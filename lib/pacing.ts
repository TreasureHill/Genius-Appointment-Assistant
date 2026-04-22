import { prisma } from "./prisma";
import { getPacing } from "./settings";

function jitter(minSec: number, maxSec: number): number {
  const min = Math.max(0, Math.min(minSec, maxSec));
  const max = Math.max(minSec, maxSec);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Return a timestamp for the next send slot. A persisted "pacing.cursor" setting
 * accumulates so bulk-enqueues stagger across minutes/hours instead of firing
 * all at once.
 */
export async function nextReadyAt(): Promise<Date> {
  const pacing = await getPacing();
  const now = Date.now();

  const cursorRow = await prisma.setting.findUnique({ where: { key: "pacing.cursor" } });
  const cursor = cursorRow ? Number(cursorRow.value) : 0;
  const base = Math.max(now, cursor);

  const gapMs = jitter(pacing.minSec, pacing.maxSec) * 1000;
  const ready = base + gapMs;

  await prisma.setting.upsert({
    where: { key: "pacing.cursor" },
    update: { value: String(ready) },
    create: { key: "pacing.cursor", value: String(ready) },
  });

  return new Date(ready);
}

export async function resetCursor(): Promise<void> {
  await prisma.setting.delete({ where: { key: "pacing.cursor" } }).catch(() => {});
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}
