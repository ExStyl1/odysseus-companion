#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Two axes, deliberately: the tracker says how much WORK is queued, the
capability ledger says how much of the PRODUCT a user can rely on per runtime.
Neither answers the other's question."""
import io
import sys, re, sys, collections

PLAN = 'docs/superpowers/plans/2026-08-22-runtime-parity-closure.md'
LEDGER = 'docs/superpowers/specs/2026-08-28-capability-ledger.md'
SPLIT = re.compile(r'(?<!\\)\|')
CAP_ID = re.compile(r'[A-Z]\d+')
# The switch cell carries free prose after the verdict; take only the first
# backticked token, and only if it is in the vocabulary.
SWITCH_VOCAB = ('UNIFORM', 'HOST', 'HONEST', 'REPORTED',
                'SILENT-LOOSER', 'SILENT', 'ADVERTISED')
# A head token shaped like a verdict — one shouted word — but absent from the
# vocabulary above. See `switch_verdict`: it is a claim written in a word this
# file does not define, and it must not be scored as silence.
SHOUTED = re.compile(r'[A-Z][A-Z-]{2,}')
# C3.44 — a cell whose subject has MOVED to a row of another plan, named.
#
# The owner's 2026-09-10 ruling relocates work out of this plan with verdicts
# intact, and a relocated cell is neither covered nor owed HERE: counting it
# understates the ledger exactly the way an unmeasured silence does, and reads
# identically. The annotation is the difference, and it is written as a second
# backticked token AFTER the verdict word so the word stays readable.
#
# MEASURED 2026-09-12 before this reader existed, both spellings, because the
# row's own premise said an annotation "would score as silence" and that is true
# of only one of them. `absent ʰ` followed by the annotation scored a plain
# `absent` with NO warning — the exclusion simply did not happen, quietly — while
# the annotation written INSTEAD of the verdict scored `no-claim` AND tripped the
# shape check by name. So the failure this reader ends is the quiet one.
MOVED_ANNOTATION = re.compile(r'`moved: *([A-Z]\d+\.\d+)`')


# D1.85 (owner, 2026-09-17) — the SIXTH marker, `ʳ`, and why it is not the `ᵈ`
# the decision named.
#
# The owner asked for a sixth marker `ᵈ` (driven) "defined beside the five".
# `ᵈ` is not free: it is the doc-only marker, the WEAKEST in the ordering, and
# the census below answered **32 cells** wearing it on 2026-09-17 (Pi 5 ·
# Claude 10 · Codex 17) — against the ledger legend's own "Zero cells wear it",
# a 2026-09-09 reading that was true when it was written. Re-using the glyph
# would have re-labelled those 32 as the STRONGEST evidence this file has, in
# silence, which is the exact failure a provenance marker exists to prevent. So
# the definition is carried word for word and only the character moves: `ʳ` (a
# RIG run), 0 occurrences in either ledger or anywhere under `scripts/` before
# this line.
#
# It is FIRST in the class and first in `MARKERS` because the ordering is the
# legend's strength ordering: a driven arm with named controls proves BEHAVIOUR,
# where `ᵗ` proves only that a build landed — which is the whole of D1.85's
# subject. The controller's 2026-09-12 rule ("a live drive that confirms a
# tracker row's build keeps `ᵗ` with the drive in the Why") is thereby amended:
# such a cell now says so in its marker.
VERDICT_CELL = re.compile(r'`(covered|partial|absent|n/a)( [ʳᵗʰˢᵏᵈ])?`.*|`?[—-]`?|')

# P6.945 — the provenance markers were VALIDATED here and SCORED nowhere.
#
# `VERDICT_CELL` above accepts a verdict word plus at most one marker and warns
# otherwise: a SHAPE check. `verdict()` then strips the backticks and takes the
# leading word, so no marker moves any number this file prints. P6.938 measured
# the rest of the picture: `check-coverage-map.ts` DEFINES four of them and
# enforces them over the two coverage maps, never over this ledger — and its `ˢ`
# means SCOPE where the ledger's means PROPAGATED — so the doc-only marker has no
# reader anywhere in the tree and a marker cannot go red under any run.
#
# The census printed under the coverage table is that reader. It moves nothing,
# by design: a marker is EVIDENCE PROVENANCE, not a verdict, and scoring one into
# a percentage would let the strength of a claim be traded against its count. It
# sits beside the verdict columns so that a drift in the evidence behind a
# verdict is visible at the same moment as the verdict — 1 415 of 1 896 cells
# resting on a hand reading is a fact about this ledger, and it was invisible.
#
# P6.949 (owner, 2026-09-10): the census is a DESCRIPTION, not a claim. A count
# that is a reading with a date must not gate — so it has no pin, no `--check`
# and no `lint:` step, and its header says so where it prints. What CAN go red is
# the shape check above; what the census says is what the ledger says today.
#
# The order is the ledger legend's strength ordering, strongest first.
# D1.197 — THE ENFORCEMENT ARM FOR `ʳ`, LANDED AS A CENSUS AND NOT AS A GATE.
#
# The marker's definition is "a live arm on the packaged build whose report
# names the controls", and the obvious enforcement is that such a cell must cite
# the rig artefact that ran it — a `scripts/cdp/cases/<id>.ts`. It is NOT a gate
# here, and the reason is a measurement rather than caution.
#
# D1.85's first ten cells: A16/Pi, A16/Claude, A19/Codex and A76's three cite
# their case files; A22's three cells and A57/Claude cite none, and both were
# admitted deliberately — A22's control is *the session's own `permissionMode`
# read back FROM THE APP*, A57's is *this profile's own default is `auto`*, and
# neither sentence is weaker for naming a behaviour instead of a path. D1.196's
# second pass makes it worse rather than better: A7's three cells and A11/Codex
# cite a packaged 1.33.0 drive by SHA and lane id (`aefc24805`, W2-p8) with the
# per-arm control named in words (`cat` of a token file), and no case path at
# all. So an arm that FAILED would fire on 8 of 14 correct cells the day it
# landed — the cry-wolf shape AGENTS.md names, on the file's newest and
# strongest marker.
#
# What is printed instead is the RATIO, under the census, every run. It is the
# number that would have to reach its denominator before a gate is honest, and
# a reader can see it move without anybody's commit being blocked.
#
# It lives here rather than in `check-ledger-citations.ts`, which the row's zone
# named: that gate reads the ledgers for CITATIONS and never splits a row into
# cells or parses a marker (measured by D1.85), so putting it there would mean a
# second cell parser beside this working one — more code for a weaker reading.
RIG_ARTEFACT = re.compile(r'scripts/cdp/')

# D1.104 — THE VERDICT-WORD CHECK: what a TRUE cell can be checked AGAINST.
#
# `VERDICT_CELL` above is a SHAPE check — it says a cell reads `covered ᵗ` and
# never that the sentence is true. P6.1060 asked for the missing half, and the
# answer the ledger's own grammar makes possible is narrow and therefore
# checkable: `ᵗ` means *"a tracker row says this landed"*, so the row it names
# has to EXIST and has to be CLOSED. (`ʳ` has the same shape one step further
# out — a rig artefact — and D1.197 measured that arm and REFUSED it as a gate:
# it would have fired on 8 of 14 correct cells. The ratio it prints instead is
# above. This one is measured before it gates, for the same reason.)
#
# MEASURED 2026-09-17 before a line of it existed, over the live ledger:
# **486** rows carry at least one `ᵗ` cell, **481** name a plan row that is
# closed, **0** name only rows still open, and **5** name no plan row at all
# (C31 F8 J60 L11 L14). So the population the gate fires on is 1 %, it is
# actionable one row at a time, and it is nothing like the cry-wolf shape that
# refused the `ʳ` arm. It is still behind `--check-verdicts` rather than in the
# default run, because a census that starts failing a lane's `lint:chain` on a
# ledger edit somebody else made is how a guard gets switched off.
#
# The seven plans are the ones a ledger `Why` cites tracker rows of (UA1.1, 2026-10-02: the 1.41.0 `F1.*` plan — 49
# F1 ids cited — and the 1.42.0 `UA*.*` plan joined; UB1.1, 2026-10-15: the 1.43.0 `UB*.*` plan joined); an absent
# file is skipped, so a synthetic tree needs only the one it plants. A prefix is one or TWO letters (`DA1.75`,
# `UA1.1`); a one-letter regex read C31's two ids as none.
VERDICT_SOURCE_PLANS = (
    'docs/superpowers/plans/2026-08-22-runtime-parity-closure.md',
    'docs/superpowers/plans/2026-09-11-coverage-95-parity.md',
    'docs/superpowers/plans/2026-09-10-integrations-and-authorization.md',
    'docs/superpowers/plans/2026-08-22-dp-auth-wave2-and-mcp-exposure.md',
    'docs/superpowers/plans/2026-09-18-integrations-followup-1.41.0.md',
    'docs/superpowers/plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md',
    'docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md',
)
TRACKER_ROW_ID = re.compile(r'\b([A-Z]{1,2}\d+\.\d+)\b')
TRACKER_ROW = re.compile(r'^\| ([A-Z]{1,2}\d+\.\d+) \|')


def tracker_row_states():
    """Every tracker row id in the VERDICT_SOURCE_PLANS plans, mapped to its GLYPH_CLASS.

    One pass per file and one dict, because the alternative — grepping a plan
    per ledger row — is 633 greps over six files. A glyph outside GLYPH_CLASS
    maps to `'unknown-glyph'` rather than being dropped: an unreadable glyph is
    not evidence that a row landed, and silently treating it as one would be the
    same silence this check exists to end.
    """
    states = {}
    for path in VERDICT_SOURCE_PLANS:
        try:
            handle = io.open(path, encoding='utf-8')
        except IOError:
            continue
        with handle:
            for line in handle:
                matched = TRACKER_ROW.match(line)
                if not matched:
                    continue
                cells = [c.strip() for c in SPLIT.split(line)]
                if len(cells) < 6:
                    continue
                states[matched.group(1)] = GLYPH_CLASS.get(cells[3], 'unknown-glyph')
    return states

MARKERS = (
    ('ʳ', 'прогон'),
    ('ᵗ', 'трекер'),
    ('ʰ', 'вручную'),
    ('ˢ', 'перенесён'),
    ('ᵏ', 'проба'),
    ('ᵈ', 'док'),
)

# A tracker row, and ONLY a tracker row. `startswith('| P')` also matched the
# §Phase-density table (`| P2.1–100 | 100 | 100 | **1.00** |`), whose four
# rows survived the `len(cells) >= 6` filter with the glyph column reading
# `100` — truthy, so they were silently counted as parked and inflated the
# total by 4 (measured 2026-09-04, P3.362).
ROW = re.compile(r'^\| (P\d+\.\d+) \|')

# Subjects the NEVER-PINNED heuristic must NOT read as "the row landed here":
# record-keeping commits name row ids in order to say what a row still owes.
# Until 2026-09-08 only `docs(plan)` was skipped, so a `docs(ledger)` commit
# whose body said "P6.641 stays out" booked P6.641 as never-pinned — the
# heuristic reporting as lost the very row the commit recorded as NOT done
# (P6.813, measured on `1c212b93f`). Kept to the three scopes that write the
# registers a row's status is recorded in; every other `docs(...)` scope
# describes code and stays scanned.
RECORD_KEEPING_SUBJECTS = ('docs(plan)', 'docs(ledger)', 'docs(spec)')

# ONE meaning per glyph, read by BOTH readers below.
#
# Until 2026-09-04 there were two contradictory definitions in this one file:
# `main()` bucketed every non-✅ non-⬜ glyph as "parked", while `wave_delta`'s
# CLOSED set contained ⏸ — so PARKING a row was reported as CLOSING it, and a
# wave that answered nothing scored 9 closures (P3.362). Neither reader now
# carries its own table.
#
# The plan's own legend (§Status glyphs) is the authority for the first three:
#   ✅ done · ⬜ open and dispatchable · ⏸ open but BLOCKED ON AN OWNER ANSWER.
# ⏸ is therefore NOT a closure — the work is owed, the answer is owed with it.
# 🟨 and 🚧 are undefined in the legend and were counted both ways; recorded here
# as what the rows using them actually mean: 🟨 landed with its residue routed to
# a row of its own (a closure), 🚧 is in flight (still open).
GLYPH_CLASS = {
    '✅': 'done',
    '🟨': 'done',
    '⬜': 'open',
    '🚧': 'open',
    '⏸': 'blocked',
    '⛔': 'blocked',  # the wave-8 brief's BLOCKED glyph (bucket D): open, blocker named in the row, not owner-owed
}


# A RETIRED capability id: struck through, because the row was merged into an
# older one and must leave the denominator without leaving the file (P6.748).
# The strike is what removes it — `CAP_ID.fullmatch` refuses `~~J52~~` — and
# counting the strikes here is what keeps that removal auditable instead of
# silent, which is the same failure `switch_verdict` was carrying.
RETIRED_ID = re.compile(r'~~([A-Z]\d+)~~')
RETIRED = []

# The PROVENANCE LINK, read back (P6.776).
#
# A ledger row admitted from the denominator sweep opens its `Why` cell with
# *"P6.358, denominator `J5x`"* — the sweep row it was written FROM. P6.748
# measured that this one relation, greppable in one line, found two of the three
# duplicates the admission's keyword search missed (`J53`, `J56`); it was in the
# file the whole time and nobody read it back. These two patterns are that probe,
# run every time the coverage is printed.
DENOMINATOR_CITE = re.compile(r'denominator +`?([A-Z]\d+)`?')
# A retired row names what it was merged into: `**RETIRED … → `J12`.**`
MERGE_TARGET = re.compile(r'RETIRED[^\n→]*→\s*`([A-Z]\d+)`')
LIVE_IDS = []
CITES = []      # (live row id, cited denominator id)
MERGES = []     # (retired row id, merge target id)
MOVED_CELLS = []  # (row id, column name, destination row) — outside the arithmetic
MOVED_ROWS = []   # (row id, destination row) — a residue pointer; nothing leaves
# The column a verdict cell index belongs to, so the moved report can name it.
# The Host switch cell is deliberately NOT here: its grammar is its own (a
# vocabulary word or a dash, read by `switch_verdict`), so the verdict-shape
# guard below cannot protect it and it would need a second rule of its own. No
# switch verdict has been relocated; the day one is, this map gains `7: 'Host'`
# and that guard gains the switch arm — together, or neither.
MOVED_COLUMN = {3: 'Pi', 4: 'Claude', 5: 'Codex'}


def ledger_rows():
    for line in io.open(LEDGER, encoding='utf-8'):
        if not line.startswith('| '):
            continue
        cells = [c.strip() for c in SPLIT.split(line)]
        # ['', id, capability, Pi, Claude, Codex, why, switch, '']
        if len(cells) == 9 and RETIRED_ID.fullmatch(cells[1]):
            retired_id = RETIRED_ID.fullmatch(cells[1]).group(1)
            RETIRED.append(retired_id)
            target = MERGE_TARGET.search(line)
            MERGES.append((retired_id, target.group(1) if target else None))
            continue
        if len(cells) == 9 and CAP_ID.fullmatch(cells[1]):
            # D1.104 — a capability id used TWICE is two capabilities counted as
            # one subject and three cells each, and nothing in this file could
            # see it: `provenance_warnings` reads `denominator` links, never the
            # id column itself. Measured 2026-09-17: 633 rows, 632 distinct ids,
            # `J60` twice (an id that was ITSELF renamed out of a collision).
            if cells[1] in LIVE_IDS:
                sys.stderr.write('  ⚠ ledger id %s appears on more than one row — two capabilities under '
                                 'one id; every per-row count here is right and every id-keyed reading of '
                                 'this file is wrong\n' % cells[1])
            LIVE_IDS.append(cells[1])
            for cited in sorted(set(DENOMINATOR_CITE.findall(line))):
                CITES.append((cells[1], cited))
            # A verdict cell is a backticked verdict word plus an optional marker,
            # or a dash. Prose in a verdict column parsed WITHOUT a word once
            # (S3-0, 2026-09-03) — say so, and still yield the row.
            for k in (3, 4, 5):
                if not VERDICT_CELL.fullmatch(cells[k]):
                    sys.stderr.write('  ⚠ ledger row %s: verdict cell %d is not a verdict: %r\n'
                                     % (cells[1], k, cells[k][:60]))
            # A `moved:` in the WHY cell is a POINTER instead —
            # the row's residue lives elsewhere and no cell leaves the
            # arithmetic — which is the B10 shape, where the verdicts are covered
            # by code and only the evidence day was relocated.
            moved_here = False
            for k in MOVED_COLUMN:
                destination = moved_to(cells[k])
                if destination:
                    MOVED_CELLS.append((cells[1], MOVED_COLUMN[k], destination))
                    moved_here = True
            if not moved_here:
                for destination in sorted(set(MOVED_ANNOTATION.findall(cells[6]))):
                    MOVED_ROWS.append((cells[1], destination))
            yield cells
        elif len(cells) > 1 and CAP_ID.fullmatch(cells[1]):
            # A raw `||` inside a cell (measured 2026-09-03, S2-0) used to drop
            # the row WITHOUT a word and the total read 106 of 107. Say so.
            sys.stderr.write('  ⚠ ledger row %s has %d fields, not 9 — an unescaped `|` in a cell; the row is SKIPPED\n'
                             % (cells[1], len(cells)))


def provenance_warnings():
    """Read the `denominator <id>` links back, and say when one is broken.

    WHAT IS AND IS NOT A DEFECT — measured against the ledger at `6614c898d`,
    where P6.748 had just merged all seven duplicates, so a correct file was
    available as the control:

      * live row → RETIRED row is the RESOLVED state and is SILENT. All seven
        surviving cites are of that shape (`F9`→`F20`, `J12`→`J52`, `J13`→`J53`,
        `J14`→`J54`, `J15`→`J55`, `J16`→`J56`, `O3`→`O18`). Warning on it — the
        literal reading of the row that asked for this guard — would print seven
        warnings on a file with nothing wrong with it, and a rule that cries wolf
        is a rule people stop running (AGENTS.md §Traps).
      * live row → LIVE row is the DEFECT: `X` says it was written from `Y`, and
        `Y` is still in the denominator. That is a duplicate BY CONSTRUCTION, and
        it is exactly the state `J13`/`J53` and `J16`/`J56` sat in from the
        admission until P6.748 — found by no keyword search, only by this link.
      * two DIFFERENT live rows citing one sweep row: both were written from it,
        so at most one of them can be the row.
      * a cite naming an id this file does not contain at all: the merge deleted
        a row instead of retiring it, or the id is a typo. Either way the link is
        no longer checkable by anyone.
      * a retired row whose merge target is missing or itself retired: the chain
        a reader follows out of a struck row dead-ends.

    Warnings only — the coverage still prints. This reports a provenance defect,
    which is a fact about the file's history; it is not a reason to refuse to
    answer the question the command was asked.
    """
    live = set(LIVE_IDS)
    retired = set(RETIRED)
    for row_id, cited in CITES:
        if cited in live:
            sys.stderr.write('  ⚠ ledger row %s cites `denominator %s`, and %s is a LIVE row — '
                             '%s was written FROM %s, so one of the two is a duplicate '
                             '(retire it: `~~%s~~`, verdicts `—`, `Why` opening `**RETIRED … → `%s`**`)\n'
                             % (row_id, cited, cited, row_id, cited, cited, row_id))
        elif cited not in retired:
            sys.stderr.write('  ⚠ ledger row %s cites `denominator %s`, which is in neither the live nor the '
                             'retired ids — a deleted row, or a typo; the provenance link is unfollowable\n'
                             % (row_id, cited))
    by_source = collections.defaultdict(list)
    for row_id, cited in CITES:
        by_source[cited].append(row_id)
    for cited, rows in sorted(by_source.items()):
        if len(set(rows)) > 1:
            sys.stderr.write('  ⚠ %d live ledger rows cite the same `denominator %s`: %s — one sweep row cannot '
                             'have produced two capabilities\n' % (len(set(rows)), cited, ' '.join(sorted(set(rows)))))
    for retired_id, target in MERGES:
        if target is None:
            sys.stderr.write('  ⚠ retired ledger row %s names no merge target — a struck row must say '
                             '`**RETIRED … → `<id>`**` or the reader has nowhere to go\n' % retired_id)
        elif target in retired:
            sys.stderr.write('  ⚠ retired ledger row %s was merged into %s, which is ITSELF retired — '
                             'the merge chain dead-ends\n' % (retired_id, target))
        elif target not in live:
            sys.stderr.write('  ⚠ retired ledger row %s was merged into %s, which is not a row in this file\n'
                             % (retired_id, target))


def verdict(cell):
    """Verdicts are backticked and carry a provenance marker: `covered ᵗ`."""
    v = cell.lower().strip('`').strip()
    for word in ('covered', 'partial', 'absent', 'n/a'):
        if v.startswith(word):
            return word
    return 'no-claim'


def marker(cell):
    """The provenance marker of a verdict cell, or `''` when it carries none.

    Read through `VERDICT_CELL` and not by scanning the cell for one of the
    marker characters, so the census and the shape check cannot drift apart:
    the marker is only a marker INSIDE the backticks, and a cell may carry prose after
    them. A cell whose shape the check already warned about reads as unmarked
    here — the warning is the report on it, and a second one would say the same
    thing in a worse place.
    """
    matched = VERDICT_CELL.fullmatch(cell)
    if matched is None or matched.group(2) is None:
        return ''
    return matched.group(2).strip()


def moved_to(cell):
    """The row of another plan a MOVED cell names, or `''`.

    The verdict word has to still be there, and that is the whole guard: a cell
    that could leave the denominator by DELETING its verdict would be the silence
    this annotation exists to end, wearing the annotation as its cure. Such a
    cell falls to the shape check above, which already warns by name, and scores
    as the no-claim it is.
    """
    if VERDICT_CELL.fullmatch(cell) is None:
        return ''
    found = MOVED_ANNOTATION.search(cell)
    return found.group(1) if found else ''


def switch_verdict(cell, row_id=None):
    """Only the FIRST backticked token is the verdict; everything after it is
    prose. Scanning all of them counted A5's *"the previous `SILENT-LOOSER` is
    refuted"* as that verdict — a refutation read as the thing it refutes.

    An out-of-vocabulary head token used to fall through to `no-claim`
    SILENTLY, and that is not the same reading: `no-claim` means *nobody
    measured it*, while an invented word means *somebody measured it and wrote
    the answer down in a word this file does not define*. G2 sat that way from
    `e8879beb1` until P6.747 — its cell said `NONE` ("no switch cost at all")
    and was scored as unmeasured, deducting a covered cell from the Host row
    with no output anywhere saying so. The vocabulary is deliberately CLOSED
    (`UNIFORM` already means "same on all three, no switch cost"), so the fix
    is not a wider vocabulary but a loud fall-through: a head token that LOOKS
    like a verdict — an ALL-CAPS word — and is not one now warns by name, the
    same way a malformed verdict cell does. A cell whose first backtick is
    prose or an identifier is left alone; only a shouted word is a claim.
    """
    tokens = re.findall(r'`([^`]+)`', cell)
    if not tokens:
        return 'no-claim'
    head = tokens[0].strip().strip('*').strip()
    for word in SWITCH_VOCAB:              # SILENT-LOOSER before SILENT
        if head.startswith(word):
            return word
    if SHOUTED.fullmatch(head):
        sys.stderr.write('  ⚠ ledger row %s: switch verdict %r is not in the vocabulary '
                         '(%s) — scored as a NO-CLAIM, i.e. "nobody measured it"\n'
                         % (row_id or '?', head, '/'.join(SWITCH_VOCAB)))
    return 'no-claim'


# The host's job is that a switch is CORRECT, so its row is scored off the
# switch column: no cost or an honest degradation is coverage; telling the user
# it broke is partial; silent or advertised-but-absent is the failure.
HOST_CLASS = {'UNIFORM': 'covered', 'HOST': 'covered', 'HONEST': 'covered',
              'REPORTED': 'partial',
              'SILENT': 'absent', 'SILENT-LOOSER': 'absent',
              'ADVERTISED': 'absent', 'no-claim': 'no-claim'}

ORDER = ('covered', 'partial', 'no-claim', 'absent', 'n/a')


def main(check_verdicts=False):
    rows = list(ledger_rows())
    per = collections.OrderedDict(
        (name, collections.Counter()) for name in ('Pi', 'Claude', 'Codex', 'Host'))
    # The marker census (P6.945) is accumulated in the SAME pass over the SAME
    # cells as the verdicts, so the two tables cannot disagree about the rows
    # they describe. Host is absent from it on purpose: its column is a switch
    # verdict, which carries no provenance marker.
    mark = collections.OrderedDict(
        (name, collections.Counter()) for name in ('Pi', 'Claude', 'Codex'))
    # D1.197 — the driven marker's ARTEFACT census; see `RIG_ARTEFACT` above.
    driven_cells = 0
    driven_with_artefact = 0
    # D1.104 — the TRACKER marker's own check; see `VERDICT_SOURCE_PLANS` above.
    tracker_states = tracker_row_states()
    tracker_rows = 0
    tracker_backed = 0
    tracker_unbacked = []          # (row id, why-it-failed, the ids it named)
    for cells in rows:
        cited = RIG_ARTEFACT.search(cells[6]) is not None
        for idx in (3, 4, 5):
            if marker(cells[idx]) != 'ʳ':
                continue
            driven_cells += 1
            if cited:
                driven_with_artefact += 1
        for name, idx in (('Pi', 3), ('Claude', 4), ('Codex', 5)):
            # A moved cell is counted in NEITHER the numerator nor the
            # denominator — it is resolved in a named row of another plan — but
            # the census below still reads its marker, so the cell totals stay
            # at the row total and a reader can see the verdict it kept.
            if moved_to(cells[idx]):
                per[name]['moved'] += 1
            else:
                per[name][verdict(cells[idx])] += 1
            mark[name][marker(cells[idx])] += 1
        per['Host'][HOST_CLASS[switch_verdict(cells[7], cells[1])]] += 1
        # D1.104. Read at ROW level and not per cell, deliberately: the `Why` is
        # ONE cell for all three runtimes, so a row id in it cannot be attributed
        # to a column without parsing the per-runtime clauses — a second grammar
        # for a check whose whole value is that it is narrow. A row wearing `ᵗ`
        # anywhere must name a tracker row somewhere, and one of those rows must
        # be closed.
        if any(marker(cells[idx]) == 'ᵗ' for idx in (3, 4, 5)):
            tracker_rows += 1
            named = sorted(set(TRACKER_ROW_ID.findall(cells[6])))
            known = [rid for rid in named if rid in tracker_states]
            if any(tracker_states[rid] == 'done' for rid in known):
                tracker_backed += 1
            elif not named:
                tracker_unbacked.append((cells[1], 'names no tracker row at all', ''))
            elif not known:
                tracker_unbacked.append((cells[1], 'names only ids no plan carries', ' '.join(named)))
            else:
                tracker_unbacked.append((cells[1], 'every tracker row it names is still open',
                                         ' '.join('%s(%s)' % (rid, tracker_states[rid]) for rid in known)))

    total = len(rows)
    if RETIRED:
        sys.stderr.write('  · %d ledger id(s) RETIRED as duplicates and merged into an older row, '
                         'therefore outside the %d: %s\n' % (len(RETIRED), total, ' '.join(sorted(RETIRED))))
    if MOVED_CELLS:
        sys.stderr.write('  · %d ledger cell(s) MOVED to a named row of another plan, therefore outside '
                         'the coverage arithmetic (the verdict word is kept and readable): %s\n'
                         % (len(MOVED_CELLS),
                            '; '.join('%s/%s → %s' % triple for triple in MOVED_CELLS)))
    if MOVED_ROWS:
        sys.stderr.write('  · %d ledger row(s) whose RESIDUE is relocated without a cell leaving the '
                         'arithmetic: %s\n'
                         % (len(MOVED_ROWS), '; '.join('%s → %s' % pair for pair in MOVED_ROWS)))
    provenance_warnings()
    head = ('покрыто', 'частично', 'нет вердикта', 'отсутствует', 'н/п',
            'остаток', 'всего', 'покрытие')
    print('| рантайм | %s |' % ' | '.join(head))
    print('|---|' + '---:|' * len(head))
    for name, c in per.items():
        # n/a is resolved, not owed. The remainder is everything still owing.
        rest = c['partial'] + c['no-claim'] + c['absent']
        denom = total - c['n/a'] - c['moved']
        pct = 100.0 * (c['covered'] + 0.5 * c['partial']) / denom if denom else 0.0
        print('| **%s** | %d | %d | %d | %d | %d | **%d** | %d | **%.0f%%** |'
              % (name, c['covered'], c['partial'], c['no-claim'], c['absent'],
                 c['n/a'], rest, total, pct))

    grand = collections.Counter()
    for c in per.values():
        grand.update(c)
    rest = grand['partial'] + grand['no-claim'] + grand['absent']
    denom = 4 * total - grand['n/a'] - grand['moved']
    print('| ИТОГО | %d | %d | %d | %d | %d | **%d** | %d | **%.0f%%** |'
          % (grand['covered'], grand['partial'], grand['no-claim'],
             grand['absent'], grand['n/a'], rest, 4 * total,
             100.0 * (grand['covered'] + 0.5 * grand['partial']) / denom))

    # P6.945 — the marker census, APPENDED below the coverage table and never
    # merged into it: every line above is parsed by the controller and stays
    # byte-identical. A blank line separates the two so a markdown reader treats
    # them as two tables rather than one with a changing arity.
    print()
    print('Перепись маркеров — описание на сегодня, не утверждение: без пина, не гейт (P6.949).')
    print('| маркер | Pi | Claude | Codex | всего |')
    print('|---|---:|---:|---:|---:|')
    for char, label in MARKERS + (('', 'без маркера'),):
        counts = [mark[name][char] for name in ('Pi', 'Claude', 'Codex')]
        print('| `%s` %s | %d | %d | %d | **%d** |'
              % (char or '—', label, counts[0], counts[1], counts[2], sum(counts)))
    # The denominator, printed rather than left to be inferred: this is a CENSUS
    # of every runtime verdict cell, and a reader who cannot see the total cannot
    # tell it from a sample.
    print('| ИТОГО ячеек | %d | %d | %d | **%d** |' % (total, total, total, 3 * total))
    # D1.197 — printed under the census, never merged into the table above: the
    # table's arity is parsed by the controller and stays byte-identical.
    print('`ʳ` с артефактом стенда: %d из %d (%s).'
          % (driven_with_artefact, driven_cells,
             'перепись, не гейт — см. RIG_ARTEFACT' if driven_cells
             else 'ни одной ячейки с этим маркером'))
    # D1.104 — printed beside it and, like it, a DESCRIPTION: it moves no number
    # and has no pin. `--check-verdicts` is the same reading with an exit code.
    print('`ᵗ` со ссылкой на ЗАКРЫТУЮ строку трекера: %d из %d%s'
          % (tracker_backed, tracker_rows,
             (' · без опоры: %s' % ' '.join(rid for rid, _, _ in tracker_unbacked))
             if tracker_unbacked else ' (все опираются на закрытую строку)'))

    # A coverage figure without its age is the defect: lanes close defects, so an
    # uncorrected ledger always understates — and an understated number is the one
    # nobody challenges. Owner rule 2026-08-28.
    import subprocess
    try:
        last = subprocess.run(['git', 'log', '-1', '--format=%h %ad', '--date=format:%Y-%m-%d %H:%M',
                               '--', LEDGER], capture_output=True, text=True, timeout=30).stdout.strip()
        sha = last.split()[0] if last else ''
        n = subprocess.run(['git', 'log', '--oneline', '%s..HEAD' % sha], capture_output=True,
                           text=True, timeout=30).stdout.splitlines() if sha else []
        code = len([l for l in n if not l.split(' ', 1)[-1].startswith('docs')])
        print('\nРЕЕСТР прочитан %s (%s) · с тех пор коммитов с кодом: %d'
              % (' '.join(last.split()[1:]), sha, code))
    except Exception as exc:
        print('\nРЕЕСТР: age unknown (%s)' % exc)

    print()
    open_rows = done = parked = 0
    tags = collections.Counter()
    unknown = collections.Counter()
    for line in io.open(PLAN, encoding='utf-8'):
        if not ROW.match(line):
            continue
        cells = [c.strip() for c in SPLIT.split(line)]
        if len(cells) < 6:
            continue
        glyph, note = cells[3], cells[5]
        cls = GLYPH_CLASS.get(glyph)
        if cls is None:
            # A glyph nobody wrote down is the failure this table exists to end,
            # so it is reported rather than folded into whichever bucket the
            # `elif` happened to reach.
            unknown[glyph or '(empty)'] += 1
            continue
        if cls == 'done':
            done += 1
        elif cls == 'blocked':
            parked += 1
        else:
            open_rows += 1
            tag = re.search(r'\[(doc:\w+|remote)\]', note)
            tags[tag.group(1) if tag else 'untagged'] += 1
    if unknown:
        print('  ⚠ UNCLASSIFIED GLYPHS (not in GLYPH_CLASS): %s'
              % ', '.join('%s ×%d' % kv for kv in unknown.most_common()))
    # A row whose NOTE names a commit while its sha cell is empty is a LOST PIN:
    # the background sort reads the whole file and writes it back, so a foreground
    # pin landing between its read and its write is discarded silently — the note
    # survives, the glyph reverts, and nothing errors. Measured 2026-08-28, four rows.
    lost = []
    for line in io.open(PLAN, encoding='utf-8'):
        if not ROW.match(line):
            continue
        cells = [c.strip() for c in SPLIT.split(line)]
        if len(cells) < 6 or cells[3] != '⬜' or cells[4]:
            continue
        if re.search(r'\b(CLOSED|LANDED|WIRED|DELETED)\b[^.]{0,40}\b[0-9a-f]{9}\b', cells[5]):
            lost.append(cells[1])
    if lost:
        print('  ⚠ LOST PINS (note names a commit, sha cell empty): %s' % ' '.join(lost))

    # A row can also be lost the OTHER way: the commit names the row and the
    # tracker never learned of it — the note keeps saying "not started" while
    # the code has been on the branch for days (P3.246 and P3.147, measured
    # 2026-09-02, four days each). The note-side check above cannot see that,
    # so read row ids out of commit subjects and bodies instead.
    import subprocess as _sp
    try:
        log = _sp.run(['git', 'log', '--since=21 days', '--format=%h%x00%s%x00%b%x00%x01'],
                      capture_output=True, text=True, timeout=30).stdout
        open_ids = set()
        for line in io.open(PLAN, encoding='utf-8'):
            if ROW.match(line):
                cells = [c.strip() for c in SPLIT.split(line)]
                if len(cells) >= 6 and cells[3] == '⬜':
                    open_ids.add(cells[1])
        never = {}
        for rec in log.split('\x01'):
            parts = rec.strip('\n').split('\x00')
            if len(parts) < 3:
                continue
            sha, subj, body = parts[0].strip(), parts[1], parts[2]
            if subj.startswith(RECORD_KEEPING_SUBJECTS):
                continue          # record-keeping edits name rows without landing them
            for rid in set(re.findall(r'\bP\d+\.\d+\b', subj + ' ' + body)):
                if rid in open_ids:
                    never.setdefault(rid, []).append(sha)
        if never:
            print('  ⚠ NEVER PINNED? (open row named outside %s, last 21 days): %s'
                  % ('|'.join(s[5:-1] for s in RECORD_KEEPING_SUBJECTS),
                     ' '.join('%s(%s)' % (r, ','.join(s[:2])) for r, s in sorted(never.items()))))
    except Exception as exc:
        print('  never-pinned check skipped (%s)' % exc)

    n = done + open_rows + parked
    print('ПЛАН  %d строк | %d закрыто | %d открыто | %d ждёт ответа владельца | %d%%'
          % (n, done, open_rows, parked, 100 * done // n if n else 0))
    print('  открытые по тегам: %s'
          % ', '.join('%s %d' % kv for kv in tags.most_common()))
    if check_verdicts and tracker_unbacked:
        sys.stderr.write('\n--check-verdicts (D1.104): %d ledger row(s) claim a TRACKER verdict with '
                         'nothing to check it against.\n' % len(tracker_unbacked))
        for row_id, reason, named in tracker_unbacked:
            sys.stderr.write('  ✗ %s — %s%s\n' % (row_id, reason, (': %s' % named) if named else ''))
        sys.stderr.write('Repair is one row at a time: name the plan row that landed it, or take the '
                         'marker down to the evidence the cell actually has.\n')
        return 1
    return 0


def wave_delta(base):
    """Per-wave progress against a baseline commit of the plan: rows born,
    closed, reopened, and the branching factor — read from git, never counted
    by hand (owner, 2026-09-02: a status after every wave, measured)."""
    import subprocess
    # Derived, never re-listed: this set used to contain ⏸ and 🚧, so a row
    # PARKED on an owner answer or still in flight was reported as closed
    # (P3.362, measured 2026-09-04 — 9 of 250 "closed" rows in one wave).
    CLOSED = {g for g, cls in GLYPH_CLASS.items() if cls == 'done'}

    def rows_of(text):
        out = {}
        for line in text.split('\n'):
            if not ROW.match(line):
                continue
            cells = [c.strip() for c in SPLIT.split(line)]
            if len(cells) >= 6:
                out[cells[1]] = cells[3]
        return out

    then = rows_of(subprocess.run(['git', 'show', '%s:%s' % (base, PLAN)],
                                  capture_output=True, text=True, timeout=30).stdout)
    now = rows_of(io.open(PLAN, encoding='utf-8').read())
    born = [r for r in now if r not in then]
    closed = [r for r in now if now[r] in CLOSED and then.get(r) not in CLOSED]
    reopened = [r for r in now if now[r] == '⬜' and then.get(r) in CLOSED]
    open_then = sum(1 for g in then.values() if g == '⬜')
    open_now = sum(1 for g in now.values() if g == '⬜')
    bf = (len(born) / len(closed)) if closed else float('nan')
    print('ВОЛНА с %s: закрыто %d | новых %d | переоткрыто %d | открыто было %d → стало %d (%+d) | ветвление %.2f'
          % (base[:9], len(closed), len(born), len(reopened), open_then, open_now,
             open_now - open_then, bf))
    if reopened:
        print('  переоткрыты: %s' % ' '.join(reopened))
    return 0


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '--since':
        sys.exit(wave_delta(sys.argv[2]))
    # D1.104. A FLAG and not the default, so a ledger edit by one lane cannot
    # redden another lane's status read; the census prints either way.
    sys.exit(main(check_verdicts=len(sys.argv) >= 2 and sys.argv[1] == '--check-verdicts'))
