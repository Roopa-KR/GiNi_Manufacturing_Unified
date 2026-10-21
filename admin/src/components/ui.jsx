import React, { useEffect, useState } from 'react';
import { human, plantTime } from '../lib/fmt.js';
import { SHOW_SYNTHETIC_BANNER } from '../lib/api.js';

/* ------------------------------------------------------------------ icons (inline SVG, no icon font) */
const P = {
  work: 'M4 7h16v12H4zM9 7V5h6v2M4 12h16',
  queue: 'M4 6h16M4 12h16M4 18h10',
  progress: 'M4 19V9M10 19V5M16 19v-7M22 19H2',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  check: 'M5 12l4 4 10-10',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  tank: 'M5 6h14v12H5zM5 10h14M9 6V4h6v2',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c1-3.5 3.8-5 7-5s6 1.5 7 5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 15c2 .7 3.3 2.3 4 5',
  swap: 'M7 7h13l-3-3M17 17H4l3 3',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z',
  box: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3M5 4v4h4M19 20v-4h-4',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  x: 'M6 6l12 12M18 6L6 18',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  orders: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h4',
  factory: 'M3 21V10l6 3V9l6 3V5h6v16z',
  quality: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7',
  verify: 'M9 12l2 2 4-4M4 4h16v16H4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10',
  plus: 'M12 5v14M5 12h14',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};
export function Icon({ name, size = 18, className, title }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={P[name] || P.chevron} />
    </svg>
  );
}

/* ------------------------------------------------------------------ status semantics: tone + icon + text, never colour alone */
const TONE = {
  ok: ['WORKING', 'COMPLETED', 'RELEASED', 'PASS', 'GREEN', 'UP', 'CLOCKED_IN', 'ROUTE_COMPLETE', 'VERIFIED', 'DELIVERED', 'RESOLVED', 'CAPTURED', 'SENT', 'ON_TARGET', 'OK', 'READY', 'ACTIVE', 'APPROVED', 'DONE', 'INSPECTING', 'REPAIRING', 'COMPLETE', 'UP_TO_DATE', 'CONFIRMED', 'RELEASED_TO_NEXT_OPERATION', 'RELEASED_ROUTE_RESUMED', 'IN_PROGRESS', 'STARTED'],
  warn: ['PAUSED', 'AMBER', 'PENDING', 'BREAK', 'WAITING', 'QUEUED', 'QUEUED_FOR_REWORK', 'REWORK_IN_PROGRESS', 'AWAITING', 'RECOVERING', 'BELOW_MIN_CREW', 'INCOMPLETE', 'INCOMPLETE_INSPECTION_HOLD', 'TRANSFER', 'IN_TRANSFER', 'RETURN_REQUESTED', 'IN_RETURN_TRANSFER', 'PARTIALLY_DELIVERED', 'NOT_CLOCKED_IN', 'RETRY', 'UNCERTAIN', 'PROPOSED', 'RECALCULATING', 'AUTHORIZED_REWORK', 'PENDING_REVIEW', 'WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'PASS_PENDING_RELEASE', 'SUSPECTED', 'OPEN_UNKNOWN', 'STALE', 'INSUFFICIENT_DATA', 'MEDIUM', 'LOW', 'ACCEPTED', 'ASSIGNED', 'PENDING_UPLOAD', 'UPLOADED_PENDING_VERIFICATION', 'LOW_EFFICIENCY', 'SCHEDULED', 'WAITING_FOR_ENGINE'],
  bad: ['FAIL', 'RED', 'DOWN', 'FIRING', 'SCRAPPED', 'QUALITY_HOLD', 'FAILED_INSPECTION', 'ABSENT', 'BLOCKED', 'FAILED', 'DEAD', 'HIGH', 'REJECTED', 'ENGINE_UNAVAILABLE', 'SHORT', 'OVERDUE', 'STARVATION_PREDICTED', 'CONSTRAINED'],
  info: ['UNKNOWN', 'NO_DATA', 'NOT_STARTED', 'OFF_SHIFT', 'CLOCKED_OUT', 'CREATED', 'INDIRECT', 'NOT_RELEASED', 'NOT_YET', 'SUPPRESSED', 'CANCELLED', 'CLOSED', 'ACKNOWLEDGED', 'UNACKNOWLEDGED', 'NORMAL', 'HANDED_OVER', 'ENDED_BEFORE_OPERATION_FINISH', 'CURING', 'INSPECTION_IN_PROGRESS', 'REINSPECTION_IN_PROGRESS', 'RECEIVED_AT_REWORK_STATION', 'DRAFT', 'SUBMITTED'],
};
const ICON = { ok: '●', warn: '◐', bad: '▲', info: '○' };
export function toneOf(state) {
  const s = String(state || '').toUpperCase();
  for (const [k, v] of Object.entries(TONE)) if (v.includes(s)) return k;
  return 'info';
}
export function Status({ value, label, tone, lg }) {
  if (value === null || value === undefined || value === '') return <span className="badge">—</span>;
  const t = tone || toneOf(value);
  return <span className={`badge ${t}${lg ? ' lg' : ''}`}><span aria-hidden>{ICON[t]}</span>{label || human(value)}</span>;
}
export function Kind({ kind }) {
  const k = String(kind || '').toUpperCase();
  if (k === 'FORECAST') return <span className="badge forecast" title="Forecast - a projection, not observed">◇ Forecast</span>;
  if (k === 'PLANNED') return <span className="badge planned" title="Planned at the checkpoint - not yet happened">◌ Planned</span>;
  return <span className="badge observed" title="Observed from operational records">■ Observed</span>;
}

/* ------------------------------------------------------------------ building blocks */
export function Card({ title, icon, actions, children, className = '', hero, onClick, ...rest }) {
  return (
    <section className={`card${hero ? ' hero' : ''}${onClick ? ' clickable' : ''} ${className}`} onClick={onClick} {...rest}>
      {(title || actions) && <div className="card-h"><h2>{icon && <Icon name={icon} />}{title}</h2>{actions ? <div className="row">{actions}</div> : null}</div>}
      {children}
    </section>
  );
}
export function Banner({ tone = 'info', children, icon }) {
  return <div className={`banner ${tone}`} role={tone === 'bad' ? 'alert' : undefined}><span aria-hidden>{icon || (tone === 'bad' ? '⚠' : tone === 'ok' ? '✓' : tone === 'warn' ? '!' : 'ℹ')}</span><div>{children}</div></div>;
}
export function Loading({ lines = 3 }) {
  return <div className="stack" aria-busy="true" aria-label="Loading">{Array.from({ length: lines }).map((_, i) => <div key={i} className="skeleton" style={{ height: i === 0 ? 26 : 16, width: `${90 - i * 12}%` }} />)}</div>;
}
export function ErrorState({ error, onRetry }) {
  if (!error) return null;
  const denied = error.status === 403;
  const expired = error.status === 401;
  const msg = error.code === 'SESSION_INITIALIZING' ? 'The simulation is being initialised from the checkpoint. This takes a few seconds while the engine worker runs.'
    : error.status === 0 ? 'No connection to the GiNi API. Showing nothing rather than stale or invented data.'
      : denied ? `Your role does not allow this view or action (${error.message}). Ask a supervisor or administrator if you need it.`
        : expired ? 'Your sign-in has ended. Sign in again - nothing you saved is lost.'
          : error.message;
  return <Banner tone={error.code === 'SESSION_INITIALIZING' ? 'info' : denied ? 'warn' : 'bad'}><b>{error.code === 'SESSION_INITIALIZING' ? 'Initialising' : denied ? 'Not permitted' : expired ? 'Signed out' : 'Could not load'}</b> — {msg} {onRetry && <button className="btn sm" style={{ marginLeft: 8 }} onClick={onRetry}><Icon name="refresh" size={14} />Retry</button>}</Banner>;
}
export function Empty({ children, icon = 'box' }) {
  return <div className="empty"><Icon name={icon} size={28} /><div style={{ marginTop: 6 }}>{children}</div></div>;
}
export function KV({ items }) {
  return <dl className="kv">{items.filter(Boolean).map(([k, v], i) => <React.Fragment key={i}><dt>{k}</dt><dd>{v ?? '—'}</dd></React.Fragment>)}</dl>;
}
export function Modal({ title, onClose, children, wide, footer }) {
  useEffect(() => {
    const on = e => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Dialog'} onMouseDown={e => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className={`sheet${wide ? ' wide' : ''}`}>
        <div className="sheet-h"><h2>{title}</h2>{onClose && <button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon name="x" /></button>}</div>
        {children}
        {footer && <div className="btn-row" style={{ justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}
export function Busy({ busy, children, className = 'btn', ...rest }) {
  return <button className={className} disabled={busy || rest.disabled} {...rest}>{busy ? <span className="spinner" aria-hidden /> : null}{children}</button>;
}
export function SyntheticBanner({ mode, env }) {
  // fresh factory: environment, factory/site, mode, operational date and timezone (and the database NAME once signed in)
  if (env && env.freshFactory) {
    const f = env.factory || {};
    const modeLabel = (env.session && env.session.operatingMode === 'SIMULATED_TEST') || f.operatingMode === 'SIMULATED_TEST' ? 'Simulated test (designated simulated workers only)' : 'Manual team test · real time';
    return <div className="synthetic fresh" role="note">{(env.environmentName || 'Fresh factory').toUpperCase()} · {f.name ? `${f.name} (${f.siteId})` : 'factory not configured yet'} · {modeLabel}{env.operationalDate ? ` · ${env.operationalDate} ${env.timezone}` : ''}{env.database ? ` · database ${env.database}` : ''} · not a production system</div>;
  }
  if (!SHOW_SYNTHETIC_BANNER) return null;
  return <div className="synthetic">SYNTHETIC DEMONSTRATION DATA · {mode === 'REPLAY' ? 'Synthetic live replay (read-only)' : 'Synthetic interactive demo'} · not connected to any factory · not Siemens-approved</div>;
}
export function ModeBadge({ session }) {
  if (!session) return null;
  if (session.factorySession) {
    const sim = session.operatingMode === 'SIMULATED_TEST';
    return <span className={`pill-mode ${sim ? 'replay' : 'interactive'}`} title={sim ? 'Simulated test: only designated simulated workers are driven by agents; real people are never acted for' : 'Manual team test: real people, real time; no background agent completes anyone\'s work'}><span className="dot" />{sim ? 'Simulated test' : 'Team test · live'}</span>;
  }
  const replay = session.mode === 'REPLAY';
  return <span className={`pill-mode ${replay ? 'replay' : 'interactive'}`} title={replay ? 'Synthetic live replay: recorded history only; no new activity can be entered' : 'Synthetic interactive demo: a branch from the checkpoint; commands create new events'}><span className="dot" />{replay ? 'Replay · read-only' : 'Interactive'}</span>;
}
export function SimClock({ now, session }) {
  if (!session || !now) return null;
  const tz = session.plantTimezone || 'America/Bogota';
  const paused = session.clock && session.clock.paused;
  if (session.realTime) return (
    <div className="clock" title="Real time in the plant timezone (Manual Team Test - the clock cannot be paused or sped up)">
      <b>{plantTime(now.toISOString(), tz, true)}</b>
      <span>{tz} · real time</span>
    </div>
  );
  return (
    <div className="clock" title="Shared server-authoritative simulation clock (all viewers of this session see the same time)">
      <b>{plantTime(now.toISOString(), tz, true)}</b>
      <span>{tz} · {paused ? 'paused' : `×${session.clock ? session.clock.speed : 1}`} · simulated</span>
    </div>
  );
}
export function Freshness({ freshness, at }) {
  if (!freshness) return null;
  const s = freshness.analyticsStatus;
  const cls = s === 'UP_TO_DATE' ? 'ok' : (s === 'RECALCULATING' || s === 'WAITING_FOR_ENGINE') ? 'warn' : 'bad';
  const label = s === 'UP_TO_DATE' ? 'Analytics up to date' : s === 'RECALCULATING' ? `Recalculating (${freshness.analyticsLagEvents} new)` : s === 'WAITING_FOR_ENGINE' ? 'Waiting for engine' : 'Engine offline - analytics may be stale';
  return <span className={`fresh ${cls}`} title={`Operational data is live. Analytics watermark ${freshness.analyticsWatermarkSeq}/${freshness.eventSeq}. Loaded ${at ? at.toLocaleTimeString() : ''}`}><span className="dot" />{label}</span>;
}
export function Connection({ error }) {
  if (!error || error.status !== 0) return null;
  return <span className="fresh bad"><span className="dot" />Offline - retrying</span>;
}
export function Confirm({ title, message, confirmLabel = 'Confirm', tone = 'primary', onConfirm, onClose, requireText }) {
  const [busy, setBusy] = useState(false);
  const [txt, setTxt] = useState('');
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <Busy busy={busy} className={`btn ${tone}`} disabled={requireText && txt !== requireText} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirmLabel}</Busy>
    </>}>
      <div>{message}</div>
      {requireText && <div className="field"><label>Type <span className="mono">{requireText}</span> to confirm</label><input className="input" value={txt} onChange={e => setTxt(e.target.value)} autoFocus /></div>}
    </Modal>
  );
}
