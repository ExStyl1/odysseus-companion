# What each runtime actually offers, by surface

Written 2026-08-28 by lane s1, to give the scope cut something to cut *against*. The companion
document is `2026-08-28-agent-loop-scope.md`, which applies the same boundary to the parity plan's
280 open rows.

This is an inventory of **capability, not of our coverage**. The coverage question — did we take it,
on which runtime — already has three files (`2026-07-31-claude-coverage-map.md`,
`2026-08-22-codex-coverage-map.md`, `2026-08-28-capability-ledger.md`). What none of them answers is
the prior question the owner's four goals now require: *what is there to take at all, and which parts
of it are the agent loop.*

## The boundary rule, stated before the tables

**A feature is `agent-loop` when it changes one of three things: what the model is told, what the
model may do, or what a tool call passes through. It is also `agent-loop` when it differs across pi,
claude and codex at a switch — by goal 1 that difference is the product, whatever category the
feature sits in.** Everything else is `not-agent-loop`: provider sign-in and subscription flows (we
authenticate with `dp` against our own endpoint), organisational reporting that is not a report *of a
permission verdict*, host presentation — UI, notifications, accessibility, keybindings — and our own
build, test and documentation instruments.

Two things the rule deliberately does **not** do. It does not let a category label decide: the
`PushNotification` tool is `agent-loop` because it is a model-callable tool held to one runtime, while
notification *timing* is not. And it does not treat an absent feature and a misreported one
differently: a control that silently stops controlling is `agent-loop` whatever it controls, because
that is this fork's largest measured defect class.

**One qualification the owner has already ruled on.** Provider-subscription surfaces are *built and
hidden behind build flags*, not out of scope — `NESSY_FEATURE_PROVIDER_CLAUDE` and
`PROVIDER_CHATGPT` default off while the two runtime flags default on (`AGENTS.md` §Commands). They
are marked **`gated`** below rather than `not-agent-loop`, because filing them as out invites someone
to delete code the owner intends to re-open.

## How to read the evidence, and what it is worth

The three runtimes do not yield the same kind of evidence, and recording them as if they did is the
error `AGENTS.md` §"The two runtimes need different evidence" exists to prevent.

| Runtime | Strongest evidence obtainable | Consequence for this file |
| :-- | :-- | :-- |
| **Claude (SDK + CLI)** | the vendored artefact for **membership**, the published page for **behaviour** | the binary is closed, so a page anchor plus its verbatim sentence is the ceiling; you can verify our behaviour against the page, never the page against the binary |
| **Codex** | `github.com/openai/codex` at `rust-v0.148.0`, the generated protocol artefacts, the shipped binary | the source outranks the page and every claim carries a **tier**: `strong` = source/artefact/binary, `weak` = `developers.openai.com` / `learn.chatgpt.com` alone, i.e. intent rather than behaviour |
| **Pi** | our own source | Pi has no contract of its own — goal 4 makes Claude's pages Pi's specification, so a Claude gap is a double gap |

**Membership is not behaviour, and the vendored bundle is the denominator.** Measured for this file:
the vendored `@anthropic-ai/claude-agent-sdk` **0.3.223** (bundled CLI `2.1.223`) enumerates **550
distinct `ANTHROPIC_*` / `CLAUDE_*` / `CLAUDE_CODE_*` environment variable names** in `sdk.mjs` +
`bridge.mjs`, against **one** page in the corpus that covers environment variables at all (`env-vars`).
Seven provider selectors exist — `USE_GATEWAY`, `USE_BEDROCK`, `USE_VERTEX`, `USE_FOUNDRY`,
`USE_MANTLE`, `USE_ANTHROPIC_AWS`, `USE_ANTHROPIC_GOOGLE_CLOUD` — each with a `SKIP_*_AUTH`
companion, and `AccountInfo.apiProvider` names eight values including `gateway`. So for any question
of the form *"what is the complete set of X"*, read the bundle and pin it with a test; the pages are a
subset.

**Two measured cautions on absence claims, both of which change what this file may assert.**

1. **A stubbed reader is not a working reader.** Two readers in the shipped Claude bundle are stubs,
   one of them a settings path (parity row `P3.171`). Presence of a name proves membership; presence
   of an accessor proves nothing.
2. **An absence found by searching for an identifier is biased toward false `absent`.** 57 cells in
   the capability ledger carry the `ᵏ` marker — *code probe only, behaviour NOT proven* — and an
   implementation that achieves a behaviour structurally cannot contain the string searched for. Lane
   z1 measured exactly this and refuted a plan row on it. **Where this file names a gap whose evidence
   is `ᵏ absent`, it says `unconfirmed`.**

**The runtime axis has four values, not three.** The product ships four `AgentProvider` values —
`pi`, `anthropic`, `codex-runtime`, **`nestor-cloud-agent`** (`packages/shared/src/config/models.ts:78`);
the owner's goals name three. The fourth has no external corpus at all, so nothing enumerates what it
should offer and no sweep can grade it. It is out of this inventory's tables, and it is recorded as an
open question rather than silently dropped.

## Corpus denominators used here

| Corpus | Size and date | Read from |
| :-- | :-- | :-- |
| Claude Code documentation index | **191 pages, snapshot 2026-08-25** (was 186 on 2026-08-22) | `scripts/claude-doc-pages.tsv`, its own `Snapshot:` comment line — re-verified 2026-08-28, page set byte-identical |
| Claude coverage map | 193 rows = the 191 + 2 historical (`ultraplan`, `agent-sdk/slash-commands`; both still 200, and a 200 is not corpus membership) | `docs/superpowers/specs/2026-07-31-claude-coverage-map.md` |
| Vendored Claude Agent SDK | `0.3.223`, bundled CLI `2.1.223`, binary commit `4535f69721056abf01650c73ee8a91c69ba00838`, built 2026-08-05 | `node_modules/@anthropic-ai/claude-agent-sdk/{package.json,manifest.json,sdk.d.ts,sdk-tools.d.ts}` |
| Codex documentation index | 139 pages mapped; the sweep measured the live corpus at **143**, five never opened | `docs/superpowers/specs/2026-08-22-codex-coverage-map.md`, parity row `P2.308` |
| Codex shipped runtime | `codex-app-server` pinned at **`rust-v0.148.0`**, darwin-arm64 sha256 `26e0c83c…a673b6b` | `apps/electron/resources/bin/codex/manifest.json`; `packages/codex-protocol/schema/config-schema.json` |

All Claude page citations below use `https://code.claude.com/docs/en/<page>.md#<section>` — the `/en/`
segment is required — with the verbatim sentence, never a line number. Every anchor was verified by
fetching the page **without** `.md` and grepping its `id="…"` set; none was derived from a slug rule.
One anchor guessed from the rule was wrong on the first attempt and is recorded here as the reason the
step is not optional: `managed-mcp#exclusive-control-with-managed-mcpjson` does not exist, the
published id is `#exclusive-control-with-managed-mcp-json` — the `.` in `managed-mcp.json` hyphenates,
exactly as `AGENTS.md` says and opposite to what three places in this tree used to say.

---

# 1. Claude Agent SDK — what the vendored artefact offers

Source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (7 264 lines) and `sdk-tools.d.ts`
(3 831 lines, auto-generated from JSON Schema). Scale of the surface: **`Options` has 64 fields**
(`sdk.d.ts:1322–2114`), **`Settings` has 140 top-level keys** (`:5039–6741`), **`Query` has 27
methods** (`:2332–2640`), the `SDKMessage` union has **37 members** (`:4094`), and the control plane
`SDKControlRequestInner` has **36 request subtypes** (`:3804`).

The darwin-arm64 native package holds exactly four files — `claude` (272 MB), `README.md`,
`LICENSE.md`, `package.json`. **There is no `schemas/` directory and no JSON schema file in it**; the
schema-derived artefact lives in the wrapper as `sdk-tools.d.ts`.

`Doc?` below is **slug-level**: `yes` = at least one of the 191 corpus slugs plausibly covers the
subject; `bundle-only` = no covering slug, verified by a named grep against the TSV. There is no local
mirror of the page bodies in this repo, so no sentence-level claim is made in this column.

## 1.1 Session lifecycle and resumption

| Feature | Evidence (`sdk.d.ts:`) | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Resume by id / continue latest / explicit session id | `Options.resume` :1799, `.continue` :1381, `.sessionId` :1805 | yes | agent-loop |
| Fork on resume | `Options.forkSession` :1496 | yes | agent-loop |
| Truncating resume to a chain entry | `Options.resumeSessionAt` :1812 | yes | agent-loop |
| Validated fork point (refuses if anything else is in range) | `Options.resumeDropsTurn` :1866 — print/headless lane only | weak | agent-loop |
| Out-of-process fork with UUID remap | `forkSession()` :700, `ForkSessionResult` :715 | yes | agent-loop |
| Enumerate / inspect sessions without spawning | `listSessions()` :954, `getSessionInfo()` :729, `getSessionMessages()` :759 | yes | agent-loop |
| Per-subagent transcripts | `listSubagents()` :1009, `getSubagentMessages()` :796 | yes | agent-loop |
| Rename / tag / delete | `renameSession()` :2651, `tagSession()` :6986, `deleteSession()` :530 | yes | not-agent-loop |
| Persistence off | `Options.persistSession` :1817 | yes | agent-loop |
| External transcript store (dual-write) | `SessionStore` :4892, `Options.sessionStore` :1825, `.sessionStoreFlush` :1836, `InMemorySessionStore` :894 — all `@alpha` | weak | agent-loop |
| Replayed user frames on resume | `SDKUserMessageReplay` :4728 (`isReplay`, `file_attachments`) | yes | agent-loop |
| Conversation reset (`/clear`, plan exit) | `SDKConversationResetMessage` :3916 (`new_conversation_id`) | yes | agent-loop |
| Pre-warmed subprocess | `startup()` :6872, `WarmQuery` :7233 | **bundle-only** (`grep -aic warm` / `prewarm` → 0 / 0) | agent-loop |
| Exit reasons | `EXIT_REASONS` :651 — **5** values at the vendored `0.3.247`, re-read 2026-09-11: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`. It was `:628` and SIX on `0.3.223`, and the sixth was `bypass_permissions_disabled`, which the vendor RETIRED: `grep -aoF` scores it 0 in `sdk.d.ts`, 0 in `sdk.mjs` and **0** in the native binary (8 before), negative control `nessyNotARealSdkKey` 0 on each. A reader who took the old cell as the denominator would have built an exit-reason switch with a dead arm. | yes | agent-loop |

## 1.2 Query, streaming, message shapes

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Entry point, string or async-iterable prompt | `query()` :2640 | yes | agent-loop |
| Partial assistant streaming, with time-to-first-token | `Options.includePartialMessages` :1902, `SDKPartialAssistantMessage` :4231 (`ttft_ms`) | yes | agent-loop |
| Subagent text forwarded to the parent stream | `Options.forwardSubagentText` :1906 | yes | agent-loop |
| Hook lifecycle visible in-stream | `Options.includeHookEvents` :1893 → `SDKHookStarted/Progress/Response` :4004/:3976/:3989 | yes | agent-loop |
| **Provenance on user frames** | `SDKMessageOrigin` :4099 — `human, channel, peer, task-notification, coordinator, unclassified, observer, auto-continuation, observer-activity`; `peer` carries `verifiedPeerPid` (SO_PEERCRED, explicitly not the forgeable `from`) | partial | agent-loop |
| Transcript-only append (no turn) | `SDKUserMessage.shouldQuery: false` :4712 | weak | agent-loop |
| Prompt priority queueing | `SDKUserMessage.priority: 'now'\|'next'\|'later'` :4691 | weak | agent-loop |
| Control plane over the transport | `SDKControlRequest` :3798, `Transport` :7085, `SpawnedProcess` :6780, `Options.spawnClaudeCodeProcess` :2094 | weak | agent-loop |
| Browser transport (WebSocket / SSE) | `browser-sdk.d.ts` — separate export | weak | not-agent-loop |
| Remote bridge | `bridge.d.ts` — `attachBridgeSession()` :196, `fetchRemoteCredentials()` :296 | weak | not-agent-loop |
| Model refusal fallback | `SDKModelRefusalFallbackMessage` :4167 / `…NoFallback…` :4203 | weak | agent-loop |

## 1.3 Tools

**43 built-in tool input schemas** — `ToolInputSchemas` (`sdk-tools.d.ts:11`): `Agent, Bash,
TaskOutput, ExitPlanMode, FileEdit, FileRead, FileWrite, Glob, Grep, TaskStop, ListMcpResources,
RefreshMcpTools, Mcp, NotebookEdit, ReadMcpResourceDir, ReadMcpResource, ReportFindings, TodoWrite,
WebFetch, WebSearch, AskUserQuestion, SendFeedback, ClaudeDesign, Projects, EnterPlanMode, TaskCreate,
TaskGet, TaskUpdate, TaskList, REPL, Workflow, CronCreate, CronDelete, CronList, ScheduleWakeup,
RemoteTrigger, ShowOnboardingRolePicker, Monitor, ProposeSkills, Artifact, PushNotification,
EnterWorktree, ExitWorktree`. One further tool is named in `sdk.d.ts:96` and absent from the schema
union: **`ObserverReport`**.

`tools-reference.md#check-which-tools-are-available` — *"Your exact tool set depends on your provider,
platform, and settings."* That sentence is the whole switch problem in one line.

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Tool gating (preset or explicit list) | `Options.tools` :1420, `allowedTools` :1367, `disallowedTools` :1391 | yes | agent-loop |
| **Tool aliasing** — remap a model-emitted name to another tool, single-hop and cycle-safe; documented use is routing `Bash` to an MCP sandbox tool | `Options.toolAliases` :1397 | **bundle-only** (`grep -aic alias` → 0) | agent-loop |
| Per-tool render config | `Options.toolConfig` / `ToolConfig` :7065 | weak | not-agent-loop |
| Deferred tool loading / tool search | `SDKDeferredToolUse` :3923; `alwaysLoad` on every MCP config shape (:489, :604, :620) and on `CreateSdkMcpServerOptions` :497; `tool(…, {searchHint, alwaysLoad})` :7055; accounting `deferredBuiltinTools` :3220; `TerminalReason: tool_deferred`, `tool_deferred_unavailable` :7024 | yes — `agent-sdk/tool-search.md#how-tool-search-works`, *"Tool search is on by default, with the exceptions listed in Configure tool search."* | agent-loop |
| MCP transports | `McpStdioServerConfig` :1167, `McpSSEServerConfig` :1150, `McpHttpServerConfig` :1035, `McpSdkServerConfig(WithInstance)` :1052/:1061, `McpClaudeAIProxyServerConfig` :1025 | yes | agent-loop |
| **Per-server tool policy with an org ceiling** | `McpServerToolPolicy` :1123 — `always_allow \| always_ask \| always_deny` + `org_max_permission` | yes — `managed-mcp.md#exclusive-control-with-managed-mcp-json`, *"Claude Code loads only the servers that file defines"* | agent-loop |
| In-process MCP servers | `createSdkMcpServer()` :482, `tool()` :7055, `SdkMcpToolDefinition` :4060 | yes | agent-loop |
| Runtime MCP control | `setMcpServers()` :2603, `reconnectMcpServer()` :2566, `toggleMcpServer()` :2574, `mcpServerStatus()` :1075, `Options.strictMcpConfig` :1978 | yes | agent-loop |
| **Direct MCP invocation with file staging** — `input_files`/`output_files`, `{{in:NAME}}`/`{{out:NAME}}` substitution, lane paths, `if_match` CAS etags, `expires_at`, `timeout_ms` | `SDKControlMcpCallRequest` :3581 | **bundle-only** (`lane` / `staging` / `cowork` → 0 / 0 / 0) | agent-loop |

## 1.4 Permissions

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| **Six modes** — `default, acceptEdits, bypassPermissions, plan, dontAsk, auto` | `PermissionMode` :2145 | yes — `permission-modes.md#available-modes`, *"The table below shows what Claude can do without a permission prompt in each mode."* | agent-loop |
| Host callback with rich context | `CanUseTool` :206 — carries `suggestions`, `blockedPath`, `decisionReason`, `title`, `displayName`, `description`, `toolUseID`, `agentID`, `requestId`, `matchedAskRule`; `null` = answered out of band | yes — `agent-sdk/user-input.md#handle-tool-approval-requests`, *"it fires when Claude wants to use a tool that nothing earlier in the permission flow has approved."* | agent-loop |
| Result variants, with input rewriting | `PermissionResult` :2167 — allow (`updatedInput`, `updatedPermissions`) / deny (`message`, `interrupt`) | yes | agent-loop |
| **Eleven escalation reason types**, `classifier` among them | `SDKControlPermissionRequest.decision_reason_type` :3699 — `rule, mode, subcommandResults, permissionPromptTool, hook, asyncAgent, sandboxOverride, workingDir, safetyCheck, classifier, other`, plus `classifier_approvable`, `suppress_always_allow_rule`, `requires_user_interaction`, `matched_ask_rule` | yes | agent-loop |
| Denial record | `SDKPermissionDenial` :4240, `result.permission_denials` :4372 — **the field is `{tool_name, tool_use_id, tool_input}` and nothing more**; the reason type arrives on the `PermissionDenied` hook, not here (measured, parity row `P3.97`) | yes | agent-loop |
| Six rule-update shapes and five destinations | `PermissionUpdate` :2186 — `addRules, replaceRules, removeRules, setMode, addDirectories, removeDirectories`; `PermissionUpdateDestination` :2215 — `userSettings, projectSettings, localSettings, session, cliArg` | yes — `permissions.md#permission-rule-syntax`, *"Permission rules follow the format `Tool` or `Tool(specifier)`."* | agent-loop |
| Deny outranks allow across every scope | — | yes — `permissions.md#settings-precedence`, *"If a tool is denied at any level, no other level can allow it."* | agent-loop |
| Per-MCP-server tighten-only override | `Query.setMcpPermissionModeOverride()` :2377 — accepts only `'default' \| 'auto' \| null` | weak | agent-loop |
| Runtime mode change | `Query.setPermissionMode()` :2354 | yes | agent-loop |
| Bypass gate, and an org lock for it | `Options.allowDangerouslySkipPermissions` :1751; `Settings.permissions.disableBypassPermissionsMode` :5161 | yes — `permission-modes.md#skip-all-checks-with-bypasspermissions-mode`, *"`bypassPermissions` mode disables permission prompts and safety checks so tool calls execute immediately"* | agent-loop |
| **Escalating-`defaultMode` filter for the repo-committed tier** | `filterEscalatingDefaultMode()` :661 | weak | agent-loop |
| Plan-mode instruction body | `Options.planModeInstructions` :1745 | yes | agent-loop |
| Auto mode's classifier, and its fixed decision order | — | yes — `permission-modes.md#how-the-classifier-evaluates-actions` (an explicit `<span id>`, not a heading), *"Each action goes through a fixed decision order. The first matching step wins"*; `auto-mode-config.md#where-the-classifier-reads-configuration`, *"The classifier reads the same CLAUDE.md content Claude itself loads"* | agent-loop |
| Permissions and sandbox as separate layers | — | yes — `permissions.md#how-permissions-interact-with-sandboxing`, *"Permissions and sandboxing are complementary security layers"* | agent-loop |

## 1.5 Hooks

**31 hook events** — `HOOK_EVENTS` (`sdk.d.ts:816`): `PreToolUse, PostToolUse, PostToolUseFailure,
PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop,
StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest,
PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged,
DirectoryAdded, MessageDisplay`.

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Hook dispatch contract | `HookInput` :837, `BaseHookInput` :164 (`session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id, agent_type, effort.level`) | yes — `hooks.md#hook-lifecycle`, *"Claude Code passes JSON context about the event to your hook handler."* | agent-loop |
| Output shape, sync and async | `HookJSONOutput` :839 = `SyncHookJSONOutput` :6954 (`continue, suppressOutput, stopReason, decision, systemMessage, terminalSequence, reason, hookSpecificOutput`) \| `AsyncHookJSONOutput` :126 (`async`, `asyncTimeout`) | yes — `hooks.md#pretooluse-decision-control`, *"PreToolUse returns its decision inside a `hookSpecificOutput` object."* | agent-loop |
| **Four permission decisions, `defer` included** | `HookPermissionDecision` :841 — `allow \| deny \| ask \| defer` | yes | agent-loop |
| **Five handler kinds, not one** | `sdk.d.ts:5258–5447` — `command` (exec-form `args`, `shell: bash\|powershell`, an `if` permission-rule filter, `once`, `async`, `asyncRewake`), `prompt` (LLM-evaluated, `continueOnBlock`), `agent` (agentic verifier), `http` (POST + `headers` + `allowedEnvVars`), `mcp_tool` (server + tool + `${path}` interpolation) | yes — `hooks.md#prompt-based-hooks`, *"…prompt-based hooks (`type: \"prompt\"`) that use an LLM to evaluate whether to allow or block an action"*; `hooks.md#agent-based-hooks`, *"Agent hooks are experimental."* | agent-loop |
| Programmatic registration | `Options.hooks` :1508, `HookCallback` :821, `HookCallbackMatcher` :828 | yes | agent-loop |
| **Four admin locks on hooks** | `allowManagedHooksOnly` :5517, `allowedHttpHookUrls` :5521, `httpHookAllowedEnvVars` :5525, `disableAllHooks` :5469 | yes | agent-loop |

## 1.6 Subagents, tasks, teams

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Agent definition, 17 fields | `AgentDefinition` :38 — `description, tools, disallowedTools, prompt, model, mcpServers, criticalSystemReminder_EXPERIMENTAL, skills, initialPrompt, maxTurns, background, memory ('user'\|'project'\|'local'), effort, permissionMode, observer, observerMessage` | mostly — `sub-agents.md#configure-subagents`, *"…its frontmatter determines what it can do."* | agent-loop |
| **`observer` / `observerMessage` and the `ObserverReport` tool** | `:96`, `:100`, `sdk-tools.d.ts` union omits the tool | **bundle-only** (`grep -aic observer` → 0) | agent-loop |
| Subagent inheritance rules | — | yes — `agent-sdk/subagents.md#what-subagents-inherit`, *"…its context window starts fresh, with no parent conversation, but isn't empty."* | agent-loop |
| Conversation fork via `/subtask` | — | yes — `sub-agents.md#fork-the-current-conversation`, *"Run a forked subagent with `/subtask`, which requires Claude Code v2.1.212 or later."* | agent-loop |
| Main-thread agent, agent roster, supported agents | `Options.agent` :1350, `.agents` :1366, `AgentInfo` :105, `Query.supportedAgents()` :2504 | yes | agent-loop |
| Background task control | `Query.stopTask()` :2610, `.backgroundTasks()` :2625, `BackgroundTaskSummary` :131, `SDKTaskStarted/Updated/Progress/Notification` :4597/:4621/:4575/:4557 | yes | agent-loop |
| Isolation declared in frontmatter | `SdkAgentDefinition.isolation` (`worktree`/`remote`) — forwarded by us; parity row `P3.205` records it goes inert **silently** if the binary drops the field | yes | agent-loop |
| Agent teams | — | yes — `agent-teams.md#how-agent-teams-work`; owner decision on this plan: **not taken**, recorded as a deviation | agent-loop |
| Workflows (script-driven, context-isolated) | `Workflow` tool; `Settings.enableWorkflows/disableWorkflows/workflowSizeGuideline/workflowKeywordTriggerEnabled/ultracode` :5481–5501, :6436 | yes — `workflows.md#how-a-workflow-runs`, *"Intermediate results stay in script variables instead of landing in Claude's context."* | agent-loop |

## 1.7 Skills, commands, plugins, marketplaces

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Skill filter, reload, and a four-position override | `Options.skills` :1955 (*"a context filter, not a sandbox"*), `Query.reloadSkills()` :2536, `Settings.skillOverrides` :5210 (`on\|name-only\|user-invocable-only\|off`) | yes — `skills.md#configure-skills` | agent-loop |
| **Skill tool pre-approval, and its lifetime** | `Settings` + frontmatter `allowed-tools` | yes — `skills.md#pre-approve-tools-for-a-skill`, *"The grant clears when you send your next message"*; `agent-sdk/skills.md#pre-approve-tools-for-skills`, *"Claude Code applies the `allowed-tools` frontmatter field in SDK sessions."* | agent-loop |
| Skill listing budget | `Settings.skillListingMaxDescChars` :5099, `skillListingBudgetFraction` :5103 | yes | agent-loop |
| Skill shell execution lock | `Settings.disableSkillShellExecution` :5505, `disableBundledSkills` :5216 | yes | agent-loop |
| Slash commands | `SlashCommand` :6756, `Query.supportedCommands()` :2494, `SDKCommandsChangedMessage` :3010 | yes — `commands.md#all-commands` | agent-loop |
| Plugin config and reload | `SdkPluginConfig` :4277, `Options.plugins` :1771, `Query.reloadPlugins()` :2530 | yes — `plugins/components.md#explore-the-plugin-directory` (was plugins § plugin-structure-overview), *"…plugins can include much more: custom agents, hooks, MCP servers, LSP servers, and background monitors."* | agent-loop |
| Marketplace trust surface, 8 settings keys | `enabledPlugins` :5600, `extraKnownMarketplaces` :5608, `strictKnownMarketplaces` :5813, `blockedMarketplaces` :6003, `pluginSuggestionMarketplaces` :6197, `disableSideloadFlags` :6193, `pluginConfigs` :6481, `strictPluginOnlyCustomization` :5541 | yes — `plugins/marketplace-reference.md#plugin-entries` (was plugin-marketplaces § plugin-entries), *"…plus these marketplace-specific fields: `source`, `category`, `tags`, `strict`, `relevance`, `headers`, and `headersHelper`."* | agent-loop |

## 1.8 Settings, managed policy, provenance

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Three setting sources plus a flag tier | `SettingSource` :6741, `Options.settingSources` :1935, `Options.settings` :1917 | yes — `settings.md#settings-precedence`, *"Claude Code uses the value from the highest level that sets it."* | agent-loop |
| Managed settings, restrictive-only filtered | `Options.managedSettings` :1895 | yes | agent-loop |
| **Settings provenance API** — which file a value came from | `resolveSettings()` :2707, `ResolvedSettings` :2657, `ResolvedSettingSource` :2681 (`user\|project\|local\|managed\|flag`), `ProvenanceEntry` :2320, `PolicySettingsOrigin` :2221 (`helper\|remote\|plist\|hklm\|file\|parent\|hkcu`) | weak — all `@alpha` | agent-loop |
| Mid-session flag settings | `Query.applyFlagSettings()` :2440 — `null` clears a key; `effortLevel:'max'` is session-scoped only | weak | agent-loop |
| Managed-policy failure mode | `SDKSettingsParseError` :4483 | yes — `managed-settings.md#invalid-entries-in-managed-settings` (an explicit `<span id>`), *"…drops any top-level key whose value still fails and keeps enforcing every remaining valid key"* | agent-loop |
| Default permission mode key | — | yes — `settings-reference.md#permissions-defaultmode`, *"Set the permission mode new sessions start in."* (dotted key hyphenates) | agent-loop |

## 1.9 System prompt, instructions, memory

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Three system-prompt starting points | `Options.systemPrompt` :2054 | yes — `agent-sdk/modifying-system-prompts.md#how-system-prompts-work`, *"The Agent SDK has three starting points for it"* | agent-loop |
| **Explicit prompt-cache split marker** | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` :6978 | weak | agent-loop |
| **`excludeDynamicSections`** — strips cwd / auto-memory / git status into the first user message for cross-user cache hits | `Options.systemPrompt` preset form :2054 | weak | agent-loop |
| Output styles rewrite the prompt | `SDKSystemMessage.output_style` :4530, `Settings.outputStyle` :6222 | yes — `output-styles.md#how-output-styles-work`, *"Output styles directly modify Claude Code's system prompt."* | agent-loop |
| CLAUDE.md load semantics and excludes | `Settings.claudeMd` :6624, `claudeMdExcludes` :6628, `InstructionsLoaded` hook | yes — `memory.md#claude-md-files`, *"Claude reads them at the start of every session."* | agent-loop |
| **Auto-memory, with scopes and a dream pass** | `SDKMemoryRecallMessage` :4072 (`select\|synthesize`; scopes `personal\|team\|organization`), `Settings.autoMemoryEnabled/autoMemoryDirectory/autoDreamEnabled` :6570–6578 | partial — `memory`; `grep -aic dream` → **0** | agent-loop |
| Cache layering | — | yes — `prompt-caching.md#how-the-cache-is-organized`, *"New content is appended at the end, which means most of each request is identical to the one before it."* | agent-loop |

## 1.10 Model, thinking, effort

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Model selection and fallback | `Options.model` :1793, `.fallbackModel` :1466, `Query.setModel()` :2350 | yes | agent-loop |
| **Model capability self-report** | `ModelInfo` :1224 — `supportsEffort, supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode, supportsAutoMode, resolvedModel` | yes | agent-loop |
| **Thinking configuration, three shapes** | `ThinkingConfig` :7037 = `ThinkingAdaptive` :7029 \| `ThinkingEnabled` :7049 \| `ThinkingDisabled` :7042, each with `display: 'summarized'\|'omitted'`; `Options.thinking` :1668 | **bundle-only** (`grep -aic thinking` → 0) | agent-loop |
| **Five effort levels** — `low, medium, high, xhigh, max` | `EffortLevel` :553, `Options.effort` :1683, `AgentDefinition.effort` | **bundle-only** (`grep -aic effort` → 0) | agent-loop |
| Betas, incl. the 1M context beta | `SdkBeta` :3005 (`context-1m-2025-08-07`), `Options.betas` :1494 | partial | agent-loop |
| Fast mode | `FastModeState` :640, `FastModeDisabledReason` :635 | yes (`fast-mode`) | agent-loop |

## 1.11 Context, compaction, budgets

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Turn ceiling | `Options.maxTurns` :1697 | yes | agent-loop |
| **USD ceiling and a task budget** | `Options.maxBudgetUsd` :1702; `Options.taskBudget` :1712 (`output_config.task_budget`, beta `task-budgets-2026-03-13`, `@alpha`) | **bundle-only** (`grep -aic budget` → 0) | agent-loop |
| **Full context accounting** | `Query.getContextUsage()` :2517 → `SDKControlGetContextUsageResponse` :3138 — per-category tokens, memory files, MCP tools, deferred builtin tools, system-prompt sections, agents, slash commands, skills, `autoCompactThreshold`, `messageBreakdown` incl. `redirectedContextTokens` | yes | agent-loop |
| Compaction boundary and what survives | `SDKCompactBoundaryMessage` :3018 (`preserved_segment`, `preserved_messages`), `PreCompact`/`PostCompact` hooks | yes — `context-window.md#what-survives-compaction`, *"What happens to each kind of content depends on how it was loaded"* | agent-loop |
| Auto-compaction window and precompute | `Settings.autoCompactEnabled` :6658, `autoCompactWindow` :6440, `precomputeCompactionEnabled` :6662 | yes — `model-config.md#context-window-and-auto-compaction`, *"The auto-compact window is how full the context window can get before Claude Code compacts the conversation."* | agent-loop |
| Re-seed the read-file cache after a context snip | `Query.seedReadState()` :2551 | weak | agent-loop |

## 1.12 Sandbox, filesystem, network, credentials

`Options.sandbox` :1893 → `SandboxSettings` :2825.

| Group | Keys | Loop? |
| :-- | :-- | :-- |
| **Network** (:2808) | `allowedDomains, deniedDomains, strictAllowlist, allowManagedDomainsOnly, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup, httpProxyPort, socksProxyPort, tlsTerminate{caCertPath,caKeyPath}` | agent-loop |
| **Filesystem** (:2792) | `allowWrite, denyWrite, denyRead, allowRead, allowManagedReadPathsOnly, disabled` | agent-loop |
| **Credentials** (:2760) | `files[]` — `path, mode:'deny'\|'mask', extract` (regex, capture group 1), `onExtractNoMatch:'warn'\|'deny'\|'error', maskDuplicates, injectHosts`; `envVars[]` — `name, mode, injectHosts`; `allowPlaintextInject` | agent-loop |
| Top level | `failIfUnavailable, autoAllowBashIfSandboxed, allowUnsandboxedCommands, ignoreViolations, enableWeakerNestedSandbox, enableWeakerNetworkIsolation, allowAppleEvents, excludedCommands, ripgrep{command,args}, bwrapPath, socatPath` | agent-loop |
| Extra roots | `Options.additionalDirectories` :1332, `SDKControlRegisterRepoRootRequest` :3742, `DirectoryAdded` hook | agent-loop |

Documented: `sandboxing.md#filesystem-isolation`, *"The sandboxed Bash tool restricts file system
access to specific directories"*; `sandboxing.md#network-isolation`, *"Network access is controlled
through a proxy server running outside the sandbox"*; `sandboxing.md#how-sandboxing-relates-to-permissions-and-permission-modes`,
*"Sandboxing, permission rules, and permission modes are complementary layers."*

**Standing owner decision, 2026-08-12/13: isolation is OFF by default and is not coming back.** So
this whole group is `agent-loop` by subject and inert by configuration — which is exactly why parity
row `P3.80` matters: an execpolicy allow rule on codex resolves to `Skip { bypass_sandbox: true }`, and
that must be documented *before* isolation is ever reconsidered, not after.

## 1.13 Structured output, todos, checkpoints, elicitation, dialogs

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Structured output with retry exhaustion | `Options.outputFormat` :1737, `JsonSchemaOutputFormat` :930, result `structured_output` :4416, `error_max_structured_output_retries` :4352 | yes — `agent-sdk/structured-outputs.md#output-format-configuration` | agent-loop |
| Todos | `TodoWriteInput` (`sdk-tools.d.ts:814`), `Settings.todoFeatureEnabled` :6694 | yes — `agent-sdk/todo-tracking.md#todo-lifecycle` | agent-loop |
| File checkpointing and rewind | `Options.enableFileCheckpointing` :1479, `Query.rewindFiles()` :2543, `RewindFilesResult` :2746 (incl. `skippedLinks` link-safety refusals), `Settings.fileCheckpointingEnabled` :6678 | yes — `agent-sdk/file-checkpointing.md#how-checkpointing-works` | agent-loop |
| **MCP elicitation — two hook events and a callback** | `Options.onElicitation` :1530, `ElicitationRequest` :580, `ElicitationResult` :605, `SDKElicitationCompleteMessage` :3932, hooks `Elicitation`/`ElicitationResult` | **bundle-only** — the only `elicitation` string in the TSV is a header comment naming `elicitation.md` as the MCP spec, *explicitly excluded from the Claude corpus*. Two full hook events with no Claude page. | agent-loop |
| **Host-rendered dialogs, fail-closed** — an undeclared kind is never emitted | `Options.onUserDialog` :1552, `Options.supportedDialogKinds` :1573, `UserDialogRequest` :7166 | **bundle-only** (`grep -aic dialog` → 0) | agent-loop |
| **Interrupt receipts** | `Query.interrupt()` :2347, `SDKControlInterruptRequest.cancel_queued` :3548, response `still_queued`/`cancelled` :3560; capabilities `interrupt_receipt_v1`, `interrupt_cancel_queued_v1` :4540 | weak | agent-loop |
| Host read-only file access | `Query.readFile()` :2513 | weak | not-agent-loop |

## 1.14 Cost, usage, rate limits

| Feature | Evidence | Doc? | Loop? |
| :-- | :-- | :-- | :-- |
| Per-model usage with context window and provider | `modelUsage` :1265 (`contextWindow`, `maxOutputTokens`, `canonicalModel`, `provider`), `NonNullableUsage` :1284 | yes — `agent-sdk/cost-tracking.md` | not-agent-loop |
| **Rate-limit windows and a local behaviour scan** | `Query.usage_EXPERIMENTAL…()` :2525 → :3261 — `five_hour, seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet, model_scoped, extra_usage`, plus `cache_miss\|long_context\|subagent_heavy\|high_parallel\|cron` attributed per agent/skill/plugin/mcp_server | weak | not-agent-loop |
| Org policy limit prefixes | `ORG_POLICY_LIMIT_PREFIXES` :2116, `USAGE_*_PREFIXES` :7140–7158 | weak | agent-loop — a limit that stops a turn is what the agent may do |

## 1.15 Provider and auth surface — `gated`, not out

| Feature | Evidence | Verdict |
| :-- | :-- | :-- |
| Eight provider values incl. `gateway` | `AccountInfo.apiProvider` :31 — `firstParty\|bedrock\|vertex\|foundry\|anthropicAws\|anthropicGoogleCloud\|mantle\|gateway`; `Query.accountInfo()` :2537; `SDKAuthStatusMessage` :2978 | **gated** — the subscription cards are flag-off and re-openable |
| Forced login method incl. `gateway` | `Settings.forceLoginMethod: 'claudeai'\|'console'\|'gateway'` :6201 | **gated** |
| Seven provider selector env vars + `SKIP_*_AUTH` companions | `sdk.mjs` strings, `grep -ao` union | **agent-loop** for the *stripping* question only: `CLAUDE_CODE_USE_GATEWAY` and `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` are stripped **nowhere in the tree** (ledger C5's re-measurement), and `_GATEWAY` sits ahead of all six others in the selector chain and installs a session exempt from the TLS-fingerprint pin. Ambient environment choosing the provider is an egress question, not a sign-in one. |

## 1.16 The bundle-only list, consolidated

Features present in the vendored artefact with **no covering slug** in the 191-page corpus. Each was
checked with a named grep against `scripts/claude-doc-pages.tsv`; the TSV carries only `<slug>\t<title>`,
so this is a slug-level claim and nothing stronger.

`observer` / `observerMessage` / `ObserverReport` · `ClaudeDesign` · `Projects` · `REPL` ·
`SendFeedback` · `ShowOnboardingRolePicker` · `PushNotification` and the three notification settings ·
`ThinkingConfig` and the whole thinking surface · `EffortLevel` and `Options.effort` ·
`promptSuggestions` · `autoDreamEnabled` · `sshConfigs` · `plansDirectory` · the MCP file-staging lane
protocol · `startup()` / `WarmQuery` · `toolAliases` · `taskBudget` / `maxBudgetUsd` · `onUserDialog`
and `supportedDialogKinds` · `footerLinksRegexes` / `prUrlTemplate` · **the two Elicitation hook events**
· `language` / `attribution` / `spinnerVerbs` / `processWrapper` · the `Monitor` tool (the single
`monitor` hit in the TSV is `monitoring-usage`, telemetry).

**All 550 environment variable names are absent from the TSV**, and that is a property of the file
rather than a finding: `grep -acE '[A-Z]{3,}_[A-Z_]{3,}'` over it returns **0** — a slug+title list
contains no SCREAMING_SNAKE tokens at all. The meaningful statement is the ratio: **one page
(`env-vars`) is the only slug that covers environment variables, against 550 names enumerated in the
bundle.** AGENTS.md's own content-level measurement (`_GATEWAY` and `_ANTHROPIC_GOOGLE_CLOUD` in zero
of 191 page *bodies*) could not be re-verified offline here — there is no local page corpus — so it is
carried as inherited, not re-measured.

One caveat worth stating rather than inferring past: roughly **20 of the 398 `CLAUDE_CODE_*` names are
opaque two-word codenames** (`_AMBER_ASTROLABE`, `_BASALT_COVE`, `_GAULT_KESTREL`, `_PEWTER_OWL`,
`_THISTLE_GREBE`, …), almost certainly unreleased feature gates. They are membership, not behaviour,
and nothing here infers what they do.

---

# 2. Claude Code CLI and product — the documented surface

Denominator: the **191 pages** of `scripts/claude-doc-pages.tsv` (snapshot 2026-08-25, re-verified
2026-08-28 — the page set was byte-identical). The coverage map has **193 rows**: the 191 plus two
historical slugs (`ultraplan`, `agent-sdk/slash-commands`) whose URLs still return 200. **A 200 is not
corpus membership**; exclude both from any denominator.

Since 2026-08-26 the map carries **three verdict columns — Pi / claude / codex** — each answering *was
this page's contract taken on this runtime*. Whole-file totals:

| Column | 🟩 taken | 🟨 exists, no row cites the page | 🟥 no implementation, no verdict | ⏸ | ⬜ out of product |
| :-- | --: | --: | --: | --: | --: |
| Pi | 81 | 42 | 10 | 1 | 59 |
| claude | 64 | 52 | 18 | 0 | 59 |
| codex | 38 | 71 | 25 | 0 | 59 |

**Two caveats that bound what those numbers are worth**, both from the map's own text. **No page in
that file was read for the pass** — a verdict locates us relative to a page's *subject*, not its
sentences, so 🟩 licenses *"we took the contract"* and never *"the page's sentences hold at HEAD"*.
And **🟨 is the expensive category, not 🟥**: 🟨 means the code exists and nothing cites the page, which
is the exact state that produced both shipped renaming bugs (`Task`→`Agent`, `lsp`/`lspServers`).

## 2.1 The 23 feature groups

| Group | Pages | Pi / claude / codex | Loop? |
| :-- | --: | :-- | :-- |
| **Agent loop & context** — `how-claude-code-works`, `agent-sdk/agent-loop`, `context-window`, `prompt-caching`, `agent-sdk/streaming-*`, `structured-outputs`, `todo-tracking`, `user-input`, `glossary` | 10 | 🟩7🟨3 / 🟩6🟨4 / 🟨6🟩4 | **agent-loop** — it *is* goals 1, 3 and 4 |
| **Instructions, memory, system prompt** — `memory`, `claude-directory`, `modifying-system-prompts`, `output-styles`, `large-codebases` | 5 | 🟩4🟨1 / 🟩3🟨2 / 🟨3🟩1🟥1 | **agent-loop** — the one surface that must survive a switch |
| **Tools & tool surface** — `tools-reference`, `custom-tools`, `tool-search` | 3 | 🟨2🟩1 / 🟩1🟨1🟥1 / 🟨2🟥1 | **agent-loop** |
| **Permissions & modes** — `permissions`, `permission-modes`, `agent-sdk/permissions`, `auto-mode-config` | 4 | 🟩4 / 🟩4 / 🟨3🟥1 | **agent-loop** — codex is 0🟩 here, the largest loop-adjacent gap |
| **Sandbox & isolation** — `sandboxing`, `sandbox-environments`, `secure-deployment`, `devcontainer` | 4 | 🟨2🟩1⬜1 / 🟨3⬜1 / 🟨2🟥1⬜1 | **agent-loop** by subject; inert by the standing isolation-off decision |
| **Hooks** — `hooks`, `hooks-guide`, `agent-sdk/hooks` | 3 | 🟩3 / 🟩2🟨1 / 🟨3 | **agent-loop** — intercepts every tool call |
| **Subagents, teams, workflows** — `sub-agents`, `agent-sdk/subagents`, `agents`, `agent-teams`, `agent-view`, `workflows`, `cross-session-messaging` | 7 | 🟨4🟩3 / 🟨3🟩2🟥2 / 🟨5🟥2 | **agent-loop** — dispatch topology; a rename here already cost a shipped bug |
| **Skills & commands** — `skills`, `agent-sdk/skills`, `commands` (+1 historical) | 4 | 🟩4 / 🟩4 / 🟩2🟨2 | **agent-loop** — injects instructions and grants tool permission for a turn |
| **MCP** — `mcp`, `mcp-quickstart`, `agent-sdk/mcp`, `managed-mcp` | 4 | 🟩3⬜1 / 🟩2🟥1⬜1 / 🟩1🟨1🟥1⬜1 | **agent-loop** |
| **Channels** — `channels`, `channels-reference` | 2 | 🟩1🟨1 / 🟨1🟥1 / 🟨1🟥1 | **agent-loop, narrowly** — an inbound prompt path into a running session; `channels-reference.md#gate-inbound-messages`: *"An ungated channel is a prompt injection vector."* |
| **Plugins & marketplaces** — 8 pages | 8 | 🟨4🟩3⬜1 / 🟨6🟩1⬜1 / 🟨6🟩1⬜1 | **agent-loop, indirectly** — the delivery vehicle for hooks, skills, agents, MCP and LSP |
| **Sessions, checkpoints, worktrees** — `sessions`, `agent-sdk/sessions`, `session-storage`, `checkpointing`, `file-checkpointing`, `worktrees` | 6 | 🟩3🟨1⏸1🟥1 / 🟨3🟩2🟥1 / 🟨3🟥2🟩1 | **agent-loop** — goal 1 directly |
| **Settings & managed policy** — `settings`, `settings-reference`, `settings-example`, `managed-settings`, `server-managed-settings`, `env-vars`, `debug-your-config`, `feature-availability` | 8 | 🟨3🟩3⬜2 / 🟨4🟩2⬜2 / 🟨4🟥2⬜2 | **agent-loop** — goal 2: the host configures three runtimes through this |
| **Models, advisor, goal** — `model-config`, `fast-mode`, `advisor`, `goal` | 4 | 🟩2🟨1⬜1 (identical on all three) | **mostly agent-loop** — `goal.md#how-evaluation-works`: *"`/goal` is a wrapper around a session-scoped prompt-based Stop hook."* |
| **CLI, headless, SDK entry** — `cli-reference`, `headless`, `interactive-mode`, 11 `agent-sdk/*` | 14 | 🟨4🟩4🟥3⬜2 / same / 🟨6🟥3🟩2⬜2 | **partly** — the SDK entry surfaces are how claude and codex are driven as runtimes; the examples and troubleshooting pages are not |
| **Terminal UX & accessibility** — `statusline`, `keybindings`, `terminal-config`, `fullscreen`, `accessibility`, `voice-dictation` | 6 | ⬜3🟨2🟩1 / ⬜3🟨2🟥1 / same | **not-agent-loop** — presentation; half already out of product |
| **Monitoring, OTel, cost** — `monitoring-usage`, `observability`, `cost-tracking`, `costs`, `analytics` | 5 | 🟩3🟨1⬜1 / 🟨3🟩1⬜1 / same | **narrowly agent-loop** — only where the thing exported is a permission verdict |
| **Enterprise admin & security posture** — `admin-setup`, `security`, `security-guidance`, `claude-security`, `data-usage`, `legal-and-compliance`, `zero-data-retention`, `network-config`, `corporate-launcher`, `third-party-integrations` | 10 | 🟩3🟨3🟥3⬜1 / 🟨4🟥3🟩2⬜1 / 🟥5🟨3🟩1⬜1 | **mixed** — `network-config` yes (egress); the compliance pages no; `corporate-launcher` is **deferred-last by owner ruling** |
| **Gateways, providers, auth** — `gateways`, 4× `llm-gateway*`, `amazon-bedrock`, `google-vertex-ai`, `microsoft-foundry`, `claude-platform-on-aws`, 6× `claude-apps-gateway*`, `authentication` | 16 | ⬜10🟨4🟩2 / ⬜10🟩3🟨2🟥1 / ⬜10🟨6 | **mostly gated/out** — sign-in and subscription flows are the owner's exclusion; **exception**: `gateways` and `llm-gateway-protocol` shape the wire our loopback adapter speaks |
| **Autonomy & external triggers** — `scheduled-tasks`, `desktop-scheduled-tasks`, `routines`, `deep-links`, `code-review`, `ultrareview`, `artifacts`, `remote-control`, `computer-use`, `chrome` (+1 historical) | 11 | ⬜6🟩5 / ⬜6🟩4🟥1 / same | **mixed** — the scheduling and review pages dispatch the loop; artifacts/routines/remote-control/computer-use are out of product |
| **IDE, desktop, web, mobile, CI** — 24 pages | 24 | ⬜22🟩1🟥1 / ⬜22🟨1🟥1 / same | **not-agent-loop** — 22 of 24 already out of product |
| **Onboarding, meta, troubleshooting** — 15 pages | 15 | ⬜8🟩5🟨2 / ⬜8🟩4🟨3 / ⬜8🟨4🟩3 | **not-agent-loop, except** `errors` and `troubleshooting`, which name loop failure modes |
| **Weekly changelog** — `whats-new/2026-w13`…`w34` | 21 | 🟩15🟨4🟥2 (identical on all three) | **not-agent-loop directly — but it is the drift detector**: new loop features enter the corpus here first, and `w33`/`w34` are 🟥 on all three, i.e. unread |

**The structural reading.** The codex column is thinnest exactly where the loop is thickest — 0🟩 on
permissions, 0🟩 on hooks, 0🟩 on subagents/teams/workflows, 0🟩 on tools. The Pi 81 / codex 38 spread
is concentrated in the first twelve groups, not in the out-of-product tail. If the cut is applied and
the remaining work is ranked by these columns, **the codex column of groups 1–12 is the queue**.

## 2.2 Anchors not already cited in §1

| Feature | Anchor | Verbatim |
| :-- | :-- | :-- |
| The Bash tool's process model | `tools-reference.md#bash-tool-behavior` | *"The Bash tool runs each command in a separate process."* |
| The Agent tool's context model | `tools-reference.md#agent-tool-behavior` | *"The Agent tool spawns a subagent in a separate context window."* |
| `.claude/` file roster | `claude-directory.md#file-reference` | *"This table lists every file the explorer covers."* |
| MCP installation scopes | `mcp.md#mcp-installation-scopes` | *"MCP servers can be configured at three scopes."* |
| MCP tool search | `mcp.md#scale-with-mcp-tool-search` | *"Tool search keeps MCP context usage low by deferring tool definitions until Claude needs them."* |
| Plugin component roster | `plugins/components.md#add-each-kind-of-component` (was plugins-reference § plugin-components-reference) | *"Plugins add skills to Claude Code, creating `/name` shortcuts"* |
| Plugin manifest | `plugins/manifest-reference.md#fields` (was plugins-reference § plugin-manifest-schema) | *"The `.claude-plugin/plugin.json` file defines your plugin's metadata and configuration."* |
| Session persistence | `sessions.md#resume-a-session` | *"Sessions are saved continuously to local transcript files as you work"* |
| SDK session tracking | `agent-sdk/sessions.md#automatic-session-management` | *"Both SDKs offer an interface that tracks session state for you across calls"* |
| External session store | `agent-sdk/session-storage.md#the-sessionstore-interface` | *"A `SessionStore` is an object with two required methods, `append` and `load`"* |
| Checkpoint capture point | `checkpointing.md#how-checkpoints-work` | *"…checkpointing automatically captures the state of your code before each user prompt."* |
| Parallelism choice | `agents.md#choose-an-approach` | *"…depends on who coordinates the work, whether the workers need to communicate"* |
| Advisor invocation | `advisor.md#when-claude-consults-the-advisor` | *"Claude decides when to call the advisor."* |
| Headless entry | `headless.md#basic-usage` | *"Add the `-p` (or `--print`) flag to any `claude` command to run it non-interactively."* |
| **`--help` is incomplete** | `cli-reference.md#cli-flags` | *"`claude --help` does not list every flag, so a flag's absence from `--help` does not mean it is unavailable."* |
| Env-var numeric parsing | `env-vars.md#variables` | *"Claude Code reads `2e3` as 2000 and `64_000` as 64000."* |
| Statusline contract | `statusline.md#how-status-lines-work` | *"Claude Code runs your script with JSON session data on stdin"* |
| Proxy scope | `network-config.md#proxy-configuration` | *"Claude Code respects standard proxy environment variables."* |
| OTel metric roster | `monitoring-usage.md#available-metrics-and-events` | *"All metrics and events share these standard attributes"* |
| **SDK telemetry origin** | `agent-sdk/observability.md#how-telemetry-flows-from-the-sdk` | *"The SDK does not produce telemetry of its own."* |

The `cli-reference` sentence is worth flagging on its own: it makes an *absence* from `--help`
non-evidential, which is the CLI equivalent of the membership rule in §1 — and it means a flag census
run against `--help` is not a census.

---

# 3. Codex — the shipped app-server at `rust-v0.148.0`

Every row carries an evidence **tier**, per `AGENTS.md`: **strong** = read from the generated protocol
artefacts, the shipped binary, or `github.com/openai/codex` at the pinned tag; **weak** = read from
`developers.openai.com` / `learn.chatgpt.com` alone, which is intent, not behaviour. A weak cell is a
hypothesis about the binary and must not be recorded beside a strong one as if they were the same
thing.

`github.com` was reachable for this pass, so `codex-rs/app-server-protocol/src/experimental_api.rs`
and `protocol/{common,v2/thread,v2/turn}.rs` were read **at the tag**. The binary was not executed;
every "measured on the shipped binary" claim is either a string-table read done this session or a
citation to a prior in-repo measurement that names its own rig and date.

## 3.0 What we ship

| Fact | Evidence | Tier |
| :-- | :-- | :-- |
| Pin `openai/codex` `rust-v0.148.0`, app-server `0.148.0` | `packages/codex-protocol/manifest.json` (`upstream.tag`) | strong |
| **Six binaries, all six sha256 matching the manifest** (re-verified this session) | `apps/electron/resources/bin/codex/{darwin-arm64,darwin-x64}/codex-app-server`, `win32-x64/{codex-app-server,codex,codex-command-runner,codex-windows-sandbox-setup}.exe` | strong |
| **No Linux binary ships** — three targets only | same manifest | strong |
| The vendored `opencodex` directory is **docs only** (`UPSTREAM.md` + MIT `LICENSE`, ~4 KB each); the copied code lives in `packages/codex-responses-adapter/src/anthropic/{inbound,outbound}.ts` — Anthropic-Messages ⇄ `/v1/responses`, from `@bitkyc08/opencodex` v2.7.17 commit `16bef04`, captured 2026-08-04, `outbound.ts` differing in 4 hunks (2 value-level) | `…/vendor/opencodex/UPSTREAM.md` | strong |

## 3.1 The config surface: 94 properties, and **we write 17**

`packages/codex-protocol/schema/config-schema.json` has **94 top-level properties**, verified by
`json.load` (`additionalProperties: false`). The seventeen we emit, measured this session by executing
`buildCodexConfigToml` on a maximal option set and parsing the top-level keys:

`agents` · `approval_policy` · `approvals_reviewer` · `auto_review` · `default_permissions` ·
`features` · `mcp_servers` · `model` · `model_auto_compact_token_limit` · `model_context_window` ·
`model_provider` · `model_providers` · `model_reasoning_effort` · `permissions` · `sandbox_mode` ·
`shell_environment_policy` · `web_search`.  A minimal option set emits seven.

**Two repo documents are stale on this number and both are cited by lanes.** `docs/architecture/runtime-control-boundary.md`
says *"94 top-level properties; we write 14"* and still lists `auto_review` under "never evaluated";
`docs/superpowers/specs/2026-08-22-codex-coverage-map.md` says 15. The three missing from both
enumerations are `approvals_reviewer`, `auto_review` (P3.2 landed them) and `web_search` (always
emitted as `"disabled"`).

`developer_instructions` is a special case: it is **not** written to `config.toml`. It goes into each
per-role layer at `CODEX_HOME/agent-roles/<role>.toml` via `buildCodexAgentRoles`, and separately over
the protocol (§3.6).

## 3.2 The method surface — and why the generated bindings under-report it by 47

All method literals live in five generated files under `packages/codex-protocol/generated/`. Tier:
strong (generated from the pinned binary).

| Group | File | Count |
| :-- | :-- | --: |
| Client→server requests | `generated/ClientRequest.ts` | **98**, all unique |
| Client→server notification | `generated/ClientNotification.ts` | 1 (`initialized`) |
| Server→client requests | `generated/ServerRequest.ts` | **10** |
| Server→client notifications | `generated/ServerNotification.ts` | **74** |

**Our host drives about twenty of the 108**: `initialize`/`initialized`,
`thread/{start,fork,compact/start,inject_items,approveGuardianDeniedAction}`,
`turn/{start,steer,interrupt}`, `permissionProfile/list`, `config/{mcpServer/reload,value/write}`,
`fuzzyFileSearch`, the five approval/elicitation server-requests, and two experimental methods.

**The structural finding, and it changes how any codex inventory must be built.** The generated
bindings are *not* the app-server's method surface.
`codex-rs/app-server-protocol/src/experimental_api.rs` at the tag states the gate convention
verbatim — *"Convention: `<method>` for method-level gates or `<method>.<field>` for field-level
gates"* — and `protocol/common.rs` carries **63 method-level `#[experimental(...)]` gates**. Against
our shipped bindings those split as:

| | Count | Examples |
| :-- | --: | :-- |
| Experimental **notifications** already present in `ServerNotification.ts` | 16 | `thread/{reverted,queue/changed,environment/connected,settings/updated}`, `process/{outputDelta,exited}`, `turn/moderationMetadata`, 8× `thread/realtime/*` |
| Experimental **methods absent from every generated binding** | **47** | `thread/backgroundTerminals/{clean,list,terminate}`, `thread/queue/{add,list,update,delete,reorder,start}`, `thread/{search,searchOccurrences,turns/list,items/list,revert,settings/update,memoryMode/set}`, `memory/reset`, `process/{spawn,writeStdin,kill,resizePty}`, 7× `remoteControl/*`, 6× `thread/realtime/*`, `environment/{add,info,status}`, `collaborationMode/list`, `plugin/search`, `server/diagnostics` |
| Experimental **field** gates on stable methods | many | `thread/start.{runtimeWorkspaceRoots, permissions, multiAgentMode, historyMode, environments, dynamicTools, activePermissionProfile, …}`, `turn/start.{permissions, environments, granular, collaborationMode, multiAgentMode, additionalContext, …}`, `command/exec.permissionProfile`, `account/login/start.{chatgptAuthTokens, amazonBedrock}` |

**We already depend on this tier.** `packages/shared/src/agent/codex-agent.ts:1444` declares
`capabilities: { experimentalApi: true, requestAttestation: false }` and the host drives
`thread/backgroundTerminals/list` and `…/terminate` — two of the 47. Its own docblock records the
reason: *"the methods DO ship (the binary's own table reads `thread/backgroundTerminals/clean|list|terminate`;
only the TS bindings lag)"*.

**And the refusal taxonomy is measured off the binary, which is why parity row `P2.243` matters**:
there is **no "Method not found" string in the binary at all** (0 occurrences). `ClientRequest` is a
serde-tagged enum, so an unknown method fails as `unknown variant` (32 occurrences), a bad param shape
as `missing field` (41) / `unknown field` (20) / `invalid type` (15). Any classifier that reads a JSON-RPC
code as method-absence is reading a catch-all.

## 3.3 Thread and turn lifecycle

| Feature | Evidence | Tier |
| :-- | :-- | :-- |
| `thread/start` with per-thread overrides | `generated/v2/ThreadStartParams.ts` — `model, modelProvider, serviceTier, cwd, approvalPolicy, approvalsReviewer, sandbox, config` (arbitrary key→JSON), `serviceName, baseInstructions, developerInstructions, personality, ephemeral, sessionStartSource, threadSource` | strong |
| `thread/resume`, three modes with a stated precedence | `v2/ThreadResumeParams.ts` — by `threadId`, by in-memory `history`, or by rollout `path`; precedence `history > non-empty path > thread_id`; rejoins a running thread and uses `path` as a consistency check | strong |
| `thread/fork`, optionally through `lastTurnId` | `v2/ThreadForkParams.ts` — the supported mid-session model-switch boundary | strong |
| **`thread/inject_items`** — appends raw Responses API items to model-visible history | `v2/ThreadInjectItemsParams.ts`; confirmed live at this pin including paired `function_call` + `function_call_output` | strong |
| Rollout records | `v2/ThreadReadParams.ts` (`includeTurns` — *"include turns and their items from rollout history"*), `ThreadListParams`, `ThreadResumeParams`. There is **no `rollout/*` method** | strong |
| Thread record | `v2/Thread.ts` — `id` (UUIDv7), `sessionId`, `forkedFromId`, `parentThreadId` (set only for a subagent), sections, turns, `GitInfo`, `ThreadStatus` | strong |
| `turn/start` with **turn-and-subsequent** overrides | `v2/TurnStartParams.ts` — `cwd, approvalPolicy, approvalsReviewer, sandboxPolicy, model, serviceTier, effort, summary, personality`, **and `outputSchema`** | strong |
| `turn/steer` into a running turn | `v2/TurnSteerParams.ts` — `expectedTurnId` is a required precondition | strong |
| 74 streaming notifications | `generated/ServerNotification.ts` — deltas (`item/agentMessage/delta`, `item/reasoning/*`, `item/commandExecution/outputDelta`), lifecycle (`turn/{started,completed,diff/updated,plan/updated}`, `item/{started,completed}`), guardian (`item/autoApprovalReview/*`, `guardianWarning`), ops (`model/rerouted`, `warning`, `deprecationNotice`, `configWarning`) | strong |
| **Per-connection notification opt-out** | `generated/InitializeCapabilities.ts` → `optOutNotificationMethods?: string[]`. **We set none.** | strong |

**Correction to `docs/architecture/runtime-control-boundary.md`:** it says *"`turn/start` carries no
config"* and files a mid-session model switch as structural. The narrow claim about the *`config` map*
holds — that map is on `thread/{start,resume,fork}` only. The broad claim does not: `model`, `effort`,
`sandboxPolicy`, `approvalPolicy`, `personality` and `serviceTier` are all turn-and-subsequent
overrides on `turn/start`.

## 3.4 Tools

Item kinds the protocol can carry (`generated/v2/ThreadItem.ts`): `userMessage, hookPrompt,
agentMessage, plan, reasoning, commandExecution, fileChange, mcpToolCall, dynamicToolCall,
collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep, imageGeneration,
enteredReviewMode, exitedReviewMode, contextCompaction`.

| Tool | Status | Tier |
| :-- | :-- | :-- |
| `shell` | Live. Surfaces as `commandExecution` with `commandActions` best-effort parsed into `read`/`listFiles`/`search`/`unknown`; `source ∈ agent\|userShell\|unifiedExecStartup\|unifiedExecInteraction` | strong |
| `apply_patch` | Live; `fileChange` items plus `item/fileChange/{outputDelta,patchUpdated}` | strong |
| **`view_image`** | Live, and **the only tool that returns an image content item — codex has no `read` tool.** We now write `[features] view_image = true` explicitly | strong |
| `update_plan` | Live | strong |
| **`web_search`** | `WebSearchMode = disabled\|cached\|indexed\|live`. **We hard-disable it** — it is hosted on OpenAI's backend and unreachable through the Nestor adapter. **Except on the ChatGPT (Codex) card (F1.570, `2c7187bd8`, 2026-09-24):** that card sends its turns to OpenAI's own backend, so the writer writes no `web_search` key there and codex resolves its own default (`Cached` at `rust-v0.156.1`); the host's own `web_search` session tool is withheld on that card through `disabled_tools` on `[mcp_servers.session]`, so only one search tool is offered, and the operator's `NESSY_WEB_SEARCH_ALLOWED_DOMAINS` is written as `[tools.web_search] allowed_domains` — all keyed on `packages/codex-responses-adapter/src/config-writer.ts` (`codexConfigFollowsCodexWebSearch`). The gateway and Bedrock cards keep the disabled line. The host's per-session search cap does not bound codex's own search on that card; the host counts it and says so once past the cap (F1.598, `1eef8e4ff`) | strong |
| `unified_exec` / `exec_command` / `write_stdin` | Present, **not enabled by us** — the persistent-shell family | strong |
| **`tool_search`** | Exists as a feature toggle at this pin (`features.tool_search`, `features.tool_search_always_defer_mcp_tools`). **We write neither**, and there is no `ToolSearch*` type in the bindings | strong |
| `request_user_input` | Present (`ServerRequest item/tool/requestUserInput`, `ToolsToml.experimental_request_user_input`) | strong |
| Multi-agent `spawn_agent` / `list_agents` | Enabled by us via `[features] multi_agent = true` plus `[agents.<role>]`; `CollabAgentTool = spawnAgent\|sendInput\|resumeAgent\|wait\|closeAgent` | strong |
| Image generation | Present; we write nothing | strong |
| **Dynamic tools — the client registers tools codex calls back into** | `v2/DynamicToolSpec.ts` (`function` \| `namespace`), `ServerRequest item/tool/call`, `thread/start.dynamicTools`. Gated behind `experimentalApi`, **which we already declare — and we pass no `dynamicTools`** | strong |
| The `[tools]` table itself | Only **three** keys: `experimental_request_user_input`, `update_plan`, `web_search`; `additionalProperties: false` | strong |

## 3.5 MCP

| Feature | Evidence | Tier |
| :-- | :-- | :-- |
| `RawMcpServerConfig` has **26 fields** | `config-schema.json` `/definitions/RawMcpServerConfig` — `command, args, cwd, env, env_vars, url, auth, oauth, oauth_resource, scopes, bearer_token_env_var, http_headers, env_http_headers, http_headers_helper, enabled, required, enabled_tools, disabled_tools, omit_tools_from, tools, default_tools_approval_mode, startup_timeout_{ms,sec}, tool_timeout_sec, supports_parallel_tool_calls, environment_id, name` | strong |
| Model-facing naming is `mcp__<server>__<tool>` | binary, verbatim: *"Plugin-provided MCP tools keep standard MCP identifiers such as `mcp__server__tool`"* | strong |
| **The prefix is defeatable** | `/definitions/NonPrefixedMcpToolNamesConfigToml` (`enabled`, `server_names` — *"MCP servers whose tools should omit the legacy `mcp__` namespace prefix"*), behind `features.non_prefixed_mcp_tool_names`. Flipping it would break every `mcp__session__`-keyed consumer in this tree | strong |
| What we write | `[mcp_servers.session]` (stdio) and `[mcp_servers.sources]` (`url` + `bearer_token_env_var`); the key `session` deliberately matches the Claude SDK / Pi `mcp__session__` prefix | strong |
| Runtime surface | `mcpServer/{oauth/login,resource/read,tool/call}`, `mcpServerStatus/list`, `config/mcpServer/reload`, `mcpServer/elicitation/request`, `item/mcpToolCall/progress`, `mcpServer/startupStatus/updated` | strong |

## 3.6 Instructions — the one channel we use, and the one that would have destroyed the prompt

| Surface | Status | Tier |
| :-- | :-- | :-- |
| `instructions` (config.toml) | **Never written** | strong |
| `developer_instructions` (config.toml, top level) | Never written at top level | strong |
| `model_instructions_file` | Never written — the schema itself says users are *"STRONGLY DISCOURAGED"* | strong |
| **`thread/start.developerInstructions` (protocol)** | **Live** — `codex-agent.ts` `codexDeveloperInstructions()`, on the start and both fork legs. Lands as the first `developer` item, ahead of codex's own `<skills_instructions>` / `<permissions instructions>` and ahead of the user turn | strong |
| **`baseInstructions`** | **Deliberately not sent.** Measured: with `developerInstructions` the top-level `instructions` stays at codex's own **20,751 characters**; with `baseInstructions` it collapses to **68** — ours and only ours. Sending it deletes codex's entire base prompt | strong |
| Per-role `developer_instructions` | Written into `CODEX_HOME/agent-roles/<role>.toml`; `nickname_candidates` deliberately never emitted | strong |
| AGENTS.md discovery | `project_doc_fallback_filenames` (default `[]`), `project_doc_max_bytes` (**default 32 768**), `project_root_markers` (default `[".git"]`) — **all three unwritten**, so codex's defaults apply | strong |
| The four `include_*` instruction blocks | All four unwritten | strong |

**A second correction to `runtime-control-boundary.md`:** it states *"our system prompt does not reach
codex at all today"* and lists `instructions`/`developer_instructions` under "never exercised". Both
are stale — P3.33 landed the protocol channel and measured it against the shipped binary.

## 3.7 Approvals and sandbox — where the source and the page disagree

| Feature | Evidence | Tier |
| :-- | :-- | :-- |
| `approval_policy` = `untrusted \| on-request \| on-failure \| never` | `/definitions/AskForApproval` | strong |
| `sandbox_mode` = `read-only \| workspace-write \| danger-full-access` | `/definitions/SandboxMode` | strong |
| **`approvals_reviewer` = `user \| auto_review \| guardian_subagent`** | `/definitions/ApprovalsReviewer`. We write `auto_review` only when the resolved policy is interactive; we never select `guardian_subagent` | strong |
| `[auto_review].policy` — *"Additional policy instructions inserted into the guardian prompt"* | `/definitions/AutoReviewToml` | strong |
| Permission profiles | `[permissions.<name>]` with `description, extends, filesystem, network, workspace_roots`; `FileSystemAccessMode = read \| write \| deny` | strong |
| **A profile beats `sandbox_mode` — the opposite of the published page** | `docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md` §1 | **strong (measured); the page is weak and Beta-marked** |
| **"Sandbox off" is observationally identical to "sandbox on" on codex** — all nine capability rows match, and the agent shell has **no network in any shipped configuration**; DNS fails with **exit 0 and empty output** | same doc §2 | strong |
| **Only `:workspace` and `:read-only` are usable `extends` parents.** `:danger-full-access` is reported `allowed:true` by `permissionProfile/list` and **rejects as a parent**, at which point the whole `config.toml` is discarded — **fail-open, stderr only** | same doc §3–§4 | strong |
| Execpolicy projection | `buildCodexExecpolicyRules` writes `prefix_rule(pattern=[…], decision="allow"\|"forbidden")` into `CODEX_HOME/rules/nessy.rules`; precedence `forbidden > prompt > allow`; **one malformed line drops every rule in the file** | strong |
| `ReviewDecision` carries amendment variants | `approved`, `approved_for_session`, `approved_execpolicy_amendment{…}`, `approved_mcp_policy_amendment`, `network_policy_amendment{…}`, `denied{rejection}`, `timed_out`, `abort` | strong |
| Scope limits, stated as nulls | macOS/Seatbelt only; Linux and Windows sandbox unmeasured; the effect of an *accepted* escalation on the credential deny is unmeasured | strong (as a stated null) |

## 3.8 Plugins and hooks — **eleven events, not twelve**

| Feature | Evidence | Tier |
| :-- | :-- | :-- |
| **Three plugin manifest paths, not one** | binary, verbatim: `.codex-plugin/plugin.json` · `.claude-plugin/plugin.json` · `.cursor-plugin/plugin.json` | strong |
| Plugin and marketplace RPC | `plugin/{list,installed,read,install,uninstall,skill/read}`, `plugin/share/{save,updateTargets,list,checkout,delete}`, `marketplace/{add,remove,upgrade}` | strong |
| Config tables | `[plugins.<n>]` → `{enabled, mcp_servers}`; `[marketplaces.<n>]` → `{source, source_type(git\|local), ref, sparse_paths, last_revision, last_updated}`; `[skills]` → `{bundled, config, include_instructions}` | strong |
| **`HookEventName` has ELEVEN values** | `generated/v2/HookEventName.ts` — `preToolUse, permissionRequest, postToolUse, preCompact, postCompact, sessionStart, sessionEnd, userPromptSubmit, subagentStart, subagentStop, stop`. Corroborated by `/definitions/HooksToml` (11 named keys + `state`) and `v2/ManagedHooksRequirements.ts` (11 groups) | strong |
| …and the page agrees | `learn.chatgpt.com/docs/hooks.md`, fetched this session: exactly eleven `###` event headings, no twelfth | weak, but concordant |
| Hook handler types | `HookHandlerType = command \| mcpTool \| prompt \| agent`; `ConfiguredHookHandler` carries `timeoutSec`, `async`, `statusMessage`, `additionalContextLimit` (*null → 2 500 tokens; 0 disables spilling*) | strong |
| Hook provenance and trust | `HookSource` (11 values incl. `mdm`, `cloudRequirements`, `cloudManagedConfig`), `HookTrustStatus = managed\|untrusted\|trusted\|modified`, `HookScope = thread\|turn`, `HookOutputEntryKind = warning\|stop\|feedback\|context\|error` | strong |
| **We write no `[hooks]` table and call no `hooks/list`** | `config-writer.ts` emits no `hooks` key | strong |

> **`AGENTS.md` needs a one-word fix.** Its Codex table describes `learn.chatgpt.com/docs/hooks.md`
> as *"the twelve events"*. At this pin it is **eleven**, agreed by the generated enum, `HooksToml`,
> `ManagedHooksRequirements` and the page itself. Filed here rather than edited, because `AGENTS.md`
> is outside this lane's zone.

## 3.9 The named decision-list items, checked at the pin

| Item | Exists at `rust-v0.148.0`? | Evidence | Tier |
| :-- | :-- | :-- | :-- |
| `thread/goal/*` | **Yes** — 3 methods, `ThreadGoal` with `tokensUsed`/`timeUsedSeconds`, config `goals.max_goal_token_budget`, notifications `thread/goal/{updated,cleared}`. **We write nothing and call nothing.** | `ClientRequest.ts`, `v2/ThreadGoal*.ts` | strong |
| `multi_agent` | **Yes** — `features.multi_agent`, `[agents]` (`enabled, max_depth, max_concurrent_threads_per_session, default_subagent_model, default_subagent_reasoning_effort, interrupt_message`), `MultiAgentMode = explicitRequestOnly \| proactive \| {custom}`. We enable it and set role entries only. | schema + bindings | strong |
| `backgroundTerminals` | **Yes, experimental** — 3 methods, config `background_terminal_max_timeout` (default 300 000 ms). **Absent from the generated bindings**; we call `list` and `terminate`. | `common.rs` at tag; binary strings | strong |
| `outputSchema` | **Yes** — `turn/start.outputSchema`, *"Optional JSON Schema used to constrain the final assistant message for this turn"*. **We pass none.** | `v2/TurnStartParams.ts` | strong |
| Image items | **Yes** — `UserInput` variants `image` (url) and `localImage` (path) with `ImageDetail`; `imageView` and `imageGeneration` items | bindings | strong |
| **Worktree setup scripts** | **NOT FOUND as a config or protocol surface.** `worktree` appears 26× in the binary and **0×** in `config-schema.json` and 0 files in the bindings; `setup_script` is 0 in both. Positive controls on the same rig: `background_terminal` 18, `apply_patch` 166. | absence with controls | strong |
| manage-app-updates | **Partially** — there is no `manage_app_updates` key; the levers are `[features] in_app_updates` and top-level `check_for_update_on_startup`. Our own Electron updater has **no managed gate at all**. | schema + `apps/electron/src/main/auto-update.ts` | strong |
| Import-from-Claude-Code | **Yes** — `externalAgentConfig/{detect,import,import/recordHistory,import/readHistories}`; `ExternalAgentConfigMigrationItemType = AGENTS_MD, CONFIG, SKILLS, PLUGINS, MCP_SERVER_CONFIG, SUBAGENTS, HOOKS, COMMANDS, MEMORY, SESSIONS`. **We call none of it.** | `ClientRequest.ts` | strong |

## 3.10 Model, wire, compaction, cost

| Feature | Evidence | Tier |
| :-- | :-- | :-- |
| `ModelProviderInfo` has 18 fields incl. `wire_api, env_key, auth, aws, http_headers, env_http_headers, query_params, requires_openai_auth, experimental_bearer_token, request_max_retries, stream_max_retries, stream_idle_timeout_ms, supports_websockets, supports_standalone_web_search` | `/definitions/ModelProviderInfo` | strong |
| **`WireApi` at this pin is `["responses"]` only — there is no `chat`** | `/definitions/WireApi` | strong |
| Reasoning knobs | `model_reasoning_effort`, `model_reasoning_summary` (`auto\|concise\|detailed\|none`), `plan_mode_reasoning_effort`, `model_verbosity` | strong |
| Context window | `model_context_window`, `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope` (`total \| body_after_prefix`) | strong |
| What we write | `model`, `model_provider`, `[model_providers.nessy_gateway]` (`base_url = http://127.0.0.1:<port>/v1`, `wire_api = "responses"`, `env_key = COMPANY_LLM_API_KEY`), `model_reasoning_effort`, and the two window keys **only when the catalogue has a real window** | strong |
| `model/list` and `modelProvider/capabilities/read` exist; **we call neither** | `ClientRequest.ts` | strong |
| Compaction | `thread/compact/start` + `thread/compacted`, `contextCompaction` item, `PreCompact`/`PostCompact` hooks, `compact_prompt`, `experimental_compact_prompt_file`, `tool_output_token_limit`. We write the auto-compact limit and nothing else; **compaction ordering at this pin is explicitly unverified** | strong |
| Cost | `thread/tokenUsage/updated` → `ThreadTokenUsage{total, last, modelContextWindow}` with a six-field breakdown; **`ThreadUsage` carries `estimatedUsageUsdMicros` and `estimatedUsageCreditsMicros`**; `account/{usage/read, rateLimits/read}` | strong |

That last row is the direct answer to parity row `P2.258` (*codex's USD ceiling counts zero forever*):
a USD figure **does** exist at this pin, on `ThreadUsage`, with zero callers in our tree.

## 3.11 The capability switches we do not write

Grouped by what flipping one changes. This is the "what is there to take" list for codex, and it is
where §5's `not-agent-loop` line has to be drawn carefully — most of these are squarely in the loop.

- **Instructions and prompt** — `instructions`, top-level `developer_instructions`,
  `model_instructions_file` (replaces the per-model instructions; the schema discourages it),
  `compact_prompt` / `experimental_compact_prompt_file` (compact with *our* prompt instead of codex's),
  the four `include_*` blocks (each trades prompt tokens against the model knowing its own
  environment or permissions), `project_doc_{fallback_filenames,max_bytes}` / `project_root_markers`
  (which project docs are found and how many bytes load), `personality`.
- **Tools** — `[tools].update_plan` and `.experimental_request_user_input`;
  **`features.tool_search` + `tool_search_always_defer_mcp_tools`** (deferred tool loading, the same
  knob the Claude side has also never flipped); `unified_exec` family; `shell_snapshot` /
  `shell_zsh_fork`; `code_mode` / `js_repl` (tool calls routed through a JS REPL where MCP tools appear
  as `tools.mcp__server__tool(...)`); `image_generation`; `browser_use` / `computer_use` /
  `in_app_browser`; **`memory_tool` + `[memories]` (12 keys)** — a cross-thread memory subsystem that
  reads prior rollouts and injects memory instructions; `web_search` modes; `tool_suggest`;
  `allow_login_shell`.
- **Approvals, sandbox, policy** — **`sandbox_workspace_write.network_access` is the single most
  consequential unwritten key: it is why the agent's shell has no network in any shipped
  configuration**; `[permissions.<p>].network` and `.workspace_roots` (the only shape that could keep
  the credential deny *and* lift confinement — unmeasured); the guardian feature family;
  `approvals_reviewer = "guardian_subagent"`; `features.network_proxy` / `respect_system_proxy`;
  the per-OS sandbox backend switches.
- **Model and wire** — `model_reasoning_summary`, `model_verbosity`, `plan_mode_reasoning_effort`,
  `model_auto_compact_token_limit_scope`, `service_tier`, **`model_catalog_json`** (a client-owned model
  catalogue carrying context window, reasoning levels, service tiers and shell type — parity row
  `P3.201`), `oss_provider`, the websocket Responses wire, `review_model`.
- **Extensibility** — **`[hooks]`**, the entire eleven-event vocabulary; `[plugins]`, `[marketplaces]`,
  `[skills]` (codex's own layers — we run ours host-side); `[agents]` fan-out limits;
  `[goals].max_goal_token_budget`; `[orchestrator]`; `[apps]`;
  `features.non_prefixed_mcp_tool_names`.
- **Operations and posture** — `[otel]` (the only route to exported traces; `log_user_prompt` is the
  privacy-relevant one), `[analytics]`, `notify`, the update pair, `cli_auth_credentials_store`
  (`file|keyring|auto|ephemeral`), `forced_login_method` / `forced_chatgpt_workspace_id` (**gated —
  sign-in restriction**), `[history].{persistence,max_bytes}`, `log_dir` / `sqlite_home`,
  `[projects.<path>].trust_level`, `[profiles.<n>]` (26-key named config sets),
  `tool_output_token_limit`, `hide_agent_reasoning` / `show_raw_agent_reasoning`,
  `responses_api_metadata`, and the remainder of the **124-key `[features]` table**
  (`additionalProperties: false`).

---

# 4. The switch surface — where the three actually differ

This is goal 1's payload. Everything below is `agent-loop` by definition: a feature that exists on one
runtime and not another *is* the switch cost, whatever category it sits in. Cells marked
**unconfirmed** rest on identifier-search absence and carry the `ᵏ` bias described at the top.

| # | Feature | Pi | claude | codex | Evidence |
| --: | :-- | :-- | :-- | :-- | :-- |
| 1 | Hook **events** | built to Claude's contract, host-side | **31** in the SDK | **11** natively, of which we fire **4**, and the `Stop` result is discarded | `HOOK_EVENTS` `sdk.d.ts:816`; `generated/v2/HookEventName.ts`; row `P6.11` |
| 2 | Hook **handler kinds** (`command, prompt, agent, http, mcp_tool`) | all five | one of five wired | native `command\|mcpTool\|prompt\|agent`, **and we write no `[hooks]` table at all** | `sdk.d.ts:5258–5447`; `HookHandlerType`; rows `P6.12`, `P6.14` |
| 3 | Hooks declared in a **skill's own frontmatter** | dispatch | **never dispatch** — deferred to an SDK that never loads the skill | — | row `P6.59` |
| 4 | Deferred tool loading / tool search | host-side, Pi only | the SDK's own turns on for a BYO connection **where we can neither see nor render it** | `features.tool_search` exists at the pin, **unwritten** | `agent-sdk/tool-search.md#how-tool-search-works`; row `P6.23`; §3.4 |
| 5 | Output style shaping the assistant | host prompt | host prompt | **receives none at all** | row `P6.36` |
| 6 | The `Concise` style's three documented qualifiers, incl. the **safety carve-out** | dropped | dropped | n/a (no style) | row `P6.37` |
| 7 | Auto-compaction off-switch | honoured | **the claude path turns the SDK's own compaction back on** | `—` no claim | row `P6.53` |
| 8 | Compaction steering (`Compact Instructions`) | **nothing reads it**; the auto path hardcodes `customInstructions: undefined` | — | `compact_prompt` exists, unwritten | row `P6.54`; §3.10 |
| 9 | Compaction-thrashing guard | covered | `—` | **absent — a context that refills after every compaction loops the turn** | row `P6.55` |
| 10 | Reasoning effort from the environment | **env vars read by nothing** | documented vars reach the subprocess | `model_reasoning_effort` written | row `P6.30` |
| 11 | Effort levels reaching the runtime | — | 5 (`low…max`) | **two of six silently downgraded to `high` on every turn** | `EffortLevel` `sdk.d.ts:553`; row `P6.31` |
| 12 | Context window for a gateway model | **stamps a hand-typed 131 072**; the electron preset seeds 262 144 above the gateway's own 262 000 | `modelUsage.contextWindow`; the drift detector **cannot fire** for any gateway/BYO model | `model_context_window` written only when the catalogue has a real window | rows `P3.79`, `P3.43`, `P3.88` |
| 13 | `web_search` execution | — | **never measured through our gateway** | **hard-disabled** — hosted on OpenAI's backend, unreachable through the adapter | row `P6.29`; §3.4 |
| 14 | Built-in browser (pane + CDP) | reachable | reachable | **unreachable by omission from a list, not by architecture** | row `P6.27` |
| 15 | MCP resources and prompts reaching the model | yes | **never, and nothing says so** | — | row `P6.25` |
| 16 | MCP tool name the model is asked for | `mcp__<wire>__<tool>` | `mcp__<wire>__<tool>` | **`mcp__sources__<wire>__<tool>`** | `docs/testing/cdp-live-checklist.md` case `MCP-W2` |
| 17 | An MCP result mixing text with a resource | resource lost, silently | same | same | row `P6.24` |
| 18 | Structured output validation | in-adapter | in-adapter | in-adapter — **no host backstop on any of the three**, and codex's own `turn/start.outputSchema` is unused | row `P3.23`; §3.9 |
| 19 | Native history carry at a switch | — | **every `claude-*` target degrades to a 24×1200 text tail** | `thread/inject_items`, proven live at the pin with paired `function_call` + `function_call_output` | row `P6.10`; §3.3 |
| 20 | Attachments carried across a switch | passed | passed | **never passed** — the payload closure is sync and the resolver async, so it is a shape change | row `P3.56` |
| 21 | An image the receiving model can open | reachable | blocked by evidence, not by types | `view_image` declared and **never run end to end**; the pointer targets a store outside the profile's filesystem scope | rows `P3.57`, `P3.202` |
| 22 | Permission-mode descriptions | true | true | **three of seven are false** | row `P6.4` |
| 23 | The DSL's middle (`ask`/`prompt`) tier | enforced | enforced | **never emitted; a codex refusal names no rule** | row `P6.1` |
| 24 | Read-side non-negotiable floor | present | present | **absent** — codex's only `shouldAllowToolInMode` call consults `deniedPaths` solely to stop a rule auto-approving | row `P3.77` |
| 25 | Deny excluding files from **search results** | not implemented | **the vendor does not deliver it either** — `Read` denied and `Grep` one level above returns the secret, measured on 2.1.223 | `permissions.filesystem` is **OS-enforced**, and may close it | rows `P3.105`, `P3.174`, `P3.175` |
| 26 | Network from the agent's shell | present | present | **absent in every shipped configuration, and DNS fails with exit 0 + empty output** | row `P3.45`; sandbox-enforcement spec §2 |
| 27 | An OS-level deny's blast radius | tool-mediated: `ssh`, `git push`, `aws`, `gcloud`, `kubectl` keep working | tool-mediated, same | **OS-enforced: denying `~/.ssh` stops those commands too**, with `Operation not permitted` naming neither our floor nor the reason | row `P3.184` |
| 28 | Durable Always-Allow grants | host rules | host rules | projected into codex's own execpolicy — **and an allow rule resolves to `Skip { bypass_sandbox: true }`**, and is **stripped per model** by `AllowPrefixRules::IgnoreForCyberModel` | rows `P3.80`, `P3.82` |
| 29 | Managed `env` applied | desktop yes, **headless no** | same | same | row `P3.64` |
| 30 | Organisation's managed requirements enforced | — | — | **21 of 22 read, reported and discarded**; the notice reaches only a debug sink | rows `P6.6`, `P6.7` |
| 31 | Bundled skills seeded | desktop yes; **a headless `nessy-server` ships zero, on every runtime** | same | same | row `P3.206` |
| 32 | `--add-dir` contributing skills / commands / subagents | gate-widening only | **never reaches the subprocess** | same | row `P6.34` |
| 33 | `AGENTS.override.md` steering the agent | host collector blind to it | host collector blind to it | **native** | row `P6.35` |
| 34 | Host RAM-derived subagent ceiling | applies | **never reaches the session** | — | row `P6.16` |
| 35 | Subagent `isolation: worktree` | — | **forwarded unobserved**, and goes inert silently if the binary drops the field | **absent — no mechanism** | rows `P6.18`, `P3.205` |
| 36 | `PushNotification` (a model-callable tool) | present | **absent** | **absent** | row `P6.52` |
| 37 | Operator output cap (`BASH_MAX_OUTPUT_LENGTH`) | **honoured nowhere** | forwarded and honoured | `tool_output_token_limit` exists, unwritten | rows `P2.367`, `P2.366` |
| 38 | Cost reporting | reports | reports | **cannot price a turn** — although `ThreadUsage.estimatedUsageUsdMicros` exists at the pin with zero callers here | rows `P2.238`, `P2.258`; §3.10 |
| 39 | Audit event export (`tool_decision`, `tool_result`, `user_prompt`) | gated on | **off** | **off** — while the metrics sibling is deliberately on | row `P6.42` |
| 40 | Wire protocol | native | **both wires in one connection** — `anthropic-messages` passthrough per request, `openai-compatible` translated | **`responses` only — `WireApi` has no `chat` at this pin** | `AGENTS.md` §Gateway Facts; `/definitions/WireApi` |

## 4.1 Three things this table says that no single row does

**The codex column is a different kind of thin from the Claude column.** Claude's gaps are mostly
*forwarded but unobserved* (35, 4, 7) — the mechanism reaches the runtime and nothing confirms it
landed. Codex's are mostly *never asked for* (2, 5, 8, 13, 18, 37) — the runtime has the mechanism and
we write nothing into it. Those need opposite work: the first needs measurement, the second needs
configuration. **Any plan that treats them as one backlog will mis-size both.**

**The host is thickest exactly where goal 4 is satisfied.** Rows 8, 10, 12 and 37 are all the same
shape: Pi has no contract of its own, so a Claude behaviour Pi must reproduce becomes host code, and
where it was not written Pi silently has nothing. Goal 2 (*thin host*) and goal 4 (*Pi built strictly
to Claude's documentation*) pull against each other on every one of them, and the native-first
ordering cannot arbitrate, because Pi has no native mechanism to prefer.

**Five rows are the same defect wearing five faces: a control that is present, configured, and does
not act.** Rows 7, 12, 28, 30 and 37. Each one reports success while enforcing nothing, and in three
of them the failure direction is *looser*, not stricter.

---

# 5. What the boundary puts outside, and why

Stated as its own section so the cut is arguable rather than implied. Each line names the criterion it
fails, because "not the agent loop" is not a reason by itself.

| Area | Examples from the three surfaces | Why it is out |
| :-- | :-- | :-- |
| **Provider sign-in and subscription** | `AccountInfo.apiProvider` (8 values), `Settings.forceLoginMethod`, `account/login/*`, `forced_login_method`, `forced_chatgpt_workspace_id`, `cli_auth_credentials_store` | Owner statement: we authenticate with `dp` against our own endpoint. **Filed `gated`, not deleted** — the cards are built and hidden behind `NESSY_FEATURE_PROVIDER_CLAUDE` / `PROVIDER_CHATGPT`, both default off. |
| **Host presentation** | `statusline`, `keybindings`, `terminal-config`, `fullscreen`, `accessibility`, `voice-dictation`, notification timing, composer queue verbs, spinner verbs, footer links | Fails all three criteria and does not differ meaningfully at a switch. |
| **IDE, desktop, web, mobile, CI surfaces** | 24 corpus pages, 22 already out of product | Not runtimes and not the loop. |
| **Compliance and legal posture** | `data-usage`, `legal-and-compliance`, `zero-data-retention` | Real obligations; not a thing the model is told, may do, or a tool call passes through. |
| **Cost and usage reporting that gates nothing** | rate-limit windows, per-model usage attribution, the behaviour scan, `[analytics]`, `[otel]` | Out **unless** the thing exported is a permission verdict, or the number gates a turn. Both exceptions are live: `ORG_POLICY_LIMIT_PREFIXES` stops a turn, and the audit-event stream (`P6.42`) reports permission verdicts. |
| **Our own instruments** | build gates, lint configs, typecheck coverage, the test mutex, worktree measurement rigs, doc-anchor conversion, register regeneration | Necessary work; not this cut's subject. It is also the single largest cluster the cut removes — see the companion document. |
| **Platform reach beyond the three runtimes** | `apps/ios` (116 files, in no map and no typecheck), the WSL spike | Not one of the three named runtimes. |

## 5.1 One deferral, and it is not a category judgement

**Corporate launcher** (`corporate-launcher.md`; ledger `C4`; parity row `P6.9`) — routing every shell
command, hook and stdio-MCP server launch through an operator-set wrapper. **By criterion 3 this is
inside the loop**: every Bash tool call passes through such a wrapper. The measurement stands — three
live unwrapped spawn sites, absent on all three runtimes, switch verdict `UNIFORM`.

**The owner has ruled on its priority, not on the finding:** *«этого не будет, я бы не стал сейчас это
делать»*, and *«я бы сместил это аж в самую последнюю очередь»*. The reasoning that makes the ruling
legible rather than arbitrary: the launcher changes how an organisation **observes and constrains** the
agent rather than what the agent can do, and the four goals are about the agent loop. It is
**deferred-last**, and it must not be recorded as refuted or as done.

---

# 6. What this inventory says the cut should keep

Not a plan — an ordering that falls out of the tables above.

1. **The codex column of documentation groups 1–12** (§2.1). Codex is 0🟩 on permissions, hooks,
   subagents/workflows and tools, and §3.11 shows most of those are *unwritten configuration in a
   mechanism codex already has* rather than a build. Native-first step 1, forty-odd times over.
2. **The five rows in §4.1's last paragraph** — controls that are present, configured and do not act.
   Three of the five fail loose.
3. **The switch surface itself** (§4, rows 19–21 and 40): native history carry, attachments, images,
   and the wire. This is what goal 1 *is*, and it is the smallest coherent block in the table.
4. **The membership sweeps neither corpus can answer** — the 550 bundle-enumerated environment
   variables against one covering page, the 47 experimental codex methods absent from our own
   bindings, and the 124-key `[features]` table. Derive guards from the artefact's own list and pin
   them with a test; a prose enumeration beside a single source of truth ages silently, and three
   sentences in this repo have already done so while this file was being written.

## 6.1 Corrections this inventory owes to other files

Filed here rather than edited, because each file is outside this lane's zone.

| File | Claim | Measured |
| :-- | :-- | :-- |
| `AGENTS.md` §Codex table | *"the twelve events"* for `learn.chatgpt.com/docs/hooks.md` | **eleven** — the generated `HookEventName` enum, `HooksToml`, `ManagedHooksRequirements` and the page itself all agree |
| `docs/architecture/runtime-control-boundary.md:138` | *"94 top-level properties; we write 14"* | **17**, measured by executing `buildCodexConfigToml`; `auto_review` is written and still listed there under "never evaluated"; `approvals_reviewer` and `web_search` are absent from the enumeration |
| same file | *"our system prompt does not reach codex at all today"*; `instructions`/`developer_instructions` "never exercised" | stale — `thread/start.developerInstructions` is live on the start and both fork legs |
| same file | *"`turn/start` carries no config"* | true of the `config` **map** only; `model`, `effort`, `sandboxPolicy`, `approvalPolicy`, `personality`, `serviceTier` are turn-and-subsequent overrides |
| `docs/superpowers/specs/2026-08-22-codex-coverage-map.md` | `approvals_reviewer` / `[auto_review]` "never written"; 15 keys written | both stale; see above |
| `packages/codex-protocol/README.md` | protocol notes | accurate as far as they go, but they do not record that `generated/` omits **47 experimental request methods** the binary serves — anything treating `ClientRequest.ts` as the method surface under-counts |
