import { useEffect, useState } from "react";
import { api } from "../api";

type Rep = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  _count: { lots: number };
};

export function Reps() {
  const [reps, setReps] = useState<Rep[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  async function refresh() { setReps(await api.get<Rep[]>("/api/reps")); }
  useEffect(() => { refresh(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    await api.post("/api/reps", { name, email, phone });
    setName(""); setEmail(""); setPhone("");
    refresh();
  }

  async function remove(id: string) {
    if (!confirm("Remove this rep? Lots will become unassigned.")) return;
    await api.delete(`/api/reps/${id}`);
    refresh();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Reps</h1>
      <p className="text-sm text-slate-500">
        Reps are labels you can attach to lots so you can filter the lot list by rep. They do not get their own login.
      </p>

      <form onSubmit={add} className="card grid gap-3 md:grid-cols-4">
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="input" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn-primary" type="submit">Add rep</button>
      </form>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Phone</th><th className="text-right">Lots</th><th></th></tr>
          </thead>
          <tbody>
            {reps.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500 py-6">No reps yet.</td></tr>}
            {reps.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="text-slate-500">{r.email ?? "—"}</td>
                <td className="text-slate-500">{r.phone ?? "—"}</td>
                <td className="text-right">{r._count.lots}</td>
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
