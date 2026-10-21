import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, POLL_MS } from './api.js';

/* ------------------------------------------------------------------ tiny history router (deep links work through the SPA rewrite) */
const RouterCtx = createContext({ path: '/', navigate: () => {} });
export function Router({ children }) {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const on = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((to, replace = false) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return <RouterCtx.Provider value={{ path, navigate }}>{children}</RouterCtx.Provider>;
}
export const useRouter = () => useContext(RouterCtx);
export function Link({ to, children, className, onClick, ...rest }) {
  const { navigate, path } = useRouter();
  const active = to === '/' ? path === '/' : path.split('?')[0].startsWith(to);
  return <a href={to} className={className} aria-current={active ? 'page' : undefined} {...rest} onClick={e => { if (onClick) onClick(e); if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}
/** match "/inspection/:id" against the current path */
export function match(pattern, path) {
  const p = pattern.split('/').filter(Boolean), a = path.split('?')[0].split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const out = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return out;
}
export function queryParam(path, key) { return new URLSearchParams(path.split('?')[1] || '').get(key); }

/* ------------------------------------------------------------------ toasts */
const ToastCtx = createContext(() => {});
export function ToastHost({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'info', ms = 4200) => {
    const id = Math.random().toString(36).slice(2);
    setItems(x => [...x.slice(-3), { id, msg, kind }]);
    setTimeout(() => setItems(x => x.filter(i => i.id !== id)), ms);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {items.map(t => <div key={t.id} className={`toast ${t.kind}`}><span aria-hidden>{t.kind === 'bad' ? '⚠' : t.kind === 'ok' ? '✓' : 'ℹ'}</span><span>{t.msg}</span></div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ------------------------------------------------------------------ polling with backoff and visibility awareness */
export function usePoll(path, { interval = POLL_MS, enabled = true, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true, at: null });
  const timer = useRef(null);
  const failures = useRef(0);
  const ctrl = useRef(null);
  const load = useCallback(async (quiet) => {
    if (!path || !enabled) return;
    if (ctrl.current) ctrl.current.abort();
    ctrl.current = new AbortController();
    if (!quiet) setState(s => ({ ...s, loading: true }));
    try {
      const data = await api.get(path, { signal: ctrl.current.signal });
      failures.current = 0;
      setState({ data, error: null, loading: false, at: new Date() });
    } catch (e) {
      if (e.name === 'AbortError') return;
      failures.current += 1;
      setState(s => ({ ...s, error: e, loading: false }));
    }
  }, [path, enabled]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === 'visible') await load(true);
      const backoff = Math.min(60000, interval * Math.pow(2, Math.min(failures.current, 4)));
      timer.current = setTimeout(tick, failures.current ? backoff : interval);
    };
    setState(s => ({ ...s, loading: true }));
    load(false).then(() => { timer.current = setTimeout(tick, interval); });
    const vis = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', vis);
    return () => { alive = false; clearTimeout(timer.current); document.removeEventListener('visibilitychange', vis); if (ctrl.current) ctrl.current.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, interval, ...deps]);
  return { ...state, reload: () => load(true) };
}

/* ------------------------------------------------------------------ auth + simulation session context */
const AppCtx = createContext(null);
export function AppProvider({ children }) {
  const [user, setUser] = useState(undefined);       // undefined = checking, null = signed out
  const [session, setSession] = useState(null);
  const [sessionHint, setSessionHint] = useState(null);
  const refreshUser = useCallback(async () => {
    try { const r = await api.get('/auth/me'); setUser(r.user); return r.user; } catch (e) { setUser(null); return null; }
  }, []);
  const refreshSession = useCallback(async (preferred) => {
    try {
      const want = preferred || (() => { try { return localStorage.getItem('gini_session'); } catch (e) { return null; } })();
      if (want) {
        try { const r = await api.get(`/sessions/${encodeURIComponent(want)}`); if (r.session && !['ARCHIVED', 'PURGED'].includes(r.session.status)) { setSession(r.session); return r.session; } } catch (e) { /* fall back to default */ }
      }
      const r = await api.get('/sessions/default');
      setSession(r.session); setSessionHint(r.hint || null);
      return r.session;
    } catch (e) { setSession(null); return null; }
  }, []);
  const chooseSession = useCallback((sid) => { try { localStorage.setItem('gini_session', sid); } catch (e) { /* ignore */ } return refreshSession(sid); }, [refreshSession]);
  useEffect(() => { refreshUser(); }, [refreshUser]);
  useEffect(() => { if (user) refreshSession(); }, [user, refreshSession]);
  // keep the session header (clock anchors, status) current; simulated time is computed from the persisted anchors
  useEffect(() => {
    if (!user || !session) return undefined;
    const t = setInterval(() => refreshSession(session.sessionId), 15000);
    return () => clearInterval(t);
  }, [user, session && session.sessionId, refreshSession]);
  return <AppCtx.Provider value={{ user, setUser, refreshUser, session, setSession, refreshSession, chooseSession, sessionHint }}>{children}</AppCtx.Provider>;
}
export const useApp = () => useContext(AppCtx);

/** shared simulated clock: same formula as the server (anchor + (wall - anchorWall) x speed), ticking locally between polls */
export function useSimClock(session) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force(x => x + 1), 1000); return () => clearInterval(t); }, []);
  if (!session) return null;
  const base = new Date(session.simNow).getTime();
  const fetched = session._fetchedAt || (session._fetchedAt = Date.now());
  const speed = session.clock && !session.clock.paused ? Number(session.clock.speed || 1) : 0;
  let t = base + (Date.now() - fetched) * speed;
  if (session.horizonAt) t = Math.min(t, new Date(session.horizonAt).getTime());
  return new Date(t);
}

/** non-secret environment description (/api/environment): fresh factory vs synthetic demo, factory, mode, operational date */
export function useEnv() {
  const r = usePoll('/environment', { interval: 60000 });
  return r.data;
}

/** work-centre IDs to show: the configured active work centres of a fresh factory, the four core work centres of the synthetic demo */
const SYNTHETIC_WCS = ['WC1', 'WC2', 'WC3', 'WC4'];
export function useWorkCenterIds() {
  const r = usePoll('/admin/reference', { interval: 300000 });
  const d = r.data;
  if (!d) return { ids: [], loading: r.loading, ref: null };
  return { ids: d.freshFactory ? (d.workCenters || []).map(w => w.id) : SYNTHETIC_WCS, loading: false, ref: d };
}
