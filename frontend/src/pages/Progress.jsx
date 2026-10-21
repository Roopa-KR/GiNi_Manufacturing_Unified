import { Bars, ProgressMeter } from '../components/Visuals.jsx';
import React from 'react';
import { useApp, usePoll } from '../lib/hooks.jsx';
import { hhmm, mins, human, signed } from '../lib/fmt.js';
import { Card, Empty, ErrorState, Kind, Loading, Status, Banner } from '../components/ui.jsx';
import { TankLink } from '../components/PassportSections.jsx';

const CAT_ORDER = ['DIRECT', 'REWORK', 'INSPECTING', 'WAITING', 'INDIRECT', 'BREAK', 'TRANSFER', 'BLOCKED', 'REPAIRING'];

export default function Progress() {
  const { session } = useApp();
  const sid = session && session.sessionId;
  const { data, error, loading, reload } = usePoll(sid && session.status !== 'INITIALIZING' ? `/sessions/${sid}/me/progress` : null, { interval: 10000 });
  if (!data && loading) return <div className="page"><Loading lines={6} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const cats = data.laborCategoriesMin || {};
  const keys = [...CAT_ORDER.filter(k => cats[k] !== undefined), ...Object.keys(cats).filter(k => !CAT_ORDER.includes(k))];
  const total = keys.reduce((s, k) => s + (cats[k] || 0), 0);
  const p = data.points || {};
  return (
    <div className="page">
      <h1>My progress</h1>
      <div className="grid four">
        <Card className="flat"><div className="stat"><b>{Number((p.total || {}).TOTAL || 0).toFixed(2)}</b><span>Points (as known now)</span></div></Card>
        <Card className="flat"><div className="stat"><b>{data.tasksCompleted.session + data.tasksCompleted.historyThisShift}</b><span>Tasks completed this shift</span></div></Card>
        <Card className="flat"><div className="stat"><b>{data.milestonesRecorded}</b><span>Milestones recorded (session)</span></div></Card>
        <Card className="flat"><div className="stat"><b>{data.remainingAssigned}</b><span>Remaining assigned tasks</span></div></Card>
      </div>

      <div className="grid two"><Bars title="Where my shift time went" note={data.categoriesBasis} unit="min" rows={keys.map(k=>({label:k,value:cats[k]}))}/><Bars title="My points breakdown" unit="points" signed note="Posted scores only; positive and negative values share a zero baseline." rows={[{label:'Quality',value:p.total?.QUALITY},{label:'Time',value:p.total?.TIME}]}/></div>
      <ProgressMeter label="Completed and remaining assigned tasks" value={data.tasksCompleted.session+data.tasksCompleted.historyThisShift} total={data.tasksCompleted.session+data.tasksCompleted.historyThisShift+data.remainingAssigned} note="Task-count progress, not tank output or effort-weighted completion." />
      <Card title="My labour categories this shift" icon="clock" actions={<Kind kind="OBSERVED" />}>
        {total === 0 ? <Empty icon="clock">No recorded time yet this shift.</Empty> : (
          <div className="stack">
            <div style={{ display: 'flex', height: 18, borderRadius: 99, overflow: 'hidden', border: '1px solid var(--line)' }} aria-hidden>
              {keys.map((k, i) => <div key={k} title={`${human(k)} ${mins(cats[k])}`} style={{ width: `${(cats[k] / total) * 100}%`, background: ['var(--brand)', 'var(--warn)', 'var(--info)', 'var(--line-strong)', 'var(--planned)', 'var(--ok)', 'var(--forecast)', 'var(--bad)'][i % 8] }} />)}
            </div>
            <div className="grid three">{keys.map(k => <div key={k} className="row between"><span>{human(k)}</span><b className="num">{mins(cats[k])}</b></div>)}</div>
            <span className="hint">{data.categoriesBasis}. Waiting caused by supply, equipment or material is not underperformance.</span>
          </div>
        )}
      </Card>

      <Card title="Accepted work shared in a crew" icon="users">
        {data.crewShares.length === 0 ? <Empty icon="users">No completed labour attempts yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Tank</th><th>Operation</th><th className="num">My eligible min</th><th className="num">Crew eligible min</th><th className="num">My share</th><th>Accepted</th></tr></thead>
            <tbody>{data.crewShares.map(s => <tr key={s.operationInstanceId}><td><TankLink id={s.unitId} /></td><td>{s.operationId}</td><td className="num">{Number(s.myEligibleMin).toFixed(0)}</td><td className="num">{Number(s.crewEligibleMin).toFixed(0)}</td><td className="num">{s.share === null ? '—' : `${(s.share * 100).toFixed(0)}%`}</td><td><Status value={s.accepted} /></td></tr>)}</tbody>
          </table></div>
        )}
        <span className="hint">A tank completed by a crew counts once for the crew; your share is your eligible minutes over the crew's.</span>
      </Card>

      <Card title="Points ledger" icon="progress">
        {p.total && <div className="row" style={{ marginBottom: 8 }}><span className="badge">Quality {signed(p.total.QUALITY || 0)}</span><span className="badge">Time {signed(p.total.TIME || 0)}</span><span className="badge brand">Total {signed(p.total.TOTAL || 0)}</span><span className="small muted">{p.basis}</span></div>}
        {data.ledger.length === 0 ? <Empty icon="progress">No points transactions known yet. Points post when the qualifying event is known (e.g. after the gate release).</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Known at</th><th>Rule</th><th>Reference</th><th className="num">Points</th><th>Status</th><th>Explanation</th></tr></thead>
            <tbody>{data.ledger.map(l => (
              <tr key={l.POINTS_TRANSACTION_ID}>
                <td className="small">{l.KNOWN_AT ? String(l.KNOWN_AT).slice(5, 16).replace('T', ' ') : '—'} <span className="badge">{l.scope === 'SESSION' ? 'session' : 'history'}</span></td>
                <td>{l.RULE_ID}</td><td className="small">{l.UNIT_ID ? <TankLink id={l.UNIT_ID} /> : (l.ORDER_ID || l.DEFECT_ID || '—')}</td>
                <td className="num" style={{ color: l.POINTS_DELTA < 0 ? 'var(--bad)' : l.POINTS_DELTA > 0 ? 'var(--ok)' : undefined, fontWeight: 700 }}>{signed(l.POINTS_DELTA)}</td>
                <td><Status value={l.ATTRIBUTION_STATUS || 'CONFIRMED'} />{l.REVERSAL_OF_ID && <span className="small muted"> reverses {l.REVERSAL_OF_ID}</span>}</td>
                <td className="small">{l.CALCULATION_NOTE || l.EVIDENCE_REFERENCE || ''}{l.STANDARD_ALLOWANCE_MIN !== undefined && ` · standard ${l.STANDARD_ALLOWANCE_MIN} vs actual ${l.ACTUAL_ELIGIBLE_MIN} min`}</td>
              </tr>
            ))}</tbody></table></div>
        )}
        <span className="hint">Every displayed score reconciles to these ledger rows. Corrections post inverse reversals; nothing is edited.</span>
      </Card>

      {(data.pendingPoints || []).length > 0 && (
        <Card title="Pending points (not booked yet)" icon="clock" actions={<Kind kind="CALCULATED" />}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Subject</th><th>Rule</th><th>Tank / order</th><th className="num">My eligible min</th><th>Why pending</th><th>Evaluated (sim)</th></tr></thead>
            <tbody>{data.pendingPoints.map(e => <tr key={e.subject}><td className="mono small">{e.subject}</td><td>{e.rule || '—'}</td><td className="small">{e.unitId ? <TankLink id={e.unitId} /> : (e.orderId || '—')}</td>
              <td className="num">{e.myEligibleMin === null ? '—' : Number(e.myEligibleMin).toFixed(1)}</td><td className="small">{e.reason}</td><td className="small">{hhmm(e.evaluatedAt)}</td></tr>)}</tbody>
          </table></div>
          <span className="hint">Pending items are re-evaluated on every calculation pass and post to the ledger only once their evidence is final.</span>
        </Card>
      )}

      {data.pendingInvestigations.length > 0 && (
        <Card title="Pending investigations" icon="quality">
          {data.pendingInvestigations.map(i => <Banner key={i.investigationId} tone="info"><b>{i.defectId}</b> on <TankLink id={i.unitId} /> ({human(i.status)}): {i.note}</Banner>)}
        </Card>
      )}
    </div>
  );
}
