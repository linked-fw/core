/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The request the ontology sync's `default` mode sends a store (`IDataset.replaceDefaultGraphTerms`):
 * replace a set of terms in the default graph in one update. A SPARQL store compiles it with
 * `defaultGraphTermsToSparql` (`sparql/defaultGraphTerms.ts`).
 *
 * @module @_linked/core/queries/defaultGraphTerms
 */

/**
 * How many blank-node steps below a term the delete follows. A step is one link to a blank node
 * and then any number of `rdf:rest` links along a list, so an OWL restriction inside a union
 * inside a restriction is three steps, however long the list. Deeper structures are refused
 * before anything is sent.
 */
export const DEFAULT_GRAPH_TERMS_DEPTH = 8;

/** Replace terms in the default graph: delete the terms (see the fields), then insert `insert`. */
export interface DefaultGraphTermsReplace {
  /** Every IRI subject that starts with one of these namespaces is deleted. */
  namespaces: string[];
  /** And every one of these IRI subjects. */
  subjects: string[];
  /**
   * The triples written after the delete, as N-Triples (blank-node labels are fresh in the
   * store). Empty for a delete only.
   */
  insert: string;
}
