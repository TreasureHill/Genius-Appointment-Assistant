"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ImportSummary = {
  added: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
};

export function ProjectTools({ projectId }: { projectId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/import", { method: "POST", body: fd });
    setBusy(false);
    if (!res.ok) {
      alert("Import failed");
      return;
    }
    const data = (await res.json()) as ImportSummary;
    setResult(data);
    router.refresh();
  }

  return (
    <div className="card">
      <div className="flex flex-wrap gap-3">
        <a className="btn-ghost" href="/api/import/template">Download blank template</a>
        <a className="btn-ghost" href={`/api/export?projectId=${projectId}`}>Export current</a>
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? "Importing..." : "Import sheet"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={onImport}
        />
      </div>
      {result && (
        <div className="mt-3 text-sm">
          <div>
            Added <strong>{result.added}</strong> · Updated{" "}
            <strong>{result.updated}</strong> · Skipped <strong>{result.skipped}</strong>
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-2 list-disc pl-6 text-red-600">
              {result.errors.map((e, i) => (
                <li key={i}>Row {e.row}: {e.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
