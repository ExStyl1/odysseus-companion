/**
 * R82 — the plugin update affordance.
 *
 * R81 made the wire truthful (`availableUpdateVersion` has a producer,
 * `canUpdate` can be true); this proves the user is finally TOLD:
 *
 *   1. a row whose wire payload carries `availableUpdateVersion` renders the
 *      version, one that omits it renders no badge (the dependency-hold case
 *      is withheld server-side by R81 — we render the wire, never re-derive),
 *   2. the Update action is offered iff `canUpdate`,
 *   3. a SUCCESSFUL manual update raises the `plugins/cli-reference.md#reload-plugins` reload
 *      notice — without it the toast says updated while every hook, MCP and LSP
 *      server in the session keeps executing the old path,
 *   4. enable/disable/uninstall still never raise that notice: `AppShell`'s
 *      auto-update toast stays keyed on the reason code, and the manual notice
 *      lives at its own mutation site.
 *
 * The badge is proved by rendering it (it is inline, not portalled). The menu
 * item is portalled by Radix and this package has no DOM harness, so its gate
 * is proved as the pure decision plus a pin on the single call site.
 */

import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  SafeInstalledPluginSummary,
  SafePluginManagementActionResult,
} from '@nessy-agent/shared/protocol/capabilities'
import {
  PluginUpdateBadge,
  PluginUpdateStalledBadge,
  describePluginActivation,
  resolvePluginRefreshSafe,
  offersPluginUpdate,
  pluginUpdateVersion,
  pluginUpdateVersionUncomparable,
  reportPluginActivation,
  runPluginUpdate,
  type PluginUpdateNotifier,
} from '../plugin-update-affordance'

const pluginsPageSource = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
const pluginInfoPageSource = readFileSync(new URL('../PluginInfoPage.tsx', import.meta.url), 'utf8')
const appShellSource = readFileSync(
  new URL('../../components/app-shell/AppShell.tsx', import.meta.url),
  'utf8',
)
const en = JSON.parse(readFileSync(
  new URL('../../../../../../packages/shared/src/i18n/locales/en.json', import.meta.url),
  'utf8',
)) as Record<string, string>

/** The real English strings, so the assertions are about what the user reads. */
const t = (key: string): string => en[key] ?? key

/** Exactly the shape the server sends (`SafeInstalledPluginSummary`). */
function installed(over: Partial<SafeInstalledPluginSummary> = {}): SafeInstalledPluginSummary {
  return {
    pluginKey: 'pk-1',
    activeInstanceId: 'inst-1',
    origin: { marketplaceId: 'acme', pluginId: 'tools' },
    name: 'Acme Tools',
    version: '1.0.0',
    installedAt: 1000,
    lifecycleState: 'ready',
    capabilityKinds: ['skill'],
    activation: { effective: 'active', global: 'unset', workspace: 'enabled' },
    actions: {
      canEnable: true, canDisable: true, canUpdate: false,
      canRepair: true, canUninstall: true, reasonCodes: [],
    },
    ...over,
  }
}

function badge(summary?: SafeInstalledPluginSummary): string {
  return renderToStaticMarkup(
    <PluginUpdateBadge
      installed={summary}
      formatLabel={version => t('plugins.updateAvailable').replace('{{version}}', version)}
    />,
  )
}

describe('the update badge renders the wire and nothing else', () => {
  it('renders the advertised version for a payload carrying availableUpdateVersion', () => {
    const markup = badge(installed({ availableUpdateVersion: '2.4.0' }))
    expect(markup).toContain('2.4.0')
    expect(markup).toContain('Update available')
    expect(markup).toContain('data-testid="plugin-update-badge"')
  })

  it('renders NO badge when the payload omits availableUpdateVersion', () => {
    // R81 withholds the field for a dependency-held plugin whose catalog latest
    // is outside the intersected range. Omitted → nothing rendered, so the
    // renderer never resurrects a badge the server deliberately suppressed.
    expect(badge(installed())).toBe('')
    expect(badge(installed({ availableUpdateVersion: '' }))).toBe('')
  })

  it('renders NO badge for a listing that is not installed at all', () => {
    expect(badge(undefined)).toBe('')
  })

  it('advertises the wire version verbatim — no renderer-side re-derivation', () => {
    expect(pluginUpdateVersion(installed({ availableUpdateVersion: '0.0.1-beta.3' }))).toBe('0.0.1-beta.3')
    expect(pluginUpdateVersion(installed())).toBeUndefined()
    expect(pluginUpdateVersion(undefined)).toBeUndefined()
  })
})

describe('the row says WHY an update can never be offered (P2.159)', () => {
  const stalled = (summary?: SafeInstalledPluginSummary): string => renderToStaticMarkup(
    <PluginUpdateStalledBadge
      installed={summary}
      formatLabel={() => t('plugins.updateVersionUncomparable')}
    />,
  )

  it('renders the note when the server named the reason', () => {
    const markup = stalled(installed({
      version: '0.10.2.3',
      actions: { ...installed().actions, reasonCodes: ['update-version-uncomparable'] },
    }))
    expect(markup).toContain('data-testid="plugin-update-stalled-badge"')
    expect(markup).toContain(t('plugins.updateVersionUncomparable'))
    // The real English string, not the key: this is what the user reads.
    expect(t('plugins.updateVersionUncomparable')).not.toBe('plugins.updateVersionUncomparable')
  })

  it('renders NOTHING for the ordinary already-current plugin, or no install at all', () => {
    // `canUpdate` is false in both cases; only the named one is news.
    expect(stalled(installed())).toBe('')
    expect(stalled(installed({ actions: { ...installed().actions, reasonCodes: ['managed-force-enabled'] } }))).toBe('')
    expect(stalled(undefined)).toBe('')
  })

  it('reads the wire field and re-derives nothing from the version strings', () => {
    expect(pluginUpdateVersionUncomparable(installed({
      actions: { ...installed().actions, reasonCodes: ['update-version-uncomparable'] },
    }))).toBe(true)
    // A four-part version with NO server verdict stays silent: the renderer is
    // not allowed to reach its own conclusion about comparability.
    expect(pluginUpdateVersionUncomparable(installed({ version: '0.10.2.3' }))).toBe(false)
    expect(pluginUpdateVersionUncomparable(undefined)).toBe(false)
    // And a PARTIAL payload — some pages build fixtures without `actions` at all
    // — must answer false rather than throw inside a render.
    expect(pluginUpdateVersionUncomparable({} as never)).toBe(false)
    expect(pluginUpdateVersionUncomparable({ actions: {} } as never)).toBe(false)
    expect(stalled({} as never)).toBe('')
  })

  it('is rendered on both surfaces that show the update badge', () => {
    for (const source of [pluginsPageSource, pluginInfoPageSource]) {
      expect(source).toContain('<PluginUpdateStalledBadge')
      expect(source).toContain("t('plugins.updateVersionUncomparable')")
    }
  })
})

describe('the Update action is offered iff the wire allows it', () => {
  it('offered when canUpdate is true', () => {
    expect(offersPluginUpdate(installed({
      actions: { ...installed().actions, canUpdate: true },
    }))).toBe(true)
  })

  it('withheld when canUpdate is false, and for a listing with no install', () => {
    expect(offersPluginUpdate(installed())).toBe(false)
    expect(offersPluginUpdate(undefined)).toBe(false)
  })

  it('the detail menu gates its Update item on that decision, next to Repair', () => {
    // Radix portals the menu content, and this package has no DOM harness, so
    // the gate is pinned at its single call site instead of rendered.
    const gate = pluginsPageSource.indexOf('{offersPluginUpdate(item.installed) && (')
    const label = pluginsPageSource.indexOf("{t('plugins.update')}", gate)
    const repair = pluginsPageSource.indexOf("{t('plugins.repair')}", gate)
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(label).toBeGreaterThan(gate)
    expect(repair).toBeGreaterThan(label)
    expect(pluginsPageSource).toContain('onClick={() => void onUpdate(item)}')
  })
})

describe('a successful manual update raises the reload notice (plugins/cli-reference.md#reload-plugins)', () => {
  function harness(result: SafePluginManagementActionResult | Error) {
    const notices: Array<{ level: 'success' | 'error'; title: string; description?: string }> = []
    const notify: PluginUpdateNotifier = {
      success: (title, options) => { notices.push({ level: 'success', title, ...options }) },
      error: (title, options) => { notices.push({ level: 'error', title, ...options }) },
    }
    const requests: Array<{ pluginKey: string; action: string }> = []
    return {
      notices,
      requests,
      run: () => runPluginUpdate({ pluginKey: 'pk-1', name: 'Acme Tools' }, {
        update: async (request) => {
          requests.push(request)
          if (result instanceof Error) throw result
          return result
        },
        notify,
        t,
        describeError: error => (error instanceof Error ? error.message : t('plugins.errorUpdate')),
      }),
    }
  }

  const ok: SafePluginManagementActionResult = { ok: true, pluginKey: 'pk-1', action: 'update' }

  it('sends the update action and raises the notice on success', async () => {
    const h = harness(ok)
    const outcome = await h.run()
    expect(h.requests).toEqual([{ pluginKey: 'pk-1', action: 'update' }])
    expect(outcome.ok).toBe(true)
    expect(h.notices).toEqual([{
      level: 'success',
      title: t('plugins.toastUpdated'),
      description: t('plugins.turnBoundaryNoticeBody'),
    }])
    // P6.412 — the notice still says what happens to the running session
    // rather than a bare "done"; what changed is that it names the mechanism
    // that ACTUALLY applies it (the turn boundary) instead of a button that
    // reaches no server RPC.
    expect(h.notices[0]?.description).toContain('activates as soon as it finishes')
  })

  it('still raises it for a partial update that needs re-consent', async () => {
    const h = harness({
      ok: true, pluginKey: 'pk-1', action: 'update',
      state: 'partial', requiresConfirmation: true,
      deferred: [{ externalKind: 'unsupported-hook', reasonCode: 'unsupported-runtime' }],
    })
    const outcome = await h.run()
    expect(outcome.needsConfirmEnable).toBe(true)
    expect(outcome.deferred).toHaveLength(1)
    expect(h.notices[0]?.description).toBe(t('plugins.turnBoundaryNoticeBody'))
  })

  it('a REJECTED update raises only its error — nothing was updated to reload', async () => {
    const h = harness({ ok: false, pluginKey: 'pk-1', action: 'update' })
    const outcome = await h.run()
    expect(outcome.ok).toBe(false)
    expect(outcome.errorMessage).toBe(t('plugins.errorUpdate'))
    expect(h.notices).toEqual([{
      level: 'error',
      title: t('plugins.errorUpdate'),
      description: 'Acme Tools',
    }])
    expect(h.notices.some(n => n.description === t('plugins.turnBoundaryNoticeBody'))).toBe(false)
  })

  it('a THROWN update raises only its error', async () => {
    const h = harness(new Error('plugin.manage.runtime-unavailable'))
    const outcome = await h.run()
    expect(outcome.ok).toBe(false)
    expect(h.notices).toEqual([{
      level: 'error',
      title: t('plugins.errorUpdate'),
      description: 'plugin.manage.runtime-unavailable',
    }])
    expect(h.notices.some(n => n.description === t('plugins.turnBoundaryNoticeBody'))).toBe(false)
  })
})

describe('P2.8 — the third install-summary state: "Plugin is now active"', () => {
  // The between-turns fact (active session NOT processing) is the SAME one the
  // server gate reads before it eagerly refreshes an idle session; the summary
  // only reflects the server's decision, it never runs a second refresh.
  it('describePluginActivation maps the between-turns fact to the three states', () => {
    // SAFE (between turns): now-active, and no Refresh-runtime affordance.
    expect(describePluginActivation(true)).toEqual({
      needsRuntimeRefresh: false,
      noticeBodyKey: 'plugins.nowActiveBody',
    })
    // UNSAFE (mid-turn): fall back to the existing needs-refresh notice.
    expect(describePluginActivation(false)).toEqual({
      needsRuntimeRefresh: true,
      noticeBodyKey: 'plugins.turnBoundaryNoticeBody',
    })
  })

  /**
   * P6.412 — the third state, and the reason it is not folded into the safe one.
   *
   * `Query.reloadPlugins()` (`sdk.d.ts:2544`) is shipped by the vendored SDK and
   * had ZERO call sites at HEAD. A session that takes it is live WITHOUT a
   * teardown — strictly better news than `applied` — but it is the only outcome
   * that costs the user:
   * `plugins/loading.md#check-which-stage-a-plugin-reached`, "Reloading has
   * a token cost on the next request".
   */
  it('describePluginActivation names the native reload and what it cost', () => {
    // POSITIVE: a reloaded runtime is live AND says what it cost.
    expect(describePluginActivation(true, true)).toEqual({
      needsRuntimeRefresh: false,
      noticeBodyKey: 'plugins.reloadedNoticeBody',
    })
    // A reload is safe by construction, so it wins over the caller's own
    // between-turns derivation rather than being masked by it — reading them the
    // other way round is how the cost would be lost.
    expect(describePluginActivation(false, true)).toEqual({
      needsRuntimeRefresh: false,
      noticeBodyKey: 'plugins.reloadedNoticeBody',
    })
    // NEGATIVE: absent means today's two states, byte for byte. Every caller
    // that cannot tell keeps the behaviour it had.
    expect(describePluginActivation(true)).toEqual(describePluginActivation(true, false))
    expect(describePluginActivation(false)).toEqual(describePluginActivation(false, false))
    expect(describePluginActivation(true).noticeBodyKey).toBe('plugins.nowActiveBody')
    // `'reloaded'` is SAFE but is NOT `'applied'`: the predicate answers "is the
    // plugin live", never "what did it cost".
    expect(resolvePluginRefreshSafe('reloaded', () => false)).toBe(true)
    expect(resolvePluginRefreshSafe('deferred', () => true)).toBe(false)
    // Both install call sites pass the verdict through; neither re-derives it.
    expect(pluginsPageSource.split("result.runtimeRefresh === 'reloaded'").length - 1).toBe(2)
    // The key lives in the flow module, like its two siblings — never in a page.
    const flowSource = readFileSync(new URL('../plugin-update-affordance.tsx', import.meta.url), 'utf8')
    expect(flowSource).toContain("'plugins.reloadedNoticeBody'")
    expect(pluginsPageSource).not.toContain('reloadedNoticeBody')
    expect(typeof en['plugins.reloadedNoticeBody']).toBe('string')
  })

  /**
   * F1.396 (origin WJ-ff P-WJ-ff-2) — the FOURTH state: the server says a live session's refresh FAILED
   * (`runtimeRefresh: 'failed'`, F1.265's summary), so the summary names it rather than falling back to the
   * active-session proxy that could announce "Plugin is now active" beside a session still on the old plugins.
   */
  it('describePluginActivation names a failed live-session refresh, and it outranks the other three', () => {
    const failed = { needsRuntimeRefresh: true, noticeBodyKey: 'plugins.refreshFailedNoticeBody' as const }
    expect(describePluginActivation(true, false, true)).toEqual(failed)
    expect(describePluginActivation(false, false, true)).toEqual(failed)
    expect(describePluginActivation(true, true, true)).toEqual(failed)
    // CONTROL — absent means the three states it had, byte for byte.
    expect(describePluginActivation(true, false)).toEqual(describePluginActivation(true, false, false))
    expect(describePluginActivation(true, true)).toEqual(describePluginActivation(true, true, false))
    // The server SAID it failed: unsafe, and the caller's own proxy is never asked.
    let proxyAsked = false
    expect(resolvePluginRefreshSafe('failed', () => { proxyAsked = true; return true })).toBe(false)
    expect(proxyAsked).toBe(false)
    expect(resolvePluginRefreshSafe('applied', () => false)).toBe(true)
    expect(resolvePluginRefreshSafe(undefined, () => true)).toBe(true)
    // The notice fires with the failed body, and the page must still offer Refresh.
    const fired: Array<{ title: string; description?: string }> = []
    const notify = { success: (title: string, options?: { description?: string }) => { fired.push({ title, ...options }) } }
    expect(reportPluginActivation(t('plugins.toastInstalled'), false, { notify, t }, false, true)).toEqual({ needsRuntimeRefresh: true })
    expect(fired).toEqual([{ title: t('plugins.toastInstalled'), description: t('plugins.refreshFailedNoticeBody') }])
    expect(typeof en['plugins.refreshFailedNoticeBody']).toBe('string')
    // Both install call sites pass the verdict through; the key lives in the flow module, never in a page.
    expect(pluginsPageSource.split("result.runtimeRefresh === 'failed'").length - 1).toBe(2)
    expect(pluginsPageSource).not.toContain('refreshFailedNoticeBody')
    const flowSource = readFileSync(new URL('../plugin-update-affordance.tsx', import.meta.url), 'utf8')
    expect(flowSource).toContain("'plugins.refreshFailedNoticeBody'")
  })

  it('reportPluginActivation fires the safe-aware notice and reports the flag', () => {
    const fired: Array<{ title: string; description?: string }> = []
    const notify = {
      success: (title: string, options?: { description?: string }) => { fired.push({ title, ...options }) },
    }
    const safe = reportPluginActivation(t('plugins.toastInstalled'), true, { notify, t })
    expect(safe).toEqual({ needsRuntimeRefresh: false })
    expect(fired).toEqual([{ title: t('plugins.toastInstalled'), description: t('plugins.nowActiveBody') }])

    fired.length = 0
    const unsafe = reportPluginActivation(t('plugins.toastInstalled'), false, { notify, t })
    expect(unsafe).toEqual({ needsRuntimeRefresh: true })
    expect(fired).toEqual([{ title: t('plugins.toastInstalled'), description: t('plugins.turnBoundaryNoticeBody') }])
  })

  function updateHarness(refreshSafe: boolean | undefined) {
    const notices: Array<{ level: 'success' | 'error'; title: string; description?: string }> = []
    const notify: PluginUpdateNotifier = {
      success: (title, options) => { notices.push({ level: 'success', title, ...options }) },
      error: (title, options) => { notices.push({ level: 'error', title, ...options }) },
    }
    return {
      notices,
      run: () => runPluginUpdate({ pluginKey: 'pk-1', name: 'Acme Tools' }, {
        update: async () => ({ ok: true, pluginKey: 'pk-1', action: 'update' }),
        notify,
        t,
        describeError: () => t('plugins.errorUpdate'),
        ...(refreshSafe === undefined ? {} : { refreshSafe }),
      }),
    }
  }

  it('a successful update BETWEEN TURNS reports "now active" and drops the refresh affordance', async () => {
    const h = updateHarness(true)
    const outcome = await h.run()
    expect(outcome.ok).toBe(true)
    expect(outcome.needsRuntimeRefresh).toBe(false)
    expect(h.notices).toEqual([{
      level: 'success',
      title: t('plugins.toastUpdated'),
      description: t('plugins.nowActiveBody'),
    }])
    // The user is told it is live now, not told to go refresh.
    expect(h.notices[0]?.description).toContain('now active')
  })

  it('a successful update MID-TURN falls back to needs-refresh — no false "active" claim', async () => {
    const h = updateHarness(false)
    const outcome = await h.run()
    expect(outcome.ok).toBe(true)
    // The gate deferred the refresh, so the summary must still tell the truth.
    expect(outcome.needsRuntimeRefresh).toBe(true)
    expect(h.notices[0]?.description).toBe(t('plugins.turnBoundaryNoticeBody'))
    expect(h.notices[0]?.description).not.toBe(t('plugins.nowActiveBody'))
  })

  it('defaults to the conservative needs-refresh state when safety is unknown', async () => {
    const h = updateHarness(undefined)
    const outcome = await h.run()
    expect(outcome.needsRuntimeRefresh).toBe(true)
    expect(h.notices[0]?.description).toBe(t('plugins.turnBoundaryNoticeBody'))
  })

  it('the new i18n key resolves in EVERY locale', () => {
    const dir = new URL('../../../../../../packages/shared/src/i18n/locales/', import.meta.url)
    const files = readdirSync(dir).filter(name => name.endsWith('.json'))
    // en + ru at minimum; every locale must carry the key.
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const file of files) {
      const locale = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, string>
      const value = locale['plugins.nowActiveBody']
      expect(typeof value).toBe('string')
      expect((value ?? '').trim().length).toBeGreaterThan(0)
    }
  })

  /**
   * P2.107 — the install summary stops GUESSING.
   *
   * `isRefreshSafe()` reads the active session's `isProcessing`, which is the
   * FIRST operand of the server's between-turns gate
   * (`managed.isProcessing || managed.agent.isProcessing()`) and not the whole
   * of it, so in the window where the host flag is already false while the
   * agent is still winding down it could report "Plugin is now active" a beat
   * before the refresh applied. `runtimeRefresh` is what the server DID.
   *
   * Each case kills its own mutation: swap the ternary's arms and the first two
   * flip; drop the `runtimeRefresh ?` guard and the last two lose the fallback;
   * make the fallback eager and the fourth's `called` count is wrong.
   */
  it('resolvePluginRefreshSafe prefers the server verdict and falls back only without one', () => {
    expect(resolvePluginRefreshSafe('applied', () => false)).toBe(true)
    expect(resolvePluginRefreshSafe('deferred', () => true)).toBe(false)
    expect(resolvePluginRefreshSafe(undefined, () => true)).toBe(true)
    expect(resolvePluginRefreshSafe(undefined, () => false)).toBe(false)

    // The server's answer wins WITHOUT consulting the proxy at all.
    let called = 0
    const derived = () => { called++; return false }
    expect(resolvePluginRefreshSafe('applied', derived)).toBe(true)
    expect(called).toBe(0)
    expect(resolvePluginRefreshSafe(undefined, derived)).toBe(false)
    expect(called).toBe(1)
  })

  it('PluginsPage feeds the between-turns signal in and keys the affordance off it', () => {
    // The page reads the SAME fact the server gate reads (active session
    // isProcessing), passes it as refreshSafe, and only keeps the Refresh-runtime
    // affordance when the server deferred (outcome.needsRuntimeRefresh).
    //
    // P2.107 — that derivation is now the FALLBACK on the install paths: they
    // pass the server's own `result.runtimeRefresh` through
    // `resolvePluginRefreshSafe`, and the local read only stands in when the
    // server could not say. The update path still derives it (its RPC result
    // carries no verdict), which is why `refreshSafe: isRefreshSafe()` stays.
    expect(pluginsPageSource).toContain('resolvePluginRefreshSafe(runtimeRefresh, isRefreshSafe)')
    expect(pluginsPageSource.split('isRefreshSafeFor(result.runtimeRefresh)').length - 1).toBe(2)
    expect(pluginsPageSource).toContain('const isRefreshSafe = useCallback(')
    expect(pluginsPageSource).toContain('isProcessing === true')
    expect(pluginsPageSource).toContain('refreshSafe: isRefreshSafe()')
    expect(pluginsPageSource).toContain('refreshAfterMarketplaceMutation({ needsRuntimeRefresh: outcome.needsRuntimeRefresh })')
    // Install paths report the third state through the flow module, so the notice
    // keys never leak into the page (keeps trap-1's single-site invariant true).
    expect(pluginsPageSource.split('reportPluginActivation(').length - 1).toBeGreaterThanOrEqual(2)
    expect(pluginsPageSource).not.toContain('nowActiveBody')
    expect(pluginsPageSource).not.toContain('turnBoundaryNoticeBody')
    expect(pluginsPageSource).not.toContain('autoUpdateNoticeBody')
  })
})

describe('enable/disable/uninstall never raise the reload notice (trap 1)', () => {
  it("AppShell's auto-update toast is still keyed on the reason code, not widened", () => {
    expect(appShellSource).toContain(
      'if (refreshed && event.reasonCode === MARKETPLACE_AUTO_UPDATE_REASON_CODE) {',
    )
  })

  it('the notice is raised at exactly two sites: auto-update and the manual update flow', () => {
    // P6.412 — the two flows no longer share a body key, because one sentence
    // was answering two different facts. `autoUpdateNoticeBody` is now the
    // auto-update flow's ALONE, so AppShell is its only site and the flow
    // module must not reach for it.
    const sites = [
      ['AppShell.tsx', appShellSource],
      ['PluginsPage.tsx', pluginsPageSource],
    ] as const
    expect(sites.filter(([, source]) => source.includes('autoUpdateNoticeBody')).map(([name]) => name))
      .toEqual(['AppShell.tsx'])
    // …and the manual half lives in the flow module, not in the page. Since
    // P2.8 the notice body is chosen by `describePluginActivation`, so the key
    // itself lives in the flow module (both the needs-refresh and now-active
    // bodies), never in a page.
    const flowSource = readFileSync(new URL('../plugin-update-affordance.tsx', import.meta.url), 'utf8')
    expect(flowSource).toContain("'plugins.turnBoundaryNoticeBody'")
    expect(flowSource).toContain("'plugins.nowActiveBody'")
  })

  it('the flow runs from the update handler only — enable/disable/uninstall/repair never call it', () => {
    expect(pluginsPageSource.split('runPluginUpdate(').length - 1).toBe(1)
    const enable = pluginsPageSource.indexOf('const onEnable = useCallback')
    const update = pluginsPageSource.indexOf('const onUpdate = useCallback')
    const call = pluginsPageSource.indexOf('runPluginUpdate(')
    expect(enable).toBeGreaterThanOrEqual(0)
    expect(update).toBeGreaterThan(enable)
    expect(call).toBeGreaterThan(update)
    // The enable → uninstall → repair span (everything before onUpdate) carries
    // neither the flow nor the notice.
    const otherLifecycles = pluginsPageSource.slice(enable, update)
    expect(otherLifecycles).not.toContain('runPluginUpdate(')
    expect(otherLifecycles).not.toContain('autoUpdateNotice')
  })
})
