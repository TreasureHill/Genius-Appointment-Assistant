import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const Update = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  reminderIntervalDays: z.number().int().min(0).max(365).optional(),
  maxReminders: z.number().int().min(0).max(50).optional(),
  defaultEmailTemplateId: z.string().nullable().optional(),
  defaultSmsTemplateId: z.string().nullable().optional(),
});

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const body = Update.parse(await req.json());
  const project = await prisma.project.update({ where: { id: params.id }, data: body });
  return NextResponse.json(project);
}

export async function DELETE(_: Request, { params }: Params) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  await prisma.project.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
