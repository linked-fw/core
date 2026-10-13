/**
 * Prints how many live-Fuseki tests ran, so a green log says whether the live suites executed.
 * A live test is one whose outermost describe starts with `[fuseki]` (see
 * `src/test-helpers/fuseki-live.ts`). Reporting only: failing a run that needed Fuseki is
 * globalSetup's job.
 */
const PREFIX = '[fuseki]';

class FusekiLiveReporter {
  onRunComplete(_contexts, results) {
    const counts = {passed: 0, failed: 0, skipped: 0};
    for (const file of results.testResults) {
      for (const test of file.testResults) {
        if (!(test.ancestorTitles[0] || '').startsWith(PREFIX)) continue;
        if (test.status === 'passed') counts.passed++;
        else if (test.status === 'failed') counts.failed++;
        else counts.skipped++;
      }
    }
    const total = counts.passed + counts.failed + counts.skipped;
    console.log(
      `${PREFIX} live tests: ${total} total — ${counts.passed} passed, ${counts.failed} failed, ` +
        `${counts.skipped} skipped`,
    );
  }
}

module.exports = FusekiLiveReporter;
