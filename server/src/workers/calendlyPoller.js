const cron = require('node-cron');
const env = require('../config/env');
const { syncAll } = require('../services/calendly');

function start() {
  if (!env.calendly.configured) {
    console.log('[calendly] poller not starting — token not configured');
    return;
  }
  cron.schedule('*/30 * * * *', () => {
    syncAll().catch((e) => console.error('[calendly] sync error', e.message));
  });
  console.log('[calendly] poller started (every 30 min, uses owner URI from Settings)');
}

module.exports = { start };
