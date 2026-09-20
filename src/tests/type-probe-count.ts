/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Type probe for the root COUNT.
 *
 * This file is NOT a test — it is compiled by `npm run typecheck` (tsconfig-tests
 * includes all of `src`), and it fails the build if the inference below regresses.
 *
 * What it pins: `.count()` answers `number` **regardless of the builder's projection
 * generics**. That is the whole reason `CountBuilder` is non-generic — `SelectBuilder`
 * carries `<S, R, Result>` and threads a precise row type through them, and a count
 * must not participate in, widen, or be widened by any of it.
 */
import {Person, Dog} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {CountBuilder} from '../queries/CountBuilder';
import {Shape} from '../shapes/Shape';
import type {CountQuery} from '../queries/CountQuery';
import type {IDataset} from '../interfaces/IDataset';
import type {SparqlDataset} from '../sparql/SparqlDataset';

/** Compile-time assertion that `T` is exactly `Expected` (invariant, not assignable). */
type Exact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;
const exact = <Expected>() => <T>(_probe: T & (Exact<T, Expected> extends true ? unknown : never)) => {};

const expectNumberPromise = exact<Promise<number>>();
const expectNumber = exact<number>();
const expectCountBuilder = exact<CountBuilder>();

// ---------------------------------------------------------------------------
// PROBE 1: `.count()` is Promise<number> whatever the projection was
// ---------------------------------------------------------------------------

expectNumberPromise(SelectBuilder.from(Person).count());
expectNumberPromise(SelectBuilder.from(Person).select((p) => p.name).count());
expectNumberPromise(
  SelectBuilder.from(Person).select((p) => [p.name, p.friends.name]).count(),
);
expectNumberPromise(
  SelectBuilder.from(Person).select((p) => ({n: p.name, h: p.hobby})).count(),
);
expectNumberPromise(SelectBuilder.from(Person).selectAll().count());
// After `.for()` — which unwraps the array Result type — the count is still a number.
expectNumberPromise(SelectBuilder.from(Person).for({id: 'x'}).count());
// And with an explicit dataset target.
expectNumberPromise(SelectBuilder.from(Person).count(null as unknown as IDataset));

// ---------------------------------------------------------------------------
// PROBE 2: from a shape IRI alone — the consumer's entry point
// ---------------------------------------------------------------------------

// `@_linked/shape-ui` holds a shape IRI and a where clause, nothing else.
expectNumberPromise(
  SelectBuilder.from<Person>('https://linked.cm/shape/core/Person')
    .where((p) => p.name.equals('Semmy'))
    .count(),
);

// ---------------------------------------------------------------------------
// PROBE 3: `toCount()` is a CountBuilder, and awaiting one yields a number
// ---------------------------------------------------------------------------

expectCountBuilder(SelectBuilder.from(Person).toCount());
// Non-generic: the projection generics do not leak into the count builder's type,
// so these are the SAME type and this assignment compiles.
const fromProjected: CountBuilder = SelectBuilder.from(Person)
  .select((p) => [p.name])
  .toCount();
const fromBare: CountBuilder = SelectBuilder.from(Dog).toCount();
const swapped: CountBuilder = fromProjected;
void fromBare;
void swapped;

async function awaited(): Promise<void> {
  expectNumber(await SelectBuilder.from(Person).toCount());
  expectNumber(await SelectBuilder.from(Person).toCount().exec());
  expectNumber(await Person.count());
  expectNumber(await Shape.count());
}
void awaited;

// ---------------------------------------------------------------------------
// PROBE 4: a CountBuilder satisfies the CountQuery interface a dataset receives
// ---------------------------------------------------------------------------

const asQuery: CountQuery = SelectBuilder.from(Person).toCount();
void asQuery;

// A count rides the select channel, so `IDataset.selectQuery` accepts it. The
// interface's answer is deliberately the wide `SelectResult | number`: narrowing it
// per query kind would need overloads, and an overloaded member cannot be satisfied
// by the single-signature object literals that implement this interface everywhere.
// `resolveCount` is what turns the wide answer into a checked number.
declare const dataset: IDataset;
async function viaDataset(): Promise<void> {
  void (await dataset.selectQuery(asQuery));
}
void viaDataset;

// A store extending SparqlDataset answers it as a `number` — the concrete class
// overloads `selectQuery` on the query kind, which is where the precision belongs.
declare const sparqlStore: SparqlDataset;
async function viaSparqlDataset(): Promise<void> {
  expectNumber(await sparqlStore.selectQuery(asQuery));
  // And the select half of the same overload is untouched.
  const rows = await sparqlStore.selectQuery(SelectBuilder.from(Person));
  void rows;
}
void viaSparqlDataset;

// ---------------------------------------------------------------------------
// PROBE 5: the select chain is unchanged by the presence of count
// ---------------------------------------------------------------------------

async function selectStillInfers(): Promise<void> {
  const rows = await SelectBuilder.from(Person).select((p) => p.name);
  // Still a row array with a typed `name`, exactly as before.
  const name: string | null | undefined = rows[0].name;
  void name;
}
void selectStillInfers;
