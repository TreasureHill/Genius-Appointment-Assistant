const cron = require('node-cron');
const secrets = require('../services/secrets');
const { syncAll } = require('../services/calendly');

// Always scheduled: the token can be connected from Integrations at any time,
// so whether there's anything to do is decided on each tick.
function start() {
  cron.schedule('*/30 * * * *', () => {
    if (!secrets.calendlyConfigured()) return;
    syncAll().catch((e) => console.error('[calendly] sync error', e.message));
  });
  console.log(
    `[calendly] poller started (every 30 min, uses owner URI from Settings)${
      secrets.calendlyConfigured() ? '' : ' — idle until a Calendly token is connected'
    }`
  );
}

module.exports = { start };
