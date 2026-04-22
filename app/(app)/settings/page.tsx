import { getSetting } from "@/lib/settings";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const [smtp, twilio, calendly, pacing] = await Promise.all([
    getSetting<Record<string, unknown>>("smtp"),
    getSetting<Record<string, unknown>>("twilio"),
    getSetting<Record<string, unknown>>("calendly"),
    getSetting<Record<string, unknown>>("pacing"),
  ]);
  const redact = (obj: Record<string, unknown> | null, fields: string[]) => {
    if (!obj) return null;
    const out = { ...obj };
    for (const f of fields) if (out[f]) out[f] = "********";
    return out;
  };
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <SettingsForm
        initial={{
          smtp: redact(smtp, ["pass"]),
          twilio: redact(twilio, ["authToken"]),
          calendly: redact(calendly, ["token"]),
          pacing: pacing ?? { minSec: 45, maxSec: 180, dailyCapPerDomain: 200 },
        }}
      />
    </div>
  );
}
