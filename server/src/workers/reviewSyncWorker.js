const cron = require('node-cron');
const Setting = require('../models/Setting');
const sync = require('../services/reviews/sync');

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

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
  const lastFull = rv.lastFullSyncAt ? new Date(rv.lastFullSyncAt).getTime() : 0;
  const last = rv.lastSyncAt ? new Date(rv.lastSyncAt).getTime() : 0;
  const incrementalDue = hours > 0 && now - last >= hours * MS_HOUR;
  // A store holding far fewer reviews than the listing reports (a backfill
  // that only got Google's newest-first feed) is re-read in full as soon as
  // any sync is due, whatever the full-read cadence says.
  const partial = (incrementalDue || fullDays > 0) && (await sync.storeLooksPartial(setting));
  const fullDue = (fullDays > 0 && now - lastFull >= fullDays * MS_DAY) || partial;
  if (!fullDue && !incrementalDue) return { skipped: 'fresh' };
  return sync.runSync({ full: fullDue, trigger: partial ? 'scheduled:backfill' : 'scheduled' });
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
