/**
 * Reconcile / backfill Calendly appointments.
 *
 * The live poll (calendlyPoller) only looks 30 days back, so any appointment
 * booked while the server was down — or before Calendly was wired up — never
 * flipped its lot to scheduled/completed. This one-off script sweeps a wide
 * window, matches invitee emails to lot buyers, and sets each matched lot to:
 *   - 'scheduled'  if the appointment is still upcoming
 *   - 'completed'  if the appointment already ended (it was missed)
 * Lots that are 'opted_out' are left untouched. Unmatched invitees are queued
 * into the CalendlyUnmatch list for manual mapping in the UI.
 *
 * Usage:
 *   node src/scripts/reconcileCalendly.js [--dry-run] [--months=N] [--future-months=N]
 *   npm run reconcile:calendly -- --dry-run
 *
 * Options:
 *   --dry-run            Report what would change without writing anything.
 *   --months=N           How many months back to scan (default 12).
 *   --future-months=N    How many months ahead to scan (default 12).
 *   --help               Show this help.
 *
 * Calendly creds come from CALENDLY_TOKEN and the owner URI (Settings → Owner
 * or the CALENDLY_USER_URI env fallback).
 */
require('../config/env');
const env = require('../config/env');
const { connect, mongoose } = require('../config/db');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const MessageLog = require('../models/MessageLog');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');
const { logStatusChange } = require('../services/lotEventLogger');
const {
  listEvents,
  collectOccurrences,
  findLotHits,
  buildLotCalendlyEvent,
  reconcileTargetStatus,
} = require('../services/calendly');

function parseArgs(argv) {
  const opts = { dryRun: false, months: 12, futureMonths: 12, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--months=')) opts.months = Number(arg.split('=')[1]) || opts.months;
    else if (arg.startsWith('--future-months=')) opts.futureMonths = Number(arg.split('=')[1]) || opts.futureMonths;
  }
  return opts;
}

const HELP = `Reconcile Calendly appointments into lot statuses.

  node src/scripts/reconcileCalendly.js [--dry-run] [--months=N] [--future-months=N]

  --dry-run            Show what would change; write nothing.
  --months=N           Months back to scan (default 12).
  --future-months=N    Months ahead to scan (default 12).
  --help               Show this help.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!env.calendly.token) {
    console.error('✖ CALENDLY_TOKEN is not set — cannot reach Calendly. Aborting.');
    process.exit(1);
  }

  await connect();

  const setting = await Setting.getSingleton();
  const userUri = setting.owner?.calendlyUri || env.calendly.userUri;
  if (!userUri) {
    console.error(
      '✖ No Calendly user URI. Set it in Settings → Owner, or export CALENDLY_USER_URI. Aborting.'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const now = Date.now();
  const minStart = new Date(now - opts.months * 30 * 24 * 60 * 60 * 1000).toISOString();
  const maxStart = new Date(now + opts.futureMonths * 30 * 24 * 60 * 60 * 1000).toISOString();

  console.log(
    `Reconciling Calendly events from ${minStart.slice(0, 10)} to ${maxStart.slice(0, 10)}` +
      (opts.dryRun ? '  [DRY RUN — no writes]' : '')
  );

  // Only active events represent real bookings; cancelled ones shouldn't set a
  // status. (status=active still includes events that have already happened.)
  let events;
  try {
    events = await listEvents(userUri, { minStart, maxStart, status: 'active' });
  } catch (err) {
    console.error('✖ Failed to list Calendly events:', err.response?.data?.message || err.message);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Fetched ${events.length} active event(s). Loading invitees…`);

  const emailOccurrences = await collectOccurrences(events);
  const emails = Array.from(emailOccurrences.keys());
  console.log(`Found ${emails.length} distinct invitee email(s).`);

  const stats = { scheduled: 0, completed: 0, unchanged: 0, skippedOptedOut: 0, lotsTouched: 0 };
  const matchedEmails = new Set();
  const changes = [];

  if (emails.length) {
    const lots = await Lot.find({ 'buyers.email': { $in: emails } }).populate('project', 'name');
    for (const lot of lots) {
      const hits = findLotHits(lot, emailOccurrences);
      if (!hits.length) continue;
      for (const h of hits) matchedEmails.add(h.email);

      // Prefer the most recent occurrence so a re-booked invitee reflects their
      // latest appointment rather than an old one.
      const occurrences = hits.flatMap((h) => h.occurrences.map((o) => ({ ...o, role: h.role, email: h.email })));
      occurrences.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
      const firstHit = occurrences[0];
      const multi = occurrences.length > 1;

      const target = reconcileTargetStatus(lot.status, firstHit, now);
      if (target === null) {
        stats.skippedOptedOut += 1;
        continue;
      }

      const alreadyCorrect = lot.status === target && lot.calendlyEventUri === firstHit.eventUri;
      if (alreadyCorrect) {
        stats.unchanged += 1;
        continue;
      }

      const priorStatus = lot.status;
      changes.push({
        lot: lot.lotNumber,
        project: lot.project?.name || '',
        from: priorStatus,
        to: target,
        when: firstHit.startTime ? new Date(firstHit.startTime).toISOString().slice(0, 16).replace('T', ' ') : '—',
        email: firstHit.email,
      });

      if (!opts.dryRun) {
        lot.status = target;
        lot.calendlyEventUri = firstHit.eventUri || lot.calendlyEventUri;
        lot.calendlyWarning = multi
          ? `Invitee appears in multiple Calendly events (${occurrences.length}). Check for duplicates.`
          : '';
        lot.calendlyEvent = buildLotCalendlyEvent(firstHit, firstHit.email, firstHit.role);
        await lot.save();

        await MessageLog.create({
          project: lot.project?._id || lot.project,
          lot: lot._id,
          type: 'calendly',
          direction: 'in',
          to: firstHit.email,
          subject: firstHit.eventName || 'Calendly event (reconciled)',
          body: `Reconciled invitee ${firstHit.email} (${firstHit.role}) → ${target} from event ${firstHit.eventUri}`,
          status: 'received',
          providerId: firstHit.eventUri,
          sentAt: new Date(),
        });

        await logStatusChange({
          lot,
          project: lot.project?._id || lot.project,
          fromStatus: priorStatus,
          toStatus: target,
          actor: 'calendly_sync',
          message: `Reconciled from Calendly (${firstHit.eventName || 'event'}).`,
        });
      }

      stats.lotsTouched += 1;
      if (target === 'completed') stats.completed += 1;
      else stats.scheduled += 1;
    }
  }

  // Queue invitees we couldn't match for manual mapping (skip on dry-run).
  let unmatchedCount = 0;
  for (const [email, occurrences] of emailOccurrences) {
    if (matchedEmails.has(email)) continue;
    for (const occ of occurrences) {
      unmatchedCount += 1;
      if (opts.dryRun) continue;
      await CalendlyUnmatch.updateOne(
        { eventUri: occ.eventUri, inviteeEmail: email },
        {
          // Backfill the typed answer + name like syncAll does — the queue
          // re-matcher and the UI both rely on them.
          $set: {
            lastSeenAt: new Date(),
            answer: occ.answerText || '',
            inviteeName: occ.inviteeName || '',
            inviteeFirstName: occ.inviteeFirstName || '',
            inviteeLastName: occ.inviteeLastName || '',
          },
          $setOnInsert: {
            eventUri: occ.eventUri,
            eventName: occ.eventName || '',
            eventStartTime: occ.startTime ? new Date(occ.startTime) : null,
            inviteeEmail: email,
            inviteeStatus: occ.inviteeStatus || '',
            status: 'unmatched',
          },
        },
        { upsert: true }
      );
    }
  }

  if (!opts.dryRun) {
    setting.lastCalendlySync = new Date();
    setting.calendlyHealth = {
      ok: true,
      checkedAt: new Date(),
      message: `Reconcile ran: ${events.length} events, ${stats.lotsTouched} lots updated`,
    };
    await setting.save();
  }

  // Print a sample of changes so the operator can eyeball them.
  if (changes.length) {
    console.log(`\n${opts.dryRun ? 'Would update' : 'Updated'} ${changes.length} lot(s):`);
    for (const c of changes.slice(0, 50)) {
      console.log(
        `  • Lot ${c.lot}${c.project ? ` (${c.project})` : ''}: ${c.from} → ${c.to}  @ ${c.when}  [${c.email}]`
      );
    }
    if (changes.length > 50) console.log(`  …and ${changes.length - 50} more.`);
  }

  console.log('\n──────── Summary ────────');
  console.log(`Events scanned:        ${events.length}`);
  console.log(`Invitee emails:        ${emails.length}`);
  console.log(`→ scheduled (upcoming):${stats.scheduled}`);
  console.log(`→ completed (past):    ${stats.completed}`);
  console.log(`Already correct:       ${stats.unchanged}`);
  console.log(`Skipped (opted out):   ${stats.skippedOptedOut}`);
  console.log(`Unmatched invitees:    ${unmatchedCount}`);
  console.log(opts.dryRun ? '\n(DRY RUN — nothing was written.)' : '\nDone.');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Reconcile failed:', err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
