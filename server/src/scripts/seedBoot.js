const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Template = require('../models/Template');
const Lot = require('../models/Lot');
const env = require('../config/env');

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

module.exports = { seedAdmin, seedStarterTemplates, migrateBookedToScheduled, migrateCalendlyWarnings };
