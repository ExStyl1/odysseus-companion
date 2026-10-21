/**
 * P6.237 — the operator's `disableAgentView`, as the SPAWNER reports it.
 *
 * The host refuses at `ChildSessionService.start()`, the single admission point
 * every background surface reaches. That refusal arrives here as a bare host
 * code, and the spawner's own docblock already says what happens if such a code
 * reaches the model unchanged: it reads as a crash. So the second half of
 * "legible rather than a silent no-op" is this translation.
 *
 * Two refusals now arrive on the same door with the same shape — the spending
 * cap and this one — and only one of them can be cleared by the user. A model
 * told to ask for a raised limit when the real answer is "your administrator
 * turned this off" sends the user after the wrong lever, which is why the
 * sentences are separate rather than shared.
 *
 * Page: `admin-setup.md#decide-what-to-enforce`. The key's spelling is the
 * claude SDK's own (`sdk.d.ts`: "Disable agent view (`claude agents`, `--bg`,
 * /background, the on-demand daemon). Typically set in managed settings.").
 */
import { describe, expect, it } from 'bun:test'

import { CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR } from '../../../server-core/src/pi-harness/child-session-service.ts'
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import type { AgentDefinition } from '../../../shared/src/agents/index.ts'
import {
  AGENT_VIEW_DISABLED_SPAWN_MESSAGE,
  BUDGET_EXHAUSTED_SPAWN_MESSAGE,
  configureSpawner,
  HOST_AGENT_VIEW_DISABLED_ERROR,
  spawnChildSession,
} from './spawner.ts'

const scout: AgentDefinition = {
  name: 'scout', description: 'Scout', systemPrompt: 'Scout prompt', toolset: 'read-only',
  tools: ['read', 'grep', 'find', 'ls'], tier: 'small',
}

function port(overrides: Partial<PiChildSessionPort> = {}): PiChildSessionPort {
  return {
    start: async input => ({ agentId: input.requestedAgentId ?? 'child', status: 'completed', output: 'ok', result: 'ok' }),
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {}, getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {}, stopTask: async () => {}, sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: 'ok', result: 'ok' }),
    ...overrides,
  }
}

function spawn() {
  return spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp/ws', background: false })
}

describe('spawner — the managed disableAgentView switch', () => {
  it('is the same literal the host refuses with', () => {
    // Re-declared rather than imported: server-core is host code and must never
    // enter the Pi subprocess bundle. This assertion is the only thing keeping
    // the two copies equal, so it imports both.
    expect(HOST_AGENT_VIEW_DISABLED_ERROR).toBe(CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR)
  })

  it('turns the host refusal into an honest message, without retrying it', async () => {
    let starts = 0
    configureSpawner({
      childSessionPort: port({
        start: async () => {
          starts += 1
          throw new Error(CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR)
        },
      }),
      modelId: 'default-model',
      retryBaseDelayMs: () => 0,
    })

    const refused = await spawn()
    expect(refused.status).toBe('error')
    expect(refused.error).toBe(AGENT_VIEW_DISABLED_SPAWN_MESSAGE)
    expect(refused.text).toBe('')
    // ONE attempt: a managed-policy refusal is not a transient, so the retry
    // arm below it never sees this error.
    expect(starts).toBe(1)
  })

  it('does not borrow the spending cap sentence — the two refusals stay distinct', async () => {
    // The negative control that matters. Both codes reach the same arm; a
    // single shared sentence would send the user to raise a limit that is not
    // the obstacle.
    configureSpawner({
      childSessionPort: port({ start: async () => { throw new Error(CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR) } }),
      modelId: 'default-model',
      retryBaseDelayMs: () => 0,
    })
    const refused = await spawn()
    expect(refused.error).not.toBe(BUDGET_EXHAUSTED_SPAWN_MESSAGE)
    expect(refused.error).toContain('disableAgentView')
    expect(AGENT_VIEW_DISABLED_SPAWN_MESSAGE).not.toBe(BUDGET_EXHAUSTED_SPAWN_MESSAGE)
  })

  it('leaves an ordinary spawn untouched', async () => {
    let starts = 0
    configureSpawner({
      childSessionPort: port({
        start: async input => { starts += 1; return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' } },
      }),
      modelId: 'default-model',
      retryBaseDelayMs: () => 0,
    })
    const done = await spawn()
    expect(done.status).toBe('done')
    expect(starts).toBe(1)
  })
})
