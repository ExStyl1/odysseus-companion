# Wave findings: the stale fork row, the leaking style, the project-less subagent

Three product defects from the 2026-07-31 full wave on the healthy rig
(AGT-1 10/10 PASS, AGT-3 7/7 PASS — the fork loop itself is solid).

## Tracker

| # | task | status | commit | note |
|---|---|---|---|---|
| W1 | stop_child invalidates the children domain | ✅ | (this commit) | `controlPiHarnessRuntime`'s final emit is now per-action: `stop_child`/`steer_child` → `['runtime','children']`, `stop_process` keeps `['processes']`, everything else keeps `['runtime']`. Switch audit: the goal_* and read_* arms return before the emit; ask/plan answers invalidate `['interactions','security']` and worktree release `['worktrees']` through their services — stop_child/steer_child were the only child-affecting arms with no children-domain path at the control seam (the existing `['children']` emit at the SubagentStop terminal-automation callback is race-dependent relative to the control ACK, which is the measured staleness). `useAgentPanel.ts:112` reloads only on `changedDomains.includes('children')`, so the panel now reloads with the ACK. Red→green at the emit site: new pi-runtime-snapshot test (stop_child+steer_child carry `['runtime','children']`, stop_process control stays `['processes']`) failed with `['runtime']` received, 13/13 after. Mutation: restoring the bare `['runtime']` arm → that test red (12/1), restored → 13/13. server-core tsc exit 0 |
| W2 | An output style does not reach a named subagent | ✅ | (this commit) | CORRECTION: the composition seam already excludes the style — `resolveChildOutputStyleId` (29a70d6b, 2026-07-29) nulls the style id for `piChildKind: 'named'` before `getSystemPrompt` resolves it, keeps it for a fork and the main session, and `grep -c resolveChildOutputStyleId apps/electron/dist/main.cjs` = 2 on the wave-day bundle (built Jul 31 06:30), so the guard was in the build the wave measured. What leaked was the MEASUREMENT: AGT-4's negative half read `lastAssistantText` of the PARENT transcript — the parent is styled (`output-styles.md:104` applies the style to the main conversation), so its relay of the subagent's answer carries the marker no matter what the child was composed with. Fixed the driver: the named half now reads the CHILD's own transcript through the `read_child` control. Seam hardened with the wave-fixture shape: a user-scope custom style file (`custom:cdp-probe` with a marker body) asserted at the delivery boundary — fork carries the marker, named does not (fork half must not regress and is asserted in the same test). Exclusion scope stays exactly the style id → composition (`OutputStyleComposition.prompt` + `keepCodingInstructions` subtraction); session memory/rewind halves untouched. Mutation probe: re-including the style for named children (`resolveChildOutputStyleId` → unconditional) sent 3 red — the builtin opposite-sides test, the NEW custom-style test, and the resolver test — all on the named side; restored → 6/6 green |
| W3 | A named subagent without a project falls back to shared, not failure | ✅ | (this commit) | Doc line quoted (sub-agents.md:263): "A subagent starts in the main conversation's current working directory. … To give the subagent an isolated copy of the repository instead, set `isolation: worktree`." — the parent's checkout is the baseline, so the toolset-DERIVED isolated-worktree default is a hardening, not a floor. Fix at the host admission seam (`createPiChildSessionPort.start`, AFTER the `runtime-agent-worktree-policy-mismatch` validation so the spawner's derivation is still authenticated): when the effective policy is `isolated-worktree`, the ask is NOT explicit (`pinnedDefinition?.isolation !== 'worktree'` and not a fork — a fork's policy is only ever isolated by call-site request), and `projectHandleService.resolveHandle` returns no bound project, the admitted record degrades to `shared`; explicit asks keep `isolated-worktree` and still fail closed downstream at `worktreeAuthority` with `worktree-project-required`. Red→green at the seam: new orchestration test (project-less + derived → admitted record `shared` and the spawn completes; project-less + frontmatter `isolation: worktree` → record keeps `isolated-worktree` AND the real un-stubbed path rejects `worktree-project-required`; positive control: project BOUND + derived → stays `isolated-worktree`). Mutation: restoring the unconditional policy (degrade removed) → the shared-fallback assertion red (expected `shared`, received `isolated-worktree`), restored → green. Recorded test conversion: the X4B lease-publication fixture stubbed `resolveHandle → null` while acquiring a lease — a fiction the real authority always refused — converted to a bound-project stub (its intent is lease publication/drain mechanics, unchanged). Affected suites 48 pass / 2 fail = exactly the known-failing "retains … authority" rows; server-core tsc exit 0 |

## W1 — the stale fork row (AGT-2, 13/14)

**Commit:** `fix(sessions): stopping a child invalidates the children domain`

`SessionManager.controlPiHarnessRuntime` ends with
`emitPiHarnessInvalidation(managed, request.action === 'stop_process' ?
['processes'] : ['runtime'])` — so `stop_child` (and `steer_child`) emit only
`runtime`, and `useAgentPanel` reloads ONLY on a `children` domain change. After
Stop, the row keeps `data-status=running` until some unrelated children
invalidation arrives; the user's second click (dismiss) is read as another stop
against a stale-running row, filters nothing, and the row sits there — measured
live: "rows still present after 20s: 1", race-dependent across runs.

- `stop_child` (and any child-affecting action — audit the switch) emits
  `['children']` (or `['runtime','children']`).
- Test at the emit site: the invalidation for stop_child carries `children`.

**Gate:** after stop_child, a renderer subscribed to children-domain
invalidations reloads without any other event; AGT-2's dismiss check is the
live proof at the next wave. **Mutation:** restore `['runtime']` → the domain
test goes red.

## W2 — the style leak (AGT-4, 4/5)

**Commit:** `fix(agents): an output style stays out of a named subagent's context`

Measured: with `custom:cdp-probe` active, the FORK's answer carries the style
marker (correct — a fork inherits the parent's composition) and **the named
subagent's answer carries it too** (wrong — a named subagent starts fresh:
its own prompt, tools, model). `curl -s
https://code.claude.com/docs/en/sub-agents.md` and `output-styles.md` — quote
the lines that bound a subagent's context and what an output style applies to.
Find where the style rides into the child's composition (the child backend
config or the pinned context the spawner hands over) and exclude it for
non-fork children.

**Gate:** with a marker style active, a fork's answer carries the marker and a
named subagent's does not — asserted at the composition seam (unit) since the
live half re-proves at the wave. **Mutation:** re-include the style for named
children → the seam test goes red.

## W3 — the project-less subagent (AGT-5, blocked by this)

**Commit:** `fix(agents): a named subagent without a project runs shared, not refused`

Both spawns of a named subagent in a workspace session with NO bound project
failed `worktree-project-required` before any model turn. The R2 series
deliberately shipped `bgIsolation: 'none'` as the default, and Claude's
subagents run in the parent's checkout unless a worktree is configured — a
project-less session refusing to spawn ANY named subagent is a divergence, not
a safety floor. Quote the doc line, then make the default worktree policy for
a named subagent degrade to `shared` when no project is bound (an EXPLICIT
`isolated-worktree` request may still refuse with the current error — that is
honest).

**Gate:** in a session with no project, a named subagent spawns and answers
(temp config dir, unit through the spawner seam); an explicit isolated-worktree
request still refuses with the named error. **Mutation:** restore the
unconditional requirement → the shared-fallback test goes red.

## Rules

Repo root tests; ps-check before every run; pathspec on the commit; one commit
per task, tracker row in the same commit; no push/MR/tags/reset/rebase/amend;
probes by re-edit; specs/ and the CDP checklist planner-owned; no version
bumps; the app on 9224 is the live wave rig — do not touch it, no electron
builds (the planner rebuilds at close-out); temp config dirs only; English.

## Report

Shas; each defect red-then-green at its seam; the doc lines quoted for W2/W3;
what the style-containment excluded exactly; typecheck:all + apps/cli exit 0;
mutation probes with sides; corrections.
