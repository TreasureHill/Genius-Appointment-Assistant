import { useState } from 'react';
import { api } from '../../api';
import { RepBadge, plural, idOf } from './bits.jsx';

// Reps & matching: who the reviews can be credited to, the nicknames the
// matcher looks for, and the words that mark a review as Genius-related.

function RepRow({ rep, onChanged }) {
  const [form, setForm] = useState({
    name: rep.name,
    role: rep.role || '',
    aliases: (rep.aliases || []).filter((a) => a !== String(rep.name).toLowerCase()).join(', '),
    color: rep.color || '#94a3b8',
    active: rep.active !== false,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const dirty =
    form.name !== rep.name ||
    form.role !== (rep.role || '') ||
    form.aliases !== (rep.aliases || []).filter((a) => a !== String(rep.name).toLowerCase()).join(', ') ||
    form.color !== (rep.color || '#94a3b8') ||
    form.active !== (rep.active !== false);

  async function save(patch) {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.patch(`/api/reviews/reps/${rep._id}`, patch || { name: form.name, role: form.role, aliases: form.aliases, color: form.color, active: form.active });
      setMsg(r.rematch ? `Saved · re-matched ${plural(r.rematch.scanned, 'review')}, ${r.rematch.changed} changed` : 'Saved');
      onChanged();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${rep.name}? ${rep.reviewCount ? `${plural(rep.reviewCount, 'review')} credited to them will lose that credit. ` : ''}Deactivating keeps the history instead.`)) return;
    setBusy(true);
    try {
      await api.del(`/api/reviews/reps/${rep._id}`);
      onChanged();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
      setBusy(false);
    }
  }

  return (
    <tr className={form.active ? '' : 'is-off'}>
      <td style={{ minWidth: 150 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} title="Badge colour" style={{ width: 34, height: 34, padding: 2 }} />
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" />
        </div>
        <div style={{ marginTop: 6 }}>
          <RepBadge rep={{ name: form.name || rep.name, color: form.color }} inactive={!form.active} />
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            {plural(rep.reviewCount || 0, 'review')} all time
          </span>
        </div>
      </td>
      <td style={{ minWidth: 130 }}>
        <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="Genius technician" />
      </td>
      <td style={{ minWidth: 240 }}>
        <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} placeholder="nicknames, misspellings — comma separated" />
        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
          The name itself always matches. Whole words only, any case.
        </div>
      </td>
      <td className="nowrap">
        <label className="rv-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          active
        </label>
      </td>
      <td className="nowrap" style={{ textAlign: 'right' }}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" className="small" disabled={busy || !dirty} onClick={() => save()}>
            Save
          </button>
          <button type="button" className="secondary small" disabled={busy} onClick={remove} title="Delete this rep">
            Delete
          </button>
        </div>
        {msg && (
          <div className={msg.startsWith('Error') ? 'error' : 'muted'} style={{ fontSize: 11, marginTop: 4, whiteSpace: 'normal', maxWidth: 220 }}>
            {msg}
          </div>
        )}
      </td>
    </tr>
  );
}

export default function RepsManageCard({ reps, geniusTerms, hintTerms, onChanged }) {
  const [add, setAdd] = useState({ name: '', aliases: '', role: 'Genius technician' });
  const [terms, setTerms] = useState((geniusTerms || []).join(', '));
  const [hints, setHints] = useState((hintTerms || []).join(', '));
  const [phrase, setPhrase] = useState('');
  const [tried, setTried] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const termsDirty = terms !== (geniusTerms || []).join(', ');
  const hintsDirty = hints !== (hintTerms || []).join(', ');

  async function run(label, fn) {
    setBusy(label);
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card">
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Reps &amp; matching</h3>
          <div className="muted" style={{ fontSize: 12.5 }}>
            A review is credited to a rep when its text names them (or one of their nicknames), and counts as
            Genius-related when it names a rep or uses a Genius term. Anything the matcher misses can be mapped
            by hand on the review itself — manual mappings are never overwritten by a sync or a re-match.
          </div>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy === 'rematch'}
          onClick={() =>
            run('rematch', async () => {
              const r = await api.post('/api/reviews/rematch');
              setMsg(`Re-matched ${plural(r.scanned, 'review')} · ${r.changed} changed.`);
              onChanged();
            })
          }
          title="Run the matcher over every stored review again (manual mappings stay)"
        >
          {busy === 'rematch' ? 'Re-matching…' : 'Re-run matching'}
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="compact-table">
          <thead>
            <tr>
              <th>Rep</th>
              <th>Role</th>
              <th>Also matches</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <RepRow key={idOf(r)} rep={r} onChanged={onChanged} />
            ))}
            {reps.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                  No reps yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!add.name.trim()) return;
          run('add', async () => {
            const r = await api.post('/api/reviews/reps', add);
            setAdd({ name: '', aliases: '', role: 'Genius technician' });
            setMsg(`Added ${r.rep.name}${r.rematch ? ` · re-matched ${plural(r.rematch.scanned, 'review')}, ${r.rematch.changed} changed` : ''}.`);
            onChanged();
          });
        }}
        className="row"
        style={{ alignItems: 'flex-end', marginTop: 12 }}
      >
        <div style={{ flex: 1 }}>
          <label style={{ marginTop: 0 }}>Add a rep</label>
          <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="Name" required />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ marginTop: 0 }}>Role</label>
          <input value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })} placeholder="Genius technician" />
        </div>
        <div style={{ flex: 2 }}>
          <label style={{ marginTop: 0 }}>Also matches (comma separated)</label>
          <input value={add.aliases} onChange={(e) => setAdd({ ...add, aliases: e.target.value })} placeholder="nicknames, common misspellings" />
        </div>
        <div style={{ flex: '0 0 auto' }}>
          <button type="submit" disabled={busy === 'add' || !add.name.trim()}>
            {busy === 'add' ? 'Adding…' : 'Add rep'}
          </button>
        </div>
      </form>

      <div className="row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
        <div style={{ flex: 2 }}>
          <label style={{ marginTop: 0 }}>Genius terms — any of these words marks a review as Genius-related</label>
          <input value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="genius, genious, genuis" />
        </div>
        <div style={{ flex: '0 0 auto' }}>
          <button
            type="button"
            className="secondary"
            disabled={busy === 'terms' || !termsDirty}
            onClick={() =>
              run('terms', async () => {
                const r = await api.patch('/api/reviews/config', { geniusTerms: terms });
                setTerms((r.geniusTerms || []).join(', '));
                setMsg(r.rematch ? `Saved terms · re-matched ${plural(r.rematch.scanned, 'review')}, ${r.rematch.changed} changed.` : 'Saved terms.');
                onChanged();
              })
            }
          >
            {busy === 'terms' ? 'Saving…' : 'Save terms'}
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div style={{ flex: 2 }}>
          <label style={{ marginTop: 0 }}>
            "Possibly Genius" hint words — flag untagged reviews that mention smart-home work (never tags them; you decide and map)
          </label>
          <input value={hints} onChange={(e) => setHints(e.target.value)} placeholder="google home, cameras, wifi, doorbell, thermostat" />
        </div>
        <div style={{ flex: '0 0 auto' }}>
          <button
            type="button"
            className="secondary"
            disabled={busy === 'hints' || !hintsDirty}
            onClick={() =>
              run('hints', async () => {
                const r = await api.patch('/api/reviews/config', { hintTerms: hints });
                setHints((r.hintTerms || []).join(', '));
                setMsg(r.rematch ? `Saved hint words · re-checked ${plural(r.rematch.scanned, 'review')}, ${r.rematch.changed} changed.` : 'Saved hint words.');
                onChanged();
              })
            }
          >
            {busy === 'hints' ? 'Saving…' : 'Save hint words'}
          </button>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!phrase.trim()) return;
          run('try', async () => setTried(await api.post('/api/reviews/classify', { text: phrase })));
        }}
        className="row"
        style={{ marginTop: 16, alignItems: 'flex-end' }}
      >
        <div style={{ flex: 2 }}>
          <label style={{ marginTop: 0 }}>Try a phrase — see what the matcher makes of it</label>
          <input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder='e.g. "Thanks a lot Jason and Syed from the Genius team"' />
        </div>
        <div style={{ flex: '0 0 auto' }}>
          <button type="submit" className="secondary" disabled={busy === 'try' || !phrase.trim()}>
            Test
          </button>
        </div>
      </form>
      {tried && (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          {tried.reps.length ? (
            <>
              Credited to <strong>{tried.repNames.join(', ')}</strong> (matched "{tried.aliases.join('", "')}")
            </>
          ) : (
            'No rep matched'
          )}
          {' · '}
          Genius-related: <strong>{tried.genius ? 'yes' : 'no'}</strong>
          {tried.termHit ? ` (term "${tried.terms.join('", "')}")` : ''}
          {!tried.genius && tried.hint ? ` · possibly Genius (mentions "${tried.hints.join('", "')}")` : ''}
        </div>
      )}
      {msg && (
        <div className={msg.startsWith('Error') ? 'error' : 'success'} style={{ marginTop: 10 }}>
          {msg}
        </div>
      )}
    </div>
  );
}
