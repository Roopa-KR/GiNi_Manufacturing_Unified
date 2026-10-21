'use strict';
/*
 * LOCAL TEST STAND-IN - NOT USED IN DEPLOYMENT.
 *
 * A small in-memory document store implementing the subset of MongoDB query/update semantics that the GiNi
 * application code uses. It exists only because this build environment cannot install or download MongoDB.
 * Production and any real integration test must use MongoDB Atlas / a replica set with the official drivers.
 *
 * Supported: equality on scalars/arrays/dates, dotted paths, $eq $ne $gt $gte $lt $lte $in $nin $exists $regex
 * $elemMatch $size $all $not $and $or $nor; updates $set $unset $inc $mul $min $max $push($each,$slice) $addToSet
 * $pull $setOnInsert $currentDate; unique + compound + partial indexes; sort/skip/limit/projection; a small
 * aggregation subset ($match $group $sort $skip $limit $project $count $unwind).
 */
const crypto = require('crypto');

class ObjectId {
  constructor(hex) {
    if (hex instanceof ObjectId) hex = hex.hex;
    if (hex && typeof hex === 'object' && hex.$oid) hex = hex.$oid;
    this.hex = typeof hex === 'string' && /^[0-9a-f]{24}$/i.test(hex) ? hex.toLowerCase() : ObjectId.generate();
  }
  static generate() {
    const t = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    ObjectId._ctr = ((ObjectId._ctr || crypto.randomInt(0, 0xffffff)) + 1) % 0xffffff;
    return t + ObjectId._rand + ObjectId._ctr.toString(16).padStart(6, '0');
  }
  toString() { return this.hex; }
  toHexString() { return this.hex; }
  toJSON() { return this.hex; }
  equals(o) { return o != null && String(o.hex || o) === this.hex; }
  getTimestamp() { return new Date(parseInt(this.hex.slice(0, 8), 16) * 1000); }
}
ObjectId._rand = crypto.randomBytes(5).toString('hex');

class Decimal128 {
  constructor(s) { this.value = String(s); }
  toString() { return this.value; }
  toJSON() { return { $numberDecimal: this.value }; }
}

// ------------------------------------------------------------------ Extended JSON (wire format between processes)
function toEJSON(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Date) return { $date: isNaN(v.getTime()) ? null : v.toISOString() };
  if (v instanceof ObjectId) return { $oid: v.hex };
  if (v instanceof Decimal128) return { $numberDecimal: v.value };
  if (Array.isArray(v)) return v.map(x => (x === undefined ? null : toEJSON(x)));
  if (typeof v === 'object') {
    if (typeof v.toHexString === 'function' && v._bsontype === 'ObjectId') return { $oid: v.toHexString() };
    const o = {};
    for (const k of Object.keys(v)) { const e = toEJSON(v[k]); if (e !== undefined) o[k] = e; }
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}
function fromEJSON(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(fromEJSON);
  const keys = Object.keys(v);
  if (keys.length === 1) {
    if (keys[0] === '$date') {
      const d = v.$date;
      if (d === null) return null;
      if (typeof d === 'object' && d.$numberLong) return new Date(Number(d.$numberLong));
      return new Date(d);
    }
    if (keys[0] === '$oid') return new ObjectId(v.$oid);
    if (keys[0] === '$numberDecimal') return new Decimal128(v.$numberDecimal);
    if (keys[0] === '$numberLong') return Number(v.$numberLong);
  }
  const o = {};
  for (const k of keys) o[k] = fromEJSON(v[k]);
  return o;
}

// ------------------------------------------------------------------ helpers
function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof ObjectId) return new ObjectId(v.hex);
  if (v instanceof Decimal128) return new Decimal128(v.value);
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}
function typeRank(v) {
  if (v === undefined || v === null) return 1;
  if (typeof v === 'number' || v instanceof Decimal128) return 2;
  if (typeof v === 'string') return 3;
  if (Array.isArray(v)) return 5;
  if (v instanceof ObjectId) return 7;
  if (typeof v === 'boolean') return 8;
  if (v instanceof Date) return 9;
  if (v instanceof RegExp) return 11;
  if (typeof v === 'object') return 4;
  return 12;
}
function scalar(v) {
  if (v instanceof Date) return v.getTime();
  if (v instanceof ObjectId) return v.hex;
  if (v instanceof Decimal128) return Number(v.value);
  return v;
}
function cmp(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 1) return 0;
  if (ra === 5) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  if (ra === 4) return cmp(JSON.stringify(toEJSON(a)), JSON.stringify(toEJSON(b)));
  const x = scalar(a), y = scalar(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
function eq(a, b) {
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  if (typeRank(a) !== typeRank(b)) return false;
  return cmp(a, b) === 0;
}
// values reachable at a dotted path (arrays expand); returns [] when missing
function getPath(doc, path) {
  const parts = path.split('.');
  let cur = [doc];
  for (const p of parts) {
    const next = [];
    for (const c of cur) {
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) {
        if (/^\d+$/.test(p)) { if (c[+p] !== undefined) next.push(c[+p]); }
        else for (const el of c) if (el && typeof el === 'object' && p in el) next.push(el[p]);
      } else if (typeof c === 'object' && p in c) next.push(c[p]);
    }
    cur = next;
  }
  return cur;
}
function getOne(doc, path) {
  const parts = path.split('.');
  let c = doc;
  for (const p of parts) { if (c === null || c === undefined || typeof c !== 'object') return undefined; c = c[p]; }
  return c;
}
function isOperatorObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof ObjectId) && !(v instanceof RegExp) &&
    Object.keys(v).length > 0 && Object.keys(v).every(k => k.startsWith('$'));
}

// ------------------------------------------------------------------ query matching
const inCache = new WeakMap();
function inSet(arg) {
  if (!Array.isArray(arg) || arg.length < 8) return null;
  if (inCache.has(arg)) return inCache.get(arg);
  let r = null;
  if (arg.every(a => a === null || typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean' || a instanceof Date || a instanceof ObjectId)) {
    r = { set: new Set(arg.map(valKey)), hasNull: arg.some(a => a === null) };
  }
  inCache.set(arg, r);
  return r;
}
function matchValueOp(values, op, arg, doc, path) {
  const any = fn => values.some(v => (Array.isArray(v) ? (fn(v) || v.some(fn)) : fn(v)));
  switch (op) {
    case '$eq': return values.length === 0 ? (arg === null) : any(v => eq(v, arg));
    case '$ne': return !(values.length === 0 ? (arg === null) : any(v => eq(v, arg)));
    case '$gt': return any(v => v !== null && v !== undefined && typeRank(v) === typeRank(arg) && cmp(v, arg) > 0);
    case '$gte': return any(v => v !== null && v !== undefined && typeRank(v) === typeRank(arg) && cmp(v, arg) >= 0);
    case '$lt': return any(v => v !== null && v !== undefined && typeRank(v) === typeRank(arg) && cmp(v, arg) < 0);
    case '$lte': return any(v => v !== null && v !== undefined && typeRank(v) === typeRank(arg) && cmp(v, arg) <= 0);
    case '$in': {
      const fast = inSet(arg);
      if (fast) return values.length === 0 ? fast.hasNull : values.some(v => (Array.isArray(v) ? v.some(x => fast.set.has(valKey(x))) || fast.set.has(valKey(v)) : fast.set.has(valKey(v))));
      return arg.some(a => (a instanceof RegExp ? any(v => typeof v === 'string' && a.test(v)) : (values.length === 0 ? a === null : any(v => eq(v, a)))));
    }
    case '$nin': return !arg.some(a => (values.length === 0 ? a === null : any(v => eq(v, a))));
    case '$exists': {
      const present = getPath(doc, path).length > 0;
      return arg ? present : !present;
    }
    case '$regex': {
      const re = arg instanceof RegExp ? arg : new RegExp(arg, '');
      return any(v => typeof v === 'string' && re.test(v));
    }
    case '$options': return true;
    case '$size': return values.some(v => Array.isArray(v) && v.length === arg);
    case '$all': return values.some(v => Array.isArray(v) && arg.every(a => v.some(x => eq(x, a))));
    case '$elemMatch': return values.some(v => Array.isArray(v) && v.some(el => (el && typeof el === 'object' && !isOperatorObject(arg) ? matches(el, arg) : matchCondition([el], arg, el, ''))));
    case '$not': return !matchCondition(values, arg, doc, path);
    case '$type': return true;
    default: throw new Error(`docdb: unsupported query operator ${op}`);
  }
}
function matchCondition(values, cond, doc, path) {
  if (cond instanceof RegExp) return values.some(v => (Array.isArray(v) ? v.some(x => typeof x === 'string' && cond.test(x)) : typeof v === 'string' && cond.test(v)));
  if (isOperatorObject(cond)) {
    for (const op of Object.keys(cond)) {
      let arg = cond[op];
      if (op === '$regex') arg = new RegExp(arg instanceof RegExp ? arg.source : arg, cond.$options || (arg instanceof RegExp ? arg.flags : ''));
      if (!matchValueOp(values, op, arg, doc, path)) return false;
    }
    return true;
  }
  // literal equality (array field matches element or whole array)
  if (values.length === 0) return cond === null;
  return values.some(v => eq(v, cond) || (Array.isArray(v) && v.some(x => eq(x, cond))));
}
function matches(doc, filter) {
  if (!filter) return true;
  for (const k of Object.keys(filter)) {
    const c = filter[k];
    if (k === '$and') { if (!c.every(f => matches(doc, f))) return false; continue; }
    if (k === '$or') { if (!c.some(f => matches(doc, f))) return false; continue; }
    if (k === '$nor') { if (c.some(f => matches(doc, f))) return false; continue; }
    if (k === '$comment') continue;
    if (k === '$expr') throw new Error('docdb: $expr not supported');
    if (!matchCondition(getPath(doc, k), c, doc, k)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ updates
function setPath(doc, path, value) {
  const parts = path.split('.');
  let c = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (c[p] === undefined || c[p] === null || typeof c[p] !== 'object') c[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    c = c[p];
  }
  c[parts[parts.length - 1]] = value;
}
function unsetPath(doc, path) {
  const parts = path.split('.');
  let c = doc;
  for (let i = 0; i < parts.length - 1; i++) { c = c[parts[i]]; if (c === undefined || c === null) return; }
  delete c[parts[parts.length - 1]];
}
function applyUpdate(doc, update, isInsert) {
  if (!isOperatorObject(update)) {             // replacement
    const id = doc._id;
    for (const k of Object.keys(doc)) delete doc[k];
    Object.assign(doc, clone(update));
    if (id !== undefined) doc._id = id;
    return;
  }
  // MongoDB parity: two operators may not touch the same path or a path and its prefix (error 40, ConflictingUpdateOperators)
  const touched = [];
  for (const op of Object.keys(update)) for (const path of Object.keys(update[op] || {})) {
    for (const t of touched) if (t === path || t.startsWith(path + '.') || path.startsWith(t + '.')) { const e = new Error(`docdb: Updating the path '${path}' would create a conflict at '${t}'`); e.code = 40; throw e; }
    touched.push(path);
  }
  for (const op of Object.keys(update)) {
    const spec = update[op];
    for (const path of Object.keys(spec)) {
      const val = spec[path];
      const cur = getOne(doc, path);
      switch (op) {
        case '$set': setPath(doc, path, clone(val)); break;
        case '$setOnInsert': if (isInsert) setPath(doc, path, clone(val)); break;
        case '$unset': unsetPath(doc, path); break;
        case '$inc': setPath(doc, path, (typeof cur === 'number' ? cur : 0) + val); break;
        case '$mul': setPath(doc, path, (typeof cur === 'number' ? cur : 0) * val); break;
        case '$min': if (cur === undefined || cmp(val, cur) < 0) setPath(doc, path, clone(val)); break;
        case '$max': if (cur === undefined || cmp(val, cur) > 0) setPath(doc, path, clone(val)); break;
        case '$currentDate': setPath(doc, path, new Date()); break;
        case '$push': {
          const arr = Array.isArray(cur) ? cur : [];
          if (val && typeof val === 'object' && '$each' in val) {
            arr.push(...val.$each.map(clone));
            if (typeof val.$slice === 'number') {
              const s = val.$slice;
              const sliced = s >= 0 ? arr.slice(0, s) : arr.slice(s);
              arr.length = 0; arr.push(...sliced);
            }
          } else arr.push(clone(val));
          setPath(doc, path, arr);
          break;
        }
        case '$addToSet': {
          const arr = Array.isArray(cur) ? cur : [];
          const items = val && typeof val === 'object' && '$each' in val ? val.$each : [val];
          for (const it of items) if (!arr.some(x => eq(x, it))) arr.push(clone(it));
          setPath(doc, path, arr);
          break;
        }
        case '$pull': {
          if (!Array.isArray(cur)) break;
          const keep = cur.filter(x => (isOperatorObject(val) ? !matchCondition([x], val, x, '') : (val && typeof val === 'object' && !(val instanceof Date) ? !matches(x, val) : !eq(x, val))));
          setPath(doc, path, keep);
          break;
        }
        default: throw new Error(`docdb: unsupported update operator ${op}`);
      }
    }
  }
}
function upsertSeed(filter) {
  const d = {};
  const walk = f => {
    for (const k of Object.keys(f || {})) {
      if (k === '$and') { f[k].forEach(walk); continue; }
      if (k.startsWith('$')) continue;
      const v = f[k];
      if (isOperatorObject(v)) { if ('$eq' in v) setPath(d, k, clone(v.$eq)); }
      else if (!(v instanceof RegExp)) setPath(d, k, clone(v));
    }
  };
  walk(filter);
  return d;
}

// ------------------------------------------------------------------ projection / sort
function project(doc, proj) {
  if (!proj || Object.keys(proj).length === 0) return clone(doc);
  const keys = Object.keys(proj).filter(k => k !== '_id');
  const inclusive = keys.some(k => proj[k]);
  if (inclusive && keys.some(k => !proj[k])) { const e = new Error(`docdb: Cannot do exclusion on field ${keys.find(k => !proj[k])} in inclusion projection`); e.code = 31254; throw e; }   // MongoDB parity
  if (inclusive) {
    const out = {};
    if (proj._id !== 0 && proj._id !== false && doc._id !== undefined) out._id = clone(doc._id);
    for (const k of keys) if (proj[k]) { const v = getOne(doc, k); if (v !== undefined) setPath(out, k, clone(v)); }
    return out;
  }
  const out = clone(doc);
  for (const k of Object.keys(proj)) if (!proj[k]) unsetPath(out, k);
  return out;
}
function sortDocs(docs, sort) {
  if (!sort) return docs;
  const entries = Array.isArray(sort) ? sort : Object.entries(sort);
  if (!entries.length) return docs;
  return docs.sort((a, b) => {
    for (const [k, dir] of entries) {
      const va = getOne(a, k), vb = getOne(b, k);
      const c = cmp(va, vb);
      if (c) return dir < 0 || dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

// ------------------------------------------------------------------ aggregation subset
function evalExpr(doc, e) {
  if (typeof e === 'string' && e.startsWith('$')) return getOne(doc, e.slice(1));
  if (e && typeof e === 'object' && !Array.isArray(e) && !(e instanceof Date)) {
    const ks = Object.keys(e);
    if (ks.length === 1 && ks[0].startsWith('$')) {
      const op = ks[0]; const a = e[op];
      const args = Array.isArray(a) ? a.map(x => evalExpr(doc, x)) : [evalExpr(doc, a)];
      switch (op) {
        case '$add': return args.reduce((s, x) => s + (x || 0), 0);
        case '$subtract': return (args[0] || 0) - (args[1] || 0);
        case '$multiply': return args.reduce((s, x) => s * (x || 0), 1);
        case '$divide': return args[1] ? args[0] / args[1] : null;
        case '$ifNull': return args[0] === null || args[0] === undefined ? args[1] : args[0];
        case '$toString': return args[0] === null || args[0] === undefined ? null : String(scalar(args[0]));
        case '$eq': return eq(args[0], args[1]);
        case '$cond': { const [c, t, f] = args; return c ? t : f; }
        default: throw new Error(`docdb: unsupported expression ${op}`);
      }
    }
    const o = {};
    for (const k of ks) o[k] = evalExpr(doc, e[k]);
    return o;
  }
  return e;
}
function aggregate(docs, pipeline) {
  let cur = docs.map(clone);
  for (const stage of pipeline) {
    const [op] = Object.keys(stage); const s = stage[op];
    if (op === '$match') cur = cur.filter(d => matches(d, s));
    else if (op === '$sort') cur = sortDocs(cur, s);
    else if (op === '$skip') cur = cur.slice(s);
    else if (op === '$limit') cur = cur.slice(0, s);
    else if (op === '$count') cur = [{ [s]: cur.length }];
    else if (op === '$project') cur = cur.map(d => {
      const out = {};
      for (const k of Object.keys(s)) {
        if (s[k] === 1 || s[k] === true) { const v = getOne(d, k); if (v !== undefined) setPath(out, k, v); }
        else if (s[k] === 0 || s[k] === false) continue;
        else setPath(out, k, evalExpr(d, s[k]));
      }
      if (s._id === undefined && d._id !== undefined) out._id = d._id;
      if (s._id === 0) delete out._id;
      return out;
    });
    else if (op === '$unwind') {
      const path = (typeof s === 'string' ? s : s.path).slice(1);
      const next = [];
      for (const d of cur) { const v = getOne(d, path); if (Array.isArray(v)) for (const el of v) { const c = clone(d); setPath(c, path, el); next.push(c); } }
      cur = next;
    } else if (op === '$group') {
      const groups = new Map();
      for (const d of cur) {
        const id = evalExpr(d, s._id);
        const key = JSON.stringify(toEJSON(id));
        if (!groups.has(key)) groups.set(key, { _id: id, __n: {}, __acc: {} });
        const g = groups.get(key);
        for (const f of Object.keys(s)) {
          if (f === '_id') continue;
          const [aop] = Object.keys(s[f]); const v = evalExpr(d, s[f][aop]);
          if (aop === '$sum') g.__acc[f] = (g.__acc[f] || 0) + (typeof v === 'number' ? v : 0);
          else if (aop === '$avg') { g.__acc[f] = (g.__acc[f] || 0) + (typeof v === 'number' ? v : 0); g.__n[f] = (g.__n[f] || 0) + (typeof v === 'number' ? 1 : 0); }
          else if (aop === '$min') { if (v !== null && v !== undefined && (g.__acc[f] === undefined || cmp(v, g.__acc[f]) < 0)) g.__acc[f] = v; }
          else if (aop === '$max') { if (v !== null && v !== undefined && (g.__acc[f] === undefined || cmp(v, g.__acc[f]) > 0)) g.__acc[f] = v; }
          else if (aop === '$first') { if (!(f in g.__acc)) g.__acc[f] = v; }
          else if (aop === '$last') g.__acc[f] = v;
          else if (aop === '$push') (g.__acc[f] = g.__acc[f] || []).push(v);
          else if (aop === '$addToSet') { g.__acc[f] = g.__acc[f] || []; if (!g.__acc[f].some(x => eq(x, v))) g.__acc[f].push(v); }
          else throw new Error(`docdb: unsupported accumulator ${aop}`);
        }
      }
      cur = [...groups.values()].map(g => {
        const out = { _id: g._id };
        for (const f of Object.keys(s)) if (f !== '_id') {
          const [aop] = Object.keys(s[f]);
          out[f] = aop === '$avg' ? (g.__n[f] ? g.__acc[f] / g.__n[f] : null) : (g.__acc[f] === undefined ? null : g.__acc[f]);
        }
        return out;
      });
    } else throw new Error(`docdb: unsupported aggregation stage ${op}`);
  }
  return cur;
}

// ------------------------------------------------------------------ collection with indexes
function idKey(id) {
  if (id instanceof ObjectId) return 'o:' + id.hex;
  if (id instanceof Date) return 'd:' + id.getTime();
  return 'v:' + JSON.stringify(toEJSON(id));
}
function valKey(v) { return v === undefined ? 'null' : JSON.stringify(toEJSON(v === undefined ? null : v)); }

class DuplicateKeyError extends Error {
  constructor(coll, index, keyValue) {
    super(`E11000 duplicate key error collection: ${coll} index: ${index.name} dup key: ${JSON.stringify(toEJSON(keyValue))}`);
    this.code = 11000; this.codeName = 'DuplicateKey'; this.keyPattern = Object.fromEntries(index.keys); this.keyValue = keyValue;
  }
}

// string interning: repeated short values (RUN_ID, EVENT_TYPE, sheet names ...) share one copy (memory only)
const internPool = new Map();
function intern(doc) {
  if (doc === null || typeof doc !== 'object' || doc instanceof Date || doc instanceof ObjectId) return doc;
  if (Array.isArray(doc)) { for (let i = 0; i < doc.length; i++) doc[i] = typeof doc[i] === 'string' ? internStr(doc[i]) : intern(doc[i]); return doc; }
  for (const k of Object.keys(doc)) { const v = doc[k]; doc[k] = typeof v === 'string' ? internStr(v) : intern(v); }
  return doc;
}
function internStr(v) {
  if (v.length > 48) return v;
  const e = internPool.get(v);
  if (e !== undefined) return e;
  if (internPool.size < 2000000) internPool.set(v, v);
  return v;
}

class Collection {
  constructor(name) {
    this.name = name;
    this.docs = new Map();
    this.indexes = [{ name: '_id_', keys: [['_id', 1]], unique: true, partial: null, map: new Map() }];
  }
  indexEntry(index, doc) {
    if (index.partial && !matches(doc, index.partial)) return null;
    const vals = index.keys.map(([k]) => { const v = getOne(doc, k); return v === undefined ? null : v; });
    return { key: vals.map(valKey).join('|'), value: Object.fromEntries(index.keys.map(([k], i) => [k, vals[i]])) };
  }
  createIndex(keys, opts = {}) {
    const kv = Array.isArray(keys) ? keys : Object.entries(keys);
    const name = opts.name || kv.map(([k, d]) => `${k}_${d}`).join('_');
    const existing = this.indexes.find(i => i.name === name);
    if (existing) return name;
    const index = { name, keys: kv, unique: !!opts.unique, partial: opts.partialFilterExpression || null, map: new Map() };
    for (const [id, doc] of this.docs) {
      const e = this.indexEntry(index, doc);
      if (!e) continue;
      if (index.unique && index.map.has(e.key) && index.map.get(e.key).size) throw new DuplicateKeyError(this.name, index, e.value);
      if (!index.map.has(e.key)) index.map.set(e.key, new Set());
      index.map.get(e.key).add(id);
    }
    this.indexes.push(index);
    return name;
  }
  dropIndexes() { this.indexes = this.indexes.slice(0, 1); }
  checkUnique(doc, excludeId) {
    for (const index of this.indexes) {
      if (!index.unique) continue;
      const e = this.indexEntry(index, doc);
      if (!e) continue;
      const s = index.map.get(e.key);
      if (s && [...s].some(id => id !== excludeId)) throw new DuplicateKeyError(this.name, index, e.value);
    }
  }
  addToIndexes(id, doc) {
    for (const index of this.indexes) {
      const e = this.indexEntry(index, doc);
      if (!e) continue;
      if (!index.map.has(e.key)) index.map.set(e.key, new Set());
      index.map.get(e.key).add(id);
    }
  }
  removeFromIndexes(id, doc) {
    for (const index of this.indexes) {
      const e = this.indexEntry(index, doc);
      if (!e) continue;
      const s = index.map.get(e.key);
      if (s) { s.delete(id); if (!s.size) index.map.delete(e.key); }
    }
  }
  insert(doc) {
    if (doc._id === undefined) doc._id = new ObjectId();
    intern(doc);
    const id = idKey(doc._id);
    if (this.docs.has(id)) throw new DuplicateKeyError(this.name, this.indexes[0], { _id: doc._id });
    this.checkUnique(doc, null);
    this.docs.set(id, doc);
    this.addToIndexes(id, doc);
    return id;
  }
  replaceStored(id, oldDoc, newDoc) {
    intern(newDoc);
    this.checkUnique(newDoc, id);
    this.removeFromIndexes(id, oldDoc);
    this.docs.set(id, newDoc);
    this.addToIndexes(id, newDoc);
  }
  remove(id) {
    const d = this.docs.get(id);
    if (!d) return;
    this.removeFromIndexes(id, d);
    this.docs.delete(id);
  }
  // candidate docs using an equality / $in index lookup when possible (falls back to a full scan)
  static eqValues(c) {
    if (c === undefined || c instanceof RegExp || Array.isArray(c)) return null;
    if (isOperatorObject(c)) {
      const ks = Object.keys(c);
      if (ks.length === 1 && ks[0] === '$eq') return Collection.eqValues(c.$eq);
      if (ks.length === 1 && ks[0] === '$in' && Array.isArray(c.$in) && c.$in.every(v => !(v instanceof RegExp) && !Array.isArray(v) && !(v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof ObjectId)))) return c.$in;
      return null;
    }
    if (c && typeof c === 'object' && !(c instanceof Date) && !(c instanceof ObjectId)) return null;
    return [c];
  }
  partialImplied(index, filter) {
    if (!index.partial) return true;
    return Object.keys(index.partial).every(f => {
      const pc = index.partial[f];
      if (!(pc && typeof pc === 'object' && pc.$exists === true && Object.keys(pc).length === 1)) return false;
      const vals = Collection.eqValues(filter[f]);
      return vals && vals.every(v => v !== null && v !== undefined);
    });
  }
  candidates(filter) {
    if (filter && filter._id !== undefined) {
      const vals = Collection.eqValues(filter._id);
      if (vals) {
        const out = [];
        for (const v of vals) { const id = idKey(v); const d = this.docs.get(id); if (d) out.push([id, d]); }
        return out;
      }
    }
    if (filter) {
      let best = null;
      for (const index of this.indexes) {
        if (!this.partialImplied(index, filter)) continue;
        const lists = [];
        for (const [k] of index.keys) { const v = Collection.eqValues(filter[k]); if (!v) break; lists.push(v); }
        if (lists.length !== index.keys.length) continue;
        const combos = lists.reduce((n, l) => n * l.length, 1);
        if (combos > 20000) continue;
        if (!best || index.keys.length > best.index.keys.length) best = { index, lists };
      }
      if (best) {
        let keys = [''];
        best.lists.forEach((l, i) => { const next = []; for (const pre of keys) for (const v of l) next.push(i ? pre + '|' + valKey(v) : valKey(v)); keys = next; });
        const ids = new Set();
        for (const k of keys) { const s = best.index.map.get(k); if (s) for (const id of s) ids.add(id); }
        return [...ids].map(id => [id, this.docs.get(id)]);
      }
      // prefix lookup on a single-field index
      for (const index of this.indexes) {
        if (index.partial || index.keys.length !== 1) continue;
        const v = Collection.eqValues(filter[index.keys[0][0]]);
        if (!v || v.length > 20000) continue;
        const ids = new Set();
        for (const x of v) { const s = index.map.get(valKey(x)); if (s) for (const id of s) ids.add(id); }
        return [...ids].map(id => [id, this.docs.get(id)]);
      }
    }
    return [...this.docs.entries()];
  }
  find(filter) { return this.candidates(filter).filter(([, d]) => matches(d, filter)); }
}

module.exports = { intern, ObjectId, Decimal128, toEJSON, fromEJSON, clone, matches, applyUpdate, upsertSeed, project, sortDocs, aggregate, Collection, DuplicateKeyError, idKey, getOne, cmp, eq };
