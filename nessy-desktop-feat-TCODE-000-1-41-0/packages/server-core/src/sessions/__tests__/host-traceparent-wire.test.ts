import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostTracer } from '@nessy-agent/shared/telemetry/host-tracer'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * P6.459 arm (2) / P6.732 — the WIRE that makes codex's per-request `trace`
 * field live: `SessionManager` → `CoreBackendConfig.resolveTraceparent` →
 * `CodexAgent` → `AppServerClient`.
 *
 * `AppServerClient` has carried the field and its whole absent/empty/notification
 * vocabulary since `08393fecd`, pinned in
 * `codex-agent-server/src/__tests__/app-server-client.test.ts`. What nothing
 * covered is the half above it: **nothing supplied the resolver**, so the field
 * was dormant in production while every test of it was green — the exact shape
 * of a wire that can be deleted without a red.
 *
 * The one thing worth driving rather than reading is the **KEY**. The resolver
 * must ask the tracer for the span opened by `beginTurnSpan`, which is keyed
 * `this.managedKey(managed)`. Any other key — the session id alone, the
 * workspace id, a composite spelled differently — returns `undefined` for ever
 * and looks exactly like "tracing is off": no error, no export, no way to tell
 * a broken wire from a correct absence. So the tracer here answers for ONE key
 * and refuses every other, and the positive case is the assertion that the two
 * call sites agree.
 *
 * Stands at the factory seam `createBackendFromManagedContext` for the reason
 * `agent-config-budget-anchors.test.ts` records: everything before it is
 * production code, and the tail (credentials, subprocess spawn) is irrelevant
 * to a wire. Nothing is transcribed — each case CALLS the wired closure.
 */

setSessionPlatform(createHeadlessPlatform())

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type CapturedConfig = { resolveTraceparent?: () => string | undefined }

/** A tracer that answers `currentTraceparent` for ONE key and nothing else. */
function tracerAnsweringFor(expectedKey: string | null, traceparent: string): {
  tracer: HostTracer
  askedWith: string[]
} {
  const askedWith: string[] = []
  const tracer: HostTracer = {
    startSpan: async (_options, callback) => callback({
      startSpan: async (_o, c) => c({} as never),
      addEvent: () => {}, setAttributes: () => {}, setStatus: () => {},
    }),
    currentTraceparent: key => {
      askedWith.push(key ?? '<no key>')
      return expectedKey !== null && key === expectedKey ? traceparent : undefined
    },
    beginTurnSpan: () => {},
    endTurnSpan: () => {},
    closeOpenTurnSpans: () => {},
    flush: async () => undefined,
    shutdown: async () => undefined,
  }
  return { tracer, askedWith }
}

async function capturedBackendConfig(hostTracer?: HostTracer): Promise<CapturedConfig> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-host-traceparent-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  const manager = createTestSessionManager(hostTracer ? { hostTracer } : {})
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
    workingDirectory: workspaceRoot,
  })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    'workspace-a:session-a',
    managed,
  )

  const internals = manager as unknown as {
    createCapabilityTurn(managed: unknown): Promise<{ runtime: unknown }>
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    createBackendFromManagedContext(args: { coreConfig: CapturedConfig }): unknown
    cleanup(): void
  }
  try {
    const turn = await internals.createCapabilityTurn(managed)
    let captured: CapturedConfig | undefined
    internals.createBackendFromManagedContext = args => {
      captured = args.coreConfig
      throw new Error('captured-before-construction')
    }
    await expect(internals.getOrCreateAgent(managed, turn.runtime))
      .rejects.toThrow('captured-before-construction')
    expect(captured).toBeTruthy()
    return captured!
  } finally {
    internals.cleanup()
  }
}

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

describe('P6.459 arm (2) — the host traceparent reaches the backend config', () => {
  it('resolves the open turn span, asking the tracer with the SAME key beginTurnSpan uses', async () => {
    // THE POSITIVE, and the key is the whole point. `managedKey` is
    // `<workspaceId>:<sessionId>`, which is what `beginTurnSpan` is called with
    // in `setProcessing` — a resolver reaching for anything else would return
    // `undefined` for ever and be indistinguishable from tracing being off.
    const { tracer, askedWith } = tracerAnsweringFor('workspace-a:session-a', TRACEPARENT)
    const coreConfig = await capturedBackendConfig(tracer)

    expect(coreConfig.resolveTraceparent?.()).toBe(TRACEPARENT)
    expect(askedWith).toContain('workspace-a:session-a')
  })

  it('answers undefined between turns, without minting an id', async () => {
    // THE BOUNDARY. A tracer that has no span open for this key returns
    // `undefined`, and the resolver must pass that through rather than invent a
    // carrier — `AppServerClient` then sends no `trace` key at all. A minted id
    // would name a trace nothing will ever export, which is worse than none.
    const { tracer } = tracerAnsweringFor(null, TRACEPARENT)
    const coreConfig = await capturedBackendConfig(tracer)

    expect(coreConfig.resolveTraceparent?.()).toBeUndefined()
  })

  it('hands the resolver on to the codex app-server client, which is the only undriven link', () => {
    // The middle of the chain, and the only part of it a test cannot DRIVE: the
    // line lives in `CodexAgent`'s spawn path and reaching it needs a real
    // codex child. Both ends ARE driven — this file above, and
    // `app-server-client.test.ts` below — so a source assertion here is the
    // cheapest honest cover for the one link whose deletion would otherwise be
    // green everywhere. Read the same way `codex-callback-bridge-host.test.ts`
    // reads this file.
    //
    // Asserted as a FORWARDING closure, not a captured value: `= this.config.resolveTraceparent`
    // would freeze nothing here but would stop reading a config replaced on a
    // reconstruction, and `AppServerClient` calls it per request by design.
    const codexAgent = readFileSync(
      fileURLToPath(new URL('../../../../shared/src/agent/codex-agent.ts', import.meta.url)),
      'utf8',
    )
    expect(codexAgent).toContain('resolveTraceparent: () => this.config.resolveTraceparent?.()')
  })

  it('is wired but silent when the operator never opted into tracing', async () => {
    // THE NEGATIVE, and it is deliberately not "the field is absent": the wire
    // is unconditional and the TRACER is what is optional. Asserting both halves
    // separates "no tracing" from "the wire was deleted" — the failure this
    // whole file exists for, since a deleted wire is otherwise green everywhere.
    const coreConfig = await capturedBackendConfig()

    expect(typeof coreConfig.resolveTraceparent).toBe('function')
    expect(coreConfig.resolveTraceparent?.()).toBeUndefined()
  })
})
