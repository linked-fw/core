/**
 * Integration tests: shape decorator → FieldSet → desugar → lower → algebra → SPARQL string.
 *
 * Verifies the full pipeline from @literalProperty / @objectProperty decorators
 * with complex property paths through to the final SPARQL SELECT output.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {ShapeSet} from '../collections/ShapeSet';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';
import {setQueryContext} from '../queries/QueryContext';
import {NodeReferenceValue} from '../queries/QueryFactory';

// Ensure prefixes are registered
import '../ontologies/rdf';
import '../ontologies/xsd';
import '../ontologies/rdfs';

// ---------------------------------------------------------------------------
// Property references used in test shapes
// ---------------------------------------------------------------------------

const testBase = 'linked://path-integration/';
const prop = (suffix: string): NodeReferenceValue => ({id: `${testBase}${suffix}`});
const cls = (suffix: string): NodeReferenceValue => ({id: `${testBase}type/${suffix}`});

// ---------------------------------------------------------------------------
// Test shapes with complex paths
// ---------------------------------------------------------------------------

const memberProp = prop('member');
const roleProp = prop('role');
const labelProp = prop('label');

@linkedShape
class RoleShape extends Shape {
  static targetClass = cls('Role');

  @literalProperty({path: labelProp, maxCount: 1})
  get caption(): string {
    return '';
  }
}

@linkedShape
class OrgShape extends Shape {
  static targetClass = cls('Organization');

  // Complex sequence path: member / role
  @objectProperty({
    path: {seq: [{id: `${testBase}member`}, {id: `${testBase}role`}]},
    shape: RoleShape,
  })
  get memberRoles(): ShapeSet<RoleShape> {
    return null;
  }
}

// Shapes using {id} refs (standard full-IRI paths) for backward compat
@linkedShape
class SimplePersonShape extends Shape {
  static targetClass = cls('SimplePerson');

  @literalProperty({path: prop('name'), maxCount: 1})
  get name(): string {
    return '';
  }
}

// Shape with inverse path
@linkedShape
class ChildShape extends Shape {
  static targetClass = cls('Child');

  @literalProperty({
    path: {seq: [{inv: {id: `${testBase}parent`}}, {id: `${testBase}name`}]},
    maxCount: 1,
  })
  get parentName(): string {
    return '';
  }
}

// Shape with alternative path
@linkedShape
class ContactShape extends Shape {
  static targetClass = cls('Contact');

  @literalProperty({
    path: {alt: [{id: `${testBase}email`}, {id: `${testBase}phone`}]},
  })
  get contactInfo(): string[] {
    return [];
  }
}

// Set query context (required for query pipeline)
setQueryContext('user', {id: 'test-user'}, SimplePersonShape);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const goldenSelect = async (
  factory: () => Promise<unknown>,
): Promise<string> => {
  const ir = await captureQuery(factory);
  return selectToSparql(ir);
};

// Shape URI prefix used in generated IDs
const O = 'https://linked.cm/shape/core/OrgShape';
const R = 'https://linked.cm/shape/core/RoleShape';
const SP = 'https://linked.cm/shape/core/SimplePersonShape';
const CH = 'https://linked.cm/shape/core/ChildShape';
const CO = 'https://linked.cm/shape/core/ContactShape';

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('property path integration — decorator to SPARQL', () => {
  test('sequence path on object property', async () => {
    const sparql = await goldenSelect(() => OrgShape.select((p) => p.memberRoles));
    // The sequence path should appear as a property path in the traversal triple
    expect(sparql).toContain(`<${testBase}member>/<${testBase}role>`);
    // Type triple should be present
    expect(sparql).toContain('rdf:type');
    expect(sparql).toContain('PREFIX rdf:');
  });

  test('sequence path with nested property selection', async () => {
    const sparql = await goldenSelect(() =>
      OrgShape.select((p) => p.memberRoles.caption),
    );
    // Should have the complex path for the memberRoles traversal
    expect(sparql).toContain(`<${testBase}member>/<${testBase}role>`);
    // Should have the simple property for label
    expect(sparql).toContain(`<${testBase}label>`);
  });

  test('inverse path in decorator', async () => {
    const sparql = await goldenSelect(() =>
      ChildShape.select((p) => p.parentName),
    );
    // Should have inverse + sequence path
    expect(sparql).toContain(`^<${testBase}parent>/<${testBase}name>`);
  });

  test('alternative path in decorator', async () => {
    const sparql = await goldenSelect(() =>
      ContactShape.select((p) => p.contactInfo),
    );
    // Should have alternative path
    expect(sparql).toContain(`<${testBase}email>|<${testBase}phone>`);
  });

  test('backward compat — simple {id} path produces standard SPARQL', async () => {
    const sparql = await goldenSelect(() =>
      SimplePersonShape.select((p) => p.name),
    );
    // Simple paths should still use standard IRI format (not path syntax)
    expect(sparql).toContain(`<${testBase}name>`);
    // Should NOT contain property path operators
    expect(sparql).not.toMatch(/[/|^*+?!]<.*?>[/|^*+?!]/);
  });

  test('sortBy with complex path intermediate step', async () => {
    const sparql = await goldenSelect(() =>
      OrgShape.select((p) => p.memberRoles.caption).orderBy(
        (p) => p.memberRoles.caption,
      ),
    );
    // The complex path should be used in the traversal, not the raw propertyShapeId
    expect(sparql).toContain(`<${testBase}member>/<${testBase}role>`);
    expect(sparql).toContain('ORDER BY ASC(');
  });

  test('where filter on complex-path property', async () => {
    const sparql = await goldenSelect(() =>
      OrgShape.select((p) =>
        p.memberRoles.where((r) => r.caption.equals('Admin')),
      ),
    );
    // Complex path in traversal
    expect(sparql).toContain(`<${testBase}member>/<${testBase}role>`);
    // Where filter with literal comparison
    expect(sparql).toContain('"Admin"');
  });
});
