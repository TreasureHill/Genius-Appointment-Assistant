import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

type Project = {
  id: string;
  name: string;
  reminderIntervalDays: number;
  maxReminders: number;
  _count: { lots: number };
};

export function Projects() {
  const [list, setList] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [intervalDays, setIntervalDays] = useState(14);
  const [maxReminders, setMax] = useState(4);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setList(await api.get<Project[]>("/api/projects"));
  }
  useEffect(() => { refresh(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/projects", {
        name,
        reminderIntervalDays: intervalDays,
        maxReminders,
      });
      setName(""); setOpen(false);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projects</h1>
      </div>

      {!open ? (
        <button className="btn-primary" onClick={() => setOpen(true)}>New project</button>
      ) : (
        <form onSubmit={submit} className="card grid gap-4 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="label">Reminder interval (days)</label>
            <input type="number" min={0} className="input"
                   value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value))} />
          </div>
          <div>
            <label className="label">Max reminders</label>
            <input type="number" min={0} className="input"
                   value={maxReminders} onChange={(e) => setMax(Number(e.target.value))} />
          </div>
          <div className="md:col-span-4 flex gap-2">
            <button className="btn-primary" disabled={busy}>{busy ? "Creating..." : "Create project"}</button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="text-right">Lots</th>
              <th className="text-right">Reminder interval</th>
              <th className="text-right">Max reminders</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-6">No projects yet.</td></tr>
            )}
            {list.map((p) => (
              <tr key={p.id}>
                <td><Link className="text-brand-600 hover:underline" to={`/projects/${p.id}`}>{p.name}</Link></td>
                <td className="text-right">{p._count.lots}</td>
                <td className="text-right">{p.reminderIntervalDays}d</td>
                <td className="text-right">{p.maxReminders}</td>
                <td className="text-right">
                  <Link className="text-sm text-brand-600 hover:underline" to={`/projects/${p.id}`}>Open →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
