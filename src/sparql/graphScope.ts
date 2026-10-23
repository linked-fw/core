/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads from named graphs: scope a read's algebra to the graphs it may read.
 *
 * The query body never names a graph the caller did not ask for. Given the expanded set (the
 * store expands portable names first, see `SparqlDataset`):
 *
 * - **no set**: the algebra is unchanged and reads the default graph;
 * - **one graph**: the whole pattern goes in `GRAPH <iri> { … }`;
 * - **several graphs**: every basic graph pattern is split into one cleanly ordered
 *   `GRAPH ?g_<subject> { … }` block per subject, and the plan gets `FROM NAMED <g1> … <gK>`, the
 *   set those blocks may match in. A subject's data lives in exactly one graph, so the graph
 *   variable is per subject and the same in every block of that subject (in OPTIONAL, MINUS,
 *   UNION, sub-select and EXISTS patterns too): an OPTIONAL block of a bound subject joins on its
 *   graph.
 *
 * Measured on Jena (10 of 100 graphs, ~1M quads): `FROM NAMED` with a graph variable per subject
 * returns exactly the expected rows with inference working inside each graph, at close to the
 * cost of reading one graph for points, pages and counts; merging every graph returns 6-10 times
 * too many rows.
 */
import type {
  SparqlAlgebraNode,
  SparqlBGP,
  SparqlDatasetClause,
  SparqlExpression,
  SparqlTerm,
  SparqlTriple,
} from './SparqlAlgebra.js';
import type {SparqlOptions} from './sparqlUtils.js';
import {graphs} from '../ontologies/graphs.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Names only a store can resolve: it expands or maps them before compiling. */
const STORE_RESOLVED_NAMES: ReadonlySet<string> = new Set([
  graphs.default,
  graphs.union,
  graphs.allOntologies,
  graphs.allShapes,
]);

/** A read's algebra scoped to its graphs, and the dataset clause that goes with it. */
export type GraphScopedAlgebra = {
  algebra: SparqlAlgebraNode;
  dataset?: SparqlDatasetClause;
};

/**
 * Scope `algebra` to `graphNames` (already expanded by the store; see the module comment).
 * Refuses an empty set (without `FROM NAMED`, `GRAPH ?g` would match in every named graph; a
 * store answers an empty expansion without querying) and a name only a store can resolve.
 */
export function scopeAlgebraToGraphs(
  algebra: SparqlAlgebraNode,
  graphNames: readonly string[] | undefined,
  options?: SparqlOptions,
): GraphScopedAlgebra {
  if (graphNames === undefined) return {algebra};
  if (graphNames.length === 0) {
    throw new Error(
      'A read from an empty set of graphs matches nothing; the store answers it without ' +
        'querying. Without FROM NAMED, GRAPH ?g would match in every named graph instead.',
    );
  }
  for (const name of graphNames) {
    if (STORE_RESOLVED_NAMES.has(name)) {
      throw new Error(
        `<${name}> is a portable graph name a store resolves (SparqlDataset expands it from the ` +
          `graph registry or maps it to its own name). Compile the read through the store, or ` +
          `pass the graphs it stands for.`,
      );
    }
  }
  if (graphNames.length === 1) {
    return {algebra: {type: 'graph', iri: graphNames[0], inner: algebra}};
  }
  const scoper = new SubjectGraphScoper(algebra, options?.isolateLinkedTypeChecks === true);
  return {algebra: scoper.scope(algebra), dataset: {fromNamed: [...graphNames]}};
}

class SubjectGraphScoper {
  /** Variables used anywhere in the algebra, so a graph variable never collides with one. */
  private readonly used = new Set<string>();
  /** Subjects reached through a link: variables that are the object of some triple. */
  private readonly linked = new Set<string>();
  private readonly graphVars = new Map<string, string>();
  private iriSubjects = 0;

  constructor(
    algebra: SparqlAlgebraNode,
    private readonly isolateLinkedTypeChecks: boolean,
  ) {
    collectNode(algebra, (triple) => {
      for (const term of [triple.subject, triple.object]) {
        if (term.kind === 'variable') this.used.add(term.name);
      }
      if (triple.object.kind === 'variable') this.linked.add(triple.object.name);
    }, this.used);
  }

  scope(node: SparqlAlgebraNode): SparqlAlgebraNode {
    switch (node.type) {
      case 'bgp':
        return this.scopeBgp(node);
      case 'join':
      case 'union':
      case 'minus':
        return {...node, left: this.scope(node.left), right: this.scope(node.right)};
      case 'left_join':
        return {
          ...node,
          left: this.scope(node.left),
          right: this.scope(node.right),
          ...(node.condition ? {condition: this.scopeExpression(node.condition)} : {}),
        };
      case 'filter':
        return {...node, expression: this.scopeExpression(node.expression), inner: this.scope(node.inner)};
      case 'extend':
        return {...node, expression: this.scopeExpression(node.expression), inner: this.scope(node.inner)};
      case 'subselect':
        return {...node, inner: this.scope(node.inner)};
      case 'graph':
      case 'values':
        return node;
    }
  }

  private scopeExpression(expr: SparqlExpression): SparqlExpression {
    switch (expr.kind) {
      case 'exists_expr':
        return {...expr, pattern: this.scope(expr.pattern)};
      case 'binary_expr':
        return {...expr, left: this.scopeExpression(expr.left), right: this.scopeExpression(expr.right)};
      case 'logical_expr':
        return {...expr, exprs: expr.exprs.map((e) => this.scopeExpression(e))};
      case 'not_expr':
        return {...expr, inner: this.scopeExpression(expr.inner)};
      case 'function_expr':
      case 'aggregate_expr':
        return {...expr, args: expr.args.map((e) => this.scopeExpression(e))};
      case 'in_expr':
        return {
          ...expr,
          value: this.scopeExpression(expr.value),
          list: expr.list.map((e) => this.scopeExpression(e)),
        };
      default:
        return expr;
    }
  }

  /** One `GRAPH ?g { … }` block per subject, in the order the subjects first appear. */
  private scopeBgp(bgp: SparqlBGP): SparqlAlgebraNode {
    if (bgp.triples.length === 0) return bgp;
    const groups = new Map<string, {subject: SparqlTerm; triples: SparqlTriple[]}>();
    for (const triple of bgp.triples) {
      const key = subjectKey(triple.subject);
      const group = groups.get(key);
      if (group) group.triples.push(triple);
      else groups.set(key, {subject: triple.subject, triples: [triple]});
    }
    const blocks: SparqlAlgebraNode[] = [];
    for (const [key, {subject, triples}] of groups) {
      const variable = this.graphVariable(key, subject);
      for (const part of this.splitLinkedTypeCheck(subject, triples)) {
        blocks.push({type: 'graph', variable, inner: {type: 'bgp', triples: part}});
      }
    }
    return blocks.reduce((left, right) => ({type: 'join', left, right}));
  }

  /*
   * Why the second block (decision 9 of CN plan 071, measured on Jena 6.2):
   *
   * Two GRAPH blocks on the same variable mean exactly what one block with both patterns means
   * (same graph, same subject, both required). They exist for speed. The inferred type check is
   * the expensive pattern (the store considers every subclass), and Jena reorders the patterns
   * inside one block at run time: `arq.sparql --explain` shows a `Reorder/generic` step that moves
   * the type check first for a bound subject, whatever the written order (`qparse --print=opt`
   * does not show it, and `arq:optReorderBGP false` does not switch it off). In one block the type
   * check therefore runs in every allowed graph for each linked subject. The first block reads a
   * stored triple of the already-bound subject, which binds its one graph; the second block's
   * type check then runs in that graph only. It is plain SPARQL 1.1, valid on any store; a store
   * that does not reorder runs it like one block, which is why it is a store option
   * (`isolateLinkedTypeChecks`) and not the default. Measured, 10 of 100 graphs, join of a work
   * to its author, median: two blocks 108 ms, one block 247-253 ms in either order, ideal (only
   * the 10 graphs' data in one graph) 44 ms.
   *
   * It applies to a subject reached through a link whose block holds a type check and at least
   * one stored triple; the root subject's type check stays in its block.
   */
  private splitLinkedTypeCheck(subject: SparqlTerm, triples: SparqlTriple[]): SparqlTriple[][] {
    if (!this.isolateLinkedTypeChecks) return [triples];
    if (subject.kind !== 'variable' || !this.linked.has(subject.name)) return [triples];
    const typeChecks = triples.filter(isTypeCheck);
    const stored = triples.filter((t) => !isTypeCheck(t));
    if (typeChecks.length === 0 || stored.length === 0) return [triples];
    return [stored, typeChecks];
  }

  private graphVariable(key: string, subject: SparqlTerm): string {
    const existing = this.graphVars.get(key);
    if (existing) return existing;
    const base = subject.kind === 'variable' ? `g_${subject.name}` : `g_s${this.iriSubjects++}`;
    let name = base;
    for (let n = 2; this.used.has(name); n++) name = `${base}_${n}`;
    this.used.add(name);
    this.graphVars.set(key, name);
    return name;
  }
}

function isTypeCheck(triple: SparqlTriple): boolean {
  return triple.predicate.kind === 'iri' && triple.predicate.value === RDF_TYPE;
}

function subjectKey(term: SparqlTerm): string {
  switch (term.kind) {
    case 'variable':
      return `?${term.name}`;
    case 'iri':
      return `<${term.value}>`;
    case 'blank':
      return `_:${term.label}`;
    default:
      return JSON.stringify(term);
  }
}

/** Visit every triple of the algebra (EXISTS patterns included) and record every variable name. */
function collectNode(
  node: SparqlAlgebraNode,
  onTriple: (triple: SparqlTriple) => void,
  vars: Set<string>,
): void {
  switch (node.type) {
    case 'bgp':
      node.triples.forEach(onTriple);
      return;
    case 'join':
    case 'union':
    case 'minus':
      collectNode(node.left, onTriple, vars);
      collectNode(node.right, onTriple, vars);
      return;
    case 'left_join':
      collectNode(node.left, onTriple, vars);
      collectNode(node.right, onTriple, vars);
      if (node.condition) collectExpression(node.condition, onTriple, vars);
      return;
    case 'filter':
      collectExpression(node.expression, onTriple, vars);
      collectNode(node.inner, onTriple, vars);
      return;
    case 'extend':
      vars.add(node.variable);
      collectExpression(node.expression, onTriple, vars);
      collectNode(node.inner, onTriple, vars);
      return;
    case 'graph':
      if (node.variable !== undefined) vars.add(node.variable);
      collectNode(node.inner, onTriple, vars);
      return;
    case 'values':
      vars.add(node.variable);
      return;
    case 'subselect':
      node.projection.forEach((v) => vars.add(v));
      collectNode(node.inner, onTriple, vars);
      return;
  }
}

function collectExpression(
  expr: SparqlExpression,
  onTriple: (triple: SparqlTriple) => void,
  vars: Set<string>,
): void {
  switch (expr.kind) {
    case 'variable_expr':
      vars.add(expr.name);
      return;
    case 'bound_expr':
      vars.add(expr.variable);
      return;
    case 'exists_expr':
      collectNode(expr.pattern, onTriple, vars);
      return;
    case 'binary_expr':
      collectExpression(expr.left, onTriple, vars);
      collectExpression(expr.right, onTriple, vars);
      return;
    case 'logical_expr':
      expr.exprs.forEach((e) => collectExpression(e, onTriple, vars));
      return;
    case 'not_expr':
      collectExpression(expr.inner, onTriple, vars);
      return;
    case 'function_expr':
    case 'aggregate_expr':
      expr.args.forEach((e) => collectExpression(e, onTriple, vars));
      return;
    case 'in_expr':
      collectExpression(expr.value, onTriple, vars);
      expr.list.forEach((e) => collectExpression(e, onTriple, vars));
      return;
    default:
      return;
  }
}
