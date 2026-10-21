/**
 * P6.417, the diagnostic half — a plugin language server that did not start
 * reaches the person whose plugin it is.
 *
 * Both failure sites in `SessionManager`'s LSP provisioning ended in
 * `sessionLog.warn`, and this file is the only consumer of
 * `resolvePluginStdioExecutable`'s `reason` and of the start throw. A packaged
 * build logs nothing outside debug mode, so an author whose `command` resolves
 * to nothing — and the user who installed the plugin — had no way at all to
 * learn the server was never running.
 *
 * Driven through `announcePluginLspUnavailable` itself rather than through a
 * whole session start: the subject is the NOTICE (that one is emitted, that it
 * names the server and the reason, that it carries a warning level, and that a
 * re-arm does not repeat it), and standing a real LSP process up would measure
 * the supervisor instead.
 */
import { describe, expect, it } from 'bun:test'
import type { RuntimeLspRegistration } from '@nessy-agent/shared/capabilities/resolver'
import { createTestSessionManager } from './test-session-manager'

interface Emitted {
  type: string
  sessionId?: string
  message?: string
  level?: string
}

function rig() {
  const manager = createTestSessionManager()
  const events: Emitted[] = []
  ;(manager as any).sendEvent = (event: Emitted) => { events.push(event) }
  const managed = {
    id: 'session-lsp',
    name: 'LSP session',
    workspace: { id: 'ws-lsp', rootPath: '/tmp/nessy-p6417' },
  }
  const announce = (registration: RuntimeLspRegistration, reason: string): void => {
    ;(manager as any).announcePluginLspUnavailable(managed, registration, reason)
  }
  return { announce, events }
}

const REGISTRATION = {
  key: 'plugin-a#tsserver',
  lspId: 'tsserver',
  command: 'tsserver',
  languages: ['typescript'],
  executableHash: 'hash',
} as RuntimeLspRegistration

describe('P6.417 · a plugin language server that did not start is announced', () => {
  it('emits one readable warning naming the server and the reason', () => {
    const { announce, events } = rig()

    announce(REGISTRATION, 'plugin-executable-not-found: tsserver')

    expect(events).toHaveLength(1)
    const notice = events[0]!
    expect(notice.type).toBe('info')
    expect(notice.sessionId).toBe('session-lsp')
    // Warning, not error: a capability the user configured is not running, and
    // that is not a failure of the session. The `channels.noDispatcher`
    // precedent.
    expect(notice.level).toBe('warning')
    // Read the message into a local BEFORE asserting on it — asserting a shape
    // with an asymmetric matcher would overwrite the field (AGENTS.md).
    const message = notice.message ?? ''
    expect(message).toContain('tsserver')
    expect(message).toContain('plugin-executable-not-found: tsserver')
    // The blast radius is bounded in the sentence itself, so one plugin's
    // failure is not read as the session being broken.
    expect(message.toLowerCase()).toContain('session')
  })

  it('does not repeat a failure a re-arm meets again, and does not swallow a NEW one', () => {
    // NEGATIVE/boundary. LSP provisioning re-runs per capability generation, so
    // an unresolvable command would otherwise emit its notice on every
    // generation of a session that will never resolve it. A DIFFERENT reason is
    // a different fact and must still arrive.
    const { announce, events } = rig()

    announce(REGISTRATION, 'plugin-executable-not-found: tsserver')
    announce(REGISTRATION, 'plugin-executable-not-found: tsserver')
    expect(events).toHaveLength(1)

    announce(REGISTRATION, 'lsp-start-timeout')
    expect(events).toHaveLength(2)
    expect(events[1]!.message ?? '').toContain('lsp-start-timeout')

    // …and a second server failing for the same reason is its own notice.
    announce({ ...REGISTRATION, key: 'plugin-b#pyright', lspId: 'pyright' }, 'lsp-start-timeout')
    expect(events).toHaveLength(3)
    expect(events[2]!.message ?? '').toContain('pyright')
  })
})
