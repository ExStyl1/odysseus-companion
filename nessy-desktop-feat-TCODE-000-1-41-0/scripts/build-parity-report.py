#!/usr/bin/env python3
"""Build the single-file parity report: two tables, nothing else.

Generated, not authored. The tracker and the deviation register stay the
sources of truth; this only reshapes them. Regenerate with:

    python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md
    python3 scripts/build-parity-report.py --check       # report drift, write nothing
    python3 scripts/build-parity-report.py --self-test   # assert the harvester on a fixture

The report answers two questions and refuses to grow past them:

    1. What do we have?
    2. What is deferred or divergent — and does it have a plan?

Detail deliberately lives elsewhere. A row's commits, probes and every
correction an executor made are in the tracker row; a deviation's full reason
is in the plan that recorded it. Both are one link away, so this file stays
readable in one pass.

Two properties this script exists to preserve, both learned the hard way:

- **A row is never silently dropped.** The register's own generator lost rows
  five ways (soft wrapping, `**emphasis**`, an unterminated bullet, a narrow
  glob, a length cap biting the parsed reason). Every parse here is asserted:
  if a count does not match what the source declares, this exits non-zero
  rather than printing a plausible smaller number.
- **A status is copied, never inferred.**
"""

import collections
import datetime
import difflib
import functools
import io
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPECS = ROOT / "docs/superpowers/specs"
PLANS = ROOT / "docs/superpowers/plans"
TRACKER = SPECS / "2026-07-25-nessy-claude-parity-audit.md"
REGISTER = SPECS / "2026-07-29-deviation-register.md"
ARTIFACT = SPECS / "2026-07-30-parity-report.md"
# The stamp on the provenance line is derived from the INPUTS and never from the
# clock — see `provenance_stamp()` below. `--check` still normalises the first date
# on that line away, because the two mechanisms answer different questions: this
# one keeps the artifact byte-reproducible on any day, that one keeps a re-dating
# from reading as content drift. Anything else differing means an input moved and
# the committed artifact is stale.
DATE_TOKEN = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
PROVENANCE_PREFIX = "**Every number below is a snapshot of FIVE inputs, taken "
COVERAGE_MAP = SPECS / "2026-07-31-claude-coverage-map.md"

DONE = ("✅", "\U0001f6e1")
OPEN = ("\U0001f504", "⬜", "⏸")
LABEL = {
    "✅": "done",
    "\U0001f6e1": "ahead",
    "\U0001f504": "partial",
    "⬜": "unowned",
    "⏸": "parked",
}
PLAN_RE = re.compile(r"(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\.md")
# A Claude documentation page as we cite it: a bare `.md` name, optionally with
# a one-level prefix (`agent-sdk/hooks.md`). Dated names are OUR plans, not
# Claude's pages, so they are excluded — that filter is the whole difference
# between an index of the contract and an index of ourselves.
#
# The leading `\b` became `(?<![.\w-])` on 2026-09-08 (P6.921), and the change is
# not cosmetic: `\b` matches immediately after a dot or a hyphen, so the detector
# was harvesting the TAIL of every dotted or hyphenated filename this repo
# writes. `lane-W9-e-report.md` was counted as a page named `e-report.md`,
# `AGENTS.override.md` as `override.md`, `CLAUDE.local.md` as `local.md`.
# Measured over the tracker plus every plan: §3b fell from 186 foreign names to
# 107, while §3 — the pages actually cited — did not move by one line. That
# unchanged §3 is the control saying only fragments were lost.
DOC_RE = re.compile(r"(?<![.\w-])((?:[a-z][a-z0-9-]*/)?[a-z][a-z0-9-]*\.md)\b")
# The SAME name without the suffix, inside backticks — how a tracker row usually
# names the unit it built (`` `output-styles` ``) rather than the page.
#
# This is DELIBERATELY not folded into the cited set, and the reason is measured
# (2026-08-28): over the tracker plus every plan it matches ten pages that `.md`
# detection misses, and most of them are not citations at all — `` `sessions` ``
# is a subsystem tally, `` `setup` `` is a coincident unit name, `` `agent-teams` ``
# and `` `tool-search` `` appear inside lists of names. Admitting them would
# certify contracts nobody took, which is the dangerous direction; so they are
# reported as their own labelled bucket in §3a and counted as uncited.
BARE_RE = re.compile(r"`((?:[a-z][a-z0-9-]*/)?[a-z][a-z0-9-]*)`")
# OUR files, not Claude's. Most appear in every plan's boilerplate (the
# known-failing list, the CDP checklist), so leaving them in produces a row that
# cites every plan and says nothing — the first draft of this table did exactly
# that.
DOC_SKIP = {
    "AGENTS.md", "CLAUDE.md", "README.md", "MEMORY.md",
    "known-failing-tests.md", "cdp-live-checklist.md", "deviation-register.md",
    "deviation-audit.md", "parity-audit.md", "parity-report.md",
    "doc-verification.md", "phase4-findings.md", "b1-audit.md",
    "r-queue-doc-verification.md", "claude-adapter-doc-gaps.md",
    "reverification.md", "index.md", "llms.txt",
}

# ---------------------------------------------------------------------------
# OUR OWN working files are not a contract, and the hand list above cannot keep
# up with a tree that mints a new lane report every wave. Measured 2026-09-08
# (P6.921), before the wave-9 regeneration: §3b stood at 186 foreign names
# against the committed 138, and its five largest NEW rows were `rezone.md`
# (22), `page.md` (18), `e-report.md` (16), `report.md` (13) and `s1-report.md`
# (12) — the controller's hand-off file and lane-report filenames, harvested out
# of plan prose that merely NAMES them. Regenerating would have shipped 48
# phantom "documentation" citations as a number nobody could re-derive.
#
# Two derivable tests replace the guesswork, and both run only AFTER a name has
# failed to resolve against `scripts/claude-doc-pages.tsv`, so §3 cannot move:
#
#   1. A lane report, the controller's `rezone.md`, or the `page.md` placeholder
#      that AGENTS.md's own citation rule spells (`page.md` › `#section`). The
#      first two live OUTSIDE this repository, in the checkpoints tree, so no
#      filesystem test can see them — the filename shape is the only handle.
#   2. A name that is a path SUFFIX of one of our own tracked documents under
#      `docs/` or `docs-site/`. A suffix on a component boundary, never a leaf:
#      a leaf test swallows `specialized/deploy.md` — a codex example — because a
#      format-adapter fixture happens to carry `commands/deploy.md`. Fixtures,
#      `.planning/` and packaged resources are deliberately not "ours" here for
#      the same reason.
#
# The name list comes from git's INDEX and nothing is read from disk, so a
# neighbour's uncommitted edit cannot move this filter — the trap AGENTS.md
# records for ledgers that enumerate with `git ls-files` and then read the file.
# ---------------------------------------------------------------------------
OUR_WORKING_FILE_RE = re.compile(r"(?:^|-)report\.md$|^(?:rezone|page)\.md$")


def _our_doc_paths():
    """Tracked `.md` files under `docs/` and `docs-site/` — our own documentation.

    A failure to ask git is reported, never swallowed: an empty answer here does
    not corrupt anything, it only lets this repo's own documents be counted as
    foreign citations again, and the reader has to be able to see that happen.
    """
    try:
        out = subprocess.run(
            ["git", "ls-files", "--", "docs", "docs-site"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"parity report: WARNING — could not ask git for our own documents ({exc}); "
              "§3b will count this repo's own docs as foreign citations.", file=sys.stderr)
        return ()
    if out.returncode != 0:
        print(f"parity report: WARNING — `git ls-files` exited {out.returncode} while listing "
              f"our own documents ({out.stderr.strip()[:200]}); §3b will count this repo's own "
              "docs as foreign citations.", file=sys.stderr)
        return ()
    return tuple(line for line in out.stdout.splitlines() if line.endswith(".md"))


_OUR_DOCS = _our_doc_paths()
# What the filter removed, so §3b can say how much it is not showing.
_OUR_FILE_CITATIONS = collections.Counter()


@functools.lru_cache(maxsize=None)
def is_our_file(name):
    """True when a cited `.md` name is one of OUR files rather than a contract."""
    if OUR_WORKING_FILE_RE.search(name.split("/")[-1]):
        return True
    return any(path == name or path.endswith("/" + name) for path in _OUR_DOCS)


PAGES_TSV = ROOT / "scripts" / "claude-doc-pages.tsv"

# ---------------------------------------------------------------------------
# The provenance stamp is a property of the INPUTS, never of the clock.
#
# `datetime.date.today()` used to be written straight into the provenance line,
# and that made this artifact decay every calendar day.
# `scripts/check-generator-faithfulness.ts` reproduces every committed artifact
# byte-for-byte from HEAD and is a case of CI's `test` job, so on the day after any
# regeneration it reported this report as drifted — measured 2026-09-20, `first
# differs at line 10 of 574`, with `2026-09-19` against `2026-09-20` the ONLY
# differing bytes and 7 of 8 artifacts identical. A CI red that recurs daily is a
# merge blocker in disguise, and at the moment a reviewer meets it it is
# indistinguishable from a real drift (D1.422).
#
# So the stamp is the newest COMMITTER date among the five inputs: it moves when an
# input moves and never with the calendar, which is what the sentence carrying it
# has always claimed.
#
# THREE ANSWERS, in order, and the middle one is load-bearing:
#
#   1. git answers -> that date.
#   2. git cannot answer BUT the committed artifact carries a stamp -> reuse it.
#      This is not politeness, it is the whole reason the gate stays green: that
#      gate runs this script inside a `git archive` extraction which it turns into
#      a work tree with `git init` plus `git add -Af` and NO COMMIT, so `git log`
#      there exits 128 (measured 2026-09-20: "your current branch 'master' does not
#      have any commits yet"). A plain git-or-clock fix would therefore leave that
#      gate red on EVERY day, the regeneration day included. Where the inputs'
#      history is unreadable the honest answer is to PRESERVE the last recorded
#      reading rather than replace it with a clock reading of something else — and
#      it is announced on stderr, because a silent substitution is the failure mode
#      this whole file is built against.
#   3. Neither -> the clock, and the header line SAYS it is the clock, so a report
#      generated outside a checkout can never be read as an input-dated one.
#
# One consequence of answer 2 that is easy to trip over: the documented regenerate
# command redirects stdout INTO the artifact, and the shell truncates it before
# python starts. So the preservation is available to `--check` and to the
# faithfulness gate, which both capture stdout, and NOT to a redirected regenerate
# in a tree with no history — there the stamp falls through to answer 3, which says
# what it is. Nothing can preserve a file the shell has already emptied.
#
# The clock is reached through `datetime.date.today()`, which is LOCAL time, so the
# arms in `scripts/build-parity-report.test.ts` move the calendar by running this
# script under two timezones 25 hours apart: a real clock injection that needs no
# test-only knob in this file.
# ---------------------------------------------------------------------------
STAMP_INPUTS = (TRACKER, REGISTER, PAGES_TSV, PLANS, COVERAGE_MAP)


def _newest_input_commit_date():
    """The newest committer date among the five inputs (`YYYY-MM-DD`), or None."""
    paths = [str(path.relative_to(ROOT)) for path in STAMP_INPUTS]
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", *paths],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"parity report: could not ask git when the inputs last moved ({exc}).",
              file=sys.stderr)
        return None
    if out.returncode != 0:
        print(f"parity report: `git log` exited {out.returncode} while dating the inputs "
              f"({out.stderr.strip()[:200]}).", file=sys.stderr)
        return None
    answer = out.stdout.strip()
    # Two ways to get a non-date out of a ZERO exit, and neither is a failure that
    # reports itself: an older git prints an unknown format placeholder literally
    # rather than refusing it, and a pathspec matching no commit in a shallow clone
    # answers an empty string.
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", answer):
        print("parity report: git did not answer a date for the inputs "
              f"({answer[:60]!r}); their history is unreadable here.", file=sys.stderr)
        return None
    return answer


def _committed_stamp():
    """The date the committed artifact stamped on its own provenance line, or None."""
    try:
        text = ARTIFACT.read_text()
    except OSError:
        return None
    for line in text.split("\n"):
        if line.startswith(PROVENANCE_PREFIX):
            found = DATE_TOKEN.search(line)
            return found.group(0) if found is not None else None
    return None


@functools.lru_cache(maxsize=1)
def provenance_stamp():
    """What follows "taken " on the provenance line. See the block above for why."""
    dated = _newest_input_commit_date()
    if dated is not None:
        return f"at their newest committed change, {dated}"
    preserved = _committed_stamp()
    if preserved is not None:
        print("parity report: the inputs' history is unreadable here, so the committed "
              f"artifact's own stamp ({preserved}) is PRESERVED rather than replaced by a "
              "clock reading of something else.", file=sys.stderr)
        return f"at their newest committed change, {preserved}"
    return (f"{datetime.date.today().isoformat()} FROM THE CLOCK — neither the inputs' "
            "history nor a committed artifact was readable here, so this date says when "
            "the file was generated and not when its inputs last moved")


# ---------------------------------------------------------------------------
# Untracked inputs are EXCLUDED, and always named.
#
# This script reads `docs/superpowers/plans/` as a directory glob, so a plan
# sitting untracked in someone's working tree became an input. Two harms, and the
# second is the one that mattered:
#
#   1. Generating absorbed it, so the committed report described a tree nobody
#      else had (one such file moved §3b from 85 foreign names to 87).
#   2. `--check` COUNTED it, so its verdict was contaminated. Measured on
#      `feat/TCODE-000` 2026-08-28: `--check` said STALE, 8 lines differ; moving
#      the branch's two untracked plan/spec files aside took it to 2. Six of the
#      eight differing lines were the untracked files themselves. A genuine drift
#      and a phantom one were indistinguishable to the person running it.
#
# The documented remedy was prose — "regenerate from a clean tree" — and prose did
# not prevent it, because untracked plans and specs are the NORMAL state of a
# working branch, which makes that advice impossible to follow mid-flight.
#
# So the tree's own index decides, not the filesystem: a file `git` does not know
# about is not an input. Staging it (`git add`) makes it one, which is the right
# semantic — in the index means it exists for the repo. Every exclusion is printed
# to stderr on every run, because silence about an absorbed file is how this
# happened in the first place. `--include-untracked` restores the old behaviour
# for a deliberate local preview, and says so just as loudly.
# ---------------------------------------------------------------------------
INCLUDE_UNTRACKED = "--include-untracked" in sys.argv[1:]
# False when we could not ask git, so no verdict claims an exclusion it did not make.
_INPUTS_TRUSTED = not INCLUDE_UNTRACKED


def _untracked_paths():
    """Absolute paths under `docs/superpowers/` that are not in git's index.

    A failure to ask git is reported, never swallowed, and it flips
    `_INPUTS_TRUSTED` so the verdict text stops claiming an exclusion that did
    not happen: an unusable answer that looks like "nothing is untracked" is
    exactly the silent contamination this guard exists to end.
    """
    global _INPUTS_TRUSTED
    try:
        out = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard", "--",
             "docs/superpowers/plans", "docs/superpowers/specs"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"parity report: WARNING — could not ask git for untracked inputs ({exc}); "
              "every file on disk is being read, including any untracked plan.", file=sys.stderr)
        _INPUTS_TRUSTED = False
        return set()
    if out.returncode != 0:
        print(f"parity report: WARNING — `git ls-files` exited {out.returncode} "
              f"({out.stderr.strip()[:200]}); every file on disk is being read, "
              "including any untracked plan.", file=sys.stderr)
        _INPUTS_TRUSTED = False
        return set()
    return {(ROOT / line).resolve() for line in out.stdout.splitlines() if line.strip()}


_UNTRACKED = set() if INCLUDE_UNTRACKED else _untracked_paths()
_ANNOUNCED = []


def tracked(paths):
    """Filter a glob down to inputs the repository actually has."""
    kept = []
    for p in sorted(paths):
        if p.resolve() in _UNTRACKED:
            rel = p.relative_to(ROOT).as_posix()
            if rel not in _ANNOUNCED:
                _ANNOUNCED.append(rel)
        else:
            kept.append(p)
    return kept


def announce_inputs():
    """Say what was left out. Runs on every invocation, before any verdict."""
    if INCLUDE_UNTRACKED:
        print("parity report: --include-untracked — UNTRACKED plans/specs are being read as "
              "inputs. Do not commit this output; its counts describe a tree only you have.",
              file=sys.stderr)
        return
    if not _ANNOUNCED:
        return
    print(f"parity report: {len(_ANNOUNCED)} untracked input(s) EXCLUDED — this report and "
          "its --check verdict describe the committed tree, not your working tree:",
          file=sys.stderr)
    for rel in _ANNOUNCED:
        print(f"  - {rel}", file=sys.stderr)


def load_claude_pages():
    """`{slug: title}` for every page in Claude Code's `llms.txt` snapshot.

    This is BOTH the allowlist and the denominator. Without it the report keyed
    a table headed "By Claude's documentation" off any cited `.md`, so Codex's
    `submission-errors.md`, the MCP spec's `elicitation.md` and names that are
    neither (`cmd.md`, `react.md`, `style.md`) read as Claude contracts — and
    the pages we never cited, the ones a coverage map exists to show, were
    absent entirely. Refresh with `scripts/refresh-claude-doc-pages.py`.
    """
    pages = {}
    for line in PAGES_TSV.read_text().splitlines():
        if line.startswith("#") or "\t" not in line:
            continue
        slug, title = line.split("\t", 1)
        pages[slug] = title
    return pages


CLAUDE_PAGES = load_claude_pages()
# A bare `hooks.md` could be `hooks` or `agent-sdk/hooks`. Resolve to the
# top-level page when one exists — that is how this repo's plans use the bare
# name — and to the sole namespaced page when it does not (`tool-search.md` is
# only ever `agent-sdk/tool-search`).
_BY_LEAF = collections.defaultdict(list)
for _slug in CLAUDE_PAGES:
    _BY_LEAF[_slug.split("/")[-1]].append(_slug)
LEAF_TO_SLUG = {
    leaf: (leaf if leaf in slugs else sorted(slugs)[0])
    for leaf, slugs in _BY_LEAF.items()
}


def doc_pages(text, ours=frozenset(), foreign=None):
    """Claude documentation pages this text cites, as canonical `llms.txt` slugs.

    A cited name that is not a Claude page is collected into `foreign` rather
    than silently admitted or silently dropped: this repo cites Codex and MCP
    docs on purpose, and the report has to be able to say so.

    The leaf rule is NARROW on purpose (P6.925, measured 2026-09-08 over
    `docs/superpowers/{plans,specs}/*.md` + `AGENTS.md`): resolving ANY prefixed
    name by its leaf credited 137 foreign citations across 40 names to Claude
    pages of the same leaf — codex's `plugins/build/plugins.md` (17) to Claude's
    `plugins`, `learn.chatgpt.com/docs/hooks.md` (14) to `hooks`, `cli/index.md`
    (5) to `whats-new/index`, the two `overview.md` (15) to `overview` — so a
    Claude page read as cited when only a foreign page of the same name was
    named, and the codex citation vanished from §3b. Only two prefixes are
    Claude's own: none at all (how this repo's plans cite a page) and `en/`
    (the documented URL carries it). Everything else falls through to `foreign`.
    """
    out = set()
    for name in DOC_RE.findall(text):
        leaf = name.split("/")[-1]
        # `ours` carries every plan's name with its date prefix stripped: plans
        # cite each other both ways, and an undated citation is still us.
        if leaf in DOC_SKIP or leaf in ours or PLAN_RE.match(leaf) or leaf[:4].isdigit():
            continue
        stem = name[:-3]
        prefix = name[: -len(leaf)]
        if stem in CLAUDE_PAGES:
            out.add(stem)
        elif prefix in ("", "en/") and leaf[:-3] in LEAF_TO_SLUG:
            out.add(LEAF_TO_SLUG[leaf[:-3]])
        elif is_our_file(name):
            _OUR_FILE_CITATIONS[name] += 1
        elif foreign is not None:
            foreign[name] += 1
    return out


SLUG_TOKEN = re.compile(r"^(?:[a-z][a-z0-9-]*/)?[a-z][a-z0-9-]*$")


def tracker_page_column(cell):
    """Claude pages named in the tracker's PAGE column, which omits `.md`.

    This is the citation form `DOC_RE` cannot see, and it is the one the coverage
    map already diagnosed by hand, twice, without anyone sweeping for it: R65 names
    its page as `agent-sdk/modifying-system-prompts`, R44 as `output-styles`, R53c as
    `statusline` — no suffix, so the detector that requires one read a closed row's
    own subject as uncited. Fifty-five pages are named here (measured 2026-08-28),
    among them every page whose map cell says "страница не открывалась" while a
    closed row cites it.

    Unlike a bare name in prose (`BARE_RE`, deliberately not admitted) this is
    unambiguous by position: the cell is a short list of what one status-bearing row
    closed. Rows that use the column for a title instead are filtered by the token
    shape — a title has spaces, a slug does not.
    """
    out = set()
    for token in re.split(r"[,/]|\sи\s", cell.replace("*", "")):
        token = token.strip().strip("`").strip()
        if not token or not SLUG_TOKEN.match(token):
            continue
        if token in CLAUDE_PAGES:
            out.add(token)
        elif token in LEAF_TO_SLUG:
            out.add(LEAF_TO_SLUG[token])
    return out


def bare_pages(text):
    """Claude pages this text names WITHOUT the `.md` suffix, inside backticks.

    Ambiguous by construction — see `BARE_RE`. Used only to label a slice of the
    uncited list, never to move a page out of it.
    """
    out = set()
    for name in BARE_RE.findall(text):
        if name in CLAUDE_PAGES:
            out.add(name)
        elif name in LEAF_TO_SLUG:
            out.add(LEAF_TO_SLUG[name])
    return out


# The coverage map's Pi verdict per page — the FIFTH input, and the only one this
# script reads rather than writes.
#
# It exists because the two artefacts were measured on 2026-08-28 to disagree by 74
# pages about what is uncovered (48 in-product pages not green on Pi, against 122
# "no row and no plan cites" here), and a reader's answer therefore depended on which
# file they opened — while the plan's stopping rule is coverage of this corpus. Most
# of that gap is NOT a detector error: 59 of the 122 are pages the map records as ⬜
# out-of-product and subtracts from its denominator, so the two numbers were never
# counting the same set. Printing the crosswalk makes that visible in the artefact
# instead of leaving it to be rediscovered.
#
# Deliberately tolerant: a map that cannot be parsed degrades to an empty crosswalk
# and a stated reason, because a hand-maintained table must never be able to break
# the generated report.
MAP_ROW = re.compile(r"^\|\s*\d+\s*\|")
MAP_SLUG = re.compile(r"\[`([^`]+)`\]")


def load_pi_verdicts():
    """`{slug: glyph}` from the coverage map's Pi column, or `{}` if unreadable."""
    try:
        text = COVERAGE_MAP.read_text()
    except OSError:
        return {}
    out = {}
    for line in text.split("\n"):
        if not MAP_ROW.match(line):
            continue
        cells = re.split(r"(?<!\\)\|", line)
        if len(cells) < 8:
            continue
        slug = MAP_SLUG.search(cells[2])
        pi = cells[4].strip()
        if slug and pi and pi[0] in "🟩🟨🟥⏸⬜":
            out[slug.group(1)] = pi[0]
    return out


def flatten(text):
    return re.sub(r"\s+", " ", text.replace("**", "").replace("`", "")).strip()


def clip(text, limit):
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def plan_links(text, known):
    """Link every plan this text names, once each, in order of appearance."""
    out, seen = [], set()
    for stem in PLAN_RE.findall(text):
        if stem in seen or stem not in known:
            continue
        seen.add(stem)
        out.append("[%s](../plans/%s.md)" % (stem[11:], stem))
    return ", ".join(out)


def parse_tracker(known_plans, our_names=frozenset(), foreign=None):
    rows = []
    for line in TRACKER.read_text().split("\n"):
        if not line.startswith("|"):
            continue
        cells = line.split("|")
        if len(cells) < 9:
            continue
        status = cells[3].strip()
        if status not in LABEL:
            continue
        raw_evidence = cells[8]
        # Scan the WHOLE row for plan references, not just the evidence cell —
        # a plan is named in the scope column about as often, and reading one
        # cell is how the first draft printed "—" for rows that do have a plan.
        raw_row = line
        surface = flatten(cells[5])
        scope = flatten(cells[4])
        name = surface if surface and surface not in ("—", "?") else scope
        name = re.sub(r"^(deepens|closes|adds)\s+", "", name).strip()
        rows.append(
            {
                "ord": flatten(cells[1]) or "—",
                "unit": flatten(cells[2]) or "—",
                "status": status,
                "name": name or "—",
                "evidence": flatten(raw_evidence),
                "plans": plan_links(raw_row, known_plans),
                "planStems": [st for st in PLAN_RE.findall(raw_row) if st in known_plans],
                "docs": doc_pages(raw_row, our_names, foreign) | tracker_page_column(cells[5]),
            }
        )
    if not rows:
        sys.exit("tracker: parsed zero rows — the table shape changed")
    return rows


def parse_register():
    src = REGISTER.read_text()
    rows = []
    for section in re.split(r"^### ", src, flags=re.M)[1:]:
        head = section.split("\n", 1)[0].strip().strip("`")
        head = head.replace("Recorded while executing ", "")
        for category, _body in re.findall(r"^- \*\*(.+?)\*\* — (.+)$", section, flags=re.M):
            rows.append(
                {
                    "source": head,
                    "category": category.split(",")[-1].split("—")[0].strip(),
                }
            )
    declared = re.search(r"TOTAL[^\d]*(\d+)", src)
    if declared and int(declared.group(1)) != len(rows):
        sys.exit(
            "register: parsed %d rows but the file declares %s — refusing to print a wrong count"
            % (len(rows), declared.group(1))
        )
    if not rows:
        sys.exit("register: parsed zero rows — the bullet shape changed")
    return rows


def table(headers, rows):
    yield "| " + " | ".join(headers) + " |"
    yield "|" + "|".join(" --- " for _ in headers) + "|"
    for row in rows:
        yield "| " + " | ".join(row) + " |"


def main():
    known_plans = set(p.stem for p in tracked(PLANS.glob("*.md")))
    # A plan cited without its date is still a plan, not a Claude page.
    our_names = {stem[11:] + ".md" for stem in known_plans if stem[:4].isdigit()}
    known_specs = tracked(SPECS.glob("*.md"))
    our_names |= {p.name for p in known_specs}
    our_names |= {p.name[11:] for p in known_specs if p.name[:4].isdigit()}
    announce_inputs()
    # Names cited as documentation that are NOT Claude Code pages — Codex,
    # the MCP spec, and a few that are neither. Counted, then reported in §3
    # rather than folded in, which is the defect this section fixes.
    foreign = collections.Counter()
    tracker = parse_tracker(known_plans, our_names, foreign)
    register = parse_register()
    counts = collections.Counter(r["status"] for r in tracker)

    done = [r for r in tracker if r["status"] in DONE]
    open_rows = [r for r in tracker if r["status"] in OPEN]

    print("# Nessy ↔ Claude Code parity — the whole picture")
    print()
    print("**Generated. Do not hand-edit.** Regenerate:")
    print()
    print("```bash")
    print("python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md")
    print("python3 scripts/build-parity-report.py --check   # report drift, write nothing")
    print("```")
    print()
    print(
        "**Every number below is a snapshot of FIVE inputs, taken %s.** The rule used to "
        "say \"regenerate after any tracker change\", which could not keep this file true: "
        "the tracker "
        "([2026-07-25-nessy-claude-parity-audit.md](2026-07-25-nessy-claude-parity-audit.md)) "
        "is one input of five. The others are the deviation register "
        "([2026-07-29-deviation-register.md](2026-07-29-deviation-register.md)), the corpus "
        "snapshot [`scripts/claude-doc-pages.tsv`](../../../scripts/claude-doc-pages.tsv) — "
        "which supplies the page denominator, so a corpus refresh moves §3 without anyone "
        "touching a row — and the FULL TEXT of every plan under `docs/superpowers/plans/`, "
        "read as a directory glob, because §3's page axis is harvested from the pages each "
        "plan cites — EVERY plan, since 2026-08-28: until then only the 55 of 134 that some "
        "tracker row happens to link were consumed, and fifteen pages a plan cites by full "
        "name read as cited by nobody. The fifth is the coverage map "
        "([2026-07-31-claude-coverage-map.md](2026-07-31-claude-coverage-map.md)), read only "
        "to print §3a's crosswalk, so that this file and that one can no longer be quoted "
        "against each other. One consequence, measured 2026-08-25: this file goes stale on any "
        "plan commit, not only a tracker one. A second one is now FIXED rather than warned "
        "about — an untracked plan in the working tree used to land in the output (one such "
        "file moved §3b from 85 foreign names to 87) and, worse, to be counted by `--check`, "
        "which reported 8 differing lines on `feat/TCODE-000` where only 2 were real. Inputs "
        "are now taken from git's index, so both this file and its `--check` verdict describe "
        "the committed tree; anything skipped is named on stderr. The stamp above is the "
        "newest COMMIT date among those five inputs and never the clock, so a report "
        "regenerated on a later day is byte-identical — which is what lets CI reproduce this "
        "file from HEAD instead of reading a fresh date as drift. Run `--check` before "
        "trusting a count."
        % provenance_stamp()
    )
    print()
    print(
        "**%d of %d rows are built** (%d matched, %d where we are ahead of the documented "
        "behaviour). **%d are open.** Beyond the rows, **%d deviations** are recorded — "
        "documented behaviours we chose not to build, each with a written reason."
        % (len(done), len(tracker), counts.get("✅", 0), counts.get("\U0001f6e1", 0),
           len(open_rows), len(register))
    )
    print()
    print(
        "Detail is one link away by design: a row's commits, probes and every correction an "
        "executor made live in the tracker "
        "([2026-07-25-nessy-claude-parity-audit.md](2026-07-25-nessy-claude-parity-audit.md)); "
        "a deviation's full reason lives in the plan that recorded it."
    )
    print()

    print("## 1. What we have")
    print()
    print(
        "%d rows. The `plan` column links the plan that built it; a row without one was "
        "built directly from the tracker's own scope." % len(done)
    )
    print()
    for line in table(
        ["", "ord", "unit", "behaviour", "plan"],
        [[r["status"], r["ord"], r["unit"], clip(r["name"], 80), r["plans"] or "—"] for r in done],
    ):
        print(line)
    print()

    print("## 2. What is deferred or divergent")
    print()
    print(
        "**The `plan` column answers \"is anyone going to do this?\"** — a link means the "
        "work is planned and the plan says how; `—` means no plan exists yet."
    )
    print()

    print("### 2a. Open parity rows — %d" % len(open_rows))
    print()
    for line in table(
        ["", "ord", "unit", "behaviour", "what is missing", "plan"],
        [
            [
                # A row with a plan is owned, whatever its glyph says. Printing
                # "unowned" beside a plan link is the report contradicting itself.
                r["status"] + " " + ("planned" if r["plans"] and r["status"] == "\u2b1c" else LABEL[r["status"]]),
                r["ord"],
                r["unit"],
                clip(r["name"], 60),
                clip(r["evidence"], 220) or "—",
                r["plans"] or "—",
            ]
            for r in open_rows
        ],
    ):
        print(line)
    print()

    by_source = collections.Counter(r["source"] for r in register)
    by_cat = collections.Counter(r["category"] for r in register)
    print("### 2b. Recorded deviations — %d" % len(register))
    print()
    print(
        "%d buildable but deliberately not built, %d impossible on this runtime, %d with no "
        "counterpart in this product. **None of these is planned work** — each is a recorded "
        "decision, and the plan linked below carries its reason. The audit's rule is that a gap "
        "may be left open but never left unnamed."
        % (by_cat.get("not implemented", 0), by_cat.get("impossible", 0), by_cat.get("inapplicable", 0))
    )
    print()
    print()
    print("## 3. By Claude's documentation")
    print()
    print(
        "The same picture from the contract's side. **Claude Code's docs are a "
        "contract source for this fork, not inspiration** — so this table answers "
        "the question a reviewer actually asks: *for THIS page, where do we stand?* "
        "It is the axis to use when a page changes upstream."
    )
    print()
    print(
        "A page's row set is harvested from the tracker row AND from the plan that "
        "built it, because most citations live in the plan. **Line numbers are "
        "deliberately not carried here:** pages grow, and this audit has already "
        "had six citations drift by seven lines when a page changed between two "
        "fetches. The quoted sentence in the plan is the identifier; this table is "
        "the map to it."
    )
    print()
    print(
        "**Every page in `llms.txt` is listed, including the ones nothing cites** "
        "— a coverage map without its denominator is a list of what we happened "
        "to look at. Pages are validated against "
        "[`scripts/claude-doc-pages.tsv`](../../../scripts/claude-doc-pages.tsv); "
        "before that allowlist existed this table admitted Codex and MCP pages "
        "under a heading that says Claude, and omitted the uncited pages entirely."
    )
    print()

    plan_docs = {}
    for stem in known_plans:
        try:
            plan_docs[stem] = doc_pages(
                (PLANS / (stem + ".md")).read_text(), our_names, foreign
            )
        except OSError:
            plan_docs[stem] = set()

    by_page = collections.defaultdict(lambda: {"rows": [], "plans": set(), "citing": set()})
    for r in tracker:
        cited = set(r["docs"])
        for stem in r["planStems"]:
            cited |= plan_docs.get(stem, set())
        for page in cited:
            by_page[page]["rows"].append(r)
            by_page[page]["plans"].update(r["planStems"])
            by_page[page]["citing"].update(r["planStems"])

    # A plan that no tracker row happens to LINK still cites the pages it cites.
    #
    # This loop is a bug fix, measured 2026-08-28. `plan_docs` above reads every plan
    # in the directory — as the provenance paragraph promises — and the loop before
    # this one then consumed only the 55 of 134 plans some tracker row names, so 79
    # plans were parsed and thrown away. Fifteen pages read as "cited by nobody" while
    # a plan cited them by full `.md` name, five of them among the seven pages the map
    # marks 🟩 and this table called uncited: `agent-sdk/modifying-system-prompts` (12
    # citations in `2026-07-29-output-style-contract.md`), `agent-sdk/skills`,
    # `code-review`, `gateways`, `managed-mcp`. The published cause of that
    # contradiction was `DOC_RE`'s `.md` requirement; it is this instead, and the two
    # are distinguishable because these five carry the suffix.
    #
    # Such a page has no tracker row, so it lands in the table with an em dash under
    # "our rows" and a state that says exactly that — which is weaker evidence than a
    # row, and stronger than the silence it replaces.
    for stem in known_plans:
        for page in plan_docs.get(stem, set()):
            by_page[page]["citing"].add(stem)

    # the register keys its sections by `plans/<stem>.md`
    dev_by_stem = collections.Counter()
    for row in register:
        stem = row["source"].split("/")[-1]
        if stem.endswith(".md"):
            stem = stem[:-3]
        dev_by_stem[stem] += 1

    def page_state(page):
        rows = by_page[page]["rows"]
        if not rows:
            # No tracker row — the page is here because a plan cites it. Saying
            # "all built" would be this table asserting a contract off zero rows.
            return "no row — cited by %s" % ", ".join(
                "[%s](../plans/%s.md)" % (st[11:], st)
                for st in sorted(by_page[page]["citing"])
            )
        open_rows = [r for r in rows if r["status"] in OPEN]
        if not open_rows:
            return "all built"
        return "%d open: %s" % (
            len(open_rows),
            " ".join(sorted(r["unit"] for r in open_rows)),
        )

    cited_pages = sorted(by_page, key=lambda p: (-len(by_page[p]["rows"]), p))
    uncited = sorted(set(CLAUDE_PAGES) - set(by_page))
    plan_only = [p for p in cited_pages if not by_page[p]["rows"]]
    print(
        "**%d of %d pages are cited by a row or a plan; %d are cited by neither.** "
        "Of the %d, %d carry a tracker row and %d are cited only by a plan — the "
        "`state` column says which."
        % (
            len(by_page),
            len(CLAUDE_PAGES),
            len(uncited),
            len(by_page),
            len(by_page) - len(plan_only),
            len(plan_only),
        )
    )
    print()
    for line in table(
        ["Claude page", "our rows", "state", "recorded deviations"],
        [
            [
                "`%s`" % page,
                " ".join(sorted({r["unit"] for r in by_page[page]["rows"]})) or "—",
                page_state(page),
                str(sum(dev_by_stem.get(st, 0) for st in by_page[page]["plans"])),
            ]
            for page in cited_pages
        ],
    ):
        print(line)

    print()
    print("### 3a. Claude pages no row and no plan cites — %d" % len(uncited))
    print()
    print(
        "**Uncited is not the same as unread, and neither is the same as "
        "unimplemented.** But this series' own rule is that a plan or commit "
        "cites the page it implements against, so by our own standard nothing "
        "here has been verified. A page may well resolve to one line of "
        "`inapplicable`; the point is that the line does not exist yet."
    )
    print()

    pi = load_pi_verdicts()
    bare_named = set()
    for text in [TRACKER.read_text()] + [
        (PLANS / (stem + ".md")).read_text() for stem in sorted(known_plans)
        if (PLANS / (stem + ".md")).exists()
    ]:
        bare_named |= bare_pages(text)
    bare_named &= set(uncited)

    print(
        "**This number and the coverage map's are not the same measurement, and the "
        "crosswalk below is here so nobody has to guess which to believe.** "
        "[`2026-07-31-claude-coverage-map.md`](2026-07-31-claude-coverage-map.md) "
        "counts *in-product pages not green on Pi* and subtracts every ⬜ page from "
        "its denominator; this section counts *pages nothing cites*, over the whole "
        "corpus. Most of the gap between the two is that ⬜ subtraction, not a "
        "disagreement about coverage. A page that is 🟩 here IS a disagreement — 🟩 "
        "means the map found a closed row citing the page, which is the thing this "
        "section says does not exist."
    )
    print()
    if pi:
        buckets = collections.Counter(pi.get(page, "?") for page in uncited)
        for line in table(
            ["map's Pi verdict", "pages", "how to read it"],
            [
                ["⬜", str(buckets.get("⬜", 0)),
                 "out of product — **excluded from the map's denominator**, counted here"],
                ["🟨", str(buckets.get("🟨", 0)), "feature exists, contract not taken — both agree"],
                ["🟥", str(buckets.get("🟥", 0)), "gap — both agree"],
                ["⏸", str(buckets.get("⏸", 0)), "row open or parked — both agree"],
                ["🟩", str(buckets.get("🟩", 0)),
                 "**contradiction**: the map says a closed row cites it and this section says none does"],
                ["not in the map", str(buckets.get("?", 0)), "a row is missing from the map"],
            ],
        ):
            print(line)
        print()
        contradictions = sorted(p for p in uncited if pi.get(p) == "🟩")
        weekly = [p for p in contradictions if p.startswith("whats-new/")]
        rest = [p for p in contradictions if not p.startswith("whats-new/")]
        if weekly:
            print(
                "**%d of the %d contradictions are weekly changelog pages** (%s) and are "
                "explained rather than open: a week's read is recorded in a findings SPEC, "
                "not in a plan, and this section scans plans. They are left in the count "
                "instead of allowlisted away, because the map's own convention is that a "
                "weekly verdict asserts the week was read AND its findings decomposed — and "
                "only two weeks have a full decomposition."
                % (len(weekly), len(contradictions), ", ".join("`%s`" % p for p in weekly))
            )
            print()
        if rest:
            print(
                "**The remaining %d %s a real contradiction**: %s. Nothing in the tracker or "
                "in any plan cites %s, so the 🟩 rests on something other than the closed row "
                "the map's own definition of 🟩 requires."
                % (
                    len(rest),
                    "is" if len(rest) == 1 else "are",
                    ", ".join("`%s`" % p for p in rest),
                    "it" if len(rest) == 1 else "them",
                )
            )
            print()
    else:
        print(
            "*(The coverage map could not be parsed, so the crosswalk is omitted "
            "rather than guessed.)*"
        )
        print()
    if bare_named:
        print(
            "**%d of these pages ARE named somewhere in the tracker or a plan, but "
            "without the `.md` suffix** (`` `%s` ``-style, usually as a unit name). "
            "They stay counted as uncited: measured, most such mentions are lists of "
            "names or coincident unit names rather than citations, and admitting them "
            "would certify contracts nobody took. Named here so the ambiguity is "
            "visible instead of silent: %s."
            % (
                len(bare_named),
                sorted(bare_named)[0],
                ", ".join("`%s`" % p for p in sorted(bare_named)),
            )
        )
        print()
    for line in table(
        ["Claude page", "map's Pi verdict", "what it is"],
        [
            ["`%s`" % page, pi.get(page, "—"), CLAUDE_PAGES[page]]
            for page in uncited
        ],
    ):
        print(line)

    if foreign:
        print()
        print(
            "### 3b. Cited as documentation, but not a Claude Code page — %d"
            % len(foreign)
        )
        print()
        print(
            "Kept visible rather than dropped. Codex and MCP pages are real "
            "contract sources for this fork (`AGENTS.md` names them), they are "
            "just not *this* contract — and folding them in is what made the "
            "table above unusable as a coverage map. A name here that is neither "
            "is a citation typo worth fixing at the source."
        )
        print()
        print(
            "%d name(s) were filtered out before this table as OUR OWN files "
            "rather than anyone's documentation: lane reports and the "
            "controller's hand-off file, which live outside this repository, and "
            "names resolving to a tracked document under `docs/` or `docs-site/`. "
            "That filter runs only after a name has failed to resolve against "
            "`scripts/claude-doc-pages.tsv`, so it cannot hide a Claude page."
            % len(_OUR_FILE_CITATIONS)
        )
        print()
        for line in table(
            ["cited name", "times"],
            [
                ["`%s`" % name, str(n)]
                for name, n in sorted(foreign.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
        ):
            print(line)

    print()
    print("## 4. Deviations by the plan that recorded them")
    print()
    for line in table(
        ["recorded while executing", "deviations"],
        [
            [
                "[%s](../plans/%s.md)" % (src[11:], src) if src in known_plans else src,
                str(count),
            ]
            for src, count in sorted(by_source.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    ):
        print(line)
    print()


# ---------------------------------------------------------------------------
# `--self-test`: the harvester read against a FIXTURE, never against its own output
#
# P6.923. `--check` regenerates and diffs against the committed artifact, which
# answers "is this file stale?" and CANNOT answer "does the harvester still see a
# real citation?" — a filter that starts dropping one changes BOTH sides of that
# comparison as soon as the artifact is regenerated, and the number just gets
# smaller with nobody able to say why. P6.921 tightened two filters here and its
# evidence was a hand-built control (generate before and after, diff every section
# except the one under change) that leaves no artefact and nobody can re-derive.
# This is that control made cheap, repeatable and wired into `lint:chain`; it is
# the only test any of `scripts/*.py` has.
#
# Each case is one string in and three sets out — the pages `doc_pages` admits,
# the names it hands to the foreign bucket, and the names `is_our_file` removes.
# Three sets rather than one on purpose: a case then fails in the DANGEROUS
# direction (a real citation quietly reclassified as ours) exactly as loudly as
# in the harmless one, which a count of admitted pages cannot do.
#
# The two anchors that must exist in the corpus snapshot are asserted BEFORE the
# cases run, so a refreshed `claude-doc-pages.tsv` that drops one says "pick
# another anchor" instead of printing a mismatch that reads like a regression.
# ---------------------------------------------------------------------------
# The top-level anchor was `plugins-reference` until 2026-10-01, when the plugin docs
# moved under `plugins/` and it left `llms.txt` (F1.1033). Its successors are all
# NAMESPACED, which is the other case's shape, so the top-level, hyphenated slot went to
# `settings-reference` — another `<word>-reference` page at the top level of the corpus.
SELF_TEST_PAGE_ANCHORS = ("settings-reference", "agent-sdk/hooks")


def _self_test_our_doc():
    """A tracked `docs/architecture/<name>.md` path, taken from git's index.

    Derived, never hand-pinned: a pinned filename makes the case assert that ONE
    file still exists, where the thing under test is the suffix rule in
    `is_our_file`. `None` when the directory is empty, which the caller reports
    as an inconclusive case rather than passing it.

    A name whose stem is ALSO a Claude page is skipped, because such a name never
    reaches `is_our_file` — the page lookup answers first — so a case built on one
    would test nothing and look like it tested the filter.
    """
    for path in _OUR_DOCS:
        if not path.startswith("docs/architecture/") or path.count("/") != 2:
            continue
        stem = path.split("/")[-1][:-3]
        if stem in CLAUDE_PAGES or stem in LEAF_TO_SLUG or path.split("/")[-1] in DOC_SKIP:
            continue
        return path
    return None


def _self_test_cases():
    """`(label, text, pages, foreign, ours)` — the fixture, with its reasons."""
    our_doc = _self_test_our_doc()
    cases = [
        # The two forms a Claude page is cited in. Both must resolve to a slug.
        ("Claude page, top level",
         "the field is documented in `settings-reference.md` today",
         {"settings-reference"}, set(), set()),
        ("Claude page, namespaced",
         "read `agent-sdk/hooks.md` before assuming the behaviour is ours",
         {"agent-sdk/hooks"}, set(), set()),
        # P6.925 (2026-09-10) FIXED what this case used to pin as measured-not-
        # endorsed: a codex page resolved by LEAF to the Claude page of the same
        # name, so `plugins/build/plugins.md` was credited to Claude's `plugins`
        # — 137 occurrences across 40 names, and each one hid a codex citation
        # from §3b. The leaf rule now fires for an unprefixed name and for `en/`
        # only; every other namespace falls through to foreign. The two halves
        # are pinned as two cases so a future widening trips the first and a
        # future narrowing trips the second. `DOC_RE` captures at most ONE
        # leading segment, so the deep codex path arrives as `build/plugins.md`
        # — that truncated name is what reaches the foreign bucket, and it is
        # what §3b reports.
        ("codex page, NOT leaf-resolved to a Claude page",
         "the codex manifest fields live in `plugins/build/plugins.md`",
         set(), {"build/plugins.md"}, set()),
        # The half the leaf rule exists for: the documented Claude URL carries
        # `/en/`, so `en/<page>.md` is the same page as `<page>.md`. Anchored on
        # `settings-reference`, already in `SELF_TEST_PAGE_ANCHORS`.
        ("Claude page under the documented `en/` prefix",
         "the anchor is `en/settings-reference.md` on the rendered page",
         {"settings-reference"}, set(), set()),
        # The P6.921 regex: `\b` matched after a hyphen, so the TAIL of every lane
        # report was harvested as a page (`e-report.md`, 16 occurrences).
        ("lane report with an upper-case lane id",
         "the measurement is in `lane-W9-e-report.md`, outside this repo",
         set(), set(), set()),
        # The other half of the same defect, and the ONLY case that reaches
        # `OUR_WORKING_FILE_RE`: a lowercase lane id still matches `DOC_RE`, so the
        # filename test is what keeps it out. Delete the regex and this case fails
        # while the one above still passes.
        ("lane report the regex alone cannot stop",
         "the measurement is in `s1-report.md`, outside this repo",
         set(), set(), {"s1-report.md"}),
        ("the controller's hand-off file",
         "live file locks are in `rezone.md`",
         set(), set(), {"rezone.md"}),
        # `\b` also matched after a DOT: `AGENTS.override.md` was read as a page
        # named `override.md`.
        ("a dotted name of ours",
         "a project override belongs in `AGENTS.override.md`",
         set(), set(), set()),
        # A dated name is one of our plans, never a contract.
        ("one of our dated plans",
         "the tracker is `2026-08-22-runtime-parity-closure.md`",
         set(), set(), set()),
        # The suffix test in `is_our_file`, on a real tracked path.
        ("one of our own documents",
         f"the gaps are listed in `{our_doc}`" if our_doc else None,
         set(), set(), {our_doc[len("docs/"):]} if our_doc else set()),
        # The DANGEROUS direction, and the only case that can see it: a foreign
        # path that merely SHARES A LEAF with one of our documents. `is_our_file`
        # matches a path SUFFIX on a component boundary, so this stays foreign;
        # under the leaf-only rule W9-bo rejected it would be filtered away as
        # ours, which is a real citation dropped, silently, into a smaller number.
        ("a foreign path sharing a leaf with one of ours",
         f"the codex tree writes `codex/{our_doc.split('/')[-1]}`" if our_doc else None,
         set(), {f"codex/{our_doc.split('/')[-1]}"} if our_doc else set(), set()),
        # The codex example that motivated rejecting the leaf rule. It survives as
        # foreign here for a NARROWER reason than W9-bo's report gives: the
        # `commands/deploy.md` that would have collided with it is a format-adapter
        # fixture under `packages/`, and `_OUR_DOCS` lists `docs/` and `docs-site/`
        # only — so it is the case above, not this one, that separates leaf from
        # suffix. Kept because a codex example reaching the foreign bucket at all
        # is what §3b exists to report.
        ("a codex example that must SURVIVE as foreign",
         "the codex tree writes `specialized/deploy.md`",
         set(), {"specialized/deploy.md"}, set()),
    ]
    return cases


def self_test() -> int:
    """Assert `doc_pages` over the fixture above. Non-zero on any mismatch."""
    missing = [slug for slug in SELF_TEST_PAGE_ANCHORS if slug not in CLAUDE_PAGES]
    if missing:
        print(
            "parity report self-test: the corpus snapshot no longer carries "
            f"{', '.join(missing)} — these are the fixture's anchors, so pick another page "
            "from scripts/claude-doc-pages.tsv rather than relaxing the case.",
            file=sys.stderr,
        )
        return 1

    width = max(len(label) for label, *_ in _self_test_cases())
    failures = 0
    for label, text, want_pages, want_foreign, want_ours in _self_test_cases():
        if text is None:
            print(f"FAIL  {label.ljust(width)}  no tracked docs/architecture/*.md to derive the "
                  "case from", file=sys.stderr)
            failures += 1
            continue
        foreign = collections.Counter()
        before = dict(_OUR_FILE_CITATIONS)
        pages = doc_pages(text, foreign=foreign)
        ours = {name for name, n in _OUR_FILE_CITATIONS.items() if before.get(name, 0) != n}
        _OUR_FILE_CITATIONS.clear()
        _OUR_FILE_CITATIONS.update(before)
        ok = (pages, set(foreign), ours) == (want_pages, want_foreign, want_ours)
        failures += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'}  {label.ljust(width)}  "
              f"pages={sorted(pages)} foreign={sorted(foreign)} ours={sorted(ours)}")
        if not ok:
            print(f"      expected  pages={sorted(want_pages)} foreign={sorted(want_foreign)} "
                  f"ours={sorted(want_ours)}", file=sys.stderr)

    if failures:
        print(f"parity report self-test: {failures} case(s) FAILED — the citation harvester "
              "changed behaviour. Read the case's comment before adjusting its expectation: "
              "each one records a measurement.", file=sys.stderr)
        return 1
    print(f"parity report self-test: {len(_self_test_cases())} cases, harvester unchanged")
    return 0


def normalise(text: str) -> str:
    """Drop the generated stamp so `--check` reports content drift, not re-dating."""
    return "\n".join(
        DATE_TOKEN.sub("<date>", line, count=1) if line.startswith(PROVENANCE_PREFIX) else line
        for line in text.split("\n")
    )


def check() -> int:
    """Regenerate in memory and diff against the committed artifact.

    This exists because the failure mode is not a wrong generator — measured
    2026-08-25, this script reproduces its artifact BYTE-IDENTICALLY at the commit
    that produced it (`83de2c0bb`, 0 diff lines). The failure mode is that four
    inputs move independently and nobody re-runs it, so the file reads as current
    while its counts belong to an earlier tree: the committed artifact said 364
    deviations where the register said 363, because one deviation was re-cut from
    `documented, not implemented` to `documented, implemented` when P2.3 closed it
    (`d0595f05a`), and a closed deviation is no longer a deviation. A generator
    nobody can ask "are you stale?" gets discovered by a reviewer instead.

    The precedent is `scripts/sort-plan-tracker.py --check`: fix by default,
    report under --check. `scripts/check-coverage-map.ts` used to be the second
    one and is not any more — P6.876 made every run of it read-only unless
    `--write` is passed, because its bare invocation reads like a diagnostic.
    """
    buffer = io.StringIO()
    stdout, sys.stdout = sys.stdout, buffer
    try:
        main()
    finally:
        sys.stdout = stdout
    fresh, committed = normalise(buffer.getvalue()), normalise(ARTIFACT.read_text())
    if fresh == committed:
        print("parity report: up to date with the tracker, register, corpus snapshot and plans")
        return 0
    diff = list(difflib.unified_diff(
        committed.split("\n"), fresh.split("\n"),
        fromfile="committed", tofile="regenerated", lineterm="", n=0,
    ))
    for line in diff[:40]:
        print(line, file=sys.stderr)
    if len(diff) > 40:
        print(f"… {len(diff) - 40} more diff lines", file=sys.stderr)
    print(
        f"parity report: STALE — {sum(1 for l in diff if l[:1] in '+-' and l[:3] not in ('+++', '---'))}"
        " line(s) differ. " + (
            "This drift is REAL: untracked plans and specs were excluded from the comparison"
            " (any that exist are named above), so it is not the working tree talking."
            if _INPUTS_TRUSTED else
            "CAUTION: untracked plans and specs were NOT excluded (see the warning above), so"
            " part of this drift may be your working tree rather than the committed one."
        ) +
        "\n  python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    _ARGS = sys.argv[1:]
    raise SystemExit(
        self_test() if "--self-test" in _ARGS else check() if "--check" in _ARGS else main()
    )
