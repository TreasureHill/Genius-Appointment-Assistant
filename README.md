# Genius Appointment Assistant

An internal tool that sends paced email + SMS campaigns to homeowners to book
appointments. Built with **Express + React (Vite) + Prisma (SQLite)**, TipTap,
Twilio and Nodemailer.

## Features

- **Login** (single admin seeded from env vars — no signup).
- **Projects → Lots → Buyers** (primary / co-buyer / third) with full CRUD.
- **Rep management** with per-lot assignment and filtering.
- **Spreadsheet import/export** (xlsx). Diff-aware re-uploads (added / updated /
  skipped counters); changes to `BOOKED` lots are never overwritten.
- **HTML email editor** (TipTap WYSIWYG + raw HTML toggle) with merge tags.
- **SMS editor** with segment counter and merge tags.
- **Paced sender**: random gap between sends (configurable min / max seconds)
  plus per-domain daily caps so mail doesn't land in junk.
- **Reminder scheduler**: per-project `reminderIntervalDays` and `maxReminders`;
  stops for `SCHEDULED` / `BOOKED` / `OPTED_OUT`.
- **Manual status change**, and when a lot is marked `SCHEDULED` / `BOOKED` /
  `OPTED_OUT` any pending outbox rows for that lot are dropped.
- **Calendly integration**: webhook flips matched lots to `SCHEDULED`; a
  15-minute reconciler is a safety net for missed webhooks. Multi-event warning
  on lot detail + dashboard when a buyer email has more than one active event.
- **History** page filtering by channel, status, and project.
- **Dashboard** tiles for 24h/7d/30d email + SMS volume, outbox, failures, and
  a per-project status breakdown.

## Architecture

One Node process runs everything:

```
Express (server/)
├── REST API under /api/*
├── Cookie-based JWT auth
├── In-process crons (workers/)
│   ├── sender (every 30s)  — drains outbox with pacing + daily caps
│   ├── reminders (hourly)  — enqueues due reminders per project
│   └── calendly (15 min)   — reconciles bookings via API
├── Prisma → SQLite at ./data/app.db
└── Serves the built React SPA from dist/client
```

The React client lives in `client/` and is built by Vite into `dist/client`,
which Express serves as static files in production.

## Quick start

```bash
cp .env.example .env
# edit .env:
#   NEXTAUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
#   SMTP_* (email)
#   TWILIO_* (SMS)
#   CALENDLY_* (Calendly auto-match)

npm install --legacy-peer-deps
npx prisma db push
npm run db:seed

# Dev (hot reload, client on :5173 proxying /api to server on :3000)
npm run dev

# Production build + run (both on :3000)
npm run build
npm run start
```

Visit `http://localhost:3000` (or `:5173` in dev) and sign in with the admin
credentials from `.env`.

All provider credentials are read from `.env` at startup. The Settings page
shows which are configured and lets you send test messages; edit `.env` and
restart the app to rotate them. Pacing (gap min/max, per-domain daily cap) is
user-editable from the UI because it's operational tuning, not a secret.

## Sheet format

Download the blank template from any project detail page. Columns:

```
Project | LotNumber | Address | Status | AssignedRep
Buyer1Name | Buyer1Email | Buyer1Phone
Buyer2Name | Buyer2Email | Buyer2Phone
Buyer3Name | Buyer3Email | Buyer3Phone
```

- `Project` + `LotNumber` together key a lot. Re-importing unchanged rows is a
  no-op. Any field change triggers an update. New rows are created.
- `Status` defaults to `NEW`. Allowed: `NEW`, `CONTACTED`, `SCHEDULED`,
  `BOOKED`, `OPTED_OUT`. Lots already `BOOKED` are never overwritten.
- `AssignedRep` matches on name. Unknown names create a new rep record.

## Deployment (Windows VPS without Docker)

The repo used to ship with Docker. It doesn't anymore — a single Node process
works fine under NSSM on Windows, and under systemd on Linux.

### Windows with NSSM

```powershell
# inside the project folder, after npm install + prisma db push + db:seed + build
nssm install GeniusApp "C:\Program Files\nodejs\npm.cmd" "run start"
nssm set    GeniusApp AppDirectory "C:\path\to\Genius-Appointment-Assistant"
nssm set    GeniusApp AppStdout    ".\app.log"
nssm set    GeniusApp AppStderr    ".\app.err.log"
nssm set    GeniusApp Start        SERVICE_AUTO_START
nssm start  GeniusApp
```

Then put Caddy in front for HTTPS (see the repo history or our deployment notes
for the Caddyfile + `nssm install GeniusCaddy` commands).

### Linux with systemd

```ini
# /etc/systemd/system/genius.service
[Unit]
Description=Genius Appointment Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/genius
ExecStart=/usr/bin/npm run start
Restart=always
EnvironmentFile=/opt/genius/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now genius
```

Put Caddy/Nginx in front for TLS.

## Calendly

1. Create a personal access token + get your organisation URI. Put them in
   `.env` as `CALENDLY_TOKEN` and `CALENDLY_ORG_URI`, then restart.
2. Add a Calendly webhook pointing at `https://<your host>/api/webhooks/calendly`
   with events `invitee.created` and `invitee.canceled`.
3. When an invitee email matches a buyer, the lot flips to `SCHEDULED`.
   If one email has more than one active event, a warning badge appears on the
   dashboard and the lot detail page.

## Twilio delivery status

Point Twilio's messaging *Status callback URL* at
`https://<your host>/api/webhooks/twilio` to flip `MessageLog.status` from
`SENT` → `DELIVERED` / `FAILED`.

## Testing

```bash
npm run typecheck
npm test           # vitest: merge + sms-segments
```
