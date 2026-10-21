import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionFilePath } from '@nessy-agent/shared/sessions/storage'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * B2 task 2: the persisted record must say whether its `costUsd` is a figure a
 * backend established.
 *
 * The pre-existing seam accumulated `event.usage.costUsd ?? 0`, so a backend that
 * reports no cost — Codex, whose token payload has no money field, and the Nessy
 * Gateway and Nestor Cloud, which return none — persisted `costUsd: 0`. Zero is
 * what a free turn also persists, and the usage overlay rendered on `costUsd > 0`,
 * so the user saw either "$0.00" or nothing at all where the truth is "unknown".
 */

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

interface Internals {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  persistSession(managed: unknown): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
  sessions: Map<string, unknown>
}

function session(id: string): { managed: ReturnType<typeof createManagedSession>; internals: Internals } {
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/nessy-cost-reporting',
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const internals = manager as unknown as Internals
  internals.sessions.set(`ws_test:${id}`, managed)
  return { managed, internals }
}

describe('cost-reporting persistence', () => {
  it('records a Nestor turn as cost-unsupported and persists that, not a zero', async () => {
    const { managed, internals } = session('cost-nestor')

    // The Nestor Cloud shape: a usage_update carrying context, then a bare
    // `complete` with no usage at all (`nestor-cloud/turn.ts`).
    await internals.processEvent(managed, {
      type: 'usage_update',
      usage: { inputTokens: 1_200, contextWindow: 128_000 },
    })
    await internals.processEvent(managed, { type: 'complete' })

    expect(managed.tokenUsage?.costReporting).toBe('unsupported')
    expect(managed.tokenUsage?.costUsd).toBe(0)

    internals.persistSession(managed)
    await internals.flushSession('cost-nestor', 'ws_test')

    const header = JSON.parse(
      readFileSync(getSessionFilePath('ws_test', 'cost-nestor'), 'utf-8').split('\n')[0]!,
    )
    expect(header.tokenUsage?.costReporting).toBe('unsupported')
  })

  it('records a Codex turn as cost-unsupported even though it reports tokens', async () => {
    const { managed, internals } = session('cost-codex')

    // What `CodexAgent.withCodexUsage` emits: real counts, explicit marker.
    await internals.processEvent(managed, {
      type: 'complete',
      usage: { inputTokens: 900, outputTokens: 40, contextWindow: 272_000, costReporting: 'unsupported' },
    })

    expect(managed.tokenUsage?.costReporting).toBe('unsupported')
    expect(managed.tokenUsage?.outputTokens).toBe(40)
  })

  it('persists the full per-model map and a reported verdict for a Claude turn', async () => {
    const { managed, internals } = session('cost-claude')

    const turn = {
      type: 'complete',
      usage: {
        inputTokens: 5_000,
        outputTokens: 300,
        costUsd: 0.42,
        contextWindow: 200_000,
        costReporting: 'reported',
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 4_000, outputTokens: 250, cacheReadTokens: 100,
            cacheCreationTokens: 20, webSearchRequests: 1, costUsd: 0.4,
            costReporting: 'reported',
          },
          'claude-haiku-4-5': {
            inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 0,
            cacheCreationTokens: 0, webSearchRequests: 0, costUsd: 0.02,
            costReporting: 'reported',
          },
        },
      },
    }
    await internals.processEvent(managed, turn)
    await internals.processEvent(managed, turn)

    expect(managed.tokenUsage?.costReporting).toBe('reported')
    // The MAP, accumulated per model — not a flattened total.
    expect(Object.keys(managed.tokenUsage?.modelUsage ?? {}).sort())
      .toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6'])
    expect(managed.tokenUsage?.modelUsage?.['claude-sonnet-4-6']?.inputTokens).toBe(8_000)
    expect(managed.tokenUsage?.modelUsage?.['claude-haiku-4-5']?.costUsd).toBeCloseTo(0.04, 10)

    internals.persistSession(managed)
    await internals.flushSession('cost-claude', 'ws_test')

    const header = JSON.parse(
      readFileSync(getSessionFilePath('ws_test', 'cost-claude'), 'utf-8').split('\n')[0]!,
    )
    expect(header.tokenUsage?.modelUsage?.['claude-sonnet-4-6']?.webSearchRequests).toBe(2)
    expect(header.tokenUsage?.costReporting).toBe('reported')
  })

  it('marks a session that switched backends mid-way as partial', async () => {
    const { managed, internals } = session('cost-mixed')

    await internals.processEvent(managed, {
      type: 'complete',
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1, costReporting: 'reported' },
    })
    await internals.processEvent(managed, {
      type: 'complete',
      usage: { inputTokens: 200, outputTokens: 20, costReporting: 'unsupported' },
    })

    expect(managed.tokenUsage?.costReporting).toBe('partial')
  })

  it('never creates a usage record just to say the cost is unknown', async () => {
    const { managed, internals } = session('cost-empty')

    await internals.processEvent(managed, { type: 'complete' })

    // Several surfaces branch on `if (managed.tokenUsage)`; a turn that produced
    // no usage at all must not start rendering a zeroed token summary.
    expect(managed.tokenUsage).toBeUndefined()
  })
})

/**
 * P2.44 — THE SPEND CEILING'S SESSION ANCHOR IS ACTUALLY WIRED.
 *
 * `BaseAgent` resumes its ceiling from `config.getSessionSpendUsd()`, and this
 * class is the only thing that supplies it. The seam is OPTIONAL on
 * `BackendConfig` (every other agent construction in the repo omits it), so
 * deleting the one line that wires it compiles clean and every behaviour test
 * stays green — measured, by deleting it. The ceiling would then silently go
 * back to restarting at $0 for every new instance, which is the whole defect.
 *
 * A behaviour test would have to build the config object `createAgent` composes
 * inline inside a very large method, with no seam to reach it; the sibling
 * anchor (`getPiWebSearchesUsed`, R48) has no wiring test for the same reason.
 * So this asserts the wiring at the source, which is exactly the failure mode
 * above and no more than that. If a `createAgent` config harness ever exists,
 * replace this with the real thing.
 */
describe('the spend ceiling reads the session total this file maintains', () => {
  it('SessionManager wires getSessionSpendUsd to tokenUsage.costUsd', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'SessionManager.ts'), 'utf8')
    const wiring = source
      .split('\n')
      .filter(line => line.includes('getSessionSpendUsd') && !line.trim().startsWith('//'))

    // Positive control: the field name must appear at all. An empty result would
    // otherwise pass this test for a renamed field or an unreadable path.
    expect(wiring.length).toBeGreaterThan(0)
    // And it must read the accumulator the rest of this file is about, not some
    // second total that could drift from the figure the cost surface renders.
    expect(wiring.some(line => /getSessionSpendUsd:\s*\(\)\s*=>\s*managed\.tokenUsage\?\.costUsd/.test(line))).toBe(true)
  })
})
