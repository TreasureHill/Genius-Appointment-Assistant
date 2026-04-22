import { NextResponse } from "next/server";
import { requireSession } from "@/lib/api";
import { exportCurrent } from "@/lib/exporter";

export async function GET(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const buf = await exportCurrent(projectId);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="contacts-${projectId ?? "all"}-${Date.now()}.xlsx"`,
    },
  });
}
