/**
 * READ-ONLY diagnostic: why is each queued Calendly invitee unmatched?
 *
 * Writes nothing. For every 'unmatched' queue row, checks the invitee's email
 * against every lot buyer in the database and reports one of:
 *   EXACT MATCH   — email IS on a lot (the fix script would map this; if you
 *                   see this, something else is wrong — tell me).
 *   NEAR MISS     — same email once whitespace/case is stripped, or a buyer
 *                   with a matching NAME but a different email (likely a typo
 *                   in one of the two systems — shown side by side).
 *   NOT IN DB     — no buyer has this email or name; nothing to match.
 *
 * Use this to sanity-check a fix:calendly dry-run before applying it.
 *
 * Usage:
 *   node src/scripts/checkCalendlyEmails.js
 *   npm run check:calendly
 */
require('../config/env');
const { connect, mongoose } = require('../config/db');
const Lot = require('../models/Lot');
require('../models/Project');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');

const compactEmail = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const compactName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Invitee name tokens (>=2 chars) for the name-based near-miss check.
function nameParts(row) {
  const src = [row.inviteeFirstName, row.inviteeLastName].filter(Boolean).join(' ') || row.inviteeName || '';
  return src.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 2);
}

async function main() {
  await connect();

  const rows = await CalendlyUnmatch.find({ status: 'unmatched' }).sort({ eventStartTime: 1 }).lean();
  const lots = await Lot.find({}).populate('project', 'name').lean();

  // Index every buyer: exact email, compacted email, compacted name.
  const byEmail = new Map();
  const byCompactEmail = new Map();
  const buyerList = [];
  for (const lot of lots) {
    for (const b of lot.buyers || []) {
      const where = `${lot.project?.name || '?'} / Lot ${lot.lotNumber} (${b.role}, lot status: ${lot.status})`;
      const entry = { email: b.email || '', name: b.name || '', where };
      buyerList.push(entry);
      const exact = String(b.email || '').toLowerCase().trim();
      if (exact) {
        if (!byEmail.has(exact)) byEmail.set(exact, []);
        byEmail.get(exact).push(entry);
        const comp = compactEmail(b.email);
        if (!byCompactEmail.has(comp)) byCompactEmail.set(comp, []);
        byCompactEmail.get(comp).push(entry);
      }
    }
  }

  console.log(
    `Checking ${rows.length} unmatched queue row(s) against ${lots.length} lot(s) / ${buyerList.length} buyer(s)\n`
  );

  const now = Date.now();
  const counts = { exact: 0, near: 0, none: 0 };

  for (const row of rows) {
    const email = String(row.inviteeEmail || '').toLowerCase().trim();
    const when = row.eventStartTime
      ? `${new Date(row.eventStartTime).toISOString().slice(0, 16).replace('T', ' ')}${new Date(row.eventStartTime).getTime() <= now ? ' (past)' : ' (upcoming)'}`
      : 'no date';
    const head = `${email}  [${row.inviteeName || '?'}]  event ${when}  answer: "${row.answer || ''}"`;

    const exact = byEmail.get(email);
    if (exact && exact.length) {
      counts.exact += 1;
      console.log(`✅ EXACT MATCH  ${head}`);
      for (const e of exact) console.log(`      → ${e.where}`);
      continue;
    }

    const nearLines = [];
    const comp = byCompactEmail.get(compactEmail(email));
    if (comp && comp.length) {
      for (const e of comp) nearLines.push(`email matches after stripping spaces: "${e.email}" on ${e.where}`);
    }
    const parts = nameParts(row);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      for (const b of buyerList) {
        const bn = compactName(b.name);
        if (bn && bn.includes(first) && bn.includes(last)) {
          nearLines.push(`buyer NAME matches ("${b.name}") but email differs: DB has "${b.email || '(no email)'}" on ${b.where}`);
        }
      }
    }

    if (nearLines.length) {
      counts.near += 1;
      console.log(`⚠️  NEAR MISS   ${head}`);
      for (const l of [...new Set(nearLines)].slice(0, 5)) console.log(`      → ${l}`);
    } else {
      counts.none += 1;
      console.log(`✖  NOT IN DB   ${head}`);
    }
  }

  console.log('\n──────── Summary ────────');
  console.log(`Exact email matches:   ${counts.exact}   (fix:calendly should map these)`);
  console.log(`Near misses:           ${counts.near}   (typo/name-only — map manually in the UI)`);
  console.log(`Not in DB at all:      ${counts.none}   (nothing to match — stale or never imported)`);
  console.log('\n(Read-only — nothing was written.)');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Check failed:', err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
