/**
 * UB14.37 (R6-08) — the onboarding registry (`registry/onboarding.tsx`), every state rendered for real in DARK inside
 * the playground's own entry frame by one child process (`fixtures/onboarding-entries-probe.ts`; the recipe and its
 * reasons are `dialog-entries-probe.ts`'s). What a reviewer sees on the playground: each step on v0.15.1's paper
 * card over the navigator canvas, a left-aligned serif display title, Continue the solid-accent primary and Back a
 * ghost of the same size, the provider tiles on a hairline ring with OUR card set and OUR `currentColor` marks, the
 * API-setup tiles and segments on the accent/floating recipe, the ChatGPT step's notes on their tints, and the
 * reauth screen with a primary login and a ghost reset. Before the row no step drew the card, every title was a
 * centred `text-lg font-semibold`, Continue and Back carried a `bg-background`/`bg-foreground-2 shadow-minimal`
 * override that won over the variant's fill, and the wizard sat on `bg-foreground-2` — so every POSITIVE fails on
 * that tree.
 *
 * The three entries this row ADDED (`credentials-step-chatgpt`, `local-model-step`, `reauth-screen`) close the
 * surfaces the playground had no state for. Children another row restyles (`ApiKeyInput` UB14.38, `ByoRuntimeStep`
 * UB14.40, `OAuthConnect` and the flow demo, both unchanged upstream) keep their own classes, so the v0.14-class
 * NEGATIVE reads only the entries whose whole tree this row owns.
 *
 * UB14.40 (R6-11) adds its own describe at the bottom over the same renders: the four personal-key form entries, and
 * the two entries it ADDED — `gateway-connect-step` (the zero-form gateway step, every state a prop of its view) and
 * `model-catalog-picker` (the form's catalog list on its own, with verdicts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { ONBOARDING_ENTRIES_MARKER, type OnboardingEntryRender } from './fixtures/onboarding-entries-probe'

const CHILD = new URL('./fixtures/onboarding-entries-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../', import.meta.url).pathname
const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>

let renders: OnboardingEntryRender[] = []
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'onboarding-entries-probe-'))
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: REPO_ROOT,
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => child.kill(), MODULE_GRAPH_HOOK_BUDGET_MS - 30_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(killer)
  const at = stdout.lastIndexOf(ONBOARDING_ENTRIES_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`onboarding-entries probe exited ${exitCode} without renders:\n${stderr.slice(-4000)}`)
  }
  renders = JSON.parse(stdout.slice(at + ONBOARDING_ENTRIES_MARKER.length)) as OnboardingEntryRender[]
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const label = (render: OnboardingEntryRender) => `${render.id} · ${render.variant ?? '(base state)'}`
const statesOf = (id: string) => renders.filter(render => render.id === id)
const one = (id: string, variant: string | null): string => {
  const render = renders.find(r => r.id === id && r.variant === variant)
  expect({ id, variant, found: !!render?.markup }).toEqual({ id, variant, found: true })
  return render!.markup!
}
/** Every `Button` (data-slot) in the markup whose visible text ends with `name`. */
const buttonsNamed = (markup: string, name: string) =>
  (markup.match(/<button data-slot="button"[^>]*>[\s\S]*?<\/button>/g) ?? []).filter(b => b.endsWith(`>${name}</button>`))
const openingTag = (button: string) => button.slice(0, button.indexOf('>') + 1)

const PAPER_CARD = '<div class="flex w-full flex-col rounded-xl bg-paper shadow-elev-1 px-7 pt-7 pb-6 max-sm:bg-transparent max-sm:shadow-none max-sm:px-1 max-sm:pt-2">'
const SERIF_TITLE = /<h1 class="step-title font-serif text-display text-foreground text-balance">/
/** The entries whose WHOLE rendered tree this row restyles (no child left to another row). */
const OWNED = ['provider-select-step', 'welcome-step', 'api-setup-step', 'credentials-step-chatgpt', 'completion-step', 'git-bash-warning', 'local-model-step', 'reauth-screen']

describe('the onboarding registry, every state in dark (UB14.37)', () => {
  it('every state is swept, none threw, the three added entries are there, and the registry is in the index', () => {
    expect(renders.length).toBe(82) // 71 + UB14.40's gateway step (6) and model catalog picker (5)
    expect(renders.filter(render => render.error).map(render => `${label(render)}: ${render.error}`)).toEqual([])
    expect(renders.filter(render => !render.markup?.trim()).map(label)).toEqual([])
    expect(statesOf('credentials-step-chatgpt').map(label)).toEqual([
      'credentials-step-chatgpt · (base state)', 'credentials-step-chatgpt · Codex runtime - Idle',
      'credentials-step-chatgpt · Codex runtime - Validating', 'credentials-step-chatgpt · Pi - Success', 'credentials-step-chatgpt · Pi - Error',
    ])
    expect(statesOf('local-model-step').map(label)).toEqual(['local-model-step · (base state)', 'local-model-step · Validating', 'local-model-step · Error'])
    expect(statesOf('reauth-screen').map(label)).toEqual(['reauth-screen · (base state)'])
    const index = readFileSync(join(import.meta.dir, '../registry/index.ts'), 'utf8')
    expect(index).toContain("import { onboardingComponents } from './onboarding'")
    expect(index).toContain('...onboardingComponents,')
  })

  it('POSITIVE — every step state draws the paper card and a left-aligned serif display title', () => {
    const steps = renders.filter(render => render.markup!.includes('step-title'))
    // Every entry but the Claude import panel and the bare catalog picker is a StepFormLayout step (the byo-runtime
    // forms, the gateway step and the flow demo too).
    const notSteps = new Set(['claude-import-panel', 'model-catalog-picker'])
    expect([...new Set(steps.map(render => render.id))]).toEqual([...new Set(renders.map(render => render.id))].filter(id => !notSteps.has(id)))
    for (const render of steps) {
      const markup = render.markup!
      expect(markup, label(render)).toContain(PAPER_CARD)
      expect(markup, label(render)).toMatch(SERIF_TITLE)
      // The header block right before the title: not centred.
      expect(markup.match(/<div class="([^"]*)"><h1 class="step-title/)?.[1], label(render)).toBe('')
    }
  })

  it('POSITIVE — every Continue is the solid-accent primary at lg and every Back a ghost at lg, in every state that draws one', () => {
    const all = renders.map(render => render.markup!).join('\n')
    const continues = buttonsNamed(all, 'Continue')
    const backs = buttonsNamed(all, 'Back')
    expect(continues.length).toBeGreaterThan(10)
    expect(backs.length).toBeGreaterThan(10)
    for (const button of continues) {
      expect(openingTag(button)).toContain('data-variant="primary"')
      expect(openingTag(button)).toContain('bg-accent-solid text-on-accent')
      expect(openingTag(button)).toContain('h-control-lg')
    }
    for (const button of backs) {
      expect(openingTag(button)).toContain('data-variant="ghost"')
      expect(openingTag(button)).toContain('h-control-lg')
      expect(openingTag(button)).not.toContain('bg-foreground-2')
    }
  })

  it('POSITIVE — the provider step keeps OUR cards and marks on the v0.15.1 tile', () => {
    const markup = one('provider-select-step', null)
    // Before the provider flags resolve, the default-on set: the Pi gateway, the cloud agent, the custom endpoint.
    const names = [...markup.matchAll(/<span class="block text-label font-medium text-foreground">([^<]*)<\/span>/g)].map(m => m[1])
    expect(names).toEqual([
      EN['onboarding.providerSelect.nessyPi'], EN['onboarding.providerSelect.nessyCloud'], EN['onboarding.providerSelect.customRuntime'],
    ].map(name => name.replace(/&/g, '&amp;')))
    const tiles = markup.match(/<button type="button" class="motion-press flex w-full min-h-\[52px\][^"]*"/g) ?? []
    expect(tiles.length).toBe(3)
    for (const tile of tiles) expect(tile).toContain('ring-1 ring-inset ring-border hover:bg-fill-hover active:bg-fill-pressed')
    // The one-line description: shown at every width, truncated, its full text on `title`.
    expect(markup).toContain(`<span class="block truncate text-label-sm text-secondary" title="${EN['onboarding.providerSelect.nessyPiDesc']}">`)
    // The brand mark above the card and the two Nessy marks are NessySymbol in the accent; the custom card a line icon.
    expect(markup).toContain('<div class="mb-4 shrink-0"><svg viewBox="0 0 24 24" class="h-7 text-accent"')
    expect(markup.match(/<svg viewBox="0 0 24 24" class="size-6 text-accent"/g)?.length).toBe(2)
    expect(markup).toContain('class="lucide lucide-server size-6 p-0.5"')
    expect(markup).toContain(`<button type="button" class="min-h-6 text-label text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent">${EN['onboarding.providerSelect.setupLater']}</button>`)
  })

  it('NEGATIVE — the provider step adds no ProviderMark: no <img> mark, no CSS-mask mark, no mobile-hidden description', () => {
    const markup = one('provider-select-step', null)
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('mask-image')
    expect(markup).not.toContain('hidden sm:block')
    expect(markup).not.toContain('rounded-xl bg-foreground-2 p-3')
  })

  it('POSITIVE — the wizard and the reauth screen sit on the navigator canvas; reauth: login primary, reset ghost', () => {
    for (const render of statesOf('onboarding-wizard')) expect(render.markup!, label(render)).toStartWith('<div class="bg-navigator overflow-y-auto')
    const reauth = one('reauth-screen', null)
    expect(reauth).toStartWith('<div class="flex min-h-screen flex-col bg-navigator">')
    expect(reauth).toContain('<div class="flex size-16 items-center justify-center rounded-full bg-info-tint">')
    expect(openingTag(buttonsNamed(reauth, EN['onboarding.reauth.loginWithNessy'])[0] ?? '')).toContain('data-variant="primary"')
    const reset = openingTag(buttonsNamed(reauth, EN['onboarding.reauth.resetApp'])[0] ?? '')
    expect(reset).toContain('data-variant="ghost"')
    expect(reset).toContain('h-control-lg')
  })

  it('POSITIVE — API setup: the selected tile on the accent ring and tint, the active segment raised; ChatGPT notes on their tints', () => {
    const selected = one('api-setup-step', 'Anthropic - Claude OAuth Selected')
    expect(selected).toContain('ring-2 ring-inset ring-accent-solid bg-accent-tint')
    expect(selected).toContain('ring-1 ring-inset ring-border hover:bg-fill-hover')
    expect(selected).toContain('bg-floating shadow-elev-1 text-foreground')
    expect(one('api-setup-step', null)).not.toContain('ring-accent-solid')
    expect(one('credentials-step-chatgpt', 'Codex runtime - Idle')).toContain('<div class="rounded-lg bg-sunken p-4 text-label text-secondary"><p>')
    expect(one('credentials-step-chatgpt', 'Pi - Error')).toContain('<div class="rounded-md bg-destructive-tint text-destructive text-label p-3">')
    expect(one('credentials-step-chatgpt', 'Pi - Success')).toContain('<div class="rounded-md bg-success-tint text-success text-label p-3">')
    // Keep (UA12.206): the local step's loading label is the shared key, not a literal.
    expect(buttonsNamed(one('local-model-step', 'Validating'), EN['common.connecting']).length).toBe(1)
  })

  it('NEGATIVE — no state the row owns keeps a v0.14 class, and no step title is centred anywhere', () => {
    const owned = OWNED.flatMap(statesOf).map(render => render.markup!).join('\n')
    for (const old of [
      'bg-foreground-2', 'text-muted-foreground', 'max-w-[320px]', 'hover:bg-foreground/5', 'max-w-[28rem]', 'step-title text-lg',
      'text-foreground/30', 'bg-destructive/10', 'bg-success/10', 'bg-info/10', 'bg-muted ',
    ]) {
      expect({ old, present: owned.includes(old) }).toEqual({ old, present: false })
    }
    const all = renders.map(render => render.markup!).join('\n')
    expect(all).not.toContain('<div class="text-center"><h1 class="step-title')
    expect(all).not.toContain('max-w-[28rem]')
  })
})

/** UB14.40's entries: the personal-key form (four contexts), the gateway step and the bare catalog picker. */
const UB1440_ENTRIES = [
  'byo-runtime-merged-pi-custom', 'byo-runtime-merged-pi-official', 'byo-runtime-merged-anthropic-protocol',
  'byo-runtime-merged-edit-locked', 'gateway-connect-step', 'model-catalog-picker',
]
/** v0.14's chrome on these surfaces; any of them in a rendered state is an unported hunk. */
const UB1440_V014 = [
  'bg-foreground-2', 'text-muted-foreground', 'text-foreground/', 'bg-foreground/', 'shadow-minimal', 'focus-within:bg-background',
  'bg-destructive/10', 'bg-success/10', 'border-border/60', 'focus-visible:ring-2', 'text-[11px]', 'data-variant="outline"',
]

describe('UB14.40 — the personal-key form, the gateway step and the catalog picker, every state in dark', () => {
  it('every state of the six entries rendered, the two added entries carry their states', () => {
    for (const id of UB1440_ENTRIES) expect({ id, states: statesOf(id).length > 0 }).toEqual({ id, states: true })
    expect(statesOf('gateway-connect-step').map(label)).toEqual([
      'gateway-connect-step · (base state)', 'gateway-connect-step · Connecting', 'gateway-connect-step · Waiting for the browser, with the link',
      'gateway-connect-step · Waiting, both dp hints', 'gateway-connect-step · Creating the connection (Codex)',
      'gateway-connect-step · Sign-in failed (Claude Code)',
    ])
    expect(statesOf('model-catalog-picker').map(label)).toEqual([
      'model-catalog-picker · (base state)', 'model-catalog-picker · Before Fetch (placeholder)',
      'model-catalog-picker · Fetched, no probe (Check access)', 'model-catalog-picker · Probe streaming',
      'model-catalog-picker · Probed: available and unavailable',
    ])
  })

  it('POSITIVE — the form: the runtime radio is the segmented track with the floating segment, the fields are the field-surface Input, the default chip is raised', () => {
    const form = one('byo-runtime-merged-pi-custom', null)
    expect(form).toContain('<div class="flex rounded-md bg-fill-hover p-0.5" role="radiogroup"')
    expect(form).toContain('aria-checked="true" class="flex-1 h-control px-3 text-label font-medium rounded-sm transition-[background-color,color,box-shadow] duration-micro ease-out-subtle bg-floating shadow-elev-1 text-foreground"')
    expect(form).toMatch(/<input type="password" data-slot="input" class="field-surface [^"]*" id="byo-api-key"/)
    expect(form).toContain('class="inline-flex shrink-0 items-center rounded-md text-label-sm transition-colors duration-micro ease-out-subtle bg-raised text-foreground shadow-elev-1"')
    expect(form).toContain('class="inline-flex shrink-0 items-center rounded-md text-label-sm transition-colors duration-micro ease-out-subtle bg-fill-hover text-secondary"')
    // The locked edit shows the endpoint as the disabled field-surface Input itself, no wrapper box around it.
    expect(one('byo-runtime-merged-edit-locked', null)).toMatch(/<input type="text" data-slot="input" class="field-surface [^"]*" id="byo-base-url" readonly="" disabled=""/)
  })

  it('POSITIVE — the gateway step: the running line is the lede, a failure sits in the destructive tint well with no lede, the link hint on the role inks', () => {
    const waiting = one('gateway-connect-step', 'Waiting, both dp hints')
    expect(waiting).toContain('<p class="step-description mt-2 text-copy text-secondary">')
    expect(waiting).toContain('<span class="spinner text-2xl text-tertiary" role="status"')
    expect(waiting).toContain('<div data-testid="gateway-auth-url-hint" class="flex flex-col items-center gap-1.5 text-label-sm text-tertiary">')
    expect(waiting).toContain('<code class="rounded-xs bg-fill-hover px-1.5 py-0.5 font-mono text-mono-ui text-secondary">auth.example.invalid</code>')
    expect(openingTag(buttonsNamed(waiting, EN['onboarding.gatewayConnect.copyAuthUrl'])[0] ?? '')).toContain('data-variant="secondary"')
    expect(waiting).toContain('data-testid="gateway-connect-dp-unrunnable"')
    const failed = one('gateway-connect-step', 'Sign-in failed (Claude Code)')
    expect(failed).toContain('<div data-testid="gateway-connect-error" class="rounded-md bg-destructive-tint text-destructive text-label p-3">')
    expect(failed).not.toContain('step-description')
    expect(failed).not.toContain('class="spinner')
    expect(openingTag(buttonsNamed(failed, EN['onboarding.gatewayConnect.retry'])[0] ?? '')).toContain('data-variant="primary"')
    // Negative: a running state shows no failure well.
    expect(one('gateway-connect-step', 'Connecting')).not.toContain('gateway-connect-error')
  })

  it('POSITIVE — the catalog picker: marks on the status tints, the context size on the neutral fill, Check access the secondary button', () => {
    const probed = one('model-catalog-picker', 'Probed: available and unavailable')
    expect(probed).toContain('bg-success-tint text-success')
    expect(probed).toContain('bg-fill-hover text-secondary')
    expect(probed).toContain('overflow-hidden rounded-md border border-border')
    const fetched = one('model-catalog-picker', 'Fetched, no probe (Check access)')
    expect(openingTag(buttonsNamed(fetched, EN['apiSetup.modelCatalog.checkAccess'])[0] ?? '')).toContain('data-variant="secondary"')
    // The unavailable group starts collapsed, so its red marks are not drawn until it opens. While a probe streams, a
    // row with no verdict yet carries the pending spinner on the neutral fill and keeps its family.
    const streaming = one('model-catalog-picker', 'Probe streaming')
    expect(streaming).toContain('bg-success-tint text-success')
    expect(streaming).toMatch(/bg-fill-hover text-secondary"[^>]*><svg[^>]*lucide-loader-circle[^"]*animate-spin/)
  })

  it('NEGATIVE — no state of the six entries keeps a v0.14 class', () => {
    for (const render of UB1440_ENTRIES.flatMap(statesOf)) {
      const left = UB1440_V014.filter(old => render.markup!.includes(old))
      expect({ state: label(render), left }).toEqual({ state: label(render), left: [] })
    }
  })
})
