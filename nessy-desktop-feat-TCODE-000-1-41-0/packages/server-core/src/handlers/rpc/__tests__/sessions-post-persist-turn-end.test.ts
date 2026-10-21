/**
 * P3.19 · the tenth renderer-facing `complete` waits for the batcher too.
 *
 * `SEND_MESSAGE`'s post-persist arm pushes `error` + `complete` straight to the
 * calling client. It is the only renderer-facing terminal event emitted outside
 * `SessionManager`, so P3.16's door cannot carry it — that door broadcasts to
 * the workspace and this report is addressed to one client. What it takes
 * instead is the door's flush half, `flushBeforeTurnEndEvent`, and this file
 * pins the ORDER: flush first, terminal event after.
 *
 * The reachability of the arm itself — a post-turn cleanup failure rejecting
 * `sendMessage` after `onAck`, with the model already streamed — is measured on
 * the real `sendMessage` in `sessions/post-turn-cleanup-failure.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import { registerSessionsHandlers } from '../sessions'

type Step =
  | { step: 'flush'; sessionId: string; workspaceId: string }
  | { step: 'push'; type: string }

function createHarness(options: { flushRejects?: boolean } = {}) {
  const order: Step[] = []
  const handlers = new Map<string, HandlerFn>()
  const warnings: unknown[][] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push(_channel, _target, ...args) {
      order.push({ step: 'push', type: (args[0] as { type?: string })?.type ?? 'unknown' })
    },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: () => [],
      flushBeforeTurnEndEvent: async (sessionId: string, workspaceId: string) => {
        // Recorded AFTER an await, like the real one: the delta reaches the wire
        // several awaits deep (`flushDelta` → the per-session chain →
        // `flushDeltaOnce` → possibly a `MessageDisplay` hook). Recording it on
        // entry would make a call-site that forgot to `await` look identical to
        // one that did — which is the regression this row exists for.
        await Promise.resolve()
        order.push({ step: 'flush', sessionId, workspaceId })
        if (options.flushRejects) throw new Error('flush blew up')
      },
      // Acks (so the arm under test is the POST-persist one), then rejects the
      // way a post-turn cleanup failure does.
      sendMessage: async (
        ..._args: [unknown, unknown, unknown, unknown, unknown, unknown, unknown, ((id: string) => void) | undefined, unknown]
      ) => {
        _args[7]?.('user-message-1')
        throw new Error('cleanup: setAutomationSystem threw')
      },
    },
    platform: {
      logger: {
        info() {}, debug() {}, error() {},
        warn(...args: unknown[]) { warnings.push(args) },
      },
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSessionsHandlers(server, deps)
  const context: RequestContext = {
    clientId: 'client-p319',
    workspaceId: 'workspace-p319',
    webContentsId: null,
  }
  return { handler: handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!, context, order, warnings }
}

/** The arm runs off the settled send, one tick behind the RPC's own resolution. */
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

describe('P3.19 · the post-persist arm flushes before its complete', () => {
  it('flushes the session, then pushes error and complete', async () => {
    const { handler, context, order } = createHarness()

    await expect(handler(context, 'session-p319', 'hello')).resolves
      .toEqual({ accepted: true, messageId: 'user-message-1' })
    await settle()

    // The whole point is the ORDER. RE-BREAK: drop the `await` on
    // `flushBeforeTurnEndEvent` and the flush step lands after both pushes;
    // remove the call and it disappears.
    expect(order).toEqual([
      { step: 'flush', sessionId: 'session-p319', workspaceId: 'workspace-p319' },
      { step: 'push', type: 'error' },
      { step: 'push', type: 'complete' },
    ])
  })

  it('still reports the error when the flush itself fails', async () => {
    // A flush is a best effort in front of a failure report; it may not become a
    // way to lose the report. The user is told what went wrong either way.
    const { handler, context, order, warnings } = createHarness({ flushRejects: true })

    await expect(handler(context, 'session-p319', 'hello')).resolves
      .toEqual({ accepted: true, messageId: 'user-message-1' })
    await settle()

    expect(order.map(step => step.step === 'push' ? step.type : step.step))
      .toEqual(['flush', 'error', 'complete'])
    expect(warnings).toHaveLength(1)
  })
})
