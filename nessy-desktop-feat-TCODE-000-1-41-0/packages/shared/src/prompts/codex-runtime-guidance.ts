/**
 * P3.251 — the codex-specific prose that survived being measured, on the one
 * channel that reaches the codex model.
 *
 * ## What this replaces
 *
 * `prompts/system.ts` carried four `backendName === 'Codex'` sections. They were
 * emitted by `getSystemPrompt`, and codex never calls it: verified at HEAD by
 * `git grep -a` for `getSystemPrompt(`/`getNessyAssistantPrompt(` over
 * `packages` + `apps/electron/src` with tests excluded, which returns exactly
 * `claude-agent.ts` (passes `undefined` as `backendName`), `pi-agent.ts` (passes
 * `'Nessy Backend'`) and the dev printer (passes none) — the two real callers
 * ARE found on the same rig, which is the positive control that makes the
 * absence a reading. So all four blocks reached no runtime at all, and the
 * row's premise that "the other two runtimes have" this guidance is REFUTED:
 * the blocks sit inside the codex conditional, so Pi and Claude never had them
 * either.
 *
 * ## Two of the four were deleted rather than routed, because they are FALSE
 *
 *  - *### Planning tools (Codex)* told the model to call `SubmitPlan`. Codex
 *    does not have it: P3.238 DROVE the real `session-mcp-server` over MCP
 *    stdio under `CodexAgent.buildSessionMcpSpec`'s own argv and got 27 tools
 *    with no `SubmitPlan` (positive controls `advisor_consult`, `Monitor`,
 *    `source_test` present in the same answer), against 45 including it when
 *    `--external-standalone-only` is dropped. Routing that block would have
 *    instructed the model to call a tool it cannot see.
 *  - *Writing plan files (Codex)* said heredocs "are blocked by the sandbox".
 *    Nothing blocks them, on any runtime: at HEAD the only `<<` predicate in the
 *    tree is `isUnparseableCompoundCommand`
 *    (`config/background-task-settings.ts`), which decides whether a command can
 *    be AUTO-BACKGROUNDED, and codex runs its own shell without our bash rules
 *    at all (`runPreToolUseChecks` scores 0 in `codex-agent.ts`).
 *
 * ## The two that travel, and why only codex gets them
 *
 * The MCP naming rules are the one genuine per-runtime difference in what the
 * model must TYPE, so delivering them to codex alone is not a new divergence —
 * it is the host describing an existing one.
 *
 * F1.217 (origin WJ-v P-WJ-v-1) — and until then the block described it WRONG.
 * It told the model its pool tools were `mcp__sources__{slug}__{tool}`, its
 * session tools `mcp__session__{tool}`, and a discovery tool
 * `mcp__sources__{slug}__list_tools` that no server in this tree has ever
 * exposed. MEASURED on the shipped `codex-app-server` (`rust-v0.154.0`,
 * 2026-09-23, the real pool server + the real `session-mcp-server` +
 * `buildCodexConfigToml` + the real Responses adapter): codex files each MCP
 * server's tools under a NAMESPACE named after the server (`mcp__sources`,
 * `mcp__session`), and the function name inside it is the tool's own name
 * through `sanitize_responses_api_tool_name` — `<wire>__<tool>` for a pool tool
 * ({@link codexModelToolName}), the bare name for a session tool
 * (`source_test`, `remember`, …). The Nessy Gateway leg flattens the namespaces
 * away (`codex-responses-adapter/src/to-chat.ts`), so there the model is handed
 * the function name ALONE; a Responses-native provider shows the namespace
 * beside it, never joined into it. The names below are therefore RENDERED from
 * {@link codexModelToolName} and {@link CODEX_POOL_TOOL_NAMESPACE} rather than
 * spelled, so the sentence and the rule cannot drift apart again. SIT-11 A3's
 * codex model had answered the old spelling with "does not exist in my
 * available tools".
 *
 * The TRANSCRIPT row keeps codex's raw `(server, tool)` pair —
 * `mcp__sources__<wire>__<tool>`, hyphens and all
 * (`backend/codex/event-adapter.ts::mcpRowToolName`) — which is what a rule, a
 * hook and the UI read. That is the host's spelling, not the model's.
 *
 * The source-management guidance is delivered CORRECTED rather than verbatim.
 * The table in `system.ts` named four tools and codex has one: `source_test` is
 * `executionMode: 'registry'` with no host-callback dependency, while
 * `source_oauth_trigger`, `source_google_oauth_trigger` and
 * `source_credential_prompt` are all in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`
 * and in neither bridged set (`session-tools-core/src/tool-defs.ts`), so an
 * external standalone subprocess is not offered them. Shipping that table as
 * written would have told the codex model to call three tools it does not have
 * — which is the failure this row exists to stop, one layer further on.
 *
 * ## F1.718 — a refusal the host makes reads as the user's
 *
 * A v2 file-change decline and an MCP elicitation decline carry no reason
 * (`buildApprovalResponse`'s `rejection` reaches the v1 kinds only), so the
 * model is handed codex's own fixed words — `patch rejected by user`, `user
 * rejected MCP tool call` (`core/src/mcp_tool_call.rs` at `rust-v0.156.1`, read
 * by WJ-crit-gg for F1.779; each string occurs once in the shipped darwin-arm64
 * `codex-app-server`, read 2026-09-26) — whoever refused. F1.693's data-folder
 * floor refuses in every mode with a named sentence that reaches only the debug
 * log, and the SIT-l E21 model then told the user they had declined a patch they
 * never saw. Codex has no reason channel to enable (native-first asked and
 * answered: F1.779), so the host says it once here, where the model reads it.
 * The protected names are the floor's own (`codexDataFolderControlTarget`), and
 * a test refuses a name the floor would not; F1.375 already says the same for
 * the explore/plan MCP refusals in the per-turn mode line. F1.779 adds the
 * COMMAND half: a v2 `commandExecution` decline is `ReviewDecision::denied("rejected
 * by user")` (`app-server/src/bespoke_event_handling.rs`), which
 * `core/src/tools/events.rs` rewrites to `exec command rejected by user` for the
 * exec emitter, so a rule, a floor, `dontAsk` or an unattended turn refusing a
 * command reads as the user's too — plus the two levers the user holds, in the
 * words Pi and claude already use for `permissions.json` (Settings > Permissions,
 * `GUARDED_WORKSPACE_RECORDS` in `agent/core/pre-tool-use.ts`).
 *
 * ## Where it lands
 *
 * `codexDeveloperInstructions` (`agent/codex-agent.ts`), i.e. `thread/start`'s
 * `developerInstructions`. NOT `baseInstructions`: that field REPLACES codex's
 * whole 20,751-character base prompt, measured on the wire — the reason is
 * argued in full at that function.
 */

import { CODEX_POOL_TOOL_NAMESPACE, codexModelToolName } from '../capabilities/mcp-wire-name.ts';

/** The `[mcp_servers.…]` name codex is given for the host's source pool. */
const CODEX_POOL_SERVER_NAME = 'sources';

/** The namespace codex files the bundled session server's tools under (measured, F1.217). */
const CODEX_SESSION_TOOL_NAMESPACE = 'mcp__session';

/**
 * Codex-only runtime guidance, appended to the safety block in
 * {@link codexDeveloperInstructions}.
 *
 * A constant rather than a builder: nothing in it is per-session, and the string
 * is part of a prompt cached for the life of the thread.
 */
export const CODEX_RUNTIME_GUIDANCE = `## MCP Tool Naming (Codex)

MCP tools from connected sources reach you through ONE server, \`${CODEX_POOL_SERVER_NAME}\`. Call a source's tool by the source's slug and the tool's name joined with \`__\` — \`{slug}__{tool}\` — with every character that is not a letter, a digit or \`_\` written as \`_\`. Where your tools are grouped into namespaces, these sit in the \`${CODEX_POOL_TOOL_NAMESPACE}\` namespace; the namespace is never part of the name you call.

- \`slug\` is the source's **slug** from the \`<sources>\` block, not a source ID, a provider name, or a \`config.json\` \`id\` field.
- Example: a source with slug \`linear\` → \`${codexModelToolName('linear', 'list_issues')}\`; a slug with a hyphen, \`my-tracker\` → \`${codexModelToolName('my-tracker', 'list_issues')}\`.
- The bundled \`session\` server's tools are called by their own names, with no prefix — for example \`source_test\` (in the \`${CODEX_SESSION_TOOL_NAMESPACE}\` namespace where namespaces are shown).
- Documentation written for other runtimes may spell these \`mcp__{slug}__{tool}\` or \`mcp__session__{tool}\`. On this runtime drop that prefix and call the name above.

**Tool discovery:** a source's tools are the entries in your tool list whose names begin with \`{slug}__\`. If the tool you need is not there, say so — do not guess a name.
- Do NOT use \`list_mcp_resources\`: it lists resources, not tools.
- Do NOT use the shell to call an MCP tool. MCP tools are functions you call directly.
- After an OAuth sign-in completes, the source's tools become available on your NEXT turn. Call them; do not re-run a connectivity check to find out.

## Source Management (Codex)

\`source_test\` validates a source's config, connection and auth status. Run it **at most once** per source, before authentication — it validates config structure, so repeating it returns the same answer.

The tools that TRIGGER authentication — an OAuth flow, a Google sign-in, an API-key prompt — are not part of your tool surface on this runtime. When a source needs credentials, say so and ask the user to complete the sign-in from the app; do not search for a way to do it yourself.

When creating a source: write \`config.json\` under \`sources/{slug}/\`, add \`permissions.json\`, write \`guide.md\`, then run \`source_test\` once. When a source already exists, read its \`config.json\` and \`guide.md\` and use it — do not grep the workspace, search session files, or web-search for how it was set up.

If a source keeps failing with "Auth required" after a sign-in, the session needs the source re-enabled for the new credentials to take effect. Ask the user; do not retry the call or read log files.

## Refusals (Codex)

On this runtime a refused shell command reaches you as "exec command rejected by user", a refused file change as "patch rejected by user" and a refused MCP tool call as "user rejected MCP tool call" — and a refused escalated command can also come back as an "exec_command failed" error that says Rejected("rejected by user"), so read any refusal text that says "rejected by user" the same way — whoever refused it: the user declining an approval card, or Nessy refusing before any card was shown — for example by a permission rule, a denied path, a safety floor on a destructive command, the current mode, no one being present to answer the card, or because an existing file was not read in this conversation. One of Nessy's refusals holds in every permission mode, Bypass permissions included: the data-folder floor. No agent may change Nessy's own control files in its data folder — the codex homes (\`codex-home/\`), \`permissions/\`, the global \`hooks.json\`, \`mcp.json\`, \`config.json\` and \`credentials.enc\`, and the four records at the top level of any workspace folder — \`permissions.json\`, \`hooks.json\`, \`automations.json\` and \`automations-history.jsonl\` (a source's own permissions file is not one of them). So do not tell the user they declined something: say the action was refused, and when the file is one of these, that it is Nessy's own record, for the user to change from Nessy itself. If the user wants a refused action to run, the permission rules are theirs to change in Settings > Permissions and the permission mode is theirs to switch. Do not retry the action or work around the refusal with the shell.`;
