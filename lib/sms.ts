import Twilio from "twilio";
import { getSetting, type TwilioSettings } from "./settings";

export { smsSegments } from "./sms-segments";

let cachedClient: { key: string; client: Twilio.Twilio; from: string } | null = null;

async function getClient() {
  const cfg = await getSetting<TwilioSettings>("twilio");
  if (!cfg?.accountSid) return null;
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
  const c = await getClient();
  if (!c) throw new Error("Twilio not configured");
  const msg = await c.client.messages.create({
    from: c.from,
    to: args.to,
    body: args.body,
  });
  return { id: msg.sid };
}

