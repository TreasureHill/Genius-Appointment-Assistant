"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CreateProjectForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [reminderIntervalDays, setInterval] = useState(14);
  const [maxReminders, setMax] = useState(4);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, reminderIntervalDays, maxReminders }),
    });
    setBusy(false);
    if (res.ok) {
      setName("");
      setOpen(false);
      router.refresh();
    } else {
      alert("Could not create project");
    }
  }

  if (!open) {
    return (
      <button className="btn-primary" onClick={() => setOpen(true)}>New project</button>
    );
  }

  return (
    <form onSubmit={submit} className="card grid gap-4 md:grid-cols-4">
      <div className="md:col-span-2">
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <label className="label">Reminder interval (days)</label>
        <input type="number" min={0} className="input"
               value={reminderIntervalDays}
               onChange={(e) => setInterval(Number(e.target.value))} />
      </div>
      <div>
        <label className="label">Max reminders</label>
        <input type="number" min={0} className="input"
               value={maxReminders}
               onChange={(e) => setMax(Number(e.target.value))} />
      </div>
      <div className="md:col-span-4 flex gap-2">
        <button className="btn-primary" disabled={busy}>{busy ? "Creating..." : "Create project"}</button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
