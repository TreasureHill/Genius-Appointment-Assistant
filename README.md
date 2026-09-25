# Genius Appointment Assistant

MERN webapp that books homeowner appointments by sending paced email + SMS
campaigns from uploaded lot sheets. Tracks every send, honors a reminder
interval and a hard reminder cap, and auto-flips lots to "scheduled" when
Calendly confirms the invitee.

## Stack
- **MongoDB** (Mongoose 8)
- **Express 4** on Node 20
- **React 18 + Vite 5** (plain JSX), React Router 6
- `nodemailer`, `twilio`, `xlsx` (SheetJS), `node-cron`, `handlebars`, `react-quill-new`, `pptxgenjs`
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
| Send windows + timezone | `server/src/services/sendWindow.js`, `server/src/services/outboxPlanner.js` |
| **Queue tab (every queued email / SMS / call)** | `server/src/routes/queue.js`, `client/src/pages/Queue.jsx` |
| Scheduled reminders | `server/src/workers/reminderScheduler.js` |
| Calendly webhook + poll (multi-event warning) | `server/src/services/calendly.js`, `server/src/workers/calendlyPoller.js`, `server/src/routes/webhooks.js` |
| **Aria voice calls (ElevenLabs) + transcript/recording/booking** | `server/src/services/elevenlabs.js`, `server/src/services/ariaCall.js`, `server/src/routes/aria.js`, `client/src/pages/LotDetail.jsx` |
| Dashboard + activity log | `server/src/routes/dashboard.js`, `server/src/routes/activity.js`, `client/src/pages/Dashboard.jsx`, `Activity.jsx` |
| **Reviews tab (Google reviews → reps, weekly deck)** | `server/src/routes/reviews.js`, `server/src/services/reviews/`, `server/src/workers/reviewSyncWorker.js`, `client/src/pages/Reviews.jsx`, `client/src/components/reviews/` |

## How messages are paced (anti-junk)
When you bulk send or the scheduler enqueues reminders, each message gets a
`sendAfter` timestamp staggered by `random(pacing.minSec..maxSec)` seconds
from the previous one (Settings → Sending schedule; default 30–120 s). Pacing
is one global line: a new batch starts after whatever is already queued, and
email + SMS + the hourly reminders all chain on the same line. A worker
drains the outbox every 10 s.

## Send windows and the timezone
Send windows ("09:00–21:00", per weekday) are wall-clock times in **one
explicit IANA timezone** — Settings → Sending schedule → Timezone. The server's
own clock never matters: a 9 AM window means 9 AM in Toronto whether the box
runs in UTC, Pacific, or anywhere else. Every queued message is planned into
the window *when it is queued*, so the Queue tab shows the real send time
immediately; the worker only re-checks at send time. Saving the schedule
(windows, pacing, or timezone) re-plans everything still queued, and the first
boot after this change pins the zone (Aria's zone, else `America/New_York`) and
re-plans the existing queue once.

## The lot is the unit of sending
A send is one lot × one channel × one round. One "Send" queues, per lot, a
single email addressed to every buyer on the lot (the greeting renders as
"Hi Jane and John," — `{{buyer.firstName}}` and `{{buyer.name}}` list every
buyer on a per-lot email) and one text per buyer phone; the texts go out
together in the same pacing slot. Every Outbox / MessageLog row carries a
`sendGroup`, and the Queue, the Board's queued badge and comms icons, and the
Dashboard's sent counts all count sends, not recipients. Settings → Sending
schedule → "Send one email per lot" can be switched off to send a separate
personalised email per buyer; either way the lot still counts as one send and
uses one reminder. The Aria call-time outreach follows the same rule.

## The Queue tab
`/queue` lists every email and text waiting in the outbox (one row per lot
send, with all of its recipients) and every Aria call waiting in the call
queue, in the order they will happen, grouped by day, with times in the
schedule timezone. Per send: **Send now** (skips the window, pacing and
reminder holds; only "Pause sending" still stops it) and **Cancel**;
bulk cancel; **Re-plan queue**; pause/resume sending. Rows expand to the full
rendered message. The old History page is folded into Activity (`/history`
redirects), which now filters by channel, replies received, failed sends, and
status changes.

## Tests
```bash
npm test            # pure-function suites: Calendly matching, send-window timezone math, per-lot rendering, ElevenLabs helpers, Google reviews (matcher, windows, SerpApi, deck)
```

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

**Availability, and why it used to time out:** Calendly's
`event_type_available_times` endpoint only accepts a 7-day window, so a
60-day horizon is up to nine requests. Reading them one after another is what
made the agent's first `get_availability` call hit ElevenLabs' ~20 s tool
timeout while the retry succeeded. Now:

- Windows are read **five at a time**, so 60 days is two round trips even when
  the next opening is weeks out.
- The Calendly reads run under a **time budget** (6 s for the in-call tool, 3 s
  for the pre-call fetch), and the whole tool response is capped by a **hard
  9 s deadline** covering everything else too (database, DNS, TLS). It answers
  with the soonest slots it has rather than making the agent wait.
- Results are **cached stale-while-revalidate**: served instantly for 10
  minutes, refreshed in the background once older than 90 s. Dispatching a call
  primes the cache, so the mid-call tool hit is normally a cache hit.
- If Calendly fails or is too slow, the **last times we read** are offered
  rather than an error — `book_appointment` re-validates with Calendly, and a
  slot taken in the meantime is already handled.

Each lookup logs one line (`[calendly] availability: 412 ms, 5 window(s), 3
slot(s)`) so a slow call can be diagnosed from the server log. If the tool
still times out, check the tool's own **response timeout** on the ElevenLabs
agent — it should be comfortably above 10 seconds.

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

**If Aria doesn't say your first message / ignores your prompt:** ElevenLabs
disables overrides by default. The agent's *Security* tab must allow the
"First message" and "System prompt" overrides, otherwise the ones set in
Settings → Aria are refused or ignored and the agent opens with its
dashboard default. Settings → Aria reads those toggles from the agent and
shows them (with an *Enable on the agent* button), and *Preview what Aria
will say* renders the first message + prompt for a real lot and flags any
placeholder that would be spoken literally. Placeholders can be written as
`{{first_name}}` or `{first_name}`; they are filled in server-side before the
call. *Use recommended* next to each field inserts a prompt written for Eleven
v3 Conversational (tone rules, a limited `[slow]` / `[excited]` tag policy, no
filler sounds, times in words) that you can edit before saving. Each call records the opening line it was given (lot page → Call with
Aria), and a call ElevenLabs refuses now fails loudly instead of sitting in
"calling".

Everything degrades gracefully: with no ElevenLabs keys the Call button is
disabled and the rest of the app is unaffected.

## Google reviews (the Reviews tab)

`/reviews` replaces the hand-built weekly "Genius Google Reviews" deck. It
keeps every review on the Treasure Hill Google listing — Genius-related or
not — credits each one to the reps it mentions, and shows the same numbers
the deck reports, live: Genius reviews this week / five-star / all time, the
listing's own total and rating, a 12-week trend, per-rep mentions and
averages, and the week's review log. **Download deck (.pptx)** builds the
deck (cover → Key Metrics → Technician Performance Highlights → All-Time
Technician Review → Customer Review Log) for whatever window is shown;
**Export Excel** writes a workbook with the summary, the reps, the window's
log and every stored review.

**Where the reviews come from.** SerpApi's Google Maps Reviews engine reads
the public listing (no Google Business Profile approval needed). Paste the
key under *Reviews → Setup* (stored in Settings, never echoed back) or set
`SERPAPI_KEY` in `.env` as the headless fallback; *Test connection* checks
the key against SerpApi's free account endpoint and shows the searches
left. `GOOGLE_PLACE_ID` / the Setup place_id default to the *Treasure Hill -
Corporate* listing. Each page of 20 reviews is one SerpApi search: the
first read of the whole listing is ~40 searches, a routine sync 1–3. A
worker runs an incremental sync every *Auto-sync* hours (default 12) and a
full re-read every *Full re-read* days (default 30, catches edits to old
reviews); Setup shows the monthly search budget those settings imply, and
*Sync now* / *Full resync now* run on demand. A failed sync keeps the last
good data and says why on the page. Reviews can also be imported from JSON
(a manual export, or the Python tool's fixture shape).

Two Google quirks shape the sync. Google's *newest first* feed only exposes
a few dozen of the latest reviews, so a full read pages through the listing
in Google's default *most relevant* order instead, and newest-first is used
only for the incremental check (stopping at the last review already
stored); if that feed runs out before getting there, the sync re-reads the
whole listing. And when a full read still comes back with far fewer reviews
than the listing reports, the page says so ("Incomplete: Google served 25 of
the listing's 770 reviews…") and the worker re-reads the listing on its next
run instead of waiting for the full-read cadence.

**Matching.** A review is credited to a rep when its text contains the
rep's name or one of their nicknames (*Reps & matching*: whole words only,
any case, multi-word aliases allowed, e.g. `syed salman`), and it is
Genius-related when it names a rep **or** uses a Genius term (`genius`,
`genious`, …). One review can credit several reps. Editing reps, aliases or
terms re-runs the matcher over every stored review; *Try a phrase* shows
what the matcher makes of a sentence. The seeded reps are Jason, Salman and
Alvee with the nicknames from the old `technicians.json`.

**Mapping by hand.** *Map to a rep* / *Edit mapping* on any review — Genius
or not — credits it to exactly the reps you pick (or nobody), optionally
forces the Genius flag on or off, and keeps a note. Manual mappings win
over the matcher and survive every sync and re-match; *Reset to automatic*
drops them. *Needs mapping* lists Genius-related reviews the matcher could
not credit; *Mapped by hand* lists the overrides. The stats, deck and
export all use the effective (manual-first) classification.

Week boundaries ("Monday of the current week through today", past weeks
Monday–Sunday) and every date use the sending-schedule timezone from
Settings. A review counts for the date it was last edited, like the manual
log did with "Edited 5 days ago" reviews.

## Branch
Work lives on `claude/mern-appointment-booking-app-sxX2C`.
