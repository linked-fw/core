import {describe, expect, test} from '@jest/globals';
import type {
  SparqlAlgebraNode,
  SparqlBGP,
  SparqlExpression,
  SparqlSelectPlan,
  SparqlInsertDataPlan,
  SparqlDeleteInsertPlan,
  SparqlDeleteWherePlan,
  SparqlTriple,
} from '../sparql/SparqlAlgebra';
import {
  serializeAlgebraNode,
  serializeExpression,
  serializeTerm,
  selectPlanToSparql,
  insertDataPlanToSparql,
  deleteInsertPlanToSparql,
  deleteWherePlanToSparql,
} from '../sparql/algebraToString';

// Ensure rdf and xsd prefixes are registered (importing the ontology modules does this)
import '../ontologies/rdf';
import '../ontologies/xsd';

// ---------------------------------------------------------------------------
// Helper: well-known URIs for tests
// ---------------------------------------------------------------------------

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const PERSON_URI = 'http://example.org/Person';
const NAME_URI = 'http://example.org/name';
const HOBBY_URI = 'http://example.org/hobby';
const FRIEND_URI = 'http://example.org/hasFriend';
const ENTITY_URI = 'http://example.org/data/p1';
const ENTITY_URI_2 = 'http://example.org/data/p2';
const GRAPH_URI = 'http://example.org/graph/default';

// ---------------------------------------------------------------------------
// Test helpers to build algebra nodes concisely
// ---------------------------------------------------------------------------

function iri(value: string) {
  return {kind: 'iri' as const, value};
}
function variable(name: string) {
  return {kind: 'variable' as const, name};
}
function literal(value: string, datatype?: string) {
  return {kind: 'literal' as const, value, datatype};
}
function triple(
  s: ReturnType<typeof iri | typeof variable>,
  p: ReturnType<typeof iri | typeof variable>,
  o: ReturnType<typeof iri | typeof variable | typeof literal>,
): SparqlTriple {
  return {subject: s, predicate: p, object: o};
}
function bgp(...triples: SparqlTriple[]): SparqlBGP {
  return {type: 'bgp', triples};
}

// ---------------------------------------------------------------------------
// serializeTerm
// ---------------------------------------------------------------------------

describe('serializeTerm', () => {
  test('variable term → ?name', () => {
    expect(serializeTerm(variable('x'))).toBe('?x');
  });

  test('iri term with registered prefix → prefixed form', () => {
    expect(serializeTerm(iri(RDF_TYPE))).toBe('rdf:type');
  });

  test('iri term with no registered prefix → <full-uri>', () => {
    expect(serializeTerm(iri(PERSON_URI))).toBe(`<${PERSON_URI}>`);
  });

  test('plain literal → quoted string', () => {
    expect(serializeTerm(literal('hello'))).toBe('"hello"');
  });

  test('typed literal → quoted string with datatype', () => {
    expect(serializeTerm(literal('42', XSD_INTEGER))).toBe(
      '"42"^^xsd:integer',
    );
  });

  test('language-tagged literal → quoted string with @lang', () => {
    expect(
      serializeTerm({kind: 'literal', value: 'hello', language: 'en'}),
    ).toBe('"hello"@en');
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — BGP
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — BGP', () => {
  test('BGP with two triples produces dot-separated output', () => {
    const node = bgp(
      triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI)),
      triple(variable('s'), iri(NAME_URI), variable('name')),
    );
    const result = serializeAlgebraNode(node);
    expect(result).toBe(
      `?s rdf:type <${PERSON_URI}> .\n?s <${NAME_URI}> ?name .`,
    );
  });

  test('BGP with single triple produces single line with dot', () => {
    const node = bgp(
      triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
    );
    const result = serializeAlgebraNode(node);
    expect(result).toBe(`?a0 rdf:type <${PERSON_URI}> .`);
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — Join
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — Join', () => {
  test('Join concatenates left and right blocks', () => {
    const node: SparqlAlgebraNode = {
      type: 'join',
      left: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
      right: bgp(triple(variable('s'), iri(NAME_URI), variable('name'))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toBe(
      `?s rdf:type <${PERSON_URI}> .\n?s <${NAME_URI}> ?name .`,
    );
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — LeftJoin (OPTIONAL)
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — LeftJoin', () => {
  test('LeftJoin produces OPTIONAL block', () => {
    const node: SparqlAlgebraNode = {
      type: 'left_join',
      left: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
      right: bgp(triple(variable('s'), iri(NAME_URI), variable('name'))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('OPTIONAL {');
    expect(result).toContain(`?s <${NAME_URI}> ?name .`);
    // Left part appears before OPTIONAL
    const optIndex = result.indexOf('OPTIONAL');
    const leftIndex = result.indexOf(`?s rdf:type <${PERSON_URI}>`);
    expect(leftIndex).toBeLessThan(optIndex);
  });

  test('LeftJoin with condition includes FILTER inside OPTIONAL', () => {
    const node: SparqlAlgebraNode = {
      type: 'left_join',
      left: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
      right: bgp(triple(variable('s'), iri(NAME_URI), variable('name'))),
      condition: {
        kind: 'binary_expr',
        op: '=',
        left: {kind: 'variable_expr', name: 'name'},
        right: {kind: 'literal_expr', value: 'Test'},
      },
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('OPTIONAL {');
    expect(result).toContain('FILTER(?name = "Test")');
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — Filter
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — Filter', () => {
  test('Filter with binary expression → FILTER(?x = "value")', () => {
    const node: SparqlAlgebraNode = {
      type: 'filter',
      expression: {
        kind: 'binary_expr',
        op: '=',
        left: {kind: 'variable_expr', name: 'x'},
        right: {kind: 'literal_expr', value: 'value'},
      },
      inner: bgp(triple(variable('x'), iri(RDF_TYPE), iri(PERSON_URI))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('FILTER(?x = "value")');
    // Inner pattern appears before the FILTER
    const filterIndex = result.indexOf('FILTER');
    const patternIndex = result.indexOf(`?x rdf:type`);
    expect(patternIndex).toBeLessThan(filterIndex);
  });

  test('Filter with logical AND → FILTER(a && b)', () => {
    const node: SparqlAlgebraNode = {
      type: 'filter',
      expression: {
        kind: 'logical_expr',
        op: 'and',
        exprs: [
          {
            kind: 'binary_expr',
            op: '=',
            left: {kind: 'variable_expr', name: 'x'},
            right: {kind: 'literal_expr', value: 'a'},
          },
          {
            kind: 'binary_expr',
            op: '=',
            left: {kind: 'variable_expr', name: 'y'},
            right: {kind: 'literal_expr', value: 'b'},
          },
        ],
      },
      inner: bgp(triple(variable('x'), iri(RDF_TYPE), iri(PERSON_URI))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('FILTER(?x = "a" && ?y = "b")');
  });

  test('Filter with logical OR → FILTER(a || b)', () => {
    const node: SparqlAlgebraNode = {
      type: 'filter',
      expression: {
        kind: 'logical_expr',
        op: 'or',
        exprs: [
          {
            kind: 'binary_expr',
            op: '=',
            left: {kind: 'variable_expr', name: 'x'},
            right: {kind: 'literal_expr', value: 'a'},
          },
          {
            kind: 'binary_expr',
            op: '=',
            left: {kind: 'variable_expr', name: 'y'},
            right: {kind: 'literal_expr', value: 'b'},
          },
        ],
      },
      inner: bgp(triple(variable('x'), iri(RDF_TYPE), iri(PERSON_URI))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('FILTER(?x = "a" || ?y = "b")');
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — Union
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — Union', () => {
  test('Union produces { left } UNION { right }', () => {
    const node: SparqlAlgebraNode = {
      type: 'union',
      left: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
      right: bgp(triple(variable('s'), iri(NAME_URI), variable('name'))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('UNION');
    // Each side is in its own braces
    expect(result).toMatch(/\{[\s\S]*\}\s*UNION\s*\{[\s\S]*\}/);
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — Minus
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — Minus', () => {
  test('Minus produces left + MINUS { right }', () => {
    const node: SparqlAlgebraNode = {
      type: 'minus',
      left: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
      right: bgp(triple(variable('s'), iri(NAME_URI), variable('name'))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('MINUS {');
    expect(result).toContain(`?s <${NAME_URI}> ?name .`);
    // Left part appears before MINUS
    const minusIndex = result.indexOf('MINUS');
    const leftIndex = result.indexOf(`?s rdf:type`);
    expect(leftIndex).toBeLessThan(minusIndex);
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — Extend (BIND)
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — Extend', () => {
  test('Extend produces BIND(expr AS ?var)', () => {
    const node: SparqlAlgebraNode = {
      type: 'extend',
      inner: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
      variable: 'bound',
      expression: {
        kind: 'binary_expr',
        op: '+',
        left: {kind: 'variable_expr', name: 'x'},
        right: {kind: 'literal_expr', value: '1', datatype: XSD_INTEGER},
      },
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain('BIND(?x + "1"^^xsd:integer AS ?bound)');
  });
});

// ---------------------------------------------------------------------------
// serializeAlgebraNode — Graph
// ---------------------------------------------------------------------------

describe('serializeAlgebraNode — Graph', () => {
  test('Graph produces GRAPH <iri> { inner }', () => {
    const node: SparqlAlgebraNode = {
      type: 'graph',
      iri: GRAPH_URI,
      inner: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
    };
    const result = serializeAlgebraNode(node);
    expect(result).toContain(`GRAPH <${GRAPH_URI}>`);
    expect(result).toContain(`?s rdf:type <${PERSON_URI}> .`);
  });
});

// ---------------------------------------------------------------------------
// serializeExpression
// ---------------------------------------------------------------------------

describe('serializeExpression', () => {
  test('variable_expr → ?name', () => {
    const expr: SparqlExpression = {kind: 'variable_expr', name: 'x'};
    expect(serializeExpression(expr)).toBe('?x');
  });

  test('iri_expr → formatted URI', () => {
    const expr: SparqlExpression = {kind: 'iri_expr', value: RDF_TYPE};
    expect(serializeExpression(expr)).toBe('rdf:type');
  });

  test('literal_expr → formatted literal', () => {
    const expr: SparqlExpression = {kind: 'literal_expr', value: 'hello'};
    expect(serializeExpression(expr)).toBe('"hello"');
  });

  test('literal_expr with datatype → typed literal', () => {
    const expr: SparqlExpression = {
      kind: 'literal_expr',
      value: '42',
      datatype: XSD_INTEGER,
    };
    expect(serializeExpression(expr)).toBe('"42"^^xsd:integer');
  });

  test('binary_expr → left op right', () => {
    const expr: SparqlExpression = {
      kind: 'binary_expr',
      op: '=',
      left: {kind: 'variable_expr', name: 'x'},
      right: {kind: 'literal_expr', value: 'test'},
    };
    expect(serializeExpression(expr)).toBe('?x = "test"');
  });

  test('logical_expr AND → exprs joined by &&', () => {
    const expr: SparqlExpression = {
      kind: 'logical_expr',
      op: 'and',
      exprs: [
        {kind: 'variable_expr', name: 'a'},
        {kind: 'variable_expr', name: 'b'},
      ],
    };
    expect(serializeExpression(expr)).toBe('?a && ?b');
  });

  test('logical_expr OR → exprs joined by ||', () => {
    const expr: SparqlExpression = {
      kind: 'logical_expr',
      op: 'or',
      exprs: [
        {kind: 'variable_expr', name: 'a'},
        {kind: 'variable_expr', name: 'b'},
      ],
    };
    expect(serializeExpression(expr)).toBe('?a || ?b');
  });

  test('not_expr → !inner', () => {
    const expr: SparqlExpression = {
      kind: 'not_expr',
      inner: {kind: 'variable_expr', name: 'x'},
    };
    expect(serializeExpression(expr)).toBe('!(?x)');
  });

  test('function_expr → NAME(args)', () => {
    const expr: SparqlExpression = {
      kind: 'function_expr',
      name: 'STRLEN',
      args: [{kind: 'variable_expr', name: 'x'}],
    };
    expect(serializeExpression(expr)).toBe('STRLEN(?x)');
  });

  test('function_expr with multiple args → NAME(a, b)', () => {
    const expr: SparqlExpression = {
      kind: 'function_expr',
      name: 'CONCAT',
      args: [
        {kind: 'variable_expr', name: 'a'},
        {kind: 'literal_expr', value: ' '},
        {kind: 'variable_expr', name: 'b'},
      ],
    };
    expect(serializeExpression(expr)).toBe('CONCAT(?a, " ", ?b)');
  });

  test('aggregate_expr → NAME(args)', () => {
    const expr: SparqlExpression = {
      kind: 'aggregate_expr',
      name: 'COUNT',
      args: [{kind: 'variable_expr', name: 'x'}],
    };
    expect(serializeExpression(expr)).toBe('COUNT(?x)');
  });

  test('aggregate_expr with DISTINCT → NAME(DISTINCT args)', () => {
    const expr: SparqlExpression = {
      kind: 'aggregate_expr',
      name: 'COUNT',
      args: [{kind: 'variable_expr', name: 'x'}],
      distinct: true,
    };
    expect(serializeExpression(expr)).toBe('COUNT(DISTINCT ?x)');
  });

  test('exists_expr (non-negated) → EXISTS { pattern }', () => {
    const expr: SparqlExpression = {
      kind: 'exists_expr',
      negated: false,
      pattern: bgp(
        triple(variable('s'), iri(FRIEND_URI), variable('f')),
      ),
    };
    const result = serializeExpression(expr);
    expect(result).toContain('EXISTS {');
    expect(result).not.toContain('NOT EXISTS');
    expect(result).toContain(`?s <${FRIEND_URI}> ?f .`);
  });

  test('exists_expr (negated) → NOT EXISTS { pattern }', () => {
    const expr: SparqlExpression = {
      kind: 'exists_expr',
      negated: true,
      pattern: bgp(
        triple(variable('s'), iri(FRIEND_URI), variable('f')),
      ),
    };
    const result = serializeExpression(expr);
    expect(result).toContain('NOT EXISTS {');
    expect(result).toContain(`?s <${FRIEND_URI}> ?f .`);
  });

  test('bound_expr → BOUND(?var)', () => {
    const expr: SparqlExpression = {kind: 'bound_expr', variable: 'x'};
    expect(serializeExpression(expr)).toBe('BOUND(?x)');
  });
});

// ---------------------------------------------------------------------------
// selectPlanToSparql — full plan
// ---------------------------------------------------------------------------

describe('selectPlanToSparql', () => {
  test('full plan with PREFIX, SELECT DISTINCT, WHERE, ORDER BY, LIMIT', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [
        {kind: 'variable', name: 'a0'},
        {kind: 'variable', name: 'a0_name'},
      ],
      distinct: true,
      algebra: {
        type: 'left_join',
        left: bgp(
          triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        ),
        right: bgp(
          triple(variable('a0'), iri(NAME_URI), variable('a0_name')),
        ),
      },
      orderBy: [
        {
          expression: {kind: 'variable_expr', name: 'a0_name'},
          direction: 'ASC',
        },
      ],
      limit: 10,
    };

    const result = selectPlanToSparql(plan);

    // Check PREFIX block — rdf prefix should be present since rdf:type is used
    expect(result).toContain('PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>');

    // Check SELECT line
    expect(result).toContain('SELECT DISTINCT ?a0 ?a0_name');

    // Check WHERE block
    expect(result).toContain('WHERE {');
    expect(result).toContain(`?a0 rdf:type <${PERSON_URI}>`);
    expect(result).toContain('OPTIONAL {');
    expect(result).toContain(`?a0 <${NAME_URI}> ?a0_name .`);

    // Check ORDER BY
    expect(result).toContain('ORDER BY ASC(?a0_name)');

    // Check LIMIT
    expect(result).toContain('LIMIT 10');

    // DISTINCT is present
    expect(result).toMatch(/SELECT DISTINCT/);
  });

  test('plan without DISTINCT omits the keyword', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('SELECT ?a0');
    expect(result).not.toContain('DISTINCT');
  });

  test('plan with aggregates and GROUP BY', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [
        {kind: 'variable', name: 'a0'},
        {
          kind: 'aggregate',
          expression: {
            kind: 'aggregate_expr',
            name: 'COUNT',
            args: [{kind: 'variable_expr', name: 'a1'}],
          },
          alias: 'a2',
        },
      ],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        triple(variable('a0'), iri(FRIEND_URI), variable('a1')),
      ),
      groupBy: ['a0'],
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('SELECT ?a0 (COUNT(?a1) AS ?a2)');
    expect(result).toContain('GROUP BY ?a0');
  });

  test('plan with HAVING clause', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [
        {kind: 'variable', name: 'a0'},
        {
          kind: 'aggregate',
          expression: {
            kind: 'aggregate_expr',
            name: 'COUNT',
            args: [{kind: 'variable_expr', name: 'a1'}],
          },
          alias: 'a2',
        },
      ],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        triple(variable('a0'), iri(FRIEND_URI), variable('a1')),
      ),
      groupBy: ['a0'],
      having: {
        kind: 'binary_expr',
        op: '=',
        left: {
          kind: 'aggregate_expr',
          name: 'COUNT',
          args: [{kind: 'variable_expr', name: 'a1'}],
        },
        right: {kind: 'literal_expr', value: '2', datatype: XSD_INTEGER},
      },
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('HAVING(COUNT(?a1) = "2"^^xsd:integer)');
  });

  test('plan with OFFSET', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
      limit: 10,
      offset: 5,
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('LIMIT 10');
    expect(result).toContain('OFFSET 5');
  });

  test('plan with multiple ORDER BY conditions', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [
        {kind: 'variable', name: 'a0'},
        {kind: 'variable', name: 'a0_name'},
      ],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
      orderBy: [
        {
          expression: {kind: 'variable_expr', name: 'a0_name'},
          direction: 'ASC',
        },
        {
          expression: {kind: 'variable_expr', name: 'a0'},
          direction: 'DESC',
        },
      ],
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('ORDER BY ASC(?a0_name) DESC(?a0)');
  });

  test('PREFIX block contains only actually used prefixes', () => {
    // Use rdf:type (registered) and an unknown URI (not registered)
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
    };

    const result = selectPlanToSparql(plan);
    // rdf prefix is used (rdf:type)
    expect(result).toContain('PREFIX rdf:');
    // xsd prefix is NOT used
    expect(result).not.toContain('PREFIX xsd:');
  });
});

// ---------------------------------------------------------------------------
// insertDataPlanToSparql
// ---------------------------------------------------------------------------

describe('insertDataPlanToSparql', () => {
  test('InsertDataPlan with 3 triples produces correct output', () => {
    const plan: SparqlInsertDataPlan = {
      type: 'insert_data',
      triples: [
        triple(iri(ENTITY_URI), iri(RDF_TYPE), iri(PERSON_URI)),
        triple(iri(ENTITY_URI), iri(NAME_URI), literal('Test')),
        triple(iri(ENTITY_URI), iri(HOBBY_URI), literal('Chess')),
      ],
    };

    const result = insertDataPlanToSparql(plan);

    expect(result).toContain('INSERT DATA {');
    expect(result).toContain(`<${ENTITY_URI}> rdf:type <${PERSON_URI}> .`);
    expect(result).toContain(`<${ENTITY_URI}> <${NAME_URI}> "Test" .`);
    expect(result).toContain(`<${ENTITY_URI}> <${HOBBY_URI}> "Chess" .`);
    expect(result).toContain('PREFIX rdf:');
  });

  test('InsertDataPlan with graph wraps triples in GRAPH block', () => {
    const plan: SparqlInsertDataPlan = {
      type: 'insert_data',
      triples: [
        triple(iri(ENTITY_URI), iri(RDF_TYPE), iri(PERSON_URI)),
      ],
      graph: GRAPH_URI,
    };

    const result = insertDataPlanToSparql(plan);
    expect(result).toContain('INSERT DATA {');
    expect(result).toContain(`GRAPH <${GRAPH_URI}>`);
  });
});

// ---------------------------------------------------------------------------
// deleteInsertPlanToSparql
// ---------------------------------------------------------------------------

describe('deleteInsertPlanToSparql', () => {
  test('DeleteInsertPlan with delete, insert, and where blocks', () => {
    const plan: SparqlDeleteInsertPlan = {
      type: 'delete_insert',
      deletePatterns: [
        triple(iri(ENTITY_URI), iri(HOBBY_URI), variable('old_hobby')),
      ],
      insertPatterns: [
        triple(iri(ENTITY_URI), iri(HOBBY_URI), literal('Chess')),
      ],
      whereAlgebra: bgp(
        triple(iri(ENTITY_URI), iri(HOBBY_URI), variable('old_hobby')),
      ),
    };

    const result = deleteInsertPlanToSparql(plan);

    expect(result).toContain('DELETE {');
    expect(result).toContain(
      `<${ENTITY_URI}> <${HOBBY_URI}> ?old_hobby .`,
    );
    expect(result).toContain('INSERT {');
    expect(result).toContain(`<${ENTITY_URI}> <${HOBBY_URI}> "Chess" .`);
    expect(result).toContain('WHERE {');
  });

  test('DeleteInsertPlan with a graph targets it with WITH', () => {
    const plan: SparqlDeleteInsertPlan = {
      type: 'delete_insert',
      deletePatterns: [triple(iri(ENTITY_URI), iri(HOBBY_URI), variable('old_hobby'))],
      insertPatterns: [triple(iri(ENTITY_URI), iri(HOBBY_URI), literal('Chess'))],
      whereAlgebra: bgp(triple(iri(ENTITY_URI), iri(HOBBY_URI), variable('old_hobby'))),
      graph: GRAPH_URI,
    };

    const lines = deleteInsertPlanToSparql(plan).split('\n');
    expect(lines[0]).toBe(`WITH <${GRAPH_URI}>`);
    expect(lines[1]).toBe('DELETE {');
    expect(deleteInsertPlanToSparql({...plan, graph: undefined})).not.toContain('WITH');
  });

  test('DeleteInsertPlan with empty insert (unset/delete only)', () => {
    const plan: SparqlDeleteInsertPlan = {
      type: 'delete_insert',
      deletePatterns: [
        triple(iri(ENTITY_URI), iri(HOBBY_URI), variable('old_hobby')),
      ],
      insertPatterns: [],
      whereAlgebra: bgp(
        triple(iri(ENTITY_URI), iri(HOBBY_URI), variable('old_hobby')),
      ),
    };

    const result = deleteInsertPlanToSparql(plan);

    expect(result).toContain('DELETE {');
    // No INSERT block when empty
    expect(result).not.toContain('INSERT {');
    expect(result).toContain('WHERE {');
  });
});

// ---------------------------------------------------------------------------
// deleteWherePlanToSparql
// ---------------------------------------------------------------------------

describe('deleteWherePlanToSparql', () => {
  test('DeleteWherePlan with subject + object patterns', () => {
    const plan: SparqlDeleteWherePlan = {
      type: 'delete_where',
      patterns: bgp(
        triple(iri(ENTITY_URI), variable('p'), variable('o')),
        triple(variable('s'), variable('p2'), iri(ENTITY_URI)),
        triple(iri(ENTITY_URI), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
    };

    const result = deleteWherePlanToSparql(plan);

    expect(result).toContain('DELETE WHERE {');
    expect(result).toContain(`<${ENTITY_URI}> ?p ?o .`);
    expect(result).toContain(`?s ?p2 <${ENTITY_URI}> .`);
    expect(result).toContain(`<${ENTITY_URI}> rdf:type <${PERSON_URI}> .`);
  });

  test('DeleteWherePlan with graph wraps in GRAPH block', () => {
    const plan: SparqlDeleteWherePlan = {
      type: 'delete_where',
      patterns: bgp(
        triple(iri(ENTITY_URI), variable('p'), variable('o')),
      ),
      graph: GRAPH_URI,
    };

    const result = deleteWherePlanToSparql(plan);
    expect(result).toContain('DELETE WHERE {');
    expect(result).toContain(`GRAPH <${GRAPH_URI}>`);
  });
});

// ---------------------------------------------------------------------------
// Prefix resolution
// ---------------------------------------------------------------------------

describe('prefix resolution', () => {
  test('URIs with registered prefixes are shortened and PREFIX declarations appear', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
    };

    const result = selectPlanToSparql(plan);

    // rdf:type should be used in the body (not <full uri>)
    expect(result).toContain('rdf:type');
    expect(result).not.toContain(
      `<${RDF_TYPE}>`,
    );

    // PREFIX declaration for rdf
    expect(result).toContain(
      'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
    );
  });

  test('URIs with no registered prefix stay as <full-uri> with no PREFIX for them', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(
          variable('a0'),
          iri('http://unknown.example.org/prop'),
          variable('val'),
        ),
      ),
    };

    const result = selectPlanToSparql(plan);

    // Full URI form in body
    expect(result).toContain('<http://unknown.example.org/prop>');
    // No PREFIX for unknown namespace
    expect(result).not.toContain('PREFIX');
  });

  test('multiple prefixes used → all appear in PREFIX block', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        triple(
          variable('a0'),
          iri(NAME_URI),
          literal('42', XSD_INTEGER),
        ),
      ),
    };

    const result = selectPlanToSparql(plan);

    // Both rdf and xsd prefixes should be present
    expect(result).toContain('PREFIX rdf:');
    expect(result).toContain('PREFIX xsd:');
  });
});

// ---------------------------------------------------------------------------
// Complex / combined scenarios
// ---------------------------------------------------------------------------

describe('complex serialization scenarios', () => {
  test('nested LeftJoin inside Filter', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [
        {kind: 'variable', name: 'a0'},
        {kind: 'variable', name: 'a0_name'},
      ],
      distinct: true,
      algebra: {
        type: 'filter',
        expression: {
          kind: 'binary_expr',
          op: '!=',
          left: {kind: 'variable_expr', name: 'a0_name'},
          right: {kind: 'literal_expr', value: ''},
        },
        inner: {
          type: 'left_join',
          left: bgp(
            triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
          ),
          right: bgp(
            triple(variable('a0'), iri(NAME_URI), variable('a0_name')),
          ),
        },
      },
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('SELECT DISTINCT ?a0 ?a0_name');
    expect(result).toContain('OPTIONAL {');
    expect(result).toContain('FILTER(?a0_name != "")');
  });

  test('Union inside select plan', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 's'}],
      algebra: {
        type: 'union',
        left: bgp(triple(variable('s'), iri(RDF_TYPE), iri(PERSON_URI))),
        right: bgp(
          triple(
            variable('s'),
            iri(RDF_TYPE),
            iri('http://example.org/Animal'),
          ),
        ),
      },
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('UNION');
    expect(result).toContain('WHERE {');
  });

  test('Extend (BIND) inside select plan', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [
        {kind: 'variable', name: 'a0'},
        {kind: 'variable', name: 'computed'},
      ],
      algebra: {
        type: 'extend',
        inner: bgp(
          triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        ),
        variable: 'computed',
        expression: {
          kind: 'function_expr',
          name: 'STRLEN',
          args: [{kind: 'variable_expr', name: 'a0'}],
        },
      },
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('BIND(STRLEN(?a0) AS ?computed)');
  });

  test('Graph pattern inside select plan', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: {
        type: 'graph',
        iri: GRAPH_URI,
        inner: bgp(
          triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        ),
      },
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain(`GRAPH <${GRAPH_URI}>`);
    expect(result).toContain(`?a0 rdf:type <${PERSON_URI}> .`);
  });

  test('EXISTS in filter inside select plan', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      distinct: true,
      algebra: {
        type: 'filter',
        expression: {
          kind: 'exists_expr',
          negated: false,
          pattern: bgp(
            triple(variable('a0'), iri(FRIEND_URI), variable('f')),
          ),
        },
        inner: bgp(
          triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        ),
      },
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('FILTER(EXISTS {');
    expect(result).toContain(`?a0 <${FRIEND_URI}> ?f .`);
  });

  test('NOT EXISTS in filter inside select plan', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      distinct: true,
      algebra: {
        type: 'filter',
        expression: {
          kind: 'exists_expr',
          negated: true,
          pattern: bgp(
            triple(variable('a0'), iri(FRIEND_URI), variable('f')),
          ),
        },
        inner: bgp(
          triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        ),
      },
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('FILTER(NOT EXISTS {');
  });

  test('DISTINCT aggregate in select plan', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [
        {kind: 'variable', name: 'a0'},
        {
          kind: 'aggregate',
          expression: {
            kind: 'aggregate_expr',
            name: 'COUNT',
            args: [{kind: 'variable_expr', name: 'a1'}],
            distinct: true,
          },
          alias: 'cnt',
        },
      ],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
        triple(variable('a0'), iri(FRIEND_URI), variable('a1')),
      ),
      groupBy: ['a0'],
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('(COUNT(DISTINCT ?a1) AS ?cnt)');
    expect(result).toContain('GROUP BY ?a0');
  });
});

// ---------------------------------------------------------------------------
// Output structure validation
// ---------------------------------------------------------------------------

describe('output structure', () => {
  test('PREFIX lines come before SELECT', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
    };

    const result = selectPlanToSparql(plan);
    const prefixIndex = result.indexOf('PREFIX');
    const selectIndex = result.indexOf('SELECT');
    expect(prefixIndex).toBeLessThan(selectIndex);
  });

  test('WHERE comes after SELECT', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
    };

    const result = selectPlanToSparql(plan);
    const selectIndex = result.indexOf('SELECT');
    const whereIndex = result.indexOf('WHERE');
    expect(selectIndex).toBeLessThan(whereIndex);
  });

  test('ORDER BY comes after WHERE closing brace', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
      orderBy: [
        {
          expression: {kind: 'variable_expr', name: 'a0'},
          direction: 'ASC',
        },
      ],
    };

    const result = selectPlanToSparql(plan);
    const lastBrace = result.lastIndexOf('}');
    const orderByIndex = result.indexOf('ORDER BY');
    expect(lastBrace).toBeLessThan(orderByIndex);
  });

  test('LIMIT comes after ORDER BY', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
      orderBy: [
        {
          expression: {kind: 'variable_expr', name: 'a0'},
          direction: 'ASC',
        },
      ],
      limit: 5,
    };

    const result = selectPlanToSparql(plan);
    const orderByIndex = result.indexOf('ORDER BY');
    const limitIndex = result.indexOf('LIMIT');
    expect(orderByIndex).toBeLessThan(limitIndex);
  });

  test('uses SPARQL-standard PREFIX form (not @prefix)', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}],
      algebra: bgp(
        triple(variable('a0'), iri(RDF_TYPE), iri(PERSON_URI)),
      ),
    };

    const result = selectPlanToSparql(plan);
    expect(result).toContain('PREFIX ');
    expect(result).not.toContain('@prefix');
  });
});

// G1 (report 021 §3): binary_expr must parenthesize nested operands so SPARQL
// parses arithmetic/relational precedence correctly.
describe('binary_expr operator precedence (G1)', () => {
  const v = (name: string): SparqlExpression => ({kind: 'variable_expr', name});
  const bin = (op: string, left: SparqlExpression, right: SparqlExpression): SparqlExpression =>
    ({kind: 'binary_expr', op, left, right} as SparqlExpression);

  test('lower-precedence left operand is parenthesized: (a+b)*c', () => {
    // binary(*, binary(+, a, b), c) must NOT serialize as "a + b * c"
    expect(serializeExpression(bin('*', bin('+', v('a'), v('b')), v('c')))).toBe('(?a + ?b) * ?c');
  });

  test('higher-precedence child stays bare: a + b*c', () => {
    expect(serializeExpression(bin('+', v('a'), bin('*', v('b'), v('c'))))).toBe('?a + ?b * ?c');
  });

  test('left-associativity: a - (b - c) keeps parens on the right', () => {
    expect(serializeExpression(bin('-', v('a'), bin('-', v('b'), v('c'))))).toBe('?a - (?b - ?c)');
    // ...but (a - b) - c does not need them
    expect(serializeExpression(bin('-', bin('-', v('a'), v('b')), v('c')))).toBe('?a - ?b - ?c');
  });

  test('arithmetic child of a relational parent stays bare: a + b < c', () => {
    expect(serializeExpression(bin('<', bin('+', v('a'), v('b')), v('c')))).toBe('?a + ?b < ?c');
  });

  test('relational-in-relational is parenthesized (non-associative): (a = b) = c', () => {
    expect(serializeExpression(bin('=', bin('=', v('a'), v('b')), v('c')))).toBe('(?a = ?b) = ?c');
  });

  test('logical child of a binary parent is parenthesized', () => {
    const or: SparqlExpression = {
      kind: 'logical_expr',
      op: 'or',
      exprs: [v('a'), v('b')],
    } as SparqlExpression;
    expect(serializeExpression(bin('=', or, v('c')))).toBe('(?a || ?b) = ?c');
  });
});
