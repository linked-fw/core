/**
 * Jest globalTeardown — runs once after all test workers finish, even when tests failed.
 * Deletes the run's datasets (TDB2 datasets persist in the container), then stops the Fuseki
 * container if globalSetup started it.
 */
import {
  FUSEKI_LIVE_ENV,
  isFusekiAvailable,
  reapTestDatasets,
  stopFuseki,
} from '../test-helpers/fuseki-test-store';

export default async function globalTeardown() {
  try {
    // Only a store global setup reached and checked (it sets FUSEKI_LIVE_ENV to '1').
    if (process.env[FUSEKI_LIVE_ENV] === '1' && (await isFusekiAvailable())) await reapTestDatasets();
  } catch (error) {
    console.warn('[globalTeardown] could not delete the test datasets:', (error as Error).message);
  }
  await stopFuseki();
}
