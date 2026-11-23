import { describe, expect, test } from "@jest/globals";
import {
  Dog,
  Employee,
  Person,
  Pet,
  queryFactories,
  tmpEntityBase,
} from "../test-helpers/query-fixtures";
import {
  captureQuery,
  captureRawQuery,
} from "../test-helpers/query-capture-store";
import { buildSelectQuery } from "../queries/IRPipeline";
import type { IRSelectQuery } from "../queries/IntermediateRepresentation";
import { setQueryContext } from "../queries/QueryContext";
import {lower} from '../queries/lower';
import {
  mapSparqlSelectResult,
  type SparqlJsonResults,
} from '../sparql/resultMapping';

setQueryContext("user", { id: "user-1" }, Person);

const sanitize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (acc, [key, child]) => {
        if (child !== undefined) acc[key] = sanitize(child);
        return acc;
      },
      {} as Record<string, unknown>
    );
  }
  return value;
};

const captureIR = async (
  runner: () => Promise<unknown>
): Promise<IRSelectQuery> => {
  const query = await captureQuery(runner);
  return sanitize(query) as IRSelectQuery;
};

type SelectCase = {
  name: string;
  run: () => Promise<unknown>;
  minProjection?: number;
  exactProjection?: number;
  minPatterns?: number;
  hasWhere?: boolean;
  whereKind?: "binary_expr" | "logical_expr" | "exists_expr" | "not_expr";
  singleResult?: boolean;
  subjectId?: string;
  orderByDirection?: "ASC" | "DESC";
  limit?: number;
  requireAggregate?: boolean;
  expectedRootShapeId?: string;
  requiredResultKeys?: string[];
};

const assertSelectCase = (ir: IRSelectQuery, testCase: SelectCase) => {
  expect(ir.kind).toBe("select");
  expect(ir.root.kind).toBe("shape_scan");
  expect(ir.root.alias).toBeDefined();
  expect(Array.isArray(ir.patterns)).toBe(true);
  expect(Array.isArray(ir.projection)).toBe(true);
  expect(ir.resultMap?.length).toBe(ir.projection.length);

  if (testCase.expectedRootShapeId) {
    expect(ir.root.shape).toBe(testCase.expectedRootShapeId);
  } else {
    expect(ir.root.shape).toBeDefined();
  }

  if (testCase.exactProjection !== undefined) {
    expect(ir.projection.length).toBe(testCase.exactProjection);
  }

  if (testCase.minProjection !== undefined) {
    expect(ir.projection.length).toBeGreaterThanOrEqual(testCase.minProjection);
  }

  if (testCase.minPatterns !== undefined) {
    expect(ir.patterns.length).toBeGreaterThanOrEqual(testCase.minPatterns);
  }

  if (testCase.hasWhere) {
    expect(ir.where).toBeDefined();
  }

  if (testCase.whereKind) {
    expect(ir.where?.kind).toBe(testCase.whereKind);
  }

  if (testCase.singleResult !== undefined) {
    expect(ir.singleResult).toBe(testCase.singleResult);
  }

  if (testCase.subjectId) {
    expect(ir.subjectId).toBe(testCase.subjectId);
  }

  if (testCase.orderByDirection) {
    expect(ir.orderBy).toBeDefined();
    expect(ir.orderBy?.[0]?.direction).toBe(testCase.orderByDirection);
  }

  if (testCase.limit !== undefined) {
    expect(ir.limit).toBe(testCase.limit);
  }

  if (testCase.requireAggregate) {
    expect(
      ir.projection.some((item) => item.expression.kind === "aggregate_expr")
    ).toBe(true);
  }

  if (testCase.requiredResultKeys?.length) {
    const keys = ir.resultMap?.map((entry) => entry.key) ?? [];
    testCase.requiredResultKeys.forEach((key) => {
      expect(keys).toContain(key);
    });
  }
};

const basicCases: SelectCase[] = [
  {
    name: "selectName",
    run: () => queryFactories.selectName(),
    minProjection: 1,
  },
  {
    name: "selectFriends",
    run: () => queryFactories.selectFriends(),
    minProjection: 1,
  },
  {
    name: "selectBirthDate",
    run: () => queryFactories.selectBirthDate(),
    minProjection: 1,
  },
  {
    name: "selectIsRealPerson",
    run: () => queryFactories.selectIsRealPerson(),
    minProjection: 1,
  },
  {
    name: "selectById",
    run: () => queryFactories.selectById(),
    minProjection: 1,
    singleResult: true,
    subjectId: `${tmpEntityBase}p1`,
  },
  {
    name: "selectByIdReference",
    run: () => queryFactories.selectByIdReference(),
    minProjection: 1,
    singleResult: true,
    subjectId: `${tmpEntityBase}p1`,
  },
  {
    name: "selectNonExisting",
    run: () => queryFactories.selectNonExisting(),
    minProjection: 1,
    singleResult: true,
    subjectId: "https://does.not/exist",
  },
  {
    name: "selectUndefinedOnly",
    run: () => queryFactories.selectUndefinedOnly(),
    minProjection: 2,
    singleResult: true,
    subjectId: `${tmpEntityBase}p3`,
  },
];

const nestedCases: SelectCase[] = [
  {
    name: "selectFriendsName",
    run: () => queryFactories.selectFriendsName(),
    minProjection: 1,
    minPatterns: 1,
  },
  {
    name: "selectNestedFriendsName",
    run: () => queryFactories.selectNestedFriendsName(),
    minProjection: 1,
    minPatterns: 2,
  },
  {
    name: "selectMultiplePaths",
    run: () => queryFactories.selectMultiplePaths(),
    exactProjection: 3,
    minPatterns: 1,
  },
  {
    name: "selectBestFriendName",
    run: () => queryFactories.selectBestFriendName(),
    minProjection: 1,
    minPatterns: 1,
  },
  {
    name: "selectBestFriendOnly",
    run: () => queryFactories.selectBestFriendOnly(),
    exactProjection: 1,
  },
  {
    name: "selectDeepNested",
    run: () => queryFactories.selectDeepNested(),
    minProjection: 1,
    minPatterns: 3,
  },
];

const filteringCases: SelectCase[] = [
  {
    name: "whereFriendsNameEquals",
    run: () => queryFactories.whereFriendsNameEquals(),
    minProjection: 1,
  },
  {
    name: "whereBestFriendEquals",
    run: () => queryFactories.whereBestFriendEquals(),
    hasWhere: true,
    whereKind: "binary_expr",
    exactProjection: 0,
  },
  {
    name: "whereHobbyEquals",
    run: () => queryFactories.whereHobbyEquals(),
    minProjection: 1,
  },
  { name: "whereAnd", run: () => queryFactories.whereAnd(), minProjection: 1 },
  { name: "whereOr", run: () => queryFactories.whereOr(), minProjection: 1 },
  {
    name: "selectAll",
    run: () => queryFactories.selectAll(),
    exactProjection: 0,
  },
  {
    name: "selectAllProperties",
    run: () => queryFactories.selectAllProperties(),
    minProjection: 10,
  },
  {
    name: "selectAllEmployeeProperties",
    run: () => queryFactories.selectAllEmployeeProperties(),
    minProjection: 10,
    expectedRootShapeId: Employee.shape.id,
  },
  {
    name: "selectWhereNameSemmy",
    run: () => queryFactories.selectWhereNameSemmy(),
    hasWhere: true,
    whereKind: "binary_expr",
    exactProjection: 0,
  },
  {
    name: "whereAndOrAnd",
    run: () => queryFactories.whereAndOrAnd(),
    minProjection: 1,
  },
  {
    name: "whereAndOrAndNested",
    run: () => queryFactories.whereAndOrAndNested(),
    minProjection: 1,
  },
  {
    name: "whereSomeImplicit",
    run: () => queryFactories.whereSomeImplicit(),
    hasWhere: true,
    whereKind: "binary_expr",
    exactProjection: 0,
  },
  {
    name: "whereSomeExplicit",
    run: () => queryFactories.whereSomeExplicit(),
    hasWhere: true,
    whereKind: "exists_expr",
    exactProjection: 0,
  },
  {
    name: "whereEvery",
    run: () => queryFactories.whereEvery(),
    hasWhere: true,
    whereKind: "not_expr",
    exactProjection: 0,
  },
  {
    name: "whereNone",
    run: () => queryFactories.whereNone(),
    hasWhere: true,
    whereKind: "not_expr",
    minProjection: 1,
  },
  {
    name: "whereSomeNot",
    run: () => queryFactories.whereSomeNot(),
    hasWhere: true,
    whereKind: "not_expr",
    minProjection: 1,
  },
  {
    name: "whereEqualsNot",
    run: () => queryFactories.whereEqualsNot(),
    hasWhere: true,
    whereKind: "not_expr",
    minProjection: 1,
  },
  {
    name: "whereNoneAndEquals",
    run: () => queryFactories.whereNoneAndEquals(),
    hasWhere: true,
    whereKind: "logical_expr",
    minProjection: 1,
  },
  {
    name: "whereNeq",
    run: () => queryFactories.whereNeq(),
    hasWhere: true,
    whereKind: "binary_expr",
    minProjection: 1,
  },
  {
    name: "whereExprNot",
    run: () => queryFactories.whereExprNot(),
    hasWhere: true,
    whereKind: "not_expr",
    minProjection: 1,
  },
  {
    name: "whereSequences",
    run: () => queryFactories.whereSequences(),
    hasWhere: true,
    whereKind: "logical_expr",
    exactProjection: 0,
  },
  {
    name: "outerWhere",
    run: () => queryFactories.outerWhere(),
    hasWhere: true,
    whereKind: "binary_expr",
    minProjection: 1,
  },
  {
    name: "whereWithContext",
    run: () => queryFactories.whereWithContext(),
    hasWhere: true,
    whereKind: "binary_expr",
    minProjection: 1,
  },
  {
    name: "whereWithContextPath",
    run: () => queryFactories.whereWithContextPath(),
    hasWhere: true,
    whereKind: "exists_expr",
    minProjection: 1,
  },
];

const aggregationCases: SelectCase[] = [
  {
    name: "countFriends",
    run: () => queryFactories.countFriends(),
    exactProjection: 1,
    requireAggregate: true,
  },
  {
    name: "countNestedFriends",
    run: () => queryFactories.countNestedFriends(),
    exactProjection: 1,
    minPatterns: 1,
    requireAggregate: true,
  },
  {
    name: "countLabel",
    run: () => queryFactories.countLabel(),
    exactProjection: 1,
    minPatterns: 1,
    requireAggregate: true,
    requiredResultKeys: ["numFriends"],
  },
  {
    name: "nestedObjectProperty",
    run: () => queryFactories.nestedObjectProperty(),
    exactProjection: 1,
    minPatterns: 1,
  },
  {
    name: "nestedObjectPropertySingle",
    run: () => queryFactories.nestedObjectPropertySingle(),
    exactProjection: 1,
    minPatterns: 1,
  },
  {
    name: "subSelectSingleProp",
    run: () => queryFactories.subSelectSingleProp(),
    exactProjection: 1,
    minPatterns: 1,
    requiredResultKeys: ["name"],
  },
  {
    name: "subSelectPluralCustom",
    run: () => queryFactories.subSelectPluralCustom(),
    exactProjection: 2,
    minPatterns: 1,
    requiredResultKeys: ["name", "hobby"],
  },
  {
    name: "subSelectAllProperties",
    run: () => queryFactories.subSelectAllProperties(),
    minProjection: 10,
    minPatterns: 1,
  },
  {
    name: "subSelectAllPropertiesSingle",
    run: () => queryFactories.subSelectAllPropertiesSingle(),
    minProjection: 10,
    minPatterns: 1,
  },
  {
    name: "doubleNestedSubSelect",
    run: () => queryFactories.doubleNestedSubSelect(),
    exactProjection: 1,
    minPatterns: 2,
    requiredResultKeys: ["name"],
  },
  {
    name: "subSelectAllPrimitives",
    run: () => queryFactories.subSelectAllPrimitives(),
    exactProjection: 3,
    minPatterns: 1,
  },
  {
    name: "customResultEqualsBoolean",
    run: () => queryFactories.customResultEqualsBoolean(),
    exactProjection: 1,
    requiredResultKeys: ["isBestFriend"],
  },
  {
    name: "customResultNumFriends",
    run: () => queryFactories.customResultNumFriends(),
    exactProjection: 1,
    requireAggregate: true,
    requiredResultKeys: ["numFriends"],
  },
  {
    name: "countEquals",
    run: () => queryFactories.countEquals(),
    hasWhere: true,
    whereKind: "binary_expr",
    exactProjection: 0,
  },
  {
    name: "subSelectArray",
    run: () => queryFactories.subSelectArray(),
    exactProjection: 2,
    minPatterns: 1,
  },
];

const transformationCases: SelectCase[] = [
  {
    name: "selectShapeSetAs",
    run: () => queryFactories.selectShapeSetAs(),
    exactProjection: 1,
    minPatterns: 1,
  },
  {
    name: "selectNonExistingMultiple",
    run: () => queryFactories.selectNonExistingMultiple(),
    exactProjection: 2,
  },
  {
    name: "selectShapeAs",
    run: () => queryFactories.selectShapeAs(),
    exactProjection: 1,
    minPatterns: 1,
  },
  {
    name: "selectOne",
    run: () => queryFactories.selectOne(),
    hasWhere: true,
    whereKind: "binary_expr",
    exactProjection: 1,
    singleResult: true,
  },
  {
    name: "nestedQueries2",
    run: () => queryFactories.nestedQueries2(),
    minProjection: 1,
    minPatterns: 1,
  },
  {
    name: "pluralFilteredNestedSubSelect",
    run: () => queryFactories.pluralFilteredNestedSubSelect(),
    minProjection: 3,
    minPatterns: 2,
  },
  {
    name: "selectDuplicatePaths",
    run: () => queryFactories.selectDuplicatePaths(),
    exactProjection: 3,
    minPatterns: 1,
  },
];

const preloadCases: SelectCase[] = [
  {
    name: "preloadBestFriend",
    run: () => queryFactories.preloadBestFriend(),
    minProjection: 1,
    minPatterns: 1,
  },
];

const sortingCases: SelectCase[] = [
  {
    name: "outerWhereLimit",
    run: () => queryFactories.outerWhereLimit(),
    hasWhere: true,
    whereKind: "logical_expr",
    exactProjection: 1,
    limit: 1,
  },
  {
    name: "sortByAsc",
    run: () => queryFactories.sortByAsc(),
    exactProjection: 1,
    orderByDirection: "ASC",
  },
  {
    name: "sortByDesc",
    run: () => queryFactories.sortByDesc(),
    exactProjection: 1,
    orderByDirection: "DESC",
  },
];

describe("select canonical IR golden fixtures", () => {
  test("basic selection fixture", async () => {
    const actual = await captureIR(() => queryFactories.selectName());
    expect(actual).toMatchInlineSnapshot(`
      {
        "kind": "select",
        "patterns": [],
        "projection": [
          {
            "alias": "a1",
            "expression": {
              "kind": "property_expr",
              "maxCount": 1,
              "property": "https://linked.cm/shape/core/Person/name",
              "sourceAlias": "a0",
            },
          },
        ],
        "resultMap": [
          {
            "alias": "a1",
            "key": "https://linked.cm/shape/core/Person/name",
          },
        ],
        "root": {
          "alias": "a0",
          "kind": "shape_scan",
          "shape": "https://linked.cm/shape/core/Person",
        },
        "singleResult": false,
      }
    `);
  });

  test("nested selection fixture", async () => {
    const actual = await captureIR(() =>
      queryFactories.selectNestedFriendsName()
    );
    expect(actual).toMatchInlineSnapshot(`
      {
        "kind": "select",
        "patterns": [
          {
            "from": "a0",
            "kind": "traverse",
            "property": "https://linked.cm/shape/core/Person/friends",
            "to": "a1",
          },
          {
            "from": "a1",
            "kind": "traverse",
            "property": "https://linked.cm/shape/core/Person/friends",
            "to": "a2",
          },
        ],
        "projection": [
          {
            "alias": "a1",
            "expression": {
              "kind": "property_expr",
              "maxCount": 1,
              "property": "https://linked.cm/shape/core/Person/name",
              "sourceAlias": "a2",
            },
          },
        ],
        "resultMap": [
          {
            "alias": "a1",
            "key": "https://linked.cm/shape/core/Person/name",
          },
        ],
        "root": {
          "alias": "a0",
          "kind": "shape_scan",
          "shape": "https://linked.cm/shape/core/Person",
        },
        "singleResult": false,
      }
    `);
  });

  test("single-value bestFriend traversal carries maxCount", async () => {
    const actual = await captureIR(() => queryFactories.selectBestFriendName());
    // The bestFriend traverse pattern must carry maxCount: 1
    const traversePattern = actual.patterns.find(
      (p: any) => p.kind === "traverse"
    );
    expect(traversePattern).toBeDefined();
    expect((traversePattern as any).maxCount).toBe(1);
    expect(actual).toMatchInlineSnapshot(`
      {
        "kind": "select",
        "patterns": [
          {
            "from": "a0",
            "kind": "traverse",
            "maxCount": 1,
            "property": "https://linked.cm/shape/core/Person/bestFriend",
            "to": "a1",
          },
        ],
        "projection": [
          {
            "alias": "a1",
            "expression": {
              "kind": "property_expr",
              "maxCount": 1,
              "property": "https://linked.cm/shape/core/Person/name",
              "sourceAlias": "a1",
            },
          },
        ],
        "resultMap": [
          {
            "alias": "a1",
            "key": "https://linked.cm/shape/core/Person/name",
          },
        ],
        "root": {
          "alias": "a0",
          "kind": "shape_scan",
          "shape": "https://linked.cm/shape/core/Person",
        },
        "singleResult": false,
      }
    `);
  });

  test("filtering fixture with normalized quantifier", async () => {
    const actual = await captureIR(() => queryFactories.whereSomeExplicit());
    expect(actual.where?.kind).toBe("exists_expr");
    expect(actual).toMatchInlineSnapshot(`
      {
        "kind": "select",
        "patterns": [],
        "projection": [],
        "resultMap": [],
        "root": {
          "alias": "a0",
          "kind": "shape_scan",
          "shape": "https://linked.cm/shape/core/Person",
        },
        "singleResult": false,
        "where": {
          "filter": {
            "kind": "binary_expr",
            "left": {
              "kind": "property_expr",
              "property": "https://linked.cm/shape/core/Person/name",
              "sourceAlias": "a1",
            },
            "operator": "=",
            "right": {
              "kind": "literal_expr",
              "value": "Moa",
            },
          },
          "kind": "exists_expr",
          "pattern": {
            "from": "a0",
            "kind": "traverse",
            "property": "https://linked.cm/shape/core/Person/friends",
            "to": "a1",
          },
        },
      }
    `);
  });
});

describe("select IR parity coverage (Phase 3)", () => {
  test.each([
    ...basicCases,
    ...nestedCases,
    ...filteringCases,
    ...aggregationCases,
    ...transformationCases,
    ...preloadCases,
    ...sortingCases,
  ])("$name emits expected IR structure", async (testCase) => {
    const actual = await captureIR(testCase.run);
    assertSelectCase(actual, testCase);
  });
});

describe("IR pipeline behavior", () => {
  test("buildSelectQuery lowers raw select input to IR", async () => {
    const query = await captureRawQuery(() => queryFactories.sortByDesc());
    const ir = buildSelectQuery(query);

    expect(ir.kind).toBe("select");
    expect(ir.root.kind).toBe("shape_scan");
    expect(ir.projection.length).toBe(1);
    expect(ir.orderBy?.[0]?.direction).toBe("DESC");
    expect(ir.limit).toBeUndefined();
  });

  test("lower() returns canonical IR", async () => {
    const query = Person.select((p) => p.name).where((p) =>
      p.name.equals("Semmy")
    );

    const ir = lower(query);

    expect(ir.kind).toBe("select");
    expect(ir.projection.length).toBe(1);
    expect(ir.where).toBeDefined();
  });

  test("builder accepts already-lowered IR as pass-through", async () => {
    const query = Person.select((p) => p.name);
    const ir = lower(query);

    expect(buildSelectQuery(ir)).toBe(ir);
  });

  test("lower() preserves nested sub-select projections inside array selections", async () => {
    const query = await captureRawQuery(() =>
      queryFactories.pluralFilteredNestedSubSelect()
    );
    const ir = buildSelectQuery(query);

    expect(ir.projection.length).toBeGreaterThanOrEqual(3);
    expect(
      ir.patterns.some(
        (p) => p.kind === "traverse" && p.property.endsWith("/pluralTestProp")
      )
    ).toBe(true);
    expect(
      ir.patterns.some(
        (p) => p.kind === "traverse" && p.property.endsWith("/friends")
      )
    ).toBe(true);

    const projectedProperties = ir.projection
      .filter(
        (
          item
        ): item is {
          alias: string;
          expression: {
            kind: "property_expr";
            sourceAlias: string;
            property: string;
          };
        } => item.expression.kind === "property_expr"
      )
      .map((item) => item.expression.property);
    expect(projectedProperties.some((prop) => prop.endsWith("/hobby"))).toBe(
      true
    );
    expect(
      projectedProperties.filter((prop) => prop.endsWith("/name")).length
    ).toBeGreaterThanOrEqual(2);
  });

  test("nested array children do not inherit the enclosing custom result key", () => {
    const ir = lower(
      Person.select((p) => ({
        bestFriend: p.bestFriend.select((friend) => [friend.name]),
      })),
    );

    // The key names the sub-select's member rows (a `members` entry); the field inside keeps its
    // own property key, in those rows.
    expect(ir.resultMap).toHaveLength(2);
    expect(ir.resultMap?.[0]).toEqual({key: 'bestFriend', alias: 'a1', container: 'a0', keyed: true, members: true});
    expect(ir.projection[0].expression.kind).toBe('property_expr');
    expect(ir.resultMap?.[1].key).toBe(
      ir.projection[0].expression.kind === 'property_expr'
        ? ir.projection[0].expression.property
        : undefined,
    );
    expect(ir.resultMap?.[1].container).toBe('a1');
  });

  test("nested array children map to their property key in the final result", () => {
    const ir = lower(
      Person.select((p) => ({
        bestFriend: p.bestFriend.select((friend) => [friend.name]),
      })),
    );
    const traversal = ir.patterns.find(
      (pattern) => pattern.kind === 'traverse',
    );
    expect(traversal?.kind).toBe('traverse');
    if (!traversal || traversal.kind !== 'traverse') {
      throw new Error('Expected the nested selection to produce a traversal');
    }

    const projection = ir.projection[0];
    expect(projection.expression.kind).toBe('property_expr');
    if (projection.expression.kind !== 'property_expr') {
      throw new Error('Expected the nested field to produce a property projection');
    }
    const propertyLabel = projection.expression.property.split('/').pop();
    const sparqlVariable = `${projection.expression.sourceAlias}_${propertyLabel}`;
    const sparqlResult: SparqlJsonResults = {
      head: {vars: [ir.root.alias, traversal.to, sparqlVariable]},
      results: {
        bindings: [{
          [ir.root.alias]: {type: 'uri', value: `${tmpEntityBase}p1`},
          [traversal.to]: {type: 'uri', value: `${tmpEntityBase}p2`},
          [sparqlVariable]: {type: 'literal', value: 'Moa'},
        }],
      },
    };

    const mapped = mapSparqlSelectResult(sparqlResult, ir);
    expect(Array.isArray(mapped)).toBe(true);
    if (!Array.isArray(mapped)) {
      throw new Error('Expected a multi-result query to map to an array');
    }
    const firstResult = mapped[0] as unknown as {
      bestFriend: Record<string, unknown>;
    };
    expect(firstResult.bestFriend).toMatchObject({
      id: `${tmpEntityBase}p2`,
      name: 'Moa',
    });
    expect(firstResult.bestFriend).not.toHaveProperty('bestFriend');
  });

  // --- Computed expression tests ---

  test("exprStrlen: expression select produces function_expr projection", async () => {
    const ir = await captureIR(() => queryFactories.exprStrlen());
    expect(ir.kind).toBe("select");
    expect(ir.projection.length).toBe(1);
    expect(ir.projection[0].expression.kind).toBe("function_expr");
    expect((ir.projection[0].expression as any).name).toBe("STRLEN");
    // The argument should be a property_expr for name
    const args = (ir.projection[0].expression as any).args;
    expect(args.length).toBe(1);
    expect(args[0].kind).toBe("property_expr");
    expect(args[0].property).toContain("name");
  });

  test("exprCustomKey: expression with custom result key", async () => {
    const ir = await captureIR(() => queryFactories.exprCustomKey());
    expect(ir.kind).toBe("select");
    expect(ir.projection.length).toBe(1);
    expect(ir.projection[0].expression.kind).toBe("function_expr");
    expect(ir.resultMap?.length).toBe(1);
    expect(ir.resultMap?.[0].key).toBe("nameLen");
  });

  test("exprNestedPath: expression on nested property creates traversal", async () => {
    const ir = await captureIR(() => queryFactories.exprNestedPath());
    expect(ir.kind).toBe("select");
    expect(ir.projection.length).toBe(1);
    expect(ir.projection[0].expression.kind).toBe("function_expr");
    expect((ir.projection[0].expression as any).name).toBe("UCASE");
    // Should have a traverse pattern for bestFriend
    expect(
      ir.patterns.some(
        (p) => p.kind === "traverse" && p.property.endsWith("/bestFriend")
      )
    ).toBe(true);
  });

  test("exprMultiple: mix of plain path and expression select", async () => {
    const ir = await captureIR(() => queryFactories.exprMultiple());
    expect(ir.kind).toBe("select");
    expect(ir.projection.length).toBe(2);
    // First is a plain property_expr
    expect(ir.projection[0].expression.kind).toBe("property_expr");
    // Second is a function_expr (strlen)
    expect(ir.projection[1].expression.kind).toBe("function_expr");
  });
});
