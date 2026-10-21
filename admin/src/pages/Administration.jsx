import React, { useState } from 'react';
import { useApp, usePoll, useToast, useRouter, queryParam, useWorkCenterIds, useEnv } from '../lib/hooks.jsx';
import { api, newKey } from '../lib/api.js';
import { human, plantTime } from '../lib/fmt.js';
import { Banner, Busy, Card, Confirm, ErrorState, Icon, KV, Loading, Modal, Status, Empty } from '../components/ui.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { SimpleModal } from './Workforce.jsx';

const TABS = [['workers', 'Workers'], ['simulation', 'Simulation'], ['scenario', 'Scenario console'], ['rules', 'Rule settings'], ['system', 'Jobs & engine'], ['notifications', 'Notifications'], ['import', 'Import & reconciliation'], ['audit', 'Audit'], ['account', 'My account']];

export default function Administration({ initialTab }) {
  const { path, navigate } = useRouter();
  const tab = queryParam(path, 'tab') || initialTab || 'workers';
  const { user } = useApp();
  const perms = user.permissions || [];
  return (
    <div className="page">
      <h1>Administration</h1>
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => navigate(`/admin?tab=${k}`)}>{l}</button>)}</div>
      {tab === 'workers' && <Workers canManage={perms.includes('manage_workers')} />}
      {tab === 'simulation' && <Simulation canControl={perms.includes('scenario_control')} />}
      {tab === 'scenario' && <ScenarioConsole canControl={perms.includes('scenario_control')} />}
      {tab === 'rules' && <Rules canEdit={perms.includes('rule_editing')} />}
      {tab === 'system' && <System />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'import' && <ImportStatus />}
      {tab === 'audit' && <Audit />}
      {tab === 'account' && <Account />}
    </div>
  );
}

/* ------------------------------------------------------------------ workers */
function Workers({ canManage }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(role ? { role } : {}) });
  const { data, error, loading, reload } = usePoll(`/admin/workers?${qs}`, { interval: 30000 });
  const ref = usePoll('/admin/reference', { interval: 600000 });
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState(null);
  const [pinFor, setPinFor] = useState(null);
  const [deleteFor, setDeleteFor] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [page, setPage] = useState(1);
  if (!data && loading) return <Loading lines={8} />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  const rows = data.workers.slice((page - 1) * 50, page * 50);
  return (
    <div className="stack">
      {!canManage && <Banner tone="warn">You can view people; only administrators with “manage workers” create, edit or deactivate them.</Banner>}
      <div className="row between">
        <div className="row">
          <input className="input" style={{ maxWidth: 240 }} placeholder="Search name or ID" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} aria-label="Search" />
          <select className="select" style={{ maxWidth: 220 }} value={role} onChange={e => { setRole(e.target.value); setPage(1); }}><option value="">All roles</option>{Object.keys(data.roleCounts).map(r => <option key={r} value={r}>{human(r)}</option>)}</select>
          <span className="small muted">{data.total} people · {Object.entries(data.roleCounts).map(([k, v]) => `${human(k)} ${v}`).join(' · ')}</span>
        </div>
        {canManage && <button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" size={16} />New worker</button>}
      </div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Worker</th><th>Role / app role</th><th>Home WC</th><th>Shift</th><th>Account</th><th>Qualifications</th><th>Origin</th><th /></tr></thead>
        <tbody>{rows.map(w => (
          <tr key={w.workerId}>
            <td><b>{w.name}</b><div className="small muted mono">{w.workerId} · login {w.loginId || '—'}</div></td>
            <td className="small">{human(w.role)}<div className="muted">{w.appRoles.join(', ')}</div></td><td>{w.homeWorkCenterId}</td><td>{w.shiftCrew}</td>
            <td><Status value={w.accountStatus} /></td>
            <td className="small">{w.qualifications.map(x => x.skillId).join(', ') || '—'}</td>
            <td><span className="badge">{human(w.origin)}</span></td>
            <td>{canManage && <div className="row nowrap">
              <button className="btn sm" onClick={() => setEdit(w)}>Edit</button>
              <button className="btn sm" onClick={() => setPinFor(w)}>PIN</button>
              {ref.data?.freshFactory && <button className="btn sm danger" onClick={() => setDeleteFor(w)}>Delete unused</button>}
              {w.active ? <button className="btn sm" onClick={() => setConfirm({ w, active: false })}>Deactivate</button> : <button className="btn sm" onClick={() => setConfirm({ w, active: true })}>Activate</button>}
            </div>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button><span className="small">Page {page} of {Math.max(1, Math.ceil(data.workers.length / 50))}</span><button className="btn sm" disabled={page * 50 >= data.workers.length} onClick={() => setPage(p => p + 1)}>Next</button></div>
      {create && ref.data && <CreateWorker ref_={ref.data} onClose={() => setCreate(false)} onDone={reload} />}
      {edit && <EditWorker w={edit} ref_={ref.data} onClose={() => setEdit(null)} onDone={reload} />}
      {deleteFor && <SimpleModal title={`Delete unused worker ${deleteFor.name}`} fields={[["confirmWorkerId", `Type ${deleteFor.workerId} to permanently delete. Workers with history must be deactivated.`, 'text', '']]} onClose={() => setDeleteFor(null)} submit={async v => { try { await api.post(`/admin/workers/${deleteFor.workerId}/delete`, v, { idempotencyKey: newKey('worker-delete') }); toast('Unused worker and account deleted', 'ok'); reload(); return true; } catch (e) { toast(e.message, 'bad'); return null; } }} />}
      {pinFor && <SimpleModal title={`Reset PIN for ${pinFor.name}`} fields={[['pin', 'New initial PIN (6-8 digits, leading zeros kept)', 'text', '']]} onClose={() => setPinFor(null)}
        submit={async v => { try { await api.post(`/admin/workers/${pinFor.workerId}/reset-pin`, { pin: String(v.pin) }, { idempotencyKey: newKey('pin-reset') }); toast('PIN reset - the person must change it at next sign-in', 'ok'); return true; } catch (e) { toast(e.message, 'bad'); return null; } }} />}
      {confirm && <Confirm title={`${confirm.active ? 'Activate' : 'Deactivate'} ${confirm.w.name}?`} tone={confirm.active ? 'primary' : 'danger'} confirmLabel={confirm.active ? 'Activate' : 'Deactivate'}
        message={confirm.active ? 'Activation restores sign-in. It does not clock the person in.' : 'Future sign-in is blocked and open sessions are revoked. Historical attribution, tasks and points are kept.'}
        onClose={() => setConfirm(null)} onConfirm={async () => { try { await api.post(`/admin/workers/${confirm.w.workerId}/${confirm.active ? 'activate' : 'deactivate'}`, {}, { idempotencyKey: newKey('worker-active') }); toast('Saved', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }} />}
    </div>
  );
}

function QualEditor({ skills, value, onChange }) {
  return (
    <div className="stack tight">
      {value.map((q, i) => (
        <div key={i} className="row">
          <select className="select" style={{ maxWidth: 230 }} value={q.skillId} onChange={e => onChange(value.map((x, k) => (k === i ? { ...x, skillId: e.target.value } : x)))}>{skills.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}</select>
          <select className="select" style={{ maxWidth: 150 }} value={q.level} onChange={e => onChange(value.map((x, k) => (k === i ? { ...x, level: e.target.value } : x)))}>{['TRAINEE', 'QUALIFIED', 'EXPERT'].map(l => <option key={l} value={l}>{human(l)}</option>)}</select>
          <input className="input" style={{ maxWidth: 150 }} type="date" value={q.validFrom || ''} onChange={e => onChange(value.map((x, k) => (k === i ? { ...x, validFrom: e.target.value } : x)))} aria-label="Valid from" />
          <input className="input" style={{ maxWidth: 150 }} type="date" value={q.validTo || ''} onChange={e => onChange(value.map((x, k) => (k === i ? { ...x, validTo: e.target.value } : x)))} aria-label="Valid to" />
          <label className="check"><input type="checkbox" checked={q.independent !== false} onChange={e => onChange(value.map((x, k) => (k === i ? { ...x, independent: e.target.checked } : x)))} /> independent</label>
          <button className="btn sm ghost" onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label="Remove"><Icon name="x" size={14} /></button>
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...value, { skillId: (skills[0] || {}).id, level: 'QUALIFIED', independent: true }])}><Icon name="plus" size={14} />Add qualification</button>
    </div>
  );
}

function CreateWorker({ ref_, onClose, onDone }) {
  const toast = useToast();
  const env = useEnv();
  const r = ref_ || { workCenters: [], skills: [], roles: [], shifts: ['A', 'B'], shiftTemplates: [] };
  const fresh = !!r.freshFactory;
  const firstWc = (r.workCenters[0] || {}).id || '';
  const firstShift = (r.shifts || [])[0] || '';
  const [f, setF] = useState({ employeeNumber: '', firstName: '', lastName: '', displayName: '', workerRole: 'PRODUCTION_OPERATOR', siteId: fresh ? ((env && env.factory && env.factory.siteId) || '') : 'SITE-DEMO-01', team: '', supervisorId: '', homeWorkCenterId: firstWc, employmentStatus: 'ACTIVE', employmentType: 'FULL_TIME',
    startDate: '', shiftCode: firstShift, startOption: 'JOIN_CURRENT_SHIFT', authorizedAreas: '', loginId: '', initialPin: '', pinMustChange: true, preferredLanguage: 'en', timezone: (r.timezone || (env && env.timezone)) || 'America/Bogota', badgeId: '', contactEmail: '', simulatedWorker: false });
  const [quals, setQuals] = useState(r.skills.length ? [{ skillId: r.skills[0].id, level: 'QUALIFIED', independent: true }] : []);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  // one Idempotency-Key per creation attempt: a retry after a lost response returns the first result instead of a second worker;
  // a refused request (4xx: nothing was written) gets a fresh key so a corrected form is a new request
  const [key, setKey] = useState(() => newKey('worker-create'));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const submit = async () => {
    setBusy(true);
    try {
      const body = { ...f, authorizedAreas: f.authorizedAreas ? f.authorizedAreas.split(',').map(s => s.trim()).filter(Boolean) : [], qualifications: quals.filter(q => q.skillId), initialPin: String(f.initialPin) };
      for (const k of ['displayName', 'loginId', 'startDate', 'team', 'supervisorId', 'badgeId', 'contactEmail', 'employeeNumber', 'siteId']) if (!body[k]) delete body[k];
      if (!body.simulatedWorker) delete body.simulatedWorker;
      const res = await api.post('/admin/workers', body, { idempotencyKey: key });
      setDone(res); onDone();
    } catch (e) { if (e.status >= 400 && e.status < 500) setKey(newKey('worker-create')); toast(e.message, 'bad', 8000); } finally { setBusy(false); }
  };
  if (done) return (
    <Modal title="Worker created" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <Banner tone="ok"><b>{done.displayName}</b> created as <span className="mono">{done.workerId}</span> (login <span className="mono">{done.loginId}</span>, role {done.appRole}).</Banner>
      <KV items={[['Login ID', <span className="mono">{done.loginId}</span>], ['First shift', done.firstShift ? `${done.firstShift.shiftId}${done.firstShift.joinsCurrent ? ' (running now)' : ''}` : 'none scheduled yet'], ['Roster rows', done.rosterRows], ['Prior activity', 'none - zero tasks, zero points, no attendance, not clocked in']]} />
      <div className="card flat"><b>Onboarding instructions to give the person</b><ol className="small" style={{ margin: '6px 0 0 18px' }}>
        <li>Open the operator application (the address your administrator gives you) on a tablet or phone.</li>
        <li>Sign in with login ID <span className="mono">{done.loginId}</span> and the initial PIN you were told in person{f.pinMustChange ? ', then choose a new PIN' : ''}.</li>
        <li>Signing in does not clock you in: press <b>Clock in</b> on the Work screen when your shift starts.</li>
        <li>Your assigned work appears on the Work and Queue screens; start it there.</li>
      </ol></div>
      <span className="hint">{done.note} The PIN is not shown again or stored in readable form.</span>
    </Modal>
  );
  return (
    <Modal wide title="New worker" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><Busy busy={busy} className="btn primary" disabled={!f.firstName || !f.lastName || !/^\d{6,8}$/.test(f.initialPin) || !f.shiftCode || !f.homeWorkCenterId || (f.startOption === 'FUTURE_START' && !f.startDate)} onClick={submit}>Create worker and login</Busy></>}>
      {fresh && !(r.shifts || []).length && <Banner tone="warn">No shift is configured yet. Add a shift under Factory setup → Shifts first - every worker belongs to a shift.</Banner>}
      {fresh && !r.workCenters.length && <Banner tone="warn">No work centre is configured yet. Add one under Factory setup → Work centres first.</Banner>}
      <div className="grid three">
        <Field label="Employee number"><input className="input" value={f.employeeNumber} onChange={set('employeeNumber')} placeholder="auto = worker ID" /></Field>
        <Field label="First name *"><input className="input" value={f.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name *"><input className="input" value={f.lastName} onChange={set('lastName')} /></Field>
        <Field label="Display name"><input className="input" value={f.displayName} onChange={set('displayName')} placeholder={`${f.firstName} ${f.lastName}`.trim()} /></Field>
        <Field label="Role *"><select className="select" value={f.workerRole} onChange={set('workerRole')}>{(r.roles || []).map(x => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
        <Field label="Home work centre *"><select className="select" value={f.homeWorkCenterId} onChange={set('homeWorkCenterId')}>{r.workCenters.map(w => <option key={w.id} value={w.id}>{w.id} · {w.name}</option>)}</select></Field>
        <Field label="Site"><input className="input" value={f.siteId} onChange={set('siteId')} placeholder={fresh ? 'factory site' : ''} /></Field>
        <Field label="Team"><input className="input" value={f.team} onChange={set('team')} /></Field>
        <Field label="Supervisor (worker ID)"><input className="input mono" value={f.supervisorId} onChange={set('supervisorId')} /></Field>
        <Field label="Employment status"><select className="select" value={f.employmentStatus} onChange={set('employmentStatus')}>{['ACTIVE', 'ON_LEAVE'].map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Employment type"><select className="select" value={f.employmentType} onChange={set('employmentType')}>{['FULL_TIME', 'PART_TIME', 'TEMPORARY'].map(x => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Shift / calendar *"><select className="select" value={f.shiftCode} onChange={set('shiftCode')}>{fresh ? (r.shiftTemplates || []).map(t => <option key={t.code} value={t.code}>{t.code} · {t.name} {t.start}–{t.end}{t.overnight ? ' (overnight)' : ''}</option>) : <><option value="A">A · 06:00–14:30</option><option value="B">B · 14:30–23:00</option></>}</select></Field>
        <Field label="First shift *"><select className="select" value={f.startOption} onChange={set('startOption')}><option value="JOIN_CURRENT_SHIFT">Join the current shift (if this crew's shift is running)</option><option value="NEXT_SHIFT">Start from the next shift</option><option value="FUTURE_START">Future start date</option></select></Field>
        <Field label={f.startOption === 'FUTURE_START' ? 'Start date * (plant local)' : (fresh ? 'Start date (default: today, plant time)' : 'Start date (default: simulation date)')}><input className="input" type="date" value={f.startDate} onChange={set('startDate')} /></Field>
        <Field label="Authorised areas (comma separated)"><input className="input" value={f.authorizedAreas} onChange={set('authorizedAreas')} placeholder="area IDs" /></Field>
        <Field label="Preferred language"><select className="select" value={f.preferredLanguage} onChange={set('preferredLanguage')}><option value="en">English</option><option value="es">Spanish</option><option value="de">German</option></select></Field>
        <Field label="Timezone"><input className="input" value={f.timezone} onChange={set('timezone')} /></Field>
        <Field label="Login ID (default = worker ID)"><input className="input mono" value={f.loginId} onChange={set('loginId')} /></Field>
        <Field label="Initial PIN * (6-8 digits)"><input className="input mono" inputMode="numeric" autoComplete="new-password" value={f.initialPin} onChange={set('initialPin')} /></Field>
        <Field label="Badge (optional)"><input className="input" value={f.badgeId} onChange={set('badgeId')} /></Field>
        <Field label="Contact email (optional, never emailed in tests)"><input className="input" value={f.contactEmail} onChange={set('contactEmail')} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.pinMustChange} onChange={set('pinMustChange')} /> Require a PIN change at first sign-in</label>
      {r.operatingMode === 'SIMULATED_TEST' && <label className="check"><input type="checkbox" checked={f.simulatedWorker} onChange={set('simulatedWorker')} /> Designated <b>simulated</b> worker (driven by background agents in Simulated Test mode - never tick this for a real person)</label>}
      <div className="field"><label>Qualifications (validity dates are checked whenever a task starts; untick "independent" for supervised-only)</label><QualEditor skills={r.skills} value={quals} onChange={setQuals} /></div>
      <Banner tone="info">The new person gets a permanent worker ID, a linked login and planned roster rows for the chosen shift - nothing else. No attendance, tasks, labour or points are created; creating the account never marks anyone present.</Banner>
    </Modal>
  );
}

function EditWorker({ w, ref_, onClose, onDone }) {
  const toast = useToast();
  const r = ref_ || { workCenters: [], skills: [], roles: [] };
  const [f, setF] = useState({ displayName: w.name, workerRole: w.role, homeWorkCenterId: w.homeWorkCenterId, shiftCode: w.shiftCrew });
  const [quals, setQuals] = useState([]);
  const [revoke, setRevoke] = useState([]);
  const [key, setKey] = useState(() => newKey('worker-edit'));
  return (
    <Modal title={`Edit ${w.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => {
      try { await api.patch(`/admin/workers/${w.workerId}`, { ...f, ...(f.workerRole === w.role ? { workerRole: undefined } : {}), ...(f.shiftCode === w.shiftCrew ? { shiftCode: undefined } : {}), addQualifications: quals, revokeQualifications: revoke }, { idempotencyKey: key }); toast('Saved (audited)', 'ok'); onDone(); onClose(); } catch (e) { if (e.status >= 400 && e.status < 500) setKey(newKey('worker-edit')); toast(e.message, 'bad'); }
    }}>Save</button></>}>
      <Field label="Display name"><input className="input" value={f.displayName} onChange={e => setF({ ...f, displayName: e.target.value })} /></Field>
      <Field label="Role (changes the account's permissions)"><select className="select" value={f.workerRole} onChange={e => setF({ ...f, workerRole: e.target.value })}>{(r.roles || []).map(x => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
      <Field label="Home work centre"><select className="select" value={f.homeWorkCenterId} onChange={e => setF({ ...f, homeWorkCenterId: e.target.value })}>{r.workCenters.map(x => <option key={x.id} value={x.id}>{x.id}</option>)}</select></Field>
      <Field label="Shift (future planned shifts move to the new crew; history stays)"><select className="select" value={f.shiftCode || ''} onChange={e => setF({ ...f, shiftCode: e.target.value })}>{(r.shifts || ['A', 'B']).map(x => <option key={x} value={x}>{x}</option>)}</select></Field>
      <div className="field"><label>Current qualifications (tick to revoke - the record is kept with its end date)</label><div className="stack tight">{w.qualifications.length ? w.qualifications.map(q => <label key={q.skillId + String(q.validTo)} className="check small"><input type="checkbox" checked={revoke.includes(q.skillId)} onChange={e => setRevoke(e.target.checked ? [...revoke, q.skillId] : revoke.filter(x => x !== q.skillId))} /> {q.skillId} ({human(q.level)}{q.validTo ? ` to ${String(q.validTo).slice(0, 10)}` : ''})</label>) : <span className="small">none</span>}</div></div>
      <div className="field"><label>Add qualifications</label><QualEditor skills={r.skills} value={quals} onChange={setQuals} /></div>
    </Modal>
  );
}

function Field({ label, children }) { return <div className="field"><label>{label}</label>{children}</div>; }

/* ------------------------------------------------------------------ simulation sessions */
function Simulation({ canControl }) {
  const toast = useToast();
  const { session, chooseSession, refreshSession } = useApp();
  const { data, reload } = usePoll('/sessions', { interval: 8000 });
  const ref = usePoll('/admin/reference', { interval: 600000 });
  const [mode, setMode] = useState('INTERACTIVE');
  const [ck, setCk] = useState('CK-20261015-1055');
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(null);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/sessions', { mode, checkpointId: ck, name: name || undefined, makeDefault });
      toast(`Session ${r.session.sessionId} created - the engine initialises it from ${ck}`, 'ok');
      reload(); chooseSession(r.session.sessionId);
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const act = async (fn, msg) => { try { await fn(); toast(msg, 'ok'); reload(); refreshSession(session && session.sessionId); } catch (e) { toast(e.message, 'bad'); } };
  return (
    <div className="stack">
      <Card title="Sessions" icon="clock">
        {!data ? <Loading /> : data.sessions.length === 0 ? <Empty icon="clock">No session yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Session</th><th>Mode</th><th>Checkpoint / fork</th><th>Simulated now</th><th>Clock</th><th>Status</th><th>Engine</th><th /></tr></thead>
            <tbody>{data.sessions.map(s => (
              <tr key={s.sessionId} style={session && session.sessionId === s.sessionId ? { outline: '2px solid var(--brand)' } : undefined}>
                <td><b>{s.name}</b><div className="small muted mono">{s.sessionId}{s.defaultFlag ? ' · default' : ''}</div></td><td className="small">{s.modeLabel}</td>
                <td className="small">{s.checkpointId || '—'}<div className="muted">{plantTime(s.forkAt, s.plantTimezone, true)}</div></td><td className="small">{plantTime(s.simNow, s.plantTimezone, true)}</td>
                <td className="small">{s.clock.paused ? 'paused' : `running ×${s.clock.speed}`}</td><td><Status value={s.status} /></td>
                <td className="small">events {s.eventSeq} · watermark {s.engine.watermarkSeq} · v{s.engine.projectionVersion}<div className="muted">heartbeat {s.engine.heartbeatAt ? plantTime(s.engine.heartbeatAt, 'UTC') + ' UTC' : 'never'}</div></td>
                <td><div className="row nowrap">
                  <button className="btn sm" onClick={() => chooseSession(s.sessionId)}>Open</button>
                  {canControl && !s.defaultFlag && <button className="btn sm" onClick={() => act(() => api.post(`/sessions/${s.sessionId}/default`, {}), 'Default session set')}>Make default</button>}
                  {canControl && s.mode === 'INTERACTIVE' && <button className="btn sm warn" onClick={() => setReset(s)}>Reset</button>}
                  {canControl && <button className="btn sm" onClick={() => act(() => api.post(`/sessions/${s.sessionId}/archive`, {}), 'Archived')}>Archive</button>}
                </div></td>
              </tr>
            ))}</tbody></table></div>
        )}
      </Card>
      {canControl && <Card title="Create a session" icon="plus">
        <div className="grid three">
          <Field label="Mode"><div className="seg"><button aria-pressed={mode === 'INTERACTIVE'} onClick={() => setMode('INTERACTIVE')}>Interactive simulation</button><button aria-pressed={mode === 'REPLAY'} onClick={() => setMode('REPLAY')}>Live replay</button></div></Field>
          <Field label="Checkpoint"><select className="select" value={ck} onChange={e => setCk(e.target.value)}>{((ref.data || {}).checkpoints || [{ id: 'CK-20261015-1055' }]).map(c => <option key={c.id} value={c.id}>{c.id} {c.purpose ? `· ${c.purpose.slice(0, 50)}` : ''}</option>)}</select></Field>
          <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Client demo branch" /></Field>
        </div>
        <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} /> Make it the default session for everyone</label>
        <div style={{ marginTop: 10 }}><Busy busy={busy} className="btn primary" onClick={create}>Create session</Busy></div>
        <span className="hint">Interactive: a branch from the checkpoint - history frozen at the fork, branch-local future, background colleagues continue. Replay: read-only recorded history with play/pause/speed/seek. Sessions are isolated from each other.</span>
      </Card>}
      {canControl && session && session.mode === 'REPLAY' && <ReplaySeek session={session} onDone={() => refreshSession(session.sessionId)} />}
      {reset && <Confirm title={`Reset ${reset.sessionId} to its checkpoint?`} tone="danger" confirmLabel="Reset session" requireText={`RESET ${reset.sessionId}`}
        message={<>All activity entered in <b>this session only</b> (events, tasks, inspections, photos, alerts, points, forecasts) is deleted and the plant restarts from {reset.checkpointId}. Other sessions and the seeded history are untouched.</>}
        onClose={() => setReset(null)} onConfirm={() => act(() => api.post(`/sessions/${reset.sessionId}/reset`, { confirm: `RESET ${reset.sessionId}` }), 'Reset - the engine re-initialises the session')} />}
    </div>
  );
}

function ReplaySeek({ session, onDone }) {
  const toast = useToast();
  const [t, setT] = useState(String(session.simNow).slice(0, 16));
  return (
    <Card title="Replay seek" icon="clock">
      <div className="row"><input className="input" type="datetime-local" style={{ maxWidth: 260 }} value={t} onChange={e => setT(e.target.value)} /><span className="small muted">UTC</span>
        <button className="btn primary" onClick={async () => { try { await api.post(`/sessions/${session.sessionId}/clock`, { action: 'SEEK', seekTo: new Date(t + ':00Z').toISOString() }); toast('Seeked - the replay projection is rebuilt as known at that time', 'ok'); onDone(); } catch (e) { toast(e.message, 'bad'); } }}>Seek</button></div>
    </Card>
  );
}

/* ------------------------------------------------------------------ scenario console: inject causes, never set flags */
function ScenarioConsole({ canControl }) {
  const { session } = useApp();
  const { run, busy } = useCommand();
  const sid = session && session.sessionId;
  const ref = usePoll('/admin/reference', { interval: 600000 });
  const workers = usePoll(sid ? `/sessions/${sid}/workforce?pageSize=200` : null, { interval: 20000 });
  const [w, setW] = useState('');
  const [mat, setMat] = useState('MAT-MARK');
  const [qty, setQty] = useState(0);
  const [supplyMin, setSupplyMin] = useState(240);
  const [eq, setEq] = useState('FX-01');
  const [eqMin, setEqMin] = useState(60);
  const [unit, setUnit] = useState('');
  const [gate, setGate] = useState('');
  const [sev, setSev] = useState('REPAIRABLE');
  const [lag, setLag] = useState(8);
  const [toWc, setToWc] = useState('WC2');
  const { ids: wcIds } = useWorkCenterIds();
  const people = (workers.data && workers.data.workers) || [];
  const r = ref.data || { materials: [], equipment: [] };
  if (!session || session.mode !== 'INTERACTIVE') return <Banner tone="info">The scenario console works on an interactive session. Open or create one under Simulation.</Banner>;
  if (!canControl) return <Banner tone="warn">Requires scenario control permission.</Banner>;
  return (
    <div className="stack">
      <Banner tone="info">Each button creates a realistic <b>cause</b> through the same command services the plant uses. Alerts, forecasts and points then follow from the engine - nothing here sets a flag or edits a total. Scope: session {sid} only.</Banner>
      <div className="grid two">
        <Card title="Absence / mid-shift exit" icon="users">
          <select className="select" value={w} onChange={e => setW(e.target.value)}><option value="">Choose a person…</option>{people.filter(p => p.role === 'PRODUCTION_OPERATOR' || p.role === 'QUALITY_INSPECTOR').map(p => <option key={p.workerId} value={p.workerId}>{p.name} ({p.workerId}) · {human(p.plantState)}</option>)}</select>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Busy busy={busy === 'ABSENCE_CONFIRM' + w} className="btn" disabled={!w} onClick={() => run('ABSENCE_CONFIRM', { workerId: w, reason: 'SICK', midShiftExit: (people.find(p => p.workerId === w) || {}).attendance === 'CLOCKED_IN' }, 'Absence recorded - tasks paused, crews and forecasts react')}>Record absence</Busy>
            <select className="select" style={{ maxWidth: 110 }} value={toWc} onChange={e => setToWc(e.target.value)}>{wcIds.map(x => <option key={x}>{x}</option>)}</select>
            <Busy busy={busy === 'WORKER_TRANSFER' + w} className="btn" disabled={!w} onClick={() => run('WORKER_TRANSFER', { workerId: w, toWorkCenterId: toWc, reason: 'SUPERVISOR_DIRECTED_TRANSFER' }, 'Transfer started')}>Transfer</Busy>
          </div>
        </Card>
        <Card title="Material shortage" icon="box">
          <div className="row"><select className="select" style={{ maxWidth: 220 }} value={mat} onChange={e => setMat(e.target.value)}>{r.materials.map(m => <option key={m.id} value={m.id}>{m.id} · {m.name}</option>)}</select>
            <input className="input" type="number" min="0" style={{ maxWidth: 110 }} value={qty} onChange={e => setQty(e.target.value)} aria-label="Remaining on hand" /><span className="small muted">left on hand</span></div>
          <div className="row" style={{ marginTop: 8 }}><input className="input" type="number" min="0" max="10080" style={{ maxWidth: 110 }} value={supplyMin} onChange={e => setSupplyMin(e.target.value)} aria-label="Supplier delay minutes" /><span className="small muted">min until the supplier can deliver again (0 = normal replenishment)</span></div>
          <Busy busy={busy === 'MATERIAL_SHORTAGE' + mat} className="btn" style={{ marginTop: 8 }} onClick={() => run('MATERIAL_SHORTAGE', { materialId: mat, setOnHandQty: Number(qty), supplyDelayMin: Number(supplyMin), reason: 'SUPPLIER_SHORT_DELIVERY' }, Number(supplyMin) > 0 ? `Shortage recorded - operations needing it block; supply resumes in ${supplyMin} min` : 'Shortage recorded - operations needing it block; replenishment follows')}>Create shortage</Busy>
        </Card>
        <Card title="Equipment interruption" icon="wrench">
          <div className="row"><select className="select" style={{ maxWidth: 220 }} value={eq} onChange={e => setEq(e.target.value)}>{r.equipment.map(x => <option key={x.id} value={x.id}>{x.id} · {x.workstationId}</option>)}</select>
            <input className="input" type="number" min="5" style={{ maxWidth: 110 }} value={eqMin} onChange={e => setEqMin(e.target.value)} aria-label="Recovery minutes" /><span className="small muted">min to recover</span></div>
          <Busy busy={busy === 'EQUIPMENT_BREAKDOWN' + eq} className="btn" style={{ marginTop: 8 }} onClick={() => run('EQUIPMENT_BREAKDOWN', { equipmentId: eq, estimatedRecoveryMin: Number(eqMin), reasonCode: 'RANDOM_FAILURE' }, 'Breakdown recorded - affected crews wait with an external reason')}>Break down</Busy>
        </Card>
        <Card title="Physical defect on a tank (repairable or scrap)" icon="quality">
          <UnitPicker sid={sid} value={unit} onChange={setUnit} />
          <div className="row" style={{ marginTop: 8 }}>
            <select className="select" style={{ maxWidth: 160 }} value={gate} onChange={e => setGate(e.target.value)}><option value="">next gate</option>{['QG10', 'QG20', 'QG30', 'QG40'].map(g => <option key={g}>{g}</option>)}</select>
            <div className="seg"><button aria-pressed={sev === 'REPAIRABLE'} onClick={() => setSev('REPAIRABLE')}>Repairable</button><button aria-pressed={sev === 'NON_REPAIRABLE'} onClick={() => setSev('NON_REPAIRABLE')}>Non-repairable (scrap)</button></div>
          </div>
          <div><Busy busy={busy === 'SEED_DEFECT' + unit} className="btn" style={{ marginTop: 8 }} disabled={!unit} onClick={() => run('SEED_DEFECT', { unitId: unit, gateOperationId: gate || undefined, severity: sev, failCount: 1 }, 'Defect seeded - the next inspection must detect it (no result is pre-set)')}>Seed defect</Busy></div>
          <span className="hint">The inspector records out-of-limit readings; the hold, disposition, return to the origin station, rework attempt and reinspection follow through normal transitions.</span>
        </Card>
        <Card title="Late evidence (entry lag)" icon="clock">
          <div className="row"><input className="input" type="number" min="1" style={{ maxWidth: 110 }} value={lag} onChange={e => setLag(e.target.value)} aria-label="Minutes" /><span className="small muted">minutes between decision and entry</span></div>
          <Busy busy={busy === 'SET_ENTRY_LAG'} className="btn" style={{ marginTop: 8 }} onClick={() => run('SET_ENTRY_LAG', { minutes: Number(lag) }, 'The next simulated inspection result will be entered late (KNOWN_AT after EVENT_TIME)')}>Delay next entry</Busy>
        </Card>
        <Card title="Reset" icon="refresh">
          <span className="small">Resetting the selected session to its checkpoint is under Simulation (requires typed confirmation and affects this session only).</span>
        </Card>
      </div>
    </div>
  );
}

function UnitPicker({ sid, value, onChange }) {
  const { data } = usePoll(sid ? `/sessions/${sid}/orders` : null, { interval: 30000 });
  const [lineId, setLineId] = useState('');
  const line = usePoll(sid && lineId ? `/sessions/${sid}/orders/${lineId}` : null, { interval: 30000 });
  const tanks = line.data ? [...line.data.batches.flatMap(b => b.tanks), ...line.data.extraTanks].filter(t => !['ROUTE_COMPLETE', 'SCRAPPED', 'RELEASED_BEFORE_WINDOW'].includes(t.state)) : [];
  return (
    <div className="row">
      <select className="select" style={{ maxWidth: 220 }} value={lineId} onChange={e => { setLineId(e.target.value); onChange(''); }}><option value="">Order line…</option>{((data || {}).lines || []).filter(l => l.wip > 0).map(l => <option key={l.orderLineId} value={l.orderLineId}>{l.orderLineId} ({l.wip} WIP)</option>)}</select>
      <select className="select" style={{ maxWidth: 260 }} value={value} onChange={e => onChange(e.target.value)} disabled={!lineId}><option value="">Tank…</option>{tanks.map(t => <option key={t.unitId} value={t.unitId}>{t.serial || t.unitId} · {human(t.state)} {t.routeStep || ''}</option>)}</select>
    </div>
  );
}

/* ------------------------------------------------------------------ rules */
function Rules({ canEdit }) {
  const toast = useToast();
  const { data, error, loading, reload } = usePoll('/admin/rules', { interval: 60000 });
  const [editing, setEditing] = useState(null);
  const [note, setNote] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  if (!data && loading) return <Loading lines={8} />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  const a = data.active;
  const rules = a.RULES.rules;
  const save = async (updated) => {
    try {
      const r = await api.put('/admin/rules', { rules: rules.map(x => (x.rule_id === updated.rule_id ? updated : x)), note: note || `Edited ${updated.rule_id}`, ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom).toISOString() } : {}) });
      toast(new Date(r.effectiveFrom) > new Date() ? `Rule version v${r.version} scheduled from ${new Date(r.effectiveFrom).toLocaleString()} (current version stays in force until then)` : `Rule version v${r.version} active (previous kept)`, 'ok');
      setEditing(null); setNote(''); setEffectiveFrom(''); reload(); return true;
    } catch (e) { toast(e.message, 'bad', 8000); return null; }
  };
  return (
    <div className="stack">
      <Banner tone="warn">Provisional demo values - not Siemens-approved. Every edit creates a new effective-dated version; the engine evaluates the active version and records it on every alert.</Banner>
      <Card title={`Active version v${a.VERSION_NO}`} icon="settings" actions={<span className="small muted">effective {String(a.EFFECTIVE_FROM).slice(0, 10)} · by {a.CREATED_BY} {a.NOTE ? `· ${a.NOTE}` : ''}</span>}>
        <div className="small muted" style={{ marginBottom: 8 }}>Cutoff: buffer {a.RULES.cutoff.safety_buffer_minutes} min · deadline basis {a.RULES.cutoff.deadline_basis}</div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Rule</th><th>Formula</th><th>Threshold</th><th>Samples</th><th>Persist / recover</th><th>Cooldown</th><th>Notify</th><th>Enabled</th><th /></tr></thead>
          <tbody>{rules.map(x => <tr key={x.rule_id}><td><b>{x.rule_id}</b><div className="small">{x.name}</div><div className="small muted">{x.legacy}</div></td><td className="small" style={{ maxWidth: 300 }}>{x.formula}</td>
            <td className="small mono">{JSON.stringify(x.threshold || x.classification || {})}</td><td className="small mono">{JSON.stringify(x.min_samples || {})}</td><td className="num">{x.persistence ?? '—'} / {x.recovery ?? '—'}</td><td className="num">{x.cooldown_min ?? '—'}</td>
            <td>{x.notify ? 'yes' : 'no'}</td><td>{x.enabled === false ? <Status value="CANCELLED" label="off" /> : <Status value="OK" label="on" />}</td>
            <td>{canEdit && <button className="btn sm" onClick={() => setEditing(x)}>Edit</button>}</td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card title="Version history" icon="clock">{data.versions.map(v => <div key={v.version} className="row between small"><span>v{v.version} · {v.createdBy} · {v.note || ''}</span><span><Status value={v.status} /> {String(v.effectiveFrom).slice(0, 16)}</span></div>)}</Card>
      {editing && <RuleEditor rule={editing} note={note} setNote={setNote} effectiveFrom={effectiveFrom} setEffectiveFrom={setEffectiveFrom} onClose={() => setEditing(null)} onSave={save} />}
      <PointsPolicy canEdit={canEdit} />
      <ReworkStandards canEdit={canEdit} />
    </div>
  );
}

const ADJ_LABEL = {
  withdraw_positive_time_on_confirmed_workmanship_defect: 'Withdraw positive speed points from an attempt when a reviewer confirms a workmanship defect on it',
  waive_negative_time_on_confirmed_equipment_cause: 'Do not charge an attempt\'s overrun when a reviewer confirms an equipment cause',
};

/** points policy: the client formula is the default; the two attempt adjustments need a confirmed, versioned decision */
function PointsPolicy({ canEdit }) {
  const toast = useToast();
  const { data, error, loading, reload } = usePoll('/admin/points-policy', { interval: 60000 });
  const [form, setForm] = useState(null);
  const [key, setKey] = useState(() => newKey('points-policy'));
  if (!data && loading) return <Loading lines={4} />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  const eff = data.effective;
  const adj = (eff.policy && eff.policy.attempt_adjustments) || {};
  const save = async () => {
    try {
      const r = await api.post('/admin/points-policy', { attemptAdjustments: form.adj, confirmationStatement: form.statement, ...(form.effectiveFrom ? { effectiveFrom: new Date(form.effectiveFrom).toISOString() } : {}) }, { idempotencyKey: key });
      toast(`Points policy ${r.key} confirmed - sessions re-evaluate on their next pass`, 'ok'); setForm(null); setKey(newKey('points-policy')); reload();
    } catch (e) { if (e.status >= 400 && e.status < 500) setKey(newKey('points-policy')); toast(e.message, 'bad', 8000); }
  };
  return (
    <Card title="Points policy" icon="check" actions={canEdit && <button className="btn sm" onClick={() => setForm({ adj: { ...Object.fromEntries(data.adjustments.map(k => [k, !!adj[k]])) }, statement: '', effectiveFrom: '' })}>Confirm a new version</button>}>
      <KV items={[['In force', eff.source === 'SHIPPED_DEFAULT' ? `${eff.key} - shipped default (client formula), not yet confirmed by a business owner` : `${eff.key} - confirmed by ${eff.confirmedBy}`],
        ...(eff.statement ? [['Confirmation', eff.statement]] : [])]} />
      <div className="stack tight" style={{ marginTop: 8 }}>{data.adjustments.map(k => <div key={k} className="row between small"><span>{ADJ_LABEL[k] || k}</span>{adj[k] ? <Status value="OK" label="on" /> : <Status value="CANCELLED" label="off" />}</div>)}</div>
      {data.versions.length > 0 && <div className="small muted" style={{ marginTop: 8 }}>{data.versions.map(v => <div key={v.version}>P{v.version} · {v.status} · {v.confirmedBy} · {String(v.effectiveFrom).slice(0, 16)}</div>)}</div>}
      {form && <Modal title="Confirm a points-policy version" onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn primary" disabled={form.statement.trim().length < 20} onClick={save}>Confirm version</button></>}>
        <Banner tone="warn">These adjustments go beyond the client's time-points formula. Switch one on only when the business owner has agreed it; your name and statement are stored with the version and audited.</Banner>
        {data.adjustments.map(k => <label key={k} className="check"><input type="checkbox" checked={!!form.adj[k]} onChange={e => setForm({ ...form, adj: { ...form.adj, [k]: e.target.checked } })} /> {ADJ_LABEL[k] || k}</label>)}
        <Field label="Confirmation statement * (who agreed it, where it is recorded - at least 20 characters)"><textarea className="input" rows={3} value={form.statement} onChange={e => setForm({ ...form, statement: e.target.value })} /></Field>
        <Field label="Effective from (empty = now)"><input className="input" type="datetime-local" value={form.effectiveFrom} onChange={e => setForm({ ...form, effectiveFrom: e.target.value })} /></Field>
      </Modal>}
    </Card>
  );
}

/** rework labour standards: only APPROVED standards (named approver, version, effective date) earn rework time points */
function ReworkStandards({ canEdit }) {
  const toast = useToast();
  const { data, error, loading, reload } = usePoll('/admin/master/rework-standards', { interval: 60000 });
  const [form, setForm] = useState(null);
  const [key, setKey] = useState(() => newKey('rework-std'));
  if (!data && loading) return <Loading lines={4} />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  const save = async () => {
    try {
      const body = { operationId: form.operationId, productId: form.productId || '*', reworkType: form.reworkType, laborMin: Number(form.laborMin), approvalStatement: form.approvalStatement, ...(form.effectiveFrom ? { effectiveFrom: new Date(form.effectiveFrom).toISOString() } : {}) };
      const r = await api.post('/admin/master/rework-standards', body, { idempotencyKey: key });
      toast(`Approved ${r.standard.STANDARD_ID}`, 'ok'); setForm(null); setKey(newKey('rework-std')); reload();
    } catch (e) { if (e.status >= 400 && e.status < 500) setKey(newKey('rework-std')); toast(e.message, 'bad', 10000); }
  };
  return (
    <Card title="Rework labour standards" icon="wrench" actions={canEdit && <button className="btn sm" onClick={() => setForm({ operationId: '', productId: '', reworkType: '*', laborMin: '', approvalStatement: '', effectiveFrom: '' })}>Approve a standard</button>}>
      <div className="small muted" style={{ marginBottom: 8 }}>Without an approved standard a rework attempt uses the {data.planningDefaultMin}-min planning value for forecasts only and earns no time points (shown as pending).</div>
      {data.standards.length === 0 ? <Empty icon="wrench">No approved rework standards yet.</Empty> :
        <div className="table-wrap"><table className="table"><thead><tr><th>Standard</th><th>Operation</th><th>Product</th><th>Rework type</th><th className="num">Labour min</th><th>Status</th><th>Approved by</th><th>Effective</th></tr></thead>
          <tbody>{data.standards.map(x => <tr key={x.STANDARD_ID}><td className="mono small">{x.STANDARD_ID}</td><td>{x.OPERATION_ID}</td><td>{x.PRODUCT_ID}</td><td>{x.REWORK_TYPE}</td><td className="num">{x.LABOR_MIN}</td><td><Status value={x.STATUS} /></td><td className="small">{x.APPROVED_BY}<div className="muted">{x.APPROVAL_STATEMENT}</div></td><td className="small">{String(x.EFFECTIVE_FROM).slice(0, 10)}</td></tr>)}</tbody></table></div>}
      {form && <Modal title="Approve a rework standard" onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn primary" onClick={save}>Approve</button></>}>
        <Field label="Operation ID * (labour operation, e.g. OP10)"><input className="input mono" value={form.operationId} onChange={e => setForm({ ...form, operationId: e.target.value.toUpperCase() })} /></Field>
        <Field label="Product ID (empty = any product)"><input className="input mono" value={form.productId} onChange={e => setForm({ ...form, productId: e.target.value.toUpperCase() })} /></Field>
        <Field label="Rework type"><select className="select" value={form.reworkType} onChange={e => setForm({ ...form, reworkType: e.target.value })}>{data.reworkTypes.map(t => <option key={t} value={t}>{t === '*' ? 'Any' : human(t)}</option>)}</select></Field>
        <Field label="Labour minutes *"><input className="input" inputMode="decimal" value={form.laborMin} onChange={e => setForm({ ...form, laborMin: e.target.value })} /></Field>
        <Field label="Approval statement * (who measured or agreed it, on what basis)"><textarea className="input" rows={3} value={form.approvalStatement} onChange={e => setForm({ ...form, approvalStatement: e.target.value })} /></Field>
        <Field label="Effective from (empty = 1 Sep 2026, covers the whole dataset)"><input className="input" type="datetime-local" value={form.effectiveFrom} onChange={e => setForm({ ...form, effectiveFrom: e.target.value })} /></Field>
      </Modal>}
    </Card>
  );
}

function RuleEditor({ rule, onClose, onSave, note, setNote, effectiveFrom, setEffectiveFrom }) {
  const [txt, setTxt] = useState(JSON.stringify({ threshold: rule.threshold, min_samples: rule.min_samples, window_min: rule.window_min, persistence: rule.persistence, recovery: rule.recovery, cooldown_min: rule.cooldown_min, warmup_min: rule.warmup_min, notify: rule.notify, enabled: rule.enabled !== false }, null, 2));
  const [err, setErr] = useState(null);
  return (
    <Modal wide title={`Edit ${rule.rule_id} · ${rule.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => {
      try { const v = JSON.parse(txt); setErr(null); onSave({ ...rule, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) }); } catch (e) { setErr('Not valid JSON: ' + e.message); }
    }}>Save as new version</button></>}>
      <div className="small">{rule.formula}</div>
      <textarea className="textarea mono" style={{ minHeight: 260 }} value={txt} onChange={e => setTxt(e.target.value)} aria-label="Rule settings JSON" />
      {err && <Banner tone="bad">{err}</Banner>}
      <div className="field"><label>Change note</label><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="why this changed" /></div>
      <div className="field"><label>Effective from (optional - empty = immediately; application time, applies to every session)</label><input className="input" type="datetime-local" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ jobs, engine, integrations */
function System() {
  const toast = useToast();
  const jobs = usePoll('/admin/jobs', { interval: 6000 });
  const integ = usePoll('/admin/integrations', { interval: 15000 });
  const ready = usePoll('/ready', { interval: 30000 });
  return (
    <div className="stack">
      <div className="grid three">
        <Card title="Engine worker" icon="bolt">{integ.data ? <KV items={[['Status', <Status key="s" value={integ.data.engine.status} />], ['Last heartbeat', integ.data.engine.lastHeartbeatAt ? `${Math.round(integ.data.engine.ageSec)} s ago` : 'never']]} /> : <Loading lines={2} />}
          <span className="hint">The always-on worker advances running sessions, evaluates time-based rules and consumes jobs even with no browser open.</span></Card>
        <Card title="Integrations" icon="settings">{integ.data ? <KV items={[['Database', integ.data.database], ['Email', `${integ.data.email.mode}${integ.data.email.host ? ` via ${integ.data.email.host}` : ''} · ${integ.data.email.allowlistCount} allowlisted`], ['Evidence', `${integ.data.evidence.mode}${integ.data.evidence.cloudinaryConfigured ? ' · Cloudinary configured' : ''}`], ['Demo mode', String(integ.data.demoMode)]]} /> : <Loading lines={3} />}</Card>
        <Card title="API readiness" icon="check">{ready.data ? <KV items={[['Ready', <Status key="r" value={ready.data.ready ? 'OK' : 'FAIL'} />], ['Database', ready.data.database], ['Problems', (ready.data.problems || []).join('; ') || 'none']]} /> : ready.error ? <Banner tone="bad">{ready.error.message}</Banner> : <Loading lines={2} />}</Card>
      </div>
      <Card title="Durable jobs" icon="queue" actions={jobs.data ? <span className="small">{Object.entries(jobs.data.counts).map(([k, v]) => `${human(k)} ${v}`).join(' · ')}</span> : null}>
        {!jobs.data ? <Loading /> : <div className="table-wrap"><table className="table">
          <thead><tr><th>Job</th><th>Type</th><th>Session</th><th>Status</th><th className="num">Attempts</th><th>Updated</th><th>Error / result</th><th /></tr></thead>
          <tbody>{jobs.data.jobs.map(j => <tr key={j.JOB_ID}><td className="mono small">{j.JOB_ID}</td><td>{human(j.TYPE)}</td><td className="mono small">{j.SESSION_ID}</td><td><Status value={j.STATUS} /></td><td className="num">{j.ATTEMPTS}</td><td className="small">{plantTime(j.UPDATED_AT, 'UTC')} UTC</td>
            <td className="small" style={{ maxWidth: 360 }}>{j.ERROR || (j.RESULT ? JSON.stringify(j.RESULT).slice(0, 160) : '')}</td>
            <td>{['DEAD', 'FAILED'].includes(j.STATUS) && <button className="btn sm" onClick={async () => { try { await api.post(`/admin/jobs/${j.JOB_ID}/retry`, {}); toast('Requeued', 'ok'); jobs.reload(); } catch (e) { toast(e.message, 'bad'); } }}>Retry</button>}</td></tr>)}</tbody>
        </table></div>}
        <span className="hint">Jobs are claimed atomically with a lease, heartbeat and fencing token; failures retry with exponential backoff and end in the dead-letter state for inspection.</span>
      </Card>
    </div>
  );
}

function Notifications() {
  const { data, error, loading, reload } = usePoll('/admin/notifications', { interval: 10000 });
  const [open, setOpen] = useState(null);
  if (!data && loading) return <Loading lines={6} />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <Banner tone="info">Email mode: <b>{data.mode}</b>. {data.note}</Banner>
      {data.notifications.length === 0 ? <Card><Empty icon="bell">No notification yet.</Empty></Card> : <div className="table-wrap"><table className="table">
        <thead><tr><th>Created</th><th>Subject</th><th>Status</th><th className="num">Attempts</th><th>Provider message ID / reason</th><th /></tr></thead>
        <tbody>{data.notifications.map(n => <tr key={n.NOTIFICATION_ID}><td className="small">{plantTime(n.CREATED_AT, 'UTC')} UTC</td><td className="small">{n.SUBJECT}</td><td><Status value={n.STATUS} /></td><td className="num">{n.ATTEMPTS}</td><td className="small">{n.SUPPRESSED_REASON || n.LAST_ERROR || n.PROVIDER_MESSAGE_ID || ''}</td><td><button className="btn sm" onClick={() => setOpen(n)}>View</button></td></tr>)}</tbody>
      </table></div>}
      {open && <Modal wide title={open.SUBJECT} onClose={() => setOpen(null)}>
        <KV items={[['Dedup key', <span className="mono small" key="d">{open.DEDUP_KEY}</span>], ['Message-ID', <span className="mono small" key="m">{open.MESSAGE_ID}</span>], ['Status', human(open.STATUS)], ['Recipients', open.CAPTURED ? (open.CAPTURED.to || []).join(', ') : open.RECIPIENTS]]} />
        <pre className="card flat small" style={{ whiteSpace: 'pre-wrap' }}>{open.BODY}</pre>
      </Modal>}
    </div>
  );
}

function ImportStatus() {
  const { data, error, loading, reload } = usePoll('/admin/import-status', { interval: 60000 });
  if (!data && loading) return <Loading lines={6} />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <Banner tone="info">{data.note}</Banner>
      <Card title="Seeded dataset" icon="box">{data.manifests.length === 0 ? <Empty>No import manifest - run the seed commands (backend/seed/README_SEED.md).</Empty> : data.manifests.map(m => <KV key={m.manifestSha256} items={[['Dataset version', m.datasetVersion], ['Manifest SHA-256', <span className="mono small" key="h">{m.manifestSha256}</span>], ['First seeded', String(m.firstSeededAt).slice(0, 19)], ['Collections / documents', `${m.collections} / ${m.documents}`], ['Source workbooks', (m.sourceWorkbooks || []).join(', ')]]} />)}</Card>
      <Card title="Seed runs" icon="clock">{data.seedRuns.length === 0 ? <Empty>None.</Empty> : data.seedRuns.map(r => <div key={r.seed_run_id} className="row between small"><span className="mono">{r.seed_run_id}</span><span>inserted {r.inserted_total} · already present {r.already_present_total} · drift {(r.drift || []).length}</span></div>)}</Card>
      <Card title="Reconciliation" icon="verify">{data.reconciliation.length === 0 ? <Empty>No reconciliation report stored. Run seed/reconcile_mongo.py.</Empty> : data.reconciliation.map((x, k) => <div key={k} className="row between small"><span>{String(x.checkedAt).slice(0, 19)} · {x.store}</span><span><Status value={x.result === 'PASS' ? 'OK' : 'FAIL'} label={x.result} /> {x.checks} checks, {x.failing} failing</span></div>)}</Card>
      {data.quarantine.length > 0 && <Card title={`Quarantined rows (${data.quarantine.length})`}>{data.quarantine.map((q, k) => <div key={k} className="small mono">{JSON.stringify(q).slice(0, 200)}</div>)}</Card>}
    </div>
  );
}

function Audit() {
  const { data, error, loading, reload } = usePoll('/admin/audit', { interval: 20000 });
  if (!data && loading) return <Loading lines={6} />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  return data.entries.length === 0 ? <Card><Empty>No audit entries.</Empty></Card> : (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
      <tbody>{data.entries.map(a => <tr key={a.AUDIT_ID}><td className="small">{String(a.AT).slice(0, 19).replace('T', ' ')}</td><td>{a.ACTOR}</td><td>{human(a.ACTION)}</td><td className="mono small">{a.TARGET}</td><td className="small mono">{JSON.stringify(a.DETAILS).slice(0, 180)}</td></tr>)}</tbody>
    </table></div>
  );
}

function Account() {
  const toast = useToast();
  const { user, refreshUser } = useApp();
  const [v, setV] = useState({ cur: '', next: '', again: '' });
  const min = (user.roles || []).includes('ADMIN') ? 15 : 6;
  return (
    <Card title="Change password / PIN" icon="settings">
      {user.mustChangePin && <Banner tone="warn">Your initial password must be changed.</Banner>}
      <div className="grid three">
        <Field label="Current"><input type="password" className="input" value={v.cur} onChange={e => setV({ ...v, cur: e.target.value })} /></Field>
        <Field label={`New (at least ${min} characters)`}><input type="password" className="input" value={v.next} onChange={e => setV({ ...v, next: e.target.value })} /></Field>
        <Field label="Repeat new"><input type="password" className="input" value={v.again} onChange={e => setV({ ...v, again: e.target.value })} /></Field>
      </div>
      <button className="btn primary" style={{ marginTop: 10 }} disabled={v.next.length < min || v.next !== v.again} onClick={async () => { try { await api.post('/auth/change-pin', { currentPin: v.cur, newPin: v.next }); toast('Changed', 'ok'); setV({ cur: '', next: '', again: '' }); refreshUser(); } catch (e) { toast(e.message, 'bad'); } }}>Change</button>
    </Card>
  );
}
