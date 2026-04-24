import { useState } from 'react';
import { api } from '../api';

export default function SheetImport() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [updateExisting, setUpdate] = useState(false);

  async function downloadTemplate() {
    const res = await api.raw('/api/sheets/template');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'genius-contacts-template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doPreview() {
    if (!file) return;
    setErr('');
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const p = await api.upload('/api/sheets/preview', fd);
      setPreview(p);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.upload(
        `/api/sheets/import${updateExisting ? '?update=true' : ''}`,
        fd
      );
      setResult(r);
      setPreview(null);
      setFile(null);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Import / Export</h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Template sheet</h2>
        <p className="muted">
          Download a blank xlsx with all expected columns. Fill a row per lot per project, then
          upload below. Existing lots (matched by project + lot #) are skipped by default; only new
          rows are added.
        </p>
        <button className="secondary" onClick={downloadTemplate}>
          Download blank template
        </button>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Upload sheet</h2>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setPreview(null);
            setResult(null);
          }}
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={doPreview} disabled={!file || busy}>
            {busy ? 'Working…' : 'Preview changes'}
          </button>
          <label style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(e) => setUpdate(e.target.checked)}
            />{' '}
            Update existing lots on commit (overwrite buyers/address/rep)
          </label>
        </div>
        {err && <div className="error">{err}</div>}
      </div>

      {preview && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Preview</h2>
          <div className="tiles">
            <div className="tile">
              <div className="label">Rows</div>
              <div className="value">{preview.totalRows}</div>
            </div>
            <div className="tile">
              <div className="label">New lots</div>
              <div className="value">{preview.toCreate.length}</div>
            </div>
            <div className="tile">
              <div className="label">Existing (skipped)</div>
              <div className="value">{preview.toSkip.length}</div>
            </div>
            <div className="tile">
              <div className="label">Projects referenced</div>
              <div className="value">{preview.projects.length}</div>
            </div>
          </div>
          {preview.projects.some((p) => p.isNew) && (
            <p className="muted">
              New projects will be auto-created:{' '}
              {preview.projects.filter((p) => p.isNew).map((p) => p.name).join(', ')}
            </p>
          )}
          {preview.warnings.length > 0 && (
            <div className="error">
              {preview.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          <h3>Will create ({preview.toCreate.length})</h3>
          <div style={{ maxHeight: 240, overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Project</th>
                  <th>Lot #</th>
                  <th>Address</th>
                  <th>Buyers</th>
                </tr>
              </thead>
              <tbody>
                {preview.toCreate.slice(0, 200).map((r, i) => (
                  <tr key={i}>
                    <td>{r.rowNumber}</td>
                    <td>{r.projectName}</td>
                    <td>{r.lotNumber}</td>
                    <td>{r.address}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {r.buyers.map((b) => b.name || b.email).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={commit} disabled={busy}>
              {busy ? 'Importing…' : `Commit import (${preview.toCreate.length} new)`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Import complete</h2>
          <ul>
            <li>Created projects: {result.createdProjects}</li>
            <li>Created lots: {result.createdLots}</li>
            <li>Updated lots: {result.updatedLots}</li>
            <li>Skipped lots: {result.skippedLots}</li>
          </ul>
          {result.warnings.length > 0 && (
            <div className="error">
              {result.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Export everything</h2>
        <p className="muted">Download all lots across all projects as an xlsx file.</p>
        <button
          className="secondary"
          onClick={async () => {
            const res = await api.raw('/api/sheets/export');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'genius-contacts-export.xlsx';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download all lots
        </button>
      </div>
    </div>
  );
}
