const cron = require('node-cron');
const Setting = require('../models/Setting');
const sync = require('../services/reviews/sync');

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;
const BACKFILL_RETRY_MS = MS_DAY;

// Keeps the Reviews tab fresh without anyone clicking Sync: an incremental
// read every `autoSyncHours` (1–3 SerpApi searches) and, when enabled, a
// re-read of the whole listing every `fullSyncDays` so edits to old reviews
// are caught. Nothing runs until a SerpApi key is configured.
async function runIfDue({ now = Date.now() } = {}) {
  const setting = await Setting.getSingleton();
  const rv = setting.reviews || {};
  if (!sync.resolveKey(setting)) return { skipped: 'no_key' };
  if (sync.isRunning()) return { skipped: 'running' };
  const hours = Number(rv.autoSyncHours) || 0;
  const fullDays = Number(rv.fullSyncDays) || 0;
  const at = (d) => (d ? new Date(d).getTime() : 0);
  const last = at(rv.lastSyncAt);
  // Full reads are paced by the last ATTEMPT (complete, partial or failed):
  // an incomplete listing must never turn into a ~40-search read every tick.
  const lastFullAttempt = Math.max(at(rv.lastFullAttemptAt), at(rv.lastFullSyncAt));
  const incrementalDue = hours > 0 && now - last >= hours * MS_HOUR;
  const fullByCadence = fullDays > 0 && now - lastFullAttempt >= fullDays * MS_DAY;
  // A store holding far fewer reviews than the listing reports is re-read in
  // full ahead of the cadence, but at most once a day.
  const backfillDue = now - lastFullAttempt >= BACKFILL_RETRY_MS && (await sync.storeLooksPartial(setting));
  const fullDue = fullByCadence || backfillDue;
  if (!fullDue && !incrementalDue) return { skipped: 'fresh' };
  return sync.runSync({ full: fullDue, trigger: backfillDue && !fullByCadence ? 'scheduled:backfill' : 'scheduled' });
}

function start() {
  cron.schedule('*/15 * * * *', () => {
    runIfDue().catch((e) => console.error('[reviews] scheduled sync error', e.message));
  });
  // First check shortly after boot so a fresh deploy doesn't wait up to 15 min.
  setTimeout(() => runIfDue().catch((e) => console.error('[reviews] boot sync error', e.message)), 20_000).unref();
  console.log('[reviews] sync worker started (checks every 15 min; cadence from Reviews → Setup)');
}

module.exports = { start, runIfDue };
