/**
 * Test helper module for Apache Jena Fuseki integration tests.
 *
 * Provides utilities to:
 * - Ensure a Fuseki instance is running (auto-starts via Docker if needed)
 * - Check if a Fuseki instance is available, and whether this run requires one
 * - Create / delete an in-memory test dataset
 * - Load N-Triples data
 * - Execute SPARQL queries and updates
 * - Clear all data
 *
 * Uses native fetch (Node 18+). No external HTTP libraries.
 */
import {execSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename, resolve} from 'node:path';

export const FUSEKI_BASE_URL = process.env.FUSEKI_BASE_URL || 'http://localhost:3939';
const FUSEKI_ADMIN_PASSWORD = process.env.FUSEKI_ADMIN_PASSWORD || 'admin';
/**
 * One dataset per test file. Each live suite seeds and clears its whole dataset, so two files
 * sharing one — in parallel workers, or one after another on the same worker — can clobber each
 * other's fixtures. Naming it after the file isolates them under any jest invocation, and a
 * failing dataset name points straight at its suite. Outside a test file (globalSetup, a plain
 * node script) there is no `expect`, and the worker id is used instead.
 */
function datasetName(): string {
  const testPath = typeof expect === 'undefined' ? undefined : expect.getState().testPath;
  if (testPath) return `nashville-test-${basename(testPath).replace(/\.test\.tsx?$/, '')}`;
  return `nashville-test-${process.env.JEST_WORKER_ID ?? '1'}`;
}
export const DATASET_NAME = datasetName();

/**
 * Set by jest globalSetup to `'1'` when it reached Fuseki and `'0'` when it did not. Workers
 * inherit it, so every suite reads the same answer synchronously while jest collects tests.
 * Lives here rather than in `fuseki-live.ts` because globalSetup must not import `@jest/globals`.
 */
export const FUSEKI_LIVE_ENV = 'LINKED_TEST_FUSEKI_LIVE';

/**
 * Whether a run must fail rather than skip when Fuseki is unreachable. `REQUIRE_FUSEKI` decides
 * when set (`0`/`false` opt out, any other value requires); otherwise CI requires it, so a CI
 * run whose Docker start failed cannot report the live suites as green.
 */
export function fusekiRequired(): boolean {
  const explicit = process.env.REQUIRE_FUSEKI;
  if (explicit) return explicit !== '0' && explicit.toLowerCase() !== 'false';
  const ci = process.env.CI;
  return Boolean(ci) && ci !== '0' && ci.toLowerCase() !== 'false';
}

/** Whether this process started Fuseki (so we know whether to stop it). */
let startedByUs = false;

const adminAuth = `Basic ${Buffer.from(`admin:${FUSEKI_ADMIN_PASSWORD}`).toString('base64')}`;

/**
 * Check whether a Fuseki server is reachable.
 * Returns true if a HEAD request to the base URL succeeds with status 200.
 */
export async function isFusekiAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(FUSEKI_BASE_URL, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Locate the docker-compose.test.yml for Fuseki.
 * Works from both source (src/) and compiled (lib/esm/) paths.
 */
function findComposeFile(): string | null {
  // Resolve from the package root (process.cwd() when jest/tsc runs) rather
  // than this module's dir. Avoids `import.meta.url`, which ts-jest cannot
  // compile in the CJS-mode globalSetup path (TS1343) — while the test always
  // runs from the package root, so cwd is stable.
  const candidates = [
    resolve(process.cwd(), 'src/tests/docker-compose.test.yml'),
    resolve(process.cwd(), 'tests/docker-compose.test.yml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Ensure a Fuseki instance is running.
 * If Fuseki is already reachable, returns immediately.
 * Otherwise, starts it via Docker Compose and waits for the healthcheck.
 *
 * Returns true if Fuseki is available after this call.
 * Returns false if Docker is not installed or the compose file can't be found.
 */
export async function ensureFuseki(): Promise<boolean> {
  if (await isFusekiAvailable()) return true;

  const composeFile = findComposeFile();
  if (!composeFile) {
    console.warn(
      '[ensureFuseki] docker-compose.test.yml not found — cannot auto-start Fuseki',
    );
    return false;
  }

  try {
    execSync('docker compose version', {stdio: 'ignore'});
  } catch {
    console.warn('[ensureFuseki] Docker Compose not available — cannot auto-start Fuseki');
    return false;
  }

  console.log('[ensureFuseki] Fuseki not running — starting via Docker...');
  try {
    execSync(`docker compose -f "${composeFile}" up -d --wait`, {
      stdio: 'inherit',
      timeout: 60_000,
    });
    startedByUs = true;

    // Verify it came up
    if (await isFusekiAvailable()) {
      console.log('[ensureFuseki] Fuseki is ready');
      return true;
    }
    console.warn('[ensureFuseki] Fuseki started but not responding');
    return false;
  } catch (err) {
    console.warn('[ensureFuseki] Failed to start Fuseki:', (err as Error).message);
    return false;
  }
}

/**
 * Stop the Fuseki container if it was started by `ensureFuseki()`.
 * No-op if Fuseki was already running before the tests.
 */
export async function stopFuseki(): Promise<void> {
  if (!startedByUs) return;

  const composeFile = findComposeFile();
  if (!composeFile) return;

  try {
    execSync(`docker compose -f "${composeFile}" down`, {
      stdio: 'inherit',
      timeout: 30_000,
    });
  } catch {
    // Best effort — don't fail the test suite on cleanup
  }
  startedByUs = false;
}

/**
 * Create the in-memory test dataset on Fuseki.
 * Ignores 409 Conflict (dataset already exists).
 */
export async function createTestDataset(): Promise<void> {
  const response = await fetch(`${FUSEKI_BASE_URL}/$/datasets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: adminAuth,
    },
    body: `dbName=${DATASET_NAME}&dbType=mem`,
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `Failed to create test dataset: ${response.status} ${response.statusText}`,
    );
  }
}

/**
 * Delete the test dataset from Fuseki.
 */
export async function deleteTestDataset(): Promise<void> {
  const response = await fetch(
    `${FUSEKI_BASE_URL}/$/datasets/${DATASET_NAME}`,
    {method: 'DELETE', headers: {Authorization: adminAuth}},
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to delete test dataset: ${response.status} ${response.statusText}`,
    );
  }
}

/**
 * Load N-Triples data into the test dataset.
 */
export async function loadTestData(ntriples: string): Promise<void> {
  const response = await fetch(`${FUSEKI_BASE_URL}/${DATASET_NAME}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/n-triples'},
    body: ntriples,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to load test data: ${response.status} ${response.statusText}\n${body}`,
    );
  }
}

/**
 * Execute a SPARQL SELECT/ASK/CONSTRUCT query against the test dataset.
 * Returns parsed SPARQL JSON results.
 */
export async function executeSparqlQuery(sparql: string): Promise<any> {
  const response = await fetch(
    `${FUSEKI_BASE_URL}/${DATASET_NAME}/sparql`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: sparql,
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `SPARQL query failed: ${response.status} ${response.statusText}\n${sparql}\n${body}`,
    );
  }
  return response.json();
}

/**
 * Execute a SPARQL UPDATE against the test dataset.
 */
export async function executeSparqlUpdate(sparql: string): Promise<void> {
  const response = await fetch(
    `${FUSEKI_BASE_URL}/${DATASET_NAME}/update`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/sparql-update'},
      body: sparql,
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `SPARQL update failed: ${response.status} ${response.statusText}\n${sparql}\n${body}`,
    );
  }
}

/**
 * Remove all triples from the test dataset.
 */
export async function clearAllData(): Promise<void> {
  await executeSparqlUpdate('DELETE WHERE { ?s ?p ?o }');
}
