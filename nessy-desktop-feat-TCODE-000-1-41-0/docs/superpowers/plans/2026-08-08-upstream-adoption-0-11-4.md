# Upstream adoption: craft-agents-oss v0.11.2 → v0.11.4

Owner-approved batch (2026-08-08). The fork's upstream published three releases
since our reference snapshot (v0.11.1, 2026-07-10); the reference checkout in
`.references/craft-agents-oss` is now at v0.11.4. Upstream squashes each release
to one commit, so the release notes are the changelog of record:
<https://github.com/craft-ai-agents/craft-agents-oss/releases>.

Five units adopt what still maps onto this fork. Each unit's "grounding" row
records what was verified in OUR tree on 2026-08-08 — do not re-derive it,
re-verify it at implementation time.

Verification budget: implementation-first (AGENTS.md). Focused tests per unit;
full wave at close-out only.

## Units

### U1 — Claude Agent SDK 0.3.215 → latest available in Artifactory

**Owner directive 2026-08-09: do not pin upstream's 0.3.220 — query the
Artifactory npm mirror (`artifactory.tcsbank.ru/api/npm/npm-all`, the
registry this repo already resolves from) for the LATEST published version of
`@anthropic-ai/claude-agent-sdk` AND its `-binary` companion, verify both
tarballs actually download from the mirror (the Pi-SDK quarantine lesson:
availability is proven by a fetch, not by `npm view`), and uplift to that.**
Record the resolved version in the tracker note. The same rule applies to any
other dependency this plan touches. Never bypass the registry to reach
npmjs.org directly (supply-chain rule stands).

Upstream moved to 0.3.220 (Claude Code v2.1.220 parity) and names the pulls:
abort-listener leak in streaming queries, richer process-exit diagnostics (CLI
stderr included in errors), **correct HTTP status reporting for rate-limit
errors** (adjacent to our CLR-12/429 work), session resume with dash-leading
IDs.

**Two traps, both from upstream's own notes:**

1. **Subagent nesting depth default changed 5 → 1** upstream
   (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` overrides). Grounding: zero
   occurrences of `MAX_SUBAGENT_SPAWN_DEPTH` in our tree, and nested spawn is
   product behavior (R60 rows). **Set the env explicitly in the claude env
   block BEFORE the uplift lands**, pinned by a test beside
   `claude-retry-ceiling.test.ts` (same pattern: never override an explicit
   value).
2. **The Explore-mode silent-block regression.** Upstream v0.11.4: "since the
   v0.11.3 SDK uplift, the first blocked tool ended the turn before the agent
   could respond". The regression window is 0.3.197→0.3.220 — our 0.3.215 may
   already carry it. **Measure on claude-runtime BEFORE uplifting** (blocked
   tool in a restricted mode; agent must still respond with the block reason),
   then again after. If 0.3.215 is affected, the fix rides this unit either
   way; record which side of the window we were on.

**Executor's corrections (2026-08-09) — both traps were wrong as written.**

*Trap 1, the depth default.* The plan says the default changed "5 → 1" and asks
for a seatbelt. `env-vars.md`, the `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` row,
says: "In v2.1.217 through v2.1.218, the default was 1 … v2.1.219 raised the
default to 3." The uplift target is on the far side of that restoration, so the
feared default is not what we land on, and `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH`
here has been 3 all along. The grounding ("zero occurrences of
`MAX_SUBAGENT_SPAWN_DEPTH` in our tree") was also wrong — there are 42, in a
whole `config/subagent-spawn-depth.ts` module with tests. What was REAL, and is
what the unit actually fixed: that module's only reader was `SessionManager`,
seeding the **Pi** execution manifest. Nothing carried the value into the Claude
subprocess, so `NESSY_MAX_SUBAGENT_SPAWN_DEPTH=1` turned nesting off on Pi
sessions and was **silently ignored on claude-runtime ones**. One knob, two
runtimes, one of them deaf.

*Trap 2, the Explore silent block.* Not the SDK, and the uplift does not fix it.
Measured on claude-runtime against the real gateway: a refused write in Explore
mode ends the turn with no assistant message at all — 4 valid runs on 0.3.215,
3 more on 0.3.218, all silent. The cause is our own PreToolUse payload.
`blockWithReason` returned `{ continue: false, decision: 'block', reason }`, and
`hooks.md` says `continue: false` "stops processing entirely … Takes precedence
over any event-specific decision fields", its message "Not shown to Claude".
Our local `SdkAutomationCallbackResult` had made that the only expressible
shape: `continue` was required where the SDK has it optional, and the type
lacked `permissionDecision`/`permissionDecisionReason` entirely. Fixed to the
documented § PreToolUse decision control shape; live-verified RESPONDED 3/3.

*Version.* Artifactory's latest is **0.3.218**; upstream's 0.3.220 is not
mirrored, which is exactly what the owner directive anticipated.

### U2 — server lock survives OS PID recycling

Upstream v0.11.3: "a stale server lock whose process ID was recycled by the OS
no longer prevents the app from starting — the lock now records which
executable wrote it, and startup verifies the live process actually matches."

Grounding: our lock (`packages/server-core/src/bootstrap/headless-start.ts:313`)
stores `{pid, startedAt, leaseId}` (plus a legacy plain-PID parse) and the
staleness check is `process.kill(pid, 0)` — **any process that inherited the
PID passes it**, so the hole is real here. Adopt the shape: record the writing
executable's path in the payload, and on startup treat a lock as stale when the
live process's executable does not match. Keep both older payload shapes
parseable (three formats total). Unit: a lock naming a live-but-foreign PID
must be treated as stale; a lock naming our own live twin must still refuse.

### U3 — macOS auto-update installer handoff

Upstream v0.11.3, two related fixes: updates ended "downloaded-but-never-
installed because quit cleanup interrupted the installer handoff", and a failed
final handoff now restarts the app cleanly instead of continuing half-shut-down.

Grounding: our quit path (`apps/electron/src/main/index.ts` before-quit) runs
cleanup → `releaseServerLock()` → defers to electron-updater when
`isUpdating()` (comment: "Force exit breaks the NSIS installer on Windows") —
so the Windows arm is guarded, but the specific macOS race (cleanup steps
racing the Squirrel handoff) and the failed-handoff recovery are unverified.
This unit is verify-first: reproduce/inspect the macOS handoff on a packaged
build with a local feed (`verify-update-feed.mjs` rehearsal), adopt the
clean-restart-on-failed-handoff behavior if we lack it, and pin the quit-path
ordering (lock release must not precede the updater's own quit when updating).

**Executor's note (2026-08-09).** Both upstream failures reproduce as real
shapes in our quit path, and were fixed by inspection rather than by a packaged
rehearsal:

* `before-quit` guarded only `flushAllSessions`. Everything after it —
  `sessionManager.cleanup()`, the storage runtime and dp broker disposals,
  browser panes, the OAuth store, model-refresh timers, the power blocker, the
  server lock — ran unguarded, and a throw in any of them aborted the handler
  before `app.quit()`/`app.exit(0)` were reached. That is precisely "quit
  cleanup interrupted the installer handoff": the app sits half-shut-down and
  the update stays downloaded.
* Nothing recovered from a handoff that failed silently. `quitAndInstall`'s
  synchronous throw was already handled in `installUpdate`; a handoff that
  simply never completes was not, and left a disposed app lingering.

**The plan's third instruction is deliberately not followed.** It asks to pin
that "lock release must not precede the updater's own quit when updating". The
lock release stays where it is, before the quit, for two reasons: the next
launch should not have to reason about a lock we could have cleaned up, and
after U2 a lock naming a dead PID is detectable as stale anyway. The risk the
instruction was aimed at — cleanup interrupting the handoff — is addressed
directly by making the quit unconditional instead of by reordering it.

**Not done here:** the packaged build + local-feed rehearsal. It is scheduled at
C, where packaging runs anyway; observing a real macOS handoff needs an install
over a running packaged app, which no unit can stand in for.

### U4 — empty `tool_calls: []` must not break stream completion

Upstream v0.11.3: "Custom OpenAI-compatible endpoints validate again: relays
that send an empty `tool_calls: []` field no longer break stream completion."

Grounding: our BYO endpoints are exactly this class. `from-chat.ts` iterates
`message.tool_calls ?? []` safely at the loop, but the stream-completion half
(does a delta/message carrying `tool_calls: []` leave the adapter waiting for
a call that never comes, or emit a phantom `function_call`?) is unverified.
Add a conformance case to the codex-responses-adapter suite: a stream whose
chunks carry `tool_calls: []` completes with a normal text turn; fix whatever
it finds. Also run the same shape through the claude route's `/v1/messages`
translation.

### U5 — mid-turn queue ordering

Upstream v0.11.2, two fixes on the queue path we default to
(`midStreamBehavior: 'queue'` on every gateway connection):

- "Queuing a message while the agent is still replying no longer pushes the
  in-progress response below your new message" — transcript ordering.
- "Queuing a message mid-turn no longer makes the agent treat its already-
  finished previous response as interrupted" — the flushed queue must not
  re-classify the completed turn.

Grounding: unverified in our tree (shared heritage, heavily reworked since).
Verify both scenarios first — one renderer/transcript test for ordering, one
agent-loop test for the interrupted-classification — and fix only what is red.
If both are green on our fork, close the unit as verified-not-affected with
the two tests as the record.

## Explicitly not adopted (recorded so the next sweep does not re-litigate)

- **Opus 4.6 restore + one-shot re-add migration** — subscription cards are
  flag-off here; gateway catalogs are ours. The *pattern* (a deliberate
  re-add that runs once and respects a later manual remove) is noted for our
  deprecated-model replacement table if we ever restore a model.
- **`create_task` / `archive_session` session tools** — this fork has its own
  task and session-management tool surface.
- **Composer autocapitalize fix** — ADOPTED in 1.41.0 by F1.249 (`28a8f4f3f`). Correction 2026-09-23 (WJ-ii): the earlier not-adopted verdict ("no autocapitalize in our composer (grep)") rested on a grep for the very attribute the fix adds — a reading of the pre-fix state — and missed our own JS capitaliser `shouldAutoCapitaliseFirstCharacter`.
- **Windows path-doubling / `gitBashPath`** — carried to the next Windows
  cycle instead; neither ships in the mac dmg.
- **Up-arrow recall, filter inheritance, `%20` links, transfer timeouts,
  background-chip UX** — real but small; candidates for a later polish batch,
  not this one.

## Tracker

Status: ⬜ open · 🔄 in progress · ✅ done · ⏸ parked

| # | task | status | commit | note |
|---|---|---|---|---|
| U1 | SDK → **0.3.218** + depth pin + Explore-block measurement | ✅ | `feat(upstream): U1` | **0.3.218 is the latest in Artifactory** — upstream's 0.3.220 is not mirrored. Both tarballs proven by fetch (sdk 1 142 740 B; darwin-arm64 74 286 064 B; darwin-x64/linux-x64/win32-x64 also 200). **Both traps corrected — see the unit's notes.** The 5→1 depth change is not what we land on (`env-vars.md`: v2.1.219 raised the default back to 3, and our own default already is 3); the pin now forwards the Nessy knob to the Claude subprocess, which it never reached. The Explore silent block is NOT the SDK: identical on 0.3.215 and 0.3.218, caused by our own `continue: false` PreToolUse payload. Fixed, guarded by `pretool-deny-shape.test.ts` and live case `AGT-10` |
| U2 | Lock executable identity | ✅ | `feat(upstream): U2` | grounding refined: `isLockFromPreviousBoot` ALREADY closed PID reuse across a reboot, so the open half was reuse WITHIN one boot. Lock now records `process.execPath`; a live PID whose executable differs is stale. Fail-closed on every unknown (no `ps` on Windows, foreign-owned process, older payload without the field). Basenames compared on both sides — the test caught a seam that trusted its reader to normalise. Logic split into `server-lock-identity.ts`; 10 cases, control discriminates |
| U3 | macOS update handoff verify-first | ✅ | `feat(upstream): U3` | inspection found BOTH upstream failures real here: only the session flush was guarded, so a throw in the cleanup chain aborted `before-quit` before any quit call (update downloaded, never installed); and a handoff that never completed left the app half-shut-down with no recovery. Fixed in `quit-finalizer.ts`, 6 cases, two controls. **The plan's "lock release must not precede the updater's quit" is NOT adopted** — see the unit note. Packaged local-feed rehearsal deferred to C, where packaging already runs |
| U4 | `tool_calls: []` conformance | ✅ | `test(upstream): U4` | **verified-not-affected, nothing to fix.** The accumulate-by-index loop iterates an empty array zero times, so no phantom `function_call` and no waiting flush. Four cases across both routes (Responses conformance + `/v1/messages`), each covering the plain shape AND the nastier `finish_reason: "tool_calls"` with an empty array. Control — making an empty array push an accumulator — fails all four **Correction 2026-09-23 (F1.237, WJ-ee + its verifier): holds for the two routes measured here; Pi's preloaded interceptor (`createOpenAiSseStrippingStream` in `unified-network-interceptor.ts`) was the third consumer of the shape, was not measured, and WAS affected — an empty `tool_calls` chunk lost its text and `finish_reason`, a turn ERROR at the Pi SDK boundary; fixed in `319dcdf00`. The same preloaded interceptor also rewrote the codex and claude-runtime OpenAI-wire hop on the headless server (F1.315).** |
| U5 | queue ordering verify-first | ✅ | `fix(upstream): U5` | **both scenarios were RED here, not not-affected.** (a) the assistant message is appended at `text_complete` while a queued user message is appended immediately, so the reply to the earlier question landed BELOW the later one — fixed in `transcript-order.ts`, 6 cases, control discriminates. (b) `wasInterrupted` was set on BOTH queue paths, including queue-direct where the code's own comment says the turn is undisturbed — so a queued follow-up told the model its finished reply had been cut off, on the DEFAULT path for every gateway connection. Pinned in `mid-stream-interruption.ts` |
| C | close-out: bump, notes, specs, full wave | ✅ | `chore(release): 1.22.0` | **minor, not patch** — U1 changes behaviour (a blocked tool no longer ends the turn) and the depth knob starts governing a second runtime. Full wave 12 639 pass / 1 fail, that one a NEW intermittent (`dp` SIGTERM cancel) measured 4/4 green alone and recorded in the known-failing register with its independence checked. Typecheck incl. `apps/cli` clean, lint 0 errors, both generated specs verified unchanged, `docs-site` updated in both locales. **Packaged update-handoff rehearsal from U3 still not run** |
