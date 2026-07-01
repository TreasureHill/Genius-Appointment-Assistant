const sender = require('./senderWorker');
const reminders = require('./reminderScheduler');
const calendly = require('./calendlyPoller');
const completion = require('./appointmentCompletionTracker');
const stuckCall = require('./stuckCallJanitor');
const callQueue = require('./callQueueWorker');

function startWorkers() {
  sender.start();
  reminders.start();
  calendly.start();
  completion.start();
  stuckCall.start();
  callQueue.start();
}

module.exports = { startWorkers };
