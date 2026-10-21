import React, { useState } from 'react';
import { useApp, usePoll, useToast, useRouter, queryParam, useEnv, Link } from '../lib/hooks.jsx';
import { api, newKey, command } from '../lib/api.js';
import { human } from '../lib/fmt.js';
import { Banner, Busy, Card, ErrorState, Icon, KV, Loading, Modal, Status, Empty } from '../components/ui.jsx';
import { printLabel } from '../components/Barcode.jsx';

/*
 * Fresh Factory setup: the first-run checklist and the configuration forms (factory, work centres and stations, skills, shifts,
 * equipment and materials with explicit stock, products and routes, inspection checklists), the optional illustrative template
 * and the guarded reset. Every save is one audited transaction on the server; nothing here invents values.
 */
const TABS = [['checklist', 'Checklist'], ['factory', '1 · Factory'], ['work-centres', '2 · Work centres'], ['products', '3 · Products & routes'], ['checklists', '4 · Inspection checklists'],
  ['skills', '5 · Skills'], ['shifts', '6 · Shifts'], ['resources', '7 · Equipment & materials'], ['template', 'Template import'], ['reset', 'Reset']];
const STEP_TAB = { factory: 'factory', workCenters: 'work-centres', products: 'products', checklists: 'checklists', skills: 'skills', shifts: 'shifts', resources: 'resources' };
const STATUS_TONE = { READY: 'ok', PARTIAL: 'warn', NOT_CONFIGURED: 'info' };
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const TZS = ['America/Bogota', 'America/Mexico_City', 'America/New_York', 'America/Sao_Paulo', 'Europe/Berlin', 'Europe/London', 'Europe/Madrid', 'Asia/Kolkata', 'Asia/Shanghai', 'UTC'];

function Field({ label, children, hint }) { return <div className="field"><label>{label}</label>{children}{hint && <span className="hint">{hint}</span>}</div>; }
const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

/** PUT/POST with toast + one idempotency key per attempt (a 4xx refusal means nothing was written) */
function useSave() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (method, path, body, okMsg) => {
    setBusy(true);
    try {
      const r = await api[method](path, body, { idempotencyKey: newKey('setup') });
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
      return r;
    } catch (e) {
      const probs = e.details && (e.details.problems || e.details.errors);
      toast(probs && probs.length ? `${e.message}: ${probs.slice(0, 4).join(' · ')}` : e.message, 'bad', 9000);
      return null;
    } finally { setBusy(false); }
  };
  return { save, busy };
}

/* ------------------------------------------------------------------ checklist (also shown on the overview until complete) */
export function SetupGuide({ compact }) {
  const { navigate } = useRouter();
  const { data, error } = usePoll('/factory/setup', { interval: 20000 });
  if (!data) return compact ? null : (error ? <ErrorState error={error} /> : <Loading lines={6} />);
  const done = data.steps.filter(s => s.status === 'READY').length;
  if (compact && data.readyToStart && data.steps.every(s => s.status === 'READY')) return null;
  return (
    <div className={compact ? 'page' : ''} style={compact ? { paddingBottom: 0 } : undefined}>
      <Card title={`First-run setup · ${done} of ${data.steps.length} ready`} icon="settings" actions={<span className="row" style={{ gap: 6 }}>
        <Status value={data.configurationSaved ? 'READY' : 'PENDING'} label={data.configurationSaved ? 'Configuration saved' : 'Configuration incomplete'} />
        <Status value={data.readyToRelease ? 'READY' : 'PENDING'} label={data.readyToRelease ? 'Ready to release' : 'Not ready to release'} />
        <Status value={data.readyToStart ? 'READY' : 'PENDING'} label={data.readyToStart ? 'Ready to start work' : 'Not ready to start'} />
      </span>}>
        {data.illustrativeConfiguration && <Banner tone="warn">Part of the configuration comes from the <b>illustrative template</b>: its standards, crews, checklists and limits are synthetic assumptions - not Siemens values, not confirmed. Review them before relying on results.</Banner>}
        <div className="stack tight">
          {data.steps.map(s => (
            <div key={s.key} className="row between" style={{ borderBottom: '1px solid var(--line)', padding: '6px 0', alignItems: 'flex-start' }}>
              <div className="stack tight" style={{ flex: 1, minWidth: 220 }}>
                <b>{s.n}. {s.title}</b>
                {s.missing.length > 0 && <span className="small" style={{ color: 'var(--warn)' }}>Missing: {s.missing.slice(0, 4).join(' · ')}{s.missing.length > 4 ? ` · +${s.missing.length - 4} more` : ''}</span>}
                {s.validation.length > 0 && <span className="small muted">{s.validation.slice(0, 3).join(' · ')}</span>}
              </div>
              <div className="row nowrap"><span className={`badge ${STATUS_TONE[s.status]}`}>{human(s.status)}</span>
                <button className="btn sm" onClick={() => navigate(STEP_TAB[s.key] ? `/setup?tab=${STEP_TAB[s.key]}` : s.link)}>{s.status === 'READY' ? 'Review' : 'Open'}<Icon name="chevron" size={14} /></button></div>
            </div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>{data.note}</p>
      </Card>
    </div>
  );
}

export default function Setup() {
  const { path, navigate } = useRouter();
  const tab = queryParam(path, 'tab') || 'checklist';
  const { user } = useApp();
  const can = (user.permissions || []).includes('factory_configuration');
  const master = usePoll(tab === 'checklist' ? null : '/factory/master', { interval: 30000, deps: [tab] });
  return (
    <div className="page">
      <h1>Factory setup</h1>
      {!can && <Banner tone="warn">You can view the setup; only administrators with “factory configuration” change it.</Banner>}
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => navigate(`/setup?tab=${k}`)}>{l}</button>)}</div>
      {tab === 'checklist' && <SetupGuide />}
      {tab !== 'checklist' && !master.data && (master.error ? <ErrorState error={master.error} onRetry={master.reload} /> : <Loading lines={6} />)}
      {tab !== 'checklist' && master.data && <>
        {tab === 'factory' && <FactoryTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'work-centres' && <WorkCentresTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'skills' && <SkillsTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'shifts' && <ShiftsTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'resources' && <ResourcesTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'products' && <ProductsTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'checklists' && <ChecklistsTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'template' && <TemplateTab m={master.data} reload={master.reload} can={can} />}
        {tab === 'reset' && <ResetTab />}
      </>}
    </div>
  );
}

/* ------------------------------------------------------------------ 1 factory */
function FactoryTab({ m, reload, can }) {
  const s = m.settings || {};
  const [f, setF] = useState({ factoryName: s.FACTORY_NAME || '', siteId: s.SITE_ID || '', timezone: s.TIMEZONE || '', operatingMode: s.OPERATING_MODE || 'MANUAL_TEAM_TEST', workingDays: s.WORKING_DAYS || [1, 2, 3, 4, 5], serialPrefix: s.SERIAL_PREFIX || 'TANK', calendarNote: s.CALENDAR_NOTE || '' , scanRequiredStartWork: !!(s.SCAN_REQUIRED || {}).START_WORK, scanRequiredInspection: !!(s.SCAN_REQUIRED || {}).INSPECTION });
  const { save, busy } = useSave();
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Factory, site and timezone" icon="factory">
      <div className="grid three">
        <Field label="Factory name *"><input className="input" value={f.factoryName} onChange={set('factoryName')} /></Field>
        <Field label="Site ID *" hint="Stable ID, capital letters/digits/-"><input className="input mono" value={f.siteId} onChange={e => setF({ ...f, siteId: e.target.value.toUpperCase() })} /></Field>
        <Field label="Plant timezone *" hint="All shift times, due dates and the operational date use this zone"><input className="input" list="tz-list" value={f.timezone} onChange={set('timezone')} placeholder="e.g. Europe/Berlin" /><datalist id="tz-list">{TZS.map(t => <option key={t} value={t} />)}</datalist></Field>
        <Field label="Operating mode" hint="Manual Team Test = real people, real time, no agent completes anyone's work"><select className="select" value={f.operatingMode} onChange={set('operatingMode')}><option value="MANUAL_TEAM_TEST">Manual team test (real time)</option><option value="SIMULATED_TEST">Simulated test (designated simulated workers only)</option></select></Field>
        <Field label="Tank serial prefix" hint="Serial = PREFIX-YY-00001"><input className="input mono" value={f.serialPrefix} onChange={e => setF({ ...f, serialPrefix: e.target.value.toUpperCase() })} /></Field>
        <Field label="Operational calendar note"><input className="input" value={f.calendarNote} onChange={set('calendarNote')} placeholder="e.g. plant holidays, maintenance days" /></Field>
      </div>
      <div className="field"><label>Working days (default for new shifts)</label><div className="row">{DAYS.map(([d, l]) => <label key={d} className="check"><input type="checkbox" checked={f.workingDays.includes(d)} onChange={e => setF({ ...f, workingDays: e.target.checked ? [...f.workingDays, d].sort() : f.workingDays.filter(x => x !== d) })} />{l}</label>)}</div></div>
      <div className="field"><label>Tank label scanning (the label is the tank serial; every scan is saved in the tank history)</label>
        <div className="row"><label className="check"><input type="checkbox" checked={f.scanRequiredStartWork} onChange={e => setF({ ...f, scanRequiredStartWork: e.target.checked })} /> Require a scan of the tank before people start work</label>
          <label className="check"><input type="checkbox" checked={f.scanRequiredInspection} onChange={e => setF({ ...f, scanRequiredInspection: e.target.checked })} /> Require a scan of the tank before an inspection starts</label></div>
        <span className="hint">Off = scanning is optional (Confirm tank / Scan buttons). On = the Start work / Inspect buttons ask for the scan first; a handheld scanner, the camera or typing the serial all count.</span></div>
      {s.CALENDAR_GENERATED_TO && <p className="hint">Shift calendar generated up to {s.CALENDAR_GENERATED_TO} (extended automatically).</p>}
      {can && <div className="btn-row" style={{ marginTop: 10 }}><Busy busy={busy} className="btn primary" disabled={!f.factoryName || !f.siteId || !f.timezone} onClick={async () => { if (await save('put', '/factory/settings', f, 'Factory settings saved (audited)')) reload(); }}>Save factory settings</Busy></div>}
    </Card>
  );
}

/* ------------------------------------------------------------------ 2 work centres and stations */
function WorkCentresTab({ m, reload, can }) {
  const { save, busy } = useSave();
  const blankWc = { id: '', name: '', type: 'PRODUCTION', areaId: '', queueCapacity: '', capacity: '', sequence: '', applicableOperations: '', active: true };
  const blankSt = { id: '', name: '', workCenterId: (m.workCenters[0] || {}).WORK_CENTER_ID || '', type: 'WORKSTATION', capacity: 1, equipmentId: '', applicableOperations: '', active: true };
  const [wc, setWc] = useState(blankWc);
  const [st, setSt] = useState(blankSt);
  const editWc = w => setWc({ id: w.WORK_CENTER_ID, name: w.WORK_CENTER_NAME, type: w.WORK_CENTER_TYPE || 'PRODUCTION', areaId: w.AREA_ID || '', queueCapacity: w.QUEUE_CAPACITY_UNITS ?? '', capacity: w.UNIT_CAPACITY ?? '', sequence: w.ROUTE_SEQUENCE ?? '', applicableOperations: (w.APPLICABLE_OPERATIONS || []).join(', '), active: w.ACTIVE_FLAG !== 'N' });
  const editSt = s => setSt({ id: s.WORKSTATION_ID, name: s.WORKSTATION_NAME, workCenterId: s.WORK_CENTER_ID, type: s.WORKSTATION_TYPE || 'WORKSTATION', capacity: s.UNIT_CAPACITY || 1, equipmentId: s.EQUIPMENT_ID || '', applicableOperations: (s.APPLICABLE_OPERATIONS || []).join(', '), active: s.ACTIVE_FLAG !== 'N' });
  return (
    <div className="stack">
      <Card title="Work centres" icon="factory">
        {m.workCenters.length === 0 ? <Empty icon="factory">No work centre yet. Add the first one below.</Empty> : <div className="table-wrap"><table className="table">
          <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Area</th><th className="num">Queue cap.</th><th className="num">Capacity</th><th>Stations</th><th>Status</th><th /></tr></thead>
          <tbody>{m.workCenters.map(w => <tr key={w.WORK_CENTER_ID}><td className="mono">{w.WORK_CENTER_ID}</td><td>{w.WORK_CENTER_NAME}{w.ILLUSTRATIVE && <span className="badge warn" style={{ marginLeft: 6 }}>illustrative</span>}</td><td className="small">{human(w.WORK_CENTER_TYPE)}</td><td className="small">{w.AREA_ID || '—'}</td><td className="num">{w.QUEUE_CAPACITY_UNITS ?? '—'}</td><td className="num">{w.UNIT_CAPACITY ?? '—'}</td>
            <td className="small">{m.stations.filter(s => s.WORK_CENTER_ID === w.WORK_CENTER_ID).map(s => s.WORKSTATION_ID).join(', ') || <span style={{ color: 'var(--warn)' }}>none</span>}</td><td><Status value={w.ACTIVE_FLAG === 'N' ? 'CLOSED' : 'ACTIVE'} label={w.ACTIVE_FLAG === 'N' ? 'Inactive' : 'Active'} /></td>
            <td>{can && <button className="btn sm" onClick={() => editWc(w)}>Edit</button>}</td></tr>)}</tbody></table></div>}
        {can && <div className="card flat" style={{ marginTop: 10 }}>
          <b>{m.workCenters.some(w => w.WORK_CENTER_ID === wc.id) ? `Edit ${wc.id}` : 'Add a work centre'}</b>
          <div className="grid four">
            <Field label="ID *"><input className="input mono" value={wc.id} onChange={e => setWc({ ...wc, id: e.target.value.toUpperCase() })} placeholder="FAB" /></Field>
            <Field label="Name *"><input className="input" value={wc.name} onChange={e => setWc({ ...wc, name: e.target.value })} /></Field>
            <Field label="Type"><input className="input" value={wc.type} onChange={e => setWc({ ...wc, type: e.target.value.toUpperCase() })} /></Field>
            <Field label="Area" hint="Areas group work centres for balance rules"><input className="input mono" value={wc.areaId} onChange={e => setWc({ ...wc, areaId: e.target.value.toUpperCase() })} /></Field>
            <Field label="Queue capacity (tanks)"><input className="input" type="number" min="1" value={wc.queueCapacity} onChange={e => setWc({ ...wc, queueCapacity: e.target.value })} placeholder="no limit" /></Field>
            <Field label="Capacity (tanks worked at once)"><input className="input" type="number" min="1" value={wc.capacity} onChange={e => setWc({ ...wc, capacity: e.target.value })} /></Field>
            <Field label="Route order"><input className="input" type="number" value={wc.sequence} onChange={e => setWc({ ...wc, sequence: e.target.value })} /></Field>
            <Field label="Applicable operations"><input className="input mono" value={wc.applicableOperations} onChange={e => setWc({ ...wc, applicableOperations: e.target.value })} placeholder="OP10, QG10" /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={wc.active} onChange={e => setWc({ ...wc, active: e.target.checked })} /> Active</label>
          <div className="btn-row"><Busy busy={busy} className="btn primary" disabled={!wc.id || !wc.name} onClick={async () => { if (await save('put', `/factory/work-centers/${encodeURIComponent(wc.id)}`, { ...wc, applicableOperations: csv(wc.applicableOperations), active: wc.active ? 'Y' : 'N' }, `Work centre ${wc.id} saved`)) { setWc(blankWc); reload(); } }}>Save work centre</Busy><button className="btn" onClick={() => setWc(blankWc)}>Clear</button></div>
        </div>}
      </Card>
      <Card title="Stations" icon="tank">
        {m.stations.length === 0 ? <Empty icon="tank">No station yet. Every work centre needs at least one workstation (and a cure zone if a route has an unattended cure).</Empty> : <div className="table-wrap"><table className="table">
          <thead><tr><th>ID</th><th>Name</th><th>Work centre</th><th>Type</th><th className="num">Capacity</th><th>Equipment</th><th>Status</th><th /></tr></thead>
          <tbody>{m.stations.map(s => <tr key={s.WORKSTATION_ID}><td className="mono">{s.WORKSTATION_ID}</td><td>{s.WORKSTATION_NAME}</td><td>{s.WORK_CENTER_ID}</td><td className="small">{human(s.WORKSTATION_TYPE)}</td><td className="num">{s.UNIT_CAPACITY || 1}</td><td className="mono small">{s.EQUIPMENT_ID || '—'}</td><td><Status value={s.ACTIVE_FLAG === 'N' ? 'CLOSED' : 'ACTIVE'} label={s.ACTIVE_FLAG === 'N' ? 'Inactive' : 'Active'} /></td><td className="row nowrap" style={{ gap: 6 }}>{can && <button className="btn sm" onClick={() => editSt(s)}>Edit</button>}<button className="btn sm" title="Printable station label (Code 128) for the operator scanner" onClick={() => printLabel({ title: `Station ${s.WORKSTATION_ID}`, code: s.WORKSTATION_ID, lines: [s.WORKSTATION_NAME || '', `Work centre ${s.WORK_CENTER_ID}`] })}>Label</button></td></tr>)}</tbody></table></div>}
        {can && m.workCenters.length > 0 && <div className="card flat" style={{ marginTop: 10 }}>
          <b>{m.stations.some(x => x.WORKSTATION_ID === st.id) ? `Edit ${st.id}` : 'Add a station'}</b>
          <div className="grid four">
            <Field label="ID *"><input className="input mono" value={st.id} onChange={e => setSt({ ...st, id: e.target.value.toUpperCase() })} placeholder="FAB-01" /></Field>
            <Field label="Name *"><input className="input" value={st.name} onChange={e => setSt({ ...st, name: e.target.value })} /></Field>
            <Field label="Work centre *"><select className="select" value={st.workCenterId} onChange={e => setSt({ ...st, workCenterId: e.target.value })}><option value="">choose…</option>{m.workCenters.map(w => <option key={w.WORK_CENTER_ID} value={w.WORK_CENTER_ID}>{w.WORK_CENTER_ID}</option>)}</select></Field>
            <Field label="Type"><select className="select" value={st.type} onChange={e => setSt({ ...st, type: e.target.value })}>{['WORKSTATION', 'INSPECTION_BAY', 'CURE_ZONE', 'HOLD_AREA'].map(x => <option key={x} value={x}>{human(x)}</option>)}</select></Field>
            <Field label="Capacity"><input className="input" type="number" min="1" value={st.capacity} onChange={e => setSt({ ...st, capacity: e.target.value })} /></Field>
            <Field label="Equipment"><select className="select" value={st.equipmentId} onChange={e => setSt({ ...st, equipmentId: e.target.value })}><option value="">none</option>{m.equipment.map(x => <option key={x.EQUIPMENT_ID} value={x.EQUIPMENT_ID}>{x.EQUIPMENT_ID}</option>)}</select></Field>
            <Field label="Applicable operations"><input className="input mono" value={st.applicableOperations} onChange={e => setSt({ ...st, applicableOperations: e.target.value })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={st.active} onChange={e => setSt({ ...st, active: e.target.checked })} /> Active</label>
          <div className="btn-row"><Busy busy={busy} className="btn primary" disabled={!st.id || !st.name || !st.workCenterId} onClick={async () => { if (await save('put', `/factory/stations/${encodeURIComponent(st.id)}`, { ...st, applicableOperations: csv(st.applicableOperations), active: st.active ? 'Y' : 'N', equipmentId: st.equipmentId || null }, `Station ${st.id} saved`)) { setSt(blankSt); reload(); } }}>Save station</Busy><button className="btn" onClick={() => setSt(blankSt)}>Clear</button></div>
        </div>}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ 5 skills */
function SkillsTab({ m, reload, can }) {
  const { save, busy } = useSave();
  const blank = { id: '', name: '', category: 'PRODUCTION', workCenterId: '', active: true };
  const [f, setF] = useState(blank);
  const used = {};
  for (const p of m.products) for (const r of p.route) if (r.REQUIRED_SKILL_ID) (used[r.REQUIRED_SKILL_ID] = used[r.REQUIRED_SKILL_ID] || []).push(`${p.PRODUCT_ID} ${r.OPERATION_ID} (crew ${r.MIN_CREW_SIZE ?? '-'}/${r.STD_CREW_SIZE ?? '-'}/${r.MAX_CREW_SIZE ?? '-'})`);
  return (
    <Card title="Skills and crew requirements" icon="users">
      <p className="hint">A skill is what a person must be qualified for (with validity dates) to work an operation. Crew sizes (minimum / standard / maximum) are part of each route operation.</p>
      {m.skills.length === 0 ? <Empty icon="users">No skill yet.</Empty> : <div className="table-wrap"><table className="table">
        <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Work centre</th><th>Required by (crew min/std/max)</th><th /></tr></thead>
        <tbody>{m.skills.map(s => <tr key={s.SKILL_ID}><td className="mono">{s.SKILL_ID}</td><td>{s.SKILL_NAME}</td><td className="small">{human(s.SKILL_CATEGORY)}</td><td>{s.WORK_CENTER_ID || '—'}</td><td className="small">{(used[s.SKILL_ID] || []).join(' · ') || '—'}</td><td>{can && <button className="btn sm" onClick={() => setF({ id: s.SKILL_ID, name: s.SKILL_NAME, category: s.SKILL_CATEGORY || 'PRODUCTION', workCenterId: s.WORK_CENTER_ID || '', active: s.ACTIVE_FLAG !== 'N' })}>Edit</button>}</td></tr>)}</tbody></table></div>}
      {Object.keys(used).filter(k => !m.skills.some(s => s.SKILL_ID === k)).length > 0 && <Banner tone="warn">Routes require skills that are not defined: {Object.keys(used).filter(k => !m.skills.some(s => s.SKILL_ID === k)).join(', ')}</Banner>}
      {can && <div className="card flat" style={{ marginTop: 10 }}>
        <div className="grid four">
          <Field label="Skill ID *"><input className="input mono" value={f.id} onChange={e => setF({ ...f, id: e.target.value.toUpperCase() })} placeholder="SK-WELD" /></Field>
          <Field label="Name *"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Category"><select className="select" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{['PRODUCTION', 'INSPECTION', 'SUPPORT'].map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Work centre"><select className="select" value={f.workCenterId} onChange={e => setF({ ...f, workCenterId: e.target.value })}><option value="">any</option>{m.workCenters.map(w => <option key={w.WORK_CENTER_ID}>{w.WORK_CENTER_ID}</option>)}</select></Field>
        </div>
        <div className="btn-row"><Busy busy={busy} className="btn primary" disabled={!f.id || !f.name} onClick={async () => { if (await save('put', `/factory/skills/${encodeURIComponent(f.id)}`, { ...f, workCenterId: f.workCenterId || null, active: f.active ? 'Y' : 'N' }, `Skill ${f.id} saved`)) { setF(blank); reload(); } }}>Save skill</Busy><button className="btn" onClick={() => setF(blank)}>Clear</button></div>
      </div>}
    </Card>
  );
}

/* ------------------------------------------------------------------ 6 shifts */
function ShiftsTab({ m, reload, can }) {
  const { save, busy } = useSave();
  const defDays = (m.settings && m.settings.WORKING_DAYS) || [1, 2, 3, 4, 5];
  const blank = { code: '', name: '', startLocal: '06:00', endLocal: '14:30', daysOfWeek: defDays, breaks: [], effectiveFrom: '', effectiveTo: '', active: true };
  const [f, setF] = useState(blank);
  const edit = t => setF({ code: t.SHIFT_CODE, name: t.SHIFT_NAME, startLocal: t.START_LOCAL, endLocal: t.END_LOCAL, daysOfWeek: t.DAYS_OF_WEEK, breaks: (t.BREAKS || []).map(b => ({ startLocal: b.START_LOCAL, endLocal: b.END_LOCAL, resourceIds: (b.RESOURCE_IDS || []).join(', '), label: b.LABEL || '' })), effectiveFrom: t.EFFECTIVE_FROM || '', effectiveTo: t.EFFECTIVE_TO || '', active: t.ACTIVE_FLAG !== 'N' });
  const overnight = f.endLocal && f.startLocal && f.endLocal < f.startLocal;
  return (
    <Card title="Shifts and schedules" icon="clock">
      {!(m.settings && m.settings.TIMEZONE) && <Banner tone="warn">Save the factory timezone first (step 1) - shift times are plant-local.</Banner>}
      {m.shiftTemplates.length === 0 ? <Empty icon="clock">No shift yet.</Empty> : <div className="table-wrap"><table className="table">
        <thead><tr><th>Code</th><th>Name</th><th>Time (plant)</th><th>Days</th><th>Breaks</th><th>Effective</th><th>Status</th><th /></tr></thead>
        <tbody>{m.shiftTemplates.map(t => <tr key={t.SHIFT_CODE}><td className="mono"><b>{t.SHIFT_CODE}</b></td><td>{t.SHIFT_NAME}</td><td>{t.START_LOCAL}–{t.END_LOCAL}{t.OVERNIGHT && <span className="badge" style={{ marginLeft: 6 }}>overnight</span>}</td><td className="small">{DAYS.filter(([d]) => t.DAYS_OF_WEEK.includes(d)).map(([, l]) => l).join(' ')}</td>
          <td className="small">{(t.BREAKS || []).map(b => `${b.START_LOCAL}–${b.END_LOCAL}${b.RESOURCE_IDS && b.RESOURCE_IDS.length ? ` (${b.RESOURCE_IDS.join(', ')})` : ''}`).join(' · ') || '—'}</td><td className="small">{t.EFFECTIVE_FROM || 'now'} → {t.EFFECTIVE_TO || 'open'}</td><td><Status value={t.ACTIVE_FLAG === 'N' ? 'CLOSED' : 'ACTIVE'} label={t.ACTIVE_FLAG === 'N' ? 'Inactive' : 'Active'} /></td><td>{can && <button className="btn sm" onClick={() => edit(t)}>Edit</button>}</td></tr>)}</tbody></table></div>}
      {can && <div className="card flat" style={{ marginTop: 10 }}>
        <div className="grid four">
          <Field label="Shift code *"><input className="input mono" value={f.code} onChange={e => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="A" /></Field>
          <Field label="Name *"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Start (plant time)"><input className="input" type="time" value={f.startLocal} onChange={e => setF({ ...f, startLocal: e.target.value })} /></Field>
          <Field label="End (plant time)" hint={overnight ? 'Ends the next morning (overnight shift)' : null}><input className="input" type="time" value={f.endLocal} onChange={e => setF({ ...f, endLocal: e.target.value })} /></Field>
          <Field label="Effective from"><input className="input" type="date" value={f.effectiveFrom} onChange={e => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
          <Field label="Effective to"><input className="input" type="date" value={f.effectiveTo} onChange={e => setF({ ...f, effectiveTo: e.target.value })} /></Field>
        </div>
        <div className="field"><label>Days</label><div className="row">{DAYS.map(([d, l]) => <label key={d} className="check"><input type="checkbox" checked={f.daysOfWeek.includes(d)} onChange={e => setF({ ...f, daysOfWeek: e.target.checked ? [...f.daysOfWeek, d].sort() : f.daysOfWeek.filter(x => x !== d) })} />{l}</label>)}</div></div>
        <div className="field"><label>Breaks (labour pauses; unattended processes continue)</label>
          {f.breaks.map((b, i) => <div key={i} className="row">
            <input className="input" type="time" style={{ maxWidth: 130 }} value={b.startLocal} onChange={e => setF({ ...f, breaks: f.breaks.map((x, k) => (k === i ? { ...x, startLocal: e.target.value } : x)) })} aria-label="Break start" />
            <input className="input" type="time" style={{ maxWidth: 130 }} value={b.endLocal} onChange={e => setF({ ...f, breaks: f.breaks.map((x, k) => (k === i ? { ...x, endLocal: e.target.value } : x)) })} aria-label="Break end" />
            <input className="input mono" style={{ maxWidth: 260 }} placeholder="work centres (empty = all), SUPPORT" value={b.resourceIds} onChange={e => setF({ ...f, breaks: f.breaks.map((x, k) => (k === i ? { ...x, resourceIds: e.target.value } : x)) })} aria-label="Work centres" />
            <button className="btn sm ghost" onClick={() => setF({ ...f, breaks: f.breaks.filter((_, k) => k !== i) })} aria-label="Remove break"><Icon name="x" size={14} /></button>
          </div>)}
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, breaks: [...f.breaks, { startLocal: '10:00', endLocal: '10:30', resourceIds: '', label: '' }] })}><Icon name="plus" size={14} />Add break</button>
        </div>
        <label className="check"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Active</label>
        <div className="btn-row"><Busy busy={busy} className="btn primary" disabled={!f.code || !f.name || !f.daysOfWeek.length} onClick={async () => {
          const body = { name: f.name, startLocal: f.startLocal, endLocal: f.endLocal, daysOfWeek: f.daysOfWeek, breaks: f.breaks.map(b => ({ startLocal: b.startLocal, endLocal: b.endLocal, resourceIds: csv(b.resourceIds).map(x => x.toUpperCase()), label: b.label })), effectiveFrom: f.effectiveFrom || null, effectiveTo: f.effectiveTo || null, active: f.active ? 'Y' : 'N' };
          const r = await save('put', `/factory/shifts/${encodeURIComponent(f.code)}`, body, r2 => `Shift ${f.code} saved - calendar ${r2.calendar && r2.calendar.generatedTo ? `generated to ${r2.calendar.generatedTo}` : 'updated'}`);
          if (r) { setF(blank); reload(); }
        }}>Save shift</Busy><button className="btn" onClick={() => setF(blank)}>Clear</button></div>
      </div>}
    </Card>
  );
}

/* ------------------------------------------------------------------ 7 equipment, materials and stock */
function ResourcesTab({ m, reload, can }) {
  const { save, busy } = useSave();
  const toast = useToast();
  const { session } = useApp();
  const blankEq = { id: '', name: '', type: '', workCenterId: (m.workCenters[0] || {}).WORK_CENTER_ID || '', workstationId: '', availability: 'AVAILABLE', requiredSkills: '', mttrMin: '' };
  const blankMat = { id: '', name: '', uom: 'EA', lotTracked: false, reorderPoint: '' };
  const [eq, setEq] = useState(blankEq);
  const [mat, setMat] = useState(blankMat);
  const [rc, setRc] = useState({ materialId: (m.materials[0] || {}).MATERIAL_ID || '', qty: '', lotId: '', note: '' });
  const [rbusy, setRbusy] = useState(false);
  const cmd = async (type, payload, ok) => { setRbusy(true); try { await command(session.sessionId, type, payload); toast(ok, 'ok'); reload(); return true; } catch (e) { toast(e.message, 'bad', 8000); return false; } finally { setRbusy(false); } };
  const bom = {};
  for (const p of m.products) for (const b of p.bom) (bom[b.MATERIAL_ID] = bom[b.MATERIAL_ID] || []).push(`${p.PRODUCT_ID} @${b.CONSUMED_AT_OPERATION_ID} × ${b.QTY_PER_UNIT} ${b.UOM || ''}`);
  return (
    <div className="stack">
      <Card title="Equipment" icon="wrench">
        <p className="hint">Equipment starts with the availability you enter. Breakdowns and repairs are recorded as events (they pause and resume work with an external reason); nothing is repaired by itself in Manual Team Test.</p>
        {m.equipment.length === 0 ? <Empty icon="wrench">No equipment yet (optional unless a route requires an equipment type).</Empty> : <div className="table-wrap"><table className="table">
          <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Station / WC</th><th>Required skills</th><th>Live status</th><th /></tr></thead>
          <tbody>{m.equipment.map(e => <tr key={e.EQUIPMENT_ID}><td className="mono">{e.EQUIPMENT_ID}</td><td>{e.EQUIPMENT_NAME}</td><td className="small">{e.EQUIPMENT_TYPE}</td><td className="small">{e.WORKSTATION_ID || '—'} / {e.WORK_CENTER_ID}</td><td className="small">{(e.REQUIRED_SKILL_IDS || []).join(', ') || '—'}</td><td><Status value={e.liveStatus || 'UNKNOWN'} /></td>
            <td>{can && <div className="row nowrap">
              {e.liveStatus === 'DOWN' ? <button className="btn sm" disabled={rbusy} onClick={() => cmd('EQUIPMENT_REPAIRED', { equipmentId: e.EQUIPMENT_ID }, `${e.EQUIPMENT_ID} repaired`)}>Mark repaired</button> : <button className="btn sm" disabled={rbusy} onClick={() => cmd('EQUIPMENT_BREAKDOWN', { equipmentId: e.EQUIPMENT_ID, reasonCode: 'BREAKDOWN' }, `${e.EQUIPMENT_ID} marked down`)}>Mark down</button>}
              <button className="btn sm" onClick={() => setEq({ id: e.EQUIPMENT_ID, name: e.EQUIPMENT_NAME, type: e.EQUIPMENT_TYPE || '', workCenterId: e.WORK_CENTER_ID, workstationId: e.WORKSTATION_ID || '', availability: e.AVAILABILITY || 'AVAILABLE', requiredSkills: (e.REQUIRED_SKILL_IDS || []).join(', '), mttrMin: e.MTTR_MIN || '' })}>Edit</button></div>}</td></tr>)}</tbody></table></div>}
        {can && <div className="card flat" style={{ marginTop: 10 }}><div className="grid four">
          <Field label="Equipment ID *"><input className="input mono" value={eq.id} onChange={e => setEq({ ...eq, id: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name *"><input className="input" value={eq.name} onChange={e => setEq({ ...eq, name: e.target.value })} /></Field>
          <Field label="Type"><input className="input mono" value={eq.type} onChange={e => setEq({ ...eq, type: e.target.value.toUpperCase() })} placeholder="WELDER" /></Field>
          <Field label="Work centre *"><select className="select" value={eq.workCenterId} onChange={e => setEq({ ...eq, workCenterId: e.target.value, workstationId: '' })}><option value="">choose…</option>{m.workCenters.map(w => <option key={w.WORK_CENTER_ID}>{w.WORK_CENTER_ID}</option>)}</select></Field>
          <Field label="Station"><select className="select" value={eq.workstationId} onChange={e => setEq({ ...eq, workstationId: e.target.value })}><option value="">none</option>{m.stations.filter(s => s.WORK_CENTER_ID === eq.workCenterId).map(s => <option key={s.WORKSTATION_ID}>{s.WORKSTATION_ID}</option>)}</select></Field>
          <Field label="Initial availability"><select className="select" value={eq.availability} onChange={e => setEq({ ...eq, availability: e.target.value })}><option value="AVAILABLE">Available</option><option value="UNAVAILABLE">Unavailable</option></select></Field>
          <Field label="Required skills"><input className="input mono" value={eq.requiredSkills} onChange={e => setEq({ ...eq, requiredSkills: e.target.value })} placeholder="SK-WELD" /></Field>
          <Field label="Typical repair (min)"><input className="input" type="number" min="1" value={eq.mttrMin} onChange={e => setEq({ ...eq, mttrMin: e.target.value })} /></Field>
        </div><div className="btn-row"><Busy busy={busy} className="btn primary" disabled={!eq.id || !eq.name || !eq.workCenterId} onClick={async () => { if (await save('put', `/factory/equipment/${encodeURIComponent(eq.id)}`, { ...eq, workstationId: eq.workstationId || null, requiredSkills: csv(eq.requiredSkills).map(x => x.toUpperCase()), mttrMin: eq.mttrMin || null }, `Equipment ${eq.id} saved`)) { setEq(blankEq); reload(); } }}>Save equipment</Busy><button className="btn" onClick={() => setEq(blankEq)}>Clear</button></div></div>}
      </Card>
      <Card title="Materials, BOM and stock" icon="box">
        <p className="hint">Stock starts at <b>zero</b> and changes only through receipts you enter (and consumption when work starts). Inventory is never assumed.</p>
        {m.materials.length === 0 ? <Empty icon="box">No material yet.</Empty> : <div className="table-wrap"><table className="table">
          <thead><tr><th>ID</th><th>Name</th><th>UOM</th><th>Used by (BOM)</th><th className="num">On hand</th><th className="num">Reserved</th><th>Lots</th><th /></tr></thead>
          <tbody>{m.materials.map(x => <tr key={x.MATERIAL_ID}><td className="mono">{x.MATERIAL_ID}</td><td>{x.MATERIAL_NAME}{x.LOT_TRACKED === 'Y' && <span className="badge" style={{ marginLeft: 6 }}>lot-tracked</span>}</td><td>{x.UOM}</td><td className="small">{(bom[x.MATERIAL_ID] || []).join(' · ') || '—'}</td>
            <td className="num"><b>{x.onHand ?? 'not recorded'}</b></td><td className="num">{x.reserved || 0}</td><td className="small">{(x.lots || []).map(l => `${l.LOT_ID} (${l.QTY})`).join(', ') || '—'}</td>
            <td>{can && <button className="btn sm" onClick={() => setMat({ id: x.MATERIAL_ID, name: x.MATERIAL_NAME, uom: x.UOM, lotTracked: x.LOT_TRACKED === 'Y', reorderPoint: x.REORDER_POINT ?? '' })}>Edit</button>}</td></tr>)}</tbody></table></div>}
        {can && <div className="grid two" style={{ marginTop: 10 }}>
          <div className="card flat"><b>Material</b><div className="grid three">
            <Field label="Material ID *"><input className="input mono" value={mat.id} onChange={e => setMat({ ...mat, id: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name *"><input className="input" value={mat.name} onChange={e => setMat({ ...mat, name: e.target.value })} /></Field>
            <Field label="Unit of measure *"><input className="input mono" value={mat.uom} onChange={e => setMat({ ...mat, uom: e.target.value.toUpperCase() })} /></Field>
          </div><label className="check"><input type="checkbox" checked={mat.lotTracked} onChange={e => setMat({ ...mat, lotTracked: e.target.checked })} /> Lot-tracked (receipts need a lot number)</label>
            <div className="btn-row"><Busy busy={busy} className="btn primary" disabled={!mat.id || !mat.name || !mat.uom} onClick={async () => { if (await save('put', `/factory/materials/${encodeURIComponent(mat.id)}`, { ...mat, lotTracked: mat.lotTracked ? 'Y' : 'N', reorderPoint: mat.reorderPoint || null }, `Material ${mat.id} saved (stock 0 until received)`)) { setMat(blankMat); reload(); } }}>Save material</Busy></div></div>
          <div className="card flat"><b>Receive stock</b><div className="grid three">
            <Field label="Material"><select className="select" value={rc.materialId} onChange={e => setRc({ ...rc, materialId: e.target.value })}><option value="">choose…</option>{m.materials.map(x => <option key={x.MATERIAL_ID}>{x.MATERIAL_ID}</option>)}</select></Field>
            <Field label="Quantity *"><input className="input" type="number" min="0" step="any" value={rc.qty} onChange={e => setRc({ ...rc, qty: e.target.value })} /></Field>
            <Field label="Lot"><input className="input mono" value={rc.lotId} onChange={e => setRc({ ...rc, lotId: e.target.value })} /></Field>
          </div><Field label="Note"><input className="input" value={rc.note} onChange={e => setRc({ ...rc, note: e.target.value })} /></Field>
            <div className="btn-row"><Busy busy={rbusy} className="btn primary" disabled={!rc.materialId || !(Number(rc.qty) > 0)} onClick={async () => { if (await cmd('MATERIAL_RECEIPT', { materialId: rc.materialId, qty: Number(rc.qty), lotId: rc.lotId || null, note: rc.note || null, initialStock: true }, `Received ${rc.qty} ${rc.materialId}`)) setRc({ ...rc, qty: '', lotId: '', note: '' }); }}>Record receipt</Busy></div></div>
        </div>}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ 3 products and routes */
const OP_BLANK = { operationId: '', operationName: '', kind: 'LABOR', workCenterId: '', sequenceNo: '', standardLaborMin: '', standardElapsedMin: '', minCrew: 1, stdCrew: 1, maxCrew: 1, requiredSkillId: '', gateOperationId: '', milestones: '', transferMin: '' };
function ProductsTab({ m, reload, can }) {
  const { save, busy } = useSave();
  const [form, setForm] = useState(null);
  const [check, setCheck] = useState(null);
  const startNew = () => setForm({ revise: false, productId: '', productName: '', modelVariant: '', componentType: 'TRANSFORMER_TANK', drawingRef: '', drawingRevision: 'A', routeVersion: '1.0',
    operations: [{ ...OP_BLANK, sequenceNo: 10 }], materials: [{ materialId: (m.materials[0] || {}).MATERIAL_ID || '', consumedAtOperationId: '', qtyPerUnit: 1, uom: (m.materials[0] || {}).UOM || 'EA' }] });
  const revise = p => setForm({ revise: true, productId: p.PRODUCT_ID, productName: p.PRODUCT_NAME, modelVariant: p.MODEL_VARIANT || '', componentType: p.COMPONENT_TYPE || 'TRANSFORMER_TANK', drawingRef: p.DRAWING_REF || '', drawingRevision: p.DRAWING_REVISION || '',
    operations: p.route.map(r => ({ operationId: r.OPERATION_ID, operationName: r.OPERATION_NAME || '', kind: r.OPERATION_KIND, workCenterId: r.WORK_CENTER_ID, sequenceNo: r.SEQUENCE_NO, standardLaborMin: r.STANDARD_LABOR_MIN ?? '', standardElapsedMin: r.STANDARD_ELAPSED_MIN ?? '', minCrew: r.MIN_CREW_SIZE ?? 1, stdCrew: r.STD_CREW_SIZE ?? 1, maxCrew: r.MAX_CREW_SIZE ?? 1, requiredSkillId: r.REQUIRED_SKILL_ID || '', gateOperationId: r.GATE_OPERATION_ID || '', milestones: '', transferMin: '' })),
    materials: p.bom.map(b => ({ materialId: b.MATERIAL_ID, consumedAtOperationId: b.CONSUMED_AT_OPERATION_ID, qtyPerUnit: b.QTY_PER_UNIT, uom: b.UOM || 'EA' })) });
  const body = f => ({ revise: f.revise, productId: f.productId, productName: f.productName, modelVariant: f.modelVariant || null, componentType: f.componentType, drawingRef: f.drawingRef, drawingRevision: f.drawingRevision, routeVersion: f.routeVersion,
    operations: f.operations.map(o => ({ operationId: o.operationId, operationName: o.operationName, kind: o.kind, workCenterId: o.workCenterId, sequenceNo: Number(o.sequenceNo), standardLaborMin: o.kind === 'PROCESS' ? 0 : Number(o.standardLaborMin || 0), standardElapsedMin: Number(o.standardElapsedMin || 0),
      minCrew: Number(o.minCrew), stdCrew: Number(o.stdCrew), maxCrew: Number(o.maxCrew), requiredSkillId: o.requiredSkillId || null, gateOperationId: o.gateOperationId || null, qualityGateRequired: o.kind === 'LABOR' && o.gateOperationId ? 'Y' : 'N',
      milestones: o.kind === 'LABOR' ? String(o.milestones || '').split(';').map(x => x.trim()).filter(Boolean) : [], transferMin: o.transferMin || 0 })),
    materials: f.materials.filter(x => x.materialId).map(x => ({ ...x, qtyPerUnit: Number(x.qtyPerUnit) })) });
  const setOp = (i, k, v) => setForm({ ...form, operations: form.operations.map((o, j) => (j === i ? { ...o, [k]: v } : o)) });
  return (
    <div className="stack">
      <Card title="Products and routes" icon="tank" actions={can && <button className="btn primary" onClick={startNew}><Icon name="plus" size={16} />New product</button>}>
        {m.products.length === 0 ? <Empty icon="tank">No product yet. A product needs a route (operations in order, ending with an inspection gate), labour standards, crew sizes, a checklist per gate and a bill of materials.</Empty>
          : m.products.map(p => (
            <div key={p.PRODUCT_ID} className="card flat" style={{ marginBottom: 10 }}>
              <div className="row between"><b>{p.PRODUCT_ID} · {p.PRODUCT_NAME}{p.ILLUSTRATIVE && <span className="badge warn" style={{ marginLeft: 6 }}>illustrative · unconfirmed</span>}</b>
                <span className="row nowrap"><Status value={p.STATUS === 'RELEASED' ? 'RELEASED' : p.STATUS === 'INACTIVE' ? 'CLOSED' : 'PENDING'} label={human(p.STATUS || 'RELEASED')} /><span className="small muted">route {p.ROUTE_ID} v{p.ROUTE_VERSION} · drawing {p.DRAWING_REF} rev {p.DRAWING_REVISION}</span>
                  {can && p.STATUS === 'DRAFT' && <Busy busy={busy} className="btn sm primary" onClick={async () => { if (await save('post', `/factory/products/${p.PRODUCT_ID}/release`, {}, `${p.PRODUCT_ID} released`)) reload(); }}>Release</Busy>}
                  {can && <button className="btn sm" onClick={() => revise(p)}>New route version</button>}</span></div>
              {p.problems.length > 0 && <Banner tone="warn">Not complete: {p.problems.join(' · ')}</Banner>}
              <div className="table-wrap"><table className="table">
                <thead><tr><th className="num">Seq</th><th>Operation</th><th>Kind</th><th>WC</th><th>Skill</th><th className="num">Crew min/std/max</th><th className="num">Labour / elapsed (min)</th><th>Gate</th><th>Milestones</th></tr></thead>
                <tbody>{p.route.map(r => <tr key={r.OPERATION_ID}><td className="num">{r.SEQUENCE_NO}</td><td><b className="mono">{r.OPERATION_ID}</b> {r.OPERATION_NAME}</td><td className="small">{r.OPERATION_KIND === 'PROCESS' ? 'Unattended process' : human(r.OPERATION_KIND)}</td><td>{r.WORK_CENTER_ID}</td><td className="mono small">{r.REQUIRED_SKILL_ID || '—'}</td>
                  <td className="num">{r.OPERATION_KIND === 'LABOR' ? `${r.MIN_CREW_SIZE}/${r.STD_CREW_SIZE}/${r.MAX_CREW_SIZE}` : '—'}</td><td className="num">{r.STANDARD_LABOR_MIN ?? '—'} / {r.STANDARD_ELAPSED_MIN ?? '—'}</td><td className="mono small">{r.GATE_OPERATION_ID || '—'}</td><td className="small">{(r.milestones || []).join(' → ') || '—'}</td></tr>)}</tbody></table></div>
              <div className="small muted">BOM: {p.bom.map(b => `${b.MATERIAL_ID} × ${b.QTY_PER_UNIT} ${b.UOM || ''} at ${b.CONSUMED_AT_OPERATION_ID}`).join(' · ') || 'none'}</div>
            </div>))}
      </Card>
      {form && <Modal wide title={form.revise ? `New route version for ${form.productId}` : 'New product'} onClose={() => setForm(null)} footer={<>
        <button className="btn" onClick={() => setForm(null)}>Cancel</button>
        <Busy busy={busy} className="btn" onClick={async () => { const r = await save('post', '/factory/products', { ...body(form), dryRun: true }); if (r) setCheck(r); }}>Check</Busy>
        <Busy busy={busy} className="btn primary" onClick={async () => { const r = await save('post', '/factory/products', body(form), r2 => `${r2.productId} saved as ${r2.status}${r2.missing && r2.missing.length ? ` - missing: ${r2.missing.slice(0, 2).join('; ')}` : ''}`); if (r) { setForm(null); setCheck(null); reload(); } }}>Save</Busy></>}>
        {form.revise && <Banner tone="info">A new route version replaces the current one for new tanks. It is refused while tanks of this product are in progress; finished tanks keep the version they were made with.</Banner>}
        <div className="grid four">
          <Field label="Product ID *"><input className="input mono" disabled={form.revise} value={form.productId} onChange={e => setForm({ ...form, productId: e.target.value.toUpperCase() })} placeholder="TANK-A" /></Field>
          <Field label="Name / model *"><input className="input" value={form.productName} onChange={e => setForm({ ...form, productName: e.target.value })} /></Field>
          <Field label="Model / variant"><input className="input" value={form.modelVariant} onChange={e => setForm({ ...form, modelVariant: e.target.value })} /></Field>
          <Field label="Component type"><input className="input mono" value={form.componentType} onChange={e => setForm({ ...form, componentType: e.target.value.toUpperCase() })} /></Field>
          <Field label="Drawing / reference *"><input className="input mono" value={form.drawingRef} onChange={e => setForm({ ...form, drawingRef: e.target.value })} /></Field>
          <Field label="Revision *"><input className="input mono" value={form.drawingRevision} onChange={e => setForm({ ...form, drawingRevision: e.target.value })} /></Field>
          {!form.revise && <Field label="Route version"><input className="input mono" value={form.routeVersion} onChange={e => setForm({ ...form, routeVersion: e.target.value })} /></Field>}
        </div>
        <div className="field"><label>Route - operations in order (end with an inspection gate). Milestones: separate with “;” - the last one is recorded by finishing the work.</label>
          <div className="table-wrap"><table className="table"><thead><tr><th>Seq</th><th>Op ID</th><th>Name</th><th>Kind</th><th>WC</th><th>Skill</th><th>Labour min</th><th>Elapsed min</th><th>Crew min/std/max</th><th>Gate (labour)</th><th>Milestones</th><th /></tr></thead>
            <tbody>{form.operations.map((o, i) => <tr key={i}>
              <td><input className="input" style={{ width: 64 }} type="number" value={o.sequenceNo} onChange={e => setOp(i, 'sequenceNo', e.target.value)} aria-label="Sequence" /></td>
              <td><input className="input mono" style={{ width: 80 }} value={o.operationId} onChange={e => setOp(i, 'operationId', e.target.value.toUpperCase())} aria-label="Operation ID" /></td>
              <td><input className="input" style={{ width: 150 }} value={o.operationName} onChange={e => setOp(i, 'operationName', e.target.value)} aria-label="Name" /></td>
              <td><select className="select" value={o.kind} onChange={e => setOp(i, 'kind', e.target.value)} aria-label="Kind"><option value="LABOR">Labour (attended)</option><option value="INSPECTION">Inspection gate</option><option value="PROCESS">Unattended process</option></select></td>
              <td><select className="select" value={o.workCenterId} onChange={e => setOp(i, 'workCenterId', e.target.value)} aria-label="Work centre"><option value="">—</option>{m.workCenters.map(w => <option key={w.WORK_CENTER_ID}>{w.WORK_CENTER_ID}</option>)}</select></td>
              <td><select className="select" value={o.requiredSkillId} onChange={e => setOp(i, 'requiredSkillId', e.target.value)} aria-label="Skill"><option value="">none</option>{m.skills.map(s => <option key={s.SKILL_ID}>{s.SKILL_ID}</option>)}</select></td>
              <td><input className="input" style={{ width: 70 }} type="number" min="0" disabled={o.kind === 'PROCESS'} value={o.standardLaborMin} onChange={e => setOp(i, 'standardLaborMin', e.target.value)} aria-label="Labour minutes" /></td>
              <td><input className="input" style={{ width: 70 }} type="number" min="0" value={o.standardElapsedMin} onChange={e => setOp(i, 'standardElapsedMin', e.target.value)} aria-label="Elapsed minutes" /></td>
              <td className="nowrap">{['minCrew', 'stdCrew', 'maxCrew'].map(k => <input key={k} className="input" style={{ width: 48, display: 'inline-block' }} type="number" min="0" value={o[k]} onChange={e => setOp(i, k, e.target.value)} aria-label={k} />)}</td>
              <td><input className="input mono" style={{ width: 80 }} disabled={o.kind !== 'LABOR'} value={o.gateOperationId} onChange={e => setOp(i, 'gateOperationId', e.target.value.toUpperCase())} aria-label="Gate" /></td>
              <td><input className="input" style={{ width: 200 }} disabled={o.kind !== 'LABOR'} value={o.milestones} onChange={e => setOp(i, 'milestones', e.target.value)} placeholder={form.revise ? 'keep existing' : 'Step 1; Step 2; Work complete'} aria-label="Milestones" /></td>
              <td><button className="btn sm ghost" onClick={() => setForm({ ...form, operations: form.operations.filter((_, j) => j !== i) })} aria-label="Remove operation"><Icon name="x" size={14} /></button></td>
            </tr>)}</tbody></table></div>
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setForm({ ...form, operations: [...form.operations, { ...OP_BLANK, sequenceNo: (Number((form.operations[form.operations.length - 1] || {}).sequenceNo) || 0) + 10 }] })}><Icon name="plus" size={14} />Add operation</button>
        </div>
        <div className="field"><label>Bill of materials</label>
          {form.materials.map((x, i) => <div key={i} className="row">
            <select className="select" style={{ maxWidth: 200 }} value={x.materialId} onChange={e => setForm({ ...form, materials: form.materials.map((y, j) => (j === i ? { ...y, materialId: e.target.value, uom: (m.materials.find(z => z.MATERIAL_ID === e.target.value) || {}).UOM || y.uom } : y)) })} aria-label="Material"><option value="">—</option>{m.materials.map(z => <option key={z.MATERIAL_ID}>{z.MATERIAL_ID}</option>)}</select>
            <span className="small">consumed at</span><input className="input mono" style={{ maxWidth: 100 }} value={x.consumedAtOperationId} onChange={e => setForm({ ...form, materials: form.materials.map((y, j) => (j === i ? { ...y, consumedAtOperationId: e.target.value.toUpperCase() } : y)) })} aria-label="Consumed at operation" />
            <input className="input" type="number" min="0" step="any" style={{ maxWidth: 90 }} value={x.qtyPerUnit} onChange={e => setForm({ ...form, materials: form.materials.map((y, j) => (j === i ? { ...y, qtyPerUnit: e.target.value } : y)) })} aria-label="Quantity per tank" /><span className="small">{x.uom} per tank</span>
            <button className="btn sm ghost" onClick={() => setForm({ ...form, materials: form.materials.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="x" size={14} /></button></div>)}
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setForm({ ...form, materials: [...form.materials, { materialId: '', consumedAtOperationId: '', qtyPerUnit: 1, uom: 'EA' }] })}><Icon name="plus" size={14} />Add material</button>
        </div>
        {check && <Banner tone={check.status === 'RELEASED' ? 'ok' : 'warn'}>Check: would be saved as <b>{check.status}</b>{check.missing && check.missing.length ? ` - still missing: ${check.missing.join(' · ')}` : ' - complete and ready to order.'}</Banner>}
      </Modal>}
    </div>
  );
}

/* ------------------------------------------------------------------ 4 inspection checklists */
const Q_BLANK = { checkId: '', question: '', requirement: '', section: '', inputType: 'YES_NO', mandatory: true, failureAnswer: 'No', unit: '', lower: '', upper: '', nominal: '', readings: 1, photoRequired: false, photoOnFail: false, instrument: '' };
function ChecklistsTab({ m, reload, can }) {
  const { save, busy } = useSave();
  const [form, setForm] = useState(null);
  const gates = [...new Set(m.products.flatMap(p => p.route.filter(r => r.OPERATION_KIND === 'INSPECTION').map(r => r.OPERATION_ID)))];
  const missing = gates.filter(g => !m.checklists.some(c => c.gateOperationId === g));
  const edit = (gate, c) => {
    const nextVersion = c ? `${(Math.floor(Number(c.version)) || 1) + 1}.0` : '1.0';
    setForm({ gate, version: nextVersion, checks: c ? c.checks.map(k => { const s = (k.DEFAULT_SPECS || [])[0] || {}; return { checkId: k.CHECK_ID, question: k.QUESTION_TEXT || '', requirement: k.REQUIREMENT_TEXT || '', section: k.SECTION || '', inputType: k.ANSWER_TYPE, mandatory: (k.MANDATORY_FLAG || 'Y') === 'Y', failureAnswer: k.FAILURE_ANSWER || 'No', unit: s.MEASUREMENT_UNIT || '', lower: s.LOWER_LIMIT ?? '', upper: s.UPPER_LIMIT ?? '', nominal: s.NOMINAL_VALUE ?? '', readings: s.REQUIRED_READING_COUNT || 1, photoRequired: !!k.PHOTO_REQUIRED, photoOnFail: k.EVIDENCE_REQUIRED === 'ON_FAILURE_ANSWER', instrument: k.INSTRUMENT_TYPE || '' }; }) : [{ ...Q_BLANK }] });
  };
  const setQ = (i, k, v) => setForm({ ...form, checks: form.checks.map((q, j) => (j === i ? { ...q, [k]: v } : q)) });
  return (
    <div className="stack">
      <Banner tone="info">Limits are entered by you - none are invented, and nothing here is presented as a Siemens tolerance. Each saved checklist is a new <b>version</b>; an inspection keeps the exact questions and limits it was started with.</Banner>
      {missing.length > 0 && <Banner tone="warn">Gates in your routes without a checklist: {missing.map(g => <button key={g} className="btn sm" style={{ marginLeft: 6 }} disabled={!can} onClick={() => edit(g, null)}>Create {g}</button>)}</Banner>}
      {m.checklists.length === 0 && !missing.length && <Empty icon="quality">No checklist yet. Products name their inspection gates; create a checklist per gate.</Empty>}
      {m.checklists.map(c => (
        <Card key={c.gateOperationId} title={`${c.gateOperationId} · version ${c.version}`} icon="quality" actions={<span className="row nowrap">{c.illustrative && <span className="badge warn">illustrative · unconfirmed</span>}{c.previousVersions.length > 0 && <span className="small muted">earlier: {c.previousVersions.join(', ')}</span>}{can && <button className="btn sm" onClick={() => edit(c.gateOperationId, c)}>New version</button>}</span>}>
          <div className="table-wrap"><table className="table"><thead><tr><th>Check</th><th>Question</th><th>Input</th><th>Mandatory</th><th>Pass / fail rule</th><th>Photo</th><th>Instrument</th></tr></thead>
            <tbody>{c.checks.map(k => { const s = k.DEFAULT_SPECS || []; return <tr key={k.CHECK_ID}><td className="mono small">{k.CHECK_ID}</td><td>{k.QUESTION_TEXT}<div className="small muted">{k.REQUIREMENT_TEXT}</div></td><td className="small">{human(k.ANSWER_TYPE)}</td><td>{(k.MANDATORY_FLAG || 'Y') === 'Y' ? 'Yes' : 'No'}</td>
              <td className="small">{k.ANSWER_TYPE === 'YES_NO' ? `“${k.FAILURE_ANSWER || 'No'}” fails` : (s.length ? s.map(x => `${x.MEASUREMENT_POSITION}: ${x.LOWER_LIMIT ?? '−∞'}..${x.UPPER_LIMIT ?? '+∞'} ${x.MEASUREMENT_UNIT || ''} ×${x.REQUIRED_READING_COUNT || 1}`).join('; ') : 'product-specific limits')}</td><td>{k.PHOTO_REQUIRED || k.EVIDENCE_REQUIRED === 'PHOTO' ? 'Required' : '—'}</td><td className="small">{k.INSTRUMENT_TYPE || '—'}</td></tr>; })}</tbody></table></div>
        </Card>))}
      {form && <Modal wide title={`Checklist ${form.gate} · version ${form.version}`} onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>Cancel</button>
        <Busy busy={busy} className="btn primary" disabled={!form.gate || !form.checks.length} onClick={async () => {
          const r = await save('put', `/factory/checklists/${encodeURIComponent(form.gate)}`, { version: form.version, checks: form.checks.map(q => ({ ...q, lower: q.lower === '' ? null : Number(q.lower), upper: q.upper === '' ? null : Number(q.upper), nominal: q.nominal === '' ? null : Number(q.nominal), readings: Number(q.readings || 1), checkId: q.checkId || undefined })) }, `Checklist ${form.gate} v${form.version} saved`);
          if (r) { setForm(null); reload(); }
        }}>Save version {form.version}</Busy></>}>
        <div className="grid four"><Field label="Gate operation ID"><input className="input mono" value={form.gate} onChange={e => setForm({ ...form, gate: e.target.value.toUpperCase() })} /></Field><Field label="Version"><input className="input mono" value={form.version} onChange={e => setForm({ ...form, version: e.target.value })} /></Field></div>
        {form.checks.map((q, i) => <div key={i} className="card flat" style={{ marginBottom: 8 }}>
          <div className="row between"><b>Question {i + 1}</b><button className="btn sm ghost" onClick={() => setForm({ ...form, checks: form.checks.filter((_, j) => j !== i) })} aria-label="Remove question"><Icon name="x" size={14} /></button></div>
          <div className="grid four">
            <Field label="Question text *"><input className="input" value={q.question} onChange={e => setQ(i, 'question', e.target.value)} /></Field>
            <Field label="Requirement / reference"><input className="input" value={q.requirement} onChange={e => setQ(i, 'requirement', e.target.value)} /></Field>
            <Field label="Input type"><select className="select" value={q.inputType} onChange={e => setQ(i, 'inputType', e.target.value)}><option value="YES_NO">Yes / No</option><option value="NUMERIC">Numeric reading</option></select></Field>
            <Field label="Check ID"><input className="input mono" value={q.checkId} onChange={e => setQ(i, 'checkId', e.target.value.toUpperCase())} placeholder="auto" /></Field>
            {q.inputType === 'YES_NO' ? <Field label="Answer that FAILS"><select className="select" value={q.failureAnswer} onChange={e => setQ(i, 'failureAnswer', e.target.value)}><option>No</option><option>Yes</option></select></Field> : <>
              <Field label="Unit *"><input className="input" value={q.unit} onChange={e => setQ(i, 'unit', e.target.value)} placeholder="mm" /></Field>
              <Field label="Lower limit"><input className="input" type="number" step="any" value={q.lower} onChange={e => setQ(i, 'lower', e.target.value)} /></Field>
              <Field label="Upper limit"><input className="input" type="number" step="any" value={q.upper} onChange={e => setQ(i, 'upper', e.target.value)} /></Field>
              <Field label="Nominal"><input className="input" type="number" step="any" value={q.nominal} onChange={e => setQ(i, 'nominal', e.target.value)} /></Field>
              <Field label="Readings"><input className="input" type="number" min="1" max="20" value={q.readings} onChange={e => setQ(i, 'readings', e.target.value)} /></Field></>}
            <Field label="Instrument"><input className="input" value={q.instrument} onChange={e => setQ(i, 'instrument', e.target.value)} /></Field>
            <Field label="Section"><input className="input" value={q.section} onChange={e => setQ(i, 'section', e.target.value)} /></Field>
          </div>
          <div className="row"><label className="check"><input type="checkbox" checked={q.mandatory} onChange={e => setQ(i, 'mandatory', e.target.checked)} /> Mandatory (missing = incomplete, never a pass)</label><label className="check"><input type="checkbox" checked={q.photoRequired} onChange={e => setQ(i, 'photoRequired', e.target.checked)} /> Photo always required</label><label className="check"><input type="checkbox" checked={!q.photoRequired && q.photoOnFail} disabled={q.photoRequired} onChange={e => setQ(i, 'photoOnFail', e.target.checked)} /> Photo required when the answer fails</label></div>
        </div>)}
        <button className="btn sm" onClick={() => setForm({ ...form, checks: [...form.checks, { ...Q_BLANK }] })}><Icon name="plus" size={14} />Add question</button>
      </Modal>}
    </div>
  );
}

/* ------------------------------------------------------------------ template import */
function TemplateTab({ reload, can }) {
  const prev = usePoll('/factory/template', { interval: 600000 });
  const { save, busy } = useSave();
  const [txt, setTxt] = useState('');
  if (!prev.data) return prev.error ? <ErrorState error={prev.error} /> : <Loading />;
  const p = prev.data;
  return (
    <Card title={p.label} icon="box">
      <Banner tone="warn"><b>Optional and illustrative.</b> {p.warning}</Banner>
      <KV items={[['Contains', p.contains], ['Records', Object.entries(p.counts).map(([k, v]) => `${human(k)} ${v}`).join(' · ')]]} />
      {p.conflicts.length > 0 ? <Banner tone="info">The template only fills an empty configuration: {p.conflicts.length} record(s) already exist ({p.conflicts.slice(0, 3).join('; ')}…). Nothing will be imported.</Banner>
        : can && <div className="stack tight" style={{ marginTop: 10 }}>
          <Field label='Type "IMPORT ILLUSTRATIVE TEMPLATE" to confirm'><input className="input mono" value={txt} onChange={e => setTxt(e.target.value)} /></Field>
          <Busy busy={busy} className="btn primary" disabled={txt !== 'IMPORT ILLUSTRATIVE TEMPLATE'} onClick={async () => { if (await save('post', '/factory/template/import', { confirm: txt }, 'Illustrative template imported - review every value')) { prev.reload(); reload(); } }}>Import configuration template</Busy>
          <span className="hint">After the import: receive material stock (stock stays 0), create shifts if you need others, and create your workers. No worker, order or history is imported.</span>
        </div>}
    </Card>
  );
}

/* ------------------------------------------------------------------ guarded reset */
function ResetTab() {
  const { user } = useApp();
  const env = useEnv();
  const allowed = (user.permissions || []).includes('factory_reset');
  const prev = usePoll(allowed ? '/factory/reset' : null, { interval: 30000 });
  const { save, busy } = useSave();
  const [f, setF] = useState({ confirmText: '', factoryName: '', acknowledge: false, clearWorkers: false, clearConfiguration: false });
  const [done, setDone] = useState(null);
  if (!allowed) return <Banner tone="warn">Only administrators with the factory-reset permission can see this.</Banner>;
  if (!prev.data) return prev.error ? <ErrorState error={prev.error} /> : <Loading />;
  const p = prev.data;
  const rows = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
  return (
    <Card title="Reset the test factory" icon="refresh">
      <Banner tone={p.enabled ? 'warn' : 'info'}>{p.enabled ? <>The reset is <b>enabled</b> for this disposable test environment. It deletes operational data of database <b className="mono">{p.target.database}</b> only.</> : <><b>Disabled.</b> {p.reason}</>}</Banner>
      <KV items={[['Target database', <span className="mono">{p.target.database}</span>], ['Environment', env ? env.environmentName : '—'], ['Factory', p.target.factoryName || '—'], ['Operational records', rows(p.operational)], ['People', rows(p.people)], ['Configuration', rows(p.configuration)], ['Always kept', p.keeps.join(' · ')]]} />
      {done && <Banner tone="ok">Reset {done.resetId} completed (generation {done.generation}). Operator sign-ins were ended; administrators keep access.</Banner>}
      {p.enabled && <div className="stack tight" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={f.clearWorkers} onChange={e => setF({ ...f, clearWorkers: e.target.checked })} /> {p.options.clearWorkers}</label>
        <label className="check"><input type="checkbox" checked={f.clearConfiguration} onChange={e => setF({ ...f, clearConfiguration: e.target.checked })} /> {p.options.clearConfiguration}</label>
        <Field label={`Type "${p.confirmText}"`}><input className="input mono" value={f.confirmText} onChange={e => setF({ ...f, confirmText: e.target.value })} /></Field>
        <Field label="Type the factory name exactly"><input className="input" value={f.factoryName} onChange={e => setF({ ...f, factoryName: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.acknowledge} onChange={e => setF({ ...f, acknowledge: e.target.checked })} /> I understand that the operational data listed above is deleted (evidence files in Cloudinary are not deleted - see DATA_RESET_POLICY.md).</label>
        <Busy busy={busy} className="btn danger" disabled={f.confirmText !== p.confirmText || !f.acknowledge || (p.target.factoryName && f.factoryName !== p.target.factoryName)} onClick={async () => { const r = await save('post', '/factory/reset', f, 'Factory reset completed'); if (r) { setDone(r); prev.reload(); } }}>Reset operational data</Busy>
      </div>}
    </Card>
  );
}

export { Link };
