import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ContractStatusBadge } from './bits.jsx';
import ContractSendModal from './ContractSendModal.jsx';
import { errText, fmtDay } from './fmt.js';
import './ct-admin.css';

// "New contract" from the Contracts page: pick a closed lot (GET
// /api/lots?closed=1), then the same dialog as the lot page's "Prepare
// agreement". Lots that already have a current contract are listed but
// can't be picked — their contract is managed from the lot or its page.
export default function NewContractModal({ onClose, onCreated }) {
  const [q, setQ] = useState('');
  const [lots, setLots] = useState(null);
  const [err, setErr] = useState('');
  const [lot, setLot] = useState(null);
  const [opening, setOpening] = useState('');

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api
        .get(`/api/lots?closed=1&limit=100${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`)
        .then((r) => live && setLots(Array.isArray(r) ? r : []))
        .catch((e) => live && setErr(errText(e)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  async function pick(l) {
    setOpening(l._id);
    setErr('');
    try {
      // Full lot (buyers, model, closing, project) for the prefill.
      const d = await api.get(`/api/lots/${l._id}`);
      setLot(d.lot);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setOpening('');
    }
  }

  if (lot) {
    return (
      <ContractSendModal
        lot={lot}
        contract={null}
        onClose={onClose}
        onSaved={(detail, { close } = {}) => {
          if (close) onCreated(detail);
        }}
      />
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="ct-head">
          <h2>New monitoring contract</h2>
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary small" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Choose a closed lot. To close a lot, open it from the <Link to="/board">Board</Link> and use <em>Mark closed</em> in its Alarm
          monitoring card.
        </p>
        <input autoFocus placeholder="Search lot #, address or buyer…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
        {err && <div className="error">{err}</div>}
        {lots == null ? (
          <div className="muted">Loading…</div>
        ) : lots.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>
            No closed lots{q ? ' match' : ' yet'}.
          </div>
        ) : (
          <div className="ct-lot-pick">
            {lots.map((l) => {
              const has = Boolean(l.contract);
              const buyers = (l.buyers || []).map((b) => b.name).filter(Boolean).join(', ');
              return (
                <button key={l._id} type="button" disabled={has || !!opening} onClick={() => pick(l)} title={has ? 'This lot already has a contract' : 'Prepare its agreement'}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>Lot {l.lotNumber}</strong> <span className="muted">· {l.project?.name || ''}</span>
                    <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {buyers || 'no buyers'}
                      {l.closing?.closingDate ? ` · closed ${fmtDay(l.closing.closingDate)}` : ''}
                    </div>
                  </div>
                  {has ? (
                    <>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {l.contract.number}
                      </span>
                      <ContractStatusBadge status={l.contract.status} />
                    </>
                  ) : opening === l._id ? (
                    <span className="muted">Opening…</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
