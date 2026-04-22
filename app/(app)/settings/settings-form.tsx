"use client";

import { useState } from "react";

type Pacing = { minSec: number; maxSec: number; dailyCapPerDomain: number };
type Providers = { smtp: boolean; twilio: boolean; calendly: boolean };

export function SettingsForm({
  initial,
}: {
  initial: { pacing: Pacing; providers: Providers };
}) {
  return (
    <div className="space-y-6">
      <ProvidersCard providers={initial.providers} />
      <PacingCard initial={initial.pacing} />
    </div>
  );
}

function ProvidersCard({ providers }: { providers: Providers }) {
  const Row = ({ label, on, vars }: { label: string; on: boolean; vars: string[] }) => (
    <div className="flex items-start justify-between rounded-md border border-slate-200 p-3">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-xs text-slate-500">
          Configured via env: <code>{vars.join(", ")}</code>
        </div>
      </div>
      <span className={`badge ${on ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
        {on ? "Configured" : "Not set"}
      </span>
    </div>
  );

  const [testing, setTesting] = useState<null | "EMAIL" | "SMS">(null);
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function runTest(channel: "EMAIL" | "SMS") {
    setTesting(channel);
    setMsg(null);
    const res = await fetch("/api/settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, to }),
    });
    setTesting(null);
    const data = await res.json();
    if (res.ok) setMsg(`${channel} test sent.`);
    else setMsg(data.error ?? "Test failed");
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-medium">Providers</h2>
        <p className="text-xs text-slate-500">
          Credentials are read from <code>.env</code> at startup. Change them there and restart the app.
        </p>
      </div>

      <div className="grid gap-3">
        <Row label="SMTP (email)" on={providers.smtp} vars={["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]} />
        <Row label="Twilio (SMS)" on={providers.twilio} vars={["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]} />
        <Row label="Calendly" on={providers.calendly} vars={["CALENDLY_TOKEN", "CALENDLY_ORG_URI"]} />
      </div>

      <div>
        <label className="label">Send test</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input max-w-sm"
            placeholder="you@example.com or +15551234567"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <button
            type="button"
            className="btn-ghost"
            disabled={!to || !providers.smtp || testing !== null}
            onClick={() => runTest("EMAIL")}
          >
            {testing === "EMAIL" ? "Sending..." : "Test email"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={!to || !providers.twilio || testing !== null}
            onClick={() => runTest("SMS")}
          >
            {testing === "SMS" ? "Sending..." : "Test SMS"}
          </button>
        </div>
        {msg && <div className="mt-2 text-sm text-slate-600">{msg}</div>}
      </div>
    </div>
  );
}

async function savePacing(value: Pacing) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "pacing", value }),
  });
  if (!res.ok) throw new Error("Save failed");
}

function PacingCard({ initial }: { initial: Pacing }) {
  const [s, setS] = useState<Pacing>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="card space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try { await savePacing(s); setMsg("Saved."); } catch { setMsg("Failed."); }
      }}
    >
      <h2 className="font-medium">Send pacing</h2>
      <p className="text-xs text-slate-500">Random gap between enqueues. Helps email reach the inbox.</p>
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <label className="label">Min gap (seconds)</label>
          <input type="number" min={0} className="input" value={s.minSec}
                 onChange={(e) => setS({ ...s, minSec: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">Max gap (seconds)</label>
          <input type="number" min={0} className="input" value={s.maxSec}
                 onChange={(e) => setS({ ...s, maxSec: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">Daily cap / domain</label>
          <input type="number" min={0} className="input" value={s.dailyCapPerDomain}
                 onChange={(e) => setS({ ...s, dailyCapPerDomain: Number(e.target.value) })} />
        </div>
      </div>
      <button className="btn-primary">Save pacing</button>
      {msg && <div className="text-sm text-slate-600">{msg}</div>}
    </form>
  );
}
