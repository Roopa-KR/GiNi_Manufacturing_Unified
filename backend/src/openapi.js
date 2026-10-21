'use strict';
/* OpenAPI 3.1 description generated from the route table and the command registry (so documented commands always match the code). */
const { registry } = require('./domain/executor');

const R = (method, path, summary, opts = {}) => ({ method, path, summary, ...opts });
const ROUTES = [
  R('post', '/api/auth/login', 'Sign in with employee ID + demo PIN (PIN is a string; leading zeros count). Sets host-only HttpOnly session cookie + CSRF cookie for the calling app.', { body: { loginId: 'string', pin: 'string' }, public: true }),
  R('post', '/api/auth/logout', 'Revoke the session'),
  R('get', '/api/auth/me', 'Current user, roles and permissions'),
  R('post', '/api/auth/change-pin', 'Change own PIN/password', { body: { currentPin: 'string', newPin: 'string' } }),
  R('get', '/api/health', 'Liveness', { public: true }), R('get', '/api/ready', 'Readiness incl. configuration and database', { public: true }),
  R('get', '/api/sessions', 'List simulation sessions'), R('get', '/api/sessions/default', 'Default session'),
  R('post', '/api/sessions', 'Create a session (scenario_control): mode INTERACTIVE (fork at checkpoint) or REPLAY', { body: { mode: 'INTERACTIVE|REPLAY', checkpointId: 'string', sourceRunId: 'string', makeDefault: 'boolean' } }),
  R('get', '/api/sessions/{sid}', 'Session incl. shared clock'),
  R('post', '/api/sessions/{sid}/clock', 'PLAY | PAUSE | SPEED | SEEK (seek: replay only)', { body: { action: 'string', speed: 'number', seekTo: 'date-time' } }),
  R('post', '/api/sessions/{sid}/reset', 'Reset an interactive session to its checkpoint (confirm text "RESET <sid>")', { body: { confirm: 'string' } }),
  R('post', '/api/sessions/{sid}/recalculate', 'Enqueue a recalculation or recovery-option job (202)', { body: { kind: 'RECALC|RECOVERY', orderLineId: 'string' } }),
  R('post', '/api/sessions/{sid}/commands/{type}', 'Execute a command (Idempotency-Key header required; expected entity version in body where relevant). See x-commands.'),
  R('get', '/api/sessions/{sid}/me/home', 'My shift, current task, draft inspections, next actions, points'),
  R('get', '/api/sessions/{sid}/me/queue', 'My assigned tasks, joinable operations, eligible queue (DR-1.0 order) and planned work'),
  R('get', '/api/sessions/{sid}/me/progress', 'My labour categories, completed work, crew shares, points ledger, pending investigations'),
  R('get', '/api/sessions/{sid}/me/tasks/{taskId}', 'Task detail (instructions, milestones, crew, material, time)'),
  R('get', '/api/sessions/{sid}/overview', 'Shift overview (observe)'), R('get', '/api/sessions/{sid}/workforce', 'Full plant workforce (filters: shiftOnly, workCenterId, role, state, q, page)'),
  R('get', '/api/sessions/{sid}/workers/{wid}', 'Worker timeline'), R('get', '/api/sessions/{sid}/work-centers/{wc}', 'Work centre detail'),
  R('get', '/api/sessions/{sid}/orders', 'Order lines with good/scrap/WIP buckets and forecast band'), R('get', '/api/sessions/{sid}/orders/{lineId}', 'Order line -> batches -> tanks'),
  R('get', '/api/sessions/{sid}/units/{unitId}', 'Tank passport'), R('get', '/api/sessions/{sid}/quality', 'Holds, returns, investigations, inspections'),
  R('get', '/api/sessions/{sid}/inspections/{id}', 'Inspection with versioned checklist and specifications'),
  R('get', '/api/sessions/{sid}/alerts', 'Alerts (evaluation + workflow states), notifications, rule evaluation'),
  R('get', '/api/sessions/{sid}/forecasts', 'Order forecasts, cutoff bands, work-centre predictions, recovery options'),
  R('get', '/api/sessions/{sid}/actions', 'Recovery actions with before/after and verification'),
  R('get', '/api/sessions/{sid}/materials', 'Materials, requests, equipment'), R('get', '/api/sessions/{sid}/events', 'Event delta since cursor (?since=seq)'),
  R('get', '/api/sessions/{sid}/support-requests', 'Help requests'), R('get', '/api/sessions/{sid}/freshness', 'Operational / analytical freshness'),
  R('post', '/api/sessions/{sid}/evidence/sign', 'Authorise a photo upload (Cloudinary signed fields or local adapter URL)'),
  R('post', '/api/sessions/{sid}/evidence/{evidenceId}/complete', 'Verify the stored upload server-side'),
  R('get', '/api/sessions/{sid}/evidence/{evidenceId}/view', 'Role-restricted evidence delivery'),
  R('get', '/api/admin/workers', 'List workers'), R('post', '/api/admin/workers', 'Create worker (manage_workers)'), R('patch', '/api/admin/workers/{wid}', 'Edit worker'),
  R('post', '/api/admin/workers/{wid}/deactivate', 'Deactivate'), R('post', '/api/admin/workers/{wid}/activate', 'Activate'), R('post', '/api/admin/workers/{wid}/reset-pin', 'Reset PIN'),
  R('get', '/api/admin/reference', 'Reference lists'), R('get', '/api/admin/rules', 'Rule versions'), R('put', '/api/admin/rules', 'New rule version (rule_editing)'),
  R('get', '/api/admin/audit', 'Audit log'), R('get', '/api/admin/import-status', 'Import manifests, seed runs, reconciliation, quarantine'), R('get', '/api/admin/jobs', 'Jobs + engine heartbeats'),
  R('post', '/api/admin/jobs/{jobId}/retry', 'Retry a dead job'), R('get', '/api/admin/notifications', 'Notification outbox'), R('get', '/api/admin/integrations', 'Integration status'),
  R('get', '/api/environment', 'Environment banner: environment (FRESH_FACTORY | SYNTHETIC_DEMO), factory name, operating mode, plant date + timezone; database NAME only when signed in. Never secrets.', { public: true }),
  R('get', '/api/factory/setup', 'Fresh factory: 10-step setup checklist with completion state, configurationSaved / readyToRelease / readyToStart (factory_configuration | operational_supervision | manage_workers)'),
  R('get', '/api/factory/master', 'Fresh factory: all configuration (work centres, stations, skills, equipment, materials, shift templates, products + routes, checklists)'),
  R('get', '/api/factory/readiness', 'Fresh factory: per-tank readiness (material, station, equipment, qualified worker, crew, checklist) with blockers (?unitId=)'),
  R('get', '/api/factory/settings', 'Fresh factory settings'),
  R('put', '/api/factory/settings', 'Save factory settings: factoryName, siteId, timezone, operatingMode MANUAL_TEAM_TEST|SIMULATED_TEST, serialPrefix, workday (factory_configuration)', { body: { factoryName: 'string', siteId: 'string', timezone: 'IANA zone', operatingMode: 'MANUAL_TEAM_TEST|SIMULATED_TEST', serialPrefix: 'string' } }),
  R('put', '/api/factory/work-centers/{id}', 'Create / update a work centre (audited; triggers RECALC)'),
  R('put', '/api/factory/stations/{id}', 'Create / update a station'),
  R('put', '/api/factory/skills/{id}', 'Create / update a skill'),
  R('put', '/api/factory/equipment/{id}', 'Create / update equipment'),
  R('put', '/api/factory/materials/{id}', 'Create / update a material (stock starts at 0; receive with MATERIAL_RECEIPT)'),
  R('put', '/api/factory/shifts/{code}', 'Create / update a shift template (start/end incl. overnight, breaks, workdays); regenerates the 60-day calendar'),
  R('post', '/api/factory/calendar/regenerate', 'Regenerate the shift calendar and rosters 60 days ahead'),
  R('put', '/api/factory/checklists/{gate}', 'New checklist version for an inspection gate (old version archived to ctq_check_history; open inspections keep their pinned snapshot)'),
  R('post', '/api/factory/products', 'Create / revise a product with route, crew, labour standards, milestones, material (DRAFT when incomplete, RELEASED when complete; dryRun supported)'),
  R('post', '/api/factory/products/{id}/release', 'Release a DRAFT product once it is complete'),
  R('get', '/api/factory/template', 'Preview the illustrative (unconfirmed) configuration template'),
  R('post', '/api/factory/template/import', 'Import the illustrative template into an EMPTY configuration (confirm "IMPORT ILLUSTRATIVE TEMPLATE"); never workers, orders or history', { body: { confirm: 'string' } }),
  R('get', '/api/factory/reset', 'Reset preview: database name, factory name, counts that would be removed (factory_reset; disabled unless ALLOW_FACTORY_RESET=true, never in production)'),
  R('post', '/api/factory/reset', 'Guarded reset of operational data (confirmText "RESET <database>" + factory name + acknowledge). Keeps admins and the audit; workers / configuration only removed when clearWorkers / clearConfiguration. Never run at start-up', { body: { confirmText: 'string', factoryName: 'string', acknowledge: 'bool', clearWorkers: 'bool', clearConfiguration: 'bool' } }),
  R('post', '/api/internal/commands', 'Engine agents: batch of commands (Bearer INTERNAL_SERVICE_TOKEN)', { internal: true }),
  R('post', '/api/internal/notifications/dispatch', 'Engine: dispatch claimed notifications through Nodemailer', { internal: true }),
];

function build() {
  const paths = {};
  for (const r of ROUTES) {
    const op = { summary: r.summary, responses: { 200: { description: 'OK' }, 400: { description: 'Validation error' }, 401: { description: 'Not signed in' }, 403: { description: 'Not permitted' }, 409: { description: 'Conflict (state/version)' } } };
    if (r.body) op.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(r.body).map(([k, t]) => [k, { type: 'string', description: t }])) } } } };
    if (!r.public) op.security = r.internal ? [{ internalToken: [] }] : [{ sessionCookie: [], csrf: [] }];
    (paths[r.path] = paths[r.path] || {})[r.method] = op;
  }
  const commands = Object.entries(registry).map(([type, d]) => ({ type, permission: d.perm || null, agentAllowed: d.agentAllowed !== false, serverOnly: !!d.trustedOnly })).sort((a, b) => a.type.localeCompare(b.type));
  return { openapi: '3.1.0', info: { title: 'GiNi manufacturing demo API', version: '1.0.0', description: 'Synthetic demonstration (not a Siemens system). Commands are validated server-side and executed in MongoDB transactions.' },
    components: { securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'gini_sid_operator | gini_sid_admin' }, csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, internalToken: { type: 'http', scheme: 'bearer' } } },
    paths, 'x-commands': commands };
}
module.exports = build();
