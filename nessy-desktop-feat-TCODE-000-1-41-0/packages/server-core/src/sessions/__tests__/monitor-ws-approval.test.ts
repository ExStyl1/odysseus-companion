/**
 * `tools-reference.md`: Monitor's WebSocket source "has its own approval
 * prompt", and the changelog records it as deliberately offering no
 * skip-future-prompts option.
 *
 * These assertions drive the SHIPPED wiring — the real `authorizeMonitor` the
 * real `SessionMonitorService` calls, and the real `respondToPermission` the RPC
 * layer calls — rather than a stub above it, because the failure mode is a
 * prompt that appears correct and grants more than it says.
 */
import { describe, expect, test } from 'bun:test'
import type { PermissionRequest } from '@nessy-agent/core/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'
import type { MonitorSocket, MonitorSocketHandlers, SessionMonitorService } from '../session-monitor-service.ts'

const sessionKey = { workspaceId: 'workspace-1', sessionId: 'session-1' }

interface Harness {
  manager: ReturnType<typeof createTestSessionManager>
  monitors: SessionMonitorService
  prompts: PermissionRequest[]
  openedUrls: string[]
  respond(allowed: boolean, alwaysAllow: boolean): boolean
}

function harness(): Harness {
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    sessionMonitors: SessionMonitorService
    sendEvent(event: unknown, workspaceId: string): void
    resolveNetworkAddressesFn: (host: string) => Promise<string[]>
  }
  // Pin DNS: the guard's resolve step is exercised on its own table-driven
  // suite, and these assertions are about approval, not name resolution.
  internals.resolveNetworkAddressesFn = async () => ['93.184.216.34']
  const prompts: PermissionRequest[] = []
  const openedUrls: string[] = []
  internals.sessions.set(encodeSessionKey(sessionKey), {
    id: sessionKey.sessionId,
    workspace: { id: sessionKey.workspaceId, rootPath: '/tmp/workspace-1' },
    isProcessing: false,
    messages: [],
    // `backgroundShellCommands` is a REQUIRED field of `ManagedSession`, set at
    // creation for every production session. A command watch reaches the process
    // supervisor, whose `notifyChanged` calls `SessionManager.onChanged`, which
    // fires `void reconcileEndedBackgroundShells(managed)` — a voided async call,
    // so a stub without the map produces an UNHANDLED rejection that bun charges
    // to whichever test is running. Omitting it is a defect in this stub, not in
    // the guard: the same omission was diagnosed and fixed in two other hand-built
    // parent stubs (register entry for `5287fd49`, commit `e9e691c2`), and the ten
    // sibling stubs in this directory all carry the field. The `as unknown` cast
    // on `internals` is why the compiler cannot say so.
    backgroundShellCommands: new Map<string, string>(),
  })
  const originalSendEvent = internals.sendEvent.bind(manager)
  internals.sendEvent = (event: unknown, workspaceId: string) => {
    const typed = event as { type?: string; request?: PermissionRequest }
    if (typed.type === 'permission_request' && typed.request) prompts.push(typed.request)
    else originalSendEvent(event, workspaceId)
  }
  const monitors = internals.sessionMonitors
  // The ws transport is the only injected seam; approval, registry and stop are
  // the production implementations.
  ;(monitors as unknown as { options: { openSocket?: unknown } }).options.openSocket = async (
    input: { url: string },
    _handlers: MonitorSocketHandlers,
  ): Promise<MonitorSocket> => {
    openedUrls.push(input.url)
    return { close: () => undefined }
  }
  return {
    manager,
    monitors,
    prompts,
    openedUrls,
    respond: (allowed, alwaysAllow) => manager.respondToPermission(
      sessionKey.sessionId,
      prompts.at(-1)!.requestId,
      allowed,
      alwaysAllow,
      undefined,
      sessionKey.workspaceId,
    ),
  }
}

const startWs = (h: Harness, url = 'wss://events.example.test/stream') => h.monitors.start({
  sessionKey,
  cwd: '/tmp/workspace-1',
  workspaceRoot: '/tmp/workspace-1',
  description: 'watch the event stream',
  timeoutMs: 300_000,
  persistent: false,
  ws: { url },
})

describe('the ws source raises its own approval', () => {
  test('the prompt names the URL and offers no remember option', async () => {
    const h = harness()
    const pending = startWs(h)
    await Bun.sleep(0)

    expect(h.prompts).toHaveLength(1)
    const prompt = h.prompts[0]!
    expect(prompt.toolName).toBe('Monitor')
    expect(prompt.command).toBe('wss://events.example.test/stream')
    expect(prompt.description).toContain('wss://events.example.test/stream')
    expect(prompt.noAlwaysAllow).toBe(true)
    expect(prompt.rememberForMinutes).toBeUndefined()
    // No socket is opened while the prompt is outstanding.
    expect(h.openedUrls).toEqual([])

    expect(h.respond(true, false)).toBe(true)
    await pending
    expect(h.openedUrls).toEqual(['wss://events.example.test/stream'])
    expect(h.monitors.list(sessionKey)).toHaveLength(1)
  })

  test('an alwaysAllow answer grants this call only — the next watch prompts again', async () => {
    const h = harness()
    const first = startWs(h)
    await Bun.sleep(0)
    h.respond(true, true)
    await first

    const second = startWs(h)
    await Bun.sleep(0)
    // P2.187. The label promises WHICH watch prompted again, and a count cannot
    // see it: two prompts for the wrong URL, or two sockets opened somewhere
    // else, both satisfy `toHaveLength(2)`. The sibling case two tests up
    // already spells the identity form — `toEqual(['wss://…/stream'])` — so this
    // is the file's own vocabulary, not a new convention.
    expect(h.prompts.map(prompt => prompt.command)).toEqual([
      'wss://events.example.test/stream',
      'wss://events.example.test/stream',
    ])
    h.respond(true, false)
    await second
    expect(h.openedUrls).toEqual([
      'wss://events.example.test/stream',
      'wss://events.example.test/stream',
    ])
  })

  test('a denied ws Monitor opens no socket and leaves no registry entry', async () => {
    const h = harness()
    const pending = startWs(h)
    await Bun.sleep(0)
    expect(h.respond(false, false)).toBe(true)

    await expect(pending).rejects.toThrow('was denied')
    expect(h.openedUrls).toEqual([])
    expect(h.monitors.list(sessionKey)).toEqual([])
  })
})

describe('the command source is not double-gated here (Pi)', () => {
  // T2 split this by runtime: a non-Pi command watch IS gated here, against the
  // same Bash rules, because nothing gated it earlier. This row stays a PI row —
  // the harness session above carries no connection, and `resolveManagedProvider`
  // answers `'pi'` for it — so what it pins is unchanged: on Pi the pre-tool gate
  // is the only gate. The non-Pi half lives in `monitor-command-gate.test.ts`.
  test('a command watch raises no approval of its own', async () => {
    const h = harness()
    const started = h.monitors.start({
      sessionKey,
      cwd: '/tmp/workspace-1',
      workspaceRoot: '/tmp/workspace-1',
      description: 'watch the log',
      timeoutMs: 300_000,
      persistent: false,
      command: 'true',
    }).catch(error => error as Error)
    await started
    expect(h.prompts).toEqual([])
  })
})

describe('the address guard runs before the prompt', () => {
  test('a loopback URL is refused with no prompt and no socket', async () => {
    const h = harness()
    await expect(h.monitors.start({
      sessionKey,
      cwd: '/tmp/workspace-1',
      workspaceRoot: '/tmp/workspace-1',
      description: 'watch localhost',
      timeoutMs: 300_000,
      persistent: false,
      ws: { url: 'ws://127.0.0.1:9000/stream' },
    })).rejects.toThrow('not permitted')
    expect(h.prompts).toEqual([])
    expect(h.openedUrls).toEqual([])
    expect(h.monitors.list(sessionKey)).toEqual([])
  })

  test('the cloud-metadata address is refused', async () => {
    const h = harness()
    await expect(startWs(h, 'ws://169.254.169.254/latest/meta-data')).rejects.toThrow('cloud-metadata')
    expect(h.prompts).toEqual([])
    expect(h.openedUrls).toEqual([])
  })

  test('a non-ws scheme is refused before anything else happens', async () => {
    const h = harness()
    await expect(startWs(h, 'https://example.test/stream')).rejects.toThrow('must use ws: or wss:')
    expect(h.prompts).toEqual([])
  })

  test('a managed deniedDomains entry refuses the host without a lookup', async () => {
    const h = harness()
    const internals = h.manager as unknown as {
      sandboxSettings: { network: { deniedDomains: string[]; allowedDomains: string[]; allowManagedDomainsOnly: boolean } }
    }
    internals.sandboxSettings = {
      ...internals.sandboxSettings,
      network: { deniedDomains: ['blocked.example.test'], allowedDomains: [], allowManagedDomainsOnly: false },
    }
    await expect(startWs(h, 'wss://api.blocked.example.test/s')).rejects.toThrow('deniedDomains')
    expect(h.prompts).toEqual([])
  })

  test('allowManagedDomainsOnly refuses a host outside the managed allowlist', async () => {
    const h = harness()
    const internals = h.manager as unknown as {
      sandboxSettings: { network: { deniedDomains: string[]; allowedDomains: string[]; allowManagedDomainsOnly: boolean } }
    }
    internals.sandboxSettings = {
      ...internals.sandboxSettings,
      network: { deniedDomains: [], allowedDomains: ['corp.example.test'], allowManagedDomainsOnly: true },
    }
    await expect(startWs(h, 'wss://elsewhere.example.test/s')).rejects.toThrow('managed domain allowlist')
    expect(h.prompts).toEqual([])
  })
})

describe('spelling the host as a literal IP does not downgrade a deny to a prompt (R3)', () => {
  // `tools-reference.md:303` — "It also denies hosts in
  // `sandbox.network.deniedDomains`, and when `allowManagedDomainsOnly` is set
  // in managed settings, any host outside the managed allowlist." A raw IP is
  // a host. Before the guard fell through for literal addresses, both probes
  // below raised a USER-APPROVABLE prompt and opened on approval.

  const posture = (h: Harness, network: { deniedDomains: string[]; allowedDomains: string[]; allowManagedDomainsOnly: boolean }) => {
    const internals = h.manager as unknown as {
      sandboxSettings: { network: typeof network }
    }
    internals.sandboxSettings = { ...internals.sandboxSettings, network }
  }

  test('a literal public IP outside the managed allowlist refuses with the managed-deny reason and zero prompts', async () => {
    const h = harness()
    posture(h, { deniedDomains: [], allowedDomains: ['corp.example.test'], allowManagedDomainsOnly: true })
    await expect(startWs(h, 'ws://93.184.216.34/stream'))
      .rejects.toThrow('93.184.216.34 is outside the managed domain allowlist')
    expect(h.prompts).toEqual([])
    expect(h.openedUrls).toEqual([])
    expect(h.monitors.list(sessionKey)).toEqual([])
  })

  test('a deniedDomains entry naming the address refuses the literal IP with zero prompts', async () => {
    const h = harness()
    posture(h, { deniedDomains: ['93.184.216.34'], allowedDomains: [], allowManagedDomainsOnly: false })
    await expect(startWs(h, 'ws://93.184.216.34/stream')).rejects.toThrow('deniedDomains')
    expect(h.prompts).toEqual([])
    expect(h.openedUrls).toEqual([])
  })
})

describe('the ws field rules are enforced before any socket opens (tools-reference.md:296-297)', () => {
  test('a credentialed URL is refused before any prompt or socket, and the error never echoes it', async () => {
    // The challenger opened `ws://user:secret@93.184.216.34/stream` and the
    // credentials survived into `openSocket`. Now the watch is refused before
    // `authorize`, so the secret reaches neither a prompt nor an error string.
    const h = harness()
    let thrown: Error | undefined
    try {
      await startWs(h, 'ws://user:secret@93.184.216.34/stream')
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toContain('credentials')
    expect(thrown!.message).not.toContain('secret')
    expect(h.prompts).toEqual([])
    expect(h.openedUrls).toEqual([])
    expect(h.monitors.list(sessionKey)).toEqual([])
  })

  test('an invalid or duplicate protocols list is refused before any socket opens', async () => {
    // The challenger started a watch with `['a b', 'dup', 'dup']`.
    const h = harness()
    await expect(h.monitors.start({
      sessionKey,
      cwd: '/tmp/workspace-1',
      workspaceRoot: '/tmp/workspace-1',
      description: 'watch with bad protocols',
      timeoutMs: 300_000,
      persistent: false,
      ws: { url: 'wss://events.example.test/stream', protocols: ['a b', 'dup', 'dup'] },
    })).rejects.toThrow('subprotocol token')
    await expect(h.monitors.start({
      sessionKey,
      cwd: '/tmp/workspace-1',
      workspaceRoot: '/tmp/workspace-1',
      description: 'watch with duplicate protocols',
      timeoutMs: 300_000,
      persistent: false,
      ws: { url: 'wss://events.example.test/stream', protocols: ['dup', 'dup'] },
    })).rejects.toThrow('duplicates an earlier entry')
    expect(h.prompts).toEqual([])
    expect(h.openedUrls).toEqual([])
  })
})
