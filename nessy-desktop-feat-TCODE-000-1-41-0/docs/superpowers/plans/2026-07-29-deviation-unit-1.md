# Deviation Unit 1 — hook signal, exit-code contract, PreToolUse allow, InstructionsLoaded

Closed 2026-07-29. Four rows from `docs/superpowers/specs/2026-07-29-deviation-worklist.md`
§3 Unit 1, all in the security-or-permission band. Executed on `fix/renderer`
from baseline `8ee5fbbf`, one commit per row.

The contract is `https://code.claude.com/docs/en/hooks.md`, fetched raw with
`curl -sL` (3169 lines) and read directly — no transcription, including the
worklist's own, was trusted for a payload or an exit-code rule.

## Rows and commits

| Row | Commit | Category |
| --- | --- | --- |
| P3 — a failing hook produces no signal | `1854b890` | `documented, implemented` |
| P3 — 0/2/other exit contract applied unconditionally | `9fb535a2` | `documented, implemented` |
| P3/R15 — a PreToolUse `allow` does not skip the prompt | `c4a521ae` | `documented, implemented` |
| R28 — `InstructionsLoaded` fires once per session, content-free | `924b7aa4` | `documented, implemented` (one carve-out below) |

### R28 carve-out

`nested_traversal` has no producer. Nessy resolves the nested-instruction
ancestor walk EAGERLY at inventory time (`native-sources.ts:873-890`), so those
files are in context before the first turn and there is no lazy traversal to
report. They report `session_start`, which is what actually happened.

Category: `documented, not implemented — every nested instruction file is loaded
eagerly at inventory time, so no traversal is lazy; those files truthfully
report session_start`. Not a Pi limitation and not an impossibility — it would
become reachable if the inventory ever moved the ancestor walk to a lazy read.

## What changed

**`1854b890` — hook error notice.** `HookErrorNotice` rides
`AgentEventExecutionResult` beside `decision` and `universal`. Both executors
build one per failing command hook that did NOT block, carrying the matcher name
as the documented `<hook name>`, the first stderr line as the transcript summary
and the full stderr as the debug detail. `SessionManager.reportHookErrors`
consumes it on the `role:'info'` / `infoLevel:'warning'` channel
`handleSessionMirrorError` uses, and logs the full stderr. A non-PreToolUse
event whose command hook has no execution authority now reports too.

**`9fb535a2` — `exitCodeContract`.** A format identity on
`PluginHookDescriptor`, set by the Claude adapter only, cloned from the
`asyncRewake` chain: descriptor type → Claude adapter → **native schema reader**
→ projection record → `RuntimeHookRegistration` → the two action constructors.
`blockOnNonZero: false` is now conditional on it, so Codex and native
`nessy-plugin.json` command hooks get back the contract where any non-zero exit
blocks. `pluginHookExecutableHash` does not read the field, so no installed
plugin is re-prompted for trust.

**`c4a521ae` — PreToolUse allow.** Resolved at the existing R15 band behind the
shipped `promptIsNonNegotiable(checkResult, readableDecision)`, which is exactly
the documented exception list. A deny rule never reaches the band, so the floor
is untouched. It resolves BEFORE `PermissionRequest` fires, because that event
fires "when a permission dialog is about to be shown" and once the hook approved,
none is.

**`924b7aa4` — `InstructionsLoaded`.** Emitter moved from the Pi lifecycle bridge
to `BaseAgent.emitInstructionsLoaded`, one event per loaded file, four load
reasons (`session_start`, `include`, `path_glob_match`, `compact`), and the
matcher now reads `load_reason`. `PathScopedRuleActivation` already carried
`triggerFilePath`, `matchedPatterns` and `memoryType` for exactly this payload
and nothing had ever read them.

## Pinned assertions rewritten

Three currently-green tests pinned the WRONG contract. Rewriting them was the
work, not collateral.

1. **`hook-command.test.ts:198-205`** — "does NOT block on other non-zero exits
   when Claude semantics are selected" asserted only `toBeUndefined()`. That
   pinned exactly the half of hooks.md § Exit code output that lets a crashed
   hook pass silently. The no-block half is kept; the notice is now asserted
   too, because "non-blocking" never meant "unreported".
2. **`pi-agent-lifecycle-hooks.test.ts:349-353`** — asserted the overlay returns
   the central prompt untouched for a hook `allow`. The assertion still holds
   and is kept, but it was being read as "a hook allow can never clear a
   prompt". It now carries the reason it holds — the documented exception list
   is not computable at that point, so the overlay DEFERS rather than refuses —
   and points at the new suite that pins where the allow lands.
3. **`lifecycle-bridge.test.ts:40`** — pinned the once-per-session, content-free
   emission inside an exhaustive `toEqual`. The entry is REMOVED rather than
   updated: the subprocess has no instruction inventory and can never produce
   the documented payload. Keeping the assertion exhaustive is what now proves
   the bridge no longer emits it.

Two fixtures moved and were tightened, never loosened:

4. **`hooks-automation.test.ts`** "keeps the observational hooks
   non-decision-bearing even on non-zero exit" asserted the whole result equalled
   `{matchedCount:1}`. Its subject is the DECISION surface, so the exact notice
   is now spelled out and `decision`/`universal` are asserted absent
   individually.
5. **`runtime-automations.test.ts`** "applies the imported two-mode matcher and
   exit-code semantics to plugin hooks only, on the live runtime path" asserted
   that ANY imported plugin hook returns no decision on exit 1 — true only for a
   Claude-format hook. Its fixture hook now carries the identity, keeping the
   three-way assertions, and a second plugin hook WITHOUT the identity asserts
   exit 1 blocks.

## Gate evidence

Run from the repo root (a run from a package directory bypasses the config-dir
isolation preload).

| Gate | Result |
| --- | --- |
| `bun test packages/shared/src/automations/hook-command.test.ts` | 32 pass / 0 fail |
| `bun test packages/shared/src/plugins/__tests__/hooks-automation.test.ts` | 47 pass / 0 fail |
| `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts` | 96 pass / 0 fail |
| `bun test packages/shared/src/capabilities/__tests__/runtime-automations.test.ts` | 11 pass / 0 fail |
| `bun test packages/shared/src/agent/__tests__/pi-agent-pretool-hook-decision.test.ts` | 43 pass / 0 fail |
| ... same file against pre-fix `pi-agent.ts` | **1 fail** / 42 pass (the new positive case) |
| `bun test packages/shared/src/agent/__tests__/instructions-loaded.test.ts` | 4 pass / 0 fail |
| `bun test packages/pi-agent-server/src/extensions/lifecycle-bridge.test.ts` | 6 pass / 0 fail |
| Hook contract aggregate (49 files matching `hook` across automations/plugins/server-core) | 891 pass / 1 skip / 0 fail |
| Permission + mode aggregate (149 files matching `permission` across shared/server-core) | 1975 pass / 3 skip / 0 fail |
| `bun run typecheck:all` | clean |
| `bun run lint:shared` | 0 errors, 4 pre-existing warnings in untouched files |
| `bun test` (whole repo) | 9260 pass / 18 skip / **11 fail**, all known pre-existing |

The two aggregates were run once on the final diff, per the immediate-risk
triggers this unit hits (hook decision handling, a permission outcome).

The 11 whole-repo failures are the documented pre-existing set: ten shared
`ensureStorageLayoutV2` / `paths-default-root` / `managed paths with
NESSY_CONFIG_DIR` cases that assert on an unset `NESSY_CONFIG_DIR` the isolation
preload necessarily sets, plus `Pi harness R0 baseline > executes golden
foreground and background process contracts`.

## Worklist claims that were wrong about the code

1. **"mcpb hooks stopped blocking on exit 1"** — mcpb bundles produce no hooks
   at all. `format-adapters/mcpb.ts` contains zero occurrences of `hook`, and
   only the Claude and Codex adapters emit `kind: 'hook'` capabilities. The row
   was real for Codex and native `nessy-plugin.json`; mcpb was never in it.
2. **The `asyncRewake` chain is six files, not five.** The Claude adapter
   round-trips its own capabilities through the NATIVE schema reader
   (`claude.ts:229 normalizeNessyPluginManifest` → `schema.ts`), which rebuilds
   each hook capability field by field. A descriptor field the reader does not
   know is silently dropped between the adapter and everything downstream. The
   first `exitCodeContract` implementation looked correct and produced
   `undefined` at the adapter's own test boundary for exactly this reason.
3. **The `InstructionsLoaded` gap was worse than the worklist stated, and the
   worklist said so correctly** — confirmed against the raw doc: no
   `path`/`file_path` field existed, and because the matcher had no
   `load_reason` to read it fell through to `''`, so only a catch-all hook could
   ever fire.

## Propagation found (reported, not fixed)

1. **`universal.systemMessage`, `suppressOutput` and `terminalSequence` have no
   consumer.** `parseUniversalHookOutput` (`hook-command.ts:242-253`) parses all
   five universal fields and merges them across hooks, but `rg 'universal'`
   across production code shows only `continue` and `stopReason` read, at
   `SessionManager.ts:2026-2033`. Three documented user-facing outputs are
   computed and discarded. Same failure class as the P3 row this unit closed.
2. **Async hook failures are still silent.** `hooks-automation.ts` fires an
   `async` hook with `.catch(() => {})`. hooks.md documents `asyncRewake` as
   showing "the hook's stderr, or stdout if stderr is empty [...] to Claude as a
   system reminder so it can react to a long-running background failure". The
   flag is stored and deferred (`plugin.hooks.async_rewake_deferred`); the
   failure itself reaches nobody. The `HookErrorNotice` channel this unit added
   is the natural carrier when R3 lands.
3. **The two-mode matcher is applied with the same format-blindness the
   exit-code row had.** `pluginHookMatcher` (`hooks-automation.ts`) and
   `runtime-automations.ts` set `matchMode: 'claude'` on EVERY imported hook, so
   a Codex or native-format hook gets Claude's exact-name/unanchored-regex
   semantics. `exitCodeContract` is now the precedent for a `matcherContract`
   identity alongside it.
4. **`MATCHERLESS_AGENT_EVENTS` covers 2 of the 10 documented events.**
   `automations/utils.ts:155-158` says so in its own comment; hooks.md:262 lists
   ten events whose `matcher` is ignored. Pre-existing and deliberately scoped.
5. **Exit 2 on `SessionStart`/`Setup`/`SubagentStart`** (hooks.md:735) renders as
   a `<hook name> hook error` notice rather than blocking. This unit's notice
   rule — report whenever a run failed and produced no block — covers it as a
   side effect, since those events drop the block decision at projection. Worth
   confirming live rather than assuming.
6. **`memoryType`, `triggerFilePath` and `matchedPatterns` on
   `PathScopedRuleActivation` were built for `InstructionsLoaded` and left
   unwired** — their own doc comments name the documented fields. Before this
   unit `rg 'memoryType'` returned exactly one hit, the write site. Worth a
   sweep for other fields carrying a documented name with no reader.
