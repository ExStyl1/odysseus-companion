export type ToolEffect = 'read' | 'workspaceMutation' | 'externalMutation'
export type ToolRisk = 'low' | 'sensitiveRead' | 'codeExecution' | 'externalWrite'
export type ToolScheduling = 'parallel' | 'serialByScope' | 'exclusive'

export interface HarnessToolDescriptor {
  id: string
  schemaVersion: 1
  effect: ToolEffect
  risk: ToolRisk
  scheduling: ToolScheduling
  mutationScope?: 'workspace' | 'session' | 'external'
  sandboxProfile: 'workspace' | 'host' | 'none'
  backgroundable: boolean
  cancellable: boolean
  timeoutMs: number
  checkpointAdapter?: 'file'
}

export interface PiToolBinding {
  provider: 'pi'
  surfaceVersion: 2
  piName: string
  modelSchemaVersion: 1
  bindingName: string
  bindingSchemaVersion: 1
  handlerName?: string
  handlerSchemaVersion?: 1
  descriptorId: string
  permissionName: string
}

/**
 * P2.116 — WHERE THESE VALUES COME FROM, because two implementers in a row have
 * cited the wrong test for them. Every entry is typed in by hand, and they are
 * DERIVED-COMPARED rather than merely copied:
 * `packages/pi-agent-server/src/harness/live-manifest-contract.test.ts`
 * recomputes them with `hashProjectedPiToolDefinition` — the EXACT comparison
 * `projectPiManifestTools` makes before throwing "Pi execution manifest model
 * contract mismatch" — across four live manifest compositions and every child
 * tool-pool. That test is what a red pin here must be answered with.
 *
 * With ONE limit, stated because overstating it is the very habit this comment
 * exists to break: both of that test's loops skip on `if (!pin) continue` /
 * `if (!definition) continue`, so a `bindingName` that appears in NO
 * composition it builds is silently not compared. That hole is not
 * hypothetical — its own comment records `mcp__tool_search` and
 * `mcp__tool_load` sitting "never compared against anything" until a fourth
 * composition was added for them. So: derived, yes; "every entry", only for
 * entries the compositions actually carry.
 *
 * The Pi harness baseline test does NOT derive these. Its
 * `expect(row.modelContractHash).toBe(getPiStaticModelContractHash(...))`
 * compares a fixture value with this constant, so it proves the two copies
 * agree and nothing about the live surface. Do not cite it as the guard.
 *
 * Distinct again from the `source-state-schema` digests in
 * `fixtures/tool-surface.json` (see `pi-agent-server/src/harness/source-state-contract.ts`):
 * those hash a factory's whole SOURCE TEXT, so they move on an implementation
 * edit that the model never sees — and correctly move without these.
 */
export const PI_STATIC_MODEL_CONTRACT_HASHES: Readonly<Record<string, string>> = Object.freeze({
  read: '25728b85748e6840cda2ea75edf07926fb7b30e32b8026e1ddf08dd6ace37fa8',
  // The session-tool wire-name unification moved `ProcessStop`'s model-facing
  // name, and this schema's `run_in_background` text names it for the model
  // (`runtime-backed-tools.ts`). A pinned copy of another tool's name moves with
  // that name — these two pins are the whole of the churn the rename caused.
  //
  // Moved again by P6.329 (this pin only, not `bash_background`): the
  // `dangerouslyDisableSandbox` description now names the SHAPE of a sandbox
  // denial — a bare `Operation not permitted` with no path in it, a connection
  // or name-resolution failure with no host in it — because the layer below
  // states neither, so the old "after a run has already failed for that reason"
  // asked the model to recognise something nothing tells it. Model-visible text,
  // therefore a new pin.
  bash: 'b37b294a7f49ce4206a95df1e9e2c21348817edec51f17e9e5b3bc3f22082008',
  // Same cause as `bash` above: this tool's promptSnippet (`background-bash.ts`)
  // names `mcp__session__ProcessStop` for the model.
  bash_background: 'b26ebe640efea6c6b9d356359b5487d7835b1d789580643d8d01a618dbd369c9',
  edit: '9ae3c184285bb1ba9f3bb9ec380f0d524d5f2ee6c0ee6d2101094ee645a03647',
  write: 'ccab55f016e216ec1a90df800815991f953344a1d3113b467bd064080fc90350',
  grep: 'f9a700237bfbdcffe45db5b755139c8c22a02f9a8ab9c0f22de0eb5fb57fd6fe',
  find: '9d72f93c00f09ba0ac55bd611927317710ff0746b4e9d655fb5d7ec9f00ce4e0',
  ls: '0ee55cdf68d8509a36bc205c060ba58b0245751083607fe5df00b2f344b7ade5',
  NotebookEdit: '7d989795962d937049625bf616d04c73b26201b8b004d11812dd1587610503aa',
  // Q10-3 — the presentation rewrite became word-boundary-aware, so this text's
  // "Returns titles, URLs, and snippets" stopped reaching the model as `URls`.
  // Model-visible, therefore a new pin.
  web_search: '6c8c15fd82d91b5f4e1159b0f54624fcee8b36742ea7fdf5d3d68fdac419213d',
  // P6.802 — re-pinned 2026-09-08. `7a459959b` put web fetch's extraction step
  // behind the opt-in the tool already had, which rewrote the `prompt`
  // parameter's description; that text is model-visible, so the projected
  // contract moved and this pin did not follow it. Left stale, `registry.ts`'s
  // own check and `projectPiManifestTools` both refuse the tool by name
  // ("Pi execution manifest model contract mismatch for web_fetch"), so this is
  // a shipped drift rather than a fixture one — `tool-surface.json`'s
  // `web.fetch` row carries the same value and moves with it.
  web_fetch: '951c17281f2f732be3daece6516fbf5cf67d4f3ee00b0499c1a55be89008b815',
  subagent: 'fdc18e4d328b090f92f930ce2ca259bcf3cf7c3bf9bbf07d01683d9543ba5a43',
  // sub-agents.md:783 — under fork mode the `subagent` tool loses its
  // `background` parameter (Claude's `run_in_background`) and gains the fork
  // guidance, so it is a DIFFERENT model-visible contract and needs its own pin.
  // `piStaticModelContractPinKey` picks between the two from the manifest's
  // `orchestrator.forkSubagent`, which host and subprocess both read, so the two
  // sides cannot select different shapes.
  'subagent:fork-mode': '800117d25c87bfbd8868425351bed1049b2ca48ae51583c50ac5678d9cfdf705',
  // R71 — `code-review.md:293` widened the target grammar (upstream default,
  // ref range, file paths, explicit scope) and added a per-run `effort`, all of
  // which are model-visible, so this pin moved with them.
  //
  // Moved again by P6.308: the tool gained an opt-in `background` parameter, so
  // the model can now ask for the composer back and take the findings on the
  // completion notice. A parameter is model-visible by definition, which is the
  // whole reason this pin and the source-state digest are separate gates.
  //
  // Moved again 2026-09-11 (W11-pi, found while landing P7.3) — and this one was
  // a LIVE DEFECT, not a stale record. `d0e61e7ff` (P6.798) flipped the default
  // and rewrote the `background` parameter's DESCRIPTION, which is model-visible,
  // then re-pinned only the source-state digest in `tool-surface.json`. That is
  // exactly the split `source-state-contract.ts`'s own failure report warns
  // about: an implementation-only edit moves that digest alone, a model-facing
  // edit must move THIS table too. Because `harness-manifest.ts` builds the
  // PRODUCTION manifest from `getPiStaticModelContractHash`, every live Pi
  // session carrying `review` died on its FIRST turn with `Pi execution manifest
  // model contract mismatch for review` from 2026-09-10 until this line moved —
  // instance fifteen of the failure `live-manifest-contract.test.ts` exists to
  // catch, and that guard was red at HEAD the whole time because nobody ran it.
  // Rebuild and restage after moving this line: the same guard checks that both
  // built bundles embed the CURRENT table.
  review: '2b8a03965276ce39040f65b7d0eca152e45a1e32e1e385d44d200b6309550a48',
  get_subagent_result: '20d48076c69bf2f5ca51627a8e0a93a353fe8b4227c0e7c9661c87e7a7254562',
  steer_subagent: 'a475f0427319df8bb5f5bbd16118ce93b5d4a1f1734e1a35b3b170c5fdf45a51',
  stopTask: 'b64fc1e32a352311067963b780830ed679f7483a78aeb713ee74cf57db03b1d4',
  // Q10-3 — same cause as `web_search` above: "paths, URLs, and inline source
  // are rejected" no longer reaches the model as `URls`.
  workflow: 'ec8102d8017841992635718de4b10bad794cd86533a3b24f493a853ca2049f46',
  ask_user: 'feaab99af81a34bc139a44eac222047b14668ebf9b913419290688c4fcf141a3',
  mcp__tool_search: '5cc4f298da736e22a69112b3124dcfead3fa89629433ccc6ba4b83c8097a4cd1', // F1.197: no longer 'MCP-only'
  // F1.803 (2026-09-25) — the description and prompt snippet promise the
  // loaded tool from the model's NEXT STEP of the same request again, and it is
  // true now: T15 (2026-08-21) had withdrawn that promise because the live
  // session's `tools` allowlist dropped the registered tool, which was the
  // defect, not Pi (measured on the real subprocess). Model-visible text, so
  // this pin moved; the host and the subprocess bundle must be rebuilt
  // TOGETHER, or every deferred-tool session dies on its first turn.
  mcp__tool_load: 'd3b734fce654803b60018f7fcc17c0ab828b76fcd0a98ee8f24b85a776cd3da6', // F1.197, then F1.803
})

export function getPiStaticModelContractHash(bindingName: string): string {
  const value = PI_STATIC_MODEL_CONTRACT_HASHES[bindingName]
  if (!value) throw new Error(`Missing Pi static model contract hash: ${bindingName}`)
  return value
}

const read = (id: string, overrides: Partial<HarnessToolDescriptor> = {}): HarnessToolDescriptor => ({
  id,
  schemaVersion: 1,
  effect: 'read',
  risk: 'sensitiveRead',
  scheduling: 'parallel',
  sandboxProfile: 'workspace',
  backgroundable: false,
  cancellable: true,
  timeoutMs: 120_000,
  ...overrides,
})

const mutate = (id: string, overrides: Partial<HarnessToolDescriptor> = {}): HarnessToolDescriptor => ({
  id,
  schemaVersion: 1,
  effect: 'workspaceMutation',
  risk: 'externalWrite',
  scheduling: 'serialByScope',
  mutationScope: 'workspace',
  sandboxProfile: 'workspace',
  backgroundable: false,
  cancellable: true,
  timeoutMs: 120_000,
  ...overrides,
})

const external = (id: string, overrides: Partial<HarnessToolDescriptor> = {}): HarnessToolDescriptor => ({
  id,
  schemaVersion: 1,
  effect: 'externalMutation',
  risk: 'externalWrite',
  scheduling: 'serialByScope',
  mutationScope: 'external',
  sandboxProfile: 'host',
  backgroundable: false,
  cancellable: true,
  timeoutMs: 120_000,
  ...overrides,
})

export const HARNESS_TOOL_DESCRIPTORS: readonly HarnessToolDescriptor[] = Object.freeze([
  read('read'),
  read('grep'),
  read('find'),
  read('ls'),
  mutate('write', { checkpointAdapter: 'file' }),
  mutate('edit', { checkpointAdapter: 'file' }),
  mutate('notebook_edit', { checkpointAdapter: 'file' }),
  mutate('bash', { risk: 'codeExecution', backgroundable: true }),
  mutate('bash_background', { risk: 'codeExecution', backgroundable: true }),
  read('web_search', { sandboxProfile: 'host' }),
  read('web_fetch', { sandboxProfile: 'host' }),
  external('subagent', { risk: 'codeExecution', backgroundable: true }),
  external('review', { risk: 'codeExecution' }),
  read('get_subagent_result', { sandboxProfile: 'none' }),
  external('steer_subagent', { mutationScope: 'session', sandboxProfile: 'none' }),
  external('stop_task', { scheduling: 'exclusive' }),
  external('workflow', { risk: 'codeExecution', backgroundable: true }),
  read('ask_user', { risk: 'low', scheduling: 'exclusive', sandboxProfile: 'none' }),
  read('mcp_tool_search', { sandboxProfile: 'host' }),
  mutate('mcp_tool_load', { mutationScope: 'session', sandboxProfile: 'host' }),
  read('lsp', { sandboxProfile: 'workspace' }),
  // CI1 formatter dispatch: formats a workspace file in place with the
  // project's own configured formatter (host binary, no LSP required).
  mutate('format', { checkpointAdapter: 'file' }),
  external('submit_plan', { mutationScope: 'session', scheduling: 'exclusive' }),
  read('config_validate'),
  read('skill_validate'),
  read('mermaid_validate'),
  mutate('source_test', { mutationScope: 'session', sandboxProfile: 'host' }),
  // D3: disable flips a config flag; remove deletes the source and revokes it
  // from live sessions — a workspace-scoped mutation, host-side.
  mutate('source_manage', { mutationScope: 'workspace', sandboxProfile: 'host' }),
  external('source_oauth_trigger'),
  external('source_google_oauth_trigger'),
  external('source_credential_prompt'),
  external('update_user_preferences', { mutationScope: 'session' }),
  external('remember', { mutationScope: 'session' }),
  external('todo_write', { mutationScope: 'session' }),
  external('task', { mutationScope: 'session', scheduling: 'exclusive' }),
  // R20. The three writers serialize on one list, so they share the legacy
  // task tool's exclusive scheduling; the two readers are plain reads.
  external('task_create', { mutationScope: 'session', scheduling: 'exclusive' }),
  external('task_update', { mutationScope: 'session', scheduling: 'exclusive' }),
  read('task_get', { risk: 'low', sandboxProfile: 'none' }),
  read('task_list', { risk: 'low', sandboxProfile: 'none' }),
  read('goal_get', { risk: 'low', sandboxProfile: 'none' }),
  external('goal', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
  read('transform_data', { sandboxProfile: 'host' }),
  mutate('script_sandbox', { risk: 'codeExecution', sandboxProfile: 'host' }), // F1.107 · the RISK CLASS; `tool-defs.ts`'s `safeMode: 'allow'` is the separate MODE GATE, earned by the unconditional isolation.
  read('render_template', { sandboxProfile: 'host' }),
  external('send_developer_feedback'),
  read('call_llm', { sandboxProfile: 'host' }),
  external('spawn_session', { risk: 'codeExecution', backgroundable: true }),
  external('browser_tool'),
  external('slash_command', { risk: 'codeExecution' }),
  read('bash_output'),
  external('process_stop', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
  // A monitor's `command` source runs a shell script under the SAME workspace
  // isolation profile `bash_background` gets, which is why its risk is
  // codeExecution and not `low`.
  external('monitor', { risk: 'codeExecution', backgroundable: true, sandboxProfile: 'workspace' }),
  // Entering or leaving a worktree relocates the session's working directory
  // and write access, so it is a session mutation and must not interleave with
  // a tool that already resolved a path against the old cwd.
  external('enter_worktree', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
  external('exit_worktree', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
  // P6.508/P6.803 — the batch fan-out. Its two siblings above relocate THIS
  // session's cwd; the batch does not — it creates N new sessions, each with its
  // own worktree and branch, so the mutation it performs is the workspace's
  // repository rather than the caller's directory. It still schedules
  // `exclusive` because the branches and the worktree leases it adds come off
  // the same repository `enter_worktree`/`exit_worktree` are moving through, and
  // `codeExecution` because every unit it starts is an agent with tools — the
  // same reading `spawn_session` gets. `sandboxProfile: 'none'`: the fan-out is
  // host-side (`SessionManager.runWorktreeBatch`), not workspace-sandboxed.
  external('worktree_batch', {
    mutationScope: 'workspace',
    risk: 'codeExecution',
    scheduling: 'exclusive',
    sandboxProfile: 'none',
  }),
  external('set_session_labels', { mutationScope: 'session' }),
  external('set_session_status', { mutationScope: 'session' }), external('create_board_task', { mutationScope: 'workspace', sandboxProfile: 'none' }), external('project_memory_append', { mutationScope: 'workspace', sandboxProfile: 'none' }), ...pageToolDescriptors(), // UA3.5 — a host-side task (yaml + orchestrator), never run; UB1.12 — a host-side O_APPEND into projects/<slug>/MEMORY.md, never workspace-sandboxed (same-line insertion: the array sits above the file's highest cited line); UA6.3 — the six page tools (declared at the file end)
  read('get_session_info'),
  read('list_sessions'),
  // Read-only MCP resource surface: no workspace filesystem, no permission. The
  // read goes through the host-owned MCP pool, not the workspace sandbox.
  read('list_mcp_resources', { risk: 'low', sandboxProfile: 'none' }),
  read('read_mcp_resource', { sandboxProfile: 'none' }),
  // UB7.11 — the MCP prompt pair (upstream v0.15.1): same shape as the resource
  // pair above — the resolution is host-side (`ctx.mcpSources`: the enabled-
  // source check, the pool reads, the rendering, the large-result guard), never
  // workspace-sandboxed, and the tools are read-only in tool-defs (`safeMode:
  // 'allow'`, `readOnly: true`).
  read('source_list_prompts', { risk: 'low', sandboxProfile: 'none' }),
  read('source_get_prompt', { sandboxProfile: 'none' }),
  // UB6.11 — the decide tool (upstream v0.15.1): read-only in tool-defs
  // (`safeMode: 'allow'`, `readOnly: true`), the resolution is host-side
  // (`ctx.decide`), never workspace-sandboxed.
  read('decide', { risk: 'low', sandboxProfile: 'none' }),
  // R17: serves bytes already pinned in the session's own skill snapshot. It
  // touches no workspace filesystem — the one file read it performs is a drift
  // check through the capability materializer, which owns its own containment.
  read('read_skill_resource', { risk: 'low', sandboxProfile: 'none' }),
  read('automation_list'),
  read('automation_validate'),
  external('automation_create'),
  external('automation_update'),
  external('send_agent_message'),
  external('mcp_dynamic'),
  read('plugin_plan_install', { sandboxProfile: 'host' }),
  external('plugin_install'),
  read('plugin_status', { sandboxProfile: 'host' }),
  external('plugin_manage'),
  // R27a. `ReportFindings` reaches nothing: no host port, no filesystem, no
  // network — it shapes its own result and returns. `read` with no sandbox
  // profile is the honest classification, and it keeps findings parallel with
  // the reads a review turn is already running.
  read('report_findings', { risk: 'low', sandboxProfile: 'none' }),
  // UA1.18 — publish reads a workspace file and sends it off the machine (send_user_file's classification); list reads host rows.
  external('publish_artifact', { sandboxProfile: 'workspace' }), read('list_artifacts', { risk: 'low', sandboxProfile: 'host' }),
  // The OS notification centre is outside the sandbox and the transcript, so this is an external mutation however
  // small the payload; `serialByScope` (the `external` default) is enough — the host rate limit bounds a loop.
  external('push_notification', { sandboxProfile: 'none' }),
  // Reads workspace files (under its own containment check) and hands them to
  // a surface outside the transcript, so it carries the workspace sandbox
  // profile while staying an external mutation.
  external('send_user_file', { sandboxProfile: 'workspace' }),
  // R27b. Scheduling writes the session's task list under the project root and
  // arms a turn that runs after this one — a session mutation, and `exclusive`
  // for the reason `task_create`/`goal` are: the three serialize on one list and
  // must not interleave with each other. No workspace sandbox is involved; the
  // store path is host-owned and the model never names it.
  external('cron_create', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
  external('cron_delete', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
  // P6.295 arm (2) / P6.803. `CronControl` pauses, resumes, runs now or marks
  // read ONE record of the same list the two above write, so it carries their
  // classification verbatim. It shipped as a binding with no descriptor and was
  // found by the completeness guard this row added, not by a live run.
  external('cron_control', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
  read('cron_list', { risk: 'low', sandboxProfile: 'none' }),
  // R39. `ScheduleWakeup` rewrites the same session task list the three cron
  // tools serialize on (it re-arms or deletes the self-paced loop's record),
  // so it carries their exact classification.
  external('schedule_wakeup', { mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' }),
])

const binding = (
  descriptorId: string,
  piName: string,
  bindingName = piName,
  handlerName = bindingName.replace(/^mcp__session__/, ''),
  permissionName = handlerName,
): PiToolBinding => ({
  provider: 'pi',
  surfaceVersion: 2,
  piName,
  modelSchemaVersion: 1,
  bindingName,
  bindingSchemaVersion: 1,
  handlerName,
  handlerSchemaVersion: 1,
  descriptorId,
  permissionName,
})

/**
 * A session tool's model-facing name is its registry id verbatim, under the
 * `mcp__session__` server segment — byte-identical to what the Claude Agent SDK
 * mints for the same tool (`createSdkMcpServer({ name: 'session' })` +
 * `tool(<registry id>)`, `session-scoped-tools.ts`), and to what the Codex
 * binary mints from the bundled `[mcp_servers.session]` entry.
 *
 * `piName` used to be `mcp__session__${descriptorId}` — the snake_case
 * transform — which gave 22 of the 55 session tools a THIRD spelling that no
 * other runtime used, for no gain: the descriptor id is an internal
 * classification key, and the definition-lookup key (`bindingName`) was already
 * the registry spelling. Collapsing the two makes one canonical
 * `mcp__session__*` list every runtime, and the deferred llm-proxy allowlist,
 * can register as ONE set. `session-tool-wire-parity.test.ts` is the fence.
 *
 * Old sessions recorded the snake spelling on disk; `pi-legacy-ingress.ts`
 * normalizes those forward at read time, so this is not a history break.
 */
const sessionBinding = (descriptorId: string, handlerName: string): PiToolBinding => binding(
  descriptorId,
  `mcp__session__${handlerName}`,
  `mcp__session__${handlerName}`,
  handlerName,
  handlerName,
)

export const PI_TOOL_BINDINGS: readonly PiToolBinding[] = Object.freeze([
  binding('read', 'read', 'read', 'read', 'Read'),
  binding('bash', 'bash', 'bash', 'bash', 'Bash'),
  binding('bash_background', 'bash_background', 'bash_background', 'bash_background', 'Bash'),
  binding('edit', 'edit', 'edit', 'edit', 'Edit'),
  binding('write', 'write', 'write', 'write', 'Write'),
  binding('grep', 'grep', 'grep', 'grep', 'Grep'),
  binding('find', 'find', 'find', 'find', 'Find'),
  binding('ls', 'ls', 'ls', 'ls', 'Ls'),
  binding('notebook_edit', 'notebook_edit', 'NotebookEdit', 'NotebookEdit', 'NotebookEdit'),
  binding('web_search', 'web_search', 'web_search', 'web_search', 'WebSearch'),
  binding('web_fetch', 'web_fetch', 'web_fetch', 'web_fetch', 'WebFetch'),
  binding('subagent', 'subagent'),
  binding('review', 'review'),
  binding('get_subagent_result', 'get_subagent_result'),
  binding('steer_subagent', 'steer_subagent'),
  // tools-reference.md's opening rule ("The tool names are the exact strings
  // you use in permission rules, subagent tool lists, and hook matchers") plus
  // its table row `TaskStop` and permissions.md:158 ("the tool labeled `Stop
  // Task` in the transcript has the canonical name `TaskStop`. Permission rules
  // and hook matchers match the canonical name only") bind the permission/hook
  // axis to `TaskStop`. Only the 5th argument moves: piName/descriptorId stay
  // `stop_task` and bindingName/handlerName stay `stopTask` because those are
  // Pi's own wire names (pi-agent-server subagent-tool.ts `name: 'stopTask'`)
  // and PI_STATIC_MODEL_CONTRACT_HASHES is keyed by bindingName, which must not
  // move. The subagent tool-list axis resolves via the `taskstop` alias in
  // PI_RUNTIME_AGENT_TOOL_ALIASES.
  binding('stop_task', 'stop_task', 'stopTask', 'stopTask', 'TaskStop'),
  binding('workflow', 'workflow'),
  binding('ask_user', 'ask_user'),
  binding('mcp_tool_search', 'mcp__tool_search'),
  binding('mcp_tool_load', 'mcp__tool_load'),
  binding('lsp', 'lsp'),
  binding('format', 'format'),
  sessionBinding('submit_plan', 'SubmitPlan'),
  sessionBinding('config_validate', 'config_validate'),
  sessionBinding('skill_validate', 'skill_validate'),
  sessionBinding('mermaid_validate', 'mermaid_validate'),
  sessionBinding('source_test', 'source_test'),
  sessionBinding('source_manage', 'source_manage'),
  sessionBinding('source_oauth_trigger', 'source_oauth_trigger'),
  sessionBinding('source_google_oauth_trigger', 'source_google_oauth_trigger'),
  sessionBinding('source_credential_prompt', 'source_credential_prompt'),
  sessionBinding('update_user_preferences', 'update_user_preferences'),
  sessionBinding('remember', 'remember'),
  sessionBinding('todo_write', 'TodoWrite'),
  sessionBinding('task', 'Task'),
  sessionBinding('task_create', 'TaskCreate'),
  sessionBinding('task_update', 'TaskUpdate'),
  sessionBinding('task_get', 'TaskGet'),
  sessionBinding('task_list', 'TaskList'),
  sessionBinding('goal_get', 'GoalGet'),
  sessionBinding('goal', 'Goal'),
  sessionBinding('transform_data', 'transform_data'),
  sessionBinding('script_sandbox', 'script_sandbox'),
  sessionBinding('render_template', 'render_template'),
  sessionBinding('send_developer_feedback', 'send_developer_feedback'),
  sessionBinding('call_llm', 'call_llm'),
  sessionBinding('spawn_session', 'spawn_session'),
  sessionBinding('browser_tool', 'browser_tool'),
  sessionBinding('slash_command', 'SlashCommand'),
  sessionBinding('bash_output', 'BashOutput'),
  sessionBinding('process_stop', 'ProcessStop'),
  // permissionName stays 'Monitor' deliberately. Presenting it as 'Bash' would
  // make Bash rules match but would also relabel every monitor as a Bash call
  // and make `deny Monitor` unmatchable. The Bash-rule inheritance the docs
  // require is implemented where the rules are actually matched — the two bash
  // matchers in permission-dsl.ts admit semanticId 'monitor'.
  sessionBinding('monitor', 'Monitor'),
  // tools-reference.md opens with "The tool names are the exact strings you use
  // in permission rules, subagent tool lists, and hook matchers", so the
  // handlerName — which is also the permissionName — must be the documented
  // spelling verbatim. That alone makes an imported `EnterWorktree` permission
  // rule match; the subagent tool-list side needs the alias entry in
  // PI_RUNTIME_AGENT_TOOL_ALIASES as well.
  sessionBinding('enter_worktree', 'EnterWorktree'),
  sessionBinding('exit_worktree', 'ExitWorktree'),
  // P6.508 — the batch fan-out, beside its two siblings.
  sessionBinding('worktree_batch', 'WorktreeBatch'),
  sessionBinding('set_session_labels', 'set_session_labels'),
  sessionBinding('set_session_status', 'set_session_status'),
  sessionBinding('get_session_info', 'get_session_info'),
  sessionBinding('list_sessions', 'list_sessions'),
  sessionBinding('list_mcp_resources', 'list_mcp_resources'),
  sessionBinding('read_mcp_resource', 'read_mcp_resource'),
  sessionBinding('read_skill_resource', 'read_skill_resource'),
  sessionBinding('automation_list', 'automation_list'),
  sessionBinding('automation_validate', 'automation_validate'),
  sessionBinding('automation_create', 'automation_create'),
  sessionBinding('automation_update', 'automation_update'),
  sessionBinding('send_agent_message', 'send_agent_message'),
  sessionBinding('plugin_plan_install', 'plugin_plan_install'),
  sessionBinding('plugin_install', 'plugin_install'),
  sessionBinding('plugin_status', 'plugin_status'),
  sessionBinding('plugin_manage', 'plugin_manage'),
  sessionBinding('report_findings', 'ReportFindings'),
  sessionBinding('push_notification', 'PushNotification'),
  sessionBinding('send_user_file', 'SendUserFile'),
  sessionBinding('cron_create', 'CronCreate'),
  sessionBinding('cron_list', 'CronList'),
  sessionBinding('cron_delete', 'CronDelete'),
  // P6.295 arm (2) — the fifth cron tool.
  sessionBinding('cron_control', 'CronControl'),
  // R39 — the documented spelling verbatim, for permission rules and subagent
  // tool lists (tools-reference.md's opening rule), like the cron three above.
  sessionBinding('schedule_wakeup', 'ScheduleWakeup'),
  // UA1.18 — the t-artifacts pair; the documented spelling is the tool's own name.
  sessionBinding('publish_artifact', 'publish_artifact'),
  sessionBinding('list_artifacts', 'list_artifacts'),
  // UA3.5 — the board task tool; the documented spelling is the tool's own name.
  sessionBinding('create_board_task', 'create_board_task'),
  // UB1.12 — the append-only project-memory note; the documented spelling is the tool's own name.
  sessionBinding('project_memory_append', 'project_memory_append'),
  // UB7.11 — the MCP prompt pair; the documented spelling is the tool's own name.
  sessionBinding('source_list_prompts', 'source_list_prompts'),
  sessionBinding('source_get_prompt', 'source_get_prompt'),
  sessionBinding('decide', 'decide'), // UB6.11
  // UA6.3 — the six page tools; the documented spelling is the tool's own name.
  sessionBinding('list_pages', 'list_pages'),
  sessionBinding('get_page', 'get_page'),
  sessionBinding('create_page', 'create_page'),
  sessionBinding('update_page', 'update_page'),
  sessionBinding('write_page_data', 'write_page_data'),
  sessionBinding('delete_page', 'delete_page'),
])

/**
 * F1.1111 (origin DN-078, the Pi mirror of F1.833) — Pi tools whose Claude counterpart has ANOTHER name, keyed by Pi
 * binding name, valued by Claude's tool name; `session-tool-rule-alias.ts` judges a Pi call under both (its
 * `piSessionToolRuleAlias` carries the full reasoning). F1.1083 moved the table HERE so the rule parser's known names
 * ({@link PERMISSION_RULE_TOOL_NAMES}) include the Claude names it binds: a managed `claudeRules` entry naming
 * `AskUserQuestion` (or `Glob`, `Agent`, `ToolSearch`, the MCP resource tools) was refused as
 * `claude_rule.unknown_tool` although the rule binds Pi's tool of that meaning.
 */
export const PI_BUILTIN_CLAUDE_RULE_NAMES: ReadonlyMap<string, string> = new Map([
  ['find', 'Glob'],
  ['subagent', 'Agent'],
  ['ask_user', 'AskUserQuestion'],
  ['mcp__tool_search', 'ToolSearch'],
  ['mcp__tool_load', 'ToolSearch'],
  ['mcp__session__list_mcp_resources', 'ListMcpResourcesTool'],
  ['mcp__session__read_mcp_resource', 'ReadMcpResourceTool'],
])
const PI_BUILTIN_CLAUDE_RULE_NAMES_VALUES = (): string[] => [...PI_BUILTIN_CLAUDE_RULE_NAMES.values()]

/**
 * Every canonical name a `kind: 'tool'` permission rule can actually match.
 *
 * `permission-dsl.ts` compares a tool rule against BOTH the request's
 * `semanticId` (the descriptor id) and its `toolName` (the binding's
 * `permissionName`), so both spellings belong here — and nothing else does.
 * tools-reference.md opens with "The tool names are the exact strings you use in
 * permission rules, subagent tool lists, and hook matchers", which is why
 * `permissionName` is the documented half.
 *
 * This is the list `ParseClaudeRuleOptions.knownToolNames` wants: permissions.md
 * specifies that "a deny or ask rule whose tool name matches no known tool
 * produces a startup warning to catch typos". Dynamically registered MCP proxy
 * and plugin tools are absent on purpose — every one of them carries `_` or
 * `mcp__`, which the parser exempts from the check.
 */
export const PERMISSION_RULE_TOOL_NAMES: readonly string[] = Object.freeze(
  [...new Set([
    ...PI_TOOL_BINDINGS.flatMap(binding => [binding.permissionName, binding.descriptorId]),
    ...PI_BUILTIN_CLAUDE_RULE_NAMES_VALUES(), // F1.1083
  ])].sort(),
)

/** UB12.5 — a host spelling that is also lowercase prose; see {@link PI_TOOL_PRESENTATION_REWRITES}. */
const PROSE_WORD_SPELLING = /^[a-z]+$/

/**
 * Every host spelling a model-facing text may mention, mapped to the piName the
 * model actually sees — longest name first, so `stopTask` is rewritten before
 * the `Task` inside it.
 *
 * Derived from the static binding REGISTRY, not from a session's manifest, and
 * that is the whole of Q6-D1. `projectPiToolDefinition` used to build this set
 * from `manifest.tools`, which made a pinned tool's projected text depend on
 * WHICH OTHER TOOLS the session carried: `subagent`'s guidance names `stopTask`,
 * so a parent (whose pool has `stop_task`) hashed the rewritten text while a
 * child whose author wrote `tools: Read, Grep, Agent` hashed the unrewritten one
 * and died on its FIRST turn with `Pi execution manifest model contract mismatch
 * for subagent` — measured live on the packaged 1.25.1, and reproducible at
 * every checkout back to 2026-08-08.
 *
 * A child's pool is an ARBITRARY SUBSET an agent author writes, so "keep
 * rewritable names out of pinned text" cannot be kept by inspection: the
 * spellings include ordinary English words (`Read`, `Write`, `Edit`, `Find`,
 * `Task`, `Ls`). Making the rewrite a property of the registry makes the
 * model-visible contract identical in every session, parent or child, which is
 * exactly what a single pinned hash per tool asserts.
 *
 * The set is unchanged for a session that carries every tool — the composition
 * the pins were computed for — because dynamic MCP bindings set
 * `piName === bindingName` and so contribute no rewrite at all.
 *
 * Ambiguous spellings are dropped, not guessed: `Bash` is the permissionName of
 * both `bash` and `bash_background`, so it is rewritten nowhere rather than
 * somewhere.
 *
 * A spelling that is ALSO ordinary lowercase prose is dropped for the same
 * reason — ambiguous with the language the texts are written in (UB12.5,
 * 2026-10-16). Every host spelling a text means to name carries a capital
 * (`stopTask`, `Task`, `Ls`) or an underscore (`call_llm`); one with neither
 * (`/^[a-z]+$/`) cannot be told apart from the English verb. UB6.11 added the
 * `decide` session tool, whose handler and permission spelling is that bare
 * verb, and from then on `ask_user`'s pinned snippet ("you need the user to
 * decide before continuing") reached the model as "… to mcp__session__decide
 * …": its projected hash left `PI_STATIC_MODEL_CONTRACT_HASHES.ask_user`, and
 * the production manifest refused every Pi session carrying `ask_user` with
 * `Pi execution manifest model contract mismatch for ask_user` (measured:
 * `live-manifest-contract.test.ts` 2 pass / 4 fail at `00755e14f`). The same
 * rewrite turned `SendUserFile`'s "let the client decide" and, since `remember`
 * landed, `update_user_preferences`'s "helpful to remember" into tool names. No
 * model-facing text names either tool by the bare word (searched
 * `session-tools-core`, `pi-agent-server`, `pi-harness`: comments only), so the
 * drop loses no real mention; the pins are the ones computed before `decide`.
 */
export const PI_TOOL_PRESENTATION_REWRITES: readonly { name: string; piName: string }[] = Object.freeze(
  (() => {
    const targets = new Map<string, Set<string>>()
    for (const binding of PI_TOOL_BINDINGS) {
      for (const name of [binding.bindingName, binding.handlerName, binding.permissionName]) {
        if (!name || name === binding.piName || PROSE_WORD_SPELLING.test(name)) continue
        const piNames = targets.get(name) ?? new Set<string>()
        piNames.add(binding.piName)
        targets.set(name, piNames)
      }
    }
    return [...targets]
      .filter(([, piNames]) => piNames.size === 1)
      .map(([name, piNames]) => Object.freeze({ name, piName: [...piNames][0]! }))
      .sort((a, b) => b.name.length - a.name.length)
  })(),
)

const descriptorById = new Map(HARNESS_TOOL_DESCRIPTORS.map(value => [value.id, value]))
const bindingByPiName = new Map(PI_TOOL_BINDINGS.map(value => [value.piName, value]))
const bindingByBindingName = new Map(PI_TOOL_BINDINGS.map(value => [value.bindingName, value]))

export function getHarnessToolDescriptor(id: string): HarnessToolDescriptor {
  const value = descriptorById.get(id)
  if (!value) throw new Error(`Unknown H2 harness tool descriptor: ${id}`)
  return value
}

export function getPiToolBinding(piName: string): PiToolBinding {
  const value = bindingByPiName.get(piName)
  if (!value) throw new Error(`Unknown H2 Pi tool binding: ${piName}`)
  return value
}

export function findPiToolBinding(piName: string): PiToolBinding | undefined {
  return bindingByPiName.get(piName)
}

export function getPiToolBindingByBindingName(bindingName: string): PiToolBinding | undefined {
  return bindingByBindingName.get(bindingName)
}

/**
 * Every spelling that can arrive as `presentedName` for one tool definition.
 *
 * A static binding has TWO of them whenever they diverge: the model-facing
 * piName (`notebook_edit`) carried by projected definitions, and the host
 * bindingName (`NotebookEdit`) carried by the raw definitions the execution
 * ports are built from, so any registry keyed on a single axis resolves one and
 * throws on the other at the first real call. Two NATIVE bindings diverge today
 * — `notebook_edit`/`NotebookEdit` and `stop_task`/`stopTask`, both keeping Pi's
 * own wire name on the piName axis and the documented spelling on the host axis.
 * SESSION bindings no longer diverge at all: `sessionBinding` puts the registry
 * id on both axes so the model-facing name matches the Claude SDK's. Dynamic MCP
 * bindings set piName === bindingName, so they contribute exactly one spelling.
 *
 * This is the same union rule findPiManifestToolByPresentedName applies to the
 * signed manifest, expressed over the static binding registry for the callers
 * that hold definitions rather than a manifest.
 */
export function piToolPresentedNames(name: string): readonly string[] {
  const binding = bindingByPiName.get(name) ?? bindingByBindingName.get(name)
  if (!binding) return [name]
  return binding.piName === binding.bindingName
    ? [binding.piName]
    : [binding.piName, binding.bindingName]
}

/**
 * UA6.3 — the six page tools' descriptors, spread into {@link HARNESS_TOOL_DESCRIPTORS} on `create_board_task`'s line
 * so no cited line of this file moves (a function declaration is hoisted; `read` / `external` are initialised before
 * that array is built). Every one runs in the HOST closure (`SessionManager.pagesToolCallbacksForAgent`) against the
 * workspace's `pages/` folder, never in the workspace sandbox — hence `sandboxProfile: 'none'`, as `create_board_task`.
 * The four mutations are workspace-scoped (`delete_page` behind the host's one-shot card).
 */
function pageToolDescriptors(): HarnessToolDescriptor[] {
  return [
    read('list_pages', { sandboxProfile: 'none' }),
    read('get_page', { sandboxProfile: 'none' }),
    external('create_page', { mutationScope: 'workspace', sandboxProfile: 'none' }),
    external('update_page', { mutationScope: 'workspace', sandboxProfile: 'none' }),
    external('write_page_data', { mutationScope: 'workspace', sandboxProfile: 'none' }),
    external('delete_page', { mutationScope: 'workspace', sandboxProfile: 'none' }),
  ]
}
