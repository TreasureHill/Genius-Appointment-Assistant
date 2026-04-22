import { NextResponse } from "next/server";
import { requireSession } from "@/lib/api";
import { blankTemplateBuffer } from "@/lib/exporter";

export async function GET() {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const buf = blankTemplateBuffer();
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="contacts-template.xlsx"',
    },
  });
}
