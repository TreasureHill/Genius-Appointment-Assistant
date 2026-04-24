const sender = require('./senderWorker');
const reminders = require('./reminderScheduler');
const calendly = require('./calendlyPoller');

function startWorkers() {
  sender.start();
  reminders.start();
  calendly.start();
}

module.exports = { startWorkers };
