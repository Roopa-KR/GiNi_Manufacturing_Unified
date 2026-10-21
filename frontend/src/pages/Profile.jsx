import React, { useState } from 'react';
import { useApp, usePoll, useToast } from '../lib/hooks.jsx';
import { api, command } from '../lib/api.js';
import { human, hhmm } from '../lib/fmt.js';
import { Banner, Busy, Card, Icon, KV, Status } from '../components/ui.jsx';

export default function Profile() {
  const { user, setUser, session, chooseSession } = useApp();
  const toast = useToast();
  const sessions = usePoll('/sessions', { interval: 30000 });
  const [policy, setPolicy] = useState('RETURN_TO_SIMULATION');
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState({ cur: '', next: '', again: '' });
  const logout = async () => {
    setBusy(true);
    try {
      if (session && session.mode === 'INTERACTIVE' && user.workerId) {
        try { await command(session.sessionId, 'RELEASE_CONTROL', { workerId: user.workerId, policy }); } catch (e) { /* lease simply expires after 2 minutes */ }
      }
      await api.post('/auth/logout', {});
    } finally { setUser(null); setBusy(false); }
  };
  const changePin = async () => {
    if (pin.next !== pin.again) { toast('The new PINs do not match', 'bad'); return; }
    try { await api.post('/auth/change-pin', { currentPin: pin.cur, newPin: pin.next }); toast('PIN changed', 'ok'); setPin({ cur: '', next: '', again: '' }); } catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <div className="page">
      <h1>Profile</h1>
      <Card title={user.name} icon="profile">
        <KV items={[['Employee ID', <span className="mono" key="i">{user.workerId || user.loginId}</span>], ['Role', human(user.role)], ['Home work centre', user.homeWorkCenterId || '—'], ['Permissions', (user.permissions || []).map(human).join(', ')]]} />
      </Card>

      <Card title="Simulation session" icon="clock">
        <div className="stack">
          {session && <KV items={[['Session', `${session.name} (${session.sessionId})`], ['Mode', session.modeLabel], session.factorySession ? ['Clock', 'Real time (plant timezone)'] : ['Forked at', `${session.checkpointId || ''} ${String(session.forkAt).slice(0, 16).replace('T', ' ')} UTC`], ['Status', <Status key="s" value={session.status} />]]} />}
          {sessions.data && sessions.data.sessions.length > 1 && <div className="field"><label>Switch session</label>
            <select className="select" value={session ? session.sessionId : ''} onChange={e => chooseSession(e.target.value)}>
              {sessions.data.sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{s.name} · {s.modeLabel} · {s.status}{s.defaultFlag ? ' (default)' : ''}</option>)}
            </select></div>}
          <span className="hint">All viewers of a session share one simulated clock. Different sessions are isolated branches.</span>
        </div>
      </Card>

      {session && session.mode === 'INTERACTIVE' && (
        <Card title="Control of my simulated person" icon="swap">
          <div className="stack">
            <Banner tone="info">While you are signed in, background simulation does not act for you (a human control lease renewed every 45 s). When you sign out, choose what happens to your work - nothing is silently completed.</Banner>
            <label className="check"><input type="radio" checked={policy === 'RETURN_TO_SIMULATION'} onChange={() => setPolicy('RETURN_TO_SIMULATION')} /> <span><b>Return to simulation</b> - the simulated colleague continues your work.</span></label>
            <label className="check"><input type="radio" checked={policy === 'KEEP_TASK_PAUSED'} onChange={() => setPolicy('KEEP_TASK_PAUSED')} /> <span><b>Keep my task paused</b> - paused with reason "handover pending" until someone resumes it.</span></label>
          </div>
        </Card>
      )}

      <Card title="Change PIN" icon="settings">
        <div className="grid three">
          <div className="field"><label htmlFor="p1">Current PIN</label><input id="p1" type="password" className="input mono" value={pin.cur} onChange={e => setPin({ ...pin, cur: e.target.value })} /></div>
          <div className="field"><label htmlFor="p2">New PIN (6+ digits)</label><input id="p2" type="password" inputMode="numeric" className="input mono" value={pin.next} onChange={e => setPin({ ...pin, next: e.target.value })} /></div>
          <div className="field"><label htmlFor="p3">Repeat new PIN</label><input id="p3" type="password" inputMode="numeric" className="input mono" value={pin.again} onChange={e => setPin({ ...pin, again: e.target.value })} /></div>
        </div>
        <div style={{ marginTop: 10 }}><button className="btn" disabled={!pin.cur || pin.next.length < 6} onClick={changePin}>Change PIN</button></div>
      </Card>

      <Busy busy={busy} className="btn danger lg" onClick={logout}><Icon name="logout" />Sign out</Busy>
      <span className="hint">Signing out does not clock you out.</span>
    </div>
  );
}
