import {describe, expect, test} from '@jest/globals';
import {getPropertyShape} from '../shapes/SHACL';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {coreOntology} from '../ontologies/linked-core';
import {shacl} from '../ontologies/shacl';
import type {NodeReferenceValue} from '../utils/NodeReference';

const packageName = 'meta-test';
const {linkedShape, packageMetadata} = linkedPackage(packageName);

const tmpPropBase = 'linked://tmp/props/';
const tmpTypeBase = 'linked://tmp/types/';

const prop = (suffix: string): NodeReferenceValue => ({
  id: `${tmpPropBase}${suffix}`,
});
const type = (suffix: string): NodeReferenceValue => ({
  id: `${tmpTypeBase}${suffix}`,
});

@linkedShape
class MetaPerson extends Shape {
  static targetClass = type('MetaPerson');

  @literalProperty({path: prop('name'), maxCount: 1})
  get name(): string {
    return '';
  }
}

describe('Package & Shape Metadata Registration', () => {
  test('registers package metadata with the expected id', () => {
    expect(packageMetadata).toEqual({
      id: `https://linked.cm/pkg/${packageName}`,
      packageName,
      type: coreOntology.Package,
    });
    expect(globalThis['_linked']._packages[packageName]).toBe(packageMetadata);
  });

  test('registers node shape metadata with expected id', () => {
    // arch-02: {baseUri}shape/{packageSlug}/{ShapeName} — PascalCase shape name.
    const expectedId = `https://linked.cm/shape/${packageName}/${MetaPerson.name}`;

    expect(MetaPerson.shape).toBeDefined();
    expect(MetaPerson.shape.id).toBe(expectedId);
    expect(MetaPerson.shape.label).toBe(MetaPerson.name);
    expect(MetaPerson.shape.targetClass).toEqual(type('MetaPerson'));
  });

  test('registers property shape metadata with expected id', () => {
    const nodeShapeId = MetaPerson.shape.id;
    const propertyShape = getPropertyShape(MetaPerson.shape, 'name');

    expect(propertyShape).toBeDefined();
    expect(propertyShape.label).toBe('name');
    expect(propertyShape.id).toBe(`${nodeShapeId}/name`);
    expect(propertyShape.path).toEqual(prop('name'));
    expect(propertyShape.nodeKind).toEqual(shacl.Literal);
    expect(propertyShape.parentNodeShape).toBe(MetaPerson.shape);
  });

  test('allows override that omits min/max/nodeKind (inherits silently)', () => {
    expect(() => {
      @linkedShape
      class InheritBase extends Shape {
        static targetClass = type('InheritBase');

        @objectProperty({
          path: prop('link'),
          shape: InheritBase,
          required: true,
          maxCount: 1,
          nodeKind: shacl.BlankNodeOrIRI,
        })
        get link(): InheritBase {
          return null;
        }
      }

      @linkedShape
      class InheritChild extends InheritBase {
        static targetClass = type('InheritChild');

        @objectProperty({path: prop('link'), shape: InheritChild})
        get link(): InheritChild {
          return null;
        }
      }

      expect(getPropertyShape(InheritChild.shape, 'link', false).minCount).toBe(1);
      expect(getPropertyShape(InheritChild.shape, 'link', false).maxCount).toBe(1);
      expect(getPropertyShape(InheritChild.shape, 'link', false).nodeKind).toEqual(
        shacl.BlankNodeOrIRI,
      );
    }).not.toThrow();
  });

  test('throws when override lowers minCount', () => {
    expect(() => {
      @linkedShape
      class TightMinBase extends Shape {
        static targetClass = type('TightMinBase');

        @literalProperty({path: prop('code'), minCount: 2})
        get code(): string {
          return '';
        }
      }

      @linkedShape
      class TightMinChild extends TightMinBase {
        static targetClass = type('TightMinChild');

        @literalProperty({path: prop('code'), minCount: 1})
        get code(): string {
          return '';
        }
      }

      return TightMinChild;
    }).toThrow(/minCount cannot be lowered/);
  });

  test('throws when override increases maxCount', () => {
    expect(() => {
      @linkedShape
      class TightMaxBase extends Shape {
        static targetClass = type('TightMaxBase');

        @literalProperty({path: prop('code'), maxCount: 1})
        get code(): string {
          return '';
        }
      }

      @linkedShape
      class TightMaxChild extends TightMaxBase {
        static targetClass = type('TightMaxChild');

        @literalProperty({path: prop('code'), maxCount: 2})
        get code(): string {
          return '';
        }
      }

      return TightMaxChild;
    }).toThrow(/maxCount cannot be increased/);
  });

  test('respects explicit zero minCount and maxCount', () => {
    @linkedShape
    class ZeroCountShape extends Shape {
      static targetClass = type('ZeroCountShape');

      @literalProperty({path: prop('zeroLimited'), minCount: 0, maxCount: 0})
      get zeroLimited(): string {
        return '';
      }
    }

    const zeroLimited = getPropertyShape(ZeroCountShape.shape, 'zeroLimited');
    expect(zeroLimited.minCount).toBe(0);
    expect(zeroLimited.maxCount).toBe(0);
  });

  test('throws when override increases explicit zero maxCount', () => {
    expect(() => {
      @linkedShape
      class ZeroMaxBase extends Shape {
        static targetClass = type('ZeroMaxBase');

        @literalProperty({path: prop('locked'), maxCount: 0})
        get locked(): string {
          return '';
        }
      }

      @linkedShape
      class ZeroMaxChild extends ZeroMaxBase {
        static targetClass = type('ZeroMaxChild');

        @literalProperty({path: prop('locked'), maxCount: 1})
        get locked(): string {
          return '';
        }
      }

      return ZeroMaxChild;
    }).toThrow(/maxCount cannot be increased/);
  });

  test('throws when override widens nodeKind', () => {
    expect(() => {
      @linkedShape
      class NodeKindBase extends Shape {
        static targetClass = type('NodeKindBase');

        @objectProperty({
          path: prop('ref'),
          shape: NodeKindBase,
          nodeKind: shacl.BlankNodeOrIRI,
        })
        get ref(): NodeKindBase {
          return null;
        }
      }

      @linkedShape
      class NodeKindChild extends NodeKindBase {
        static targetClass = type('NodeKindChild');

        @objectProperty({
          path: prop('ref'),
          shape: NodeKindChild,
          nodeKind: shacl.IRIOrLiteral,
        })
        get ref(): NodeKindChild {
          return null;
        }
      }

      return NodeKindChild;
    }).toThrow(/nodeKind cannot be widened/);
  });

  test('allows override that tightens nodeKind', () => {
    expect(() => {
      @linkedShape
      class NodeKindTightenBase extends Shape {
        static targetClass = type('NodeKindTightenBase');

        @objectProperty({
          path: prop('target'),
          shape: NodeKindTightenBase,
          nodeKind: shacl.BlankNodeOrIRI,
        })
        get target(): NodeKindTightenBase {
          return null;
        }
      }

      @linkedShape
      class NodeKindTightenChild extends NodeKindTightenBase {
        static targetClass = type('NodeKindTightenChild');

        @objectProperty({
          path: prop('target'),
          shape: NodeKindTightenChild,
          nodeKind: shacl.IRI,
        })
        get target(): NodeKindTightenChild {
          return null;
        }
      }

      expect(
        getPropertyShape(NodeKindTightenChild.shape, 'target', false).nodeKind,
      ).toEqual(shacl.IRI);
    }).not.toThrow();
  });

  test('allows mixed override: tighten minCount while maxCount/nodeKind inherit', () => {
    expect(() => {
      @linkedShape
      class MixedInheritBase extends Shape {
        static targetClass = type('MixedInheritBase');

        @objectProperty({
          path: prop('member'),
          shape: MixedInheritBase,
          minCount: 1,
          maxCount: 3,
          nodeKind: shacl.BlankNodeOrIRI,
        })
        get member(): MixedInheritBase {
          return null;
        }
      }

      @linkedShape
      class MixedInheritChild extends MixedInheritBase {
        static targetClass = type('MixedInheritChild');

        @objectProperty({
          path: prop('member'),
          shape: MixedInheritChild,
          minCount: 2,
        })
        get member(): MixedInheritChild {
          return null;
        }
      }

      const member = getPropertyShape(MixedInheritChild.shape, 'member', false);
      expect(member.minCount).toBe(2);
      expect(member.maxCount).toBe(3);
      expect(member.nodeKind).toEqual(shacl.BlankNodeOrIRI);
    }).not.toThrow();
  });
});
