/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Named graphs and the graph registry.
 *
 * Every graph a dataset keeps on purpose (a package's ontology data, its shapes, ontology-editor
 * drafts) has a record in the graph registry (`graphs.registry`): its name, content hash, load
 * time, sources and whether it feeds the store's class hierarchy. The record's class is the
 * graph's kind: `OntologyGraph`, `ShapesGraph`, `ComponentsGraph` and `DraftGraph` all extend `NamedGraph`
 * (`sd:NamedGraph`), so selecting `NamedGraph` returns every kind's records through the store's
 * inference.
 *
 * The statics change a graph and its record together, each call as exactly one graph query
 * (`IDataset.graphQuery`) and one transaction in the store:
 *
 * ```ts
 * const g = OntologyGraph.iriFor('@_linked/schema');
 * await OntologyGraph.create({id: g, package: '@_linked/schema', version: '1.7.0'}).withContent(c);
 * await OntologyGraph.update(g).set({version: '1.8.0'}).replaceContent(c2);
 * await NamedGraph.patchContent(g, {insert, delete: del});
 * const triples = await OntologyGraph.readContent(g); // a read: every triple of the graph
 * await OntologyGraph.delete(g);
 * const records = await NamedGraph.select((r) => [r.name, r.contentHash]);
 * ```
 *
 * The record's automatic fields (`sd:name`, `core:contentHash`, `dcterms:modified`) follow every
 * body change; the caller passes only the class's own fields. Graph queries are server-only: a
 * call in a browser throws (importing this module does not).
 */
import {linkedShape} from '../package.js';
import {Shape} from './Shape.js';
import {getPackageUri, literalProperty, objectProperty} from './SHACL.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {sd} from '../ontologies/sd.js';
import {shacl} from '../ontologies/shacl.js';
import {xsd} from '../ontologies/xsd.js';
import {graphs} from '../ontologies/graphs.js';
import {dcterms} from '../queries/graphRecords.js';
import {assertGraphWritable} from '../queries/graphQuery.js';
import {dispatchGraphQuery} from '../queries/queryDispatch.js';
import {TriplesBuilder} from '../queries/TriplesBuilder.js';
import type {
  GraphContent,
  GraphQuery,
  GraphResult,
} from '../queries/IntermediateRepresentation.js';
import type {IDataset} from '../interfaces/IDataset.js';

/** A patch of a graph's body: triples to delete, then triples to insert. */
export type GraphPatch = {insert?: GraphContent; delete?: GraphContent};

/** Options of the content-changing calls. */
export type GraphContentOptions = {
  /** A hash the caller computed (for instance a file's new hash), recorded instead of core's. */
  contentHash?: string;
};

/** The own record fields of a graph-record class `C` (its `recordFields` declaration). */
export type GraphRecordFieldsOf<C> = C extends {recordFields?: infer F} ? NonNullable<F> : never;

/** Graph queries change data, so they never run in a browser. */
function assertServerSide(call: string): void {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    throw new Error(
      `${call} is a graph query, which runs on the server only. Call it from a server ` +
        'process (a provider, a sync, a script), not from browser code.',
    );
  }
}

/**
 * One graph query, sent when awaited (or by `exec(target)`). Each builder sends exactly one
 * query; chaining returns a new builder.
 */
export class GraphQueryBuilder implements PromiseLike<GraphResult> {
  protected constructor(protected readonly query: GraphQuery) {}

  /** The graph query this builder sends. */
  toGraphQuery(): GraphQuery {
    return {...this.query};
  }

  /**
   * Send the query: to `target` when given, else through `LinkedStorage`, which routes it by the
   * record class's shape.
   */
  async exec(target?: IDataset): Promise<GraphResult> {
    assertServerSide(`${this.query.kind} on <${this.query.graph}>`);
    assertGraphWritable(this.query.graph);
    return dispatchGraphQuery(this.toGraphQuery(), target);
  }

  then<TResult1 = GraphResult, TResult2 = never>(
    onfulfilled?: ((value: GraphResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<GraphResult | TResult> {
    return this.exec().catch(onrejected);
  }

  /** @internal */
  static of(query: GraphQuery): GraphQueryBuilder {
    return new GraphQueryBuilder(query);
  }
}

/** `X.create({id, ...own})`: registers the graph (empty unless `.withContent(c)`). */
export class GraphCreateBuilder extends GraphQueryBuilder {
  /** @internal */
  static start(query: GraphQuery): GraphCreateBuilder {
    return new GraphCreateBuilder(query);
  }

  /** Register the graph with this body. */
  withContent(content: GraphContent, options?: GraphContentOptions): GraphQueryBuilder {
    return GraphQueryBuilder.of(withHash({...this.query, content}, options));
  }
}

/** `X.update(iri).set({...own})`: changes the record only, or chains a body change. */
export class GraphUpdateBuilder extends GraphQueryBuilder {
  /** @internal */
  static start(query: GraphQuery): GraphUpdateBuilder {
    return new GraphUpdateBuilder(query);
  }

  /** Replace the body as well, in the same query. */
  replaceContent(content: GraphContent, options?: GraphContentOptions): GraphQueryBuilder {
    return GraphQueryBuilder.of(
      withHash({...this.query, kind: 'graph_replace', content}, options),
    );
  }

  /** Patch the body as well, in the same query. */
  patchContent(patch: GraphPatch, options?: GraphContentOptions): GraphQueryBuilder {
    return GraphQueryBuilder.of(withHash({...this.query, kind: 'graph_patch', patch}, options));
  }
}

function withHash(query: GraphQuery, options?: GraphContentOptions): GraphQuery {
  return options?.contentHash ? {...query, contentHash: options.contentHash} : query;
}

/** The record class IRI of a graph-record class (its `targetClass`). */
function recordClassOf(cls: {targetClass?: {id?: string} | null; name?: string}): string {
  const id = cls.targetClass?.id;
  if (!id) throw new Error(`${cls.name ?? 'This class'} has no targetClass to record graphs as.`);
  return id;
}

/**
 * `Shape`'s statics without the mutation ones (`create`, `update`, `delete`, `upsert`,
 * `deleteAll`, `deleteWhere`): a graph record's `create`, `update` and `delete` are graph
 * queries with other signatures, and the rest do not apply to a record.
 */
type GraphRecordBaseStatics = Omit<
  typeof Shape,
  'create' | 'update' | 'delete' | 'upsert' | 'deleteAll' | 'deleteWhere' | 'prototype'
> &
  (abstract new (node?: string | {id?: string}) => Shape);
const GraphRecordBase = Shape as unknown as GraphRecordBaseStatics;

// Each class is registered by call, right after its declaration (a subclass's property shapes
// attach to its registered parent), with an explicit name that survives a minifier. The
// decorator form's `typeof Shape` bound does not accept these classes' graph-query statics.
const registerGraphRecordShape = (cls: object, name: string, description: string): void =>
  linkedShape({name, description})(cls as typeof Shape);

/**
 * A named graph's record in the graph registry (`sd:NamedGraph`). Its subject is the graph IRI.
 * `select()` reads the registry (`static storedInGraph`), so callers never name it.
 */
export class NamedGraph extends GraphRecordBase {
  static targetClass = sd.NamedGraph;
  /** Records live in the graph registry; reads of this shape and its subclasses go there. */
  static storedInGraph: string = graphs.registry;
  /** The own record fields of this class, for typing the statics only. */
  declare static readonly recordFields?: {sources?: string | string[]};

  /** The graph's name (its IRI; the record's subject repeats it). */
  @objectProperty({path: sd.name, maxCount: 1, nodeKind: shacl.IRI})
  get name(): {id: string} {
    return null;
  }

  /** SHA-256 (hex) of the content last written, or the hash the writer supplied. */
  @literalProperty({path: coreOntology.contentHash, datatype: xsd.string, maxCount: 1})
  get contentHash(): string {
    return null;
  }

  /** Whether the graph's `rdfs:subClassOf` triples feed the store's class hierarchy. */
  @literalProperty({path: coreOntology.feedsHierarchy, datatype: xsd.boolean, maxCount: 1})
  get feedsHierarchy(): boolean {
    return null;
  }

  /** When the content was last written. */
  @literalProperty({path: {id: dcterms.modified}, datatype: xsd.dateTime, maxCount: 1})
  get modified(): Date {
    return null;
  }

  /** Where the content came from: data files, or the URL of an import. */
  @literalProperty({path: {id: dcterms.source}, datatype: xsd.string})
  get sources(): string[] {
    return null;
  }

  /**
   * Register a graph and set its body (`.withContent(c)`; without it the graph is registered
   * empty). Refused (`graph-exists`) when the graph already has a record.
   */
  static create<C extends typeof NamedGraph>(
    this: C,
    data: {id: string} & GraphRecordFieldsOf<C>,
  ): GraphCreateBuilder {
    const {id, ...record} = data as {id: string} & Record<string, unknown>;
    return GraphCreateBuilder.start({
      kind: 'graph_create',
      graph: id,
      recordClass: recordClassOf(this),
      record,
    });
  }

  /** Change a registered graph's record: `.set({...own})`, optionally chained with a body change. */
  static update<C extends typeof NamedGraph>(
    this: C,
    iri: string,
  ): {set(fields: Partial<GraphRecordFieldsOf<C>>): GraphUpdateBuilder} {
    const recordClass = recordClassOf(this);
    return {
      set: (fields) =>
        GraphUpdateBuilder.start({
          kind: 'graph_patch',
          graph: iri,
          recordClass,
          record: {...(fields as Record<string, unknown>)},
        }),
    };
  }

  /**
   * Replace the body of a registered graph; its record's own fields are untouched. Refused
   * (`graph-not-registered`) for a graph with no record.
   */
  static replaceContent(
    this: typeof NamedGraph,
    iri: string,
    content: GraphContent,
    options?: GraphContentOptions,
  ): GraphQueryBuilder {
    return GraphQueryBuilder.of(
      withHash({kind: 'graph_replace', graph: iri, recordClass: recordClassOf(this), content}, options),
    );
  }

  /**
   * Patch the body of a registered graph (delete, then insert); its record's own fields are
   * untouched. Refused (`graph-not-registered`) for a graph with no record.
   */
  static patchContent(
    this: typeof NamedGraph,
    iri: string,
    patch: GraphPatch,
    options?: GraphContentOptions,
  ): GraphQueryBuilder {
    return GraphQueryBuilder.of(
      withHash({kind: 'graph_patch', graph: iri, recordClass: recordClassOf(this), patch}, options),
    );
  }

  /**
   * Read every triple of the graph (a triples read, `IDataset.triplesQuery`), registered or not.
   * Routed like this class's graph queries, so `DraftGraph.readContent(g)` reads where
   * `DraftGraph.replaceContent(g, c)` writes. `.limit(n)` bounds it.
   */
  static readContent(this: typeof NamedGraph, iri: string): TriplesBuilder {
    return TriplesBuilder.of({kind: 'triples', graphs: [iri], recordClass: recordClassOf(this)});
  }

  /** Drop the graph and its record. */
  static delete(this: typeof NamedGraph, iri: string): GraphQueryBuilder {
    return GraphQueryBuilder.of({kind: 'graph_drop', graph: iri, recordClass: recordClassOf(this)});
  }

  /** Not for graph records: they change through graph queries only. */
  static upsert(): never {
    throw new Error('A graph record changes through graph queries: use create(), update() or delete().');
  }

  /** Not for graph records: they change through graph queries only. */
  static deleteAll(): never {
    throw new Error('A graph record changes through graph queries: use delete(iri) per graph.');
  }

  /** Not for graph records: they change through graph queries only. */
  static deleteWhere(): never {
    throw new Error('A graph record changes through graph queries: use delete(iri) per graph.');
  }
}
registerGraphRecordShape(
  NamedGraph,
  'NamedGraph',
  "A named graph's record in the graph registry: name, content hash, load time, sources, whether it feeds the class hierarchy. (graph registry, named graph)",
);

/** A graph holding one package's whole ontology data, at `{package IRI}/graph/ontology`. Feeds the hierarchy. */
export class OntologyGraph extends NamedGraph {
  static targetClass = coreOntology.OntologyGraph;
  declare static readonly recordFields?: {
    package: string;
    version?: string;
    sources?: string | string[];
    feedsHierarchy?: boolean;
    packageHashes?: string | string[];
  };

  /** The npm name of the package. */
  @literalProperty({path: coreOntology.package, datatype: xsd.string, maxCount: 1})
  get package(): string {
    return null;
  }

  /** The package version whose data the graph holds. */
  @literalProperty({path: coreOntology.version, datatype: xsd.string, maxCount: 1})
  get version(): string {
    return null;
  }

  /**
   * A shared graph's parts (one graph for every package, see `utils/graphTargets.ts`): one
   * `"{npm name} {sha256 hex}"` per package whose data it holds. Unset on a package's own graph.
   */
  @literalProperty({path: coreOntology.packageHash, datatype: xsd.string})
  get packageHashes(): string[] {
    return null;
  }

  /** A package's ontology graph IRI: `{package IRI}/graph/ontology`. */
  static iriFor(packageName: string): string {
    return `${getPackageUri(packageName)}/graph/ontology`;
  }
}
registerGraphRecordShape(
  OntologyGraph,
  'OntologyGraph',
  "The registry record of a package's ontology graph. (graph registry, ontology graph)",
);

/** A graph holding one package's shapes, at `{package IRI}/graph/shapes`. */
export class ShapesGraph extends NamedGraph {
  static targetClass = coreOntology.ShapesGraph;
  declare static readonly recordFields?: {
    package: string;
    version?: string;
    sources?: string | string[];
    packageHashes?: string | string[];
  };

  /** The npm name of the package. */
  @literalProperty({path: coreOntology.package, datatype: xsd.string, maxCount: 1})
  get package(): string {
    return null;
  }

  /** The package version whose shapes the graph holds. */
  @literalProperty({path: coreOntology.version, datatype: xsd.string, maxCount: 1})
  get version(): string {
    return null;
  }

  /**
   * A shared graph's parts (one graph for every package, see `utils/graphTargets.ts`): one
   * `"{npm name} {sha256 hex}"` per package whose data it holds. Unset on a package's own graph.
   */
  @literalProperty({path: coreOntology.packageHash, datatype: xsd.string})
  get packageHashes(): string[] {
    return null;
  }

  /** A package's shapes graph IRI: `{package IRI}/graph/shapes`. */
  static iriFor(packageName: string): string {
    return `${getPackageUri(packageName)}/graph/shapes`;
  }
}
registerGraphRecordShape(
  ShapesGraph,
  'ShapesGraph',
  "The registry record of a package's shapes graph. (graph registry, shapes graph)",
);

/**
 * A graph holding one package's component index (the `lib/esm/data/components.ttl` its build
 * writes) at one key: a published version, or a package branch with the commit it was built from.
 * A host keeps these next to its package records; the graph IRI is the host's to choose.
 */
export class ComponentsGraph extends NamedGraph {
  static targetClass = coreOntology.ComponentsGraph;
  declare static readonly recordFields?: {
    package: string;
    version?: string;
    commit?: string;
    sources?: string | string[];
  };

  /** The npm name of the package. */
  @literalProperty({path: coreOntology.package, datatype: xsd.string, maxCount: 1})
  get package(): string {
    return null;
  }

  /** The published version whose component index the graph holds (unset for a branch build). */
  @literalProperty({path: coreOntology.version, datatype: xsd.string, maxCount: 1})
  get version(): string {
    return null;
  }

  /** The commit (40 hex) the indexed build was made from. */
  @literalProperty({path: coreOntology.commit, datatype: xsd.string, maxCount: 1})
  get commit(): string {
    return null;
  }
}
registerGraphRecordShape(
  ComponentsGraph,
  'ComponentsGraph',
  "The registry record of a package's component index graph. (graph registry, components graph)",
);

/**
 * A draft graph a dataset owns, under its data root (`{DATA_ROOT}/graph/drafts/…`, e.g.
 * `…/drafts/forms`, `…/drafts/ontology`). Never feeds the hierarchy.
 */
export class DraftGraph extends NamedGraph {
  static targetClass = coreOntology.DraftGraph;
}
registerGraphRecordShape(
  DraftGraph,
  'DraftGraph',
  'The registry record of a draft graph a dataset owns. (graph registry, draft graph)',
);
