import React, { useEffect, useRef } from 'react';
import { AppProvider, Router, ToastHost, useApp, useRouter, match, Link, useSimClock, useEnv } from './lib/hooks.jsx';
import { Icon, SyntheticBanner, ModeBadge, SimClock, Banner, Loading } from './components/ui.jsx';
import { command } from './lib/api.js';
import Login from './pages/Login.jsx';
import Work from './pages/Work.jsx';
import Queue from './pages/Queue.jsx';
import Progress from './pages/Progress.jsx';
import Profile from './pages/Profile.jsx';
import Inspection from './pages/Inspection.jsx';
import DefectReport from './pages/DefectReport.jsx';
import TaskView from './pages/TaskView.jsx';
import TankPassport from './pages/TankPassport.jsx';
import { ScanButton } from './components/Scan.jsx';
import Assistant from './components/Assistant.jsx';

export default function App() {
  return (
    <AppProvider>
      <Router>
        <ToastHost>
          <Shell />
        </ToastHost>
      </Router>
    </AppProvider>
  );
}

/** human control lease: while this tester is signed in, background agents do not act for this worker */
function useControlLease(session, user) {
  const taken = useRef(null);
  useEffect(() => {
    // fresh factory: people are HUMAN_ONLY - no lease is needed (and none could ever expire into an agent taking over)
    if (!session || !user || !user.workerId || session.mode !== 'INTERACTIVE' || session.status === 'INITIALIZING' || session.factorySession) return undefined;
    let alive = true;
    const key = `${session.sessionId}|${user.workerId}`;
    const take = async () => {
      try { await command(session.sessionId, 'TAKE_CONTROL', { workerId: user.workerId }); taken.current = key; } catch (e) { /* shown on the profile page */ }
    };
    if (taken.current !== key) take();
    const hb = setInterval(async () => {
      if (!alive) return;
      try { const r = await command(session.sessionId, 'CONTROL_HEARTBEAT', { workerId: user.workerId }); if (r && r.result && r.result.controlled === false) take(); } catch (e) { /* offline: lease expires after 2 min, agents resume */ }
    }, 45000);
    return () => { alive = false; clearInterval(hb); };
  }, [session && session.sessionId, session && session.status, user && user.workerId]);
}

function Shell() {
  const { user, session, sessionHint } = useApp();
  const { path } = useRouter();
  const now = useSimClock(session);
  useControlLease(session, user);
  const env = useEnv();
  if (user === undefined) return <div className="login-wrap"><div className="login-card"><Loading /></div></div>;
  if (!user) return <><SyntheticBanner env={env} /><Login /></>;
  let page;
  let m;
  if (!session) page = <div className="page"><Banner tone="warn"><b>{env && env.freshFactory ? 'The factory is not initialised yet.' : 'No simulation session is available.'}</b> {env && env.freshFactory ? 'Ask your administrator to finish the factory setup.' : (sessionHint || 'Ask a supervisor to create one in the admin application.')}</Banner></div>;
  else if ((m = match('/inspection/:id', path))) page = <Inspection id={m.id} />;
  else if ((m = match('/defect/:unitId', path))) page = <DefectReport unitId={m.unitId} />;
  else if ((m = match('/task/:taskId', path))) page = <TaskView taskId={m.taskId} />;
  else if ((m = match('/tanks/:unitId', path))) page = <TankPassport unitId={m.unitId} />;
  else if (path.startsWith('/queue')) page = <Queue />;
  else if (path.startsWith('/progress')) page = <Progress />;
  else if (path.startsWith('/profile')) page = <Profile />;
  else page = <Work />;
  return (
    <div className="app">
      <SyntheticBanner mode={session && session.mode} env={env} />
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><span className="brand-mark">Gi</span><span className="hide-sm">GiNi Operator</span></div>
          <ModeBadge session={session} />
          <div className="spacer" />
          {session && session.status !== 'INITIALIZING' && <ScanButton />}
          <SimClock now={now} session={session} />
          <div className="row nowrap hide-sm" style={{ gap: 8 }}><span className="avatar">{(user.name || '?').split(' ').map(x => x[0]).slice(0, 2).join('')}</span><div className="stack tight"><b style={{ fontSize: 14 }}>{user.name}</b><span className="small muted mono">{user.workerId || user.loginId}</span></div></div>
        </div>
      </header>
      {session && session.status === 'INITIALIZING' && <div className="page" style={{ paddingBottom: 0 }}><Banner tone="info">The simulation is being initialised from checkpoint {session.checkpointId}. Screens fill in a few seconds after the engine worker processes it.</Banner></div>}
      {page}
      <nav className="bottomnav" aria-label="Main">
        <div className="bottomnav-inner">
          <Link to="/"><Icon name="work" />Work</Link>
          <Link to="/queue"><Icon name="queue" />Queue</Link>
          <Link to="/progress"><Icon name="progress" />Progress</Link>
          <Link to="/profile"><Icon name="profile" />Profile</Link>
        </div>
      </nav>
      <Assistant />
    </div>
  );
}
