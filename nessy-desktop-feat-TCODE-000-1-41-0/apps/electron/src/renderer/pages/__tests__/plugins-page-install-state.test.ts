/**
 * U5 Step 2 — deriveInstallState per-card install progress.
 *
 * The fold-forward fix: only the card whose listing install is IN FLIGHT flips
 * to `installing`; every other not-installed card stays `not-installed` during
 * that single install (the earlier global-pending behavior lit every card).
 * `deriveInstallState` lives in a pure sibling module, so this drives it
 * directly with safe catalog items — no renderer mount, no IPC, no stubs.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY,
  PLUGIN_INSTALL_SCOPE_OFFERS,
} from '@nessy-agent/shared/plugins/types'
import { marketplaceListingIdentity } from '@/hooks/useMarketplaceItems'
import { deriveInstallState, installNotesNotice, installOutcomeFor } from '../plugin-install-state'
import type { SafeMarketplaceCatalogItem } from '@/hooks/useMarketplaceItems'

function item(id: string, overrides: Partial<SafeMarketplaceCatalogItem> = {}): SafeMarketplaceCatalogItem {
  return {
    marketplaceId: 'internal',
    id,
    kind: 'skill',
    listKind: 'skills',
    name: id,
    version: '1.0.0',
    icon: { kind: 'symbol', name: 'skill' },
    capabilities: ['skill'],
    install: { sourceConfidence: 'primary' },
    ...overrides,
  }
}

describe('deriveInstallState per-card installing (U5 Step 2)', () => {
  it('marks ONLY the in-flight card installing; siblings stay not-installed', () => {
    const clicked = item('clicked')
    const other = item('other')
    expect(deriveInstallState(clicked, {}, marketplaceListingIdentity(clicked))).toBe('installing')
    expect(deriveInstallState(other, {}, marketplaceListingIdentity(clicked))).toBe('not-installed')
  })

  it('no install in flight → not-installed for an installable card', () => {
    expect(deriveInstallState(item('a'), {}, null)).toBe('not-installed')
  })

  it('installed items are never shown installing (even mid-install of another card)', () => {
    const installed = item('installed', {
      installed: { pluginKey: 'ns.plugin' } as SafeMarketplaceCatalogItem['installed'],
    })
    expect(deriveInstallState(installed, {}, marketplaceListingIdentity(item('clicked')))).toBe('installed')
  })

  it('unsupported (non-installable) card stays blocked, not installing', () => {
    const unsupported = item('bad', { id: '', install: { sourceConfidence: 'missing' } })
    expect(deriveInstallState(unsupported, {}, marketplaceListingIdentity(unsupported))).toBe('blocked')
  })

  it('does not mark an equal listing id from another marketplace as installing', () => {
    const clicked = item('shared', { marketplaceId: 'registry-a' })
    const collision = item('shared', { marketplaceId: 'registry-b' })
    expect(deriveInstallState(collision, {}, marketplaceListingIdentity(clicked))).toBe('not-installed')
  })

  it('reconstructs partial confirmation from persisted safe compatibility after reload', () => {
    const installed = item('partial', {
      installed: {
        pluginKey: 'internal.partial',
        activation: { effective: 'inactive' },
        compatibility: {
          state: 'partial',
          deferred: [{ externalKind: 'lsp', reasonCode: 'plugin.deferred.codex_lsp' }],
        },
      } as SafeMarketplaceCatalogItem['installed'],
    })
    expect(installOutcomeFor(installed, {})).toEqual({
      blocked: false,
      needsConfirmEnable: true,
      deferred: [{ externalKind: 'lsp', reasonCode: 'plugin.deferred.codex_lsp' }],
    })
    expect(installOutcomeFor({
      ...installed,
      installed: {
        ...installed.installed!,
        activation: { ...installed.installed!.activation, effective: 'active' },
      },
    }, {})?.needsConfirmEnable).toBe(false)
  })

  it('uses a preserved confirmation target and never recomputes a wider default', () => {
    const source = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
    const branchStart = source.indexOf('item.installed && installOutcome?.needsConfirmEnable')
    const branchEnd = source.indexOf(': item.installed ?', branchStart)
    const confirmationBranch = source.slice(branchStart, branchEnd)
    expect(source).toContain('const confirmationTarget = installOutcome?.confirmationTarget')
    expect(confirmationBranch).toContain('onConfirmEnable(item, confirmationTarget)')
    expect(confirmationBranch).not.toContain('defaultInstallScope')
  })

  it('turns the installed manifest\'s adapter warnings into a success-path notice', () => {
    // P2.155. `compatibility.adapter.warnings` was written by five adapters,
    // persisted onto every installed manifest, and read by nothing outside
    // tests — so a bundle whose listing metadata was dropped installed with the
    // drop recorded on disk and shown to no one. This is the reader.
    const notice = installNotesNotice(
      { adapterWarnings: ['plugin.format.codex_listing_metadata_dropped', 'plugin.format.codex_listing_metadata_dropped'] },
      key => key,
    )
    expect(notice).toEqual({
      title: 'plugins.toastInstalledNotes',
      description: 'plugin.format.codex_listing_metadata_dropped',
    })
  })

  it('says nothing when the importer dropped nothing', () => {
    // The boundary that keeps the field NON-gating: a clean install, and an
    // install that lost a component (which rides `deferred` and is reported by
    // the confirm-enable affordance instead), must both produce no notice here.
    // A notice on every install would train the user to ignore it.
    expect(installNotesNotice({}, key => key)).toBeUndefined()
    expect(installNotesNotice({ adapterWarnings: [] }, key => key)).toBeUndefined()
    expect(installNotesNotice({ adapterWarnings: [''] }, key => key)).toBeUndefined()
  })

  it('reports the notice AFTER the success toast on both install paths', () => {
    // The posture is the contract: visible on success, blocking nothing. A
    // notice raised before `reportPluginActivation` would read as the outcome of
    // the install rather than a footnote to it.
    const source = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
    for (const anchor of ['const onInstall = useCallback', 'const installProposal = useCallback']) {
      const start = source.indexOf(anchor)
      expect(start).toBeGreaterThan(-1)
      const flow = source.slice(start, source.indexOf('}, [', start))
      expect(flow).toContain('installNotesNotice(result, t)')
      expect(flow.indexOf('reportPluginActivation')).toBeLessThan(flow.indexOf('installNotesNotice'))
      expect(flow).not.toContain('if (notes) return')
    }
  })

  it('routes MCPB import through the no-argument native picker proposal', () => {
    const source = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
    const start = source.indexOf('const onPickMcpb = useCallback')
    const end = source.indexOf('const onInstallMcpbProposal', start)
    const pickerFlow = source.slice(start, end)
    expect(pickerFlow).toContain('window.electronAPI.marketplace.proposeMcpb()')
    expect(pickerFlow).not.toMatch(/filePath|sourcePath|getFilePath|openFolderDialog/)
    expect(source).toContain('data-testid="marketplace-import-mcpb"')
    expect(source).toContain('data-testid="mcpb-install-submit"')
  })
})

/**
 * P6.414 — the install scope is OFFERED, not derived.
 *
 * W9-e landed the model half (`ac0957ef5`): the wire has always carried
 * `activateIn`, `PLUGIN_INSTALL_SCOPE_OFFERS` is the list to render and
 * `installScopeTarget` is the one mapping behind it. What was missing is the
 * ASKING — PluginsPage computed a scope from the listing's kind and installed
 * without saying so, which is why `plugins.installScopeTitle` had no reader.
 *
 * The dialog is inline in PluginsPage and this package has no DOM harness, so
 * it is pinned the way every other PluginsPage affordance in this file is: the
 * source of the one render site, plus the keys resolved against the REAL
 * locales so the assertions are about what the user reads.
 */
describe('P6.414 — the install scope offer', () => {
  const source = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
  const locales = ['en', 'ru'].map(locale => JSON.parse(readFileSync(
    new URL(`../../../../../../packages/shared/src/i18n/locales/${locale}.json`, import.meta.url),
    'utf8',
  )) as Record<string, string>)
  const dialogStart = source.indexOf('data-testid="install-scope-dialog"')
  const dialog = source.slice(dialogStart, source.indexOf('</Dialog>', dialogStart))

  it('renders every offered scope and the not-shared sentence, and installs the CHOSEN one', () => {
    expect(dialogStart).toBeGreaterThan(-1)
    // The picker is derived from the shared list, never a second copy of it,
    // so a fourth PluginScope appears here without editing this file.
    expect(dialog).toContain('PLUGIN_INSTALL_SCOPE_OFFERS.map')
    expect(dialog).toContain('t(offer.labelKey)')
    expect(dialog).toContain('t(offer.hintKey)')
    expect(dialog).toContain('t(PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY)')
    expect(source).toContain("t('plugins.installScopeTitle')")
    // Confirm installs with the scope the user selected — not a re-derived one.
    expect(source).toContain('await onInstall(pending.item, pending.scope)')
    // Every key the dialog renders is real copy in BOTH locales.
    const keys = [
      'plugins.installScopeTitle',
      PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY,
      ...PLUGIN_INSTALL_SCOPE_OFFERS.flatMap(offer => [offer.labelKey, offer.hintKey]),
    ]
    for (const locale of locales) {
      for (const key of keys) expect(typeof locale[key]).toBe('string')
    }
  })

  it('never installs without asking, and disables an unreachable scope instead of substituting one', () => {
    // Both install entry points now REQUEST the offer. The bug this row closes
    // is a call site that hands `onInstall` a scope the user never saw.
    expect(source).not.toContain('onInstall(item, defaultInstallScope(')
    expect(source).toContain('onInstall: () => requestInstall(item),')
    expect(source).toContain('onInstall={requestInstall}')
    // A scope with no resolvable target is disabled where it is rendered...
    expect(dialog).toContain('const unavailable = activationTarget(offer.scope, activeWorkspaceId, capabilityContext) === null')
    expect(dialog).toContain('disabled={unavailable}')
    // ...and `defaultInstallScope` survives only as the PRE-selection, routed
    // through the fallback so the dialog never opens on a disabled row.
    expect(source).toContain('offerableScope(defaultInstallScope(item, hasProjectContext))')
    expect(source).not.toContain('function activationTarget(')
    expect(source).toContain('const activationTarget = installScopeTarget')
  })
})

/**
 * P6.245 — an administrator's own pre-install trust message.
 *
 * `settings-reference.md#plugintrustmessage`: "Add your organization's own text
 * to the plugin trust warning Claude Code shows before installation." The
 * vendored 2.1.247 CLI carries the name — re-measured 2026-09-12 (C3.252) with
 * the instrument named on both sides (C3.294): `grep -acF` 3 lines and
 * `grep -aoF … | wc -l` 3 occurrences, against `nessyNotARealSdkKey` → 0/0;
 * the reading was the same 3 at `2.1.233` — and its restrictive MANAGED filter does NOT copy
 * it — and its own rendering is in the interactive CLI UI this fork never
 * shows. So the host renders it, on the confirmation the user actually meets,
 * identically on all three runtimes.
 */
describe('P6.245 — the managed plugin trust message', () => {
  const source = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
  const en = JSON.parse(readFileSync(
    new URL('../../../../../../packages/shared/src/i18n/locales/en.json', import.meta.url),
    'utf8',
  )) as Record<string, string>

  it('renders the administrator\'s text VERBATIM on the pre-install confirmation', () => {
    // Read off the same list result `registryLoadErrors` rides, because it
    // describes the whole list rather than one row.
    expect(source).toContain("marketplace.data?.pages.at(-1)?.pluginTrustMessage")
    // Inside the install-scope dialog — the confirmation shown BEFORE the
    // install, which is what the page specifies.
    const dialogStart = source.indexOf('data-testid="install-scope-dialog"')
    const dialog = source.slice(dialogStart, source.indexOf('</Dialog>', dialogStart))
    expect(dialog).toContain('{managedTrustMessage && (')
    expect(dialog).toContain('{managedTrustMessage}')
    // The ONLY host string is the label saying whose text it is; the sentence
    // itself is interpolated raw, never through `t(...)` or a template.
    expect(dialog).toContain("t('plugins.managedTrustMessageTitle')")
    expect(typeof en['plugins.managedTrustMessageTitle']).toBe('string')
    expect(dialog).not.toMatch(/managedTrustMessage[^}\n]*\+/)
  })

  it('a policy that says nothing renders nothing', () => {
    // The managed-pair invariant, on the surface as well as on the wire: the
    // notice is behind a truthiness guard on the optional field, so a fleet with
    // no managed trust message sees exactly the dialog it saw before. There is
    // no default sentence anywhere to fall back to.
    const dialogStart = source.indexOf('data-testid="install-scope-dialog"')
    const dialog = source.slice(dialogStart, source.indexOf('</Dialog>', dialogStart))
    expect(dialog).toContain('{managedTrustMessage && (')
    expect(dialog).not.toContain('managedTrustMessage ??')
    expect(dialog).not.toContain('managedTrustMessage ||')
  })
})

