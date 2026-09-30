/**
 * Loading the SHACL metamodel must be enough to query every property of it.
 *
 * `PropertyShape.in` (sh:in) has `List` as its value shape. It used to name it by string, which
 * imports nothing, so a consumer that deep-imported `package.js` + `shapes/SHACL.js` (as most do)
 * got "Shape class not found for …/core/List" from any query that touched `in` (backlog 045).
 *
 * This file deliberately imports nothing that loads `shapes/List.ts` or the package entry, so it
 * sees exactly what such a consumer sees. Do not add a fixture import here.
 */
import {describe, expect, test} from '@jest/globals';
import '../package';
import {getNodeShapeUri, NodeShape, PropertyShape} from '../shapes/SHACL';
import {getShapeClass} from '../utils/ShapeClass';

// The metamodel's properties are registered at runtime, so they are untyped on the classes.
const LIST_IRI = getNodeShapeUri('@_linked/core', 'List');

describe('SHACL metamodel registration without the entry', () => {
  test('List is registered by loading package.js alone', () => {
    const list = getShapeClass(LIST_IRI);
    expect(list).toBeDefined();
    expect(list.shape.id).toBe(LIST_IRI);
  });

  test('PropertyShape.in points at the registered List shape', () => {
    expect(() => PropertyShape.select((p: any) => p.in).toJSON()).not.toThrow();
    expect(() => PropertyShape.select((p: any) => p.in.first).toJSON()).not.toThrow();
  });

  test('the shape-catalog query that selects ps.in builds', () => {
    expect(() =>
      NodeShape.select((ns: any) => [ns.properties.select((ps: any) => [ps.path, ps.in])]).toJSON(),
    ).not.toThrow();
  });
});
