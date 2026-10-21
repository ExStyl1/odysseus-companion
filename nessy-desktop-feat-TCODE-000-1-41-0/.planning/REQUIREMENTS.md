# Requirements: Nessy Desktop

**Defined:** — no active milestone
**Status:** cleared to a blank slate on 2026-08-17 by owner decision

## State

No requirements are defined. The roadmap was reset to a blank slate on the current codebase
before any phase was planned or executed.

The previous set — 25 requirements derived from 37 ingested documents (11 ADR, 20 SPEC,
6 DOC, **0 PRD**), each carrying its source citation — is in git history at commit
`9f4951e15`. The evidence those requirements were derived from is untouched in
`.planning/intel/` and in the source documents themselves.

**When requirements are defined next, note there is still no PRD in this repo.** Anything
written here will be derived from decision records, measured findings and the codebase map
— not from validated product requirements — and should say so and name its source.

## Out of Scope

| Item | Reason |
|------|--------|
| Everything under `docs/superpowers/plans/` | Owner directive for this roadmap. Those plans keep their own trackers and close-outs. |
| Managed-MCP / managed-plugin filter scope, and the `isPiCapabilityTurn` gate | Open owner question OQ-1. "A security control's scope is an owner decision, not a planner's." |
| Deviation-worklist **P5** (MCP `timeout`) and capability-gaps **R3** (bypass pin) | SUPERSEDED-BY-MEASUREMENT — already landed code (`4a5de5554`, `3b78acb00`). Marked, not deleted. |
| The nine dated owner decisions in `2026-07-29-inert-worklist.md` §3 | Decisions with reasons, not defects. One permanently destroys a user's model list if "fixed". |
| `SEATBELT_TESTING_WILDCARD → false` | A dated owner decision with a designed re-arm; a scheduled pre-GA flip. |
| Sandbox / isolation returning on by default | Standing owner decision 2026-08-12/13. |
| Pi SDK bump past `0.80.3` | Strict `!==` version gate; a bump is a qualification exercise, and `0.81.1` was assessed and skipped. |
| STRUCTURAL rows in the capability register | They change only if the integration shape changes. |
| The `platform.claude.com` corpus (549 pages) | Owner decision 2026-07-31 — our contract is Claude Code, not the platform API. |
| Themes and Channels in the plugin runtime | Deferred by `unified-plugin-adapter-runtime.md`. |
| Claude Pro/Max and ChatGPT subscription cards | Opt-in build flags; not shipped on. |
| Re-planning any shipped surface | Brownfield at 1.30.0 — see PROJECT.md § Validated. |

## Traceability

*No requirements defined.*

| Requirement | Phase | Status |
|-------------|-------|--------|
| - | - | - |
