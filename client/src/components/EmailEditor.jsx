import { useState } from 'react';
import ReactQuill from 'react-quill-new';

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

export default function EmailEditor({ value, onChange }) {
  const [mode, setMode] = useState('rich');

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
            onClick={() => setMode('rich')}
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
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        {mode === 'rich'
          ? 'Rich-text editing — switch to HTML to paste full email markup (tables, inline styles, etc.).'
          : 'Raw HTML — accepts full HTML, including <table>, inline CSS, and Handlebars variables.'}
      </div>
    </div>
  );
}
