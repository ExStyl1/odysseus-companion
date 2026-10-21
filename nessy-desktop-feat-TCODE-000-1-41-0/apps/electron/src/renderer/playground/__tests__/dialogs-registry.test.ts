/**
 * UB14.36 (R6-07) — the dialogs registry (`registry/dialogs.tsx`), every state rendered for real in DARK inside the
 * playground's own entry frame by one child process (`fixtures/dialog-entries-probe.ts`; its docblock says why a
 * child and why dark). What a reviewer sees on the playground: the dialog on v0.15.1's floating material, Cancel the
 * ghost, the forward action the primary with an `aria-hidden` ↵ keycap, the irreversible Reset `danger-solid` on the
 * solid destructive fill, the backup note on the info tint, and the inline colour row's swatches transitioning scale
 * and ring only. Before the row each dialog drew `outline` / default / `destructive` buttons, no keycap, a `py-4`
 * field wrapper and an amber warning box, so every POSITIVE fails on that tree.
 *
 * The handlers (Save disabled for whitespace, Reset disabled until the sum is right) are
 * `components/ui/__tests__/dialog-buttons.test.tsx`'s; here the disabled state is read from the markup each knob
 * produces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { DIALOG_ENTRIES_MARKER, type DialogEntryRender } from './fixtures/dialog-entries-probe'

const CHILD = new URL('./fixtures/dialog-entries-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../', import.meta.url).pathname

let renders: DialogEntryRender[] = []
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'dialog-entries-probe-'))
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
  const at = stdout.lastIndexOf(DIALOG_ENTRIES_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`dialog-entries probe exited ${exitCode} without renders:\n${stderr.slice(-4000)}`)
  }
  renders = JSON.parse(stdout.slice(at + DIALOG_ENTRIES_MARKER.length)) as DialogEntryRender[]
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const label = (render: DialogEntryRender) => `${render.id} · ${render.variant ?? '(base state)'}`
const statesOf = (id: string) => renders.filter(render => render.id === id)
const one = (id: string, variant: string | null): string => {
  const render = renders.find(r => r.id === id && r.variant === variant)
  expect({ id, variant, found: !!render?.markup }).toEqual({ id, variant, found: true })
  return render!.markup!
}
/** The footer button whose text (keycap aside) is `name`, as one opening tag + text + optional keycap. */
const buttonOf = (markup: string, name: string) =>
  markup.match(new RegExp(`<button data-slot="button"[^>]*>${name}(?:<kbd[^>]*>↵</kbd>)?</button>`))?.[0] ?? ''

describe('the dialogs registry, every state in dark (UB14.36)', () => {
  it('every state of the four entries is swept, none threw, and the registry is in the index', () => {
    expect(renders.map(label)).toEqual([
      'rename-dialog · (base state)', 'rename-dialog · Empty name', 'rename-dialog · Whitespace only',
      'reset-confirmation-dialog · (base state)',
      'create-project-dialog · (base state)',
      'inline-color-picker-row · (base state)', 'inline-color-picker-row · No colour', 'inline-color-picker-row · Custom colour',
    ])
    expect(renders.filter(render => render.error).map(render => `${label(render)}: ${render.error}`)).toEqual([])
    const index = readFileSync(join(import.meta.dir, '../registry/index.ts'), 'utf8')
    expect(index).toContain("import { dialogComponents } from './dialogs'")
    expect(index).toContain('...dialogComponents,')
  })

  it('POSITIVE — Rename and Create Project: on the floating material, Cancel ghost, the forward primary carries the ↵ keycap', () => {
    for (const [id, forward] of [['rename-dialog', 'Save'], ['create-project-dialog', 'Create']] as const) {
      for (const render of statesOf(id)) {
        const markup = render.markup!
        expect(markup, label(render)).toContain('data-slot="dialog-content" class="motion-dialog')
        expect(markup, label(render)).toContain('rounded-xl bg-floating p-5 text-foreground shadow-elev-3')
        expect(buttonOf(markup, 'Cancel'), label(render)).toContain('data-variant="ghost"')
        const primary = buttonOf(markup, forward)
        expect(primary, label(render)).toContain('data-variant="primary"')
        expect(primary, label(render)).toMatch(/<kbd data-slot="kbd"[^>]*aria-hidden="true"[^>]*>↵<\/kbd><\/button>$/)
      }
    }
    expect(buttonOf(one('rename-dialog', null), 'Save')).not.toContain('disabled=""')
  })

  it('NEGATIVE — Save is disabled for an empty or whitespace-only name, and Create for the empty one it opens with', () => {
    expect(buttonOf(one('rename-dialog', 'Empty name'), 'Save')).toContain('disabled=""')
    expect(buttonOf(one('rename-dialog', 'Whitespace only'), 'Save')).toContain('disabled=""')
    expect(one('rename-dialog', 'Whitespace only')).toContain('value="   "')
    expect(buttonOf(one('create-project-dialog', null), 'Create')).toContain('disabled=""')
  })

  it('POSITIVE — Reset: the irreversible confirm is danger-solid on the solid destructive fill, the note on the info tint', () => {
    const markup = one('reset-confirmation-dialog', null)
    const reset = buttonOf(markup, 'Reset App')
    expect(reset).toContain('data-variant="danger-solid"')
    expect(reset).toContain('bg-destructive-solid text-on-destructive')
    expect(buttonOf(markup, 'Cancel')).toContain('data-variant="ghost"')
    expect(markup).toContain('<div class="bg-info-tint rounded-md p-3 text-label"><strong class="text-info">')
    expect(markup).toMatch(/<label class="text-label font-medium">To confirm, solve: \d+ \+ \d+ =<\/label>/)
  })

  it('NEGATIVE — Reset opens disabled (nothing typed), and no dialog state keeps a v0.14 class', () => {
    expect(buttonOf(one('reset-confirmation-dialog', null), 'Reset App')).toContain('disabled=""')
    const dialogs = [...statesOf('rename-dialog'), ...statesOf('reset-confirmation-dialog'), ...statesOf('create-project-dialog')]
      .map(render => render.markup!).join('\n')
    for (const old of ['data-variant="outline"', 'data-variant="destructive"', 'data-variant="default"', 'bg-amber-500/10', 'text-muted-foreground', '<div class="py-4">', '<div class="pt-2">', 'gap-2 sm:gap-0']) {
      expect({ old, present: dialogs.includes(old) }).toEqual({ old, present: false })
    }
  })

  it('POSITIVE — the inline colour row: eight presets and the custom swatch transition scale and ring only', () => {
    for (const render of statesOf('inline-color-picker-row')) {
      const swatches = render.markup!.match(/<button[^>]*class="h-5 w-5 rounded-full[^"]*"/g) ?? []
      expect(swatches.length, label(render)).toBe(9)
      for (const swatch of swatches) expect(swatch, label(render)).toContain('hover:scale-110 transition-[scale,box-shadow]')
    }
    expect(one('inline-color-picker-row', null)).toContain('aria-label="Selected color #6366f1"')
    expect(one('inline-color-picker-row', 'Custom colour')).toContain('aria-label="Selected color #0EA5A4"')
  })

  it('NEGATIVE — with no colour the indicator says so and Clear is absent; no swatch keeps the v0.14 transition', () => {
    const none = one('inline-color-picker-row', 'No colour')
    expect(none).toContain('aria-label="No color selected"')
    expect(none).not.toContain('>Clear</button>')
    expect(one('inline-color-picker-row', null)).toContain('>Clear</button>')
    const all = statesOf('inline-color-picker-row').map(render => render.markup!).join('\n')
    expect(all).not.toMatch(/rounded-full[^"]*transition-all/)
  })
})
