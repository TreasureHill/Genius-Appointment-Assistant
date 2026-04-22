"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type T = { id: string; name: string };

export function SendNow({
  lotId,
  emailTemplates,
  smsTemplates,
}: {
  lotId: string;
  emailTemplates: T[];
  smsTemplates: T[];
}) {
  const router = useRouter();
  const [emailId, setEmailId] = useState("");
  const [smsId, setSmsId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function send() {
    if (!emailId && !smsId) {
      setMsg("Pick at least one template");
      return;
    }
    setBusy(true);
    setMsg(null);
    const channels: Array<"EMAIL" | "SMS"> = [];
    if (emailId) channels.push("EMAIL");
    if (smsId) channels.push("SMS");
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lotIds: [lotId],
        channels,
        emailTemplateId: emailId || undefined,
        smsTemplateId: smsId || undefined,
      }),
    });
    setBusy(false);
    if (res.ok) {
      const data = (await res.json()) as { enqueued: number };
      setMsg(`Queued ${data.enqueued} message${data.enqueued === 1 ? "" : "s"} (paced send)`);
      router.refresh();
    } else {
      setMsg("Failed to enqueue");
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
