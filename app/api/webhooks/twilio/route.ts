import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const form = await req.formData();
  const sid = form.get("MessageSid")?.toString();
  const status = form.get("MessageStatus")?.toString();
  if (!sid || !status) return NextResponse.json({ ok: true });

  const map: Record<string, string> = {
    delivered: "DELIVERED",
    failed: "FAILED",
    undelivered: "FAILED",
    sent: "SENT",
  };
  const mapped = map[status.toLowerCase()];
  if (!mapped) return NextResponse.json({ ok: true });

  await prisma.messageLog.updateMany({
    where: { providerId: sid },
    data: { status: mapped },
  });
  return NextResponse.json({ ok: true });
}
