import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTimezone } from '../timezone.jsx';
import Tile from '../components/Tile.jsx';
import MultiSelect from '../components/MultiSelect.jsx';
import ContractsChart from '../components/contracts/ContractsChart.jsx';
import NewContractModal from '../components/contracts/NewContractModal.jsx';
import { ContractStatusBadge, PACKAGE_LABEL, downloadFile, fmtMoney } from '../components/contracts/bits.jsx';
import { errText, fmtDay, fmtDayIn, plural } from '../components/contracts/fmt.js';
import '../components/contracts/ct-admin.css';

// Monitoring contracts: every alarm monitoring agreement Genius has sold —
// signing pipeline, billing health (MRR, collected, missed payments) and a
// server-paged table for follow-up and accounting. Same conventions as the
// Reviews tab: filters live in the URL (useSearchParams), tiles apply a
// filter, `refreshKey` reloads after an action.

const PAGE_SIZE = 50;
// Status chips in the toolbar, in lifecycle order. "Past due" covers unpaid
// too (both need a call).
const STATUS_CHIPS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Awaiting signature' },
  { value: 'awaiting_payment', label: 'Awaiting payment' },
  { value: 'active', label: 'Active' },
  { value: 'past_due,unpaid', label: 'Past due' },
  { value: 'canceled', label: 'Cancelled' },
  { value: 'declined,voided', label: 'Declined / voided' },
];
// Filters that are cleared when another tile/chip is picked, so a tile always
// shows exactly what it counts.
const TILE_KEYS = ['status', 'due', 'missed', 'needsAttention', 'page'];

function SortTh({ label, k, sort, onSort, title }) {
  const active = sort === k || sort === `-${k}`;
  const desc = sort === `-${k}`;
  return (
    <th title={title}>
      <button
        type="button"
        className="btn-link"
        style={{ padding: 0, border: 'none', background: 'none', font: 'inherit', color: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit' }}
        onClick={() => onSort(active && !desc ? `-${k}` : k)}
        aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
      >
        {label}
        {active ? (desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
}

function Bars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => (
    <div key={r.key} className="ct-bar-row">
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>
        {r.label}
      </div>
      <div className="rv-bar" aria-hidden="true">
        <span style={{ width: `${(100 * r.value) / max}%`, background: r.color || 'var(--primary)' }} />
      </div>
      <div className="muted nowrap" style={{ fontSize: 12 }}>
        {r.hint}
      </div>
    </div>
  ));
}

export default function Contracts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { timezone: tz } = useTimezone();
  const [settings, setSettings] = useState(null);
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState(null);
  const [projects, setProjects] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [loadingRows, setLoadingRows] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toggling, setToggling] = useState('');
  const [qDraft, setQDraft] = useState(searchParams.get('q') || '');

  const f = useMemo(
    () => ({
      status: searchParams.get('status') || '',
      project: searchParams.get('project') || '',
      q: searchParams.get('q') || '',
      due: searchParams.get('due') || '',
      reminders: searchParams.get('reminders') || '',
      missed: searchParams.get('missed') || '',
      needsAttention: searchParams.get('needsAttention') || '',
      sort: searchParams.get('sort') || '',
      page: Number(searchParams.get('page')) || 1,
    }),
    [searchParams]
  );

  const setParams = useCallback(
    (patch, { keepPage = false } = {}) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '' || (k === 'page' && Number(v) <= 1)) next.delete(k);
        else next.set(k, String(v));
      }
      if (!keepPage && !('page' in patch)) next.delete('page');
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // A tile replaces the tile-type filters (status / due / missed / needs
  // attention) and keeps project, search and reminders.
  function applyTile(patch) {
    const clear = Object.fromEntries(TILE_KEYS.map((k) => [k, '']));
    const isSame = Object.entries(patch).every(([k, v]) => String(f[k] || '') === String(v));
    setParams(isSame ? clear : { ...clear, ...patch });
  }

  const listQs = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of ['status', 'project', 'q', 'due', 'reminders', 'missed', 'needsAttention', 'sort']) if (f[k]) p.set(k, f[k]);
    return p;
  }, [f]);

  useEffect(() => {
    api.get('/api/settings').then(setSettings).catch(() => setSettings({}));
    api
      .get('/api/projects')
      .then((r) => setProjects(Array.isArray(r) ? r : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    const qs = f.project ? `?projects=${encodeURIComponent(f.project)}` : '';
    api
      .get(`/api/contracts/summary${qs}`)
      .then((s) => live && setSummary(s))
      .catch((e) => live && setErr(errText(e)));
    return () => {
      live = false;
    };
  }, [f.project, refreshKey]);

  useEffect(() => {
    let live = true;
    setLoadingRows(true);
    const p = new URLSearchParams(listQs);
    p.set('page', String(f.page));
    p.set('limit', String(PAGE_SIZE));
    api
      .get(`/api/contracts?${p.toString()}`)
      .then((r) => live && setRows(r))
      .catch((e) => live && setErr(errText(e)))
      .finally(() => live && setLoadingRows(false));
    return () => {
      live = false;
    };
  }, [listQs, f.page, refreshKey]);

  // Debounced search box → URL.
  useEffect(() => {
    if (qDraft === f.q) return undefined;
    const t = setTimeout(() => setParams({ q: qDraft.trim() }), 350);
    return () => clearTimeout(t);
  }, [qDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleGlobal(path, field) {
    const alarm = (settings && settings.alarm) || {};
    setToggling(path);
    setMsg('');
    try {
      const next = await api.post(`/api/settings/alarm/${path}`, { enabled: !(alarm[field] !== false) });
      setSettings((s) => ({ ...(s || {}), alarm: { ...(s?.alarm || {}), ...next } }));
    } catch (e) {
      setMsg(`Error: ${errText(e)}`);
    } finally {
      setToggling('');
    }
  }

  async function exportCsv() {
    setExporting(true);
    setMsg('');
    try {
      await downloadFile(`/api/contracts/export.csv?${listQs.toString()}`, 'monitoring-contracts.csv');
    } catch (e) {
      setMsg(`Error: ${errText(e)}`);
    } finally {
      setExporting(false);
    }
  }

  // The page needs the summary and settings to render at all, so a failure of
  // either is shown (not an endless "Loading…") even when the table loaded.
  if (err && (!summary || !settings)) return <div className="error">{err}</div>;
  if (!summary || !settings) return <div className="muted">Loading…</div>;

  const s = summary;
  const counts = s.counts || {};
  const stripe = settings.stripe || {};
  const docusign = settings.docusign || {};
  const alarm = settings.alarm || {};
  const testMode = s.testMode || stripe.mode === 'test';

  // Setup strip: anything that stops agreements going out or payments coming in.
  const setup = [];
  if (!docusign.configured) setup.push('DocuSign is not configured, so agreements can only be recorded as paper uploads.');
  else if (docusign.health && docusign.health.checkedAt && !docusign.health.ok) setup.push(`DocuSign check failed: ${docusign.health.message}`);
  if (!stripe.configured) setup.push('Stripe is not configured, so homeowners cannot set up payment yet.');
  else if (!stripe.billable) setup.push('Stripe has no HST tax rate set (STRIPE_TAX_RATE_ID), so checkout is blocked.');
  else if (stripe.health && stripe.health.checkedAt && !stripe.health.ok) setup.push(`Stripe check failed: ${stripe.health.message}`);
  if (stripe.configured && !stripe.webhookSecretSet) setup.push('The Stripe webhook secret is not set, so payments only sync on the nightly check.');

  const pastDue = (counts.past_due || 0) + (counts.unpaid || 0);
  const items = (rows && rows.items) || [];
  const projectOptions = projects.map((p) => ({ value: p._id, label: p.name }));
  const selectedProjects = f.project ? f.project.split(',') : [];
  const mix = s.packageMix || {};

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            Monitoring contracts {testMode && <span className="ct-test-mode" title="Stripe is using a test key: no real money moves">TEST MODE</span>}
          </h1>
          <div className="muted" style={{ fontSize: 13 }}>
            Alarm monitoring agreements: signing, the monthly subscription and payments. Amounts include 13% HST unless marked pre-tax.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className={alarm.paymentRemindersEnabled === false ? '' : 'secondary'}
            onClick={() => toggleGlobal('reminders', 'paymentRemindersEnabled')}
            disabled={!!toggling}
            title="Every contract's upcoming payment reminder (each contract can also turn its own off)"
          >
            Reminders: {alarm.paymentRemindersEnabled === false ? 'off' : 'on'}
          </button>
          <button
            type="button"
            className={alarm.autoSendInvoices === false ? '' : 'secondary'}
            onClick={() => toggleGlobal('auto-invoices', 'autoSendInvoices')}
            disabled={!!toggling}
            title="Email a receipt after every payment"
          >
            Auto invoices: {alarm.autoSendInvoices === false ? 'off' : 'on'}
          </button>
          <button type="button" className="secondary" onClick={exportCsv} disabled={exporting} title="The table below with its filters, every page">
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button type="button" onClick={() => setNewOpen(true)}>
            New contract
          </button>
        </div>
      </div>

      {setup.length > 0 && (
        <div className="card alert alert-warn" style={{ padding: '12px 16px' }}>
          <strong>Setup needed.</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {setup.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <div style={{ marginTop: 4 }}>
            <Link to="/settings#monitoring-billing">Open Settings</Link>
          </div>
        </div>
      )}
      {msg && <div className={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</div>}

      <div className="tiles">
        <Tile label="Active" value={counts.active || 0} accent={counts.active ? 'ok' : ''} active={f.status === 'active'} onClick={() => applyTile({ status: 'active' })} title="Show active subscriptions" />
        <Tile label="MRR" value={fmtMoney(s.mrrCents) || '$0.00'} hint={`${fmtMoney(s.mrrInclTaxCents) || '$0.00'} incl. HST`} title="Monthly recurring revenue before HST: active, past due and unpaid" />
        <Tile label="Collected" value={fmtMoney(s.collectedCents) || '$0.00'} hint={s.collectedTaxCents ? `${fmtMoney(s.collectedTaxCents)} of it HST` : 'all time'} />
        <Tile
          label="Missed payments"
          value={s.missed?.count || 0}
          hint={s.missed?.count ? `${fmtMoney(s.missed.cents)} outstanding` : 'none'}
          accent={s.missed?.count ? 'err' : ''}
          active={f.missed === '1'}
          onClick={() => applyTile({ missed: '1' })}
          title="Contracts with a failed or uncollectible charge"
        />
        <Tile label="Past due" value={pastDue} accent={pastDue ? 'err' : ''} hint={counts.unpaid ? `${counts.unpaid} unpaid` : undefined} active={f.status === 'past_due,unpaid'} onClick={() => applyTile({ status: 'past_due,unpaid' })} />
        <Tile
          label="Awaiting signature"
          value={s.awaitingSignature?.count || 0}
          hint={s.awaitingSignature?.count ? `oldest ${plural(s.awaitingSignature.oldestDays, 'day')}` : undefined}
          active={f.status === 'sent'}
          onClick={() => applyTile({ status: 'sent' })}
        />
        <Tile
          label="Awaiting payment setup"
          value={s.awaitingPayment?.count || 0}
          hint={s.awaitingPayment?.staleCount ? `${s.awaitingPayment.staleCount} signed over 7 days ago` : undefined}
          accent={s.awaitingPayment?.staleCount ? 'warn' : ''}
          active={f.status === 'awaiting_payment'}
          onClick={() => applyTile({ status: 'awaiting_payment' })}
        />
        <Tile label="Avg months active" value={Number(s.avgMonthsActive || 0).toFixed(1)} />
        <Tile
          label="Charges next 7 days"
          value={s.upcoming7d?.count || 0}
          hint={s.upcoming7d?.count ? fmtMoney(s.upcoming7d.cents) : undefined}
          active={f.due === '7d'}
          onClick={() => applyTile({ due: '7d' })}
        />
        {counts.needsAttention > 0 && (
          <Tile label="Needs attention" value={counts.needsAttention} accent="err" active={f.needsAttention === '1'} onClick={() => applyTile({ needsAttention: '1' })} hint="package missing" />
        )}
      </div>

      <div className="rv-grid">
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: '0 0 2px' }}>Payments per month</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Last 12 months, incl. HST. Failed = charges that did not go through.
          </div>
          <ContractsChart chart={s.chart || []} />
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: '0 0 6px' }}>Package mix</h3>
          <Bars
            rows={['basic', 'smart'].map((k) => ({
              key: k,
              label: PACKAGE_LABEL[k],
              value: mix[k] || 0,
              hint: plural(mix[k] || 0, 'contract'),
              color: k === 'smart' ? 'var(--primary)' : '#94a3b8',
            }))}
          />
          <h3 style={{ margin: '14px 0 6px' }}>By project</h3>
          {(s.byProject || []).length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              No contracts yet.
            </div>
          ) : (
            <Bars
              rows={(s.byProject || []).map((p) => ({
                key: String(p.projectId),
                label: p.name || '—',
                value: p.active || 0,
                hint: `${p.active} active of ${p.total} · ${fmtMoney(p.mrrCents) || '$0.00'}/mo`,
              }))}
            />
          )}
        </div>
      </div>

      {(s.alerts || []).length > 0 && (
        <div className="card alert alert-err" style={{ marginTop: 16 }}>
          <strong>Needs a look ({s.alerts.length})</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {s.alerts.map((a, i) => (
              <li key={`${a.kind}-${a.contractId || i}`} style={{ fontSize: 13 }}>
                {a.contractId ? <Link to={`/contracts/${a.contractId}`}>{a.message}</Link> : a.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 16 }}>
        <input placeholder="Search number, purchaser, email, phone, lot, address…" value={qDraft} onChange={(e) => setQDraft(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <div style={{ minWidth: 200 }}>
          <MultiSelect value={selectedProjects} onChange={(v) => setParams({ project: v.join(',') })} options={projectOptions} placeholder="All projects" allLabel="All projects" />
        </div>
        <select value={f.reminders} onChange={(e) => setParams({ reminders: e.target.value })} style={{ width: 'auto' }} aria-label="Reminders">
          <option value="">Reminders: any</option>
          <option value="on">Reminders on</option>
          <option value="off">Reminders off</option>
        </select>
      </div>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <div className="chip-group" role="group" aria-label="Status">
          {STATUS_CHIPS.map((c) => (
            <button key={c.value || 'all'} type="button" className={`chip${f.status === c.value ? ' active' : ''}`} onClick={() => setParams({ status: c.value })}>
              {c.label}
            </button>
          ))}
        </div>
        <button type="button" className={`chip${f.due === '7d' ? ' active' : ''}`} onClick={() => setParams({ due: f.due === '7d' ? '' : '7d' })} style={{ border: '1px solid var(--border)' }}>
          Due in 7 days
        </button>
        {(f.missed || f.needsAttention) && (
          <button type="button" className="secondary small" onClick={() => setParams({ missed: '', needsAttention: '' })}>
            Clear {f.missed ? 'missed' : 'needs attention'} filter
          </button>
        )}
        <div style={{ flex: 1 }} />
        <div className="muted" style={{ fontSize: 12 }}>
          {rows ? plural(rows.total, 'contract') : ''}
          {loadingRows ? ' · loading…' : ''}
        </div>
      </div>

      <div className="card ct-table-wrap" style={{ padding: 0 }}>
        <table className="compact-table">
          <thead>
            <tr>
              <SortTh label="#" k="number" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <th>Purchasers</th>
              <SortTh label="Project · Lot" k="lot" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <SortTh label="Package" k="package" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <th>Monthly incl. HST</th>
              <SortTh label="Status" k="status" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <SortTh label="Signed" k="signedAt" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <SortTh label="Started" k="startedAt" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <th title="Whole months since billing started">Months</th>
              <SortTh label="Paid" k="paid" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <SortTh label="Missed" k="missed" sort={f.sort} onSort={(v) => setParams({ sort: v })} title="Missed payments (in a row)" />
              <SortTh label="Next charge" k="nextCharge" sort={f.sort} onSort={(v) => setParams({ sort: v })} />
              <th>Reminders</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r._id} onClick={() => navigate(`/contracts/${r._id}`)} style={{ cursor: 'pointer' }}>
                <td className="nowrap">
                  <Link to={`/contracts/${r._id}`} onClick={(e) => e.stopPropagation()}>
                    <strong>{r.number}</strong>
                  </Link>
                </td>
                <td style={{ maxWidth: 220 }}>
                  {(r.purchasers || []).map((p, i) => (
                    <div key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.email}>
                      {p.name || p.email || '—'}
                    </div>
                  ))}
                </td>
                <td>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {r.project?.name || ''}
                  </div>
                  {r.lot?._id ? (
                    <Link to={`/lots/${r.lot._id}`} onClick={(e) => e.stopPropagation()}>
                      Lot {r.lot.lotNumber}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{r.package ? PACKAGE_LABEL[r.package] : <span className="muted">—</span>}</td>
                <td className="nowrap">{fmtMoney(r.totalCents) || <span className="muted">—</span>}</td>
                <td>
                  <ContractStatusBadge status={r.status} />
                  {r.needsAttention && (
                    <div>
                      <span className="badge err" style={{ marginTop: 3 }}>
                        {r.needsAttention.replace(/_/g, ' ')}
                      </span>
                    </div>
                  )}
                  {r.cancelAtPeriodEnd && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      ends at period end
                    </div>
                  )}
                </td>
                <td className="nowrap">{fmtDay(r.signedAt) || <span className="muted">—</span>}</td>
                <td className="nowrap">{fmtDayIn(r.startedAt, tz) || <span className="muted">—</span>}</td>
                <td>{r.startedAt ? r.monthsActive : <span className="muted">—</span>}</td>
                <td className="nowrap">
                  {r.paidCount ? (
                    <>
                      {fmtMoney(r.totalPaidCents)}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {plural(r.paidCount, 'payment')}
                      </div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="nowrap">
                  {r.missedCount ? (
                    <span className="error" style={{ margin: 0 }}>
                      {r.missedCount}
                      {r.consecutiveMissed ? ` (${r.consecutiveMissed})` : ''}
                      <div style={{ fontSize: 11 }}>{fmtMoney(r.missedOpenCents)}</div>
                    </span>
                  ) : (
                    <span className="muted">0</span>
                  )}
                </td>
                <td className="nowrap">{fmtDayIn(r.nextChargeAt, tz) || <span className="muted">—</span>}</td>
                <td>{r.remindersEnabled ? <span className="badge ok">on</span> : <span className="badge completed">off</span>}</td>
              </tr>
            ))}
            {rows && items.length === 0 && (
              <tr>
                <td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 18 }}>
                  {listQs.toString() ? 'No contracts match these filters.' : 'No monitoring contracts yet. Mark a lot closed to prepare the first one.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows && rows.pages > 1 && (
        <div className="pagination">
          <div className="muted" style={{ fontSize: 12 }}>
            {plural(rows.total, 'contract')}
          </div>
          <div style={{ flex: 1 }} />
          <button className="secondary" disabled={f.page <= 1 || loadingRows} onClick={() => setParams({ page: f.page - 1 })}>
            ‹ Prev
          </button>
          <span className="muted" style={{ fontSize: 12, padding: '0 6px' }}>
            Page {rows.page} of {rows.pages}
          </span>
          <button className="secondary" disabled={f.page >= rows.pages || loadingRows} onClick={() => setParams({ page: f.page + 1 })}>
            Next ›
          </button>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Email switches, package prices and the Stripe / DocuSign connections are in <Link to="/settings#monitoring-billing">Settings</Link>.
      </div>

      {newOpen && (
        <NewContractModal
          onClose={() => setNewOpen(false)}
          onCreated={(detail) => {
            setNewOpen(false);
            setRefreshKey((k) => k + 1);
            if (detail && detail.contract) navigate(`/contracts/${detail.contract._id}`);
          }}
        />
      )}
    </div>
  );
}
