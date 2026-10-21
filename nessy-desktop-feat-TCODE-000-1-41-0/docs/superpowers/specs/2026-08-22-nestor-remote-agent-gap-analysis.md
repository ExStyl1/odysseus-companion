# Nestor remote agent (`nessy_cloud`) — gap analysis vs fresh backend and nessy-acp-agent

Date: 2026-08-22. Analysis only — no code changed.

## Provenance

- Sources pulled to `.references/` (shallow, `master`, history deepened to ~80 commits):
  - `gitlab.tcsbank.ru/nestor/code-completion` @ `df526b7` -> `.references/nestor-code-completion` (backend: `service/nestor`, Go; A2A core: `pkg/agentcore`)
  - `gitlab.tcsbank.ru/nestor/assistant` @ `cfb01c8` -> `.references/nestor-assistant` (reference connector: `nessy-acp-agent`; docs source: `docs/nessy-cloud/` — the Pages site is auth-gated, the clone is not)
- Our side: `packages/shared/src/agent/nestor-cloud-agent.ts` + `packages/shared/src/agent/backend/nestor-cloud/`, `packages/server-core/src/domain/connection-setup-logic.ts`, `packages/server-core/src/model-fetchers/nestor.ts`.
- Method: Workflow `nestor-remote-agent-analysis` (run `wf_3709c318-b9e`), 11 Opus 5 agents: 4 parallel source readers -> 1 synthesis -> 6 adversarial verifiers (default-refute, positive controls on absence claims, `grep -a`). 25 non-info findings verified: 22 confirmed, 2 adjusted, 1 refuted; info findings not verified by design.
- Blockers F1/F2/F4 additionally spot-checked by hand against `tool-schema.ts` and the backend `codeagent/tools.go`.

## Verification corrections (read before acting on the findings)

- **F21 consequence refuted**: the seam drop of `alwaysAllow` in `tool-executor.ts:297-311` is real, but `SessionManager.respondToPermission` enforces alwaysAllow one layer up, so users are NOT re-prompted today. Treat as a latent seam inconsistency, not a UX bug.
- **F24 magnitude corrected**: the request-size limit is not the 1 MB envDefault — every helm values file sets `request_limit_size: "500000"` (500 KB), which makes unbounded first-message metadata riskier than claimed.
- **F25 refuted**: we DO read the OS trust store by default (`network-proxy-utils.ts:47` `DEFAULT_CERT_STORE_SOURCES = ['bundled','system']`, composed into a global undici dispatcher governing `globalThis.fetch`). No system-CA gap.

---

# Gap analysis — nessy-desktop ↔ Nestor A2A code agent

**Verdict: yes, our integration needs changes — five of them are blockers that make shipped features fail on every call.** The tool-argument contract in `packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts` was written against *our own* (Claude/Pi) tool vocabulary, not against Nestor's `codeagent/tools.go`. Three of the nine tools the remote agent can emit are rejected by our own validator before they ever run, MCP tool calls are rejected 100 % of the time, and the two "terminal" tools are auto-answered by us with their own text so the user never sees the question.

None of this is recent backend drift — `regex`, `diff`, `file_pattern`, `followup` predate the shallow-clone boundary (`git log -S` on `service/nestor/internal/usecase/vibe/agent/codeagent/tools.go` bottoms out at `fc48ede`, 2026-07-22). It is a contract that was never checked against the backend, and our test fixtures bake in the wrong shape, so CI is green on an invented protocol.

## Path shorthand (all citations are absolute-expandable)

| Tag | Root |
| --- | --- |
| **BACKEND** | `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/nestor-code-completion/service/nestor` |
| **AGENTCORE** | `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/nestor-code-completion/pkg/agentcore` |
| **CONNECTOR** | `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/nestor-assistant/nessy-acp-agent` |
| **DOCS** | `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/nestor-assistant/docs/nessy-cloud` |
| **OURS** | `/Users/i.i.gavrikov/Desktop/work/nessy-desktop` |

## Verification note (one correction to Report 1)

Report 1 §3.2 states that a metadata parse error other than `ErrExtensionNotFound` "aborts". It does not abort the request: `createCodeAgentSpec` routes every extension error through `logErr`, which only logs (`BACKEND/internal/usecase/vibe/usecase_nessy_execution.go:185-221`). A malformed extension is therefore *silently dropped*, not fatal. This downgrades the `workspace_tabs` shape mismatch (F10) from latent-blocker to latent-nice. Everything else I re-checked in Reports 1–3 held exactly.

---

## A. BREAKING / DRIFT

The tool round trip is where our client and the live backend disagree. The backend's client-tool schemas are `Strict: true`, so the model emits exactly the declared keys; our `validateBuiltinArgs` throws on any key it does not list (`OURS/packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:210-213`), and the throw is converted into an error tool-result (`.../tool-executor.ts:182-186`).

**F1 — `search_files` (blocker).** Backend declares `path` + `regex` (required) + `file_pattern`; we allow only `pattern` + `path`. Every search call returns `Invalid Nestor tool arguments: Unknown Nestor tool argument: regex`.

**F2 — `replace_in_file` (blocker).** Backend declares `path` + `diff` (SEARCH/REPLACE block text, required); we require `old_string`/`new_string`. Every targeted edit fails. Worse, the backend wraps returned tool errors with an instruction that explicitly forbids the model from working around the failure with `execute_command` (`BACKEND/internal/usecase/vibe/mapping/tool_result.go:32-40`), so the model has no recovery path and the session degrades to full-file `write_to_file` rewrites at best.

**F3 — MCP tool names (blocker).** We advertise MCP tools to the backend under our proxy convention `mcp__<slug>__<tool>` (`OURS/packages/shared/src/mcp/mcp-pool.ts:663`, surfaced verbatim into `metadata.mcp[].name` by `.../mcp-metadata.ts:23-27`), but our inbound parser only accepts `<server>|<tool>` or `use_mcp_tool` (`tool-schema.ts:48-49`, `:111-125`). The backend echoes the advertised name back unchanged, so **every** MCP tool call the cloud agent makes lands in `kind: 'unknown'` → `Unsupported Nestor tool`. The connector is self-consistent here: it advertises `${server}|${tool.name}` (`CONNECTOR/src/metadata/mcp/provider.ts:11-16`) and detects the same separator.

**F4 — `activate_skill` (blocker).** Flag `a2a_skills_enabled` flipped to ENABLE on 2026-07-29 (`fe96908`), and the tool is appended unconditionally when the flag is on — independent of whether the client sent any skills (`BACKEND/internal/usecase/vibe/agent/codeagent/agent.go:80-82`). It is absent from our vocabulary, so the call errors out.

**F5 — terminal tools are auto-answered (blocker).** `ask_followup_question` and `plan_mode_respond` map to `return_text`, which returns the *model's own text* as the tool result (`OURS/packages/shared/src/agent/local-tools/runtime.ts:94-95`). `turn.ts:157-176` filters the only event those tools produce and then pushes the echo into `pendingToolResults`, so the turn continues immediately. Net effect: the user never sees the question, and the model receives its own question as the answer. The connector implements the correct contract — the result is deferred and the *next user prompt* becomes the `tool_result` (`CONNECTOR/src/core/turn.ts:340-357`).

The remaining A findings (F6–F11) cover `followup` rejection, the lost `text_complete` flush on the retryable-error path, `/clear` not resetting the remote context, the discarded 429 body, the `workspace_tabs` shape, and unconstrained mode ids.

## B. NEW BACKEND CAPABILITY

The backend's a2a **v1.0** surface (`/api/v2/code-agent/a2a`) is live and is a different wire (`TASK_STATE_*` strings, oneof-keyed stream events with no `kind` discriminator). We are pinned to the 0.3 compat endpoint by a hard-coded URL and hold **no protocol-version constant at all** — we require `card.protocolVersion` to be present and never compare it. That is a silent-migration trap (F14). Beyond that: skills metadata is never populated (F12), server-tool activity events are dropped (F13), `GET /api/v1/quota` is unused (F15).

## C. CONNECTOR PARITY

`nessy-acp-agent` is materially more robust on four axes worth porting: a real rate-limit retry manager (10 × 5 s→60 s for `-32029`/429), terminal-task recovery (re-send without `taskId` when the backend says the task is terminal — without it a session whose stream dropped before the final status update is permanently bricked), a cancel that is not passed the already-aborted signal, and persisted "always allow" decisions.

## D. DOCS OBLIGATIONS

The docs corpus is thin as a protocol source (Report 4 §6 is right: no method names, no task lifecycle, no header names). Two real obligations: the documented `A2AAuthorizationTokens.llmProxyKey` (backend binds `X-LLM-Proxy-Key`) which we cannot supply, and the documented `{retry:{}}` continuation primitive we do not implement.

## E. NON-ISSUES

Task-state vocabulary, the metadata-on-first-message-only pattern, our un-stamped `data_type` envelopes, the extra `workspace_root` field, `recursive` arriving as a string, and `content: ''` on error results are all correct as-is — details in the findings.

---

## Recommended order of work

1. **Rebuild the tool contract from `BACKEND/internal/usecase/vibe/agent/codeagent/tools.go`** — F1, F2, F4, F6, plus a `diff` (SEARCH/REPLACE) applier and a fixture generated from that file so the mismatch cannot silently return.
2. **Fix the MCP name round trip** (F3) — either advertise `server|tool` (connector-compatible) or accept `mcp__…__…` inbound; advertise-and-accept must be one decision in one place.
3. **Implement terminal-tool suspension** (F5) — defer the result, surface the question, send the next user prompt as the `tool_result`.
4. **Turn-end correctness** — flush on stream end not on `final === true` (F7), reset the sidecar on `/clear` (F8), fire `tasks/cancel` off the aborted signal (F20), recover from a stale terminal `taskId` (F19).
5. **Rate-limit survival** (F9, F18, F26/F27) — retry `-32029`/429 with backoff and surface the backend's quota text.
6. **Then** consider the v1.0 endpoint (F14) and the passive capabilities (F12, F13, F15).


---

## Findings (full, with verdicts)

> **Outcomes annotated 2026-08-22.** Each finding below carries an `**Outcome**` line recording what the
> plan `docs/superpowers/plans/2026-08-22-nestor-cloud-contract-fix.md` did with it — shipped in 1.32.0 (with the
> task that shipped it), parked, superseded by the `/api/v2` migration, or refuted here and left alone. The findings
> themselves are unedited: where implementation disagreed with a recommendation, the Outcome line says so.

### F1 [blocker] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T3 rebuilt the schema to `path`+`regex` (required) + `file_pattern`, T5 routes it onto the existing `grep` op (`regex`->pattern, `file_pattern`->glob); the old `search_files` op passed `--fixed-strings` and had no glob, so a backend regex matched nothing even after the keys were accepted.

**Claim.** Our strict argument validator rejects the backend's real `search_files` schema, so every search the remote agent attempts fails before it runs.

**Evidence.**
Backend declares `path` + `regex` (both required) + optional `file_pattern`: BACKEND/internal/usecase/vibe/agent/codeagent/tools.go:263 (name), :277 (`regex`), :281 (`file_pattern`), :287 (`"required": []string{"path", "regex"}`), with `Strict: true`. Ours allows only `pattern` and `path`: OURS/packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:179-186 (`strictKeys(args, ['pattern','path'])`, `pattern: stringValue(args.pattern,'pattern')`); the extra-key throw is at :210-213 and is converted to an error tool-result at .../tool-executor.ts:182-186. Our own fixture encodes the wrong shape: OURS/packages/shared/src/agent/backend/nestor-cloud/__tests__/fixtures/provider-adapter-parity.json:6 (`"args": {"pattern": "x", ...}`). Not recent drift: `git log -S'"file_pattern"'` on that file bottoms out at the shallow-clone root `fc48ede` (2026-07-22).

**Recommendation.** Rename the allow-list to `['path','regex','file_pattern']`, make `path`+`regex` required, and map `regex`→pattern / `file_pattern`→glob in `local-tool-adapter.ts:86-96`. Regenerate `provider-adapter-parity.json` from `tools.go` rather than from our own vocabulary.

**Verifier note.** Both sides verified verbatim. Backend: .references/nestor-code-completion/service/nestor/internal/usecase/vibe/agent/codeagent/tools.go:263 `Name: "search_files"`, :277 `regex`, :281 `file_pattern`, :287 `"required": []string{"path", "regex"}`, `Strict: true` at :291-292. It is live for the nessy A2A agent: codeagent/agent.go:76 `SearchFilesTool(workingDir)` inside getDefaultTools. Ours: packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:179-186 `strictKeys(args, ['pattern','path'])` + `pattern: stringValue(args.pattern,'pattern')` — doubly fatal: `regex` throws as an unknown key at :210-213 AND the required `pattern` is absent so stringValue would throw anyway. normalizeNestorToolCall is called from tool-executor.ts:182-186, whose catch turns the throw into an isError tool result (`return this.result(call, boundedError(error), true)`), so the search never runs. Counter-evidence searched and not found: `grep -an "'regex'|\"regex\"|file_pattern"` over packages/shared/src/agent/backend/ and local-tools/ returns NOTHING (positive control: the same pattern hits tools.go:281), so there is no rename/alias layer anywhere — local-tool-adapter.ts:85-93 reads `call.args.pattern` and local-tools/types.ts:6 types the op as `{kind:'search_files'; pattern; path?}`. The reference connector confirms the backend shape is what actually arrives: nessy-acp-agent/src/tools/search-files/local.ts:226-227 and mcp.ts:25-26 read `args.regex` / `args.file_pattern`. Our fixture encodes our own vocabulary (…/__tests__/fixtures/provider-adapter-parity.json:6 `"args": {"pattern": "x", …}`, and agent/__tests__/fixtures/adjacent-backends/nestor-a2a.json:32 likewise). Additional same-class drift found while checking: tools.go:252 requires `["path","diff"]` for replace_in_file while tool-schema.ts:187-193 demands `path/old_string/new_string`, and tools.go:347/:367 declares `activate_skill(skill_name)` which is absent from NESTOR_BUILTIN_TOOL_NAMES entirely.

### F2 [blocker] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T3 accepts `{path, diff}`, T4 added `parseSearchReplaceDiff` (whole-line markers, multi-block, CRLF-tolerant, empty REPLACE = delete) whose error message IS the connector's `buildFormatReminder` guidance, T5 routes it onto `edit_file`.

**Claim.** `replace_in_file` is unusable: the backend sends a `diff` of SEARCH/REPLACE blocks, we demand `old_string`/`new_string`, and the backend's tool-error wrapper then forbids the model from falling back to a shell workaround.

**Evidence.**
Backend: BACKEND/internal/usecase/vibe/agent/codeagent/tools.go:193 (name), :203 (`"diff"` property, documented as `<<<<<<< SEARCH … ======= … >>>>>>> REPLACE`), :252 (`"required": []string{"path", "diff"}`). Ours: OURS/packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:188-195 (`strictKeys(args, ['path','old_string','new_string'])`) and local-tool-adapter.ts:110-127 (`oldString: call.args.old_string`). Recovery is blocked by the backend's error wrapper text "Do not switch to execute_command to work around this failure without following the recovery protocol" (BACKEND/internal/usecase/vibe/mapping/tool_result.go:32-40). The connector implements the real contract: `_tools/replace_in_file` params `{path, diff}` (CONNECTOR/src/tools/replace-in-file/acp-advertising.ts:28-32) and a SEARCH/REPLACE parser (CONNECTOR/src/tools/replace-in-file/local.ts:10-38).

**Recommendation.** Accept `{path, diff}`, port the connector's SEARCH/REPLACE block parser (including its `buildFormatReminder` instruction-string behaviour on malformed input, which returns guidance instead of an error), and map it onto our existing `replace_in_file`/`edit` local operation.

**Verifier note.** Both sides confirmed at the cited locations, and the failure path is live. Backend: /Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/nestor-code-completion/service/nestor/internal/usecase/vibe/agent/codeagent/tools.go:193 (Name: "replace_in_file"), :203 ("diff" property, description embeds the literal <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format), :252 ("required": []string{"path", "diff"}). The tool set is fixed server-side — codeagent/agent.go:70-92 getDefaultTools() appends ReplaceInFileTool(workingDir) in AgentModeAct; only MCP tools come from the client (convertMcpToolsToChatTools), and we never advertise a replace_in_file MCP tool, so the model can only ever emit {path, diff}. The system prompt reinforces it (prompt_builder.go:290, :392, :420, :436). Ours: /Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:188-194 strictKeys(args, ['path','old_string','new_string']) — an incoming {path, diff} hits strictKeys' extra-key branch (:212-215) and throws `Unknown Nestor tool argument: diff`. This is on the live inbound path: tool-executor.ts:184 calls normalizeNestorToolCall(call) for every remote tool call (also local-tool-adapter.ts:40), and local-tool-adapter.ts:109-126 reads call.args.old_string/new_string. Error wrapper confirmed verbatim at .../internal/usecase/vibe/mapping/tool_result.go:32-40, line 38 exactly: "Do not switch to execute_command to work around this failure without following the recovery protocol." Counter-evidence search found none: `grep -ran "<<<<<<< SEARCH" packages apps --include='*.ts' --include='*.tsx'` returns zero hits in nessy-desktop, while the same grep on the connector returns 7 files (positive control), and the full `replace_in_file` sweep across packages/apps shows only the old_string/new_string shape (tool-schema.ts, local-tool-adapter.ts, local-tools/types.ts:8 `{kind:'replace_in_file'; oldString; newString}`, runtime.ts:80/:153) plus an unrelated pi-agent-server tool-name set. Connector contract confirmed: .references/nestor-assistant/nessy-acp-agent/src/tools/replace-in-file/acp-advertising.ts:24-33 sends {sessionId, path, diff} over _tools/replace_in_file, and .../local.ts:8-18 parseDiff() implements the SEARCH/REPLACE regex with buildFormatReminder() at :20-37 (cited line spans off by ~2 lines; content exact).

### F3 [blocker] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T7 made advertise and parse one decision: `buildAdvertisedMcpName(server, tool)` mints `${slug}|${tool.name}` from the pool's `getTools`, sitting next to the parser; legacy `mcp__…__…` is still accepted inbound.

**Claim.** MCP tool calls from the cloud agent are rejected 100% of the time: we advertise tools under `mcp__<slug>__<tool>` but only parse `<server>|<tool>` and `use_mcp_tool` inbound.

**Evidence.**
We advertise the proxy name verbatim: OURS/packages/shared/src/mcp/mcp-pool.ts:663 (`const prefix = \`mcp__${slug}__\``) → getProxyToolDefs mcp-pool.ts:2316 → OURS/packages/shared/src/agent/backend/nestor-cloud/mcp-metadata.ts:23-27 (`name: tool.name`) → metadata-builder.ts:106-112 (`metadata.mcp`). Backend passes the advertised name straight to the model and echoes it back on the call (BACKEND/internal/usecase/vibe/agent/codeagent/agent.go:96-113, `Name: tool.Name`, `Strict: true`). Our inbound parser: OURS/.../tool-schema.ts:48-49 (`MCP_TOOL_NAME_SEPARATOR='|'`, `MCP_USE_TOOL_NAME='use_mcp_tool'`), :111-125 (`normalizeMcp` returns null for a name with no `|`) → `kind:'unknown'` → `Unsupported Nestor tool: <name>` (tool-executor.ts:188). Connector is self-consistent, advertising `${server}|${tool.name}` (CONNECTOR/src/metadata/mcp/provider.ts:11-16) and detecting the same separator (CONNECTOR/src/adapter/a2a/utils.ts:215-221).

**Recommendation.** Make advertise and parse one decision. Cheapest correct fix: keep advertising the `mcp__slug__tool` proxy name (it is what the rest of our stack executes) and add it as a recognised inbound form in `normalizeMcp`, resolving slug/tool by longest-prefix match against `mcpPool` slugs rather than by splitting on `__` (slugs may contain `__`). Add a test that feeds a call back using exactly the name emitted by `buildNestorCloudMcpToolMetadata`.

**Verifier note.** Both cited sides verified plus counter-evidence search. ADVERTISE: /Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/mcp/mcp-pool.ts:663 mints the prefix mcp__<slug>__ in buildPoolProxyBaseName; mcp-pool.ts:2807-2816 getProxyName returns a minted proxyName or falls back to that base; mcp-pool.ts:2316 getProxyToolDefs sets name from getProxyName; .../agent/backend/nestor-cloud/mcp-metadata.ts:23-27 copies name verbatim; metadata-builder.ts:105-112 emits it as metadata.mcp[].name; production call site nestor-cloud-agent.ts:86. BACKEND: .references/nestor-code-completion/service/nestor/internal/usecase/vibe/agent/codeagent/agent.go:95-112 convertMcpToolsToChatTools sets Name: tool.Name (line 106) with Strict: true and Init appends them to a.tools -- no rename anywhere. PARSE: tool-schema.ts:48-49 defines separator '|' and 'use_mcp_tool'; :113-134 normalizeMcp returns null for a name with no '|' that is not use_mcp_tool, so normalizeNestorToolCall falls through to kind:'unknown' (:94) with no semanticId, and tool-executor.ts:188 returns 'Unsupported Nestor tool: <name>'. COUNTER-EVIDENCE, all negative: grep -ran 'use_mcp_tool' over the whole Go service returns zero hits (positive control: the same grep hits tool-schema.ts:49 on our side and CONNECTOR/src/adapter/a2a/utils.ts:220); no '|' separator constant anywhere under internal/usecase/vibe; no minted name can ever contain '|' because capabilities/mcp-wire-name.ts:24 sanitizeMcpNameSegment and mcp-pool.ts:641 sanitizeMcpToolNameSegment both restrict to [A-Za-z0-9_-]; no test under packages/shared/src/agent/backend/nestor-cloud/__tests__ feeds an mcp__-prefixed name into normalizeNestorToolCall -- tool-schema.test.ts:63-93 covers only 'jira|get_issue' and 'use_mcp_tool'. Connector self-consistency confirmed at CONNECTOR/src/metadata/mcp/provider.ts:11-16. Only line-number nit: the backend evidence is agent.go:95-112, not 96-113.

### F4 [blocker] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T3 added the ninth builtin (`activate_skill[skill_name]`, semantic id `skill`), T8 executes it.

**Claim.** `activate_skill` has been on by default since 2026-07-29 and is missing from our tool vocabulary, so the call always errors.

**Evidence.**
Backend adds it whenever the flag is on, independent of whether the client sent any skills: BACKEND/internal/usecase/vibe/agent/codeagent/agent.go:80-82 (`if flag.IsEnabled(ctx, flag.A2ASkillsEnabled) { defaultTools = append(defaultTools, ActivateSkillTool()) }`); schema at tools.go:347 (name), :362 (`skill_name`), :367 (required). Default flipped to ENABLE by `fe96908` (2026-07-29), BACKEND/internal/usecase/flag/default.go:82-85. Ours: `NESTOR_BUILTIN_TOOL_NAMES` has eight entries and no `activate_skill` — OURS/packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:3-12; unmatched names fall to `kind:'unknown'` → `Unsupported Nestor tool` (tool-executor.ts:188). Connector implements it locally (CONNECTOR/src/tools/activate-skill/local.ts:14-26).

**Recommendation.** Add `activate_skill` with `strictKeys(['skill_name'])`, a `skill` semantic id, and a local implementation that returns the skill body plus its directory and resources — the connector's `<skill_content name=…>…</skill_content>` envelope is a working reference. Pair with F12 so the model has skills to activate.

**Verifier note.** Both sides verified at the cited locations. Backend: `.references/nestor-code-completion/service/nestor/internal/usecase/vibe/agent/codeagent/agent.go:80-81` appends `ActivateSkillTool()` inside `getDefaultTools` whenever `flag.IsEnabled(ctx, flag.A2ASkillsEnabled)` — unconditional on any client-sent skills. Schema in tools.go: `Name: "activate_skill"` at :347, `"skill_name"` at :362, `"required": []string{"skill_name"}` at :367, `Strict: true`. Flag default is ENABLE at internal/usecase/flag/default.go:83-84; `git log -L 80,86:internal/usecase/flag/default.go` shows commit fe969080af4d (2026-07-29, "enable external skills") flipping `state: DISABLE` -> `state: ENABLE` for `A2ASkillsEnabled` — exactly as cited. Note the tool is offered even with zero skills: prompt_builder.go:92-113 emits the SKILLS section and writes "No skills added for now." when `len(p.spec.Skills.GetSkills()) == 0`, so the tool is advertised regardless. Ours: `NESTOR_BUILTIN_TOOL_NAMES` at packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:3-12 has exactly the eight names and no `activate_skill`; `normalizeNestorToolCall` (tool-schema.ts:66-95) falls through BUILTINS -> normalizeMcp (needs '|' separator or `use_mcp_tool`) -> `kind:'unknown'` with no semanticId, and tool-executor.ts:188 returns `Unsupported Nestor tool: ${call.name}` as an isError result. Counter-evidence search: `grep -ran "activate_skill" packages apps docs` in nessy-desktop returns ZERO hits (positive control: `grep -an "read_file" .../tool-schema.ts` hits lines 4/18/170; and the same term hits 10 files in the connector under .references). Connector reference implementation confirmed at .references/nestor-assistant/nessy-acp-agent/src/tools/activate-skill/local.ts:14-26 (exec returns `<skill_content name=...>` envelope with skill body, directory, resources), registered at src/tools/registry.ts:162 and classified permissionless at src/core/permission/helpers/classify.ts:19.

### F5 [blocker] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T9: the two terminal tools now have no local operation at all; the turn parks the call, surfaces its rendered text after the stream, and the NEXT user prompt is sent as that call's `tool_result` on the parked `taskId`.

**Claim.** `ask_followup_question` and `plan_mode_respond` are auto-answered with their own text and emit nothing to the UI, so the user never sees the question and never answers it.

**Evidence.**
Our mapping sends both to `return_text` (OURS/packages/shared/src/agent/backend/nestor-cloud/local-tool-adapter.ts:146 and :153), and `return_text` returns the text itself as the result (OURS/packages/shared/src/agent/local-tools/runtime.ts:94-95). In turn.ts:157-159 terminal tools have their only event (`tool_result`) filtered out, :163 skips the synthesized event, and :172-176 pushes the echo into `pendingToolResults` unconditionally — so :81-85 immediately opens a continuation. Backend ends that turn with `TASK_STATE_INPUT_REQUIRED, final=true` precisely because it is waiting for a client answer (BACKEND/internal/usecase/vibe/agent/a2a_environment.go:174-176). Connector does it correctly: terminal tools store `pendingToolCall`, surface the text as an agent message, and the next user prompt is sent as that call's `tool_result` (CONNECTOR/src/commands/tool-call.command.ts:126-133, CONNECTOR/src/core/turn.ts:340-357). No terminal/pending handling exists on our side — verified by `grep -arn 'ask_followup\|pendingToolCall\|terminal' packages/shared/src/agent/nestor-cloud-agent.ts` returning nothing.

**Recommendation.** Suspend the turn on a terminal tool: surface the question/plan as an agent message, persist the pending tool-call id in the sidecar, end the turn, and send the next user prompt as `{tool_call_id, content: <prompt text>}`. Do not drop the result entirely — the backend reassembles OpenAI history from calls-then-results (BACKEND/internal/usecase/vibe/mapping/message.go:30-40), so an orphan tool_call would break the next turn.

**Verifier note.** Mechanism verified end-to-end on both sides. OURS: local-tool-adapter.ts:143-156 maps both tools to `operation: {kind:'return_text', ...}` with `terminal: true`; local-tools/runtime.ts:94-95 `case 'return_text': return result(requireString(call.operation.text,'text'))` — the result IS the question text. event-adapter.ts:165-169 emits NO `startEvent` when `isNestorTerminalTool(name)` (tool-schema.ts:29-30,109 — the set is exactly ask_followup_question + plan_mode_respond). turn.ts:157-159 filters `tool_start`/`tool_result` out of the terminal tool's events (tool-executor.ts:350-362 produces ONLY a tool_result event), :163 skips the synthesized fallback, :172-176 pushes the echo into pendingToolResults unconditionally, and :81-85 immediately opens the continuation. The repo's own test asserts this: __tests__/turn.test.ts:186-213 'continues terminal tool calls without emitting local tool cards' expects `not.toContain('tool_start')`, `not.toContain('tool_result')`, and `results: [{toolCallId:'call-terminal', content:'plan'}]`. No alternate surfacing path exists: the permission subject is `ask_user`/`SubmitPlan`, and `SubmitPlan` is in ALWAYS_ALLOWED_TOOLS (mode-manager.ts:2008) so it never reaches onPermissionRequest; `ask_user` is not permission-gated in interactive-write modes either (permission-gate.ts:27-29 returns early unless requiresPermission). BACKEND confirms the turn is waiting on a client answer: a2a_environment.go:83-95 marks any non-server tool `receivedClientToolCall = true`, and :174-176 then ends with `TaskStateInputRequired, final=true`; ask_followup_question/plan_mode_respond are client tools (codeagent/agent.go:71-95, tools.go:294-340). CONNECTOR behaves as described: tool-call.command.ts:126-133 emits the result as an agent message and calls `setPendingToolCall`, and core/turn.ts:340-357 `buildInitialParts` turns the next prompt into `{kind:'tool_result', toolCallId, content: promptText}`. The recommendation's premise also holds — mapping/message.go:21-34 rebuilds history as texts, then extractToolCalls, then extractToolResults, so an orphan call would break the next turn. ONE EVIDENCE CORRECTION: the sentence 'No terminal/pending handling exists on our side — verified by grep ... nestor-cloud-agent.ts returning nothing' is wrong and the grep was scoped too narrowly. Terminal handling DOES exist (event-adapter.ts:17,165-169; local-tool-adapter.ts:148,155; turn.ts:157-163; local-tools/types.ts:35) — it is deliberate suppression of the tool card, not absence. What is missing is turn SUSPENSION and any surfacing of the question. The defect and its severity stand.

### F6 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T3 accepts `followup?: string[]` (the 2-4 bounds are deliberately NOT enforced client-side: a length check could only manufacture a failure the backend did not), T9 renders the choices numbered under the question.

**Claim.** `ask_followup_question` carries a `followup` array of 2–4 answer choices that our strict validator rejects.

**Evidence.**
Backend: BACKEND/internal/usecase/vibe/agent/codeagent/tools.go:298 (name), :322 (`"followup"` array, minItems 2 / maxItems 4), :336 (only `question` is required, so `followup` is optional-but-expected — the description at :320 tells the model the user answers by selecting a followup). Ours: OURS/packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:201-203 (`strictKeys(args, ['question'])`) → throws `Unknown Nestor tool argument: followup`. Connector renders them as numbered options (CONNECTOR/src/tools/ask-followup-question/acp.ts:11-22).

**Recommendation.** Accept `followup?: string[]` and surface the choices as selectable options in the UI prompt built for F5. Also re-check `plan_mode_respond` against tools.go:41-60 when touching this (it currently declares `response` only, which we match).

**Verifier note.** Both sides check out at the cited locations. Backend: /Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/nestor-code-completion/service/nestor/internal/usecase/vibe/agent/codeagent/tools.go — `Name: "ask_followup_question"` at :298, `"followup"` property at :322 with `"minItems": 2` (:329) / `"maxItems": 4` (:330) and `"items": {"type":"string"}`, `"required": []string{"question"}` at :336. The question description at :320 literally says the user answers by selecting one of the "followup" choices. Ours: packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:201-203 `case 'ask_followup_question': strictKeys(args, ['question']); return { question: ... }` — strictKeys (:208-211) throws `Unknown Nestor tool argument: followup` on any extra key, and validateBuiltinArgs is on the mandatory path (normalizeNestorToolCall :77). Counter-evidence search found none: `grep -arn followup` over packages/ + apps/ returns only tool-schema.ts (:10,:24,:29,:201), local-tool-adapter.ts (:143,:145) which reads only `call.args.question`, and two unrelated hits (capabilities/resolver.ts comment, an AgentPanel test-id). No sibling handler, no getter/setter pair, no enforcement one layer up. Connector confirms the intended UX: .references/nestor-assistant/nessy-acp-agent/src/tools/ask-followup-question/acp.ts:11-22 reads `args.followup as string[]` and renders `${i+1}. ${opt}` numbered options. Two refinements to severity/impact, neither weakening the claim: (1) the throw is caught at tool-executor.ts:184-187 and converted into a tool error result, so the failure mode is a failed ask surfaced as a tool error, not a crash; (2) the recommendation's side-check holds — backend PlanModeRespondTool (tools.go:38-63) declares only `response`, `required: ["response"]`, which our :204-205 matches exactly.

### F7 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0, premise narrowed** — T10 made `flushPending()` public and calls it after the stream loop AND before rethrowing a non-terminal stream error. The mechanism this finding names is DEAD on v2: the backend emits INPUT_REQUIRED on the retryable path, v2 carries no `final` field, and the computed predicate counts input-required as final. What the fix actually saves is a stream that ends with NO final state (torn socket, abort mid-WORKING).

**Claim.** When a turn ends on the retryable-error path the backend's last event carries `final=false`, so we never flush `text_complete` and never emit `done` — any assistant text streamed in that turn is lost from the committed message.

**Evidence.**
Backend: BACKEND/internal/usecase/vibe/agent/a2a_environment.go:157-165 — with retryable error parts it emits `TaskStateWorking, false` then `TaskStateInputRequired, **false**` and closes the stream (contrast :174-178 where the client-tool and completed paths pass `true`). Ours flushes only on the final flag: OURS/packages/shared/src/agent/backend/nestor-cloud/event-adapter.ts:77-87 (`if (statusUpdate.final === true) { … flushTextComplete() … push({kind:'done'}) }`); text is buffered at :99-108. turn.ts:184 then exits the for-await and :87 yields `complete` with the buffer unflushed.

**Recommendation.** Flush on stream exhaustion as well as on `final === true` — move `flushTextComplete()` into an adapter `endTurn()` called from `consumeStream` after the for-await loop, and treat the flag as an optimisation rather than the only trigger.

**Verifier note.** Backend verified at the cited lines: internal/usecase/vibe/agent/a2a_environment.go:157-165 CollectClientEvents — when FilterRetryableErrorParts is non-empty it emits `yieldUpdateMessage(ctx, a2a.TaskStateWorking, false, errParts...)` then `return e.yieldUpdateMessage(ctx, a2a.TaskStateInputRequired, false)`; contrast :174-178 where the client-tool and completed paths pass `true`. Ours verified: event-adapter.ts:77-87 gates flushTextComplete()+`{kind:'done'}` on `statusUpdate.final === true`; text accrues into `this.textBuffers` at :99-108 and is only emptied by flushTextComplete() (:176-192) or startTurn()/onTurnStart (:27-29). turn.ts:133-184 exits the for-await on stream close, :81 requires `pendingToolResults.length > 0` to continue, else :87 yields `complete`. Loss confirmed one layer up rather than assumed: SessionManager.ts:21748-21755 `text_delta` only does `managed.streamingText += event.text` + queueDelta (renderer only); the assistant `Message` is constructed and inserted ONLY in the `text_complete` case (SessionManager.ts:21761-21786, `insertCompletedAssistantMessage(...)`, then persistSession), and grep shows `managed.streamingText` is never converted into a message anywhere — the other 4 sites only reset it to ''. Nuance worth carrying: the loss bites only when the retryable error ends the turn with no pending tool results; if a tool ran earlier in the turn, turn.ts:81-84 continues and the buffer survives to a later final=true.

### F8 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T11: `clearHistory()` resets the context sidecar, and does so BEFORE `endLifecycle('clear')` so a failing SessionEnd hook cannot leave the remote context anchored.

**Claim.** `/clear` does not reset the remote conversation: the sidecar keeps `contextId`, and the backend replays the whole context across tasks, so the model still remembers everything the user just cleared.

**Evidence.**
Backend history spans the entire context, not just the task: BACKEND/internal/usecase/vibe/usecase_nessy_execution.go:136 (`MakeA2AContextReverseIter(ctx, contextID, taskID)` walks the whole context backwards) and BACKEND/internal/usecase/vibe/agent/memory/db_memory.go:34-65. Ours: OURS/packages/shared/src/agent/nestor-cloud-agent.ts:213-221 — `clearHistory()` calls `endLifecycle('clear')`, resets four hook booleans and `super.clearHistory()`, and never touches the context store; `NestorCloudContextStore.reset()` exists but is production-dead (OURS/packages/shared/src/agent/backend/nestor-cloud/context-store.ts:90-93, referenced only from __tests__/context-store.test.ts:44). Connector gets this right structurally: a new chat is a new session with no `contextId` (CONNECTOR/src/core/session/types.ts:141-143).

**Recommendation.** Call `contextStore.reset()` from `clearHistory()` so the next turn starts a fresh remote context. This is a two-line fix and the dead `reset()` was clearly written for it.

**Verifier note.** Confirmed on both sides, including the counter-evidence check. Backend: .references/nestor-code-completion/service/nestor/internal/usecase/vibe/usecase_nessy_execution.go:136 — `memory.NewDBMemory(c.a2aRepo.MakeA2AContextReverseIter(ctx, execCtx.ContextID, execCtx.TaskID), taskHistory)`; the port signature (internal/usecase/vibe/ports.go:41) is `MakeA2AContextReverseIter(ctx, contextID string, excludedTasks ...a2a.TaskID)`, i.e. the whole context minus the current task, which is then re-joined as taskHistory in .../agent/memory/db_memory.go:21-26 and :55-65 (joinContextHistory). So history spans the context, not the task. Ours: packages/shared/src/agent/nestor-cloud-agent.ts:213-221 clearHistory() = endLifecycle('clear') + four boolean resets + super.clearHistory(); it never touches the sidecar. chatImpl re-loads it every turn: :72-75 `const sessionPath = this.getSessionStoragePath(); const contextStore = this.createContextStore(...); const context = contextStore?.load();` and :137 passes `contextId: context?.contextId` into NestorCloudTurn. The sidecar path is `join(sessionPath,'meta','nestor-cloud-context.json')` (context-store.ts:45) and sessionPath is derived from the unchanged workspace/session ids (base-agent.ts:2744-2747), so /clear does not move or invalidate it. Counter-evidence checked and rejected: the /clear seam at base-agent.ts:3708-3716 also calls `this.config.onSdkSessionIdCleared?.()`, but that callback (packages/server-core/src/sessions/SessionManager.ts:14029-14035) only clears managed.sdkSessionId and sdkSessionAnchors and persists — it never deletes the nestor sidecar; backend/types.ts:668-670 says as much ("it only clears sdkSessionId"). `grep -ran "nestor-cloud-context" packages apps --include='*.ts'` finds only context-store.ts:45 and two test hits, so nothing else deletes the file. context-store.ts:90-93 reset() is real and production-dead — the only other reference in the whole tree is the test file (__tests__/context-store.test.ts; the assertions are around :53 and :86, not :44 — minor citation drift). Connector structural contract confirmed: .references/nestor-assistant/nessy-acp-agent/src/core/session/types.ts:141-143 holds contextId/taskId/taskStatus as per-session optional fields.

### F9 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T14 reads the 429 body (unwrapping echo's `{"message":…}` envelope before redaction, capped at 300 chars) and surfaces it verbatim; T17 adds `/quota` so the budget can be checked before the 429.

**Claim.** HTTP 429 from the per-user limiter is reported to the user as a bare status number; the backend's actual quota message and the new quota endpoint are both discarded.

**Evidence.**
Backend applies `userLimitMiddleware(h.limiters.Qwen35)` to the code-agent POST (BACKEND/internal/httpserver/handler.go:331, :440) and returns 429 with body `"too many requests"` or `"суточный лимит токенов исчерпан, лимит обновится в 00:00"` (BACKEND/internal/httpserver/userlimit_middleware.go:54-70). Ours maps every non-401/403 `!res.ok` to a status-only message: OURS/packages/shared/src/agent/backend/nestor-cloud/client.ts:193-195 (`Nestor stream failed: ${res.status}`), same at :142-144 and :78-84; the body is never read and there is no retry. Connector treats 429 as retryable with backoff (CONNECTOR/src/adapter/a2a/a2a-retry-manager.ts:3-11).

**Recommendation.** On 429 read the body (it is short, non-secret prose), surface it verbatim through `redactNestorSecrets`, and feed the status into the retry manager from F18. Optionally poll `GET /api/v1/quota` (F15) to render remaining limits instead of only reacting to exhaustion.

**Verifier note.** BACKEND: internal/httpserver/handler.go:331 h.registerNessyHandlers(traceMiddleware, userLimitMiddleware(h.limiters.Qwen35)); the definition is at :435 and the code-agent POST it wraps is at :445 (the finding cited :440 -- inside the same function, minor offset). internal/httpserver/userlimit_middleware.go:15-20 defines msgTooManyRequests='too many requests' and msgTokenLimitExceeded='суточный лимит токенов исчерпан, лимит обновится в 00:00'; :63-66 returns echo.NewHTTPError(http.StatusTooManyRequests, ...) for ErrPoolFull / ErrTokenLimitExceeded. OURS: packages/shared/src/agent/backend/nestor-cloud/client.ts:190-195 -- 401/403 branch, then any other !res.ok throws 'Nestor stream failed: ${res.status}'; identical shape at :139-144 (cancel) and :75-84 (agent card). res.body is never read on the error path and there is no retry anywhere in the file. COUNTER-EVIDENCE: grep -ran '429' over packages/shared/src/agent/backend/nestor-cloud, packages/server-core/src/model-fetchers/nestor.ts and connection-setup-logic.ts finds exactly one hit, connection-setup-logic.ts:50, which is the connection-verification path, not the chat stream. The generic classifier packages/shared/src/agent/errors.ts:423 does map a message containing '429' to rate_limited, but parseError is called only from claude-agent.ts, pi-agent.ts, backend/pi/event-adapter.ts and url-validator.ts -- never from the nestor-cloud backend, so the status-only string is what propagates (SessionManager.ts:21719 renders it as 'API error: <msg>'). Quota endpoint exists (handler.go:310 GET /api/v1/quota, quota_handler.go:28) and grep -rain 'quota' across packages/shared/src and packages/server-core/src finds only unrelated plugin/LLM-validation hits -- positive control passes, we never call it.

### F12 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T8 advertises `{name, description}` filtered by exactly the pair the local prompt builder applies (`disableModelInvocation !== true && overrideState !== 'off'`).

**Claim.** We never send the `skills` metadata the backend reads, so the SKILLS prompt section is empty while `activate_skill` is advertised — the docs list skills advertisement as a client obligation.

**Evidence.**
Backend reads `skills` as an array of `{name, description}` and injects it into the prompt/tool set (BACKEND/internal/usecase/vibe/a2aextensions/skills_extension.go:16,18-21; consumed at BACKEND/internal/usecase/vibe/usecase_nessy_execution.go:209-210). Our builder supports the key but no call site feeds it: OURS/packages/shared/src/agent/backend/nestor-cloud/metadata-builder.ts:65 and :114-118, versus the production call site OURS/packages/shared/src/agent/nestor-cloud-agent.ts:82-88 which passes only workspaceRootPath/workingDirectory/mode/mcpTools/projectTrusted. Docs make it explicit: "Агент получает имя и описание доступных skills" (DOCS/cli/index.md:241, list at :177-184). Connector feeds it from its skill registry (CONNECTOR/src/metadata/skills/provider.ts:15-18).

**Recommendation.** Wire our skill registry into `buildNestorCloudMetadata({ skills })` (name + description, excluding `disable-model-invocation`), landed together with F4 so an advertised skill is actually activatable.

**Verifier note.** Both sides check out. BACKEND: a2aextensions/skills_extension.go:16-21 reads metadata key `skills` as `[]SkillV1{Name,Description}` (both `validate:"required"`), GetSkillsFromMessage at :62-71; usecase_nessy_execution.go:209-210 pulls it into `codeagent.Spec.Skills`; prompt_builder.go:92-136 renders the `# SKILLS` section and, at :110-111, writes literally 'No skills added for now.' when the list is empty, while codeagent/agent.go:80-82 appends `ActivateSkillTool()` purely on the `flag.A2ASkillsEnabled` server flag — i.e. the tool is advertised independently of whether any skill was sent, exactly as claimed (the flag is the one qualifier worth recording: with A2ASkillsEnabled off, neither the section nor the tool appears). OURS: metadata-builder.ts declares `skills?: NestorSkillMetadata[]` (:29, :65) and maps it at :114-119, but the ONLY production call site is nestor-cloud-agent.ts:82-88, which passes workspaceRootPath, workingDirectory, mode, mcpTools, projectTrusted — no `skills`. Positive control for the absence: `grep -arn buildNestorCloudMetadata packages apps` returns exactly that call site plus metadata-builder.ts, its test file, and the built apps/electron/dist/main.cjs; `grep -arni skill` over nestor-cloud-agent.ts + all of backend/nestor-cloud/*.ts returns only a comment at nestor-cloud-agent.ts:292 about hook `reloadSkills`, i.e. no skill data reaches the wire by any other name (no injection via userInstructions or prompt text either — applyPromptHooks at :279-315 only prepends `<hook_context>`). DOCS: cli/index.md:244 'Агент получает имя и описание доступных skills' and the client-context list at :177-184 includes 'список доступных skills'. CONNECTOR: metadata/skills/provider.ts:9-19 returns `{key:'skills', content: skills}` from its registry.

### F14 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0, differently than recommended (owner decision 'планируем сразу на v2')** — instead of pinning 0.3 behind a constant, T1/T2 MIGRATED to `/api/v2/code-agent/a2a` (A2A 1.0): `SendStreamingMessage`/`CancelTask`, `ROLE_USER`, flattened parts, `TASK_STATE_*`, computed `final`, and card validation on `supportedInterfaces`. The recommendation's other half was kept: unknown envelope keys and unknown part keys are logged and skipped, never thrown.

**Claim.** We are pinned to the a2a 0.3 compat endpoint by a hard-coded URL and hold no protocol-version constant; the v1.0 endpoint exists and would break our parser wholesale if anyone repointed `baseUrl`.

**Evidence.**
Backend serves both: `/api/v1/code-agent/a2a` via `a2av0.NewJSONRPCHandler` (protocol 0.3) and `/api/v2/code-agent/a2a` via `a2asrv.NewJSONRPCHandler` (protocol 1.0) — BACKEND/internal/httpserver/handler.go:439-448, BACKEND/internal/usecase/vibe/usecase_nessy.go:85-100. On v1.0 task states become `TASK_STATE_*` and stream events are a oneof keyed by field name (`message`/`task`/`statusUpdate`/`artifactUpdate`) with no `kind` discriminator. Ours hard-codes the v1 path in three places (OURS/packages/shared/src/agent/backend/internal/drivers/nestor-cloud.ts:3-7 and again at OURS/packages/shared/src/agent/nestor-cloud-agent.ts:330) and switches on `event.kind` with a silent `default: return outputs` (OURS/.../event-adapter.ts:31-93); `card.protocolVersion` is required-present but never compared (client.ts:226-228 per Report 3, no protocol constant exists in the backend dir — verified by grep for version literals, only `jsonrpc: '2.0'`). A per-connection `baseUrl` override reaches the same code path (drivers/nestor-cloud.ts:12-17).

**Recommendation.** Add an explicit `NESTOR_A2A_PROTOCOL_VERSION = '0.3'` constant, compare it against `card.protocolVersion` in `validateNestorAgentCard`, and fail with a clear message instead of mis-parsing. Log unknown event kinds rather than dropping them. Treat a v1.0 migration as its own piece of work (new state strings + oneof events + camelCase interface fields).

**Verifier note.** Backend serves both, verified: internal/httpserver/handler.go:435-449 registers `codeAgentPathV1 := vibe.GetCodeAgentURL("", "v1")` with `GetAgentHandler()` and `codeAgentPathV2 := …"v2"` with `GetAgentHandlerV2()`; usecase_nessy.go:85-100 — `GetAgentHandler` = `a2av0.NewJSONRPCHandler`, card produced with `a2av0.Version`; `GetAgentHandlerV2` = `a2asrv.NewJSONRPCHandler`, card with `a2a.Version`. The version literals check out in the module itself (~/go/pkg/mod/github.com/a2aproject/a2a-go/v2@v2.1.0): a2acompat/a2av0/doc.go:21 `const Version a2a.ProtocolVersion = "0.3"` and a2a/core.go:31 `const Version ProtocolVersion = "1.0"`. The claimed v1.0 wire differences are real too: a2a/core.go:296 `TaskStateWorking TaskState = "TASK_STATE_WORKING"` and a2a/core.go:102-141 marshals/unmarshals the stream event as a oneof keyed `message`/`task`/`statusUpdate`/`artifactUpdate` with no `kind` discriminator. Ours: three hard-coded v1 literals — backend/internal/drivers/nestor-cloud.ts:3-4 (agent-card URL) and :6-7 (A2A URL), plus nestor-cloud-agent.ts:330 (context-store endpoint); the per-connection override at drivers/nestor-cloud.ts:12-17 reaches the same parser. event-adapter.ts:31-93 switches on `event.kind` with `default: return outputs` at :91-92 (silent drop). Absence of a version check confirmed with positive control: grep -a for protocolVersion across shared/server-core/core hits only client.ts:226-228 (presence-only throw) and types.ts:80 (optional field); `PROTOCOL_VERSION = '1.0'` in shared/src/protocol/types.ts:187 is our own websocket envelope version, unrelated to A2A, and no A2A protocol constant exists on either side.

### F18 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T14's `retry.ts` (10 retries, 5s->60s, connector-verbatim constants), abortable sleep, with the in-band `-32029` continuation carrying `contextId` alone.

**Claim.** We have no rate-limit retry: a `-32029` from the backend ends the turn with a non-fatal error event and the user must retype, where the connector retries ten times with capped backoff.

**Evidence.**
Backend emits `-32029 "Inference rate limit error occurred, please try again later"` as an in-band retryable-error data part, then ends the turn on INPUT_REQUIRED (AGENTCORE/a2a/extensions/retryable_error_extension.go:54-84; emission path BACKEND/internal/usecase/vibe/agent/a2a_environment.go:126-138 and :157-165). Ours treats any `data.error` object as a plain non-fatal `type:'error'` event and keeps going (OURS/packages/shared/src/agent/backend/nestor-cloud/event-adapter.ts:151-160), then `turn.ts:81-87` finds no pending tool results and yields `complete`. Connector: `RETRYABLE_STREAM_ERROR_CODES = new Set([429, -32029, -32001])` (CONNECTOR/src/adapter/a2a/a2a-errors.ts:86-87) with `RATE_LIMIT_MAX_RETRIES: 10`, `RATE_LIMIT_INITIAL_DELAY: 5_000`, `RATE_LIMIT_MAX_DELAY: 60_000` and abortable doubling backoff (CONNECTOR/src/adapter/a2a/a2a-retry-manager.ts:3-29), routed at CONNECTOR/src/commands/handle-a2a-error.command.ts:48-79.

**Recommendation.** Port the retry manager, keyed on `-32029`/`-32000`/HTTP 429, re-sending on the same `taskId`/`contextId` (the backend has no dedicated resume RPC — a fresh message on the live task re-invokes the agent over stored history). Copy the connector's budget-per-send structure but avoid its bug at handle-a2a-error.command.ts:74, where the log-line interpolation calls `handleServerErrorRetry()` and consumes the server-error budget as a side effect.

**Verifier note.** Backend: `MakeA2ARetryableErrorPart` at .references/nestor-code-completion/pkg/agentcore/a2a/extensions/retryable_error_extension.go:54-84 maps `ErrRateLimitError` to `ErrorData{Code: -32029, Message: "Inference rate limit error occurred, please try again later"}` and encodes it as a DataPart. Emission: a2a_environment.go `case *EventError:` (~:127-138) builds the part and appends to `e.resultParts`; `CollectClientEvents` (~:156-165) yields the retryable-error parts as a WORKING update then `a2a.TaskStateInputRequired` — i.e. the turn ends waiting on the client. Ours: event-adapter.ts:151-160 `isRetryableErrorData(data)` (defined at :229-231 as merely `typeof data.error === 'object' && data.error !== null` — no code inspection) pushes a plain `{type:'error', message}` agent event and `continue`s; turn.ts:81-87 then finds `taskStatus === 'input-required'` but `pendingToolResults.length === 0`, so it falls through to `yield { type: 'complete' }`. Absence of retry confirmed: `grep -ran "32029|rate.limit|rateLimit|RATE_LIMIT|429"` over packages/shared/src/agent/backend/nestor-cloud/ and nestor-cloud-agent.ts returns ZERO hits, and `grep -ran "32029" packages/shared/src packages/server-core/src` returns zero (positive control: the same grep pattern for retry hits packages/shared/src/agent/backend/claude/event-adapter.ts:230-242,928-945, and `-32029` hits the connector). client.ts has no retry either (grep for 429/retry in client.ts: no hits). Connector side verified: `RETRYABLE_STREAM_ERROR_CODES = new Set([429, -32029, -32001])` at src/adapter/a2a/a2a-errors.ts:86-87, `RATE_LIMIT_MAX_RETRIES: 10 / RATE_LIMIT_INITIAL_DELAY: 5_000 / RATE_LIMIT_MAX_DELAY: 60_000` plus `abortableDelay` at src/adapter/a2a/a2a-retry-manager.ts:3-29, and the in-band DataPart path is what feeds it (a2a-bridge.ts:179-182 throws `createA2AError(...)` on `isStreamErrorData`, which returns `A2ARetryableError` for those codes). The noted connector bug is real: handle-a2a-error.command.ts:74 is `log(\`A2A rate limit, retrying (attempt ${retryManager.handleServerErrorRetry()})\`)` — the log interpolation consumes the server-error budget as a side effect.

### F19 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T12 throws `NestorCloudTerminalTaskError` from a CODE-agnostic detector (a `TASK_STATE_[A-Z_]+` token anywhere in `message` + stringified `data`, plus the stateless `terminal state` phrase) so the existing recovery catch finally fires. Named divergence from the connector: `-32001` routes here rather than into backoff — a task the backend has LOST does not come back on a timer.

**Claim.** A stale terminal `taskId` in the sidecar permanently bricks a session — we define a recovery error but never throw it, while the connector recovers by re-sending without the task id.

**Evidence.**
Ours: `NestorCloudTerminalTaskError` is declared at OURS/packages/shared/src/agent/backend/nestor-cloud/turn.ts:28-33 and caught at :71-77, but is thrown nowhere in shipped code (verified by grep across OURS/packages/shared/src for `NestorCloudTerminalTaskError` — only the class, the catch, and tests). The sidecar keeps `activeTaskId` unless a terminal status is observed in-stream (turn.ts:147-150 / context-store.ts:73-88), so a dropped stream before the final status update leaves a stale id that every subsequent turn re-sends (turn.ts:123). Connector: detects `TASK_STATE_*` terminal names in the error text (CONNECTOR/src/adapter/a2a/utils.ts:104-128), raises `TurnTaskInTerminalStateError` (CONNECTOR/src/commands/handle-a2a-error.command.ts:29-35) and re-sends the initial parts with no `taskId` (CONNECTOR/src/core/turn.ts:96-132).

**Recommendation.** Detect the backend's terminal-task rejection (message match on `TASK_STATE_(COMPLETED|CANCELED|FAILED|REJECTED)` plus JSON-RPC `-32001`), throw `NestorCloudTerminalTaskError`, and let the existing catch at turn.ts:71-77 do its job. Mirror the connector's guard: do not retry when the initial parts were tool results.

**Verifier note.** Verified on all three sides. OURS: NestorCloudTerminalTaskError is declared at turn.ts:28-33 and caught at :71-77; `grep -arn NestorCloudTerminalTaskError packages apps/electron/src scripts` returns ONLY those two sites plus __tests__/turn.test.ts:3 and :245 — never thrown in shipped code (positive control: the grep does find the term, so this is a real absence, not a missed file). The throw site would have to be the client, and client.ts cannot produce it: consumeSseFrames (client.ts:305-313) discards the backend's error text entirely — `throw new Error('A2A JSON-RPC error ' + code)` — and openStream re-wraps everything as NestorCloudClientError('stream-failed') at :187/:200, so even a message-based match is impossible today. Sidecar staleness confirmed: turn.ts:143-150 clears activeTaskId only when an in-stream status is terminal (isTerminal at :197-202), context-store.ts:73-88 otherwise persists it, and nestor-cloud-agent.ts has no other clearing path (only :74 load and :141 update; clearActiveTask/reset are never called outside tests), so a dropped stream leaves the id and turn.ts:120-126 re-sends it every subsequent turn. BACKEND does reject such an update: pkg/agentcore/repo/a2ar/a2a_repo_task_store.go:106-107 `if a2a.TaskState(lockedTask.StatusState).Terminal() { return fmt.Errorf("task is already in terminal state: %w", a2a.ErrUnsupportedOperation) }` (test at a2a_repo_task_store_test.go:682-729). CONNECTOR recovers exactly as described: adapter/a2a/utils.ts:104-128 parseTerminalTaskState matches /TASK_STATE_[A-Z_]+/ against terminal proto states, handle-a2a-error.command.ts:28-35 raises TurnTaskInTerminalStateError, core/turn.ts:95-131 clears taskId, emits clearTask, refuses to retry when initialParts contain a tool_result, and otherwise re-sends the initial parts with no taskId. ONE CAVEAT on the recommendation, not the claim: the exact wording the connector matches ('task in a terminal state 'TASK_STATE_X'', per its test at src/__tests__/parse-terminal-task-state.test.ts:12) is NOT present in this backend snapshot — the only terminal-state string here is 'task is already in terminal state' with no TASK_STATE_ token, so a message-match implementation must accept both spellings (and the client must stop swallowing the JSON-RPC error message first).

### F20 [should] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T13: `cancel()` builds its own `AbortSignal.timeout(5000)` per call, so the request leaves the process after the turn signal is aborted.

**Claim.** `tasks/cancel` is issued with the AbortSignal that was just aborted, so the cancel request is almost always killed before it leaves the process and the remote task keeps burning quota.

**Evidence.**
Ours: `abort()` calls `abortController.abort()` and then `currentTurn.cancel()` (OURS/packages/shared/src/agent/nestor-cloud-agent.ts:157-167); `cancel()` passes `this.options.signal` — the aborted one — into the cancel fetch (OURS/packages/shared/src/agent/backend/nestor-cloud/turn.ts:92-97 → client.ts:114-134, `signal` at :133). Backend's cancel is a real state transition to `TASK_STATE_CANCELED` and is a no-op only if the task is already terminal (BACKEND/internal/usecase/vibe/usecase_nessy_execution.go:60-80). Connector emits the local clear immediately and fires the remote cancel in the background on its own lifetime, applying the follow-up state only if the session's taskId has not changed (CONNECTOR/src/commands/helper/cancel-task.ts:13-43).

**Recommendation.** Give the cancel its own AbortSignal (or none) with a short timeout, keep the optimistic local `clearTask` as today, and fire-and-forget the RPC — the connector's `cancelTaskAndEmit` is a direct template.

**Verifier note.** Confirmed, and slightly stronger than stated. Ours: nestor-cloud-agent.ts:157-161 `abort()` calls `this.abortController?.abort()` then `await this.currentTurn?.cancel().catch(() => undefined)`; :163-167 `forceAbort()` does the same synchronously. The turn was constructed with `signal: this.abortController.signal` (nestor-cloud-agent.ts:136), and turn.ts:92-97 `cancel()` passes `this.options.signal` — that same, now-aborted signal — into `client.cancelTask(this.taskId, this.options.signal)`, which lands as `signal` on the fetch at client.ts:133 (cancelTask spans :114-144, `this.fetchImpl` defaults to global `fetch` at :50). An already-aborted signal makes fetch reject immediately, and the rejection is swallowed by the `.catch(() => undefined)`. Adjustment in the finding's favour: `abort()`/`forceAbort()` are the ONLY callers of `turn.cancel()` in non-test code (`cancelWithEvents` at turn.ts:99-107 has no production caller), and both abort synchronously before calling cancel — so it is not 'almost always' but always, on every cancel path. Backend side confirmed: usecase_nessy_execution.go:60-80 `NessyUseCase.Cancel` returns early only when `StoredTask == nil || StoredTask.Status.State.Terminal()`, otherwise it yields a real `a2a.NewStatusUpdateEvent(execCtx, a2a.TaskStateCanceled, msg)` — a genuine state transition. Connector template confirmed at .references/nestor-assistant/nessy-acp-agent/src/commands/helper/cancel-task.ts:13-43: `cancelTaskAndEmit` emits `clearTask: true, taskStatus: 'canceled'` immediately, then `void bridge.cancelTask(taskId)` on its own lifetime with a stale-taskId guard (`current.taskId !== taskId → return`).

### F21 [should] — verdict: adjusted

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **parked, consistent with this document's own correction** — the consequence is refuted (`SessionManager.respondToPermission` enforces alwaysAllow one layer up); the seam-level drop in `tool-executor.ts` is untouched by the 1.32.0 plan.

**Claim.** "Always allow" is silently discarded for this backend, so users are re-prompted for the same tool on every call.

**Evidence.**
Ours: `respondToPermission(requestId, allowed, _alwaysAllow?, _options?)` ignores both trailing arguments and forwards only the boolean (OURS/packages/shared/src/agent/backend/nestor-cloud/tool-executor.ts:297-311). Connector persists decisions on both paths: a session-level cache for `allow_always`/`reject_always` in legacy mode (CONNECTOR/src/core/permission/permission-service.ts:75-110) and durable project/user rule files in extended mode (CONNECTOR/src/core/permission/permission-storage.ts:37-42, rules written at permission-service.ts:213-218).

**Recommendation.** Forward `alwaysAllow` into the existing permission manager the way the other backends do; nothing here is Nestor-specific, the parameter is simply dropped at the seam.

**Verifier note.** The seam-level fact is exactly as claimed: tool-executor.ts:297-311 `respondToPermission(requestId, allowed, _alwaysAllow?, _options?)` underscore-drops both trailing args and calls `this.permissionGate.respondToPermission(requestId, allowed)`; LocalToolPermissionGate (local-tools/permission-gate.ts:50-55) has no alwaysAllow parameter at all, and nestor-cloud-agent.ts:196-202 does forward it, so the drop is genuinely at this seam (contrast claude-agent.ts:2009-2043, which whitelists the base command / domain on alwaysAllow). The connector citations also check out (permission-service.ts, permission-storage.ts). What refutes the CONSEQUENCE clause ("re-prompted for the same tool on every call") is enforcement one layer up, which the finding did not check: SessionManager.respondToPermission (packages/server-core/src/sessions/SessionManager.ts:21183-21284) acts on alwaysAllow BEFORE delegating — :21271-21274 `if (allowed && alwaysAllow && requestMeta?.type === 'bash' && requestMeta.command) this.persistBashAlwaysAllowRule(...)`, which at :7218-7254 writes a durable `Bash(<base> *)` allow rule into `.claude/settings.local.json` via addClaudePermissionRules; plus :21245-21257 storeAdminRememberApproval and :21252-21258 workflowLaunchConsent. Nestor's execute_command requests carry exactly `type: 'bash'` + `command` (local-tool-adapter.ts:128-142), and that persisted rule IS consulted on the Nestor path: permission-gate.ts:18-21 → permission-manager.ts:245-257 evaluateToolCall → mode-manager.ts:2151-2181 `matchesToolPermissionRule(toolName, config.toolRules)` returning `{allowed:true}` for an `allow` rule, with `.claude/settings.local.json` compiled into those rules at permissions-config.ts:419-423/511-556. So: for Bash the always-allow does survive (subject to permissionsConfigCache.getMergedConfig caching per key with no mtime check, SessionManager/permissions-config.ts:915-924 — a same-process re-prompt is possible until the cache is invalidated); for every other Nestor tool (Read/Write/Edit/MCP prompts raised by an `ask` toolRule) the flag is dropped with no persistence at any layer, which is the real, narrower defect. Severity as scoped should be 'nice/should' on non-bash tools, not a blanket backend-wide loss.

### F10 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T15 emits the backend object `{open_tabs: string[], visible_files: string[]}`; still unpopulated, but no longer a shape the backend would drop whole.

**Claim.** Our `workspace_tabs` metadata is an array of `{path,title}` where the backend expects an object `{open_tabs, visible_files}`; the key would be silently dropped if ever populated.

**Evidence.**
Backend expects an object and reads it via `GetMetaObjectForKey`, which returns `ErrWrongExtensionType` for a non-map value (AGENTCORE/a2a/extensions/metadata.go:21-37); struct is `WorkspaceTabsV1{open_tabs []string, visible_files []string}` (BACKEND/internal/usecase/vibe/a2aextensions/open_tabs_extension.go:18-21). Ours declares `workspace_tabs?: NestorWorkspaceTabMetadata[]` (OURS/packages/shared/src/agent/backend/nestor-cloud/metadata-builder.ts:66, built at :121-123, item type at :16). Non-fatal: `createCodeAgentSpec` only logs the error (BACKEND/internal/usecase/vibe/usecase_nessy_execution.go:206-207 via `logErr` at :188-192) — this corrects Report 1 §3.2's "aborts". Currently dormant: `nestor-cloud-agent.ts:82-88` never passes `workspaceTabs`.

**Recommendation.** Change the shape to `{ open_tabs: string[], visible_files: string[] }` before wiring any producer, matching CONNECTOR/src/metadata/workspace-tabs/provider.ts:17-20.

**Verifier note.** Backend shape verified: `WorkspaceTabsV1{ OpenTabs []string \`json:"open_tabs"\`; VisibleFiles []string \`json:"visible_files"\` }` at .references/nestor-code-completion/service/nestor/internal/usecase/vibe/a2aextensions/open_tabs_extension.go:18-21, read through `extensions.GetMetaObjectForKey(msg, "workspace_tabs", getWorkspaceTabs)`; `GetMetaObjectForKey` at pkg/agentcore/a2a/extensions/metadata.go:21-37 switches on the metadata value type and returns `ErrWrongExtensionType` for anything that is not `map[string]any` — a JSON array hits the `default` branch. Ours: `NestorWorkspaceTabMetadata { path; title? }` at packages/shared/src/agent/backend/nestor-cloud/metadata-builder.ts:16-19, declared `workspace_tabs?: NestorWorkspaceTabMetadata[]` at :66, built at :121-122 (`metadata.workspace_tabs = args.workspaceTabs.map((tab) => ({ ...tab }))`) — an array of objects, so it would be rejected by the parser. Non-fatal claim confirmed: `createCodeAgentSpec` (internal/usecase/vibe/usecase_nessy_execution.go:185) defines `logErr` at :188-192 which only calls `logger.Error()`, and the workspace-tabs read at :206-207 uses it; the spec is still built with a nil WorkspaceTabs (:212-220). This does correct "aborts". Dormant claim confirmed: `buildNestorCloudMetadata` in packages/shared/src/agent/nestor-cloud-agent.ts:81-88 passes only workspaceRootPath/workingDirectory/mode/mcpTools/projectTrusted — no workspaceTabs; repo-wide grep finds `workspaceTabs`/`workspace_tabs` only in metadata-builder.ts and the built apps/electron/dist/main.cjs. One citation correction: the connector's `{open_tabs, visible_files}` shape lives at .references/nestor-assistant/nessy-acp-agent/src/metadata/workspace-tabs/parse-workspace-tabs.ts:3-6 (`type TWorkspaceTabsMetadata = { open_tabs: string[]; visible_files: string[] }`), not provider.ts:17-20 (that range is the `{ key, content }` return of `McpWorkspaceTabsMetadataProvider.collect`).

### F13 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T16, with one deliberate narrowing: `server_tool_invocation` renders as an `agent_event` PAIR and NOT as a `tool_call` output (which would re-run a tool the backend already ran), and `server_tool_status` renders `description` only, because the backend fills that field only when it decided the run is visible.

**Claim.** Server-side tool activity — `server_tool_status` artifact-updates and `server_tool_invocation` data parts — is silently dropped, so doc-search runs invisibly.

**Evidence.**
Backend emits `server_tool_status` as an artifact-update (BACKEND/internal/usecase/vibe/mapping/status.go:26-50, added by `27c38d8` 2026-07-30) and `server_tool_invocation` `{call,result}` as a data part (BACKEND/internal/usecase/vibe/agent/a2a_environment.go:102-124). Our `partsToOutputs` recognises only context_usage / compaction / reasoning / error / tool_call and falls through to nothing for these (OURS/packages/shared/src/agent/backend/nestor-cloud/event-adapter.ts:116-160); artifact `append`/`lastChunk` are ignored at :58-62. Currently low impact: the only server tool is `doc_search_v2` behind flag `code_agent_doc_search` (default DISABLE, BACKEND/internal/usecase/flag/default.go:86-89) and it is now hidden from external models entirely (`d4a9b78`, 2026-08-21). Connector also drops them, so this is not a parity regression.

**Recommendation.** Render `server_tool_status` (state `started`, with `description` when present) as a status event and `server_tool_invocation` as a read-only tool card. Do not execute them — the backend already ran them.

**Verifier note.** Backend emission verified: mapping/status.go:25-50 `yieldToolCallStatus` builds `extensions.MakeA2AServerToolStatusPart(...)` and wraps it in `a2a.NewArtifactEvent(info, part)`; the part's DataType is `"server_tool_status"` (.references/nestor-code-completion/pkg/agentcore/a2a/extensions/server_tool_status.go:20, fields tool_call_id/name/state/description, only state `started` exists at :10). agent/a2a_environment.go:102-124 emits `extensions.MakeA2AServerToolInvocationPart(call, result)` via `yieldUpdateMessage`; DataType `"server_tool_invocation"` with required `call`+`result` (pkg/.../server_tool_invocation.go:7-26). Both commits exist: `27c38d8 AIDT-6969: Add server tool status`, `d4a9b78 AIDT-7530: restrict server tools from external models`. Flag mitigation verified: `CodeAgentDocSearch Key = "code_agent_doc_search"` (internal/usecase/flag/list.go:40) with `state: DISABLE` in default.go:86-89. Ours: event-adapter.ts artifact-update at :58-62 forwards `artifact.artifact?.parts` into partsToOutputs but drops the append/lastChunk chunking flags; partsToOutputs (:96-173) tries, in order, context_usage, compaction, `data.reasoning`, retryable-error, then parseRemoteToolCall — which requires `data.id: string` + `data.index: number` (tool-schema.ts:50-51), so a server_tool_status/server_tool_invocation data part matches nothing and falls out of the loop with zero output. Absence claim has a positive control: the identical grep pattern `server_tool_status|server_tool_invocation|serverToolStatus|serverToolInvocation` returns 0 hits across packages/ + apps/ (grep -a) while hitting pkg/agentcore/a2a/extensions/*.go on the backend side. Connector also has 0 hits under nessy-acp-agent/src, so 'not a parity regression' holds too.

### F15 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T17's `/quota`: per limit `- <title> [<scope>] (<state>): <N>% remaining — <status.message> (resets <reset_at>)`, with the percentage suppressed on `exhausted`; availability is read from `status.state`, never derived from `usage` (render shape from the 1c8b17875 review fixes). EXTENDED post-1.32.0 (addendum T19, 52885afba): the same command on the built-in Pi Nessy Gateway connection — same budget, same endpoint, gated by the `NESTOR_CLI_BASE_PREFIX` rule; BYOK Pi excluded.

**Claim.** The new `GET /api/v1/quota` endpoint is unused; we have no way to show the user their remaining daily token budget before they hit the 429.

**Evidence.**
Backend added it in `5cb0d29`/`4a0a4de` (2026-08-19/21): `GET /api/v1/quota` returning `{schema_version:"1.0", generated_at, limits[]}` (BACKEND/internal/httpserver/handler.go:310, BACKEND/internal/httpserver/quota_handler.go:28-65). Absent in ours — verified by grep for `/api/v1/quota` across OURS/packages and OURS/apps returning no hits; our only Nestor HTTP calls are the three in OURS/packages/shared/src/agent/backend/nestor-cloud/client.ts (card GET :66, message/stream POST :161, tasks/cancel POST :121).

**Recommendation.** Fetch it alongside the agent card at `postInit` and surface remaining limits in the composer for the Nessy Cloud connection; it is the same `Nestor-Token` auth we already build.

**Verifier note.** Endpoint exists on the backend, is absent from ours. Backend: .references/nestor-code-completion/service/nestor/internal/httpserver/handler.go:309-310 `// quota` / `h.e.GET("/api/v1/quota", h.quotaHandler, apiLimiter)`; quota_handler.go:28-66 returns `QuotaResponse{SchemaVersion: "1.0", GeneratedAt: h.timeProvider.Now(), Limits: limits}` with QuotaLimit{ID, Display{Title,Description}, Scope{Type,Values}, Usage, Status{State,Severity,Message}, ResetAt} built at :68-87, 401 on missing user, 500 on read failure. Commit dates verified exactly: `5cb0d29 2026-08-19 AIDT-7441: add quota info handler`, `4a0a4de 2026-08-21 AIDT-7441: fix quota handler`. Ours: `grep -ran "v1/quota" packages apps docs` returns zero hits (positive control: the same pattern hits handler.go:310 on the backend); a broader case-insensitive `quota` sweep of packages/shared/src, packages/server-core/src and apps returns only unrelated matches (llm-validation.ts:123-125 error-string matching, plugins/acquisition.ts dependency-quota, claude event-adapter rate_limit_event, protocol/dto.ts 'no-quota' entitlement verdict). Our Nestor HTTP surface is exactly the three cited fetches in packages/shared/src/agent/backend/nestor-cloud/client.ts — :66 GET agent card, :121 POST tasks/cancel, :161 POST message/stream. The recommendation is viable: auth is the global echo middleware (handler.go:336-342) with the `nestor-token` apiKey security definition (:229-231), so the same header we already build applies; note the path sits at the service root, not under the `/api/v1/cli/openai-like` gateway prefix, so a URL derivation would be needed.

### F16 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **parked** — `agent_settings.user_instructions` is still populated by nothing; no 1.32.0 task took it.

**Claim.** `agent_settings.user_instructions` is a supported backend field our builder implements but nothing populates, so per-project custom instructions never reach the cloud agent.

**Evidence.**
Backend: `UserInstructions []string` is the second field of the agent-settings extension (BACKEND/internal/usecase/vibe/a2aextensions/agent_settings_extension.go:27) and is fed into the prompt. Ours accepts it and emits it only when non-empty (OURS/packages/shared/src/agent/backend/nestor-cloud/metadata-builder.ts:88-90) but the production call site never passes it (OURS/packages/shared/src/agent/nestor-cloud-agent.ts:82-88). Note the adjacent `agents_md` path IS wired and correctly fail-closed on untrusted projects (metadata-builder.ts:94-103).

**Recommendation.** Feed our per-workspace custom-instructions setting into `user_instructions`. Apply the same trust gate as `agents_md` if the source is repository-owned.

**Verifier note.** BACKEND: internal/usecase/vibe/a2aextensions/agent_settings_extension.go:27 UserInstructions []string with json/mapstructure tag user_instructions, second field of AgentSettingsV1; consumed by internal/usecase/vibe/agent/codeagent/prompt_builder.go:51 ({Get: p.getUserInstructions}) and :508-513, so it really does reach the prompt. OURS: packages/shared/src/agent/backend/nestor-cloud/metadata-builder.ts:27 accepts userInstructions?: string[] and :89 emits user_instructions only when non-empty. Production call site packages/shared/src/agent/nestor-cloud-agent.ts:82-88 passes workspaceRootPath, workingDirectory, mode, mcpTools and projectTrusted -- no userInstructions. COUNTER-EVIDENCE: grep -ran 'userInstructions' over packages/ and apps/ returns only metadata-builder.ts:27/:89, the compiled apps/electron/dist/main.cjs mirror of the same line, and an unrelated EditPopover.tsx parameter name -- no producer. grep for customInstructions/custom_instructions finds only Pi/Claude compaction plumbing (claude-agent.ts, pi-agent.ts, slash-commands/session-command.ts), which is /compact input, not per-project instructions, and never touches the nestor-cloud metadata. The adjacent agents_md path at metadata-builder.ts:93-103 is indeed wired and gated on args.projectTrusted === true (fail-closed), as the finding states.

### F22 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0, one clause parked** — T16 remembers `request_id` per turn and appends ` [request_id: …]` to task-failure and `stream_error` messages (`"N/A"` treated as absent). PARKED: `NestorCloudClientError` messages still carry no id — that is `client.ts`, outside T16's file list.

**Claim.** The backend stamps every outgoing message with a support-grade `request_id` that we discard, making gateway-side incident triage impossible from our logs.

**Evidence.**
Backend attaches `metadata.request_details = {data_type:'request_details', data_version:1, request_id}` plus the extension URI to every status message (BACKEND/internal/usecase/vibe/a2aextensions/request_details_extension.go:82-98, :55-70; introduced for all outgoing messages by `4a6e1ec`, 2026-07-31; falls back to the literal `"N/A"` at :72-80). Absent in ours — verified by grep for `request_details`/`request_id` under OURS/packages/shared/src/agent/backend/nestor-cloud returning no hits; our adapter reads only context_usage/compaction/reasoning/error/tool_call (event-adapter.ts:116-160). Connector extracts it with a fallback chain and logs it per event (CONNECTOR/src/adapter/a2a/utils.ts:67-80, used at CONNECTOR/src/adapter/a2a/a2a-bridge.ts:75-78) and attaches it to error `_meta` (CONNECTOR/src/core/turn.ts:134-142).

**Recommendation.** Parse `metadata.request_details.request_id` off status-update messages, log it once per turn, and include it in the message of every `NestorCloudClientError` and in-band error event.

**Verifier note.** Confirmed on all three sides. Backend: .references/nestor-code-completion/service/nestor/internal/usecase/vibe/a2aextensions/request_details_extension.go:18 `dataRequestDetailsField = "request_details"`, :20-22 `RequestDetailsV1{RequestID string \`json:"request_id"\`}`, :55-70 SetRequestDetailsMetadata writes it into msg.Metadata and appends RequestDetailsExtensionURI ("urn:a2a:extension:request-details:v1", :33), :72-80 GetRequestID falls back to the literal "N/A" when the domain context is missing, :82-98 MakeResponseMessage always calls SetRequestDetailsMetadata. The data_type/data_version envelope claimed in the finding is real but comes one layer up, in pkg/agentcore/a2a/extensions/versioned.go:32-46 (encodeVersionedData stamps `data_type` and `data_version`) via metadata.go:61-72 AddMetaToMessage — the finding is accurate, the fields just are not literals in the cited file. "Every outgoing status message" holds: internal/usecase/vibe/agent/a2a_environment.go:202-215 yieldUpdateMessage builds every status-update event's message through MakeResponseMessage. Commit verified: `4a6e1ec 2026-07-31 AIDT-6969: Add concurrent events writing and refactor A2AEnvironment`. Ours: `grep -ran "request_id" packages/shared/src/agent/backend/nestor-cloud` returns zero hits; `grep -ran "request_details" packages apps --include='*.ts' --include='*.tsx'` returns only `analytics_request_details` (metadata-builder.ts:48, :83 and its test), which is an unrelated OUTBOUND field carrying `project_name` — not the backend's inbound request_id, so it is not counter-evidence. Our event-adapter.ts:110-165 only inspects part.data (context usage, compaction, `reasoning`, retryable error, tool call) and never reads event.metadata or event.status.message.metadata (positive control for the metadata path: the connector reads exactly those two locations). Connector confirmed: src/adapter/a2a/utils.ts:67-80 extractRequestId (event.metadata.request_details.request_id → status.message.metadata.request_details.request_id), logged per event at src/adapter/a2a/a2a-bridge.ts:75-78, and surfaced on retryable errors at src/core/turn.ts:134-141.

### F23 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0, with a named scope decision** — T13 captures the turn ref first and fires a bounded fire-and-forget cancel from `destroy()`/`disposeForRestart()`. The cancel is TURN-ref based, not sidecar-based as recommended: a sidecar-based cancel would also kill T9's suspended INPUT_REQUIRED task, silently degrading the user's next prompt from an answer into an ordinary message. An idle suspended task is left to the backend's own expiry.

**Claim.** Closing or destroying a session leaves the remote task running: we send nothing to the backend on `destroy()`/`disposeForRestart()`.

**Evidence.**
Ours: `destroy()` (OURS/packages/shared/src/agent/nestor-cloud-agent.ts:249-253) and `disposeForRestart()` (:255-264) only abort locally, dispose the executor and release local surfaces — no `tasks/cancel`. Verified by reading both methods and by the fact that the only cancel call site is `turn.cancel()` from `abort`/`forceAbort` (:157-167). Connector added exactly this in `65ad6ae` (AIDT-711): `closeSessionCommand` snapshots bridge/taskId/taskStatus, detaches synchronously, then fires `cancelTaskBestEffort` when the task is still cancelable (CONNECTOR/src/commands/close-session.command.ts:13-28, CONNECTOR/src/commands/helper/cancel-task.ts:45-53). There is no server-side close RPC — cancel is the whole mechanism.

**Recommendation.** On destroy/dispose, if the sidecar holds a non-terminal `activeTaskId`, fire a best-effort `tasks/cancel` with its own signal (shares the fix from F20).

**Verifier note.** OURS: packages/shared/src/agent/nestor-cloud-agent.ts:249-253 destroy() calls endLifecycle, toolExecutor.dispose() and super.destroy(); :255-264 disposeForRestart() aborts the controller, disposes the executor, stops the config watcher and releases the elicitation surface. Neither touches the client or the turn. BaseAgent.destroy (base-agent.ts:2794-2819) only clears whitelists/usage/retention, releases the elicitation surface and disconnects a private MCP pool -- no cancel. The ONLY cancelTask call site in our source is turn.ts:94 inside NestorCloudTurn.cancel(), reached solely from abort()/forceAbort() at nestor-cloud-agent.ts:157-167 (grep -ran 'cancelTask' over packages/shared/src and packages/server-core/src returns only turn.ts:13/:94, client.ts:114 and test doubles). Session teardown routes through SessionManager.disposeManagedAgentRuntime (SessionManager.ts:10940, agent dispose at :10984-10986), which prefers disposeForRestart and does not call abort for a non-Pi provider -- the forceAbort at :14486 is inside the Pi-only drain branch. The taskId is available at teardown (context store persists activeTaskId, read at nestor-cloud-agent.ts:138). CONNECTOR: src/commands/close-session.command.ts:13-28 snapshots bridge/taskId/taskStatus, calls sessionManager.close synchronously, then cancelTaskBestEffort when hasCancelableTask; src/commands/helper/cancel-task.ts:45-53 fires bridge.cancelTask and swallows errors, :55-62 defines the terminal-status set. Commit confirmed: 65ad6ae '[AIDT-711] feat(nessy-acp): Add ACP session close support'.

### F24 [nice] — verdict: adjusted

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T15 budgets against the 500,000-byte helm cap (not the 1 MB envDefault), trimming agents_md -> MCP `parameters` -> skills and re-measuring after each step; a review fix put BOTH halves on the same scale (serialized bytes), since a newline-heavy prompt doubles on the wire.

**Claim.** Our first message carries unbounded metadata (concatenated AGENTS.md files plus every connected MCP tool's full JSON Schema) against a hard 1 MB server-side request limit whose rejection surfaces as an opaque JSON-RPC error.

**Evidence.**
Backend rejects oversize requests in an interceptor that reads the `content-length` service param: AGENTCORE/a2a/interceptors/request_size_limit.go:26-36 (`too large request: size=%d, limit=%d: a2a.ErrInvalidRequest`), wired for the code agent at BACKEND/cmd/nestor/startup/usecase.go:691 with `RequestLimit int \`env:"CODE_AGENT_REQUEST_LIMIT_SIZE" envDefault:"1000000"\`` (BACKEND/internal/config/config.go:413). Ours has no size accounting: `agents_md.content` is the concatenation of every AGENTS.md from workingDirectory up to workspaceRoot (OURS/packages/shared/src/agent/backend/nestor-cloud/metadata-builder.ts:94-103, :128-159) and `mcp[]` carries each tool's full `inputSchema` (mcp-metadata.ts:23-27). The failure would arrive as `-32600` → our generic `A2A JSON-RPC error -32600` → `stream-failed` (client.ts:193-201 and the SSE reader's throw path).

**Recommendation.** Measure the serialized body before sending; when it approaches ~900 KB, trim in priority order (MCP schemas first, then AGENTS.md tail) and log what was dropped. Map `-32600` with an oversize hint so the failure is diagnosable.

**Verifier note.** Mechanism confirmed, MAGNITUDE WRONG. Interceptor verified verbatim at .references/nestor-code-completion/pkg/agentcore/a2a/interceptors/request_size_limit.go:26-36: reads `callCtx.ServiceParams().Get("content-length")` and returns `fmt.Errorf("too large request: size=%d, limit=%d: %w", size, i.size, a2a.ErrInvalidRequest)`; wired for the nessy code agent at service/nestor/cmd/nestor/startup/usecase.go:691 inside `makeNessyUseCase` (also agents.go:96), fed by `RequestLimit int \`env:"CODE_AGENT_REQUEST_LIMIT_SIZE" envDefault:"1000000"\`` at internal/config/config.go:413. BUT the envDefault is not what runs: the helm chart always sets the env var (service/nestor/helm/nestor/templates/deployment.yaml:819-820, nestor-external .../deployment.yaml:331-332) and EVERY values file sets `request_limit_size: "500000"` — service/nestor/helm/nestor/values.yaml:238, values.ya-a-prod1.yaml:236, values.bm-ix-m4-prod1.yaml:206, values.ya-ruc1-dev1.yaml:218, nestor-external/helm/nestor-external/values.yaml:100 (no values file lacks the key). So the effective limit is 500,000 bytes, half the claimed 1 MB, and the recommendation's "~900 KB" trim threshold would never fire — it must be ~450 KB. Our side of the claim holds: no size accounting anywhere (`grep -ran "byteLength|JSON.stringify(metadata|payloadSize|maxBytes"` over packages/shared/src/agent/backend/nestor-cloud/ and nestor-cloud-agent.ts returns ZERO hits; positive control: `Buffer.byteLength` hits packages/shared/src/capabilities/runtime-skill-context.ts:183,268 and runtime-skill-content.ts:167,644,1314); `readApplicableAgentsMd` (metadata-builder.ts:128-159) concatenates every AGENTS.md from workingDirectory up to workspaceRoot with no cap (gated on `args.projectTrusted === true` at :93-102, so it is skipped for untrusted projects); mcp-metadata.ts:23-27 passes each tool's full `inputSchema` as `parameters` with no truncation. Second correction: the cited client.ts:193-201 is the `!res.ok` -> `Nestor stream failed: ${res.status}` branch; the generic `A2A JSON-RPC error ${parsed.error.code ?? 'unknown'}` throw is client.ts:313 (SSE reader), wrapped into `stream-failed` at client.ts:198-200 — the opaque-failure conclusion stands, the line anchor does not.

### F25 [nice] — verdict: refuted

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **refuted here; no action taken** — unchanged in 1.32.0.

**Claim.** The connector explicitly compiles against the OS certificate store for the corporate TLS-intercepted gateway; our A2A fetch relies on an operator-provided CA file instead, so a user with only the OS trust store configured gets an unexplained connection failure.

**Evidence.**
Connector: `--compile-exec-argv="--use-system-ca"` added by `5134dbb` (AIDT-7030) to both the release script and CI (CONNECTOR/package.json:11), for exactly the corporate-TLS reason. Ours: no `--use-system-ca` anywhere in source — verified by `grep -rn 'use-system-ca' apps packages scripts` returning no hits; we have a managed-CA mechanism keyed on `NODE_EXTRA_CA_CERTS` (OURS/packages/shared/src/config/tls-ca-path.ts, `MANAGED_CA_ENV_VAR`) plus an Electron `certificate-error` handler (OURS/apps/electron/src/main/index.ts:273), which covers the case only when someone supplies the CA file. Our client uses plain `globalThis.fetch` (OURS/packages/shared/src/agent/backend/nestor-cloud/client.ts:50, :66/:121/:161).

**Recommendation.** Either pass `--use-system-ca` to the Electron/Node runtime or auto-populate the managed CA path from the OS store on first run, and map TLS failures (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`) to an actionable message instead of the generic `stream-failed`.

**Verifier note.** The literal flag absence is true but the capability claim is wrong — we read the OS trust store by default, under a different name. COUNTER-EVIDENCE: apps/electron/src/main/network-proxy.ts:125-136 calls `parseCertStoreSources(settings?.certStore)` and `composeCaTrust({sources, extraCa, getCACertificates: runtimeGetCACertificates()})` on EVERY settings application, and network-proxy-utils.ts:47 sets `DEFAULT_CERT_STORE_SOURCES = ['bundled','system']` with :55-75 returning that default when `certStore` is unset — so with zero operator configuration the composed set is bundled Mozilla PLUS `tls.getCACertificates('system')` (network-proxy-utils.ts:92-95, :130-146), and network-proxy.ts:150-158 installs it via `setGlobalDispatcher(new Agent(...))`. That is precisely what `--use-system-ca` buys, and it governs `globalThis.fetch` — the very call the finding cites at client.ts:50/:161. `tls.getCACertificates` exists on this toolchain (node v24.4.1 here; electron ^39.2.7 in package.json:120), and applyConfiguredProxySettings runs at apps/electron/src/main/index.ts:481 long before any Nestor request. SECOND counter-evidence: the corporate CA is not operator-supplied either — tls-ca-path.ts:36-50/:68-69 makes the shipped `resources/certs/tinkoff-bundle.crt` tier 3, applied by DEFAULT unless `useBundledCa:false`/`NESSY_DISABLE_BUNDLED_CA`; the file is present at apps/electron/resources/certs/tinkoff-bundle.crt and staged into apps/electron/dist/resources/certs/. The finding's own cited comment contradicts it: tls-ca-path.ts:44 says 'the OS store (certStore source system) and an explicit tlsCaPath remain available.' So an OS-trust-only user is covered, and MANAGED_CA_ENV_VAR/NODE_EXTRA_CA_CERTS is one tier of a four-tier ladder, not the mechanism. Positive control on the absence half: `grep -arn use-system-ca` over apps/packages/scripts/fastlane/.gitlab-ci.yml (node_modules, dist, release, out excluded) returns nothing, while the same term is found in CONNECTOR/package.json:11 and CONNECTOR/.ci/build_release_binaries.sh:24 — the flag genuinely is absent, it is just not needed. TWO RESIDUES worth keeping, neither supporting the stated severity or claim: (a) the headless path is narrower — network-runtime.ts:129-140 composes trust only `if (tlsCa.ca || settings?.certStore)`, so a `nessy-server` run with no CA settings at all does NOT pull the OS store, unlike the Electron main path where the desktop agent actually runs; (b) the diagnostic half is accurate — client.ts:186-201 collapses every transport failure, TLS included, into NestorCloudClientError('stream-failed'), so mapping UNABLE_TO_VERIFY_LEAF_SIGNATURE / SELF_SIGNED_CERT_IN_CHAIN to an actionable message remains a valid (nice-severity) improvement on its own.

### F26 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **parked** — `llmProxyKey` / `X-LLM-Proxy-Key` still cannot be supplied by this client.

**Claim.** The documented second auth token, `llmProxyKey` (server header `X-LLM-Proxy-Key`), cannot be supplied by our client at all.

**Evidence.**
Docs declare it as half of the token config: `interface A2AAuthorizationTokens { nestorToken: string; llmProxyKey: string }` — "Ключ для доступа к LLM proxy" (DOCS/a2a-sdk/types.md:320-327), passed as `token` to both setup functions (DOCS/a2a-sdk/index.md:63, :118) and exposed by the CLI as `--llm-proxy-key <key>` (DOCS/cli/index.md:117). Backend binds it: `LLMProxyKey string \`header:"X-LLM-Proxy-Key"\`` (BACKEND/internal/httpserver/api.go:18). Ours sends exactly three headers and no more: `Nestor-Token`, `Device-Id`, `User-Agent` (OURS/packages/shared/src/agent/backend/nestor-cloud/auth.ts:24-48, applied at client.ts:68, :123-126, :163-167). Mitigating: the docs show it as an empty string in two examples, so it is optional in practice.

**Recommendation.** Add an optional per-connection LLM-proxy-key field and emit `X-LLM-Proxy-Key` when set, scoped to the verified gateway host like the `Nestor-Token` rule in AGENTS.md. Note that our current header attachment is unconditional on whatever `baseUrl` the connection names (auth.ts:24-48) — that scoping gap is worth closing in the same change.

**Verifier note.** Every cited location checks out. Docs: .references/nestor-assistant/docs/nessy-cloud/a2a-sdk/types.md:319-327 declares `interface A2AAuthorizationTokens { nestorToken: string; llmProxyKey: string }` with the bullet «`llmProxyKey` — Ключ для доступа к LLM proxy»; passed as `token` in index.md:63 (`llmProxyKey: ""`) and index.md:118 (`llmProxyKey: 'your-token'`); CLI flag `--llm-proxy-key <key>` documented at cli/index.md:117 and used at :278. Backend binds it: internal/httpserver/api.go:18 ``LLMProxyKey string `header:"X-LLM-Proxy-Key"` ``. Ours: packages/shared/src/agent/backend/nestor-cloud/auth.ts:24-47 `buildNestorCloudAuthHeaders` returns exactly `{'Nestor-Token', 'Device-Id', 'User-Agent'}` and nothing else; those headers are spread at client.ts:68 (agent card), :123-126 (cancelTask) and :163-167 (openStream) — no other header source. Absence claim has a positive control: `grep -arin 'llm.proxy.key|llmProxyKey'` over packages/ + apps/ returns only three prose comments in model-fetchers/openai-compat.ts about a 'real llm-proxy key' and zero header/config plumbing, while the same pattern hits api.go:18 and eleven doc lines on the other side. No sibling implementation under a different name. The recommendation's scoping note is also accurate: backend/internal/drivers/nestor-cloud.ts:13-16 resolves `baseUrl: context.connection?.baseUrl ?? NESTOR_CLOUD_A2A_URL`, nestor-cloud-agent.ts:265-271 `createClient()` passes it straight to `NestorCloudClient`, and the only validation is `validateNestorAgentCard(card, { postUrl })` (client.ts:221-243) which checks card/postUrl agreement, not host — so `Nestor-Token` is attached to whatever URL the connection names, with no gateway-host allowlist anywhere.

### F27 [nice] — verdict: confirmed

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **fixed in 1.32.0** — T14 sends the v2-flattened `RETRY_MARKER_PART = { data: { retry: {} } }` (no `kind`) on `contextId` alone, never on the frozen `taskId`.

**Claim.** The only documented continuation primitive in the whole nessy-cloud corpus — the `{retry:{}}` data part sent back after a retryable error — is unimplemented on our side.

**Evidence.**
Docs: `interface A2AErrorRetryDataPart extends DataPart { data: { retry: Record<never, never> } }`, "используется в ответ на A2ARetryableError, чтобы продолжить стрим с сообщения, на котором произошла ошибка" (DOCS/a2a-sdk/types.md:271-278); the handling pattern branches on the error code and returns the retry part, which "будет добавлен к следующему пользовательскому сообщению" (:127-139). Backend advertises the two-way contract on the card: "Defines the format for retryable error data (agent->client) and retry request (client->agent) via DataPart" (AGENTCORE/a2a/extensions/retryable_error_extension.go:48). Connector implements it: `RETRY_MARKER_PART = { kind: 'data', data: { retry: {} } }` (CONNECTOR/src/adapter/a2a/utils.ts:62-65) as a first-class domain part (CONNECTOR/src/core/turn-types.ts:3-6). Absent in ours — verified by grep for `retry` across OURS/packages/shared/src/agent/backend/nestor-cloud (only the unrelated `retriedTerminalTask` flag in turn.ts).

**Recommendation.** Send the retry marker part as the continuation body when F18's retry fires. Note the backend's inbound mapper only extracts text / tool_call / tool_result parts (BACKEND/internal/usecase/vibe/mapping/message.go:22-40), so the marker is inert server-side today — its practical value is that it re-invokes the agent over stored history without polluting it with a fake user message.

**Verifier note.** Docs verified verbatim at .references/nestor-assistant/docs/nessy-cloud/a2a-sdk/types.md — the `A2AErrorRetryDataPart` block with `data: { retry: Record<never, never> }` and the sentence "Используется для отправки в ответ на A2ARetryableError, чтобы продолжить стрим с сообщения, на котором произошла ошибка", plus the retryableErrorDataPart example returning createRetryDataPart() with "Возвращаемый part будет добавлен к следующему пользовательскому сообщению". Backend advertises it: pkg/agentcore/a2a/extensions/retryable_error_extension.go — `RetryableErrorExtensionURI = "urn:a2a:extension:retryable-error:v1"` with Description "Defines the format for retryable error data (agent->client) and retry request (client->agent) via DataPart." Connector implements it: nessy-acp-agent/src/adapter/a2a/utils.ts `export const RETRY_MARKER_PART: DataPart = { kind: 'data', data: { retry: {} } }` and src/core/turn-types.ts:3-6 `| { kind: 'retry_marker' }` as a first-class TDomainPart. Absence on our side confirmed with `grep -ran retry` over packages/shared/src/agent/backend/nestor-cloud/ (positive control: the same grep hits the connector): only two test files match, and the production continuation path (turn.ts:109-118 sendToolResultsStream) sends tool results only — no data part. The recommendation's caveat also checks out: service/nestor/internal/usecase/vibe/mapping/message.go:22-40 ExtractDomainMessages builds history from getTextMessages / extractToolCalls / extractToolResults only, so an inbound retry marker is inert server-side today.

### F11 [info] — verdict: info-not-verified

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **not taken as written; the real defect underneath it was fixed** — T2 found that `agent-card-modes.ts` read only top-level `extension(s)` and never `capabilities.extensions`, where BOTH wires nest them, so the remote mode catalog was dead on the live card and the built-in Plan/Act fallback always won. Whether the backend then drops a non-`plan|act` mode is still unverified live (checklist row NCA-3).

**Claim.** Our mode resolver can emit an arbitrary card-advertised mode id, but the backend validates `mode` as `oneof=plan act` and drops the whole `agent_settings` extension on anything else — silently falling back to ACT.

**Evidence.**
Backend: `Mode AgentMode \`validate:"required,oneof=plan act"\`` (BACKEND/internal/usecase/vibe/a2aextensions/agent_settings_extension.go:26); on a nil/dropped extension `GetAgentMode()` returns `AgentModeAct` (:60-66), i.e. full write tools. Ours types the id as `NestorCloudA2AMode = 'plan' | 'act' | (string & {})` and prefers a catalog entry's `remoteModeId` read straight from the agent card enum (OURS/packages/shared/src/agent/backend/nestor-cloud/mode-mapping.ts:4, :27-38; card enum read at .../agent-card-modes.ts:69-92). Our local `dontAsk`/`explore` both intentionally map to `plan` (mode-mapping.ts:11-25), so the fail-open direction is dangerous: a bad id turns a read-only intent into ACT.

**Recommendation.** Clamp the outgoing id to the card's advertised enum and, if it is not one of them, send `plan` rather than an unknown string — failing closed on the local side matches the intent comment at mode-mapping.ts:12-14.

### F17 [info] — verdict: info-not-verified

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **unchanged** — deliberately not adopted in 1.32.0.

**Claim.** The backend's new template-agent surface (`/api/agents/**`, T-Tracker, the ADK tool-confirmation protocol) is a second, incompatible client-tool wire that we should deliberately not adopt.

**Evidence.**
Routes and ADK executor: BACKEND/internal/agentcore/agents/echo_adapter.go:67-79, :123-131 (`OutputArtifactPerEvent`, in-memory task store at :54); the ADK round trip uses genai FunctionCall/FunctionResponse rather than our DataPart extensions (BACKEND/internal/agentcore/agents/testclient/main.go:81-168). All of it is gated off by default: `TEMPLATE_AGENTS_ENABLED` defaults false and returns 404 `"Template agents (including T-Tracker) are disabled"` (BACKEND/internal/config/config.go:402-405, BACKEND/internal/agentcore/ttrackeragent/poc/usecase_disabled.go:63-65, `f3f02bd` 2026-08-19). Also note the version-token trap: T-Tracker's path `v0` is protocol 0.3 while `v1` is protocol 1.0 — the opposite of the code agent. Absent in ours — verified by grep for `/api/agents` across OURS returning no hits.

**Recommendation.** No action. If a future connection ever targets `/api/agents/**`, note that the URL version token means different protocols per agent family and that our DataPart tool parser does not apply there at all.

### F28 [info] — verdict: info-not-verified

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **superseded** — the 0.3 shapes this finding blesses are no longer spoken: T1/T2 moved the codec to the 1.0 vocabulary (oneof envelope, `TASK_STATE_*`, flattened parts, computed `final`), and lowercase legacy states are now a negative control in the tests.

**Claim.** Task-state vocabulary, terminal-set semantics and the `kind`-discriminated event shapes match on the 0.3 endpoint — no action needed.

**Evidence.**
Ours accepts exactly `submitted|working|input-required|completed|canceled|failed|rejected|auth-required` and maps anything else to `unknown` (OURS/packages/shared/src/agent/backend/nestor-cloud/event-adapter.ts:206-220), with terminal = `completed|failed|rejected|canceled` (turn.ts:197-202). The connector maps the identical set 1:1 (CONNECTOR/src/adapter/a2a/utils.ts:88-102) and uses the same terminal set (CONNECTOR/src/commands/helper/cancel-task.ts:55-62). The backend only ever emits SUBMITTED/WORKING/INPUT_REQUIRED/COMPLETED/CANCELED (BACKEND/internal/usecase/vibe/agent/a2a_environment.go:157-179, usecase_nessy_execution.go:60-106), so our `failed`/`rejected`/`auth-required` branches are dead but harmless. Our handling of `task`/`message`/`status-update`/`artifact-update` matches what the v0.3 compat handler emits.

**Recommendation.** No change. Do re-verify this set if F14 (v1.0 migration) is ever taken up — on `/api/v2` the strings become `TASK_STATE_*` and the `kind` discriminator disappears.

### F29 [info] — verdict: info-not-verified

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **mostly unchanged in 1.32.0** — `workspace_tabs` was corrected under F10, and T9 narrows one clause: the answer to a parked terminal-tool question IS the first send of a user turn, so it carries the turn metadata (without it that turn would advertise no MCP tools and no skills).

**Claim.** Sending metadata only on the first message of a turn, omitting `data_type`/`data_version` envelopes, and including the extra `workspace_root` field are all correct against the current backend.

**Evidence.**
Metadata resolution is latest-wins across the whole task history, so continuations need not repeat it: `GetLatestMetaObject` scans backwards (AGENTCORE/a2a/extensions/metadata.go:85-102), used for every extension at BACKEND/internal/usecase/vibe/usecase_nessy_execution.go:194-210 — matching our first-message-only behaviour (OURS/packages/shared/src/agent/backend/nestor-cloud/client.ts:104-112 passes no metadata on continuations) and the connector's (CONNECTOR/src/core/turn.ts:192). Unstamped payloads are accepted because every decoder falls back to the V1 parser when `GetHead` fails (AGENTCORE/a2a/extensions/versioned.go:23-30, e.g. environment_data_extension.go:86-89). Unknown keys are ignored: `DecodeMapWithValidation` uses plain `mapstructure.Decode` with no `ErrorUnused` (AGENTCORE/a2a/extensions/mapstructure.go:10-22), so `system_info.workspace_root` (OURS/.../metadata-builder.ts:78-84) is harmless. Bonus: because we do not stamp `data_type`, we sidestep the backend's skills-extension bug where it compares against `"skills"` instead of `"skill"` (BACKEND/internal/usecase/vibe/a2aextensions/skills_extension.go:79 vs constants.go:10).

**Recommendation.** No change — but do NOT start stamping `data_type` on outbound metadata as a "correctness" improvement: a correctly stamped `skills` item would be rejected by that backend bug. Keep the unstamped form until the backend fixes it.

### F30 [info] — verdict: info-not-verified

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **unchanged** — T3 kept the string re-marshal of `list_files.recursive` (and additionally accepts the empty root `path` the backend re-marshals), and T9 keeps `tool_result.content` always emitted, empty string included.

**Claim.** `list_files.recursive` arriving as a string and `tool_result.content` always being present are both already right — we happen to match two easily-missed backend requirements.

**Evidence.**
Backend rewrites `recursive` to a string before the call reaches the client, explicitly so the front-end format need not change (BACKEND/internal/usecase/vibe/agent/codeagent/tools.go:120-145 `fixListFilesArgs` → `strconv.FormatBool`, added by `96b2a7b` 2026-08-13); ours accepts boolean or `'true'`/`'false'` (OURS/packages/shared/src/agent/backend/nestor-cloud/tool-schema.ts:222-226) and again at local-tool-adapter.ts:80. Backend requires `content` on a tool result even when `error` is set (`Content *string \`validate:"required"\`` — AGENTCORE/a2a/extensions/tool_result.go:7-11); ours always sends `content: ''` and adds `error` only when set (turn.ts:172-176 → client.ts:247-260). Note we are stricter than the connector here, which omits `content` when undefined (CONNECTOR/src/adapter/a2a/utils.ts:36-37).

**Recommendation.** No change. Keep the always-present `content` when reworking the tool contract for F1/F2 — it is a hard server-side validation, not a convention.

### F31 [info] — verdict: info-not-verified

**Outcome (2026-08-22, plan `2026-08-22-nestor-cloud-contract-fix`):** **partly acted on** — T1 DELETED the dead `context_usage`/`compaction` parsers (zero hits across the backend repo, and our discriminator never matched the backend's `data_type` envelope anyway); attachments and `invocation_id` grouping are unchanged.

**Claim.** Attachments/images, `invocation_id` history grouping, and the dead `context_usage`/`compaction` parsers are non-issues; and the docs corpus cannot be used as a contract source.

**Evidence.**
Attachments: the backend has no code path that reads a FilePart (Report 1 §3.1, re-confirmed — parsing is TextPart/DataPart only in BACKEND/internal/usecase/vibe/mapping/message.go:22-40), so our ignoring `_attachments` (OURS/packages/shared/src/agent/nestor-cloud-agent.ts:62) loses nothing; composer already declares `images: 'no'`. `invocation_id` grouping is a requirement only for clients that replay history (BACKEND/internal/usecase/vibe/mapping/message.go:43-93); the backend rebuilds history itself from its Postgres task store, and we send no history — so our ignoring it is correct. Our `context_usage`/`compaction_start`/`compaction_end` parsers (event-adapter.ts:116-137) key on `data.type`, while every Nestor payload uses `data_type` — dead code, consistent with our declared `{kind:'unavailable', reason:'remote-not-reported'}` composer capability. Docs: DOCS states no protocol version (only a link to `/latest/`, DOCS/index.md:9), no method catalogue, no header names, no task lifecycle (Report 4 §6, items 1-6), and carries live contradictions (deprecated enums vs literals, DOCS/chat-component/cdn.md:167-171 vs DOCS/chat-component/imperativeApi.md:149).

**Recommendation.** No change. Treat `service/nestor` as the sole contract of record for this integration and cite it in code comments; the nessy-cloud docs are integration guides for the web SDK/CLI, not a wire specification. Consider deleting the dead context_usage/compaction parsers or repointing them at `data_type` if the backend ever adds such events.

---

# The cloud agent's corpus, started as a LIST (P2.335)

Date: 2026-09-08. Owner decision D17 (2026-09-05), option A: *a narrow lane on
the cloud agent's emission discipline, and the corpus starts as a list.*

## Why a list, and why it is here rather than in a page

`nestor-cloud-agent.ts` is the one runtime in this product with **no external
documentation corpus**. Claude has 191 published pages this repo checks itself
against; codex has an open source tree that outranks its own pages; the Nestor
remote agent has a backend whose contract this document already maps and
**nothing at all that says what our BACKEND OBJECT owes** — no equivalent of
`agent-loop.md`, no equivalent of `hooks.md`. So the standard it is held to has
to be **defined by us**, which is exactly what the stopping rule records, and a
definition that lives nowhere is a definition nobody can fail.

This is that definition, as a list. Each row names an obligation, the place the
standard comes from on the runtimes that DO have one, and the cloud agent's
verdict **with the date it was measured**. A row with no verdict is a row nobody
has swept — which is the state this list exists to make visible, and it is not
the same state as "conforming".

## 1. Emission discipline — SWEPT 2026-09-08, one defect found and fixed

**The standard.** From the floating-emission family (P2.73, P2.192, P2.274,
P2.284, P2.303, P2.304, P2.332, P2.333, P2.347 — all closed), pinned by
`packages/shared/src/agent/__tests__/floating-emission-escape.test.ts` and its
subprocess probe:

- every DETACHED promise carries a rejection handler, and that handler **names**
  the failure — `.catch(() => undefined)` closes the escape and throws away the
  half that makes it reportable;
- every teardown method (`destroy`, `disposeForRestart`, `abort`, `forceAbort`)
  is **total over its synchronous steps**, so a throwing step cannot skip the
  ones after it;
- the detector is a **plain `bun` subprocess**, because a user
  `unhandledRejection` listener is never consulted under `bun test` and the
  assertion the family was originally tracked with therefore could not fail.

**Method.** Every `void`, `.then(`, `.catch(`, `setTimeout` and teardown body in
`nestor-cloud-agent.ts` read by hand (the file is 800 lines), then the two new
probe scenarios below.

**Verdict.** Conforming at every detached site and every teardown step, and
failing at the one site that is **neither**:

| Class | Sites | Verdict |
| --- | --- | --- |
| Detached emissions (`void x.catch(named)`) | 5 — `forceAbort`, `destroy` ×2, `disposeForRestart`, `emitStopHookOnceDetached` | all named, through `reportCancelFault` / `reportDetachedFault` |
| Teardown totality (`runTeardownStep`) | `destroy` 5 steps, `disposeForRestart` 6, `abort` 4, `forceAbort` 4 | all isolated |
| **Awaited emission on the ordinary turn end** | 1 — `chatImpl`'s `finally` → `await this.emitStopHookOnce()` | **DEFECT, fixed by this row** |

The defect is worth stating in full, because its shape is why fifteen previous
sweeps missed it: **an awaited rejection is HANDLED by the await**, so nothing
is ever unhandled and `unhandledRejection` — the detector that found every other
site in the family — is blind to it by construction. The recorder inside
`emitStopHookOnce` was belted; the emission was not, and `emitAutomationEvent`
rejects whenever its own `onError` handler throws, which is the same mechanism
`destroy()` names two hundred lines above and belts against. The rejection left
the `finally`, skipping `toolExecutor.dispose()`, `processing = false`,
`abortController = null`, `toolExecutor = null` and `currentTurn = null` — so
`processing` stayed true and the session refused every later turn. The promise is
memoised, so the wedge was permanent for the session rather than transient.

Fixed at the source rather than at each call site: three consumers await or
detach the same memoised promise, and one of them was the one that was missed.
Pinned by `nestor:stopHookAwaited:emitRejects` and its `:rebroken` control.

## 2. Cancellation reaches the server, or nobody hears about it — PINNED, not swept

There is no server-side close-session RPC (F23 above), so `cancel()` is the
entire stop mechanism and a swallowed rejection is a live remote task nobody will
ever hear about again. One case pins it
(`nestor:cancelRejects`); the obligation is broader than that case and has not
been swept: every path that ends a turn owes a cancel that is either delivered or
NAMED.

## 3. Not swept — the rows that make this a corpus rather than a result

Listed so the next reader can tell "conforming" from "nobody has looked". None
of these has a verdict, and none should be assumed:

- **Tool-result secret scanning.** The other two runtimes route tool output
  through `scanToolResultForSecrets` (P6.574's named rules). Whether the cloud
  agent's tool results reach that scanner has not been measured.
- **Hook coverage.** Which of the documented automation events this backend
  emits, against the set the other two emit. `Stop` is implemented (P3.231);
  the rest is unenumerated.
- **Usage and quota.** `/quota` reads the remaining budget from the backend
  rather than inferring it. Whether the usage numbers this backend reports are
  the same SHAPE the switch-cost and `/usage` surfaces read has not been checked.
- **Permission floors.** The gate (`core/pre-tool-use.ts`) is host-side and
  shared, but which of its inputs this backend supplies — `plansFolderPath`,
  the session scratch directory, the worktree identity — has not been enumerated.
- **Context store durability.** `NestorCloudContextStore` writes the session
  path; its failure modes are not covered by any case in this list.

## 4. How to add to this list

A row is added when someone sweeps a class, whether the verdict is a defect or
conformance — a clean sweep with a date is the more valuable of the two here,
because on this runtime "clean" and "unlooked-at" are otherwise the same word.
State the method, state the date, and name the test that keeps the verdict true.
