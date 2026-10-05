/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {type NodeReferenceValue, toNodeReference} from '../utils/NodeReference.js';
import {Shape, type ShapeConstructor} from './Shape.js';
import {shacl} from '../ontologies/shacl.js';
import {warnOnReservedPropertyLabel} from '../queries/reservedQueryNames.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {normalizePropertyPath, type PropertyPathDecoratorInput} from '../paths/normalizePropertyPath.js';
import {
  createPropertyShapeData,
  getPropertyShape as getPropertyShapeData,
  addPropertyShape as addPropertyShapeData,
  clonePropertyShape,
  type NodeShapeData,
  type PropertyShapeData,
} from './nodeShapeData.js';

// Metadata types now live in nodeShapeData.js (plain objects); re-exported here for
// existing importers of `NodeShape`/`PropertyShape`-adjacent types.
export type {NodeShapeData, PropertyShapeData, PropertyShapeResult} from './nodeShapeData.js';
// Metadata operations (formerly NodeShape/PropertyShape instance methods).
export {
  getPropertyShapes,
  getUniquePropertyShapes,
  getPropertyShape,
  addPropertyShape,
  clonePropertyShape,
  propertyShapeToResult,
  nodeShapeEquals,
  createNodeShapeData,
  createPropertyShapeData,
} from './nodeShapeData.js';

/**
 * Default identity root for shape & package IRIs. Public/first-party packages
 * publish under `linked.cm` (arch-02 §Domains). Packages may override per-package
 * via `linkedPackage(name, { baseUri })` — CN injects a workspace-scoped root
 * (`{workspaceSlug}.id.create.now`) for private packages; first-party packages
 * keep this default.
 */
export const LINKED_DATA_ROOT: string = 'https://linked.cm/';

/**
 * Derive the public package slug — the npm package **basename** with the
 * `@scope/` dropped, kebab-cased (arch-02 §Slug rules: `^[a-z0-9]+(?:-[a-z0-9]+)*$`).
 * The package name is the single source of truth; there is no separate slug.
 *   `@_linked/core` → `core`, `@linked.cm/blog` → `blog`, `mypkg` → `mypkg`.
 *
 * Both first-party (`@_linked`) and community (`@linked.cm`) packages publish into
 * the one `linked.cm/{shape,pkg}` space, so the basename must be globally unique —
 * enforced by the registry, which reserves the (handful of) first-party names.
 */
export function packageNameToSlug(packageName: string): string {
  return packageName
    .replace(/^@[^/]+\//, '') // drop the npm scope (@scope/), keep the basename
    .replace(/[^a-zA-Z0-9]+/g, '-') // any run of non-alphanumerics → single hyphen
    .replace(/^-+|-+$/g, '') // trim stray hyphens
    .toLowerCase();
}

/**
 * Where each package publishes its IRIs (the identity root). The slug is always
 * derived from the package name; only the root is configurable — `linkedPackage`
 * defaults it to `LINKED_DATA_ROOT` (linked.cm), and CN injects a workspace-scoped
 * root (`{workspaceSlug}.id.create.now`) for private packages.
 */
const packageBaseUri = new Map<string, string>();

/** Record a package's publish root. Called by `linkedPackage()`. */
export function setPackagePublishConfig(
  packageName: string,
  config?: {baseUri?: string},
): void {
  packageBaseUri.set(packageName, config?.baseUri ?? LINKED_DATA_ROOT);
}

/** Resolve a package's publish root, defaulting to linked.cm if undeclared. */
function resolveBaseUri(packageName: string): string {
  return packageBaseUri.get(packageName) ?? LINKED_DATA_ROOT;
}

/** Public/first-party package IRI — arch-02: `{baseUri}pkg/{slug}`. */
export function getPackageUri(packageName: string): string {
  return `${resolveBaseUri(packageName)}pkg/${packageNameToSlug(packageName)}`;
}

type NodeKindConfig = NodeReferenceValue | NodeReferenceValue[];

export type PropertyPathInput = PropertyPathDecoratorInput;
export type PropertyPathInputList = PropertyPathDecoratorInput;

const normalizeNodeKind = (
  nodeKind?: NodeKindConfig,
  defaultNodeKind?: NodeReferenceValue,
): NodeReferenceValue | undefined => {
  if (!nodeKind) {
    return defaultNodeKind;
  }
  if (Array.isArray(nodeKind)) {
    const ids = nodeKind.map((entry) => entry?.id);
    const includesBlank = ids.includes(shacl.BlankNode.id);
    const includesNamed = ids.includes(shacl.IRI.id);
    const includesLiteral = ids.includes(shacl.Literal.id);
    if (includesBlank && includesNamed) {
      return shacl.BlankNodeOrIRI;
    }
    if (includesLiteral && includesNamed) {
      return shacl.IRIOrLiteral;
    }
    if (includesLiteral && includesBlank) {
      return shacl.BlankNodeOrLiteral;
    }
    return nodeKind[0];
  }
  return nodeKind;
};

export interface NodeShapeConfig {
  /**
   * Set to true to close the shape. This means any target node of this shape
   * that has properties outside the defined properties of this shape is invalid.
   */
  closed?: boolean;
  /**
   * Optional list of properties that are also permitted in addition to those explicitly listed by this shape.
   */
  ignoredProperties?: NodeReferenceValue[];
}

export interface LiteralPropertyShapeConfig extends PropertyShapeConfig {
  nodeKind?: NodeReferenceValue;
  /**
   * Values of the configured property must be less than the values of this 'lessThan' property.
   * Value is always a property IRI (pair constraint).
   */
  lessThan?: NodeReferenceValue;
  /**
   * Values of the configured property must be less than or equal the values of this 'lessThanOrEquals' property.
   * Value is always a property IRI (pair constraint).
   */
  lessThanOrEquals?: NodeReferenceValue;
  /**
   * All values of this property must be higher than this number
   */
  minExclusive?: number | string;
  /**
   * All values of this property must be higher than or equal this number
   */
  minInclusive?: number;
  /**
   * All values of this property must be lower than this number
   */
  maxExclusive?: number;
  /**
   * All values of this property must be lower than or equal this number
   */
  maxInclusive?: number;
  /**
   * All literal values of this property must at least be this long
   */
  minLength?: number;
  /**
   * All literal values of this property must at most be this long
   */
  maxLength?: number;
  /**
   * All literal values of this property must match this regular expression
   */
  pattern?: RegExp;
  /**
   * All literal values of this property must have one of these languages as their language tag
   */
  languageIn?: string[];
  /**
   * No pair of values may use the same language tag.
   */
  uniqueLang?: boolean;
  /**
   * Each literal value of this property must use this datatype
   */
  datatype?: NodeReferenceValue;
  /**
   * Each value of the property must occur in this set.
   * Use {id: '...'} for IRI nodes, or plain strings/numbers/booleans for literal values.
   */
  in?: (NodeReferenceValue | string | number | boolean)[];
}

export interface ObjectPropertyShapeConfig extends PropertyShapeConfig {
  nodeKind?: NodeReferenceValue;
  /**
   * Each value of this property must have this class as its rdf:type
   */
  class?: NodeReferenceValue;
  /**
   * The shape that values of this property path need to confirm to.
   * You need to provide a class that extends Shape.
   */
  shape?: typeof Shape | [string, string];
  /**
   * Marks this property as *containment* (composition): the value(s) are owned by the subject
   * and the delete/update cascade removes the owned subtree.
   */
  contains?: boolean;
}

export interface PropertyShapeConfig {
  /**
   * The property path of this property shape.
   *
   * Four accepted forms, all equivalent where they overlap:
   *
   * - **An ontology term** — `documents.confidence`. The idiom for real shapes: it reuses the
   *   ontology, so a namespace changes in one place. `createNameSpace` returns a `{id}` ref, so
   *   the term IS the second form and is passed DIRECTLY — never `documents.confidence.id`,
   *   which unwraps it back to a bare string.
   * - **A node reference** — `{id: 'https://example.org/vocab#startsAt'}`. What the first form
   *   produces. Convenient in tests, or wherever an ontology module would be overkill.
   * - **A bare IRI or prefixed name** — `'https://example.org/vocab#startsAt'`, `'ex:startsAt'`.
   * - **A path expression** — `'ex:a/ex:b'`, `{seq: [...]}`, `{inv: ...}`, and the other
   *   operators. An array is read as a sequence.
   *
   * A string is parsed as an expression only when it is not a bare absolute IRI: `ex:a/ex:b` is
   * a sequence, while the `/` inside `https://example.org/vocab#x` belongs to the IRI.
   */
  path: PropertyPathInputList;
  /**
   * Indicates that this property must exist.
   * Shorthand for minCount=1
   */
  required?: boolean;
  /**
   * Each value must be of this node type.
   */
  nodeKind?: NodeKindConfig;
  /**
   * Minimum number of values required
   */
  minCount?: number;
  /**
   * Maximum number of values allowed
   */
  maxCount?: number;
  /**
   * Values of the configured property must equal the values of this 'equals' property.
   * Value is always a property IRI (pair constraint).
   */
  equals?: NodeReferenceValue;
  /**
   * Values of the configured property must differ from the values of this 'disjoint' property.
   * Value is always a property IRI (pair constraint).
   */
  disjoint?: NodeReferenceValue;
  /**
   * At least one value of this property must equal the given value.
   * Use {id: '...'} for IRI nodes, or a plain string for literal values.
   */
  hasValue?: NodeReferenceValue | string | number | boolean;
  name?: string;
  description?: string;
  order?: number;
  group?: string;
  /**
   * Display importance, lower = more important (`core:displayRank`).
   * A renderer that can show only N properties shows the N lowest ranks.
   */
  displayRank?: number;
  /** Omit this property from generic rendering (`core:displayHidden`). */
  displayHidden?: boolean;
  /**
   * should correlate to the given datatype or class
   */
  defaultValue?: unknown;
  /**
   * Each value of the property must occur in this set.
   * Use {id: '...'} for IRI nodes, or plain strings for literal values.
   *
   * @example
   * in: ['ACTIVE', 'PENDING', 'CLOSED']
   * in: [{id: 'http://example.org/StatusA'}, {id: 'http://example.org/StatusB'}]
   */
  in?: (NodeReferenceValue | string | number | boolean)[];
  /**
   * Values of the configured property path are sorted by the values of this property path.
   */
  sortBy?: PropertyPathInputList;
}

const EXPLICIT_NODE_KIND_SYMBOL = Symbol('explicitNodeKind');
const EXPLICIT_MIN_COUNT_SYMBOL = Symbol('explicitMinCount');
const EXPLICIT_MAX_COUNT_SYMBOL = Symbol('explicitMaxCount');

/** Internal symbol-keyed flags on a PropertyShapeData object to track which fields were explicitly configured. */
interface ExplicitFlags {
  [EXPLICIT_NODE_KIND_SYMBOL]?: boolean;
  [EXPLICIT_MIN_COUNT_SYMBOL]?: boolean;
  [EXPLICIT_MAX_COUNT_SYMBOL]?: boolean;
}

export interface ParameterConfig {
  optional?: number;
}

/**
 * Static-only DSL handle for the SHACL `sh:NodeShape` meta-shape.
 *
 * Never instantiated — a shape's metadata is a plain {@link NodeShapeData} object
 * (see nodeShapeData.js), and the instance methods that used to live here are now
 * free functions in that module. This class exists only to carry the meta-shape's
 * static `.shape` self-description and to serve as the DSL entry point for reading
 * and writing node-shape SHACL data (`NodeShape.create/select/delete`).
 */
export class NodeShape extends Shape {
  static targetClass = shacl.NodeShape;
}

/**
 * Static-only DSL handle for the SHACL `sh:PropertyShape` meta-shape.
 *
 * Never instantiated — property-shape metadata is a plain {@link PropertyShapeData}
 * object (see nodeShapeData.js). Exists only for its static `.shape` self-description
 * and as a DSL entry point (`PropertyShape.create/select`).
 */
export class PropertyShape extends Shape {
  static targetClass = shacl.PropertyShape;
}

const connectValueShape = <
  Config extends LiteralPropertyShapeConfig | ObjectPropertyShapeConfig,
>(
  config: Config,
  propertyKey: string,
  property: PropertyShapeData,
) => {
  if ((config as ObjectPropertyShapeConfig).shape) {
    const shapeConfig = (config as ObjectPropertyShapeConfig).shape;

    if (Array.isArray(shapeConfig)) {
      const [packageName, shapeName] = shapeConfig;
      const nodeShapeUri = getNodeShapeUri(packageName, shapeName);
      property.valueShape = {id: nodeShapeUri};
    } else {
      const shapeClass = shapeConfig as typeof Shape;
      if (shapeClass.shape) {
        property.valueShape = {id: shapeClass.shape.id};
      } else {
        onShapeSetup(
          shapeConfig,
          (nodeShape: NodeShapeData) => {
            property.valueShape = {id: nodeShape.id};
          },
          propertyKey,
        );
      }
    }
  }
};

/**
 * The DSL-JSON where-clause combinators. A property may not be named after one,
 * because a condition key in those positions has no `{path}` escape (the key is a
 * bare string). See documentation/dsl-json.md (Reserved words).
 */
const RESERVED_PROPERTY_LABELS = new Set(['and', 'or', 'not']);

export function registerPropertyShape(
  shape: NodeShapeData,
  propertyShape: PropertyShapeData,
) {
  if (RESERVED_PROPERTY_LABELS.has(propertyShape.label)) {
    throw new Error(
      `Property label '${propertyShape.label}' is reserved (a DSL-JSON boolean combinator) ` +
        `and cannot be used as a property name. See documentation/dsl-json.md (Reserved words).`,
    );
  }
  // Not fatal, but the author needs to hear it here rather than from the field tracer.
  warnOnReservedPropertyLabel(propertyShape.label, shape.label, shape.id);
  const inherited = getPropertyShapeData(shape, propertyShape.label, true);
  const existing = getPropertyShapeData(shape, propertyShape.label, false);
  if (!existing && inherited) {
    if (!(propertyShape as unknown as ExplicitFlags)[EXPLICIT_MIN_COUNT_SYMBOL]) {
      propertyShape.minCount = inherited.minCount;
    }
    if (!(propertyShape as unknown as ExplicitFlags)[EXPLICIT_MAX_COUNT_SYMBOL]) {
      propertyShape.maxCount = inherited.maxCount;
    }
    if (!(propertyShape as unknown as ExplicitFlags)[EXPLICIT_NODE_KIND_SYMBOL]) {
      propertyShape.nodeKind = inherited.nodeKind;
    }
    validateOverrideTightening(shape, inherited, propertyShape);
  }
  if (existing) {
    Object.assign(existing, propertyShape);
    return existing;
  }
  propertyShape.id = `${shape.id}/${propertyShape.label}`;
  addPropertyShapeData(shape, propertyShape);
  return propertyShape;
}

const ATOMIC_NODE_KINDS = [
  shacl.BlankNode.id,
  shacl.IRI.id,
  shacl.Literal.id,
];

const nodeKindToAtomics = (nodeKind?: NodeReferenceValue): Set<string> => {
  if (!nodeKind?.id) {
    return new Set();
  }
  switch (nodeKind.id) {
    case shacl.BlankNode.id:
    case shacl.IRI.id:
    case shacl.Literal.id:
      return new Set([nodeKind.id]);
    case shacl.BlankNodeOrIRI.id:
      return new Set([shacl.BlankNode.id, shacl.IRI.id]);
    case shacl.IRIOrLiteral.id:
      return new Set([shacl.IRI.id, shacl.Literal.id]);
    case shacl.BlankNodeOrLiteral.id:
      return new Set([shacl.BlankNode.id, shacl.Literal.id]);
    default:
      return new Set(ATOMIC_NODE_KINDS);
  }
};

const throwOverrideError = (
  shape: NodeShapeData,
  propertyShape: PropertyShapeData,
  message: string,
) => {
  throw new Error(
    `Invalid override for ${shape.label}.${propertyShape.label}: ${message}`,
  );
};

const validateOverrideTightening = (
  shape: NodeShapeData,
  base: PropertyShapeData,
  override: PropertyShapeData,
) => {
  if (
    typeof base.minCount === 'number' &&
    typeof override.minCount === 'number' &&
    override.minCount < base.minCount
  ) {
    throwOverrideError(
      shape,
      override,
      `minCount cannot be lowered (${base.minCount} -> ${override.minCount}).`,
    );
  }

  if (
    typeof base.maxCount === 'number' &&
    typeof override.maxCount === 'number' &&
    override.maxCount > base.maxCount
  ) {
    throwOverrideError(
      shape,
      override,
      `maxCount cannot be increased (${base.maxCount} -> ${override.maxCount}).`,
    );
  }

  if (base.nodeKind && override.nodeKind) {
    const baseKinds = nodeKindToAtomics(base.nodeKind);
    const overrideKinds = nodeKindToAtomics(override.nodeKind);
    const widensNodeKind = [...overrideKinds].some((kind) => !baseKinds.has(kind));
    if (widensNodeKind) {
      throwOverrideError(
        shape,
        override,
        `nodeKind cannot be widened (${base.nodeKind.id} -> ${override.nodeKind.id}).`,
      );
    }
  }
};

export function createPropertyShape<
  Config extends LiteralPropertyShapeConfig | ObjectPropertyShapeConfig,
>(
  config: Config,
  propertyKey: string,
  defaultNodeKind: NodeReferenceValue = null,
  shapeClass: typeof Shape | [string, string] = null,
) {
  const propertyShape = createPropertyShapeData();
  propertyShape.path = normalizePropertyPath(config.path);
  propertyShape.label = propertyKey;

  if (config.name) {
    propertyShape.name = config.name;
  }
  if (config.description) {
    propertyShape.description = config.description;
  }

  if (config.required) {
    propertyShape.minCount = 1;
  } else if (config.minCount !== undefined) {
    propertyShape.minCount = config.minCount;
  }
  (propertyShape as unknown as ExplicitFlags)[EXPLICIT_MIN_COUNT_SYMBOL] =
    config.required === true || config.minCount !== undefined;

  if (config.maxCount !== undefined) {
    propertyShape.maxCount = config.maxCount;
  }
  (propertyShape as unknown as ExplicitFlags)[EXPLICIT_MAX_COUNT_SYMBOL] =
    config.maxCount !== undefined;
  if ((config as LiteralPropertyShapeConfig).datatype) {
    propertyShape.datatype = toNodeReference(
      (config as LiteralPropertyShapeConfig).datatype,
    );
  }

  if ((config as ObjectPropertyShapeConfig).class) {
    propertyShape.class = toNodeReference(
      (config as ObjectPropertyShapeConfig).class,
    );
  }

  if ((config as ObjectPropertyShapeConfig).contains) {
    propertyShape.contains = true;
  }

  if (config.equals) {
    propertyShape.equalsConstraint = toNodeReference(config.equals);
  }
  if (config.disjoint) {
    propertyShape.disjoint = toNodeReference(config.disjoint);
  }
  if ((config as LiteralPropertyShapeConfig).lessThan) {
    propertyShape.lessThan = toNodeReference((config as LiteralPropertyShapeConfig).lessThan);
  }
  if ((config as LiteralPropertyShapeConfig).lessThanOrEquals) {
    propertyShape.lessThanOrEquals = toNodeReference((config as LiteralPropertyShapeConfig).lessThanOrEquals);
  }
  // Value-range / string-length / pattern constraints (report 021 §3, G5). These are
  // recorded on the shape and serialized to SHACL; there is no DSL-side runtime
  // enforcement — they describe the shape for validators / introspection.
  {
    const lit = config as LiteralPropertyShapeConfig;
    if (lit.minInclusive !== undefined) propertyShape.minInclusive = lit.minInclusive;
    if (lit.maxInclusive !== undefined) propertyShape.maxInclusive = lit.maxInclusive;
    if (lit.minExclusive !== undefined) propertyShape.minExclusive = lit.minExclusive;
    if (lit.maxExclusive !== undefined) propertyShape.maxExclusive = lit.maxExclusive;
    if (lit.minLength !== undefined) propertyShape.minLength = lit.minLength;
    if (lit.maxLength !== undefined) propertyShape.maxLength = lit.maxLength;
    if (lit.pattern !== undefined) propertyShape.pattern = lit.pattern;
  }
  if (config.hasValue !== undefined) {
    const v = config.hasValue;
    propertyShape.hasValueConstraint = typeof v === 'object' && v !== null ? toNodeReference(v) : v;
  }
  if (config.defaultValue !== undefined) {
    propertyShape.defaultValue = config.defaultValue;
  }
  if (config.in) {
    propertyShape.in = config.in.map((entry) =>
      typeof entry === 'object' && entry !== null ? toNodeReference(entry) : entry,
    );
  }
  if (config.sortBy) {
    propertyShape.sortBy = normalizePropertyPath(config.sortBy);
  }
  // Arrangement + display metadata. `order` and `group` were declared on the config
  // but never copied onto the property shape, so a declared `sh:order` was silently
  // dropped and every renderer fell back to array position. Carried now, alongside
  // the two display terms.
  if (config.order !== undefined) propertyShape.order = config.order;
  if (config.group !== undefined) propertyShape.group = config.group;
  if (config.displayRank !== undefined) propertyShape.displayRank = config.displayRank;
  if (config.displayHidden !== undefined)
    propertyShape.displayHidden = config.displayHidden;

  propertyShape.nodeKind = normalizeNodeKind(config.nodeKind, defaultNodeKind);
  (propertyShape as unknown as ExplicitFlags)[EXPLICIT_NODE_KIND_SYMBOL] =
    config.nodeKind !== undefined;

  if (shapeClass) {
    onShapeSetup(shapeClass, (shape: NodeShapeData) => {
      connectValueShape(config, propertyKey, propertyShape);
      registerPropertyShape(shape, propertyShape);
    });
  }

  return propertyShape;
}

export function onShapeSetup(
  shapeClass: typeof Shape | [string, string],
  callback: (shape: NodeShapeData) => void,
  propertyName?: string,
  waitForSuperShapes?: boolean,
) {
  const cb = waitForSuperShapes
    ? (shape: NodeShapeData) => {
        const superClass = Object.getPrototypeOf(shapeClass) as typeof Shape;
        if (superClass.name === 'Shape') {
          callback(shape);
          return;
        }
        if (superClass.name === '') {
          console.error(
            `Shape ${shape.label} does not extend base class lincd/shapes/Shape. Make sure it extends Shape.`,
          );
          return;
        }
        onShapeSetup(
          superClass,
          () => {
            callback(shape);
          },
          propertyName,
          waitForSuperShapes,
        );
      }
    : callback;

  const safeCallback = (
    targetShapeClass: typeof Shape,
    innerCallback: (shape: NodeShapeData) => void,
  ) => {
    if (targetShapeClass.hasOwnProperty('shape')) {
      innerCallback((targetShapeClass as typeof Shape).shape);
    } else {
      if (!targetShapeClass['shapeCallbacks']) {
        targetShapeClass['shapeCallbacks'] = [];
      }
      targetShapeClass['shapeCallbacks'].push(innerCallback);
    }
  };

  if (Array.isArray(shapeClass)) {
    const [packageName, shapeName] = shapeClass;
    const nodeShapeId = getNodeShapeUri(packageName, shapeName);
    if (typeof document !== 'undefined') {
      window.addEventListener('load', () => {
        const resolved = getShapeClass(nodeShapeId);
        if (!resolved) {
          console.warn(
            `Could not find value shape (${packageName}/${shapeName}) for accessor get ${propertyName}(). Likely because it is not bundled.`,
          );
          return;
        }
        safeCallback(resolved as unknown as typeof Shape, cb);
      });
    } else {
      addNodeShapeCallback(nodeShapeId, cb);
    }
  } else {
    safeCallback(shapeClass, cb);
  }
}

const _linkedProperty = <
  Config extends ObjectPropertyShapeConfig | LiteralPropertyShapeConfig,
>(
  config: Config,
  defaultNodeKind: NodeReferenceValue = null,
) => {
  return function (
    target: any,
    propertyKey: string,
    _descriptor: PropertyDescriptor,
  ) {
    createPropertyShape(config, propertyKey, defaultNodeKind, target.constructor);
  };
};

export const literalProperty = (config: LiteralPropertyShapeConfig) => {
  return _linkedProperty<LiteralPropertyShapeConfig>(config, shacl.Literal);
};

export const objectProperty = (config: ObjectPropertyShapeConfig) => {
  return _linkedProperty<ObjectPropertyShapeConfig>(config, shacl.IRI);
};

export const linkedProperty = (
  config: ObjectPropertyShapeConfig | LiteralPropertyShapeConfig,
) => {
  return _linkedProperty(config);
};

export function disallowProperty(
  target: any,
  propertyKey: string,
  _descriptor: PropertyDescriptor,
) {
  onShapeSetup(
    target.constructor,
    (shape: NodeShapeData) => {
      const superClass = Object.getPrototypeOf(target.constructor) as typeof Shape;
      const superNodeShape = superClass.shape;
      const superPropertyShape = getPropertyShapeData(
        superNodeShape,
        propertyKey,
        true,
      );
      if (!superPropertyShape) {
        console.warn(
          `Property ${propertyKey} not found in super class ${superClass.name} or any of its super classes. Does it have a property decorator? Cannot disallow property ${target.constructor.name}.${propertyKey}`,
        );
        return;
      }
      const clonedPropertyShape = clonePropertyShape(superPropertyShape);
      clonedPropertyShape.maxCount = 0;
      registerPropertyShape(shape, clonedPropertyShape);
    },
    '',
    true,
  );
}

export function getNodeShapeUri(packageName: string, shapeName: string): string {
  // arch-02: `{baseUri}shape/{packageSlug}/{ShapeName}` — ShapeName kept PascalCase
  // (it is a class name, already URI-safe), packageSlug derived from the name.
  return `${resolveBaseUri(packageName)}shape/${packageNameToSlug(packageName)}/${shapeName}`;
}

const nodeShapeCallbacks = new Map<string, ((shape: NodeShapeData) => void)[]>();
export function getAndClearCallbacks(
  nodeShapeId: string,
): ((shape: NodeShapeData) => void)[] {
  const callbacks = nodeShapeCallbacks.get(nodeShapeId);
  nodeShapeCallbacks.delete(nodeShapeId);
  return callbacks;
}
export const addNodeShapeCallback = (
  nodeShapeId: string,
  callback: (shape: NodeShapeData) => void,
) => {
  if (!nodeShapeCallbacks.has(nodeShapeId)) {
    nodeShapeCallbacks.set(nodeShapeId, []);
  }
  nodeShapeCallbacks.get(nodeShapeId).push(callback);
};
