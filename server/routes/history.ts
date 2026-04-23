import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../auth";

export const historyRouter = Router();
historyRouter.use(requireAuth);

historyRouter.get("/", async (req, res) => {
  const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const project = typeof req.query.project === "string" ? req.query.project : undefined;

  const logs = await prisma.messageLog.findMany({
    where: {
      channel: channel || undefined,
      status: status || undefined,
      lot: project ? { projectId: project } : undefined,
    },
    include: { buyer: true, lot: { include: { project: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(logs);
});
