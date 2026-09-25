/**
 * The registry reports how many copies of itself are loaded.
 *
 * It exists because a duplicate never announces itself: the symptoms are "this declared
 * property is not declared" and "this pinned shape has no pin", both accusing code that
 * is correct. Counting is what turns that into a sentence naming the real cause.
 */
import {describe, expect, test} from '@jest/globals';
import {getShapeRegistryInstanceCount} from '../utils/ShapeClass';
import {undeclaredPropertyMessage} from '../shapes/validation';

describe('single-instance guard', () => {
  test('one copy is loaded in a normal process', () => {
    expect(getShapeRegistryInstanceCount()).toBe(1);
  });

  test('counts copies rather than evaluations', () => {
    // The distinction this test exists for: a counter incremented per evaluation is
    // inflated by HMR re-evaluating the same module in one process, which would make
    // the guard cry wolf on every few edits. Calling twice must not move it.
    const first = getShapeRegistryInstanceCount();
    expect(getShapeRegistryInstanceCount()).toBe(first);
  });

  test('the undeclared-property message stays plain when only one copy is loaded', () => {
    const message = undeclaredPropertyMessage('projectSlug', {
      id: 'https://example.org/shape/Project',
      label: 'Project',
      propertyShapes: [],
    } as any);
    expect(message).toContain('Invalid property key: projectSlug');
    // No note about copies — there is nothing to warn about, and a spurious one sends
    // the reader after a module-resolution problem that does not exist.
    expect(message).not.toContain('copies of the shape registry');
  });
});
