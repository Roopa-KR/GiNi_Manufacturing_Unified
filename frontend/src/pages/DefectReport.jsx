import React, { useState } from 'react';
import { useApp, usePoll, useRouter } from '../lib/hooks.jsx';
import { Banner, Busy, Card, ErrorState, Icon, Loading } from '../components/ui.jsx';
import { useCommand } from './Work.jsx';

/** report a defect found on a received tank against the correct PRIOR operation - recorded as detection, never as blame */
export default function DefectReport({ unitId }) {
  const { session } = useApp();
  const { navigate } = useRouter();
  const sid = session && session.sessionId;
  const { data, error, loading, reload } = usePoll(sid ? `/sessions/${sid}/units/${encodeURIComponent(unitId)}` : null, { interval: 60000 });
  const { run, busy } = useCommand();
  const [origin, setOrigin] = useState('');
  const [code, setCode] = useState('FAILED_VISUAL_CHECK');
  const [desc, setDesc] = useState('');
  const [severity, setSeverity] = useState('MINOR');
  const [done, setDone] = useState(null);
  if (!data && loading) return <div className="page"><Loading /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const seen = [];
  for (const a of data.attempts) if (a.kind === 'LABOR' && !seen.includes(a.operationId) && a.operationId !== data.unit.routeStep && (a.finishedAt || a.state === 'WORK_COMPLETED')) seen.push(a.operationId);
  return (
    <div className="page">
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/')}><Icon name="back" />Work</button>
      <Card hero title={<span className="row" style={{ gap: 8 }}><Icon name="alert" />Report incoming defect · <span className="mono">{data.unit.serial || unitId}</span></span>}>
        <div className="stack">
          <Banner tone="info">Use this when you find a problem on a tank you received. It is logged against the operation that most likely caused it - as a detection, not as blame. A quality approver decides what happens next; the origin crew is not penalised unless a reviewer confirms responsibility.</Banner>
          {done ? <Banner tone="ok">Defect {done.defectId || ''} recorded and the tank placed on hold for review ({done.holdId || 'hold opened'}).</Banner> : <>
            <div className="field"><label>Suspected origin operation (prior step)</label>
              {seen.length ? <div className="seg" role="group">{seen.map(o => <button key={o} aria-pressed={origin === o} onClick={() => setOrigin(o)}>{o}</button>)}</div> : <span className="muted">No completed prior labour operation is known for this tank.</span>}
            </div>
            <div className="field"><label>Defect type</label>
              <div className="seg" role="group">{[['FAILED_VISUAL_CHECK', 'Visual'], ['OUT_OF_TOLERANCE', 'Out of tolerance'], ['UNCLASSIFIED', 'Not sure']].map(([k, l]) => <button key={k} aria-pressed={code === k} onClick={() => setCode(k)}>{l}</button>)}</div>
            </div>
            <div className="field"><label>Severity as observed</label>
              <div className="seg" role="group">{['MINOR', 'MAJOR', 'CRITICAL'].map(k => <button key={k} aria-pressed={severity === k} onClick={() => setSeverity(k)}>{k.toLowerCase()}</button>)}</div>
            </div>
            <div className="field"><label htmlFor="d">What did you find?</label><textarea id="d" className="textarea" value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. weld spatter on flange, seam not ground" /></div>
            <Busy busy={busy === 'INCOMING_DEFECT_REPORT'} className="btn primary lg" disabled={!origin || !desc.trim() || data.session.mode === 'REPLAY'} onClick={async () => {
              const r = await run('INCOMING_DEFECT_REPORT', { unitId, suspectedOriginOperationId: origin, defectCode: code, description: desc.trim(), severity }, 'Defect reported - tank on hold for review');
              if (r) setDone(r.result || {});
            }}><Icon name="flag" />Report defect</Busy>
          </>}
        </div>
      </Card>
    </div>
  );
}
