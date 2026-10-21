import { Bars } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { useRouter, queryParam, usePoll, useApp } from '../lib/hooks.jsx';
import { human, plantTime } from '../lib/fmt.js';
import { Banner, Busy, Card, ErrorState, Icon, KV, Loading, Modal, Status, Empty, Kind } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { TankLink } from '../components/PassportSections.jsx';

export default function Alerts() {
  const { path, navigate } = useRouter();
  const sel = queryParam(path, 'alertId');
  const [filter, setFilter] = useState('open');
  const [tab, setTab] = useState('alerts');
  const qs = new URLSearchParams({ ...(filter === 'open' ? { open: '1' } : filter ? { state: filter } : {}), ...(sel ? { alertId: sel } : {}) });
  const { data, error, loading, reload } = useView(`/alerts?${qs}`, { interval: 5000 });
  const { run, busy } = useCommand();
  const [closeDlg, setCloseDlg] = useState(null);
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const tz = data.session.timezone;
  const a = sel ? data.alerts.find(x => x.alertId === sel) : null;
  const wf = (action, al, extra = {}) => run('ALERT_WORKFLOW', { alertId: al.alertId, action, ...extra }, `Alert ${human(action === 'ACK' ? 'acknowledged' : action === 'START' ? 'in progress' : 'closed')}`, reload);
  return (
    <div className="page">
      <h1>Variance alerts</h1>
      <Bars title="Alert state in this view" note="Counts follow the selected filter. Acknowledging an alert does not resolve its underlying condition." unit="alerts" rows={Object.entries(data.alerts.reduce((a,x)=>(a[x.evaluation]=(a[x.evaluation]||0)+1,a),{})).map(([label,value])=>({label,value}))}/>
      <Banner tone="info">{data.note}</Banner>
      <div className="tabs" role="tablist">
        {[['alerts', 'Alerts'], ['rules', `Rule evaluation${data.ruleEvaluation ? ` (${data.ruleEvaluation.rules.length})` : ''}`], ['email', `Notifications (${data.notifications.length})`]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'alerts' && <>
        <div className="seg" role="group" aria-label="Evaluation state filter">{[['open', 'Open'], ['FIRING', 'Firing'], ['PENDING', 'Pending'], ['RECOVERING', 'Recovering'], ['RESOLVED', 'Resolved'], ['', 'All']].map(([k, l]) => <button key={k || 'all'} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}</div>
        {data.alerts.length === 0 ? <Card><Empty icon="bell">No alert in this filter.</Empty></Card> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Rule</th><th>Entity</th><th>Evaluation</th><th>Workflow</th><th>Severity</th><th>Message</th><th>First detected</th><th /></tr></thead>
            <tbody>{data.alerts.map(x => (
              <tr key={x.alertId} className="clickable" onClick={() => navigate(`/alerts?alertId=${encodeURIComponent(x.alertId)}`)} style={sel === x.alertId ? { outline: '2px solid var(--brand)' } : undefined}>
                <td><b>{x.ruleId}</b><div className="small muted">{x.ruleName}</div></td><td className="small">{human(x.scope)} {x.scope === 'UNIT' ? <TankLink id={x.entityId} /> : x.entityId}</td><td><Status value={x.evaluation} /></td><td><Status value={x.workflow} /></td><td><Status value={x.severity} /></td>
                <td className="small" style={{ maxWidth: 420 }}>{x.message}</td><td className="small">{plantTime(x.firstDetectedAt, tz, true)}</td>
                <td onClick={e => e.stopPropagation()}><div className="row nowrap">
                  {x.workflow === 'UNACKNOWLEDGED' && <Busy busy={busy === 'ALERT_WORKFLOW' + x.alertId} className="btn sm" onClick={() => wf('ACK', x)}>Ack</Busy>}
                  {['UNACKNOWLEDGED', 'ACKNOWLEDGED'].includes(x.workflow) && <button className="btn sm" onClick={() => wf('START', x)}>Start</button>}
                  {x.workflow !== 'CLOSED' && <button className="btn sm" onClick={() => setCloseDlg(x)}>Close</button>}
                </div></td>
              </tr>
            ))}</tbody></table></div>
        )}
        {a && (
          <Card title={`${a.ruleId} · ${a.ruleName}`} icon="bell" actions={<><Status value={a.evaluation} /><Status value={a.workflow} /></>}>
            <div className="grid two">
              <KV items={[['Alert / episode', <span className="mono small" key="e">{a.alertId} / {a.episodeId}</span>], ['Entity', a.scope === 'UNIT' ? <TankLink key="t" id={a.entityId} /> : `${human(a.scope)} ${a.entityId}`], ['Actual', JSON.stringify(a.actual)], ['Expected / baseline', JSON.stringify(a.expected)], ['Delta', JSON.stringify(a.delta)], ['Threshold', JSON.stringify(a.threshold)], ['Window', a.window ? `${a.window} min` : '—'], ['Rule version', a.ruleVersion], ['Owner', a.owner || '—']]} />
              <div className="stack">
                <div><b>Why</b><div className="small">{a.message}</div></div>
                {a.recommended && <div><b>Recommended investigation</b><div className="small">{a.recommended}</div></div>}
                {a.evidence.length > 0 && <div><b>Evidence</b><div className="chip-list">{a.evidence.map(e => <span key={e} className="badge mono">{e}</span>)}</div></div>}
                {a.sample && <details className="more"><summary>Sample / data sufficiency</summary><pre className="small mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.sample, null, 1)}</pre></details>}
                {a.legacy && <div className="small muted">Legacy mapping: {a.legacy}</div>}
              </div>
            </div>
            <div className="section-title">Transitions (audit)</div>
            <ul className="timeline">{data.transitions.map((t, k) => <li key={k} className={t.KIND === 'WORKFLOW' ? 'session' : ''}><span className="t">{plantTime(t.AT, tz)}</span><span className="d" /><span>{t.KIND === 'WORKFLOW' ? 'Workflow' : 'Evaluation'} {human(t.FROM_STATE)} → <b>{human(t.TO_STATE)}</b> {t.ACTOR ? `· ${t.ACTOR}` : ''} {t.MESSAGE ? `· ${t.MESSAGE}` : ''} {t.NOTE ? `· “${t.NOTE}”` : ''}</span></li>)}</ul>
          </Card>
        )}
      </>}
      {tab === 'rules' && (data.ruleEvaluation ? (
        <Card title={`Latest evaluation (computed ${plantTime(data.ruleEvaluation.computedAt)} UTC wall time)`} actions={<Kind kind="FORECAST" />}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Rule</th><th>Entity</th><th>Status</th><th>Actual</th><th>Expected</th><th>Message</th></tr></thead>
            <tbody>{data.ruleEvaluation.rules.map((o, k) => <tr key={k}><td><b>{o.rule_id}</b><div className="small muted">{o.rule_name}</div></td><td className="small">{o.entity_id}</td><td><Status value={o.status === 'BREACH' ? 'FIRING' : o.status} label={human(o.status)} /></td><td className="small">{typeof o.actual === 'object' ? JSON.stringify(o.actual) : String(o.actual ?? '—')}</td><td className="small">{String(o.expected ?? '—')}</td><td className="small">{o.message}</td></tr>)}</tbody>
          </table></div>
          <span className="hint">INSUFFICIENT_DATA / NO_DATA are never treated as zero throughput or on-time.</span>
        </Card>) : <Empty>No evaluation yet.</Empty>)}
      {tab === 'email' && (
        <Card title="Notification outbox (this session)" icon="bell">
          {data.notifications.length === 0 ? <Empty icon="bell">No notification enqueued.</Empty> : <div className="table-wrap"><table className="table">
            <thead><tr><th>Created</th><th>Alert</th><th>Transition</th><th>Status</th><th>Attempts</th><th>Message ID / reason</th></tr></thead>
            <tbody>{data.notifications.map(n => <tr key={n.notificationId}><td className="small">{plantTime(n.createdAt)}</td><td className="small mono">{n.alertId}</td><td>{human(n.transition)}</td><td><Status value={n.status} /></td><td className="num">{n.attempts}</td><td className="small">{n.suppressedReason || n.error || n.messageId || ''}</td></tr>)}</tbody></table></div>}
          <span className="hint">Capture mode stores the email instead of sending it. One notification per alert episode and transition (dedup key); suppressed in replay, at accelerated speed and inside the cooldown.</span>
        </Card>
      )}
      {closeDlg && <CloseModal a={closeDlg} onClose={() => setCloseDlg(null)} onSave={(note, force) => wf('CLOSE', closeDlg, { note, force })} />}
    </div>
  );
}

function CloseModal({ a, onClose, onSave }) {
  const [note, setNote] = useState('');
  const active = ['FIRING', 'PENDING'].includes(a.evaluation);
  return (
    <Modal title="Close alert workflow" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={active && !note.trim()} onClick={async () => { const r = await onSave(note, active); if (r) onClose(); }}>Close workflow</button></>}>
      {active && <Banner tone="warn">The condition is still {human(a.evaluation)}. Closing the workflow does not resolve it; the evaluation keeps running. A note is required.</Banner>}
      <div className="field"><label>Note</label><textarea className="textarea" value={note} onChange={e => setNote(e.target.value)} /></div>
    </Modal>
  );
}
