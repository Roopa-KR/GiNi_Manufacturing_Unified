"""Minimal in-memory stand-in for the pymongo calls used by alerts.py and calc.publish (find, find_one, insert_one/many, update_one,
find_one_and_update, delete_many, count_documents; $set/$inc/$max on dotted paths)."""
import copy
from pymongo.errors import DuplicateKeyError


def _match(d, f):
    for k, v in (f or {}).items():
        if k == "$or":
            if not any(_match(d, x) for x in v):
                return False
            continue
        cur = d
        for p in k.split("."):
            cur = cur.get(p) if isinstance(cur, dict) else None
        if isinstance(v, dict) and any(str(x).startswith("$") for x in v):
            for op, arg in v.items():
                if op == "$in" and cur not in arg: return False
                if op == "$nin" and cur in arg: return False
                if op == "$ne" and cur == arg: return False
                if op == "$exists" and (cur is not None) != arg: return False
                if op == "$lte" and not (cur is not None and cur <= arg): return False
                if op == "$gte" and not (cur is not None and cur >= arg): return False
                if op == "$lt" and not (cur is not None and cur < arg): return False
                if op == "$gt" and not (cur is not None and cur > arg): return False
        elif cur != v:
            return False
    return True


class Result:
    def __init__(self, matched=0, modified=0, upserted=None):
        self.matched_count, self.modified_count, self.upserted_id = matched, modified, upserted


class Coll:
    def __init__(self, unique=None):
        self.docs, self.unique = [], unique or []

    def find(self, f=None, proj=None, sort=None):
        return [copy.deepcopy(d) for d in self.docs if _match(d, f)]

    def find_one(self, f=None, proj=None, sort=None):
        rows = self.find(f)
        if sort:
            k, direction = sort[0]
            rows.sort(key=lambda d: d.get(k), reverse=direction < 0)
        return rows[0] if rows else None

    def count_documents(self, f=None, **kw):
        return len(self.find(f))

    def insert_one(self, d):
        for key in self.unique:
            if d.get(key) is not None and any(x.get(key) == d.get(key) for x in self.docs):
                raise DuplicateKeyError("duplicate %s" % key)
        self.docs.append(copy.deepcopy(d))

    @staticmethod
    def _get(d, path):
        for p in path.split("."):
            d = d.get(p) if isinstance(d, dict) else None
        return d

    @staticmethod
    def _set(d, path, v):
        parts = path.split(".")
        for p in parts[:-1]:
            d = d.setdefault(p, {})
        d[parts[-1]] = v

    def _apply(self, d, upd):
        for k, v in upd.get("$set", {}).items():
            self._set(d, k, v)
        for k, v in upd.get("$inc", {}).items():
            self._set(d, k, (self._get(d, k) or 0) + v)
        for k, v in upd.get("$max", {}).items():
            cur = self._get(d, k)
            if cur is None or v > cur:
                self._set(d, k, v)

    def insert_many(self, docs, ordered=True):
        for d in docs:
            self.insert_one(d)

    def delete_many(self, f):
        before = len(self.docs)
        self.docs = [d for d in self.docs if not _match(d, f)]
        return Result(before - len(self.docs), before - len(self.docs))

    def find_one_and_update(self, f, upd, return_document=None, **kw):
        for d in self.docs:
            if _match(d, f):
                self._apply(d, upd)
                return copy.deepcopy(d)
        return None

    def update_one(self, f, upd, upsert=False):
        for d in self.docs:
            if _match(d, f):
                self._apply(d, upd)
                return Result(1, 1)
        if upsert:
            nd = {k: v for k, v in f.items() if not str(k).startswith("$")}
            nd.update(upd.get("$setOnInsert", {}))
            nd.update(upd.get("$set", {}))
            self.docs.append(nd)
            return Result(0, 0, "new")
        return Result(0, 0)


class FakeDB:
    def __init__(self):
        self.c = {"notifications": Coll(unique=["DEDUP_KEY"])}

    def __getattr__(self, name):
        if name == "c":
            raise AttributeError
        return self.c.setdefault(name, Coll())

    def __getitem__(self, name):
        return getattr(self, name)
