/**
 * RS-46 (D1.14) — `/tasks` and `/workflows` are CONSUMED by the host, and each
 * leaves the row it is supposed to leave, measured beside two commands the host
 * consumes at the seam and persists nothing for.
 *
 * ## This case was INVERTED on 2026-09-18 (D1.326), and the inversion is the point
 *
 * Until then it asserted D1.14's PREMISE: that neither token has a parser row,
 * so the text reaches the MODEL as prose and an `assistant` row answers it. That
 * premise was true when the row was written and it is FALSE on the packaged
 * 1.40.0 — by design, because D1.14 is the row that built the parser. Driven as
 * written on that build the case reads **FAIL 6 of 8** while the product is
 * correct, and a case that reddens on the fix is a case the next sitting learns
 * to discount. `TASKS_PATTERN` and `WORKFLOWS_PATTERN`
 * (`packages/shared/src/slash-commands/session-command.ts`) are in the table
 * now, and `SessionManager.runTasksSessionCommand` /
 * `runWorkflowsListSessionCommand` are what answer them.
 *
 * The four tokens and the two arms are unchanged; what moved is which way each
 * subject check points and the addition of a DURABILITY check the old shape had
 * no use for.
 *
 * ## The discriminator, and it is still the ASSISTANT row
 *
 * The obvious detector — *an `info` row lands in the transcript* — is wrong as a
 * test of CONSUMPTION, and it was wrong on this case's own first drive. Measured
 * 2026-09-17 on the packaged 1.39.0: `/help`, a command `parseSessionCommand`
 * demonstrably carries, produced NO non-user row at all in 45 s while its
 * listing was plainly on screen, so a case using the info row as its control
 * scores its own instrument a failure and cannot read anything below it.
 *
 * So consumption is read off the assistant row, for all four tokens:
 *
 * - the host CONSUMED it ⟺ no `assistant` row answers, whatever else appears;
 * - the text reached the MODEL ⟺ an `assistant` row answers it (on a tool-using
 *   runtime, usually with a `tool` row beside it).
 *
 * ## …and the SECOND reading is the durable row, which only two of the four owe
 *
 * `/help`, `/status`, `/mcp`, `/diff` and `/hooks` answer at the `BaseAgent.chat`
 * seam with a bare `yield { type: 'info' }`: that reaches the screen and does NOT
 * reach `getSessionMessages`. `/tasks` and `/workflows` deliberately do not —
 * `runTasksSessionCommand`'s own docblock cites THIS case's 1.39.0 reading as the
 * reason and routes the answer through `recordSessionInfoEntry`, whose whole
 * distinction is durability.
 *
 * That gives the case a detector it can read from a source the feature itself
 * writes, and a discrimination control that does not depend on the two seam
 * commands staying silent:
 *
 * - `/tasks` answers with the WHOLE inventory —
 *   `SESSION_SCHEDULED_WORK_EMPTY_LINE`, *"This session is holding no background
 *   work and has nothing scheduled."*, on a session with nothing queued, or the
 *   listing's own two headers when something is;
 * - `/workflows` answers with the RUNNING-only view — *"No background work is
 *   running in this session right now."*, which points AT `/tasks` precisely
 *   because it filtered the scheduled half out.
 *
 * The two sentences DIFFER on one and the same session, so "an `info` row landed"
 * is never banked as "this command's own answer landed": each subject arm asserts
 * the sentence its own handler writes and refuses the sibling's. A build that
 * wrote one generic row for both would fail the pair while passing either alone.
 *
 * The seam controls keep their observation — whether anything durable lands for
 * `/help` and `/status` — as a READING and not a check, because a host that later
 * decides to persist a seam answer would be improving the product, and a guard
 * that reddens on that is the stale-guard shape this repo pays for elsewhere.
 *
 * ## The controls
 *
 * TWO seam commands, of two different kinds, because a single one that broke
 * would take the whole reading with it: `/help` (its own `HELP_PATTERN`) and
 * `/status` (one of the four `SEAM_READ_PATTERNS`). Both must be consumed — if
 * either reaches the model, the assistant-row discriminator does not separate the
 * two outcomes on this build and nothing below it can be read.
 *
 * The palette arm has its own control: the row offered for `help` must be found,
 * or "no row is offered for `tasks`" is equally true of a probe that cannot see a
 * palette at all.
 *
 * ## The palette arm is a READING now, and that is a deliberate loss of a check
 *
 * It used to assert that no row is NAMED `tasks` or `workflows`, because a row
 * the palette offers and nothing dispatches is `P3.71`'s advertised-then-refused
 * shape. That shape cannot exist once `parseSessionCommand` carries both names,
 * so the check no longer discriminates anything; kept, it would assert a
 * DISCOVERABILITY posture no row states — the palette not advertising a command
 * the host parses is the opposite and much smaller complaint. It is recorded
 * with the offered rows beside it so a sitting can raise it if the owner wants
 * it raised. (Measured at HEAD: `slash-command-actions.ts` spells neither token.)
 *
 * ## Typed, not selected — and why that is not a weaker reading
 *
 * The palette's own Help entry submits the identical text: `slash-command-actions.ts`
 * maps `help` to the string `/help` and only `/subtask` prefills instead of
 * submitting. So typing and selecting reach the same submit path, and the case
 * types — which is also the only option for two tokens the palette has no row for.
 *
 * ## Matching a palette row, and the trap in it
 *
 * `peekPalette` returns each row's VISIBLE TEXT, which carries the description as
 * well as the name. On the first drive `/tasks` "matched" `/gsd-capture Capture
 * ideas, tasks, notes…` and `/workflows` matched a plugin whose description
 * contains the word — two false positives that read as a product defect. A row is
 * therefore matched on its FIRST WORD only, with the leading slash stripped.
 *
 * ## Why one session and not three
 *
 * The parser is HOST code with no provider argument — one table, read before any
 * runtime is consulted — and `runTasksSessionCommand` is dispatched from
 * `SessionManager` ahead of every backend, so a per-runtime drive would measure
 * the same two functions three times. The case records the card that answered
 * rather than implying it measured all three; the ledger hand-back says which
 * cell is driven and which is derived from the dispatch being provider-blind.
 *
 * ## Safety
 *
 * No credential is read or written. All four tokens are consumed by the host on
 * this build, so no turn reaches a model at all; the case creates no connection
 * and switches none.
 */

import { clearComposer, focusComposer, paletteState, peekPalette, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, isProcessing, transcript, waitFor, type SessionKey, type TranscriptMessage } from '../lib/state.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-46'
const TITLE = 'the two documented commands the host now parses, measured beside two it consumes at the seam'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.14',
  runtimes: ['pi'],
  credentials:
    'whatever card the profile already has — the case creates none and switches none. Run it on a NESSY_CONFIG_DIR '
    + 'created for the run, after the onboarding has been passed, so the session it makes is its own.',
} as const satisfies CaseMeta

/**
 * A durable `info` row the HOST writes, named by a sentence its own handler
 * produces rather than by a shape.
 *
 * One needle per branch the handler can take on a session this case created, so
 * a session that happens to be holding work reads as correctly as an empty one.
 * The `notNeedles` field is the discrimination: the sibling command's sentence,
 * on the same session, must NOT be what answered.
 */
interface DurableAnswer {
  /** Any ONE of these, verbatim from the handler's own source. */
  readonly needles: readonly string[]
  /** The SIBLING subject's sentence — banking it would be reading the wrong row. */
  readonly notNeedles: readonly string[]
  /** Where the sentence is written, for the failure message. */
  readonly writtenBy: string
}

const TASKS_ANSWER: DurableAnswer = {
  needles: [
    // `SESSION_SCHEDULED_WORK_EMPTY_LINE` — a session holding nothing.
    'This session is holding no background work and has nothing scheduled.',
    // `formatSessionScheduledWorkReport`'s two listing headers.
    'Background work in this session right now:',
    'Scheduled to run later:',
    // The unavailable line, which is an answer and not a silence.
    'background work could not be read here',
  ],
  notNeedles: ['No background work is running in this session right now.'],
  writtenBy: 'SessionManager.runTasksSessionCommand via formatSessionScheduledWorkReport',
}

const WORKFLOWS_ANSWER: DurableAnswer = {
  needles: [
    'No background work is running in this session right now.',
    // The non-empty branch appends this to the same formatter's output.
    'Run `/workflows stop` to stop all of it.',
    'Background work in this session right now:',
  ],
  notNeedles: ['This session is holding no background work and has nothing scheduled.'],
  writtenBy: 'SessionManager.runWorkflowsListSessionCommand',
}

/**
 * The four tokens.
 *
 * ALL FOUR are consumed by the host at HEAD; `durable` is what separates the two
 * subjects from the two controls. `/help` and `/status` answer at the
 * `BaseAgent.chat` seam and persist nothing (measured on the packaged 1.39.0 by
 * this case); `/tasks` and `/workflows` go through `recordSessionInfoEntry`.
 */
const COMMANDS: ReadonlyArray<{ token: string; durable: DurableAnswer | undefined }> = [
  { token: 'help', durable: undefined },
  { token: 'status', durable: undefined },
  { token: 'tasks', durable: TASKS_ANSWER },
  { token: 'workflows', durable: WORKFLOWS_ANSWER },
]

/** A palette row's own NAME — its first word, with any leading slash stripped. */
function rowName(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? '').replace(/^\//, '').toLowerCase()
}

interface Submitted {
  /** What the composer held at the moment Enter was pressed. */
  readonly submitted: string
  /** Every row that landed after the submit, oldest first. */
  readonly rows: readonly { role: string; text: string }[]
  /** Milliseconds from the submit to the first non-user row, or the full wait. */
  readonly ms: number
}

/**
 * Type `/<token>` and submit it as TEXT.
 *
 * Lifted in shape from `rs-39.ts`'s `typeQuota`, for its reason: the palette
 * opens on the slash token whether or not it has a match, and `submitComposer`
 * refuses to press Enter while it is open — correctly, because Enter would
 * select a row instead of sending. Escape first, then re-read the composer, so
 * an Escape that also cleared it cannot be misread as an empty reply.
 */
async function typeAndSubmit(session: CdpSession, key: SessionKey, token: string): Promise<Submitted> {
  // Idle FIRST. Measured on this case's second drive: the `/tasks` turn was
  // still streaming when `/workflows` was submitted, so the slice for the
  // `/workflows` arm opened with `/tasks`'s assistant row — the arm passed on
  // another arm's evidence, in 79 ms. A per-arm verdict needs a quiet session.
  await waitFor(
    () => isProcessing(session, key),
    busy => busy === false,
    { timeoutMs: 120_000, intervalMs: 1_000, label: `the session to go idle before /${token}` },
  ).catch(() => undefined)
  const before = (await transcript(session, key)).length
  await focusComposer(session)
  await clearComposer(session)
  await typeIntoComposer(session, `/${token}`, { charDelayMs: 12 })
  await Bun.sleep(600)
  const palette = await paletteState(session).catch(() => ({ open: false, items: [] as unknown[] }))
  if ((palette as { open?: boolean }).open) {
    await pressKey(session, 'Escape')
    await Bun.sleep(400)
  }
  const submitted = await session.call<string>(`
    const el = document.querySelector(${JSON.stringify('div[data-tutorial="chat-input"][role="textbox"][aria-multiline="true"]')})
    return el ? (el.innerText || '').trim() : ''
  `)
  const started = Date.now()
  await submitComposer(session)
  // Wait for an ASSISTANT row, not for the count to move: the submitted text
  // lands as a `user` row at once, which satisfies `count > before` before
  // anything has answered. 45 s for `rs-39.ts`'s measured reason — the question
  // is whether the HOST consumed it, which it answers in milliseconds, while a
  // model asked to answer `/tasks` as prose can take minutes to say something
  // irrelevant. A consumed command spends the whole budget by construction.
  await waitFor(
    async () => (await transcript(session, key)).slice(before).filter(message => message.role === 'assistant').length,
    count => count > 0,
    { timeoutMs: 45_000, intervalMs: 500, label: `an assistant reply to /${token}` },
  ).catch(() => 0)
  const ms = Date.now() - started
  await Bun.sleep(1_500)
  const rows = (await transcript(session, key))
    .slice(before)
    .map((message: TranscriptMessage) => ({ role: message.role, text: (message.content ?? '').slice(0, 400) }))
  return { submitted, rows, ms }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const cards = await session.call<Array<{ slug: string; providerType: string }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('the cards this profile has', cards)
  if (cards.length === 0) {
    blocked(
      'this profile lists no LLM connection, so no session can run a turn and a command that reached the MODEL could '
      + 'not be told from a session that never reached one — which is the discriminator every arm below rests on. Run '
      + 'RS-32 first: it presses the onboarding\'s own one-click button.',
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.reason ?? '')
  const bound = await session.call<string | undefined>(`
    const rows = await window.electronAPI.getSessions()
    const row = (rows ?? []).find(s => s.id === ${JSON.stringify(key.sessionId)})
    return row?.connectionSlug ?? row?.llmConnectionSlug ?? undefined
  `).catch(() => undefined)
  run.observe('the card that answered', bound ?? cards[0]?.slug ?? '(unknown)')

  // ---- arm 1: the palette -------------------------------------------------
  // A READING for the two subjects since D1.326; see the header. The `help`
  // control stays a check, because every empty reading here is equally true of a
  // probe that cannot see a palette at all.
  for (const command of COMMANDS) {
    const offered = await peekPalette(session, command.token).catch(() => [] as string[])
    const named = offered.filter(text => rowName(text) === command.token)
    run.observe(`/${command.token} — what the palette offers`, { named, all: offered.slice(0, 4) })
    if (command.token === 'help') {
      run.check(
        'THE CONTROL — the palette offers a row NAMED "help"',
        named.length > 0,
        'the palette offers no row named for a command the host demonstrably parses, so every empty reading below is '
        + 'equally true of a probe that cannot see a palette at all',
      )
    } else if (command.durable) {
      run.observe(
        `/${command.token} — is a command the host PARSES also advertised?`,
        named.length > 0
          ? `yes — the palette names it: ${named.join(' | ')}`
          : 'NO — the host parses this token and the palette offers no row of that name. Recorded, not scored: that is '
            + 'a discoverability complaint, and the advertised-then-refused shape this arm used to guard against '
            + 'cannot exist once the parser carries the name.',
      )
    }
  }

  // ---- arm 2: what answers ------------------------------------------------
  for (const command of COMMANDS) {
    const result = await typeAndSubmit(session, key, command.token)
    const assistant = result.rows.filter(row => row.role === 'assistant')
    const hostRows = result.rows.filter(row => row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool')
    run.observe(`/${command.token} — what answered`, {
      submitted: result.submitted,
      msWaited: result.ms,
      roles: result.rows.map(row => row.role),
      rows: result.rows.map(row => `${row.role}: ${row.text.slice(0, 200)}`),
    })

    // Every one of the four is consumed on this build. For the two seam
    // commands that is THE CONTROL the subjects are read against; for the two
    // subjects it is half of D1.14's own answer.
    run.check(
      command.durable
        ? `/${command.token} — the HOST consumes it and the text never reaches the model (D1.14)`
        : `THE CONTROL — /${command.token} is CONSUMED by the host and never reaches the model`,
      assistant.length === 0,
      command.durable
        ? `an assistant row answered /${command.token}, so the host did NOT consume it on this build — the parser row `
          + '`parseSessionCommand` carries at HEAD is not reached by the packaged dispatch'
        : 'a command the parser demonstrably carries was answered by the MODEL, so the discriminator this case rests '
          + 'on does not separate the two outcomes on this build and nothing below it can be read',
    )

    if (!command.durable) {
      // Recorded, never asserted: whether a SEAM answer persists is a different
      // question from whether the host parsed the command, and on the packaged
      // 1.39.0 and 1.40.0 the answer is no for both controls. A check here would
      // redden the day the host decides to persist one, which would be an
      // improvement.
      run.observe(
        `/${command.token} — does the host's own answer reach the transcript?`,
        hostRows.length > 0
          ? `yes: ${hostRows.map(row => `${row.role}: ${row.text.slice(0, 120)}`).join(' | ')}`
          : 'NO — the command was consumed at the `BaseAgent.chat` seam and nothing was persisted for the user to '
            + 'read. That is the seam posture `runTasksSessionCommand` cites as its reason for NOT using it.',
      )
      // And the second half of that finding: `getSessionMessages` is a STORE
      // read, so its silence would be explained by a transient on-screen surface
      // the store never sees. This reads the chat pane's own text for the token,
      // so the residue is "nowhere" rather than "not in the store".
      run.observe(
        `/${command.token} — and does anything on SCREEN answer it?`,
        await session.call<string>(`
          const pane = document.querySelector('[data-testid="chat-display"]') ?? document.body
          const text = (pane.innerText || '').replace(/\\s+/g, ' ')
          return text.length > 1200 ? text.slice(-1200) : text
        `).catch(() => '(unreadable)'),
      )
      continue
    }

    // The DURABLE half, and it is read off the handler's own sentence rather
    // than off the shape of the row: an `info` row appearing proves only that
    // something wrote one.
    const durable = command.durable
    const infoRows = result.rows.filter(row => row.role === 'info')
    const answering = infoRows.filter(row => durable.needles.some(needle => row.text.includes(needle)))
    const sibling = infoRows.filter(row => durable.notNeedles.some(needle => row.text.includes(needle)))
    run.observe(`/${command.token} — the durable rows it left`, {
      infoRows: infoRows.map(row => row.text.slice(0, 200)),
      matchedItsOwnSentence: answering.length,
      matchedTheSIBLINGSentence: sibling.length,
    })
    run.check(
      `/${command.token} — the host leaves its OWN durable transcript row (${durable.writtenBy})`,
      answering.length > 0,
      `no \`info\` row after /${command.token} carries any sentence that handler writes. The command was consumed `
      + '(checked above), so the answer went to the screen only and does not survive a reload — which is the exact '
      + 'property `recordSessionInfoEntry` was chosen for over the seam\'s `yield { type: \'info\' }`',
    )
    run.check(
      `/${command.token} — and it is that command's answer, not the sibling's (the discrimination)`,
      sibling.length === 0,
      `the row after /${command.token} carries the OTHER subject's sentence, so "an info row landed" cannot be read `
      + 'as "this command answered" — the two handlers write different sentences on one and the same session, and '
      + 'that difference is what makes either reading mean anything',
    )
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
