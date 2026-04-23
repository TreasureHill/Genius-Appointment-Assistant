import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../auth";

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

const Create = z.object({
  type: z.enum(["EMAIL", "SMS"]),
  name: z.string().min(1),
  subject: z.string().optional(),
  bodyHtml: z.string().optional(),
  bodyText: z.string().default(""),
});

const Update = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().optional().nullable(),
  bodyHtml: z.string().optional().nullable(),
  bodyText: z.string().optional(),
});

templatesRouter.get("/", async (_req, res) => {
  const list = await prisma.template.findMany({ orderBy: { updatedAt: "desc" } });
  res.json(list);
});

templatesRouter.post("/", async (req, res) => {
  const data = Create.parse(req.body);
  const created = await prisma.template.create({ data });
  res.status(201).json(created);
});

templatesRouter.get("/:id", async (req, res) => {
  const t = await prisma.template.findUnique({ where: { id: req.params.id } });
  if (!t) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(t);
});

templatesRouter.patch("/:id", async (req, res) => {
  const data = Update.parse(req.body);
  const updated = await prisma.template.update({ where: { id: req.params.id }, data });
  res.json(updated);
});

templatesRouter.delete("/:id", async (req, res) => {
  await prisma.template.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
