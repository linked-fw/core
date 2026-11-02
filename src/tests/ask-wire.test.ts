/**
 * The DSL-JSON wire form of an ask query.
 *
 * An ask travels as its own envelope, discriminated by `op: 'ask'` — the same
 * field mutations use. It carries a pattern and nothing else, so there is no
 * `fields`, `limit`, `offset`, `sortBy` or `one` for a receiver to validate or
 * ignore, and the absence of `shape` is what makes an ask shapeless.
 */
import {describe, expect, test, beforeAll} from '@jest/globals';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {AskBuilder} from '../queries/AskBuilder';
import {SelectBuilder} from '../queries/QueryBuilder';
import {fromJSON} from '../queries/fromJSON';
import {Shape} from '../shapes/Shape';
import {lower} from '../queries/lower';
import {askToSparql} from '../sparql/irToAlgebra';
import {setQueryContext, PendingQueryContext} from '../queries/QueryContext';
import {WIRE_VERSION} from '../queries/wireVersion';

import '../ontologies/rdf';
import '../ontologies/xsd';
import {readQueryOf} from '../test-helpers/read-double';
import type {QueryFeature} from '../queries/queryFeatures';

const entity = (s: string) => ({id: `${tmpEntityBase}${s}`});

beforeAll(() => {
  setQueryContext('user', {id: 'user-1'}, Person);
});

/** Reach the ask a select reduces to, the way `.exists()` does. */
const askFor = (b: any): AskBuilder => (b as any)._toAsk();

describe('ask envelope — shape', () => {
  test('a shaped ask by subject', () => {
    expect(askFor(SelectBuilder.from(Person).for(entity('p1'))).toJSON()).toEqual({
      v: WIRE_VERSION,
      op: 'ask',
      shape: Person.shape.id,
      subject: entity('p1').id,
    });
  });

  test('a shapeless ask omits `shape` — that absence is the discriminator', () => {
    expect(AskBuilder.forNode('https://example.org/thing').toJSON()).toEqual({
      v: WIRE_VERSION,
      op: 'ask',
      subject: 'https://example.org/thing',
    });
  });

  test('a where clause rides along; no answer-shaping fields appear', () => {
    const json = askFor(
      SelectBuilder.from(Person)
        .select((p: any) => p.name)
        .orderBy((p: any) => p.name)
        .where((p: any) => p.name.equals('Semmy'))
        .offset(10)
        .limit(50),
    ).toJSON();
    expect(json.op).toBe('ask');
    expect(json.where).toBeDefined();
    for (const absent of ['fields', 'limit', 'offset', 'sortBy', 'one']) {
      expect(json).not.toHaveProperty(absent);
    }
  });

  test('forAll subjects survive', () => {
    const json = askFor(
      SelectBuilder.from(Person).forAll([entity('p1'), entity('p2')]),
    ).toJSON();
    expect(json.subjects).toEqual([entity('p1').id, entity('p2').id]);
  });
});

describe('ask envelope — round trip', () => {
  const roundTrip = (b: AskBuilder) => AskBuilder.fromJSON(b.toJSON());

  test.each([
    ['by subject', () => askFor(SelectBuilder.from(Person).for(entity('p1')))],
    ['shapeless', () => AskBuilder.forNode('https://example.org/thing')],
    ['with where', () =>
      askFor(
        SelectBuilder.from(Person).where((p: any) => p.name.equals('Semmy')),
      )],
    ['forAll', () =>
      askFor(SelectBuilder.from(Person).forAll([entity('p1'), entity('p2')]))],
  ])('%s survives a round trip, down to the SPARQL', (_label, build) => {
    const original = build();
    const revived = roundTrip(original);
    expect(revived.toJSON()).toEqual(original.toJSON());
    expect(askToSparql(lower(revived))).toBe(askToSparql(lower(original)));
  });
});

describe('ask envelope — fromJSON dispatch', () => {
  test('`op: ask` routes to an AskBuilder, not a SelectBuilder', () => {
    const revived = fromJSON(AskBuilder.forNode('https://example.org/x').toJSON());
    expect(revived).toBeInstanceOf(AskBuilder);
    expect((revived as any).__queryKind).toBe('ask');
  });

  test('a select envelope still routes to a SelectBuilder', () => {
    const revived = fromJSON(SelectBuilder.from(Person).toJSON());
    expect(revived).toBeInstanceOf(SelectBuilder);
  });

  test('an unknown op still fails loud rather than being read as a select', () => {
    expect(() => fromJSON({op: 'sparql-injection'} as any)).toThrow(/Unknown query op/);
  });

  test('a shapeless envelope carrying a where clause is rejected', () => {
    // A where clause names properties, and properties resolve only through a
    // shape. Such an envelope is malformed, not a query to guess at.
    expect(() =>
      AskBuilder.fromJSON({
        v: WIRE_VERSION,
        op: 'ask',
        subject: 'https://example.org/x',
        where: {} as any,
      }),
    ).toThrow(/must name a `shape`/);
  });
});

describe('ask envelope — Shape.exists on the base class', () => {
  test('Shape.exists reaches a shapeless ask; Person.exists a shaped one', async () => {
    // Shape is free to mean "anything" — the shapes themselves are described by
    // NodeShape and PropertyShape, so Shape.exists is not needed for "is this a
    // shape?".
    const seen: any[] = [];
    const store: any = {
      supports: ['ask'] as QueryFeature[],
      readQuery: readQueryOf({
        select: async () => {
          throw new Error('not reached');
        },
        ask: async (q: any) => {
          seen.push(q.toJSON());
          return true;
        },
      }),
    };
    await Shape.exists(entity('p1'), store);
    await Person.exists(entity('p1'), store);
    expect(seen[0]).toEqual({v: WIRE_VERSION, op: 'ask', subject: entity('p1').id});
    expect(seen[0].shape).toBeUndefined();
    expect(seen[1].shape).toBe(Person.shape.id);
  });

  test('a null id is carried as nullSubject, not as a missing subject', () => {
    expect(AskBuilder.forNode(null).toJSON()).toEqual({
      v: WIRE_VERSION,
      op: 'ask',
      nullSubject: true,
    });
  });
});

describe('ask envelope — context references and null subjects', () => {
  test('a pending context travels as {@ctx}, exactly as the select does', () => {
    // It must NOT be resolved against this process's context map on the way out:
    // a forwarding store resolves it against its own (e.g. server-side auth).
    const select = SelectBuilder.from(Person).for(new PendingQueryContext('user'));
    const ask = askFor(select);
    expect(select.toJSON().subject).toEqual({'@ctx': 'user'});
    expect(ask.toJSON().subject).toEqual({'@ctx': 'user'});
  });

  test('…and still resolves locally when executed here', async () => {
    // setQueryContext('user', …) ran in beforeAll, so exec sees a concrete id.
    const seen: any[] = [];
    const store: any = {
      supports: ['ask'] as QueryFeature[],
      readQuery: readQueryOf({
        select: async () => {
          throw new Error('not reached');
        },
        ask: async (q: any) => {
          seen.push(lower(q));
          return true;
        },
      }),
    };
    await SelectBuilder.from(Person).for(new PendingQueryContext('user')).exists(store);
    expect(seen[0].subjectId).toBe('user-1');
  });

  test('an unresolved pending context answers false without querying', async () => {
    const store: any = {
      supports: ['ask'] as QueryFeature[],
      readQuery: readQueryOf({
        select: async () => {
          throw new Error('not reached');
        },
        ask: async () => {
          throw new Error('the ask must not be sent');
        },
      }),
    };
    await expect(
      SelectBuilder.from(Person)
        .for(new PendingQueryContext('never-set'))
        .exists(store),
    ).resolves.toBe(false);
  });

  test('a null subject is carried to lowering, and lowering refuses it', async () => {
    const builder = askFor(SelectBuilder.from(Person).for(null));
    expect(builder.toJSON().nullSubject).toBe(true);
    expect(builder.toRawInput().nullSubject).toBe(true);
    // Without this, a store lowering the envelope directly would emit
    // `ASK WHERE { ?a0 rdf:type <Person> }` and answer true.
    expect(() => lower(builder)).toThrow(/no subject/);
    // The normal path still answers false without ever reaching a store.
    await expect(
      builder.exec({
        supports: ['ask'] as QueryFeature[],
        readQuery: readQueryOf({
          select: async () => {
            throw new Error('not reached');
          },
          ask: async () => {
            throw new Error('not reached');
          },
        }),
      } as any),
    ).resolves.toBe(false);
  });
});
