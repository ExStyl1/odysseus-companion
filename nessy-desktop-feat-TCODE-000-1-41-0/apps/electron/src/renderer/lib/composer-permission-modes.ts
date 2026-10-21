import type { ComposerCapabilities, ComposerPermissionModeOption } from '@nessy-agent/shared/protocol'
import type { ModelProvider } from '@config/models'
import {
  DEFAULT_CYCLABLE_PERMISSION_MODES,
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from '@nessy-agent/shared/agent/modes'

type Translate = (key: string) => string

/**
 * Resolve a workspace's `cyclablePermissionModes` config into the SHIFT+TAB
 * cycle, which since P2.56 is the PICKER's list too.
 *
 * A workspace without the setting (pre-migration workspaces never wrote one)
 * gets DEFAULT_CYCLABLE_PERMISSION_MODES — every mode but `dontAsk`, which
 * every picker hides anyway (`PICKER_HIDDEN_MODES`). `bypassPermissions` is IN
 * that default since D1.369 (owner, 2026-09-18: it must be offered rather than
 * hidden); the enablement permission-modes.md spells as a launch flag is the
 * first-activation responsibility dialog here, which every entry point still
 * passes through. A workspace list may still leave it out, and a degenerate
 * list (< 2 modes) cannot cycle and takes the default too.
 */
export function resolveWorkspaceCyclablePermissionModes(
  cyclablePermissionModes?: PermissionMode[],
): PermissionMode[] {
  return cyclablePermissionModes && cyclablePermissionModes.length >= 2
    ? cyclablePermissionModes
    : DEFAULT_CYCLABLE_PERMISSION_MODES
}

/**
 * What Workspace Settings → Permissions SHOWS as the workspace's default mode.
 *
 * Three tiers, and only the first is the workspace's own: its configured
 * `permissionMode`; then the host-supplied
 * `WorkspaceSettings.effectiveDefaultPermissionMode`, which is the tail of the
 * chain `createSession` resolves for a workspace that has never set one; then
 * `'default'`, which survives ONLY for the case where the settings load failed
 * or returned null and the page knows nothing at all.
 *
 * P4.8 — the page used to seed and fall back to `'default'` outright, so an
 * unconfigured workspace displayed **Manual** while its sessions started in
 * **Auto** (`config-defaults.json` has said `auto` since P0.2 flipped it on
 * 2026-08-14). The direction is the point: the label CLAIMED LESS AUTONOMY
 * than the product was granting. Before that flip the same bug erred the other
 * way and was on the safe side, which is why it survived review then.
 *
 * A function here rather than a `??` chain in the page, for
 * {@link resolveWorkspaceCyclablePermissionModes}'s reason: the page is a
 * 589-line component no unit test mounts, and a precedence rule that cannot be
 * tested is a precedence rule that drifts.
 */
export function resolveWorkspaceDefaultPermissionMode(
  configured?: PermissionMode,
  effectiveDefault?: PermissionMode,
): PermissionMode {
  return configured ?? effectiveDefault ?? 'default'
}

/** What the workspace default-mode control shows, and whether it still decides. */
export interface WorkspaceDefaultModeDisplay {
  /** The mode a new session in this workspace will actually start in. */
  mode: PermissionMode
  /**
   * A managed policy decides it, so the control below is INERT: a value written
   * there is stored and then outranked, and no session ever reads it.
   */
  managed: boolean
}

/**
 * The same question as {@link resolveWorkspaceDefaultPermissionMode}, with the
 * tier that outranks all three of its own — P2.489.
 *
 * ## The defect
 *
 * `createSession` resolves `managedPiPolicy.defaultMode ??
 * wsConfig?.defaults?.permissionMode ?? globalDefaults.workspaceDefaults.permissionMode`.
 * P4.8 made the control honest about the LAST of those and left the FIRST out,
 * deliberately and with the reason written into
 * `WorkspaceSettings.effectiveDefaultPermissionMode`'s own docblock: on an
 * install that sets a managed mode, the control writes a value no session will
 * ever read, and the user gets no indication whatever. A policy the user
 * experiences as a malfunction — the same shape as P2.464's missing managed
 * indicator and P2.429's indistinguishable refusal.
 *
 * ## The fix is entirely in what the control SAYS
 *
 * The managed tier outranking a user setting is correct and deliberate, so this
 * does not re-rank anything and does not widen the workspace field's precedence.
 * It reports. The shape is the one the app already ships for the same situation
 * one page over: retention's window is `disabled` with
 * `settings.retention.managed` beneath it when a policy sets it. Same shape
 * here, so a user meets managed overrides as one recognisable thing rather than
 * as two unrelated behaviours.
 *
 * ## Fail-open on absence, and why that is the safe direction here
 *
 * `undefined` means "no managed mode" — not "unknown" — because the field is
 * absent from the payload on every unmanaged install and on any main process
 * older than this. Treating absence as managed would disable the control for
 * everyone; treating it as unmanaged leaves the pre-P2.489 behaviour exactly as
 * it was, which is the strictly smaller error and the only one that is
 * recoverable by the user.
 */
export function resolveWorkspaceDefaultModeDisplay(
  configured?: PermissionMode,
  effectiveDefault?: PermissionMode,
  managed?: PermissionMode,
): WorkspaceDefaultModeDisplay {
  if (managed) return { mode: managed, managed: true }
  return { mode: resolveWorkspaceDefaultPermissionMode(configured, effectiveDefault), managed: false }
}

/**
 * The i18n key for each mode's full description. The composer, the slash-command
 * menu, workspace settings, and the playground all read THIS map — it is the
 * single spelling of the mode-description key family.
 *
 * R15 — THESE SEVEN STRINGS STATE INTENT, NOT ENFORCEMENT, and the distinction
 * is load-bearing rather than stylistic. They render on TWO surfaces with
 * different information available:
 *
 * - the composer's picker and the slash menu, inside a session, where
 *   `ComposerCapabilities.connection.activeRuntime` says which runtime is under
 *   the mode ({@link RUNTIME_PERMISSION_MODE_CLAUSE_KEYS} adds the mode-specific
 *   part of what it enforces, {@link RUNTIME_PERMISSION_MODE_FOOTER_KEYS} the
 *   shared part);
 * - Workspace Settings → Permissions, which renders all seven from
 *   `PERMISSION_MODE_ORDER` for a WORKSPACE. A workspace has no runtime — its
 *   sessions can run on any of the three and switch mid-session — so there is
 *   nothing there to be runtime-aware about.
 *
 * Because one string has to serve both, it may not carry a guarantee that only
 * some runtimes keep. Three of them used to: `explore` said "never prompts",
 * `bypassPermissions` said "no prompts", and `plan` said "produce a plan" where
 * codex advertises no `SubmitPlan` at all. Those absolutes are gone, and the
 * per-runtime facts moved to the clause/footer tables below, where a runtime is
 * known. `dontAsk` KEPT "denies everything else" on purpose: codex's residual
 * there is a bounded EXCEPTION its clause states ("Codex still runs its own
 * reads"), not a flat negation of the sentence.
 *
 * **THEY ARE ALSO SIZED, since 2026-08-17.** Every one of them has to fit ONE
 * rendered line in the composer's picker, whose description column is 440 CSS px
 * at `text-xs` — and Russian runs 20–100% longer than English, so ru is the
 * binding constraint, not en. `explore`, `plan`, `acceptEdits` and `auto` were
 * shortened for that (ru `auto` was 736px of text, on its own nearly two lines
 * wide). `dontAsk` is exempt: it is picker-hidden, and Workspace Settings — the
 * only surface that renders it — is a wide settings row that has always wrapped.
 * A copy edit that lengthens one of these is a layout change; measure it.
 */
export const PERMISSION_MODE_FULL_DESCRIPTION_KEYS: Record<PermissionMode, string> = {
  dontAsk: 'mode.dontAskFullDesc',
  // F1.1050: no `explore` entry — the mode is retired (F1.1052 removed its locale keys and its codex clause key).
  plan: 'mode.planFullDesc',
  default: 'mode.defaultFullDesc',
  acceptEdits: 'mode.acceptEditsFullDesc',
  auto: 'mode.autoFullDesc',
  bypassPermissions: 'mode.bypassPermissionsFullDesc',
}

/**
 * What the ACTIVE runtime can actually enforce of a mode — R15, narrowed
 * 2026-08-17 to the part that is genuinely MODE-specific.
 *
 * The shared half moved out. This table used to name a note for all six picker
 * modes, and four of those six were the SAME sentence — the picker then printed
 * one fact about the runtime six times, three or four lines per row, and
 * measured 564px tall against 384px on Pi. That sentence is now stated once, as
 * the menu's footer, from {@link RUNTIME_PERMISSION_MODE_FOOTER_KEYS}. What
 * stays here is only what changes from mode to mode, as a SHORT clause the
 * general string can carry on one line.
 *
 * One entry per (runtime, mode) that needs one; absent means the general string
 * plus the footer already tell the whole truth there. Only `codex-runtime` has
 * entries today, and that is a measurement rather than an omission:
 *
 * - **Pi** — the vocabulary is Pi's and `core/pre-tool-use.ts` IS the
 *   translation, so the general string is Pi's own behaviour.
 * - **Claude (`anthropic`)** — the same gate runs as the SDK's `PreToolUse`
 *   hook, so Nessy still sees every call before it runs.
 * - **Codex** — **nothing of ours sees the call FIRST; everything codex raises
 *   is checked before it runs.** This bullet read *"nothing of ours sees the
 *   call first. Measured 2026-08-16: `grep -ac runPreToolUseChecks … → 0
 *   (control: `consultPermissionRules` → 2)"* until P6.69 (2026-09-06), two
 *   landed measurements after the second half stopped being true, and the
 *   sentence it decided — the one a user reads in the picker — over-stated the
 *   gap by the whole safety floor.
 *
 *   What is still true: there is no PRE-tool gate on this runtime.
 *   `runPreToolUseChecks` has zero call sites in `codex-agent.ts` — a claim
 *   deliberately not written as a grep COUNT, because at HEAD that count is 1
 *   and the one hit is a comment saying the call sites are zero, so a count pin
 *   here reads as a regression and a bare `→ 0` reads as a lie.
 *
 *   What is no longer true: that nothing of ours runs at all. P2.140 extracted
 *   the non-negotiable floors into `core/pre-tool-use.ts` and P2.197 made
 *   `untrusted` raise the calls — narrowed by P7.2, since `rust-v0.150.1`
 *   retired that policy and no remaining one raises an unmatched command with
 *   the sandbox off — so `CodexAgent.floorVerdict` puts every subject
 *   of every raised approval through the SAME `findNonNegotiableFloors` /
 *   `firstNonNegotiableFloor` pair that stops the same command on Pi and Claude,
 *   `CodexAgent`'s `getDeniedPathViolation` route refuses a denied credential
 *   path on its own (P6.62), and `consultPermissionRules` answers from the
 *   user's own rules. Since P6.61 that holds in `bypassPermissions` too:
 *   `CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED` is EMPTY, so every mode reaches
 *   the SAME unbounded configuration. Which one moved at `rust-v0.150.1`: it was
 *   `untrusted`, whose schema text auto-approved only "known safe" commands
 *   "that **only read files**", and upstream retired it.
 *
 *   So the honest division is about ORDER, not about presence: codex decides
 *   what to raise, and we decide what happens to what it raised. That is what
 *   the footer says, and it is why `default`, `acceptEdits`, `auto` and
 *   `bypassPermissions` need no clause of their own.
 *
 * Stated at the strength it is proven. Nothing in this repo executes codex, so
 * these clauses say WHO decides, never what codex decides.
 *
 * `dontAsk` is the one mode that keeps a clause for the OPPOSITE reason to the
 * others: on codex we DO answer it — `CodexAgent.handleServerRequest` refuses
 * without a card in that mode — so the footer's "the runtime decides which
 * actions to raise" would be wrong under it. (P3.328 rewrote that footer in
 * `7843b293b`; the sentence quoted here read "the runtime decides what to ask
 * you about" and no longer appears in any locale.) Its clause carries the one residual
 * instead: with the sandbox master switch off (the shipped default,
 * `SANDBOX_ENABLED_DEFAULT === false`) `dontAsk` emits `on-request` — it emitted
 * `untrusted` until `rust-v0.150.1` retired that value (P7.2) — under which
 * codex auto-approves an unmatched command outright rather than only a read;
 * with the switch on it emits `read-only`/`never`, and reads run there without an
 * approval request either. The residual is WIDER at switch-off than it was, and
 * it is reported to the operator by `CODEX_UNBOUNDED_APPROVAL_NOTICE` rather
 * than left to this comment. **It is also
 * the one clause with no width budget to respect**: `PICKER_HIDDEN_MODES` keeps
 * `dontAsk` out of every picker, so it renders on no one-line surface.
 *
 * `plan` carries both of its own facts in one clause: codex asks before an edit
 * (F1.787, F1.1003), AND no plan is handed over. `SubmitPlan` is in
 * `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` and `CodexAgent` spawns the session
 * MCP server with `--external-standalone-only`, so the tool is never advertised
 * (`codex-agent.ts` names `SubmitPlan` only in a docblock and never calls
 * `onPlanSubmitted`, which `pi-agent.ts` does).
 */
export const RUNTIME_PERMISSION_MODE_CLAUSE_KEYS:
  Partial<Record<ModelProvider, Partial<Record<PermissionMode, string>>>> = {
  'codex-runtime': {
    dontAsk: 'chat.permissionModeClause.codexDontAsk',
    // `explore` and `plan` are the two modes whose GENERAL string still promises
    // something about files ("no file changes" / "read-only"), so their clause
    // has to discharge the write half — the footer only discharges the asking
    // half. Review caught an early version doing the opposite: it removed
    // "never prompts" — where reality is MORE prompts than stated, i.e. safer —
    // and kept the unbacked write guarantee, where reality may be MORE writes.
    // F1.787 (2026-09-26) changed what is measured: codex's own `:read-only`
    // profile now holds both modes in both switch positions — a shell write is
    // refused, a patch is RAISED — and F1.1003 lets the session's plans and data
    // folders take writes; `runPreToolUseChecks` still has no call site in
    // `codex-agent.ts`, so nothing of ours inspects a call codex does not raise.
    //
    // P6.69 narrowed the second half. It used to end "nothing of ours inspects
    // the call first either", which read as "nothing of ours inspects the call",
    // and that is false at HEAD: a raised `applyPatchApproval` goes through
    // `CodexAgent.floorVerdict` (the shared `findNonNegotiableFloors` seam), the
    // `deniedPaths` refusal (P6.62) and the user's own rules before it runs.
    // What these two modes' GENERAL strings still over-promise is the WRITE
    // guarantee — "no file changes" / "read-only": codex asks before an edit and
    // the edit can be approved, and saying so is the whole job of this clause.
    // F1.1050: the retired `explore` had a clause here; F1.1052 deleted its now unused locale key.
    plan: 'chat.permissionModeClause.codexPlan',
    // `default`, `acceptEdits`, `auto` and `bypassPermissions` deliberately have
    // NO entry: what they used to say was the footer's sentence, verbatim, four
    // times over.
  },
}

/**
 * The ONE fact about the active runtime that is the same under every mode.
 *
 * A menu-level footer, not an item's words — which is what it always was. It is
 * keyed by runtime alone, because it is a statement about the runtime and not
 * about any mode: on codex, codex decides WHICH actions to raise, and we check
 * each raised one. (This sentence said *"Nessy is not in the loop before a call
 * runs"* until P6.69; the shipped string it describes has said the corrected
 * thing since P3.328's `7843b293b`, so the docblock was the half that had gone
 * stale — the one place a reader goes to find out what the string means.)
 *
 * Absent runtime → no enforcement half from this table. Pi and Claude have no
 * entry on purpose (the pre-tool-use gate really does run there) and still draw
 * a band, P6.492's resume sentence (UB12.48); the runtime-less surfaces —
 * Workspace Settings — have no runtime to look up.
 *
 * **The `except in Bypass` tail is GONE (P6.572, 2026-09-07).** It had become
 * conservative rather than exact when P6.61 (`45b47c723`) emptied
 * `CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED`: in Bypass the floors and a `deny`
 * rule still refuse, and only the human CARD is skipped. Claiming less
 * protection than the session has is the safe direction, but a notice meant to
 * be trusted has to be exact — so both locales now name the half that is
 * skipped and the half that still refuses.
 */
export const RUNTIME_PERMISSION_MODE_FOOTER_KEYS: Partial<Record<ModelProvider, string>> = {
  'codex-runtime': 'chat.permissionModeRuntimeNote.codex',
}

/**
 * The resume table's one divergence, said once at menu level (P6.492).
 *
 * `7c2dd610c` applied the page's resume table on all three runtimes: a session
 * that ended in `bypassPermissions` reopens in the connection's default mode, a
 * session that ended in `auto` is re-checked against current eligibility, and
 * `plan` alone is restored unchanged. That row's `done_means` asks for the
 * divergence to be STATED in the mode picker, and W8-d handed the sentence on
 * rather than guessing where it goes, for a reason worth keeping:
 * {@link RUNTIME_PERMISSION_MODE_CLAUSE_KEYS} is one clause per (runtime, mode)
 * and codex's `plan` slot is already taken, while this fact is neither.
 *
 * It is not per-mode: the sentence names three modes at once, so a per-mode
 * clause would repeat it three times — and could not, because
 * `describePermissionModeLine`'s output has a ONE-LINE budget of 440 CSS px at
 * `text-xs` with Russian as the binding constraint. It belongs where the other
 * once-per-menu fact lives.
 *
 * It is not per-runtime either, which is why this is a SET rather than another
 * table: the three local runtimes all follow the same restore path through
 * `SessionManager`. `nestor-cloud-agent` is excluded deliberately — it ships its
 * own modes with its own `remoteModeId`s and its own words, so a sentence about
 * how OUR host restores a local mode would be false there, the same reason a
 * backend-supplied `modeOptions` description wins outright.
 *
 * Consequence to expect rather than to discover: Pi and Claude sessions now draw
 * a footer band where they drew none. That is the row asking for the disclosure,
 * not a regression — and `resolveRuntimePermissionModeNote` still answers
 * `undefined` where there is genuinely nothing to say, so the renderers' "no
 * band at all rather than an empty one" rule is untouched.
 */
export const PERMISSION_MODE_RESUME_NOTE_KEY = 'chat.permissionModeNote.resumeTable'

/** The runtimes whose sessions go through the host's own restore path. */
const RUNTIMES_FOLLOWING_THE_RESUME_TABLE: ReadonlySet<ModelProvider> =
  new Set(['pi', 'anthropic', 'codex-runtime'])

/**
 * ONE LINE for one mode: the general statement of intent, plus the short clause
 * this runtime adds to it where the general string alone would over-promise.
 *
 * **The shared runtime caveat is deliberately NOT in here** — it is
 * {@link resolveRuntimePermissionModeNote}, and a surface that renders these
 * lines on a known runtime owes the user that note somewhere. The name says
 * "line" for that reason: what you get back is sized to fit one, and it is not
 * the whole runtime story. This function used to be
 * `describePermissionModeForRuntime` and used to return general + the whole
 * note; six copies of one sentence is what made the picker a wall of text.
 *
 * `activeRuntime` undefined is the runtime-less caller, and Workspace Settings
 * IS that caller — both of its mode surfaces (the default-mode select and the
 * cycling toggles) route through here with no runtime, deliberately. A
 * workspace has no runtime: it sets a default for sessions that pick their own
 * integration and can switch mid-session. So the only thing it can honestly
 * state is the INTENT, which is what R5's owner decision says a mode IS. The
 * default parameter is the live path, not defensive dead code.
 *
 * It yields the general string alone — never a clause for a runtime nobody named.
 */
export function describePermissionModeLine(
  mode: PermissionMode,
  t: Translate,
  activeRuntime?: ModelProvider,
): string {
  const general = t(PERMISSION_MODE_FULL_DESCRIPTION_KEYS[mode])
  const clauseKey = activeRuntime ? RUNTIME_PERMISSION_MODE_CLAUSE_KEYS[activeRuntime]?.[mode] : undefined
  if (!clauseKey) return general
  const clause = t(clauseKey)
  // A locale that has not translated the key yet echoes it back; render the
  // general string alone rather than a raw key in the picker.
  return clause && clause !== clauseKey ? `${general} ${clause}` : general
}

/**
 * The active runtime's shared caveat, once — or `undefined` when there is none
 * to give.
 *
 * `undefined` is a rendering instruction as much as a value: no band, no
 * separator, no empty strip. Only `nestor-cloud-agent` takes that branch (or a
 * locale echoing both keys): since P6.492 Pi and Claude draw a band carrying the
 * resume sentence (UB12.48), though the footer table names neither.
 *
 * `activeRuntime` is REQUIRED here, unlike on {@link describePermissionModeLine}
 * where an optional runtime is the live Workspace-Settings path. Every caller of
 * this one knows its runtime: `ComposerCapabilities.connection.activeRuntime` is
 * a required field of the DTO, and a runtime-less surface has no footer to draw
 * in the first place. An `activeRuntime?` here would be a branch with no caller.
 */
export function resolveRuntimePermissionModeNote(
  t: Translate,
  activeRuntime: ModelProvider,
): string | undefined {
  // Same untranslated-key rule as the per-mode clause, applied to each half: an
  // echoed key is not a sentence, and a footer showing one is worse than no
  // footer. A half that does not translate drops out and the other still shows.
  const translated = (key: string | undefined): string | undefined => {
    if (!key) return undefined
    const value = t(key)
    return value && value !== key ? value : undefined
  }
  const parts = [
    translated(RUNTIME_PERMISSION_MODE_FOOTER_KEYS[activeRuntime]),
    RUNTIMES_FOLLOWING_THE_RESUME_TABLE.has(activeRuntime)
      ? translated(PERMISSION_MODE_RESUME_NOTE_KEY)
      : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(' ') : undefined
}

export interface ComposerPermissionModeDisplay {
  mode: PermissionMode
  label: string
  shortLabel: string
  description: string
  iconMode: PermissionMode
  remoteModeId?: string
}

/**
 * `dontAsk` is settable through config, the CLI flag, and automations only —
 * never through a picker. Cycling or clicking into a mode that silently
 * denies and never prompts would be a surprise; the pickers therefore filter
 * it even when a capability set names every mode.
 */
const PICKER_HIDDEN_MODES: ReadonlySet<PermissionMode> = new Set(['dontAsk'])

/**
 * F1.1052 — Claude Desktop's mode picker, in its order (the owner's MODES-SPEC,
 * 2026-09-28, from a screenshot of that picker): Auto, Manual, Accept edits,
 * Plan, Bypass permissions, numbered 1–5. `dontAsk` is absent: kept and fully
 * working, but hidden from the user ({@link PICKER_HIDDEN_MODES}).
 *
 * A UI order ONLY. `PERMISSION_MODE_ORDER` stays the STRICTNESS order the clamp
 * indexes, and must never be reordered for a menu (a reordered entry there is a
 * silent widening).
 *
 * The SHIFT+TAB cycle walks this same list (P2.56: the cycle IS the picker's
 * list), so it runs Auto → Manual → Accept edits → Plan → Bypass permissions →
 * Auto — which is the cycle permission-modes.md documents for the CLI ("the
 * cycle then runs `default` → `acceptEdits` → `plan` … Enabled optional modes
 * slot in after `plan`, with `bypassPermissions` first and `auto` last"), read
 * as a ring. A workspace's `cyclablePermissionModes` narrows it as a SET; the
 * order written in that list is not read.
 */
export const PERMISSION_MODE_PICKER_ORDER: readonly PermissionMode[] =
  ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']

/** The mode Claude Desktop's picker marks "Recommended". */
export const RECOMMENDED_PERMISSION_MODE: PermissionMode = 'auto'

/**
 * The modes a picker offers, in the order it offers them.
 *
 * Nessy's own modes follow {@link PERMISSION_MODE_PICKER_ORDER}. A backend that
 * names its OWN modes (`modeOptions` — today only Nestor Cloud, whose list comes
 * from its agent card) keeps the order it sent: that picker is Nestor's, not
 * ours, and stays exactly as it was.
 */
export function getVisibleComposerPermissionModes(
  capabilities?: ComposerCapabilities,
): PermissionMode[] {
  const modes = capabilities?.permissions.modes ?? PERMISSION_MODE_ORDER
  const visible = modes.filter(mode =>
    PERMISSION_MODE_ORDER.includes(mode) && !PICKER_HIDDEN_MODES.has(mode))
  if (visible.length === 0) return [...PERMISSION_MODE_PICKER_ORDER]
  if ((capabilities?.permissions.modeOptions?.length ?? 0) > 0) return visible
  return PERMISSION_MODE_PICKER_ORDER.filter(mode => visible.includes(mode))
}

/** What one picker row shows beside its label and on its right edge. */
export interface PermissionModeMenuDecorations {
  /** Claude Desktop's "Recommended" badge — on Auto. */
  recommended: boolean
  /** The "Default" badge — on the mode a new session in this workspace starts in. */
  isDefault: boolean
  /** The 1-based digit that selects this row while the menu is open. */
  shortcut?: number
}

/**
 * F1.1052 — the badges and the digit of one picker row, decided in one place so
 * the dropdown and the drawer cannot disagree.
 *
 * A row a backend supplied (`remoteModeId`: Nestor Cloud's Plan and Act) gets
 * none of them: that picker keeps exactly what it showed before, and "Auto is
 * recommended" or "this is your default" are statements about OUR modes.
 * `defaultMode` undefined (no workspace loaded, the playground) draws no
 * Default badge rather than guessing one. Digits stop at 9.
 */
export function resolvePermissionModeMenuDecorations(
  display: Pick<ComposerPermissionModeDisplay, 'mode' | 'remoteModeId'>,
  index: number,
  defaultMode?: PermissionMode,
): PermissionModeMenuDecorations {
  if (display.remoteModeId) return { recommended: false, isDefault: false }
  return {
    recommended: display.mode === RECOMMENDED_PERMISSION_MODE,
    isDefault: defaultMode !== undefined && display.mode === defaultMode,
    ...(index < 9 ? { shortcut: index + 1 } : {}),
  }
}

/** A picker row with its F1.1052 badges and digit attached. */
export interface ComposerPermissionModeMenuDisplay extends ComposerPermissionModeDisplay {
  decorations?: PermissionModeMenuDecorations
}

/**
 * Attach {@link resolvePermissionModeMenuDecorations} to the rows a menu RENDERS
 * (after the workspace cycle narrowed them), so the digit is the row's position
 * in the menu the user sees.
 */
export function withPermissionModeMenuDecorations(defaultMode?: PermissionMode) {
  return (display: ComposerPermissionModeDisplay, index: number): ComposerPermissionModeMenuDisplay => ({
    ...display,
    decorations: resolvePermissionModeMenuDecorations(display, index, defaultMode),
  })
}

/**
 * The digit shortcut, as a menu `onKeyDown`: `1`…`9` clicks the row that
 * carries that `data-permission-mode-shortcut`, so selection goes through the
 * row's own `onSelect` and the menu closes the way a click closes it. A digit
 * no row carries, or a digit with a modifier held, is left alone.
 */
export function selectPermissionModeByDigit(
  event: { key: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean, currentTarget: ParentNode, preventDefault: () => void },
): void {
  if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return
  const row = event.currentTarget.querySelector<HTMLElement>(`[data-permission-mode-shortcut="${event.key}"]`)
  if (!row) return
  event.preventDefault()
  row.click()
}

/**
 * D1.327 — the modes this RUNTIME can honour, which is a wider list than the
 * one the picker offers, and the difference is exactly `PICKER_HIDDEN_MODES`.
 *
 * The two lists existed as one, and a session could not sit in `dontAsk`
 * because of it. Measured on the packaged 1.40.0 (SIT-5b): asked for `dontAsk`
 * the app reported `default` on both the pi and the claude card, with `explore`
 * and `plan` reporting themselves in the same runs. The host is not where that
 * happened — all seven modes round-trip through `setSessionPermissionMode` and
 * back out of both session reads (`sessions/__tests__/dont-ask-mode-round-trip.test.ts`).
 * The composer was: it coerced the session's mode against the PICKER's list,
 * `dontAsk` fell to `coercePermissionModeForComposer`'s `default` rung, and the
 * effect beside that memo WROTE the coerced value back to the host.
 *
 * So a mode hidden from the picker on purpose is not a mode to rewrite, and the
 * rule was already written down twice before this function existed: this set's
 * own docblock says `dontAsk` is "settable through config, the CLI flag, and
 * automations only", and {@link applyWorkspaceCycleToComposerModes} says the
 * mode a session is already in "must not be re-derived from a menu filter".
 * A coercion that reaches the host is what turns a hidden control into an
 * unreachable state.
 *
 * What it deliberately keeps: a mode the runtime genuinely CANNOT honour is
 * still absent from this list, still coerced, and still written back — that is
 * the effect's real purpose, and it is untouched.
 */
export function getSupportedComposerPermissionModes(
  capabilities?: ComposerCapabilities,
): PermissionMode[] {
  const modes = capabilities?.permissions.modes ?? PERMISSION_MODE_ORDER
  const supported = modes.filter(mode => PERMISSION_MODE_ORDER.includes(mode))
  return supported.length > 0 ? supported : [...PERMISSION_MODE_ORDER]
}

/**
 * **P2.56 — the workspace cycle, applied to the CLICK surface as well.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P2.56,
 * decided by the owner on 2026-09-02 (§A3(a)).
 *
 * A workspace can restrict which permission modes may be entered
 * (`cyclablePermissionModes`). SHIFT+TAB honoured it and the picker did not,
 * because `FreeFormInput`'s `enabledModes` prop was declared and never read — so
 * the setting was INERT on the click path while looking enforced. A control that
 * silently stops controlling is this fork's largest defect class, and two
 * surfaces disagreeing about a permission mode is that class in its purest form.
 *
 * The rule is COPIED from the keyboard path rather than re-derived, because the
 * point of the row is that the two agree: intersect the runtime's visible modes
 * with the workspace cycle, and fall back to the runtime list when fewer than
 * two survive — `AppShell.tsx`'s `chat.cyclePermissionMode` action, verbatim:
 * `intersectedModes.length >= 2 ? intersectedModes : capabilityModes`. Fewer
 * than two cannot cycle, and an empty picker is worse than an unrestricted one.
 *
 * ## What this deliberately does NOT filter, and why
 *
 * Only the list the picker RENDERS. The mode the session is already in is not
 * re-derived from it, so a session started in a non-cyclable mode by config, the
 * CLI flag or an automation keeps that mode and keeps its correct label
 * ({@link findComposerPermissionModeDisplay} synthesises a display for a mode
 * outside the list). Coercing there would let a workspace setting silently
 * change a running session's permission mode, which is a different and much
 * larger claim than "the menu offers what the workspace allows" — and it is not
 * what the keyboard path does either.
 */
export function applyWorkspaceCycleToComposerModes<T extends { mode: PermissionMode }>(
  displays: T[],
  cyclablePermissionModes: PermissionMode[] | undefined,
): T[] {
  const workspaceModes = resolveWorkspaceCyclablePermissionModes(cyclablePermissionModes)
  const intersected = displays.filter(display => workspaceModes.includes(display.mode))
  return intersected.length >= 2 ? intersected : displays
}

/**
 * F1.1052 — one SHIFT+TAB press over `ring` (the picker's list, narrowed by the
 * workspace cycle — `AppShell.tsx`'s `chat.cyclePermissionMode`).
 *
 * A mode IN the ring steps to its neighbour. A mode OUTSIDE it — `dontAsk` set
 * by config, the CLI flag or an automation, or a mode the workspace left out —
 * steps to Manual first, the rule permission-modes.md states for the CLI
 * ("From `auto`, the first press switches to `default`"); without Manual in the
 * ring, to its first mode. It used to step from the COERCED mode instead, and
 * with Claude Desktop's order that is wrong in the widening direction: a
 * `dontAsk` session coerces to Plan, and Plan's neighbour is Bypass
 * permissions — one keypress from the strictest mode to the widest.
 * `undefined` only for an empty ring, which cannot cycle.
 */
export function nextCyclePermissionMode(
  current: PermissionMode,
  ring: readonly PermissionMode[],
): PermissionMode | undefined {
  if (ring.length === 0) return undefined
  const index = ring.indexOf(current)
  if (index === -1) return ring.includes('default') ? 'default' : ring[0]
  return ring[(index + 1) % ring.length]
}

export function coercePermissionModeForComposer(
  mode: PermissionMode,
  visibleModes: PermissionMode[],
): PermissionMode {
  if (visibleModes.includes(mode)) return mode
  // F1.1070: `dontAsk` lands on `plan` too when the list offers it — the read-only neighbour, and what
  // Nestor Cloud's wire already sends for it (`mapPermissionModeToNestorCloudMode`), so a Nestor Cloud
  // session in dontAsk shows (and keeps) Plan instead of being rewritten to Act. F1.1050 retired explore.
  if ((mode === 'plan' || mode === 'dontAsk') && visibleModes.includes('plan')) return 'plan'
  if (visibleModes.includes('default')) return 'default'
  return visibleModes[0] ?? mode
}

/**
 * Everything a picker needs to render one runtime's mode list.
 *
 * The note is a SIBLING of the items rather than a field on each of them, and
 * that shape is the point: it belongs to the list, it is rendered once, and a
 * renderer that destructures `modes` and drops `runtimeNote` is visibly dropping
 * something named instead of silently shipping a `description` that no longer
 * says what it used to. `ComposerPermissionModeDisplay.description` is now a
 * ONE-LINE string by contract — see {@link describePermissionModeLine}.
 */
export interface ComposerPermissionModeList {
  modes: ComposerPermissionModeDisplay[]
  /**
   * The active runtime's shared caveat, to be shown ONCE for the whole list.
   * `undefined` means there is nothing to say and no band should be drawn.
   */
  runtimeNote?: string
}

export function resolveComposerPermissionModeList(
  capabilities: ComposerCapabilities,
  t: Translate,
): ComposerPermissionModeList {
  const optionByMode = new Map<PermissionMode, ComposerPermissionModeOption>()
  for (const option of capabilities.permissions.modeOptions ?? []) {
    optionByMode.set(option.mode, option)
  }

  const modes = getVisibleComposerPermissionModes(capabilities).map((mode) => {
    const option = optionByMode.get(mode)
    return {
      mode,
      label: option?.label ?? t(`mode.${mode}`),
      shortLabel: option?.shortLabel ?? t(`mode.${mode}Short`),
      // A backend-supplied `description` still wins outright: Nestor cloud ships
      // its own modes with its own words, and a clause about a local runtime
      // would be false there. Every other provider gets the general string plus
      // the mode-specific part of what its runtime enforces (R15).
      description: option?.description
        ?? describePermissionModeLine(mode, t, capabilities.connection.activeRuntime),
      iconMode: option?.iconMode ?? mode,
      ...(option?.remoteModeId ? { remoteModeId: option.remoteModeId } : {}),
    }
  })

  // The footer is keyed on the RUNTIME, not on the words, so a backend override
  // does not suppress it: overriding what a mode means cannot change who is in
  // the loop before a call runs. It is moot today — the one backend that ships
  // `modeOptions` is `nestor-cloud-agent`, which has no footer entry — and this
  // is the honest behaviour if that ever changes.
  const runtimeNote = resolveRuntimePermissionModeNote(t, capabilities.connection.activeRuntime)
  return runtimeNote ? { modes, runtimeNote } : { modes }
}

/**
 * `activeRuntime` is optional and is the SAME runtime the displays were built
 * with. Passing it keeps the fallback branch — a mode the capability set does
 * not list — describing the mode the way the list beside it does; omitting it
 * yields the general string, which is the runtime-less answer rather than a
 * guessed one.
 */
export function findComposerPermissionModeDisplay(
  displays: ComposerPermissionModeDisplay[],
  mode: PermissionMode,
  t: Translate,
  activeRuntime?: ModelProvider,
): ComposerPermissionModeDisplay {
  return displays.find(display => display.mode === mode) ?? {
    mode,
    label: t(`mode.${mode}`),
    shortLabel: t(`mode.${mode}Short`),
    description: describePermissionModeLine(mode, t, activeRuntime),
    iconMode: mode,
  }
}
