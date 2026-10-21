import { beforeAll, describe, expect, it } from 'bun:test'
import type { SlashCommand, SlashCommandId } from '../slash-command-menu'
import type { ModelProvider } from '@nessy-agent/shared/config/models'
import type { CustomSlashCommand } from '@nessy-agent/shared/slash-commands/common'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/*
 * P6.844 — the pdfjs carve-out that stood here is GONE. `slash-command-menu.tsx`
 * reached the `@nessy-agent/ui` BARREL for exactly one name, `Icon_Folder`, and
 * the barrel's graph ends at the Vite-only
 * `pdfjs-dist/build/pdf.worker.min.mjs?url` specifier bun cannot resolve. The
 * menu now takes that icon from `@nessy-agent/ui/icons` — a pure leaf over a
 * type-only `SVGProps` import — so the two `mock.module` stubs and the
 * `DOMMatrix` shim were replacing modules this file no longer loads.
 *
 * The imports below stay DYNAMIC, and the reason has CHANGED: it is no longer
 * "the stubs must be registered first" (there are no stubs) but the module-graph
 * budget and heartbeat this file documents next — those price a cost the carve-out
 * did not cause and its removal does not remove.
 */

let defaultSlashCommands: SlashCommand[]
let buildPermissionModeCommands: typeof import('../slash-command-menu').buildPermissionModeCommands
let getTranslatedCommandDescription: typeof import('../slash-command-menu').getTranslatedCommandDescription
let filterCommandsByCapability: typeof import('../slash-command-menu').filterCommandsByCapability
// UB14.21 — the rendered menus, through the same dynamic import.
let InlineSlashCommand: typeof import('../slash-command-menu').InlineSlashCommand
let SlashCommandMenu: typeof import('../slash-command-menu').SlashCommandMenu
let PermissionModeIcon: typeof import('../slash-command-menu').PermissionModeIcon
let renderToStaticMarkup: typeof import('react-dom/server').renderToStaticMarkup
let PERMISSION_MODE_CONFIG: typeof import('@nessy-agent/shared/agent/modes').PERMISSION_MODE_CONFIG

// The enumeration's collaborators. DYNAMIC, like the menu module itself, and
// P6.844 replaced the reason: it used to be that this file's `mock.module` stubs
// only took effect for modules loaded AFTER them while ESM hoists every static
// import above every statement. The stubs are gone; what remains is the
// module-graph budget below, which is the cost these imports are bounded by.
let AGENT_PROVIDERS: readonly ModelProvider[]
let resolveComposerCapabilities: typeof import('@nessy-agent/shared/agent/backend/composer-capabilities').resolveComposerCapabilities
let runtimeDispatchesWorkflows: typeof import('@nessy-agent/shared/agent/runtime-agent-support').runtimeDispatchesWorkflows
let runtimeForksConversations: typeof import('@nessy-agent/shared/agent/runtime-agent-support').runtimeForksConversations
let workflowSlashCommandId: typeof import('@nessy-agent/shared/slash-commands/custom-commands').workflowSlashCommandId
let pluginWorkflowCommandId: typeof import('@nessy-agent/shared/slash-commands/custom-commands').pluginWorkflowCommandId
let dispatchSlashCommandAction: typeof import('@/components/app-shell/input/slash-command-actions').dispatchSlashCommandAction
let resolveComposerPermissionModeList: typeof import('@/lib/composer-permission-modes').resolveComposerPermissionModeList

/**
 * P6.730 · The budget, and why it is not the 120 s it used to be.
 *
 * This hook is a module-graph budget of the family the known-failing register
 * (`docs/superpowers/specs/2026-07-29-known-failing-tests.md`, §"three more
 * module-graph budgets") calls the TIMER LOTTERY: the wall time
 * is decided by page-cache luck rather than by load, and the CPU is invariant.
 * Every reading below was taken on 2026-09-07, sequentially, alone, on one
 * file, with `user`/`sys` from zsh's `time` and the load from `uptime`:
 *
 * - the ZERO-CASE CONTROL (`bun test <file> -t 'zzz-no-such-case-W8tail3'`,
 *   which prices the module graph with no case and no hook running) —
 *   41.83 s at load 12.14, 0.51 s user / 0.30 s sys, 1 % of wall in CPU. So
 *   ~42 s of this file is paid before the hook's first import, and it is I/O,
 *   not contention;
 * - the file at HEAD with the old 120 000 — `(fail) (unnamed)`, the hook
 *   abandoned at 137.4 s (bun overshoots its own budget) inside a 213.26 s
 *   run at load 10.15, 0.94 s / 0.59 s, under 1 % CPU. That 137.4 s is the
 *   measured hook CEILING this constant is sized against;
 * - with this constant: 12 pass / 0 fail in 81.59 s at load 11.55 (1.09 s /
 *   0.68 s, 2 %), 48.21 s at load 10.93 (1.06 s / 0.61 s, 3 %) and 32.88 s at
 *   load 17.40 (1.06 s / 0.63 s, 5 %) — fastest at the HIGHEST load, which is
 *   the backwards-against-load signature the register records for this family,
 *   and the reason a budget here may not be sized off one lucky run.
 *
 * 600 000 is the register's own prescribed remedy for this family and the
 * constant its `monitor-command-gate.test.ts` member carries; against a
 * 137.4 s ceiling that is ~4x headroom for a family measured swinging 100x+
 * on byte-identical work. Sized against THIS file's largest observed hook,
 * never a neighbour's constant: `context-usage-after-switch.test.ts` next
 * door uses 120 000 against a 44.7 s floor, and copying that number is what
 * left this hook red — with three rows (`/mcp`, `/diff`, `/hooks`) shipping
 * inert behind its unnamed failure.
 */
// P6.638 — the budget is the SHARED one now; the reasoning above is this
// file's own measurement and stays. The constant's docblock carries the
// sizing rule and the zero-case-control recipe for whoever sizes the next
// one, so a seventh suite does not rediscover them a seventh time.

/** Cadence of the heartbeat that names the import a timeout would not. */
const IMPORT_HEARTBEAT_MS = 30_000

/**
 * P6.730 · Names the import in flight, so a hook timeout names its row.
 *
 * bun reports a timed-out lifecycle hook as `(fail) (unnamed)` with "a
 * beforeEach/afterEach hook timed out" — no test name, no import name, and
 * `beforeEach/afterEach` is bun's wording for the whole family including this
 * `beforeAll`. Three rows shipped inert behind exactly that message. The
 * heartbeat keeps ticking after the hook is abandoned, so the last lines on
 * stderr name the import that was still pending; a fast run prints nothing,
 * because every step is then far below the cadence.
 *
 * Live positive control, from the second of the three green readings above:
 * `[slash-command-menu] still importing ../slash-command-menu after 43s` —
 * one import, named, in a run that then passed 12 of 12. Under the old
 * constant that same 43 s import was the whole of the unnamed failure.
 */
async function loadStep<T>(name: string, load: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
    process.stderr.write(`[slash-command-menu] still importing ${name} after ${elapsedSeconds}s\n`)
  }, IMPORT_HEARTBEAT_MS)
  ;(heartbeat as { unref?: () => void }).unref?.()
  try {
    return await load()
  } finally {
    clearInterval(heartbeat)
  }
}

beforeAll(async () => {
  // THE MENU MODULE FIRST, and the order is load-bearing — measured, not
  // stylistic. Importing any `@nessy-agent/shared/*` subpath BEFORE
  // `../slash-command-menu` makes that import cost ~42s instead of ~0.6s
  // (probed both ways, repeated runs), which surfaces as a hung `beforeAll`
  // rather than as slowness. Everything below is then free: the menu module has
  // already pulled the shared chain in.
  const mod = await loadStep('../slash-command-menu', () => import('../slash-command-menu'))
  defaultSlashCommands = mod.DEFAULT_SLASH_COMMANDS
  buildPermissionModeCommands = mod.buildPermissionModeCommands
  getTranslatedCommandDescription = mod.getTranslatedCommandDescription
  filterCommandsByCapability = mod.filterCommandsByCapability
  InlineSlashCommand = mod.InlineSlashCommand
  SlashCommandMenu = mod.SlashCommandMenu
  PermissionModeIcon = mod.PermissionModeIcon
  renderToStaticMarkup = (await loadStep('react-dom/server', () => import('react-dom/server'))).renderToStaticMarkup
  PERMISSION_MODE_CONFIG = (await loadStep(
    '@nessy-agent/shared/agent/modes',
    () => import('@nessy-agent/shared/agent/modes'),
  )).PERMISSION_MODE_CONFIG

  const vocabulary = await loadStep(
    '@nessy-agent/shared/agent/backend/runtime-vocabulary',
    () => import('@nessy-agent/shared/agent/backend/runtime-vocabulary'),
  )
  AGENT_PROVIDERS = vocabulary.AGENT_PROVIDERS as readonly ModelProvider[]
  resolveComposerCapabilities = (await loadStep(
    '@nessy-agent/shared/agent/backend/composer-capabilities',
    () => import('@nessy-agent/shared/agent/backend/composer-capabilities'),
  )).resolveComposerCapabilities
  const runtimeSupport = await loadStep(
    '@nessy-agent/shared/agent/runtime-agent-support',
    () => import('@nessy-agent/shared/agent/runtime-agent-support'),
  )
  runtimeDispatchesWorkflows = runtimeSupport.runtimeDispatchesWorkflows
  runtimeForksConversations = runtimeSupport.runtimeForksConversations
  const customCommands = await loadStep(
    '@nessy-agent/shared/slash-commands/custom-commands',
    () => import('@nessy-agent/shared/slash-commands/custom-commands'),
  )
  workflowSlashCommandId = customCommands.workflowSlashCommandId
  pluginWorkflowCommandId = customCommands.pluginWorkflowCommandId
  dispatchSlashCommandAction = (await loadStep(
    '@/components/app-shell/input/slash-command-actions',
    () => import('@/components/app-shell/input/slash-command-actions'),
  )).dispatchSlashCommandAction
  resolveComposerPermissionModeList = (await loadStep(
    '@/lib/composer-permission-modes',
    () => import('@/lib/composer-permission-modes'),
  )).resolveComposerPermissionModeList
}, MODULE_GRAPH_HOOK_BUDGET_MS)

describe('DEFAULT_SLASH_COMMANDS', () => {
  it('includes built-in model, clear, and help commands', () => {
    const commandIds = defaultSlashCommands.map(command => command.id)

    expect(commandIds).toContain('model')
    expect(commandIds).toContain('clear')
    expect(commandIds).toContain('help')
  })

  it('includes the C2 create-skill and create-plugin creator macros', () => {
    const commandIds = defaultSlashCommands.map(command => command.id)

    expect(commandIds).toContain('create-skill')
    expect(commandIds).toContain('create-plugin')
  })

  /**
   * P4.5 · `/advisor` was answerable from the day P2.1 shipped and appeared in
   * no menu — P2.1's ledger recorded it as "absent from the renderer slash
   * menu → owed to P4.5". Two halves, and the second is the one P2.490 showed a
   * locale gate cannot catch: a `commands.advisor.*` key added to BOTH locales
   * in SORTED position passes `lint:i18n:parity` AND `lint:i18n:sorted` while
   * nothing reads it. Membership in TRANSLATED_COMMAND_IDS is what makes the
   * key live, so it is asserted here rather than assumed.
   */
  it('offers /advisor and resolves its label and description from i18n', () => {
    const command = defaultSlashCommands.find(candidate => candidate.id === 'advisor')
    expect(command).toBeDefined()
    expect(command!.label).toBeTruthy()
    expect(command!.description).toBeTruthy()

    const seen: string[] = []
    const t = ((key: string, fallback?: string) => {
      seen.push(key)
      return `translated:${fallback ?? key}`
    }) as unknown as Parameters<typeof getTranslatedCommandDescription>[1]

    expect(getTranslatedCommandDescription(command!, t)).toBe(`translated:${command!.description}`)
    expect(seen).toEqual(['commands.advisor.description'])
  })

  // F1.1052 — the menu's own mode rows (the fallback the compact badge's dropdown
  // renders when no session list is passed) are the picker's: Claude Desktop's
  // order, the hidden `dontAsk` absent, Manual's label from the locale.
  it('F1.1052: its mode rows are the picker\'s five, in Claude Desktop\'s order, with no dontAsk', () => {
    const modeIds = defaultSlashCommands
      .map(command => command.id)
      .filter(id => ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'].includes(id))
    expect(modeIds).toEqual(['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'])
    expect(defaultSlashCommands.find(command => command.id === 'default')?.label).toBe('Manual')
  })

  it('F1.1052 BOUNDARY: a session list that names dontAsk is still rendered as given (the host decides that list)', () => {
    const rows = buildPermissionModeCommands([
      { mode: 'dontAsk', label: "Don't ask", shortLabel: "Don't ask", description: 'x', iconMode: 'dontAsk' },
    ])
    expect(rows.map(row => [row.id, row.label])).toEqual([['dontAsk', "Don't ask"]])
  })

  it('gives the creator macros an English label + description fallback', () => {
    // The menu resolves labels via t(`commands.${id}.label`, command.label) for
    // ids in TRANSLATED_COMMAND_IDS; the SlashCommand definition supplies the
    // English fallback. (The commands.create-*.label/description i18n keys are
    // gated by lint:i18n:parity + lint:i18n:sorted.)
    for (const id of ['create-skill', 'create-plugin']) {
      const command = defaultSlashCommands.find(candidate => candidate.id === id)
      expect(command).toBeDefined()
      expect(command!.label).toBeTruthy()
      expect(command!.description).toBeTruthy()
    }
  })
})

/**
 * R15 — the slash menu is the SECOND surface inside a session, and it used to
 * throw the resolved description away.
 *
 * `FreeFormInput` passes `permissionModeDisplays` down, `buildPermissionModeCommands`
 * copies each `display.description` onto the command, and
 * `getTranslatedCommandDescription` — the function `CommandItemContent` renders
 * through — re-resolved every mode id from
 * `PERMISSION_MODE_FULL_DESCRIPTION_KEYS`, discarding it. Without the fix, the
 * picker and the slash menu would say different things about the same mode in
 * the same codex session, which is the one outcome R15 must not ship.
 */
describe('R15 — a resolved mode description survives the slash menu', () => {
  /** The renderer's `t`: returns the key, so a re-resolve is visible as the key. */
  const t = ((key: string, fallback?: string) => key ?? fallback) as never

  it('keeps the runtime-aware description a display carried in', () => {
    const [command] = buildPermissionModeCommands([{
      mode: 'plan',
      label: 'Plan',
      shortLabel: 'Plan',
      description: 'Read-only planning. On Codex the runtime decides what to ask you about.',
      iconMode: 'plan',
    }])

    expect(command!.descriptionResolved).toBe(true)
    expect(getTranslatedCommandDescription(command!, t))
      .toBe('Read-only planning. On Codex the runtime decides what to ask you about.')
  })

  it('THE NEGATIVE CONTROL — an unflagged mode command is still re-resolved from its key', () => {
    // The before-state, and the reason `descriptionResolved` is a flag rather
    // than "mode commands are never re-resolved": DEFAULT_SLASH_COMMANDS' mode
    // rows carry English literals that MUST follow the user's language, so the
    // re-resolve is correct for them and wrong only for a display-built row.
    const [command] = buildPermissionModeCommands([{
      mode: 'plan',
      label: 'Plan',
      shortLabel: 'Plan',
      description: 'Read-only planning. On Codex the runtime decides what to ask you about.',
      iconMode: 'plan',
    }])
    const unflagged = { ...command!, descriptionResolved: undefined }

    expect(getTranslatedCommandDescription(unflagged, t)).toBe('mode.planFullDesc')
  })

  it('the no-displays fallback is unflagged, so it keeps following the language', () => {
    for (const command of buildPermissionModeCommands()) {
      expect(command.descriptionResolved, command.id).toBeUndefined()
      expect(getTranslatedCommandDescription(command, t), command.id)
        .toBe(`mode.${command.id}FullDesc`)
    }
  })
})

/**
 * P3.71 / P2.279 — THE ENUMERATION. Offered vs dispatchable, every menu row,
 * every runtime.
 *
 * Both rows were found incidentally, by lanes doing something else, and both are
 * the capability ledger's `ADVERTISED` anti-pattern: *the surface keeps offering
 * what the target cannot do.* Two instances found by accident is a sampling
 * result, not a bound — so this row stops sampling and enumerates.
 *
 * The instrument is deliberately the MENU, not the seam. `filterCommandsByCapability`
 * is what `useInlineSlashCommand` builds its sections from, so what it returns
 * IS what the user is offered; `dispatchSlashCommandAction` is the renderer's
 * own independent answer to "may this row run". The two are computed at
 * different sites from the same `ComposerCapabilities`, so the equality below is
 * a drift check rather than a restatement — and nothing here transcribes a list
 * of which command is available where.
 *
 * The custom families get a second assertion because `dispatchSlashCommandAction`
 * is not their seam: a custom id is routed by `submitCustomSlashCommand` one line
 * earlier in `FreeFormInput.handleSlashCommand`, and the thing that would refuse
 * a workflow recipe is `BaseAgent.chat`'s `workflowInvocation` gate. So an
 * offered workflow row is checked against `runtimeDispatchesWorkflows`, the same
 * predicate that gate is tied to.
 */
describe('P3.71 · every offered menu row is a row its seam will accept', () => {
  // Everything below is resolved LAZILY: the collaborators land in `beforeAll`,
  // which runs after this describe body.
  //
  // The vocabulary is imported rather than restated — `runtime-vocabulary.ts` is
  // the one source, so a fifth runtime enters this sweep by itself.
  const providers = (): readonly ModelProvider[] => AGENT_PROVIDERS

  /**
   * A saved workflow recipe and a plugin's, as the menu receives them: ids minted
   * by the id builders themselves, so a renamed prefix breaks this rather than
   * quietly passing.
   */
  const workflowRows = (): CustomSlashCommand[] => [
    { id: workflowSlashCommandId('ship'), name: 'ship', label: '/ship' },
    { id: pluginWorkflowCommandId('acme', 'release'), name: 'release', label: '/acme:release' },
  ]

  /** The renderer's `t`, as the other describes here use it. */
  const t = ((key: string, fallback?: string) => key ?? fallback) as never

  /**
   * Every row the composer can offer on a session, assembled the way
   * `useInlineSlashCommand` assembles its sections — mode rows from
   * `resolveComposerPermissionModeList` (NOT `DEFAULT_SLASH_COMMANDS`'
   * unfiltered fallback, which the remote agent narrows to two), the feature
   * rows, and the two custom families.
   *
   * Getting this wrong is the failure mode the rig itself has to avoid: built
   * from `DEFAULT_SLASH_COMMANDS` this reported five phantom mode rows on the
   * remote agent, which is a detector wrong in the direction that manufactures
   * findings.
   */
  const allMenuRows = (caps: ReturnType<typeof resolveComposerCapabilities>): SlashCommand[] => [
    ...buildPermissionModeCommands(resolveComposerPermissionModeList(caps, t).modes),
    ...defaultSlashCommands.filter(command => !modeIds().includes(command.id)),
    ...workflowRows().map(command => ({
      id: command.id,
      label: command.label,
      description: command.label,
      icon: null,
      customCommand: command,
    } as SlashCommand)),
  ]

  /** The permission-mode ids, taken from the builder rather than restated. */
  const modeIds = (): string[] => buildPermissionModeCommands().map(command => command.id)

  const offeredIds = (provider: ModelProvider): string[] => {
    const caps = resolveComposerCapabilities({ provider })
    return filterCommandsByCapability(
      allMenuRows(caps),
      caps.slash.commandIds,
      caps.slash.excludedCommandIds,
      caps.slash.excludedCommandIdPrefixes,
    ).map(command => command.id)
  }

  /**
   * The renderer's own verdict on a BUILT-IN row, with every handler supplied and
   * `isProcessing: false` — so a `false` here is the capability gate refusing,
   * never a missing handler or a mid-turn block.
   */
  const dispatches = (provider: ModelProvider, commandId: SlashCommandId): boolean => {
    const caps = resolveComposerCapabilities({ provider })
    return dispatchSlashCommandAction(commandId, {
      isProcessing: false,
      allowedCommandIds: caps.slash.commandIds,
      excludedCommandIds: caps.slash.excludedCommandIds,
      excludedCommandIdPrefixes: caps.slash.excludedCommandIdPrefixes,
      contextUsageCapability: caps.contextUsage,
      // `visiblePermissionModes` in production — the same list the mode rows
      // are built from, so the two sides of this comparison stay one decision.
      allowedPermissionModes: resolveComposerPermissionModeList(caps, t).modes.map(display => display.mode),
      onPermissionModeChange: () => {},
      openAgents: () => {},
      openAutomations: () => {},
      openContext: () => {},
      openExport: () => {},
      openModelSelector: () => {},
      openMemory: () => {},
      openUsage: () => {},
      openSideQuestionOverlay: () => {},
      requestRecap: () => {},
      submitCommand: () => {},
      prefillCommand: () => {},
    })
  }

  const isWorkflowRow = (id: string): boolean =>
    workflowRows().some(command => command.id === id)

  it('THE POSITIVE CONTROL — the instrument reads the menu, and a working row survives it', () => {
    // An absence finding needs a positive control on the same rig. `/model`
    // opens a renderer panel and is refused by nothing, so it must be offered
    // AND dispatchable on all four runtimes; if the filter were returning an
    // empty list — the way this whole test could pass by vacuum — this fails.
    for (const provider of providers()) {
      expect(offeredIds(provider), provider).toContain('model')
      expect(dispatches(provider, 'model'), provider).toBe(true)
      expect(offeredIds(provider).length, provider).toBeGreaterThan(10)
    }
    // …and the menu really does carry the two families before any gate runs.
    for (const row of workflowRows()) expect(offeredIds('pi')).toContain(row.id)
  })

  it('no BUILT-IN row is offered on a runtime whose dispatcher refuses it', () => {
    for (const provider of providers()) {
      const offered = offeredIds(provider).filter(id => !isWorkflowRow(id))
      const refused = offered.filter(id => !dispatches(provider, id as SlashCommandId))
      expect(refused, `${provider} offers rows its dispatcher refuses`).toEqual([])
    }
  })

  it('no row whose seam is SERVER-side is offered where that seam refuses', () => {
    // The rows `dispatchSlashCommandAction` cannot speak for. `/subtask` and a
    // workflow recipe are both refused by `BaseAgent.chat`, not by the renderer,
    // so the drift check above is structurally blind to them — which is exactly
    // how both shipped. Each is compared against the shared predicate its own
    // refusal reads, never against a transcribed membership list.
    const seamAccepts: Array<[string, (provider: ModelProvider) => boolean]> = [
      ...workflowRows().map(row =>
        [row.id, runtimeDispatchesWorkflows] as [string, (provider: ModelProvider) => boolean]),
      ['subtask', runtimeForksConversations],
    ]
    for (const provider of providers()) {
      const offered = offeredIds(provider)
      for (const [id, accepts] of seamAccepts) {
        expect(offered.includes(id), `${provider}/${id}`).toBe(accepts(provider))
      }
    }
    // Both answers occur for every row, so each is a partition and not a constant.
    for (const [id] of seamAccepts) {
      expect(providers().some(provider => offeredIds(provider).includes(id)), id).toBe(true)
      expect(providers().some(provider => !offeredIds(provider).includes(id)), id).toBe(true)
    }
  })

  it('UB14.21 control — /approve is still withdrawn off codex after the caret-menu merge', () => {
    // The look merge must leave the per-runtime data alone: `resolveExcludedCommandIds`
    // withdraws `/approve` everywhere but codex (P2.217).
    expect(offeredIds('codex-runtime')).toContain('approve')
    for (const provider of providers().filter(provider => provider !== 'codex-runtime')) {
      expect(offeredIds(provider), provider).not.toContain('approve')
    }
  })

  it('the three known instances are each closed, and named', () => {
    // P3.71 — `/subtask` needs `subtask_start`, which is Pi's alone.
    expect(offeredIds('pi')).toContain('subtask')
    for (const provider of ['anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      expect(offeredIds(provider), provider).not.toContain('subtask')
    }
    // P2.279 — a saved recipe runs in the Pi orchestrator's `workflow` tool.
    expect(offeredIds('codex-runtime')).not.toContain(workflowSlashCommandId('ship'))
    // Found by this enumeration: the remote agent DECLARES `compact.manual:
    // false` and the dispatcher obeyed it, so the row was listed and picking it
    // did nothing at all — the same lie, and quieter than the other two.
    expect(offeredIds('nestor-cloud-agent')).not.toContain('compact')
    expect(offeredIds('codex-runtime')).toContain('compact')
  })

  it('the gate withdraws rows rather than emptying the menu', () => {
    // The failure mode of an over-broad prefix or an over-eager exclusion: every
    // runtime must keep most of the menu, and no two runtimes may end up with
    // identical offerings by everything collapsing to a common floor.
    const perProvider = providers().map(provider => offeredIds(provider))
    for (const [index, offered] of perProvider.entries()) {
      expect(offered.length, providers()[index]).toBeGreaterThan(10)
    }
    expect(new Set(perProvider.map(ids => ids.slice().sort().join(','))).size).toBeGreaterThan(1)
  })
})

/**
 * UB14.21 — the caret menus on upstream v0.15.0's floating material
 * (`inline-menu-styles.ts`): `popover-styled` (radius 12 + elev-2) growing from
 * the caret's corner, in place of the radius that followed the composer's own
 * (R6-05's logged decision). Rendered, not read: no DOM ships here, so the
 * inline menu renders in place of its portal.
 */
describe('UB14.21 — the caret menus wear the floating menu material', () => {
  const commandRow = (): SlashCommand => defaultSlashCommands.find(command => command.id === 'model')!

  /** The class list of the element carrying `data-inline-menu`. */
  const inlineContainerClasses = (html: string): string[] => {
    const tag = html.match(/<div[^>]*data-inline-menu[^>]*>/)?.[0] ?? ''
    expect(tag).not.toBe('')
    return (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(' ')
  }

  it('positive — the open InlineSlashCommand container carries popover-styled and origin-bottom-left', () => {
    const html = renderToStaticMarkup(
      <InlineSlashCommand
        open
        onOpenChange={() => {}}
        sections={[{ id: 'commands', label: 'Commands', items: [commandRow()] }]}
        onSelectCommand={() => {}}
        onSelectFolder={() => {}}
        position={{ x: 0, y: 0 }}
      />,
    )
    const classes = inlineContainerClasses(html)
    expect(classes).toContain('popover-styled')
    expect(classes).toContain('origin-bottom-left')
    expect(classes).toContain('fixed')
    // Our list cap (Keep) wins over upstream's 260px through the token-aware cn.
    expect(html).toContain('max-h-[40dvh]')
    expect(html).not.toContain('max-h-[260px]')
  })

  it('negative — the composer-radius coupling and the old ad-hoc material are gone from the container', () => {
    const html = renderToStaticMarkup(
      <InlineSlashCommand
        open
        onOpenChange={() => {}}
        sections={[{ id: 'commands', label: 'Commands', items: [commandRow()] }]}
        onSelectCommand={() => {}}
        onSelectFolder={() => {}}
        position={{ x: 0, y: 0 }}
      />,
    )
    const classes = inlineContainerClasses(html).join(' ')
    expect(classes).not.toContain('composer-radius')
    expect(classes).not.toContain('shadow-modal-small')
    expect(classes).not.toContain('bg-background')
  })

  it('PermissionModeIcon is exported, draws the mode glyph, and falls back to default for an unknown mode', () => {
    const plan = renderToStaticMarkup(<PermissionModeIcon mode="plan" className="size-4" />)
    expect(plan).toContain('class="size-4"')
    expect(plan).toContain(`d="${PERMISSION_MODE_CONFIG.plan.svgPath}"`)
    const unknown = renderToStaticMarkup(<PermissionModeIcon mode={'nope' as never} />)
    expect(unknown).toContain(`d="${PERMISSION_MODE_CONFIG.default.svgPath}"`)
  })

  it('SlashCommandMenu: bare drops the material, footer renders under the list, the cmdk root is labelled', () => {
    const standalone = renderToStaticMarkup(
      <SlashCommandMenu commands={[commandRow()]} onSelect={() => {}} footer="Shift+Tab" />,
    )
    expect(standalone).toContain('popover-styled')
    // the footer is the hint row under the list, after a hairline
    expect(standalone).toContain('<div class="bg-separator h-px"></div><div class="flex items-center gap-2 px-3 py-2 text-label-sm text-tertiary select-none">Shift+Tab</div></div>')
    // cmdk's visually-hidden root label (upstream's `label`), whatever language the t() resolves to
    expect(standalone).toMatch(/<label cmdk-label=""[^>]*>[^<]+<\/label>/)
    const bare = renderToStaticMarkup(<SlashCommandMenu commands={[commandRow()]} onSelect={() => {}} bare />)
    expect(bare).not.toContain('popover-styled')
    expect(bare).toContain('min-w-[220px]')
    // control: no footer prop, no footer row
    expect(bare).not.toContain('px-3 py-2 text-label-sm text-tertiary')
    expect(bare).not.toContain('bg-separator h-px')
  })
})
