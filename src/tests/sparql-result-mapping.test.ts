import {describe, expect, test} from '@jest/globals';
import {
  mapSparqlSelectResult,
  mapSparqlAskResult,
  mapSparqlCreateResult,
  mapSparqlUpdateResult,
  isSparqlSelectResults,
} from '../sparql/resultMapping';
import type {SparqlJsonResults} from '../sparql/resultMapping';
import type {
  IRCreateMutation,
  IRSelectQuery,
  IRUpdateMutation,
  ResultRow,
} from '../queries/IntermediateRepresentation';

// ---------------------------------------------------------------------------
// XSD datatype URIs (local constants for test clarity)
// ---------------------------------------------------------------------------

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_BOOLEAN = `${XSD}boolean`;
const XSD_INTEGER = `${XSD}integer`;
const XSD_DOUBLE = `${XSD}double`;
const XSD_DATE_TIME = `${XSD}dateTime`;
const XSD_STRING = `${XSD}string`;

// ---------------------------------------------------------------------------
// Test entity / property URIs
// ---------------------------------------------------------------------------

const PERSON_SHAPE = 'linked://tmp/types/Person';
const PROP_NAME = 'linked://tmp/props/name';
const PROP_HOBBY = 'linked://tmp/props/hobby';
const PROP_IS_REAL = 'linked://tmp/props/isRealPerson';
const PROP_BIRTH_DATE = 'linked://tmp/props/birthDate';
const PROP_BEST_FRIEND = 'linked://tmp/props/bestFriend';
const PROP_HAS_FRIEND = 'linked://tmp/props/hasFriend';
const PROP_GUARD_DOG_LEVEL = 'linked://tmp/props/guardDogLevel';
const PROP_NICK_NAME = 'linked://tmp/props/nickName';

const E = (suffix: string) => `linked://tmp/entities/${suffix}`;

// ---------------------------------------------------------------------------
// Helper: minimal IR query builders
// ---------------------------------------------------------------------------

/**
 * Creates a minimal IRSelectQuery for flat property projections from the root.
 */
function flatSelectQuery(
  fields: Array<{key: string; property: string; maxCount?: number}>,
  opts?: {singleResult?: boolean; subjectId?: string},
): IRSelectQuery {
  return {
    kind: 'select',
    root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
    patterns: [],
    projection: fields.map((f, i) => {
      const expr: any = {
        kind: 'property_expr' as const,
        sourceAlias: 'a0',
        property: f.property,
      };
      if (typeof f.maxCount === 'number') {
        expr.maxCount = f.maxCount;
      }
      return {alias: `a${i + 1}`, expression: expr};
    }),
    resultMap: fields.map((f, i) => ({
      key: f.key,
      alias: `a${i + 1}`,
    })),
    singleResult: opts?.singleResult ?? false,
    subjectId: opts?.subjectId,
  };
}

/**
 * Creates an IRSelectQuery for nested properties via a traversal.
 * Root a0 → traverse to a1 via traverseProperty → project fields off a1.
 */
function nestedSelectQuery(
  traverseProperty: string,
  fields: Array<{key: string; property: string; maxCount?: number}>,
  opts?: {singleResult?: boolean},
): IRSelectQuery {
  return {
    kind: 'select',
    root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
    patterns: [
      {
        kind: 'traverse',
        from: 'a0',
        to: 'a1',
        property: traverseProperty,
      },
    ],
    projection: fields.map((f, i) => {
      const expr: any = {
        kind: 'property_expr' as const,
        sourceAlias: 'a1',
        property: f.property,
      };
      if (typeof f.maxCount === 'number') {
        expr.maxCount = f.maxCount;
      }
      return {alias: `a${i + 2}`, expression: expr};
    }),
    resultMap: fields.map((f, i) => ({
      key: f.key,
      alias: `a${i + 2}`,
    })),
    singleResult: opts?.singleResult ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapSparqlSelectResult', () => {
  test('flat literal result — selectName', () => {
    const query = flatSelectQuery([{key: PROP_NAME, property: PROP_NAME, maxCount: 1}]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
          },
          {
            a0: {type: 'uri', value: E('p2')},
            a0_name: {type: 'literal', value: 'Moa'},
          },
          {
            a0: {type: 'uri', value: E('p3')},
            a0_name: {type: 'literal', value: 'Jinx'},
          },
          {
            a0: {type: 'uri', value: E('p4')},
            a0_name: {type: 'literal', value: 'Quinn'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query);
    expect(Array.isArray(result)).toBe(true);
    const rows = result as ResultRow[];
    expect(rows.length).toBe(4);
    expect(rows[0].id).toBe(E('p1'));
    expect(rows[0].name).toBe('Semmy');
    expect(rows[1].id).toBe(E('p2'));
    expect(rows[1].name).toBe('Moa');
    expect(rows[2].id).toBe(E('p3'));
    expect(rows[2].name).toBe('Jinx');
    expect(rows[3].id).toBe(E('p4'));
    expect(rows[3].name).toBe('Quinn');
  });

  test('nested object result — selectFriendsName', () => {
    const query = nestedSelectQuery(
      PROP_HAS_FRIEND,
      [{key: PROP_NAME, property: PROP_NAME, maxCount: 1}],
    );

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1', 'a1_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p2')},
            a1_name: {type: 'literal', value: 'Moa'},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p3')},
            a1_name: {type: 'literal', value: 'Jinx'},
          },
          {
            a0: {type: 'uri', value: E('p2')},
            a1: {type: 'uri', value: E('p3')},
            a1_name: {type: 'literal', value: 'Jinx'},
          },
          {
            a0: {type: 'uri', value: E('p2')},
            a1: {type: 'uri', value: E('p4')},
            a1_name: {type: 'literal', value: 'Quinn'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query);
    expect(Array.isArray(result)).toBe(true);
    const rows = result as ResultRow[];
    expect(rows.length).toBe(2);

    // p1's friends
    expect(rows[0].id).toBe(E('p1'));
    const p1Friends = rows[0].hasFriend as ResultRow[];
    expect(Array.isArray(p1Friends)).toBe(true);
    expect(p1Friends.length).toBe(2);
    expect(p1Friends[0].id).toBe(E('p2'));
    expect(p1Friends[0].name).toBe('Moa');
    expect(p1Friends[1].id).toBe(E('p3'));
    expect(p1Friends[1].name).toBe('Jinx');

    // p2's friends
    expect(rows[1].id).toBe(E('p2'));
    const p2Friends = rows[1].hasFriend as ResultRow[];
    expect(Array.isArray(p2Friends)).toBe(true);
    expect(p2Friends.length).toBe(2);
    expect(p2Friends[0].id).toBe(E('p3'));
    expect(p2Friends[0].name).toBe('Jinx');
    expect(p2Friends[1].id).toBe(E('p4'));
    expect(p2Friends[1].name).toBe('Quinn');
  });

  test('boolean coercion — "true" string', () => {
    const query = flatSelectQuery([{key: PROP_IS_REAL, property: PROP_IS_REAL, maxCount: 1}]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_isRealPerson']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_isRealPerson: {
              type: 'typed-literal',
              value: 'true',
              datatype: XSD_BOOLEAN,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].isRealPerson).toBe(true);
    expect(typeof result[0].isRealPerson).toBe('boolean');
  });

  test('boolean coercion — "1" string', () => {
    const query = flatSelectQuery([{key: PROP_IS_REAL, property: PROP_IS_REAL, maxCount: 1}]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_isRealPerson']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_isRealPerson: {
              type: 'typed-literal',
              value: '1',
              datatype: XSD_BOOLEAN,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].isRealPerson).toBe(true);
    expect(typeof result[0].isRealPerson).toBe('boolean');
  });

  test('boolean coercion — "false" string', () => {
    const query = flatSelectQuery([{key: PROP_IS_REAL, property: PROP_IS_REAL, maxCount: 1}]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_isRealPerson']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_isRealPerson: {
              type: 'typed-literal',
              value: 'false',
              datatype: XSD_BOOLEAN,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].isRealPerson).toBe(false);
    expect(typeof result[0].isRealPerson).toBe('boolean');
  });

  test('boolean coercion — "0" string', () => {
    const query = flatSelectQuery([{key: PROP_IS_REAL, property: PROP_IS_REAL, maxCount: 1}]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_isRealPerson']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_isRealPerson: {
              type: 'typed-literal',
              value: '0',
              datatype: XSD_BOOLEAN,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].isRealPerson).toBe(false);
    expect(typeof result[0].isRealPerson).toBe('boolean');
  });

  test('integer coercion', () => {
    const query = flatSelectQuery([
      {key: PROP_GUARD_DOG_LEVEL, property: PROP_GUARD_DOG_LEVEL, maxCount: 1},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_guardDogLevel']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('dog1')},
            a0_guardDogLevel: {
              type: 'typed-literal',
              value: '2',
              datatype: XSD_INTEGER,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].guardDogLevel).toBe(2);
    expect(typeof result[0].guardDogLevel).toBe('number');
  });

  test('double coercion', () => {
    const query = flatSelectQuery([
      {key: 'linked://tmp/props/score', property: 'linked://tmp/props/score', maxCount: 1},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_score']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('x1')},
            a0_score: {
              type: 'typed-literal',
              value: '3.14',
              datatype: XSD_DOUBLE,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].score).toBe(3.14);
    expect(typeof result[0].score).toBe('number');
  });

  test('dateTime coercion', () => {
    const query = flatSelectQuery([
      {key: PROP_BIRTH_DATE, property: PROP_BIRTH_DATE, maxCount: 1},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_birthDate']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_birthDate: {
              type: 'typed-literal',
              value: '2020-01-01T00:00:00.000Z',
              datatype: XSD_DATE_TIME,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    const birthDate = result[0].birthDate;
    expect(birthDate).toBeInstanceOf(Date);
    expect((birthDate as Date).getFullYear()).toBe(2020);
    expect((birthDate as Date).getMonth()).toBe(0);
    expect((birthDate as Date).getDate()).toBe(1);
  });

  test('missing binding → null', () => {
    const query = flatSelectQuery([
      {key: PROP_HOBBY, property: PROP_HOBBY, maxCount: 1},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_hobby']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p3')},
            // a0_hobby is absent → field should be null
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(E('p3'));
    expect(result[0].hobby).toBeNull();
  });

  test('URI field → id string (entity reference)', () => {
    const query = flatSelectQuery([
      {key: PROP_BEST_FRIEND, property: PROP_BEST_FRIEND, maxCount: 1},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_bestFriend']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p2')},
            a0_bestFriend: {type: 'uri', value: E('p3')},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const bestFriend = result[0].bestFriend as ResultRow;
    expect(bestFriend).toBeDefined();
    expect(bestFriend.id).toBe(E('p3'));
  });

  test('singleResult — one match → single ResultRow', () => {
    const query = flatSelectQuery(
      [{key: PROP_NAME, property: PROP_NAME, maxCount: 1}],
      {singleResult: true},
    );

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query);
    // Should be a single ResultRow, not an array
    expect(Array.isArray(result)).toBe(false);
    expect(result).not.toBeNull();
    const row = result as ResultRow;
    expect(row.id).toBe(E('p1'));
    expect(row.name).toBe('Semmy');
  });

  test('singleResult — no match → null', () => {
    const query = flatSelectQuery(
      [{key: PROP_NAME, property: PROP_NAME, maxCount: 1}],
      {singleResult: true},
    );

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name']},
      results: {
        bindings: [],
      },
    };

    const result = mapSparqlSelectResult(json, query);
    expect(result).toBeNull();
  });

  test('untyped literal → string', () => {
    const query = flatSelectQuery([{key: PROP_NAME, property: PROP_NAME, maxCount: 1}]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].name).toBe('Semmy');
    expect(typeof result[0].name).toBe('string');
  });

  test('xsd:string typed literal → string', () => {
    const query = flatSelectQuery([{key: PROP_NAME, property: PROP_NAME, maxCount: 1}]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {
              type: 'typed-literal',
              value: 'Semmy',
              datatype: XSD_STRING,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result[0].name).toBe('Semmy');
    expect(typeof result[0].name).toBe('string');
  });

  test('empty resultMap (selectAll) returns entity references only', () => {
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [],
      projection: [],
      resultMap: [],
      singleResult: false,
    };

    const json: SparqlJsonResults = {
      head: {vars: ['a0']},
      results: {
        bindings: [
          {a0: {type: 'uri', value: E('p1')}},
          {a0: {type: 'uri', value: E('p2')}},
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(2);
    expect(result[0].id).toBe(E('p1'));
    expect(result[1].id).toBe(E('p2'));
  });

  test('multiple flat fields', () => {
    const query = flatSelectQuery([
      {key: PROP_NAME, property: PROP_NAME, maxCount: 1},
      {key: PROP_HOBBY, property: PROP_HOBBY, maxCount: 1},
      {key: PROP_IS_REAL, property: PROP_IS_REAL, maxCount: 1},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name', 'a0_hobby', 'a0_isRealPerson']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
            a0_hobby: {type: 'literal', value: 'Coding'},
            a0_isRealPerson: {
              type: 'typed-literal',
              value: 'true',
              datatype: XSD_BOOLEAN,
            },
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Semmy');
    expect(result[0].hobby).toBe('Coding');
    expect(result[0].isRealPerson).toBe(true);
  });

  test('deduplicates rows by root entity id', () => {
    const query = flatSelectQuery([{key: PROP_NAME, property: PROP_NAME, maxCount: 1}]);

    // Same entity appears twice (e.g. due to OPTIONAL patterns producing duplicates)
    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(E('p1'));
  });
});

describe('mapSparqlSelectResult — flat multi-value fields', () => {
  test('multi-value flat field collects into array', () => {
    // Person.select(p => p.friends) — friends has no maxCount → multi-value
    const query = flatSelectQuery([
      {key: PROP_HAS_FRIEND, property: PROP_HAS_FRIEND},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_hasFriend']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_hasFriend: {type: 'uri', value: E('p2')},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a0_hasFriend: {type: 'uri', value: E('p3')},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const friends = result[0].hasFriend as ResultRow[];
    expect(Array.isArray(friends)).toBe(true);
    expect(friends.length).toBe(2);
    expect(friends.some((f) => f.id === E('p2'))).toBe(true);
    expect(friends.some((f) => f.id === E('p3'))).toBe(true);
  });

  test('multi-value flat field deduplicates by value', () => {
    const query = flatSelectQuery([
      {key: PROP_HAS_FRIEND, property: PROP_HAS_FRIEND},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_hasFriend']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_hasFriend: {type: 'uri', value: E('p2')},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a0_hasFriend: {type: 'uri', value: E('p2')},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const friends = result[0].hasFriend as ResultRow[];
    expect(friends.length).toBe(1);
    expect(friends[0].id).toBe(E('p2'));
  });

  test('absent multi-value flat field returns empty array', () => {
    const query = flatSelectQuery([
      {key: PROP_HAS_FRIEND, property: PROP_HAS_FRIEND},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_hasFriend']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            // a0_hasFriend absent
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const friends = result[0].hasFriend as ResultRow[];
    expect(Array.isArray(friends)).toBe(true);
    expect(friends.length).toBe(0);
  });

  test('mixed single-value and multi-value flat fields', () => {
    // Person.select(p => [p.name, p.friends]) — name has maxCount:1, friends has none
    const query = flatSelectQuery([
      {key: PROP_NAME, property: PROP_NAME, maxCount: 1},
      {key: PROP_HAS_FRIEND, property: PROP_HAS_FRIEND},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_name', 'a0_hasFriend']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
            a0_hasFriend: {type: 'uri', value: E('p2')},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a0_name: {type: 'literal', value: 'Semmy'},
            a0_hasFriend: {type: 'uri', value: E('p3')},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    // name is single-value → scalar
    expect(result[0].name).toBe('Semmy');
    // friends is multi-value → array
    const friends = result[0].hasFriend as ResultRow[];
    expect(Array.isArray(friends)).toBe(true);
    expect(friends.length).toBe(2);
    expect(friends.some((f) => f.id === E('p2'))).toBe(true);
    expect(friends.some((f) => f.id === E('p3'))).toBe(true);
  });

  test('multi-value flat field in nested mode (with traversal)', () => {
    // Person.select(p => [p.friends, p.bestFriend.name])
    // friends is flat multi-value, bestFriend.name is a traversal
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_BEST_FRIEND, maxCount: 1},
      ],
      projection: [
        {alias: 'a2', expression: {kind: 'property_expr', sourceAlias: 'a0', property: PROP_HAS_FRIEND}},
        {alias: 'a3', expression: {kind: 'property_expr', sourceAlias: 'a1', property: PROP_NAME, maxCount: 1}},
      ],
      resultMap: [
        {key: PROP_HAS_FRIEND, alias: 'a2'},
        {key: PROP_NAME, alias: 'a3'},
      ],
    };

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_hasFriend', 'a1', 'a1_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p2')},
            a0_hasFriend: {type: 'uri', value: E('p3')},
            a1: {type: 'uri', value: E('p3')},
            a1_name: {type: 'literal', value: 'Jinx'},
          },
          {
            a0: {type: 'uri', value: E('p2')},
            a0_hasFriend: {type: 'uri', value: E('p4')},
            a1: {type: 'uri', value: E('p3')},
            a1_name: {type: 'literal', value: 'Jinx'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(E('p2'));

    // friends is multi-value flat → array
    const friends = result[0].hasFriend as ResultRow[];
    expect(Array.isArray(friends)).toBe(true);
    expect(friends.length).toBe(2);
    expect(friends.some((f) => f.id === E('p3'))).toBe(true);
    expect(friends.some((f) => f.id === E('p4'))).toBe(true);

    // bestFriend is maxCount:1 traversal → unwrapped single row
    const bf = result[0].bestFriend as ResultRow;
    expect(bf).toBeDefined();
    expect(bf.name).toBe('Jinx');
  });
});

describe('mapSparqlSelectResult — flat multi-value literal fields', () => {
  test('multi-value literal strings collected into array', () => {
    // Person.select(p => p.nickNames) — nickNames has no maxCount, literal type
    const query = flatSelectQuery([
      {key: PROP_NICK_NAME, property: PROP_NICK_NAME},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_nickName']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_nickName: {type: 'literal', value: 'Sem1'},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a0_nickName: {type: 'literal', value: 'Sem'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const nickNames = result[0].nickName as string[];
    expect(Array.isArray(nickNames)).toBe(true);
    expect(nickNames.length).toBe(2);
    expect(nickNames).toContain('Sem1');
    expect(nickNames).toContain('Sem');
  });

  test('mixed URI and literal multi-value fields in same query', () => {
    // Person.select(p => [p.friends, p.nickNames])
    const query = flatSelectQuery([
      {key: PROP_HAS_FRIEND, property: PROP_HAS_FRIEND},
      {key: PROP_NICK_NAME, property: PROP_NICK_NAME},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_hasFriend', 'a0_nickName']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_hasFriend: {type: 'uri', value: E('p2')},
            a0_nickName: {type: 'literal', value: 'Sem1'},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a0_hasFriend: {type: 'uri', value: E('p3')},
            a0_nickName: {type: 'literal', value: 'Sem'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);

    // URI multi-value → ResultRow[]
    const friends = result[0].hasFriend as ResultRow[];
    expect(Array.isArray(friends)).toBe(true);
    expect(friends.length).toBe(2);
    expect(friends[0].id).toBe(E('p2'));
    expect(friends[1].id).toBe(E('p3'));

    // Literal multi-value → string[]
    const nickNames = result[0].nickName as string[];
    expect(Array.isArray(nickNames)).toBe(true);
    expect(nickNames.length).toBe(2);
    expect(nickNames).toContain('Sem1');
    expect(nickNames).toContain('Sem');
  });

  test('absent multi-value literal field returns empty array', () => {
    const query = flatSelectQuery([
      {key: PROP_NICK_NAME, property: PROP_NICK_NAME},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_nickName']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            // a0_nickName absent
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const nickNames = result[0].nickName as string[];
    expect(Array.isArray(nickNames)).toBe(true);
    expect(nickNames.length).toBe(0);
  });

  test('multi-value literal deduplicates by value', () => {
    const query = flatSelectQuery([
      {key: PROP_NICK_NAME, property: PROP_NICK_NAME},
    ]);

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a0_nickName']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a0_nickName: {type: 'literal', value: 'Sem'},
          },
          {
            a0: {type: 'uri', value: E('p1')},
            a0_nickName: {type: 'literal', value: 'Sem'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const nickNames = result[0].nickName as string[];
    expect(nickNames.length).toBe(1);
    expect(nickNames[0]).toBe('Sem');
  });
});

describe('mapSparqlSelectResult — 3-level nesting', () => {
  // Query: Person.select(p => p.friends.select(f => f.bestFriend.select(bf => bf.name)))
  // root: a0, traverse a0→a1 (hasFriend), traverse a1→a2 (bestFriend, maxCount: 1)
  // projection: a3 = a2.name

  function deepNestedQuery(): IRSelectQuery {
    return {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_HAS_FRIEND},
        {kind: 'traverse', from: 'a1', to: 'a2', property: PROP_BEST_FRIEND, maxCount: 1},
      ],
      projection: [
        // name is single-valued (maxCount 1, as the lowering reads it from the property shape).
        {alias: 'a3', expression: {kind: 'property_expr', sourceAlias: 'a2', property: PROP_NAME, maxCount: 1}},
      ],
      resultMap: [{key: PROP_NAME, alias: 'a3'}],
      singleResult: false,
    };
  }

  test('groups 3-level nesting (friends.bestFriend.name)', () => {
    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1', 'a2', 'a2_name']},
      results: {
        bindings: [
          // p1 → friend p2 → bestFriend p3 (Jinx)
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p2')},
            a2: {type: 'uri', value: E('p3')},
            a2_name: {type: 'literal', value: 'Jinx'},
          },
          // p1 → friend p3 → bestFriend p1 (Semmy)
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p3')},
            a2: {type: 'uri', value: E('p1')},
            a2_name: {type: 'literal', value: 'Semmy'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, deepNestedQuery()) as ResultRow[];
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(E('p1'));

    // Level 1: friends (multi-value, still an array)
    const friends = result[0].hasFriend as ResultRow[];
    expect(Array.isArray(friends)).toBe(true);
    expect(friends.length).toBe(2);

    // p2's bestFriend (single-value, maxCount: 1 → unwrapped)
    const friendP2 = friends.find((f) => f.id === E('p2'))!;
    expect(friendP2).toBeDefined();
    const p2Best = friendP2.bestFriend as ResultRow;
    expect(Array.isArray(p2Best)).toBe(false);
    expect(p2Best.id).toBe(E('p3'));
    expect(p2Best.name).toBe('Jinx');

    // p3's bestFriend (single-value, maxCount: 1 → unwrapped)
    const friendP3 = friends.find((f) => f.id === E('p3'))!;
    expect(friendP3).toBeDefined();
    const p3Best = friendP3.bestFriend as ResultRow;
    expect(Array.isArray(p3Best)).toBe(false);
    expect(p3Best.id).toBe(E('p1'));
    expect(p3Best.name).toBe('Semmy');
  });

  test('entity with missing deep binding has null for single-value property', () => {
    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1', 'a2', 'a2_name']},
      results: {
        bindings: [
          // p1 → friend p2 → bestFriend p3 (Jinx)
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p2')},
            a2: {type: 'uri', value: E('p3')},
            a2_name: {type: 'literal', value: 'Jinx'},
          },
          // p1 → friend p4 has no bestFriend (a2 missing)
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p4')},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, deepNestedQuery()) as ResultRow[];
    expect(result.length).toBe(1);
    const friends = result[0].hasFriend as ResultRow[];
    expect(friends.length).toBe(2);

    const friendP4 = friends.find((f) => f.id === E('p4'))!;
    expect(friendP4).toBeDefined();
    // Single-value property with no match → null (not empty array)
    expect(friendP4.bestFriend).toBeNull();
  });
});

describe('mapSparqlSelectResult — single-value property (maxCount: 1)', () => {
  test('single-value object property returns single ResultRow, not array', () => {
    // Simulates: Person.select(p => p.bestFriend) where bestFriend has maxCount: 1
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_BEST_FRIEND, maxCount: 1},
      ],
      projection: [
        {alias: 'p0', expression: {kind: 'alias_expr', alias: 'a1'}},
      ],
      resultMap: [{key: PROP_BEST_FRIEND, alias: 'p0'}],
      singleResult: false,
    };

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p3')},
          },
          {
            a0: {type: 'uri', value: E('p2')},
            a1: {type: 'uri', value: E('p4')},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(2);

    // bestFriend should be a single ResultRow, NOT an array
    const p1Best = result[0].bestFriend as ResultRow;
    expect(Array.isArray(p1Best)).toBe(false);
    expect(p1Best).not.toBeNull();
    expect(p1Best.id).toBe(E('p3'));

    const p2Best = result[1].bestFriend as ResultRow;
    expect(Array.isArray(p2Best)).toBe(false);
    expect(p2Best).not.toBeNull();
    expect(p2Best.id).toBe(E('p4'));
  });

  test('single-value object property with no match returns null', () => {
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_BEST_FRIEND, maxCount: 1},
      ],
      projection: [
        {alias: 'p0', expression: {kind: 'alias_expr', alias: 'a1'}},
      ],
      resultMap: [{key: PROP_BEST_FRIEND, alias: 'p0'}],
      singleResult: false,
    };

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            // a1 missing — no bestFriend
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    expect(result[0].bestFriend).toBeNull();
  });

  test('single-value property with nested select returns unwrapped ResultRow', () => {
    // Simulates: Person.select(p => p.bestFriend.select(bf => bf.name))
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_BEST_FRIEND, maxCount: 1},
      ],
      projection: [
        {alias: 'a2', expression: {kind: 'property_expr', sourceAlias: 'a1', property: PROP_NAME, maxCount: 1}},
      ],
      resultMap: [{key: PROP_NAME, alias: 'a2'}],
      singleResult: false,
    };

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1', 'a1_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p3')},
            a1_name: {type: 'literal', value: 'Jinx'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);

    // bestFriend should be a single ResultRow with name, not an array
    const bestFriend = result[0].bestFriend as ResultRow;
    expect(Array.isArray(bestFriend)).toBe(false);
    expect(bestFriend).not.toBeNull();
    expect(bestFriend.id).toBe(E('p3'));
    expect(bestFriend.name).toBe('Jinx');
  });

  test('multi-value property without maxCount still returns array', () => {
    // hasFriend has no maxCount → should remain as array
    const query = nestedSelectQuery(
      PROP_HAS_FRIEND,
      [{key: PROP_NAME, property: PROP_NAME, maxCount: 1}],
    );

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1', 'a1_name']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'uri', value: E('p2')},
            a1_name: {type: 'literal', value: 'Moa'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    const friends = result[0].hasFriend;
    expect(Array.isArray(friends)).toBe(true);
  });
});

describe('mapSparqlSelectResult — alias_expr (inline where pattern)', () => {
  // When inline where forces a traversal, projection uses alias_expr
  // instead of property_expr. The nesting descriptor should still
  // place the field in the correct nested group.

  test('alias_expr with literal binding returns coerced value, not {id}', () => {
    // Simulates: Person.select(p => p.hobby.where(h => h.equals('Jogging')))
    // The inline .where() on a literal property forces alias_expr in projection.
    // When SPARQL returns a literal (not URI), it should NOT be wrapped as {id: ...}.
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_HOBBY},
      ],
      projection: [
        {alias: 'p0', expression: {kind: 'alias_expr', alias: 'a1'}},
      ],
      resultMap: [{key: PROP_HOBBY, alias: 'p0'}],
      singleResult: false,
    };

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a1: {type: 'literal', value: 'Jogging'},
          },
          {
            a0: {type: 'uri', value: E('p2')},
            a1: {type: 'literal', value: 'Jogging'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(2);
    // Should be a string, not {id: 'Jogging'}
    expect(result[0].hobby).toBe('Jogging');
    expect(typeof result[0].hobby).toBe('string');
    expect(result[1].hobby).toBe('Jogging');
    expect(typeof result[1].hobby).toBe('string');
  });

  test('alias_expr projection groups into nested array', () => {
    // Simulates: Person.select(p => p.friends.where(f => f.name.equals('Moa')))
    // root: a0, traverse a0→a1 (friends) with filter
    // projection: p0 = alias_expr(a1)  (not property_expr)
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_HAS_FRIEND},
      ],
      projection: [
        {alias: 'p0', expression: {kind: 'alias_expr', alias: 'a1'}},
      ],
      resultMap: [{key: PROP_HAS_FRIEND, alias: 'p0'}],
      singleResult: false,
    };

    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1']},
      results: {
        bindings: [
          {a0: {type: 'uri', value: E('p1')}, a1: {type: 'uri', value: E('p2')}},
          {a0: {type: 'uri', value: E('p1')}, a1: {type: 'uri', value: E('p3')}},
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(E('p1'));

    const friends = result[0].hasFriend as ResultRow[];
    expect(Array.isArray(friends)).toBe(true);
    expect(friends.length).toBe(2);
    expect(friends[0].id).toBe(E('p2'));
    expect(friends[1].id).toBe(E('p3'));
  });
});

describe('mapSparqlCreateResult', () => {
  test('echoes back created fields', () => {
    const generatedUri = 'http://example.org/data/person_01ABC';
    const query: IRCreateMutation = {
      kind: 'create',
      shape: PERSON_SHAPE,
      data: {
        shape: PERSON_SHAPE,
        fields: [
          {property: PROP_NAME, value: 'Test Create'},
          {property: PROP_HOBBY, value: 'Chess'},
        ],
      },
    };

    const result = mapSparqlCreateResult(generatedUri, query);
    expect(result.id).toBe(generatedUri);
    expect(result.name).toBe('Test Create');
    expect(result.hobby).toBe('Chess');
  });

  test('echoes back nested creates', () => {
    const generatedUri = 'http://example.org/data/person_01ABC';
    const nestedId = 'http://example.org/data/person_01DEF';
    const query: IRCreateMutation = {
      kind: 'create',
      shape: PERSON_SHAPE,
      data: {
        shape: PERSON_SHAPE,
        fields: [
          {property: PROP_NAME, value: 'Test Create'},
          {
            property: PROP_BEST_FRIEND,
            value: {
              shape: PERSON_SHAPE,
              fields: [{property: PROP_NAME, value: 'Bestie'}],
              id: nestedId,
            },
          },
        ],
      },
    };

    const result = mapSparqlCreateResult(generatedUri, query);
    expect(result.id).toBe(generatedUri);
    expect(result.name).toBe('Test Create');
    const bestFriend = result.bestFriend as ResultRow;
    expect(bestFriend.id).toBe(nestedId);
    expect(bestFriend.name).toBe('Bestie');
  });

  test('echoes back reference values', () => {
    const generatedUri = 'http://example.org/data/person_01ABC';
    const query: IRCreateMutation = {
      kind: 'create',
      shape: PERSON_SHAPE,
      data: {
        shape: PERSON_SHAPE,
        fields: [
          {property: PROP_NAME, value: 'Test Create'},
          {property: PROP_BEST_FRIEND, value: {id: E('p2')}},
        ],
      },
    };

    const result = mapSparqlCreateResult(generatedUri, query);
    expect(result.id).toBe(generatedUri);
    const bestFriend = result.bestFriend as ResultRow;
    expect(bestFriend.id).toBe(E('p2'));
  });
});

describe('mapSparqlUpdateResult', () => {
  test('echoes back updated fields', () => {
    const query: IRUpdateMutation = {
      kind: 'update',
      shape: PERSON_SHAPE,
      id: E('p1'),
      data: {
        shape: PERSON_SHAPE,
        fields: [
          {property: PROP_HOBBY, value: 'Chess'},
        ],
      },
    };

    const result = mapSparqlUpdateResult(query);
    expect(result.id).toBe(E('p1'));
    expect(result.hobby).toBe('Chess');
  });

  test('echoes back multiple updated fields', () => {
    const query: IRUpdateMutation = {
      kind: 'update',
      shape: PERSON_SHAPE,
      id: E('p1'),
      data: {
        shape: PERSON_SHAPE,
        fields: [
          {property: PROP_NAME, value: 'New Name'},
          {property: PROP_HOBBY, value: 'Chess'},
        ],
      },
    };

    const result = mapSparqlUpdateResult(query);
    expect(result.id).toBe(E('p1'));
    expect(result.name).toBe('New Name');
    expect(result.hobby).toBe('Chess');
  });

  test('echoes back null for unset fields', () => {
    const query: IRUpdateMutation = {
      kind: 'update',
      shape: PERSON_SHAPE,
      id: E('p1'),
      data: {
        shape: PERSON_SHAPE,
        fields: [
          {property: PROP_HOBBY, value: null},
        ],
      },
    };

    const result = mapSparqlUpdateResult(query);
    expect(result.id).toBe(E('p1'));
    expect(result.hobby).toBeNull();
  });

  test('echoes back date values', () => {
    const date = new Date('2020-01-01');
    const query: IRUpdateMutation = {
      kind: 'update',
      shape: PERSON_SHAPE,
      id: E('p1'),
      data: {
        shape: PERSON_SHAPE,
        fields: [
          {property: PROP_BIRTH_DATE, value: date},
        ],
      },
    };

    const result = mapSparqlUpdateResult(query);
    expect(result.id).toBe(E('p1'));
    expect(result.birthDate).toBeInstanceOf(Date);
    expect((result.birthDate as Date).getFullYear()).toBe(2020);
  });
});

// ---------------------------------------------------------------------------
// Aggregate result mapping with traversal (GROUP BY)
// ---------------------------------------------------------------------------

describe('mapSparqlSelectResult — aggregate with traversal', () => {
  test('renamed aggregate alias (a1 → a1_agg) produces correct count', () => {
    // Simulates: Person.select(p => p.friends.friends.size())
    // irToAlgebra renames aggregate alias a1 → a1_agg because a1 collides
    // with the traverse alias. It updates resultMap but NOT projection.
    // The result mapping must handle the missing projection entry.
    const query: IRSelectQuery = {
      kind: 'select',
      root: {kind: 'shape_scan', shape: PERSON_SHAPE, alias: 'a0'},
      patterns: [
        {kind: 'traverse', from: 'a0', to: 'a1', property: PROP_HAS_FRIEND},
      ],
      projection: [
        // Projection still has alias 'a1' (not renamed)
        {
          alias: 'a1',
          expression: {
            kind: 'aggregate_expr',
            name: 'count',
            args: [{kind: 'property_expr', sourceAlias: 'a1', property: PROP_HAS_FRIEND}],
          },
        },
      ],
      // resultMap was updated by irToAlgebra to use 'a1_agg'
      resultMap: [{key: 'friends', alias: 'a1_agg'}],
    };

    // Fuseki GROUP BY result uses the renamed variable a1_agg
    const json: SparqlJsonResults = {
      head: {vars: ['a0', 'a1_agg']},
      results: {
        bindings: [
          {
            a0: {type: 'uri', value: E('p1')},
            a1_agg: {type: 'typed-literal', value: '2', datatype: 'http://www.w3.org/2001/XMLSchema#integer'},
          },
          {
            a0: {type: 'uri', value: E('p2')},
            a1_agg: {type: 'typed-literal', value: '0', datatype: 'http://www.w3.org/2001/XMLSchema#integer'},
          },
        ],
      },
    };

    const result = mapSparqlSelectResult(json, query) as ResultRow[];
    expect(result.length).toBe(2);

    const p1 = result.find((r) => r.id === E('p1'));
    expect(p1).toBeDefined();
    expect(p1!.friends).toBe(2);

    const p2 = result.find((r) => r.id === E('p2'));
    expect(p2).toBeDefined();
    expect(p2!.friends).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ASK results
// ---------------------------------------------------------------------------

describe('mapSparqlAskResult', () => {
  // The wire shape Fuseki (and any SPARQL 1.1 endpoint) returns for ASK: no
  // `results` key at all, just `boolean`.
  const askTrue = {head: {}, boolean: true};
  const askFalse = {head: {}, boolean: false};

  test('maps the boolean through, both ways', () => {
    expect(mapSparqlAskResult(askTrue)).toBe(true);
    expect(mapSparqlAskResult(askFalse)).toBe(false);
  });

  test('THROWS on a SELECT result set rather than coercing it', () => {
    // A result set arriving here means the wrong query form reached the endpoint.
    // Coercing it — `!!json.results.bindings.length` — would be a plausible-looking
    // answer to a question that was never asked, which is the failure mode the
    // whole existence check exists to remove.
    const selectResults: SparqlJsonResults = {
      head: {vars: ['a0']},
      results: {bindings: [{a0: {type: 'uri', value: 'urn:x'}}]},
    };
    expect(() => mapSparqlAskResult(selectResults)).toThrow(/SELECT result set/);
    expect(() =>
      mapSparqlAskResult({head: {vars: []}, results: {bindings: []}}),
    ).toThrow(/SELECT result set/);
  });

  test('throws on a malformed response', () => {
    expect(() => mapSparqlAskResult({head: {}} as any)).toThrow(/ASK/);
    expect(() => mapSparqlAskResult({head: {}, boolean: 'true'} as any)).toThrow(/ASK/);
    expect(() => mapSparqlAskResult(null as any)).toThrow(/ASK/);
  });
});

describe('isSparqlSelectResults', () => {
  test('separates the two response shapes', () => {
    expect(isSparqlSelectResults({head: {}, boolean: true})).toBe(false);
    expect(
      isSparqlSelectResults({head: {vars: []}, results: {bindings: []}}),
    ).toBe(true);
  });
});
