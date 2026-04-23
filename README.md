# Genius Appointment Assistant

MERN webapp that books homeowner appointments by sending paced email + SMS
campaigns from uploaded lot sheets. Tracks every send, honors a reminder
interval and a hard reminder cap, and auto-flips lots to "scheduled" when
Calendly confirms the invitee.

## Stack
- **MongoDB** (Mongoose 8)
- **Express 4** on Node 20
- **React 18 + Vite 5** (plain JSX), React Router 6
- `nodemailer`, `twilio`, `xlsx` (SheetJS), `node-cron`, `handlebars`, `react-quill-new`

## Quick start
```bash
cp .env.example .env        # fill in SMTP / Twilio / Calendly if you want live sends
docker run -d -p 27017:27017 --name genius-mongo mongo:7   # or your own Mongo
npm install                 # installs both workspaces
npm run dev                 # server :4000 + Vite dev server :5173 (proxies /api)
```

Open http://localhost:5173 and log in with `admin / changeme` (values from
`.env`). The app boots even when SMTP / Twilio / Calendly are blank — those
features fail loudly in Settings → Health, everything else works.

### Production
```bash
npm run build     # builds client into client/dist
npm start         # Express serves the SPA + API on $PORT
```

## Feature map
| Area | Where |
| --- | --- |
| Login (single admin, env-seeded) | `server/src/routes/auth.js`, `client/src/pages/Login.jsx` |
| Projects + pacing + reminder config | `server/src/models/Project.js`, `client/src/pages/ProjectDetail.jsx` |
| Lots + up to 3 buyers + status | `server/src/models/Lot.js`, `client/src/pages/LotDetail.jsx` |
| Reps (no login, just tracking) | `server/src/models/Rep.js`, `client/src/pages/Reps.jsx` |
| HTML email + SMS editors | `client/src/components/EmailEditor.jsx`, `SmsEditor.jsx` |
| Sheet import (diff: add new only) / export | `server/src/services/sheetParser.js`, `sheetExporter.js` |
| Paced sender (random jitter) | `server/src/workers/senderWorker.js` + `Outbox` collection |
| Scheduled reminders | `server/src/workers/reminderScheduler.js` |
| Calendly webhook + poll (multi-event warning) | `server/src/services/calendly.js`, `server/src/workers/calendlyPoller.js`, `server/src/routes/webhooks.js` |
| Dashboard + message history | `server/src/routes/dashboard.js`, `client/src/pages/Dashboard.jsx`, `History.jsx` |

## How messages are paced (anti-junk)
When you bulk send or the scheduler enqueues reminders, each message gets a
`sendAfter` timestamp staggered by `random(project.pacing.minSec..maxSec)`
seconds from the previous one. A worker drains the outbox every 10 s. Default
window is 30–120 s — override per project.

## How the sheet diff works
- **Key** = `(project, lotNumber)`.
- On re-upload, existing lots are **skipped** by default (not overwritten).
- New lots are inserted with their buyers.
- Unknown project names get a new Project row with default pacing.
- The UI shows a preview (`created / skipped / warnings`) before you commit.

## Calendly
Two ways to stay in sync:
1. **Webhook** (`POST /api/webhooks/calendly`) — point Calendly at your URL
   with the shared secret in `.env`.
2. **Poll** — if a rep has `calendlyUser` set, a cron job every 30 min pulls
   scheduled events for that user, matches invitee emails to lot buyers, and
   flips matched lots to `scheduled`. If the same email shows up in multiple
   active events, the lot is flagged with a warning on the Dashboard.

## Branch
Work lives on `claude/mern-appointment-booking-app-sxX2C`.
