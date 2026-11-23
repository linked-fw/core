import {describe, test} from '@jest/globals';
import {Person, Dog, Pet} from '../test-helpers/query-fixtures';
import {QueryBuilder} from '../queries/QueryBuilder';

const expectType = <T>(_value: T) => _value;

// Compile-time checks only; skipped at runtime.
// These mirror query.types.test.ts but use QueryBuilder instead of the DSL.
describe.skip('QueryBuilder result type inference (compile only)', () => {
  test('select a literal property', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.name);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
    expectType<string | undefined>(first.id);
  });

  test('select an object property (set)', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.friends);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | undefined>(first.id);
    expectType<string | undefined>(first.friends[0].id);
  });

  test('select a date', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.birthDate);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<Date | null | undefined>(first.birthDate);
    expectType<string | undefined>(first.id);
  });

  test('select a boolean', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.isRealPerson);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<boolean | null | undefined>(first.isRealPerson);
    expectType<string | undefined>(first.id);
  });

  test('select multiple property paths', () => {
    const qb = QueryBuilder.from(Person).select((p) => [p.name, p.friends, p.bestFriend.name]);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
    expectType<string | undefined>(first.friends[0].id);
    expectType<string | null | undefined>(first.bestFriend.name);
  });

  test('select nested set property', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.friends.name);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.friends[0].name);
    expectType<string | undefined>(first.friends[0].id);
  });

  test('select deep nested', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.friends.bestFriend.bestFriend.name);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.friends[0].bestFriend.bestFriend.name);
  });

  test('select best friend name (single object property)', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.bestFriend.name);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.bestFriend.name);
  });

  test('count a shapeset', () => {
    const qb = QueryBuilder.from(Person).select((p) => p.friends.size());
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<number>(first.friends);
  });

  test('custom result object - count', () => {
    const qb = QueryBuilder.from(Person).select((p) => ({numFriends: p.friends.size()}));
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<number>(first.numFriends);
  });

  test('custom result object - equals boolean', () => {
    const qb = QueryBuilder.from(Person).select((p) => ({isBestFriend: p.bestFriend.equals({id: 'p3'})}));
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<boolean>(first.isBestFriend);
  });

  test('sub select plural - custom object', () => {
    const qb = QueryBuilder.from(Person).select((p) =>
      p.friends.select((f) => ({name: f.name, hobby: f.hobby})),
    );
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.friends[0].name);
    expectType<string | null | undefined>(first.friends[0].hobby);
  });

  test('select with where preserves result type', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => p.name)
      .where((p) => p.friends.name.equals('Alice'));
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
    expectType<string | undefined>(first.id);
  });

  test('select with limit preserves result type', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => [p.name, p.friends])
      .limit(10);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
    expectType<string | undefined>(first.friends[0].id);
  });

  test('select with offset preserves result type', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => p.name)
      .offset(5);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
  });

  test('select with orderBy preserves result type', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => p.name)
      .orderBy((p) => p.name, 'DESC');
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
  });

  test('select with orderBy preserves result type', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => p.name)
      .orderBy((p) => p.name);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
  });

  test('select with orderBy and thenBy preserves result type', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => [p.name, p.hobby])
      .orderBy((p) => p.hobby, 'DESC')
      .thenBy((p) => p.name);
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | null | undefined>(first.name);
    expectType<string | null | undefined>(first.hobby);
    // thenBy returns the same builder type as orderBy, so .one() still unwraps.
    const single = QueryBuilder.from(Person).select((p) => p.name).orderBy((p) => p.name).thenBy((p) => p.hobby, 'DESC').one();
    expectType<string | null | undefined>((null as unknown as Awaited<typeof single>).name);
    // @ts-expect-error thenBy takes 'ASC' | 'DESC' only
    QueryBuilder.from(Person).select((p) => p.name).orderBy((p) => p.name).thenBy((p) => p.hobby, 'UP');
  });

  test('one() unwraps array to single result', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => p.name)
      .one();
    type Result = Awaited<typeof qb>;
    const single = null as unknown as Result;
    expectType<string | null | undefined>(single.name);
    expectType<string | undefined>(single.id);
  });

  test('one() with multiple paths unwraps correctly', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => [p.name, p.friends])
      .one();
    type Result = Awaited<typeof qb>;
    const single = null as unknown as Result;
    expectType<string | null | undefined>(single.name);
    expectType<string | undefined>(single.friends[0].id);
  });

  test('one() with chained where/limit preserves unwrapped type', () => {
    const qb = QueryBuilder.from(Person)
      .select((p) => p.name)
      .where((p) => p.name.equals('Alice'))
      .limit(1)
      .one();
    type Result = Awaited<typeof qb>;
    const single = null as unknown as Result;
    expectType<string | null | undefined>(single.name);
  });

  test('selectAll returns typed results', () => {
    const qb = QueryBuilder.from(Person).selectAll();
    type Result = Awaited<typeof qb>;
    const first = (null as unknown as Result)[0];
    expectType<string | undefined>(first.id);
    expectType<string | null | undefined>(first.name);
  });
});

// --- Phase 7e: FieldSet<R> type tests ---
import {FieldSet} from '../queries/FieldSet';

describe.skip('FieldSet<R> type inference (compile only)', () => {
  test('FieldSet.for(Person, callback) captures return type', () => {
    const fs = FieldSet.for(Person, (p) => [p.name]);
    // fs is FieldSet<QueryBuilderObject[]> — the return type of the callback
    const _check: FieldSet<any[]> = fs;
    void _check;
  });

  test('FieldSet.for(personShape, labels) is FieldSet<any>', () => {
    const personShape = (Person as any).shape;
    const fs = FieldSet.for(personShape, ['name']);
    // String-constructed FieldSet has `any` type parameter
    const _check: FieldSet<any> = fs;
    void _check;
  });

  test('QueryBuilder.select(typedFieldSet) resolves typed result', () => {
    const fs = FieldSet.for(Person, (p) => [p.name]);
    const qb = QueryBuilder.from(Person).select(fs);
    // The builder should carry the FieldSet's R through
    type _Result = Awaited<typeof qb>;
    void (null as unknown as _Result);
  });

  test('composition degrades to FieldSet<any>', () => {
    const fs = FieldSet.for(Person, (p) => [p.name]);
    const fs2 = fs.add(['hobby']);
    // After composition, type degrades to FieldSet<any>
    const _check: FieldSet<any> = fs2;
    void _check;
  });
});
