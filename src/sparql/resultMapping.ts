import type {
  IRCreateMutation,
  IRExpression,
  IRGraphPattern,
  IRFieldValue,
  IRNodeData,
  IRCountQuery,
  IRSelectQuery,
  IRUpdateMutation,
  IRUpsertMutation,
  CreateResult,
  ResultFieldValue,
  ResultRow,
  SelectResult,
  UpdateResult,
} from '../queries/IntermediateRepresentation.js';

// ---------------------------------------------------------------------------
// SPARQL JSON Result Types
// ---------------------------------------------------------------------------

export type SparqlJsonResults = {
  head: {vars: string[]};
  results: {
    bindings: SparqlBinding[];
  };
};

/**
 * The `application/sparql-results+json` form of an **ASK** response:
 * `{"head": {}, "boolean": true}`. It carries no `results` key at all, which is
 * why this is a sibling type rather than an optional field on
 * {@link SparqlJsonResults} — that type would then describe a shape no endpoint
 * returns.
 */
export type SparqlAskResults = {
  head: {vars?: string[]; link?: string[]};
  boolean: boolean;
};

/** Either form a SPARQL query endpoint can return for the queries this layer emits. */
export type SparqlQueryResults = SparqlJsonResults | SparqlAskResults;

/** Narrowing guard for {@link SparqlQueryResults} — true for a SELECT result set. */
export function isSparqlSelectResults(
  json: SparqlQueryResults,
): json is SparqlJsonResults {
  return (json as SparqlJsonResults)?.results?.bindings !== undefined;
}

export type SparqlBinding = Record<
  string,
  {
    type: 'uri' | 'literal' | 'bnode' | 'typed-literal';
    value: string;
    datatype?: string;
    'xml:lang'?: string;
  }
>;

import {xsd} from '../ontologies/xsd.js';
import {sanitizeVarName} from './sparqlUtils.js';

// ---------------------------------------------------------------------------
// XSD constants (derived from ontology module)
// ---------------------------------------------------------------------------

const XSD_BOOLEAN = xsd.boolean.id;
const XSD_INTEGER = xsd.integer.id;
const XSD_LONG = xsd.long.id;
const XSD_DECIMAL = xsd.decimal.id;
const XSD_FLOAT = xsd.float.id;
const XSD_DOUBLE = xsd.double.id;
const XSD_DATE_TIME = xsd.dateTime.id;
const XSD_DATE = xsd.date.id;

const NUMERIC_DATATYPES = new Set([
  XSD_INTEGER,
  XSD_LONG,
  XSD_DECIMAL,
  XSD_FLOAT,
  XSD_DOUBLE,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the local name (last segment) from a full URI.
 * E.g. "https://linked.cm/shape/core/Person/name" → "name"
 */
function localName(uri: string): string {
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx >= 0) return uri.substring(hashIdx + 1);
  const slashIdx = uri.lastIndexOf('/');
  return slashIdx >= 0 ? uri.substring(slashIdx + 1) : uri;
}

const traverseKey = (alias: string, property: string): string => `${alias}::${property}`;

/**
 * Every traverse of the query, at any depth, as (from, property) → target alias: the bindings
 * `irToAlgebra`'s variable registry makes for them (a later traverse of the same pair wins, as
 * it does there).
 */
function collectTraverseVars(patterns: readonly IRGraphPattern[], out = new Map<string, string>()): Map<string, string> {
  for (const pattern of patterns) {
    switch (pattern.kind) {
      case 'traverse':
        out.set(traverseKey(pattern.from, pattern.property), pattern.to);
        break;
      case 'join':
        collectTraverseVars(pattern.patterns, out);
        break;
      case 'union':
        collectTraverseVars(pattern.branches, out);
        break;
      case 'optional':
      case 'exists':
        collectTraverseVars([pattern.pattern], out);
        break;
    }
  }
  return out;
}

/**
 * Derives the SPARQL variable name that will appear in the result bindings
 * for a given projection expression.
 *
 * Convention (aligned with irToAlgebra variable naming):
 * - `property_expr(sourceAlias, property)` → `{sourceAlias}_{localName(property)}`
 * - `alias_expr(alias)` → `{alias}`
 * - `aggregate_expr` → uses the projection alias directly
 * - Anything else → falls back to the projection alias
 */
function sparqlVarName(
  expression: IRExpression,
  projectionAlias: string,
  traverseVars: ReadonlyMap<string, string>,
): string {
  switch (expression.kind) {
    case 'property_expr': {
      // A relation the query also traverses (`[u.ofKey]` with `.where(u => u.ofKey.key…)`)
      // is read from the traversal's variable: `irToAlgebra` binds (alias, property) to the
      // traverse target and projects that variable, not `{alias}_{local name}`.
      const traversed = traverseVars.get(traverseKey(expression.sourceAlias, expression.property));
      if (traversed) return traversed;
      // SANITIZED, because `algebraToString` sanitizes when it WRITES the variable and this
      // reads the same variable back. A SPARQL variable may hold only letters, digits and `_`,
      // so a property named by a person — "Volume share", "Avg. basket" — is emitted as
      // `?a0_Volume_share` while this returned `a0_Volume share`, which matches no binding.
      // The lookup then yielded undefined, the value became null, and the CMS drew the column
      // with an empty cell and no error anywhere. Single-word names were unaffected, which is
      // what made it look like missing data rather than a naming mismatch.
      return sanitizeVarName(`${expression.sourceAlias}_${localName(expression.property)}`);
    }
    case 'alias_expr':
      return expression.alias;
    case 'aggregate_expr':
      return projectionAlias;
    default:
      return projectionAlias;
  }
}

/**
 * Coerces a raw SPARQL binding value into the appropriate JS type
 * based on the binding's type and datatype annotations.
 */
function coerceValue(
  binding: {type: string; value: string; datatype?: string},
): ResultFieldValue {
  // URI → return the URI string as an id
  if (binding.type === 'uri') {
    return binding.value;
  }

  // Typed literal → coerce based on datatype
  if (binding.datatype) {
    if (binding.datatype === XSD_BOOLEAN) {
      return binding.value === 'true' || binding.value === '1';
    }
    if (NUMERIC_DATATYPES.has(binding.datatype)) {
      return Number(binding.value);
    }
    if (binding.datatype === XSD_DATE_TIME || binding.datatype === XSD_DATE) {
      return new Date(binding.value);
    }
  }

  // Untyped literal or bnode → string
  return binding.value;
}

// ---------------------------------------------------------------------------
// Type: nesting descriptor for reconstructing nested objects from flat bindings
// ---------------------------------------------------------------------------

type FieldDescriptor = {
  key: string;
  sparqlVar: string;
  expression: IRExpression;
  /** Maximum cardinality from PropertyShapeData. Absent → multi-value (collected into array). */
  maxCount?: number;
};

/**
 * The fields of one kind of row: the root's, a traversed entity's (array form), or a keyed
 * sub-select's members'. Unkeyed fields sit flat or nested under their hops; keyed ones by key.
 */
type RowSpec = {
  flatFields: FieldDescriptor[];
  nestedGroups: NestedGroup[];
  keyed: KeyedField[];
};

type NestedGroup = RowSpec & {
  key: string;
  traverseAlias: string;
  maxCount?: number;
};

/**
 * An object-form key of a row: a value read through the hops below the row (`value`), or the
 * member rows of a keyed sub-select or preload (`members`). `plural`: some hop (or the property
 * itself) is multi-valued, so the field holds every distinct value / member.
 */
type KeyedField =
  | {kind: 'value'; key: string; field: FieldDescriptor; plural: boolean}
  | {kind: 'members'; key: string; alias: string; plural: boolean; row: RowSpec};

type NestingDescriptor = RowSpec & {
  /** The root alias variable name (e.g. "a0") */
  rootVar: string;
};

type TraverseInfo = {from: string; property: string; maxCount?: number};

/**
 * Builds the alias chain from sourceAlias back to `stopAlias` (the root, or the row a field is
 * read from) by walking the traverseMap.
 * Returns the chain outward, e.g. [{alias: "a1", property: "friends"}, {alias: "a2", property: "bestFriend"}].
 */
function buildAliasChain(
  sourceAlias: string,
  stopAlias: string,
  traverseMap: Map<string, TraverseInfo>,
): Array<{alias: string; property: string; maxCount?: number}> {
  const chain: Array<{alias: string; property: string; maxCount?: number}> = [];
  let current = sourceAlias;
  while (current !== stopAlias) {
    const info = traverseMap.get(current);
    if (!info) break;
    chain.unshift({alias: current, property: info.property, maxCount: info.maxCount});
    current = info.from;
  }
  return chain;
}

const multiValued = (maxCount: number | undefined): boolean => typeof maxCount !== 'number' || maxCount > 1;

/** The nested group for a traversal target under `row`, created when it is not there yet. */
function groupIn(row: RowSpec, hop: {alias: string; property: string; maxCount?: number}): NestedGroup {
  let group = row.nestedGroups.find((g) => g.traverseAlias === hop.alias);
  if (!group) {
    group = {
      key: localName(hop.property),
      traverseAlias: hop.alias,
      flatFields: [],
      nestedGroups: [],
      keyed: [],
      maxCount: hop.maxCount,
    };
    row.nestedGroups.push(group);
  }
  return group;
}

/**
 * Inserts a field into the nesting tree at the position described by the alias chain.
 * Creates intermediate NestedGroup nodes as needed.
 */
function insertIntoTree(
  root: RowSpec,
  chain: Array<{alias: string; property: string; maxCount?: number}>,
  field: FieldDescriptor,
): void {
  if (chain.length === 0) {
    // Skip alias_expr fields that match the group's traverseAlias — the entity's
    // id is already captured by collectNestedGroup via binding[traverseAlias].
    if (
      field.expression.kind === 'alias_expr' &&
      'traverseAlias' in root &&
      field.expression.alias === (root as NestedGroup).traverseAlias
    ) {
      return;
    }
    root.flatFields.push(field);
    return;
  }
  // Recurse: remaining chain determines where the field sits within this group
  insertIntoTree(groupIn(root, chain[0]), chain.slice(1), field);
}

/** The entity a field is read from: its source alias (an aggregate: its argument's). */
function sourceAliasOf(expression: IRExpression, rootAlias: string): string {
  if (expression.kind === 'property_expr') return expression.sourceAlias;
  if (expression.kind === 'alias_expr') return expression.alias;
  if (expression.kind === 'aggregate_expr') {
    // An aggregate over a traversed entity's property (e.g. a sub-select
    // `f.friends.size()`) is grouped per that entity — anchor the field to
    // the argument's source alias, not the root.
    const propArg = expression.args.find((a) => a.kind === 'property_expr');
    return propArg && propArg.kind === 'property_expr' ? propArg.sourceAlias : rootAlias;
  }
  return rootAlias;
}

/**
 * Analyzes the query structure to build a recursive nesting descriptor that guides
 * how flat SPARQL bindings should be grouped into nested result objects.
 *
 * An entry without a `container` (the array form) nests under each traversal from the root. An
 * entry with one is a field of that row: the root, a keyed sub-select's members (a `members`
 * entry, earlier in the result map), or an entity an unkeyed sub-select reaches from one of those
 * (found by walking its traversals up). A keyed entry collapses the hops below its row.
 */
function buildNestingDescriptor(query: IRSelectQuery): NestingDescriptor {
  const rootAlias = query.root.alias;

  // Build a map from alias → traverse pattern (to identify which aliases are traversals)
  const traverseMap = new Map<string, TraverseInfo>();
  for (const pattern of query.patterns) {
    if (pattern.kind === 'traverse') {
      traverseMap.set(pattern.to, {from: pattern.from, property: pattern.property, maxCount: pattern.maxCount});
    }
  }

  const traverseVars = collectTraverseVars(query.patterns);

  const descriptor: NestingDescriptor = {
    rootVar: rootAlias,
    flatFields: [],
    nestedGroups: [],
    keyed: [],
  };

  // The row of each container alias: the root, the members of a keyed sub-select, or an entity
  // nested (by its hops) under one of those.
  const rows = new Map<string, RowSpec>([[rootAlias, descriptor]]);
  const rowFor = (alias: string): RowSpec => {
    const known = rows.get(alias);
    if (known) return known;
    const info = traverseMap.get(alias);
    if (!info) {
      throw new Error(`Result mapping: no row for "${alias}", which no traversal of the query reaches.`);
    }
    const row = groupIn(rowFor(info.from), {alias, ...info});
    rows.set(alias, row);
    return row;
  };

  const resultMap = query.resultMap ?? [];
  const projectionByAlias = new Map(
    query.projection.map((p) => [p.alias, p]),
  );

  for (const entry of resultMap) {
    if (entry.members) {
      // A keyed sub-select or preload: its key holds the member rows its traversal reaches.
      const container = entry.container ?? rootAlias;
      const chain = buildAliasChain(entry.alias, container, traverseMap);
      const row: RowSpec = {flatFields: [], nestedGroups: [], keyed: []};
      rows.set(entry.alias, row);
      rowFor(container).keyed.push({
        kind: 'members',
        key: entry.key,
        alias: entry.alias,
        plural: chain.some((hop) => multiValued(hop.maxCount)),
        row,
      });
      continue;
    }

    const projItem = projectionByAlias.get(entry.alias);

    // When irToAlgebra renames an aggregate alias (e.g. a1 → a1_agg) to avoid
    // collision with a traversal alias, it updates resultMap but not projection.
    // In that case, use the resultMap alias directly as the SPARQL variable name
    // and treat the expression as an aggregate (single-value, in its row).
    if (!projItem) {
      const field: FieldDescriptor = {
        key: localName(entry.key),
        sparqlVar: entry.alias,
        expression: {kind: 'aggregate_expr', name: 'count', args: []} as any,
        maxCount: 1,
      };
      const row = rowFor(entry.container ?? rootAlias);
      if (entry.keyed) row.keyed.push({kind: 'value', key: field.key, field, plural: false});
      else row.flatFields.push(field);
      continue;
    }

    const expression = projItem.expression;
    const sparqlVar = sparqlVarName(expression, entry.alias, traverseVars);
    const resultKey = localName(entry.key);

    const field: FieldDescriptor = {key: resultKey, sparqlVar, expression};
    if (expression.kind === 'property_expr') {
      // property_expr carries maxCount from PropertyShapeData — absent means multi-value
      if (typeof expression.maxCount === 'number') {
        field.maxCount = expression.maxCount;
      }
    } else {
      // All other expressions (aggregate_expr, binary_expr, function_expr, etc.)
      // produce a single scalar value per entity/group — always single-value
      field.maxCount = 1;
    }

    // A computed value (an aggregate, an expression) with a row is computed per that row: a
    // field of the row itself, whatever paths it reads.
    const computed = expression.kind !== 'property_expr' && expression.kind !== 'alias_expr';

    if (entry.keyed) {
      const container = entry.container ?? rootAlias;
      const chain = computed ? [] : buildAliasChain(sourceAliasOf(expression, rootAlias), container, traverseMap);
      rowFor(container).keyed.push({
        kind: 'value',
        key: resultKey,
        field,
        plural:
          chain.some((hop) => multiValued(hop.maxCount)) ||
          (expression.kind === 'property_expr' && isMultiValueField(field)),
      });
      continue;
    }

    if (entry.container !== undefined) {
      const row = rowFor(entry.container);
      if (computed) row.flatFields.push(field);
      else insertIntoTree(row, buildAliasChain(sourceAliasOf(expression, rootAlias), entry.container, traverseMap), field);
      continue;
    }

    const sourceAlias = sourceAliasOf(expression, rootAlias);
    if (sourceAlias === rootAlias) {
      descriptor.flatFields.push(field);
    } else {
      // Build the full chain from root to sourceAlias and insert into tree
      insertIntoTree(descriptor, buildAliasChain(sourceAlias, rootAlias, traverseMap), field);
    }
  }

  // Defensive: lowering drops exact duplicate fields and refuses two different fields under one
  // key (`dedupeProjectionSeeds`), so a duplicate key here means an IR built some other way.
  for (const row of rows.values()) {
    const keys = [...row.flatFields.map((f) => f.key), ...row.keyed.map((k) => k.key)];
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) {
      throw new Error(
        `Duplicate result key "${dup}" in projection. ` +
        `Two fields with the same local name cannot appear at the same level of a row.`,
      );
    }
  }

  return descriptor;
}

// ---------------------------------------------------------------------------
// Main API: mapSparqlSelectResult
// ---------------------------------------------------------------------------

/**
 * Maps a SPARQL JSON result set back into the `SelectResult` shape expected
 * by the Linked DSL.
 *
 * 1. Walks `query.resultMap` to know which alias → result key mapping
 * 2. Walks `query.projection` to know each alias's expression type (for type coercion)
 * 3. For each binding row, extracts values by variable name, coerces types, handles missing → null
 * 4. Groups rows by root alias to reconstruct nested objects
 * 5. If `query.singleResult` → returns single row or null
 */
export function mapSparqlSelectResult(
  json: SparqlJsonResults,
  query: IRSelectQuery,
): SelectResult {
  const bindings = json.results.bindings;

  // A grouped select: one row per group, its keys and aggregates, no id.
  if (query.groupBy && query.groupBy.length > 0) {
    return mapGroupedRows(bindings, query);
  }

  // If no resultMap, just return entity references
  if (!query.resultMap || query.resultMap.length === 0) {
    const rootVar = query.root.alias;
    const rows: ResultRow[] = [];
    const seenIds = new Set<string>();
    for (const binding of bindings) {
      const rootBinding = binding[rootVar];
      if (!rootBinding) continue;
      const id = rootBinding.value;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      rows.push({id});
    }
    if (query.singleResult) {
      return rows.length > 0 ? rows[0] : null;
    }
    return rows;
  }

  return mapRows(bindings, buildNestingDescriptor(query), query);
}

/**
 * The rows of a grouped select: one per binding, each the select's fields by result key. A key
 * that is a node is `{id}`; an unbound key (the group of members without that value) is `null`.
 * Read through the result map, whose aliases `irToAlgebra` renames on collisions.
 */
function mapGroupedRows(bindings: SparqlBinding[], query: IRSelectQuery): ResultRow[] {
  const traverseVars = collectTraverseVars(query.patterns);
  const projectionByAlias = new Map(query.projection.map((p) => [p.alias, p]));
  const fields = (query.resultMap ?? []).map((entry) => {
    const item = projectionByAlias.get(entry.alias);
    // No projection item under the alias: an aggregate or expression renamed to avoid a
    // traversal variable, read under its new name.
    const sparqlVar = item ? sparqlVarName(item.expression, entry.alias, traverseVars) : entry.alias;
    return {key: localName(entry.key), sparqlVar};
  });
  return bindings.map((binding) => {
    const row: Record<string, ResultFieldValue> = {};
    for (const field of fields) {
      const val = binding[field.sparqlVar];
      row[field.key] = !val ? null : val.type === 'uri' ? ({id: val.value} as ResultRow) : coerceValue(val);
    }
    return row as ResultRow;
  });
}

/**
 * Checks whether a flat field is multi-value (no maxCount or maxCount > 1).
 */
function isMultiValueField(field: FieldDescriptor): boolean {
  return typeof field.maxCount !== 'number' || field.maxCount > 1;
}

/**
 * Extracts a single field value from a SPARQL binding.
 * URI bindings are wrapped as entity references ({id: ...}), regardless of
 * whether the expression is an alias_expr or property_expr — any URI-typed
 * SPARQL value represents an entity reference in the result.
 */
function extractFieldValue(
  field: FieldDescriptor,
  binding: SparqlBinding,
): ResultFieldValue {
  const val = binding[field.sparqlVar];
  if (!val) return null;
  if (val.type === 'uri') {
    return {id: val.value} as ResultRow;
  }
  return coerceValue(val);
}

/**
 * Collects multi-value flat fields from all bindings for a given root entity,
 * producing deduplicated arrays for multi-value fields and single values
 * for single-value fields.
 */
function populateFlatFields(
  row: ResultRow,
  fields: FieldDescriptor[],
  groupBindings: SparqlBinding[],
): void {
  const multiValueFields = fields.filter(isMultiValueField);
  const singleValueFields = fields.filter((f) => !isMultiValueField(f));

  // Single-value fields: take first binding
  for (const field of singleValueFields) {
    row[field.key] = extractFieldValue(field, groupBindings[0]);
  }

  // Multi-value fields (no maxCount): collect all distinct values across bindings.
  // URI bindings produce ResultRow[] (entity references like friends),
  // literal bindings produce string[]/number[]/etc (like nickNames).
  for (const field of multiValueFields) {
    const seenValues = new Set<string>();
    const values: ResultFieldValue[] = [];
    for (const binding of groupBindings) {
      const val = binding[field.sparqlVar];
      if (!val) continue;
      if (seenValues.has(val.value)) continue;
      seenValues.add(val.value);
      const extracted = extractFieldValue(field, binding);
      if (extracted !== null) {
        values.push(extracted);
      }
    }
    row[field.key] = values as ResultFieldValue;
  }
}

/**
 * Scans bindings to identify which nested groups represent literal property
 * traversals (e.g. `p.hobby.where(h => h.equals('Jogging'))`) vs entity
 * traversals. Returns a set of traverse aliases that resolve to literals.
 *
 * Scans ALL non-null bindings for each group to validate type consistency.
 * If mixed types are found (both URI and literal), defaults to literal
 * treatment — coerceValue handles both safely.
 */
function detectLiteralTraversals(
  groups: NestedGroup[],
  bindings: SparqlBinding[],
): Set<string> {
  const literalAliases = new Set<string>();
  for (const group of groups) {
    let seenUri = false;
    let seenLiteral = false;
    for (const binding of bindings) {
      const val = binding[group.traverseAlias];
      if (!val) continue;
      if (val.type === 'uri') seenUri = true;
      else seenLiteral = true;
    }
    // Literal-only or mixed types → treat as literal (safe fallback)
    if (seenLiteral) {
      literalAliases.add(group.traverseAlias);
    }
  }
  return literalAliases;
}

/**
 * Collects the coerced literal value from a nested group that traverses a
 * datatype property. Returns the first non-null value, or null if absent.
 */
function collectLiteralTraversalValue(
  nestedGroup: NestedGroup,
  bindings: SparqlBinding[],
): ResultFieldValue {
  for (const binding of bindings) {
    const val = binding[nestedGroup.traverseAlias];
    if (!val) continue;
    return coerceValue(val);
  }
  return null;
}

/**
 * Assigns the collected value of a nested group to a result row,
 * unwrapping single-value properties (maxCount <= 1) from arrays to
 * a single ResultRow or null.
 */
function assignNestedGroupValue(
  row: ResultRow,
  nestedGroup: NestedGroup,
  bindings: SparqlBinding[],
  literalAliases: Set<string>,
): void {
  if (literalAliases.has(nestedGroup.traverseAlias)) {
    row[nestedGroup.key] = collectLiteralTraversalValue(nestedGroup, bindings);
  } else {
    const collected = collectEntityRows(nestedGroup.traverseAlias, nestedGroup, bindings, literalAliases);
    if (typeof nestedGroup.maxCount === 'number' && nestedGroup.maxCount <= 1) {
      row[nestedGroup.key] = collected.length > 0 ? collected[0] : null;
    } else {
      row[nestedGroup.key] = collected;
    }
  }
}

/**
 * The rows of the entities bound to `alias` in `bindings`: grouped by the entity's id, each
 * built from its own bindings (a multi-valued field collects its values across them).
 */
function collectEntityRows(
  alias: string,
  spec: RowSpec,
  bindings: SparqlBinding[],
  literalAliases: Set<string>,
): ResultRow[] {
  const entityBindings = new Map<string, SparqlBinding[]>();
  for (const binding of bindings) {
    const idBinding = binding[alias];
    if (!idBinding) continue;
    let group = entityBindings.get(idBinding.value);
    if (!group) entityBindings.set(idBinding.value, (group = []));
    group.push(binding);
  }
  return Array.from(entityBindings, ([id, group]) => buildRow(spec, id, group, literalAliases));
}

/** One row: its id, its unkeyed fields (flat and nested under their hops), its keyed fields. */
function buildRow(
  spec: RowSpec,
  id: string,
  bindings: SparqlBinding[],
  literalAliases: Set<string>,
): ResultRow {
  const row: ResultRow = {id};
  // Flat fields — single-value from first binding, multi-value collected across all
  populateFlatFields(row, spec.flatFields, bindings);
  // Nested groups — recursively collect traversed entities (or literal values)
  for (const nestedGroup of spec.nestedGroups) {
    assignNestedGroupValue(row, nestedGroup, bindings, literalAliases);
  }
  for (const keyed of spec.keyed) {
    row[keyed.key] = keyed.kind === 'value'
      ? keyedValue(keyed.field, keyed.plural, bindings)
      : keyedMembers(keyed, bindings, literalAliases);
  }
  return row;
}

/**
 * A keyed value of a row, read across the row's bindings: through a multi-valued hop every
 * distinct value (`[]` when none), otherwise the value or `null`.
 */
function keyedValue(field: FieldDescriptor, plural: boolean, bindings: SparqlBinding[]): ResultFieldValue {
  if (!plural) {
    for (const binding of bindings) {
      const value = extractFieldValue(field, binding);
      if (value !== null) return value;
    }
    return null;
  }
  const seen = new Set<string>();
  const values: ResultFieldValue[] = [];
  for (const binding of bindings) {
    const val = binding[field.sparqlVar];
    if (!val) continue;
    const identity = `${val.type}|${val.datatype ?? ''}|${val['xml:lang'] ?? ''}|${val.value}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    values.push(extractFieldValue(field, binding));
  }
  return values as ResultFieldValue;
}

/** The member rows a keyed sub-select or preload holds: every member, or the one (or `null`). */
function keyedMembers(
  keyed: Extract<KeyedField, {kind: 'members'}>,
  bindings: SparqlBinding[],
  literalAliases: Set<string>,
): ResultFieldValue {
  const rows = collectEntityRows(keyed.alias, keyed.row, bindings, literalAliases);
  if (keyed.plural) return rows;
  return rows.length > 0 ? rows[0] : null;
}

/** Every nested group of the row tree, at any depth (through keyed members too). */
function allNestedGroups(spec: RowSpec, out: NestedGroup[] = []): NestedGroup[] {
  for (const group of spec.nestedGroups) {
    out.push(group);
    allNestedGroups(group, out);
  }
  for (const keyed of spec.keyed) {
    if (keyed.kind === 'members') allNestedGroups(keyed.row, out);
  }
  return out;
}

/**
 * Maps result rows — groups flat SPARQL bindings by root entity, then builds each row from its
 * bindings: flat fields, nested traversed entities, keyed fields.
 */
function mapRows(
  bindings: SparqlBinding[],
  descriptor: NestingDescriptor,
  query: IRSelectQuery,
): SelectResult {
  // Group bindings by root entity id
  const rootGroups = new Map<string, SparqlBinding[]>();

  for (const binding of bindings) {
    const rootBindingVal = binding[descriptor.rootVar];
    if (!rootBindingVal) continue;
    const rootId = rootBindingVal.value;

    let group = rootGroups.get(rootId);
    if (!group) {
      group = [];
      rootGroups.set(rootId, group);
    }
    group.push(binding);
  }

  // Pre-scan ALL bindings to determine which nested groups are literal traversals.
  // This must span all root groups because a specific root entity may have no
  // binding for the alias (OPTIONAL miss) — we need at least one bound value
  // to know the type.
  const literalAliases = detectLiteralTraversals(allNestedGroups(descriptor), bindings);

  const rows: ResultRow[] = [];
  for (const [rootId, groupBindings] of rootGroups) {
    rows.push(buildRow(descriptor, rootId, groupBindings, literalAliases));
  }

  if (query.singleResult) {
    return rows.length > 0 ? rows[0] : null;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// mapSparqlCreateResult
// ---------------------------------------------------------------------------

/**
 * Constructs a `CreateResult` from a generated URI and the IR create mutation.
 * Echoes back the created fields as a `ResultRow` with the generated URI as `id`.
 */
export function mapSparqlCreateResult(
  generatedUri: string,
  query: IRCreateMutation,
): CreateResult {
  const row: ResultRow = {id: generatedUri};
  populateRowFromNodeData(row, query.data);
  return row;
}

/**
 * Recursively populates a ResultRow from IRNodeData.
 */
function populateRowFromNodeData(row: ResultRow, data: IRNodeData): void {
  for (const field of data.fields) {
    const key = localName(field.property);
    row[key] = fieldValueToResult(field.value);
  }
}

/**
 * Converts an IRFieldValue to the corresponding ResultFieldValue.
 */
function fieldValueToResult(value: IRFieldValue): ResultFieldValue {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value;

  // NodeReferenceValue — has an id field
  if (typeof value === 'object' && 'id' in value && !('shape' in value) && !('fields' in value)) {
    return {id: (value as {id: string}).id} as ResultRow;
  }

  // IRNodeData — nested created entity
  if (typeof value === 'object' && 'shape' in value && 'fields' in value) {
    const nested = value as IRNodeData;
    const nestedRow: ResultRow = {id: nested.id || ''};
    populateRowFromNodeData(nestedRow, nested);
    return nestedRow;
  }

  // Array
  if (Array.isArray(value)) {
    return value.map((item) => {
      const result = fieldValueToResult(item);
      if (result && typeof result === 'object' && 'id' in result) {
        return result as ResultRow;
      }
      return result as ResultRow;
    }) as ResultRow[];
  }

  return null;
}

// ---------------------------------------------------------------------------
// mapSparqlUpdateResult
// ---------------------------------------------------------------------------

/**
 * Maps a SPARQL `ASK` response to the boolean it carries.
 *
 * Throws on a SELECT result set rather than coercing one. A result set is not a
 * failed `ASK` — it means the wrong query form reached the endpoint, and the
 * existence check that called this exists precisely so that "could not ask" is
 * never quietly reported as `false`.
 */
export function mapSparqlAskResult(json: SparqlQueryResults): boolean {
  const value = (json as SparqlAskResults)?.boolean;
  if (typeof value !== 'boolean') {
    throw new Error(
      'Expected a SPARQL ASK response with a `boolean` field, got ' +
      (isSparqlSelectResults(json)
        ? 'a SELECT result set'
        : `${JSON.stringify(json)?.slice(0, 200)}`) +
      '. The endpoint did not answer the ASK query that was sent.',
    );
  }
  return value;
}

/**
 * Reads the number out of a root-count result set.
 *
 * Strict on purpose, and in exactly the way {@link mapSparqlAskResult} is strict: a
 * missing binding, an empty result set or a non-numeric value **throws**. It never
 * defaults to `0`, because `0` is a perfectly plausible count — it renders an empty
 * table and is indistinguishable from real data, so a broken count that returned it
 * would hide instead of failing.
 *
 * A well-formed `COUNT` over an empty match set does bind `?count` to `0`, and that
 * is returned as the real answer it is.
 */
export function mapSparqlCountResult(
  json: SparqlQueryResults,
  query: IRCountQuery,
): number {
  if (!isSparqlSelectResults(json)) {
    throw new Error(
      'Expected a SPARQL SELECT result set for a count query, got ' +
      `${JSON.stringify(json)?.slice(0, 200)}. The endpoint did not answer the ` +
      'SELECT (COUNT(…)) query that was sent.',
    );
  }
  const variable = sanitizeVarName(query.alias);
  const binding = json.results.bindings[0]?.[variable];
  if (!binding) {
    throw new Error(
      `A count result set has no binding for ?${variable}. A root COUNT is an ` +
      'aggregate over the whole match set, so it always yields exactly one row — an ' +
      'empty result set means the query that ran was not the count that was built.',
    );
  }
  // `Number('')` and `Number('  ')` are both 0, and `Number.isFinite(0)` is true —
  // so a blank lexical form must be rejected BEFORE the numeric check, or the one
  // value this function exists not to invent is exactly the one it would return.
  const lexical = binding.value?.trim();
  const value = lexical ? Number(lexical) : NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `A count result bound ?${variable} to ${JSON.stringify(binding.value)}, which ` +
      'is not a non-negative integer. It is not coerced — a count that silently reads ' +
      'as 0 hides a broken query behind an empty table. (These checks are repeated ' +
      'here rather than left to `resolveRead`, because a caller may hold a store and ' +
      'pass a count query to `readQuery` on it directly, which does not go through ' +
      'that helper.)',
    );
  }
  return value;
}

/**
 * Constructs an `UpdateResult` from the IR update mutation.
 * Echoes back the updated fields as an `UpdateResult` with the target node's `id`.
 */
export function mapSparqlUpdateResult(
  // Upsert returns exactly what update returns — the caller deliberately does not learn
  // whether the node was created or replaced (that would cost the extra read the single
  // round-trip exists to avoid). Only `id` and `data.fields` are read, which both carry.
  query: IRUpdateMutation | IRUpsertMutation,
): UpdateResult {
  const result: UpdateResult = {id: query.id};

  for (const field of query.data.fields) {
    const key = localName(field.property);
    result[key] = fieldValueToResult(field.value);
  }

  return result;
}
