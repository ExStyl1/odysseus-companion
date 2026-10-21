# V1 stragglers: the legacy-workspace bypass leak and the agent channel's old words

Two real defects and three stale comments, found by the docs-site pass reading
code against the landed V1 (2026-07-31). Dispatch AFTER V2 wave 2 lands — the
renderer files overlap its zone.

## Tracker

| # | task | status | commit | note |
|---|---|---|---|---|
| S1 | Legacy workspaces cannot cycle into bypass | ✅ | bd6b577b | fallback → `DEFAULT_CYCLABLE_PERMISSION_MODES` at all three sites via `resolveWorkspaceCyclablePermissionModes` (AppShell useState seed, AppShell cycle-action fallback + settings-load resolution, FreeFormInput prop default). Red-then-green: `workspace-cyclable-modes.test.ts` 3 pass/4 fail on HEAD (legacy-workspace fixture green on helper, all four site contracts red) → 7/0 after the fix; mutation probes both sides (FreeFormInput default restored → red; AppShell cycle fallback restored → 6/1) then re-restored green. Explicit-bypass workspace keeps it (fixture) and the App.tsx:1340 responsibility dialog still gates every option-change into bypass; seeding untouched — `mode-claude-gates.test.ts` green |
| S2 | The agent channel speaks the new vocabulary | ✅ | 3057302c | every `formatModeGuidance` case opens with `${PERMISSION_MODE_AGENT_LABELS[mode]} mode` — "Ask mode"→"Manual mode", "Execute mode"→"Bypass permissions mode", "Accept-edits mode"→"Accept edits mode". Red-then-green: mode-session-state 8/5 → 13/0 incl. new all-seven pin-open test; mode-label-source pin green throughout; mutation probe (re-inlined "Ask mode") → 2 red, restored 13/0. CORRECTION for planner: formatModeGuidance was not the only old-vocabulary agent-channel text — mode-manager.ts still says "switch to Ask/Execute mode" (:1127), "Switch to Ask or Allow All mode" (modeSwitchHint :1590 and ~10 more reason strings :2270-:2476), ":1670 switch to Ask mode", and SessionManager.ts:16283 "Switch to Ask, Accept Edits, or Execute mode"; plus the playground fixture turn-card.tsx:2199. Left for a scoped follow-up — S2's commit subject and gates cover the guidance function only |
| S3 | Three stale comments | ✅ | d0dea1ea | protected-paths.ts:181-183 now records the shipped behaviour (auto's protected-path prompt is a nonNegotiable floor `autoBorderlineEligible` refuses — reaches the human, a deliberate deviation from the doc's "Routed to the classifier" row); mode-types.ts dontAsk bullet aligned with the PICKER_HIDDEN_MODES truth (config/CLI/automations only, no picker); workspaces/types.ts:60 "all 6" → the five-mode DEFAULT_CYCLABLE_PERMISSION_MODES. Diff verified comments-only |

## S1 — the fallback leak (security)

**Commit:** `fix(modes): a workspace without cyclable config gets the gated default cycle`

`permission-modes.md`: bypassPermissions enters the cycle only after explicit
enablement — that is the contract V1's T3 shipped via
`DEFAULT_CYCLABLE_PERMISSION_MODES` and the responsibility dialog. But three
renderer sites fall back to `PERMISSION_MODE_ORDER` (all seven) when a
workspace has no `cyclablePermissionModes`: `AppShell.tsx` (~:912, ~:1142) and
`FreeFormInput.tsx` (~:302) — locate by the fallback expression, not the line.
A pre-migration workspace therefore cycles into bypassPermissions with no
dialog and no enablement. Fix: the fallback is
`DEFAULT_CYCLABLE_PERMISSION_MODES` everywhere; a workspace that WANTS bypass
in the cycle writes it into `cyclablePermissionModes` (the T3 seam) — and the
dialog still gates the first activation either way.

**Gate:** a workspace with no cyclable config cycles through exactly the
default five; one that lists bypass explicitly still gets it (after the
dialog); new-workspace seeding unchanged. **Mutation:** restore one
`PERMISSION_MODE_ORDER` fallback → its test goes red.

## S2 — the agent channel

**Commit:** `fix(agent): mode guidance for the model uses the current vocabulary`

`formatModeGuidance` (mode-manager.ts, locate by name) still says "Ask mode"
and "Execute mode". Route its labels through `PERMISSION_MODE_AGENT_LABELS`
(the byte-equal-to-en pin from mode-table T3) rather than editing prose
in place — one text source, agent channel included.

**Gate:** the guidance strings for default and bypassPermissions carry the
pinned labels; the mode-label-source pin test still green. **Mutation:** inline
an old literal → the pin or the guidance test goes red.

## S3 — stale comments

**Commit:** `docs(code): three mode comments match the shipped behaviour`

`protected-paths.ts:184` (auto's protected-path prompt is nonNegotiable and
excluded from the Guardian consult — the comment claims the classifier band);
`mode-types.ts:70` (dontAsk is hidden from every picker by
`PICKER_HIDDEN_MODES` — the comment claims menu reachability);
`workspaces/types.ts:60` ("default: all 6" — the default cycle is five).
Comments only; zero behaviour.

## Rules

Repo root tests, ps-check before every run; pathspec on the commit; no
push/MR/tags/reset/rebase/amend; probes by re-edit; specs/ and the CDP
checklist planner-owned; no version bumps; English. The dev app on 9224 is the
owner's — untouched.

## Report

Shas; the leak proven red-then-green on a legacy-workspace fixture; the
guidance strings before/after; typecheck:all + apps/cli exit 0; corrections.

## S4 — the remaining old-vocabulary agent strings (appended 2026-07-31)

**Commit:** `fix(agent): every mode-switch hint speaks the current vocabulary`

S2's correction 3 enumerated what the guidance function did not cover:
mode-manager.ts "switch to Ask/Execute mode" (~:1127), "switch to Ask mode"
(~:1670), `modeSwitchHint` (~:1590) and ~10 reason strings (~:2270–:2476);
SessionManager.ts (~:16283) "Switch to Ask, Accept Edits, or Execute mode";
the playground fixture turn-card.tsx (~:2199). Locate every site by the string,
not the line. Route agent-facing text through `PERMISSION_MODE_AGENT_LABELS`;
the playground fixture is a literal respell.

**Gate:** `grep -a` across production finds zero agent-facing "Ask mode" /
"Execute mode" / "Allow All" spellings (state the counts; UI i18n keys and the
alias table are not agent-facing); the label-source pin stays green.
**Mutation:** re-inline one literal → its test goes red.

| # | task | status | commit | note |
|---|---|---|---|---|
| S4 | Remaining old-vocabulary agent strings | ✅ | 1e9f2c76 | every mode-switch hint routes through `PERMISSION_MODE_AGENT_LABELS`: new private `formatModeSwitchHint` feeds the 11 "Switch to Ask or Allow All mode" sites, the Ask/Execute mismatch suggestion and the dangerous-operator "Ask mode" hint interpolate the labels directly, SessionManager's composer-! string interpolates all five mode names, and the turn-card fixture is respelled. CORRECTION for planner: the enumeration missed two more agent-facing sites — the write-target block hints "switch to Ask or Auto mode" (mode-manager.ts, bash-write and file-write branches); both now interpolate `default`/`auto` labels. Red-then-green: mode-manager-bash-hints 3 pass/5 fail on HEAD → 8/0; mutation probe (re-inlined the old modeSwitchHint literal) → 2 red, restored 8/0. Gate: production `grep -a` "Ask mode\|Execute mode\|Allow All" 22 → 7, all 7 non-agent-facing (theme.ts field comments ×2, doc-links.ts UI summary, pi-agent-server JSDoc, FreeFormInput comments ×2, actions/definitions.ts UI action description — the last two families are UI/comment text, exempt); mode-label-source pin green throughout; typecheck:all + apps/cli exit 0 |
