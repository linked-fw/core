import {Shape, createShapeTarget, type ShapeConstructor} from '../shapes/Shape.js';
import {getPropertyShapes, getUniquePropertyShapes, nodeShapeEquals} from '../shapes/nodeShapeData.js';
import type {NodeShapeData, PropertyShapeData} from '../shapes/SHACL.js';
import type {RawSelectInput} from './IRDesugar.js';
import {ShapeSet} from '../collections/ShapeSet.js';
import {shacl} from '../ontologies/shacl.js';
import {CoreSet} from '../collections/CoreSet.js';
import {getOrCreateShapeAdapter, getPropertyShapeByLabel,getShapeClass} from '../utils/ShapeClass.js';

/**
 * An authored shape class if there is one, otherwise a constructor derived from the
 * shape's registered metadata.
 *
 * A shape authored in a project exists only as data -- `registerRuntimeShape` records
 * the metadata and deliberately does NOT synthesize a class, so `getShapeClass` alone
 * answers `undefined` for every such shape and the query layer then fails somewhere
 * downstream of the lookup.
 */
const resolveShapeForQuery = (id: string) =>
  getShapeClass(id) ?? getOrCreateShapeAdapter(id);
import {NodeReferenceValue,type Prettify,type ShapeReferenceValue} from './QueryFactory.js';
import {xsd} from '../ontologies/xsd.js';
import type {IRSelectQuery} from './IntermediateRepresentation.js';
import {createProxiedPathBuilder} from './ProxiedPathBuilder.js';
import {FieldSet} from './FieldSet.js';
import {PropertyPath} from './PropertyPath.js';
import type {QueryBuilder, QueryBuilderJSON} from './QueryBuilder.js';
import {ExpressionNode, ExistsCondition, isExpressionNode, isExistsCondition, tracedPropertyExpression, tracedAliasExpression} from '../expressions/ExpressionNode.js';
import {PendingQueryContext} from './QueryContext.js';

/**
 * String keys the query-shape proxy must let through *without* treating them as
 * a property access — promise-awaiting (`then`), React (`$$typeof`), and common
 * serializer/object-protocol probes. Everything else that isn't a decorated
 * property is a genuine misuse and throws. (Symbol keys always pass through.)
 */
const INTEROP_PASSTHROUGH_KEYS = new Set<string>([
  'then',
  '$$typeof',
  'toJSON',
  'toString',
  'valueOf',
  'constructor',
  'asymmetricMatch', // jest matchers probe this
  'nodeType', // some DOM/serializer probes
]);

/**
 * The closed, read-only select query a dataset receives (implemented by
 * `SelectBuilder`). It exposes the wire form (`toJSON`), the routing key
 * (`shape`), and the read-only lowering hook (`toRawInput`) — but none of the
 * fluent mutators, so a store cannot keep building on it. The IR algebra is
 * `IRSelectQuery`, produced on demand by `lower(query)`.
 */
export interface SelectQuery {
  readonly __queryKind: 'select';
  readonly shape: NodeShapeData;
  toJSON(): QueryBuilderJSON;
  toRawInput(): RawSelectInput;
}

/**
 * ###################################
 * #### TYPES FOR QUERY BUILDING  ####
 * ###################################
 */
export type JSPrimitive = JSNonNullPrimitive | null | undefined;
export type JSNonNullPrimitive = string | number | boolean | Date;

const isSameRef = (
  a?: NodeReferenceValue,
  b?: NodeReferenceValue,
): boolean => !!a && !!b && a.id === b.id;

export type SingleResult<ResultType> =
  ResultType extends Array<infer R>
    ? R
    : ResultType extends Set<infer R>
      ? R
      : ResultType;

/**
 * All the possible types that a regular get/set method of a Shape can return
 */
export type AccessorReturnValue =
  | Shape
  | ShapeSet
  | JSPrimitive
  | NodeReferenceValue;

export type WhereClause<S extends Shape | AccessorReturnValue> =
  | ExpressionNode
  | ExistsCondition
  | ((s: ToQueryBuilderObject<S>) => ExpressionNode | ExistsCondition);

export type QueryBuildFn<T extends Shape, ResponseType> = (
  p: ToQueryBuilderObject<T>,
) => ResponseType;

export type SortByPath = {
  paths: PropertyPath[];
  /** Per-path sort direction (parallel to `paths`). */
  directions: ('ASC' | 'DESC')[];
};

/**
 * A property-only query path, used by where/sort proxy tracing.
 */
export type QueryPropertyPath = QueryStep[];

/**
 * A QueryStep is a single step in a query path.
 */
export type QueryStep =
  | PropertyQueryStep
  | SizeStep
  | ShapeReferenceValue;
export type SizeStep = {
  count: QueryPropertyPath;
  label?: string;
};
export type PropertyQueryStep = {
  property: PropertyShapeData;
  where?: WherePath;
};

/**
 * Maps all the return types of get/set methods of a Shape and maps their return types to QueryBuilderObjects
 */
export type QueryShapeProps<
  T extends Shape,
  Source,
  Property extends string | number | symbol = any,
> = {
  [P in keyof T]: ToQueryBuilderObject<T[P], QShape<T, Source, Property>, P>;
};

export type SelectAllQueryResponse<T extends Shape> = Array<
  QueryShapeProps<T, null, ''>[Exclude<
    Extract<
      {
        [K in keyof T]-?: T[K] extends (...args: any[]) => any ? never : K;
      }[keyof T],
      string
    >,
    Extract<keyof Shape, string>
  >]
>;

/**
 * This type states that the ShapeSet has access to the same methods as the shape of all the items in the set
 * (this is enabled with the QueryShapeSet.proxifyShapeSet method)
 * Each value of the shape is converted to a QueryBuilderObject
 */
export type QueryShapeSetProps<SourceShapeSet, Shape> = {
  [P in keyof Shape]: ToQueryBuilderObject<Shape[P], SourceShapeSet, P>;
};

/**
 * ShapeSets are converted to QueryShapeSets, but also inherit all the properties of the shape that each item in the set has (with converted result types)
 */
export type QShapeSet<
  ShapeSetType extends Shape,
  Source = null,
  Property extends string | number | symbol = null,
> = QueryShapeSet<ShapeSetType, Source, Property> &
  QueryShapeSetProps<
    QueryShapeSet<ShapeSetType, Source, Property>,
    ShapeSetType
  >;

/**
 * Shapes are converted to QueryShapes, but also inherit all the properties of the shape (with converted result types)
 */
export type QShape<
  T extends Shape,
  Source = any,
  Property extends string | number | symbol = any,
> = QueryShape<T, Source, Property> & QueryShapeProps<T, Source, Property>;

export type ToQueryBuilderObject<
  T,
  Source = null,
  Property extends string | number | symbol = '',
> =
  T extends ShapeSet<infer ShapeSetType>
    ? QShapeSet<ShapeSetType, Source, Property>
    : T extends Shape
      ? QShape<T, Source, Property>
      : T extends string | number | Date | boolean
        ? ToQueryPrimitive<T, Source, Property>
        : // : QueryBuilderObject<T,Source,Property>;
          T extends Array<infer AT>
          ? AT extends Date | string | number
            ? QueryPrimitiveSet<ToQueryPrimitive<AT, Source, Property>>
            : AT extends boolean
              ? QueryPrimitive<boolean>
              : AT[]
          : //added support for get/set methods that return NodeReferenceValue, treating them as plain Shapes
            T extends NodeReferenceValue
            ? QShape<Shape, Source, Property>
            : QueryBuilderObject<T, Source, Property>;

export type ToQueryPrimitive<
  T extends string | number | Date | boolean,
  Source,
  Property extends string | number | symbol = '',
> = T extends string
  ? QueryPrimitive<string, Source, Property>
  : T extends number
    ? QueryPrimitive<number, Source, Property>
    : T extends Date
      ? QueryPrimitive<Date, Source, Property>
      : T extends boolean
        ? QueryPrimitive<boolean, Source, Property>
        : never & {__error: 'ToQueryPrimitive: no matching primitive type'};

export type WhereExpressionPath = {
  expressionNode: ExpressionNode;
};

export type WhereExistsPath = {
  existsCondition: ExistsCondition;
};

export type WherePath = WhereExpressionPath | WhereExistsPath;

/**
 * An argument can be a direct reference to a node, a js primitive (boolean,number), a path to resolve (like from a query context variables)
 * Or a wherePath in the case of some() or every() (e.g. x.where(x.friends.some(f => f.age > 18) -> the argument is a wherePath)
 */
export type QueryComponentLike<ShapeType extends Shape, CompQueryResult> = {
  query:
    | QueryBuilder<ShapeType>
    | FieldSet
    | Record<string, QueryBuilder<ShapeType>>;
  fields?: FieldSet;
};

/**
 * Interface that linked components (e.g. from `@_linked/react`'s `linkedComponent()`)
 * must satisfy to participate in preloadFor.
 *
 * Components expose their data requirements as a QueryBuilder,
 * and optionally a FieldSet for declarative field access.
 */
export interface LinkedComponentInterface<S extends Shape = Shape, R = any> {
  /** The component's data query (QueryBuilder template, not executed). */
  query: QueryBuilder<S, any, R>;
  /** The component's field requirements as a FieldSet. */
  fields?: FieldSet;
}

/**
 * ###################################
 * ####    QUERY RESULT TYPES     ####
 * ###################################
 */

export type QResult<ShapeType extends Shape = Shape, Object = {}> = Object & {
  id: string;
  // shape?: ShapeType;
};

/**
 * MAIN ENTRY to convert the response of a query into a result object
 */
export type QueryResponseToResultType<
  T,
  QShapeType extends Shape = null,
  HasName = false,
> = T extends QueryBuilderObject
  ? GetQueryObjectResultType<T, {}, false, HasName>
  : T extends FieldSet<infer Response, infer Source>
    ? GetNestedQueryResultType<Response, Source>
    : T extends Array<infer Type>
      ? UnionToIntersection<QueryResponseToResultType<Type>>
      : T extends ExpressionNode
        ? boolean
        : T extends Object
          ? QResult<QShapeType, Prettify<ObjectToPlainResult<T>>>
          : never & {__error: 'QueryResponseToResultType: unmatched query response type'};

/**
 * Turns a QueryBuilderObject into a plain JS object
 * @param QV the query value type
 * @param SubProperties to add extra properties into the result object (used to merge arrays into objects for example)
 * @param SourceOverwrite if the source of the query value should be overwritten
 */
export type GetQueryObjectResultType<
  QV,
  SubProperties = {},
  PrimitiveArray = false,
  HasName = false,
> =
  //note: count needs to be above primitive
  QV extends SetSize<infer Source>
    ? SetSizeToQueryResult<Source, HasName>
    : QV extends QueryPrimitive<infer Primitive, infer Source, infer Property>
      ? CreateQResult<
          Source,
          PrimitiveArray extends true ? Primitive[] : Primitive,
          Property,
          {},
          HasName
        >
      : QV extends QueryShape<infer ShapeType, infer Source, infer Property>
        ? CreateQResult<Source, ShapeType, Property, SubProperties, HasName>
        : QV extends BoundComponent<infer Source, infer CompQueryResult>
          ? GetQueryObjectResultType<
              Source,
              SubProperties & QueryResponseToResultType<CompQueryResult>,
              PrimitiveArray,
              HasName
            >
          : QV extends QueryShapeSet<
              infer ShapeType,
              infer Source,
              infer Property
            >
            ? CreateShapeSetQResult<
                ShapeType,
                Source,
                Property,
                SubProperties,
                HasName
              >
            : QV extends QueryPrimitiveSet<
                  infer QPrim extends QueryPrimitive<any>
                >
              ? GetQueryObjectResultType<QPrim, null, null, true>
              : QV extends Array<infer Type>
                ? UnionToIntersection<QueryResponseToResultType<Type>>
                : QV extends QueryPrimitive<boolean, any, any>
                  ? 'bool'
                  : never & {__error: 'GetQueryObjectResultType: unmatched query value type'};

export type SetSizeToQueryResult<Source, HasName = false> =
  Source extends QueryShapeSet<
    infer ShapeType,
    infer ParentSource,
    infer SourceProperty
  >
    ? HasName extends false
      ? //when we count something and we already know what the name of the variable of the resulting number is, then we return a number
        //But if we count a shapeset and its NOT in a custom object where a key (name) is already known, then we return a QResult
        //This QResult will be the same as it would be if there was no .count() statement. Except now it returns a number (hence we send number as value type)
        CreateQResult<ParentSource, number, SourceProperty>
      : number
    : number;

/**
 * If the source is an object (it extends shape)
 * then the result is a plain JS Object, with Property as its key, with type Value
 */
export type CreateQResult<
  Source,
  Value = undefined,
  Property extends string | number | symbol = '',
  SubProperties = {},
  HasName = false,
> =
  Source extends QueryShape<
    infer SourceShapeType,
    infer ParentSource,
    infer SourceProperty
  >
    ? //if the parent source is null, that means this is the final source-node in the query
      ParentSource extends null
      ? HasName extends true
        ? Value
        : //TODO: this must be simplified and rewritten
          // it is likely the most complex part of the type system currently
          // It turns out that sub-.select() on a QueryShapeSet ends up here with Value being null, and sub properties need to be added to the QResult itself
          // Whilst sub-.select() on a single QueryShape ends up here with Value being defined, in which case the SubProperties need to be included in the inner QResult
          Value extends null
          ? //hence we create a single QResult, but do not use CreateQResult (which will keep creating nested QResults)
            QResult<
              SourceShapeType,
              {
                //we pass Value and Value but not Property, so that when the value is a Shape or ShapeSet, there is recursion
                //but for all other cases (like string, number, boolean) the value is just passed through
                [P in Property]: CreateQResult<Value, Value>;
              } & SubProperties
            >
          : //hence we create a single QResult, but do not use CreateQResult (which will keep creating nested QResults)
            QResult<
              SourceShapeType,
              {
                //we pass Value and Value but not Property, so that when the value is a Shape or ShapeSet, there is recursion
                //but for all other cases (like string, number, boolean) the value is just passed through
                [P in Property]: CreateQResult<Value, Value, '', SubProperties>;
              }
            >
      : CreateQResult<
          ParentSource,
          QResult<
            SourceShapeType,
            {
              //we pass Value and Value but not Property, so that when the value is a Shape or ShapeSet, there is recursion
              //but for all other cases (like string, number, boolean) the value is just passed through
              [P in Property]: CreateQResult<Value, Value>;
            } & SubProperties
          >,
          SourceProperty,
          {},
          HasName
        >
    : Source extends QueryShapeSet<
          infer ShapeType,
          infer ParentSource,
          infer SourceProperty
        >
      ? //for a ShapeSet, we make the current result (a QResult) the value of a parent QResult (created with ToQueryResult)
        CreateQResult<
          ParentSource,
          QResult<
            ShapeType,
            {
              //we pass Value and Value but not Property, so that when the value is a Shape or ShapeSet, there is recursion
              //but for all other cases (like string, number, boolean) the value is just passed through
              [P in Property]: CreateQResult<Value, Value, null, SubProperties>;
            }
          >[],
          SourceProperty,
          {},
          HasName
        >
      : //Source is not a QueryShape or QueryShape set (currently sometimes used by end QueryPrimitives) ..
        // this needs to convert to value (amongst other things) for .select({customKeys}) and ObjectToPlainResult
        Value extends Shape
        ? QResult<Value, SubProperties>
        : // : Value extends boolean ? 'boolean' : Value;
          NormaliseBoolean<Value>;

type NormaliseBoolean<T> = [T] extends [boolean] ? boolean : T;

export type CreateShapeSetQResult<
  ShapeType = undefined,
  Source = undefined,
  Property extends string | number | symbol = '',
  SubProperties = {},
  HasName = false,
> =
  Source extends QueryShape<infer SourceShapeType, infer ParentSource>
    ? //if HasName is true and source is a QueryShape, but ITS source (ParentSource) is null
      //then we don't want to create a nested QResult, but instead we ignore this last property and we return an array of QResults of this source
      //This is used by custom object keys with values like: p.friends, which should return an array of QResult<Person> Objects, not a {friends:...} QResult
      //NOTE: this notation check if 2 statements are true: HasName is true, and ParentSource is null
      [HasName, ParentSource] extends [true, null]
      ? CreateQResult<Source, null, null>[]
      : ParentSource extends null
        ? QResult<
            SourceShapeType,
            {[P in Property]: CreateQResult<Source, null, null, SubProperties>[]}
          >
        : //when ParentSource is not null, we need to continue unwinding the source chain
          //Pass the inner ShapeSet items as SubProperties so they stay at the correct nesting level
          CreateQResult<
            Source,
            null,
            null,
            {[P in Property]: (ShapeType extends Shape ? QResult<ShapeType, SubProperties> : QResult<Shape, SubProperties>)[]}
          >
    : Source extends QueryShapeSet<
          infer ShapeType,
          infer ParentSource,
          infer SourceProperty
        >
      ? //for a shapeset source, we make the current result (a QResult) the value of a parent QResult (created with ToQueryResult)
        CreateQResult<
          ParentSource,
          QResult<
            ShapeType,
            {
              [P in Property]: CreateQResult<ShapeType>[];
            }
          >[],
          SourceProperty,
          {},
          HasName
        >
      : CreateQResult<ShapeType>;

/**
 * Ignores the source and property, and returns the converted value
 */
export type ObjectToPlainResult<T> = {
  //passing true as sourceOverwrite will mean that the original source is ignored and so the converted value will not be wrapped in a QResult
  // [P in keyof T]: QueryResponseToResultType<T[P], null, true>;
  [P in keyof T]: QueryResponseToResultType<T[P], null, true>;
};

type GetNestedQueryResultType<Response, Source> =
  Source extends QueryBuilderObject
    ? //if the linked query originates from within another query (like with select())
      //then we turn the source into a result. And then pass the selected properties as "SubProperties"
      //regardless of whether the response type is an array or object, it gets converted into a result value object
      GetQueryObjectResultType<Source, QueryResponseToResultType<Response>>
    : //by default: we just convert the response type into a result value object
      QueryResponseToResultType<Response>[];

//https://stackoverflow.com/a/50375286/977206
type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;


/**
 * ###################################
 * ####  QUERY BUILDING CLASSES   ####
 * ###################################
 */

export class QueryBuilderObject<
  OriginalValue = any,
  Source = any,
  Property extends string | number | symbol = any,
> {
  //is null by default to avoid warnings when trying to access wherePath when its undefined
  wherePath?: WherePath = null;
  protected originalValue?: OriginalValue;
  protected source: Source;
  protected prop: Property;

  constructor(
    public property?: PropertyShapeData,
    public subject?: QueryShape<any> | QueryShapeSet<any> | QueryPrimitiveSet,
  ) {}

  /**
   * Create a Query Builder Object based on the requested PropertyShapeData
   */
  static generatePathValue(
    // originalValue: AccessorReturnValue,
    property: PropertyShapeData,
    subject: QueryShape<any> | QueryShapeSet<any> | QueryShape<any>,
  ): QueryBuilderObject {
    let datatype = property.datatype;
    let valueShape = property.valueShape;
    let singleValue = property.maxCount <= 1;
    if (datatype) {
      if (singleValue) {
        if (isSameRef(datatype, xsd.integer)) {
          return wrapWithExpressionProxy(new QueryPrimitive<number>(0, property, subject));
        } else if (isSameRef(datatype, xsd.boolean)) {
          return wrapWithExpressionProxy(new QueryPrimitive<boolean>(false, property, subject));
        } else if (
          isSameRef(datatype, xsd.dateTime) ||
          isSameRef(datatype, xsd.date)
        ) {
          return wrapWithExpressionProxy(new QueryPrimitive<Date>(new Date(), property, subject));
        } else if (isSameRef(datatype, xsd.string)) {
          return wrapWithExpressionProxy(new QueryPrimitive<string>('', property, subject));
        }
      } else {
        //TODO review this, do we need property & subject in both of these? currently yes, but why
        return new QueryPrimitiveSet([''], property, subject, [
          new QueryPrimitive<string>('', property, subject),
        ]);
      }
    }
    if (valueShape) {
      // Same as MutationQuery: fall back to the metadata-derived constructor so a
      // project-authored shape resolves as a value shape too.
      const shapeClass =
        getShapeClass(valueShape) ?? getOrCreateShapeAdapter(valueShape.id);
      if(!shapeClass) {
        //TODO: getShapeClassAsync -> which will lazy load the shape class
        // but Im not sure if that's even possible with dynamic import paths, that are only known at runtime
        //UPDATE: we should not need to load shapeclasses. We just need to be able to access shapes.
        // but the problem remains that the ImageObject shape needs to be available, but thats easier, as its data
        throw new Error(`Shape class not found for ${valueShape.id}`);
      }
      const shapeValue = createShapeTarget(shapeClass);
      if (singleValue) {
        return QueryShape.create(shapeValue, property, subject);
      } else {
        return QueryShapeSet.create(
          new ShapeSet([shapeValue]),
          property,
          subject,
        );
      }
    }

    //no value shape and no data type.
    //Lets look at the node kind
    if (
      isSameRef(property.nodeKind, shacl.Literal) ||
      isSameRef(property.nodeKind, shacl.BlankNodeOrLiteral)
    ) {
      if (singleValue) {
        //default to string if no datatype is set
        return wrapWithExpressionProxy(new QueryPrimitive<string>('', property, subject));
      } else {
        //TODO review this, do we need property & subject in both of these? currently yes, but why
        return new QueryPrimitiveSet([''], property, subject, [
          new QueryPrimitive<string>('', property, subject),
        ]);
      }
    }

    // An object-valued property with no value shape and a non-Literal node kind
    // (e.g. `sh:path` — a raw predicate IRI, or any bare IRI reference). Project
    // it as a generic node reference via the base `Shape`, so the query returns
    // the value's IRI `{id}` — identical to how a *shaped* object property
    // resolves (cf. `sh:targetClass`, registered `shape: Shape`). This lets the
    // DSL read raw IRI predicates back out of a store (SHACL shape catalog etc.).
    //
    // NOTE: a polymorphic value (an `rdf:List` sequence path or a `PathNode`
    // operator) resolves to its *node reference* here, not its structure. Full
    // structural projection ("if List → members, if PathNode → operands") is the
    // `byShape` polymorphic-projection follow-up — see
    // packages/core/docs/backlog/031-byshape-polymorphic-projection.md.
    // Build a constructor-less generic node-reference target on the base `Shape`
    // (like the `valueShape` branch above, but for the shapeless base). `Shape`'s
    // constructor throws, so we use `createShapeTarget` (Object.create) — the
    // target is only a proxy metadata carrier, never a live instance.
    const genericShape = createShapeTarget(Shape);
    return singleValue
      ? QueryShape.create(genericShape, property, subject)
      : QueryShapeSet.create(new ShapeSet([genericShape]), property, subject);
  }

  getOriginalValue() {
    return this.originalValue;
  }

  getPropertyStep(): QueryStep {
    return {
      property: this.property,
      where: this.wherePath,
    };
  }

  preloadFor<ShapeType extends Shape, CompQueryRes>(
    component: QueryComponentLike<ShapeType, CompQueryRes>,
  ): BoundComponent<this, CompQueryRes> {
    return new BoundComponent<this, CompQueryRes>(component, this);
  }

  /**
   * Pagination is applied to a nested *select*, not to a bare traversal — use
   * `p.friends.select(f => f.name).limit(n)`. Calling `.limit()` directly on a
   * traversal would silently do nothing, so we fail loudly instead.
   * (Top-level result pagination lives on the outer query builder.)
   */
  limit(lim: number): never {
    throw new Error(
      `.limit(${lim}) is not supported directly on a traversal — use ` +
      '.select(...).limit(n) on the nested collection (single-subject queries only).',
    );
  }

  /**
   * Returns the path of properties that were requested to reach this value
   */
  getPropertyPath(currentPath?: QueryPropertyPath): QueryPropertyPath {
    let path: QueryPropertyPath = currentPath || [];
    //add the step of this object to the beginning of the path (so that the next parent will always before the current item)
    if (this.property || this.wherePath) {
      path.unshift(this.getPropertyStep());
    }
    if (this.subject) {
      return this.subject.getPropertyPath(path);
    }
    //when query context is used as the first step, then the first step is just a pointer to the subject it represents
    if ((this.originalValue as Shape)?.__queryContextId) {
      path.unshift(convertQueryContext(this as any as QueryShape));
    }
    return path;
  }
}

export class BoundComponent<
  Source extends QueryBuilderObject,
  CompQueryResult = any,
> extends QueryBuilderObject {
  constructor(
    public originalValue: QueryComponentLike<any, CompQueryResult>,
    public source: Source,
  ) {
    super(null, null);
  }

}

/**
 * Converts query context to a ShapeReferenceValue
 */
const convertQueryContext = (shape: QueryShape): ShapeReferenceValue => {
  return {
    id: (shape.originalValue as Shape).__queryContextId,
    shape: {
      id: shape.originalValue.nodeShape.id,
    },
  } as ShapeReferenceValue;
};

export const processWhereClause = (
  validation: WhereClause<any>,
  shape?,
): WherePath => {
  if (validation instanceof Function) {
    if (!shape) {
      throw new Error('Cannot process where clause without shape');
    }
    const proxy = createProxiedPathBuilder(shape);
    const result = validation(proxy);
    if (isExpressionNode(result)) {
      return {expressionNode: result};
    }
    if (isExistsCondition(result)) {
      return {existsCondition: result};
    }
    throw new Error('WHERE callback must return ExpressionNode or ExistsCondition');
  } else if (isExpressionNode(validation)) {
    return {expressionNode: validation};
  } else if (isExistsCondition(validation)) {
    return {existsCondition: validation};
  } else {
    throw new Error('WHERE clause must be ExpressionNode, ExistsCondition, or a callback');
  }
};

// ---------------------------------------------------------------------------
// Expression method proxy for QueryPrimitive
// ---------------------------------------------------------------------------

const EXPRESSION_METHODS = new Set([
  'plus', 'minus', 'times', 'divide', 'abs', 'round', 'ceil', 'floor', 'power',
  'equals', 'eq', 'neq', 'notEquals', 'gt', 'greaterThan', 'gte', 'greaterThanOrEqual',
  'lt', 'lessThan', 'lte', 'lessThanOrEqual', 'oneOf', 'notOneOf',
  'concat', 'contains', 'startsWith', 'endsWith', 'substr', 'before', 'after',
  'replace', 'ucase', 'lcase', 'strlen', 'encodeForUri', 'matches',
  'year', 'month', 'day', 'hours', 'minutes', 'seconds', 'timezone', 'tz',
  'and', 'or', 'not',
  'isDefined', 'isNotDefined', 'defaultTo',
  'lang', 'datatype', 'str', 'iri', 'isIri', 'isLiteral', 'isBlank', 'isNumeric',
  'md5', 'sha256', 'sha512',
]);

/**
 * Convert a QueryBuilderObject to a traced ExpressionNode by extracting its
 * property path segments and creating a property expression reference.
 * This is the bridge between the query proxy world and the expression IR world.
 */
function toExpressionNode(qbo: QueryBuilderObject): ExpressionNode {
  // Check if this is a query context reference. We carry the context *name*
  // (not the resolved id): it serializes as `{@ctx}` and is resolved by `lower()`.
  const contextName = findContextName(qbo);
  if (contextName) {
    const segments = FieldSet.collectPropertySegments(qbo);
    if (segments.length > 0) {
      // Context property access (e.g. getQueryContext('user').name) → context_property_expr
      const lastSegment = segments[segments.length - 1].id;
      const ir = {kind: 'context_property_expr' as const, contextName, property: lastSegment};
      return new ExpressionNode(ir);
    }
    // Context root reference (e.g. getQueryContext('user')) → reference_expr
    const ir = {kind: 'reference_expr' as const, contextName};
    return new ExpressionNode(ir);
  }

  const segments = FieldSet.collectPropertySegments(qbo);
  if (segments.length === 0) {
    // Root shape or entity reference — produce alias expression (the entity itself)
    return tracedAliasExpression([]);
  }
  const segmentIds = segments.map((s) => s.id);
  return tracedPropertyExpression(segmentIds);
}

/** Walk up the QueryBuilderObject chain to find a query context *name* (for `{@ctx}`). */
function findContextName(qbo: QueryBuilderObject): string | undefined {
  let current: QueryBuilderObject | undefined = qbo;
  while (current) {
    if (current instanceof QueryShape && (current.originalValue as any)?.__queryContextName) {
      return (current.originalValue as any).__queryContextName;
    }
    current = current.subject as QueryBuilderObject | undefined;
  }
  return undefined;
}

/**
 * A wrapper for inline `.where()` on primitives that produces alias-based expressions.
 * When `p.hobby.where(h => h.equals('Jogging'))` is called, `h` should reference
 * the hobby variable itself (alias), not traverse to a sub-property.
 */
class InlineWhereProxy extends QueryBuilderObject {
  constructor(public readonly source: QueryPrimitive<any>) {
    super(source.property, source.subject);
  }

  equals(otherValue: any): ExpressionNode {
    // Empty traversal = "the current alias" — resolved by lowering
    // against the property's own alias scope
    const self = tracedAliasExpression([]);
    return self.eq(otherValue);
  }
}

/**
 * Wrap a QueryPrimitive in a Proxy that intercepts expression method calls.
 * When an expression method (e.g., `.plus()`, `.gt()`, `.equals()`) is accessed,
 * creates a traced ExpressionNode based on the QueryPrimitive's property path.
 */
function wrapWithExpressionProxy<T>(qp: QueryPrimitive<T>): QueryPrimitive<T> {
  return new Proxy(qp, {
    get(target, key, receiver) {
      if (typeof key === 'string' && EXPRESSION_METHODS.has(key)) {
        const segments = FieldSet.collectPropertySegments(target);
        // Only intercept if we have valid property segments to trace
        if (segments.length > 0) {
          // Use toExpressionNode so a context property as the *self* of an
          // expression (e.g. getQueryContext('user').name.equals(x)) becomes a
          // context_property_expr, not a root-entity property_expr.
          const baseNode = toExpressionNode(target as unknown as QueryBuilderObject);
          return (...args: any[]) => {
            // Convert QueryBuilderObject arguments to ExpressionNode
            const convertedArgs = args.map((arg) =>
              arg instanceof QueryBuilderObject ? (toExpressionNode(arg) ?? arg) : arg,
            );
            return (baseNode as any)[key](...convertedArgs);
          };
        }
      }
      return Reflect.get(target, key, receiver);
    },
  }) as QueryPrimitive<T>;
}

/**
 * Evaluate a sort callback through the proxy and extract a SortByPath.
 * This is a standalone helper that replaces the need for the former SelectQueryFactory.sortBy().
 */
export const evaluateSortCallback = <S extends Shape>(
  shape: ShapeConstructor<S>,
  sortFn: (p: any) => any,
  direction: 'ASC' | 'DESC' = 'ASC',
): SortByPath => {
  const proxy = createProxiedPathBuilder(shape);
  const response = sortFn(proxy);
  const nodeShape = shape.shape;
  const paths: PropertyPath[] = [];
  if (response instanceof QueryBuilderObject || response instanceof QueryPrimitiveSet) {
    paths.push(new PropertyPath(nodeShape, FieldSet.collectPropertySegments(response)));
  } else if (Array.isArray(response)) {
    for (const item of response) {
      if (item instanceof QueryBuilderObject) {
        paths.push(new PropertyPath(nodeShape, FieldSet.collectPropertySegments(item)));
      }
    }
  }
  // The DSL callback carries a single direction for all its paths; per-path
  // directions come from the wire form (deserializeSortByPath).
  return {paths, directions: paths.map(() => direction)};
};

export class QueryShapeSet<
  S extends Shape = Shape,
  Source = any,
  Property extends string | number | symbol = any,
> extends QueryBuilderObject<ShapeSet<S>, Source, Property> {
  public queryShapes: CoreSet<QueryShape>;
  private proxy;

  constructor(
    _originalValue?: ShapeSet<S>,
    property?: PropertyShapeData,
    subject?: QueryShape<any> | QueryShapeSet<any>,
  ) {
    super(property, subject);
    this.originalValue = _originalValue;

    //Note that QueryShapeSet intentionally does not store the _originalValue shape set, because it manipulates this.queryShapes
    // and then recreates the original shape set when getOriginalValue() is called
    this.queryShapes = new CoreSet(
      _originalValue?.map((shape) =>
        QueryShape.create(shape, property, subject),
      ),
    );
  }

  static create<S extends Shape = Shape>(
    originalValue: ShapeSet<S>,
    property: PropertyShapeData,
    subject: QueryShape<any> | QueryShapeSet<any>,
  ) {
    let instance = new QueryShapeSet<S>(originalValue, property, subject);

    let proxy = this.proxifyShapeSet<S>(instance);
    return proxy;
  }

  static proxifyShapeSet<T extends Shape = Shape>(
    queryShapeSet: QueryShapeSet<T>,
  ) {
    let originalShapeSet = queryShapeSet.getOriginalValue();

    queryShapeSet.proxy = new Proxy(queryShapeSet, {
      get(target, key, receiver) {
        //if the key is a string
        if (typeof key === 'string') {
          //if this is a get method that is implemented by the QueryShapeSet, then use that
          if (key in queryShapeSet) {
            //if it's a function, then bind it to the queryShape and return it so it can be called
            if (typeof queryShapeSet[key] === 'function') {
              return target[key].bind(target);
            }
            //if it's a get method, then return that
            //NOTE: we may not need this if we don't use any get methods in QueryValue classes?
            return queryShapeSet[key];
          }

          //if not, then a method/accessor was called that likely fits with the methods of the original SHAPE of the items in the shape set
          //As in Shape.friends.name -> key would be name, which is requested from (each item in!) a ShapeSet of Shapes
          //So here we find back the shape that all items have in common, and then find the property shape that matches the key
          //NOTE: this will only work if the key corresponds with an accessor in the shape that uses a @linkedProperty decorator
          let leastSpecificShape = queryShapeSet
            .getOriginalValue()
            .getLeastSpecificShape();
          let valueShape = leastSpecificShape ? leastSpecificShape.shape : null;
          if (!valueShape && queryShapeSet.property?.valueShape) {
            const shapeClass = getShapeClass(queryShapeSet.property.valueShape);
            valueShape = shapeClass?.shape;
          }
          let propertyShape: PropertyShapeData = valueShape
            ? getPropertyShapes(valueShape, true).find(
                (propertyShape) => propertyShape.label === key,
              )
            : undefined;

          //if the property shape is found
          if (propertyShape) {
            return queryShapeSet.callPropertyShapeAccessor(propertyShape);
          } else if (
            //else if a genuine collection method of the ShapeSet is called
            //(.forEach()/.map()/… — including symbol methods like iteration)
            originalShapeSet[key] &&
            typeof originalShapeSet[key] === 'function'
          ) {
            //then return that method and bind the original value as 'this'
            return originalShapeSet[key].bind(originalShapeSet);
          } else if (typeof key === 'string' && !INTEROP_PASSTHROUGH_KEYS.has(key)) {
            // Same policy as the single-node proxy: an undecorated string key
            // is a genuine misuse (it would silently return a broken path over
            // the set → silently-wrong results). Throw. Interop/framework keys
            // and symbols pass through.
            throw new Error(
              `${valueShape?.label ?? 'shape'}.${key} is accessed in a query, but it does not have a @linkedProperty decorator. Queries can only access decorated get/set methods (@objectProperty / @literalProperty).`,
            );
          }
        }
        //otherwise return the value of the property on the original shape
        return originalShapeSet[key];
      },
    });
    return queryShapeSet.proxy;
  }

  as<ShapeClass extends typeof Shape>(
    shape: ShapeClass,
  ): QShapeSet<InstanceType<ShapeClass>, Source, Property> {
    //if the shape is not the same as the original value, then we need to create a new query shape
    // `getLeastSpecificShape()` is `undefined` for an empty set; `?.` avoids a
    // TypeError and `nodeShapeEquals(_, undefined)` is false, so we rebuild as needed.
    if (!nodeShapeEquals(shape.shape, this.originalValue.getLeastSpecificShape()?.shape)) {
      let newOriginal = new ShapeSet(
        this.originalValue.map((existing) =>
          createShapeTarget(shape as any, existing?.id),
        ),
      );
      return QueryShapeSet.create(
        newOriginal,
        this.property,
        this.subject as any,
      );
    }
    // else return this
    return this as any as QShapeSet<InstanceType<ShapeClass>, Source, Property>;
  }

  add(item) {
    this.queryShapes.add(item);
  }

  concat(other: QueryShapeSet): QueryShapeSet {
    if (other) {
      if (other instanceof QueryShapeSet) {
        (other as QueryShapeSet).queryShapes.forEach(
          this.queryShapes.add.bind(this.queryShapes),
        );
      } else {
        throw new Error('Unknown type: ' + other);
      }
    }
    return this;
  }

  getOriginalValue() {
    return new ShapeSet(
      this.queryShapes.map((shape) => {
        return shape.originalValue;
      }),
    ) as ShapeSet<S>;
  }

  callPropertyShapeAccessor(
    propertyShape: PropertyShapeData,
  ): QueryShapeSet | QueryPrimitiveSet {
    //call the get method for that property shape on each item in the shape set
    //and return the result as a new shape set
    let result: QueryPrimitiveSet | QueryShapeSet; //QueryValueSetOfSets;

    //if we expect the accessor to return a Primitive (string,number,boolean,Date)
    if (isSameRef(propertyShape.nodeKind, shacl.Literal)) {
      //then return a Set of QueryPrimitives
      result = new QueryPrimitiveSet(null, propertyShape, this);
    } else {
      // result = QueryValueSetOfSets.create(propertyShape, this); //QueryShapeSet.create(null, propertyShape, this);
      result = QueryShapeSet.create(null, propertyShape, this);
    }
    let expectSingleValues =
      typeof propertyShape.maxCount === 'number' && propertyShape.maxCount <= 1;

    this.queryShapes.forEach((shape) => {
      //access the propertyShapes accessor,
      // since the shape should already be converted to a QueryShape, the result is a QueryValue also
      let shapeQueryValue = shape[propertyShape.label];

      //only add results if something was actually returned, if the property is not defined for this shape the result can be undefined
      if (shapeQueryValue) {
        if (expectSingleValues) {
          (result as any).add(shapeQueryValue);
        } else {
          //if each of the shapes in a set return a new shapeset for the request accessor
          //then we merge all the returned values into a single shapeset
          (result as QueryShapeSet).concat(shapeQueryValue);
        }
      }
    });
    return result;
  }

  //countable?, resultKey?: string
  size(): SetSize<this> {
    //when count() is called we want to count the number of items in the entire query path
    return new SetSize(this); //countable, resultKey
  }

  // get testItem() {}
  where(validation: WhereClause<S>): this {
    if (
      (this.getPropertyPath() as QueryStep[]).some(
        (step) => (step as PropertyQueryStep).where,
      )
    ) {
      throw new Error(
        'You cannot call where() from within a where() clause. Consider using some() or every() instead',
      );
    }
    let leastSpecificShape = this.getOriginalValue().getLeastSpecificShape();
    this.wherePath = processWhereClause(validation, leastSpecificShape);
    //return this.proxy because after Shape.friends.where() we can call other methods of Shape.friends
    //and for that we need the proxy
    return this.proxy;
  }

  select<QF = unknown>(
    subQueryFn: QueryBuildFn<S, QF>,
  ): FieldSet<QF, QueryShapeSet<S, Source, Property>> {
    const leastSpecificShape = this.getOriginalValue().getLeastSpecificShape();
    const parentSegments = FieldSet.collectPropertySegments(this);
    const fs = FieldSet.forSubSelect<QF, QueryShapeSet<S, Source, Property>>(
      leastSpecificShape,
      subQueryFn as any,
      parentSegments,
      this,
    );
    return fs;
  }

  selectAll(): FieldSet<
    SelectAllQueryResponse<S>,
    QueryShapeSet<S, Source, Property>
  > {
    let leastSpecificShape = this.getOriginalValue().getLeastSpecificShape();
    const propertyLabels = getUniquePropertyShapes(leastSpecificShape.shape)
      .map((propertyShape) => propertyShape.label);
    return this.select((shape) =>
      propertyLabels.map((label) => (shape as any)[label]),
    );
  }

  some(validation: WhereClause<S>): ExistsCondition {
    const predicate = this.buildPredicateExpression(validation);
    const pathSegmentIds = FieldSet.collectPropertySegments(this).map(s => s.id);
    return new ExistsCondition(pathSegmentIds, predicate, false);
  }

  every(validation: WhereClause<S>): ExistsCondition {
    // every(fn) = NOT EXISTS(path WHERE NOT(fn))
    const predicate = this.buildPredicateExpression(validation);
    const pathSegmentIds = FieldSet.collectPropertySegments(this).map(s => s.id);
    return new ExistsCondition(pathSegmentIds, predicate.not(), true);
  }

  none(validation: WhereClause<S>): ExistsCondition {
    // none(fn) = NOT EXISTS(path WHERE fn) = some(fn).not()
    const predicate = this.buildPredicateExpression(validation);
    const pathSegmentIds = FieldSet.collectPropertySegments(this).map(s => s.id);
    return new ExistsCondition(pathSegmentIds, predicate, true);
  }

  private buildPredicateExpression(validation: WhereClause<S>): ExpressionNode {
    const leastSpecificShape = this.getOriginalValue().getLeastSpecificShape();
    if (validation instanceof Function) {
      const proxy = createProxiedPathBuilder(leastSpecificShape) as any;
      const result = validation(proxy);
      if (isExpressionNode(result)) {
        return result;
      }
      throw new Error('Validation callback must return an ExpressionNode or ExistsCondition');
    }
    if (isExpressionNode(validation)) {
      return validation;
    }
    throw new Error('Expected a callback or ExpressionNode for some/every/none');
  }
}

export class QueryShape<
  S extends Shape = Shape,
  Source = any,
  Property extends string | number | symbol = any,
> extends QueryBuilderObject<S, Source, Property> {
  private proxy;

  constructor(
    public originalValue: S,
    property?: PropertyShapeData,
    subject?: QueryShape<any> | QueryShapeSet<any>,
  ) {
    super(property, subject);
  }

  get id() {
    return (
      (this.originalValue as Shape).__queryContextId ||
      this.originalValue['id']
    );
  }

  static create(
    original: Shape,
    property?: PropertyShapeData,
    subject?: QueryShape<any> | QueryShapeSet<any>,
  ) {
    let instance = new QueryShape(original, property, subject);
    let proxy = this.proxifyQueryShape(instance);
    return proxy;
  }

  private static proxifyQueryShape<T extends Shape>(queryShape: QueryShape<T>) {
    let originalShape = queryShape.originalValue;
    queryShape.proxy = new Proxy(queryShape, {
      get(target, key, receiver) {
        //if the key is a string
        if (typeof key === 'string') {
          //if this is a get method that is implemented by the QueryShape, then use that
          if (key in queryShape) {
            //if it's a function, then bind it to the queryShape and return it so it can be called
            if (typeof queryShape[key] === 'function') {
              return target[key].bind(target);
            }
            //if it's a get method, then return that
            //NOTE: we may not need this if we don't use any get methods in QueryValue classes?
            return queryShape[key];
          }

          //if not, then a method/accessor of the original shape was called
          //then check if we have indexed any property shapes with that name for this shapes NodeShapeData
          //NOTE: this will only work with a @linkedProperty decorator
          let propertyShape = getPropertyShapeByLabel(
            originalShape.constructor as typeof Shape,
            key,
          );
          if (propertyShape) {
            return QueryBuilderObject.generatePathValue(propertyShape, target);
          }
        }
        // A string key that is neither a QueryShape member nor a decorated
        // property is a genuine misuse: it would silently return the raw value
        // and the query would run with a broken path (silently-wrong results).
        // Throw. Symbols and framework/interop keys pass through untouched so
        // promise-awaiting, React, and serializers can still introspect the proxy.
        if (typeof key === 'string' && !INTEROP_PASSTHROUGH_KEYS.has(key)) {
          throw new Error(
            `${originalShape.constructor.name}.${key} is accessed in a query, but it does not have a @linkedProperty decorator. Queries can only access decorated get/set methods (@objectProperty / @literalProperty).`,
          );
        }
        return originalShape[key];
      },
    });
    return queryShape.proxy;
  }

  as<ShapeClass extends typeof Shape>(
    shape: ShapeClass,
  ): QShape<InstanceType<ShapeClass>, Source, Property> {
    //if the shape is not the same as the original value, then we need to create a new query shape
    if (!nodeShapeEquals(shape.shape, this.originalValue.nodeShape)) {
      const newOriginal = createShapeTarget(shape as any, this.originalValue.id);
      return QueryShape.create(newOriginal, this.property, this.subject as any);
    }
    return this as any as QShape<InstanceType<ShapeClass>, Source, Property>;
  }

  equals(otherValue: NodeReferenceValue | QShape<any> | PendingQueryContext): ExpressionNode {
    const self = toExpressionNode(this);
    // An unresolved query-context reference (`getQueryContext('user')` before it
    // is set) carries no `.id` yet — keep it as a `{@ctx}` ref, resolved at lower.
    if (otherValue instanceof PendingQueryContext) {
      return self.eq(otherValue as any);
    }
    //validate the value is formed correctly
    if(!otherValue.id) {
      throw Error(`Invalid value for .equals(). ${JSON.stringify(otherValue)}`);
    }
    const arg = otherValue instanceof QueryBuilderObject
      ? toExpressionNode(otherValue)
      : otherValue;
    return self.eq(arg as any);
  }

  oneOf(values: (NodeReferenceValue | QShape<any>)[]): ExpressionNode {
    return toExpressionNode(this).oneOf(
      values.map((v) => (v instanceof QueryBuilderObject ? toExpressionNode(v) : v)) as any,
    );
  }
  notOneOf(values: (NodeReferenceValue | QShape<any>)[]): ExpressionNode {
    return toExpressionNode(this).notOneOf(
      values.map((v) => (v instanceof QueryBuilderObject ? toExpressionNode(v) : v)) as any,
    );
  }

  select<QF = unknown>(
    subQueryFn: QueryBuildFn<S, QF>,
  ): FieldSet<QF, QueryShape<S, Source, Property>> {
    // A sub-select on a project-authored value shape has no authored class, so fall
    // back to the metadata-derived constructor. Without it this returned undefined and
    // FieldSet.forSubSelect failed reading `.shape` off it, far from the cause.
    const leastSpecificShape = resolveShapeForQuery(
      (this.getOriginalValue() as Shape).nodeShape.id,
    );
    const parentSegments = FieldSet.collectPropertySegments(this);
    const fs = FieldSet.forSubSelect<QF, QueryShape<S, Source, Property>>(
      leastSpecificShape,
      subQueryFn as any,
      parentSegments,
      this,
    );
    return fs;
  }

  selectAll(): FieldSet<
    SelectAllQueryResponse<S>,
    QueryShape<S, Source, Property>
  > {
    // Same as `select()` above: runtime shapes resolve through the adapter.
    let leastSpecificShape = resolveShapeForQuery(
      (this.getOriginalValue() as Shape).nodeShape.id,
    );
    const propertyLabels = getUniquePropertyShapes(leastSpecificShape.shape)
      .map((propertyShape) => propertyShape.label);
    return this.select((shape) =>
      propertyLabels.map((label) => (shape as any)[label]),
    );
  }

  // count(countable: QueryBuilderObject, resultKey?: string): SetSize<this> {
  //   return new SetSize(this, countable, resultKey);
  //   // return this._count;
  // }
}


/**
 * Concrete query wrapper for JS primitive values (string, number, boolean, Date).
 *
 * Replaces the former abstract class + subclasses (QueryString, QueryNumber,
 * QueryBoolean, QueryDate) — the type parameter T carries the primitive type,
 * so separate subclasses are unnecessary.
 */
export class QueryPrimitive<
  T,
  Source = any,
  Property extends string | number | symbol = any,
> extends QueryBuilderObject<T, Source, Property> {
  constructor(
    public originalValue?: T,
    public property?: PropertyShapeData,
    public subject?: QueryShape<any> | QueryShapeSet<any> | QueryPrimitiveSet,
  ) {
    super(property, subject);
  }

  equals(otherValue: JSPrimitive | QueryBuilderObject): ExpressionNode {
    const self = toExpressionNode(this);
    const arg = otherValue instanceof QueryBuilderObject
      ? toExpressionNode(otherValue)
      : otherValue;
    return self.eq(arg as any);
  }

  oneOf(values: (JSPrimitive | QueryBuilderObject)[]): ExpressionNode {
    return toExpressionNode(this).oneOf(
      values.map((v) => (v instanceof QueryBuilderObject ? toExpressionNode(v) : v)) as any,
    );
  }
  notOneOf(values: (JSPrimitive | QueryBuilderObject)[]): ExpressionNode {
    return toExpressionNode(this).notOneOf(
      values.map((v) => (v instanceof QueryBuilderObject ? toExpressionNode(v) : v)) as any,
    );
  }

  where(validation: WhereClause<string>): this {
    // For inline where on a primitive (p.hobby.where(h => h.equals(...))),
    // pass a clone that produces alias expressions (the bound value itself)
    // rather than property traversals
    const selfAsAlias = new InlineWhereProxy(this);
    this.wherePath = processWhereClause(validation, selfAsAlias as any);
    //return this because after Shape.friends.where() we can call other methods of Shape.friends
    return this as any;
  }
}


export class QueryPrimitiveSet<
  QPrimitive extends QueryPrimitive<any> = null,
> extends QueryBuilderObject<any, any, any> {
  public contents: CoreSet<QPrimitive>;

  constructor(
    public originalValue?: JSNonNullPrimitive[],
    public property?: PropertyShapeData,
    public subject?: QueryShapeSet<any> | QueryShape<any>,
    items?,
  ) {
    super(property, subject);
    this.contents = new CoreSet(items);
  }

  add(item) {
    this.contents.add(item);
  }

  values() {
    return [...this.contents.values()];
  }

  //this is needed because we extend CoreSet which has a createNew method but does not expect the constructor to have arguments
  createNew(...args): this {
    return new (<any>this.constructor)(
      this.property,
      this.subject,
      ...args,
    ) as this;
  }

  //TODO: see if we can merge these methods of QueryPrimitive and QueryPrimitiveSet
  // so that they're only defined once
  equals(other): ExpressionNode {
    return toExpressionNode(this).eq(other);
  }

  getPropertyStep(): QueryStep {
    if (this.contents.size > 1) {
      throw new Error(
        'This should never happen? Not implemented: get property path for a QueryPrimitiveSet with multiple values',
      );
    }
    return this.contents.first().getPropertyStep();
  }

  getPropertyPath(): QueryPropertyPath {
    if (this.contents.size > 1) {
      throw new Error(
        'This should never happen? Not implemented: get property path for a QueryPrimitiveSet with multiple values',
      );
    }
    //here we let the first item in the set return its property path, because all items will be the same
    //however, sometimes the path goes through the subject of this SET rather than the individual items (which have an individual shape as subject)
    //so we pass the subject of this set so it can be used
    let first = this.contents.first();
    if (first) {
      (first.subject as QueryShapeSet).wherePath =
        (first.subject as QueryShapeSet).wherePath || this.subject.wherePath;
      return first.getPropertyPath();
    } else {
      console.warn(
        `QueryPrimitiveSet without items. From ${this.subject.getOriginalValue().nodeShape.label}.${this.property.label}.  What to return as property path?`,
      );
      return this.subject.getPropertyPath();
    }
  }

  //countable, resultKey?: string
  size(): SetSize<this> {
    return new SetSize(this as QueryPrimitiveSet);
    //countable, resultKey
  }
}

export class SetSize<Source = null> extends QueryPrimitive<number, Source> {
  constructor(
    public subject: QueryShapeSet | QueryShape | QueryPrimitiveSet,
    public countable?: QueryBuilderObject,
    public label?: string,
  ) {
    super();
  }

  // Build an aggregate_expr(count, …) ExpressionNode for the counted property.
  private toCountExpr(): ExpressionNode {
    const countedSegments = FieldSet.collectPropertySegments(this.subject);
    const countedIds = countedSegments.map((s) => s.id);
    const countedNode = tracedPropertyExpression(countedIds);
    return new ExpressionNode(
      {kind: 'aggregate_expr', name: 'count', args: [countedNode.ir]} as any,
      countedNode._refs,
    );
  }

  // Comparisons on the count (lowered to a HAVING clause on COUNT(…)).
  equals(v: any): ExpressionNode { return this.toCountExpr().eq(v); }
  eq(v: any): ExpressionNode { return this.toCountExpr().eq(v); }
  neq(v: any): ExpressionNode { return this.toCountExpr().neq(v); }
  notEquals(v: any): ExpressionNode { return this.toCountExpr().neq(v); }
  gt(v: any): ExpressionNode { return this.toCountExpr().gt(v); }
  greaterThan(v: any): ExpressionNode { return this.toCountExpr().gt(v); }
  gte(v: any): ExpressionNode { return this.toCountExpr().gte(v); }
  greaterThanOrEqual(v: any): ExpressionNode { return this.toCountExpr().gte(v); }
  lt(v: any): ExpressionNode { return this.toCountExpr().lt(v); }
  lessThan(v: any): ExpressionNode { return this.toCountExpr().lt(v); }
  lte(v: any): ExpressionNode { return this.toCountExpr().lte(v); }
  lessThanOrEqual(v: any): ExpressionNode { return this.toCountExpr().lte(v); }

  as(label: string) {
    this.label = label;
    return this;
  }

  getPropertyPath(): QueryPropertyPath {
    //count the last property in the path
    //use the label of the last property as the label of the count step
    let countable = this.subject.getPropertyStep();
    let self: SizeStep = {
      count: [countable],
      label: this.label || this.subject.property.label,
    };

    //request the path of the subject's subject (the parent of the parent)
    //and add the SizeStep to that path, since we already used the subject as the thing that's counted
    if (this.subject.subject) {
      let path = this.subject.subject.getPropertyPath();
      path.push(self);
      return path;
    }
    return [self];
  }
}

