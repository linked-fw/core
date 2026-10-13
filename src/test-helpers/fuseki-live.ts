/**
 * The one switch for live-Fuseki tests. jest globalSetup tries to reach (or start) Fuseki once
 * and records the answer in `FUSEKI_LIVE_ENV`; a suite wraps its live tests in `describeFuseki`,
 * which registers them normally when Fuseki is up and as visibly skipped when it is not. When the
 * run requires Fuseki (`CI` or `REQUIRE_FUSEKI`), globalSetup fails instead, so the skipped branch
 * is only ever taken locally.
 *
 * Put a live block's Fuseki hooks (`createTestDataset`, `clearAllData`, store setup) inside the
 * `describeFuseki` callback: jest does not run the hooks of a skipped block. A file-level hook
 * shared by several live blocks starts with `if (!fusekiLive) return;` instead — jest runs a
 * file's top-level hooks whenever any test in the file runs, including an offline one. Tests
 * themselves never check availability.
 */
import {describe} from '@jest/globals';
import {FUSEKI_BASE_URL, FUSEKI_LIVE_ENV} from './fuseki-test-store';

/**
 * Every live block's name starts with this; `npm run test:fuseki` selects on it and the
 * live-test reporter counts by it. Call `describeFuseki` at file top level: the reporter reads
 * only a test's outermost describe.
 */
export const FUSEKI_TEST_PREFIX = '[fuseki]';

export const fusekiLive = process.env[FUSEKI_LIVE_ENV] === '1';

export function describeFuseki(name: string, fn: () => void): void {
  if (fusekiLive) {
    describe(`${FUSEKI_TEST_PREFIX} ${name}`, fn);
  } else {
    describe.skip(`${FUSEKI_TEST_PREFIX} ${name} (skipped: Fuseki unavailable at ${FUSEKI_BASE_URL})`, fn);
  }
}
