import { useEffect, useMemo, useRef, useState } from 'react';

// Multi-select dropdown with a search box and checkboxes.
// Props:
//   value       — array of selected values
//   onChange    — called with the next array of values
//   options     — [{ value, label }]
//   placeholder — shown when nothing is selected
//   allLabel    — label for the "select all" affordance
export default function MultiSelect({
  value = [],
  onChange,
  options = [],
  placeholder = 'Select…',
  allLabel = 'All',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const selectedSet = useMemo(() => new Set(value.map(String)), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => String(o.label).toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function toggle(v) {
    const key = String(v);
    const next = selectedSet.has(key)
      ? value.filter((x) => String(x) !== key)
      : [...value, v];
    onChange(next);
  }

  function selectAllFiltered() {
    const merged = new Set(value.map(String));
    for (const o of filtered) merged.add(String(o.value));
    onChange(options.filter((o) => merged.has(String(o.value))).map((o) => o.value));
  }

  function clearAll() {
    onChange([]);
  }

  const summary =
    value.length === 0
      ? placeholder
      : value.length === options.length
        ? `${allLabel} (${options.length})`
        : `${value.length} selected`;

  return (
    <div ref={wrapRef} className={`multiselect${open ? ' is-open' : ''}`}>
      <button type="button" className="multiselect-control" onClick={() => setOpen((o) => !o)}>
        <span className={value.length === 0 ? 'muted' : ''}>{summary}</span>
        <span className="multiselect-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="multiselect-panel">
          <input
            className="multiselect-search"
            type="text"
            value={query}
            placeholder="Search…"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="multiselect-actions">
            <button type="button" onClick={selectAllFiltered}>
              Select {query ? 'matching' : 'all'}
            </button>
            <button type="button" onClick={clearAll}>
              Clear
            </button>
          </div>
          <div className="multiselect-list">
            {filtered.length === 0 ? (
              <div className="multiselect-empty muted">No matches</div>
            ) : (
              filtered.map((o) => (
                <label key={o.value} className="multiselect-option">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(String(o.value))}
                    onChange={() => toggle(o.value)}
                  />
                  <span>{o.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
