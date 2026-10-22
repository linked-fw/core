/*
 * Tighten-only: an override (a property a sub-shape redeclares under an inherited label) may only
 * narrow the inherited property. Every widening of a decorated shape throws at registration;
 * omitted constraints are inherited; data-only shapes warn for every case.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {getPropertyShape, type NodeShapeData} from '../shapes/nodeShapeData';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import {getAllNodeShapes} from '../utils/ShapeClass';
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

describe('every widening throws at registration', () => {
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

  test('datatype changed', () => {
    expect(() => {
      @linkedShape
      class TDatatype extends TBase {
        @literalProperty({path: ex('count'), datatype: xsd.string})
        get count(): number {
          return 0;
        }
      }
      return TDatatype;
    }).toThrow(/^Invalid override for TDatatype\.count: datatype cannot change /);
    expect(warnings()).toEqual([]);
  });

  test('value shape that is not a sub-shape', () => {
    expect(() => {
      @linkedShape
      class TValue extends TBase {
        @objectProperty({path: ex('part'), shape: TUnrelated, contains: true})
        get part(): TBase {
          return null;
        }
      }
      return TValue;
    }).toThrow(/TValue\.part: value shape .*TUnrelated is not .*TBase or a sub-shape/);
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
    expect(TDeferred).toBeDefined();
    // A later override waiting on TLater too, which narrows correctly.
    @linkedShape
    class TDeferredOk extends TBase {
      @objectProperty({path: ex('part'), shape: ['tighten-only-test', 'TLater'], contains: true})
      get part(): TBase {
        return null;
      }
    }
    let later: typeof Shape | undefined;
    expect(() => {
      @linkedShape
      class TLater extends TBase {
        static targetClass = ex('TLater');
        @literalProperty({path: ex('note')})
        get note(): string {
          return '';
        }
      }
      later = TLater;
    }).not.toThrow();
    // TLater extends TBase, so both narrow: nothing thrown, both connected.
    expect(getPropertyShape(TDeferredOk.shape, 'part')?.valueShape).toEqual({id: later!.shape.id});

    @linkedShape
    class TDeferredBad extends TBase {
      @objectProperty({path: ex('part'), shape: ['tighten-only-test', 'TLaterBad'], contains: true})
      get part(): TBase {
        return null;
      }
    }
    @linkedShape
    class TDeferredBadOk extends TBase {
      @objectProperty({path: ex('part'), shape: ['tighten-only-test', 'TLaterBad']})
      get part(): TBase {
        return null;
      }
    }
    expect(() => {
      @linkedShape
      class TLaterBad extends Shape {
        static targetClass = ex('TLaterBad');
        @literalProperty({path: ex('note')})
        get note(): string {
          return '';
        }
      }
      return TLaterBad;
    }).toThrow(/TDeferredBad\.part: value shape .*TLaterBad is not/);
    // The value shape that triggered the comparison still registers completely.
    const laterBad = [...getAllNodeShapes().values()].find((n) => n.label === 'TLaterBad');
    expect(laterBad?.targetClass).toEqual(ex('TLaterBad'));
    expect(getPropertyShape(TDeferredBad.shape, 'part')?.valueShape).toEqual({id: laterBad?.id});
    expect(TDeferredBadOk).toBeDefined();
  });

  test('contains: false drops ownership', () => {
    expect(() => {
      @linkedShape
      class TNoContains extends TBase {
        @objectProperty({path: ex('part'), shape: TBase, contains: false})
        get part(): TBase {
          return null;
        }
      }
      return TNoContains;
    }).toThrow(/TNoContains\.part: contains cannot be dropped/);
  });

  test('a changed path', () => {
    expect(() => {
      @linkedShape
      class TPath extends TBase {
        @literalProperty({path: ex('otherCount'), maxCount: 1})
        get count(): number {
          return 0;
        }
      }
      return TPath;
    }).toThrow(/TPath\.count: path cannot change/);
  });

  test('an inherited path under a new label', () => {
    expect(() => {
      @linkedShape
      class TPathLabel extends TBase {
        @literalProperty({path: ex('count')})
        get amount(): number {
          return 0;
        }
      }
      return TPathLabel;
    }).toThrow(/TPathLabel\.amount: the path .* is already declared as the inherited property 'count'/);
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
