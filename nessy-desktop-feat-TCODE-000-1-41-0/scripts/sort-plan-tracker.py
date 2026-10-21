#!/usr/bin/env python3
"""Sort a plan's `## Tracker` rows into phase order, refusing to change content.

A plan grows while it executes: findings become rows the moment they are
confirmed, so new rows land wherever the editor happened to be. Left alone the
tracker ends up ordered by when each row was BORN, which makes "what is left in
phase 2" unreadable — the state this script exists to prevent.

Usage:  python3 scripts/sort-plan-tracker.py docs/superpowers/plans/<plan>.md
        python3 scripts/sort-plan-tracker.py --check <plan>.md   # CI/pre-commit
        python3 scripts/sort-plan-tracker.py --shas [<plan>.md…] # every commit cell resolves
        python3 scripts/sort-plan-tracker.py --self-test         # assert the extractor

Safety: the row multiset is hashed before and after. Any difference in row
CONTENT (not order) aborts without writing — sorting must never edit a row.
Status glyphs: the plan's legend defines `✅` done, `⬜` open and dispatchable,
`⏸` open but BLOCKED ON AN OWNER ANSWER. That is a legend, not the roster —
`🟨` (landed, residue routed to its own row) and `🚧` (in flight) are on real
rows and are defined in no legend. This script does not read the glyph at all;
the one place a glyph is classified is `GLYPH_CLASS` in scripts/plan-status.py,
which two readers used to contradict each other about (P3.362, 2026-09-04).
Add a glyph THERE, or plan-status prints it as unclassified rather than
silently folding it into whichever bucket an `elif` reached first.
Row ids are `P<phase>.<n>` or `T<n>` (T rows are phase 1, the scheduling lane),
with an optional lowercase suffix for splits (`T13a`, `T13b`).
"""

from __future__ import annotations

import hashlib
import pathlib
import re
import subprocess
import sys
from datetime import date

ROW_ID = re.compile(r"^([A-Z]+)(\d+)(?:\.(\d+))?([a-z]?)$")
HEADER = "| Row | Task | Status | Commit | Note |"


def sort_key(row: str) -> tuple[int, int, int, str]:
    rid = row.split("|")[1].strip()
    m = ROW_ID.match(rid)
    if not m:
        raise SystemExit(f"unrecognized tracker row id: {rid!r}")
    family, first, second, suffix = m.group(1), int(m.group(2)), m.group(3), m.group(4)
    # T rows are the scheduling lane and belong with phase 1; P rows carry their
    # phase in the first number. Within a phase, P sorts before T.
    phase = 1 if family == "T" else first
    return (phase, 0 if family == "P" else 1, int(second) if second else first, suffix)


def main(argv: list[str]) -> int:
    check_only = "--check" in argv
    paths = [a for a in argv[1:] if not a.startswith("--")]
    if len(paths) != 1:
        raise SystemExit(__doc__)
    path = paths[0]

    lines = open(path).read().split("\n")
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith(HEADER))
    except StopIteration:
        raise SystemExit(f"{path}: no `{HEADER}` table found")
    if not lines[start + 1].startswith("| ---"):
        raise SystemExit(f"{path}: tracker header is not followed by a separator row")

    end = start + 2
    while end < len(lines) and lines[end].startswith("| "):
        end += 1
    rows = lines[start + 2 : end]
    if not rows:
        raise SystemExit(f"{path}: tracker has no rows")

    ordered = sorted(rows, key=sort_key)
    before = hashlib.sha256("\n".join(sorted(rows)).encode()).hexdigest()
    after = hashlib.sha256("\n".join(sorted(ordered)).encode()).hexdigest()
    if before != after or len(rows) != len(ordered):
        raise SystemExit("row content changed — refusing to write")

    if ordered == rows:
        print(f"{path}: {len(rows)} tracker rows already in phase order")
        return 0
    if check_only:
        moved = sum(1 for a, b in zip(rows, ordered) if a != b)
        print(f"{path}: tracker is out of order ({moved} rows misplaced)")
        return 1

    lines[start + 2 : end] = ordered
    open(path, "w").write("\n".join(lines))
    print(f"{path}: sorted {len(rows)} tracker rows, content hash unchanged")
    return 0


# ---------------------------------------------------------------------------
# `--shas`: every commit cell of every plan names a commit that EXISTS
#
# P6.987. A tracker's commit cell is the only durable link from a row to what
# landed it, and nothing checked one: two cells cited shas that exist in no ref
# (`a6cd0ea5d` on P6.317, `7f8a2ee7c` on P6.307), found by hand and corrected by
# hand. `--check` above answers "is the tracker sorted?" and cannot answer "does
# this row point at a commit?", so a phantom sha reads exactly like a real one.
#
# Four measurements shape the extraction (2026-09-10, over all plans):
#
# * The sha CELL, not the line. Notes cite FILE-content sha prefixes ("restored
#   byte-identically (sha `0d43c5e0…`)") — 15 of them, none a commit. A scanner
#   that reads a whole row manufactures fifteen findings on a clean tree.
# * `\b[0-9a-f]{8,40}\b`, not `{9}`. AGENTS.md's §Traps bullet prescribes the
#   nine-hex form for a multi-sha cell, and nine alone SKIPS both other lengths
#   this corpus carries: 196 distinct 8-hex tokens and one 10-hex
#   (`a6ea30b609`, P3.11) — all 197 resolve, so widening costs no false
#   positive and closes a 7 % hole. The known false-positive shape is an 8-digit
#   date written bare in a commit cell (`20260910`); none exists today, and the
#   miss it would report names the row, so it is legible rather than silent.
# * A MISALIGNED row is skipped and NAMED, never guessed at. An unescaped `|`
#   inside a cell shifts every column after it (the same defect that drops a row
#   from `plan-status.py`), so index-based reading would land in the note — see
#   the first bullet. 54 rows across 20 plans are in that state; their tokens go
#   unchecked, which is why the count is printed on every run.
# * ONE `git cat-file --batch-check` over `<token>^{commit}`, not one process
#   per token: 2 000+ tokens, and a per-token fork is a minute of the lint chain.
#
# The counts are a reading with a date, not a fact — the summary prints today's,
# and there is deliberately no pinned total to go stale in prose.
# ---------------------------------------------------------------------------
ROOT = pathlib.Path(__file__).resolve().parent.parent
PLANS = ROOT / "docs" / "superpowers" / "plans"
# `|` splits a cell unless escaped as `\|` — the ledger convention AGENTS.md
# names, and the only thing separating a wide cell from a dropped row.
CELL_SPLIT = re.compile(r"(?<!\\)\|")
SEPARATOR = re.compile(r"^\|[\s|:-]+\|?\s*$")
SHA_TOKEN = re.compile(r"\b[0-9a-f]{8,40}\b")
COMMIT_HEADINGS = {"commit", "commits", "sha", "shas"}
# P6.995 (2026-09-10): every misaligned row is PRINTED, on stdout, and the count is
# a ratchet — a truncated printout (`MISALIGNED_SHOWN = 12`) hid 37 of the 49 rows
# from the controller's reading, and once W9-ci escaped all 49 the true count is
# zero over 143 plans, which is the only reason a zero-tolerance gate is honest.


def _cells(line: str) -> list[str]:
    """The row's cells. A row need not carry a trailing `|` — 142 do not."""
    parts = CELL_SPLIT.split(line)
    if parts and not parts[0].strip():
        parts = parts[1:]
    if parts and not parts[-1].strip():
        parts = parts[:-1]
    return [p.strip() for p in parts]


def harvest_shas(text: str, path: str):
    """`(found, misaligned)` for one plan's text.

    `found` is `(token, path, line_no, row_id)`; `misaligned` is
    `(path, line_no, row_id, got, want)` for a row whose field count does not
    match its header's. Split out of `shas()` so `--self-test` can assert the
    extractor against fixture text rather than against the tree it just read.
    """
    found: list[tuple[str, str, int, str]] = []
    misaligned: list[tuple[str, int, str, int, int]] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if not (line.startswith("|") and i + 1 < len(lines) and SEPARATOR.match(lines[i + 1])):
            i += 1
            continue
        header = _cells(line)
        columns = [
            k for k, h in enumerate(header) if h.strip("*` ").lower() in COMMIT_HEADINGS
        ]
        j = i + 2
        while j < len(lines) and lines[j].startswith("|"):
            if columns:
                row = _cells(lines[j])
                row_id = row[0] if row else ""
                if len(row) != len(header):
                    misaligned.append((path, j + 1, row_id, len(row), len(header)))
                else:
                    for k in columns:
                        for token in SHA_TOKEN.findall(row[k]):
                            found.append((token, path, j + 1, row_id))
            j += 1
        i = j
    return found, misaligned


def unresolved_shas(tokens: list[str]) -> set[str]:
    """The subset of `tokens` naming no commit in this repository."""
    if not tokens:
        return set()
    probe = "".join(f"{t}^{{commit}}\n" for t in tokens)
    try:
        out = subprocess.run(
            ["git", "cat-file", "--batch-check"],
            input=probe, cwd=ROOT, capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover - rig
        raise SystemExit(f"plan shas: `git cat-file` failed: {exc}")
    answers = out.stdout.split("\n")
    if len(answers) < len(tokens):  # pragma: no cover - rig
        raise SystemExit(
            f"plan shas: `git cat-file` answered {len(answers)} of {len(tokens)} probes "
            f"— refusing to report a miss from a truncated batch. stderr: {out.stderr.strip()}"
        )
    # `<input> missing` / `<input> ambiguous`; a hit is `<sha> commit <size>`.
    return {t for t, a in zip(tokens, answers) if " commit " not in a}


def shas(paths: list[str]) -> int:
    """Assert every commit cell in `paths` (default: every plan). 1 on any miss."""
    files = [pathlib.Path(p) for p in paths] or sorted(PLANS.glob("*.md"))
    if not files:
        raise SystemExit(f"plan shas: no plans found under {PLANS}")

    found: list[tuple[str, str, int, str]] = []
    misaligned: list[tuple[str, int, str, int, int]] = []
    for f in files:
        rel = f.as_posix()
        try:
            rel = f.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            pass
        a, b = harvest_shas(f.read_text(), rel)
        found += a
        misaligned += b

    ordered = list(dict.fromkeys(t for t, *_ in found))
    missing = unresolved_shas(ordered)

    for token, path, line_no, row_id in found:
        if token in missing:
            print(f"{path}:{line_no}: row {row_id} cites `{token}`, which names no commit")

    if misaligned:
        # On STDOUT beside the phantom lines: a gate's verdict belongs where its
        # findings are (AGENTS.md §Traps, 2026-09-09). Every row, never a prefix.
        print(
            f"plan shas: {len(misaligned)} row(s) carry an unescaped `|` and were NOT read "
            "— their commit cells go unchecked (and they drop out of any column-indexed "
            "reader, `plan-status.py` included); escape the pipe as `\\|`:"
        )
        for path, line_no, row_id, got, want in misaligned:
            print(f"  {path}:{line_no}: row {row_id} has {got} fields, not {want}")

    summary = (
        f"plan shas: {len(found)} token(s), {len(ordered)} distinct, over {len(files)} plan(s) "
        f"— {len(misaligned)} row(s) unread (a reading of {date.today().isoformat()})"
    )
    if missing:
        # On STDOUT, beside the miss lines above. AGENTS.md §Traps, 2026-09-09:
        # `plan-status.py`'s unescaped-`|` guard writes to stderr while the table
        # a reader actually reads is stdout, so any invocation that pipes only
        # stdout drops the verdict. A gate's verdict belongs where its findings are.
        print(
            f"{summary}; {len(missing)} PHANTOM: the cell names a commit this repository does "
            "not have. Re-derive it from `git log` for that row's work and correct the cell — "
            "the plan is the controller's, so report it rather than editing it yourself."
        )
        return 1
    if misaligned:
        print(f"{summary}; every commit cell that could be read resolves — the unread rows above are the finding")
        return 1
    print(f"{summary}; every commit cell resolves")
    return 0


# ---------------------------------------------------------------------------
# `--self-test`: the extractor read against a FIXTURE, never against the tree
#
# Sibling of `build-parity-report.py --self-test` and
# `regenerate-deviation-register.py --self-test` (P6.923). `--shas` over the real
# plans answers "is the tree clean?" and cannot answer "does the extractor still
# SEE a cell?" — every way this reader can go blind (a multi-sha `+` span, a
# missing trailing `|`, a `Sha`-titled column, a token that is not nine wide)
# leaves the real run green with fewer tokens checked, and a green run over half
# the corpus is indistinguishable from a green run over all of it.
#
# Each case is a document that does not exist, with its expected tokens written
# out in full: a change that starts trimming the population passes a count and
# fails a list.
# ---------------------------------------------------------------------------
SELF_TEST_PATH = "docs/superpowers/plans/2026-01-01-self-test-fixture.md"
_H5 = "| Row | Task | Status | Commit | Note |\n| --- | --- | --- | --- | --- |\n"


def _self_test_cases():
    """`(label, text, want_tokens, want_misaligned)`; tokens are `(sha, row_id)`."""
    return [
        ("the ordinary one-sha cell",
         _H5 + "| P1 | a task | ✅ | `1ff71c5a4` | it landed. |",
         [("1ff71c5a4", "P1")], 0),
        # AGENTS.md §Traps, 2026-09-10: the plan writes several shas as ONE
        # backticked span joined by ` + `, and a per-cell `` `([0-9a-f]{7,12})` ``
        # extraction finds nothing there. Both phantoms this row was born for
        # lived in a span of exactly this shape.
        ("the multi-sha `+` span yields every sha in it",
         _H5 + "| P2 | a task | ✅ | `c48e0a9f2 + 9d4c15a5f + a941d2f6a` | five batches. |",
         [("c48e0a9f2", "P2"), ("9d4c15a5f", "P2"), ("a941d2f6a", "P2")], 0),
        ("the arrow form and the parenthesised superseding form",
         _H5 + "| P3 | a task | ✅ | `109e48700` → `9303da6a5` | superseded twice. |\n"
             + "| P4 | a task | ✅ | `1ff71c5a4` (superseding `724ce6844`) | widened a grant. |",
         [("109e48700", "P3"), ("9303da6a5", "P3"),
          ("1ff71c5a4", "P4"), ("724ce6844", "P4")], 0),
        # 196 distinct 8-hex and one 10-hex token live in real commit cells and
        # all of them resolve; `{9}` alone would skip every one in silence.
        ("an 8-hex and a 10-hex sha are read, because `{9}` skips both",
         _H5 + "| P5 | a task | ✅ | `8b17a79c` `a6ea30b609` | two lengths. |",
         [("8b17a79c", "P5"), ("a6ea30b609", "P5")], 0),
        ("an em-dash cell and prose are not tokens",
         _H5 + "| P6 | a task | ⬜ | — | not started. |\n"
             + "| P7 | a task | ✅ | decided — no code | an owner decision. |",
         [], 0),
        # The note cites FILE-content sha prefixes; reading a note cell as a
        # commit cell manufactured 15 findings on a clean tree.
        ("a sha in the NOTE is not a commit cell",
         _H5 + "| P8 | a task | ✅ | `1ff71c5a4` | restored byte-identically (sha `0d43c5e0…`). |",
         [("1ff71c5a4", "P8")], 0),
        ("a table with no commit column is not read at all",
         "| Row | Task | Status | Note |\n| --- | --- | --- | --- |\n"
         "| P9 | a task | ✅ | landed as `1ff71c5a4`. |",
         [], 0),
        ("a `Sha` column is a commit column, and so is a bolded one",
         "| Task | Sha | Subject |\n| --- | --- | --- |\n"
         "| T1 | `26bc740ee` | the subject |\n"
         "\n| Task | **Commit** | Subject |\n| --- | --- | --- |\n"
         "| T2 | `50754157b` | the subject |",
         [("26bc740ee", "T1"), ("50754157b", "T2")], 0),
        # 142 of the 144 plans carry rows with no trailing `|`; dropping the last
        # field unconditionally misaligned 5 rows that were perfectly well formed.
        ("a row with no trailing pipe is still aligned",
         _H5 + "| P10 | a task | ✅ | `4e9d75306` | the note runs to the end of the line",
         [("4e9d75306", "P10")], 0),
        ("an unescaped `|` skips the row and counts it; an escaped one does not",
         _H5 + "| P11 | a task | ✅ | `9d76ef12e` | the union `a|b` splits the row. |\n"
             + "| P12 | a task | ✅ | `63d9c32e6` | the union `a\\|b` keeps it whole. |",
         [("63d9c32e6", "P12")], 1),
    ]


def self_test() -> int:
    """Assert the extractor over the fixtures above. Non-zero on any mismatch."""
    cases = _self_test_cases()
    width = max(len(label) for label, *_ in cases)
    failures = 0
    for label, text, want_tokens, want_misaligned in cases:
        found, misaligned = harvest_shas(text, SELF_TEST_PATH)
        got = [(token, row_id) for token, _path, _line, row_id in found]
        ok = (got, len(misaligned)) == (want_tokens, want_misaligned)
        failures += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'}  {label.ljust(width)}  "
              f"tokens={len(got)} unread={len(misaligned)}")
        if not ok:
            print(f"      got      {got} unread={len(misaligned)}", file=sys.stderr)
            print(f"      expected {want_tokens} unread={want_misaligned}", file=sys.stderr)

    if failures:
        print(f"plan-tracker sha self-test: {failures} case(s) FAILED — the extractor changed "
              "behaviour. Each case records a measured way this reader has gone or could go "
              "blind; read its comment before adjusting the expectation.", file=sys.stderr)
        return 1
    print(f"plan-tracker sha self-test: {len(cases)} cases, extractor unchanged")
    return 0


if __name__ == "__main__":
    _ARGS = sys.argv
    if "--self-test" in _ARGS:
        sys.exit(self_test())
    if "--shas" in _ARGS:
        sys.exit(shas([a for a in _ARGS[1:] if not a.startswith("--")]))
    sys.exit(main(_ARGS))
