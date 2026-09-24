import {getShapeRegistryInstanceCount} from '../utils/ShapeClass.js';
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * SHACL-aligned validation of plain data objects against a node shape.
 *
 * One entry point — {@link validate} — used by the create and update pipelines
 * (via `MutationQueryFactory.describe()`) and directly by callers that want to
 * know how well an object fits a shape without building a mutation.
 *
 * **Shape of the output.** This library has no triple/Turtle layer and this
 * module does not add one: a {@link ValidationReport} is plain JavaScript. It is
 * however 1-1 with the SHACL vocabulary — one key per SHACL property, named
 * after it, holding a value the mutation pipeline accepts (a literal, or a
 * `{id}` node reference for IRI-valued properties). So a report can be
 * materialized by an ordinary create query as soon as shape classes for
 * `sh:ValidationReport` / `sh:ValidationResult` exist, with no transform step:
 *
 * ```ts
 * const report = validate(Slide, data);
 * await ValidationReport.create(report);   // once those shape classes exist
 * ```
 *
 * Two deliberate departures, both documented on the types: `results` is plural
 * where SHACL's repeated property is `sh:result`, and `propertyPath` is a
 * non-SHACL locator. Both map cleanly — a shape class chooses its own labels for
 * SHACL paths, and an extension property is legal on a SHACL report.
 *
 * **Coverage.** Cardinality (`sh:minCount` / `sh:maxCount`), node kind (literal
 * vs relation), undeclared properties (as `sh:closed`), `sh:datatype`, the four
 * `sh:min/maxInclusive/Exclusive` bounds, `sh:min/maxLength`, `sh:pattern` and
 * `sh:in`. Each is one entry in {@link CARDINALITY_CONSTRAINTS} or
 * {@link VALUE_CONSTRAINTS}, so adding another is one function and one test.
 *
 * Not covered: `sh:languageIn` / `sh:uniqueLang` (skipped at serialization time
 * too, so there is no metadata to check against) and `sh:hasValue`.
 */
import {shacl} from '../ontologies/shacl.js';
import {xsd} from '../ontologies/xsd.js';
import {isNodeReferenceValue, type NodeReferenceValue} from '../utils/NodeReference.js';
import {getUniquePropertyShapes} from './nodeShapeData.js';
import type {NodeShapeData, PropertyShapeData} from './nodeShapeData.js';
import {getNodeShape, getShapeClass} from '../utils/ShapeClass.js';
import {isExpressionNode} from '../expressions/ExpressionNode.js';
import {asContextRef} from '../queries/QueryContext.js';

/**
 * Which constraints apply to the data being validated.
 *
 * - `complete` — the object describes a whole node (a create, or a standalone
 *   object being checked for fit). Properties absent from the data are genuinely
 *   absent, so `sh:minCount` presence is checkable.
 * - `partial` — the object describes a change to an existing node (an update).
 *   The store holds whatever the payload does not mention, so presence is
 *   unknowable; only the values actually provided are checked.
 */
export type ValidationMode = 'complete' | 'partial';

/**
 * A single constraint violation — an `sh:ValidationResult`.
 *
 * Every key is the local name of the SHACL property it carries, and every value
 * is in a form the create pipeline accepts (a literal, or a `{id}` node
 * reference for IRI-valued properties). A shape class declaring these
 * properties therefore materializes a result with no transform step:
 * `ValidationResult.create(result)`. The one non-SHACL key is `propertyPath`;
 * see {@link ValidationReport}.
 */
export interface ValidationResult {
  /** `sh:focusNode` — the node the violation is about, when its id is known. */
  focusNode?: NodeReferenceValue;
  /** `sh:resultPath` — the IRI of the property the violation is about. */
  resultPath?: NodeReferenceValue;
  /**
   * `sh:value` — the offending value, present only when it is an RDF term (a
   * literal or a node reference). Cardinality violations are about the property
   * rather than any one value, so they carry none.
   */
  value?: LiteralTerm | NodeReferenceValue;
  /** `sh:sourceShape` — the node or property shape carrying the constraint. */
  sourceShape?: NodeReferenceValue;
  /** `sh:sourceConstraintComponent` — which SHACL constraint failed. */
  sourceConstraintComponent: NodeReferenceValue;
  /** `sh:resultSeverity` — `sh:Violation`, `sh:Warning` or `sh:Info`. */
  resultSeverity: NodeReferenceValue;
  /** `sh:resultMessage` — human-readable explanation. */
  resultMessage: string;
  /**
   * **Not SHACL.** The property's label, dot-joined through nested shapes
   * (`author.fullName`) — the locator a caller needs to point at a field in the
   * object they passed in, which `sh:resultPath` alone cannot give (it names the
   * property, not where the nesting reached it). Materializes like any other
   * property once a shape class declares it; drop it for a pure-SHACL result.
   */
  propertyPath?: string;
}

/**
 * The outcome of a validation run — an `sh:ValidationReport`.
 *
 * Plain objects, 1-1 with the SHACL vocabulary, so a report can later be
 * materialized through an ordinary create query against shape classes for
 * `sh:ValidationReport` / `sh:ValidationResult` — whether or not this library
 * ever ships those classes. `results` is the sole plural rename (SHACL's
 * property is `sh:result`, repeated); a shape class maps it with
 * `@objectProperty({path: shacl.result, …}) get results()`.
 */
export interface ValidationReport {
  /** `sh:conforms` — true when there are no `sh:Violation`-severity results. */
  conforms: boolean;
  /** `sh:result` — every violation found, in deterministic order. */
  results: ValidationResult[];
}

/** The literal types the mutation pipeline accepts as a value. */
type LiteralTerm = string | number | boolean | Date;

export interface ValidateOptions {
  /** Defaults to `complete`. */
  mode?: ValidationMode;
  /** How deep to descend into nested node descriptions. Defaults to 10. */
  maxDepth?: number;
}

/** Thrown by {@link assertValid} — carries the full report, not just the first violation. */
export class ShapeValidationError extends Error {
  readonly report: ValidationReport;
  constructor(report: ValidationReport) {
    super(report.results.map((r) => r.resultMessage).join('\n'));
    this.name = 'ShapeValidationError';
    this.report = report;
  }
}

/**
 * Keys that carry metadata about the node rather than a property value: `id` /
 * `__id` name it, and `shape` names the shape of a nested value when the
 * property shape itself doesn't declare one (see `convertUpdateValue`).
 */
const RESERVED_KEYS = new Set(['id', '__id', 'shape']);

/**
 * The message for an undeclared property key. Shared with the normalization path
 * in `MutationQuery`, which needs the same guard to build a field at all.
 */
export function undeclaredPropertyMessage(key: string, shape: NodeShapeData): string {
  const shapeName = shape.label || shape.id?.split('/').pop();
  const base =
    `Invalid property key: ${key}. The shape ${shapeName} does not have a registered ` +
    `property with this name. Make sure the get/set method exists, and that it uses a ` +
    `@objectProperty or @literalProperty decorator.`;

  // If more than one copy of the shape registry module has evaluated, this message is
  // very probably lying: the property IS declared, on a copy this code cannot see.
  // Saying so here is the whole point — the previous version of this error accused
  // correct application code, and finding the real cause took a day of eliminating
  // innocent suspects. See docs/reports/043-module-identity-in-the-backend.md.
  const copies = getShapeRegistryInstanceCount();
  if (copies > 1) {
    return (
      `${base}\n\n` +
      `NOTE: ${copies} copies of the shape registry have loaded in this process. If this ` +
      `property is declared, it almost certainly registered on a different copy than the ` +
      `one validating here, and the declaration is not the problem. This happens when part ` +
      `of the app resolves a framework package to its source and part to its built output.`
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// Constraint components
// ---------------------------------------------------------------------------

/** What a constraint check needs to know about the property it is checking. */
interface PropertyContext {
  shape: NodeShapeData;
  propertyShape: PropertyShapeData;
  /** Dot-joined label path from the root of the validated object. */
  property: string;
  focusNode?: string;
  mode: ValidationMode;
}

/**
 * A constraint check. Receives the property's values already normalized to an
 * array (a single value becomes a one-element array) and returns any violations.
 */
type ConstraintCheck = (values: unknown[], ctx: PropertyContext) => ValidationResult[];

/**
 * `sh:value` must be an RDF term. A literal or a node reference is one; a plain
 * object, array or function is not, so it is left off rather than emitted as
 * something no store could materialize — the message still names it.
 */
function asTerm(value: unknown): LiteralTerm | NodeReferenceValue | undefined {
  if (isScalarValue(value)) return value as LiteralTerm;
  if (isNodeReference(value)) return {id: (value as NodeReferenceValue).id};
  return undefined;
}

/**
 * A violation about the node itself rather than one of its property shapes —
 * `sh:sourceShape` is the node shape, and there is no `sh:resultPath` (an
 * undeclared key has no property IRI to point at).
 */
function nodeViolation(
  shape: NodeShapeData,
  ctx: {focusNode?: string},
  component: NodeReferenceValue,
  message: string,
  propertyPath?: string,
  value?: unknown,
): ValidationResult {
  const result: ValidationResult = {
    sourceConstraintComponent: component,
    resultSeverity: shacl.Violation,
    resultMessage: message,
  };
  if (ctx.focusNode) result.focusNode = {id: ctx.focusNode};
  if (propertyPath) result.propertyPath = propertyPath;
  const term = asTerm(value);
  if (term !== undefined) result.value = term;
  if (shape.id) result.sourceShape = {id: shape.id};
  return result;
}

/**
 * Build a result, omitting absent keys entirely — an `undefined` value is not a
 * property the create pipeline should see.
 */
function violation(
  ctx: PropertyContext,
  component: NodeReferenceValue,
  message: string,
  value?: unknown,
): ValidationResult {
  const result: ValidationResult = {
    sourceConstraintComponent: component,
    resultSeverity: shacl.Violation,
    resultMessage: message,
  };
  if (ctx.focusNode) result.focusNode = {id: ctx.focusNode};
  const path = ctx.propertyShape.path as NodeReferenceValue | undefined;
  if (path?.id) result.resultPath = {id: path.id};
  if (ctx.property) result.propertyPath = ctx.property;
  const term = asTerm(value);
  if (term !== undefined) result.value = term;
  const sourceShape = ctx.propertyShape.id || ctx.shape.id;
  if (sourceShape) result.sourceShape = {id: sourceShape};
  return result;
}

/** The label used in messages — the property's own label, not its nested path. */
function labelOf(ps: PropertyShapeData): string {
  return ps.label || ps.id;
}

/** `sh:maxCount` — no more values than the shape allows. */
const maxCountCheck: ConstraintCheck = (values, ctx) => {
  const {maxCount} = ctx.propertyShape;
  if (typeof maxCount !== 'number' || values.length <= maxCount) return [];
  return [
    violation(
      ctx,
      shacl.MaxCountConstraintComponent,
      `Property '${labelOf(ctx.propertyShape)}' allows at most ${maxCount} value(s), but ${values.length} were provided.`,
    ),
  ];
};

/** `sh:minCount` — at least as many values as the shape requires. */
const minCountCheck: ConstraintCheck = (values, ctx) => {
  const {minCount} = ctx.propertyShape;
  if (typeof minCount !== 'number' || minCount <= 0 || values.length >= minCount) return [];
  return [
    violation(
      ctx,
      shacl.MinCountConstraintComponent,
      `Property '${labelOf(ctx.propertyShape)}' requires at least ${minCount} value(s), but ${values.length} were provided.`,
    ),
  ];
};

/** True when the property clearly accepts only literal values. */
function expectsLiteral(ps: PropertyShapeData): boolean {
  if (ps.nodeKind) return ps.nodeKind.id === shacl.Literal.id;
  return !!ps.datatype && !ps.valueShape;
}

/** True when the property clearly accepts only nodes (IRIs/blank nodes). */
function expectsNode(ps: PropertyShapeData): boolean {
  if (ps.nodeKind) {
    return (
      ps.nodeKind.id === shacl.IRI.id ||
      ps.nodeKind.id === shacl.BlankNode.id ||
      ps.nodeKind.id === shacl.BlankNodeOrIRI.id
    );
  }
  return !!ps.valueShape;
}

function isScalarValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

/**
 * `sh:nodeKind` — literal properties reject nodes/objects, relation properties
 * reject bare scalars. Ambiguous kinds (`sh:IRIOrLiteral`, or no `nodeKind` and
 * no `datatype`/`valueShape` to infer from) are not enforced.
 */
const nodeKindCheck: ConstraintCheck = (values, ctx) => {
  const ps = ctx.propertyShape;
  const literalExpected = expectsLiteral(ps);
  const nodeExpected = expectsNode(ps);
  if (!literalExpected && !nodeExpected) return [];

  const results: ValidationResult[] = [];
  for (const el of values) {
    if (!isCheckableElement(el)) continue;
    const scalar = isScalarValue(el);
    if (literalExpected && !scalar) {
      results.push(
        violation(
          ctx,
          shacl.NodeKindConstraintComponent,
          `Property '${labelOf(ps)}' is a literal property but was given a ${typeof el === 'object' ? 'node/object' : typeof el} value.`,
          el,
        ),
      );
    } else if (nodeExpected && scalar) {
      results.push(
        violation(
          ctx,
          shacl.NodeKindConstraintComponent,
          `Property '${labelOf(ps)}' is a relation (object) property but was given a literal (${typeof el}). Provide a {id} reference or a nested object.`,
          el,
        ),
      );
    }
  }
  return results;
};

/**
 * An element worth checking: a concrete value rather than something whose final
 * form is decided elsewhere (an expression, a context ref, an absent value).
 */
function isCheckableElement(el: unknown): boolean {
  return el !== null && el !== undefined && !isExpressionNode(el) && !asContextRef(el);
}

const XSD_BASE = xsd.string.id.slice(0, -'string'.length);

/** `xsd:integer` rather than the full IRI, when the datatype is an XSD one. */
function datatypeLabel(datatype: NodeReferenceValue): string {
  return datatype.id.startsWith(XSD_BASE)
    ? `xsd:${datatype.id.slice(XSD_BASE.length)}`
    : datatype.id;
}

/** How a value reads in a message — its JS kind, which is what went wrong. */
function describeValue(value: unknown): string {
  if (value instanceof Date) return 'a Date';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'a whole number' : 'a decimal number';
  if (typeof value === 'object') return 'a node/object';
  return `a ${typeof value}`;
}

const isFiniteNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * What each XSD datatype accepts as a JavaScript value.
 *
 * This matters more than a normal type check: mutation literals are typed from
 * the *JavaScript* type when they reach SPARQL (`irToAlgebra`), not from the
 * declared datatype — a number becomes `xsd:integer`/`xsd:double`, a boolean
 * `xsd:boolean`, a `Date` `xsd:dateTime`, and a string an untyped literal. So a
 * string handed to an `xsd:integer` property does not merely skip a check, it
 * writes the wrong RDF term. Rejecting it is a correctness fix.
 *
 * `xsd:date` and `xsd:dateTime` take a `Date` and nothing else — one representation for a point
 * in time, rather than a JS object and a hand-written lexical string that behave differently.
 * The serializer derives the right lexical form from the declared datatype
 * (`irToAlgebra.dateToTerm`), so an `xsd:date` property gets `"2020-06-15"^^xsd:date` from the
 * same `Date` an `xsd:dateTime` property gets a full timestamp from.
 *
 * `xsd:time` is the exception, and takes a STRING. A `Date` cannot express a time of day without
 * inventing a date to carry it: the date half is meaningless, has to be discarded on
 * serialization, and makes two identical clock times on different days compare unequal. JS has
 * no time-only type — `Temporal.PlainTime` is the right answer and is not available yet — so the
 * lexical form is the honest representation. It is pattern-checked here, and `irToAlgebra` types
 * it from the declared datatype so it is written `"10:30:00"^^xsd:time` rather than as a plain
 * literal.
 *
 * Datatypes with no obvious JS counterpart (`xsd:duration`, `xsd:gYear`,
 * `xsd:Bytes`) are not checked.
 */
/**
 * `HH:MM:SS` with optional milliseconds and optional timezone.
 *
 * Ranges are enforced by the pattern rather than parsed: hours 00-23, minutes and seconds 00-59,
 * so "25:00:00" is rejected where a looser `\d{2}` would let it through and write a malformed
 * literal. The optional `Z`/offset is included because it is valid `xsd:time` — rejecting
 * "14:30:00Z" would make this stricter than the datatype it validates.
 */
const XSD_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/;

const DATATYPE_RULES: Record<string, {accepts: (v: unknown) => boolean; expected: string}> = {
  [xsd.string.id]: {accepts: (v) => typeof v === 'string', expected: 'a string'},
  [xsd.boolean.id]: {accepts: (v) => typeof v === 'boolean', expected: 'a boolean'},
  [xsd.integer.id]: {accepts: (v) => isFiniteNumber(v) && Number.isInteger(v), expected: 'a whole number'},
  [xsd.long.id]: {accepts: (v) => isFiniteNumber(v) && Number.isInteger(v), expected: 'a whole number'},
  [xsd.decimal.id]: {accepts: isFiniteNumber, expected: 'a number'},
  [xsd.float.id]: {accepts: isFiniteNumber, expected: 'a number'},
  [xsd.double.id]: {accepts: isFiniteNumber, expected: 'a number'},
  [xsd.date.id]: {accepts: (v) => v instanceof Date, expected: 'a Date'},
  [xsd.dateTime.id]: {accepts: (v) => v instanceof Date, expected: 'a Date'},
  [xsd.time.id]: {
    accepts: (v) => typeof v === 'string' && XSD_TIME_PATTERN.test(v),
    expected: 'a time string like "14:30:00", "14:30:00.250" or "14:30:00Z"',
  },
};

/** `sh:datatype` — the value's JavaScript type must match the declared datatype. */
const datatypeCheck: ConstraintCheck = (values, ctx) => {
  const ps = ctx.propertyShape;
  if (!ps.datatype) return [];
  const rule = DATATYPE_RULES[ps.datatype.id];
  if (!rule) return [];

  const results: ValidationResult[] = [];
  for (const el of values) {
    // A node reference is a node-kind problem, not a datatype one — one
    // violation per mistake, reported by the check that owns it.
    if (!isCheckableElement(el) || isNodeReference(el) || rule.accepts(el)) continue;
    results.push(
      violation(
        ctx,
        shacl.DatatypeConstraintComponent,
        `Property '${labelOf(ps)}' expects ${datatypeLabel(ps.datatype)} (${rule.expected}), but was given ${describeValue(el)}.`,
        el,
      ),
    );
  }
  return results;
};

/** The four `sh:min/maxInclusive/Exclusive` range constraints, on numbers. */
const rangeCheck: ConstraintCheck = (values, ctx) => {
  const ps = ctx.propertyShape;
  const bounds: {
    limit: unknown;
    component: NodeReferenceValue;
    ok: (v: number, limit: number) => boolean;
    phrase: string;
  }[] = [
    {limit: ps.minInclusive, component: shacl.MinInclusiveConstraintComponent, ok: (v, l) => v >= l, phrase: 'at least'},
    {limit: ps.maxInclusive, component: shacl.MaxInclusiveConstraintComponent, ok: (v, l) => v <= l, phrase: 'at most'},
    {limit: ps.minExclusive, component: shacl.MinExclusiveConstraintComponent, ok: (v, l) => v > l, phrase: 'greater than'},
    {limit: ps.maxExclusive, component: shacl.MaxExclusiveConstraintComponent, ok: (v, l) => v < l, phrase: 'less than'},
  ];
  const active = bounds.filter((b) => typeof b.limit === 'number');
  if (!active.length) return [];

  const results: ValidationResult[] = [];
  for (const el of values) {
    // Non-numbers are the datatype check's business.
    if (!isCheckableElement(el) || typeof el !== 'number') continue;
    for (const bound of active) {
      if (bound.ok(el, bound.limit as number)) continue;
      results.push(
        violation(
          ctx,
          bound.component,
          `Property '${labelOf(ps)}' must be ${bound.phrase} ${bound.limit}, but was given ${el}.`,
          el,
        ),
      );
    }
  }
  return results;
};

/** `sh:minLength` / `sh:maxLength`, on strings. */
const lengthCheck: ConstraintCheck = (values, ctx) => {
  const ps = ctx.propertyShape;
  if (typeof ps.minLength !== 'number' && typeof ps.maxLength !== 'number') return [];

  const results: ValidationResult[] = [];
  for (const el of values) {
    if (!isCheckableElement(el) || typeof el !== 'string') continue;
    if (typeof ps.minLength === 'number' && el.length < ps.minLength) {
      results.push(
        violation(
          ctx,
          shacl.MinLengthConstraintComponent,
          `Property '${labelOf(ps)}' must be at least ${ps.minLength} character(s), but was given ${el.length}.`,
          el,
        ),
      );
    }
    if (typeof ps.maxLength === 'number' && el.length > ps.maxLength) {
      results.push(
        violation(
          ctx,
          shacl.MaxLengthConstraintComponent,
          `Property '${labelOf(ps)}' must be at most ${ps.maxLength} character(s), but was given ${el.length}.`,
          el,
        ),
      );
    }
  }
  return results;
};

/** `sh:pattern` — the string form of the value must match the shape's regex. */
const patternCheck: ConstraintCheck = (values, ctx) => {
  const ps = ctx.propertyShape;
  if (!ps.pattern) return [];
  // Rebuild without `g`/`y`: those carry `lastIndex` between calls, so a shared
  // shape regex would match every other value.
  const regex = new RegExp(ps.pattern.source, ps.pattern.flags.replace(/[gy]/g, ''));

  const results: ValidationResult[] = [];
  for (const el of values) {
    if (!isCheckableElement(el) || typeof el !== 'string') continue;
    if (regex.test(el)) continue;
    results.push(
      violation(
        ctx,
        shacl.PatternConstraintComponent,
        `Property '${labelOf(ps)}' must match ${String(ps.pattern)}, but was given "${el}".`,
        el,
      ),
    );
  }
  return results;
};

/** `sh:in` — the value must be one of the shape's allowed values. */
const inCheck: ConstraintCheck = (values, ctx) => {
  const ps = ctx.propertyShape;
  if (!ps.in?.length) return [];
  const allowed = ps.in;
  const matches = (el: unknown) =>
    allowed.some((a) =>
      isNodeReferenceValue(a)
        ? isNodeReference(el) && (el as NodeReferenceValue).id === a.id
        : a === el,
    );

  const results: ValidationResult[] = [];
  for (const el of values) {
    if (!isCheckableElement(el) || matches(el)) continue;
    const rendered = allowed
      .map((a) => (isNodeReferenceValue(a) ? a.id : JSON.stringify(a)))
      .join(', ');
    results.push(
      violation(
        ctx,
        shacl.InConstraintComponent,
        `Property '${labelOf(ps)}' must be one of [${rendered}].`,
        el,
      ),
    );
  }
  return results;
};

/**
 * The registry. Every property-level constraint the library enforces lives here;
 * adding another SHACL component is one more entry plus its test.
 *
 * Split by what each kind of check needs to see. **Cardinality** needs the
 * property's whole value set, so it cannot run against a set modification —
 * `{add: […]}` changes a count that lives in the store. **Value** checks need
 * only the value in hand, so they run everywhere a concrete value appears,
 * including inside `add`.
 *
 * Cardinality runs first when it runs at all: a count problem explains itself
 * better than the per-value violations that would follow it.
 */
const CARDINALITY_CONSTRAINTS: ConstraintCheck[] = [maxCountCheck, minCountCheck];

const VALUE_CONSTRAINTS: ConstraintCheck[] = [
  nodeKindCheck,
  datatypeCheck,
  rangeCheck,
  lengthCheck,
  patternCheck,
  inCheck,
];

const PROPERTY_CONSTRAINTS: ConstraintCheck[] = [
  ...CARDINALITY_CONSTRAINTS,
  ...VALUE_CONSTRAINTS,
];

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

/**
 * A `{add, remove}` set modification. The resulting value count depends on the
 * node's current state, so cardinality and kind are unknowable here.
 */
function isSetModification(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const expected = (obj.add ? 1 : 0) + (obj.remove ? 1 : 0);
  return expected > 0 && Object.getOwnPropertyNames(obj).length === expected;
}

/** An object carrying only an `id` — a reference to an existing node, not a description. */
function isNodeReference(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    Object.keys(value).length === 1
  );
}

/**
 * A value that stands for something resolved later — an expression, a query
 * context reference, a callback, or nothing at all.
 *
 * Must be ruled out *before* anything reads properties off the value: a resolved
 * context ref is a query proxy that throws on any undecorated key, so probing it
 * for `.add` is not a safe way to ask what it is.
 */
function isDeferredValue(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === 'function' ||
    isExpressionNode(value) ||
    !!asContextRef(value)
  );
}

/** Values whose final shape isn't knowable without the store or a lowering pass. */
function isOpaqueValue(value: unknown): boolean {
  return isDeferredValue(value) || isSetModification(value);
}

/** A nested node description — an object to descend into, rather than a leaf value. */
function isNodeDescription(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !isNodeReference(value) &&
    !isOpaqueValue(value)
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * What can be validated against: a shape class (`Person`) or the plain
 * `NodeShapeData` the decorators generate (`Person.shape`, or the same object
 * obtained anywhere else). The two are interchangeable — the class is unwrapped
 * to its `shape` and nothing else about it is read.
 */
export type ValidatableShape = NodeShapeData | {shape: NodeShapeData};

function resolveShapeData(shape: ValidatableShape): NodeShapeData {
  const resolved = 'propertyShapes' in shape ? shape : (shape as {shape: NodeShapeData}).shape;
  if (!resolved) {
    throw new Error(
      'validate() requires a node shape or a shape class with a static `shape`. ' +
        'Did you pass an unregistered class (missing @linkedShape)?',
    );
  }
  return resolved as NodeShapeData;
}

/**
 * Validate a plain data object against a node shape.
 *
 * Never throws for invalid *data* — a violation is a result, not an exception.
 * (It does throw when the *shape* argument itself is unusable.)
 *
 * ```ts
 * const report = validate(Person, {name: ['a', 'b']});
 * report.conforms; // false
 * report.results[0].sourceConstraintComponent.id; // …shacl#MaxCountConstraintComponent
 * ```
 *
 * **A shape class is optional.** The plain `NodeShapeData` the decorators
 * generate validates identically, so a caller that only ever holds shape
 * objects needs no class reference:
 *
 * ```ts
 * validate(Person, data);        // ≡
 * validate(Person.shape, data);  // same report
 * ```
 *
 * That holds even though a shape object carries neither its inherited property
 * shapes (a subclass's `propertyShapes` holds only its own) nor its nested
 * shapes (`valueShape` is a bare `{id}`): both are resolved through the shape
 * registry by id. A shape whose id is not registered therefore cannot be fully
 * checked, and says so — see {@link unresolvedValueShapeMessage} and the
 * inherited-properties check in `validateNode` — rather than reporting a node
 * as conforming on the strength of a branch it could not look at.
 */
export function validate(
  shape: ValidatableShape,
  data: unknown,
  options: ValidateOptions = {},
): ValidationReport {
  const {mode = 'complete', maxDepth = 10} = options;
  const results = validateNode(resolveShapeData(shape), data, {
    mode,
    maxDepth,
    depth: 0,
    prefix: '',
  });
  return {
    conforms: !results.some((r) => r.resultSeverity.id === shacl.Violation.id),
    results,
  };
}

/** {@link validate}, but throws a {@link ShapeValidationError} when the data doesn't conform. */
export function assertValid(
  shape: ValidatableShape,
  data: unknown,
  options: ValidateOptions = {},
): void {
  const report = validate(shape, data, options);
  if (!report.conforms) throw new ShapeValidationError(report);
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

interface WalkContext {
  mode: ValidationMode;
  maxDepth: number;
  depth: number;
  /** Dot-joined label path of the node being validated (`''` at the root). */
  prefix: string;
  focusNode?: string;
}

function validateNode(
  shape: NodeShapeData,
  data: unknown,
  ctx: WalkContext,
): ValidationResult[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [
      nodeViolation(
        shape,
        ctx,
        shacl.NodeConstraintComponent,
        `Expected an object describing '${shape.label || shape.id}', but got ${data === null ? 'null' : typeof data}.`,
        ctx.prefix,
        data,
      ),
    ];
  }

  const obj = data as Record<string, unknown>;
  const propertyShapes = getUniquePropertyShapes(shape);
  const byLabel = new Map(propertyShapes.map((ps) => [ps.label, ps]));
  const focusNode =
    typeof obj.__id === 'string'
      ? obj.__id
      : typeof obj.id === 'string'
        ? obj.id
        : ctx.focusNode;
  const results: ValidationResult[] = [];

  // A shape declaring a superclass carries only its *own* property shapes; the
  // inherited ones are resolved through the registry by id. If this shape's id
  // is not registered, that resolution quietly yields half a shape — required
  // inherited properties go unchecked, and any that *are* supplied look
  // undeclared. Report it rather than let a partial shape pass as a clean bill.
  //
  // "Registered" means present in EITHER registry. Checking only for a class rejected
  // exactly the shapes the metamodel work exists to support: a data-only child is
  // registered, its parent resolves, and its inherited properties are checked — it simply
  // has no class, which is not a defect.
  if (shape.extends?.id && !getShapeClass(shape.id) && !getNodeShape(shape.id)) {
    results.push(
      nodeViolation(
        shape,
        {focusNode},
        shacl.NodeConstraintComponent,
        `Cannot resolve the properties '${shape.label || shape.id}' inherits from '${shape.extends.id}': shape '${shape.id}' is not registered, so only its own properties could be checked.`,
        ctx.prefix,
      ),
    );
  }

  // Presence of required properties — only decidable for a complete description.
  if (ctx.mode === 'complete') {
    for (const ps of propertyShapes) {
      if (typeof ps.minCount !== 'number' || ps.minCount <= 0) continue;
      if (ps.label in obj) continue;
      results.push(
        violation(
          {shape, propertyShape: ps, property: join(ctx.prefix, ps.label), focusNode, mode: ctx.mode},
          shacl.MinCountConstraintComponent,
          `Property '${labelOf(ps)}' requires at least ${ps.minCount} value(s), but none were provided.`,
        ),
      );
    }
  }

  // The values actually provided.
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) continue;
    const propertyShape = byLabel.get(key);
    if (!propertyShape) {
      results.push(
        nodeViolation(
          shape,
          {...ctx, focusNode},
          shacl.ClosedConstraintComponent,
          undeclaredPropertyMessage(key, shape),
          join(ctx.prefix, key),
          value,
        ),
      );
      continue;
    }
    results.push(
      ...validateProperty(value, {
        shape,
        propertyShape,
        property: join(ctx.prefix, key),
        focusNode,
        mode: ctx.mode,
      }, ctx),
    );
  }

  return results;
}

function validateProperty(
  value: unknown,
  propCtx: PropertyContext,
  walk: WalkContext,
): ValidationResult[] {
  const ps = propCtx.propertyShape;

  // `null` clears the property — the same as providing zero values, so clearing
  // a required one is a cardinality violation (both spellings behave alike).
  if (value === null) {
    if (typeof ps.minCount === 'number' && ps.minCount > 0) {
      return [
        violation(
          propCtx,
          shacl.MinCountConstraintComponent,
          `Property '${labelOf(ps)}' requires at least ${ps.minCount} value(s) and cannot be cleared.`,
        ),
      ];
    }
    return [];
  }

  // Ruled out first: reading `.add` off a resolved context proxy would throw.
  if (isDeferredValue(value)) return [];

  // A set modification adds to and removes from what the store already holds,
  // so the resulting *count* is unknowable here — but each added value is as
  // checkable as any other, and skipping them let mistyped literals through the
  // one door the rest of this module closes. `remove` takes `{id}` references
  // only, which normalization enforces on its own.
  if (isSetModification(value)) {
    const {add} = value as {add?: unknown};
    if (add === undefined) return [];
    return runChecks(VALUE_CONSTRAINTS, toValues(add), propCtx, walk);
  }

  return runChecks(PROPERTY_CONSTRAINTS, toValues(value), propCtx, walk);
}

/** A property's value(s) as an array — a single value becomes a one-element one. */
function toValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Run a set of constraint checks over a property's values, then descend into any
 * nested node descriptions among them (`sh:node`-style recursion). A bare `{id}`
 * is a reference to an existing node and has nothing to validate; an object with
 * an id *and* data is a nested create with a predefined id.
 */
function runChecks(
  checks: ConstraintCheck[],
  values: unknown[],
  propCtx: PropertyContext,
  walk: WalkContext,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const check of checks) {
    results.push(...check(values, propCtx));
  }

  if (walk.depth < walk.maxDepth) {
    for (const el of values) {
      if (!isNodeDescription(el)) continue;
      const nestedShape = resolveValueShape(propCtx.propertyShape, el);
      if (!nestedShape) {
        // The value is a node description we have no shape for, so nothing about
        // it can be checked. Silently skipping would report the whole node as
        // conforming on the strength of a branch never looked at.
        results.push(
          violation(
            propCtx,
            shacl.NodeConstraintComponent,
            unresolvedValueShapeMessage(propCtx.propertyShape),
          ),
        );
        continue;
      }
      results.push(
        ...validateNode(nestedShape, el, {
          ...walk,
          depth: walk.depth + 1,
          prefix: propCtx.property,
          focusNode: undefined,
        }),
      );
    }
  }

  return results;
}

/**
 * Why a nested value could not be resolved to a shape — the property named one
 * that is not registered, or named none and the value did not carry one either.
 * Both are actionable, and they are fixed differently.
 */
function unresolvedValueShapeMessage(ps: PropertyShapeData): string {
  const label = labelOf(ps);
  return ps.valueShape
    ? `Cannot validate the value of '${label}': its shape '${ps.valueShape.id}' is not registered.`
    : `Cannot validate the value of '${label}': the property declares no shape for its values. ` +
        `Add a 'shape' to its @objectProperty decorator, or give the value a 'shape' key.`;
}

/**
 * The shape a nested value should be validated against: the property's declared
 * `valueShape`, or — for properties that declare none — the shape class carried
 * in the value's reserved `shape` key. Mirrors `convertUpdateValue`; returns
 * undefined when neither is available.
 */
function resolveValueShape(
  ps: PropertyShapeData,
  value: unknown,
): NodeShapeData | undefined {
  if (ps.valueShape) return getShapeClass(ps.valueShape)?.shape;
  const declared = (value as {shape?: {shape?: NodeShapeData}}).shape;
  return declared?.shape;
}

function join(prefix: string, label: string): string {
  return prefix ? `${prefix}.${label}` : label;
}
