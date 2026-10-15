import { useState } from 'react';
import ReactQuill from 'react-quill-new';
import { api } from '../api';

const modules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link', 'image'],
    [{ align: [] }],
    ['clean'],
  ],
};

// Markup the rich-text editor can't hold. Loading it into the editor rewrites
// it (a table becomes one row of cells, wrapper styles vanish), so such
// bodies open in the HTML tab instead.
function looksLikeRawHtml(html) {
  return /<(table|div|center|html|body|style)\b/i.test(String(html || ''));
}

export default function EmailEditor({ value, onChange }) {
  const [mode, setMode] = useState(() => (looksLikeRawHtml(value) ? 'html' : 'rich'));
  const [presetMsg, setPresetMsg] = useState('');

  async function insertGeniusEmail() {
    setPresetMsg('');
    if (String(value || '').trim() && !confirm('Replace the current body with the Genius appointment email?')) return;
    try {
      const presets = await api.get('/api/templates/presets');
      const preset = (presets || []).find((p) => p.key === 'genius-appointment');
      if (!preset) throw new Error('preset not found');
      setMode('html');
      onChange(preset.bodyHtml);
    } catch (ex) {
      setPresetMsg('Could not load the Genius email: ' + ex.message);
    }
  }

  function pasteSample() {
    const sample = `<table cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.6;max-width:600px">
  <tr><td>
    <h2 style="margin:0 0 12px;color:#1f3a93">Hello {{buyersFirstDisplay}}</h2>
    <p>This is a friendly reminder to schedule your appointment for
    <strong>Lot {{lot.number}}</strong>{{#if lot.address}} at {{lot.address}}{{/if}}.</p>
    <p style="margin:24px 0">
      <a href="{{owner.calendlyUrl}}"
         style="background:#1f3a93;color:#fff;padding:10px 18px;border-radius:6px;
                text-decoration:none;display:inline-block">Book a time</a>
    </p>
    <p>Thanks,<br/>{{owner.name}}</p>
  </td></tr>
</table>`;
    onChange(sample);
  }

  return (
    <div className="email-editor">
      <div className="editor-toolbar">
        <div className="editor-tabs" role="tablist">
          <button
            type="button"
            className={`editor-tab ${mode === 'rich' ? 'active' : ''}`}
            onClick={() => {
              if (
                mode !== 'rich' &&
                looksLikeRawHtml(value) &&
                !confirm(
                  'This email uses layout the rich-text editor cannot keep (tables or styled blocks). ' +
                    'Opening it there rewrites the HTML (tables turn into a row of side-by-side cells). Open anyway?'
                )
              )
                return;
              setMode('rich');
            }}
          >
            Rich text
          </button>
          <button
            type="button"
            className={`editor-tab ${mode === 'html' ? 'active' : ''}`}
            onClick={() => setMode('html')}
          >
            HTML
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="secondary"
          onClick={insertGeniusEmail}
          style={{ padding: '4px 10px', fontSize: 12, marginRight: 6 }}
          title="The Treasure Hill Genius appointment request, laid out as plain paragraphs with blue links"
        >
          Insert Genius appointment email
        </button>
        {mode === 'html' && (
          <button
            type="button"
            className="secondary"
            onClick={pasteSample}
            style={{ padding: '4px 10px', fontSize: 12 }}
          >
            Insert sample HTML
          </button>
        )}
      </div>

      {mode === 'rich' ? (
        <ReactQuill theme="snow" value={value || ''} onChange={onChange} modules={modules} />
      ) : (
        <textarea
          className="html-editor"
          spellCheck={false}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste HTML here. Handlebars variables like {{buyer.firstName}} are evaluated at send time."
        />
      )}
      {presetMsg && (
        <div className="error" style={{ fontSize: 12, marginTop: 4 }}>
          {presetMsg}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        {mode === 'rich'
          ? 'Rich-text editing — switch to HTML to paste full email markup (tables, inline styles, etc.).'
          : 'Raw HTML — accepts full HTML, including <table>, inline CSS, and Handlebars variables.'}
      </div>
    </div>
  );
}
