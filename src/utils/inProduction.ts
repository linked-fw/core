/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * True when the process runs with `NODE_ENV=production`. Core's development warnings check it:
 * in production they are neither printed nor paid for (no extra query). Read through
 * `globalThis`, so a bundle without `process` (a browser) counts as development.
 */
export function inProduction(): boolean {
  const env = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env;
  return env?.NODE_ENV === 'production';
}
