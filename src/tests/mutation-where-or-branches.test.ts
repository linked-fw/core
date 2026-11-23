/**
 * Backlog 113: a delete or update where requires only what the filter needs in every `||` branch.
 * A property or traversal only some branches read, or one `isNotDefined()` reads, is OPTIONAL, so
 * a subject without it still matches (it used to be skipped: fewer subjects changed than should).
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {Person, tmpEntityBase, personClass, propBase} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {deleteWhereToSparql, updateWhereToSparql} from '../sparql/irToAlgebra';
import type {IRDeleteWhereMutation, IRUpdateWhereMutation} from '../queries/IntermediateRepresentation';
import {
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const node = (id: string, o: {name?: string; hobby?: string; bestFriend?: string}) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`,
    ...(o.name ? [`<${ENT}${id}> <${PROP}name> "${o.name}" .`] : []),
    ...(o.hobby ? [`<${ENT}${id}> <${PROP}hobby> "${o.hobby}" .`] : []),
    ...(o.bestFriend ? [`<${ENT}${id}> <${PROP}bestFriend> <${ENT}${o.bestFriend}> .`] : []),
  ].join('\n');

// bob: no best friend, no hobby. carl: best friend ann (Golf), no hobby. ann: Golf, no best
// friend. erik: Chess, best friend carl (no hobby). dirk: nothing.
const DATA = [
  node('bob', {name: 'Bob'}),
  node('carl', {name: 'Carl', bestFriend: 'ann'}),
  node('ann', {name: 'Anna', hobby: 'Golf'}),
  node('erik', {name: 'Erik', hobby: 'Chess', bestFriend: 'carl'}),
  node('dirk', {}),
].join('\n');

const deleteSparql = async (q: () => unknown) =>
  deleteWhereToSparql((await captureQuery(q as never)) as IRDeleteWhereMutation);
const updateSparql = async (q: () => unknown) =>
  updateWhereToSparql((await captureQuery(q as never)) as IRUpdateWhereMutation);

const bobOrGolfBestFriend = () =>
  (Person as any).deleteWhere((p: any) => p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf')));
const withoutHobby = () => (Person as any).deleteWhere((p: any) => p.hobby.isNotDefined());
const bobOrGolferJogs = () =>
  (Person as any).update({hobby: 'Jog'}).where((p: any) => p.name.equals('Bob').or(p.hobby.equals('Golf')));
const hobbylessJog = () => (Person as any).update({hobby: 'Jog'}).where((p: any) => p.hobby.isNotDefined());

describe('a mutation where with || or isNotDefined()', () => {
  test('a traversal only one branch reads is an OPTIONAL subtree', async () => {
    const sparql = await deleteSparql(bobOrGolfBestFriend);
    expect(sparql).toMatch(/OPTIONAL \{\n {4}\?a0 <[^>]*bestFriend> \?a1 \.\n {4}OPTIONAL \{\n {6}\?a1 <[^>]*hobby> \?a1_hobby \./);
    expect(sparql).not.toMatch(/^ {2}\?a0 <[^>]*bestFriend>/m);
  });

  test('isNotDefined() reads its property OPTIONAL, in a delete and an update', async () => {
    for (const sparql of [await deleteSparql(withoutHobby), await updateSparql(hobbylessJog)]) {
      expect(sparql).toMatch(/OPTIONAL \{\n {4}\?a0 <[^>]*hobby> \?a0_hobby \.\n {2}\}\n {2}FILTER\(!\(BOUND\(\?a0_hobby\)\)\)/);
    }
  });

  test('a conjunction keeps every triple required', async () => {
    const sparql = await deleteSparql(() =>
      (Person as any).deleteWhere((p: any) => p.name.equals('Carl').and(p.bestFriend.hobby.equals('Golf'))),
    );
    expect(sparql).not.toContain('OPTIONAL');
  });
});

const people = async (): Promise<string[]> => {
  const res = await executeSparqlQuery(
    `SELECT ?s ?h WHERE { ?s a <${personClass.id}> OPTIONAL { ?s <${PROP}hobby> ?h } } ORDER BY ?s`,
  );
  return res.results.bindings.map((b: any) => b.s.value.replace(ENT, '') + (b.h ? `=${b.h.value}` : ''));
};

beforeAll(async () => {
  if (fusekiLive) await createTestDataset();
}, 30000);

beforeEach(async () => {
  if (!fusekiLive) return;
  await clearAllData();
  await loadTestData(DATA);
});

afterAll(async () => {
  if (fusekiLive) await clearAllData();
});

describeFuseki('a mutation where with || or isNotDefined() changes exactly the right subjects', () => {
  test('delete: bob (no best friend) by name, carl through his best friend', async () => {
    await executeSparqlUpdate(await deleteSparql(bobOrGolfBestFriend));
    expect(await people()).toEqual(['ann=Golf', 'dirk', 'erik=Chess']);
  });

  test('delete: every person without a hobby', async () => {
    await executeSparqlUpdate(await deleteSparql(withoutHobby));
    expect(await people()).toEqual(['ann=Golf', 'erik=Chess']);
  });

  test('update: bob (no hobby) by name, ann by her hobby', async () => {
    await executeSparqlUpdate(await updateSparql(bobOrGolferJogs));
    expect(await people()).toEqual(['ann=Jog', 'bob=Jog', 'carl', 'dirk', 'erik=Chess']);
  });

  test('update: every person without a hobby', async () => {
    await executeSparqlUpdate(await updateSparql(hobbylessJog));
    expect(await people()).toEqual(['ann=Golf', 'bob=Jog', 'carl=Jog', 'dirk=Jog', 'erik=Chess']);
  });
});
