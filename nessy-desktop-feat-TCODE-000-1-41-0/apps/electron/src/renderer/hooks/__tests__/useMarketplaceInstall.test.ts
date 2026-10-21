import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  SafeMarketplacePluginInstallRequest,
  SafeMarketplacePluginInstallResult,
  SafePluginActivationTarget,
} from '@nessy-agent/shared/protocol/capabilities'
import {
  PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY,
  PLUGIN_INSTALL_SCOPE_OFFERS,
  PLUGIN_SCOPES,
} from '@nessy-agent/shared/plugins/types'
import {
  addRegistryPayload,
  consumeConnectorAuthRequests,
  describeInstallOutcome,
  installScopeTarget,
} from '../useMarketplaceInstall.ts'

const pluginsPageSource = readFileSync(new URL('../../pages/PluginsPage.tsx', import.meta.url), 'utf8')

describe('connector auth handoff', () => {
  it('consumes every auth request for the active workspace', async () => {
    const calls: Array<{ workspaceId?: string; sourceSlug: string }> = []
    await consumeConnectorAuthRequests([
      { workspaceId: 'ws-1', sourceSlug: 'github' },
      { workspaceId: 'ws-1', sourceSlug: 'gmail' },
    ], 'ws-1', async ({ workspaceId, sourceSlug }) => {
      calls.push({ workspaceId, sourceSlug })
      return { success: true }
    })
    expect(calls).toEqual([
      { workspaceId: 'ws-1', sourceSlug: 'github' },
      { workspaceId: 'ws-1', sourceSlug: 'gmail' },
    ])
  })

  it('authenticates global connector requests sequentially in their exact workspaces', async () => {
    const calls: string[] = []
    await consumeConnectorAuthRequests([
      { workspaceId: 'ws-2', sourceSlug: 'github' },
      { workspaceId: 'ws-1', sourceSlug: 'gmail' },
    ], 'ws-1', async ({ workspaceId, sourceSlug }) => {
      calls.push(`${workspaceId}:${sourceSlug}`)
      return { success: true }
    })
    expect(calls).toEqual(['ws-2:github', 'ws-1:gmail'])
  })

  it('surfaces provider authentication failure', async () => {
    await expect(consumeConnectorAuthRequests(
      [{ workspaceId: 'ws-1', sourceSlug: 'github' }],
      'ws-1',
      async () => ({ success: false, error: 'cancelled' }),
    )).rejects.toThrow('cancelled')
  })
})

it('does not present a rejected repair as successful', () => {
  const repair = pluginsPageSource.indexOf('const result = await repairMutation.mutateAsync({')
  const rejected = pluginsPageSource.indexOf('if (!result.ok) {', repair)
  const success = pluginsPageSource.indexOf("toast.success(t('plugins.toastRepaired')", repair)
  expect(repair).toBeGreaterThanOrEqual(0)
  expect(rejected).toBeGreaterThan(repair)
  expect(success).toBeGreaterThan(rejected)
})

it('wires installed Marketplace component switches to the capability mutation', () => {
  expect(pluginsPageSource).toContain('useMarketplaceSetCapabilityEnabled(activeWorkspaceId)')
  expect(pluginsPageSource).toContain('setCapabilityEnabledMutation.mutateAsync({')
  expect(pluginsPageSource).toContain('onToggle={onDetailCapabilityToggle}')
  expect(pluginsPageSource).toMatch(/toGroups\([^)]*, \{ pendingCapabilityId \}\)/)
})

describe('safe marketplace install requests', () => {
  it('carry listing IDs and activation refs only', () => {
    const request: SafeMarketplacePluginInstallRequest = {
      source: { kind: 'listing', marketplaceId: 'internal', listingId: 'skill-1', listingKind: 'skills' },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    }
    expect(request).toEqual({
      source: { kind: 'listing', marketplaceId: 'internal', listingId: 'skill-1', listingKind: 'skills' },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })
    expect(JSON.stringify(request)).not.toMatch(/Root|Path|command|cache/i)
  })

  it('commits repository installs by opaque proposal ID', () => {
    const request: SafeMarketplacePluginInstallRequest = {
      source: { kind: 'proposal', proposalId: 'proposal-1' },
      activateIn: { kind: 'global' },
    }
    expect(request.source).toEqual({ kind: 'proposal', proposalId: 'proposal-1' })
  })
})

describe('describeInstallOutcome (A7-carry surfaced at the RPC boundary)', () => {
  function result(overrides: Partial<SafeMarketplacePluginInstallResult> = {}): SafeMarketplacePluginInstallResult {
    return { ok: true, diagnosticCodes: [], ...overrides }
  }

  it('drives the confirm-enable affordance for a partial install requiring confirmation', () => {
    const outcome = describeInstallOutcome(result({ state: 'partial', requiresConfirmation: true }))
    expect(outcome).toEqual({ blocked: false, needsConfirmEnable: true })
  })

  it('carries the exact requested activation target through partial confirmation', () => {
    const target: SafePluginActivationTarget = {
      kind: 'project',
      context: { workspaceId: 'ws-1', sessionId: 'session-1' },
    }
    const outcome = describeInstallOutcome(
      result({ state: 'partial', requiresConfirmation: true }),
      target,
    )
    expect(outcome).toEqual({
      blocked: false,
      needsConfirmEnable: true,
      confirmationTarget: target,
    })
  })

  it('drives the blocked affordance (no enable, show why) for a blocked install', () => {
    const outcome = describeInstallOutcome(result({
      state: 'blocked',
      deferred: [{ externalKind: 'unsupported-hook', reasonCode: 'unsupported-runtime' }],
    }))
    expect(outcome).toEqual({ blocked: true, needsConfirmEnable: false })
    expect(JSON.stringify(outcome)).not.toMatch(/path|Path/)
  })

  it('needs neither affordance for a fully supported install or one with no compatibility report', () => {
    expect(describeInstallOutcome(result({ state: 'supported' }))).toEqual({ blocked: false, needsConfirmEnable: false })
    expect(describeInstallOutcome(result())).toEqual({ blocked: false, needsConfirmEnable: false })
  })

  it('does not ask for a second enable step when a partial install is already consented', () => {
    expect(describeInstallOutcome(result({ state: 'partial' }))).toEqual({
      blocked: false,
      needsConfirmEnable: false,
    })
  })

  it('still recognizes a fresh install as blocked when the server returns no pluginKey', () => {
    // A brand-new install the server refuses to stage has no pluginKey to key
    // a per-plugin banner on (PluginsPage.onInstall) — the caller must fall
    // back to a page-level error instead of relying on `result.pluginKey`.
    const outcome = describeInstallOutcome(result({
      ok: false,
      state: 'blocked',
      deferred: [{ externalKind: 'unsupported-hook', reasonCode: 'unsupported-runtime' }],
    }))
    expect(outcome).toEqual({ blocked: true, needsConfirmEnable: false })
  })

  it('never classifies ok:false as installed, including an app-only partial compatibility report', () => {
    expect(describeInstallOutcome(result({ ok: false }))).toEqual({
      blocked: true,
      needsConfirmEnable: false,
    })
    expect(describeInstallOutcome(result({
      ok: false,
      state: 'partial',
      requiresConfirmation: true,
      diagnosticCodes: ['plugin.install.app_connector_metadata_missing'],
    }))).toEqual({ blocked: true, needsConfirmEnable: false })
  })
})

describe('addRegistryPayload (R3 dialog → ADD_REGISTRY mapping)', () => {
  it('maps gitRef → refName and passes sparsePaths through', () => {
    expect(addRegistryPayload({ source: 'openai/plugins', gitRef: 'v1.2.3', sparsePaths: ['plugins/codex'] })).toEqual({
      source: 'openai/plugins',
      refName: 'v1.2.3',
      sparsePaths: ['plugins/codex'],
    })
  })

  it('omits refName + sparsePaths when empty (additive-safe; no absolute path field)', () => {
    const payload = addRegistryPayload({ source: 'git@github.com:org/repo.git', gitRef: '', sparsePaths: [] })
    expect(payload).toEqual({ source: 'git@github.com:org/repo.git' })
    expect('refName' in payload).toBe(false)
    expect('sparsePaths' in payload).toBe(false)
    expect(JSON.stringify(payload)).not.toMatch(/installedRoot|catalogRoot|gitRef/)
  })
})

/**
 * P6.414 — the install-time scope choice (Q-den 50 = A).
 *
 * The wire already carried it: `SafeMarketplacePluginInstallRequest.activateIn`
 * reaches `service.install({ activateIn })` through `rpc/marketplace.ts`. What
 * was missing is the OFFER — the renderer picked a scope for the user from the
 * listing's kind. These pin the offer table and the mapping behind it.
 */
describe('P6.414 — the install scope is offered, not guessed', () => {
  it('maps each offered scope to the activation target the install request carries', () => {
    // `SafeCapabilityContextRef` requires `workspaceId` in every member — a
    // session id alone is not a context the renderer may send (W9-t, P6.752:
    // this literal shipped without it and `typecheck:electron` was red at HEAD).
    const context = { workspaceId: 'ws-1', sessionId: 'sess-1' } as const
    expect(installScopeTarget('user/global', 'ws-1', context)).toEqual({ kind: 'global' })
    expect(installScopeTarget('workspace', 'ws-1', context))
      .toEqual({ kind: 'workspace', workspaceId: 'ws-1' })
    expect(installScopeTarget('project', 'ws-1', context)).toEqual({ kind: 'project', context })
  })

  it('refuses a scope this context cannot target instead of silently widening it', () => {
    // The boundary that makes the offer honest: with no workspace open, and with
    // no project context, those choices resolve to `null` so a caller disables
    // them. Returning `{kind:'global'}` here would reinstate exactly the silent
    // substitution the offer replaces.
    expect(installScopeTarget('workspace', null, { workspaceId: 'ws-1', sessionId: 'sess-1' })).toBeNull()
    expect(installScopeTarget('project', 'ws-1', undefined)).toBeNull()
  })

  it('offers every scope the product HAS, each with copy in both locales', () => {
    expect(PLUGIN_INSTALL_SCOPE_OFFERS.map(offer => offer.scope)).toEqual([...PLUGIN_SCOPES])
    const keys = [
      ...PLUGIN_INSTALL_SCOPE_OFFERS.flatMap(offer => [offer.labelKey, offer.hintKey]),
      PLUGIN_INSTALL_SCOPE_NOT_SHARED_KEY,
    ]
    for (const locale of ['en', 'ru']) {
      const messages = JSON.parse(readFileSync(
        new URL(`../../../../../../packages/shared/src/i18n/locales/${locale}.json`, import.meta.url),
        'utf8',
      )) as Record<string, string>
      for (const key of keys) expect(messages[key]).toBeTruthy()
    }
  })
})
