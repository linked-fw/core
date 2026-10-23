/**
 * Test helper module for Apache Jena Fuseki integration tests.
 *
 * Provides utilities to:
 * - Ensure a Fuseki instance is running (auto-starts via Docker if needed)
 * - Check if a Fuseki instance is available, and whether this run requires one
 * - Create / delete a test dataset (TDB2, so the inferring image infers over it)
 * - Probe that the store infers, and reap datasets a killed run left behind
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
/**
 * The compose project the test store runs under, so it never joins (or stops) another project's
 * Fuseki. Set LINKED_CORE_TEST_COMPOSE_PROJECT to run a second store next to it.
 */
const COMPOSE_PROJECT = process.env.LINKED_CORE_TEST_COMPOSE_PROJECT || 'linked-core-test';
/** The image the compose file runs when LINKED_FUSEKI_IMAGE is unset. */
const DEFAULT_IMAGE = 'ghcr.io/linked-fw/fuseki:6.2.0-2';
/** Every dataset a test file creates is named with this prefix (see `datasetName`). */
export const TEST_DATASET_PREFIX = 'nashville-test-';
/** The dataset global setup creates to check that the store infers, and drops again. */
export const INFERENCE_PROBE_DATASET = 'linked-inference-probe';
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
  if (testPath) return `${TEST_DATASET_PREFIX}${basename(testPath).replace(/\.test\.tsx?$/, '')}`;
  return `${TEST_DATASET_PREFIX}${process.env.JEST_WORKER_ID ?? '1'}`;
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

  console.log(
    `[ensureFuseki] Fuseki not running — starting ${process.env.LINKED_FUSEKI_IMAGE || DEFAULT_IMAGE} ` +
      `via Docker (compose project ${COMPOSE_PROJECT})...`,
  );
  try {
    execSync(`docker compose -p ${COMPOSE_PROJECT} -f "${composeFile}" up -d --wait`, {
      stdio: 'inherit',
      timeout: 120_000,
      env: composeEnv(),
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
    execSync(`docker compose -p ${COMPOSE_PROJECT} -f "${composeFile}" down`, {
      stdio: 'inherit',
      timeout: 30_000,
      env: composeEnv(),
    });
  } catch {
    // Best effort — don't fail the test suite on cleanup
  }
  startedByUs = false;
}

/** The compose file's variables: the port of FUSEKI_BASE_URL, the rest from the environment. */
function composeEnv(): NodeJS.ProcessEnv {
  const port = new URL(FUSEKI_BASE_URL).port || '3939';
  return {...process.env, FUSEKI_TEST_PORT: process.env.FUSEKI_TEST_PORT || port};
}

/**
 * Create a dataset through the admin form. `tdb2`: on the inferring image only TDB2 datasets
 * infer (`mem` stays plain), and they persist, so the run's teardown and the next run's setup
 * delete them (`reapTestDatasets`). Ignores 409 Conflict (dataset already exists).
 */
export async function createDataset(name: string): Promise<void> {
  const response = await fetch(`${FUSEKI_BASE_URL}/$/datasets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: adminAuth,
    },
    body: `dbName=${encodeURIComponent(name)}&dbType=tdb2`,
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `Failed to create dataset ${name}: ${response.status} ${response.statusText}`,
    );
  }
}

/** Delete a dataset (its TDB2 files too, on the image). Tolerates 404. */
export async function deleteDataset(name: string): Promise<void> {
  const response = await fetch(
    `${FUSEKI_BASE_URL}/$/datasets/${encodeURIComponent(name)}`,
    {method: 'DELETE', headers: {Authorization: adminAuth}},
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to delete dataset ${name}: ${response.status} ${response.statusText}`,
    );
  }
}

/** Create this test file's dataset (`DATASET_NAME`). */
export async function createTestDataset(): Promise<void> {
  await createDataset(DATASET_NAME);
}

/** Delete this test file's dataset. */
export async function deleteTestDataset(): Promise<void> {
  await deleteDataset(DATASET_NAME);
}

/** The names of every dataset the server holds. */
export async function listDatasets(): Promise<string[]> {
  const response = await fetch(`${FUSEKI_BASE_URL}/$/datasets`, {
    headers: {Authorization: adminAuth, Accept: 'application/json'},
  });
  if (!response.ok) {
    throw new Error(`Failed to list datasets: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as {datasets?: Array<{'ds.name'?: string}>};
  return (body.datasets ?? [])
    .map((d) => (d['ds.name'] ?? '').replace(/^\//, ''))
    .filter(Boolean);
}

/**
 * Delete every test dataset (`nashville-test-*`) and the inference probe. Run by global setup,
 * for what a killed run left behind, and by global teardown, even when tests failed: TDB2
 * datasets persist in the container.
 */
export async function reapTestDatasets(): Promise<string[]> {
  const names = (await listDatasets()).filter(
    (name) => name.startsWith(TEST_DATASET_PREFIX) || name === INFERENCE_PROBE_DATASET,
  );
  for (const name of names) await deleteDataset(name);
  return names;
}

/**
 * Whether the store infers `rdf:type` through `rdfs:subClassOf`: creates the probe dataset,
 * stores `A ⊑ B` and `x a A`, asks for `x a B`, and drops the dataset again. A stock Fuseki
 * answers false; so does a `mem` dataset on the image.
 */
export async function probeInference(): Promise<boolean> {
  const name = INFERENCE_PROBE_DATASET;
  await deleteDataset(name);
  await createDataset(name);
  try {
    const ex = 'http://example.org/linked-inference-probe/';
    const update = await fetch(`${FUSEKI_BASE_URL}/${name}/update`, {
      method: 'POST',
      headers: {'Content-Type': 'application/sparql-update'},
      body:
        `INSERT DATA { <${ex}A> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${ex}B> . ` +
        `<${ex}x> a <${ex}A> . }`,
    });
    if (!update.ok) throw new Error(`probe insert: ${update.status} ${await update.text()}`);
    const ask = await fetch(`${FUSEKI_BASE_URL}/${name}/sparql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: `ASK { <${ex}x> a <${ex}B> }`,
    });
    if (!ask.ok) throw new Error(`probe ask: ${ask.status} ${await ask.text()}`);
    return ((await ask.json()) as {boolean?: boolean}).boolean === true;
  } finally {
    await deleteDataset(name);
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

/** Read the whole test dataset's default graph as Turtle (blank nodes labelled consistently). */
export async function readDatasetAsTurtle(): Promise<string> {
  const response = await fetch(`${FUSEKI_BASE_URL}/${DATASET_NAME}/sparql`, {
    method: 'POST',
    headers: {'Content-Type': 'application/sparql-query', Accept: 'text/turtle'},
    body: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
  });
  if (!response.ok) {
    throw new Error(`CONSTRUCT failed: ${response.status} ${response.statusText}\n${await response.text()}`);
  }
  return response.text();
}

/**
 * The dataset the test image exposes a SHACL service on. The image keeps the base image's `ds`
 * (now inferring, over TDB2) and its `fuseki:shacl` endpoint when the container runs with
 * `ENABLE_SHACL=true` (set in docker-compose.test.yml, together with `ENABLE_DATA_WRITE` for the
 * graph-store PUT below). Using `ds` keeps the SHACL suite independent of the per-file datasets.
 */
const SHACL_DATASET = 'ds';

/**
 * Validate `dataTurtle` against `shapesTurtle` with Jena SHACL (Fuseki's `/ds/shacl` service).
 * Replaces the default graph of `ds` with the data, then POSTs the shapes. Returns the
 * validation report as Turtle. Callers sharing `ds` must not run in parallel; only one
 * test file uses it.
 */
export async function validateWithJenaShacl(
  shapesTurtle: string,
  dataTurtle: string,
): Promise<string> {
  const put = await fetch(`${FUSEKI_BASE_URL}/${SHACL_DATASET}/data?default`, {
    method: 'PUT',
    headers: {'Content-Type': 'text/turtle'},
    body: dataTurtle,
  });
  if (!put.ok) {
    throw new Error(
      `Loading SHACL test data failed: ${put.status} ${put.statusText} — is the test Fuseki ` +
        `running with ENABLE_DATA_WRITE/ENABLE_SHACL (src/tests/docker-compose.test.yml)?`,
    );
  }
  const report = await fetch(`${FUSEKI_BASE_URL}/${SHACL_DATASET}/shacl?graph=default`, {
    method: 'POST',
    headers: {'Content-Type': 'text/turtle', Accept: 'text/turtle'},
    body: shapesTurtle,
  });
  if (!report.ok) {
    throw new Error(
      `SHACL validation failed: ${report.status} ${report.statusText} — is the test Fuseki ` +
        `running with ENABLE_SHACL=true (src/tests/docker-compose.test.yml)?\n${await report.text()}`,
    );
  }
  return report.text();
}
