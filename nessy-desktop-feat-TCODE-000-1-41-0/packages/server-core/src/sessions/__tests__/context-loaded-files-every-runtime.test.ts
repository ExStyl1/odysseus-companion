/**
 * P6.397 — `/context` names the instruction and memory files that loaded, on a
 * runtime that reports no snapshot of its own.
 *
 * Measured at HEAD: `ContextUsageSnapshot` had exactly ONE producer
 * (`pi-agent-server/src/context-categories.ts`) and `requestContextUsage` is
 * implemented only by `PiAgent`, so `refreshContextUsage` on claude and on codex
 * returned `unsupported` with whatever snapshot the session already had — which
 * for those two is none, because their event adapters emit `tokenUsage` and
 * never a `contextUsage`. The loaded-files group was therefore empty on two of
 * three runtimes for a fact that is not per-runtime at all.
 *
 * The control is the Pi arm: a runtime that DOES implement
 * `requestContextUsage` must be untouched, or the host composition would be
 * overwriting the producer the row calls the reference.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { ContextUsageSnapshot } from '@nessy-agent/core/types'
import { estimateTokens } from '@nessy-agent/shared/utils/large-response'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
})

let seq = 0

const BODIES: Record<string, string> = {
  '/repo/AGENTS.md': 'project instructions that steer this workspace',
  '/home/u/.claude/CLAUDE.md': 'user memory',
}

function fakeRuntime(over: { readText?: (path: string) => Promise<string> } = {}) {
  const layer = (key: string, absolutePath: string) => ({
    key,
    order: 0,
    resource: { absolutePath, contentHash: `hash-${key}` },
  })
  return {
    view: {
      promptLayers: [layer('project:AGENTS.md', '/repo/AGENTS.md')],
      memory: [layer('user:CLAUDE.md', '/home/u/.claude/CLAUDE.md')],
    },
    materializer: {
      assertActive: () => {},
      readText: async (resource: { absolutePath?: string }) => (
        over.readText
          ? over.readText(resource.absolutePath ?? '')
          : BODIES[resource.absolutePath ?? ''] ?? ''
      ),
    },
  }
}

function fixture(agent: Record<string, unknown>, runtime: unknown) {
  const manager = createTestSessionManager()
  managers.push(manager)
  seq += 1
  const workspaceId = `ws-context-${seq}`
  const managed = createManagedSession({ id: `session-context-${seq}` }, {
    id: workspaceId,
    name: 'Workspace Context',
    rootPath: '/tmp/nessy-context-loaded-files',
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  managed.agent = agent as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspaceId}:${managed.id}`,
    managed,
  )
  const internals = manager as unknown as {
    withCapabilityRuntime<T>(m: unknown, action: (r: unknown) => Promise<T>): Promise<T>
    getOrCreateAgent(m: unknown, r: unknown): Promise<unknown>
    acquireSessionMutationBoundary(m: unknown): () => void
  }
  internals.withCapabilityRuntime = async (_m, action) => action(runtime)
  internals.getOrCreateAgent = async () => agent
  internals.acquireSessionMutationBoundary = () => () => {}
  return { manager, managed, workspaceId }
}

describe('the loaded-files group reaches a runtime that reports no snapshot (P6.397)', () => {
  test('a claude/codex session gets the files, named and sized exactly as Pi names and sizes them', async () => {
    // POSITIVE. The agent implements no `requestContextUsage` — which is
    // literally true of `ClaudeAgent` and `CodexAgent` — and the host composes
    // the one group it owns.
    const { manager, managed, workspaceId } = fixture({}, fakeRuntime())

    const result = await manager.refreshContextUsage(managed.id, workspaceId)

    // Still `unsupported`, and honestly so: the RUNTIME did not measure this,
    // which is why there is a file list and no per-category breakdown.
    expect(result.unsupported).toBe(true)
    expect(result.usage?.loadedFiles).toEqual([
      {
        name: 'project:AGENTS.md',
        kind: 'instruction',
        tokens: estimateTokens(BODIES['/repo/AGENTS.md'] ?? ''),
      },
      {
        name: 'user:CLAUDE.md',
        kind: 'memory',
        tokens: estimateTokens(BODIES['/home/u/.claude/CLAUDE.md'] ?? ''),
      },
    ])
    // …and it is stored on the session, so the overlay reads it without asking
    // again.
    expect(managed.contextUsage?.loadedFiles).toHaveLength(2)
    // No other category is invented: the host cannot price a system prompt it
    // does not build.
    expect(managed.contextUsage?.categories).toBeUndefined()
  })

  test('a runtime that DOES report a snapshot is untouched, and an unreadable layer composes nothing', async () => {
    // NEGATIVE 1, the control: Pi is the reference producer, and the host arm
    // must never overwrite it.
    const piSnapshot: ContextUsageSnapshot = {
      inputTokens: 42,
      source: 'sdk_usage',
      loadedFiles: [{ name: 'pi:AGENTS.md', kind: 'instruction', tokens: 7 }],
    }
    const pi = fixture({ requestContextUsage: async () => piSnapshot }, fakeRuntime())
    const piResult = await pi.manager.refreshContextUsage(pi.managed.id, pi.workspaceId)
    expect(piResult.unsupported).toBeUndefined()
    expect(piResult.usage?.loadedFiles).toEqual(piSnapshot.loadedFiles)

    // NEGATIVE 2: a materializer that cannot read a layer composes NOTHING
    // rather than a list with a hole in it — a file reported as loaded that is
    // not is worse than the empty group this fork already showed.
    const broken = fixture({}, fakeRuntime({
      readText: async () => { throw new Error('capability lease revoked') },
    }))
    const brokenResult = await broken.manager.refreshContextUsage(broken.managed.id, broken.workspaceId)
    expect(brokenResult.unsupported).toBe(true)
    expect(brokenResult.usage).toBeUndefined()
    expect(broken.managed.contextUsage).toBeUndefined()
  })
})
