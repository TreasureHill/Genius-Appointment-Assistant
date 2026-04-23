import Twilio from "twilio";
import { twilioEnv } from "./env";

export { smsSegments } from "./sms-segments";

let cachedClient: { key: string; client: Twilio.Twilio; from: string } | null = null;

function getClient() {
  const cfg = twilioEnv();
  if (!cfg) return null;
  const key = JSON.stringify(cfg);
  if (!cachedClient || cachedClient.key !== key) {
    cachedClient = {
      key,
      client: Twilio(cfg.accountSid, cfg.authToken),
      from: cfg.fromNumber,
    };
  }
  return cachedClient;
}

export async function sendSms(args: { to: string; body: string }): Promise<{ id?: string }> {
  const c = getClient();
  if (!c) throw new Error("Twilio not configured (set TWILIO_* in .env)");
  const msg = await c.client.messages.create({
    from: c.from,
    to: args.to,
    body: args.body,
  });
  return { id: msg.sid };
}
