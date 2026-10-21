# Parity ceiling — 2026-09-05

Produced by the ledger-closure sweep; counts are CELLS of the 107-row ledger (`2026-08-28-capability-ledger.md`), classified at HEAD `34be43fde`. Read with the reconciliation section: ±3 cells.

# Parity ceiling — what closes, what is unknown, and what cannot close

Denominator is the capability ledger's **107** capabilities
(`docs/superpowers/specs/2026-08-28-capability-ledger.md`). *Covered now* is the ledger header's own
count. Every other column is the summed classification of the 21 compose slices' input cells
(**272 cells** in total), so each column counts CELLS, not lanes — several cells share one row, and one
row can move cells on two runtimes.

Reading of each column:

- **+CLOSED_AT_HEAD** — already delivered; the ledger is stale. Costs a ledger edit, no build.
- **+BUILDABLE** — closable by a lane with no owner input.
- **+OWNER (parity direction)** — closes *only if* the owner answers toward parity. An answer the other
  way keeps the cell open **by decision**, which is a finished product, not a gap.
- **MEASURE (unknown)** — nobody has measured it. It is not a gap and not a cover; it is a null, and it
  can resolve in either direction. Counted separately, never inside a best case that is claimed.
- **STRUCTURAL** — the runtime cannot, at HEAD, with its native mechanisms. This is the ceiling. The
  host's only move here is an HONEST divergence surface, not a cover.

## Per-runtime ceiling

| Runtime | Covered now | +CLOSED | +BUILDABLE | +OWNER | Best case (no measurements) | MEASURE unknown | If every measurement lands covered | STRUCTURAL | Hard ceiling (107 − STRUCTURAL) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Pi** | 54 (50.5 %) | +12 | +14 | +14 | **94 (87.9 %)** | 13 | 104 (97.2 %) ⚠ raw sum 107 exceeds the ceiling | 3 | 104 (97.2 %) |
| **Claude** | 32 (29.9 %) | +11 | +25 | +18 | **86 (80.4 %)** | 20 | 104 (97.2 %) ⚠ raw sum 106 exceeds the ceiling | 3 | 104 (97.2 %) |
| **Codex** | 21 (19.6 %) | +9 | +29 | +24 | **83 (77.6 %)** | 12 | 95 (88.8 %) | 12 | 95 (88.8 %) |
| **Host** | 52 (48.6 %) | +13 | +29 | +4 | **98 (91.6 %)** | 6 | 104 (97.2 %) | 1 | 106 (99.1 %) |

The two right-hand columns are the honest bracket: the left of them assumes every measurement resolves
against us, the right that every one resolves for us. **Codex is the only runtime whose arithmetic
closes exactly on its ceiling**: 21 + 9 + 29 + 24 + 12 = 95 = 107 − 12, so codex's 12 STRUCTURAL cells are
precisely what separates a fully-finished codex from parity — nothing else on codex is unaccounted for.

**Pi's measurement-inclusive sum overflows its own ceiling (107 against 104) and Claude's nearly does
(106 against 104).** That overflow is not a finding about Pi; it is the arithmetic showing the same
over-count the reconciliation below measures. The capped figure is shown; the raw sum is flagged.

## What the ceiling is made of

- **Codex carries 12 of the 19 STRUCTURAL cells** — four times Pi's or Claude's 3, and twelve times the
  host's 1. Codex is where "maximally finished" has to mean *disclosed*, not *closed*, and the honest
  divergence surface is the deliverable for those twelve.
- **The host is the cheapest parity available**: 1 STRUCTURAL cell, 29 BUILDABLE, only 4 OWNER — the
  one column that is almost entirely lane work and almost entirely independent of the owner.
- **Claude is the measurement-heaviest runtime**: 20 unknown cells against 75 non-covered — better than
  a quarter of its open set is a null rather than a gap. Claude's true position is not known well
  enough to plan against, and measurement is the cheapest thing that moves it.
- **The owner is the largest single lever on codex and claude** (24 and 18 cells). Answered toward
  parity they are the difference between 55.1 % and 77.6 % on codex; answered away they are a deliberate
  product, and the ledger should then read `absent — DECISION`, not a defect.

## Reconciliation — and what could not be counted

| Runtime | Covered | Non-covered (107 − covered) | Cells classified | Δ | Best case, drift removed |
| --- | --- | --- | --- | --- | --- |
| Pi | 54 | 53 | 56 | +3 | 91 |
| Claude | 32 | 75 | 77 | +2 | 84 |
| Codex | 21 | 86 | 86 | +0 | 83 |
| Host | 52 | 55 | 53 | -2 | 100 |

**The sums do not reconcile exactly, and that is a real limit on these percentages, not a rounding
artefact.** Codex reconciles at Δ 0; Pi over-counts by 3 and Claude by 2; the host under-counts by 2.
Three composition effects the slices themselves recorded explain the drift, and none is a missing cell:

1. **Derived residue cells** were classified alongside true ledger coordinates. Slice C states one
   explicitly — `C4/claude-notice`, "a derived residue rather than a ledger coordinate", counted under
   claude/BUILDABLE. Such a cell inflates a runtime column with no ledger cell behind it.
2. **Host entries exist only conditionally** — one per cell whose switch verdict is not
   UNIFORM/HOST/HONEST — so the host column is not a 107-cell column at all, and its 53 classified
   cells against a nominal 55 non-covered is expected, not a shortfall.
3. **Cells were grouped and split** across rows by the file-zoning rule (slice A1's four host cells are
   one row; slice F1's F2/pi is one cell across three rows). Grouping moves rows, not counts — but the
   slices that scored one shared host seam once per ledger column it appears in do move counts.

So read every percentage here as **±3 cells (±2.8 pp)**. With the drift removed the best cases become
Host 100, Pi 91, Claude 84, Codex 83, and that changes what may be concluded:

- Host over Pi: 9 cells — larger than the drift, so the ordering holds
- Pi over Claude: 7 cells — larger than the drift, so the ordering holds
- Claude over Codex: 1 cell — **within the ±3 drift, so this is not an ordering**, and the two must be read as tied

In short: **the host is clearly the most closable and codex clearly the least, while Claude and Codex
cannot be separated by these numbers** (1 cell apart against a ±3 drift). Any plan that depends on
claude ranking above codex needs the drift resolved first — which means auditing the derived-residue
cells out of the two runtime columns, not re-running the arithmetic.

**A second, larger discrepancy is not mine to resolve and must not be smoothed over.** These
percentages are strict *fully-covered-cell* fractions: Pi 54/107 = 50.5 %. The closure brief's own headline
reads **Pi 63 %, Claude 44 %, Codex 36 %, Host 52 %** — higher on every runtime except the host,
because the ledger's own scoring credits `partial` cells fractionally while the header's 54/32/21/52
counts only `covered` (`scripts/plan-status.py` line ~96 scores the host column from the Switch
verdict). Both scorings are defensible and they are not interchangeable: the brief's number answers
*how much capability exists*, the table above answers *how many capabilities are finished*. Every
figure in this file is the second question, on the ledger header's own counts, and a reader comparing
it against the brief's headline is comparing two different measurements, not finding an error.

Nothing in the 21 slices was left unclassified: every slice reported all of its input cells carrying a
klass, 272 cells across the four columns. The judgement calls behind that total — cells counted under
one class while carrying a second field, cells grouped into one row, residues promoted to rows, and the
two ledger narratives stale at HEAD without their cell becoming covered (A7/codex's DEFECT headline,
closed by P6.1; A1/codex's omission of the wired `auto_review`) — are recorded per slice in
`ledger-closure-rows.md` under `## Ledger cells to promote at the next refresh`.
