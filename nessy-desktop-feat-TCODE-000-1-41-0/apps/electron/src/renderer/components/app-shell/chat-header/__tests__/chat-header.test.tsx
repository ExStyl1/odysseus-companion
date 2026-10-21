/**
 * UB14.6 (B3-07, R2-07; upstream v0.15.1 `chat-header/{ChatHeader,ChatHeaderLabels,ChatHeaderStatusButton,
 * ChatShareMenu}.tsx`, `atoms/label-value-edit.ts`, `PanelHeader.tsx`) — the chat header carries status · title ·
 * folder · labels (+N) · info · share · ⋯, with our share flow, saved actions and Edit task re-applied.
 *
 * Before the row the chat header was `PanelHeader` with a centred title dropdown (`titleMenu`), a Share button
 * built in `ChatPage`, and labels and status only in the composer's badge row: there was no `chat-header` entry, no
 * status glyph, no label strip, and nothing read `pendingLabelValueEditAtom`, so every POSITIVE arm below fails on
 * that tree.
 *
 * Instrument: one child process (`fixtures/chat-header-probe.ts`; its docblock says why a child and how each reading
 * is taken) — the playground entry's states rendered in DARK (the design surface), the share menu and the actions
 * slot driven through the components' own code, and the label strip mounted on the real reconciler for its effects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { CHAT_HEADER_PROBE_MARKER, type ChatHeaderProbeReading } from './fixtures/chat-header-probe'

const CHILD = new URL('./fixtures/chat-header-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../../', import.meta.url).pathname
const OUR_LEARN_MORE = 'https://gitlab.tcsbank.ru/nessy-desktop/nessy-desktop'
/** The domain no shipped string may carry (assembled, so this file's own source is not a hit for a broader grep). */
const CRAFT_DOMAIN = ['thecraftagents', 'com'].join('.')

let reading: ChatHeaderProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'chat-header-probe-'))
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
  const at = stdout.lastIndexOf(CHAT_HEADER_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`chat-header probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + CHAT_HEADER_PROBE_MARKER.length)) as ChatHeaderProbeReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const state = (variant: string) => {
  const html = reading.states[`chat-header · ${variant}`]
  if (html === undefined) throw new Error(`no state "chat-header · ${variant}" (threw: ${JSON.stringify(reading.threw)})`)
  return html
}
/** Opening tags of every element carrying `aria-label="<label>"`. */
const tagsLabelled = (html: string, label: string) =>
  html.match(new RegExp(`<[a-z]+ [^>]*aria-label="${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'g')) ?? []
/** The label strip's chips (React writes the `true` data attribute as `"true"`); a hidden one carries `aria-hidden`. */
const chips = (html: string) => html.match(/<span data-label-chip="true"[^>]*>/g) ?? []
const visibleChips = (html: string) => chips(html).filter(tag => !tag.includes('aria-hidden'))
const SHORT_TITLE = 'Create a new branch based on latest main'

describe('the probe covered the states', () => {
  it('POSITIVE CONTROL — every state of the entry rendered in the dark sweep, none threw', () => {
    expect(reading.threw).toEqual({})
    for (const variant of ['(base state)', 'No labels', 'Two labels', 'Overflow (6 labels)', 'Narrow panel', 'Shared, long title', 'Compact', 'Sharing off', 'Task orchestrator']) {
      expect({ variant, length: state(variant).length > 0 }).toEqual({ variant, length: true })
    }
  })
})

describe('the desktop header: status · title · folder · labels · info · share · ⋯ (UB14.6)', () => {
  it('POSITIVE — the status glyph, the rename title, the folder meta, two chips, Info, Share and ⋯ render', () => {
    const html = state('Two labels')
    expect(tagsLabelled(html, 'Status: In Progress')).toHaveLength(1)
    expect(html).toContain(`title="Rename Session"`)
    expect(html).toContain(`>${SHORT_TITLE}</span>`)
    // The meta is OUR folder (the bound project's basename), titled with the whole path.
    expect(html).toMatch(/<span class="[^"]*text-tertiary[^"]*" title="\/Users\/demo\/nessy-desktop">nessy-desktop<\/span>/)
    expect(html).toContain('data-slot="chat-header-labels"')
    expect(visibleChips(html)).toHaveLength(2)
    expect(tagsLabelled(html, 'Session info')).toHaveLength(1)
    expect(tagsLabelled(html, 'Share session')).toHaveLength(1)
    const more = tagsLabelled(html, `Actions for ${SHORT_TITLE}`)
    expect(more).toHaveLength(1)
    expect(more[0]).toContain('aria-haspopup="menu"')
  })

  it('POSITIVE — six labels show three whole chips, then "+3" naming the rest', () => {
    const html = state('Overflow (6 labels)')
    expect(chips(html)).toHaveLength(6) // every chip renders so it can be measured …
    expect(visibleChips(html)).toHaveLength(3) // … and only whole chips up to the cap show
    const counter = tagsLabelled(html, '3 more labels')
    expect(counter).toHaveLength(1)
    expect(html).toMatch(/aria-label="3 more labels"[^>]*>\+3<\/button>/)
    // every hidden chip is out of sight and out of the focus order
    for (const tag of chips(html).filter(tag => tag.includes('aria-hidden'))) expect(tag).toContain('visibility:hidden')
  })

  it('POSITIVE — a published session\'s Share button is the accent "shared" state', () => {
    const tags = tagsLabelled(state('Shared, long title'), 'Shared session options')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toContain('text-accent')
  })

  it('POSITIVE — a task orchestrator gets Edit task (UA3.6); NEGATIVE — a plain session does not', () => {
    expect(tagsLabelled(state('Task orchestrator'), 'Edit task')).toHaveLength(1)
    expect(tagsLabelled(state('Two labels'), 'Edit task')).toHaveLength(0)
  })

  it('NEGATIVE — no labels draws no strip; sharing off draws no Share button (RENDERER_CONFIG)', () => {
    expect(state('No labels')).not.toContain('data-slot="chat-header-labels"')
    const off = state('Sharing off')
    expect(tagsLabelled(off, 'Share session')).toHaveLength(0)
    expect(tagsLabelled(off, 'Shared session options')).toHaveLength(0)
    expect(tagsLabelled(off, 'Session info')).toHaveLength(1) // control: the rest of the actions are still there
  })

  it('the header is the 48px v0.15.1 PanelHeader with the title row in flow (no centred title dropdown)', () => {
    const html = state('Two labels')
    expect(html).toMatch(/<div class="flex shrink-0 items-center min-w-0 gap-1\.5 relative z-panel h-12 [^"]*">/)
    expect(html).not.toContain('h-[42px]')
    expect(html).not.toContain('lucide-chevron-down')
  })
})

describe('the compact header (UB14.6)', () => {
  it('NEGATIVE — compact renders no labels, no folder meta and no Share; ⋯ opens the drawer (aria-haspopup="dialog")', () => {
    const html = state('Compact')
    expect(html).not.toContain('data-slot="chat-header-labels"')
    expect(html).not.toContain('>nessy-desktop</span>')
    expect(tagsLabelled(html, 'Share session')).toHaveLength(0)
    expect(tagsLabelled(html, 'Session info')).toHaveLength(0) // Session info lives in the drawer here
    const more = tagsLabelled(html, `Actions for ${SHORT_TITLE}`)
    expect(more).toHaveLength(1)
    expect(more[0]).toContain('aria-haspopup="dialog"')
    // control: the status glyph is still there, opening the drawer's Status pane rather than the desktop popover
    const status = tagsLabelled(html, 'Status: In Progress')
    expect(status).toHaveLength(1)
    expect(status[0]).not.toContain('data-slot="popover-trigger"')
    expect(tagsLabelled(state('Two labels'), 'Status: In Progress')[0]).toContain('data-slot="popover-trigger"')
  })
})

describe('the share menu keeps our flow and our page (UB14.6 Keep)', () => {
  it('POSITIVE — "Learn More" opens OUR page, shared or not, and the menu lists our share items', () => {
    expect(reading.share.notShared.learnMoreUrls).toEqual([OUR_LEARN_MORE])
    expect(reading.share.shared.learnMoreUrls).toEqual([OUR_LEARN_MORE])
    expect(reading.share.notShared.markup).toContain('Share Online')
    for (const item of ['Open in Browser', 'Copy Link', 'Update Share', 'Stop Sharing']) expect(reading.share.shared.markup).toContain(item)
  })

  it('NEGATIVE — no rendered state or menu carries the Craft sharing domain', () => {
    const rendered = [...Object.values(reading.states), reading.share.notShared.markup, reading.share.shared.markup]
    expect(rendered.filter(html => html.includes(CRAFT_DOMAIN))).toEqual([])
    expect(rendered.filter(html => html.includes(OUR_LEARN_MORE))).toEqual([]) // the URL is opened, never printed
  })

  it('grep pin — no tracked or new file under apps/ or packages/ ships the Craft sharing domain (control: our URL is found)', () => {
    const grep = (needle: string) => {
      try {
        return execFileSync('git', ['grep', '--untracked', '-n', '-F', needle, '--', 'apps', 'packages', ':(exclude)**/__tests__/**'], {
          cwd: REPO_ROOT, encoding: 'utf-8',
        }).split('\n').filter(Boolean)
      } catch (error) {
        if ((error as { status?: number }).status === 1) return []
        throw error
      }
    }
    expect(grep(CRAFT_DOMAIN)).toEqual([])
    expect(grep(OUR_LEARN_MORE).some(line => line.startsWith('apps/electron/src/renderer/components/app-shell/chat-header/ChatShareMenu.tsx:'))).toBe(true)
  })
})

describe('the actions slot keeps our launcher (P6.361) and Edit task (UA3.6)', () => {
  it('POSITIVE — WorkspaceActionsMenu leads the actions for this session\'s workspace', () => {
    expect(reading.actions.plain).toEqual(['WorkspaceActionsMenu', 'SessionInfoPopover', 'ChatShareMenu', 'DropdownMenu'])
    expect(reading.actions.workspaceActionsProps).toEqual({ sessionId: 'session-1', workspaceId: 'playground-workspace' })
    expect(reading.actions.taskOrchestrator).toEqual(['WorkspaceActionsMenu', 'PanelHeaderCenterButton', 'SessionInfoPopover', 'ChatShareMenu', 'DropdownMenu'])
  })

  it('NEGATIVE — sharing off drops only Share; compact keeps the launcher and the drawer ⋯', () => {
    expect(reading.actions.sharingOff).toEqual(['WorkspaceActionsMenu', 'SessionInfoPopover', 'DropdownMenu'])
    expect(reading.actions.compact).toEqual(['WorkspaceActionsMenu', 'PanelHeaderCenterButton'])
  })
})

describe('sameHeaderProps: streamed deltas skip the header', () => {
  it('POSITIVE — a field-equal new meta object is "same"', () => {
    expect(reading.sameHeaderProps.fieldEqualNewMeta).toBe(true)
  })
  it('NEGATIVE — a new title, a changed meta field or the sharing gate re-render it', () => {
    expect(reading.sameHeaderProps.titleChanged).toBe(false)
    expect(reading.sameHeaderProps.metaFieldChanged).toBe(false)
    expect(reading.sameHeaderProps.sharingToggled).toBe(false)
  })
})

describe('a valued label opens its editor via pendingLabelValueEditAtom (v0.15.0 "Editable label values")', () => {
  it('POSITIVE — the request for this session and panel opens that chip\'s editor and is consumed', () => {
    expect(reading.pendingEdit.matching).toEqual({ openChips: ['priority::2'], atomAfter: null })
  })
  it('POSITIVE — with two entries of the id, the newest one opens (UB4.13\'s residue retired here)', () => {
    expect(reading.pendingEdit.newestOfTwo).toEqual({ openChips: ['code::svn'], atomAfter: null })
  })
  it('NEGATIVE — another panel\'s request opens nothing and is left for that panel', () => {
    expect(reading.pendingEdit.otherPanel.openChips).toEqual([])
    expect(reading.pendingEdit.otherPanel.atomAfter).toMatchObject({ panelId: 'panel-b', labelId: 'priority' })
  })
  it('BOUNDARY — a request past its 10 s TTL is dropped unopened; one whose label has not arrived waits', () => {
    expect(reading.pendingEdit.stale).toEqual({ openChips: [], atomAfter: null })
    expect(reading.pendingEdit.notArrived.openChips).toEqual([])
    expect(reading.pendingEdit.notArrived.atomAfter).toMatchObject({ labelId: 'due' })
  })
})

describe('ChatPage hands the header over (per-hunk merge, our specifics kept)', () => {
  const page = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'pages', 'ChatPage.tsx'), 'utf8')

  it('POSITIVE — both session branches mount ChatHeader with the sharing gate; the runtime-switch toasts stay', () => {
    expect(page.match(/<ChatHeader\n/g) ?? []).toHaveLength(2)
    expect(page.match(/sharingEnabled=\{RENDERER_CONFIG\.sharingEnabled\}/g) ?? []).toHaveLength(2)
    expect(page).toContain("t('chat.runtimeSwitch.capabilityEditTooling')")
    expect(page).toContain('<ProjectTrustDialog')
  })

  it('NEGATIVE — no title menu, share flow, rename dialog or status hand-off is left in the page', () => {
    for (const gone of ['titleMenu', 'compactTitleMenu', 'shareToViewer', 'RenameDialog', 'compactInfoButton', 'sessionStatuses={sessionStatuses}', 'onSessionStatusChange={handleSessionStatusChange}']) {
      expect({ gone, present: page.includes(gone) }).toEqual({ gone, present: false })
    }
  })
})
