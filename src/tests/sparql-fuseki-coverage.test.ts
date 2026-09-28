/**
 * Fuseki E2E coverage tests — exercises features supported by core but not
 * covered by sparql-fuseki.test.ts. Result assertions go through the live-query
 * store contract (FusekiStore.selectQuery/createQuery/updateQuery/deleteQuery),
 * which lowers internally — IR stays an internal detail.
 *
 * Skipped gracefully if Fuseki is not available.
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {
  queryFactories,
  Person,
  Employee,
  Dog,
  Metric,
  PathNode,
  tmpEntityBase,
  personClass,
  dogClass,
  petClass,
  employeeClass,
  metricClass,
  propBase,
} from '../test-helpers/query-fixtures';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {
  ensureFuseki,
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
  DATASET_NAME,
} from '../test-helpers/fuseki-test-store';
import {setQueryContext, getQueryContext} from '../queries/QueryContext';
import {Shape} from '../shapes/Shape';
import {Expr} from '../expressions/Expr';
import {fromJSON} from '../queries/fromJSON';
import {WIRE_VERSION} from '../queries/wireVersion';
import {createHash} from 'node:crypto';

import '../ontologies/rdf';
import '../ontologies/xsd';

setQueryContext('user', {id: `${tmpEntityBase}p3`}, Person);

// Shape URIs (SHACL-generated)
const P = 'https://linked.cm/shape/core/Person';
// Property predicates are the declared `sh:path`, not derived from the shape IRI.
const PROP = propBase;
const D = 'https://linked.cm/shape/core/Dog';
const PET = 'https://linked.cm/shape/core/Pet';
const E = 'https://linked.cm/shape/core/Employee';
const M = 'https://linked.cm/shape/core/Metric';
const PP = 'linked://pp/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
// Class IRIs — the separate node each shape declares as its `targetClass`.
// Only these appear as an rdf:type; the shape IRIs above identify the
// SHACL descriptions and are what property predicates derive from.
const PT = personClass.id;
const DT = dogClass.id;
const PETT = petClass.id;
const ET = employeeClass.id;
const MT = metricClass.id;

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ENT = tmpEntityBase;

// Base graph: identical to sparql-fuseki.test.ts so expectations are well
// understood, plus a Dog `d1` (guardDogLevel) for updateExprCallback.
const BASE_DATA = `
<${ENT}p1> <${RDF_TYPE}> <${PT}> .
<${ENT}p1> <${PROP}name> "Semmy" .
<${ENT}p1> <${PROP}hobby> "Reading" .
<${ENT}p1> <${PROP}birthDate> "1990-01-01T13:45:30.000Z"^^<${XSD}dateTime> .
<${ENT}p1> <${PROP}isRealPerson> "true"^^<${XSD}boolean> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p2> .
<${ENT}p1> <${PROP}hasFriend> <${ENT}p3> .
<${ENT}p1> <${PROP}hasPet> <${ENT}dog1> .
<${ENT}p1> <${PROP}hasPet> <${ENT}dog1> .
<${ENT}p1> <${PROP}nickName> "Sem1" .
<${ENT}p1> <${PROP}nickName> "Sem" .
<${ENT}p1> <${PROP}pluralTestProp> <${ENT}p1> .
<${ENT}p1> <${PROP}pluralTestProp> <${ENT}p2> .
<${ENT}p1> <${PROP}pluralTestProp> <${ENT}p3> .
<${ENT}p1> <${PROP}pluralTestProp> <${ENT}p4> .
<${ENT}p2> <${RDF_TYPE}> <${PT}> .
<${ENT}p2> <${PROP}name> "Moa" .
<${ENT}p2> <${PROP}hobby> "Jogging" .
<${ENT}p2> <${PROP}isRealPerson> "false"^^<${XSD}boolean> .
<${ENT}p2> <${PROP}bestFriend> <${ENT}p3> .
<${ENT}p2> <${PROP}hasFriend> <${ENT}p3> .
<${ENT}p2> <${PROP}hasFriend> <${ENT}p4> .
<${ENT}p2> <${PROP}hasPet> <${ENT}dog2> .
<${ENT}p2> <${PROP}hasPet> <${ENT}dog2> .
<${ENT}p3> <${RDF_TYPE}> <${PT}> .
<${ENT}p3> <${PROP}name> "Jinx" .
<${ENT}p3> <${PROP}isRealPerson> "true"^^<${XSD}boolean> .
<${ENT}p4> <${RDF_TYPE}> <${PT}> .
<${ENT}p4> <${PROP}name> "Quinn" .
<${ENT}p5> <${RDF_TYPE}> <${PT}> .
<${ENT}p5> <${PROP}name> "Maximilian" .
<${ENT}dog1> <${RDF_TYPE}> <${DT}> .
<${ENT}dog1> <${RDF_TYPE}> <${PETT}> .
<${ENT}dog1> <${PROP}guardDogLevel> "2"^^<${XSD}integer> .
<${ENT}dog1> <${PROP}bestFriend> <${ENT}dog2> .
<${ENT}dog2> <${RDF_TYPE}> <${DT}> .
<${ENT}dog2> <${RDF_TYPE}> <${PETT}> .
<${ENT}d1> <${RDF_TYPE}> <${DT}> .
<${ENT}d1> <${RDF_TYPE}> <${PETT}> .
<${ENT}d1> <${PROP}guardDogLevel> "5"^^<${XSD}integer> .
<${ENT}e1> <${RDF_TYPE}> <${ET}> .
<${ENT}e1> <${PROP}employeeName> "Alice" .
<${ENT}e1> <${PROP}employeeDepartment> "Engineering" .
<${ENT}e1> <${PROP}bestFriend> <${ENT}e2> .
<${ENT}e2> <${RDF_TYPE}> <${ET}> .
<${ENT}e2> <${PROP}employeeName> "Bob" .
<${ENT}e2> <${PROP}employeeDepartment> "Sales" .
<${ENT}m1> <${RDF_TYPE}> <${MT}> .
<${ENT}m1> <${PROP}metricScore> "3.14"^^<${XSD}decimal> .
<${ENT}m1> <${PROP}metricRating> "2.5"^^<${XSD}double> .
<${ENT}m1> <${PROP}metricViews> "1000000"^^<${XSD}long> .
<${ENT}m1> <${PROP}metricCount> "42"^^<${XSD}integer> .
<${ENT}m1> <${PROP}metricJoinedOn> "2020-06-15"^^<${XSD}date> .
<${ENT}m1> <${PROP}metricScores> "1.5"^^<${XSD}decimal> .
<${ENT}m1> <${PROP}metricScores> "2.5"^^<${XSD}decimal> .
<${ENT}m1> <${PROP}metricScores> "2.5"^^<${XSD}decimal> .
<${ENT}m1> <${PROP}metricScores> "3.5"^^<${XSD}decimal> .
<${ENT}m2> <${RDF_TYPE}> <${MT}> .
<${ENT}m2> <${PROP}metricScore> "-7.25"^^<${XSD}decimal> .
<${ENT}m2> <${PROP}metricCount> "-3"^^<${XSD}integer> .
<${ENT}pna> <${RDF_TYPE}> <${PP}Node> .
<${ENT}pna> <${PP}name> "A" .
<${ENT}pna> <${PP}knows> <${ENT}pnb> .
<${ENT}pna> <${PP}email> "a@x" .
<${ENT}pna> <${PP}phone> "555" .
<${ENT}pna> <${PP}manages> <${ENT}pnb> .
<${ENT}pnb> <${RDF_TYPE}> <${PP}Node> .
<${ENT}pnb> <${PP}name> "B" .
<${ENT}pnb> <${PP}knows> <${ENT}pnc> .
<${ENT}pnb> <${PP}manages> <${ENT}pnc> .
<${ENT}pnc> <${RDF_TYPE}> <${PP}Node> .
<${ENT}pnc> <${PP}name> "C" .
`.trim();

let fusekiAvailable = false;
const store = new FusekiStore(
  process.env.FUSEKI_BASE_URL || 'http://localhost:3939',
  DATASET_NAME,
);

async function reloadBase(): Promise<void> {
  await clearAllData();
  await loadTestData(BASE_DATA);
}

beforeAll(async () => {
  fusekiAvailable = await ensureFuseki();
  if (!fusekiAvailable) {
    console.log('Fuseki not available — skipping coverage tests');
    return;
  }
  await createTestDataset();
  await reloadBase();
}, 30000);

afterAll(async () => {
  if (!fusekiAvailable) return;
  await clearAllData();
});

type Row = Record<string, any>;
const ids = (rows: Row[]): string[] =>
  rows.map((r) => r.id.replace(ENT, '')).sort();

const runSel = (name: keyof typeof queryFactories) =>
  store.selectQuery((queryFactories as any)[name]());

const find = (rows: Row[], id: string): Row =>
  rows.find((r) => r.id.includes(id))!;

// =========================================================================
// §2/§4 — operator & property-path tails
// =========================================================================
describe('coverage tails — operators & paths', () => {
  const P1 = {id: `${ENT}p1`}, PNA = {id: `${ENT}pna`};
  const one = async (q: any, key: string) => ((await store.selectQuery(q)) as Row)[key];

  test('date components hours/minutes/seconds (p1 13:45:30)', async () => {
    if (!fusekiAvailable) return;
    expect(await one(Person.select((p: any) => ({r: p.birthDate.hours()})).for(P1), 'r')).toBe(13);
    expect(await one(Person.select((p: any) => ({r: p.birthDate.minutes()})).for(P1), 'r')).toBe(45);
    expect(await one(Person.select((p: any) => ({r: p.birthDate.seconds()})).for(P1), 'r')).toBe(30);
  });

  test('encodeForUri projection', async () => {
    if (!fusekiAvailable) return;
    expect(await one(Person.select((p: any) => ({r: p.name.encodeForUri()})).for(P1), 'r')).toBe('Semmy');
  });

  test('isLiteral / isNumeric introspection (filter)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await store.selectQuery(Person.select().where((p: any) => p.name.isLiteral()))) as Row[]))
      .toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect((await store.selectQuery(Person.select().where((p: any) => p.name.isNumeric()))) as Row[]).toEqual([]);
  });

  test('zeroOrMore path knows*/name (pna → self + transitive)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(PathNode.select((n: any) => n.knowsChainNames).for(PNA))) as Row;
    expect([...(r.knowsChainNames as string[])].sort()).toEqual(['A', 'B', 'C']);
  });

  test('zeroOrOne path knows?/name (pna → self + direct)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(PathNode.select((n: any) => n.maybeKnownNames).for(PNA))) as Row;
    expect([...(r.maybeKnownNames as string[])].sort()).toEqual(['A', 'B']);
  });
});

// =========================================================================
// §6/§7 — DSL-JSON delete round-trip + {$ctx} mutation tails
// =========================================================================
describe('coverage tails — DSL-JSON delete & {$ctx} mutations', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('delete round-trips via fromJSON (deleteWhere)', async () => {
    if (!fusekiAvailable) return;
    // give p2 hobby=Chess, then delete-where(hobby=Chess) over the wire
    await executeSparqlUpdate(`DELETE { <${ENT}p2> <${PROP}hobby> ?o } INSERT { <${ENT}p2> <${PROP}hobby> "Chess" } WHERE { <${ENT}p2> <${PROP}hobby> ?o }`);
    const dq = queryFactories.deleteWhere();
    await store.deleteQuery(fromJSON((dq as any).toJSON()) as any);
    expect(ids((await store.selectQuery(queryFactories.selectName())) as Row[]))
      .toEqual(['p1', 'p3', 'p4', 'p5']);
  });

  test('{$ctx} as update target (user = p3)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(Person.update({hobby: 'CtxHobby'}).for(getQueryContext('user')));
    const r = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p3> <${PROP}hobby> ?h }`);
    expect(r.results.bindings.map((b: any) => b.h.value)).toEqual(['CtxHobby']);
  });

  test('{$ctx} as mutation field value (p1.bestFriend := user p3)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(Person.update({bestFriend: getQueryContext('user')} as any).for({id: `${ENT}p1`}));
    const r = await executeSparqlQuery(`SELECT ?b WHERE { <${ENT}p1> <${PROP}bestFriend> ?b }`);
    expect(r.results.bindings.map((b: any) => b.b.value)).toEqual([`${ENT}p3`]);
  });
});

// =========================================================================
// §5 — Builder features (ordering / pagination)
// =========================================================================
describe('coverage §5 — builder features', () => {
  const names = async (q: any) => ((await store.selectQuery(q)) as Row[]).map((r) => r.name);

  test('orderBy DESC', async () => {
    if (!fusekiAvailable) return;
    expect(await names(Person.select((p: any) => p.name).orderBy((p: any) => p.name, 'DESC')))
      .toEqual(['Semmy', 'Quinn', 'Moa', 'Maximilian', 'Jinx']);
  });

  test('multi-key orderBy [hobby, name] (nulls first, then by name)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await store.selectQuery(
      Person.select((p: any) => [p.name, p.hobby]).orderBy((p: any) => [p.hobby, p.name]),
    )) as Row[];
    expect(rows.map((r) => r.name)).toEqual(['Jinx', 'Maximilian', 'Quinn', 'Moa', 'Semmy']);
  });

  test('top-level offset + limit windowing', async () => {
    if (!fusekiAvailable) return;
    // names asc: Jinx, Maximilian, Moa, Quinn, Semmy → offset(1).limit(2)
    expect(await names(Person.select((p: any) => p.name).orderBy((p: any) => p.name).offset(1).limit(2)))
      .toEqual(['Maximilian', 'Moa']);
  });
});

// =========================================================================
// §6 — DSL-JSON round-trip E2E (toJSON → fromJSON → run == run)
// =========================================================================
describe('coverage §6 — DSL-JSON round-trip', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('select round-trips losslessly (versioned) and yields identical results', async () => {
    if (!fusekiAvailable) return;
    const q = Person.select((p: any) => [p.name, p.friends.name]);
    const json = (q as any).toJSON();
    expect(json.v).toBe(WIRE_VERSION);
    const direct = await store.selectQuery(q);
    const viaJson = await store.selectQuery(fromJSON(json) as any);
    expect(viaJson).toEqual(direct);
  });

  test('create round-trips and executes via fromJSON', async () => {
    if (!fusekiAvailable) return;
    const cq = Person.create({name: 'JsonRoundTrip'} as any);
    const created = (await store.createQuery(fromJSON((cq as any).toJSON()) as any)) as Row;
    expect(created.name).toBe('JsonRoundTrip');
    const verify = await executeSparqlQuery(`SELECT ?n WHERE { <${created.id}> <${PROP}name> ?n }`);
    expect(verify.results.bindings[0].n.value).toBe('JsonRoundTrip');
    await executeSparqlUpdate(`DELETE WHERE { <${created.id}> ?p ?o }`);
  });

  test('update round-trips and applies via fromJSON', async () => {
    if (!fusekiAvailable) return;
    const uq = Person.update({hobby: 'JsonHobby'}).for({id: `${ENT}p1`});
    await store.updateQuery(fromJSON((uq as any).toJSON()) as any);
    const verify = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p1> <${PROP}hobby> ?h }`);
    expect(verify.results.bindings.map((b: any) => b.h.value)).toEqual(['JsonHobby']);
  });
});

// =========================================================================
// §7 — {$ctx} context references E2E
// =========================================================================
describe('coverage §7 — {$ctx} context', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('context as select subject (user = p3 → Jinx)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      Person.select((p: any) => p.name).for(getQueryContext('user')),
    )) as Row;
    expect(r.id).toContain('p3');
    expect(r.name).toBe('Jinx');
  });

  test('context as where-arg (bestFriend == user p3 → p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await store.selectQuery(
      Person.select().where((p: any) => p.bestFriend.equals(getQueryContext('user'))),
    )) as Row[])).toEqual(['p2']);
  });

  test('delete-by-context removes the context entity (p3)', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(Person.delete(getQueryContext('user')) as any);
    const remaining = (await store.selectQuery(queryFactories.selectName())) as Row[];
    expect(ids(remaining)).toEqual(['p1', 'p2', 'p4', 'p5']);
  });

  test('mutation with an unresolved context rejects', async () => {
    if (!fusekiAvailable) return;
    await expect(
      store.updateQuery(Person.update({hobby: 'x'}).for(getQueryContext('no-such-ctx')) as any),
    ).rejects.toThrow(/context/i);
  });
});

// =========================================================================
// §4 — DSL property paths E2E (complex decorator paths → SPARQL → results)
// =========================================================================
describe('coverage §4 — property paths', () => {
  const PNA = {id: `${ENT}pna`};
  const PNB = {id: `${ENT}pnb`};

  test('sequence path: knows/name (pna → "B")', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.friendName).for(PNA),
    )) as Row;
    expect(r.friendName).toBe('B');
  });

  test('alternative path: email|phone (pna → both)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.contact).for(PNA),
    )) as Row;
    expect([...(r.contact as string[])].sort()).toEqual(['555', 'a@x']);
  });

  test('inverse+sequence path: ^knows/name (pnb → "A")', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.knownByName).for(PNB),
    )) as Row;
    expect(r.knownByName).toBe('A');
  });

  test('transitive path: manages+/name (pna → ["B","C"])', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.reportNames).for(PNA),
    )) as Row;
    expect([...(r.reportNames as string[])].sort()).toEqual(['B', 'C']);
  });
});

// =========================================================================
// §2 — Operators (string / numeric / date / null / introspection / hash)
// =========================================================================
const P1 = {id: `${ENT}p1`}, M1 = {id: `${ENT}m1`}, M2 = {id: `${ENT}m2`};
const projVal = async (q: any, key = 'r') => {
  const r = (await store.selectQuery(q)) as any;
  return Array.isArray(r) ? r.map((x) => x[key]) : r?.[key];
};
const filterIds = async (q: any) => ids((await store.selectQuery(q)) as Row[]);

describe('coverage §2 — string operators', () => {
  test('substr / replace / concat / before / after (projection)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.name.substr(1, 3)})).for(P1))).toBe('Sem');
    expect(await projVal(Person.select((p: any) => ({r: p.name.replace('m', 'X', 'i')})).for(P1))).toBe('SeXXy');
    expect(await projVal(Person.select((p: any) => ({r: p.name.concat('!')})).for(P1))).toBe('Semmy!');
    expect(await projVal(Person.select((p: any) => ({r: p.name.before('m')})).for(P1))).toBe('Se');
    expect(await projVal(Person.select((p: any) => ({r: p.name.after('m')})).for(P1))).toBe('my');
  });
  test('contains / startsWith / endsWith / matches (filter)', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(Person.select().where((p: any) => p.name.contains('in')))).toEqual(['p3', 'p4']);
    expect(await filterIds(Person.select().where((p: any) => p.name.startsWith('S')))).toEqual(['p1']);
    expect(await filterIds(Person.select().where((p: any) => p.name.endsWith('x')))).toEqual(['p3']);
    expect(await filterIds(Person.select().where((p: any) => p.name.matches('^[MQ]')))).toEqual(['p2', 'p4', 'p5']);
  });
});

describe('coverage §2 — numeric operators', () => {
  test('minus / times / divide / power (Metric m1: count=42)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Metric.select((x: any) => ({r: x.count.minus(2)})).for(M1))).toBe(40);
    expect(await projVal(Metric.select((x: any) => ({r: x.count.times(2)})).for(M1))).toBe(84);
    expect(await projVal(Metric.select((x: any) => ({r: x.count.divide(2)})).for(M1))).toBe(21);
    expect(await projVal(Metric.select((x: any) => ({r: x.count.power(2)})).for(M1))).toBe(1764);
  });
  test('abs / round / ceil / floor', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Metric.select((x: any) => ({r: x.count.abs()})).for(M2))).toBe(3); // m2.count=-3
    expect(await projVal(Metric.select((x: any) => ({r: x.score.round()})).for(M1))).toBe(3); // 3.14
    expect(await projVal(Metric.select((x: any) => ({r: x.score.ceil()})).for(M1))).toBe(4);
    expect(await projVal(Metric.select((x: any) => ({r: x.score.floor()})).for(M1))).toBe(3);
  });
  test('gte / lte (filter)', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(Metric.select().where((x: any) => x.count.gte(42)))).toEqual(['m1']);
    expect(await filterIds(Metric.select().where((x: any) => x.count.lte(0)))).toEqual(['m2']);
  });
});

describe('coverage §2 — date operators', () => {
  test('year / month / day (p1 birthDate 1990-01-01)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.birthDate.year()})).for(P1))).toBe(1990);
    expect(await projVal(Person.select((p: any) => ({r: p.birthDate.month()})).for(P1))).toBe(1);
    expect(await projVal(Person.select((p: any) => ({r: p.birthDate.day()})).for(P1))).toBe(1);
  });

  /**
   * The end-to-end proof that a `Date` in a filter is emitted TYPED. Measured before
   * the fix, this returned zero rows against the very triple below: the filter
   * rendered a plain `"1990-01-01T13:45:30.000Z"`, and in SPARQL that is a type
   * error against an `^^xsd:dateTime` term, so the row was dropped.
   */
  test('equals(Date) matches a stored xsd:dateTime', async () => {
    if (!fusekiAvailable) return;
    expect(
      await filterIds(
        Person.select().where((p: any) =>
          p.birthDate.equals(new Date('1990-01-01T13:45:30.000Z')),
        ),
      ),
    ).toEqual(['p1']);
  });

  test('a Date range filter matches too', async () => {
    if (!fusekiAvailable) return;
    expect(
      await filterIds(
        Person.select().where((p: any) => p.birthDate.lt(new Date('2000-01-01T00:00:00.000Z'))),
      ),
    ).toEqual(['p1']);
  });
});

describe('coverage §2 — null / introspection / hash', () => {
  test('isDefined (filter) → persons with a hobby', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(Person.select().where((p: any) => p.hobby.isDefined()))).toEqual(['p1', 'p2']);
  });
  test('defaultTo (coalesce) fills missing hobby', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(Person.select((p: any) => ({r: p.hobby.defaultTo('none')})))) as Row[];
    expect(Object.fromEntries(r.map((x) => [x.id.replace(ENT, ''), x.r]))).toEqual({
      p1: 'Reading', p2: 'Jogging', p3: 'none', p4: 'none', p5: 'none',
    });
  });
  test('defaultTo (coalesce) in a where-filter matches persons missing the property', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(queryFactories.whereExprDefaultTo())).toEqual(['p3', 'p4', 'p5']);
  });
  test('Expr.ifThen in a where-filter — taken branch matches even when the untaken branch references a missing property', async () => {
    if (!fusekiAvailable) return;
    // p4 (Quinn) has no hobby; the else-branch STR(hobby) must not inner-join it away
    expect(await filterIds(queryFactories.whereExprIfThen())).toEqual(['p4']);
  });
  test('str / datatype (introspection)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.name.str()})).for(P1))).toBe('Semmy');
    const dt = await projVal(Metric.select((x: any) => ({r: x.score.datatype()})).for(M1));
    expect(dt.id).toBe(`${XSD}decimal`);
  });
  test('md5 / sha256 — exact digests of "Semmy"', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.name.md5()})).for(P1)))
      .toBe(createHash('md5').update('Semmy').digest('hex'));
    expect(await projVal(Person.select((p: any) => ({r: p.name.sha256()})).for(P1)))
      .toBe(createHash('sha256').update('Semmy').digest('hex'));
  });

  test('isNotDefined (filter) → persons without a hobby', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(Person.select().where((p: any) => p.hobby.isNotDefined()))).toEqual([
      'p3', 'p4', 'p5',
    ]);
  });
  test('Expr.ifThen picks the matching branch per row', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      Person.select((p: any) => ({r: Expr.ifThen(p.name.equals('Semmy'), 'yes', 'no')})),
    )) as Row[];
    expect(Object.fromEntries(r.map((x) => [x.id.replace(ENT, ''), x.r]))).toEqual({
      p1: 'yes', p2: 'no', p3: 'no', p4: 'no', p5: 'no',
    });
    expect(await projVal(
      Person.select((p: any) => ({r: Expr.ifThen(p.isRealPerson.equals(true), 'real', 'fake')})).for(P1),
    )).toBe('real');
  });
});

// =========================================================================
// §3 — Datatype coercion (Metric shape)
// =========================================================================
describe('coverage §3 — datatypes', () => {
  test('decimal/double/long/integer coerce to JS number', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => [x.score, x.rating, x.views, x.count]).for({id: `${ENT}m1`}),
    )) as Row;
    expect(m.score).toBe(3.14);
    expect(m.rating).toBe(2.5);
    expect(m.views).toBe(1000000);
    expect(m.count).toBe(42);
    expect(typeof m.score).toBe('number');
  });

  test('xsd:date coerces to a JS Date', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => x.joinedOn).for({id: `${ENT}m1`}),
    )) as Row;
    expect(m.joinedOn instanceof Date).toBe(true);
    expect((m.joinedOn as Date).getUTCFullYear()).toBe(2020);
  });

  test('negative numbers round-trip', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => [x.score, x.count]).for({id: `${ENT}m2`}),
    )) as Row;
    expect(m.score).toBe(-7.25);
    expect(m.count).toBe(-3);
  });

  test('multi-valued numeric literal collects, dedups, into number[]', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => x.scores).for({id: `${ENT}m1`}),
    )) as Row;
    expect(Array.isArray(m.scores)).toBe(true);
    // seed has 1.5, 2.5, 2.5, 3.5 → deduped {1.5, 2.5, 3.5}
    expect([...(m.scores as number[])].sort((a, b) => a - b)).toEqual([1.5, 2.5, 3.5]);
    (m.scores as number[]).forEach((v) => expect(typeof v).toBe('number'));
  });
});

// =========================================================================
// §1 — Deep nesting / sub-selects (read-only). 11 sound; 3 quarantined (bugs).
// =========================================================================
describe('coverage §1 — deep nesting', () => {
  test('tripleNestedSubSelect — friends→bestFriend→friends', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('tripleNestedSubSelect')) as Row[];
    const p1 = find(rows, 'p1');
    expect(p1.friends.map((f: Row) => f.id.replace(ENT, '')).sort()).toEqual(['p2', 'p3']);
    const p2 = p1.friends.find((f: Row) => f.id.includes('p2'));
    expect(p2.bestFriend.id).toContain('p3');
    expect(p2.bestFriend.friends).toEqual([]);
  });

  test('doubleNestedSingularPlural — bestFriend→friends', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('doubleNestedSingularPlural')) as Row[];
    expect(find(rows, 'p2').bestFriend.id).toContain('p3');
    expect(find(rows, 'p2').bestFriend.friends).toEqual([]);
    expect(find(rows, 'p1').bestFriend).toBeNull();
  });

  test('doubleNestedPluralSingular — friends→bestFriend {name,isReal}', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('doubleNestedPluralSingular')) as Row[];
    const p2 = find(rows, 'p1').friends.find((f: Row) => f.id.includes('p2'));
    expect(p2.bestFriend).toEqual(expect.objectContaining({name: 'Jinx', isReal: true}));
  });

  test('employeeSubSelect — Employee.bestFriend {name,dept}', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('employeeSubSelect')) as Row[];
    expect(find(rows, 'e1').bestFriend).toEqual(expect.objectContaining({name: 'Bob', dept: 'Sales'}));
    expect(find(rows, 'e2').bestFriend).toBeNull();
  });

  test('mixedPathAndSubSelect — name + friends.select(name,hobby)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('mixedPathAndSubSelect')) as Row[];
    const p1 = find(rows, 'p1');
    expect(p1.name).toBe('Semmy');
    const moa = p1.friends.find((f: Row) => f.id.includes('p2'));
    expect(moa).toEqual(expect.objectContaining({name: 'Moa', hobby: 'Jogging'}));
    expect(p1.friends.find((f: Row) => f.id.includes('p3')).hobby).toBeNull();
  });

  test('multipleSubSelectsInArray — friends.select(name) + bestFriend.select(hobby)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('multipleSubSelectsInArray')) as Row[];
    const p2 = find(rows, 'p2');
    expect(p2.friends.map((f: Row) => f.id.replace(ENT, '')).sort()).toEqual(['p3', 'p4']);
    expect(p2.bestFriend.id).toContain('p3');
    expect(p2.bestFriend.hobby).toBeNull();
    expect(find(rows, 'p1').bestFriend).toBeNull();
  });

  test('subSelectArrayOfPaths — friends.select([name,hobby,birthDate])', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectArrayOfPaths')) as Row[];
    const moa = find(rows, 'p1').friends.find((f: Row) => f.id.includes('p2'));
    expect(moa).toEqual(expect.objectContaining({name: 'Moa', hobby: 'Jogging', birthDate: null}));
  });

  test('subSelectSingularArrayPaths — bestFriend.select([name,hobby,isRealPerson])', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectSingularArrayPaths')) as Row[];
    expect(find(rows, 'p2').bestFriend).toEqual(
      expect.objectContaining({name: 'Jinx', hobby: null, isRealPerson: true}),
    );
  });

  test('subSelectAllPlural — friends.selectAll() includes nested refs', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectAllPlural')) as Row[];
    const moa = find(rows, 'p1').friends.find((f: Row) => f.id.includes('p2'));
    expect(moa.name).toBe('Moa');
    expect(moa.isRealPerson).toBe(false);
    expect(moa.bestFriend.id).toContain('p3');
    expect(moa.firstPet.id).toContain('dog2');
  });

  test('subSelectAllSingular — bestFriend.selectAll()', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectAllSingular')) as Row[];
    const bf = find(rows, 'p2').bestFriend;
    expect(bf.name).toBe('Jinx');
    expect(bf.isRealPerson).toBe(true);
    expect(bf.hobby).toBeNull();
  });

  test('selectBestFriendOnly — bestFriend reference only', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('selectBestFriendOnly')) as Row[];
    expect(find(rows, 'p2').bestFriend.id).toContain('p3');
    expect(find(rows, 'p1').bestFriend).toBeNull();
  });

  test('pluralFilteredNestedSubSelect — inline .where() keeps only Moa + her friends', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('pluralFilteredNestedSubSelect')) as Row[];
    const p1 = find(rows, 'p1');
    expect(p1.pluralTestProp).toHaveLength(1);
    const moa = p1.pluralTestProp[0];
    expect(moa.id).toContain('p2');
    expect(moa.name).toBe('Moa');
    expect(
      moa.friends
        .map((f: Row) => ({id: f.id.replace(ENT, ''), name: f.name, hobby: f.hobby}))
        .sort((a: Row, b: Row) => (a.id as string).localeCompare(b.id as string)),
    ).toEqual([
      {id: 'p3', name: 'Jinx', hobby: null},
      {id: 'p4', name: 'Quinn', hobby: null},
    ]);
    // Persons without a matching pluralTestProp keep an empty array (no leak
    // of unfiltered entries and no cross-product from the unbound alias)
    expect(find(rows, 'p2').pluralTestProp).toEqual([]);
    expect(find(rows, 'p5').pluralTestProp).toEqual([]);
  });

  test('nestedFilteredSubSelects — a filtered sub-select inside a filtered sub-select', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('nestedFilteredSubSelects')) as Row[];
    const p1 = find(rows, 'p1');
    expect(p1.pluralTestProp).toHaveLength(1);
    const moa = p1.pluralTestProp[0];
    expect(moa.name).toBe('Moa');
    // Inner filter keeps only Jinx out of Moa's friends [Jinx, Quinn]
    expect(moa.friends.map((f: Row) => ({name: f.name, hobby: f.hobby}))).toEqual([
      {name: 'Jinx', hobby: null},
    ]);
    // Persons without a Moa match keep an empty array — the inner filtered
    // block must not cross-product over the graph when the outer alias is unbound
    for (const other of ['p2', 'p3', 'p4', 'p5']) {
      expect(find(rows, other).pluralTestProp).toEqual([]);
    }
  });

  test('subSelectWithCount — numFriends scoped to each friend, not the parent', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectWithCount')) as Row[];
    const friendCounts = (row: Row) =>
      Object.fromEntries(row.friends.map((f: Row) => [f.name, f.numFriends]));
    expect(find(rows, 'p1').numFriends).toBeUndefined();
    expect(friendCounts(find(rows, 'p1'))).toEqual({Moa: 2, Jinx: 0});
    expect(friendCounts(find(rows, 'p2'))).toEqual({Jinx: 0, Quinn: 0});
    expect(find(rows, 'p3').friends).toEqual([]);
  });

  test('subSelectWithOne — .one() keeps the full friends array incl. null-hobby Jinx', async () => {
    if (!fusekiAvailable) return;
    const row = (await runSel('subSelectWithOne')) as Row;
    expect(row.id).toContain('p1');
    expect(
      row.friends
        .map((f: Row) => ({name: f.name, hobby: f.hobby}))
        .sort((a: Row, b: Row) => (a.name as string).localeCompare(b.name as string)),
    ).toEqual([
      {name: 'Jinx', hobby: null},
      {name: 'Moa', hobby: 'Jogging'},
    ]);
  });
});

// =========================================================================
// §1 — MINUS exclusion (read-only)
// =========================================================================
describe('coverage §1 — MINUS', () => {
  test('minusShape — Person minus Employee (persons are not employees)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusShape')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('minusCondition — minus hobby=Chess (nobody) keeps all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusCondition')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('minusChained — two MINUS blocks', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusChained')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('minusMultiProperty — exclude where hobby AND nickNames exist (p1)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusMultiProperty')) as Row[])).toEqual(['p2', 'p3', 'p4', 'p5']);
  });
  test('minusNestedPath — exclude where bestFriend.name exists (p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusNestedPath')) as Row[])).toEqual(['p1', 'p3', 'p4', 'p5']);
  });
  test('minusMixed — flat + nested AND exclusion (p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusMixed')) as Row[])).toEqual(['p1', 'p3', 'p4', 'p5']);
  });
  test('minusSingleProperty — exclude anyone with a hobby (p1, p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusSingleProperty')) as Row[])).toEqual(['p3', 'p4', 'p5']);
  });
});

// =========================================================================
// §1 — Negation / quantifier filters (read-only)
// =========================================================================
describe('coverage §1 — negation/quantifier', () => {
  test('whereNone — friends none hobby=Chess → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereNone')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereSomeNot — NOT some(friend hobby=Chess) → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereSomeNot')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereEqualsNot — name != Alice → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereEqualsNot')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereNeq — name neq Alice → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereNeq')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereNoneAndEquals — none(Chess) AND name=Bob → none', async () => {
    if (!fusekiAvailable) return;
    expect((await runSel('whereNoneAndEquals')) as Row[]).toEqual([]);
  });
});

// =========================================================================
// §1 — Expression-based WHERE (read-only)
// =========================================================================
describe('coverage §1 — expression WHERE', () => {
  test('whereExprStrlen — strlen(name) > 5 → Maximilian', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprStrlen')) as Row[])).toEqual(['p5']);
  });
  test('whereExprArithmetic — strlen+10 < 100 → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprArithmetic')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereExprAndChain — strlen>5 AND strlen<20 → Maximilian', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprAndChain')) as Row[])).toEqual(['p5']);
  });
  test('whereExprMixed — name=Bob AND strlen>3 → none', async () => {
    if (!fusekiAvailable) return;
    expect((await runSel('whereExprMixed')) as Row[]).toEqual([]);
  });
  test('whereExprNestedPath — bestFriend.name strlen>3 → p2', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprNestedPath')) as Row[])).toEqual(['p2']);
  });
  test('whereExprNot — NOT(name=Alice AND hobby=Chess); requires hobby bound → p1,p2', async () => {
    if (!fusekiAvailable) return;
    // hobby is a required binding in the AND, so only rows with a hobby (p1,p2)
    // are evaluated; both pass the negation.
    expect(ids((await runSel('whereExprNot')) as Row[])).toEqual(['p1', 'p2']);
  });
  test('whereExprWithProjection — filter strlen>2 + nameLen projection', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('whereExprWithProjection')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), r.nameLen]));
    expect(byId).toEqual({p1: 5, p2: 3, p3: 4, p4: 5, p5: 10});
  });
});

// =========================================================================
// §1 — Computed expression projections (read-only)
// =========================================================================
describe('coverage §1 — computed projections', () => {
  test('exprStrlen — name length per person (key: expr)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprStrlen')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), r.expr]));
    expect(byId).toEqual({p1: 5, p2: 3, p3: 4, p4: 5, p5: 10});
  });
  test('exprCustomKey — {nameLen: strlen}', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprCustomKey')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), r.nameLen]));
    expect(byId).toEqual({p1: 5, p2: 3, p3: 4, p4: 5, p5: 10});
  });
  test('exprMultiple — [name, strlen]', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprMultiple')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), [r.name, r.expr]]));
    expect(byId).toEqual({
      p1: ['Semmy', 5], p2: ['Moa', 3], p3: ['Jinx', 4],
      p4: ['Quinn', 5], p5: ['Maximilian', 10],
    });
  });
  test('exprNestedPath — bestFriend.name.ucase() (fixed alias collision)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprNestedPath')) as Row[];
    // Only p2 has a bestFriend (p3 "Jinx") → "JINX"; others have no bestFriend.
    const byId = Object.fromEntries(
      rows.filter((r) => r.expr != null).map((r) => [r.id.replace(ENT, ''), r.expr]),
    );
    expect(byId).toEqual({p2: 'JINX'});
  });
});

// =========================================================================
// §1 — Expression-based updates (mutating; isolated per test)
// =========================================================================
describe('coverage §1 — expression updates', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('updateExprCallback — guardDogLevel + 1 (d1: 5 → 6)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.updateExprCallback());
    const r = await executeSparqlQuery(`SELECT ?v WHERE { <${ENT}d1> <${PROP}guardDogLevel> ?v }`);
    expect(r.results.bindings.map((b: any) => b.v.value)).toEqual(['6']);
  });

  test('updateExprNow — birthDate := now() (single, current year)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.updateExprNow());
    const r = await executeSparqlQuery(`SELECT ?v WHERE { <${ENT}p1> <${PROP}birthDate> ?v }`);
    expect(r.results.bindings.length).toBe(1);
    const yr = new Date(r.results.bindings[0].v.value).getFullYear();
    expect(yr).toBeGreaterThanOrEqual(2026);
  });

  // backlog 003 (FIXED): expression update over a traversal now nests the leaf
  // property triple inside its traversal-edge OPTIONAL, so it is scoped to the
  // target's traversal target instead of every entity in the graph.
  test('updateExprTraversal — hobby := bestFriend.name.ucase(), target WITH bestFriend', async () => {
    if (!fusekiAvailable) return;
    // p2.bestFriend = p3 ("Jinx") → hobby becomes "JINX"
    await store.updateQuery(
      Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).for({id: `${ENT}p2`}),
    );
    const r = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p2> <${PROP}hobby> ?h }`);
    expect(r.results.bindings.map((b: any) => b.h.value)).toEqual(['JINX']);
  });

  test('updateExprTraversal — no cross-entity corruption when target has no bestFriend', async () => {
    if (!fusekiAvailable) return;
    // p1 has no bestFriend: old hobby is removed, nothing is inserted — and
    // crucially the hobby must NOT be filled with every entity's UCASE(name).
    await store.updateQuery(queryFactories.updateExprTraversal());
    const r = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p1> <${PROP}hobby> ?h }`);
    const vals = r.results.bindings.map((b: any) => b.h.value);
    expect(vals).not.toContain('SEMMY');
    expect(vals.length).toBeLessThanOrEqual(1);
  });

  test('updateExprSharedTraversal — two fields off bestFriend stay scoped', async () => {
    if (!fusekiAvailable) return;
    // p2.bestFriend = p3 ("Jinx", no hobby): name := "JINX"; hobby := lcase(none) → unset
    await store.updateQuery(
      Person.update((p: any) => ({
        name: p.bestFriend.name.ucase(),
        hobby: p.bestFriend.hobby.lcase(),
      })).for({id: `${ENT}p2`}),
    );
    const n = await executeSparqlQuery(`SELECT ?n WHERE { <${ENT}p2> <${PROP}name> ?n }`);
    expect(n.results.bindings.map((b: any) => b.n.value)).toEqual(['JINX']);
  });
});

// =========================================================================
// §1 — Bulk / conditional mutations (mutating; isolated per test)
// =========================================================================
describe('coverage §1 — bulk/conditional mutations', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  const personCount = async () =>
    Number((await executeSparqlQuery(
      `SELECT (COUNT(?s) AS ?c) WHERE { ?s <${RDF_TYPE}> <${PT}> }`,
    )).results.bindings[0].c.value);
  const hobbies = async () =>
    (await executeSparqlQuery(`SELECT ?s ?h WHERE { ?s <${PROP}hobby> ?h }`)).results.bindings
      .map((b: any) => `${b.s.value.replace(ENT, '')}=${b.h.value}`).sort();

  test('updateForAll — set hobby=Chess on all persons', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.updateForAll());
    expect(await hobbies()).toEqual(['p1=Chess', 'p2=Chess', 'p3=Chess', 'p4=Chess', 'p5=Chess']);
  });

  test('updateWhere — hobby:=Archived where hobby=Chess (set one Chess first)', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(`DELETE { <${ENT}p1> <${PROP}hobby> ?o } INSERT { <${ENT}p1> <${PROP}hobby> "Chess" } WHERE { <${ENT}p1> <${PROP}hobby> ?o }`);
    await store.updateQuery(queryFactories.updateWhere());
    expect(await hobbies()).toEqual(['p1=Archived', 'p2=Jogging']);
  });

  test('deleteWhere — delete persons with hobby=Chess (set p2 Chess first)', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(`DELETE { <${ENT}p2> <${PROP}hobby> ?o } INSERT { <${ENT}p2> <${PROP}hobby> "Chess" } WHERE { <${ENT}p2> <${PROP}hobby> ?o }`);
    await store.deleteQuery(queryFactories.deleteWhere());
    const remaining = (await store.selectQuery(queryFactories.selectName())) as Row[];
    expect(ids(remaining)).toEqual(['p1', 'p3', 'p4', 'p5']);
  });

  test('deleteAll — removes every Person', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(queryFactories.deleteAll());
    expect(await personCount()).toBe(0);
  });

  test('deleteAllBuilder — DeleteBuilder.from(Person).all() removes every Person', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(queryFactories.deleteAllBuilder());
    expect(await personCount()).toBe(0);
  });

  test('whereExprUpdateBuilder — hobby:=Archived where strlen(name)>3', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.whereExprUpdateBuilder() as any);
    // names>3 chars: Semmy, Jinx, Quinn, Maximilian → Archived; Moa(3) untouched.
    expect(await hobbies()).toEqual(
      ['p1=Archived', 'p2=Jogging', 'p3=Archived', 'p4=Archived', 'p5=Archived'].sort(),
    );
  });

  test('whereExprDeleteBuilder — delete where strlen(name)>3', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(queryFactories.whereExprDeleteBuilder() as any);
    const remaining = (await store.selectQuery(queryFactories.selectName())) as Row[];
    // only Moa (len 3) survives
    expect(ids(remaining)).toEqual(['p2']);
  });
});

// ---------------------------------------------------------------------------
// Existence checks against a live store.
// ---------------------------------------------------------------------------

describe('coverage — .exists() against Fuseki', () => {
  // Re-seed: the mutation suites above leave the dataset emptied.
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('Shape.exists(id) → true for a node that is there', async () => {
    if (!fusekiAvailable) return;
    expect(await Person.exists({id: `${ENT}p1`}, store)).toBe(true);
  });

  test('Shape.exists(id) → false for a node that is not', async () => {
    if (!fusekiAvailable) return;
    expect(await Person.exists({id: `${ENT}nobody`}, store)).toBe(false);
    expect(await Person.exists('https://does.not/exist', store)).toBe(false);
  });

  test('Shape.exists(id) accepts a plain string IRI', async () => {
    if (!fusekiAvailable) return;
    expect(await Person.exists(`${ENT}p2`, store)).toBe(true);
  });

  test('existence is shape-scoped — a Dog iri is not a Person', async () => {
    if (!fusekiAvailable) return;
    expect(await Dog.exists({id: `${ENT}dog1`}, store)).toBe(true);
    expect(await Person.exists({id: `${ENT}dog1`}, store)).toBe(false);
  });

  test('.exists() with a where clause — matching and non-matching', async () => {
    if (!fusekiAvailable) return;
    expect(
      await Person.select().where((p: any) => p.name.equals('Semmy')).exists(store),
    ).toBe(true);
    expect(
      await Person.select().where((p: any) => p.name.equals('Nobody')).exists(store),
    ).toBe(false);
  });

  test('.exists() ignores projection and sorting but honours the subject', async () => {
    if (!fusekiAvailable) return;
    // hobby is unset on p3 — a projected property must not gate existence.
    expect(
      await Person.select((p: any) => p.hobby)
        .orderBy((p: any) => p.name)
        .for({id: `${ENT}p3`})
        .exists(store),
    ).toBe(true);
  });

  test('.exists() drops pagination — offset does not flip the answer', async () => {
    if (!fusekiAvailable) return;
    // p1 has two friends, so this projection yields 2 solution rows per subject.
    // If exists() dropped the projection but kept OFFSET 1, the normalised query
    // would produce 1 row, skip it, and wrongly answer false.
    expect(
      await Person.select((p: any) => p.friends.name)
        .for({id: `${ENT}p1`})
        .offset(1)
        .exists(store),
    ).toBe(true);
    // An offset past the end of the *un-normalised* result set must not read as absent.
    expect(
      await Person.select((p: any) => p.name).offset(500).exists(store),
    ).toBe(true);
  });

  test('.exists() ignores a previously set limit, including limit(0)', async () => {
    if (!fusekiAvailable) return;
    expect(await Person.select().limit(0).exists(store)).toBe(true);
  });

  test('.forAll(ids).exists() — true if any of the ids is there', async () => {
    if (!fusekiAvailable) return;
    expect(
      await Person.selectAll().forAll([`${ENT}nobody`, `${ENT}p2`]).exists(store),
    ).toBe(true);
    expect(
      await Person.selectAll().forAll([`${ENT}nobody`, `${ENT}no-one`]).exists(store),
    ).toBe(false);
  });

  test('.exists() answers "any at all" when nothing is targeted', async () => {
    if (!fusekiAvailable) return;
    expect(await Person.select().exists(store)).toBe(true);
    await clearAllData();
    try {
      expect(await Person.select().exists(store)).toBe(false);
      expect(await Person.exists({id: `${ENT}p1`}, store)).toBe(false);
    } finally {
      // All fuseki suites share one dataset — restore it here rather than relying
      // on the next beforeEach, so a failure above cannot strand an empty store.
      await reloadBase();
    }
  });

  test('a real store failure rejects rather than resolving false', async () => {
    if (!fusekiAvailable) return;
    const broken = new FusekiStore(
      process.env.FUSEKI_BASE_URL || 'http://localhost:3939',
      'no-such-dataset-here',
    );
    await expect(Person.exists({id: `${ENT}p1`}, broken)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The existence check is an ASK against a live store — and agrees with the
// SELECT degradation it replaces.
// ---------------------------------------------------------------------------

describe('coverage — .exists() emits ASK against Fuseki', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  /** Wraps the live store, recording the SPARQL it actually sends. */
  const spyStore = () => {
    const sent: string[] = [];
    const spy = Object.create(store) as FusekiStore & {
      executeSparqlSelect(sparql: string): Promise<any>;
    };
    spy.executeSparqlSelect = function (sparql: string) {
      sent.push(sparql);
      return (store as any).executeSparqlSelect(sparql);
    };
    return {spy, sent};
  };

  test('the query on the wire is an ASK, not a SELECT', async () => {
    if (!fusekiAvailable) return;
    const {spy, sent} = spyStore();
    expect(await Person.exists({id: `${ENT}p1`}, spy)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ASK WHERE {');
    expect(sent[0]).not.toContain('SELECT');
    expect(sent[0]).not.toContain('LIMIT');
  });

  test('Fuseki answers ASK with the boolean shape the mapper expects', async () => {
    if (!fusekiAvailable) return;
    // Guards the SparqlAskResults type against the real endpoint: an ASK
    // response carries `boolean` and no `results` key at all.
    const present = await executeSparqlQuery(
      `ASK WHERE { <${ENT}p1> ?p ?o }`,
    );
    expect(present).toEqual({head: {}, boolean: true});
    const absent = await executeSparqlQuery(
      `ASK WHERE { <${ENT}nobody> ?p ?o }`,
    );
    expect(absent).toEqual({head: {}, boolean: false});
  });

  test('ASK answers correctly across every pattern the builder can express', async () => {
    if (!fusekiAvailable) return;
    const cases: Array<[string, () => Promise<boolean>, boolean]> = [
      ['present', () => Person.select().for(`${ENT}p1`).exists(store), true],
      ['absent', () => Person.select().for(`${ENT}nobody`).exists(store), false],
      ['where match', () =>
        Person.select().where((p: any) => p.name.equals('Semmy')).exists(store), true],
      ['where miss', () =>
        Person.select().where((p: any) => p.name.equals('Nobody')).exists(store), false],
      ['wrong shape', () => Person.select().for(`${ENT}dog1`).exists(store), false],
      ['any at all', () => Person.select().exists(store), true],
      ['forAll partial', () =>
        Person.selectAll().forAll([`${ENT}nobody`, `${ENT}p2`]).exists(store), true],
      ['projected + sorted', () =>
        Person.select((p: any) => p.hobby)
          .orderBy((p: any) => p.name)
          .for(`${ENT}p3`)
          .exists(store), true],
    ];
    for (const [label, run, expected] of cases) {
      expect(`${label}=${await run()}`).toBe(`${label}=${expected}`);
    }
  });

  test('a shapeless Shape.exists(uri) ignores type entirely', async () => {
    if (!fusekiAvailable) return;
    const {spy, sent} = spyStore();
    // dog1 is a Dog, not a Person: shape-scoped asks say false, shapeless says true.
    expect(await Person.exists({id: `${ENT}dog1`}, spy)).toBe(false);
    expect(await Shape.exists(`${ENT}dog1`, spy)).toBe(true);
    expect(await Shape.exists(`${ENT}nobody`, spy)).toBe(false);
    expect(sent[1]).toContain('ASK WHERE {');
    expect(sent[1]).not.toContain('rdf:type');
  });

  test('a shape-scoped ASK still excludes a node of another type', async () => {
    if (!fusekiAvailable) return;
    // ASK drops the projection, not the rdf:type scan — Person.exists() still
    // means "exists as a Person". (Type-free existence is backlog 036.)
    const {spy, sent} = spyStore();
    expect(await Person.exists({id: `${ENT}dog1`}, spy)).toBe(false);
    expect(sent[0]).toContain('rdf:type');
  });
});

// ---------------------------------------------------------------------------
// Expression traversals in an `update().where()`.
//
// A golden alone would not have caught the defect these cover: the emitted
// SPARQL parsed and ran. Only counting what landed in the store shows it.
// ---------------------------------------------------------------------------

describe('coverage — update(expr).where() with a traversal', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  const hobbiesOf = async (id: string): Promise<string[]> => {
    const json = await executeSparqlQuery(
      `SELECT ?h WHERE { <${id}> <${PROP}hobby> ?h }`,
    );
    return json.results.bindings.map((b: any) => b.h.value).sort();
  };

  test('writes exactly one value, taken from the traversed node', async () => {
    if (!fusekiAvailable) return;
    // p2 ("Moa") has bestFriend p3 ("Jinx"). hobby is maxCount 1.
    await store.updateQuery(
      Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).where(
        (p: any) => p.name.equals('Moa'),
      ) as any,
    );
    expect(await hobbiesOf(`${ENT}p2`)).toEqual(['JINX']);
  });

  test('the traversal does not range over unrelated nodes', async () => {
    if (!fusekiAvailable) return;
    // The defect emitted the leaf property OPTIONAL before the edge bound its
    // subject, making it a cartesian product over every node with a name — so
    // p2 ended up with one hobby per named person in the store.
    await store.updateQuery(
      Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).where(
        (p: any) => p.name.equals('Moa'),
      ) as any,
    );
    const hobbies = await hobbiesOf(`${ENT}p2`);
    expect(hobbies).toHaveLength(1);
    for (const foreign of ['SEMMY', 'MOA', 'QUINN']) {
      expect(hobbies).not.toContain(foreign);
    }
  });

  test('a subject whose traversal edge is absent gets no value, and others are untouched', async () => {
    if (!fusekiAvailable) return;
    // p1 ("Semmy") has no bestFriend, so the computed value is unbound.
    await store.updateQuery(
      Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).where(
        (p: any) => p.name.equals('Semmy'),
      ) as any,
    );
    expect(await hobbiesOf(`${ENT}p1`)).toEqual([]);
    // p2 was never targeted — the where clause scopes the write.
    expect(await hobbiesOf(`${ENT}p2`)).toEqual(['Jogging']);
  });
});

