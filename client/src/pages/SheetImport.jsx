import { useEffect, useState } from 'react';
import { api } from '../api';

export default function SheetImport() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [updateExisting, setUpdate] = useState(false);
  const [imports, setImports] = useState([]);
  const [marketingNames, setMarketingNames] = useState({});

  async function loadImports() {
    try {
      const rows = await api.get('/api/sheets/imports');
      setImports(rows);
    } catch {}
  }
  useEffect(() => {
    loadImports();
  }, []);

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
    // Force a marketing name for every new project before committing.
    const newProjects = (preview?.projects || []).filter((p) => p.isNew);
    const missing = newProjects.filter((p) => !(marketingNames[p.name] || '').trim());
    if (missing.length) {
      setErr(`Enter a marketing name for new project${missing.length === 1 ? '' : 's'}: ${missing.map((p) => p.name).join(', ')}`);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('marketingNames', JSON.stringify(marketingNames));
      const r = await api.upload(
        `/api/sheets/import${updateExisting ? '?update=true' : ''}`,
        fd
      );
      setResult(r);
      setPreview(null);
      setFile(null);
      loadImports();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function revert(batchId) {
    if (!confirm('Revert this import? It will delete the lots it created and restore any lots it overwrote.')) return;
    try {
      const r = await api.post(`/api/sheets/imports/${batchId}/revert`);
      alert(
        `Reverted: deleted ${r.deletedLots} lot${r.deletedLots === 1 ? '' : 's'}, ` +
          `restored ${r.restoredLots}, removed ${r.deletedProjects} empty project${
            r.deletedProjects === 1 ? '' : 's'
          }.`
      );
      loadImports();
    } catch (ex) {
      alert('Revert failed: ' + ex.message);
    }
  }

  return (
    <div>
      <h1>Import / Export</h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Template sheet</h2>
        <p className="muted">
          Download the blank xlsx with the expected columns. The <span className="kbd">Project</span>{' '}
          column determines which project each lot gets assigned to. Projects that don't exist yet
          will be auto-created; lots under existing projects will be added to them.
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
            Update existing lots on commit (overwrite buyers / address)
          </label>
        </div>
        {err && <div className="error">{err}</div>}
      </div>

      {preview && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Preview</h2>
          <div className="tiles">
            <div className="tile">
              <div className="label">Rows in sheet</div>
              <div className="value">{preview.totalRows}</div>
            </div>
            <div className="tile">
              <div className="label">New lots (total)</div>
              <div className="value">{preview.totalNew}</div>
            </div>
            <div className="tile">
              <div className="label">Existing (skipped)</div>
              <div className="value">{preview.totalSkip}</div>
            </div>
            <div className="tile">
              <div className="label">Projects</div>
              <div className="value">{preview.projects.length}</div>
            </div>
            <div className="tile">
              <div className="label">New projects</div>
              <div className="value">{preview.newProjectCount}</div>
            </div>
          </div>

          {preview.warnings.length > 0 && (
            <div className="error">
              {preview.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          {preview.projects.map((p) => (
            <div key={p.name} style={{ marginTop: 12 }}>
              <h3 style={{ margin: '8px 0 4px' }}>
                {p.name}{' '}
                {p.isNew ? (
                  <span className="badge err" style={{ background: '#dbeafe', color: '#1e40af' }}>
                    new project
                  </span>
                ) : (
                  <span className="badge ok">existing project</span>
                )}
              </h3>
              {p.isNew && (
                <div style={{ margin: '4px 0 10px', maxWidth: 460 }}>
                  <label style={{ fontSize: 12 }}>
                    Marketing name <span style={{ color: 'var(--danger)' }}>*</span> — the
                    customer-facing name Aria speaks on calls
                  </label>
                  <input
                    value={marketingNames[p.name] || ''}
                    onChange={(e) =>
                      setMarketingNames((m) => ({ ...m, [p.name]: e.target.value }))
                    }
                    placeholder="e.g. Union Village"
                    style={
                      !(marketingNames[p.name] || '').trim()
                        ? { borderColor: 'var(--danger)' }
                        : undefined
                    }
                  />
                </div>
              )}
              <div className="muted" style={{ fontSize: 12 }}>
                {p.toCreate.length} new lot{p.toCreate.length === 1 ? '' : 's'} ·{' '}
                {p.toSkip.length} existing (skipped)
                {updateExisting && p.toSkip.length > 0 && ' — will be overwritten on commit'}
              </div>
              {p.toCreate.length > 0 && (
                <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 4 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Lot #</th>
                        <th>Address</th>
                        <th>Buyers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.toCreate.slice(0, 50).map((r, i) => (
                        <tr key={i}>
                          <td>{r.rowNumber}</td>
                          <td>{r.lotNumber}</td>
                          <td>{r.address}</td>
                          <td className="muted" style={{ fontSize: 12 }}>
                            {r.buyers.map((b) => b.name || b.email).filter(Boolean).join(' · ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {p.toCreate.length > 50 && (
                    <div className="muted" style={{ fontSize: 12, padding: 6 }}>
                      …and {p.toCreate.length - 50} more
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          <div style={{ marginTop: 16 }}>
            <button onClick={commit} disabled={busy}>
              {busy ? 'Importing…' : `Commit import (${preview.totalNew} new)`}
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
          <p className="muted" style={{ marginBottom: 0 }}>
            You can revert this import below.
          </p>
        </div>
      )}

      <h2>Previous imports</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>File</th>
              <th>New projects</th>
              <th>New lots</th>
              <th>Overwrites</th>
              <th>Mode</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {imports.map((b) => (
              <tr key={b._id}>
                <td className="nowrap">{new Date(b.createdAt).toLocaleString()}</td>
                <td>{b.filename || <span className="muted">(unnamed)</span>}</td>
                <td>{(b.createdProjects || []).length}</td>
                <td>{(b.createdLots || []).length}</td>
                <td>{(b.updatedLotSnapshots || []).length}</td>
                <td className="muted">{b.updateExisting ? 'update existing' : 'add only'}</td>
                <td>
                  <span className={`badge ${b.status === 'reverted' ? 'err' : 'ok'}`}>
                    {b.status}
                  </span>
                </td>
                <td className="nowrap">
                  {b.status !== 'reverted' && (
                    <button className="danger" onClick={() => revert(b._id)}>
                      Revert
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {imports.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No imports yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Export everything</h2>
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
