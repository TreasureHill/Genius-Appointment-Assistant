import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { getPacing, setSetting } from "../../lib/settings";
import { providerStatus } from "../../lib/env";
import { sendEmail } from "../../lib/mailer";
import { sendSms } from "../../lib/sms";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const PacingBody = z.object({
  key: z.literal("pacing"),
  value: z.object({
    minSec: z.number().int().min(0),
    maxSec: z.number().int().min(0),
    dailyCapPerDomain: z.number().int().min(0),
  }),
});

settingsRouter.get("/", async (_req, res) => {
  res.json({
    providers: providerStatus(),
    pacing: await getPacing(),
  });
});

settingsRouter.post("/", async (req, res) => {
  const { key, value } = PacingBody.parse(req.body);
  await setSetting(key, value);
  res.json({ ok: true });
});

const TestBody = z.object({
  channel: z.enum(["EMAIL", "SMS"]),
  to: z.string().min(1),
});

settingsRouter.post("/test", async (req, res) => {
  const { channel, to } = TestBody.parse(req.body);
  try {
    if (channel === "EMAIL") {
      await sendEmail({
        to,
        subject: "Genius test email",
        html: "<p>This is a test email from Genius Appointment Assistant.</p>",
        text: "This is a test email from Genius Appointment Assistant.",
      });
    } else {
      await sendSms({ to, body: "Test SMS from Genius Appointment Assistant" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
