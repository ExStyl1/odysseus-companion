/**
 * P3.30: `worktree.setupScript` has a SUPPLIER.
 *
 * 721b7374e built the whole mechanism behind `WorktreeSetupPort` — the key
 * parses, resolves, composes, and the lease service orchestrates it — and then
 * nothing supplied the port, so no setup script ran for anybody. These tests
 * drive the REAL `WorktreeLeaseService` through the REAL host port
 * (`SessionManager.createWorktreeSetupPort`) and the REAL approval chain
 * (`requestPiToolApproval` -> `handleAgentPermissionRequest` ->
 * `respondToPermission`), because the two ways this wire can be wrong both
 * produce green unit tests and a broken user:
 *
 *  1. **The card describes the wrong thing.** `workflow_launch` is the shape
 *     the consent copies, but the STRING routes `ChatDisplay` to the workflow
 *     card — the user would be shown a workflow's name-and-phases consent for a
 *     shell command. The prompt type is asserted here, on the event the
 *     renderer actually receives.
 *  2. **The Always is silently dropped.** `requestPiToolApproval` resolves
 *     `{allowed, canonicalInput}` (plus a denial `comment`); the always-allow flag is
 *     consumed by `respondToPermission`. A wire that expected it back would
 *     record nothing, and the user who answered "don't ask again" would be
 *     asked again on every single creation while believing they had answered.
 *     So the SECOND creation is driven, and its silence is the assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import {
  createWorktreeSetupConsentStore,
  worktreeSetupConsentName,
  worktreeSetupConsentProjectKey,
} from '@nessy-agent/shared/sessions/worktree-setup-consent'
import { WorktreeLeaseService } from '../pi-harness/worktree-lease-service.ts'
import { WORKTREE_SETUP_TIMEOUT_MS } from '../pi-harness/worktree-setup-plan.ts'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type SessionManagerInstance = InstanceType<typeof SessionManager>

interface Rig {
  sm: SessionManagerInstance
  managed: { messages: { role: string; content: string }[] }
  events: SessionEvent[]
  started: Record<string, unknown>[]
  /** The transcript rows the HOST wrote, never a test-side copy of them. */
  notices(): string[]
  service: WorktreeLeaseService
  consentPath: string
  repoRoot: string
  namespaceRoot: string
}

let tmpRoot: string
let rigs: Rig[]

/**
 * A session, a host setup port built by the manager, and a lease service whose
 * git is a stub — everything real except the repository.
 */
function createRig(options: {
  script?: string
  exitCode?: number
  output?: string
  consentPath: string
}): Rig {
  const sm = createTestSessionManager()
  const events: SessionEvent[] = []
  sm.setEventSink(((...args: unknown[]) => {
    events.push(args[2] as SessionEvent)
  }) as Parameters<SessionManagerInstance['setEventSink']>[0])

  const started: Record<string, unknown>[] = []
  ;(sm as unknown as { piWorkspaceDrainParticipant: unknown }).piWorkspaceDrainParticipant = {
    processSupervisorPort: {
      start: async (request: Record<string, unknown>) => {
        started.push(request)
        return {
          handle: 'handle',
          output: options.output ?? '',
          nextCursor: 0,
          isRunning: false,
          exitCode: options.exitCode ?? 0,
          signal: null,
          isolationProfile: 'read-only',
          environmentProfile: 'restricted',
          environmentDigest: 'digest',
        }
      },
    },
  }
  // Hermetic record file for BOTH sides. The production spelling is pinned
  // separately, by `the writer's file is the file the reader opens`.
  ;(sm as unknown as { worktreeSetupConsent: unknown }).worktreeSetupConsent =
    createWorktreeSetupConsentStore({ path: options.consentPath })

  const workspace = {
    id: 'ws_worktree_setup',
    name: 'Worktree Setup Workspace',
    rootPath: tmpRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session_worktree_setup', name: 'worktree setup' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(managed as unknown as { agent: unknown }).agent = {
    respondToPermission: () => {},
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions
    .set(`${workspace.id}:${managed.id}`, managed)

  const repoRoot = join(tmpRoot, 'repo')
  const namespaceRoot = join(tmpRoot, '.nessy-worktrees', 'repo')
  const port = (sm as unknown as {
    createWorktreeSetupPort(
      managed: unknown,
      ports: {
        worktreeSettings: () => { setupScript?: string }
        worktreeAuthority: () => Promise<{ root: string; namespaceRoot: string; containmentRoot: string }>
      },
    ): Record<string, unknown>
  }).createWorktreeSetupPort(managed, {
    worktreeSettings: () => (options.script === undefined ? {} : { setupScript: options.script }),
    worktreeAuthority: async () => ({ root: repoRoot, namespaceRoot, containmentRoot: tmpRoot }),
  })

  const service = new WorktreeLeaseService({
    workspaceId: workspace.id,
    persist: async () => {},
    policy: {
      select: async ({ worktreeLeaseId }) => ({
        path: join(namespaceRoot, worktreeLeaseId),
        branch: `nessy/agent/${worktreeLeaseId}`,
        baseSha: 'base-sha',
      }),
    },
    git: {
      create: async () => {},
      inspect: async () => ({ exists: true, dirty: false, branch: '', baseSha: 'base-sha' }),
      remove: async () => {},
    },
    repoRoot: () => repoRoot,
    setup: { ...port, consentStorePath: options.consentPath } as never,
  })

  const rig: Rig = {
    sm,
    managed: managed as unknown as Rig['managed'],
    events,
    started,
    notices: () => (managed as unknown as Rig['managed']).messages
      .filter(message => message.role === 'info')
      .map(message => message.content),
    service,
    consentPath: options.consentPath,
    repoRoot,
    namespaceRoot,
  }
  rigs.push(rig)
  return rig
}

function permissionRequests(events: SessionEvent[]): { requestId: string; type?: string; description: string; command?: string; toolName: string }[] {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'permission_request' }> => event.type === 'permission_request')
    .map(event => event.request as never)
}

/** Create one worktree, answering the card when it appears. */
async function createWorktree(rig: Rig, leaseId: string, answer?: { allowed: boolean; always: boolean }): Promise<void> {
  const seen = permissionRequests(rig.events).length
  const acquired = rig.service.acquire({ ownerAgentId: 'agent-1', worktreeLeaseId: leaseId })
  if (answer) {
    const deadline = Date.now() + 2_000
    while (permissionRequests(rig.events).length === seen) {
      if (Date.now() > deadline) throw new Error('the consent card never appeared')
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const request = permissionRequests(rig.events).at(-1)!
    rig.sm.respondToPermission('session_worktree_setup', request.requestId, answer.allowed, answer.always)
  }
  await acquired
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sm-worktree-setup-'))
  rigs = []
})

afterEach(() => {
  for (const rig of rigs) rig.sm.cleanup?.()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('worktree setup script — the host supplies the port (P3.30)', () => {
  it('runs the declared script after consent, on its own prompt type, and reports it', async () => {
    const script = 'echo installing'
    const rig = createRig({ script, output: 'installing\n', consentPath: join(tmpRoot, 'consent.json') })

    await createWorktree(rig, 'lease-1', { allowed: true, always: false })

    // (1) The card. Its own type — NOT `workflow_launch`, which the renderer
    // routes to the workflow card, where the text the user reads would describe
    // a workflow launch instead of the shell command about to run.
    const [request] = permissionRequests(rig.events)
    expect(request!.type).toBe('worktree_setup')
    expect(request!.type).not.toBe('workflow_launch')
    expect(request!.toolName).toBe('WorktreeSetup')
    // …and it names the real thing: this script, this worktree, this setting.
    expect(request!.command).toBe(script)
    expect(request!.description).toContain(script)
    expect(request!.description).toContain(join(rig.namespaceRoot, 'lease-1'))
    expect(request!.description).toContain('worktree.setupScript')

    // (2) The process. Host-selected interpreter, script as one argv element,
    // cwd = the NEW worktree, and the same write grant worktree git runs under.
    expect(rig.started).toHaveLength(1)
    const started = rig.started[0]!
    expect(started.command).toBe(process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh')
    expect(started.args).toEqual(process.platform === 'win32' ? ['/d', '/s', '/c', script] : ['-c', script])
    expect(started.cwd).toBe(join(rig.namespaceRoot, 'lease-1'))
    expect(started.workspaceRoot).toBe(tmpRoot)
    expect(started.profile).toBe('read-only')
    expect(started.timeoutMs).toBe(WORKTREE_SETUP_TIMEOUT_MS)
    expect(started.additionalWritableRoots).toEqual([rig.repoRoot, rig.namespaceRoot])

    // (3) The transcript. The session is told what happened, in a row of its own.
    expect(rig.notices()).toHaveLength(1)
    expect(rig.notices()[0]!.split('\n')[0]).toContain('exit 0')
    expect(rig.notices()[0]).toContain(`$ ${script}`)
    expect(rig.notices()[0]).toContain(join(rig.namespaceRoot, 'lease-1'))
    // …and the renderer is told, on the same content.
    expect(rig.events.filter(event => event.type === 'info'))
      .toEqual([expect.objectContaining({ message: rig.notices()[0] })] as never)
  })

  it('an Always answer is REMEMBERED: the second creation runs the script without a card', async () => {
    const script = 'echo installing'
    const consentPath = join(tmpRoot, 'consent.json')
    const rig = createRig({ script, consentPath })

    await createWorktree(rig, 'lease-1', { allowed: true, always: true })
    expect(permissionRequests(rig.events)).toHaveLength(1)

    // The record the host wrote, under the two axes the reader computes.
    const recorded = JSON.parse(readFileSync(consentPath, 'utf8')) as { projects: Record<string, string[]> }
    expect(recorded.projects[worktreeSetupConsentProjectKey(rig.repoRoot)])
      .toEqual([worktreeSetupConsentName(script)])

    // The second creation: no card, and the script still runs.
    await createWorktree(rig, 'lease-2')
    expect(permissionRequests(rig.events)).toHaveLength(1)
    expect(rig.started).toHaveLength(2)
    expect(rig.started[1]!.cwd).toBe(join(rig.namespaceRoot, 'lease-2'))
  })

  it('a plain yes is NOT remembered: the second creation asks again', async () => {
    const consentPath = join(tmpRoot, 'consent.json')
    const rig = createRig({ script: 'echo installing', consentPath })

    await createWorktree(rig, 'lease-1', { allowed: true, always: false })
    await createWorktree(rig, 'lease-2', { allowed: true, always: false })

    expect(permissionRequests(rig.events)).toHaveLength(2)
    expect(rig.started).toHaveLength(2)
    // Nothing durable was written by a consent the user gave for one run.
    expect(() => readFileSync(consentPath, 'utf8')).toThrow()
  })

  it('the writer\'s file is the file the reader opens', () => {
    // The port's docblock: a host that remembers on its own Always MUST write
    // through `createWorktreeSetupConsentStore()`, or the approval lands in a
    // file the lease service never reads and silently never takes effect. The
    // manager's store is built by that factory, so this pins the one spelling.
    const sm = createTestSessionManager()
    const writer = (sm as unknown as { worktreeSetupConsent: { path: string } }).worktreeSetupConsent
    const reader = createWorktreeSetupConsentStore() as unknown as { path: string }
    expect(writer.path).toBe(reader.path)
    sm.cleanup?.()
  })

  it('the lease service the host BUILDS is given the port', async () => {
    // The P3.6/P3.30 boundary itself. Every other test here drives a port this
    // manager produced; this one asserts the production factory actually hands
    // it to the service. Without the wire the mechanism is complete, tested and
    // unreachable — which is precisely the state 721b7374e shipped.
    const sm = createTestSessionManager()
    const started: Record<string, unknown>[] = []
    ;(sm as unknown as { piWorkspaceDrainParticipant: unknown }).piWorkspaceDrainParticipant = {
      processSupervisorPort: {
        start: async (request: Record<string, unknown>) => {
          started.push(request)
          return {
            handle: 'handle', output: '', nextCursor: 0, isRunning: false, exitCode: 0,
            signal: null, isolationProfile: 'read-only', environmentProfile: 'restricted',
            environmentDigest: 'digest',
          }
        },
      },
    }
    const repoRoot = join(tmpRoot, 'repo')
    mkdirSync(repoRoot, { recursive: true })
    ;(sm as unknown as { projectHandleService: unknown }).projectHandleService = {
      resolveHandle: async () => ({ canonicalPath: repoRoot }),
    }
    const managed = createManagedSession(
      { id: 'session_supply' },
      { id: 'ws_supply', name: 'Supply', rootPath: tmpRoot, createdAt: Date.now() } as never,
      { messagesLoaded: true, ephemeral: true },
    )

    const service = (sm as unknown as {
      createPiWorktreeLeaseService(managed: unknown, emit: unknown): WorktreeLeaseService
    }).createPiWorktreeLeaseService(managed, async () => {})

    const setup = (service as unknown as { options: { setup?: Record<string, Function> } }).options.setup
    expect(setup).toBeDefined()
    // …and it is THIS manager's port: the process goes through its supervisor.
    await setup!.run!({
      operation: 'setup-script',
      cwd: join(tmpRoot, 'worktree'),
      program: '/bin/sh',
      args: ['-c', 'true'],
      timeoutMs: 1_000,
    })
    expect(started).toHaveLength(1)
    expect(started[0]!.cwd).toBe(join(tmpRoot, 'worktree'))
    expect(started[0]!.semanticId).toBe('worktree')
    sm.cleanup?.()
  })

  it('no declared script means no card, no process and no transcript row', async () => {
    const rig = createRig({ consentPath: join(tmpRoot, 'consent.json') })

    await createWorktree(rig, 'lease-1')

    expect(permissionRequests(rig.events)).toEqual([])
    expect(rig.started).toEqual([])
    expect(rig.notices()).toEqual([])
  })

  it('a script that exits non-zero is reported and the worktree is still usable', async () => {
    const rig = createRig({ script: './setup.sh', exitCode: 99, output: 'boom', consentPath: join(tmpRoot, 'consent.json') })

    await createWorktree(rig, 'lease-1', { allowed: true, always: false })

    const [lease] = rig.service.list()
    expect(lease!.status).toBe('active')
    // The STATUS line, not the echoed script: an assertion that reads the whole
    // block passes on a script whose own text spells the status.
    expect(rig.notices()[0]!.split('\n')[0]).toContain('exit 99')
    expect(rig.notices()[0]).toContain('boom')
  })
})
