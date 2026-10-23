import {describe, expect, test, beforeAll} from '@jest/globals';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {existsFactories} from '../test-helpers/query-fixtures';
import {entity, captureDslIR, sanitize} from '../test-helpers/test-utils';
import {QueryBuilder} from '../queries/QueryBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {walkPropertyPath} from '../queries/PropertyPath';
import {FieldSet} from '../queries/FieldSet';
import {setQueryContext, getQueryContext, PendingQueryContext, UnresolvedContextError} from '../queries/QueryContext';
import {lower} from '../queries/lower';
import {resolveExistence} from '../queries/queryDispatch';
import {Shape} from '../shapes/Shape';

const personShape = Person.shape;

beforeAll(() => {
  setQueryContext('user', {id: 'user-1'}, Person);
});

// =============================================================================
// Immutability tests
// =============================================================================

describe('QueryBuilder — immutability', () => {
  test('.where() returns new instance', () => {
    const b1 = QueryBuilder.from(Person).select((p) => p.name);
    const b2 = b1.where((p) => p.name.equals('Semmy'));
    expect(b1).not.toBe(b2);
  });

  test('.limit() returns new instance', () => {
    const b1 = QueryBuilder.from(Person).select((p) => p.name);
    const b2 = b1.limit(10);
    expect(b1).not.toBe(b2);
  });

  test('.select() returns new instance', () => {
    const b1 = QueryBuilder.from(Person);
    const b2 = b1.select((p) => p.name);
    expect(b1).not.toBe(b2);
  });

  test('chaining preserves prior state', () => {
    const b1 = QueryBuilder.from(Person).select((p) => p.name);
    const b2 = b1.limit(5);
    const b3 = b1.limit(10);
    expect(b2).not.toBe(b3);
    // b2 and b3 should produce different IRs since they have different limits
    const ir2 = lower(b2);
    const ir3 = lower(b3);
    expect(ir2.limit).toBe(5);
    expect(ir3.limit).toBe(10);
  });

  test('.orderBy() returns new instance', () => {
    const b1 = QueryBuilder.from(Person).select((p) => p.name);
    const b2 = b1.orderBy((p) => p.name);
    expect(b1).not.toBe(b2);
  });

  test('.for() returns new instance', () => {
    const b1 = QueryBuilder.from(Person).select((p) => p.name);
    const b2 = b1.for(entity('p1'));
    expect(b1).not.toBe(b2);
  });

  test('.one() returns new instance', () => {
    const b1 = QueryBuilder.from(Person).select((p) => p.name);
    const b2 = b1.one();
    expect(b1).not.toBe(b2);
  });
});

// =============================================================================
// IR equivalence tests — QueryBuilder must produce identical IR to DSL
// =============================================================================

describe('QueryBuilder — IR equivalence with DSL', () => {
  test('selectName', async () => {
    const dslIR = await captureDslIR(() => Person.select((p) => p.name));
    const builderIR = lower(QueryBuilder.from(Person).select((p) => p.name));
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('selectMultiplePaths', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => [p.name, p.friends, p.bestFriend.name]),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => [p.name, p.friends, p.bestFriend.name])
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('selectFriendsName', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.friends.name),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.friends.name)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('selectDeepNested', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.friends.bestFriend.bestFriend.name),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.friends.bestFriend.bestFriend.name)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('whereFriendsNameEquals', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.friends.where((f) => f.name.equals('Moa'))),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.friends.where((f) => f.name.equals('Moa')))
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('whereAnd', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) =>
        p.friends.where((f) =>
          f.name.equals('Moa').and(f.hobby.equals('Jogging')),
        ),
      ),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) =>
        p.friends.where((f) =>
          f.name.equals('Moa').and(f.hobby.equals('Jogging')),
        ),
      )
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('selectById', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.name).for(entity('p1')),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.name)
      .for(entity('p1'))
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('outerWhereLimit', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.name)
        .where((p) => p.name.equals('Semmy').or(p.name.equals('Moa')))
        .limit(1),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.name)
      .where((p) => p.name.equals('Semmy').or(p.name.equals('Moa')))
      .limit(1)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('sortByAsc', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.name).orderBy((p) => p.name),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.name)
      .orderBy((p) => p.name)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('countFriends', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.friends.size()),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.friends.size())
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('subSelectPluralCustom', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) =>
        p.friends.select((f) => ({name: f.name, hobby: f.hobby})),
      ),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) =>
        p.friends.select((f) => ({name: f.name, hobby: f.hobby})),
      )
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('selectAllProperties', async () => {
    const dslIR = await captureDslIR(() => Person.selectAll());
    const builderIR = lower(QueryBuilder.from(Person).selectAll());
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });
});

// =============================================================================
// walkPropertyPath tests
// =============================================================================

describe('walkPropertyPath', () => {
  test('single segment', () => {
    const path = walkPropertyPath(personShape, 'name');
    expect(path.segments.length).toBe(1);
    expect(path.terminal.label).toBe('name');
    expect(path.toString()).toBe('name');
  });

  test('nested segments', () => {
    const path = walkPropertyPath(personShape, 'friends.name');
    expect(path.segments.length).toBe(2);
    expect(path.segments[0].label).toBe('friends');
    expect(path.segments[1].label).toBe('name');
    expect(path.toString()).toBe('friends.name');
  });

  test('deeply nested', () => {
    const path = walkPropertyPath(personShape, 'bestFriend.bestFriend.name');
    expect(path.segments.length).toBe(3);
    expect(path.toString()).toBe('bestFriend.bestFriend.name');
  });

  test('invalid segment throws', () => {
    expect(() => walkPropertyPath(personShape, 'nonexistent')).toThrow(
      /not found/,
    );
  });

  test('traversal through non-object property throws', () => {
    expect(() => walkPropertyPath(personShape, 'name.something')).toThrow(
      /no valueShape/,
    );
  });
});

// =============================================================================
// Shape resolution test
// =============================================================================

describe('QueryBuilder — shape resolution', () => {
  test('from() with shape class', () => {
    const ir = lower(QueryBuilder.from(Person).select((p) => p.name));
    expect(ir.kind).toBe('select');
    expect(ir.root.kind).toBe('shape_scan');
  });

  test('from() with string IRI', () => {
    const shapeId = personShape.id;
    const ir = lower(QueryBuilder.from(shapeId).select((p: any) => p.name));
    expect(ir.kind).toBe('select');
  });
});

// =============================================================================
// PromiseLike test
// =============================================================================

describe('QueryBuilder — PromiseLike', () => {
  test('has .then() method', () => {
    const builder = QueryBuilder.from(Person).select((p) => p.name);
    expect(typeof builder.then).toBe('function');
  });

  test('is thenable (await triggers execution)', async () => {
    const result = await QueryBuilder.from(Person).select((p) => p.name);
    // captureStore returns [] for select queries
    expect(result).toEqual([]);
  });
});

// =============================================================================
// Preload tests (Phase 5)
// B2 fix: removed duplicate ".preload() IR matches DSL preloadFor" test.
// TQ2 fix: strengthened preload assertions to verify actual preload structure.
// =============================================================================

describe('QueryBuilder — preload', () => {
  const componentBuilder = QueryBuilder.from(Person).select((p: any) => ({name: p.name}));
  const componentLike = {query: componentBuilder};

  test('.preload() returns new instance', () => {
    const b1 = QueryBuilder.from(Person).select((p) => [p.name]);
    const b2 = b1.preload('bestFriend', componentLike);
    expect(b1).not.toBe(b2);
  });

  test('.preload() produces same IR as DSL preloadFor', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => [p.name, p.bestFriend.preloadFor(componentLike)]),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .preload('bestFriend', componentLike)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('.preload() with FieldSet-based component includes preload projections', async () => {
    const componentFieldSet = FieldSet.for(personShape, ['name']);
    const componentLikeFieldSet = {query: componentFieldSet, fields: componentFieldSet};

    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .preload('bestFriend', componentLikeFieldSet)
      );
    expect(builderIR.kind).toBe('select');
    // Should have the base 'name' projection + at least one preload projection
    expect(builderIR.projection.length).toBeGreaterThanOrEqual(2);
  });

  test('DSL preloadFor with QueryBuilder component produces valid IR', async () => {
    const componentBuilder = QueryBuilder.from(Person).select((p: any) => ({name: p.name}));
    const componentLikeBuilder = {query: componentBuilder};

    const ir = await captureQuery(() =>
      Person.select((p) => p.bestFriend.preloadFor(componentLikeBuilder)),
    );
    expect(ir.kind).toBe('select');
    expect(ir.projection.length).toBeGreaterThanOrEqual(1);
  });

  test('DSL preloadFor with FieldSet component produces valid IR', async () => {
    const componentFieldSet = FieldSet.for(personShape, ['name']);
    const componentLikeFieldSet = {query: componentFieldSet, fields: componentFieldSet};

    const ir = await captureQuery(() =>
      Person.select((p) => p.bestFriend.preloadFor(componentLikeFieldSet)),
    );
    expect(ir.kind).toBe('select');
    expect(ir.projection.length).toBeGreaterThanOrEqual(1);
  });

  test('fields() returns FieldSet for use by pipeline', () => {
    const builder = QueryBuilder.from(Person).select((p) => [p.name]);
    const fs = builder.fields();
    expect(fs).toBeDefined();
    expect(fs!.entries.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// forAll — multi-ID subject filtering
// =============================================================================

describe('QueryBuilder — forAll', () => {
  test('forAll([id1, id2]) produces IR with subjectIds', () => {
    const ir = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .forAll([`${tmpEntityBase}p1`, `${tmpEntityBase}p2`])
      );
    expect(ir.subjectIds).toHaveLength(2);
    expect(ir.subjectIds).toContain(`${tmpEntityBase}p1`);
    expect(ir.subjectIds).toContain(`${tmpEntityBase}p2`);
  });

  test('forAll() without IDs produces no subject filter', () => {
    const ir = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .forAll()
      );
    expect(ir.subjectId).toBeUndefined();
    expect(ir.subjectIds).toBeUndefined();
  });

  test('for(id) after forAll(ids) clears multi-subject', () => {
    const ir = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .forAll([`${tmpEntityBase}p1`, `${tmpEntityBase}p2`])
      .for(`${tmpEntityBase}p3`)
      );
    expect(ir.subjectId).toBe(`${tmpEntityBase}p3`);
    expect(ir.subjectIds).toBeUndefined();
  });

  test('forAll(ids) after for(id) clears single subject', () => {
    const ir = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .for(`${tmpEntityBase}p1`)
      .forAll([`${tmpEntityBase}p2`, `${tmpEntityBase}p3`])
      );
    expect(ir.subjectId).toBeUndefined();
    expect(ir.subjectIds).toHaveLength(2);
  });

  test('forAll() returns new instance (immutability)', () => {
    const base = QueryBuilder.from(Person).select((p) => [p.name]);
    const withForAll = base.forAll([`${tmpEntityBase}p1`]);
    expect(base).not.toBe(withForAll);
    // Original has no subjects
    expect(lower(base).subjectIds).toBeUndefined();
  });

  test('forAll accepts {id} references', () => {
    const ir = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .forAll([{id: `${tmpEntityBase}p1`}, `${tmpEntityBase}p2`])
      );
    expect(ir.subjectIds).toHaveLength(2);
    expect(ir.subjectIds).toContain(`${tmpEntityBase}p1`);
    expect(ir.subjectIds).toContain(`${tmpEntityBase}p2`);
  });
});

// =============================================================================
// Phase 8: Direct IR generation tests
// TQ3 fix: strengthened sub-select test to verify actual structure.
// =============================================================================

describe('QueryBuilder — direct IR generation', () => {
  test('FieldSet select produces same IR as callback select', () => {
    const fs = FieldSet.for(Person, ['name', 'hobby']);
    const fieldSetIR = lower(QueryBuilder.from(Person).select(fs));
    const callbackIR = lower(QueryBuilder.from(Person).select((p) => [p.name, p.hobby]));
    expect(sanitize(fieldSetIR)).toEqual(sanitize(callbackIR));
  });

  test('FieldSet select with where produces same IR as callback', () => {
    const fs = FieldSet.for(Person, ['name']);
    const fieldSetIR = lower(QueryBuilder.from(Person)
      .select(fs)
      .where((p) => p.name.equals('Semmy'))
      );
    const callbackIR = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .where((p) => p.name.equals('Semmy'))
      );
    expect(sanitize(fieldSetIR)).toEqual(sanitize(callbackIR));
  });

  test('FieldSet select with orderBy produces same IR as callback', () => {
    const fs = FieldSet.for(Person, ['name']);
    const fieldSetIR = lower(QueryBuilder.from(Person)
      .select(fs)
      .orderBy((p) => p.name, 'DESC')
      );
    const callbackIR = lower(QueryBuilder.from(Person)
      .select((p) => [p.name])
      .orderBy((p) => p.name, 'DESC')
      );
    expect(sanitize(fieldSetIR)).toEqual(sanitize(callbackIR));
  });

  test('selectAll uses direct path (no buildFactory)', () => {
    const ir = lower(QueryBuilder.from(Person).selectAll().limit(5));
    expect(ir.projection.length).toBeGreaterThan(0);
    expect(ir.limit).toBe(5);
  });

  test('label-based select uses direct path', () => {
    const ir = lower(QueryBuilder.from(Person).select(['name', 'hobby']).limit(10));
    expect(ir.projection.length).toBe(2);
    expect(ir.limit).toBe(10);
  });

  test('direct path handles where + limit + offset', () => {
    const fs = FieldSet.for(Person, ['name']);
    const ir = lower(QueryBuilder.from(Person)
      .select(fs)
      .where((p) => p.name.equals('Semmy'))
      .limit(5)
      .offset(10)
      );
    expect(ir.where).toBeDefined();
    expect(ir.limit).toBe(5);
    expect(ir.offset).toBe(10);
  });

  test('direct path handles forAll + subjects', () => {
    const fs = FieldSet.for(Person, ['name']);
    const ir = lower(QueryBuilder.from(Person)
      .select(fs)
      .forAll([`${tmpEntityBase}p1`, `${tmpEntityBase}p2`])
      );
    expect(ir.subjectIds).toHaveLength(2);
  });

  test('direct path handles for (single subject)', () => {
    const fs = FieldSet.for(Person, ['name']);
    const ir = lower(QueryBuilder.from(Person)
      .select(fs)
      .for({id: `${tmpEntityBase}p1`})
      );
    expect(ir.subjectId).toBe(`${tmpEntityBase}p1`);
    expect(ir.singleResult).toBe(true);
  });

  test('evaluation selection (equals) produces same IR as DSL', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => ({isBestFriend: p.bestFriend.equals({id: `${tmpEntityBase}p3`})})),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => ({isBestFriend: p.bestFriend.equals({id: `${tmpEntityBase}p3`})}))
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('sub-select via callback produces matching IR to DSL', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => p.friends.select((f) => [f.name, f.hobby])),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.friends.select((f: any) => [f.name, f.hobby]))
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });
});

// =============================================================================
// .for() and .forAll() chaining tests
// =============================================================================

describe('Shape.select().for() / .forAll() chaining', () => {
  test('Person.select(callback).for(id) produces single-result IR', () => {
    const ir = lower(Person.select((p) => p.name).for(entity('p1')));
    expect(ir.subjectId).toBe(entity('p1').id);
    expect(ir.singleResult).toBe(true);
  });

  test('Person.select(callback).for(string) accepts string id', () => {
    const ir = lower(Person.select((p) => p.name).for(`${tmpEntityBase}p1`));
    expect(ir.subjectId).toBe(`${tmpEntityBase}p1`);
    expect(ir.singleResult).toBe(true);
  });

  test('Person.select().for(id) with no callback selects nothing', () => {
    const ir = lower(Person.select().for(entity('p1')));
    expect(ir.subjectId).toBe(entity('p1').id);
    expect(ir.singleResult).toBe(true);
  });

  test('Person.selectAll().for(id) selects all fields for a single entity', () => {
    const ir = lower(Person.selectAll().for(entity('p1')));
    expect(ir.subjectId).toBe(entity('p1').id);
    expect(ir.singleResult).toBe(true);
    expect(ir.projection.length).toBeGreaterThan(0);
  });

  test('.for(id) produces same IR as old select(id, callback)', async () => {
    const newIR = lower(Person.select((p) => p.name).for(entity('p1')));
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => p.name)
      .for(entity('p1'))
      );
    expect(sanitize(newIR)).toEqual(sanitize(builderIR));
  });

  test('.forAll(ids) targets multiple entities', () => {
    const ir = lower(QueryBuilder.from(Person)
      .select((p) => p.name)
      .forAll([entity('p1'), entity('p2')])
      );
    expect(ir.subjectIds).toEqual([entity('p1').id, entity('p2').id]);
    expect(ir.singleResult).toBeFalsy();
  });
});

// =============================================================================
// Phase 9: Expression equivalence tests — QueryBuilder vs DSL
// =============================================================================

describe('QueryBuilder — expression equivalence with DSL', () => {
  test('SELECT expression projection equivalence', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => ({nameLen: (p.name as any).strlen()})),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => ({nameLen: (p.name as any).strlen()}))
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('WHERE expression filter equivalence', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => ({name: p.name})).where(((p: any) => p.name.strlen().gt(5)) as any),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => ({name: p.name}))
      .where(((p: any) => p.name.strlen().gt(5)) as any)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('mixed expression + evaluation WHERE equivalence', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => ({name: p.name})).where((p) =>
        p.name.equals('Bob').and((p.name as any).strlen().gt(3)),
      ),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => ({name: p.name}))
      .where((p) => p.name.equals('Bob').and((p.name as any).strlen().gt(3)))
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('expression projection + expression WHERE combined equivalence', async () => {
    const dslIR = await captureDslIR(() =>
      Person.select((p) => ({
        name: p.name,
        nameLen: (p.name as any).strlen(),
      })).where(((p: any) => p.name.strlen().gt(2)) as any),
    );
    const builderIR = lower(QueryBuilder.from(Person)
      .select((p) => ({
        name: p.name,
        nameLen: (p.name as any).strlen(),
      }))
      .where(((p: any) => p.name.strlen().gt(2)) as any)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });
});

// =============================================================================
// .for() and .forAll() chaining tests
// =============================================================================

describe('Person.update(data).for(id) chaining', () => {
  test('Person.update(data).for(id) produces correct IR', () => {
    const ir = lower(Person.update({hobby: 'Chess'}).for(entity('p1')));
    expect(ir).toBeDefined();
  });

  test('UpdateBuilder.from().for(id).set(data) produces same IR as update(data).for(id)', () => {
    const ir1 = lower(Person.update({hobby: 'Chess'}).for(entity('p1')));
    const ir2 = lower(UpdateBuilder.from(Person).for(entity('p1')).set({hobby: 'Chess'}));
    expect(sanitize(ir1)).toEqual(sanitize(ir2));
  });

  test('Person.update(data).for(string) accepts string id', () => {
    const ir = lower(Person.update({hobby: 'Chess'}).for(`${tmpEntityBase}p1`));
    expect(ir).toBeDefined();
  });

  test('UpdateBuilder.from(Person).for(id).set(data) matches Person.update(data).for(id)', () => {
    const dslIR = lower(Person.update({hobby: 'Chess'}).for(entity('p1')));
    const builderIR = lower(UpdateBuilder.from(Person)
      .for(entity('p1'))
      .set({hobby: 'Chess'})
      );
    expect(sanitize(dslIR)).toEqual(sanitize(builderIR));
  });
});

// =============================================================================
// PendingQueryContext — lazy resolution & .for() integration
// =============================================================================

describe('PendingQueryContext', () => {
  afterEach(() => {
    // Reset the context entry used by these tests
    setQueryContext('pendingTest', null as any);
  });

  test('getQueryContext returns PendingQueryContext when name is not set', () => {
    const ctx = getQueryContext('neverSet');
    expect(ctx).toBeInstanceOf(PendingQueryContext);
    expect((ctx as any).contextName).toBe('neverSet');
  });

  test('.id is undefined before context is set', () => {
    const ctx = getQueryContext('pendingTest');
    expect(ctx.id).toBeUndefined();
  });

  test('.id resolves lazily after setQueryContext', () => {
    const ctx = getQueryContext('pendingTest');
    expect(ctx.id).toBeUndefined();

    setQueryContext('pendingTest', {id: `${tmpEntityBase}u1`}, Person);
    expect(ctx.id).toBe(`${tmpEntityBase}u1`);
  });

  test('.id tracks value changes', () => {
    const ctx = getQueryContext('pendingTest');

    setQueryContext('pendingTest', {id: `${tmpEntityBase}u1`}, Person);
    expect(ctx.id).toBe(`${tmpEntityBase}u1`);

    setQueryContext('pendingTest', {id: `${tmpEntityBase}u2`}, Person);
    expect(ctx.id).toBe(`${tmpEntityBase}u2`);
  });

  test('getQueryContext returns resolved value after context is set', () => {
    setQueryContext('pendingTest', {id: `${tmpEntityBase}u1`}, Person);
    const ctx = getQueryContext('pendingTest');
    expect(ctx).not.toBeInstanceOf(PendingQueryContext);
    expect(ctx.id).toBe(`${tmpEntityBase}u1`);
  });
});

// =============================================================================
// QueryBuilder — .for() with PendingQueryContext
// =============================================================================

describe('QueryBuilder — .for() with PendingQueryContext', () => {
  afterEach(() => {
    setQueryContext('qbPending', null as any);
  });

  test('.for(PendingQueryContext) sets pending context name', () => {
    const pending = new PendingQueryContext('qbPending');
    const qb = Person.select((p) => p.name).for(pending as any);
    expect(qb.hasPendingContext()).toBe(true);
  });

  test('hasPendingContext() returns false after context resolves', () => {
    const pending = new PendingQueryContext('qbPending');
    const qb = Person.select((p) => p.name).for(pending as any);
    expect(qb.hasPendingContext()).toBe(true);

    // Set the context — the PendingQueryContext's .id getter now resolves
    setQueryContext('qbPending', {id: `${tmpEntityBase}u1`}, Person);
    expect(qb.hasPendingContext()).toBe(false);
  });

  test('toJSON().subject carries a {@ctx} reference, not the resolved id', () => {
    const pending = new PendingQueryContext('qbPending');
    const qb = Person.select((p) => p.name).for(pending as any);

    // The wire carries the context reference regardless of local resolution —
    // the receiver resolves it against its own context map at lowering time.
    expect(qb.toJSON().subject).toEqual({'@ctx': 'qbPending'});

    setQueryContext('qbPending', {id: `${tmpEntityBase}u1`}, Person);
    expect(qb.toJSON().subject).toEqual({'@ctx': 'qbPending'});
  });

  test('toJSON/fromJSON round-trips a {@ctx} subject and resolves live', () => {
    const pending = new PendingQueryContext('qbPending');
    const qb = Person.select((p) => p.name).for(pending as any);
    const restored = QueryBuilder.fromJSON(qb.toJSON());

    // Still a context reference after the round-trip.
    expect(restored.toJSON().subject).toEqual({'@ctx': 'qbPending'});
    expect(restored.hasPendingContext()).toBe(true);

    // And it resolves live once the context lands.
    setQueryContext('qbPending', {id: `${tmpEntityBase}u1`}, Person);
    expect(restored.hasPendingContext()).toBe(false);
    expect((restored as any).toRawInput().subject?.id).toBe(`${tmpEntityBase}u1`);
  });

  test('.for(null) still sets _nullSubject (not pending)', () => {
    const qb = Person.select((p) => p.name).for(null);
    expect(qb.hasPendingContext()).toBe(false);
  });

  test('.for(id) after .for(PendingQueryContext) clears pending state', () => {
    const pending = new PendingQueryContext('qbPending');
    const qb = Person.select((p) => p.name)
      .for(pending as any)
      .for(`${tmpEntityBase}p1`);
    expect(qb.hasPendingContext()).toBe(false);
    expect(qb.toJSON().subject).toBe(`${tmpEntityBase}p1`);
  });
});

// =============================================================================
// Where-clause context references ({@ctx} carried through the IR)
// =============================================================================

describe('where-clause context references', () => {
  afterEach(() => setQueryContext('wctx', null as any));

  test('UNSET context: .equals(ctx) builds without throwing and carries the name', () => {
    setQueryContext('wctx', null as any); // ensure unset
    const q = Person.select((p) => p.name).where((p: any) =>
      p.bestFriend.equals(getQueryContext('wctx')),
    );
    // Pre-auth where-context no longer throws at build; the wire carries the
    // context *name* as a `{@ctx}` marker, not a baked/undefined id.
    const json: any = JSON.parse(JSON.stringify(q.toJSON()));
    expect(json.where).toEqual({bestFriend: {'@ctx': 'wctx'}});
    expect(JSON.stringify(json.where)).not.toContain('"id"'); // no baked id while unset

    // fromJSON → toJSON preserves the reference verbatim.
    const restored = QueryBuilder.fromJSON(json);
    expect(restored.toJSON().where).toEqual(json.where);
  });

  test('SET context: lower() resolves the name to the concrete id', () => {
    setQueryContext('wctx', {id: `${tmpEntityBase}u9`}, Person);
    const q = Person.select((p) => p.name).where((p: any) =>
      p.bestFriend.equals(getQueryContext('wctx')),
    );
    const ir: any = lower(q as any);
    const where = JSON.stringify(ir.where);
    expect(where).toContain(`${tmpEntityBase}u9`); // resolved
    expect(where).not.toContain('contextName'); // name dropped after resolution
  });

  test('UNSET context, SELECT exec(): resolves to null (not ready), not a throw', async () => {
    setQueryContext('wctx', null as any);
    const result = await Person.select((p) => p.name).where((p: any) =>
      p.bestFriend.equals(getQueryContext('wctx')),
    );
    expect(result).toBeNull();
  });

  test('UNSET context, MUTATION where: lower() throws UnresolvedContextError', () => {
    setQueryContext('wctx', null as any);
    const upd = UpdateBuilder.from(Person)
      .set({hobby: 'x'})
      .where((p: any) => p.bestFriend.equals(getQueryContext('wctx')));
    expect(() => lower(upd as any)).toThrow(/context "wctx" is not set/i);
  });

  test('context property as the SELF of an expression resolves (not dropped to root)', () => {
    // getQueryContext('user').hobby.equals(x) must become a context_property_expr,
    // not a property_expr on the root entity.
    setQueryContext('wctx', {id: `${tmpEntityBase}u9`}, Person);
    const q = QueryBuilder.from(Person).select((p: any) => p.name).where((p: any) =>
      (getQueryContext('wctx') as any).hobby.equals('Chess'),
    );
    const s = JSON.stringify(lower(q as any));
    expect(s).toContain('context_property_expr');
    expect(s).toContain(`${tmpEntityBase}u9`); // resolved to the context entity
    setQueryContext('wctx', null as any);
  });

  test('context in a PROJECTED expression resolves at lower (not only in where)', () => {
    // Regression: a projected expression carrying a context ref must be resolved
    // by lower() too — otherwise it reaches SPARQL unresolved and crashes.
    setQueryContext('wctx', {id: `${tmpEntityBase}u9`}, Person);
    const q = QueryBuilder.from(Person).select((p: any) => ({
      isFriend: p.bestFriend.equals(getQueryContext('wctx')),
    }));
    const ir: any = lower(q as any);
    const s = JSON.stringify(ir);
    expect(s).toContain(`${tmpEntityBase}u9`); // resolved into the projection
    expect(s).not.toContain('contextName'); // no unresolved ref reaches SPARQL
    // unset → throws at lower rather than producing a broken projection
    setQueryContext('wctx', null as any);
    expect(() =>
      lower(QueryBuilder.from(Person).select((p: any) => ({
        isFriend: p.bestFriend.equals(getQueryContext('wctx')),
      })) as any),
    ).toThrow(/context "wctx" is not set/i);
  });
});

// =============================================================================
// Error policy — accessing an undecorated property in a query throws
// (was a console.warn + silently-wrong path; a swallowed warning is a trap)
// =============================================================================

describe('undecorated property access in a query', () => {
  test('a decorated property still resolves', () => {
    expect(() => Person.select((p: any) => [p.name]).toJSON()).not.toThrow();
  });

  test('an undecorated property throws instead of returning a broken path', () => {
    expect(() =>
      Person.select((p: any) => [p.notADecoratedProperty]).toJSON(),
    ).toThrow(/does not have a @linkedProperty decorator/);
  });

  test('an undecorated property across a SET-valued relation also throws (no policy hole)', () => {
    // The set-valued proxy (p.friends…) must enforce the same rule as the
    // single-node proxy — otherwise multi-hop paths silently produce broken
    // results.
    expect(() =>
      Person.select((p: any) => [p.friends.notADecoratedProperty]).toJSON(),
    ).toThrow(/does not have a @linkedProperty decorator/);
  });

  test('a decorated property across a set-valued relation still resolves', () => {
    expect(() => Person.select((p: any) => [p.friends.name]).toJSON()).not.toThrow();
  });

  test('genuine ShapeSet collection methods still pass through', () => {
    // A real set method (not an undecorated property) must not throw.
    expect(() =>
      Person.select((p: any) => [p.friends.size()]).toJSON(),
    ).not.toThrow();
  });
});


// =============================================================================
// .exists() — boolean existence checks
// =============================================================================

/**
 * A store that answers asks directly. `answer` may be a value or a thunk that
 * throws — a store with `askQuery` is never asked through a select, so what this
 * returns is the whole story.
 */
const askStore = (answer: boolean | (() => never)): any => ({
  selectQuery: async () => {
    throw new Error('selectQuery must not be reached by an existence check');
  },
  askQuery: async () => (typeof answer === 'function' ? answer() : answer),
});

describe('SelectBuilder — .exists()', () => {
  test('Person.exists(id) lowers to a bare, single-row, subject-filtered query', async () => {
    const ir: any = await captureQuery(existsFactories.existsById);
    expect(ir.kind).toBe('ask');
    expect(ir.subjectId).toBe(entity('p1').id);
    expect(ir.root).toBeDefined();
    // There is no projection, resultMap, sorting or pagination on an ask IR at
    // all — not an empty one. The shape of the type IS the normalisation.
    expect(ir.projection).toBeUndefined();
    expect(ir.resultMap).toBeUndefined();
    expect(ir.orderBy).toBeUndefined();
    expect(ir.limit).toBeUndefined();
    expect(ir.offset).toBeUndefined();
  });

  test('.exists() normalises away projection, preloads and sorting', async () => {
    const bare = await captureQuery(existsFactories.existsById);
    const decorated = await captureQuery(existsFactories.existsNormalised);
    // A chained .select(...).orderBy(...) costs exactly the same as a bare exists.
    expect(sanitize(decorated)).toEqual(sanitize(bare));
  });

  test('.exists() drops pagination — offset and limit do not survive', async () => {
    // OFFSET skips rows of the solution sequence, whose cardinality depends on the
    // projection exists() just dropped. Honouring offset while dropping the
    // projection would let the same chain answer true before normalisation and
    // false after; exists() answers about the match set, not a page of it.
    const paginated: any = await captureQuery(existsFactories.existsPaginated);
    const bare = await captureQuery(existsFactories.existsById);
    expect(paginated.offset).toBeUndefined();
    expect(paginated.limit).toBeUndefined();
    expect(sanitize(paginated)).toEqual(sanitize(bare));
  });

  test('.exists() keeps minus entries — they decide whether a match exists', async () => {
    const ir = await captureQuery(() =>
      Person.select((p) => p.name)
        .minus((p) => p.name.equals('Semmy'))
        .exists(),
    );
    expect(ir.kind).toBe('ask');
    expect(ir.projection).toBeUndefined();
    // The minus survives normalisation: the IR is not the same as a bare exists.
    const bare = await captureQuery(() => Person.select().exists());
    expect(JSON.stringify(ir)).toContain('minus');
    expect(sanitize(ir)).not.toEqual(sanitize(bare));
  });

  test('.forAll(ids).exists() keeps the subject list and stays multi-row-capable', async () => {
    const ir = await captureQuery(() =>
      Person.selectAll().forAll([entity('p1'), entity('p2')]).exists(),
    );
    expect(ir.subjectIds).toEqual([entity('p1').id, entity('p2').id]);
    expect(ir.projection).toBeUndefined();
    expect(ir.limit).toBeUndefined();
  });

  test('.exists() keeps the where clause — it decides whether a row exists', async () => {
    const ir: any = await captureQuery(existsFactories.existsWhere);
    expect(ir.kind).toBe('ask');
    expect(ir.projection).toBeUndefined();
    expect(ir.where).toBeDefined();
    expect(ir.subjectId).toBeUndefined();
  });

  test("resolves the store's boolean, both ways, without touching selectQuery", async () => {
    await expect(Person.select().exists(askStore(true))).resolves.toBe(true);
    await expect(Person.select().exists(askStore(false))).resolves.toBe(false);
  });

  test('the subject form behaves identically — there is one path', async () => {
    await expect(
      Person.select().for(entity('p1')).exists(askStore(true)),
    ).resolves.toBe(true);
    await expect(
      Person.select().for(entity('p1')).exists(askStore(false)),
    ).resolves.toBe(false);
  });

  test('a null/undefined id resolves false without dispatching a query', async () => {
    const ir = await captureQuery(() => Person.exists(null));
    expect(ir).toBeUndefined();
    await expect(Person.exists(null)).resolves.toBe(false);
    await expect(Person.exists(undefined)).resolves.toBe(false);
  });

  test('a store failure REJECTS — it is never reported as false', async () => {
    // The bug this API replaces: `.catch(() => null)` around a select made an
    // unreachable store indistinguishable from a missing node, so every
    // `exists ? update : create` silently became an unconditional create.
    const broken = askStore(() => {
      throw new Error('fuseki is down');
    });
    await expect(Person.exists(entity('p1'), broken as any)).rejects.toThrow(
      /fuseki is down/,
    );
    await expect(
      Person.select().where((p) => p.name.equals('Semmy')).exists(broken as any),
    ).rejects.toThrow(/fuseki is down/);
  });

  test('an unresolved where-clause context REJECTS — it is not "not ready" → false', async () => {
    // exec() deliberately reports UnresolvedContextError as null ("not ready", a
    // reactive layer re-runs). exists() must not flatten that into a boolean:
    // "could not ask" is not "does not exist".
    const unresolving = {
      askQuery: async () => {
        throw new UnresolvedContextError('user');
      },
      selectQuery: async () => {
        throw new UnresolvedContextError('user');
      },
    };
    await expect(Person.select().exists(unresolving as any)).rejects.toThrow();
    // …while exec() keeps its existing, documented null behaviour.
    await expect(Person.select().exec(unresolving as any)).resolves.toBeNull();
  });

  test('a malformed string id rejects rather than throwing synchronously', async () => {
    // Shape.exists is declared Promise<boolean>, so callers may only have a
    // .catch() — a sync throw out of resolveUriOrThrow would escape it.
    let threwSynchronously = false;
    let promise: Promise<boolean> | undefined;
    try {
      promise = Person.exists('not-a-known-prefix:oops');
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).toBe(false);
    await expect(promise).rejects.toThrow();
  });

  test('.exists() is terminal — it returns a promise, not a builder', () => {
    const result = Person.select().exists(askStore(false));
    expect(result).toBeInstanceOf(Promise);
    expect((result as any).where).toBeUndefined();
    return expect(result).resolves.toBe(false);
  });
});

// =============================================================================
// .exists() → ASK dispatch
// =============================================================================

describe('SelectBuilder — .exists() prefers askQuery', () => {
  /** A store that answers booleans directly, recording what it was asked. */
  const askStore = (answer: boolean) => {
    const seen: {ask: number; select: number; query?: any} = {ask: 0, select: 0};
    const store = {
      askQuery: async (q: any) => {
        seen.ask += 1;
        seen.query = q;
        return answer;
      },
      selectQuery: async () => {
        seen.select += 1;
        return [] as any;
      },
    };
    return {store, seen};
  };

  test('uses askQuery when the target has one, and does not also select', async () => {
    const {store, seen} = askStore(true);
    await expect(Person.exists(entity('p1'), store as any)).resolves.toBe(true);
    expect(seen.ask).toBe(1);
    expect(seen.select).toBe(0);
  });

  test('askQuery returning FALSE resolves false — not "not null, therefore true"', async () => {
    // The conversion `.exists()` shipped on was `result != null`, which reads a
    // literal `false` from a store as "present". The boolean arm in exists()
    // exists for exactly this, and this test is what holds it in place.
    const {store, seen} = askStore(false);
    await expect(Person.exists(entity('p1'), store as any)).resolves.toBe(false);
    expect(seen.ask).toBe(1);
  });

  test('askQuery receives the normalised query, not the decorated chain', async () => {
    const {store, seen} = askStore(true);
    await Person.select((p) => p.name)
      .orderBy((p) => p.name)
      .for(entity('p1'))
      .offset(10)
      .exists(store as any);
    const ir: any = lower(seen.query);
    expect(ir.kind).toBe('ask');
    expect(ir.limit).toBeUndefined();
    expect(ir.offset).toBeUndefined();
    expect(ir.projection).toBeUndefined();
    expect(ir.orderBy).toBeUndefined();
  });

  test('a store failure on the ASK path REJECTS — same contract as the SELECT path', async () => {
    const broken = {
      askQuery: async () => {
        throw new Error('fuseki is down');
      },
      selectQuery: async () => [] as any,
    };
    await expect(Person.exists(entity('p1'), broken as any)).rejects.toThrow(
      /fuseki is down/,
    );
  });

  test('an unresolved where-clause context still REJECTS on the ASK path', async () => {
    const unresolving = {
      askQuery: async () => {
        throw new UnresolvedContextError('user');
      },
      selectQuery: async () => [] as any,
    };
    await expect(Person.select().exists(unresolving as any)).rejects.toThrow();
  });

  test('a null id short-circuits to false without reaching askQuery', async () => {
    const {store, seen} = askStore(true);
    await expect(Person.exists(null, store as any)).resolves.toBe(false);
    expect(seen.ask).toBe(0);
    expect(seen.select).toBe(0);
  });

  test('exec() never takes the ASK path', async () => {
    const {store, seen} = askStore(true);
    await Person.select((p) => p.name).exec(store as any);
    expect(seen.ask).toBe(0);
    expect(seen.select).toBe(1);
  });

  test('a store without askQuery is asked with a select LIMIT 1', async () => {
    const seen: any[] = [];
    const withRow = {
      selectQuery: async (q: any) => {
        seen.push(q.toJSON());
        return [{id: entity('p1').id}];
      },
    };
    await expect(Person.exists(entity('p1'), withRow as any)).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({shape: Person.shape.id, subject: entity('p1').id, limit: 1});
    expect(seen[0].op).toBeUndefined();
    const empty = {selectQuery: async () => []};
    await expect(Person.exists(entity('p1'), empty as any)).resolves.toBe(false);
  });

  test('a shapeless ask on a store without askQuery is refused', async () => {
    await expect(
      Shape.exists(entity('p1'), {selectQuery: async () => []} as any),
    ).rejects.toThrow(/shapeless ask/);
  });
});

// =============================================================================
// The existence contract — what a store is allowed to answer with
// =============================================================================

describe('SelectBuilder — .exists() enforces the boolean contract', () => {
  // A store that answers with something truthy but not a boolean used to slip
  // through as "exists": the conversion was `result != null`. Coercion here is
  // exactly the quiet-wrong-answer this API family exists to remove, so a
  // non-boolean is a rejected store contract, not an answer.
  test.each([
    ['a truthy object', {} as any],
    ['a row array', [{id: 'x'}] as any],
    ['a string', 'true' as any],
    ['undefined', undefined as any],
    ['null', null as any],
    ['a number', 1 as any],
  ])('askQuery resolving %s REJECTS rather than coercing', async (_label, value) => {
    const store = {
      askQuery: async () => value,
      selectQuery: async () => [] as any,
    };
    await expect(Person.exists(entity('p1'), store as any)).rejects.toThrow(
      /must resolve to a boolean/,
    );
  });

  test('both real booleans pass the contract unchanged', async () => {
    for (const answer of [true, false]) {
      const store = {askQuery: async () => answer, selectQuery: async () => [] as any};
      await expect(Person.exists(entity('p1'), store as any)).resolves.toBe(answer);
    }
  });
});

describe('AskBuilder — pagination is unrepresentable, not guarded', () => {
  // The earlier design normalised a select and then guarded against OFFSET /
  // LIMIT 0 surviving. AskBuilder has nowhere to put them, so there is nothing
  // left to guard: a chain carrying either still reduces to the same ask.
  test('a chain with offset and limit(0) still answers', async () => {
    const store = {
      selectQuery: async () => {
        throw new Error('not reached');
      },
      askQuery: async () => true,
    };
    await expect(
      Person.select().for(entity('p1')).offset(5).limit(0).exists(store as any),
    ).resolves.toBe(true);
  });

  test('the ask it reduces to carries no pagination, projection or sorting', async () => {
    const ir: any = await captureQuery(() =>
      Person.select((p) => p.name)
        .orderBy((p) => p.name)
        .for(entity('p1'))
        .offset(10)
        .limit(50)
        .exists(),
    );
    expect(ir.kind).toBe('ask');
    expect(ir.limit).toBeUndefined();
    expect(ir.offset).toBeUndefined();
    expect(ir.orderBy).toBeUndefined();
    expect(ir.projection).toBeUndefined();
    // The pattern that decides the answer survives.
    expect(ir.subjectId).toBe(entity('p1').id);
    expect(ir.root).toBeDefined();
  });

  test('a decorated chain and a bare exists lower to the same ask', async () => {
    const decorated = await captureQuery(existsFactories.existsNormalised);
    const bare = await captureQuery(existsFactories.existsById);
    expect(sanitize(decorated)).toEqual(sanitize(bare));
  });
});
