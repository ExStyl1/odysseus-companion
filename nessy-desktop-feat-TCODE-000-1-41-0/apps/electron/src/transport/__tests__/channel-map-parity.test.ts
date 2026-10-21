import { describe, it, expect } from 'bun:test'
import type { ElectronAPI } from '../../shared/types'
import { CHANNEL_MAP } from '../channel-map'

type AnyFn = (...args: any[]) => any

type FunctionKeys<T> = {
  [K in keyof T]-?: Extract<T[K], AnyFn> extends never ? never : K
}[keyof T] & string

type BrowserPaneKeys = `browserPane.${FunctionKeys<ElectronAPI['browserPane']>}`
type PluginKeys = `plugin.${FunctionKeys<ElectronAPI['plugin']>}`
type MarketplaceKeys = `marketplace.${FunctionKeys<ElectronAPI['marketplace']>}`
type CapabilityKeys = `capabilities.${FunctionKeys<ElectronAPI['capabilities']>}`

// Methods excluded from CHANNEL_MAP because they are implemented directly in the preload
// (no IPC round-trip to the main process). Each reads local state or orchestrates client-side.
type ApiToChannelMapKeys = Exclude<
  FunctionKeys<ElectronAPI>,
  | 'performDpAuth'
  | 'cancelDpAuth'
  | 'performOAuth'
  | 'cancelOAuth'
  | 'getTransportConnectionState'
  | 'getRuntimeEnvironment'
  | 'onTransportConnectionStateChanged'
  | 'reconnectTransport'
  | 'isChannelAvailable'
  | 'getSystemWarnings' // reads env var set at startup — no IPC needed
  | 'isSafeModeSession' // reads the safe-mode env var directly — no IPC needed
  | 'getOdysseusSkillPrompt' // local skills catalog prompt; direct main-process IPC
  | 'getOdysseusStatus' // local composition bridge, direct main-process IPC
  | 'syncOdysseus'
  | 'launchOdysseusCli'
  | 'setOdysseusAppearance'
  | 'getKnowledgeView'
  | 'editKnowledge'
  | 'getKnowledgeAgent'
  | 'getKnowledgeDocument'
  | 'manageKnowledgeCatalog'
  | 'syncKnowledgeObsidian'
  | 'relaunchApp' // direct IPC to main process — not through WS RPC
  | 'removeWorkspace' // direct IPC to main process — modifies local config
  | 'importResourcesIntoRemoteWorkspace' // narrow trusted-main remote import
  | 'transferSessionToWorkspace' // direct IPC to main process — orchestrated remote transfer
  | 'onTransferProgress' // direct IPC listener — chunk upload progress
  | 'changeLanguage' // direct IPC to main process — syncs i18n language
  | 'getFilePath' // renderer-local — webUtils.getPathForFile, no IPC round-trip
  | 'saveTextFile' // direct IPC to main process — native save dialog + local write
  | 'getNessyGatewayJwt' // direct IPC to main process — reads local Nessy creds
  | 'ensureGatewayAuth' // direct IPC to main process — one-click gateway auth
  | 'cancelGatewayAuth' // direct IPC to main process — abort pending gateway auth
  | 'onGatewayAuthStatus' // direct IPC listener — gateway auth status codes
  | 'isCodexRuntimeEnabled' // direct IPC to main process — reads a feature flag
  | 'getProviderFlags' // direct IPC to main process — reads build-time provider flags
  | 'getWindowVibrancy' // reads a launch argument set by window-manager — no IPC needed (UB14.47)
> | BrowserPaneKeys | PluginKeys | MarketplaceKeys | CapabilityKeys
type ChannelMapKeys = keyof typeof CHANNEL_MAP & string

type AssertNever<T extends never> = true

// Compile-time guardrails: if these fail, CHANNEL_MAP and ElectronAPI drifted.
const _missingFromMap: AssertNever<Exclude<ApiToChannelMapKeys, ChannelMapKeys>> = true
const _extraInMap: AssertNever<Exclude<ChannelMapKeys, ApiToChannelMapKeys>> = true

void _missingFromMap
void _extraInMap

describe('CHANNEL_MAP runtime contract', () => {
  it('has valid entry kinds and channels', () => {
    for (const [method, entry] of Object.entries(CHANNEL_MAP)) {
      expect(typeof method).toBe('string')
      expect(entry.type === 'invoke' || entry.type === 'listener').toBe(true)
      expect(typeof entry.channel).toBe('string')
      expect(entry.channel.length).toBeGreaterThan(0)

      if (entry.type === 'listener') {
        expect((entry as any).transform).toBeUndefined()
      }
    }
  })

  it('contains at least one listener and one invoke entry', () => {
    const values = Object.values(CHANNEL_MAP)
    expect(values.some((entry) => entry.type === 'listener')).toBe(true)
    expect(values.some((entry) => entry.type === 'invoke')).toBe(true)
  })

  it('exposes only safe plugin and marketplace methods', () => {
    expect(Object.keys(CHANNEL_MAP).filter(key => key.startsWith('plugin.'))).toEqual([
      'plugin.manage',
    ])
    expect(Object.keys(CHANNEL_MAP).filter(key => key.startsWith('marketplace.'))).toEqual([
      'marketplace.list',
      'marketplace.content',
      'marketplace.components',
      'marketplace.proposeInstall',
      'marketplace.proposeMcpb',
      'marketplace.install',
      'marketplace.addRegistry',
      'marketplace.upgradeRegistry',
      'marketplace.removeRegistry',
      'marketplace.listRegistries',
      'marketplace.setRegistryAutoUpdate',
      'marketplace.enableOffer',
      // P6.563 — safe: the request names a workspace and nothing else.
      'marketplace.refreshRuntime',
    ])
    expect(Object.keys(CHANNEL_MAP).filter(key => key.startsWith('capabilities.'))).toEqual([
      'capabilities.getCatalog',
      'capabilities.getComposerCatalog',
      'capabilities.getDetail',
      'capabilities.listMcpTools',
      'capabilities.preview',
      'capabilities.summary',
      'capabilities.open',
      'capabilities.reveal',
      'capabilities.submitManagedEdit',
      'capabilities.onChanged',
      'capabilities.listTrustReviews',
      'capabilities.grantTrust',
      'capabilities.revokeTrust',
      'capabilities.detectProjectContributions',
    ])
  })
})
