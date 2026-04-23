import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";

type Row = {
  id: string;
  channel: string;
  status: string;
  subject: string | null;
  body: string;
  createdAt: string;
  sentAt: string | null;
  lotId: string;
  lot: { id: string; lotNumber: string; projectId: string; project: { name: string } };
  buyer: { name: string };
};
type Project = { id: string; name: string };

export function History() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Row[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => { api.get<Project[]>("/api/projects").then(setProjects); }, []);
  useEffect(() => {
    const qs = params.toString();
    api.get<Row[]>(`/api/history${qs ? `?${qs}` : ""}`).then(setRows);
  }, [params]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Message history</h1>

      <form
        className="card flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const next = new URLSearchParams();
          for (const key of ["channel", "status", "project"]) {
            const v = fd.get(key); if (v) next.set(key, String(v));
          }
          setParams(next);
        }}
      >
        <div>
          <label className="label">Channel</label>
          <select name="channel" defaultValue={params.get("channel") ?? ""} className="input">
            <option value="">All</option>
            <option value="EMAIL">Email</option>
            <option value="SMS">SMS</option>
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select name="status" defaultValue={params.get("status") ?? ""} className="input">
            <option value="">All</option>
            {["QUEUED", "SENT", "DELIVERED", "FAILED"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Project</label>
          <select name="project" defaultValue={params.get("project") ?? ""} className="input">
            <option value="">All</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <button className="btn-ghost" type="submit">Apply</button>
      </form>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>When</th><th>Channel</th><th>Project</th><th>Lot</th><th>Buyer</th><th>Status</th><th>Subject</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="text-center text-slate-500 py-6">No messages.</td></tr>}
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-slate-500">{new Date(m.sentAt ?? m.createdAt).toLocaleString()}</td>
                <td>{m.channel}</td>
                <td>{m.lot.project.name}</td>
                <td><Link className="text-brand-600 hover:underline" to={`/projects/${m.lot.projectId}/lots/${m.lotId}`}>{m.lot.lotNumber}</Link></td>
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
