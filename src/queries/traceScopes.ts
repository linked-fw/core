/**
 * Which callback a traced path belongs to.
 *
 * An inline filter (`p.bestFriend.friends.where((f) => f.name.equals(p.name))`) runs its callback
 * with a proxy of its own (`f`), while the enclosing callback's proxy (`p`) is still reachable.
 * Both paths trace to the same property ids (`['name']`), so the filter must know which root a
 * path starts from: `f.name` reads the member, `p.name` reads the outer subject.
 *
 * A quantifier (`p.friends.some((f) => f.name.equals(p.name))`) has the same problem: its callback's
 * proxy is the member, and `p` is the outer subject.
 *
 * While an inline filter's or a quantifier's callback runs, its proxy is on the scope stack. A path
 * whose chain root is not the innermost scope is an outer reference:
 * - rooted at the query's own proxy (the select, sort, where or sub-select callback): it is
 *   resolved by its path from the query root (`outerPathOf`);
 * - rooted at an enclosing scope (an inline filter's or an outer quantifier's member, read from a
 *   quantifier inside it): it is resolved from that scope's member, counted in scopes up from the
 *   innermost one.
 */

type TraceObject = {subject?: TraceObject; property?: {id: string}};

const scopeStack: object[] = [];
/** A sub-select's proxy → the relation it selects from (`p.friends` in `p.friends.select(…)`). */
const subSelectSources = new WeakMap<object, TraceObject>();

/**
 * The object a traced chain starts from: the callback's proxy. A path's chain ends at the proxied
 * query object, the callback receives its proxy (`proxy` on the object); both name the same root.
 */
export const chainRootOf = (obj: TraceObject): object => {
  const root = rawRootOf(obj);
  return castRoots.get(root) ?? root;
};

const rawRootOf = (obj: TraceObject): object => {
  let current = obj;
  while (current.subject) current = current.subject;
  return (current as {proxy?: object}).proxy ?? current;
};

/**
 * A root cast (`f.as(Employee)` on a callback's own proxy) is a new root object: it maps to the
 * root it casts, so a cast member is still that callback's member, never the query root.
 */
const castRoots = new WeakMap<object, object>();
/** Every root a query callback receives (`createProxiedPathBuilder`), or a cast of one. */
const knownRoots = new WeakSet<object>();

/** Records that `cast` (a root cast's object) is `original`'s root seen as another shape. */
export const registerCastRoot = (cast: object, original: object): void => {
  castRoots.set(rawRootOf(cast as TraceObject), chainRootOf(original as TraceObject));
};

/** Records a callback's proxy as a root a traced path may start from. */
export const registerQueryRoot = (proxy: object): void => {
  knownRoots.add(rawRootOf(proxy as TraceObject));
};

/** Runs `fn` with `root` (a callback's proxy) as the innermost scope. */
export const withTraceScope = <T>(root: object, fn: () => T): T => {
  scopeStack.push(chainRootOf(root as TraceObject));
  try {
    return fn();
  } finally {
    scopeStack.pop();
  }
};

/** Records that `proxy` is the root of a sub-select on `source`. */
export const registerSubSelectRoot = (proxy: object, source: TraceObject | undefined): void => {
  if (source) subSelectSources.set(chainRootOf(proxy as TraceObject), source);
};

export type TraceScopeOfPath =
  | {kind: 'own'}
  /** Property ids from the query root to the path's root. */
  | {kind: 'outer'; prefix: string[]}
  /** `up` scopes above the innermost one (1: the scope enclosing it). */
  | {kind: 'enclosing'; up: number}
  /** A sub-select rooted inside an enclosing scope: no path reaches it, lowering refuses it. */
  | {kind: 'unscoped'};

/** Where a traced path starts, relative to the innermost scope. */
export const traceScopeOf = (obj: TraceObject): TraceScopeOfPath => {
  if (scopeStack.length === 0) return {kind: 'own'};
  const root = chainRootOf(obj);
  if (root === scopeStack[scopeStack.length - 1]) return {kind: 'own'};
  const index = scopeStack.lastIndexOf(root);
  if (index >= 0) return {kind: 'enclosing', up: scopeStack.length - 1 - index};
  const prefix = outerPathOf(root);
  return prefix ? {kind: 'outer', prefix} : {kind: 'unscoped'};
};

const segmentIdsOf = (obj: TraceObject): string[] => {
  const ids: string[] = [];
  for (let current: TraceObject | undefined = obj; current; current = current.subject) {
    if (current.property) ids.unshift(current.property.id);
  }
  return ids;
};

/** The path from the query root to `root`, or undefined when it starts in an enclosing scope. */
const outerPathOf = (root: object): string[] | undefined => {
  if (scopeStack.includes(root)) return undefined;
  const source = subSelectSources.get(root);
  if (!source) {
    // The query's own root (a select, where or sort callback's proxy). A root this module does not
    // know is never taken for it: refused at lowering rather than read from the query root.
    return knownRoots.has(root) ? [] : undefined;
  }
  const prefix = outerPathOf(chainRootOf(source));
  return prefix && [...prefix, ...segmentIdsOf(source)];
};

/**
 * The property ids from the query root to `obj`, through the sub-selects it is traced in: where a
 * preloaded component's subject sits in the host query.
 */
export const pathFromQueryRoot = (obj: TraceObject): string[] => [
  ...(outerPathOf(chainRootOf(obj)) ?? []),
  ...segmentIdsOf(obj),
];
