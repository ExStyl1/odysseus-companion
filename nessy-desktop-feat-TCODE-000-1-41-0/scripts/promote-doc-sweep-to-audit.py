#!/usr/bin/env python3
"""Promote the doc sweep's surviving findings into the parity audit.

The sweep's own two files stay the detail; the audit gets what it is for — the
queue. Each proposed plan unit becomes one row in §A with an R-number, and §5f
records the method, the counts and the dependency order behind those rows.

Numbers are assigned in dependency order, so a unit always sorts after the units
it depends on. Ord is left blank on purpose: the legend reads blank as "no
execution position", and position is the owner's call, not a sweep's.

Idempotent — refuses to run twice.

Usage: python3 scripts/promote-doc-sweep-to-audit.py
"""

import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SPECS = os.path.join(HERE, "..", "docs", "superpowers", "specs")
AUDIT = os.path.join(SPECS, "2026-07-25-nessy-claude-parity-audit.md")
DATA = os.path.join(SPECS, "data")
P2 = os.path.join(DATA, "2026-07-31-doc-sweep-phase2.json")
SDIR = os.path.join(DATA, "phase25-specs")
ANALYSIS = os.path.join(DATA, "phase3-analysis.json")

FIRST_R = 31
MARKER = "## 5f. Full read of all 174 pages"
GAP = {"not-built": "build", "built-wrong": "wiring", "built-partial": "wiring"}


def esc(s):
    return " ".join(str(s or "").split()).replace("|", "\\|")


def clip(s, n):
    s = esc(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def order_units(units):
    """Dependency order; a cycle or a dangling name falls back to input order."""
    by_name = {u["name"]: u for u in units}
    done, out = set(), []
    remaining = list(units)
    while remaining:
        ready = [u for u in remaining
                 if all(d in done or d not in by_name for d in u.get("dependsOn", []))]
        if not ready:                      # cycle — emit the rest as-is
            out.extend(remaining)
            break
        for u in ready:
            out.append(u)
            done.add(u["name"])
        remaining = [u for u in remaining if u["name"] not in done]
    return out


def main():
    audit = open(AUDIT).read()
    if MARKER in audit:
        sys.exit("§5f already present — nothing to do")

    p2 = json.load(open(P2))
    analysis = json.load(open(ANALYSIS))
    specs = {}
    for n in sorted(os.listdir(SDIR)):
        if n.endswith(".json"):
            s = json.load(open(os.path.join(SDIR, n)))
            specs[s.get("id") or n[:-5]] = s

    results = {r["id"]: r for r in p2["results"]}
    survived = [r for r in p2["results"] if not r["verdict"]["refuted"]]
    refuted = [r for r in p2["results"] if r["verdict"]["refuted"]]

    units = order_units(analysis["units"])
    rnum = {u["name"]: f"R{FIRST_R + i}" for i, u in enumerate(units)}

    # ---- §A rows -----------------------------------------------------------
    rows = []
    for u in units:
        kinds = Counter(specs[f]["kind"] for f in u["findings"] if f in specs)
        gap = GAP.get(kinds.most_common(1)[0][0], "build") if kinds else "build"
        pages = sorted({results[f]["slug"] for f in u["findings"] if f in results})
        deps = ", ".join(rnum[d] for d in u.get("dependsOn", []) if d in rnum)
        kind_note = ", ".join(f"{v}×{k}" for k, v in kinds.most_common())
        rows.append(
            f"|  | **{rnum[u['name']]}** | ⬜ | **{clip(u['title'], 150)}** "
            f"· {clip(u['why'], 260)} | **{clip(', '.join(pages), 110)}** | {gap} "
            f"| queued — doc sweep 2026-08-02, {u.get('effort', '?')}"
            + (f", after {deps}" if deps else "")
            + f" | {kind_note}; findings {', '.join(u['findings'])}; "
              f"spec in `2026-08-02-claude-doc-sweep-worklist.md` |"
        )

    lines = audit.split("\n")
    end = max(i for i, l in enumerate(lines[:800]) if l.startswith("| ") or l.startswith("|  |"))
    lines[end + 1: end + 1] = rows
    audit = "\n".join(lines)

    # ---- §5f ---------------------------------------------------------------
    kinds = Counter(specs[r["id"]]["kind"] for r in survived if r["id"] in specs)
    subs = Counter(specs[r["id"]]["subsystem"] for r in survived if r["id"] in specs)

    sec = [
        MARKER + " (2026-08-02)",
        "",
        "§5e's sweep triaged most pages by title and **never opened the 18 `whats-new/*`",
        "pages**; it said so in its own depth caveat. This one read all 174 in full, by",
        "`curl -sL <url>.md`, and raised **" + str(p2["raised"]) + "** findings of bug/gap level.",
        "",
        "**Every finding was then handed to an independent challenger told to refute it**,",
        "and the challengers killed **" + str(len(refuted)) + " of " + str(p2["raised"]) +
        "** — 49%, a rate that held steady across",
        "three separately-run batches rather than decaying, so it is the corpus and not a",
        "bad first batch. Promoting the raw findings would have doubled this queue with",
        "work that does not exist. The kinds of mistake are catalogued in the divergence",
        "file; the three that recur are a quote cut where its second half reverses the",
        "conclusion, an identifier that really is unwired whose consequence is already",
        "handled upstream, and a recorded owner decision read as a defect.",
        "",
        "**" + str(len(survived)) + " survived**, each then read back off the code and classified:",
        "**" + str(kinds["not-built"]) + " not built**, **" + str(kinds["built-partial"]) +
        " built narrower than specified**, **" + str(kinds["built-wrong"]) + " built with behaviour that",
        "contradicts the page**. Leading subsystems: " +
        ", ".join(f"`{k}` {v}" for k, v in subs.most_common(6)) + ".",
        "",
        "`permissions` is the one subsystem where *built-wrong* outnumbers *not-built*.",
        "That is the expensive shape: the mechanism is there and users already rely on it,",
        "so the divergence is silently wrong rather than visibly missing.",
        "",
        "The " + str(len(units)) + " units below are **R" + str(FIRST_R) + "–R" +
        str(FIRST_R + len(units) - 1) + "** in §A, numbered in dependency order.",
        "`Ord` is deliberately blank on all of them — execution position is an owner",
        "decision, and this sweep has no standing to renumber the existing queue.",
        "",
        "| Unit | R | What it closes | Findings | After | Effort |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for u in units:
        deps = ", ".join(rnum[d] for d in u.get("dependsOn", []) if d in rnum) or "—"
        sec.append(f"| `{u['name']}` | {rnum[u['name']]} | {clip(u['title'], 90)} "
                   f"| {len(u['findings'])} | {deps} | {u.get('effort', '?')} |")
    sec += [
        "",
        "**Effort is ordinal here, not a estimate.** The classifiers returned 61 `L`, 56 `M`",
        "and 2 `S` across 124 findings — a distribution that says they do not distinguish",
        "small work reliably. Use it to sort, not to size.",
        "",
        "Detail lives in two generated files, not here:",
        "`2026-08-02-claude-doc-sweep-worklist.md` (the change list per finding, with",
        "file, symbol, blast radius and user impact) and",
        "`2026-08-02-claude-doc-sweep-divergences.md` (all " + str(p2["raised"]) +
        " findings including the refuted",
        "ones, each with its verbatim doc sentence). Regenerate both with",
        "`python3 scripts/build-doc-sweep-report.py`.",
        "",
    ]

    anchor = "## 6. Evidence quality"
    audit = audit.replace(anchor, "\n".join(sec) + "\n" + anchor, 1)
    open(AUDIT, "w").write(audit)

    print(f"added {len(rows)} rows to §A as R{FIRST_R}–R{FIRST_R + len(units) - 1}")
    print(f"added §5f ({len(sec)} lines)")


if __name__ == "__main__":
    main()
