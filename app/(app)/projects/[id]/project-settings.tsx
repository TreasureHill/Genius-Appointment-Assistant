"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Template = { id: string; name: string; type: string };
type Project = {
  id: string;
  reminderIntervalDays: number;
  maxReminders: number;
  defaultEmailTemplateId: string | null;
  defaultSmsTemplateId: string | null;
};

export function ProjectSettings({ project, templates }: { project: Project; templates: Template[] }) {
  const router = useRouter();
  const [interval, setInterval_] = useState(project.reminderIntervalDays);
  const [max, setMax] = useState(project.maxReminders);
  const [emailId, setEmailId] = useState(project.defaultEmailTemplateId ?? "");
  const [smsId, setSmsId] = useState(project.defaultSmsTemplateId ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reminderIntervalDays: interval,
        maxReminders: max,
        defaultEmailTemplateId: emailId || null,
        defaultSmsTemplateId: smsId || null,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  const emailTemplates = templates.filter((t) => t.type === "EMAIL");
  const smsTemplates = templates.filter((t) => t.type === "SMS");

  return (
    <form onSubmit={save} className="card grid gap-4 md:grid-cols-4">
      <div>
        <label className="label">Reminder interval (days)</label>
        <input type="number" min={0} className="input" value={interval}
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
