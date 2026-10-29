/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A store for the sync tests that keeps the graph registry in memory: graph queries create,
 * replace and drop graphs (record and content), selects of `ShapesGraph` / `OntologyGraph`
 * records answer from them, the inference probe answers `'named-graphs'`, everything else reads
 * empty. `failing` makes every read and graph query throw.
 */
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import type {GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import {OntologyGraph, ShapesGraph} from '../shapes/NamedGraph';
import {inferenceProbeAnswer, isInferenceProbeGraph} from './test-utils';

export interface MemoryGraph {
  recordClass: string;
  record: Record<string, unknown>;
  contentHash?: string;
  text?: string;
}

/** The shape a select reads (the IR's root, or the DSL-JSON's `shape`). */
const shapeOf = (query: any): string | undefined => {
  const shape = query?.root?.shape ?? query?.shape;
  return typeof shape === 'string' ? shape : shape?.id;
};

export class MemoryGraphStore extends SparqlDataset {
  graphs = new Map<string, MemoryGraph>();
  /** The sync's graph queries (the probe's left out). */
  graphQueries: GraphQuery[] = [];
  failing = false;

  constructor(readonly id: string) {
    super();
  }

  private check(): void {
    if (this.failing) throw new Error(`store ${this.id} is down`);
  }

  /** The graphs of one record class, as the record readers select them. */
  private rows(recordClass: string) {
    return [...this.graphs]
      .filter(([, g]) => g.recordClass === recordClass)
      .map(([id, g]) => ({id, ...g.record, contentHash: g.contentHash}));
  }

  override async askQuery(query: any): Promise<boolean> {
    this.check();
    return inferenceProbeAnswer(query, 'named-graphs') ?? false;
  }

  override async selectQuery(query: any): Promise<any> {
    this.check();
    const shape = shapeOf(query);
    if (shape === ShapesGraph.shape.id) return this.rows(ShapesGraph.targetClass.id);
    if (shape === OntologyGraph.shape.id) return this.rows(OntologyGraph.targetClass.id);
    return [];
  }

  override async graphQuery(query: GraphQuery): Promise<GraphResult> {
    this.check();
    if (!isInferenceProbeGraph(query.graph)) {
      this.graphQueries.push(query);
      const existing = this.graphs.get(query.graph);
      if (query.kind === 'graph_drop') this.graphs.delete(query.graph);
      else if (query.kind === 'graph_create' || query.kind === 'graph_replace') {
        this.graphs.set(query.graph, {
          recordClass: query.recordClass,
          record: {...(existing?.record ?? {}), ...(query.record ?? {})},
          contentHash: query.contentHash,
          text: query.content?.text,
        });
      }
    }
    return {graph: query.graph, contentHash: query.contentHash, changed: true};
  }

  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    this.check();
    return {head: {vars: []}, results: {bindings: []}};
  }

  protected async executeSparqlUpdate(): Promise<void> {
    this.check();
  }
}
