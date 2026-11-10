/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {getPropertyShapes} from '../shapes/SHACL';
import '../utils/Package'; // runs the core meta-model setup (sets NodeShape.shape etc.)
import {NodeShape} from '../shapes/SHACL';
import {Prefix} from '../utils/Prefix';
import {cached} from '../utils/cached';
import {rdf} from '../ontologies/rdf';

// Report 021 §1 Gap 1 regression lock-ins.

describe('Prefix._toFull — colon-containing local names (Gap 1.b)', () => {
  test('preserves the full local name past the first colon', () => {
    Prefix.add('exq', 'https://example.org/q/');
    // Local name itself contains a colon; only the FIRST colon separates prefix.
    expect(Prefix.toFull('exq:foo:bar')).toBe('https://example.org/q/foo:bar');
    // Sanity: a plain local name still works.
    expect(Prefix.toFull('exq:foo')).toBe('https://example.org/q/foo');
    Prefix.delete('exq');
  });

  test('toFull throws with the correct prefix name for an unknown prefix', () => {
    expect(() => Prefix.toFull('nope:foo:bar')).toThrow('Unknown prefix "nope" in "nope:foo:bar"');
  });
});

describe('cached() — key isolation and error handling (Gap 1.c)', () => {
  test('two different functions with identical args do not collide', () => {
    const fnA = () => 'A';
    const fnB = () => 'B';
    expect(cached(fnA, ['same'], Infinity)).toBe('A');
    // Same arg key, different function — must NOT return fnA's cached 'A'.
    expect(cached(fnB, ['same'], Infinity)).toBe('B');
  });

  test('cached errors are re-thrown, never returned as a value', () => {
    let calls = 0;
    const boom = () => {
      calls++;
      throw new Error('kaboom');
    };
    expect(() => cached(boom, ['k'], Infinity, true)).toThrow('kaboom');
    // Within the window the error is remembered (fn not re-invoked) but still thrown.
    expect(() => cached(boom, ['k'], Infinity, true)).toThrow('kaboom');
    expect(calls).toBe(1);
  });
});

describe('NodeShape meta-model — `type` predicate (Gap 1.a)', () => {
  test('the `type` property shape resolves to rdf:type, not sh:description', () => {
    const typeShape = getPropertyShapes(NodeShape.shape, true)
      .find((ps: {label?: string}) => ps.label === 'type');
    expect(typeShape).toBeDefined();
    const pathId = (typeShape as {path?: {id?: string}}).path?.id;
    expect(pathId).toBe(rdf.type.id);
  });
});
