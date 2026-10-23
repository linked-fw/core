import {SparqlDataset} from '../sparql/SparqlDataset.js';
import type {SparqlQueryResults} from '../sparql/resultMapping.js';
import type {SparqlOptions} from '../sparql/sparqlUtils.js';
import {graphs} from '../ontologies/graphs.js';

/**
 * Concrete SparqlDataset implementation for Apache Jena Fuseki.
 *
 * Demonstrates how to extend SparqlDataset with a real SPARQL endpoint.
 * Used by the integration tests to implicitly validate the base class.
 *
 * Usage:
 * ```ts
 * const store = new FusekiStore('http://localhost:3030', 'my-dataset');
 * await store.init();
 * const result = await store.selectQuery(irSelectQuery);
 * ```
 */
/** Jena's names for the portable default and union graphs. */
function jenaGraphName(iri: string): string | null {
  if (iri === graphs.default) return 'urn:x-arq:DefaultGraph';
  if (iri === graphs.union) return 'urn:x-arq:UnionGraph';
  return null;
}

export class FusekiStore extends SparqlDataset {
  private readonly queryEndpoint: string;
  private readonly updateEndpoint: string;
  private readonly baseUrl: string;
  private readonly dataset: string;
  private readonly adminAuth?: string;

  constructor(
    baseUrl: string,
    dataset: string,
    options?: SparqlOptions & {adminPassword?: string},
  ) {
    super({mapGraphName: jenaGraphName, ...options});
    this.baseUrl = baseUrl;
    this.dataset = dataset;
    this.queryEndpoint = `${baseUrl}/${dataset}/sparql`;
    this.updateEndpoint = `${baseUrl}/${dataset}/update`;

    if (options?.adminPassword) {
      this.adminAuth = `Basic ${Buffer.from(`admin:${options.adminPassword}`).toString('base64')}`;
    }
  }

  /** One registry cache per Fuseki dataset, shared by every store instance for it. */
  protected override graphRegistryKey(): string {
    return `${this.baseUrl}/${this.dataset}`;
  }

  async init(): Promise<void> {
    // Check availability (use AbortController for jsdom compatibility)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(this.baseUrl, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.status !== 200) {
      throw new Error(`Fuseki not available at ${this.baseUrl}`);
    }
  }

  protected async executeSparqlSelect(
    sparql: string,
  ): Promise<SparqlQueryResults> {
    const response = await fetch(this.queryEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: sparql,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `SPARQL query failed: ${response.status} ${response.statusText}\n${sparql}\n${body}`,
      );
    }

    return response.json();
  }

  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    const response = await fetch(this.updateEndpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/sparql-update'},
      body: sparql,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `SPARQL update failed: ${response.status} ${response.statusText}\n${sparql}\n${body}`,
      );
    }
  }
}
