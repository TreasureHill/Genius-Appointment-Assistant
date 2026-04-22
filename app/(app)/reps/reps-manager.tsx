"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Rep = { id: string; name: string; email: string | null; phone: string | null; active: boolean; lotCount: number };

export function RepsManager({ initial }: { initial: Rep[] }) {
  const router = useRouter();
  const [reps, setReps] = useState<Rep[]>(initial);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/reps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone }),
    });
    if (res.ok) {
      const rep = (await res.json()) as Rep;
      setReps((r) => [...r, { ...rep, lotCount: 0 }]);
      setName(""); setEmail(""); setPhone("");
      router.refresh();
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this rep? Lots will become unassigned.")) return;
    const res = await fetch(`/api/reps/${id}`, { method: "DELETE" });
    if (res.ok) {
      setReps((r) => r.filter((x) => x.id !== id));
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="card grid gap-3 md:grid-cols-4">
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="input" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn-primary" type="submit">Add rep</button>
      </form>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th className="text-right">Lots</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reps.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500 py-6">No reps yet.</td></tr>}
            {reps.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="text-slate-500">{r.email ?? "—"}</td>
                <td className="text-slate-500">{r.phone ?? "—"}</td>
                <td className="text-right">{r.lotCount}</td>
                <td className="text-right">
                  <button className="text-sm text-red-600 hover:underline" onClick={() => remove(r.id)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
