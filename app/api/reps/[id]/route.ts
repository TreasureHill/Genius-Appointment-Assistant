import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const Update = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  phone: z.string().nullable().optional().or(z.literal("")),
  active: z.boolean().optional(),
});

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const body = Update.parse(await req.json());
  const rep = await prisma.rep.update({
    where: { id: params.id },
    data: {
      ...body,
      email: body.email === "" ? null : body.email,
      phone: body.phone === "" ? null : body.phone,
    },
  });
  return NextResponse.json(rep);
}

export async function DELETE(_: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  await prisma.lot.updateMany({ where: { assignedRepId: params.id }, data: { assignedRepId: null } });
  await prisma.rep.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
