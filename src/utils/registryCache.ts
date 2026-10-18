/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The registry-derived cache, in a module with no imports so the modules that
 * `ShapeClass.ts` imports (and that import it back) can create caches at evaluation.
 *
 * It reads the shared registry container `ShapeClass.ts` puts on `globalThis`
 * (`__linkedShapeRegistry`); the first `get()` always runs after that module evaluated.
 */

const shapeRegistryGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);

let registryState: {registryVersion: number; activeCatalog: object | undefined} | undefined;

/**
 * A cache derived from the shape registry: one map for the global registry, rebuilt when
 * its version moves, and one per catalog, kept in a WeakMap on the catalog object. A
 * catalog is immutable, so its map needs no version and lives as long as the catalog does.
 * `fill`, when given, populates a fresh map. @internal
 */
export class RegistryCache<K, V> {
  private globalMap = new Map<K, V>();
  private globalVersion = -1;
  private readonly byCatalog = new WeakMap<object, Map<K, V>>();

  constructor(private readonly fill?: (map: Map<K, V>) => void) {}

  /** The map for the active catalog (or the global registry). */
  get(): Map<K, V> {
    const state = (registryState ??= shapeRegistryGlobal.__linkedShapeRegistry);
    const catalog = state.activeCatalog;
    if (catalog === undefined) {
      if (this.globalVersion !== state.registryVersion) {
        this.globalMap = new Map();
        this.globalVersion = state.registryVersion;
        this.fill?.(this.globalMap);
      }
      return this.globalMap;
    }
    let map = this.byCatalog.get(catalog);
    if (!map) {
      map = new Map();
      this.byCatalog.set(catalog, map);
      this.fill?.(map);
    }
    return map;
  }
}
