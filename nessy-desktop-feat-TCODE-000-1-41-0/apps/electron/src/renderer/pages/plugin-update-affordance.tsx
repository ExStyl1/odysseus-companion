/**
 * R82 — the plugin update affordance: the badge, the action gate, and the
 * post-update reload notice.
 *
 * `plugins/cli-reference.md#plugin-update` documents a per-plugin update
 * action ("Update a plugin to the latest version."), while
 * `plugins/install.md#manage-installed-plugins` deliberately keeps update OUT of the installed
 * tab's verb list ("view, enable, disable, or uninstall"). So the BADGE is what
 * carries discoverability and the action appears only when the wire says there
 * is something to update — never as a fourth always-present verb.
 *
 * Everything here reads the wire and nothing else. R81 owns what
 * `availableUpdateVersion` MEANS — in particular a dependency-held plugin whose
 * catalog latest falls outside the intersected range has the field withheld
 * server-side. Re-deriving that renderer-side would either contradict the
 * server or resurrect exactly the badge R81 suppresses.
 *
 * `runPluginUpdate` owns the honesty requirement from `plugins/cli-reference.md#reload-plugins`
 * — "When a plugin updates mid-session, hook commands, monitors, MCP servers,
 * and LSP servers keep using the previous version's path. Run `/reload-plugins`
 * to switch hooks, MCP servers, and LSP servers to the new path; monitors
 * require a session restart." Without it the toast says updated while the
 * running session keeps executing the old path. This fork has no
 * `/reload-plugins`: a deferred refresh is flushed at the TURN BOUNDARY by the
 * server, which is what `plugins.turnBoundaryNoticeBody` now says. P6.412
 * measured that the Refresh-runtime button this comment used to name reaches no
 * server RPC at all, so it was never the equivalent action.
 *
 * The notice is raised HERE, at the manual mutation's own site — never by
 * widening `AppShell`'s auto-update toast, which is keyed on
 * `MARKETPLACE_AUTO_UPDATE_REASON_CODE` so that an interactive mutation the
 * user just made (enable/disable/uninstall) never toasts at them.
 *
 * Pure + presentational so the affordance is provable without a DOM: the badge
 * renders inline (no portal) and the flow takes its notifier injected.
 */

import * as React from 'react'
import type {
  SafeInstalledPluginSummary,
  SafeMarketplacePluginDeferredCapability,
  SafePluginManagementActionResult,
} from '@nessy-agent/shared/protocol/capabilities'
import { PLUGIN_UPDATE_VERSION_UNCOMPARABLE_REASON } from '@nessy-agent/shared/capabilities/views'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type InstalledUpdateFields = Pick<SafeInstalledPluginSummary, 'availableUpdateVersion'> & {
  actions: Pick<SafeInstalledPluginSummary['actions'], 'canUpdate'>
}

/**
 * Deliberately TOLERANT of a missing `actions`/`reasonCodes`, the way
 * {@link InstalledUpdateFields} is of a missing `availableUpdateVersion`: this
 * reads a wire payload, and a badge is never worth throwing inside a render.
 * The real `SafeInstalledPluginSummary` always carries both.
 */
type InstalledReasonFields = {
  actions?: Partial<Pick<SafeInstalledPluginSummary['actions'], 'reasonCodes'>>
}

/**
 * The version the badge advertises, straight off the wire. `undefined` (no
 * badge) for a plugin the server did not advertise an update for — including
 * R81's dependency-hold case, which is withheld before it reaches us.
 */
export function pluginUpdateVersion(
  installed?: Pick<SafeInstalledPluginSummary, 'availableUpdateVersion'>,
): string | undefined {
  const version = installed?.availableUpdateVersion
  return version ? version : undefined
}

/**
 * Whether the Update action is offered at all. `canUpdate` is the server's
 * verdict (`SafeInstalledPluginSummary.actions.canUpdate`); a false one means
 * the control would either do nothing or break a dependent, so the item is
 * withheld rather than shown disabled.
 */
export function offersPluginUpdate(
  installed?: { actions: Pick<SafeInstalledPluginSummary['actions'], 'canUpdate'> },
): boolean {
  return installed?.actions.canUpdate === true
}

export interface PluginUpdateBadgeProps {
  /** The installed summary exactly as it crossed the wire. */
  installed?: InstalledUpdateFields | undefined
  /** i18n formatter, e.g. `version => t('plugins.updateAvailable', { version })`. */
  formatLabel: (version: string) => string
  className?: string
}

/**
 * The update badge. Renders nothing when the wire advertises no update, so the
 * row is unchanged for the (vast) majority of installed plugins.
 */
export function PluginUpdateBadge({ installed, formatLabel, className }: PluginUpdateBadgeProps) {
  const version = pluginUpdateVersion(installed)
  if (!version) return null
  return (
    <Badge
      variant="secondary"
      className={cn('font-normal', className)}
      data-testid="plugin-update-badge"
    >
      {formatLabel(version)}
    </Badge>
  )
}

/**
 * Whether the server withheld the Update action because the two version strings
 * cannot be ORDERED (P2.159) — not because the plugin is already current.
 *
 * Reads `actions.reasonCodes` off the wire and re-derives nothing. That field had
 * one writer and, until this reader, nothing outside tests read it at all; the
 * measured consequence was that the official `claude-security` bundle's
 * four-part `0.10.2.3` made `canUpdate` permanently false and the row looked
 * exactly like a plugin that was up to date.
 */
export function pluginUpdateVersionUncomparable(installed?: InstalledReasonFields): boolean {
  return installed?.actions?.reasonCodes?.includes(PLUGIN_UPDATE_VERSION_UNCOMPARABLE_REASON) === true
}

export interface PluginUpdateStalledBadgeProps {
  installed?: InstalledReasonFields | undefined
  /** i18n formatter, e.g. `() => t('plugins.updateVersionUncomparable')`. */
  formatLabel: () => string
  className?: string
}

/**
 * The counterpart to {@link PluginUpdateBadge}: it says an update CANNOT be
 * offered, where that badge says one is available. Renders nothing for every
 * ordinary plugin, so the row is unchanged unless the server named the reason.
 *
 * Non-gating: purely a label beside the same menu, exactly as the deferred
 * install notice is non-gating. Nothing here disables an action.
 */
export function PluginUpdateStalledBadge({ installed, formatLabel, className }: PluginUpdateStalledBadgeProps) {
  if (!pluginUpdateVersionUncomparable(installed)) return null
  return (
    <Badge
      variant="outline"
      className={cn('font-normal', className)}
      data-testid="plugin-update-stalled-badge"
    >
      {formatLabel()}
    </Badge>
  )
}

export interface PluginUpdateNotifier {
  success: (title: string, options?: { description?: string }) => void
  error: (title: string, options?: { description?: string }) => void
}

export interface PluginUpdateOutcome {
  ok: boolean
  /** Page-level action error; absent on success. */
  errorMessage?: string
  /** A `partial` update the server wants re-consented, same as repair. */
  needsConfirmEnable: boolean
  deferred: SafeMarketplacePluginDeferredCapability[]
  /**
   * Whether the page must still offer "Refresh runtime" (P2.8). `false` when the
   * mutation activated in the running session — the session was between turns, so
   * the manage RPC's `afterPluginMutation` already rebuilt the capability set
   * (`refresh-before-next-turn`) and the summary reports "Plugin is now active".
   * `true` when a turn was in flight (the refresh was deferred to the turn
   * boundary, `plugins/cli-reference.md#reload-plugins`) or when nothing changed to reload.
   */
  needsRuntimeRefresh: boolean
}

export interface PluginUpdateDeps {
  update: (request: { pluginKey: string; action: 'update' }) => Promise<SafePluginManagementActionResult>
  notify: PluginUpdateNotifier
  t: (key: string) => string
  describeError: (error: unknown) => string
  /**
   * Whether it is SAFE to activate in the running session — true when the active
   * session is between turns. This is the SAME fact the server's between-turns
   * gate reads (`SessionManager.invalidatePluginRuntimeForSession`:
   * `managed.isProcessing || managed.agent.isProcessing()`); the summary only
   * REFLECTS the server's decision, it never performs a second refresh, and it
   * never weakens that gate. Defaults to `false` (conservative needs-refresh)
   * when the caller cannot tell.
   */
  refreshSafe?: boolean
}

/**
 * The third install-summary state (P2.8). Given whether activation was SAFE
 * (the active session was between turns), report which post-mutation notice the
 * summary shows and whether the page must still offer "Refresh runtime":
 *
 *  - SAFE   → "Plugin is now active" (`plugins.nowActiveBody`), no refresh: the
 *             install/manage RPC's `afterPluginMutation` already refreshed the
 *             idle session (`refresh-before-next-turn`), so the plugin is live.
 *  - UNSAFE → the turn-boundary notice (`plugins.turnBoundaryNoticeBody`): a
 *             turn was in flight, so the server deferred the refresh to the turn
 *             boundary and the running turn still holds the old paths
 *             (`plugins/cli-reference.md#reload-plugins`).
 *
 * P6.412 moved the UNSAFE body OFF `plugins.autoUpdateNoticeBody`, which the
 * background auto-update path also shows. One sentence was answering two
 * different facts and it got the more actionable one wrong: a DEFERRED refresh
 * is flushed by `flushPendingPluginRuntimeRefresh` at the turn boundary with no
 * user action, while the auto-update pass swaps nothing into a live session at
 * all (`plugins/loading.md#when-auto-update-runs`: the running session keeps the versions it loaded
 * at launch). The old shared sentence — "Refresh the plugin runtime to use the
 * new versions" — named an action that does nothing on EITHER path:
 * `useMarketplaceRefresh` is `mutationFn: async () => undefined` plus a
 * react-query invalidation, and `SessionManager.refreshPluginRuntime` has one
 * caller, `afterPluginMutation`, reachable from no renderer RPC. Paying that
 * reload natively (`Query.reloadPlugins`, zero call sites at HEAD) is the rest
 * of P6.412 and lands in `backend/claude/live-session.ts`, which this lane does
 * not hold.
 *
 * Pure, so the three states (needs-confirm/error aside) are provable without a
 * DOM or a live session.
 */
export function describePluginActivation(
  refreshSafe: boolean,
  /**
   * P6.412 — the THIRD state. True when the server reports `'reloaded'`: the
   * live session took the RUNTIME'S OWN plugin reload
   * (`Query.reloadPlugins()`, `sdk.d.ts:2544`) rather than a teardown, so the
   * plugin is live in the session the user is looking at.
   *
   * It is not folded into the SAFE state, because it is the only outcome that
   * costs the user something and they are entitled to know:
   * `plugins/loading.md#check-which-stage-a-plugin-reached` — "Reloading
   * has a token cost on the next request: newly loaded components announce
   * themselves in content appended to the conversation, while the existing
   * history still reads from the prompt cache."
   *
   * And there is deliberately no force option beside it, which is a
   * MEASUREMENT rather than an omission. The page's `--force` belongs to the
   * CLI's slash command; the SDK's control request is
   * `{ subtype: 'reload_plugins' }` and nothing else (`sdk.d.ts:3932`) and
   * `reloadPlugins()` takes no arguments, so a reload through this seam is
   * already unconditional and there is no warn-and-skip to offer. The honest
   * affordance therefore names the cost that was paid; re-implementing
   * warn-and-skip host-side would be building beside a native mechanism instead
   * of enabling it. Recorded in `backend/claude/live-session.ts` too, where the
   * call lives.
   *
   * Defaults to `false`, so every caller that cannot tell keeps today's two
   * states exactly.
   */
  liveReloaded = false,
  /**
   * F1.396 — the FOURTH state. True when the server reports `'failed'`: at least one live session's refresh threw
   * (F1.265's summary), so that session keeps the previous plugins until its runtime restarts. It outranks the other
   * three — a reload or an applied refresh elsewhere does not make the failed session current — and it always
   * offers the Refresh affordance. Defaults to `false`, so every caller that cannot tell keeps its states exactly.
   */
  refreshFailed = false,
): {
  needsRuntimeRefresh: boolean
  noticeBodyKey:
    | 'plugins.nowActiveBody'
    | 'plugins.turnBoundaryNoticeBody'
    | 'plugins.reloadedNoticeBody'
    | 'plugins.refreshFailedNoticeBody'
} {
  if (refreshFailed) return { needsRuntimeRefresh: true, noticeBodyKey: 'plugins.refreshFailedNoticeBody' }
  // Ordered ahead of `refreshSafe` because a reload IS safe — the two are not
  // alternatives, and reading them the other way round would lose the cost.
  if (liveReloaded) return { needsRuntimeRefresh: false, noticeBodyKey: 'plugins.reloadedNoticeBody' }
  return refreshSafe
    ? { needsRuntimeRefresh: false, noticeBodyKey: 'plugins.nowActiveBody' }
    : { needsRuntimeRefresh: true, noticeBodyKey: 'plugins.turnBoundaryNoticeBody' }
}

/**
 * P2.107 — whether activation was safe, preferring the SERVER's verdict.
 *
 * `runtimeRefresh` is what `afterPluginMutation` actually did to the live
 * sessions (`'applied'` — every one took the refresh or had no runtime to
 * refresh; `'deferred'` — at least one had a turn in flight). Absent means the
 * server cannot say: the mutation committed but its refresh failed soft. Only
 * then does the caller's own derivation stand in, and that derivation is a
 * PROXY — it reads the active session's `isProcessing`, which is the first
 * operand of the server's gate and not the whole of it, so it can read "safe" a
 * beat before the refresh applies.
 *
 * `derived` is a thunk rather than a boolean so the proxy is not computed when
 * the real answer is present — the point of this function is that the fallback
 * is the exception.
 */
export function resolvePluginRefreshSafe(
  runtimeRefresh: 'applied' | 'deferred' | 'reloaded' | 'failed' | undefined,
  derived: () => boolean,
): boolean {
  // F1.396 — `'failed'` is the server SAYING a live session did not take the refresh: unsafe, and never a reason to
  // fall back to the caller's proxy (which reads only the active session).
  if (runtimeRefresh === 'failed') return false
  // P6.412 — `'reloaded'` is SAFE: the runtime reloaded its plugins in place, so
  // nothing stale is held. It differs from `'applied'` only in what it costs the
  // user, which `describePluginActivation`'s third state says and this predicate
  // deliberately does not — this answers "is the plugin live", not "what did it
  // cost".
  return runtimeRefresh ? runtimeRefresh !== 'deferred' : derived()
}

/**
 * Fire the post-mutation activation notice for an install/update and report
 * whether the page must still offer "Refresh runtime". Both i18n keys live here,
 * at the shared mutation-notice site, so no page re-implements the summary text
 * (and neither notice body reaches `PluginsPage`, per trap 1).
 */
export function reportPluginActivation(
  title: string,
  refreshSafe: boolean,
  deps: { notify: Pick<PluginUpdateNotifier, 'success'>; t: (key: string) => string },
  /** P6.412 — the server's `runtimeRefresh === 'reloaded'`; see {@link describePluginActivation}. */
  liveReloaded = false,
  /** F1.396 — the server's `runtimeRefresh === 'failed'`; see {@link describePluginActivation}. */
  refreshFailed = false,
): { needsRuntimeRefresh: boolean } {
  const { needsRuntimeRefresh, noticeBodyKey } = describePluginActivation(refreshSafe, liveReloaded, refreshFailed)
  deps.notify.success(title, { description: deps.t(noticeBodyKey) })
  return { needsRuntimeRefresh }
}

/**
 * Run one manual update and report what the page must do with the result.
 * A SUCCESSFUL update raises the reload notice; a rejected or thrown one
 * raises only its error, because nothing changed on disk to reload.
 */
export async function runPluginUpdate(
  plugin: { pluginKey: string; name: string },
  deps: PluginUpdateDeps,
): Promise<PluginUpdateOutcome> {
  try {
    const result = await deps.update({ pluginKey: plugin.pluginKey, action: 'update' })
    if (!result.ok) {
      const message = deps.t('plugins.errorUpdate')
      deps.notify.error(message, { description: plugin.name })
      return { ok: false, errorMessage: message, needsRuntimeRefresh: false, needsConfirmEnable: false, deferred: [] }
    }
    // `plugins/cli-reference.md#reload-plugins` — the running session still holds the previous
    // version's paths WHILE a turn is in flight; between turns the manage RPC's
    // `afterPluginMutation` already activated the new version. The success notice
    // tells that truth (P2.8): "now active" between turns, the reload notice
    // mid-turn. The refresh itself is the server's — this only reports it.
    const { needsRuntimeRefresh } = reportPluginActivation(
      deps.t('plugins.toastUpdated'),
      deps.refreshSafe ?? false,
      deps,
    )
    return {
      ok: true,
      needsRuntimeRefresh,
      needsConfirmEnable: result.state === 'partial' && result.requiresConfirmation === true,
      deferred: result.deferred ?? [],
    }
  } catch (error) {
    const message = deps.describeError(error)
    deps.notify.error(deps.t('plugins.errorUpdate'), { description: message })
    return { ok: false, errorMessage: message, needsRuntimeRefresh: false, needsConfirmEnable: false, deferred: [] }
  }
}
