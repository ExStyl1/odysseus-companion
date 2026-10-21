/**
 * RS-62 (D1.40, source `P6.288`) — how much of a session's FIRST turn is the
 * agent process starting, per runtime, on the packaged build.
 *
 * ## The row, and what it will and will not decide
 *
 * `done_means`: *"a per-runtime split of first-turn latency into spawn and
 * answer; if the spawn dominates on claude, `startup()` is a small follow-up row,
 * and if it does not, the cell closes as a stated non-issue rather than an unbuilt
 * feature."* The premise correction of 2026-09-11 (C3.76) settled the other half
 * already: `startup()` and the `WarmQuery` interface ARE declared in the vendored
 * `sdk.d.ts`, with zero importers across `packages` and `apps` — so this is a
 * wiring question and the only thing missing is the number that says whether the
 * wiring is worth doing.
 *
 * ## The split, and why it is a SUBTRACTION rather than an instrument
 *
 * Nothing in a packaged build reports "the runtime took N ms to start": a
 * packaged main process writes no application log (`apps/electron/src/main/logger.ts`
 * disables both transports whenever `isDebugMode` is false), so a case that went
 * looking for a spawn timestamp would be reading a dev build.
 *
 * What a session does have is four IDENTICAL turns. The first pays for the runtime
 * start and the last two do not, so `cold − warm` IS the spawn contribution, and
 * it needs no instrument the product does not have. **The second turn is NOT
 * warm** — see {@link TURNS} for the measurement that says so.
 *
 * ## The clock is the PRODUCT's, not the harness's
 *
 * Each turn is measured from the `user` row's own `timestamp` to the last
 * `assistant` row's, both out of `getSessionMessages` — the store the feature
 * itself writes. The harness's wall clock is recorded beside it and is NOT the
 * reading: `sendPrompt` types the prompt one real key event at a time, and that
 * cost is the rig's. (It is the same for all three turns, so it cancels in the
 * subtraction either way — recording both is what lets a reader check that.)
 *
 * ## The control, and it is the one that decides whether the number exists
 *
 * **The last two turns against each other.** The subtraction is only meaningful if "warm" is a
 * stable quantity; on a loaded box it need not be, and this repo has measured a
 * 22x spread on identical bytes minutes apart. So the case computes the spread
 * between the two warm turns and refuses to report a split when they disagree by
 * more than {@link WARM_SPREAD_CEILING} — UNAVAILABLE, with both numbers, rather
 * than a difference that is mostly the machine. A single cold/warm pair cannot
 * see this at all, which is why there are three turns and not two.
 *
 * A second control: every turn must produce the SAME one-word answer, so the
 * measurements are of the same work. A turn that reasoned at length would
 * make the "warm" figure an answer-length reading.
 *
 * And `uptime` is recorded with every run, because a duration on this box without
 * the load beside it is a number nobody can repeat.
 *
 * ## Per runtime, in the order they are cheapest to make
 *
 * Every card the profile lists whose family the case recognises is driven, and
 * the families it found are reported — so a profile with one card produces one
 * honest row rather than a blocked case. The row wants all three; a sitting that
 * can only make one says which one.
 *
 * ## Safety
 *
 * No credential is read, printed or written; no card is created and none is
 * switched permanently — each family gets its own fresh session. The prompt is a
 * single sentence and no tool is asked for.
 */

import { execFileSync } from 'node:child_process'

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript, type SessionKey } from '../lib/state.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-62'
const TITLE = 'the first turn’s spawn share, per runtime, as cold minus warm on the product’s own clock'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.40',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: whatever cards the profile already has — the case creates none. It drives one fresh session per runtime '
    + 'family it finds and reports which families answered, so a one-card profile still produces a row.',
} as const satisfies CaseMeta

/**
 * How far apart the two WARM turns may be before the subtraction is refused, as a
 * fraction of the larger.
 *
 * 0.5 rather than something tight, deliberately: the question is whether a spawn
 * DOMINATES a first turn, and a warm baseline that is stable within a factor of
 * two is enough to answer that. A tighter ceiling on this box would refuse most
 * runs and teach the next sitting to widen it, which is the cries-wolf failure.
 */
const WARM_SPREAD_CEILING = 0.5

/** The same trivial work three times, so the three turns measure one thing. */
const PROMPT = 'Reply with the single word ready and nothing else.'
const EXPECTED = /ready/i

/**
 * FOUR, and the fourth is what the first drive bought.
 *
 * Three turns (cold + two warm) refused on both runtimes it could reach:
 * pi read 14 507 / 9 168 / 648 ms and codex 6 467 / 6 521 / 896 ms, so the
 * SECOND turn was 93 % and 86 % away from the third. Read as noise that is a
 * refusal; read as a reading it is the finding — **the second turn is still
 * paying something on both runtimes**, and a case that called turn 2 "warm"
 * would have subtracted a warm-up from a warm-up. So the stable pair is the LAST
 * TWO and turn 2 is reported in its own right.
 */
const TURNS = 4

interface TurnTiming {
  /** The product's own account: last assistant timestamp minus the user's. */
  productMs: number | undefined
  /** The harness's wall clock around `sendPrompt`, typing included. NOT the reading. */
  wallMs: number
  answer: string
}

/** One turn, timed on both clocks. */
async function timedTurn(session: CdpSession, key: SessionKey): Promise<TurnTiming> {
  const before = (await transcript(session, key)).length
  const started = Date.now()
  await sendPrompt(session, key, PROMPT, 300_000)
  const wallMs = Date.now() - started
  const added = (await transcript(session, key)).slice(before)
  const user = added.find(message => message.role === 'user')
  const assistants = added.filter(message => message.role === 'assistant')
  const last = assistants[assistants.length - 1]
  const productMs = user && last && typeof user.timestamp === 'number' && typeof last.timestamp === 'number'
    ? last.timestamp - user.timestamp
    : undefined
  return { productMs, wallMs, answer: assistants.map(message => message.content ?? '').join(' ').trim().slice(0, 80) }
}

interface Split {
  family: string
  slug: string
  turns: TurnTiming[]
  coldMs: number | undefined
  /** Turn 2 — reported in its own right, because it is not warm. */
  secondMs: number | undefined
  warmMs: number | undefined
  warmSpread: number | undefined
  spawnMs: number | undefined
  spawnShare: number | undefined
  /** Set when the two warm turns disagree too much for the subtraction to mean anything. */
  unavailable?: string
}

function splitOf(family: string, slug: string, turns: TurnTiming[]): Split {
  const product = turns.map(turn => turn.productMs)
  const cold = product[0]
  // The LAST TWO, never turns 2 and 3 — see {@link TURNS}.
  const warm1 = product[product.length - 2]
  const warm2 = product[product.length - 1]
  const base: Split = {
    family, slug, turns,
    coldMs: cold, secondMs: product[1], warmMs: undefined, warmSpread: undefined,
    spawnMs: undefined, spawnShare: undefined,
  }
  if (cold === undefined || warm1 === undefined || warm2 === undefined) {
    return { ...base, unavailable: 'at least one turn produced no product timestamps, so nothing can be subtracted' }
  }
  const spread = Math.abs(warm1 - warm2) / Math.max(warm1, warm2, 1)
  if (spread > WARM_SPREAD_CEILING) {
    return {
      ...base, warmSpread: spread,
      unavailable:
        `the two warm turns are ${warm1} ms and ${warm2} ms — ${(spread * 100).toFixed(0)} % apart, past the `
        + `${(WARM_SPREAD_CEILING * 100).toFixed(0)} % ceiling — so "warm" is not a stable quantity on this box right `
        + 'now and cold minus warm would be mostly the machine',
    }
  }
  const warm = Math.min(warm1, warm2)
  const spawn = cold - warm
  return {
    ...base,
    warmMs: warm,
    warmSpread: spread,
    spawnMs: spawn,
    spawnShare: cold > 0 ? spawn / cold : undefined,
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  run.observe('load at the start', execFileSync('uptime', { encoding: 'utf8' }).trim())

  const cards = await listConnections(session)
  run.observe('the cards this profile has', cards.map(card => ({ slug: card.slug, providerType: card.providerType })))
  // `runtimeOf` answers `remote` for anything it does not recognise — a BYO
  // OpenAI-wire card, say — and a `remote` card is not one of the three runtimes
  // whose process start this row asks about, so it is dropped by name rather
  // than silently folded into one of them.
  const byFamily = new Map<string, string>()
  for (const card of cards) {
    const family = runtimeOf(card.providerType)
    if (family === 'remote' || byFamily.has(family)) continue
    byFamily.set(family, card.slug)
  }
  run.observe('the families this profile can answer for', [...byFamily.entries()].map(([family, slug]) => `${family}: ${slug}`))
  if (byFamily.size === 0) {
    blocked(
      'this profile lists no connection whose runtime family this case recognises, so there is no first turn to time. '
      + 'Run RS-32 first — it presses the onboarding\'s own one-click button.',
    )
  }

  const splits: Split[] = []
  for (const [family, slug] of byFamily) {
    const key = await freshSession(session, `CDP ${ID} ${family} ${new Date().toISOString().slice(11, 19)}`)
    run.check(`${family}: the case ran in a session it created`, key.fresh, key.reason ?? '')
    const outcome = await switchRuntime(session, key.sessionId, slug)
    const bound = await waitForConnection(session, key.sessionId, slug, outcome.ok ? 30_000 : 60_000)
    run.check(
      `${family}: the session is bound to \`${slug}\``,
      bound === slug,
      `the session reports \`${String(bound)}\`, so the turns below are another runtime's: `
      + String(outcome.errorDetail?.message ?? outcome.error ?? 'the app reported no error'),
    )
    if (bound !== slug) continue

    const turns: TurnTiming[] = []
    for (let index = 0; index < TURNS; index += 1) turns.push(await timedTurn(session, key))
    const split = splitOf(family, slug, turns)
    splits.push(split)
    run.observe(`${family}: the ${TURNS} turns`, turns.map(turn => ({
      productMs: turn.productMs, wallMs: turn.wallMs, answer: turn.answer,
    })))
    run.check(
      `${family}: THE CONTROL — every turn did the SAME work (one word, \`ready\`)`,
      turns.every(turn => EXPECTED.test(turn.answer)),
      `at least one turn answered something else, so the durations are not measurements of one thing: `
      + `${JSON.stringify(turns.map(turn => turn.answer))}`,
    )
    run.check(
      `${family}: THE CONTROL — the two WARM turns agree well enough to subtract`,
      split.unavailable === undefined,
      split.unavailable ?? '',
    )
    if (split.unavailable === undefined) {
      run.observe(`${family}: THE SPLIT`, {
        coldMs: split.coldMs,
        secondTurnMs: split.secondMs,
        warmMs: split.warmMs,
        spawnMs: split.spawnMs,
        spawnShare: split.spawnShare !== undefined ? `${(split.spawnShare * 100).toFixed(0)} %` : undefined,
        warmSpread: split.warmSpread !== undefined ? `${(split.warmSpread * 100).toFixed(0)} %` : undefined,
      })
      run.check(
        `${family}: the first turn really is the SLOWEST — a negative spawn share means the subtraction has no subject`,
        (split.spawnMs ?? -1) > 0,
        `cold ${split.coldMs} ms against warm ${split.warmMs} ms: the first turn was not slower than the warm ones, `
        + 'so on this runtime the process start is not a measurable part of it — which is D1.40 answered, in the '
        + 'direction that closes the cell as a stated non-issue rather than an unbuilt feature',
      )
    }
  }

  run.observe('THE ANSWER — the per-runtime split D1.40 asks for', splits.map(split => ({
    runtime: split.family,
    card: split.slug,
    coldMs: split.coldMs,
    secondTurnMs: split.secondMs,
    warmMs: split.warmMs,
    spawnMs: split.spawnMs,
    spawnShare: split.spawnShare !== undefined ? `${(split.spawnShare * 100).toFixed(0)} %` : undefined,
    unavailable: split.unavailable,
  })))
  run.observe('load at the end', execFileSync('uptime', { encoding: 'utf8' }).trim())
}

if (import.meta.main) await main(ID, TITLE, drive)
