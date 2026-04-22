import Link from "next/link";
import { prisma } from "@/lib/prisma";

type Props = { searchParams: { channel?: string; status?: string; project?: string } };

export default async function HistoryPage({ searchParams }: Props) {
  const [projects, logs] = await Promise.all([
    prisma.project.findMany({ orderBy: { name: "asc" } }),
    prisma.messageLog.findMany({
      where: {
        channel: searchParams.channel || undefined,
        status: searchParams.status || undefined,
        lot: searchParams.project ? { projectId: searchParams.project } : undefined,
      },
      include: { buyer: true, lot: { include: { project: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Message history</h1>

      <form className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Channel</label>
          <select name="channel" defaultValue={searchParams.channel ?? ""} className="input">
            <option value="">All</option>
            <option value="EMAIL">Email</option>
            <option value="SMS">SMS</option>
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select name="status" defaultValue={searchParams.status ?? ""} className="input">
            <option value="">All</option>
            {["QUEUED", "SENT", "DELIVERED", "FAILED"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Project</label>
          <select name="project" defaultValue={searchParams.project ?? ""} className="input">
            <option value="">All</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <button className="btn-ghost" type="submit">Apply</button>
      </form>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Project</th>
              <th>Lot</th>
              <th>Buyer</th>
              <th>Status</th>
              <th>Subject</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && <tr><td colSpan={7} className="text-center text-slate-500 py-6">No messages.</td></tr>}
            {logs.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-slate-500">
                  {(m.sentAt ?? m.createdAt).toLocaleString()}
                </td>
                <td>{m.channel}</td>
                <td>{m.lot.project.name}</td>
                <td>
                  <Link href={`/projects/${m.lot.projectId}/lots/${m.lotId}`}
                        className="text-brand-600 hover:underline">{m.lot.lotNumber}</Link>
                </td>
                <td>{m.buyer.name}</td>
                <td>{m.status}</td>
                <td className="max-w-md truncate text-slate-500">{m.subject ?? m.body.slice(0, 120)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
