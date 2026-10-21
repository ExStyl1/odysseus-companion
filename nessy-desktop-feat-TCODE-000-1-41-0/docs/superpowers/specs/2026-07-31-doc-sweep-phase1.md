# Полный проход по документации Claude Code — фаза 1

**Прогон `wf_79b6bcd5-c22`, 2026-07-31. 174 страницы из 174 прочитаны целиком** (`curl -sL <url>.md`, не через сумматор), непрочитанных нет. 18 читателей, по ~10 страниц каждый.

**Это сырьё, а не вердикт.** Ни одна находка ещё не проходила оппонирования: фаза 2 (по одному challenger'у на находку) и фаза 3 (синтез) запускаются отдельно — скрипт `claude-doc-sweep-phase23.js`. Полные записи с дословными цитатами: [`data/2026-07-31-doc-sweep-phase1.json`](data/2026-07-31-doc-sweep-phase1.json).

История этого репозитория говорит, что неоспоренная находка — слабое свидетельство. Не переносить ничего отсюда в трекер до фазы 2.

## Расклад по страницам

| Вердикт читателя | Страниц |
| --- | --- |
| `parity` — всё сходится | 8 |
| `partial` — сходится частично | 101 |
| `absent` — поверхности нет вовсе | 15 |
| `inapplicable` — нас не связывает | 50 |

Находок заведено: **245** (36 `bug`, 209 `gap`).

## Страницы, где поверхности нет вовсе

`plugin-hints`, `plugin-relevance`, `agent-sdk/observability`, `agent-view`, `agent-teams`, `monitoring-usage`, `advisor`, `artifacts`, `computer-use`, `corporate-launcher`, `desktop-ios-simulator`, `desktop-wsl`, `keybindings`, `statusline`, `voice-dictation`

## Страницы, где читатель не нашёл ни одного расхождения

`agent-sdk/permissions`, `agent-sdk/agent-loop`, `agent-sdk/cost-tracking`, `agent-sdk/streaming-output`, `agent-sdk/streaming-vs-single-mode`, `agent-sdk/todo-tracking`, `security-guidance`, `data-usage`

## Находки уровня `bug`

Дословные цитаты страниц — в JSON; здесь claim читателя и наше состояние.

| # | Страница | Документировано | У нас | Где |
| --- | --- | --- | --- | --- |
| 1 | `hooks` | Setup hooks receive a `trigger` field whose value is `init` or `maintenance`. | Our Setup emission carries `source: 'pi-runtime'` and no `trigger` at all, and it fires on every Pi session start rather than only under `--init-only` / `-p --init` / `-p --maintenance`. | packages/pi-agent-server/src/extensions/lifecycle-bridge.ts:107 |
| 2 | `hooks` | FileChanged input carries `file_path` (absolute path) and `event` (`change` \| `add` \| `unlink`). | We emit `path` (only when a path was captured) and `change_kind` set to the mutating TOOL NAME, never `file_path` or `event`. The stdin payload is the event input verbatim (`hookCommandStdinPayload` spreads `...input`), so a hook doing `jq -r .file_path` reads null. | packages/pi-agent-server/src/extensions/lifecycle-bridge.ts:228-232; packages/shared/src/automations/hook-command.ts:646 |
| 3 | `hooks` | CwdChanged input carries `old_cwd` and `new_cwd`. | We emit `cwd` and `previous_cwd`. Neither documented key is produced anywhere (`grep -ran 'old_cwd\\|new_cwd' packages apps` → 0 outside docs). | packages/pi-agent-server/src/extensions/lifecycle-bridge.ts:168-172; packages/shared/src/automations/types.ts:801-802 |
| 4 | `hooks` | StopFailure input carries `error`, and that field is what the matcher filters on. | We emit `error_code` only. The MATCHER path was fixed (`getMatchValueForSdkInput` reads `input.error_code ?? input.error` and maps it through `STOP_FAILURE_DOCUMENTED_ERROR`), but the payload a hook reads on stdin still has no `error` key, and `error_details` / `last_assistant_message` have no producer. | packages/shared/src/agent/pi-agent.ts:7299; packages/shared/src/automations/utils.ts:214-217 |
| 5 | `permissions` | `Bash(*)` is equivalent to a bare `Bash`, and as a deny rule BOTH forms remove the tool from Claude's context. | `Bash(*)` parses to `{ kind: 'bash', pattern: '*' }` — a pattern matcher, not a tool matcher. Context removal is decided by `isWholeCapabilityDeniedByPermissionDsl`, which only inspects `rule.matcher.kind === 'tool'`, so a `deny: ["Bash(*)"]` leaves the Bash tool definition in the model's context and denies every call it makes instead of hiding the tool. Same for `PowerShell(*)`. | packages/shared/src/agent/pi-harness/claude-permission-rules.ts:310; packages/shared/src/agent/pi-harness/permission-dsl.ts:900-905 |
| 6 | `permissions` | `Skill(<name pattern>)` is a supported rule format that matches by skill name. | `parseClaudeRuleString` has no `Skill` case; `Skill(deploy *)` contains no `param:` colon, so it falls through to the `default:` branch and returns an inert warning ("uses a specifier form no permission check matches; the rule is ignored"). There is no `skill` matcher kind in `CompiledMatcher`, so an imported Claude `deny: ["Skill(deploy *)"]` silently grants the skill. | packages/shared/src/agent/pi-harness/claude-permission-rules.ts:378-381; packages/shared/src/agent/pi-harness/permission-dsl.ts:76-87 (matcher kinds) |
| 7 | `tools-reference` | The canonical tool name is `TaskStop`; permission rules and hook matchers match the canonical name only, and the transcript label `Stop Task` does not match. | The binding spells it `stopTask` on every permission-visible axis — `binding('stop_task', 'stop_task', 'stopTask', 'stopTask')` gives semanticId `stop_task`, permissionName/bindingName `stopTask`. `PERMISSION_RULE_TOOL_NAMES` is derived from permissionName+descriptorId, so `TaskStop` is not a known tool: an imported `deny: ["TaskStop"]` matches nothing AND raises the unknown-tool typo warning. A `taskstop` alias exists only for SUBAGENT tool lists (`runtime-agent-definition.ts:95`), not for permission rules or hook matchers. | packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts:262 and :351 (PERMISSION_RULE_TOOL_NAMES); packages/shared/src/agent/pi-harness/runtime-agent-definition.ts:94-95 |
| 8 | `settings` | The sandbox write/deny path keys are nested under `sandbox.filesystem` and named `allowWrite`, `denyWrite`, `denyRead`, `allowRead`. | `SANDBOX_FILESYSTEM_KEYS` is `['disabled','allowRead','allowManagedReadPathsOnly']` and the equivalents live flat at the top level under different names (`additionalWritableRoots`, `deniedWriteRoots`, `deniedReadRoots`). `filesystemSection` THROWS `invalid sandbox filesystem setting: allowWrite` on any other nested key, so a settings file written exactly as the doc shows is rejected whole at user/project/local scope. | packages/shared/src/config/sandbox-settings.ts:183 and :267 |
| 9 | `settings` | Sandbox filesystem paths accept `~/`-relative and `./`-or-bare project-relative prefixes, not only absolute paths. | `filesystemRoots` rejects any non-absolute entry with `sandbox-<key>-not-absolute`, so the doc's own examples `~/.kube`, `./output` and `.` are refused. | packages/shared/src/config/sandbox-settings.ts:312 |
| 10 | `settings` | `strictKnownMarketplaces` accepts eight source types: `github`, `git`, `url`, `npm`, `file`, `directory`, `hostPattern`, `pathPattern`. | `parseManagedMarketplaceEntry` handles only `github`, `url`, `hostPattern`, `pathPattern`; every other kind hits `default` and returns `managed marketplace allowlist entry declares an unsupported source`. An administrator writing the documented `{ "source": "git", "url": "https://gitlab.example.com/tools/plugins.git" }` has the entry stripped, so that marketplace can never be allowlisted in its documented form. | packages/shared/src/agent/pi-harness/managed-marketplace-entries.ts:167-207 |
| 11 | `agent-sdk/mcp` | `"streamable-http"` is accepted as an alias for `"http"` in `.mcp.json` and other JSON config files. | `parseProjectMcpServer` branches on `type === 'http' \|\| type === 'sse'`, then `'ws'`, then `undefined\|'stdio'`, and returns `null` for anything else — the caller logs `Ignoring .mcp.json server "<name>": unsupported MCP server config` and drops it. The Claude plugin adapter has the same closed set. The alias exists only inside the vendored Pi/session-MCP bundles under `apps/electron/dist`, never in our own parser. | packages/shared/src/mcp/project-config.ts:119-177; packages/shared/src/plugins/format-adapters/claude.ts:1034 |
| 12 | `mcp` | `"streamable-http"` is a valid value of the `type` field wherever MCP servers are configured in JSON. | Our `.mcp.json` parser and the Claude plugin adapter both accept only `stdio\|http\|sse\|ws`; an entry copied verbatim from an MCP server's own documentation is dropped with `unsupported MCP server config`. | packages/shared/src/mcp/project-config.ts:119; packages/shared/src/plugins/format-adapters/claude.ts:1034 |
| 13 | `skills` | Dynamic context uses an inline `` !`<command>` `` placeholder that may appear anywhere in the body, whose output replaces the placeholder in place, with a ` ```! ` fenced block for multi-line commands. | `runtimeSkillContextCommand` recognises a different syntax: a bare `!command` that must be the FIRST non-empty top-level body line, backticks not part of the form, fenced blocks skipped as prose, and a second `!` line throwing `runtime-skill-context-command-ambiguous`. Output is appended (`outputs.join('\n\n')`) rather than substituted at the placeholder. The docs' own example skill (`- PR diff: !`gh pr diff``, three placeholders inside list items) yields zero substitutions here; a skill whose first line IS `` !`git diff HEAD` `` passes the backticks through to the Bash permission evaluator as part of the command string. | packages/shared/src/capabilities/runtime-skill-context.ts:32 |
| 14 | `agent-sdk/typescript` | The result message carries terminal_reason naming why the loop ended, across a 19-value vocabulary. | The Claude result adapter never reads msg.terminal_reason. It derives the reason from stop_reason==='refusal', then from subtype via a 4-entry table, with everything unrecognized collapsing to 'provider_error'. A run ending subtype:'error_during_execution' with terminal_reason:'prompt_too_long' (or hook_stopped, stop_hook_prevented, aborted_tools, blocking_limit, rapid_refill_breaker, image_error, model_error) is reported to the user as an undifferentiated provider error even though the SDK put the specific cause on the same message. The installed SDK 0.3.183 does declare the field (`terminal_reason?: TerminalReason`, 12 values). | packages/shared/src/agent/backend/claude/event-adapter.ts:581-585 and the 4-entry table at :50-57; field confirmed present in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts |
| 15 | `network-config` | `NO_PROXY` accepts a space-separated list as well as a comma-separated one. | Both NO_PROXY parsers split on commas only. `parseNoProxyRules` calls `splitCommaSeparated` (`str.split(',')`), and the Pi interceptor does `NO_PROXY.split(',')`. `NO_PROXY="localhost 192.168.1.1 example.com .example.com"` therefore yields one rule whose host is the whole string, which matches no hostname — every request goes through the proxy with no error or warning, the opposite of what the operator configured. | packages/shared/src/config/network-proxy-utils.ts:11-13 (via :221 `splitCommaSeparated(noProxy)`) and packages/shared/src/unified-network-interceptor.ts:84-86 |
| 16 | `memory` | `@path` imports are recognised anywhere in a CLAUDE.md line, not only when the line begins with `@`. | `parseMemoryImportPath` returns null unless the TRIMMED LINE ITSELF starts with `@`. Both of the page's own examples — `See @README for project overview and @package.json ...` and `- git workflow @docs/git-instructions.md` — are silently not imported. Only a whole-line `@path` (the shape our own CLAUDE.md uses) works. | packages/shared/src/agent/memory/memory-store.ts:49-64 (`if (!trimmed.startsWith('@') \|\| trimmed.startsWith('@@')) return null;`) |
| 17 | `amazon-bedrock` | CLAUDE_CODE_USE_MANTLE (with ANTHROPIC_BEDROCK_MANTLE_BASE_URL and CLAUDE_CODE_SKIP_MANTLE_AUTH) routes Claude Code requests to an Amazon Bedrock endpoint, in addition to the older CLAUDE_CODE_USE_BEDROCK path. | buildClaudeSubprocessEnv inherits the whole ambient `process.env` and then deletes exactly three Bedrock vars — CLAUDE_CODE_USE_BEDROCK, AWS_BEARER_TOKEN_BEDROCK, ANTHROPIC_BEDROCK_BASE_URL — under the stated invariant 'Bedrock must never be routed through the Claude SDK path'. CLAUDE_CODE_USE_MANTLE, ANTHROPIC_BEDROCK_MANTLE_BASE_URL and CLAUDE_CODE_SKIP_MANTLE_AUTH are absent from our entire source tree, so they survive into the subprocess and defeat that invariant. | packages/shared/src/agent/options.ts:239 (env spread from process.env), :257-262 (three-var strip list) |
| 18 | `authentication` | Cloud provider credentials outrank every other credential whenever CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX or CLAUDE_CODE_USE_FOUNDRY is set. | The Claude SDK subprocess env is built by spreading the host's whole process.env and deleting only the Bedrock trio. CLAUDE_CODE_USE_VERTEX and CLAUDE_CODE_USE_FOUNDRY are not stripped and appear nowhere in our source, so an ambient value in the user's shell silently outranks the credential the session's LlmConnection configured, on the highest precedence tier the doc defines. | packages/shared/src/agent/options.ts:239, :260-262 |
| 19 | `changelog` | `DirectoryAdded` is a hook event, fired when `/add-dir` or the SDK `register_repo_root` control request adds a working directory mid-session. | Absent everywhere. `grep -ran -e 'DirectoryAdded' packages apps` → 0 hits. It is missing from `PluginHookEventName` (packages/shared/src/plugins/hooks-runtime.ts:25-54), from `CLAUDE_HOOK_EVENT_MAP` (packages/shared/src/plugins/format-adapters.ts:122), and from `DEFERRED_EXTERNAL_HOOK_EVENT_REASONS` (:99) — so an imported Claude plugin declaring it is reported as an unknown event (a typo) rather than as a deferral. The adapter's own comment ("28 of the 30 documented Claude hook events") is now a stale count. This is the exact renamed/new-event failure mode AGENTS.md flags. | /Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/plugins/format-adapters.ts:122 |
| 20 | `channels` | A channel event pushed while the user is away reaches the session and Claude reacts to it; several events arriving during a busy turn are delivered together on the next turn. | An event arriving while the session is IDLE is silently discarded. `packages/server-core/src/sessions/SessionManager.ts:2436` subscribes with `({ text }) => { ...; canDeliver()?.redirect(text) }`, and `canDeliver()` at `:2399-2405` returns `undefined` unless `managed.isProcessing && agent.isProcessing?.()`. There is no queue and no idle wake for this path: the R3 grouping/idle-wake delivery that DOES cite this contract (`packages/server-core/src/sessions/task-notification.ts:46-51`, "delivered together on the next turn ... one delivery, in arrival order") is wired to monitor events only, never to `subscribeChannel`. Events during a busy turn are also not grouped — each is steered in immediately. | /Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/server-core/src/sessions/SessionManager.ts:2436 |
| 21 | `channels-reference` | The channel notification method is `notifications/claude/channel`, and its params are `content` (string) and optional `meta` (Record<string,string>). | Both the method and the payload field are different. `packages/shared/src/mcp/client.ts:112-114` registers `NotificationSchema.extend({ method: z.literal('claude/channel') })` — no `notifications/` prefix — and the handler at `:357-361` reads `(notification.params as { text?: unknown }).text`, ignoring `content` and `meta` entirely. `grep -ran 'notifications/claude' --exclude-dir=node_modules .` returns zero hits repo-wide, so a conforming channel server's notifications match no handler and are dropped silently. This is the same rename class as the `input.lsp`/`lspServers` bug AGENTS.md records. | /Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/mcp/client.ts:113 |
| 22 | `channels-reference` | The event reaches the model wrapped in a `<channel>` tag whose `source` attribute is the server's name, with each `meta` key as a further attribute. | No wrapping at all. The pool does carry the server slug (`packages/shared/src/mcp/client.ts:102-105`, `McpChannelMessage { server, text }`), but the consumer throws it away: `packages/server-core/src/sessions/SessionManager.ts:2436` destructures `({ text })` and calls `canDeliver()?.redirect(text)`, which reaches `PiAgent.redirect` (`packages/shared/src/agent/pi-agent.ts:7086-7095`) and is sent verbatim as a `steer` message. The model cannot tell which channel an event came from, and there is no attribute channel for routing keys like `chat_id` — which makes the documented two-way reply pattern ("passing the chat_id from the tag") unimplementable against us. | /Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/server-core/src/sessions/SessionManager.ts:2436 |
| 23 | `chrome` | In plan mode, read-only browser calls run without a prompt and state-changing browser calls (clicks, typing, navigation, tab/window management, GIF recording) prompt for approval. | Every browser command is auto-allowed in plan mode with no inspection of what it does. `packages/shared/src/agent/mode-manager.ts:2207-2210` — inside the branch commented "Safe/Plan mode: check against read-only allowlist" — reads `if (isBrowserToolNameOrAlias(toolName)) { return { allowed: true } }`, and `plan` reaches it because `isInteractiveWritePermissionMode` (packages/shared/src/agent/mode-types.ts:98-100) covers only `default`/`acceptEdits`/`auto`. Our browser tool is a single command-string tool (`BrowserToolSchema`, packages/session-tools-core/src/tool-defs.ts:359-364), so `click`, `type`, `navigate` and `evaluate` all arrive under the same tool name and all auto-run. `packages/shared/src/agent/__tests__/browser-tools-permissions.test.ts:21` pins the current behaviour ("allows browser_tool in safe mode") without any command-level split. Claude fixed the equivalent bug in 2.1.199 ("Fixed plan mode not prompting for state-changing browser tool calls"). | /Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/mode-manager.ts:2208 |
| 24 | `claude-directory` | When a skill and a single-file command share a bare name, the skill wins. | Inverted: `selectSkillSlashCommands` treats the explicit command names as `takenNames` and drops the skill from the `/` menu, so `commands/review.md` shadows a `review` skill. The module comment states the opposite rule deliberately ("Explicit commands are authored for this purpose and are the more specific declaration"). | packages/shared/src/slash-commands/custom-commands.ts:444 — `if (taken.has(skill.logicalName)) continue;`, called from packages/server-core/src/sessions/SessionManager.ts:16119 with `nativeCommands.map(command => command.name)` |
| 25 | `deep-links` | The handler accepts exactly one path (`open`), and a deep link can only choose a directory and pre-fill the prompt box — nothing is sent or executed until the user presses Enter. | `nessy://action/new-session?input=…&send=true` sends the prompt straight to the model with no user confirmation — `const shouldSend = parsed.params.send === 'true'` then `window.electronAPI.sendMessage(session.id, parsed.params.input!, …)`. The scheme is registered OS-wide via `app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)` (`apps/electron/src/main/index.ts:197`), and the same handler also routes `delete-session/{id}`, `flag-session/{id}`, `rename-session` and `oauth` (`apps/electron/src/main/deep-link.ts:22-24`), so a link on any web page reaches them. There is no external-origin gate and no `Prompt from an external link` warning line. | apps/electron/src/renderer/contexts/NavigationContext.tsx:754 |
| 26 | `fast-mode` | Fast mode applies to Opus 5 and Opus 4.8; Opus 4.7 is no longer served at fast speed and the API rejects fast-mode requests for it. | `shouldEnableFastMode` matches the single literal `claude-opus-4-7` and nothing else, so it targets only the removed model and never fires for Opus 4.8 (which IS in our catalogue, models-pi.ts:92) or Opus 5. When FEATURE_FLAGS.fastMode is turned on, every request it modifies sets `body.speed='fast'` plus the `fast-mode-2026-02-01` beta header on a model the API now rejects, while the two supported models get no speedup at all. | packages/shared/src/unified-network-interceptor.ts:496-498 (and :319, :991-999); packages/shared/src/feature-flags.ts:182; packages/shared/src/config/models-pi.ts:92 |
| 27 | `features-overview` | When a skill of the same name exists at more than one level, the USER-scope definition wins over the project-scope one (managed > user > project). | Skill collisions are resolved by `scopeSpecificity`, which ranks project(3) > workspace(2) > global(1) > builtin(0) for every non-MCP capability kind including skills — the inverse of the documented skill order for the user-vs-project pair. A repo checking in `.nessy-agent/skills/deploy` silently shadows the user's own `deploy` skill; on Claude it would not. The surrounding comment cites mcp.md for the MCP arm only, so the skill arm appears unexamined. | packages/shared/src/capabilities/resolver.ts:863-869 and :2013-2044 |
| 28 | `glossary` | Trusting your home directory must be session-scoped and re-prompt on every launch; in our fork a home-directory grant persists to disk like any other project. | `ProjectTrustStore.record`/`resolve` persist any grant whose identity `persistence` is `'stable'`; `persistence` is decided purely by whether the platform can stat the root, with no home-directory carve-out anywhere in `projects/` or `capabilities/`. | packages/shared/src/capabilities/project-trust-store.ts:114-125 (`resolve` returns a persisted `'stable'` decision), :135-157 (`record`); packages/shared/src/projects/project-identity.ts:112-132 (`process-only` only on stat failure); `grep -rain "homedir\\|process.env.HOME" packages/shared/src/projects packages/shared/src/capabilities` returns nothing |
| 29 | `headless` | A SIGTERM'd non-interactive run must exit 143; ours exits 130 for both SIGINT and SIGTERM, so a supervisor cannot tell an operator interrupt from a shutdown signal. | One `onSignal` handler is registered for both `SIGINT` and `SIGTERM` and ends in `process.exit(130)`. | apps/cli/src/index.ts:796-804 (`process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)` with `process.exit(130)` at :801) |
| 30 | `large-codebases` | We enable git's `extensions.worktreeConfig` by running `sparse-checkout set` in a linked worktree but never unset it when the last worktree is removed, leaving the main checkout in the state the doc says causes go-git tools to fail. | The lease `remove` handler runs exactly one command, `git -C <root> worktree remove <path>`; there is no `git config --unset extensions.worktreeConfig`, no ownership marker recording that we added it, and no last-worktree bookkeeping. `worktree-settings.ts` documents the side effect but nothing acts on it. | packages/server-core/src/sessions/SessionManager.ts:10210-10213 (the whole `remove` handler); packages/server-core/src/pi-harness/worktree-git-plan.ts:85-95 (`sparse-checkout set --cone` is what enables it); packages/shared/src/config/worktree-settings.ts:38-44 (the side effect, noted only); `grep -ran "worktreeConfig" packages apps` matches that comment alone |
| 31 | `llm-gateway-protocol` | The gateway model-list request must not follow redirects; a redirect is a failure specifically so the credential is not forwarded to the redirect target. | Both model-list fetches use bare `fetch(url, { headers })` with no `redirect` option, so the WHATWG default `"follow"` applies. The Nessy Gateway fetch carries the user's JWT in the custom header `Nestor-Token`, and the fetch spec strips only `Authorization`/`Cookie`/`Proxy-Authorization` across an origin change — a custom header rides the redirect intact. The Anthropic-format fetch has the same shape with `x-api-key`. A gateway (or a captive proxy in front of one) that answers `/v1/models` with a 30x hands the credential to whatever host it names. | packages/server-core/src/model-fetchers/nestor.ts:41-42 (`await fetch(NESTOR_MODELS_URL, { headers: { 'Nestor-Token': credentials.apiKey ?? '' } })`); packages/shared/src/agent/backend/internal/drivers/anthropic.ts:50 (`await fetch(`${baseUrl}/v1/models?${params}`, { headers })`) |
| 32 | `llm-gateway-protocol` | Discovery keeps every entry whose `id` begins with `claude` **or** `anthropic`. | Our Anthropic-format discovery filter is `m.id.startsWith('claude-')` only — no `anthropic` branch, and it additionally requires the hyphen. The two dominant LLM-gateway products namespace Anthropic models as `anthropic/claude-sonnet-4-6` (LiteLLM, OpenRouter) or `anthropic.claude-sonnet-4-6-v1:0` (Bedrock-proxying gateways); every such id is dropped, so the picker comes back empty against a gateway whose model list Claude Code would populate. Path ships only in `NESSY_FEATURE_PROVIDER_CLAUDE=1` builds. | packages/shared/src/agent/backend/internal/drivers/anthropic.ts:76 |
| 33 | `whats-new/2026-w14` | Hook output above 50K is written to disk and replaced with a path plus a preview, rather than being injected into context or dropped. | We buffer hook stdout+stderr to a hard 8,192-byte ceiling and silently discard the remainder (a `truncated: true` flag is set on the result but no content is preserved and nothing is written to disk). Because `getHookCommandPreToolDecision` JSON-parses that same truncated stdout, a hook that emits a decision object larger than 8 KiB has its JSON cut mid-object and its decision is lost entirely — a fail-open on any hook with a verbose payload. | packages/shared/src/automations/hook-command.ts:26 (`const OUTPUT_LIMIT = 8_192;`) with the truncating appender at :215-221 |
| 34 | `whats-new/2026-w16` | A `PreCompact` hook can stop a compaction, either by exiting 2 or by returning a top-level `decision: "block"`. | PreCompact cannot block anything, and the two halves of our own contract disagree. `hook-decision-contract.ts` lists PreCompact in `TOP_LEVEL_BLOCK_EVENTS`, so its parsed output is allowed to carry `block`/`deny` + `reason` — but the frozen event table declares it `kind: 'observational'`, and its single emission site awaits `options.emit('PreCompact', …)` whose signature returns `Promise<void> \| void`, so any decision the parser produced is discarded before compaction proceeds. A hook author writing the documented blocker sees it accepted and parsed, and the context is compacted anyway. | packages/shared/src/automations/types.ts:83 (`kind: 'observational'`) vs packages/shared/src/automations/hook-decision-contract.ts:49 (PreCompact in TOP_LEVEL_BLOCK_EVENTS); emission at packages/pi-agent-server/src/extensions/lifecycle-bridge.ts:151 with the void-returning `emit` declared at :28 |
| 35 | `whats-new/2026-w20` | The Agent tool's `subagent_type` resolves case-insensitively AND separator-insensitively, so "Code Reviewer" reaches the agent named code-reviewer. | `resolveAgentDefinition` normalises with `normalizeName` = `name.trim().toLowerCase()` only. No separator folding: spaces and underscores are not collapsed to hyphens, so "Code Reviewer" normalises to "code reviewer", misses both the name match and the author-declared alias list, and throws `Unknown agent "Code Reviewer"`. This is the same class as the Task→Agent rename that broke every turn. | packages/shared/src/agents/definitions.ts:281 (normalizeName) and :718-:727 (resolveAgentDefinition) |
| 36 | `whats-new/2026-w22` | Fast mode's default model moved to Opus 4.8; Opus 4.7 and 4.6 keep the old price and Opus 4.6 fast mode is deprecated. | `shouldEnableFastMode` returns true for exactly one literal — `model === 'claude-opus-4-7'`. A session on `claude-opus-4-8` (which IS in our model table and IS the current default upstream) never gets the fast-mode beta header, so the fast toggle is silently inert on the model fast mode now defaults to. Stale pin, not a policy decision — the comment still reads "Only activates for Opus 4.7". | packages/shared/src/unified-network-interceptor.ts:496-:499 |

## Находки уровня `gap`

209 штук, по страницам:

| Страница | Находок |
| --- | --- |
| `hooks` | 7 |
| `sub-agents` | 7 |
| `whats-new/2026-w29` | 7 |
| `admin-setup` | 6 |
| `settings` | 5 |
| `sandboxing` | 5 |
| `skills` | 5 |
| `memory` | 5 |
| `auto-mode-config` | 5 |
| `desktop` | 5 |
| `permissions` | 4 |
| `best-practices` | 4 |
| `changelog` | 4 |
| `claude-directory` | 4 |
| `headless` | 4 |
| `mcp` | 3 |
| `plugins-reference` | 3 |
| `agent-sdk/subagents` | 3 |
| `agent-sdk/typescript` | 3 |
| `model-config` | 3 |
| `env-vars` | 3 |
| `errors` | 3 |
| `interactive-mode` | 3 |
| `llm-gateway-connect` | 3 |
| `output-styles` | 3 |
| `scheduled-tasks` | 3 |
| `setup` | 3 |
| `whats-new/2026-w14` | 3 |
| `whats-new/2026-w28` | 3 |
| `whats-new/index` | 3 |
| `sandbox-environments` | 2 |
| `mcp-quickstart` | 2 |
| `discover-plugins` | 2 |
| `plugin-dependencies` | 2 |
| `plugin-marketplaces` | 2 |
| `agent-sdk/claude-code-features` | 2 |
| `agent-sdk/slash-commands` | 2 |
| `workflows` | 2 |
| `worktrees` | 2 |
| `accessibility` | 2 |
| `code-review` | 2 |
| `corporate-launcher` | 2 |
| `debug-your-config` | 2 |
| `desktop-scheduled-tasks` | 2 |
| `goal` | 2 |
| `prompt-caching` | 2 |
| `statusline` | 2 |
| `troubleshooting` | 2 |
| `whats-new/2026-w19` | 2 |
| `whats-new/2026-w22` | 2 |
| `whats-new/2026-w26` | 2 |
| `whats-new/2026-w27` | 2 |
| `agent-sdk/hooks` | 1 |
| `hooks-guide` | 1 |
| `permission-modes` | 1 |
| `agent-sdk/custom-tools` | 1 |
| `agent-sdk/mcp` | 1 |
| `managed-mcp` | 1 |
| `plugin-hints` | 1 |
| `plugins` | 1 |
| `agent-sdk/skills` | 1 |
| `agent-sdk/file-checkpointing` | 1 |
| `agent-sdk/hosting` | 1 |
| `agent-sdk/modifying-system-prompts` | 1 |
| `agent-sdk/observability` | 1 |
| `agent-sdk/python` | 1 |
| `agent-sdk/session-storage` | 1 |
| `agent-sdk/sessions` | 1 |
| `agent-sdk/structured-outputs` | 1 |
| `agent-sdk/user-input` | 1 |
| `sessions` | 1 |
| `how-claude-code-works` | 1 |
| `context-window` | 1 |
| `authentication` | 1 |
| `champion-kit` | 1 |
| `channels-reference` | 1 |
| `checkpointing` | 1 |
| `claude-apps-gateway` | 1 |
| `cloud-environments` | 1 |
| `commands` | 1 |
| `deep-links` | 1 |
| `features-overview` | 1 |
| `glossary` | 1 |
| `keybindings` | 1 |
| `large-codebases` | 1 |
| `llm-gateway` | 1 |
| `remote-control` | 1 |
| `third-party-integrations` | 1 |
| `troubleshoot-install` | 1 |
| `whats-new/2026-w13` | 1 |
| `whats-new/2026-w15` | 1 |
| `whats-new/2026-w20` | 1 |
| `whats-new/2026-w23` | 1 |
| `whats-new/2026-w24` | 1 |
| `whats-new/2026-w25` | 1 |

## Как поднять фазы 2 и 3

```
Workflow({scriptPath: ".../claude-doc-sweep-phase23.js"})
```

Скрипт несёт находки в себе — он не зависит ни от кеша прогона, ни от этой сессии.
