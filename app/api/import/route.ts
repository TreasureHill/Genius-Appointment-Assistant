import { NextResponse } from "next/server";
import { requireSession } from "@/lib/api";
import { importRows, parseWorkbook } from "@/lib/importer";

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const rows = await parseWorkbook(buffer);
  const summary = await importRows(rows, file.name);
  return NextResponse.json(summary);
}
