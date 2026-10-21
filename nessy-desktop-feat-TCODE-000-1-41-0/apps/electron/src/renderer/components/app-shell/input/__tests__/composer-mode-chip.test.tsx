/**
 * UB14.29 — `ComposerModeChip`: v0.15.1's tinted mode pill in the composer toolbar, over OUR menu content
 * (the six Claude modes, F1.1052's badges and digits, R15's 440px descriptions and single runtime note, `locked`).
 *
 * Instruments, both without a DOM (this repo ships none):
 * - `renderToStaticMarkup` for what the trigger draws (Radix renders the closed trigger server-side; the menu body
 *   sits in a portal, which SSR never mounts);
 * - the ELEMENT TREE the component returns, captured by calling it inside a probe component's render (its hooks
 *   run as the probe's), so the menu's rows, its `onKeyDown`, its root `open` and each row's `onSelect` are real
 *   values we can read and call. A state setter called after the probe returned is a no-op on the server, which is
 *   exactly what lets `onSelect` be pressed here.
 *
 * Rows come from the REAL chain the composer runs (capabilities → `resolveComposerPermissionModeList` →
 * `withPermissionModeMenuDecorations`), strings from the shipped `en.json`.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/modes'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import { isMac } from '@/lib/platform'
import { StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { DrawerContent } from '@/components/ui/drawer'
import {
  resolveComposerPermissionModeList,
  selectPermissionModeByDigit,
  withPermissionModeMenuDecorations,
  type ComposerPermissionModeMenuDisplay,
} from '@/lib/composer-permission-modes'
import { ComposerModeChip, type ComposerModeChipProps } from '../ComposerModeChip'
import { CompactPermissionModeSelector } from '../CompactPermissionModeSelector'

const EN = LOCALE_REGISTRY.en.messages as Record<string, string>
const SHIFT = isMac ? '⇧' : 'Shift'
const MOD = isMac ? '⌘' : 'Ctrl'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    resources: { en: { translation: EN } },
    interpolation: { escapeValue: false },
  })
})

const wrap = (node: React.ReactNode) => <I18nextProvider i18n={testI18n}>{node}</I18nextProvider>
const render = (node: React.ReactNode) => renderToStaticMarkup(wrap(node))

function caps(runtime: 'pi' | 'codex-runtime' = 'pi'): ComposerCapabilities {
  return {
    attachments: { files: true, images: 'no', folders: true },
    mentions: { files: true, skills: true, sources: true },
    slash: { commandIds: 'all' },
    submit: { queue: true, steer: false },
    reasoning: { levels: [] },
    permissions: { modes: PERMISSION_MODE_ORDER },
    connection: { switchable: true, activeRuntime: runtime },
    contextMeter: true,
    externalFooter: { gitBranch: true },
  }
}

const translateEn = (key: string) => EN[key] ?? key

/** The composer's own chain: the picker's rows with their badges and digits (workspace default = Auto). */
function rows(runtime: 'pi' | 'codex-runtime' = 'pi'): { displays: ComposerPermissionModeMenuDisplay[]; runtimeNote?: string } {
  const list = resolveComposerPermissionModeList(caps(runtime), translateEn)
  return { displays: list.modes.map(withPermissionModeMenuDecorations('auto')), runtimeNote: list.runtimeNote }
}

const base = (overrides: Partial<ComposerModeChipProps> = {}): ComposerModeChipProps => ({
  permissionMode: 'acceptEdits',
  onPermissionModeChange: () => {},
  permissionModeDisplays: rows().displays,
  sessionId: 'session-ub14-29',
  ...overrides,
})

/** The element tree `ComposerModeChip` returns for these props (its hooks run inside the probe's render). */
function treeOf(props: ComposerModeChipProps): React.ReactElement<Record<string, unknown>> {
  let tree: React.ReactNode = null
  function Probe() {
    tree = ComposerModeChip(props)
    return null
  }
  renderToStaticMarkup(wrap(<Probe />))
  expect(React.isValidElement(tree)).toBe(true)
  return tree as unknown as React.ReactElement<Record<string, unknown>>
}

function findAll(
  node: React.ReactNode,
  match: (el: React.ReactElement<Record<string, unknown>>) => boolean,
  out: React.ReactElement<Record<string, unknown>>[] = [],
) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out)
    return out
  }
  if (!React.isValidElement<Record<string, unknown>>(node)) return out
  if (match(node)) out.push(node)
  findAll(node.props.children as React.ReactNode, match, out)
  return out
}

/** The trigger's opening tag (the one `data-tutorial="permission-mode-dropdown"` button). */
function triggerTag(markup: string): string {
  const tags = markup.match(/<button[^>]*data-tutorial="permission-mode-dropdown"[^>]*>/g) ?? []
  expect(tags).toHaveLength(1)
  return tags[0]!
}

describe('UB14.29 · the trigger is v0.15.1\'s tinted pill, keyed to our six modes', () => {
  it('POSITIVE — Accept edits renders data-mode and the success tone on the 28px rounded pill, named in full', () => {
    const tag = triggerTag(render(<ComposerModeChip {...base()} />))
    expect(tag).toContain('data-mode="acceptEdits"')
    for (const cls of ['bg-success-tint', 'text-success', 'h-control', 'rounded-full', 'motion-press', 'state-overlay', 'input-toolbar-btn']) {
      expect({ cls, present: tag.includes(cls) }).toEqual({ cls, present: true })
    }
    expect(tag).toContain(`aria-label="${EN['chat.permissionMode']}: ${EN['mode.acceptEdits']}"`)
    expect(tag).toContain('aria-haspopup="menu"')
    expect(tag).not.toContain('disabled=""')
    expect(render(<ComposerModeChip {...base()} />)).toContain(`>${EN['mode.acceptEdits']}</span>`)
    // The old toolbar trigger's material is gone.
    expect(tag).not.toContain('rounded-[6px]')
  })

  it('every picker mode gets its own tone family (Manual/Auto info, Plan/Bypass accent)', () => {
    const tone: Partial<Record<PermissionMode, string>> = {
      default: 'bg-info-tint', auto: 'bg-info-tint', plan: 'bg-accent-tint', bypassPermissions: 'bg-accent-tint',
    }
    for (const [mode, cls] of Object.entries(tone)) {
      const tag = triggerTag(render(<ComposerModeChip {...base({ permissionMode: mode as PermissionMode })} />))
      expect({ mode, dataMode: tag.includes(`data-mode="${mode}"`), tone: tag.includes(cls!) }).toEqual({ mode, dataMode: true, tone: true })
    }
  })

  it('NEGATIVE (control) — `locked` disables the trigger, and the menu does not open even when asked to start open', () => {
    const lockedTag = triggerTag(render(<ComposerModeChip {...base({ locked: true })} />))
    expect(lockedTag).toContain('disabled=""')
    expect(lockedTag).toContain('data-mode="acceptEdits"') // the tone stays: the chip still says WHICH mode is fixed
    expect(treeOf(base({ locked: true, defaultOpen: true })).props.open).toBe(false)
    // The same instrument CAN read an open menu: unlocked, the same request opens it.
    expect(treeOf(base({ defaultOpen: true })).props.open).toBe(true)
    expect(treeOf(base()).props.open).toBe(false)
  })

  it('boundary — a mode the list does not offer (dontAsk) is named by THAT mode; an unknown one draws as Manual', () => {
    const dontAsk = triggerTag(render(<ComposerModeChip {...base({ permissionMode: 'dontAsk' })} />))
    expect(rows().displays.some(display => display.mode === 'dontAsk')).toBe(false)
    expect(dontAsk).toContain('data-mode="dontAsk"')
    expect(dontAsk).toContain(`aria-label="${EN['chat.permissionMode']}: ${EN['mode.dontAsk']!.replace(/'/g, '&#x27;')}"`)
    expect(dontAsk).toContain('bg-fill-hover text-secondary')
    const unknown = triggerTag(render(<ComposerModeChip {...base({ permissionMode: 'guarded' as PermissionMode })} />))
    expect(unknown).toContain('data-mode="default"')
    expect(unknown).toContain('bg-info-tint')
  })
})

describe('UB14.29 · the menu content stays ours', () => {
  const menuRows = (props: ComposerModeChipProps) => findAll(treeOf(props), el => el.type === StyledDropdownMenuItem)
  const contentOf = (props: ComposerModeChipProps) =>
    findAll(treeOf(props), el => el.props.onKeyDown !== undefined && el.props.side === 'top')

  it('the rows are the picker\'s rows, in order, each with its digit; the digits select (F1.1052)', () => {
    const { displays } = rows()
    const items = menuRows(base())
    expect(items.map(item => item.key)).toEqual(displays.map(display => display.mode))
    expect(items.map(item => item.props['data-permission-mode-shortcut'])).toEqual([1, 2, 3, 4, 5])
    const content = contentOf(base())
    expect(content).toHaveLength(1)
    expect(content[0]!.props.onKeyDown).toBe(selectPermissionModeByDigit)
    expect(content[0]!.props.className).toContain('max-w-(--radix-dropdown-menu-content-available-width)')
  })

  it('selecting a row writes that mode; a locked chip writes nothing', () => {
    const onPermissionModeChange = mock((_mode: PermissionMode) => {})
    const plan = menuRows(base({ onPermissionModeChange })).find(item => item.key === 'plan')!
    ;(plan.props.onSelect as () => void)()
    expect(onPermissionModeChange.mock.calls).toEqual([['plan']])

    const lockedChange = mock((_mode: PermissionMode) => {})
    const lockedPlan = menuRows(base({ onPermissionModeChange: lockedChange, locked: true })).find(item => item.key === 'plan')!
    ;(lockedPlan.props.onSelect as () => void)()
    expect(lockedChange).not.toHaveBeenCalled()
  })

  it('the runtime note is drawn ONCE, as a plain element, and no band at all when the list carries none (R15)', () => {
    const notesOf = (props: ComposerModeChipProps) =>
      findAll(treeOf(props), el => el.props['data-permission-mode-runtime-note'] !== undefined)
    for (const runtime of ['codex-runtime', 'pi'] as const) {
      const list = rows(runtime)
      expect({ runtime, note: typeof list.runtimeNote }).toEqual({ runtime, note: 'string' })
      const notes = notesOf(base({ permissionModeDisplays: list.displays, runtimeNote: list.runtimeNote }))
      expect({ runtime, bands: notes.length }).toEqual({ runtime, bands: 1 })
      expect(notes[0]!.type).toBe('p')
      expect(notes[0]!.props.children).toBe(list.runtimeNote)
    }
    // Codex's note is longer than Pi's (its own caveat before the shared resume sentence).
    expect(rows('codex-runtime').runtimeNote!.length).toBeGreaterThan(rows('pi').runtimeNote!.length)
    expect(notesOf(base({ runtimeNote: undefined }))).toHaveLength(0)
  })

  it('UB12.110 POSITIVE — the menu takes v0.15.1\'s placement for the right-hand group: side top, align end, 6px', () => {
    const content = contentOf(base())
    expect(content).toHaveLength(1)
    const { side, align, sideOffset } = content[0]!.props
    expect({ side, align, sideOffset }).toEqual({ side: 'top', align: 'end', sideOffset: 6 })
    // Opened on mount (the playground's open state), it is the same one end-aligned content.
    expect(contentOf(base({ defaultOpen: true })).map(el => el.props.align)).toEqual(['end'])
  })

  it('UB12.110 NEGATIVE (control) — the compact drawer is a bottom sheet: no anchored content, no align of its own', () => {
    let tree: React.ReactNode = null
    function Probe() {
      tree = CompactPermissionModeSelector({
        permissionMode: 'acceptEdits',
        onPermissionModeChange: () => {},
        permissionModeDisplays: rows().displays,
      })
      return null
    }
    renderToStaticMarkup(wrap(<Probe />))
    const sheets = findAll(tree, el => el.type === DrawerContent)
    expect(sheets).toHaveLength(1)
    expect({ align: sheets[0]!.props.align, side: sheets[0]!.props.side }).toEqual({ align: undefined, side: undefined })
    // The same instrument reads an `align` where one is set: nothing in the drawer's tree carries the prop.
    expect(findAll(tree, el => el.props.align !== undefined)).toEqual([])
    expect(findAll(treeOf(base()), el => el.props.align !== undefined)).toHaveLength(1)
  })

  it('the footer names the cycle shortcut with the binding the user HAS (P6.49); an unbound action draws no footer', () => {
    const keycapsOf = (props: ComposerModeChipProps) => {
      const footers = findAll(treeOf(props), el => el.props['data-permission-mode-cycle-hint'] !== undefined)
      if (footers.length === 0) return null
      const keys = findAll(footers[0]!.props.children as React.ReactNode, el => el.type !== 'span' && typeof el.props.children === 'string')
      return keys.map(el => el.props.children)
    }
    expect(keycapsOf(base())).toEqual([SHIFT, 'Tab'])
    expect(keycapsOf(base({ cycleHotkey: 'mod+m' }))).toEqual([MOD, 'M'])
    expect(keycapsOf(base({ cycleHotkey: null }))).toBeNull()
    expect(EN['shortcuts.action.cyclePermissionMode']).toBe('Cycle Permission Mode')
  })
})
