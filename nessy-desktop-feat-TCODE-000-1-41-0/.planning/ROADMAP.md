# Roadmap: Nessy Desktop

## Overview

No active milestone. The roadmap was cleared to a blank slate on 2026-08-17 by owner
decision — the previously derived five-phase agenda was removed before any phase was
planned or executed.

Nessy Desktop is shipped and broad (1.30.0, three runtimes, four client surfaces). The
codebase map is in `.planning/codebase/`, and the ingested decisions and constraints are in
`.planning/intel/` and `PROJECT.md`. Nothing was lost — only the agenda was cleared.

**To start work:**

- `/gsd-phase "<description>"` — add a single phase to this milestone, then
  `/gsd-discuss-phase N` → `/gsd-plan-phase N` → `/gsd-execute-phase N`
- `/gsd-new-milestone --reset-phase-numbers "<name>"` — define a full milestone with scoped
  requirements and a generated phase breakdown

### Guardrails

Not an agenda — standing constraints that any phase added here inherits.

- **No phase routes managed-MCP or managed-plugin filter work.** Blocked on open owner
  question OQ-1 (`PROJECT.md` § Open Owner Questions).
- **Do not schedule** deviation-worklist **P5** or capability-gaps **R3** — both are already
  landed code, marked SUPERSEDED-BY-MEASUREMENT.
- **Nothing reaches an executor from a raw sweep.** Two re-verification passes in this
  repo's history each found a third of a raw finding list unactionable. Re-verify against
  current HEAD first.
- **No phase rebuilds a shipped surface.** See `PROJECT.md` § Requirements → Validated.

### Execution rules carried from `AGENTS.md`

Reflected here so a phase plan does not contradict them; the authority is `AGENTS.md`.

- One commit per task. Branch `<type>/TCODE-000`. **No MR and no tag during autonomous
  execution.**
- Implementation-First Verification Budget: focused checks during the loop; full suites,
  builds, packaging and live smokes only at an explicit verification-wave boundary or a
  named risk trigger.
- Close-out per phase-set: version bump in **both** root and `apps/electron`
  `package.json`, a **new** `apps/electron/resources/release-notes/<version>.md` (never edit
  or delete an existing one), and updated `docs-site/` pages.
- Zone parallel work **by file**, not by subsystem — another agent session is editing this
  worktree, and `git commit <pathspec>` takes the file's working-tree state.
- Live evidence comes from a packaged build. A dev build can pass while the shipped artifact
  fails.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

*No phases defined.*

## Phase Details

*No phases defined.*

## Progress

**Execution Order:**
*No phases defined.*

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| - | - | - | - |

## Coverage

*No requirements defined. See `.planning/REQUIREMENTS.md`.*

---
*Roadmap cleared: 2026-08-17 by owner decision — blank slate on the current codebase. The
prior derived roadmap (5 phases, 25 requirements, built from 37 ingested documents) is in
git history at commit `9f4951e15`.*
