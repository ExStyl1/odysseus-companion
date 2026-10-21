/**
 * UA12.108 — the schema half ported (session-tools-core `SpawnSessionSchema`), this pins the hop the field
 * rides: `preExecuteSpawnSession` reads `input.projectId` into the `SpawnSessionRequest` the host's folder rule
 * consumes (`SessionManager.onSpawnSession` → `spawnSessionProjectFields`, UA5.4). The non-string guard drops
 * silently ON PURPOSE — the refusal point is the schema (UA12.108's control: a number is refused there), this
 * hop is belt-and-braces and must not manufacture a value.
 *
 * Positive: a string `projectId` reaches `onSpawnSession` unchanged.
 * Negative: a non-string `projectId` arrives as `undefined` — never coerced into a project binding.
 */
import { describe, expect, it } from 'bun:test'
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts'
import { TestAgent, createMockBackendConfig } from './test-utils.ts'

class SpawnTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSpawnSession(input)
  }
}

function setup() {
  const agent = new SpawnTestAgent(createMockBackendConfig())
  const captured: SpawnSessionRequest[] = []
  agent.onSpawnSession = async (request) => {
    captured.push(request)
    return { sessionId: 'spawned-id', name: 'spawned', status: 'started' } as SpawnSessionResult
  }
  return { agent, captured }
}

describe('UA12.108 — the projectId pass-through reaches the host request', () => {
  it('positive: a string projectId rides the request to onSpawnSession', async () => {
    const { agent, captured } = setup()
    await agent.invokeSpawn({ prompt: 'ship it', projectId: 'proj_ua12_108' })
    expect(captured[0]?.projectId).toBe('proj_ua12_108')
  })

  it('negative: a non-string projectId is dropped here (the schema is the refusal point), never coerced', async () => {
    const { agent, captured } = setup()
    await agent.invokeSpawn({ prompt: 'ship it', projectId: 42 })
    expect(captured[0]?.projectId).toBeUndefined()
  })
})
