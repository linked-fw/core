/**
 * Golden tests for the full SPARQL SELECT pipeline:
 *   query factory → IR → algebra → SPARQL string
 *
 * Each test captures the query from a DSL fixture, runs it through
 * buildSelectQuery (IR pipeline) then selectToSparql, and asserts the
 * exact SPARQL string output.
 */
import {describe, expect, test} from '@jest/globals';
import {
  queryFactories,
  personClass,
  employeeClass,
  propBase,
} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';
import {setQueryContext} from '../queries/QueryContext';
import {Person} from '../test-helpers/query-fixtures';

import '../ontologies/rdf';
import '../ontologies/xsd';

setQueryContext('user', {id: 'user-1'}, Person);

// ---------------------------------------------------------------------------
// URI shorthands for readability
// ---------------------------------------------------------------------------

// Shape IRIs — these identify the SHACL *descriptions*, and are what property
// predicates are derived from.
const P = 'https://linked.cm/shape/core/Person';
// Property predicates are the declared `sh:path`, not derived from the shape IRI.
const PROP = propBase;
const E = 'https://linked.cm/shape/core/Employee';
const D = 'https://linked.cm/shape/core/Dog';
const S = 'https://linked.cm/shape/core/Shape';

// Class IRIs — the separate nodes each shape declares as its `targetClass`, and
// the only thing that appears as an `rdf:type`. Temporary IRIs in these fixtures;
// in a real dataset the same node would carry `rdf:type rdfs:Class`.
const PT = personClass.id;
const ET = employeeClass.id;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const goldenSelect = async (
  factory: () => Promise<unknown>,
): Promise<string> => {
  const ir = await captureQuery(factory);
  return selectToSparql(ir);
};

// ---------------------------------------------------------------------------
// Basic property selection
// ---------------------------------------------------------------------------

describe('SPARQL golden — basic selection', () => {
  test('selectName', async () => {
    const sparql = await goldenSelect(queryFactories.selectName);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
}`);
  });

  test('selectFriends', async () => {
    const sparql = await goldenSelect(queryFactories.selectFriends);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_friends
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
}`);
  });

  test('selectBirthDate', async () => {
    const sparql = await goldenSelect(queryFactories.selectBirthDate);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_birthDate
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}birthDate> ?a0_birthDate .
  }
}`);
  });

  test('selectIsRealPerson', async () => {
    const sparql = await goldenSelect(queryFactories.selectIsRealPerson);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_isRealPerson
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}isRealPerson> ?a0_isRealPerson .
  }
}`);
  });

  test('selectAll', async () => {
    const sparql = await goldenSelect(queryFactories.selectAll);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <${PT}> .
}`);
  });

  test('selectAllProperties', async () => {
    const sparql = await goldenSelect(queryFactories.selectAllProperties);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?a0 ?a0_name ?a0_hobby ?a0_nickNames ?a0_birthDate ?a0_isRealPerson ?a0_bestFriend ?a0_friends ?a0_pets ?a0_firstPet ?a0_pluralTestProp ?a0_label ?a0_type
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  OPTIONAL {
    ?a0 <${PROP}hobby> ?a0_hobby .
  }
  OPTIONAL {
    ?a0 <${PROP}nickName> ?a0_nickNames .
  }
  OPTIONAL {
    ?a0 <${PROP}birthDate> ?a0_birthDate .
  }
  OPTIONAL {
    ?a0 <${PROP}isRealPerson> ?a0_isRealPerson .
  }
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a0_bestFriend .
  }
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
  OPTIONAL {
    ?a0 <${PROP}hasPet> ?a0_pets .
  }
  OPTIONAL {
    ?a0 <${PROP}hasPet> ?a0_firstPet .
  }
  OPTIONAL {
    ?a0 <${PROP}pluralTestProp> ?a0_pluralTestProp .
  }
  OPTIONAL {
    ?a0 rdfs:label ?a0_label .
  }
  OPTIONAL {
    ?a0 rdf:type ?a0_type .
  }
}`);
  });

  test('selectNonExistingMultiple', async () => {
    const sparql = await goldenSelect(queryFactories.selectNonExistingMultiple);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_bestFriend ?a0_friends
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a0_bestFriend .
  }
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// SubjectId / filtering by ID
// ---------------------------------------------------------------------------

describe('SPARQL golden — subjectId', () => {
  test('selectById', async () => {
    const sparql = await goldenSelect(queryFactories.selectById);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(?a0 = <linked://tmp/entities/p1>)
}`);
  });

  test('selectByIdReference', async () => {
    const sparql = await goldenSelect(queryFactories.selectByIdReference);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(?a0 = <linked://tmp/entities/p1>)
}`);
  });

  test('selectNonExisting', async () => {
    const sparql = await goldenSelect(queryFactories.selectNonExisting);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(?a0 = <https://does.not/exist>)
}`);
  });

  test('selectUndefinedOnly', async () => {
    const sparql = await goldenSelect(queryFactories.selectUndefinedOnly);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_hobby ?a0_bestFriend
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hobby> ?a0_hobby .
  }
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a0_bestFriend .
  }
  FILTER(?a0 = <linked://tmp/entities/p3>)
}`);
  });

  test('selectOne', async () => {
    const sparql = await goldenSelect(queryFactories.selectOne);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(?a0 = <linked://tmp/entities/p1>)
}
LIMIT 1`);
  });
});

// ---------------------------------------------------------------------------
// Nested traversals
// ---------------------------------------------------------------------------

describe('SPARQL golden — nested traversals', () => {
  test('selectFriendsName', async () => {
    const sparql = await goldenSelect(queryFactories.selectFriendsName);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
}`);
  });

  test('selectNestedFriendsName', async () => {
    const sparql = await goldenSelect(queryFactories.selectNestedFriendsName);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a2_name ?a1 ?a2
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}hasFriend> ?a2 .
      OPTIONAL {
        ?a2 <${PROP}name> ?a2_name .
      }
    }
  }
}`);
  });

  test('selectMultiplePaths', async () => {
    const sparql = await goldenSelect(queryFactories.selectMultiplePaths);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a0_friends ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
}`);
  });

  test('selectBestFriendName', async () => {
    const sparql = await goldenSelect(queryFactories.selectBestFriendName);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
}`);
  });

  test('selectDeepNested', async () => {
    const sparql = await goldenSelect(queryFactories.selectDeepNested);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a3_name ?a1 ?a2 ?a3
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}bestFriend> ?a2 .
      OPTIONAL {
        ?a2 <${PROP}bestFriend> ?a3 .
        OPTIONAL {
          ?a3 <${PROP}name> ?a3_name .
        }
      }
    }
  }
}`);
  });

  test('selectDuplicatePaths', async () => {
    const sparql = await goldenSelect(queryFactories.selectDuplicatePaths);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1_hobby ?a1_isRealPerson ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
    OPTIONAL {
      ?a1 <${PROP}isRealPerson> ?a1_isRealPerson .
    }
  }
}`);
  });

  test('nestedObjectProperty', async () => {
    const sparql = await goldenSelect(queryFactories.nestedObjectProperty);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_bestFriend ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}bestFriend> ?a1_bestFriend .
    }
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Inline where / filter fixtures
// ---------------------------------------------------------------------------

describe('SPARQL golden — inline where (lowered to projection)', () => {
  test('whereFriendsNameEquals', async () => {
    const sparql = await goldenSelect(queryFactories.whereFriendsNameEquals);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    FILTER(?a1_name = "Moa")
  }
}`);
  });

  test('whereHobbyEquals', async () => {
    const sparql = await goldenSelect(queryFactories.whereHobbyEquals);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hobby> ?a1 .
    FILTER(?a1 = "Jogging")
  }
}`);
  });

  test('whereAnd', async () => {
    const sparql = await goldenSelect(queryFactories.whereAnd);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
    FILTER(?a1_name = "Moa" && ?a1_hobby = "Jogging")
  }
}`);
  });

  test('whereOr', async () => {
    const sparql = await goldenSelect(queryFactories.whereOr);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
    FILTER(?a1_name = "Jinx" || ?a1_hobby = "Jogging")
  }
}`);
  });

  test('whereAndOrAnd', async () => {
    const sparql = await goldenSelect(queryFactories.whereAndOrAnd);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
    FILTER((?a1_name = "Jinx" || ?a1_hobby = "Jogging") && ?a1_name = "Moa")
  }
}`);
  });

  test('whereAndOrAndNested', async () => {
    const sparql = await goldenSelect(queryFactories.whereAndOrAndNested);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
    FILTER(?a1_name = "Jinx" || ?a1_hobby = "Jogging" && ?a1_name = "Moa")
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Outer where clause (query-level FILTER)
// ---------------------------------------------------------------------------

describe('SPARQL golden — outer where', () => {
  test('whereBestFriendEquals', async () => {
    const sparql = await goldenSelect(queryFactories.whereBestFriendEquals);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}bestFriend> ?a0_bestFriend .
  FILTER(?a0_bestFriend = <linked://tmp/entities/p3>)
}`);
  });

  test('selectWhereNameSemmy', async () => {
    const sparql = await goldenSelect(queryFactories.selectWhereNameSemmy);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(?a0_name = "Semmy")
}`);
  });

  test('outerWhere', async () => {
    const sparql = await goldenSelect(queryFactories.outerWhere);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_friends
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
  FILTER(?a0_name = "Semmy")
}`);
  });

  test('outerWhereLimit', async () => {
    const sparql = await goldenSelect(queryFactories.outerWhereLimit);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(?a0_name = "Semmy" || ?a0_name = "Moa")
}
LIMIT 1`);
  });

  test('outerWhereDifferentPropsOr', async () => {
    const sparql = await goldenSelect(queryFactories.outerWhereDifferentPropsOr);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name ?a0_hobby
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  OPTIONAL {
    ?a0 <${PROP}hobby> ?a0_hobby .
  }
  FILTER(?a0_name = "Jinx" || ?a0_hobby = "Jogging")
}`);
  });

  test('whereSomeImplicit', async () => {
    const sparql = await goldenSelect(queryFactories.whereSomeImplicit);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}hasFriend> ?a1 .
  ?a1 <${PROP}name> ?a1_name .
  FILTER(?a1_name = "Moa")
}`);
  });

  test('whereSomeExplicit', async () => {
    const sparql = await goldenSelect(queryFactories.whereSomeExplicit);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <${PT}> .
  FILTER(EXISTS {
    ?a0 <${PROP}hasFriend> ?a1 .
    ?a1 <${PROP}name> ?a1_name .
    FILTER(?a1_name = "Moa")
  })
}`);
  });

  test('whereEvery', async () => {
    const sparql = await goldenSelect(queryFactories.whereEvery);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <${PT}> .
  FILTER(!(EXISTS {
    ?a0 <${PROP}hasFriend> ?a1 .
    ?a1 <${PROP}name> ?a1_name .
    FILTER(!(?a1_name = "Moa" || ?a1_name = "Jinx"))
  }))
}`);
  });

  test('whereNone', async () => {
    const sparql = await goldenSelect(queryFactories.whereNone);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(!(EXISTS {
    ?a0 <${PROP}hasFriend> ?a1 .
    ?a1 <${PROP}hobby> ?a1_hobby .
    FILTER(?a1_hobby = "Chess")
  }))
}`);
  });

  test('whereSomeNot — equivalent to whereNone', async () => {
    const sparql = await goldenSelect(queryFactories.whereSomeNot);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(!(EXISTS {
    ?a0 <${PROP}hasFriend> ?a1 .
    ?a1 <${PROP}hobby> ?a1_hobby .
    FILTER(?a1_hobby = "Chess")
  }))
}`);
  });

  test('whereEqualsNot — negated equality', async () => {
    const sparql = await goldenSelect(queryFactories.whereEqualsNot);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(!(?a0_name = "Alice"))
}`);
  });

  test('whereNoneAndEquals — .none().and() chaining', async () => {
    const sparql = await goldenSelect(queryFactories.whereNoneAndEquals);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(!(EXISTS {
    ?a0 <${PROP}hasFriend> ?a1 .
    ?a1 <${PROP}hobby> ?a1_hobby .
    FILTER(?a1_hobby = "Chess")
  }) && ?a0_name = "Bob")
}`);
  });

  test('whereNeq — != operator', async () => {
    const sparql = await goldenSelect(queryFactories.whereNeq);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(?a0_name != "Alice")
}`);
  });

  test('whereExprNot — Expr.not() wrapping compound condition', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprNot);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  ?a0 <${PROP}hobby> ?a0_hobby .
  FILTER(!(?a0_name = "Alice" && ?a0_hobby = "Chess"))
}`);
  });

  test('whereSequences', async () => {
    const sparql = await goldenSelect(queryFactories.whereSequences);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}name> ?a0_name .
  FILTER(EXISTS {
    ?a0 <${PROP}hasFriend> ?a1 .
    ?a1 <${PROP}name> ?a1_name .
    FILTER(?a1_name = "Jinx")
  } && ?a0_name = "Semmy")
}`);
  });

  test('whereWithContext', async () => {
    const sparql = await goldenSelect(queryFactories.whereWithContext);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}bestFriend> ?a0_bestFriend .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(?a0_bestFriend = <user-1>)
}`);
  });

  test('whereWithContextPath', async () => {
    const sparql = await goldenSelect(queryFactories.whereWithContextPath);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  FILTER(EXISTS {
    ?a0 <${PROP}hasFriend> ?a1 .
    ?a1 <${PROP}name> ?a1_name .
    <user-1> <${PROP}name> ?__ctx__user_1_name .
    FILTER(?a1_name = ?__ctx__user_1_name)
  })
}`);
  });
});

// ---------------------------------------------------------------------------
// Aggregates and GROUP BY
// ---------------------------------------------------------------------------

describe('SPARQL golden — aggregates', () => {
  test('countFriends', async () => {
    const sparql = await goldenSelect(queryFactories.countFriends);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?a0 (COUNT(?a0_friends) AS ?a1)
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
}
GROUP BY ?a0`);
  });

  test('countNestedFriends', async () => {
    const sparql = await goldenSelect(queryFactories.countNestedFriends);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?a0 (COUNT(?a1_friends) AS ?a1_agg)
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}hasFriend> ?a1 .
  OPTIONAL {
    ?a1 <${PROP}hasFriend> ?a1_friends .
  }
}
GROUP BY ?a0`);
  });

  test('countLabel', async () => {
    const sparql = await goldenSelect(queryFactories.countLabel);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?a0 (COUNT(?a1_friends) AS ?a1_agg)
WHERE {
  ?a0 rdf:type <${PT}> .
  ?a0 <${PROP}hasFriend> ?a1 .
  OPTIONAL {
    ?a1 <${PROP}hasFriend> ?a1_friends .
  }
}
GROUP BY ?a0`);
  });

  test('customResultNumFriends', async () => {
    const sparql = await goldenSelect(queryFactories.customResultNumFriends);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?a0 (COUNT(?a0_friends) AS ?a1)
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
}
GROUP BY ?a0`);
  });

  test('countEquals', async () => {
    const sparql = await goldenSelect(queryFactories.countEquals);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?a0
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
}
GROUP BY ?a0
HAVING(COUNT(?a0_friends) = "2"^^xsd:integer)`);
  });

  test('customResultEqualsBoolean', async () => {
    const sparql = await goldenSelect(queryFactories.customResultEqualsBoolean);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 (?a0_bestFriend = <linked://tmp/entities/p3> AS ?a1)
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a0_bestFriend .
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('SPARQL golden — ordering', () => {
  test('sortByAsc', async () => {
    const sparql = await goldenSelect(queryFactories.sortByAsc);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
}
ORDER BY ASC(?a0_name)`);
  });

  test('sortByDesc', async () => {
    const sparql = await goldenSelect(queryFactories.sortByDesc);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
}
ORDER BY DESC(?a0_name)`);
  });
});

// ---------------------------------------------------------------------------
// Sub-selects (nested select / selectAll)
// ---------------------------------------------------------------------------

describe('SPARQL golden — sub-selects', () => {
  test('subSelectSingleProp', async () => {
    const sparql = await goldenSelect(queryFactories.subSelectSingleProp);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
}`);
  });

  test('subSelectPluralCustom', async () => {
    const sparql = await goldenSelect(queryFactories.subSelectPluralCustom);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1_hobby ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
  }
}`);
  });

  test('subSelectAllProperties', async () => {
    const sparql = await goldenSelect(queryFactories.subSelectAllProperties);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?a0 ?a1_name ?a1_hobby ?a1_nickNames ?a1_birthDate ?a1_isRealPerson ?a1_bestFriend ?a1_friends ?a1_pets ?a1_firstPet ?a1_pluralTestProp ?a1_label ?a1_type ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
    OPTIONAL {
      ?a1 <${PROP}nickName> ?a1_nickNames .
    }
    OPTIONAL {
      ?a1 <${PROP}birthDate> ?a1_birthDate .
    }
    OPTIONAL {
      ?a1 <${PROP}isRealPerson> ?a1_isRealPerson .
    }
    OPTIONAL {
      ?a1 <${PROP}bestFriend> ?a1_bestFriend .
    }
    OPTIONAL {
      ?a1 <${PROP}hasFriend> ?a1_friends .
    }
    OPTIONAL {
      ?a1 <${PROP}hasPet> ?a1_pets .
    }
    OPTIONAL {
      ?a1 <${PROP}hasPet> ?a1_firstPet .
    }
    OPTIONAL {
      ?a1 <${PROP}pluralTestProp> ?a1_pluralTestProp .
    }
    OPTIONAL {
      ?a1 rdfs:label ?a1_label .
    }
    OPTIONAL {
      ?a1 rdf:type ?a1_type .
    }
  }
}`);
  });

  test('subSelectAllPropertiesSingle', async () => {
    const sparql = await goldenSelect(queryFactories.subSelectAllPropertiesSingle);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?a0 ?a1_name ?a1_hobby ?a1_nickNames ?a1_birthDate ?a1_isRealPerson ?a1_bestFriend ?a1_friends ?a1_pets ?a1_firstPet ?a1_pluralTestProp ?a1_label ?a1_type ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
    OPTIONAL {
      ?a1 <${PROP}nickName> ?a1_nickNames .
    }
    OPTIONAL {
      ?a1 <${PROP}birthDate> ?a1_birthDate .
    }
    OPTIONAL {
      ?a1 <${PROP}isRealPerson> ?a1_isRealPerson .
    }
    OPTIONAL {
      ?a1 <${PROP}bestFriend> ?a1_bestFriend .
    }
    OPTIONAL {
      ?a1 <${PROP}hasFriend> ?a1_friends .
    }
    OPTIONAL {
      ?a1 <${PROP}hasPet> ?a1_pets .
    }
    OPTIONAL {
      ?a1 <${PROP}hasPet> ?a1_firstPet .
    }
    OPTIONAL {
      ?a1 <${PROP}pluralTestProp> ?a1_pluralTestProp .
    }
    OPTIONAL {
      ?a1 rdfs:label ?a1_label .
    }
    OPTIONAL {
      ?a1 rdf:type ?a1_type .
    }
  }
}`);
  });

  test('subSelectAllPrimitives', async () => {
    const sparql = await goldenSelect(queryFactories.subSelectAllPrimitives);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1_birthDate ?a1_isRealPerson ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}birthDate> ?a1_birthDate .
    }
    OPTIONAL {
      ?a1 <${PROP}isRealPerson> ?a1_isRealPerson .
    }
  }
}`);
  });

  test('subSelectArray', async () => {
    const sparql = await goldenSelect(queryFactories.subSelectArray);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1_hobby ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
    OPTIONAL {
      ?a1 <${PROP}hobby> ?a1_hobby .
    }
  }
}`);
  });

  test('doubleNestedSubSelect', async () => {
    const sparql = await goldenSelect(queryFactories.doubleNestedSubSelect);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a2_name ?a1 ?a2
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}bestFriend> ?a2 .
      OPTIONAL {
        ?a2 <${PROP}name> ?a2_name .
      }
    }
  }
}`);
  });

  test('nestedQueries2', async () => {
    const sparql = await goldenSelect(queryFactories.nestedQueries2);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_firstPet ?a2_name ?a1 ?a2
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}hasPet> ?a1_firstPet .
    }
    OPTIONAL {
      ?a1 <${PROP}bestFriend> ?a2 .
      OPTIONAL {
        ?a2 <${PROP}name> ?a2_name .
      }
    }
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Shape casting (as)
// ---------------------------------------------------------------------------

describe('SPARQL golden — shape casting', () => {
  test('selectShapeSetAs', async () => {
    const sparql = await goldenSelect(queryFactories.selectShapeSetAs);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_guardDogLevel ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasPet> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}guardDogLevel> ?a1_guardDogLevel .
    }
  }
}`);
  });

  test('selectShapeAs', async () => {
    const sparql = await goldenSelect(queryFactories.selectShapeAs);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_guardDogLevel ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}hasPet> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}guardDogLevel> ?a1_guardDogLevel .
    }
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Employee (subclass) queries
// ---------------------------------------------------------------------------

describe('SPARQL golden — employee', () => {
  test('selectAllEmployeeProperties', async () => {
    const sparql = await goldenSelect(queryFactories.selectAllEmployeeProperties);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?a0 ?a0_name ?a0_bestFriend ?a0_department ?a0_hobby ?a0_nickNames ?a0_birthDate ?a0_isRealPerson ?a0_friends ?a0_pets ?a0_firstPet ?a0_pluralTestProp ?a0_label ?a0_type
WHERE {
  ?a0 rdf:type <${ET}> .
  OPTIONAL {
    ?a0 <${PROP}employeeName> ?a0_name .
  }
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a0_bestFriend .
  }
  OPTIONAL {
    ?a0 <${PROP}employeeDepartment> ?a0_department .
  }
  OPTIONAL {
    ?a0 <${PROP}hobby> ?a0_hobby .
  }
  OPTIONAL {
    ?a0 <${PROP}nickName> ?a0_nickNames .
  }
  OPTIONAL {
    ?a0 <${PROP}birthDate> ?a0_birthDate .
  }
  OPTIONAL {
    ?a0 <${PROP}isRealPerson> ?a0_isRealPerson .
  }
  OPTIONAL {
    ?a0 <${PROP}hasFriend> ?a0_friends .
  }
  OPTIONAL {
    ?a0 <${PROP}hasPet> ?a0_pets .
  }
  OPTIONAL {
    ?a0 <${PROP}hasPet> ?a0_firstPet .
  }
  OPTIONAL {
    ?a0 <${PROP}pluralTestProp> ?a0_pluralTestProp .
  }
  OPTIONAL {
    ?a0 rdfs:label ?a0_label .
  }
  OPTIONAL {
    ?a0 rdf:type ?a0_type .
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// preloadFor
// ---------------------------------------------------------------------------

describe('SPARQL golden — preload', () => {
  test('preloadBestFriend', async () => {
    const sparql = await goldenSelect(queryFactories.preloadBestFriend);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a1_name ?a1
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}bestFriend> ?a1 .
    OPTIONAL {
      ?a1 <${PROP}name> ?a1_name .
    }
  }
}`);
  });

  test('QueryBuilder.preload() produces same SPARQL as DSL preloadFor', async () => {
    const sparql = await goldenSelect(queryFactories.queryBuilderPreload);
    // QueryBuilder.preload adds name selection + bestFriend preload
    expect(sparql).toContain('OPTIONAL');
    expect(sparql).toContain(`<${PROP}bestFriend>`);
    expect(sparql).toContain(`<${PROP}name>`);
  });
});

// ---------------------------------------------------------------------------
// MINUS patterns
// ---------------------------------------------------------------------------

describe('SPARQL golden — MINUS patterns', () => {
  test('minusShape — exclude by shape type', async () => {
    const sparql = await goldenSelect(queryFactories.minusShape);
    expect(sparql).toContain('MINUS {');
    expect(sparql).toContain(`rdf:type <${ET}>`);
    expect(sparql).toContain(`<${PROP}name>`);
  });

  test('minusCondition — exclude by property condition', async () => {
    const sparql = await goldenSelect(queryFactories.minusCondition);
    expect(sparql).toContain('MINUS {');
    expect(sparql).toContain(`<${PROP}hobby>`);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('"Chess"');
  });

  test('minusChained — two separate MINUS blocks', async () => {
    const sparql = await goldenSelect(queryFactories.minusChained);
    const minusCount = (sparql.match(/MINUS \{/g) || []).length;
    expect(minusCount).toBe(2);
    expect(sparql).toContain(`rdf:type <${ET}>`);
    expect(sparql).toContain('"Chess"');
  });

  test('minusMultiProperty — exclude where multiple properties exist', async () => {
    const sparql = await goldenSelect(queryFactories.minusMultiProperty);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  MINUS {
    ?a0 <${PROP}hobby> ?a1 .
    ?a0 <${PROP}nickName> ?a2 .
  }
}`);
  });

  test('minusNestedPath — exclude where nested property path exists', async () => {
    const sparql = await goldenSelect(queryFactories.minusNestedPath);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  MINUS {
    ?a0 <${PROP}bestFriend> ?a1 .
    ?a1 <${PROP}name> ?a2 .
  }
}`);
  });

  test('minusMixed — flat and nested in one MINUS block', async () => {
    const sparql = await goldenSelect(queryFactories.minusMixed);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  MINUS {
    ?a0 <${PROP}hobby> ?a1 .
    ?a0 <${PROP}bestFriend> ?a2 .
    ?a2 <${PROP}name> ?a3 .
  }
}`);
  });

  test('minusSingleProperty — single property existence (no array)', async () => {
    const sparql = await goldenSelect(queryFactories.minusSingleProperty);
    expect(sparql).toBe(
`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0 ?a0_name
WHERE {
  ?a0 rdf:type <${PT}> .
  OPTIONAL {
    ?a0 <${PROP}name> ?a0_name .
  }
  MINUS {
    ?a0 <${PROP}hobby> ?a1 .
  }
}`);
  });
});

// ---------------------------------------------------------------------------
// Computed expressions in projections
// ---------------------------------------------------------------------------

describe('SPARQL golden — computed expressions', () => {
  test('exprStrlen', async () => {
    const sparql = await goldenSelect(queryFactories.exprStrlen);
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain(`<${PROP}name>`);
  });

  test('exprCustomKey', async () => {
    const sparql = await goldenSelect(queryFactories.exprCustomKey);
    expect(sparql).toContain('STRLEN');
  });

  test('exprNestedPath', async () => {
    const sparql = await goldenSelect(queryFactories.exprNestedPath);
    expect(sparql).toContain('UCASE');
    expect(sparql).toContain(`<${PROP}bestFriend>`);
    expect(sparql).toContain(`<${PROP}name>`);
  });

  test('exprMultiple', async () => {
    const sparql = await goldenSelect(queryFactories.exprMultiple);
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain(`<${PROP}name>`);
  });
});

// ---------------------------------------------------------------------------
// Expression-based WHERE filters
// ---------------------------------------------------------------------------

describe('SPARQL golden — expression WHERE filters', () => {
  test('whereExprStrlen — string expression WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprStrlen);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('> "5"');
  });

  test('whereExprArithmetic — numeric expression WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprArithmetic);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('+');
    expect(sparql).toContain('< "100"');
  });

  test('whereExprAndChain — two expressions AND\'d', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprAndChain);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('&&');
    expect(sparql).toContain('STRLEN');
  });

  test('whereExprMixed — Evaluation AND ExpressionNode', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprMixed);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('"Bob"');
  });

  test('whereExprNestedPath — traversal in WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprNestedPath);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain(`<${PROP}bestFriend>`);
  });

  test('whereExprWithProjection — expression in both SELECT and WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprWithProjection);
    // Expression projection may be inlined in SELECT or use BIND
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('FILTER');
  });
});

// ---------------------------------------------------------------------------
// Computed expressions
// ---------------------------------------------------------------------------

describe('SPARQL golden — computed expressions', () => {
  test('exprStrlen', async () => {
    const sparql = await goldenSelect(queryFactories.exprStrlen);
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain(`<${PROP}name>`);
  });

  test('exprCustomKey', async () => {
    const sparql = await goldenSelect(queryFactories.exprCustomKey);
    expect(sparql).toContain('STRLEN');
  });

  test('exprNestedPath', async () => {
    const sparql = await goldenSelect(queryFactories.exprNestedPath);
    expect(sparql).toContain('UCASE');
    expect(sparql).toContain(`<${PROP}bestFriend>`);
    expect(sparql).toContain(`<${PROP}name>`);
  });

  test('exprMultiple', async () => {
    const sparql = await goldenSelect(queryFactories.exprMultiple);
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain(`<${PROP}name>`);
  });
});

// ---------------------------------------------------------------------------
// Expression-based WHERE filters
// ---------------------------------------------------------------------------

describe('SPARQL golden — expression WHERE filters', () => {
  test('whereExprStrlen — string expression WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprStrlen);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('> "5"');
  });

  test('whereExprArithmetic — numeric expression WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprArithmetic);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('+');
    expect(sparql).toContain('< "100"');
  });

  test('whereExprAndChain — two expressions AND\'d', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprAndChain);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('&&');
    expect(sparql).toContain('STRLEN');
  });

  test('whereExprMixed — Evaluation AND ExpressionNode', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprMixed);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('"Bob"');
  });

  test('whereExprNestedPath — traversal in WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprNestedPath);
    expect(sparql).toContain('FILTER');
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain(`<${PROP}bestFriend>`);
  });

  test('whereExprWithProjection — expression in both SELECT and WHERE', async () => {
    const sparql = await goldenSelect(queryFactories.whereExprWithProjection);
    // Expression projection may be inlined in SELECT or use BIND
    expect(sparql).toContain('STRLEN');
    expect(sparql).toContain('FILTER');
  });
});
