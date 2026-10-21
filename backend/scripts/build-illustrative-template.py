#!/usr/bin/env python3
"""Builds backend/config/templates/illustrative_tank_line.json from the CONFIGURATION collections of the synthetic seed bundle.

Only configuration is copied (work centres, stations, skills, equipment, materials/BOM, products, routes, crew and labour
standards, milestones, inspection checklists and synthetic limits, shift pattern, disposition policy). No workers, accounts,
orders, batches, tanks, attendance, events, inspections, points or other history is copied. Every document is marked
ILLUSTRATIVE / UNCONFIRMED: the numbers are the synthetic demonstration's assumptions, not Siemens values.

    python scripts/build-illustrative-template.py            (run from backend/)
"""
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "..", "data", "seed_bundle")
OUT = os.path.join(HERE, "..", "config", "templates", "illustrative_tank_line.json")
CONFIG = ["work_center_master", "workstation_master", "skill_master", "equipment_master", "equipment_operation_map", "material_master", "material_requirements",
          "product_master", "routing_operations", "route_dependencies", "crew_capacity_rules", "operation_skill_requirements", "milestone_definitions",
          "operation_instructions", "instruction_steps", "ctq_check_master", "ctq_specifications", "transfer_rules", "dispatch_rules"]
DROP = {"_id", "_seed", "_origin", "dataset_id", "SOURCE_FILE", "SOURCE_SHEET", "SOURCE_ROW"}


def load(name):
    p = os.path.join(BUNDLE, name + ".ndjson.gz")
    if not os.path.exists(p):
        sys.exit("missing %s - the seed bundle (backend/data/seed_bundle) is needed to rebuild the template" % p)
    with gzip.open(p, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def clean(d):
    return {k: v for k, v in d.items() if k not in DROP}


def main():
    out = {"TEMPLATE_ID": "ILLUSTRATIVE-TANK-LINE-v1", "TEMPLATE_VERSION": "1.0", "LABEL": "Illustrative transformer-tank line (UNCONFIRMED)",
           "WARNING": "Illustrative configuration taken from the synthetic demonstration. Work centres, standards, crew sizes, checklists and numeric limits are "
                      "synthetic assumptions - NOT Siemens values and NOT confirmed by the client. Review and confirm every item before relying on it. "
                      "Contains configuration only: no workers, orders, batches, tanks or history.",
           "collections": {}}
    for c in CONFIG:
        out["collections"][c] = [clean(d) for d in load(c)]
    pol = [clean(d) for d in load("disposition_policies") if d.get("POLICY_ID") == "DEFAULT_REPAIRABLE_RETURN_V1"]
    out["collections"]["disposition_policies"] = pol
    out["collections"]["disposition_matrix"] = [clean(d) for d in load("disposition_matrix") if d.get("POLICY_ID") == "DEFAULT_REPAIRABLE_RETURN_V1"]
    # the dated shift calendar becomes two reusable shift templates (every day) with the same breaks per work centre
    out["collections"]["shift_templates"] = [
        {"SHIFT_CODE": "A", "SHIFT_NAME": "Shift A (day)", "START_LOCAL": "06:00", "END_LOCAL": "14:30", "DAYS_OF_WEEK": [1, 2, 3, 4, 5, 6, 7],
         "BREAKS": [{"START_LOCAL": "10:00", "END_LOCAL": "10:30", "RESOURCE_IDS": ["WC1", "WC2"]}, {"START_LOCAL": "10:30", "END_LOCAL": "11:00", "RESOURCE_IDS": ["WC3", "WC4"]},
                    {"START_LOCAL": "10:15", "END_LOCAL": "10:45", "RESOURCE_IDS": ["SUPPORT"]}]},
        {"SHIFT_CODE": "B", "SHIFT_NAME": "Shift B (late)", "START_LOCAL": "14:30", "END_LOCAL": "23:00", "DAYS_OF_WEEK": [1, 2, 3, 4, 5, 6, 7],
         "BREAKS": [{"START_LOCAL": "18:30", "END_LOCAL": "19:00", "RESOURCE_IDS": ["WC1", "WC2"]}, {"START_LOCAL": "19:00", "END_LOCAL": "19:30", "RESOURCE_IDS": ["WC3", "WC4"]},
                    {"START_LOCAL": "18:45", "END_LOCAL": "19:15", "RESOURCE_IDS": ["SUPPORT"]}]}]
    for docs in out["collections"].values():
        for d in docs:
            d["ILLUSTRATIVE"] = True
            d["CONFIRMATION_STATUS"] = "UNCONFIRMED"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=0, sort_keys=True, default=str)
    print("wrote %s (%s)" % (OUT, ", ".join("%s %d" % (k, len(v)) for k, v in out["collections"].items())))


if __name__ == "__main__":
    main()
