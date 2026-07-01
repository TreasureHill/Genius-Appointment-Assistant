const sender = require('./senderWorker');
const reminders = require('./reminderScheduler');
const calendly = require('./calendlyPoller');
const completion = require('./appointmentCompletionTracker');
const stuckCall = require('./stuckCallJanitor');

function startWorkers() {
  sender.start();
  reminders.start();
  calendly.start();
  completion.start();
  stuckCall.start();
}

module.exports = { startWorkers };
