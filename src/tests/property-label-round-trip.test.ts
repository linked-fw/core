import {describe, expect, test} from '@jest/globals';
import {buildPropertyShapeData} from '../shapes/syncShapes';
import {createPropertyShapeData} from '../shapes/nodeShapeData';
import type {PropertyShapeData} from '../shapes/nodeShapeData';

/**
 * The property label must survive the code → graph → code round trip.
 *
 * `buildPropertyShapeData` used the label only to mint the property-shape IRI and
 * never wrote it as a field. Readers then re-derived a label from the path's local
 * part, which is correct only while the two happen to coincide. When they differ —
 * `@_linked/org` declares `memberships` on `org:hasMembership` — the catalog reports
 * `hasMembership`, `InstanceProvider` indexes the query proxy with it, and the proxy
 * resolves labels against the CLASS, which only knows `memberships`. It throws.
 */
describe('property label round trip', () => {
  const SHAPE_IRI = 'https://example.org/shapes/Person';

  const propertyShape = (label: string, path: string): PropertyShapeData =>
    ({...createPropertyShapeData(), label, path}) as PropertyShapeData;

  test('serializesLabel — the label is written as a field, not just implied by the IRI', () => {
    const d = buildPropertyShapeData(propertyShape('name', 'https://schema.org/name'), SHAPE_IRI);
    expect(d.label).toBe('name');
  });

  test('labelDiffersFromPathLocalPart — the regression case', () => {
    const d = buildPropertyShapeData(
      propertyShape('memberships', 'https://www.w3.org/ns/org#hasMembership'),
      SHAPE_IRI,
    );
    // The DSL label, NOT the path's local part.
    expect(d.label).toBe('memberships');
    expect(d.label).not.toBe('hasMembership');
  });

  test('omitsEmptyLabel — a falsy label writes no field, so old readers keep their fallback', () => {
    const d = buildPropertyShapeData(propertyShape('', 'https://schema.org/name'), SHAPE_IRI);
    expect(d).not.toHaveProperty('label');
  });

  test('iriUnchanged — IRI minting is untouched by the added field', () => {
    const d = buildPropertyShapeData(
      propertyShape('memberships', 'https://www.w3.org/ns/org#hasMembership'),
      SHAPE_IRI,
    );
    expect(d.__id).toBe(`${SHAPE_IRI}/memberships`);
  });

  test('labelIsNotName — rdfs:label and sh:name are different fields', () => {
    const ps = propertyShape('memberships', 'https://www.w3.org/ns/org#hasMembership');
    ps.name = 'Memberships of this person';
    const d = buildPropertyShapeData(ps, SHAPE_IRI);
    expect(d.label).toBe('memberships');
    expect(d.name).toBe('Memberships of this person');
  });
});
