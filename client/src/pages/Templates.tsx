import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

type Template = {
  id: string;
  type: "EMAIL" | "SMS";
  name: string;
  updatedAt: string;
};

export function Templates() {
  const navigate = useNavigate();
  const [list, setList] = useState<Template[]>([]);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"EMAIL" | "SMS">("EMAIL");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() { setList(await api.get<Template[]>("/api/templates")); }
  useEffect(() => { refresh(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await api.post<Template>("/api/templates", {
        type, name,
        subject: type === "EMAIL" ? "Let's find a time to meet" : undefined,
        bodyHtml: type === "EMAIL" ? "<p>Hi {{buyer.firstName}},</p><p>Ready to schedule?</p>" : undefined,
        bodyText: type === "EMAIL"
          ? "Hi {{buyer.firstName}}, ready to schedule?"
          : "Hi {{buyer.firstName}}, let's book your appointment.",
      });
      navigate(`/templates/${t.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Templates</h1>

      {!open ? (
        <button className="btn-primary" onClick={() => setOpen(true)}>New template</button>
      ) : (
        <form onSubmit={submit} className="card grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="label">Type</label>
            <select className="input" value={type} onChange={(e) => setType(e.target.value as "EMAIL" | "SMS")}>
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button className="btn-primary" disabled={busy}>{busy ? "Creating..." : "Create"}</button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Updated</th><th></th></tr>
          </thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={4} className="text-center text-slate-500 py-6">No templates yet.</td></tr>}
            {list.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><span className="badge bg-slate-100 text-slate-700">{t.type}</span></td>
                <td className="text-slate-500">{new Date(t.updatedAt).toLocaleString()}</td>
                <td className="text-right">
                  <Link className="text-sm text-brand-600 hover:underline" to={`/templates/${t.id}`}>Edit →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
