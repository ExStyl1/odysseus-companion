/**
 * Source: v0.15.1:apps/electron/src/renderer/pages/settings/__tests__/ai-settings-loader.test.ts (UB15.10; ADDED in
 * v0.15.0), rebased onto OUR pick of the AI page's first reads.
 *
 * Upstream's three cases are kept, each re-pointed where it read `enable1M` (the Extended context switch is gone,
 * F1.1241): the snapshot waits for the connection list AND the credential banner; a slow workspace lookup does not
 * serialise the reads behind it; an RPC failure rejects instead of presenting invented healthy credentials. Two arms
 * are ours: the snapshot carries exactly our pick and never `enable1M` (and never asks for it), and the output-style
 * list is read for the workspace the page is showing.
 *
 * The page half is pinned by SOURCE match (no DOM in this repo; importing `AiSettingsPage` drags the
 * `@nessy-agent/ui` barrel's pdfjs `?url` chain, see `ai-settings-reconnect.test.ts`): the page draws v0.15.1's
 * three-block skeleton inside `SettingsPage` until the one snapshot lands, and reads none of the snapshot's values
 * one by one beside it — the sequential reads are what inserted sections above visible controls.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'
import { loadAiSettings } from '../ai-settings-loader'

type Api = Parameters<typeof loadAiSettings>[0]
const api = (): Api => ({
  getWorkspaces: async () => [],
  getDefaultThinkingLevel: async () => 'medium',
  getOutputStyle: async () => 'default',
  listOutputStyles: async () => [],
  getExtendedPromptCache: async () => false,
  getRtkEnabled: async () => false,
  getRtkStatus: async () => ({ installed: false, version: null, path: null, outdated: false, minSafeVersion: '1.0.0', foundPath: null }),
  getGuardianEnabled: async () => true,
  getGuardianModel: async () => '',
  getGuardianModelsByConnection: async () => ({}),
  getAdvisorEnabled: async () => false,
  getAdvisorModel: async () => '',
  getCodexAutoReviewEnabled: async () => false,
  getCodexAutoReviewPolicy: async () => '',
  getCodexSubagentsEnabled: async () => true,
  getCredentialHealth: async () => ({ healthy: true, issues: [] }),
})

describe('initial AI settings snapshot', () => {
  it('waits for both connection hydration and the credential banner', async () => {
    let releaseConnections!: () => void
    let releaseHealth!: (value: Awaited<ReturnType<Api['getCredentialHealth']>>) => void
    let resolved = false
    const loading = loadAiSettings({ ...api(), getCredentialHealth: () => new Promise(resolve => { releaseHealth = resolve }) },
      () => new Promise<void>(resolve => { releaseConnections = resolve })).then(value => { resolved = true; return value })
    await Promise.resolve()
    expect(resolved).toBe(false)
    releaseConnections()
    await Promise.resolve()
    expect(resolved).toBe(false)
    releaseHealth({ healthy: true, issues: [] })
    const settings = await loading
    expect(settings.health).toEqual({ healthy: true, issues: [] })
    // One of OUR reads arrives in the same snapshot (codex's own delegation default).
    expect(settings.codexSubagentsEnabled).toBe(true)
  })

  it('does not serialize independent settings behind a slow workspace lookup', async () => {
    let release!: (value: []) => void
    let healthStarted = false
    let codexSubagentsStarted = false
    const loading = loadAiSettings({ ...api(), getWorkspaces: () => new Promise(resolve => { release = resolve }),
      getCodexSubagentsEnabled: async () => { codexSubagentsStarted = true; return true },
      getCredentialHealth: async () => { healthStarted = true; return { healthy: true, issues: [] } } }, async () => {})
    expect(healthStarted).toBe(true)
    expect(codexSubagentsStarted).toBe(true)
    release([])
    await loading
  })

  it('propagates RPC failure instead of presenting invented healthy credentials', async () => {
    await expect(loadAiSettings({ ...api(), getCredentialHealth: async () => { throw new Error('offline') } }, async () => {})).rejects.toThrow('offline')
  })

  it('carries exactly our pick — never enable1M, and never asks for it (F1.1241)', async () => {
    let asked1M = false
    // A host that still exposes the retired channel: the loader must not read it.
    const withRetired = { ...api(), getEnable1MContext: async () => { asked1M = true; return true } }
    const settings = await loadAiSettings(withRetired, async () => {})
    expect(asked1M).toBe(false)
    expect('enable1M' in settings).toBe(false)
    expect(Object.keys(settings).sort()).toEqual([
      'advisorEnabled', 'advisorModel', 'codexAutoReviewEnabled', 'codexAutoReviewPolicy', 'codexSubagentsEnabled',
      'extendedCache', 'guardianEnabled', 'guardianModel', 'guardianModels', 'health', 'outputStyle', 'outputStyles',
      'rtkEnabled', 'rtkStatus', 'thinking', 'workspaces',
    ])
  })

  it('lists the output styles of the workspace the page shows, and of none when it has none', async () => {
    const asked: Array<string | undefined> = []
    const listing = { ...api(), listOutputStyles: async (workspaceId?: string) => { asked.push(workspaceId); return [] } }
    await loadAiSettings(listing, async () => {}, 'ws-1')
    await loadAiSettings(listing, async () => {})
    expect(asked).toEqual(['ws-1', undefined])
  })
})

describe('the AI page reveals the snapshot at once (source match)', () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
  const page = read('../AiSettingsPage.tsx')
  const loader = read('../ai-settings-loader.ts')
  /** Every first read the snapshot owns (the row's pick). */
  const PICK = [
    'getWorkspaces', 'getDefaultThinkingLevel', 'getOutputStyle', 'listOutputStyles', 'getExtendedPromptCache',
    'getRtkEnabled', 'getRtkStatus', 'getGuardianEnabled', 'getGuardianModel', 'getGuardianModelsByConnection',
    'getAdvisorEnabled', 'getAdvisorModel', 'getCodexAutoReviewEnabled', 'getCodexAutoReviewPolicy',
    'getCodexSubagentsEnabled', 'getCredentialHealth',
  ] as const

  it('POSITIVE — until it lands, the page is SettingsPage around three Skeleton blocks in a status region', () => {
    expect(page.match(/\bloadAiSettings\(/g)?.length).toBe(1)
    const loading = bracedRegion(page, page.indexOf('if (settingsLoading) {'))
    expect(loading).toContain('<SettingsPage')
    expect(loading).toContain(`role="status" aria-label={t('common.loading')}`)
    expect(loading.match(/<Skeleton className=/g)?.length).toBe(3)
    // Boundary control: the revealed page (its first child, the health banner) sits BELOW the loading branch.
    expect(loading).not.toContain('<CredentialHealthBanner')
  })

  it('NEGATIVE — the page reads none of the pick one by one; the loader reads every one', () => {
    for (const name of PICK) {
      expect({ name, inLoader: loader.includes(`api.${name}(`) }).toEqual({ name, inLoader: true })
    }
    // The one direct read left is ours (T9): the gateway reconnect re-reads health after the dp flow.
    const direct = PICK.filter(name => page.includes(`electronAPI.${name}(`))
    expect(direct).toEqual(['getCredentialHealth'])
    expect(page.match(/electronAPI\.getCredentialHealth\(/g)?.length).toBe(1)
    const reconnect = bracedRegion(page, page.indexOf('const handleReconnectGateway = useCallback('))
    expect(reconnect).toContain('electronAPI.getCredentialHealth(')
    // Boundary control: the banner's re-authenticate handler is declared BELOW the reconnect handler.
    expect(reconnect).not.toContain('const handleReauthenticate = useCallback(')
  })
})
