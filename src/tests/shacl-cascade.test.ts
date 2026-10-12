/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {
  ensureFuseki,
  createTestDataset,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {
  deleteAllToSparql,
  deleteToSparql,
  deleteWhereToSparql,
  updateToSparql,
  upsertToSparql,
  buildOwnedCascade,
  buildOwnedSelfDelete,
} from '../sparql/irToAlgebra';
import type {
  IRDeleteAllMutation,
  IRDeleteMutation,
  IRDeleteWhereMutation,
  IRUpdateMutation,
  IRUpsertMutation,
} from '../queries/IntermediateRepresentation';
// Ensure List/PathNode (dependent shapes) are registered so the cascade has targets.
import '../shapes/List';
import '../shapes/PathNode';
import {lower} from '../queries/lower';

const {linkedShape} = linkedPackage('cascade-test');
const ex = (n: string) => ({id: `http://example.org/c#${n}`});

@linkedShape({dependent: true})
class TCell extends Shape {
  static targetClass = ex('TCell');
  @objectProperty({path: ex('next'), shape: TCell, maxCount: 1, contains: true})
  get next(): TCell {
    return null;
  }
}

@linkedShape
class TBox extends Shape {
  static targetClass = ex('TBox');
  @objectProperty({path: ex('owns'), shape: TCell, maxCount: 1, contains: true})
  get owns(): TCell {
    return null;
  }
  @objectProperty({path: ex('ref'), shape: TCell, maxCount: 1})
  get ref(): TCell {
    return null;
  }
}

@linkedShape
class TBag extends Shape {
  static targetClass = ex('TBag');
  @objectProperty({path: ex('items'), shape: TCell, contains: true})
  get items(): TCell[] {
    return [];
  }
}

// A `contains` child that is deliberately NOT `dependent` — mirrors `schema:ImageObject`
// owned via `Thing.image` (backlog 032). The replace/remove self-delete must fire on the
// `contains` edge alone, without the child shape being marked `dependent`.
@linkedShape
class TPlainCell extends Shape {
  static targetClass = ex('TPlainCell');
  @objectProperty({path: ex('label'), maxCount: 1})
  get label(): string {
    return null;
  }
}

@linkedShape
class TCard extends Shape {
  static targetClass = ex('TCard');
  @literalProperty({path: ex('title'), maxCount: 1})
  get title(): string {
    return null;
  }
  @objectProperty({path: ex('holds'), shape: TPlainCell, maxCount: 1, contains: true})
  get holds(): TPlainCell {
    return null;
  }
  @objectProperty({path: ex('cells'), shape: TPlainCell, contains: true})
  get cells(): TPlainCell[] {
    return [];
  }
}

// A `contains` property WITHOUT a value shape — a polymorphic slot like `PropertyShape.path`,
// whose value may be a shared predicate IRI. It must never self-delete its old value.
@linkedShape
class TSlot extends Shape {
  static targetClass = ex('TSlot');
  @objectProperty({path: ex('anyPath'), maxCount: 1, contains: true})
  get anyPath(): unknown {
    return null;
  }
}

describe('owned-subtree cascade', () => {
  test('delete cascades via contains edges to dependent-typed nodes', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TBox, {id: 'http://example.org/c#b1'})) as IRDeleteMutation,
    );
    // follows contains edges as a one-or-more property path
    expect(sparql).toContain('owns');
    expect(sparql).toContain('next');
    expect(sparql).toMatch(/\)\* /); // (…|…)* property path
    // only deletes reached nodes asserted to be a dependent type
    expect(sparql).toContain('http://example.org/c#TCell');
  });

  test('delete joins its blocks with UNION, never with chained OPTIONALs', () => {
    // Chained OPTIONALs multiply: own triples x incoming references x each owned type's
    // triples. A UNION adds them up and deletes the same triples.
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TBox, {id: 'http://example.org/c#b1'})) as IRDeleteMutation,
    );
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).not.toContain('OPTIONAL');
    expect(where).toContain('UNION');
    // The type guard is still required, outside the UNION.
    expect(where).toMatch(/^WHERE \{\n  <http:\/\/example\.org\/c#b1> rdf:type <http:\/\/example\.org\/c#TBox> \./);
  });

  test('safety: non-contains predicate (ref) is NOT followed by the cascade', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TBox, {id: 'http://example.org/c#b1'})) as IRDeleteMutation,
    );
    expect(sparql).not.toContain('#ref');
  });

  test('cascade includes rdf:rest (List spine) and PathNode/List dependent types', () => {
    const {deletePatterns, whereOptionals} = buildOwnedCascade(
      {kind: 'iri', value: 'http://example.org/c#b1'},
      't_',
    );
    expect(deletePatterns.length).toBeGreaterThan(0);
    // one OPTIONAL per dependent type; the path term carries the contains predicates
    const paths = whereOptionals
      .flatMap((o: any) => o.triples)
      .filter((t: any) => t.predicate.kind === 'path')
      .map((t: any) => t.predicate.value);
    expect(paths.join(' ')).toMatch(/rest/); // List.rest is a contains edge
    const types = whereOptionals
      .flatMap((o: any) => o.triples)
      .filter((t: any) => t.predicate.kind === 'iri' && t.predicate.value.endsWith('#type'))
      .map((t: any) => t.object.value);
    expect(types).toEqual(expect.arrayContaining([
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#List',
      'https://linked.cm/ont/core/PathNode',
      'http://example.org/c#TCell',
    ]));
  });

  test('upsert cascades identically to update, plus the type triple', () => {
    // The cascade is computed in the body `update` and `upsert` share, so it should ride
    // along untouched — but "untouched by construction" is the claim worth checking, since
    // this governs whether replaced owned nodes orphan.
    const build = (b: any) =>
      b.for('http://example.org/c#bag1')
        .set({items: {remove: [{id: 'http://example.org/c#oldcell'}]}} as any);

    const updateSparql = updateToSparql(
      lower(build(UpdateBuilder.from(TBag))) as unknown as IRUpdateMutation,
    );
    const upsertSparql = upsertToSparql(
      lower(build(UpdateBuilder.upsertFrom(TBag))) as unknown as IRUpsertMutation,
    );

    // Cascade markers still present under upsert.
    expect(upsertSparql).toContain('http://example.org/c#oldcell');
    expect(upsertSparql).toMatch(/\)\* /);
    expect(upsertSparql).toContain('http://example.org/c#TCell');

    // And the only difference from the update is the type triple. This particular update
    // only removes, so it has no INSERT block at all — the upsert grows one to hold it.
    const added = upsertSparql.split('\n').filter((l) => !updateSparql.split('\n').includes(l));
    expect(added).toEqual([
      'INSERT {',
      '  <http://example.org/c#bag1> rdf:type <http://example.org/c#TBag> .',
    ]);

    // The asserted type is the shape's targetClass, NOT its shape id. Getting this wrong
    // would type upserted nodes with an IRI the select path never scans for, making every
    // upserted node invisible — the exact failure upsert exists to prevent.
    expect(TBag.shape.id).not.toBe('http://example.org/c#TBag');
    expect(upsertSparql).toContain('rdf:type <http://example.org/c#TBag>');
  });

  test('update set-modification remove on a contains property cascades the removed subtree', () => {
    const sparql = updateToSparql(
      lower(UpdateBuilder.from(TBag)
        .for('http://example.org/c#bag1')
        .set({items: {remove: [{id: 'http://example.org/c#oldcell'}]}} as any)
        ) as IRUpdateMutation,
    );
    // the removed value is a cascade root, followed by the contains property path
    expect(sparql).toContain('http://example.org/c#oldcell');
    expect(sparql).toMatch(/\)\* /);
    expect(sparql).toContain('http://example.org/c#TCell');
  });

  // --- backlog 032: replace/remove of a `contains` edge deletes the old node itself,
  // even when the owned child shape is NOT `dependent` (contains = exclusive ownership). ---

  test('replace of a non-dependent contains child deletes the old node\'s own triples', () => {
    const sparql = updateToSparql(
      lower(UpdateBuilder.from(TCard)
        .for('http://example.org/c#card1')
        .set({holds: {id: 'http://example.org/c#newplain'}})
        ) as IRUpdateMutation,
    );
    const [deleteBlock] = sparql.split('INSERT');
    // DELETE wildcards the old node's own one-hop triples (?old_holds ?p ?o).
    expect(deleteBlock).toMatch(/\?old_holds \?\w+ \?\w+ \./);
    // Safety: the owning edge is re-asserted INSIDE the self-delete WHERE group, so an
    // absent old value is a no-op (never an unbound ?old matching the whole graph).
    expect(sparql).toMatch(
      /#holds>\s+\?old_holds\s*\.\s*\?old_holds\s+\?\w+\s+\?\w+\s*\./,
    );
  });

  test('buildOwnedSelfDelete: one-hop wildcard delete with edge-bound WHERE group', () => {
    const subject = {kind: 'iri', value: 'http://example.org/c#card1'} as const;
    const prop = {kind: 'iri', value: 'http://example.org/c#holds'} as const;
    const old = {kind: 'variable', name: 'old_holds'} as const;
    const {deletePatterns, whereOptionals} = buildOwnedSelfDelete(
      subject as any,
      prop as any,
      old as any,
      'z_',
    );
    // Exactly one delete pattern: the old node's own triples.
    expect(deletePatterns).toHaveLength(1);
    expect(deletePatterns[0].subject).toEqual(old);
    // Exactly one WHERE group holding BOTH the owning edge (binds ?old) and the wildcard.
    expect(whereOptionals).toHaveLength(1);
    const triples = (whereOptionals[0] as any).triples;
    expect(triples).toHaveLength(2);
    // First triple is the edge <subject> <prop> ?old — required to bind ?old in-group.
    expect(triples[0].subject).toEqual(subject);
    expect(triples[0].predicate).toEqual(prop);
    expect(triples[0].object).toEqual(old);
    // Second triple wildcards the old node; its subject is ?old, matching the delete pattern.
    expect(triples[1].subject).toEqual(old);
    expect(triples[1]).toEqual(deletePatterns[0]);
  });

  test('set-remove of a non-dependent contains child deletes the removed node\'s own triples', () => {
    const sparql = updateToSparql(
      lower(UpdateBuilder.from(TCard)
        .for('http://example.org/c#card1')
        .set({cells: {remove: [{id: 'http://example.org/c#oldplain'}]}} as any)
        ) as IRUpdateMutation,
    );
    const [deleteBlock] = sparql.split('INSERT');
    // The removed IRI's own triples are wildcard-deleted (not just the edge unlinked).
    expect(deleteBlock).toMatch(
      /<http:\/\/example\.org\/c#oldplain> \?\w+ \?\w+ \./,
    );
    // And the ownership link is confirmed in the WHERE before wiping the node.
    expect(sparql).toMatch(
      /#cells>\s+<http:\/\/example\.org\/c#oldplain>\s*\.\s*<http:\/\/example\.org\/c#oldplain>\s+\?\w+\s+\?\w+/,
    );
  });

  test('update replacing a contains property cascades the old value subtree', () => {
    const sparql = updateToSparql(
      lower(UpdateBuilder.from(TBox)
        .for('http://example.org/c#b1')
        .set({owns: {id: 'http://example.org/c#newcell'}})
        ) as IRUpdateMutation,
    );
    // DELETE removes the old owns edge AND the old owned subtree (cascade path present)
    expect(sparql).toContain('owns');
    expect(sparql).toMatch(/\)\* /);
    expect(sparql).toContain('http://example.org/c#TCell');
  });
});

const C = 'http://example.org/c#';
const updateSparqlOf = (builder: any) =>
  updateToSparql(lower(builder) as unknown as IRUpdateMutation);
const deleteBlockOf = (sparql: string) => sparql.split('INSERT')[0].split('WHERE')[0];
/** The `{ … }` UNION branches of the WHERE, as strings. */
const branchesOf = (sparql: string) =>
  sparql.slice(sparql.indexOf('WHERE')).split(/\n\s*UNION\n/);

describe('owned values: keep list, value-shape rule and subject delete', () => {
  test('replace with the current {id} filters the old value', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TCard).for(`${C}card1`).set({holds: {id: `${C}plain1`}}),
    );
    const branches = branchesOf(sparql);
    const self = branches.find((b) => /\?old_holds \?uc0_sp \?uc0_so/.test(b));
    expect(self).toBeDefined();
    // The filter sits inside the same group as the edge that binds ?old_holds.
    expect(self).toMatch(/#holds> \?old_holds \.[\s\S]*FILTER\(\?old_holds NOT IN \(<http:\/\/example\.org\/c#plain1>\)\)/);
    // The edge-only branch has no filter: the edge is deleted and re-inserted (a no-op).
    const edgeOnly = branches.find((b) => /#holds> \?old_holds \.\s*\}/.test(b) && !/\?uc0_/.test(b));
    expect(edgeOnly).toBeDefined();
    expect(edgeOnly).not.toContain('FILTER');
    // Every cascade branch is filtered too.
    const cascade = branches.filter((b) => /\?uc0_own\d/.test(b));
    expect(cascade.length).toBeGreaterThan(0);
    for (const b of cascade) expect(b).toContain('FILTER(?old_holds NOT IN (<http://example.org/c#plain1>))');
  });

  test('replace with a different {id} keeps the filter harmless', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TCard).for(`${C}card1`).set({holds: {id: `${C}newplain`}}),
    );
    const filters = sparql.match(/FILTER\([^)]*\)\)/g) ?? [];
    expect(filters.length).toBeGreaterThan(0);
    // Only the new id is listed; an old value that differs is still deleted.
    for (const f of filters) expect(f).toBe('FILTER(?old_holds NOT IN (<http://example.org/c#newplain>))');
  });

  test('array overwrite keeps the retained ids', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TCard).for(`${C}card1`).set({cells: [{id: `${C}a`}, {id: `${C}b`}]} as any),
    );
    const kept = 'FILTER(?old_cells NOT IN (<http://example.org/c#a>, <http://example.org/c#b>))';
    const branches = branchesOf(sparql);
    const self = branches.find((b) => /\?old_cells \?uc0_sp \?uc0_so/.test(b));
    expect(self).toContain(kept);
    const cascade = branches.filter((b) => /\?uc0_own\d/.test(b));
    expect(cascade.length).toBeGreaterThan(0);
    for (const b of cascade) expect(b).toContain(kept);
  });

  test('nested create with the current id is a full rewrite', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TCard).for(`${C}card1`).set({holds: {id: `${C}plain1`, label: 'x'}} as any),
    );
    expect(sparql).not.toContain('NOT IN');
    expect(deleteBlockOf(sparql)).toMatch(/\?old_holds \?\w+ \?\w+ \./);
  });

  test('set-mod add+remove of the same id emits no node delete', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TCard)
        .for(`${C}card1`)
        .set({cells: {add: [{id: `${C}x`}], remove: [{id: `${C}x`}]}} as any),
    );
    const del = deleteBlockOf(sparql);
    expect(del).not.toMatch(/<http:\/\/example\.org\/c#x> \?\w+ \?\w+ \./);
    expect(del).not.toMatch(/\?ucr_/);
    // The edge delete remains; the INSERT puts it back.
    expect(del).toContain('<http://example.org/c#card1> <http://example.org/c#cells> <http://example.org/c#x> .');
  });

  test('set-remove cascade is anchored on the owning edge', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TCard).for(`${C}card1`).set({cells: {remove: [{id: `${C}old`}]}} as any),
    );
    const cascade = branchesOf(sparql).filter((b) => /\?ucr_cells_0_own\d/.test(b));
    expect(cascade.length).toBeGreaterThan(0);
    for (const b of cascade) {
      expect(b).toMatch(/<http:\/\/example\.org\/c#card1> <http:\/\/example\.org\/c#cells> <http:\/\/example\.org\/c#old> \./);
    }
  });

  test('buildOwnedSelfDelete with keep wraps the block in a NOT IN filter', () => {
    const subject = {kind: 'iri', value: `${C}card1`} as const;
    const prop = {kind: 'iri', value: `${C}holds`} as const;
    const old = {kind: 'variable', name: 'old_holds'} as const;
    const keep = [{kind: 'iri', value: `${C}plain1`} as const];
    const plain = buildOwnedSelfDelete(subject, prop, old, 'z_');
    const kept = buildOwnedSelfDelete(subject, prop, old, 'z_', keep);
    const block = kept.whereOptionals[0] as any;
    expect(block.type).toBe('filter');
    expect(block.expression.kind).toBe('in_expr');
    expect(block.expression.negated).toBe(true);
    expect(block.expression.value).toEqual({kind: 'variable_expr', name: 'old_holds'});
    expect(block.expression.list).toEqual([{kind: 'iri_expr', value: `${C}plain1`}]);
    expect(block.inner.triples).toEqual((plain.whereOptionals[0] as any).triples);
    // An IRI old term (set-remove) ignores keep.
    const iriOld = buildOwnedSelfDelete(subject, prop, {kind: 'iri', value: `${C}x`}, 'z_', keep);
    expect(iriOld.whereOptionals[0].type).toBe('bgp');
  });

  test('buildOwnedCascade with keep filters every block', () => {
    const old = {kind: 'variable', name: 'old_owns'} as const;
    const keep = [{kind: 'iri', value: `${C}cell1`} as const];
    const plain = buildOwnedCascade(old, 'k_');
    const kept = buildOwnedCascade(old, 'k_', undefined, keep);
    expect(kept.whereOptionals).toHaveLength(plain.whereOptionals.length);
    kept.whereOptionals.forEach((block: any, i) => {
      expect(block.type).toBe('filter');
      expect(block.expression.negated).toBe(true);
      expect(block.inner).toEqual(plain.whereOptionals[i]);
    });
  });

  test('cascade path includes the root (zero-or-more)', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TBox, {id: `${C}b1`})) as IRDeleteMutation,
    );
    expect(sparql).toMatch(/\)\* /);
    expect(sparql).not.toMatch(/\)\+ /);
  });

  test('valueShape-less contains field: no self-delete', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TSlot).for(`${C}s1`).set({anyPath: {id: `${C}p`}} as any),
    );
    // No wildcard delete of the old value's own triples...
    expect(deleteBlockOf(sparql)).not.toMatch(/\?old_anyPath \?\w+ \?\w+ \./);
    // ...and every block that reads ?old_anyPath beyond the edge requires a dependent type.
    for (const b of branchesOf(sparql).filter((b) => /\?old_anyPath \S/.test(b) && /\?uc0_/.test(b))) {
      expect(b).toMatch(/rdf:type (shacl:PropertyShape|rdf:List|core:PathNode|<http:\/\/example\.org\/c#TCell>)/);
    }
    // The cascade still runs, so a dependent value (a PathNode) is cleaned up.
    expect(sparql).toMatch(/\?old_anyPath \([^)]*\)\* \?uc0_own\d/);
  });

  test('subject delete removes immediately-owned non-dependent children', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TCard, {id: `${C}card1`})) as IRDeleteMutation,
    );
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).toMatch(/\{\s*<http:\/\/example\.org\/c#card1> <http:\/\/example\.org\/c#holds> \?d0 \.\s*\?d0 \?d0_p \?d0_o \.\s*\}/);
    expect(where).toMatch(/\{\s*<http:\/\/example\.org\/c#card1> <http:\/\/example\.org\/c#cells> \?d1 \.\s*\?d1 \?d1_p \?d1_o \.\s*\}/);
    expect(where).not.toContain('OPTIONAL');
    expect(deleteBlockOf(sparql)).toContain('?d0 ?d0_p ?d0_o .');
    expect(deleteBlockOf(sparql)).toContain('?d1 ?d1_p ?d1_o .');
  });

  test('subject delete skips valueShape-less contains properties', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TSlot, {id: `${C}s1`})) as IRDeleteMutation,
    );
    expect(sparql).not.toMatch(/\?d\d/);
    expect(sparql).not.toMatch(/#anyPath> \?d/);
  });

  test('multi-id delete suffixes child vars', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TCard, [{id: `${C}card1`}, {id: `${C}card2`}])) as IRDeleteMutation,
    );
    expect(sparql).toContain('<http://example.org/c#card2> <http://example.org/c#holds> ?d0_1 .');
    expect(sparql).toContain('?d0_1 ?d0_1_p ?d0_1_o .');
    expect(sparql).toContain('?d1_0 ?d1_0_p ?d1_0_o .');
  });

  const CARD_TYPE = '\\?a0 rdf:type <http:\\/\\/example\\.org\\/c#TCard> \\.';

  test('deleteAll removes immediately-owned children, each block led by the type triple', () => {
    const sparql = deleteAllToSparql(lower(DeleteBuilder.from(TCard).all()) as IRDeleteAllMutation);
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).toMatch(
      new RegExp(`\\{\\s*${CARD_TYPE}\\s*\\?a0 <http:\\/\\/example\\.org\\/c#holds> \\?d0 \\.\\s*\\?d0 \\?d0_p \\?d0_o \\.\\s*\\}`),
    );
    expect(where).toMatch(
      new RegExp(`\\{\\s*${CARD_TYPE}\\s*\\?a0 <http:\\/\\/example\\.org\\/c#cells> \\?d1 \\.\\s*\\?d1 \\?d1_p \\?d1_o \\.\\s*\\}`),
    );
    // The dependent cascade, rooted at the subject variable and led by the type triple.
    const cascade = branchesOf(sparql).filter((b) => /\?c_own\d/.test(b));
    expect(cascade.length).toBeGreaterThan(0);
    for (const b of cascade) {
      expect(b).toMatch(new RegExp(`${CARD_TYPE}\\s*\\?a0 \\([^)]*\\)\\* \\?c_own\\d`));
    }
    expect(where).not.toContain('OPTIONAL');
    const del = deleteBlockOf(sparql);
    expect(del).toContain('?a0 ?p ?o .');
    expect(del).toContain('?d0 ?d0_p ?d0_o .');
    expect(del).toContain('?d1 ?d1_p ?d1_o .');
  });

  test('deleteAll of a dependent-owning shape cascades; a shape-less contains property adds no child block', () => {
    const box = deleteAllToSparql(lower(DeleteBuilder.from(TBox).all()) as IRDeleteAllMutation);
    expect(box).toContain('?a0 <http://example.org/c#owns> ?d0 .');
    expect(box).toMatch(/\?a0 \([^)]*<http:\/\/example\.org\/c#next>[^)]*\)\* \?c_own\d/);
    expect(box).not.toContain('#ref> ?d');
    const slot = deleteAllToSparql(lower(DeleteBuilder.from(TSlot).all()) as IRDeleteAllMutation);
    expect(slot).not.toMatch(/\?d\d/);
    expect(slot).toMatch(/\?c_own\d/);
  });

  test('delete().where() carries the same owned blocks, joined with the filtered match', () => {
    const sparql = deleteWhereToSparql(
      lower(DeleteBuilder.from(TCard).where((c: any) => c.title.equals('x'))) as IRDeleteWhereMutation,
    );
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).toContain('FILTER');
    expect(where).toContain('?a0 <http://example.org/c#holds> ?d0 .');
    expect(where).toContain('?a0 <http://example.org/c#cells> ?d1 .');
    expect(where).toMatch(/\?c_own\d/);
    expect(where).not.toContain('OPTIONAL');
  });
});

// Live end-to-end reproduction of backlog 032: replacing a `contains`-owned node whose
// shape is NOT `dependent` must leave no orphan behind. Skips gracefully if Fuseki is down.
describe('owned-subtree cascade — live Fuseki (backlog 032 orphan repro)', () => {
  const C = 'http://example.org/c#';
  const iri = (n: string) => `<${C}${n}>`;
  const RDF = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n';
  let fusekiAvailable = false;

  const countTriples = async (subject: string): Promise<number> => {
    const res = await executeSparqlQuery(
      `SELECT (COUNT(*) AS ?c) WHERE { ${iri(subject)} ?p ?o }`,
    );
    return Number(res.results.bindings[0]?.c?.value ?? 0);
  };

  const materializeCell = (id: string, label: string) =>
    `${RDF}INSERT DATA { ${iri(id)} rdf:type ${iri('TPlainCell')} ; ${iri('label')} "${label}" . }`;

  const replaceHolds = (target: string) =>
    updateToSparql(
      lower(UpdateBuilder.from(TCard).for(`${C}card1`).set({holds: {id: `${C}${target}`}})) as IRUpdateMutation,
    );

  beforeAll(async () => {
    fusekiAvailable = await ensureFuseki();
    if (fusekiAvailable) await createTestDataset();
  });
  afterAll(async () => {
    if (fusekiAvailable) await clearAllData();
  });
  beforeEach(async () => {
    if (fusekiAvailable) await clearAllData();
  });

  test('replacing a contains-owned node twice accumulates zero orphans', async () => {
    if (!fusekiAvailable) return;

    // Initial: card1 --holds--> plain1 (2 own triples: type + label).
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} . }`,
    );
    await executeSparqlUpdate(materializeCell('plain1', 'a'));
    expect(await countTriples('plain1')).toBe(2);

    // Replace #1: holds → plain2. The generated update removes plain1's own triples;
    // plain2 is materialized separately (simulating a nested create on the new value).
    await executeSparqlUpdate(replaceHolds('plain2'));
    await executeSparqlUpdate(materializeCell('plain2', 'b'));
    expect(await countTriples('plain1')).toBe(0); // orphan removed (was 2 before the fix)
    expect(await countTriples('plain2')).toBe(2);

    // Replace #2: holds → plain3. plain2 must now be fully removed too.
    await executeSparqlUpdate(replaceHolds('plain3'));
    await executeSparqlUpdate(materializeCell('plain3', 'c'));
    expect(await countTriples('plain2')).toBe(0);
    expect(await countTriples('plain3')).toBe(2);

    // Read-correctness: the current link resolves to plain3.
    const linked = await executeSparqlQuery(
      `SELECT ?cell WHERE { ${iri('card1')} ${iri('holds')} ?cell }`,
    );
    expect(linked.results.bindings.map((b: any) => b.cell.value)).toEqual([`${C}plain3`]);

    // No orphan TPlainCell nodes remain in the graph (only the currently-held one).
    const orphans = await executeSparqlQuery(
      `${RDF}SELECT (COUNT(DISTINCT ?cell) AS ?c) WHERE {
        ?cell rdf:type ${iri('TPlainCell')} .
        FILTER NOT EXISTS { ?card ${iri('holds')} ?cell }
      }`,
    );
    expect(Number(orphans.results.bindings[0]?.c?.value ?? 0)).toBe(0);
  });

  const hasEdge = async (s: string, p: string, o: string): Promise<boolean> => {
    const res = await executeSparqlQuery(`ASK { ${iri(s)} ${iri(p)} ${iri(o)} }`);
    return res.boolean === true;
  };

  test('re-sending the current id keeps the owned node', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} . }`,
    );
    await executeSparqlUpdate(materializeCell('plain1', 'a'));

    await executeSparqlUpdate(replaceHolds('plain1'));

    expect(await countTriples('plain1')).toBe(2);
    expect(await hasEdge('card1', 'holds', 'plain1')).toBe(true);
  });

  test('array overwrite keeps retained, deletes dropped', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ` +
        `${iri('cells')} ${iri('a')}, ${iri('b')}, ${iri('c')} . }`,
    );
    for (const id of ['a', 'b', 'c']) await executeSparqlUpdate(materializeCell(id, id));

    await executeSparqlUpdate(
      updateToSparql(
        lower(
          UpdateBuilder.from(TCard)
            .for(`${C}card1`)
            .set({cells: [{id: `${C}a`}, {id: `${C}b`}]} as any),
        ) as IRUpdateMutation,
      ),
    );

    expect(await countTriples('a')).toBe(2);
    expect(await countTriples('b')).toBe(2);
    expect(await countTriples('c')).toBe(0);
    expect(await hasEdge('card1', 'cells', 'a')).toBe(true);
    expect(await hasEdge('card1', 'cells', 'b')).toBe(true);
    expect(await hasEdge('card1', 'cells', 'c')).toBe(false);
  });

  test('subject delete removes owned child, keeps referenced-only nodes', async () => {
    if (!fusekiAvailable) return;
    // card1 owns plain1. box1 only refers to plain2 (not owned by anyone) and, as a
    // non-owning reference, to plain1, which will dangle after card1 is deleted (A5).
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} .
        ${iri('box1')} rdf:type ${iri('TBox')} ; ${iri('ref')} ${iri('plain2')} ; ${iri('tag')} ${iri('plain1')} . }`,
    );
    await executeSparqlUpdate(materializeCell('plain1', 'a'));
    await executeSparqlUpdate(materializeCell('plain2', 'b'));

    await executeSparqlUpdate(
      deleteToSparql(lower(DeleteBuilder.from(TCard, {id: `${C}card1`})) as IRDeleteMutation),
    );

    expect(await countTriples('card1')).toBe(0);
    expect(await countTriples('plain1')).toBe(0);
    expect(await countTriples('plain2')).toBe(2);
    // The referencing subject is untouched, including its now-dangling reference.
    expect(await countTriples('box1')).toBe(3);
    expect(await hasEdge('box1', 'tag', 'plain1')).toBe(true);
  });

  test('replacing a valueShape-less contains value keeps a plain predicate IRI', async () => {
    if (!fusekiAvailable) return;
    const RDFS = 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n';
    await executeSparqlUpdate(
      `${RDF}${RDFS}INSERT DATA { ${iri('pred')} rdfs:label "x" .
        ${iri('slot1')} rdf:type ${iri('TSlot')} ; ${iri('anyPath')} ${iri('pred')} . }`,
    );

    await executeSparqlUpdate(
      updateToSparql(
        lower(
          UpdateBuilder.from(TSlot).for(`${C}slot1`).set({anyPath: {id: `${C}pred2`}} as any),
        ) as IRUpdateMutation,
      ),
    );

    expect(await countTriples('pred')).toBe(1);
    expect(await hasEdge('slot1', 'anyPath', 'pred2')).toBe(true);
    expect(await hasEdge('slot1', 'anyPath', 'pred')).toBe(false);
  });

  test('deleteAll deletes every subject\'s owned children, keeps unowned nodes', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} ; ${iri('cells')} ${iri('a')} .
        ${iri('card2')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain2')} . }`,
    );
    for (const id of ['plain1', 'plain2', 'a', 'free']) await executeSparqlUpdate(materializeCell(id, id));

    await executeSparqlUpdate(
      deleteAllToSparql(lower(DeleteBuilder.from(TCard).all()) as IRDeleteAllMutation),
    );

    for (const id of ['card1', 'card2', 'plain1', 'plain2', 'a']) expect(await countTriples(id)).toBe(0);
    expect(await countTriples('free')).toBe(2);
  });

  test('deleteAll cascades into a dependent owned chain', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('b1')} rdf:type ${iri('TBox')} ; ${iri('owns')} ${iri('cell0')} ; ${iri('ref')} ${iri('free')} .
        ${iri('cell0')} rdf:type ${iri('TCell')} ; ${iri('next')} ${iri('cell1')} .
        ${iri('cell1')} rdf:type ${iri('TCell')} ; ${iri('next')} ${iri('cell2')} .
        ${iri('cell2')} rdf:type ${iri('TCell')} .
        ${iri('free')} rdf:type ${iri('TCell')} . }`,
    );

    await executeSparqlUpdate(
      deleteAllToSparql(lower(DeleteBuilder.from(TBox).all()) as IRDeleteAllMutation),
    );

    for (const id of ['b1', 'cell0', 'cell1', 'cell2']) expect(await countTriples(id)).toBe(0);
    expect(await countTriples('free')).toBe(1);
  });

  test('delete().where() deletes only the matched subject\'s owned children', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('title')} "x" ; ${iri('holds')} ${iri('plain1')} .
        ${iri('card2')} rdf:type ${iri('TCard')} ; ${iri('title')} "y" ; ${iri('holds')} ${iri('plain2')} . }`,
    );
    await executeSparqlUpdate(materializeCell('plain1', 'a'));
    await executeSparqlUpdate(materializeCell('plain2', 'b'));

    await executeSparqlUpdate(
      deleteWhereToSparql(
        lower(DeleteBuilder.from(TCard).where((c: any) => c.title.equals('x'))) as IRDeleteWhereMutation,
      ),
    );

    expect(await countTriples('card1')).toBe(0);
    expect(await countTriples('plain1')).toBe(0);
    expect(await countTriples('card2')).toBe(3);
    expect(await countTriples('plain2')).toBe(2);
  });
});

// The shape sync deletes every shape description through this path on every boot.
// Its WHERE once chained the cascade blocks as OPTIONALs, so the solutions were the
// product of all of them: ~27,000 rows and 30+ seconds per shape on Fuseki, which made
// a server's second boot take minutes. Counted here as solutions of the generated WHERE.
describe('owned-subtree cascade — live Fuseki (delete WHERE size)', () => {
  const C = 'http://example.org/c#';
  const iri = (n: string) => `<${C}${n}>`;
  const RDF = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n';
  let fusekiAvailable = false;

  beforeAll(async () => {
    fusekiAvailable = await ensureFuseki();
    if (fusekiAvailable) await createTestDataset();
  });
  afterAll(async () => {
    if (fusekiAvailable) await clearAllData();
  });
  beforeEach(async () => {
    if (fusekiAvailable) await clearAllData();
  });

  test('solutions add up across blocks instead of multiplying, and the delete is complete', async () => {
    if (!fusekiAvailable) return;
    const OWN = 8; // extra own triples on the box
    const REFS = 8; // incoming references to the box
    const CELLS = 4; // owned chain b1 -owns-> cell0 -next-> cell1 ...
    const triples: string[] = [`${iri('b1')} rdf:type ${iri('TBox')} .`];
    for (let i = 0; i < OWN; i++) triples.push(`${iri('b1')} ${iri('tag')} "t${i}" .`);
    for (let i = 0; i < REFS; i++) triples.push(`${iri(`r${i}`)} ${iri('ref')} ${iri('b1')} .`);
    triples.push(`${iri('b1')} ${iri('owns')} ${iri('cell0')} .`);
    for (let i = 0; i < CELLS; i++) {
      triples.push(`${iri(`cell${i}`)} rdf:type ${iri('TCell')} .`);
      if (i + 1 < CELLS) triples.push(`${iri(`cell${i}`)} ${iri('next')} ${iri(`cell${i + 1}`)} .`);
    }
    // A node the box only refers to: not owned, so it must survive.
    triples.push(`${iri('b1')} ${iri('ref')} ${iri('free')} .`, `${iri('free')} rdf:type ${iri('TCell')} .`);
    await executeSparqlUpdate(`${RDF}INSERT DATA {\n${triples.join('\n')}\n}`);

    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TBox, {id: `${C}b1`})) as IRDeleteMutation,
    );
    const countQuery = sparql.replace(/DELETE \{[\s\S]*?\n\}\nWHERE/, 'SELECT (COUNT(*) AS ?n)\nWHERE');
    const res = await executeSparqlQuery(countQuery);
    const solutions = Number(res.results.bindings[0]?.n?.value ?? 0);

    // b1's own triples: type + OWN tags + owns + ref = OWN + 3; incoming: REFS;
    // the immediately-owned cell0's own triples (type + next) = 2;
    // owned cells: CELLS types + (CELLS - 1) next edges.
    const additive = OWN + 3 + REFS + 2 + CELLS + (CELLS - 1);
    expect(solutions).toBe(additive);

    await executeSparqlUpdate(sparql);
    const left = await executeSparqlQuery(`SELECT ?s ?p ?o WHERE { ?s ?p ?o }`);
    const remaining = left.results.bindings
      .map((b: any) => `${b.s.value} ${b.p.value} ${b.o.value}`)
      .sort();
    expect(remaining).toEqual([`${C}free http://www.w3.org/1999/02/22-rdf-syntax-ns#type ${C}TCell`]);
  });
});
