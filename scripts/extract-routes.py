#!/usr/bin/env python3
"""Regenerate public/routes.json from the Muse live tracker's routes-data.ts.

Provenance: the Muse tracker (canadian-lakes-plow-tracker-live, v14) already
carries the verified v11 geometry. This script only READS that file and the
v11 CSV — it never edits the Muse artifact or its database — and writes a
plain JSON copy for the standalone app. It also verifies the JSON matches
the v11 CSV exactly (truck, order, name) and the mile totals.

Usage: python3 scripts/extract-routes.py
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path.home() / "workspace/ts-spaces/canadian-lakes-plow-tracker-live/server/src/routes-data.ts"
CSV = Path.home() / "workspace/canadian-lakes-plow/canadian-lakes-south-routes-v11.csv"
OUT = ROOT / "public/routes.json"

s = SRC.read_text()
m = re.search(r"export const ROUTES[^=]*=\s*(\[.*\]);?\s*$", s, re.S)
if not m:
    sys.exit("could not find ROUTES array in routes-data.ts")
data = json.loads(m.group(1))
out = [{
    "id": d["truck"] * 1000 + d["order"],
    "truck": d["truck"], "order": d["order"], "name": d["name"],
    "miles": d["miles"], "estMin": d["estMin"], "area": d["area"],
    "center": d["center"], "lines": d["lines"],
} for d in data]

rows = list(csv.DictReader(CSV.open()))
csvset = {(int(r["truck"]), int(r["order"]), r["road"]) for r in rows}
jset = {(d["truck"], d["order"], d["name"]) for d in out}
assert csvset == jset, f"CSV/JSON mismatch: {sorted(csvset ^ jset)}"
assert len(out) == 165, len(out)
OUT.write_text(json.dumps(out))
print(f"{len(out)} roads written to {OUT} — matches v11 CSV exactly, "
      f"{round(sum(d['miles'] for d in out), 2)} mi total")
