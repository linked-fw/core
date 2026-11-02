/**
 * Backlog 093: a filter below the first segment of a sort path or a projection keeps every
 * instance (an instance whose filtered path has no value sorts last); a quantifier on a cast
 * relation keeps its cast on the wire, as do condition and sort paths; a quantifier's condition is
 * never read against the outer shape; decode edges (an exists that is not the first operand, an
 * empty condition) and `not().not()` on a chained quantifier.
 */
import {describe, expect, test, beforeAll, afterAll} from '@jest/globals';
import {Person, Dog, Employee, tmpEntityBase, personClass, dogClass, employeeClass, propBase} from '../test-helpers/query-fixtures';
import {lower} from '../queries/lower';
import {fromJSON} from '../queries/fromJSON';
import {selectToSparql} from '../sparql/irToAlgebra';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import {decodeCondition} from '../queries/DslJsonExpression';
import {createNodeShapeData, createPropertyShapeData, type NodeShapeData} from '../shapes/nodeShapeData';
import {registerRuntimeShapes} from '../shapes/registerRuntimeShape';
import {SelectBuilder} from '../queries/QueryBuilder';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {createTestDataset, loadTestData, executeSparqlQuery, clearAllData} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const node = (
  id: string,
  o: {
    types?: string[];
    name?: string;
    hobby?: string;
    bestFriend?: string;
    friends?: string[];
    pets?: string[];
    level?: number;
    department?: string;
  },
) =>
  [
    ...(o.types ?? [personClass.id]).map((t) => `<${ENT}${id}> <${RDF_TYPE}> <${t}> .`),
    ...(o.name ? [`<${ENT}${id}> <${PROP}name> "${o.name}" .`] : []),
    ...(o.hobby ? [`<${ENT}${id}> <${PROP}hobby> "${o.hobby}" .`] : []),
    ...(o.bestFriend ? [`<${ENT}${id}> <${PROP}bestFriend> <${ENT}${o.bestFriend}> .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${PROP}hasFriend> <${ENT}${f}> .`),
    ...(o.pets ?? []).map((p) => `<${ENT}${id}> <${PROP}hasPet> <${ENT}${p}> .`),
    ...(o.level !== undefined ? [`<${ENT}${id}> <${PROP}guardDogLevel> "${o.level}"^^<http://www.w3.org/2001/XMLSchema#integer> .`] : []),
    ...(o.department ? [`<${ENT}${id}> <${PROP}employeeDepartment> "${o.department}" .`] : []),
  ].join('\n');

// Sort key `p.bestFriend.friends.where(f => not f.name = 'Dirk').hobby`:
//   anna → best friend Bob, his friends Carl (Chess) and Dirk (filtered out) → Chess
//   dirk → best friend Carl, his friend Anna (Golf) → Golf
//   carl → best friend Erik, his only friend is Dirk (filtered out) → missing
//   bob, erik → no best friend → missing
// Pets: Anna has Rex (Dog, level 2), Carl has Tom (Dog, level 1). Friends that are employees:
// Bob's friend Carl (Employee, R&D).
const DATA = [
  node('anna', {name: 'Anna', hobby: 'Golf', bestFriend: 'bob', pets: ['rex']}),
  node('bob', {name: 'Bob', friends: ['carl', 'dirk']}),
  node('carl', {
    types: [personClass.id, employeeClass.id],
    name: 'Carl',
    hobby: 'Chess',
    bestFriend: 'erik',
    friends: ['anna'],
    pets: ['tom'],
    department: 'R&D',
  }),
  node('dirk', {name: 'Dirk', hobby: 'Archery', bestFriend: 'carl'}),
  node('erik', {name: 'Erik', friends: ['dirk']}),
  node('rex', {types: [dogClass.id], level: 2}),
  node('tom', {types: [dogClass.id], level: 1}),
].join('\n');

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const jsonOf = (q: {toJSON(): unknown}) => JSON.parse(JSON.stringify(q.toJSON())) as Record<string, unknown>;
const roundTrip = (q: {toJSON(): unknown}) => fromJSON(jsonOf(q) as never);
const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
};
const ids = (rows: unknown) => (rows as ResultRow[]).map((r) => String(r.id).replace(ENT, ''));

// --- 1. A filter below the first segment --------------------------------------------------

const notDirk = (f: {name: {equals(v: string): {not(): unknown}}}) => f.name.equals('Dirk').not();
const byDeepFilter = (d: 'ASC' | 'DESC') =>
  Person.select((p) => p.name).orderBy((p) => p.bestFriend.friends.where(notDirk as never).hobby, d);

describe('a filter below the first segment of a sort path (lowering, wire)', () => {
  test('is supported: the hops above the filter are OPTIONAL, the filtered block nests in them', () => {
    const sparql = sparqlOf(byDeepFilter('ASC'));
    // The best-friend hop is not a required triple of the root pattern…
    expect(sparql).not.toMatch(/WHERE \{\s*\?a0 rdf:type <[^>]+> \.\s*\?a0 <[^>]*bestFriend> \?a1 \./);
    // …but the filter sits inside the OPTIONAL that binds it.
    expect(sparql).toMatch(/OPTIONAL \{\s*\?a0 <[^>]*bestFriend> \?a1 \.[\s\S]*OPTIONAL \{[\s\S]*hasFriend> \?a2 \.[\s\S]*FILTER/);
  });

  test('round-trips through DSL-JSON with whereIndex 1', () => {
    const q = byDeepFilter('DESC');
    expect((jsonOf(q).sortBy as unknown[])[0]).toEqual({
      'bestFriend.friends.hobby': {direction: 'DESC', where: {not: {name: 'Dirk'}}, whereIndex: 1},
    });
    expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });

  test('a wire whereIndex out of range is refused, not dropped', () => {
    for (const whereIndex of [3, 7, -1, 0.5]) {
      const json = {
        ...jsonOf(byDeepFilter('ASC')),
        sortBy: [{'bestFriend.friends.hobby': {direction: 'ASC', where: {name: 'Anna'}, whereIndex}}],
      };
      expect(() => sparqlOf(fromJSON(json as never))).toThrow(/whereIndex/);
    }
  });
});

describe('a filter below the first segment of a projection (lowering)', () => {
  test('keeps the instances without the hops above it', () => {
    const sparql = sparqlOf(Person.select((p) => p.bestFriend.friends.where(notDirk as never).name));
    expect(sparql).toMatch(/OPTIONAL \{\s*\?a0 <[^>]*bestFriend> \?a1 \.[\s\S]*FILTER/);
    expect(sparql).not.toMatch(/WHERE \{\s*\?a0 rdf:type <[^>]+> \.\s*\?a0 <[^>]*bestFriend> \?a1 \./);
  });
});

describe('filtered blocks under other parents (lowering, wire)', () => {
  test('a filtered child of a paginated nested select nests in its sub-SELECT block', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.friends.select((f) => f.friends.where((g) => g.name.equals('A')).name).limit(1)).for({
        id: `${ENT}anna`,
      }),
    );
    // One OPTIONAL holds the sub-SELECT and the filtered block: an empty window leaves ?a2 unbound.
    expect(sparql).toMatch(/OPTIONAL \{\s*\{\s*SELECT[\s\S]*LIMIT 1\s*\}\s*OPTIONAL \{[\s\S]*hasFriend> \?a2 \.[\s\S]*FILTER/);
  });

  test('a filter before a cast is kept (sort key and projection)', () => {
    const sort = sparqlOf(
      Person.select((p) => p.name).orderBy((p) => p.friends.where((f) => f.name.equals('A')).as(Employee).name),
    );
    expect(sort).toContain('FILTER(?a1_name = "A")');
    const field = sparqlOf(Person.select((p) => p.bestFriend.friends.where((f) => f.name.equals('A')).as(Employee).name));
    expect(field).toMatch(/FILTER\(\?a2_name = "A"\)/);
  });

  test('a wire field filter out of range is refused, not dropped', () => {
    for (const whereIndex of [2, 7, -1]) {
      const json = {...jsonOf(Person.select((p) => p.name)), fields: [{'friends.hobby': {where: {name: 'A'}, whereIndex}}]};
      expect(() => sparqlOf(fromJSON(json as never))).toThrow(/whereIndex/);
    }
  });

  test('a deep filter under a hop the where requires', () => {
    const q = Person.select((p) => p.bestFriend.friends.where(notDirk as never).name).where((p) => p.bestFriend.name.equals('Bob'));
    expect(sparqlOf(q)).toMatch(/\?a0 <[^>]*bestFriend> \?a1 \.[\s\S]*OPTIONAL \{[\s\S]*hasFriend> \?a2 \.[\s\S]*FILTER/);
  });
});

// --- 2. Casts on the wire ---------------------------------------------------------------

const dogLevel2 = () => Person.select((p) => p.name).where((p) => p.pets.as(Dog).some((d) => d.guardDogLevel.equals(2)));
const employeeFriend = () =>
  Person.select((p) => p.name).where((p) => p.friends.as(Employee).some((e) => e.department.equals('R&D')));

describe('a quantifier on a cast relation (wire)', () => {
  test('writes the cast on the relation key', () => {
    expect(jsonOf(dogLevel2()).where).toEqual({'pets.as(Dog).some': {guardDogLevel: 2}});
    expect(jsonOf(employeeFriend()).where).toEqual({'friends.as(Employee).some': {department: 'R&D'}});
  });

  test('round-trips (some, every, none, chained)', () => {
    const qs = [
      dogLevel2(),
      employeeFriend(),
      Person.select((p) => p.name).where((p) => p.pets.as(Dog).every((d) => d.guardDogLevel.equals(2))),
      Person.select((p) => p.name).where((p) => p.pets.as(Dog).none((d) => d.guardDogLevel.equals(2))),
      Person.select((p) => p.name).where((p) =>
        p.pets.as(Dog).some((d) => d.guardDogLevel.equals(2)).and(p.name.equals('Anna')),
      ),
    ];
    for (const q of qs) expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });

  test('a relation without a cast writes none', () => {
    expect(jsonOf(Person.select((p) => p.name).where((p) => p.friends.some((f) => f.name.equals('A')))).where).toEqual({
      'friends.some': {name: 'A'},
    });
  });

  test('an unknown cast label is refused', () => {
    const json = {...jsonOf(dogLevel2()), where: {'pets.as(Cat).some': {guardDogLevel: 2}}};
    expect(() => fromJSON(json as never)).toThrow(/Cat/);
  });
});

describe('casts in condition and sort paths (wire)', () => {
  test('a where path through a cast round-trips', () => {
    const q = Person.select((p) => p.name).where((p) => p.firstPet.as(Dog).guardDogLevel.equals(2));
    expect(jsonOf(q).where).toEqual({'firstPet.as(Dog).guardDogLevel': 2});
    expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });

  test('a sort path through a cast round-trips', () => {
    const q = Person.select((p) => p.name).orderBy((p) => p.firstPet.as(Dog).guardDogLevel, 'DESC');
    expect(jsonOf(q).sortBy).toEqual([{'firstPet.as(Dog).guardDogLevel': 'DESC'}]);
    expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
  });
});

// --- 3. The member shape of a quantifier's condition -----------------------------------

const NS = 'https://example.org/sort-filter-depth/';
const CLUB = `${NS}shape/Club`;
const MEMBER = `${NS}shape/Member`;
const vocab = (term: string) => ({id: `${NS}vocab#${term}`});
function dataShape(id: string, targetClass: string, props: Array<Record<string, unknown>>): NodeShapeData {
  const shape = createNodeShapeData(id);
  shape.label = id.split('/').pop()!;
  shape.targetClass = vocab(targetClass);
  shape.propertyShapes = props.map((p) => {
    const prop = createPropertyShapeData();
    Object.assign(prop, {id: `${id}/${p.label}`, parentNodeShape: shape, ...p});
    return prop;
  });
  return shape;
}
let clubShape: NodeShapeData;

describe('a quantifier condition on a relation (wire decode)', () => {
  beforeAll(() => {
    const member = dataShape(MEMBER, 'Member', [{label: 'rank', path: vocab('rank'), datatype: xsd.string, maxCount: 1}]);
    clubShape = dataShape(CLUB, 'Club', [
      {label: 'rank', path: vocab('clubRank'), datatype: xsd.string, maxCount: 1},
      {label: 'leads', path: vocab('lead'), class: vocab('Member'), nodeKind: shacl.IRI},
      {label: 'sponsors', path: vocab('sponsor'), class: vocab('Unshaped'), nodeKind: shacl.IRI},
    ]);
    registerRuntimeShapes([member, clubShape]);
  });

  test('a relation declared with sh:class only reads its condition on the shape targeting the class', () => {
    const sparql = sparqlOf(SelectBuilder.from(CLUB).where((decodeCondition({'leads.some': {rank: 'A'}}, clubShape) as {existsCondition: never}).existsCondition));
    expect(sparql).toContain(`<${NS}vocab#rank>`);
    expect(sparql).not.toContain(`<${NS}vocab#clubRank>`);
  });

  test('a relation with no member shape never binds a same-label property of the outer shape', () => {
    expect(() => decodeCondition({'sponsors.some': {rank: 'A'}}, clubShape)).toThrow(/rank/);
    // equals on the member itself still works.
    expect(() => decodeCondition({'sponsors.some': {'': {'@id': `${NS}m1`}}}, clubShape)).not.toThrow();
  });
});

// --- 4. Decode edges, not().not() ----------------------------------------------------------

describe('decode edges', () => {
  test('a quantifier that is not the first operand of and/or', () => {
    for (const op of ['and', 'or'] as const) {
      const json = {...jsonOf(Person.select((p) => p.name)), where: {[op]: [{name: 'Bob'}, {'friends.some': {name: 'Carl'}}]}};
      const sparql = sparqlOf(fromJSON(json as never));
      expect(sparql).toContain('EXISTS');
      expect(sparql).toContain('"Bob"');
    }
  });

  test('an empty condition is refused, never an empty FILTER()', () => {
    const base = jsonOf(Person.select((p) => p.name));
    for (const where of [{'pets.none': {}}, {}]) {
      expect(() => sparqlOf(fromJSON({...base, where} as never))).toThrow(/empty condition/);
    }
  });

  test('not().not() on a chained quantifier is the condition itself', () => {
    const once = Person.select((p) => p.name).where((p) =>
      p.friends.some((f) => f.name.equals('Carl')).and(p.name.equals('Bob')),
    );
    const twice = Person.select((p) => p.name).where((p) =>
      p.friends.some((f) => f.name.equals('Carl')).and(p.name.equals('Bob')).not().not(),
    );
    expect(sparqlOf(twice)).toBe(sparqlOf(once));
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

describeFuseki('sort filter depth and quantifier casts', () => {
  test('deep filtered sort key, unpaged: ASC Anna (Chess), Dirk (Golf), DESC Dirk, Anna; the rest kept, last', async () => {
    const asc = ids(await run(byDeepFilter('ASC')));
    expect(asc.slice(0, 2)).toEqual(['anna', 'dirk']);
    expect(asc.slice(2).sort()).toEqual(['bob', 'carl', 'erik']);
    const desc = ids(await run(byDeepFilter('DESC')));
    expect(desc.slice(0, 2)).toEqual(['dirk', 'anna']);
    expect(desc.slice(2).sort()).toEqual(['bob', 'carl', 'erik']);
  });

  test('deep filtered sort key, paged: missing last, by IRI', async () => {
    const page = (d: 'ASC' | 'DESC', offset: number) => byDeepFilter(d).limit(3).offset(offset);
    expect([...ids(await run(page('ASC', 0))), ...ids(await run(page('ASC', 3)))]).toEqual(['anna', 'dirk', 'bob', 'carl', 'erik']);
    expect([...ids(await run(page('DESC', 0))), ...ids(await run(page('DESC', 3)))]).toEqual(['dirk', 'anna', 'bob', 'carl', 'erik']);
  });

  test('deep filtered sort key through DSL-JSON', async () => {
    expect(ids(await run(roundTrip(byDeepFilter('ASC').limit(5))))).toEqual(['anna', 'dirk', 'bob', 'carl', 'erik']);
  });

  test('deep filtered projection keeps every person', async () => {
    const rows = (await run(Person.select((p) => p.bestFriend.friends.where(notDirk as never).name))) as ResultRow[];
    expect(ids(rows).sort()).toEqual(['anna', 'bob', 'carl', 'dirk', 'erik']);
    const anna = rows.find((r) => String(r.id).endsWith('anna'))!;
    expect(ids((anna.bestFriend as ResultRow).friends)).toEqual(['carl']);
  });

  test('a deep filter under a hop the where requires: Anna only', async () => {
    const q = Person.select((p) => p.bestFriend.friends.where(notDirk as never).name).where((p) => p.bestFriend.name.equals('Bob'));
    expect(ids(await run(q))).toEqual(['anna']);
  });

  test('a quantifier on a cast relation, through DSL-JSON', async () => {
    expect(ids(await run(roundTrip(dogLevel2())))).toEqual(['anna']);
    expect(ids(await run(roundTrip(employeeFriend())))).toEqual(['bob']);
  });
});
