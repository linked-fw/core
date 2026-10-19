import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {getActiveShapeCatalog, getOrCreateShapeAdapter, getShapeClass} from '../utils/ShapeClass.js';
import {topLevelDetails, unresolvedShapeError} from '../utils/unresolvedShape.js';

/**
 * Resolve a shape class or IRI string to a ShapeConstructor.
 *
 * Shared utility used by QueryBuilder, CreateBuilder, UpdateBuilder, and DeleteBuilder
 * to normalize their shape input.
 *
 * @throws If a string IRI cannot be resolved via the shape registry.
 */
export function resolveShape<S extends Shape>(
  shape: ShapeConstructor<S> | string,
): ShapeConstructor<S> {
  if (typeof shape === 'string') {
    // An authored class first; otherwise a constructor derived from the registered
    // metadata, so a project-authored shape that exists only as data resolves too.
    const shapeClass = getShapeClass(shape) ?? getOrCreateShapeAdapter(shape);
    if (!shapeClass) {
      throw unresolvedShapeError(`Cannot resolve shape for '${shape}'`, topLevelDetails(shape));
    }
    return shapeClass as ShapeConstructor<S>;
  }
  // Inside a catalog the catalog's data is the authority for every IRI it holds, so an
  // authored class for one of them (CN's compiled `Person` for a project's `Person`)
  // resolves to the catalog's shape. A class the catalog does not hold is kept as is.
  const catalog = getActiveShapeCatalog();
  if (catalog !== undefined) {
    const id = shape?.shape?.id;
    if (id && catalog.has(id)) {
      const own = getOrCreateShapeAdapter(id);
      if (own) return own as unknown as ShapeConstructor<S>;
    }
  }
  return shape;
}
