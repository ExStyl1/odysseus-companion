/**
 * The workflow keyword trigger through the HOST's production send path.
 *
 * The pure decision is unit-tested in shared; what this file pins is the wiring
 * that decision actually rides: `SessionManager.sendMessage` composes the model
 * message, and the origin it consults is the one the composer stamps. The
 * boundary matters because `workflows.md` §Where the keyword works forbids the
 * keyword from firing on a relayed prompt, and this repo's deep-link route
 * calls the very same RPC without stamping an origin.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { WORKFLOW_TRIGGER_KEYWORD } from '@nessy-agent/shared/workflows/workflow-keyword'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Drives the mid-stream branch of `sendMessage`, which hands the composed model
 * message straight to `agent.redirect`. That is the shallowest point where the
 * host's own composition is observable without standing up a model backend.
 */
function fixture(managedPiPolicy?: ManagedPiPolicyV1) {
  const root = mkdtempSync(join(tmpdir(), 'nessy-workflow-keyword-'))
  roots.push(root)
  const manager = createTestSessionManager({
    projectHandleService: new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
    }),
    ...(managedPiPolicy ? { managedPiPolicy } : {}),
  })
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: join(root, 'workspace'),
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  const redirected: string[] = []
  managed.isProcessing = true
  managed.agent = { redirect: (text: string) => { redirected.push(text); return true } } as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    'workspace-a:session-a',
    managed,
  )
  const send = (message: string, origin?: 'human') => manager.sendMessage(
    'session-a',
    message,
    undefined,
    undefined,
    origin ? { origin } : undefined,
    undefined,
    undefined,
    undefined,
    { workspaceId: 'workspace-a' },
  )
  return { manager, redirected, send }
}

describe('workflow keyword trigger through SessionManager.sendMessage', () => {
  it('appends the orchestration directive for a human-stamped prompt only', async () => {
    const { manager, redirected, send } = fixture()
    try {
      await send(`${WORKFLOW_TRIGGER_KEYWORD}: audit every route handler`, 'human')
      expect(redirected).toHaveLength(1)
      expect(redirected[0]).toContain('audit every route handler')
      expect(redirected[0]).toContain('workflow orchestration')

      // Same text, no origin stamp: a deep link, a webhook relay, or any other
      // caller that did not come from the composer.
      await send(`${WORKFLOW_TRIGGER_KEYWORD}: audit every route handler`)
      expect(redirected).toHaveLength(2)
      expect(redirected[1]).not.toContain('workflow orchestration')
    } finally {
      manager.cleanup()
    }
  })

  it('does not fire when managed policy disables workflows', async () => {
    const { manager, redirected, send } = fixture({
      schemaVersion: 1,
      disabledPermissionModes: [],
      workflow: { disableWorkflows: true },
    })
    try {
      await send(`${WORKFLOW_TRIGGER_KEYWORD}: audit every route handler`, 'human')
      expect(redirected).toHaveLength(1)
      expect(redirected[0]).not.toContain('workflow orchestration')
    } finally {
      manager.cleanup()
    }
  })

  /**
   * P2.315 / F46.1 — the runtime gate, through the same production send path.
   *
   * The directive tells the model to "run it with the workflow tool", and that
   * tool exists only on the Pi harness, so on a claude-runtime or codex-runtime
   * session it named a tool the session does not have. Nothing errored; the
   * marker just reached the model as prose (P2.212's defect one route up).
   *
   * `resolveManagedProvider` is substituted rather than driven, deliberately and
   * narrowly: it resolves through the stored `llmConnections`, which
   * `scheduled-delivery-runtimes.test.ts` already pins card-by-card, and the
   * case ABOVE runs this same path with the REAL resolution (it returns `'pi'`
   * and the directive is appended), so the collaborator being doubled here is
   * exercised for real in the same file.
   */
  it('does not fire on a runtime that cannot dispatch a workflow', async () => {
    for (const provider of ['anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      const { manager, redirected, send } = fixture()
      try {
        ;(manager as unknown as { resolveManagedProvider: () => string }).resolveManagedProvider = () => provider
        await send(`${WORKFLOW_TRIGGER_KEYWORD}: audit every route handler`, 'human')
        expect(redirected).toHaveLength(1)
        expect(redirected[0], `${provider} still received the orchestration directive`)
          .not.toContain('workflow orchestration')
        // The prompt itself must survive untouched — the gate withholds the
        // directive, it does not swallow the user's words.
        expect(redirected[0]).toContain('audit every route handler')
      } finally {
        manager.cleanup()
      }
    }
  })

  it('does not fire when only the keyword toggle is off', async () => {
    const { manager, redirected, send } = fixture({
      schemaVersion: 1,
      disabledPermissionModes: [],
      workflow: { keywordTriggerEnabled: false },
    })
    try {
      await send(`${WORKFLOW_TRIGGER_KEYWORD}: audit every route handler`, 'human')
      expect(redirected).toHaveLength(1)
      expect(redirected[0]).not.toContain('workflow orchestration')
    } finally {
      manager.cleanup()
    }
  })
})
