/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Live queries: `@_linked/core/live`.
 *
 * Importing this module registers the live-query store for the runtime, which
 * is what makes `query.live()` work. The package root imports it too, so an app
 * that imports `@_linked/core` needs nothing else.
 */
export {
  LiveQueryStore,
  getLiveQueryStore,
  resetLiveQueryStore,
  publishChange,
  invalidate,
} from './live/LiveQueryStore.js';
export type {ChangeEvent} from './live/changes.js';
export type {
  LiveQuery,
  LiveState,
  LiveStatus,
  LiveListener,
  LiveQueryOptions,
  LiveQueryStoreOptions,
  Template,
  Instance,
} from './live/LiveQueryStore.js';
export type {InstanceParams, LiveBuilder, LiveQueryKind} from './live/keys.js';
export {splitQuery, templateKey, paramsKey, stripSubjects} from './live/keys.js';
