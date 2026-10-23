/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shapes as deterministic Turtle: what a package's shape graph holds (`lib/esm/data/shapes.ttl`,
 * written by `linked build`, and the graph `{package IRI}/graph/shapes` the server syncs from it).
 *
 * The triples are the ones core's create pipeline writes for a `NodeShape` (the same data the
 * default-graph shape sync builds), so a reader of stored shapes reads them unchanged. Shapes are
 * written as declared: own property shapes only, plus `core:isExtending` to the shape they
 * extend. The only blank nodes are complex `sh:path` values (SHACL requires them), each the
 * object of exactly one triple, written inline on its owner's line.
 *
 * The form is fixed so the same shapes give the same bytes in every process: a fixed prefix
 * block, IRI subjects sorted, `a` first and then the predicates sorted, one statement per line.
 * The graph's content hash is over those bytes.
 *
 * Server only: not exported from the browser index.
 *
 * @module @_linked/core/shapes/shapesToTurtle
 */
import type {Shape} from './Shape.js';
import {NodeShape} from './SHACL.js';
import type {NodeShapeData} from './nodeShapeData.js';
import {buildNodeShapeData} from './syncShapes.js';
import {buildSingleOwnerConstraints} from './singleOwnerConstraint.js';
import {getAllShapeClasses} from '../utils/ShapeClass.js';
import {builtInShapeIris} from '../utils/ShapeCatalog.js';
import {Prefix} from '../utils/Prefix.js';
import {lower, type LowerableCreate} from '../queries/lower.js';
import {createToAlgebra} from '../sparql/irToAlgebra.js';
import type {SparqlTerm, SparqlTriple} from '../sparql/SparqlAlgebra.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const GENERATED_SHAPE = 'https://linked.cm/ont/core/generatedShape';

/** The prefixes every shapes Turtle declares, whether it uses them or not. */
export const SHAPES_TURTLE_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  core: 'https://linked.cm/ont/core/',
  rdf: RDF,
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  sh: 'http://www.w3.org/ns/shacl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
});

/** Options of {@link shapesToTurtle}. */
export interface ShapesToTurtleOptions {
  /**
   * Prefixes added to the fixed block ({@link SHAPES_TURTLE_PREFIXES}), by name. A name of the
   * fixed block may not be bound to another namespace. Pass the same prefixes every time: they
   * are part of the bytes, and so of the graph's content hash.
   */
  prefixes?: Record<string, string>;
}

type ShapeInput = typeof Shape | NodeShapeData;

const PREFIX_NAME = /^[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;

function nodeShapeOf(input: ShapeInput): NodeShapeData {
  const data = typeof input === 'function' ? (input as typeof Shape).shape : input;
  if (!data?.id) throw new Error('shapesToTurtle: every entry must be a shape class or node shape data with an id.');
  return data;
}

/** The triples core's create pipeline writes for a `NodeShape` create of `data` at `iri`. */
function createTriples(iri: string, data: Record<string, unknown>): SparqlTriple[] {
  const builder = NodeShape.create(data as never).withId(iri);
  return createToAlgebra(lower(builder as unknown as LowerableCreate)).triples;
}

/** The fixed block plus `extra`, refusing a rebinding of a fixed name or a bad name/namespace. */
function prefixTable(extra: Record<string, string> = {}): Array<[string, string]> {
  const table = new Map(Object.entries(SHAPES_TURTLE_PREFIXES));
  for (const [name, namespace] of Object.entries(extra)) {
    if (!PREFIX_NAME.test(name)) throw new Error(`shapesToTurtle: "${name}" is not a valid prefix name.`);
    if (typeof namespace !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/.test(namespace)) {
      throw new Error(`shapesToTurtle: the namespace of prefix "${name}" is not an absolute IRI.`);
    }
    const fixed = table.get(name);
    if (fixed !== undefined && fixed !== namespace) {
      throw new Error(`shapesToTurtle: the prefix "${name}" is fixed to <${fixed}>.`);
    }
    table.set(name, namespace);
  }
  return [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const escapeLiteral = (value: string): string =>
  value.replace(/[\\"\n\r\t\b\f]/g, (c) =>
    ({'\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f'})[c]!,
  );

const escapeIri = (value: string): string => {
  if (/[\s<>"{}|^`\\]/.test(value)) throw new Error(`shapesToTurtle: <${value}> is not a valid IRI.`);
  return `<${value}>`;
};

/**
 * Serialise `triples` as Turtle in the fixed form. Every blank node must be the object of exactly
 * one triple and reachable from an IRI subject (a tree under one IRI subject); it is written
 * inline. A blank `rdf:List` whose cells hold only `rdf:first`/`rdf:rest` is written as `( … )`.
 */
function writeTurtle(triples: SparqlTriple[], prefixes: Array<[string, string]>): string {
  // By namespace length, longest first, so the most specific prefix wins.
  const byLength = [...prefixes].sort(([, a], [, b]) => b.length - a.length);
  const iri = (value: string): string => {
    for (const [name, namespace] of byLength) {
      if (value.startsWith(namespace)) {
        const local = value.slice(namespace.length);
        if (Prefix.isValidLocalName(local)) return `${name}:${local}`;
      }
    }
    return escapeIri(value);
  };

  const seen = new Set<string>();
  const iriSubjects = new Map<string, SparqlTriple[]>();
  const blankSubjects = new Map<string, SparqlTriple[]>();
  const parents = new Map<string, number>();
  const keyOf = (t: SparqlTerm): string =>
    t.kind === 'iri'
      ? `<${t.value}>`
      : t.kind === 'blank'
        ? `_:${t.label}`
        : t.kind === 'literal'
          ? JSON.stringify([t.value, t.datatype ?? '', t.language ?? ''])
          : JSON.stringify(t);
  for (const triple of triples) {
    const key = `${keyOf(triple.subject)} ${keyOf(triple.predicate)} ${keyOf(triple.object)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const {subject, predicate, object} = triple;
    if (predicate.kind !== 'iri') throw new Error('shapesToTurtle: a predicate must be an IRI.');
    if (subject.kind === 'iri') {
      const list = iriSubjects.get(subject.value) ?? [];
      list.push(triple);
      iriSubjects.set(subject.value, list);
    } else if (subject.kind === 'blank') {
      const list = blankSubjects.get(subject.label) ?? [];
      list.push(triple);
      blankSubjects.set(subject.label, list);
    } else {
      throw new Error(`shapesToTurtle: a ${subject.kind} cannot be a subject.`);
    }
    if (object.kind === 'blank') parents.set(object.label, (parents.get(object.label) ?? 0) + 1);
  }
  for (const count of parents.values()) {
    if (count > 1) {
      throw new Error(`shapesToTurtle: a blank node is the object of ${count} triples; each must hang off exactly one subject.`);
    }
  }

  const written = new Set<string>();
  const predicateOrder = (a: SparqlTriple, b: SparqlTriple): number => {
    const pa = (a.predicate as {value: string}).value;
    const pb = (b.predicate as {value: string}).value;
    if (pa === pb) return 0;
    if (pa === RDF_TYPE) return -1;
    if (pb === RDF_TYPE) return 1;
    return pa < pb ? -1 : 1;
  };
  const statements = (list: SparqlTriple[]): string[] =>
    list
      .map((t) => ({t, text: `${(t.predicate as {value: string}).value === RDF_TYPE ? 'a' : iri((t.predicate as {value: string}).value)} ${term(t.object)}`}))
      .sort((x, y) => predicateOrder(x.t, y.t) || (x.text < y.text ? -1 : x.text > y.text ? 1 : 0))
      .map(({text}) => text);

  /** The items of a blank-celled list starting at `label`, or undefined when it is not one. */
  const listItems = (label: string): SparqlTerm[] | undefined => {
    const items: SparqlTerm[] = [];
    let current: string | undefined = label;
    const cells = new Set<string>();
    while (current !== undefined) {
      if (cells.has(current)) return undefined;
      cells.add(current);
      const cell: SparqlTriple[] = blankSubjects.get(current) ?? [];
      const first = cell.filter((t) => (t.predicate as {value: string}).value === RDF_FIRST);
      const rest = cell.filter((t) => (t.predicate as {value: string}).value === RDF_REST);
      if (cell.length !== 2 || first.length !== 1 || rest.length !== 1) return undefined;
      items.push(first[0].object);
      const next: SparqlTerm = rest[0].object;
      if (next.kind === 'iri' && next.value === RDF_NIL) return items;
      if (next.kind !== 'blank') return undefined;
      current = next.label;
    }
    return undefined;
  };

  function blank(label: string): string {
    if (written.has(label)) throw new Error('shapesToTurtle: blank nodes form a cycle.');
    written.add(label);
    const items = listItems(label);
    if (items) {
      // Mark every cell as written; the items are written as terms.
      let cell: string | undefined = label;
      while (cell !== undefined) {
        written.add(cell);
        const rest = (blankSubjects.get(cell) ?? []).find(
          (t) => (t.predicate as {value: string}).value === RDF_REST,
        )?.object;
        cell = rest?.kind === 'blank' ? rest.label : undefined;
      }
      return items.length ? `( ${items.map(term).join(' ')} )` : '()';
    }
    const inner = statements(blankSubjects.get(label) ?? []);
    return inner.length ? `[ ${inner.join(' ; ')} ]` : '[]';
  }

  function term(t: SparqlTerm): string {
    switch (t.kind) {
      case 'iri':
        return iri(t.value);
      case 'blank':
        return blank(t.label);
      case 'literal': {
        const text = `"${escapeLiteral(t.value)}"`;
        if (t.language) return `${text}@${t.language}`;
        if (!t.datatype || t.datatype === XSD_STRING) return text;
        return `${text}^^${iri(t.datatype)}`;
      }
      default:
        throw new Error(`shapesToTurtle: a ${t.kind} cannot be written as a term.`);
    }
  }

  const blocks: string[] = [];
  for (const subject of [...iriSubjects.keys()].sort()) {
    const lines = statements(iriSubjects.get(subject)!);
    blocks.push(`${iri(subject)}\n  ${lines.join(' ;\n  ')} .\n`);
  }
  for (const label of blankSubjects.keys()) {
    if (!written.has(label)) {
      throw new Error('shapesToTurtle: a blank node hangs off no IRI subject.');
    }
  }
  const header = prefixes.map(([name, namespace]) => `@prefix ${name}: ${escapeIri(namespace)} .`).join('\n');
  return `${header}\n${blocks.length ? `\n${blocks.join('\n')}` : ''}`;
}

/**
 * The given shapes as deterministic Turtle, as declared: each shape's `sh:NodeShape` with its own
 * property shapes, `core:isExtending` to the shape it extends, `sh:in`/`sh:and`/`sh:xone` lists
 * with IRI cells, complex paths as inline blank nodes. The single-owner shapes core generates from
 * `contains` properties are not included (see {@link singleOwnerShapesTurtle}).
 *
 * Same shapes and same `prefixes` → same bytes, in any process.
 */
export function shapesToTurtle(shapes: ShapeInput[], options: ShapesToTurtleOptions = {}): string {
  const prefixes = prefixTable(options.prefixes);
  const triples: SparqlTriple[] = [];
  for (const shape of shapes.map(nodeShapeOf)) {
    triples.push(...createTriples(shape.id, buildNodeShapeData(shape, shape.id, {generated: false})));
  }
  return writeTurtle(triples, prefixes);
}

/**
 * The single-owner shapes core generates from the `contains` properties of `shapes`, with the
 * declaring shapes' `core:generatedShape` links, as Turtle in the same form; `undefined` when
 * there are none. An app keeps them in its own shape graph (`{DATA_ROOT}/graph/shapes`).
 */
export function singleOwnerShapesTurtle(
  shapes: ShapeInput[],
  options: ShapesToTurtleOptions = {},
): string | undefined {
  const triples: SparqlTriple[] = [];
  for (const shape of shapes.map(nodeShapeOf)) {
    for (const {iri, data} of buildSingleOwnerConstraints(shape, shape.id)) {
      triples.push({
        subject: {kind: 'iri', value: shape.id},
        predicate: {kind: 'iri', value: GENERATED_SHAPE},
        object: {kind: 'iri', value: iri},
      });
      triples.push(...createTriples(iri, data));
    }
  }
  return triples.length ? writeTurtle(triples, prefixTable(options.prefixes)) : undefined;
}

/** The npm scope of core's shapes: of these, only the built-ins are a package shape. */
const CORE_PACKAGE = '@_linked/core';

/**
 * The registered shapes of `packageName`, sorted by IRI: every shape declared through that
 * package's `linkedShape`; for `@_linked/core`, its built-in shapes only (other shapes declared
 * with core's own `linkedShape` are test fixtures). The selection the shape syncs use.
 */
export function packageShapes(packageName: string): NodeShapeData[] {
  const builtIns = new Set(builtInShapeIris());
  const out: NodeShapeData[] = [];
  for (const [iri, shapeClass] of getAllShapeClasses()) {
    if (!shapeClass?.shape) continue;
    const pkg = (shapeClass as {packageName?: string}).packageName;
    const owner = builtIns.has(iri) ? CORE_PACKAGE : pkg;
    if (owner !== packageName || (pkg === CORE_PACKAGE && !builtIns.has(iri))) continue;
    out.push(shapeClass.shape);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Every package with registered shapes (core counted for its built-ins), sorted.
 */
export function packagesWithShapes(): string[] {
  const builtIns = new Set(builtInShapeIris());
  const names = new Set<string>();
  for (const [iri, shapeClass] of getAllShapeClasses()) {
    if (!shapeClass?.shape) continue;
    const pkg = (shapeClass as {packageName?: string}).packageName;
    if (builtIns.has(iri)) names.add(CORE_PACKAGE);
    else if (pkg && pkg !== CORE_PACKAGE) names.add(pkg);
  }
  return [...names].sort();
}

/**
 * A package's `shapes.ttl`: {@link shapesToTurtle} of {@link packageShapes}, or `undefined` when
 * the package registers no shapes. `linked build` writes it to `lib/esm/data/shapes.ttl`, and the
 * shape graph sync generates it when a package has no such file, so both give the same bytes.
 */
export function packageShapesTurtle(
  packageName: string,
  options: ShapesToTurtleOptions = {},
): string | undefined {
  const shapes = packageShapes(packageName);
  return shapes.length ? shapesToTurtle(shapes, options) : undefined;
}
