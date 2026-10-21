/**
 * The permission mode every case runs in, and the cases that opt out of it.
 *
 * **OWNER RULE, 2026-09-18 ~19:25 (D1.385):** *"запиши тестирование проводить
 * через bypass permissions, потому что очень часто спрашивает разрешение и
 * тестирование не может проходить автоматически"* — testing runs through bypass
 * permissions, because the app asks for permission so often that testing cannot
 * proceed automatically. An unattended drive cannot click, so a card nobody
 * answers is a hang: RS-79's was one, and RS-86's own docblock records the same
 * shape twice (a command hook's card on screen, `awaitingApprovalCount: 0`, the
 * turn wedged for 180 s and again for 300 s).
 *
 * ## The mechanism, and why it is neither of the two the row offers
 *
 * D1.385 offers two ways to set the mode before the model's first turn: answer
 * the first-activation dialog once per fresh profile, or write the workspace's
 * `defaults.permissionMode` before launch. Read at HEAD there is a third, and it
 * costs less than both:
 *
 *  1. **The responsibility dialog is renderer-side and this harness never passes
 *     through it.** `needsBypassPermissionsAcknowledgment`
 *     (`apps/electron/src/renderer/lib/bypass-permissions-gate.ts`) is consulted
 *     by exactly two callers, both in the trusted renderer — `App.tsx`'s
 *     `handleSessionOptionsChange` and `BypassPermissionsDialog`'s `onConfirm`,
 *     which its own docblock enumerates. `state.ts`'s `setPermissionMode` issues
 *     `sessionCommand(id, {type:'setPermissionMode', mode})`, a state write that
 *     reaches the session manager directly. No dialog is raised and no
 *     acknowledgment is needed; `cases/rs-26.ts` already says so in its own words
 *     ("a state write rather than a menu click").
 *  2. **The workspace default is the dearest AND the wrong instrument.** A new
 *     session resolves `managedPiPolicy.defaultMode ?? wsConfig?.defaults?.
 *     permissionMode ?? globalDefaults.workspaceDefaults.permissionMode`
 *     (`packages/server-core/src/handlers/rpc/settings.ts`, symbol comment from
 *     P4.8). Reaching the middle term means a pre-launch config write — which
 *     this harness's README allows a FIXTURE and forbids a CASE — or a settings
 *     RPC that persists into the profile. And a workspace default applies to
 *     EVERY session in it, including the opt-outs, so it cannot express a
 *     per-case rule at all.
 *  3. **So: one `sessionCommand` per session created, at creation.** No fresh
 *     profile, no launch-time file, no dialog, no operator step, and it is
 *     per-case by construction. `claude-agent.ts` reads
 *     `config.session?.permissionMode` at spawn, so a mode set on the session
 *     record before its first message is the mode the child starts in.
 *
 * It is applied in `state.ts`'s `freshSession`, which 138 of the 163 case files
 * call, and NOT at the call sites: "every case gets bypass by default" written
 * as an opt-in becomes "every case that remembered", which is the silent
 * divergence AGENTS.md names.
 *
 * ## What an opt-out means
 *
 * The harness applies NOTHING. The case keeps whatever mode the app created the
 * session in and sets its own if it wants one — which is the row's "they keep
 * the mode they measure".
 */

/** The mode `freshSession` applies to every case that does not opt out. */
export const DEFAULT_CASE_PERMISSION_MODE = 'bypassPermissions'

/** One case that keeps the mode it measures. */
export interface CasePermissionModeOptOut {
  /** The case's `meta.id` — the id `runCase` is given, not the filename. */
  readonly id: string
  /** The id `docs/testing/cdp-live-checklist.md` carries a row for. */
  readonly checklistId: string
  /** Which of D1.385's six subjects this case is. */
  readonly subject:
    | 'the card'
    | 'the mode'
    | 'the floor'
    | 'Always-Allow'
    | 'read-before-write'
    | 'a hook approval'
  /** What bypass would destroy, measured — never "it looks like a card case". */
  readonly why: string
}

/**
 * The cases that keep the mode they measure.
 *
 * Derived from D1.385's CRITERION ("the cases whose SUBJECT is the card, the
 * mode, the floor, Always-Allow, read-before-write or a hook approval") rather
 * than from its sketch of an id list, because the two disagree —
 * {@link ROW_NAMED_NOT_OPTED_OUT} records every id the row named that reading
 * the cases refutes, so the disagreement is visible rather than silent.
 *
 * Every entry names what bypass would DESTROY, measured at `edbc4c4fa`
 * (2026-09-20). A case that merely runs `approvePermissionsWhile` as a net is
 * NOT here: bypass makes that net idle, which is the point of the rule.
 */
export const CASE_PERMISSION_MODE_OPT_OUTS: readonly CasePermissionModeOptOut[] = [
  {
    id: 'RS-07',
    checklistId: 'RS-07',
    subject: 'the card',
    why: 'the case says so itself, in a section heading: "Approval is part of the subject, not a '
      + 'nuisance" — the row asks about an APPROVED Bash command, and the count `approvePermissionsWhile` '
      + 'answered is recorded "so a run where nothing was ever asked is visible rather than assumed". '
      + 'Under bypass nothing is ever asked, and that instrument reads zero for every run.',
  },
  {
    id: 'RS-12',
    checklistId: 'RS-12',
    subject: 'the floor',
    why: 'the protected-path floor ALLOWS under this mode. `packages/shared/src/agent/pi-harness/'
      + 'protected-paths.ts` returns `allow` for `bypassPermissions` before anything else is consulted, '
      + 'and the case\'s arm 2 drives that floor as its own positive control that the floor is live on '
      + 'the build at all — so bypass would remove the control and the subject together.',
  },
  {
    id: 'RS-51',
    checklistId: 'RS-51',
    subject: 'the card',
    why: 'the ABSENCE of a card is the finding — its docblock records `awaitingApprovalCount` having '
      + '"stayed 0: nothing asked the person before" a worktree was created. Bypass manufactures that '
      + 'zero, and a manufactured zero is indistinguishable from the measured one.',
  },
  {
    id: 'RS-76',
    checklistId: 'RS-76',
    subject: 'read-before-write',
    why: 'the subject is whether ANYTHING stops a model overwriting a file it has never read, and a '
      + 'guard implemented as a permission decision is invisible under bypass. The case\'s own verdict '
      + 'vocabulary includes "nothing stopped it", which bypass would manufacture on all three runtimes.',
  },
  {
    id: 'RS-97',
    checklistId: 'RS-97',
    subject: 'a hook approval',
    why: '`PermissionRequest` is one of the host hook events in the matrix under test '
      + '(`packages/shared/src/automations/runtime-hook-events.ts` declares it, and `hook-decision-'
      + 'contract.ts` carries its own decision arm). Under bypass no permission is requested, so that '
      + 'event never fires and its row in the matrix would record a false non-firing.',
  },
  {
    id: 'WIRE-PARITY',
    checklistId: 'WIRE-PARITY',
    subject: 'the card',
    why: 'the case refuses this lever BY NAME, in a comment beside its own mode read: "The permission '
      + 'mode is left exactly as the app created it. Setting `bypassPermissions` here would make F7\'s '
      + '\'no permission prompt regressed\' assertion vacuous — it would be measuring the lever, not the '
      + 'product." It is the only case carrying `watchPermissionCards`.',
  },
]

/** One id D1.385 named as an opt-out that reading the case refutes. */
export interface RowNamedNotOptedOut {
  /** The case's `meta.id`. */
  readonly id: string
  /**
   * Which decidable shape the refutation takes, so the gate can re-measure it:
   *
   *  - `no-permission-code` — the file carries no `setPermissionMode` at all, so
   *    it takes no mode reading bypass could destroy;
   *  - `sets-its-own-mode` — the file sets the mode itself AFTER `freshSession`
   *    returns, so the harness default is overridden and no opt-out is needed.
   */
  readonly shape: 'no-permission-code' | 'sets-its-own-mode'
  /** Why the criterion does not reach it. */
  readonly why: string
}

/**
 * D1.385's own id list, minus the one entry of it that survives reading.
 *
 * The row sketches its criterion as *"RS-46/61/65/72/76/77 family, RS-79, RS-81,
 * the permission rows"*. Measured at `edbc4c4fa` (2026-09-20), `RS-76` is the
 * only one of the eight the criterion reaches; the other seven are here with the
 * measurement that refutes each, and `harness.test.ts` RE-RUNS those
 * measurements so this table goes red the day one of them stops being true —
 * a prose refutation ages, a re-measured one cannot.
 *
 * **The owner named these ids and can overrule the reading.** That is why this
 * is an exported, gated list and not an omission.
 */
export const ROW_NAMED_NOT_OPTED_OUT: readonly RowNamedNotOptedOut[] = [
  {
    id: 'RS-46',
    shape: 'no-permission-code',
    why: 'no permission-mode symbol of any kind; its subject is not the card.',
  },
  {
    id: 'RS-61',
    shape: 'no-permission-code',
    why: 'a VICTIM of the card storm, not a subject: its own comment records the run having '
      + '"raised TWO permission cards" with the turn sitting at `processing: true`, and it runs '
      + '`approvePermissionsWhile` as a net. Bypass is the fix for it, not a hazard to it.',
  },
  {
    id: 'RS-65',
    shape: 'sets-its-own-mode',
    why: 'it is genuinely a mode case and needs no opt-out: `freshSession` applies the default at '
      + 'creation and the case\'s own later `setPermissionMode` wins.',
  },
  {
    id: 'RS-72',
    shape: 'no-permission-code',
    why: 'its subject is the child\'s prompt-caching environment; no permission-mode symbol.',
  },
  {
    id: 'RS-77',
    shape: 'no-permission-code',
    why: 'its subject is the settings-combine file reads; no permission-mode symbol.',
  },
  {
    id: 'RS-79',
    shape: 'no-permission-code',
    why: 'D1.385 names RS-79 as the MOTIVATING VICTIM in the same sentence — "RS-79\'s \'hang\' was a '
      + 'card nobody answered" — so opting it out would preserve the exact failure the rule was '
      + 'written to end. The row contradicts itself here and the reading resolves it.',
  },
  {
    id: 'RS-81',
    shape: 'no-permission-code',
    why: 'no permission-mode symbol, and a card would stall the very turn its Stop arm needs running.',
  },
]

const OPT_OUT_BY_ID = new Map(CASE_PERMISSION_MODE_OPT_OUTS.map(entry => [entry.id, entry] as const))

/** The opt-out entry for a case id, or `undefined` when the default applies. */
export function casePermissionModeOptOut(caseId: string): CasePermissionModeOptOut | undefined {
  return OPT_OUT_BY_ID.get(caseId)
}

/**
 * The mode the harness applies to a session this case creates.
 *
 * `undefined` means APPLY NOTHING — the case keeps the mode the app created the
 * session in. An unknown id takes the default, deliberately: a new case gets
 * bypass unless it opts out by name, which is what D1.385's "done means" asks.
 */
export function resolveCasePermissionMode(caseId: string | undefined): string | undefined {
  if (caseId !== undefined && OPT_OUT_BY_ID.has(caseId)) return undefined
  return DEFAULT_CASE_PERMISSION_MODE
}

let currentCase: string | undefined

/**
 * Record the case this process is running, for {@link resolveCasePermissionMode}.
 *
 * A module-level registry is right here and nowhere else because `run.ts` gives
 * **each case its own process**, so there is exactly one case per module
 * instance. `report.ts`'s `runCase` is the single writer.
 */
export function setCurrentCaseId(caseId: string | undefined): void {
  currentCase = caseId
}

/** The case id `runCase` recorded, or `undefined` outside a case. */
export function currentCaseId(): string | undefined {
  return currentCase
}
