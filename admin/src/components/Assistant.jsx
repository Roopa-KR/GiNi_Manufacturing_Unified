import React, { useEffect, useRef, useState } from 'react';
import { api, APP_KIND } from '../lib/api.js';
import { useApp, useRouter } from '../lib/hooks.jsx';

/* GiNi Assistant: floating chat panel backed by Google Gemini through the GiNi API (/api/assistant). The API key stays on the server
   (backend/.env GEMINI_API_KEY); this component only sends the question, the conversation and the current screen path. The server adds
   the live plant data the signed-in user is allowed to see. Read-only: the assistant explains and guides, it never changes anything. */

const SUGGESTIONS = {
  admin: ['Summarise the plant right now', 'Which orders are at risk and why?', 'What are the most urgent alerts?', 'Which work centre is the bottleneck?'],
  operator: ['What should I do next?', 'Explain my current task', 'Why can\'t I start my task?', 'How do I report a defect?'],
};
const STORE_KEY = `gini_assistant_${APP_KIND}`;

/* ---- minimal, safe markdown (bold, inline code, bullet / numbered lists, headings) - rendered as React elements, no HTML injection */
function inline(text, keyBase) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={keyBase + i}>{p.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(p)) return <code key={keyBase + i}>{p.slice(1, -1)}</code>;
    return <React.Fragment key={keyBase + i}>{p}</React.Fragment>;
  });
}
function Markdown({ text }) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let list = null;
  const flush = () => { if (list) { blocks.push(list); list = null; } };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    let m;
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); return; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); return; }
    flush();
    if (!line.trim()) return;
    if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { blocks.push({ type: 'h', text: m[1], i }); return; }
    blocks.push({ type: 'p', text: line, i });
  });
  flush();
  return <>{blocks.map((b, k) => b.type === 'ul' ? <ul key={k}>{b.items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}-`)}</li>)}</ul>
    : b.type === 'ol' ? <ol key={k}>{b.items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}-`)}</li>)}</ol>
      : b.type === 'h' ? <p key={k} className="chat-h">{inline(b.text, `${k}-`)}</p>
        : <p key={k}>{inline(b.text, `${k}-`)}</p>)}</>;
}

function loadHistory() { try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; } }
function saveHistory(msgs) { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(msgs.slice(-30))); } catch (e) { /* storage unavailable */ } }

const BotIcon = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v3M8 6h8a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-5l-4 3v-3.3A4 4 0 0 1 4 15v-5a4 4 0 0 1 4-4z" /><path d="M9 12h.01M15 12h.01" />
  </svg>
);
const CloseIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;
const SendIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></svg>;

export default function Assistant() {
  const { user, session } = useApp();
  const { path } = useRouter();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState(loadHistory);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const kind = APP_KIND === 'admin' ? 'admin' : 'operator';

  useEffect(() => { saveHistory(msgs); }, [msgs]);
  useEffect(() => {
    if (!open) return;
    api.get('/assistant/status').then(setStatus).catch(e => setStatus({ enabled: false, hint: e.message }));
    setTimeout(() => inputRef.current && inputRef.current.focus(), 50);
  }, [open]);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy, open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!user) return null;

  const send = async (text) => {
    const q = String(text ?? input).trim();
    if (!q || busy) return;
    const next = [...msgs, { role: 'user', content: q }];
    setMsgs(next); setInput(''); setBusy(true);
    try {
      const r = await api.post('/assistant/chat', {
        sessionId: session ? session.sessionId : null,
        page: path,
        messages: next.filter(m => !m.error).map(({ role, content }) => ({ role, content })),
      });
      setMsgs(m => [...m, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      setMsgs(m => [...m, { role: 'assistant', content: e.message || 'The assistant is not available right now.', error: true }]);
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
    }
  };

  const disabled = status && status.enabled === false;
  return (
    <div className={`chat-dock ${kind}`}>
      {open && (
        <section className="chat-panel" role="dialog" aria-label="GiNi Assistant">
          <header className="chat-head">
            <span className="chat-avatar"><BotIcon size={18} /></span>
            <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
              <b>GiNi Assistant</b>
              <span className="small muted">{status && status.enabled ? `Gemini · ${status.model} · reads live plant data` : 'Powered by Google Gemini'}</span>
            </div>
            {msgs.length > 0 && <button className="btn sm ghost" onClick={() => setMsgs([])} title="Start a new conversation">Clear</button>}
            <button className="btn sm ghost" onClick={() => setOpen(false)} aria-label="Close assistant"><CloseIcon /></button>
          </header>
          <div className="chat-body" ref={listRef} aria-live="polite">
            {disabled && <div className="chat-setup"><b>Assistant not configured.</b> {status.hint || 'Add GEMINI_API_KEY to backend/.env and restart the API.'}</div>}
            {msgs.length === 0 && !disabled && (
              <div className="chat-empty">
                <p>Hi {(user.name || '').split(' ')[0] || 'there'} - ask me about {kind === 'admin' ? 'the plant, orders, alerts, quality or how to use a screen' : 'your current task, your queue, inspections or how to use the app'}. I read the same live data you see.</p>
                <div className="chat-suggest">{SUGGESTIONS[kind].map(s => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}${m.error ? ' error' : ''}`}>
                {m.role === 'assistant' ? <Markdown text={m.content} /> : <p>{m.content}</p>}
              </div>
            ))}
            {busy && <div className="chat-msg assistant typing" aria-label="Assistant is typing"><span /><span /><span /></div>}
          </div>
          <form className="chat-input" onSubmit={e => { e.preventDefault(); send(); }}>
            <textarea ref={inputRef} className="textarea" rows={1} value={input} placeholder={disabled ? 'Assistant not configured' : 'Ask GiNi Assistant…'} aria-label="Message"
              disabled={disabled} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button type="submit" className="btn primary" disabled={busy || disabled || !input.trim()} aria-label="Send"><SendIcon /></button>
          </form>
          <div className="chat-foot small muted">AI answers can be wrong - check figures on the screen before acting. Synthetic demo data.</div>
        </section>
      )}
      <button className={`chat-fab${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={open ? 'Close GiNi Assistant' : 'Open GiNi Assistant'} title="GiNi Assistant">
        {open ? <CloseIcon /> : <BotIcon />}
      </button>
    </div>
  );
}
