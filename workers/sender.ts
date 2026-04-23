import { prisma } from "../lib/prisma";
import { claimDueItems } from "../lib/outbox";
import { sendEmail } from "../lib/mailer";
import { sendSms } from "../lib/sms";
import { domainOf } from "../lib/pacing";
import { getPacing } from "../lib/settings";

const MAX_ATTEMPTS = 3;

export async function drainOutbox(): Promise<{ processed: number }> {
  const ids = await claimDueItems(5);
  if (ids.length === 0) return { processed: 0 };

  const pacing = await getPacing();
  let processed = 0;

  for (const id of ids) {
    const item = await prisma.outboxItem.findUnique({ where: { id } });
    if (!item) continue;

    try {
      const payload = JSON.parse(item.payload) as
        | { to: string; subject: string; html: string; text: string }
        | { to: string; body: string };

      if (item.channel === "EMAIL") {
        const p = payload as { to: string; subject: string; html: string; text: string };

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const todayCount = await prisma.messageLog.count({
          where: {
            channel: "EMAIL",
            status: { in: ["SENT", "DELIVERED"] },
            createdAt: { gte: startOfDay },
          },
        });
        const domain = domainOf(p.to);
        if (domain && pacing.dailyCapPerDomain > 0 && todayCount >= pacing.dailyCapPerDomain) {
          await prisma.outboxItem.update({
            where: { id },
            data: {
              readyAt: new Date(Date.now() + 60 * 60 * 1000),
              lockedAt: null,
            },
          });
          continue;
        }

        const { id: providerId } = await sendEmail({
          to: p.to,
          subject: p.subject,
          html: p.html,
          text: p.text,
        });
        await prisma.$transaction([
          prisma.messageLog.create({
            data: {
              lotId: item.lotId,
              buyerId: item.buyerId,
              channel: "EMAIL",
              templateId: item.templateId,
              subject: p.subject,
              body: p.html,
              status: "SENT",
              providerId,
              sentAt: new Date(),
            },
          }),
          prisma.outboxItem.delete({ where: { id } }),
        ]);
        processed++;
        continue;
      }

      const p = payload as { to: string; body: string };
      const { id: providerId } = await sendSms({ to: p.to, body: p.body });
      await prisma.$transaction([
        prisma.messageLog.create({
          data: {
            lotId: item.lotId,
            buyerId: item.buyerId,
            channel: "SMS",
            templateId: item.templateId,
            body: p.body,
            status: "SENT",
            providerId,
            sentAt: new Date(),
          },
        }),
        prisma.outboxItem.delete({ where: { id } }),
      ]);
      processed++;
    } catch (err) {
      const attempts = item.attempts + 1;
      const fatal = attempts >= MAX_ATTEMPTS;
      if (fatal) {
        await prisma.$transaction([
          prisma.messageLog.create({
            data: {
              lotId: item.lotId,
              buyerId: item.buyerId,
              channel: item.channel,
              templateId: item.templateId,
              body: item.payload,
              status: "FAILED",
              error: err instanceof Error ? err.message : String(err),
            },
          }),
          prisma.outboxItem.delete({ where: { id } }),
        ]);
      } else {
        await prisma.outboxItem.update({
          where: { id },
          data: {
            attempts,
            readyAt: new Date(Date.now() + 2 * 60 * 1000 * attempts),
            lockedAt: null,
          },
        });
      }
    }
  }

  return { processed };
}
