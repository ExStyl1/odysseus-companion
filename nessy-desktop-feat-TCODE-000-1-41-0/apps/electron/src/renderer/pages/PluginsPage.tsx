import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowUpCircle,
  Box,
  CheckCircle2,
  ChevronDown,
  Download,
  FolderGit2,
  Info, Loader2,
  MoreHorizontal,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Trash2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAtom, useStore } from 'jotai'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UNMATCHABLE_RELEVANCE_SIGNALS } from '@nessy-agent/shared/marketplace/relevance'
import { useAppShellContext } from '@/context/AppShellContext'
import { usePluginConfigurationPrompt } from '@/hooks/usePluginConfigurationPrompt'
import { usePluginInstallChecklist } from '@/hooks/usePluginInstallChecklist'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { capabilityRouteId } from '@/lib/capability-catalog'
import { sourceListSkillId } from '@/lib/source-list-ids'
import {
  MarketplaceBrowsePage,
  type MarketplaceBrowseSection,
  type MarketplaceBrowseStatus,
} from '@/components/marketplace/MarketplaceBrowsePage'
import { MarketplaceAddDialog, type MarketplaceAddSubmit } from '@/components/marketplace/MarketplaceAddDialog'
import type { MarketplaceInstalledEntry } from '@/components/marketplace/MarketplaceInstalledStrip'
import { MarketplaceDetail } from '@/components/marketplace/MarketplaceDetail'
import type { CapabilityContentPanelProps } from '@/components/info/CapabilityContentPanel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PluginComponentsSection, type PluginComponentGroup } from '@/components/info/PluginComponentsSection'
import { toDeclaredKinds, toGroups } from './plugin-components-groups'
import { deriveInstallState, installNotesNotice, installOutcomeFor, isInstallable, type InstallOutcome } from './plugin-install-state'
import { PluginUpdateBadge, PluginUpdateStalledBadge, offersPluginUpdate, pluginUpdateVersion, reportPluginActivation, resolvePluginRefreshSafe, runPluginUpdate } from './plugin-update-affordance'
import {
  browseTenantFilter,
  marketplaceListingIdentity,
  useMarketplaceItems,
  useMarketplaceRegistries,
  useTenantVocabulary,
  type MarketplaceItemsQueryContext,
  type SafeMarketplaceCatalogItem,
} from '@/hooks/useMarketplaceItems'
import {
  BUILT_IN_MARKETPLACE_FILTER_ID,
  PAGE_RENDER_STEP,
  browseSectionCounts,
  browseShowingNoteKey,
  browseSelectionForInstallLink,
  buildMarketplaceFilterOptions,
  capListForRender,
  filterItemsForMarketplace,
  pinSuggestedItems,
  isBuiltInMarketplace,
  marketplaceKindAvailability,
  nextMarketplaceFilterAfterRemove,
  shouldShowMarketplaceFilter,
  type BrowseSectionCounts,
} from './plugin-marketplace-filter'
import { REGISTRY_LOAD_ERROR_FALLBACK_KEY, registryLoadErrorMessageKey, registryLoadFailuresElsewhere } from './plugin-registry-load-error'
import { pendingPluginInstallAtom } from '@/atoms/plugin-install-link'
import {
  addRegistryPayload,
  describeInstallOutcome,
  installScopeTarget,
  useMarketplaceAddRegistry,
  useMarketplaceDisable,
  useMarketplaceEnable,
  useMarketplaceEnableOffer,
  useMarketplaceInstall,
  useMarketplaceRemoveRegistry,
  useMarketplaceSetRegistryAutoUpdate,
  useMarketplaceRepair,
  useMarketplaceRefresh,
  useMarketplaceSetCapabilityEnabled,
  useMarketplaceUninstall,
  useMarketplaceUpdate,
  useMarketplaceUpgradeRegistry,
} from '@/hooks/useMarketplaceInstall'
import type {
  SafeCapabilityContextRef,
  SafeMarketplaceItemKind,
  SafeMarketplaceListKind,
  SafeMarketplacePluginDeferredCapability,
  SafeMarketplacePluginInstallProposal,
  SafeMarketplaceSort,
  SafePluginActivationTarget,
} from '@nessy-agent/shared/protocol/capabilities'
import type { PluginScope } from '@nessy-agent/shared/plugins/types'
import {
  PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY,
  PLUGIN_INSTALL_SCOPE_OFFERS,
} from '@nessy-agent/shared/plugins/types'
import { CREATE_PLUGIN_PROMPT } from '@nessy-agent/shared/prompts/create-plugin'
import { CREATE_SKILL_PROMPT } from '@nessy-agent/shared/prompts/create-skill'

// Codex-style browse defaults to the popularity sort; the earlier sort/
// capability/phase filter controls are dropped by the presentation swap (the
// approved browse design carries only tabs + search — U5 Step 1).
const DEFAULT_SORT: SafeMarketplaceSort = 'installs'
// P6.414 — the product's own scope vocabulary, offered at install rather than
// guessed from the listing's kind. A fourth `PluginScope` is then a compile
// error in `PLUGIN_INSTALL_SCOPE_COPY` until it has a label, and it appears in
// this picker without a second edit here.
type ActivationScope = PluginScope

export default function PluginsPage() {
  const { t, i18n } = useTranslation()
  const { activeWorkspaceId, capabilityContext, openNewChat, refreshPluginState } = useAppShellContext()
  const hasProjectContext = Boolean(capabilityContext && ('sessionId' in capabilityContext || 'projectHandleId' in capabilityContext))
  const activeSessionId = capabilityContext && 'sessionId' in capabilityContext ? capabilityContext.sessionId : null
  const store = useStore()
  // P2.8 — the third install-summary state. An install/update is SAFE to report
  // as "Plugin is now active" only when the active session is BETWEEN TURNS:
  // that is the same fact the server's between-turns gate reads before it eagerly
  // refreshes an idle session (`SessionManager.invalidatePluginRuntimeForSession`
  // → `managed.isProcessing`). Mid-turn the server defers the refresh, so the
  // summary falls back to the needs-refresh affordance. Read lazily at call time
  // so the page does not re-render on every `isProcessing` flip, and never a
  // second refresh — the manage RPC's `afterPluginMutation` owns the refresh.
  const isRefreshSafe = useCallback(
    () => !(activeSessionId && store.get(sessionMetaMapAtom).get(activeSessionId)?.isProcessing === true),
    [activeSessionId, store],
  )
  // P2.107 — prefer the SERVER's own verdict over the derivation above.
  //
  // `isRefreshSafe()` mirrors only the FIRST operand of the server's
  // between-turns gate (`managed.isProcessing || managed.agent.isProcessing()`),
  // so in the window where the host flag is already false while the agent is
  // still winding down, the summary could claim "Plugin is now active" a beat
  // before the refresh applied. `result.runtimeRefresh` is what
  // `afterPluginMutation` actually did, decided behind the same tail that
  // serialises the refresh. Absent means the server cannot say (the refresh
  // failed soft), and then — and only then — the local derivation stands in,
  // with its conservative needs-refresh default underneath it.
  const isRefreshSafeFor = useCallback(
    (runtimeRefresh?: 'applied' | 'deferred' | 'reloaded' | 'failed') => resolvePluginRefreshSafe(runtimeRefresh, isRefreshSafe),
    [isRefreshSafe],
  )
  const [kind, setKind] = useState<SafeMarketplaceListKind>('skills')
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query.trim(), 250)
  const [selectedItem, setSelectedItem] = useState<SafeMarketplaceCatalogItem | null>(null)
  // Marketplace skill-preview MODAL (U5 Step 3): a not-yet-installed plugin's
  // skill has no routed capability page, so its inventory row opens this modal.
  // We hold the component key + display name; the SKILL.md body is NOT available
  // pre-install (the safe data layer carries no inline preview and there is no
  // renderer-side preview RPC), so the panel shows an honest empty state.
  const [url, setUrl] = useState('')
  const [proposal, setProposal] = useState<SafeMarketplacePluginInstallProposal | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [isProposingUrl, setIsProposingUrl] = useState(false)
  const [mcpbProposal, setMcpbProposal] = useState<SafeMarketplacePluginInstallProposal | null>(null)
  const [mcpbInstallOpen, setMcpbInstallOpen] = useState(false)
  const [isPickingMcpb, setIsPickingMcpb] = useState(false)
  const [needsRuntimeRefresh, setNeedsRuntimeRefresh] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingCapabilityId, setPendingCapabilityId] = useState<string | undefined>()
  // Preserve immediate mutation feedback locally; after catalog refresh the
  // same affordance is reconstructed from SafeInstalledPluginSummary's
  // persisted, path-free compatibility report.
  const [installOutcomes, setInstallOutcomes] = useState<Record<string, InstallOutcome>>({})
  // P6.414 — the pending install-scope offer. `null` is "nothing is being
  // installed"; a value is the item plus the currently selected scope, so the
  // dialog is the only place the scope is decided.
  const [installScopeOffer, setInstallScopeOffer] = useState<{
    item: SafeMarketplaceCatalogItem
    scope: ActivationScope
  } | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // R3: bring-your-own registry surfaces — the Create ▾ menu, the Add-marketplace
  // dialog, the pending upgrade (per-registry spinner), and the remove-confirm.
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [addRegistryOpen, setAddRegistryOpen] = useState(false)
  // Repository-URL install lives in a Create ▾ dialog (not an always-visible
  // block at the bottom of the browse list).
  const [urlInstallOpen, setUrlInstallOpen] = useState(false)
  const [upgradingRegistryId, setUpgradingRegistryId] = useState<string | null>(null)
  const [removeRegistry, setRemoveRegistry] = useState<{ marketplaceId: string; name: string } | null>(null)
  // Marketplace-first browse: the selected marketplace (built-in Skills Market
  // or one bring-your-own registry — NO cross-market "All") + the client-side
  // render cap that grows on the existing load-more sentinel. Default = the
  // built-in Skills Market; the selection persists for the session.
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>(BUILT_IN_MARKETPLACE_FILTER_ID)
  // P6.512 — the parcel an install deep link left behind, consumed once below.
  const [pendingPluginInstall, setPendingPluginInstall] = useAtom(pendingPluginInstallAtom)
  const [renderLimit, setRenderLimit] = useState<number>(PAGE_RENDER_STEP)
  // F1 — the tenant the browse list is narrowed to (`tenant=` on `/v1/skills`),
  // or null for the whole catalog. Only ever set to a value the vocabulary below
  // offers; see `browseTenantFilter`.
  const [tenantFilter, setTenantFilter] = useState<string | null>(null)

  // The kind actually browsed/fetched: the built-in Skills Market honors the
  // user's tab (its plugins + skills endpoints); a registry exposes no skills
  // endpoint today, so it always browses Plugins. Decided WITHOUT loaded items
  // (breaking the fetch↔items cycle); the data-driven `marketplaceAvailability`
  // below governs which tabs render + why the Skills tab is disabled.
  const effectiveKind: SafeMarketplaceListKind = isBuiltInMarketplace(marketplaceFilter) ? kind : 'plugins'

  // `tenant` is a `/v1/skills` parameter: the built-in Skills Market's skills
  // list is the only browsed set it narrows, so the control (and the parameter)
  // stay out of the Plugins tab and out of a bring-your-own registry.
  const supportsTenantFilter = effectiveKind === 'skills' && isBuiltInMarketplace(marketplaceFilter)
  const activeTenant = supportsTenantFilter ? tenantFilter : null

  const queryContext = useMemo<MarketplaceItemsQueryContext>(() => ({
    kind: effectiveKind,
    ...(debouncedQuery ? { query: debouncedQuery } : {}),
    sort: DEFAULT_SORT,
    ...(activeTenant ? { tenants: [activeTenant] } : {}),
    ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
    ...(activeSessionId ? { sessionId: activeSessionId } : {}),
  }), [activeSessionId, activeTenant, activeWorkspaceId, debouncedQuery, effectiveKind])

  const marketplace = useMarketplaceItems(queryContext)
  /**
   * P6.245 — the administrator's own pre-install trust sentence.
   *
   * `settings-reference.md#plugintrustmessage`: "Add your organization's own
   * text to the plugin trust warning Claude Code shows before installation."
   * The vendored runtime renders it in the CLI's interactive UI, which this fork
   * never shows, so the host renders it — the same sentence on all three
   * runtimes, on the confirmation the user actually meets.
   *
   * Taken from the LAST page for the reason `registryLoadErrors` is: it
   * describes the whole list, not one row. Undefined with no managed value, so a
   * fleet with no policy sees exactly what it saw before.
   */
  const managedTrustMessage = marketplace.data?.pages.at(-1)?.pluginTrustMessage
  // F1 — the filter's vocabulary. `/v1/skills/facets` publishes the full 457
  // tenants, but that endpoint has no wire to the renderer (see the row note),
  // so the options are the tenants the loaded rows carry: every one of them
  // provably has at least one row, which is what makes the 0-row selection the
  // facets vocabulary would otherwise permit unreachable here.
  const tenantVocabulary = useTenantVocabulary(marketplace.loadedTenants, `${effectiveKind}|${marketplaceFilter}`)
  const { registries, offers, isLoading: registriesLoading } = useMarketplaceRegistries()
  const installMutation = useMarketplaceInstall(activeWorkspaceId)
  const enableMutation = useMarketplaceEnable(activeWorkspaceId)
  const disableMutation = useMarketplaceDisable(activeWorkspaceId)
  const uninstallMutation = useMarketplaceUninstall(activeWorkspaceId)
  const repairMutation = useMarketplaceRepair(activeWorkspaceId)
  const updateMutation = useMarketplaceUpdate(activeWorkspaceId)
  const refreshMutation = useMarketplaceRefresh(activeWorkspaceId)
  const setCapabilityEnabledMutation = useMarketplaceSetCapabilityEnabled(activeWorkspaceId)
  const addRegistryMutation = useMarketplaceAddRegistry()
  const upgradeRegistryMutation = useMarketplaceUpgradeRegistry()
  const removeRegistryMutation = useMarketplaceRemoveRegistry()
  const setRegistryAutoUpdateMutation = useMarketplaceSetRegistryAutoUpdate()
  const enableOfferMutation = useMarketplaceEnableOffer()

  const refreshAfterMarketplaceMutation = useCallback(async (options: { needsRuntimeRefresh?: boolean } = {}) => {
    await marketplace.refetch()
    await refreshPluginState?.()
    setNeedsRuntimeRefresh(options.needsRuntimeRefresh ?? true)
  }, [marketplace, refreshPluginState])

  // `plugins/components.md#when-the-configuration-dialog-appears` — the enable-time configuration prompt, shared
  // with every other enable path through the same controller.
  const configurationPrompt = usePluginConfigurationPrompt(refreshPluginState)

  // T3 (plugin-install plan § 4): install ends in a setup checklist, not
  // silence. Consumes the install result's `pendingAuth`/`authRequirements`/
  // `configuration`; dp sign-in and the userConfig dialog are actionable,
  // connector rows point at the session-start notice (§ 0b-2, no chaining).
  const installChecklist = usePluginInstallChecklist({
    onConfigure: context => {
      configurationPrompt.offer(
        // Install-with-activation IS an enable (T2), so the checklist raises
        // the same enable-shaped result the enable RPC would have carried.
        { ok: true, pluginKey: context.pluginKey, action: 'enable', configuration: context.configuration },
        {
          pluginKey: context.pluginKey,
          workspaceId: context.workspaceId,
          ...(context.displayName ? { displayName: context.displayName } : {}),
        },
      )
    },
    onAuthCompleted: () => refreshAfterMarketplaceMutation({ needsRuntimeRefresh: false }),
  })

  // Which kind tabs the selected marketplace offers (data-driven from loaded
  // item kinds; the built-in Skills Market always offers both). Drives the
  // scoped Plugins|Skills tabs + the disabled-Skills note for a registry.
  const marketplaceAvailability = useMemo(
    () => marketplaceKindAvailability(marketplaceFilter, marketplace.items),
    [marketplaceFilter, marketplace.items],
  )

  // Narrow the loaded rows to the selected marketplace, then cap how many
  // render at once (lightweight, no windowing lib). `hasMoreToReveal` grows the
  // client-side slice first; only once exhausted does the sentinel fetch the
  // next server page.
  const filteredItems = useMemo(
    // `plugins/org.md#recommend-plugins` — the pin runs BEFORE `capListForRender`, so a
    // suggested row can never land outside the render window.
    () => pinSuggestedItems(filterItemsForMarketplace(marketplace.items, marketplaceFilter)),
    [marketplace.items, marketplaceFilter],
  )
  const renderWindow = useMemo(() => capListForRender(filteredItems, renderLimit), [filteredItems, renderLimit])
  // sev-4 — how many LOADED rows the chip filtered out, i.e. the rows the other
  // marketplace chips hold for this same query. The server's `total` counts them
  // (`service.ts:mergeRegistryItems` adds each registry's merged rows to the
  // Skills Market's own total), so the browse note needs this number both to
  // scope its denominator and to say that those rows are one chip away.
  const otherMarketplaceRows = Math.max(0, marketplace.items.length - filteredItems.length)
  const hasMoreToReveal = renderWindow.hasMoreToReveal
  const canLoadMore = hasMoreToReveal || marketplace.hasNextPage

  // Reset the render cap whenever the browsed set changes (marketplace/kind/
  // search/tenant).
  useEffect(() => {
    setRenderLimit(PAGE_RENDER_STEP)
  }, [activeTenant, effectiveKind, debouncedQuery, marketplaceFilter])

  const onReachListEnd = useCallback(() => {
    if (hasMoreToReveal) {
      setRenderLimit(limit => limit + PAGE_RENDER_STEP)
    } else if (marketplace.hasNextPage && !marketplace.isFetchingNextPage) {
      void marketplace.fetchNextPage()
    }
  }, [hasMoreToReveal, marketplace])

  useEffect(() => {
    const target = sentinelRef.current
    if (!target || !canLoadMore) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) onReachListEnd()
    }, { rootMargin: '240px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [canLoadMore, onReachListEnd])

  const onInstall = useCallback(async (item: SafeMarketplaceCatalogItem, scope: ActivationScope = defaultInstallScope(item, hasProjectContext)) => {
    setActionError(null)
    try {
      const requestedTarget = activationTarget(scope, activeWorkspaceId, capabilityContext)
      const result = await installMutation.mutateAsync({
        source: {
          kind: 'listing',
          marketplaceId: marketplaceIdFor(item),
          listingId: item.id,
          listingKind: item.listKind,
        },
        ...(requestedTarget ? { activateIn: requestedTarget } : {}),
      })
      const outcome = describeInstallOutcome(result, requestedTarget ?? undefined)
      if (result.pluginKey && (outcome.blocked || outcome.needsConfirmEnable)) {
        setInstallOutcomes(previous => ({
          ...previous,
          [result.pluginKey!]: { ...outcome, deferred: result.deferred ?? [] },
        }))
      }
      // A blocked install never has a usable capability — its own banner
      // already explains why; a plain "installed" success toast alongside it
      // would read as contradictory feedback.
      let needsRuntimeRefresh = true
      if (!outcome.blocked) {
        // P2.8 — report the third install-summary state: "Plugin is now active"
        // between turns, else the reload notice. Routed through the flow module
        // so the notice keys stay out of this page (trap 1).
        // P2.107 — and "between turns" is now the SERVER's answer when it gave
        // one, not this page's re-derivation of it.
        // P6.412 — the third state. `'reloaded'` means the live session took the
        // RUNTIME'S OWN plugin reload rather than a teardown, so the plugin is
        // live in the session the user is looking at — and the notice names what
        // that reload costs on the next request.
        const summary = reportPluginActivation(t('plugins.toastInstalled'), isRefreshSafeFor(result.runtimeRefresh), {
          notify: { success: (title, options) => toast.success(title, options) },
          t,
        }, result.runtimeRefresh === 'reloaded', result.runtimeRefresh === 'failed') // F1.396 — a live session's refresh failed
        needsRuntimeRefresh = summary.needsRuntimeRefresh
        // P2.155 — after the success toast, never instead of it: the adapter's
        // persisted warnings are what the importer dropped, and they are
        // informational, so they ride their own notice and gate nothing.
        const notes = installNotesNotice(result, t)
        if (notes) toast.warning(notes.title, { description: notes.description })
        // T3: a successful install that still needs setup raises the
        // checklist; a fully-ready install stays as quiet as before.
        installChecklist.offer(result, {
          pluginKey: result.pluginKey,
          workspaceId: activeWorkspaceId,
          displayName: item.name,
        })
      } else if (!result.pluginKey) {
        // A fresh install the server blocked has no pluginKey to key the
        // per-plugin banner on — without this, a blocked-from-the-start
        // install would leave the user with no banner, no success toast
        // (suppressed above), and no error toast (no exception thrown).
        const message = blockedInstallMessage(t, result.deferred, result.diagnosticCodes)
        setActionError(message)
        toast.error(t('plugins.errorInstallBlocked'), { description: item.name })
      }
      await refreshAfterMarketplaceMutation({ needsRuntimeRefresh })
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorInstall'))
      setActionError(message)
      toast.error(t('plugins.errorInstall'), { description: message })
    }
  }, [activeWorkspaceId, capabilityContext, hasProjectContext, installChecklist, installMutation, isRefreshSafeFor, refreshAfterMarketplaceMutation, t])

  /**
   * P6.414 — every install path now ASKS. `defaultInstallScope` survives as the
   * pre-selection only: the row exists because the renderer used to derive a
   * scope from the listing's kind and install without saying so.
   *
   * A pre-selection whose target is unreachable here (no workspace open, no
   * project context) would open the dialog on a disabled row, so it falls back
   * to the first offer that CAN be targeted — widest-first, which is
   * `user/global` in every configuration.
   */
  const offerableScope = useCallback((preferred: ActivationScope): ActivationScope => {
    if (activationTarget(preferred, activeWorkspaceId, capabilityContext)) return preferred
    const fallback = PLUGIN_INSTALL_SCOPE_OFFERS
      .find(offer => activationTarget(offer.scope, activeWorkspaceId, capabilityContext))
    return fallback?.scope ?? preferred
  }, [activeWorkspaceId, capabilityContext])

  const requestInstall = useCallback((item: SafeMarketplaceCatalogItem) => {
    setInstallScopeOffer({ item, scope: offerableScope(defaultInstallScope(item, hasProjectContext)) })
  }, [hasProjectContext, offerableScope])

  const onConfirmInstallScope = useCallback(async () => {
    const pending = installScopeOffer
    if (!pending) return
    setInstallScopeOffer(null)
    await onInstall(pending.item, pending.scope)
  }, [installScopeOffer, onInstall])

  const clearInstallOutcome = useCallback((pluginKey: string) => {
    setInstallOutcomes(previous => {
      if (!(pluginKey in previous)) return previous
      const { [pluginKey]: _dropped, ...rest } = previous
      return rest
    })
  }, [])

  const onConfirmEnable = useCallback(async (
    item: SafeMarketplaceCatalogItem,
    target: SafePluginActivationTarget,
  ) => {
    if (!item.installed) return
    setActionError(null)
    try {
      const result = await enableMutation.mutateAsync({
        pluginKey: item.installed.pluginKey,
        action: 'enable',
        target,
      })
      // `plugins/components.md#when-the-configuration-dialog-appears` — ask for the plugin's options at enable
      // rather than letting the user meet the failure at first use.
      configurationPrompt.offer(result, {
        pluginKey: item.installed.pluginKey,
        workspaceId: activeWorkspaceId,
        displayName: item.name,
      })
      // Confirmed: drop the transient partial-install affordance for this plugin.
      clearInstallOutcome(item.installed.pluginKey)
      toast.success(t('plugins.toastEnabled'), { description: item.name })
      await refreshAfterMarketplaceMutation()
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorEnable'))
      setActionError(message)
      toast.error(t('plugins.errorEnable'), { description: message })
    }
  }, [activeWorkspaceId, clearInstallOutcome, configurationPrompt, enableMutation, refreshAfterMarketplaceMutation, t])

  const onEnable = useCallback(async (item: SafeMarketplaceCatalogItem, scope: ActivationScope) => {
    await onConfirmEnable(
      item,
      requireActivationTarget(scope, activeWorkspaceId, capabilityContext),
    )
  }, [activeWorkspaceId, capabilityContext, onConfirmEnable])

  const onDisable = useCallback(async (item: SafeMarketplaceCatalogItem, scope: ActivationScope) => {
    if (!item.installed) return
    setActionError(null)
    try {
      await disableMutation.mutateAsync({
        pluginKey: item.installed.pluginKey,
        action: 'disable',
        target: requireActivationTarget(scope, activeWorkspaceId, capabilityContext),
      })
      toast.success(t('plugins.toastDisabled'), { description: item.name })
      await refreshAfterMarketplaceMutation()
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorDisable'))
      setActionError(message)
      toast.error(t('plugins.errorDisable'), { description: message })
    }
  }, [activeWorkspaceId, capabilityContext, disableMutation, refreshAfterMarketplaceMutation, t])

  const onUninstall = useCallback(async (item: SafeMarketplaceCatalogItem) => {
    if (!item.installed) return
    setActionError(null)
    try {
      await uninstallMutation.mutateAsync({
        pluginKey: item.installed.pluginKey,
        action: 'uninstall',
      })
      // The transient blocked/needsConfirmEnable outcome belonged to this
      // now-gone install; never let it leak onto a later install that
      // happens to reuse the same pluginKey.
      clearInstallOutcome(item.installed.pluginKey)
      toast.success(t('plugins.toastUninstalled'), { description: item.name })
      await refreshAfterMarketplaceMutation()
      if (selectedItem && marketplaceListingIdentity(selectedItem) === marketplaceListingIdentity(item)) setSelectedItem(null)
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorUninstall'))
      setActionError(message)
      toast.error(t('plugins.errorUninstall'), { description: message })
    }
  }, [clearInstallOutcome, refreshAfterMarketplaceMutation, selectedItem, t, uninstallMutation])

  const onRepair = useCallback(async (item: SafeMarketplaceCatalogItem) => {
    if (!item.installed) return
    setActionError(null)
    try {
      const result = await repairMutation.mutateAsync({
        pluginKey: item.installed.pluginKey,
        action: 'repair',
      })
      if (!result.ok) {
        const message = t('plugins.errorRepair')
        setActionError(message)
        toast.error(message, { description: item.name })
        return
      }
      if (result.state === 'partial' && result.requiresConfirmation) {
        setInstallOutcomes(previous => ({
          ...previous,
          [item.installed!.pluginKey]: {
            blocked: false,
            needsConfirmEnable: true,
            deferred: result.deferred ?? [],
          },
        }))
      }
      toast.success(t('plugins.toastRepaired'), { description: item.name })
      await refreshAfterMarketplaceMutation()
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorRepair'))
      setActionError(message)
      toast.error(t('plugins.errorRepair'), { description: message })
    }
  }, [refreshAfterMarketplaceMutation, repairMutation, t])

  // R82 — the manual per-plugin update. The flow (including the
  // `plugins/cli-reference.md#reload-plugins` reload notice a SUCCESSFUL update owes the user)
  // lives in `runPluginUpdate`; this only feeds it the page's own effects.
  const onUpdate = useCallback(async (item: SafeMarketplaceCatalogItem) => {
    if (!item.installed) return
    setActionError(null)
    const pluginKey = item.installed.pluginKey
    const outcome = await runPluginUpdate({ pluginKey, name: item.name }, {
      update: request => updateMutation.mutateAsync(request),
      notify: {
        success: (title, options) => toast.success(title, options),
        error: (title, options) => toast.error(title, options),
      },
      t,
      describeError: error => errorMessage(error, t('plugins.errorUpdate')),
      refreshSafe: isRefreshSafe(),
    })
    if (outcome.errorMessage) setActionError(outcome.errorMessage)
    if (outcome.needsConfirmEnable) {
      setInstallOutcomes(previous => ({
        ...previous,
        [pluginKey]: { blocked: false, needsConfirmEnable: true, deferred: outcome.deferred },
      }))
    }
    // P2.8 — when the update activated in the running session (between turns) the
    // summary already said "now active"; only keep the Refresh-runtime affordance
    // when the server deferred to the turn boundary.
    if (outcome.ok) await refreshAfterMarketplaceMutation({ needsRuntimeRefresh: outcome.needsRuntimeRefresh })
  }, [isRefreshSafe, refreshAfterMarketplaceMutation, t, updateMutation])

  const onRuntimeRefresh = useCallback(async () => {
    setActionError(null)
    try {
      // P6.563 — report the SERVER's verdict. Before this the button reached no
      // server at all and this toast asserted a runtime refresh unconditionally;
      // `untouched` keeps the old wording because that is what it truthfully
      // described — the catalog queries refreshed and no runtime was touched.
      const verdict = await refreshMutation.mutateAsync()
      await refreshAfterMarketplaceMutation({ needsRuntimeRefresh: false })
      toast.success(t(
        verdict === 'applied' ? 'plugins.toastRefreshedApplied'
        : verdict === 'deferred' ? 'plugins.toastRefreshedDeferred'
        : 'plugins.toastRefreshed',
      ))
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorRefresh'))
      setActionError(message)
      toast.error(t('plugins.errorRefresh'), { description: message })
    }
  }, [refreshAfterMarketplaceMutation, refreshMutation, t])

  const onTryInChat = useCallback(async (item: SafeMarketplaceCatalogItem) => {
    try {
      if (!openNewChat) {
        toast.error(t('plugins.errorTryInChat'))
        return
      }
      const locale = i18n.resolvedLanguage ?? i18n.language
      const input = locale.toLowerCase().startsWith('ru')
        ? `Расскажи, что ты умеешь с ${item.name}, и предложи первую полезную задачу.`
        : `Tell me what you can do with ${item.name} and suggest a useful first task.`
      await openNewChat({ input, name: item.name })
      toast.success(t('plugins.toastTryInChat'), { description: item.name })
    } catch (error) {
      toast.error(t('plugins.errorTryInChat'), { description: errorMessage(error, t('plugins.errorTryInChat')) })
    }
  }, [i18n.language, i18n.resolvedLanguage, openNewChat, t])

  const onProposeUrl = useCallback(async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setIsProposingUrl(true)
    setProposal(null)
    setUrlError(null)
    try {
      const next = await window.electronAPI.marketplace.proposeInstall({ sourceUrl: trimmed })
      setProposal(next)
      if (next.status === 'unsupported') {
        setUrlError(next.diagnosticCodes.join('\n') || t('plugins.urlUnsupported'))
      }
    } catch (error) {
      setUrlError(errorMessage(error, t('plugins.urlUnsupported')))
    } finally {
      setIsProposingUrl(false)
    }
  }, [t, url])

  const installProposal = useCallback(async (candidate: SafeMarketplacePluginInstallProposal): Promise<boolean> => {
    if (candidate.status !== 'installable') return false
    setActionError(null)
    try {
      const requestedTarget = requireActivationTarget(
        hasProjectContext ? 'project' : 'workspace',
        activeWorkspaceId,
        capabilityContext,
      )
      const result = await installMutation.mutateAsync({
        source: { kind: 'proposal', proposalId: candidate.proposalId },
        activateIn: requestedTarget,
      })
      const outcome = describeInstallOutcome(result, requestedTarget)
      if (outcome.blocked) {
        const message = blockedInstallMessage(t, result.deferred, result.diagnosticCodes)
        setActionError(message)
        toast.error(t('plugins.errorInstallBlocked'), { description: candidate.displaySource })
        await refreshAfterMarketplaceMutation()
        return false
      }
      if (result.pluginKey && outcome.needsConfirmEnable) {
        setInstallOutcomes(previous => ({
          ...previous,
          [result.pluginKey!]: { ...outcome, deferred: result.deferred ?? [] },
        }))
      }
      // P2.8 — the third install-summary state for URL/MCPB proposal installs.
      // P2.107 — decided by the server's verdict when it gave one.
      // P6.412 — the same third state on the proposal path.
      const summary = reportPluginActivation(t('plugins.toastInstalled'), isRefreshSafeFor(result.runtimeRefresh), {
        notify: { success: (title, options) => toast.success(title, options) },
        t,
      }, result.runtimeRefresh === 'reloaded', result.runtimeRefresh === 'failed') // F1.396
      // P2.155 — the same install-success reader on the proposal path, for the
      // same reason: a dropped declaration the user is never told about is the
      // defect, and which install flow found it is irrelevant.
      const notes = installNotesNotice(result, t)
      if (notes) toast.warning(notes.title, { description: notes.description })
      // T3: URL/MCPB proposal installs get the same setup checklist.
      installChecklist.offer(result, {
        pluginKey: result.pluginKey,
        workspaceId: activeWorkspaceId,
        displayName: candidate.displaySource,
      })
      await refreshAfterMarketplaceMutation({ needsRuntimeRefresh: summary.needsRuntimeRefresh })
      return true
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorInstall'))
      setActionError(message)
      toast.error(t('plugins.errorInstall'), { description: message })
      return false
    }
  }, [activeWorkspaceId, capabilityContext, hasProjectContext, installChecklist, installMutation, isRefreshSafeFor, refreshAfterMarketplaceMutation, t])

  const onInstallProposal = useCallback(async () => {
    if (!proposal || !await installProposal(proposal)) return
    setUrlInstallOpen(false)
    setUrl('')
    setProposal(null)
    setUrlError(null)
  }, [installProposal, proposal])

  const onPickMcpb = useCallback(async () => {
    setCreateMenuOpen(false)
    setIsPickingMcpb(true)
    try {
      const next = await window.electronAPI.marketplace.proposeMcpb()
      if (!next) return
      if (next.status === 'unsupported') {
        toast.error(t('plugins.mcpbUnsupported'), { description: next.diagnosticCodes.join('\n') })
        return
      }
      setMcpbProposal(next)
      setMcpbInstallOpen(true)
    } catch (error) {
      toast.error(t('plugins.mcpbUnsupported'), { description: errorMessage(error, t('plugins.mcpbUnsupported')) })
    } finally {
      setIsPickingMcpb(false)
    }
  }, [t])

  const onInstallMcpbProposal = useCallback(async () => {
    if (!mcpbProposal || !await installProposal(mcpbProposal)) return
    setMcpbInstallOpen(false)
    setMcpbProposal(null)
  }, [installProposal, mcpbProposal])

  // ── C2: Create plugin (creator macro) ─────────────────────────────────────
  // Opens a VISIBLE new chat seeded with the shared CREATE_PLUGIN_PROMPT
  // constant (same openNewChat deep-link path as "Try in chat" — NOT a hidden
  // session). The agent interviews the user and scaffolds + locally installs
  // the plugin through the NORMAL permission-gated Write + existing install
  // path; no new tool, no elevated access.
  const onCreatePlugin = useCallback(async () => {
    setCreateMenuOpen(false)
    if (!openNewChat) {
      toast.error(t('plugins.errorCreatePlugin'))
      return
    }
    try {
      await openNewChat({ input: CREATE_PLUGIN_PROMPT, name: t('plugins.createPlugin') })
    } catch (error) {
      toast.error(t('plugins.errorCreatePlugin'), { description: errorMessage(error, t('plugins.errorCreatePlugin')) })
    }
  }, [openNewChat, t])

  // Create skill = same creator-macro pattern, seeded with the shared
  // CREATE_SKILL_PROMPT (skill-creator guide). The Create menu's first item
  // follows the active tab (Skills → this; Plugins → onCreatePlugin).
  const onCreateSkill = useCallback(async () => {
    setCreateMenuOpen(false)
    if (!openNewChat) {
      toast.error(t('plugins.errorCreateSkill'))
      return
    }
    try {
      await openNewChat({ input: CREATE_SKILL_PROMPT, name: t('plugins.createSkill') })
    } catch (error) {
      toast.error(t('plugins.errorCreateSkill'), { description: errorMessage(error, t('plugins.errorCreateSkill')) })
    }
  }, [openNewChat, t])

  // ── R3: bring-your-own registry actions ───────────────────────────────────
  // {source, gitRef, sparsePaths} → refName. The add only RECORDS; the server clones on the next list.
  const onAddRegistry = useCallback(async (value: MarketplaceAddSubmit) => {
    setActionError(null)
    try {
      const result = await addRegistryMutation.mutateAsync(addRegistryPayload(value))
      setAddRegistryOpen(false)
      toast.success(t('plugins.toastMarketplaceAdded'), { description: result.displayName })
      await refreshAfterMarketplaceMutation({ needsRuntimeRefresh: false })
      setMarketplaceFilter(result.marketplaceId) // F1.81: its section says "loading", then why it failed
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorAddMarketplace'))
      setActionError(message)
      toast.error(t('plugins.errorAddMarketplace'), { description: message })
    }
  }, [addRegistryMutation, refreshAfterMarketplaceMutation, t])

  const onUpgradeRegistry = useCallback(async (marketplaceId: string) => {
    setUpgradingRegistryId(marketplaceId)
    try {
      await applyRegistryUpgrade(marketplaceId, {
        upgrade: ref => upgradeRegistryMutation.mutateAsync(ref),
        toastSuccess: title => toast.success(title),
        toastError: (title, description) => toast.error(title, { description }),
        setActionError,
        refresh: () => refreshAfterMarketplaceMutation({ needsRuntimeRefresh: false }),
      }, t)
    } finally {
      setUpgradingRegistryId(null)
    }
  }, [refreshAfterMarketplaceMutation, t, upgradeRegistryMutation])

  const onConfirmRemoveRegistry = useCallback(async () => {
    if (!removeRegistry) return
    const { marketplaceId, name } = removeRegistry
    setActionError(null)
    try {
      await removeRegistryMutation.mutateAsync({ marketplaceId })
      setRemoveRegistry(null)
      // Removing the active filter's registry falls the browse view back to All.
      setMarketplaceFilter(current => nextMarketplaceFilterAfterRemove(current, marketplaceId))
      toast.success(t('plugins.toastMarketplaceRemoved'), { description: name })
      await refreshAfterMarketplaceMutation({ needsRuntimeRefresh: false })
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorRemoveMarketplace'))
      setActionError(message)
      toast.error(t('plugins.errorRemoveMarketplace'), { description: message })
    }
  }, [refreshAfterMarketplaceMutation, removeRegistry, removeRegistryMutation, t])

  // `plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace` — Enable/Disable auto-update for ONE marketplace.
  // The effective value comes from the server (managed → user toggle → default
  // polarity), so the renderer only ever sends the flip it was shown.
  const onToggleRegistryAutoUpdate = useCallback(async (marketplaceId: string, autoUpdate: boolean) => {
    setActionError(null)
    try {
      await setRegistryAutoUpdateMutation.mutateAsync({ marketplaceId, autoUpdate })
      toast.success(autoUpdate ? t('plugins.toastAutoUpdateEnabled') : t('plugins.toastAutoUpdateDisabled'))
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorSetAutoUpdate'))
      setActionError(message)
      toast.error(t('plugins.errorSetAutoUpdate'), { description: message })
    }
  }, [setRegistryAutoUpdateMutation, t])

  // P6.517 / P6.518 — one click turns a DELIVERED-but-off catalog on. The name
  // is all that travels; the source is pinned server-side, so this cannot be
  // aimed. On success the offer disappears from `listRegistries().available`
  // and reappears as a real chip, both through the same invalidation.
  const onEnableOffer = useCallback(async (name: string) => {
    setActionError(null)
    try {
      const result = await enableOfferMutation.mutateAsync({ name })
      toast.success(t('plugins.toastMarketplaceAdded'), { description: result.displayName })
      // Deliberately NOT selected here. The registries query is still in flight
      // at this point, so the new id is not yet in `marketplaceFilterOptions` —
      // and the stale-selection effect below would immediately bounce it back to
      // the built-in market, which looks like the click failed. The toast plus
      // the offer turning into a real chip is the confirmation.
      await refreshAfterMarketplaceMutation({ needsRuntimeRefresh: false })
    } catch (error) {
      const message = errorMessage(error, t('plugins.errorAddMarketplace'))
      setActionError(message)
      toast.error(t('plugins.errorAddMarketplace'), { description: message })
    }
  }, [enableOfferMutation, refreshAfterMarketplaceMutation, t])

  // Per-card install progress (Step 2): the id of the card whose listing
  // install is in flight, so ONLY that card shows "Installing…". A listing
  // install carries `source.listingId` (= the card's item.id); URL/proposal
  // installs have no card, so they never mark a browse card installing.
  const installingIdentity = installMutation.isPending && installMutation.variables?.source.kind === 'listing'
    ? marketplaceListingIdentity({
        marketplaceId: installMutation.variables.source.marketplaceId,
        id: installMutation.variables.source.listingId,
      })
    : null

  const isBusy = installMutation.isPending
    || enableMutation.isPending
    || disableMutation.isPending
    || uninstallMutation.isPending
    || repairMutation.isPending
    || updateMutation.isPending
    || refreshMutation.isPending
    || setCapabilityEnabledMutation.isPending

  const activeSubtitle = effectiveKind === 'skills' ? t('plugins.subtitleSkills') : t('plugins.subtitlePlugins')
  const displayedError = actionError ?? (marketplace.error ? marketplace.error.message : null)

  // ── Browse-page presentation (U5) ─────────────────────────────────────────
  // The catalog list + the joined installed inventory come straight from the
  // existing hook; the browse page is a pure PRESENTATION of that safe data —
  // no new RPC, no new datum. Each card's installState is derived renderer-side
  // from safe fields already on the item.

  // Strip-level "manage all" handoff → the Sources ▸ Plugins management LIST
  // (R2: marketplace = supply, Sources = management).
  const onManageInSources = useCallback(() => {
    navigate(routes.view.sourcesPlugins())
  }, [])

  // Per-item handoff (Step 2): clicking an installed tile deep-links to THAT
  // plugin's detail in Sources ▸ Plugins (U4 route `sources/plugins/plugin/
  // <key>` → PluginInfoPage), NOT the old marketplace dialog. The strip is
  // keyed by catalog item id; every installed item carries `installed`, so we
  // resolve the opaque pluginKey the route needs from the joined inventory.
  const onOpenInstalled = useCallback((identity: string) => {
    const pluginKey = marketplace.installedItems.find(item => marketplaceListingIdentity(item) === identity)?.installed?.pluginKey
    if (pluginKey) navigate(routes.view.sourcesPlugins(pluginKey))
  }, [marketplace.installedItems])

  // R83 — the strip is the browse page's map of what is already installed, and
  // it is the surface a user passes through without ever opening a detail page.
  // The tile carries a dot when the wire advertises an update; the sentence
  // (with the version) is the tile's tooltip/accessible name, because a 32 px
  // icon has nowhere to put it. `pluginUpdateVersion` is R81's decision reused,
  // not a second reading of the field.
  const installedEntries = useMemo<MarketplaceInstalledEntry[]>(
    () => marketplace.installedItems.map(item => {
      const updateVersion = pluginUpdateVersion(item.installed)
      return {
        id: marketplaceListingIdentity(item),
        name: item.name,
        icon: iconTileForKind(item.kind),
        ...(updateVersion ? { updateLabel: t('plugins.updateAvailable', { version: updateVersion }) } : {}),
      }
    }),
    [marketplace.installedItems, t],
  )

  const sections = useMemo<MarketplaceBrowseSection[]>(() => {
    const toCard = (item: SafeMarketplaceCatalogItem) => ({
      id: marketplaceListingIdentity(item),
      icon: iconTileForKind(item.kind),
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      ...(pickPresentation(item) ? { presentation: pickPresentation(item)! } : {}),
      ...(item.tenant ? { tenant: item.tenant } : {}),
      // `plugins/org.md#recommend-plugins`'s "suggested for this directory" label. The
      // server sends the SIGNAL; the sentence is chosen (and translated) here.
      //
      // P6.519 — the label names WHICH signal matched, because the two say
      // different things to a reader, and the tooltip names the three signals
      // this fork does not decide. `plugin-relevance.md`'s Note lists five;
      // `cli`, `hosts` and `filesRead` each need a per-session record of
      // commands, hostnames or file reads, which is a privacy and retention
      // posture this fork has not taken. Naming them here is what makes the
      // narrowing visible instead of leaving the user to conclude the feature
      // is broken.
      ...(item.suggestion
        ? {
          suggestionLabel: item.suggestion.signal === 'manifestDeps'
            ? t('plugins.suggestedForDependency')
            : t('plugins.suggestedForDirectory'),
          suggestionDetail: t('plugins.suggestionSignalsUnsupported', {
            signals: UNMATCHABLE_RELEVANCE_SIGNALS.join(', '),
          }),
        }
        : {}),
      installState: deriveInstallState(item, installOutcomes, installingIdentity),
      installLabel: item.kind === 'skill' ? t('plugins.installSkill') : t('plugins.install'),
      installedLabel: t('plugins.statusInstalled'),
      installingLabel: t('plugins.installing'),
      ...(deriveBlockedReason(item, installOutcomes, t) ? { blockedReason: deriveBlockedReason(item, installOutcomes, t)! } : {}),
      onInstall: () => requestInstall(item),
      onOpen: () => setSelectedItem(item),
    })

    // Marketplace-first: `filteredItems`/`renderWindow.visible` are already
    // scoped to the SELECTED marketplace, so this builds exactly ONE section.
    // The built-in Skills Market → the kind-titled catalog section. A registry →
    // its own section (registry-name label + Upgrade/Remove header + load-error
    // note), shown even with zero loaded rows so it stays reachable/removable.
    const visibleRows = renderWindow.visible

    if (isBuiltInMarketplace(marketplaceFilter)) {
      if (visibleRows.length === 0) return []
      return [browseCatalogSection({
        id: `catalog:${effectiveKind}`,
        title: effectiveKind === 'skills' ? t('plugins.tabSkills') : t('plugins.tabPlugins'),
        cards: visibleRows.map(toCard),
      }, {
        catalogTotal: marketplace.total,
        elsewhere: otherMarketplaceRows,
        showCount: Boolean(debouncedQuery),
        showingNote: counts => t(browseShowingNoteKey(counts), counts),
      })]
    }

    const registryRow = registries.find(registry => registry.marketplaceId === marketplaceFilter)
    const label = visibleRows.find(item => item.registryLabel)?.registryLabel
      ?? registryRow?.displayName
      ?? marketplaceFilter
    const loadError = marketplace.registryLoadErrors.find(error => error.marketplaceId === marketplaceFilter)
    return [{
      id: `registry:${marketplaceFilter}`,
      title: label,
      actions: (
        <RegistrySectionActions
          marketplaceId={marketplaceFilter}
          name={label}
          upgrading={upgradingRegistryId === marketplaceFilter}
          disabled={upgradeRegistryMutation.isPending || removeRegistryMutation.isPending}
          autoUpdate={registryRow?.autoUpdate ?? false}
          autoUpdateManaged={registryRow?.autoUpdateManaged ?? false}
          autoUpdateBusy={setRegistryAutoUpdateMutation.isPending}
          t={t}
          onUpgrade={() => { void onUpgradeRegistry(marketplaceFilter) }}
          onToggleAutoUpdate={next => { void onToggleRegistryAutoUpdate(marketplaceFilter, next) }}
          onRemove={() => setRemoveRegistry({ marketplaceId: marketplaceFilter, name: label })}
        />
      ),
      // P2.429 — the refusal reason decides the sentence. A marketplace refused
      // for impersonating an Anthropic-published source and a marketplace whose
      // fetch timed out are not the same event and do not have the same remedy;
      // `registryLoadErrorMessageKey` maps every code that diverges and falls
      // back to the generic note for the ones that do not.
      ...(loadError ? { note: t(registryLoadErrorMessageKey(loadError.diagnosticCodes)) } : {}),
      cards: visibleRows.map(toCard),
    }]
  }, [debouncedQuery, effectiveKind, installingIdentity, installOutcomes, marketplace.registryLoadErrors, marketplace.total, marketplaceFilter, onToggleRegistryAutoUpdate, onUpgradeRegistry, otherMarketplaceRows, registries, removeRegistryMutation.isPending, requestInstall, renderWindow.visible, setRegistryAutoUpdateMutation.isPending, t, upgradeRegistryMutation.isPending, upgradingRegistryId])

  // Marketplace selector chips (Skills Market | one per configured registry).
  // Driven by listRegistries; the built-in Skills Market is always first + the
  // default home, so there is no cross-market "All" entry.
  const marketplaceFilterOptions = useMemo(
    () => buildMarketplaceFilterOptions({
      registries: registries.map(registry => ({ marketplaceId: registry.marketplaceId, displayName: registry.displayName })),
      builtInLabel: t('plugins.marketplaceBuiltIn'),
      offers: offers.map(offer => ({ name: offer.name, description: offer.description })),
    }),
    [offers, registries, t],
  )
  // The selector is a top-level affordance (above the kind tabs, kind-agnostic):
  // it renders whenever ≥1 bring-your-own registry is configured — or ≥1 offer
  // is still off, because hiding the row would hide the only way to turn it on.
  // With neither, the built-in Skills Market is implicit and the row stays hidden.
  const showMarketplaceFilter = shouldShowMarketplaceFilter(marketplaceFilterOptions)

  // A selected registry that was removed (or stopped being offered) falls back
  // to the built-in Skills Market so the browse list never strands empty.
  useEffect(() => {
    if (!isBuiltInMarketplace(marketplaceFilter) && !marketplaceFilterOptions.some(option => option.id === marketplaceFilter)) {
      setMarketplaceFilter(BUILT_IN_MARKETPLACE_FILTER_ID)
    }
  }, [marketplaceFilter, marketplaceFilterOptions])

  // P6.512 — an `install-plugin` deep link, applied HERE because this is where
  // the registered marketplaces are known. The link pre-fills the search box and
  // (when it named a marketplace this machine has) scopes the browse to it; it
  // installs nothing, and the final step stays a button press by a person. A
  // link naming an unregistered marketplace is refused outright — no marketplace
  // is added, allowlisted or fetched on a link's say-so.
  //
  // Waits for the registries query: resolving against a not-yet-loaded list
  // would refuse every link that names a marketplace, and the parcel is cleared
  // on the way out either way, so a refusal is not retried on the next render.
  useEffect(() => {
    if (!pendingPluginInstall || registriesLoading) return
    setPendingPluginInstall(null)
    const selection = browseSelectionForInstallLink(pendingPluginInstall, registries)
    if (!selection.ok) {
      console.warn('[Plugins] Refused install link:', selection.reason)
      toast.error(t('toast.invalidLink'), { description: t('toast.invalidLinkDesc') })
      return
    }
    setQuery(selection.query)
    if (selection.marketplaceId) setMarketplaceFilter(selection.marketplaceId)
  }, [pendingPluginInstall, registries, registriesLoading, setPendingPluginInstall, t])

  const browseStatus: MarketplaceBrowseStatus = marketplace.isLoading
    ? 'loading'
    : displayedError
      ? 'error'
      : marketplace.items.length === 0 || sections.length === 0
        ? 'empty'
        : 'ready'

  // ── Detail surface (U5 Step 3) ────────────────────────────────────────────
  // HOSTED in-place (not a new route): the plugins navigator is a standalone
  // panel branch with no `details` shape, so a routed marketplace detail would
  // need route-parser + nav-state changes (disproportionate). We reuse the
  // existing surface — the same MarketplaceDetail the playground approved — and
  // toggle it with the local `selectedItem` state. The data is the SAME safe
  // catalog item; no new RPC/channel. Re-resolve the selection from the live
  // list so a post-install refetch reflects the new installed state.
  const detailItem = useMemo<SafeMarketplaceCatalogItem | null>(() => {
    if (!selectedItem) return null
    const identity = marketplaceListingIdentity(selectedItem)
    return marketplace.installedItems.find(item => marketplaceListingIdentity(item) === identity)
      ?? marketplace.items.find(item => marketplaceListingIdentity(item) === identity)
      ?? selectedItem
  }, [marketplace.installedItems, marketplace.items, selectedItem])

  const onDetailCapabilityToggle = useCallback(async (capabilityId: string, enabled: boolean) => {
    const pluginKey = detailItem?.installed?.pluginKey
    const target = activationTarget('workspace', activeWorkspaceId, capabilityContext)
    if (!pluginKey || !target) return
    setPendingCapabilityId(capabilityId)
    setActionError(null)
    try {
      await setCapabilityEnabledMutation.mutateAsync({
        pluginKey,
        action: 'set-capability-enabled',
        target,
        capabilityId,
        enabled,
      })
      toast.success(t(enabled
        ? 'pluginDetail.toastComponentEnabled'
        : 'pluginDetail.toastComponentDisabled'))
      await refreshAfterMarketplaceMutation()
    } catch (error) {
      const message = errorMessage(error, t('pluginDetail.errorComponentToggle'))
      setActionError(message)
      toast.error(t('pluginDetail.errorComponentToggle'), { description: message })
    } finally {
      setPendingCapabilityId(undefined)
    }
  }, [
    activeWorkspaceId,
    capabilityContext,
    detailItem?.installed?.pluginKey,
    refreshAfterMarketplaceMutation,
    setCapabilityEnabledMutation,
    t,
  ])

  // Skill preview body: fetch the raw SKILL.md through the marketplace RPC
  // (main-process fetch — never a renderer-side remote request) and render its
  // markdown in the About panel. Cached per skill id for the session; skills
  // only, plugins keep the description. Fail-soft: any refusal/empty keeps the
  // description text (below), so `content(...)` resolving to null is expected.
  const isSkillDetail = detailItem?.kind === 'skill'
  const skillContentQuery = useQuery({
    queryKey: ['marketplace', 'skill-content', detailItem?.id],
    enabled: Boolean(isSkillDetail && detailItem?.id) && Boolean(window.electronAPI.marketplace),
    staleTime: Infinity,
    queryFn: () => window.electronAPI.marketplace.content({ id: detailItem!.id }),
  })

  const detailContent = useMemo<CapabilityContentPanelProps>(() => {
    const descriptionFallback: CapabilityContentPanelProps = detailItem?.description
      ? { status: 'loaded', markdown: detailItem.description }
      : { status: 'empty', emptyMessage: t('plugins.detailAboutEmpty') }
    if (!isSkillDetail) return descriptionFallback
    if (skillContentQuery.isPending) return { status: 'loading' }
    const body = skillContentQuery.data
    return typeof body === 'string' && body.trim().length > 0
      ? { status: 'loaded', markdown: body }
      : descriptionFallback
  }, [detailItem?.description, isSkillDetail, skillContentQuery.isPending, skillContentQuery.data, t])

  // Component inventory groups: a MEASURED inventory only exists once installed
  // (SafePluginComponent[] is on the installed summary). Pre-install there is a
  // DECLARATION instead, and the two are rendered differently — see
  // `detailDeclaredKinds` and PluginComponentsSection's `source` prop.
  const detailGroups = useMemo<PluginComponentGroup[] | undefined>(
    () => (detailItem?.installed
      ? toGroups(detailItem.installed.components ?? [], { pendingCapabilityId })
      : []),
    [detailItem, pendingCapabilityId],
  )

  // Pre-install composition, in two steps so the list stays cheap. The row the
  // browse list already has answers for free (a Codex registry's per-plugin
  // manifests were read during the catalog's own staged scan; a Claude entry may
  // declare components inline). Only when it says nothing does the detail page
  // spend ONE request on that plugin's own manifest at its pinned sha — never
  // the list, which is 2 307 rows deep.
  const detailIsListing = Boolean(detailItem && !detailItem.installed)
  const detailListingKinds = useMemo(
    () => toDeclaredKinds(detailItem?.capabilities),
    [detailItem],
  )
  const declaredComponentsQuery = useQuery({
    // `version` is in the key so a registry upgrade that repins the entry
    // refetches instead of serving the old ref's composition.
    queryKey: [
      'marketplace', 'declared-components',
      detailItem?.marketplaceId, detailItem?.id, detailItem?.version ?? '',
    ],
    enabled: detailIsListing
      && detailListingKinds.length === 0
      && Boolean(window.electronAPI.marketplace?.components),
    staleTime: Infinity,
    retry: false,
    queryFn: () => window.electronAPI.marketplace.components({
      marketplaceId: detailItem!.marketplaceId,
      listingId: detailItem!.id,
      listingKind: detailItem!.listKind,
    }),
  })
  const detailDeclaredKinds = useMemo(
    () => (detailListingKinds.length
      ? detailListingKinds
      : toDeclaredKinds(declaredComponentsQuery.data?.kinds)),
    [detailListingKinds, declaredComponentsQuery.data],
  )

  // A clicked inventory row deep-links to its OWN capability page (routed
  // Info_Page canon, exactly as PluginInfoPage.openComponent does). Only rows
  // WITH a capabilityKey are clickable (see PluginComponentsSection/toGroups),
  // so `onOpen` always resolves to a routed component here.
  const openDetailComponent = useCallback((key: string) => {
    const component = detailItem?.installed?.components?.find(
      entry => (entry.capabilityKey ?? `${entry.kind}:${entry.name}`) === key,
    )
    if (component?.capabilityKey) {
      const slug = component.kind === 'skill'
        ? sourceListSkillId(component.capabilityKey)
        : capabilityRouteId(component.capabilityKey)
      navigate(routes.view.sources({ sourceSlug: slug }))
    }
  }, [detailItem])

  const detailInformation = useMemo(() => {
    if (!detailItem) return []
    const rows: Array<{ label: string; value: React.ReactNode }> = [
      { label: t('plugins.detailKind'), value: labelForKind(detailItem.kind, t) },
    ]
    if (detailItem.version) rows.push({ label: t('plugins.detailVersion'), value: detailItem.version })
    if (detailItem.tenant) rows.push({ label: t('plugins.detailTenant'), value: detailItem.tenant })
    const repo = detailItem.repo ?? detailItem.sourceUrl
    if (repo) rows.push({ label: t('plugins.detailRepo'), value: repo })
    rows.push({ label: t('plugins.detailInstallSource'), value: installSourceLabel(detailItem, t) })
    if (detailItem.installed) {
      rows.push({ label: t('plugins.detailInstalledVersion'), value: detailItem.installed.version })
      rows.push({ label: t('plugins.detailScopes'), value: activationLabel(detailItem.installed.activation, t) })
    }
    return rows
  }, [detailItem, t])

  return (
    <div className="flex h-full flex-col bg-background">
      {configurationPrompt.element}
      {installChecklist.element}
      <PanelHeader
        actions={
          <div className="flex items-center gap-1">
            {needsRuntimeRefresh && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void onRuntimeRefresh()}
                disabled={refreshMutation.isPending}
              >
                <RefreshCw className={cn('h-4 w-4', refreshMutation.isPending && 'animate-spin')} />
                <span className="hidden sm:inline">{t('plugins.refreshRuntime')}</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void marketplace.refetch()}
              disabled={marketplace.isFetching}
              aria-label={t('plugins.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', marketplace.isFetching && 'animate-spin')} />
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detailItem ? (
          // Detail surface (U5 Step 3): the approved MarketplaceDetail, hosted
          // in place of the browse page (see the detailItem note above). Actions
          // reuse the existing install/enable/disable/uninstall/repair callbacks;
          // the About panel renders the skill's SKILL.md body (fetched via the
          // marketplace RPC, cached per id, fail-soft to the description), and
          // the component inventory is real once installed.
          <MarketplaceDetail
            icon={iconTileForKind(detailItem.kind)}
            name={detailItem.name}
            {...(detailItem.description ? { tagline: detailItem.description } : {})}
            {...(pickPresentation(detailItem) ? { presentation: pickPresentation(detailItem)! } : {})}
            breadcrumbParent={t('plugins.title')}
            actions={
              <DetailActions
                item={detailItem}
                installOutcome={installOutcomeFor(detailItem, installOutcomes)}
                hasProjectContext={hasProjectContext}
                isBusy={isBusy}
                t={t}
                onBack={() => setSelectedItem(null)}
                onInstall={requestInstall}
                onEnable={onEnable}
                onConfirmEnable={onConfirmEnable}
                onDisable={onDisable}
                onUninstall={onUninstall}
                onRepair={onRepair}
                onUpdate={onUpdate}
                onTryInChat={onTryInChat}
              />
            }
            aboutTitle={t('plugins.detailAbout')}
            content={detailContent}
            componentsSlot={
              <PluginComponentsSection
                groups={detailGroups}
                source={detailIsListing ? 'listing' : 'installed'}
                declaredKinds={detailDeclaredKinds}
                declaredPending={detailIsListing && declaredComponentsQuery.isPending
                  && declaredComponentsQuery.fetchStatus !== 'idle'}
                onOpen={openDetailComponent}
                onToggle={onDetailCapabilityToggle}
              />
            }
            informationTitle={t('plugins.detailInformation')}
            information={detailInformation}
            informationEmpty={t('plugins.detailInformationEmpty')}
          />
        ) : (
          <>
            {/* Codex-style browse page (U5 Step 1). R3 wired the "Create ▾" header
                (Add marketplace → ADD_REGISTRY; Create plugin stays disabled until the C
                phases) and the grouped registry browse; the scope segment stays deferred
                (no public/personal filter). Step 2 wired the installed strip / manage
                handoff; Step 3 the hosted MarketplaceDetail; F1.226 the load-error banner. */}
            <MarketplaceBrowsePage
              title={t('plugins.title')}
              subtitle={activeSubtitle}
              status={browseStatus}
              query={query}
              searchPlaceholder={effectiveKind === 'skills' ? t('plugins.searchSkills') : t('plugins.searchPlugins')}
              onQueryChange={setQuery}
              headerActions={
                <div className="flex items-center gap-2">
                  {/* F1 — narrow 6084 skills by the tenant that publishes them. */}
                  {supportsTenantFilter && tenantVocabulary.length > 1 && (
                    <TenantMenu
                      t={t}
                      active={activeTenant}
                      vocabulary={tenantVocabulary}
                      onSelect={tenant => setTenantFilter(browseTenantFilter(tenant, tenantVocabulary) ?? null)}
                      onClear={() => setTenantFilter(null)}
                    />
                  )}
                  <CreateMenu
                    open={createMenuOpen}
                    onOpenChange={setCreateMenuOpen}
                    t={t}
                    kind={effectiveKind}
                    onCreatePlugin={() => { void onCreatePlugin() }}
                    onCreateSkill={() => { void onCreateSkill() }}
                    onAddMarketplace={() => { setCreateMenuOpen(false); setAddRegistryOpen(true) }}
                    onInstallFromUrl={() => { setCreateMenuOpen(false); setUrlInstallOpen(true) }}
                    onImportMcpb={() => { void onPickMcpb() }}
                    isPickingMcpb={isPickingMcpb}
                  />
                </div>
              }
              // Marketplace-first selector on top; the Plugins|Skills tabs are
              // SCOPED to the selected marketplace below it.
              marketplaceFilter={showMarketplaceFilter ? {
                active: marketplaceFilter,
                options: marketplaceFilterOptions.map(option => ({
                  id: option.id,
                  label: option.label,
                  ...(option.kind === 'offer' ? { offered: true, description: option.description } : {}),
                })),
                onChange: setMarketplaceFilter,
                onEnable: (name: string) => { void onEnableOffer(name) },
                offeredLabel: t('plugins.marketplaceOffered'),
                enableLabel: t('plugins.marketplaceEnable'),
                ...(enableOfferMutation.isPending && enableOfferMutation.variables
                  ? { enabling: [enableOfferMutation.variables.name] }
                  : {}),
              } : undefined}
              tabs={{
                active: effectiveKind,
                pluginsLabel: t('plugins.tabPlugins'),
                skillsLabel: t('plugins.tabSkills'),
                onChange: setKind,
                ...(marketplaceAvailability.skills ? {} : { disabled: { skills: true }, note: t('plugins.marketplaceNoSkills') }),
              }}
              installedStrip={installedEntries.length > 0 ? {
                title: t('plugins.installed'),
                entries: installedEntries,
                manageLabel: t('plugins.manageInSources'),
                onManage: onManageInSources,
                onOpenInstalled,
              } : undefined}
              sections={sections}
              loadErrorNote={registryLoadFailuresElsewhere(marketplace.registryLoadErrors, marketplaceFilter).length > 0 ? t(REGISTRY_LOAD_ERROR_FALLBACK_KEY) : undefined}
              emptyMessage={t(browseEmptyMessageKey({ query: debouncedQuery, tenant: activeTenant }))}
              errorMessage={displayedError ?? undefined}
              retryLabel={t('plugins.retry')}
              onRetry={() => void marketplace.refetch()}
            />

            <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-5 pb-5">
              {/* Infinite-scroll sentinel + explicit load-more fallback. The
                  sentinel first reveals more already-loaded rows (client-side
                  render cap), then fetches the next server page. */}
              <div ref={sentinelRef} className="h-1" />
              {canLoadMore && (
                <div className="flex justify-center py-2">
                  <Button
                    variant="secondary"
                    onClick={onReachListEnd}
                    disabled={marketplace.isFetchingNextPage}
                  >
                    {marketplace.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('plugins.loadMore')}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* R3: Add-marketplace dialog (Create ▾ → Add marketplace). The dialog
          emits {source, gitRef, sparsePaths}; onAddRegistry maps gitRef→refName
          and calls ADD_REGISTRY — the SERVER clones (no renderer fetch). */}
      <MarketplaceAddDialog
        open={addRegistryOpen}
        onOpenChange={setAddRegistryOpen}
        title={t('plugins.addMarketplaceTitle')}
        description={t('plugins.addMarketplaceDescription')}
        sourceLabel={t('plugins.addMarketplaceSource')}
        sourcePlaceholder={t('plugins.addMarketplaceSourcePlaceholder')}
        gitRefLabel={t('plugins.addMarketplaceGitRef')}
        sparsePathsLabel={t('plugins.addMarketplaceSparsePaths')}
        sparsePathsPlaceholder={t('plugins.addMarketplaceSparsePathsPlaceholder')}
        cancelLabel={t('plugins.addMarketplaceCancel')}
        submitLabel={addRegistryMutation.isPending ? t('plugins.installing') : t('plugins.addMarketplaceSubmit')}
        onSubmit={(value) => { void onAddRegistry(value) }}
      />

      {/* Install-from-URL dialog (Create ▾ → Install from URL). Hosts the SAME
          repository-URL install flow that used to sit at the bottom of the
          browse list — url → Inspect → proposal → Install proposal — with no
          data-layer change. Closes on a successful install.
          UB14.39 (R6-10) — this page's four dialogs are on v0.15.1's dialog vocabulary: Cancel ghost, the forward
          action primary, the registry-removal confirm danger-solid (as v0.15.1's own delete confirmations), text roles, Info_Alert's notice recipe,
          and DialogContent's own rhythm (no margin or gap overrides). */}
      <Dialog open={urlInstallOpen} onOpenChange={setUrlInstallOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('plugins.urlInstallTitle')}</DialogTitle>
            <DialogDescription>{t('plugins.installFromUrlDescription')}</DialogDescription>
          </DialogHeader>
          <UrlInstall
            url={url}
            proposal={proposal}
            error={urlError}
            isLoading={isProposingUrl}
            isInstalling={installMutation.isPending}
            onUrlChange={setUrl}
            onPropose={() => void onProposeUrl()}
            onInstall={() => void onInstallProposal()}
            t={t}
          />
        </DialogContent>
      </Dialog>

      {/* P6.414 — the install scope is OFFERED, not derived. Every row of
          `PLUGIN_INSTALL_SCOPE_OFFERS` is rendered; a row whose target cannot be
          resolved from here (no workspace open, no project context) is disabled
          rather than silently redirected, and
          `PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY` states the divergence from the
          page's four scopes where the user meets it: none of ours is the
          team-shared `project` scope. */}
      <Dialog
        open={installScopeOffer !== null}
        onOpenChange={(open) => { if (!open) setInstallScopeOffer(null) }}
      >
        <DialogContent className="sm:max-w-md" data-testid="install-scope-dialog">
          <DialogHeader>
            <DialogTitle>{t('plugins.installScopeTitle')}</DialogTitle>
            <DialogDescription>{installScopeOffer?.item.name ?? ''}</DialogDescription>
          </DialogHeader>
          {managedTrustMessage && (
            <InlineNotice tone="info" icon={<ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />}>
              {/* VERBATIM. The label is the only host string here — the sentence
                  itself is the administrator's, and reinterpreting it would put
                  words they did not write beside a trust decision. */}
              <span className="font-medium">{t('plugins.managedTrustMessageTitle')}</span>
              {'\n'}
              {managedTrustMessage}
            </InlineNotice>
          )}
          <div className="space-y-2" role="radiogroup" aria-label={t('plugins.installScopeTitle')}>
            {PLUGIN_INSTALL_SCOPE_OFFERS.map((offer) => {
              const unavailable = activationTarget(offer.scope, activeWorkspaceId, capabilityContext) === null
              return (
                <label
                  key={offer.scope}
                  className={cn(
                    'flex items-start gap-2 rounded-md border px-3 py-2 text-label',
                    unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                    installScopeOffer?.scope === offer.scope ? 'border-strong' : 'border-subtle',
                  )}
                  data-testid={`install-scope-${offer.scope}`}
                >
                  <input
                    type="radio"
                    name="plugin-install-scope"
                    className="mt-1"
                    value={offer.scope}
                    disabled={unavailable}
                    checked={installScopeOffer?.scope === offer.scope}
                    onChange={() => setInstallScopeOffer(previous => (
                      previous ? { ...previous, scope: offer.scope } : previous
                    ))}
                  />
                  <span className="flex flex-col">
                    <span>{t(offer.labelKey)}</span>
                    <span className="text-label-sm text-tertiary">{t(offer.hintKey)}</span>
                  </span>
                </label>
              )
            })}
          </div>
          <p className="text-label-sm text-tertiary">{t(PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY)}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setInstallScopeOffer(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void onConfirmInstallScope()}
              disabled={installMutation.isPending}
              data-testid="install-scope-submit"
            >
              {installMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {installScopeOffer?.item.kind === 'skill' ? t('plugins.installSkill') : t('plugins.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mcpbInstallOpen}
        onOpenChange={(open) => {
          setMcpbInstallOpen(open)
          if (!open) setMcpbProposal(null)
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="mcpb-install-dialog">
          <DialogHeader>
            <DialogTitle>{t('plugins.mcpbInstallTitle')}</DialogTitle>
            <DialogDescription>{t('plugins.mcpbInstallDescription')}</DialogDescription>
          </DialogHeader>
          {mcpbProposal?.status === 'installable' && (
            <InlineNotice tone="info" icon={<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}>
              {t('plugins.mcpbInstallable', { source: mcpbProposal.displaySource })}
            </InlineNotice>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => {
              setMcpbInstallOpen(false)
              setMcpbProposal(null)
            }}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void onInstallMcpbProposal()}
              disabled={mcpbProposal?.status !== 'installable' || installMutation.isPending}
              data-testid="mcpb-install-submit"
            >
              {installMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {t('plugins.installProposal')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* R3: remove-registry confirm. The built-in Skills Market never reaches
          here (registry sections only). Confirm is destructive; installed
          plugins are NOT uninstalled (copy says so). */}
      <Dialog open={removeRegistry !== null} onOpenChange={(open) => { if (!open) setRemoveRegistry(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('plugins.removeMarketplaceConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('plugins.removeMarketplaceConfirm', { name: removeRegistry?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoveRegistry(null)} data-testid="marketplace-registry-remove-cancel">
              {t('plugins.addMarketplaceCancel')}
            </Button>
            <Button
              variant="danger-solid"
              onClick={() => void onConfirmRemoveRegistry()}
              disabled={removeRegistryMutation.isPending}
              data-testid="marketplace-registry-remove-confirm"
            >
              {removeRegistryMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('plugins.removeMarketplace')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * CreateMenu (R3 + C2)
 *
 * The Codex-style "Create ▾" header dropdown. "Add marketplace" opens the
 * add-registry dialog; "Create plugin" (C2) opens a visible new chat seeded
 * with the shared CREATE_PLUGIN_PROMPT creator macro.
 */
/**
 * F2 (open seam) — the number beside a section title is the number of rows
 * under it.
 *
 * The header used to show `marketplace.total`, the Skills Market's own match
 * count, while the list rendered something else entirely: the duplicate
 * collapse removes 1373 of the live 6084 rows before any of them reach a card,
 * and the client render cap shows `PAGE_RENDER_STEP` of what survives. A user
 * searching therefore read a count that contradicted the screen.
 *
 * The count is derived from the section's OWN cards here rather than passed in,
 * so the two cannot disagree again. The catalog total is not dropped — it moves
 * into the section note as the already-translated "Showing {{visible}} of
 * {{total}}", which is the honest way to say both numbers.
 *
 * sev-4 (audit of the signed 1.25.0) — that note then had the same disease one
 * level up: `marketplace.total` spans EVERY marketplace, while the cards under
 * the header are one chip's. `browseSectionCounts` scopes the denominator and
 * names what the chip is hiding; see its comment for the measurement.
 */
export function browseCatalogSection(
  section: Omit<MarketplaceBrowseSection, 'count'>,
  input: {
    /** The server's match count, which spans EVERY marketplace (see below). */
    catalogTotal: number
    /** Loaded rows the other marketplace chips hold for the same query. */
    elsewhere: number
    showCount: boolean
    showingNote: (counts: BrowseSectionCounts) => React.ReactNode
  },
): MarketplaceBrowseSection {
  const visible = section.cards.length
  // sev-4 — the denominator is scoped to the marketplace whose rows are under
  // this header, and the rows one chip away are named; see `browseSectionCounts`.
  const counts = browseSectionCounts({ visible, catalogTotal: input.catalogTotal, elsewhere: input.elsewhere })
  return {
    ...section,
    ...(input.showCount ? { count: visible } : {}),
    ...(counts ? { note: input.showingNote(counts) } : {}),
  }
}

/**
 * F1 — the browse tenant filter.
 *
 * Every item is a value the loaded rows carried, so an out-of-vocabulary
 * selection (measured live: `tenant=not-a-real-tenant` returns 0 of 6084) is
 * not reachable from the control. `Clear` is always offered, including from
 * inside a filtered-to-empty list, so the filter is never a trap.
 */
function TenantMenu({
  t,
  active,
  vocabulary,
  onSelect,
  onClear,
}: {
  t: (key: string, options?: Record<string, unknown>) => string
  active: string | null
  vocabulary: readonly string[]
  onSelect: (tenant: string) => void
  onClear: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={active ? 'primary' : 'secondary'} size="sm" data-testid="marketplace-tenant-filter">
          {active ?? t('plugins.filterTenant')}
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <DropdownMenuItem onClick={onClear} data-testid="marketplace-tenant-clear">
          {t('common.clear')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {vocabulary.map(tenant => (
          <DropdownMenuItem key={tenant} onClick={() => onSelect(tenant)}>
            {tenant}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * F1 — an empty browse list explains itself. A tenant filter can empty the list
 * exactly like a search can, and reading "Search marketplace items" under an
 * active filter is what makes an empty result look like a broken list.
 */
export function browseEmptyMessageKey(
  input: { query?: string; tenant?: string | null },
): 'plugins.noResults' | 'plugins.emptySearch' {
  return input.query?.trim() || input.tenant ? 'plugins.noResults' : 'plugins.emptySearch'
}

function CreateMenu({
  open,
  onOpenChange,
  t,
  kind,
  onCreatePlugin,
  onCreateSkill,
  onAddMarketplace,
  onInstallFromUrl,
  onImportMcpb,
  isPickingMcpb,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  t: (key: string, options?: Record<string, unknown>) => string
  kind: 'plugins' | 'skills'
  onCreatePlugin: () => void
  onCreateSkill: () => void
  onAddMarketplace: () => void
  onInstallFromUrl: () => void
  onImportMcpb: () => void
  isPickingMcpb: boolean
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" data-testid="marketplace-create">
          {t('plugins.create')}
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Creator macro follows the active tab: Skills -> create-skill chat,
            Plugins -> create-plugin chat (both seeded shared prompts). */}
        {kind === 'skills' ? (
          <DropdownMenuItem onClick={onCreateSkill} data-testid="marketplace-create-skill">
            <Plus className="h-3.5 w-3.5" />
            {t('plugins.createSkill')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={onCreatePlugin} data-testid="marketplace-create-plugin">
            <Plus className="h-3.5 w-3.5" />
            {t('plugins.createPlugin')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onAddMarketplace} data-testid="marketplace-add-open">
          <FolderGit2 className="h-3.5 w-3.5" />
          {t('plugins.addMarketplace')}
        </DropdownMenuItem>
        {/* Install a single plugin directly from a repository URL. */}
        <DropdownMenuItem onClick={onInstallFromUrl} data-testid="marketplace-install-from-url">
          <Download className="h-3.5 w-3.5" />
          {t('plugins.installFromUrlMenu')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onImportMcpb} disabled={isPickingMcpb} data-testid="marketplace-import-mcpb">
          {isPickingMcpb ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Box className="h-3.5 w-3.5" />}
          {t('plugins.mcpbImportMenu')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * RegistrySectionActions (R3)
 *
 * Per-registry Upgrade / auto-update / Remove affordance rendered in the browse
 * section header. Upgrade is git re-fetch (the server no-ops local folders);
 * auto-update is `plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace`'s Enable/Disable toggle; Remove opens
 * the confirm dialog. The built-in Skills Market section never renders these
 * (only registry sections carry them).
 */
function RegistrySectionActions({
  upgrading,
  disabled,
  autoUpdate,
  autoUpdateManaged,
  autoUpdateBusy,
  t,
  onUpgrade,
  onToggleAutoUpdate,
  onRemove,
}: {
  marketplaceId: string
  name: string
  upgrading: boolean
  disabled: boolean
  /**
   * `settings-reference.md#extraknownmarketplaces`'s `autoUpdate`, as the
   * effective value already resolved server-side.
   */
  autoUpdate: boolean
  /** Fixed by managed settings — the control renders disabled, never silently inert. */
  autoUpdateManaged: boolean
  autoUpdateBusy: boolean
  t: (key: string, options?: Record<string, unknown>) => string
  onUpgrade: () => void
  onToggleAutoUpdate: (autoUpdate: boolean) => void
  onRemove: () => void
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onUpgrade}
        data-testid="marketplace-registry-upgrade"
      >
        {upgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        {t('plugins.upgradeMarketplace')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || autoUpdateManaged || autoUpdateBusy}
        title={autoUpdateManaged ? t('plugins.autoUpdateManaged') : undefined}
        onClick={() => onToggleAutoUpdate(!autoUpdate)}
        data-testid="marketplace-registry-auto-update"
      >
        {autoUpdate ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
        {autoUpdate ? t('plugins.disableAutoUpdate') : t('plugins.enableAutoUpdate')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onRemove}
        data-testid="marketplace-registry-remove"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t('plugins.removeMarketplace')}
      </Button>
    </>
  )
}

/**
 * DetailActions (U5 Step 3)
 *
 * Hero action bar for the hosted MarketplaceDetail: a quiet Back affordance +
 * the same install/enable/disable/uninstall/repair/try-in-chat actions the old
 * dialog footer carried, driven by the existing callbacks. An overflow menu
 * holds the installed-only management actions (management proper lives in
 * Sources; these stay here where install lives so removing them would strand
 * the action).
 */
function DetailActions({
  item,
  installOutcome,
  hasProjectContext,
  isBusy,
  t,
  onBack,
  onInstall,
  onEnable,
  onConfirmEnable,
  onDisable,
  onUninstall,
  onRepair,
  onUpdate,
  onTryInChat,
}: DetailActionsProps) {
  const installable = isInstallable(item)
  const confirmationTarget = installOutcome?.confirmationTarget
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onBack}>
        {t('common.back')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void onTryInChat(item)} disabled={isBusy}>
        <PlayCircle className="h-4 w-4" />
        {t('plugins.tryInChat')}
      </Button>
      {/* R82 — `plugins/install.md#manage-installed-plugins` keeps update out of the installed
          verb list, so this badge is what tells the user an update exists. It
          sits beside the menu that acts on it, and renders the wire's
          `availableUpdateVersion` and nothing else. */}
      <PluginUpdateBadge
        installed={item.installed}
        formatLabel={version => t('plugins.updateAvailable', { version })}
      />
      {/* P2.159 — and the row's other honest state: an update that can never be
          offered because the two versions cannot be ordered. Same wire, opposite
          news; renders nothing for every plugin the server said nothing about. */}
      <PluginUpdateStalledBadge
        installed={item.installed}
        formatLabel={() => t('plugins.updateVersionUncomparable')}
      />
      {/* P2.518, unit 5, DECIDED at the close-out. The BLOCKED arm carries its
          reason as a `title` (`deriveBlockedReason` → `MarketplaceBrowseCard`),
          and the PARTIAL arm — this one — carried none at all: a bare "Confirm
          enable" button with nothing saying what needs confirming. Extending
          `deriveBlockedReason` would have surfaced nothing, because its consumer
          renders only when `installState === 'blocked'`; the affordance that
          actually needs the line is here.
          `plugins.compatPartialReason` already exists in both locales and says
          exactly this state, so the fix is one attribute per button and no new
          key. A `title` rather than a visible line, deliberately: the row is
          dense and the blocked twin already sets the precedent for where a
          reason lives on this surface. */}
      {item.installed && installOutcome?.needsConfirmEnable ? (
        confirmationTarget ? (
          <Button size="sm" title={t('plugins.compatPartialReason')} onClick={() => void onConfirmEnable(item, confirmationTarget)} disabled={isBusy}>
            <ShieldCheck className="h-4 w-4" />
            {t('plugins.confirmEnable')}
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" title={t('plugins.compatPartialReason')} disabled={isBusy}>
                <ShieldCheck className="h-4 w-4" />
                {t('plugins.confirmEnable')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void onEnable(item, 'user/global')} disabled={isBusy || !item.installed.actions.canEnable}>
                <CheckCircle2 className="h-4 w-4" />
                {t('plugins.enableGlobal')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void onEnable(item, 'workspace')} disabled={isBusy || !item.installed.actions.canEnable}>
                <CheckCircle2 className="h-4 w-4" />
                {t('plugins.enableWorkspace')}
              </DropdownMenuItem>
              {hasProjectContext && (
                <DropdownMenuItem onClick={() => void onEnable(item, 'project')} disabled={isBusy || !item.installed.actions.canEnable}>
                  <CheckCircle2 className="h-4 w-4" />
                  {t('plugins.enableProject')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      ) : item.installed ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm">
              <MoreHorizontal className="h-4 w-4" />
              {t('plugins.actions')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void onEnable(item, 'workspace')} disabled={isBusy || !item.installed.actions.canEnable}>
              <CheckCircle2 className="h-4 w-4" />
              {t('plugins.enableWorkspace')}
            </DropdownMenuItem>
            {hasProjectContext && (
              <DropdownMenuItem onClick={() => void onEnable(item, 'project')} disabled={isBusy || !item.installed.actions.canEnable}>
                <CheckCircle2 className="h-4 w-4" />
                {t('plugins.enableProject')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => void onDisable(item, 'workspace')} disabled={isBusy || !item.installed.actions.canDisable}>
              <XCircle className="h-4 w-4" />
              {t('plugins.disableWorkspace')}
            </DropdownMenuItem>
            {hasProjectContext && (
              <DropdownMenuItem onClick={() => void onDisable(item, 'project')} disabled={isBusy || !item.installed.actions.canDisable}>
                <XCircle className="h-4 w-4" />
                {t('plugins.disableProject')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {/* Offered only when the wire says there IS an update; a false
                `canUpdate` means the control would do nothing, so it is
                withheld rather than shown disabled. */}
            {offersPluginUpdate(item.installed) && (
              <DropdownMenuItem onClick={() => void onUpdate(item)} disabled={isBusy}>
                <ArrowUpCircle className="h-4 w-4" />
                {t('plugins.update')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => void onRepair(item)} disabled={isBusy || !item.installed.actions.canRepair}>
              <RefreshCw className="h-4 w-4" />
              {t('plugins.repair')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => void onUninstall(item)} disabled={isBusy || !item.installed.actions.canUninstall}>
              <Trash2 className="h-4 w-4" />
              {t('plugins.uninstall')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : installable ? (
        <Button size="sm" onClick={() => onInstall(item)} disabled={isBusy} data-testid="detail-install">
          <Download className="h-4 w-4" />
          {item.kind === 'skill' ? t('plugins.installSkill') : t('plugins.install')}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">{unsupportedInstallReason(item, t)}</span>
      )}
    </>
  )
}
function UrlInstall({
  url,
  proposal,
  error,
  isLoading,
  isInstalling,
  onUrlChange,
  onPropose,
  onInstall,
  t,
}: UrlInstallProps) {
  return (
    <div className="space-y-3" data-testid="url-install">
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder={t('plugins.urlInstallPlaceholder')}
          autoFocus
          data-testid="url-install-input"
        />
        <Button variant="secondary" size="lg" onClick={onPropose} disabled={isLoading || !url.trim()} data-testid="url-install-inspect">
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {t('plugins.inspectUrl')}
        </Button>
        <Button variant="primary" size="lg" onClick={onInstall} disabled={proposal?.status !== 'installable' || isInstalling} data-testid="url-install-submit">
          {isInstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t('plugins.installProposal')}
        </Button>
      </div>
      {proposal?.status === 'installable' && ( // F1.986 — only the URL was checked (F1.805 `not_contacted`): an info icon, never a check mark
        <InlineNotice tone="info" icon={<Info className="mt-0.5 h-4 w-4 shrink-0" />}>
          {t('plugins.urlInstallable', { source: proposal.displaySource })}
        </InlineNotice>
      )}
      {error && (
        <InlineNotice tone="error" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}>
          {error}
        </InlineNotice>
      )}
    </div>
  )
}

/**
 * The dialogs' inline notice. UB14.39: v0.15.1's `Info_Alert` recipe, inline: the neutral tone is its `warning`
 * fill (`bg-fill-hover` + hairline ring, secondary text), the error tone its destructive tint and ring; the icon takes
 * the tone's text role. Kept local: the verbatim managed-trust sentence needs `whitespace-pre-wrap`.
 */
function InlineNotice({ tone, icon, children }: { tone: 'info' | 'error'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn(
      'flex items-start gap-2.5 rounded-lg px-3.5 py-2 text-label',
      tone === 'error'
        ? 'bg-destructive-tint text-destructive inset-ring inset-ring-[var(--destructive-border)]'
        : 'bg-fill-hover text-secondary inset-ring inset-ring-border',
    )}>
      {icon}
      <span className="whitespace-pre-wrap">{children}</span>
    </div>
  )
}

interface DetailActionsProps {
  item: SafeMarketplaceCatalogItem
  installOutcome?: InstallOutcome
  hasProjectContext: boolean
  isBusy: boolean
  t: (key: string, options?: Record<string, unknown>) => string
  onBack: () => void
  /** P6.414 — opens the scope offer; the install itself happens on confirm. */
  onInstall: (item: SafeMarketplaceCatalogItem) => void
  onEnable: (item: SafeMarketplaceCatalogItem, scope: ActivationScope) => Promise<void>
  onConfirmEnable: (item: SafeMarketplaceCatalogItem, target: SafePluginActivationTarget) => Promise<void>
  onDisable: (item: SafeMarketplaceCatalogItem, scope: ActivationScope) => Promise<void>
  onUninstall: (item: SafeMarketplaceCatalogItem) => Promise<void>
  onRepair: (item: SafeMarketplaceCatalogItem) => Promise<void>
  onUpdate: (item: SafeMarketplaceCatalogItem) => Promise<void>
  onTryInChat: (item: SafeMarketplaceCatalogItem) => Promise<void>
}

interface UrlInstallProps {
  url: string
  proposal: SafeMarketplacePluginInstallProposal | null
  error: string | null
  isLoading: boolean
  isInstalling: boolean
  onUrlChange: (value: string) => void
  onPropose: () => void
  onInstall: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(handle)
  }, [delayMs, value])
  return debounced
}

function defaultInstallScope(item: SafeMarketplaceCatalogItem, hasProjectContext: boolean): ActivationScope {
  if (hasProjectContext && item.kind === 'skill') return 'workspace'
  if (item.kind === 'skill' || item.kind === 'mcp') return 'workspace'
  return 'user/global'
}

// P6.414 — one writer. The mapping moved beside the install mutation so the
// dialog's offer and the request's `activateIn` cannot drift apart; `null` is
// "this scope cannot be targeted from here" and disables the choice rather than
// installing somewhere else.
const activationTarget = installScopeTarget

function requireActivationTarget(
  scope: ActivationScope,
  workspaceId: string | null,
  context: SafeCapabilityContextRef | undefined,
): SafePluginActivationTarget {
  const target = activationTarget(scope, workspaceId, context)
  if (!target) throw new Error('Plugin activation context is unavailable')
  return target
}

function marketplaceIdFor(item: SafeMarketplaceCatalogItem): string {
  if (item.installed) return item.installed.origin.marketplaceId
  return item.marketplaceId ?? 'internal'
}

function labelForKind(kind: SafeMarketplaceItemKind, t: (key: string) => string): string {
  return t(`plugins.kind.${kind}`)
}

function iconForKind(kind: SafeMarketplaceItemKind): React.ReactNode {
  if (kind === 'skill') return <CheckCircle2 className="h-4 w-4" />
  if (kind === 'mcp') return <ShieldAlert className="h-4 w-4" />
  if (kind === 'hook') return <AlertTriangle className="h-4 w-4" />
  return <Box className="h-4 w-4" />
}

/** Icon tile filling the browse card's fixed avatar slot (U5 browse rows). */
function iconTileForKind(kind: SafeMarketplaceItemKind): React.ReactNode {
  return (
    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
      {iconForKind(kind)}
    </div>
  )
}

/** The reason tooltip shown on a blocked card, path-/secret-free. */
function deriveBlockedReason(
  item: SafeMarketplaceCatalogItem,
  installOutcomes: Record<string, InstallOutcome>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  const outcome = installOutcomeFor(item, installOutcomes)
  if (outcome?.blocked) return t('plugins.compatBlockedReason')
  if (!item.installed && !isInstallable(item)) return unsupportedInstallReason(item, t)
  return undefined
}

/** Origin-badge projection, preferring the installed summary's when present. */
function pickPresentation(item: SafeMarketplaceCatalogItem) {
  return item.installed?.presentation ?? item.presentation
}

/** What the upgrade RPC reports back; `upgraded` is the only honest signal. */
export interface RegistryUpgradeReport {
  upgraded: boolean
  /** Why nothing was upgraded — named to the user by {@link registryUpgradeFailureDescription}. */
  reason?: 'not-git' | 'not-found' | 'fetch-failed' | 'fetch-timeout'
}

/**
 * The sentence shown when an upgrade did not happen.
 *
 * The description used to be the bare `marketplaceId` — an opaque
 * `registry-<uuid>` that tells the user nothing and cannot be searched for. Now
 * that the RPC carries `reason`, each case gets its own sentence; a missing or
 * unrecognized reason still falls back to the generic one, so a future server
 * tag can never render as a raw enum string.
 */
export function registryUpgradeFailureDescription(
  reason: RegistryUpgradeReport['reason'],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (reason) {
    case 'not-git':
      return t('plugins.upgradeReasonNotGit')
    case 'not-found':
      return t('plugins.upgradeReasonNotFound')
    case 'fetch-timeout':
      return t('plugins.upgradeReasonFetchTimeout')
    case 'fetch-failed':
      return t('plugins.upgradeReasonFetchFailed')
    default:
      return t('plugins.upgradeReasonUnknown')
  }
}

/** The effects `applyRegistryUpgrade` drives, injected so the decision is drivable. */
export interface RegistryUpgradeSurface {
  upgrade: (ref: { marketplaceId: string }) => Promise<RegistryUpgradeReport>
  toastSuccess: (title: string) => void
  toastError: (title: string, description: string) => void
  setActionError: (message: string | null) => void
  refresh: () => Promise<unknown>
}

/**
 * A6 — an upgrade reports what actually happened.
 *
 * `PluginRegistrySource.upgrade` does NOT reject when the re-clone throws: a
 * refused clone, a timeout or a missing manifest all resolve as
 * `{upgraded:false}` with the previous catalog deliberately left in place
 * (`registry-source.ts`, `!entry.persistable`). The old handler awaited the
 * mutation and then toasted success unconditionally, so the one case the
 * server goes out of its way to report — nothing fresh arrived — reached the
 * user as "Marketplace upgraded", and the browse list they then looked at was
 * the pre-upgrade one.
 *
 * `upgraded:false` therefore ends in the SAME surface as a thrown error: the
 * inline action-error banner plus an error toast, and no catalog refetch (there
 * is nothing new to refetch). The server-side `reason` now crosses the RPC
 * boundary (A6 left it behind), so the description NAMES the case instead of
 * echoing the opaque `registry-<uuid>` back at the user; `diagnosticCodes` stay
 * server-side, in the log.
 */
export async function applyRegistryUpgrade(
  marketplaceId: string,
  surface: RegistryUpgradeSurface,
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<void> {
  surface.setActionError(null)
  const title = t('plugins.errorUpgradeMarketplace')
  let report: RegistryUpgradeReport
  try {
    report = await surface.upgrade({ marketplaceId })
  } catch (error) {
    const message = errorMessage(error, title)
    surface.setActionError(message)
    surface.toastError(title, message)
    return
  }
  if (!report.upgraded) {
    const description = registryUpgradeFailureDescription(report.reason, t)
    surface.setActionError(description)
    surface.toastError(title, description)
    return
  }
  surface.toastSuccess(t('plugins.toastMarketplaceUpgraded'))
  await surface.refresh()
}

/**
 * A0: the confidence member is interpolated straight into the i18n key, so a
 * union member with no locale entry renders as the literal key string in the
 * detail rows and on the card. Exported so the label assertion drives THIS
 * function against the real locale bundles rather than re-deriving the key
 * template — the two i18n lint gates compare locales against each other and
 * cannot see a key the code needs and no locale carries.
 */
export function installSourceLabel(item: SafeMarketplaceCatalogItem, t: (key: string, options?: Record<string, unknown>) => string): string {
  return item.installed?.origin.marketplaceId ?? t(`plugins.sourceConfidence.${item.install.sourceConfidence}`)
}

export function unsupportedInstallReason(item: SafeMarketplaceCatalogItem, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t('plugins.unsupportedReason', {
    reason: t(`plugins.sourceConfidence.${item.install.sourceConfidence}`),
  })
}

/**
 * P2.518 unit 2 — the four activation states, spelled as LITERAL keys.
 *
 * `plugins.scopeGlobal` and its two siblings are translated sentences with a
 * `{{state}}` hole, and the hole was being filled with the raw union member. So
 * a Russian user read "Глобально: enabled" — a translated sentence with an
 * English enum inside it, which is the defect P2.518 names. `scopeEnabled` and
 * `scopeDisabled` are the translations that were always meant to fill it and
 * had never had a reader; `scopeUnset` and `scopeIneligible` are new, because
 * the union is four members wide and `unset` is the resting state of a plugin
 * nobody has switched in that scope.
 *
 * A MAP rather than `t(\`plugins.scope${…}\`)`, deliberately, and for two
 * reasons the composed form loses. It keeps all four keys as quoted literals
 * that `check-i18n-reachable` can see — a composed key is only reachable to that
 * scan through a derived dotted prefix, and this one has no dot to derive from.
 * And `Record<…, string>` over the union makes a fifth member a TYPE error here
 * rather than a raw enum leaking back onto the screen, which is how the first
 * one got through.
 */
const PLUGIN_SCOPE_STATE_KEYS: Record<'enabled' | 'disabled' | 'unset' | 'ineligible', string> = {
  enabled: 'plugins.scopeEnabled',
  disabled: 'plugins.scopeDisabled',
  unset: 'plugins.scopeUnset',
  ineligible: 'plugins.scopeIneligible',
}

export function activationLabel(
  activation: NonNullable<SafeMarketplaceCatalogItem['installed']>['activation'],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const state = (value: keyof typeof PLUGIN_SCOPE_STATE_KEYS): string => t(PLUGIN_SCOPE_STATE_KEYS[value])
  return [
    t('plugins.scopeGlobal', { state: state(activation.global) }),
    t('plugins.scopeWorkspace', { state: state(activation.workspace) }),
    ...(activation.project ? [t('plugins.scopeProject', { state: state(activation.project) })] : []),
  ].join(', ')
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === 'string' && error ? error : fallback
}

// A fresh install the server blocks outright has no pluginKey, so it can't
// key the per-plugin blocked outcome (see onInstall) — it surfaces via the
// action-error toast instead. The reason hint stays path-/secret-free: only
// externalKind/reasonCode from `deferred`.
//
// P2.518, unit 4, DECIDED at the close-out rather than left open: both values
// are interpolated RAW, so a kebab-case machine code reaches the user inside a
// translated sentence. A key-per-code was the obvious fix and is NOT possible —
// `reasonCode` is typed `string` (`protocol/capabilities.ts`), an OPEN set the
// server mints, so any vocabulary here is exhaustive only until the next server
// release and the miss would be silent, which is the same defect one layer
// along. The smallest honest thing instead: the SENTENCE now frames both values
// as identifiers (`<kind> not supported (code: <reason>)`) rather than as
// English, so a reader sees a code they can quote in a bug report instead of a
// half-translated line. Nothing is hidden and nothing is invented; the residue
// is that the code itself stays untranslated, deliberately.
function blockedInstallMessage(
  t: (key: string, options?: Record<string, unknown>) => string,
  deferred: SafeMarketplacePluginDeferredCapability[] | undefined,
  diagnosticCodes: string[] = [],
): string {
  const base = t('plugins.errorInstallBlocked')
  const first = deferred?.[0]
  if (!first) return diagnosticCodes[0] ? `${base} (${diagnosticCodes[0]})` : base
  return `${base} ${t('plugins.compatDeferredEntry', { kind: first.externalKind, reason: first.reasonCode })}`
}
