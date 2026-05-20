import { useEffect, useMemo, useRef, useState } from 'react';

// Controlled combobox: text input + filtered dropdown panel. Matches the
// styling of the native <select> so it slots in wherever a select was used.
// Props:
//   value       — selected option's `value` (or '' for none)
//   onChange    — called with the next value when the user picks one
//   options     — [{ value, label }]
//   placeholder — shown when no value is selected
//   disabled    — disables interaction
export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value)) || null,
    [options, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => String(o.label).toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) setHighlight(0);
  }, [open, query]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${highlight}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  function openPanel() {
    if (disabled) return;
    setOpen(true);
    setQuery('');
  }

  function pick(opt) {
    onChange(opt.value);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        openPanel();
        return;
      }
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return;
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault();
        pick(filtered[highlight]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery('');
      }
    }
  }

  const displayValue = open ? query : selected ? selected.label : '';

  return (
    <div
      ref={wrapRef}
      className={`searchable-select${disabled ? ' is-disabled' : ''}${open ? ' is-open' : ''}`}
    >
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={openPanel}
        onClick={openPanel}
        onChange={(e) => {
          if (!open) setOpen(true);
          setQuery(e.target.value);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      {open && (
        <div className="searchable-select-panel" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="searchable-select-empty muted">No matches</div>
          ) : (
            filtered.map((opt, idx) => (
              <div
                key={opt.value}
                data-idx={idx}
                className={`searchable-select-option${
                  idx === highlight ? ' is-highlight' : ''
                }${String(opt.value) === String(value) ? ' is-selected' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(opt);
                }}
                onMouseEnter={() => setHighlight(idx)}
              >
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
