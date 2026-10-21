/**
 * UB3.5 (H20) — model refresh after a re-auth, and the deferred-setup flag the
 * headless onboarding read must honour.
 *
 * Two mechanisms, each tested where it lives:
 *
 * 1. `createModelRefreshInBackground` (rpc/llm-connections.ts, upstream #820) —
 *    a re-auth can switch to an account with different model entitlements, so
 *    every credential-changing flow schedules exactly one fire-and-forget
 *    refresh and never lets a refresh failure fail the credential flow. The
 *    two sign-in completions (ChatGPT, Copilot) are pinned by a bounded
 *    source-text needle — driving them for real means a live provider, which
 *    is the sitting's business, not a unit test's.
 *
 * 2. `GET_AUTH_STATE` must honour "Setup later" (isSetupDeferred) — without the
 *    flag a headless/WebUI reload re-enters onboarding forever. The handler
 *    wiring is pinned by a source needle (registering the real handler here
 *    would couple this file to whichever test batch binds the credential
 *    manager first), and the flag's EFFECT is driven through the real
 *    getSetupNeeds + the real deferred-flag storage over the isolated
 *    NESSY_CONFIG_DIR the bun-test preload installs. No value here is a real
 *    credential.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createModelRefreshInBackground } from '../llm-connections'
import { getSetupNeeds } from '@nessy-agent/shared/auth'
import { setSetupDeferred, isSetupDeferred } from '@nessy-agent/shared/config'
import * as configStorage from '@nessy-agent/shared/config/storage'
import type { AuthState } from '@nessy-agent/shared/auth'

const LLM_CONNECTIONS_SOURCE = resolve(import.meta.dir, '..', 'llm-connections.ts')
const ONBOARDING_SOURCE = resolve(import.meta.dir, '..', 'onboarding.ts')

describe('UB3.5 — model refresh after a credential change', () => {
  it('positive: a credential change schedules exactly one model refresh', async () => {
    const refreshed: string[] = []
    const refresh = createModelRefreshInBackground(
      () => ({ refreshNow: async (slug: string) => { refreshed.push(slug) } }),
      () => {},
    )

    refresh('my-connection', 'ChatGPT auth')

    // The hook is fire-and-forget: it returns before the promise settles, so
    // yield one microtask turn before asserting the single scheduled refresh.
    await Promise.resolve()
    expect(refreshed).toEqual(['my-connection'])
  })

  it('a failing refresh is swallowed and warned about — never thrown into the credential flow', async () => {
    const warnings: string[] = []
    const refresh = createModelRefreshInBackground(
      () => ({ refreshNow: async () => { throw new Error('fetcher offline') } }),
      (message) => { warnings.push(message) },
    )

    expect(() => refresh('my-connection', 're-auth')).not.toThrow()
    await Promise.resolve()
    expect(warnings.some((w) => w.includes('fetcher offline') && w.includes('my-connection'))).toBe(true)
  })

  it('a refresh service that cannot even be reached is swallowed too', () => {
    const warnings: string[] = []
    const refresh = createModelRefreshInBackground(
      () => { throw new Error('service not initialized') },
      (message) => { warnings.push(message) },
    )

    expect(() => refresh('my-connection', 'validation')).not.toThrow()
    expect(warnings.some((w) => w.includes('service not initialized'))).toBe(true)
  })

  it('both sign-in completions and the validation arm schedule the refresh (source pin)', () => {
    const source = readFileSync(LLM_CONNECTIONS_SOURCE, 'utf-8')
    // The two re-auth sites — a sign-in that can change the account.
    expect(source).toContain("refreshModelsInBackground(flow.connectionSlug, 'ChatGPT auth')")
    expect(source).toContain("refreshModelsInBackground(connectionSlug, 'Copilot auth')")
    // The validation arm keeps its shouldRefreshModels gate.
    expect(source).toContain('refreshModelsInBackground(slug, \'validation\')')
    expect(source).toContain('if (result.shouldRefreshModels)')
  })
})

describe('UB3.5 — the headless onboarding read honours "Setup later"', () => {
  const authStateWithNeeds = {
    billing: {
      type: null,
      hasCredentials: false,
      apiKey: null,
      claudeOAuthToken: null,
      migrationRequired: false,
    },
  } as unknown as AuthState

  let configPath = ''
  let previous: string | null = null
  const seededConfig = JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null })

  beforeEach(() => {
    // The deferred flag lives in the stored config over the isolated
    // NESSY_CONFIG_DIR; seed a minimal file so the mutation has a subject,
    // restoring whatever was there.
    configPath = configStorage.getConfigPath()
    previous = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null
    if (!previous) writeFileSync(configPath, seededConfig)
  })

  afterEach(() => {
    if (previous === null) {
      if (existsSync(configPath)) rmSync(configPath)
    } else {
      writeFileSync(configPath, previous)
    }
  })

  it('negative control: with setup deferred, a state that still has needs reads fully configured — a headless reload does not re-enter onboarding', () => {
    expect(setSetupDeferred(true)).toBe(true)
    expect(isSetupDeferred()).toBe(true)

    const setupNeeds = getSetupNeeds(authStateWithNeeds, isSetupDeferred())
    expect(setupNeeds.needsBillingConfig).toBe(true) // the needs are real…
    expect(setupNeeds.isFullyConfigured).toBe(true) // …but "Setup later" wins
  })

  it('control: without the flag the same state reads NOT configured — the flag is what the handler passes, so it can fail', () => {
    setSetupDeferred(false)
    expect(isSetupDeferred()).toBe(false)

    const setupNeeds = getSetupNeeds(authStateWithNeeds, isSetupDeferred())
    expect(setupNeeds.needsBillingConfig).toBe(true)
    expect(setupNeeds.isFullyConfigured).toBe(false)
  })

  it('wiring pin: the onboarding handler passes the flag to getSetupNeeds', () => {
    const source = readFileSync(ONBOARDING_SOURCE, 'utf-8')
    expect(source).toContain('getSetupNeeds(authState, isSetupDeferred())')
  })
})
