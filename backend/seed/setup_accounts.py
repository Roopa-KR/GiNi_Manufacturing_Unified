#!/usr/bin/env python3
"""Explicit application-setup command: create login accounts for every seeded person (and one admin) in MongoDB.

    DEMO_PIN_SEED=... ADMIN_LOGIN=admin ADMIN_PASSWORD=... python3 setup_accounts.py --dataset-id GINI-SYN-TANKS --guide demo_accounts.csv

PIN hashes (scrypt$16384$8$1$<salt hex>$<digest hex>, per-account salt) exist only in the `accounts` collection - never in Excel,
the seed bundle or the browser bundle. Insert-only: re-running never resets a PIN, status or role.
Roles come from the explicit WORKER_ROLE -> role table in contracts/permissions.json (no substring matching); people with an
unknown WORKER_ROLE get no account and are listed.

Local credential helper (refused when NODE_ENV/APP_ENV is production; needs the same DEMO_PIN_SEED; prints to the terminal only):
    python3 setup_accounts.py --dataset-id GINI-SYN-TANKS --show-pin-for W0042 [--show-pin-for W0107 ...]
    python3 setup_accounts.py --dataset-id GINI-SYN-TANKS --show-local-pins        # first 10 people of each role
PINs are text: a derived PIN such as 004217 keeps its leading zeros.
"""
import argparse, csv, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import seedlib as L, seedops as O

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--dataset-id", required=True)
ap.add_argument("--guide", default="demo_accounts.csv")
ap.add_argument("--show-local-pins", action="store_true", help="print local demo PINs for the first 10 people of each role")
ap.add_argument("--show-pin-for", action="append", default=[], metavar="WORKER_ID", help="print the local demo PIN for an explicitly selected worker (repeatable)")
ap.add_argument("--migrate-roles", action="store_true", help="rewrite roles of setup-created accounts whose role is unknown to contracts/permissions.json")
a = ap.parse_args()

seed = os.environ.get("DEMO_PIN_SEED")
if a.show_pin_for or a.show_local_pins:
    if "production" in (os.environ.get("NODE_ENV", "") + os.environ.get("APP_ENV", "")).lower():
        sys.exit("refusing to print PINs when NODE_ENV/APP_ENV is production")
    if not seed:
        sys.exit("DEMO_PIN_SEED is required to derive local demo PINs")

made, guide, unmapped, migrated = O.setup_accounts(L.open_store("mongodb"), a.dataset_id, seed, os.environ.get("ADMIN_LOGIN"), os.environ.get("ADMIN_PASSWORD"), a.migrate_roles)
if guide:
    with open(a.guide, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(guide[0].keys())); w.writeheader(); w.writerows(guide)
print(f"accounts created: {made}; roles migrated: {migrated}; guide: {a.guide} ({len(guide)} people, no PINs)")
for wid, role in unmapped:
    print(f"NO ACCOUNT: {wid} has WORKER_ROLE {role!r} which is not in contracts/permissions.json worker_role_map")
if a.show_pin_for:
    by = {g["login_id"]: g for g in guide}
    for wid in a.show_pin_for:
        wid = wid.strip().upper()
        if wid not in by:
            print(f"{wid}: no seeded account (unknown worker or unmapped role)")
            continue
        print(f"{wid}\t{by[wid]['display_name']}\t{by[wid]['app_role']}\tPIN {O.demo_pin(seed, wid)}")
if a.show_local_pins:
    seen = {}
    for g in guide:
        if seen.get(g["app_role"], 0) < 10:
            seen[g["app_role"]] = seen.get(g["app_role"], 0) + 1
            print(f"{g['login_id']}\t{g['app_role']:<18}\t{g['display_name']}\tPIN {O.demo_pin(seed, g['login_id'])}")
    print("... use --show-pin-for <WORKER_ID> for anyone else")
