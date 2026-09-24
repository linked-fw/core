import {
  type LiteralUpdateValue,
  type NodeDescriptionValue,
  NodeReferenceValue,
  type PropUpdateValue,
  QueryFactory,
  type SetModification,
  type SetModificationValue,
  type SinglePropertyUpdateValue,
  type UpdateNodePropertyValue,
  type UpdatePartial,
} from './QueryFactory.js';
import {getPropertyShapes} from '../shapes/nodeShapeData.js';
import type {NodeShapeData, PropertyShapeData} from '../shapes/SHACL.js';
import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {resolveShapeConstructor} from '../utils/ShapeClass.js';
import {isExpressionNode, ExpressionNode} from '../expressions/ExpressionNode.js';
import {createProxiedPathBuilder} from './ProxiedPathBuilder.js';
import {asContextRef} from './QueryContext.js';
import {
  assertValid,
  undeclaredPropertyMessage,
  type ValidationMode,
} from '../shapes/validation.js';

export type NodeId = {id: string} | string;

/** Options for {@link MutationQueryFactory.describe}. */
export interface DescribeOptions {
  /** Create data may carry a top-level `id`; update data may not. */
  allowTopLevelId?: boolean;
  /**
   * Validate the data against the shape before normalizing, throwing a
   * `ShapeValidationError` with every violation. Omit to skip validation
   * (normalization-only, e.g. when the caller has already validated).
   */
  validate?: ValidationMode;
}

export class MutationQueryFactory extends QueryFactory {
  /**
   * Normalize raw create/update data into a {@link NodeDescriptionValue} — the
   * IR-free step shared by `toJSON()` and `lower()`. Kept on this base (which
   * imports no IR) so the builders can normalize for serialization without
   * pulling the canonical-IR pipeline.
   *
   * This is also the single validation gate: pass `validate` and the resolved
   * data is checked against the shape first, so `toJSON()`, `lower()` and
   * `exec()` reject exactly the same input. See `shapes/validation`.
   */
  describe(
    shape: NodeShapeData,
    data: unknown,
    options: DescribeOptions = {},
  ): NodeDescriptionValue {
    return this.convertUpdateObject(data as any, shape, options);
  }

  /** Normalize delete ids (strings / `{id}`) to `NodeReferenceValue[]` (IR-free). */
  normalizeNodeRefs(ids: NodeId[] | NodeId): NodeReferenceValue[] {
    return this.convertNodeReferences(ids);
  }

  protected convertUpdateObject(
    obj,
    shape: NodeShapeData,
    {allowTopLevelId = false, validate}: DescribeOptions = {},
  ): NodeDescriptionValue {
    let resolved;
    if (typeof obj === 'object' && !(obj instanceof Date) && obj !== null) {
      if (!allowTopLevelId && 'id' in obj) {
        throw new Error(
          'You cannot use id in the top level of an update object',
        );
      }
      resolved = obj;
    } else if (typeof obj === 'function') {
      // A shape authored in a project exists only as metadata, so it has no authored
      // class. `getOrCreateShapeAdapter` derives a constructor from that metadata --
      // which is the documented return leg of the shape round trip (see
      // registerRuntimeShape). Resolving with `getShapeClass` alone made every runtime shape
      // fail here with "Shape class not found".
      const shapeClass = shape.id ? resolveShapeConstructor(shape.id) : undefined;
      if (!shapeClass) {
        throw new Error(`Shape class not found for ${shape.id || 'unknown'}`);
      }
      const proxy = createProxiedPathBuilder(shapeClass);
      const result = obj(proxy);
      if (typeof result !== 'object' || result === null) {
        throw new Error('Update function must return an object');
      }
      // Validate what the callback produced, not the callback itself.
      resolved = result;
    } else {
      throw new Error('Invalid update object');
    }
    if (validate) {
      assertValid(shape, resolved, {mode: validate});
    }
    return this.convertNodeDescription(resolved, shape);
  }

  protected isSetModification(obj, shape) {
    let hasAdd = obj.add;
    let hasRemove = obj.remove;
    let numKeysExpected = (hasAdd ? 1 : 0) + (hasRemove ? 1 : 0);
    let numKeys = Object.getOwnPropertyNames(obj).length;
    // A set modification is ONLY add/remove keys. Mixing them with other keys
    // (e.g. {add:[…], name:'x'}) must NOT be silently treated as a set mod —
    // that dropped the sibling fields. Require an exact key-count match for
    // both add and remove (mirrors isSetModificationValue).
    return (hasAdd || hasRemove) && numKeysExpected === numKeys;
  }

  protected convertSetModification(
    obj: SetModification<any>,
    shape: PropertyShapeData,
  ): SetModificationValue {
    if (!obj.add && !obj.remove) {
      throw new Error('Set modification should have either add or remove key');
    }
    const res: SetModificationValue = {};
    if (obj.add) {
      res.$add = this.convertSetAddValue(obj.add, shape);
    }
    if (obj.remove) {
      res.$remove = this.convertSetRemoveValue(obj.remove, shape);
    }
    return res;
  }

  protected convertSetRemoveValue(
    obj: UpdatePartial | UpdatePartial[],
    shape: PropertyShapeData,
  ): NodeReferenceValue[] {
    //the user can either pass an array of node references or a single node reference
    //either way we should return an array of node reference values
    if (Array.isArray(obj)) {
      return obj.map((o) => this.convertSingleRemoveValue(o, shape));
    } else {
      return [this.convertSingleRemoveValue(obj, shape)];
    }
  }

  protected convertSetAddValue(
    obj: UpdatePartial | UpdatePartial[],
    shape: PropertyShapeData,
  ): UpdatePartial[] {
    if (Array.isArray(obj)) {
      return obj.map((o) => this.convertUpdateValue(o, shape) as UpdatePartial);
    } else {
      return [this.convertUpdateValue(obj, shape) as UpdatePartial];
    }
  }

  protected convertSingleRemoveValue(
    value,
    shape: PropertyShapeData,
  ): NodeReferenceValue {
    const ctx = asContextRef(value);
    if (ctx) {
      return ctx as unknown as NodeReferenceValue;
    }
    if (this.isNodeReference(value)) {
      return this.convertNodeReference(value);
    } else {
      throw new Error(
        `Invalid value for ${shape.label}.$remove. Expected an object with an id as key: {id:string}`,
      );
    }
  }

  protected convertNodeDescription(
    inputObj: Record<string, unknown>,
    shape: NodeShapeData,
  ): NodeDescriptionValue {
    // Shallow-copy so we never mutate the caller's object
    const obj = {...inputObj};
    const props = getPropertyShapes(shape, true);
    const fields: UpdateNodePropertyValue[] = [];
    let id;
    if ('__id' in obj) {
      //if the object has a __id key, then we should use that in the result
      id = obj.__id.toString();
      //but we should not include it in the fields
      delete obj.__id;
    } else if ('id' in obj) {
      //if the object has an id key alongside other data properties,
      //treat it as a nested create with a predefined ID
      id = String(obj.id);
      delete obj.id;
    }
    for (var key in obj) {
      let propShape = props.find((p) => p.label === key);
      if (!propShape) {
        // Also reported as an `sh:ClosedConstraintComponent` violation when the
        // caller validates; kept here because normalization cannot build a field
        // without a property shape (`describe()` may run without validation).
        throw Error(undeclaredPropertyMessage(key, shape));
      } else {
        fields.push(this.createNodePropertyValue(obj[key], propShape));
      }
    }
    const res: NodeDescriptionValue = {
      fields,
      shape,
    };
    if (id) {
      res.__id = id;
    }

    return res;
  }

  protected createNodePropertyValue(
    value,
    propShape: PropertyShapeData,
  ): UpdateNodePropertyValue {
    return {
      prop: propShape,
      val: this.convertUpdateValue(value, propShape),
    } as UpdateNodePropertyValue;
  }

  protected convertUpdateValue(
    value,
    propShape?: PropertyShapeData,
    allowArrays: boolean = true,
  ): PropUpdateValue {
    // ExpressionNode → pass through as-is (will be converted to IRExpression by IRMutation)
    if (isExpressionNode(value)) {
      return value as unknown as PropUpdateValue;
    }

    // Query-context reference → preserve the live ref (do NOT collapse to {id},
    // which would read an unresolved `.id` as undefined). Handles both an unset
    // PendingQueryContext and a resolved context shape; both serialize as a {@ctx}
    // marker and are resolved — or throw — at lowering time.
    {
      const ctx = asContextRef(value);
      if (ctx) return ctx as unknown as PropUpdateValue;
    }

    //single value which will
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value instanceof Date
    ) {
      return value as LiteralUpdateValue;
    }

    //if multiple items are given as value of this prop
    if (Array.isArray(value)) {
      if (!allowArrays) {
        throw new Error('Nested arrays are not allowed as values of keys');
      }
      //then convert each value, but disallow nested arrays moving forward
      return value.map((o) => {
        return this.convertUpdateValue(o, propShape, false);
      }) as SinglePropertyUpdateValue[];
    } else if (typeof value === 'undefined') {
      return value;
    } else if (value === null) {
      //unsetting a value with null is also possible. But we pass it as undefined in the query object
      return undefined;
    } else if (typeof value === 'object') {
      if (this.isNodeReference(value)) {
        return this.convertNodeReference(value);
      } else {
        let valueShape: NodeShapeData = null;
        if (propShape.valueShape) {
          const shapeClass = resolveShapeConstructor(propShape.valueShape);
          valueShape = shapeClass?.shape || null;
          if (!valueShape) {
            throw new Error(
              `Shape class not found for ${propShape.valueShape.id}`,
            );
          }
        }
        //pass the value shape of the property as the node shape of this value
        if (!propShape.valueShape) {
          //It's possible to define the shape of the value in the value itself for properties who do not define the shape in their objectProperty
          if (value.shape) {
            if (!value.shape.shape) {
              throw new Error(
                `The value of property "shape" is invalid and should be a class that extends Shape.`,
              );
            }
            valueShape = (value.shape as typeof Shape).shape;
          } else {
            //TODO: not sure if this should be an error. Does every @linkedObject need to define the shape of the values?
            // If not, then how do we continue? because currently we use the value shape to look up further property shapes
            throw new Error(
              `Cannot update properties with plain objects if the shape of the values is not known. Make sure get/set ${propShape.parentNodeShape.label}.${propShape.label} defines the 'shape' key in its @objectProperty decorator.`,
            );
          }
        }
        //never keep a shape key in the value object
        if (value.shape) {
          //double check that IF a shape value is provided, that it matches the shape from the @objectProperty decorator
          if ((value.shape as typeof Shape).shape.id !== valueShape.id) {
            throw new Error(
              `The property 'shape' is reserved in LINCD and should not be used here in this way. The ${propShape.label} property already defines the shape of the value as ${propShape.label}. If you want to use a different shape, use the 'shape' key in the @objectProperty decorator.`,
            );
          }
          delete value.shape;
        }

        if (this.isSetModification(value, propShape)) {
          return this.convertSetModification(value, propShape);
        } else {
          return this.convertNodeDescription(value, valueShape);
        }
      }
    }
    throw new Error(`Unsupported update value type: ${typeof value}`);
  }

  protected isNodeReference(obj): obj is NodeReferenceValue {
    //check if obj is an object with only an id property
    //if additional data properties are present, it's a nested create with predefined ID
    return typeof obj === 'object' && obj !== null && 'id' in obj && Object.keys(obj).length === 1;
  }

  protected convertNodeReferences(
    input: NodeId[] | NodeId,
  ): NodeReferenceValue[] {
    if (Array.isArray(input)) {
      return input.map((o) => {
        return this.convertNodeReferenceOrString(o);
      });
    } else {
      return [this.convertNodeReferenceOrString(input)];
    }
  }

  protected convertNodeReferenceOrString(
    o: {id: string} | string,
  ): NodeReferenceValue {
    if (typeof o === 'string') {
      return {id: o};
    } else if (this.isNodeReference(o)) {
      return this.convertNodeReference(o);
    } else {
      throw new Error(`Invalid node reference: ${JSON.stringify(o)}`);
    }
  }

  protected convertNodeReference(obj: {id: string}): NodeReferenceValue {
    return {id: obj.id};
  }
}
