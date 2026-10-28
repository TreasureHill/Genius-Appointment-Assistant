# Genius Appointment Assistant

MERN webapp that books homeowner appointments by sending paced email + SMS
campaigns from uploaded lot sheets. Tracks every send, honors a reminder
interval and a hard reminder cap, and auto-flips lots to "scheduled" when
Calendly confirms the invitee.

## Stack
- **MongoDB** (Mongoose 8)
- **Express 4** on Node 20
- **React 18 + Vite 5** (plain JSX), React Router 6
- `nodemailer`, `twilio`, `xlsx` (SheetJS), `node-cron`, `handlebars`, `react-quill-new`, `pptxgenjs`, `stripe`, `pdfkit`
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
| **Monitoring contracts (closing → DocuSign → Stripe subscription) + homeowner portal** | `server/src/routes/contracts.js`, `server/src/routes/portal.js`, `server/src/services/contracts/`, `server/src/workers/{docusignPoller,stripeReconciler,paymentReminderWorker,contractTailWorker}.js`, `client/src/pages/Contracts.jsx`, `ContractDetail.jsx`, `client/src/components/contracts/`, `client/src/portal/` |

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
single email to every buyer on the lot — the first buyer on **To**, the
co-buyer (and any third buyer) **CC'd** — whose greeting renders as "Hi Jane
and John," (`{{buyer.firstName}}` and `{{buyer.name}}` list every buyer on a
per-lot email), and one text per buyer phone; the texts go out together in
the same pacing slot. Every Outbox / MessageLog row carries a
`sendGroup`, and the Queue, the Board's queued badge and comms icons, and the
Dashboard's sent counts all count sends, not recipients. Settings → Sending
schedule → "Send one email per lot" can be switched off to send a separate
personalised email per buyer; either way the lot still counts as one send and
uses one reminder. The Aria call-time outreach follows the same rule.

## How emails look in the inbox
- **Sender name.** Settings → Email (SMTP) → *Sender name* is the name shown
  next to the `SMTP_FROM` address (default **Mariyam Amir - Treasure Hill**,
  so inboxes no longer show the bare "mariyama"). Blank uses the name in
  `SMTP_FROM`, if it has one.
- **Blue links.** Every link gets an inline blue (`#0000EE`) unless it sets
  its own colour, so links stay blue after they are clicked instead of
  turning purple; editor `rgb()` colours are sent as hex for Outlook.
- **Plain-text part.** Built from the HTML when the template has no plain
  text of its own: paragraphs, bullets, links spelled out, entities decoded
  (`server/src/services/emailFormat.js`).
- **Genius appointment email.** The template editor's *Insert Genius
  appointment email* button drops in the letter as plain paragraphs and
  lists (`server/src/services/emailPresets.js`). Bodies with tables or styled
  blocks open in the HTML tab, because the rich-text editor rewrites them (a
  table becomes one row of side-by-side cells). On boot, the old table-built
  copy of that email is replaced in place (window security films out, EV
  chargers in, its Calendly link kept) and anything already queued from it is
  re-rendered.

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
npm test            # pure-function suites: Calendly matching, send-window timezone math, per-lot rendering, ElevenLabs helpers, Google reviews (matcher, windows, SerpApi, deck), email formatting (sender, To/CC, links, plain text, Genius preset), monitoring contracts (below)
npm run test:contracts -w server   # just the monitoring-contract suites
```
The monitoring-contract suites (`server/src/services/__tests__/contract*.test.js`,
run by `runContracts.js`, no database and no network) cover pricing and HST,
the status derivation and action guards, admin/portal auth isolation,
webhook signatures (Stripe `constructEvent`, DocuSign HMAC rotation), signer
routing and the package radio group, the agreement PDF and its anchors,
DocuSign envelope sync, Stripe checkout/webhook/reconcile flows against a fake
client (basil and legacy shapes), portal tokens and lockout, the portal
routes, reminder scheduling across Toronto DST, contract emails and the
metrics/CSV. A new `contract*.test.js` file is picked up automatically.

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
   **Every booking shows on the Calendly page.** *Unmatched* is the manual
   queue; *Matched* lists every booking tied to a lot (by email, typed
   project/lot, name, or by hand), newest first, with a note when the lot
   didn't take that booking. When a buyer holds several bookings the lot
   follows the next one coming up (not simply the first Calendly lists), and
   a **completed** lot is reopened to `scheduled` only for a new appointment
   booked after the last one ended — past events and older duplicates never
   reopen it. Opted-out lots are never changed.
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

## Monitoring contracts (alarm monitoring + homeowner portal)

Genius sells the alarm system on the APS addendum ($980, billed there) plus
**monthly monitoring**: *Basic* $24.99 or *Smart* $32.99, with 13% HST added
on top ($28.24 / $37.28 a month). This feature tracks each lot's monitoring
contract from the home closing to the monthly payments.

### How it works
1. **Close the lot.** On the lot page, *Alarm monitoring → Mark closed*
   records `Lot.closing` (a flag and date, deliberately **not** a lot status,
   so the appointment workers and outbox are unaffected). A lot with a live
   contract can't be reopened or deleted.
2. **Prepare and send the agreement.** *Prepare agreement* prefills the
   purchasers from the lot's buyers. The app generates the agreement PDF
   itself (pdfkit, `services/contracts/agreementPdf.js`; the terms text is the
   placeholder `TERMS` constant + `termsVersion`, pending legal) and places
   DocuSign tabs on it with white anchor strings. Signing modes:
   - **Remote** (default): DocuSign emails the purchasers in order. The
     primary purchaser (recipient 1) must pick *Basic* or *Smart* in a
     required radio group before signing; co-buyers sign after.
   - **In person**: *Sign now* opens embedded signing on a tablet; DocuSign
     returns to `/contracts/:id/signing-return`, which hands off to the next
     purchaser.
   - **Paper**: upload a signed PDF with the package and signed date (older
     or offline contracts), so every contract can be tracked.
3. **Signing completes.** DocuSign Connect (or the 20-minute poller when
   Connect is off or a message was missed) calls the single sync path
   `envelopeSync.applyEnvelopeStatus`. On completion the app reads the
   package from the tabs (no package → *needs attention*, staff set it with an
   audit note), stores the signed PDF and certificate in Mongo with their
   sha256, creates a portal account per signer email and sends the welcome
   email with the signed PDF attached and a one-time set-password link.
4. **Payment.** The homeowner logs in at `/portal` and pays through hosted
   Stripe Checkout (subscription, 13% HST tax rate). The first charge is that
   day; renewals follow monthly on the same date. Cards are updated through
   the Stripe Billing Portal. Emails always link to our portal, never to a
   Checkout URL (those expire).
5. **Billing mirror.** Stripe webhooks (and a nightly/hourly reconciler)
   re-fetch each object from Stripe and mirror it: one `ContractPayment` per
   invoice, aggregates (paid, missed, consecutive missed, totals) recomputed
   from those rows, and the contract status derived from envelope + billing:
   `draft → sent → awaiting_payment → active ⇄ past_due → unpaid / canceled`
   (plus `declined` / `voided`, which can be regenerated as a new draft).
   Homeowners can't cancel; staff cancel from the contract page (end of
   period by default).
6. **Emails** (our own, via SMTP, never the Outbox): welcome, payment-setup
   nudge (3 days unpaid), upcoming payment (N days before the charge), receipt,
   payment failed, card expiring, password reset, cancelled, and internal
   alerts to *Contracts CC email*. To = primary purchaser, CC = co-buyers,
   BCC = Contracts CC email (except emails that carry a personal login link).
   Toggles: global in *Settings → Alarm monitoring billing* (and the Contracts
   page header), per contract on the lot card / contract page, and the homeowner's
   own reminder switch in the portal.

Staff views: the lot card, `/contracts` (tiles for active, MRR, collected,
missed, past due, awaiting signature/payment, average months active, charges
in the next 7 days; paid-vs-failed chart; filters; CSV export) and
`/contracts/:id` (documents, envelope, billing, payments, portal users,
history). The Dashboard shows Stripe/DocuSign health and a monitoring row.

The portal is isolated from the admin app: its own `psid` cookie (path
`/api/portal`, JWT `aud:'portal'` signed with `PORTAL_JWT_SECRET`), and the
admin API rejects any portal token. Logins are rate-limited per IP and per
email (failed attempts only) and lock for 15 minutes after 10 failures; a
locked account answers like a wrong password, so the lock never confirms
that an email has an account. Portal POSTs accept JSON only (login CSRF).

### Environment variables
| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public https base URL; portal links, Checkout return URLs and the Connect webhook are built from it |
| `HOST` | Interface to listen on (blank = all). `deploy.ps1 -ListenHost 127.0.0.1` keeps :4000 reachable only from Caddy on the same machine (point Caddy at `127.0.0.1:4000` first); the default stays every interface |
| `PORTAL_JWT_SECRET` | Portal session secret (blank = derived from `JWT_SECRET`; must differ from it) |
| `HST_REGISTRATION_NUMBER` | Printed on receipts and reminders |
| `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…`; test/live mode comes from the prefix |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for `/api/webhooks/stripe` (required in production) |
| `STRIPE_TAX_RATE_ID` | The 13% exclusive HST rate; printed by `npm run stripe:bootstrap -w server`. Checkout is off until it is set |
| `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_SMART` | Optional price id overrides (default: lookup keys `genius_monitoring_basic_monthly` / `genius_monitoring_smart_monthly`) |
| `STRIPE_API_VERSION` | Pinned API version; must match the webhook endpoint's version (default: the SDK's, `2025-08-27.basil`) |
| `STRIPE_TEST_CLOCKS` | Dev only: attach new customers to a test clock |
| `DOCUSIGN_ENV` | `demo` or `prod` |
| `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID` | The app, the user it acts as, and the account |
| `DOCUSIGN_PRIVATE_KEY` / `DOCUSIGN_PRIVATE_KEY_PATH` | RSA key for the JWT grant (keep the file outside the repo folder; `deploy.ps1` resets it) |
| `DOCUSIGN_CONNECT_HMAC_KEYS` | Connect HMAC secret(s), comma-separated while rotating (required in production) |
| `DOCUSIGN_REDIRECT_URI` | Redirect URI for the one-time consent link (default `${APP_URL}/settings`) |

With the Stripe or DocuSign variables blank the server still boots; those
features report *not configured* in Settings and the related buttons are
disabled.

### Setup runbook
**DocuSign**
1. In the DocuSign developer (demo) account, create an app (integration
   key), generate an RSA key pair, and add the redirect URI
   (`${APP_URL}/settings`, or `DOCUSIGN_REDIRECT_URI`). Copy the API username
   (user GUID) and account id. Put the private key file outside the repo.
2. Fill in the `DOCUSIGN_*` variables and restart. In *Settings → Agreements (DocuSign)*,
   click *Grant consent* once (signature + impersonation), then *Test connection*.
3. Connect (push updates): in DocuSign *Settings → Connect → Connect Keys*,
   add an HMAC key and put it in `DOCUSIGN_CONNECT_HMAC_KEYS`, and make sure
   HMAC signing and envelope-level Connect (`eventNotification`) are enabled
   on the account. Per-envelope HMAC only works once an account HMAC key
   exists. The app adds the per-envelope webhook only when `APP_URL` is https
   and a key is set; otherwise the poller (every 20 minutes) is the only
   status path.
4. **One-time tab check:** send a test agreement in the demo account and
   confirm the signature, name, date and package radio tabs sit where they
   should. Their offsets are `TAB_OFFSETS` in
   `server/src/services/contracts/docusign.js`; adjust there if needed. Also
   confirm the radio group can't be skipped.
5. Go live: promote the integration key, switch `DOCUSIGN_ENV=prod` and the
   ids/keys to the production account, and grant consent again.

**Stripe**
1. Set `STRIPE_SECRET_KEY` (test key first) and run
   `npm run stripe:bootstrap -w server`. It finds or creates the two
   products, the two monthly CAD prices (by lookup key) and the 13% Ontario
   HST tax rate (exclusive), and prints the ids. Put the tax rate id in
   `STRIPE_TAX_RATE_ID` (price overrides are optional). It is safe to re-run.
2. Add a webhook endpoint `${APP_URL}/api/webhooks/stripe` with the same API
   version as `STRIPE_API_VERSION`, for: `checkout.session.completed`,
   `checkout.session.expired`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed`,
   `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`,
   `invoice.voided`, `invoice.marked_uncollectible`, `charge.refunded`. Put its
   signing secret in `STRIPE_WEBHOOK_SECRET`. For local dev:
   `stripe listen --forward-to localhost:4000/api/webhooks/stripe`.
3. **Customer Portal**: nothing to configure. The app creates its own portal
   configuration (card updates and invoice history on; cancellation and plan
   switching off, since staff cancel in the app) and pins every session to it,
   so a change to the dashboard default can't let homeowners cancel.
4. Turn **off** Stripe's own customer emails for successful payments and
   upcoming renewals (the app sends its own, so the toggles work).
5. *Subscriptions → Manage failed payments*: Smart Retries, then mark the
   subscription **unpaid** when retries run out.
6. Set the HST number in Stripe's invoice settings and in
   `HST_REGISTRATION_NUMBER`.
7. *Settings → Payments (Stripe) → Test connection* checks the key and the catalog. Checkout is
   blocked (and the boot log warns) whenever Stripe's prices or tax rate
   differ from `server/src/services/contracts/pricing.js`.

**Backups.** Signed agreements, certificates and the contract history now
live in MongoDB (`contractdocuments`, `alarmcontracts`, `contractevents`).
They are legal records: include the database in backups.

## Branch
Work lives on `claude/mern-appointment-booking-app-sxX2C`.
