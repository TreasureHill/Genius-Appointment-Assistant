import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/api";
import { getSetting, setSetting } from "@/lib/settings";

const Body = z.object({
  key: z.enum(["smtp", "twilio", "calendly", "pacing"]),
  value: z.unknown(),
});

export async function GET() {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const [smtp, twilio, calendly, pacing] = await Promise.all([
    getSetting("smtp"),
    getSetting("twilio"),
    getSetting("calendly"),
    getSetting("pacing"),
  ]);
  const redact = <T extends Record<string, unknown> | null>(obj: T, fields: string[]): T => {
    if (!obj) return obj;
    const out: Record<string, unknown> = { ...obj };
    for (const f of fields) if (out[f]) out[f] = "********";
    return out as T;
  };
  return NextResponse.json({
    smtp: redact(smtp as Record<string, unknown> | null, ["pass"]),
    twilio: redact(twilio as Record<string, unknown> | null, ["authToken"]),
    calendly: redact(calendly as Record<string, unknown> | null, ["token"]),
    pacing,
  });
}

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const { key, value } = Body.parse(await req.json());

  if (key !== "pacing" && value && typeof value === "object") {
    const current = (await getSetting<Record<string, unknown>>(key)) ?? {};
    const incoming = value as Record<string, unknown>;
    const secrets = key === "smtp" ? ["pass"] : key === "twilio" ? ["authToken"] : key === "calendly" ? ["token"] : [];
    for (const f of secrets) {
      if (incoming[f] === "********" || incoming[f] === undefined) {
        incoming[f] = current[f];
      }
    }
    await setSetting(key, incoming);
  } else {
    await setSetting(key, value);
  }
  return NextResponse.json({ ok: true });
}
