import { afterEach, describe, expect, it } from 'bun:test'
import { describeWorkflowLaunchConsent } from '@nessy-agent/shared/workflows/workflow-launch-consent'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * Production seam of the pass-8 live BLOCKER: the Pi permission service's
 * `requestApproval` registers its resolver in `directPermissionResolvers` and
 * surfaces the prompt through `handleAgentPermissionRequest`; the user's answer
 * arrives through `respondToPermission`. The live hang was an approval that
 * NEVER settled that resolver: the workflow-launch prompt was typed
 * `admin_approval`, the privileged broker's policy rejected the workflow name,
 * and the fail-closed branch answered through `managed.agent` — a resolver the
 * service never registered with.
 */

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
})

function fixture() {
  const manager = createTestSessionManager()
  managers.push(manager)
  const agentResponses: unknown[][] = []
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: '/tmp/nessy-workflow-approval-workspace',
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  managed.agent = {
    respondToPermission: (...args: unknown[]) => { agentResponses.push(args) },
  } as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    'workspace-a:session-a',
    managed,
  )
  return { manager: manager as unknown as {
    requestPiToolApproval(managed: unknown, request: Record<string, unknown>): Promise<{ allowed: boolean }>
    respondToPermission: SessionManager['respondToPermission']
    workflowLaunchConsent: { remember(projectKey: string, name: string): void }
    pendingPermissionRequests: Map<string, { workflowLaunch?: { name: string; projectKey: string } }>
  }, managed, agentResponses }
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: approval never settled (the live hang)`)), 1_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('SessionManager workflow launch approval settlement', () => {
  it('settles an approved workflow_launch prompt as allowed without the privileged broker', async () => {
    const { manager, managed, agentResponses } = fixture()

    const approval = manager.requestPiToolApproval(managed, {
      decisionId: 'decision-workflow-1',
      toolName: 'workflow',
      type: 'workflow_launch',
      description: describeWorkflowLaunchConsent({ name: 'pass8-demo', phases: ['Audit the release'] }),
      command: 'pass8-demo',
    })

    // The pending request carries the two-axis consent scope for the remember.
    expect(manager.pendingPermissionRequests.get('decision-workflow-1')?.workflowLaunch)
      .toMatchObject({ name: 'pass8-demo' })

    expect(manager.respondToPermission('session-a', 'decision-workflow-1', true, false, undefined, 'workspace-a')).toBe(true)
    await expect(bounded(approval, 'workflow_launch approve')).resolves.toMatchObject({ allowed: true })
    // The service's resolver settles the decision; nothing may detour through
    // the agent's own pending-permission table (it has no such request).
    expect(agentResponses).toEqual([])
  })

  it('records the durable per-workflow-per-project remember on an Always approval', async () => {
    const { manager, managed } = fixture()
    const remembered: Array<[string, string]> = []
    manager.workflowLaunchConsent.remember = (projectKey: string, name: string) => {
      remembered.push([projectKey, name])
    }

    const approval = manager.requestPiToolApproval(managed, {
      decisionId: 'decision-workflow-2',
      toolName: 'workflow',
      type: 'workflow_launch',
      description: describeWorkflowLaunchConsent({ name: 'pass8-demo', phases: [] }),
      command: 'pass8-demo',
    })

    expect(manager.respondToPermission('session-a', 'decision-workflow-2', true, true, undefined, 'workspace-a')).toBe(true)
    await expect(bounded(approval, 'workflow_launch always')).resolves.toMatchObject({ allowed: true })
    expect(remembered).toEqual([['/tmp/nessy-workflow-approval-workspace', 'pass8-demo']])
  })

  it('settles a broker-rejected admin approval as denied instead of hanging', async () => {
    const { manager, managed } = fixture()

    const approval = manager.requestPiToolApproval(managed, {
      decisionId: 'decision-admin-1',
      toolName: 'Bash',
      type: 'admin_approval',
      description: 'Run a privileged command.',
      command: 'rm -rf /tmp/not-allowlisted',
    })

    // The privileged policy only allows brew-cask/installer commands, so the
    // broker rejects this approval. Fail closed means a SETTLED denial.
    manager.respondToPermission('session-a', 'decision-admin-1', true, false, undefined, 'workspace-a')
    await expect(bounded(approval, 'admin_approval broker reject')).resolves.toMatchObject({ allowed: false })
  })
})
