"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewTemplateForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"EMAIL" | "SMS">("EMAIL");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        name,
        subject: type === "EMAIL" ? "Let's find a time to meet" : undefined,
        bodyHtml: type === "EMAIL" ? "<p>Hi {{buyer.firstName}},</p><p>Ready to schedule?</p>" : undefined,
        bodyText: type === "EMAIL"
          ? "Hi {{buyer.firstName}}, ready to schedule?"
          : "Hi {{buyer.firstName}}, let's book your appointment.",
      }),
    });
    setBusy(false);
    if (res.ok) {
      const created = (await res.json()) as { id: string };
      router.push(`/templates/${created.id}`);
    }
  }

  if (!open) return <button className="btn-primary" onClick={() => setOpen(true)}>New template</button>;

  return (
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
  );
}
