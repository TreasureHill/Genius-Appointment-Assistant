import cron from "node-cron";
import { drainOutbox } from "./sender";
import { runReminderTick } from "./reminders";
import { runCalendlyReconcile } from "./calendly-reconciler";

let started = false;

export function startWorkers() {
  if (started) return;
  started = true;

  cron.schedule("*/30 * * * * *", async () => {
    try {
      await drainOutbox();
    } catch (err) {
      console.error("[sender]", err);
    }
  });

  cron.schedule("0 * * * *", async () => {
    try {
      const res = await runReminderTick();
      console.log("[reminders]", res);
    } catch (err) {
      console.error("[reminders]", err);
    }
  });

  cron.schedule("*/15 * * * *", async () => {
    try {
      const res = await runCalendlyReconcile();
      console.log("[calendly]", res);
    } catch (err) {
      console.error("[calendly]", err);
    }
  });

  console.log("[workers] started");
}
