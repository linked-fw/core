/**
 * Dataset pins are keyed on shape IDENTITY, not on class object identity.
 *
 * A shape's IRI is what a query carries and what a stored triple points at, so two
 * classes claiming the same IRI are the same shape. Resolution therefore falls back to
 * matching on IRI when the class object itself is not a key — and removal has to work
 * the same way round, or a pin the caller deleted comes back.
 */
import {describe, expect, test, beforeEach, jest} from '@jest/globals';
import {LinkedStorage} from '../utils/LinkedStorage';

const dataset = (name: string): any => ({
  name,
  selectQuery: async () => [],
  askQuery: async () => false,
  updateQuery: async () => undefined,
  createQuery: async () => undefined,
  deleteQuery: async () => undefined,
});

/** A stand-in shape class: the resolution only reads `static shape.id`. */
const shapeClass = (id: string): Function => {
  const cls = class {};
  (cls as any).shape = {id};
  return cls;
};

const IRI = 'https://example.org/shape/pin-test/Thing';

describe('dataset pins are keyed on shape identity', () => {
  beforeEach(() => {
    LinkedStorage.getShapeToDatasetMap().clear();
  });

  test('a second copy of the same shape class resolves to the pin', () => {
    const store = dataset('pinned');
    LinkedStorage.setDatasetForShapes(store, shapeClass(IRI));

    // A different class object for the same shape — what a second module copy produces.
    expect(LinkedStorage.getDatasetForShapeClass(shapeClass(IRI))).toBe(store);
  });

  test('unsetting removes every class pinned to that identity', () => {
    const store = dataset('pinned');
    const first = shapeClass(IRI);
    const second = shapeClass(IRI);
    LinkedStorage.setDatasetForShapes(store, first, second);

    LinkedStorage.unsetDatasetForShape(first);

    // Deleting `first` alone would leave `second` pinned, and the IRI fallback would
    // resurrect the pin the caller believed they had removed.
    expect(LinkedStorage.getDatasetForShapeClass(first)).not.toBe(store);
    expect(LinkedStorage.getDatasetForShapeClass(second)).not.toBe(store);
    expect(LinkedStorage.getShapeToDatasetMap().size).toBe(0);
  });

  test('unsetting by IRI works too', () => {
    LinkedStorage.setDatasetForShapes(dataset('pinned'), shapeClass(IRI));
    LinkedStorage.unsetDatasetForShape(IRI);
    expect(LinkedStorage.getShapeToDatasetMap().size).toBe(0);
  });

  test('two classes pinned to one identity with different datasets warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    LinkedStorage.setDatasetForShapes(dataset('a'), shapeClass(IRI));
    LinkedStorage.setDatasetForShapes(dataset('b'), shapeClass(IRI));

    // Resolving by insertion order would be silent and arbitrary; this is a
    // duplicate-registration bug and should say so.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(IRI));
    warn.mockRestore();
  });

  test('an unpinned shape falls through to the default dataset', () => {
    const fallback = dataset('default');
    LinkedStorage.setDefaultDataset(fallback);
    expect(LinkedStorage.getDatasetForShapeClass(shapeClass('https://example.org/other'))).toBe(fallback);
  });
});
