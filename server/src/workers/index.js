const sender = require('./senderWorker');
const reminders = require('./reminderScheduler');
const calendly = require('./calendlyPoller');
const completion = require('./appointmentCompletionTracker');

function startWorkers() {
  sender.start();
  reminders.start();
  calendly.start();
  completion.start();
}

module.exports = { startWorkers };
