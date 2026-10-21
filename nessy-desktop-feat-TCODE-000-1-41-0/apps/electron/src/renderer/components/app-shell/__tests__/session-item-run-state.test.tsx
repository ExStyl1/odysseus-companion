/**
 * UB14.3 (R2-05, R2-06; upstream v0.15.1 `SessionItem.tsx`, `SessionBadges.tsx` + `fit-labels.ts`,
 * `SessionInfoPopover.tsx`) — the session row's anatomy, the "+N" label expand, and the info popover's
 * controlled `open`.
 *
 * Before the row a session's state was a strip of glyphs beside the status icon (spinner, unread blob, plan
 * plane, shield) carrying the attention label; labels sat on a third "badges" line that scrolled sideways; the
 * popover needed a trigger and had a fixed 460px height. Every POSITIVE arm below fails on that tree: there was
 * no `data-run-state`, no "+N", and no way to open the popover without a trigger.
 *
 * Instrument: one child process (`fixtures/session-row-probe.ts`; its docblock says why a child and how each
 * reading is taken) — `renderToStaticMarkup` of the playground entries' states (the design surface, dark theme)
 * and two render-phase toggles through the components' own handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { fitLabelCount } from '../fit-labels'
import { SESSION_ROW_PROBE_MARKER, type SessionRowProbeReading } from './fixtures/session-row-probe'

const CHILD = new URL('./fixtures/session-row-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname
const APP_SHELL = join(import.meta.dir, '..')

let reading: SessionRowProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'session-row-probe-'))
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
  const at = stdout.lastIndexOf(SESSION_ROW_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`session-row probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + SESSION_ROW_PROBE_MARKER.length)) as SessionRowProbeReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const row = (variant: string) => {
  const html = reading.states[`session-item-search · ${variant}`]
  if (html === undefined) throw new Error(`no state "session-item-search · ${variant}" (threw: ${JSON.stringify(reading.threw)})`)
  return html
}
/** The opening tag of the row's run-state line, or null. */
const runStateTag = (html: string) => html.match(/<span data-run-state="[^"]*"[^>]*>/)?.[0] ?? null
/** The opening tag of the row's title element. */
const titleTag = (html: string) => html.match(/<div data-slot="entity-row-title"[^>]*>/)?.[0] ?? ''
/** Every label chip wrapper, in order (React writes a `true` data attribute as `"true"`). */
const chipTags = (html: string) => html.match(/<span data-label-measure="true"[^>]*>/g) ?? []
/** The "+N" / "show fewer" controls: elements announcing expanded state that are not a chip's own value popover. */
const expanders = (html: string) =>
  (html.match(/<div [^>]*aria-expanded="(true|false)"[^>]*>/g) ?? []).filter(tag => !tag.includes('data-slot="popover-trigger"'))

describe('the probe covered the states', () => {
  it('POSITIVE CONTROL — every state of the three entries rendered, none threw', () => {
    expect(reading.threw).toEqual({})
    for (const key of [
      'session-item-search · Needs you — server count only',
      'session-item-search · Needs you — labels give way',
      'session-item-search · Failed',
      'session-item-search · Labels on line 2',
      'session-badges · +N collapsed',
      'session-badges · +N expanded',
      'session-info-popover · Open, no trigger (controlled)',
      'session-info-popover · Trigger, closed (uncontrolled)',
    ]) expect(Object.keys(reading.states)).toContain(key)
  })
})

describe('UB14.3 — the session row: the run-state line (our predicates) and the unread title', () => {
  it('POSITIVE — the server\'s awaitingApprovalCount alone (no local card) renders "needs you", naming the tool (P6.757/P6.764)', () => {
    const html = row('Needs you — server count only')
    const tag = runStateTag(html)
    expect(tag).toContain('data-run-state="needs-you"')
    expect(tag).toContain('text-info')
    // The attention label naming WHAT waits is the line's tooltip and accessible name (P6.270).
    expect(tag).toContain('title="Waiting for you: Bash"')
    expect(tag).toContain('aria-label="Waiting for you: Bash"')
    expect(tag).toContain('role="status"')
    expect(html).toContain('>Waiting for you</span>')
  })

  it('POSITIVE — a processing meta renders the working line; failed and plan-ready render theirs', () => {
    const working = runStateTag(row('Loading'))
    expect(working).toContain('data-run-state="working"')
    expect(working).toContain('aria-label="Working — the model is running this session"')
    expect(row('Loading')).toContain('Working…')
    const failed = runStateTag(row('Failed'))
    expect(failed).toContain('data-run-state="failed"')
    expect(failed).toContain('text-destructive')
    expect(row('Failed')).toContain('Stopped with an error')
    expect(runStateTag(row('Plan Pending'))).toContain('data-run-state="plan"')
    expect(row('Plan Pending')).toContain('Plan ready for review')
  })

  it('POSITIVE — while the row needs you, its labels give way (v0.15.1; the P6.589 answer\'s slot is pinned from source)', () => {
    const html = row('Needs you — labels give way')
    expect(runStateTag(html)).toContain('data-run-state="needs-you"')
    expect(html).not.toContain('data-slot="session-labels"')
    // This host supplies no onRespondToPermission, so the answer would draw nothing — and reserves no slot.
    expect(html).not.toContain('shrink-0 w-[55%]')
    // Control: the same labels with no run state own the second line.
    const labelled = row('Labels on line 2')
    expect(labelled).toContain('data-slot="session-labels"')
    expect(runStateTag(labelled)).toBeNull()
  })

  it('NEGATIVE — an idle unread meta renders the 600 title and the accent dot, and NO run-state line', () => {
    const html = row('New / Unread')
    expect(titleTag(html)).toContain('font-semibold')
    expect(html).toContain('size-2 shrink-0 rounded-full bg-accent-solid')
    expect(html).toContain('<span class="sr-only">Unread</span>')
    expect(runStateTag(html)).toBeNull()
    // Control on the same instrument: a read row has neither.
    const read = row('Default')
    expect(titleTag(read)).not.toContain('font-semibold')
    expect(read).not.toContain('bg-accent-solid')
  })

  it('NEGATIVE — the marker strip is gone (no shield, no unread blob); the row carries one named ⋯ button', () => {
    for (const variant of ['Needs you — server count only', 'Loading', 'New / Unread']) {
      const html = row(variant)
      expect(html).not.toContain('lucide-shield-alert')
      expect(html).toContain('aria-label="Actions for Fix authentication bug in login flow"')
    }
  })
})

describe('UB14.3 — SessionBadges: "+N" expands the labels in place (v0.15.1)', () => {
  it('fit-labels: six chips on a 260px line keep the counter\'s room and stop at the last whole chip', () => {
    // Six 50px chips need 320px with their 4px gaps; 260px holds four whole chips plus a 24px "+2".
    expect(fitLabelCount([50, 50, 50, 50, 50, 50], 260, 24)).toBe(4)
    // Boundary: the same six at exactly their full width fit with no counter.
    expect(fitLabelCount([50, 50, 50, 50, 50, 50], 320, 24)).toBe(6)
  })

  it('POSITIVE — six labels with two whole: "+4" (collapsed, naming the rest), four chips hidden', () => {
    const html = reading.states['session-badges · +N collapsed']!
    const [more, ...rest] = expanders(html)
    expect(rest).toEqual([])
    expect(more).toContain('aria-expanded="false"')
    expect(more).toContain('aria-label="4 more labels"')
    expect(more).toContain('title="Frontend, Backend, Priority · high, Research"')
    expect(html).toContain('>+4</div>')
    const chips = chipTags(html)
    expect(chips).toHaveLength(6)
    expect(chips.filter(tag => tag.includes('aria-hidden="true"'))).toHaveLength(4)
  })

  it('POSITIVE — clicking "+4" (its own handler) expands IN PLACE: the same six chips, none hidden, then "show fewer"', () => {
    const before = reading.toggles.badgesBefore
    const after = reading.toggles.badgesAfter
    expect(chipTags(before).filter(tag => tag.includes('aria-hidden="true"'))).toHaveLength(4)
    const chips = chipTags(after)
    expect(chips).toHaveLength(6)
    expect(chips.filter(tag => tag.includes('aria-hidden="true"'))).toEqual([])
    // The four revealed chips slide in (the reveal transition), the two that were visible do not.
    expect(chips.filter(tag => tag.includes('transition-[opacity,translate]'))).toHaveLength(4)
    expect(after).toContain('flex-wrap')
    const [less, ...rest] = expanders(after)
    expect(rest).toEqual([])
    expect(less).toContain('aria-expanded="true"')
    expect(less).toContain('aria-label="Show fewer labels"')
    // The playground's expanded state is the same render.
    expect(expanders(reading.states['session-badges · +N expanded']!)[0]).toContain('aria-label="Show fewer labels"')
  })

  it('NEGATIVE (control) — labels that fit show no "+N" and no expander', () => {
    const html = reading.states['session-badges · All fit']!
    expect(chipTags(html)).toHaveLength(2)
    expect(expanders(html)).toEqual([])
    expect(chipTags(html).filter(tag => tag.includes('aria-hidden="true"'))).toEqual([])
  })
})

describe('UB14.3 — SessionInfoPopover: controlled open, optional trigger, hugs its content (v0.15.1)', () => {
  it('POSITIVE — `open` with no trigger renders the content, sized to hug up to 460px', () => {
    const html = reading.states['session-info-popover · Open, no trigger (controlled)']!
    expect(html).toContain('id="session-info-title-session-1"')
    expect(html).toContain('max-h-[460px]')
    expect(html).not.toMatch(/[\s"]h-\[460px\]/)
    expect(html).not.toContain('data-slot="popover-trigger"')
  })

  it('BOUNDARY — uncontrolled with a trigger renders only the trigger, and its own onOpenChange opens it', () => {
    const closed = reading.states['session-info-popover · Trigger, closed (uncontrolled)']!
    expect(closed).toContain('data-slot="popover-trigger"')
    expect(closed).not.toContain('id="session-info-title-session-1"')
    expect(reading.toggles.popoverBefore).toContain('aria-expanded="false"')
    expect(reading.toggles.popoverBefore).not.toContain('id="session-info-title-session-1"')
    expect(reading.toggles.popoverAfter).toContain('aria-expanded="true"')
    expect(reading.toggles.popoverAfter).toContain('id="session-info-title-session-1"')
  })
})

describe('UB14.3 — the menus (R2-06)', () => {
  const read = (file: string) => readFileSync(join(APP_SHELL, file), 'utf8')

  it('the label count is the distinct applied labels, shown only when > 0, in both menus', () => {
    expect(read('SessionMenu.tsx')).toContain('{actions.appliedLabelIds.size > 0 && (')
    expect(read('CompactSessionMenu.tsx')).toContain('labelsCount={actions.appliedLabelIds.size}')
    // Control: the entry count they used before is gone from both.
    for (const file of ['SessionMenu.tsx', 'CompactSessionMenu.tsx']) expect(read(file)).not.toContain('sessionLabels.length')
  })

  it('the compact menu takes onShowInfo / initialView / onCloseAutoFocus, and (UB14.6) no longer draws a title pill', () => {
    const src = read('CompactSessionMenu.tsx')
    expect(src).toContain("label={t('chat.sessionInfo')} onTap={onShowInfo}")
    expect(src).toContain('if (open) setView(initialView)')
    expect(src).toContain('<DrawerContent onCloseAutoFocus={onCloseAutoFocus}>')
    expect(src).toContain('label={statusDisplayLabel(state, t)}')
    // UB14.6 retired the omitted-trigger title pill (the chat header is `ChatHeader` now, as v0.15.1): an omitted
    // trigger renders none, exactly as `null` does.
    expect(src).toContain('{trigger != null && <DrawerTrigger asChild>{trigger}</DrawerTrigger>}')
    expect(src).not.toContain('title-pill button')
    expect(src).not.toContain('isRegeneratingTitle')
    expect(src).not.toContain('MessagingPane')
  })
})
