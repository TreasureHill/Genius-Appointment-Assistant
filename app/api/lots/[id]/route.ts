import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const STATUS = z.enum(["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"]);

const BuyerIn = z.object({
  id: z.string().optional(),
  role: z.enum(["PRIMARY", "CO_BUYER", "THIRD"]),
  name: z.string().min(1),
  email: z.string().email().nullable().optional().or(z.literal("")),
  phone: z.string().nullable().optional().or(z.literal("")),
});

const Update = z.object({
  lotNumber: z.string().min(1).optional(),
  address: z.string().nullable().optional(),
  status: STATUS.optional(),
  assignedRepId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reminderCount: z.number().int().min(0).optional(),
  buyers: z.array(BuyerIn).optional(),
});

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;

  const body = Update.parse(await req.json());
  const { buyers, ...lotData } = body;

  await prisma.lot.update({
    where: { id: params.id },
    data: {
      ...lotData,
      assignedRepId: lotData.assignedRepId === "" ? null : lotData.assignedRepId,
    },
  });

  if (buyers) {
    await prisma.buyer.deleteMany({ where: { lotId: params.id } });
    await prisma.buyer.createMany({
      data: buyers.map((b) => ({
        lotId: params.id,
        role: b.role,
        name: b.name,
        email: b.email || null,
        phone: b.phone || null,
      })),
    });
  }

  const lot = await prisma.lot.findUnique({
    where: { id: params.id },
    include: { buyers: true, assignedRep: true, project: true },
  });
  return NextResponse.json(lot);
}

export async function DELETE(_: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  await prisma.lot.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
