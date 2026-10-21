/**
 * F1.216 — EVERY playground entry renders, and a blank one is a red.
 *
 * ## Why this exists
 *
 * The playground is the design surface every UI lane is told to sweep, and
 * until this file nothing rendered it. The `EditPopover` and `/btw` entries were
 * blank for an unknown time while three lanes extended them (fixed by
 * `ae4ee7834`, P-WJ-t-4); the source-level pin that commit added can see the
 * one rule it names — an entry that mounts `ChatDisplay` wraps its providers —
 * and nothing else. Its first run here found SEVEN more entries that threw on
 * their first render (`input-container`, `permission-input-toggle`,
 * `active-tasks-bar-context`, `slash-command-demo`, `automation-info-page`,
 * `automation-event-timeline` for a missing provider, and
 * `turn-card-transcript-verbosity`, whose base state had no `activities`), plus
 * one whose base state rendered nothing at all (`agent-panel`); all eight are
 * fixed in the same commit.
 *
 * ## What it does
 *
 * One child process (`fixtures/render-every-entry.ts` — its docblock says why a
 * child, and the four places the static render is made to match a page)
 * enumerates `componentRegistry` itself, so a new entry is covered by
 * construction and there is no hand list to forget. For each entry it renders
 * the base state the page opens it in AND every variant, through
 * `ComponentPreview`'s own merge and frame (`playgroundEntryProps`,
 * `PlaygroundEntryFrame`), and reports `rendered`, `empty` or `threw`.
 *
 * `empty` means the entry added no markup of its own to the frame — measured
 * as the frame's markup with the entry minus the same frame with nothing in it.
 * A handful of VARIANTS are designed to draw nothing (a hidden banner, an empty
 * strip); they are named below with their reason, and the list checks itself:
 * a named state that starts drawing something, or stops existing, is a red too,
 * so it cannot rot into an allowlist. No base state is on it — an entry that
 * opens blank is the defect this file exists for.
 *
 * ## Cost, measured 2026-09-23
 *
 * The child is the renderer's whole module graph: 166.57 s real / 4.13 s user /
 * 1.04 s sys for 854 renders over 154 entries at load ~11–14 — I/O, not CPU,
 * which is AGENTS.md's module-graph family. Under `bun test` the FILE took
 * 200.49 s while junit timed every case body below 1 ms, so the whole cost is
 * the hook's: it pays it once, under `MODULE_GRAPH_HOOK_BUDGET_MS`, and kills
 * the child 30 s before that so a hang fails with the child's own stderr
 * rather than a bare timer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { CompactChatCard } from '@/components/ui/compact-chat-card'
import { VERDICTS_MARKER, type EntryVerdict } from './fixtures/render-every-entry'
import { COLOUR_CENSUS_HOOK_BUDGET_MS, loadColourVocabulary, type ColourVocabulary } from '../../__tests__/colour-role-census'

/**
 * Variants DESIGNED to draw nothing — `id · variant name` → why. Base states
 * (`variant: null`) may never appear here.
 */
const DESIGNED_EMPTY: Readonly<Record<string, string>> = {
  'attachment-preview · Empty': 'the strip is absent when nothing is attached — the state the variant shows',
  'setup-auth-banner · Hidden': 'the banner is absent when no activation is needed — the state the variant shows',
}

const CHILD = new URL('./fixtures/render-every-entry.ts', import.meta.url).pathname
/** F1.91's entry: the compact chat in the card the add popover wears. */
const COMPACT_CHAT_ENTRY = 'compact-chat-display'
/** UB14.27's entries: the composer card, its attachment strip, and the chip above it. */
const UB14_27_ENTRIES = ['input-container', 'attachment-preview', 'background-finished-chip'] as const
/** UB14.25's standalone entry: the ask_user dialog in every scenario (the hosted states are `input-container`'s). */
const UB14_25_ENTRIES = ['orchestration-ask-user'] as const
/** UB14.12's entries: the TurnCard shell (answer, footer, plan card, compact drawer) and the verbosity modes it keeps. */
const UB14_12_ENTRIES = ['turn-card', 'turn-card-transcript-verbosity'] as const
/** UB14.26's entry: the transcript auth card in every state (credential, OAuth, Google, dp; pending, waiting, finished). */
const UB14_26_ENTRIES = ['auth-request-card'] as const
/** UB14.29's entry: the composer's mode chip (desktop) and drawer selector (compact) in every mode, locked and narrow. */
const UB14_29_ENTRIES = ['parity-permission-mode-selector'] as const
/** UB14.30's entries: the composer model chip + menu (desktop) and the compact model selector's trigger. */
const UB14_30_ENTRIES = ['parity-desktop-model-picker', 'parity-compact-model-selector'] as const
/** UB14.31's entry: the toolbar's sources chip and branch chip in every state (the composer's own are `input-container`'s). */
const UB14_31_ENTRIES = ['composer-toolbar-chips'] as const
/** UB15.1's sweep: every `settings-*` entry, on the v0.15.1 settings primitives (the list checks itself below). */
const UB15_1_SETTINGS_ENTRIES = [
  'settings-blocked-tools-unenforceable', 'settings-browser-download', 'settings-browser-origin-trust',
  'settings-codex-auto-review', 'settings-config-doctor', 'settings-decision-model', 'settings-isolation-network-posture',
  'settings-judge-denials', 'settings-judge-rules', 'settings-permissions-cross-scope', 'settings-provenance',
  'settings-safe-mode', 'settings-sandbox-switches',
  // UB15.2's entry: the settings navigator (EntityRow anatomy; no primitive rows, so only the census reads it).
  'settings-navigator',
  // UB15.4's entry: the Shortcuts page (its rows take v0.15.1's denser SHORTCUT_ROW_CLASS, read below).
  'settings-shortcuts',
  // UB15.9's entry: the Appearance Mode section, colour theme grid and Motion row (read again below).
  'settings-theme-grid',
] as const
/** UB15.2's entry, read again on its own below. */
const UB15_2_NAVIGATOR_ENTRY = 'settings-navigator'
/** UB15.4's entry, read again on its own below. */
const UB15_4_SHORTCUTS_ENTRY = 'settings-shortcuts'
/** UB15.9's entry, read again on its own below. */
const UB15_9_THEME_GRID_ENTRY = 'settings-theme-grid'
/** v0.15.1 `ShortcutsPage.tsx` `SHORTCUT_ROW_CLASS = 'min-h-11 py-2'` merged over `settingsUI.row` (44px rows, not 56px). */
const UB15_4_SHORTCUT_ROW = 'gap-4 px-3.5 min-h-11 py-2'
/** UB15.3's entry: the Settings → Import panel (ours), on the settings material and roles in every state. */
const UB15_3_IMPORT_ENTRY = 'claude-import-panel'
/** UB14.35's entries: the session-row label chip, its value editor open, the # menu, the status menu, EditButton. */
const UB14_35_ENTRIES = ['entity-list-label-badge', 'label-value-editor', 'inline-label-menu', 'session-status-menu', 'edit-button'] as const
/** UB12.58's entry: Settings → Workspace's Published pages section (ours), on the settings material in every state. */
const UB12_58_PUBLISHED_PAGES_ENTRY = 'published-pages-list'
/** UB14.34's entry: the pasted console snippet's "Run in background" chip above the composer, every state. */
const UB14_34_PASTED_COMMAND_ENTRY = 'pasted-command-chip'
/** UB12.84's mock entries: the Marketplace browse page (the Sentry tile in the Installed strip) and the planner's sync palette (the Unavailable state). */
const UB12_84_MOCK_ENTRIES = ['marketplace-browse', 'planner-sync-palette'] as const
/** UB14.55's entries: the rows above the composer alone and in context; `chat-header` is the label detector's control. */
const UB14_55_ENTRIES = ['active-option-badges', 'active-tasks-bar-context', 'chat-header'] as const
/** UB12.79's entry: the overlay a task card's Open fills — an agent's digest as a document, a command in the terminal. */
const UB12_79_TASK_OUTPUT_ENTRY = 'task-output-overlay'
/** UB12.97's mock entries: the label row's simulated input area, the two overlay openers, the mobile session list's status glyphs. */
const UB12_97_MOCK_ENTRIES = ['label-badge-row-standalone', 'document-overlay', 'data-table-overlay', 'mobile-webui-session-list'] as const
const REPO_ROOT = new URL('../../../../../../', import.meta.url).pathname

let verdicts: EntryVerdict[] = []
let configDir = ''

beforeAll(async () => {
  // The child runs as `bun <file>`, where the root `bunfig.toml` preload freezes
  // the config dir at import (AGENTS.md §Traps) — so it is isolated BEFORE bun
  // starts, never after.
  configDir = mkdtempSync(join(tmpdir(), 'playground-render-'))
  // The child returns the whole markup only for the entries named here (F1.91, UB14.27, UB14.25, UB14.12, UB14.26, UB14.29, UB14.30, UB14.31, UB15.1 with UB15.2's navigator and UB15.4's shortcuts, UB14.35, UB15.3, UB12.58, UB12.84, UB14.55, UB12.79, UB12.97).
  const child = Bun.spawn([process.execPath, CHILD, COMPACT_CHAT_ENTRY, ...UB14_27_ENTRIES, ...UB14_25_ENTRIES, ...UB14_12_ENTRIES, ...UB14_26_ENTRIES, ...UB14_29_ENTRIES, ...UB14_30_ENTRIES, ...UB14_31_ENTRIES, ...UB15_1_SETTINGS_ENTRIES, ...UB14_35_ENTRIES, UB15_3_IMPORT_ENTRY, UB12_58_PUBLISHED_PAGES_ENTRY, UB14_34_PASTED_COMMAND_ENTRY, ...UB12_84_MOCK_ENTRIES, ...UB14_55_ENTRIES, UB12_79_TASK_OUTPUT_ENTRY, ...UB12_97_MOCK_ENTRIES], {
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
  const at = stdout.lastIndexOf(VERDICTS_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`render child exited ${exitCode} without verdicts:\n${stderr.slice(-4000)}`)
  }
  verdicts = JSON.parse(stdout.slice(at + VERDICTS_MARKER.length)) as EntryVerdict[]
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const label = (verdict: EntryVerdict) => `${verdict.id} · ${verdict.variant ?? '(base state)'}`

describe('every playground entry renders (F1.216)', () => {
  it('POSITIVE CONTROL — the child enumerated the registry, base state and variants', () => {
    const baseStates = verdicts.filter(verdict => verdict.variant === null).map(verdict => verdict.id)
    // One base state per entry, and ids are unique — a duplicate id would make
    // `getComponentById` open the wrong entry on the page.
    expect(new Set(baseStates).size).toBe(baseStates.length)
    // The entries measured blank before `ae4ee7834`, and the one that mounts the
    // compact chat, are in the enumeration — so it is the registry, not a subset.
    expect(baseStates).toEqual(expect.arrayContaining(['edit-popover', 'compact-chat-display', 'side-question-panel']))
    expect(baseStates.length).toBeGreaterThan(100)
    expect(verdicts.length).toBeGreaterThan(baseStates.length)
  })

  it('no base state and no variant throws on render', () => {
    const threw = verdicts.filter(verdict => verdict.outcome === 'threw').map(verdict => `${label(verdict)}: ${verdict.error}`)
    expect(threw).toEqual([])
  })

  it('no base state and no variant renders empty, except the states designed to', () => {
    const empty = verdicts
      .filter(verdict => verdict.outcome === 'empty')
      .map(label)
      .filter(key => !(key in DESIGNED_EMPTY))
    expect(empty).toEqual([])
  })

  it('the designed-empty list checks itself: each named state exists, is a variant, and is still empty', () => {
    const byKey = new Map(verdicts.map(verdict => [label(verdict), verdict]))
    const stale = Object.keys(DESIGNED_EMPTY).filter(key => byKey.get(key)?.outcome !== 'empty')
    expect(stale).toEqual([])
    expect(Object.keys(DESIGNED_EMPTY).filter(key => key.includes('(base state)'))).toEqual([])
  })
})

/**
 * F1.91 — the compact-chat entry draws the SHIPPED card, not a copy of it.
 *
 * The entry (`registry/edit-popover.tsx`, category Edit Popover) drew a
 * hand-built frame — its own radius, grip row and border — so the design surface
 * would drift from the shipped popover the day `CompactChatCard` changed, while
 * `compact-chat-card.test.tsx` pinned only the SHIPPED side. The card's own
 * opening markup (the card, its grip, and its content slot up to the chat) is
 * rendered here from the component itself and must appear, byte for byte, in
 * every state of the entry. CONTROL, measured 2026-09-23 on the entry's pre-fix
 * markup (the same child, the same states): 0 of 9 states carried it and 9 of 9
 * carried the copy's `popover-styled`.
 */
describe('the compact-chat entry wears the shipped card (F1.91)', () => {
  const SLOT = '<i data-f191-slot=""></i>'
  const cardOpening = () =>
    renderToStaticMarkup(
      createElement(CompactChatCard, {
        // The entry's base state, and `EditPopover`'s own arm: at rest, draggable.
        transform: 'translate(0px, 0px)',
        onGripMouseDown: () => {},
        isDragging: false,
        children: createElement('i', { 'data-f191-slot': '' }),
      }),
    ).split(SLOT)[0]!
  const states = () => verdicts.filter(verdict => verdict.id === COMPACT_CHAT_ENTRY)

  it('every state carries CompactChatCard\'s own markup, grip and content slot included', () => {
    const opening = cardOpening()
    // The instrument reads a real card: its classes and its grip are in it.
    expect(opening).toContain('relative bg-foreground-2 overflow-hidden w-full h-full shadow-modal-small')
    expect(opening).toContain('lucide-grip-horizontal')
    expect(states().length).toBeGreaterThan(1)
    expect(states().filter(verdict => !verdict.markup?.includes(opening)).map(label)).toEqual([])
  })

  it('NEGATIVE — none of them draws the hand-built copy any more', () => {
    const copies = states()
      .filter(verdict => verdict.markup?.includes('popover-styled') || verdict.markup?.includes('border-b border-border/30'))
      .map(label)
    expect(copies).toEqual([])
  })
})

/**
 * UB14.27 — the composer card on v0.15.1's material, rendered for real (dark) in every state the row
 * touches. `InputContainer` cannot be imported by a plain test (its module graph reaches
 * `ThemeContext`'s Vite-only `import.meta.glob`), so this child — which stubs that — is the one
 * instrument that renders it; `input-container-look.test.ts` pins the wiring from source.
 */
describe('the composer card, its decision ring and its neighbours (UB14.27)', () => {
  const INFO_RING = 'ring-[color:var(--info-border)]'
  const DANGER_RING = 'ring-[color:var(--destructive-border)]'
  const FOCUS_RING = 'focus-within:ring-focus/55'
  const GLASS_SURFACE = ['composer', 'surface'].join('-')
  const state = (id: string, variant: string | null) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!
  }
  /** The visible card's class list (the measuring copy is a plain `overflow-hidden rounded-xl` div). */
  const cardClasses = (markup: string): string[] => {
    const all = [...markup.matchAll(/class="(input-container [^"]*)"/g)]
    expect(all).toHaveLength(1)
    return all[0]![1]!.split(/\s+/)
  }

  it('POSITIVE — a permission prompt wears the info ring on the raised card, not the focus ring', () => {
    const card = cardClasses(state('input-container', 'Permission Mode UI'))
    expect(card).toEqual(expect.arrayContaining(['rounded-xl', 'bg-raised', 'shadow-elev-1', 'ring-1', INFO_RING]))
    expect(card).not.toContain(FOCUS_RING)
    expect(card).not.toContain(DANGER_RING)
  })

  it('POSITIVE — a risky permission (a decision-model badge) wears the destructive ring', () => {
    const card = cardClasses(state('input-container', 'Permission (risky) UI'))
    expect(card).toContain(DANGER_RING)
    expect(card).not.toContain(INFO_RING)
  })

  it('NEGATIVE (control) — freeform wears the focus ring and no decision ring, and no glass', () => {
    const markup = state('input-container', null)
    const card = cardClasses(markup)
    expect(card).toEqual(expect.arrayContaining(['rounded-xl', 'bg-raised', 'shadow-elev-1', FOCUS_RING]))
    expect(card).not.toContain(INFO_RING)
    expect(card).not.toContain(DANGER_RING)
    for (const glass of [GLASS_SURFACE, 'backdrop-blur-lg', 'bg-background/95']) expect(card).not.toContain(glass)
    expect(markup).toContain('class="peer/composer relative"')
  })

  it('the attachment strip keeps an extension outside the truncating stem; the chip floats above the card', () => {
    expect(state('attachment-preview', 'Long names')).toContain(
      '<span class="truncate">q3-planning-notes-for-the-gateway-migration</span><span class="shrink-0">.md</span>',
    )
    expect(state('attachment-preview', 'Long names')).toContain('<span class="truncate">Makefile-for-the-release-rehearsal-pipeline</span></span>')
    expect(state('attachment-preview', 'Pasted text')).toContain('<button type="button"')
    const chip = state('background-finished-chip', 'One background completion')
    expect(chip).toContain('absolute right-0 bottom-full mb-2 z-20')
    expect(chip).not.toContain(GLASS_SURFACE)
  })
})

/**
 * UB14.28 — the send control, the context chip and the follow-up chips, rendered for real (dark) inside
 * the whole composer: the `input-container` states this row added, plus the existing ones it changes
 * (base = an empty Send, "Processing + Tasks" = a live Stop, "Follow-up Review").
 */
describe('the send control, the context chip and the follow-up chips (UB14.28)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (variant: string | null) => {
    const verdict = verdicts.find(v => v.id === 'input-container' && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!
  }
  /** The one send control's opening tag. */
  const sendTag = (markup: string): string => {
    const tags = markup.match(/<button[^>]*data-tutorial="send-button"[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    return tags[0]!
  }

  it('POSITIVE — a turn running with a draft: the accent control is a SUBMIT named Steer (Queue on a queue runtime)', () => {
    const steer = sendTag(markupOf('Processing + draft (Steer)'))
    for (const part of ['type="submit"', 'data-mode="steer"', 'data-state="ready"', `aria-label="${EN['chat.submit.steer']}"`, 'bg-accent-solid', 'send-btn']) {
      expect({ part, inTag: steer.includes(part) }).toEqual({ part, inTag: true })
    }
    const queue = sendTag(markupOf('Processing + draft (Queue)'))
    expect(queue).toContain('data-mode="queue"')
    expect(queue).toContain(`aria-label="${EN['chat.submit.queue']}"`)
  })

  it('POSITIVE — a live Stop is the same accent (not grey), a plain button; an empty Send is idle', () => {
    const stop = sendTag(markupOf('Processing + Tasks'))
    for (const part of ['type="button"', 'data-state="stop"', 'bg-accent-solid']) expect(stop).toContain(part)
    expect(stop).not.toContain('disabled=""')
    const idle = sendTag(markupOf(null))
    expect(idle).toContain('data-state="idle"')
    expect(idle).toContain('disabled=""')
    expect(sendTag(markupOf('Draft ready (Send)'))).toContain('data-state="ready"')
  })

  it('POSITIVE — the context meter: the quiet ring, the info-tint chip at the warning, the broken ring with no window', () => {
    const quiet = markupOf('Context meter (quiet)')
    // UB14.29 — the toolbar's mode chip in Manual wears `bg-info-tint` too, so the quiet ring's "no tint" is read
    // on the ring's own element, and the warning chip's absence on its state.
    const quietTags = quiet.match(/<[^>]*data-state="quiet"[^>]*>/g) ?? []
    expect(quietTags.length).toBeGreaterThan(0)
    expect(quietTags.filter(tag => tag.includes('bg-info-tint'))).toEqual([])
    expect(quiet).not.toContain('data-state="warning"')
    const warning = markupOf('Context meter (warning)')
    expect(warning).toMatch(/<button type="button"[^>]*data-state="warning"[^>]*class="[^"]*bg-info-tint/)
    expect(warning).toContain('70%</button>')
    const running = markupOf('Context meter (warning, turn running)').match(/<button[^>]*data-state="warning"[^>]*>/g) ?? []
    expect(running).toHaveLength(1)
    expect(running[0]).toContain('disabled=""')
    const unknown = markupOf('Context window unknown')
    expect(unknown).toContain('data-state="unknown"')
    expect(unknown).toContain('>?</text>')
  })

  it('NEGATIVE (control) — nothing reported yet draws no meter at all; the follow-up chips wear v0.15.1\'s material', () => {
    const base = markupOf(null)
    for (const state of ['data-state="quiet"', 'data-state="warning"', 'data-state="unknown"']) expect(base).not.toContain(state)
    const followUps = markupOf('Follow-up Review')
    expect(followUps).toContain('class="keycap ')
    expect(followUps).toContain('bg-fill-hover')
    expect(followUps).not.toContain('bg-foreground/2')
  })
})

/**
 * UB14.23 — the credential and admin cards on v0.15.1's decision anatomy, rendered for real (dark) inside
 * the composer slot: the `input-container` states this row added (Credential UI, basic auth) and the two
 * admin states it restyles. Hosted by the slot, the card draws no material of its own — the composer card
 * carries the info ring (UB14.27).
 */
describe('the credential and admin cards on the decision anatomy (UB14.23)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const INFO_RING = 'ring-[color:var(--info-border)]'
  const markupOf = (variant: string) => {
    const verdict = verdicts.find(v => v.id === 'input-container' && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!
  }
  /**
   * The VISIBLE card onward: InputContainer renders the structured card twice, an invisible measuring copy
   * first (`aria-hidden`, height only) and then the card inside `.input-container`.
   */
  const visible = (markup: string): string => {
    const at = markup.indexOf('class="input-container ')
    expect(at).toBeGreaterThan(-1)
    expect(markup.slice(0, at)).toContain('data-decision-tone=') // the measuring copy, before the card
    return markup.slice(at)
  }
  /** The visible decision card's own opening tag (exactly one per state). */
  const decisionTag = (markup: string): string => {
    const tags = markup.match(/<div[^>]*data-decision-tone="[^"]*"[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    return tags[0]!
  }
  const composerCard = (markup: string): string => markup.match(/class="(input-container [^"]*)"/)?.[1] ?? ''

  it('POSITIVE — the credential card: info anatomy hosted by the ring-carrying slot, Save the submit, a named reveal, the translated foot', () => {
    const markup = markupOf('Credential UI')
    const tag = decisionTag(visible(markup))
    expect(tag).toContain('data-decision-tone="info"')
    expect(tag).not.toContain('shadow-elev-2') // hosted: the slot draws the material
    expect(composerCard(markup)).toContain(INFO_RING)
    expect(markup).toContain('action="https://linear.app"')
    const submits = (visible(markup).match(/<button[^>]*>/g) ?? []).filter(tag => tag.includes('type="submit"'))
    expect(submits).toHaveLength(1) // Save is the card's one submit (Cancel and the reveal are plain buttons)
    for (const part of ['data-variant="primary"', 'bg-accent-solid', 'disabled=""']) expect(submits[0]).toContain(part)
    expect(markup).toContain(`aria-label="${EN['chat.credentials.showValue']}"`)
    expect(markup).toContain(EN['auth.credentialsEncryptedAtRest'])
    expect(markup).toContain('bg-info-tint text-info')
    const basic = markupOf('Credential UI (basic auth)')
    expect(basic).toContain('name="username"')
    expect(basic).toContain('name="password"')
  })

  it('POSITIVE — the admin card: the remember switch in the actions row, the command in the sunken well', () => {
    const markup = markupOf('Admin Approval UI')
    expect(decisionTag(visible(markup))).toContain('data-decision-tone="info"')
    expect(composerCard(markup)).toContain(INFO_RING)
    expect(visible(markup)).toContain('role="switch"')
    expect(markup).toContain('bg-sunken')
    expect(markup).toContain('brew install --cask docker')
  })

  it('NEGATIVE (control) — under an ask rule there is no switch and the rule is named; neither card keeps the old tinted block', () => {
    const askRule = markupOf('Admin Approval UI (ask rule)')
    expect(askRule).not.toContain('role="switch"')
    expect(askRule).toContain('ask-brew')
    for (const variant of ['Admin Approval UI', 'Admin Approval UI (ask rule)', 'Credential UI']) {
      for (const old of ['bg-info/5', 'border-info/30']) {
        expect({ variant, old, found: visible(markupOf(variant)).includes(old) }).toEqual({ variant, old, found: false })
      }
    }
  })
})

/**
 * UB14.24 — the permission card on v0.15.1's decision anatomy, rendered for real (dark) inside the composer
 * slot in every `input-container` permission state: the three it already had and the nine variant states
 * this row added. Hosted by the slot, the card draws no material of its own (UB14.27's ring is the slot's).
 */
describe('the permission card on the decision anatomy, every variant (UB14.24)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const STATES = [
    'Permission Mode UI',
    'Permission + Impact UI',
    'Permission (risky) UI',
    'Permission UI (switch to auto mode)',
    'Permission UI (no remember key)',
    'Permission UI (subagent, session-only)',
    'Permission UI (outside read)',
    'Permission UI (outside root)',
    'Permission UI (worktree cleanup)',
    'Permission UI (reopen compact)',
    'Permission UI (artifact publish)',
    'Permission UI (defaultToNo)',
  ] as const
  const markupOf = (variant: string) => {
    const verdict = verdicts.find(v => v.id === 'input-container' && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!
  }
  /** The VISIBLE card onward (InputContainer renders an `aria-hidden` measuring copy first, UB14.23). */
  const visible = (markup: string): string => {
    const at = markup.indexOf('class="input-container ')
    expect(at).toBeGreaterThan(-1)
    expect(markup.slice(0, at)).toContain('data-decision-tone=')
    return markup.slice(at)
  }
  const decisionTag = (markup: string): string => {
    const tags = markup.match(/<div[^>]*data-decision-tone="[^"]*"[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    return tags[0]!
  }
  /** The opening tag of the visible button whose label is `label`. */
  const buttonLabelled = (markup: string, label: string): string => {
    const tags = [...markup.matchAll(/(<button[^>]*>)((?:(?!<\/button>).)*)<\/button>/g)]
      .filter(match => match[2]!.replace(/<[^>]*>/g, '') === label)
      .map(match => match[1]!)
    expect({ label, count: tags.length }).toEqual({ label, count: 1 })
    return tags[0]!
  }

  it('POSITIVE — every permission state is the decision card in the slot: its tone and tutorial hook, no material of its own, no old tinted or dashed style', () => {
    for (const variant of STATES) {
      const card = visible(markupOf(variant))
      const tag = decisionTag(card)
      expect({ variant, tutorial: tag.includes('data-tutorial="permission-banner"'), hosted: !tag.includes('shadow-elev-2') })
        .toEqual({ variant, tutorial: true, hosted: true })
      for (const old of ['bg-info/5', 'border-info/30', 'bg-destructive/5', 'rounded-[8px]', 'border-dashed', 'shadow-middle']) {
        expect({ variant, old, found: card.includes(old) }).toEqual({ variant, old, found: false })
      }
    }
    expect(decisionTag(visible(markupOf('Permission (risky) UI')))).toContain('data-decision-tone="danger"')
    expect(visible(markupOf('Permission (risky) UI'))).toContain('bg-destructive-tint text-destructive')
  })

  it('POSITIVE — the outside-read state: three answers, Keep allowing the primary and the two refusals ghosts; the path in the sunken well', () => {
    const card = visible(markupOf('Permission UI (outside read)'))
    expect(buttonLabelled(card, EN['chat.outsideRead.keepAllowing']!)).toContain('data-variant="primary"')
    expect(buttonLabelled(card, EN['chat.outsideRead.blockFromNowOn']!)).toContain('data-variant="ghost"')
    expect(buttonLabelled(card, EN['chat.outsideRead.askAgain']!)).toContain('data-variant="ghost"')
    expect(card).toMatch(/bg-sunken[^"]*"[^>]*>\/etc\/hosts</)
    expect(card).not.toContain(`>${EN['chat.permissionAlwaysAllow']}<`)
  })

  it('POSITIVE — the auto-switch state: the switch and Always Allow secondaries, Deny the ghost, the note offered; defaultToNo draws Allow secondary and focuses Deny', () => {
    const card = visible(markupOf('Permission UI (switch to auto mode)'))
    expect(buttonLabelled(card, EN['chat.permissionAllow']!)).toContain('data-variant="primary"')
    expect(buttonLabelled(card, EN['chat.permissionSwitchToAuto']!)).toContain('data-variant="secondary"')
    expect(buttonLabelled(card, EN['chat.permissionAlwaysAllow']!)).toContain('data-variant="secondary"')
    expect(buttonLabelled(card, EN['chat.permissionDeny']!)).toContain('data-variant="ghost"')
    expect(card).toContain('data-testid="permission-answer-note-open"')
    const declined = visible(markupOf('Permission UI (defaultToNo)'))
    expect(buttonLabelled(declined, EN['chat.permissionAllow']!)).toContain('data-variant="secondary"')
    expect(buttonLabelled(declined, EN['chat.permissionDeny']!)).toContain('autofocus')
  })

  it('NEGATIVE (control) — worktree cleanup and a keyless Bash card render no Always Allow; the plain permission state does', () => {
    const cleanup = visible(markupOf('Permission UI (worktree cleanup)'))
    expect(cleanup).not.toContain(`>${EN['chat.permissionAlwaysAllow']}<`)
    expect(buttonLabelled(cleanup, EN['worktree.cleanup.remove']!)).toContain('data-variant="primary"')
    expect(buttonLabelled(cleanup, EN['worktree.cleanup.keep']!)).toContain('data-variant="ghost"')
    const keyless = visible(markupOf('Permission UI (no remember key)'))
    expect(keyless).not.toContain(`>${EN['chat.permissionAlwaysAllow']}<`)
    expect(keyless).toContain(EN['chat.permissionRemember.bashOnce'])
    expect(buttonLabelled(visible(markupOf('Permission Mode UI')), EN['chat.permissionAlwaysAllow']!)).toContain('data-variant="secondary"')
  })

  // UB12.84 — the impact block (both states that carry one) and the publish card's access line wear v0.15.1's amber
  // "needs you" role; the `warning` spelling they had drew nothing (tokens.css defines no warning colour).
  it('POSITIVE (UB12.84) — the impact block and the publish access line wear the info tint, its inset hairline and the info ink; NEGATIVE — no permission state draws a warning class', () => {
    const NEEDS_YOU = ['bg-info-tint', 'text-info', 'inset-ring', 'inset-ring-[var(--info-border)]']
    for (const [variant, testId] of [
      ['Permission + Impact UI', 'permission-impact'],
      ['Permission UI (worktree cleanup)', 'permission-impact'],
      ['Permission UI (artifact publish)', 'artifact-publish-access'],
    ] as const) {
      const block = new RegExp(`<div class="([^"]*)" data-testid="${testId}">`).exec(visible(markupOf(variant)))
      const classes = block?.[1]!.split(' ') ?? []
      expect({ variant, testId, missing: NEEDS_YOU.filter(cls => !classes.includes(cls)) }).toEqual({ variant, testId, missing: [] })
    }
    for (const variant of STATES) {
      expect({ variant, warning: visible(markupOf(variant)).match(/(?:text|bg|border)-warning\b/g) ?? [] }).toEqual({ variant, warning: [] })
    }
  })
})

/**
 * UB12.84 — the two playground mocks that spelled the same dead `warning` classes, rendered for real (dark) in
 * every state of their entries: the Marketplace browse page's Installed strip (the Sentry tile, `text-warning`)
 * and the planner's sync palette (the Unavailable state, `text-warning bg-warning/12`). Both now draw amber on
 * the `info` role tokens.css defines.
 */
describe('the playground mocks draw amber on the info role (UB12.84)', () => {
  const WARNING_CLASS = /(?:text|bg|border)-warning\b/g
  const states = (id: string) => {
    const found = verdicts.filter(v => v.id === id && typeof v.markup === 'string')
    expect({ id, states: found.length > 0 }).toEqual({ id, states: true })
    return found
  }
  /** The markup from `start` up to the first `end` after it. */
  const sliceFrom = (markup: string, start: string, end: string): string => {
    const at = markup.indexOf(start)
    expect({ start, found: at > -1 }).toEqual({ start, found: true })
    return markup.slice(at, markup.indexOf(end, at))
  }

  it('POSITIVE — the Sentry tile and the Unavailable sync glyph carry text-info', () => {
    const populated = states('marketplace-browse').find(v => v.variant === 'Populated')!.markup!
    expect(sliceFrom(populated, 'aria-label="Sentry — Update available: 2.4.0"', '</button>')).toMatch(/<svg[^>]*class="[^"]*\btext-info\b/)
    const palette = states('planner-sync-palette').find(v => v.variant === null)!.markup!
    const unavailable = palette.slice(palette.lastIndexOf('<svg', palette.indexOf('</svg>Unavailable')), palette.indexOf('</svg>Unavailable'))
    expect(unavailable).toMatch(/class="[^"]*\btext-info\b/)
  })

  it('NEGATIVE — no state of either entry draws a warning class (the needle matches the spelling it replaced)', () => {
    expect('text-warning bg-warning/12'.match(WARNING_CLASS)).toEqual(['text-warning', 'bg-warning'])
    for (const verdict of [...states('marketplace-browse'), ...states('planner-sync-palette')]) {
      expect({ state: label(verdict), warning: verdict.markup!.match(WARNING_CLASS) ?? [] }).toEqual({ state: label(verdict), warning: [] })
    }
  })
})

/**
 * UB12.97 — the playground mocks that spelled colour roles no stylesheet defines, rendered for real (dark) in every
 * state of their entries: the label row's simulated input area (`bg-sidebar` → v0.15.1's raised card `bg-raised`), the
 * document and data-table overlay openers (`text-accent-foreground` → the primary-button `bg-accent-solid
 * text-on-accent`) and the mobile session list's status glyphs (Needs Review drew `var(--warning)` → `var(--info)`).
 * Every colour class in their markup is judged by the renderer census' instrument (`renderer/__tests__/colour-role-census.ts`).
 */
describe('the playground mocks draw on colour roles the stylesheet defines (UB12.97)', () => {
  let vocabulary: ColourVocabulary
  beforeAll(async () => {
    vocabulary = await loadColourVocabulary()
  }, COLOUR_CENSUS_HOOK_BUDGET_MS)
  const TOKENS_CSS = readFileSync(join(REPO_ROOT, 'packages/ui/src/styles/tokens.css'), 'utf8')
  const states = (id: string) => {
    const found = verdicts.filter(v => v.id === id && typeof v.markup === 'string')
    expect({ id, states: found.length > 0 }).toEqual({ id, states: true })
    return found
  }
  /** Every class attribute of a static markup, entities decoded, joined. */
  const classesOf = (markup: string) => [...markup.matchAll(/ class="([^"]*)"/g)]
    .map(match => match[1]!.replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#x27;/g, "'").replace(/&quot;/g, '"'))
    .join(' ')
  /** The custom properties the status glyphs colour themselves with (`style="color:var(--x)"`). */
  const glyphColours = (markup: string) => [...markup.matchAll(/style="color:var\((--[\w-]+)\)"/g)].map(match => match[1]!)

  it('POSITIVE — the input area is the raised card, both openers the primary-button material, every status glyph a tokens.css colour', () => {
    for (const verdict of states('label-badge-row-standalone')) {
      expect({ state: label(verdict), raised: verdict.markup!.includes('class="w-[500px] rounded-[12px] border border-border bg-raised overflow-hidden"') })
        .toEqual({ state: label(verdict), raised: true })
    }
    for (const verdict of [...states('document-overlay'), ...states('data-table-overlay')]) {
      const opener = /<button class="([^"]*)">Open (?:Document Overlay|Data Table)<\/button>/.exec(verdict.markup!)
      expect({ state: label(verdict), opener: opener?.[1] }).toEqual({ state: label(verdict), opener: 'px-4 py-2 bg-accent-solid text-on-accent rounded-lg text-sm font-medium hover:bg-accent-solid/90' })
    }
    const byStatus = states('mobile-webui-session-list').find(v => v.variant === 'Status grouping')!.markup!
    expect(byStatus).toContain('>Needs Review</span>')
    expect(glyphColours(byStatus)).toContain('--info')
    for (const verdict of states('mobile-webui-session-list')) {
      for (const colour of new Set(glyphColours(verdict.markup!))) {
        expect({ state: label(verdict), colour, defined: new RegExp(`^\\s*${colour}\\s*:`, 'm').test(TOKENS_CSS) }).toEqual({ state: label(verdict), colour, defined: true })
      }
    }
  })

  it('NEGATIVE — no state of the four entries draws a colour class that generates no CSS, nor var(--warning)', () => {
    // The instrument flags the spellings these mocks replaced, and tokens.css defines no --warning.
    expect(vocabulary.unresolved('bg-sidebar text-accent-foreground bg-raised text-on-accent')).toEqual(['bg-sidebar', 'text-accent-foreground'])
    expect(/^\s*--warning\s*:/m.test(TOKENS_CSS)).toBe(false)
    for (const verdict of UB12_97_MOCK_ENTRIES.flatMap(id => states(id))) {
      expect({ state: label(verdict), unresolved: vocabulary.unresolved(classesOf(verdict.markup!)), warning: verdict.markup!.includes('var(--warning)') })
        .toEqual({ state: label(verdict), unresolved: [], warning: false })
    }
  })
})

/**
 * UB14.25 — our own structured cards on v0.15.1's decision anatomy, rendered for real (dark): hosted by the
 * composer slot (`input-container`: the two ask-user states and the two workflow-launch states this row
 * restyles, plus the artifact-publish card whose DETAILS it restyles) and standalone (`orchestration-ask-user`,
 * every scenario: options, free text, batched, countdown, preview, the three URL-consent panels).
 */
describe('our structured cards on the decision anatomy (UB14.25)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const OLD = ['bg-info/5', 'border-info/30', 'rounded-[8px]', 'border-dashed', 'shadow-middle', 'text-muted-foreground', 'bg-foreground/5']
  const markupOf = (id: string, variant: string) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!
  }
  /** The VISIBLE card onward (InputContainer renders an `aria-hidden` measuring copy first, UB14.23). */
  const visible = (markup: string): string => {
    const at = markup.indexOf('class="input-container ')
    expect(at).toBeGreaterThan(-1)
    expect(markup.slice(0, at)).toContain('data-decision-tone=')
    return markup.slice(at)
  }
  const decisionTag = (markup: string): string => {
    const tags = markup.match(/<div[^>]*data-decision-tone="[^"]*"[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    return tags[0]!
  }
  /** The opening tag of the one button whose visible label is `label`. */
  const buttonLabelled = (markup: string, label: string): string => {
    const tags = [...markup.matchAll(/(<button[^>]*>)((?:(?!<\/button>).)*)<\/button>/g)]
      .filter(match => match[2]!.replace(/<[^>]*>/g, '') === label)
      .map(match => match[1]!)
    expect({ label, count: tags.length }).toEqual({ label, count: 1 })
    return tags[0]!
  }
  /** The decision card's own subtree: from its opening tag to the `</div>` that balances it. */
  const cardOf = (markup: string): string => {
    const start = markup.indexOf(decisionTag(markup))
    const tags = /<div\b|<\/div>/g
    tags.lastIndex = start
    let depth = 0
    for (let match = tags.exec(markup); match; match = tags.exec(markup)) {
      depth += match[0] === '</div>' ? -1 : 1
      if (depth === 0) return markup.slice(start, match.index + '</div>'.length)
    }
    throw new Error('the decision card\'s markup never closes')
  }
  const noOldMaterial = (where: string, markup: string) => {
    for (const old of OLD) expect({ where, old, found: markup.includes(old) }).toEqual({ where, old, found: false })
  }

  it('POSITIVE — two questions in the composer slot: the info anatomy and its hook, the header pills, Submit primary (off until an answer), Cancel ghost', () => {
    const card = cardOf(visible(markupOf('input-container', 'Ask User UI (two questions)')))
    const tag = decisionTag(card)
    for (const part of ['data-decision-tone="info"', 'data-tutorial="ask-user-banner"']) expect(tag).toContain(part)
    expect(tag).not.toContain('shadow-elev-2') // hosted: the slot draws the material and the ring
    expect(card).toContain('rounded-full bg-info-tint')
    for (const header of ['Format', 'Sections']) expect(card).toContain(`>${header}</span>`)
    const submit = buttonLabelled(card, EN['chat.askUser.submit']!)
    for (const part of ['data-variant="primary"', 'disabled=""']) expect(submit).toContain(part)
    expect(buttonLabelled(card, EN['chat.askUser.cancel']!)).toContain('data-variant="ghost"')
    expect((card.match(/aria-pressed="false"/g) ?? []).length).toBe(4)
    noOldMaterial('Ask User UI (two questions)', card)
  })

  it('POSITIVE — one question in the slot: raised answers in the grid the CDP harness reads, the free-text Send primary', () => {
    const card = cardOf(visible(markupOf('input-container', 'Ask User UI')))
    expect(decisionTag(card)).toContain('data-tutorial="ask-user-banner"')
    const grid = card.match(/<div class="mt-3 grid gap-2">((?:(?!<\/div>).)*)<\/div>/)?.[1] ?? ''
    expect((grid.match(/<button[^>]*data-variant="secondary"/g) ?? []).length).toBe(3)
    expect(card).toMatch(new RegExp(`<button[^>]*aria-label="${EN['chat.askUser.send']}"[^>]*data-variant="primary"|<button[^>]*data-variant="primary"[^>]*aria-label="${EN['chat.askUser.send']}"`))
    noOldMaterial('Ask User UI', card)
  })

  it('NEGATIVE (control) — a workflow with no phases still offers the ghost Deny; the planned one draws Once primary and Always secondary', () => {
    const empty = cardOf(visible(markupOf('input-container', 'Workflow Launch UI (no phases)')))
    expect(empty).toContain('declares no phases up front')
    expect(buttonLabelled(empty, EN['chat.workflowLaunch.deny']!)).toContain('data-variant="ghost"')
    const planned = cardOf(visible(markupOf('input-container', 'Workflow Launch UI')))
    expect(decisionTag(planned)).toContain('data-decision-tone="info"')
    expect(buttonLabelled(planned, EN['chat.workflowLaunch.approveOnce']!)).toContain('data-variant="primary"')
    expect(buttonLabelled(planned, EN['chat.workflowLaunch.approveAlways']!)).toContain('data-variant="secondary"')
    expect(buttonLabelled(planned, EN['chat.workflowLaunch.deny']!)).toContain('data-variant="ghost"')
    for (const variant of ['Workflow Launch UI', 'Workflow Launch UI (no phases)']) noOldMaterial(variant, cardOf(visible(markupOf('input-container', variant))))
  })

  it('the artifact-publish details sit in the anatomy\'s wells; the standalone ask_user dialog draws its own material in every scenario', () => {
    const publish = cardOf(visible(markupOf('input-container', 'Permission UI (artifact publish)')))
    expect(publish).toMatch(/<pre class="[^"]*bg-sunken[^"]*font-mono[^"]*" data-testid="artifact-publish-source">/)
    expect(publish).toMatch(/class="[^"]*bg-sunken[^"]*" data-testid="artifact-publish-markdown"/)
    noOldMaterial('Permission UI (artifact publish)', publish)
    const scenarios = verdicts.filter(v => v.id === 'orchestration-ask-user' && v.variant !== null)
    expect(scenarios.length).toBeGreaterThanOrEqual(9)
    for (const scenario of scenarios) {
      const markup = scenario.markup ?? ''
      const tag = decisionTag(markup)
      expect({ scenario: scenario.variant, standalone: tag.includes('shadow-elev-2') && tag.includes('data-tutorial="ask-user-banner"') })
        .toEqual({ scenario: scenario.variant, standalone: true })
      noOldMaterial(String(scenario.variant), cardOf(markup))
    }
    const punycode = scenarios.find(v => v.markup?.includes('xn--'))?.markup ?? ''
    expect(punycode).toContain('data-testid="url-consent"')
    expect(punycode).toContain('role="alert"')
    expect(punycode).toContain('bg-destructive-tint')
  })
})

/**
 * UB14.12 — v0.15.1's TurnCard shell, rendered for real (dark) in every state the row touches. `TurnCard.tsx`
 * cannot be loaded by a plain bun test (pdfjs through `Markdown`); this child stubs pdfjs, so it is the one
 * instrument that paints the merged card. `response-footer.test.tsx` renders the footer alone.
 */
describe('the TurnCard shell: plain answer, plan card, response footer (UB14.12)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (id: string, variant: string | null) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!
  }
  const turn = (variant: string | null) => markupOf('turn-card', variant)
  /** aria-labels of every `<button>` in the markup, in document order. */
  const buttonNames = (markup: string): string[] =>
    [...markup.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*>/g)].map(m => m[1] ?? '')
  const FOOTER = [EN['common.copy'], EN['turnCard.viewAsMarkdown'], EN['common.viewFullscreen'], EN['chat.branchOptions']]

  it('POSITIVE — the answer is plain copy in the 10px-gapped turn, with Copy / Markdown / Fullscreen / Branch as named buttons', () => {
    const markup = turn('Answer + Footer Actions')
    expect(markup).toContain('class="flex min-w-0 flex-col gap-2.5"')
    expect(markup).toContain('class="group/answer flex min-w-0 flex-col gap-2"')
    expect(markup).toMatch(/data-search-root="response"[^>]*class="text-copy text-foreground/)
    expect(buttonNames(markup)).toEqual(expect.arrayContaining(FOOTER))
    expect(markup).toContain('data-touch-reveal="true"')
    // v0.14.0's card is gone: no 540px inner scroll, no card material, no text buttons, no "Streaming..." strip
    for (const old of ['max-height:540px', 'bg-background shadow-minimal rounded-[8px]', '<span>Markdown</span>', 'Streaming...']) {
      expect({ old, found: markup.includes(old) }).toEqual({ old, found: false })
    }
  })

  it('POSITIVE — the plan is a raised card with the translated header and an always-visible footer holding the solid Accept', () => {
    const markup = turn('Plan Card (Accept)')
    expect(markup).toContain('class="group/answer overflow-hidden rounded-lg bg-raised shadow-elev-1"')
    expect(markup).toContain(`<span class="font-medium text-foreground">${EN['turnCard.plan']}</span>`)
    expect(markup).toContain('class="flex min-w-0 items-center gap-0.5 border-t border-subtle px-2 py-1.5"')
    expect(markup).toMatch(/<button[^>]*class="group\/accept[^"]*bg-accent-solid[^"]*"/)
    expect(markup).toContain(EN['plan.acceptPlan'])
    expect(buttonNames(markup)).toEqual(expect.arrayContaining(FOOTER))
    expect(markup).not.toContain('bg-success/5')
  })

  it('POSITIVE — a turn whose only subagent rows come from an earlier turn groups them (hasTaskSubagents on parentId)', () => {
    const markup = turn('Continued Subagent Only')
    expect(markup).toContain('continued from an earlier turn')
  })

  it('POSITIVE — P6.469 kept: Verbose opens the work log; Normal stays collapsed', () => {
    const verbose = markupOf('turn-card-transcript-verbosity', 'Verbose — every step, section open')
    const normal = markupOf('turn-card-transcript-verbosity', 'Normal — the default, unchanged')
    expect(verbose).toMatch(/<button type="button" aria-expanded="true"/)
    expect(normal).toMatch(/<button type="button" aria-expanded="false"/)
  })

  it('NEGATIVE (control) — Summary keeps the unfiltered step count; a streaming answer draws no footer; no onPopOut/messageId → no Markdown/Branch', () => {
    const lead = (markup: string) => markup.match(/<span class="font-medium text-foreground">(\d+ steps?)[^<]*<\/span>/)?.[1]
    const summary = markupOf('turn-card-transcript-verbosity', 'Summary — only the changes, and the count stays honest')
    const normal = markupOf('turn-card-transcript-verbosity', 'Normal — the default, unchanged')
    expect(lead(normal)).toMatch(/^\d+ steps?$/)
    expect(lead(summary)).toBe(lead(normal))

    const streaming = turn('Streaming Answer (No Footer)')
    expect(streaming).toContain('I am reading the authentication module')
    expect(buttonNames(streaming)).not.toContain(EN['common.copy'])
    expect(streaming).not.toContain('Streaming...')

    const plain = buttonNames(turn('Response Only'))
    expect(plain).toEqual(expect.arrayContaining([EN['common.copy'], EN['common.viewFullscreen']]))
    expect(plain).not.toContain(EN['turnCard.viewAsMarkdown'])
    expect(plain).not.toContain(EN['chat.branchOptions'])
  })

  it('NEGATIVE (control) — the compact plan keeps only the 40px Accept drawer: no footer actions', () => {
    const markup = turn('Plan Card (Compact Drawer)')
    expect(markup).toMatch(/<button[^>]*class="group\/accept[^"]*h-control-xl[^"]*"/)
    for (const name of FOOTER) expect(buttonNames(markup)).not.toContain(name)
  })
})

/**
 * UB14.26 — the transcript auth card on v0.15.1's decision material, rendered for real (dark) in every
 * `auth-request-card` state: a pending card is a STANDALONE info decision card (it draws its own raised material
 * and ring; the dp failure, which keeps Retry, is the danger one), a finished card is upstream's tinted
 * `AuthOutcome` with no action, and the two waits draw the restart beside our cancel (OAuth) and the copy-link
 * hint with the primary disabled (dp).
 */
describe('the transcript auth card on the decision material (UB14.26)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const STANDALONE = 'rounded-xl bg-raised shadow-elev-2'
  const markupOf = (variant: string) => {
    const verdict = verdicts.find(v => v.id === 'auth-request-card' && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!
  }
  /** The decision card's own opening tag (exactly one per pending state), or none. */
  const decisionTags = (markup: string): string[] => markup.match(/<div[^>]*data-decision-tone="[^"]*"[^>]*>/g) ?? []
  /** The opening tag of the button whose label is `label`. */
  const buttonTag = (markup: string, label: string): string => {
    const at = markup.indexOf(`${label}</button>`)
    expect({ label, found: at > -1 }).toEqual({ label, found: true })
    const start = markup.lastIndexOf('<button', at)
    return markup.slice(start, markup.indexOf('>', start) + 1)
  }
  const fill = (key: string, values: Record<string, string>) =>
    Object.entries(values).reduce((text, [name, value]) => text.replace(`{{${name}}}`, value), EN[key] ?? key)

  it('POSITIVE — every pending state is the standalone info decision card; the dp failure is the danger one', () => {
    for (const variant of ['Credential Pending', 'Basic Auth', 'OAuth Pending', 'Google OAuth', 'OAuth Waiting Browser', 'Developer Platform Pending', 'Developer Platform Waiting Browser']) {
      const tags = decisionTags(markupOf(variant))
      expect({ variant, count: tags.length }).toEqual({ variant, count: 1 })
      expect({ variant, info: tags[0]!.includes('data-decision-tone="info"'), standalone: tags[0]!.includes(STANDALONE) })
        .toEqual({ variant, info: true, standalone: true })
    }
    const failed = decisionTags(markupOf('Developer Platform Failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('data-decision-tone="danger"')
    expect(failed[0]).toContain('ring-[color:var(--destructive-border)]')
    expect(buttonTag(markupOf('Developer Platform Failed'), EN['chat.dpAuth.retry']!)).toContain('data-variant="primary"')

    const credential = markupOf('Credential Pending')
    expect(credential).toContain(fill('chat.authCard.titleCredential', { name: 'GitHub' }))
    const submits = (credential.match(/<button[^>]*>/g) ?? []).filter(tag => tag.includes('type="submit"'))
    expect(submits).toHaveLength(1) // Save is the card's one submit (UB1.15)
    expect(submits[0]).toContain('data-variant="primary"')
    expect(buttonTag(credential, EN['common.cancel']!)).toContain('type="button"')
    expect(credential).toContain(`aria-label="${EN['chat.credentials.showValue']}"`)
    expect(credential).toContain(EN['chat.authCard.encryptedAtRest'])
    expect(markupOf('Google OAuth')).toContain(fill('chat.authCard.signInWith', { provider: 'Google' }))
    expect(markupOf('Developer Platform Pending')).toContain(fill('chat.authCard.titleDp', { name: 'Developer Platform' }))
  })

  it('POSITIVE — the waits: the OAuth restart beside our cancel; the dp copy-link hint with the primary disabled', () => {
    const oauth = markupOf('OAuth Waiting Browser')
    expect(oauth).toContain(fill('chat.authCard.authenticating', { name: 'Linear' }))
    for (const label of [EN['chat.authCard.restartSignIn']!, EN['common.cancel']!]) {
      expect({ label, disabled: buttonTag(oauth, label).includes('disabled=""') }).toEqual({ label, disabled: false })
    }
    const dp = markupOf('Developer Platform Waiting Browser')
    expect(dp).toContain(EN['chat.dpAuth.waitingBrowser'])
    expect(dp).toContain('data-testid="gateway-auth-url-hint"')
    expect(dp).toContain('auth.example.invalid')
    expect(dp).not.toContain('state=playground') // the host only, never the query
    expect(buttonTag(dp, EN['chat.dpAuth.title']!)).toContain('disabled=""')
    expect(buttonTag(dp, EN['chat.dpAuth.cancel']!)).not.toContain('disabled=""')
  })

  it('NEGATIVE (control) — a finished request is a tinted outcome: no decision card, no button, none of the old card material', () => {
    const outcomes: Array<[string, string]> = [
      ['Completed', 'bg-success-tint'],
      ['Completed (workspace)', 'bg-success-tint'],
      ['Completed (compact)', 'bg-success-tint'],
      ['Cancelled', 'bg-fill-hover'],
      ['Failed', 'bg-destructive-tint'],
      ['Developer Platform Connected', 'bg-success-tint'],
    ]
    for (const [variant, tint] of outcomes) {
      const markup = markupOf(variant)
      expect({ variant, decision: decisionTags(markup).length, tint: markup.includes(tint), button: markup.includes('<button') })
        .toEqual({ variant, decision: 0, tint: true, button: false })
    }
    expect(markupOf('Completed (workspace)')).toContain(fill('chat.authCard.workspace', { workspace: 'Platform Team' }))
    expect(markupOf('Completed (compact)')).toContain('w-fit')
    for (const variant of [...outcomes.map(([name]) => name), 'Credential Pending', 'OAuth Pending', 'Developer Platform Failed']) {
      const markup = markupOf(variant)
      expect({ variant, old: markup.includes('--shadow-color') || markup.includes('border-t border-border/50') }).toEqual({ variant, old: false })
    }
  })
})

/**
 * UB14.29 — the mode control is v0.15.1's tinted pill: the toolbar chip on desktop (over OUR menu content) and the
 * drawer trigger in compact, both `data-mode` + `MODE_CHIP_TONE`, both disabled by the capability lock. Read from the
 * REAL dark markup of the mode entry and of the composer card's base state.
 */
describe('the mode chip and the drawer trigger (UB14.29)', () => {
  const markupOf = (id: string, variant: string | null) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!
  }
  const ENTRY = 'parity-permission-mode-selector'
  /** Opening tags of the desktop chip (`data-tutorial`) and of the compact trigger (the drawer's `aria-haspopup="dialog"`). */
  const chipTags = (markup: string) => markup.match(/<button[^>]*data-tutorial="permission-mode-dropdown"[^>]*>/g) ?? []
  const drawerTags = (markup: string) =>
    (markup.match(/<button[^>]*data-mode="[^"]*"[^>]*>/g) ?? []).filter(tag => !tag.includes('data-tutorial="permission-mode-dropdown"'))

  it('POSITIVE — Accept edits: both triggers carry data-mode and the success tint on the rounded 28px pill', () => {
    const markup = markupOf(ENTRY, 'acceptEdits')
    const chip = chipTags(markup)
    const drawer = drawerTags(markup)
    expect({ chips: chip.length, drawers: drawer.length }).toEqual({ chips: 1, drawers: 1 })
    for (const tag of [chip[0]!, drawer[0]!]) {
      expect({ mode: tag.includes('data-mode="acceptEdits"'), tone: tag.includes('bg-success-tint text-success'), pill: tag.includes('rounded-full') && tag.includes('h-control') })
        .toEqual({ mode: true, tone: true, pill: true })
    }
    expect(chip[0]).toContain('aria-haspopup="menu"')
    expect(markup).toContain('@container/panel')
    // The badge-row dropdown this entry used to show (and its shadow-tinted chip) is gone.
    expect(markup).not.toContain('--shadow-color')
  })

  it('POSITIVE — the composer card\'s toolbar carries the chip (no second mode control above the card)', () => {
    const tags = chipTags(markupOf('input-container', null))
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) {
      expect({ mode: tag.includes('data-mode="default"'), tone: tag.includes('bg-info-tint text-info'), old: tag.includes('rounded-[6px]') || tag.includes('rounded-[8px]') })
        .toEqual({ mode: true, tone: true, old: false })
    }
  })

  it('NEGATIVE (control) — locked: both triggers are disabled and keep their tone; unlocked ones are not disabled', () => {
    const locked = markupOf(ENTRY, 'Locked (Manual)')
    const tags = [...chipTags(locked), ...drawerTags(locked)]
    expect(tags).toHaveLength(2)
    for (const tag of tags) {
      expect({ disabled: tag.includes('disabled=""'), tone: tag.includes('bg-info-tint') }).toEqual({ disabled: true, tone: true })
    }
    const open = [...chipTags(markupOf(ENTRY, null)), ...drawerTags(markupOf(ENTRY, null))]
    expect(open).toHaveLength(2)
    expect(open.filter(tag => tag.includes('disabled=""'))).toEqual([])
  })

  it('boundary — dontAsk (not in the picker) is named by itself on the neutral fill; the narrow boxes and the open-menu state render', () => {
    const dontAsk = markupOf(ENTRY, 'dontAsk')
    expect(chipTags(dontAsk)[0]).toContain('data-mode="dontAsk"')
    expect(chipTags(dontAsk)[0]).toContain('bg-fill-hover text-secondary')
    const narrow = markupOf(ENTRY, 'Narrow panels (icon only)')
    expect(narrow).toContain('w-[440px]')
    expect(narrow).toContain('w-[340px]')
    expect(narrow).toContain('@max-[32rem]/panel:hidden')
    expect(narrow).toContain('sr-only @min-[24rem]/panel:not-sr-only')
    expect(chipTags(markupOf(ENTRY, 'Menu open on codex'))[0]).toContain('data-mode="plan"')
  })
})

/**
 * UB14.30 — the model control is v0.15.1's `ComposerModelMenu`: the composer chip (with our effort pill) over the menu
 * rows, our integration row badging each runtime, the disclosure lines on the caption role, and only the effort
 * levels the runtime honours; the compact trigger is the same chip with the Cpu fold. Read from the REAL dark markup
 * (both pickers are imported eagerly since this row, so the sweep renders them instead of a lazy fallback).
 */
describe('the model chip, its menu and the compact trigger (UB14.30)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (id: string, variant: string | null) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!
  }
  const DESKTOP = 'parity-desktop-model-picker'
  const COMPACT = 'parity-compact-model-selector'
  /** Opening tags of every menu trigger: the chip itself, then the effort sub-menu's trigger when it is drawn. */
  const menuTriggers = (markup: string) => markup.match(/<(?:button|div)[^>]*aria-haspopup="menu"[^>]*>/g) ?? []
  /** The menu body onward (the playground's own chrome precedes it). */
  const menuOf = (markup: string) => {
    const at = markup.indexOf('role="menu"')
    expect(at).toBeGreaterThan(-1)
    return markup.slice(at)
  }

  it('POSITIVE — the chip is the composer chip with the effort pill naming the level; the rows wear v0.15.1\'s menu vocabulary', () => {
    const markup = markupOf(DESKTOP, 'Several models')
    const chip = menuTriggers(markup)[0]!
    expect({ chip: chip.includes('h-control') && chip.includes('rounded-full') && chip.includes('shrink gap-1 pl-2.5 pr-2'), open: chip.includes('bg-fill-hover') })
      .toEqual({ chip: true, open: true })
    expect(markup).toContain(`<span data-effort-pill="true" class="shrink-0 rounded-xs bg-fill-hover px-1 text-caption text-secondary">${EN['thinking.medium']}</span>`)
    const menu = menuOf(markup)
    expect(menu).toContain('flex cursor-pointer items-center justify-between py-1.5')
    expect(menu).toContain('class="text-label font-medium"')
    expect(menu).toContain('px-2 pt-2 pb-1 text-label-sm font-medium text-tertiary select-none')
    expect(menu).toContain('class="max-w-[380px] whitespace-normal px-2 pt-2 text-caption font-normal text-tertiary"')
    for (const old of ['text-muted-foreground', 'text-[11px]', 'rounded-lg', 'uppercase tracking-wide', 'bg-foreground/5', 'text-foreground/60']) {
      expect({ old, found: menu.includes(old) }).toEqual({ old, found: false })
    }
  })

  it('POSITIVE — two runtimes with the integration list open: one target per connection, each badged with its runtime', () => {
    const markup = markupOf(DESKTOP, 'Two runtimes, integration open')
    expect(markup.match(/data-runtime-badge="[^"]+"/g)).toEqual([
      'data-runtime-badge="pi"', // the active integration's head
      'data-runtime-badge="pi"',
      'data-runtime-badge="codex-runtime"',
    ])
    expect(markup).toContain('bg-fill-selected')
    // Control: with one connection there is nowhere to go — one badge (the head), no list.
    expect(markupOf(DESKTOP, 'Several models').match(/data-runtime-badge="[^"]+"/g)).toEqual(['data-runtime-badge="pi"'])
  })

  it('NEGATIVE (control) — a runtime with no effort levels: no pill and no effort sub-menu; with levels, both are drawn', () => {
    const none = markupOf(DESKTOP, 'No effort levels — no pill, no sub-menu')
    expect({ pill: none.includes('data-effort-pill'), triggers: menuTriggers(none).length }).toEqual({ pill: false, triggers: 1 })
    const codex = markupOf(DESKTOP, 'Codex effort levels (off–high)')
    expect({ pill: codex.includes('data-effort-pill'), triggers: menuTriggers(codex).length }).toEqual({ pill: true, triggers: 2 })
  })

  it('the compact trigger is the composer chip with the Cpu fold, inside its own panel container; no tinted shadow', () => {
    for (const variant of [null, 'Narrow panel (Cpu glyph)', 'Open, several models', 'Connection unavailable'] as const) {
      const markup = markupOf(COMPACT, variant)
      const tag = (markup.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/g) ?? [])[0] ?? ''
      expect({ variant, chip: tag.includes('h-control') && tag.includes('rounded-full'), fold: tag.includes('@max-[26rem]/panel:px-2'), old: markup.includes('shadow-tinted') || markup.includes('--shadow-color') })
        .toEqual({ variant, chip: true, fold: true, old: false })
      expect(markup).toContain('@container/panel')
    }
    expect(markupOf(COMPACT, 'Narrow panel (Cpu glyph)')).toContain('w-[340px]')
    expect(markupOf(COMPACT, 'Connection unavailable')).toContain('bg-destructive-tint text-destructive')
  })
})

/**
 * UB15.1 — the settings primitives at v0.15.1, swept over every `settings-*` playground entry rendered for
 * real (dark): the rows the primitives draw (`data-layout="settings-row"`) take the ≥ 56px in-card geometry
 * (`settingsUI.row`) or the bare one (`settingsUI.rowBare`), `SettingsCard` is the raised card, and no row
 * description truncates. Hand-rolled markup INSIDE our sections (Provenance, Config Doctor, Safe Mode, the
 * permission sections) is not the primitives' and moves with its own rows (UB15.7, UB15.8, UB15.12).
 */
describe('the settings primitives, every settings-* entry (UB15.1)', () => {
  const settingsStates = () => verdicts.filter(verdict => verdict.id.startsWith('settings-'))
  const rowTags = (markup: string): string[] => markup.match(/<[a-z]+ [^>]*data-layout="settings-row"[^>]*>/g) ?? []
  const RAISED_CARD = 'rounded-lg bg-raised shadow-elev-1 overflow-hidden'

  it('POSITIVE CONTROL — the named list is every settings-* entry in the registry, each with its markup', () => {
    const ids = [...new Set(settingsStates().map(verdict => verdict.id))].sort()
    expect(ids).toEqual([...UB15_1_SETTINGS_ENTRIES].sort())
    expect(settingsStates().filter(verdict => !verdict.markup).map(label)).toEqual([])
  })

  it('POSITIVE — every primitive row takes the new geometry, and SettingsCard is the raised card', () => {
    const withRows = settingsStates().filter(verdict => rowTags(verdict.markup!).length > 0)
    // The sweep sees real rows and real cards (measured 2026-10-16: rows in 15 states over 5 entries, a card in 21 over 8).
    expect(withRows.length).toBeGreaterThan(10)
    const offGeometry = withRows.flatMap(verdict =>
      rowTags(verdict.markup!)
        .filter(tag => !tag.includes('min-h-14 gap-4 px-3.5 py-2.5') && !tag.includes('gap-4 py-3'))
        // UB15.4: the Shortcuts page's rows are v0.15.1's dense key rows — on that entry only.
        .filter(tag => !(verdict.id === UB15_4_SHORTCUTS_ENTRY && tag.includes(UB15_4_SHORTCUT_ROW)))
        .map(tag => `${label(verdict)}: ${tag}`))
    expect(offGeometry).toEqual([])
    expect(settingsStates().filter(verdict => verdict.markup!.includes(RAISED_CARD)).length).toBeGreaterThan(10)
  })

  it('NEGATIVE (control) — no primitive row keeps the old padding, no card the old material, no description truncates', () => {
    const oldRows = settingsStates().flatMap(verdict =>
      rowTags(verdict.markup!).filter(tag => tag.includes('px-4 py-3.5')).map(() => label(verdict)))
    expect(oldRows).toEqual([])
    expect(settingsStates().filter(verdict => verdict.markup!.includes('rounded-xl bg-background shadow-minimal')).map(label)).toEqual([])
    // The description material is `settingsUI.description`; a truncating one would carry `truncate` on it. The
    // control: the sweep reads real descriptions (34 on 2026-10-16), so the absence below is not an empty probe.
    const DESCRIPTION = /class="text-label-sm leading-4\.5 text-secondary[^"]*"/g
    expect(settingsStates().reduce((n, verdict) => n + (verdict.markup!.match(DESCRIPTION) ?? []).length, 0)).toBeGreaterThan(10)
    expect(settingsStates().filter(verdict => /class="text-label-sm leading-4\.5 text-secondary[^"]*\btruncate\b/.test(verdict.markup!)).map(label)).toEqual([])
  })
})

/**
 * UB15.3 — the Settings → Import panel (ours; upstream v0.15.1 has no import page), rendered for real (dark) in
 * every state of its entry: one `SettingsSection` (the page's `SettingsPage` owns the h2 title + lede), the kind
 * groups in raised `SettingsCard`s, the actions the shared `Button`, the chips and notices on solved role tints.
 */
describe('the Claude Code import panel on the settings material, every state (UB15.3)', () => {
  const states = () => verdicts.filter(verdict => verdict.id === UB15_3_IMPORT_ENTRY)
  const RAW_PALETTE = /\b(?:bg|text|border|ring|fill|stroke|outline|divide|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/

  it('POSITIVE — every state sits under the quiet section heading; the previews carry raised cards, role chips and the shared Button', () => {
    expect(states().map(label)).toEqual([
      'claude-import-panel · (base state)',
      'claude-import-panel · Idle (before scan)',
      'claude-import-panel · Scanning',
      'claude-import-panel · Dry-run preview (all kinds)',
      'claude-import-panel · Nothing to import',
      'claude-import-panel · Conflicts + warning',
      'claude-import-panel · Importing',
      'claude-import-panel · Done',
      'claude-import-panel · Done — something needs authentication',
      'claude-import-panel · Error',
    ])
    for (const verdict of states()) {
      expect(verdict.markup!, label(verdict)).toContain('<h3 class="text-label-sm font-semibold text-secondary">Import from Claude Code</h3>')
    }
    const markupOf = (variant: string | null) => states().find(verdict => verdict.variant === variant)!.markup!
    const ROLE_OF: Record<string, string> = { create: 'bg-success-tint text-success', merge: 'bg-accent-tint text-accent', conflict: 'bg-info-tint text-info' }
    for (const preview of [null, 'Dry-run preview (all kinds)', 'Conflicts + warning']) {
      const markup = markupOf(preview)
      expect(markup, String(preview)).toContain('rounded-lg bg-raised shadow-elev-1 overflow-hidden')
      // Every chip carries its own action's role tint.
      const chips = [...markup.matchAll(/data-action="(\w+)" class="([^"]*)"/g)]
      expect(chips.length, String(preview)).toBeGreaterThan(1)
      expect(chips.filter(([, action, cls]) => !cls!.endsWith(ROLE_OF[action!]!)).map(([chip]) => chip)).toEqual([])
      expect(markup, String(preview)).toMatch(/<button data-slot="button" data-variant="primary"/)
      expect(markup, String(preview)).toMatch(/<button data-slot="button" data-variant="secondary"/)
    }
    expect(markupOf('Conflicts + warning')).toMatch(/data-action="conflict" class="[^"]*bg-info-tint text-info"/)
    expect(markupOf('Dry-run preview (all kinds)')).toMatch(/data-action="create" class="[^"]*bg-success-tint text-success"/)
    expect(markupOf('Dry-run preview (all kinds)')).toMatch(/data-action="merge" class="[^"]*bg-accent-tint text-accent"/)
    expect(markupOf('Conflicts + warning')).toContain('data-notice="info"')
    expect(markupOf('Done')).toContain('data-notice="success"')
    expect(markupOf('Done — something needs authentication')).toMatch(/data-notice="info" data-testid="claude-import-needs-auth"/)
    expect(markupOf('Error')).toContain('data-notice="error"')
    expect(markupOf('Nothing to import')).toContain('data-notice="neutral"')
  })

  it('NEGATIVE (control) — no state draws a raw palette class, a foreground-opacity tint, a Loader2 spin or a hand-rolled button', () => {
    expect(states().length).toBe(10)
    expect(states().filter(verdict => RAW_PALETTE.test(verdict.markup!)).map(label)).toEqual([])
    expect(states().filter(verdict => /\b(?:text|bg|border)-foreground\/|text-muted-foreground|animate-spin/.test(verdict.markup!)).map(label)).toEqual([])
    expect(states().filter(verdict => verdict.markup!.includes('bg-foreground px-4 py-2') || verdict.markup!.includes('border border-border px-4 py-2')).map(label)).toEqual([])
  })
})

/**
 * UB15.2 — the settings navigator rows at v0.15.1 (`SettingsNavigator.tsx` taken 1:1, `nessy://` kept),
 * rendered for real (dark) in every state of its entry: icon · title / description on the EntityRow slots,
 * selection as `bg-fill-selected` on exactly the row the state names (none on the bare route), and the "⋯" a
 * named button whose wrapper stays invisible and unclickable until hover or focus-within.
 */
describe('the settings navigator rows, every state (UB15.2)', () => {
  const states = () => verdicts.filter(verdict => verdict.id === UB15_2_NAVIGATOR_ENTRY)
  const count = (markup: string, needle: string) => markup.split(needle).length - 1

  it('POSITIVE — every state draws one slotted row per page and selects exactly the row it names', () => {
    expect(states().map(label)).toEqual([
      'settings-navigator · (base state)',
      'settings-navigator · Middle row selected',
      'settings-navigator · First row selected',
      'settings-navigator · Last row selected',
      'settings-navigator · Nothing selected (compact route)',
      'settings-navigator · Short panel',
    ])
    for (const verdict of states()) {
      const markup = verdict.markup!
      const rows = count(markup, '<div class="settings-item"')
      // Our list: ten pages, eleven with the embedded server's page.
      expect(rows, label(verdict)).toBeGreaterThanOrEqual(10)
      expect(count(markup, 'data-slot="entity-row-title"'), label(verdict)).toBe(rows)
      expect(count(markup, 'data-slot="entity-row-subtitle"'), label(verdict)).toBe(rows)
      expect(count(markup, 'aria-label="More"'), label(verdict)).toBe(rows)
      expect(count(markup, 'opacity-0 pointer-events-none group-hover:opacity-100'), label(verdict)).toBe(rows)
      const selected = verdict.variant === 'Nothing selected (compact route)' ? 0 : 1
      expect(count(markup, '<div class="settings-item" data-selected="true">'), label(verdict)).toBe(selected)
      expect(count(markup, 'bg-fill-selected'), label(verdict)).toBe(selected)
    }
  })

  it('NEGATIVE (control) — no state keeps the old anatomy: no Separator rows, no pinned icon, no unnamed "⋯" div', () => {
    const old = states().filter(verdict =>
      verdict.markup!.includes('settings-separator')
      || verdict.markup!.includes('absolute left-[20px] top-[14px]')
      || verdict.markup!.includes('p-1.5 hover:bg-foreground/10')
      || verdict.markup!.includes('bg-foreground/5 hover:bg-foreground/7'))
    expect(old.map(label)).toEqual([])
  })
})

/**
 * UB15.4 — the Shortcuts page at v0.15.1 (`pages/settings/ShortcutsPage.tsx` merged), rendered for real (dark) in
 * every state of its entry: the `SettingsPage` column (title h2 + the description lede), our search row first,
 * every key a shared `Kbd` inside a `KbdGroup`, every row v0.15.1's dense key row, the rebind control the shared
 * `Button`. The compact state is the same page in a panel under the 768px breakpoint.
 */
describe('the Shortcuts page on the settings column and shared keycaps, every state (UB15.4)', () => {
  const states = () => verdicts.filter(verdict => verdict.id === UB15_4_SHORTCUTS_ENTRY)
  const count = (markup: string, needle: string | RegExp) =>
    typeof needle === 'string' ? markup.split(needle).length - 1 : (markup.match(needle) ?? []).length
  /** The page's own markup, keycaps only: a group of shared chips and nothing else. */
  const KBD_GROUP = /<kbd data-slot="kbd-group"[^>]*>((?:<kbd data-slot="kbd"[^>]*>[^<]+<\/kbd>)+)<\/kbd>/g
  /** The material the page's own keycap and controls carried until UB15.4 (spelled as that source spelled it). */
  const OLD_MATERIAL = /bg-muted border border-border rounded|text-\[11px\]|text-muted-foreground|px-1\.5 py-0\.5 rounded hover:bg-muted/

  it('POSITIVE — every state is the column with its lede, the search row first, and every key a Kbd in a KbdGroup', () => {
    expect(states().map(label)).toEqual([
      'settings-shortcuts · (base state)',
      'settings-shortcuts · Full panel',
      'settings-shortcuts · Compact panel',
    ])
    for (const verdict of states()) {
      const markup = verdict.markup!
      expect(markup, label(verdict)).toContain('<h2 class="text-title text-foreground">Shortcuts</h2>')
      expect(markup, label(verdict)).toContain('>Keyboard shortcuts</p>')
      const search = markup.indexOf('data-shortcuts-search')
      expect(search, label(verdict)).toBeGreaterThan(markup.indexOf('Shortcuts</h2>'))
      expect(search, label(verdict)).toBeLessThan(markup.indexOf('<section'))
      // One group per action row (its rebind control) plus the nine fixed component rows; no chip outside a group.
      const rebind = count(markup, /<button data-slot="button" data-variant="ghost"[^>]*aria-label="Change the shortcut for /g)
      expect(rebind, label(verdict)).toBeGreaterThan(25)
      const groups = [...markup.matchAll(KBD_GROUP)]
      expect(groups.length, label(verdict)).toBe(rebind + 9)
      const chips = groups.reduce((n, group) => n + count(group[1]!, 'data-slot="kbd"'), 0)
      expect(count(markup, 'data-slot="kbd"'), label(verdict)).toBe(chips)
      // Every row is the dense key row.
      expect(count(markup, UB15_4_SHORTCUT_ROW), label(verdict)).toBe(rebind + 9)
    }
    const compact = states().find(verdict => verdict.variant === 'Compact panel')!.markup!
    expect(compact).toContain('@container/panel')
    expect(compact).toContain('width:420px')
  })

  it('NEGATIVE (control) — no state keeps the page\'s old keycap, its 11px muted text or its hand-rolled buttons', () => {
    expect(states().length).toBe(3)
    expect(states().filter(verdict => OLD_MATERIAL.test(verdict.markup!)).map(label)).toEqual([])
    // Control: the needle fires on the shapes the page drew until UB15.4.
    expect(OLD_MATERIAL.test('<kbd class="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-medium font-sans bg-muted border border-border rounded">')).toBe(true)
    expect(OLD_MATERIAL.test('<button class="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-muted">')).toBe(true)
  })
})

/**
 * UB14.35 — the label chips, the value editor, the `#` menu, the status menu and EditButton at v0.15.1, rendered for
 * real (dark: the child's ThemeContext stub resolves every label colour's dark value) in every state of their
 * entries. The chip's keyboard and controlled-open arms are `components/ui/__tests__/label-chip-entry.test.ts`'s;
 * `statusDisplayLabel` in ru is `components/ui/__tests__/session-status-menu.test.tsx`'s.
 */
describe('label chips, the value editor, the # menu, the status menu and EditButton (UB14.35)', () => {
  const statesOf = (id: string) => verdicts.filter(verdict => verdict.id === id)
  const one = (id: string, variant: string | null) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!
  }
  const chipTags = (markup: string) => markup.match(/<div role="button" tabindex="0"[^>]*>/g) ?? []
  const TINT = /background-color:color-mix\(in srgb, #[0-9A-F]{6} 18%, transparent\)/

  it('every state of the five entries is swept (base state and each variant)', () => {
    expect(statesOf('entity-list-label-badge').map(label)).toEqual([
      'entity-list-label-badge · (base state)', 'entity-list-label-badge · Uncoloured', 'entity-list-label-badge · Duplicate ids',
    ])
    expect(statesOf('label-value-editor').length).toBe(6)
    expect(statesOf('inline-label-menu').length).toBe(3)
    expect(statesOf('session-status-menu').length).toBe(4)
    expect(statesOf('edit-button').length).toBe(1)
  })

  it('POSITIVE — coloured chips: the 18% tint behind foreground text; duplicate ids stay one chip per valued entry', () => {
    const chips = chipTags(one('entity-list-label-badge', null))
    expect(chips.length).toBe(6)
    for (const chip of chips) expect(chip).toContain('h-5 @max-mobile/shell:h-6 max-w-[140px] px-1.5 rounded-xs text-label-sm')
    // Five labels carry a colour; Research has none, so the same row shows the neutral chip beside them.
    const tinted = chips.filter(chip => TINT.test(chip))
    expect(tinted.length).toBe(5)
    for (const chip of tinted) expect(chip).toContain(' text-foreground"')
    expect(chips.filter(chip => !TINT.test(chip)).map(chip => chip.match(/title="([^"]*)"/)![1])).toEqual(['Research'])
    // customer::Acme, Bug (bug + legacy bug::bug collapse), customer::Globex, Priority.
    expect(chipTags(one('entity-list-label-badge', 'Duplicate ids')).map(tag => tag.match(/title="([^"]*)"/)![1])).toEqual([
      'Customer · Acme', 'Bug', 'Customer · Globex', 'Priority · 3',
    ])
  })

  it('NEGATIVE (control) — uncoloured chips carry no inline style: the neutral fill and the secondary role, no v0.14 chip', () => {
    const chips = chipTags(one('entity-list-label-badge', 'Uncoloured'))
    expect(chips.length).toBe(6)
    for (const chip of chips) {
      expect(chip).not.toContain('style=')
      expect(chip).toContain('bg-fill-hover text-secondary')
    }
    const all = statesOf('entity-list-label-badge').map(verdict => verdict.markup!).join('\n')
    for (const old of ['h-[18px]', 'max-w-[120px]', ' 6%, transparent)', 'opacity:0.4']) expect(all).not.toContain(old)
  })

  it('POSITIVE — the open value editor names its label in a header, on the sunken field, Remove on the destructive tint', () => {
    for (const verdict of statesOf('label-value-editor')) {
      const markup = verdict.markup!
      expect(markup, label(verdict)).toContain('data-slot="popover-content"')
      expect(markup, label(verdict)).toContain('<div class="flex min-w-0 items-center gap-2 px-3.5 pt-2.5 pb-1">')
      expect(markup, label(verdict)).toContain('hover:bg-destructive-tint focus:bg-destructive-tint')
    }
    expect(one('label-value-editor', null)).toContain('field-surface w-full h-7 rounded-md px-2 text-label')
    expect(one('label-value-editor', 'Date')).toContain('field-surface flex-1 h-7 rounded-md px-2 text-label')
    expect(one('label-value-editor', 'Link')).toContain('hover:bg-fill-hover focus:bg-fill-hover')
    expect(one('label-value-editor', null)).toContain('data-side="top"')
    expect(one('label-value-editor', 'Opens downward')).toContain('data-side="bottom"')
  })

  it('NEGATIVE (control) — a plain label\'s editor has no field (presence-only: header and Remove)', () => {
    const plain = one('label-value-editor', 'Plain label')
    expect(plain).not.toContain('<input')
    expect(plain).not.toContain('field-surface')
    expect(one('label-value-editor', 'Number')).toContain('<input type="number"')
  })

  it('POSITIVE — the # menu sits on the caret-menu material: floating surface, 30px rows, tertiary section labels', () => {
    const menu = one('inline-label-menu', null)
    expect(menu).toContain('popover-styled overflow-hidden text-foreground origin-bottom-left')
    expect(menu).toContain('px-2 pt-2 pb-1 text-label-sm font-medium text-tertiary select-none')
    expect(menu).toContain('bg-separator mx-1 my-1 h-px')
    expect(menu).toContain('flex min-h-row-menu cursor-pointer select-none items-center')
    expect(menu).toContain('bg-fill-selected')
    expect(one('inline-label-menu', 'No match: add new label')).toContain('<div class="shrink-0 text-secondary">')
  })

  it('NEGATIVE (control) — the applied plain label (Bug) is not offered; without states there are no section labels', () => {
    for (const verdict of statesOf('inline-label-menu')) expect(verdict.markup!, label(verdict)).not.toContain('>Bug<')
    expect(one('inline-label-menu', null)).toContain('>Research<')
    expect(one('inline-label-menu', 'Labels only')).not.toContain('text-label-sm font-medium text-tertiary select-none')
    const all = statesOf('inline-label-menu').map(verdict => verdict.markup!).join('\n')
    for (const old of ['shadow-modal-small', 'bg-foreground/5', 'text-muted-foreground/60']) expect(all).not.toContain(old)
  })

  it('POSITIVE — the status menu is named, on the floating material; the active row (or Clear) takes the selected fill', () => {
    for (const verdict of statesOf('session-status-menu')) {
      const markup = verdict.markup!
      expect(markup, label(verdict)).toContain('class="popover-styled min-w-[180px] overflow-hidden" cmdk-root=""')
      expect(markup, label(verdict)).toMatch(/<label cmdk-label=""[^>]*>Filter statuses\.\.\.<\/label>/)
      expect(markup.split('bg-fill-selected').length - 1, label(verdict)).toBe(1)
      expect(markup.split('bg-separator -mx-1 my-1 h-px').length - 1, label(verdict)).toBe(2)
    }
    expect(one('session-status-menu', 'No status')).toMatch(/bg-fill-selected"[^>]*>(<span[^>]*>.*?<\/span>)<div class="flex-1 min-w-0">Clear<\/div>/)
    expect(one('session-status-menu', 'Custom status active')).toMatch(/bg-fill-selected"[^>]*>(<span[^>]*>.*?<\/span>)<div class="flex-1 min-w-0">Blocked on review<\/div>/)
    expect(one('session-status-menu', 'Archived')).toContain('>Unarchive<')
  })

  it('NEGATIVE (control) — no state keeps the v0.14 status-menu material', () => {
    const all = statesOf('session-status-menu').map(verdict => verdict.markup!).join('\n')
    for (const old of ['bg-foreground/7', 'bg-foreground/3', 'shadow-modal-small', 'border-t border-border/50', 'opacity-60']) {
      expect({ old, present: all.includes(old) }).toEqual({ old, present: false })
    }
  })

  it('POSITIVE — EditButton is a quiet ghost text action whose padding bleeds past the column edge', () => {
    const button = one('edit-button', null).match(/<button data-slot="popover-trigger"[^>]*>Edit<\/button>/)?.[0] ?? ''
    expect(button).toContain('data-variant="ghost"')
    expect(button).toContain('-mr-2 text-secondary hover:text-foreground')
  })

  it('NEGATIVE (control) — it is no longer a second box (no fill, shadow or fixed radius of its own)', () => {
    const button = one('edit-button', null).match(/<button data-slot="popover-trigger"[^>]*>Edit<\/button>/)?.[0] ?? ''
    expect(button).not.toBe('')
    for (const old of ['bg-background', 'shadow-minimal', 'rounded-[6px]', 'text-foreground/70']) expect(button).not.toContain(old)
  })
})

/**
 * UB14.31 — v0.15.1's sources chip, the folder chip and our branch chip in the composer toolbar, rendered for real
 * (dark): the `composer-toolbar-chips` entry for the chip states, and the composer's own base and compact states for
 * the placement. The fixtures' mention ids differ from their logical names, so the compact count can only come out
 * right through the one identity (`sourceSelectionId`).
 */
describe('the sources, folder and branch chips in the composer toolbar (UB14.31)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const ENTRY = 'composer-toolbar-chips'
  const markupOf = (id: string, variant: string | null) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!
  }
  /** Opening tags of the buttons whose accessible name is `name`. */
  const named = (markup: string, name: string) => (markup.match(/<button[^>]*>/g) ?? []).filter(tag => tag.includes(`aria-label="${name}"`))
  const count = (n: number) => EN['chat.sourcesCount']!.replace('{{count}}', String(n))
  const STACK_TILE = 'rounded-xs bg-raised shadow-elev-0'

  it('POSITIVE — desktop names two sources "A, B" on their stacked tiles; three are a count; compact counts from two', () => {
    const two = markupOf(ENTRY, 'Sources — two')
    expect(named(two, 'GitHub API, Linear')).toHaveLength(1)
    expect(named(two, 'GitHub API, Linear')[0]).toContain('data-tutorial="source-selector-button"')
    expect(two.split(STACK_TILE).length - 1).toBe(2)
    expect(named(markupOf(ENTRY, 'Sources — all three'), count(3))).toHaveLength(1)
    expect(named(markupOf(ENTRY, 'Sources — one'), 'GitHub API')).toHaveLength(1)
    expect(named(markupOf(ENTRY, 'Compact — two'), count(2))).toHaveLength(1)
  })

  it('NEGATIVE (control) — a stale slug is the empty affordance on both layouts: no "0 sources", no empty tile stack', () => {
    const desktop = markupOf(ENTRY, 'Sources — stale slug')
    const compact = markupOf(ENTRY, 'Compact — stale slug')
    expect(named(desktop, EN['chat.chooseSources']!)).toHaveLength(1)
    expect(named(compact, EN['chat.sourcesTooltip']!)).toHaveLength(1)
    for (const markup of [desktop, compact]) {
      expect({ zero: markup.includes(count(0)), tiles: markup.includes(STACK_TILE), icon: markup.includes('lucide-database-zap') })
        .toEqual({ zero: false, tiles: false, icon: true })
    }
  })

  it('POSITIVE — the branch chip is a composer chip naming the branch, foldable; NEGATIVE — outside a repo it is disabled and named "Branch"', () => {
    const onBranch = named(markupOf(ENTRY, null), 'feat/TCODE-000-composer')
    expect(onBranch).toHaveLength(1)
    for (const part of ['input-toolbar-btn', 'h-control', 'rounded-full', 'aria-haspopup="menu"']) expect(onBranch[0]).toContain(part)
    expect(onBranch[0]).not.toContain('disabled=""')
    for (const variant of ['Branch — not a repo', 'Branch — no working directory', 'Branch — git error']) {
      const tags = named(markupOf(ENTRY, variant), EN['chat.branch.label']!)
      expect({ variant, tags: tags.length, disabled: tags[0]?.includes('disabled=""'), chip: tags[0]?.includes('input-toolbar-btn') })
        .toEqual({ variant, tags: 1, disabled: true, chip: true })
    }
    // Compact mounts no branch chip (as in the composer).
    expect(named(markupOf(ENTRY, 'Compact — two'), 'feat/TCODE-000-composer')).toEqual([])
  })

  it('POSITIVE — in the composer the folder chip sits in the card\'s toolbar after the sources chip, before Send; no footer row under the card', () => {
    const base = markupOf('input-container', null)
    const sourcesAt = base.indexOf('aria-label="GitHub API, Linear"')
    const folderAt = base.indexOf('aria-label="nessy-general-agent"')
    const sendAt = base.indexOf('data-tutorial="send-button"')
    expect({ sources: sourcesAt > -1, folderAfterSources: folderAt > sourcesAt, sendAfterFolder: sendAt > folderAt })
      .toEqual({ sources: true, folderAfterSources: true, sendAfterFolder: true })
    // The pre-UB14.31 footer row (folder + branch under the card) is gone.
    expect(base).not.toContain('flex min-w-0 flex-wrap items-center gap-1 px-2 pt-1.5')
    // The compact composer counts its two sources (the old compact chip keyed on the logical name and drew "Sources").
    expect(named(markupOf('input-container', 'Safe + Compact'), count(2))).toHaveLength(1)
  })
})

/**
 * UB15.5 — Settings → App's Tools card twin (`settings-browser-download`), rendered for real (dark) in every state:
 * the page's free-form note lines moved onto v0.15.1's in-card padding + prose (`CARD_NOTE_CLASS`), a refusal keeps
 * `text-destructive` on its own line, and the Browse button is the shared secondary md (the raised neutral).
 */
describe('the App page download card on the card-note material, every state (UB15.5)', () => {
  const ENTRY = 'settings-browser-download'
  const states = () => verdicts.filter(verdict => verdict.id === ENTRY)
  /** `cn(settingsUI.cardPadding, settingsUI.prose)` as it renders. */
  const NOTE = '<div class="px-3.5 py-3 space-y-1.5 text-label leading-5 text-secondary">'
  const LEGACY_NOTE = 'px-4 py-3.5 text-sm text-muted-foreground'
  const markupOf = (variant: string | null) => states().find(verdict => verdict.variant === variant)?.markup ?? ''

  it('POSITIVE — every state the environment or a refusal reaches renders its note on the card-note material', () => {
    expect(states().length).toBe(7)
    for (const variant of [
      'Root taken by the environment',
      'Both taken by the environment',
      'Stored root refused (relative)',
      'Environment root refused (relative)',
    ]) {
      expect({ variant, note: markupOf(variant).includes(NOTE) }).toEqual({ variant, note: true })
    }
    // A refusal is its own destructive line inside the note.
    const refused = markupOf('Stored root refused (relative)')
    expect(refused.slice(refused.indexOf(NOTE))).toContain('<div class="text-destructive">config.json browserDownload.root=')
    // The Browse button is the shared secondary (raised neutral) at md, never the deprecated outline alias.
    for (const verdict of states()) {
      expect({ state: label(verdict), browse: /data-variant="secondary"[^>]*h-control px-2\.5/.test(verdict.markup!) })
        .toEqual({ state: label(verdict), browse: true })
      expect(verdict.markup!).not.toContain('data-variant="outline"')
    }
  })

  it('NEGATIVE (control) — no state keeps the hand-spelled note block, and a state with nothing to say has no note', () => {
    expect(states().filter(verdict => verdict.markup!.includes(LEGACY_NOTE)).map(label)).toEqual([])
    for (const variant of [null, 'Unset (the shipped default)', 'Set in config.json']) {
      expect({ variant, note: markupOf(variant).includes(NOTE) }).toEqual({ variant, note: false })
    }
    // Control: the probe reads real markup (the card itself renders in every state).
    expect(states().every(verdict => verdict.markup!.includes('rounded-lg bg-raised shadow-elev-1 overflow-hidden'))).toBe(true)
  })
})

/**
 * UB15.7 — the Permissions page's own sections (ours) on the v0.15.1 settings material, rendered for real (dark) in
 * every state of the seven entries that preview them (all in UB15.1's settings-* list, so the child already returns
 * their markup): the raised `SettingsCard`, the in-card padding, list rows split by the separator hairline, and the
 * role inks instead of the muted shadcn ink and the hand-padded card the sections and their twins drew until UB15.7.
 */
describe('the Permissions page sections on the settings material, every state (UB15.7)', () => {
  const ENTRIES = [
    'settings-blocked-tools-unenforceable', 'settings-browser-origin-trust', 'settings-isolation-network-posture',
    'settings-judge-denials', 'settings-judge-rules', 'settings-permissions-cross-scope', 'settings-sandbox-switches',
  ] as const
  const states = () => verdicts.filter(verdict => (ENTRIES as readonly string[]).includes(verdict.id))
  const markupOf = (id: string, variant: string | null) =>
    states().find(verdict => verdict.id === id && verdict.variant === variant)?.markup ?? ''
  const RAISED_CARD = 'rounded-lg bg-raised shadow-elev-1 overflow-hidden'
  /** `cn(settingsUI.cardPadding, settingsUI.descriptionSmall)` — the scope notes' fine print. */
  const FINE_PRINT = 'px-3.5 py-3 text-label-sm text-tertiary'
  /** The material the sections and their twins drew until UB15.7 (spelled as those sources spelled it). */
  const LEGACY = ['text-muted-foreground', 'px-4 py-3.5', 'rounded-lg border border-border bg-background', 'border-dashed'] as const

  it('POSITIVE — every state sits in the raised card, the isolation groups and denials rows on the hairline list', () => {
    // 30 states over the seven entries (measured 2026-10-16): every one but the judge rules' first paint (below)
    // draws the raised card.
    expect(states().length).toBe(30)
    expect(states().filter(verdict => verdict.id !== 'settings-judge-rules' && !verdict.markup!.includes(RAISED_CARD)).map(label))
      .toEqual([])
    // Isolation: one padded group per profile, then the posture group, on the dl's separator hairline.
    const open = markupOf('settings-isolation-network-posture', 'Open + unenforceable deniedDomains')
    expect(open).toContain('<dl class="divide-y divide-separator"><div class="px-3.5 py-3 space-y-1">')
    expect(open).toContain('<dt class="font-mono text-mono-ui text-foreground">outbound network</dt>')
    expect(open).toContain('<li class="text-label-sm text-tertiary [overflow-wrap:anywhere]">sandbox.network.deniedDomains')
    // The switches: two settings rows, then the scope notice as its own fine-print block.
    const switches = markupOf('settings-sandbox-switches', 'Pinned on by policy')
    expect((switches.match(/data-layout="settings-row" class="flex items-center justify-between min-h-14 gap-4 px-3\.5 py-2\.5/g) ?? []).length).toBe(2)
    expect(switches).toContain(`<p class="${FINE_PRINT}">`)
    // Denials: rows on the hairline list with the tool in mono; a state sentence in the card padding.
    const listed = markupOf('settings-judge-denials', 'Three refusals')
    expect((listed.match(/<li class="px-3\.5 py-2\.5">/g) ?? []).length).toBe(3)
    expect(listed).toContain('<ul class="divide-y divide-separator" data-testid="auto-mode-denials">')
    expect(markupOf('settings-judge-denials', 'No chat open')).toContain('<p class="px-3.5 py-3 text-label-sm leading-4.5 text-secondary">')
    // Browser sites (the static first paint is the empty store): in-card prose, then the session footer.
    const trust = markupOf('settings-browser-origin-trust', null)
    expect(trust).toContain('<p class="px-3.5 py-3 space-y-1.5 text-label leading-5 text-secondary">')
    expect(trust).toContain(`<p class="${FINE_PRINT} [overflow-wrap:anywhere]">`)
    // The tables' twins wear the page's padless card.
    expect(markupOf('settings-permissions-cross-scope', null).split(`${RAISED_CARD} p-0`).length - 1).toBe(2)
    expect(markupOf('settings-blocked-tools-unenforceable', 'warn').split(RAISED_CARD).length - 1).toBe(2)
  })

  it('NEGATIVE (control) — no state keeps the muted ink, the hand-padded card or the dashed frame; judge rules draws no empty card', () => {
    expect(states().flatMap(verdict => LEGACY.filter(needle => verdict.markup!.includes(needle)).map(needle => `${label(verdict)}: ${needle}`)))
      .toEqual([])
    // Before the read answers the rules section shows its heading and no card (an empty card would read as no rules).
    const rules = markupOf('settings-judge-rules', null)
    expect(rules).toContain('<h3 class="text-label-sm font-semibold text-secondary">')
    expect(rules).not.toContain(RAISED_CARD)
    // Control: the probe reads real markup, and each needle fires on the shape its source drew until UB15.7.
    expect(states().every(verdict => (verdict.markup ?? '').length > 200)).toBe(true)
    const planted = '<div class="rounded-lg border border-border bg-background px-4 py-3.5"><p class="text-xs text-muted-foreground"></p></div><div class="w-[560px] rounded border border-dashed border-border/60 p-3">'
    expect(LEGACY.filter(needle => planted.includes(needle))).toEqual([...LEGACY])
  })
})

/**
 * UB15.8 — Settings → App's three Nessy sections (ours; upstream v0.15.1 has none of them) on the v0.15.1 settings
 * material, rendered for real (dark) in every state of the three entries that preview them (all in UB15.1's settings-*
 * list, so the child already returns their markup). Each entry renders the section's view with the answer passed in,
 * so every state the read can reach is a variant here, the first paint included: the raised card, one padded block per
 * group split by the card's hairline, the code well, the fine-print closing note, and Safe Mode's secondary md restart.
 */
describe('the App page Provenance, Config Doctor and Safe Mode sections on the settings material, every state (UB15.8)', () => {
  const ENTRIES = ['settings-config-doctor', 'settings-provenance', 'settings-safe-mode'] as const
  const states = () => verdicts.filter(verdict => (ENTRIES as readonly string[]).includes(verdict.id))
  const markupOf = (id: string, variant: string | null) =>
    states().find(verdict => verdict.id === id && verdict.variant === variant)?.markup ?? ''
  const count = (markup: string, needle: string) => markup.split(needle).length - 1
  const RAISED_CARD = 'rounded-lg bg-raised shadow-elev-1 overflow-hidden'
  /** `cn(settingsUI.cardPadding, 'space-y-1')` — one group of the provenance card. */
  const BLOCK = '<div class="px-3.5 py-3 space-y-1"'
  const HAIRLINE = 'class="h-px bg-separator"'
  /** `cn(settingsUI.cardPadding, settingsUI.descriptionSmall)` — the doctor's closing note. */
  const FINE_PRINT = '<p class="px-3.5 py-3 text-label-sm text-tertiary">'
  /** `cn(settingsUI.cardPadding, settingsUI.description)` — Safe Mode's policy note. */
  const NOTE = '<p class="px-3.5 py-3 text-label-sm leading-4.5 text-secondary">'
  const WELL = '<pre class="max-h-96 overflow-auto rounded-md bg-sunken px-2.5 py-2 font-mono text-mono-ui whitespace-pre text-secondary select-text">'
  /** The material the three sections drew until UB15.8 (spelled as those sources spelled it). */
  const LEGACY = ['text-muted-foreground', 'px-4 py-3.5', 'border-t border-border/50', 'bg-muted/50'] as const

  it('POSITIVE — every state sits in the raised card, each group in its own padded block on the hairline', () => {
    // 18 states (measured 2026-10-16): provenance base + 8 variants, the doctor base + 5, Safe Mode base + 2.
    expect(states().length).toBe(18)
    expect(states().filter(verdict => !verdict.markup!.includes(RAISED_CARD)).map(label)).toEqual([])
    // Provenance, project open: the intro, four families and Claude Code's stack — six blocks, five hairlines.
    const project = markupOf('settings-provenance', 'project')
    expect({ blocks: count(project, BLOCK), hairlines: count(project, HAIRLINE) }).toEqual({ blocks: 6, hairlines: 5 })
    expect(project).toContain('<div class="text-label font-medium text-foreground">')
    expect(project).toContain('<span class="font-mono text-mono-ui [overflow-wrap:anywhere] text-foreground">/Users/dev/work/api-gateway/.nessy-agent/permissions.json</span>')
    // The connection pane: the gateway line is the loud one, a BYO endpoint is not, and values are mono.
    expect(markupOf('settings-provenance', 'gateway')).toContain('<p class="pt-0.5 text-label-sm font-medium text-foreground" data-testid="connection-gateway">Verified Nessy gateway')
    const byo = markupOf('settings-provenance', 'byo')
    expect(byo).toContain('<p class="pt-0.5 text-label-sm text-secondary" data-testid="connection-byo">Bring-your-own endpoint')
    expect(byo).toContain('http://proxy.example.internal:3128')
    expect(markupOf('settings-provenance', 'no-connection')).toContain('<div class="px-3.5 py-3 space-y-1" data-testid="settings-connection-pane">')
    expect(markupOf('settings-provenance', 'codex')).toContain('<div class="px-3.5 py-3 space-y-1" data-testid="provenance-codex">')
    // Config Doctor: the report in the code well, the clean sentence as a row description, the note as fine print.
    expect(markupOf('settings-config-doctor', 'findings')).toContain(`${WELL}Managed settings`)
    expect(markupOf('settings-config-doctor', 'clean')).toContain('<p class="text-label-sm leading-4.5 text-secondary">Nothing here needs attention')
    expect(markupOf('settings-config-doctor', 'no-workspace')).toContain(`${FINE_PRINT}No workspace is open in this window`)
    expect(markupOf('settings-config-doctor', 'findings')).toContain(`${FINE_PRINT}The project instruction files are measured in the workspace this window has open: api-gateway.`)
    // Safe Mode: one settings row with the shared secondary md restart, then the policy note; each posture its own.
    for (const [variant, text] of [['normal', 'Restart in safe mode'], ['in-safe-mode', 'Restart normally']] as const) {
      const markup = markupOf('settings-safe-mode', variant)
      expect({ variant, rows: count(markup, 'data-layout="settings-row" class="w-full flex items-center justify-between text-left min-h-14 gap-4 px-3.5 py-2.5"') })
        .toEqual({ variant, rows: 1 })
      expect({ variant, restart: new RegExp(`data-variant="secondary"[^>]*h-control px-2\\.5[^>]*>${text}</button>`).test(markup) })
        .toEqual({ variant, restart: true })
      expect({ variant, note: markup.includes(`${NOTE}Your organization`) }).toEqual({ variant, note: true })
    }
  })

  it('NEGATIVE (control) — no state keeps the legacy material; a first paint draws no group it has no answer for', () => {
    expect(states().flatMap(verdict => LEGACY.filter(needle => verdict.markup!.includes(needle)).map(needle => `${label(verdict)}: ${needle}`)))
      .toEqual([])
    // Before the read answers: provenance draws the intro block alone, the doctor its closing note alone (no well).
    const provenance = markupOf('settings-provenance', 'loading')
    expect({ blocks: count(provenance, BLOCK), hairlines: count(provenance, HAIRLINE) }).toEqual({ blocks: 1, hairlines: 0 })
    const doctor = markupOf('settings-config-doctor', 'loading')
    expect({ well: doctor.includes('<pre'), hairlines: count(doctor, HAIRLINE), note: doctor.includes(FINE_PRINT) })
      .toEqual({ well: false, hairlines: 0, note: true })
    // The unavailable answers carry no report and no family.
    expect(markupOf('settings-config-doctor', 'unavailable')).not.toContain('<pre')
    expect(count(markupOf('settings-provenance', 'unavailable'), BLOCK)).toBe(1)
    // The safe-mode restart is never the solid accent it drew until UB15.8.
    expect(states().filter(verdict => verdict.id === 'settings-safe-mode' && verdict.markup!.includes('data-variant="primary"')).map(label))
      .toEqual([])
    // Control: the probe reads real markup, and each needle fires on the shape its source drew until UB15.8.
    expect(states().every(verdict => (verdict.markup ?? '').length > 200)).toBe(true)
    const planted = '<div class="space-y-1 border-t border-border/50 pt-3"><div class="px-4 py-3.5 text-xs text-muted-foreground"></div><pre class="max-h-96 overflow-auto rounded-md bg-muted/50 p-3">'
    expect(LEGACY.filter(needle => planted.includes(needle))).toEqual([...LEGACY])
  })
})

/**
 * UB14.32 — FreeFormInput assembled in v0.15.0's order, rendered for real (dark) in the composer's own states (the
 * `input-container` entry, already returned whole for UB14.27): ONE toolbar row for both layouts — attach (the named
 * icon button) · sources · folder on the left, a spacer, mode · model in the squeezable right group, then context and
 * Send; the composer owns its panel container; the draft takes the copy type with the overlay on the same line box.
 */
describe('the composer toolbar in upstream\'s order, the copy type and the collapsed spacer (UB14.32)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (variant: string | null) => {
    const verdict = verdicts.find(v => v.id === 'input-container' && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!
  }
  const LEFT_DESKTOP = 'class="flex items-center gap-1 min-w-[clamp(0px,calc(100%-11rem),6rem)] shrink overflow-hidden @max-[32rem]/panel:[&amp;_[data-badge-label]]:hidden"'
  /** UB12.78 — the same group where our branch chip mounts: the floor is four icons (8rem), not v0.15.1's three. */
  const LEFT_DESKTOP_FOUR = 'class="flex items-center gap-1 min-w-[clamp(0px,calc(100%-11rem),8rem)] shrink overflow-hidden @max-[32rem]/panel:[&amp;_[data-badge-label]]:hidden"'
  const LEFT_COMPACT = 'class="flex items-center gap-1 shrink-0 [&amp;_[data-badge-label]]:hidden"'
  const RIGHT = 'class="-m-1 flex min-w-0 shrink items-center gap-1 overflow-hidden p-1"'
  /** Each needle searched from its predecessor: all found means this order. */
  const inOrder = (markup: string, needles: readonly string[]) => {
    let from = 0
    return needles.map(needle => {
      const index = markup.indexOf(needle, from)
      if (index > -1) from = index
      return { needle, found: index > -1 }
    })
  }
  const allFound = (needles: readonly string[]) => needles.map(needle => ({ needle, found: true }))
  const textbox = (markup: string) => markup.match(/<div[^>]*role="textbox"[^>]*>/)?.[0] ?? ''
  const overlay = (markup: string) => markup.match(/<div[^>]*pointer-events-none select-none[^>]*>/)?.[0] ?? ''

  it('POSITIVE — desktop: attach · sources · folder · spacer · [mode · model] · Send inside the composer\'s own panel container', () => {
    const base = markupOf(null)
    const order = [
      '<div class="@container/panel relative flex flex-col min-h-0 overflow-hidden transition-colors">',
      'data-composer-actions="true"',
      LEFT_DESKTOP_FOUR, // the base state mounts the folder chip, so the branch chip's gate is open (UB12.78)
      `input-toolbar-btn" aria-label="${EN['chat.attachFiles']}"`,
      'aria-label="GitHub API, Linear"',
      'aria-label="nessy-general-agent"',
      '<div class="flex-1">',
      RIGHT,
      'data-tutorial="permission-mode-dropdown"',
      'data-tutorial="send-button"',
    ] as const
    expect(inOrder(base, order)).toEqual(allFound(order))
    // The draft takes v0.15.0's copy type, and the rotating tip shares its line box (F1.460 (2)).
    expect(textbox(base)).toContain('px-3.5 pt-3.5 pb-3.5 overflow-y-auto text-copy @max-panel-medium/panel:min-h-[76px]')
    expect(textbox(base)).toContain('line-height:var(--lh-copy)')
    expect(overlay(base)).toContain('line-height:var(--lh-copy)')
  })

  it('POSITIVE — compact: the left chips fold to icons and mode · model moved to the RIGHT, before Send', () => {
    const compact = markupOf('Safe + Compact')
    const order = [
      LEFT_COMPACT,
      `aria-label="${EN['chat.attachFiles']}"`,
      `aria-label="${EN['chat.sourcesCount']!.replace('{{count}}', '2')}"`,
      'aria-label="nessy-general-agent"',
      RIGHT,
      'data-mode="plan"',
      'data-tutorial="send-button"',
    ] as const
    expect(inOrder(compact, order)).toEqual(allFound(order))
    expect(textbox(compact)).toContain('text-copy-lg min-h-[80px]')
    expect(textbox(compact)).toContain('line-height:var(--lh-copy-lg)')
  })

  it('POSITIVE — compact while a turn runs: no draft, and the spacer is the tap-to-type target on v0.15.0\'s material', () => {
    const collapsed = markupOf('Compact + Processing (collapsed)')
    expect(collapsed).not.toContain('role="textbox"')
    expect(collapsed).toContain(
      `<button type="button" aria-label="${EN['chat.tapToType']}" class="motion-press mx-1 flex h-control min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md text-tertiary hover:bg-fill-hover hover:text-secondary">`,
    )
    expect(collapsed).toContain('class="flex items-center gap-1 pb-1.5 px-1 pt-1.5"')
  })

  it('NEGATIVE (control) — no state keeps the grid footer, the old draft padding, or a mode control in the left group', () => {
    const FOOTER = ['composer', 'footer'].join('-')
    const states = verdicts.filter(v => v.id === 'input-container' && v.markup && v.markup.includes('data-composer-actions'))
    // Positive control: the freeform states are found (the structured ones replace the composer and are skipped).
    expect(states.length).toBeGreaterThan(20)
    for (const verdict of states) {
      const markup = verdict.markup!
      const leftAt = Math.max(markup.indexOf(LEFT_DESKTOP), markup.indexOf(LEFT_DESKTOP_FOUR), markup.indexOf(LEFT_COMPACT))
      const leftGroup = markup.slice(leftAt, markup.indexOf(RIGHT, leftAt))
      expect({
        state: label(verdict),
        footer: markup.includes(FOOTER) || markup.includes('grid-cols-[minmax(0,1fr)_auto_auto]'),
        oldDraft: markup.includes('pl-5 pr-4 pt-4 pb-3') || markup.includes('min-h-[88px]'),
        leftGroup: leftAt > -1 && leftGroup.length > 0,
        modeOnLeft: leftGroup.includes('data-mode='),
      }).toEqual({ state: label(verdict), footer: false, oldDraft: false, leftGroup: true, modeOnLeft: false })
    }
  })

  /**
   * UB12.78 — the floor follows the branch chip's gate. The entry's states differ in one input of that gate, the folder
   * callback (workspace, session and `externalFooter.gitBranch` are constant), so the folder chip's wrapper is the
   * visible proxy: a desktop state that draws the folder chip carries the four-icon floor, one that does not keeps
   * v0.15.1's three-icon floor. (The static render draws no branch chip itself: it paints after its own fetch.)
   */
  it('UB12.78 — a desktop state with the folder chip (the branch chip\'s gate open) floors the left group at four icons; one without keeps v0.15.1\'s three', () => {
    const FOLDER_CHIP = 'class="shrink min-w-0 overflow-hidden"'
    const desktop = verdicts.filter(v => v.id === 'input-container' && v.markup && (v.markup.includes(LEFT_DESKTOP) || v.markup.includes(LEFT_DESKTOP_FOUR)))
    const rows = desktop.map(verdict => ({
      state: label(verdict),
      folderChip: verdict.markup!.includes(FOLDER_CHIP),
      three: verdict.markup!.includes(LEFT_DESKTOP),
      four: verdict.markup!.includes(LEFT_DESKTOP_FOUR),
    }))
    expect(rows.filter(row => row.four !== row.folderChip || row.three === row.four)).toEqual([])
    // Controls: both floors are reached by the sweep (the base state four; Minimal and Source-heavy Review three).
    expect({ four: rows.filter(row => row.four).length > 10, three: rows.some(row => row.three) }).toEqual({ four: true, three: true })
    expect(rows.find(row => row.state === label({ id: 'input-container', variant: 'Minimal' } as EntryVerdict))).toMatchObject({ three: true, four: false })
  })
})

/**
 * UB15.9 — Settings › Appearance's new sections at v0.15.1 (`ThemeGrid` taken 1:1, the page's Mode section and
 * Interface rows), rendered for real (dark) in every state of its entry: one tile per bundled preset plus the
 * built-in default, swatches solved in the state's mode, the dark-only caption on the dark-only preset alone, one
 * inert placeholder per bundled preset while loading (nothing below shifts), and the tri-state Motion row.
 */
describe('the Appearance mode, colour theme grid and Motion row, every state (UB15.9)', () => {
  const states = () => verdicts.filter(verdict => verdict.id === UB15_9_THEME_GRID_ENTRY)
  const count = (markup: string, needle: string | RegExp) =>
    typeof needle === 'string' ? markup.split(needle).length - 1 : (markup.match(needle) ?? []).length
  const TILE = /<button type="button" aria-pressed="(?:true|false)"/g
  const PLACEHOLDER = '<div aria-hidden="true" class="flex min-w-0 flex-col gap-1.5 rounded-lg p-1.5 inset-ring inset-ring-border">'
  const CAPTION = '<span class="shrink-0 font-normal text-tertiary">Dark</span>'
  const BUNDLED = readdirSync(join(REPO_ROOT, 'apps/electron/resources/themes')).filter(file => file.endsWith('.json')).length
  /** The option a radiogroup has checked, by its accessible name. */
  const checked = (markup: string, group: string) => {
    const start = markup.indexOf(`role="radiogroup" aria-label="${group}"`)
    return start === -1 ? null : markup.slice(start).match(/aria-checked="true"[^>]*>(?:<span[^>]*>(?:(?!<\/span>).)*<\/span>)?<span class="truncate">([^<]+)<\/span>/)?.[1] ?? null
  }
  /** A tile's paper and navigator colours (the swatch's first two fills). */
  const surfaces = (markup: string, label: string) => {
    const tile = markup.match(new RegExp(`<button type="button" aria-pressed="(?:true|false)"(?:(?!</button>).)*<span class="truncate">${label}</span>`))?.[0] ?? ''
    return [...tile.matchAll(/style="background:([^"]+)"/g)].slice(0, 2).map(m => m[1])
  }

  it('POSITIVE — every state draws the grid of bundled presets plus the default, one tile pressed, and the three-way Motion row', () => {
    expect(BUNDLED).toBeGreaterThan(0)
    expect(states().map(label)).toEqual([
      'settings-theme-grid · (base state)',
      'settings-theme-grid · Dark previews',
      'settings-theme-grid · Light previews',
      'settings-theme-grid · Loading presets',
      'settings-theme-grid · Motion reduced',
      'settings-theme-grid · Motion full',
    ])
    for (const verdict of states()) {
      const markup = verdict.markup!
      const loading = verdict.variant === 'Loading presets'
      expect(markup, label(verdict)).toContain('<div role="group" aria-label="Color theme" class="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5">')
      expect(count(markup, TILE), label(verdict)).toBe(loading ? 1 : BUNDLED + 1)
      expect(count(markup, PLACEHOLDER), label(verdict)).toBe(loading ? BUNDLED : 0)
      // Loading or loaded, the grid holds the same number of cells, so nothing below it shifts.
      expect(count(markup, TILE) + count(markup, PLACEHOLDER), label(verdict)).toBe(BUNDLED + 1)
      expect(count(markup, 'aria-pressed="true"'), label(verdict)).toBe(1)
      expect(checked(markup, 'Mode'), label(verdict)).not.toBeNull()
      expect(checked(markup, 'Font'), label(verdict)).toBe('System')
    }
    const markupOf = (variant: string) => states().find(verdict => verdict.variant === variant)!.markup!
    expect(checked(markupOf('Dark previews'), 'Motion')).toBe('System')
    expect(checked(markupOf('Motion reduced'), 'Motion')).toBe('Reduced')
    expect(checked(markupOf('Motion full'), 'Motion')).toBe('Full')
    // Live swatches in the state's mode: codex.json's own dark surfaces in dark, its light ones in light.
    expect(surfaces(markupOf('Dark previews'), 'Codex')).toEqual(['#212121', '#101010'])
    expect(surfaces(markupOf('Light previews'), 'Codex')).toEqual(['#ffffff', '#f9f9f9'])
  })

  it('NEGATIVE (control) — the dark-only caption marks the dark-only preset alone, a loading grid has no preset tile, and no state draws a dropdown for the theme', () => {
    for (const verdict of states()) {
      const markup = verdict.markup!
      const loading = verdict.variant === 'Loading presets'
      expect(count(markup, CAPTION), label(verdict)).toBe(loading ? 0 : 1)
      if (!loading) expect(markup, label(verdict)).toMatch(/<span class="truncate">Haze<\/span><span class="shrink-0 font-normal text-tertiary">Dark<\/span>/)
      expect(markup, label(verdict)).not.toContain('aria-haspopup')
    }
    // control: the caption needle is spelled as the grid spells it, and the haze tile previews dark in light mode
    expect(surfaces(states().find(verdict => verdict.variant === 'Light previews')!.markup!, 'Haze'))
      .toEqual(surfaces(states().find(verdict => verdict.variant === 'Dark previews')!.markup!, 'Haze'))
  })
})

/**
 * UB12.58 — Settings → Workspace's Published pages section (ours: `components/artifacts/PublishedPagesSection.tsx`,
 * outside UB15.12's pages/settings + components/settings census), rendered for real (dark) in every state of its
 * entry: v0.15.1's list rows in the raised card, the neutral chip, the named `IconButton`s, the list-row `danger`
 * removal, the info-tint notice for the signed-out and unavailable list, the download-line loading state and the
 * in-card empty state, instead of the muted shadcn ink, the hand-padded row, the 10px badge and the `warning` classes
 * (no `--color-warning` token exists, so they drew nothing) the section drew until UB12.58.
 */
describe('the Published pages section on the settings material, every state (UB12.58)', () => {
  const states = () => verdicts.filter(verdict => verdict.id === UB12_58_PUBLISHED_PAGES_ENTRY)
  const markupOf = (variant: string | null) => states().find(verdict => verdict.variant === variant)?.markup ?? ''
  const count = (markup: string, needle: string | RegExp) =>
    typeof needle === 'string' ? markup.split(needle).length - 1 : (markup.match(needle) ?? []).length
  const RAISED_CARD = 'rounded-lg bg-raised shadow-elev-1 overflow-hidden'
  const ROW = '<div class="flex min-h-14 items-center gap-3 px-3.5 py-2.5" data-state="'
  const TITLE = '<span class="text-label font-medium text-foreground truncate">'
  const URL_LINE = '<div class="text-label-sm leading-4.5 text-secondary mt-px [overflow-wrap:anywhere]">https://'
  const FINE_PRINT = '<div class="text-label-sm text-tertiary mt-0.5 flex flex-wrap gap-x-2">'
  const NOTICE = '<div class="rounded-lg bg-info-tint inset-ring inset-ring-[var(--info-border)] px-3.5 py-3" role="status">'
  const CHIP = '<span class="inline-flex h-5 shrink-0 items-center rounded-xs bg-fill-hover px-1.5 text-label-sm font-medium text-secondary" data-testid="published-page-chat-badge">'
  /** `IconButton size="sm"`, named: open and copy. */
  const NAMED_ICON = /<button data-slot="icon-button" type="button" class="[^"]* size-control-sm rounded-sm" aria-label="(?:Open|Copy link)" title="(?:Open|Copy link)">/g
  /** A button whose whole content is one icon and which carries no aria-label (named only by `title`, or not at all). */
  const UNNAMED_ICON = /<button(?![^>]*aria-label=)[^>]*><svg(?:(?!<\/button>).)*<\/svg><\/button>/g
  const DELETE = /<button data-slot="button" data-variant="danger" class="[^"]* h-control-sm rounded-sm px-2 text-label-sm"(?: disabled="")?><svg[^>]*lucide-trash2[^>]*>(?:(?!<\/button>).)*<\/svg>Delete<\/button>/g
  /** The material the section drew until UB12.58 (spelled as its source spelled it). */
  const LEGACY = [
    'text-muted-foreground', 'px-4 py-3', 'text-[10px]', 'bg-foreground/5', 'text-warning', 'bg-warning', 'border-warning',
    'h-3.5 w-3.5 mr-1',
  ] as const

  it('POSITIVE — every state draws v0.15.1\'s settings material: list rows in the raised card, named icon buttons, the danger removal, the info notice', () => {
    expect(states().map(label)).toEqual([
      'published-pages-list · (base state)',
      ...['none', 'live', 'expiring-soon', 'expired', 'needs-login', 'pending-deletion', 'loading', 'unavailable', 'registry-unreadable', 'busy', 'shared-chat']
        .map(variant => `published-pages-list · ${variant}`),
    ])
    // Live: two rows on the card's hairline; the title on the label ink, the URL on the description ink, the expiry
    // and source line as fine print; open and copy are named icon buttons, Delete the list-row danger removal.
    const live = markupOf('live')
    expect(live).toContain(RAISED_CARD)
    expect(count(live, ROW)).toBe(2)
    expect(count(live, 'aria-hidden="true" class="h-px bg-separator"')).toBe(1)
    expect({ titles: count(live, TITLE), urls: count(live, URL_LINE), fine: count(live, FINE_PRINT) }).toEqual({ titles: 2, urls: 2, fine: 2 })
    expect(count(live, NAMED_ICON)).toBe(4)
    expect(count(live, DELETE)).toBe(2)
    expect(markupOf(null)).toBe(live)
    // The amber "needs you" role marks the expiring row and the pending deletion; an expired row is destructive.
    expect(markupOf('expiring-soon')).toMatch(/<span class="text-info">[^<]+ · [^<]+<\/span>/)
    expect(markupOf('pending-deletion')).toContain('<span class="text-info">Deletion pending')
    expect(markupOf('expired')).toContain('<span class="text-destructive">')
    // Signed out and unavailable: ONE info-tint notice; the pending row still shows under the signed-out one.
    expect({ needsLogin: count(markupOf('needs-login'), NOTICE), unavailable: count(markupOf('unavailable'), NOTICE) })
      .toEqual({ needsLogin: 1, unavailable: 1 })
    expect(markupOf('needs-login')).toContain(`${ROW}pending-deletion"`)
    // First paint: the download line's spinner and type, no card and no Retry; the empty list: the in-card empty state.
    const loading = markupOf('loading')
    expect(loading).toContain('<div class="flex items-center gap-2 text-label-sm text-tertiary"><span class="spinner"')
    expect({ card: loading.includes(RAISED_CARD), retry: loading.includes('>Retry</button>') }).toEqual({ card: false, retry: false })
    expect(markupOf('none')).toContain(`${RAISED_CARD}"><div class="px-6 py-8 text-center"><p class="text-label text-secondary">`)
    // The registry note is fine print; a row in flight shows the tertiary spinner and disables extend and delete.
    expect(markupOf('registry-unreadable')).toContain('<p class="text-label-sm text-tertiary">This workspace')
    const busy = markupOf('busy')
    expect(busy).toContain('<span class="spinner text-label-sm text-tertiary" role="status"')
    expect(count(busy, /<button data-slot="button" data-variant="(?:ghost|danger)" class="[^"]*" disabled="">/g)).toBe(2)
    // A shared chat wears the neutral chip, once.
    expect(count(markupOf('shared-chat'), CHIP)).toBe(1)
  })

  it('NEGATIVE (control) — no state keeps the legacy material, and no icon-only button is named by its title alone', () => {
    expect(states().flatMap(verdict => LEGACY.filter(needle => verdict.markup!.includes(needle)).map(needle => `${label(verdict)}: ${needle}`)))
      .toEqual([])
    expect(states().filter(verdict => count(verdict.markup!, UNNAMED_ICON) > 0).map(label)).toEqual([])
    // The chip appears on the chat row alone; no other state draws it.
    expect(states().filter(verdict => verdict.markup!.includes('published-page-chat-badge')).map(label)).toEqual(['published-pages-list · shared-chat'])
    // Control: the probe reads real markup, and each needle fires on the shape the section drew until UB12.58.
    expect(states().every(verdict => (verdict.markup ?? '').length > 200)).toBe(true)
    const planted = [
      '<div class="flex items-start gap-3 px-4 py-3" data-state="live"><div class="min-w-0 flex-1 text-sm">',
      '<span class="shrink-0 rounded px-1.5 py-px text-[10px] font-medium bg-foreground/5 text-muted-foreground">Chat</span>',
      '<div class="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm" role="status"><svg class="h-4 w-4 text-warning"></svg>',
      '<button data-slot="button" data-variant="ghost" class="h-control-sm" title="Open"><svg class="lucide h-3.5 w-3.5"><path d="M15 3h6v6"></path></svg></button>',
      '<button data-slot="button" data-variant="ghost"><svg class="h-3.5 w-3.5 mr-1"></svg>Extend</button>',
    ].join('')
    expect(LEGACY.filter(needle => planted.includes(needle))).toEqual([...LEGACY])
    expect(count(planted, UNNAMED_ICON)).toBe(1)
    expect(count(markupOf('live').replace(/aria-label="Open" /, ''), UNNAMED_ICON)).toBe(1)
  })
})

/**
 * UB14.33 — v0.15.1's hint line under the composer card and the badge-row mode rule, rendered for real (dark) in the
 * composer's own states (the `input-container` entry, already returned whole for UB14.27): desktop draws the reserved
 * line under the card (keycaps for Send, new line and the mode cycle), a decision prompt keeps the line but empties it
 * and moves the mode control up into the row above the card, and compact draws no line at all.
 */
describe('the hint line under the card and the mode above it during a decision prompt (UB14.33)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (variant: string | null) => {
    const verdict = verdicts.find(v => v.id === 'input-container' && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!
  }
  const HINTS = 'data-composer-hints'
  const CARD = 'class="input-container '
  const MODE_TRIGGER = 'data-tutorial="permission-mode-dropdown"'
  /** The hint line's own markup, opening tag to its close (it holds spans and keycaps only, no nested div). */
  const hintLine = (markup: string) => {
    const start = markup.lastIndexOf('<div', markup.indexOf(HINTS))
    return markup.slice(start, markup.indexOf('</div>', start) + '</div>'.length)
  }
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

  it('POSITIVE — desktop: one reserved line UNDER the card, with Send ↵, new line and the mode cycle', () => {
    const base = markupOf(null)
    expect(count(base, HINTS)).toBe(1)
    expect(base.indexOf(CARD)).toBeGreaterThan(-1)
    expect(base.indexOf(HINTS)).toBeGreaterThan(base.indexOf(CARD))
    const line = hintLine(base)
    expect(line).toContain('h-6')
    expect(line).toContain('peer-focus-within/composer:opacity-100')
    for (const text of [EN['shortcuts.sendMessage']!, EN['shortcuts.newLine']!, EN['chat.permissionMode']!, '>↵</kbd>', '>Tab</kbd>']) {
      expect({ text, inLine: line.includes(text) }).toEqual({ text, inLine: true })
    }
    // Freeform: the mode lives in the toolbar only (inside the card), never in the row above it.
    expect(count(base, MODE_TRIGGER)).toBe(1)
    expect(base.indexOf(MODE_TRIGGER)).toBeGreaterThan(base.indexOf(CARD))
  })

  it('POSITIVE — a decision prompt keeps the reserved line empty and shows the mode in the row ABOVE the card', () => {
    const prompt = markupOf('Permission Mode UI')
    expect(count(prompt, HINTS)).toBe(1)
    const line = hintLine(prompt)
    expect(line).toContain('h-6')
    expect(line).not.toContain('<kbd')
    expect(line).not.toContain(EN['shortcuts.sendMessage']!)
    expect(count(prompt, MODE_TRIGGER)).toBe(1)
    expect(prompt.indexOf(MODE_TRIGGER)).toBeLessThan(prompt.indexOf(CARD))
  })

  it('NEGATIVE (control) — compact draws no hint line, and no state draws two', () => {
    for (const variant of ['Safe + Compact', 'Compact + Processing (collapsed)']) {
      expect({ variant, hints: count(markupOf(variant), HINTS) }).toEqual({ variant, hints: 0 })
    }
    const states = verdicts.filter(v => v.id === 'input-container' && v.markup)
    expect(states.length).toBeGreaterThan(20)
    expect(states.filter(v => count(v.markup!, HINTS) > 1).map(label)).toEqual([])
    // Control: the census sees both kinds — states with the line and states without it.
    expect(states.some(v => count(v.markup!, HINTS) === 1) && states.some(v => count(v.markup!, HINTS) === 0)).toBe(true)
  })
})

/**
 * UB14.34 — the pasted console snippet's offer (v0.15.0 `PastedCommandChip`), rendered for real (dark) in its states:
 * the composer meta chip naming the action and the command's first line, " …" for more lines, and a named dismiss.
 */
describe('the pasted console snippet\'s Run-in-background chip, every state (UB14.34)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (variant: string | null) => {
    const verdict = verdicts.find(v => v.id === UB14_34_PASTED_COMMAND_ENTRY && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!.replaceAll('<!-- -->', '')
  }

  it('POSITIVE — every state draws one meta chip with the action, the command\'s first line and a named dismiss', () => {
    for (const variant of [null, 'Single Command', 'Multi-line (first line + …)', 'Long Command (truncated)']) {
      const markup = markupOf(variant)
      expect({ variant, chips: markup.split('data-pasted-command').length - 1 }).toEqual({ variant, chips: 1 })
      for (const part of [`>${EN['chat.runCommandInBackground']}</span>`, `aria-label="${EN['common.dismiss']}"`, 'h-control-sm', 'text-accent', 'truncate font-mono']) {
        expect({ variant, part, drawn: markup.includes(part) }).toEqual({ variant, part, drawn: true })
      }
    }
    expect(markupOf('Multi-line (first line + …)')).toContain('>git status …</span>')
  })

  it('NEGATIVE (control) — a one-line command carries no " …" marker, so the arm above can fail', () => {
    const single = markupOf('Single Command')
    expect(single).toContain('>bun test</span>')
    expect(single).not.toContain(' …</span>')
  })
})

/**
 * UB14.55 — the rows above the composer at v0.15.1 (R2-08), rendered for real (dark): the background-task row on its
 * own line (upstream's `mb-2`), then ONE quiet chip row — the mode chip (`ComposerModeChip`) while a decision prompt
 * replaces the toolbar, and our session facts (never persisted P6.502, `@agent` P6.940) on the static meta chip. The
 * label and status chips left for the chat header (UB14.6): with labels and a status set, the row draws neither.
 */
describe('the rows above the composer: the task row, then one quiet chip row (UB14.55)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (id: string, variant: string | null) => {
    const verdict = verdicts.find(v => v.id === id && v.variant === variant)
    expect({ id, variant, found: !!verdict?.markup }).toEqual({ id, variant, found: true })
    return verdict!.markup!.replaceAll('<!-- -->', '')
  }
  const CARD = 'class="input-container '
  /** Everything the zone draws ABOVE the visible card (the rows this row owns). */
  const above = (markup: string) => {
    const at = markup.indexOf(CARD)
    expect(at).toBeGreaterThan(-1)
    return markup.slice(0, at)
  }
  const ROW = 'data-slot="session-chips"'
  const MODE_TRIGGER = 'data-tutorial="permission-mode-dropdown"'
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1
  const factTag = (markup: string, testId: string) => new RegExp(`<div[^>]*data-testid="${testId}"[^>]*>`).exec(markup)?.[0] ?? ''
  /** The label and status words the input-container fixture sets (labels Bug/Priority/Sprint, status In Progress). */
  const LABEL_AND_STATUS_WORDS = ['Bug', 'Priority', 'Sprint', 'In Progress']
  const drawnWords = (markup: string) => LABEL_AND_STATUS_WORDS.filter(word => new RegExp(`>\\s*${word}\\s*<`).test(markup))

  it('POSITIVE — a session with facts: the row above the card draws both fact chips on the static meta chip, inert', () => {
    const row = above(markupOf('input-container', 'Session Facts (never persisted, pinned agent)'))
    expect(count(row, ROW)).toBe(1)
    for (const testId of ['never-persist-badge', 'session-agent-badge']) {
      const tag = factTag(row, testId)
      expect({ testId, note: tag.includes('role="note"'), chip: tag.includes('h-control-sm') && tag.includes('rounded-full') && tag.includes('bg-raised'), press: tag.includes('motion-press') })
        .toEqual({ testId, note: true, chip: true, press: false })
    }
    expect(row).toContain(`>${EN['session.neverPersistBadge']}</span>`)
    expect(row).toContain('>@reviewer</span>')
    // Freeform: the mode chip is the toolbar's, never raised above the card.
    expect(count(row, MODE_TRIGGER)).toBe(0)
  })

  it('NEGATIVE — with labels and a status set, nothing above the card draws a label or status chip (the header owns them)', () => {
    for (const variant of [null, 'Session Facts (never persisted, pinned agent)', 'Label-heavy Review']) {
      const row = above(markupOf('input-container', variant))
      expect({ variant, words: drawnWords(row), badge: row.includes('h-[30px]'), stack: row.includes('drop-shadow(') }).toEqual({ variant, words: [], badge: false, stack: false })
    }
    // Control: the same detector finds the label chip where one IS drawn — the chat header.
    expect(drawnWords(markupOf('chat-header', 'Two labels'))).toContain('Bug')
  })

  it('POSITIVE — a decision prompt raises the v0.15.1 mode chip into the same row as the facts; the legacy dropdown is gone', () => {
    const row = above(markupOf('input-container', 'Session Facts + Permission Mode UI'))
    expect(count(row, ROW)).toBe(1)
    const rowMarkup = row.slice(row.indexOf(ROW))
    const chip = /<button[^>]*data-tutorial="permission-mode-dropdown"[^>]*>/.exec(rowMarkup)?.[0] ?? ''
    expect({ mode: chip.includes('data-mode="default"'), tone: chip.includes('bg-info-tint text-info'), pill: chip.includes('rounded-full') && chip.includes('h-control') })
      .toEqual({ mode: true, tone: true, pill: true })
    expect(rowMarkup.indexOf(MODE_TRIGGER)).toBeLessThan(rowMarkup.indexOf('data-testid="never-persist-badge"'))
    for (const state of ['Session Facts + Permission Mode UI', 'Permission Mode UI']) {
      const markup = markupOf('input-container', state)
      expect({ state, legacy: markup.includes('shadow-tinted') || markup.includes('--shadow-color') }).toEqual({ state, legacy: false })
    }
  })

  it('POSITIVE — the task row is its own line above the chip row, with upstream\'s margin; the standalone entry draws our facts', () => {
    const both = markupOf('active-tasks-bar-context', 'With Tasks And Session Facts')
    const bar = /<div[^>]*data-slot="background-tasks"[^>]*>/.exec(both)?.[0] ?? ''
    expect({ bar: bar.length > 0, margin: / class="mb-2 flex /.test(bar) }).toEqual({ bar: true, margin: true })
    expect(both.indexOf('data-slot="background-tasks"')).toBeLessThan(both.indexOf(ROW))
    const standalone = markupOf('active-option-badges', 'Session Facts Only')
    expect({ agent: standalone.includes('>@reviewer</span>'), persist: standalone.includes('data-testid="never-persist-badge"'), mode: count(standalone, MODE_TRIGGER) })
      .toEqual({ agent: true, persist: true, mode: 0 })
  })

  it('NEGATIVE (control) — no facts, no prompt: no chip row at all; the tasks alone keep their row', () => {
    const tasksOnly = markupOf('active-tasks-bar-context', 'With Multiple Tasks')
    expect({ row: count(tasksOnly, ROW), bar: count(tasksOnly, 'data-slot="background-tasks"') }).toEqual({ row: 0, bar: 1 })
    expect(count(above(markupOf('input-container', null)), ROW)).toBe(0)
  })
})

/**
 * UB12.79 — what a task card's Open shows, rendered for real (dark) through the overlay `ChatDisplay` mounts
 * (`chat-display/TaskOutputOverlay`): an agent's digest as v0.15.1's document overlay — the message, a rule, the recent
 * steps under their heading (a source tool by its source), the task's name on a Bot badge — and a command's whole
 * output in the terminal overlay, with L9's running notice only while it runs AND its row is still listed.
 */
describe('the task output overlay: an agent as a document, a command in the terminal (UB12.79)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const markupOf = (variant: string | null) => {
    const verdict = verdicts.find(v => v.id === UB12_79_TASK_OUTPUT_ENTRY && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!.replaceAll('<!-- -->', '')
  }
  const DOCUMENT = 'class="markdown-content"'
  const TERMINAL = '>Terminal</div>'
  const STEPS = `<strong class="font-semibold">${EN['chat.backgroundTask.recentSteps']}</strong>`
  const running = (subject: string) => EN['chat.taskOutputRunningTitle']!.replace('{{subject}}', subject)

  it('POSITIVE — an agent digest opens the document: the message, a rule, the steps, the task on a Bot badge', () => {
    for (const variant of [null, 'Agent Digest']) {
      const markup = markupOf(variant)
      expect({ variant, document: markup.includes(DOCUMENT), terminal: markup.includes(TERMINAL) }).toEqual({ variant, document: true, terminal: false })
      const doc = markup.slice(markup.indexOf(DOCUMENT))
      const message = doc.indexOf('Radix popovers trap focus while open.')
      expect(message).toBeGreaterThan(-1)
      expect(doc.indexOf('<hr')).toBeGreaterThan(message)
      expect(doc.indexOf(STEPS)).toBeGreaterThan(doc.indexOf('<hr'))
      for (const step of ['<strong class="font-semibold">Read</strong>', '<strong class="font-semibold">Grep</strong> newAutoLabelEntries',
        '<strong class="font-semibold">github</strong> Search Code']) {
        expect({ variant, step, drawn: doc.includes(step) }).toEqual({ variant, step, drawn: true })
      }
      expect(markup).toContain('lucide-bot')
      expect(markup).toContain('title="Research Radix popover focus rules"')
    }
  })

  it('BOUNDARY — an agent with no message yet draws its steps alone, with no rule', () => {
    const markup = markupOf('Agent Steps Only (No Message Yet)')
    expect(markup).toContain(STEPS)
    expect(markup).not.toContain('<hr')
    expect(markup).not.toContain(TERMINAL)
  })

  it('NEGATIVE (control) — a command opens the terminal, never the document; the running notice only while it runs and is listed', () => {
    const live = markupOf('Command Running')
    const gone = markupOf('Command Running, Row Gone')
    const ended = markupOf('Command Ended (Exit 1)')
    for (const [name, markup] of [['live', live], ['gone', gone], ['ended', ended]] as const) {
      expect({ name, terminal: markup.includes(TERMINAL), document: markup.includes(DOCUMENT), steps: markup.includes(STEPS) })
        .toEqual({ name, terminal: true, document: false, steps: false })
    }
    expect(live).toContain(`>${running('bun test --watch')}</span>`)
    expect(gone).not.toContain(running('bun test --watch'))
    expect(gone).toContain('>bun test --watch</span>')
    expect(ended).not.toContain(running('Lint the workspace'))
    expect(ended).toContain('>exit 1</span>')
  })
})

/**
 * UB14.62 — the queue strip above the composer (ours: `input/QueuedMessageList.tsx`; upstream v0.15.1 has no queue
 * UI, B1) on the composer meta-chip material, rendered for real (dark) in the `input-container` entry's two queue
 * states (already returned whole for UB14.27): each row is the raised fill and inset hairline in a `rounded-md` row
 * with the message on `text-label` / `text-secondary`, its five verbs are named IconButtons with tertiary icons, and
 * the paused state's banner sits on `text-tertiary` beside a Resume drawn as the meta chip itself.
 */
describe('the queue strip on the composer meta-chip material, live and paused (UB14.62)', () => {
  const EN = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>
  const QUEUE_STATES = ['Queued Follow-ups', 'Paused Queue'] as const
  const STRIP = 'data-slot="message-queue"'
  const markupOf = (variant: string | null) => {
    const verdict = verdicts.find(v => v.id === 'input-container' && v.variant === variant)
    expect({ variant, found: !!verdict?.markup }).toEqual({ variant, found: true })
    return verdict!.markup!.replaceAll('<!-- -->', '')
  }
  /** The strip's own element, its opening `<div` to the matching `</div>` (its rows are divs; buttons, spans, svgs are not). */
  const stripOf = (markup: string) => {
    const at = markup.indexOf(STRIP)
    if (at === -1) return ''
    const start = markup.lastIndexOf('<div', at)
    const tags = /<div\b|<\/div>/g
    tags.lastIndex = start
    let depth = 0
    for (let tag = tags.exec(markup); tag; tag = tags.exec(markup)) {
      depth += tag[0] === '</div>' ? -1 : 1
      if (depth === 0) return markup.slice(start, tag.index + '</div>'.length)
    }
    return ''
  }
  const classesOf = (tag: string) => (/ class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ')
  const hasAll = (tag: string, wanted: readonly string[]) => wanted.every(c => classesOf(tag).includes(c))
  const VERBS = ['chat.queue.steer', 'chat.queue.moveUp', 'chat.queue.moveDown', 'chat.queue.edit', 'chat.queue.delete'] as const
  const MATERIAL = ['bg-raised', 'ring-1', 'ring-inset', 'ring-border', 'rounded-md'] as const
  /** The strip's pre-UB14.62 look: alpha-on-foreground text and fills, and literal pixel radii. */
  const OLD_LOOK = [/text-foreground\//, /bg-foreground\//, /rounded-\[\d+px\]/] as const

  it('POSITIVE — live and paused: two rows on the meta-chip material, the message on the label roles, five named IconButtons each', () => {
    for (const variant of QUEUE_STATES) {
      const strip = stripOf(markupOf(variant))
      const rows = [...strip.matchAll(/<div[^>]*data-slot="queued-message"[^>]*>/g)].map(m => m[0])
      expect({ variant, rows: rows.length }).toEqual({ variant, rows: 2 })
      for (const row of rows) {
        expect({ variant, material: hasAll(row, MATERIAL), pressable: classesOf(row).includes('motion-press') }).toEqual({ variant, material: true, pressable: false })
      }
      const message = /<span class="([^"]*)">Add a regression test for queued follow-up replay\.<\/span>/.exec(strip)?.[1] ?? ''
      expect({ variant, message: hasAll(` class="${message}"`, ['text-label', 'text-secondary', 'truncate']) }).toEqual({ variant, message: true })
      const buttons = [...strip.matchAll(/<button[^>]*data-slot="icon-button"[^>]*>/g)].map(m => m[0])
      expect({ variant, buttons: buttons.length }).toEqual({ variant, buttons: 10 })
      for (const key of VERBS) {
        const named = buttons.filter(tag => tag.includes(`aria-label="${EN[key]}"`))
        expect({ variant, key, named: named.length, tertiary: named.every(tag => hasAll(tag, ['text-tertiary', 'size-control-sm'])) })
          .toEqual({ variant, key, named: 2, tertiary: true })
      }
    }
  })

  it('POSITIVE — paused: the banner on text-tertiary and Resume as the pressable meta chip; live draws neither', () => {
    const paused = stripOf(markupOf('Paused Queue'))
    const banner = new RegExp(`<span class="([^"]*)">${EN['chat.queue.pausedBanner']}</span>`).exec(paused)?.[1] ?? ''
    expect(hasAll(` class="${banner}"`, ['text-label', 'text-tertiary'])).toBe(true)
    const resume = new RegExp(`<button[^>]*>${EN['chat.queue.resume']}</button>`).exec(paused)?.[0] ?? ''
    expect(hasAll(resume, ['h-control-sm', 'rounded-full', 'bg-raised', 'ring-inset', 'ring-border', 'motion-press', 'text-label-sm'])).toBe(true)
    const live = stripOf(markupOf('Queued Follow-ups'))
    expect({ banner: live.includes(EN['chat.queue.pausedBanner']!), resume: live.includes(`>${EN['chat.queue.resume']}</button>`) }).toEqual({ banner: false, resume: false })
  })

  it('NEGATIVE — no state keeps the old look; only the two queue states draw a strip, and the one without a queue draws none', () => {
    const states = verdicts.filter(v => v.id === 'input-container' && v.markup)
    expect(states.length).toBeGreaterThan(20)
    const withStrip = states.filter(v => stripOf(v.markup!.replaceAll('<!-- -->', '')) !== '').map(v => v.variant)
    expect(withStrip.sort()).toEqual([...QUEUE_STATES].sort())
    for (const variant of QUEUE_STATES) {
      const strip = stripOf(markupOf(variant))
      // Control: the slice is the strip, rows and buttons included, so the census below cannot pass on an empty string.
      expect({ variant, rows: strip.includes('data-slot="queued-message"'), closes: strip.endsWith('</div>') }).toEqual({ variant, rows: true, closes: true })
      expect({ variant, old: OLD_LOOK.filter(re => re.test(strip)).map(String) }).toEqual({ variant, old: [] })
    }
    // The detector reads this grammar: the same patterns fire on the class string the strip drew before this row.
    expect(OLD_LOOK.every(re => re.test('class="inline-flex h-6 rounded-[6px] text-foreground/70 hover:bg-foreground/10"'))).toBe(true)
  })
})
