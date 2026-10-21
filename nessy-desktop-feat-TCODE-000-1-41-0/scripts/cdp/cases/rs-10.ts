/**
 * RS-10 (row P6.188) — the claude RE-QUEUE arm, blocked since 2026-08-21, driven
 * in the same run as the delivered arm that already passes.
 *
 * Ledger O5 (claude cell), `—`. **Native mechanism: claude's steer is an
 * EMULATION** — `redirect()` parks the text and a `PreToolUse` hook injects it as
 * `additionalContext`. It is the nearest mechanism the runtime has, it is already
 * adopted, and the residual cost is documented in place. Nothing to build.
 *
 * Two facts, from the checklist itself:
 *
 *  - the DELIVERED arm is measured — STR-1, PASS 23/23, 2026-08-21, on a DEV
 *    build;
 *  - the UNDELIVERED arm is **BLOCKED**, and the recorded blocker was *the
 *    prompt*, not the mechanism: the prose turn settled before there was
 *    anything to steer into.
 *
 * That blocker has since been fixed inside `str-2.ts` itself — the correction is
 * sent as soon as the app reports a turn in flight (`CORRECTION_DELAY_MS`
 * defaults to 0, and its own comment records the 9 s-to-81 s spread that caused
 * the block), and `longProsePrompt` was widened, with the lever stated as a
 * LONGER PROMPT rather than a delay. So what P6.188 still owes is not a new
 * detector: it is **the sitting**, on a PACKAGED build, with the delivered arm
 * beside it.
 *
 * ## Why this file delegates instead of re-implementing
 *
 * `str-2.ts` carries the detector this arm needs and every reason it is shaped
 * the way it is: the tool-call gate that blocks when the seed turn DOES call a
 * tool (which makes `steer_undelivered` unreachable), the in-flight read taken at
 * the instant of the Enter, and the `isQueued` re-queue check that separates
 * "re-queued under the id the transcript carries" from the shipped defect where
 * a fresh id made `sendMessage`'s replay throw. Copying that here would create a
 * second copy to drift. This case is the SITTING WRAPPER the row asks for: run
 * the subject, then run its control, in one process, and report both.
 *
 * The coupling is deliberate and worth naming: RS-10 follows `str-1.ts` and
 * `str-2.ts`. If either is edited, this case measures the edit.
 *
 * ## One arm blocking must not lose the other
 *
 * Both arms depend on the model's own choices — a prose turn that reaches for a
 * tool, a turn that ends before the correction goes — so either can legitimately
 * block. Each is run inside its own catch: a blocked subject is re-raised at the
 * end so the case's own status is honest, and the control's result is recorded
 * first either way. A run that reported only "BLOCKED" and threw the control
 * away would have paid for the sitting twice.
 *
 * ## The row's in-zone residue is a HAND-OFF, not a fix in this file
 *
 * Two prose lines say the claude default is `queue` where
 * `defaultMidStreamBehavior` returns `'steer'` for every providerType but
 * `nestor-cloud-agent`. Both reproduce at HEAD:
 * `packages/shared/AGENTS.md` (the per-providerType default sentence) and
 * `packages/shared/src/agent/backend/composer-capabilities.ts` (the
 * `CLAUDE_RUNTIME_DEFAULTS` docblock's closing line). Neither file is in this
 * lane's zone; the correction rides the lane report.
 */

import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { BlockedError, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import { drive as deliveredArm } from './str-1.ts'
import { drive as undeliveredArm } from './str-2.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-10'
const TITLE = 'The undelivered claude steer is re-queued rather than lost, with the delivered arm as its control in the same run'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.188',
  runtimes: ['claude'],
  credentials: 'owner: the claude gateway card, already signed in. Both arms write the connection '
    + 'midStreamBehavior and restore the operator value in their own finally blocks.',
} as const satisfies CaseMeta

interface ArmOutcome {
  arm: string
  status: 'ran' | 'blocked' | 'failed'
  detail?: string
}

async function runArm(
  arm: string,
  body: (run: CaseRun, session: CdpSession) => Promise<void>,
  run: CaseRun,
  session: CdpSession,
): Promise<{ outcome: ArmOutcome; blocked?: BlockedError }> {
  try {
    await body(run, session)
    return { outcome: { arm, status: 'ran' } }
  } catch (cause) {
    if (cause instanceof BlockedError) {
      return { outcome: { arm, status: 'blocked', detail: cause.message }, blocked: cause }
    }
    return { outcome: { arm, status: 'failed', detail: cause instanceof Error ? cause.message : String(cause) } }
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  // The whole point of re-sitting this row is that the recorded PASS was taken on
  // a dev build. A packaged reading is the deliverable, so this is a check rather
  // than an observation.
  run.check(
    'the artefact under test is the PACKAGED app',
    app.kind === 'packaged',
    app.kind === 'packaged' ? undefined
      : `kind=${app.kind} — STR-1's 2026-08-21 PASS was already a dev reading; a second one closes nothing`,
  )
  run.observe('correction delay knob', process.env.NESSY_CDP_STEER_DELAY_MS ?? '0 (the default, and the fix)')

  const subject = await runArm('STR-2 (undelivered, the subject)', undeliveredArm, run, session)
  run.observe('subject arm', subject.outcome)

  const control = await runArm('STR-1 (delivered, the control)', deliveredArm, run, session)
  run.observe('control arm', control.outcome)

  run.check(
    'THE CONTROL — the delivered arm produced a verdict in this same run',
    control.outcome.status === 'ran',
    control.outcome.status === 'ran' ? undefined
      : `the delivered arm ${control.outcome.status}: ${control.outcome.detail ?? ''} — without it, a blocked or `
        + 'failing subject cannot be told from a card that is not answering today',
  )

  run.observe(
    'VERDICT',
    subject.outcome.status === 'ran'
      ? 'STR-2 leaves BLOCKED for a recorded result — file its narrative in docs/testing/cdp-runs/'
      : `STR-2 still ${subject.outcome.status} — ${subject.outcome.detail ?? ''}`,
  )

  // Re-raised LAST, so the control above is recorded whichever way the subject
  // went. `runCase` turns this into BLOCKED only when no check has already
  // failed, which is the behaviour this case wants: a failed control is a FAIL.
  if (subject.blocked) throw subject.blocked
}

/**
 * What makes the subject arm reachable, when it blocks on the model's own choice.
 *
 * Both levers are prompt-shaped and neither is a delay: a sleep measures the
 * gateway's speed, which is the confound that blocked this row in the first place.
 */
export const manual = {
  why: 'the undelivered arm needs a turn that makes NO tool call and is still running when the correction goes',
  runOnlyIf: 'the automated run reported the subject arm blocked',
  steps: [
    'Read the block message: it says which of the two preconditions failed.',
    'If the seed turn CALLED A TOOL — re-run. The seed asks for invented prose with no reads and no '
      + 'commands; reaching for a tool is the model\'s choice, and with a boundary present '
      + 'steer_undelivered is unreachable by design.',
    'If the seed turn ENDED FIRST — widen the window with a LONGER prompt (more output), never with '
      + 'NESSY_CDP_STEER_DELAY_MS. Prose length does not depend on the gateway\'s speed and induces no tool call.',
    'Record the packaged run in docs/testing/cdp-runs/ with the build id and the load.',
  ],
  expected: 'an undelivered steer returns steer_undelivered, is re-queued under an id the transcript already '
    + 'carries, and the replay does not throw',
  detector: 'str-2.ts\'s own checks — no PreToolUse injection, the app\'s re-queue record where a log exists, '
    + 'two prompt entries in the CLI\'s own transcript, and the correction back at isQueued: true rather than '
    + 'replaced by a new message',
  positiveControl: 'STR-1\'s delivered arm, in this same run',
  doneMeans: 'STR-2 leaves BLOCKED for a recorded PASS/FAIL with its narrative filed, and the two stale prose '
    + 'lines named in this file\'s header match the code',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
