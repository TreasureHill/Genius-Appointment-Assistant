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
  seedReviewReps,
  seedMailboxFromEnv,
} = require('./scripts/seedBoot');
const { loadSecrets } = require('./services/secrets');
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
const inboxRoutes = require('./routes/inbox');
const mailAccountsRoutes = require('./routes/mailAccounts');
const knowledgeRoutes = require('./routes/knowledge');
const aiRoutes = require('./routes/ai');
const integrationsRoutes = require('./routes/integrations');
const oauthRoutes = require('./routes/oauth');

const app = express();

app.use(cors({ origin: true, credentials: true }));
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

// Microsoft redirects the browser back here after "Sign in with Microsoft";
// the signed `state` parameter is what authorises it.
app.use('/api/oauth', oauthRoutes);

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
app.use('/api/inbox', inboxRoutes);
app.use('/api/mail-accounts', mailAccountsRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/integrations', integrationsRoutes);

// Serve built client in production
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
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
  await seedReviewReps();
  // API keys pasted in Integrations live encrypted in Mongo; decrypt them
  // into memory before any worker or route needs them.
  await loadSecrets();
  await seedMailboxFromEnv();
  app.listen(env.port, () => {
    console.log(`[server] listening on :${env.port} (${env.nodeEnv})`);
    startWorkers();
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
