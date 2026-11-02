require('express-async-errors');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const env = require('./config/env');
const { connect: connectDb } = require('./config/db');
const { requireAuth } = require('./middleware/auth');
const {
  seedAdmin,
  seedStarterTemplates,
  migrateBookedToScheduled,
  migrateCalendlyWarnings,
  migrateScheduleTimezone,
  migrateGeniusEmailTemplate,
  seedReviewReps,
  migrateAlarmDefaults,
} = require('./scripts/seedBoot');
const { startWorkers } = require('./workers');

// Routes
const authRoutes = require('./routes/auth');
const projectsRoutes = require('./routes/projects');
const lotsRoutes = require('./routes/lots');
const templatesRoutes = require('./routes/templates');
const sheetsRoutes = require('./routes/sheets');
const messagesRoutes = require('./routes/messages');
const callsRoutes = require('./routes/calls');
const queueRoutes = require('./routes/queue');
const activityRoutes = require('./routes/activity');
const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');
const webhooksRoutes = require('./routes/webhooks');
const ariaRoutes = require('./routes/aria');
const calendlyRoutes = require('./routes/calendly');
const reportsRoutes = require('./routes/reports');
const reviewsRoutes = require('./routes/reviews');
const adminRoutes = require('./routes/admin');
const portalRoutes = require('./routes/portal');
const contractsRoutes = require('./routes/contracts');

const app = express();

// Production runs behind Caddy on the same box: trust exactly one proxy hop so
// req.ip (rate limits, portal lockouts) is the client, not 127.0.0.1.
app.set('trust proxy', 1);

// Credentialed CORS only for our own front end (and the Vite dev server). The
// old `origin: true` reflected any site with cookies attached, which the
// money-adjacent portal endpoints can't afford. Requests with no Origin header
// (same-origin GETs, curl, webhooks, server-to-server) are unaffected.
const corsOrigins = new Set([env.appUrl, 'http://localhost:5173', 'http://127.0.0.1:5173']);
app.use(
  cors({
    credentials: true,
    origin(origin, cb) {
      // Not allowed → no CORS headers; the browser blocks the read.
      cb(null, !origin || corsOrigins.has(origin));
    },
  })
);
app.use(cookieParser());

// Webhooks need raw / url-encoded body handlers; mount before JSON parser
app.use('/api/webhooks', webhooksRoutes);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);

// Aria's live server tools (Calendly availability + booking) are called by
// ElevenLabs' servers mid-call, so they sit OUTSIDE the auth wall — guarded by
// the shared ARIA_TOOL_SECRET instead. Must be mounted before requireAuth.
app.use('/api/aria', ariaRoutes);

// Homeowner portal API. Has its own login (psid cookie, see
// middleware/portalAuth) and its own requirePortalAuth on the protected
// routes, so it must sit OUTSIDE the admin wall below.
app.use('/api/portal', portalRoutes);

// Everything under /api below this line requires auth
app.use('/api', requireAuth);
app.use('/api/projects', projectsRoutes);
app.use('/api/lots', lotsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/sheets', sheetsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/calendly', calendlyRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/contracts', contractsRoutes);

// Serve built client in production
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  // Portal pages carry one-time set-password tokens in the URL fragment; make
  // sure no page there ever leaks its URL to another site via Referer.
  app.use('/portal', (req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.static(clientDist));
  // Everything except /api and /api/... falls through to the SPA.
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error('[api error]', err.stack || err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'server_error' });
});

async function main() {
  await connectDb();
  await seedAdmin();
  await seedStarterTemplates();
  await migrateBookedToScheduled();
  await migrateCalendlyWarnings();
  await migrateScheduleTimezone();
  await migrateGeniusEmailTemplate();
  await seedReviewReps();
  await migrateAlarmDefaults();
  const onListen = () => {
    console.log(`[server] listening on ${env.host || '*'}:${env.port} (${env.nodeEnv})`);
    startWorkers();
    warnOnStripeCatalog();
  };
  if (env.host) app.listen(env.port, env.host, onListen);
  else app.listen(env.port, onListen);
}

// Checkout refuses to run while Stripe's prices or HST rate differ from
// pricing.js, so say so loudly at boot instead of at a homeowner's first
// click. Background and best-effort: a Stripe outage must not block startup.
function warnOnStripeCatalog() {
  if (!env.stripe.configured) return;
  const { verifyCatalog, safeStripeMessage } = require('./services/contracts/stripeClient');
  verifyCatalog({ force: true })
    .then((r) => {
      if (r.ok) console.log(`[stripe] catalog OK (${env.stripe.mode} mode)`);
      else console.warn(`[stripe] CATALOG MISMATCH, checkout is blocked until fixed: ${r.problems.join('; ')}`);
    })
    .catch((err) => console.warn('[stripe] catalog check failed at boot:', safeStripeMessage(err)));
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
