/**
 * Two copies of the BUILT core (`lib/esm`) in one runtime, as `linked start` or two bundles
 * produce: every value core's callers write through one copy is read by the other, and a
 * value one copy made passes the other copy's class and error checks.
 *
 * Loads `lib/esm`, so it needs `linked build` first (CI builds before it tests). The second
 * copy is a whole module graph evaluated again by `jest.isolateModulesAsync`.
 */
import {afterAll, beforeAll, describe, expect, it, jest} from '@jest/globals';
import {existsSync} from 'fs';
import path from 'path';

const LIB = path.resolve(process.cwd(), 'lib/esm');

/** The built modules a copy is made of; each copy loads all of them in one module graph. */
const MODULES = {
  core: 'index.js',
  qc: 'queries/QueryContext.js',
  select: 'queries/SelectQuery.js',
  storage: 'utils/LinkedFileStorage.js',
  logging: 'utils/LinkedErrorLogging.js',
  prefix: 'utils/Prefix.js',
  pkg: 'utils/Package.js',
  shacl: 'shapes/SHACL.js',
  shapeClass: 'utils/ShapeClass.js',
  shape: 'shapes/Shape.js',
  coreSet: 'collections/CoreSet.js',
  shapeSet: 'collections/ShapeSet.js',
  expression: 'expressions/ExpressionNode.js',
  unresolved: 'utils/unresolvedShape.js',
  error: 'utils/linkedError.js',
} as const;

type Copy = {[K in keyof typeof MODULES]: any};

async function loadCopy(): Promise<Copy> {
  const copy = {} as Copy;
  for (const [key, file] of Object.entries(MODULES)) {
    copy[key as keyof Copy] = await import(path.join(LIB, file));
  }
  return copy;
}

/** A second, independently evaluated copy of the built core. */
async function secondCopy(): Promise<Copy> {
  let copy: Copy | undefined;
  // The second copy announces itself (ShapeClass reports duplicate copies); that is expected.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await jest.isolateModulesAsync(async () => {
      copy = await loadCopy();
    });
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
  if (!copy) throw new Error('second copy did not load');
  return copy;
}

const shared = (name: string): any =>
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(`@_linked/core:${name}`)];

let a: Copy;
let b: Copy;

beforeAll(async () => {
  if (!existsSync(path.join(LIB, 'index.js'))) {
    throw new Error(`${LIB}/index.js is missing: run \`npx linked build\` before this test.`);
  }
  a = await loadCopy();
  b = await secondCopy();
});

describe('two copies of the built core', () => {
  it('are distinct copies', () => {
    expect(b.core.Shape).not.toBe(a.core.Shape);
    expect(b.qc.setQueryContext).not.toBe(a.qc.setQueryContext);
  });
});

describe('state set through one copy is read by the other', () => {
  /** A shape class in copy `c` and a proxy target for it, as the query DSL makes. */
  const target = (c: Copy, id: string) => {
    class Person extends c.shape.Shape {}
    return c.shape.createShapeTarget(Person, id);
  };

  it('query context: a context set through one copy resolves in the other', () => {
    const pending = b.qc.getQueryContext('two-copies-late');
    expect(pending).toBeInstanceOf(b.qc.PendingQueryContext);

    // A shape target from copy B, set through copy A: A's Shape check must accept it.
    a.qc.setQueryContext('two-copies-user', target(b, 'https://ex.org/u1'));
    expect(b.qc.getQueryContext('two-copies-user').id).toBe('https://ex.org/u1');

    b.qc.setQueryContext('two-copies-late', target(a, 'https://ex.org/u2'));
    expect(pending.id).toBe('https://ex.org/u2');
    expect(a.qc.getQueryContext('two-copies-late').id).toBe('https://ex.org/u2');
  });

  it('query context listeners: one subscribed through one copy hears a change through the other', () => {
    const heard: string[] = [];
    const unsubscribe = b.qc.subscribeQueryContext((name: string) => heard.push(name));
    a.qc.setQueryContext('two-copies-user', null);
    unsubscribe();
    a.qc.setQueryContext('two-copies-late', null);
    expect(heard).toEqual(['two-copies-user']);
    expect(b.qc.getQueryContext('two-copies-user')).toBeInstanceOf(b.qc.PendingQueryContext);
  });

  it('LinkedFileStorage: default store, accessURL, stores and purposes', () => {
    const A = a.storage.LinkedFileStorage;
    const B = b.storage.LinkedFileStorage;
    expect(B).not.toBe(A);
    try {
      A.setDefaultAccessURL('https://cdn.ex.org');
      expect(B.accessURL).toBe('https://cdn.ex.org');

      const defaultStore = {accessURL: 'https://files.ex.org'};
      A.setDefaultStore(defaultStore);
      expect(B.getDefaultStore()).toBe(defaultStore);
      expect(B.accessURL).toBe('https://files.ex.org');

      const exports = {accessURL: 'https://exports.ex.org'};
      B.setStore('two-copies-exports', exports);
      expect(A.getStore('two-copies-exports')).toBe(exports);
      expect(A.hasStore('two-copies-exports')).toBe(true);

      A.registerPurpose('two-copies-reports', {description: 'only declared'});
      expect(B.listPurposes()).toContainEqual({
        purpose: 'two-copies-reports',
        description: 'only declared',
        configured: false,
      });
      expect(B.getStore('uploads')).toBe(defaultStore);
    } finally {
      A.resetForTests();
    }
  });

  it('LinkedErrorLogging: a logger set through one copy logs for the other', async () => {
    const logged: unknown[] = [];
    a.logging.LinkedErrorLogging.setDefaultLogger({log: async (e: unknown) => void logged.push(e)});
    expect(b.logging.LinkedErrorLogging.hasDefaultLogger()).toBe(true);
    const err = new Error('to sentry');
    await b.logging.LinkedErrorLogging.log(err);
    expect(logged).toEqual([err]);
  });

  it('Prefix: a prefix added through one copy serialises in the other', () => {
    a.prefix.Prefix.add('twocopies', 'https://ex.org/two-copies#');
    try {
      expect(b.prefix.Prefix.getPrefix('https://ex.org/two-copies#')).toBe('twocopies');
      expect(b.prefix.Prefix.toPrefixed('https://ex.org/two-copies#thing')).toBe('twocopies:thing');
      expect(b.prefix.Prefix.uriToPrefix).toBe(a.prefix.Prefix.uriToPrefix);
      expect(b.prefix.Prefix.prefixToUri).toBe(a.prefix.Prefix.prefixToUri);
    } finally {
      b.prefix.Prefix.delete('twocopies');
    }
    expect(a.prefix.Prefix.getPrefixToUriMap().has('twocopies')).toBe(false);
  });

  it('Package: the default page limit, on the getter and on each copy\'s DEFAULT_LIMIT binding', () => {
    try {
      b.pkg.setDefaultPageLimit(7);
      expect(a.pkg.getDefaultPageLimit()).toBe(7);
      expect(a.pkg.DEFAULT_LIMIT).toBe(7);
      expect(b.pkg.DEFAULT_LIMIT).toBe(7);
    } finally {
      a.pkg.setDefaultPageLimit(12);
    }
    expect(b.pkg.DEFAULT_LIMIT).toBe(12);
  });

  it('Package: autoLoadOntologyData through one copy loads an ontology registered through the other', () => {
    const load = jest.fn(async () => {});
    const {linkedOntology} = a.pkg.linkedPackage('@two-copies/ontology');
    linkedOntology({}, (term: string) => ({id: `https://ex.org/onto#${term}`}), 'twocopiesonto', load);
    // Detach the other ontologies' loaders for the call, so only this one runs.
    const others = [...shared('Package').ontologies].filter((o: any) => o._prefix !== 'twocopiesonto');
    const saved = others.map((o: any) => o._load);
    others.forEach((o: any) => (o._load = undefined));
    try {
      b.pkg.autoLoadOntologyData(true);
      expect(load).toHaveBeenCalledTimes(1);
      expect(shared('Package').autoLoadOntologyData).toBe(true);
    } finally {
      a.pkg.autoLoadOntologyData(false);
      others.forEach((o: any, i: number) => (o._load = saved[i]));
      b.prefix.Prefix.delete('twocopiesonto');
    }
  });

  it('SHACL: a package publish root set through one copy derives IRIs in the other', () => {
    a.pkg.linkedPackage('@two-copies/private', {baseUri: 'https://ws.id.example/'});
    const uri = a.shacl.getPackageUri('@two-copies/private');
    expect(uri.startsWith('https://ws.id.example/')).toBe(true);
    expect(b.shacl.getPackageUri('@two-copies/private')).toBe(uri);
    expect(b.shacl.getNodeShapeUri('@two-copies/private', 'Thing')).toBe(
      a.shacl.getNodeShapeUri('@two-copies/private', 'Thing'),
    );
    expect(b.shacl.getNodeShapeUri('@two-copies/private', 'Thing').startsWith('https://ws.id.example/')).toBe(true);
  });

  it('SHACL: a node shape callback added through one copy is handed out by the other', () => {
    const cb = () => {};
    b.shacl.addNodeShapeCallback('https://ex.org/shape/Waiting', cb);
    expect(a.shacl.getAndClearCallbacks('https://ex.org/shape/Waiting')).toEqual([cb]);
    expect(b.shacl.getAndClearCallbacks('https://ex.org/shape/Waiting')).toBeUndefined();
  });

  it('ShapeClass: an adapter one copy built in a catalog keeps that catalog in the other', () => {
    const iri = 'https://ex.org/two-copies/shape/Person';
    const catalog = a.core.ShapeCatalog.from([
      {id: iri, label: 'Person', targetClass: {id: 'https://ex.org/two-copies/Person'}, propertyShapes: []},
    ]);
    const adapter = a.core.withShapeCatalog(catalog, () => a.shapeClass.getOrCreateShapeAdapter(iri));
    expect(adapter).toBeDefined();
    expect(b.shapeClass.captureCatalog(adapter)).toBe(catalog);
    expect(b.core.withShapeCatalog(catalog, () => b.shapeClass.getOrCreateShapeAdapter(iri))).toBe(adapter);
  });

  it('Shape.typesToShapes: one map behind both copies', () => {
    expect(b.shape.Shape.typesToShapes).toBe(a.shape.Shape.typesToShapes);
    class Typed extends a.shape.Shape {
      static targetClass = {id: 'https://ex.org/two-copies/Typed'};
    }
    a.shape.Shape.registerByType(Typed);
    expect(b.shape.Shape.typesToShapes.get('https://ex.org/two-copies/Typed')?.has(Typed)).toBe(true);
  });
});

describe('class and error checks across copies', () => {
  /** Every class core brands, by the module that defines it. */
  const BRANDED: [keyof Copy, string][] = [
    ['shape', 'Shape'],
    ['coreSet', 'CoreSet'],
    ['shapeSet', 'ShapeSet'],
    ['core', 'SelectBuilder'],
    ['core', 'CreateBuilder'],
    ['core', 'UpdateBuilder'],
    ['core', 'DeleteBuilder'],
    ['core', 'AskBuilder'],
    ['core', 'CountBuilder'],
    ['qc', 'PendingQueryContext'],
    ['core', 'FieldSet'],
    ['core', 'PropertyPath'],
    ['expression', 'ExpressionNode'],
    ['expression', 'ExistsCondition'],
    ['select', 'QueryBuilderObject'],
    ['select', 'QueryShape'],
    ['select', 'QueryShapeSet'],
    ['select', 'QueryPrimitive'],
    ['select', 'QueryPrimitiveSet'],
  ];

  it.each(BRANDED)('%s %s: an instance from the other copy passes isLinkedInstance', (mod, name) => {
    const Mine = a[mod][name];
    const Theirs = b[mod][name];
    expect(Theirs).not.toBe(Mine);
    const theirs = Object.create(Theirs.prototype);
    expect(theirs instanceof Mine).toBe(false);
    expect(a.error.isLinkedInstance(theirs, Mine)).toBe(true);
    expect(b.error.isLinkedInstance(Object.create(Mine.prototype), Theirs)).toBe(true);
  });

  it('a subclass instance or prototype from the other copy matches the base', () => {
    class TheirPerson extends b.shape.Shape {}
    expect(a.error.isLinkedInstance(b.shape.createShapeTarget(TheirPerson), a.shape.Shape)).toBe(true);
    expect(a.error.isLinkedInstance(TheirPerson.prototype, a.shape.Shape)).toBe(true);
    expect(a.error.isLinkedInstance(new b.shapeSet.ShapeSet(), a.coreSet.CoreSet)).toBe(true);
    expect(a.error.isLinkedInstance(new b.coreSet.CoreSet(), a.shapeSet.ShapeSet)).toBe(false);
    // An unbranded subclass falls back to instanceof.
    class MyPerson extends a.shape.Shape {}
    expect(a.error.isLinkedInstance(b.shape.createShapeTarget(TheirPerson), MyPerson)).toBe(false);
  });

  it('a pending context from the other copy is a context reference', () => {
    const ref = a.qc.asContextRef(new b.qc.PendingQueryContext('two-copies-ref'));
    expect(ref?.contextName).toBe('two-copies-ref');
  });

  it.each(['UnresolvedShapeError', 'UnresolvedContextError', 'ShapeValidationError'])(
    '%s from the other copy passes isLinkedError',
    (name) => {
      const theirs = Object.create(b.core[name].prototype);
      expect(theirs instanceof a.core[name]).toBe(false);
      expect(a.core.isLinkedError(theirs, a.core[name])).toBe(true);
      expect(a.core.isLinkedInstance(theirs, a.core[name])).toBe(true);
    },
  );

  it('an UnresolvedShapeError thrown by the other copy is caught by brand', () => {
    const err = new b.unresolved.UnresolvedShapeError('no shape', {shapeIri: 'https://ex.org/x'});
    expect(a.core.isLinkedError(err, a.core.UnresolvedShapeError)).toBe(true);
    expect(a.core.isLinkedError(new Error('x'), a.core.UnresolvedShapeError)).toBe(false);
  });
});

afterAll(() => {
  a?.qc.setQueryContext('two-copies-user', null);
  a?.qc.setQueryContext('two-copies-late', null);
});
