import {describe, expect, test} from '@jest/globals';
import {
  Employee,
  Person,
  queryFactories,
  tmpEntityBase,
  propBase,
} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToAlgebra} from '../sparql/irToAlgebra';
import {setQueryContext} from '../queries/QueryContext';
import type {IRSelectQuery} from '../queries/IntermediateRepresentation';
import type {
  SparqlSelectPlan,
  SparqlBGP,
  SparqlLeftJoin,
  SparqlFilter,
  SparqlTriple,
  SparqlAlgebraNode,
  SparqlExpression,
  SparqlExistsExpr,
  SparqlUnion,
} from '../sparql/SparqlAlgebra';

// Ensure prefixes are registered
import '../ontologies/rdf';
import '../ontologies/xsd';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
// Property predicates are the declared `sh:path`, not derived from the shape IRI.
const PROP = propBase;

setQueryContext('user', {id: 'user-1'}, Person);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const captureIR = async (
  runner: () => Promise<unknown>,
): Promise<IRSelectQuery> => {
  return await captureQuery(runner) as IRSelectQuery;
};

const capturePlan = async (
  runner: () => Promise<unknown>,
): Promise<SparqlSelectPlan> => {
  const ir = await captureIR(runner);
  return selectToAlgebra(ir);
};

/** Collect all triples from the algebra tree, regardless of nesting. */
function collectAllTriples(node: SparqlAlgebraNode): SparqlTriple[] {
  const triples: SparqlTriple[] = [];
  walkAlgebra(node, (n) => {
    if (n.type === 'bgp') {
      triples.push(...(n as SparqlBGP).triples);
    }
  });
  return triples;
}

/** Collect all triples that are inside LeftJoin (OPTIONAL) right-hand sides. */
function collectOptionalTriples(node: SparqlAlgebraNode): SparqlTriple[] {
  const triples: SparqlTriple[] = [];
  const seenBgps = new Set<SparqlAlgebraNode>();
  walkAlgebra(node, (n) => {
    if (n.type === 'left_join') {
      const lj = n as SparqlLeftJoin;
      // Collect triples from the right-hand side (the optional part)
      walkAlgebra(lj.right, (inner) => {
        if (inner.type === 'bgp' && !seenBgps.has(inner)) {
          seenBgps.add(inner);
          triples.push(...(inner as SparqlBGP).triples);
        }
      });
    }
  });
  return triples;
}

/** Collect all Filter nodes from the algebra tree. */
function collectFilters(node: SparqlAlgebraNode): SparqlFilter[] {
  const filters: SparqlFilter[] = [];
  walkAlgebra(node, (n) => {
    if (n.type === 'filter') {
      filters.push(n as SparqlFilter);
    }
  });
  return filters;
}

/** Walk the algebra tree and call visitor for each node. */
function walkAlgebra(
  node: SparqlAlgebraNode,
  visitor: (n: SparqlAlgebraNode) => void,
): void {
  visitor(node);
  switch (node.type) {
    case 'bgp':
      break;
    case 'join':
      walkAlgebra(node.left, visitor);
      walkAlgebra(node.right, visitor);
      break;
    case 'left_join':
      walkAlgebra(node.left, visitor);
      walkAlgebra(node.right, visitor);
      break;
    case 'filter':
      walkAlgebra(node.inner, visitor);
      break;
    case 'union':
      walkAlgebra(node.left, visitor);
      walkAlgebra(node.right, visitor);
      break;
    case 'minus':
      walkAlgebra(node.left, visitor);
      walkAlgebra(node.right, visitor);
      break;
    case 'extend':
      walkAlgebra(node.inner, visitor);
      break;
    case 'graph':
      walkAlgebra(node.inner, visitor);
      break;
  }
}

/** Find a triple by predicate URI. */
function findTripleByPredicate(
  triples: SparqlTriple[],
  predicateUri: string,
): SparqlTriple | undefined {
  return triples.find(
    (t) => t.predicate.kind === 'iri' && t.predicate.value === predicateUri,
  );
}

/** Count triples with a given predicate URI. */
function countTriplesByPredicate(
  triples: SparqlTriple[],
  predicateUri: string,
): number {
  return triples.filter(
    (t) => t.predicate.kind === 'iri' && t.predicate.value === predicateUri,
  ).length;
}

/** Find the innermost algebra node (strip away Filter wrappers). */
function stripFilters(node: SparqlAlgebraNode): SparqlAlgebraNode {
  if (node.type === 'filter') {
    return stripFilters(node.inner);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectToAlgebra — basic selection', () => {
  test('selectName produces correct algebra', async () => {
    const plan = await capturePlan(() => queryFactories.selectName());

    expect(plan.type).toBe('select');

    // Find the type triple
    const allTriples = collectAllTriples(plan.algebra);
    const typeTriple = findTripleByPredicate(allTriples, RDF_TYPE);
    expect(typeTriple).toBeDefined();
    expect(typeTriple!.subject).toEqual({kind: 'variable', name: 'a0'});
    // The type triple carries the shape's declared targetClass — the class node
    // instances are typed with — not the shape's own IRI.
    expect(typeTriple!.object).toEqual({kind: 'iri', value: Person.targetClass.id});

    // Property triple should be in OPTIONAL (LeftJoin)
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(optionalTriples.length).toBeGreaterThanOrEqual(1);

    // Check that there's a property triple for `name`
    const nameTriple = optionalTriples.find(
      (t) =>
        t.subject.kind === 'variable' &&
        t.subject.name === 'a0' &&
        t.object.kind === 'variable',
    );
    expect(nameTriple).toBeDefined();

    // Projection includes root variable and property variable
    expect(plan.projection.length).toBeGreaterThanOrEqual(2);
    expect(plan.projection[0]).toEqual({kind: 'variable', name: 'a0'});

    // No groupBy, no orderBy, no limit
    expect(plan.groupBy).toBeUndefined();
    expect(plan.orderBy).toBeUndefined();
    expect(plan.limit).toBeUndefined();

    // DISTINCT should be set
    expect(plan.distinct).toBe(true);
  });

  test('selectAll produces minimal algebra', async () => {
    const plan = await capturePlan(() => queryFactories.selectAll());

    expect(plan.type).toBe('select');

    // Should have at least a type triple
    const allTriples = collectAllTriples(plan.algebra);
    const typeTriple = findTripleByPredicate(allTriples, RDF_TYPE);
    expect(typeTriple).toBeDefined();

    // Projection includes root variable (selectAll with no selections returns only id)
    expect(plan.projection[0]).toEqual({kind: 'variable', name: 'a0'});
  });

  test('selectAllProperties produces OPTIONAL triples for all properties', async () => {
    const plan = await capturePlan(() => queryFactories.selectAllProperties());

    expect(plan.type).toBe('select');

    // Should have many optional triples (one per property)
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(optionalTriples.length).toBeGreaterThanOrEqual(5);

    // Each optional triple should have the root variable as subject
    for (const t of optionalTriples) {
      expect(t.subject).toEqual({kind: 'variable', name: 'a0'});
    }
  });
});

describe('selectToAlgebra — nested traversals', () => {
  test('selectFriendsName produces traverse + property triple', async () => {
    const plan = await capturePlan(() => queryFactories.selectFriendsName());

    const allTriples = collectAllTriples(plan.algebra);

    // Type triple for root
    const typeTriple = findTripleByPredicate(allTriples, RDF_TYPE);
    expect(typeTriple).toBeDefined();
    expect(typeTriple!.subject).toEqual({kind: 'variable', name: 'a0'});

    // Traverse triple: ?a0 <hasFriend-property> ?a1
    // The traverse creates a required triple in the BGP
    const traverseTriples = allTriples.filter(
      (t) =>
        t.subject.kind === 'variable' &&
        t.subject.name === 'a0' &&
        t.predicate.kind === 'iri' &&
        t.predicate.value !== RDF_TYPE &&
        t.object.kind === 'variable',
    );
    expect(traverseTriples.length).toBeGreaterThanOrEqual(1);

    // OPTIONAL property triple for name on the traversed alias
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(optionalTriples.length).toBeGreaterThanOrEqual(1);
  });

  test('selectDuplicatePaths has one traverse and three property triples', async () => {
    const plan = await capturePlan(() =>
      queryFactories.selectDuplicatePaths(),
    );

    const allTriples = collectAllTriples(plan.algebra);

    // Find traverse triples (non-rdf:type, non-optional)
    // In the required BGP, we should have: type triple + ONE traverse triple
    const innerAlgebra = stripFilters(plan.algebra);
    // Walk to find the root BGP (it's inside the LeftJoins)
    let rootBgp: SparqlBGP | null = null;
    walkAlgebra(innerAlgebra, (n) => {
      if (n.type === 'bgp' && !rootBgp) {
        const bgp = n as SparqlBGP;
        // The root BGP has the type triple
        if (bgp.triples.some((t) => t.predicate.kind === 'iri' && t.predicate.value === RDF_TYPE)) {
          rootBgp = bgp;
        }
      }
    });

    expect(rootBgp).not.toBeNull();
    // Root BGP should contain only the type triple; the nullable bestFriend
    // traverse now lives inside a nested OPTIONAL subtree.
    const traverseInBgp = rootBgp!.triples.filter(
      (t) => t.predicate.kind === 'iri' && t.predicate.value !== RDF_TYPE,
    );
    expect(traverseInBgp.length).toBe(0);

    // Three nested OPTIONAL property triples on alias a1 + the parent traverse
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(optionalTriples.length).toBe(4);

    const bestFriendTraverse = optionalTriples.find(
      (t) =>
        t.subject.kind === 'variable' &&
        t.subject.name === 'a0' &&
        t.predicate.kind === 'iri' &&
        t.predicate.value === `${PROP}bestFriend` &&
        t.object.kind === 'variable' &&
        t.object.name === 'a1',
    );
    expect(bestFriendTraverse).toBeDefined();

    // Each should reference the traversed alias (a1)
    const a1PropertyTriples = optionalTriples.filter(
      (t) => t.subject.kind === 'variable' && t.subject.name === 'a1',
    );
    expect(a1PropertyTriples.length).toBe(3);
    for (const t of a1PropertyTriples) {
      expect(t.subject.kind).toBe('variable');
      expect((t.subject as any).name).toBe('a1');
    }

    // Each should have distinct variable names
    const objectNames = a1PropertyTriples.map(
      (t) => t.object.kind === 'variable' ? t.object.name : '',
    );
    const uniqueNames = new Set(objectNames);
    expect(uniqueNames.size).toBe(3);
  });

  test('selectBestFriendName nests a nullable single-value traversal under OPTIONAL', async () => {
    const plan = await capturePlan(() => queryFactories.selectBestFriendName());

    const allTriples = collectAllTriples(plan.algebra);
    const requiredBestFriendTriples = allTriples.filter(
      (t) =>
        t.subject.kind === 'variable' &&
        t.subject.name === 'a0' &&
        t.predicate.kind === 'iri' &&
        t.predicate.value === `${PROP}bestFriend` &&
        t.object.kind === 'variable' &&
        t.object.name === 'a1',
    );
    expect(requiredBestFriendTriples.length).toBe(1);

    const innerAlgebra = stripFilters(plan.algebra);
    let rootBgp: SparqlBGP | null = null;
    walkAlgebra(innerAlgebra, (n) => {
      if (n.type === 'bgp' && !rootBgp) {
        const bgp = n as SparqlBGP;
        if (bgp.triples.some((t) => t.predicate.kind === 'iri' && t.predicate.value === RDF_TYPE)) {
          rootBgp = bgp;
        }
      }
    });
    expect(rootBgp).not.toBeNull();
    expect(
      rootBgp!.triples.some(
        (t) =>
          t.predicate.kind === 'iri' &&
          t.predicate.value === `${PROP}bestFriend`,
      ),
    ).toBe(false);

    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(
      optionalTriples.some(
        (t) =>
          t.subject.kind === 'variable' &&
          t.subject.name === 'a0' &&
          t.predicate.kind === 'iri' &&
          t.predicate.value === `${PROP}bestFriend`,
      ),
    ).toBe(true);
    expect(
      optionalTriples.some(
        (t) =>
          t.subject.kind === 'variable' &&
          t.subject.name === 'a1' &&
          t.predicate.kind === 'iri' &&
          t.predicate.value === `${PROP}name`,
      ),
    ).toBe(true);
  });

  test('selectFriendsName nests a multi-valued traversal under OPTIONAL', async () => {
    // friends is a multi-valued ShapeSet (no maxCount). A projection-only
    // multi-valued traversal must be lowered to a nested OPTIONAL so a parent
    // with no friends is preserved (friends: []) rather than inner-joined away.
    const plan = await capturePlan(() => queryFactories.selectFriendsName());

    // The friends traverse must NOT sit in the required root BGP.
    const innerAlgebra = stripFilters(plan.algebra);
    let rootBgp: SparqlBGP | null = null;
    walkAlgebra(innerAlgebra, (n) => {
      if (n.type === 'bgp' && !rootBgp) {
        const bgp = n as SparqlBGP;
        if (bgp.triples.some((t) => t.predicate.kind === 'iri' && t.predicate.value === RDF_TYPE)) {
          rootBgp = bgp;
        }
      }
    });
    expect(rootBgp).not.toBeNull();
    expect(
      rootBgp!.triples.some(
        (t) =>
          t.predicate.kind === 'iri' &&
          t.predicate.value === `${PROP}hasFriend`,
      ),
    ).toBe(false);

    // The friends traverse and the child name property both live inside OPTIONAL.
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(
      optionalTriples.some(
        (t) =>
          t.subject.kind === 'variable' &&
          t.subject.name === 'a0' &&
          t.predicate.kind === 'iri' &&
          t.predicate.value === `${PROP}hasFriend` &&
          t.object.kind === 'variable' &&
          t.object.name === 'a1',
      ),
    ).toBe(true);
    expect(
      optionalTriples.some(
        (t) =>
          t.subject.kind === 'variable' &&
          t.subject.name === 'a1' &&
          t.predicate.kind === 'iri' &&
          t.predicate.value === `${PROP}name`,
      ),
    ).toBe(true);
  });

  test('selectDeepNested produces multiple traverse triples', async () => {
    const plan = await capturePlan(() => queryFactories.selectDeepNested());

    const allTriples = collectAllTriples(plan.algebra);

    // Should have type triple + at least 3 traverse triples
    const nonTypeTriples = allTriples.filter(
      (t) => !(t.predicate.kind === 'iri' && t.predicate.value === RDF_TYPE),
    );
    // At least 3 required traversals + potentially optional property triples
    expect(nonTypeTriples.length).toBeGreaterThanOrEqual(3);
  });
});

describe('selectToAlgebra — where clauses', () => {
  test('whereHobbyEquals encodes inline where as projection expression', async () => {
    // Person.select((p) => p.hobby.where((h) => h.equals('Jogging')))
    // The inline .where() is lowered into the projection expression (not query.where)
    const plan = await capturePlan(() => queryFactories.whereHobbyEquals());

    expect(plan.type).toBe('select');
    // Should have at least one projection item with a binary expression
    const projExpressions = plan.projection
      .filter((p): p is {kind: 'variable'; name: string} => p.kind === 'variable')
      .map((p) => p.name);
    // The IR embeds the binary_expr inside the projection, which gets converted
    // The algebra builder converts the binary_expr in the projection to variables
    expect(plan.projection.length).toBeGreaterThanOrEqual(2); // root + expression
  });

  test('whereAnd encodes inline where with AND as projection expression', async () => {
    // Person.select((p) => p.friends.where((f) => f.name.equals('Moa').and(f.hobby.equals('Jogging'))))
    // The inline .where() is lowered into the projection expression
    const plan = await capturePlan(() => queryFactories.whereAnd());

    expect(plan.type).toBe('select');
    expect(plan.projection.length).toBeGreaterThanOrEqual(2);
  });

  test('whereOr encodes inline where with OR as projection expression', async () => {
    // Person.select((p) => p.friends.where((f) => f.name.equals('Jinx').or(f.hobby.equals('Jogging'))))
    const plan = await capturePlan(() => queryFactories.whereOr());

    expect(plan.type).toBe('select');
    expect(plan.projection.length).toBeGreaterThanOrEqual(2);
  });

  test('whereAndOrAnd encodes nested AND/OR as projection expression', async () => {
    const plan = await capturePlan(() => queryFactories.whereAndOrAnd());

    expect(plan.type).toBe('select');
    expect(plan.projection.length).toBeGreaterThanOrEqual(2);
  });

  test('whereSomeExplicit produces exists expression', async () => {
    const plan = await capturePlan(() => queryFactories.whereSomeExplicit());

    const filters = collectFilters(plan.algebra);
    expect(filters.length).toBeGreaterThanOrEqual(1);

    const existsFilter = filters.find(
      (f) => f.expression.kind === 'exists_expr',
    );
    expect(existsFilter).toBeDefined();

    const expr = existsFilter!.expression;
    if (expr.kind === 'exists_expr') {
      expect(expr.negated).toBe(false);
      // The inner pattern should contain triples (traverse to friends)
      const innerTriples = collectAllTriples(expr.pattern);
      expect(innerTriples.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('whereEvery produces NOT EXISTS pattern', async () => {
    const plan = await capturePlan(() => queryFactories.whereEvery());

    const filters = collectFilters(plan.algebra);
    expect(filters.length).toBeGreaterThanOrEqual(1);

    // whereEvery in IR is a `not_expr` wrapping an `exists_expr`
    const notFilter = filters.find(
      (f) => f.expression.kind === 'not_expr',
    );
    expect(notFilter).toBeDefined();

    if (notFilter) {
      const notExpr = notFilter.expression;
      if (notExpr.kind === 'not_expr') {
        // The inner should be an exists_expr
        expect(notExpr.inner.kind).toBe('exists_expr');
      }
    }
  });

  test('selectWhereNameSemmy has filter for name equals Semmy', async () => {
    const plan = await capturePlan(() =>
      queryFactories.selectWhereNameSemmy(),
    );

    const filters = collectFilters(plan.algebra);
    expect(filters.length).toBeGreaterThanOrEqual(1);

    // At least one filter should be a binary expression
    const binaryFilter = filters.find(
      (f) => f.expression.kind === 'binary_expr',
    );
    expect(binaryFilter).toBeDefined();

    const allTriples = collectAllTriples(plan.algebra);
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(allTriples, `${PROP}name`)).toBe(1);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}name`)).toBe(0);
  });

  test('outerWhere has Filter wrapping the entire pattern', async () => {
    const plan = await capturePlan(() => queryFactories.outerWhere());

    // Filter should be at or near the top of the algebra
    const filters = collectFilters(plan.algebra);
    expect(filters.length).toBeGreaterThanOrEqual(1);

    // The filter expression should reference the root alias's name property
    const binaryFilter = filters.find(
      (f) => f.expression.kind === 'binary_expr',
    );
    expect(binaryFilter).toBeDefined();

    if (binaryFilter && binaryFilter.expression.kind === 'binary_expr') {
      // Left side should be a variable referencing name on root alias
      expect(binaryFilter.expression.left.kind).toBe('variable_expr');
    }

    const allTriples = collectAllTriples(plan.algebra);
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(allTriples, `${PROP}name`)).toBe(1);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}name`)).toBe(0);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}hasFriend`)).toBe(1);
  });

  test('outerWhereLimit promotes same-property OR to a required triple', async () => {
    const plan = await capturePlan(() => queryFactories.outerWhereLimit());

    const allTriples = collectAllTriples(plan.algebra);
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(allTriples, `${PROP}name`)).toBe(1);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}name`)).toBe(0);
  });

  test('outerWhereDifferentPropsOr keeps both properties optional', async () => {
    const plan = await capturePlan(() => queryFactories.outerWhereDifferentPropsOr());

    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}name`)).toBe(1);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}hobby`)).toBe(1);
  });

  test('whereWithContext keeps projection optional but promotes filter binding', async () => {
    const plan = await capturePlan(() => queryFactories.whereWithContext());

    const allTriples = collectAllTriples(plan.algebra);
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(allTriples, `${PROP}bestFriend`)).toBe(1);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}bestFriend`)).toBe(0);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}name`)).toBe(1);
  });

  test('whereSomeImplicit promotes the traversed filter property to required', async () => {
    const plan = await capturePlan(() => queryFactories.whereSomeImplicit());

    const allTriples = collectAllTriples(plan.algebra);
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(allTriples, `${PROP}hasFriend`)).toBe(1);
    expect(countTriplesByPredicate(allTriples, `${PROP}name`)).toBe(1);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}name`)).toBe(0);
  });

  test('whereExprStrlen promotes function-filter property bindings to required', async () => {
    const plan = await capturePlan(() => queryFactories.whereExprStrlen());

    const allTriples = collectAllTriples(plan.algebra);
    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(allTriples, `${PROP}name`)).toBe(1);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}name`)).toBe(0);
  });

  test('countEquals keeps aggregate inputs optional', async () => {
    const plan = await capturePlan(() => queryFactories.countEquals());

    const optionalTriples = collectOptionalTriples(plan.algebra);
    expect(countTriplesByPredicate(optionalTriples, `${PROP}hasFriend`)).toBe(1);
  });
});

describe('selectToAlgebra — aggregates and GROUP BY', () => {
  test('countFriends produces aggregate + GROUP BY', async () => {
    const plan = await capturePlan(() => queryFactories.countFriends());

    // Should have aggregates
    expect(plan.aggregates).toBeDefined();
    expect(plan.aggregates!.length).toBeGreaterThanOrEqual(1);

    // The aggregate should be COUNT
    const countAgg = plan.aggregates!.find(
      (a) => a.aggregate.name === 'count',
    );
    expect(countAgg).toBeDefined();

    // GROUP BY should include the root alias
    expect(plan.groupBy).toBeDefined();
    expect(plan.groupBy).toContain('a0');

    // Projection should include the aggregate
    const aggProjection = plan.projection.find(
      (p) => p.kind === 'aggregate',
    );
    expect(aggProjection).toBeDefined();
  });

  test('countNestedFriends produces aggregate on nested path', async () => {
    const plan = await capturePlan(() =>
      queryFactories.countNestedFriends(),
    );

    expect(plan.aggregates).toBeDefined();
    expect(plan.aggregates!.length).toBeGreaterThanOrEqual(1);
    expect(plan.groupBy).toBeDefined();
    expect(plan.groupBy).toContain('a0');
  });

  test('customResultNumFriends produces named aggregate', async () => {
    const plan = await capturePlan(() =>
      queryFactories.customResultNumFriends(),
    );

    expect(plan.aggregates).toBeDefined();
    const aggProjection = plan.projection.find(
      (p) => p.kind === 'aggregate',
    );
    expect(aggProjection).toBeDefined();
  });
});

describe('selectToAlgebra — subjectId handling', () => {
  test('selectById produces subjectId Filter', async () => {
    const plan = await capturePlan(() => queryFactories.selectById());

    // Should have a filter for the subjectId
    const filters = collectFilters(plan.algebra);

    // Find the subjectId filter (binary expr with IRI on right)
    const subjectFilter = filters.find((f) => {
      if (f.expression.kind === 'binary_expr') {
        return (
          f.expression.op === '=' &&
          f.expression.right.kind === 'iri_expr' &&
          f.expression.right.value === `${tmpEntityBase}p1`
        );
      }
      return false;
    });
    expect(subjectFilter).toBeDefined();
  });

  test('selectOne produces subjectId-like filter from where clause', async () => {
    const plan = await capturePlan(() => queryFactories.selectOne());

    const filters = collectFilters(plan.algebra);
    expect(filters.length).toBeGreaterThanOrEqual(1);
  });
});

describe('selectToAlgebra — ordering and pagination', () => {
  test('sortByAsc produces orderBy with ASC', async () => {
    const plan = await capturePlan(() => queryFactories.sortByAsc());

    // A bound-first key, then the value: a missing value sorts last.
    expect(plan.orderBy).toEqual([
      {expression: {kind: 'bound_expr', variable: 'a0_name'}, direction: 'DESC'},
      {expression: {kind: 'variable_expr', name: 'a0_name'}, direction: 'ASC'},
    ]);
  });

  test('sortByDesc produces orderBy with DESC', async () => {
    const plan = await capturePlan(() => queryFactories.sortByDesc());

    expect(plan.orderBy).toEqual([
      {expression: {kind: 'bound_expr', variable: 'a0_name'}, direction: 'DESC'},
      {expression: {kind: 'variable_expr', name: 'a0_name'}, direction: 'DESC'},
    ]);
  });

  test('outerWhereLimit has limit and Filter', async () => {
    const plan = await capturePlan(() => queryFactories.outerWhereLimit());

    expect(plan.limit).toBe(1);

    const filters = collectFilters(plan.algebra);
    expect(filters.length).toBeGreaterThanOrEqual(1);
  });
});

describe('selectToAlgebra — variable reuse and deduplication', () => {
  test('property_expr matching traverse reuses variable', async () => {
    // selectFriendsName: traverse from a0 to a1 via hasFriend,
    // then property_expr on a1 for name
    const plan = await capturePlan(() => queryFactories.selectFriendsName());

    const allTriples = collectAllTriples(plan.algebra);

    // The traverse triple should appear exactly once
    const traverseTriples = allTriples.filter(
      (t) =>
        t.subject.kind === 'variable' &&
        t.subject.name === 'a0' &&
        t.predicate.kind === 'iri' &&
        t.predicate.value !== RDF_TYPE &&
        t.object.kind === 'variable',
    );
    // Should be exactly one traverse triple from a0
    expect(traverseTriples.length).toBe(1);
    expect(traverseTriples[0].object).toEqual({kind: 'variable', name: 'a1'});
  });

  test('multiple property_expr on same alias create distinct variables', async () => {
    const plan = await capturePlan(() =>
      queryFactories.selectDuplicatePaths(),
    );

    const optionalTriples = collectOptionalTriples(plan.algebra);

    // All three should be on alias a1
    const a1Triples = optionalTriples.filter(
      (t) => t.subject.kind === 'variable' && t.subject.name === 'a1',
    );
    expect(a1Triples.length).toBe(3);

    // Each should have a unique object variable name
    const varNames = a1Triples
      .map((t) => (t.object.kind === 'variable' ? t.object.name : ''))
      .filter(Boolean);
    expect(new Set(varNames).size).toBe(3);

    // Variable names should follow the pattern a1_{suffix}
    for (const name of varNames) {
      expect(name).toMatch(/^a1_/);
    }
  });
});

describe('selectToAlgebra — projection', () => {
  test('projection includes root variable as first item', async () => {
    const plan = await capturePlan(() => queryFactories.selectName());

    expect(plan.projection[0]).toEqual({kind: 'variable', name: 'a0'});
  });

  test('DISTINCT is set for non-aggregate queries', async () => {
    const plan = await capturePlan(() => queryFactories.selectName());
    expect(plan.distinct).toBe(true);
  });

  test('DISTINCT is not set for aggregate queries', async () => {
    const plan = await capturePlan(() => queryFactories.countFriends());
    expect(plan.distinct).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EXISTS pattern conversion — verifies all pattern kinds are supported
// ---------------------------------------------------------------------------

describe('EXISTS pattern conversion', () => {
  const P = Person.shape.id;

  test('EXISTS with join containing mixed sub-patterns handles all kinds', () => {
    // Hand-crafted IR with EXISTS whose pattern is a join containing
    // a traverse and a shape_scan (the old code silently dropped shape_scan
    // inside join)
    const ir: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: P, alias: 'a0'},
      patterns: [],
      projection: [],
      where: {
        kind: 'exists_expr',
        pattern: {
          kind: 'join',
          patterns: [
            {kind: 'traverse', from: 'a0', to: 'a1', property: `${PROP}hasFriend`},
            {kind: 'shape_scan', shape: Employee.shape.id, alias: 'a1'},
          ],
        },
      },
      singleResult: false,
    };

    const plan = selectToAlgebra(ir);

    // The WHERE should contain a FILTER with EXISTS
    // Dig through the algebra to find the exists_expr
    function findExists(node: SparqlAlgebraNode): SparqlExistsExpr | null {
      if (node.type === 'filter') {
        if (node.expression.kind === 'exists_expr') return node.expression;
        return findExists(node.inner);
      }
      if (node.type === 'join') {
        return findExists(node.left) || findExists(node.right);
      }
      if (node.type === 'left_join') {
        return findExists(node.left) || findExists(node.right);
      }
      return null;
    }

    const existsExpr = findExists(plan.algebra);
    expect(existsExpr).not.toBeNull();
    // The inner pattern should be a join of BGPs (traverse + shape_scan)
    // Both sub-patterns should be present (old code only kept traverse)
    expect(existsExpr!.pattern.type).toBe('join');
    const joinNode = existsExpr!.pattern;
    if (joinNode.type === 'join') {
      // Left: traverse BGP, right: shape_scan BGP — both are BGPs with triples
      expect((joinNode.left as SparqlBGP).triples.length).toBeGreaterThan(0);
      expect((joinNode.right as SparqlBGP).triples.length).toBeGreaterThan(0);
    }
  });

  test('EXISTS with optional pattern produces left_join', () => {
    const ir: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: P, alias: 'a0'},
      patterns: [],
      projection: [],
      where: {
        kind: 'exists_expr',
        pattern: {
          kind: 'optional',
          pattern: {kind: 'traverse', from: 'a0', to: 'a1', property: `${PROP}hasFriend`},
        },
      },
      singleResult: false,
    };

    const plan = selectToAlgebra(ir);

    function findExists(node: SparqlAlgebraNode): SparqlExistsExpr | null {
      if (node.type === 'filter' && node.expression.kind === 'exists_expr') return node.expression;
      if (node.type === 'filter') return findExists(node.inner);
      if (node.type === 'join') return findExists(node.left) || findExists(node.right);
      if (node.type === 'left_join') return findExists(node.left) || findExists(node.right);
      return null;
    }

    const existsExpr = findExists(plan.algebra);
    expect(existsExpr).not.toBeNull();
    expect(existsExpr!.pattern.type).toBe('left_join');
  });

  test('EXISTS with union pattern produces union algebra', () => {
    const ir: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: P, alias: 'a0'},
      patterns: [],
      projection: [],
      where: {
        kind: 'exists_expr',
        pattern: {
          kind: 'union',
          branches: [
            {kind: 'traverse', from: 'a0', to: 'a1', property: `${PROP}hasFriend`},
            {kind: 'traverse', from: 'a0', to: 'a2', property: `${PROP}bestFriend`},
          ],
        },
      },
      singleResult: false,
    };

    const plan = selectToAlgebra(ir);

    function findExists(node: SparqlAlgebraNode): SparqlExistsExpr | null {
      if (node.type === 'filter' && node.expression.kind === 'exists_expr') return node.expression;
      if (node.type === 'filter') return findExists(node.inner);
      if (node.type === 'join') return findExists(node.left) || findExists(node.right);
      if (node.type === 'left_join') return findExists(node.left) || findExists(node.right);
      return null;
    }

    const existsExpr = findExists(plan.algebra);
    expect(existsExpr).not.toBeNull();
    expect(existsExpr!.pattern.type).toBe('union');
    const union = existsExpr!.pattern as SparqlUnion;
    expect((union.left as SparqlBGP).triples.length).toBe(1);
    expect((union.right as SparqlBGP).triples.length).toBe(1);
  });
});
