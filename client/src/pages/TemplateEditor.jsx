import { useEffect, useMemo, useState } from 'react';
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
  const [testTo, setTestTo] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    if (id) {
      api.get(`/api/templates/${id}`).then((doc) => {
        setT(doc);
        setLoaded(true);
      });
    }
  }, [id]);

  async function save(e) {
    if (e?.preventDefault) e.preventDefault();
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

  async function sendTest() {
    if (!id) {
      setTestMsg('Save the template first, then send a test.');
      return;
    }
    if (!testTo) {
      setTestMsg('Enter a recipient first.');
      return;
    }
    setTestBusy(true);
    setTestMsg('');
    try {
      const r = await api.post(`/api/templates/${id}/test`, { to: testTo });
      setTestMsg(
        r.ok
          ? `Test ${r.channel} sent to ${testTo}. Provider ID: ${r.providerId || '(none)'}`
          : `Test failed: ${r.message || 'unknown error'}`
      );
    } catch (ex) {
      setTestMsg('Test failed: ' + ex.message);
    } finally {
      setTestBusy(false);
    }
  }

  async function refreshPreview() {
    if (!id) {
      setTestMsg('Save the template first, then preview.');
      return;
    }
    setPreviewBusy(true);
    try {
      const r = await api.post(`/api/templates/${id}/preview`, {});
      setPreview(r.rendered);
    } catch (ex) {
      setTestMsg('Preview failed: ' + ex.message);
    } finally {
      setPreviewBusy(false);
    }
  }

  const livePreview = useMemo(() => {
    // Quick client-side preview that just substitutes the smart variables
    // we know about, so authors see something reasonable before they Save.
    const sample = {
      'buyer.name': 'Jane Owner',
      'buyer.firstName': 'Jane',
      'buyer.email': 'jane@example.com',
      'buyer.phone': '+1 555 555 0101',
      'coBuyer.name': 'John Owner',
      'coBuyer.firstName': 'John',
      'coBuyer.email': 'john@example.com',
      'coBuyer.phone': '+1 555 555 0102',
      'thirdBuyer.name': '',
      'thirdBuyer.firstName': '',
      'thirdBuyer.email': '',
      'lot.number': '101',
      'lot.address': '123 Sample Lane',
      'lot.status': 'pending',
      'project.name': 'Sample Project',
      'owner.name': 'Acme Sales',
      'owner.email': 'sales@example.com',
      'owner.phone': '+1 555 555 0000',
      'owner.calendlyUrl': 'https://calendly.com/acme/intro',
      buyersDisplay: 'Jane Owner and John Owner',
      buyersFirstDisplay: 'Jane and John',
    };
    const sub = (s) =>
      String(s || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (k in sample ? sample[k] : ''));
    return { subject: sub(t.subject), body: sub(t.bodyHtml || t.bodyText) };
  }, [t.subject, t.bodyHtml, t.bodyText]);

  if (!loaded) return <div className="muted">Loading…</div>;

  return (
    <div>
      <div className="page-head">
        <div>
          <Link to="/templates" className="muted" style={{ fontSize: 13 }}>
            ← all templates
          </Link>
          <h1 style={{ margin: '4px 0 0' }}>{id ? 'Edit template' : 'New template'}</h1>
        </div>
      </div>

      <form onSubmit={save}>
        <div className="card">
          <div className="row">
            <div style={{ flex: 2 }}>
              <label>Name</label>
              <input
                value={t.name}
                onChange={(e) => setT({ ...t, name: e.target.value })}
                required
                placeholder="e.g. Welcome email — buyer + co-buyer"
              />
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
              <input
                value={t.subject || ''}
                onChange={(e) => setT({ ...t, subject: e.target.value })}
                placeholder="e.g. Hi {{buyersFirstDisplay}} — your appointment for Lot {{lot.number}}"
              />

              <label>Body</label>
              <EmailEditor value={t.bodyHtml} onChange={(v) => setT({ ...t, bodyHtml: v })} />

              <label style={{ marginTop: 12 }}>Plain text fallback (optional)</label>
              <textarea
                value={t.bodyText || ''}
                onChange={(e) => setT({ ...t, bodyText: e.target.value })}
                placeholder="Used by clients that don't render HTML."
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

          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="submit">Save</button>
            {id && (
              <>
                <button type="button" className="secondary" onClick={refreshPreview} disabled={previewBusy}>
                  {previewBusy ? 'Rendering…' : 'Server preview'}
                </button>
                <div style={{ flex: 1 }} />
                <button type="button" className="danger" onClick={remove}>
                  Delete
                </button>
              </>
            )}
          </div>
        </div>

        {id && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Send test {t.type === 'email' ? 'email' : 'SMS'}</h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Renders the template with sample data (Jane + John, Lot 101) and sends it to the
              address you enter. Subject is prefixed with <span className="kbd">[TEST]</span>.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type={t.type === 'email' ? 'email' : 'tel'}
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder={t.type === 'email' ? 'you@example.com' : '+15555550100'}
                style={{ maxWidth: 320 }}
              />
              <button type="button" onClick={sendTest} disabled={testBusy}>
                {testBusy ? 'Sending…' : `Send test ${t.type === 'email' ? 'email' : 'SMS'}`}
              </button>
            </div>
            {testMsg && (
              <div
                className={testMsg.startsWith('Test failed') ? 'error' : 'success'}
                style={{ marginTop: 8 }}
              >
                {testMsg}
              </div>
            )}
          </div>
        )}

        {t.type === 'email' && (livePreview.body || preview?.html) && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>
              Preview
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                {preview ? 'server-rendered' : 'live (sample data)'}
              </span>
            </h2>
            {(preview?.subject || livePreview.subject) && (
              <div style={{ marginBottom: 8 }}>
                <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Subject
                </div>
                <div>{preview?.subject || livePreview.subject}</div>
              </div>
            )}
            <iframe
              className="preview-frame"
              sandbox=""
              srcDoc={preview?.html || livePreview.body}
              title="preview"
            />
          </div>
        )}

        {t.type === 'sms' && (livePreview.body || preview?.text) && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>SMS preview</h2>
            <div
              style={{
                background: '#0f172a',
                color: '#e5e7eb',
                padding: 14,
                borderRadius: 12,
                maxWidth: 360,
                whiteSpace: 'pre-wrap',
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              {preview?.text || livePreview.body}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
