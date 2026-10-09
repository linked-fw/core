/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * The WHERE of an update, an update-where and a bulk delete must ADD UP its independent
 * blocks, not multiply them. Chained OPTIONALs are a join: the old values of two
 * multi-valued properties, an owned node's own triples and its owned subtree, a root's
 * triples and each of its blank-node subtrees all multiply into one row per combination.
 * A UNION yields each block's matches once and deletes the same triples.
 *
 * Counted here as solutions of the generated WHERE against a live Fuseki, plus the
 * graph left behind, plus the shape of the generated algebra.
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
import {shacl} from '../ontologies/shacl';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {
  updateToAlgebra,
  updateToSparql,
  updateWhereToSparql,
  deleteAllToAlgebra,
  deleteAllToSparql,
  deleteWhereToSparql,
} from '../sparql/irToAlgebra';
import type {
  IRUpdateMutation,
  IRUpdateWhereMutation,
  IRDeleteAllMutation,
  IRDeleteWhereMutation,
} from '../queries/IntermediateRepresentation';
import {lower} from '../queries/lower';

const {linkedShape} = linkedPackage('where-union-test');
const U = 'http://example.org/u#';
const ex = (n: string) => ({id: `${U}${n}`});
const iri = (n: string) => `<${U}${n}>`;
const RDF = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n';

@linkedShape({dependent: true})
class UCell extends Shape {
  static targetClass = ex('UCell');
  @objectProperty({path: ex('next'), shape: UCell, maxCount: 1, contains: true})
  get next(): UCell {
    return null;
  }
  @literalProperty({path: ex('tag')})
  get tag(): string[] {
    return [];
  }
}

@linkedShape
class UBox extends Shape {
  static targetClass = ex('UBox');
  @objectProperty({path: ex('owns'), shape: UCell, maxCount: 1, contains: true})
  get owns(): UCell {
    return null;
  }
  @literalProperty({path: ex('tags')})
  get tags(): string[] {
    return [];
  }
  @objectProperty({path: ex('refs'), shape: UCell})
  get refs(): UCell[] {
    return [];
  }
  @literalProperty({path: ex('label'), maxCount: 1})
  get label(): string {
    return null;
  }
}

@linkedShape
class UGeo extends Shape {
  static targetClass = ex('UGeo');
  @literalProperty({path: ex('lat')})
  get lat(): string[] {
    return [];
  }
}

@linkedShape
class UAddr extends Shape {
  static targetClass = ex('UAddr');
  @literalProperty({path: ex('line')})
  get line(): string[] {
    return [];
  }
  @objectProperty({path: ex('geo'), shape: UGeo, maxCount: 1, nodeKind: shacl.BlankNode})
  get geo(): UGeo {
    return null;
  }
}

@linkedShape
class UHolder extends Shape {
  static targetClass = ex('UHolder');
  @literalProperty({path: ex('name')})
  get name(): string[] {
    return [];
  }
  @objectProperty({path: ex('addr'), shape: UAddr, maxCount: 1, nodeKind: shacl.BlankNode})
  get addr(): UAddr {
    return null;
  }
  @objectProperty({path: ex('alt'), shape: UAddr, maxCount: 1, nodeKind: shacl.BlankNode})
  get alt(): UAddr {
    return null;
  }
}

/** Rewrite a generated DELETE/INSERT … WHERE into a COUNT of its WHERE's solutions. */
const countSolutions = async (sparql: string): Promise<number> => {
  const select = sparql
    .replace(/(DELETE|INSERT) \{[\s\S]*?\n\}\n/g, '')
    .replace(/(^|\n)WHERE \{/, '$1SELECT (COUNT(*) AS ?n) WHERE {');
  const res = await executeSparqlQuery(select);
  return Number(res.results.bindings[0]?.n?.value ?? 0);
};

const allTriples = async (): Promise<string[]> => {
  const res = await executeSparqlQuery(`SELECT ?s ?p ?o WHERE { ?s ?p ?o }`);
  return res.results.bindings
    .map((b: any) => `${b.s.type === 'bnode' ? '_' : b.s.value} ${b.p.value} ${b.o.type === 'bnode' ? '_' : b.o.value}`)
    .sort();
};

const insert = (triples: string[]) =>
  executeSparqlUpdate(`${RDF}INSERT DATA {\n${triples.join('\n')}\n}`);

const T = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// ---------------------------------------------------------------------------
// Generated algebra
// ---------------------------------------------------------------------------

describe('mutation WHERE — algebra', () => {
  test('update of two properties: one OPTIONAL over a UNION of their old values', () => {
    const plan = updateToAlgebra(
      lower(
        UpdateBuilder.from(UBox).for(`${U}b1`).set({tags: ['x'], refs: [{id: `${U}r`}]} as any),
      ) as IRUpdateMutation,
    );
    const where = plan.whereAlgebra as any;
    expect(where.type).toBe('left_join');
    expect(where.left).toEqual({type: 'bgp', triples: []});
    expect(where.right.type).toBe('union');
    expect(where.right.left).toEqual({type: 'bgp', triples: [expect.objectContaining({object: {kind: 'variable', name: 'old_tags'}})]});
    expect(where.right.right).toEqual({type: 'bgp', triples: [expect.objectContaining({object: {kind: 'variable', name: 'old_refs'}})]});
  });

  test('update of one property keeps its single OPTIONAL', () => {
    const sparql = updateToSparql(
      lower(UpdateBuilder.from(UBox).for(`${U}b1`).set({label: 'x'})) as IRUpdateMutation,
    );
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where).not.toContain('UNION');
    expect(where.match(/OPTIONAL/g)).toHaveLength(1);
  });

  test('replacing a contains property: no OPTIONAL chain, and every cascade block re-binds the old value through the owning edge', () => {
    const sparql = updateToSparql(
      lower(UpdateBuilder.from(UBox).for(`${U}b1`).set({owns: {id: `${U}newcell`}})) as IRUpdateMutation,
    );
    const where = sparql.slice(sparql.indexOf('WHERE'));
    expect(where.match(/OPTIONAL/g)).toHaveLength(1);
    expect(where).toContain('UNION');
    const branches = where.split('UNION');
    // Old value, self-delete, one cascade block per dependent type: every branch that
    // mentions ?old_owns binds it through <b1> <owns> ?old_owns inside the same branch.
    for (const branch of branches.filter((b) => b.includes('?old_owns'))) {
      expect(branch).toMatch(/<http:\/\/example\.org\/u#b1> <http:\/\/example\.org\/u#owns> \?old_owns \./);
    }
  });

  test('deleteAll: the type guard, then a UNION of the root wildcard and each blank-node block', () => {
    const plan = deleteAllToAlgebra(
      lower(DeleteBuilder.from(UHolder).all()) as IRDeleteAllMutation,
    );
    const where = plan.whereAlgebra as any;
    expect(where.type).toBe('join');
    expect(where.left.type).toBe('bgp');
    expect(where.left.triples).toHaveLength(1);
    expect(where.right.type).toBe('union');
    const sparql = deleteAllToSparql(lower(DeleteBuilder.from(UHolder).all()) as IRDeleteAllMutation);
    const whereText = sparql.slice(sparql.indexOf('WHERE'));
    expect(whereText).not.toContain('OPTIONAL');
    // root, addr, addr/geo, alt, alt/geo
    expect(whereText.match(/UNION/g)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Live Fuseki
// ---------------------------------------------------------------------------

describe('mutation WHERE — live Fuseki (solutions add up)', () => {
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

  test('update of two multi-valued properties', async () => {
    if (!fusekiAvailable) return;
    const TAGS = 6;
    const REFS = 5;
    const triples = [`${iri('b1')} rdf:type ${iri('UBox')} .`];
    for (let i = 0; i < TAGS; i++) triples.push(`${iri('b1')} ${iri('tags')} "t${i}" .`);
    for (let i = 0; i < REFS; i++) triples.push(`${iri('b1')} ${iri('refs')} ${iri(`r${i}`)} .`);
    await insert(triples);

    const sparql = updateToSparql(
      lower(
        UpdateBuilder.from(UBox).for(`${U}b1`).set({tags: ['new'], refs: [{id: `${U}rnew`}]} as any),
      ) as IRUpdateMutation,
    );
    expect(await countSolutions(sparql)).toBe(TAGS + REFS);

    await executeSparqlUpdate(sparql);
    expect(await allTriples()).toEqual(
      [`${U}b1 ${T} ${U}UBox`, `${U}b1 ${U}tags new`, `${U}b1 ${U}refs ${U}rnew`].sort(),
    );
  });

  test('update with no old values still inserts', async () => {
    if (!fusekiAvailable) return;
    await insert([`${iri('b1')} rdf:type ${iri('UBox')} .`]);
    const sparql = updateToSparql(
      lower(
        UpdateBuilder.from(UBox).for(`${U}b1`).set({tags: ['new'], refs: [{id: `${U}rnew`}]} as any),
      ) as IRUpdateMutation,
    );
    expect(await countSolutions(sparql)).toBe(1);
    await executeSparqlUpdate(sparql);
    expect(await allTriples()).toEqual(
      [`${U}b1 ${T} ${U}UBox`, `${U}b1 ${U}tags new`, `${U}b1 ${U}refs ${U}rnew`].sort(),
    );
  });

  test('replacing a contains property: the old node and its owned subtree add up', async () => {
    if (!fusekiAvailable) return;
    const OWN = 8; // extra own triples on the old owned node
    const CELLS = 5; // cell0 (owned directly) -next-> cell1 -> … cell4
    const triples = [
      `${iri('b1')} rdf:type ${iri('UBox')} .`,
      `${iri('b1')} ${iri('owns')} ${iri('cell0')} .`,
    ];
    for (let i = 0; i < OWN; i++) triples.push(`${iri('cell0')} ${iri('tag')} "t${i}" .`);
    for (let i = 0; i < CELLS; i++) {
      triples.push(`${iri(`cell${i}`)} rdf:type ${iri('UCell')} .`);
      if (i + 1 < CELLS) triples.push(`${iri(`cell${i}`)} ${iri('next')} ${iri(`cell${i + 1}`)} .`);
    }
    await insert(triples);

    const sparql = updateToSparql(
      lower(UpdateBuilder.from(UBox).for(`${U}b1`).set({owns: {id: `${U}newcell`}})) as IRUpdateMutation,
    );
    // the old value (1) + cell0's own triples (type, next, OWN tags) + the cells below
    // it (types and next edges) as reached by the cascade.
    const additive = 1 + (OWN + 2) + (CELLS - 1) + (CELLS - 2);
    expect(await countSolutions(sparql)).toBe(additive);

    await executeSparqlUpdate(sparql);
    expect(await allTriples()).toEqual(
      [`${U}b1 ${T} ${U}UBox`, `${U}b1 ${U}owns ${U}newcell`].sort(),
    );
  });

  test('replacing a contains property that has no old value leaves other owners\' subtrees alone', async () => {
    if (!fusekiAvailable) return;
    const other = [
      `${iri('b2')} rdf:type ${iri('UBox')} .`,
      `${iri('b2')} ${iri('owns')} ${iri('x0')} .`,
      `${iri('x0')} rdf:type ${iri('UCell')} .`,
      `${iri('x0')} ${iri('next')} ${iri('x1')} .`,
      `${iri('x1')} rdf:type ${iri('UCell')} .`,
    ];
    await insert([`${iri('b1')} rdf:type ${iri('UBox')} .`, ...other]);

    const sparql = updateToSparql(
      lower(UpdateBuilder.from(UBox).for(`${U}b1`).set({owns: {id: `${U}newcell`}})) as IRUpdateMutation,
    );
    await executeSparqlUpdate(sparql);
    expect(await allTriples()).toEqual(
      [
        `${U}b1 ${T} ${U}UBox`,
        `${U}b1 ${U}owns ${U}newcell`,
        `${U}b2 ${T} ${U}UBox`,
        `${U}b2 ${U}owns ${U}x0`,
        `${U}x0 ${T} ${U}UCell`,
        `${U}x0 ${U}next ${U}x1`,
        `${U}x1 ${T} ${U}UCell`,
      ].sort(),
    );
  });

  test('update-where over several nodes adds up per node', async () => {
    if (!fusekiAvailable) return;
    const TAGS = 4;
    const REFS = 3;
    const triples: string[] = [];
    for (const b of ['b1', 'b2']) {
      triples.push(`${iri(b)} rdf:type ${iri('UBox')} .`);
      for (let i = 0; i < TAGS; i++) triples.push(`${iri(b)} ${iri('tags')} "t${i}" .`);
      for (let i = 0; i < REFS; i++) triples.push(`${iri(b)} ${iri('refs')} ${iri(`r${i}`)} .`);
    }
    await insert(triples);

    const sparql = updateWhereToSparql(
      lower(
        UpdateBuilder.from(UBox).forAll().set({tags: ['new'], refs: [{id: `${U}rnew`}]} as any),
      ) as IRUpdateWhereMutation,
    );
    expect(await countSolutions(sparql)).toBe(2 * (TAGS + REFS));

    await executeSparqlUpdate(sparql);
    expect(await allTriples()).toEqual(
      ['b1', 'b2']
        .flatMap((b) => [`${U}${b} ${T} ${U}UBox`, `${U}${b} ${U}tags new`, `${U}${b} ${U}refs ${U}rnew`])
        .sort(),
    );
  });

  const holderTriples = (h: string, NAMES: number, LINES: number): string[] => {
    const t = [`${iri(h)} rdf:type ${iri('UHolder')} .`];
    for (let i = 0; i < NAMES; i++) t.push(`${iri(h)} ${iri('name')} "n${i}" .`);
    for (const prop of ['addr', 'alt']) {
      const lines = Array.from({length: LINES}, (_, i) => `${iri('line')} "${prop}${i}"`).join(' ; ');
      t.push(
        `${iri(h)} ${iri(prop)} [ rdf:type ${iri('UAddr')} ; ${lines} ; ${iri('geo')} [ ${iri('lat')} "1" ; ${iri('lat')} "2" ] ] .`,
      );
    }
    return t;
  };

  test('deleteAll: the root and each blank-node subtree add up', async () => {
    if (!fusekiAvailable) return;
    const NAMES = 5;
    const LINES = 4;
    await insert([...holderTriples('h1', NAMES, LINES), `${iri('keep')} ${iri('name')} "k" .`]);

    const sparql = deleteAllToSparql(lower(DeleteBuilder.from(UHolder).all()) as IRDeleteAllMutation);
    // root: type + names + addr + alt; each address: type + lines + geo; each geo: 2 lats
    const additive = 1 + NAMES + 2 + 2 * (1 + LINES + 1) + 2 * 2;
    expect(await countSolutions(sparql)).toBe(additive);

    await executeSparqlUpdate(sparql);
    expect(await allTriples()).toEqual([`${U}keep ${U}name k`]);
  });

  test('deleteWhere: the root and each blank-node subtree add up, only for matches', async () => {
    if (!fusekiAvailable) return;
    const NAMES = 5;
    const LINES = 4;
    await insert([...holderTriples('h1', NAMES, LINES), ...holderTriples('h2', NAMES, LINES)]);
    await insert([`${iri('h1')} ${iri('name')} "target" .`]);

    const sparql = deleteWhereToSparql(
      lower(DeleteBuilder.from(UHolder).where((h: any) => h.name.equals('target'))) as IRDeleteWhereMutation,
    );
    const additive = 1 + (NAMES + 1) + 2 + 2 * (1 + LINES + 1) + 2 * 2;
    expect(await countSolutions(sparql)).toBe(additive);

    const before = (await allTriples()).filter((t) => !t.startsWith(`${U}h1 `));
    await executeSparqlUpdate(sparql);
    const after = await allTriples();
    // every h1 triple and every blank node it owned is gone; h2 is untouched
    expect(after.some((t) => t.startsWith(`${U}h1 `))).toBe(false);
    expect(after).toHaveLength(before.length - (2 * (1 + LINES + 1) + 2 * 2));
  });
});
