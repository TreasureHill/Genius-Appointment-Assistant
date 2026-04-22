import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/api";
import { enqueueCampaign } from "@/lib/outbox";

const Body = z.object({
  lotIds: z.array(z.string()).min(1),
  channels: z.array(z.enum(["EMAIL", "SMS"])).min(1),
  emailTemplateId: z.string().optional(),
  smsTemplateId: z.string().optional(),
});

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const data = Body.parse(await req.json());
  const enqueued = await enqueueCampaign(data);
  return NextResponse.json({ enqueued });
}
