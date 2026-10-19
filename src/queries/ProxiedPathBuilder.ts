import {Shape, createShapeTarget, type ShapeConstructor} from '../shapes/Shape.js';
import {QueryBuilderObject, QueryShape} from './SelectQuery.js';
import {isLinkedInstance} from '../utils/linkedError.js';

/**
 * Creates the proxy object used as the `p` parameter in query callbacks.
 *
 * Property access on the returned proxy (e.g., `p.name`, `p.friends.name`)
 * creates QueryBuilderObject chains that trace the path of requested properties.
 * This is the shared foundation for both the DSL (`Person.select(p => p.name)`)
 * and the future QueryBuilder API.
 *
 * Originally extracted from SelectQueryFactory.getQueryShape() to enable reuse
 * across the DSL and dynamic query building.
 */
export function createProxiedPathBuilder<S extends Shape>(
  shape: ShapeConstructor<S> | QueryBuilderObject,
): QueryBuilderObject {
  if (isLinkedInstance(shape, QueryBuilderObject)) {
    // When a QueryBuilderObject is passed directly (e.g. QueryPrimitives
    // used as the shape for where-clause evaluation), use it as-is.
    return shape;
  }
  // Create a constructor-less dummy shape target and wrap it in a QueryShape
  // proxy. The proxy intercepts property access and resolves each property name
  // to its PropertyShapeData, building a chain of QueryBuilderObjects that
  // records which path was traversed.
  const dummyShape = createShapeTarget(shape);
  return QueryShape.create(dummyShape);
}
