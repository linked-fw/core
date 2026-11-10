/*
 * A caller that passes the hierarchy (a host's shape builder) never loads the Turtle parser: with no mirror
 * package registered, checkShapeHierarchy does not import `n3`.
 */
import {expect, jest, test} from '@jest/globals';

let n3Loaded = false;
jest.unstable_mockModule('n3', () => {
  n3Loaded = true;
  return {Parser: class {}};
});

test('a passed hierarchy does not load n3', async () => {
  const {linkedPackage} = await import('../utils/Package');
  const {Shape} = await import('../shapes/Shape');
  const {checkShapeHierarchy} = await import('../shapes/checkShapeHierarchy');
  const {registerTestOntology} = await import('../test-helpers/register-test-ontology');
  const {linkedShape} = linkedPackage('check-no-n3');
  // A registered ontology with data: only the default hierarchy would read it.
  const ns = (term: string) => ({id: `http://example.org/no-n3/${term}`});
  registerTestOntology('check-no-n3', {
    name: 'no-n3',
    namespace: ns('').id,
    load: async () => ['not parsed'],
    files: '../data/no-n3.ttl',
  });
  class Thing extends Shape {
    static targetClass = ns('Thing');
  }
  linkedShape(Thing);
  const findings = await checkShapeHierarchy({hierarchy: []});
  expect(findings).toEqual([]);
  expect(n3Loaded).toBe(false);
});
