const sender = require('./senderWorker');
const reminders = require('./reminderScheduler');
const calendly = require('./calendlyPoller');
const completion = require('./appointmentCompletionTracker');
const stuckCall = require('./stuckCallJanitor');
const callQueue = require('./callQueueWorker');
const reviewSync = require('./reviewSyncWorker');
const mailSync = require('./mailSyncWorker');

function startWorkers() {
  sender.start();
  reminders.start();
  calendly.start();
  completion.start();
  stuckCall.start();
  callQueue.start();
  reviewSync.start();
  mailSync.start();
}

module.exports = { startWorkers };
