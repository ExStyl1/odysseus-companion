/**
 * P6.412 — the mutation verdict a NATIVE plugin reload produces.
 *
 * `Query.reloadPlugins()` (`sdk.d.ts:2544`) is shipped by the vendored SDK and
 * had ZERO call sites at HEAD. Once a live session takes it, the session is
 * current WITHOUT a teardown — which is strictly better news than `'applied'`
 * and yet carries a cost `'applied'` does not:
 * `plugins/loading.md#check-which-stage-a-plugin-reached` — "Reloading has
 * a token cost on the next request: newly loaded components announce themselves
 * in content appended to the conversation, while the existing history still
 * reads from the prompt cache."
 *
 * So it is a THIRD verdict rather than a fold, and this pins the ordering
 * decision that goes with it: a session that still holds the previous paths is
 * the fact the summary must carry, whatever the other sessions did.
 *
 * `afterPluginMutation` is driven directly because the reader
 * (`describeRefreshSummary`) is private, and it stays private: it has exactly
 * one caller and exporting it for a test would widen the module's surface for
 * nobody's benefit. With no `workspaceId` and no `workspaceService` the renderer
 * push list is empty, so the fake `RpcServer` is never touched.
 */

import { describe, expect, test } from 'bun:test'
import { afterPluginMutation } from '../plugin-runtime-refresh'
import type { HandlerDeps } from '../../handler-deps'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { PluginRuntimeRefreshSummary } from '../../../sessions/plugin-runtime-refresh-outcome'

const server = {} as unknown as RpcServer

function depsReporting(summary: PluginRuntimeRefreshSummary): HandlerDeps {
  return {
    sessionManager: { refreshPluginRuntime: async () => summary },
    platform: {},
  } as unknown as HandlerDeps
}

describe('afterPluginMutation — the native-reload verdict (P6.412)', () => {
  test('a session that reloaded in place reports `reloaded`, not `applied`', async () => {
    const verdict = await afterPluginMutation(
      server,
      depsReporting({ applied: 0, deferred: 0, untouched: 0, reloaded: 1 }),
      {},
      'plugin enable',
    )
    expect(verdict).toBe('reloaded')
    // Mixed with sessions that had nothing to refresh, the reload still wins:
    // `untouched` means no stale runtime, so it hides nothing.
    expect(
      await afterPluginMutation(
        server,
        depsReporting({ applied: 1, deferred: 0, untouched: 2, reloaded: 1 }),
        {},
        'plugin install',
      ),
    ).toBe('reloaded')
  })

  test('a deferral still outranks a reload, and an absent count reads as zero', async () => {
    // NEGATIVE, the ordering: one session still holding the previous paths is
    // the fact the user needs, whatever the others did.
    expect(
      await afterPluginMutation(
        server,
        depsReporting({ applied: 0, deferred: 1, untouched: 0, reloaded: 3 }),
        {},
        'plugin uninstall',
      ),
    ).toBe('deferred')
    // NEGATIVE, the default: every producer that predates this field keeps
    // meaning exactly what it meant — absent is zero, never a reload.
    expect(
      await afterPluginMutation(
        server,
        depsReporting({ applied: 1, deferred: 0, untouched: 0 }),
        {},
        'plugin enable',
      ),
    ).toBe('applied')
    expect(
      await afterPluginMutation(
        server,
        depsReporting({ applied: 0, deferred: 0, untouched: 0, reloaded: 0 }),
        {},
        'plugin enable',
      ),
    ).toBe('applied')
  })
})

/**
 * F1.396 (origin WJ-ff P-WJ-ff-2) — a live session whose refresh FAILED is a verdict of its own, `'failed'`.
 *
 * F1.265 gave the server the per-session counts, but `afterPluginMutation` still answered `undefined` ("cannot say")
 * for a summary with `failed`, so the install summary fell back to the renderer's derivation — the ACTIVE session's
 * `isProcessing` alone — and could announce "Plugin is now active" while another live session kept the previous
 * plugins. `'failed'` is the value the agent tool channel already answers for the same fact (F1.211).
 */
describe('afterPluginMutation — a failed live-session refresh answers `failed` (F1.396)', () => {
  const failing = (over: Partial<PluginRuntimeRefreshSummary> = {}): PluginRuntimeRefreshSummary => ({
    applied: 1, deferred: 0, untouched: 0, reloaded: 0,
    failed: 1, failures: [{ sessionId: 'codex-bad', error: 'codex-runtime-session-disposal-failed' }],
    ...over,
  })

  test('two sessions, one failing: `failed`, whatever the other did', async () => {
    expect(await afterPluginMutation(server, depsReporting(failing()), {}, 'marketplace install')).toBe('failed')
    // It outranks a reload and a deferral: the failed session is the fact the user needs.
    expect(await afterPluginMutation(server, depsReporting(failing({ applied: 0, reloaded: 1 })), {}, 'marketplace install')).toBe('failed')
    expect(await afterPluginMutation(server, depsReporting(failing({ applied: 0, deferred: 1 })), {}, 'marketplace install')).toBe('failed')
  })

  test('CONTROL — every session succeeding reads exactly as before, and a refresh that THREW is still "cannot say"', async () => {
    expect(await afterPluginMutation(server, depsReporting({ applied: 2, deferred: 0, untouched: 1 }), {}, 'marketplace install')).toBe('applied')
    const threw = {
      sessionManager: { refreshPluginRuntime: async () => { throw new Error('refresh-exploded') } },
      platform: {},
    } as unknown as HandlerDeps
    expect(await afterPluginMutation(server, threw, {}, 'marketplace install')).toBeUndefined()
  })
})
