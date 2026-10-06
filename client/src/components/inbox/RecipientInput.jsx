import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../../api';
import { Avatar } from '../../mailUtil.jsx';
import Icon from '../ui/Icon.jsx';

const EMAIL_RE = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

function parseOne(text) {
  const t = String(text || '').trim().replace(/[,;]$/, '');
  if (!t) return null;
  const m = t.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m && EMAIL_RE.test(m[2].trim())) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  if (EMAIL_RE.test(t)) return { name: '', email: t.toLowerCase() };
  return null;
}

// Recipients as chips. Typing an address then Enter / Tab / comma (or
// leaving the field) adds it; suggestions come from past mail and lot buyers.
// The ref's commit() turns whatever is still typed into recipients and
// returns the full list (null if the typed text isn't a valid address), so
// Send never drops an address that wasn't "chipped" yet.
const RecipientInput = forwardRef(function RecipientInput({ label, value, onChange, autoFocus, placeholder }, ref) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const rows = await api.get(`/api/inbox/contacts?q=${encodeURIComponent(q)}`);
        if (id === seq.current) {
          const have = new Set(value.map((v) => v.email));
          setSuggestions(rows.filter((r) => !have.has(r.email)).slice(0, 7));
          setHighlight(0);
        }
      } catch {
        /* suggestions are optional */
      }
    }, 140);
    return () => clearTimeout(t);
  }, [text, value]);

  function add(person) {
    if (!person) return false;
    if (!value.some((v) => v.email === person.email)) onChange([...value, person]);
    setText('');
    setSuggestions([]);
    setInvalid(false);
    return true;
  }

  function commitText(raw = text) {
    const parts = String(raw).split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return value;
    const parsed = parts.map(parseOne);
    if (parsed.some((p) => !p)) {
      setText(raw);
      setInvalid(true);
      return null;
    }
    const next = [...value];
    for (const p of parsed) if (!next.some((v) => v.email === p.email)) next.push(p);
    onChange(next);
    setText('');
    setSuggestions([]);
    setInvalid(false);
    return next;
  }

  useImperativeHandle(ref, () => ({ commit: () => commitText() }));

  function onKeyDown(e) {
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (suggestions.length && text.trim() && !parseOne(text)) {
        e.preventDefault();
        add({ name: suggestions[highlight].name, email: suggestions[highlight].email });
        return;
      }
      if (text.trim()) {
        if (e.key !== 'Tab') e.preventDefault();
        commitText();
      }
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
    if (e.key === 'Escape') setSuggestions([]);
  }

  return (
    <div className={`rcpt${invalid ? ' is-invalid' : ''}`} onClick={() => inputRef.current?.focus()}>
      <span className="rcpt-label">{label}</span>
      <div className="rcpt-chips">
        {value.map((p) => (
          <span key={p.email} className="rcpt-chip" title={p.email}>
            <Avatar person={p} size={18} />
            <span className="rcpt-chip-text">{p.name || p.email}</span>
            <button
              type="button"
              className="rcpt-chip-x"
              aria-label={`Remove ${p.email}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((v) => v.email !== p.email));
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          autoFocus={autoFocus}
          placeholder={value.length ? '' : placeholder || 'Name or email'}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              commitText(text + pasted);
            }
          }}
          onBlur={() => setTimeout(() => (text.trim() ? commitText() : setSuggestions([])), 150)}
          aria-label={label}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="rcpt-suggest" role="listbox">
          {suggestions.map((s, i) => (
            <button
              type="button"
              key={s.email}
              className={`rcpt-suggest-row${i === highlight ? ' is-hl' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                add({ name: s.name, email: s.email });
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <Avatar person={s} size={26} />
              <span className="rcpt-suggest-text">
                <span className="rcpt-suggest-name">{s.name || s.email}</span>
                <span className="rcpt-suggest-email">{s.email}</span>
              </span>
              {s.tag && <span className="pill pill-indigo">{s.tag}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default RecipientInput;
