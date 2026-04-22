import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { multiEventEmails } from "@/lib/calendly";

async function counts() {
  const now = new Date();
  const d1 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [e1, e7, e30, s1, s7, s30, failed30, outbox, pending, booked30] = await Promise.all([
    prisma.messageLog.count({ where: { channel: "EMAIL", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d1 } } }),
    prisma.messageLog.count({ where: { channel: "EMAIL", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d7 } } }),
    prisma.messageLog.count({ where: { channel: "EMAIL", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d30 } } }),
    prisma.messageLog.count({ where: { channel: "SMS", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d1 } } }),
    prisma.messageLog.count({ where: { channel: "SMS", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d7 } } }),
    prisma.messageLog.count({ where: { channel: "SMS", status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: d30 } } }),
    prisma.messageLog.count({ where: { status: "FAILED", createdAt: { gte: d30 } } }),
    prisma.outboxItem.count(),
    prisma.outboxItem.count({ where: { readyAt: { lte: now } } }),
    prisma.lot.count({ where: { status: "BOOKED", updatedAt: { gte: d30 } } }),
  ]);
  return { e1, e7, e30, s1, s7, s30, failed30, outbox, pending, booked30 };
}

async function perProject() {
  const projects = await prisma.project.findMany({
    include: { lots: true },
    orderBy: { name: "asc" },
  });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    total: p.lots.length,
    scheduled: p.lots.filter((l) => l.status === "SCHEDULED").length,
    booked: p.lots.filter((l) => l.status === "BOOKED").length,
    pending: p.lots.filter((l) => !["BOOKED", "SCHEDULED"].includes(l.status)).length,
  }));
}

export default async function DashboardPage() {
  const c = await counts();
  const proj = await perProject();
  const multi = await multiEventEmails();

  const Tile = ({ label, value, hint }: { label: string; value: number | string; hint?: string }) => (
    <div className="card">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-slate-500">Emails, SMS and reminder activity at a glance.</p>
      </div>

      {multi.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Calendly warning:</strong> {multi.length} invitee email
          {multi.length === 1 ? "" : "s"} have multiple active events — verify the correct booking on the
          affected lots.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label="Emails 24h" value={c.e1} hint={`${c.e7} in 7d, ${c.e30} in 30d`} />
        <Tile label="SMS 24h" value={c.s1} hint={`${c.s7} in 7d, ${c.s30} in 30d`} />
        <Tile label="Outbox queued" value={c.outbox} hint={`${c.pending} ready now`} />
        <Tile label="Failures 30d" value={c.failed30} />
      </div>

      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Per project</h2>
          <Link className="text-sm text-brand-600 hover:underline" href="/projects">Manage →</Link>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th className="text-right">Total lots</th>
              <th className="text-right">Pending</th>
              <th className="text-right">Scheduled</th>
              <th className="text-right">Booked</th>
            </tr>
          </thead>
          <tbody>
            {proj.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-500 py-6">
                  No projects yet. <Link className="text-brand-600 hover:underline" href="/projects">Create one</Link>.
                </td>
              </tr>
            )}
            {proj.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link className="text-brand-600 hover:underline" href={`/projects/${p.id}`}>
                    {p.name}
                  </Link>
                </td>
                <td className="text-right">{p.total}</td>
                <td className="text-right">{p.pending}</td>
                <td className="text-right">{p.scheduled}</td>
                <td className="text-right">{p.booked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="font-medium mb-2">Booked (last 30d)</h2>
        <div className="text-3xl font-semibold">{c.booked30}</div>
      </div>
    </div>
  );
}
