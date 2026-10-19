/**
 * Module state that survives a second copy of the module.
 *
 * A framework module can be evaluated more than once in one process: under `linked start`
 * once by Vite's SSR module runner and once by Node, and in a browser when two bundles each
 * carry a copy. A module-scope variable then exists twice, and a value one caller writes is
 * invisible to a caller that reached the other copy. `sharedState` keeps the value on
 * `globalThis` under `Symbol.for('<pkg>:<name>')`, created by whichever copy asks first, so
 * every copy reads and writes the same object.
 *
 * Put a module's state in one container object and mutate it, rather than storing a primitive:
 * the container is shared, a primitive read into a local is not.
 *
 * The container outlives any one version of the module. A newer copy that adds a field must
 * tolerate a container an older copy created without it (fill the gap, don't assume it).
 *
 * See https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md.
 *
 * @param pkg  The package's npm name, e.g. `'@_linked/server-utils'`.
 * @param name What the state is, unique within the package, e.g. `'Server.proxy'`.
 * @param init Creates the initial value; called once per process, by the first copy.
 */
export function sharedState<T extends object>(pkg: string, name: string, init: () => T): T {
  const key = sharedStateKey(pkg, name);
  const store = globalThis as unknown as Record<symbol, unknown>;
  if (!(key in store)) store[key] = init();
  return store[key] as T;
}

/** The `globalThis` key {@link sharedState} uses: `Symbol.for('<pkg>:<name>')`. */
export function sharedStateKey(pkg: string, name: string): symbol {
  return Symbol.for(`${pkg}:${name}`);
}
