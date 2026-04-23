import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { EmailEditor } from "../components/EmailEditor";
import { SmsEditor } from "../components/SmsEditor";

type Template = {
  id: string;
  type: "EMAIL" | "SMS";
  name: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
};

export function TemplateEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [t, setT] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.get<Template>(`/api/templates/${id}`).then(setT);
  }, [id]);

  if (!t) return <div className="text-slate-500">Loading…</div>;

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api.patch(`/api/templates/${t!.id}`, {
        name: t!.name,
        subject: t!.subject,
        bodyHtml: t!.bodyHtml,
        bodyText: t!.bodyText,
      });
      setMsg("Saved.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this template?")) return;
    await api.delete(`/api/templates/${t!.id}`);
    navigate("/templates");
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t.name}</h1>
        <div className="text-sm text-slate-500">{t.type} template</div>
      </div>

      <div className="card grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input className="input" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
        </div>
        {t.type === "EMAIL" && (
          <div>
            <label className="label">Subject</label>
            <input className="input" value={t.subject ?? ""} onChange={(e) => setT({ ...t, subject: e.target.value })} />
          </div>
        )}
      </div>

      <div className="card">
        {t.type === "EMAIL" ? (
          <>
            <label className="label">HTML body</label>
            <EmailEditor html={t.bodyHtml ?? ""} onChange={(html) => setT({ ...t, bodyHtml: html })} />
            <div className="mt-4">
              <label className="label">Plain-text fallback</label>
              <textarea className="input min-h-[100px]" value={t.bodyText}
                        onChange={(e) => setT({ ...t, bodyText: e.target.value })} />
            </div>
          </>
        ) : (
          <>
            <label className="label">SMS body</label>
            <SmsEditor body={t.bodyText} onChange={(v) => setT({ ...t, bodyText: v })} />
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={busy}>{busy ? "Saving..." : "Save"}</button>
        <button className="btn-danger" onClick={remove}>Delete</button>
        {msg && <span className="text-sm text-slate-600">{msg}</span>}
      </div>
    </div>
  );
}
