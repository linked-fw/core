/**
 * Which callback a traced path belongs to.
 *
 * An inline filter (`p.bestFriend.friends.where((f) => f.name.equals(p.name))`) runs its callback
 * with a proxy of its own (`f`), while the enclosing callback's proxy (`p`) is still reachable.
 * Both paths trace to the same property ids (`['name']`), so the filter must know which root a
 * path starts from: `f.name` reads the member, `p.name` reads the outer subject.
 *
 * While an inline filter's callback (or a quantifier's callback inside one) runs, its proxy is on
 * the scope stack. A path whose chain root is not the innermost scope is an outer reference:
 * - rooted at the query's own proxy (the select, sort or sub-select callback): it is resolved to
 *   the outer alias, by its path from the query root (`outerPathOf`);
 * - rooted at an enclosing scope (the inline filter's member, read from a quantifier inside it):
 *   no path from the query root reaches it, and lowering refuses it.
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
  let current = obj;
  while (current.subject) current = current.subject;
  return (current as {proxy?: object}).proxy ?? current;
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

/** Whether an inline filter's callback is running (quantifiers open a scope only inside one). */
export const inTraceScope = (): boolean => scopeStack.length > 0;

/** Records that `proxy` is the root of a sub-select on `source`. */
export const registerSubSelectRoot = (proxy: object, source: TraceObject | undefined): void => {
  if (source) subSelectSources.set(chainRootOf(proxy as TraceObject), source);
};

export type TraceScopeOfPath =
  | {kind: 'own'}
  /** Property ids from the query root to the path's root. */
  | {kind: 'outer'; prefix: string[]}
  | {kind: 'unscoped'};

/** Where a traced path starts, relative to the innermost scope. */
export const traceScopeOf = (obj: TraceObject): TraceScopeOfPath => {
  if (scopeStack.length === 0) return {kind: 'own'};
  const root = chainRootOf(obj);
  if (root === scopeStack[scopeStack.length - 1]) return {kind: 'own'};
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

/** The path from the query root to `root`, or undefined when `root` is an enclosing scope. */
const outerPathOf = (root: object): string[] | undefined => {
  if (scopeStack.includes(root)) return undefined;
  const source = subSelectSources.get(root);
  if (!source) return [];
  const prefix = outerPathOf(chainRootOf(source));
  return prefix && [...prefix, ...segmentIdsOf(source)];
};
