/**
 * A value made by a second copy of core, handed to this copy's public entry points.
 *
 * This copy is the source the rest of the suite runs (with its query fixtures); the other is
 * the BUILT core (`lib/esm`), a separate module graph with its own classes. Every entry point
 * that takes a caller's `PendingQueryContext`, `FieldSet` or `ExpressionNode` must treat the
 * other copy's value as its own, not as a plain object. Needs `linked build` first.
 */
import {beforeAll, describe, expect, jest, test} from '@jest/globals';
import {existsSync} from 'fs';
import path from 'path';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {AskBuilder} from '../queries/AskBuilder';
import {CountBuilder} from '../queries/CountBuilder';
import {FieldSet} from '../queries/FieldSet';
import {asContextRef, PendingQueryContext, setQueryContext} from '../queries/QueryContext';
import {ExpressionNode, toIRExpression} from '../expressions/ExpressionNode';
import {Expr} from '../expressions/Expr';
import {lower} from '../queries/lower';
import {createToSparql, selectToSparql} from '../sparql/irToAlgebra';

const LIB = path.resolve(process.cwd(), 'lib/esm');
const CTX = 'two-copies-entry-user';
const USER = `${tmpEntityBase}entry-user`;

let other: {
  PendingQueryContext: typeof PendingQueryContext;
  FieldSet: typeof FieldSet;
  ExpressionNode: typeof ExpressionNode;
};

beforeAll(async () => {
  if (!existsSync(path.join(LIB, 'index.js'))) {
    throw new Error(`${LIB}/index.js is missing: run \`npx linked build\` before this test.`);
  }
  // The built copy announces itself as a second copy of the shape registry; that is expected.
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  let lib: any;
  let qc: any;
  try {
    lib = await import(path.join(LIB, 'index.js'));
    qc = await import(path.join(LIB, 'queries/QueryContext.js'));
  } finally {
    error.mockRestore();
  }
  other = {PendingQueryContext: qc.PendingQueryContext, FieldSet: lib.FieldSet, ExpressionNode: lib.ExpressionNode};
  expect(other.PendingQueryContext).not.toBe(PendingQueryContext);
  expect(other.FieldSet).not.toBe(FieldSet);
  expect(other.ExpressionNode).not.toBe(ExpressionNode);
});

/** The other copy's pending context for {@link CTX}. */
const theirContext = (): PendingQueryContext => new other.PendingQueryContext(CTX) as PendingQueryContext;

/** The same builder fed this copy's pending context, for comparison. */
const ourContext = (): PendingQueryContext => new PendingQueryContext(CTX);

describe("the other copy's PendingQueryContext", () => {
  test('asContextRef', () => {
    expect(asContextRef(theirContext())?.contextName).toBe(CTX);
  });

  test('SelectBuilder.for', () => {
    const json = (ctx: PendingQueryContext) => SelectBuilder.from(Person).select((p: any) => [p.name]).for(ctx).toJSON();
    expect(json(theirContext())).toEqual(json(ourContext()));
  });

  test('UpdateBuilder.for', () => {
    const json = (ctx: PendingQueryContext) => UpdateBuilder.from(Person).for(ctx).set({name: 'Bob'}).toJSON();
    expect(json(theirContext())).toEqual(json(ourContext()));
  });

  test('DeleteBuilder.from', () => {
    const json = (ctx: PendingQueryContext) => DeleteBuilder.from(Person, ctx).toJSON();
    expect(json(theirContext())).toEqual(json(ourContext()));
  });

  test('AskBuilder.forNode', () => {
    const json = (ctx: PendingQueryContext) => AskBuilder.forNode(ctx).toJSON();
    expect(json(theirContext())).toEqual(json(ourContext()));
  });

  test('CountBuilder.of', () => {
    const json = (ctx: PendingQueryContext) => CountBuilder.of({shapeClass: Person, subject: ctx}).toJSON();
    expect(json(theirContext())).toEqual(json(ourContext()));
  });

  test('a mutation field value, serialized and lowered', () => {
    const create = (ctx: PendingQueryContext) => CreateBuilder.from(Person).set({name: 'Alice', bestFriend: ctx} as any);
    expect(create(theirContext()).toJSON()).toEqual(create(ourContext()).toJSON());
    setQueryContext(CTX, {id: USER}, Person);
    try {
      // The created node's id is generated per query, so compare the context's triple only.
      expect(createToSparql(lower(create(theirContext())))).toContain(`/bestFriend> <${USER}> .`);
    } finally {
      setQueryContext(CTX, null);
    }
  });

  test('a select subject, lowered', () => {
    setQueryContext(CTX, {id: USER}, Person);
    try {
      const sparql = (ctx: PendingQueryContext) =>
        selectToSparql(lower(SelectBuilder.from(Person).select((p: any) => [p.name]).for(ctx)));
      expect(sparql(theirContext())).toContain(USER);
      expect(sparql(theirContext())).toEqual(sparql(ourContext()));
    } finally {
      setQueryContext(CTX, null);
    }
  });
});

describe("the other copy's FieldSet and ExpressionNode", () => {
  test('SelectBuilder.select(FieldSet)', () => {
    const theirs = (other.FieldSet as typeof FieldSet).for(Person, ['name', 'hobby']);
    expect(theirs).not.toBeInstanceOf(FieldSet);
    const ir = (fs: FieldSet) => selectToSparql(lower(SelectBuilder.from(Person).select(fs)));
    expect(ir(theirs)).toEqual(ir(FieldSet.for(Person, ['name', 'hobby'])));
  });

  test('toIRExpression and Expr take it as an expression', () => {
    const ir = toIRExpression(Expr.now());
    const theirs = new other.ExpressionNode(ir) as ExpressionNode;
    expect(theirs).not.toBeInstanceOf(ExpressionNode);
    expect(toIRExpression(theirs)).toBe(theirs.ir);
    expect(Expr.not(theirs).ir).toEqual(Expr.not(new ExpressionNode(ir)).ir);
  });

  test('a where clause built from it', () => {
    const sparql = (mk: (p: any) => ExpressionNode) =>
      selectToSparql(lower(SelectBuilder.from(Person).select((p: any) => [p.name]).where(mk)));
    const ours = sparql((p) => p.name.equals('Semmy'));
    const theirs = sparql((p) => {
      const node = p.name.equals('Semmy') as ExpressionNode;
      return new other.ExpressionNode(node.ir, node._refs) as ExpressionNode;
    });
    expect(theirs).toEqual(ours);
  });
});
