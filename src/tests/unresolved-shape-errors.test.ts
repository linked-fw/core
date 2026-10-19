/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * A property whose `sh:node` names a shape the active catalog does not hold: every error
 * names the property, the shape that declares it and the missing shape, with the IRIs as
 * fields (backlog 056 §2).
 */
import {describe, expect, test} from '@jest/globals';
import '../utils/Package';
import {ShapeCatalog, withShapeCatalog} from '../utils/ShapeCatalog';
import {SelectBuilder} from '../queries/QueryBuilder';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {FieldSet} from '../queries/FieldSet';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {walkPropertyPath} from '../queries/PropertyPath';
import {ShapeValidationError} from '../shapes/validation';
import {UnresolvedShapeError} from '../utils/unresolvedShape';
import {shacl} from '../ontologies/shacl';
import type {NodeShapeWire} from '../shapes/nodeShapeWire';

const EX = 'https://example.org/unresolved/';
const PERSON = `${EX}shape/Person`;
const PLACE = `${EX}shape/Place`;

const literal = (owner: string, label: string) => ({
  id: `${owner}/${label}`,
  label,
  path: {id: `${EX}${label}`},
  maxCount: 1,
  nodeKind: {id: shacl.Literal.id},
});

const personWire: NodeShapeWire = {
  id: PERSON,
  label: 'Person',
  targetClass: {id: `${EX}Person`},
  propertyShapes: [
    literal(PERSON, 'name'),
    {id: `${PERSON}/home`, label: 'home', path: {id: `${EX}home`}, maxCount: 1, valueShape: {id: PLACE}},
    {id: `${PERSON}/visited`, label: 'visited', path: {id: `${EX}visited`}, valueShape: {id: PLACE}},
  ],
} as NodeShapeWire;

const placeWire: NodeShapeWire = {
  id: PLACE,
  label: 'Place',
  targetClass: {id: `${EX}Place`},
  propertyShapes: [literal(PLACE, 'city')],
} as NodeShapeWire;

/** The branch that lacks `Place`, and one that holds it (to build the JSON forms). */
const lacking = ShapeCatalog.from([personWire], {name: 'p1#main'});
const complete = ShapeCatalog.from([personWire, placeWire], {name: 'p1#full'});

const HOME_FIELDS = {
  shapeIri: PLACE,
  property: 'home',
  propertyIri: `${EX}home`,
  ownerShapeIri: PERSON,
  catalog: 'p1#main',
};

/** The error `fn` throws, asserted to be an UnresolvedShapeError that is still a plain Error. */
function thrown(fn: () => unknown): UnresolvedShapeError {
  try {
    withShapeCatalog(lacking, fn);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(UnresolvedShapeError);
    expect((e as Error).name).toBe('Error');
    return e as UnresolvedShapeError;
  }
  throw new Error('expected a throw');
}

const NAMES_IT = /property 'home' of 'https:\/\/example\.org\/unresolved\/shape\/Person' points at it; catalog 'p1#main' does not hold it/;

describe('nested select', () => {
  test('a single-valued property', () => {
    const err = thrown(() => lower(SelectBuilder.from(PERSON).select((p: any) => [p.home.city])));
    expect(err.message).toBe(
      `Shape class not found for ${PLACE} (property 'home' of '${PERSON}' points at it; catalog 'p1#main' does not hold it)`,
    );
    expect(err).toMatchObject(HOME_FIELDS);
  });

  test('a set-valued property', () => {
    const err = thrown(() =>
      lower(SelectBuilder.from(PERSON).select((p: any) => [p.visited.select((v: any) => [v.city])])),
    );
    expect(err.message).toMatch(/^Shape class not found for /);
    expect(err).toMatchObject({...HOME_FIELDS, property: 'visited', propertyIri: `${EX}visited`});
  });

  test('a FieldSet path', () => {
    const err = thrown(() => walkPropertyPath(lacking.get(PERSON)!, 'home.city'));
    expect(err.message).toMatch(/^Cannot resolve valueShape '.*Place' for property 'home' in path 'home.city'/);
    expect(err.message).toMatch(NAMES_IT);
    expect(err).toMatchObject(HOME_FIELDS);
    const viaFieldSet = thrown(() => FieldSet.for(lacking.get(PERSON)!, [{home: ['city']}]));
    expect(viaFieldSet).toMatchObject(HOME_FIELDS);
  });

  test('the global registry says the shape is not registered', () => {
    const shape = lacking.get(PERSON)!;
    expect(() => walkPropertyPath(shape, 'home.city')).toThrow(
      /property 'home' of '.*Person' points at it; it is not registered/,
    );
  });
});

describe('nested create and update', () => {
  test('create names the property, its shape and the missing shape', () => {
    let err: unknown;
    withShapeCatalog(lacking, () => {
      try {
        lower(CreateBuilder.from(PERSON).set({home: {city: 'Utrecht'}} as any));
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(ShapeValidationError);
    expect((err as Error).message).toContain(`its shape '${PLACE}' does not resolve`);
    expect((err as Error).message).toMatch(NAMES_IT);
  });

  test('update too', () => {
    let err: unknown;
    withShapeCatalog(lacking, () => {
      try {
        lower(UpdateBuilder.from(PERSON).for(`${EX}p1`).set({home: {city: 'Utrecht'}} as any));
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(ShapeValidationError);
    expect((err as Error).message).toMatch(NAMES_IT);
  });
});

describe('fromJSON', () => {
  const selectJson = withShapeCatalog(complete, () =>
    SelectBuilder.from(PERSON).select((p: any) => [p.home.city]).toJSON(),
  );
  const nestedJson = withShapeCatalog(complete, () =>
    SelectBuilder.from(PERSON).select((p: any) => [p.visited.select((v: any) => [v.city])]).toJSON(),
  );
  const createJson = withShapeCatalog(complete, () =>
    CreateBuilder.from(PERSON).set({home: {city: 'Utrecht'}} as any).toJSON(),
  );

  test('a select path', () => {
    const err = thrown(() => lower(fromJSON(selectJson) as SelectBuilder));
    expect(err.message).toMatch(NAMES_IT);
    expect(err).toMatchObject(HOME_FIELDS);
  });

  test('nested sub-fields are not read against the parent shape', () => {
    // `visited: ['city']` used to fall back to Person and fail on `city`, naming neither
    // `visited` nor Place.
    const err = thrown(() => lower(fromJSON(nestedJson) as SelectBuilder));
    expect(err.message).toMatch(/^Cannot resolve valueShape '.*Place' for property 'visited'/);
    expect(err).toMatchObject({...HOME_FIELDS, property: 'visited', propertyIri: `${EX}visited`});
  });

  test('a create', () => {
    let err: unknown;
    withShapeCatalog(lacking, () => {
      try {
        lower(fromJSON(createJson) as CreateBuilder);
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(ShapeValidationError);
    expect((err as Error).message).toMatch(NAMES_IT);
  });

  test("a query's own shape names the catalog", () => {
    const other = `${EX}shape/Other`;
    const err = thrown(() => fromJSON({...selectJson, shape: other}));
    expect(err.message).toBe(`Cannot resolve shape for '${other}' (catalog 'p1#main' does not hold it)`);
    expect(err).toMatchObject({shapeIri: other, catalog: 'p1#main'});
  });
});
