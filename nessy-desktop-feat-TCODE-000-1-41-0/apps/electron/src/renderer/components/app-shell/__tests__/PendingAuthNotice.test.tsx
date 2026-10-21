/**
 * T4 (plugin-install plan § 5): the session-start notice renders every server
 * needing auth with a non-interrupting sign-in — and renders NOTHING when
 * everything is ready (the positive control).
 *
 * Mutation probe: dropping the notice (View returning null for a non-empty
 * summary) turns the first block red; dropping the empty-check turns the
 * positive control red.
 *
 * W1 adds the PLACEMENT block: the notice is a card inside the conversation at
 * chat width, and no longer a shell-level strip above every view.
 */

import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeWorkspacePendingAuth } from '@nessy-agent/shared/protocol'
import type { CapabilityCatalogChangedEvent } from '@nessy-agent/shared/protocol/capabilities'
import {
  isPendingAuthNoticeEmpty,
  PendingAuthNotice,
  PendingAuthNoticeView,
  subscribePendingAuthRefresh,
  type PendingAuthRowState,
} from '../PendingAuthNotice'

/**
 * D1.110 — a FILE budget, sized against the MEASURED floor rather than bun's 5 s
 * default. The sixth and last of the class-(c) subprocess/graph-import suites.
 *
 * **This one was not prophylactic: it is RED alone at HEAD.** Measured
 * 2026-09-18 on this rig, load ~8, the same bytes three times:
 *
 *  - the ZERO-CASE control (`-t 'zzz-no-such-case-zzz'`, 0 cases executed):
 *    **23.05 s wall, user 0.76 / sys 0.28** — the module GRAPH costs 23 seconds
 *    at 4 % cpu before a single test body runs. That is I/O, not contention;
 *    `uptime` cannot see it, which is why the user/sys pair is quoted.
 *  - `--timeout 120000 --reporter=junit`: **17 pass / 0 fail, 62.19 s**, with
 *    every test BODY in milliseconds (the three largest: 21 ms, 27 ms, 68 ms) and
 *    **34.48 s** attributed to ONE describe block — the `readFileSync` of four
 *    renderer sources this file pins its placement claims against.
 *  - the plain run, alone: **16 pass / 1 fail, 45.57 s** —
 *    *"absent on Sources → MCPs BY CONSTRUCTION"* **timed out after 5000 ms**
 *    having taken **17 925 ms**. Nothing about that case is slow; it is the first
 *    body charged with the graph the two readings above price.
 *
 * So the budget belongs to the FILE and is sized against the largest per-test
 * charge observed (34.5 s), not against the case's own 68 ms — sizing from the
 * failure message would have set it against the wrong number and left the other
 * sixteen exposed to the identical mechanism.
 *
 * **60 000 is the family's number, not a fourth invented one:** the floor is
 * `load-stored-config-fail-closed.test.ts`'s `SPAWN_BUDGET_MS`, and
 * `cron-scheduler`, `user-settings-strict-report`, `session-mirror-settings` and
 * `powershell-cmdlet-gate` all carry it. NOT raised to
 * `MODULE_GRAPH_CASE_BUDGET_MS` (300 000): sizing up is a cost, and a hung case
 * still has to be heard about. Re-measure before lowering; a warm reading is not
 * a floor.
 */
setDefaultTimeout(60_000)

const translations = {
  'pendingAuth.connect': 'Connect',
  'pendingAuth.connecting': 'Connecting...',
  'pendingAuth.dismiss': 'Dismiss',
  'pendingAuth.dpOutdated': 'Spirit CLI (dp) is outdated and cannot run these servers — update dp, then reopen the workspace.',
  'pendingAuth.dpRow_one': 'Sign in to Developer Platform to enable {{count}} server.',
  'pendingAuth.dpRow_other': 'Sign in to Developer Platform to enable {{count}} servers.',
  'pendingAuth.dpSignIn': 'Sign in',
  'pendingAuth.dpSigningIn': 'Signing in...',
  'pendingAuth.error': 'Sign-in failed. Try again.',
  'pendingAuth.expiringSoon_one': '{{name}}: the stored credential expires in {{count}} day. Sign in again to renew it.',
  'pendingAuth.expiringSoon_other': '{{name}}: the stored credential expires in {{count}} days. Sign in again to renew it.',
  'pendingAuth.failedServers': 'Failed to connect: {{names}}.',
  'pendingAuth.sourceCredentialExpired': '{{name}}: the stored credential expired. Sign in again.',
  'pendingAuth.sourceCredentialMissing': '{{name}}: a credential is missing. Fill it in on the plugin\'s page.',
  'pendingAuth.sourceNeedsAuth': '{{name}} needs sign-in before it can be used.',
  'pendingAuth.title': 'Some sources need sign-in',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

function render(summary: SafeWorkspacePendingAuth, dpState: PendingAuthRowState = 'pending'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PendingAuthNoticeView
        summary={summary}
        dpState={dpState}
        busySourceSlug={null}
        errorSourceSlug={null}
        onDpSignIn={() => {}}
        onSourceSignIn={() => {}}
        onDismiss={() => {}}
      />
    </I18nextProvider>,
  )
}

const fullSummary: SafeWorkspacePendingAuth = {
  dp: { state: 'needs-login', serverNames: ['dp-1', 'dp-2', 'dp-3', 'dp-4', 'dp-5', 'dp-6', 'dp-7', 'dp-8', 'dp-9'] },
  sources: [
    { workspaceId: 'ws-1', sourceSlug: 'jira', name: 'Jira', reason: 'needs-auth', canSignIn: true },
    { workspaceId: 'ws-1', sourceSlug: 'internal-api', name: 'Internal API', reason: 'credential-missing', canSignIn: false },
  ],
  failedServers: ['broken-server'],
}

/** The event a plugin install publishes — the one nothing used to listen for. */
function changedEvent(workspaceId: string): CapabilityCatalogChangedEvent {
  return {
    workspaceId,
    generation: 'gen-2',
    reasonCode: 'plugin.installed',
    effect: 'refresh-before-next-turn',
  }
}

describe('P6.256 — the advance expiry warning', () => {
  const expiring: SafeWorkspacePendingAuth = {
    sources: [],
    failedServers: [],
    expiringSoon: [{ sourceSlug: 'jira', name: 'Jira', daysLeft: 3 }],
  }

  it('renders the warning on its own, which is the state the row exists for', () => {
    // Everything else in this summary reports something already broken. This is
    // the only row that fires while the session still works, so a component that
    // returned `null` for it would deliver nothing at all.
    expect(isPendingAuthNoticeEmpty(expiring)).toBe(false)
    const html = render(expiring)
    expect(html).toContain('Jira: the stored credential expires in 3 days.')
    expect(html).toContain('pending-auth-expiring-jira')
  })

  it('offers no Connect button, because the credential still works', () => {
    const html = render(expiring)
    const row = html.slice(html.indexOf('pending-auth-expiring-jira'))
    expect(row).not.toContain('<button')
  })

  it('is still empty when nothing is expiring — the positive control', () => {
    expect(isPendingAuthNoticeEmpty({ sources: [], failedServers: [], expiringSoon: [] })).toBe(true)
    expect(render({ sources: [], failedServers: [] })).toBe('')
  })
})

describe('PendingAuthNoticeView', () => {
  it('lists the dp set, every pending source and the broken server (the notice is NOT dropped)', () => {
    const html = render(fullSummary)
    // Mutation probe target: a dropped notice renders an empty string here.
    expect(html).toContain('Some sources need sign-in')
    expect(html).toContain('Sign in to Developer Platform to enable 9 servers.')
    expect(html).toContain('Jira needs sign-in before it can be used.')
    expect(html).toContain('Internal API: a credential is missing.')
    expect(html).toContain('Failed to connect: broken-server.')
  })

  it('offers one-click sign-in only where a flow exists', () => {
    const html = render(fullSummary)
    // The actionable Jira row has a Connect button…
    const jiraRow = html.slice(html.indexOf('pending-auth-source-jira'), html.indexOf('pending-auth-source-internal-api'))
    expect(jiraRow).toContain('<button')
    expect(jiraRow).toContain('Connect')
    // …the credential-parked capability row is informational.
    const parkedRow = html.slice(html.indexOf('pending-auth-source-internal-api'), html.indexOf('pending-auth-failed'))
    expect(parkedRow).not.toContain('<button')
  })

  it('positive control: an empty summary renders nothing at all', () => {
    const empty: SafeWorkspacePendingAuth = { sources: [], failedServers: [] }
    expect(isPendingAuthNoticeEmpty(empty)).toBe(true)
    expect(render(empty)).toBe('')
  })

  it('names an outdated dp as the cause when the broker reports it (T8)', () => {
    const html = render({ sources: [], failedServers: ['dpJira'], dpOutdated: true })
    expect(html).toContain('Failed to connect: dpJira.')
    expect(html).toContain('Spirit CLI (dp) is outdated')
  })

  it('says nothing about dp being outdated when the flag is absent', () => {
    const html = render({ sources: [], failedServers: ['dpJira'] })
    expect(html).toContain('Failed to connect: dpJira.')
    expect(html).not.toContain('Spirit CLI (dp) is outdated')
  })
})

/**
 * W1 — WHERE the notice is mounted (owner decision 2026-08-01, with a
 * screenshot: "да я включил, но вижу это сверху а не в самом чате в виде
 * карточки").
 *
 * It used to be mounted by `MainContentPanel`'s `wrapWithStoplight`, before
 * `{content}` — a full-bleed strip above EVERY view, stacked with
 * `SafeModeBanner` and `GatewayAuthBanner`. That is why it read as a banner.
 * The only mount is now `ChatDisplay`'s system-card stack, at the message
 * column's own width.
 *
 * These assertions are structural because the renderer cannot be mounted in
 * this runner — `ChatDisplay` transitively imports the `pdfjs-dist` chain that
 * takes bun's module loader down (measured: importing `@/config/layout` alone
 * fails with "Missing 'default' export in module .../pdf.worker.min.mjs?url").
 * Reading the source is the established fallback in this repo
 * (`plugins-browse-count.test.ts`, `plugins-tenant-filter.test.ts`, …). Each
 * case below carries its own positive control so a moved or emptied file
 * cannot pass as a fix.
 */
describe('W1 — the notice is a card in the chat, not a strip above the app', () => {
  const sourceOf = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  const chatDisplay = sourceOf('../ChatDisplay.tsx')
  const shell = sourceOf('../MainContentPanel.tsx')
  const notice = sourceOf('../PendingAuthNotice.tsx')
  const composer = sourceOf('../input/ChatInputZone.tsx')

  /**
   * The control column's gutter, as written on both sides. B1 replaced three
   * per-plate `px-3` wrappers with ONE wrapper that reads the same constants
   * the composer reads — pinning the expression on both files is what makes
   * plate-vs-composer drift fail here instead of in a screenshot.
   */
  const CONTROL_GUTTER = 'CHAT_LAYOUT.controlGutterCompact : CHAT_LAYOUT.controlGutter'

  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1

  /** `<PendingAuthNotice` as a MOUNT — not the `…View` the playground renders. */
  const MOUNT = /<PendingAuthNotice[\s/>]/g
  const mountCount = (source: string): number => (source.match(MOUNT) ?? []).length

  it('the chat mounts it at the SAME width as the message column and the composer', () => {
    // The mount exists, exactly once, in the chat surface.
    expect(mountCount(chatDisplay)).toBe(1)
    // ONE wrapper for the plate stack — three copies of a hand-rolled width fail here.
    expect(occurrences(chatDisplay, CONTROL_GUTTER)).toBe(1)
    // …and all three plates live inside that one wrapper, i.e. between the
    // gutter expression and the composer that follows it.
    const plateStack = chatDisplay.slice(
      chatDisplay.indexOf(CONTROL_GUTTER),
      chatDisplay.indexOf('<ChatInputZone'),
    )
    expect(plateStack).toMatch(MOUNT)
    expect(plateStack).toContain('<TaskChecklistPanel')
    expect(plateStack).toContain('<AgentPanel')
    // The composer reads the same two constants: that is the alignment claim,
    // and it is why a change to one side alone turns this red.
    expect(composer).toContain(CONTROL_GUTTER)
    expect(chatDisplay).toContain('CHAT_LAYOUT.maxWidth')
    // The scrolling message column is the width being matched.
    const messageColumn = chatDisplay.slice(
      chatDisplay.indexOf('<ScrollArea'),
      chatDisplay.indexOf('</ScrollArea>'),
    )
    expect(messageColumn).toContain('CHAT_LAYOUT.maxWidth')
    // …and the notice is NOT inside it: a card at the top of the list scrolls
    // away with the first turn, taking the only sign-in affordance with it.
    expect(mountCount(messageColumn)).toBe(0)
  })

  it('the shell wrapper renders no pending-auth strip above every view', () => {
    // Mutation target: returning the mount to `wrapWithStoplight` turns this
    // red. The name may still appear in prose there — the comment recording
    // WHY it is not mounted is the point — so this reads the JSX and the
    // import, not the word.
    expect(mountCount(shell)).toBe(0)
    expect(shell).not.toContain("from './PendingAuthNotice'")
    // Positive control on the same file: the two banners that legitimately
    // belong at shell level are still mounted there, so a zero above means
    // "removed", not "file moved / wrapper deleted".
    expect(shell).toContain('<SafeModeBanner />')
    expect(shell).toContain('<GatewayAuthBanner />')
  })

  it('absent on Sources → MCPs BY CONSTRUCTION — the chat is the only mount', () => {
    // Scan every renderer source: the component is instantiated once, in the
    // chat. No navigation predicate can therefore put it over the MCP list.
    const roots = fileURLToPath(new URL('../../..', import.meta.url))
    const mounts: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.tsx?$/.test(entry.name)) continue
        if (MOUNT.test(readFileSync(full, 'utf8'))) mounts.push(entry.name)
        MOUNT.lastIndex = 0
      }
    }
    walk(roots)
    expect(mounts).toEqual(['ChatDisplay.tsx'])

    // The nav-state gate that used to keep the strip off the MCP view is gone,
    // and so is the navigation type it needed.
    expect(occurrences(notice, 'isMcpServersNavigation(')).toBe(0)
    expect(occurrences(notice, 'export function PendingAuthNoticeForView')).toBe(0)
    expect(occurrences(notice, "from '../../../shared/types'")).toBe(0)
    // Positive control for those three absences: the exports that DO survive
    // are found by the same reads.
    expect(notice).toContain('export function PendingAuthNotice(')
    expect(notice).toContain('export function subscribePendingAuthRefresh(')
  })

  it('it renders as a card, not as the full-bleed strip it was', () => {
    const html = render(fullSummary)
    const root = html.slice(0, html.indexOf('>') + 1)
    expect(root).toContain('data-testid="pending-auth-notice"')
    // Card chrome — now OWNED by the SystemCard primitive, not copied. The
    // rendered string is the primitive's (v0.15.1's sunken well since UB14.40);
    // the source must not carry it.
    expect(root).toContain('rounded-lg border border-separator bg-sunken')
    expect(notice).toContain('<SystemCard')
    expect(occurrences(notice, 'rounded-lg border border-separator')).toBe(0)
    // Strip chrome — the bottom rule across the full width, the opaque shell
    // background, and the `shrink-0` that let it sit in the shell's flex
    // column — must all be gone.
    expect(root).not.toContain('border-foreground/10')
    expect(root).not.toContain('bg-background')
    expect(root).not.toContain('shrink-0')
    // It is still dismissible from the card.
    expect(html).toContain('aria-label="Dismiss"')
  })
})

/**
 * B1 (plugins-and-marketplace plan): installing a plugin with an OAuth server
 * changes neither `workspaceId` nor `activeSessionId`, so before this
 * subscription the summary was fetched exactly once and the Connect button —
 * the only sign-in affordance we ship — never appeared.
 *
 * Mutation probe: delete the `capabilities.onChanged` subscription (or its
 * `void refresh()` body) and the first case stays at 1 call instead of 2.
 */
describe('subscribePendingAuthRefresh (B1)', () => {
  const WORKSPACE = 'ws-1'

  /** Stub the preload seam and hand back the captured listener + unsubscribe count. */
  function installStub() {
    let listener: ((event: CapabilityCatalogChangedEvent) => void) | null = null
    let unsubscribed = 0
    const win = globalThis as unknown as { window?: unknown }
    win.window = {
      electronAPI: {
        capabilities: {
          onChanged(callback: (event: CapabilityCatalogChangedEvent) => void) {
            listener = callback
            return () => { unsubscribed += 1 }
          },
        },
      },
    }
    return {
      emit: (event: CapabilityCatalogChangedEvent) => { listener?.(event) },
      unsubscribeCount: () => unsubscribed,
    }
  }

  it('a capability change in this workspace re-runs refresh (2 calls, not 1)', () => {
    const stub = installStub()
    let calls = 0
    const refresh = () => { calls += 1 }

    // The mount fetch the existing effect already does.
    refresh()
    const unsubscribe = subscribePendingAuthRefresh(WORKSPACE, refresh)
    expect(calls).toBe(1)

    stub.emit(changedEvent(WORKSPACE))
    expect(calls).toBe(2)

    // React's cleanup must reach the preload unsubscribe, not leak a listener.
    unsubscribe()
    expect(stub.unsubscribeCount()).toBe(1)
  })

  it('boundary: a change in another workspace does not refetch', () => {
    const stub = installStub()
    let calls = 0
    subscribePendingAuthRefresh(WORKSPACE, () => { calls += 1 })

    stub.emit(changedEvent('ws-other'))
    expect(calls).toBe(0)
  })
})

/**
 * A minimal function-component harness: install a hook dispatcher, call the
 * component as a function, flush its effects.
 *
 * Why this exists. The repo ships no DOM and no `renderHook`, and
 * `renderToStaticMarkup` never runs effects — so the block above can only drive
 * the exported helper. That is not the same claim: with the component's
 * `useEffect(() => subscribePendingAuthRefresh(...))` DELETED, i.e. B1 reverted
 * to the behaviour it was filed against, that block stays 5 pass / 0 fail
 * (measured). The harness closes exactly that gap — it asserts the component
 * MOUNTS the subscription, which is the user-visible half.
 *
 * It supports only the hooks this component uses; it is a test seam, not a
 * renderer.
 */
type HookSlot = { value?: unknown; deps?: unknown[]; cleanup?: (() => void) | void }

const reactDispatcherRef = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher

function mountComponent<P>(Component: (props: P) => React.ReactNode, props: P) {
  const slots: HookSlot[] = []
  const pendingEffects: Array<{ slot: HookSlot; create: () => (() => void) | void }> = []
  let cursor = 0
  let output: React.ReactNode = null
  let renderQueued = false
  let unmounted = false

  const takeSlot = (): HookSlot => {
    const slot = slots[cursor] ?? (slots[cursor] = {})
    cursor += 1
    return slot
  }
  const depsChanged = (slot: HookSlot, deps: unknown[] | undefined): boolean =>
    !slot.deps || !deps || deps.length !== slot.deps.length
      || deps.some((dep, index) => !Object.is(dep, slot.deps?.[index]))

  const scheduleRender = () => { if (!unmounted) renderQueued = true }

  const dispatcher = {
    useState(initial: unknown) {
      const slot = takeSlot()
      if (!('value' in slot)) {
        slot.value = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const setState = (next: unknown) => {
        const previous = slot.value
        const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(previous) : next
        if (Object.is(value, previous)) return
        slot.value = value
        scheduleRender()
      }
      return [slot.value, setState]
    },
    useEffect(create: () => (() => void) | void, deps?: unknown[]) {
      const slot = takeSlot()
      if (!depsChanged(slot, deps)) return
      slot.deps = deps ? [...deps] : undefined
      pendingEffects.push({ slot, create })
    },
    useLayoutEffect(create: () => (() => void) | void, deps?: unknown[]) {
      dispatcher.useEffect(create, deps)
    },
    useMemo(factory: () => unknown, deps?: unknown[]) {
      const slot = takeSlot()
      if (depsChanged(slot, deps)) {
        slot.deps = deps ? [...deps] : undefined
        slot.value = factory()
      }
      return slot.value
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      return dispatcher.useMemo(() => fn, deps)
    },
    useRef(initial: unknown) {
      const slot = takeSlot()
      if (!('value' in slot)) slot.value = { current: initial }
      return slot.value
    },
    useDebugValue() {},
  }

  const renderPass = () => {
    const previous = reactDispatcherRef.current
    reactDispatcherRef.current = dispatcher
    cursor = 0
    try {
      output = Component(props)
    } finally {
      reactDispatcherRef.current = previous
    }
    while (pendingEffects.length > 0) {
      const effect = pendingEffects.shift()
      if (!effect) break
      if (typeof effect.slot.cleanup === 'function') effect.slot.cleanup()
      effect.slot.cleanup = effect.create()
    }
  }

  const renderLoop = () => {
    for (let pass = 0; pass < 25; pass += 1) {
      renderQueued = false
      renderPass()
      if (!renderQueued) return
    }
    throw new Error('mountComponent: render loop did not settle')
  }

  renderLoop()

  return {
    output: () => output,
    /** Let the component's promises resolve, then re-render if state moved. */
    flush: async (): Promise<void> => {
      for (let tick = 0; tick < 8; tick += 1) {
        await new Promise<void>(resolve => { setTimeout(resolve, 0) })
        if (renderQueued && !unmounted) renderLoop()
      }
    },
    unmount: () => {
      unmounted = true
      for (const slot of slots) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = undefined
      }
    },
  }
}

/**
 * B1's load-bearing arm: the MOUNTED component, not the helper.
 *
 * The user story is one event long — a plugin with an OAuth server is installed
 * mid-session, `workspaceId` and `activeSessionId` both stay put, and the
 * Connect button must appear anyway. So the assertions are the refetch COUNT
 * (1 → 2) and the rendered Connect affordance, both driven by a real
 * `capabilities.onChanged` emission into a mounted `PendingAuthNotice`.
 *
 * Mutation probe: delete `useEffect(() => subscribePendingAuthRefresh(...))`
 * from `PendingAuthNotice` and the first case fails at `fetchCount` 1 vs 2,
 * with the notice still rendering nothing.
 */
describe('PendingAuthNotice mount (B1)', () => {
  const WORKSPACE = 'ws-1'

  // This block writes a `window` global; leaving it behind would hand the next
  // file in a repository-wide run a half-stubbed preload.
  const priorWindow = (globalThis as unknown as { window?: unknown }).window
  afterEach(() => {
    ;(globalThis as unknown as { window?: unknown }).window = priorWindow
  })

  const nothingPending: SafeWorkspacePendingAuth = { sources: [], failedServers: [] }
  const afterFigmaInstall: SafeWorkspacePendingAuth = {
    sources: [
      { workspaceId: WORKSPACE, sourceSlug: 'figma', name: 'Figma', reason: 'needs-auth', canSignIn: true },
    ],
    failedServers: [],
  }

  /**
   * Stub the whole preload seam the component touches. `unsubscribe` really
   * drops the listener, as `ipcRenderer.removeListener` does — otherwise the
   * unmount arm would prove nothing.
   */
  function installPreloadStub(responses: SafeWorkspacePendingAuth[]) {
    let listener: ((event: CapabilityCatalogChangedEvent) => void) | null = null
    let unsubscribed = 0
    let fetches = 0
    const win = globalThis as unknown as { window?: unknown }
    win.window = {
      electronAPI: {
        getWorkspacePendingAuth(_workspaceId: string): Promise<SafeWorkspacePendingAuth> {
          const response = responses[Math.min(fetches, responses.length - 1)]
          fetches += 1
          return Promise.resolve(response)
        },
        capabilities: {
          onChanged(callback: (event: CapabilityCatalogChangedEvent) => void) {
            listener = callback
            return () => { unsubscribed += 1; listener = null }
          },
        },
      },
    }
    return {
      emit: (workspaceId: string) => { listener?.(changedEvent(workspaceId)) },
      fetchCount: () => fetches,
      unsubscribeCount: () => unsubscribed,
    }
  }

  const markup = (node: React.ReactNode): string =>
    renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)

  it('a capability change refetches and the Connect affordance appears without a session switch', async () => {
    const stub = installPreloadStub([nothingPending, afterFigmaInstall])
    const mounted = mountComponent(PendingAuthNotice, {
      workspaceId: WORKSPACE,
      activeSessionId: 'session-1',
    })

    await mounted.flush()
    expect(stub.fetchCount()).toBe(1)
    // Nothing pending yet, so the notice is absent — the pre-install state.
    expect(markup(mounted.output())).toBe('')

    stub.emit(WORKSPACE)
    await mounted.flush()

    expect(stub.fetchCount()).toBe(2)
    const html = markup(mounted.output())
    expect(html).toContain('Figma needs sign-in before it can be used.')
    expect(html).toContain('Connect')

    mounted.unmount()
  })

  // Absence arm. Its positive control is the case above: same stub, same
  // `emit` path, same mounted component — one workspace id refetches and the
  // other does not, so a silent listener cannot pass this as a false negative.
  it('boundary: a change in another workspace neither refetches nor renders', async () => {
    const stub = installPreloadStub([nothingPending, afterFigmaInstall])
    const mounted = mountComponent(PendingAuthNotice, {
      workspaceId: WORKSPACE,
      activeSessionId: 'session-1',
    })

    await mounted.flush()
    expect(stub.fetchCount()).toBe(1)

    stub.emit('ws-other')
    await mounted.flush()

    expect(stub.fetchCount()).toBe(1)
    expect(markup(mounted.output())).toBe('')

    mounted.unmount()
  })

  it('unmounting unsubscribes, so a later change does not refetch', async () => {
    const stub = installPreloadStub([nothingPending, afterFigmaInstall])
    const mounted = mountComponent(PendingAuthNotice, {
      workspaceId: WORKSPACE,
      activeSessionId: 'session-1',
    })

    await mounted.flush()
    expect(stub.unsubscribeCount()).toBe(0)

    mounted.unmount()
    expect(stub.unsubscribeCount()).toBe(1)

    stub.emit(WORKSPACE)
    await mounted.flush()
    expect(stub.fetchCount()).toBe(1)
  })
})
