import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { writeRuntimeAnchor } from '@nessy-agent/shared/sessions'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/**
 * F1.1235 — a relaunched Codex chat hands its agent the thread id it saved.
 *
 * The final sitting (SIT2-d, RC 831fde57f) quit and relaunched the app twice:
 * the log said `Created codex-runtime agent … (resuming)` and codex then ran
 * `thread/start`, so the model had forgotten the whole chat, with no
 * could-not-resume notice. F1.1074's kept rollout was on disk and linked. The
 * thread id was on disk too — in the session header's legacy `sdkSessionId`,
 * where `CodexAgent` publishes it (P6.102) — but the agent config read only
 * `readRuntimeAnchor`, and codex is deliberately not in the anchor map, so the
 * id never reached P6.649's resume arm. DN-273's product test built the agent
 * with the id directly and so never crossed this read.
 *
 * Driven here through `SessionManager` itself: the session is built by
 * `createManagedSession` from a stored header (what `loadSessionsFromDisk`
 * does on every launch), then the production path `createCapabilityTurn` →
 * `getOrCreateAgent` runs up to the backend factory seam, where the config is
 * read (`agent-config-memory-scope.test.ts`'s instrument). The second arm is
 * the in-memory rebuild an idle release or an eviction takes: the id the
 * running agent publishes through the host's own callback is what the next
 * build receives. Boundaries: a fresh codex chat carries no id (codex starts a
 * thread), and a Pi chat still reads its own anchor and nothing else.
 *
 * A codex backend needs a stored `codex-runtime` connection, so the config is
 * seeded and restored around the file (`connection-delete-live-session.test.ts`
 * does the same); without it every case resolves to Pi and would pass for the
 * wrong reason.
 */

setSessionPlatform(createHeadlessPlatform())

const CODEX_SLUG = 'codex-gateway'
const PI_SLUG = 'pi-source'
const TEST_CONNECTIONS = [
  { slug: PI_SLUG, name: 'Pi Source', providerType: 'pi', authType: 'api_key', createdAt: 1 },
  { slug: CODEX_SLUG, name: 'Codex (Nessy Gateway)', providerType: 'codex-runtime', authType: 'bearer_token', createdAt: 1 },
] as unknown as NonNullable<StoredConfig['llmConnections']>

let restoreConfig: () => void = () => {}
const roots: string[] = []

beforeAll(async () => {
  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  storage.saveConfig({ ...base, defaultLlmConnection: PI_SLUG, llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS) // a SessionManager module graph behind a dynamic import (lint:module-graph-hooks, F1.59 gate 2026-10-02)

afterAll(() => restoreConfig())

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface CapturedConfig {
  session?: { sdkSessionId?: string }
  onSdkSessionIdUpdate?: (id: string) => void
}

interface Internals {
  sessions: Map<string, unknown>
  createCapabilityTurn(managed: unknown): Promise<{ runtime: { provider?: string } }>
  getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
  createBackendFromManagedContext(args: { coreConfig: CapturedConfig }): unknown
  cleanup(): void
}

/** A session as the startup restore builds it from its stored header. */
function restoredSession(stored: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'nessy-codex-resume-anchor-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-a', ...stored }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
    workingDirectory: workspaceRoot,
  })
  const internals = manager as unknown as Internals
  internals.sessions.set('workspace-a:session-a', managed)
  return { managed, internals }
}

/** One agent build on the production path, stopped at the factory seam. */
async function buildConfig(internals: Internals, managed: unknown): Promise<{ config: CapturedConfig; provider?: string }> {
  const turn = await internals.createCapabilityTurn(managed)
  let captured: CapturedConfig | undefined
  internals.createBackendFromManagedContext = args => {
    captured = args.coreConfig
    throw new Error('captured-before-construction')
  }
  await expect(internals.getOrCreateAgent(managed, turn.runtime)).rejects.toThrow('captured-before-construction')
  expect(captured).toBeTruthy()
  return { config: captured!, provider: turn.runtime.provider }
}

describe('F1.1235 — a relaunched codex chat resumes the thread it saved', () => {
  it('hands the stored codex thread id to the new agent, and the id the agent publishes to the next build', async () => {
    // The sitting's record: the header holds the codex thread id in the legacy
    // slot and an EMPTY anchor map.
    const { managed, internals } = restoredSession({
      llmConnection: CODEX_SLUG,
      sdkSessionId: 'codex-thread-1',
      sdkSessionAnchors: {},
    })
    try {
      const first = await buildConfig(internals, managed)
      expect(first.provider).toBe('codex-runtime')
      expect(first.config.session?.sdkSessionId).toBe('codex-thread-1')

      // The running agent opens (or re-forks) a thread and publishes its id
      // through the host's callback; the agent is then released (idle reaper,
      // eviction) and rebuilt from the in-memory record.
      expect(typeof first.config.onSdkSessionIdUpdate).toBe('function')
      first.config.onSdkSessionIdUpdate!('codex-thread-2')
      const rebuilt = await buildConfig(internals, managed)
      expect(rebuilt.config.session?.sdkSessionId).toBe('codex-thread-2')
    } finally {
      internals.cleanup()
    }
  })

  it('a fresh codex chat carries no thread id, and a Pi chat still reads only its own anchor', async () => {
    const fresh = restoredSession({ llmConnection: CODEX_SLUG })
    try {
      const built = await buildConfig(fresh.internals, fresh.managed)
      expect(built.provider).toBe('codex-runtime')
      expect(built.config.session?.sdkSessionId).toBeUndefined()
    } finally {
      fresh.internals.cleanup()
    }

    const pi = restoredSession({
      llmConnection: PI_SLUG,
      sdkSessionId: 'legacy-id-not-pi',
      sdkSessionAnchors: writeRuntimeAnchor(undefined, 'pi', 'pi-session-1'),
    })
    try {
      const built = await buildConfig(pi.internals, pi.managed)
      expect(built.provider).toBe('pi')
      expect(built.config.session?.sdkSessionId).toBe('pi-session-1')
    } finally {
      pi.internals.cleanup()
    }
  })
})
