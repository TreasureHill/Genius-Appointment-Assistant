import { listRecentEvents } from "@/lib/calendly";

export async function runCalendlyReconcile() {
  try {
    const res = await listRecentEvents(30);
    return res ?? { skipped: true };
  } catch (err) {
    console.error("[calendly-reconciler]", err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
