import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";

type Buyer = { id: string; role: string; name: string; email: string | null; phone: string | null };
type Lot = {
  id: string;
  lotNumber: string;
  address: string | null;
  status: string;
  reminderCount: number;
  assignedRepId: string | null;
  assignedRep: { id: string; name: string } | null;
  buyers: Buyer[];
};
type Project = {
  id: string;
  name: string;
  reminderIntervalDays: number;
  maxReminders: number;
  defaultEmailTemplateId: string | null;
  defaultSmsTemplateId: string | null;
  lots: Lot[];
};
type Rep = { id: string; name: string };
type Template = { id: string; name: string; type: string };

const STATUSES = ["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"];

export function ProjectDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  const repFilter = params.get("rep") ?? "";
  const statusFilter = params.get("status") ?? "";

  const refresh = useCallback(async () => {
    if (!id) return;
    const [p, r, t] = await Promise.all([
      api.get<Project>(`/api/projects/${id}`),
      api.get<Rep[]>("/api/reps"),
      api.get<Template[]>("/api/templates"),
    ]);
    setProject(p);
    setReps(r);
    setTemplates(t);
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const lots = useMemo(() => {
    if (!project) return [];
    return project.lots.filter((l) => {
      if (repFilter && l.assignedRepId !== repFilter) return false;
      if (statusFilter && l.status !== statusFilter) return false;
      return true;
    });
  }, [project, repFilter, statusFilter]);

  if (!project) return <div className="text-slate-500">Loading…</div>;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-slate-500">
          <Link to="/projects" className="hover:underline">Projects</Link> / {project.name}
        </div>
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <div className="text-sm text-slate-500">
          Reminder every {project.reminderIntervalDays}d · max {project.maxReminders} reminders
        </div>
      </div>

      <ProjectTools projectId={project.id} onImported={refresh} />

      <ProjectSettings project={project} templates={templates} onSaved={refresh} />

      <div className="card">
        <form
          className="mb-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const next = new URLSearchParams();
            const rep = fd.get("rep"); if (rep) next.set("rep", String(rep));
            const status = fd.get("status"); if (status) next.set("status", String(status));
            setParams(next);
          }}
        >
          <div>
            <label className="label">Filter by rep</label>
            <select name="rep" defaultValue={repFilter} className="input">
              <option value="">All reps</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select name="status" defaultValue={statusFilter} className="input">
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button className="btn-ghost" type="submit">Apply</button>
        </form>

        <table className="table">
          <thead>
            <tr>
              <th>Lot #</th>
              <th>Address</th>
              <th>Status</th>
              <th>Rep</th>
              <th>Buyers</th>
              <th className="text-right">Reminders</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lots.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-500 py-6">No lots. Import a sheet to add some.</td></tr>
            )}
            {lots.map((lot) => (
              <tr key={lot.id}>
                <td className="font-medium">{lot.lotNumber}</td>
                <td className="text-slate-500">{lot.address ?? "—"}</td>
                <td><StatusBadge status={lot.status} /></td>
                <td>{lot.assignedRep?.name ?? <span className="text-slate-400">Unassigned</span>}</td>
                <td className="text-slate-500">{lot.buyers.map((b) => b.name).join(", ") || "—"}</td>
                <td className="text-right">{lot.reminderCount}</td>
                <td className="text-right">
                  <Link to={`/projects/${project.id}/lots/${lot.id}`} className="text-sm text-brand-600 hover:underline">Edit →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProjectTools({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; updated: number; skipped: number; errors: Array<{ row: number; reason: string }> } | null>(null);

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.upload<typeof result>("/api/import", file);
      setResult(r as NonNullable<typeof result>);
      onImported();
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap gap-3">
        <a className="btn-ghost" href="/api/import/template">Download blank template</a>
        <a className="btn-ghost" href={`/api/export?projectId=${projectId}`}>Export current</a>
        <button className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Importing..." : "Import sheet"}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onImport} />
      </div>
      {result && (
        <div className="mt-3 text-sm">
          <div>Added <strong>{result.added}</strong> · Updated <strong>{result.updated}</strong> · Skipped <strong>{result.skipped}</strong></div>
          {result.errors.length > 0 && (
            <ul className="mt-2 list-disc pl-6 text-red-600">
              {result.errors.map((e, i) => <li key={i}>Row {e.row}: {e.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectSettings({ project, templates, onSaved }: {
  project: Project;
  templates: Template[];
  onSaved: () => void;
}) {
  const [interval_, setInterval_] = useState(project.reminderIntervalDays);
  const [max, setMax] = useState(project.maxReminders);
  const [emailId, setEmailId] = useState(project.defaultEmailTemplateId ?? "");
  const [smsId, setSmsId] = useState(project.defaultSmsTemplateId ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const emailTemplates = templates.filter((t) => t.type === "EMAIL");
  const smsTemplates = templates.filter((t) => t.type === "SMS");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/api/projects/${project.id}`, {
        reminderIntervalDays: interval_,
        maxReminders: max,
        defaultEmailTemplateId: emailId || null,
        defaultSmsTemplateId: smsId || null,
      });
      setSaved(true);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card grid gap-4 md:grid-cols-4">
      <div>
        <label className="label">Reminder interval (days)</label>
        <input type="number" min={0} className="input" value={interval_}
               onChange={(e) => setInterval_(Number(e.target.value))} />
      </div>
      <div>
        <label className="label">Max reminders</label>
        <input type="number" min={0} className="input" value={max}
               onChange={(e) => setMax(Number(e.target.value))} />
      </div>
      <div>
        <label className="label">Default email template</label>
        <select className="input" value={emailId} onChange={(e) => setEmailId(e.target.value)}>
          <option value="">— none —</option>
          {emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Default SMS template</label>
        <select className="input" value={smsId} onChange={(e) => setSmsId(e.target.value)}>
          <option value="">— none —</option>
          {smsTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div className="md:col-span-4 flex items-center gap-3">
        <button className="btn-primary" disabled={busy}>{busy ? "Saving..." : "Save project settings"}</button>
        {saved && <span className="text-sm text-emerald-600">Saved.</span>}
      </div>
    </form>
  );
}
