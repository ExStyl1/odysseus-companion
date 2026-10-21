/**
 * RS-73 (D1.63) — does an output-token figure reach the renderer MID-TURN, on
 * Pi, on codex and on claude?
 *
 * ## The row
 *
 * D1.63 is *"whether a live output-token counter advances mid-turn on Pi and on
 * codex"*. Its source row (P6.383, denominator K36) carries pi `unknown`, claude
 * `have`, codex `unknown`, and a rig of *"one long streamed turn per runtime;
 * read whether the usage overlay's token figure ADVANCES mid-turn; control, a
 * short turn where it must jump exactly once."*
 *
 * ## The detector, and the WRONG one this case was first written with
 *
 * The overlay renders `session.tokenUsage.outputTokens` (`ChatDisplay.tsx`,
 * under the `usage.outputTokens` label). The obvious probe is therefore to poll
 * `getSessions()` for that field — and it is wrong, measured 2026-09-18 on this
 * case's own first drive: over 17, 19 and 24 in-turn samples on claude, Pi and
 * codex the field was ABSENT every time and present only afterwards, so the
 * poll scored three flat lines and the case stopped at its own positive control
 * rather than reporting three product absences. `atoms/sessions.ts` says why in
 * its own words — *"tokenUsage is only returned by getSession() (not
 * getSessions())"* — and the preload publishes no `getSession` at all.
 *
 * The renderer gets it LIVE from the event channel instead. So this case
 * subscribes to `window.electronAPI.onSessionEvent` before submitting and reads
 * what actually arrives while the turn runs:
 *
 * - `text_delta` — the answer streaming, many per turn;
 * - `usage_update` — a usage frame mid-turn;
 * - `complete` — the end of the turn, carrying the full `tokenUsage`.
 *
 * ## What is scored, and what the controls are
 *
 * The SUBJECT is: how many events carrying a `tokenUsage.outputTokens` arrive
 * BEFORE `complete`. A live counter means several; a counter written once at the
 * end means none.
 *
 * - **the positive control is `text_delta` on the same subscription**: it proves
 *   the collector is attached, the channel is live, and something really does
 *   advance mid-turn. Without it, *"no live output tokens"* and *"the listener
 *   never fired"* are one reading — which is precisely how the first spelling of
 *   this case went wrong, one layer down.
 * - **the row's own control is the SHORT turn**: the same subscription on a turn
 *   that answers in one word must not manufacture a series.
 *
 * ## Scope, stated rather than implied
 *
 * All three arms run on GATEWAY cards, so the claude arm is claude-through-the-
 * loopback-adapter and not claude against a first-party Anthropic upstream. The
 * ledger's claude `have` rests on `includePartialMessages: true` and an adapter
 * that reads `message_delta.usage`; what this case can say is whether the figure
 * reaches the renderer on the card this product ships by default. A different
 * upstream is a different reading and the verdict says so.
 *
 * ## What it creates
 *
 * Two sessions per runtime family the profile has a card for, inside
 * `NESSY_CONFIG_DIR`, plus one `window` property it removes at the end. No
 * configuration is written, no connection edited, no credential read.
 */

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { clearComposer, readComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-73'
const TITLE = 'the output-token figure, read off the live session-event channel while the turn streams'

/** Long enough to stream for seconds; no tool, so nothing but text is measured. */
const LONG_PROMPT =
  'Write about three hundred words on why the number seven appears so often in folklore. '
  + 'Plain prose, no lists, no headings. Do not use any tool.'

/** The row's own control: a turn whose counter must jump at most once. */
const SHORT_PROMPT = 'Reply with the single word ready. Do not use any tool.'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.63',
  runtimes: ['pi', 'codex', 'claude'],
  credentials:
    'owner: the gateway cards for the families to be measured. No key is read and no connection is edited.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher in scripts/cdp/README.md.',
    '2. Subscribe to window.electronAPI.onSessionEvent BEFORE submitting anything, and collect every event with its type.',
    '3. Per runtime family: a fresh session bound to that family\'s card, then a LONG prose prompt.',
    '4. Count the events carrying tokenUsage.outputTokens that arrive BEFORE the turn\'s `complete` event.',
    '5. Repeat with a SHORT prompt — the row\'s own control, which must not produce a series.',
  ],
  expected:
    'A live counter delivers several output-token frames before `complete`. A counter written once delivers none, '
    + 'and the whole figure arrives with `complete`.',
  detector:
    '`window.electronAPI.onSessionEvent` — the channel the renderer\'s own session atom is updated from. NOT '
    + '`getSessions()`, which does not carry `tokenUsage` while a turn runs (`atoms/sessions.ts`: "tokenUsage is '
    + 'only returned by getSession()"), and NOT the formatted DOM string.',
  positiveControl:
    '`text_delta` on the same subscription: dozens per long turn, which proves the listener is attached and that '
    + 'something really does advance mid-turn. Without it, "no live output tokens" and "the listener never fired" '
    + 'are the same reading. The SHORT turn is the row\'s own second control.',
  doneMeans:
    'D1.63\'s Pi and codex cells carry a verdict with both arms recorded, and the claude cell is re-read against '
    + 'this build rather than inherited — with the scope (a gateway card through the loopback adapter) named.',
  doNotConflate:
    'A mid-turn `usage_update` frame is not an output-token frame. On the gateway cards measured here it carries '
    + '`inputTokens` and `contextWindow` only, so counting `usage_update` events would report a live output '
    + 'counter that does not exist.',
} as const satisfies SittingRecipe

interface Collected {
  readonly total: number
  readonly types: Record<string, number>
  /** Events carrying `tokenUsage.outputTokens`, in arrival order, before `complete`. */
  readonly outputTokenFramesBeforeComplete: number[]
  readonly usageUpdateFields: string[]
  readonly completeOutputTokens: number
  readonly textDeltas: number
}

interface ArmReading extends Collected {
  readonly runtime: SittingRuntime
  readonly slug: string
  readonly prompt: 'long' | 'short'
  readonly elapsedMs: number
}

/** Attach the collector once; each arm resets it. */
async function installCollector(session: CdpSession): Promise<void> {
  await session.call<null>(`
    if (!window.__rs73) {
      window.__rs73 = { events: [] }
      window.electronAPI.onSessionEvent((a, b) => {
        const ev = (b && typeof b === 'object') ? b : a
        if (!ev || typeof ev !== 'object') return
        window.__rs73.events.push(ev)
      })
    }
    return null
  `)
}

async function resetCollector(session: CdpSession): Promise<void> {
  await session.call<null>(`window.__rs73.events = []; return null`)
}

/**
 * What the channel delivered for ONE session, classified in the page.
 *
 * The classification happens in the page rather than here because the events
 * carry whole payloads; shipping them over CDP would mean shipping transcript
 * text through a case's own report.
 */
async function collected(session: CdpSession, key: SessionKey): Promise<Collected> {
  return session.call<Collected>(`
    const mine = window.__rs73.events.filter(e => !e.sessionId || e.sessionId === ${JSON.stringify(key.sessionId)})
    const types = {}
    const before = []
    const usageFields = new Set()
    let completeOutput = -1
    let seenComplete = false
    for (const ev of mine) {
      const type = String(ev.type || ev.kind || 'unknown')
      types[type] = (types[type] || 0) + 1
      const usage = ev.tokenUsage
      if (usage && typeof usage === 'object') {
        if (type === 'usage_update') for (const k of Object.keys(usage)) usageFields.add(k)
        if (type === 'complete') { seenComplete = true; completeOutput = usage.outputTokens ?? -1 }
        else if (!seenComplete && typeof usage.outputTokens === 'number') before.push(usage.outputTokens)
      }
    }
    return {
      total: mine.length,
      types,
      outputTokenFramesBeforeComplete: before,
      usageUpdateFields: [...usageFields].sort(),
      completeOutputTokens: completeOutput,
      textDeltas: types.text_delta || 0,
    }
  `)
}

/** Submit a prompt and wait for the channel's own `complete`, never for a poll. */
async function driveTurn(
  session: CdpSession,
  key: SessionKey,
  runtime: SittingRuntime,
  slug: string,
  prompt: 'long' | 'short',
  text: string,
  timeoutMs: number,
): Promise<ArmReading> {
  await resetCollector(session)
  await clearComposer(session)
  await typeIntoComposer(session, text)
  const typed = await readComposer(session)
  const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim()
  if (normalise(typed) !== normalise(text)) {
    throw new Error(`composer-mismatch: composer holds ${JSON.stringify(typed.slice(0, 80))}`)
  }
  const started = Date.now()
  await submitComposer(session)
  for (;;) {
    await Bun.sleep(1_000)
    const done = await session.call<boolean>(`
      return window.__rs73.events.some(e => (e.type === 'complete' || e.type === 'error')
        && (!e.sessionId || e.sessionId === ${JSON.stringify(key.sessionId)}))
    `)
    if (done) break
    if (Date.now() - started > timeoutMs) break
  }
  return { runtime, slug, prompt, elapsedMs: Date.now() - started, ...(await collected(session, key)) }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the streamed usage this case reads')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const families: ReadonlyArray<{ runtime: SittingRuntime; provider: string }> = [
    { runtime: 'claude', provider: 'anthropic' },
    { runtime: 'pi', provider: 'pi' },
    { runtime: 'codex', provider: 'codex-runtime' },
  ]
  const picked = families
    .map(entry => ({ ...entry, card: cards.find(row => runtimeOf(row.providerType) === entry.provider) }))
    .filter((entry): entry is typeof entry & { card: NonNullable<typeof entry.card> } => entry.card !== undefined)
  run.observe('cards', { listed: cards.map(row => `${row.slug}:${row.providerType}`), driving: picked.map(entry => entry.runtime) })
  if (picked.length === 0) blocked('this profile lists no card for any runtime family, so no turn can be driven at all')

  await installCollector(session)

  const readings: ArmReading[] = []
  for (const entry of picked) {
    const longKey = await freshSession(session, `CDP ${ID} ${entry.runtime} long ${new Date().toISOString().slice(11, 19)}`)
    run.check(`the ${entry.runtime} long arm ran in a session it created`, longKey.fresh, longKey.fresh ? undefined : longKey.reason)
    const longBind = await switchRuntime(session, longKey.sessionId, entry.card.slug)
    run.check(`the ${entry.runtime} long arm is bound to ${entry.card.slug}`, longBind.ok, longBind.ok ? undefined : `switchRuntime refused: ${longBind.error}`)
    const long = await driveTurn(session, longKey, entry.runtime, entry.card.slug, 'long', LONG_PROMPT, 300_000)
    readings.push(long)
    run.observe(`${entry.runtime} — LONG turn`, long)

    const shortKey = await freshSession(session, `CDP ${ID} ${entry.runtime} short ${new Date().toISOString().slice(11, 19)}`)
    const shortBind = await switchRuntime(session, shortKey.sessionId, entry.card.slug)
    run.check(`the ${entry.runtime} short arm is bound to ${entry.card.slug}`, shortBind.ok, shortBind.ok ? undefined : `switchRuntime refused: ${shortBind.error}`)
    const short = await driveTurn(session, shortKey, entry.runtime, entry.card.slug, 'short', SHORT_PROMPT, 240_000)
    readings.push(short)
    run.observe(`${entry.runtime} — SHORT turn (the row's own control)`, short)
  }

  for (const long of readings.filter(r => r.prompt === 'long')) {
    run.require(
      `THE POSITIVE CONTROL (${long.runtime}) — the event channel delivered a streaming series for this turn`,
      long.textDeltas > 1,
      `${long.textDeltas} text_delta event(s) over ${long.total} events in ${long.elapsedMs} ms. With no series on `
      + 'the channel at all, an absence of output-token frames says nothing about the counter — it says the '
      + 'listener did not fire, which is the failure this control exists to exclude',
    )
  }

  for (const long of readings.filter(r => r.prompt === 'long')) {
    run.check(
      `${long.runtime.toUpperCase()} — an output-token figure arrives BEFORE the turn completes`,
      long.outputTokenFramesBeforeComplete.length > 0,
      `0 output-token frames before \`complete\`, against ${long.textDeltas} text_delta events on the same `
      + `subscription in the same turn, and \`complete\` itself carrying outputTokens=${long.completeOutputTokens}. `
      + `Any mid-turn \`usage_update\` frames carried ${JSON.stringify(long.usageUpdateFields)} — read that list `
      + 'before calling this a live counter',
    )
  }

  for (const short of readings.filter(r => r.prompt === 'short')) {
    run.check(
      `${short.runtime.toUpperCase()} — the SHORT turn does not manufacture a series`,
      short.outputTokenFramesBeforeComplete.length <= 1,
      `${short.outputTokenFramesBeforeComplete.length} output-token frames before \`complete\` on a turn that `
      + 'answers in one word. The row\'s own control asks this arm to jump at most once',
    )
  }

  run.observe('verdict', {
    scope: 'all arms on GATEWAY cards — the claude arm is claude through the loopback adapter, not a first-party upstream',
    perArm: readings.map(r => ({
      runtime: r.runtime,
      prompt: r.prompt,
      events: r.total,
      textDeltas: r.textDeltas,
      outputTokenFramesBeforeComplete: r.outputTokenFramesBeforeComplete.length,
      usageUpdateFields: r.usageUpdateFields,
      completeOutputTokens: r.completeOutputTokens,
      elapsedMs: r.elapsedMs,
    })),
  })

  await session.call<null>(`delete window.__rs73; return null`).catch(() => null)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
