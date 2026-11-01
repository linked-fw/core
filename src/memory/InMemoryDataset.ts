/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import type {SelectQuery} from '../queries/SelectQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CountQuery} from '../queries/CountQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  CreateResult,
  GraphQuery,
  GraphResult,
  IRAskQuery,
  IRCountQuery,
  IRCreateMutation,
  IRExpression,
  IRFieldValue,
  IRNodeData,
  IRSelectQuery,
  IRUpdateMutation,
  IRUpsertMutation,
  ResultFieldValue,
  ResultRow,
  SelectResult,
  UpdateResult,
} from '../queries/IntermediateRepresentation.js';
import type {DatasetFeature} from '../queries/queryFeatures.js';
import {lower} from '../queries/lower.js';
import {unsupportedGraphQuery} from '../queries/graphQuery.js';
import {txIdOf} from '../queries/transactionQuery.js';
import {graphs} from '../ontologies/graphs.js';
import {rdf} from '../ontologies/rdf.js';
import {findPropertyShapeById, getPropertyShapes} from '../shapes/nodeShapeData.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {subClassesOf} from '../ontology/classHierarchy.js';
import {catalogOf, getAllNodeShapes, getTargetClassId, withShapeCatalog} from '../utils/ShapeClass.js';
import {inProduction} from '../utils/inProduction.js';
import {generateEntityUri} from '../sparql/sparqlUtils.js';
import {mintNestedIds} from '../sparql/irToAlgebra.js';
import {mapSparqlCreateResult, mapSparqlUpdateResult} from '../sparql/resultMapping.js';

/** A value of a property: a node, or a literal. */
type Value = {id: string} | string | number | boolean | Date;
/** subject → predicate → values. */
type Data = Map<string, Map<string, Value[]>>;

/** Options for {@link InMemoryDataset}. */
export interface InMemoryDatasetOptions {
  /** A name for messages and warnings (`id`). Default: `'in-memory'`. */
  id?: string;
  /** The root ids are minted under. Default: `DATA_ROOT`, else `http://example.org/data`. */
  dataRoot?: string;
  /**
   * How long a transaction may stay idle (no query, no commit) before the store rolls it back,
   * in milliseconds. Default: {@link DEFAULT_TRANSACTION_TIMEOUT_MS} (30 seconds).
   */
  transactionTimeoutMs?: number;
}

/** The idle timeout after which an abandoned transaction is rolled back: 30 seconds. */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;

/** The store refuses a query it does not answer (rather than answering part of it). */
export class InMemoryQueryRefusal extends Error {
  constructor(message: string) {
    super(`InMemoryDataset does not answer this query: ${message}`);
    this.name = new.target.name;
  }
}

type OpenTransaction = {
  data: Data;
  /** The store's version when the transaction began: a commit after another write is refused. */
  baseVersion: number;
  timer?: ReturnType<typeof setTimeout>;
};

const RDF_TYPE = rdf.type.id;

const isNode = (value: unknown): value is {id: string} =>
  !!value && typeof value === 'object' && !(value instanceof Date) && typeof (value as {id?: unknown}).id === 'string';

const sameValue = (a: Value, b: Value): boolean => {
  if (isNode(a) || isNode(b)) return isNode(a) && isNode(b) && a.id === b.id;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
};

const localName = (iri: string): string => {
  const hash = iri.lastIndexOf('#');
  if (hash >= 0) return iri.substring(hash + 1);
  const slash = iri.lastIndexOf('/');
  return slash >= 0 ? iri.substring(slash + 1) : iri;
};

const copyData = (data: Data): Data =>
  new Map([...data].map(([subject, props]) => [subject, new Map([...props].map(([p, vs]) => [p, [...vs]]))]));

/**
 * A dataset that keeps its data in memory: for tests, examples and tools, and the store that
 * shows the transaction protocol for real (`supports: ['transactions']`).
 *
 * It answers a deliberate subset of queries, and refuses everything else with
 * {@link InMemoryQueryRefusal} (never a partial answer):
 *
 * - creates, nested creates included; updates and upserts by id; deletes by id, of every instance
 *   of a shape, and shapeless;
 * - selects, counts and asks of one shape: by subject or subjects, with `limit`/`offset`, a where
 *   clause of `=`/`!=`/`and`/`or`/`not` on the subject's own properties, and fields that are the
 *   subject's own properties (one step, no nested selection).
 *
 * One graph: a query that names another graph is refused. Owned values (`contains`) are not
 * cascaded, so a delete of a shape that declares one is refused.
 *
 * **Transactions.** `beginTransaction()` takes a snapshot of the data; every query with that
 * `txId` reads and writes the snapshot, so it sees the transaction's own writes and nothing of
 * them shows outside. `commit(txId)` swaps the snapshot in, unless the store was written since
 * the transaction began (then it rejects and rolls back: the transaction would undo that write).
 * `rollback(txId)` drops it. A transaction idle for `transactionTimeoutMs` is rolled back.
 */
export class InMemoryDataset implements IDataset {
  readonly id: string;
  readonly supports: readonly DatasetFeature[] = Object.freeze(['shapelessDelete', 'transactions'] as DatasetFeature[]);
  readonly transactionTimeoutMs: number;
  private readonly root: string;
  private data: Data = new Map();
  private version = 0;
  private nextTx = 0;
  private readonly transactions = new Map<string, OpenTransaction>();

  constructor(options: InMemoryDatasetOptions = {}) {
    this.id = options.id ?? 'in-memory';
    this.root = (options.dataRoot ?? process.env.DATA_ROOT ?? 'http://example.org/data').replace(/\/+$/, '');
    this.transactionTimeoutMs = options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
  }

  dataRoot(): string {
    return this.root;
  }

  /** The transactions open now (for tests and diagnostics). */
  get openTransactions(): number {
    return this.transactions.size;
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  async beginTransaction(): Promise<string> {
    const txId = `${this.id}#tx-${++this.nextTx}`;
    this.transactions.set(txId, {data: copyData(this.data), baseVersion: this.version});
    this.touch(txId);
    return txId;
  }

  async commit(txId: string): Promise<void> {
    const tx = this.open(txId);
    this.end(txId);
    if (tx.baseVersion !== this.version) {
      throw new Error(
        `InMemoryDataset ${this.id}: transaction ${txId} cannot commit; the store was written ` +
          'after it began. It was rolled back.',
      );
    }
    this.data = tx.data;
    this.version++;
  }

  async rollback(txId: string): Promise<void> {
    if (this.transactions.has(txId)) this.end(txId);
  }

  private open(txId: string): OpenTransaction {
    const tx = this.transactions.get(txId);
    if (!tx) {
      throw new Error(`InMemoryDataset ${this.id}: transaction ${txId} is unknown or expired.`);
    }
    return tx;
  }

  /** Restart the idle timer of a transaction. */
  private touch(txId: string): void {
    const tx = this.transactions.get(txId);
    if (!tx) return;
    if (tx.timer) clearTimeout(tx.timer);
    tx.timer = setTimeout(() => this.transactions.delete(txId), this.transactionTimeoutMs);
    // Never keeps a process alive.
    (tx.timer as {unref?: () => void}).unref?.();
  }

  private end(txId: string): void {
    const tx = this.transactions.get(txId);
    if (tx?.timer) clearTimeout(tx.timer);
    this.transactions.delete(txId);
  }

  /**
   * Run `fn` on the data a query reads and writes: its transaction's snapshot, or the store's.
   * A write outside a transaction moves the version, so an open transaction can tell.
   */
  private within<T>(query: object, write: boolean, fn: (data: Data) => T): T {
    const txId = txIdOf(query);
    if (txId === undefined) {
      const result = withShapeCatalog(catalogOf(query), () => fn(this.data));
      if (write) this.version++;
      return result;
    }
    const tx = this.open(txId);
    this.touch(txId);
    return withShapeCatalog(catalogOf(query), () => fn(tx.data));
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async selectQuery(query: SelectQuery | CountQuery): Promise<SelectResult | number> {
    const ir = lower(query as SelectQuery) as IRSelectQuery | IRCountQuery;
    return this.within(query, false, (data) => {
      if (ir.kind === 'count') return this.match(data, ir).length;
      return this.rows(data, ir);
    });
  }

  async askQuery(query: AskQuery): Promise<boolean> {
    const ir = lower(query);
    return this.within(query, false, (data) => {
      if (!ir.root) {
        this.refuseGraphs(ir.graphs);
        if (ir.patterns.length || ir.where) throw new InMemoryQueryRefusal('a shapeless ask with a pattern');
        const ids = ir.subjectIds ?? (ir.subjectId ? [ir.subjectId] : []);
        return ids.some((id) => data.has(id));
      }
      return this.match(data, ir as IRAskQuery & {root: NonNullable<IRAskQuery['root']>}).length > 0;
    });
  }

  /** Refused: whole-graph operations need named graphs, which this store does not have. */
  async graphQuery(query: GraphQuery): Promise<GraphResult> {
    throw unsupportedGraphQuery(query, 'InMemoryDataset keeps one graph');
  }

  /** The subjects a select, count or ask matches, in insertion order. */
  private match(
    data: Data,
    ir: Pick<IRSelectQuery, 'root' | 'patterns' | 'where' | 'subjectId' | 'subjectIds' | 'graphs'>,
  ): string[] {
    this.refuseGraphs(ir.graphs);
    if (ir.patterns.length) throw new InMemoryQueryRefusal('nested paths or sub-selections');
    const classes = this.classesOf(ir.root.shape);
    const candidates = ir.subjectIds ?? (ir.subjectId ? [ir.subjectId] : [...data.keys()]);
    return candidates.filter(
      (id) =>
        this.isTyped(data, id, classes) &&
        (!ir.where || this.truthy(this.evaluate(data, id, ir.root.alias, ir.where))),
    );
  }

  private rows(data: Data, ir: IRSelectQuery): SelectResult {
    if (ir.groupBy?.length || ir.having) throw new InMemoryQueryRefusal('grouping');
    if (ir.orderBy?.length) throw new InMemoryQueryRefusal('sorting');
    const fields = (ir.resultMap ?? []).map((entry) => {
      const item = ir.projection.find((p) => p.alias === entry.alias);
      const expr = item?.expression;
      if (!expr || expr.kind !== 'property_expr' || expr.sourceAlias !== ir.root.alias || expr.pathExpr) {
        throw new InMemoryQueryRefusal('a field that is not one of the subject\'s own properties');
      }
      return {key: localName(entry.key), predicate: this.predicate(expr.property), single: expr.maxCount === 1};
    });
    let ids = this.match(data, ir);
    if (ir.offset) ids = ids.slice(ir.offset);
    if (ir.limit !== undefined) ids = ids.slice(0, ir.limit);
    const rows = ids.map((id) => {
      const row: ResultRow = {id};
      const props = data.get(id);
      for (const field of fields) {
        const values = (props?.get(field.predicate) ?? []).map(toResult);
        row[field.key] = field.single ? (values[0] ?? null) : (values as ResultFieldValue);
      }
      return row;
    });
    return ir.singleResult ? (rows[0] ?? null) : rows;
  }

  /** The value of an expression for one subject (`alias` names the subject). */
  private evaluate(data: Data, subject: string, alias: string, expr: IRExpression): Value | Value[] | boolean | null {
    switch (expr.kind) {
      case 'literal_expr':
        return expr.value as Value | null;
      case 'reference_expr':
        if (expr.value === undefined) throw new InMemoryQueryRefusal('a context reference');
        return {id: expr.value};
      case 'alias_expr':
        if (expr.alias !== alias) throw new InMemoryQueryRefusal('a reference to another node of the pattern');
        return {id: subject};
      case 'property_expr':
        if (expr.sourceAlias !== alias || expr.pathExpr) {
          throw new InMemoryQueryRefusal('a condition on a property of another node');
        }
        return data.get(subject)?.get(this.predicate(expr.property)) ?? [];
      case 'binary_expr': {
        if (expr.operator !== '=' && expr.operator !== '!=') {
          throw new InMemoryQueryRefusal(`the operator ${expr.operator}`);
        }
        const left = asValues(this.evaluate(data, subject, alias, expr.left));
        const right = asValues(this.evaluate(data, subject, alias, expr.right));
        const equal = left.some((l) => right.some((r) => sameValue(l, r)));
        // As SPARQL: `!=` holds when some pair of values differs (and none is missing).
        if (expr.operator === '=') return equal;
        return left.some((l) => right.some((r) => !sameValue(l, r)));
      }
      case 'logical_expr':
        return expr.operator === 'and'
          ? expr.expressions.every((e) => this.truthy(this.evaluate(data, subject, alias, e)))
          : expr.expressions.some((e) => this.truthy(this.evaluate(data, subject, alias, e)));
      case 'not_expr':
        return !this.truthy(this.evaluate(data, subject, alias, expr.expression));
      default:
        throw new InMemoryQueryRefusal(`a ${expr.kind} condition`);
    }
  }

  private truthy(value: Value | Value[] | boolean | null): boolean {
    if (typeof value === 'boolean') return value;
    throw new InMemoryQueryRefusal('a condition that is not a comparison');
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async createQuery(query: CreateQuery): Promise<CreateResult> {
    const ir = lower(query) as IRCreateMutation;
    return this.within(query, true, (data) => {
      this.refuseGraph(ir.graph);
      const id = ir.data.id || generateEntityUri(ir.data.shape, {dataRoot: this.root});
      ir.data.id = id;
      mintNestedIds(ir, {dataRoot: this.root});
      this.writeNode(data, ir.data, id);
      return mapSparqlCreateResult(id, ir);
    });
  }

  async updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    const ir = lower(query);
    if (ir.kind === 'update_where') throw new InMemoryQueryRefusal('an update of every match (forAll / where)');
    return this.within(query, true, (data) => {
      this.refuseGraph(ir.graph);
      if (ir.writeGraphs?.length) this.refuseGraphs(ir.writeGraphs);
      if (ir.traversalPatterns?.length) throw new InMemoryQueryRefusal('an update through a path');
      mintNestedIds(ir, {dataRoot: this.root});
      if (ir.kind === 'update' && !this.isTyped(data, ir.id, this.classesOf(ir.shape))) {
        // As a SPARQL store: an update by id matches a typed node only; nothing is written and the
        // call still resolves with the fields it was given.
        this.warnNoMatch(ir);
        return mapSparqlUpdateResult(ir);
      }
      this.writeNode(data, ir.data, ir.id, ir.kind === 'upsert' ? 'replace' : 'update');
      return mapSparqlUpdateResult(ir as IRUpdateMutation | IRUpsertMutation);
    });
  }

  async deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    const ir = lower(query);
    return this.within(query, true, (data) => {
      if (ir.kind === 'delete_shapeless') {
        for (const {id} of ir.ids) this.deleteNode(data, id, !!ir.keepIncoming);
        return {deleted: ir.ids, count: ir.ids.length};
      }
      this.refuseGraph(ir.graph);
      if (ir.writeGraphs?.length) this.refuseGraphs(ir.writeGraphs);
      this.refuseOwned(ir.shape);
      const classes = this.classesOf(ir.shape);
      if (ir.kind === 'delete_where') throw new InMemoryQueryRefusal('a delete of every match of a where clause');
      if (ir.kind === 'delete_all') {
        for (const id of [...data.keys()]) if (this.isTyped(data, id, classes)) this.deleteNode(data, id, false);
        return {deleted: [], count: 0};
      }
      for (const {id} of ir.ids) {
        if (this.isTyped(data, id, classes)) this.deleteNode(data, id, !!ir.keepIncoming);
      }
      return {deleted: ir.ids, count: ir.ids.length};
    });
  }

  /**
   * Write a node's fields: `'create'` adds them (and the type), `'update'` replaces the fields it
   * names, `'replace'` (an upsert) replaces the fields it names and types the node.
   */
  private writeNode(data: Data, node: IRNodeData, id: string, mode: 'create' | 'update' | 'replace' = 'create'): void {
    let props = data.get(id);
    if (!props) data.set(id, (props = new Map()));
    if (mode !== 'update') {
      const type = this.typeOf(node.shape);
      const types = props.get(RDF_TYPE) ?? [];
      if (!types.some((t) => sameValue(t, {id: type}))) props.set(RDF_TYPE, [...types, {id: type}]);
    }
    for (const field of node.fields) {
      const predicate = this.predicate(field.property);
      const value = field.value;
      if (isSetModification(value)) {
        const current = props.get(predicate) ?? [];
        const removed = (value.remove ?? []).map((r) => ({id: r.id}));
        const kept = current.filter((v) => !removed.some((r) => sameValue(v, r)));
        const added = this.values(data, value.add ?? []).filter((v) => !kept.some((k) => sameValue(k, v)));
        props.set(predicate, [...kept, ...added]);
        continue;
      }
      const values = value === undefined || value === null ? [] : this.values(data, value);
      if (values.length) props.set(predicate, values);
      else props.delete(predicate);
    }
  }

  /** The stored values of a field value; a nested node is written first. */
  private values(data: Data, value: IRFieldValue): Value[] {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.flatMap((item) => this.values(data, item));
    if (value instanceof Date) return [value];
    if (typeof value !== 'object') return [value];
    if (isNodeData(value)) {
      const id = value.id || generateEntityUri(value.shape, {dataRoot: this.root});
      this.writeNode(data, value, id);
      return [{id}];
    }
    if (isNode(value)) return [{id: value.id}];
    throw new InMemoryQueryRefusal('a computed value');
  }

  private deleteNode(data: Data, id: string, keepIncoming: boolean): void {
    data.delete(id);
    if (keepIncoming) return;
    for (const props of data.values()) {
      for (const [predicate, values] of props) {
        const kept = values.filter((v) => !(isNode(v) && v.id === id));
        if (kept.length !== values.length) {
          if (kept.length) props.set(predicate, kept);
          else props.delete(predicate);
        }
      }
    }
  }

  private warnNoMatch(ir: IRUpdateMutation): void {
    if (inProduction()) return;
    console.warn(
      `[linked] update().for(<${ir.id}>) on <${ir.shape}> matched no node in ${this.id}: nothing was ` +
        'written (the call still resolves with the fields it was given). (Said outside production only.)',
    );
  }

  // ---------------------------------------------------------------------------
  // Shapes and terms
  // ---------------------------------------------------------------------------

  private typeOf(shape: string): string {
    const type = getTargetClassId({id: shape});
    if (!type) throw new InMemoryQueryRefusal(`the shape <${shape}> declares no targetClass`);
    return type;
  }

  /** A shape's class and its subclasses: what a node of the shape is typed with. */
  private classesOf(shape: string): ReadonlySet<string> {
    const type = this.typeOf(shape);
    return new Set([type, ...subClassesOf(type)]);
  }

  private isTyped(data: Data, id: string, classes: ReadonlySet<string>): boolean {
    return (data.get(id)?.get(RDF_TYPE) ?? []).some((t) => isNode(t) && classes.has(t.id));
  }

  /** The predicate a property shape writes: its `sh:path`, when that is one IRI. */
  private predicate(property: string): string {
    const shape = findPropertyShapeById(property);
    if (!shape) return property;
    const path = getSimplePathId(shape.path);
    if (path === null) throw new InMemoryQueryRefusal(`the complex path of <${property}>`);
    return path;
  }

  private refuseOwned(shape: string): void {
    const nodeShape = getAllNodeShapes().get(shape);
    if (nodeShape && getPropertyShapes(nodeShape, true).some((p) => p.contains)) {
      throw new InMemoryQueryRefusal(`a delete of <${shape}>, which owns values (contains) it would not cascade to`);
    }
  }

  private refuseGraph(graph: string | undefined): void {
    if (graph !== undefined && graph !== graphs.default) {
      throw new InMemoryQueryRefusal(`the graph <${graph}> (it keeps one graph)`);
    }
  }

  private refuseGraphs(names: readonly string[] | undefined): void {
    for (const name of names ?? []) this.refuseGraph(name);
  }
}

const asValues = (value: Value | Value[] | boolean | null): Value[] =>
  value === null ? [] : Array.isArray(value) ? value : [value as Value];

const toResult = (value: Value): ResultFieldValue => (isNode(value) ? ({id: value.id} as ResultRow) : value);

function isNodeData(value: object): value is IRNodeData {
  return typeof (value as IRNodeData).shape === 'string' && Array.isArray((value as IRNodeData).fields);
}

function isSetModification(value: IRFieldValue): value is {add?: IRFieldValue[]; remove?: {id: string}[]} {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    ('add' in value || 'remove' in value) &&
    !('kind' in value)
  );
}
