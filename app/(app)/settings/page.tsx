import { getPacing } from "@/lib/settings";
import { providerStatus } from "@/lib/env";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const [pacing, providers] = await Promise.all([getPacing(), Promise.resolve(providerStatus())]);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <SettingsForm initial={{ pacing, providers }} />
    </div>
  );
}
