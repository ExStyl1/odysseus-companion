/**
 * UB15.3 — the settings pages render through v0.15.1's `SettingsPage` column (R5-03).
 *
 * v0.15.0 moved every settings page off its own `PanelHeader title=` + `ScrollArea` + `max-w-3xl` wrapper
 * onto `components/settings/SettingsPage.tsx`: a header that carries the actions only, then a centred 680px
 * column whose top is the page title (h2) and a one-line lede read from the page's existing
 * `settings.<slug>.description` key. This census reads the page SOURCES, because a page reaches the shell
 * through its imports and its JSX — no page here can be rendered without the app shell's context.
 *
 * UB15.12 — the denominator is the ROUTE registry. `SETTINGS_PAGES` (`shared/settings-registry.ts`, imported: it has
 * no imports of its own) names every route; `SETTINGS_PAGE_COMPONENTS` (`pages/settings/settings-pages.ts`, read as
 * text: importing it would load every page and the pdfjs-bearing barrel) maps each route to a component, and that
 * file's import of the component names the page file. Until UB15.12 the census counted settings-pages.ts's
 * `import X from './X'` lines instead, so a route whose page is imported from outside this directory, or by a named
 * import, escaped it (measured on a planted three-route registry: that regex saw one route). `MainContentPanel`
 * renders every settings route through `getSettingsPageComponent`, so the join below is the route's real page. The
 * PENDING list is gone with the last page it held (UB15.9): a new route lands on the shell or fails here.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SETTINGS_PAGES, type SettingsPageDefinition } from '../../../../shared/settings-registry'

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')

/**
 * The pages every settings route renders, all on the v0.15.1 shell. UB15.3: Input (taken 1:1), Labels, Preferences,
 * Server (taken + ours), Import (ours).
 * UB15.4: Shortcuts (merged: upstream's column, keycaps and row class; our rebinding and search row).
 * UB15.6: Workspace (merged: upstream's column, SettingsPageState and controls; our six-mode selector, sources,
 * folder-by-handle, ceilings and Published pages).
 * UB15.10: AI (upstream's shell: the column, a three-block skeleton until the one-snapshot loader lands); UB15.11 its
 * body (our gateway, runtime, guardian, advisor and codex sections on the primitives).
 * UB15.5: App (merged: upstream's column and lede, footer and About buttons; every group keeps its heading because
 * ours are not one-row groups; the Provenance, Config Doctor and Safe Mode sections stay mounted below About).
 * UB15.7: Permissions (merged: upstream's column and lede, Spinner, About prose and link, the tables' empty states;
 * our primary folder, MCP channel push, browser sites, isolation and the auto-mode judge sections on the primitives).
 * UB15.9: Appearance (merged: upstream's column and lede, the Mode section, the colour theme grid, Font / Motion /
 * Language in the Interface card; our board colours and status on move, chip, rich tool descriptions and UA5.9 kept).
 */
const ON_SHELL = [
  'AiSettingsPage',
  'AppSettingsPage',
  'AppearanceSettingsPage',
  'ImportSettingsPage',
  'InputSettingsPage',
  'LabelsSettingsPage',
  'PermissionsSettingsPage',
  'PreferencesPage',
  'ServerSettingsPage',
  'ShortcutsPage',
  'WorkspaceSettingsPage',
] as const

/**
 * The column title's key where v0.15.1 does not use the route's registry `labelKey`: upstream's Workspace page titles
 * its column `settings.workspace.workspaceSettings` ("Workspace Settings"), the one page that does (taken 1:1, UB15.6).
 */
const TITLE_KEY: Readonly<Record<string, string>> = {
  workspace: 'settings.workspace.workspaceSettings',
}

/** One route of the registry, joined to the component and the page file that render it. */
interface SettingsRoute extends SettingsPageDefinition {
  /** The component `SETTINGS_PAGE_COMPONENTS` maps the route to (undefined: the map lacks the id). */
  component: string | undefined
  /** The page file, relative to `pages/settings/` (undefined: no import names the component). */
  file: string | undefined
}

/** Every local name settings-pages.ts imports (default, named or renamed; `import type` skipped) → its path. */
function importedNames(source: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const [, clause, path] of source.matchAll(/^import\s+(?!type\b)([^'"]+?)\s+from\s+'([^']+)'/gm)) {
    for (const part of clause!.replace(/[{}]/g, ',').split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop()!.trim()
      if (/^\w+$/.test(local)) names.set(local, path!)
    }
  }
  return names
}

/** An import path as a page file relative to `pages/settings/` (`@/` is `renderer/`, two directories up). */
function pageFileOf(path: string): string {
  const relative = path.startsWith('@/') ? `../../${path.slice(2)}` : path
  return /\.tsx?$/.test(relative) ? relative : `${relative}.tsx`
}

/** The registry's routes, each joined to its page through settings-pages.ts (the census denominator). */
function registryRoutes(
  pages: readonly SettingsPageDefinition[] = SETTINGS_PAGES,
  registrySource: string = read('settings-pages.ts'),
): SettingsRoute[] {
  const body = registrySource.match(/export const SETTINGS_PAGE_COMPONENTS\b[^=]*=\s*\{([^}]*)\}/)?.[1] ?? ''
  const components = new Map([...body.matchAll(/^\s*['"]?(\w+)['"]?\s*:\s*(\w+)\s*,?\s*$/gm)].map(m => [m[1]!, m[2]!]))
  const imports = importedNames(registrySource)
  return pages.map(page => {
    const component = components.get(page.id)
    const path = component === undefined ? undefined : imports.get(component)
    return { ...page, component, file: path === undefined ? undefined : pageFileOf(path) }
  })
}

const PANEL_HEADER_IMPORT = /import\s*\{[^}]*\bPanelHeader\b[^}]*\}\s*from\s*'@\/components\/app-shell\/PanelHeader'/
const SCROLL_AREA_IMPORT = /import\s*\{[^}]*\bScrollArea\b[^}]*\}\s*from\s*'@\/components\/ui\/scroll-area'/

/** The page-level wrappers a page on the shell must not draw itself (the shell draws them). */
function bareWrapperImports(source: string): string[] {
  return [
    ...(PANEL_HEADER_IMPORT.test(source) ? ['PanelHeader'] : []),
    ...(SCROLL_AREA_IMPORT.test(source) ? ['ScrollArea'] : []),
  ]
}

/** The names a page imports from the settings primitives barrel. */
function settingsBarrelImports(source: string): string[] {
  const clause = source.match(/import\s*\{([^}]*)\}\s*from\s*'@\/components\/settings'/)
  return clause ? clause[1]!.split(',').map(name => name.trim()).filter(Boolean) : []
}

/** The page's slug, from its `meta` (`slug: '<slug>'`). */
function slugOf(source: string): string | undefined {
  return source.match(/export const meta: DetailsPageMeta = \{[^}]*slug: '([^']+)'/)?.[1]
}

const keyPattern = (key: string) => key.replace(/\./g, '\\.')

/**
 * Why a route's page is off the v0.15.1 shell (empty: it is on it). On the shell means: the page imports
 * `SettingsPage`/`SettingsPageState` from the barrel and renders it, its `meta` claims the route, the column's title
 * and lede are the registry's own `labelKey` and `descriptionKey` (v0.15.0), and it draws neither wrapper itself.
 */
function offShell(route: SettingsPageDefinition, source: string): string[] {
  const imported = settingsBarrelImports(source)
  const title = new RegExp(`title=\\{t\\((['"])${keyPattern(TITLE_KEY[route.id] ?? route.labelKey)}\\1\\)\\}`)
  const lede = new RegExp(`description=\\{t\\((['"])${keyPattern(route.descriptionKey)}\\1\\)\\}`)
  return [
    ...(imported.includes('SettingsPage') || imported.includes('SettingsPageState') ? [] : ['no SettingsPage import']),
    ...(/<SettingsPage(State)?\b/.test(source) ? [] : ['no SettingsPage render']),
    ...(slugOf(source) === route.id ? [] : ['meta slug is not the route']),
    ...(title.test(source) ? [] : ['title is not the registry labelKey']),
    ...(lede.test(source) ? [] : ['lede is not the registry descriptionKey']),
    ...bareWrapperImports(source).map(name => `draws ${name}`),
  ]
}

/** The census: every route's reasons, prefixed with its id. */
function censusOf(routes: readonly SettingsRoute[], sourceOf: (route: SettingsRoute) => string): string[] {
  return routes.flatMap(route => {
    if (route.component === undefined || route.file === undefined) return [`${route.id}: not joined to a page`]
    return [
      ...((ON_SHELL as readonly string[]).includes(route.component) ? [] : [`${route.id}: ${route.component} is not on the allowlist`]),
      ...offShell(route, sourceOf(route)).map(reason => `${route.id}: ${reason}`),
    ]
  })
}

/** A route as v0.14.x drew it: its own PanelHeader title over a ScrollArea and a max-w-3xl column (no shell). */
const BARE_PAGE = [
  "import { PanelHeader } from '@/components/app-shell/PanelHeader'",
  "import { ScrollArea } from '@/components/ui/scroll-area'",
  "export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'planted' }",
  'export default function PlantedSettingsPage() {',
  '  return (<div className="h-full flex flex-col"><PanelHeader title={t(\'settings.planted.title\')} />',
  '    <ScrollArea className="flex-1"><div className="px-5 py-7 max-w-3xl mx-auto" /></ScrollArea></div>)',
  '}',
].join('\n')
const PLANTED_ROUTE = { id: 'planted', labelKey: 'settings.planted.title', descriptionKey: 'settings.planted.description' }

describe('every settings route on the SettingsPage shell (UB15.3, UB15.12)', () => {
  it('POSITIVE CONTROL — the registry declares eleven routes, each joins to a page file, and the allowlist is exactly those pages', () => {
    const routes = registryRoutes()
    expect(routes.length).toBe(11)
    expect(routes.map(route => route.id)).toEqual(SETTINGS_PAGES.map(page => page.id))
    expect(routes.filter(route => route.component === undefined || route.file === undefined).map(route => route.id)).toEqual([])
    expect(routes.map(route => route.component).sort()).toEqual([...ON_SHELL].sort())
    // The reads are real: each route's page is a file of substance.
    for (const route of routes) expect({ route: route.id, read: read(route.file!).length > 1000 }).toEqual({ route: route.id, read: true })
  })

  it('POSITIVE — every route renders through SettingsPage / SettingsPageState with the registry title and lede, and draws no wrapper', () => {
    expect(censusOf(registryRoutes(), route => read(route.file!))).toEqual([])
  })

  it('NEGATIVE (control) — a planted route rendering through a bare PanelHeader fails the census, even imported from outside this directory', () => {
    // The registry as settings-pages.ts spells it, plus one route whose page lives one directory up — the import
    // shape HEAD's `./`-only census could not see.
    const registry = read('settings-pages.ts')
      .replace("import PreferencesPage from './PreferencesPage'", "import PreferencesPage from './PreferencesPage'\nimport PlantedSettingsPage from '../PlantedSettingsPage'")
      .replace('  preferences: PreferencesPage,', '  preferences: PreferencesPage,\n  planted: PlantedSettingsPage,')
    const routes = registryRoutes([...SETTINGS_PAGES, PLANTED_ROUTE], registry)
    const planted = routes.find(route => route.id === 'planted')
    expect({ component: planted?.component, file: planted?.file }).toEqual({ component: 'PlantedSettingsPage', file: '../PlantedSettingsPage.tsx' })
    const census = censusOf(routes, route => (route.id === 'planted' ? BARE_PAGE : read(route.file!)))
    expect(census).toEqual([
      'planted: PlantedSettingsPage is not on the allowlist',
      'planted: no SettingsPage import',
      'planted: no SettingsPage render',
      'planted: lede is not the registry descriptionKey',
      'planted: draws PanelHeader',
      'planted: draws ScrollArea',
    ])
  })

  it('BOUNDARY — named and aliased imports join; a page on the shell with another page\'s lede, or no meta, still fails', () => {
    const names = importedNames([
      "import type { ComponentType } from 'react'",
      "import { LazySettingsPage } from './LazySettingsPage'",
      "import { Default as AliasedPage } from '@/pages/AliasedPage'",
      "import AppSettingsPage from './AppSettingsPage'",
    ].join('\n'))
    expect(Object.fromEntries(names)).toEqual({
      LazySettingsPage: './LazySettingsPage',
      AliasedPage: '@/pages/AliasedPage',
      AppSettingsPage: './AppSettingsPage',
    })
    expect(pageFileOf('@/pages/AliasedPage')).toBe('../../pages/AliasedPage.tsx')
    const app = SETTINGS_PAGES.find(page => page.id === 'app')!
    const shell = "import { SettingsPage } from '@/components/settings'\n"
    const meta = "export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'app' }\n"
    const body = (lede: string) => `<SettingsPage title={t('settings.app.title')} description={t('${lede}')}>`
    expect(offShell(app, shell + meta + body('settings.app.description'))).toEqual([])
    expect(offShell(app, shell + meta + body('settings.ai.description'))).toEqual(['lede is not the registry descriptionKey'])
    expect(offShell(app, shell + body('settings.app.description'))).toEqual(['meta slug is not the route'])
    // The title exception is the one v0.15.1 spells, and only for its own route.
    expect(Object.keys(TITLE_KEY)).toEqual(['workspace'])
  })
})

/**
 * UB15.7 — the Permissions page's own sections (ours; upstream v0.15.1 has none of them) ADOPT the v0.15.1 settings
 * material: `settingsUI` for padding and type, roles (`text-secondary` / `text-tertiary`) for ink, the shared `Button`
 * for the one control a section draws. The census reads the four section files and the page itself, the instrument
 * the shell census above uses (none of them renders without the app shell's context and the pdfjs-bearing barrel).
 */
const PERMISSION_SECTION_FILES = [
  '../../components/settings/IsolationNetworkPosture.tsx',
  'AutoModeDenialsSection.tsx',
  'AutoModeJudgeRulesSection.tsx',
  'BrowserOriginTrustSection.tsx',
] as const
const PERMISSION_FILES = [...PERMISSION_SECTION_FILES, 'PermissionsSettingsPage.tsx'] as const

/** The legacy material each section drew until UB15.7: the hand-padded card and the shadcn muted ink. */
const LEGACY_MATERIAL = ['text-muted-foreground', 'px-4 py-3.5'] as const
const legacyIn = (source: string): string[] => LEGACY_MATERIAL.filter(needle => source.includes(needle))
const SETTINGS_UI_IMPORT = /import \{ settingsUI \} from '(?:\.\/|@\/components\/settings\/)SettingsUIConstants'/
const settingsUiUses = (source: string): number => (source.match(/\bsettingsUI\.\w+/g) ?? []).length

describe('the Permissions page sections on the v0.15.1 settings material (UB15.7)', () => {
  it('POSITIVE — each of the four sections and the page imports settingsUI and draws with it', () => {
    for (const file of PERMISSION_FILES) {
      const source = read(file)
      expect({ file, imports: SETTINGS_UI_IMPORT.test(source), uses: settingsUiUses(source) >= 3 })
        .toEqual({ file, imports: true, uses: true })
    }
    // The one control a section draws is the shared Button (upstream's list-row removal: danger, small).
    const trust = read('BrowserOriginTrustSection.tsx')
    expect(trust).toContain("import { Button } from '@/components/ui/button'")
    expect(trust).toMatch(/<Button\s+variant="danger"\s+size="sm"/)
  })

  it('NEGATIVE — none of them keeps the muted ink or the hand-padded card, and no section hand-rolls a button', () => {
    expect(PERMISSION_FILES.flatMap(file => legacyIn(read(file)).map(needle => `${file}: ${needle}`))).toEqual([])
    expect(PERMISSION_SECTION_FILES.filter(file => read(file).includes('<button')).map(String)).toEqual([])
  })

  it('CONTROL — the instruments fire on the shapes these files drew until UB15.7, and the reads are real', () => {
    // Spelled as the HEAD sources spelled them (BrowserOriginTrustSection's card and its empty line).
    const planted = '<SettingsCard className="px-4 py-3.5 space-y-3">\n<div className="text-sm text-muted-foreground">'
    expect(legacyIn(planted)).toEqual(['text-muted-foreground', 'px-4 py-3.5'])
    expect(SETTINGS_UI_IMPORT.test("import { settingsUI } from './SettingsUIConstants'")).toBe(true)
    expect(settingsUiUses('cn(settingsUI.cardPadding, settingsUI.prose)')).toBe(2)
    for (const file of PERMISSION_FILES) expect({ file, read: read(file).length > 1000 }).toEqual({ file, read: true })
  })
})

/**
 * UB15.8 — Settings → App's three Nessy sections (ours; upstream v0.15.1 has none of them): Provenance (P6.168,
 * P6.169, P6.447), Config Doctor (P6.576, P6.787, C3.212) and Safe Mode (P6.451) ADOPT the v0.15.1 settings material,
 * with no change to what they read or show. Each group is one `settingsUI.cardPadding` block split by the card's own
 * hairline; headings, explanations and fine print take `settingsUI`'s type; inks are the solved roles; the one
 * control (Safe Mode's restart) is the shared `Button` at upstream's row-action shape (secondary, md).
 */
const APP_SECTION_FILES = [
  'SettingsConfigDoctorSection.tsx',
  'SettingsProvenanceSection.tsx',
  'SettingsSafeModeSection.tsx',
] as const

/** The hand-drawn rule the provenance groups were split by until UB15.8 (the card draws the hairline now). */
const HAND_RULE = 'border-t border-border/50'

describe('the App page Provenance, Config Doctor and Safe Mode sections on the v0.15.1 settings material (UB15.8)', () => {
  it('POSITIVE — each of the three imports settingsUI and draws with it; the restart is the shared secondary md Button', () => {
    for (const file of APP_SECTION_FILES) {
      const source = read(file)
      expect({ file, imports: SETTINGS_UI_IMPORT.test(source), uses: settingsUiUses(source) >= 2 })
        .toEqual({ file, imports: true, uses: true })
    }
    const safeMode = read('SettingsSafeModeSection.tsx')
    expect(safeMode).toContain("import { Button } from '@/components/ui/button'")
    expect(safeMode).toMatch(/<Button\s+variant="secondary"\s+size="md"/)
    // The report sits in v0.15.1's code well (Info_TechnicalDetails), its columns kept.
    expect(read('SettingsConfigDoctorSection.tsx')).toMatch(/rounded-md bg-sunken px-2\.5 py-2 font-mono text-mono-ui whitespace-pre/)
  })

  it('NEGATIVE — none of them keeps the muted ink, the hand-padded card or a hand-drawn rule, and none hand-rolls a button', () => {
    expect(APP_SECTION_FILES.flatMap(file =>
      [...legacyIn(read(file)), ...(read(file).includes(HAND_RULE) ? [HAND_RULE] : [])].map(needle => `${file}: ${needle}`)))
      .toEqual([])
    expect(APP_SECTION_FILES.filter(file => read(file).includes('<button')).map(String)).toEqual([])
    // The safe-mode action is never the solid accent at the small size it drew until UB15.8.
    expect(read('SettingsSafeModeSection.tsx')).not.toMatch(/<Button size="sm"/)
  })

  it('CONTROL — the instruments fire on the shapes these files drew until UB15.8, and the reads are real', () => {
    // Spelled as the HEAD sources spelled them (the provenance codex pane's frame, Safe Mode's policy note).
    const planted = [
      '<div className="space-y-1 border-t border-border/50 pt-3" data-testid="provenance-codex">',
      '<div className="px-4 py-3.5 text-xs text-muted-foreground">',
      '<Button size="sm" onClick={() => restart(!inSafeMode)}>',
    ].join('\n')
    expect(legacyIn(planted)).toEqual(['text-muted-foreground', 'px-4 py-3.5'])
    expect(planted.includes(HAND_RULE)).toBe(true)
    expect(planted).toMatch(/<Button size="sm"/)
    for (const file of APP_SECTION_FILES) expect({ file, read: read(file).length > 1000 }).toEqual({ file, read: true })
  })
})

/**
 * UB15.12 — Done means: zero `text-muted-foreground` (shadcn's muted ink; v0.15.0 draws secondary text on the solved
 * `text-secondary` / `text-tertiary` roles) in `pages/settings/` and `components/settings/`. The census WALKS both
 * directories (every .ts/.tsx outside `__tests__`) instead of naming files, so a file a later row adds there is read
 * without anyone listing it; it bars UB15.7's `px-4 py-3.5` hand-padded card with the same instrument
 * (`LEGACY_MATERIAL`). The census row found one .tsx there that no UB15.1–UB15.11 row names, `DecisionModelCard.tsx`
 * (UB6.5's card, which UB15.11 restyled), already on the primitives.
 */
const SETTINGS_DIRS = [
  new URL('../', import.meta.url), // pages/settings/
  new URL('../../../components/settings/', import.meta.url),
] as const

/** Every .ts/.tsx under the settings directories, as `<dir>/<file>` paths below `renderer/`. */
function settingsSources({ withTests = false } = {}): Map<string, string> {
  const sources = new Map<string, string>()
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (withTests || entry.name !== '__tests__') walk(new URL(`${entry.name}/`, dir))
      } else if (/\.tsx?$/.test(entry.name)) {
        const url = new URL(entry.name, dir)
        sources.set(fileURLToPath(url).replace(/^.*\/renderer\//, ''), readFileSync(url, 'utf8'))
      }
    }
  }
  for (const dir of SETTINGS_DIRS) walk(dir)
  return sources
}

const legacyOffenders = (sources: Map<string, string>): string[] =>
  [...sources].flatMap(([file, source]) => legacyIn(source).map(needle => `${file}: ${needle}`))

describe('zero legacy ink in pages/settings and components/settings (UB15.12)', () => {
  it('POSITIVE CONTROL — the walk reads both directories: the shell, every route page and the census row\'s one unnamed file', () => {
    const files = [...settingsSources().keys()]
    for (const expected of [
      'components/settings/SettingsPage.tsx',
      'components/settings/IsolationNetworkPosture.tsx',
      'pages/settings/DecisionModelCard.tsx',
      ...ON_SHELL.map(page => `pages/settings/${page}.tsx`),
    ]) expect({ expected, read: files.includes(expected) }).toEqual({ expected, read: true })
    expect(files.some(file => file.includes('__tests__'))).toBe(false)
    expect(files.length).toBeGreaterThan(30)
  })

  it('NEGATIVE — no settings source draws the muted ink or the hand-padded card', () => {
    expect(legacyOffenders(settingsSources())).toEqual([])
  })

  it('CONTROL — the instrument fires on the corpus: the same walk WITH the census files finds the needles they spell', () => {
    const offenders = legacyOffenders(settingsSources({ withTests: true }))
    expect(offenders).toContain('pages/settings/__tests__/settings-page-shell.test.ts: text-muted-foreground')
    expect(offenders.every(offender => offender.includes('/__tests__/'))).toBe(true)
  })
})
