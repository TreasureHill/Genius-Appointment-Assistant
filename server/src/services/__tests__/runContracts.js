/**
 * Runs every alarm-monitoring contract test file in this folder:
 *   npm run test:contracts   (from server/; also part of `npm test`)
 *
 * CONVENTION — any file here named contract*.test.js is picked up
 * automatically (sorted by name), so each track adds its own file with no
 * package.json edit. A test file:
 *   - uses ./contractHarness:  const { t, group, done } = require('./contractHarness')(__filename);
 *   - registers tests with t(name, fn) (fn may be async) and group(title)
 *   - ends with:               module.exports = done();
 *   - touches no database and no network (stub models / clients; fixtures in
 *     fixtures/{docusign,stripe}/)
 * A file that throws while loading, or whose export isn't a harness promise,
 * counts as a failure. Exit code is non-zero if anything failed.
 */
const fs = require('fs');
const path = require('path');

async function main() {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => /^contract.*\.test\.js$/.test(f))
    .sort();
  let passed = 0;
  let failed = 0;
  const broken = [];
  for (const f of files) {
    try {
      const result = await require(path.join(__dirname, f));
      if (!result || typeof result.passed !== 'number') {
        broken.push(`${f}: does not export the harness result (module.exports = done())`);
        failed += 1;
        continue;
      }
      passed += result.passed;
      failed += result.failed;
    } catch (err) {
      broken.push(`${f}: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
      failed += 1;
    }
  }
  for (const b of broken) console.log(`  ✗ ${b}`);
  console.log(`\ncontracts: ${files.length} file(s), ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
