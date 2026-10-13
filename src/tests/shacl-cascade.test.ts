/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {
  createTestDataset,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, NodeShape, objectProperty} from '../shapes/SHACL';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {
  deleteAllToSparql,
  deleteToSparql,
  deleteWhereToSparql,
  updateToSparql,
  updateWhereToSparql,
  upsertToSparql,
  buildOwnedSelfDelete,
} from '../sparql/irToAlgebra';
import type {
  IRDeleteAllMutation,
  IRDeleteMutation,
  IRDeleteWhereMutation,
  IRUpdateWhereMutation,
  IRUpdateMutation,
  IRUpsertMutation,
} from '../queries/IntermediateRepresentation';
// Register List / PathNode, so the NodeShape delete walks the real metamodel.
import '../shapes/List';
import '../shapes/PathNode';
import {lower} from '../queries/lower';

const {linkedShape} = linkedPackage('cascade-test');
const ex = (n: string) => ({id: `http://example.org/c#${n}`});

@linkedShape
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

// A `contains` child that owns nothing — mirrors `schema:ImageObject` owned via `Thing.image`
// (backlog 032). The replace/remove self-delete fires on the `contains` edge alone.
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

// A plain property on the predicate `TBox.owns` declares `contains`: it owns nothing.
@linkedShape
class TRef extends Shape {
  static targetClass = ex('TRef');
  @objectProperty({path: ex('owns'), shape: TCell, maxCount: 1})
  get held(): TCell {
    return null;
  }
  @objectProperty({path: ex('owns'), shape: TCell})
  get heldMany(): TCell[] {
    return [];
  }
}

// Owns a TCard, which owns TPlainCell values: a two-level owned tree with no `dependent`.
@linkedShape
class TShelf extends Shape {
  static targetClass = ex('TShelf');
  @objectProperty({path: ex('card'), shape: TCard, maxCount: 1, contains: true})
  get card(): TCard {
    return null;
  }
}

// A value shape (TImg) with a registered sub-shape (TPhoto) that adds ownership (thumb).
@linkedShape
class TImg extends Shape {
  static targetClass = ex('TImg');
  @literalProperty({path: ex('caption'), maxCount: 1})
  get caption(): string {
    return null;
  }
}

@linkedShape
class TPhoto extends TImg {
  static targetClass = ex('TPhoto');
  @objectProperty({path: ex('thumb'), shape: TPlainCell, maxCount: 1, contains: true})
  get thumb(): TPlainCell {
    return null;
  }
}

@linkedShape
class TAlbum extends Shape {
  static targetClass = ex('TAlbum');
  @objectProperty({path: ex('cover'), shape: TImg, maxCount: 1, contains: true})
  get cover(): TImg {
    return null;
  }
}

describe('contains needs a value shape', () => {
  test('a contains property without a shape throws at decoration', () => {
    expect(() => {
      @linkedShape
      class TNoShape extends Shape {
        static targetClass = ex('TNoShape');
        @objectProperty({path: ex('anyPath'), maxCount: 1, contains: true})
        get anyPath(): unknown {
          return null;
        }
      }
      return TNoShape;
    }).toThrow(/The contains property "anyPath" needs a `shape`/);
  });
});

describe('owned-subtree walk', () => {
  const C0 = 'http://example.org/c#';
  const deleteOf = (shape: any, id = `${C0}b1`) =>
    deleteToSparql(lower(DeleteBuilder.from(shape, {id})) as IRDeleteMutation);

  test('delete follows the owned edge, then the value shape\'s own owned edges, with no type guard', () => {
    const sparql = deleteOf(TBox);
    // owns → TCell, then TCell.next as a closure (TCell owns its own kind).
    expect(sparql).toMatch(
      /<http:\/\/example\.org\/c#b1> <http:\/\/example\.org\/c#owns> \?c_0_0e \.\s*\?c_0_0e <http:\/\/example\.org\/c#next>\* \?c_0_0 \.\s*\?c_0_0 \?c_0_p \?c_0_o \./,
    );
    expect(deleteBlockOf(sparql)).toContain('?c_0_0 ?c_0_p ?c_0_o .');
    // The edge alone asserts ownership: no `rdf:type` guard on owned nodes.
    expect(sparql).not.toContain('<http://example.org/c#TCell>');
  });

  test('delete joins its blocks with UNION, never with chained OPTIONALs', () => {
    // Chained OPTIONALs multiply: own triples x incoming references x each owned group's
    // triples. A UNION adds them up and deletes the same triples.
    const where = deleteOf(TBox).slice(deleteOf(TBox).indexOf('WHERE'));
    expect(where).not.toContain('OPTIONAL');
    expect(where).toContain('UNION');
    // The type guard is still required, outside the UNION.
    expect(where).toMatch(/^WHERE \{\n  <http:\/\/example\.org\/c#b1> rdf:type <http:\/\/example\.org\/c#TBox> \./);
  });

  test('safety: a non-contains property (ref) is not followed', () => {
    expect(deleteOf(TBox)).not.toContain('#ref');
  });

  test('a plain property on a predicate another shape declares contains owns nothing', () => {
    // TRef.held is plain on ex:owns, which TBox.owns declares `contains`.
    const replace = updateSparqlOf(UpdateBuilder.from(TRef).for(`${C0}r1`).set({held: {id: `${C0}c2`}}));
    // Only the edge is replaced: no self-delete of the old value, no subtree.
    expect(replace).not.toMatch(/\?old_held \?\w+ \?\w+ \./);
    expect(replace).not.toMatch(/\?uc\d/);
    const remove = updateSparqlOf(
      UpdateBuilder.from(TRef).for(`${C0}r1`).set({heldMany: {remove: [{id: `${C0}c2`}]}} as any),
    );
    expect(deleteBlockOf(remove)).not.toMatch(/<http:\/\/example\.org\/c#c2> \?\w+ \?\w+ \./);
    expect(remove).not.toMatch(/\?ucr_/);
    // Nor does a subject delete follow it.
    expect(deleteOf(TRef, `${C0}r1`)).not.toMatch(/#owns> \?c_/);
  });

  test('a recursive value shape: the replaced root\'s own group is followed with +', () => {
    const sparql = updateSparqlOf(UpdateBuilder.from(TBox).for(`${C0}b1`).set({owns: {id: `${C0}newcell`}}));
    // The old value itself (self-delete), and the cells after it.
    expect(sparql).toMatch(/\?old_owns \?uc0_sp \?uc0_so \./);
    expect(sparql).toMatch(/#owns> \?old_owns \.\s*\?old_owns <http:\/\/example\.org\/c#next>\+ \?uc0_r \.\s*\?uc0_r \?uc0_rp \?uc0_ro \./);
  });

  test('deeper owned values go with the owner, whether or not they are dependent', () => {
    // TShelf owns TCard (not dependent), which owns TPlainCell values through holds / cells.
    const sparql = deleteOf(TShelf, `${C0}shelf1`);
    expect(sparql).toMatch(/<http:\/\/example\.org\/c#shelf1> <http:\/\/example\.org\/c#card> \?c_0_0 \.\s*\?c_0_0 \?c_0_p \?c_0_o \./);
    expect(sparql).toMatch(/\?c_\d+_0 <http:\/\/example\.org\/c#holds> \?c_\d+_1 \.\s*\?c_\d+_1 \?c_\d+_p \?c_\d+_o \./);
    expect(sparql).toMatch(/\?c_\d+_0 <http:\/\/example\.org\/c#cells> \?c_\d+_1 \./);
  });

  test('a registered sub-shape that adds a contains property gets a block guarded by its class', () => {
    const sparql = deleteOf(TAlbum, `${C0}album1`);
    // The declared value shape's own value: unguarded.
    expect(sparql).toMatch(/#cover> \?c_0_0 \.\s*\?c_0_0 \?c_0_p \?c_0_o \./);
    // TPhoto (extends TImg) adds `thumb`: followed only from nodes typed TPhoto.
    expect(sparql).toMatch(
      /#cover> \?c_1_0 \.\s*\?c_1_0 rdf:type <http:\/\/example\.org\/c#TPhoto> \.\s*\?c_1_0 <http:\/\/example\.org\/c#thumb> \?c_1_1 \.\s*\?c_1_1 \?c_1_p \?c_1_o \./,
    );
    // A shape whose value shape has no ownership-adding sub-shape emits no guard.
    expect(deleteOf(TCard, `${C0}card1`)).not.toMatch(/\?c_\w+ rdf:type/);
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

    // Subtree markers still present under upsert.
    expect(upsertSparql).toContain('<http://example.org/c#oldcell> <http://example.org/c#next>+ ?ucr_items_0_r .');

    // And the only difference from the update is the type triple. This particular update
    // only removes, so it has no INSERT block at all — the upsert grows one to hold it.
    // (The type triple may also add the `rdf:` prefix the update does not need.)
    const added = upsertSparql
      .split('\n')
      .filter((l) => !updateSparql.split('\n').includes(l) && !l.startsWith('PREFIX'));
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

  // --- backlog 032: replace/remove of a `contains` edge deletes the old node itself,
  // even when the owned child shape is NOT `dependent` (contains = exclusive ownership). ---

  test('replace of a contains child deletes the old node\'s own triples', () => {
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

  test('set-remove of a contains child deletes the removed node\'s own triples', () => {
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
      UpdateBuilder.from(TBox).for(`${C}b1`).set({owns: {id: `${C}cell1`}}),
    );
    const branches = branchesOf(sparql);
    const self = branches.find((b) => /\?old_owns \?uc0_sp \?uc0_so/.test(b));
    expect(self).toBeDefined();
    // The filter sits inside the same group as the edge that binds ?old_owns.
    expect(self).toMatch(/#owns> \?old_owns \.[\s\S]*FILTER\(\?old_owns NOT IN \(<http:\/\/example\.org\/c#cell1>\)\)/);
    // The edge-only branch has no filter: the edge is deleted and re-inserted (a no-op).
    const edgeOnly = branches.find((b) => /#owns> \?old_owns \.\s*\}/.test(b) && !/\?uc0_/.test(b));
    expect(edgeOnly).toBeDefined();
    expect(edgeOnly).not.toContain('FILTER');
    // Every subtree branch is filtered too.
    const subtree = branches.filter((b) => /\?uc0_r\b/.test(b));
    expect(subtree.length).toBeGreaterThan(0);
    for (const b of subtree) expect(b).toContain('FILTER(?old_owns NOT IN (<http://example.org/c#cell1>))');
  });

  test('replace with a different {id} keeps the filter harmless', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TCard).for(`${C}card1`).set({holds: {id: `${C}newplain`}}),
    );
    // The keep filters; the blank-node blocks' own `isBlank` filters are not keep filters.
    const filters = [...(sparql.match(/FILTER\([^)]*\)\)/g) ?? [])].filter((f: string) => !/isBlank\(/.test(f));
    expect(filters.length).toBeGreaterThan(0);
    // Only the new id is listed; an old value that differs is still deleted.
    for (const f of filters) expect(f).toBe('FILTER(?old_holds NOT IN (<http://example.org/c#newplain>))');
  });

  test('array overwrite keeps the retained ids', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TBag).for(`${C}bag1`).set({items: [{id: `${C}a`}, {id: `${C}b`}]} as any),
    );
    const kept = 'FILTER(?old_items NOT IN (<http://example.org/c#a>, <http://example.org/c#b>))';
    const branches = branchesOf(sparql);
    const self = branches.find((b) => /\?old_items \?uc0_sp \?uc0_so/.test(b));
    expect(self).toContain(kept);
    const subtree = branches.filter((b) => /\?uc0_r\b/.test(b));
    expect(subtree.length).toBeGreaterThan(0);
    for (const b of subtree) expect(b).toContain(kept);
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

  test('set-remove subtree is anchored on the owning edge', () => {
    const sparql = updateSparqlOf(
      UpdateBuilder.from(TBag).for(`${C}bag1`).set({items: {remove: [{id: `${C}old`}]}} as any),
    );
    const subtree = branchesOf(sparql).filter((b) => /\?ucr_items_0_r\b/.test(b));
    expect(subtree.length).toBeGreaterThan(0);
    for (const b of subtree) {
      expect(b).toMatch(/<http:\/\/example\.org\/c#bag1> <http:\/\/example\.org\/c#items> <http:\/\/example\.org\/c#old> \./);
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

  test('subject delete removes owned children', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TCard, {id: `${C}card1`})) as IRDeleteMutation,
    );
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).toMatch(/\{\s*<http:\/\/example\.org\/c#card1> <http:\/\/example\.org\/c#holds> \?c_0_0 \.\s*\?c_0_0 \?c_0_p \?c_0_o \.\s*\}/);
    expect(where).toMatch(/\{\s*<http:\/\/example\.org\/c#card1> <http:\/\/example\.org\/c#cells> \?c_1_0 \.\s*\?c_1_0 \?c_1_p \?c_1_o \.\s*\}/);
    expect(where).not.toContain('OPTIONAL');
    expect(deleteBlockOf(sparql)).toContain('?c_0_0 ?c_0_p ?c_0_o .');
    expect(deleteBlockOf(sparql)).toContain('?c_1_0 ?c_1_p ?c_1_o .');
  });

  test('multi-id delete prefixes child vars per id', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(TCard, [{id: `${C}card1`}, {id: `${C}card2`}])) as IRDeleteMutation,
    );
    expect(sparql).toContain('<http://example.org/c#card2> <http://example.org/c#holds> ?c_1_0_0 .');
    expect(sparql).toContain('?c_1_0_0 ?c_1_0_p ?c_1_0_o .');
    expect(sparql).toContain('?c_0_1_0 ?c_0_1_p ?c_0_1_o .');
  });

  const CARD_TYPE = '\\?a0 rdf:type <http:\\/\\/example\\.org\\/c#TCard> \\.';

  test('deleteAll removes owned children, each block led by the type triple', () => {
    const sparql = deleteAllToSparql(lower(DeleteBuilder.from(TCard).all()) as IRDeleteAllMutation);
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).toMatch(
      new RegExp(`\\{\\s*${CARD_TYPE}\\s*\\?a0 <http:\\/\\/example\\.org\\/c#holds> \\?c_0_0 \\.\\s*\\?c_0_0 \\?c_0_p \\?c_0_o \\.\\s*\\}`),
    );
    expect(where).toMatch(
      new RegExp(`\\{\\s*${CARD_TYPE}\\s*\\?a0 <http:\\/\\/example\\.org\\/c#cells> \\?c_1_0 \\.\\s*\\?c_1_0 \\?c_1_p \\?c_1_o \\.\\s*\\}`),
    );
    expect(where).not.toContain('OPTIONAL');
    const del = deleteBlockOf(sparql);
    expect(del).toContain('?a0 ?p ?o .');
    expect(del).toContain('?c_0_0 ?c_0_p ?c_0_o .');
    expect(del).toContain('?c_1_0 ?c_1_p ?c_1_o .');
  });

  test('deleteAll of a recursive owner follows the closure, led by the type triple', () => {
    const box = deleteAllToSparql(lower(DeleteBuilder.from(TBox).all()) as IRDeleteAllMutation);
    for (const b of branchesOf(box).filter((b) => /\?c_0_0e/.test(b))) {
      expect(b).toMatch(/\?a0 rdf:type <http:\/\/example\.org\/c#TBox> \.\s*\?a0 <http:\/\/example\.org\/c#owns> \?c_0_0e \.\s*\?c_0_0e <http:\/\/example\.org\/c#next>\* \?c_0_0 \./);
    }
    expect(box).not.toContain('#ref>');
  });

  test('delete().where() carries the same owned blocks, joined with the filtered match', () => {
    const sparql = deleteWhereToSparql(
      lower(DeleteBuilder.from(TCard).where((c: any) => c.title.equals('x'))) as IRDeleteWhereMutation,
    );
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).toContain('FILTER');
    expect(where).toContain('?a0 <http://example.org/c#holds> ?c_0_0 .');
    expect(where).toContain('?a0 <http://example.org/c#cells> ?c_1_0 .');
    expect(where).not.toContain('OPTIONAL');
  });

  test('the shape-sync delete of a NodeShape walks generated shapes, property shapes and sh:in lists', () => {
    const sparql = deleteToSparql(
      lower(DeleteBuilder.from(NodeShape, {id: `${C}Shape`})) as IRDeleteMutation,
    );
    expect(sparql).toContain(`<${C}Shape> core:generatedShape+ ?c_r .`);
    expect(sparql).toMatch(/core:generatedShape\* \?c_w \.\s*\?c_w shacl:property \?c_0_0 \.\s*\?c_0_0 \?c_0_p \?c_0_o \./);
    expect(sparql).toMatch(/\?c_\d+_0 shacl:in \?c_\d+_1e \.\s*\?c_\d+_1e rdf:rest\* \?c_\d+_1 \./);
    // No type guards: ownership is the edge.
    expect(sparql).not.toMatch(/\?c_\w+ rdf:type/);
  });
});

// Live end-to-end reproduction of backlog 032: replacing a `contains`-owned node whose
// shape is NOT `dependent` must leave no orphan behind. Skips gracefully if Fuseki is down.
describeFuseki('owned-subtree cascade — live Fuseki (backlog 032 orphan repro)', () => {
  const C = 'http://example.org/c#';
  const iri = (n: string) => `<${C}${n}>`;
  const RDF = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n';

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
    await createTestDataset();
  });
  afterAll(async () => {
    await clearAllData();
  });
  beforeEach(async () => {
    await clearAllData();
  });

  test('replacing a contains-owned node twice accumulates zero orphans', async () => {

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
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} . }`,
    );
    await executeSparqlUpdate(materializeCell('plain1', 'a'));

    await executeSparqlUpdate(replaceHolds('plain1'));

    expect(await countTriples('plain1')).toBe(2);
    expect(await hasEdge('card1', 'holds', 'plain1')).toBe(true);
  });

  test('array overwrite keeps retained, deletes dropped', async () => {
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

  test('a plain property on a contains predicate keeps its old value on replace', async () => {
    // r1 holds c1 through ex:owns, the predicate TBox.owns declares `contains`; TRef.held is plain.
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('r1')} rdf:type ${iri('TRef')} ; ${iri('owns')} ${iri('c1')} .
        ${iri('c1')} rdf:type ${iri('TCell')} ; ${iri('label')} "x" . }`,
    );
    await executeSparqlUpdate(
      updateToSparql(
        lower(UpdateBuilder.from(TRef).for(`${C}r1`).set({held: {id: `${C}c2`}})) as IRUpdateMutation,
      ),
    );
    expect(await countTriples('c1')).toBe(2);
    expect(await hasEdge('r1', 'owns', 'c2')).toBe(true);
    expect(await hasEdge('r1', 'owns', 'c1')).toBe(false);
  });

  test('a sub-shape\'s owned value goes through the type-guarded block', async () => {
    // album1 owns img1 (value shape TImg); img1 is typed with the sub-shape TPhoto, which owns t1.
    // album2 owns img2, typed TImg only, which holds t2 through the same predicate: not owned.
    await executeSparqlUpdate(
      `${RDF}INSERT DATA {
        ${iri('album1')} rdf:type ${iri('TAlbum')} ; ${iri('cover')} ${iri('img1')} .
        ${iri('img1')} rdf:type ${iri('TPhoto')} ; ${iri('thumb')} ${iri('t1')} .
        ${iri('t1')} rdf:type ${iri('TPlainCell')} ; ${iri('label')} "t1" .
        ${iri('album2')} rdf:type ${iri('TAlbum')} ; ${iri('cover')} ${iri('img2')} .
        ${iri('img2')} rdf:type ${iri('TImg')} ; ${iri('thumb')} ${iri('t2')} .
        ${iri('t2')} rdf:type ${iri('TPlainCell')} ; ${iri('label')} "t2" . }`,
    );
    for (const album of ['album1', 'album2']) {
      await executeSparqlUpdate(
        deleteToSparql(lower(DeleteBuilder.from(TAlbum, {id: `${C}${album}`})) as IRDeleteMutation),
      );
    }
    expect(await countTriples('img1')).toBe(0);
    expect(await countTriples('t1')).toBe(0);
    expect(await countTriples('img2')).toBe(0);
    expect(await countTriples('t2')).toBe(2);
  });

  test('set-remove of an id the subject does not own deletes nothing of it', async () => {
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('cells')} ${iri('a')} .
        ${iri('card2')} rdf:type ${iri('TCard')} ; ${iri('cells')} ${iri('x')} . }`,
    );
    await executeSparqlUpdate(materializeCell('a', 'a'));
    await executeSparqlUpdate(materializeCell('x', 'x'));

    await executeSparqlUpdate(
      updateToSparql(
        lower(
          UpdateBuilder.from(TCard).for(`${C}card1`).set({cells: {remove: [{id: `${C}x`}]}} as any),
        ) as IRUpdateMutation,
      ),
    );

    expect(await countTriples('x')).toBe(2);
    expect(await hasEdge('card2', 'cells', 'x')).toBe(true);
    expect(await countTriples('a')).toBe(2);
    expect(await hasEdge('card1', 'cells', 'a')).toBe(true);
  });

  test('a kept id keeps its owned subtree', async () => {
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('b1')} rdf:type ${iri('TBox')} ; ${iri('owns')} ${iri('cell0')} .
        ${iri('cell0')} rdf:type ${iri('TCell')} ; ${iri('next')} ${iri('cell1')} .
        ${iri('cell1')} rdf:type ${iri('TCell')} ; ${iri('next')} ${iri('cell2')} .
        ${iri('cell2')} rdf:type ${iri('TCell')} . }`,
    );

    await executeSparqlUpdate(
      updateToSparql(
        lower(UpdateBuilder.from(TBox).for(`${C}b1`).set({owns: {id: `${C}cell0`}})) as IRUpdateMutation,
      ),
    );

    expect(await hasEdge('b1', 'owns', 'cell0')).toBe(true);
    expect(await countTriples('cell0')).toBe(2);
    expect(await countTriples('cell1')).toBe(2);
    expect(await countTriples('cell2')).toBe(1);
  });

  test('upsert with the current id keeps the owned node', async () => {
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} . }`,
    );
    await executeSparqlUpdate(materializeCell('plain1', 'a'));

    await executeSparqlUpdate(
      upsertToSparql(
        lower(
          UpdateBuilder.upsertFrom(TCard).for(`${C}card1`).set({holds: {id: `${C}plain1`}}),
        ) as IRUpsertMutation,
      ),
    );

    expect(await countTriples('plain1')).toBe(2);
    expect(await hasEdge('card1', 'holds', 'plain1')).toBe(true);
  });

  test('forAll() and where() with the current id keep it, and replace the others', async () => {
    const seed = async () => {
      await clearAllData();
      await executeSparqlUpdate(
        `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('title')} "x" ; ${iri('holds')} ${iri('plain1')} .
          ${iri('card2')} rdf:type ${iri('TCard')} ; ${iri('title')} "y" ; ${iri('holds')} ${iri('plain2')} . }`,
      );
      await executeSparqlUpdate(materializeCell('plain1', 'a'));
      await executeSparqlUpdate(materializeCell('plain2', 'b'));
    };

    // forAll: every card now holds plain1; plain1 is kept, card2's old plain2 is deleted.
    await seed();
    await executeSparqlUpdate(
      updateWhereToSparql(
        lower(UpdateBuilder.from(TCard).forAll().set({holds: {id: `${C}plain1`}})) as IRUpdateWhereMutation,
      ),
    );
    expect(await countTriples('plain1')).toBe(2);
    expect(await countTriples('plain2')).toBe(0);
    expect(await hasEdge('card1', 'holds', 'plain1')).toBe(true);
    expect(await hasEdge('card2', 'holds', 'plain1')).toBe(true);

    // where(): only the matched card is touched; its kept value survives.
    await seed();
    await executeSparqlUpdate(
      updateWhereToSparql(
        lower(
          UpdateBuilder.from(TCard)
            .where((c: any) => c.title.equals('x'))
            .set({holds: {id: `${C}plain1`}}),
        ) as IRUpdateWhereMutation,
      ),
    );
    expect(await countTriples('plain1')).toBe(2);
    expect(await countTriples('plain2')).toBe(2);
    expect(await hasEdge('card1', 'holds', 'plain1')).toBe(true);
    expect(await hasEdge('card2', 'holds', 'plain2')).toBe(true);
  });

  test('two owners of one node: deleting one deletes the node, the other edge dangles', async () => {
    // card2 links plain1 by {id} although card1 already owns it, which breaks the
    // single-owner rule. Nothing refuses that on write (the rule is SHACL only).
    await executeSparqlUpdate(
      `${RDF}INSERT DATA { ${iri('card1')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} .
        ${iri('card2')} rdf:type ${iri('TCard')} ; ${iri('holds')} ${iri('plain1')} . }`,
    );
    await executeSparqlUpdate(materializeCell('plain1', 'a'));

    await executeSparqlUpdate(
      deleteToSparql(lower(DeleteBuilder.from(TCard, {id: `${C}card1`})) as IRDeleteMutation),
    );

    expect(await countTriples('card1')).toBe(0);
    expect(await countTriples('plain1')).toBe(0);
    // The other owner keeps its edge, which now points at a node with no triples.
    expect(await countTriples('card2')).toBe(2);
    expect(await hasEdge('card2', 'holds', 'plain1')).toBe(true);
  });

  test('deleteAll deletes every subject\'s owned children, keeps unowned nodes', async () => {
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

  test('deleteAll follows an owned chain', async () => {
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
describeFuseki('owned-subtree cascade — live Fuseki (delete WHERE size)', () => {
  const C = 'http://example.org/c#';
  const iri = (n: string) => `<${C}${n}>`;
  const RDF = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n';

  beforeAll(async () => {
    await createTestDataset();
  });
  afterAll(async () => {
    await clearAllData();
  });
  beforeEach(async () => {
    await clearAllData();
  });

  test('solutions add up across blocks instead of multiplying, and the delete is complete', async () => {
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
    // the owned cells (`owns/next*`, cell0 included): CELLS types + (CELLS - 1) next edges.
    const additive = OWN + 3 + REFS + CELLS + (CELLS - 1);
    expect(solutions).toBe(additive);

    await executeSparqlUpdate(sparql);
    const left = await executeSparqlQuery(`SELECT ?s ?p ?o WHERE { ?s ?p ?o }`);
    const remaining = left.results.bindings
      .map((b: any) => `${b.s.value} ${b.p.value} ${b.o.value}`)
      .sort();
    expect(remaining).toEqual([`${C}free http://www.w3.org/1999/02/22-rdf-syntax-ns#type ${C}TCell`]);
  });
});
