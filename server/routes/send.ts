import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { enqueueCampaign } from "../../lib/outbox";

export const sendRouter = Router();
sendRouter.use(requireAuth);

const Body = z.object({
  lotIds: z.array(z.string()).min(1),
  channels: z.array(z.enum(["EMAIL", "SMS"])).min(1),
  emailTemplateId: z.string().optional(),
  smsTemplateId: z.string().optional(),
});

sendRouter.post("/", async (req, res) => {
  const data = Body.parse(req.body);
  const enqueued = await enqueueCampaign(data);
  res.json({ enqueued });
});
