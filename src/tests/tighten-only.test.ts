/*
 * Tighten-only: an override (a property a sub-shape redeclares under an inherited label) may only
 * narrow the inherited property. The three original cases still throw; datatype, value shape,
 * contains and path warn (once); omitted constraints are inherited; data-only shapes warn for
 * every case.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {getPropertyShape, type NodeShapeData} from '../shapes/nodeShapeData';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import {xsd} from '../ontologies/xsd';
import {shacl} from '../ontologies/shacl';

const {linkedShape} = linkedPackage('tighten-only-test');
const ex = (term: string) => ({id: `http://example.org/tighten/${term}`});

let warn: jest.SpiedFunction<typeof console.warn>;
const warnings = () => warn.mock.calls.map((c) => String(c[0]));
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

@linkedShape
class TBase extends Shape {
  static targetClass = ex('TBase');
  @literalProperty({path: ex('count'), datatype: xsd.integer, maxCount: 1})
  get count(): number {
    return 0;
  }
  @objectProperty({path: ex('part'), shape: TBase, contains: true})
  get part(): TBase {
    return null;
  }
  @objectProperty({path: ex('peer'), shape: TBase, class: ex('TBase')})
  get peer(): TBase {
    return null;
  }
}

@linkedShape
class TSub extends TBase {
  static targetClass = ex('TSub');
}

@linkedShape
class TUnrelated extends Shape {
  static targetClass = ex('TUnrelated');
}

describe('the three original cases still throw', () => {
  test('minCount lowered, maxCount raised, nodeKind widened', () => {
    expect(() => {
      @linkedShape
      class TMax extends TBase {
        @literalProperty({path: ex('count'), maxCount: 2})
        get count(): number {
          return 0;
        }
      }
      return TMax;
    }).toThrow(/Invalid override for TMax\.count: maxCount cannot be increased \(1 -> 2\)/);
    expect(() => {
      @linkedShape
      class TKind extends TBase {
        @literalProperty({path: ex('count'), nodeKind: shacl.IRIOrLiteral})
        get count(): number {
          return 0;
        }
      }
      return TKind;
    }).toThrow(/nodeKind cannot be widened/);
  });
});

describe('the new cases warn once', () => {
  test('datatype changed', () => {
    @linkedShape
    class TDatatype extends TBase {
      @literalProperty({path: ex('count'), datatype: xsd.string})
      get count(): number {
        return 0;
      }
    }
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^\[linked\] Override TDatatype\.count widens the inherited property: datatype cannot change .*This becomes an error in the next major\.$/,
      ),
    ]);
    expect(TDatatype).toBeDefined();
  });

  test('value shape that is not a sub-shape', () => {
    @linkedShape
    class TValue extends TBase {
      @objectProperty({path: ex('part'), shape: TUnrelated, contains: true})
      get part(): TBase {
        return null;
      }
    }
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/TValue\.part .*value shape .*TUnrelated is not .*TBase or a sub-shape/);
    expect(TValue).toBeDefined();
  });

  test('a sub-shape value shape passes', () => {
    @linkedShape
    class TValueOk extends TBase {
      @objectProperty({path: ex('part'), shape: TSub, contains: true})
      get part(): TSub {
        return null;
      }
    }
    expect(warnings()).toEqual([]);
    expect(TValueOk).toBeDefined();
  });

  test('a value shape registered after the override is compared once it is', () => {
    // Named by [package, name] before the shape registers, so the comparison waits for it.
    @linkedShape
    class TDeferred extends TBase {
      @objectProperty({path: ex('part'), shape: ['tighten-only-test', 'TLater'], contains: true})
      get part(): TBase {
        return null;
      }
    }
    expect(warnings()).toEqual([]);
    @linkedShape
    class TLater extends Shape {
      @literalProperty({path: ex('note')})
      get note(): string {
        return '';
      }
    }
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/TDeferred\.part .*value shape .*TLater is not/);
    expect([TDeferred, TLater]).toHaveLength(2);
  });

  test('contains: false drops ownership', () => {
    @linkedShape
    class TNoContains extends TBase {
      @objectProperty({path: ex('part'), shape: TBase, contains: false})
      get part(): TBase {
        return null;
      }
    }
    expect(warnings()).toEqual([expect.stringMatching(/TNoContains\.part .*contains cannot be dropped/)]);
    expect(getPropertyShape(TNoContains.shape, 'part')?.contains).toBeUndefined();
  });

  test('a changed path, and an inherited path under a new label', () => {
    @linkedShape
    class TPath extends TBase {
      @literalProperty({path: ex('otherCount'), maxCount: 1})
      get count(): number {
        return 0;
      }
      @literalProperty({path: ex('count')})
      get amount(): number {
        return 0;
      }
    }
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toMatch(/TPath\.count .*path cannot change/);
    expect(warnings()[1]).toMatch(/TPath\.amount .*already declared as the inherited property 'count'/);
    expect(TPath).toBeDefined();
  });

  test('the same warning is given once per shape and property', () => {
    @linkedShape
    class TOnce extends TBase {
      @literalProperty({path: ex('count'), datatype: xsd.string})
      get count(): number {
        return 0;
      }
    }
    // Re-registering the property (a module evaluated twice) does not warn again.
    linkedShape(class TOnce2 extends TOnce {});
    expect(warnings().filter((w) => w.includes('TOnce.count'))).toHaveLength(1);
  });

  test('a differing class is left to the shape check', () => {
    @linkedShape
    class TClass extends TBase {
      @objectProperty({path: ex('peer'), shape: TBase, class: ex('Other')})
      get peer(): TBase {
        return null;
      }
    }
    expect(warnings()).toEqual([]);
    expect(TClass).toBeDefined();
  });
});

describe('omitted constraints are inherited', () => {
  test('datatype, class, value shape and contains', () => {
    @linkedShape
    class TInherit extends TBase {
      @literalProperty({path: ex('count'), minCount: 1})
      get count(): number {
        return 0;
      }
      @objectProperty({path: ex('part'), minCount: 1})
      get part(): TBase {
        return null;
      }
      @objectProperty({path: ex('peer'), maxCount: 1})
      get peer(): TBase {
        return null;
      }
    }
    expect(warnings()).toEqual([]);
    const count = getPropertyShape(TInherit.shape, 'count')!;
    expect(count.datatype).toEqual(xsd.integer);
    expect(count.maxCount).toBe(1);
    const part = getPropertyShape(TInherit.shape, 'part')!;
    expect(part.valueShape).toEqual({id: TBase.shape.id});
    expect(part.contains).toBe(true);
    const peer = getPropertyShape(TInherit.shape, 'peer')!;
    expect(peer.class).toEqual(ex('TBase'));
    expect(peer.valueShape).toEqual({id: TBase.shape.id});
  });
});

describe('data-only shapes warn for every case', () => {
  const base = (): NodeShapeData => TBase.shape;
  const prop = (label: string, fields: Record<string, unknown>) => ({
    id: `http://example.org/tighten/shape/DataOnly/${label}`,
    label,
    ...fields,
  });

  test('all seven, never a throw', () => {
    const shape = {
      id: 'http://example.org/tighten/shape/DataOnly',
      label: 'DataOnly',
      extends: {id: base().id},
      targetClass: ex('DataOnly'),
      propertyShapes: [
        prop('count', {
          path: ex('otherCount'),
          datatype: xsd.string,
          maxCount: 3,
          minCount: 0,
          nodeKind: shacl.IRIOrLiteral,
        }),
        prop('part', {path: ex('part'), valueShape: {id: TUnrelated.shape.id}}),
        prop('copy', {path: ex('peer')}),
      ],
    } as unknown as NodeShapeData;
    expect(() => registerRuntimeShape(shape)).not.toThrow();
    const texts = warnings().join('\n');
    expect(texts).toMatch(/DataOnly\.count .*maxCount cannot be increased/);
    expect(texts).toMatch(/DataOnly\.count .*nodeKind cannot be widened/);
    expect(texts).toMatch(/DataOnly\.count .*datatype cannot change/);
    expect(texts).toMatch(/DataOnly\.count .*path cannot change/);
    expect(texts).toMatch(/DataOnly\.part .*value shape/);
    expect(texts).toMatch(/DataOnly\.part .*contains cannot be dropped/);
    expect(texts).toMatch(/DataOnly\.copy .*already declared as the inherited property 'peer'/);
  });

  test('a lowered minCount warns', () => {
    @linkedShape
    class TRequired extends Shape {
      static targetClass = ex('TRequired');
      @literalProperty({path: ex('name'), required: true})
      get name(): string {
        return '';
      }
    }
    registerRuntimeShape({
      id: 'http://example.org/tighten/shape/DataOnlyMin',
      label: 'DataOnlyMin',
      extends: {id: TRequired.shape.id},
      propertyShapes: [prop('name', {path: ex('name'), minCount: 0})],
    } as unknown as NodeShapeData);
    expect(warnings()).toEqual([expect.stringMatching(/DataOnlyMin\.name .*minCount cannot be lowered/)]);
  });

  test('a flattened copy of the inherited properties warns for nothing', () => {
    registerRuntimeShape({
      id: 'http://example.org/tighten/shape/Flat',
      label: 'Flat',
      extends: {id: base().id},
      propertyShapes: TBase.shape.propertyShapes.map((ps) => ({...ps, parentNodeShape: undefined})),
    } as unknown as NodeShapeData);
    expect(warnings()).toEqual([]);
  });
});
