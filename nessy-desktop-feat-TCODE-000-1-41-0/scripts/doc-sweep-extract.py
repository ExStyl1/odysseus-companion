#!/usr/bin/env python3
"""Print one slice of the doc-sweep dataset as JSON, for an agent to read.

The findings and their verdicts are large enough that embedding them in a
workflow script blows the script-size limit. They are already on disk, so the
agents read them from here instead.

Usage:
  python3 scripts/doc-sweep-extract.py refuted    # the killed findings + why
  python3 scripts/doc-sweep-extract.py worklist   # the survivors + their specs
"""

import json
import os
import sys

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                    "docs", "superpowers", "specs", "data")
P2 = os.path.join(DATA, "2026-07-31-doc-sweep-phase2.json")
SDIR = os.path.join(DATA, "phase25-specs")


def main():
    mode = sys.argv[1]
    results = json.load(open(P2))["results"]

    if mode == "refuted":
        out = [{"page": r["slug"], "claim": r["claim"], "why": r["verdict"]["why"]}
               for r in results if r["verdict"]["refuted"]]
    elif mode == "worklist":
        specs = {}
        for n in sorted(os.listdir(SDIR)):
            if n.endswith(".json"):
                s = json.load(open(os.path.join(SDIR, n)))
                specs[s.get("id") or n[:-5]] = s
        out = []
        for r in results:
            if r["verdict"]["refuted"]:
                continue
            s = specs.get(r["id"], {})
            out.append({
                "id": r["id"], "page": r["slug"], "kind": s.get("kind", ""),
                "subsystem": s.get("subsystem", ""),
                "divergence": s.get("divergence", r["claim"]),
                "files": [c["file"] for c in s.get("change", [])],
                "blastRadius": s.get("blastRadius", ""),
                "userImpact": s.get("userImpact", ""),
                "effort": s.get("effort", ""),
            })
    else:
        sys.exit(f"unknown mode {mode!r}")

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
