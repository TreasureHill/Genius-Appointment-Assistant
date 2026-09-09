const Project = require('../models/Project');
const Setting = require('../models/Setting');
const Template = require('../models/Template');

// Resolve the default email + sms templates for a project, walking the cascade:
//   1. Project.defaultEmailTemplate / defaultSmsTemplate (per-project override)
//   2. Setting.schedule.defaultEmailTemplate / defaultSmsTemplate (system-wide default)
//   3. Template.findOne({ type, isDefaultReminder: true }) (last-resort fallback)
// Each step is tried in turn and a step whose template no longer exists (e.g.
// the project still points at a deleted template) falls through to the next
// one instead of short-circuiting the cascade. Returns plain (lean) template
// docs, or null per channel if nothing resolves, plus where each came from.
async function resolveDefaultsForProject(projectId) {
  const [project, setting] = await Promise.all([
    projectId ? Project.findById(projectId).lean() : Promise.resolve(null),
    Setting.getSingleton(),
  ]);
  const sched = (setting && setting.schedule) || {};

  const [email, sms] = await Promise.all([
    resolveChannel('email', [
      ['project', project && project.defaultEmailTemplate],
      ['settings', sched.defaultEmailTemplate],
    ]),
    resolveChannel('sms', [
      ['project', project && project.defaultSmsTemplate],
      ['settings', sched.defaultSmsTemplate],
    ]),
  ]);

  return {
    emailTpl: email.tpl,
    smsTpl: sms.tpl,
    sources: { email: email.source, sms: sms.source },
  };
}

// Try each [source, templateId] candidate in order; the first that points at
// an existing template of the right type wins. Falls back to the
// isDefaultReminder flag when none of the explicit picks resolve.
async function resolveChannel(type, candidates) {
  for (const [source, id] of candidates) {
    if (!id) continue;
    const tpl = await Template.findOne({ _id: id, type }).lean();
    if (tpl) return { tpl, source };
  }
  const tpl = await Template.findOne({ type, isDefaultReminder: true }).lean();
  return { tpl: tpl || null, source: tpl ? 'defaultReminder' : null };
}

module.exports = { resolveDefaultsForProject };
