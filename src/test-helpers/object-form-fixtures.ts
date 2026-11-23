/**
 * The object form of select, case by case: each select as a user writes it, the dataset the
 * cases run on, and the rows they answer (report 121, the contract of plan 006 step S8).
 *
 * Dataset: p1 Semmy (hobby Chess, best friend p2, friends p2 and p3); p2 Moa (hobby Golf, best
 * friend p3, friend p3); p3 Jinx (no hobby, no best friend, no friends).
 *
 * `object-form-rows.test.ts` maps recorded store answers (`fixtures/object-form-rows.bindings.json`,
 * recorded on oxigraph from the SPARQL these selects lower to) and, in its `[fuseki]` block, runs
 * them live; both compare with `objectFormRows`.
 */
import {Person, tmpEntityBase, personClass, propBase} from './query-fixtures';
import type {ResultRow} from '../queries/IntermediateRepresentation';

const ENT = tmpEntityBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const person = (id: string, o: {name?: string; hobby?: string; bf?: string; friends?: string[]}) =>
  [
    `<${ENT}${id}> <${RDF_TYPE}> <${personClass.id}> .`,
    ...(o.name ? [`<${ENT}${id}> <${propBase}name> "${o.name}" .`] : []),
    ...(o.hobby ? [`<${ENT}${id}> <${propBase}hobby> "${o.hobby}" .`] : []),
    ...(o.bf ? [`<${ENT}${id}> <${propBase}bestFriend> <${ENT}${o.bf}> .`] : []),
    ...(o.friends ?? []).map((f) => `<${ENT}${id}> <${propBase}hasFriend> <${ENT}${f}> .`),
  ].join('\n');

/** N-Triples of the dataset. */
export const objectFormData = [
  person('p1', {name: 'Semmy', hobby: 'Chess', bf: 'p2', friends: ['p2', 'p3']}),
  person('p2', {name: 'Moa', hobby: 'Golf', bf: 'p3', friends: ['p3']}),
  person('p3', {name: 'Jinx'}),
].join('\n');

/** A component whose query selects a name, as a linked component's would. */
export const nameCard = {query: Person.select((p) => ({name: p.name}))};

const isMoa = (f: any) => f.name.equals('Moa');

/** The selects, by case name. */
export const objectFormCases = {
  n: () => Person.select((p) => ({n: p.bestFriend.name})),
  bb: () => Person.select((p) => ({bb: p.bestFriend.bestFriend})),
  names: () => Person.select((p) => ({names: p.friends.name})),
  fbf: () => Person.select((p) => ({fbf: p.friends.bestFriend.name})),
  fb: () => Person.select((p) => ({fb: p.friends.bestFriend})),
  xFriends: () => Person.select((p) => ({x: p.friends.select((f) => ({bf: f.bestFriend, n: f.name}))})),
  xFriendsArray: () => Person.select((p) => ({x: p.friends.select((f) => f.name)})),
  xBestFriend: () => Person.select((p) => ({x: p.bestFriend.select((b) => ({n: b.name}))})),
  w: () => Person.select((p) => ({w: p.friends.where(isMoa)})),
  wName: () => Person.select((p) => ({w: p.friends.where(isMoa).name})),
  pre: () => Person.select((p) => ({pre: p.bestFriend.preloadFor(nameCard)})),
  preFriends: () => Person.select((p) => ({pre: p.friends.preloadFor(nameCard)})),
  person: () => Person.select((p) => ({person: p})),
  nAndB: () => Person.select((p) => ({n: p.bestFriend.name, b: p.bestFriend})),
  subSize: () => Person.select((p) => ({x: p.friends.select((f) => ({c: f.friends.size()}))})),
  subSizeArray: () => Person.select((p) => p.friends.select((f) => ({c: f.friends.size()}))),
  subSizeThroughHop: () => Person.select((p) => p.friends.select((f) => [f.name, f.bestFriend.friends.size()])),
  subSizeFiltered: () =>
    Person.select((p) => p.friends.select((f) => [f.name, f.friends.where((g) => g.name.equals('Jinx')).size()])),
  subExpr: () => Person.select((p) => ({x: p.friends.select((f) => ({e: f.name.equals('Moa')}))})),
  deepSub: () =>
    Person.select((p) => ({x: p.friends.select((f) => ({y: f.bestFriend.select((b) => ({n: b.name}))}))})),
  twoSubsOneRelation: () =>
    Person.select((p) => ({x: p.bestFriend.select((b) => ({n: b.name})), y: p.bestFriend.select((b) => ({h: b.hobby}))})),
  preloadBeside: () => Person.select((p) => ({n: p.hobby})).preload('bestFriend', nameCard),
  allAndCarls: () =>
    Person.select((p) => ({all: p.friends.name, moaHobby: p.friends.where(isMoa).hobby})),
  twoFilters: () =>
    Person.select((p) => ({a: p.friends.where(isMoa), b: p.friends.where((f) => f.name.equals('Jinx'))})),
  one: () => Person.select((p) => ({n: p.bestFriend.name})).where((p) => p.name.equals('Semmy')).one(),
  forP1: () => Person.select((p) => ({names: p.friends.name})).for({id: `${ENT}p1`}),
};

export type ObjectFormCase = keyof typeof objectFormCases;

const id = (local: string) => ({id: `${ENT}${local}`});
const p1 = `${ENT}p1`;
const p2 = `${ENT}p2`;
const p3 = `${ENT}p3`;

/**
 * The rows each case answers, sorted by id (a list: rows; one row: `.one()` / `.for()`). Values of
 * a multi-valued field are compared as sets (see `normalizeRows`).
 */
export const objectFormRows: Record<ObjectFormCase, ResultRow[] | ResultRow | null> = {
  n: [{id: p1, n: 'Moa'}, {id: p2, n: 'Jinx'}, {id: p3, n: null}],
  bb: [{id: p1, bb: id('p3')}, {id: p2, bb: null}, {id: p3, bb: null}],
  names: [{id: p1, names: ['Jinx', 'Moa']}, {id: p2, names: ['Jinx']}, {id: p3, names: []}],
  fbf: [{id: p1, fbf: ['Jinx']}, {id: p2, fbf: []}, {id: p3, fbf: []}],
  fb: [{id: p1, fb: [id('p3')]}, {id: p2, fb: []}, {id: p3, fb: []}],
  xFriends: [
    {id: p1, x: [{id: p2, bf: id('p3'), n: 'Moa'}, {id: p3, bf: null, n: 'Jinx'}]},
    {id: p2, x: [{id: p3, bf: null, n: 'Jinx'}]},
    {id: p3, x: []},
  ],
  xFriendsArray: [
    {id: p1, x: [{id: p2, name: 'Moa'}, {id: p3, name: 'Jinx'}]},
    {id: p2, x: [{id: p3, name: 'Jinx'}]},
    {id: p3, x: []},
  ],
  xBestFriend: [{id: p1, x: {id: p2, n: 'Moa'}}, {id: p2, x: {id: p3, n: 'Jinx'}}, {id: p3, x: null}],
  w: [{id: p1, w: [id('p2')]}, {id: p2, w: []}, {id: p3, w: []}],
  wName: [{id: p1, w: ['Moa']}, {id: p2, w: []}, {id: p3, w: []}],
  pre: [{id: p1, pre: {id: p2, name: 'Moa'}}, {id: p2, pre: {id: p3, name: 'Jinx'}}, {id: p3, pre: null}],
  preFriends: [
    {id: p1, pre: [{id: p2, name: 'Moa'}, {id: p3, name: 'Jinx'}]},
    {id: p2, pre: [{id: p3, name: 'Jinx'}]},
    {id: p3, pre: []},
  ],
  person: [{id: p1, person: id('p1')}, {id: p2, person: id('p2')}, {id: p3, person: id('p3')}],
  nAndB: [{id: p1, n: 'Moa', b: id('p2')}, {id: p2, n: 'Jinx', b: id('p3')}, {id: p3, n: null, b: null}],
  subSize: [
    {id: p1, x: [{id: p2, c: 1}, {id: p3, c: 0}]},
    {id: p2, x: [{id: p3, c: 0}]},
    {id: p3, x: []},
  ],
  subSizeArray: [
    {id: p1, friends: [{id: p2, c: 1}, {id: p3, c: 0}]},
    {id: p2, friends: [{id: p3, c: 0}]},
    {id: p3, friends: []},
  ],
  subSizeThroughHop: [
    {id: p1, friends: [{id: p2, name: 'Moa', friends: 0}, {id: p3, name: 'Jinx', friends: 0}]},
    {id: p2, friends: [{id: p3, name: 'Jinx', friends: 0}]},
    {id: p3, friends: []},
  ],
  subSizeFiltered: [
    {id: p1, friends: [{id: p2, name: 'Moa', friends: 1}, {id: p3, name: 'Jinx', friends: 0}]},
    {id: p2, friends: [{id: p3, name: 'Jinx', friends: 0}]},
    {id: p3, friends: []},
  ],
  subExpr: [
    {id: p1, x: [{id: p2, e: true}, {id: p3, e: false}]},
    {id: p2, x: [{id: p3, e: false}]},
    {id: p3, x: []},
  ],
  deepSub: [
    {id: p1, x: [{id: p2, y: {id: p3, n: 'Jinx'}}, {id: p3, y: null}]},
    {id: p2, x: [{id: p3, y: null}]},
    {id: p3, x: []},
  ],
  twoSubsOneRelation: [
    {id: p1, x: {id: p2, n: 'Moa'}, y: {id: p2, h: 'Golf'}},
    {id: p2, x: {id: p3, n: 'Jinx'}, y: {id: p3, h: null}},
    {id: p3, x: null, y: null},
  ],
  preloadBeside: [
    {id: p1, n: 'Chess', bestFriend: {id: p2, name: 'Moa'}},
    {id: p2, n: 'Golf', bestFriend: {id: p3, name: 'Jinx'}},
    {id: p3, n: null, bestFriend: null},
  ],
  allAndCarls: [
    {id: p1, all: ['Jinx', 'Moa'], moaHobby: ['Golf']},
    {id: p2, all: ['Jinx'], moaHobby: []},
    {id: p3, all: [], moaHobby: []},
  ],
  twoFilters: [
    {id: p1, a: [id('p2')], b: [id('p3')]},
    {id: p2, a: [], b: [id('p3')]},
    {id: p3, a: [], b: []},
  ],
  one: {id: p1, n: 'Moa'},
  forP1: {id: p1, names: ['Jinx', 'Moa']},
};

/**
 * Rows in a comparable order: keys sorted, and every array (rows, multi-valued fields, member
 * rows) sorted, since a store returns them in any order.
 */
export const normalizeRows = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeRows).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalizeRows(v)]),
    );
  }
  return value;
};
