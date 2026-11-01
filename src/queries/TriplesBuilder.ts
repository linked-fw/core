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
 * const refs = await TriplesBuilder.toNode({id: term}).from(graphs.allOntologies).exec(dataset);
 * const used = await TriplesBuilder.withPredicate({id: p}).from(dataGraphs).exists(dataset);
 * const draft = await DraftGraph.readContent(graph).limit(1001).exec(dataset);
 * ```
 *
 * `forNode` reads one subject's triples, `toNode` the triples that point at a node,
 * `withPredicate` the triples of one predicate (in named graphs only); `NamedGraph.readContent(graph)`
 * (and its subclasses) builds a graph read. `.withPredicate(p)` narrows any of them to one
 * predicate, and `.exists()` asks whether the read finds a triple at all. Each builder sends exactly
 * one query; chaining returns a new builder.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import type {NodeReferenceValue} from './QueryFactory.js';
import {dispatchTriplesQuery} from './queryDispatch.js';
import type {ReadGraphsInput} from './readGraphs.js';
import {
  checkTriplesTerm,
  triplesQueryOf,
  triplesQueryPartsOf,
  type Triple,
  type TriplesQuery,
} from './triplesQuery.js';
import {brandLinkedClass} from '../utils/linkedError.js';

export class TriplesBuilder implements PromiseLike<Triple[]> {
  /** Each part is checked; whether the parts make a whole read is checked when it is sent. */
  private constructor(private readonly query: TriplesQuery) {}

  /**
   * Read the triples of one subject (as a subject), under any type or none: in the graphs of
   * `.from()`, else where a shapeless ask of it looks (the default graph, or every graph the
   * store's routing knows). Without a shape there is no routing key, so `LinkedStorage` reads it in
   * every dataset it knows (as it asks a shapeless ask) and joins the answers.
   */
  static forNode(node: NodeReferenceValue): TriplesBuilder {
    return new TriplesBuilder(triplesQueryPartsOf({subject: checkTriplesTerm('subject', node?.id)}));
  }

  /**
   * Read the triples whose object is this node (the triples that point at it), under any
   * predicate: in the graphs of `.from()`, else where a shapeless ask of it looks, as
   * {@link forNode} does. A node only: a literal object is not read this way.
   */
  static toNode(node: NodeReferenceValue): TriplesBuilder {
    return new TriplesBuilder(triplesQueryPartsOf({object: checkTriplesTerm('object', node?.id)}));
  }

  /**
   * Read the triples with this predicate, in the graphs of `.from()`. It needs them: a predicate
   * read names the graphs it reads, so a read sent without `.from()` is refused.
   */
  static withPredicate(predicate: NodeReferenceValue): TriplesBuilder {
    return new TriplesBuilder(triplesQueryPartsOf({predicate: checkTriplesTerm('predicate', predicate?.id)}));
  }

  /** @internal The builder of a checked query (`NamedGraph.readContent`). */
  static of(query: TriplesQuery): TriplesBuilder {
    return new TriplesBuilder(triplesQueryOf(query));
  }

  /**
   * Read only in these graphs (a graph IRI or a list, portable names included); returns a new
   * builder. A graph read names its graph already, so it has no `.from()`.
   */
  from(graphs: ReadGraphsInput): TriplesBuilder {
    if (this.query.recordClass !== undefined) {
      throw new Error('A graph read names its graph (readContent(graph)); .from() is for a node or predicate read.');
    }
    return new TriplesBuilder(triplesQueryPartsOf({...this.query, graphs}));
  }

  /** Narrow this read to the triples with this predicate; returns a new builder. */
  withPredicate(predicate: NodeReferenceValue): TriplesBuilder {
    return new TriplesBuilder(triplesQueryPartsOf({...this.query, predicate: checkTriplesTerm('predicate', predicate?.id)}));
  }

  /** At most `n` triples (no order is implied); returns a new builder. */
  limit(n: number): TriplesBuilder {
    return new TriplesBuilder(triplesQueryPartsOf({...this.query, limit: n}));
  }

  /**
   * The triples read this builder sends (plain data, its own wire form). Throws for a read that is
   * not whole yet (`withPredicate(p)` without `.from()`).
   */
  toTriplesQuery(): TriplesQuery {
    return triplesQueryOf(this.query);
  }

  /** Send the read: to `target` when given, else through the global dispatch (`LinkedStorage`). */
  async exec(target?: IDataset): Promise<Triple[]> {
    return dispatchTriplesQuery(this.toTriplesQuery(), target);
  }

  /**
   * Whether the read finds any triple: the same read with `limit: 1`, `true` when a triple comes
   * back. A SPARQL store stops at the first match (`SELECT … LIMIT 1`), and `LinkedStorage` stops at
   * the first dataset that answers one. This builder's own limit is unchanged.
   */
  async exists(target?: IDataset): Promise<boolean> {
    const triples = await dispatchTriplesQuery({...this.toTriplesQuery(), limit: 1}, target);
    return triples.length > 0;
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
