"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EmailEditor } from "@/components/email-editor";
import { SmsEditor } from "@/components/sms-editor";

type Template = {
  id: string;
  type: "EMAIL" | "SMS";
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
};

export function TemplateEditor({ initial }: { initial: Template }) {
  const router = useRouter();
  const [state, setState] = useState<Template>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/templates/${state.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.name,
        subject: state.subject,
        bodyHtml: state.bodyHtml,
        bodyText: state.bodyText,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved.");
      router.refresh();
    } else {
      setMsg("Failed to save.");
    }
  }

  async function remove() {
    if (!confirm("Delete this template?")) return;
    const res = await fetch(`/api/templates/${state.id}`, { method: "DELETE" });
    if (res.ok) router.push("/templates");
  }

  return (
    <div className="space-y-4">
      <div className="card grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input className="input" value={state.name} onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))} />
        </div>
        {state.type === "EMAIL" && (
          <div>
            <label className="label">Subject</label>
            <input className="input" value={state.subject} onChange={(e) => setState((s) => ({ ...s, subject: e.target.value }))} />
          </div>
        )}
      </div>

      <div className="card">
        {state.type === "EMAIL" ? (
          <>
            <label className="label">HTML body</label>
            <EmailEditor
              html={state.bodyHtml}
              onChange={(html) => setState((s) => ({ ...s, bodyHtml: html }))}
            />
            <div className="mt-4">
              <label className="label">Plain-text fallback</label>
              <textarea
                className="input min-h-[100px]"
                value={state.bodyText}
                onChange={(e) => setState((s) => ({ ...s, bodyText: e.target.value }))}
              />
            </div>
          </>
        ) : (
          <>
            <label className="label">SMS body</label>
            <SmsEditor body={state.bodyText} onChange={(v) => setState((s) => ({ ...s, bodyText: v }))} />
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
