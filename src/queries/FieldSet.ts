import type {NodeShapeData, PropertyShapeData} from '../shapes/SHACL.js';
import {getUniquePropertyShapes, getPropertyShape} from '../shapes/nodeShapeData.js';
import type {Shape, ShapeConstructor} from '../shapes/Shape.js';
import {PropertyPath, walkPropertyPath} from './PropertyPath.js';
import {
  captureCatalog,
  getActiveShapeCatalog,
  getAllNodeShapes,
  getAllShapeClasses,
  getNodeShape,
  getShapeClass,
  withShapeCatalog,
  getQueryShapeClass,
} from '../utils/ShapeClass.js';
import type {ShapeCatalog} from '../utils/ShapeCatalog.js';
import type {WherePath} from './SelectQuery.js';
import {createProxiedPathBuilder} from './ProxiedPathBuilder.js';
import {isExpressionNode, ExpressionNode} from '../expressions/ExpressionNode.js';
import {encodeValueExpr, decodeValueExpr, type DslJsonValue} from './DslJsonExpression.js';
import {
  serializeWherePath,
  deserializeWherePath,
  type WherePathJSON,
} from './QueryBuilderSerialization.js';

// Duck-type helpers for runtime detection.
// These check structural shape since the classes live in SelectQuery.ts (runtime circular dep).
// QueryBuilderObject has .property (PropertyShapeData) and .subject (QueryBuilderObject).
// SetSize has .subject and extends QueryPrimitive<number>.
type QueryBuilderObjectLike = {
  property?: PropertyShapeData;
  subject?: QueryBuilderObjectLike;
  wherePath?: unknown;
};
const isQueryBuilderObject = (obj: any): obj is QueryBuilderObjectLike =>
  obj !== null &&
  typeof obj === 'object' &&
  'property' in obj &&
  'subject' in obj &&
  typeof obj.getPropertyPath === 'function';

const isSetSize = (obj: any): boolean =>
  obj !== null &&
  typeof obj === 'object' &&
  'subject' in obj &&
  typeof obj.as === 'function' &&
  typeof obj.getPropertyPath === 'function' &&
  // SetSize has a 'countable' field (may be undefined) and 'label' field
  'label' in obj;

// BoundComponent: has .source (QueryBuilderObject) and .originalValue (component-like)
const isBoundComponent = (obj: any): boolean =>
  obj !== null &&
  typeof obj === 'object' &&
  'source' in obj &&
  'originalValue' in obj;

/**
 * A single entry in a FieldSet: a property path with optional alias, scoped filter,
 * sub-selection, aggregation, and custom key.
 */
export type FieldSetEntry = {
  path: PropertyPath;
  alias?: string;
  scopedFilter?: WherePath;
  /** Index into path.segments indicating which segment the scopedFilter applies to.
   *  Defaults to the last segment if not specified. */
  scopedFilterIndex?: number;
  /** Nested object selection — the user explicitly selected sub-fields (e.g. `p.friends.select(...)`) */
  subSelect?: FieldSet;
  aggregation?: 'count';
  customKey?: string;
  /** Component preload composition — the FieldSet comes from a linked component's own query,
   *  merged in via `preloadFor()`. Distinct from subSelect which is a user-authored nested query. */
  preloadSubSelect?: FieldSet;
  /** Computed expression from proxy tracing (e.g. `p.age.times(12)`) */
  expressionNode?: ExpressionNode;
  /** Inner LIMIT for a nested select (e.g. `p.friends.select(...).limit(2)`).
   *  Only supported when the outer query targets a single subject. */
  innerLimit?: number;
  /** Inner OFFSET for a nested select. */
  innerOffset?: number;
  /** Inner ORDER BY for a nested select — paths relative to the sub-select shape. */
  innerOrderBy?: FieldSetInnerOrderBy[];
};

/** A single inner ORDER BY clause for a nested select. */
export type FieldSetInnerOrderBy = {
  propertyShapeId: string;
  direction: 'ASC' | 'DESC';
};

/**
 * Input types accepted by FieldSet construction methods.
 *
 * - `string` — resolved via walkPropertyPath (dot-separated)
 * - `PropertyPath` — used directly
 * - `FieldSet` — merged in
 * - `Record<string, string[] | FieldSet>` — nested fields
 */
export type FieldSetInput =
  | string
  | PropertyPath
  | FieldSet
  | Record<string, string[] | FieldSet>;

/** A computed projection field: `{ as?, value }` — a DSL-JSON expression, no path. */
export type FieldSetComputedJSON = {
  as?: string;
  value: DslJsonValue;
  customKey?: string;
};

/** Options for a relation projection (the object value under a relation key). */
export type FieldSetRelationOptionsJSON = {
  as?: string;
  /** Shape IRI for nested fields when it differs from the relation's declared value shape. */
  shape?: string;
  /** A scoped filter on the relation (`p.friends.where(...)`). */
  where?: WherePathJSON;
  /** Which path segment the scoped `where` applies to (defaults to the last). */
  whereIndex?: number;
  aggregation?: string;
  customKey?: string;
  /** Nested-select pagination (`p.friends.select(...).limit(5).offset(2).orderBy(...)`). */
  limit?: number;
  offset?: number;
  orderBy?: Array<{[path: string]: 'ASC' | 'DESC'}>;
  /** Sub-projection of the related shape. */
  fields?: FieldSetFieldJSON[];
};

/**
 * A relation-keyed field: a single-key object whose key is the relation path
 * (labels dotted, with inline `as(Shape)` casts) and whose value is either the
 * sub-fields array (`{ "friends": ["name"] }`) or an options object
 * (`{ "friends": { as, where, fields } }`). Also covers a leaf with options
 * (`{ "name": { "as": "personName" } }`). The related shape is inferred.
 */
export type FieldSetRelationJSON = {
  [path: string]: FieldSetFieldJSON[] | FieldSetRelationOptionsJSON;
};

/**
 * JSON representation of a FieldSet field entry — exactly three shapes:
 *   - a **string** leaf path (`"name"`, `"friends.friends.name"`, `"pets.as(Dog).level"`)
 *   - a **relation-keyed** object (`{ "friends": [...] | {options} }`)
 *   - a **computed** object (`{ as?, value }`)
 */
export type FieldSetFieldJSON = string | FieldSetComputedJSON | FieldSetRelationJSON;

/** JSON representation of a FieldSet (a shape + its top-level fields). */
export type FieldSetJSON = {
  shape: string;
  fields: FieldSetFieldJSON[];
};

/** Option keys reserved inside a relation options object (never a relation path). */
const RELATION_OPTION_KEYS = new Set([
  'as',
  'shape',
  'where',
  'whereIndex',
  'aggregation',
  'customKey',
  'limit',
  'offset',
  'orderBy',
  'fields',
]);

/**
 * An immutable, composable collection of property paths for a shape.
 *
 * FieldSet describes which properties to select, independent of
 * how the query is built. It integrates with QueryBuilder via
 * `.select(fieldSet)`.
 *
 * Every mutation method returns a new FieldSet — the original is never modified.
 */
export class FieldSet<R = any, Source = any> {
  readonly shape: NodeShapeData;
  readonly entries: readonly FieldSetEntry[];
  /** Phantom field — carries the callback response type for conditional type inference. */
  declare readonly __response: R;
  /** Phantom field — carries the source context (QueryShapeSet/QueryShape) for conditional type inference. */
  declare readonly __source: Source;

  /**
   * For sub-select FieldSets: the raw callback return value (proxy trace objects).
   * Stored so conditional types can extract the response type.
   */
  readonly traceResponse?: R;

  /**
   * For sub-select FieldSets: the parent property segments leading to this sub-select.
   */
  readonly parentSegments?: PropertyShapeData[];

  /**
   * For sub-select FieldSets: the shape class (ShapeType) of the sub-select's target.
   */
  readonly shapeType?: any;

  /**
   * For sub-select FieldSets: inline `.where()` filter found on the parent
   * traversal chain (e.g. `p.friends.where(...).select(...)`), plus the index
   * into `parentSegments` of the segment it scopes.
   */
  readonly parentWherePath?: WherePath;
  readonly parentWherePathIndex?: number;

  /**
   * For sub-select FieldSets: inner LIMIT/OFFSET/ORDER BY carried from
   * `.limit()`/`.offset()`/`.orderBy()` chained on the nested select.
   * These bound the related collection per parent (single-subject only).
   */
  readonly innerLimit?: number;
  readonly innerOffset?: number;
  readonly innerOrderBy?: FieldSetInnerOrderBy[];

  private readonly _catalog: ShapeCatalog | undefined;

  private constructor(
    shape: NodeShapeData,
    entries: FieldSetEntry[],
    catalog: ShapeCatalog | undefined = FieldSet.captureFor(shape),
  ) {
    this.shape = shape;
    this.entries = entries;
    this._catalog = catalog;
  }

  /** The catalog this FieldSet resolves shapes in (undefined = the global registry). */
  get catalog(): ShapeCatalog | undefined {
    return this._catalog;
  }

  /**
   * The catalog a FieldSet rooted at `shape` captures: the active one for an IRI or a
   * shape it holds, none for a shape it does not (an authored class built by code that
   * runs inside a project scope), else the catalog an adapter class came from.
   */
  private static captureFor(
    shape: ShapeConstructor<any> | NodeShapeData | string,
  ): ShapeCatalog | undefined {
    if (typeof shape === 'function') return captureCatalog(shape);
    const active = getActiveShapeCatalog();
    if (active === undefined || typeof shape === 'string') return active;
    return active.has(shape.id) ? active : undefined;
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  /**
   * Create a FieldSet for the given shape with the specified fields.
   *
   * Accepts a ShapeClass (e.g. Person), NodeShapeData, or shape IRI string.
   * Fields can be string paths, PropertyPath instances, nested objects,
   * or a callback receiving a proxy for dot-access.
   */
  static for<S extends Shape>(shape: ShapeConstructor<S>, fields: FieldSetInput[]): FieldSet<any>;
  static for<S extends Shape, R>(shape: ShapeConstructor<S>, fn: (p: any) => R): FieldSet<R>;
  static for(shape: NodeShapeData | string, fields: FieldSetInput[]): FieldSet<any>;
  static for(shape: NodeShapeData | string, fn: (p: any) => any): FieldSet<any>;
  static for(
    shape: ShapeConstructor<any> | NodeShapeData | string,
    fieldsOrFn: FieldSetInput[] | ((p: any) => any),
  ): FieldSet<any> {
    const catalog = FieldSet.captureFor(shape);
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => FieldSet.for(shape as string, fieldsOrFn as FieldSetInput[]));
    }
    const resolved = FieldSet.resolveShapeInput(shape);
    const resolvedShape = resolved.nodeShape;

    if (typeof fieldsOrFn === 'function') {
      if (!resolved.shapeClass) {
        throw new Error(
          `Cannot use callback form for shape '${resolved.nodeShape.id}': no ShapeConstructor registered. ` +
          `Use string field names instead, or pass the Shape class directly.`,
        );
      }
      const fields = FieldSet.traceFieldsWithProxy(resolved.nodeShape, resolved.shapeClass, fieldsOrFn);
      return new FieldSet(resolved.nodeShape, fields);
    }

    const entries = FieldSet.resolveInputs(resolvedShape, fieldsOrFn);
    return new FieldSet(resolvedShape, entries);
  }

  /**
   * Create a typed FieldSet for a sub-select. Traces the callback through the proxy,
   * stores parentSegments and traceResponse for runtime compatibility, and preserves
   * R and Source generics for conditional type inference.
   */
  static forSubSelect<R, Source>(
    shapeClass: any,
    fn: (p: any) => R,
    parentSegments: PropertyShapeData[],
    source?: QueryBuilderObjectLike,
  ): FieldSet<R, Source> {
    const nodeShape = shapeClass.shape || shapeClass;
    // Trace once: get both the raw response (for type carriers) and the entries
    const proxy = createProxiedPathBuilder(shapeClass);
    const traceResponse = fn(proxy as any);
    const entries = FieldSet.extractSubSelectEntries(nodeShape, traceResponse);
    const fs = new FieldSet(nodeShape, entries) as FieldSet<R, Source>;
    // Writable cast — these readonly fields are initialised once here at construction time
    const w = fs as {-readonly [K in 'traceResponse' | 'parentSegments' | 'shapeType' | 'parentWherePath' | 'parentWherePathIndex']: FieldSet<R, Source>[K]};
    w.traceResponse = traceResponse;
    w.parentSegments = parentSegments;
    w.shapeType = shapeClass;
    // Carry an inline `.where()` from the parent traversal chain (walked
    // leaf→root, same convention as convertTraceResult for plain paths).
    let current = source;
    let leafDistance = 0;
    while (current) {
      if (current.wherePath) {
        w.parentWherePath = current.wherePath as WherePath;
        w.parentWherePathIndex = parentSegments.length - 1 - leafDistance;
        break;
      }
      current = current.subject;
      leafDistance++;
    }
    return fs;
  }


  /**
   * Create a FieldSet containing all decorated properties of the shape.
   *
   * @param opts.depth Controls how deep to include nested shape properties:
   *   - `depth=1` (default): this level only — properties of the root shape.
   *   - `depth=0`: throws — use a node reference instead.
   *   - `depth>1`: recursively includes nested shape properties up to the given depth.
   */
  static all<S extends Shape>(shape: ShapeConstructor<S>, opts?: {depth?: number}): FieldSet;
  static all(shape: NodeShapeData | string, opts?: {depth?: number}): FieldSet;
  static all(shape: ShapeConstructor<any> | NodeShapeData | string, opts?: {depth?: number}): FieldSet {
    const catalog = FieldSet.captureFor(shape);
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => FieldSet.all(shape as string, opts));
    }
    const depth = opts?.depth ?? 1;
    if (depth < 1) {
      throw new Error(
        'FieldSet.all() requires depth >= 1. Use a node reference ({id}) for depth 0.',
      );
    }
    const resolved = FieldSet.resolveShapeInput(shape);
    // Seed visited with the root shape to prevent self-referencing cycles
    const visited = new Set<string>([resolved.nodeShape.id]);
    return FieldSet.allForShape(resolved.nodeShape, depth, visited);
  }

  /**
   * Recursive helper for all(). Tracks visited shape IDs to prevent infinite loops
   * from circular shape references.
   */
  private static allForShape(
    nodeShape: NodeShapeData,
    depth: number,
    visited: Set<string>,
  ): FieldSet {
    const propertyShapes = getUniquePropertyShapes(nodeShape);
    const entries: FieldSetEntry[] = [];

    for (const ps of propertyShapes) {
      const entry: FieldSetEntry = {path: new PropertyPath(nodeShape, [ps])};

      // If depth > 1, recurse into nested shapes
      if (depth > 1 && ps.valueShape) {
        const nestedShapeClass = getQueryShapeClass(ps.valueShape);
        if (nestedShapeClass?.shape && !visited.has(nestedShapeClass.shape.id)) {
          visited.add(nestedShapeClass.shape.id);
          const nestedFs = FieldSet.allForShape(nestedShapeClass.shape, depth - 1, visited);
          if (nestedFs.entries.length > 0) {
            entry.subSelect = nestedFs;
          }
        }
      }

      entries.push(entry);
    }

    return new FieldSet(nodeShape, entries);
  }

  /**
   * Merge multiple FieldSets into one, deduplicating by path equality.
   * All FieldSets must share the same root shape.
   */
  static merge(sets: FieldSet[]): FieldSet {
    if (sets.length === 0) {
      throw new Error('Cannot merge empty array of FieldSets');
    }
    const shape = sets[0].shape;
    for (const set of sets) {
      if (set.shape.id !== shape.id) {
        throw new Error(
          `Cannot merge FieldSets with different shapes: '${shape.label || shape.id}' and '${set.shape.label || set.shape.id}'`,
        );
      }
    }
    const merged: FieldSetEntry[] = [];
    const seen = new Set<string>();

    for (const set of sets) {
      for (const entry of set.entries) {
        // Include aggregation in the dedup key so that 'friends' and 'friends(count)' are distinct
        const key = entry.aggregation
          ? `${entry.path.toString()}:${entry.aggregation}`
          : entry.path.toString();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(entry);
        }
      }
    }

    return new FieldSet(shape, merged, sets[0]._catalog);
  }

  // ---------------------------------------------------------------------------
  // Composition methods — each returns a new FieldSet
  // ---------------------------------------------------------------------------

  /** Returns a new FieldSet with only the given fields. */
  select(fields: FieldSetInput[]): FieldSet {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.select(fields));
    }
    const entries = FieldSet.resolveInputs(this.shape, fields);
    return new FieldSet(this.shape, entries, this._catalog);
  }

  /**
   * Clone this FieldSet, preserving the sub-select carrier fields
   * (traceResponse / parentSegments / shapeType / inner pagination) and
   * applying the supplied overrides. Used by `.limit()`/`.offset()`/`.orderBy()`.
   */
  private cloneWith(
    overrides: Partial<Pick<FieldSet, 'innerLimit' | 'innerOffset' | 'innerOrderBy'>>,
  ): this {
    const clone = new FieldSet(this.shape, this.entries as FieldSetEntry[], this._catalog) as this;
    // The sub-select carrier fields are declared `readonly` (normally set once at
    // construction via `forSubSelect`). Copy this FieldSet's identity onto the
    // clone through a mutable view, then layer the pagination overrides on top.
    Object.assign(clone as Record<string, unknown>, {
      traceResponse: this.traceResponse,
      parentSegments: this.parentSegments,
      shapeType: this.shapeType,
      parentWherePath: this.parentWherePath,
      parentWherePathIndex: this.parentWherePathIndex,
      innerLimit: this.innerLimit,
      innerOffset: this.innerOffset,
      innerOrderBy: this.innerOrderBy,
      ...overrides,
    });
    return clone;
  }

  /**
   * Bound a nested select's related collection to at most `lim` items per parent.
   * Only honoured when the outer query targets a single subject; otherwise the
   * pipeline throws (per-group pagination across multiple parents is unsupported).
   */
  limit(lim: number): this {
    return this.cloneWith({innerLimit: lim});
  }

  /** Skip the first `off` items of a nested select's related collection (single-subject only). */
  offset(off: number): this {
    return this.cloneWith({innerOffset: off});
  }

  /**
   * Order a nested select's related collection, producing a deterministic window
   * for inner LIMIT/OFFSET. Defaults to ascending.
   *
   * Accepts either a proxy callback — `.orderBy(f => f.name)` — consistent with
   * the rest of the DSL, or a property-name string (`.orderBy('name')`).
   */
  orderBy(
    paths: string | string[] | ((p: any) => unknown),
    direction: 'ASC' | 'DESC' = 'ASC',
  ): this {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.orderBy(paths, direction));
    }
    const orderBy: FieldSetInnerOrderBy[] =
      typeof paths === 'function'
        ? this.orderByFromProxy(paths, direction)
        : (Array.isArray(paths) ? paths : [paths]).map((label) => {
            const ps = walkPropertyPath(this.shape, label).terminal;
            if (!ps) {
              throw new Error(`orderBy: cannot resolve property '${label}' on shape '${this.shape.id}'`);
            }
            return {propertyShapeId: ps.id, direction};
          });
    return this.cloneWith({innerOrderBy: orderBy});
  }

  /** Resolve a proxy `orderBy` callback (e.g. `f => f.name` or `f => [f.a, f.b]`)
   *  to inner order-by clauses by tracing the sub-select shape's property proxy. */
  private orderByFromProxy(
    fn: (p: any) => unknown,
    direction: 'ASC' | 'DESC',
  ): FieldSetInnerOrderBy[] {
    if (!this.shapeType) {
      throw new Error(
        'orderBy(callback) is only available on a nested select(); pass a property-name string otherwise',
      );
    }
    const response = fn(createProxiedPathBuilder(this.shapeType));
    const results = Array.isArray(response) ? response : [response];
    return results.map((result) => {
      const segments = FieldSet.collectPropertySegments(result as QueryBuilderObjectLike);
      const terminal = segments[segments.length - 1];
      if (!terminal) {
        throw new Error('orderBy: callback did not resolve to a property of the sub-select shape');
      }
      return {propertyShapeId: terminal.id, direction};
    });
  }

  /** Returns a new FieldSet with additional entries. */
  add(fields: FieldSetInput[]): FieldSet {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.add(fields));
    }
    const newEntries = FieldSet.resolveInputs(this.shape, fields);
    // Deduplicate
    const existing = new Set(this.entries.map((e) => e.path.toString()));
    const combined = [...this.entries];
    for (const entry of newEntries) {
      if (!existing.has(entry.path.toString())) {
        combined.push(entry);
      }
    }
    return new FieldSet(this.shape, combined, this._catalog);
  }

  /** Returns a new FieldSet without entries matching the given labels. */
  remove(labels: string[]): FieldSet {
    const labelSet = new Set(labels);
    const filtered = (this.entries as FieldSetEntry[]).filter(
      (e) => !labelSet.has(e.path.terminal?.label),
    );
    return new FieldSet(this.shape, filtered, this._catalog);
  }

  /** Synonym for replacing all entries — returns a new FieldSet with only the given fields. */
  set(fields: FieldSetInput[]): FieldSet {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.set(fields));
    }
    const entries = FieldSet.resolveInputs(this.shape, fields);
    return new FieldSet(this.shape, entries, this._catalog);
  }

  /** Returns a new FieldSet keeping only entries matching the given labels. */
  pick(labels: string[]): FieldSet {
    const labelSet = new Set(labels);
    const filtered = (this.entries as FieldSetEntry[]).filter(
      (e) => labelSet.has(e.path.terminal?.label),
    );
    return new FieldSet(this.shape, filtered, this._catalog);
  }

  /** Returns all PropertyPaths in this FieldSet. */
  paths(): PropertyPath[] {
    return (this.entries as FieldSetEntry[]).map((e) => e.path);
  }

  /** Returns terminal property labels of all entries. */
  labels(): string[] {
    return (this.entries as FieldSetEntry[]).map((e) => e.path.terminal?.label).filter(Boolean) as string[];
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Serialize this FieldSet to a plain JSON object.
   * Shape is identified by its IRI, paths by dot-separated labels.
   */
  toJSON(): FieldSetJSON {
    const catalog = this._catalog;
    if (catalog !== getActiveShapeCatalog()) {
      return withShapeCatalog(catalog, () => this.toJSON());
    }
    return {shape: this.shape.id, fields: this.toFieldsJSON()};
  }

  /** Serialize just the field entries (used for nested relation sub-fields). */
  private toFieldsJSON(): FieldSetFieldJSON[] {
    return (this.entries as FieldSetEntry[]).map((entry) =>
      this.serializeEntry(entry),
    );
  }

  private serializeEntry(entry: FieldSetEntry): FieldSetFieldJSON {
    // Computed projection — no path; carry the DSL-JSON value.
    if (entry.expressionNode) {
      const out: FieldSetComputedJSON = {
        value: encodeValueExpr(entry.expressionNode.ir, entry.expressionNode._refs),
      };
      if (entry.alias) out.as = entry.alias;
      if (entry.customKey) out.customKey = entry.customKey;
      return out;
    }
    const pathStr = FieldSet.pathToStringWithCasts(this.shape, entry.path.segments);
    const sub = entry.subSelect ?? entry.preloadSubSelect;
    const subFields = sub ? sub.toFieldsJSON() : undefined;
    const opts: FieldSetRelationOptionsJSON = {};
    const naturalSubShape = FieldSet.nestedShapeOf(entry.path);
    if (sub && sub.shape.id !== naturalSubShape?.id) opts.shape = sub.shape.id;
    if (entry.alias) opts.as = entry.alias;
    if (entry.aggregation) opts.aggregation = entry.aggregation;
    if (entry.customKey) opts.customKey = entry.customKey;
    if (entry.scopedFilter) {
      const idx = entry.scopedFilterIndex ?? entry.path.segments.length - 1;
      opts.where = serializeWherePath(entry.scopedFilter, this.scopedShapeAt(entry, idx));
      opts.whereIndex = idx;
    }
    // Nested-select pagination (G10) — was previously dropped on the wire.
    if (typeof entry.innerLimit === 'number') opts.limit = entry.innerLimit;
    if (typeof entry.innerOffset === 'number') opts.offset = entry.innerOffset;
    if (entry.innerOrderBy && entry.innerOrderBy.length > 0) {
      opts.orderBy = entry.innerOrderBy.map((o) => ({
        [FieldSet.labelOfId(o.propertyShapeId)]: o.direction,
      }));
    }
    const hasOpts = Object.keys(opts).length > 0;
    // Bare-string shorthand: a plain leaf/relation with no options or sub-fields.
    if (!subFields && !hasOpts) return pathStr;
    // Array shorthand: sub-fields only, no other options.
    if (subFields && !hasOpts) return {[pathStr]: subFields};
    // Full options object (optionally carrying `fields`).
    return {[pathStr]: {...opts, ...(subFields ? {fields: subFields} : {})}};
  }

  /** The shape a scoped filter at segment `idx` is evaluated against (the segment's value shape). */
  private scopedShapeAt(entry: FieldSetEntry, idx: number): NodeShapeData {
    const seg = entry.path.segments[idx] as PropertyShapeData | undefined;
    const valueShapeId = (seg as unknown as {valueShape?: {id: string}})
      ?.valueShape?.id;
    return (valueShapeId && getQueryShapeClass(valueShapeId)?.shape) || this.shape;
  }

  /**
   * Reconstruct a FieldSet from a JSON object.
   * Resolves shape IRI via getShapeClass() and paths via walkPropertyPath().
   */
  static fromJSON(json: FieldSetJSON): FieldSet {
    return FieldSet.fromFields(FieldSet.resolveShape(json.shape), json.fields);
  }

  /** Build a FieldSet from a shape + relation-keyed field list (recursion entry). */
  private static fromFields(shape: NodeShapeData, fields: FieldSetFieldJSON[]): FieldSet {
    return new FieldSet(
      shape,
      fields.map((raw) => FieldSet.parseField(shape, raw)),
    );
  }

  /** Parse one field entry (string leaf / computed / relation-keyed) against `shape`. */
  private static parseField(shape: NodeShapeData, raw: FieldSetFieldJSON): FieldSetEntry {
    // Leaf path (may carry inline `as(Shape)` casts).
    if (typeof raw === 'string') {
      return {path: FieldSet.walkPathWithCasts(shape, raw)};
    }
    // Computed projection — carries `value`.
    if ('value' in raw && (raw as FieldSetComputedJSON).value !== undefined) {
      const computed = raw as FieldSetComputedJSON;
      const {ir, refs} = decodeValueExpr(computed.value, shape);
      const entry: FieldSetEntry = {
        path: new PropertyPath(shape, []),
        expressionNode: new ExpressionNode(ir, refs),
      };
      if (computed.as) entry.alias = computed.as;
      if (computed.customKey) entry.customKey = computed.customKey;
      return entry;
    }
    // Relation-keyed: the single non-option key is the relation path.
    const rel = raw as FieldSetRelationJSON;
    const pathKey = Object.keys(rel).find((k) => !RELATION_OPTION_KEYS.has(k));
    if (!pathKey) {
      throw new Error(`FieldSet field has no relation path: ${JSON.stringify(raw)}`);
    }
    const spec = rel[pathKey];
    const path = FieldSet.walkPathWithCasts(shape, pathKey);
    const entry: FieldSetEntry = {path};
    const subFields = Array.isArray(spec) ? spec : spec.fields;
    const opts = Array.isArray(spec) ? ({} as FieldSetRelationOptionsJSON) : spec;
    if (opts.as) entry.alias = opts.as;
    if (opts.customKey) entry.customKey = opts.customKey;
    if (opts.aggregation) entry.aggregation = opts.aggregation as 'count';
    if (opts.where) {
      const idx = opts.whereIndex ?? path.segments.length - 1;
      const seg = path.segments[idx] as PropertyShapeData | undefined;
      const valueShapeId = (seg as unknown as {valueShape?: {id: string}})?.valueShape?.id;
      const scopedShape = (valueShapeId && getQueryShapeClass(valueShapeId)?.shape) || shape;
      entry.scopedFilter = deserializeWherePath(scopedShape, opts.where);
      entry.scopedFilterIndex = idx;
    }
    // Nested-select pagination (G10).
    if (typeof opts.limit === 'number') entry.innerLimit = opts.limit;
    if (typeof opts.offset === 'number') entry.innerOffset = opts.offset;
    if (opts.orderBy && opts.orderBy.length > 0) {
      const nested = FieldSet.nestedShapeOf(path) ?? shape;
      entry.innerOrderBy = opts.orderBy.map((e) => {
        const label = Object.keys(e)[0];
        const ps = getPropertyShape(nested, label);
        return {propertyShapeId: ps?.id ?? label, direction: Object.values(e)[0]};
      });
    }
    if (subFields) {
      const nested = opts.shape
        ? FieldSet.resolveShape(opts.shape)
        : FieldSet.nestedShapeOf(path) ?? shape;
      entry.subSelect = FieldSet.fromFields(nested, subFields);
    }
    return entry;
  }

  /** The shape reached at the end of a relation path (its terminal segment's value shape). */
  private static nestedShapeOf(path: PropertyPath): NodeShapeData | undefined {
    const seg = path.segments[path.segments.length - 1] as PropertyShapeData | undefined;
    const valueShapeId = (seg as unknown as {valueShape?: {id: string}})?.valueShape?.id;
    return (valueShapeId && getQueryShapeClass(valueShapeId)?.shape) || undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves any of the accepted shape input types to a NodeShapeData and optional ShapeClass.
   * Accepts: ShapeConstructor (class with .shape), NodeShapeData, or IRI string.
   */
  private static resolveShapeInput(shape: ShapeConstructor<any> | NodeShapeData | string): {nodeShape: NodeShapeData; shapeClass?: ShapeConstructor<any>} {
    // Inside a catalog the catalog's data is the authority for every IRI it holds, so an
    // authored class (or metadata) for one of them resolves to the catalog's shape — as
    // `resolveShape` does for the builders.
    const catalog = getActiveShapeCatalog();
    if (catalog !== undefined && typeof shape !== 'string') {
      const id = typeof shape === 'function' ? shape.shape?.id : shape?.id;
      const own = id ? catalog.get(id) : undefined;
      if (own) {
        const shapeClass = getQueryShapeClass(id!);
        return shapeClass ? {nodeShape: own, shapeClass} : {nodeShape: own};
      }
    }
    if (typeof shape === 'string') {
      const shapeClass = getQueryShapeClass(shape);
      if (shapeClass?.shape) {
        return {nodeShape: shapeClass.shape, shapeClass};
      }
      // No authored class: the metadata alone is enough here — the classless branch
      // below is already supported, it just was not reachable from an IRI.
      const nodeShape = getNodeShape(shape);
      if (!nodeShape) {
        throw new Error(`Cannot resolve shape for '${shape}'`);
      }
      return {nodeShape};
    }
    // ShapeConstructor: has a static .shape property that is a NodeShapeData
    if ('shape' in shape && typeof shape.shape === 'object' && shape.shape !== null && 'id' in shape.shape) {
      return {nodeShape: (shape as ShapeConstructor<any>).shape, shapeClass: shape as ShapeConstructor<any>};
    }
    // NodeShapeData: has .id directly — try to look up its ShapeConstructor for full proxy support
    const nodeShape = shape as NodeShapeData;
    const shapeClass = nodeShape.id ? getQueryShapeClass(nodeShape.id) : undefined;
    return shapeClass
      ? {nodeShape, shapeClass}
      : {nodeShape};
  }

  /** @deprecated Use resolveShapeInput instead. Kept for fromJSON which only passes NodeShapeData|string. */
  private static resolveShape(shape: NodeShapeData | string): NodeShapeData {
    return FieldSet.resolveShapeInput(shape).nodeShape;
  }

  private static resolveInputs(
    shape: NodeShapeData,
    inputs: FieldSetInput[],
  ): FieldSetEntry[] {
    const entries: FieldSetEntry[] = [];
    for (const input of inputs) {
      if (typeof input === 'string') {
        entries.push({path: walkPropertyPath(shape, input)});
      } else if (input instanceof PropertyPath) {
        entries.push({path: input});
      } else if (input instanceof FieldSet) {
        entries.push(...(input.entries as FieldSetEntry[]));
      } else if (typeof input === 'object') {
        // Nested object form: { friends: ['name', 'hobby'] }
        for (const [key, value] of Object.entries(input)) {
          const basePath = walkPropertyPath(shape, key);
          if (value instanceof FieldSet) {
            // Merge nested FieldSet entries under this path
            for (const entry of value.entries as FieldSetEntry[]) {
              const combined = new PropertyPath(shape, [
                ...basePath.segments,
                ...entry.path.segments,
              ]);
              entries.push({path: combined, alias: entry.alias, scopedFilter: entry.scopedFilter});
            }
          } else if (Array.isArray(value)) {
            // Resolve nested string fields
            const basePropertyShape = basePath.terminal;
            if (!basePropertyShape?.valueShape) {
              throw new Error(
                `Property '${key}' has no valueShape; cannot resolve nested fields`,
              );
            }
            const nestedShapeClass = getQueryShapeClass(basePropertyShape.valueShape);
            if (!nestedShapeClass || !nestedShapeClass.shape) {
              throw new Error(
                `Cannot resolve valueShape for property '${key}'`,
              );
            }
            for (const nestedField of value) {
              const nestedPath = walkPropertyPath(nestedShapeClass.shape, nestedField);
              const combined = new PropertyPath(shape, [
                ...basePath.segments,
                ...nestedPath.segments,
              ]);
              entries.push({path: combined});
            }
          }
        }
      }
    }
    return entries;
  }

  /**
   * Trace fields using the full ProxiedPathBuilder proxy (createProxiedPathBuilder).
   * Handles nested paths, where conditions, aggregations, and sub-selects.
   */
  private static traceFieldsWithProxy(
    nodeShape: NodeShapeData,
    shapeClass: ShapeConstructor<any>,
    fn: (p: any) => any,
  ): FieldSetEntry[] {
    const proxy = createProxiedPathBuilder(shapeClass);
    const result = fn(proxy);

    // Normalize result: could be a single value, array, or custom object
    if (Array.isArray(result)) {
      return result.map((item) => FieldSet.convertTraceResult(nodeShape, item));
    }
    if (isQueryBuilderObject(result)) {
      return [FieldSet.convertTraceResult(nodeShape, result)];
    }
    // Single FieldSet sub-select (e.g. p.friends.select(f => [f.name]))
    if (result instanceof FieldSet && result.parentSegments !== undefined) {
      return [FieldSet.convertTraceResult(nodeShape, result)];
    }
    // Single SetSize (e.g. p.friends.size())
    if (isSetSize(result)) {
      return [FieldSet.convertTraceResult(nodeShape, result)];
    }
    // Single BoundComponent (e.g. p.bestFriend.preloadFor(comp))
    if (isBoundComponent(result)) {
      return [FieldSet.convertTraceResult(nodeShape, result)];
    }
    // Single ExpressionNode (e.g. p.age.times(12))
    if (isExpressionNode(result)) {
      return [FieldSet.convertTraceResult(nodeShape, result)];
    }
    if (typeof result === 'object' && result !== null) {
      // Custom object form: {name: p.name, hobby: p.hobby}
      const entries: FieldSetEntry[] = [];
      for (const [key, value] of Object.entries(result)) {
        const entry = FieldSet.convertTraceResult(nodeShape, value);
        entry.customKey = key;
        entries.push(entry);
      }
      return entries;
    }
    return [];
  }

  /**
   * Convert a single proxy trace result (QueryBuilderObject, SetSize, or FieldSet sub-select)
   * into a FieldSetEntry.
   */
  private static convertTraceResult(rootShape: NodeShapeData, obj: any): FieldSetEntry {
    // SetSize → aggregation: 'count'
    if (isSetSize(obj)) {
      const segments = FieldSet.collectPropertySegments(obj.subject);
      return {
        path: new PropertyPath(rootShape, segments),
        aggregation: 'count',
      };
    }

    // FieldSet sub-select — use its entries directly (created by forSubSelect)
    if (obj instanceof FieldSet && obj.parentSegments !== undefined) {
      const subSelect = obj.entries.length > 0 ? obj : undefined;
      const entry: FieldSetEntry = {
        path: new PropertyPath(rootShape, obj.parentSegments),
        subSelect: subSelect as FieldSet | undefined,
      };
      // Carry an inline `.where()` from the parent traversal chain
      // (e.g. `p.friends.where(...).select(...)`).
      if (obj.parentWherePath) {
        entry.scopedFilter = obj.parentWherePath;
        entry.scopedFilterIndex = obj.parentWherePathIndex;
      }
      // Carry inner LIMIT/OFFSET/ORDER BY from `.limit()`/`.offset()`/`.orderBy()`.
      if (typeof obj.innerLimit === 'number') entry.innerLimit = obj.innerLimit;
      if (typeof obj.innerOffset === 'number') entry.innerOffset = obj.innerOffset;
      if (obj.innerOrderBy) entry.innerOrderBy = obj.innerOrderBy;
      return entry;
    }

    // BoundComponent → preload composition (e.g. p.bestFriend.preloadFor(component))
    // Extract the component's FieldSet and store it as preloadSubSelect.
    if (isBoundComponent(obj)) {
      const segments = FieldSet.collectPropertySegments(obj.source);
      const componentFieldSet = FieldSet.extractComponentFieldSet(obj.originalValue);
      return {
        path: new PropertyPath(rootShape, segments),
        preloadSubSelect: componentFieldSet,
      };
    }

    // ExpressionNode → computed expression (e.g. p.age.times(12))
    if (isExpressionNode(obj)) {
      return {
        path: new PropertyPath(rootShape, []),
        expressionNode: obj,
      };
    }

    // QueryBuilderObject → walk the chain to collect PropertyPath segments
    if (isQueryBuilderObject(obj)) {
      const segments = FieldSet.collectPropertySegments(obj);
      const entry: FieldSetEntry = {
        path: new PropertyPath(rootShape, segments),
      };
      // Walk from leaf to root to find wherePath on any object in the chain.
      // Track which segment it belongs to so desugarEntry attaches the filter correctly.
      let current: QueryBuilderObjectLike | undefined = obj;
      let leafDistance = 0;
      while (current) {
        if (current.wherePath) {
          entry.scopedFilter = current.wherePath as WherePath;
          entry.scopedFilterIndex = segments.length - 1 - leafDistance;
          break;
        }
        current = current.subject;
        leafDistance++;
      }
      return entry;
    }

    // Fallback: string label
    if (typeof obj === 'string') {
      return {path: walkPropertyPath(rootShape, obj)};
    }

    throw new Error(`Unknown trace result type: ${obj}`);
  }

  /**
   * Walk a QueryBuilderObject-like chain (via .subject) collecting PropertyShapeData segments
   * from leaf to root, then reverse to get root-to-leaf order.
   */
  static collectPropertySegments(obj: QueryBuilderObjectLike): PropertyShapeData[] {
    const segments: PropertyShapeData[] = [];
    let current: QueryBuilderObjectLike | undefined = obj;
    while (current) {
      if (current.property) {
        segments.unshift(current.property);
      }
      current = current.subject;
    }
    return segments;
  }

  // ---------------------------------------------------------------------------
  // Cast-aware path (de)serialization — carries `.as(Shape)` narrowing inline as
  // an `as(<ShapeLabel>)` path segment (documentation/dsl-json.md, backlog 002 G5).
  // ---------------------------------------------------------------------------

  private static shapeById(id: string): NodeShapeData | undefined {
    return getShapeClass(id)?.shape ?? getNodeShape(id);
  }

  private static shapeByLabel(label: string): NodeShapeData | undefined {
    // Inside a catalog every shape is data (core's built-ins aside), so scan its shapes;
    // the global registry keeps scanning authored classes.
    const matches = (shape?: NodeShapeData): shape is NodeShapeData =>
      !!shape && (shape.label === label || FieldSet.labelOfId(shape.id) === label);
    if (getActiveShapeCatalog() !== undefined) {
      for (const shape of getAllNodeShapes().values()) if (matches(shape)) return shape;
      return undefined;
    }
    for (const cls of getAllShapeClasses().values()) {
      const shape = (cls as unknown as {shape?: NodeShapeData}).shape;
      if (matches(shape)) return shape;
    }
    return undefined;
  }

  private static labelOfId(id: string): string {
    const i = id.lastIndexOf('/');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  /**
   * Render a segment chain as a dotted label path, inserting `as(<ShapeLabel>)`
   * wherever a segment is not resolvable by label from the natural (walked) shape
   * — i.e. a `.as(Shape)` narrowing happened before it.
   */
  static pathToStringWithCasts(rootShape: NodeShapeData, segments: readonly PropertyShapeData[]): string {
    const parts: string[] = [];
    let current: NodeShapeData | undefined = rootShape;
    for (const seg of segments) {
      const label = FieldSet.labelOfId(seg.id);
      const natural = current ? getPropertyShape(current, label) : undefined;
      if (!natural || natural.id !== seg.id) {
        // A cast narrowed the context to the segment's owner shape.
        const ownerId = seg.id.slice(0, seg.id.lastIndexOf('/'));
        const owner = FieldSet.shapeById(ownerId);
        parts.push(`as(${owner?.label ?? FieldSet.labelOfId(ownerId)})`);
        current = owner ?? current;
      }
      parts.push(label);
      const vs = (seg as unknown as {valueShape?: {id: string}}).valueShape;
      current = vs ? FieldSet.shapeById(vs.id) ?? current : current;
    }
    return parts.join('.');
  }

  /** Inverse of {@link pathToStringWithCasts}: resolve a dotted path with `as(X)` casts. */
  static walkPathWithCasts(rootShape: NodeShapeData, path: string): PropertyPath {
    if (!path.includes('as(')) return walkPropertyPath(rootShape, path);
    const segments: PropertyShapeData[] = [];
    let current: NodeShapeData | undefined = rootShape;
    for (const token of path.split('.')) {
      const cast = /^as\((.+)\)$/.exec(token);
      if (cast) {
        current = FieldSet.shapeByLabel(cast[1]) ?? current;
        continue;
      }
      const ps = current ? getPropertyShape(current, token) : undefined;
      if (!ps) {
        throw new Error(
          `Property '${token}' not found on shape '${current?.label || current?.id}' while resolving path '${path}'`,
        );
      }
      segments.push(ps);
      const vs = (ps as unknown as {valueShape?: {id: string}}).valueShape;
      current = vs ? FieldSet.shapeById(vs.id) ?? current : current;
    }
    return new PropertyPath(rootShape, segments);
  }

  /**
   * Extract a FieldSet from a component-like object for preload composition.
   *
   * Supports multiple component interfaces:
   * - `.fields` as a FieldSet directly
   * - `.query` as a FieldSet, QueryBuilder (duck-typed via .fields()), or
   *   Record<string, QueryBuilder> (e.g. `{person: PersonQuery}`)
   */
  static extractComponentFieldSet(component: any): FieldSet | undefined {
    // Prefer .fields if it's a FieldSet
    if (component.fields instanceof FieldSet) {
      return component.fields;
    }
    const query = component.query;
    if (query instanceof FieldSet) {
      return query;
    }
    // QueryBuilder duck-type — has .fields() method
    if (query && typeof query.fields === 'function') {
      return query.fields();
    }
    // Record form: { propName: QueryBuilder }
    if (typeof query === 'object') {
      for (const key in query) {
        const value = (query as Record<string, any>)[key];
        if (value && typeof value.fields === 'function') {
          return value.fields();
        }
      }
    }
    return undefined;
  }

  /**
   * Internal factory that bypasses the private constructor for use by static methods.
   */
  private static createInternal(shape: NodeShapeData, entries: FieldSetEntry[]): FieldSet {
    return new FieldSet(shape, entries);
  }

  /**
   * Create a FieldSet from raw entries. Used by QueryBuilder to merge preload entries.
   */
  static createFromEntries(shape: NodeShapeData, entries: FieldSetEntry[]): FieldSet {
    return new FieldSet(shape, entries);
  }

  /**
   * Extract FieldSetEntry[] from a sub-query's traceResponse.
   * Public alias for use by lightweight sub-select wrappers.
   */
  static extractSubSelectEntriesPublic(rootShape: NodeShapeData, traceResponse: any): FieldSetEntry[] {
    return FieldSet.extractSubSelectEntries(rootShape, traceResponse);
  }

  /**
   * Extract FieldSetEntry[] from a sub-select's traceResponse.
   * The traceResponse is the result of calling the sub-query callback with a proxy,
   * containing QueryBuilderObjects, arrays, custom objects, etc.
   */
  private static extractSubSelectEntries(rootShape: NodeShapeData, traceResponse: any): FieldSetEntry[] {
    if (Array.isArray(traceResponse)) {
      return traceResponse
        .filter((item) => item !== null && item !== undefined)
        .map((item) => FieldSet.convertTraceResult(rootShape, item));
    }
    if (isQueryBuilderObject(traceResponse)) {
      return [FieldSet.convertTraceResult(rootShape, traceResponse)];
    }
    // Single FieldSet sub-select — convert directly
    if (traceResponse instanceof FieldSet && traceResponse.parentSegments !== undefined) {
      return [FieldSet.convertTraceResult(rootShape, traceResponse)];
    }
    // Single SetSize
    if (isSetSize(traceResponse)) {
      return [FieldSet.convertTraceResult(rootShape, traceResponse)];
    }
    // Single ExpressionNode
    if (isExpressionNode(traceResponse)) {
      return [FieldSet.convertTraceResult(rootShape, traceResponse)];
    }
    if (typeof traceResponse === 'object' && traceResponse !== null) {
      // Custom object form: {name: p.name, hobby: p.hobby}
      const entries: FieldSetEntry[] = [];
      for (const [key, value] of Object.entries(traceResponse)) {
        if (value !== null && value !== undefined) {
          const entry = FieldSet.convertTraceResult(rootShape, value);
          entry.customKey = key;
          entries.push(entry);
        }
      }
      return entries;
    }
    return [];
  }

}
