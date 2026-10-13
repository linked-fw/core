import type {NodeShapeData, PropertyShapeData} from '../shapes/SHACL.js';
import {Shape} from '../shapes/Shape.js';
import {ShapeSet} from '../collections/ShapeSet.js';
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {ExpressionNode} from '../expressions/ExpressionNode.js';

export type Prettify<T> = T extends infer R
  ? {
      [K in keyof R]: R[K];
    }
  : never;

/**
 * Recursively adds an id property to all objects in the object.
 * Also makes all keys optional.
 */
type _AddId<U> = U extends string | number | boolean | Date | null | undefined
  ? U
  : U extends Array<infer T>
    ? Array<_AddId<T>>
    : WithId<U>;

type RemoveId<U> = Omit<U, 'id'>;

type WithId<U> = U & {id: string};

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

type CombineTypes<T> = {
  [K in keyof UnionToIntersection<T>]: T extends {[P in K]?: infer V}
    ? _AddId<V>
    : never;
};

type IsPlainObject<T> = T extends object
  ? T extends any[]
    ? false
    : T extends Function
      ? false
      : T extends Date
        ? false
        : T extends RegExp
          ? false
          : T extends Error
            ? false
            : T extends null
              ? false
              : T extends undefined
                ? false
                : T extends object
                  ? true
                  : false
  : false;

type RecursiveTransform<T, IsCreate = false> = T extends
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  ? T
  : T extends Array<infer U>
    ? UpdatedSet<Prettify<RecursiveTransform<U>>, IsCreate>
    : IsSetModification<T> extends true
      ? ModifiedSet<T, IsCreate>
      : IsPlainObject<T> extends true
        ? // ? WithId<{ [K in keyof T]-?: Prettify<RecursiveTransform<T[K]>> }>
          WithId<{[K in keyof T]: Prettify<RecursiveTransform<T[K], IsCreate>>}>
        : T;

//for update() we use {updatedTo} but for create() we actually just return the array of new values;
type UpdatedSet<U, IsCreate> = IsCreate extends true
  ? U[]
  : {
      updatedTo: U[];
    };
type IsSetModification<T> = T extends {add?: any; remove?: any} ? true : false;
type AddedType<T> = T extends {add: (infer U)[]}
  ? U
  : T extends {add: infer U}
    ? U
    : never;

type RemovedType<T> = T extends {remove: (infer U)[]}
  ? U
  : T extends {remove: infer U}
    ? U
    : never;

type ModifiedSet<T, IsCreate = false> = {
  added: AddId<AddedType<T>, IsCreate>[];
  removed: AddId<RemovedType<T>, IsCreate>[];
};

export type AddId<T, IsCreate = false> = Prettify<
  RecursiveTransform<T, IsCreate>
>;

export type UpdatePartial<S = Shape> =
  | UpdateNodeDescription<S>
  | NodeReferenceValue;
type UpdateNodeDescription<Shape> = Partial<
  Omit<
    {
      [P in KeysWithoutFunctions<Shape>]: ShapePropValueToUpdatePartial<
        Shape[P]
      >;
    },
    'node' | 'nodeShape' | 'namedNode' | 'targetClass'
  >
>;
type KeysWithoutFunctions<T> = {
  [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];

type ShapePropValueToUpdatePartial<ShapeProperty> = ShapeProperty extends Shape
  ? UpdatePartial<ShapeProperty>
  : ShapeProperty extends ShapeSet<infer SSType>
    ? SetUpdateValue<SSType>
    : ShapeProperty | ExpressionNode;

type SetUpdateValue<SSType> = UpdatePartial<SSType>[] | SetModification<SSType>;

export type SetModification<SSType> = {
  add?: UpdatePartial<SSType>[] | UpdatePartial<SSType>;
  remove?: UpdatePartial<SSType>[] | UpdatePartial<SSType>;
};

export type SetModificationValue = {
  $add?: UpdatePartial[];
  $remove?: NodeReferenceValue[];
};

type UnsetValue = undefined;
export type LiteralUpdateValue = string | number | boolean | Date;
export type PropUpdateValue =
  | SinglePropertyUpdateValue
  | SinglePropertyUpdateValue[]
  | SetModificationValue;
export type SinglePropertyUpdateValue =
  | NodeDescriptionValue
  | NodeReferenceValue
  | LiteralUpdateValue
  | UnsetValue;
export type NodeDescriptionValue = {
  shape: NodeShapeData;
  fields: UpdateNodePropertyValue[];
  /**
   * The id of the node to be created.
   * Optional, if not provided a new id will be generated.
   */
  __id?: string;
};
export type UpdateNodePropertyValue = {
  prop: PropertyShapeData;
  val: PropUpdateValue;
};
export type ShapeReferenceValue = {id: string; shape: NodeReferenceValue};
export {toNodeReference} from '../utils/NodeReference.js';
export type {NodeReferenceValue};

export abstract class QueryFactory {}

export function isSetModificationValue(
  value: any,
): value is SetModificationValue {
  if (value === null || typeof value !== 'object') return false;

  let hasAddKey = value.$add;
  let hasRemoveKey = value.$remove;
  let numKeys = Object.keys(value).length;
  //has no other keys
  return (
    (hasAddKey && hasRemoveKey && numKeys === 2) ||
    (hasAddKey && numKeys === 1) ||
    (hasRemoveKey && numKeys === 1)
  );
}

