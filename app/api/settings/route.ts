import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/api";
import { getPacing, setSetting } from "@/lib/settings";
import { providerStatus } from "@/lib/env";

const Body = z.object({
  key: z.literal("pacing"),
  value: z.object({
    minSec: z.number().int().min(0),
    maxSec: z.number().int().min(0),
    dailyCapPerDomain: z.number().int().min(0),
  }),
});

export async function GET() {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  return NextResponse.json({
    providers: providerStatus(),
    pacing: await getPacing(),
  });
}

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const { key, value } = Body.parse(await req.json());
  await setSetting(key, value);
  return NextResponse.json({ ok: true });
}
