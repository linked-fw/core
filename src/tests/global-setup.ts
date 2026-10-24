/**
 * Jest globalSetup — runs once before any test worker starts.
 *
 * Reaches (or starts) Fuseki once, so the live suites don't race Docker startup from parallel
 * workers, and records the answer for `describeFuseki` (see `test-helpers/fuseki-live.ts`).
 * When the run requires Fuseki (`CI`, or `REQUIRE_FUSEKI`), an unreachable Fuseki aborts the
 * whole run here — a CI run must never report the live suites green without running them.
 *
 * A reachable Fuseki must infer `rdf:type` through `rdfs:subClassOf` (core relies on it): a
 * probe checks it, and a store that does not infer — a stock Fuseki left on the port — fails
 * the run, naming the image to run. Datasets a killed run left behind (core's own prefix only)
 * are deleted first.
 *
 * The Fuseki URL and admin password must be set explicitly (`FUSEKI_BASE_URL`,
 * `FUSEKI_ADMIN_PASSWORD`). Without them no Fuseki is contacted or started: the live suites are
 * skipped locally, and a run that requires them fails here, naming the variables.
 */
import {
  ensureFuseki,
  fusekiRequired,
  FUSEKI_BASE_URL,
  FUSEKI_LIVE_ENV,
  fusekiConfigMessage,
  fusekiConfigMissing,
  fusekiTestPort,
  probeInference,
  reapTestDatasets,
} from '../test-helpers/fuseki-test-store';

export default async function globalSetup() {
  const missing = fusekiConfigMissing();
  if (missing.length) {
    process.env[FUSEKI_LIVE_ENV] = '0';
    const message = fusekiConfigMessage(missing);
    if (fusekiRequired()) {
      throw new Error(`[globalSetup] Fuseki is required (CI or REQUIRE_FUSEKI is set), but ${message}`);
    }
    console.warn(`[globalSetup] Every [fuseki] test will be reported as SKIPPED: ${message}`);
    return;
  }
  if (!fusekiTestPort()) {
    throw new Error(
      `[globalSetup] FUSEKI_BASE_URL (${FUSEKI_BASE_URL}) names no port: give it the port of your ` +
        'own test store, e.g. http://localhost:<free port>.',
    );
  }

  const available = await ensureFuseki();
  process.env[FUSEKI_LIVE_ENV] = available ? '1' : '0';
  if (available) {
    const reaped = await reapTestDatasets();
    if (reaped.length) {
      console.log(`[globalSetup] deleted ${reaped.length} dataset(s) a previous run left behind`);
    }
    if (!(await probeInference())) {
      throw new Error(
        `[globalSetup] The Fuseki at ${FUSEKI_BASE_URL} does not infer rdf:type through ` +
          `rdfs:subClassOf, which core's live tests rely on. Run the inferring image ` +
          `(ghcr.io/linked-fw/fuseki, or linked-fuseki:dev built from linked-fw/fuseki's ` +
          `server/Dockerfile, through LINKED_FUSEKI_IMAGE), not a stock Fuseki. That store may ` +
          `be another project's: never stop a container you did not start. Point FUSEKI_BASE_URL ` +
          `at a free port of your own instead; global setup starts the inferring image there.`,
      );
    }
    return;
  }

  if (fusekiRequired()) {
    throw new Error(
      `[globalSetup] Fuseki is required (CI or REQUIRE_FUSEKI is set) but is not reachable at ` +
        `${FUSEKI_BASE_URL}, so the live Fuseki suites cannot run. Start Docker, or set ` +
        `REQUIRE_FUSEKI=0 to let them be skipped.`,
    );
  }
  console.warn(
    `[globalSetup] Fuseki is not reachable at ${FUSEKI_BASE_URL} — every [fuseki] test will be ` +
      `reported as SKIPPED. Start Docker to run them.`,
  );
}
