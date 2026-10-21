/**
 * The two host-side stamps their rows could not land in their own lanes.
 *
 * P6.616 — `/usage` could not render the cache breakdown. `TokenUsage.cache` and
 * the overlay group landed in `e801eab21`; the STAMP is here, because this is
 * the only place that can resolve the prompt-cache TTL — `resolvePromptCacheTtl`
 * reads the operator's environment and host config and the renderer has neither.
 * Everything else in the snapshot the renderer derives itself; the lifetime it
 * could not.
 *
 * P6.481 — reasoning does not cross a switch. Both replay arms landed in
 * `2a9731131` and the last wire hop did not: nothing persisted the thinking
 * block's `signature`, so a claude → claude switch could only STRIP every
 * reasoning row. `ThinkingBlockParam` declares `signature` as REQUIRED, so an
 * unsigned block is not a degraded read — it is an unsendable one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

interface Internals {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  sessions: Map<string, unknown>
}

function session(id: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/nessy-usage-cache-stamps',
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const internals = manager as unknown as Internals
  internals.sessions.set(`ws_test:${id}`, managed)
  return { managed, internals }
}

describe('P6.616 — the cache breakdown is stamped where the TTL is knowable', () => {
  it('derives warmth, hit rate and both counters from the turn the counters came from', async () => {
    const { managed, internals } = session('cache-warm')
    await internals.processEvent(managed, {
      type: 'complete',
      usage: {
        inputTokens: 4_000,
        outputTokens: 250,
        cacheReadTokens: 3_000,
        cacheCreationTokens: 200,
        costUsd: 0.01,
      },
    })
    const cache = managed.tokenUsage?.cache
    expect(cache).toBeDefined()
    expect(cache!.warmth).toBe('warm')
    expect(cache!.cacheReadTokens).toBe(3_000)
    expect(cache!.cacheCreationTokens).toBe(200)
    // `inputTokens` already contains BOTH cache halves, which is the denominator
    // `describeCacheUsage` requires — a fresh-only input would overstate this.
    expect(cache!.hitRate).toBeCloseTo(0.75, 5)
  })

  it('says `cold` for a turn that only WROTE the cache, which is a different fact from a miss', async () => {
    const { managed, internals } = session('cache-cold')
    await internals.processEvent(managed, {
      type: 'complete',
      usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 900 },
    })
    expect(managed.tokenUsage?.cache?.warmth).toBe('cold')
    expect(managed.tokenUsage?.cache?.hitRate).toBe(0)
  })
})

describe('P6.481 — the thinking block keeps its attestation', () => {
  it('persists `thinkingSignature` on a reasoning row that carries one', async () => {
    const { managed, internals } = session('reasoning-signed')
    await internals.processEvent(managed, {
      type: 'text_complete',
      text: 'Considering the options.',
      isThinking: true,
      thinkingSignature: 'CAISmQIKiAEIEBgC-test-attestation',
      turnId: 'turn-1',
    })
    const row = managed.messages.find(message => message.isThinking)
    expect(row, 'no reasoning row was persisted').toBeDefined()
    expect(row!.thinkingSignature).toBe('CAISmQIKiAEIEBgC-test-attestation')
  })

  it('omits the field entirely when the producing runtime gave none', async () => {
    // Every runtime but claude. Absent rather than empty, because the replay
    // path's own test is presence: an unsigned block is STRIPPED, and a blank
    // string would look like an attestation to a reader checking only the key.
    const { managed, internals } = session('reasoning-unsigned')
    await internals.processEvent(managed, {
      type: 'text_complete',
      text: 'Considering the options.',
      isThinking: true,
      turnId: 'turn-1',
    })
    const row = managed.messages.find(message => message.isThinking)
    expect(row, 'no reasoning row was persisted').toBeDefined()
    expect(row!.thinkingSignature).toBeUndefined()
    expect('thinkingSignature' in row!).toBe(false)
  })

  it('hands `runtimeHandoffFrom` to both direct history projections as the row origin', () => {
    // Pinned at the SOURCE rather than driven: reaching these two call sites
    // needs a whole runtime switch with a rebuildable transcript, and what the
    // row is about is one argument. `buildRuntimeHandoffPayload` already passes
    // the same value as `origin: input.from`; these two did not, so a reasoning
    // row that names no runtime of its own could not be attributed and was
    // dropped rather than carried.
    const source = readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')
    const passes = source.split('buildRuntimeHandoffHistory({').slice(1)
      .filter(block => block.slice(0, 900).includes('origin: managed.runtimeHandoffFrom'))
    expect(passes).toHaveLength(2)
  })
})
