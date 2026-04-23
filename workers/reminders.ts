import { prisma } from "../lib/prisma";
import { enqueueForBuyer } from "../lib/outbox";

/**
 * Enqueue the next reminder for every lot that is due. Increment reminderCount
 * and set lastContactedAt at enqueue time so we do not re-pick the same lot
 * while the outbox is draining.
 */
export async function runReminderTick(): Promise<{ lotsTouched: number; enqueued: number }> {
  const now = new Date();
  const projects = await prisma.project.findMany();
  let lotsTouched = 0;
  let enqueued = 0;

  for (const project of projects) {
    const cutoff = new Date(now.getTime() - project.reminderIntervalDays * 24 * 60 * 60 * 1000);
    const lots = await prisma.lot.findMany({
      where: {
        projectId: project.id,
        status: { notIn: ["SCHEDULED", "BOOKED", "OPTED_OUT"] },
        reminderCount: { lt: project.maxReminders },
        OR: [{ lastContactedAt: null }, { lastContactedAt: { lte: cutoff } }],
      },
      include: { buyers: true },
    });

    for (const lot of lots) {
      let anyEnqueued = false;
      for (const buyer of lot.buyers) {
        if (project.defaultEmailTemplateId && buyer.email) {
          const id = await enqueueForBuyer({
            lotId: lot.id,
            buyerId: buyer.id,
            channel: "EMAIL",
            templateId: project.defaultEmailTemplateId,
          });
          if (id) {
            enqueued++;
            anyEnqueued = true;
          }
        }
        if (project.defaultSmsTemplateId && buyer.phone) {
          const id = await enqueueForBuyer({
            lotId: lot.id,
            buyerId: buyer.id,
            channel: "SMS",
            templateId: project.defaultSmsTemplateId,
          });
          if (id) {
            enqueued++;
            anyEnqueued = true;
          }
        }
      }
      if (anyEnqueued) {
        await prisma.lot.update({
          where: { id: lot.id },
          data: {
            reminderCount: { increment: 1 },
            lastContactedAt: now,
            status: lot.status === "NEW" ? "CONTACTED" : lot.status,
          },
        });
        lotsTouched++;
      }
    }
  }

  return { lotsTouched, enqueued };
}
