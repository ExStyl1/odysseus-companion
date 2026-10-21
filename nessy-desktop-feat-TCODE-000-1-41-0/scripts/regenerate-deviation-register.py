#!/usr/bin/env python3
"""Regenerate the deviation register. Unwraps soft-wrapped prose FIRST.

    python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md
    python3 scripts/regenerate-deviation-register.py --check       # report drift, write nothing
    python3 scripts/regenerate-deviation-register.py --self-test   # assert the harvester on a fixture

`--check` is the control this script was missing, and its absence is why the
defect below survived. The harvest is a COUNT nobody re-derives: when a spec
manufactured a record out of a citation, TOTAL went 363 → 364 and the only thing
that noticed was a human comparing two numbers weeks later. With `--check` the
same event is a non-zero exit that NAMES the file the new row came from — and a
new deviation appearing in a coverage map, which records none of its own, is
recognisable as a citation on sight. See `check()`.
"""
import collections
import difflib
import glob
import io
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "docs/superpowers/specs/2026-07-29-deviation-register.md"

CAT = re.compile(r"documented,\s+(not implemented|impossible on [^—|`]+|inapplicable)(\s*—\s*([^|`]{12,400}))?", re.S)
TEMPLATE = re.compile(r"<reason>|with that reason|A deviation with no category|three category strings|one of the three")

# ---------------------------------------------------------------------------
# A quotation is not a record.
#
# `documented, <category> — <reason>` is a SHAPE, and a spec that QUOTES a
# recorded verdict reproduces that shape exactly. The harvester then counts a
# citation as a deviation: measured 2026-08-28, the coverage map's row 93 quoted
# B2's verdict verbatim and TOTAL came out 364 against the register's 363 — a
# deviation manufactured out of a footnote, in the artefact the close-out reads.
# That one cell was fixed at `32b2b30f6`; the INSTRUMENT was not.
#
# What was tried and MEASURED NOT TO WORK, so that nobody re-tries it:
#
#   - Requiring a record's syntactic context (a bullet, a table cell, a fenced or
#     indented block — the fix the row recommended). Measured over the whole
#     corpus: real records live in prose (89 matches, mostly `docs/architecture/`),
#     in table cells (54), in bullets (215) and inside a blockquote
#     (`plans/2026-08-20-cross-runtime-history-carry.md`, a genuine record behind
#     a `>` prefix). A positive-context requirement drops ~89 real rows. Losing a
#     row silently is the failure this generator has already suffered five ways;
#     an inflated count is the less dangerous direction.
#   - Rejecting anything wrapped in quotes. 241 of 370 candidates are wrapped in
#     SOME delimiter, overwhelmingly backticks, and almost all are genuine —
#     `docs/architecture/*` writes the record as a code span by house style.
#     One measured false positive is decisive on its own:
#     `plans/2026-08-20-cross-runtime-history-carry.md` presents its own
#     deviation inside quotes, as a literal "category string".
#
# So the shape cannot decide, and this script does not pretend otherwise. It
# FLAGS instead: a candidate that is delimiter-wrapped AND names another of OUR
# dated plan/spec files — or a line pointer into the register — as the record's
# owner is reported on stderr for a human to adjudicate, and is still counted.
# Measured on the 2026-08-28 corpus: 7 flagged, 6 of them true citations, the one
# false positive being `plans/2026-07-29-fork-surface.md`, which mentions a
# sibling plan one paragraph above a record of its own. That is useful as a
# warning and worthless as a filter, which is exactly how it is wired.
#
# The six true citations found this way are NOT suppressed here. Suppressing a
# row by hand risks the one failure worse than the inflation being fixed — a
# dropped real deviation — and the six live in two survey specs whose content is
# not this script's to adjudicate. They are reported, on every run, by name.
# ---------------------------------------------------------------------------
DELIMS = "\"'`«“„‟"
# OUR files carry a date; Claude's documentation pages do not. A record citing
# `sub-agents.md:1046` is a normal record naming the contract it deviates from;
# a record citing `2026-07-29-session-scheduling.md:163` is naming the file that
# already OWNS it, which is what a citation does and a record never needs to.
OUR_FILE = re.compile(r"\b\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md\b")
# The other way a citation names its owner: a line pointer INTO the register
# itself ("with register category at :289 …"). Kept narrow deliberately — a bare
# mention of "the deviation register" is boilerplate two plans use to introduce
# their OWN residuals, and admitting it cost two false positives when measured.
REGISTER_REF = re.compile(r"register\b[^.]{0,60}:\s?\d+", re.I)
ATTRIB_LOOKBACK = 200
# The attribution can FOLLOW the quotation — "«…verdict…» (`plans/….md:190`)" is
# how the coverage map wrote the one that actually shipped, so a backward-only
# window missed the very defect this guard exists for. Measured 2026-08-28: the
# forward window takes the flag set from 7 to 8 on the fixed corpus and is what
# makes the re-broken coverage-map cell visible to the warning as well as to
# `--check`.
ATTRIB_LOOKAHEAD = 150

SOURCES = (
    'docs/superpowers/plans/*.md',
    'docs/superpowers/specs/*.md',
    # R29b found a third way to lose rows: its predecessor wrote category strings
    # into docs/architecture/, which this glob did not cover, so the register
    # carried R29a's two TEMPLATE PLACEHOLDERS instead of its real deviations.
    'docs/architecture/*.md',
)


def harvest_text(raw, path):
    """Every record and suspected citation in ONE document's text.

    Split out of `harvest()` for `--self-test` (P6.923): the filter chain below is
    five measured decisions and, until this was callable on a string, the only way
    to exercise any of them was to run the whole glob and diff the artefact — which
    is precisely the control that cannot see a real record being dropped.
    """
    rows = []
    citations = []
    # Unwrap: a newline inside a paragraph becomes a space. Blank lines and list
    # bullets stay, so we do not weld separate entries together.
    flat = re.sub(r"\n(?=[ \t]*[A-Za-z`'\"(*])", " ", raw)
    # Strip markdown emphasis: `**documented, not implemented** — reason` is the
    # same record as the unbolded form, and leaving the asterisks in severs the
    # category from its reason, which drops the row silently.
    # `**` only. Stripping `__` too was a fourth way to lose half a row: it
    # mangles `__tests__` in a path, which reasons cite constantly, to protect
    # against `__documented, not implemented__` emphasis, which has never once
    # appeared. R14's executor hit it writing a reason about a test file.
    flat = flat.replace("**", "")
    base = os.path.basename(path)
    for m in CAT.finditer(flat):
        kind = 'impossible' if m.group(1).startswith('impossible') else ('inapplicable' if m.group(1) == 'inapplicable' else 'not implemented')
        reason = re.sub(r"\s+", " ", (m.group(3) or "")).strip()
        if TEMPLATE.search(reason) or len(reason) < 12:
            continue
        owner = _attributed_elsewhere(flat, m.start(), m.end(), base)
        if owner:
            citations.append((path, owner, reason))
        rows.append((path.replace('docs/superpowers/', ''), kind, reason))
    return rows, citations


def dedupe(rows):
    """One record per `(file, first 120 chars of reason)`, in first-seen order."""
    seen = set(); uniq = []
    for r in rows:
        key = (r[0], r[2][:120])
        if key in seen: continue
        seen.add(key); uniq.append(r)
    return uniq


def harvest():
    """Return `(rows, citations)`; `rows` is deduped, `citations` are flagged."""
    rows = []
    citations = []
    for path in sorted(p for pattern in SOURCES for p in glob.glob(pattern)):
        found, flagged = harvest_text(open(path).read(), path)
        rows.extend(found)
        citations.extend(flagged)
    return dedupe(rows), citations


def _attributed_elsewhere(flat, start, end, me):
    """The other dated file this candidate names as the record's owner, if any.

    A warning, never a filter — see the block comment above. Two conditions,
    both required: the category token is wrapped in a quoting delimiter, and the
    surrounding text names one of OUR dated plan/spec files other than this one
    (or points at a register line). Either condition alone is far too common to
    mean anything — 241 of 370 candidates are delimiter-wrapped.
    """
    j = start - 1
    while j >= 0 and flat[j] in " \t":
        j -= 1
    if j < 0 or flat[j] not in DELIMS:
        return None
    back = flat[max(0, start - ATTRIB_LOOKBACK):start]
    for name in OUR_FILE.findall(back):
        if name != me:
            return name
    for name in OUR_FILE.findall(flat[end:end + ATTRIB_LOOKAHEAD]):
        if name != me:
            return name
    pointer = REGISTER_REF.search(back)
    return pointer.group(0).strip() if pointer else None


def render(uniq, out):
    counts = collections.Counter(k for _, k, _ in uniq)
    print(f"TOTAL {len(uniq)}", file=out)
    print(dict(counts), file=out)
    # Provenance, emitted HERE so a re-run preserves it instead of a hand-edit the
    # next regen erases. Every reason below is harvested verbatim from a FINISHED
    # plan's deviation list, and a finished plan is a dated record: the `page.md:N`
    # and `file.ts:N` anchors inside these sentences were measured on the day that
    # plan closed and were never re-hung. Measured 2026-08-25 over the resolvable
    # source anchors cited from `docs/`: 674 land on a blank line, 249 point past
    # the end of their file, 959 land on a bare `}`/`*/` — and the majority that do
    # land on real text are UNVERIFIED, not verified. The identifier is the quoted
    # sentence and the named symbol.
    print(file=out)
    print("**Line numbers in the reasons below are a dated measurement, not a live "
          "pointer.** Each reason is harvested verbatim from a finished plan's "
          "deviation list and carries that plan's anchors, measured on the day it "
          "closed. They are deliberately never re-hung: renumbering a dated record "
          "turns what was measured into a claim nobody made. Re-measure and stamp "
          "your own date if you need a number that lands; the durable identifier is "
          "the quoted sentence and the named symbol. Regenerate with "
          "`python3 scripts/regenerate-deviation-register.py > "
          "docs/superpowers/specs/2026-07-29-deviation-register.md`.", file=out)
    by_file = collections.OrderedDict()
    for path, kind, reason in uniq:
        by_file.setdefault(path, []).append((kind, reason))
    for path, items in by_file.items():
        print(f"\n### `{path}`\n", file=out)
        for kind, reason in items:
            print(f"- **{kind}** — {reason}", file=out)


def report_citations(citations):
    """Name every suspected citation on stderr. Silence is how the last one shipped."""
    if not citations:
        return
    print(
        f"deviation register: {len(citations)} candidate(s) look like a CITATION of a record "
        "owned by another file, not a record of their own. They ARE counted — the shape cannot "
        "decide (see the block comment in this script) — so adjudicate them by hand:",
        file=sys.stderr,
    )
    for path, owner, reason in citations:
        print(f"  - {path}\n      attributes it to: {owner}\n      reason: {reason[:110]}", file=sys.stderr)


def main():
    uniq, citations = harvest()
    render(uniq, sys.stdout)
    report_citations(citations)
    print(f"deviation register: harvested {len(uniq)} records", file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# `--self-test`: the filter chain read against a FIXTURE, never against its output
#
# P6.923, the sibling of `build-parity-report.py --self-test`. `--check` diffs a
# fresh harvest against the committed register, which answers "is the file
# stale?" and cannot answer "does the harvester still SEE a record?" — every one
# of the five ways this script has lost rows (soft wrapping, `**emphasis**`, an
# unterminated bullet, a narrow glob, a length cap biting the parsed reason)
# would leave `--check` green the moment the register was regenerated, one row
# lighter, with the loss recorded as the new truth.
#
# So each case below is a document that does not exist, whose expected records
# are written out in full. Every case is one of the measurements in the block
# comments above, which is why the expectations are exact strings rather than
# counts: a filter that starts trimming a reason passes a count and fails a
# string.
# ---------------------------------------------------------------------------
SELF_TEST_PATH = "docs/superpowers/plans/2026-01-01-self-test-fixture.md"
SELF_TEST_ROW = "plans/2026-01-01-self-test-fixture.md"


def _self_test_cases():
    """`(label, text, raw_count, deduped_rows, citation_count)`."""
    return [
        # The ordinary shape: a record in prose, in each of the three categories.
        ("a record in prose",
         "The knob is documented, not implemented — the runtime exposes no equivalent.",
         1, [(SELF_TEST_ROW, "not implemented", "the runtime exposes no equivalent.")], 0),
        ("the impossible category, with its subject",
         "This is documented, impossible on the codex runtime — the protocol carries no such field.",
         1, [(SELF_TEST_ROW, "impossible", "the protocol carries no such field.")], 0),
        ("the inapplicable category",
         "It is documented, inapplicable — this fork ships no such surface at all.",
         1, [(SELF_TEST_ROW, "inapplicable", "this fork ships no such surface at all.")], 0),
        # Emphasis, the SECOND way rows were lost: the asterisks sever the category
        # from its reason, and a severed record is dropped in silence.
        ("a bolded record is the same record",
         "**documented, not implemented** — the adapter has no call to make here.",
         1, [(SELF_TEST_ROW, "not implemented", "the adapter has no call to make here.")], 0),
        # And the measured limit of that repair: stripping `__` as well mangles
        # `__tests__`, which reasons cite constantly, to defend against an emphasis
        # form that has never once appeared. R14's executor hit it for real.
        ("a reason naming __tests__ survives intact",
         "It is documented, not implemented — the fixture sits under __tests__ and nothing reads it.",
         1, [(SELF_TEST_ROW, "not implemented",
              "the fixture sits under __tests__ and nothing reads it.")], 0),
        # The two deliberate drops.
        ("a template placeholder is not a record",
         "documented, not implemented — <reason> is filled in by whoever records it.",
         0, [], 0),
        ("a reason too short to be one",
         "documented, not implemented — no.",
         0, [], 0),
        # A quotation is not a record — but the shape cannot decide, so this is a
        # WARNING and never a filter. The row is counted AND flagged; a change that
        # started suppressing it would pass any count of flags and fail this case.
        ("a quoted record naming another file is flagged, NOT dropped",
         'See 2026-07-29-session-scheduling.md, which says "documented, not implemented — '
         'the runtime has no such knob."',
         1, [(SELF_TEST_ROW, "not implemented", 'the runtime has no such knob."')], 1),
        # The dedupe key is `(file, first 120 chars of reason)`. Two table cells
        # carrying one record must collapse to one row and not to zero.
        ("one record written twice collapses to one",
         "| R1 | documented, not implemented — the knob is absent everywhere. |\n"
         "| R2 | documented, not implemented — the knob is absent everywhere. |",
         2, [(SELF_TEST_ROW, "not implemented", "the knob is absent everywhere.")], 0),
    ]


def self_test():
    """Assert the filter chain over the fixture above. Non-zero on any mismatch."""
    cases = _self_test_cases()
    width = max(len(label) for label, *_ in cases)
    failures = 0
    for label, text, want_raw, want_rows, want_citations in cases:
        rows, citations = harvest_text(text, SELF_TEST_PATH)
        uniq = dedupe(rows)
        ok = (len(rows), uniq, len(citations)) == (want_raw, want_rows, want_citations)
        failures += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'}  {label.ljust(width)}  "
              f"raw={len(rows)} records={len(uniq)} flagged={len(citations)}")
        if not ok:
            print(f"      got      raw={len(rows)} {uniq} flagged={len(citations)}", file=sys.stderr)
            print(f"      expected raw={want_raw} {want_rows} flagged={want_citations}",
                  file=sys.stderr)

    if failures:
        print(f"deviation register self-test: {failures} case(s) FAILED — the harvester changed "
              "behaviour. Each case records a measured way this script has lost or invented a "
              "row; read its comment before adjusting the expectation.", file=sys.stderr)
        return 1
    print(f"deviation register self-test: {len(cases)} cases, harvester unchanged")
    return 0


def check():
    """Regenerate in memory and diff against the committed register.

    The defect this exists for: the harvest is a number nobody re-derives, so a
    row manufactured out of a quotation reads exactly like a row that was earned.
    A byte diff cannot be fooled that way — and because the register is keyed by
    the file each row came from, the diff says WHICH file grew a deviation, which
    is the whole tell. Precedent: `scripts/build-parity-report.py --check`.
    """
    uniq, citations = harvest()
    buffer = io.StringIO()
    render(uniq, buffer)
    report_citations(citations)
    if not ARTIFACT.exists():
        print(f"deviation register: {ARTIFACT} does not exist", file=sys.stderr)
        return 1
    fresh, committed = buffer.getvalue(), ARTIFACT.read_text()
    if fresh == committed:
        print(f"deviation register: up to date ({len(uniq)} records)")
        return 0
    diff = list(difflib.unified_diff(
        committed.split("\n"), fresh.split("\n"),
        fromfile="committed", tofile="regenerated", lineterm="", n=0,
    ))
    for line in diff[:40]:
        print(line, file=sys.stderr)
    if len(diff) > 40:
        print(f"… {len(diff) - 40} more diff lines", file=sys.stderr)
    changed = sum(1 for l in diff if l[:1] in '+-' and l[:3] not in ('+++', '---'))
    print(
        f"deviation register: STALE — {changed} line(s) differ. A row appearing under a file "
        "that records no deviations of its own is a QUOTATION being counted, not a new "
        "deviation. Regenerate:"
        "\n  python3 scripts/regenerate-deviation-register.py > "
        "docs/superpowers/specs/2026-07-29-deviation-register.md",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    _ARGS = sys.argv[1:]
    raise SystemExit(
        self_test() if "--self-test" in _ARGS else check() if "--check" in _ARGS else main()
    )
