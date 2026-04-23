import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { upsertEvent } from "../../lib/calendly";

export const webhooksRouter = Router();

webhooksRouter.post("/calendly", async (req, res) => {
  const body = req.body as {
    event?: string;
    payload?: {
      email?: string;
      scheduled_event?: { uri?: string; start_time?: string; status?: string };
    };
  };

  const uri = body.payload?.scheduled_event?.uri;
  const email = body.payload?.email;
  const start = body.payload?.scheduled_event?.start_time;
  const rawStatus = body.payload?.scheduled_event?.status ?? "active";

  if (!uri || !email || !start) {
    res.status(400).json({ error: "Missing fields" });
    return;
  }

  const status =
    body.event === "invitee.canceled" || rawStatus.toUpperCase() === "CANCELED"
      ? "CANCELED"
      : "ACTIVE";

  await upsertEvent({
    eventUri: uri,
    inviteeEmail: email,
    startTime: new Date(start),
    status,
  });
  res.json({ ok: true });
});

webhooksRouter.post("/twilio", async (req, res) => {
  const sid = req.body?.MessageSid;
  const status = req.body?.MessageStatus;
  if (!sid || !status) {
    res.json({ ok: true });
    return;
  }

  const map: Record<string, string> = {
    delivered: "DELIVERED",
    failed: "FAILED",
    undelivered: "FAILED",
    sent: "SENT",
  };
  const mapped = map[String(status).toLowerCase()];
  if (!mapped) {
    res.json({ ok: true });
    return;
  }

  await prisma.messageLog.updateMany({
    where: { providerId: String(sid) },
    data: { status: mapped },
  });
  res.json({ ok: true });
});
