/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * The owned walk through recursion: a shape owning itself is a closure, every other cycle is
 * unrolled into typed hops (up to MAX_OWNED_RECURSION repeats), a sub-shape's edge is followed
 * only from its own class, a sub-shape sharing its parent's class is not followed, the walk
 * never deletes rdf:nil, and the branch counts of the real metamodel are pinned.
 */
import {describe, expect, jest, test, beforeAll, beforeEach} from '@jest/globals';
import {
  createTestDataset,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, NodeShape, objectProperty, PropertyShape} from '../shapes/SHACL';
import {List} from '../shapes/List';
import {PathNode} from '../shapes/PathNode';
import {PathList} from '../shapes/PathList';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {
  deleteToSparql,
  updateToSparql,
  MAX_OWNED_RECURSION,
  OWNED_BRANCH_WARNING,
} from '../sparql/irToAlgebra';
import type {IRDeleteMutation, IRUpdateMutation} from '../queries/IntermediateRepresentation';
import {lower} from '../queries/lower';

const PKG = 'owned-walk-recursion-test';
const {linkedShape} = linkedPackage(PKG);
const W = 'http://example.org/w#';
const ex = (n: string) => ({id: `${W}${n}`});
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

// H1: a cycle through two shapes; RA also holds a plain reference on the predicate RB owns.
@linkedShape
class RA extends Shape {
  static targetClass = ex('RA');
  @objectProperty({path: ex('toB'), shape: [PKG, 'RB'], maxCount: 1, contains: true})
  get toB(): unknown {
    return null;
  }
  @objectProperty({path: ex('toA'), shape: [PKG, 'RA'], maxCount: 1})
  get peer(): unknown {
    return null;
  }
}

@linkedShape
class RB extends Shape {
  static targetClass = ex('RB');
  @objectProperty({path: ex('toA'), shape: RA, maxCount: 1, contains: true})
  get toA(): RA {
    return null;
  }
}

// H2: a shape owning itself (replies), with a plain `fork` that only a sub-shape owns.
@linkedShape
class SC extends Shape {
  static targetClass = ex('SC');
  @objectProperty({path: ex('replies'), shape: SC, contains: true})
  get replies(): SC[] {
    return [];
  }
  @objectProperty({path: ex('fork'), shape: SC, maxCount: 1})
  get fork(): SC {
    return null;
  }
}

@linkedShape
class SCSub extends SC {
  static targetClass = ex('SCSub');
  @objectProperty({path: ex('fork'), shape: SC, maxCount: 1, contains: true})
  get fork(): SC {
    return null;
  }
}

// M3: a sub-shape that shares its parent's class cannot be told apart by rdf:type.
@linkedShape
class HPlain extends Shape {
  static targetClass = ex('HPlain');
  @literalProperty({path: ex('label'), maxCount: 1})
  get label(): string {
    return null;
  }
}

@linkedShape
class HB extends Shape {
  static targetClass = ex('HB');
}

@linkedShape
class HBSame extends HB {
  static targetClass = ex('HB');
  @objectProperty({path: ex('extra'), shape: HPlain, maxCount: 1, contains: true})
  get extra(): HPlain {
    return null;
  }
}

@linkedShape
class HO extends Shape {
  static targetClass = ex('HO');
  @objectProperty({path: ex('hb'), shape: HB, maxCount: 1, contains: true})
  get hb(): HB {
    return null;
  }
}

// rdf:nil: an owner of a list.
@linkedShape
class LHolder extends Shape {
  static targetClass = ex('LHolder');
  @objectProperty({path: ex('items'), shape: List, maxCount: 1, contains: true})
  get items(): List {
    return null;
  }
}

// Schema-like: a Thing owning its image, with sub-shapes (one adds ownership of its own).
@linkedShape
class XImage extends Shape {
  static targetClass = ex('ImageObject');
  @literalProperty({path: ex('contentUrl'), maxCount: 1})
  get contentUrl(): string {
    return null;
  }
}

@linkedShape
class XThing extends Shape {
  static targetClass = ex('Thing');
  @objectProperty({path: ex('image'), shape: XImage, maxCount: 1, contains: true})
  get image(): XImage {
    return null;
  }
}

@linkedShape
class XCreativeWork extends XThing {
  static targetClass = ex('CreativeWork');
}

@linkedShape
class XProject extends XCreativeWork {
  static targetClass = ex('Project');
  @objectProperty({path: ex('attachments'), shape: XImage, contains: true})
  get attachments(): XImage[] {
    return [];
  }
}

const deleteOf = (shape: any, id: string) =>
  deleteToSparql(lower(DeleteBuilder.from(shape, {id})) as unknown as IRDeleteMutation);
const branches = (sparql: string) => sparql.slice(sparql.indexOf('WHERE')).split(/\n\s*UNION\n/).length;

describe('owned walk: recursion', () => {
  test('a cycle through two shapes is unrolled into typed hops, never one closure', () => {
    const sparql = deleteOf(RA, `${W}a1`);
    expect(sparql).not.toMatch(/\(<http:\/\/example\.org\/w#to[AB]>\|/);
    expect(sparql).not.toMatch(/<http:\/\/example\.org\/w#to[AB]>[*+]/);
    // Each hop is typed with the declaring shape's class.
    expect(sparql).toMatch(/<http:\/\/example\.org\/w#a1> rdf:type <http:\/\/example\.org\/w#RA> \.\s*<http:\/\/example\.org\/w#a1> <http:\/\/example\.org\/w#toB> \?c_0_0 \./);
    expect(sparql).toMatch(/\?c_1_0 rdf:type <http:\/\/example\.org\/w#RB> \.\s*\?c_1_0 <http:\/\/example\.org\/w#toA> \?c_1_1 \./);
    // The plain `peer` on ex:toA is never followed from an RA node.
    expect(sparql).not.toMatch(new RegExp(`<${W}a1> <${W}toA>`));
  });

  test('the unrolled walk stops after MAX_OWNED_RECURSION repeated shapes', () => {
    // RA → RB (new) → RA, RB, RA, RB (repeats): 1 + MAX_OWNED_RECURSION hops, one branch each.
    expect(MAX_OWNED_RECURSION).toBe(4);
    const sparql = deleteOf(RA, `${W}a1`);
    const depth = Math.max(...[...sparql.matchAll(/\?c_\d+_(\d+) \?c_\d+_p/g)].map((m) => Number(m[1])));
    expect(depth + 1).toBe(1 + MAX_OWNED_RECURSION);
  });

  test('a self-owning shape is a closure; a sub-shape edge into it is a typed hop outside it', () => {
    const sparql = deleteOf(SC, `${W}c1`);
    expect(sparql).toContain(`<${W}c1> <${W}replies>+ ?c_r .`);
    expect(sparql).not.toMatch(/\|<http:\/\/example\.org\/w#fork>|<http:\/\/example\.org\/w#fork>\|/);
    expect(sparql).toMatch(/\?c_w rdf:type <http:\/\/example\.org\/w#SCSub> \.\s*\?c_w <http:\/\/example\.org\/w#fork> \?c_0_0e \.\s*\?c_0_0e <http:\/\/example\.org\/w#replies>\* \?c_0_0 \./);
  });

  test('a sub-shape sharing its parent\'s class is not followed, with one warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sparql = deleteOf(HO, `${W}o1`);
      expect(sparql).not.toContain(`<${W}extra>`);
      deleteOf(HO, `${W}o2`);
      deleteToSparql(lower(DeleteBuilder.from(HB, {id: `${W}hb1`})) as unknown as IRDeleteMutation);
      const mine = warn.mock.calls.filter((c) => String(c[0]).includes(HBSame.shape.id));
      expect(mine.length).toBeLessThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
    // Deleting through the sub-shape itself still owns `extra`.
    expect(deleteOf(HBSame, `${W}hb1`)).toContain(`<${W}hb1> <${W}extra> ?c_0_0 .`);
  });

  test('every deleted node is filtered against rdf:nil', () => {
    const sparql = deleteOf(LHolder, `${W}h1`);
    expect(sparql).toMatch(/\?c_0_0e rdf:rest\* \?c_0_0 \.\s*\?c_0_0 \?c_0_p \?c_0_o \.\s*FILTER\(!\(sameTerm\(\?c_0_0, rdf:nil\)\)\)/);
    const replace = updateToSparql(
      lower(UpdateBuilder.from(LHolder).for(`${W}h1`).set({items: {id: `${RDF}nil`}})) as unknown as IRUpdateMutation,
    );
    expect(replace).toContain('FILTER(!(sameTerm(?old_items, rdf:nil)))');
    expect(replace).toContain('FILTER(!(sameTerm(?uc0_r, rdf:nil)))');
  });
});

describe('owned walk: branch counts', () => {
  test('the metamodel and a schema-like fixture stay small', () => {
    const counts = Object.fromEntries(
      [
        ['NodeShape', NodeShape],
        ['PropertyShape', PropertyShape],
        ['List', List],
        ['PathNode', PathNode],
        ['PathList', PathList],
        ['RA', RA],
        ['SC', SC],
        ['XThing', XThing],
        ['XProject', XProject],
      ].map(([name, shape]) => [name, branches(deleteOf(shape, `${W}x`))]),
    );
    expect(counts).toEqual(BRANCHES);
  });

  test('a wide owned DAG warns once above OWNED_BRANCH_WARNING branches', () => {
    // Four layers of three shapes, each owning the three of the next, under one root:
    // 3 + 9 + 27 + 81 = 120 paths > 64.
    const layers: Array<Array<typeof Shape>> = [];
    for (let l = 4; l >= 0; l--) {
      const next = layers[0] ?? [];
      const layer: Array<typeof Shape> = [];
      for (let i = 0; i < (l === 0 ? 1 : 3); i++) {
        class Wide extends Shape {
          static targetClass = ex(`Wide${l}_${i}`);
        }
        Object.defineProperty(Wide, 'name', {value: `Wide${l}_${i}`});
        next.forEach((target, n) => {
          objectProperty({path: ex(`own${l}_${n}`), shape: target, maxCount: 1, contains: true})(
            Wide.prototype,
            `own${n}`,
            {get: () => null, configurable: true},
          );
        });
        linkedShape(Wide);
        layer.push(Wide);
      }
      layers.unshift(layer);
    }
    const root = layers[0][0];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const count = branches(deleteOf(root, `${W}wide`));
      deleteOf(root, `${W}wide2`);
      expect(count).toBeGreaterThan(OWNED_BRANCH_WARNING);
      const mine = warn.mock.calls.filter((c) => String(c[0]).includes('owned paths'));
      expect(mine).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// Pinned UNION branch counts of a delete by id: the subject's own triples, incoming references,
// blank values and one branch per owned path (plus a blank branch per owned node with blank values).
// RA: 2 + 1 + MAX_OWNED_RECURSION unrolled hops; SC: the replies closure and the unrolled fork hops.
const BRANCHES: Record<string, number> = {
  NodeShape: 8,
  PropertyShape: 4,
  List: 3,
  PathNode: 5,
  PathList: 5,
  RA: 7,
  SC: 7,
  XThing: 4,
  XProject: 4,
};

describeFuseki('owned walk: recursion — live Fuseki', () => {
  const iri = (n: string) => (n.startsWith('rdf:') ? `<${RDF}${n.slice(4)}>` : `<${W}${n}>`);
  const count = async (n: string) =>
    Number(
      (await executeSparqlQuery(`SELECT (COUNT(*) AS ?c) WHERE { ${iri(n)} ?p ?o }`)).results.bindings[0].c.value,
    );
  const insert = (triples: string) => executeSparqlUpdate(`INSERT DATA { ${triples} }`);
  const T = `<${RDF}type>`;
  const run = (sparql: string) => executeSparqlUpdate(sparql);

  beforeAll(async () => {
    await createTestDataset();
  });
  beforeEach(async () => {
    await clearAllData();
  });

  test('a two-shape cycle keeps a node held through a plain property on an owned predicate', async () => {
    await insert(`
      ${iri('a1')} ${T} ${iri('RA')} ; ${iri('toB')} ${iri('b1')} ; ${iri('toA')} ${iri('a2')} .
      ${iri('a2')} ${T} ${iri('RA')} ; ${iri('label')} "plain" .
      ${iri('b1')} ${T} ${iri('RB')} ; ${iri('toA')} ${iri('a3')} .
      ${iri('a3')} ${T} ${iri('RA')} ; ${iri('label')} "owned" .`);
    await run(deleteOf(RA, `${W}a1`));
    expect(await count('b1')).toBe(0);
    expect(await count('a3')).toBe(0);
    expect(await count('a2')).toBe(2);
  });

  test('a two-shape cycle is deleted down to the unroll depth, and terminates', async () => {
    // a1 → b1 → a2 → b2 → a3 → b3 → a4: five hops are walked, the sixth node is left.
    const chain = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4'];
    await insert(
      chain
        .map((n, i) => {
          const cls = n.startsWith('a') ? 'RA' : 'RB';
          const next = chain[i + 1];
          const edge = next ? ` ; ${iri(next.startsWith('a') ? 'toA' : 'toB')} ${iri(next)}` : '';
          return `${iri(n)} ${T} ${iri(cls)}${edge} .`;
        })
        .join('\n'),
    );
    await run(deleteOf(RA, `${W}a1`));
    for (const n of chain.slice(0, 6)) expect(await count(n)).toBe(0);
    expect(await count('a4')).toBe(1);
  });

  test('a sub-shape\'s edge inside a recursion is followed only from nodes of its class', async () => {
    await insert(`
      ${iri('c1')} ${T} ${iri('SC')} ; ${iri('replies')} ${iri('c2')} , ${iri('c3')} .
      ${iri('c2')} ${T} ${iri('SC')} ; ${iri('fork')} ${iri('c5')} .
      ${iri('c5')} ${T} ${iri('SC')} ; ${iri('label')} "referenced" .
      ${iri('c3')} ${T} ${iri('SCSub')} ; ${iri('fork')} ${iri('c6')} .
      ${iri('c6')} ${T} ${iri('SC')} ; ${iri('label')} "owned" .`);
    await run(deleteOf(SC, `${W}c1`));
    expect(await count('c2')).toBe(0);
    expect(await count('c3')).toBe(0);
    expect(await count('c5')).toBe(2);
    expect(await count('c6')).toBe(0);
  });

  test('a sub-shape sharing its parent\'s class does not own through the parent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await insert(`
        ${iri('o1')} ${T} ${iri('HO')} ; ${iri('hb')} ${iri('hb1')} .
        ${iri('hb1')} ${T} ${iri('HB')} ; ${iri('extra')} ${iri('x1')} .
        ${iri('x1')} ${T} ${iri('HPlain')} ; ${iri('label')} "x" .`);
      await run(deleteOf(HO, `${W}o1`));
      expect(await count('hb1')).toBe(0);
      expect(await count('x1')).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('rdf:nil keeps its triples when a list is deleted or replaced', async () => {
    const nil = `${iri('rdf:nil')} ${T} <${RDF}List> ; <http://www.w3.org/2000/01/rdf-schema#label> "nil" .`;
    await insert(`
      ${nil}
      ${iri('h1')} ${T} ${iri('LHolder')} ; ${iri('items')} ${iri('l1')} .
      ${iri('l1')} ${T} <${RDF}List> ; <${RDF}first> "x" ; <${RDF}rest> <${RDF}nil> .
      ${iri('h2')} ${T} ${iri('LHolder')} ; ${iri('items')} <${RDF}nil> .`);
    await run(deleteOf(LHolder, `${W}h1`));
    expect(await count('l1')).toBe(0);
    expect(await count('rdf:nil')).toBe(2);
    await run(
      updateToSparql(
        lower(UpdateBuilder.from(LHolder).for(`${W}h2`).set({items: {id: `${W}l2`}})) as unknown as IRUpdateMutation,
      ),
    );
    expect(await count('rdf:nil')).toBe(2);
  });
});
