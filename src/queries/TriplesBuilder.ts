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
 * const usedOnes = await TriplesBuilder.withPredicate([{id: p}, {id: q}]).from(dataGraphs).whichExist(dataset);
 * const draft = await DraftGraph.readContent(graph).limit(1001).exec(dataset);
 * ```
 *
 * `forNode` reads one subject's triples, `toNode` the triples that point at a node,
 * `withPredicate` the triples of one predicate (in named graphs only); `NamedGraph.readContent(graph)`
 * (and its subclasses) builds a graph read. `.withPredicate(p)` narrows any of them to one
 * predicate, and `.exists()` asks whether the read finds a triple at all. Each builder sends exactly
 * one query; chaining returns a new builder.
 *
 * `toNode` and `withPredicate` also take a list of terms: a terms read, whose `.whichExist()`
 * answers which of them occur (the IRIs some triple of the read has in that position), in one query
 * (`IDataset.triplesTermsQuery`; a store may split a long list). A terms read answers terms, not
 * triples, so it has no `exec()`.
 */
import type {IDataset} from '../interfaces/IDataset.js';
import type {NodeReferenceValue} from './QueryFactory.js';
import {dispatchTriplesQuery, dispatchTriplesTermsQuery} from './queryDispatch.js';
import type {ReadGraphsInput} from './readGraphs.js';
import {
  checkTriplesTerm,
  checkTriplesTerms,
  triplesQueryOf,
  triplesTermsPosition,
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
   * {@link forNode} does. A node only: a literal object is not read this way. Given a list of
   * nodes, a terms read: {@link whichExist} answers the ones some triple points at.
   */
  static toNode(node: NodeReferenceValue | readonly NodeReferenceValue[]): TriplesBuilder {
    return new TriplesBuilder(
      triplesQueryPartsOf(
        isTermList(node)
          ? {objects: checkTriplesTerms('object', node.map((n) => n?.id))}
          : {object: checkTriplesTerm('object', node?.id)},
      ),
    );
  }

  /**
   * Read the triples with this predicate, in the graphs of `.from()`. It needs them: a predicate
   * read names the graphs it reads, so a read sent without `.from()` is refused. Given a list of
   * predicates, a terms read: {@link whichExist} answers the ones some triple has.
   */
  static withPredicate(predicate: NodeReferenceValue | readonly NodeReferenceValue[]): TriplesBuilder {
    return new TriplesBuilder(triplesQueryPartsOf(predicateParts(predicate)));
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

  /**
   * Narrow this read to the triples with this predicate; returns a new builder. Given a list, a
   * terms read of those predicates (not on a read that lists its objects already).
   */
  withPredicate(predicate: NodeReferenceValue | readonly NodeReferenceValue[]): TriplesBuilder {
    const {predicate: _one, predicates: _list, ...rest} = this.query;
    return new TriplesBuilder(triplesQueryPartsOf({...rest, ...predicateParts(predicate)}));
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

  /**
   * Send the read: to `target` when given, else through the global dispatch (`LinkedStorage`). A
   * terms read (a list of terms) is refused: it answers terms, through {@link whichExist}.
   */
  async exec(target?: IDataset): Promise<Triple[]> {
    const query = this.toTriplesQuery();
    if (triplesTermsPosition(query) !== undefined) throw termsReadExec();
    return dispatchTriplesQuery(query, target);
  }

  /**
   * Whether the read finds any triple: the same read with `limit: 1`, `true` when a triple comes
   * back. A SPARQL store stops at the first match (`SELECT … LIMIT 1`), and `LinkedStorage` stops at
   * the first dataset that answers one. This builder's own limit is unchanged. A terms read: whether
   * any of its terms occurs.
   */
  async exists(target?: IDataset): Promise<boolean> {
    const query = this.toTriplesQuery();
    if (triplesTermsPosition(query) !== undefined) return (await this.whichExist(target)).size > 0;
    const triples = await dispatchTriplesQuery({...query, limit: 1}, target);
    return triples.length > 0;
  }

  /**
   * Which terms of a terms read occur (`toNode([…])`, `withPredicate([…])`): the IRIs of its list
   * that some triple of the read has in that position. One query (`IDataset.triplesTermsQuery`)
   * that stops at the first match of each term; an empty list answers an empty set without one.
   * Throws for a read without a list. A limit set on the builder is not part of it.
   */
  async whichExist(target?: IDataset): Promise<Set<string>> {
    const {limit: _limit, ...query} = this.toTriplesQuery();
    if (triplesTermsPosition(query) === undefined) {
      throw new Error(
        'whichExist() answers which terms of a list occur; build the read with a list: ' +
          'toNode([{id}, …]) or withPredicate([{id}, …]). For one term, use exists().',
      );
    }
    return new Set(await dispatchTriplesTermsQuery(query, target));
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

function isTermList(value: NodeReferenceValue | readonly NodeReferenceValue[]): value is readonly NodeReferenceValue[] {
  return Array.isArray(value);
}

function predicateParts(predicate: NodeReferenceValue | readonly NodeReferenceValue[]): {predicate: string} | {predicates: string[]} {
  return isTermList(predicate)
    ? {predicates: checkTriplesTerms('predicate', predicate.map((p) => p?.id))}
    : {predicate: checkTriplesTerm('predicate', predicate?.id)};
}

function termsReadExec(): Error {
  return new Error(
    'A terms read (toNode([…]) or withPredicate([…])) answers which of its terms occur, not ' +
      'triples: send it with whichExist(). To read triples, name one term.',
  );
}
