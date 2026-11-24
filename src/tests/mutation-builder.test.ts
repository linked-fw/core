import {describe, expect, test} from '@jest/globals';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {entity, captureDslIR, sanitize} from '../test-helpers/test-utils';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {lower} from '../queries/lower';
import {fromJSON} from '../queries/fromJSON';

// =============================================================================
// Create IR equivalence tests
// =============================================================================

describe('CreateBuilder — IR equivalence', () => {
  test('create — simple', async () => {
    const dslIR = await captureDslIR(() =>
      Person.create({name: 'Test Create', hobby: 'Chess'}),
    );
    const builderIR = lower(CreateBuilder.from(Person)
      .set({name: 'Test Create', hobby: 'Chess'})
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('create — with friends', async () => {
    const dslIR = await captureDslIR(() =>
      Person.create({
        name: 'Test Create',
        friends: [entity('p2'), {name: 'New Friend'}],
      }),
    );
    const builderIR = lower(CreateBuilder.from(Person)
      .set({
        name: 'Test Create',
        friends: [entity('p2'), {name: 'New Friend'}],
      })
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('create — with fixed id', async () => {
    const dslIR = await captureDslIR(() =>
      Person.create({
        __id: `${tmpEntityBase}fixed-id`,
        name: 'Fixed',
        bestFriend: {id: `${tmpEntityBase}fixed-id-2`},
      } as any),
    );
    const builderIR = lower(CreateBuilder.from(Person)
      .set({name: 'Fixed', bestFriend: {id: `${tmpEntityBase}fixed-id-2`}} as any)
      .withId(`${tmpEntityBase}fixed-id`)
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });
});

// =============================================================================
// Update IR equivalence tests
// =============================================================================

describe('UpdateBuilder — IR equivalence', () => {
  test('update — simple', async () => {
    const dslIR = await captureDslIR(() =>
      Person.update({hobby: 'Chess'}).for(entity('p1')),
    );
    const builderIR = lower(UpdateBuilder.from(Person)
      .for(entity('p1'))
      .set({hobby: 'Chess'})
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('update — add/remove multi', async () => {
    const dslIR = await captureDslIR(() =>
      Person.update({
        friends: {add: [entity('p2')], remove: [entity('p3')]},
      }).for(entity('p1')),
    );
    const builderIR = lower(UpdateBuilder.from(Person)
      .for(entity('p1'))
      .set({friends: {add: [entity('p2')], remove: [entity('p3')]}})
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('update — nested with predefined id', async () => {
    const dslIR = await captureDslIR(() =>
      Person.update({
        bestFriend: {id: `${tmpEntityBase}p3-best-friend`, name: 'Bestie'},
      }).for(entity('p1')),
    );
    const builderIR = lower(UpdateBuilder.from(Person)
      .for(entity('p1'))
      .set({
        bestFriend: {id: `${tmpEntityBase}p3-best-friend`, name: 'Bestie'},
      })
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('update — overwrite set', async () => {
    const dslIR = await captureDslIR(() =>
      Person.update({friends: [entity('p2')]}).for(entity('p1')),
    );
    const builderIR = lower(UpdateBuilder.from(Person)
      .for(entity('p1'))
      .set({friends: [entity('p2')]})
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('update — birth date', async () => {
    const dslIR = await captureDslIR(() =>
      Person.update({birthDate: new Date('2020-01-01')}).for(entity('p1')),
    );
    const builderIR = lower(UpdateBuilder.from(Person)
      .for(entity('p1'))
      .set({birthDate: new Date('2020-01-01')})
      );
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });
});

// =============================================================================
// Delete IR equivalence tests
// =============================================================================

describe('DeleteBuilder — IR equivalence', () => {
  test('delete — single via .from(shape, id)', async () => {
    const dslIR = await captureDslIR(() => Person.delete(entity('to-delete')));
    const builderIR = lower(DeleteBuilder.from(Person, entity('to-delete')));
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });

  test('delete — multiple via .from(shape, ids)', async () => {
    const dslIR = await captureDslIR(() =>
      Person.delete([entity('to-delete-1'), entity('to-delete-2')]),
    );
    const builderIR = lower(DeleteBuilder.from(Person, [
      entity('to-delete-1'),
      entity('to-delete-2'),
    ]));
    expect(sanitize(builderIR)).toEqual(sanitize(dslIR));
  });
});

// =============================================================================
// Immutability tests
// =============================================================================

describe('Mutation builders — immutability', () => {
  test('CreateBuilder — .set() returns new instance', () => {
    const b1 = CreateBuilder.from(Person);
    const b2 = b1.set({name: 'Alice'});
    expect(b1).not.toBe(b2);
  });

  test('CreateBuilder — .withId() returns new instance', () => {
    const b1 = CreateBuilder.from(Person).set({name: 'Alice'});
    const b2 = b1.withId('some-id');
    expect(b1).not.toBe(b2);
  });

  test('DeleteBuilder — .from() with ids returns new instance', () => {
    const b1 = DeleteBuilder.from(Person);
    const b2 = DeleteBuilder.from(Person, entity('to-delete'));
    expect(b1).not.toBe(b2);
  });

  test('UpdateBuilder — .for() returns new instance', () => {
    const b1 = UpdateBuilder.from(Person);
    const b2 = b1.for(entity('p1'));
    expect(b1).not.toBe(b2);
  });

  test('UpdateBuilder — .set() returns new instance', () => {
    const b1 = UpdateBuilder.from(Person).for(entity('p1'));
    const b2 = b1.set({hobby: 'Chess'});
    expect(b1).not.toBe(b2);
  });
});

// =============================================================================
// Input non-mutation tests
// =============================================================================

describe('Mutation builders — input non-mutation', () => {
  test('create with __id does not mutate the input object', async () => {
    const input = {
      __id: `${tmpEntityBase}preserve-me`,
      name: 'Alice',
      hobby: 'Chess',
    } as any;
    const inputCopy = {...input};

    // Build the IR (which internally calls convertNodeDescription)
    await captureDslIR(() => Person.create(input));

    // The original input object must be untouched
    expect(input).toEqual(inputCopy);
    expect(input.__id).toBe(`${tmpEntityBase}preserve-me`);
    expect(input.name).toBe('Alice');
  });

  test('create with nested object ref does not strip id from the ref', async () => {
    const friendRef = {id: `${tmpEntityBase}friend-1`, name: 'Bob'};
    const input = {name: 'Alice', bestFriend: friendRef};

    await captureDslIR(() => Person.create(input));

    // The nested object's id must survive — this is the bug that broke JWT token creation
    expect(friendRef.id).toBe(`${tmpEntityBase}friend-1`);
    expect(friendRef.name).toBe('Bob');
  });

  test('sequential creates reusing objects do not corrupt earlier results', async () => {
    const user = {id: `${tmpEntityBase}user-1`};
    const accountInput = {name: 'Account', bestFriend: user};

    // First build: uses user as a nested reference
    const ir1 = await captureDslIR(() => Person.create(accountInput));

    // user.id must still be intact after first create consumed it
    expect(user.id).toBe(`${tmpEntityBase}user-1`);

    // Second build: same user ref should still work
    const ir2 = await captureDslIR(() =>
      Person.create({name: 'Account2', bestFriend: user}),
    );
    expect(user.id).toBe(`${tmpEntityBase}user-1`);
  });
});

// =============================================================================
// Guard tests (LP3 + LP4: consistent validation across builders)
// =============================================================================

describe('Mutation builders — guards', () => {
  test('UpdateBuilder — lower() without .for() throws', () => {
    const builder = UpdateBuilder.from(Person).set({hobby: 'Chess'});
    expect(() => lower(builder)).toThrow(/requires .for/);
  });

  test('UpdateBuilder — lower() without .set() throws', () => {
    const builder = UpdateBuilder.from(Person).for(entity('p1'));
    expect(() => lower(builder)).toThrow(/requires .set/);
  });

  test('CreateBuilder — lower() without .set() throws', () => {
    const builder = CreateBuilder.from(Person);
    expect(() => lower(builder)).toThrow(/requires .set/);
  });

  test('DeleteBuilder — lower() without ids throws', () => {
    const builder = DeleteBuilder.from(Person);
    expect(() => lower(builder)).toThrow(/requires at least one ID/);
  });

  test('DeleteBuilder — lower() with empty ids throws', () => {
    const builder = DeleteBuilder.from(Person, [] as any);
    expect(() => lower(builder)).toThrow(/requires at least one ID/);
  });
});

// =============================================================================
// PromiseLike tests
// =============================================================================

describe('Mutation builders — PromiseLike', () => {
  test('CreateBuilder has .then()', () => {
    const builder = CreateBuilder.from(Person).set({name: 'Alice'});
    expect(typeof builder.then).toBe('function');
  });

  test('UpdateBuilder has .then()', () => {
    const builder = UpdateBuilder.from(Person).for(entity('p1')).set({hobby: 'Chess'});
    expect(typeof builder.then).toBe('function');
  });

  test('DeleteBuilder has .then()', () => {
    const builder = DeleteBuilder.from(Person, entity('to-delete'));
    expect(typeof builder.then).toBe('function');
  });

  test('CreateBuilder await triggers execution', async () => {
    const result = await CreateBuilder.from(Person).set({name: 'Test'});
    expect(result).toBeDefined();
  });

  test('DeleteBuilder await triggers execution', async () => {
    const result = await DeleteBuilder.from(Person, entity('to-delete'));
    expect(result).toEqual({deleted: [], count: 0});
  });
});

describe('Shape.upsert — builder and guards', () => {
  const ID = `${tmpEntityBase}p1`;

  test('lowers to an upsert mutation carrying the same fields as an update', () => {
    const upsertIr: any = lower(Person.upsert({hobby: 'Chess'}).for({id: ID}) as any);
    const updateIr: any = lower(Person.update({hobby: 'Chess'}).for({id: ID}) as any);

    expect(upsertIr.kind).toBe('upsert');
    expect(updateIr.kind).toBe('update');
    // Identical but for the discriminant — the type triple is added at lowering to
    // SPARQL, not carried in the IR.
    expect({...upsertIr, kind: 'update'}).toEqual(updateIr);
  });

  test('.where() is rejected — an upsert has one known id', () => {
    expect(() => Person.upsert({hobby: 'Chess'}).where((p: any) => p.hobby.equals('x')))
      .toThrow(/upsert does not support \.where\(\)/);
  });

  test('.forAll() is rejected for the same reason', () => {
    expect(() => Person.upsert({hobby: 'Chess'}).forAll())
      .toThrow(/upsert does not support \.forAll\(\)/);
  });

  test('missing .for(id) reports the upsert requirement, not update’s three options', () => {
    expect(() => lower(Person.upsert({hobby: 'Chess'}) as any))
      .toThrow(/upsert requires \.for\(id\)/);
  });

  test('the expression-callback form does not type-check against upsert', () => {
    // `Shape.upsert` deliberately omits `update`'s callback overload, so typed callers
    // cannot even express it. @ts-expect-error fails the build if that stops being true.
    // @ts-expect-error - upsert takes a data object, not an expression callback
    expect(() => Person.upsert((p: any) => ({hobby: p.hobby.ucase()}))).toBeDefined();
  });

  test('expression-valued fields are rejected at runtime too, naming the property', () => {
    // The type signature covers typed callers; this guard covers the ones that reach the
    // builder untyped (an app calling shapes as `any`) and values arriving over DSL-JSON.
    // An expression reads the node's current value; when upsert creates the node that ref
    // is unbound and SPARQL drops the triple, storing nothing while reporting success.
    const untyped = Person as any;
    expect(() =>
      lower(untyped.upsert((p: any) => ({hobby: p.hobby.ucase()})).for({id: ID})),
    ).toThrow(/expression-valued fields/);
  });

  test('.for() accepts a query-context reference, as update does', () => {
    // The context is resolved at lowering; unresolved throws rather than writing to
    // `undefined`. Pinned because upsert carries its flag through the same clone path.
    const json: any = Person.upsert({hobby: 'Chess'}).for({id: ID}).toJSON();
    expect(json.targetId).toBe(ID);
    const rebuilt: any = lower(fromJSON(json) as any);
    expect(rebuilt.kind).toBe('upsert');
    expect(rebuilt.id).toBe(ID);
  });

  test('an id in the data object is named, not just "requires .for(id)"', () => {
    // The likely first mistake when migrating from `create({__id: id, ...values})`, which
    // is exactly the call upsert replaces. Both spellings, both mutations.
    expect(() => lower(Person.upsert({id: ID, hobby: 'Chess'} as any) as any))
      .toThrow(/takes the target id in \.for\(id\), not in the data/);
    expect(() => lower(Person.upsert({__id: ID, hobby: 'Chess'} as any) as any))
      .toThrow(/move "__id" out of the data object/);
    expect(() => lower(Person.update({id: ID, hobby: 'Chess'} as any) as any))
      .toThrow(/takes the target id in \.for\(id\), not in the data/);
  });

  test('create is the one that does take an id in its data', () => {
    // The asymmetry is deliberate — there the id names the node being created — and the
    // error above points at it, so this pins that create really does behave that way.
    expect((lower(Person.create({__id: ID, hobby: 'Chess'} as any) as any) as any).data.id).toBe(ID);
    // Without one the IR carries no id at all — the ULID is minted later, at SPARQL
    // lowering (`data.id || generateEntityUri(...)`), not here.
    expect((lower(Person.create({hobby: 'Chess'}) as any) as any).data.id).toBeUndefined();
  });

  test('a plain missing .for() still reports the plain requirement', () => {
    expect(() => lower(Person.upsert({hobby: 'Chess'}) as any))
      .toThrow(/upsert requires \.for\(id\)/);
  });

  test('update still accepts .where(), .forAll() and expressions', () => {
    // The guards must be scoped to upsert mode only.
    expect(() => Person.update({hobby: 'Chess'}).forAll()).not.toThrow();
    expect(() => Person.update({hobby: 'Chess'}).where((p: any) => p.hobby.equals('x'))).not.toThrow();
    expect(() =>
      lower(Person.update((p: any) => ({hobby: p.hobby.ucase()})).for({id: ID}) as any),
    ).not.toThrow();
  });
});
