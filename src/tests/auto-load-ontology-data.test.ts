import {describe, expect, test} from '@jest/globals';
import {autoLoadOntologyData} from '../utils/Package';

describe('autoLoadOntologyData', () => {
  test('is still exported and is a no-op', () => {
    expect(typeof autoLoadOntologyData).toBe('function');
    expect(autoLoadOntologyData(true)).toBeUndefined();
    expect(autoLoadOntologyData(false)).toBeUndefined();
    expect(autoLoadOntologyData()).toBeUndefined();
  });
});
