# UB5.1 result — the recorded system prompt carries a per-mode value (output style), frozen until compaction

Row: `UB5.1 `[claude]` `[measure]`` of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(R14-32). Measured 2026-10-15 (UTC timestamps in the raw dumps read 2026-10-14T23:0xZ). Lane L-P57a.

## Question (row verbatim)

"SDK 0.3.274 records the system prompt by default; read our append and confirm it carries no per-turn
or per-mode value (a recorded prompt freezes it until compaction). Instrument: the SDK transcript of a
two-turn session with a mode switch between turns. Control: a deliberately per-turn line planted in a
scratch build is visible frozen." Amended 2026-10-14 (RT): measure on HEAD's SDK 0.3.280.

## Versions and provenance

- SDK self-reports at HEAD: `@anthropic-ai/claude-agent-sdk` `0.3.280` (`grep -o '"claudeCodeVersion"[^,]*'
  node_modules/@anthropic-ai/claude-agent-sdk/package.json` → `"claudeCodeVersion": "2.1.280"`; binary
  `claude --version` → `2.1.280`). The amendment's "0.3.280" confirmed. Re-read on 0.3.296 stays with UB8.1.
- The append under test was composed from a `git archive HEAD` snapshot (sha
  `f6026e90e03b943ca90ee9da6c2fc9d8b8fcd373`, recorded in `work/l-p57a/ub5-1/head-tree/HEAD.sha`), not the
  live tree: two neighbouring lanes hold uncommitted edits in `packages/shared/src/sources/credential-manager.ts`
  (a duplicate `isMultiHeaderCredential` export, UB3.1's api-auth move) and `packages/session-tools-core`,
  and a parse error in their in-flight hunk must not read as this row's measurement. The snapshot's
  `getSystemPrompt` is byte-identical to HEAD's (`system.ts` is not modified in the working tree).
- Harness: `work/l-p57a/ub5-1/drive.ts` (scratch, under the excluded `/work/`). The vendored SDK ran
  in-process against a loopback Anthropic stub (`127.0.0.1`, ephemeral port; no egress — two `HEAD /api/hello`
  probes answered 404 and recording activated regardless). `CLAUDE_CONFIG_DIR` and `NESSY_CONFIG_DIR` pointed
  at a `mkdtemp` scratch tree; no real credentials, no `~/.claude`, `~/.nessy*` writes. Child env is an
  allowlist (PATH/HOME/…), so no shell `CLAUDE_CODE_*` leaked in.

## The static read (our append, at HEAD)

- We pass `systemPrompt` as `{type:'preset', preset:'claude_code', append, excludeDynamicSections:true}`
  and omit `snapshot` (`packages/shared/src/agent/claude-agent.ts:2753-2765`, call site `claude-agent.ts:8536-8559`).
  Per the vendored `sdk.d.ts:2297-2307`, omitted = `snapshot: true` = record.
- Pinned per session: preferences and co-author (`claude-agent.ts:7782-7785`, with a drift notice at 7788-7798).
- Tail-only by design (not in the append): the date line (`getDateTimeContext`, `system.ts:287-300`), Safe Mode
  context and project-context files (`system.ts:461`, `525-527`).
- Static all-modes table in the append, like upstream: `## Permission Modes` lists all six modes as a spectrum
  with "The user can switch modes at any time, including mid-conversation" (`system.ts:1046-1048`); the current
  mode travels per turn. A permission-mode switch does not touch the append (`permissionMode` has the live
  `setPermissionMode` setter and is not hashed — `backend/claude/live-session.ts:266`).
- **The per-mode value: the output style.** `presetAppend: getSystemPrompt(…, turnOutputStyleId, …)` where
  `turnOutputStyleId = resolveChildOutputStyleId(…, getOutputStyleId())` is re-read EVERY turn
  (`claude-agent.ts:7836`, consumed at 8546-8555), and `getSystemPrompt` embeds the resolved style prose
  (`system.ts:528-544`). Switching the style `default` → `concise` changes the append by the Concise prose block.
- On append drift our code respawns the live child (`systemPrompt` is hashed in `claudeLiveSessionSignature`,
  `backend/claude/live-session.ts:173-176`) and the respawn resumes the session (`claude-agent.ts:9545`,
  `{ resume: this.sessionId }`). The per-turn adherence reminder rides the user-message tail and stays live
  (`claude-agent.ts:7842-7857`).

## Upstream v0.15.1

- `v0.15.1:packages/shared/src/agent/claude-agent.ts:1312-1326`: pins `snapshot: true` explicitly ("SDK ≥0.3.267
  default, pinned here on purpose… Per-turn context travels on the user-message tail, never in this append"),
  and pins every append input per session (`pinnedPreferencesPrompt`, `pinnedIncludeCoAuthoredBy`,
  `pinnedProjectContext`).
- `v0.15.1:packages/shared/src/prompts/system.ts:589-591`: `getPermissionModesSection` lists Guarded always
  "because Claude snapshots the system prompt, so a session switched to Guarded after it started must still
  find the row"; the current mode lives in `<session_state>` (per turn).
- `v0.15.1:packages/shared/CLAUDE.md:96`: the standing rule, verbatim: "Anything that must reach the model per
  turn belongs on the user-message tail, never in the append."
- Delta v0.14.0→v0.15.1 on both files: no `snapshot` hunks (the pin predates v0.14.0); the system.ts delta is
  UB1.12's project-memory wording. UB5.1 is not in `retarget-rows.json`.

## Instrument readings (three arms, 2026-10-15)

Each arm: turn 1 on a fresh SDK session, turn 2 on the SAME session resumed with a changed `systemPrompt.append`
(our exact respawn shape). The stub logs every `/v1/messages` `system` field; the transcript is the CLI's own
JSONL under the scratch `CLAUDE_CONFIG_DIR`.

- **Arm B — control (the row's control), planted per-turn line, snapshot omitted:** request 1 carried
  `PER-TURN MARKER: turn=1`; request 2 carried **`turn=1`, not `turn=2`** (`turnMarkerTurn1=true,
  turnMarkerTurn2=false`, systemLen identical 43126). The planted per-turn line is visible frozen. **Control PASSED.**
- **Arm C — boundary (can the instrument see a fresh render?), `snapshot: false`:** request 2 carried
  **`turn=2`** (`turnMarkerTurn1=false, turnMarkerTurn2=true`). The transcript has NO `prompt_snapshot`
  records. The instrument distinguishes frozen from fresh; `snapshot: false` renders fresh as documented.
  **Boundary PASSED.**
- **Arm A — reading, our REAL append, mode switch `default` → `concise`:** append(Default) = 35,989 bytes
  (asserted: no Concise prose), append(Concise) = 36,606 bytes (asserted: contains "Prefer short, direct
  answers"). Request 1's system: 43,052 bytes, `## Permission Modes` present, Concise prose absent — the real
  append reached the CLI. **Request 2's system: 43,052 bytes, byte-length identical, Concise prose ABSENT**
  (`conciseProse=false`). The mode switch did not reach the model.
- **Transcript (the instrument's named artifact):** the CLI records the rendered prompt as `prompt_snapshot`
  attachments in the session JSONL. Arm A carries two (`attachment.type='prompt_snapshot'`, `systemPrompt` as
  11 blocks, 41,750 bytes; the second adds `cliPrefix` and `tools`); **both are turn-1 renders** — each contains
  `## Permission Modes` and neither contains the Concise prose. The turn-2 append appears nowhere in the
  transcript or in request 2.

## Findings

1. **Recording is ACTIVE on our shipped SDK 0.3.280 / CLI 2.1.280** — not account-gated on this endpoint
   (the `sdk.d.ts:2308-2313` rollout caveat did not bite): the default recorded the prompt once and re-sent it
   verbatim on resume. The premise's mechanism is real and measured.
2. **The row's confirmation FAILS for one value: the output style.** Our append carries a per-mode value; a
   mid-session style switch is frozen until compaction. The respawn our signature drift spends
   (`live-session.ts:176`) buys nothing for the prompt — the resumed CLI ignores the changed append — while the
   tail reminder (style label + adherence line, `claude-agent.ts:7842-7857`) is the only live channel. Bounded
   impact: the user-visible symptom is stale style PROSE with a live label/reminder until compaction or a new
   session.
3. Everything else in the append is session-static by construction (pinned preferences; tail-only date, Safe
   Mode, project context; static all-modes permission table). Permission-mode switches are live and never
   enter the append.
4. We omit `snapshot` and ride the SDK default; upstream v0.15.1 pins `snapshot: true` explicitly and states
   the rule ("per-turn context travels on the user-message tail, never in this append"). Today the default
   equals the pin (arm B measured it), so behaviour matches; the pin is the guard against a default flip and
   the upstream-parity debt is one line.

## Decision (written before the reading, per the measure-row rule)

- UB5.1's question is answered: the append carries a per-mode value (output style), and the recorded prompt
  freezes it until compaction — measured, with a passing control and boundary. No verdict on UB6.16 or any
  other row follows from this file.
- The fix spawns a take row per the Phase 5 header. **Born `UB2.13` (Phase 2, `claude-agent.ts` is Phase 2's
  zone)**: pin `snapshot: true` in `buildClaudeTurnShapeOptions` (upstream v0.15.1 parity, one line + tests),
  and decide the output-style channel per upstream's rule (move the per-style prose to the tail, or keep the
  current static-prose + live-label shape and name the frozen window as a stated residue). Born ⬜, not
  CRITICAL: no permission, safety or data dimension — the stale channel is style prose, and the live channel
  already carries the switch.
- No code change landed in THIS row: it is `[measure]`; its Done means is this file.
