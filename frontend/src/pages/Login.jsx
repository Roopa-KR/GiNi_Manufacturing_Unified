import React, { useState } from 'react';
import { api, rememberCsrf, APP_KIND } from '../lib/api.js';
import { useApp, useEnv } from '../lib/hooks.jsx';
import { Banner, Busy, Icon } from '../components/ui.jsx';

/** Employee ID + demo PIN. The PIN is always handled as text: leading zeros count. */
export default function Login() {
  const env = useEnv();
  const { setUser } = useApp();
  const [loginId, setLoginId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const admin = APP_KIND === 'admin';
  const submit = async (e) => {
    e && e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await api.post('/auth/login', { loginId: loginId.trim(), pin });
      rememberCsrf(r.csrfToken);
      setUser({ ...r.user, appKind: APP_KIND });
    } catch (ex) {
      setErr(ex);
      setPin('');
    } finally { setBusy(false); }
  };
  const key = (k) => setPin(p => (k === 'del' ? p.slice(0, -1) : k === 'clr' ? '' : (p + k).slice(0, 32)));
  return (
    <div className="login-wrap">
      <form className="card login-card stack" onSubmit={submit} style={{ gap: 16, padding: 24 }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="brand-mark" style={{ width: 44, height: 44, fontSize: 18 }}>Gi</span>
          <div className="stack tight"><h1>{admin ? 'GiNi Supervisor & Admin' : 'GiNi Operator'}</h1><span className="muted small">Transformer-tank manufacturing · {env && env.freshFactory ? `${(env.factory && env.factory.name) || 'fresh factory'} · team test` : 'synthetic demonstration'}</span></div>
        </div>
        <div className="field">
          <label htmlFor="lid">Employee ID</label>
          <input id="lid" className="input lg mono" autoComplete="username" autoCapitalize="characters" spellCheck="false" placeholder={admin ? 'admin or W0123' : 'e.g. W0042'} value={loginId} onChange={e => setLoginId(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="pin">{admin ? 'Password or PIN' : (env && env.freshFactory ? 'PIN' : 'Demo PIN')}</label>
          <input id="pin" className="input lg mono" type="password" inputMode={admin ? 'text' : 'numeric'} autoComplete="current-password" value={pin} onChange={e => setPin(e.target.value)} required />
          <span className="hint">The PIN is text, so leading zeros count (0042 is not 42).</span>
        </div>
        {!admin && (
          <div className="pinpad" aria-label="PIN keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del'].map(k => (
              <button type="button" key={k} onClick={() => key(k)} aria-label={k === 'del' ? 'Delete digit' : k === 'clr' ? 'Clear PIN' : `Digit ${k}`}>{k === 'del' ? '⌫' : k === 'clr' ? 'C' : k}</button>
            ))}
          </div>
        )}
        {err && <Banner tone="bad">{err.message}</Banner>}
        <Busy busy={busy} className="btn primary lg block" type="submit"><Icon name="check" />Sign in</Busy>
        <Banner tone="info">Signing in does not clock you in, start a task or change your shift. Your current attendance, task and progress are shown as recorded.</Banner>
      </form>
    </div>
  );
}
