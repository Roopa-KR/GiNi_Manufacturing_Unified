'use strict';
/* Server-authoritative simulation clock and timezone helpers (no guessing of local timezone). */

const PLANT_TZ = 'America/Bogota';      // synthetic dataset default; a fresh factory sets its own (factory_settings.TIMEZONE)
let currentTz = PLANT_TZ;
function setPlantTz(tz) { if (tz) { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); currentTz = tz; } }   // throws on an unknown zone
function plantTz() { return currentTz; }

/** simulated "now" for a session from persisted anchors (never mutates). Manual Team Test sessions run on real time. */
function simNow(session, wallNow = new Date()) {
  const c = session.CLOCK || {};
  if (c.REAL_TIME) return wallNow;
  const anchorSim = new Date(c.ANCHOR_SIM_AT || session.FORK_AT);
  if (c.PAUSED || !c.ANCHOR_WALL_AT) return anchorSim;
  const elapsedMs = wallNow.getTime() - new Date(c.ANCHOR_WALL_AT).getTime();
  let t = new Date(anchorSim.getTime() + Math.max(0, elapsedMs) * (c.SPEED || 1));
  if (session.HORIZON_AT && t > new Date(session.HORIZON_AT)) t = new Date(session.HORIZON_AT);
  return t;
}

/** local wall-clock parts in a named timezone using Intl (correct for any offset / DST rules). */
function localParts(d, tz = currentTz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return p;
}
function localIso(d, tz = currentTz) {
  if (!d) return null;
  const p = localParts(new Date(d), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
/** convert plant-local wall time (YYYY-MM-DD, HH:MM) to UTC Date. */
function localToUtc(dateStr, hhmm, tz = currentTz) {
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, da, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += Date.UTC(y, mo - 1, da, h, mi) - asUtc;
  }
  return new Date(guess);
}
function addMin(d, m) { return new Date(new Date(d).getTime() + m * 60000); }
function minutesBetween(a, b) { return (new Date(b).getTime() - new Date(a).getTime()) / 60000; }

/* v3 defect normalisation: two v3 columns hold simulation minutes instead of datetimes (source-audit D-01/D-02).
   The generator's documented epoch is sim minute 0 = 2026-09-14 00:00 America/Bogota (generator/common.py EPOCH_LOCAL). */
const SIM_EPOCH_UTC = localToUtc('2026-09-14', '00:00', PLANT_TZ);
function simMinuteToUtc(m) { return typeof m === 'number' ? new Date(SIM_EPOCH_UTC.getTime() + Math.round(m * 60) * 1000) : m; }

module.exports = { PLANT_TZ, setPlantTz, plantTz, simNow, localIso, localParts, localToUtc, addMin, minutesBetween, simMinuteToUtc, SIM_EPOCH_UTC };
