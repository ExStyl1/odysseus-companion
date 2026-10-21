# Runtime Control Boundary — Pi, Claude, Codex

**What this record answers.** Nessy ships three agent runtimes. Pi is ours: we build the harness around a third-party agent SDK and follow Claude Code's documentation as the design contract. Claude and Codex are vendor runtimes we drive. This record draws the line for each one: which decisions we hold, which belong to the vendor, whether *our* tools reach the model on that runtime, and what vendor functionality we do not use — separating "structurally impossible" from "a switch nobody has flipped".

**This is a MEASURED SNAPSHOT, taken 2026-08-16 against `feat/models-fetch`.** Every `file:line` in it can drift and some already has: the mapping pass that fed this record cited `packages/pi-agent-server/src/index.ts:2079-2082` for the `customTools` seam, and on the day of writing that seam sits at `:2134-2135`. **Re-verify a coordinate before relying on it.** The durable parts are the quoted sentences, the mechanism names, and the shape of the boundary; the numbers are a convenience.

---

## 0. The rule this record describes

The rule is not inferred — it is written into the code that implements it, at `packages/shared/src/agent/claude-runtime-agents.ts:5-8`:

> "The owner's rule for this fork: Pi is ours and is built to Claude Code's documentation; Claude runs "as-is" so we do not diverge from its real behaviour."

Everything below is a measurement of how faithfully that rule is actually implemented, and where it is implemented *more* strictly or *less* strictly than the sentence suggests.

---

## 1. The one-sentence answer, per runtime

| Runtime | Who owns what |
| --- | --- |
| **Pi** | **Almost everything model-visible is ours.** The SDK (`@earendil-works/pi-coding-agent` 0.84.x) supplies an agent loop, a provider transport, a session file format and a compaction primitive. The system prompt, the entire tool list, every tool implementation, every permission decision, compaction instructions, subagents, skills and hooks are Nessy's, signed into a hashed manifest and asserted identical on both sides of the subprocess boundary before a turn runs. |
| **Claude** | **Their agent, their tools, their loop — with our gate on every tool call and our tools added alongside theirs.** We append to their `claude_code` system-prompt preset rather than replacing it, we run their full built-in toolset, and their subprocess executes everything. Our influence is: an append block, per-turn user-message context, a `PreToolUse` hook that can block *and rewrite tool inputs*, an extra MCP server carrying our session tools, our subagent definitions registered through their own `agents` option, and a handful of env vars. Since R3 (2026-08-16) their permission system runs too, in the user's own mode, instead of being switched off by a pinned `bypassPermissions`. |
| **Codex** | **The thinnest control of the three: a config file, an approval answer, and text on the user message.** Codex's own base instructions, tool set, loop and compaction are untouched. We write ~14 of 94 available config keys before spawn, prepend our context to the user's message, answer approval requests allow/deny/abort (no input rewriting), and expose a *reduced* set of our session tools over MCP. There is no `PreToolUse` gate on this runtime at all. |

---

## 2. The levers we hold, and the decisions that are theirs

### 2.1 Pi

**Ours (levers we actually pull):**

- **The whole system prompt.** `getSystemPrompt` (`packages/shared/src/prompts/system.ts:400`) plus a Pi-specific tail (`packages/shared/src/agent/pi-harness/prompt-composer.ts:15`). It is delivered on the `prompt` wire message (`packages/shared/src/agent/pi-agent.ts:7325-7337`) and **replaces** Pi's own assembled prompt via a `before_agent_start` extension (`packages/pi-agent-server/src/compat/pi-runtime-adapter.ts:270-275`).
- **Turning off every SDK self-discovery path.** `noExtensions / noSkills / noPromptTemplates / noThemes / noContextFiles: true` at `pi-runtime-adapter.ts:307-311`. Nothing enters the prompt or the tool surface that the host did not sign.
- **The complete tool list, including the "built-ins".** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `NotebookEdit` are Nessy implementations (`packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts:25`), handed to the session as `customTools` with `tools` restricted to exactly our name list (`packages/pi-agent-server/src/index.ts:2134-2135`). The Pi SDK contributes **no tool** to a Nessy session.
- **Every tool execution**, through our own `ToolExecutor` (`packages/shared/src/agent/pi-harness/tool-executor.ts:156`), with semantic ports, checkpointing and result transforms.
- **Every permission decision.** The subprocess cannot execute a tool without a host-minted receipt: it asks over `pre_tool_use_request` (`packages/pi-agent-server/src/index.ts:2361`), the host runs the centralized gate `runPreToolUseChecks` (`packages/shared/src/agent/core/pre-tool-use.ts:1049`), and receipts are single-use.
- **Process isolation.** The subprocess never spawns a shell; it asks the host's `ProcessSupervisor`, which rebuilds the request from an allowlist, so a bypass flag originating in the subprocess can never be honoured (`packages/shared/src/agent/pi-agent.ts` `handleProcessStartRequest`).
- **Compaction policy and the summary text.** Whether it runs, at what threshold, and the instructions (`packages/shared/src/config/auto-compaction-settings.ts:31`; `prompt-composer.ts:114`). We hijack Pi's own auto-summarizer through the `session_before_compact` extension and return our own `CompactionResult` (`packages/pi-agent-server/src/index.ts` `autoCompactionExtension`, registered at `pi-runtime-adapter.ts:300`).
- **The wire to the provider.** A network interceptor is preloaded into the subprocess with `--require` (`packages/shared/src/agent/pi-agent.ts:1483-1487`) and rewrites gateway auth headers, strips injected metadata, upgrades prompt-cache TTL and repairs OpenAI-shaped bodies/SSE. **Pi-only** — see §4.
- **The SDK's own `Agent` object, after construction.** Nine loop hooks are public mutable fields (`node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:37-45`: `transformContext`, `streamFn`, `getApiKey`, `onPayload`, `onResponse`, `beforeToolCall`, `afterToolCall`, `prepareNextTurn`, `prepareNextTurnWithContext`), and the loop config is rebuilt from the live fields on every run. We already use this in production: `pi-runtime-adapter.ts:370-390` sets `agent.toolExecution = 'parallel'`, asserts the assignment stuck, and chains a wrapper onto `prepareNextTurnWithContext`. **The constraint is that you must chain rather than clobber**, since `AgentSession` installs its own tool hooks by the same mechanism.

**Theirs (decisions we do not make):**

- The agent loop: turn structure, message assembly, streaming, tool-call parsing and dispatch order.
- The provider transport and model registry (`pi-ai`); we choose the model object, not the wire semantics at the SDK layer.
- **When compaction is checked and fired.** Pi decides; the only knob it exposes is `reserveTokens`, which is why our percentage threshold is translated into it (`packages/pi-agent-server/src/auto-compaction-settings.ts:82`, with the reason recorded at `:78-81`).
- The compaction primitive itself — how history is truncated, what `firstKeptEntryId` is, how the summary entry is stored.
- **The session storage format.** `SessionManager`'s constructor is private; the only entry points are `create/open/continueRecent/inMemory/forkFrom`, and `createAgentSession` requires a real instance. We choose *where* the JSONL lives, never its shape. The proof that we bend rather than change it: when tool names moved we normalize legacy `toolCall` records **in memory** after construction (`normalizePiSdkToolCallRecordsV1` in `pi-runtime-adapter.ts`), and `pi-runtime-adapter.test.ts`'s "normalizes legacy structured tool calls in memory without rewriting a session file we did not author" asserts the on-disk JSONL stays byte-identical.
- Extension event vocabulary, payload shapes and the first-cancel-wins short-circuit rule (which is why our lifecycle bridge is registered *before* the auto-compaction extension — `pi-runtime-adapter.ts:283-288`).
- **There is no iteration or turn cap in the SDK.** `shouldStopAfterTurn` exists on `AgentLoopConfig` (`pi-agent-core/dist/types.d.ts:183`) but is *not* a public `Agent` field, and no `maxTurns`/`maxIterations`/`maxSteps` appears in `agent.d.ts` or `pi-coding-agent/dist/core/sdk.d.ts`. Our turn budget is therefore enforced outside the loop: we count `turn_start` events and force-abort (`packages/shared/src/agent/pi-agent.ts:2946-2957`).

### 2.2 Claude

**Ours:**

- **An append block on their preset**, not a replacement: `systemPrompt: { type: 'preset', preset: 'claude_code', append: getSystemPrompt(...), excludeDynamicSections: true }` (`packages/shared/src/agent/claude-agent.ts:283-318`, applied at `:1550-1571`). `excludeDynamicSections` keeps the SDK's cwd/memory/git sections out of the prompt so it stays cacheable; the SDK re-injects them as the first user message.
- **Per-turn context on the user message** via the shared `promptBuilder.buildContextParts` (`claude-agent.ts:2769`), including the skill listing (`packages/shared/src/agent/core/prompt-builder.ts:316`).
- **The permission gate, delivered as a hook — but no longer *instead of* theirs.** We run everything through an internal `PreToolUse` hook that calls the same centralized `runPreToolUseChecks` Pi uses. Until R3 (2026-08-16) we also set `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` for every session in every mode, which switched their permission system off entirely. **That pin is gone.** The user's own mode is translated into the SDK's vocabulary (`claude-permission-mode.ts`; five names are identity, `explore` and `plan` map to `default` because our gate is their no-write floor and because handing plan mode to the SDK is recorded REFUTED in the plan), so their mechanism decides and our hook answers it — the shape Codex has always run. What makes that safe is R1: our allow now carries `permissionDecision: 'allow'`, which "skips the permission prompt", so a read-only command our AST validator approves still runs with no card.
  This record used to add "which makes `canUseTool` dead code by design", repeating the claim the callback's own comment made. **That was wrong, and R2 (2026-08-16) measured it.** `permissions.md` § How permissions are evaluated puts three routes ahead of the permission-mode step, each "even in `bypassPermissions` mode": an `ask` rule from settings.json, a connector tool an organization set to `ask`, and tools that require user interaction. We pass `settingSources: ['user', 'project', 'local']`, so a user's own `ask` rule was reaching a callback that returned `allow` for everything.
- **Rules written in Claude's own format now take effect on Claude (R3).** The `permissions` `allow`/`ask`/`deny` blocks of `.claude/settings.json` are compiled by `claudeSettingsPermissionDsl` and consumed **only** Pi-side and (since R6) Codex-side; `claude-agent.ts` has no consumer and does not need one, because the SDK reads those files itself under the `settingSources` we pass. What kept them from mattering was the bypass in front of them and a `canUseTool` that said yes. Both are gone, so an `ask` rule raises a real card. Rules written under `permissionDsl` in a Nessy `permissions.json` are still Pi/Codex-only — a difference now recorded in `apps/electron/resources/docs/permissions.md` rather than implied.
- **Rewriting a tool's input inside their tool.** The hook returns `updatedInput`: oversized image `Read`s are redirected to a resized path and revalidated (`claude-agent.ts:1647-1682`), and an approved `Bash` command string is wrapped by the macOS seatbelt sandbox (`packages/shared/src/agent/core/pre-tool-use.ts:1476-1486`). This is a real lever inside a vendor tool.
- **A blocked tool list**: three names — `EnterPlanMode`, `ExitPlanMode`, `Skill` (`claude-agent.ts`, `CLAUDE_SESSION_DISALLOWED_TOOLS`). It was four until R2 (2026-08-16): `AskUserQuestion` was banned for "no UI", the UI had existed for some time, and the ban meant the same model in the same window could ask a clarifying question on Pi and not on Claude.
- **Extra MCP servers**: our session tools as an in-process SDK MCP server named `session` (`claude-agent.ts:1449-1456`, built by `getSessionScopedTools`, `packages/shared/src/agent/session-scoped-tools.ts:209/330-331`), plus one proxy server per active MCP/API source.
- **Our subagent definitions, through their own mechanism.** `buildClaudeRuntimeAgentOptions` (`claude-agent.ts:1925`) translates the same descriptors Pi and Codex read into the SDK's documented `agents` option. Fields the SDK cannot express (`skillKeys`, `mcpServerKeys`, `initialPrompt`) are dropped deliberately, each with a recorded reason (`claude-runtime-agents.ts:106-124`).
- **Config-dir isolation and env policy.** `CLAUDE_CONFIG_DIR` is redirected per Workspace (`packages/shared/src/agent/options.ts:227/258`), cloud-provider routing vars are stripped so no Bedrock/Vertex path can be reached through this runtime (`options.ts:262-269`), and `CLAUDE_CODE_MAX_RETRIES` / `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` are pinned.
- **Two context/compaction envs, both derived from our model catalogue**: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (`claude-agent.ts:444` region) and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`:444-452`). The docblock at `:384-443` is the important artefact here — it records a *measured* failure (a claude-runtime session carried to 227 337 tokens with no compaction) traced to the binary's `pY_` gate reading `source === "auto"` for a gateway model id, and the env that fixes it.
- **Session lifecycle control**: `resume`, `forkSession`, `resumeSessionAt` for branch cutoff (`claude-agent.ts:1890-1902`), and turn-level structured output (`buildClaudeStructuredOutputOptions`).

**Theirs:**

- **The entire built-in toolset.** `tools: { type: 'preset', preset: 'claude_code' }` (`claude-agent.ts:1588-1596`). Read/Write/Edit/Bash/Grep/Glob/WebFetch/WebSearch/Task etc. are Claude's implementations, executed in Claude's subprocess. (Note: the inline comment at `:1911` says "file tools are disabled (use MCP)" — that comment is **stale**; `disallowedTools` at `:1431` lists only the four names above.)
- The agent loop, compaction mechanics, retry, streaming, subagent dispatch, transcript storage under the redirected config dir.
- The base system prompt — we only append to it.
- Model alias resolution, except where a gateway connection makes an alias unresolvable and our `buildAgentModelPolicy` substitutes with a logged announcement (`claude-agent.ts:1932-1941`).
- Everything reached through `settingSources: ['user','project','local']` — including `CLAUDE.md` discovery.

### 2.3 Codex

**Ours:**

- **A generated `config.toml`, written before spawn** (`packages/codex-responses-adapter/src/config-writer.ts:611` `buildCodexConfigToml`). We set 14 top-level names: `model`, `model_context_window`, `model_auto_compact_token_limit`, `model_reasoning_effort`, `model_provider`, `web_search = "disabled"`, `approval_policy`, `sandbox_mode`, `default_permissions`, `[shell_environment_policy]`, `[model_providers.nessy_gateway]`, `[permissions.nessy_runtime]`, `[mcp_servers.*]`, `[agents.*]`.
- **The provider endpoint**: a per-session in-process loopback adapter, with `base_url = http://127.0.0.1:<port>/v1` and `wire_api = "responses"` (`config-writer.ts:664-668`).
- **The auto-compact point.** Codex has a window but no point to compact at unless `model_auto_compact_token_limit` is written; the code records the measurement that forced it (`config-writer.ts:630-633`: five turns reached 91.5% of the window and a sixth went higher). The fraction is `0.85` (`:593`).
- **Sandbox and approval policy per Nessy permission mode** (`codexSandboxConfigForMode`, `config-writer.ts:189`), plus a filesystem permission profile carrying the protected-path floor and the user's or operator's own `deniedPaths` (since F1.1057, 2026-09-28, the host adds no `credentials.enc` or shipped-floor deny: codex runs with its own defaults).
- **Approval answers.** Server→client approval requests bridge to our permission UI (`packages/shared/src/agent/codex-agent.ts:490-530`).
- **Context on the user message.** `buildContextParts` output — date/time, `session_state`, source state, workspace capabilities, working directory, skill listing — is prepended to the prompt text (`codex-agent.ts:740-750`).
- **Agent definitions as `[agents.<role>]` blocks** plus one role layer file each, carrying `developer_instructions` (`config-writer.ts:399` `buildCodexAgentRoles`, `:461`). Same descriptors as the other two runtimes; codex expresses a subset and the rest are denied by omission, announced on a diagnostic channel.
- **Four hook events**: `SessionStart`, `UserPromptSubmit` (whose `additionalContext` is folded into the prompt and whose `block` ends the turn), `Stop`, `SessionEnd` (`codex-agent.ts:672-698`, `:1015-1026`).
- **Thread re-forking** when the config layer or the selected model drifts, because `turn/start` carries neither and `thread/resume` ignores config overrides (`codex-agent.ts:605-631`).

**Theirs:**

- **The BASE instructions, and only those.** Codex's own 20,751-character system prompt runs the session, and we leave it standing: no top-level `instructions`, no `baseInstructions` on the thread params, no `model_instructions_file`. **All three REPLACE it rather than add to it** — driven against the bundled `codex-app-server`, `baseInstructions` collapses that prompt from 20,751 chars to 68 (P3.33's table, `codex-agent.ts`). **What is ours on this channel is additive and IS written** (P6.173): the host's safety guidance rides `developerInstructions` at thread start, thread fork and thread resume, landing as the first `developer` item ahead of codex's own `<skills_instructions>`, and each agent role carries its own `developer_instructions` (the bullet above). So *"our system prompt does not reach codex"* is false at HEAD; what does not reach it is the base-prompt SLOT, deliberately.
- **The tool set and its execution.** `shell`, `apply_patch` and the rest run inside the codex binary. Approval responses are decision-only — `{decision}` / `{action}` / a permissions grant (`packages/codex-agent-server/src/approval-bridge.ts:585-596`) — so **we can allow, deny or abort a codex tool call, but we cannot rewrite its input**.
- The loop, compaction mechanics (we call `thread/compact/start` for a manual `/compact` — `codex-agent.ts:772-781`), transcript storage, and the multi-agent spawn authorization (`agents.enabled` is deliberately not written; `config-writer.ts:718-724`).
- Sandboxing of codex's own shell: `codex-app-server` is spawned directly by `CodexRuntimeManager`, **never through `ProcessSupervisor`**, so `sandbox_mode` in the config is the only sandboxing layer codex's shell executions get (`codex-agent.ts:255-266`).

---

## 3. Do OUR tools reach each runtime?

This is the owner's specific worry. Plainly, per runtime:

**Pi — yes, and more: *all* tools are ours.** There is no "our tools alongside theirs"; the SDK contributes nothing. Session tools travel a single five-hop path: canonical definition in `packages/session-tools-core/src/tool-defs.ts` → JSON Schema with `prefix: 'mcp__session__'`, `projection: 'pi'` (`packages/shared/src/agent/backend/pi/session-tool-defs.ts:34`) → the signed execution manifest (`harness-manifest.ts:539`) → `register_tools` into the subprocess → a synthesized Pi `ToolDefinition` whose schema comes from the *manifest*, not the subprocess. A build-time assertion (`pi-agent.ts` `assertBackendSessionToolParity`) fails if a session tool has no Pi implementation. The tool then executes on the **host**, not in the Pi subprocess.

**Claude — yes, as an added MCP server, next to Claude's own tools.** `mcpServers.session` is an in-process SDK MCP server carrying `CLAUDE_BACKEND_SESSION_TOOL_NAMES` (`session-scoped-tools.ts:73`), and each active source gets its own proxy server so names come out as `mcp__<slug>__<tool>`. A parity test asserts the Claude backend implements every backend-mode session tool in the core registry (`packages/shared/src/agent/backend/claude/session-tool-parity.test.ts`). **But**: Claude's own Read/Edit/Write/Bash do the file and shell work, not ours. We do not substitute our implementations — we gate them and, where needed, rewrite their inputs.

**Codex — partly, and it is the deliberately reduced set.** Two MCP servers reach codex: `[mcp_servers.session]`, the bundled `session-mcp-server` spawned with `--external-standalone-only` (`codex-agent.ts:178-206`), and `[mcp_servers.sources]`, the shared workspace MCP pool over HTTP with a bearer token. `--external-standalone-only` advertises and dispatches **only** registry-mode tools with no host-callback dependency (`packages/session-mcp-server/src/index.ts:398-399/452-455`). The excluded set is explicit and single-sourced at `packages/session-tools-core/src/tool-defs.ts:1185-1216` — 25 names including `SubmitPlan`, `call_llm`, `spawn_session`, `browser_tool`, `SlashCommand`, `BashOutput`, `Monitor`, `EnterWorktree`/`ExitWorktree`, `Goal`/`GoalGet`, `read_skill_resource`, `PushNotification` and all four `plugin_*` tools. What survives is the standalone set: `source_test`, `config_validate`, `get_session_info`, `transform_data`, `render_template`, `list_sessions`, `TodoWrite`, the `automation_*` family (`packages/session-tools-core/src/tool-defs-filtering.test.ts:17-21`). Codex's own tools do everything else.

**And the orchestration tools are Pi-only on all counts.** `subagent`, `review`, `get_subagent_result`, `steer_subagent`, `stopTask`, `workflow`, `ask_user`, `tool_search`/`tool_load` are Nessy code registered into the Pi session; `Task` and `Goal` exist only under the `projection: 'pi'` session-tool projection. On Claude, subagents run through Claude's own Agent tool with our definitions registered; on Codex, through codex's own spawn with our `[agents.*]` roles.

**Plugin peripherals do not reach Claude or Codex at all**, and the code says why rather than aspiring otherwise (`packages/shared/src/agent/runtime-agent-support.ts:96-127`): plugin LSP servers are provisioned through the Pi harness's tool surface, and plugin monitors deliver by `agent.redirect(text)` mid-turn, a Pi-only steering primitive — "neither the Claude SDK nor codex has a seam that accepts one." The capability catalog reports those rows as `unsupported-runtime` off Pi (`packages/shared/src/capabilities/resolver.ts:1988-1993`). Plugin *command* hooks do run on every runtime.

---

## 4. What of their functionality we cannot use — structural, or a switch we never flipped?

### Claude

| Not used | Verdict |
| --- | --- |
| `canUseTool` permission callback | **Used, fully, since R3 (2026-08-16).** It routes `AskUserQuestion` to the user through the shared `ElicitationAskUserBridge` (R2) and every other kind onto the same permission card the PreToolUse `prompt` branch raises and the Codex approval path uses. R2 REFUSED those, fail-closed and explicitly temporary, and that refusal was itself a live behaviour change: a user's own `ask` rule made `git push` impossible without asking, and a trusted automation's `ask` did the same. Before R2 the same two were silently auto-approved. This row previously read "Made inert by `permissionMode: 'bypassPermissions'`", which was false: ask rules, org-`ask` connector tools and interaction-required tools all reach the callback in every mode. With the bypass gone the callback is no longer shadowed at all — bypass is one of the two configurations the SDK warns about with `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. |
| The `Skill` tool | **Switch, deliberate.** Disallowed (`:1431`); skills are host-handled by read-before-execute. Consequence: the SDK `agents` option's `skills` field is also not forwarded, because it would be inert. |
| `EnterPlanMode` / `ExitPlanMode` | **Switch, deliberate.** Safe Mode is the user-controlled surface instead; handing plan mode back to the SDK is recorded REFUTED in the clean-runtime plan, not pending. |
| `AskUserQuestion` | **No longer switched off (R2, 2026-08-16).** It was listed here as "forced by missing UI" — the reason was stale, since the option cards, the `askUserQuestionTimeout` countdown and the batched multi-select envelope all existed and Pi was already using them. It now reaches the user through `canUseTool`. Still withheld from subagents, which `user-input.md` excludes and which have no surface to ask through. |
| SDK plugin loading (`plugins: []`, `:1918`) | **Switch, deliberate.** We run our own plugin adapter runtime; plugin *agents* still reach the SDK through `agents`. |
| SDK tool-search / deferred MCP loading | **Switch, never flipped.** The SDK exposes the knobs (`sdk.d.ts:1027`, `:1142`, `:1158`, `:3073`); `claude-agent.ts` sets none of them — a grep for `toolSearch`/`deferred` in that file returns nothing. SDK defaults apply and nobody has decided what they should be. |
| The network interceptor | **Structural.** It is a Node `--require` preload; the Claude path spawns a native binary (`claude-agent-sdk-darwin-arm64/claude`), which has no such hook. All wire shaping for Claude happens in the per-session loopback adapter instead. |
| A user-scope `~/.claude/settings.json` | **Switch, deliberate and documented as the point of the change** (`options.ts:206-215`): `CLAUDE_CONFIG_DIR` is per Workspace, so a user-scope settings file is no longer a cross-Workspace policy channel. Reversing it is one constant. |
| Cloud provider routing (Bedrock/Vertex/Foundry) | **Switch, deliberate and enforced.** `CLAUDE_CODE_USE_*` sit at the top precedence tier above any key we write, so the whole set is stripped from the subprocess env (`options.ts:262-269`). |
| A main-session turn cap | **Not used, by choice.** `maxTurns` is passed only for a child; the docblock at `claude-agent.ts:288-294` records that inventing a default would silently truncate long turns. |

### Codex

The config schema (`packages/codex-protocol/schema/config-schema.json`, `rust-v0.148.0`) has **94 top-level properties; we write 14.** Re-counted 2026-08-20 when the pin moved off `rust-v0.147.0`, which had 93: `goals` and `responses_api_metadata` arrived, `debug` left, and all 14 names below are still emitted by `buildCodexConfigToml`. The notable unused ones, each a switch rather than a wall:

| Key | Schema description | Why it is unused |
| --- | --- | --- |
| `instructions` | "System instructions." | **Deliberately unwritten — and NOT "the single largest unexercised lever"; P6.173 withdrew that ranking (2026-09-06).** This key is the same slot as `ThreadStartParams.baseInstructions` under another name, read from the source at the tag we ship (`codex-rs/core/src/config/mod.rs`, `rust-v0.148.0`): `let base_instructions = base_instructions.or(file_base_instructions).or(cfg.instructions.clone());`. Writing it therefore DELETES codex's own 20,751-character prompt and leaves ours — measured at 68 chars. Our guidance already reaches codex additively through `developerInstructions`, so there is nothing here to flip. |
| `developer_instructions` (top level) | "Developer instructions inserted as a `developer` role message." | Not needed at top level: the SAME text is written per session on the wire instead, as `ThreadStartParams.developerInstructions` on all three thread-creating call sites, which a config key cannot be — the wire field is re-composed per thread and the file is a snapshot taken at spawn. The per-role variant IS written, one line per role layer file (`buildCodexAgentRoles`). |
| `model_instructions_file` | overrides built-in model instructions — schema itself says users are "STRONGLY DISCOURAGED" | Not used, and the schema's own warning is a reason to keep it that way. |
| `hooks` | "Lifecycle hooks configured inline in TOML plus user-level overrides." | Never flipped. The string `hooks` does not appear anywhere in `config-writer.ts` (`grep -ac hooks` → 0, bound: that file). This is why codex has four Nessy hook events instead of the full vocabulary. |
| `skills`, `plugins`, `marketplaces` | user-level skill/plugin/marketplace entries | Never flipped; we run our own plugin and skill layers host-side. |
| `memories` | memories subsystem settings | Never flipped. |
| `compact_prompt` / `experimental_compact_prompt_file` | compaction prompt | Never flipped — so codex compacts with its own prompt while Pi compacts with ours. |
| `tools`, `orchestrator`, `tool_output_token_limit`, `include_environment_context`, `personality`, `auto_review`, `review_model`, `notify`, `profiles` | feature toggles and policy | Never evaluated. |

Structural, not a switch, on Codex:

- **Input rewriting on a codex tool call.** The approval protocol carries a decision, not an updated input (`approval-bridge.ts:585-615`). Blocking is possible; editing is not.
- **`ProcessSupervisor` wrapping of codex's shell.** The app-server is spawned directly by `CodexRuntimeManager`, so the host-side supervisor never sees its child processes (`codex-agent.ts:255-266`).
- **Hosted `web_search`** — it executes on OpenAI's backend, unreachable through the Nestor adapter, so it is disabled outright rather than left to fail (`config-writer.ts:636-638`).
- **Mid-session model switch without a fork.** `config.toml` is read only at app-server start and `turn/start` carries no config; the accepted cost is recorded rather than papered over (`codex-agent.ts:315-322`), with `thread/fork` as the supported boundary.

### Pi

Pi's "cannot use" list is about the *SDK*, not about the product:

- **The session storage format** — structural (private constructor; see §2.1).
- **When compaction fires** — structural: the SDK's `shouldCompact` is not parameterized beyond `reserveTokens`.
- **`shouldStopAfterTurn`** — structural in practice: it exists on `AgentLoopConfig` (`pi-agent-core/dist/types.d.ts:183`) but is not a public `Agent` field and `CreateAgentSessionOptions` does not expose it, so our turn budget is enforced outside the loop.
- **The other nine loop hooks are NOT out of reach** — they are public mutable fields we already assign in production. If a future need arises for `beforeToolCall`, `transformContext` or `streamFn`, the mechanism exists and has precedent; the discipline is to chain the previous value, not replace it.

---

## 5. Honest uncertainty — what nobody has verified

State these as open, not as answers.

1. **~~Codex's `instructions` / `developer_instructions` / `hooks` / `skills` / `plugins` keys have never been exercised against our bundled binary.~~ HALF CLOSED 2026-09-06 (P6.173).** The two instruction keys HAVE been driven against the bundled `codex-app-server`, and the reading decided the posture rather than merely informing it: `developerInstructions` is additive (codex's own prompt byte-unchanged at 20,751 chars, ours first in the `developer` items) and `baseInstructions` / `instructions` REPLACE it (68 chars, codex's prompt gone). **Still open, unchanged, for `hooks` / `skills` / `plugins`:** they are in the release schema, and that is not the same as knowing what our build does with them, nor what they would cost in prompt tokens or behavioural drift. Nobody has tried those three.
2. **The Claude auto-compaction fix has one measurement behind it, in one direction.** The `pY_` gate analysis and the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` fix were read out of the v2.1.218 binary and reasoned to a conclusion; the docblock states the diagnosis is not an inference, but there is no recorded live case in this record showing a gateway session compacting *after* the fix. Treat "Claude now auto-compacts on gateway models" as expected-but-unproven until a live case says otherwise. It is also version-bound: the binary is pinned, and the gate can move — and it HAS moved once already: the pin went 2.1.218 → 2.1.223 on 2026-08-20 (U1 of the cross-runtime-history-carry plan), and 2.1.223 additionally clamps sessions on an UNRECOGNIZED model id to an assumed context window (`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`, 8 occurrences in the binary) — every gateway model id is unrecognized, so whether our env pair still wins is exactly the live arm that U1's wave-boundary smoke owes.
3. **Codex compaction ordering is explicitly marked unverified in the code** (`codex-agent.ts:764-771`): whether the compaction notification lands before or after the `thread/compact/start` response, and whether a `turn/completed` follows at all. The implementation is made harmless rather than correct — a manual compaction can lose its transcript row.
4. **No end-to-end measurement of what the Codex session tool reduction costs a user.** We know 25 session tools are withheld; nobody has measured how often a real Codex session tries to reach one and what the model does when it is absent.
5. **The stale comment at `claude-agent.ts:1911`** ("file tools are disabled (use MCP)") contradicts the code two lines below it. The code is authoritative here, but the disagreement means the *intent* at some point was to substitute our file tools on Claude, and it is not recorded whether that was abandoned deliberately or simply drifted.
6. **This record is a static read.** Nothing in it was produced by running the app. The tool inventories, prompt composition and permission paths were read from source; a live per-runtime tool-roster capture (what the model is actually offered on each of the three) would be the strongest possible check and does not exist as of this snapshot. `docs/testing/cdp-live-checklist.md` is where such a case belongs.
7. **The Pi loop hooks we do not use are untested, not unavailable.** The refutation that established their reachability was reasoning plus one production precedent (`toolExecution` and `prepareNextTurnWithContext`). Whether `streamFn` or `transformContext` can be safely chained without fighting `AgentSession._installAgentToolHooks` has not been tried.

---

## 6. Maintenance note

`docs/README.md:21` currently reads "All nine files under `architecture/` are listed here. If you add one, add it" — this record is the tenth, so that sentence and the list below it must be updated in the same commit that lands this file.