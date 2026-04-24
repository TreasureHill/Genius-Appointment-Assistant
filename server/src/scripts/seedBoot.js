const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Template = require('../models/Template');
const env = require('../config/env');

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

module.exports = { seedAdmin, seedStarterTemplates };
