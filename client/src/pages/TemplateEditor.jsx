import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import EmailEditor from '../components/EmailEditor.jsx';
import SmsEditor from '../components/SmsEditor.jsx';
import VariableHelp from '../components/VariableHelp.jsx';

export default function TemplateEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [t, setT] = useState({
    name: '',
    type: 'email',
    subject: '',
    bodyHtml: '',
    bodyText: '',
    isDefaultReminder: false,
  });
  const [loaded, setLoaded] = useState(!id);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (id) {
      api.get(`/api/templates/${id}`).then((doc) => {
        setT(doc);
        setLoaded(true);
      });
    }
  }, [id]);

  async function save(e) {
    e.preventDefault();
    setMsg('');
    try {
      if (id) {
        await api.patch(`/api/templates/${id}`, t);
        setMsg('Saved.');
      } else {
        const created = await api.post('/api/templates', t);
        nav(`/templates/${created._id}`, { replace: true });
      }
    } catch (ex) {
      setMsg('Error: ' + ex.message);
    }
  }

  async function remove() {
    if (!confirm('Delete this template?')) return;
    await api.del(`/api/templates/${id}`);
    nav('/templates');
  }

  if (!loaded) return <div className="muted">Loading…</div>;

  return (
    <div>
      <h1>
        {id ? 'Edit template' : 'New template'}{' '}
        <Link to="/templates" className="muted" style={{ fontSize: 13 }}>
          ← all templates
        </Link>
      </h1>

      <form onSubmit={save}>
        <div className="card">
          <div className="row">
            <div style={{ flex: 2 }}>
              <label>Name</label>
              <input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} required />
            </div>
            <div>
              <label>Type</label>
              <select
                value={t.type}
                onChange={(e) => setT({ ...t, type: e.target.value })}
                disabled={!!id}
              >
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </select>
            </div>
            <div style={{ alignSelf: 'end' }}>
              <label>
                <input
                  type="checkbox"
                  checked={!!t.isDefaultReminder}
                  onChange={(e) => setT({ ...t, isDefaultReminder: e.target.checked })}
                />{' '}
                Use as default reminder
              </label>
            </div>
          </div>

          {t.type === 'email' && (
            <>
              <label>Subject</label>
              <input value={t.subject || ''} onChange={(e) => setT({ ...t, subject: e.target.value })} />

              <label>Body (HTML)</label>
              <EmailEditor value={t.bodyHtml} onChange={(v) => setT({ ...t, bodyHtml: v })} />

              <label style={{ marginTop: 12 }}>Plain text fallback (optional)</label>
              <textarea
                value={t.bodyText || ''}
                onChange={(e) => setT({ ...t, bodyText: e.target.value })}
              />
            </>
          )}

          {t.type === 'sms' && (
            <>
              <label>Message</label>
              <SmsEditor value={t.bodyText} onChange={(v) => setT({ ...t, bodyText: v })} />
            </>
          )}

          <VariableHelp />

          {msg && <div className={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</div>}

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="submit">Save</button>
            {id && (
              <button type="button" className="danger" onClick={remove}>
                Delete
              </button>
            )}
          </div>
        </div>

        {t.type === 'email' && t.bodyHtml && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Preview</h2>
            <iframe
              className="preview-frame"
              sandbox=""
              srcDoc={t.bodyHtml}
              title="preview"
            />
          </div>
        )}
      </form>
    </div>
  );
}
