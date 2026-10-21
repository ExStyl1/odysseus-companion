/**
 * UB15.6 — the Workspace page on v0.15.1's material (R5-05).
 *
 * v0.15.1 `pages/settings/WorkspaceSettingsPage.tsx` renders its empty and loading states through
 * `SettingsPageState` and its body through the `SettingsPage` column, all three with ONE shared `headerActions`;
 * its controls are the shared `Button` (secondary / ghost, `md`), the icon upload is a `<label>` with a
 * focus-visible outline around a `buttonVariants` span, and the mode-cycling error appears in place through
 * `AnimatedCollapsibleContent` as a `role="status"` line (no `motion/react` height animation). Ours keeps the
 * six-mode default selector and its managed tier, the default-sources picker over the composer catalog, the
 * default project folder by handle with its trust dialog, the budget-ceilings disclosure, the saved-setting
 * reload and Published pages.
 *
 * SOURCE MATCH, for the reason its four sibling suites give (`budget-ceilings-disclosure`, `workspace-default-mode`,
 * `workspace-settings-refresh`, `components/workspace/__tests__/project-handle-flow`): `bun test` has no DOM here,
 * the page needs the app-shell context and `window.electronAPI` past its first render, and its
 * `ServerDirectoryBrowser` import pulls the `@nessy-agent/ui` barrel (pdfjs) that a plain bun test cannot load.
 * Assertions read the page's CODE (comments stripped), so a docblock quoting a forbidden shape cannot pass or
 * fail an arm.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const SOURCE = readFileSync(fileURLToPath(new URL('../WorkspaceSettingsPage.tsx', import.meta.url)), 'utf8')

/** Comments quote the shapes these assertions forbid; assert against CODE. */
function codeOf(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CODE = codeOf(SOURCE)

const count = (text: string, needle: string): number => text.split(needle).length - 1

/** The mode-cycling error, drawn in place as a live status line under the toggles (v0.15.1). */
const ERROR_IN_STATUS_NODE =
  /<AnimatedCollapsibleContent isOpen=\{!!modeCyclingError\}>\s*<p role="status"[^>]*>\s*\{modeCyclingError\}\s*<\/p>\s*<\/AnimatedCollapsibleContent>/

/** Any trace of the `motion/react` height animation the error used until UB15.6. */
const MOTION_TRACES: ReadonlyArray<[string, RegExp]> = [
  ['motion/react import', /from\s+['"]motion\/react['"]/],
  ['AnimatePresence', /\bAnimatePresence\b/],
  ['motion.<element>', /\bmotion\.[a-z]+\b/],
]

/** The pre-redesign material the page drew by hand. */
const LEGACY_MATERIAL = [
  'shadow-minimal',
  'text-muted-foreground',
  'bg-foreground/5',
  'ring-border/50',
  'text-[8px]',
  'hover:bg-foreground/[0.02]',
] as const

describe('UB15.6 · the mode-cycling error appears in place as a status line', () => {
  it('POSITIVE — the error is a role="status" node inside AnimatedCollapsibleContent keyed on the error', () => {
    expect(CODE).toMatch(ERROR_IN_STATUS_NODE)
    // The ONLY place the error reaches the screen, so no second, unannounced copy of it exists.
    expect(count(CODE, '{modeCyclingError}')).toBe(1)
    expect(CODE).toMatch(/import \{ AnimatedCollapsibleContent \} from '@nessy-agent\/ui'/)
  })

  it('NEGATIVE — no AnimatePresence / motion import or element remains in the page', () => {
    const found = MOTION_TRACES.filter(([, needle]) => needle.test(CODE)).map(([name]) => name)
    expect(found).toEqual([])
  })

  it('CONTROL — both instruments fire on the shape the page had at HEAD before UB15.6', () => {
    const before = [
      "import { motion, AnimatePresence } from 'motion/react'",
      '<AnimatePresence>',
      '  {modeCyclingError && (',
      '    <motion.p className="text-xs text-destructive mt-1 overflow-hidden">{modeCyclingError}</motion.p>',
      '  )}',
      '</AnimatePresence>',
    ].join('\n')
    expect(MOTION_TRACES.filter(([, needle]) => needle.test(before)).map(([name]) => name))
      .toEqual(['motion/react import', 'AnimatePresence', 'motion.<element>'])
    expect(before).not.toMatch(ERROR_IN_STATUS_NODE)
    // A status node that is NOT inside the collapsible is refused too.
    expect('<p role="status" className="mt-1">{modeCyclingError}</p>').not.toMatch(ERROR_IN_STATUS_NODE)
  })
})

describe('UB15.6 · the page renders through the SettingsPage column with one shared header action', () => {
  it('POSITIVE — empty and loading states are SettingsPageState, the body is SettingsPage, all three on headerActions', () => {
    expect(count(CODE, 'const headerActions = <HeaderMenu route={routes.view.settings(\'workspace\')} helpFeature="workspaces" />')).toBe(1)
    expect(count(CODE, '<HeaderMenu')).toBe(1)
    expect(count(CODE, '<SettingsPageState actions={headerActions}>')).toBe(2)
    expect(CODE).toMatch(
      /<SettingsPage\s+title=\{t\("settings\.workspace\.workspaceSettings"\)\}\s+description=\{t\("settings\.workspace\.description"\)\}\s+actions=\{headerActions\}\s*>/,
    )
    // The empty state is a bare paragraph and the loading state a tertiary spinner: SettingsPageState owns the rest.
    expect(CODE).toContain('<p>{t("settings.workspace.noWorkspaceSelected")}</p>')
    expect(CODE).toContain('<Spinner className="text-tertiary" />')
  })

  it('NEGATIVE — the page draws no PanelHeader, ScrollArea or max-w-3xl column of its own', () => {
    for (const own of ['PanelHeader', 'ScrollArea', 'max-w-3xl', 'mask-fade-y']) {
      expect({ own, present: CODE.includes(own) }).toEqual({ own, present: false })
    }
  })
})

describe('UB15.6 · the controls are the shared Button, and the upload label shows focus', () => {
  it('POSITIVE — Edit / Change are secondary md, Clear is ghost md, the upload is a focus-outlined label around buttonVariants', () => {
    expect(count(CODE, '<Button\n                variant="secondary"\n                size="md"')).toBe(1) // Edit (name)
    expect(count(CODE, '<Button variant="secondary" size="md" onClick={handleChangeWorkingDirectory}>')).toBe(1)
    expect(count(CODE, '<Button variant="ghost" size="md" onClick={handleClearWorkingDirectory}>')).toBe(1)
    expect(CODE).toContain(
      '<label className="cursor-pointer rounded-md has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus">',
    )
    expect(CODE).toContain("<span className={buttonVariants({ variant: 'secondary', size: 'md' })}>")
    expect(CODE).toMatch(/import \{ Button, buttonVariants \} from '@\/components\/ui\/button'/)
  })

  it('NEGATIVE — no hand-rolled <button>, no wrapDescription, no pre-redesign material', () => {
    expect(CODE).not.toMatch(/<button[\s>]/)
    expect(CODE).not.toContain('wrapDescription')
    const legacy = LEGACY_MATERIAL.filter(token => CODE.includes(token))
    expect(legacy).toEqual([])
  })

  it('CONTROL — the material instrument fires on the row HEAD drew before UB15.6', () => {
    const before = '<button type="button" className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors">'
    expect(before).toMatch(/<button[\s>]/)
    expect(LEGACY_MATERIAL.filter(token => before.includes(token))).toEqual(['shadow-minimal', 'hover:bg-foreground/[0.02]'])
  })
})

describe('UB15.6 · KEEP — our specifics survive the merge', () => {
  it('BOUNDARY — the six-mode selector with its managed tier, our sources, folder-by-handle, ceilings, refresh and Published pages', () => {
    // F1.1052 / P4.8 / P2.489: the picker's own list and labels; the managed tier disables the row.
    expect(CODE).toContain('value={displayedPermissionMode}')
    expect(CODE).toContain('disabled={defaultModeDisplay.managed}')
    expect(count(CODE, 'PERMISSION_MODE_PICKER_ORDER.map(')).toBe(1) // the cycling toggles
    expect(CODE).toContain('description: describePermissionModeLine(mode, t)')
    // Upstream's guarded-era helpers stay out (Guarded is D(c); ours names modes through mode.<id>).
    expect(CODE).not.toContain('useAvailablePermissionModes')
    expect(CODE).not.toContain('modeTranslations')
    // R3-C: default sources come from the composer catalog, not getSources().
    expect(CODE).toContain('isComposerSelectableSourceRow')
    expect(CODE).not.toContain('getSources(')
    // The default project folder is set and cleared by handle, with the trust dialog.
    expect(CODE).toContain('setWorkspaceDefaultProject({')
    expect(CODE).toContain('<ProjectTrustDialog')
    // P6.821, F1.1191, UA1.19, local MCP.
    expect(CODE).toContain('{budgetCeilings && (')
    expect(CODE).toContain('onWorkspaceSettingsChanged?.(); return true')
    expect(CODE).toContain('<PublishedPagesSection workspaceId={activeWorkspaceId} />')
    expect(CODE).toContain('onCheckedChange={handleLocalMcpEnabledChange}')
  })
})
