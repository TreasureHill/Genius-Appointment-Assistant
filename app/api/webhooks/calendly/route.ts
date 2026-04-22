import { NextResponse } from "next/server";
import { upsertEvent } from "@/lib/calendly";

/**
 * Calendly webhook. We accept invitee.created / invitee.canceled and extract
 * the event + invitee email to upsert a CalendlyEvent and match it to a buyer.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const b = body as {
    event?: string;
    payload?: {
      email?: string;
      scheduled_event?: { uri?: string; start_time?: string; status?: string };
    };
  };

  const uri = b.payload?.scheduled_event?.uri;
  const email = b.payload?.email;
  const start = b.payload?.scheduled_event?.start_time;
  const rawStatus = b.payload?.scheduled_event?.status ?? "active";
  if (!uri || !email || !start) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const status =
    b.event === "invitee.canceled" || rawStatus.toUpperCase() === "CANCELED" ? "CANCELED" : "ACTIVE";

  await upsertEvent({
    eventUri: uri,
    inviteeEmail: email,
    startTime: new Date(start),
    status,
  });
  return NextResponse.json({ ok: true });
}
