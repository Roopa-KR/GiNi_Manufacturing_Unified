import React, { useState } from 'react';
import { AppProvider, Router, ToastHost, useApp, useRouter, match, Link, useSimClock, usePoll, useToast, useEnv } from './lib/hooks.jsx';
import { Icon, SyntheticBanner, ModeBadge, SimClock, Banner, Loading, Freshness, Busy } from './components/ui.jsx';
import { api } from './lib/api.js';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Orders, { OrderLine } from './pages/Orders.jsx';
import Passport from './pages/Passport.jsx';
import WorkCenters from './pages/WorkCenters.jsx';
import Workforce, { WorkerDetail } from './pages/Workforce.jsx';
import Quality, { InspectionReview } from './pages/Quality.jsx';
import Alerts from './pages/Alerts.jsx';
import Recovery from './pages/Recovery.jsx';
import Verify from './pages/Verify.jsx';
import Materials from './pages/Materials.jsx';
import Administration from './pages/Administration.jsx';
import Setup, { SetupGuide } from './pages/Setup.jsx';
import Dispatch from './pages/Dispatch.jsx';
import { TankLink } from './components/PassportSections.jsx';
import Assistant from './components/Assistant.jsx';

function TankSearch() {
  const { session } = useApp();
  const [q, setQ] = useState('');
  const res = usePoll(session && q.trim().length >= 3 ? `/sessions/${session.sessionId}/search?q=${encodeURIComponent(q.trim())}` : null, { interval: 60000 });
  const rows = (res.data && res.data.units) || [];
  return (
    <div className="search-wrap" style={{ position: 'relative' }}>
      <input className="input" style={{ minHeight: 32, width: 170, padding: '4px 8px' }} placeholder="Find tank ID / serial" aria-label="Find tank by ID or serial" value={q} onChange={e => setQ(e.target.value)} />
      {q.trim().length >= 3 && <div className="card" role="listbox" aria-label="Tank search results" style={{ position: 'absolute', top: 36, right: 0, zIndex: 30, minWidth: 280, maxHeight: 320, overflow: 'auto', padding: 8 }}>
        {res.loading && !res.data ? <span className="small muted">Searching…</span> : rows.length === 0 ? <span className="small muted">No tank matches “{q}”.</span>
          : rows.map(u => <div key={u.unitId} className="row between small" onClick={() => setQ('')}><TankLink id={u.unitId}>{u.serial || u.unitId}</TankLink><span className="muted">{u.unitId} · {u.state || 'history'}</span></div>)}
      </div>}
    </div>
  );
}

export default function App() {
  return <AppProvider><Router><ToastHost><Shell /></ToastHost></Router></AppProvider>;
}

const NAV = [
  ['Observe', [['/', 'overview', 'Overview'], ['/orders', 'orders', 'Orders & Batches'], ['/work-centers', 'factory', 'Work Centers'], ['/workforce', 'users', 'Workforce']]],
  ['Quality & decisions', [['/quality', 'quality', 'Quality & Rework'], ['/alerts', 'bell', 'Alerts'], ['/recovery', 'route', 'Recovery'], ['/verify', 'verify', 'Verify']]],
  ['Plant', [['/materials', 'box', 'Materials & Equipment'], ['/admin', 'settings', 'Administration']]],
];
// fresh factory: the setup checklist and the dispatch board come first
const FRESH_NAV = [['Fresh factory', [['/setup', 'settings', 'Factory setup'], ['/dispatch', 'users', 'Dispatch & assign']]], ...NAV];

function ClockBar() {
  const { session, user, refreshSession } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  if (!session) return null;
  const can = (user.permissions || []).includes('scenario_control') && !session.realTime;
  const clock = async (body) => {
    setBusy(body.action + (body.speed || ''));
    try { await api.post(`/sessions/${session.sessionId}/clock`, body); await refreshSession(session.sessionId); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(null); }
  };
  const recalc = async () => {
    try { await api.post(`/sessions/${session.sessionId}/recalculate`, {}); toast('Recalculation queued - analytics refresh within seconds', 'ok'); } catch (e) { toast(e.message, 'bad'); }
  };
  const paused = session.clock && session.clock.paused;
  return (
    <div className="row" style={{ gap: 6 }}>
      {can && <>
        {paused ? <Busy busy={busy === 'PLAY'} className="btn sm primary" onClick={() => clock({ action: 'PLAY' })} title="Run the shared simulation clock"><Icon name="play" size={14} />Play</Busy>
          : <Busy busy={busy === 'PAUSE'} className="btn sm" onClick={() => clock({ action: 'PAUSE' })}><Icon name="pause" size={14} />Pause</Busy>}
        <select className="select" style={{ minHeight: 32, width: 78, padding: '4px 8px' }} aria-label="Simulation speed" value={(session.clock || {}).speed || 1} onChange={e => clock({ action: 'SPEED', speed: Number(e.target.value) })}>
          {[1, 2, 5, 10, 30, 60, 120].map(s => <option key={s} value={s}>×{s}</option>)}
        </select>
      </>}
      <button className="btn sm" onClick={recalc} title="Queue a recalculation job (GET requests never change the simulation)"><Icon name="refresh" size={14} /><span className="hide-sm">Recalculate</span></button>
    </div>
  );
}

function Shell() {
  const { user, session, sessionHint } = useApp();
  const { path } = useRouter();
  const now = useSimClock(session);
  const env = useEnv();
  const fresh = usePoll(session && session.status !== 'INITIALIZING' ? `/sessions/${session.sessionId}/freshness` : null, { interval: 10000 });
  if (user === undefined) return <div className="login-wrap"><div className="login-card"><Loading /></div></div>;
  if (!user) return <><SyntheticBanner env={env} /><Login /></>;
  const isFresh = !!(env && env.freshFactory);
  let m, page;
  if (!session && isFresh) page = <div className="page"><Banner tone="warn"><b>The fresh factory is not initialised.</b> Run <span className="mono">npm run factory:init</span> in the backend folder once (it creates the empty permanent factory session; it never imports or seeds anything), then reload this page.</Banner></div>;
  else if (!session) page = <div className="page"><Banner tone="warn"><b>No simulation session exists yet.</b> {sessionHint} Create one under Administration → Simulation.</Banner><Administration initialTab="simulation" /></div>;
  else if (path.startsWith('/setup')) page = <Setup />;
  else if (path.startsWith('/dispatch')) page = <Dispatch />;
  else if ((m = match('/orders/:lineId', path))) page = <OrderLine lineId={m.lineId} />;
  else if ((m = match('/units/:unitId', path))) page = <Passport unitId={m.unitId} />;
  else if ((m = match('/workforce/:wid', path))) page = <WorkerDetail wid={m.wid} />;
  else if ((m = match('/inspections/:id', path))) page = <InspectionReview id={m.id} />;
  else if ((m = match('/work-centers/:wc', path))) page = <WorkCenters wc={m.wc} />;
  else if (path.startsWith('/orders')) page = <Orders />;
  else if (path.startsWith('/work-centers')) page = <WorkCenters />;
  else if (path.startsWith('/workforce')) page = <Workforce />;
  else if (path.startsWith('/quality')) page = <Quality />;
  else if (path.startsWith('/alerts')) page = <Alerts />;
  else if (path.startsWith('/recovery')) page = <Recovery />;
  else if (path.startsWith('/verify')) page = <Verify />;
  else if (path.startsWith('/materials')) page = <Materials />;
  else if (path.startsWith('/admin')) page = <Administration />;
  else page = isFresh ? <><SetupGuide compact /><Overview /></> : <Overview />;
  return (
    <div className="app">
      <SyntheticBanner mode={session && session.mode} env={env} />
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><span className="brand-mark">Gi</span><span className="hide-sm">GiNi Supervisor</span></div>
          {isFresh ? <span className="badge hide-sm" title="Fresh factory team-test environment">{(env.factory && env.factory.name) || 'Fresh factory'}</span> : <span className="badge hide-sm" title="Fictional demo site - not a real factory">Demo plant</span>}
          <ModeBadge session={session} />
          {fresh.data && <Freshness freshness={fresh.data.freshness} at={fresh.at} />}
          <div className="spacer" />
          {session && <TankSearch />}
          <ClockBar />
          <SimClock now={now} session={session} />
          <span className="avatar hide-sm" title={`${user.name} · ${(user.roles || []).join(', ')}`}>{(user.name || '?').split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase()}</span>
          <button className="btn sm ghost" title="Sign out" onClick={async () => { try { await api.post('/auth/logout', {}); } finally { window.location.href = '/'; } }}><Icon name="logout" /></button>
        </div>
      </header>
      <div className="shell">
        <nav className="sidebar" aria-label="Sections">
          {(isFresh ? FRESH_NAV : NAV).map(([sec, items]) => <React.Fragment key={sec}><div className="sb-sec">{sec}</div>{items.map(([to, icon, label]) => <Link key={to} to={to}><Icon name={icon} />{label}</Link>)}</React.Fragment>)}
        </nav>
        <main className="main">
          {user.mustChangePin && <div className="page" style={{ paddingBottom: 0 }}><Banner tone="warn">Your initial administrator password must be changed (Administration → My account).</Banner></div>}
          {session && session.status === 'INITIALIZING' && <div className="page" style={{ paddingBottom: 0 }}><Banner tone="info">Session {session.sessionId} is being initialised from checkpoint {session.checkpointId} by the engine worker.</Banner></div>}
          {page}
        </main>
      </div>
      <Assistant />
    </div>
  );
}
