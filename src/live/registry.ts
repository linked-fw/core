/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {LiveQueryStore} from './LiveQueryStore.js';

/**
 * Where the live-query store registers itself.
 *
 * `globalThis`-backed for the same reason the query dispatch and the routing
 * table are (see `docs/architecture/runtime-instances.md`): a second physical
 * copy of this module must find the same store rather than fork it.
 */
export const LIVE_STORE_KEY = '__linkedLiveQueryStore';

const registryGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);

/**
 * The registered live-query store, or `undefined` when `./LiveQueryStore.js`
 * has not been evaluated yet.
 *
 * The builders reach the store through this tiny module — never by importing
 * `LiveQueryStore.ts` — so a bundle that only builds and forwards queries never
 * pulls in the store, and with it the IR lowering the store needs for its
 * dependency analysis. Importing the package root (`@_linked/core`) or
 * `@_linked/core/live` registers the store.
 */
export function peekLiveQueryStore(): LiveQueryStore | undefined {
  return registryGlobal[LIVE_STORE_KEY] as LiveQueryStore | undefined;
}

/** The registered store; throws when live queries have not been loaded. */
export function getLiveQueryStore(): LiveQueryStore {
  const store = peekLiveQueryStore();
  if (!store) {
    throw new Error(
      "Live queries are not loaded. Import '@_linked/core' (the package root) or " +
        "'@_linked/core/live' once before calling .live() on a query.",
    );
  }
  return store;
}

/** @internal Register (or replace) the store — called by `LiveQueryStore.ts` on load and by `resetLiveQueryStore()`. */
export function setLiveQueryStore(store: LiveQueryStore | undefined): void {
  if (store === undefined) {
    delete registryGlobal[LIVE_STORE_KEY];
  } else {
    registryGlobal[LIVE_STORE_KEY] = store;
  }
}
