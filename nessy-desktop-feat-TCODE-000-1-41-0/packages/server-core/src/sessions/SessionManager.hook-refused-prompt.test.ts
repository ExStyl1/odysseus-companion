/**
 * F1.863 `[pi]` `[permissions]` `[hooks]` — a user `UserPromptSubmit` command hook
 * the HOST refuses to start must not drop the user's prompt.
 *
 * ## The measured defect (release sitting SIT-x, RC `69a6d33da`, FAILS 1)
 *
 * A workspace carrying a structural bash DENY rule (`sitx-deny-touch`,
 * `{ kind: 'bash', executable: 'touch' }`) and a user `hooks.json`
 * `UserPromptSubmit` hook `printf '%s' '{…sessionTitle…}'; true`: on Pi in
 * bypass, every prompt got the error row "Shell command contains unsafe or
 * unsupported syntax." right after the user row and the model never ran.
 *
 * ## The cause, read before building (probe at `d94c1c2c4`, `work/wjcritvv/`)
 *
 * The hook never ran. `pluginCommandHookRunner` asks the readable permission
 * policy about the hook's command line; the structural tokenizer cannot split
 * `…; true`, so the DENY rule answers its terminal `unsafe-shell` refusal
 * (F1.784 kept that half on purpose: the compound might run `touch`). The runner
 * returns `success: false`, a native automation's failed run is a block
 * (`getHookCommandPreToolDecision`, `blockOnNonZero` unset), and a block on
 * `UserPromptSubmit` ends the turn (`hookBlockEndsTurn`) — which is exactly what
 * Pi's `runPiPromptGate` reads, so the prompt was dropped with the refusal as its
 * error row. A bare `touch` hook was dropped the same way, naming the rule; the
 * unsplittable one named nothing. The SAME hook imported from a plugin
 * (`blockOnNonZero: false`, Claude's three-way semantics) left the prompt in
 * charge with an `Automation hook error: …` notice — the "hook not run" row the
 * row asks Pi to give too.
 *
 * ## The fix under test
 *
 * The runner marks a run it refused before the spawn (`refusedBeforeStart`), and
 * on the two prompt events a refused hook is the documented non-blocking hook
 * error — a notice that says the hook did not run, names its command and the
 * refusal — never a block (`refusedHookIsNonBlocking`,
 * `automations/hook-command.ts`). The refusal itself is unchanged: the denied
 * program still never runs, and the unsplittable command's refusal now names the
 * rule (`permission-dsl.ts`).
 *
 * Driven here is the REAL runner (real `PermissionManager`, the real readable
 * policy from a real permission layer, the real spawn) through the REAL
 * dispatcher (`executePluginHookAutomations`), read the way the prompt gate reads
 * it: `isBlockingHookDecision(decision) && hookBlockEndsTurn(event)`.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { hookBlockEndsTurn, isBlockingHookDecision } from '@nessy-agent/shared/automations'
import { executePluginHookAutomations, PluginScopedAutomationSystem } from '@nessy-agent/shared/plugins/hooks-automation'

import { createTestSessionManager } from './__tests__/test-session-manager.ts'

/** SIT-x's workspace `permissions.json`, rule for rule (FAILS 1, step 1). */
const SITX_RULES = [
  { id: 'codex-execpolicy-git-status', action: 'allow', match: { kind: 'bash', executable: 'git', args: ['status'] } },
  { id: 'sitx-deny-touch', action: 'deny', match: { kind: 'bash', executable: 'touch' } },
]
/** SIT-x's hook, byte for byte (FAILS 1, step 2). */
const SITX_HOOK = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"sitx-title"}}'; true`
/** The same title hook with nothing the tokenizer cannot split. */
const TITLE_HOOK = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"sitx-title"}}'`
/**
 * F1.816 — SIT-x's hook runs no `touch`, so the deny rule, which now reads an
 * unsplittable command's subcommands, no longer refuses it (asserted below). The
 * refused hook these tests drive is the same title hook followed by a `touch` the
 * rule does name, in the same unsplittable form.
 */
const REFUSED_HOOK = `${TITLE_HOOK}; touch f1816-refused-marker`
/** A hook that genuinely blocks, in the documented top-level form. */
const BLOCK_HOOK = `printf '%s' '{"decision":"block","reason":"f1863-genuine-block"}'`

type Event = 'UserPromptSubmit' | 'UserPromptExpansion' | 'PreToolUse'
  | 'Stop' | 'SubagentStop' | 'PreCompact' | 'PermissionRequest' | 'ConfigChange' | 'PostToolBatch'
  | 'PostToolUse' | 'PostToolUseFailure' | 'TaskCreated' | 'TaskCompleted' | 'PreModelSwitch' | 'McpElicitation' | 'ElicitationResult'
  | 'WorktreeCreate'

const INPUTS: Record<Event, Record<string, unknown>> = {
  UserPromptSubmit: { hook_event_name: 'UserPromptSubmit', prompt: 'Run the shell command: touch sitx-deny.txt; echo done-deny' },
  UserPromptExpansion: { hook_event_name: 'UserPromptExpansion', prompt: '/deploy', expansion_type: 'slash_command', command_name: 'deploy' },
  PreToolUse: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } },
  // F1.874 — the six events F1.863 left on the fail-closed path.
  Stop: { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' },
  SubagentStop: { hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'agent-f1874', agent_type: 'general-purpose' },
  PreCompact: { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null },
  PermissionRequest: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
  ConfigChange: { hook_event_name: 'ConfigChange', source: 'project_settings', file_path: '.claude/settings.json' },
  PostToolBatch: { hook_event_name: 'PostToolBatch', tool_calls: [] },
  // F1.1065 — the rest of the events that can decide.
  PostToolUse: { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_response: { content: 'ok' } },
  PostToolUseFailure: { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'exit 1' },
  TaskCreated: { hook_event_name: 'TaskCreated', task_id: 'task-f1065', task_subject: 'Write the summary' },
  TaskCompleted: { hook_event_name: 'TaskCompleted', task_id: 'task-f1065', task_subject: 'Write the summary' },
  PreModelSwitch: { hook_event_name: 'PreModelSwitch', from_model: 'coder', to_model: 'fast' },
  McpElicitation: { hook_event_name: 'Elicitation', mcp_server_name: 'fixture', message: 'Pick one', requested_schema: { type: 'object' } },
  ElicitationResult: { hook_event_name: 'ElicitationResult', mcp_server_name: 'fixture', action: 'accept', content: { choice: 'a' } },
  WorktreeCreate: { hook_event_name: 'WorktreeCreate', name: 'wt-f1065' },
}

function permissionLayers(rules: unknown[]) {
  if (rules.length === 0) return []
  const content = JSON.stringify({ permissionDsl: { version: 1, rules } })
  return [{ scope: 'workspace' as const, resource: { contentHash: `hash-f1863-${content.length}`, pluginInstanceId: 'plugin://fixture@1.0.0#f1863' }, content }]
}

async function dispatch(options: {
  command: string
  rules?: unknown[]
  mode?: string
  event?: Event
  signal?: AbortSignal
}) {
  const { rules = SITX_RULES, mode = 'bypassPermissions', event = 'UserPromptSubmit' } = options
  const root = mkdtempSync(join(tmpdir(), 'f1863-'))
  const { runner, sent } = refusingRunner(root, mode, rules)
  const command = options.command.replaceAll('<root>', root)
  const config = { automations: { [event]: [{ ...(event === 'PreToolUse' ? { matcher: '^Read$' } : {}), actions: [{ type: 'command', command, timeoutMs: 20_000 }] }] } } as any
  const out = await executePluginHookAutomations(config, event, INPUTS[event] as any, {
    workspaceRootPath: root,
    runner,
    hookSource: 'user',
    ...(options.signal ? { signal: options.signal } : {}),
  } as any)
  const notices = (out.hookErrors ?? []).map((notice: { hookName: string; summary: string }) => `${notice.hookName} hook error: ${notice.summary}`)
  return {
    root,
    out,
    notices,
    cards: sent.filter(sentEvent => sentEvent.type === 'permission_request').length,
    /** What Pi's `runPiPromptGate` (and the SDK callback) do with this dispatch. */
    dropsThePrompt: isBlockingHookDecision(out.decision) && hookBlockEndsTurn(event),
  }
}

/** The REAL host runner over a real permission layer carrying `rules`, as a session in `mode` holds it. */
function refusingRunner(root: string, mode: string, rules: unknown[]) {
  const sent: Array<{ type: string }> = []
  const manager = createTestSessionManager() as any
  manager.appendPiExecutionReceipt = () => undefined
  manager.piGoalReceiptReference = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.persistSession = () => undefined
  manager.resolveManagedProvider = () => 'pi'
  manager.sendEvent = (sentEvent: { type: string }) => { sent.push(sentEvent) }
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  const layers = permissionLayers(rules)
  const byHash = new Map(layers.map(layer => [layer.resource.contentHash, layer.content]))
  const runner = manager.pluginCommandHookRunner(
    { id: 'session-f1863', provider: 'pi', permissionMode: mode, workspace: { id: 'workspacef1863', rootPath: root }, workingDirectory: root, messages: [] },
    {
      projectTrustState: 'none' as const,
      view: { generation: 'gen-f1863', hooks: [], permissionLayers: layers.map(({ scope, resource }) => ({ scope, resource })) },
      materializer: { assertActive() {}, async readText(resource: { contentHash: string }) { return byHash.get(resource.contentHash) ?? '' } },
    },
  )
  return { runner, sent }
}

describe('F1.863 — a user prompt hook the host refuses leaves the prompt in charge', () => {
  for (const mode of ['bypassPermissions', 'default']) {
    test(`a refused title hook under SIT-x's deny rule in ${mode}: the prompt is NOT dropped, and one notice says the hook did not run, which hook, and which rule`, async () => {
      const run = await dispatch({ command: REFUSED_HOOK, mode })

      expect(run.dropsThePrompt).toBe(false)
      expect(run.out.decision?.decision).toBeUndefined()
      // It did not run: the title it would have printed never came back, nor the marker.
      expect((run.out.decision as { sessionTitle?: string } | undefined)?.sessionTitle).toBeUndefined()
      expect(existsSync(join(run.root, 'f1816-refused-marker'))).toBe(false)
      expect(run.cards).toBe(0)
      expect(run.notices).toHaveLength(1)
      const [notice] = run.notices
      expect(notice).toContain('hook error: Command hook not run')
      expect(notice).toContain("printf '%s'") // the hook, by its own command
      expect(notice).toContain('Denied by readable permission policy rule `sitx-deny-touch` (workspace scope).') // F1.816 — the bare-match sentence
      expect(run.out.hookRunFailed).toBe(true)
    }, 60_000)

    test(`F1.816: SIT-x's own hook under SIT-x's deny rule in ${mode} RUNS — it runs no \`touch\` — and prints its title with no notice`, async () => {
      const run = await dispatch({ command: SITX_HOOK, mode })

      expect(run.dropsThePrompt).toBe(false)
      expect((run.out.decision as { sessionTitle?: string } | undefined)?.sessionTitle).toBe('sitx-title')
      expect(run.cards).toBe(0)
      expect(run.notices).toEqual([])
    }, 60_000)
  }

  test('UserPromptExpansion, the other prompt event whose block erases what the user typed, behaves the same', async () => {
    const run = await dispatch({ command: REFUSED_HOOK, event: 'UserPromptExpansion' })

    expect(run.dropsThePrompt).toBe(false)
    expect(run.notices).toHaveLength(1)
    expect(run.notices[0]).toContain('Command hook not run')
    expect(run.notices[0]).toContain('rule `sitx-deny-touch` (workspace scope)')
  }, 60_000)

  test('SAFETY: a hook that runs the DENIED program is still not run — bare or unsplittable — and names the rule', async () => {
    for (const command of ['touch <root>/f1863-marker', 'touch <root>/f1863-marker; true']) {
      const run = await dispatch({ command })

      expect(existsSync(join(run.root, 'f1863-marker')), command).toBe(false)
      expect(run.dropsThePrompt, command).toBe(false)
      expect(run.notices, command).toHaveLength(1)
      expect(run.notices[0], command).toContain('Command hook not run')
      expect(run.notices[0], command).toContain('rule `sitx-deny-touch` (workspace scope)')
    }
  }, 60_000)

  test('CONTROL (F1.758): with no deny rule in play the same hook RUNS, prints its title and raises no notice', async () => {
    const run = await dispatch({ command: SITX_HOOK, rules: [] })

    expect(run.dropsThePrompt).toBe(false)
    expect((run.out.decision as { sessionTitle?: string } | undefined)?.sessionTitle).toBe('sitx-title')
    expect(run.notices).toEqual([])
  }, 60_000)

  test('CONTROL: under the deny rule a hook the tokenizer CAN split and that is not about `touch` runs as before', async () => {
    const run = await dispatch({ command: TITLE_HOOK })

    expect(run.dropsThePrompt).toBe(false)
    expect((run.out.decision as { sessionTitle?: string } | undefined)?.sessionTitle).toBe('sitx-title')
    expect(run.notices).toEqual([])
  }, 60_000)

  test('CONTROL: a hook\'s own `decision: block` still stops the prompt, with its own reason', async () => {
    const run = await dispatch({ command: BLOCK_HOOK })

    expect(run.dropsThePrompt).toBe(true)
    expect(run.out.decision?.reason).toBe('f1863-genuine-block')
  }, 60_000)

  test('BOUNDARY: a refused PreToolUse hook still blocks the tool call — a guard that cannot run fails closed', async () => {
    const run = await dispatch({ command: 'touch <root>/f1863-marker; true', event: 'PreToolUse' })

    expect(existsSync(join(run.root, 'f1863-marker'))).toBe(false)
    expect(isBlockingHookDecision(run.out.decision)).toBe(true)
    expect(run.out.decision?.reason ?? '').toContain('rule `sitx-deny-touch` (workspace scope)')
  }, 60_000)

  test('BOUNDARY: a CANCELLED run is not a refusal — a stopped turn still does not send the prompt', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await dispatch({ command: REFUSED_HOOK, signal: controller.signal })

    expect(run.dropsThePrompt).toBe(true)
    expect(run.out.decision?.reason ?? '').toContain('Command hook cancelled.')
  }, 60_000)
})

/**
 * F1.874 — the six events F1.863 left fail-closed, measured on the same rig.
 *
 * Before: a refused hook on `Stop` / `SubagentStop` answered a BLOCK whose reason
 * was the refusal. On claude the SDK callback returned `decision: block` — the
 * runtime's "prevents Claude from stopping, continues the conversation", up to
 * its 8-block cap — and on Pi and codex `recordHookBlockFeedback` queued the
 * refusal as `<hook_feedback event="Stop">` onto the next turn; no notice either
 * way (a blocked run leaves none). A hook that never ran asked for more work.
 * `PreCompact` skipped every compaction. `hooks.md#other-exit-codes`: "A hook
 * that can't start lands in the same non-blocking bucket … For most hook
 * events, the action proceeds." F1.874 kept `PermissionRequest`, `ConfigChange`
 * and `PostToolBatch` fail-closed; F1.1037 (below) moved them to the same bucket.
 */
async function claudeSdkAnswer(event: Event, command: string) {
  const root = mkdtempSync(join(tmpdir(), `f1874-${event}-`))
  const { runner } = refusingRunner(root, 'bypassPermissions', SITX_RULES)
  const scoped = new PluginScopedAutomationSystem({
    pluginHookConfig: { automations: {} } as any,
    workspaceHookConfig: { automations: { [event]: [{ actions: [{ type: 'command', command, timeoutMs: 20_000 }] }] } } as any,
    workspaceRootPath: root,
    pluginCommandRunner: runner,
  })
  const matchers = scoped.buildSdkHooks()[event] ?? []
  expect(matchers).toHaveLength(1)
  return await matchers[0]!.hooks[0]!({ session_id: 'session-f1874', ...INPUTS[event] } as never, 'hook-f1874', {}) as Record<string, unknown>
}

describe('F1.874 — a refused hook on Stop, SubagentStop or PreCompact is a notice', () => {
  for (const event of ['Stop', 'SubagentStop', 'PreCompact'] as const) {
    test(`${event}: no block (the turn ends, compaction runs), one notice naming the hook and the rule`, async () => {
      const run = await dispatch({ command: REFUSED_HOOK, event })

      expect(isBlockingHookDecision(run.out.decision)).toBe(false)
      expect(run.out.decision?.reason).toBeUndefined()
      expect(run.notices).toHaveLength(1)
      expect(run.notices[0]).toContain('Command hook not run')
      expect(run.notices[0]).toContain('rule `sitx-deny-touch` (workspace scope)')
    }, 60_000)
  }

  test('claude: the SDK callback for a refused Stop hook no longer blocks the stop; the notice rides systemMessage', async () => {
    const answer = await claudeSdkAnswer('Stop', REFUSED_HOOK)

    expect(answer.continue).toBe(true)
    expect(answer.decision).toBeUndefined()
    expect(answer.reason).toBeUndefined()
    expect(String(answer.systemMessage ?? '')).toContain('hook error: Command hook not run')
  }, 60_000)

  test('CONTROL: a Stop hook that RAN and answers its own `decision: block` still keeps the turn going, with its reason', async () => {
    const run = await dispatch({ command: `printf '%s' '{"decision":"block","reason":"f1874-keep-going"}'`, event: 'Stop' })

    expect(isBlockingHookDecision(run.out.decision)).toBe(true)
    expect(run.out.decision?.reason).toBe('f1874-keep-going')
  }, 60_000)

})

/**
 * F1.1037 (controller decision 2026-09-28, DECISIONS-2 Q1) — the three events
 * F1.874 kept fail-closed join the non-blocking bucket: a hook the host refused
 * to start never ran, and `hooks.md#other-exit-codes` puts "a hook that can't
 * start" in the non-blocking bucket where "the action proceeds" — the
 * permission's normal card shows, the settings change applies, the loop goes on.
 * `PreToolUse` stays fail-closed (the F1.863 BOUNDARY above), and a hook that
 * RAN keeps its own exit code.
 */
describe('F1.1037 — a refused hook on PermissionRequest, ConfigChange or PostToolBatch is a notice; PreToolUse still fails closed', () => {
  for (const event of ['PermissionRequest', 'ConfigChange', 'PostToolBatch'] as const) {
    test(`${event}: no block (the action proceeds), the command never ran, one notice naming the hook and the rule`, async () => {
      const run = await dispatch({ command: 'touch <root>/f1874-marker; true', event })

      expect(existsSync(join(run.root, 'f1874-marker'))).toBe(false)
      expect(isBlockingHookDecision(run.out.decision)).toBe(false)
      expect(run.out.decision?.reason).toBeUndefined()
      expect(run.cards).toBe(0)
      expect(run.notices).toHaveLength(1)
      expect(run.notices[0]).toContain('Command hook not run')
      expect(run.notices[0]).toContain('rule `sitx-deny-touch` (workspace scope)')
    }, 60_000)
  }

  test('claude: the SDK callback for a refused PermissionRequest hook answers no decision (the normal card shows); the notice rides systemMessage', async () => {
    const answer = await claudeSdkAnswer('PermissionRequest', REFUSED_HOOK)

    expect(answer.continue).toBe(true)
    expect(answer.decision).toBeUndefined()
    expect(answer.hookSpecificOutput).toBeUndefined()
    expect(String(answer.systemMessage ?? '')).toContain('hook error: Command hook not run')
  }, 60_000)

  test('BOUNDARY: a PermissionRequest hook that RAN and exited non-zero still denies — only a refusal changed', async () => {
    const run = await dispatch({ command: `printf 'f1037-ran' >&2; exit 1`, rules: [], event: 'PermissionRequest' })

    expect(isBlockingHookDecision(run.out.decision)).toBe(true)
    expect(run.notices).toEqual([])
  }, 60_000)
})

/**
 * F1.1065 (controller decision 2026-09-28, origin DN-244) — every other event
 * that can decide follows the same sentence as F1.1037: a hook the host refused
 * to start never ran, and hooks.md, Other exit codes, puts "a hook that can't
 * start" in the non-blocking bucket, where "for most hook events, the action
 * proceeds". One arm per event family: after the tool (PostToolUse,
 * PostToolUseFailure — the refusal is no longer fed to the model), tasks
 * (TaskCreated, TaskCompleted), the model switch (PreModelSwitch) and
 * elicitation (McpElicitation, ElicitationResult). The fail-closed list is
 * PreToolUse (the F1.863 BOUNDARY above) and the page's own worktree exceptions.
 */
describe('F1.1065 — a refused hook on every other event is a notice; PreToolUse and WorktreeCreate still fail closed', () => {
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'TaskCreated', 'TaskCompleted', 'PreModelSwitch', 'McpElicitation', 'ElicitationResult'] as const) {
    test(`${event}: no block (the action proceeds), the command never ran, one notice naming the hook and the rule`, async () => {
      const run = await dispatch({ command: 'touch <root>/f1065-marker; true', event })

      expect(existsSync(join(run.root, 'f1065-marker'))).toBe(false)
      expect(isBlockingHookDecision(run.out.decision)).toBe(false)
      expect(run.out.decision?.reason).toBeUndefined()
      expect(run.cards).toBe(0)
      expect(run.notices).toHaveLength(1)
      expect(run.notices[0]).toContain('Command hook not run')
      expect(run.notices[0]).toContain('rule `sitx-deny-touch` (workspace scope)')
    }, 60_000)
  }

  test('claude: the SDK callback for a refused PostToolUse hook answers no decision (nothing is fed to the model); the notice rides systemMessage', async () => {
    const answer = await claudeSdkAnswer('PostToolUse', REFUSED_HOOK)

    expect(answer.continue).toBe(true)
    expect(answer.decision).toBeUndefined()
    expect(answer.reason).toBeUndefined()
    expect(String(answer.systemMessage ?? '')).toContain('hook error: Command hook not run')
  }, 60_000)

  test('BOUNDARY: a refused WorktreeCreate hook still blocks — the page\'s own exception (any non-zero exit fails the creation)', async () => {
    const run = await dispatch({ command: 'touch <root>/f1065-marker; true', event: 'WorktreeCreate' })

    expect(existsSync(join(run.root, 'f1065-marker'))).toBe(false)
    expect(isBlockingHookDecision(run.out.decision)).toBe(true)
    expect(run.out.decision?.reason ?? '').toContain('rule `sitx-deny-touch` (workspace scope)')
  }, 60_000)

  test('BOUNDARY: a PostToolUse hook that RAN and exited 2 still feeds its stderr back — only a refusal changed', async () => {
    const run = await dispatch({ command: `printf 'f1065-ran' >&2; exit 2`, rules: [], event: 'PostToolUse' })

    expect(isBlockingHookDecision(run.out.decision)).toBe(true)
    expect(run.out.decision?.reason ?? '').toContain('f1065-ran')
  }, 60_000)
})
