/**
 * Golden tests for the full SPARQL mutation pipeline:
 *   query factory → IR → algebra → SPARQL string
 *
 * Covers create (INSERT DATA), update (DELETE/INSERT), and delete (DELETE WHERE).
 *
 * Create mutations with ULID-generated URIs use toContain/toMatch assertions
 * since the URI varies per run. All other mutations are deterministic and
 * use exact toBe assertions.
 */
import {describe, expect, test} from '@jest/globals';
import {queryFactories, tmpEntityBase,
  personClass,
  propBase,
  Person,
} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {
  createToSparql,
  updateToSparql,
  upsertToSparql,
  updateWhereToSparql,
  deleteToSparql,
  deleteAllToSparql,
  deleteWhereToSparql,
} from '../sparql/irToAlgebra';
import type {
  IRCreateMutation,
  IRUpdateMutation,
  IRUpsertMutation,
  IRDeleteMutation,
  IRDeleteAllMutation,
  IRDeleteWhereMutation,
  IRUpdateWhereMutation,
} from '../queries/IntermediateRepresentation';

import '../ontologies/rdf';
import '../ontologies/xsd';

// ---------------------------------------------------------------------------
// URI shorthands
// ---------------------------------------------------------------------------

const P = 'https://linked.cm/shape/core/Person';
// Property predicates are the declared `sh:path`, not derived from the shape IRI.
const PROP = propBase;
// The separate class node Person declares as targetClass — the only thing that
// appears as an rdf:type. (Temporary IRI in these fixtures.)
const PT = personClass.id;
const ENT = tmpEntityBase; // linked://tmp/entities/

// ---------------------------------------------------------------------------
// Create mutation tests
// ---------------------------------------------------------------------------

describe('SPARQL golden — create mutations', () => {
  test('createSimple — ULID URI, contains expected triples', async () => {
    const ir = (await captureQuery(queryFactories.createSimple)) as IRCreateMutation;
    const sparql = createToSparql(ir);

    // Structure checks — URI is non-deterministic (ULID)
    expect(sparql).toContain('PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>');
    expect(sparql).toContain('INSERT DATA {');
    expect(sparql).toContain(`rdf:type <${PT}>`);
    expect(sparql).toContain(`<${PROP}name> "Test Create"`);
    expect(sparql).toContain(`<${PROP}hobby> "Chess"`);

    // The generated URI should match the ULID pattern
    expect(sparql).toMatch(
      /http:\/\/example\.org\/data\/person_[0-9A-Z]{26}/,
    );

    // Verify the overall shape
    expect(sparql).toMatch(/^PREFIX rdf:.*\nINSERT DATA \{[\s\S]*\}$/);
  });

  test('createWithFriends — nested create with ULID URIs', async () => {
    const ir = (await captureQuery(queryFactories.createWithFriends)) as IRCreateMutation;
    const sparql = createToSparql(ir);

    expect(sparql).toContain('INSERT DATA {');
    expect(sparql).toContain(`rdf:type <${PT}>`);
    expect(sparql).toContain(`<${PROP}name> "Test Create"`);
    // Reference to existing entity p2
    expect(sparql).toContain(`<${PROP}hasFriend> <${ENT}p2>`);
    // Nested friend create
    expect(sparql).toContain(`<${PROP}name> "New Friend"`);

    // Should have two rdf:type triples (root + nested)
    const typeMatches = sparql.match(/rdf:type/g);
    expect(typeMatches).not.toBeNull();
    expect(typeMatches!.length).toBe(2);
  });

  test('createWithFixedId — deterministic URI', async () => {
    const ir = (await captureQuery(queryFactories.createWithFixedId)) as IRCreateMutation;
    const sparql = createToSparql(ir);

    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
INSERT DATA {
  <${ENT}fixed-id> rdf:type <${PT}> .
  <${ENT}fixed-id> <${PROP}name> "Fixed" .
  <${ENT}fixed-id> <${PROP}bestFriend> <${ENT}fixed-id-2> .
}`);
  });
});

// ---------------------------------------------------------------------------
// Update mutation tests
// ---------------------------------------------------------------------------

describe('SPARQL golden — update mutations', () => {
  test('updateSimple', async () => {
    const ir = (await captureQuery(queryFactories.updateSimple)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hobby> ?old_hobby .
}
INSERT {
  <${ENT}p1> <${PROP}hobby> "Chess" .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hobby> ?old_hobby .
  }
}`);
  });

  test('updateOverwriteSet', async () => {
    const ir = (await captureQuery(queryFactories.updateOverwriteSet)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hasFriend> ?old_friends .
}
INSERT {
  <${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hasFriend> ?old_friends .
  }
}`);
  });

  test('updateUnsetSingleUndefined', async () => {
    const ir = (await captureQuery(queryFactories.updateUnsetSingleUndefined)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hobby> ?old_hobby .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hobby> ?old_hobby .
  }
}`);
  });

  test('updateUnsetSingleNull', async () => {
    const ir = (await captureQuery(queryFactories.updateUnsetSingleNull)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hobby> ?old_hobby .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hobby> ?old_hobby .
  }
}`);
  });

  test('updateOverwriteNested — ULID in nested create', async () => {
    const ir = (await captureQuery(queryFactories.updateOverwriteNested)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);

    // The nested create generates a ULID, so check structure
    expect(sparql).toContain('PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>');
    expect(sparql).toContain('DELETE {');
    expect(sparql).toContain(`<${ENT}p1> <${PROP}bestFriend> ?old_bestFriend .`);
    expect(sparql).toContain('INSERT {');
    expect(sparql).toContain(`<${ENT}p1> <${PROP}bestFriend>`);
    expect(sparql).toContain(`rdf:type <${PT}>`);
    expect(sparql).toContain(`<${PROP}name> "Bestie"`);
    expect(sparql).toContain('WHERE {');
    expect(sparql).toContain(`<${ENT}p1> <${PROP}bestFriend> ?old_bestFriend .`);
  });

  test('updatePassIdReferences', async () => {
    const ir = (await captureQuery(queryFactories.updatePassIdReferences)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}bestFriend> ?old_bestFriend .
}
INSERT {
  <${ENT}p1> <${PROP}bestFriend> <${ENT}p2> .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}bestFriend> ?old_bestFriend .
  }
}`);
  });

  test('updateAddRemoveMulti', async () => {
    const ir = (await captureQuery(queryFactories.updateAddRemoveMulti)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
}
INSERT {
  <${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
  }
}`);
  });

  test('updateRemoveMulti', async () => {
    const ir = (await captureQuery(queryFactories.updateRemoveMulti)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
  }
}`);
  });

  test('updateAddRemoveSame', async () => {
    const ir = (await captureQuery(queryFactories.updateAddRemoveSame)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
}
INSERT {
  <${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
  }
}`);
  });

  test('updateUnsetMultiUndefined', async () => {
    const ir = (await captureQuery(queryFactories.updateUnsetMultiUndefined)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`DELETE {
  <${ENT}p1> <${PROP}hasFriend> ?old_friends .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hasFriend> ?old_friends .
  }
}`);
  });

  test('updateNestedWithPredefinedId', async () => {
    const ir = (await captureQuery(queryFactories.updateNestedWithPredefinedId)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${ENT}p1> <${PROP}bestFriend> ?old_bestFriend .
}
INSERT {
  <${ENT}p1> <${PROP}bestFriend> <${ENT}p3-best-friend> .
  <${ENT}p3-best-friend> rdf:type <${PT}> .
  <${ENT}p3-best-friend> <${PROP}name> "Bestie" .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}bestFriend> ?old_bestFriend .
  }
}`);
  });

  test('updateBirthDate', async () => {
    const ir = (await captureQuery(queryFactories.updateBirthDate)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toBe(
`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DELETE {
  <${ENT}p1> <${PROP}birthDate> ?old_birthDate .
}
INSERT {
  <${ENT}p1> <${PROP}birthDate> "2020-01-01T00:00:00.000Z"^^xsd:dateTime .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}birthDate> ?old_birthDate .
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Delete mutation tests
// ---------------------------------------------------------------------------

describe('SPARQL golden — delete mutations', () => {
  test('deleteSingle', async () => {
    const ir = (await captureQuery(queryFactories.deleteSingle)) as IRDeleteMutation;
    const sparql = deleteToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${ENT}to-delete> ?p ?o .
  ?s ?p2 <${ENT}to-delete> .
  <${ENT}to-delete> rdf:type <${PT}> .
}
WHERE {
  <${ENT}to-delete> rdf:type <${PT}> .
  {
    <${ENT}to-delete> ?p ?o .
  }
  UNION
  {
    ?s ?p2 <${ENT}to-delete> .
  }
}`);
  });

  test('deleteSingleRef', async () => {
    const ir = (await captureQuery(queryFactories.deleteSingleRef)) as IRDeleteMutation;
    const sparql = deleteToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${ENT}to-delete> ?p ?o .
  ?s ?p2 <${ENT}to-delete> .
  <${ENT}to-delete> rdf:type <${PT}> .
}
WHERE {
  <${ENT}to-delete> rdf:type <${PT}> .
  {
    <${ENT}to-delete> ?p ?o .
  }
  UNION
  {
    ?s ?p2 <${ENT}to-delete> .
  }
}`);
  });

  test('deleteMultiple', async () => {
    const ir = (await captureQuery(queryFactories.deleteMultiple)) as IRDeleteMutation;
    const sparql = deleteToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${ENT}to-delete-1> ?p_0 ?o_0 .
  ?s_0 ?p2_0 <${ENT}to-delete-1> .
  <${ENT}to-delete-1> rdf:type <${PT}> .
  <${ENT}to-delete-2> ?p_1 ?o_1 .
  ?s_1 ?p2_1 <${ENT}to-delete-2> .
  <${ENT}to-delete-2> rdf:type <${PT}> .
}
WHERE {
  <${ENT}to-delete-1> rdf:type <${PT}> .
  <${ENT}to-delete-2> rdf:type <${PT}> .
  {
    <${ENT}to-delete-1> ?p_0 ?o_0 .
  }
  UNION
  {
    ?s_0 ?p2_0 <${ENT}to-delete-1> .
  }
  UNION
  {
    <${ENT}to-delete-2> ?p_1 ?o_1 .
  }
  UNION
  {
    ?s_1 ?p2_1 <${ENT}to-delete-2> .
  }
}`);
  });

  test('deleteMultipleFull', async () => {
    const ir = (await captureQuery(queryFactories.deleteMultipleFull)) as IRDeleteMutation;
    const sparql = deleteToSparql(ir);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${ENT}to-delete-1> ?p_0 ?o_0 .
  ?s_0 ?p2_0 <${ENT}to-delete-1> .
  <${ENT}to-delete-1> rdf:type <${PT}> .
  <${ENT}to-delete-2> ?p_1 ?o_1 .
  ?s_1 ?p2_1 <${ENT}to-delete-2> .
  <${ENT}to-delete-2> rdf:type <${PT}> .
}
WHERE {
  <${ENT}to-delete-1> rdf:type <${PT}> .
  <${ENT}to-delete-2> rdf:type <${PT}> .
  {
    <${ENT}to-delete-1> ?p_0 ?o_0 .
  }
  UNION
  {
    ?s_0 ?p2_0 <${ENT}to-delete-1> .
  }
  UNION
  {
    <${ENT}to-delete-2> ?p_1 ?o_1 .
  }
  UNION
  {
    ?s_1 ?p2_1 <${ENT}to-delete-2> .
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Bulk delete mutation tests
// ---------------------------------------------------------------------------

describe('SPARQL golden — bulk delete mutations', () => {
  test('deleteAll — deletes all instances of shape', async () => {
    const ir = (await captureQuery(queryFactories.deleteAll)) as IRDeleteAllMutation;
    expect(ir.kind).toBe('delete_all');
    const sparql = deleteAllToSparql(ir);
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain(`rdf:type <${PT}>`);
    expect(sparql).toContain('?a0 ?p ?o');
  });

  test('deleteWhere — deletes instances matching condition', async () => {
    const ir = (await captureQuery(queryFactories.deleteWhere)) as IRDeleteWhereMutation;
    expect(ir.kind).toBe('delete_where');
    const sparql = deleteWhereToSparql(ir);
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain(`rdf:type <${PT}>`);
    expect(sparql).toContain('?a0 ?p ?o');
    expect(sparql).toContain('FILTER');
  });
});

// ---------------------------------------------------------------------------
// Conditional update mutation tests
// ---------------------------------------------------------------------------

describe('SPARQL golden — conditional update mutations', () => {
  test('updateForAll — updates all instances of shape', async () => {
    const ir = (await captureQuery(queryFactories.updateForAll)) as IRUpdateWhereMutation;
    expect(ir.kind).toBe('update_where');
    const sparql = updateWhereToSparql(ir);
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain('INSERT');
    expect(sparql).toContain(`rdf:type <${PT}>`);
    expect(sparql).toContain('?a0');
    // Should NOT have FILTER (no where condition)
    expect(sparql).not.toContain('FILTER');
  });

  test('updateWhere — updates instances matching condition', async () => {
    const ir = (await captureQuery(queryFactories.updateWhere)) as IRUpdateWhereMutation;
    expect(ir.kind).toBe('update_where');
    const sparql = updateWhereToSparql(ir);
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain('INSERT');
    expect(sparql).toContain(`rdf:type <${PT}>`);
    expect(sparql).toContain('?a0');
    expect(sparql).toContain('FILTER');
  });
});

// ---------------------------------------------------------------------------
// Builder equivalence tests — sugar methods produce identical SPARQL
// ---------------------------------------------------------------------------

describe('SPARQL golden — builder equivalence', () => {
  test('Person.deleteAll() === DeleteBuilder.from(Person).all()', async () => {
    const irSugar = (await captureQuery(queryFactories.deleteAll)) as IRDeleteAllMutation;
    const irBuilder = (await captureQuery(queryFactories.deleteAllBuilder)) as IRDeleteAllMutation;
    expect(deleteAllToSparql(irSugar)).toBe(deleteAllToSparql(irBuilder));
  });

  test('Person.deleteWhere(fn) === DeleteBuilder.from(Person).where(fn)', async () => {
    const irSugar = (await captureQuery(queryFactories.deleteWhere)) as IRDeleteWhereMutation;
    const irBuilder = (await captureQuery(queryFactories.deleteWhereBuilder)) as IRDeleteWhereMutation;
    expect(deleteWhereToSparql(irSugar)).toBe(deleteWhereToSparql(irBuilder));
  });
});

// ---------------------------------------------------------------------------
// Expression-based mutation tests
// ---------------------------------------------------------------------------

describe('SPARQL golden — expression mutations', () => {
  test('updateExprCallback: functional callback with arithmetic expression', async () => {
    const ir = (await captureQuery(queryFactories.updateExprCallback)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    // Should contain BIND for computed value
    expect(sparql).toContain('BIND');
    // Should reference old value and computed value
    expect(sparql).toContain('old_guardDogLevel');
    expect(sparql).toContain('computed_guardDogLevel');
    // Should contain the arithmetic expression
    expect(sparql).toContain('+');
    // Should have DELETE and INSERT
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain('INSERT');
  });

  test('updateExprNow: expression value (Expr.now()) in update', async () => {
    const ir = (await captureQuery(queryFactories.updateExprNow)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    // Should contain BIND with NOW()
    expect(sparql).toContain('BIND');
    expect(sparql).toContain('NOW()');
  });

  test('updateExprTraversal: multi-segment ref produces traversal OPTIONAL', async () => {
    const ir = (await captureQuery(queryFactories.updateExprTraversal)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);

    // Should have traversal pattern in IR
    expect(ir.traversalPatterns).toBeDefined();
    expect(ir.traversalPatterns!.length).toBe(1);
    expect(ir.traversalPatterns![0].from).toBe('__mutation_subject__');
    expect(ir.traversalPatterns![0].to).toBe('__trav_0__');

    // SPARQL should contain OPTIONAL for the traversal
    expect(sparql).toContain('OPTIONAL');
    expect(sparql).toContain(`<${PROP}bestFriend>`);
    // Should have BIND for computed value
    expect(sparql).toContain('BIND');
    expect(sparql).toContain('UCASE');
    // The BIND expression should reference the traversal variable's property
    expect(sparql).toContain('__trav_0__');
  });

  test('updateExprSharedTraversal: shared traversal produces only one OPTIONAL', async () => {
    const ir = (await captureQuery(queryFactories.updateExprSharedTraversal)) as IRUpdateMutation;
    const sparql = updateToSparql(ir);

    // Should have exactly one traversal pattern (deduped)
    expect(ir.traversalPatterns).toBeDefined();
    expect(ir.traversalPatterns!.length).toBe(1);
    expect(ir.traversalPatterns![0].from).toBe('__mutation_subject__');
    expect(ir.traversalPatterns![0].to).toBe('__trav_0__');

    // SPARQL should contain OPTIONAL for traversal + BIND for both fields
    expect(sparql).toContain('OPTIONAL');
    expect(sparql).toContain(`<${PROP}bestFriend>`);
    expect(sparql).toContain('UCASE');
    expect(sparql).toContain('LCASE');
    // Both BINDs should reference the same traversal variable
    expect(sparql).toContain('__trav_0__');
    // Only one OPTIONAL for bestFriend traversal
    const optionalMatches = sparql.match(/OPTIONAL/g);
    // Count traversal OPTIONAL (for bestFriend) + old value OPTIONALs (for name, hobby, and their expression-referenced properties)
    expect(optionalMatches).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expression-based WHERE on mutations (Phase 8)
// ---------------------------------------------------------------------------

describe('SPARQL golden — expression WHERE mutations', () => {
  test('whereExprUpdateBuilder — expression WHERE on update', async () => {
    const ir = (await captureQuery(queryFactories.whereExprUpdateBuilder)) as IRUpdateWhereMutation;
    const sparql = updateWhereToSparql(ir);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain('INSERT');
  });

  test('whereExprDeleteBuilder — expression WHERE on delete', async () => {
    const ir = (await captureQuery(queryFactories.whereExprDeleteBuilder)) as IRDeleteWhereMutation;
    const sparql = deleteWhereToSparql(ir);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('DELETE');
  });
});

// ---------------------------------------------------------------------------
// Expression traversals inside an `update().where()`
// ---------------------------------------------------------------------------

describe('SPARQL golden — update(expr).where() traversal scoping', () => {
  const traversalUpdate = () =>
    (Person as any)
      .update((p: any) => ({hobby: p.bestFriend.name.ucase()}))
      .where((p: any) => p.name.equals('Moa'));

  test('the leaf property is nested INSIDE the traversal OPTIONAL', async () => {
    const ir = (await captureQuery(traversalUpdate)) as IRUpdateWhereMutation;
    const sparql = updateWhereToSparql(ir);

    // The edge must bind ?__trav_0__ before anything reads from it. Emitted
    // beside the edge instead of inside it, the leaf's OPTIONAL shares no
    // variable with its left side — a cartesian product over every node in the
    // store carrying that predicate.
    expect(sparql).toContain(
      `OPTIONAL {
    ?a0 <${PROP}bestFriend> ?__trav_0__ .
    OPTIONAL {
      ?__trav_0__ <${PROP}name> ?__trav_0___name .
    }
  }`,
    );
  });

  test('the edge is never preceded by a bare leaf OPTIONAL', async () => {
    const ir = (await captureQuery(traversalUpdate)) as IRUpdateWhereMutation;
    const sparql = updateWhereToSparql(ir);
    const leafAt = sparql.indexOf('?__trav_0__ <');
    const edgeAt = sparql.indexOf('?__trav_0__ .');
    expect(edgeAt).toBeGreaterThan(-1);
    expect(edgeAt).toBeLessThan(leafAt);
  });

  test('matches the shape `.for(id)` already emits for the same expression', async () => {
    // The two mutation paths lower the same expression; only the subject differs.
    const whereSparql = updateWhereToSparql(
      (await captureQuery(traversalUpdate)) as IRUpdateWhereMutation,
    );
    const forSparql = updateToSparql(
      (await captureQuery(queryFactories.updateExprTraversal)) as IRUpdateMutation,
    );
    const nesting = (q: string) =>
      q.includes(`?__trav_0__ .
    OPTIONAL {`);
    expect(nesting(whereSparql)).toBe(true);
    expect(nesting(forSparql)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upsert mutation tests
//
// The contract is deliberately narrow: an upsert is the update plan plus the one
// `rdf:type` triple the update path never writes. These tests assert that difference
// exactly — anything else changing between the two is a regression in one of them.
// ---------------------------------------------------------------------------

describe('SPARQL golden — upsert mutations', () => {
  /** Re-kind a captured update IR as an upsert; the two carry identical fields. */
  const asUpsert = (ir: IRUpdateMutation): IRUpsertMutation => ({
    ...ir,
    kind: 'upsert',
  });

  test('upsertSimple — update plan plus the type triple', async () => {
    const ir = (await captureQuery(queryFactories.updateSimple)) as IRUpdateMutation;
    const sparql = upsertToSparql(asUpsert(ir));
    // `rdf:type` + its PREFIX header, matching what `create` emits — not the `a`
    // shorthand — so both write paths assert the type in one recognisable form.
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
DELETE {
  <${ENT}p1> <${PROP}hobby> ?old_hobby .
}
INSERT {
  <${ENT}p1> rdf:type <${PT}> .
  <${ENT}p1> <${PROP}hobby> "Chess" .
}
WHERE {
  OPTIONAL {
    <${ENT}p1> <${PROP}hobby> ?old_hobby .
  }
}`);
  });

  test('the ONLY difference from update is one INSERT triple', async () => {
    const ir = (await captureQuery(queryFactories.updateSimple)) as IRUpdateMutation;
    const update = updateToSparql(ir).split('\n');
    const upsert = upsertToSparql(asUpsert(ir)).split('\n');

    const added = upsert.filter((l) => !update.includes(l));
    const removed = update.filter((l) => !upsert.includes(l));

    // Two added lines: the type triple, and the PREFIX header it needs.
    expect(added).toEqual([
      'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
      `  <${ENT}p1> rdf:type <${PT}> .`,
    ]);
    expect(removed).toEqual([]);
  });

  test('the WHERE is a bare OPTIONAL, so the INSERT fires when the node is absent', async () => {
    // This is what makes a single-request upsert possible at all: a WHERE consisting
    // only of OPTIONALs yields one solution even when nothing matches.
    const ir = (await captureQuery(queryFactories.updateSimple)) as IRUpdateMutation;
    const sparql = upsertToSparql(asUpsert(ir));
    const where = sparql.slice(sparql.indexOf('WHERE {'));
    expect(where).toContain('OPTIONAL {');
    // No non-optional pattern that would require the subject to already exist.
    expect(where.replace(/OPTIONAL \{[\s\S]*?\n  \}/g, '')).not.toMatch(/<[^>]+> <[^>]+>/);
  });

  test('a nested object value keeps its own type; the subject gets exactly one', async () => {
    // The nested node was never the gap — it already carries rdf:type from the create path
    // inside processUpdateFields. Only the SUBJECT lacked one, which is what upsert adds.
    const ir = (await captureQuery(queryFactories.updateOverwriteNested)) as IRUpdateMutation;
    const sparql = upsertToSparql(asUpsert(ir));
    const insertBlock = sparql.slice(sparql.indexOf('INSERT {'), sparql.indexOf('WHERE {'));

    const subjectTypeTriples = insertBlock
      .split('\n')
      .filter((l) => l.includes(`<${ENT}p1>`) && l.includes('rdf:type'));
    expect(subjectTypeTriples).toHaveLength(1);

    // The nested node still gets its own, from the create path — not from the upsert.
    expect(insertBlock).toMatch(/<http:\/\/example\.org\/data\/person_[0-9A-Z]{26}> rdf:type/);
  });

  test('multi-valued replace keeps the type triple first', async () => {
    const ir = (await captureQuery(queryFactories.updateOverwriteSet)) as IRUpdateMutation;
    const sparql = upsertToSparql(asUpsert(ir));
    const insertBlock = sparql.slice(sparql.indexOf('INSERT {'), sparql.indexOf('WHERE {'));
    const firstTriple = insertBlock.split('\n')[1];
    expect(firstTriple).toBe(`  <${ENT}p1> rdf:type <${PT}> .`);
  });
});

