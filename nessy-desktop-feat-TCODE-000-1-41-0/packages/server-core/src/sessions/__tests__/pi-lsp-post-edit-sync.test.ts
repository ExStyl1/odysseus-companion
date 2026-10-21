import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createPiLspPort, resolvePiLspDocumentUri, syncPiLspDocumentAfterEdit } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * The last two links of Pi's plugin-LSP chain (F1.1013's `LspService.syncDocument`
 * and F1.1025's `extensionToLanguage` router, wired into `SessionManager`).
 *
 * F1.1024 — after an edit the post-edit check tells the owning language server
 * the file changed and waits (bounded) for its push, so the payload describes the
 * NEW text. Before, it read the pushed-diagnostics mirror straight away, and the
 * server had never been told of the edit, so what it held was about the old text.
 *
 * F1.1025 — an `lsp` request that names no language is routed by the path's
 * extension (`plugins-reference.md` § `lspServers`: "Map of file extension to LSP
 * language ID"; `plugins/components.md#lsp-servers`: "the first registered
 * handles those files and the other isn't used for them").
 */

const sessionKey = { workspaceId: 'ws-f1024', sessionId: 'session-f1024' }
const lspKey = encodeSessionKey(sessionKey)

function diagnostic(message: string) {
  return { message, severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
}

function registration(key: string, languages: string[], extensionToLanguage?: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    key,
    lspId: key,
    command: key,
    languages,
    ...(extensionToLanguage ? { extensionToLanguage } : {}),
    executableHash: 'a'.repeat(64),
    ...extra,
  }
}

type SyncCall = [service: string, path: string, languageId: string | undefined]

/** A fake ready service: records each sync, answers `told`, and optionally pushes after it. */
function syncingService(name: string, calls: SyncCall[], told: boolean, push?: () => void) {
  return {
    health: () => ({ status: 'ready' as const }),
    syncDocument: async (path: string, languageId?: string) => {
      calls.push([name, path, languageId])
      if (push) setTimeout(push, 25)
      return told
    },
  }
}

async function projectWithFile() {
  const root = await mkdtemp(join(tmpdir(), 'nessy-f1024-'))
  await mkdir(join(root, 'src'))
  const file = join(root, 'src', 'a.ts')
  await writeFile(file, "export const a: number = 'x'\n")
  return { root, file, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('F1.1024 — the post-edit check syncs the edit to the language server and waits for its push', () => {
  test('the owning server is sent the file with its mapped language, and the payload carries the push about the NEW text', async () => {
    const fixture = await projectWithFile()
    try {
      const manager = createTestSessionManager() as any
      // No check markers in the fixture, so `detectChecks` finds nothing: the
      // payload is the LSP half alone.
      manager.piWorkspaceDrainParticipant = {
        processSupervisorPort: { start: async () => { throw new Error('unexpected-spawn') } },
      }
      const uri = await resolvePiLspDocumentUri(fixture.root, 'src/a.ts')
      const calls: SyncCall[] = []
      manager.piLspServices.set(lspKey, new Map<string, unknown>([
        ['ts', syncingService('ts', calls, true, () => manager.recordPiLspDiagnostics(lspKey, { uri, diagnostics: [diagnostic('new-text error')] }))],
        ['py', syncingService('py', calls, false)],
      ]))
      manager.piLspRegistrations.set(lspKey, [
        registration('ts', ['typescript'], { '.ts': 'typescript' }),
        registration('py', ['python'], { '.py': 'python' }),
      ])
      // What the server said about the file BEFORE the edit.
      manager.recordPiLspDiagnostics(lspKey, { uri, diagnostics: [diagnostic('old-text error')] })

      const payload = await manager.buildEditFeedbackRunner(sessionKey, fixture.root)({
        toolName: 'Edit',
        toolInput: { file_path: 'src/a.ts' },
      })

      expect(payload).toContain('new-text error')
      expect(payload).not.toContain('old-text error')
      // The claimant opens it with the mapped id; the other server only refreshes a copy it may hold.
      expect(calls).toEqual([['ts', fixture.file, 'typescript'], ['py', fixture.file, undefined]])
    } finally {
      await fixture.cleanup()
    }
  })

  test('no wait when no server was sent the text or the told server declared diagnostics:false; otherwise bounded, and only this URI ends it', async () => {
    const fixture = await projectWithFile()
    try {
      const manager = createTestSessionManager() as any
      const calls: SyncCall[] = []
      const registrations = [registration('ts', ['typescript'], { '.ts': 'typescript' })]

      // A 60 s bound would time the test out if either of these waited at all.
      await syncPiLspDocumentAfterEdit(manager, lspKey, {
        services: new Map([['ts', syncingService('ts', calls, false)]]),
        registrations,
      }, fixture.root, fixture.file, undefined, 60_000)
      await syncPiLspDocumentAfterEdit(manager, lspKey, {
        services: new Map([['ts', syncingService('ts', calls, true)]]),
        registrations: [registration('ts', ['typescript'], { '.ts': 'typescript' }, { supervision: { diagnostics: false } })],
      }, fixture.root, fixture.file, undefined, 60_000)
      expect(calls).toEqual([['ts', fixture.file, 'typescript'], ['ts', fixture.file, 'typescript']])

      // Told, and a push arrives only for ANOTHER file: the wait runs to its bound.
      await writeFile(join(fixture.root, 'src', 'other.ts'), 'export {}\n')
      const otherUri = await resolvePiLspDocumentUri(fixture.root, 'src/other.ts')
      const started = Date.now()
      await syncPiLspDocumentAfterEdit(manager, lspKey, {
        services: new Map([['ts', syncingService('ts', calls, true, () => manager.recordPiLspDiagnostics(lspKey, { uri: otherUri, diagnostics: [] }))]]),
        registrations,
      }, fixture.root, fixture.file, undefined, 150)
      expect(Date.now() - started).toBeGreaterThanOrEqual(140)

      // The edit's own signal ends a long wait.
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 20)
      await syncPiLspDocumentAfterEdit(manager, lspKey, {
        services: new Map([['ts', syncingService('ts', calls, true)]]),
        registrations,
      }, fixture.root, fixture.file, abort.signal, 60_000)

      // A server that is not ready is never synced.
      const idle: SyncCall[] = []
      await syncPiLspDocumentAfterEdit(manager, lspKey, {
        services: new Map([['ts', { ...syncingService('ts', idle, true), health: () => ({ status: 'connecting' as const }) }]]),
        registrations,
      }, fixture.root, fixture.file, undefined, 60_000)
      expect(idle).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('F1.1025 — an lsp request with no language is routed by its extension', () => {
  function portWith(calls: Array<[string, string | undefined]>, ready: Record<string, boolean> = {}) {
    const service = (name: string) => ({
      health: () => ({ status: ready[name] === false ? 'connecting' as const : 'ready' as const }),
      request: async (input: { language?: string }) => { calls.push([name, input.language]); return name },
    })
    return createPiLspPort(new Map([
      ['clangd', service('clangd')],
      ['ts-first', service('ts-first')],
      ['ts-second', service('ts-second')],
    ]) as never, [
      registration('clangd', ['c', 'cpp'], { '.c': 'c', '.C': 'cpp' }),
      registration('ts-first', ['typescript'], { '.ts': 'typescript' }),
      registration('ts-second', ['typescript'], { '.ts': 'typescript' }),
    ] as never)
  }

  test('the claiming server gets the request with the mapped language, case kept, and the first registered wins', async () => {
    const calls: Array<[string, string | undefined]> = []
    const port = portWith(calls)
    const signal = new AbortController().signal
    await expect(port.request({ operation: 'hover', path: 'src/main.C', line: 0, character: 0 }, signal)).resolves.toBe('clangd')
    await expect(port.request({ operation: 'document_symbols', path: '/abs/src/util.c' }, signal)).resolves.toBe('clangd')
    await expect(port.request({ operation: 'diagnostics', path: 'src/a.ts' }, signal)).resolves.toBe('ts-first')
    // A NAMED language shared by two servers keeps its own refusal.
    await expect(port.request({ operation: 'diagnostics', path: 'src/a.ts', language: 'typescript' }, signal)).rejects.toThrow('lsp-language-ambiguous')
    expect(calls).toEqual([['clangd', 'cpp'], ['clangd', 'c'], ['ts-first', 'typescript']])
  })

  test('with no claiming map the request still has to name its language, and a claimant that is not ready is unavailable', async () => {
    const calls: Array<[string, string | undefined]> = []
    const signal = new AbortController().signal
    const port = portWith(calls, { clangd: false })
    await expect(port.request({ operation: 'hover', path: 'Makefile', line: 0, character: 0 }, signal)).rejects.toThrow('lsp-language-required')
    await expect(port.request({ operation: 'hover', path: 'main.rs', line: 0, character: 0 }, signal)).rejects.toThrow('lsp-language-required')
    await expect(port.request({ operation: 'workspace_symbols', query: 'x' }, signal)).rejects.toThrow('lsp-language-required')
    await expect(port.request({ operation: 'hover', path: 'main.c', line: 0, character: 0 }, signal)).rejects.toThrow('lsp-unavailable')
    expect(calls).toEqual([])
  })
})
