import type {
  IRCreateMutation,
  IRExpression,
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
function sparqlVarName(expression: IRExpression, projectionAlias: string): string {
  switch (expression.kind) {
    case 'property_expr':
      // SANITIZED, because `algebraToString` sanitizes when it WRITES the variable and this
      // reads the same variable back. A SPARQL variable may hold only letters, digits and `_`,
      // so a property named by a person — "Volume share", "Avg. basket" — is emitted as
      // `?a0_Volume_share` while this returned `a0_Volume share`, which matches no binding.
      // The lookup then yielded undefined, the value became null, and the CMS drew the column
      // with an empty cell and no error anywhere. Single-word names were unaffected, which is
      // what made it look like missing data rather than a naming mismatch.
      return sanitizeVarName(`${expression.sourceAlias}_${localName(expression.property)}`);
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

type NestedGroup = {
  key: string;
  traverseAlias: string;
  flatFields: FieldDescriptor[];
  nestedGroups: NestedGroup[];
  maxCount?: number;
};

type NestingDescriptor = {
  /** The root alias variable name (e.g. "a0") */
  rootVar: string;
  /** Flat fields: fields directly on the root entity */
  flatFields: FieldDescriptor[];
  /** Nested groups: fields that come from traversed entities (recursive) */
  nestedGroups: NestedGroup[];
};

/**
 * Builds the alias chain from sourceAlias back to rootAlias by walking the traverseMap.
 * Returns the chain from root outward, e.g. [{alias: "a1", property: "friends"}, {alias: "a2", property: "bestFriend"}].
 */
function buildAliasChain(
  sourceAlias: string,
  rootAlias: string,
  traverseMap: Map<string, {from: string; property: string; maxCount?: number}>,
): Array<{alias: string; property: string; maxCount?: number}> {
  const chain: Array<{alias: string; property: string; maxCount?: number}> = [];
  let current = sourceAlias;
  while (current !== rootAlias) {
    const info = traverseMap.get(current);
    if (!info) break;
    chain.unshift({alias: current, property: info.property, maxCount: info.maxCount});
    current = info.from;
  }
  return chain;
}

/**
 * Inserts a field into the nesting tree at the position described by the alias chain.
 * Creates intermediate NestedGroup nodes as needed.
 */
function insertIntoTree(
  root: {flatFields: FieldDescriptor[]; nestedGroups: NestedGroup[]},
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

  const target = chain[0];
  let group = root.nestedGroups.find((g) => g.traverseAlias === target.alias);
  if (!group) {
    group = {
      key: localName(target.property),
      traverseAlias: target.alias,
      flatFields: [],
      nestedGroups: [],
      maxCount: target.maxCount,
    };
    root.nestedGroups.push(group);
  }

  // Recurse: remaining chain determines where the field sits within this group
  insertIntoTree(group, chain.slice(1), field);
}

/**
 * Analyzes the query structure to build a recursive nesting descriptor that guides
 * how flat SPARQL bindings should be grouped into nested result objects.
 */
function buildNestingDescriptor(query: IRSelectQuery): NestingDescriptor {
  const rootAlias = query.root.alias;

  // Build a map from alias → traverse pattern (to identify which aliases are traversals)
  const traverseMap = new Map<string, {from: string; property: string; maxCount?: number}>();
  for (const pattern of query.patterns) {
    if (pattern.kind === 'traverse') {
      traverseMap.set(pattern.to, {from: pattern.from, property: pattern.property, maxCount: pattern.maxCount});
    }
  }

  const descriptor: NestingDescriptor = {
    rootVar: rootAlias,
    flatFields: [],
    nestedGroups: [],
  };

  const resultMap = query.resultMap ?? [];
  const projectionByAlias = new Map(
    query.projection.map((p) => [p.alias, p]),
  );

  for (const entry of resultMap) {
    const projItem = projectionByAlias.get(entry.alias);

    // When irToAlgebra renames an aggregate alias (e.g. a1 → a1_agg) to avoid
    // collision with a traversal alias, it updates resultMap but not projection.
    // In that case, use the resultMap alias directly as the SPARQL variable name
    // and treat the expression as an aggregate (single-value, root-level).
    if (!projItem) {
      const resultKey = localName(entry.key);
      const field: FieldDescriptor = {
        key: resultKey,
        sparqlVar: entry.alias,
        expression: {kind: 'aggregate_expr', name: 'count', args: []} as any,
        maxCount: 1,
      };
      descriptor.flatFields.push(field);
      continue;
    }

    const expression = projItem.expression;
    const sparqlVar = sparqlVarName(expression, entry.alias);
    const resultKey = localName(entry.key);

    // Determine which entity this field belongs to
    let sourceAlias: string;
    if (expression.kind === 'property_expr') {
      sourceAlias = expression.sourceAlias;
    } else if (expression.kind === 'alias_expr') {
      sourceAlias = expression.alias;
    } else if (expression.kind === 'aggregate_expr') {
      // An aggregate over a traversed entity's property (e.g. a sub-select
      // `f.friends.size()`) is grouped per that entity — anchor the field to
      // the argument's source alias, not the root.
      const propArg = expression.args.find((a) => a.kind === 'property_expr');
      sourceAlias = propArg && propArg.kind === 'property_expr' ? propArg.sourceAlias : rootAlias;
    } else {
      sourceAlias = rootAlias;
    }

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

    if (sourceAlias === rootAlias) {
      descriptor.flatFields.push(field);
    } else {
      // Build the full chain from root to sourceAlias and insert into tree
      const chain = buildAliasChain(sourceAlias, rootAlias, traverseMap);
      insertIntoTree(descriptor, chain, field);
    }
  }

  // Validate: no duplicate keys at the flat level
  const flatKeys = descriptor.flatFields.map((f) => f.key);
  const dupFlat = flatKeys.find((k, i) => flatKeys.indexOf(k) !== i);
  if (dupFlat) {
    throw new Error(
      `Duplicate result key "${dupFlat}" in projection. ` +
      `Two properties with the same local name cannot appear in the same projection.`,
    );
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

  const descriptor = buildNestingDescriptor(query);

  // If there are no nested groups, produce flat rows
  if (descriptor.nestedGroups.length === 0) {
    return mapFlatRows(bindings, descriptor, query);
  }

  // Otherwise, group and nest
  return mapNestedRows(bindings, descriptor, query);
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
 * Maps flat (non-nested) result rows — no traversals involved.
 * Groups bindings by root ID to collect multi-value flat fields into arrays.
 */
function mapFlatRows(
  bindings: SparqlBinding[],
  descriptor: NestingDescriptor,
  query: IRSelectQuery,
): SelectResult {
  // Group bindings by root entity id
  const rootGroups = new Map<string, SparqlBinding[]>();

  for (const binding of bindings) {
    const rootBinding = binding[descriptor.rootVar];
    if (!rootBinding) continue;
    const id = rootBinding.value;

    let group = rootGroups.get(id);
    if (!group) {
      group = [];
      rootGroups.set(id, group);
    }
    group.push(binding);
  }

  const rows: ResultRow[] = [];

  for (const [rootId, groupBindings] of rootGroups) {
    const row: ResultRow = {id: rootId};
    populateFlatFields(row, descriptor.flatFields, groupBindings);
    rows.push(row);
  }

  if (query.singleResult) {
    return rows.length > 0 ? rows[0] : null;
  }
  return rows;
}

/**
 * Populates fields on a ResultRow from a single SPARQL binding.
 * Used inside nested groups where each entity is populated once per binding.
 */
function populateFields(row: ResultRow, fields: FieldDescriptor[], binding: SparqlBinding): void {
  for (const field of fields) {
    row[field.key] = extractFieldValue(field, binding);
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
    const collected = collectNestedGroup(nestedGroup, bindings);
    if (typeof nestedGroup.maxCount === 'number' && nestedGroup.maxCount <= 1) {
      row[nestedGroup.key] = collected.length > 0 ? collected[0] : null;
    } else {
      row[nestedGroup.key] = collected;
    }
  }
}

/**
 * Recursively collects entities for a nested group from a set of bindings.
 * Groups bindings by the nested entity's ID, populates fields, and recurses
 * into any deeper nested groups.
 */
function collectNestedGroup(
  nestedGroup: NestedGroup,
  bindings: SparqlBinding[],
): ResultRow[] {
  const entityMap = new Map<string, {row: ResultRow; bindings: SparqlBinding[]}>();

  for (const binding of bindings) {
    const idBinding = binding[nestedGroup.traverseAlias];
    if (!idBinding) continue;
    const entityId = idBinding.value;

    let entry = entityMap.get(entityId);
    if (!entry) {
      const nestedRow: ResultRow = {id: entityId};
      populateFields(nestedRow, nestedGroup.flatFields, binding);
      entry = {row: nestedRow, bindings: []};
      entityMap.set(entityId, entry);
    }
    entry.bindings.push(binding);
  }

  // Recurse into deeper nested groups
  const allNestedBindings = Array.from(entityMap.values()).flatMap((e) => e.bindings);
  const deepLiteralAliases = detectLiteralTraversals(nestedGroup.nestedGroups, allNestedBindings);
  for (const [, entry] of entityMap) {
    for (const deeperGroup of nestedGroup.nestedGroups) {
      assignNestedGroupValue(entry.row, deeperGroup, entry.bindings, deepLiteralAliases);
    }
  }

  return Array.from(entityMap.values()).map((e) => e.row);
}

/**
 * Maps nested result rows — groups flat SPARQL bindings by root entity,
 * then recursively collects traversed entities into nested arrays.
 */
function mapNestedRows(
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
  const literalAliases = detectLiteralTraversals(descriptor.nestedGroups, bindings);

  const rows: ResultRow[] = [];

  for (const [rootId, groupBindings] of rootGroups) {
    const row: ResultRow = {id: rootId};

    // Flat fields — single-value from first binding, multi-value collected across all
    populateFlatFields(row, descriptor.flatFields, groupBindings);

    // Nested groups — recursively collect traversed entities (or literal values)
    for (const nestedGroup of descriptor.nestedGroups) {
      assignNestedGroupValue(row, nestedGroup, groupBindings, literalAliases);
    }

    rows.push(row);
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
      'here rather than left to `resolveCount`, because a caller may hold a store and ' +
      'pass a count query to `selectQuery` on it directly, which does not go through ' +
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
