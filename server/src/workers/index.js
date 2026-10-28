const sender = require('./senderWorker');
const reminders = require('./reminderScheduler');
const calendly = require('./calendlyPoller');
const completion = require('./appointmentCompletionTracker');
const stuckCall = require('./stuckCallJanitor');
const callQueue = require('./callQueueWorker');
const reviewSync = require('./reviewSyncWorker');
// Alarm monitoring contracts. Each start() is a logged no-op while its
// integration (DocuSign / Stripe) isn't configured, so boot never depends on them.
const docusignPoller = require('./docusignPoller');
const paymentReminders = require('./paymentReminderWorker');
const stripeReconciler = require('./stripeReconciler');
// Needs neither integration: retries welcome emails and paper completion tails.
const contractTail = require('./contractTailWorker');

function startWorkers() {
  sender.start();
  reminders.start();
  calendly.start();
  completion.start();
  stuckCall.start();
  callQueue.start();
  reviewSync.start();
  docusignPoller.start();
  paymentReminders.start();
  stripeReconciler.start();
  contractTail.start();
}

module.exports = { startWorkers };
