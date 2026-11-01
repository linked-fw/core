/**
 * Sorting never drops an instance, and an instance without a value for a sort key sorts after
 * every instance with one, ascending and descending, for direct and nested paths alike. Paged
 * and unpaged selects, `.one()` and grouped selects follow the same rule.
 *
 * Also here: a where-aggregate next to multi-valued rows filters per subject without paging,
 * and a multi-valued field of a nested entity keeps all its values.
 */
import {graphs} from '../ontologies/graphs.js';
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {Expr} from '../expressions/Expr';
import {NodeShape} from '../shapes/SHACL';
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
const node = (
  id: string,
  o: {person?: boolean; name: string; hobby?: string; best?: string; friends?: string[]; nicks?: string[]},
) =>
  [
    ...(o.person ? [`<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`] : []),
    `<${ENT}${id}> <${PROP}name> "${o.name}" .`,
    ...(o.hobby ? [`<${ENT}${id}> <${PROP}hobby> "${o.hobby}" .`] : []),
    ...(o.best ? [`<${ENT}${id}> <${PROP}bestFriend> <${ENT}${o.best}> .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
    ...(o.nicks ?? []).map((n) => `<${ENT}${id}> <${PROP}nickName> "${n}" .`),
  ].join('\n');

// Persons: Anna (best friend Bob, hobby Chess, friends Carl and Dirk), Carl (best friend Ada,
// hobby Archery, friend Anna, nick names K, L), Dirk (nick names X, Y; nothing else). Bob (nick names C, D, E) and Ada are not persons.
const DATA = [
  node('anna', {person: true, name: 'Anna', hobby: 'Chess', best: 'bob', friends: ['carl', 'dirk'], nicks: ['N']}),
  node('carl', {person: true, name: 'Carl', hobby: 'Archery', best: 'ada', friends: ['anna'], nicks: ['K', 'L']}),
  node('dirk', {person: true, name: 'Dirk', nicks: ['X', 'Y']}),
  node('bob', {name: 'Bob', nicks: ['C', 'D', 'E']}),
  node('ada', {name: 'Ada'}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
};
const ids = (rows: unknown) => (rows as ResultRow[]).map((r) => String(r.id).replace(ENT, ''));

const byBestFriend = (direction: 'ASC' | 'DESC') =>
  Person.select((p) => [p.name, p.bestFriend.name]).orderBy((p) => p.bestFriend.name, direction);

describe('sorting keeps instances (lowering)', () => {
  test('a nested sort path is OPTIONAL', () => {
    const sparql = sparqlOf(Person.select((p) => p.name).orderBy((p) => p.bestFriend.name));
    expect(sparql).toMatch(/OPTIONAL \{\s*\?a0 <[^>]*bestFriend> \?a1 \./);
  });

  test('each sort key is preceded by a bound-first key, in both directions', () => {
    expect(sparqlOf(Person.select((p) => p.name).orderBy((p) => p.hobby))).toMatch(
      /ORDER BY DESC\(BOUND\(\?a0_hobby\)\) ASC\(\?a0_hobby\)$/,
    );
    expect(sparqlOf(byBestFriend('DESC'))).toMatch(/ORDER BY DESC\(BOUND\(\?a1_name\)\) DESC\(\?a1_name\)$/);
  });

  test('the subject itself needs no bound-first key', () => {
    expect(sparqlOf(Person.select((p) => p.name).orderBy((p) => p))).toMatch(/ORDER BY ASC\(\?a0\)$/);
  });

  test('a page sorts by bound-first, then MIN/MAX, then the subject', () => {
    const sparql = sparqlOf(
      Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p.bestFriend.name, 'DESC').limit(2),
    );
    expect(sparql).toMatch(
      /\(MAX\(\?a1_name\) AS \?page_order_0\)[\s\S]*ORDER BY DESC\(BOUND\(\?page_order_0\)\) DESC\(\?page_order_0\) ASC\(\?a0\) LIMIT 2/,
    );
  });

  test('a grouped select sorts an aggregate field through its alias', () => {
    const sparql = sparqlOf(
      Person.select((p) => ({name: p.name, last: p.bestFriend.name.max()})).groupBy('name').orderBy('last'),
    );
    expect(sparql).toMatch(/\(MAX\(\?a1_name\) AS \?(\w+)\)[\s\S]*ORDER BY DESC\(BOUND\(\?\1\)\) ASC\(MAX\(\?a1_name\)\)$/);
  });

  test('an unpaged where-aggregate with multi-valued rows is applied by a sub-SELECT of subjects', () => {
    const sparql = sparqlOf(
      Person.select((p) => [p.name, p.friends.name]).where((p) => p.friends.size().equals(2)),
    );
    expect(sparql).toMatch(/\{\s*SELECT \?a0 WHERE[\s\S]*GROUP BY \?a0 HAVING\(/);
    expect(sparql).not.toContain('LIMIT');
    // The outer query neither groups nor repeats the HAVING.
    expect(sparql.slice(sparql.lastIndexOf('}'))).not.toMatch(/GROUP BY|HAVING/);
  });
});

describe('sorting keeps instances (lowering, continued)', () => {
  test('a nested select\'s orderBy binds its key OPTIONAL in the window, bound first', () => {
    const sparql = sparqlOf(
      Person.select((p: any) => p.friends.select((f: any) => f.name).orderBy('hobby', 'DESC').limit(2)).for({
        id: `${ENT}anna`,
      }),
    );
    expect(sparql).toMatch(/OPTIONAL \{\s*\?a1 <[^>]*hobby> \?a1_hobby \.\s*\}[\s\S]*ORDER BY DESC\(BOUND\(\?a1_hobby\)\) DESC\(\?a1_hobby\) LIMIT 2/);
  });

  test('a projected aggregate with a sort path: the sub-SELECT of subjects carries the key', () => {
    const sparql = sparqlOf(
      Person.select((p) => ({name: p.name, n: p.friends.size()})).orderBy((p) => p.bestFriend.name),
    );
    expect(sparql).toMatch(/SELECT \?a0 \(MIN\(\?a1_name\) AS \?page_order_0\)/);
    expect(sparql).toMatch(/GROUP BY [^\n]*\?page_order_0/);
  });
});

describe('a nested entity keeps every value of a multi-valued field (mapping)', () => {
  test('bestFriend.nickNames maps to all values', () => {
    const ir = irOf(Person.select((p) => p.bestFriend.nickNames));
    const sparql = selectToSparql(ir);
    const v = (name: string) => sparql.match(new RegExp(`\\?(a1_${name}\\w*)`))![1];
    const uri = (id: string) => ({type: 'uri', value: `${ENT}${id}`});
    const lit = (value: string) => ({type: 'literal', value});
    const bindings = ['C', 'D', 'E'].map((n) => ({a0: uri('anna'), a1: uri('bob'), [v('nickName')]: lit(n)}));
    const rows = mapSparqlSelectResult({head: {vars: []}, results: {bindings}} as never, ir) as ResultRow[];
    expect(rows).toEqual([{id: `${ENT}anna`, bestFriend: {id: `${ENT}bob`, nickNames: ['C', 'D', 'E']}}]);
  });
});

describe('the shape metamodel reads single-valued fields as one value (mapping)', () => {
  test('a property shape\'s sh:path under NodeShape.properties is one node, not a list', () => {
    const ir = irOf((NodeShape as any).select((ns: any) => [ns.properties.select((ps: any) => [ps.path, ps.name])]).from(graphs.default));
    const sparql = selectToSparql(ir);
    const pathVar = sparql.match(/\?(a1_path\w*)/)![1];
    const nameVar = sparql.match(/\?(a1_name\w*)/)![1];
    const uri = (value: string) => ({type: 'uri', value});
    const bindings = [{a0: uri('urn:s'), a1: uri('urn:s/p'), [pathVar]: uri('urn:x:p'), [nameVar]: {type: 'literal', value: 'p'}}];
    const rows = mapSparqlSelectResult({head: {vars: []}, results: {bindings}} as never, ir) as ResultRow[];
    expect(rows[0].properties).toEqual([{id: 'urn:s/p', path: {id: 'urn:x:p'}, name: 'p'}]);
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

describeFuseki('sorting keeps instances, missing values last', () => {
  test('nested path: ASC Carl, Anna, Dirk; DESC Anna, Carl, Dirk', async () => {
    expect(ids(await run(byBestFriend('ASC')))).toEqual(['carl', 'anna', 'dirk']);
    expect(ids(await run(byBestFriend('DESC')))).toEqual(['anna', 'carl', 'dirk']);
  });

  test('nested path not projected: the instance without it is still returned, last', async () => {
    const q = (d: 'ASC' | 'DESC') => Person.select((p) => p.name).orderBy((p) => p.bestFriend.name, d);
    expect(ids(await run(q('ASC')))).toEqual(['carl', 'anna', 'dirk']);
    expect(ids(await run(q('DESC')))).toEqual(['anna', 'carl', 'dirk']);
  });

  test('direct path: missing last ascending too', async () => {
    const q = (d: 'ASC' | 'DESC') => Person.select((p) => p.name).orderBy((p) => p.hobby, d);
    expect(ids(await run(q('ASC')))).toEqual(['carl', 'anna', 'dirk']);
    expect(ids(await run(q('DESC')))).toEqual(['anna', 'carl', 'dirk']);
  });

  test('nested multi-valued path: MIN ascending, MAX descending, missing last', async () => {
    // Friends' names: Anna → Carl, Dirk; Carl → Anna; Dirk → none.
    const q = (d: 'ASC' | 'DESC') => Person.select((p) => p.name).orderBy((p) => p.friends.name, d);
    expect(ids(await run(q('ASC')))).toEqual(['carl', 'anna', 'dirk']);
    expect(ids(await run(q('DESC')))).toEqual(['anna', 'carl', 'dirk']);
  });

  test('paged: the same order, page by page', async () => {
    const q = (d: 'ASC' | 'DESC', offset: number) =>
      Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p.bestFriend.name, d).limit(2).offset(offset);
    expect([...ids(await run(q('ASC', 0))), ...ids(await run(q('ASC', 2)))]).toEqual(['carl', 'anna', 'dirk']);
    expect([...ids(await run(q('DESC', 0))), ...ids(await run(q('DESC', 2)))]).toEqual(['anna', 'carl', 'dirk']);
    const direct = Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p.hobby).limit(3);
    expect(ids(await run(direct))).toEqual(['carl', 'anna', 'dirk']);
  });

  test('.one(): the first instance with a value', async () => {
    const first = (await run(Person.select((p) => p.name).orderBy((p) => p.hobby).one())) as ResultRow;
    expect(first.id).toBe(`${ENT}carl`);
    const last = (await run(Person.select((p) => [p.name, p.nickNames]).orderBy((p) => p.bestFriend.name, 'DESC').one())) as ResultRow;
    expect(last.id).toBe(`${ENT}anna`);
  });

  test('grouped: the group without the key value sorts last, both directions', async () => {
    const q = (d: 'ASC' | 'DESC') =>
      Person.select((p) => ({hobby: p.hobby, n: Expr.count()})).groupBy('hobby').orderBy('hobby', d);
    expect(((await run(q('ASC'))) as ResultRow[]).map((r) => r.hobby)).toEqual(['Archery', 'Chess', null]);
    expect(((await run(q('DESC'))) as ResultRow[]).map((r) => r.hobby)).toEqual(['Chess', 'Archery', null]);
  });

  test('grouped: an aggregate field without a value sorts last', async () => {
    const q = (d: 'ASC' | 'DESC') =>
      Person.select((p) => ({name: p.name, last: p.bestFriend.name.max()})).groupBy('name').orderBy('last', d);
    expect(((await run(q('ASC'))) as ResultRow[]).map((r) => r.name)).toEqual(['Carl', 'Anna', 'Dirk']);
    expect(((await run(q('DESC'))) as ResultRow[]).map((r) => r.name)).toEqual(['Anna', 'Carl', 'Dirk']);
  });

  test('unpaged where-aggregate with a multi-valued projection filters per subject', async () => {
    const rows = (await run(
      Person.select((p) => [p.name, p.friends.name]).where((p) => p.friends.size().equals(2)),
    )) as ResultRow[];
    expect(ids(rows)).toEqual(['anna']);
    expect(((rows[0].friends as ResultRow[]).map((f) => f.name) as string[]).sort()).toEqual(['Carl', 'Dirk']);
    const one = (await run(
      Person.select((p) => [p.name, p.friends.name]).where((p) => p.friends.size().equals(2)).for({id: `${ENT}anna`}),
    )) as ResultRow;
    expect(one.id).toBe(`${ENT}anna`);
  });

  test('a nested select\'s own orderBy keeps every child, missing values last', async () => {
    const friends = async (d: 'ASC' | 'DESC', limit?: number) => {
      let inner = (p: any) => {
        const q = p.friends.select((f: any) => f.name).orderBy('hobby', d);
        return limit === undefined ? q : q.limit(limit);
      };
      const row = (await run(Person.select(inner as never).for({id: `${ENT}anna`}))) as ResultRow;
      return ids(row.friends);
    };
    expect(await friends('ASC')).toEqual(['carl', 'dirk']);
    expect(await friends('DESC')).toEqual(['carl', 'dirk']);
    expect(await friends('DESC', 2)).toEqual(['carl', 'dirk']);
  });

  test('a select with a projected aggregate sorts by a path it does not group by', async () => {
    const q = (d: 'ASC' | 'DESC') =>
      Person.select((p) => ({name: p.name, n: p.friends.size()})).orderBy((p) => p.bestFriend.name, d);
    expect(ids(await run(q('ASC')))).toEqual(['carl', 'anna', 'dirk']);
    expect(ids(await run(q('DESC')))).toEqual(['anna', 'carl', 'dirk']);
  });

  test('a multi-valued leaf under a single-valued traversal keeps all values', async () => {
    const row = (await run(Person.select((p) => p.bestFriend.nickNames).for({id: `${ENT}anna`}))) as ResultRow;
    const best = row.bestFriend as ResultRow;
    expect(best.id).toBe(`${ENT}bob`);
    expect([...(best.nickNames as string[])].sort()).toEqual(['C', 'D', 'E']);
  });

  test('a multi-valued leaf in a nested select under a multi-valued traversal keeps all values', async () => {
    // The shape of `Import.select(i => [i.created.select(c => [c.shape, c.instances])])`.
    const row = (await run(
      Person.select((p) => [p.friends.select((f) => [f.name, f.nickNames])]).for({id: `${ENT}anna`}),
    )) as ResultRow;
    const friends = (row.friends as ResultRow[]).map((f) => [f.name, [...(f.nickNames as string[])].sort()]);
    expect(friends.sort()).toEqual([['Carl', ['K', 'L']], ['Dirk', ['X', 'Y']]]);
  });

  test('a multi-valued leaf under a multi-valued traversal keeps all values', async () => {
    const row = (await run(Person.select((p) => p.friends.select((f) => f.nickNames)).for({id: `${ENT}carl`}))) as ResultRow;
    expect(row.friends).toEqual([{id: `${ENT}anna`, nickNames: ['N']}]);
  });
});
