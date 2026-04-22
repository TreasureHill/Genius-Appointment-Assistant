import { prisma } from "./prisma";
import { nextReadyAt } from "./pacing";
import { renderTemplate, buildContext } from "./merge";

type EnqueueInput = {
  lotId: string;
  buyerId: string;
  templateId?: string;
  channel: "EMAIL" | "SMS";
};

export async function enqueueForBuyer(input: EnqueueInput): Promise<string | null> {
  const buyer = await prisma.buyer.findUnique({
    where: { id: input.buyerId },
    include: {
      lot: {
        include: {
          project: true,
          assignedRep: true,
        },
      },
    },
  });
  if (!buyer) return null;
  if (input.channel === "EMAIL" && !buyer.email) return null;
  if (input.channel === "SMS" && !buyer.phone) return null;

  let templateId = input.templateId;
  if (!templateId) {
    templateId =
      (input.channel === "EMAIL"
        ? buyer.lot.project.defaultEmailTemplateId
        : buyer.lot.project.defaultSmsTemplateId) ?? undefined;
  }
  if (!templateId) return null;

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) return null;

  const ctx = buildContext({
    buyer: { name: buyer.name, email: buyer.email, phone: buyer.phone, role: buyer.role },
    lot: { lotNumber: buyer.lot.lotNumber, address: buyer.lot.address, status: buyer.lot.status },
    project: { name: buyer.lot.project.name },
    rep: buyer.lot.assignedRep,
  });

  const payload =
    input.channel === "EMAIL"
      ? {
          to: buyer.email!,
          subject: renderTemplate(template.subject ?? "", ctx),
          html: renderTemplate(template.bodyHtml ?? "", ctx),
          text: renderTemplate(template.bodyText ?? "", ctx),
        }
      : {
          to: buyer.phone!,
          body: renderTemplate(template.bodyText ?? "", ctx),
        };

  const readyAt = await nextReadyAt();
  const item = await prisma.outboxItem.create({
    data: {
      lotId: buyer.lotId,
      buyerId: buyer.id,
      channel: input.channel,
      templateId: template.id,
      payload: JSON.stringify(payload),
      readyAt,
    },
  });
  return item.id;
}

/**
 * Enqueue a campaign: every buyer of every lot in the given set gets one
 * message per channel when contact info is available.
 */
export async function enqueueCampaign(args: {
  lotIds: string[];
  channels: Array<"EMAIL" | "SMS">;
  emailTemplateId?: string;
  smsTemplateId?: string;
}): Promise<number> {
  let count = 0;
  for (const lotId of args.lotIds) {
    const buyers = await prisma.buyer.findMany({ where: { lotId } });
    for (const buyer of buyers) {
      for (const channel of args.channels) {
        const tid = channel === "EMAIL" ? args.emailTemplateId : args.smsTemplateId;
        const enqueued = await enqueueForBuyer({
          lotId,
          buyerId: buyer.id,
          channel,
          templateId: tid,
        });
        if (enqueued) count++;
      }
    }
  }
  return count;
}

export async function claimDueItems(limit = 5): Promise<string[]> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const candidates = await prisma.outboxItem.findMany({
    where: {
      readyAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleCutoff } }],
    },
    orderBy: { readyAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const ids: string[] = [];
  for (const c of candidates) {
    const res = await prisma.outboxItem.updateMany({
      where: {
        id: c.id,
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleCutoff } }],
      },
      data: { lockedAt: now },
    });
    if (res.count === 1) ids.push(c.id);
  }
  return ids;
}
