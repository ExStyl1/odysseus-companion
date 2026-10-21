# Host coverage by runtime: for each thing a runtime offers, do we project it?

Written 2026-09-02 by lane A3, measured at `ec765802b` on `feat/TCODE-000`. HEAD moved to
`1988dd78f` while this pass ran; the delta is docs-only — `git diff ec765802b..1988dd78f -- packages
apps` is empty — so every call site cited here is current.

**The question this file answers is the runtime-feature axis, not the user-capability axis.** The
capability ledger (`2026-08-28-capability-ledger.md`) asks *"can a user do X on runtime R"*. This file
asks the prior, mechanical question: **runtime R ships mechanism M — does our host feed it, use it,
expose it, or ignore it, and if it ignores it, is that a gap, a decision, or by design?** The two are
complementary and the owner wants both; where they disagree, they disagree about different things.

**The lens, restated by the owner today.** *A maximally thin host that uses the claude and codex
runtimes to the full. The host projects the data the runtimes need to work. What is common is done
once, in the host; what is runtime-specific is done only for that runtime. The host covers all three
runtimes: Pi, claude, codex.* **Pi is the deliberate exception to "thin"** — it is the in-house agent
kept as insurance and it has no contract of its own, so host code written for Pi is the design rather
than a violation (owner 2026-08-29, plan §"Owner answers 2026-08-29").

**Starting denominator.** `2026-08-28-runtime-feature-inventory.md`, which enumerates what each
runtime offers. It is five days and **537 commits** old; it was re-verified against the tree at HEAD
rather than trusted, and §5 below records where it was wrong. Only its `agent-loop` rows are tabled
here; the `not-agent-loop` rows are in Appendix A with a one-line reason each.

## How a row in this file was established

**"Host projects it" comes from the code that runs, never from a plan row saying it was done.** A
plan row is a pointer: it was followed to its commit and the commit to its call site. Several rows
closed as **refutations** — the row's claim was wrong and the feature did *not* move — and those are
marked, because a refutation and a delivery look identical in a tracker.

| Runtime | What counts as evidence here |
| :-- | :-- |
| **Claude** | the documentation IS the contract, because the binary is closed. Page anchors are `https://code.claude.com/docs/en/<page>.md#<section>` plus the verbatim sentence. Every anchor cited below was verified on 2026-09-02 by fetching the page **without** `.md` and grepping its `id="…"` set — **26 probed, 26 resolved**, and all 16 cited here are among them; none was derived from a slug rule. Membership questions read the vendored bundle instead: `@anthropic-ai/claude-agent-sdk` **0.3.223** (`claudeCodeVersion 2.1.223`). |
| **Codex** | `github.com/openai/codex` at **`rust-v0.148.0`** (our pin), the generated bindings under `packages/codex-protocol/generated/`, `packages/codex-protocol/schema/config-schema.json`, or the shipped binary = **strong**. `developers.openai.com` / `learn.chatgpt.com` alone = **weak — intent, not behaviour**. Every codex cell below is strong-tier or says otherwise. The generated bindings are a **floor**, not the surface: 47 experimental methods the binary serves are absent from them, and we already drive two of those. |
| **Pi** | no contract of its own. Pi's specification is Claude's page, so *"does the host project it"* for Pi means *"does Pi's host/extension path do what the Claude page says"*. A Claude gap is therefore a double gap on Pi. |

**Which side governs when the bundle and the page disagree**, per `AGENTS.md`: the bundle is the
denominator for what the runtime *can already do*; the documentation is the denominator for what we
*must be able to accept*. It matters per feature here. The vendored SDK is **0.3.223**; Artifactory
carries **0.3.233**, which declares the `archive` plugin source with a SHA-256 digest field. For the
`archive` question the **page/newer bundle governs** and our bundle is behind — which is why `P6.39`
built the credentialed archive download host-side, without digest verification, and why `P3.223` is
still open. For every other row here the vendored 0.3.223 governs and is named as the source.

**Absence rules.** An absence claim carries a positive control on the same rig. An identifier probe
is **systematically biased toward false absence** — an implementation that does the thing structurally
cannot contain the string being searched for — so wherever it was possible the call site was read
instead of grepped. `grep -a` was used for every absence claim (NUL bytes), and `:(glob)` for every
`git grep` pathspec (a bare `**` is read without glob magic and silently drops files).

**Four values, not three.** `yes` · `partial` · `no` · `by design not`. The fourth is not a softer
`no`: it means the host deliberately owns the mechanism instead, and there is a reason at the call
site. Filing one as a gap invites someone to "fix" a decision.

## The denominators, re-measured at HEAD

Every number below is a **reading with a date**, not a standing fact. Each was produced by a script
or by executing the builder, not copied from prose — three counts in this tree have moved while a
sentence beside them still said the old value.

| Denominator | Value | How it was read |
| :-- | --: | :-- |
| Claude SDK `Options` fields | **64** | script over `sdk.d.ts:1322-2107` |
| …of which the host sets | **26** | `claude-agent.ts:3781-4338` plus the six builders it spreads |
| …named nowhere in production code | **22** | probe over `packages/**/src` + `apps/**/src`, positive control `includePartialMessages` = 2 |
| Claude SDK `Query` members | **27** | script over `sdk.d.ts:2332-2638` |
| …of which the host calls | **5** | `interrupt`, `setModel`, `setPermissionMode`, `setMcpServers`, `stopTask`; `close()` is not called — teardown is `abortController.abort()` |
| Claude SDK hook events | **31** | `HOOK_EVENTS`, `sdk.d.ts:816` |
| …mapped by the host | **29** | `format-adapters.ts:174-230`; `Setup` and `TeammateIdle` deferred with reasons |
| Codex `config-schema.json` top-level properties | **94** | `json.load`, `additionalProperties: false` |
| …of which the host writes | **19** | **executing** `buildCodexConfigToml` on a maximal option set (20 with `[agents]`, 21 with `[hooks]`) |
| Codex `[features]` keys | **124** | same script |
| …of which the host writes | **2** | `multi_agent`, `view_image` |
| Codex `RawMcpServerConfig` fields | **27** | same script — **the inventory says 26** |
| Codex `ToolsToml` keys | **3** | same script; the host writes none |
| Codex `HookEventName` values | **11** | `packages/codex-protocol/generated/v2/HookEventName.ts`, read not paraphrased |
| Codex client→server methods in the bindings | **99** | `generated/ClientRequest.ts` + the one `ClientNotification` |
| …driven by the host | **18** | read at the request sites (16 listed + 2 bindings-absent experimental) |
| Codex `ServerNotification`s | **74** | `generated/ServerNotification.ts` |
| …handled by the host | **17** | three dispatch sites read; `optOutNotificationMethods` set to none |
| Codex `ServerRequest`s | **10** | `generated/ServerRequest.ts` |
| …answered by the host | **10** (6 bridged) | `codex-agent.ts:2943` → `approval-bridge.ts:929` |
| Parity plan tracker rows | **888** (631 ✅ / 235 ⬜ / 17 🟨 / 5 ⏸) | script over the tracker; on 2026-08-28 it was 679 / 391 / 277 / 3 / 7 |

---

# 1. Synthesis

*(Written after the tables. Read §2–§4 for the evidence behind every claim here.)*

## 1.1 Per runtime, in a paragraph

**Claude — the host feeds a quarter of the surface, and the shape of what it drops is consistent.**
Of 64 `Options` fields it sets **26**; of 27 `Query` members it calls **5**; of 31 hook events it
maps **29**; of `Settings`' 140 declared keys the managed tier carries **8** and the flag tier **2**.
Across the **103 rows** of §2: **38 yes · 18 partial · 40 no · 7 by design not**, and the 40 `no`
split **gap 25 · decision 10 · by design 5** (so 12 of the 103 are deliberate host ownership, and 25
are unclaimed). The consistent shape: what the host *drives* — model, prompt, permissions, hooks, MCP, agents, resume —
is projected well; what the host would have to *read back* — provenance, context usage, model
capability self-report, interrupt receipts, settings parse errors — is almost entirely unread. **Of the fifteen gaps in §2.5 — the settings / prompt / model / context half — exactly
one has a plan row.** That is the single most actionable fact in
this file: the Claude read-back surface is not a backlog, it is unmapped.

**Codex — the opposite shape. The host writes almost nothing, and most of what it does not write is
configuration, not construction.** Of 94 config properties it writes **19**; of 124 `[features]` keys
**2**; of 27 `RawMcpServerConfig` fields **5**; of 18 `ModelProviderInfo` fields **4**; of 99
bindings-listed methods it drives **18**; of 74 server notifications it handles **17** while opting out
of none, so 57 notification families are parsed and dropped every session. Across the **61 rows** of §3:
**22 yes · 13 partial · 20 no · 5 by design not** (one n/a), and the 20 `no` split **gap 11 ·
decision 8 · by design 1**. Read that split with its bias stated: this table groups unclaimed keys
into single rows where they share a reason (one row carries six unwritten tool families), so the
*per-key* gap count is higher — graded key by key it is **21 gaps of 31 absences**. But the five
days since the inventory moved codex more than any other column: `[otel]`, `[analytics]`,
`compact_prompt`, `outputSchema`, output styles, the DSL's `ask` tier, the thrash guard and nine hook
events all landed, and two of the inventory's headline "unwritten native switches" turned out to be
**dead keys upstream** rather than gaps. Codex's remaining absences are still mostly *never asked for*
rather than *forwarded and unobserved* — the opposite failure from Claude's, needing configuration
where Claude's needs measurement.

**Pi — the deliberate exception, and the column where "does the host project it" is the wrong
question by construction.** Pi has no contract, so every mechanism Pi has is host code written to
Claude's page, and the honest measure is conformance rather than projection. Against Claude's
documented agent-loop contract Pi scores **36 yes · 7 partial · 2 no · 1 by design not** over 46 rows
— the best of the three by a wide margin, and it should be, because 58 host modules under two
`pi-harness/` trees exist to make it so. **Four real gaps**: bundled skills never seed in a headless
server, `--add-dir` contributes rules but not skills/commands/subagents, non-image attachments reach
the model as filesystem paths, and — the largest — a counted subset of `settings.json` is read while
**29 ceilings/timeouts/budgets and 32 policy switches are silently unread**. Two further divergences
are *numbers* wearing a Claude-shaped refusal string: the subagent ceiling is RAM-derived (7 on a
16 GiB box against a documented 20) and the skill listing budget is 4 000 characters. **Where Pi is
thick, the seam is honest in one direction only** — a missing hook runner reports itself, while the
unread settings keys and `--add-dir` degrade with no diagnostic.

## 1.2 The thin-host verdict

**Where the host is correctly the seam.** Six mechanisms are host-owned across all three runtimes for
a stated reason, and each is the *cheap-to-unify* side of the share-vs-split rule: skills and plugins
(`Options.plugins: []` with read-before-execute, `claude-agent.ts:4311-4314`); scheduling — the host
owns the store, the tick and the delivery gate, and forces `CLAUDE_CODE_DISABLE_CRON=1` so a session
cannot carry two schedulers (`options.ts:270-301`, citing `scheduled-tasks.md#disable-scheduled-tasks`,
*"The cron tools and `/loop` become unavailable"*); the permission DSL and its non-negotiable floors;
the session store; instruction collection; and telemetry coverage marking. **Two are the model of
native-first done right:** durable Always-Allow grants are *projected into* codex's own execpolicy
rather than re-implemented beside it, and `ReportFindings` is deliberately **left to the SDK** because
the built-in is a documented superset of ours (`claude-agent.ts:670-677`) — subtracting the better
implementation to enforce symmetry is named at the call site as the failure to avoid.

**Where the host still duplicates something the runtime provides natively.** Nine, all shipping:

| # | Host machinery | The native mechanism it duplicates | Status |
| --: | :-- | :-- | :-- |
| 1 | `P6.39`'s credentialed archive download, **without digest verification** | the `archive` plugin source with a SHA-256 field, in SDK 0.3.233 | **P3.223 ⬜** — the owner has ruled the upgrade owed and the difference *covered or removed*; needs a quiet tree |
| 2 | `claude-transcript-rebuild.ts` re-implements the SDK's djb2 project-key hash, NFC cwd normalizer and JSONL layout, read out of the minified `sdk.mjs` | `getSessionInfo()`, `getSessionMessages()`, `listSessions()` | the **write** side genuinely has no SDK API; the **read** side does and is unused |
| 3 | host-derived context meter from `modelUsage[*].contextWindow` | `Query.getContextUsage()` — per-category tokens, memory files, MCP tools, deferred builtins, `autoCompactThreshold` | gap, no row |
| 4 | `isClaudeModel(model) && !model.includes('haiku')` string-matching | `ModelInfo.supportsEffort` / `supportedEffortLevels` / `supportsAdaptiveThinking` / `supportsFastMode` | gap, no row |
| 5 | host elicitation bridge + two host hook events | `Options.onElicitation` + the SDK's `Elicitation`/`ElicitationResult` hooks | gap, no row |
| 6 | host `sessions/file-checkpoints.ts` | `Options.enableFileCheckpointing` + `Query.rewindFiles()` | **decision, recorded** (`P3.31 ✅` closed the honest-message half and handed the wiring back); `P3.48 ⬜` |
| 7 | `event-adapter.ts`'s own `_sdkSlashCommands` roster | `Query.supportedCommands()` | equivalent data from `init`; low cost |
| 8 | host approval floor ladder above codex's own loop (`codex-agent.ts:2969`) | `approvals_reviewer = "auto_review"` — which we DO write, but it is **opt-in, default OFF** (`storage.ts:1907`) | justified (one rule, three runtimes) but two mechanisms exist and one is usually dark |
| 9 | host `thread/goal` and `/review` implementations | codex's own `thread/goal/*` and `review/start` | **Dev-9**, a deliberate uniformity trade — recorded, not an oversight |

**The one that is not a duplication but is worse.** The host's model-fallback retry chain is
**Pi-only** (`pi-agent.ts:8466-8473`) and `Options.fallbackModel` is never set, so a **claude turn has
no model fallback at all** — neither the runtime's nor ours. That is the inverse of a thin-host
violation: host machinery that exists, that the runtime also offers, and that reaches neither.

## 1.3 The switch verdict

The 40-row switch table of the inventory was re-verified row by row at HEAD; **29 of 40 moved in five
days** and **twelve closed as refutations** — the claim was wrong, the premise inverted, or the thing
was already true. A refutation and a delivery look identical in a tracker, which is why they are named
in §5.

**Twenty divergences remain SILENT** — the difference exists and nothing reports it: hook-event
coverage (1), deferred tool loading (4), effort reaching a gateway model (11), `web_search` through the
gateway (13), the built-in browser on codex (14), model-initiated MCP resources (15), the MCP tool
name the model is asked for (16), structured-output validation with no host backstop (18), the reason a
runtime switch degraded (19), attachments (20), images (21), the read-side floor on codex (24), an OS
deny's blast radius (27), managed `env` in headless (29), bundled skills in headless (31), `--add-dir`
components on codex (32), `isolation: worktree` on claude (35), `PushNotification` (36), the operator
output cap on codex (37), and the wire protocol (40).

**Three of those are the ones to fix first, because the user meets them and cannot act:**

- **19** — the blanket claude degradation is gone (only `missing`-window ids fall back now; `sdk-owned`
  takes the fit path, `runtime-switch.ts:485-491`), and when a switch *does* fall back to the 24×1200
  text tail the user still sees no reason: the `reason` value has **zero readers outside
  `runtime-switch.ts`** and never reaches the modal.
- **11** — `model_reasoning_effort` is written to codex's config and all six levels now pass through
  (`P6.31 ✅`), and then the loopback adapter's OpenAI-wire translation drops it: `toChatRequest`
  (`packages/codex-responses-adapter/src/to-chat.ts:190-318`) builds `model, messages, temperature,
  top_p, stream`, optional `tools` and optional `max_tokens` — **no `reasoning` or `reasoning_effort`
  field at all** (re-measured here; `max_tokens` at `:314` is the positive control, forwarded on the
  same path). So on a codex session against the gateway the effort the user chose reaches the config,
  the runtime and the adapter, and never the model. A control that is present, configured, and does
  nothing.
- **31** — a headless `nessy-server` seeds **zero** bundled skills on every runtime; the only production
  seed call is `apps/electron/src/main/index.ts:509`.

**Honesty is not one grade, and grading it as one has already hidden two rows.** Three channels carry a
divergence, and they reach different people:

| Channel | Reaches | Used by |
| :-- | :-- | :-- |
| `info` + `level:'warning'` → transcript, survives a reload (`claude-agent.ts:4340-4356`, R12) | **the user** | agent-definition degradations, uncarried images |
| `recordSessionFact` → session facts + `getRecentStderr()` | a diagnostic reader, and the user only on an error path | codex hook projection, rollout persistence |
| `onDiagnostic` → `this.debug` | **nobody on a packaged build** — such a build logs nothing outside debug mode (the trap register's standing warning, re-recorded by `P3.120`) | codex sandbox egress (26), the execpolicy grant note (28) |

So rows 26 and 28 are honest one grade weaker than rows 2 and 30, and two grades weaker than the
banner. **The best move available on the whole switch axis is cheap:** every SILENT row above already
knows its own state at a single call site — what is missing is a channel, and the strongest one already
exists and is used by three rows.

**Where the host is honest, it is very honest.** The clearest case is the audit stream: three runtimes
export three vocabularies that share **no event name** (host/Pi 4, claude SDK 25 `claude_code.*`,
codex 14 `codex.*`), so each stamps `nessy.telemetry.coverage` on its own OTLP resource
(`packages/shared/src/agent/telemetry-coverage.ts`) and one SIEM query can answer *"what am I not
seeing"* for every runtime. No page specifies such a key; it was chosen under the transparent-and-simple
rule and pinned by each stream's tests. That is the residual difference made **uniform or honest**,
which is what the host is for.

## 1.4 What remains to reach the goal — a shape, not a plan

The parity tracker holds **257 open rows** at HEAD (235 ⬜, 17 🟨, 5 ⏸) — P2 128, P3 112, P6 11, P4 4,
P5 2 — of which **53 carry `[doc:claude]`, 31 `[doc:codex]` and 173 no doc tag at all**. That last
number is the honest measure of how much of the queue is *not* the runtime-feature axis. Against the
tables above, what is left divides into five blocks of very different size and very different cost.

| Block | Rough size | Cost shape |
| :-- | :-- | :-- |
| **1. Give the 20 SILENT divergences a channel** | ~20 rows, small each | Each already knows its own state at one call site; what is missing is the channel, and the strongest one (the `info`/`warning` transcript banner) already exists and is used. Cheapest large win in this file. |
| **2. Read back what Claude already sends** | ~15 features, mostly small, **only one has a row** | `getContextUsage`, `ModelInfo`, provenance, `SDKSettingsParseError`, interrupt receipts, `ttft_ms`, `includeHookEvents`, `preserved_segment`, memory scopes. All are *reads*, so none changes behaviour — but the first four remove host duplication and the fifth closes a silent enforcement hole. |
| **3. Write codex's configuration** | ~20 keys + ~5 protocol fields | Native-first step 1, twenty-odd times over: `model_catalog_json`, `[tools]`, `[permissions.*].network`/`workspace_roots`, `[agents]` limits, the model/wire scalars, `optOutNotificationMethods`, `turn/start` overrides. Configuration, not construction — but each needs a measurement against the binary first, because two of the inventory's "just write the key" items turned out to be dead. |
| **4. The SDK upgrade, and the reconciliation it obliges** | one row, **whole-tree, quiet-tree only** | `P3.223 ⬜`. The deliverable is the owner's — *the difference covered or removed* — not a version bump: ten versions, one known host duplication to retire (`archive` + digest), and it lands in the permission classifier, hooks and tool surfaces where this plan's most delicate measurements live. |
| **5. The five controls that are present, configured, and do not act** | five rows, three of them failing **loose** | The largest defect class this fork has. Live at HEAD: `maxBudgetUsd` on codex against a cost codex emits nowhere; codex's `model_reasoning_effort` dropped by the adapter's own OpenAI-wire translation before it reaches the gateway; the auto-compaction operator knobs built and unwired; `isolation: worktree` forwarded into a field the SDK does not declare; 9 of 19 credential-floor entries reaching no enforcement anywhere. |

**Two things this list deliberately does not say.** It does not rank the blocks — that is the owner's
call, and blocks 1 and 5 are cheap while 3 and 4 are where the *capability* is. And it does not
promise that closing them converges — though the news there is better than it was. Between
2026-08-28 and today the tracker went 679 → 888 rows while **240 rows closed and 209 were born** — a
branching factor of **0.87** against the **2.24** the plan measured on 2026-08-28 — so the *open*
count fell for the first time, **287 → 257**. Two windows are not a trend, and the queue's size was
never the measure of the distance; but it is no longer growing faster than it is being worked.

---

# 2. Claude — the vendored Agent SDK, 0.3.223

**Citation convention for this section: a bare `` `:NNNN` `` is a line in
`packages/shared/src/agent/claude-agent.ts`.** Any other file is spelled out.

Grouped as the inventory groups it. `no` in this table means *the mechanism exists in the vendored
0.3.223 artefact and no production code path feeds, calls or reads it*; the probe was run over
`packages/**/src` and `apps/**/src` with `grep -a` and a named positive control, and every `by design
not` names the reason at its call site.

## 2.1 Sessions, streaming, message shapes

| feature | SDK offers it via | projected? | evidence (what runs) | if not |
| :-- | :-- | :-- | :-- | :-- |
| Resume by id | `Options.resume` | yes | `claude-agent.ts:4393` | — |
| Fork on resume + truncating fork point | `forkSession`, `resumeSessionAt` | yes | `claude-agent.ts:4396-4400`, from `branchFromSdkSessionId`/`branchFromSdkTurnId` | — |
| `continue` latest / explicit `sessionId` | `Options.continue`, `.sessionId` | no | absent from the literal; `resume`/`forkSession` two lines away are the control | decision — host owns session identity via `sdkCwd` + its own store |
| Out-of-process fork, session enumeration, per-subagent transcripts | `forkSession()`, `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `listSubagents()`, `getSubagentMessages()` | no | the only production imports from the package are `query, createSdkMcpServer, tool, AbortError` (`claude-agent.ts:2`); `listSubagents` has **0** occurrences repo-wide | by design for the store; **gap** for the read side — see §1.2 row 2 |
| Rename / tag / delete session | `renameSession()`, `tagSession()`, `deleteSession()` | no | not imported; `tagSession` 0 repo-wide | by design — host store owns naming |
| Persistence off / external transcript store | `persistSession`, `sessionStore` (`@alpha`) | no | never named in production | decision — the host rebuilds the SDK's own JSONL instead (`claude-transcript-rebuild.ts`) |
| Pre-warmed subprocess | `startup()`, `WarmQuery` | no | `WarmQuery` 0 repo-wide | gap, no row |
| Conversation reset | `SDKConversationResetMessage` | yes | `event-adapter.ts:418-422`, `info` banner | — |
| Live session reused across turns | async-iterable prompt | yes (host-built) | one `query()` per agent at `claude-agent.ts:5306`; `claudeLiveSessionSignature` decides respawn | — |
| Partial assistant streaming | `includePartialMessages` | yes | `claude-agent.ts:3838`; consumed `event-adapter.ts:390` | — |
| Time-to-first-token | `SDKPartialAssistantMessage.ttft_ms` | **no** | `ttft` has 0 hits on the claude path | gap — forwarded and unobserved |
| Hook lifecycle in-stream | `Options.includeHookEvents` | **no, and the consumer exists** | handlers at `event-adapter.ts:1122`/`:1139`; the option (`@default false`) is never set | gap — a handler wired to a stream nobody turned on |
| Subagent text to the parent stream | `forwardSubagentText` | no | never named | gap, no row |
| Frame provenance (`peer`, `verifiedPeerPid`) | `SDKMessageOrigin` | no | 0 hits under `backend/claude/`, against 6 other SDK types imported at `event-adapter.ts:60-66` | gap, no row |
| Transcript-only append / prompt priority | `SDKUserMessage.shouldQuery`, `.priority` | no | the three write sites emit neither field | gap, no row |
| Custom transport / control plane | `Transport`, `spawnClaudeCodeProcess` | no | tests only | decision — spawn via `pathToClaudeCodeExecutable` + `env` |
| Model refusal fallback | `SDKModelRefusalFallbackMessage` | yes | `event-adapter.ts:1095`, `:1108` | — |
| Background task stream | `SDKTaskStarted/Updated/Notification` | yes | `event-adapter.ts:1046`, `:1172`, `:1188` | — |
| `tool_use_summary`, `prompt_suggestion` | SDK message types | by design not | `event-adapter.ts:426-445` — explicit drops, each naming the missing surface | decision at the call site |
| Interrupt receipts | `Query.interrupt()` → `still_queued` / `cancel_queued` | partial | a uuid is stamped on every user message **precisely so the receipt is evidence** (`claude-agent.ts:4486-4489`) — then `void`ed at `:5943` and `:6463`; `cancel_queued` never sent | forwarded and unobserved, no row |

## 2.2 Tools and MCP

| feature | SDK offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| Tool gating by preset | `Options.tools` | yes | `claude-agent.ts:3869` `{type:'preset',preset:'claude_code'}` | — |
| `disallowedTools` | `Options.disallowedTools` | yes, 5 entries | `CLAUDE_SESSION_DISALLOWED_TOOLS` (`:616-690`): `EnterPlanMode, ExitPlanMode, Skill, Monitor, ScheduleWakeup` | — |
| Host tools shadowing built-ins | — | partial | **14 of 56 session tools share a built-in name**, 7 projected onto claude; only `Monitor`/`ScheduleWakeup` subtracted, `Cron*`/`TodoWrite` off via env, `ReportFindings` **deliberately left to the SDK** | decision, measured tool by tool at `:620-688` |
| `allowedTools` | `Options.allowedTools` | no | not in the literal (`disallowedTools` next line is the control) | decision — preset + deny is the shape |
| Tool aliasing / per-tool render config / search hints | `toolAliases`, `toolConfig`, `tool(…,{searchHint})` | no | never named | gap, no row |
| Deferred tool loading | `tool(…,{alwaysLoad})`; `agent-sdk/tool-search.md#how-tool-search-works` | yes, per tool | `claude-agent.ts:2297` `alwaysLoad` per proxied tool; the server-level flag deliberately unwritten | — (P2.454) |
| MCP transports (stdio/SSE/HTTP/proxy) | `McpStdioServerConfig` and four siblings | **by design not** | the only `mcpServers` values are in-process `createSdkMcpServer` proxies — `claude-agent.ts:3596-3609`, built at `:2302` | by design — the host MCP pool owns transports, auth and elicitation for all three runtimes |
| Per-server tool policy with an org ceiling | `McpServerToolPolicy.org_max_permission`; `managed-mcp.md#exclusive-control-with-managed-mcp-json` | no | 0 hits repo-wide | gap — structurally unreachable while every server is the SDK-instance type |
| In-process MCP servers | `createSdkMcpServer()`, `tool()` | yes | three production call sites — `claude-agent.ts:2302` (per-source proxy), `session-scoped-tools.ts:354`, `sources/api-tools.ts:336` | — |
| Runtime MCP control | `setMcpServers`, `reconnectMcpServer`, `toggleMcpServer`, `mcpServerStatus`, `strictMcpConfig` | partial, 1 of 5 | `claude-agent.ts:5397` `live.setMcpServers(servers)`, result checked against the asked-for set | gap for the other four |

## 2.3 Permissions

| feature | SDK offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| Six permission modes | `PermissionMode`; `permission-modes.md#available-modes` | yes | `claude-agent.ts:3903` `buildClaudePermissionModeOptions(getPermissionMode(sessionKey))` | — (R3) |
| Host approval callback | `CanUseTool` | yes | `claude-agent.ts:4301` `buildClaudeCanUseTool({…})`, body `:1049-1127` | — (R2/R3) |
| Result variants emitted | allow / deny (+`updatedInput`, `updatedPermissions`, `interrupt`) | partial | allow, allow+`updatedInput`, deny+`message`. **No `interrupt`, no `updatedPermissions`** | decision at `:1022-1027` — taking `suggestions` would write rules into user settings behind one "always allow" click; the card is raised `noAlwaysAllow` |
| Rule updates and their five destinations | `PermissionUpdate`, `PermissionUpdateDestination`; `permissions.md#permission-rule-syntax` | no | never emitted; `permission-manager.ts:127` only cites `destination:'session'` in a comment | decision, same call-site reason |
| Bypass gate + its org lock | `allowDangerouslySkipPermissions`, `disableBypassPermissionsMode` | yes | set by the mode builder; hashed into `claudeLiveSessionSignature` (`live-session.ts:154`) so crossing the boundary respawns | — |
| Live mode change | `Query.setPermissionMode()` | yes | `claude-agent.ts:5389`, behind `withLiveSettingDeadline` | — (L4) |
| Per-MCP tighten-only override | `Query.setMcpPermissionModeOverride()` | no | 0 call sites | gap, no row |
| Denial record → audit receipt | `PermissionDenied` hook | yes | `claude-agent.ts:4206-4227` `buildClaudeAutoModeDenialReceipt`, returns `{continue:true}` | — (P3.97) |
| Escalating-`defaultMode` filter | `filterEscalatingDefaultMode()` | no | 0 occurrences repo-wide | gap, no row |
| Plan-mode instruction body | `Options.planModeInstructions` | by design not | `EnterPlanMode`/`ExitPlanMode` are disallowed; Safe Mode is the host surface, and the row that would hand plan mode back is **recorded refuted** (`claude-agent.ts:594-596`) | decision |
| Auto-mode classifier config | `Options.settings.autoMode` | yes | `claude-agent.ts:3776`, folded into the single `settings` spread at `:3866`. **`autoMode` is not in the SDK's declared `Settings` type at all** — binary-schema-only | — (P3.94/P3.95) |
| Credential floor → `permissions.deny` | flag settings | yes | `claude-agent.ts:3752-3789` `mapDeniedPathsToClaudeRules`. Measured limitation kept in place: `Grep`/`Glob` still return the denied file | P3.147 ⬜ (claude half landed; codex half owed), P3.105 |
| `Options.sandbox` (network/filesystem/credentials) | `SandboxSettings`; `sandboxing.md#how-sandboxing-relates-to-permissions-and-permission-modes` | **by design not** | no `sandbox:` key in `claude-agent.ts` (`sandbox` = 1 unrelated hit against `cwd` = 25 as control). **Live hazard recorded** at `claude-auto-mode-policy.ts:60`: the SDK's sandbox branch calls `.trim()` on `Options.settings`, so passing it today would throw on our object settings | standing owner decision 2026-08-12/13 |

## 2.4 Hooks, subagents, skills, plugins

| feature | SDK offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| Programmatic hook registration | `Options.hooks`; `hooks.md#hook-lifecycle` | yes | the `hooks:` IIFE, `claude-agent.ts:3905-4285` | — |
| Host-authored events registered | — | partial — 4 direct | `PreToolUse` :3914, `PermissionDenied` :4206, `SubagentStart` :4232, `SubagentStop` :4239 | — |
| User / project / plugin / **skill-frontmatter** hooks reach the SDK | — | yes | `hooks-automation.ts:505-543` `buildSdkHooks()` merges four tiers **plus the component layer** (`:577-599`); `mergeClaudeSdkHooks` drops the trusted `PreToolUse` bucket so that event runs through our gate | — P6.59 ✅ |
| Event vocabulary | 31 `HOOK_EVENTS` | partial, 29 of 31 | `format-adapters.ts:174-230`; `Setup` (no launch mode) and `TeammateIdle` (no agent-team lifecycle) deferred with author-facing reasons | decision |
| Five handler kinds | `command \| prompt \| agent \| http \| mcp_tool`; `hooks.md#prompt-based-hooks` | yes, host-executed | `hooks-automation.ts:495-501` passes all five runners into every tier | — P6.12 ✅ |
| Four admin locks on hooks | `allowManagedHooksOnly` + 3 | partial | `allowManagedHooksOnly` written (`claude-managed-settings.ts:1093`); `disableAllHooks` and `allowedHttpHookUrls` classified `no-sdk-tier`, host-gated | decision + P2.496 ⬜ |
| Agent roster | `Options.agents`; `sub-agents.md#configure-subagents` | yes | `claude-agent.ts:4322` `buildClaudeRuntimeAgentOptions(…)` | — (Q7) |
| `AgentDefinition.skills` | :67 | **no, refused by name** | `claude-runtime-agents.ts:192-201`; bodies are inlined into the prompt by `applyAgentSkills` instead | decision — the SDK would resolve *names* against `.claude/skills` and drop our tool restrictions and budget (R10) |
| `AgentDefinition.mcpServers` / `initialPrompt` / `componentHooks` | — | no | `claude-runtime-agents.ts:205-230`; `componentHooks` is unrepresentable from our normalized value and is **announced to the user** | decision + R12 |
| `isolation: worktree` | undeclared in the typings, accepted by the binary | yes, unobserved | `claude-runtime-agents.ts:133` `SdkAgentDefinition = AgentDefinition & { isolation?: AgentIsolation }` | P3.205 ⬜ — goes inert **silently** if the binary drops the field |
| Main-thread agent | `Options.agent` | no | the builder returns `agents` only; `claude-runtime-agents.ts:213` states we never set it | decision |
| `supportedAgents()` / `supportedCommands()` | `Query` | no | 0 call sites; the host reads `init.slash_commands` instead, kept current by `commands_changed` | gap for `supportedAgents`; equivalent data for commands |
| Background task control | `stopTask()` / `backgroundTasks()` | partial | `stopTask` at `:6840`; `backgroundTasks()` never called | gap for the reader |
| Subagent concurrency / depth ceiling | env vars | yes | `options.ts:586` writes `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `:526` writes `…_MAX_SUBAGENT_SPAWN_DEPTH`; both only when the operator has not already set the name | — P6.16 ✅ |
| Agent teams | `agent-teams.md` | by design not | owner decision, recorded as **Dev-1** | decision |
| `Options.skills` | :1986 | **no** | neither `Options.skills` nor `AgentDefinition.skills` is ever set | by design — read-before-execute, `PrerequisiteManager`-enforced |
| `Options.plugins` | `plugins/components.md#explore-the-plugin-directory` (was plugins § plugin-structure-overview) | **by design not — `[]`** | `claude-agent.ts:4315`, reason at `:4311-4314`: skills go via read-before-execute, plugin *agents* via `Options.agents` from the same capability definitions | by design |
| `reloadSkills()` / `reloadPlugins()` | `Query` | no | 0 call sites | by design — nothing on the SDK side to reload |
| SDK-native skills/commands from the repo | `settingSources`; `settings.md#settings-precedence` | yes | `claude-agent.ts:1356` `['user','project','local']` | — |
| `--add-dir` roots contributing components | `additionalDirectories` | yes | `claude-agent.ts:3848` | — P6.34 ✅ |
| Slash-command dispatch | `SlashCommand`, `commands_changed` | partial | only `/compact` is dispatched (`SDK_SLASH_COMMANDS = ['compact']`, `:4388`); the roster is read, not used to dispatch | decision (`/clear` at the `BaseAgent` seam) + P6.57 ⬜ |
| Marketplace trust settings | 8 `Settings` keys; `plugin-marketplaces.md` | partial, 1 of 8 | only `strictPluginOnlyCustomization`; three classified `widening` (a floor never activates), two `no-sdk-tier` and refused by the host marketplace gate at add/upgrade/load/delivery | decision with a reason string each; P2.501 ⬜, P3.243/P3.244 ⬜ |
| `disableSideloadFlags`, `pluginConfigs` | `Settings` | no | not in the policy map | gap, no row |

## 2.5 Settings, prompt, memory, model, context

| feature | SDK offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| Three setting sources + a flag tier | `settingSources`, `settings` | yes | `:1356`, `:3775`; the flag tier writes **2** keys (`permissions.deny`, `autoMode`) | — |
| Managed policy tier | `managedSettings` | yes, **8 of 140** | `claude-managed-settings.ts:1085-1128`; every unmapped key is classified `widening` / `no-sdk-tier` / `enforced-elsewhere` **with a reason and a diagnostic** | — P2.7 |
| Settings provenance | `resolveSettings()`, `ProvenanceEntry`, `PolicySettingsOrigin` | **no** | `ProvenanceEntry`: sdk 2 / host 0; the three `resolveSettings` hits are the host's own same-named function | gap, no row |
| Mid-session flag settings | `Query.applyFlagSettings()` | no | only a docblock inventory in `live-session.ts` | gap, no row |
| Managed-policy parse failure | `SDKSettingsParseError`; `managed-settings.md#invalid-entries-in-managed-settings` | **no** | sdk 2 / host 0 — **a settings file skipped for a parse error, its deny rules unapplied, is silent** | gap, no row |
| Three system-prompt starting points | `Options.systemPrompt`; `agent-sdk/modifying-system-prompts.md#how-system-prompts-work` | yes, 2 of 3 | `claude-agent.ts:1339-1352` — preset+append for a turn, plain string for a mini agent | — |
| `excludeDynamicSections` | preset form | yes | `claude-agent.ts:1250` | — |
| Cache split marker | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | no | sdk 5 / host 0 | gap, no row |
| Output styles | `Settings.outputStyle`; `output-styles.md#how-output-styles-work` | **by design not** | the host resolves the style (`:3567`) and splices prose into `presetAppend` via `getSystemPrompt(…, turnOutputStyleId, …)`; the SDK key is never written | by design — one style engine for three runtimes |
| CLAUDE.md load semantics | `claudeMd`, `claudeMdExcludes`; `memory.md#claude-md-files` | partial | excludes are applied by the **host** gate; the mapper files the SDK key as `no-sdk-tier` **with the residue named**: *"the SDK child re-loads what it excluded through a cascade our value cannot reach"* (`claude-managed-settings.ts:465-495`) | decision, recorded in place (P3.254) |
| Auto-memory | `autoMemoryEnabled` / `Directory` / `autoDreamEnabled` | partial, OFF only | `options.ts:331` `applyAutoMemoryOffSwitch(env)`; the ON direction writes nothing, deliberately (`:395-400`) | decision — P6.33 ✅ |
| Memory recall stream | `SDKMemoryRecallMessage` | partial | `event-adapter.ts:1282-1290` emits count + mode; `memories[]` and the three scopes dropped | — |
| Model + live setter | `Options.model`, `Query.setModel()` | yes | `:3785`, live reconcile via `claudeLiveSettings` | — |
| `fallbackModel` | `Options.fallbackModel` | **no** | 0 production sites on the claude path; the host's own fallback-chain retry is **Pi-only** (`pi-agent.ts:8466-8473`) — so a claude turn has no model fallback at all | gap + thin-host, no row |
| Model capability self-report | `ModelInfo.supportsEffort` and siblings | **no — hard-coded instead** | `claude-agent.ts:1184-1187` string-matches `isClaudeModel(model) && !model.includes('haiku')`; each identifier sdk 1 / host 0 | gap + thin-host |
| Thinking, three shapes | `ThinkingConfig` | yes, all three | `:1197` disabled, `:1204` adaptive, `:1208` token fallback; `display` never set | — |
| Five effort levels | `EffortLevel`, `Options.effort` | yes, **5 of 5** | `thinking-levels.ts:75` `THINKING_TO_EFFORT`, `off` → `null` | — |
| Betas incl. the 1M context beta | `Options.betas`, `SdkBeta` | no | `:3655-3665` — 1M is opted into with a **`[1m]` model suffix** because the betas header only works for API-key users, and the interceptor strips the SDK-injected header | decision, recorded at the call site |
| Fast mode | `FastModeState` | no | sdk 6 / host 0 | gap, no row |
| Turn ceiling | `Options.maxTurns` | partial | child-only; the builder's docblock says no caller supplies it today | by design |
| USD ceiling | `Options.maxBudgetUsd` | yes | `:3843` | — P2.28 ✅ |
| Task budget | `Options.taskBudget` | no | host 0 | gap, no row |
| Full context accounting | `Query.getContextUsage()` | **no** | the meter is derived from `result.modelUsage[*].contextWindow` (`event-adapter.ts:865-899`); the three host hits are `pi-agent-server`'s own same-named function | gap + thin-host |
| Compaction boundary | `SDKCompactBoundaryMessage`; `context-window.md#what-survives-compaction` | partial | `event-adapter.ts:1039-1043` emits a banner; `preserved_segment` / `preserved_messages` unread | — |
| Auto-compaction ON/OFF | `autoCompactEnabled` | yes | `claude-agent.ts:1781` → `DISABLE_AUTO_COMPACT`, wired at `:3060` and `:2836` | — P6.53 ✅ |
| Auto-compact **window** and its operator knobs | `autoCompactWindow` | partial | the catalogue-derived window is emitted; **`buildClaudeAutoCompactionKnobEnv` and its diagnostics have ZERO production call sites** | gap, deliberate and stated in the module's own first line — **P3.235 🟨** |
| Precompute compaction / re-seed read cache | `precomputeCompactionEnabled`, `Query.seedReadState()` | no | host 0 / docblock only | gap, no row |
| Structured output | `Options.outputFormat` | yes | `:3839`; retry exhaustion mapped at `event-adapter.ts:101` | — |
| Todos | native `TodoWrite`, `todoFeatureEnabled` | partial | the native tool is off by SDK default since 2.1.142 and nothing sets `CLAUDE_CODE_ENABLE_TASKS`; the host projects `mcp__session__TodoWrite` | by design, recorded |
| File checkpointing / rewind | `enableFileCheckpointing`, `Query.rewindFiles()` | **no** | host runs `sessions/file-checkpoints.ts:29`, whose own docblock says the SDK's is unwired and its store is not ours | decision — P3.31 ✅ (honest-message half), P3.48 ⬜ |
| MCP elicitation | `Options.onElicitation` + two hook events | **no** | `elicitation-ask-user.ts` bridges to the host permission surface; `base-agent.ts:2689-2791` emits host events | gap + thin-host, no row |
| Host-rendered dialogs | `onUserDialog`, `supportedDialogKinds` | no | host 0 both; fails closed by SDK default, so nothing breaks — the host simply never receives one | gap, no row |
| Per-model usage | `modelUsage` | yes | `event-adapter.ts:865-908`, with a per-turn delta because the SDK's map is cumulative | — |
| Rate-limit windows | `Query.usage_EXPERIMENTAL…()` | partial | the polling API is unused; the **streamed** `rate_limit_event` is handled (`:414` → `:1695`) | gap for the API |
| Org policy limits | `ORG_POLICY_LIMIT_PREFIXES` | no | host 0 | gap, no row |
| Provider selector env vars | 7 `CLAUDE_CODE_USE_*` + companions | **yes — stripped** | `options.ts:315-317` over `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS` (`config/claude-provider-routing-env.ts:123-153`, all seven plus four endpoint/credential companions); also cleared from the host env at `llm-connections.ts:1244` | — P3.112 / R40 |
| Account info, forced login method | `accountInfo()`, `forceLoginMethod` | no | host 0 | by design — **gated**, the subscription cards are built and flag-off |

---

# 3. Codex — the shipped app-server at `rust-v0.148.0`

Every cell is **strong** tier — generated bindings, `config-schema.json`, or an in-tree measurement
that names its own rig and date — unless marked otherwise. The binary was not executed for this pass;
where a row rests on a prior in-repo measurement it says so, and §5 records one such citation that has
since gone stale, which is the reason the qualification is not decoration.

## 3.1 Config surface — 19 of 94 top-level properties

| feature | codex offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| The config file itself | 94 top-level properties, `additionalProperties: false` | partial, **19** | `config-writer.ts:2332` `buildCodexConfigToml`, measured by execution | per-key below |
| Model, provider, provider block | `model`, `model_provider`, `[model_providers.*]` (18 fields) | partial, **4 of 18** | `:2355`, `:2480-2485` — `name, base_url, wire_api="responses", env_key` | decision (the loopback adapter owns auth and retry); the other 14 are gap |
| Context window + auto-compact limit | `model_context_window`, `model_auto_compact_token_limit` | yes, conditional | `config-writer.ts:2356-2365`, limit = 0.85 × window; omitted when the catalogue has no real window | — |
| Reasoning effort | `model_reasoning_effort` | yes | `config-writer.ts:2343` from `thinkingLevel` | — |
| Compaction steering | `compact_prompt` | partial | emitted at `:2375`; the feeder `codex-agent.ts:1934` returns `{}` unless Pi context resources exist and logs that it does | residue gap — P2.436 ✅ with a named residue |
| Telemetry | `[otel]`, `[analytics]` | **yes, unconditional** | `config-writer.ts:2306-2326` `buildCodexOtelToml`; `log_user_prompt = false` is pinned and never configurable; drift-guarded at `:2639` | — P2.450 ✅ |
| Shell env policy | `[shell_environment_policy]` | yes | `config-writer.ts:2551` (`set` + `exclude` of the pool token) | — |
| Hosted web search | `web_search` (4 modes) | yes, hard-disabled | `config-writer.ts:2380` — hosted on OpenAI's backend, unreachable through the Nestor adapter | by design |
| `[tools]` table | 3 keys | **no** | 0 emitted occurrences; only a docblock naming them at `:1118` | gap, no row found |
| `[plugins]`, `[marketplaces]`, `[skills]`, `[profiles]`, `[projects]`, `[history]`, `[orchestrator]`, `[apps]`, `notify`, `log_dir`, `cli_auth_credentials_store`, `hide_agent_reasoning`, the four `include_*` | schema | no | 0 emit hits | decision for the plugin/skill layers (host owns them); gap for the ops keys |

## 3.2 Protocol surface

| feature | codex offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| Client→server methods | 99 in the bindings, +47 experimental the bindings omit | partial, **18 driven** | `initialize`, `initialized`, `configRequirements/read`, `permissionProfile/list`, `thread/start`, `thread/fork`, `thread/compact/start`, `thread/inject_items`, `thread/approveGuardianDeniedAction`, `thread/backgroundTerminals/{list,terminate}`, `turn/{start,steer,interrupt}`, `config/{value/write,mcpServer/reload}`, `fuzzyFileSearch` | gap |
| Server→client requests | 10 | **yes — 10 answered, 6 bridged** | `codex-agent.ts:2943` → `approval-bridge.ts:929`; `account/chatgptAuthTokens/refresh` and `attestation/generate` answered `{}` deliberately — *"every value we could invent would be a forged one"* (`:2915`) | by design for the last two |
| Server→client notifications | 74 | partial, **17 handled** | `event-adapter.ts:953` (10) + `:1216` (7) + `codex-agent.ts:2272` + `app-server-client.ts:219/:230` | gap |
| Notification opt-out | `InitializeCapabilities.optOutNotificationMethods` | **no** | `codex-agent.ts:2146` sends only `{experimentalApi:true, requestAttestation:false}` — so **57 notification families are parsed and dropped every session** | gap, unstated |
| `thread/start` params | ~15 fields | partial, **3** | `:2234` sends `cwd, model, developerInstructions` | `baseInstructions` by design (below); the rest gap |
| `thread/fork` params | — | partial, 5 | `:3467` `threadId, cwd, model, config, developerInstructions`; the `config` map (`buildCodexRuntimeConfigOverride`) carries `shell_environment_policy` + `default_permissions` + the profile's `filesystem` | — |
| `thread/resume` | 3 modes with a stated precedence | **no** | 0 literals outside the bindings | decision — `thread/fork` is the config-reload boundary; resume ignores config overrides (`:3452`) |
| `thread/inject_items` — native history carry | measured live at the pin | yes | `codex-agent.ts:3629`, with a text fallback at `:3664` | — |
| `turn/start.outputSchema` | `TurnStartParams` | **yes** | `codex-agent.ts:4070`; armed at `:4041`, and validated host-side because the field is silently ignorable (no `additionalProperties:false`) | — P3.5 ✅ |
| Other `turn/start` overrides | `cwd, approvalPolicy, approvalsReviewer, sandboxPolicy, model, serviceTier, effort, summary, personality` | **no** | the same call site carries none | gap — mid-turn steering is unavailable |
| Image input | `UserInput` 7-member union | yes | `codex-agent.ts:4066` text + `localImage` by resolved path; uncarried images **announced** at `:4055` | — P6.28 |
| Steer / interrupt | `turn/steer` (with `expectedTurnId`), `turn/interrupt` | yes | `codex-agent.ts:4382`, `:1893`/`:4505`/`:4557` | — |
| Background terminals | 2 of the 47 bindings-absent methods | yes | `codex-agent.ts:2715` turn-head poll, `:4189` id probe; `…/clean` deliberately not called (`:2654`) | by design for `clean` — P3.3 |
| Managed requirements | `configRequirements/read` | yes | `codex-config-requirements.ts:112` ← `codex-agent.ts:2172`; only `read`/`none` write the tier, `failed`/`unsupported` leave the standing one | — P2.7 / P2.463. **The inventory omits this driven method entirely** |
| `externalAgentConfig/{detect,import,…}` | 4 methods, 10 item types | no | 0 hits repo-wide | gap, no row found |

## 3.3 Tools, MCP, instructions

| feature | codex offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| `[features]` table | 124 keys | partial, **2** | `:2400-2427` `multi_agent = true`, `view_image = true`, both drift-guarded at `:2718` | gap |
| `features.tool_search` (+ `…_always_defer_mcp_tools`) | keys exist in the schema | **by design not** | `:2428-2452` — both are **`Stage::Removed` at the tag**, `apply_map` skips them, `Feature::ToolSearch` has **zero readers** in the codex tree, measured in both directions against the bundled binary with `view_image` as the live control. The real gate is `search_tool_enabled = model_info.supports_search_tool && provider.capabilities().namespace_tools`, **neither operand reachable from `config.toml`**, and gateway models fall to codex's fallback metadata which hardcodes `supports_search_tool: false` | decision on a **refuted premise** — P2.456 🟨; residue P2.462 ⬜ |
| `view_image` | the only tool returning an image content item; codex has no `read` tool | yes | `config-writer.ts:2427`; verified against the shipped binary in both directions | — P3.116 |
| Multi-agent | `features.multi_agent` + `[agents.<role>]` | yes | `config-writer.ts:2400`, roles at `:2578-2584`, per-role `developer_instructions` at `:1207` | fan-out limits (`max_depth`, `max_concurrent_threads_per_session`, `default_subagent_*`, `interrupt_message`) are **gap** |
| `update_plan` | live on codex's default | partial | the tool runs; **the adapter renders no `plan` item** — `event-adapter.ts:1000` does not handle it and `isToolItem` (`:215`) does not list it | gap — plan updates are invisible in the transcript |
| `request_user_input` | `ServerRequest` + `ToolsToml` | by design not | `approval-bridge.ts:771` answers `{answers:{}}` and **degrades loudly**: *"this runtime has no question surface"* | by design |
| Dynamic tools | `thread/start.dynamicTools`, `item/tool/call` — gated on `experimentalApi`, **which we declare** | no | `approval-bridge.ts:780` refuses: *"no dynamic tool is registered by this client"* | decision — **Dev-10**, experimental + bindings lag, revisit on stabilisation |
| `unified_exec` family, `memory_tool` + `[memories]`, `code_mode`/`js_repl`, `image_generation`, `browser_use`/`computer_use`, `shell_snapshot` | schema | no | 0 emit hits each | gap, no rows |
| MCP server config | `RawMcpServerConfig`, 27 fields | partial, **5** | `:2538-2547` session (`command,args,env`), `:2551-2556` sources (`url,bearer_token_env_var`) | gap |
| `required = true` | mechanism measured working | **by design not** | `:2500-2536`: per-entry granularity cannot express an operator's mark because every operator server aggregates behind `sources`, so the host takes codex's other half — `mcpServer/startupStatus/updated` (`codex-agent.ts:5372`) with a notice at `:5419` | decision — P2.508 |
| `features.non_prefixed_mcp_tool_names` | schema | no | 0 hits | by design — flipping it would break every `mcp__session__` consumer in this tree |
| MCP runtime RPCs | `mcpServer/{oauth/login,resource/read,tool/call}`, `mcpServerStatus/list` | no | 0 literals; `mcpServerStatus/list` explicitly ruled out at `codex-agent.ts:2375` | gap / decision |
| `thread/start.developerInstructions` | protocol | **yes, all three legs** | `codex-agent.ts:2237`, `:3471`, `:3501` — `codexDeveloperInstructions(activeOutputStyle()?.prompt)` | — P3.33, and P6.36 for the style |
| `baseInstructions` | protocol | **by design not** | never sent; the comment at `:2235` records the measurement — sending it collapses codex's own prompt from **20,751 characters to 68** | by design |
| `instructions`, top-level `developer_instructions`, `model_instructions_file`, `project_doc_*`, `project_root_markers`, the four `include_*` | schema | no | 0 emit hits | decision (codex's defaults apply) — but **unstated in the config**, so nothing says which defaults are in force |

## 3.4 Approvals, sandbox, hooks

| feature | codex offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| Approval policy + sandbox mode | `AskForApproval`, `SandboxMode` | yes | `config-writer.ts:2333-2335` via `codexSandboxConfigForMode` (`:618`); with the sandbox master switch off, `danger-full-access`, and `never` degrades so the approval channel survives (`:629-634`) | — |
| Native reviewer | `approvals_reviewer = auto_review`, `[auto_review].policy` | yes, **opt-in, default OFF** | `:2339` (gated on an interactive policy), `:2457-2462`; `storage.ts:1907 getCodexAutoReviewEnabled()` defaults false | decision — but see §1.2 row 8 |
| `approvals_reviewer = guardian_subagent` | schema | no | 0 emit hits | gap, no row |
| Permission profiles | `[permissions.<name>]` — `description, extends, filesystem, network, workspace_roots` | partial | `:2489-2498` + `default_permissions`; the profile is **verified live** by `permissionProfile/list` (`codex-agent.ts:4935`), and a session starts *unverified* with a debug line if unanswered | `network` and `workspace_roots` are **gap** — the only shape that could keep the credential deny *and* lift confinement |
| Agent-shell egress | `sandbox_workspace_write.network_access` | **no — and no longer unexamined** | `config-writer.ts:880-978`: both native alternatives measured and refused (`features.network_proxy` inert under `Restricted` and a *regression* under `danger-full-access`; `features.request_permissions_tool` is `Stage::UnderDevelopment`). `formatCodexSandboxEgressDiagnostics:964` emits a per-build operator diagnostic naming the state and both refusals | decision, transparent — P2.384 ✅, P3.45 ✅ |
| Durable grants → execpolicy | `CODEX_HOME/rules/*.rules` | yes, three tiers | `codex-agent.ts:2041/2048/2054`, `allow`/`deny`/`prompt` | — the model case of native-first |
| Host non-negotiable floors | host-authored | yes | `codex-agent.ts:2969 floorVerdict`, above both the headless yes and the rule consult | see §1.2 row 8 |
| `[hooks]` — the eleven events | `HooksToml` / `HookEventName.ts` | **by design not** | the builder, the eleven PascalCase keys, the trust-state half and a schema drift test all exist (`config-writer.ts:2569`, `config-writer-hooks.test.ts`); `codex-agent.ts:1682 hostAuthoredHookProjection()` returns `{}` and **unconditionally records** `CODEX_HOOK_PROJECTION_NOTICE`. Owner ruling 2026-08-29: only host-authored hooks are projectable, because a projected hook runs outside `ProcessSupervisor`, outside plugin-integrity verification and outside the managed kill switches — and the host authors none today | by design — P2.414, P6.14. **The inventory's "we write no `[hooks]` table" is right on bytes and wrong on mechanism** |
| `hooks/list`, `plugin/*`, `marketplace/*`, `skills/*` RPC | `ClientRequest` | no | 0 literals | decision — the host owns plugins and skills on all three runtimes |

## 3.5 Model, wire, compaction, cost

| feature | codex offers it via | projected? | evidence | if not |
| :-- | :-- | :-- | :-- | :-- |
| Wire | `WireApi` = `["responses"]` only at this pin | yes | `config-writer.ts:2483`, enum-guarded at `:2828` | — |
| `model/list` | per-model `inputModalities` | no | 0 literals | **decision on a refutation** — P3.115 ✅: codex's catalog is its own 8 OpenAI models and our Qwen id is in neither list, so wiring it would stamp `gpt-5.6-sol`'s modalities onto a Qwen turn |
| `model_catalog_json` | a client-owned catalogue carrying window, reasoning levels, service tiers and shell type | **no** | 0 emit hits; we describe our model with two top-level scalars | **gap — native-first step 1 never asked** — P3.201 ⬜ |
| `modelProvider/capabilities/read` | `ClientRequest` | no | 0 hits | gap |
| `model_reasoning_summary`, `model_verbosity`, `plan_mode_reasoning_effort`, `service_tier`, `model_auto_compact_token_limit_scope`, `tool_output_token_limit`, `review_model`, `oss_provider` | schema | no | 0 emit hits each | gap; only the `_scope` default has an in-tree "the default is the safe direction" note (`:1611`) |
| Managed new-thread defaults | `configRequirements/read` → `models.newThread.*` | **partial — read, deliberately not applied** | parsed at `codex-config-requirements.ts:646-654`; `:867-880` reports *"this build resolves a model for every codex thread before the requirement is read, so the requirement is NOT applied"* | decision, transparent — P3.239 |
| Compaction | `thread/compact/start`, `contextCompaction`, `thread/compacted` | yes | driven at `:4003`; both notification shapes handled; thrash guard at `codex-agent.ts:2411` | — P2.437 ✅ |
| Token usage | `thread/tokenUsage/updated` | yes | `codex-agent.ts:2303` → `usageTracker.recordMessageUsage` + `setContextWindow` | — |
| Cost in USD | `ThreadUsage.estimatedUsageUsdMicros`, `account/usage/read` | **no** | 0 callers; `codex-agent.ts:2901 reportsCostUsd() → false`, with an explicit *"whoever wires it must delete this override"* | gap — **and the host's `maxBudgetUsd` ceiling runs on codex against a cost codex emits nowhere: a silently inert ceiling.** P2.258 ⬜ |
| `thread/goal/*`, `review/start` | 3 + 1 methods, `[goals]` config | no | 0 hits | **decision — Dev-9**: host implementations keep the three runtimes uniform |
| In-app updates / browser gate | `configRequirements/read`, `[features] in_app_updates` | partial | read and applied at `codex-agent.ts:2205-2213`; **residue named in-tree at `:2192`** — the tier is module-scope and unpersisted, so `checkForUpdatesOnLaunch()` still runs ungated at boot in a codex-only fleet | residue gap, stated — P2.7 / P2.463. **The inventory says our updater has no managed gate at all; it does** |
| Worktree setup scripts | **do not exist** at this pin | n/a | the inventory's absence-with-controls stands (`worktree` 26 in the binary, 0 in the schema; controls `background_terminal` 18, `apply_patch` 166) | — |

---

# 4. Pi — the runtime with no contract of its own

**The question changes shape here, and pretending otherwise would produce a meaningless table.** Pi
ships no documented surface for the host to project into; Pi *is* host code. So the column reads
against **Claude's contract**, and *"does the host project it"* becomes *"does Pi's host and extension
path do what the Claude page says"*. Host thickness on this column is the design, not a violation
(owner 2026-08-29).

| feature | what Claude's contract specifies | Pi does it? | evidence (what runs) | if not |
| :-- | :-- | :-- | :-- | :-- |
| Hook event vocabulary | 31 `HOOK_EVENTS` | partial, **29 of 31** | `automations/types.ts:72-210` `AGENT_EVENT_CONTRACTS_V1` — 30 contracts, each with a real emitter (the five that score 0 on a name probe are ternaries and service unions: `pi-agent.ts:5218`, `pi-harness/child-session-service.ts:607`, `task-service.ts:73`, `worktree-lease-service.ts:421`/`:620`) | decision, both stated with author-facing text at `format-adapters.ts:116-145`: `Setup` (no launch mode), `TeammateIdle` (no agent teams) |
| Five hook handler kinds | `command \| prompt \| agent \| http \| mcp_tool` | **yes — and Pi is the only runtime with all five live** | `SessionManager.ts:15757-15764`: `provider === 'pi'` injects the four non-command runners plus `decisionMergePolicy:'strict'`; every other provider gets `allowDirectCommandRunner: true`. A missing runner **reports itself** (`reportMissingRunner`) | — |
| Skill / subagent frontmatter hooks | dispatch from a component's own frontmatter | yes | `base-agent.ts:4530 getComponentHookLayer`, combined for **every** provider at `SessionManager.ts:15823` | — P6.59 ✅ |
| Where hooks come from | `hooks` blocks in `settings.json` at every scope, live | partial | the live source is `hooks.json` (`automations/hooks-config.ts:7-8`) plus plugin manifests; `~/.claude/settings.json`'s block is read **once, as an import** (`capabilities/claude-setup-import.ts:426-446`) | decision (own store) — **the divergence is not surfaced** |
| Hook decision contract and budgets | four output patterns, per-kind timeouts | yes | `automations/hook-decision-contract.ts:40-100`; `hook-command.ts:186-198` = the documented 600 s / 30 s prompt / 60 s agent / 30 s `UserPromptSubmit`, with a `MAX_HOOK_TIMEOUT_MS` ceiling | — |
| Permission modes | six modes; `permission-modes.md#available-modes` | **yes, by identity** | `mode-types.ts:38`; Pi's gate takes the mode verbatim (`core/pre-tool-use.ts`) where claude and codex translate through tables. `explore` is the one declared Nessy extension (`mode-types.ts:19-25`) | — |
| Rule DSL, including the middle `ask` tier | `permissions.md#permission-rule-syntax` | yes | `pi-harness/permission-dsl.ts`; `ask` reaches `nonNegotiable:'askRule'` (`core/pre-tool-use.ts:2219`) and is honoured at `:1760`; overflow drops **allow** rules only | — |
| `deniedPaths` read-side floor | non-negotiable, any tool | **yes, natively** | `mode-manager.ts:2622-2628` → `denyPathBlocked` → a hard `block` at `pre-tool-use.ts:1787-1791`; a hook's `updatedInput` is re-gated at `pi-agent.ts:5610`. claude and codex need **mirrors** for the same floor | — |
| `PermissionUpdate` destinations | six entry types × the destinations | partial | all six types implemented (`pi-agent.ts:4601-4775`); `userSettings` and non-rule types at settings destinations are **refused with a receipt** (`:4500-4503`, `:4780`) | decision, stated as a privilege boundary — *"a write to a key nothing reads is a grant that silently does nothing"* |
| Claude `settings.json` keys honoured | the keys you wrote take effect | partial | Pi does read the file — `permissions-config.ts`, `skills/skill-overrides.ts`, `claude-settings-store.ts`, `agent/memory/instruction-excludes.ts`, none provider-gated | **gap, and counted**: ledger L1 — **29 ceilings/timeouts/budgets, 32 policy switches, 21 cosmetic, 78 residual flags unread on Pi, silently** |
| Bundled skills in a headless server | skills ship with the product | **no** | `ensureBundledSkills` has exactly one production call site, `apps/electron/src/main/index.ts:509`. Positive control: `packages/server/src/index.ts:238` runs `bootstrapServer`/`createStorageRuntime` and never calls it | **gap — P3.206 ⬜**, and it is all three runtimes, not Pi's alone |
| `--add-dir` contributing skills / commands / subagents | *"skills … Yes, with live reload; command files and subagents … Yes"* | **no — and worse than "rules and memory only"** | This cell said "rules and memory only", which credited Pi with a rule arm it does not have (P3.339, re-measured 2026-09-04). `native-sources.ts` does add `<root>/.claude/rules` and `<root>/.agents/rules` behind `additionalDirectoryRulesEnabled()` — but it iterates `context.additionalRuleDirectories`, and the ONE production producer of that context (`storage-runtime.ts toWorkspacePolicyContext`) never sets the field, so the loop is over an empty list in every shipped session and `NESSY_ADDITIONAL_DIRECTORIES_MEMORY` is an opt-in that cannot take effect. Positive control on the same function: `skillRecords`/`markdownAgentRecords` **are** called for the workspace root ten lines later. Since P3.339 the empty case emits one diagnostic instead of nothing | **gap** — P6.34 ✅ closed the **claude** half only. The three answers are three different ones: claude turns our `additionalDirectories` key into `--add-dir` at the child (so components DO load there, per `permissions.md`), codex references the setting in zero lines, Pi's arm has no producer |
| Skill `allowed-tools` pre-approval | tools pre-approved while the skill is active; `skills.md#configure-skills` | yes | parsed `skills/storage.ts:320`; enforced `capabilities/runtime-skill-content.ts:1539 collectSkillToolGrants` ← `base-agent.ts:4287` | — |
| Skill listing budget | a bounded initial listing | yes, **stricter than documented** | `core/prompt-builder.ts:108` `SKILL_LISTING_MAX_CHARS = 4_000` + a 180-char per-entry cap, with a truthful *"N more"* | number divergence under a Claude-shaped refusal string |
| Plugins and marketplaces | components install and run; `plugins/components.md#explore-the-plugin-directory` (was plugins § plugin-structure-overview) | yes | `capabilities/resolver.ts:1239-1594` mints `skill · mcp · agent · command · workflow` bindings; `storage-runtime.ts:1114`; marketplaces in `plugins/marketplace-registry-store.ts` | residual ledger gaps L12–L14 are three-runtime, not Pi's |
| Agent definitions | `.claude/agents/*.md` frontmatter; `sub-agents.md#configure-subagents` | yes, different directories | loader `agents/definitions.ts:1018`/`:1027`; the spawner honours `tools, model, systemPrompt, permissionMode, maxTurns, effort, skills, mcpServers, memory, background, isolation` (`orchestrator/spawner.ts:461-905`); the host re-validates the tool list. The tool is named **`subagent`**, not `Agent` | decision, recorded: *"`~/.claude/skills` and `.claude/agents` are not tiers this fork reads"* (`pi-harness/managed-policy.ts:387-388`) |
| Concurrent-subagent ceiling | a flat documented default of 20 | yes, **and it is a host invention** | `config/subagent-limits.ts:121` `max(2, floor(totalmem / 2 GiB))`, applied at `:159` as `min(20, ceiling-1)`; refusal at `spawner.ts:805`. On a 16 GiB box the effective default is **7** | deliberate deviation — a Pi subagent is a ~1 GiB subprocess, not another context window (P6.16 ✅ closed the claude half by proving the formula must **not** reach it) |
| `isolation: worktree` | subagent frontmatter → a git worktree | yes, **and observed** | `agents/definitions.ts:744` → `spawner.ts:868` → `SessionManager.ts:14224 acquirePiWorktreeLease` → real git at `:13565` / `worktree-lease-service.ts:378` | — P6.18 ✅. Note: `worktree-approval-floor.ts` **does not exist** — the floor is `pre-tool-use.ts promptIsNonNegotiable` + `worktree-layout.ts` |
| Background tasks | `run_in_background`, monitor, stop | yes | bash `local-tools/runtime-backed-tools.ts:363`; subagents default to background at `subagent-tool.ts:625-631`; registry `background-task-registry.ts:133`, stop `:885`, result `:927`. The parameter is spelled `background` | — |
| Agent teams | teammate lifecycle | by design not | `plugins/hook-events.ts:18`; `format-adapters.ts:117` emits a **machine-readable deferral** so an imported hook is not silently dead | decision — **Dev-1** |
| Workflows | the `workflows` plugin component; `workflows.md#how-a-workflow-runs` | **yes — Pi only** | recipes `pi-agent-server/src/index.ts:1817`, tool `orchestrator/workflow-tool.ts:508`, exec `:767`; gate `agent/runtime-agent-support.ts:233` = `pi:true, anthropic:false, codex-runtime:false` | — |
| Output styles | replace the system prompt; `output-styles.md#how-output-styles-work` | yes | `pi-agent.ts:9038-9080` → `prompts/system.ts:464-478`, per-turn reminder `core/prompt-builder.ts:292-294` | — |
| CLAUDE.md / AGENTS.md load semantics | four scopes, recursion, `@path` imports; `memory.md#claude-md-files` | yes | `capabilities/native-sources.ts:1502` (managed `:1560`, user `:1532`, project `:1728`, subdirectory `:1857-1875`), imports `:546`; delivery `pi-harness/context-resource.ts:39` | — |
| `AGENTS.override.md` | codex's per-directory supersession | yes | `capabilities/instruction-files.ts:67`, **first** in `PROJECT_INSTRUCTION_FILES` (`:73-78`; positive control — `AGENTS.md`/`CLAUDE.md` are entries 2–3); supersession at `:127` | — P6.35 ✅ |
| Auto-memory | memory that loads and can be turned off | yes, **structurally** | `memory/memory-store.ts:541` ← `prompts/system.ts:482`; per-subagent dir `memory/agent-memory.ts:61`; `mcp__session__remember` pinned upfront; off-switch `agent/options.ts:496`. It is `MEMORY.md` + Read/Write/Edit — there is no tool named `memory` | — |
| Reasoning effort from the environment | `CLAUDE_CODE_EFFORT_LEVEL`, `MAX_THINKING_TOKENS` | yes | `thinking-levels.ts:239 environmentThinkingOverride`, applied at `base-agent.ts:1234`/`:2974`/`:2997`; Pi forwards the effective level at `pi-agent.ts:9513` | — P6.30 ✅ |
| Effort / thinking vocabulary | levels reach the model | yes | `thinking-levels.ts:33` six levels, model clamp `:363`; Pi init `pi-agent-server/src/index.ts:2284`, live `:4901`, spawn `spawner.ts:496` | — |
| Context window for a gateway model | resolved, not invented | yes | `config/context-window-resolver.ts:72`, six tiers, called at `pi-agent.ts:8231`. **`131072` appears 0 times under `packages/*/src`**; the custom-endpoint fallback is `128_000`, matched to the Pi SDK's own default | — P3.79 ✅ |
| Auto-compaction off-switch | disable and stay disabled | yes | `config/auto-compaction-settings.ts:59-76` (every layer narrows) → `SessionManager.ts:5673` → `pi-agent.ts:2392` → `pi-agent-server/src/index.ts:917` | — |
| Compaction steering | a `Compact Instructions` section steers compaction | yes | `prompts/compaction.ts:134 extractCompactInstructionsSection` → auto `pi-agent-server/src/index.ts:3919`, manual `/compact` `:4673`; `mcp:`-provenance text dropped (`compaction.ts:192`) | — P6.54 ✅ |
| Compaction-thrash guard | not documented — ours | yes | `pi-agent-server/src/index.ts:981`/`:1011` — three refills turn auto-compaction off with `terminalReason:'auto_compaction_thrashing'` | — |
| Context accounting | usage reaches the host | yes | `pi-agent-server/src/context-usage.ts:64` → `context_usage_update` → `backend/pi/event-adapter.ts:377` → UI | — |
| Deferred tool loading / tool search | `agent-sdk/tool-search.md#how-tool-search-works` | **yes — Pi only** | `pi-agent-server/src/deferred-mcp-tools.ts:13`/`:219` (`mcp__tool_search`, `mcp__tool_load`), registered at `index.ts:1847`, gated `pi-harness/harness-manifest.ts:698`. Claude gets `ENABLE_TOOL_SEARCH=false` written **explicitly** (`agent/options.ts:487`) because the loopback proxy forwards no `tool_reference` | — |
| MCP resources and prompts reaching the model | both | partial | resources yes (`session-tools-core/tool-defs.ts:1217`, projected only when a source advertises the capability); **prompts: the one production call passes `mcpResources: []`** | by design not for prompts, stated at `SessionManager.ts:16621-16624` — they reach the model only user-invoked, as slash commands |
| MCP tool naming | `mcp__<server>__<tool>` | yes, conditionally | `mcp/mcp-pool.ts:691-696`; the tool segment is truncated over 64 chars and gets a `_2`/`_3` suffix on collision (`:1399`) | — |
| Built-in browser | agent drives the pane | yes, **not Pi-only** | `tool-defs.ts:1186`; Pi binding `pi-harness/harness-tool-descriptor.ts:380`; the same gate on claude at `session-scoped-tools.ts:337` | — |
| `PushNotification` | the model raises a desktop notification | **yes — Pi only** | `tool-defs.ts:1290` `visibility:'pi-only'`; the only `projection:'pi'` call site is `backend/pi/session-tool-defs.ts:38` (control: `browser_tool` survives both other projections) | decision — Claude Code ships its own, so projecting ours would double it (P6.52 ✅) |
| `BASH_MAX_OUTPUT_LENGTH` | an operator output ceiling | partial | read at `config/bash-output-limits.ts:98`/`:139` (30 000 default, 150 000 ceiling), applied `agent/local-tools/runtime.ts:334`; truncation applies to **failures only** — successes ride the file-plus-preview tier | decision, written down at `bash-output-limits.ts:272-295`. P2.367 ✅ — *"honoured nowhere"* is the pre-fix premise |
| Resume | rehydrate a prior session | yes | `pi-agent-server/src/index.ts:2420` `kind:'continue'` → `compat/pi-runtime-adapter.ts:440 continueRecent` — real subprocess state, not a replayed prompt | — |
| Fork | fork a session | **yes — Pi only** | branch `pi-agent.ts:2368` → `kind:'fork'` → `pi-runtime-adapter.ts:448`; in-session `/subtask` at `pi-agent.ts:8545`; gate `runtime-agent-support.ts:298` | — |
| Native history carry at a switch | ours | **yes, a real file rebuild** | `SessionManager.ts:19068` → `pi-session-rebuild.ts:261`/`:364` writes a **v3 Pi JSONL** at `.pi-carry/handoff.jsonl`, read back and verified at `:388`, **with no cap on this path**. The 24×1200 tail is the *text fallback* (`base-agent.ts:440`), armed only when the rebuild is not planned or fails | — |
| Attachments and images | images and documents as content | partial | images pass natively (`pi-agent.ts:9127-9134`); **PDFs and path-only images become text pointers** (`:9136-9145`) | gap — no document block |
| Structured output | a schema constrains the result | yes, **different channel** | compile `pi-agent-server/src/index.ts:3860`, validate `:4071`, bounded re-prompt `:4093`, terminal `error_max_structured_output_retries`. No `response_format` wire field, deliberately — gateway tool shapes are fragile (`structured-output-prompt.ts:10-15`) | — |
| Todos | `TodoWrite` / todo tracking | yes, renamed | `tool-defs.ts:1098`; the Pi projection swaps `TodoWrite`/`Task` for `TaskCreate/Update/Get/List` (`:1622-1623`), mirroring the vendor's own *"TodoWrite disabled by default as of v2.1.142"* | — |
| Checkpoints and rewind | rewind to a prior state | **yes — Pi is the only producer** | write `pi-agent-server/src/index.ts:2079`/`:2166`/`:2190`; revert `SessionManager.ts:19967`, conversation rewind `:20068`. Control table `sessions/file-checkpoints.ts:44` = `pi:true, anthropic:false, codex-runtime:false` | the rewind **menu** is partial — **P6.56 ⬜**: *Restore code* is a claude-only gap, and the SDK's `rewindFiles` has 0 call sites |
| Elicitation | an MCP server asks the user mid-call | yes, end to end | transport `mcp/client.ts:440`, routing `mcp-pool.ts:1054`, registration `base-agent.ts:2592`, dialog `pi-agent.ts:6660` on the permission-card channel, hooks `base-agent.ts:2782`/`:2790` | — |

**Pi's own counts: 46 rows — 36 yes · 7 partial · 2 no · 1 by design not.** The ten not-`yes` split
**4 gaps** (headless bundled skills · `--add-dir` components · non-image attachments · the unread
`settings.json` key subset), **4 decisions** (29 of 31 hook events · hooks from `hooks.json` ·
`PermissionUpdate`'s privilege boundary · the bash cap on failures only) and **2 by design not**
(agent teams · MCP prompts in the startup context). Two of the four gaps sit on rows verdicted
`partial` rather than `no` — the settings-key subset and non-image attachments — which is why the gap
count exceeds the `no` count.

**Where the host is thick for Pi, and why that is the design.** 25 services under
`packages/server-core/src/pi-harness/` and 33 modules under `packages/shared/src/agent/pi-harness/`
exist because Pi has no native mechanism: `permission-service`, `child-session-service`
(SubagentStart/Stop), `task-service` (TaskCreated/Completed), `worktree-lease-service`, `ask-user-service`,
`plan-mode-service`, `lsp-service`, `plugin-monitor-service`, `process-supervisor`, `goal-service`,
`mailbox-service`, `otlp-telemetry`. Above them sits the deterministic gate `core/pre-tool-use.ts` —
the same code claude calls **once** and codex reaches only through `findNonNegotiableFloors`. Claude
gets its equivalents from the SDK; codex from its own binary. **The seam is honest in one direction
and silent in the other:** the four hook runners are gated `provider === 'pi'` at
`SessionManager.ts:15757` and a missing runner **reports itself**, while the unread settings keys (L1)
and `--add-dir` (L4) degrade with no diagnostic at all.

**What Pi has that the other two do not**, from four machine-checked tables in
`agent/runtime-agent-support.ts`: workflows (`:233`), plugin peripherals — LSP servers and monitors,
via the Pi-only `agent.redirect(text)` primitive (`:163`) — and in-session conversation fork (`:298`),
all `pi:true, anthropic:false, codex-runtime:false`. Add all five hook handler kinds with strict
decision merging, the Guardian judge and the auto-mode classifier bands, deferred tool loading, file
checkpoints, `PushNotification`, MCP resources, and worktree entry tools. **Several of those are
correctly Pi-only rather than unclosed**: codex's `auto_review` and Claude's own `PushNotification`
are the native answers on those runtimes, which is native-first working as intended (**Dev-25** says
so explicitly for the classifier).

---

# 5. Where the 2026-08-28 inventory was wrong

The inventory is five days and 537 commits old and was an honest reading when written. Corrections
are grouped by **kind**, because the kinds need different responses: a *count* that moved needs
re-measuring, a *premise* that was refuted needs the row deleting rather than the number updating.

## 5.1 Counts that moved because the tree moved

| Inventory says | At HEAD | Where |
| :-- | :-- | :-- |
| codex config: *"94 top-level properties, and we write 17"* | **19** (20 with `[agents]`, 21 with `[hooks]`) | measured by executing `buildCodexConfigToml`; `[otel]`, `[analytics]`, `compact_prompt` all landed |
| *"`[otel]` … the only route to exported traces"*, listed among the switches we do not write | written, **unconditionally**, on every codex build | `config-writer.ts:2306-2326` |
| §3.9 `outputSchema`: *"**We pass none.**"* | **we pass it**, and validate host-side because the field is silently ignorable | `codex-agent.ts:4070`; P3.5 ✅ |
| §3.9 manage-app-updates: *"Our own Electron updater has **no managed gate at all**"* | it has one, with a **named residue** (unpersisted tier, launch check still ungated) | `codex-agent.ts:2205-2213`, residue at `:2192` |
| §1.5 hook handler kinds: claude *"one of five wired"* | **all five**, host-executed | `hooks-automation.ts:495-501`; P6.12 ✅ |
| §4 row 3, skill-frontmatter hooks: claude *"never dispatch"* | they dispatch | `hooks-automation.ts:577`; P6.59 ✅ |
| §4 row 1: codex fires *"4"* of *"11"* hook events | **9** | P6.11 ✅ |
| §4 row 5: codex *"receives no output style at all"* | it receives one, through `developerInstructions` | `codex-agent.ts:2240`; P6.36 ✅ |
| §4 row 39: audit export *"on / off / off"* | **on / on / on**, each with a coverage marker | P6.42, P2.423, P2.450 ✅ |
| §1.15: `CLAUDE_CODE_USE_GATEWAY` and `_ANTHROPIC_GOOGLE_CLOUD` *"stripped nowhere in the tree"* | **stripped**, in the SDK subprocess env and the host env, together with five siblings and four companions | `options.ts:315-317`, `llm-connections.ts:1244`; P3.112 / R40 |
| §4 row 8: Pi — compaction steering *"nothing reads it"* | it is read | `prompts/compaction.ts:134 extractCompactInstructionsSection`; P6.54 ✅ |
| §4 row 10: Pi — the thinking env vars *"read by nothing"* | read and applied | `thinking-levels.ts:239` ← `base-agent.ts:1234`/`:2974`/`:2997`; P6.30 ✅ |
| §4 row 12: Pi *"stamps a hand-typed 131 072"* | **`131072` appears 0 times under `packages/*/src`**; a six-tier resolver decides, with `128_000` as the custom-endpoint fallback matched to the Pi SDK's own default | `config/context-window-resolver.ts:72` ← `pi-agent.ts:8231`; P3.79 ✅ |
| §4 row 19: *"every `claude-*` target degrades to a 24×1200 text tail"* | the tail is the **fallback**, not the path: Pi's carry writes a real v3 Pi JSONL with **no cap**, and on claude only `missing`-window ids degrade | `pi-session-rebuild.ts:261`/`:364`; `runtime-switch.ts:485-491`; P6.10 ✅ |
| §4 row 37: the operator output cap *"honoured nowhere"* on Pi | honoured — on **failures** (30 000 default, 150 000 ceiling), with the success tier's divergence written down | `config/bash-output-limits.ts:98`/`:139`, applied `local-tools/runtime.ts:334`; P2.367 ✅ |
| §4 row 33: `AGENTS.override.md` — host collector *"blind to it"* | collected, and **first** in `PROJECT_INSTRUCTION_FILES` | `capabilities/instruction-files.ts:67`/`:73-78`; P6.35 ✅ |

**29 of the 40 switch rows moved in five days.** That is the number to carry: any file in this tree
that grades the runtime axis has a half-life of about a week.

## 5.2 Premises that were refuted — the feature did not move, the claim was wrong

These are the expensive ones, because a refutation and a delivery are indistinguishable in a tracker.

- **`features.tool_search` is not an unexercised native switch.** The inventory files it twice as
  configuration we simply never wrote. Both keys are **`Stage::Removed` at `rust-v0.148.0`**, skipped
  by `apply_map`, with zero readers in the codex tree; the real gate is unreachable from
  `config.toml`, and our gateway models make it false. Deliberately pinned out with a test
  (`config-writer-tool-search.test.ts`). Writing them would have produced an inert, unobservable key
  shaped like a control.
- **`sandbox_workspace_write.network_access`, *"the single most consequential unwritten key"*.** Still
  unwritten, but both native alternatives are now measured and refused in place, and an operator
  diagnostic names the state on every build. The framing — an unasked question — is stale.
- **codex's `[hooks]` table.** *"We write no `[hooks]` table"* is right on bytes and wrong on
  mechanism: the builder, the eleven keys, the trust half and a drift test exist, the projection
  returns `{}` under an owner ruling, and the session is told so.
- **§4 row 26, network from the agent's shell on codex.** *"Absent in every shipped configuration"* —
  the sandbox is off by default, so codex has network. Nothing was built; the premise inverted.
- **§4 row 30, managed requirements.** *"21 of 22 read, reported and discarded"* — **18 of 22 are
  enforced by codex itself**; four are real gaps; the wire type carries 25 fields, three of them
  `#[experimental]` and dropped by ts-rs.
- **§4 row 15, MCP resources and prompts on claude.** *"Never, and nothing says so"* — prompts and
  `@server:uri` mentions do reach claude; only the model-initiated pair is absent.
- **§4 row 14, the built-in browser on codex.** Not one missing list entry: two independent rules, no
  bridge route and a missing permission gate. Nothing shipped.
- **§4 row 34, the RAM-derived subagent ceiling.** It must **not** reach claude — the formula prices a
  Pi subprocess.
- **§4 row 36, `PushNotification` on claude.** Not absent; **unmeasured**. The runtime ships its own.
- **§4 row 22, permission-mode descriptions on codex.** Already true before the row.
- **§3.10 `model/list`.** Correctly reported as uncalled, but filed as a plain absence; it is a
  recorded refutation, which is a different verdict and a different follow-up.

## 5.3 Facts the inventory did not have

- `RawMcpServerConfig` has **27** fields, not 26.
- The driven-method enumeration omits `configRequirements/read` — a live method backing the managed
  floor — and says *"the five approval/elicitation server-requests"* where **six** are bridged and all
  **ten** `ServerRequest`s are answered.
- `optOutNotificationMethods` is set to none while **17 of 74** notifications are handled: 57
  notification families are parsed and dropped every session. The inventory notes the option; it does
  not draw the consequence.
- Line anchors in §1.1–§1.2 have drifted (`Options.resume` :1803 not :1799; `Options.skills` :1986 not
  :1955; `sessionStore` :1598 not :1825) — written against 0.3.218 typings while the tree pins 0.3.223.
  The **content** of every row checked still holds, which is the case for quoting sentences over
  numbers.
- **The host has an event vocabulary of its own and the inventory never names it.** Coverage is framed
  as *"31 `HOOK_EVENTS`, and what do we do about them"*, while `AGENT_EVENT_CONTRACTS_V1`
  (`packages/shared/src/automations/types.ts:72`) declares **30 contracts** — Claude's 31 minus `Setup`
  and `TeammateIdle`, **plus our own `McpResult`** — with the handler kinds `command | http | mcp |
  prompt | agent` and two declared subsets. That list, not the SDK's, is what all three runtimes are
  graded against inside this product.
- **Tool-name shadowing is a live question the inventory's tool section does not ask.** **14 of our 56
  session tools share a name with an SDK built-in, 7 of them projected onto claude**
  (`claude-agent.ts:620-688`, P2.512). Two are subtracted, two families are removed by env, one is
  deliberately conceded to the SDK — and the reasoning is per tool, which is the right shape and is
  invisible from a feature inventory.
- **`ensureBundledSkills` has exactly one production call site** (`apps/electron/src/main/index.ts:509`),
  so the headless server ships zero bundled skills on every runtime. Positive control:
  `packages/server/src/index.ts:238` runs the bootstrap and storage runtime and never calls it.

## 5.4 A stale in-tree claim found while verifying, filed here because it is outside this lane's zone

`packages/codex-responses-adapter/src/config-writer.ts:929` states that `case 'warning'` and
`case 'configWarning'` both score **0** across the codex event adapter and the app-server client. At
HEAD **both are consumed** — `app-server-client.ts:219` and `:230`, `codex-agent.ts:2366`. The P2.384
argument that rests on it (*"flipping `request_permissions_tool` would drop the only notice that says
so"*) no longer holds **on that ground**; the decision may still be right for its other reasons.

## 5.5 Other stale artefacts found while verifying, filed rather than edited

Each is outside this lane's zone; each was found by following a pointer to code that had moved.

- **The capability ledger's Pi column is stale in at least four cells** the code has since moved past:
  `E3` compaction steering, `L10` skill listing budget, `K1` effort-from-environment, `L5`
  `AGENTS.override.md`. (A concurrent lane is refreshing that file; these are named for it, not
  applied here.)
- **Four closed parity rows still read as open findings in their own prose, with stale path
  pointers** — `P6.30`, `P6.35`, `P6.54`, `P3.79`. `P6.35` additionally asserts a three-element
  `PROJECT_INSTRUCTION_FILES` which now has four entries, led by `AGENTS.override.md`. A ✅ row whose
  note describes the pre-fix world sends the next reader to the wrong place, which is the same failure
  mode as a wrong glyph and harder to see.
- **`packages/shared/src/agent/pi-harness/worktree-approval-floor.ts` does not exist** — only a
  composition *test* of that name. Any citation of the module needs re-pointing at
  `pre-tool-use.ts promptIsNonNegotiable` + `worktree-layout.ts`.
- **A docblock at `packages/shared/src/agent/__tests__/claude-operator-ceiling-env.test.ts:20-41`
  asserts Pi honours none of the three operator env vars.** False at HEAD for two of them — and the
  suite is green because its executable assertions test something else, which is the
  documented-claim-versus-assertion split this repo has already paid for twice.

---

# Appendix A — what the boundary puts outside, and why

The inventory's `not-agent-loop` rows are not tabled above. Each line names the criterion it fails,
because *"not the agent loop"* is not a reason by itself. The boundary rule is the inventory's and the
scope document's: a feature is `agent-loop` when it changes **what the model is told, what the model
may do, or what a tool call passes through** — or when it differs across the three at a switch.

| Area | Examples | Why out |
| :-- | :-- | :-- |
| Session naming and deletion | `renameSession`, `tagSession`, `deleteSession`, codex `thread/list`/archive/search (**Dev-8**) | records, not the loop; the host store owns them |
| Alternative transports | SDK browser transport (`browser-sdk.d.ts`), the remote bridge (`bridge.d.ts`), `Query.readFile()` | how the host reaches the runtime, not what the runtime may do |
| Presentation | `toolConfig` render config, statusline, keybindings, terminal config, fullscreen, accessibility, voice dictation, notification timing, spinner verbs, footer links | fails all three criteria and does not differ meaningfully at a switch |
| IDE / desktop / web / mobile / CI surfaces | 24 corpus pages, 22 already out of product | not runtimes and not the loop |
| Compliance posture | `data-usage`, `legal-and-compliance`, `zero-data-retention` | real obligations; not a thing the model is told, may do, or a call passes through |
| Cost and usage reporting that gates nothing | rate-limit windows, per-model attribution, `[analytics]`, the behaviour scan | out **unless** the export is a permission verdict or the number stops a turn — and both exceptions are live, so `ORG_POLICY_LIMIT_PREFIXES` and the audit stream stay **in** |
| Our own instruments | build gates, lint configs, typecheck coverage, the test mutex, worktree rigs, doc-anchor conversion, register regeneration | necessary work; not this axis's subject |
| Provider sign-in and subscription | `AccountInfo.apiProvider` (8 values), `forceLoginMethod`, codex `account/login/*`, `forced_login_method`, `cli_auth_credentials_store` | **gated, not out**: built and hidden behind `NESSY_FEATURE_PROVIDER_CLAUDE` / `PROVIDER_CHATGPT`, both default off while the two runtime flags default on. Filing them as out invites deleting code the owner intends to re-open |
| Corporate launcher | `corporate-launcher.md`, ledger `C4`, `P6.9` | **in** by criterion 3 and **deferred-last by owner ruling**. Three live unwrapped spawn sites, absent on all three runtimes, switch verdict `UNIFORM`. It must not be recorded as refuted or as done |

# Appendix B — the fourth runtime

The product ships **four** `ModelProvider` values — `pi`, `anthropic`, `codex-runtime`,
**`nestor-cloud-agent`** (`packages/shared/src/config/models.ts:78`, re-read at HEAD). The owner's
goal names three, and this file has three tables. `nestor-cloud-agent` has **no external corpus at
all**: nothing enumerates what it should offer, so no sweep can grade it and no denominator exists.
It is recorded here as an explicit null rather than silently dropped — a three-column answer to a
four-runtime product is a known incompleteness, not an oversight.
