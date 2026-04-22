"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Buyer = {
  id?: string;
  role: "PRIMARY" | "CO_BUYER" | "THIRD";
  name: string;
  email: string | null;
  phone: string | null;
};
type Lot = {
  id: string;
  lotNumber: string;
  address: string | null;
  status: string;
  notes: string | null;
  assignedRepId: string | null;
  reminderCount: number;
  buyers: Buyer[];
};

const STATUSES = ["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"] as const;
const ROLES: Buyer["role"][] = ["PRIMARY", "CO_BUYER", "THIRD"];

export function LotEditor({ lot, reps }: { lot: Lot; reps: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [state, setState] = useState<Lot>(lot);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function setBuyer(role: Buyer["role"], patch: Partial<Buyer>) {
    setState((s) => {
      const existing = s.buyers.find((b) => b.role === role);
      if (existing) {
        return {
          ...s,
          buyers: s.buyers.map((b) => (b.role === role ? { ...b, ...patch } : b)),
        };
      }
      return {
        ...s,
        buyers: [...s.buyers, { role, name: "", email: null, phone: null, ...patch }],
      };
    });
  }

  function removeBuyer(role: Buyer["role"]) {
    setState((s) => ({ ...s, buyers: s.buyers.filter((b) => b.role !== role) }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const payload = {
      lotNumber: state.lotNumber,
      address: state.address || null,
      status: state.status,
      notes: state.notes || null,
      assignedRepId: state.assignedRepId || null,
      reminderCount: state.reminderCount,
      buyers: state.buyers.filter((b) => b.name.trim()),
    };
    const res = await fetch(`/api/lots/${state.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved.");
      router.refresh();
    } else {
      setMsg("Failed to save.");
    }
  }

  async function changeStatus(status: string) {
    await fetch(`/api/lots/${state.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setState((s) => ({ ...s, status }));
    router.refresh();
  }

  return (
    <form onSubmit={save} className="card space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        <div>
          <label className="label">Lot number</label>
          <input className="input" value={state.lotNumber}
                 onChange={(e) => setState((s) => ({ ...s, lotNumber: e.target.value }))} />
        </div>
        <div className="md:col-span-2">
          <label className="label">Address</label>
          <input className="input" value={state.address ?? ""}
                 onChange={(e) => setState((s) => ({ ...s, address: e.target.value }))} />
        </div>
        <div>
          <label className="label">Rep</label>
          <select className="input" value={state.assignedRepId ?? ""}
                  onChange={(e) => setState((s) => ({ ...s, assignedRepId: e.target.value || null }))}>
            <option value="">— Unassigned —</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <div className="flex gap-2">
            <select className="input" value={state.status}
                    onChange={(e) => changeStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <p className="mt-1 text-xs text-slate-500">Changing to BOOKED/SCHEDULED clears pending reminders.</p>
        </div>
        <div>
          <label className="label">Reminder count</label>
          <input type="number" min={0} className="input"
                 value={state.reminderCount}
                 onChange={(e) => setState((s) => ({ ...s, reminderCount: Number(e.target.value) }))} />
        </div>
        <div className="md:col-span-2">
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={state.notes ?? ""}
                    onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))} />
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-medium">Buyers</h3>
        <div className="space-y-3">
          {ROLES.map((role) => {
            const b = state.buyers.find((x) => x.role === role);
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
                  {b && (
                    <button type="button" className="btn-ghost" onClick={() => removeBuyer(role)}>
                      Remove
                    </button>
                  )}
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
  );
}
