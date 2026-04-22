import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const Update = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().optional().nullable(),
  bodyHtml: z.string().optional().nullable(),
  bodyText: z.string().optional(),
});

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const data = Update.parse(await req.json());
  const updated = await prisma.template.update({ where: { id: params.id }, data });
  return NextResponse.json(updated);
}

export async function DELETE(_: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  await prisma.template.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
