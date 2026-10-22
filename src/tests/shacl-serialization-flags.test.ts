/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {getPropertyShape} from '../shapes/SHACL';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';

const {linkedShape} = linkedPackage('flags-test');

const prop = (name: string) => ({id: `https://example.org/flags#${name}`});

@linkedShape({dependent: true})
class OwnedThing extends Shape {
  @literalProperty({path: prop('label'), maxCount: 1})
  get caption(): string {
    return '';
  }
}

@linkedShape({closed: true, ignoredProperties: [prop('extra')]})
class ClosedThing extends Shape {
  @literalProperty({path: prop('x'), maxCount: 1})
  get x(): string {
    return '';
  }
}

@linkedShape
class Container extends Shape {
  @objectProperty({path: prop('owns'), shape: OwnedThing, contains: true})
  get owns(): OwnedThing[] {
    return [];
  }

  @objectProperty({path: prop('refs'), shape: OwnedThing})
  get refs(): OwnedThing[] {
    return [];
  }
}

describe('contains/dependent flags', () => {
  test('objectProperty contains stored on PropertyShape', () => {
    expect(getPropertyShape(Container.shape, 'owns', false).contains).toBe(true);
    // a property without `contains` is falsy
    expect(getPropertyShape(Container.shape, 'refs', false).contains).toBeFalsy();
  });

  test('linkedShape dependent stored on NodeShape', () => {
    expect(OwnedThing.shape.dependent).toBe(true);
    expect(Container.shape.dependent).toBeFalsy();
  });

  test('linkedShape closed / ignoredProperties stored on NodeShape', () => {
    expect(ClosedThing.shape.closed).toBe(true);
    expect(ClosedThing.shape.ignoredProperties).toEqual([prop('extra')]);
    expect(Container.shape.closed).toBeUndefined();
  });
});
