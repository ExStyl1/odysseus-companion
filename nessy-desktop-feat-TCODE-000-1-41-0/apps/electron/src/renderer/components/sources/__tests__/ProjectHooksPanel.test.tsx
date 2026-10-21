import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createProjectHooksLoader,
  hasCodexHookProjectionNotice,
  isProjectHookCapability,
  isProjectHooksContext,
  ProjectHooksList,
  ProjectHooksProjectionNotice,
  projectHookCapabilities,
  projectHookMutationRequest,
  setProjectHookEnabled,
} from '../ProjectHooksPanel'
import { CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE } from '@nessy-agent/shared/capabilities/views'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import type {
  SafeCapabilityContextRef,
  SafeCapabilityDiagnostic,
  SafeCapabilitySummary,
} from '@nessy-agent/shared/protocol/capabilities'

const marketplaceSource = readFileSync(
  fileURLToPath(new URL('../../../pages/PluginsPage.tsx', import.meta.url)),
  'utf8',
)
const projectHooksPanelSource = readFileSync(
  fileURLToPath(new URL('../ProjectHooksPanel.tsx', import.meta.url)),
  'utf8',
)

const contextA = { workspaceId: 'ws-1', sessionId: 'session-a' } as const
const contextB = { workspaceId: 'ws-1', sessionId: 'session-b' } as const

const projectHook: SafeCapabilitySummary = {
  key: 'hook::project::ws-1::project-a::.nessy/hooks.json',
  kind: 'hook',
  logicalName: 'SessionStart',
  displayName: 'Session start',
  description: 'Prepare the project session.',
  origin: 'native',
  scope: { kind: 'project', workspaceId: 'ws-1', projectKey: `p_${'a'.repeat(32)}` },
  state: 'review-required',
  readOnly: false,
  trustState: 'review-required',
  credentialState: 'not-required',
  selectedAsUnqualifiedAlias: false,
  diagnosticCodes: [],
}

const secondProjectHook: SafeCapabilitySummary = {
  ...projectHook,
  key: 'hook::project::ws-1::project-b::.nessy/hooks.json',
  logicalName: 'SessionStop',
  displayName: 'Session stop',
  scope: { kind: 'project', workspaceId: 'ws-1', projectKey: `p_${'b'.repeat(32)}` },
  state: 'active',
  trustState: 'trusted',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          'sourcesHooks.codexProjectionNotice': (en as Record<string, string>)['sourcesHooks.codexProjectionNotice']!,
          'sourcesHooks.noDescription': 'No description provided.',
          'sourcesHooks.toggleLabel': 'Toggle {{name}}',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
})

describe('ProjectHooksPanel contracts', () => {
  it('requires a session or project handle instead of a workspace-only context', () => {
    expect(isProjectHooksContext({ workspaceId: 'ws-1' })).toBe(false)
    expect(isProjectHooksContext(contextA)).toBe(true)
    expect(isProjectHooksContext({ workspaceId: 'ws-1', projectHandleId: 'project-a' })).toBe(true)
  })

  it('loads the full catalog and keeps only native project hooks', async () => {
    const pluginHook: SafeCapabilitySummary = {
      ...projectHook,
      key: 'plugin:hook:honey:session-start',
      origin: 'plugin',
      scope: { kind: 'workspace', workspaceId: 'ws-1' },
      trustState: 'not-required',
    }
    const skill: SafeCapabilitySummary = {
      ...projectHook,
      key: 'skill:honey',
      kind: 'skill',
    }
    const loader = createProjectHooksLoader(async context => {
      expect(context).toEqual(contextA)
      return { capabilities: [pluginHook, skill, projectHook] }
    })

    loader.activate(contextA)
    expect(await loader.load(contextA)).toEqual({ status: 'ready', hooks: [projectHook] })
    expect(isProjectHookCapability(projectHook)).toBe(true)
    expect(projectHookCapabilities([pluginHook, skill, projectHook])).toEqual([projectHook])
  })

  it('maps enable and disable to exact path-free grant and revoke requests', async () => {
    const granted: unknown[] = []
    const revoked: unknown[] = []
    const api = {
      grantTrust: async (request: unknown) => { granted.push(request) },
      revokeTrust: async (request: unknown) => { revoked.push(request) },
    }
    const request = projectHookMutationRequest(projectHook, contextA)

    await setProjectHookEnabled(api, projectHook, contextA, true)
    await setProjectHookEnabled(api, projectHook, contextA, false)

    expect(granted).toEqual([request])
    expect(revoked).toEqual([request])
    expect(JSON.stringify(request)).not.toMatch(/executableHash|pluginInstanceId|sourcePath|scope/)
  })

  it('ignores old-project responses after a context switch', async () => {
    const first = deferred<{ capabilities: SafeCapabilitySummary[] }>()
    const second = deferred<{ capabilities: SafeCapabilitySummary[] }>()
    const loader = createProjectHooksLoader((context: SafeCapabilityContextRef) => (
      'sessionId' in context && context.sessionId === contextA.sessionId
        ? first.promise
        : second.promise
    ))

    loader.activate(contextA)
    const firstLoad = loader.load(contextA)
    loader.activate(contextB)
    const secondLoad = loader.load(contextB)

    second.resolve({ capabilities: [secondProjectHook] })
    expect(await secondLoad).toEqual({ status: 'ready', hooks: [secondProjectHook] })
    first.resolve({ capabilities: [projectHook] })
    expect(await firstLoad).toEqual({ status: 'stale' })
  })

  it('invalidates an in-flight response during cleanup', async () => {
    const pending = deferred<{ capabilities: SafeCapabilitySummary[] }>()
    const loader = createProjectHooksLoader(() => pending.promise)

    loader.activate(contextA)
    const load = loader.load(contextA)
    loader.invalidate(contextA)
    pending.resolve({ capabilities: [projectHook] })

    expect(await load).toEqual({ status: 'stale' })
    expect(loader.isActive(contextA)).toBe(false)
  })

  it('renders an accessible switch with the hook name and persisted state', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <ProjectHooksList
          hooks={[secondProjectHook]}
          pendingKeys={new Set()}
          onSetEnabled={() => {}}
        />
      </I18nextProvider>,
    )

    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-label="Toggle Session stop"')
  })

  it('keeps concurrent hook mutations independently pending', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <ProjectHooksList
          hooks={[projectHook, secondProjectHook]}
          pendingKeys={new Set([projectHook.key, secondProjectHook.key])}
          onSetEnabled={() => {}}
        />
      </I18nextProvider>,
    )

    const toggles = [...html.matchAll(/<button\b[^>]*data-testid="project-hook-toggle"[^>]*>/g)]
    expect(toggles).toHaveLength(2)
    expect(toggles.every(match => match[0].includes('disabled=""'))).toBe(true)
  })

  it('clears stale hook controls when a refresh fails', () => {
    expect(projectHooksPanelSource).toMatch(
      /if \(result\.status === 'ready'\)[\s\S]*?} else {\s*setHooks\(\[\]\)\s*setError\(/,
    )
  })

  it('reads the codex hook-projection notice off the catalog it already loads', async () => {
    const diagnostic: SafeCapabilityDiagnostic = {
      severity: 'info',
      code: CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE,
      messageKey: CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE,
    }
    expect(hasCodexHookProjectionNotice([diagnostic])).toBe(true)
    expect(hasCodexHookProjectionNotice([{ ...diagnostic, code: 'plugin.user_config.unset' }])).toBe(false)
    expect(hasCodexHookProjectionNotice([])).toBe(false)
    expect(hasCodexHookProjectionNotice(undefined)).toBe(false)

    const codex = createProjectHooksLoader(async () => ({ capabilities: [projectHook], diagnostics: [diagnostic] }))
    codex.activate(contextA)
    expect(await codex.load(contextA))
      .toEqual({ status: 'ready', hooks: [projectHook], projectionNotice: true })
  })

  it('says WHY on a project with no hooks at all, which is where an empty list lies loudest', async () => {
    const diagnostic: SafeCapabilityDiagnostic = {
      severity: 'info',
      code: CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE,
      messageKey: CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE,
    }
    const empty = createProjectHooksLoader(async () => ({ capabilities: [], diagnostics: [diagnostic] }))
    empty.activate(contextA)
    expect(await empty.load(contextA)).toEqual({ status: 'ready', hooks: [], projectionNotice: true })

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <ProjectHooksProjectionNotice />
      </I18nextProvider>,
    )
    expect(html).toContain('data-testid="project-hooks-projection-notice"')
    // Both halves of the owner's sentence: what is NOT projected, and why.
    expect(html).toContain('NOT projected here')
    expect(html).toContain('we neither wrote nor can revoke')
    expect(html).toContain('They still run host-side')
  })

  it('renders the notice panel-level, above every list state and outside the empty branch', () => {
    const panel = projectHooksPanelSource.slice(projectHooksPanelSource.indexOf('export function ProjectHooksPanel'))
    const notice = panel.indexOf('<ProjectHooksProjectionNotice />')
    const loading = panel.indexOf("sourcesHooks.loading")
    const empty = panel.indexOf("sourcesHooks.empty")
    const list = panel.indexOf('<ProjectHooksList')
    expect(notice).toBeGreaterThan(-1)
    expect(notice).toBeLessThan(loading)
    expect(notice).toBeLessThan(empty)
    expect(notice).toBeLessThan(list)
    // Rendered on its own condition, never nested inside the zero-hooks branch:
    // the case the notice exists for is the project that has no hooks to list.
    expect(panel).toMatch(/\{projectionNotice && <ProjectHooksProjectionNotice \/>\}/)
    expect(panel).not.toMatch(/hooks\.length === 0[\s\S]{0,400}ProjectHooksProjectionNotice/)
  })

  it('keeps all trust controls out of Marketplace', () => {
    expect(marketplaceSource).not.toMatch(/TrustReview|ProjectHooksPanel|listTrustReviews|grantTrust|revokeTrust/)
  })
})
