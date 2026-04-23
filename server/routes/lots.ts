import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../auth";

export const lotsRouter = Router();
lotsRouter.use(requireAuth);

const STATUS = z.enum(["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"]);

const BuyerIn = z.object({
  id: z.string().optional(),
  role: z.enum(["PRIMARY", "CO_BUYER", "THIRD"]),
  name: z.string().min(1),
  email: z.string().email().nullable().optional().or(z.literal("")),
  phone: z.string().nullable().optional().or(z.literal("")),
});

const Update = z.object({
  lotNumber: z.string().min(1).optional(),
  address: z.string().nullable().optional(),
  status: STATUS.optional(),
  assignedRepId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reminderCount: z.number().int().min(0).optional(),
  buyers: z.array(BuyerIn).optional(),
});

lotsRouter.get("/:id", async (req, res) => {
  const lot = await prisma.lot.findUnique({
    where: { id: req.params.id },
    include: {
      project: true,
      buyers: true,
      assignedRep: true,
      messageLogs: {
        include: { buyer: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      },
      calendlyEvents: { orderBy: { startTime: "desc" } },
    },
  });
  if (!lot) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const buyerEmails = lot.buyers.map((b) => (b.email ?? "").toLowerCase()).filter(Boolean);
  const grouped = await prisma.calendlyEvent.groupBy({
    by: ["inviteeEmail"],
    where: { status: "ACTIVE", inviteeEmail: { in: buyerEmails } },
    _count: { _all: true },
  });
  const multiEventWarnings = grouped
    .filter((g) => g._count._all > 1)
    .map((g) => ({ email: g.inviteeEmail, count: g._count._all }));

  res.json({ ...lot, multiEventWarnings });
});

lotsRouter.patch("/:id", async (req, res) => {
  const body = Update.parse(req.body);
  const { buyers, ...lotData } = body;

  await prisma.lot.update({
    where: { id: req.params.id },
    data: {
      ...lotData,
      assignedRepId: lotData.assignedRepId === "" ? null : lotData.assignedRepId,
    },
  });

  if (buyers) {
    await prisma.buyer.deleteMany({ where: { lotId: req.params.id } });
    await prisma.buyer.createMany({
      data: buyers.map((b) => ({
        lotId: req.params.id,
        role: b.role,
        name: b.name,
        email: b.email || null,
        phone: b.phone || null,
      })),
    });
  }

  const lot = await prisma.lot.findUnique({
    where: { id: req.params.id },
    include: { buyers: true, assignedRep: true, project: true },
  });
  res.json(lot);
});

lotsRouter.delete("/:id", async (req, res) => {
  await prisma.lot.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

lotsRouter.post("/:id/status", async (req, res) => {
  const { status } = z.object({ status: STATUS }).parse(req.body);
  const lot = await prisma.lot.update({
    where: { id: req.params.id },
    data: {
      status,
      scheduledAt: status === "SCHEDULED" ? new Date() : undefined,
    },
  });
  if (status === "BOOKED" || status === "SCHEDULED" || status === "OPTED_OUT") {
    await prisma.outboxItem.deleteMany({ where: { lotId: lot.id } });
  }
  res.json(lot);
});
