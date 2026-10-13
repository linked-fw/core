/**
 * Jest globalSetup — runs once before any test worker starts.
 *
 * Reaches (or starts) Fuseki once, so the live suites don't race Docker startup from parallel
 * workers, and records the answer for `describeFuseki` (see `test-helpers/fuseki-live.ts`).
 * When the run requires Fuseki (`CI`, or `REQUIRE_FUSEKI`), an unreachable Fuseki aborts the
 * whole run here — a CI run must never report the live suites green without running them.
 */
import {
  ensureFuseki,
  fusekiRequired,
  FUSEKI_BASE_URL,
  FUSEKI_LIVE_ENV,
} from '../test-helpers/fuseki-test-store';

export default async function globalSetup() {
  const available = await ensureFuseki();
  process.env[FUSEKI_LIVE_ENV] = available ? '1' : '0';
  if (available) return;

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
