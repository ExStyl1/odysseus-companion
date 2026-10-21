/**
 * UB14.39 (R6-10) — our own dialogs (the files with a `DialogContent` / `AlertDialogContent` / `DrawerContent` that
 * v0.15.1 does not ship) speak v0.15.1's button vocabulary: Cancel is `ghost`, the forward action `primary`, an
 * irreversible confirmation `danger-solid`, a lesser alternative `secondary`. The deprecated aliases
 * (`outline` / `destructive` / `default`, kept in `ui/button.tsx` so 85 call sites compiled through UB13.10) render the
 * same classes as their successors, so only the source can tell a dialog still written in v0.14's words — which is
 * what this pins, with the v0.14 class vocabulary those dialogs drew beside it.
 *
 * Read as source on purpose: four of the dialogs are inline in page components (PageFrame's link-out confirmation in
 * an iframe page, PluginsPage's four dialogs in the whole marketplace page) that no static render can open. The
 * rendered states of the rest are `playground/__tests__/ours-dialogs-registry.test.ts`'s.
 *
 * The census at the bottom re-derives the row's list the way the row says to (every renderer file with a dialog
 * content part, minus v0.15.1's own list): a NEW ours-only dialog fails it until it is classified here.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const RENDERER = join(import.meta.dir, '../..')
/**
 * The census reads every `.tsx` under the renderer (untracked files included, which a `git grep` would miss). Measured
 * 2026-10-16: 157 ms on a quiet machine, 51.7 s beside five other lanes' test runs, so the default 5 s is not its
 * budget.
 */
const CENSUS_BUDGET_MS = 120_000
const read = (path: string) => readFileSync(join(RENDERER, path), 'utf8')

/** The row's own regex (UB14.39 Tests). */
const DEPRECATED_VARIANT = /variant="(outline|destructive|default)"/
/** The same aliases in an expression (`variant={on ? 'default' : 'outline'}`), which the row's regex cannot see. */
const DEPRECATED_VARIANT_EXPRESSION = /variant=\{[^}]*(['"])(outline|destructive|default)\1/

/** v0.14's words for what v0.15.1 draws with role tokens (each line of the recipe diffs UB14.36 took). */
const V014_CLASSES: readonly RegExp[] = [
  /\btext-muted-foreground\b/,
  /\btext-foreground\/\d/,
  /\bbg-foreground\/(\d|\[)/,
  /\bborder-foreground\/\d/,
  /\btext-(amber|green|red)-\d/,
  /\bbg-(amber|green|red)-\d/,
  /\btext-\[\d+(\.\d+)?px\]/,
  /\bshadow-minimal\b/,
  /gap-2 sm:gap-0/,
  /\buppercase tracking-wide/,
]

/** Ours-only dialog files, read whole (their every line is dialog). */
const WHOLE_FILES = [
  'components/BypassPermissionsDialog.tsx',
  'components/app-shell/input/RuntimeSwitchDialog.tsx',
  'components/app-shell/kanban/RunConfirmationDialog.tsx',
  'components/workspace/ProjectTrustDialog.tsx',
  'components/workspace/ProjectContributionsList.tsx',
  'components/marketplace/MarketplaceAddDialog.tsx',
  'components/marketplace/MarketplaceSkillPreviewModal.tsx',
  'components/plugins/PluginConfigurationPrompt.tsx',
  'components/plugins/PluginConfigurationFields.tsx',
  'components/plugins/PluginInstallChecklist.tsx',
] as const

/** Files whose DIALOG PARTS are ours: every `<Dialog …</Dialog>` span plus the named helpers that render inside one. */
const DIALOG_PARTS: Record<string, readonly string[]> = {
  'components/artifacts/PublishedPagesSection.tsx': ['ExtendPublishedPageDialog', 'DeletePublishedPageDialog'],
  'components/pages/PageFrame.tsx': ['PageOpenUrlTarget'],
  'pages/PluginsPage.tsx': ['UrlInstall', 'InlineNotice'],
}

/**
 * Every `<Button …>` opening tag in `source`. Walks the tag rather than matching `[^>]*`: an arrow's `=>` inside an
 * `onClick={…}` is not the end of the tag, and a string may hold a `>`.
 */
export function buttonTags(source: string): string[] {
  return buttonTagsAt(source).map(found => found.tag)
}

/** {@link buttonTags} with each tag's offset in `source`. */
function buttonTagsAt(source: string): Array<{ tag: string; start: number }> {
  const tags: Array<{ tag: string; start: number }> = []
  const opener = /<Button\b/g
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 0
    let quote: string | null = null
    let end = -1
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i]!
      if (quote) {
        if (ch === quote && source[i - 1] !== '\\') quote = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
      } else if (ch === '>' && depth === 0) {
        end = i
        break
      }
    }
    if (end === -1) throw new Error(`unterminated <Button at offset ${match.index}`)
    tags.push({ tag: source.slice(match.index, end + 1), start: match.index })
  }
  return tags
}

/** The variant of the last `<Button` that opens before the first occurrence of `needle` (its label or its handler). */
function variantOfButtonBefore(source: string, needle: string): string | undefined {
  const at = source.indexOf(needle)
  if (at === -1) return undefined
  const before = buttonTagsAt(source).filter(found => found.start < at).pop()
  return before?.tag.match(/variant="([^"]+)"/)?.[1]
}

/** The Button tags that still name a deprecated alias, in either spelling. */
export function deprecatedButtons(source: string): string[] {
  return buttonTags(source).filter(tag => DEPRECATED_VARIANT.test(tag) || DEPRECATED_VARIANT_EXPRESSION.test(tag))
}

/** The `<Dialog …</Dialog>` spans and the named function bodies of a file: what this row restyled in it. */
function dialogParts(source: string, helpers: readonly string[]): string[] {
  const parts: string[] = [...(source.match(/<Dialog\b[\s\S]*?<\/Dialog>/g) ?? [])]
  for (const name of helpers) {
    const at = source.search(new RegExp(`function ${name}\\b`))
    expect({ name, found: at >= 0 }).toEqual({ name, found: true })
    const end = source.indexOf('\n}\n', at)
    parts.push(source.slice(at, end === -1 ? undefined : end))
  }
  return parts
}

const v014ClassesIn = (text: string) => V014_CLASSES.filter(pattern => pattern.test(text)).map(String)

describe('our own dialogs on the v0.15.1 button vocabulary (UB14.39)', () => {
  it('POSITIVE (control) — the scanner and the row\'s regex catch a planted alias in each spelling, arrows and all', () => {
    const planted = [
      '<Button variant="outline" onClick={() => onCancel()}>Cancel</Button>',
      '<Button\n  variant="destructive"\n  onClick={() => row && onConfirm(row)}\n>Delete</Button>',
      '<Button onClick={() => go()} variant="default">Go</Button>',
      "<Button variant={days === choice ? 'default' : 'outline'} size=\"sm\">7 days</Button>",
    ].join('\n')
    expect(DEPRECATED_VARIANT.test('<Button variant="outline">')).toBe(true)
    expect(buttonTags(planted)).toHaveLength(4)
    expect(deprecatedButtons(planted)).toHaveLength(4)
    // The arrow inside onClick does not end the tag early: the variant after it is still read.
    expect(buttonTags(planted)[2]).toContain('variant="default"')
    // The successors and a menu item's own `destructive` are not aliases of a Button.
    expect(deprecatedButtons('<Button variant="ghost">x</Button><Button variant="danger-solid" onClick={() => x()}>y</Button>')).toEqual([])
    expect(deprecatedButtons('<DropdownMenuItem variant="destructive">Uninstall</DropdownMenuItem>')).toEqual([])
  })

  it('NEGATIVE — no listed file names a deprecated Button variant (outline / destructive / default)', () => {
    for (const path of [...WHOLE_FILES, ...Object.keys(DIALOG_PARTS)]) {
      expect({ path, deprecated: deprecatedButtons(read(path)) }).toEqual({ path, deprecated: [] })
    }
  })

  it('POSITIVE — the irreversible confirmations are danger-solid, and every dialog\'s Cancel is the ghost', () => {
    const irreversible: Array<[string, string]> = [
      ['components/BypassPermissionsDialog.tsx', 'dialog.bypassPermissions.confirm'],
      ['components/workspace/ProjectTrustDialog.tsx', "decide('trusted')"],
      ['components/artifacts/PublishedPagesSection.tsx', 'publishedPages.deleteConfirm'],
      ['pages/PluginsPage.tsx', 'void onConfirmRemoveRegistry()'],
    ]
    for (const [path, needle] of irreversible) {
      expect({ path, needle, variant: variantOfButtonBefore(read(path), needle) }).toEqual({ path, needle, variant: 'danger-solid' })
    }
    const cancels: Array<[string, string]> = [
      ['components/BypassPermissionsDialog.tsx', '{t("dialog.bypassPermissions.cancel")}'],
      ['components/app-shell/input/RuntimeSwitchDialog.tsx', "{t('common.cancel')}"],
      ['components/app-shell/kanban/RunConfirmationDialog.tsx', "{t('common.cancel')}"],
      ['components/workspace/ProjectTrustDialog.tsx', "{t('common.cancel')}"],
      ['components/plugins/PluginConfigurationPrompt.tsx', "{t('pluginDetail.configurationPromptLater')}"],
      ['components/plugins/PluginInstallChecklist.tsx', "{t('pluginChecklist.skip')}"],
      ['components/pages/PageFrame.tsx', "{t('common.cancel')}"],
    ]
    for (const [path, label] of cancels) {
      expect({ path, label, variant: variantOfButtonBefore(read(path), label) }).toEqual({ path, label, variant: 'ghost' })
    }
    // Control on the same reader: the button before Bypass's confirm label is NOT the ghost Cancel.
    expect(variantOfButtonBefore(read('components/BypassPermissionsDialog.tsx'), 'dialog.bypassPermissions.confirm')).not.toBe('ghost')
  })

  it('NEGATIVE — no v0.14 class survives in the whole dialog files or in the dialog parts of the three page files', () => {
    for (const path of WHOLE_FILES) {
      expect({ path, v014: v014ClassesIn(read(path)) }).toEqual({ path, v014: [] })
    }
    for (const [path, helpers] of Object.entries(DIALOG_PARTS)) {
      const parts = dialogParts(read(path), helpers)
      expect({ path, hasDialog: parts.some(part => part.startsWith('<Dialog')) }).toEqual({ path, hasDialog: true })
      expect({ path, v014: v014ClassesIn(parts.join('\n')) }).toEqual({ path, v014: [] })
    }
    // Control on the same instrument: the v0.14 RuntimeSwitchDialog line this row replaced is still caught (the palette
    // name is assembled so the style guard does not read this control as a class list of its own).
    const palette = 'amber'
    expect(v014ClassesIn(`<AlertTriangle className="h-5 w-5 text-${palette}-600 shrink-0" />`)).toEqual([String(V014_CLASSES[4])])
  })

  it('census — every renderer file with a dialog content part is upstream\'s (v0.15.1) or classified here', () => {
    // v0.15.1's own list (`git grep -lE "DialogContent|AlertDialogContent|DrawerContent" v0.15.1 -- apps/electron/src/renderer`,
    // 2026-10-16), less its playground entry. These take the vocabulary from their upstream rows (UB14.36 and others).
    const UPSTREAM = new Set([
      'components/KeyboardShortcutsDialog.tsx', 'components/ResetConfirmationDialog.tsx', 'components/RtkUpdateDialog.tsx',
      'components/ServerDirectoryBrowser.tsx', 'components/app-shell/AppShell.tsx', 'components/app-shell/CompactSessionListFilter.tsx',
      'components/app-shell/CompactSessionMenu.tsx', 'components/app-shell/CompactWorkspaceSwitcher.tsx',
      'components/app-shell/SendResourceToWorkspaceDialog.tsx', 'components/app-shell/SendToWorkspaceDialog.tsx',
      'components/app-shell/SessionInfoPopover.tsx', 'components/app-shell/input/CompactModelSelector.tsx',
      'components/app-shell/input/CompactPermissionModeSelector.tsx', 'components/messaging/LarkConnectDialog.tsx',
      'components/messaging/PairingCodeDialog.tsx', 'components/messaging/TelegramConnectDialog.tsx',
      'components/messaging/TelegramSupergroupPairingDialog.tsx', 'components/messaging/WhatsAppConnectDialog.tsx',
      'components/pages/DeletePageDialog.tsx', 'components/pages/PageGrantRequestDialog.tsx', 'components/pages/PageGrantsDialog.tsx',
      'components/pages/PageSourceAuthBanner.tsx', 'components/pages/SharePageDialog.tsx', 'components/projects/CreateProjectDialog.tsx',
      'components/ui/CompactSourceSelector.tsx', 'components/ui/CompactWorkingDirectorySelector.tsx', 'components/ui/command.tsx',
      'components/ui/dialog.tsx', 'components/ui/drawer.tsx', 'components/ui/rename-dialog.tsx',
    ])
    const classified = new Set<string>([...WHOLE_FILES, ...Object.keys(DIALOG_PARTS)])
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'playground') walk(path)
        } else if (entry.name.endsWith('.tsx') && /DialogContent|AlertDialogContent|DrawerContent/.test(readFileSync(path, 'utf8'))) {
          found.push(relative(RENDERER, path))
        }
      }
    }
    walk(RENDERER)
    expect(found.length).toBeGreaterThan(20) // the walk saw the tree (control: upstream's own files are in it)
    expect(found).toContain('components/ui/rename-dialog.tsx')
    const unclassified = found.filter(path => !UPSTREAM.has(path) && !classified.has(path)).sort()
    expect(unclassified).toEqual([])
    // Each classified ours-only file still HAS a dialog content part (or renders inside one: the two shared bodies).
    const insideOnly = new Set(['components/workspace/ProjectContributionsList.tsx', 'components/plugins/PluginConfigurationFields.tsx'])
    expect([...classified].filter(path => !insideOnly.has(path) && !found.includes(path))).toEqual([])
  }, CENSUS_BUDGET_MS)
})

// ---------------------------------------------------------------------------
// UB14.40 (R6-11) — our own onboarding, API-setup and ui surfaces re-tokened
// ---------------------------------------------------------------------------

/**
 * A file with its comments removed. These files' docblocks narrate the classes they replaced (the C3.248 history of
 * the system card's band names three of them), and a narrated class is not a drawn one. Line comments are taken only
 * where `//` opens a line or follows whitespace/punctuation, so a `https://` inside a string survives.
 */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s;{}(,])\/\/.*$/gm, '$1')
}

/** The row's two words (UB14.40 Tests) on top of UB14.39's list, and the alpha fills v0.15.1 drew as tints or fills. */
const UB1440_CLASSES: readonly RegExp[] = [
  ...V014_CLASSES,
  /\bbg-foreground-\d+\b/,
  /\bbg-muted\b/,
  /\bbg-(success|destructive|info)\/\d/,
  /\bborder-(border|destructive)\/\d/,
  /\bring-destructive\/\d/,
  /\bfocus-visible:ring-/,
]
const ub1440ClassesIn = (text: string) => UB1440_CLASSES.filter(pattern => pattern.test(text)).map(String)

/** The row's files, read whole (code only). */
const UB1440_FILES = [
  'components/onboarding/ByoRuntimeStep.tsx',
  'components/onboarding/GatewayConnectStep.tsx',
  'components/apisetup/ModelCatalogPicker.tsx',
  'components/apisetup/GatewayAuthUrlHint.tsx',
  'components/ui/system-card.tsx',
  'components/ui/panel-header-button-style.ts',
] as const

/** A named top-level function's body, up to the closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const at = source.search(new RegExp(`function ${name}\\b`))
  expect({ name, found: at >= 0 }).toEqual({ name, found: true })
  const end = source.indexOf('\n}\n', at)
  return source.slice(at, end === -1 ? undefined : end)
}

/** Every double-quoted literal inside the first `className={cn(…)` of a component, split into classes. */
function cnClasses(source: string): string[] {
  const open = source.indexOf('className={cn(')
  expect(open).toBeGreaterThan(-1)
  const close = source.indexOf('className\n', open)
  return [...source.slice(open, close).matchAll(/"([^"]*)"/g)].flatMap(match => match[1]!.split(/\s+/)).filter(Boolean)
}

/** Two class lists as the same recipe, ignoring order and each one's compact-shell hook class. */
const sameRecipe = (a: readonly string[], b: readonly string[], hooks: readonly string[]) => {
  const norm = (list: readonly string[]) => [...new Set(list.filter(cls => !hooks.includes(cls)))].sort()
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

describe('our own onboarding, API-setup and ui surfaces on the v0.15.1 tokens (UB14.40)', () => {
  it('POSITIVE (control) — the scan catches each v0.14 line this row replaced, and reads code, not comments', () => {
    const replaced = [
      '"bg-foreground-2 focus-within:bg-background"',
      '"flex-1 rounded-md px-3 py-2 text-sm shadow-minimal transition-colors"',
      "ok: { colorClass: 'bg-success/10 text-success' }",
      "cn('rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs', className)",
      "'mt-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-1 text-destructive'",
      '"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"',
      '<code className="rounded bg-foreground/5 px-1.5 py-0.5">',
      "invalid && 'ring-1 ring-destructive/40'",
    ]
    for (const line of replaced) expect({ line, caught: ub1440ClassesIn(line).length > 0 }).toEqual({ line, caught: true })
    // The stripper drops a narrated class and keeps a URL in a string.
    expect(ub1440ClassesIn(codeOnly('// the band was bg-muted\nconst x = 1 /* bg-foreground-5 */'))).toEqual([])
    expect(codeOnly("const url = 'https://auth.example.invalid' // note")).toContain("'https://auth.example.invalid'")
    // The successors are not caught.
    expect(ub1440ClassesIn('"field-surface bg-sunken bg-fill-hover text-secondary bg-destructive-tint border-separator"')).toEqual([])
  })

  it('NEGATIVE — no v0.14 class and no deprecated Button variant in the row\'s files', () => {
    for (const path of UB1440_FILES) {
      const code = codeOnly(read(path))
      expect({ path, v014: ub1440ClassesIn(code), deprecated: deprecatedButtons(code) }).toEqual({ path, v014: [], deprecated: [] })
    }
  })

  it('NEGATIVE — McpServersPanel\'s row draws no separator of its own and no v0.14 class', () => {
    const row = codeOnly(functionBody(read('components/app-shell/McpServersPanel.tsx'), 'McpEntityRow'))
    expect(row).not.toContain('<Separator')
    expect(row).not.toContain('showSeparator')
    expect(ub1440ClassesIn(row)).toEqual([])
    // Positive on the same read: the row's own hairline and gutter, EntityRow's (UB13.13).
    expect(row).toContain('after:bg-separator')
    expect(row).toContain('px-gutter')
  })

  it('POSITIVE — panel-header-button-style is HeaderIconButton\'s recipe and stays barrel-free', () => {
    const style = codeOnly(read('components/ui/panel-header-button-style.ts'))
    const recipe = [...style.matchAll(/'([^']*)'/g)].flatMap(match => match[1]!.split(/\s+/)).filter(Boolean)
    const headerIconButton = cnClasses(read('components/ui/HeaderIconButton.tsx'))
    const HOOKS = ['panel-header-btn', 'header-icon-btn']
    expect(recipe).toContain('panel-header-btn') // PanelHeaderCenterButton's compact 44px hook (v0.15.1), kept
    expect(headerIconButton).toContain('header-icon-btn')
    expect(sameRecipe(recipe, headerIconButton, HOOKS)).toBe(true)
    // Control on the same comparator: one class more, or one fewer, is a different recipe.
    expect(sameRecipe([...recipe, 'bg-background'], headerIconButton, HOOKS)).toBe(false)
    expect(sameRecipe(recipe.filter(cls => cls !== 'hover:bg-fill-hover'), headerIconButton, HOOKS)).toBe(false)
    // Barrel-free: the module imports nothing at all (the reason it exists, its header).
    expect(style).not.toMatch(/^\s*import\b/m)
  })

  it('compact-chat-card keeps v0.15.1 EditPopover\'s own card, so its ONLY legacy classes are upstream\'s three', () => {
    // v0.15.1 `EditPopover.tsx` draws this card with these exact strings (card :1041, grip :1055, slot :1059), so the
    // redesign's 1:1 is this markup (the row's recorded deviation from its own test wording).
    const code = codeOnly(read('components/ui/compact-chat-card.tsx'))
    expect(code).toContain("'relative bg-foreground-2 overflow-hidden w-full h-full shadow-modal-small'")
    expect(code).toContain('"w-4 h-4 text-muted-foreground/30"')
    expect(code).toContain('"flex-1 flex flex-col bg-foreground-2"')
    const count = (needle: RegExp) => code.match(needle)?.length ?? 0
    expect({ bgForeground2: count(/\bbg-foreground-2\b/g), mutedForeground: count(/\btext-muted-foreground\b/g) })
      .toEqual({ bgForeground2: 2, mutedForeground: 1 })
    // Control: a fourth legacy class planted beside them moves the census.
    const planted = `${code}\nconst extra = 'text-muted-foreground'`
    expect(planted.match(/\btext-muted-foreground\b/g)?.length).toBe(2)
    expect(ub1440ClassesIn(code).sort()).toEqual([String(/\bbg-foreground-\d+\b/), String(/\btext-muted-foreground\b/)].sort())
  })
})
