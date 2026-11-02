import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { PACKAGE_LABEL, SIGNING_MODE_LABEL, fmtMoney } from './bits.jsx';
import { ROLE_LABEL, errText, openAfter, toDateInput, todayInput } from './fmt.js';
import './ct-admin.css';

// "Prepare agreement" / "Edit draft" dialog for one lot's monitoring
// agreement.
//
// New contract: POST /api/contracts {lotId, purchasers, property,
// signingMode, saveToLot, send?}. Existing draft: PATCH /api/contracts/:id,
// then POST /:id/send. Paper mode records an agreement already signed outside
// DocuSign: the draft is saved, then the PDF goes to POST /:id/manual-signed
// with the package and signed date, which runs the same tail as a DocuSign
// completion (portal invite, payment).
//
// Props:
//   lot       — the lot (buyers, model, address, closing, project); for an
//               existing draft only its id/project are needed
//   contract  — the draft being edited (or null for a new one)
//   alarm     — Settings `alarm` block (default signing mode, packages);
//               fetched when not given
//   onSaved(detail, {close}) — after any save; the parent reloads
//   onClose()
const MODES = ['remote', 'in_person', 'paper'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PURCHASERS = 3;
const ROLES = ['buyer', 'coBuyer', 'thirdBuyer'];

const MODE_HINT = {
  remote: 'DocuSign emails each purchaser in turn. The first purchaser chooses Basic or Smart before signing.',
  in_person: 'Sign on this device at the closing. Each purchaser signs in turn on the DocuSign page; you come back here between signers.',
  paper: 'Already signed on paper or outside DocuSign. Upload the signed PDF and record the package; the homeowner then gets the portal invite.',
};

function purchaserRows(lot, contract) {
  const src = contract && Array.isArray(contract.purchasers) && contract.purchasers.length ? contract.purchasers : (lot && lot.buyers) || [];
  const rows = src
    .filter((b) => b && (b.name || b.email || b.phone))
    .slice(0, MAX_PURCHASERS)
    .map((b) => ({ role: b.role, name: b.name || '', email: b.email || '', phone: b.phone || '', signs: b.signs !== false }));
  return rows.length ? rows : [{ role: 'buyer', name: '', email: '', phone: '', signs: true }];
}

function propertyOf(lot, contract) {
  const p = (contract && contract.property) || {};
  const proj = (lot && lot.project) || {};
  return {
    projectName: p.projectName || proj.marketingName || proj.name || '',
    model: p.model ?? (lot && lot.model) ?? '',
    lotNumber: p.lotNumber || (lot && lot.lotNumber) || '',
    address: p.address || (lot && lot.address) || '',
    closingDate: toDateInput(p.closingDate || (lot && lot.closing && lot.closing.closingDate)),
  };
}

export default function ContractSendModal({ lot, contract, alarm: alarmProp, onSaved, onClose }) {
  const [alarm, setAlarm] = useState(alarmProp || null);
  const [contractId, setContractId] = useState(contract ? contract._id : null);
  const [purchasers, setPurchasers] = useState(() => purchaserRows(lot, contract));
  const [property, setProperty] = useState(() => propertyOf(lot, contract));
  const [mode, setMode] = useState(contract ? contract.signingMode : null);
  const [saveToLot, setSaveToLot] = useState(true);
  const [paper, setPaper] = useState({ file: null, package: '', signedAt: todayInput(), note: '' });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [consentUrl, setConsentUrl] = useState('');
  const [touched, setTouched] = useState(false);
  // Editing: the lot card only has a summary of the draft (no phones, no
  // property snapshot), so load the full contract before showing the form.
  const [loading, setLoading] = useState(Boolean(contract && !contract.property));

  useEffect(() => {
    if (!contract || contract.property) return;
    let live = true;
    api
      .get(`/api/contracts/${contract._id}`)
      .then((d) => {
        if (!live) return;
        setPurchasers(purchaserRows(lot, d.contract));
        setProperty(propertyOf(lot, d.contract));
        setMode(d.contract.signingMode);
      })
      .catch((e) => live && setErr(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [contract && contract._id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (alarmProp) return;
    api
      .get('/api/settings')
      .then((s) => setAlarm(s.alarm || {}))
      .catch(() => setAlarm({}));
  }, [alarmProp]);

  // Default signing mode from Settings once it is known (new contracts).
  useEffect(() => {
    if (mode == null && alarm) setMode(alarm.defaultSigningMode || 'remote');
  }, [alarm, mode]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const signingMode = mode || 'remote';
  const isPaper = signingMode === 'paper';
  const packages = (alarm && alarm.packages) || [];
  const lotId = (lot && lot._id) || (contract && (contract.lot?._id || contract.lot));

  // Inline validation. Couples sharing one inbox are fine (DocuSign accepts
  // the same email for two recipients with different names).
  const problems = useMemo(() => {
    const out = [];
    const rows = purchasers.filter((p) => p.name || p.email || p.phone);
    if (!rows.length) out.push('Add at least one purchaser.');
    rows.forEach((p, i) => {
      if (!p.name.trim()) out.push(`Purchaser ${i + 1} needs a name.`);
      if (p.email && !EMAIL_RE.test(p.email.trim())) out.push(`"${p.email}" is not a valid email.`);
    });
    if (!isPaper && rows.some((p) => p.signs && !p.email.trim())) {
      out.push('Each purchaser needs a valid email — DocuSign uses it for their signed copy.');
    }
    if (!isPaper && !rows.some((p) => p.signs)) out.push('At least one purchaser must sign.');
    return out;
  }, [purchasers, isPaper]);

  function setRow(i, patch) {
    setPurchasers((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function addRow() {
    setPurchasers((prev) => {
      if (prev.length >= MAX_PURCHASERS) return prev;
      const used = new Set(prev.map((p) => p.role));
      return [...prev, { role: ROLES.find((r) => !used.has(r)) || 'thirdBuyer', name: '', email: '', phone: '', signs: true }];
    });
  }
  function removeRow(i) {
    setPurchasers((prev) => prev.filter((_, idx) => idx !== i));
  }

  function payload() {
    return {
      purchasers: purchasers
        .filter((p) => p.name || p.email || p.phone)
        .map((p) => ({ role: p.role, name: p.name.trim(), email: p.email.trim(), phone: p.phone.trim(), signs: p.signs })),
      property: { ...property, closingDate: property.closingDate || null },
      signingMode,
    };
  }

  function fail(e) {
    setErr(errText(e));
    setConsentUrl((e.data && e.data.consentUrl) || '');
  }

  // Create or update the draft. Returns the detail payload.
  async function saveDraft() {
    if (contractId) return api.patch(`/api/contracts/${contractId}`, payload());
    const detail = await api.post('/api/contracts', { lotId, ...payload(), saveToLot });
    setContractId(detail.contract._id);
    return detail;
  }

  async function run(kind, fn) {
    setTouched(true);
    if (problems.length || loading) return;
    setBusy(kind);
    setErr('');
    setConsentUrl('');
    try {
      await fn();
    } catch (e) {
      // A create-and-send that failed at DocuSign still created the draft:
      // keep editing that one instead of creating a second.
      if (e.data && e.data.created && e.data.contract) {
        setContractId(e.data.contract._id);
        onSaved && onSaved(e.data, { close: false });
      }
      fail(e);
    } finally {
      setBusy('');
    }
  }

  const save = () =>
    run('save', async () => {
      const detail = await saveDraft();
      onSaved && onSaved(detail, { close: true });
    });

  const preview = () =>
    run('preview', () =>
      openAfter(async () => {
        const detail = await saveDraft();
        onSaved && onSaved(detail, { close: false });
        return `/api/contracts/${detail.contract._id}/agreement-preview.pdf`;
      })
    );

  const send = () =>
    run('send', async () => {
      let detail;
      if (contractId) {
        await api.patch(`/api/contracts/${contractId}`, payload());
        detail = await api.post(`/api/contracts/${contractId}/send`);
      } else {
        detail = await api.post('/api/contracts', { lotId, ...payload(), saveToLot, send: true });
        setContractId(detail.contract._id);
      }
      onSaved && onSaved(detail, { close: true, sent: true });
    });

  const recordPaper = () => {
    if (!paper.file) {
      setTouched(true);
      setErr('Attach the signed agreement (PDF).');
      return;
    }
    if (!paper.package) {
      setErr('Choose the package the homeowner signed for.');
      return;
    }
    return run('paper', async () => {
      const draft = await saveDraft();
      const fd = new FormData();
      fd.append('file', paper.file);
      fd.append('package', paper.package);
      fd.append('signedAt', paper.signedAt || todayInput());
      if (paper.note.trim()) fd.append('note', paper.note.trim());
      const detail = await api.upload(`/api/contracts/${draft.contract._id}/manual-signed`, fd);
      onSaved && onSaved(detail, { close: true, sent: true });
    });
  };

  const isNew = !contractId;
  const title = contract ? `Edit ${contract.number}` : isNew ? 'Prepare monitoring agreement' : 'Monitoring agreement (draft saved)';

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <form
        className="card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (isPaper) recordPaper();
          else send();
        }}
        style={{ maxWidth: 760 }}
        aria-label={title}
      >
        <div className="ct-head">
          <h2>{title}</h2>
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary small" onClick={onClose} disabled={!!busy} aria-label="Close">
            Close
          </button>
        </div>
        {lot && (
          <div className="muted" style={{ fontSize: 13 }}>
            Lot {lot.lotNumber || property.lotNumber}
            {property.projectName ? ` · ${property.projectName}` : ''}
          </div>
        )}

        {loading && <div className="muted">Loading the draft…</div>}

        <h3 style={{ marginBottom: 4 }}>Purchasers</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          Filled in from the lot’s buyers. The first purchaser signs first and chooses the package; the others sign after.
          Purchasers who share one inbox can both sign.
        </div>
        {purchasers.map((p, i) => (
          <div key={i} className="row" style={{ marginBottom: 8, alignItems: 'flex-end' }}>
            <div style={{ minWidth: 92, flex: '0 0 92px', paddingBottom: 9, fontSize: 13 }}>
              <strong>{i + 1}.</strong> {ROLE_LABEL[p.role] || p.role}
            </div>
            <div>
              <label>Name</label>
              <input value={p.name} onChange={(e) => setRow(i, { name: e.target.value })} />
            </div>
            <div>
              <label>Email</label>
              <input type="email" value={p.email} onChange={(e) => setRow(i, { email: e.target.value })} />
            </div>
            <div style={{ minWidth: 130 }}>
              <label>Phone</label>
              <input value={p.phone} onChange={(e) => setRow(i, { phone: e.target.value })} />
            </div>
            <div style={{ flex: '0 0 auto', minWidth: 0, paddingBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <label className="ct-check" style={{ margin: 0 }} title="Uncheck for a purchaser who will not sign the monitoring agreement">
                <input type="checkbox" checked={p.signs} onChange={(e) => setRow(i, { signs: e.target.checked })} /> Signs
              </label>
              {purchasers.length > 1 && (
                <button type="button" className="secondary small" onClick={() => removeRow(i)} title="Remove this purchaser">
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {purchasers.length < MAX_PURCHASERS && (
            <button type="button" className="secondary small" onClick={addRow}>
              Add purchaser
            </button>
          )}
          {isNew && lot && (
            <label className="ct-check">
              <input type="checkbox" checked={saveToLot} onChange={(e) => setSaveToLot(e.target.checked)} /> Save changes to the lot’s buyers
              and model
            </label>
          )}
        </div>

        <h3 style={{ marginBottom: 4 }}>Property</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          Printed on the agreement. Frozen once it is sent.
        </div>
        <div className="row">
          <div style={{ flex: 2 }}>
            <label>Project</label>
            <input value={property.projectName} onChange={(e) => setProperty({ ...property, projectName: e.target.value })} />
          </div>
          <div>
            <label>Model</label>
            <input value={property.model} placeholder="e.g. A3END A" onChange={(e) => setProperty({ ...property, model: e.target.value })} />
          </div>
          <div style={{ minWidth: 100 }}>
            <label>Lot</label>
            <input value={property.lotNumber} onChange={(e) => setProperty({ ...property, lotNumber: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 3 }}>
            <label>Address</label>
            <input value={property.address} onChange={(e) => setProperty({ ...property, address: e.target.value })} />
          </div>
          <div>
            <label>Closing date</label>
            <input type="date" value={property.closingDate} onChange={(e) => setProperty({ ...property, closingDate: e.target.value })} />
          </div>
        </div>

        <h3 style={{ marginBottom: 4 }}>How it gets signed</h3>
        <div className="ct-radio-group" role="radiogroup" aria-label="Signing mode">
          {MODES.map((m) => (
            <label key={m}>
              <input type="radio" name="signingMode" value={m} checked={signingMode === m} onChange={() => setMode(m)} />
              <span>
                {SIGNING_MODE_LABEL[m]}
                <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                  {MODE_HINT[m]}
                </div>
              </span>
            </label>
          ))}
        </div>

        {isPaper && (
          <div className="card" style={{ background: 'var(--panel-subtle)', marginBottom: 8 }}>
            <div className="row">
              <div style={{ flex: 2 }}>
                <label>Signed agreement (PDF, up to 15 MB)</label>
                <input type="file" accept="application/pdf,.pdf" onChange={(e) => setPaper({ ...paper, file: e.target.files[0] || null })} />
              </div>
              <div>
                <label>Signed on</label>
                <input type="date" value={paper.signedAt} max={todayInput()} onChange={(e) => setPaper({ ...paper, signedAt: e.target.value })} />
              </div>
            </div>
            <label>Package signed for</label>
            <select value={paper.package} onChange={(e) => setPaper({ ...paper, package: e.target.value })}>
              <option value="">Choose…</option>
              {(packages.length ? packages : Object.keys(PACKAGE_LABEL).map((k) => ({ package: k }))).map((q) => (
                <option key={q.package} value={q.package}>
                  {PACKAGE_LABEL[q.package] || q.label || q.package}
                  {q.totalCents != null ? ` — ${fmtMoney(q.unitCents)} + HST = ${fmtMoney(q.totalCents)}/month` : ''}
                </option>
              ))}
            </select>
            <label>Note (optional)</label>
            <input value={paper.note} placeholder="e.g. signed at the closing table, original in the lot file" onChange={(e) => setPaper({ ...paper, note: e.target.value })} />
          </div>
        )}

        {touched && problems.length > 0 && (
          <div className="error">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        {err && (
          <div className="error">
            {err}
            {consentUrl && (
              <>
                {' '}
                <a href={consentUrl} target="_blank" rel="noreferrer">
                  Grant DocuSign consent
                </a>
                , then try again.
              </>
            )}
          </div>
        )}

        <div className="ct-actions" style={{ marginTop: 14 }}>
          {isPaper ? (
            <button type="submit" disabled={!!busy}>
              {busy === 'paper' ? 'Recording…' : 'Record signed agreement'}
            </button>
          ) : (
            <button type="submit" disabled={!!busy} title="Save, then create the DocuSign envelope">
              {busy === 'send' ? 'Sending…' : signingMode === 'in_person' ? 'Create for in-person signing' : 'Send for signature'}
            </button>
          )}
          <button type="button" className="secondary" onClick={save} disabled={!!busy}>
            {busy === 'save' ? 'Saving…' : 'Save draft'}
          </button>
          {!isPaper && (
            <button type="button" className="secondary" onClick={preview} disabled={!!busy} title="Saves the draft and opens the agreement PDF in a new tab">
              {busy === 'preview' ? 'Building…' : 'Preview PDF'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
