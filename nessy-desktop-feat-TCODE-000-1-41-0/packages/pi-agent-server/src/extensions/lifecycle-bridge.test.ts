import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { AGENT_EVENTS, getAgentEventContractV1 } from '../../../shared/src/automations/types.ts'
import {
  PI_LIFECYCLE_HOOK_CONTRACTS,
  createPiLifecycleExtension,
  createPiLifecycleSinkGate,
} from './lifecycle-bridge.ts'

// The documented lifecycle inventory the behavior corpus (hooks-complete-inventory)
// pins. Every entry must be a canonical member with a frozen semantic contract.
//
// This is the INVENTORY, not the bridge's emission list: most entries here are
// owned elsewhere (child-session-service, task-service, worktree-lease-service,
// SessionManager) and the bridge's deliberate silence about them is asserted
// separately below. It is also the SECOND frozen roster in the repo — the other
// is `DOCUMENTED_CLAUDE_HOOK_EVENTS` in
// packages/shared/src/plugins/__tests__/format-adapters.test.ts — and R32 grew
// the shared table (`MessageDisplay`, `DirectoryAdded`, both from hooks.md)
// while updating only that one. Grow BOTH, in the shared table's order:
// `toEqual` is order-sensitive.
//
// R73 · f001 removed `Setup` from the head of this roster. It is not a gap: the
// event left the inventory because hooks.md#setup fires it only under
// `--init-only` / `-p --init` / `-p --maintenance`, launch modes this fork does
// not have, and the bridge was firing it on every runtime start — the one case
// the page excludes.
const REQUIRED_HOOKS = [
  'InstructionsLoaded', 'SessionStart', 'UserPromptSubmit', 'UserPromptExpansion',
  'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure',
  'PostToolBatch', 'Notification', 'MessageDisplay',
  // P3.374 — the model-switch pair joined the inventory when
  // `SessionManager.updateSessionModel` gained its emitter and the plugin
  // adapter's deferral was retired. They are HOST-owned, like `MessageDisplay`
  // above: this bridge does not emit them, and this list is the INVENTORY, not
  // this bridge's own roster (see the `PreCompact` note below for the same
  // distinction). Absent from `REQUIRED_HOOKS`, the projection below would go
  // red for a table that is correct.
  'PreModelSwitch', 'PostModelSwitch',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'StopFailure', 'Stop', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
  'PreCompact', 'PostCompact', 'ConfigChange', 'McpElicitation', 'McpResult', 'ElicitationResult', 'SessionEnd',
] as const

describe('fixed Pi lifecycle bridge', () => {
  test('maps only extension-owned lifecycle events through one session-bound sink', async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    const factory = createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (event, input) => { emitted.push({ event, input }) },
      getOriginalUserPrompt: () => 'original user prompt',
    })
    await factory({ on: (event: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(event, handler)
    } } as never)

    await handlers.get('session_start')?.({})
    await handlers.get('before_agent_start')?.({ systemPrompt: 'secret', messages: [{ role: 'user', content: 'composed' }] })
    await handlers.get('session_before_compact')?.({ reason: 'threshold' })
    await handlers.get('session_compact')?.({ reason: 'threshold' })
    await handlers.get('session_shutdown')?.({})

    // `InstructionsLoaded` is deliberately ABSENT from this bridge. The old
    // entry here pinned a content-free, once-per-session ping — the wrong
    // contract: hooks.md#instructionsloaded fires one event per LOADED FILE with
    // `file_path`, `memory_type` and `load_reason`, none of which this
    // subprocess can know. It is emitted by the host from the pinned capability
    // layers instead (`BaseAgent.emitInstructionsLoaded`), covered by
    // `instructions-loaded.test.ts`.
    // R73 · f001 · `Setup` is deliberately ABSENT too, and for a third reason:
    // not a wrong payload but a forbidden occurrence. hooks.md#setup — "It
    // doesn't fire on normal startup" — and a Pi runtime start is exactly that.
    // The event no longer exists in the inventory, so this list is the guard
    // that the emit does not come back.
    expect(emitted).toEqual([
      { event: 'SessionStart', input: { hook_event_name: 'SessionStart', source: 'startup' } },
      { event: 'UserPromptSubmit', input: { hook_event_name: 'UserPromptSubmit', prompt: 'original user prompt' } },
      // R73 · `UserPromptExpansion` is deliberately ABSENT from this bridge now,
      // for the same reason `InstructionsLoaded` is. The old entry pinned a
      // content-free, once-per-TURN ping fired even when nothing expanded;
      // hooks.md#userpromptexpansion fires once per EXPANDED COMMAND with
      // `expansion_type`, `command_name`, `command_args`, `command_source` and
      // the original prompt, none of which this subprocess can know. The host
      // emits it from the expansion site (`SessionManager.emitUserPromptExpansion`).
      // It stays in `REQUIRED_HOOKS` above: the event is still in the inventory,
      // only its owner moved.
      // D1.115 — `custom_instructions` is PRESENT and `null` on the auto path,
      // never absent and no longer `''`. `hooks.md#precompact-input`, verbatim
      // 2026-09-17: "For `auto`, `custom_instructions` is `null`."
      { event: 'PreCompact', input: { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null, source: 'threshold' } },
      { event: 'PostCompact', input: { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: '', source: 'threshold' } },
    ])
    expect(JSON.stringify(emitted)).not.toContain('secret')
    expect(JSON.stringify(emitted)).not.toContain('composed')
    expect(emitted.some(entry => entry.event === 'SessionEnd')).toBe(false)
  })

  test('emits observational cwd, file and mcp hooks in order from tool lifecycle seams', async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    const factory = createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (event, input) => { emitted.push({ event, input }) },
      getOriginalUserPrompt: () => null,
    })
    await factory({ on: (event: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(event, handler)
    } } as never)

    // A bash run reports a new cwd -> CwdChanged (only on delta).
    await handlers.get('user_bash')?.({ command: 'cd sub', cwd: '/repo/sub' })
    await handlers.get('user_bash')?.({ command: 'ls', cwd: '/repo/sub' }) // no delta
    // A write tool: args (with the path) arrive on start; end carries no args, so
    // the path is correlated across the pair by tool call id.
    await handlers.get('tool_execution_start')?.({ toolCallId: 't1', toolName: 'write', args: { path: '/repo/sub/a.txt' } })
    await handlers.get('tool_execution_end')?.({ toolCallId: 't1', toolName: 'write', result: {}, isError: false })
    // A read tool finishes -> no FileChanged (non-mutating).
    await handlers.get('tool_execution_start')?.({ toolCallId: 't2', toolName: 'read', args: { path: '/repo/sub/a.txt' } })
    await handlers.get('tool_execution_end')?.({ toolCallId: 't2', toolName: 'read', result: {}, isError: false })
    // A genuine external MCP tool call starts and ends -> McpElicitation then McpResult.
    await handlers.get('tool_execution_start')?.({ toolCallId: 't3', toolName: 'mcp__linear__create_issue', args: { title: 'x' } })
    await handlers.get('tool_execution_end')?.({ toolCallId: 't3', toolName: 'mcp__linear__create_issue', result: {}, isError: false })
    // An internal session-tool proxy must NOT emit MCP hooks (owns its own hooks).
    await handlers.get('tool_execution_start')?.({ toolCallId: 't4', toolName: 'mcp__session__Task', args: {} })
    await handlers.get('tool_execution_end')?.({ toolCallId: 't4', toolName: 'mcp__session__Task', result: {}, isError: false })

    expect(emitted.map(entry => entry.event)).toEqual([
      'CwdChanged', 'FileChanged', 'McpElicitation', 'McpResult', 'ElicitationResult',
    ])
    // hooks.md:2562 — `new_cwd` alongside the common `cwd`, both the new
    // directory (the page's example carries them with the same value). No
    // `old_cwd`/`previous_cwd` on the first delta: there is no directory left
    // behind yet.
    expect(emitted[0]?.input).toEqual({ hook_event_name: 'CwdChanged', cwd: '/repo/sub', new_cwd: '/repo/sub' })
    // hooks.md:2636 — `file_path` + `event`; `/repo/sub/a.txt` does not exist on
    // disk, so the pre-write probe yields `add`. `change_kind`/`path` are the
    // retained legacy aliases.
    expect(emitted[1]?.input).toEqual({
      hook_event_name: 'FileChanged', file_path: '/repo/sub/a.txt', event: 'add',
      change_kind: 'write', path: '/repo/sub/a.txt',
    })
    expect(emitted[2]?.input).toMatchObject({ hook_event_name: 'McpElicitation', mcp_server: 'linear', mcp_tool: 'mcp__linear__create_issue', correlation_id: 't3' })
    expect(emitted[3]?.input).toMatchObject({ hook_event_name: 'McpResult', mcp_server: 'linear', mcp_tool: 'mcp__linear__create_issue', correlation_id: 't3' })
    expect(emitted[4]?.input).toMatchObject({ hook_event_name: 'ElicitationResult', correlation_id: 't3', outcome: 'success' })
  })

  test('carries the documented old_cwd on a second directory change', async () => {
    // The fixture above only ever exercises the first-cwd branch, where there is
    // no directory left behind. hooks.md:2562's `old_cwd` (and its retained
    // Nessy alias `previous_cwd`) only appear from the second delta on.
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (event, input) => { emitted.push({ event, input }) },
      getOriginalUserPrompt: () => null,
    })({ on: (event: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(event, handler)
    } } as never)

    await handlers.get('user_bash')?.({ command: 'cd sub', cwd: '/repo/sub' })
    await handlers.get('user_bash')?.({ command: 'cd ../other', cwd: '/repo/other' })

    expect(emitted).toHaveLength(2)
    expect(emitted[1]?.input).toEqual({
      hook_event_name: 'CwdChanged',
      cwd: '/repo/other',
      new_cwd: '/repo/other',
      old_cwd: '/repo/sub',
      previous_cwd: '/repo/sub',
    })
  })

  test('resolves a relative FileChanged path against the session cwd and reports change for an existing file', async () => {
    // hooks.md:2640 requires an "Absolute path to the file that changed", and a
    // model's tool argument is absolute only by luck. `event` is `change` here
    // because the file exists BEFORE the write — a real file on disk, so the
    // existence probe is exercised rather than stubbed.
    const base = mkdtempSync(join(tmpdir(), 'nessy-filechanged-'))
    try {
      writeFileSync(join(base, 'existing.txt'), 'before')
      const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
      const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
      await createPiLifecycleExtension({
        cwd: base,
        emit: async (event, input) => { emitted.push({ event, input }) },
        getOriginalUserPrompt: () => null,
      })({ on: (event: string, handler: (value: Record<string, unknown>) => unknown) => {
        handlers.set(event, handler)
      } } as never)

      await handlers.get('tool_execution_start')?.({ toolCallId: 'e1', toolName: 'edit', args: { path: 'existing.txt' } })
      await handlers.get('tool_execution_end')?.({ toolCallId: 'e1', toolName: 'edit', isError: false })
      await handlers.get('tool_execution_start')?.({ toolCallId: 'e2', toolName: 'write', args: { path: 'nested/new.txt' } })
      await handlers.get('tool_execution_end')?.({ toolCallId: 'e2', toolName: 'write', isError: false })

      expect(emitted.map(entry => entry.input)).toEqual([
        {
          hook_event_name: 'FileChanged', file_path: join(base, 'existing.txt'), event: 'change',
          change_kind: 'edit', path: join(base, 'existing.txt'),
        },
        {
          hook_event_name: 'FileChanged', file_path: join(base, 'nested/new.txt'), event: 'add',
          change_kind: 'write', path: join(base, 'nested/new.txt'),
        },
      ])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('carries the /compact argument and the generated summary onto the compaction hooks', async () => {
    // hooks.md#precompact-input — "For `manual`, `custom_instructions` contains
    // what the user passes into `/compact`"; hooks.md#postcompact-input — the
    // `compact_summary` field "contains the conversation summary generated by
    // the compact operation", read off Pi's saved `CompactionEntry`, never
    // recomputed. (Anchors re-derived 2026-09-11 from the rendered page; the
    // line numbers they replace had moved.)
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (event, input) => { emitted.push({ event, input }) },
      getOriginalUserPrompt: () => null,
    })({ on: (event: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(event, handler)
    } } as never)

    await handlers.get('session_before_compact')?.({ reason: 'manual', customInstructions: 'Focus on API usage' })
    await handlers.get('session_compact')?.({ reason: 'manual', compactionEntry: { summary: 'S' } })

    expect(emitted.map(entry => entry.input)).toEqual([
      { hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'Focus on API usage', source: 'manual' },
      { hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'S', source: 'manual' },
    ])
  })

  test('D1.115 · a manual compaction the user passed NOTHING to is null, not an empty string', async () => {
    // The arm the row did not have and the page does: `hooks.md#precompact-input`,
    // verbatim 2026-09-17 — "For `manual`, `custom_instructions` contains what
    // the user passes into `/compact` and is `null` when they pass nothing."
    // So the empty string is the user passing nothing, on the one trigger where
    // Pi can actually produce one, and `''` was wrong on BOTH triggers rather
    // than only on `auto`.
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (event, input) => { emitted.push({ event, input }) },
      getOriginalUserPrompt: () => null,
    })({ on: (event: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(event, handler)
    } } as never)

    await handlers.get('session_before_compact')?.({ reason: 'manual', customInstructions: '' })

    expect(emitted[0]?.input).toHaveProperty('custom_instructions', null)
    expect(Object.keys(emitted[0]?.input ?? {})).toContain('custom_instructions')
    // The positive control in the same test, so "everything becomes null" would
    // fail here: a manual compaction WITH text still carries the text.
    emitted.length = 0
    await handlers.get('session_before_compact')?.({ reason: 'manual', customInstructions: 'keep the plan' })
    expect(emitted[0]?.input).toHaveProperty('custom_instructions', 'keep the plan')
  })

  test('keeps custom_instructions present and NULL on an auto compaction', async () => {
    // The negative for the pair above, and the one easy to get wrong: Pi passes
    // `customInstructions: undefined` on the auto path, and `optionalString`
    // would drop the key entirely, which is the one shape no version of the page
    // has ever described — the documented absence is a PRESENT `null`.
    //
    // D1.115 — these assertions pinned `''` until 2026-09-17, matching an older
    // page. `hooks.md#precompact-input` now reads "For `auto`,
    // `custom_instructions` is `null`", with a JSON example carrying `null`,
    // and the declaration plus the four other carriers moved with it.
    for (const event of [{ reason: 'threshold' }, { reason: 'overflow' }, {}]) {
      const handlers = new Map<string, (value: Record<string, unknown>) => unknown>()
      const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
      await createPiLifecycleExtension({
        cwd: '/repo',
        emit: async (name, input) => { emitted.push({ event: name, input }) },
        getOriginalUserPrompt: () => null,
      })({ on: (name: string, handler: (value: Record<string, unknown>) => unknown) => {
        handlers.set(name, handler)
      } } as never)

      await handlers.get('session_before_compact')?.(event)
      await handlers.get('session_compact')?.(event)

      expect(emitted[0]?.input).toHaveProperty('custom_instructions', null)
      // PRESENT, which is the half `optionalString` would break: the key must
      // exist even though its value is `null`.
      expect(Object.keys(emitted[0]?.input ?? {})).toContain('custom_instructions')
      expect(emitted[1]?.input).toHaveProperty('compact_summary', '')
    }
  })

  test('P6.1078 · a FAILED compaction produces no terminal hook event, and the bridge listens for none', async () => {
    // The posture's pin. `session_compact_failed` is reachable from this bridge
    // and from nowhere else in this fork (the session-event adapter consumes
    // `AgentSessionEvent`, which the event is absent from); the bridge declines
    // it, because hooks.md publishes no terminal event for a failed compaction
    // and the codex arm mints none either — `CodexAgent.emitCodexPostCompactHook`
    // fires only from a compaction codex announced, and codex announces only
    // completed ones. The module's docblock carries the five reasons and the two
    // shapes an owner would choose between if this is ever re-decided.
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (event, input) => { emitted.push({ event, input }) },
      getOriginalUserPrompt: () => null,
    })({ on: (event: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(event, handler)
    } } as never)

    // The declined registration itself, so adding a handler without reading the
    // docblock turns this red rather than passing silently.
    expect(handlers.has('session_compact_failed')).toBe(false)

    await handlers.get('session_before_compact')?.({ reason: 'overflow' })
    // Pi's own failure event, field for field with `SessionCompactFailedEvent`
    // — `fromExtension` included, the one field `compaction_end` lacks and the
    // whole of what adopting this event would buy.
    await handlers.get('session_compact_failed')?.({
      reason: 'overflow',
      errorMessage: 'summarization failed',
      aborted: false,
      willRetry: true,
      fromExtension: true,
    })

    // The `PreCompact` stands alone: no `PostCompact`, no marker event, nothing.
    expect(emitted.map(entry => entry.event)).toEqual(['PreCompact'])

    // The control on the same rig, without which "nothing was emitted" would
    // also pass for a bridge that had stopped emitting anything at all: the
    // SUCCESS event still produces the documented terminal, unchanged.
    await handlers.get('session_compact')?.({ reason: 'overflow', compactionEntry: { summary: 'S' } })
    expect(emitted.map(entry => entry.event)).toEqual(['PreCompact', 'PostCompact'])
    expect(emitted[1]?.input).toEqual({
      hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'S', source: 'overflow',
    })
  })

  test('returns Pi its cancel when the awaited PreCompact verdict blocks, and emits nothing twice', async () => {
    // R73 · hooks.md#precompact — "Exit with code 2 to block compaction […] You
    // can also block by returning JSON with `"decision": "block"`", and the
    // exit-code table row is "`PreCompact` | Yes | Blocks compaction". `emit` is
    // fire-and-forget, so the verdict has to travel the awaited callback; the
    // handler's return value is what Pi reads (`{ cancel: true }`).
    const asked: unknown[] = []
    const emitted: unknown[] = []
    const drive = async (
      answer: { block?: boolean; reason?: string } | void | (() => never),
    ): Promise<unknown> => {
      const handlers = new Map<string, (value: Record<string, unknown>) => unknown>()
      await createPiLifecycleExtension({
        cwd: '/repo',
        emit: async (name, input) => { emitted.push({ event: name, input }) },
        getOriginalUserPrompt: () => null,
        requestCompactionDecision: input => {
          asked.push(input)
          if (typeof answer === 'function') answer()
          return answer
        },
      })({ on: (name: string, handler: (value: Record<string, unknown>) => unknown) => {
        handlers.set(name, handler)
      } } as never)
      return await handlers.get('session_before_compact')?.({ reason: 'manual', customInstructions: 'keep the plan' })
    }

    expect(await drive({ block: true, reason: 'plan mid-execution' })).toEqual({ cancel: true })
    expect(await drive({})).toBeUndefined()
    expect(await drive(undefined)).toBeUndefined()
    // A THROWING callback fails open and never escapes into `runner.emit`, which
    // swallows handler throws — an escaping error would lose the reason and fail
    // open anyway, just silently.
    expect(await drive(() => { throw new Error('hook exploded') })).toBeUndefined()

    expect(asked).toEqual(Array(4).fill({ trigger: 'manual', source: 'manual', customInstructions: 'keep the plan' }))
    // ONE emission per compaction: with the callback present the fire-and-forget
    // `emit` is skipped entirely, or the host would run the hook twice.
    expect(emitted).toEqual([])
  })

  test('keeps the fire-and-forget PreCompact emission when no decision callback is wired', async () => {
    // The backward-compatible half: an embedder that does not pass
    // `requestCompactionDecision` sees exactly the previous behaviour.
    const handlers = new Map<string, (value: Record<string, unknown>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (name, input) => { emitted.push({ event: name, input }) },
      getOriginalUserPrompt: () => null,
    })({ on: (name: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(name, handler)
    } } as never)

    expect(await handlers.get('session_before_compact')?.({ reason: 'manual' })).toBeUndefined()
    expect(emitted).toEqual([
      // D1.115 — a `manual` compaction the user passed nothing to is `null`
      // too: "For `manual`, `custom_instructions` contains what the user passes
      // into `/compact` and is `null` when they pass nothing."
      { event: 'PreCompact', input: { hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null, source: 'manual' } },
    ])
  })

  test('replaces model-visible tool output through the pre-commit tool_result seam', async () => {
    const handlers = new Map<string, (event: Record<string, any>) => unknown>()
    const seen: unknown[] = []
    const factory = createPiLifecycleExtension({
      cwd: '/repo',
      emit: () => undefined,
      getOriginalUserPrompt: () => null,
      transformToolResult: async input => {
        seen.push(input)
        return { updatedToolOutput: 'compressed output' }
      },
    })
    await factory({ on: (event: string, handler: (value: Record<string, any>) => unknown) => {
      handlers.set(event, handler)
    } } as never)

    const result = await handlers.get('tool_result')?.({
      type: 'tool_result', toolCallId: 't1', toolName: 'bash', input: { command: 'verbose' },
      content: [{ type: 'text', text: 'long' }, { type: 'text', text: 'output' }], details: undefined, isError: false,
    })
    expect(seen).toEqual([{
      toolName: 'bash', toolInput: { command: 'verbose' }, toolResponse: 'long\noutput', isError: false,
    }])
    expect(result).toEqual({ content: [{ type: 'text', text: 'compressed output' }] })

    const failOpenHandlers = new Map<string, (event: Record<string, any>) => unknown>()
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: () => undefined,
      getOriginalUserPrompt: () => null,
      transformToolResult: async () => { throw new Error('hook failed') },
    })({ on: (event: string, handler: (value: Record<string, any>) => unknown) => {
      failOpenHandlers.set(event, handler)
    } } as never)
    expect(await failOpenHandlers.get('tool_result')?.({
      type: 'tool_result', toolCallId: 't2', toolName: 'bash', input: {},
      content: [{ type: 'text', text: 'original' }], details: undefined, isError: false,
    })).toBeUndefined()
  })

  test('freezes a complete per-hook semantic contract for the documented inventory', () => {
    // Every documented hook is represented exactly once, in inventory order.
    expect(PI_LIFECYCLE_HOOK_CONTRACTS.map(contract => contract.event)).toEqual([...REQUIRED_HOOKS])

    // Each contract carries ordered input, a decision-vs-observational class and a
    // terminal-delivery guarantee (hooks-semantics).
    for (const contract of PI_LIFECYCLE_HOOK_CONTRACTS) {
      expect(contract.owner, contract.event).toBeString()
      expect(['decision', 'observational'], contract.event).toContain(contract.kind)
      expect(contract.ordering, contract.event).toBeString()
      expect(['once-per-occurrence', 'once-per-session', 'once-per-turn'], contract.event).toContain(contract.terminalDelivery)
      // Every hook name must be a canonical shared inventory member.
      expect(AGENT_EVENTS as readonly string[], contract.event).toContain(contract.event)
    }

    // Exactly the frozen decision-bearing hooks may block; everything else is observational.
    const decisionHooks = PI_LIFECYCLE_HOOK_CONTRACTS.filter(c => c.kind === 'decision').map(c => c.event).sort()
    // R20 flipped the two task events from observational to decision:
    // hooks.md:708-709 gives their exit 2 real authority over the task list.
    // R24 flipped the two elicitation events for the same reason: hooks.md:2735
    // and :2783 give both a real `hookSpecificOutput.{action, content}` surface
    // that answers the MCP server, and exit 2 denies/blocks (:2756, :2802).
    // P3.374 added `PreModelSwitch`, and it is the strongest of them:
    // hooks.md#premodelswitch-decision-control gives it allow/ask/deny with
    // `deny > ask > allow` precedence AND a top-level `decision: "block"` that
    // cancels the switch, and the page's own default is fail-CLOSED — a hook that
    // does not answer before its timeout blocks. `PostModelSwitch` is deliberately
    // NOT here: "It can't block, because the model has already changed."
    expect(decisionHooks).toEqual([
      'ElicitationResult', 'McpElicitation', 'PermissionRequest', 'PreModelSwitch', 'PreToolUse',
      'TaskCompleted', 'TaskCreated',
    ])

    // Required P7A additions are observational and cannot change receipts.
    // `ElicitationResult` left this list in R24 — see the decision hooks above.
    for (const event of ['InstructionsLoaded', 'UserPromptExpansion', 'PostToolBatch', 'StopFailure', 'ConfigChange']) {
      const contract = PI_LIFECYCLE_HOOK_CONTRACTS.find(c => c.event === event)
      expect(contract?.kind, event).toBe('observational')
    }
    // `InstructionsLoaded` fires once per LOADED FILE, not once per session, and
    // this bridge is no longer its owner.
    const instructions = PI_LIFECYCLE_HOOK_CONTRACTS.find(c => c.event === 'InstructionsLoaded')
    expect(instructions?.terminalDelivery).toBe('once-per-occurrence')
    expect(instructions?.owner).toBe('capability-context-builder')
    expect(instructions?.redactedPayload).toEqual([
      'file_path', 'memory_type', 'load_reason', 'globs', 'trigger_file_path', 'parent_file_path',
    ])
    expect(() => getAgentEventContractV1('SessionStart', 2)).toThrow(/version/i)
    expect(() => getAgentEventContractV1('Unknown', 1)).toThrow(/unknown/i)
    // R73 · f001 · and `Setup` is now one of the unknowns, which is the point:
    // nothing can look up a contract for an event this fork cannot emit.
    expect(() => getAgentEventContractV1('Setup', 1)).toThrow(/unknown/i)
  })

  test('emits one redacted batch result and cancels pending MCP correlation on crash teardown', async () => {
    const handlers = new Map<string, (event: Record<string, any>) => unknown>()
    const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: async (event, input) => { emitted.push({ event, input }) },
      getOriginalUserPrompt: () => null,
    })({ on: (event: string, handler: (value: Record<string, any>) => unknown) => handlers.set(event, handler) } as never)

    await handlers.get('before_agent_start')?.({ prompt: 'secret', systemPrompt: 'secret' })
    await handlers.get('turn_end')?.({ toolResults: [{ isError: false }, { isError: true }] })
    await handlers.get('tool_execution_start')?.({ toolCallId: 'pending-1', toolName: 'mcp__gitlab__get_project', args: { token: 'secret' } })
    await handlers.get('session_shutdown')?.({ reason: 'reload' })

    expect(emitted.find(entry => entry.event === 'PostToolBatch')?.input).toMatchObject({ batch_count: 2, error_count: 1, correlation_id: 'turn-1' })
    expect(emitted.filter(entry => entry.event === 'ElicitationResult')).toHaveLength(1)
    expect(emitted.find(entry => entry.event === 'ElicitationResult')?.input).toMatchObject({ correlation_id: 'pending-1', outcome: 'cancelled' })
    expect(JSON.stringify(emitted)).not.toContain('secret')
  })

  test('projects every Pi compaction reason onto the documented manual/auto trigger', async () => {
    // hooks.md#precompact defines exactly two matcher values: `manual` for
    // `/compact` and `auto` for the context-window path. Pi declares
    // `reason: "manual" | "threshold" | "overflow"`, so both non-manual reasons
    // — and an absent one — must land on `auto`, or a `/compact`-only hook
    // fires on every threshold compaction.
    const cases: Array<[Record<string, unknown>, 'manual' | 'auto']> = [
      [{ reason: 'manual' }, 'manual'],
      [{ reason: 'threshold' }, 'auto'],
      [{ reason: 'overflow' }, 'auto'],
      [{}, 'auto'],
    ]
    for (const [event, expected] of cases) {
      const handlers = new Map<string, (value: Record<string, unknown>) => unknown>()
      const emitted: Array<{ event: string; input: Record<string, unknown> }> = []
      const factory = createPiLifecycleExtension({
        cwd: '/repo',
        emit: async (name, input) => { emitted.push({ event: name, input }) },
        getOriginalUserPrompt: () => null,
      })
      await factory({ on: (name: string, handler: (value: Record<string, unknown>) => unknown) => {
        handlers.set(name, handler)
      } } as never)

      await handlers.get('session_before_compact')?.(event)
      await handlers.get('session_compact')?.(event)

      expect(emitted.map(entry => [entry.event, entry.input.trigger])).toEqual([
        ['PreCompact', expected],
        ['PostCompact', expected],
      ])
    }
  })

  test('drops candidate lifecycle events until finalize without replay', async () => {
    const emitted: string[] = []
    const gate = createPiLifecycleSinkGate(event => { emitted.push(event) })

    await gate.emit('SessionStart', { hook_event_name: 'SessionStart' })
    await gate.emit('PreCompact', { hook_event_name: 'PreCompact' })
    expect(emitted).toEqual([])

    gate.open()
    await gate.emit('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'current prompt' })
    expect(emitted).toEqual(['UserPromptSubmit'])
  })
})

// F1.591 — Pi 0.85.1's `AgentSession.abort()` aborts a running compaction and then
// WAITS for idle, and `isIdle` is now false while compacting; the compaction awaits
// the `session_before_compact` handlers. A handler that ignores the `signal` Pi hands
// it therefore holds a Stop until the host answers PreCompact (the production half is
// `__tests__/stop-during-precompact-verdict.test.ts`).
describe('F1.591 · the awaited PreCompact verdict yields to the compaction signal', () => {
  type Verdict = { block?: boolean; reason?: string } | void
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  const handlerFor = async (requestCompactionDecision: () => Promise<Verdict> | Verdict) => {
    const handlers = new Map<string, (value: Record<string, unknown>) => unknown>()
    await createPiLifecycleExtension({
      cwd: '/repo',
      emit: async () => {},
      getOriginalUserPrompt: () => null,
      requestCompactionDecision,
    })({ on: (name: string, handler: (value: Record<string, unknown>) => unknown) => {
      handlers.set(name, handler)
    } } as never)
    return handlers.get('session_before_compact')!
  }

  test('an abort while the host verdict is pending cancels the compaction instead of waiting for the host', async () => {
    let asked = 0
    const handler = await handlerFor(() => { asked += 1; return new Promise<Verdict>(() => {}) })
    const controller = new AbortController()
    const settled = Promise.resolve(handler({ reason: 'manual', signal: controller.signal }))
    controller.abort()
    expect(await Promise.race([settled, sleep(1_000).then(() => 'still waiting on the host')])).toEqual({ cancel: true })
    expect(asked).toBe(1)
  })

  test('a compaction already cancelled when the handler runs does not ask the host at all', async () => {
    let asked = 0
    const handler = await handlerFor(() => { asked += 1; return new Promise<Verdict>(() => {}) })
    const controller = new AbortController()
    controller.abort()
    const settled = Promise.resolve(handler({ reason: 'threshold', signal: controller.signal }))
    expect(await Promise.race([settled, sleep(1_000).then(() => 'still waiting on the host')])).toEqual({ cancel: true })
    expect(asked).toBe(0)
  })

  test('CONTROL — with no abort the handler waits for the verdict and returns exactly it', async () => {
    let answer: (verdict: Verdict) => void = () => {}
    const handler = await handlerFor(() => new Promise<Verdict>(resolve => { answer = resolve }))
    const controller = new AbortController()
    const pending = Promise.resolve(handler({ reason: 'manual', signal: controller.signal }))
    expect(await Promise.race([pending, sleep(50).then(() => 'pending')])).toBe('pending')
    answer({})
    expect(await pending).toBeUndefined()

    const blocked = Promise.resolve(handler({ reason: 'manual', signal: controller.signal }))
    answer({ block: true, reason: 'plan mid-execution' })
    expect(await blocked).toEqual({ cancel: true })
    // A late abort after the verdict changes nothing already returned.
    controller.abort()
    expect(await pending).toBeUndefined()
  })
})
