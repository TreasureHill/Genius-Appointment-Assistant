import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/api";
import { sendEmail } from "@/lib/mailer";
import { sendSms } from "@/lib/sms";

const Body = z.object({
  channel: z.enum(["EMAIL", "SMS"]),
  to: z.string().min(1),
});

export async function POST(req: Request) {
  const gate = await requireSession();
  if (gate.response) return gate.response;
  const { channel, to } = Body.parse(await req.json());
  try {
    if (channel === "EMAIL") {
      await sendEmail({
        to,
        subject: "Genius test email",
        html: "<p>This is a test email from Genius Appointment Assistant.</p>",
        text: "This is a test email from Genius Appointment Assistant.",
      });
    } else {
      await sendSms({ to, body: "Test SMS from Genius Appointment Assistant" });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
