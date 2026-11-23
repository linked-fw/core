/**
 * Type probe for deep nesting & boundary cases of the FieldSet<R, Source>
 * type inference system.
 *
 * Tests the limits of QueryResponseToResultType when sub-selects are nested
 * multiple levels deep, combined with other operations, or used in edge cases.
 *
 * Run with: npx tsc --noEmit src/tests/type-probe-deep-nesting.ts
 * If it compiles, all type inferences are correct.
 */
import {Person, Dog, Pet, Employee} from '../test-helpers/query-fixtures';
import type {
  QueryResponseToResultType,
  QueryBuildFn,
} from '../queries/SelectQuery';
import {Shape} from '../shapes/Shape';
import {FieldSet} from '../queries/FieldSet';
import {QueryBuilder} from '../queries/QueryBuilder';

const expectType = <T>(_value: T) => _value;

// Helper: simulates QueryBuilder.select() return type
type SimulatedResult<S extends Shape, R> = QueryResponseToResultType<R, S>[];
declare function fakeSelect<S extends Shape, NewR>(
  shape: abstract new (...args: any[]) => S,
  fn: QueryBuildFn<S, NewR>,
): {result: SimulatedResult<S, NewR>};

// PromiseLike-based builder (matches real QueryBuilder behavior)
type OneResult<R> = R extends (infer E)[] ? E : R;
declare class PromiseBuilder<S extends Shape, R = any, Result = any>
  implements PromiseLike<Result>
{
  select<NewR>(fn: QueryBuildFn<S, NewR>): PromiseBuilder<S, NewR, QueryResponseToResultType<NewR, S>[]>;
  where(fn: any): PromiseBuilder<S, R, Result>;
  limit(n: number): PromiseBuilder<S, R, Result>;
  one(): PromiseBuilder<S, R, Result extends (infer E)[] ? E : Result>;
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}
declare function promiseFrom<S extends Shape>(shape: abstract new (...args: any[]) => S): PromiseBuilder<S>;

// =============================================================================
// TEST 1: Triple-nested sub-selects (3 levels of .select())
// Person → friends.select → bestFriend.select → friends.select
//
// KNOWN LIMITATION: At 3 levels of .select() nesting, the type system loses
// the inner property structure. The innermost sub-select result collapses
// into a flat QResult instead of preserving the friends[] array wrapper.
// 2 levels of .select() works correctly (see type-probe-4.4a.ts TEST fb4).
// =============================================================================
const t1 = promiseFrom(Person).select((p) =>
  p.friends.select((f) =>
    f.bestFriend.select((bf) =>
      bf.friends.select((ff) => ({name: ff.name, hobby: ff.hobby})),
    ),
  ),
);
type T1Result = Awaited<typeof t1>;
const _t1: T1Result = null as any;
// All 3 levels resolve correctly!
expectType<string | undefined>(_t1[0].friends[0].id);
expectType<string | null | undefined>(_t1[0].friends[0].bestFriend.friends[0].name);
expectType<string | null | undefined>(_t1[0].friends[0].bestFriend.friends[0].hobby);

// =============================================================================
// TEST 2: Multiple sub-selects in same custom object
//
// NOTE: When sub-selects are used as values in a custom object, the custom
// key names ARE preserved in the result type. However, the inner sub-select
// result is wrapped with the SOURCE property name (from the query builder),
// not the custom key. So {friendNames: p.friends.select(...)} gives
// {friendNames: {friends: [...]}} — the custom key wraps the source-named result.
// =============================================================================
const t2 = promiseFrom(Person).select((p) => ({
  friendNames: p.friends.select((f) => f.name),
  bestFriendInfo: p.bestFriend.select((bf) => ({name: bf.name, hobby: bf.hobby})),
}));
type T2Result = Awaited<typeof t2>;
const _t2: T2Result = null as any;
// A key names the sub-select's member rows: friendNames holds the friends' rows,
// bestFriendInfo the best friend's row (no relation key in between).
expectType<string | null | undefined>(_t2[0].friendNames[0].name);
expectType<string | null | undefined>(_t2[0].bestFriendInfo.name);
expectType<string | null | undefined>(_t2[0].bestFriendInfo.hobby);

// =============================================================================
// TEST 3: Sub-select with .size() in same custom object
// Mixing a count operation with a sub-select at the same level
// =============================================================================
const t3 = promiseFrom(Person).select((p) => ({
  numFriends: p.friends.size(),
  friendDetails: p.friends.select((f) => ({name: f.name})),
}));
type T3Result = Awaited<typeof t3>;
const _t3: T3Result = null as any;
expectType<number>(_t3[0].numFriends);
expectType<string | null | undefined>(_t3[0].friendDetails[0].name);

// =============================================================================
// TEST 4: Sub-select returning an array of paths (not a custom object)
// =============================================================================
const t4 = promiseFrom(Person).select((p) =>
  p.friends.select((f) => [f.name, f.hobby, f.birthDate]),
);
type T4Result = Awaited<typeof t4>;
const _t4: T4Result = null as any;
expectType<string | null | undefined>(_t4[0].friends[0].name);
expectType<string | null | undefined>(_t4[0].friends[0].hobby);
expectType<Date | null | undefined>(_t4[0].friends[0].birthDate);

// =============================================================================
// TEST 5: Sub-select on singular property (bestFriend) returning array of paths
// =============================================================================
const t5 = promiseFrom(Person).select((p) =>
  p.bestFriend.select((bf) => [bf.name, bf.hobby, bf.isRealPerson]),
);
type T5Result = Awaited<typeof t5>;
const _t5: T5Result = null as any;
// bestFriend is singular → should NOT be an array
expectType<string | null | undefined>(_t5[0].bestFriend.name);
expectType<string | null | undefined>(_t5[0].bestFriend.hobby);
expectType<boolean | null | undefined>(_t5[0].bestFriend.isRealPerson);

// =============================================================================
// TEST 6: Sub-select inside sub-select, inner returns custom object with .size()
// =============================================================================
const t6 = promiseFrom(Person).select((p) =>
  p.friends.select((f) => ({
    name: f.name,
    numFriends: f.friends.size(),
  })),
);
type T6Result = Awaited<typeof t6>;
const _t6: T6Result = null as any;
expectType<string | null | undefined>(_t6[0].friends[0].name);
expectType<number>(_t6[0].friends[0].numFriends);

// =============================================================================
// TEST 7: Double nested sub-select through singular → plural
// Person → bestFriend.select → friends.select → custom object
// =============================================================================
const t7 = promiseFrom(Person).select((p) =>
  p.bestFriend.select((bf) =>
    bf.friends.select((f) => ({name: f.name, hobby: f.hobby})),
  ),
);
type T7Result = Awaited<typeof t7>;
const _t7: T7Result = null as any;
// bestFriend is singular, friends is plural
expectType<string | null | undefined>(_t7[0].bestFriend.friends[0].name);
expectType<string | null | undefined>(_t7[0].bestFriend.friends[0].hobby);

// =============================================================================
// TEST 8: Double nested sub-select through plural → singular
// Person → friends.select → bestFriend.select → custom object
// =============================================================================
const t8 = promiseFrom(Person).select((p) =>
  p.friends.select((f) =>
    f.bestFriend.select((bf) => ({name: bf.name, isReal: bf.isRealPerson})),
  ),
);
type T8Result = Awaited<typeof t8>;
const _t8: T8Result = null as any;
// friends is plural, bestFriend is singular
expectType<string | null | undefined>(_t8[0].friends[0].bestFriend.name);
expectType<boolean | null | undefined>(_t8[0].friends[0].bestFriend.isReal);

// =============================================================================
// TEST 9: Sub-select combined with plain property paths in array
// Mixed: some elements are sub-selects, some are plain paths
// =============================================================================
const t9 = promiseFrom(Person).select((p) => [
  p.name,
  p.friends.select((f) => ({name: f.name, hobby: f.hobby})),
]);
type T9Result = Awaited<typeof t9>;
const _t9: T9Result = null as any;
expectType<string | null | undefined>(_t9[0].name);
expectType<string | null | undefined>(_t9[0].friends[0].name);
expectType<string | null | undefined>(_t9[0].friends[0].hobby);

// =============================================================================
// TEST 10: Multiple sub-selects in array (not custom object)
// =============================================================================
const t10 = promiseFrom(Person).select((p) => [
  p.friends.select((f) => ({name: f.name})),
  p.bestFriend.select((bf) => ({hobby: bf.hobby})),
]);
type T10Result = Awaited<typeof t10>;
const _t10: T10Result = null as any;
expectType<string | null | undefined>(_t10[0].friends[0].name);
expectType<string | null | undefined>(_t10[0].bestFriend.hobby);

// =============================================================================
// TEST 11: Sub-select with polymorphic .as() cast
// Person → pets.as(Dog).select → guardDogLevel
// =============================================================================
const t11 = promiseFrom(Person).select((p) =>
  p.pets.as(Dog).guardDogLevel,
);
type T11Result = Awaited<typeof t11>;
const _t11: T11Result = null as any;
expectType<number | null | undefined>(_t11[0].pets[0].guardDogLevel);

// =============================================================================
// TEST 12: Sub-select on Employee (subclass of Person)
// Tests that inheritance doesn't break type inference
// =============================================================================
const t12 = promiseFrom(Employee).select((e) =>
  e.bestFriend.select((bf) => ({name: bf.name, dept: bf.department})),
);
type T12Result = Awaited<typeof t12>;
const _t12: T12Result = null as any;
expectType<string | null | undefined>(_t12[0].bestFriend.name);
expectType<string | null | undefined>(_t12[0].bestFriend.dept);

// =============================================================================
// TEST 13: Sub-select + .one() unwrapping
// =============================================================================
const t13 = promiseFrom(Person)
  .select((p) =>
    p.friends.select((f) => ({name: f.name, hobby: f.hobby})),
  )
  .one();
type T13Result = Awaited<typeof t13>;
const _t13: T13Result = null as any;
// .one() should unwrap the outer array but sub-select arrays remain
expectType<string | null | undefined>(_t13.friends[0].name);
expectType<string | null | undefined>(_t13.friends[0].hobby);

// =============================================================================
// TEST 14: Sub-select + where + limit chain
// Verifies that chaining doesn't lose sub-select type info
// =============================================================================
const t14 = promiseFrom(Person)
  .select((p) =>
    p.friends.select((f) => ({name: f.name})),
  )
  .where(null)
  .limit(5);
type T14Result = Awaited<typeof t14>;
const _t14: T14Result = null as any;
expectType<string | null | undefined>(_t14[0].friends[0].name);

// =============================================================================
// TEST 15: selectAll() on a sub-select (plural)
// =============================================================================
const t15 = promiseFrom(Person).select((p) =>
  p.friends.selectAll(),
);
type T15Result = Awaited<typeof t15>;
const _t15: T15Result = null as any;
expectType<string | undefined>(_t15[0].friends[0].id);
expectType<string | null | undefined>(_t15[0].friends[0].name);
expectType<string | null | undefined>(_t15[0].friends[0].hobby);

// =============================================================================
// TEST 16: selectAll() on a sub-select (singular)
// =============================================================================
const t16 = promiseFrom(Person).select((p) =>
  p.bestFriend.selectAll(),
);
type T16Result = Awaited<typeof t16>;
const _t16: T16Result = null as any;
expectType<string | undefined>(_t16[0].bestFriend.id);
expectType<string | null | undefined>(_t16[0].bestFriend.name);
expectType<string | null | undefined>(_t16[0].bestFriend.hobby);

// =============================================================================
// TEST 17: Deep chain — property path + sub-select at 4th level
// Person → friends → bestFriend → friends.select → name
//
// Deep property chains (3+ levels) before .select() now correctly resolve
// by continuing to unwind the source chain through CreateShapeSetQResult.
// =============================================================================
const t17 = promiseFrom(Person).select((p) =>
  p.friends.bestFriend.friends.select((ff) => ({name: ff.name})),
);
type T17Result = Awaited<typeof t17>;
const _t17: T17Result = null as any;
// All levels of the property chain resolve correctly
expectType<string | undefined>(_t17[0].friends[0].id);
expectType<string | null | undefined>(_t17[0].friends[0].bestFriend.friends[0].name);

// =============================================================================
// TEST 18: QueryBuilder (real) — triple nested sub-select
// Uses actual QueryBuilder instead of the PromiseBuilder simulation
// =============================================================================
const t18 = QueryBuilder.from(Person).select((p) =>
  p.friends.select((f) =>
    f.bestFriend.select((bf) => ({name: bf.name, hobby: bf.hobby})),
  ),
);
type T18Result = Awaited<typeof t18>;
const _t18: T18Result = null as any;
expectType<string | null | undefined>(_t18[0].friends[0].bestFriend.name);
expectType<string | null | undefined>(_t18[0].friends[0].bestFriend.hobby);

// =============================================================================
// TEST 19: QueryBuilder (real) — multiple sub-selects in custom object
// Same behavior as TEST 2: each key holds the member row(s) of its sub-select.
// =============================================================================
const t19 = QueryBuilder.from(Person).select((p) => ({
  friendNames: p.friends.select((f) => f.name),
  bestFriendHobby: p.bestFriend.select((bf) => bf.hobby),
}));
type T19Result = Awaited<typeof t19>;
const _t19: T19Result = null as any;
expectType<string | null | undefined>(_t19[0].friendNames[0].name);
expectType<string | null | undefined>(_t19[0].bestFriendHobby.hobby);

// =============================================================================
// TEST 20: QueryBuilder (real) — sub-select with count in custom object
// =============================================================================
const t20 = QueryBuilder.from(Person).select((p) => ({
  numFriends: p.friends.size(),
  friendDetails: p.friends.select((f) => ({name: f.name})),
}));
type T20Result = Awaited<typeof t20>;
const _t20: T20Result = null as any;
expectType<number>(_t20[0].numFriends);
expectType<string | null | undefined>(_t20[0].friendDetails[0].name);

console.log('Deep nesting type probe compiled successfully.');
