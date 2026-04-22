import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { LotEditor } from "./lot-editor";
import { SendNow } from "./send-now";

type Props = { params: { id: string; lotId: string } };

export default async function LotDetailPage({ params }: Props) {
  const lot = await prisma.lot.findUnique({
    where: { id: params.lotId },
    include: { buyers: true, project: true },
  });
  if (!lot) notFound();

  const [reps, templates, logs, calendlyEvents] = await Promise.all([
    prisma.rep.findMany({ orderBy: { name: "asc" } }),
    prisma.template.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.messageLog.findMany({
      where: { lotId: lot.id },
      include: { buyer: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.calendlyEvent.findMany({
      where: { matchedLotId: lot.id },
      orderBy: { startTime: "desc" },
    }),
  ]);

  const emailsByInvitee = await prisma.calendlyEvent.groupBy({
    by: ["inviteeEmail"],
    where: {
      status: "ACTIVE",
      inviteeEmail: { in: lot.buyers.map((b) => b.email ?? "").filter(Boolean) as string[] },
    },
    _count: { _all: true },
  });
  const multiWarn = emailsByInvitee.filter((g) => g._count._all > 1);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-slate-500">
          <Link href="/projects" className="hover:underline">Projects</Link> /{" "}
          <Link href={`/projects/${lot.projectId}`} className="hover:underline">{lot.project.name}</Link> / Lot {lot.lotNumber}
        </div>
        <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold">
          Lot {lot.lotNumber} <StatusBadge status={lot.status} />
        </h1>
      </div>

      {multiWarn.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Calendly warning:</strong> one or more buyer emails have multiple active Calendly events.
          Verify which booking is correct before marking this lot BOOKED.
          <ul className="mt-1 list-disc pl-6">
            {multiWarn.map((g) => (
              <li key={g.inviteeEmail}>{g.inviteeEmail}: {g._count._all} events</li>
            ))}
          </ul>
        </div>
      )}

      <LotEditor
        lot={{
          id: lot.id,
          lotNumber: lot.lotNumber,
          address: lot.address,
          status: lot.status,
          notes: lot.notes,
          assignedRepId: lot.assignedRepId,
          reminderCount: lot.reminderCount,
          buyers: lot.buyers.map((b) => ({
            id: b.id,
            role: b.role as "PRIMARY" | "CO_BUYER" | "THIRD",
            name: b.name,
            email: b.email,
            phone: b.phone,
          })),
        }}
        reps={reps.map((r) => ({ id: r.id, name: r.name }))}
      />

      <SendNow
        lotId={lot.id}
        emailTemplates={templates.filter((t) => t.type === "EMAIL").map((t) => ({ id: t.id, name: t.name }))}
        smsTemplates={templates.filter((t) => t.type === "SMS").map((t) => ({ id: t.id, name: t.name }))}
      />

      <div className="card">
        <h2 className="mb-2 font-medium">Message history</h2>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Buyer</th>
              <th>Status</th>
              <th>Subject / body</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-6">No messages yet.</td></tr>
            )}
            {logs.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-slate-500">
                  {(m.sentAt ?? m.createdAt).toLocaleString()}
                </td>
                <td>{m.channel}</td>
                <td>{m.buyer.name}</td>
                <td>{m.status}</td>
                <td className="max-w-xl truncate text-slate-500">{m.subject ?? m.body.slice(0, 120)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {calendlyEvents.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-medium">Calendly events</h2>
          <ul className="text-sm">
            {calendlyEvents.map((e) => (
              <li key={e.id}>
                {e.inviteeEmail} — {e.startTime.toLocaleString()} ({e.status})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
