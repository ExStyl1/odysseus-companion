import { describe, expect, test } from 'bun:test'

import { evaluateClaudeHookIfFilter } from '@nessy-agent/shared/agent/pi-harness/claude-permission-rules'
import { PiAgent } from '@nessy-agent/shared/agent'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '@nessy-agent/shared/agent/pi-harness/harness-manifest'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '@nessy-agent/shared/agent/pi-harness/harness-tool-descriptor'

import { createPiPermissionService } from './permission-service.ts'

/**
 * ONE `PermissionRequest` per prompt on the COMPOSED Pi path (R15), and one
 * `PermissionDenied`.
 *
 * The composition is what the defect lived in: `SessionManager` builds the Pi
 * permission service and the agent's automation system, and the two used to
 * emit the same event independently — the band in `pi-agent.ts` with the
 * documented input, and `permission-service.ts` again with a payload carrying
 * no `tool_input`, no `permission_mode`, no `permission_suggestions`, a
 * discarded return value, and the Pi BINDING spelling of the tool
 * (`subject.piName`, lowercase `bash`) rather than the spelling permission
 * rules and hook `if` filters match (`Bash`).
 *
 * hooks.md:1632 — "PermissionRequest hooks receive `tool_name` and `tool_input`
 * fields like PreToolUse hooks, but without `tool_use_id`", and hooks.md:342
 * makes `if` (permission-rule syntax) evaluable on this event, which needs that
 * input. A hook that side-effects or filters on `if` must see exactly one event.
 *
 * These tests wire the REAL service and the REAL agent into ONE automation
 * system, so re-adding a second emitter anywhere in the composition turns the
 * count assertions red.
 */

type Emission = { event: string; input: Record<string, unknown> }

function composedSession(mode: string, approve: boolean | undefined) {
  const emitted: Emission[] = []
  const record = async (event: string, input: Record<string, unknown>) => {
    emitted.push({ event, input })
    return { matchedCount: 0 }
  }
  // The service as SessionManager composes it: interactive approval only. The
  // legacy `emitAutomationEvent` forwarder that SessionManager used to pass is
  // ALSO handed over, through a cast — the option no longer exists, and passing
  // it anyway is what makes this a two-emitter detector rather than a
  // single-emitter tautology. It forwards into the SAME `emitted` list the
  // agent's band emits into, so if `authorize` ever emits again, every count
  // assertion below sees two.
  const service = createPiPermissionService({
    ...(approve === undefined ? {} : { requestApproval: async () => ({ allowed: approve }) }),
    emitAutomationEvent: record,
  } as never)
  const sessionId = `session-r15-${mode}-${approve}`
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: 'ws-r15',
      name: 'R15 Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-r15',
    },
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    },
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: service,
    contextProfile: 'bare',
  } as never)
  agent.setPermissionMode(mode as never)
  const sent: Array<Record<string, unknown>> = []
  const internals = agent as unknown as {
    send: (message: Record<string, unknown>) => void
    emitAutomationEvent: typeof record
    setCurrentTurnUserMessage: (message: string) => void
    setCapabilityTurnRuntime: (runtime: unknown) => void
    activeExecutionManifest: unknown
    handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>
  }
  internals.send = message => { sent.push(message) }
  internals.emitAutomationEvent = record
  internals.setCurrentTurnUserMessage('push the branch')

  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'r15-generation',
    sessionKey: { workspaceId: 'ws-r15', sessionId },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
      return modelContractHash
        ? [{
            descriptor: getHarnessToolDescriptor(binding.descriptorId),
            binding,
            source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
            modelContractHash,
          }]
        : []
    }),
  }
  const manifest = finalizePiExecutionManifest(seed, [])
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'Bash')
  if (!tool) throw new Error('missing Bash tool binding')
  internals.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  })
  internals.activeExecutionManifest = manifest

  const run = async (command: string) => {
    await internals.handlePreToolUseRequest({
      requestId: `req-${mode}-${command.length}`,
      semanticId: tool.descriptor.id,
      piName: tool.binding.piName,
      surfaceVersion: manifest.surfaceVersion,
      manifestResponseEpoch: 0,
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      toolName: 'Bash',
      input: { command },
    })
  }
  return { agent, emitted, sent, run, piName: tool.binding.piName }
}

describe('R15 — one PermissionRequest per prompt on the composed Pi path', () => {
  test('a single prompt fires PermissionRequest exactly once, with the documented input', async () => {
    const session = composedSession('default', true)
    await session.run('git push origin main')
    session.agent.destroy()

    const requests = session.emitted.filter(entry => entry.event === 'PermissionRequest')
    expect(requests).toHaveLength(1)

    const input = requests[0]!.input
    // hooks.md:1632's documented fields, all four present on the one emission.
    expect(input.hook_event_name).toBe('PermissionRequest')
    expect(input.tool_input).toEqual({ command: 'git push origin main' })
    expect(input.permission_mode).toBe('default')
    // UA12.71 — `git push origin main` mints no Always Allow key (UA12.70), so the
    // band offers no suggestion; it offered `Bash(git:*)` at `session` until then.
    // The offer itself is pinned by pi-agent-pretool-hook-decision.test.ts "UA12.71".
    expect(input.permission_suggestions).toBeUndefined()
    // The tool name is spelled the way permission rules and `if` filters match,
    // never the Pi binding spelling the removed emitter used.
    expect(input.tool_name).toBe('Bash')
    expect(input.tool_name).not.toBe(session.piName)
  })

  test("an `if: \"Bash(git *)\"` hook matches the emission, and a non-matching rule does not", async () => {
    const session = composedSession('default', true)
    await session.run('git push origin main')
    session.agent.destroy()

    const input = session.emitted.find(entry => entry.event === 'PermissionRequest')!.input
    // The real `if` evaluator, fed the emitted payload exactly as the hook
    // runner feeds it (tool name + tool input). This is what the second
    // emitter's payload could never satisfy: no `tool_input` at all.
    const call = {
      toolName: String(input.tool_name),
      toolInput: input.tool_input as Record<string, unknown>,
      cwd: '/tmp/project-root',
    }
    expect(evaluateClaudeHookIfFilter('Bash(git *)', call).run).toBe(true)
    expect(evaluateClaudeHookIfFilter('Bash(npm *)', call).run).toBe(false)
  })

  test('PermissionDenied likewise fires exactly once, with tool_input and permission_mode', async () => {
    // `dontAsk` never prompts, so a would-prompt call is denied by the mode —
    // the auto-mode-style denial the band reports (hooks.md § PermissionDenied).
    const session = composedSession('dontAsk', undefined)
    await session.run('git push origin main')
    session.agent.destroy()

    const denials = session.emitted.filter(entry => entry.event === 'PermissionDenied')
    expect(denials).toHaveLength(1)

    const input = denials[0]!.input
    expect(input.tool_name).toBe('Bash')
    expect(input.tool_name).not.toBe(session.piName)
    expect(input.tool_input).toEqual({ command: 'git push origin main' })
    expect(input.permission_mode).toBe('dontAsk')
  })

  test('a human refusing the prompt fires no PermissionDenied at all', async () => {
    // hooks.md § PermissionDenied: it "doesn't run when you manually deny a
    // permission dialog". One PermissionRequest, zero PermissionDenied.
    const session = composedSession('default', false)
    await session.run('git push origin main')
    session.agent.destroy()

    expect(session.emitted.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(1)
    expect(session.emitted.filter(entry => entry.event === 'PermissionDenied')).toHaveLength(0)
    expect(session.sent.at(-1)).toMatchObject({ action: 'block' })
  })
})
