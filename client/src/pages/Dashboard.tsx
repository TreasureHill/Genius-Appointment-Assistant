import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

type Summary = {
  counts: {
    e1: number; e7: number; e30: number;
    s1: number; s7: number; s30: number;
    failed30: number; outbox: number; pending: number; booked30: number;
  };
  perProject: Array<{ id: string; name: string; total: number; pending: number; scheduled: number; booked: number }>;
  multiEventEmails: Array<{ email: string; count: number }>;
};

export function Dashboard() {
  const [data, setData] = useState<Summary | null>(null);

  useEffect(() => {
    api.get<Summary>("/api/projects/dashboard/summary").then(setData);
  }, []);

  if (!data) return <div className="text-slate-500">Loading…</div>;
  const { counts: c, perProject, multiEventEmails } = data;

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

      {multiEventEmails.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Calendly warning:</strong> {multiEventEmails.length} invitee email
          {multiEventEmails.length === 1 ? "" : "s"} have multiple active events — verify the correct booking on the affected lots.
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
          <Link className="text-sm text-brand-600 hover:underline" to="/projects">Manage →</Link>
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
            {perProject.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-6">
                No projects yet. <Link className="text-brand-600 hover:underline" to="/projects">Create one</Link>.
              </td></tr>
            )}
            {perProject.map((p) => (
              <tr key={p.id}>
                <td><Link className="text-brand-600 hover:underline" to={`/projects/${p.id}`}>{p.name}</Link></td>
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
