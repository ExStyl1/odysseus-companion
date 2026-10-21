import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

let createManagedSessionFn: typeof import('./SessionManager.ts')['createManagedSession']
let createTestSessionManagerFn: typeof import('./__tests__/test-session-manager.ts')['createTestSessionManager']

type SessionManagerInstance = InstanceType<typeof import('./SessionManager.ts')['SessionManager']>

type ManagedForTest = {
  agent: unknown
}

type FuzzyFileSearchResultForTest = {
  root: string
  path: string
  match_type: 'file' | 'directory'
  file_name: string
  score: number
  indices: number[] | null
}

type FuzzyApi = {
  fuzzyFileSearch(sessionId: string, query: string): Promise<{ files: FuzzyFileSearchResultForTest[] } | null>
}

function fuzzyApi(sm: SessionManagerInstance): FuzzyApi {
  return sm as unknown as FuzzyApi
}

describe('fuzzy file search', () => {
  let tmpRoot: string
  let sm: SessionManagerInstance

  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-fuzzy-files-'))
    sm = createTestSessionManagerFn()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string): ManagedForTest {
    const workspace = {
      id: 'ws_fuzzy',
      name: 'Fuzzy Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSessionFn(
      { id, name: 'fuzzy file search test', llmConnection: 'codex-conn' },
      workspace as never,
      { messagesLoaded: true },
    ) as ManagedForTest
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${id}`, managed)
    return managed
  }

  it('delegates to a codex-like agent fuzzyFileSearch implementation', async () => {
    const sessionId = 'fuzzy-codex'
    const managed = buildSession(sessionId)
    const files: FuzzyFileSearchResultForTest[] = [{
      root: tmpRoot,
      path: 'src/App.tsx',
      match_type: 'file',
      file_name: 'App.tsx',
      score: 0.97,
      indices: [4, 5, 6],
    }]
    const fuzzyFileSearch = jest.fn(async () => ({ files }))
    managed.agent = { fuzzyFileSearch }

    const result = await fuzzyApi(sm).fuzzyFileSearch(sessionId, 'app')

    expect(fuzzyFileSearch).toHaveBeenCalledWith('app')
    expect(result).toEqual({ files })
  })

  it('returns null for non-codex agents', async () => {
    const sessionId = 'fuzzy-non-codex'
    const managed = buildSession(sessionId)
    managed.agent = { redirect: jest.fn() }

    await expect(fuzzyApi(sm).fuzzyFileSearch(sessionId, 'app')).resolves.toBeNull()
  })
})
