/**
 * Pure install-affordance derivation for the marketplace browse cards (U5).
 *
 * Kept in its own module (no React / IPC / heavy transitive imports) so the
 * per-card install-progress logic is unit-testable without mounting the page.
 * `PluginsPage` re-exports these; the render path is unchanged.
 */

import type { MarketplaceCardInstallState } from '@/components/marketplace/MarketplaceBrowseCard'
import { marketplaceListingIdentity, type SafeMarketplaceCatalogItem } from '@/hooks/useMarketplaceItems'
import type {
  SafeMarketplacePluginDeferredCapability,
  SafePluginActivationTarget,
} from '@nessy-agent/shared/protocol/capabilities'

/**
 * Transient A7-carry install outcome (A9), tracked client-side per pluginKey
 * from the one-time INSTALL RPC result — see `useMarketplaceInstall.ts`
 * `describeInstallOutcome`. `deferred` is the safe externalKind/reasonCode
 * summary only; never a path.
 */
export interface InstallOutcome {
  blocked: boolean
  needsConfirmEnable: boolean
  deferred: SafeMarketplacePluginDeferredCapability[]
  /** Exact target requested for the suppressed activation; absent requires an explicit scope choice. */
  confirmationTarget?: SafePluginActivationTarget
}

/**
 * P2.155 — the install-SUCCESS reader for `compatibility.adapter.warnings`.
 *
 * That field is the adapter's non-gating record of what it dropped while still
 * importing the bundle: listing metadata with no runtime effect, deliberately
 * NOT a `deferred` entry (which would make the report `partial` and gate the
 * install behind a confirmation — right for a lost component, wrong for this).
 * Five adapters wrote it, it was persisted onto every installed manifest, and
 * until now nothing outside tests read it, so the drop was recorded and shown to
 * nobody.
 *
 * Returns the notice or nothing. It reports; it decides nothing — the caller's
 * success path is already committed by the time this is called, which is the
 * posture the field's contract asks for: visible on success, blocking nothing.
 * Codes are what crosses the RPC boundary (the messages name bundle paths), and
 * they are shown the same way `plugins.compatDeferredEntry` shows reason codes.
 */
export function installNotesNotice(
  result: { adapterWarnings?: readonly string[] },
  t: (key: string) => string,
): { title: string; description: string } | undefined {
  const codes = [...new Set(result.adapterWarnings ?? [])].filter(code => code.length > 0)
  if (codes.length === 0) return undefined
  return { title: t('plugins.toastInstalledNotes'), description: codes.join(', ') }
}

/** Prefer a one-shot mutation result, then reconstruct the same affordance
 * from persisted safe compatibility after reload/restart. */
export function installOutcomeFor(
  item: SafeMarketplaceCatalogItem,
  installOutcomes: Record<string, InstallOutcome>,
): InstallOutcome | undefined {
  if (!item.installed) return undefined
  const transient = installOutcomes[item.installed.pluginKey]
  if (transient) return transient
  const compatibility = item.installed.compatibility
  if (!compatibility) return undefined
  return {
    blocked: compatibility.state === 'blocked',
    needsConfirmEnable: compatibility.state === 'partial'
      && item.installed.activation.effective !== 'active',
    deferred: compatibility.deferred,
  }
}

export function isInstallable(item: SafeMarketplaceCatalogItem): boolean {
  return Boolean(item.id && item.listKind)
}

/**
 * Derive the browse card's install-affordance state from safe fields ALREADY
 * on the catalog item + the transient per-plugin install outcome. `installing`
 * is PER-CARD (Step 2 fix): only the card whose listing id matches the in-flight
 * install (`installingIdentity`) flips to `installing`; every other not-installed card
 * stays `not-installed` during that single install.
 */
export function deriveInstallState(
  item: SafeMarketplaceCatalogItem,
  installOutcomes: Record<string, InstallOutcome>,
  installingIdentity: string | null,
): MarketplaceCardInstallState {
  const outcome = installOutcomeFor(item, installOutcomes)
  if (outcome?.blocked) return 'blocked'
  if (item.installed) return 'installed'
  if (!isInstallable(item)) return 'blocked'
  if (installingIdentity !== null && marketplaceListingIdentity(item) === installingIdentity) return 'installing'
  return 'not-installed'
}
