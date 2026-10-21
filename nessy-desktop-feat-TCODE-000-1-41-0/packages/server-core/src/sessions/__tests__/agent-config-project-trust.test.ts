import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * CDP pass 9 live blocker: a session whose cwd was already set when the agent
 * spawned never runs a cwd-change transaction — the ONLY path that carried
 * `projectTrusted` to the backend. The agent config therefore stayed untrusted:
 * the Pi subprocess init skipped the project workflow recipes ("Unknown
 * workflow recipe: pass8-demo") and the launch-consent gate lost the declared
 * phases. Host-resolved trust must reach the backend config at CREATION.
 */

setSessionPlatform(createHeadlessPlatform())

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(trusted: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'nessy-agent-trust-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(join(projectRoot, '.nessy-agent', 'workflows'), { recursive: true })
  writeFileSync(join(projectRoot, '.nessy-agent', 'workflows', 'pass8-demo.js'), [
    "export const meta = { name: 'pass8-demo', description: 'Pass 8 demo', phases: [{ title: 'Greet', detail: 'zero-agent check' }] }",
    "return 'greeted';",
  ].join('\n'))

  const handles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
    managedRootPaths: [workspaceRoot],
    newId: () => 'project-handle',
  })
  const manager = createTestSessionManager({ projectHandleService: handles })
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
    // cwd preset at session creation — no cwd-change transaction will ever run.
    workingDirectory: projectRoot,
  })
  managed.activeProvider = 'pi'
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    'workspace-a:session-a',
    managed,
  )
  if (trusted) {
    const handle = await handles.validateProjectDirectory('workspace-a', projectRoot)
    await handles.setProjectTrust({ workspaceId: 'workspace-a', projectHandleId: handle.id }, 'trusted')
  }
  return { manager, managed }
}

async function capturedBackendConfig(trusted: boolean): Promise<Record<string, unknown>> {
  const { manager, managed } = await fixture(trusted)
  const internals = manager as unknown as {
    createCapabilityTurn(managed: unknown): Promise<{ snapshot: { leaseId: string }; runtime: { projectTrustState?: string } }>
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    createBackendFromManagedContext(args: { coreConfig: Record<string, unknown> }): unknown
    cleanup(): void
  }
  try {
    const turn = await internals.createCapabilityTurn(managed)
    expect(turn.runtime.projectTrustState).toBe(trusted ? 'trusted' : 'none')

    // Capture the exact config SessionManager hands the backend factory. Every
    // step before this boundary (trust resolution, capability turn, config
    // assembly) is production code; the factory tail (credentials, subprocess
    // env) is irrelevant to the contract under test.
    let captured: Record<string, unknown> | undefined
    internals.createBackendFromManagedContext = args => {
      captured = args.coreConfig
      throw new Error('captured-before-construction')
    }
    await expect(internals.getOrCreateAgent(managed, turn.runtime)).rejects.toThrow('captured-before-construction')
    expect(captured).toBeTruthy()
    return captured!
  } finally {
    internals.cleanup()
  }
}

describe('SessionManager backend config project trust', () => {
  it('carries host-resolved trust into the backend config for a preset-cwd session', async () => {
    const coreConfig = await capturedBackendConfig(true)
    expect(coreConfig.projectTrusted).toBe(true)
  })

  it('stays fail-closed while the project is not trusted', async () => {
    const coreConfig = await capturedBackendConfig(false)
    expect(coreConfig.projectTrusted).toBe(false)
  })
})
