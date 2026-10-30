/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * `TriplesBuilder` — a shapeless read whose answer is triples (see `triplesQuery.ts`).
 *
 * ```ts
 * const triples = await TriplesBuilder.forNode({id}).from(importGraph).exec(dataset);
 * const draft = await DraftGraph.readContent(graph).limit(1001).exec(dataset);
 * ```
 *
 * `forNode` reads one subject's triples; `NamedGraph.readContent(graph)` (and its subclasses)
 * builds a graph read. Each builder sends exactly one query; chaining returns a new builder.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import type {NodeReferenceValue} from './QueryFactory.js';
import {dispatchTriplesQuery} from './queryDispatch.js';
import type {ReadGraphsInput} from './readGraphs.js';
import {triplesQueryOf, type Triple, type TriplesQuery} from './triplesQuery.js';
import {brandLinkedClass} from '../utils/linkedError.js';

export class TriplesBuilder implements PromiseLike<Triple[]> {
  private constructor(private readonly query: TriplesQuery) {}

  /**
   * Read the triples of one subject (as a subject), under any type or none: in the graphs of
   * `.from()`, else where a shapeless ask of it looks (the default graph, or every graph the
   * store's routing knows). Without a shape there is no routing key, so `LinkedStorage` reads it in
   * every dataset it knows (as it asks a shapeless ask) and joins the answers.
   */
  static forNode(node: NodeReferenceValue): TriplesBuilder {
    return new TriplesBuilder(triplesQueryOf({subject: node?.id}));
  }

  /** @internal The builder of a checked query (`NamedGraph.readContent`). */
  static of(query: TriplesQuery): TriplesBuilder {
    return new TriplesBuilder(triplesQueryOf(query));
  }

  /**
   * Read the subject only in these graphs (a graph IRI or a list, portable names included); returns
   * a new builder. A graph read names its graph already, so it has no `.from()`.
   */
  from(graphs: ReadGraphsInput): TriplesBuilder {
    if (this.query.subject === undefined) {
      throw new Error('A graph read names its graph (readContent(graph)); .from() is for a subject read.');
    }
    return new TriplesBuilder(triplesQueryOf({...this.query, graphs}));
  }

  /** At most `n` triples (no order is implied); returns a new builder. */
  limit(n: number): TriplesBuilder {
    return new TriplesBuilder(triplesQueryOf({...this.query, limit: n}));
  }

  /** The triples read this builder sends (plain data, its own wire form). */
  toTriplesQuery(): TriplesQuery {
    return {...this.query, ...(this.query.graphs ? {graphs: [...this.query.graphs]} : {})};
  }

  /** Send the read: to `target` when given, else through the global dispatch (`LinkedStorage`). */
  async exec(target?: IDataset): Promise<Triple[]> {
    return dispatchTriplesQuery(this.toTriplesQuery(), target);
  }

  then<TResult1 = Triple[], TResult2 = never>(
    onfulfilled?: ((value: Triple[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<Triple[] | TResult> {
    return this.exec().catch(onrejected);
  }
}
brandLinkedClass(TriplesBuilder, '@_linked/core', 'TriplesBuilder');
