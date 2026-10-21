/**
 * T10 — which runtime produced each row.
 *
 * `Message.runtime` / `Message.llmConnection` were declared by T16 and nothing
 * filled them, so rewind, branch and the transcript boundary all fell back to
 * the session's CURRENT connection — wrong for every row written before a
 * switch. These tests measure the stamp at write time and its survival through
 * the persistence round trip.
 *
 * The mapper round trip is the half that is easy to get wrong twice over:
 * `messageToStored` and `storedToPersistedMessage` both spread, so the fields
 * ride along for free — but only because they are on the message. A stamp
 * applied at PERSIST time instead would give every pre-switch row the
 * post-switch runtime, which is the exact lie the field exists to stop.
 */

import { describe, expect, it } from 'bun:test'
import { messageToStored, storedToPersistedMessage } from '@nessy-agent/core/types'
import type { PersistedMessage } from '@nessy-agent/core/types'
import { createTestSessionManager } from './test-session-manager.ts'

type Stamper = {
  resolveManagedProvider: (managed: unknown) => string
  stampMessageProvenance: <T>(managed: unknown, message: T) => T
  appendManagedMessage: (managed: unknown, message: PersistedMessage) => void
}

/** A real manager: the two helpers read only `resolveManagedProvider` and the session. */
function stamper(): Stamper {
  return createTestSessionManager() as unknown as Stamper
}

const session = (provider: string, llmConnection?: string) => ({
  messages: [] as PersistedMessage[],
  llmConnection,
  // `resolveManagedProvider` derives this from the connection; stubbed per
  // session so the tests do not depend on a config file.
  __provider: provider,
})

function withProvider(manager: Stamper): Stamper {
  manager.resolveManagedProvider = (managed: unknown) => (managed as { __provider: string }).__provider
  return manager
}

const row = (id: string, role: PersistedMessage['role'] = 'assistant'): PersistedMessage =>
  ({ id, role, content: `content-${id}`, timestamp: 1 }) as PersistedMessage

describe('per-message runtime provenance', () => {
  it('stamps the producing runtime and connection on an appended row', () => {
    const manager = withProvider(stamper())
    const managed = session('pi', 'pi-source')
    manager.appendManagedMessage(managed, row('m1'))
    expect(managed.messages[0]).toMatchObject({ runtime: 'pi', llmConnection: 'pi-source' })
  })

  // The point of the whole task: a row written before the switch keeps the
  // runtime that produced it, instead of reading as the session's current one.
  it('keeps the pre-switch runtime on pre-switch rows', () => {
    const manager = withProvider(stamper())
    const managed = session('pi', 'pi-source')
    manager.appendManagedMessage(managed, row('m1'))

    // The switch: same session object, new provider and connection.
    managed.__provider = 'anthropic'
    managed.llmConnection = 'claude-gateway'
    manager.appendManagedMessage(managed, row('m2'))

    expect(managed.messages.map(m => m.runtime)).toEqual(['pi', 'anthropic'])
    expect(managed.messages.map(m => m.llmConnection)).toEqual(['pi-source', 'claude-gateway'])
  })

  // Negative subject. A session with no connection slug must not invent one —
  // "absent" has to stay distinguishable, because a reader is documented to
  // treat it as "the session's current runtime".
  it('omits the connection when the session has none, and still records the runtime', () => {
    const manager = withProvider(stamper())
    const managed = session('codex-runtime', undefined)
    manager.appendManagedMessage(managed, row('m1'))
    expect(managed.messages[0]?.runtime).toBe('codex-runtime')
    expect(managed.messages[0]).not.toHaveProperty('llmConnection')
  })

  it('survives the persistence round trip in both directions', () => {
    const manager = withProvider(stamper())
    const managed = session('anthropic', 'claude-gateway')
    manager.appendManagedMessage(managed, row('m1'))

    const stored = messageToStored(managed.messages[0]!)
    expect(stored).toMatchObject({ runtime: 'anthropic', llmConnection: 'claude-gateway' })
    expect(storedToPersistedMessage(stored)).toMatchObject({ runtime: 'anthropic', llmConnection: 'claude-gateway' })
  })

  // Positive control for an absence: a row built the old way carries nothing,
  // and the round trip must not manufacture a value for it. Without this, a
  // mapper that defaulted `runtime` would pass every row above.
  it('carries nothing for a row written before the field existed', () => {
    const legacy = messageToStored(row('legacy'))
    expect(legacy).not.toHaveProperty('runtime')
    expect(storedToPersistedMessage(legacy)).not.toHaveProperty('runtime')
  })
})
