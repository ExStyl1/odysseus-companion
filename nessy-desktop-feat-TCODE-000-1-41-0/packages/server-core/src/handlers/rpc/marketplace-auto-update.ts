/**
 * Post-startup marketplace auto-update, wired.
 *
 * `plugins/loading.md#when-auto-update-runs` — "Claude Code checks for marketplace and plugin
 * updates after your session starts, with a random delay of up to ten minutes,
 * so the running session keeps using the versions it loaded at launch. If any
 * plugins were updated, you'll see a notification prompting you to run
 * `/reload-plugins`, or the new versions load on your next launch."
 *
 * The delay policy, the env gate and the randomness all live in the shared leaf
 * (`marketplace/auto-update.ts`); this file is only the composition — which
 * controller runs, and how a landed refresh announces itself.
 *
 * NOTHING here swaps into a live session. The pass re-fetches marketplace
 * CATALOGS and then reuses the existing plugin-mutation invalidation seam, whose
 * `add-or-refresh` effect is resolved before the next turn rather than inside
 * the running one. The `/reload-plugins` half is the renderer notice keyed on
 * the reason code below; this fork has no `/reload-plugins` command, and its
 * analogue is the Plugins page's Refresh-runtime action — which since P6.563
 * genuinely is one: it reaches `marketplace.REFRESH_RUNTIME`, which calls
 * `SessionManager.refreshPluginRuntime` for the workspace and reports back
 * which of `applied`/`deferred`/`untouched` happened. Until that row the
 * sentence was false: the button invalidated renderer query caches and touched
 * no live session.
 *
 * This is deliberately distinct from an INTERACTIVE marketplace/`/plugin`
 * install: that path runs `afterPluginMutation` (not just this invalidation), so
 * a session BETWEEN TURNS is eagerly refreshed and its install summary reports
 * the third state, "Plugin is now active" (P2.8, `plugin-update-affordance.tsx`
 * `describePluginActivation`). This BACKGROUND pass keeps the `:445` contract —
 * "the new versions load on your next launch" — so it stays refresh-before-next-
 * turn and its notice remains the Refresh-runtime substitute above.
 */
import {
  MARKETPLACE_AUTO_UPDATE_REASON_CODE,
  scheduleMarketplaceAutoUpdate,
  type MarketplaceAutoUpdateEnv,
  type ScheduledMarketplaceAutoUpdate,
} from '@nessy-agent/shared/marketplace/auto-update'
import { MarketplaceService } from '@nessy-agent/shared/marketplace'
import { listRepositoryTags } from '@nessy-agent/shared/plugins'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { emitPluginMutationInvalidation } from './plugin-runtime-refresh'

export interface MarketplaceAutoUpdateOptions {
  env?: MarketplaceAutoUpdateEnv
  random?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  maxDelayMs?: number
}

/**
 * Render a thrown value for the pass's own failure line. `String(x)` is NOT
 * total — `String(Object.create(null))` raises (measured in P2.65) — and this
 * runs inside the catch that exists to stop a rejection from vanishing, so it
 * must not be able to throw.
 */
function autoUpdateFailureText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  try {
    return String(error)
  } catch {
    return '(unrenderable error)'
  }
}

/**
 * Arm the single post-startup check for this process. Returns a handle whose
 * `scheduled` is false when the env gate refused, so a caller can log the
 * decision; the timer is `unref`'d, so a pending check never holds the process.
 *
 * A no-op when no registry controller is composed (headless before storage
 * readiness, and every test that stubs `HandlerDeps`).
 */
export function startMarketplaceAutoUpdate(
  server: RpcServer,
  deps: HandlerDeps,
  options: MarketplaceAutoUpdateOptions = {},
): ScheduledMarketplaceAutoUpdate {
  const registrySource = deps.marketplaceRegistrySource
  if (!registrySource) {
    return { scheduled: false, gate: { run: true, reason: 'default' }, delayMs: 0, cancel: () => {} }
  }
  const scheduled = scheduleMarketplaceAutoUpdate({
    env: options.env ?? process.env,
    ...(options.random ? { random: options.random } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
    run: async () => {
      // P2.184 — the pass logs its OWN failures, which is what makes
      // `auto-update.ts`'s `.catch(() => {})` comment true rather than
      // aspirational. It was not: the per-plugin loops inside
      // `updateInstalledBundles` name their own skips (P2.173), but a throw
      // from anywhere ELSE in this body — the catalog refresh, the bundle
      // service construction, the invalidation emit — escaped to the
      // scheduler's swallow and produced NO LINE AT ALL. An unattended pass
      // whose failure mode is that nothing happens is indistinguishable from a
      // pass with nothing to do, which is the family P2.146/P2.153/P2.159/P2.162
      // all sit in.
      //
      // The channel is the one this function already writes to and the prefix
      // is the one it already uses, so the failure lands in the same log stream
      // as the successes it would otherwise silently replace. Not a second
      // record, and no new i18n key: nothing here is user-facing text.
      try {
        const result = await registrySource.refreshAutoUpdateMarketplaces()
        // P2.159 — named BEFORE the early return, because the measured case is the
        // one where `refreshed` is empty: the official Anthropic marketplace timed
        // out on every attempt, so the pass returned here silently and its catalog
        // went on serving three-week-old rows with auto-update reported as on. A
        // refresh that did not land is the thing worth a line, not the one that
        // did. (The user-visible half rides `registryLoadErrors`, stamped onto the
        // retained catalog by `MarketplaceRegistrySource.upgrade`.)
        for (const failure of result.failed) {
          deps.platform.logger?.warn(
            `MARKETPLACE_AUTO_UPDATE: refresh did not land for ${failure.marketplaceId} (${failure.reason});`
              + ' its cached catalog is stale',
          )
        }
        if (result.refreshed.length === 0) return
        deps.platform.logger?.info(
          `MARKETPLACE_AUTO_UPDATE: refreshed ${result.refreshed.length} of ${result.considered.length} marketplaces`,
        )
        // `plugins/loading.md#when-auto-update-runs` — the SECOND half: "refreshes the marketplace
        // data and updates installed plugins to their latest versions on disk."
        // R63 shipped the refresh and recorded this as deferred; it runs here,
        // scoped to the marketplaces that actually refreshed, and only ever writes
        // bundles — the invalidation below is what makes them visible, before the
        // next turn rather than inside the running one.
        if (deps.pluginManagement) {
          const bundles = await new MarketplaceService({
            pluginService: deps.pluginManagement,
            registrySource,
            listRepositoryTags: repositoryUrl => listRepositoryTags(repositoryUrl),
          }).updateInstalledBundles({ marketplaceIds: result.refreshed })
          if (bundles.updated.length > 0 || bundles.skipped.length > 0) {
            deps.platform.logger?.info(
              `MARKETPLACE_AUTO_UPDATE: updated ${bundles.updated.length} of ${bundles.considered.length} `
                + `installed plugin bundles (${bundles.skipped.length} skipped)`,
            )
          }
          for (const skip of bundles.skipped) {
            // `plugins/host-marketplace.md#hold-users-on-one-version` — a skip "lists the skip in the
            // `/plugin` Errors tab, naming the constraining plugin". Named here so
            // the reason survives into the log even before the Errors tab reads it.
            deps.platform.logger?.info(
              `MARKETPLACE_AUTO_UPDATE: skipped ${skip.pluginKey} (${skip.reasonCode})`
                + (skip.constrainedBy?.length ? ` held by ${skip.constrainedBy.join(', ')}` : ''),
            )
          }
        }
        // Reuse the ONE invalidation seam — no second path. `add-or-refresh`
        // resolves before the next turn, which is exactly `:445`'s "the new
        // versions load on your next launch" rather than a mid-session swap.
        emitPluginMutationInvalidation(
          server,
          { workspaceIds: deps.workspaceService?.listResolved().map(workspace => workspace.id) ?? [] },
          'marketplace.auto-update',
          'add-or-refresh',
          MARKETPLACE_AUTO_UPDATE_REASON_CODE,
        )
      } catch (error) {
        deps.platform.logger?.warn(
          // "did not finish" rather than "nothing happened": the throw can land
          // after a refresh or an update has already been written, and the lines
          // above say which ones did.
          `MARKETPLACE_AUTO_UPDATE: the pass did not finish: ${autoUpdateFailureText(error)}`,
        )
      }
    },
  })
  if (!scheduled.scheduled) {
    deps.platform.logger?.info('MARKETPLACE_AUTO_UPDATE: disabled by DISABLE_AUTOUPDATER')
  }
  return scheduled
}
