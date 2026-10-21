# Inert-contract list — nessy-desktop (§2 and §5 CLOSED; §3, §4 and the addendum are live)

> **THE HEADER BELOW SAID "LIVE" AND WAS WRONG BY 2026-07-30. Corrected here.**
>
> - **§2 (live defects) and §5 (suggested units) are CLOSED.** All five units
>   ran. Verified in code, not from the plans: U-A — `PermissionRequest.tsx`'s
>   `{request.impact && (` block renders `{request.impact}`, the file §2 says "has zero `impact` references".
>   U-B — `automations/utils.ts:189` returns `input.notification_type ?? ''`,
>   with a `STOP_FAILURE_DOCUMENTED_ERROR` map and a `changedFileBasename`
>   helper, against the claim that nine events "all hit `default: return ''`".
>   U-C — `format-adapters/claude.ts:1202` reads `readExternalHookTimeoutMs`.
>   U-D — `knownToolNames: PERMISSION_RULE_TOOL_NAMES` is passed at
>   `pi-agent.ts:2986`, `permissions-config.ts:529` and `managed-policy.ts:977`.
> - **THE U-D LINE ABOVE CLOSED A FOUR-CLAUSE UNIT ON ONE CLAUSE, and this is
>   recorded rather than rewritten (P2.305, 2026-09-03).** `knownToolNames` was
>   one of U-D's four; when the header was written, `sourceRoot`, the
>   `warning`-reachability clause and `unparseableRule` were all still open. All
>   three have since landed, so the verdict is now true — but it was not true
>   when it was asserted, and the reason it went unnoticed is the shape this
>   whole file is about: **a unit-level claim verified by one of its clauses
>   reads exactly like one verified by all of them.** The three that followed:
>   `unparseableRule` as an author diagnostic, `0d0f4da00` (P2.277, recorded by
>   P2.289); `sourceRoot` supplied from the plugin's own root, `8826cfef0`; and
>   the `warning` reachability, `7987d4c63` + `f61778b75` — `parsed.warning` is
>   now read BESIDE a rule, not only when `!parsed.rule`, at
>   `managed-policy.ts:1613` (an unknown tool refuses the managed rule),
>   `permissions-config.ts:652` and `pi-agent.ts:4711`. **Verify a unit clause by
>   clause, and name which clause the evidence covers.**
> - **§3 (nine dated owner decisions) and §4 (the sweep's false positives, and
>   the four shapes it kept missing) are the durable part.** §4's four shapes
>   have been copied into `AGENTS.md`'s traps section so they survive this file;
>   §3 stays here because it is the only index of the nine.
> - **The addendum at the bottom is STILL LIVE and is why this file is not
>   deleted.** The parity tracker at `:230` names this file as where that bound
>   "stays recorded". Its line numbers have drifted: `storage-runtime.ts:576` is
>   now `:697` and `:637` is now `:775`; both gates still read
>   `isPiCapabilityTurn = context.provider === 'pi'` (`:646`).

> **This is the list to work from. The raw sweep
> (`2026-07-29-inert-contracts.md`) is not.** Re-verification against current HEAD
> found **34% of its rows would have produced a wrong change**, and two of those
> would have been damaging:
>
> - "call `isManagedModelAllowed` at the model-selection site" is precisely the
>   path Unit 4 rejected, because it round-trips through `updateLlmConnection`
>   and **permanently destroys a user's model list**.
> - "delete `plugins/hooks-runtime.ts`" **breaks the build** — three production
>   files import its `PluginHookEventName` type.
>
> Nine rows are dated **owner decisions**, not defects. One had a consumer the
> sweep missed. One was mis-bundled and is not inert at all. Five more survived
> with their stated consequence refuted or overstated.
>
> Two re-verifications in this series have now each found a third of a raw
> finding list unactionable. **Nothing goes to an executor from a sweep without
> this pass.**
>
> **One row is already closed and this list predates the closure**: `SendUserFile`
> was half-fixed by `a98b656e` (the result text) and finished by `cf74b760` (the
> tool description, which still promised delivery — the model reads that before
> deciding to call the tool, so fixing only the result was fixing the wrong half
> first).


## 1. What the re-verification changed

32 submitted rows collapse to **29 distinct identifiers** (three were submitted twice: `ClaudeHookIfCall.sourceRoot`, `ClaudeHookIfResult.unparseableRule`, `PiPendingApprovalV1.requestedAt`). Of those 29: **19 are live inert defects**, **9 are dated owner decisions**, **1 had a consumer the sweep missed** (`getMacosSeatbeltBashSandboxEnabled` is called at `claude-agent.ts:1296` and `pi-agent.ts:3584` — only the *setter* is dead), and **1 was half-fixed since the sweep** (`SendUserFile`: commit `a98b656e` replaced the false-delivery result text on 2026-07-29; the tool *description* at `tool-defs.ts:628` still promises delivery). A tenth identifier, `MANAGED_DELIVERY_SOURCE`, was mis-bundled into a row and is not inert at all — it is read as the default argument of `salvageDeliveredPayload` (`managed-delivery.ts:199`). **No — the original report could not have been acted on as written.** 10 of 29 rows (34%) would have produced a wrong change, and two of them would have produced a *damaging* one: the "just call `isManagedModelAllowed` at the selection site" fix is precisely the path the owner rejected because it round-trips through `updateLlmConnection` and permanently destroys a user's model list (`2026-07-29-deviation-unit-4.md:217-227`), and "delete `plugins/hooks-runtime.ts`" breaks the build because three production files import its `PluginHookEventName` type. Beyond that, five rows that *did* survive had their stated consequence refuted or overstated (channel-policy, `awaitingApproval`, `policyMatch` "persisted", `args` "one chokepoint" — it is two, `SEATBELT` framed as a defect rather than a scheduled GA flip).

## 2. Live defects, ranked by consequence

### security-or-permission (5)

- **`PromptInfo.impact` on `promptType:'bash'`** (`packages/shared/src/agent/core/pre-tool-use.ts:1511`, written `:1880`) — the string "Runs outside the sandbox: matched the administrator's excludedCommands pattern …" travels the wire (`:1483`), is emitted (`claude-agent.ts:1511`, `pi-agent.ts:4386`) and persisted (`SessionManager.ts:5688`), but `ChatDisplay.tsx:1717-1729` reads `impact` only under `type === 'admin_approval'`; `PermissionRequest.tsx` renders toolName/description/command and has zero `impact` references. Human approves a sandbox-escaping command with no indication it escapes. **small**
- **`PiPendingApprovalV1.requestedAt`** (`packages/shared/src/sessions/types.ts:173`) — one write (`SessionManager.ts:5696`), zero reads repo-wide; `reprojectPendingApproval` (`:5721-5751`) forwards `approvalTtlSeconds` while comparing nothing, and no TTL arithmetic exists outside the in-memory broker (`privileged-execution-broker.ts:51,63`), which is lost on restart. A week-old persisted prompt is re-presented as live and settled — except `admin_approval`, excluded at `:5794/:5807` by a dated, honoured decision. **small**
- **`ParseClaudeRuleOptions.knownToolNames`** (`packages/shared/src/agent/pi-harness/claude-permission-rules.ts:41`) — every one of the six production call sites passes two args (`pi-agent.ts:2850`, `permissions-config.ts:492`, `managed-policy.ts:614`, `prerequisite-manager.ts:316`, `hooks-automation.ts:638`, `claude-permission-rules.ts:241`); only tests pass three. And no reader exists even if supplied: the unknown-tool branch (`:188-198`) attaches `warning` *alongside* a rule, while both `warning` consumers gate on `!parsed.rule`. Probe: `parseClaudeRuleString('StopTask','deny')` installs an enforced rule matching no tool, warning or not. **medium**
- **`SkillMetadata.disallowedTools`** (skill `disallowed-tools`) — parsed at `skills/storage.ts:237,247`, but the only enforcement reader of skill frontmatter, `materializeRuntimeSkillInvocation` (`capabilities/runtime-skill-content.ts:763-765`), reads `tools ?? allowed-tools` and freezes `{tools, model, agent, effort}` only; `applySkillInvocationGrant` (`base-agent.ts:2189-2211`) only narrows — there is no subtraction path anywhere. Both sibling projections drop it (`plugins/format-adapters/shared.ts:206-213`, `capabilities/native-sources.ts:290-305`), while `session-tools-core/src/validation.ts:329-337` hard-errors on its syntax. Near-miss: the identically-named *subagent* field is enforced (`spawner.ts:201`). **medium**
- **`getMatchValueForSdkInput` — 9 matcher-bearing events return `''`** (`packages/shared/src/automations/utils.ts:116-147`) — PermissionDenied, Setup, SessionEnd, PreCompact, PostCompact, ConfigChange, StopFailure, UserPromptExpansion, FileChanged all hit `default: return ''`, though `hooks.md:223-243` specifies a matcher vocabulary for each. `matchValue` flows to `matchesBasePredicate` (`utils.ts:181-195`) via `matcherMatchesSdk` and `pluginMatcherMatches` (`hooks-automation.ts:275-285`), so a `claude`-mode matcher exact-compares against `''` and never fires; the Claude-SDK path re-enters the same check (`hooks-automation.ts:1147-1183`), so it is not an escape. Worst sub-case: PermissionDenied carries `tool_name` from both emitters (`pi-agent.ts:4162-4166`, `permission-service.ts:71-76`) and its hook can set `decision.retry` — fully wired, silently unreachable. No import-time diagnostic warns. **large**

### user-visible (6)

- **`ManagedDeliveryStateV1.fatalError`** (`packages/shared/src/config/managed-delivery.ts:321`) — one write at `:442` (unsalvageable payload), reads only at `__tests__/managed-delivery.test.ts:116,131`; no listener inspects it (`getDeliveredManagedPolicy` reads `.policy/.source`, `isManagedDeliveryConfirmed` reads `.confirmed`). The cache-preservation behaviour is implemented; only the reporting half is missing. **small**
- **Imported hook timeout read as `entry.timeoutMs`** (`format-adapters/claude.ts:903`, `codex.ts:1334`) — `hooks.md:339` names the field `timeout`, in seconds; Codex's own spelling is `timeoutSec` (`packages/codex-protocol/generated/v2/HookMetadata.ts`). The same `claude.ts` reads the correct key 316 lines earlier for MCP (`:587`). Result: every imported hook silently gets the 30s default capped at 120s (`hook-command.ts:410`), and a PreToolUse timeout sets `success:false` → block (`:485-488`, `:369-380`). The line has never been touched since its initial commit, so the parity audit's **DONE** claim never landed for hooks. **small**
- **`DOCUMENTED_SKILL_FIELDS` entries `context`, `background`, `hooks`, `shell`** (`packages/session-tools-core/src/validation.ts:212-222`) — the list's only reader is `:315`, whose only effect is to suppress the "Unknown frontmatter field … it will be ignored" warning. None of the four is read on any skill path; the single `frontmatter.background` read is the *subagent* parser (`runtime-agent-definition.ts:418`), which never sees a SKILL.md. Their neighbour `agent` is enforced, which is why they look supported. **small**
- **`ClaudeHookIfCall.sourceRoot`** (`claude-permission-rules.ts:203-209`) — ~~consumed at `:259` inside the module, never supplied: the sole caller `hookIfFilterRuns` (`hooks-automation.ts:1023-1035`) builds `{toolName, toolInput, cwd}` and reads `.run`. Probe: `Read(/src/**)` against a deliberately non-matching path → `{run:true, unparseableRule:true}`; with `sourceRoot` → `run:false`. Every source-anchored `if` filter runs the hook on every tool call across the five TOOL_HOOK_EVENTS, and the registration diagnostic (`hooks-automation.ts:638`) stays silent because the rule *parses*. **small** to supply; *which* root a plugin hook's `if` anchors to is an owner call.~~
  **DONE — struck 2026-09-03 (P2.305). FALSE at HEAD.** `8826cfef0` supplied it: `capabilities/runtime-automations.ts` sets `ifSourceRoot` from `hook.pluginRuntime.rootPath`, and `plugins/hooks-automation.ts` spreads it into the call as `sourceRoot`. The owner answer the entry was waiting on came with it — a source-anchored rule anchors to the plugin's own installed bundle (owner decision 2026-07-29) — and `automations/schemas.ts` now declares `ifSourceRoot: z.never(…)` so an author cannot write it. A sweep acting on this entry today would delete a live scoping path.
- **Notification matcher reads `input.message`** (`automations/utils.ts:131-132`) — `hooks.md:229`/`:1986` specify `notification_type` with a fixed vocabulary (`permission_prompt`, `idle_prompt`, …). `rg notification_type` over the repo returns one hit: the report itself. The only emitter carries title+message (`pi-agent.ts:6756-6762`), and the frozen contract row (`automations/types.ts:53`) lists `['title','message']`. So a `permission_prompt` matcher never fires, and a native regex matcher substring-hits unrelated notifications. **medium** (needs the emitter field too)
- **`PluginHookDescriptor.args`** (`plugins/types.ts:169`) — ~~written by both adapters (`claude.ts:902`, `codex.ts:1333`) and dropped at *two* independent chokepoints: `projectHook` (`projection.ts:385-411`) copies 16 fields but not `args` — while copying args for MCP `:372`, command `:429`, LSP `:453` — and `RuntimeHookRegistration` (`resolver.ts:272-303`, `:897-933`) has no `args` member either. Terminal consumer is always shell form (`hook-command.ts:439-444`), so the documented `{"command":"node","args":["…/eslint.js"]}` degrades to `sh -c "node"`. The trust hash also omits it (`hooks-automation.ts:676-695`). The parity audit records this as **DONE** (`2026-07-25-nessy-claude-parity-audit.md:1335`). **medium**~~
  **DONE — struck 2026-09-03 (P2.305). FALSE at HEAD, and this is U-C landed.** `943bacbd1` ("an exec-form hook spawns its argument vector, and the vector is trusted"): `RuntimeHookRegistration` declares `args?: string[]`, the resolver forwards it, and `automations/hook-command.ts` selects the exec form on its PRESENCE — `spawn(execForm.command, execForm.args, …)`, no shell, `args: []` still exec — while `commandHookDedupKey` JSON-encodes `[command, ...args]` so the trust key covers the vector. The parity audit's DONE claim this entry contradicted is now true.

### model-visible (1)

- **`SendUserFile`** — half fixed. The tool stays registered and model-reachable (`tool-defs.ts:1058`) and returns `structuredContent {files, display, caption}` (`send-user-file.ts:177-186`), which nothing outside the Pi tool wrapper reads (zero hits in `apps/electron/src`, `packages/ui/src`, `apps/webui`, `apps/viewer`, `packages/server-core/src`). The fix touched the result text, not the description: `tool-defs.ts:628` still says files "reach them instead of only being named in the transcript", and `runtime-agent-definitions.ts:79` still calls it the tool that "delivers file content" — so the model now reads a description that promises delivery and a result that denies it. **medium**

### cosmetic (7)

- ~~**`ClaudeHookIfResult.unparseableRule`** (`claude-permission-rules.ts:211-216`) — seven writes (`:242,:245,:247,:249,:250,:271,:272`), zero reads including tests; the one caller ends in `.run`. Introduced with its own ignoring caller in `147dbfa2`. The case it exists to distinguish is exactly the `sourceRoot` fail-open above. **small**~~ **DONE — struck 2026-08-28 (P2.289); this entry is FALSE at HEAD and was the dangerous kind of false.** P2.277 (`0d0f4da00`) supplied the reader: the dispatch loop in `hooks-automation.ts` keeps `ifFilter.unparseableRule` and `reportUnparseableIfRule` puts it on the `hookErrors` channel as an operator-visible notice quoting the offending rule, deduplicated per matcher. Both routes the entry anticipated are covered — a rule that will not parse, and the `sourceRoot`/`invalid-policy` fail-open it names above. A sweep acting on this entry today would delete a live diagnostic.
- **`isManagedChannelServerAllowed`** (`managed-policy.ts:1047`) — callers only at `managed-policy.test.ts:564-566`; the live path is `SessionManager.ts:2283 → pool.setChannelPolicy → mcp-pool.ts:660`, which checks `enabled` + `allowedSources` only. Consequence corrected: a denied server is already stripped upstream at `storage-runtime.ts:577-580,:639`, so it can never arm a channel. Residual (distinct, not in the row): `storage-runtime.ts:576 if (!isPiCapabilityTurn) return true` skips the whole managed MCP filter on non-Pi turns. **small**
- **`ManagedDeliveryStateV1.awaitingApproval` (+ `mode:'interactive-unavailable'`, `outcome:'deferred'`)** — one write (`managed-delivery.ts:363`, tamper branch), zero production reads; the mode arm has no producer (`main/index.ts:1108` hard-codes interactive/non-interactive, `headless-start.ts:156` non-interactive), making `managed-approval.ts:249-252` unreachable. Consequence refuted: hold-back works without reading the field (`source:'none'`), and hourly polling re-runs the gate in both hosts (`main/index.ts:1128`, `headless-start.ts:167`). Dead diagnostic field + dead enum arm. **small**
- **`ManagedPolicyCompositionV1.winner` / `ManagedPolicyWinnerV1`** (`config/managed-composition.ts:112-118`, computed `:176-180`) — the sole production caller reads `.policy` only (`storage-runtime.ts:252-253`); every `.winner` read is a test assertion. Its own docblock scopes it as "for diagnostics, never a gate", and the surface that would show it does not exist (`/doctor` is separately recorded as unimplemented, owned by R30b). **small**
- **`PiPermissionReceiptV1.policyMatch`** (`pi-harness/permission-receipt.ts:35`) — ~~14 production writes (`pi-agent.ts:3948…:4102`, `SessionManager.ts:3766…:9913`) plus the forward at `permission-service.ts:103`; the only "read" is re-validation (`:164-176`, re-emitted `:206`). All three receipt consumers skip it (`pi-agent.ts:4159-4224`, `:4841-4847`, `pi-agent-server/src/index.ts:1646-1652`), and telemetry deliberately strips it. Correction: nothing persists it — computed, validated, discarded. **medium**~~
  **MOOT — struck 2026-09-03 (P2.305). The identifier no longer exists.** `3a57a7093` ("drop policyMatch from the Pi permission receipt") deleted it; `grep -a policyMatch` over `packages`, `apps` and `scripts` returns **zero** hits at HEAD. U-E's `delete-or-finish` on this one went the delete way. Kept rather than removed because an unrecorded deletion reads exactly like an unfixed defect to the next reader.
- **`PluginHookDescriptor.statusMessage`** (`plugins/types.ts:171`) — ~~four writers (`claude.ts:904`, `codex.ts:1335`, `format-adapters.ts:1255`, `schema.ts:620`) survive projection (`projection.ts:397`) and die at the resolver: absent from `RuntimeHookRegistration` (`resolver.ts:272-303`, `:897-933`) and never read by `runtime-automations.ts:165-210`. Remaining repo hits are unrelated same-name symbols; the renderer's `ProcessingIndicator` is fed `session.currentStatus?.message`, never a hook. Siblings `once` and `asyncRewake` emit ignore-diagnostics (`hooks-automation.ts:616,:664`); this does not. **medium**~~
  **DONE — struck 2026-09-03 (P2.305). FALSE at HEAD, the other half of U-C.** `906638da3` ("a hook's statusMessage reaches the spinner it was written for"): `RuntimeHookRegistration` declares `statusMessage?: string` and the resolver forwards it, `capabilities/runtime-automations.ts` carries it as `statusFields`, and `plugins/hooks-automation.ts` collects it across all five action kinds and calls `options.statusReporter?.(statusMessage)`. The "no signal at all" contrast with `once` and `asyncRewake` is gone — it is not ignored any more.
- **`PiMailboxMessageV1.fromAgentId` + `MailboxService`** — `MailboxService` *is* constructed in production (`SessionManager.ts:9649-9656`) with a real persist closure, but `piMailboxServices` is only set/deleted/cleared; `.send()`/`.list()` (`mailbox-service.ts:15,33`) have no non-test caller, and construction passes no `profile`, so `send()` would throw `peer-messaging-disabled` immediately. The persisted chain is dead end-to-end: `mailboxState` (`sessions/types.ts:48`) → `mailbox.messageCount` permanently 0 (`SessionManager.ts:2884`) → `PiHarnessMailboxSummaryV1` read by no renderer. Live inter-session messaging is the unrelated `send_agent_message`. Delete-or-finish. **medium**

## 3. Owner decisions — do not fix

1. **`SEATBELT_TESTING_WILDCARD`** (`bash-seatbelt.ts:63`) — `bash-seatbelt.ts:54-62`: "TEMPORARY (owner decision 2026-07-21): while the app is in the testing period, the seatbelt profile is a wildcard … Flip back to `false` before GA to restore real write containment; the containment tests key off this constant and re-arm automatically." The test file is the designed re-arm (`bash-seatbelt.test.ts:24-25`).
2. **`availableModels` / `enforceAvailableModels` (+ `isManagedModelAllowed`, `resolveManagedDefaultModel`)** — `2026-07-29-deviation-unit-4.md:217-227`: "documented, not implemented … filtering there would round-trip through `updateLlmConnection` — which rebuilds connections from a hardcoded allowlist — and permanently destroy a user's model list. Cost: 1 medium slice: filter at the read boundary … NOT at the persistence boundary." Restated in `2026-07-29-delivered-policy-enforcement.md:319-323`.
3. **`autoMode.classifyAllShell` / `resolveAutoModeClassifyAllShell`** — in shipped source, `managed-policy.ts:240-252`: "it is a BAND control … It is parsed and carried; the band that would honour it does not exist yet … strictly better than the previous behaviour, which REFUSED the key and took the admin's valid `allow` prose down with it." Also `2026-07-26-auto-mode-policy.md:450` and `deviation-unit-4.md:193-205`.
4. **`ManagedDeliveryStateV1.drops`** — `2026-07-29-delivered-policy-enforcement.md:332-338`: "Deliberately not folded into this unit: the desktop shell builds the storage runtime before delivery is initialised, so reading the session's drops there would report them in the headless host and silently not in the desktop one — worse than reporting neither." (`MANAGED_DELIVERY_SOURCE` was wrongly bundled here — see §4.)
5. **`plugins/hooks-runtime.ts` — `PluginHookRuntime` / `runHooks` / `parseHookOutput` / `createHookRegistryFromProjection`** — `2026-07-25-plugin-import-contract.md:71-74`: "**Do not revive `hooks-runtime.ts`.** It contains a second, unreachable hook executor whose `PluginHookOutputDecision` vocabulary does not match the live `PreToolUseDecision`. Fixing the dead path and believing the bug closed is the specific trap here." If it is ever removed, `PluginHookEventName` must move first — three production files import it.
6. **`SdkMcpServerConfig.required`** — `agent/backend/types.ts:662-663` and `:688-689`: "Imported upstream criticality metadata; connection failure remains capability-local," echoed at `plugins/types.ts:156-157` ("Upstream startup criticality metadata; Nessy keeps per-capability fail-soft semantics"). If the owner wants honesty rather than implementation, stop carrying it into the pool config — do not add a session-refusal path.
7. **`SessionMirrorStore.delete`** — `2026-07-28-session-mirror-store.md:25`: "**Retention is the adapter's own** … the host never deletes from a mirror on its sweep," carried in shipped code at `mirror/directory.ts:16-17` and `mirror/types.ts:60-68` ("without `delete`, deletion is a no-op ('which suits append-only backends')").
8. **`MirrorSessionKey.subpath` + `SessionMirrorStore.listSubkeys`** — `2026-07-28-session-mirror-store.md`, Task 4: "subagent-transcript restore via `listSubkeys` is contract-ready in the adapters but has no host producer yet — the queue mirrors only the main session JSONL today … (exactly the documented consequence of the missing half)."
9. **`SessionMirrorStore.listSessionSummaries` / `listSessions` + the `foldSessionSummary` sidecar** — same plan, `:7`: "the interface shape is portability guidance, not a compatibility surface," and the CDP-pass-10 note: "Decision: **restore at list time** … Chosen over synthesizing list entries from mirror summaries (two seams, phantom risk)." The fold runs only when `sessionMirror` is configured, so it is not an unconditional per-flush cost.

## 4. The sweep's false positives

- **`macosSeatbeltBashSandboxEnabled` / `getMacosSeatbeltBashSandboxEnabled`** (`config/storage.ts:990`) — consumers: `claude-agent.ts:20` + `:1296` and `pi-agent.ts:219` + `:3584`, reaching `applyBashSeatbeltSandbox` via `pre-tool-use.ts:1333-1336`. Schema-declared (`storage.ts:82`), validated (`validators.ts:112/158/199`), defaulted (`config-defaults.json:16`). Only the **setter** `setMacosSeatbeltBashSandboxEnabled` (`storage.ts:999`) has zero callers — the pref is file-editable only.
- **`MANAGED_DELIVERY_SOURCE`** (`managed-delivery.ts:187`) — read in production as the default argument of `salvageDeliveredPayload(document, source = MANAGED_DELIVERY_SOURCE)` (`:199`), the exact call shape `applyDeliveredDocument` uses at `:426`. Not inert; it just never surfaces because the drops it stamps are unreported.
- **`SendUserFile`'s false-delivery result text** — already fixed by `a98b656e` (2026-07-29); the quoted sentence no longer exists. A staleness false positive, not a shape one.

**Shapes the sweep kept missing — check these four before filing next time:**
1. **Getter/setter pairs.** Grepping the config key name lands on the dead setter and hides the live getter.
2. **Default-parameter reads** (`fn(x, source = CONST)`). A `const` used only as a default value looks like a declaration to a call-site grep.
3. **Enforcement one layer up.** `isManagedChannelServerAllowed` really is unwired, but `storage-runtime.ts:577-580` already strips the record, so the *consequence* was false. Verify the consequence separately from the identifier.
4. **Identically-named symbols in a sibling subsystem.** `disallowed-tools` is enforced for subagents (`spawner.ts:201`) and not for skills; `statusMessage` and `required` each collide with unrelated live symbols. Name the subsystem in the identifier.

Also: the sweep reported *identifiers* but wrote *consequences* it had not tested. Five surviving rows needed their consequence rewritten (channel policy, `awaitingApproval` "no prompt, permanently", `policyMatch` "persisted", `args` "one chokepoint" — there are two, `requestedAt`'s admin_approval carve-out).

## 5. Suggested units

- **U-A — Permission-prompt truth (goes first).** Render `impact` in `PermissionRequest.tsx` for non-`admin_approval` prompts, and make `requestedAt`/`approvalTtlSeconds` actually gate reprojection in `SessionManager.ts:5721-5751`. *Why first:* two small edits in one surface, both security-or-permission, both currently mislead the human at the moment of approval, and neither touches a cross-package contract — highest consequence per unit of risk.
- **U-B — Hook matcher contract.** Fill the 9 documented-matcher arms in `getMatchValueForSdkInput` and switch Notification to `notification_type` (adding the field to the emitter and the frozen contract row). Largest blast radius and the one `large`; PermissionDenied alone is a fully-wired, unreachable `retry` hook.
- **U-C — Hook descriptor drop-through.** Carry `args`, `timeout` (seconds, correct key) and `statusMessage` from both adapters through `projection.ts` **and** `resolver.ts` to `hook-command.ts`; add exec-form spawn and include `args` in the trust hash. Do after U-B so the adapter/projection/resolver path is edited once. **LANDED, recorded 2026-09-03 (P2.305): `943bacbd1` for `args` + the exec-form spawn + the trust key (`commandHookDedupKey` JSON-encodes `[command, ...args]`), and `906638da3` for `statusMessage` reaching `options.statusReporter`. The `timeout`/`timeoutMs` spelling clause was measured too rather than assumed, precisely so this does not repeat the U-D mistake of closing a unit on whichever clauses happened to be checked: BOTH adapters now call `readExternalHookTimeoutMs(entry)` (`format-adapters/claude.ts`, `format-adapters/codex.ts`), each with a comment recording that the reader used to be `entry.timeoutMs` and that the field is common to every hook type rather than command-only. **All three clauses of U-C are closed.**
- **U-D — Claude rule plumbing.** Supply `sourceRoot` at `hooks-automation.ts:1031`, pass `knownToolNames` at the six parse sites and make the unknown-tool warning reachable (`warning` currently only read when `!rule`), and surface `unparseableRule` as an author diagnostic. Self-contained: one module plus its callers. Needs one owner answer first — which root a plugin hook's `if` anchors to. **The third clause LANDED 2026-08-27 in P2.277 (`0d0f4da00`) — recorded here 2026-08-28 (P2.289).** `unparseableRule` is now an author diagnostic: `reportUnparseableIfRule` puts it on `hookErrors`, which `SessionManager.reportHookErrors` shows as a transcript warning quoting the rule. The owner answer the unit was waiting on also came in — a source-anchored `/x` rule anchors to the plugin's own installed bundle (owner decision 2026-07-29, carried in `runtime-automations.ts`'s `ifSourceRoot`) — so what remains of U-D is the `warning`-reachability clause only. **That clause landed too — `7987d4c63` + `f61778b75`, recorded 2026-09-03 (P2.305): `parsed.warning` is read beside an applied rule at `managed-policy.ts:1613`, `permissions-config.ts:652` and `pi-agent.ts:4711`, so U-D is closed on all four clauses and the header's verdict is true at last.** Note the header above closed this unit on the `knownToolNames` clause alone; two of its four clauses were still open at that moment.
- **U-E — Honesty and dead-weight sweep.** Skill `disallowed-tools` (enforce or drop from `SkillMetadata`), the four unimplemented `DOCUMENTED_SKILL_FIELDS` keys (warn instead of allowlist), the `SendUserFile` description, and delete-or-finish on `policyMatch`, `winner`, `fatalError`, `awaitingApproval` + its dead enum arms, `isManagedChannelServerAllowed`, and the whole `MailboxService`/`mailboxState`/`fromAgentId` chain. Last: mostly deletions, and each needs a one-line owner ruling on delete vs finish.
---

## Carried out of U-E, verified by the planner — bigger than any row on this list

**The managed MCP and plugin filters are skipped entirely on a non-Pi turn.**
`packages/server-core/src/bootstrap/storage-runtime.ts` gates both filters on
`isPiCapabilityTurn = context.provider === 'pi'`:

- `:576` — `if (!isPiCapabilityTurn) return true` — the native inventory filter
  keeps every record, so `allowedMcpServers` / `deniedMcpServers` do not apply.
- `:637` — `!isPiCapabilityTurn || (…)` — every plugin candidate passes, so
  `allowedPluginKeys`, `deniedPluginKeys` and `allowPluginHooks` do not apply.

So an organisation's managed MCP and plugin restrictions are **unenforced under
the Claude backend**. Practical exposure today is bounded — `NESSY_FEATURE_
PROVIDER_CLAUDE` is off by default — but this is an admin security control that
silently does not apply on a backend whose code we ship.

**Not fixed, deliberately.** The type is named `ManagedPiPolicyV1`, so the gate
may encode an intent ("this policy describes the Pi runtime") rather than an
oversight. Against that: the same object carries `sandbox`, `channelsEnabled`,
`cleanupPeriodDays` and the permission DSL, none of which are Pi-specific, and
`settings.md` describes these keys as properties of the *installation*, not of a
runtime. My reading is that the gate is wrong and the name is a historical
accident — but a security control's scope is an owner decision, not a planner's,
so it is recorded here for a ruling rather than changed.

Whoever takes it: check whether the Claude backend even reaches this resolver,
and whether any other consumer of `ManagedPiPolicyV1` carries the same gate.

---

## Recorded 2026-09-26 (F1.829) — a guardian runner with no production caller, kept on purpose

**`runGuardianJudge`** (`packages/pi-agent-server/src/orchestrator/guardian-runner.ts`) is the
orchestrator-spawner wrapper over the shared `runGuardianJudgeCore`. Its only caller is
`guardian-runner.test.ts`. The core's live callers are both in server-core's `SessionManager`:
the host `guardianJudgePort` (`createGuardianJudgePort`), which calls the core over the host
child-session authority, and `consultAgentMessageGuardian`, the send_agent_message judge on every
runtime, which calls it over the sender's tool-less `queryLlm` (F1.1195: F1.829's text named only
the first). Until F1.829 the headers of `guardian-runner.ts` and `guardian-judge-core.ts` counted
`runGuardianJudge` as a live runner, and the `GuardianJudgePort` doc in `guardian-consult.ts` named
it as THE concrete implementation; all three now name the live callers instead.

- **Kept, not retired.** `guardian-runner.test.ts` drives the core's retry, timeout, `fast`-alias
  and injection cases through it; retiring it means moving those onto the core's minimal spawn
  contract — a test-only change with no user-visible effect, so it was not worth the churn.
- **What the wrapper hid.** Its outer `scanSubagentOutput` pass runs on NO live path, yet
  `child-output-neutraliser.test.ts`'s `guardian-verdict` case (one of the "every model-facing
  child path" set) drove the wrapper — so with the core's own `sanitizeReason` defang removed that
  case stayed green. F1.829 re-pointed the case at `runGuardianJudgeCore`, the live port's call,
  and it now goes red on that mutant.
- **Whoever wires a caller** (a subprocess-side judge): correct the three docs above and this entry
  in the same commit. `guardian-runner.test.ts`'s importer guard (only test files may import the
  module) goes red first.
