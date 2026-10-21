# Synthesis — doc ingest, mode `new` (run 2)

Entry point for `gsd-roadmapper`. Read this first, then the per-type intel
files, then `.planning/INGEST-CONFLICTS.md`.

**STATUS: AWAITING USER.** 0 blockers, 1 warning. The warning is a security-scope
question that needs an owner answer before managed-MCP or managed-plugin work is
routed; everything else is safe to route.

---

## What changed since run 1

Run 1 withheld 11 of 37 documents behind five cross-reference-cycle BLOCKERs and
raised one WARNING. All six were adjudicated by the orchestrator with direct
evidence:

- **The five cycles are confirmed benign** — every edge is a provenance or index
  back-link. Waived, recorded as INFO-6. All 37 documents are now synthesized.
- **The MCP-`timeout` WARNING is settled by measurement** — the b1-audit variant
  is correct, the deviation-worklist P5 row and the deviation-audit spot-check
  are stale. Demoted to INFO-7; the stale variants are **marked, not deleted**.

Consuming the 11 released documents produced two findings run 1 could not see:
one new WARNING (below) and one new staleness settled by measurement (INFO-8).

## Doc counts by type

| Type | Classified | Synthesized | Withheld |
| --- | --- | --- | --- |
| ADR | 11 | 11 | 0 |
| SPEC | 20 | 20 | 0 |
| PRD | 0 | 0 | 0 |
| DOC | 6 | 6 | 0 |
| UNKNOWN | 0 | 0 | 0 |
| **Total** | **37** | **37** | **0** |

All 37 classifications carry `confidence: high` and `manifest_override: true` —
types come from `.planning/ingest-manifest.yaml`, not from heuristics.

## Decisions

11 extracted to `.planning/intel/decisions.md`.

**Locked: 2** — `codex-like-workspace-storage.md` (Accepted 2026-07-13, "still in
force at 1.15.0") and `project-local-nessy-agent-and-workspace-roots.md`
(self-declared "Final architecture" for the P1-P6 cutover). They do not
contradict each other (INFO-5).

**Proposed / unmarked: 9** — runtime control boundary, runtime capability gaps,
extension-first Pi agent runtime, unified plugin adapter runtime, managed MCP
access, guardian command judge, file checkpointing and rewind, conversation
forks, transport locality. None carries a status field; all nine read as decision
records, so `locked: false` means "no Accepted marker found", not "provisional".

**The two newly released ADRs are the newest architecture evidence in the set**
(both measured 2026-08-16 against `feat/models-fetch`) and they matter
disproportionately: `runtime-control-boundary.md` records the R3 change that
removed the pinned `bypassPermissions` from the Claude runtime, and
`runtime-capability-gaps.md` is the per-runtime gap register keyed by
STRUCTURAL / DECISION / PLANNED / UNVERIFIED — the reason tag decides whether a
gap can ever change, which makes it the most directly useful input to a roadmap
in the whole set. One of its rows is stale; it is marked (INFO-8).

## Requirements

**0 extracted.** No PRD-classified documents exist in this ingest set. See
`.planning/intel/requirements.md` — requirements for `REQUIREMENTS.md` must come
from the user or a later ingest, and the SPEC-derived constraints must not be
reinterpreted as requirements. The nearest thing to a backlog is the 46-unit plan
slicing in the doc-sweep worklist, and INFO-9 explains why it is not a list of
46 open items.

## Constraints

20 extracted to `.planning/intel/constraints.md`.

Type breakdown: `api-contract` 15, `schema` 4, `nfr` 1.

The corpus is overwhelmingly conformance and defect records measured against an
external contract (Claude Code's published documentation), not internal technical
specification. Nine entries carry a self-declared staleness or supersession
banner written by the source itself; those banners are reproduced verbatim and
were not resolved. Three rows are additionally marked SUPERSEDED-BY-MEASUREMENT
with the evidence attached.

Newly released and load-bearing: the **parity audit** (declared source of truth —
its deviation rule and its three category strings govern how any gap here must be
recorded), the generated **parity report** (143/150 built, 7 open, 352 recorded
deviations; 70 of 185 Claude doc pages carry a row and 115 carry none), the
**inert-worklist** (whose §3 nine dated owner decisions `AGENTS.md` names as
required reading before filing any unused-identifier finding — one of them
permanently destroys a user's model list if "fixed"), and the **doc-sweep
divergences/worklist pair** (245 findings, 124 survived, 121 refuted, 0
unchallenged, sliced into 46 plan units).

## Context topics

6 topics extracted to `.planning/intel/context.md`: the documentation index and
its own rules, CLI client, mobile remote, post-wave release verification
(1.21.0), CDP live-audit checklist, parity wave live verification checklist.

## Conflicts

- **0 blockers.**
- **1 warning** — an owner directive in the declared source of truth CLOSED the
  question of managed MCP/plugin filters being skipped on non-Pi turns, on the
  stated ground that the Claude backend is flag-off. Measured on the working
  tree: `isClaudeRuntimeEnabled()` returns `true` when unset,
  `PROVIDER_FLAG_DEFAULTS` carries `nessy_claude: true` / `nessy_codex: true`,
  the `AGENTS.md:127-138` citation the directive gives no longer holds the flag
  table, and the `isPiCapabilityTurn` gate is still present at
  `storage-runtime.ts:804`, `:888` and `:1091`. Precedence would resolve this the
  wrong way (both flag-off sources are SPEC, the contradicting source is DOC), so
  it is surfaced rather than picked.
- **9 info** — the cycle waiver, two measurements settling stale claims, two
  precedence auto-resolutions carried forward, two source-declared supersessions,
  the doc-sweep wave's closure state, and the confirmation that the two locked
  ADRs do not contradict.

Full detail with `source:` references for every claim:
`.planning/INGEST-CONFLICTS.md`.

## What a resolver should do first

1. **WARNING-1 needs one owner answer covering three questions** — whether the
   2026-07-29 scope directive survives the 2026-08-06 flag flip, whether
   `isPiCapabilityTurn` on the managed filters is intent or accident, and whether
   the `managed-mcp-access.md` sentence or the gate is the thing that changes.
   Until then, do not route managed-MCP or managed-plugin work.
2. **Two intel entries are marked SUPERSEDED-BY-MEASUREMENT and must not be
   scheduled**: the deviation-worklist P5 MCP-timeout row (already landed code,
   `4a5de5554`) and the capability-gaps R3 row (already landed, `3b78acb00`).
   Both are marked in place rather than deleted, so the history stays readable.
3. **Read `runtime-capability-gaps.md`'s reason tags before planning anything
   runtime-related.** DECISION rows are reopenable product calls with recorded
   reasons; PLANNED rows close on their own; STRUCTURAL rows change only if the
   integration shape changes. Treating a STRUCTURAL row as a backlog item is the
   most likely way to waste a plan here.
4. **The generated files are generated.** `parity-report.md`,
   `deviation-register.md`, `parity-wave-verification-checklist.md` and the
   doc-sweep pair are all script output. Never hand-edit; regenerate. The
   register has drifted downward by a third before, "and drift downward is
   invisible because a smaller number still looks like an answer."

## Per-type intel files

- `.planning/intel/decisions.md`
- `.planning/intel/requirements.md`
- `.planning/intel/constraints.md`
- `.planning/intel/context.md`
- `.planning/INGEST-CONFLICTS.md`
