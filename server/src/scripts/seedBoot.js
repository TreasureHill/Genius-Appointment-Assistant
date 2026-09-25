const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Template = require('../models/Template');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const Rep = require('../models/Rep');
const env = require('../config/env');
const { resolveScheduleTimezone } = require('../services/sendWindow');
const { replanPendingOutbox } = require('../services/outboxPlanner');

async function migrateBookedToScheduled() {
  // 'booked' was an early redundant status; it now collapses into 'scheduled'.
  const result = await Lot.collection.updateMany(
    { status: 'booked' },
    { $set: { status: 'scheduled' } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[migration] flipped ${result.modifiedCount} 'booked' lots to 'scheduled'`);
  }
}

// Retire stale Calendly warnings on lots:
//   - the "Auto-matched by <method> — verify" notice is no longer raised at all
//   - a duplicate-booking warning is moot once the lot is completed / opted out
//     or its appointment has already passed
async function migrateCalendlyWarnings() {
  const now = new Date();
  const autoMatch = await Lot.collection.updateMany(
    { calendlyWarning: /^Auto-matched by/ },
    { $set: { calendlyWarning: '' } }
  );
  const stale = await Lot.collection.updateMany(
    {
      calendlyWarning: { $ne: '' },
      $or: [
        { status: { $in: ['completed', 'opted_out'] } },
        { 'calendlyEvent.endTime': { $ne: null, $lte: now } },
        { 'calendlyEvent.endTime': null, 'calendlyEvent.startTime': { $ne: null, $lte: now } },
      ],
    },
    { $set: { calendlyWarning: '' } }
  );
  const n = (autoMatch.modifiedCount || 0) + (stale.modifiedCount || 0);
  if (n > 0) console.log(`[migration] cleared ${n} stale Calendly warning(s)`);
}

// Send windows used to be evaluated on the server's clock. They now live in an
// explicit timezone (Settings → Sending schedule). The first boot after that
// change pins the zone (Aria's zone, else Eastern) and re-plans anything still
// queued so a "9 AM" window really means 9 AM for the owner. Runs once: the
// timezone field is non-empty afterwards.
async function migrateScheduleTimezone() {
  const setting = await Setting.getSingleton();
  if (setting.schedule && setting.schedule.timezone) return;
  const timezone = resolveScheduleTimezone(setting);
  setting.schedule = setting.schedule || {};
  setting.schedule.timezone = timezone;
  await setting.save();
  const r = await replanPendingOutbox();
  console.log(
    `[migration] send windows are now evaluated in ${timezone}; re-planned ${r.moved} of ${r.total} queued message(s)`
  );
}

async function seedAdmin() {
  const count = await User.countDocuments();
  if (count > 0) return;
  const passwordHash = await bcrypt.hash(env.admin.pass, 10);
  await User.create({ username: env.admin.user.toLowerCase(), passwordHash, role: 'admin' });
  console.log(`[seed] created admin user "${env.admin.user}"`);
}

async function seedStarterTemplates() {
  if ((await Template.countDocuments()) > 0) return;
  await Template.create([
    {
      name: 'Default reminder (email)',
      type: 'email',
      subject: 'Reminder: schedule your appointment at {{lot.address}}',
      bodyHtml: `<p>Hi {{buyer.firstName}},</p>
<p>This is a friendly reminder to book your appointment for <strong>Lot {{lot.number}}</strong>
at {{lot.address}}. You can pick a time here:
{{#if owner.calendlyUrl}}<a href="{{owner.calendlyUrl}}">{{owner.calendlyUrl}}</a>{{else}}please reply to this email{{/if}}.</p>
<p>Thanks,<br/>{{owner.name}}</p>`,
      bodyText: 'Hi {{buyer.firstName}}, reminder to book your appointment for Lot {{lot.number}} at {{lot.address}}.',
      isDefaultReminder: true,
    },
    {
      name: 'Default reminder (sms)',
      type: 'sms',
      subject: '',
      bodyText: 'Hi {{buyer.firstName}}, this is {{owner.name}} — reminder to schedule your appointment for Lot {{lot.number}}. {{owner.calendlyUrl}}',
      bodyHtml: '',
      isDefaultReminder: true,
    },
  ]);
  console.log('[seed] inserted starter templates');
}

// The Reviews tab credits Google reviews to our reps by the names / nicknames
// reviewers use. Start with the Genius technicians the weekly deck tracked;
// everything is editable in the Reviews tab (Reps & matching).
const DEFAULT_REPS = [
  { name: 'Jason', aliases: ['jason', 'jeson'] },
  { name: 'Salman', aliases: ['salman', 'solman', 'syed', 'syed salman', 'syedsalman'] },
  { name: 'Alvee', aliases: ['alvee', 'alvi', 'alvy'] },
];

async function seedReviewReps() {
  if ((await Rep.countDocuments()) > 0) return;
  await Rep.create(
    DEFAULT_REPS.map((r, i) => ({
      name: r.name,
      aliases: Rep.normalizeAliases(r.name, r.aliases),
      color: Rep.COLORS[i % Rep.COLORS.length],
      sortOrder: i,
    }))
  );
  console.log(`[seed] inserted ${DEFAULT_REPS.length} reps for the Reviews tab`);
}

module.exports = {
  seedAdmin,
  seedStarterTemplates,
  seedReviewReps,
  migrateBookedToScheduled,
  migrateCalendlyWarnings,
  migrateScheduleTimezone,
};
