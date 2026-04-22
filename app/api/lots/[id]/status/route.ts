import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const Body = z.object({
  status: z.enum(["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"]),
});

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const { status } = Body.parse(await req.json());

  const lot = await prisma.lot.update({
    where: { id: params.id },
    data: {
      status,
      scheduledAt: status === "SCHEDULED" ? new Date() : undefined,
    },
  });

  if (status === "BOOKED" || status === "SCHEDULED" || status === "OPTED_OUT") {
    await prisma.outboxItem.deleteMany({ where: { lotId: lot.id } });
  }

  return NextResponse.json(lot);
}
