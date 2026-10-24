/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads from named graphs: scope a read's algebra to the graphs it may read.
 *
 * The query body never names a graph the caller or the routing did not give it. The graphs come
 * either as one set for every subject (`.from()`, expanded by the store first, see
 * `SparqlDataset`) or per subject (graph routing: each subject reads where its shape is routed,
 * sub-shapes included). Then:
 *
 * - **only the default graph**: the algebra is unchanged;
 * - **one graph for every subject**: the whole pattern goes in `GRAPH <iri> { … }`;
 * - **otherwise**: every basic graph pattern is split into one cleanly ordered block per subject,
 *   `GRAPH ?g_<subject> { … }`, `GRAPH <iri> { … }` for a subject with one graph, or plain triples
 *   for a subject that reads only the default graph. With named graphs only, the plan gets
 *   `FROM NAMED <g1> … <gK>`, the set the blocks may match in, and a type-checked subject whose
 *   set is narrower gets `VALUES ?g_<subject> { … }`; with the default graph in the mix there is
 *   no `FROM NAMED` (it would hide the default graph) and every subject with several graphs gets
 *   `VALUES`. A subject's data lives in exactly one graph, so the graph variable is per subject
 *   and the same in every block of that subject (in OPTIONAL, MINUS, UNION, sub-select and EXISTS
 *   patterns too): an OPTIONAL block of a bound subject joins on its graph.
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
import {GraphQueryError} from '../queries/graphQuery.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Names only a store can resolve: it expands or maps them before compiling. `graphs.default`
 * reaches the generator in a set with other graphs (it is read through `VALUES` under the store's
 * name for it, `mapGraphName`); the others never do.
 */
const STORE_RESOLVED_NAMES: ReadonlySet<string> = new Set([
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
 * The graphs a read may match in:
 * - a list: one set for every subject (`.from()`, expanded by the store);
 * - per subject (graph routing): the set of each subject variable, and the set of any subject
 *   not listed (`otherSubjects`: every graph the routing knows, the default graph included).
 *
 * A set names concrete graphs; `graphs.default` stands for the default graph.
 */
export type ReadGraphScope =
  | readonly string[]
  | {
      bySubject: ReadonlyMap<string, readonly string[]>;
      otherSubjects: readonly string[];
    };

/**
 * Scope `algebra` to its graphs (see the module comment and `ReadGraphScope`). Refuses an empty
 * set (without `FROM NAMED`, `GRAPH ?g` would match in every named graph; a store answers an empty
 * expansion without querying) and a name only a store can resolve.
 *
 * - Every subject reads only the default graph: unchanged.
 * - Every subject reads one same named graph: `GRAPH <iri> { whole pattern }`.
 * - Only named graphs: `FROM NAMED` their union; per subject group, a set of one graph is
 *   `GRAPH <iri>`, a set equal to the union `GRAPH ?g`, and a narrower set of a subject with a
 *   type check `VALUES ?g { … }` with `GRAPH ?g` (another subject's graph might hold instances of
 *   its class; core cannot know which classes a graph holds). A linked subject without a type
 *   check needs no `VALUES`: its data lives in one graph, and `FROM NAMED` bounds it.
 * - The default graph with named graphs: no `FROM NAMED`, because with any `FROM NAMED` the
 *   default graph is unreachable on Jena (as plain triples, in `GRAPH <urn:x-arq:DefaultGraph>`
 *   and in `VALUES`); a subject that reads only the default graph is plain triples, one graph
 *   `GRAPH <iri>`, and any other set `VALUES ?g { … }` with the default graph under the store's
 *   name for it (`SparqlOptions.mapGraphName(graphs.default)`; refused without one).
 */
export function scopeAlgebraToGraphs(
  algebra: SparqlAlgebraNode,
  scope: ReadGraphScope | undefined,
  options?: SparqlOptions,
): GraphScopedAlgebra {
  if (scope === undefined) return {algebra};
  const allSets: (readonly string[])[] = isUniformScope(scope)
    ? [scope]
    : [...scope.bySubject.values(), scope.otherSubjects];
  for (const set of allSets) {
    if (set.length === 0) {
      throw new Error(
        'A read from an empty set of graphs matches nothing; the store answers it without ' +
          'querying. Without FROM NAMED, GRAPH ?g would match in every named graph instead.',
      );
    }
    for (const name of set) {
      if (STORE_RESOLVED_NAMES.has(name)) {
        throw new Error(
          `<${name}> is a portable graph name a store resolves (SparqlDataset expands it from the ` +
            `graph registry or maps it to its own name). Compile the read through the store, or ` +
            `pass the graphs it stands for.`,
        );
      }
    }
  }
  const scoper = new SubjectGraphScoper(algebra, scope, options);
  return scoper.result();
}

function isUniformScope(scope: ReadGraphScope): scope is readonly string[] {
  return Array.isArray(scope);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((g) => b.includes(g));

/** How one subject's blocks are written. */
type SubjectForm =
  | {kind: 'plain'}
  | {kind: 'fixed'; iri: string}
  | {kind: 'variable'; values?: string[]};

/**
 * The graph a mutation on existing subjects runs in: the default graph, one known graph (`WITH
 * <g>`), or a graph found at write time (`GRAPH ?g_w { … }` around the WHERE).
 */
export type MutationSubjectGraph =
  | {kind: 'plain'}
  | {kind: 'fixed'; iri: string}
  | {kind: 'variable'; variable: string};

/**
 * The graphs the WHERE of a mutation reads. The WHERE runs in the subject's graph
 * (`subjectGraph`), which holds the subject's own triples, its old values, and its owned and blank
 * nodes; the variables in `linked`, nodes reached through a link to another shape, are read in
 * their shape's read set.
 */
export type MutationGraphScope = {
  subjectGraph: MutationSubjectGraph;
  linked: ReadonlyMap<string, readonly string[]>;
  /** Variable names the plan uses outside the algebra (its own graph variable), never reused. */
  reserved?: readonly string[];
};

/**
 * Scope the WHERE of a mutation that reads a linked node in other graphs (see
 * {@link MutationGraphScope}). The subject's patterns are left as they are (the plan runs them in
 * its graph); a linked node's patterns get a block nested in it: plain triples when its set is the
 * subject's one graph, `GRAPH <g>` for one other graph (the default graph under the store's name
 * for it), `VALUES ?g { … }` with `GRAPH ?g` for several (an update has no `FROM NAMED`). `GRAPH`
 * and `VALUES` nodes already in the algebra are kept.
 */
export function scopeMutationWhere(
  algebra: SparqlAlgebraNode,
  scope: MutationGraphScope,
  options?: SparqlOptions,
): SparqlAlgebraNode {
  for (const set of scope.linked.values()) {
    if (set.length === 0) throw new Error('A mutation reads a linked node in an empty set of graphs.');
    for (const name of set) {
      if (STORE_RESOLVED_NAMES.has(name)) {
        throw new Error(`<${name}> is a portable graph name; a mutation reads concrete graphs.`);
      }
    }
  }
  return new SubjectGraphScoper(algebra, scope, options).scopedWhere();
}

const isMutationScope = (scope: ReadGraphScope | MutationGraphScope): scope is MutationGraphScope =>
  !Array.isArray(scope) && 'subjectGraph' in scope;

class SubjectGraphScoper {
  /** Variables used anywhere in the algebra, so a graph variable never collides with one. */
  private readonly used = new Set<string>();
  /** Subjects reached through a link: variables that are the object of some triple. */
  private readonly linked = new Set<string>();
  /** Subjects with a type check (`?x a C`) somewhere in the algebra. */
  private readonly typed = new Set<string>();
  /** Every subject, by its key, in first-appearance order. */
  private readonly subjects = new Map<string, SparqlTerm>();
  private readonly graphVars = new Map<string, string>();
  private readonly forms = new Map<string, SubjectForm>();
  private readonly isolateLinkedTypeChecks: boolean;
  private iriSubjects = 0;
  private fromNamed?: string[];
  private unchanged = false;
  private wholeGraph?: string;
  /** The form of a subject without one of its own (in a mutation: plain, in the plan's graph). */
  private defaultForm: SubjectForm = {kind: 'variable'};

  constructor(
    private readonly algebra: SparqlAlgebraNode,
    scope: ReadGraphScope | MutationGraphScope,
    options?: SparqlOptions,
  ) {
    this.isolateLinkedTypeChecks = options?.isolateLinkedTypeChecks === true;
    collectNode(algebra, (triple) => {
      for (const term of [triple.subject, triple.object]) {
        if (term.kind === 'variable') this.used.add(term.name);
      }
      if (triple.object.kind === 'variable') this.linked.add(triple.object.name);
      const key = subjectKey(triple.subject);
      if (!this.subjects.has(key)) this.subjects.set(key, triple.subject);
      if (isTypeCheck(triple)) this.typed.add(key);
    }, this.used);
    if (isMutationScope(scope)) this.planMutationForms(scope, options);
    else this.planForms(scope, options);
  }

  /** A mutation's forms (see {@link scopeMutationWhere}). */
  private planMutationForms(scope: MutationGraphScope, options?: SparqlOptions): void {
    // A subject that is not linked stays in the plan's graph.
    this.defaultForm = {kind: 'plain'};
    for (const name of scope.reserved ?? []) this.used.add(name);
    const subject = scope.subjectGraph;
    const storeName = (graph: string): string => {
      if (graph !== graphs.default) return graph;
      const name = options?.mapGraphName ? options.mapGraphName(graphs.default) : null;
      if (!name) {
        throw new GraphQueryError(
          'unsupported-query-kind',
          'This write reads a linked node that may be in the default graph while the write runs ' +
            'in a named graph, which a SPARQL store addresses through its own name for the ' +
            'default graph; this store has none (SparqlOptions.mapGraphName).',
          graphs.default,
        );
      }
      return name;
    };
    for (const [variable, set] of scope.linked) {
      const key = `?${variable}`;
      const one = set.length === 1 ? set[0] : undefined;
      if (
        one !== undefined &&
        ((subject.kind === 'plain' && one === graphs.default) || (subject.kind === 'fixed' && one === subject.iri))
      ) {
        this.forms.set(key, {kind: 'plain'});
      } else if (one !== undefined) {
        this.forms.set(key, {kind: 'fixed', iri: storeName(one)});
      } else {
        this.forms.set(key, {kind: 'variable', values: set.map(storeName)});
      }
    }
  }

  /** The scoped algebra of a mutation's WHERE. */
  scopedWhere(): SparqlAlgebraNode {
    return this.scope(this.algebra);
  }

  /** Decide each subject's form, the dataset clause, or that the algebra stays as it is. */
  private planForms(scope: ReadGraphScope, options?: SparqlOptions): void {
    const setOf = (key: string): readonly string[] => {
      if (isUniformScope(scope)) return scope;
      const term = this.subjects.get(key);
      const own = term?.kind === 'variable' ? scope.bySubject.get(term.name) : undefined;
      return own ?? scope.otherSubjects;
    };
    const sets = new Map<string, readonly string[]>();
    for (const key of this.subjects.keys()) sets.set(key, setOf(key));
    const used = sets.size > 0 ? [...sets.values()] : [setOf('')];

    if (used.every((set) => set.length === 1 && set[0] === graphs.default)) {
      this.unchanged = true;
      return;
    }
    const first = used[0];
    if (first.length === 1 && used.every((set) => sameSet(set, first))) {
      this.wholeGraph = first[0];
      return;
    }
    const withDefault = used.some((set) => set.includes(graphs.default));
    // The named graphs any subject reads: a `.from()` set in the caller's order, a routed one
    // sorted, so the query text is stable.
    const named = [...new Set(used.flat().filter((g) => g !== graphs.default))];
    const union = isUniformScope(scope) ? named : named.sort();
    let defaultName: string | null | undefined;
    const storeName = (graph: string): string => {
      if (graph !== graphs.default) return graph;
      if (defaultName === undefined) {
        defaultName = options?.mapGraphName ? options.mapGraphName(graphs.default) : null;
      }
      if (!defaultName) {
        throw new GraphQueryError(
          'unsupported-query-kind',
          'This read covers the default graph together with named graphs, which a SPARQL store ' +
            'reads through VALUES under its own name for the default graph; this store has none ' +
            '(SparqlOptions.mapGraphName).',
          graphs.default,
        );
      }
      return defaultName;
    };
    for (const [key, set] of sets) {
      if (withDefault) {
        if (set.length === 1 && set[0] === graphs.default) this.forms.set(key, {kind: 'plain'});
        else if (set.length === 1) this.forms.set(key, {kind: 'fixed', iri: set[0]});
        else this.forms.set(key, {kind: 'variable', values: set.map(storeName)});
      } else if (set.length === 1 && union.length > 1) {
        this.forms.set(key, {kind: 'fixed', iri: set[0]});
      } else if (sameSet(set, union) || !this.typed.has(key)) {
        this.forms.set(key, {kind: 'variable'});
      } else {
        this.forms.set(key, {kind: 'variable', values: [...set]});
      }
    }
    if (!withDefault) this.fromNamed = union;
  }

  result(): GraphScopedAlgebra {
    if (this.unchanged) return {algebra: this.algebra};
    if (this.wholeGraph !== undefined) {
      return {algebra: {type: 'graph', iri: this.wholeGraph, inner: this.algebra}};
    }
    const algebra = this.scope(this.algebra);
    return this.fromNamed ? {algebra, dataset: {fromNamed: this.fromNamed}} : {algebra};
  }

  /**
   * Scope `node`. `bound` holds the graph variables a required block before this point has
   * already bound (it grows along a join): a subject's `VALUES` is written only where its graph
   * variable is not bound yet. An OPTIONAL, UNION or EXISTS pattern starts from a copy, since what
   * it binds does not reach the patterns after it; a MINUS right side and a sub-select start empty.
   */
  scope(node: SparqlAlgebraNode, bound: Set<string> = new Set()): SparqlAlgebraNode {
    switch (node.type) {
      case 'bgp':
        return this.scopeBgp(node, bound);
      case 'join': {
        const left = this.scope(node.left, bound);
        return {...node, left, right: this.scope(node.right, bound)};
      }
      case 'union':
        return {
          ...node,
          left: this.scope(node.left, new Set(bound)),
          right: this.scope(node.right, new Set(bound)),
        };
      case 'minus': {
        // The right side of a MINUS is evaluated on its own (no bindings flow in), so it writes
        // its own VALUES: without them, with no FROM NAMED, GRAPH ?g would never match the
        // default graph and nothing from it would be removed.
        const left = this.scope(node.left, bound);
        return {...node, left, right: this.scope(node.right, new Set())};
      }
      case 'left_join': {
        const left = this.scope(node.left, bound);
        const inRight = new Set(bound);
        const right = this.scope(node.right, inRight);
        return {
          ...node,
          left,
          right,
          ...(node.condition ? {condition: this.scopeExpression(node.condition, inRight)} : {}),
        };
      }
      case 'filter': {
        const inner = this.scope(node.inner, bound);
        return {...node, expression: this.scopeExpression(node.expression, bound), inner};
      }
      case 'extend': {
        const inner = this.scope(node.inner, bound);
        return {...node, expression: this.scopeExpression(node.expression, bound), inner};
      }
      case 'subselect':
        return {...node, inner: this.scope(node.inner, new Set())};
      case 'graph':
      case 'values':
        return node;
    }
  }

  private scopeExpression(expr: SparqlExpression, bound: Set<string>): SparqlExpression {
    switch (expr.kind) {
      case 'exists_expr':
        return {...expr, pattern: this.scope(expr.pattern, new Set(bound))};
      case 'binary_expr':
        return {
          ...expr,
          left: this.scopeExpression(expr.left, bound),
          right: this.scopeExpression(expr.right, bound),
        };
      case 'logical_expr':
        return {...expr, exprs: expr.exprs.map((e) => this.scopeExpression(e, bound))};
      case 'not_expr':
        return {...expr, inner: this.scopeExpression(expr.inner, bound)};
      case 'function_expr':
      case 'aggregate_expr':
        return {...expr, args: expr.args.map((e) => this.scopeExpression(e, bound))};
      case 'in_expr':
        return {
          ...expr,
          value: this.scopeExpression(expr.value, bound),
          list: expr.list.map((e) => this.scopeExpression(e, bound)),
        };
      default:
        return expr;
    }
  }

  /**
   * One block per subject, in the order the subjects first appear: `GRAPH ?g { … }` (after its
   * `VALUES` when the subject's set is restricted), `GRAPH <iri> { … }`, or plain triples.
   */
  private scopeBgp(bgp: SparqlBGP, bound: Set<string>): SparqlAlgebraNode {
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
      const form = this.forms.get(key) ?? this.defaultForm;
      if (form.kind === 'plain') {
        blocks.push({type: 'bgp', triples});
        continue;
      }
      if (form.kind === 'fixed') {
        blocks.push({type: 'graph', iri: form.iri, inner: {type: 'bgp', triples}});
        continue;
      }
      const variable = this.graphVariable(key, subject);
      if (form.values && !bound.has(variable)) {
        blocks.push({type: 'values', variable, iris: form.values});
      }
      for (const part of this.splitLinkedTypeCheck(subject, triples)) {
        blocks.push({type: 'graph', variable, inner: {type: 'bgp', triples: part}});
      }
      bound.add(variable);
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
