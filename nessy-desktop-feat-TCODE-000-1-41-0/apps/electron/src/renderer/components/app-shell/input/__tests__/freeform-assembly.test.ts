/**
 * UB14.32 — FreeFormInput assembled in v0.15.0's order with our behaviour (R4-12).
 *
 * Upstream v0.15.0 `input/FreeFormInput.tsx` ("A new look"): the composer owns its `@container/panel`; a file
 * dragged over it draws an inset focus ring on the accent tint instead of a labelled overlay; the toolbar is ONE
 * flex row for both layouts — attach (an `IconButton`) · sources · folder on the left, a spacer, mode · model in a
 * squeezable right group, then the context chip and Send outside the squeeze. It replaced our Codex-parity grid
 * footer, where compact led with mode · model on the LEFT.
 *
 * Source-level, the instrument `compact-placeholder.test.ts` records the reason for (no DOM in `bun test`, and the
 * component's graph reaches `ThemeContext`'s Vite-only `import.meta.glob`). The REAL rendered order is read in dark
 * by `playground/__tests__/registry-render.test.ts` (its UB14.32 describe).
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
/** Comments stripped, so a docblock naming a symbol is never read as a mount. */
const stripped = (relative: string): string =>
  read(relative).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const input = stripped('../FreeFormInput.tsx')
const REPO_ROOT = fileURLToPath(new URL('../../../../../../../../', import.meta.url))
const EN = JSON.parse(read('../../../../../../../../packages/shared/src/i18n/locales/en.json')) as Record<string, string>
const RU = JSON.parse(read('../../../../../../../../packages/shared/src/i18n/locales/ru.json')) as Record<string, string>

/** Index of `needle` at or after `from`; -1 when absent. */
const at = (needle: string, from = 0) => input.indexOf(needle, from)

describe('UB14.32 — the card and the drop target (v0.15.0)', () => {
  it('POSITIVE — the composer owns its panel container, and a drag draws the inset focus ring on the accent tint', () => {
    expect(input).toContain("'@container/panel relative flex flex-col min-h-0 overflow-hidden transition-colors'")
    expect(input).toContain("isDraggingOver && 'ring-2 ring-inset ring-focus bg-accent-tint'")
    // The standalone card UB14.27 took stays.
    expect(input).toContain("!unstyled && 'rounded-xl bg-raised shadow-elev-2'")
  })

  it('NEGATIVE (control) — the "Drop to attach" pill and the two keys the old toolbar read are gone, in en and ru', () => {
    expect(input).not.toContain('chat.dropToAttach')
    expect(input).not.toContain('bg-background/60')
    expect(input).not.toContain('t("chat.attach")')
    for (const [locale, keys] of [['en', EN], ['ru', RU]] as const) {
      expect({ locale, dropToAttach: 'chat.dropToAttach' in keys, attach: 'chat.attach' in keys })
        .toEqual({ locale, dropToAttach: false, attach: false })
      // Positive control on the same instrument: the attach button's own names are still there.
      expect({ locale, attachFiles: 'chat.attachFiles' in keys, tooltip: 'chat.attachFilesTooltip' in keys })
        .toEqual({ locale, attachFiles: true, tooltip: true })
    }
  })
})

describe('UB14.32 — the toolbar in upstream\'s order', () => {
  it('POSITIVE — attach · sources · folder · (branch) · spacer · [mode · model] · context · Send, one row for both layouts', () => {
    const actions = at('data-composer-actions')
    const row = at('"flex items-center gap-1 pb-1.5", compactMode ? "px-1" : "px-2"', actions)
    // UB12.78 — the floor is `composerLeftGroupFloor` (v0.15.1's three icons, four where our branch chip mounts).
    const left = at('cn(composerLeftGroupFloor(mountsBranchChip), "shrink overflow-hidden @max-[32rem]/panel:[&_[data-badge-label]]:hidden")', row)
    const attach = at('<IconButton', left)
    const sources = at('<ComposerSourcesChip', attach)
    const folder = at('<WorkingDirectoryBadge', sources)
    const branch = at('<BranchSwitcher', folder)
    const spacer = at('<div className="flex-1" />', branch)
    const right = at('"-m-1 flex min-w-0 shrink items-center gap-1 overflow-hidden p-1"', spacer)
    const compactMode = at('<CompactPermissionModeSelector', right)
    const desktopMode = at('<ComposerModeChip', right)
    const compactModel = at('<CompactModelSelector', desktopMode)
    const desktopModel = at('<ComposerModelMenu', compactModel)
    const context = at('<ContextUsageChip', desktopModel)
    const send = at('<SendButton', context)
    // Each search starts at its predecessor, so "every one found" IS the order.
    for (const [name, index] of Object.entries({ actions, row, left, attach, sources, folder, branch, spacer, right, compactMode, desktopMode, compactModel, desktopModel, context, send })) {
      expect({ name, found: index > -1 }).toEqual({ name, found: true })
    }
    // Compact folds every left chip to its icon; the attach control is upstream's named icon button.
    expect(input).toContain('? "shrink-0 [&_[data-badge-label]]:hidden"')
    expect(input).toContain('icon={<Paperclip />}')
    expect(input).toContain('className="input-toolbar-btn"')
  })

  it('NEGATIVE (control) — compact no longer leads with mode · model: no mode or model control sits in the left group', () => {
    const left = at('cn(composerLeftGroupFloor(mountsBranchChip), "shrink overflow-hidden')
    const right = at('"-m-1 flex min-w-0 shrink items-center gap-1 overflow-hidden p-1"', left)
    expect({ left: left > -1, right: right > left }).toEqual({ left: true, right: true })
    const leftGroup = input.slice(left, right)
    for (const control of ['<CompactPermissionModeSelector', '<ComposerModeChip', '<CompactModelSelector', '<ComposerModelMenu', '<SendButton']) {
      expect({ control, inLeftGroup: leftGroup.includes(control) }).toEqual({ control, inLeftGroup: false })
    }
    // Each control is mounted exactly once (the two layouts share one toolbar).
    for (const control of ['<CompactPermissionModeSelector', '<ComposerModeChip', '<ComposerSourcesChip', '<IconButton', '<SendButton']) {
      expect({ control, mounts: input.split(control).length - 1 }).toEqual({ control, mounts: 1 })
    }
  })
})

describe('UB14.32 — Done means: the Codex grid footer has no reader left', () => {
  // The needles are built from parts so this file is no hit itself.
  const FOOTER_PATTERN = [['composer', 'footer'].join('-'), ['Composer', 'Footer', 'Label'].join(''), ['Context', 'Usage', 'Donut'].join('')].join('|')
  const gitGrep = (pattern: string) => Bun.spawnSync(
    ['git', 'grep', '-n', '-E', pattern, '--', 'apps/electron/src/renderer/components', 'apps/electron/src/renderer/index.css'],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )

  it('NEGATIVE — no component (nor the renderer stylesheet) names the footer, its label or the donut', () => {
    const result = gitGrep(FOOTER_PATTERN)
    expect({ exitCode: result.exitCode, hits: result.stdout.toString() }).toEqual({ exitCode: 1, hits: '' })
    expect(existsSync(fileURLToPath(new URL('../composer-parts.tsx', import.meta.url)))).toBe(false)
  })

  it('POSITIVE CONTROL — the same instrument finds the chip that replaced the donut', () => {
    const result = gitGrep(['Context', 'Usage', 'Chip'].join(''))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('FreeFormInput.tsx')
  })
})
