# Genius Appointment Assistant

An internal tool that sends paced email + SMS campaigns to homeowners to book
appointments. Built with Next.js 14, Prisma (SQLite), NextAuth, TipTap, Twilio
and Nodemailer.

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

## Quick start (dev)

```bash
cp .env.example .env
# edit .env: set NEXTAUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD

npm install
npx prisma db push
npm run db:seed

npm run dev
# open http://localhost:3000 and sign in
```

Go to **Settings** to enter SMTP, Twilio and Calendly credentials. Credentials
are stored in the database so they can be rotated without redeploying.

## Docker

```bash
docker compose up --build
```

The container runs `prisma db push`, seeds the admin user (if missing) and
starts the Next.js server. SQLite lives in the mounted `./data` volume.

## Sheet format

Download a blank template from any project detail page. The columns are:

```
Project | LotNumber | Address | Status | AssignedRep
Buyer1Name | Buyer1Email | Buyer1Phone
Buyer2Name | Buyer2Email | Buyer2Phone
Buyer3Name | Buyer3Email | Buyer3Phone
```

- `Project` and `LotNumber` together key a lot. Re-importing the same row is a
  no-op. Changing any field triggers an update. New lots are created.
- `Status` defaults to `NEW` if missing. Allowed: `NEW`, `CONTACTED`,
  `SCHEDULED`, `BOOKED`, `OPTED_OUT`. Lots already `BOOKED` are never overwritten.
- `AssignedRep` is matched on name. Unknown names create a new rep record.

## Background jobs

Three in-process crons run inside the Next.js server (started from
`instrumentation.ts`):

- **Sender** (every 30 s) drains the outbox, respecting per-message `readyAt`
  timestamps and per-domain daily caps.
- **Reminder scheduler** (hourly) finds lots due for a reminder (per-project
  interval, under `maxReminders`) and enqueues their next message per channel.
- **Calendly reconciler** (every 15 min) pulls recent events and matches invitee
  emails to buyers — belt-and-braces for the webhook.

## Calendly

1. Generate a personal access token and find your organisation URI.
2. Enter them in **Settings → Calendly**.
3. Add a webhook in Calendly pointing to
   `https://<your host>/api/webhooks/calendly` for `invitee.created` and
   `invitee.canceled` events.
4. When an invitee email matches a buyer, the lot is flipped to `SCHEDULED`.
   If one email has more than one active event, a warning badge appears.

## Twilio delivery status

Point Twilio's status callback URL at
`https://<your host>/api/webhooks/twilio` to flip `MessageLog.status` from
`SENT` to `DELIVERED` / `FAILED`.

## Testing

```bash
npm test         # unit tests for importer, merge, pacing
npm run typecheck
npm run lint
```
