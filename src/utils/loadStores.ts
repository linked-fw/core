// Backend-side store loader. Lives in its own file so that frontend
// bundlers (webpack) consuming parseDatasetsConfig don't pull in the
// dynamic import (through importPackageModule) — webpack flags `import(variableString)` as
// a critical dependency when it can't analyse the target statically.
//
// Backends import this directly; frontends never do.

import type {DatasetsConfig} from './parseDatasetsConfig.js';
import {importPackageModule} from './importPackageModule.js';

/**
 * Dynamically imports each alias's `store` (an npm specifier) and
 * instantiates the resolved class with the entry's `config` verbatim —
 * `new StoreClass(entry.config)`. Returns alias → store.
 *
 * Convention: the last segment of the `store` path is the named export
 * to use (e.g. `@_linked/fuseki/shapes/FusekiStore` → `FusekiStore`).
 * Falls back to the module's `default` export if the named export is
 * absent. Each store class must accept a single config-object argument.
 *
 * Imports each store with {@link importPackageModule}: through the host
 * loader under `Symbol.for('@_linked/core:importModule')` when one is set
 * (`linked start` sets it in dev, so a store comes from the same copy of its
 * package as the app's own import of it), else the native `import()`. The
 * specifier is passed unchanged.
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
): Promise<Record<string, T>> {
  const stores: Record<string, T> = {};
  for (const [alias, entry] of Object.entries(config.datasets)) {
    // SECURITY: `entry.store` is a module specifier loaded and executed here.
    // It must come from a trusted developer artifact (datasets.json) and must
    // NEVER be attacker-influenced — an arbitrary specifier is arbitrary code
    // execution. Do not source this from request/user input.
    const mod = await importPackageModule(entry.store);
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
    stores[alias] = new (StoreClass as new (cfg: unknown) => T)(entry.config);
  }
  return stores;
}
