# 2026-09-18 — measure sitting 5 (WAVE I-7, lane SIT-5b) on the packaged 1.40.0, CLEAN environment

The fifth sitting against the `measure:` rows the runtime-parity closure deferred on 2026-09-10 and the
integrations-and-authorization plan carries as `D1.*`. Two other sitting lanes ran beside it on their own ports and
their own config dirs (SIT-5a, release verification and the artefact-dependent rows; SIT-5c, the tail of the measure
list from `D1.55`). **This lane's list is `D1.234` first, then `D1.5` … `D1.54` in id order** — narrowed mid-sitting
by the controller when the third lane took the tail.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.40.0** (`CFBundleShortVersionString` reads
`1.40.0`), built by the controller from `61cfc4659` (dmg `release/NessyDesktop-1.40.0-mac-arm64.dmg`). Never
rebuilt, never removed.

**Rig.** Port **9242**; `NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad (`rig-a`), created for
the run and never under `~`. The owner's profile was never launched; `dp auth login` / `logout` were never run; no
token was read, printed or committed. `NESSY_DEBUG=1` and `NESSY_PROXY_AUTH_DEBUG=1` on every launch, through the
`env -u` launcher `scripts/cdp/README.md` prescribes, with the CASE process given the same treatment. The app's
stdout and stderr were captured to a file named through `NESSY_CDP_APP_LOG`, which two of the three cases read.

**The rig precondition.** `RS-32` **PASS 8/8**, 22 703 ms at load 9.29 — the one-click Pi card seeding
`tgpt/deepseek-v4-flash-0731` (the `coder` alias), its first turn answering `ready`, and the retired-id control
showing the host substituting the live id before the call with 0 info rows.

---

## 0. The clean-environment control, printed once per run

**The derivation re-run at HEAD, boundary-aware (`-P`), never a copied list.** The candidate set is the lane's own
environment; the intersection is what the repo reads:

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do
    c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
    [ "$c" != 0 ] && echo "$n -> $c file(s)"
  done
```

THIRTEEN names over the same 31-name candidate set, and every count identical to `lib/app-env.ts`'s own table:
`ANTHROPIC_BASE_URL` 51, `CLAUDECODE` 2, `CLAUDE_CODE_DISABLE_CRON` 12,
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` 1, `CLAUDE_CODE_EXECPATH` 4, `CLAUDE_CODE_MESSAGING_SOCKET` 1,
`CLAUDE_CODE_MESSAGING_TOKEN` 1, `CLAUDE_CODE_OAUTH_SCOPES` 2, `CLAUDE_CODE_SUBAGENT_MODEL` 10,
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 11, `CLAUDE_EFFORT` 19, `DISABLE_AUTOUPDATER` 5,
`MCP_CONNECTION_NONBLOCKING` 1.

**The app's own read-back**, through `ps eww` on the RUNNING app and never on this process:
`{"pids":4,"present":{},"controlSeen":true}` at launch and `{"pids":12,"present":{},"controlSeen":true}` later, when
the two sibling lanes' apps were up too — no contaminating name on any of them, with `NESSY_CONFIG_DIR` seen in the
same read as the positive control. `appEnvBlockReason` answered `(clean)` every time.

---

## 1. D1.234 — the row's own reason for being deferred is the WRONG one (case `RS-63`, **PASS 7/7**, 170 634 ms)

D1.234 is D1.4's OUTPUT half: *"whether a real model's stage-1 auto-mode reasoning overruns `max_tokens` 2112 on a
long transcript and the truncated verdict fails `parseVerdict` (which blocks)"*. Sittings 2, 3 and 4 each recorded
it NULL with the same reason — *"needs a REALISTIC long transcript built first, which is a sitting of its own
rather than a turn"*.

**That reason is about the transcript, and the transcript is not what binds it.**

### The detector, and the two controls

Every upstream call the per-session loopback adapter makes writes one line of the app's own stderr under
`NESSY_PROXY_AUTH_DEBUG=1` — `[codex-adapter] upstream auth: <scheme>`, from `nestor-client.ts`'s
`logUpstreamAuthScheme`, which the claude path reaches because `claude-agent.ts`'s `startAdapter(…)` passes no
`onUpstreamAuth` sink. Beside it the product's own classifier COUNTER: `reportHostOverheadCall` classifies each
upstream call by its system prompt and writes `[host-overhead] auto-mode-classifier: …` for a classifier hop.

A classifier hop rides the SAME adapter and the SAME logger as the agent's own hops, which is what makes a zero a
statement about the classifier rather than about the log — and the control that the log writes at all is the
`upstream auth` count on a plain turn in the same session: **20**.

The second control is the transcript itself: the case refuses to bank the reading until the conversation has passed
a 40 000-char floor.

### The measurement, on a claude-gateway card in `auto` mode

| arm | upstream calls | `auto-mode-classifier` markers | `[host-overhead]` lines |
| --- | ---: | ---: | ---: |
| control, a plain turn | 20 | 0 | 0 |
| A — a read-only shell (`ls -la`) | 2 | 0 | 0 |
| B — the filler loop, three `seq` turns | 6 | 0 | 0 |
| C — `curl … \| sh` at an RFC 2606 `.invalid` host | 2 | 0 | 0 |

The conversation went **2 843 → 57 377 chars** over arm B, and the band action was settled by the product's OWN
permission card (the case's answerer clicked one) and completed.

**So stage 1 was never reached, at any transcript length, and the reason is the shipped PreToolUse payload.**
`buildClaudePreToolUseContinue` names a `permissionDecision` on all three of its return paths — `defer` on the
P2.525 branch, then `ask` when the gate asked and `allow` otherwise — and `hooks.md#pretooluse-decision-control`
says a hook's `"allow"` skips the permission prompt, which in `auto` mode IS the classifier.
`claude-permission-mode.ts`'s own header records the same thing from the other side: the only shape measured to
keep the classifier is a hook that names NO `permissionDecision`, which P3.139 deliberately did not ship.

**D1.234 is therefore a NULL by CONFIGURATION, not by transcript**, and it is owed on a build whose PreToolUse hook
names no decision — a build, not a sitting.

### A rig fact the first drive paid for

The filler arm is a LOOP of moderate `seq` results rather than one big one, and that is measured. The first drive
asked for `seq 1 9000` in one call and the transcript grew by **4 366** chars: the product PERSISTS a large tool
result to a file and leaves `<persisted-output> Output too large (42.9KB) …` in the transcript in its place. A case
that grows a conversation with one big tool result cannot grow it at all.

---

## 2. D1.6 — the claude sentence HOLDS on its own decisive arm, and ledger A1's `auto` reading is REFUTED on this build (case `RS-64`, **PASS 8/8**, 204 118 ms)

D1.6 (P6.70) is about shipped text: *"**Claude (`anthropic`)** — the same gate runs as the SDK's `PreToolUse` hook,
so Nessy still sees every call before it runs"*
(`apps/electron/src/renderer/lib/composer-permission-modes.ts`). Ledger A1 records the opposite for `auto`
(P3.93/P3.96, measured 2026-08-28 on the vendored 2.1.223): our shipped hook returns `allow`, which skips the SDK's
own prompt, and *"`curl … | sh` EXECUTED WITH NO REVIEW"*.

The row names its own decisive arm — a `curl … | sh`-class command in `default`, with classifier requests counted
off our own loopback upstream. This case drove that arm and `auto` beside it, each with a read-only command in the
same session immediately before as the negative:

| arm | control `echo` | band `curl … \| sh` | upstream calls | classifier markers |
| --- | --- | --- | ---: | ---: |
| `default` | **0 cards**, ran | **1 card**, ran | 23 | 0 |
| `auto` | **0 cards**, ran | **1 card**, ran | 26 | 0 |

**In both modes Nessy saw the dangerous call before it ran**, while the read-only command beside it raised nothing
— which is what makes "a card appeared" a statement about the command rather than about a rig that cards
everything.

**So A1's `auto` reading does not reproduce on the packaged 1.40.0.** It is not a contradiction of P3.93: the
classifier was still consulted zero times in both modes. What changed is that the product's OWN gate now asks for
this command — `curl` is one of `DANGEROUS_COMMANDS` (`packages/shared/src/agent/core/dangerous-commands.ts`, thirty entries, `curl` among them) — so the action is reviewed by us
rather than by the SDK, which is precisely what the composer sentence claims.

**What stays owed:** the row asks for SEVEN modes, a read-only AND a mutating probe each, and TWO agreeing runs.
This is two modes, one probe pair each, one run.

**A rig fact, measured twice:** the same band action with NO answerer running leaves the turn at
`toolStatus: "executing"` with `isProcessing: true` for the full 300 s wait and no error — sitting 4's silent-hang
fact, reproduced here on a claude card. A sitting driving a dangerous Bash spelling keeps an answerer running or it
measures its own timeout.

---

## 3. D1.7 — the seven Pi mode sentences, driven for the first time (case `RS-65`, **FAIL 4 of 6**, 678 921 ms — and both FAILs are one finding)

D1.7 (P6.71) is ledger A11's Pi cell, a `—` nobody has ever driven; the composer prints
*"**Pi** — the vocabulary is Pi's and `core/pre-tool-use.ts` IS the translation, so the general string is Pi's own
behaviour"*, and the row's own absence control is that no test drives it.

Seven modes, one fresh Pi session each, a read-only `echo` probe and a mutating `touch ./<tag>.txt` probe per mode,
cards counted per PROBE. **The mutation writes into the session's own working directory and never into a home
directory**, which the row's `touch ~/<tag>` would have done.

| mode | reported by the app | read-only `echo` | mutating `touch` |
| --- | --- | --- | --- |
| `dontAsk` | **`default`** | 0 cards, ran | 1 card, ran |
| `explore` | `explore` | 0 cards, ran | 0 cards, **refused** (`Bash/error`) |
| `plan` | `plan` | 0 cards, ran | 1 card, ran |
| `default` | `default` | 0 cards, ran | 1 card, ran |
| `acceptEdits` | `acceptEdits` | 0 cards, ran | 0 cards, ran |
| `auto` | `auto` | 0 cards, ran | 0 cards, ran |
| `bypassPermissions` | `bypassPermissions` | 0 cards, ran | 0 cards, ran |

Where the pair is interpretable the sentences are borne out: `explore` runs the read and REFUSES the write with no
card, which is the read/write asymmetry its sentence claims; `default` asks for the write and not for the read;
`acceptEdits`, `auto` and `bypassPermissions` run the write without asking. `plan` asks for the write and then runs
it once the card is answered — the gate saw it, and the approval is a user action rather than the mode failing.

**The row asks for TWO AGREEING RUNS, and it has them for six of the seven.** The case was driven twice on the same
bytes of the app: a first run at 416 003 ms and this one at 678 921 ms. **Every cell the two runs both measured
agrees** — all seven `applied` values, and all seven mutation pairs. The difference is entirely in the read-only
probe: in the first run four of the seven never reached a tool (the model answered `echo <tag>` from its own
knowledge instead of running it), where in this one all seven did. That is why the case now records an arm with no
read-only probe as UNINTERPRETABLE rather than scoring it, and why the first run's shape — a `require` that aborted
the sweep — was replaced by a check that scores the mismatch and lets the other six arms be read.

**And the row's own named control cannot be entered.** `dontAsk` is the mode D1.7 nominates as the control whose
answer is known — *"Never prompts. Runs pre-approved tools and denies everything else"* (`mode.dontAskFullDesc`).
Asked for it, the app reports the session's `permissionMode` as **`default`**, in both runs, and its pair then
behaves exactly like `default` (no card on the read, one card on the write). Both of the case's two FAILs are that
one fact. It is recorded as a finding with its own controls in §5 below, not as a property of the `dontAsk`
sentence — the sentence describes a state this build does not enter.

## 4. D1.18 — the detector WI-f asked for does not exist on a packaged build, measured three ways

WI-f's correction on RS-49 (2026-09-17) says the rig's detector is the wrong surface and *"the next arm needs the
SDK `system`/`init` message as the HOST receives it"*. That surface is not reachable from a packaged rig, and each
half of that has its own control:

1. **The SDK's persisted session file does not carry it.** Over this rig's own
   `<workspace>/claude-config/projects/…/*.jsonl` the entry types present are `queue-operation`, `assistant`,
   `attachment`, `user`, `file-history-snapshot`, `atis-latch` and `last-prompt` — no `system`, no `init`. The file
   is the right one and is being written, which is the control.
2. **The host's own line for it does not reach the packaged app's output.** `adaptSystem` writes
   `SDK init: captured <n> tools` through `callbacks.onDebug` on every init. Over the whole captured log of this
   sitting that string occurs **0** times, while other claude debug lines from the same runs are there —
   `[claude auto memory]` 4 and `[claude-code:unrecognized_model]` 16. Same shape as lane SIT's P-SIT-3.
3. **Nothing reads the rosters it captures.** `getSdkTools` occurs **1** time in the whole tree (its own
   declaration), against the sibling accessor `getModel()` at **41** as the control that the probe finds call
   sites; and `.sdkSlashCommands` / `.sdkSkills` / `.sdkAgents` have no consumer outside the adapter except a test.
   The one roster that IS used is `_sdkSlashCommands`, as the baseline the `commands_changed` diff subtracts from.

So D1.18 stays NULL on this artefact, and its blocker is now named precisely rather than as "the wrong surface".

---

## 5. A product finding: `dontAsk` cannot be entered, on EITHER runtime

Measured after `RS-65` raised it, with controls in the same runs:

| card | mode asked | mode the app reports |
| --- | --- | --- |
| `pi-api-key` | `dontAsk` | **`default`** |
| `pi-api-key` | `dontAsk` (a second session) | **`default`** |
| `pi-api-key` | `explore` — CONTROL | `explore` |
| `pi-api-key` | `plan` — CONTROL | `plan` |
| `claude-gateway` | `dontAsk` | **`default`** |
| `claude-gateway` | `plan` — CONTROL | `plan` |

Read through the app's own `getSessions()` immediately, after 4 s, and after a second `setPermissionMode` call —
`default` every time. In the same sitting, `explore`, `plan`, `default`, `acceptEdits`, `auto` and
`bypassPermissions` all reported back the mode they were given, which is the control that the set call works.

The app's own backend line says it applied the mode —
`[Mode] Set permission mode to dontAsk for session … (changedBy=user, modeVersion=2)` — so the two surfaces
disagree. The managed clamp is NOT the cause and can be excluded by reading it: `normalizeManagedPermissionMode`
answers `plan`, not `default`, for a disabled `dontAsk`, and this rig carries no managed policy at all.

This is proposed as a row rather than diagnosed here; a sitting lane touches no package source.

---

## 6. The rows this sitting did NOT drive, each with its premise re-taken at HEAD

Recorded as NULLs rather than left implied. Where a re-take MOVED something it is said so, and every absence
carries a positive control on the same instrument. Counts name their instrument: `lines` is `git grep -c`,
`occurrences` is `git grep -o | wc -l`.

| row | premise at HEAD | why NULL |
| --- | --- | --- |
| `D1.5` credential floor, three runtimes | **one number MOVED, the claim did not.** `deniedReadPaths` in `codex-agent.ts` is 6 lines / 6 occurrences (as sitting 1 read it); `deniedPaths` in `claude-agent.ts` is **2 lines / 2 occurrences**, not 4 — and both are still what the row says: one is a comment and the other is `getMergedConfig(permissionsContext).deniedPaths`, the mirror's only source. Control on the same instrument: a fabricated symbol scored 0 in the same file | needs a claude AND a codex session each reading a credential file, and a control file chosen after the profile's `config.json` has been checked for plaintext secrets. Sitting 1's second reason stands: a model asked to read `credentials.enc` puts what it read into a transcript |
| `D1.8` managed clamp of the Pi mode | holds: `normalizePiPermissionMode` 35 occurrences over `packages`+`apps`, `noteSwitchVisibleDegradation` 8 in `claude-agent.ts`, `surfaceCodexOperatorNotice` 39 in `codex-agent.ts` — neither of the last two on any Pi path | needs a deployed managed policy carrying `disabledPermissionModes` and a relaunch. **Read §5 first:** a mode that does not stick with NO policy present has to be separated from a clamp before this row's arm means anything |
| `D1.9` the administrator's skill, once or twice | holds: `getAdminAgentSkillsDirs` 28 occurrences, `NESSY_ADMIN_SKILLS_DIR` 6, `CLAUDE_CODE_MANAGED_SETTINGS_PATH` 12 | needs the enterprise root established for the claude half — the row itself says to settle whether it follows `CLAUDE_CODE_MANAGED_SETTINGS_PATH` first, or to run under a container |
| `D1.10` ambient `OPENAI_BASE_URL` on codex | holds: the name is in 5 files over `packages`+`apps` and in NEITHER `codex-agent.ts` nor `codex-responses-adapter/src`; `CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS` 12 occurrences | needs a codex card, a local sink and the codex SOURCE re-read at `rust-v0.154.0` (the row cites `rust-v0.148.0`) — and on this runtime the source outranks the page |
| `D1.12` the SDK's compaction and `## Compact Instructions` | holds: `withProjectCompactSteering` is in 4 files and **0** of its occurrences are in `claude-agent.ts` — reached from Pi and from codex, from claude by nothing | needs a claude session, a `PostCompact` hook and a real compaction |
| `D1.15` background work against the reaper | holds: `backendBackgroundTasks` is 1 line / 1 occurrence in `SessionManager.ts` | needs a packaged Pi session with a `bash_background` command AND a background subagent held across an idle-reaper window, plus the no-background negative control |
| `D1.16` the claude hook-event column | holds as the 2026-09-11 premise correction already states: `MEASURED_HOOK_EVENT_COLUMNS` reads `anthropic: true` (`runtime-hook-events.ts:632`), so the row's title is false and the residue is narrower — every claude `emitted` verdict is backed by a DECLARATION rather than by an observed firing | needs hooks installed and a firing WATCHED per event, which is a fixture sitting with a relaunch |
| `D1.17` a skill's frontmatter hooks on codex | holds, and the naive re-take still says otherwise: `provider !== 'anthropic'` answers **1 line** in `SessionManager.ts` and that line is the COMMENT recording that P6.59 removed the gate | needs a codex card and a skill declaring both a `PostToolUse` and a `PreToolUse` command hook |
| `D1.18` the SDK's dynamic Workflows | **MOVED — the detector is now named.** See §4: the persisted session file carries no `system`/`init` entry (types listed, as the control), the host's `SDK init: captured … tools` line occurs 0 times in the packaged app's captured output against two other claude debug lines at 4 and 16, and nothing outside the adapter reads the rosters (`getSdkTools` 1 occurrence — its own declaration — against `getModel()` at 41) | the arm WI-f asked for cannot be taken on a packaged build with the surfaces that exist. It needs a reader for the init rosters (proposed row) or a dev build |
| `D1.19` the claude USD budget cap | holds: `CHILD_SESSION_BUDGET_EXHAUSTED_ERROR` 24 occurrences, `buildClaudeMaxBudgetUsdOptions` 7 | needs `workspaceDefaults.maxBudgetUsd` set just above one turn's spend and two turns on a real card. Not driven here: the sitting spent its budget on the three cases above |
| `D1.20` a codex spawned agent's inherited tools | holds: in `tool-defs.ts` `list_sessions` and `send_agent_message` carry no `visibility`, while the control `list_mcp_resources` carries `visibility: 'pi-only'`; `multi_agent` is in 31 files | needs a codex card and a real `spawn_agent` |
| `D1.22` `ENABLE_TOOL_SEARCH` | holds, including sitting 2's refutation: `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is 2 lines in `claude-agent.ts` (the row says it is written nowhere); `NESSY_ENABLE_TOOL_SEARCH` is in 13 files | forcing `true` into the child is not a rig lever — our own options write the name — so the arm needs a managed-env block or a code change |
| `D1.23` codex `preToolUse` | holds, and the naive probe LIES about it: the generated `HookEventName` writes its members in DOUBLE quotes, so a single-quote census answers 0. Read literally it is TWELVE — `preToolUse permissionRequest postToolUse preCompact postCompact sessionStart sessionEnd userPromptSubmit subagentStart subagentStop stop interrupt` | a BINARY-level rig (host-authored `[hooks.PreToolUse]` plus the trust second pass), not a CDP case — the third sitting to record that verdict |
| `D1.24` codex→claude MCP resources | holds, at a path the row's sitting-2 note mis-states: `runtime-switch-costs.ts` is at `apps/electron/src/renderer/components/app-shell/input/`, where `resources/list` occurs twice and still says the question *"is unmeasured and needs a"* live run. A census at `packages/shared/src/agent/` answers 0 for BOTH the needle and its control, which is the path being wrong rather than the sentence being gone | needs MCP-R1 arm 1 with a leased source advertising resources, registered as `{type:'sdk',…}` |
| `D1.26` extended context | holds: `getEnable1MContext` 1 line in `config/storage.ts`, `enable1MContext` **0** over `codex-responses-adapter` + `codex-agent.ts`. The codex half is ANSWERED (sitting 2: zero catalogue models at 1 000 000) | the Pi half needs an ANTHROPIC-WIRE Pi connection; the gateway card is OpenAI-wire and so is the loopback stub |
| `D1.28` skill-listing keys | holds at the vendored **2.1.251** (both self-reports agree): `skillListingMaxDescChars` at `sdk.d.ts:5614` and `skillListingBudgetFraction` at `:5618`, once each | needs a user `settings.json` carrying values far from the documented default plus the absent-key control. The expected result is a dead control, which is why it must be measured |
| `D1.29` claude `PushNotification` | **MOVED.** Sitting 2 read 0 in `claude-agent.ts` and concluded the tool is not disallowed. At the vendored 2.1.251 the name occurs **0** times in `sdk.d.ts` too — with `Notification` at 17 and `WebFetch` at 5 in the same file as the controls — so the SDK we ship declares no such tool at all | the delivery half needs an OS notification observed, which this headless rig cannot see; and the advertisement half now needs the init roster, which §4 measures as unreadable |
| `D1.30` the judge's fourth tier | holds at the corrected path: the four-list sentence is `packages/shared/src/prompts/guardian.ts:158` (*"hard deny (unconditional), soft deny (user intent or an …"*) and `trustedIntent` is 4 occurrences there | needs the guardian driven twice over one `soft_deny`-matching action with a `hard_deny` control in both arms, and a compliance RATE rather than a single pass |
| `D1.31` symlink pair + re-check | holds at the corrected path: `Symlink-pair asymmetry (permissions.md)` is at `packages/shared/src/agent/pi-harness/permission-dsl.ts:1291`. Sitting 2 cited `permission-dsl.ts` without the `pi-harness/` segment, and that spelling answers 0 | needs a link swapped BETWEEN the permission decision and the open, once per runtime — a TOCTOU rig |
| `D1.32` `requiresUserInteraction` | holds: 15 files, 52 occurrences | needs an MCP server declaring `_meta['anthropic/requiresUserInteraction']` on one tool and a sibling without it, driven in `dontAsk` and `bypassPermissions` per runtime. **`dontAsk` is not enterable on this build (§5)**, so half the matrix is blocked by that finding |
| `D1.34` mid-turn `addDirectories` | holds: `addDirectories` in `sdk.d.ts` (1) and `buildClaudeAdditionalDirectoriesOptions` 2 in `claude-agent.ts` | not drivable as a sitting at all: it needs `canUseTool` to RETURN `{type:'addDirectories',…}` mid-turn, which is a code change |
| `D1.39` resume by id from another directory | holds: `resume` is 52 lines / 54 occurrences in `claude-agent.ts` (sitting 3 read 8 with the line instrument on a smaller file) | needs a resume driven from a second directory. Not reached — the sitting's budget went to the three cases above |

### Premises taken but NOT counted as rows

`D1.40`–`D1.54` are past this sitting's stop point and are recorded here only so the next one does not re-take them:
`startup` 30 occurrences in `sdk.d.ts` (D1.40); the twelve `HookEventName` members above (D1.41);
`__PERMISSION_UPDATE__` in 3 files (D1.42); `asyncRewake` 6 in `packages/shared/src/automations/hook-command.ts`
and `setSanitized(env, 'CLAUDE_EFFORT', …)` at that file's `:164` (D1.43); `signalExitCode` in 3 files (D1.44);
`permissionMode` 12 / `maxTurns` 14 / `background` 14 in `packages/shared/src/agents/definitions.ts` (D1.45);
`reloadAgents` 0 against a `watchAgents` family at 4 (D1.47); `costUsd` 3 in `claude-agent.ts` (D1.48);
`SEATBELT_TESTING_WILDCARD` 12 (D1.51); `MAX_WEB_SEARCHES_PER_SESSION_ENV` 12 and its `_COMPAT_` sibling 8
(D1.53); `jsonSchemaToZodShape` in 1 file, reading `schema.properties` at `claude-agent.ts:4616` (D1.54).
Three of those paths are corrections: `hook-command.ts` is under `automations/`, `definitions.ts` under
`packages/shared/src/agents/`, and neither spelling in the sitting-3 table resolves.

---

## 7. Where this sitting stopped

**The last row this lane covered is `D1.39`**, which is row 25 of its list counting `D1.234` first. `D1.40`
onwards — `D1.40`, `D1.41`, `D1.42`, `D1.43`, `D1.44`, `D1.45`, `D1.47`, `D1.48`, `D1.51`, `D1.52`, `D1.53`,
`D1.54` — are this lane's remaining list and the next sitting starts there; `D1.49` and `D1.50` are Windows and
Linux questions and are not drivable on this rig at all, and `D1.182` is rig-day. `D1.55` and everything above it
belongs to SIT-5c.

## What ran

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition) | P6.1080 | **PASS 8/8**, 22 703 ms, load 9.29 | `scripts/cdp/cases/rs-32.ts` |
| RS-63 | D1.234 | **PASS 7/7**, 170 634 ms — the row's own deferral reason refuted | `scripts/cdp/cases/rs-63.ts` |
| RS-64 | D1.6 | **PASS 8/8**, 204 118 ms — the sentence holds; A1's `auto` reading does not reproduce | `scripts/cdp/cases/rs-64.ts` |
| RS-65 | D1.7 | **FAIL 4 of 6**, 678 921 ms — driven twice with every measured cell agreeing; both FAILs are the one `dontAsk` finding | `scripts/cdp/cases/rs-65.ts` |

`bun scripts/bun-test-lock.ts run --label SIT-5b -- bun test ./scripts/cdp/harness.test.ts` green after every case
file this lane added. `bun run tsc -p scripts/cdp/tsconfig.json` exit 0 after every edit. `git diff --check` clean
before every commit.
