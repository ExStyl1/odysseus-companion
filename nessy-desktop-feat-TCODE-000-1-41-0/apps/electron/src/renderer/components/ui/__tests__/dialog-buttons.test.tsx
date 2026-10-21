/**
 * UB14.36 (R6-07) — the upstream dialogs and pickers on v0.15.1's button vocabulary: Cancel is the ghost, the forward
 * action is the primary with an `aria-hidden` ↵ keycap where Enter in the field submits, and the irreversible Reset
 * is `danger-solid` (`components/ui/button.tsx`'s table, UB13.10). Before the row: Rename and Create Project drew an
 * `outline` Cancel and a bare (default-variant) forward button with no keycap, and Reset drew `destructive` — so every
 * POSITIVE below fails on that tree (`data-variant` is the variant NAME, so the deprecated aliases read as themselves).
 *
 * Instrument (no DOM library ships): the ELEMENT TREE a dialog returns, captured by calling it inside a probe
 * component's render, so its hooks run as the probe's and the handlers read are its own (the UB14.25 recipe in
 * `app-shell/__tests__/AskUserRequest.test.tsx`). Typing into a field sets state during that render, a RENDER-PHASE
 * update React's server renderer applies by rendering the probe again — so "type, then read Save" runs on the real
 * state, one pass per step. A button's own markup is `renderToStaticMarkup` of the element the dialog built.
 * Nothing here opens a portal, so no `mock.module` (and nothing leaks into this directory's other files).
 *
 * The two pickers whose hunks sit behind state they do not expose (`ColorPicker`'s swatches in its closed popover,
 * `CompactWorkingDirectorySelector`'s rows in its drawer) are pinned at the source; the dialogs and the inline colour
 * row are also swept, every playground state in dark, by `playground/__tests__/dialogs-registry.test.ts`.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModalProvider } from '@/context/ModalContext'
import { Button } from '../button'
import { Input } from '../input'
import { Kbd } from '../kbd'
import { RenameDialog } from '../rename-dialog'
import { InlineColorPickerRow } from '../inline-color-picker-row'
import { ResetConfirmationDialog } from '../../ResetConfirmationDialog'
import { CreateProjectDialog } from '../../projects/CreateProjectDialog'

const translations = {
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.enterName': 'Enter a name...',
  'common.hexValue': 'Hex value',
  'common.save': 'Save',
  'dialog.reset.backupWarning': 'Back up any important data first!',
  'dialog.reset.cannotUndo': 'This action cannot be undone.',
  'dialog.reset.confirmSolve': 'To confirm, solve: {{a}} + {{b}} =',
  'dialog.reset.credentials': 'All credentials and API keys',
  'dialog.reset.description': 'This will <strong>permanently delete</strong>:',
  'dialog.reset.enterAnswer': 'Enter answer',
  'dialog.reset.preferences': 'All preferences and session data',
  'dialog.reset.title': 'Reset App',
  'dialog.reset.workspaces': 'All workspaces and their settings',
  'projectInfo.colorNone': 'No color selected',
  'projectInfo.colorSelected': 'Selected color {{value}}',
  'projectsList.createButton': 'Create',
  'projectsList.createDialogNamePlaceholder': 'Project name',
  'projectsList.createDialogTitle': 'New Project',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

type Element = React.ReactElement<Record<string, unknown>>

/** The v0.14 swatch class the hunks replaced, named once, only to assert its absence. */
// eslint-disable-next-line nessy-styles/no-motion-antipatterns
const TRANSITION_ALL = 'transition-all'

const findAll = (node: React.ReactNode, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out)
    return out
  }
  if (!React.isValidElement<Record<string, unknown>>(node)) return out
  if (match(node)) out.push(node)
  findAll(node.props.children as React.ReactNode, match, out)
  return out
}
const only = (node: React.ReactNode, match: (el: Element) => boolean): Element => {
  const found = findAll(node, match)
  expect(found).toHaveLength(1)
  return found[0]!
}
/** The text a button's own children carry (its keycap is not text). */
const textOf = (node: React.ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!React.isValidElement<Record<string, unknown>>(node) || node.type === Kbd) return ''
  return textOf(node.props.children as React.ReactNode)
}
const buttonNamed = (tree: React.ReactNode, name: string) =>
  only(tree, el => el.type === Button && textOf(el.props.children as React.ReactNode) === name)

/**
 * Render `Component` inside a probe: `steps[n]` runs against the tree of render pass n. A step that sets state makes
 * React render the probe again (a render-phase update), so the next step sees the updated dialog.
 */
function drive<P extends object>(Component: (props: P) => React.ReactNode, props: P, steps: Array<(tree: React.ReactNode) => void>): number {
  let passes = 0
  function Probe() {
    const tree = Component(props)
    steps[passes++]?.(tree)
    return null
  }
  renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <ModalProvider>
        <Probe />
      </ModalProvider>
    </I18nextProvider>,
  )
  return passes
}

const type = (tree: React.ReactNode, value: string) =>
  (only(tree, el => el.type === Input).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } })
const pressEnter = (tree: React.ReactNode) => {
  let prevented = false
  ;(only(tree, el => el.type === Input).props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)({
    key: 'Enter',
    preventDefault: () => { prevented = true },
  })
  return prevented
}
/** The keycap a forward button carries: one `Kbd`, `aria-hidden`, showing ↵ — and in its markup too. */
const expectEnterKeycap = (button: Element) => {
  const keycap = only(button.props.children as React.ReactNode, el => el.type === Kbd)
  expect(keycap.props['aria-hidden']).toBe(true)
  expect(keycap.props.children).toBe('↵')
  const html = renderToStaticMarkup(button)
  expect(html).toMatch(/<kbd data-slot="kbd"[^>]*aria-hidden="true"[^>]*>↵<\/kbd><\/button>$/)
}
const variantOf = (button: Element) => renderToStaticMarkup(button).match(/data-variant="([^"]+)"/)?.[1]

describe('RenameDialog (UB14.36, v0.15.1 1:1)', () => {
  const renameProps = (value: string, onSubmit: () => void = () => {}) => ({
    open: true,
    onOpenChange: () => {},
    title: 'Rename session',
    value,
    onValueChange: () => {},
    onSubmit,
  })

  it('POSITIVE — Save is the primary with an aria-hidden ↵ keycap; Cancel is the ghost', () => {
    drive(RenameDialog, renameProps('Quarterly planning'), [tree => {
      const save = buttonNamed(tree, 'Save')
      expect(save.props.variant).toBe('primary')
      expect(variantOf(save)).toBe('primary')
      expect(save.props.disabled).toBe(false)
      expectEnterKeycap(save)
      expect(variantOf(buttonNamed(tree, 'Cancel'))).toBe('ghost')
      // The field is a direct child of the dialog content now (v0.15.1 dropped the `py-4` wrapper).
      expect(findAll(tree, el => el.type === 'div' && el.props.className === 'py-4')).toEqual([])
    }])
  })

  it('NEGATIVE — a whitespace-only name: Save is disabled, and neither Enter nor Save submits', () => {
    let submits = 0
    drive(RenameDialog, renameProps('   ', () => { submits++ }), [tree => {
      const save = buttonNamed(tree, 'Save')
      expect(save.props.disabled).toBe(true)
      expect(renderToStaticMarkup(save)).toContain(' disabled=""')
      pressEnter(tree)
      ;(save.props.onClick as () => void)()
    }])
    expect(submits).toBe(0)
  })

  it('NEGATIVE (control) — the same Enter on a real name submits once, so the arm above can fail', () => {
    let submits = 0
    drive(RenameDialog, renameProps(' Plan ', () => { submits++ }), [tree => { pressEnter(tree) }])
    expect(submits).toBe(1)
  })
})

describe('ResetConfirmationDialog (UB14.36, v0.15.1 hunks)', () => {
  const resetLabel = (tree: React.ReactNode) => textOf(only(tree, el => el.type === 'label').props.children as React.ReactNode)
  const sumOf = (label: string) => {
    const [, a, b] = label.match(/(\d+) \+ (\d+)/) ?? []
    expect(a && b).toBeTruthy()
    return Number(a) + Number(b)
  }

  it('POSITIVE — the irreversible Reset is danger-solid; Cancel is the ghost; the backup note sits on the info tint', () => {
    drive(ResetConfirmationDialog, { open: true, onConfirm: () => {}, onCancel: () => {} }, [tree => {
      const reset = buttonNamed(tree, 'Reset App')
      expect(reset.props.variant).toBe('danger-solid')
      expect(variantOf(reset)).toBe('danger-solid')
      expect(variantOf(buttonNamed(tree, 'Cancel'))).toBe('ghost')
      expect(findAll(tree, el => el.type === 'div' && el.props.className === 'bg-info-tint rounded-md p-3 text-label')).toHaveLength(1)
      expect(findAll(tree, el => typeof el.props.className === 'string' && (el.props.className as string).includes('amber'))).toEqual([])
    }])
  })

  it('NEGATIVE — Reset stays disabled (and confirms nothing) until the sum is answered right; then it confirms once', () => {
    let confirms = 0
    let sum = 0
    const passes = drive(ResetConfirmationDialog, { open: true, onConfirm: () => { confirms++ }, onCancel: () => {} }, [
      tree => {
        sum = sumOf(resetLabel(tree))
        expect(buttonNamed(tree, 'Reset App').props.disabled).toBe(true)
        type(tree, String(sum + 1))
      },
      tree => {
        const reset = buttonNamed(tree, 'Reset App')
        expect(reset.props.disabled).toBe(true)
        ;(reset.props.onClick as () => void)()
        type(tree, String(sum))
      },
      tree => {
        const reset = buttonNamed(tree, 'Reset App')
        expect(reset.props.disabled).toBe(false)
        expect(renderToStaticMarkup(reset)).not.toContain('disabled=""')
        ;(reset.props.onClick as () => void)()
      },
    ])
    expect(passes).toBeGreaterThanOrEqual(3)
    expect(confirms).toBe(1)
  })
})

describe('CreateProjectDialog (UB14.36, v0.15.1 hunks; UA5.8 header kept)', () => {
  it('POSITIVE — Create is the primary with an aria-hidden ↵ keycap; Cancel is the ghost', () => {
    drive(CreateProjectDialog, { open: true, onCancel: () => {}, onSubmit: () => {} }, [tree => {
      const create = buttonNamed(tree, 'Create')
      expect(variantOf(create)).toBe('primary')
      expectEnterKeycap(create)
      expect(variantOf(buttonNamed(tree, 'Cancel'))).toBe('ghost')
    }])
  })

  it('NEGATIVE — a whitespace-only name keeps Create disabled and Enter inert; a real name submits trimmed', () => {
    const submitted: string[] = []
    drive(CreateProjectDialog, { open: true, onCancel: () => {}, onSubmit: (name: string) => { submitted.push(name) } }, [
      tree => {
        expect(buttonNamed(tree, 'Create').props.disabled).toBe(true)
        type(tree, '   ')
      },
      tree => {
        expect(buttonNamed(tree, 'Create').props.disabled).toBe(true)
        expect(pressEnter(tree)).toBe(false)
        type(tree, '  Atlas  ')
      },
      tree => {
        expect(buttonNamed(tree, 'Create').props.disabled).toBe(false)
        expect(pressEnter(tree)).toBe(true)
      },
    ])
    expect(submitted).toEqual(['Atlas'])
  })
})

describe('the colour pickers (UB14.36, v0.15.1 hunks; UA2.3 headers kept)', () => {
  const PRESETS = ['#6366f1', '#10b981', '#f59e0b'] as const
  const rowMarkup = (value: string) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <InlineColorPickerRow value={value} onChange={() => {}} presets={PRESETS} customAriaLabel="Custom color" />
      </I18nextProvider>,
    )
  const swatches = (html: string) => html.match(/<button[^>]*class="h-5 w-5 rounded-full[^"]*"/g) ?? []

  it('POSITIVE — every inline swatch (the presets and the custom one) transitions scale and ring only', () => {
    const found = swatches(rowMarkup('#6366f1'))
    expect(found).toHaveLength(PRESETS.length + 1)
    for (const swatch of found) expect(swatch).toContain('hover:scale-110 transition-[scale,box-shadow]')
  })

  it('NEGATIVE — no swatch keeps transition-all, and the indicator keeps OUR translated label (v0.15.1 ships a literal)', () => {
    const html = rowMarkup('#6366f1')
    expect(html).not.toContain(TRANSITION_ALL)
    expect(html).toContain('aria-label="Selected color #6366f1"')
    expect(rowMarkup('')).toContain('aria-label="No color selected"')
    const source = readFileSync(join(import.meta.dir, '../inline-color-picker-row.tsx'), 'utf8')
    expect(source).toContain("t('projectInfo.colorSelected', { value })")
    expect(source).not.toContain('`Selected color ${value}`')
  })

  it('ColorPicker (source: its swatches render only inside its closed popover): the swatch presses with motion-press', () => {
    const source = readFileSync(join(import.meta.dir, '../color-picker.tsx'), 'utf8')
    expect(source).toContain("'motion-press relative h-5 w-5 rounded-full flex items-center justify-center'")
    // The code, not the provenance header (which names the class it replaced).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).toContain('rounded-full')
    expect(code).not.toContain(TRANSITION_ALL)
  })
})

describe('CompactWorkingDirectorySelector (UB14.36, v0.15.1 hunks; source: its rows render only inside its own drawer)', () => {
  const source = readFileSync(join(import.meta.dir, '../CompactWorkingDirectorySelector.tsx'), 'utf8')

  it('POSITIVE — the current folder, each recent row, Choose folder and Reset pad px-2', () => {
    expect(source.split('gap-3 px-2 py-3 rounded-[10px]').length - 1).toBe(2)
    expect(source.split('w-full h-12 px-2 rounded-[10px]').length - 1).toBe(2)
    expect(source).not.toMatch(/px-3 py-3 rounded-\[10px\]|h-12 px-3 rounded-\[10px\]/)
  })

  it('NEGATIVE (Keep) — rows stay issued project handles in a required workspace, with no per-row remove-recent button', () => {
    expect(source).toContain("import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'")
    expect(source).toContain('onWorkingDirectoryChange: (project: IssuedProjectHandle) => void')
    expect(source).toMatch(/\n {2}workspaceId: string\n/)
    expect(source).not.toContain('handleRemoveRecent')
    expect(source).not.toContain("t('common.remove')")
  })
})
