// Backend-side store loader. Lives in its own file so that frontend
// bundlers (webpack) consuming parseDatasetsConfig don't pull in the
// dynamic-import code below — webpack flags `import(variableString)` as
// a critical dependency when it can't analyse the target statically.
//
// Backends import this directly; frontends never do.

import type {DatasetsConfig} from './parseDatasetsConfig.js';
import type {IDataset} from '../interfaces/IDataset.js';
import {parseGraphTargetOptions, type GraphTargetOptions} from './graphTargets.js';

/** Options of {@link loadStores}. */
export interface LoadStoresOptions {
  /**
   * Graph targets for every store that takes them (`IDataset.setGraphTargets`), filling only what
   * the entry's own `config.ontologyGraph` / `config.shapeGraph` leaves unset. A host passes its
   * environment's (`graphTargetOptionsFromEnv(process.env)`); core never reads it itself.
   */
  graphTargets?: GraphTargetOptions;
}

/**
 * The module loader `loadStores` imports each store with. A host that
 * evaluates the app through another loader sets it on `globalThis`, so a
 * store comes from the same copy of its package as the app's own import of
 * it. `linked start` (dev) sets it, because there the app runs in Vite's SSR
 * module runner while a native `import()` would load a second copy through
 * Node (cli backlog 014). Unset, `loadStores` uses the native `import()`.
 *
 * The hook receives the specifier unchanged and resolves to the module
 * namespace. It is read on every call: the host may set it after this module
 * was evaluated.
 */
const IMPORT_MODULE = Symbol.for('@_linked/core:importModule');

function importModule(specifier: string): Promise<unknown> {
  const hook = (globalThis as Record<symbol, unknown>)[IMPORT_MODULE];
  return typeof hook === 'function'
    ? (hook as (specifier: string) => Promise<unknown>)(specifier)
    : import(specifier);
}

/**
 * Dynamically imports each alias's `store` (an npm specifier) and
 * instantiates the resolved class with the entry's `config` verbatim —
 * `new StoreClass(entry.config)`. Returns alias → store. The entry's
 * `config.ontologyGraph` / `config.shapeGraph` are then set on the store
 * (`setGraphTargets`), and `options.graphTargets` fills what they leave unset
 * (see `utils/graphTargets.ts`); an invalid value fails the load. Graph routing is not read from the
 * config (an entry with a `graphs` key gets a warning): the app routes shapes in code.
 *
 * Convention: the last segment of the `store` path is the named export
 * to use (e.g. `@_linked/fuseki/shapes/FusekiStore` → `FusekiStore`).
 * Falls back to the module's `default` export if the named export is
 * absent. Each store class must accept a single config-object argument.
 *
 * Imports through the host loader under
 * `Symbol.for('@_linked/core:importModule')` when one is set (see
 * `importModule` above), else the native `import()`.
 *
 * Async + uses runtime dynamic import; works in Node where the module
 * specifier can be resolved at runtime. Frontends should instead
 * import each store class explicitly in their storage-config file and
 * instantiate per alias by hand (webpack can't bundle
 * `import(variableString)`).
 *
 * @example
 * ```ts
 * import rawConfig from './linked.backend.datasets.json' assert { type: 'json' };
 * import { parseDatasetsConfig } from '@_linked/core/utils/parseDatasetsConfig';
 * import { loadStores } from '@_linked/core/utils/loadStores';
 * import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
 *
 * const config = parseDatasetsConfig(rawConfig, process.env);
 * const stores = await loadStores(config);
 * LinkedStorage.setDefaultDataset(stores.appData);
 * ```
 *
 * @param config  Parsed config from {@link parseDatasetsConfig}.
 * @returns       Map of alias → constructed store instance.
 * @throws        If a `store` path can't be resolved to a class export.
 */
export async function loadStores<T = unknown>(
  config: DatasetsConfig,
  options: LoadStoresOptions = {},
): Promise<Record<string, T>> {
  const stores: Record<string, T> = {};
  // Checked before any store is built: an invalid value fails the load, naming the setting.
  const defaults = parseGraphTargetOptions(options.graphTargets);
  for (const [alias, entry] of Object.entries(config.datasets)) {
    // SECURITY: `entry.store` is a module specifier loaded and executed here.
    // It must come from a trusted developer artifact (datasets.json) and must
    // NEVER be attacker-influenced — an arbitrary specifier is arbitrary code
    // execution. Do not source this from request/user input.
    const mod = await importModule(entry.store);
    const exportName = entry.store.split('/').pop()!;
    const StoreClass =
      (mod && (mod as Record<string, unknown>)[exportName]) ??
      (mod && (mod as {default?: unknown}).default);
    if (typeof StoreClass !== 'function') {
      throw new Error(
        `loadStores: could not resolve a class export from "${entry.store}" for alias "${alias}". ` +
          `Expected a named export "${exportName}" or a default export that is a class.`,
      );
    }
    const store = new (StoreClass as new (cfg: unknown) => T)(entry.config);
    applyGraphTargets(store as unknown as IDataset, alias, entry.config, defaults);
    // Graph routing lives in the app's code, never in this file (see `graphRouting.ts`).
    if ((entry as {graphs?: unknown}).graphs !== undefined) {
      console.warn(
        `[linked] loadStores: alias "${alias}" has a "graphs" key, which the datasets config ` +
          `does not read; route shapes in code with ` +
          `LinkedStorage.setDatasetForShapes(store, [Shape], {graph: 'own'}) (or dataGraph('slug')).`,
      );
    }
    stores[alias] = store;
  }
  return stores;
}

/**
 * Give `store` the entry's own graph targets (`config.ontologyGraph` / `config.shapeGraph`), then
 * fill what is still unset from `defaults`. A store that takes none (`setGraphTargets` absent)
 * runs `'package'` for both: an entry that sets another target for it throws, and defaults that
 * would set one are ignored with a warning.
 */
function applyGraphTargets(
  store: IDataset,
  alias: string,
  config: Record<string, unknown> | undefined,
  defaults: GraphTargetOptions,
): void {
  const own = parseGraphTargetOptions(
    {ontologyGraph: config?.ontologyGraph as string | undefined, shapeGraph: config?.shapeGraph as string | undefined},
    {ontologyGraph: `datasets.${alias}.config.ontologyGraph`, shapeGraph: `datasets.${alias}.config.shapeGraph`},
  );
  const takes = typeof store?.setGraphTargets === 'function';
  const name = (store as {constructor?: {name?: string}})?.constructor?.name ?? 'store';
  if (!takes) {
    if (Object.values(own).some((v) => v !== 'package')) {
      throw new Error(
        `loadStores: alias "${alias}" sets a graph target, but its store (${name}) takes none ` +
          '(IDataset.setGraphTargets); it always runs \'package\'.',
      );
    }
    if (Object.values(defaults).some((v) => v !== 'package')) {
      console.warn(
        `[linked] loadStores: alias "${alias}" (${name}) takes no graph targets, so it runs 'package' ` +
          'for the ontology and shape graphs whatever the host sets.',
      );
    }
    return;
  }
  store.setGraphTargets!(own);
  store.setGraphTargets!(defaults, {onlyUnset: true});
}
