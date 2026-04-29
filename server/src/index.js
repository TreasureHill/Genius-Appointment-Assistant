require('express-async-errors');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const env = require('./config/env');
const { connect: connectDb } = require('./config/db');
const { requireAuth } = require('./middleware/auth');
const { seedAdmin, seedStarterTemplates, migrateBookedToScheduled } = require('./scripts/seedBoot');
const { startWorkers } = require('./workers');

// Routes
const authRoutes = require('./routes/auth');
const projectsRoutes = require('./routes/projects');
const lotsRoutes = require('./routes/lots');
const templatesRoutes = require('./routes/templates');
const sheetsRoutes = require('./routes/sheets');
const messagesRoutes = require('./routes/messages');
const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');
const webhooksRoutes = require('./routes/webhooks');
const calendlyRoutes = require('./routes/calendly');
const reportsRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

// Webhooks need raw / url-encoded body handlers; mount before JSON parser
app.use('/api/webhooks', webhooksRoutes);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);

// Everything under /api below this line requires auth
app.use('/api', requireAuth);
app.use('/api/projects', projectsRoutes);
app.use('/api/lots', lotsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/sheets', sheetsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/calendly', calendlyRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/admin', adminRoutes);

// Serve built client in production
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (req, res) => {
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
  app.listen(env.port, () => {
    console.log(`[server] listening on :${env.port} (${env.nodeEnv})`);
    startWorkers();
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
