"use client";

import { useState } from "react";

type Initial = {
  smtp: Record<string, unknown> | null;
  twilio: Record<string, unknown> | null;
  calendly: Record<string, unknown> | null;
  pacing: Record<string, unknown>;
};

export function SettingsForm({ initial }: { initial: Initial }) {
  return (
    <div className="space-y-6">
      <SmtpCard initial={(initial.smtp ?? {}) as Record<string, string | number | boolean>} />
      <TwilioCard initial={(initial.twilio ?? {}) as Record<string, string>} />
      <CalendlyCard initial={(initial.calendly ?? {}) as Record<string, string>} />
      <PacingCard initial={initial.pacing as { minSec: number; maxSec: number; dailyCapPerDomain: number }} />
    </div>
  );
}

async function saveKey(key: string, value: unknown) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Save failed");
}

async function sendTest(channel: "EMAIL" | "SMS", to: string) {
  const res = await fetch("/api/settings/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, to }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Test failed");
}

function SmtpCard({ initial }: { initial: Record<string, string | number | boolean> }) {
  const [s, setS] = useState({
    host: String(initial.host ?? ""),
    port: Number(initial.port ?? 587),
    secure: Boolean(initial.secure ?? false),
    user: String(initial.user ?? ""),
    pass: String(initial.pass ?? ""),
    from: String(initial.from ?? ""),
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState("");

  return (
    <form className="card space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      try { await saveKey("smtp", s); setMsg("Saved."); } catch { setMsg("Failed."); }
    }}>
      <h2 className="font-medium">SMTP</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <div><label className="label">Host</label><input className="input" value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} /></div>
        <div><label className="label">Port</label><input type="number" className="input" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) })} /></div>
        <div>
          <label className="label">TLS</label>
          <select className="input" value={s.secure ? "1" : "0"} onChange={(e) => setS({ ...s, secure: e.target.value === "1" })}>
            <option value="0">STARTTLS / None</option>
            <option value="1">Implicit TLS</option>
          </select>
        </div>
        <div><label className="label">Username</label><input className="input" value={s.user} onChange={(e) => setS({ ...s, user: e.target.value })} /></div>
        <div><label className="label">Password</label><input className="input" type="password" value={s.pass} onChange={(e) => setS({ ...s, pass: e.target.value })} /></div>
        <div><label className="label">From</label><input className="input" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} /></div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <button className="btn-primary">Save SMTP</button>
        <div className="flex-1" />
        <div>
          <label className="label">Send test to</label>
          <div className="flex gap-2">
            <input className="input" placeholder="you@example.com" value={test} onChange={(e) => setTest(e.target.value)} />
            <button type="button" className="btn-ghost" onClick={async () => {
              try { await sendTest("EMAIL", test); setMsg("Test email sent."); }
              catch (err) { setMsg((err as Error).message); }
            }}>Send test</button>
          </div>
        </div>
      </div>
      {msg && <div className="text-sm text-slate-600">{msg}</div>}
    </form>
  );
}

function TwilioCard({ initial }: { initial: Record<string, string> }) {
  const [s, setS] = useState({
    accountSid: initial.accountSid ?? "",
    authToken: initial.authToken ?? "",
    fromNumber: initial.fromNumber ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState("");

  return (
    <form className="card space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      try { await saveKey("twilio", s); setMsg("Saved."); } catch { setMsg("Failed."); }
    }}>
      <h2 className="font-medium">Twilio</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <div><label className="label">Account SID</label><input className="input" value={s.accountSid} onChange={(e) => setS({ ...s, accountSid: e.target.value })} /></div>
        <div><label className="label">Auth Token</label><input type="password" className="input" value={s.authToken} onChange={(e) => setS({ ...s, authToken: e.target.value })} /></div>
        <div><label className="label">From number</label><input className="input" value={s.fromNumber} onChange={(e) => setS({ ...s, fromNumber: e.target.value })} /></div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <button className="btn-primary">Save Twilio</button>
        <div className="flex-1" />
        <div>
          <label className="label">Send test to</label>
          <div className="flex gap-2">
            <input className="input" placeholder="+15551234567" value={test} onChange={(e) => setTest(e.target.value)} />
            <button type="button" className="btn-ghost" onClick={async () => {
              try { await sendTest("SMS", test); setMsg("Test SMS sent."); }
              catch (err) { setMsg((err as Error).message); }
            }}>Send test</button>
          </div>
        </div>
      </div>
      {msg && <div className="text-sm text-slate-600">{msg}</div>}
    </form>
  );
}

function CalendlyCard({ initial }: { initial: Record<string, string> }) {
  const [s, setS] = useState({
    token: initial.token ?? "",
    orgUri: initial.orgUri ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <form className="card space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      try { await saveKey("calendly", s); setMsg("Saved."); } catch { setMsg("Failed."); }
    }}>
      <h2 className="font-medium">Calendly</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <div><label className="label">Personal access token</label><input type="password" className="input" value={s.token} onChange={(e) => setS({ ...s, token: e.target.value })} /></div>
        <div><label className="label">Organisation URI</label><input className="input" value={s.orgUri} onChange={(e) => setS({ ...s, orgUri: e.target.value })} placeholder="https://api.calendly.com/organizations/..." /></div>
      </div>
      <p className="text-xs text-slate-500">
        Add a webhook in Calendly pointing to <code>/api/webhooks/calendly</code> for real-time updates.
        The reconciler also runs every 15 minutes as a safety net.
      </p>
      <button className="btn-primary">Save Calendly</button>
      {msg && <div className="text-sm text-slate-600">{msg}</div>}
    </form>
  );
}

function PacingCard({ initial }: { initial: { minSec: number; maxSec: number; dailyCapPerDomain: number } }) {
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form className="card space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      try { await saveKey("pacing", s); setMsg("Saved."); } catch { setMsg("Failed."); }
    }}>
      <h2 className="font-medium">Send pacing</h2>
      <p className="text-xs text-slate-500">Random gap between enqueues. Helps email reach the inbox.</p>
      <div className="grid gap-3 md:grid-cols-3">
        <div><label className="label">Min gap (seconds)</label><input type="number" min={0} className="input" value={s.minSec} onChange={(e) => setS({ ...s, minSec: Number(e.target.value) })} /></div>
        <div><label className="label">Max gap (seconds)</label><input type="number" min={0} className="input" value={s.maxSec} onChange={(e) => setS({ ...s, maxSec: Number(e.target.value) })} /></div>
        <div><label className="label">Daily cap / domain</label><input type="number" min={0} className="input" value={s.dailyCapPerDomain} onChange={(e) => setS({ ...s, dailyCapPerDomain: Number(e.target.value) })} /></div>
      </div>
      <button className="btn-primary">Save pacing</button>
      {msg && <div className="text-sm text-slate-600">{msg}</div>}
    </form>
  );
}
