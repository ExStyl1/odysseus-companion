import {
  RPC_CHANNELS,
  projectSessionScheduledWork,
  type SessionScheduledWorkPageV1,
} from '@nessy-agent/shared/protocol'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

/**
 * D1.97 + D1.98 — the one read that carries this session's scheduled work.
 *
 * ## What was missing was the ROUTE, not the data
 *
 * Measured at HEAD before this module was written: `cron` appeared **zero**
 * times in `packages/shared/src/protocol/channels.ts` (control: seven files
 * under `protocol/` name `automation`), while `sessionCronServices` occurs
 * thirteen times inside `SessionManager` with a store and a lifecycle test
 * behind it, and `SessionMonitorService` files every watch into the
 * background-task registry. So both inventories existed and neither had a way
 * out of the server. This module is that way out and decides nothing else — the
 * flattening is `projectSessionScheduledWork`'s, in `packages/shared`, where the
 * typed `/tasks` answer reads it too.
 *
 * ## A module of its own rather than another handler inside `sessions.ts`
 *
 * `sessions.ts` is the hottest file in this directory and a session read that
 * changes on its own schedule does not need to share a lane with it. The cost
 * is one registration line and one entry in the registration-profile set, and
 * that set is the guard that makes the cost visible: a handler registered
 * without being declared fails there rather than in production.
 *
 * ## THREE answers, never merged
 *
 * The page distinguishes an EMPTY session, a session the host cannot answer for,
 * and a session id nothing owns. A handler that returned `[]` for all three
 * would tell a user "nothing is queued" about a session it never asked, and the
 * panel would have no way to tell the difference — which is the exact merge the
 * accessor's optionality exists to expose.
 */

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.LIST_SCHEDULED_WORK,
] as const

/** The page a host without the accessor answers. See the module header. */
export const SCHEDULED_WORK_UNSUPPORTED_PAGE: SessionScheduledWorkPageV1 = Object.freeze({
  schemaVersion: 1,
  entries: Object.freeze([]),
  unavailable: 'not-supported',
})

export function registerScheduledWorkHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.sessions.LIST_SCHEDULED_WORK,
    async (ctx, sessionId: string): Promise<SessionScheduledWorkPageV1> => {
      const { sessionManager } = deps
      // The accessor is optional on `ISessionManager` (`getSessionProvider?`'s
      // shape), so "this host cannot answer" is a real state and is reported as
      // one rather than as an empty list.
      if (typeof sessionManager.listSessionScheduledWork !== 'function') {
        return SCHEDULED_WORK_UNSUPPORTED_PAGE
      }
      const sources = sessionManager.listSessionScheduledWork(
        sessionId,
        ctx.workspaceId ?? undefined,
      )
      if (!sources) return { schemaVersion: 1, entries: [], unavailable: 'session-not-found' }
      // F1.508 — the armed scheduled plugin monitors ride on THIS page only, never on the hook port above (whose two
      // arrays are the hooks' documented payload), and only when there is one: an empty session's page is unchanged.
      const pluginMonitors = sessionManager.listArmedScheduledPluginMonitors?.(sessionId, ctx.workspaceId ?? undefined) ?? []
      return {
        schemaVersion: 1,
        entries: projectSessionScheduledWork(sources),
        ...(pluginMonitors.length > 0 ? { pluginMonitors } : {}),
      }
    },
  )
}
