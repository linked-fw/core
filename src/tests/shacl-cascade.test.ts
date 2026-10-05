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
import {objectProperty} from '../shapes/SHACL';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {
  deleteToSparql,
  updateToSparql,
  upsertToSparql,
  buildOwnedCascade,
  buildOwnedSelfDelete,
} from '../sparql/irToAlgebra';
import type {
  IRDeleteMutation,
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
  @objectProperty({path: ex('holds'), shape: TPlainCell, maxCount: 1, contains: true})
  get holds(): TPlainCell {
    return null;
  }
  @objectProperty({path: ex('cells'), shape: TPlainCell, contains: true})
  get cells(): TPlainCell[] {
    return [];
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
    expect(sparql).toMatch(/\)\+ /); // (…|…)+ property path
    // only deletes reached nodes asserted to be a dependent type
    expect(sparql).toContain('http://example.org/c#TCell');
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
    expect(upsertSparql).toMatch(/\)\+ /);
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
    expect(sparql).toMatch(/\)\+ /);
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
    expect(sparql).toMatch(/\)\+ /);
    expect(sparql).toContain('http://example.org/c#TCell');
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
});
