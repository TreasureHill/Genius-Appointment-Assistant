/**
 * Tiny shared harness for the alarm-monitoring contract tests
 * (contract*.test.js). Same output style as the other test files (✓ per test,
 * a count at the end) but async-aware and failure-counting, so one runner
 * (runContracts.js) can execute every file in a single process.
 *
 * Usage in a test file:
 *
 *   const { t, group, done } = require('./contractHarness')(__filename);
 *   group('pricing');
 *   t('basic is 2499 + 325', () => { ... });          // sync or async
 *   module.exports = done();                            // MUST be last
 *
 * done() starts running the queued tests and returns a promise of
 * { file, passed, failed }. Run directly (node contractX.test.js) the file
 * sets a non-zero exit code on failure by itself.
 */
const path = require('path');

module.exports = function harness(filename) {
  const queue = [];
  const t = (name, fn) => queue.push({ name, fn });
  const group = (name) => queue.push({ group: name });

  async function run() {
    const file = path.basename(filename);
    let passed = 0;
    let failed = 0;
    console.log(`\n# ${file}`);
    for (const item of queue) {
      if (item.group) {
        console.log(item.group);
        continue;
      }
      try {
        await item.fn();
        passed += 1;
        console.log(`  ✓ ${item.name}`);
      } catch (err) {
        failed += 1;
        console.log(`  ✗ ${item.name}`);
        console.log(`    ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n    ')}`);
      }
    }
    console.log(`${file}: ${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    return { file, passed, failed };
  }

  function done() {
    const p = run();
    if (require.main && require.main.filename === filename) {
      p.then(
        (r) => {
          if (r.failed) process.exitCode = 1;
        },
        (err) => {
          console.error(err);
          process.exitCode = 1;
        }
      );
    }
    return p;
  }

  return { t, group, done };
};
