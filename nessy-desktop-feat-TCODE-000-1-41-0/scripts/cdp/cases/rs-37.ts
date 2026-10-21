/**
 * RS-37 (plan row C5.30) — C4.13's live proof: a REAL detached codex review,
 * started on a thread of its own and reporting back into this session.
 *
 * C4.13 was the owner's flip from "keep the refusal" to "wire it": codex has the
 * mechanism natively — `review/start` with `delivery: "detached"` on the pinned
 * protocol at `rust-v0.150.1` — so the host calls it rather than building a
 * second reviewer beside it. The row shipped with unit coverage on both halves
 * and no live run at all, which is what this case is for. Nothing here is
 * codex-specific except the card: the tool, the diff, the target and the rubric
 * are all the host's.
 *
 * ## The two branches, and why the CONTROL is the inline one
 *
 * `handleReviewDiff` (`@nessy-agent/session-tools-core`) has exactly two
 * answers, and they are byte-different sentences:
 *
 * | arm | the tool result says |
 * | --- | --- |
 * | no `background` | `Reviewing <target>.` … `Delegate this to the <agent> agent, …` |
 * | `background: true`, and codex accepted | `Reviewing <target> in the background on a review thread of its own; the findings will arrive here when it finishes.` |
 *
 * So the inline arm is a real negative control rather than a formality: it
 * proves the tool, the diff and this session all work, and that the background
 * sentence is NOT what the tool says by default. Both come from
 * `backend/codex/detached-review.ts` (`describeCodexDetachedReviewStart`) and
 * `handlers/review-diff.ts`, and they are spelled out below rather than
 * imported — a case that derives its expectation from the code under test passes
 * whatever that code does, including a regression.
 *
 * ## The report-back needs a TURN to land on, and that is the trap
 *
 * `admitDetachedReviewNotification` hands the findings to
 * `surfaceCodexOperatorNotice`, which pushes an `info` event onto the LIVE turn
 * when there is one and otherwise HOLDS it for the next turn (a bounded queue of
 * 8, de-duplicated). The ordinary case is the second one — the whole point of a
 * background review is that the user went on working — so a case that submits
 * the background review and then waits for a transcript row can wait forever
 * while the notice sits in `pendingServerWarningNotices`. This case therefore
 * sends ONE MORE prompt after the review was started and reads the transcript
 * after THAT turn. A run that finds the notice already there is also a pass; the
 * extra turn is the flush, not the trigger.
 *
 * That also settles which `info` rows are readable at all. R5 measured
 * (2026-09-12) that a HOST `sendEvent({type:'info'})` is rendered by the pane
 * and absent from `getSessionMessages`, while an `info` row an agent adapter
 * emits is persisted. This notice is the adapter's — an `AgentEvent` pushed on
 * the turn sink — so the transcript is the right instrument.
 *
 * ## The residue this case cannot close, stated rather than measured away
 *
 * `CODEX_DETACHED_REVIEW_SWITCH_NOTE` in the same module: the review is a codex
 * THREAD, so switching the session to Pi or claude mid-review abandons it and
 * its findings never arrive. That is a switch cost, not a defect, and it is not
 * driven here.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection } from '../lib/runtime-switch.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import {
  assertElectronApi, freshSession, setPermissionMode, transcript, waitFor,
  type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'

const ID = 'RS-37'
const TITLE = 'a real detached codex review: started on a review thread of its own, and its findings arriving back in this session'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'C5.30',
  runtimes: ['codex'],
  credentials: 'owner: one codex-runtime card, already signed in. No key is read; the card is named in the observations.',
} as const satisfies CaseMeta

/** `handleReviewDiff`'s inline template — the CONTROL's fingerprint. */
const INLINE_SENTENCE = 'Delegate this to the'
/** `describeCodexDetachedReviewStart` — the tool result when codex accepted. */
const STARTED_SENTENCE = 'in the background on a review thread of its own'
/** `describeCodexDetachedReviewFindings` — the notice when that thread reports. */
const FINISHED_SENTENCE = 'Background review of'

/**
 * `ReviewDiff` as the TRANSCRIPT spells it — bare, or under an MCP namespace.
 *
 * A codex session reaches the host's session tools through the bridged MCP
 * server, so its rows are named `mcp__session__ReviewDiff`; a Pi session's are
 * the bare `ReviewDiff`. This matched the bare name by equality, and on the
 * 1.37.0 release build (RV, 2026-09-12, HEAD `10c12eb65`) that scored BOTH arms
 * as *"no ReviewDiff row at all — the tool never ran"* over a transcript in
 * which the tool had run twice and answered with the two sentences below
 * verbatim. A detector that cannot see the tool reports the capability absent on
 * the very build that added it, which is the finding C3.360 was fixed for.
 */
const REVIEW_DIFF_TOOL = /(?:^|__)ReviewDiff$/

/** Every `ReviewDiff` row of a turn, with the result text a case asserts on. */
function reviewRows(messages: TranscriptMessage[]): Array<{ status?: string; result: string }> {
  return messages
    .filter(message => REVIEW_DIFF_TOOL.test(message.toolName ?? ''))
    .map(message => ({ ...(message.toolStatus ? { status: message.toolStatus } : {}), result: message.toolResult ?? '' }))
}

/** The findings notice, wherever in the session it landed. */
function findingsNotices(messages: TranscriptMessage[]): string[] {
  return messages
    .filter(message => message.role === 'info' && message.content.includes(FINISHED_SENTENCE))
    .map(message => message.content)
}

/**
 * A git repository with ONE uncommitted change — the smallest thing that makes
 * `scope: "uncommitted"` a non-empty diff.
 *
 * An empty diff is a real answer (`handleReviewDiff` returns "No changes to
 * review") and the bridge deliberately never starts a background thread for one,
 * so a case without a real change would measure the empty-diff branch and score
 * the absence of a capability it never asked for.
 */
function seedRepository(run: CaseRun): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs37-repo-')))
  const file = join(root, 'adder.py')
  writeFileSync(file, 'def add(a, b):\n    return a + b\n', 'utf8')
  const git = (...args: string[]): void => {
    const done = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (done.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(done.stderr)}`)
  }
  git('init', '--initial-branch=main')
  git('-c', 'user.email=rs37@example.invalid', '-c', 'user.name=RS-37', 'add', '--', 'adder.py')
  git('-c', 'user.email=rs37@example.invalid', '-c', 'user.name=RS-37', 'commit', '-m', 'seed')
  // The change under review: a real, reviewable defect, so a reviewer that runs
  // has something to say and an empty findings body means "it did not run"
  // rather than "there was nothing to find".
  writeFileSync(file, 'def add(a, b):\n    return a - b\n', 'utf8')
  run.observe('probe repository', { root, changed: 'adder.py', change: 'the addition was turned into a subtraction' })
  return root
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const connections = await listConnections(session)
  const codexCard = connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug
  if (!codexCard) {
    blocked(
      'no codex-runtime connection on this host, and `review/start` is codex\'s own mechanism — there is nothing '
      + `to measure on another runtime. The host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }
  run.observe('card under test', codexCard)

  const root = seedRepository(run)
  try {
    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
    run.require('the case ran in a session it created', key.fresh,
      key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
    await switchRuntime(session, key.sessionId, codexCard)
    run.require('the session runs on the codex card',
      (await waitForConnection(session, key.sessionId, codexCard)) === codexCard, codexCard)
    await bindProject(run, session, key.sessionId, root, {
      gate: () => trustScratchProject(session, root),
    })
    // Permissions are not what this row asks about, and `ReviewDiff` is
    // `readOnly: true` — but the reviewer's own shell is not, so the strongest
    // posture keeps a card from stalling a 4-minute turn. The approver under it
    // is the net for what `bypassPermissions` deliberately does not cover.
    const posture = await setPermissionMode(session, key.sessionId, 'bypassPermissions')
      .then(() => 'set').catch(error => `refused: ${String(error)}`)
    run.observe('permission-posture', { posture: 'bypassPermissions', outcome: posture })
    const approver = approvePermissionsWhile(session, key.sessionId)

    try {
      // ---- THE CONTROL — the same tool, the same diff, no background --------
      const control = await sendPrompt(
        session,
        key,
        'Call the ReviewDiff tool with scope uncommitted and no other arguments, then reply with exactly '
        + 'what it returned and nothing else. Do not review the code yourself.',
        300_000,
      ).catch(error => ({ added: [] as TranscriptMessage[], error: String(error) }))
      if ('error' in control && control.error) run.observe('control-turn-error', control.error)
      const controlRows = reviewRows(control.added)
      run.observe('control — ReviewDiff rows', controlRows.map(row => ({ status: row.status, head: row.result.slice(0, 160) })))
      run.check(
        'THE CONTROL — ReviewDiff ran on this diff and answered with the INLINE delegation template',
        controlRows.some(row => row.result.includes(INLINE_SENTENCE)),
        controlRows.length === 0
          ? 'no ReviewDiff row at all. On the packaged `70d269e46` (R4, 2026-09-12) that was the product: '
            + '`createSessionTools` (`@nessy-agent/session-mcp-server` `src/index.ts`) omitted `reviewDiffPort` '
            + 'beside its two `hostCallbackBridge` siblings, so `isOfferedByHostPorts` answered false and a '
            + 'bridged session was advertised 52 tools instead of 53. C3.360 (`fe1c54e17`) added the line and '
            + 'the 1.37.0 release build advertises it — so read this as the TOOL LIST only after checking the '
            + 'transcript for a row under any namespace: the same absence was once this case’s own '
            + 'detector missing `mcp__session__ReviewDiff` (RV, 2026-09-12)'
          : controlRows.some(row => row.result.includes(STARTED_SENTENCE))
            ? 'the control answered with the BACKGROUND sentence, so the two branches are not distinguishable here'
            : `rows: ${JSON.stringify(controlRows.map(row => row.result.slice(0, 120)))}`,
      )

      // ---- THE PROBE — the same tool with `background: true` ---------------
      const before = (await transcript(session, key)).length
      const probe = await sendPrompt(
        session,
        key,
        'Now call ReviewDiff again with scope uncommitted and background true, then reply with exactly what '
        + 'it returned and nothing else. Do not review the code yourself.',
        300_000,
      ).catch(error => ({ added: [] as TranscriptMessage[], error: String(error) }))
      if ('error' in probe && probe.error) run.observe('probe-turn-error', probe.error)
      const probeRows = reviewRows(probe.added)
      run.observe('probe — ReviewDiff rows', probeRows.map(row => ({ status: row.status, head: row.result.slice(0, 200) })))
      const started = probeRows.some(row => row.result.includes(STARTED_SENTENCE))
      run.check(
        'the background review STARTED on a review thread of its own',
        started,
        started
          ? undefined
          : probeRows.some(row => row.result.includes(INLINE_SENTENCE))
            ? 'the answer fell back to the inline template, which is what `startDetachedReview` returns `null` for: '
              + 'an app-server with no `review/start`, a refusal, an inline delivery, or no open thread. codex '
              + 'DECLINED the detached review — record that, not an absence of the capability'
            : `rows: ${JSON.stringify(probeRows.map(row => row.result.slice(0, 160)))}`,
      )

      // ---- THE REPORT-BACK — with the flush turn the notice needs ----------
      // One more prompt, because the notice is pushed onto a LIVE turn and HELD
      // for the next one otherwise (`surfaceCodexOperatorNotice`). A notice
      // already present before this turn also counts; see the docblock.
      await sendPrompt(session, key, 'While that runs: reply with the single word waiting.', 300_000)
        .catch(error => run.observe('flush-turn-error', String(error)))
      let notices = await waitFor(
        async () => findingsNotices(await transcript(session, key)),
        found => found.length > 0,
        { timeoutMs: 240_000, intervalMs: 5_000, label: 'the detached review to report its findings back' },
      ).catch(() => [] as string[])
      // A WAIT CANNOT FLUSH A HELD NOTICE, and that is what the wait above was
      // asked to do. `surfaceCodexOperatorNotice` pushes onto a LIVE turn and
      // otherwise HOLDS — so a review that finishes DURING this wait leaves the
      // notice in `pendingServerWarningNotices` with no turn to ride, and the
      // flush turn that already ran is the wrong side of it. Measured on the
      // 1.37.0 release build (RV, 2026-09-12, HEAD `10c12eb65`): both arms
      // started, the 240 s wait found nothing, and the case scored the read-back
      // absent with no turn ever offered to a held notice. So the wait is
      // followed by a SECOND flush turn, and the observation says which of the
      // two produced the notice — "never" is then a reading and not a gap.
      let arrivedOn = notices.length > 0 ? 'the wait itself (a live turn carried it)' : 'never'
      if (notices.length === 0) {
        await sendPrompt(session, key, 'Reply with the single word done.', 300_000)
          .catch(error => run.observe('second-flush-turn-error', String(error)))
        notices = findingsNotices(await transcript(session, key))
        if (notices.length > 0) arrivedOn = 'a LATER turn — it was held, not lost'
      }
      run.observe('the notice arrived on', arrivedOn)
      run.observe('findings notices', notices.map(notice => notice.slice(0, 400)))
      run.check(
        'the review thread reported its findings BACK into this session',
        notices.length > 0,
        notices.length > 0
          ? undefined
          : 'no info row carrying "Background review of …" after the review started, a wait, AND a second turn '
            + 'for a held notice to ride. `admitDetachedReviewNotification` drops the notice only when '
            + '`turn/completed` never named the review thread, so this is the read-back half failing, not the '
            + 'start half and not the holding queue',
      )
      const substantive = notices.some(notice => !notice.includes('with nothing to report'))
      run.observe('findings body', substantive
        ? 'the notice carries the reviewer\'s own findings'
        : 'the notice says "nothing to report" — the thread ran and produced no item text')
      run.check(
        'the findings name what was reviewed',
        notices.some(notice => /Background review of .+ finished/.test(notice)),
        notices.length > 0 ? JSON.stringify(notices.map(notice => notice.slice(0, 120))) : undefined,
      )
      run.observe('transcript grew by', (await transcript(session, key)).length - before)
    } finally {
      run.observe('permission-cards-answered', await approver.stop())
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. PACKAGED build, one content panel, a codex-runtime card signed in.',
    '2. `bun run scripts/cdp/cases/rs-37.ts` with NESSY_CDP_PORT pointed at the app. The case mints its own git repository under the OS temp dir, binds the session to it, answers the trust gate for that directory only, and removes it afterwards.',
    '3. It needs no env and no fixture. It BLOCKS when the host lists no codex-runtime connection.',
  ],
  expected: 'the inline arm answers with the "Delegate this to the <agent> agent" template; the background arm answers "… in the background on a review thread of its own"; and an info row carrying "Background review of <target> finished" arrives in the same session.',
  detector: 'the transcript\'s own `ReviewDiff` tool rows (`toolResult`) and the `info` row `surfaceCodexOperatorNotice` emits as an AgentEvent — which is persisted, unlike a host `sendEvent({type:"info"})`. NOT the app log: a packaged build writes none.',
  positiveControl: 'the SAME tool on the SAME diff with no `background`, which must answer with the inline delegation template — proving the tool, the diff and the session work, and that the background sentence is not the default.',
  doneMeans: 'C4.13\'s codex flip is live-proven end to end (start and report-back), or the run records which half codex declined, with the sentence it answered instead.',
  neverDo: 'point this at a repository the operator owns. `trustScratchProject` refuses any directory outside the OS temp dir, and the review runs a real reviewer over whatever diff it is given.',
  safety: 'the probe repository is created by the case and removed in a `finally`; nothing is written to the config dir.',
} as const satisfies SittingRecipe
