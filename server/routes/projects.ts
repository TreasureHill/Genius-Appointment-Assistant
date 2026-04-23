import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../auth";
import { multiEventEmails } from "../../lib/calendly";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const Create = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  reminderIntervalDays: z.number().int().min(0).max(365).optional(),
  maxReminders: z.number().int().min(0).max(50).optional(),
});

const Update = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  reminderIntervalDays: z.number().int().min(0).max(365).optional(),
  maxReminders: z.number().int().min(0).max(50).optional(),
  defaultEmailTemplateId: z.string().nullable().optional(),
  defaultSmsTemplateId: z.string().nullable().optional(),
});

projectsRouter.get("/", async (_req, res) => {
  const projects = await prisma.project.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { lots: true } } },
  });
  res.json(projects);
});

projectsRouter.post("/", async (req, res) => {
  const body = Create.parse(req.body);
  const project = await prisma.project.create({ data: body });
  res.status(201).json(project);
});

projectsRouter.get("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { lots: { include: { buyers: true, assignedRep: true }, orderBy: { lotNumber: "asc" } } },
  });
  if (!project) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(project);
});

projectsRouter.patch("/:id", async (req, res) => {
  const body = Update.parse(req.body);
  const project = await prisma.project.update({ where: { id: req.params.id }, data: body });
  res.json(project);
});

projectsRouter.delete("/:id", async (req, res) => {
  await prisma.project.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

projectsRouter.get("/dashboard/summary", async (_req, res) => {
  const now = new Date();
  const d1 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [e1, e7, e30, s1, s7, s30, failed30, outbox, pending, booked30] = await Promise.all([
    prisma.messageLog.count({ where: { channel: "EMAIL", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d1 } } }),
    prisma.messageLog.count({ where: { channel: "EMAIL", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d7 } } }),
    prisma.messageLog.count({ where: { channel: "EMAIL", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d30 } } }),
    prisma.messageLog.count({ where: { channel: "SMS", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d1 } } }),
    prisma.messageLog.count({ where: { channel: "SMS", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d7 } } }),
    prisma.messageLog.count({ where: { channel: "SMS", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d30 } } }),
    prisma.messageLog.count({ where: { status: "FAILED", createdAt: { gte: d30 } } }),
    prisma.outboxItem.count(),
    prisma.outboxItem.count({ where: { readyAt: { lte: now } } }),
    prisma.lot.count({ where: { status: "BOOKED", updatedAt: { gte: d30 } } }),
  ]);

  const projects = await prisma.project.findMany({
    include: { lots: true },
    orderBy: { name: "asc" },
  });
  const perProject = projects.map((p) => ({
    id: p.id,
    name: p.name,
    total: p.lots.length,
    scheduled: p.lots.filter((l) => l.status === "SCHEDULED").length,
    booked: p.lots.filter((l) => l.status === "BOOKED").length,
    pending: p.lots.filter((l) => !["BOOKED", "SCHEDULED"].includes(l.status)).length,
  }));

  const multi = await multiEventEmails();

  res.json({
    counts: { e1, e7, e30, s1, s7, s30, failed30, outbox, pending, booked30 },
    perProject,
    multiEventEmails: multi,
  });
});
