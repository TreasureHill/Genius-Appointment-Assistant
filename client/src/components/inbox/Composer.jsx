import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactQuill from 'react-quill-new';
import { streamPost } from '../../sse';
import { bytes, htmlToPlain, textToHtml } from '../../mailUtil.jsx';
import Icon from '../ui/Icon.jsx';
import RecipientInput from './RecipientInput.jsx';

const QUILL_MODULES = {
  toolbar: [['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['link', 'blockquote'], ['clean']],
};

const INTENTS = [
  { id: 'accept', label: 'Say yes', intent: 'agree to what they asked and confirm next steps' },
  { id: 'times', label: 'Propose times', intent: 'propose specific appointment times', availability: true },
  { id: 'info', label: 'Ask for details', intent: 'ask for the details still needed before we can help' },
  { id: 'decline', label: 'Decline politely', intent: 'politely decline while keeping the relationship warm' },
  { id: 'followup', label: 'Follow up', intent: 'follow up on the open question and nudge for a reply' },
  { id: 'thanks', label: 'Thank them', intent: 'thank them warmly and close the loop' },
];

const REFINES = [
  { label: 'Shorter', instructions: 'Make it noticeably shorter.' },
  { label: 'Warmer', instructions: 'Make it warmer and friendlier.' },
  { label: 'More formal', instructions: 'Make it more formal and polished.' },
  { label: 'More direct', instructions: 'Make it more direct; lead with the answer.' },
  { label: 'Fix grammar', instructions: 'Fix grammar, spelling and flow only; keep the wording otherwise.' },
];

const MODE_LABEL = { reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', new: 'New message' };

// Reply / reply-all / forward / new message, with Claude drafting in the
// owner's voice. `insert` ({ id, html }) appends HTML from outside (e.g. a
// Calendly link from the scheduler).
export default function Composer({
  mode,
  accounts,
  defaultAccountId,
  thread,
  replyTo,
  initial,
  ai,
  calendlyConnected,
  insert,
  onSent,
  onCancel,
  onSchedule,
  autoDraft,
}) {
  const [accountId, setAccountId] = useState(defaultAccountId || accounts?.[0]?._id || '');
  const [to, setTo] = useState(initial?.to || []);
  const [cc, setCc] = useState(initial?.cc || []);
  const [bcc, setBcc] = useState([]);
  const [showCc, setShowCc] = useState((initial?.cc || []).length > 0);
  const [subject, setSubject] = useState(initial?.subject || '');
  const [html, setHtml] = useState(initial?.html || '');
  const [files, setFiles] = useState([]);
  const [includeSignature, setIncludeSignature] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const [instructions, setInstructions] = useState('');
  const [intent, setIntent] = useState(null);
  const [tone, setTone] = useState('match');
  const [length, setLength] = useState('medium');
  const [withTimes, setWithTimes] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiMeta, setAiMeta] = useState(null);
  const [hasDraft, setHasDraft] = useState(false);
  const abortRef = useRef(null);
  const fileRef = useRef(null);
  const frame = useRef(0);
  const toRef = useRef(null);
  const ccRef = useRef(null);
  const bccRef = useRef(null);

  const account = useMemo(() => accounts?.find((a) => a._id === accountId) || null, [accounts, accountId]);

  useEffect(() => {
    if (!insert?.html) return;
    setHtml((h) => `${h || ''}${insert.html}`);
  }, [insert?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => abortRef.current?.abort(), []);

  // "Draft with Claude" opens the composer and starts drafting straight away.
  useEffect(() => {
    if (autoDraft && ai?.configured) runDraft();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isEmpty = !htmlToPlain(html);

  async function runDraft({ rewrite, refine } = {}) {
    if (drafting) return;
    setAiError('');
    setDrafting(true);
    setHasDraft(false);
    const controller = new AbortController();
    abortRef.current = controller;
    const chosen = INTENTS.find((i) => i.id === intent);
    const body = {
      mode: rewrite ? 'rewrite' : mode,
      threadId: thread?._id || null,
      accountId,
      instructions: refine || instructions,
      intent: rewrite ? '' : chosen?.intent || '',
      tone,
      length,
      includeAvailability: !rewrite && (withTimes || Boolean(chosen?.availability)),
      currentDraft: rewrite ? htmlToPlain(html) : '',
      to,
      subject,
    };
    let acc = '';
    const before = html;
    try {
      await streamPost('/api/ai/draft', body, {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === 'meta') setAiMeta(e);
          else if (e.type === 'subject') setSubject(e.subject);
          else if (e.type === 'text') {
            acc += e.text;
            cancelAnimationFrame(frame.current);
            frame.current = requestAnimationFrame(() => setHtml(textToHtml(acc)));
          } else if (e.type === 'done') {
            cancelAnimationFrame(frame.current);
            setHtml(textToHtml(e.body || acc));
            if (e.subject && !subject) setSubject(e.subject);
            setHasDraft(true);
            setAiMeta((m) => ({ ...(m || {}), usage: e.usage }));
          } else if (e.type === 'error') {
            setAiError(e.message);
            if (!acc) setHtml(before);
          }
        },
      });
    } catch (err) {
      if (err.name !== 'AbortError') setAiError(err.message);
    } finally {
      setDrafting(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setDrafting(false);
    setHasDraft(true);
  }

  async function send() {
    setError('');
    // Include anything still typed in the To / Cc / Bcc boxes.
    const finalTo = toRef.current ? toRef.current.commit() : to;
    const finalCc = ccRef.current ? ccRef.current.commit() : cc;
    const finalBcc = bccRef.current ? bccRef.current.commit() : bcc;
    if (!finalTo || !finalCc || !finalBcc) {
      setError('One of the addresses isn’t valid — fix it or remove it.');
      return;
    }
    if (!finalTo.length && !finalCc.length && !finalBcc.length) {
      setError('Add at least one recipient.');
      return;
    }
    if (mode === 'new' && !subject.trim() && !window.confirm('Send without a subject?')) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append(
        'payload',
        JSON.stringify({
          accountId,
          mode,
          replyToMessageId: replyTo?._id || null,
          to: finalTo,
          cc: finalCc,
          bcc: finalBcc,
          subject,
          html,
          includeSignature,
        })
      );
      for (const f of files) fd.append('files', f);
      const res = await fetch('/api/inbox/send', { method: 'POST', credentials: 'include', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sending failed');
      onSent?.(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!sending && !drafting) send();
    }
  }

  const replyName = replyTo?.from?.name || replyTo?.from?.email;

  return (
    <div className={`composer composer-${mode}`} onKeyDown={onKeyDown}>
      <div className="composer-head">
        <span className="composer-mode">
          <Icon name={mode === 'new' ? 'pencil' : mode === 'forward' ? 'forward' : mode === 'replyAll' ? 'replyAll' : 'reply'} size={15} />
          {MODE_LABEL[mode]}
          {replyName && mode !== 'new' && <span className="muted"> · to {replyName}</span>}
        </span>
        <div style={{ flex: 1 }} />
        {accounts?.length > 1 || mode === 'new' ? (
          <label className="composer-from">
            From
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={mode !== 'new'}>
              {(accounts || []).map((a) => (
                <option key={a._id} value={a._id}>
                  {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" className="icon-btn" onClick={onCancel} title="Discard" aria-label="Discard draft">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="composer-fields">
        <div className="composer-row">
          <RecipientInput ref={toRef} label="To" value={to} onChange={setTo} autoFocus={mode === 'new' || mode === 'forward'} />
          {!showCc && (
            <button type="button" className="link-btn" onClick={() => setShowCc(true)}>
              Cc / Bcc
            </button>
          )}
        </div>
        {showCc && (
          <>
            <div className="composer-row">
              <RecipientInput ref={ccRef} label="Cc" value={cc} onChange={setCc} />
            </div>
            <div className="composer-row">
              <RecipientInput ref={bccRef} label="Bcc" value={bcc} onChange={setBcc} />
            </div>
          </>
        )}
        {(mode === 'new' || mode === 'forward') && (
          <div className="composer-row">
            <span className="rcpt-label">Subject</span>
            <input className="composer-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
          </div>
        )}
      </div>

      <div className={`ai-bar${drafting ? ' is-drafting' : ''}`}>
        {!ai?.configured ? (
          <div className="ai-bar-off">
            <Icon name="sparkles" size={16} />
            <span>
              Draft replies in your voice with Claude — <Link to="/integrations">connect your Anthropic API key</Link>.
            </span>
          </div>
        ) : (
          <>
            <div className="ai-bar-top">
              <span className="ai-badge">
                <Icon name="sparkles" size={14} /> Claude
              </span>
              <div className="ai-intents" role="group" aria-label="What should the email do?">
                {(mode === 'new' ? INTENTS.filter((i) => ['times', 'info', 'followup', 'thanks'].includes(i.id)) : INTENTS).map((i) => (
                  <button
                    type="button"
                    key={i.id}
                    className={`chip${intent === i.id ? ' active' : ''}`}
                    onClick={() => setIntent((cur) => (cur === i.id ? null : i.id))}
                    disabled={drafting}
                  >
                    {i.label}
                  </button>
                ))}
              </div>
              <div className="ai-tune">
                <select value={tone} onChange={(e) => setTone(e.target.value)} disabled={drafting} aria-label="Tone" className="ai-select">
                  <option value="match">My usual tone</option>
                  <option value="friendly">Friendly</option>
                  <option value="formal">Formal</option>
                  <option value="direct">Direct</option>
                  <option value="apologetic">Apologetic</option>
                </select>
                <select value={length} onChange={(e) => setLength(e.target.value)} disabled={drafting} aria-label="Length" className="ai-select">
                  <option value="short">Short</option>
                  <option value="medium">Medium length</option>
                  <option value="detailed">Detailed</option>
                </select>
              </div>
            </div>
            <div className="ai-bar-main">
              <input
                className="ai-input"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    runDraft();
                  }
                }}
                placeholder={mode === 'new' ? 'What should this email say? e.g. “invite Jane to her walkthrough next week”' : 'Anything to add? e.g. “deck is done Friday, offer Tuesday morning”'}
                disabled={drafting}
              />
              {drafting ? (
                <button type="button" className="ai-go is-stop" onClick={stop}>
                  <Icon name="stop" size={14} /> Stop
                </button>
              ) : (
                <button type="button" className="ai-go" onClick={() => runDraft()}>
                  <Icon name="sparkles" size={15} /> {isEmpty ? (mode === 'new' ? 'Write it' : 'Draft reply') : 'Redraft'}
                </button>
              )}
            </div>
            <div className="ai-bar-foot">
              {calendlyConnected && (
                <label className="ai-toggle">
                  <input type="checkbox" checked={withTimes} onChange={(e) => setWithTimes(e.target.checked)} disabled={drafting} />
                  Offer my open Calendly times
                </label>
              )}
              {hasDraft && !drafting && (
                <div className="ai-refine">
                  <span className="muted">Refine:</span>
                  {REFINES.map((r) => (
                    <button type="button" key={r.label} className="chip chip-sm" onClick={() => runDraft({ rewrite: true, refine: r.instructions })}>
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ flex: 1 }} />
              {drafting && (
                <span className="ai-status">
                  <span className="ai-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {aiMeta ? `Writing in your voice · ${aiMeta.knowledgeEntries} knowledge ${aiMeta.knowledgeEntries === 1 ? 'entry' : 'entries'}${aiMeta.availability ? ` · ${aiMeta.availability} open times` : ''}` : 'Reading the conversation…'}
                </span>
              )}
              {!drafting && aiMeta?.usage && (
                <span className="ai-status muted" title="Tokens: input / cached / output">
                  {aiMeta.model} · {aiMeta.usage.cacheRead ? `${Math.round((aiMeta.usage.cacheRead / Math.max(1, aiMeta.usage.cacheRead + aiMeta.usage.input)) * 100)}% cached · ` : ''}
                  {aiMeta.usage.output} tokens out
                </span>
              )}
            </div>
            {aiError && (
              <div className="ai-error">
                <Icon name="alert" size={14} /> {aiError}
              </div>
            )}
          </>
        )}
      </div>

      <div className={`composer-editor${drafting ? ' is-streaming' : ''}`}>
        <ReactQuill theme="snow" value={html} onChange={setHtml} modules={QUILL_MODULES} readOnly={drafting} placeholder={drafting ? '' : 'Write your message…'} />
      </div>

      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f, i) => (
            <span className="file-chip" key={`${f.name}-${i}`}>
              <Icon name="paperclip" size={13} />
              {f.name}
              <span className="muted">{bytes(f.size)}</span>
              <button type="button" className="rcpt-chip-x" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="composer-error">
          <Icon name="alert" size={14} /> {error}
        </div>
      )}

      <div className="composer-foot">
        <button type="button" className="send-btn" onClick={send} disabled={sending || drafting}>
          <Icon name="send" size={15} />
          {sending ? 'Sending…' : 'Send'}
        </button>
        <span className="kbd-hint">
          <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
          <kbd>Enter</kbd>
        </span>
        <div style={{ flex: 1 }} />
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files || [])]);
            e.target.value = '';
          }}
        />
        <button type="button" className="tool-btn" onClick={() => fileRef.current?.click()} title="Attach files">
          <Icon name="paperclip" size={16} />
          <span>Attach</span>
        </button>
        {onSchedule && (
          <button type="button" className="tool-btn" onClick={onSchedule} title="Find a time on Calendly">
            <Icon name="calendarPlus" size={16} />
            <span>Schedule</span>
          </button>
        )}
        {account?.hasSignature || account?.signatureHtml ? (
          <label className="tool-check" title="Append this mailbox's signature">
            <input type="checkbox" checked={includeSignature} onChange={(e) => setIncludeSignature(e.target.checked)} />
            Signature
          </label>
        ) : null}
      </div>
    </div>
  );
}
