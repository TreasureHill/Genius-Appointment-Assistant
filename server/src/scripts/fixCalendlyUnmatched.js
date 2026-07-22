/**
 * Fix stuck Calendly "unmatched" queue entries.
 *
 * Two ways rows get stuck in the manual-mapping queue forever:
 *   1. The invitee's email was uploaded to the DB AFTER their event synced
 *      (e.g. the DB was wiped and projects re-imported). The live sync only
 *      re-checks invitees that appear inside its 30-day window, so once the
 *      event ages out, the row is never looked at again — even though its
 *      email now matches a lot buyer exactly.
 *   2. Rows from before a DB wipe reference projects/lots that no longer
 *      exist. Nothing can ever match them; they just clog the queue.
 *
 * This script re-matches every queued 'unmatched' row straight from the DB
 * (no Calendly API needed): by invitee email first, then by the project/lot
 * answer they typed at booking, then by buyer name (unambiguous hits only —
 * the same rules the live sync uses). Matched lots are set to:
 *   - 'completed'  when the appointment has already passed
 *   - 'scheduled'  when it is still upcoming
 * (opted_out lots are never touched). All of the invitee's queue rows flip to
 * 'mapped'. Rows that still match nothing and whose event has already passed
 * are marked 'ignored' (stale pre-wipe leftovers) unless --keep-past is given.
 *
 * Usage:
 *   node src/scripts/fixCalendlyUnmatched.js [--dry-run] [--keep-past]
 *   npm run fix:calendly -- --dry-run
 *
 * Options:
 *   --dry-run     Report what would change without writing anything.
 *   --keep-past   Do NOT ignore stale past rows that still match nothing.
 *   --help        Show this help.
 */
require('../config/env');
const { connect, mongoose } = require('../config/db');
const { rematchUnmatchedQueue } = require('../services/calendly');

function parseArgs(argv) {
  const opts = { dryRun: false, keepPast: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--keep-past') opts.keepPast = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

const HELP = `Re-match stuck Calendly unmatched-queue entries against the current DB.

  node src/scripts/fixCalendlyUnmatched.js [--dry-run] [--keep-past]

  --dry-run     Show what would change; write nothing.
  --keep-past   Keep stale past rows in the queue instead of ignoring them.
  --help        Show this help.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  await connect();

  console.log(
    `Re-matching queued Calendly invitees against the current database` +
      (opts.dryRun ? '  [DRY RUN — no writes]' : '')
  );

  const { stats, changes } = await rematchUnmatchedQueue({
    dryRun: opts.dryRun,
    ignoreStalePast: !opts.keepPast,
  });

  if (changes.length) {
    console.log(`\n${opts.dryRun ? 'Would update' : 'Updated'} ${changes.length} lot(s):`);
    for (const c of changes.slice(0, 100)) {
      console.log(
        `  • Lot ${c.lot}${c.project ? ` (${c.project})` : ''}: ${c.from} → ${c.to}  @ ${c.when}  [${c.email}, by ${c.method}]`
      );
    }
    if (changes.length > 100) console.log(`  …and ${changes.length - 100} more.`);
  }

  console.log('\n──────── Summary ────────');
  console.log(`Queue rows scanned:        ${stats.rows}`);
  console.log(`Distinct invitees:         ${stats.invitees}`);
  console.log(`Mapped by email:           ${stats.mappedByEmail}`);
  console.log(`Mapped by answer/name:     ${stats.mappedBySignal}`);
  console.log(`Lots → scheduled:          ${stats.lotsScheduled}`);
  console.log(`Lots → completed (past):   ${stats.lotsCompleted}`);
  console.log(`Ignored (stale, past):     ${stats.ignoredStalePast}`);
  console.log(`Still unmatched:           ${stats.stillUnmatched}`);
  console.log(opts.dryRun ? '\n(DRY RUN — nothing was written.)' : '\nDone.');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Fix failed:', err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
