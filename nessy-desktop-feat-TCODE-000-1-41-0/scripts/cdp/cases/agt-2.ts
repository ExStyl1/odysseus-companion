/**
 * AGT-2 — the fork panel shows, steers and stops.
 *
 * docs/testing/cdp-live-checklist.md: a row per fork below the composer, its
 * transcript opens, a follow-up reaches it, stop works, a finished one dismisses.
 *
 * The previous result for this case was retracted as INVALID: it measured
 * `childState.children` for a fork that never started, because the command had
 * been typed as prose. Here the fork is started by SELECTING the palette entry,
 * and the case refuses to go on unless a child actually registers — so a zero is
 * a finding about registration, not about the harness.
 *
 * `AgentPanel.tsx` is the surface: `[data-testid="agent-panel"]`, rows
 * `agent-panel-row-<agentId>` carrying `data-fork` and `data-status`, buttons
 * `agent-panel-open-…`, `agent-panel-dismiss-…`, follow-up input
 * `agent-panel-followup-…` and `agent-panel-send-…`.
 *
 * **Two forks, because the four properties need the fork in two different
 * states.** Steering and reading a transcript need one that is still working;
 * stopping needs one that is still working *at the moment the button is pressed*,
 * which is not the same instant. Driving all four against a single fork meant the
 * long task raced the case: 250 sentences arrive in about a minute, so by the
 * time the follow-up had been typed the fork had finished, `steer_child` had
 * nothing to steer, and the stop "passed" against a fork that stopped itself.
 * Fork A is steered and read; fork B is started and stopped immediately.
 */

import type { CdpSession } from '../lib/connect.ts'
import { forkStartFailure, seedForkableConversation, startFork, waitForForkSettled } from '../lib/fork.ts'
import { typeText } from '../lib/keys.ts'
import { main, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  freshSession,
  piChildren,
  piRuntime,
  readChildTranscript,
  requireReadablePiRuntime,
  selectorCount,
  selectorText,
  waitFor,
} from '../lib/state.ts'
import { clickSelector } from '../lib/viewport.ts'

const ID = 'AGT-2'
const TITLE = 'Fork panel: a row per fork, transcript opens, follow-up reaches it, stop and dismiss work'

/**
 * Long enough to observe, dependent on nothing outside the conversation, and
 * work the model will actually agree to do.
 *
 * Three earlier wordings failed in three different ways, and the third is the
 * one worth remembering. Reading two repo files needs a cwd a case-created
 * session does not have, so the fork died in seconds. Forty numbers finished
 * before the case could steer or stop it. Four hundred numbers then made the
 * fork **refuse outright** — "I'm going to respectfully decline… token
 * efficiency… practical utility" — and a refusal completes even faster than the
 * work would have. A padding task scaled up far enough stops being a long task
 * and becomes an instant one.
 *
 * So the task has to be genuinely worth doing AND genuinely long: real prose the
 * model will produce at length, rather than busywork it will talk its way out of.
 */
/**
 * "As chat text only, no tools" is load-bearing. On 2026-07-31 a run's model
 * decided to CREATE the explanations as markdown files, hit `Write`, and its
 * permission prompt — correctly surfaced in the parent since the L5 fix —
 * replaced the composer with the structured card, so the case could neither
 * steer (Pi delivers a steer after the current tool finishes, and the tool was
 * waiting on an approval nobody answers) nor start its second fork
 * (`composer-not-focusable`). A fork task in this case must never reach a
 * permission prompt; AGT-3 owns that path.
 */
const LONG_TASK =
  'Write a thorough, well-structured technical explanation of how B-tree indexes work in databases — '
  + 'around 1500 words, with sections and worked examples. Then write a second explanation of the same '
  + 'length covering how LSM-tree storage differs and when each is the better choice. Be detailed. '
  + 'Write everything as plain chat text in your reply only — do not create files and do not use any tools.'

/** Distinctive enough to find in the child's own output, and hard to miss. */
const FOLLOW_UP = 'IMPORTANT ADDITIONAL INSTRUCTION: end your reply with the exact line PINEAPPLE-ACK.'
const FOLLOW_UP_MARKER = 'PINEAPPLE-ACK'

/** `agentPanel.transcriptEmpty`, in both shipped locales. */
const TRANSCRIPT_EMPTY = /No output yet\.|Пока нет вывода\./

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  // A fork needs something to fork FROM: `/subtask` in a never-used session is
  // refused before it starts. Without this the case measures the panel's
  // rendering of a fork the app correctly declined to run.
  await seedForkableConversation(session, key)

  const started = await startFork(session, key, LONG_TASK)
  run.observe('composer-after-selection', started.selection.selection.composerAfter)

  // ---- the fork registers --------------------------------------------------
  run.observe('children', started.children)
  run.require(
    'the fork registered in childState.children',
    started.child !== undefined,
    started.child ? undefined : 'zero children means the panel has nothing to render — the defect is registration, not the panel',
  )

  const fork = started.child!
  run.observe('fork-child', fork)
  // A refused fork registers as a child too, so "children is non-empty" is true
  // for one that never ran. Steering and stopping are meaningless against it.
  const refused = forkStartFailure(fork)
  run.require('the fork actually started', refused === undefined, refused)

  // ---- the panel renders a row for it --------------------------------------
  // The row wait comes FIRST. The panel mounts on the renderer's invalidation
  // event, which lands after the child is already in `childState.children`, so
  // asserting the mount the instant registration is observed fails on a panel
  // that is about to appear — a race in the check, not a missing surface.
  const rowSelector = `[data-testid="agent-panel-row-${cssEscape(fork.agentId)}"]`
  await waitFor(() => selectorCount(session, rowSelector), n => n > 0, { timeoutMs: 20_000, intervalMs: 1_000, label: 'a panel row for the fork' })
  run.check('the agent panel is mounted', (await selectorCount(session, '[data-testid="agent-panel"]')) > 0)
  run.observe('row-text', await selectorText(session, rowSelector))
  const forkFlag = await session.call<string | null>(`
    const el = document.querySelector(${JSON.stringify(rowSelector)})
    return el ? el.getAttribute('data-fork') : null
  `)
  run.check('the row is marked as a fork', forkFlag === 'true', `data-fork=${forkFlag}`)

  // ---- its transcript opens ------------------------------------------------
  const openSelector = `[data-testid="agent-panel-open-${cssEscape(fork.agentId)}"]`
  const transcriptSelector = `[data-testid="agent-panel-transcript-${cssEscape(fork.agentId)}"]`
  await clickSelector(session, openSelector)
  const expanded = await waitFor(() => selectorCount(session, transcriptSelector), n => n > 0, { timeoutMs: 15_000, intervalMs: 500, label: "the fork's transcript to expand" })
    .catch(() => 0)
  run.require('the transcript expands', expanded > 0, `transcript panes: ${expanded}`)

  // ---- the follow-up goes in FIRST, while the fork is still working --------
  // Order matters, and cost a run to learn. Waiting for the transcript to carry
  // real output takes long enough that the fork finishes, and `steer_child` then
  // has nothing to steer. So the steer is sent immediately after the pane opens
  // and its EFFECT is verified below.
  const followUpSelector = `[data-testid="agent-panel-followup-${cssEscape(fork.agentId)}"]`
  await clickSelector(session, followUpSelector)
  await typeText(session, FOLLOW_UP, { charDelayMs: 4 })
  const typed = await session.call<string>(`
    const el = document.querySelector(${JSON.stringify(followUpSelector)})
    return el ? el.value : ''
  `)
  run.require('the follow-up text reached the input', typed.length > 0, JSON.stringify(typed))
  const beforeFollowUp = (await readChildTranscript(session, key, fork.agentId, 0)).output
  const liveAtFollowUp = (await piChildren(session, key, 'the fork at follow-up'))
    .find(c => c.agentId === fork.agentId)
  run.observe('child-status-at-followup', liveAtFollowUp?.status ?? 'gone')
  await clickSelector(session, `[data-testid="agent-panel-send-${cssEscape(fork.agentId)}"]`)
  // The clear is a DELIVERY RECEIPT, not a UI reflex: `submitFollowUp` awaits
  // the steer control round-trip and clears only on ok (a refusal keeps the
  // user's text and renders an alert instead — the L5 decision). Reading the
  // value synchronously after the click raced that await and filed a false
  // FAIL against a steer that demonstrably arrived (2026-07-31 wave).
  const errorSelector = `[data-testid="agent-panel-error-${cssEscape(fork.agentId)}"]`
  const sendSettled = await waitFor(
    async () => ({
      value: await session.call<string>(`
        const el = document.querySelector(${JSON.stringify(followUpSelector)})
        return el ? el.value : ''
      `),
      refusals: await selectorCount(session, errorSelector),
    }),
    state => state.value === '' || state.refusals > 0,
    { timeoutMs: 15_000, intervalMs: 500, label: 'the follow-up to clear (delivered) or refuse (alert)' },
  ).catch(async () => ({
    value: await session.call<string>(`
      const el = document.querySelector(${JSON.stringify(followUpSelector)})
      return el ? el.value : ''
    `),
    refusals: await selectorCount(session, errorSelector),
  }))
  run.check(
    'sending clears the follow-up box (the panel accepted it)',
    sendSettled.value === '' && sendSettled.refusals === 0,
    JSON.stringify(sendSettled),
  )

  // An expanded pane is not a transcript. `openTranscript` fetches ONCE per
  // open, from a stored cursor, so a pane opened the moment the fork started
  // holds the "No output yet." empty state and holds it forever — and a check
  // for "the pane has some text" passes on that placeholder. Re-open to refetch,
  // which is also exactly what a watching user does.
  const liveText = await waitFor(
    async () => {
      const current = (await selectorText(session, transcriptSelector))[0] ?? ''
      if (!TRANSCRIPT_EMPTY.test(current)) return current
      await clickSelector(session, openSelector).catch(() => undefined)
      await clickSelector(session, openSelector).catch(() => undefined)
      return (await selectorText(session, transcriptSelector))[0] ?? ''
    },
    text => text.length > 0 && !TRANSCRIPT_EMPTY.test(text),
    { timeoutMs: 90_000, intervalMs: 3_000, label: "the fork's transcript to carry output WHILE it runs" },
  ).catch(() => '')
  const liveChild = (await piChildren(session, key, 'the fork while it runs'))
    .find(c => c.agentId === fork.agentId)
  const liveRead = await readChildTranscript(session, key, fork.agentId, 0)
  run.observe('live-observation', {
    forkStatus: liveChild?.status ?? 'gone',
    paneShowsOutput: liveText.length > 0 && !TRANSCRIPT_EMPTY.test(liveText),
    readChildChars: liveRead.output.length,
  })

  // Whatever the live picture, the fork has to settle before the steer can be
  // judged: if `read_child` only serves a child's output once it is terminal,
  // then "nothing while running" is a statement about the OBSERVE half and says
  // nothing about whether the steer arrived. Separating the two is the whole
  // point of taking both readings.
  const settledChild = await waitForForkSettled(session, key, fork.agentId, 240_000)
  const settledRead = await readChildTranscript(session, key, fork.agentId, 0)
  run.observe('settled-observation', {
    forkStatus: settledChild?.status ?? 'gone',
    readChildChars: settledRead.output.length,
  })
  await clickSelector(session, openSelector).catch(() => undefined)
  await clickSelector(session, openSelector).catch(() => undefined)
  const settledPane = (await selectorText(session, transcriptSelector))[0] ?? ''
  run.observe('transcript-head', settledPane.slice(0, 300))

  const paneEverShowedOutput = (liveText.length > 0 && !TRANSCRIPT_EMPTY.test(liveText))
    || (settledPane.length > 0 && !TRANSCRIPT_EMPTY.test(settledPane))
  run.check(
    "the transcript shows the fork's own output",
    paneEverShowedOutput,
    paneEverShowedOutput ? undefined : 'the pane never left the empty state, running or settled — it renders, but it never shows what the fork did',
  )
  // The panel exists to watch a fork WHILE it works (`sub-agents.md:1019`:
  // "runs in the background while you keep working"). Output that only appears
  // once the fork is finished is a different, weaker feature — recorded rather
  // than asserted, because the checklist's wording is "open its transcript".
  run.observe('live-output-available', liveRead.output.length > 0
    ? `yes — ${liveRead.output.length} chars readable while the fork was ${liveChild?.status ?? 'gone'}`
    : `NO — read_child returned 0 chars while the fork was ${liveChild?.status ?? 'gone'}, `
      + `and ${settledRead.output.length} chars once it settled. The panel cannot show progress, only results.`)

  // "The panel accepted it" is not "it reached the fork". Look for the steer in
  // the CHILD's own transcript — a panel that renders but cannot steer is half
  // the feature, and clearing an input box is something a purely local handler
  // does just as well. The MARKER is the assertion; growth alone is not, because
  // a fork mid-answer grows whether or not it was ever steered.
  run.observe('child-transcript-tail', settledRead.output.slice(-400))
  run.check(
    'the follow-up reached the fork',
    settledRead.output.includes(FOLLOW_UP_MARKER),
    settledRead.output.includes(FOLLOW_UP_MARKER)
      ? undefined
      : `marker absent; child output ${beforeFollowUp.length} → ${settledRead.output.length} chars, and the fork was `
        + `${liveAtFollowUp?.status ?? 'gone'} when the follow-up was sent`
        + (liveAtFollowUp && /starting|running/.test(liveAtFollowUp.status)
          ? ' — it WAS live, so the steer had somewhere to go and did not arrive'
          : ' — it was already terminal, so this measures nothing and the task needs to be longer'),
  )

  // ---- stop: a SECOND fork, started in order to be stopped -----------------
  // Stopping needs a fork that is running at the instant the button is pressed,
  // and fork A has spent exactly that window being read and steered. Reusing it
  // meant the stop "passed" against a fork that had finished on its own — the
  // same shape of false pass this whole file exists to stop producing.
  const second = await startFork(session, key, LONG_TASK)
  run.observe('second-fork', second.child ?? null)
  run.require(
    'a second fork started, to be stopped',
    second.child !== undefined && forkStartFailure(second.child) === undefined,
    forkStartFailure(second.child) ?? (second.child ? undefined : 'no second child registered'),
  )
  const stopTarget = second.child!
  const stopRowSelector = `[data-testid="agent-panel-row-${cssEscape(stopTarget.agentId)}"]`
  const stopDismissSelector = `[data-testid="agent-panel-dismiss-${cssEscape(stopTarget.agentId)}"]`
  await waitFor(() => selectorCount(session, stopRowSelector), n => n > 0, { timeoutMs: 20_000, intervalMs: 1_000, label: 'a panel row for the second fork' })

  const liveBeforeStop = (await piChildren(session, key, 'the second fork before Stop'))
    .find(c => c.agentId === stopTarget.agentId)
  run.observe('child-before-stop', liveBeforeStop ?? null)
  run.require(
    'the second fork is still running when Stop is pressed',
    liveBeforeStop !== undefined && /starting|running/.test(liveBeforeStop.status),
    liveBeforeStop && /starting|running/.test(liveBeforeStop.status)
      ? undefined
      : `status=${liveBeforeStop?.status ?? 'gone'} — a stop pressed on a finished fork proves nothing`,
  )

  // `useAgentPanel.dismiss` sends `stop_child` for a running row and otherwise
  // just filters the row out locally, so the SAME button means two things and
  // has to be driven as two steps against the row's actual state.
  await clickSelector(session, stopDismissSelector)
  const stopped = await waitFor(
    () => piRuntime(session, key),
    r => {
      const child = r.children.find(c => c.agentId === stopTarget.agentId)
      return child === undefined || !/starting|running/.test(child.status)
    },
    { timeoutMs: 60_000, intervalMs: 2_000, label: 'the second fork to stop' },
  ).catch(() => piRuntime(session, key))
  // D1.265 — guarded because THIS check reads an absent child as SUCCESS
  // (`afterStop === undefined || …`): an unreadable snapshot would score the
  // stop as working without a single row having been read.
  requireReadablePiRuntime(stopped, 'the second fork after Stop')
  const afterStop = stopped.children.find(c => c.agentId === stopTarget.agentId)
  run.observe('child-after-stop', afterStop ?? null)
  run.check(
    'the fork stopped and the row reflects it',
    afterStop === undefined || !/starting|running/.test(afterStop.status),
    JSON.stringify(afterStop),
  )
  // `completed` is not proof the stop did anything: a fork that finished on its
  // own in the same window lands there too. Only `stopped`/`interrupted`
  // attribute the terminal state to the button. Recorded, not asserted — the
  // checklist's claim is that the row reflects the stop, and it does.
  run.observe('stop-attribution', afterStop === undefined
    ? 'the child left the snapshot entirely'
    : /stopped|interrupted/.test(afterStop.status)
      ? `attributable to the stop (${afterStop.status})`
      : `NOT attributable: status is ${afterStop.status}, which a self-finishing fork also reaches`)

  // ---- dismiss a finished one, and it must STAY dismissed ------------------
  // `useAgentPanel.dismiss` drops a finished row from local state only; the
  // child record lives on in `childState.children`, so any later `children`
  // invalidation calls `reload()` and rebuilds the rows from the snapshot.
  // Whether the row comes back is the difference between "dismiss works" and
  // "dismiss blinks", and the two are told apart here rather than left to
  // whichever moment the assertion happened to sample.
  if ((await selectorCount(session, stopRowSelector)) > 0) await clickSelector(session, stopDismissSelector)
  const gone = await waitFor(
    () => selectorCount(session, stopRowSelector),
    n => n === 0,
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'the finished row to be dismissed' },
  ).catch(() => -1)
  if (gone !== 0) {
    run.check('a finished fork dismisses', false, `the row never left the panel (rows still present after 20s: ${await selectorCount(session, stopRowSelector)})`)
  } else {
    await Bun.sleep(6_000)
    const returned = await selectorCount(session, stopRowSelector)
    run.observe('rows-after-dismiss-settle', returned)
    run.check(
      'a finished fork dismisses',
      returned === 0,
      returned === 0 ? undefined : 'the row was dismissed and then CAME BACK — the panel rebuilds rows from childState on the next invalidation, so dismissal does not survive one',
    )
  }
}

/** Agent ids are opaque; keep them safe inside an attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
