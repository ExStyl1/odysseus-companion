/**
 * UB14.38 (R6-09) — `ApiKeyInput` on v0.15.1's look, every state of `registry/api-key-input.tsx` rendered for real
 * in DARK inside the playground's own entry frame by one child process (`fixtures/api-key-input-entries-probe.ts`;
 * the recipe and its reasons are `dialog-entries-probe.ts`'s), once in English and once in Russian.
 *
 * What a reviewer sees on the playground: every field on `field-surface`, the endpoint preset as a hairline pill,
 * the protocol / credential-header / Bedrock-authentication choices as one segmented track whose selected segment is
 * raised, the hints in tertiary text, and an eye toggle with an accessible name (`common.show`, flipping to
 * `common.hide` once the key is revealed). Before the row every field sat on `bg-foreground-2 shadow-minimal`, the
 * pill was a `rounded-[6px] bg-background` chip and the eye toggle had no name at all — so every POSITIVE below fails
 * on that tree.
 *
 * The NEGATIVES are the row's Keep: the toggle stays out of the tab order (`tabIndex=-1`), the visible preset list is
 * still DA1.53's `anthropic, openai, custom`, and upstream's Cloudflare AI Gateway preset was not taken (B2-11
 * DROP-a). The tier dropdown's `popover-styled` list opens only after a live model load, so no static render can show
 * it; it is pinned at its source line here and left to the API-setup arm of the dark sitting (UB14.41).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { API_KEY_INPUT_ENTRIES_MARKER, type ApiKeyInputEntryRender } from './fixtures/api-key-input-entries-probe'

const CHILD = new URL('./fixtures/api-key-input-entries-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../', import.meta.url).pathname
const FORM_PATH = join(REPO_ROOT, 'apps/electron/src/renderer/components/apisetup/ApiKeyInput.tsx')
const LOCALES = {
  en: JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>,
  ru: JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/ru.json'), 'utf8')) as Record<string, string>,
}

let renders: ApiKeyInputEntryRender[] = []
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'api-key-input-entries-probe-'))
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
  const at = stdout.lastIndexOf(API_KEY_INPUT_ENTRIES_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`api-key-input probe exited ${exitCode} without renders:\n${stderr.slice(-4000)}`)
  }
  renders = JSON.parse(stdout.slice(at + API_KEY_INPUT_ENTRIES_MARKER.length)) as ApiKeyInputEntryRender[]
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const label = (render: ApiKeyInputEntryRender) => `${render.language} · ${render.variant ?? '(base state)'}`
const inLanguage = (language: 'en' | 'ru') => renders.filter(render => render.language === language)
const one = (variant: string | null, language: 'en' | 'ru' = 'en'): string => {
  const render = renders.find(r => r.variant === variant && r.language === language)
  expect({ variant, language, found: !!render?.markup }).toEqual({ variant, language, found: true })
  return render!.markup!
}
/** Every eye toggle in the markup: the icon button absolutely placed inside a field (the key, or Bedrock's secret). */
const eyeToggles = (markup: string) => markup.match(/<button type="button" class="absolute [^"]*"[^>]*>/g) ?? []

const EYE_CLASS = 'absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center text-tertiary hover:text-foreground'
const PRESET_PILL_CLASS = 'motion-press flex h-control-sm items-center gap-1 rounded-full pl-2.5 pr-2 text-label-sm font-medium text-secondary ring-1 ring-inset ring-border hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground'
/** What `cn` makes of upstream's two track lines (`bg-fill-hover p-0.5` then `bg-foreground-2`): tailwind-merge keeps the last fill — upstream's own render, taken 1:1. */
const SEGMENT_TRACK = '<div class="flex gap-0.5 rounded-md p-0.5 bg-foreground-2">'
const SEGMENT_SELECTED = 'class="flex-1 rounded-sm py-1 text-label-sm font-medium transition-colors duration-micro ease-out-subtle hover:duration-instant bg-raised text-foreground shadow-elev-1"'
/** The v0.14 chrome this row replaces; any of these in a rendered state is an unported hunk. */
const V014_CLASSES = ['shadow-minimal', 'focus-within:bg-background', 'text-foreground/30', 'text-foreground/50', 'text-muted-foreground', 'rounded-[6px]', 'text-[12px]', 'data-variant="outline"']

describe('the API-key registry, every state in dark (UB14.38)', () => {
  it('every state is swept in both languages, none threw, none is empty, and the two added states are there', () => {
    expect(inLanguage('en').length).toBe(15)
    expect(inLanguage('ru').length).toBe(15)
    expect(renders.filter(render => render.error).map(render => `${label(render)}: ${render.error}`)).toEqual([])
    expect(renders.filter(render => !render.markup?.trim()).map(label)).toEqual([])
    expect(inLanguage('en').map(render => render.variant)).toContain('Anthropic (default endpoint)')
    expect(inLanguage('en').map(render => render.variant)).toContain('Amazon Bedrock edit (IAM)')
  })

  it('POSITIVE — every eye toggle is named by common.show, in English and in Russian', () => {
    expect(LOCALES.en['common.show']).toBe('Show')
    expect(LOCALES.ru['common.show']).toBe('Показать')
    for (const language of ['en', 'ru'] as const) {
      for (const render of inLanguage(language)) {
        const toggles = eyeToggles(render.markup!)
        // Every state draws exactly one: the key field's, or (Bedrock, key field hidden) the secret key's.
        expect({ state: label(render), count: toggles.length }).toEqual({ state: label(render), count: 1 })
        expect({ state: label(render), named: toggles[0]!.includes(`aria-label="${LOCALES[language]['common.show']}"`) })
          .toEqual({ state: label(render), named: true })
        expect({ state: label(render), recipe: toggles[0]!.includes(`class="${EYE_CLASS}"`) }).toEqual({ state: label(render), recipe: true })
      }
    }
  })

  it('POSITIVE — revealed, both toggles flip to common.hide (the source line; the static render cannot click)', () => {
    const source = readFileSync(FORM_PATH, 'utf8')
    expect(source.split("aria-label={showValue ? t('common.hide') : t('common.show')}").length - 1).toBe(2)
    expect(LOCALES.en['common.hide']).toBe('Hide')
    expect(LOCALES.ru['common.hide']).toBe('Скрыть')
  })

  it('NEGATIVE — every eye toggle stays out of the tab order (tabIndex=-1)', () => {
    for (const render of renders) {
      for (const toggle of eyeToggles(render.markup!)) {
        expect({ state: label(render), tabindex: /\btabindex="-1"/.test(toggle) }).toEqual({ state: label(render), tabindex: true })
      }
    }
  })

  it('POSITIVE — the fields, the preset pill and the segmented tracks wear the v0.15.1 recipe', () => {
    const custom = one(null)
    expect(custom).toContain('<div class="field-surface relative rounded-md"><input type="password"')
    expect(custom).toContain(`class="${PRESET_PILL_CLASS}">Custom<svg`)
    expect(custom).toContain('lucide-chevron-down size-2.5 text-tertiary')
    // Protocol and our P6.586 credential header: one track each, the selected segment raised.
    expect(custom.split(SEGMENT_TRACK).length - 1).toBe(2)
    expect(custom.split(SEGMENT_SELECTED).length - 1).toBe(2)
    expect(custom).toContain('<div class="field-surface rounded-md"><input type="text" data-slot="input"')
    // Our C3 catalog action sits on the secondary successor of the retired outline alias.
    expect(custom).toContain('data-variant="secondary"')
    const bedrock = one('Amazon Bedrock edit (IAM)')
    expect(bedrock.split(SEGMENT_TRACK).length - 1).toBe(1)
    expect(bedrock).toContain('<div class="field-surface relative rounded-md"><input type="password" data-slot="input"')
    expect(bedrock).toContain('class="text-label-sm text-tertiary">') // P6.457's region note on the hint recipe
  })

  it('NEGATIVE — no state keeps the v0.14 chrome', () => {
    for (const render of renders) {
      const left = V014_CLASSES.filter(cls => render.markup!.includes(cls))
      expect({ state: label(render), left }).toEqual({ state: label(render), left: [] })
    }
  })

  it('NEGATIVE — the visible preset list is still exactly anthropic, openai, custom (DA1.53)', () => {
    const source = readFileSync(FORM_PATH, 'utf8')
    expect(source).toContain("const VISIBLE_ENDPOINT_PRESET_KEYS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'custom'])")
    // Both arms of getPresetsForProvider that list the table filter through it.
    expect(source.split('.filter(p => VISIBLE_ENDPOINT_PRESET_KEYS.has(p.key))').length - 1).toBe(2)
    // Rendered: a visible preset names the pill; a hidden one (Bedrock, reached only by editing) finds no row.
    expect(one('Anthropic (default endpoint)')).toContain(`class="${PRESET_PILL_CLASS}">Anthropic<svg`)
    expect(one('Amazon Bedrock edit (IAM)')).toContain(`class="${PRESET_PILL_CLASS}"><svg`)
  })
})

/** The ANTHROPIC_PRESETS table's own text, from its declaration to its closing bracket. */
function presetTable(source: string): string {
  const start = source.indexOf('const ANTHROPIC_PRESETS: Preset[] = [')
  if (start === -1) return ''
  return source.slice(start, source.indexOf('\n]\n', start))
}
const CLOUDFLARE_ROW = /cloudflare/i

describe('upstream rows taken and not taken (UB14.38)', () => {
  it('CONTROL — the table reader finds the real table, and the pin trips on a planted Cloudflare row', () => {
    const table = presetTable(readFileSync(FORM_PATH, 'utf8'))
    expect(table).toContain("key: 'anthropic'")
    expect(table).toContain("key: 'custom'")
    expect(CLOUDFLARE_ROW.test("  { key: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway', url: '' },")).toBe(true)
  })

  it('NEGATIVE — no Cloudflare AI Gateway preset, import or submit check (B2-11 DROP-a)', () => {
    const source = readFileSync(FORM_PATH, 'utf8')
    expect(CLOUDFLARE_ROW.test(presetTable(source))).toBe(false)
    for (const needle of ['cloudflare-ai-gateway', 'CLOUDFLARE_AI_GATEWAY', '@config/cloudflare-gateway', 'parseCloudflareGatewayUrl']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false })
    }
    expect(existsSync(join(REPO_ROOT, 'packages/shared/src/config/cloudflare-gateway.ts'))).toBe(false)
  })

  it('POSITIVE — Azure carries upstream\'s urlPlaceholder and the base URL field reads it, falling back for Custom', () => {
    const source = readFileSync(FORM_PATH, 'utf8')
    expect(presetTable(source)).toContain("urlPlaceholder: 'https://<resource>.openai.azure.com/openai/v1'")
    expect(source).toContain('placeholder={activePresetObj?.urlPlaceholder ?? "https://your-api-endpoint.com"}')
    expect(one(null)).toContain('id="base-url" placeholder="https://your-api-endpoint.com"')
  })

  it('the tier dropdown list sits on popover-styled with menu-height rows (source; it opens only after a live model load)', () => {
    const source = readFileSync(FORM_PATH, 'utf8')
    expect(source).toContain('className="popover-styled fixed z-floating-menu min-w-[200px] overflow-hidden text-foreground"')
    expect(source).toContain('"flex min-h-row-menu cursor-pointer select-none items-center justify-between gap-3 rounded-md px-3 text-label",')
    expect(source).not.toContain('shadow-modal-small')
  })
})
