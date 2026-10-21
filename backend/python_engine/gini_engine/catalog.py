"""Master / configuration data read from the seeded collections (plus application-created workers)."""
import time
from collections import defaultdict

ROUTE_FALLBACK = ["OP10", "QG10", "OP20", "QG20", "OP30", "OP31", "QG30", "OP40", "QG40"]


class Catalog:
    TTL = 60

    def __init__(self, db, dataset_id="GINI-SYN-TANKS", fresh=False):
        self.db = db
        self.ds = dataset_id
        self.fresh = fresh              # fresh factory: no synthetic route fallback, configured work centres / timezone
        self.loaded_at = 0
        self.load()

    def _all(self, coll, flt=None):
        f = {"dataset_id": self.ds}
        f.update(flt or {})
        return list(self.db[coll].find(f, {"_seed": 0}))

    def load(self):
        self.routing = self._all("routing_operations")
        self.route_deps = self._all("route_dependencies")
        self.crew_rules = self._all("crew_capacity_rules")
        self.wcs = {w["WORK_CENTER_ID"]: w for w in self._all("work_center_master")}
        self.stations = {w["WORKSTATION_ID"]: w for w in self._all("workstation_master")}
        self.equipment = {e["EQUIPMENT_ID"]: e for e in self._all("equipment_master")}
        self.skills = {s["SKILL_ID"]: s for s in self._all("skill_master")}
        self.op_skills = self._all("operation_skill_requirements")
        self.ctq = {c["CHECK_ID"]: c for c in self._all("ctq_check_master")}
        self.specs = self._all("ctq_specifications")
        self.milestones = sorted(self._all("milestone_definitions"), key=lambda m: (m["OPERATION_ID"], m.get("INSTRUCTION_TYPE") or "", m["SEQUENCE_NO"]))
        self.instructions = {i["INSTRUCTION_VERSION_ID"]: i for i in self._all("operation_instructions")}
        self.transfer_rules = self._all("transfer_rules")
        # recorded calendar + the synthetic continuation after the last recorded day (continuation.py, ASM-APP-CAL-01)
        self.calendar = self._all("calendar_intervals") + self._all("continuation_calendar_intervals")
        self.shifts = {s["SHIFT_ID"]: s for s in self._all("shift_calendar") + self._all("continuation_shift_calendar")}
        self.products = {p["PRODUCT_ID"]: p for p in self._all("product_master")}
        self.disp_matrix = self._all("disposition_matrix")
        self.policies = {p["POLICY_ID"]: p for p in self._all("disposition_policies")}
        self.materials = {m["MATERIAL_ID"]: m for m in self._all("material_master")}
        self.mat_reqs = self._all("material_requirements")
        self.run_catalog = {r["RUN_ID"]: r for r in self._all("run_catalog")}
        self.config = {r["PARAMETER"]: r["VALUE"] for r in self._all("config")}
        # workers include application-created people (_origin APP); seeded rows carry dataset_id too
        self.workers = {w["WORKER_ID"]: w for w in self.db.worker_master.find({"dataset_id": self.ds}, {"_seed": 0})}
        self.quals = defaultdict(list)
        for q in self.db.worker_qualifications.find({"dataset_id": self.ds}, {"_seed": 0}):
            self.quals[q["WORKER_ID"]].append(q)
        self._route_cache = {}
        self.factory = self.db.factory_settings.find_one({"dataset_id": self.ds}) if self.fresh else None
        if self.factory and self.factory.get("TIMEZONE"):
            from .timeutil import set_plant_tz
            set_plant_tz(self.factory["TIMEZONE"])
        from . import variance
        variance.configure(self, fresh=self.fresh)
        self.loaded_at = time.time()

    def _stamp(self):
        try:
            d = self.db.catalog_stamp.find_one({"_id": self.ds})
            return (d or {}).get("N")
        except Exception:
            return None

    def refresh_if_stale(self):
        # reload after the TTL, or at once when the API reports a master-data change (new worker, qualification, configuration)
        stamp = self._stamp()
        if time.time() - self.loaded_at > self.TTL or stamp != getattr(self, "stamp", None):
            self.load()
            self.stamp = stamp

    # ---------------------------------------------------------------- route
    def route(self, product):
        if product in self._route_cache:
            return self._route_cache[product]
        ops = sorted([r for r in self.routing if r["PRODUCT_ID"] == product], key=lambda r: r["SEQUENCE_NO"] if r.get("SEQUENCE_NO") is not None else 0)
        seq = [r["OPERATION_ID"] for r in ops]
        if not seq and not self.fresh:
            seq = list(ROUTE_FALLBACK)
        self._route_cache[product] = seq
        return seq

    def op(self, product, op_id):
        for r in self.routing:
            if r["PRODUCT_ID"] == product and r["OPERATION_ID"] == op_id:
                return r
        for r in self.routing:
            if r["OPERATION_ID"] == op_id:
                return r
        return None

    def next_op(self, product, op_id):
        seq = self.route(product)
        if op_id not in seq:
            return None
        i = seq.index(op_id)
        return seq[i + 1] if i + 1 < len(seq) else "ROUTE_END"

    def transfer_min(self, pred, succ):
        for d in self.route_deps:
            if d["PREDECESSOR_OPERATION_ID"] == pred and d["SUCCESSOR_OPERATION_ID"] == succ:
                return float(d.get("TRANSFER_MIN") or 0)
        return 0.0

    def elapsed_for_crew(self, product, op_id, crew):
        """standard elapsed minutes per unit for the qualified crew count (CREW_CAPACITY_RULES); None below minimum."""
        rows = sorted([r for r in self.crew_rules if r["PRODUCT_ID"] == product and r["OPERATION_ID"] == op_id], key=lambda r: r["QUALIFIED_CREW_COUNT"])
        if not rows:
            o = self.op(product, op_id)
            if not o:
                return None
            if (o.get("OPERATION_KIND") or "") != "LABOR":
                return float(o.get("STANDARD_ELAPSED_MIN") or 0)
            if crew < (o.get("MIN_CREW_SIZE") or 1):
                return None
            return float(o["STANDARD_LABOR_MIN"]) / max(1, min(crew, o.get("MAX_CREW_SIZE") or crew))
        if crew < rows[0]["QUALIFIED_CREW_COUNT"]:
            return None
        best = rows[0]
        for r in rows:
            if r["QUALIFIED_CREW_COUNT"] <= crew:
                best = r
        return float(best["ELAPSED_MIN_PER_UNIT"])

    def gate_of_wc(self, wc):
        for r in self.routing:
            if r["WORK_CENTER_ID"] == wc and r.get("OPERATION_KIND") == "INSPECTION":
                return r["OPERATION_ID"]
        return None

    def labor_op_of_gate(self, product, gate):
        seq = self.route(product)
        i = seq.index(gate)
        for j in range(i - 1, -1, -1):
            o = self.op(product, seq[j])
            if o and o.get("OPERATION_KIND") == "LABOR":
                return seq[j]
        return None

    # ---------------------------------------------------------------- people
    def qualified(self, worker_id, skill_id, at):
        if not skill_id:
            return True
        for q in self.quals.get(worker_id, []):
            if q["SKILL_ID"] != skill_id or q.get("QUALIFICATION_STATUS") not in ("VALID", None):
                continue
            vf, vt = q.get("VALID_FROM"), q.get("VALID_TO")
            if (vf is None or vf <= at) and (vt is None or vt >= at):
                return True
        return False

    def can_work_independently(self, worker_id, skill_id, at):
        for q in self.quals.get(worker_id, []):
            if q["SKILL_ID"] == skill_id and q.get("CAN_WORK_INDEPENDENTLY") == "Y" and (q.get("VALID_TO") is None or q["VALID_TO"] >= at):
                return True
        return False

    def stations_of(self, wc):
        return sorted([s for s in self.stations.values() if s.get("WORK_CENTER_ID") == wc and s.get("WORKSTATION_TYPE") not in ("CURE_ZONE", "HOLD_AREA")], key=lambda s: s["WORKSTATION_ID"])

    def breaks_for(self, shift_id, wc):
        return [c for c in self.calendar if c.get("SHIFT_ID") == shift_id and c.get("RESOURCE_ID") == wc and c.get("INTERVAL_TYPE") == "PLANNED_BREAK"]

    def milestones_for(self, op_id, instruction_type="STANDARD"):
        ms = [m for m in self.milestones if m["OPERATION_ID"] == op_id and (m.get("INSTRUCTION_TYPE") or "STANDARD") == instruction_type]
        if not ms and instruction_type != "STANDARD":
            ms = [m for m in self.milestones if m["OPERATION_ID"] == op_id and (m.get("INSTRUCTION_TYPE") or "STANDARD") == "STANDARD"]
        return sorted(ms, key=lambda m: m["SEQUENCE_NO"])

    def disposition(self, policy_id, gate, defect_code):
        rows = [m for m in self.disp_matrix if m["POLICY_ID"] == policy_id]
        for m in rows:
            if m["DETECTION_POINT"] == gate and m["DEFECT_CODE"] == defect_code:
                return m
        for m in rows:
            if m["DETECTION_POINT"] in (gate, "ANY") and m["DEFECT_CODE"] in ("ANY", "*"):
                return m
        return None
