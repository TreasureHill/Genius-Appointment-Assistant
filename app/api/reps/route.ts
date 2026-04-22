import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/api";

const Create = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
});

export async function GET() {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const reps = await prisma.rep.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json(reps);
}

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const data = Create.parse(await req.json());
  const rep = await prisma.rep.create({
    data: { name: data.name, email: data.email || null, phone: data.phone || null },
  });
  return NextResponse.json(rep, { status: 201 });
}
