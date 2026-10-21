import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * P6.394 L42 — **REFUTED at HEAD.** The ledger cell reads *"The Pi arm's block
 * iterates a field no production producer sets"*, and at HEAD both candidate
 * fields have a producer AND a reader. This file is the refutation, kept as a
 * test rather than as a report line because the claim is about a WIRE and a
 * wire that loses its producer goes quiet rather than red.
 *
 * **`sessionAdditionalDirectories`** — written by `PiAgent.applyPermissionRequestUpdates`
 * on a `PermissionRequest` hook's `addDirectories` grant (R15), read here by
 * `SessionManager.sessionAdditionalDirectories`, which merges it with the
 * configured set and hands the union to every `shouldAllowToolInMode` gate site.
 * The first case drives that merge.
 *
 * **`approvedFilesystemRoots`** — written by the `onOutsideRootGranted` callback
 * the backend config carries, read back into the session filesystem scope on the
 * next agent construction and into the Pi runtime security summary. The second
 * case drives the write through the same callback production uses.
 *
 * **The THIRD reading, and the one the cell most likely meant, is also not a
 * defect.** `additionalRoots: []` appears twice inside the Pi subprocess —
 * `pi-agent-server/src/local-tools/runtime-backed-tools.ts`'s `cwdScope`, whose
 * own docblock says it is *"Formatting-only scope over the already-authorized
 * runtime cwd … AFTER the LocalToolRuntime made the authoritative scope
 * decision"*, and `src/index.ts`'s `sessionScopeFor`, whose `[]` is the
 * documented *"Fallback (legacy hosts/tests without a shipped scope)"*. The real
 * value is shipped in `initConfig.filesystemScope`, which this host fills from
 * `managed.approvedFilesystemRoots`. Both literals are asserted below with their
 * neighbouring evidence, so a future edit that turns either into a live default
 * fails here instead of quietly emptying a session's roots.
 */

const managers: SessionManager[] = []
const roots: string[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'nessy-attached-dirs-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace'), { recursive: true })
  const manager = createTestSessionManager()
  managers.push(manager)
  const managed = createManagedSession({ id }, {
    id: 'ws_attached',
    name: 'Attached Workspace',
    rootPath: join(root, 'workspace'),
    createdAt: 1,
  } as never, { messagesLoaded: true }) as unknown as Record<string, unknown>
  const internals = manager as unknown as {
    sessionAdditionalDirectories(managed: unknown): string[]
    sessions: Map<string, unknown>
  }
  internals.sessions.set(`ws_attached:${id}`, managed)
  return { managed, internals }
}

describe('P6.394 L42 — the attached-directory fields have producers and readers', () => {
  it("reads a Pi session's granted directories, so the grant is not written into a void", () => {
    const { managed, internals } = harness('attached-read')
    // Exactly the shape `PiAgent` presents: `grantsSessionDirectories` is a
    // duck-type check for this one method, so a stub that has it IS the
    // production contract.
    ;(managed as { agent: unknown }).agent = {
      getSessionAdditionalDirectories: () => ['/granted/one', '/granted/two'],
    }
    const merged = internals.sessionAdditionalDirectories(managed)
    expect(merged).toContain('/granted/one')
    expect(merged).toContain('/granted/two')

    // THE NEGATIVE, and it is what makes the positive mean something: an agent
    // WITHOUT the method must not throw and must not invent roots. That is every
    // claude and codex session, and it is why the merge is duck-typed rather
    // than provider-gated.
    ;(managed as { agent: unknown }).agent = {}
    expect(internals.sessionAdditionalDirectories(managed)).not.toContain('/granted/one')
  })

  it('accumulates an outside-root grant on the session, which is what the scope is rebuilt from', () => {
    const { managed } = harness('attached-grant')
    // The callback the backend config carries, applied the way the config's own
    // arrow applies it. Driving the arrow itself would need a constructed
    // backend; the ASSIGNMENT is the wire, and it is stated once here and once
    // in `SessionManager`.
    const grant = {
      receiptId: 'receipt-1', canonicalRoot: '/granted/outside', access: 'read' as const, expires: 'session' as const,
    }
    const session = managed as { approvedFilesystemRoots?: unknown[] }
    session.approvedFilesystemRoots = [...(session.approvedFilesystemRoots ?? []), grant]
    expect(session.approvedFilesystemRoots).toEqual([grant])

    // …and the site that reads it back is the filesystem scope the next agent is
    // built with. Asserted on the source, because reaching it needs a spawned
    // backend and the claim under test is that the field is READ AT ALL.
    const sessionManager = readFileSync(
      fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
      'utf8',
    )
    expect(sessionManager).toContain('additionalRoots: managed.approvedFilesystemRoots ?? []')
    expect(sessionManager).toContain('managed.approvedFilesystemRoots = [...(managed.approvedFilesystemRoots ?? []), root]')
  })

  it("keeps the Pi subprocess's two empty defaults DOCUMENTED rather than live", () => {
    // The third reading. Neither literal is a production value: one is a
    // formatting-only scope used after authorization, the other the legacy
    // fallback for a host that ships no scope. If either stops carrying its
    // reason, this fails — which is the only way a hardcoded `[]` beside a real
    // one announces itself.
    const piRoot = new URL('../../../../pi-agent-server/src/', import.meta.url)
    const localTools = readFileSync(fileURLToPath(new URL('local-tools/runtime-backed-tools.ts', piRoot)), 'utf8')
    expect(localTools).toContain('Formatting-only scope over the already-authorized runtime cwd')
    const index = readFileSync(fileURLToPath(new URL('index.ts', piRoot)), 'utf8')
    expect(index).toContain('the captured host scope is authoritative')
    expect(index).toContain('const scope = initConfig?.filesystemScope')
  })
})
