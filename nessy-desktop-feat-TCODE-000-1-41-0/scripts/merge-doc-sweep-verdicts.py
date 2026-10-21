#!/usr/bin/env python3
"""Merge the per-finding challenger verdicts into one phase-2 dataset.

Each challenger writes its own `<id>.json` the moment it reaches a verdict, so a
stopped run keeps everything it had already decided. This script folds those
files back onto the phase-1 findings and reports the three states separately.

"Unchallenged" is its own state. It is never folded in with "confirmed": in the
one series that measured it, unchallenged turned out to mean probably wrong.
"""

import json
import os
import sys

SPECS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "superpowers", "specs")
DATA = os.path.join(SPECS, "data")
VDIR = os.path.join(DATA, "phase2-verdicts")
PHASE1 = os.path.join(DATA, "2026-07-31-doc-sweep-phase1.json")
OUT = os.path.join(DATA, "2026-07-31-doc-sweep-phase2.json")


def main() -> int:
    phase1 = json.load(open(PHASE1))
    flagged = phase1["flagged"]

    verdicts, malformed = {}, []
    for name in sorted(os.listdir(VDIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(VDIR, name)
        try:
            v = json.load(open(path))
        except json.JSONDecodeError as exc:
            malformed.append((name, str(exc)))
            continue
        if "refuted" not in v:
            malformed.append((name, "no 'refuted' key"))
            continue
        verdicts[v.get("id") or name[:-5]] = v

    results, unchallenged = [], []
    for i, f in enumerate(flagged):
        fid = "f%03d" % i
        row = dict(f, id=fid)
        v = verdicts.get(fid)
        if v is None:
            unchallenged.append(row)
            continue
        row["verdict"] = {
            "refuted": bool(v["refuted"]),
            "why": v.get("why", ""),
            "correctedState": v.get("correctedState", ""),
            "source": v.get("source", "phase2-rest"),
        }
        results.append(row)

    survived = [r for r in results if not r["verdict"]["refuted"]]
    refuted = [r for r in results if r["verdict"]["refuted"]]

    json.dump(
        {
            # A verdict's line numbers are a DATED MEASUREMENT, not a live
            # pointer. Every one was taken against the doc fetch and the source
            # tree of `measuredAgainst`, and both have moved since — page numbers
            # and source-file numbers alike. They are deliberately never re-hung:
            # renumbering a dated verdict onto a later fetch turns a record of
            # what was measured into a claim nobody made. The identifier is the
            # quoted sentence or the named symbol; re-measure and stamp your own
            # date if you need a number that lands.
            "citationsAreDated": True,
            "measuredAgainst": phase1.get("generatedAt"),
            "raised": len(flagged),
            "challenged": len(results),
            "survived": len(survived),
            "refuted": len(refuted),
            "unchallenged": len(unchallenged),
            "malformed": [{"file": n, "error": e} for n, e in malformed],
            "results": results,
            "unchallengedFindings": unchallenged,
        },
        open(OUT, "w"),
        ensure_ascii=False,
        indent=1,
    )

    print(f"raised       {len(flagged)}")
    print(f"challenged   {len(results)}")
    print(f"  survived   {len(survived)}")
    print(f"  refuted    {len(refuted)}")
    print(f"unchallenged {len(unchallenged)}  <- separate state, never folded into survived")
    if malformed:
        print(f"malformed    {len(malformed)}")
        for n, e in malformed:
            print(f"  {n}: {e}")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
