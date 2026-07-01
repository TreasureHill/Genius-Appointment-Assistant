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
- **ElevenLabs Conversational AI** ("Aria") for outbound voice calls that book over the phone

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
| **Aria voice calls (ElevenLabs) + transcript/recording/booking** | `server/src/services/elevenlabs.js`, `server/src/services/ariaCall.js`, `server/src/routes/aria.js`, `client/src/pages/LotDetail.jsx` |
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
Three ways to stay in sync:
1. **Webhook** (`POST /api/webhooks/calendly`) — point Calendly at your URL
   with the shared secret in `.env`. Handles both `invitee.created` (→ lot
   `scheduled`) and `invitee.canceled` (→ lot reverts to `contacted` and the
   appointment card is cleared, so reminders resume).
2. **Poll** — a cron job every 30 min pulls scheduled events for the owner URI
   (Settings → Owner, or `CALENDLY_USER_URI`), matches invitee emails to lot
   buyers, and flips matched lots to `scheduled`. Past appointments are reaped
   to `completed` by a separate 15-min worker. The poll never overrides a
   `completed` or `opted_out` lot. If the same email shows up in multiple active
   events, the lot is flagged with a warning on the Dashboard.
3. **Reconcile / backfill** — `npm run reconcile:calendly` (from `server/`)
   sweeps a wide window (default ±12 months) to catch appointments booked while
   the server was down or before Calendly was wired up. It sets upcoming matches
   to `scheduled` and already-passed ones to `completed`, and queues unmatched
   invitees for manual mapping. Use `-- --dry-run` to preview, `-- --months=N`
   / `-- --future-months=N` to widen the window.

## Voice calls with Aria (ElevenLabs)

Every lot with a buyer phone number gets a **📞 Call** button — on the Board
rows and on the lot page. Clicking it dials the buyer with **Aria**, an
ElevenLabs Conversational AI agent, who introduces the project, offers open
Calendly times, and can **book the appointment right on the call**.

**What you get per call** (on the lot page, filled in automatically when the
call ends):
- **Outcome** (completed / voicemail / no answer / failed) and **duration**
- **Summary** and full **transcript**
- **Recording** playback (streamed through the server so the ElevenLabs API
  key never reaches the browser)

**How it flows**
1. `POST /api/lots/:id/call` dispatches through
   `/convai/twilio/outbound-call` (ElevenLabs runs the Twilio leg). We pass the
   buyer, project, and the next few open Calendly slots as dynamic variables,
   and tag the conversation `user_id: lot_<id>`.
2. **During** the call Aria calls two server tools:
   - `POST /api/aria/tools/availability` → real open slots from Calendly's
     `event_type_available_times`.
   - `POST /api/aria/tools/book` → records the chosen slot, flips the lot to
     **scheduled**, and texts/emails the homeowner the Calendly link for that
     exact slot to confirm.
   Both are public (ElevenLabs calls them directly) and guarded by the
   `x-aria-secret` header (`ARIA_TOOL_SECRET`).
3. **After** the call ElevenLabs POSTs `/api/webhooks/elevenlabs`
   (HMAC-verified with `ELEVENLABS_WEBHOOK_SECRET`, idempotent per
   `conversation_id`) with the transcript, summary, duration, and recording.

**Booking + Calendly, honestly:** Calendly's API can't create a confirmed
event server-side, so "booked on the call" means the lot is marked
`scheduled` immediately *and* the homeowner is sent the scheduling link for
that slot. When they tap it and finish on Calendly, the existing webhook/poll
reconciles the lot against the real event (`calendlyEventUri` gets filled in).
Aria-held slots keep an empty `calendlyEventUri`, so the cancellation handler
(which keys off the event URI) never disturbs them. A stuck-call janitor
force-fails any call left "calling" for 30 min (dropped webhook safety net).

**Setup** (Settings → *Aria voice calling*, plus `.env`):
- `.env`: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`,
  `ELEVENLABS_AGENT_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`,
  `ARIA_TOOL_SECRET` (and a `CALENDLY_EVENT_TYPE_URI` fallback).
- Settings UI: the Calendly **event type URI** Aria books, the timezone used
  to speak times, and optional first-message / system-prompt overrides. The
  card also shows the exact webhook + tool URLs to paste into the ElevenLabs
  agent, and a **Preview availability** button to sanity-check the wiring.
- On the ElevenLabs agent, point the post-call webhook at
  `/api/webhooks/elevenlabs`, and add two server tools pointing at the
  `/api/aria/tools/*` URLs (sending the `x-aria-secret` header). The tool the
  agent uses to book takes `lot_id`, `start_time`, and optional
  `buyer_name` / `buyer_email`.

Everything degrades gracefully: with no ElevenLabs keys the Call button is
disabled and the rest of the app is unaffected.

## Branch
Work lives on `claude/mern-appointment-booking-app-sxX2C`.
