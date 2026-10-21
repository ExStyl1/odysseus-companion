/**
 * P3: trusted project `.nessy-agent/config.toml` [defaults] compose into NEW
 * sessions at explicit session > project > workspace > global precedence, and
 * a project permission mode can never weaken the workspace/global floor.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { resolveProjectIdentity } from '@nessy-agent/shared/projects/project-identity'
import { createSessionStore } from '@nessy-agent/shared/sessions'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import { createTestSessionManager } from './test-session-manager'

const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-project-defaults-'))

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true })
})

async function makeProject(
  name: string,
  configToml: string | undefined,
  trusted: boolean,
  managerOptions: Parameters<typeof createTestSessionManager>[0] = {},
) {
  const projectPath = join(stateRoot, name)
  mkdirSync(projectPath, { recursive: true })
  if (configToml !== undefined) {
    mkdirSync(join(projectPath, '.nessy-agent'), { recursive: true })
    writeFileSync(join(projectPath, '.nessy-agent', 'config.toml'), configToml)
  }
  const trustStore = new ProjectTrustStore({ path: join(projectPath, `${name}-trust.json`) })
  if (trusted) {
    trustStore.record(await resolveProjectIdentity(projectPath), 'trusted')
  }
  const handles = new ProjectHandleService({ trustStore })
  const manager = createTestSessionManager({ projectHandleService: handles, ...managerOptions })
  return { projectPath, manager, handles }
}

/** A managed floor for the mode-ranking cases; disables nothing else. */
function managedFloor(defaultMode: 'acceptEdits' | 'auto') {
  return {
    managedPiPolicy: {
      schemaVersion: 1 as const,
      disabledPermissionModes: [],
      defaultMode,
    },
  }
}

const WS = 'ws-defaults'

/**
 * A workspace service whose ROOT PATH is one this test owns, so
 * `loadWorkspaceConfig` reads a `config.json` written here. The default factory
 * points at a temp dir it never exposes, which is why the workspace tier had no
 * pin (P6.363).
 */
function singleWorkspaceService(workspaceId: string, rootPath: string): WorkspaceService {
  const workspace = {
    id: workspaceId,
    workspaceRootPath: rootPath,
    sessionRootPath: join(rootPath, 'sessions'),
    config: { id: workspaceId, name: workspaceId, createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  }
  return {
    resolve: () => workspace,
    listResolved: () => [workspace],
  } as unknown as WorkspaceService
}

describe('project default composition (P3 contract corpus)', () => {
  it('applies trusted project defaults below an explicit session value', async () => {
    const { projectPath, manager, handles } = await makeProject('trusted-project', `
[defaults]
model = "project-model"
thinking_level = "high"
permission_mode = "safe"
`, true)
    const issued = await handles.validateProjectDirectory(WS, projectPath)

    const session = await manager.createSession(WS, { projectHandleId: issued.id })
    // Project narrows mode from the 'ask' floor and supplies model/thinking.
    expect(session.permissionMode).toBe('plan')
    expect(session.thinkingLevel).toBe('high')
    expect(session.model).toBe('project-model')

    // An explicit session value always wins over the project default.
    const explicit = await manager.createSession(WS, {
      projectHandleId: issued.id,
      permissionMode: 'acceptEdits',
      thinkingLevel: 'low',
      model: 'session-model',
    })
    expect(explicit.permissionMode).toBe('acceptEdits')
    expect(explicit.thinkingLevel).toBe('low')
    expect(explicit.model).toBe('session-model')
    manager.cleanup()
  })

  it('ignores a project permission mode that would weaken the floor', async () => {
    const { projectPath, manager, handles } = await makeProject('weakening-project', `
[defaults]
permission_mode = "allow-all"
`, true)
    const issued = await handles.validateProjectDirectory(WS, projectPath)

    const session = await manager.createSession(WS, { projectHandleId: issued.id })
    expect(session.permissionMode).not.toBe('allow-all')
    manager.cleanup()
  })

  it('drops a project request for auto over an acceptEdits floor (the inverted-table widening)', async () => {
    const { projectPath, manager, handles } = await makeProject('widening-auto-project', `
[defaults]
permission_mode = "auto"
`, true, managedFloor('acceptEdits'))
    const issued = await handles.validateProjectDirectory(WS, projectPath)

    const session = await manager.createSession(WS, { projectHandleId: issued.id })
    // `auto` sits ABOVE `acceptEdits` in PERMISSION_MODE_ORDER: its write
    // auto-approval is unbounded where acceptEdits is root-bounded, so a
    // trusted project must not reach it over an acceptEdits floor.
    expect(session.permissionMode).toBe('acceptEdits')
    manager.cleanup()
  })

  it('applies a legitimate acceptEdits narrowing over an auto floor (refused by the inverted table)', async () => {
    const { projectPath, manager, handles } = await makeProject('narrowing-acceptedits-project', `
[defaults]
permission_mode = "acceptEdits"
`, true, managedFloor('auto'))
    const issued = await handles.validateProjectDirectory(WS, projectPath)

    const session = await manager.createSession(WS, { projectHandleId: issued.id })
    expect(session.permissionMode).toBe('acceptEdits')
    manager.cleanup()
  })

  /**
   * P6.363 — MEASURED, and it REFUTES the row's premise.
   *
   * The row reads "no runtime honours a configured default model for new
   * sessions". At HEAD the host already does, for all three, and it does it
   * ABOVE the runtime: `SessionManager.createSession` resolves
   * `options?.model || projectDefaults?.model ?? wsConfig?.defaults?.model`
   * BEFORE `resolveBackendContext` picks a backend, so the tier cannot be
   * runtime-specific — the connection's own `defaultModel` is the tail below it.
   * Building a fourth tier for this would be the invented-answer shape.
   *
   * What was genuinely missing is the PIN. The two rows above cover the explicit
   * and project tiers; these cover the WORKSPACE tier and the survival
   * direction, which is the half `done_means` asks for ("a persisted /model pick
   * still wins and survives a restart").
   *
   * The env half of the row WAS a measured NULL, recorded rather than built:
   * `ANTHROPIC_DEFAULT_MODEL` appeared in 0 tracked source files and 0 times in
   * the vendored `2.1.233` native binary (control `ANTHROPIC_MODEL` 25, negative
   * control 0).
   Re-measured 2026-09-12 (C3.266, W17-b): the name now matches **3** tracked
   files — this suite, `claude-default-model-env.test.ts` and one comment in
   `SessionManager.ts`. All three are prose ABOUT the null and none of them is a
   reader, so the claim this paragraph makes is unchanged; only its number was.
   *
   * P7.1 · re-measured at the vendored `2.1.247`, the binary half is 13 against
   * `ANTHROPIC_MODEL` 22 and a nonsense control 0 — the null closed, and the
   * verdict did not: the model is resolved above `resolveBackendContext` for all
   * three runtimes and passed explicitly on every claude spawn, so the child's
   * own default is outranked before it is consulted. The reasoning is at the
   * reader (`SessionManager.ts`, this row's own tier list).
   */
  it('honours a WORKSPACE default model for a new session, and an explicit pick still wins (P6.363)', async () => {
    const workspaceRoot = join(stateRoot, 'ws-default-model')
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'config.json'),
      JSON.stringify({
        id: 'ws-default-model',
        name: 'ws-default-model',
        createdAt: 1,
        updatedAt: 1,
        defaults: { model: 'workspace-model' },
      }),
      'utf-8',
    )
    const manager = createTestSessionManager({
      workspaceService: singleWorkspaceService('ws-default-model', workspaceRoot),
    })

    const session = await manager.createSession('ws-default-model', {})
    expect(session.model).toBe('workspace-model')

    // The tier below the workspace one is the connection's own `defaultModel`,
    // reached only when nothing above answered — so an explicit pick, which is
    // what a `/model` choice becomes, still wins.
    const explicit = await manager.createSession('ws-default-model', { model: 'session-model' })
    expect(explicit.model).toBe('session-model')
    manager.cleanup()
  })

  it('a persisted model pick survives a restart and outranks the workspace default (P6.363)', async () => {
    const workspaceRoot = join(stateRoot, 'ws-persisted-model')
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'config.json'),
      JSON.stringify({
        id: 'ws-persisted-model',
        name: 'ws-persisted-model',
        createdAt: 1,
        updatedAt: 1,
        defaults: { model: 'workspace-model' },
      }),
      'utf-8',
    )
    // ONE store across both managers — that is what makes the second manager a
    // restart rather than a different installation.
    const sessionStore = createSessionStore({
      storageLayoutVersion: 2 as const,
      verificationId: `test-${randomUUID()}`,
    })
    const workspaceService = singleWorkspaceService('ws-persisted-model', workspaceRoot)

    const first = createTestSessionManager({ sessionStore, workspaceService })
    const created = await first.createSession('ws-persisted-model', { model: 'picked-model' })
    await first.flushSession(created.id, 'ws-persisted-model')
    await first.cleanup()

    // `getSessions` is the hydration entry point a cold manager goes through —
    // `getSession` alone reads only what is already managed, so asserting on it
    // first would have measured the rig rather than the persistence.
    const second = createTestSessionManager({ sessionStore, workspaceService })
    second.reloadSessions()
    const listed = second.getSessions('ws-persisted-model')
    expect(listed.map(s => s.id)).toContain(created.id)
    const reloaded = await second.getSession(created.id, 'ws-persisted-model')
    expect(reloaded).not.toBeNull()
    expect(reloaded!.model).toBe('picked-model')
    await second.cleanup()
  })

  it('reads no defaults from an untrusted project', async () => {
    const { projectPath, manager, handles } = await makeProject('untrusted-project', `
[defaults]
model = "must-never-apply"
`, false)
    const issued = await handles.validateProjectDirectory(WS, projectPath)

    const session = await manager.createSession(WS, { projectHandleId: issued.id })
    expect(session.model).not.toBe('must-never-apply')
    manager.cleanup()
  })
})
