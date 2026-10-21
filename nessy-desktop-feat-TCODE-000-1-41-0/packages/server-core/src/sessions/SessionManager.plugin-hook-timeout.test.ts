/**
 * F1.209 (origin WJ-o P-WJ-o-2) — the host's plugin http hook runner waits as
 * long as the hook's `timeout` says, not a flat 30 s.
 *
 * hooks.md#common-fields, `timeout`: *"Seconds before canceling. Defaults: 600
 * for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`"*. The
 * shared half (`plugins/__tests__/plugin-hook-action-timeout.test.ts`) pins that
 * the resolved budget reaches the runner request; this file pins that the REAL
 * `SessionManager.pluginHttpHookRunner` honours it against a real loopback
 * server, in both directions:
 *
 * - the brief's control, literally: a hook declaring `timeout: 120` against a
 *   policy server answering at 45 s gets the server's answer (before the fix it
 *   was cut at 30 s and came back `http-hook-timeout`);
 * - and the tightening direction, which a runner that simply stopped timing out
 *   would fail: a hook declaring 1 s against a server answering at 3 s times out.
 *
 * Loopback only; a hook probe never points at a real host.
 */
import { describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

/** The server answers the policy verdict after `delayMs`. */
async function slowPolicyServer(delayMs: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ decision: 'block', reason: 'held by policy' }))
    }, delayMs)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local test server address unavailable')
  return { server, url: `http://127.0.0.1:${address.port}/policy` }
}

function httpRunner() {
  // The same real-instance harness `SessionManager.plugin-hook-runners.test.ts` uses.
  const manager = createTestSessionManager() as any
  const receipts: Array<Record<string, unknown>> = []
  manager.appendPiExecutionReceipt = (_managed: unknown, receipt: Record<string, unknown>) => {
    receipts.push(receipt)
    return receipt
  }
  manager.piGoalReceiptReference = () => undefined
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  manager.isPluginHookEffectAllowed = async () => true
  const runner = manager.pluginHttpHookRunner({
    id: 'session-f1209',
    workspace: { id: 'workspace-f1209', rootPath: process.cwd() },
  }, {
    projectTrustState: 'trusted',
    view: { generation: 'f1209', hooks: [], permissionLayers: [] },
    materializer: { assertActive() {}, async verifyPlugin() {} },
  })
  return { runner, receipts }
}

describe('F1.209 — the host http hook runner honours the declared timeout', () => {
  test('a hook declaring timeout: 120 gets the answer of a server that takes 45 s', async () => {
    const { server, url } = await slowPolicyServer(45_000)
    const { runner, receipts } = httpRunner()
    try {
      const verdict = await runner({ event: 'PreToolUse', http: { url }, timeoutMs: 120_000 })
      expect(verdict?.failed).toBeUndefined()
      expect(JSON.parse(String(verdict?.body))).toEqual({ decision: 'block', reason: 'held by policy' })
      expect(receipts.at(-1)).toMatchObject({ outcome: 'success', isolationProfile: 'host-webhook' })
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 90_000)

  /** CONTROL — the declared value is a bound, not a removal: 1 s against a 3 s server times out. */
  test('a hook declaring timeout: 1 times out against a server that takes 3 s', async () => {
    const { server, url } = await slowPolicyServer(3_000)
    const { runner, receipts } = httpRunner()
    try {
      const verdict = await runner({ event: 'PreToolUse', http: { url }, timeoutMs: 1_000 })
      expect(verdict).toEqual({ failed: true, code: 'http-hook-timeout' })
      expect(receipts.at(-1)).toMatchObject({ outcome: 'timed-out', code: 'timeout' })
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 30_000)
})
