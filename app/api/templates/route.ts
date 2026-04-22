import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const Create = z.object({
  type: z.enum(["EMAIL", "SMS"]),
  name: z.string().min(1),
  subject: z.string().optional(),
  bodyHtml: z.string().optional(),
  bodyText: z.string().default(""),
});

export async function GET() {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const list = await prisma.template.findMany({ orderBy: { updatedAt: "desc" } });
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const data = Create.parse(await req.json());
  const created = await prisma.template.create({ data });
  return NextResponse.json(created, { status: 201 });
}
