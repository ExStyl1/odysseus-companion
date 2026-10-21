import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionFilePath } from '@nessy-agent/shared/sessions/storage'
import { readSessionJsonl } from '@nessy-agent/shared/sessions/jsonl'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { ContextUsageSnapshot } from '@nessy-agent/shared/protocol/dto'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * CDP pass 9 gap, host half: once the subprocess emits the category snapshot on
 * turn completion, the production event seam must land it where the `/context`
 * overlay reads (`session.contextUsage ?? tokenUsage.contextUsage`) and it must
 * survive a restart via the persisted session header. Also pins the
 * `contextTokens` fix: the field was initialized to 0 and never written, and
 * the overlay's `contextTokens ?? inputTokens` preferred that 0 over the real
 * total ("Current context 0" live).
 */

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

function snapshot(): ContextUsageSnapshot {
  return {
    inputTokens: 41_643,
    contextWindow: 200_000,
    contextWindowSource: 'runtime',
    percent: 20.8,
    remainingWindow: 158_357,
    source: 'sdk_usage',
    categories: [
      { id: 'system_prompt', tokens: 12_000 },
      { id: 'system_tools', tokens: 8_000 },
      { id: 'mcp_tools', tokens: 0 },
      { id: 'custom_subagents', tokens: 0 },
      { id: 'memory_files', tokens: 3_000 },
      { id: 'skills', tokens: 1_000 },
      { id: 'conversation_messages', tokens: 15_000 },
    ],
    unattributedTokens: 2_643,
    loadedFiles: [{ name: 'project:AGENTS.md', kind: 'instruction', tokens: 3_000 }],
  }
}

describe('turn-completion context usage persistence', () => {
  it('lands the snapshot on the overlay path and persists it across a reload', async () => {
    const manager = createTestSessionManager()
    managers.push(manager)
    const managed = createManagedSession({ id: 'context-usage-turn' }, {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-context-usage-turn',
      createdAt: 1,
    } as never, { messagesLoaded: true })
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'ws_test:context-usage-turn',
      managed,
    )
    const internals = manager as unknown as {
      processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
      persistSession(managed: unknown): void
      flushSession(sessionId: string, workspaceId?: string): Promise<void>
    }

    // The production event seam the chat loop feeds — the same usage_update the
    // Pi adapter yields for a subprocess context_usage_update.
    await internals.processEvent(managed, {
      type: 'usage_update',
      usage: { inputTokens: 41_643, contextWindow: 200_000, contextUsage: snapshot() },
    })

    expect(managed.contextUsage?.categories?.map(category => category.id)).toEqual([
      'system_prompt',
      'system_tools',
      'mcp_tools',
      'custom_subagents',
      'memory_files',
      'skills',
      'conversation_messages',
    ])
    expect(managed.tokenUsage?.contextUsage?.loadedFiles).toEqual(snapshot().loadedFiles)
    expect(managed.tokenUsage?.inputTokens).toBe(41_643)
    // The overlay's total prefers `contextTokens ?? inputTokens`; a lingering 0
    // here rendered "Current context 0" even with real usage.
    expect(managed.tokenUsage?.contextTokens).toBe(41_643)

    internals.persistSession(managed)
    await internals.flushSession('context-usage-turn', 'ws_test')

    // Restart source of truth: the persisted header carries the snapshot...
    const sessionFile = getSessionFilePath('ws_test', 'context-usage-turn')
    const header = JSON.parse(readFileSync(sessionFile, 'utf-8').split('\n')[0]!)
    expect(header.tokenUsage?.contextUsage?.categories).toHaveLength(7)
    expect(header.tokenUsage?.contextTokens).toBe(41_643)

    // ...and the production reader hydrates it back.
    const reloaded = readSessionJsonl(sessionFile)
    expect(reloaded?.tokenUsage?.contextUsage?.categories?.map((category: { id: string }) => category.id))
      .toContain('conversation_messages')
    expect(reloaded?.tokenUsage?.contextUsage?.unattributedTokens).toBe(2_643)
  })
})
