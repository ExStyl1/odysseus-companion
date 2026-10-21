/**
 * NCA-6 — a rate-limited remote turn shows honest retry status and then
 * completes.
 *
 * ## The status lines are TRANSIENT, and that decides the whole design
 *
 * `SessionManager`'s `case 'status'` only `sendEvent`s — it appends nothing to
 * the session and persists nothing (`SessionManager.ts:24055-24072`), and the
 * renderer drops every `role: 'status'` row again on interrupt
 * (`event-processor/handlers/session.ts` `handleInterrupted`). So the retry
 * lines exist **only while the turn is in flight, only in the rendered pane**.
 *
 * A case that sent the prompt, waited for the turn, and then read
 * `getSessionMessages` would find nothing and report that no retry status was
 * shown — about a turn that showed several. This case therefore watches the
 * chat pane WHILE the turn runs, and the watcher is started before the prompt.
 *
 * ## The precondition is genuinely the operator's, and the case says so twice
 *
 * A 429 cannot be manufactured from here: the budget is the gateway's, the
 * limiter is per user, and reading `/quota` deliberately does not consume it
 * (`quota_handler.go` is outside `userLimitMiddleware`). So the case:
 *
 * 1. reads `/quota` FIRST and requires the backend's own `status.state` to say
 *    the budget is under pressure — `exhausted`, or `warning`. An `allowed`
 *    state means a 429 is not reachable and the case BLOCKS with that fact,
 *    rather than sending a prompt and reporting "no retry line" as a failure;
 * 2. BLOCKS again if the turn ran without a retry line, naming the two causes
 *    (the limiter did not fire; or it fired after the watcher stopped).
 *
 * `NESSY_CDP_NESTOR_RATE_LIMIT=1` is the operator's assertion that a limit is in
 * force; without it the case does not even spend a turn.
 *
 * ## What the assertions actually pin
 *
 * The retry line is matched against the backend's own template, EM-DASH included
 * (`nestor-cloud/turn.ts:206-210` and `:259-262` — two producers, one string):
 *
 *     Nestor rate limit — retrying in <N>s (attempt <A>/10)...
 *
 * and the attempt counter must be inside `1..RATE_LIMIT_MAX_RETRIES`. A line
 * that said `attempt 14/10` would be a real finding; a substring match on
 * "rate limit" would never have found it.
 */

import { lastAssistantText, sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import {
  CLOUD_PROVIDER_TYPE,
  QUOTA_STRINGS,
  chatPaneText,
  cloudTranscript,
  composerCapabilities,
  createSessionOn,
  currentWorkspaceId,
  openSessionInUi,
  requireCloudConnection,
  waitForChatText,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-6'
const TITLE = 'A rate-limited remote turn shows the backend\'s own retry status with a bounded attempt counter, and then completes'

/** `nestor-cloud/retry.ts:25` — the cap the attempt counter is printed against. */
const RATE_LIMIT_MAX_RETRIES = 10

/** `turn.ts:206-210` / `:259-262`, verbatim up to the two numbers. */
const RETRY_LINE = /Nestor rate limit — retrying in (\d+)s \(attempt (\d+)\/(\d+)\)\.\.\./g

/** The 5xx sibling, recorded but not required (`turn.ts:210`). */
const SERVER_RETRY_LINE = /Nestor request failed \((\d+)\) — retrying\.\.\./

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  if (process.env.NESSY_CDP_NESTOR_RATE_LIMIT?.trim() !== '1') {
    blocked(
      'this case needs a genuinely rate-limited gateway and cannot create one: the budget is per user, it is the '
      + 'gateway\'s to spend, and reading /quota deliberately does not consume it. Set '
      + 'NESSY_CDP_NESTOR_RATE_LIMIT=1 when the account\'s budget is exhausted (or an operator-side limit is in '
      + 'force) and re-run. Without that assertion this case will not spend a turn to discover the obvious.',
    )
  }

  const cloud = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG,
    purpose: 'NCA-6',
  })
  run.observe('cloud connection', { slug: cloud.slug, baseUrl: cloud.baseUrl ?? '(built-in)' })

  const workspaceId = await currentWorkspaceId(session)
  const key = await createSessionOn(run, session, { workspaceId, slug: cloud.slug, label: 'ratelimit', caseId: ID })
  if (!key) blocked('could not create a session on the remote-agent connection')
  run.check('the pane followed the new session', await openSessionInUi(session, key), key.sessionId)

  const caps = await composerCapabilities(session, key.sessionId)
  run.require(
    'the session reports the remote agent as its active runtime',
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )

  // --- the precondition, read from the gateway rather than assumed --------
  await sendSlashCommand(session, key, {
    token: 'quota',
    match: /quota/i,
    expectComposer: '',
    submitOnSelect: true,
    timeoutMs: 180_000,
  })
  const quota = await waitForChatText(
    session,
    text => text.includes(QUOTA_STRINGS.head)
      || text.includes(QUOTA_STRINGS.unavailablePrefix)
      || text.includes(QUOTA_STRINGS.noLimits),
    { label: 'the /quota render', timeoutMs: 60_000 },
  )
  run.observe('quota render', quota.text.slice(-600))
  const underPressure = /\((exhausted|warning)\)/i.test(quota.text)
  run.observe('budget state read off the backend\'s own status', underPressure ? 'exhausted/warning' : 'not under pressure')
  if (!underPressure) {
    blocked(
      'the gateway\'s own limit status does not report `exhausted` or `warning`, so a 429 is not reachable on this '
      + 'account right now and any absence of a retry line below would say nothing. `quota_handler.go:18` makes '
      + '`status` the authority here — the percentage is not, and this case does not second-guess it. What /quota '
      + `rendered: ${JSON.stringify(quota.text.slice(-400))}`,
    )
  }

  // --- watch the pane WHILE the turn runs ---------------------------------
  const seen: string[] = []
  let watching = true
  const watcher = (async () => {
    while (watching) {
      const text = await chatPaneText(session).catch(() => '')
      for (const match of text.matchAll(RETRY_LINE)) {
        if (!seen.includes(match[0])) seen.push(match[0])
      }
      const server = SERVER_RETRY_LINE.exec(text)
      if (server && !seen.includes(server[0])) seen.push(server[0])
      await Bun.sleep(700)
    }
  })()

  let answer = ''
  try {
    const turn = await sendPrompt(
      session,
      key,
      'In two sentences, say what a rate limit is. Keep it short.',
      900_000,
    )
    answer = lastAssistantText(turn.added)
  } finally {
    watching = false
    await watcher
  }
  run.observe('retry status lines seen while the turn was in flight', seen)
  run.observe('final answer', answer.slice(0, 300))

  const rateLines = seen.filter(line => line.startsWith('Nestor rate limit'))
  if (rateLines.length === 0) {
    blocked(
      'the turn ran without a rate-limit retry line. Two causes to separate before reading anything into it: the '
      + 'limiter did not fire on this turn (the budget recovered, or this account is not the metered one), or it '
      + 'fired outside the pane watcher\'s window. The status lines are transient and renderer-only — they are never '
      + 'in `getSessionMessages` — so a later read cannot recover them. '
      + `What the pane held at the end: ${JSON.stringify((await chatPaneText(session).catch(() => '')).slice(-400))}`,
    )
  }

  run.check('the retry status uses the backend\'s own wording', rateLines.length > 0, rateLines.join(' | '))

  // The counter is the honesty claim: a status that said "retrying" forever, or
  // counted past its own cap, is the dishonest version of this feature.
  const attempts = rateLines.map(line => {
    const m = /\(attempt (\d+)\/(\d+)\)/.exec(line)
    return m ? { attempt: Number(m[1]), cap: Number(m[2]) } : undefined
  }).filter((v): v is { attempt: number; cap: number } => Boolean(v))
  run.observe('attempt counters', attempts)
  run.check(
    'every retry names its attempt out of the real cap',
    attempts.length === rateLines.length && attempts.every(a => a.cap === RATE_LIMIT_MAX_RETRIES),
    JSON.stringify(attempts),
  )
  run.check(
    'no attempt number exceeds the cap',
    attempts.every(a => a.attempt >= 1 && a.attempt <= RATE_LIMIT_MAX_RETRIES),
    JSON.stringify(attempts.map(a => a.attempt)),
  )

  // --- and then it completes ----------------------------------------------
  const after = await cloudTranscript(session, key)
  const errors = after.filter(m => m.role === 'error')
  run.observe('error rows', errors.map(m => m.content.slice(0, 300)))
  run.check(
    'the turn completed with an answer rather than an error',
    answer.trim().length > 0 && errors.length === 0,
    errors.length > 0 ? errors.map(m => m.content.slice(0, 200)).join(' | ') : `${answer.length} chars`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
