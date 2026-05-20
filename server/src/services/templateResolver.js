const Project = require('../models/Project');
const Setting = require('../models/Setting');
const Template = require('../models/Template');

// Resolve the default email + sms templates for a project, walking the cascade:
//   1. Project.defaultEmailTemplate / defaultSmsTemplate (per-project override)
//   2. Setting.schedule.defaultEmailTemplate / defaultSmsTemplate (system-wide default)
//   3. Template.findOne({ type, isDefaultReminder: true }) (last-resort fallback)
// Returns plain (lean) template docs, or null per channel if nothing resolves.
async function resolveDefaultsForProject(projectId) {
  const [project, setting] = await Promise.all([
    projectId ? Project.findById(projectId).lean() : Promise.resolve(null),
    Setting.getSingleton(),
  ]);
  const sched = (setting && setting.schedule) || {};

  const emailId = (project && project.defaultEmailTemplate) || sched.defaultEmailTemplate || null;
  const smsId = (project && project.defaultSmsTemplate) || sched.defaultSmsTemplate || null;

  let emailTpl = emailId ? await Template.findById(emailId).lean() : null;
  let smsTpl = smsId ? await Template.findById(smsId).lean() : null;

  if (!emailTpl) emailTpl = await Template.findOne({ type: 'email', isDefaultReminder: true }).lean();
  if (!smsTpl) smsTpl = await Template.findOne({ type: 'sms', isDefaultReminder: true }).lean();

  return { emailTpl, smsTpl };
}

module.exports = { resolveDefaultsForProject };
