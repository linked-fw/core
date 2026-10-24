/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads from named graphs: `.from()` on select, count and ask builders, its DSL-JSON field and
 * its IR field.
 */
import {describe, expect, jest, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {AskBuilder} from '../queries/AskBuilder';
import {CountBuilder} from '../queries/CountBuilder';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {graphs} from '../ontologies/graphs';
import {normalizeReadGraphs} from '../queries/readGraphs';
import {askToSparql, countToSparql, selectToAlgebra, selectToSparql} from '../sparql/irToAlgebra';
import {selectPlanToSparql} from '../sparql/algebraToString';
import {scopeAlgebraToGraphs} from '../sparql/graphScope';
import type {SparqlAlgebraNode, SparqlBGP, SparqlFilter, SparqlLeftJoin} from '../sparql/SparqlAlgebra';
import {NamedGraph, OntologyGraph} from '../shapes/NamedGraph';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {graphCreateOutcomeAnswer} from '../test-helpers/test-utils';
import {
  GRAPH_REGISTRY_MAX_AGE_MS,
  invalidateGraphRegistry,
  readGraphRegistry,
} from '../utils/graphRegistryCache';

import '../ontologies/rdf';
import '../ontologies/xsd';

const G1 = 'https://example.org/graph/one';
const G2 = 'https://example.org/graph/two';

describe('.from() on the builders', () => {
  test('select: one name or a list, carried to the IR and through JSON', () => {
    const one = Person.select((p) => p.name).from(G1);
    expect(lower(one).graphs).toEqual([G1]);
    const many = Person.select((p) => p.name).from([G1, graphs.allOntologies, G1]);
    expect(lower(many).graphs).toEqual([G1, graphs.allOntologies]);

    const json = many.toJSON();
    expect(json.graphs).toEqual([G1, graphs.allOntologies]);
    const back = SelectBuilder.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(lower(back).graphs).toEqual([G1, graphs.allOntologies]);
    expect(back.toJSON()).toEqual(json);
  });

  test('a select without .from() carries no graphs', () => {
    const q = Person.select((p) => p.name);
    expect(lower(q).graphs).toBeUndefined();
    expect(q.toJSON().graphs).toBeUndefined();
  });

  test('builders stay immutable; later calls keep the graphs', () => {
    const base = Person.select((p) => p.name);
    const scoped = base.from(G1).limit(3).where((p) => p.name.equals('x'));
    expect(lower(base).graphs).toBeUndefined();
    expect(lower(scoped).graphs).toEqual([G1]);
    expect(lower(scoped.from(G2)).graphs).toEqual([G2]);
  });

  test('count and ask derived from a select keep the graphs', () => {
    const q = Person.select((p) => p.name).from([G1, G2]);
    const count = q.toCount();
    expect(lower(count).graphs).toEqual([G1, G2]);
    expect(count.toJSON().graphs).toEqual([G1, G2]);
    const countBack = fromJSON(JSON.parse(JSON.stringify(count.toJSON()))) as CountBuilder;
    expect(lower(countBack).graphs).toEqual([G1, G2]);
  });

  test('count and ask builders take .from() themselves', () => {
    const count = Person.select().toCount().from(G2);
    expect(lower(count).graphs).toEqual([G2]);

    const ask = AskBuilder.forNode('https://example.org/thing').from(G1);
    const askIR = lower(ask);
    expect(askIR.graphs).toEqual([G1]);
    expect(askIR.root).toBeUndefined();
    const json = ask.toJSON();
    expect(json.graphs).toEqual([G1]);
    expect(lower(fromJSON(JSON.parse(JSON.stringify(json))) as AskBuilder).graphs).toEqual([G1]);
  });

  test('a malformed argument or JSON field is refused', () => {
    const q = Person.select((p) => p.name);
    expect(() => q.from([])).toThrow(/non-empty list/);
    expect(() => q.from('not an iri')).toThrow(/absolute IRI/);
    expect(() => q.from(['https://ok.example/g', 'https://bad.example/<g>'])).toThrow(/absolute IRI/);
    expect(() =>
      SelectBuilder.fromJSON({...q.toJSON(), graphs: 'https://example.org/g' as unknown as string[]}),
    ).toThrow(/must be an array/);
    expect(() => fromJSON({v: '1.1', op: 'ask', subject: 'https://e.org/x', graphs: [42]} as never)).toThrow(
      /absolute IRI/,
    );
  });

  test('normalizeReadGraphs keeps order and drops duplicates', () => {
    expect(normalizeReadGraphs([G2, G1, G2])).toEqual([G2, G1]);
    expect(normalizeReadGraphs(G1)).toEqual([G1]);
  });
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const PERSON = 'https://example.org/types/Person';
const PROPS = 'https://example.org/props/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** A where on the linked subject's name: its block holds a stored triple; then add its type check. */
function linkedAlgebraWithTypeCheck() {
  const plan = selectToAlgebra(
    lower(Person.select((p) => p.name).where((p) => p.bestFriend.name.equals('x'))),
  );
  const filter = plan.algebra as SparqlFilter;
  const required = (filter.inner as SparqlLeftJoin).left as SparqlBGP;
  required.triples.push({
    subject: {kind: 'variable', name: 'a1'},
    predicate: {kind: 'iri', value: RDF_TYPE},
    object: {kind: 'iri', value: PERSON},
  });
  return plan;
}

describe('the generator', () => {
  test('one graph: the whole pattern in GRAPH <iri>, no FROM NAMED', () => {
    expect(selectToSparql(lower(Person.select((p) => p.name).from(G1)))).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  GRAPH <${G1}> {
    ?a0 rdf:type <${PERSON}> .
    OPTIONAL {
      ?a0 <${PROPS}name> ?a0_name .
    }
  }
}`,
    );
  });

  test('several graphs: FROM NAMED and one GRAPH ?g block per subject group', () => {
    expect(selectToSparql(lower(Person.select((p) => [p.name, p.bestFriend.name]).from([G1, G2])))).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a1_name ?a1
FROM NAMED <${G1}>
FROM NAMED <${G2}>
WHERE {
  GRAPH ?g_a0 {
    ?a0 rdf:type <${PERSON}> .
  }
  OPTIONAL {
    GRAPH ?g_a0 {
      ?a0 <${PROPS}bestFriend> ?a1 .
    }
    OPTIONAL {
      GRAPH ?g_a1 {
        ?a1 <${PROPS}name> ?a1_name .
      }
    }
  }
  OPTIONAL {
    GRAPH ?g_a0 {
      ?a0 <${PROPS}name> ?a0_name .
    }
  }
}`,
    );
  });

  test('a required group keeps its triples in one block; EXISTS patterns are scoped too', () => {
    expect(
      selectToSparql(
        lower(
          Person.select((p) => p.name)
            .where((p) => p.friends.some((f) => f.name.equals('x')))
            .from([G1, G2]),
        ),
      ),
    ).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
FROM NAMED <${G1}>
FROM NAMED <${G2}>
WHERE {
  GRAPH ?g_a0 {
    ?a0 rdf:type <${PERSON}> .
  }
  OPTIONAL {
    GRAPH ?g_a0 {
      ?a0 <${PROPS}name> ?a0_name .
    }
  }
  FILTER(EXISTS {
    GRAPH ?g_a0 {
      ?a0 <${PROPS}hasFriend> ?a1 .
    }
    GRAPH ?g_a1 {
      ?a1 <${PROPS}name> ?a1_name .
    }
    FILTER(?a1_name = "x")
  })
}`,
    );
  });

  test('count and ask carry the dataset clause', () => {
    const q = Person.select().where((p) => p.name.equals('x')).from([G1, G2]);
    expect(countToSparql(lower(q.toCount()))).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT (COUNT(DISTINCT ?a0) AS ?count)
FROM NAMED <${G1}>
FROM NAMED <${G2}>
WHERE {
  GRAPH ?g_a0 {
    ?a0 rdf:type <${PERSON}> .
    ?a0 <${PROPS}name> ?a0_name .
  }
  FILTER(?a0_name = "x")
}`,
    );
    const ask = AskBuilder.forNode('https://example.org/thing').from([G1, G2]);
    expect(askToSparql(lower(ask))).toBe(
      `ASK
FROM NAMED <${G1}>
FROM NAMED <${G2}>
WHERE {
  GRAPH ?g_s0 {
    <https://example.org/thing> ?p ?o .
  }
}`,
    );
    expect(askToSparql(lower(AskBuilder.forNode('https://example.org/thing').from(G1)))).toBe(
      `ASK WHERE {
  GRAPH <${G1}> {
    <https://example.org/thing> ?p ?o .
  }
}`,
    );
  });

  test('isolateLinkedTypeChecks: a linked subject’s type check moves to a second block', () => {
    const plan = linkedAlgebraWithTypeCheck();
    const twoBlocks = scopeAlgebraToGraphs(plan.algebra, [G1, G2], {isolateLinkedTypeChecks: true});
    expect(selectPlanToSparql({...plan, ...twoBlocks})).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a1
FROM NAMED <${G1}>
FROM NAMED <${G2}>
WHERE {
  GRAPH ?g_a0 {
    ?a0 rdf:type <${PERSON}> .
    ?a0 <${PROPS}bestFriend> ?a1 .
  }
  GRAPH ?g_a1 {
    ?a1 <${PROPS}name> ?a1_name .
  }
  GRAPH ?g_a1 {
    ?a1 rdf:type <${PERSON}> .
  }
  OPTIONAL {
    GRAPH ?g_a0 {
      ?a0 <${PROPS}name> ?a0_name .
    }
  }
  FILTER(?a1_name = "x")
}`,
    );
    const oneBlock = scopeAlgebraToGraphs(plan.algebra, [G1, G2], {isolateLinkedTypeChecks: false});
    expect(selectPlanToSparql({...plan, ...oneBlock})).toContain(
      `  GRAPH ?g_a1 {
    ?a1 <${PROPS}name> ?a1_name .
    ?a1 rdf:type <${PERSON}> .
  }
  OPTIONAL {`,
    );
  });

  test('the option changes no query the DSL builds today (no linked type checks)', () => {
    const ir = lower(Person.select((p) => [p.name, p.bestFriend.name]).from([G1, G2]));
    expect(selectToSparql(ir, {isolateLinkedTypeChecks: true})).toBe(selectToSparql(ir));
  });

  test('a graph variable never reuses a variable of the query', () => {
    const algebra: SparqlAlgebraNode = {
      type: 'bgp',
      triples: [
        {subject: {kind: 'variable', name: 'x'}, predicate: {kind: 'iri', value: `${PROPS}p`}, object: {kind: 'variable', name: 'g_x'}},
      ],
    };
    const scoped = scopeAlgebraToGraphs(algebra, [G1, G2]);
    expect((scoped.algebra as {variable?: string}).variable).toBe('g_x_2');
  });

  test('names only a store can resolve, and an empty set, are refused', () => {
    for (const name of [graphs.allOntologies, graphs.allShapes, graphs.union]) {
      expect(() => selectToSparql(lower(Person.select((p) => p.name).from([name])))).toThrow(/store resolves/);
    }
    // The default graph alone is the unrestricted read; with other graphs it needs the store's name.
    expect(selectToSparql(lower(Person.select((p) => p.name).from([graphs.default])))).toBe(
      selectToSparql(lower(Person.select((p) => p.name))),
    );
    expect(() => selectToSparql(lower(Person.select((p) => p.name).from([graphs.default, G1])))).toThrow(
      /mapGraphName/,
    );
    const ir = lower(Person.select((p) => p.name));
    expect(() => selectToSparql({...ir, graphs: []})).toThrow(/empty set of graphs/);
    // The registry is a real graph: read as itself.
    expect(selectToSparql(lower(Person.select((p) => p.name).from(graphs.registry)))).toContain(
      `GRAPH <${graphs.registry}>`,
    );
  });

  test('NamedGraph.select() reads the registry through the same path', () => {
    const sparql = selectToSparql(lower(NamedGraph.select((g) => g.contentHash)));
    expect(sparql).toContain(`GRAPH <${graphs.registry}> {`);
    expect(sparql).not.toContain('FROM NAMED');
    expect(selectToSparql(lower(NamedGraph.select((g) => g.contentHash).from([G1, G2])))).toContain(
      'FROM NAMED',
    );
  });
});

// ---------------------------------------------------------------------------
// The store: expansion and the registry cache
// ---------------------------------------------------------------------------

const CORE = 'https://linked.cm/ont/core/';
const SD_NAMED_GRAPH = 'http://www.w3.org/ns/sparql-service-description#NamedGraph';
const ONT_A = 'https://linked.cm/pkg/a/graph/ontology';
const ONT_B = 'https://linked.cm/pkg/b/graph/ontology';
const ONT_C = 'https://linked.cm/pkg/c/graph/ontology';
const DRAFTS = 'https://acme.example/data/graph/drafts';

/** A SPARQL store whose transport answers from a fake registry and records every request. */
class StubStore extends SparqlDataset {
  registryLoads = 0;
  selects: string[] = [];
  updates: string[] = [];
  registry: Array<[string, string]> = [
    [ONT_B, `${CORE}OntologyGraph`],
    [ONT_B, SD_NAMED_GRAPH],
    [ONT_A, `${CORE}OntologyGraph`],
    [DRAFTS, `${CORE}DraftGraph`],
  ];

  constructor(options?: SparqlOptions, private readonly key?: string) {
    super(options);
  }

  protected override graphRegistryKey(): string {
    return this.key ?? super.graphRegistryKey();
  }

  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    if (sparql.startsWith('ASK {')) return {head: {}, boolean: false};
    const outcome = graphCreateOutcomeAnswer(sparql, {registered: false});
    if (outcome) return outcome;
    if (sparql.startsWith('SELECT ?g ?c WHERE')) {
      this.registryLoads++;
      return {
        head: {vars: ['g', 'c']},
        results: {
          bindings: this.registry.map(([g, c]) => ({
            g: {type: 'uri', value: g},
            c: {type: 'uri', value: c},
          })),
        },
      };
    }
    this.selects.push(sparql);
    if (sparql.includes('COUNT(')) {
      return {
        head: {vars: ['count']},
        results: {bindings: [{count: {type: 'literal', value: '0', datatype: 'http://www.w3.org/2001/XMLSchema#integer'}}]},
      };
    }
    if (sparql.startsWith('ASK') || sparql.includes('\nASK')) return {head: {}, boolean: false};
    return {head: {vars: []}, results: {bindings: []}};
  }

  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }

  lastSelect(): string {
    return this.selects[this.selects.length - 1];
  }
}

const ontologies = () => Person.select((p) => p.name).from(graphs.allOntologies);

describe('the store expands the graph set', () => {
  test('graphs.allOntologies: every OntologyGraph the registry lists, sorted', async () => {
    const store = new StubStore();
    await ontologies().exec(store);
    expect(store.lastSelect()).toBe(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
FROM NAMED <${ONT_A}>
FROM NAMED <${ONT_B}>
WHERE {
  GRAPH ?g_a0 {
    ?a0 rdf:type <${PERSON}> .
  }
  OPTIONAL {
    GRAPH ?g_a0 {
      ?a0 <${PROPS}name> ?a0_name .
    }
  }
}`,
    );
    expect(store.registryLoads).toBe(1);
  });

  test('one listed graph reads as GRAPH <iri>; listed graphs join explicit ones', async () => {
    const store = new StubStore();
    store.registry = [[ONT_A, `${CORE}OntologyGraph`]];
    await ontologies().exec(store);
    expect(store.lastSelect()).toContain(`GRAPH <${ONT_A}> {`);
    await Person.select((p) => p.name).from([G1, graphs.allOntologies]).exec(store);
    expect(store.lastSelect()).toContain(`FROM NAMED <${G1}>\nFROM NAMED <${ONT_A}>\n`);
  });

  test('no graph of that kind registered: the read matches nothing, without a query', async () => {
    const store = new StubStore();
    store.registry = [[DRAFTS, `${CORE}DraftGraph`]];
    expect(await ontologies().exec(store)).toEqual([]);
    expect(await Person.select().from(graphs.allShapes).toCount().exec(store)).toBe(0);
    expect(await Person.select().from(graphs.allOntologies).exists(store)).toBe(false);
    expect(store.selects).toEqual([]);
    expect(store.registryLoads).toBe(1);
  });

  test('graphs.default alone reads the default graph as without .from()', async () => {
    const store = new StubStore();
    await Person.select((p) => p.name).from(graphs.default).exec(store);
    const plain = selectToSparql(lower(Person.select((p) => p.name)));
    expect(store.lastSelect()).toBe(plain);
    expect(store.registryLoads).toBe(0);
  });

  test('graphs.union is read on its own only and needs mapGraphName; graphs.default joins a set through VALUES', async () => {
    const jena = (iri: string) =>
      iri === graphs.default ? 'urn:x-arq:DefaultGraph' : iri === graphs.union ? 'urn:x-arq:UnionGraph' : null;
    const mapped = new StubStore({mapGraphName: jena});
    await expect(Person.select((p) => p.name).from([graphs.union, G1]).exec(mapped)).rejects.toMatchObject({
      cause: {name: 'GraphQueryError', code: 'unsupported-query-kind'},
    });
    // With the default graph in the set there is no FROM NAMED (it would hide the default graph).
    await Person.select((p) => p.name).from([graphs.default, G1]).exec(mapped);
    expect(mapped.lastSelect()).toContain(`VALUES ?g_a0 { <urn:x-arq:DefaultGraph> <${G1}> }`);
    expect(mapped.lastSelect()).not.toContain('FROM NAMED');
    await expect(
      Person.select((p) => p.name).from([graphs.default, G1]).exec(new StubStore()),
    ).rejects.toMatchObject({cause: {name: 'GraphQueryError', code: 'unsupported-query-kind'}});
    await Person.select((p) => p.name).from(graphs.union).exec(mapped);
    expect(mapped.lastSelect()).toContain('GRAPH <urn:x-arq:UnionGraph> {');

    const unmapped = new StubStore();
    await expect(Person.select((p) => p.name).from(graphs.union).exec(unmapped)).rejects.toMatchObject({
      cause: {name: 'GraphQueryError', code: 'unsupported-query-kind'},
    });
    const refusing = new StubStore({mapGraphName: () => null});
    await expect(Person.select((p) => p.name).from(graphs.union).exec(refusing)).rejects.toThrow(/mapGraphName/);
  });

  test('the store option reaches the generator', async () => {
    const on = new StubStore({isolateLinkedTypeChecks: true});
    const off = new StubStore();
    const q = Person.select((p) => [p.name, p.bestFriend.name]).from([G1, G2]);
    await q.exec(on);
    await q.exec(off);
    expect(on.lastSelect()).toBe(off.lastSelect());
  });
});

describe('the registry cache', () => {
  test('a graph query through the store updates its cache: no re-read, the next read sees it', async () => {
    const store = new StubStore();
    await ontologies().exec(store);
    expect(store.registryLoads).toBe(1);

    await OntologyGraph.create({id: ONT_C, package: '@acme/c', version: '1.0.0'}).exec(store);
    await ontologies().exec(store);
    expect(store.registryLoads).toBe(1);
    expect(store.lastSelect()).toContain(`FROM NAMED <${ONT_C}>`);

    await OntologyGraph.delete(ONT_A).exec(store);
    await ontologies().exec(store);
    expect(store.registryLoads).toBe(1);
    expect(store.lastSelect()).not.toContain(ONT_A);
    expect(store.lastSelect()).toContain(`FROM NAMED <${ONT_B}>\nFROM NAMED <${ONT_C}>\n`);
  });

  test('invalidateGraphRegistry forces a re-read', async () => {
    const store = new StubStore();
    await ontologies().exec(store);
    store.registry = [[ONT_C, `${CORE}OntologyGraph`]];
    await ontologies().exec(store);
    expect(store.registryLoads).toBe(1);
    store.invalidateGraphRegistry();
    await ontologies().exec(store);
    expect(store.registryLoads).toBe(2);
    expect(store.lastSelect()).toContain(`GRAPH <${ONT_C}> {`);

    // The package-level call, by dataset key; and with no key, every dataset.
    const keyed = new StubStore(undefined, 'dataset-x');
    await ontologies().exec(keyed);
    invalidateGraphRegistry('dataset-x');
    await ontologies().exec(keyed);
    expect(keyed.registryLoads).toBe(2);
    invalidateGraphRegistry();
    await ontologies().exec(keyed);
    await ontologies().exec(store);
    expect(keyed.registryLoads).toBe(3);
    expect(store.registryLoads).toBe(3);
  });

  test('stores keyed by the same dataset share one entry; others keep their own', async () => {
    const first = new StubStore(undefined, 'shared-dataset');
    const second = new StubStore(undefined, 'shared-dataset');
    await ontologies().exec(first);
    await ontologies().exec(second);
    expect(first.registryLoads + second.registryLoads).toBe(1);
    await OntologyGraph.create({id: ONT_C, package: '@acme/c', version: '1.0.0'}).exec(first);
    await ontologies().exec(second);
    expect(second.lastSelect()).toContain(`FROM NAMED <${ONT_C}>`);
    const other = new StubStore();
    await ontologies().exec(other);
    expect(other.registryLoads).toBe(1);
  });

  test('an entry older than 30 seconds is re-read (fake clock)', async () => {
    jest.useFakeTimers({now: 1_000_000});
    try {
      const store = new StubStore();
      await ontologies().exec(store);
      jest.setSystemTime(1_000_000 + GRAPH_REGISTRY_MAX_AGE_MS);
      await ontologies().exec(store);
      expect(store.registryLoads).toBe(1);
      jest.setSystemTime(1_000_000 + GRAPH_REGISTRY_MAX_AGE_MS + 1);
      await ontologies().exec(store);
      expect(store.registryLoads).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('concurrent reads share one load; an invalidation during a load is not undone by it', async () => {
    const store = new StubStore();
    await Promise.all([ontologies().exec(store), ontologies().exec(store), ontologies().exec(store)]);
    expect(store.registryLoads).toBe(1);

    const racing = new StubStore(undefined, 'racing');
    const pending = readGraphRegistry('racing', async () => [{graph: ONT_A, recordClass: `${CORE}OntologyGraph`}]);
    invalidateGraphRegistry('racing');
    await pending;
    await ontologies().exec(racing);
    expect(racing.registryLoads).toBe(1);
  });
});
