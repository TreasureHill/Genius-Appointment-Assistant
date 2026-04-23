import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../auth";

export const repsRouter = Router();
repsRouter.use(requireAuth);

const Create = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
});

const Update = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  phone: z.string().nullable().optional().or(z.literal("")),
  active: z.boolean().optional(),
});

repsRouter.get("/", async (_req, res) => {
  const reps = await prisma.rep.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { lots: true } } },
  });
  res.json(reps);
});

repsRouter.post("/", async (req, res) => {
  const data = Create.parse(req.body);
  const rep = await prisma.rep.create({
    data: { name: data.name, email: data.email || null, phone: data.phone || null },
  });
  res.status(201).json(rep);
});

repsRouter.patch("/:id", async (req, res) => {
  const body = Update.parse(req.body);
  const rep = await prisma.rep.update({
    where: { id: req.params.id },
    data: {
      ...body,
      email: body.email === "" ? null : body.email,
      phone: body.phone === "" ? null : body.phone,
    },
  });
  res.json(rep);
});

repsRouter.delete("/:id", async (req, res) => {
  await prisma.lot.updateMany({ where: { assignedRepId: req.params.id }, data: { assignedRepId: null } });
  await prisma.rep.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
