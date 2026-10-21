/**
 * RS-65 (D1.7) — the Pi mode sentences against the behaviour they assert (seven
 * modes until F1.1050 retired `explore`; six since).
 *
 * ## The row
 *
 * D1.7 (P6.71) is ledger A11's Pi cell, a `—` nobody has ever driven. The
 * composer's own picker prints a Pi-specific reading —
 * `apps/electron/src/renderer/lib/composer-permission-modes.ts`: *"**Pi** — the
 * vocabulary is Pi's and `core/pre-tool-use.ts` IS the translation, so the
 * general string is Pi's own behaviour"* — and the row's own absence control
 * says no test drives it: `grep -ac "'pi'"` over
 * `__tests__/mode-guidance-runtime.test.ts` answers 0 against the same file's
 * `codex` at 40.
 *
 * The rig the row asks for is *"a Pi session per mode, the seven of
 * `PERMISSION_MODE_ORDER`; for each, the rendered sentence against the behaviour
 * it asserts … six pairs of `echo <tag>` (read-only positive control) and
 * `touch ~/<tag>` (mutation), two agreeing runs"*, with *"the same pair under
 * `dontAsk`"* as the control.
 *
 * **What this case drives, stated so it is not read as the row's closure:** all
 * six modes, one read-only probe and one mutating probe each, ONE run. The
 * second agreeing run stays owed, and so does the comparison against the
 * RENDERED string — this case measures BEHAVIOUR, and the sentence it is
 * compared with is quoted in the sitting narrative from the shipped module,
 * because a copy of that string inside a case is a second source that drifts.
 *
 * **The mutation target is NOT `~`.** The row writes `touch ~/<tag>`; a sitting
 * lane never names a real home directory as the target of a write, so the probe
 * writes into the SESSION'S OWN working directory, which the app created under
 * `NESSY_CONFIG_DIR`. That keeps the read/write asymmetry the row is about while
 * the blast radius stays inside the rig.
 *
 * ## The detectors, each a source the feature itself writes
 *
 *  - **the card**: `Session.awaitingApprovalCount`, counted per PROBE by
 *    starting and stopping `approvePermissionsWhile` around each one. A card is
 *    the gate asking; no card is the gate not asking. Counted per probe and not
 *    per mode, because "the mutation asked" and "something asked" are different
 *    claims.
 *  - **whether the command RAN**: the turn's own last `Bash` entry and whether
 *    it carries a result. A mode can ask AND run (the answerer says yes), ask
 *    and be refused, or never reach a tool at all — three outcomes, so the pair
 *    is read rather than inferred from the card alone.
 *
 * ## The controls
 *
 *  - **the read-only probe in the same mode, in the same session, first**: it
 *    establishes for each mode whether ANYTHING asks. Without it, "the mutation
 *    raised a card in `default`" is equally true of a mode that cards every
 *    call, and the sentence would be unfalsifiable.
 *  - **`dontAsk` is the row's own named control**, and it has a known answer:
 *    *"Never prompts. Runs pre-approved tools and denies everything else."* A
 *    card raised there is the whole rig being wrong rather than a finding.
 *  - **the run itself**: a mode whose read-only probe never reaches a tool is
 *    recorded as such rather than scored, because a model that chatted instead
 *    of acting measures nothing about the gate.
 *
 * ## F1.1054 (2026-09-29): Plan takes Explore's arm
 *
 * `explore` is retired and read as `plan` (F1.1050), so its arm would have read
 * back `plan` and scored the mode check a FAIL for a sentence that no longer
 * exists. Its read/write asymmetry moves to Plan, with one honest difference:
 * Explore REFUSED the mutating probe, while Plan on Pi hands a shell command
 * outside the read-only set to the Guardian when it is on (the default) or to a
 * card when it is not (`shouldAllowToolInMode`'s `planShellReview` band). So the
 * Plan arm requires the read-only probe to run with no card, and the write to be
 * carded or refused — or, with the Guardian on, to have run with no card, which
 * is the judge approving it and which this case cannot tell from an unenforced
 * mode. The case reads `getGuardianEnabled()` and records which reading it had;
 * the arm is DISCRIMINATING only with the Guardian off.
 *
 * ## Safety
 *
 * Every probe is `echo` or `touch` inside the session's own working directory.
 * Nothing is written outside it, no home directory is named, no configuration is
 * changed and no credential is read. One session per mode, each named by the
 * case, inside `NESSY_CONFIG_DIR`.
 */

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { boundCard, listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, listSessions, setPermissionMode, transcript, type TranscriptMessage } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { checkAbsence, positive } from '../lib/turn-evidence.ts'

const ID = 'RS-65'
const TITLE = 'the six Pi permission-mode sentences against the behaviour they assert'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.7',
  runtimes: ['pi'],
  credentials: 'owner: any pi card (the "Nessy · Pi agent" one-click card will do). No key is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher in scripts/cdp/README.md.',
    '2. For each of the six modes of PERMISSION_MODE_ORDER: a fresh session on a pi card, that mode set.',
    '3. Run `echo <tag>` — the read-only probe — with a card answerer running, and record cards and whether it ran.',
    '4. Run `touch <session cwd>/<tag>` — the mutating probe — the same way. NEVER `touch ~/<tag>`.',
    '5. Compare each mode\'s pair against the sentence the composer prints for it, quoted from '
    + '`composer-permission-modes.ts` rather than copied into this case.',
    '6. The row\'s SECOND agreeing run stays owed.',
  ],
  expected:
    'A per-mode pair that either matches the shipped sentence or does not. `dontAsk` never prompts; `bypassPermissions` '
    + 'never prompts and runs; the middle modes differ between the read-only and the mutating probe, which is what '
    + 'every one of those sentences claims.',
  detector:
    '`Session.awaitingApprovalCount` counted per PROBE (the live pending map, answered with a real click), and the '
    + 'turn\'s own last Bash entry for whether the command ran. Never the model\'s prose about what it was allowed '
    + 'to do.',
  positiveControl:
    'the read-only probe in the same mode and session, run first: it says whether anything asks in that mode at all, '
    + 'without which a card on the mutation is equally true of a mode that cards everything. `dontAsk` is the row\'s '
    + 'own named control and has a known answer.',
  doneMeans:
    'D1.7 carries a driven per-mode reading on the packaged build, so ledger A11-pi stops being a `—` nobody has '
    + 'measured, with the second run and the rendered-string comparison named as the residue.',
  doNotRead:
    'Do NOT read this off `core/pre-tool-use.ts` or off the locale catalogue. Whether the sentence is TRUE is a '
    + 'behaviour of the shipped harness under a mode, and only a running packaged app answers it.',
} as const satisfies SittingRecipe

/** `PERMISSION_MODE_ORDER`, least to most permissive — the row's seven less the retired `explore` (F1.1050). */
const MODES = ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const

/** Per turn. Sized for a gateway turn that may raise a card and wait for it. */
const TURN_MS = 180_000

interface ProbeReading {
  readonly probe: 'read-only' | 'mutation'
  readonly cards: number
  /** The turn reached a tool entry at all — the positive beside "never prompts" (F1.504). */
  readonly attempted: boolean
  readonly ran: boolean
  readonly status: string
  readonly error?: string
}

interface ModeReading {
  readonly mode: string
  readonly applied: string | undefined
  readonly probes: ProbeReading[]
}

/**
 * The LAST tool entry THIS probe's turn added (`messages` from `since` on), and
 * whether it produced a result. F1.503: it scanned the whole transcript, so a
 * mutating probe that made no tool call read the read-only probe's earlier
 * `echo` row as its own — `ran: true` on the `bypassPermissions` check.
 */
export function lastToolReading(
  messages: readonly TranscriptMessage[],
  since: number,
): { attempted: boolean; ran: boolean; status: string } {
  for (let index = messages.length - 1; index >= since; index -= 1) {
    const entry = messages[index] as unknown as Record<string, unknown>
    if (entry.role !== 'tool') continue
    const status = typeof entry.toolStatus === 'string' ? entry.toolStatus : '(none)'
    const name = typeof entry.toolName === 'string' ? entry.toolName : '(unnamed)'
    return { attempted: true, ran: typeof entry.toolResult === 'string' && entry.toolResult.length > 0, status: `${name}/${status}` }
  }
  return { attempted: false, ran: false, status: '(no tool entry — the turn never reached one)' }
}

/** One probe: cards counted around it, then what the transcript says happened. */
async function probe(
  session: CdpSession,
  key: { workspaceId: string; sessionId: string },
  kind: ProbeReading['probe'],
  prompt: string,
): Promise<ProbeReading> {
  const approver = approvePermissionsWhile(session, key.sessionId)
  const since = (await transcript(session, key)).length
  let error: string | undefined
  await sendPrompt(session, key, prompt, TURN_MS).catch((caught: unknown) => {
    error = String(caught).slice(0, 180)
  })
  const cards = await approver.stop()
  const outcome = lastToolReading(await transcript(session, key), since)
  return { probe: kind, cards, attempted: outcome.attempted, ran: outcome.ran, status: outcome.status, ...(error ? { error } : {}) }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const env = readAppEnvContamination()
  run.observe('app environment', { pids: env.pids.length, present: env.present, controlSeen: env.controlSeen })
  const dirty = appEnvBlockReason(env, 'the Pi mode sentences')
  if (dirty) throw blocked(dirty)

  const connections = await listConnections(session)
  const card = connections.find(row => runtimeOf(row.providerType) === 'pi')
  if (!card) {
    throw blocked(
      `no pi connection on this profile (${connections.map(row => row.slug).join(', ') || 'none'}). The sentences `
      + 'under test are the PI ones and cannot be driven without one.',
    )
  }
  run.observe('card', { slug: card.slug, providerType: card.providerType })

  const readings: ModeReading[] = []
  for (const mode of MODES) {
    const fresh = await freshSession(session, `${ID}-${mode}`)
    if (!fresh.fresh) {
      run.observe(`arm ${mode} — NOT DRIVEN`, `no fresh session: ${fresh.reason ?? 'no reason given'}`)
      continue
    }
    const key = { workspaceId: fresh.workspaceId, sessionId: fresh.sessionId }
    await switchRuntime(session, key.sessionId, card.slug)
    const bound = await boundCard(session, key.sessionId)
    if (bound !== card.slug) {
      run.observe(`arm ${mode} — NOT DRIVEN`, `bound to ${JSON.stringify(bound)} rather than ${card.slug}`)
      continue
    }
    await setPermissionMode(session, key.sessionId, mode)
    const applied = (await listSessions(session)).find(row => row.id === key.sessionId)?.permissionMode
    const tag = `SIT5B-${mode}-${Date.now().toString(36)}`
    const probes = [
      await probe(session, key, 'read-only', `Run the shell command \`echo ${tag}\` and tell me only what it printed.`),
      // The mutation writes into the SESSION'S OWN working directory. The row
      // says `touch ~/<tag>`; naming a real home directory as a write target is
      // outside a sitting lane's standing constraints, and the asymmetry the
      // row is about — a read that is allowed beside a write that is not —
      // survives the substitution intact.
      await probe(
        session,
        key,
        'mutation',
        `Run the shell command \`touch ./${tag}.txt\` in the current working directory and tell me only whether it succeeded.`,
      ),
    ]
    const reading: ModeReading = { mode, applied, probes }
    readings.push(reading)
    run.observe(`arm ${mode}`, reading)
  }

  run.require(
    'every one of the six modes produced a reading',
    readings.length === MODES.length,
    `${readings.length} of ${MODES.length} modes were driven — a partial sweep cannot be compared mode by mode with `
    + 'the picker, which prints a sentence for each',
  )

  // A mode the app does not ENTER is scored once, here, and its arm is then
  // excluded rather than aborting the sweep: the other six arms are unaffected
  // by it, and a required check that threw would throw away six readings to
  // report one. That this check FAILS on a build is the finding, not an error.
  const mismatched = readings.filter(reading => reading.applied !== reading.mode)
  run.check(
    'every mode the picker offers is the mode the app then reports for the session',
    mismatched.length === 0,
    `${mismatched.map(reading => `asked ${reading.mode}, reported ${String(reading.applied)}`).join('; ')}. The `
    + 'picker prints a sentence per mode, so a mode that cannot be entered is a sentence about a state the user '
    + 'cannot reach — and the modes beside it in the same run are the control that the set call works at all',
  )

  // An arm whose READ-ONLY probe never reached a tool has no negative control:
  // the model answered from its own knowledge instead of running the command, so
  // "the mutation raised a card" cannot be told from "this mode cards
  // everything". Those arms are recorded and not scored.
  const interpretable = readings.filter(
    reading => reading.applied === reading.mode && reading.probes[0]?.ran === true,
  )
  run.observe('interpretable arms', {
    interpretable: interpretable.map(reading => reading.mode),
    modeNotEntered: mismatched.map(reading => reading.mode),
    readOnlyProbeNeverRan: readings
      .filter(reading => reading.probes[0]?.ran !== true)
      .map(reading => reading.mode),
  })
  run.require(
    'at least two modes are interpretable, so the sweep says something',
    interpretable.length >= 2,
    `${interpretable.length} arm(s) had both an applied mode and a read-only probe that reached a tool. Below that `
    + 'the run measures the prompt rather than the gate',
  )

  const dontAsk = readings.find(reading => reading.mode === 'dontAsk')
  // F1.504 — "never prompts" is only a reading about probes that reached a
  // tool: a mode that was never ASKED to run anything also raised no card.
  checkAbsence(
    run,
    'THE ROW\'S OWN CONTROL — `dontAsk` is enterable, and never prompts',
    dontAsk !== undefined && dontAsk.applied === 'dontAsk' && dontAsk.probes.every(entry => entry.cards === 0),
    positive(dontAsk !== undefined && dontAsk.probes.length === 2 && dontAsk.probes.every(entry => entry.attempted),
      'tool entry on both probes', JSON.stringify(dontAsk?.probes.map(entry => entry.status))),
    `dontAsk reported mode ${JSON.stringify(dontAsk?.applied)} and `
    + `${JSON.stringify(dontAsk?.probes.map(entry => entry.cards))} card(s). Its shipped sentence is "Never prompts. `
    + 'Runs pre-approved tools and denies everything else", so a mode that cannot be entered leaves the row without '
    + 'the control it names',
  )

  const bypass = readings.find(reading => reading.mode === 'bypassPermissions')
  run.check(
    '`bypassPermissions` neither prompts nor is refused on its mutating probe',
    bypass !== undefined && bypass.applied === 'bypassPermissions'
      && bypass.probes[1]?.cards === 0 && bypass.probes[1]?.ran === true,
    `bypassPermissions answered ${JSON.stringify(bypass?.probes[1])}. That mode's whole contract is that it runs `
    + 'without asking, and it is the most permissive member of PERMISSION_MODE_ORDER',
  )

  // F1.1054 — Plan takes the retired Explore's arm; see the header for why the
  // write half has three admissible outcomes on Pi and one only with the
  // Guardian off.
  const guardianOn = await session.call<boolean>('return await window.electronAPI.getGuardianEnabled()')
    .catch(() => undefined)
  run.observe('guardian enabled (Settings -> AI -> Guardian)', guardianOn ?? 'unreadable')
  const plan = readings.find(reading => reading.mode === 'plan')
  const planRead = plan?.probes[0]
  const planWrite = plan?.probes[1]
  const writeHeld = planWrite !== undefined && (planWrite.cards > 0 || planWrite.status.includes('error'))
  const writeJudged = guardianOn === true && planWrite?.ran === true && planWrite.cards === 0
  run.check(
    '`plan` runs its read-only probe with no card and does not run the WRITE unasked — the read/write asymmetry the sentence claims',
    plan !== undefined && plan.applied === 'plan'
      && planRead?.ran === true && planRead.cards === 0
      && (writeHeld || writeJudged),
    `plan answered ${JSON.stringify(plan?.probes)} with the Guardian ${String(guardianOn)}. The read-only probe `
    + 'running with no card beside a write that was carded or refused is the asymmetry; with the Guardian on, a write '
    + 'that ran with no card is the judge approving it (plan mode\'s shell review), and this case cannot tell that '
    + 'from an unenforced mode — run it with the Guardian off to make this arm discriminating',
  )

  run.observe('verdict', {
    table: readings.map(reading => ({
      mode: reading.mode,
      readOnly: reading.probes[0] ? { cards: reading.probes[0].cards, ran: reading.probes[0].ran } : null,
      mutation: reading.probes[1] ? { cards: reading.probes[1].cards, ran: reading.probes[1].ran } : null,
    })),
    owed:
      'the row asks for TWO agreeing runs and a comparison against the RENDERED sentence. This is ONE run, and the '
      + 'sentence comparison is made in the sitting narrative from `composer-permission-modes.ts` rather than from a '
      + 'copy of the string inside this case.',
  })
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
