import type {PropertyShapeData, NodeShapeData} from '../shapes/SHACL.js';
import {getPropertyShape} from '../shapes/nodeShapeData.js';
import {getQueryShapeClass} from '../utils/ShapeClass.js';
import {unresolvedValueShapeError} from '../utils/unresolvedShape.js';
import {brandLinkedClass} from '../utils/linkedError.js';

/**
 * A value object representing a sequence of property traversals from a root shape.
 *
 * Each segment is a PropertyShapeData representing one hop in the traversal.
 * For example, `friends.name` on PersonShape produces a PropertyPath with
 * two segments: [friendsPropertyShape, namePropertyShape].
 *
 * This is used by FieldSet and QueryBuilder to describe which properties
 * to select/filter, independent of proxy tracing.
 */
export class PropertyPath {
  constructor(
    readonly rootShape: NodeShapeData,
    readonly segments: readonly PropertyShapeData[],
  ) {}

  /** Append a property traversal hop, returning a new PropertyPath. */
  prop(property: PropertyShapeData): PropertyPath {
    return new PropertyPath(this.rootShape, [...this.segments, property]);
  }

  /** The terminal (leaf) property of this path. */
  get terminal(): PropertyShapeData | undefined {
    return this.segments[this.segments.length - 1];
  }

  /** The depth (number of hops) of this path. */
  get depth(): number {
    return this.segments.length;
  }

  /** String representation using property labels joined by dots. */
  toString(): string {
    return this.segments.map((s) => s.label).join('.');
  }

  /** Two PropertyPaths are equal if they have the same root shape and same segment sequence. */
  equals(other: PropertyPath): boolean {
    if (this.rootShape.id !== other.rootShape.id) return false;
    if (this.segments.length !== other.segments.length) return false;
    return this.segments.every((s, i) => s.id === other.segments[i].id);
  }
}
brandLinkedClass(PropertyPath, '@_linked/core', 'PropertyPath');


/**
 * Resolve a dot-separated property path string into a PropertyPath.
 *
 * Walks the shape's property shapes by label, following valueShape references
 * to traverse into nested shapes.
 *
 * Example: `walkPropertyPath(PersonShape, 'friends.name')` resolves
 * [friendsPropertyShape, namePropertyShape].
 *
 * @throws If any segment cannot be resolved.
 */
export function walkPropertyPath(shape: NodeShapeData, path: string): PropertyPath {
  const labels = path.split('.');
  const segments: PropertyShapeData[] = [];
  let currentShape = shape;

  for (const label of labels) {
    const propertyShape = getPropertyShape(currentShape, label);
    if (!propertyShape) {
      throw new Error(
        `Property '${label}' not found on shape '${currentShape.label || currentShape.id}' while resolving path '${path}'`,
      );
    }
    segments.push(propertyShape);

    // If there are more segments to resolve, follow the valueShape
    if (segments.length < labels.length) {
      if (!propertyShape.valueShape) {
        throw new Error(
          `Property '${label}' on shape '${currentShape.label || currentShape.id}' has no valueShape; cannot traverse further in path '${path}'`,
        );
      }
      const shapeClass = getQueryShapeClass(propertyShape.valueShape);
      if (!shapeClass || !shapeClass.shape) {
        throw unresolvedValueShapeError(
          `Cannot resolve valueShape '${propertyShape.valueShape.id}' for property '${label}' in path '${path}'`,
          propertyShape,
          currentShape,
        );
      }
      currentShape = shapeClass.shape;
    }
  }

  return new PropertyPath(shape, segments);
}
