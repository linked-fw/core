/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads from named graphs: `.from()` on select, count and ask builders, its DSL-JSON field and
 * its IR field.
 */
import {describe, expect, test} from '@jest/globals';
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
import {NamedGraph} from '../shapes/NamedGraph';

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
    for (const name of [graphs.allOntologies, graphs.allShapes, graphs.default, graphs.union]) {
      expect(() => selectToSparql(lower(Person.select((p) => p.name).from([name])))).toThrow(/store resolves/);
    }
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
