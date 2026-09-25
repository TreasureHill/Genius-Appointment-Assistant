const sender = require('./senderWorker');
const reminders = require('./reminderScheduler');
const calendly = require('./calendlyPoller');
const completion = require('./appointmentCompletionTracker');
const stuckCall = require('./stuckCallJanitor');
const callQueue = require('./callQueueWorker');
const reviewSync = require('./reviewSyncWorker');

function startWorkers() {
  sender.start();
  reminders.start();
  calendly.start();
  completion.start();
  stuckCall.start();
  callQueue.start();
  reviewSync.start();
}

module.exports = { startWorkers };
