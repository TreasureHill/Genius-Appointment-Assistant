import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const Create = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  reminderIntervalDays: z.number().int().min(0).max(365).optional(),
  maxReminders: z.number().int().min(0).max(50).optional(),
});

export async function GET() {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const projects = await prisma.project.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json(projects);
}

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const body = Create.parse(await req.json());
  const project = await prisma.project.create({ data: body });
  return NextResponse.json(project, { status: 201 });
}
