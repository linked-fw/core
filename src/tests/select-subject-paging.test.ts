/**
 * `limit`/`offset` on a select page over the root subjects, not over SPARQL solution rows. A
 * subject with a multi-valued property (or reached values through a traversal) spans one row
 * per value; the page still holds `limit` subjects, each with all its values, and no subject is
 * split across two pages.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {Expr} from '../expressions/Expr';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {createTestDataset, loadTestData, executeSparqlQuery, clearAllData} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';
import '../ontologies/xsd';

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const person = (id: string, name: string, nicks: string[], friends: string[] = []) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`,
    `<${ENT}${id}> <${PROP}name> "${name}" .`,
    ...nicks.map((n) => `<${ENT}${id}> <${PROP}nickName> "${n}" .`),
    ...friends.map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
  ].join('\n');

// p1: nick names A, B; p2: C, D, E; p3: F; p4: none. Friends: p1 → p2, p3; p2 → p3.
const DATA = [
  person('p1', 'Ann', ['A', 'B'], ['p2', 'p3']),
  person('p2', 'Bob', ['C', 'D', 'E'], ['p3']),
  person('p3', 'Cyd', ['F']),
  person('p4', 'Dee', []),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
};
const ids = (rows: unknown) => (rows as ResultRow[]).map((r) => String(r.id).replace(ENT, ''));

const nicksBySubject = (limit: number, offset?: number) => {
  let q = Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p).limit(limit);
  if (offset !== undefined) q = q.offset(offset);
  return q;
};

describe('subject paging (lowering)', () => {
  test('a select of subjects only keeps its plain LIMIT', () => {
    const sparql = sparqlOf(Person.select().where((p) => p.name.equals('Ann')).limit(2).offset(1));
    expect(sparql).not.toMatch(/\{\s*SELECT/);
    expect(sparql).toMatch(/ORDER BY ASC\(\?a0\)\s+LIMIT 2\s+OFFSET 1\s*$/);
  });

  test('a single-valued select pages by subject: data can hold more values than declared', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).orderBy((p) => p.name).limit(2).offset(1));
    expect(sparql).toMatch(/SELECT \?a0[\s\S]*ASC\(\?a0\) LIMIT 2 OFFSET 1\s*\}/);
  });

  test('a multi-valued projection pages a sub-SELECT of subjects', () => {
    const sparql = sparqlOf(nicksBySubject(2, 2));
    // The page: distinct subjects, ordered, limited.
    expect(sparql).toMatch(/\{\s*SELECT DISTINCT \?a0 WHERE \{[\s\S]*\} ORDER BY ASC\(\?a0\) LIMIT 2 OFFSET 2\s*\}/);
    // The outer query reads every value of those subjects: no LIMIT of its own.
    expect(sparql.trim()).toMatch(/ORDER BY ASC\(\?a0\)$/);
    // The page does not read the projected nick names.
    const page = sparql.slice(sparql.indexOf('{', sparql.indexOf('WHERE')) + 1);
    const inner = page.slice(page.indexOf('SELECT'), page.indexOf('ORDER BY'));
    expect(inner).not.toContain('nickName');
  });

  test('a single-valued traversal pages by subject', () => {
    const sparql = sparqlOf(Person.select((p) => p.bestFriend.name).limit(2));
    expect(sparql).toMatch(/SELECT DISTINCT \?a0 WHERE[\s\S]*LIMIT 2\s*\}/);
  });

  test('a traversal pages by subject', () => {
    const sparql = sparqlOf(Person.select((p) => p.friends.name).limit(1));
    expect(sparql).toMatch(/SELECT DISTINCT \?a0 WHERE[\s\S]*LIMIT 1\s*\}/);
  });

  test('an order on a multi-valued path sorts each subject by MIN ascending and MAX descending', () => {
    const asc = sparqlOf(Person.select((p) => p.name).orderBy((p) => p.nickNames).limit(2));
    expect(asc).toMatch(/\(MIN\(\?a0_nickNames\) AS \?(\w+)\)[\s\S]*ORDER BY DESC\(BOUND\(\?\1\)\) ASC\(\?\1\) ASC\(\?a0\) LIMIT 2/);
    const desc = sparqlOf(Person.select((p) => p.name).orderBy((p) => p.nickNames, 'DESC').limit(2));
    expect(desc).toMatch(/\(MAX\(\?a0_nickNames\) AS \?(\w+)\)[\s\S]*ORDER BY DESC\(BOUND\(\?\1\)\) DESC\(\?\1\) ASC\(\?a0\) LIMIT 2/);
  });

  test('.one() limits subjects, not rows', () => {
    const sparql = sparqlOf(Person.select((p) => p.nickNames).one());
    expect(sparql).toMatch(/SELECT DISTINCT \?a0 WHERE[\s\S]*LIMIT 1\s*\}/);
  });

  test('.for(id) reads one subject without a LIMIT', () => {
    const sparql = sparqlOf(Person.select((p) => p.nickNames).for({id: `${ENT}p1`}));
    expect(sparql).not.toContain('LIMIT');
  });

  test('a grouped select keeps its LIMIT on groups', () => {
    const sparql = sparqlOf(
      Person.select((p) => ({nick: p.nickNames, n: Expr.count()})).groupBy('nick').limit(2),
    );
    expect(sparql).not.toMatch(/\{\s*SELECT/);
    expect(sparql).toMatch(/LIMIT 2\s*$/);
  });
});

beforeAll(async () => {
  if (!fusekiLive) return;
  await createTestDataset();
  await clearAllData();
  await loadTestData(DATA);
}, 30000);

afterAll(async () => {
  if (fusekiLive) await clearAllData();
});

describeFuseki('subject paging', () => {
  test('limit counts subjects; each keeps every value', async () => {
    const rows = (await run(nicksBySubject(2))) as ResultRow[];
    expect(ids(rows)).toEqual(['p1', 'p2']);
    expect([...(rows[0].nickNames as string[])].sort()).toEqual(['A', 'B']);
    expect([...(rows[1].nickNames as string[])].sort()).toEqual(['C', 'D', 'E']);
  });

  test('offset skips subjects: pages do not split a subject', async () => {
    expect(ids(await run(nicksBySubject(2, 1)))).toEqual(['p2', 'p3']);
    expect(ids(await run(nicksBySubject(2, 2)))).toEqual(['p3', 'p4']);
    expect(ids(await run(nicksBySubject(2, 4)))).toEqual([]);
  });

  test('a traversal: limit counts subjects', async () => {
    const rows = (await run(Person.select((p) => p.friends.name).orderBy((p) => p.name).limit(2))) as ResultRow[];
    expect(ids(rows)).toEqual(['p1', 'p2']);
    expect((rows[0].friends as ResultRow[]).length).toBe(2);
  });

  test('order on a multi-valued path: lowest value ascending, highest descending', async () => {
    // Lowest nick names: p1 A, p2 C, p3 F, p4 none (a missing value sorts last).
    expect(ids(await run(Person.select((p) => p.nickNames).orderBy((p) => p.nickNames).limit(4)))).toEqual([
      'p1', 'p2', 'p3', 'p4',
    ]);
    // Highest: p3 F, p2 E, p1 B, p4 none.
    expect(
      ids(await run(Person.select((p) => p.nickNames).orderBy((p) => p.nickNames, 'DESC').limit(3))),
    ).toEqual(['p3', 'p2', 'p1']);
  });

  test('where and limit: the page is of the matching subjects', async () => {
    const q = Person.select((p) => p.nickNames)
      .where((p) => p.name.notEquals('Ann'))
      .orderBy((p) => p.name)
      .limit(2);
    const rows = (await run(q)) as ResultRow[];
    expect(ids(rows)).toEqual(['p2', 'p3']);
    expect((rows[0].nickNames as string[]).length).toBe(3);
  });

  test('where on a multi-valued path and limit', async () => {
    const q = Person.select((p) => p.nickNames)
      .where((p) => p.nickNames.equals('D').or(p.nickNames.equals('F')))
      .orderBy((p) => p.name)
      .limit(5);
    expect(ids(await run(q))).toEqual(['p2', 'p3']);
  });

  test('.one() returns one subject with all its values', async () => {
    const row = (await run(Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p.name, 'DESC').offset(2).one())) as ResultRow;
    expect(row.id).toBe(`${ENT}p2`);
    expect([...(row.nickNames as string[])].sort()).toEqual(['C', 'D', 'E']);
  });

  test('size() next to a page', async () => {
    const rows = (await run(
      Person.select((p) => ({name: p.name, n: p.nickNames.size()})).orderBy((p) => p.name).limit(2).offset(1),
    )) as ResultRow[];
    expect(rows.map((r) => [r.name, r.n])).toEqual([['Bob', 3], ['Cyd', 1]]);
  });

  test('a where aggregate with a multi-valued projection: the page applies it per subject', async () => {
    const q = Person.select((p) => [p.name, p.friends.name])
      .where((p) => p.friends.size().equals(2))
      .limit(5);
    expect(sparqlOf(q)).not.toMatch(/\}\s*GROUP BY[\s\S]*HAVING[\s\S]*\n\s*GROUP BY/);
    const rows = (await run(q)) as ResultRow[];
    expect(ids(rows)).toEqual(['p1']);
    expect((rows[0].friends as ResultRow[]).length).toBe(2);
  });

  test('ties are broken by the subject: pages neither repeat nor skip one', async () => {
    // No one has a hobby: every subject ties on the sort key.
    const tied = (offset: number) =>
      run(Person.select((p) => [p.nickNames, p.hobby]).orderBy((p) => p.hobby).limit(1).offset(offset));
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push(...ids(await tied(i)));
    expect(seen).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  test('the values of a subject keep the select order', async () => {
    const rows = (await run(Person.select((p) => p.nickNames).orderBy((p) => p.nickNames).offset(1).limit(1))) as ResultRow[];
    expect(rows[0].nickNames).toEqual(['C', 'D', 'E']);
  });

  test('a grouped select: limit counts groups', async () => {
    const rows = (await run(
      Person.select((p) => ({nick: p.nickNames, n: Expr.count()})).groupBy('nick').orderBy('nick').limit(2),
    )) as ResultRow[];
    // The group of persons without a nick name sorts last.
    expect(rows.map((r) => r.nick)).toEqual(['A', 'B']);
  });
});
