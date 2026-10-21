/**
 * P3.158 · the `/help` table and the composer menu list the SAME commands.
 *
 * `/help` is answered host-side from `@nessy-agent/shared/slash-commands/help`,
 * which cannot import the renderer's menu — the menu rows are React elements
 * with icons and i18n keys, and dragging that into `packages/shared` would put
 * the renderer bundle inside the agent. So the two tables are separate on
 * purpose, and this test is what keeps them one table in practice: a command
 * added to the menu and not to the listing is undocumented, and a command in
 * the listing with no menu row is either a typed-only command (there are
 * exactly two, and they are named) or a lie.
 *
 * The ids are the contract; the PROSE deliberately is not. A help listing reads
 * differently from a menu row — "/subtask <task>" with its argument, against a
 * menu label of "Subtask" — so the summaries are each surface's own and are not
 * diffed.
 *
 * Loading the menu module NO LONGER needs the pdfjs/DOMMatrix preamble (P6.844):
 * the chain that reached `Markdown` → `MarkdownPdfBlock` → `pdfjs-dist` was the
 * `@nessy-agent/ui` barrel, and the menu takes its one icon from
 * `@nessy-agent/ui/icons` now. The import stays DYNAMIC for the cost rather than
 * for the stubs — a static one turned a 2 s file into a 100 s hook timeout when it
 * was measured, and that measurement was of the graph, not of the mock ordering.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import type { SlashCommand } from '../slash-command-menu'
import type { SessionCommandHelpEntry } from '@nessy-agent/shared/slash-commands'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/*
 * P6.844 — the pdfjs carve-out that stood here is GONE, for the reason
 * `slash-command-menu.test.tsx` records beside its own: the menu module took one
 * name, `Icon_Folder`, from the `@nessy-agent/ui` barrel and now takes it from
 * `@nessy-agent/ui/icons`, so nothing this file loads reaches pdfjs any more.
 */

let defaultSlashCommands: SlashCommand[]
let permissionModeOrder: readonly string[]
let helpEntries: readonly SessionCommandHelpEntry[]

/**
 * The commands with no menu row, and why each is deliberate. Counted by the
 * ARRAY below rather than by a number in this sentence: this docblock said "two"
 * while listing three, and a count in prose beside a list is the drift AGENTS.md
 * §Traps records — it ages silently every time the list grows.
 *  - `/heapdump` — troubleshooting.md says it "doesn't appear in the command
 *    menu; type it in full".
 *  - `/rewind` — `checkpointing.md#rewind-and-summarize` binds it to opening a
 *    menu of its own, so it is answered in the renderer and never travels.
 *  - `/resume [session-id]` — P6.106. Meaningful only while the session has a
 *    cleared runtime session to return to; a permanent menu row would answer
 *    "nothing to resume" almost every time it was picked, so the offer is made
 *    in `/clear`'s own reply, which can name the id.
 *  - `/branch` — P6.881. The transcript's branch button is the RICHER surface
 *    (it can branch from any turn and switches you in), so a permanent menu row
 *    beside it would offer the weaker half of the same affordance. The typed
 *    spelling exists because it is the only one that reaches `-p`, `apps/cli`
 *    and the headless server, where there is no transcript to click.
 *  - `/tasks` — D1.14. The background-task panel is the richer surface, so the
 *    typed spelling is the one that reaches `-p`, `apps/cli` and the headless
 *    server rather than a second, weaker menu row.
 *  - `/workflows` — D1.14 + D1.37. The all-stop, and a permanent menu row for a
 *    gesture that stops everything is an invitation; typed is deliberate.
 * Every one of them is a real command a user can type, so a listing that omitted
 * them would be the only documentation of them, failing.
 */
const TYPED_ONLY_LABELS = ['/heapdump', '/rewind', '/resume [session-id]', '/branch', '/tasks', '/workflows']

beforeAll(async () => {
  // THE MENU MODULE FIRST, and the order is load-bearing — the sibling
  // `slash-command-menu.test.tsx` measured it both ways: importing any
  // `@nessy-agent/shared/*` subpath BEFORE `../slash-command-menu` makes that
  // import cost ~42 s instead of ~0.6 s, and it surfaces as a hung hook rather
  // than as slowness. (This file was written with the shared imports static and
  // hit exactly that: a 15.8 s hook timeout against the 5 s default.) So every
  // shared value below is resolved lazily, after the menu has pulled the shared
  // chain in, and the hook carries the same explicit budget its sibling does.
  //
  // P6.870, 2026-09-10 — that sentence used to say "the same explicit 120 s
  // budget", and it had ALREADY gone false: `slash-command-menu.test.tsx` moved
  // to `MODULE_GRAPH_HOOK_BUDGET_MS` (600 000) while the 120_000 stayed here, so
  // a comment asserting what a DIFFERENT file does was wrong with nothing able
  // to notice. Naming the constant instead of a number is what makes "the same
  // as its sibling" checkable rather than a claim.
  const menu = await import('../slash-command-menu')
  defaultSlashCommands = menu.DEFAULT_SLASH_COMMANDS
  permissionModeOrder = (await import('@nessy-agent/shared/agent/modes')).PERMISSION_MODE_ORDER
  helpEntries = (await import('@nessy-agent/shared/slash-commands')).SESSION_COMMAND_HELP_ENTRIES
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function menuFeatureIds(): string[] {
  const modes = new Set<string>(permissionModeOrder)
  return defaultSlashCommands.map(command => command.id).filter(id => !modes.has(id))
}

function helpMenuIds(): string[] {
  return helpEntries.map(entry => entry.id).filter((id): id is string => id !== null)
}

describe('P3.158 · the /help listing and the composer menu cannot drift', () => {
  it('reads both tables', () => {
    // Positive control: every set comparison below is vacuous if either table
    // fails to load.
    expect(defaultSlashCommands.length).toBeGreaterThan(permissionModeOrder.length)
    expect(helpEntries.length).toBeGreaterThan(0)
    expect(menuFeatureIds().length).toBeGreaterThan(0)
  })

  it('documents every command the menu offers', () => {
    const documented = new Set(helpMenuIds())
    const undocumented = menuFeatureIds().filter(id => !documented.has(id))
    expect(undocumented).toEqual([])
  })

  it('offers a menu row, or a stated reason, for every command it documents', () => {
    const offered = new Set(menuFeatureIds())
    const orphaned = helpMenuIds().filter(id => !offered.has(id))
    expect(orphaned).toEqual([])
  })

  it('names exactly the typed-only commands as the rows with no menu id', () => {
    const typedOnly = helpEntries.filter(entry => entry.id === null).map(entry => entry.label)
    expect(typedOnly.sort()).toEqual([...TYPED_ONLY_LABELS].sort())
    // And the menu really does not offer them — the claim "typed-only" needs an
    // instrument that reads the menu, not one that reads this list.
    const menuIds = new Set(defaultSlashCommands.map(command => command.id))
    expect(menuIds.has('heapdump' as never)).toBe(false)
    expect(menuIds.has('rewind' as never)).toBe(false)
    expect(menuIds.has('branch' as never)).toBe(false)
  })

  it('lists the permission modes as one line rather than seven rows', () => {
    // The per-runtime mode set is `ComposerCapabilities.permissions.modes`,
    // which the send-path seam cannot read — so enumerating the modes in the
    // listing would be an invented second spelling of a fact that already has
    // one. The line points at the picker instead.
    const helpIds = new Set(helpMenuIds())
    for (const mode of permissionModeOrder) {
      expect(helpIds.has(mode)).toBe(false)
    }
  })
})
