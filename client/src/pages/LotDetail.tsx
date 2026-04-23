import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";

type Buyer = {
  id?: string;
  role: "PRIMARY" | "CO_BUYER" | "THIRD";
  name: string;
  email: string | null;
  phone: string | null;
};

type MessageLog = {
  id: string;
  channel: string;
  status: string;
  subject: string | null;
  body: string;
  createdAt: string;
  sentAt: string | null;
  buyer: { name: string };
};

type CalendlyEventRow = {
  id: string;
  inviteeEmail: string;
  startTime: string;
  status: string;
};

type Lot = {
  id: string;
  lotNumber: string;
  address: string | null;
  status: string;
  notes: string | null;
  reminderCount: number;
  assignedRepId: string | null;
  projectId: string;
  project: { id: string; name: string };
  buyers: Buyer[];
  messageLogs: MessageLog[];
  calendlyEvents: CalendlyEventRow[];
  multiEventWarnings: Array<{ email: string; count: number }>;
};

type Rep = { id: string; name: string };
type Template = { id: string; name: string; type: string };

const STATUSES = ["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"] as const;
const ROLES: Buyer["role"][] = ["PRIMARY", "CO_BUYER", "THIRD"];

export function LotDetail() {
  const { lotId } = useParams();
  const [lot, setLot] = useState<Lot | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [form, setForm] = useState<{
    lotNumber: string; address: string; status: string; notes: string; assignedRepId: string; reminderCount: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!lotId) return;
    const [l, r, t] = await Promise.all([
      api.get<Lot>(`/api/lots/${lotId}`),
      api.get<Rep[]>("/api/reps"),
      api.get<Template[]>("/api/templates"),
    ]);
    setLot(l);
    setReps(r);
    setTemplates(t);
    setBuyers(l.buyers);
    setForm({
      lotNumber: l.lotNumber,
      address: l.address ?? "",
      status: l.status,
      notes: l.notes ?? "",
      assignedRepId: l.assignedRepId ?? "",
      reminderCount: l.reminderCount,
    });
  }, [lotId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!lot || !form) return <div className="text-slate-500">Loading…</div>;

  function setBuyer(role: Buyer["role"], patch: Partial<Buyer>) {
    setBuyers((bs) => {
      const existing = bs.find((b) => b.role === role);
      if (existing) return bs.map((b) => (b.role === role ? { ...b, ...patch } : b));
      return [...bs, { role, name: "", email: null, phone: null, ...patch }];
    });
  }
  function removeBuyer(role: Buyer["role"]) {
    setBuyers((bs) => bs.filter((b) => b.role !== role));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api.patch(`/api/lots/${lot!.id}`, {
        lotNumber: form!.lotNumber,
        address: form!.address || null,
        status: form!.status,
        notes: form!.notes || null,
        assignedRepId: form!.assignedRepId || null,
        reminderCount: form!.reminderCount,
        buyers: buyers.filter((b) => b.name.trim()),
      });
      setMsg("Saved.");
      refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: string) {
    await api.post(`/api/lots/${lot!.id}/status`, { status });
    setForm((f) => f ? { ...f, status } : f);
    refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-slate-500">
          <Link to="/projects" className="hover:underline">Projects</Link> /{" "}
          <Link to={`/projects/${lot.project.id}`} className="hover:underline">{lot.project.name}</Link> / Lot {lot.lotNumber}
        </div>
        <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold">
          Lot {lot.lotNumber} <StatusBadge status={form.status} />
        </h1>
      </div>

      {lot.multiEventWarnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Calendly warning:</strong> one or more buyer emails have multiple active Calendly events.
          <ul className="mt-1 list-disc pl-6">
            {lot.multiEventWarnings.map((g) => (
              <li key={g.email}>{g.email}: {g.count} events</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={save} className="card space-y-4">
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <label className="label">Lot number</label>
            <input className="input" value={form.lotNumber}
                   onChange={(e) => setForm({ ...form, lotNumber: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Address</label>
            <input className="input" value={form.address}
                   onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div>
            <label className="label">Rep</label>
            <select className="input" value={form.assignedRepId}
                    onChange={(e) => setForm({ ...form, assignedRepId: e.target.value })}>
              <option value="">— Unassigned —</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={form.status} onChange={(e) => changeStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-500">Changing to BOOKED/SCHEDULED clears pending reminders.</p>
          </div>
          <div>
            <label className="label">Reminder count</label>
            <input type="number" min={0} className="input" value={form.reminderCount}
                   onChange={(e) => setForm({ ...form, reminderCount: Number(e.target.value) })} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Notes</label>
            <textarea className="input" rows={2} value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>

        <div>
          <h3 className="mb-2 font-medium">Buyers</h3>
          <div className="space-y-3">
            {ROLES.map((role) => {
              const b = buyers.find((x) => x.role === role);
              const label = role === "PRIMARY" ? "Primary buyer" : role === "CO_BUYER" ? "Co-buyer" : "Third buyer";
              return (
                <div key={role} className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-4">
                  <div className="text-sm font-medium md:self-center">{label}</div>
                  <input className="input" placeholder="Name" value={b?.name ?? ""}
                         onChange={(e) => setBuyer(role, { name: e.target.value })} />
                  <input className="input" placeholder="Email" value={b?.email ?? ""}
                         onChange={(e) => setBuyer(role, { email: e.target.value })} />
                  <div className="flex gap-2">
                    <input className="input flex-1" placeholder="Phone" value={b?.phone ?? ""}
                           onChange={(e) => setBuyer(role, { phone: e.target.value })} />
                    {b && <button type="button" className="btn-ghost" onClick={() => removeBuyer(role)}>Remove</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={busy}>{busy ? "Saving..." : "Save lot"}</button>
          {msg && <span className="text-sm text-slate-600">{msg}</span>}
        </div>
      </form>

      <SendNow
        lotId={lot.id}
        emailTemplates={templates.filter((t) => t.type === "EMAIL")}
        smsTemplates={templates.filter((t) => t.type === "SMS")}
        onSent={refresh}
      />

      <div className="card">
        <h2 className="mb-2 font-medium">Message history</h2>
        <table className="table">
          <thead>
            <tr>
              <th>When</th><th>Channel</th><th>Buyer</th><th>Status</th><th>Subject / body</th>
            </tr>
          </thead>
          <tbody>
            {lot.messageLogs.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-6">No messages yet.</td></tr>
            )}
            {lot.messageLogs.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-slate-500">
                  {new Date(m.sentAt ?? m.createdAt).toLocaleString()}
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

      {lot.calendlyEvents.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-medium">Calendly events</h2>
          <ul className="text-sm">
            {lot.calendlyEvents.map((e) => (
              <li key={e.id}>
                {e.inviteeEmail} — {new Date(e.startTime).toLocaleString()} ({e.status})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SendNow({
  lotId,
  emailTemplates,
  smsTemplates,
  onSent,
}: {
  lotId: string;
  emailTemplates: Template[];
  smsTemplates: Template[];
  onSent: () => void;
}) {
  const [emailId, setEmailId] = useState("");
  const [smsId, setSmsId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function send() {
    if (!emailId && !smsId) { setMsg("Pick at least one template"); return; }
    setBusy(true); setMsg(null);
    try {
      const channels: Array<"EMAIL" | "SMS"> = [];
      if (emailId) channels.push("EMAIL");
      if (smsId) channels.push("SMS");
      const data = await api.post<{ enqueued: number }>("/api/send", {
        lotIds: [lotId], channels,
        emailTemplateId: emailId || undefined,
        smsTemplateId: smsId || undefined,
      });
      setMsg(`Queued ${data.enqueued} message${data.enqueued === 1 ? "" : "s"} (paced send)`);
      onSent();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="mb-2 font-medium">Send now</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label className="label">Email template</label>
          <select className="input" value={emailId} onChange={(e) => setEmailId(e.target.value)}>
            <option value="">— none —</option>
            {emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">SMS template</label>
          <select className="input" value={smsId} onChange={(e) => setSmsId(e.target.value)}>
            <option value="">— none —</option>
            {smsTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="flex items-end gap-3">
          <button className="btn-primary" disabled={busy} onClick={send}>
            {busy ? "Queuing..." : "Queue paced send"}
          </button>
        </div>
      </div>
      {msg && <div className="mt-2 text-sm text-slate-600">{msg}</div>}
    </div>
  );
}
