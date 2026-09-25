import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Stars, RepBadge, fmtReviewDate, plural, idOf } from './bits.jsx';

// The review log: every review in the window (or all time), filterable, with
// an inline editor to credit a review to one of our reps by hand.

const PAGE_SIZES = [25, 50, 100];
const MAIN_FILTERS = [
  ['all', 'All'],
  ['genius', 'Genius'],
  ['other', 'Other'],
  ['unmapped', 'Needs mapping'],
];
const MORE_FILTERS = [
  ['', 'More filters…'],
  ['hint', 'Possibly Genius (not tagged)'],
  ['five', '5-star only'],
  ['low', 'Rated 3 or less'],
  ['unreplied', 'No owner reply'],
  ['manual', 'Mapped by hand'],
];
const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['rating_low', 'Lowest rating first'],
  ['rating_high', 'Highest rating first'],
];

function Avatar({ item }) {
  const initial = (item.reviewer || '?').trim().slice(0, 1).toUpperCase();
  return (
    <span className="rv-avatar" aria-hidden="true">
      {item.reviewerAvatar ? <img src={item.reviewerAvatar} alt="" loading="lazy" referrerPolicy="no-referrer" /> : initial}
    </span>
  );
}

function autoSummary(item, reps) {
  const auto = item.auto || {};
  const names = (auto.reps || []).map((r) => (typeof r === 'object' ? r.name : reps.find((x) => idOf(x) === idOf(r))?.name || 'a rep'));
  const bits = [];
  if (names.length) bits.push(`${names.join(', ')} (matched "${(auto.aliases || []).join('", "')}")`);
  if (auto.termHit) bits.push(`Genius term "${(auto.terms || []).join('", "')}"`);
  return bits.length ? bits.join(' · ') : 'no rep or Genius term found in the text';
}

function MappingEditor({ item, reps, onCancel, onSaved }) {
  const activeReps = reps.filter((r) => r.active !== false);
  const current = (item.manual?.repsSet ? item.manual.reps : item.reps) || [];
  const [selected, setSelected] = useState(() => new Set(current.map(idOf)));
  const [genius, setGenius] = useState(item.manual?.genius === true ? 'yes' : item.manual?.genius === false ? 'no' : 'auto');
  const [note, setNote] = useState(item.manual?.note || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Inactive reps still credited on this review stay pickable so the mapping
  // can be cleared, but new picks are limited to active reps.
  const extra = reps.filter((r) => r.active === false && selected.has(idOf(r)));
  const choices = [...activeReps, ...extra];

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const autoIds = new Set(((item.auto && item.auto.reps) || []).map(idOf));
  const sameAsAuto = selected.size === autoIds.size && [...selected].every((id) => autoIds.has(id));

  async function save(reset = false) {
    setBusy(true);
    setErr('');
    try {
      const body = reset
        ? { reps: null, genius: null, note: '' }
        : {
            // Choosing exactly what the matcher found (and no forced flag) is
            // not an override — leave it automatic so alias edits keep applying.
            reps: sameAsAuto && genius === 'auto' ? null : [...selected],
            genius: genius === 'auto' ? null : genius === 'yes',
            note,
          };
      const saved = await api.patch(`/api/reviews/${item._id}/mapping`, body);
      onSaved(saved);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const willBeGenius = genius === 'yes' || (genius === 'auto' && (selected.size > 0 || item.auto?.termHit));

  return (
    <div className="rv-mapping" onClick={(e) => e.stopPropagation()}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Auto-detected: {autoSummary(item, reps)}.
      </div>
      <div style={{ marginBottom: 6 }}>
        <div className="strip-label" style={{ marginBottom: 6 }}>Credit this review to</div>
        {choices.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No reps yet — add them under Reps &amp; matching below.</div>}
        {choices.map((r) => (
          <label key={idOf(r)} className="rv-check">
            <input type="checkbox" checked={selected.has(idOf(r))} onChange={() => toggle(idOf(r))} />
            <RepBadge rep={r} inactive={r.active === false} />
          </label>
        ))}
        {selected.size === 0 && <span className="muted" style={{ fontSize: 12 }}>nobody</span>}
      </div>
      <div style={{ marginBottom: 6 }}>
        <div className="strip-label" style={{ marginBottom: 6 }}>Genius-related</div>
        {[
          ['auto', `Automatic (${willBeGenius && genius === 'auto' ? 'yes' : genius === 'auto' ? 'no' : 'follows the reps / Genius terms'})`],
          ['yes', 'Yes'],
          ['no', 'No'],
        ].map(([v, label]) => (
          <label key={v} className="rv-check">
            <input type="radio" name={`genius-${item._id}`} checked={genius === v} onChange={() => setGenius(v)} />
            {label}
          </label>
        ))}
      </div>
      <label style={{ marginTop: 4 }}>Note (optional — why this mapping)</label>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder='e.g. "the reviewer calls him Jay"' maxLength={1000} />
      {err && <div className="error">{err}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button type="button" onClick={() => save(false)} disabled={busy}>
          {busy ? 'Saving…' : 'Save mapping'}
        </button>
        {item.mappingSource === 'manual' && (
          <button type="button" className="secondary" onClick={() => save(true)} disabled={busy} title="Drop the manual mapping and go back to what the matcher finds">
            Reset to automatic
          </button>
        )}
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ReviewCard({ item, reps, tz, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const text = String(item.text || '');
  const long = text.length > 320 || text.split('\n').length > 4;
  const edited = item.editedAt && item.postedAt && new Date(item.editedAt) > new Date(item.postedAt);
  const low = Number(item.rating) > 0 && Number(item.rating) <= 3;
  const effectiveReps = (item.reps || []).map((r) => (typeof r === 'object' ? r : reps.find((x) => idOf(x) === idOf(r)) || { name: 'rep' }));

  return (
    <article className={`rv-review${low ? ' is-low' : ''}${item.genius ? ' is-genius' : ''}`}>
      <header className="rv-review-head">
        <Avatar item={item} />
        <strong>{item.reviewer || 'Anonymous'}</strong>
        <Stars rating={item.rating} />
        <span className="muted nowrap" title={edited ? `Posted ${fmtReviewDate(item.postedAt, tz)}, edited ${fmtReviewDate(item.editedAt, tz)}` : undefined}>
          {edited ? 'Edited ' : ''}
          {fmtReviewDate(item.effectiveAt, tz)}
        </span>
        <span className="rv-tags">
          {effectiveReps.map((r) => (
            <RepBadge key={idOf(r)} rep={r} inactive={r.active === false} />
          ))}
          {item.genius && <span className="badge genius">Genius</span>}
          {item.mappingSource === 'manual' && (
            <span className="badge manual" title={item.manual?.note ? `Mapped by hand: ${item.manual.note}` : 'Mapped by hand'}>
              manual
            </span>
          )}
          {item.genius && effectiveReps.length === 0 && <span className="badge err">needs mapping</span>}
          {!item.genius && item.auto?.hint && (
            <span className="badge hint" title={`Mentions ${(item.auto.hints || []).map((h) => `"${h}"`).join(', ')} — a Genius job? Map it to a rep if so.`}>
              possibly Genius
            </span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {item.link && (
          <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
            Open on Google ↗
          </a>
        )}
      </header>

      {text ? (
        <p className={`rv-review-text${long && !expanded ? ' is-clamped' : ''}`}>{text}</p>
      ) : (
        <p className="rv-review-text muted">
          <em>No text — rating only.</em>
        </p>
      )}
      {long && (
        <button type="button" className="rv-link" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      {item.reply?.text && (
        <div className="rv-reply">
          <button type="button" className="rv-link" onClick={() => setReplyOpen((o) => !o)} style={{ fontWeight: 600 }}>
            {replyOpen ? '▾' : '▸'} Owner reply{item.reply.at ? ` · ${fmtReviewDate(item.reply.at, tz)}` : ''}
          </button>
          {replyOpen && <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{item.reply.text}</div>}
        </div>
      )}

      <footer className="rv-review-foot">
        <span>
          {item.mappingSource === 'manual' ? (
            <>
              Mapped by hand
              {item.manual?.note ? ` — ${item.manual.note}` : ''}
              {item.auto?.reps?.length || item.auto?.termHit ? ` (auto would say: ${autoSummary(item, reps)})` : ''}
            </>
          ) : (
            <>
              Auto: {autoSummary(item, reps)}
              {!item.genius && item.auto?.hint ? ` · mentions "${(item.auto.hints || []).join('", "')}" — a Genius job? Map it to a rep if so` : ''}
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {!editing && (
          <button type="button" className="secondary small" onClick={() => setEditing(true)}>
            {effectiveReps.length ? 'Edit mapping' : 'Map to a rep'}
          </button>
        )}
      </footer>
      {editing && (
        <MappingEditor
          item={item}
          reps={reps}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            onSaved(saved);
          }}
        />
      )}
    </article>
  );
}

export default function ReviewLog({ window, reps, tz, filters, onFilters, refreshKey, onChanged }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState('newest');
  const [q, setQ] = useState(filters.q || '');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const mainActive = MAIN_FILTERS.some(([v]) => v === filters.show) ? filters.show : '';
  const moreActive = MORE_FILTERS.some(([v]) => v && v === filters.show) ? filters.show : '';

  const query = useMemo(() => {
    const qs = new URLSearchParams();
    if (filters.scope === 'all') qs.set('scope', 'all');
    else if (window) {
      qs.set('start', window.start);
      qs.set('end', window.end);
    }
    if (filters.show && filters.show !== 'all') qs.set('show', filters.show);
    if (filters.rep) qs.set('rep', filters.rep);
    if (filters.q) qs.set('q', filters.q);
    qs.set('sort', sort);
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));
    return qs.toString();
  }, [filters.scope, filters.show, filters.rep, filters.q, window && window.start, window && window.end, sort, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [filters.scope, filters.show, filters.rep, filters.q, window && window.start, window && window.end, sort, pageSize]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr('');
    api
      .get(`/api/reviews?${query}`)
      .then((r) => {
        if (!live) return;
        setItems(r.items || []);
        setTotal(r.total || 0);
        setPages(r.pages || 1);
      })
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query, refreshKey]);

  useEffect(() => {
    setQ(filters.q || '');
  }, [filters.q]);

  function replace(saved) {
    setItems((list) => list.map((it) => (it._id === saved._id ? saved : it)));
    onChanged && onChanged(saved);
  }

  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(total, page * pageSize);
  const activeReps = reps.filter((r) => r.active !== false);

  return (
    <div id="review-log">
      <div className="toolbar" style={{ gap: 10 }}>
        <div className="chip-group">
          {MAIN_FILTERS.map(([v, label]) => (
            <button key={v} type="button" className={`chip${mainActive === v ? ' active' : ''}`} onClick={() => onFilters({ show: v })}>
              {label}
            </button>
          ))}
        </div>
        <select value={moreActive} onChange={(e) => onFilters({ show: e.target.value || 'all' })} title="Narrow the list further">
          {MORE_FILTERS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select value={filters.rep || ''} onChange={(e) => onFilters({ rep: e.target.value })} title="Only reviews credited to this rep">
          <option value="">Any rep</option>
          {activeReps.map((r) => (
            <option key={idOf(r)} value={idOf(r)}>
              {r.name}
            </option>
          ))}
          <option value="none">Credited to nobody</option>
        </select>
        <div className="chip-group" title="Reviews in the selected window, or everything stored">
          <button type="button" className={`chip${filters.scope !== 'all' ? ' active' : ''}`} onClick={() => onFilters({ scope: 'window' })}>
            {window ? window.label : 'This window'}
          </button>
          <button type="button" className={`chip${filters.scope === 'all' ? ' active' : ''}`} onClick={() => onFilters({ scope: 'all' })}>
            All time
          </button>
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value)} title="Sort">
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onFilters({ q });
          }}
          style={{ display: 'flex', gap: 6, flex: '1 1 220px' }}
        >
          <input placeholder="Search reviewer, text, reply…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 160, flex: 1 }} />
          <button type="submit" className="secondary">
            Search
          </button>
          {filters.q && (
            <button type="button" className="secondary" onClick={() => onFilters({ q: '' })} title="Clear the search">
              ×
            </button>
          )}
        </form>
      </div>

      {err && <div className="error">{err}</div>}
      <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
        {items.map((it) => (
          <ReviewCard key={it._id} item={it} reps={reps} tz={tz} onSaved={replace} />
        ))}
        {!loading && items.length === 0 && (
          <div className="card rv-empty">
            {total === 0 && filters.show === 'all' && !filters.rep && !filters.q
              ? filters.scope === 'all'
                ? 'No reviews stored yet. Sync the listing or import a JSON export from Setup below.'
                : 'No reviews landed in this window. Try All time, or another week.'
              : 'Nothing matches these filters.'}
          </div>
        )}
        {loading && items.length === 0 && <div className="card rv-empty">Loading…</div>}
      </div>

      <div className="pagination">
        <div className="muted" style={{ fontSize: 12 }}>
          {total === 0 ? 'No results' : `Showing ${startRow}–${endRow} of ${plural(total, 'review')}`}
        </div>
        <div style={{ flex: 1 }} />
        <label className="muted" style={{ fontSize: 12, margin: 0 }}>
          Per page&nbsp;
        </label>
        <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ width: 'auto' }}>
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
          ‹ Prev
        </button>
        <span className="muted" style={{ fontSize: 12, padding: '0 6px' }}>
          Page {page} of {pages}
        </span>
        <button className="secondary" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
          Next ›
        </button>
      </div>
    </div>
  );
}
