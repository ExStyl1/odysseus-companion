/**
 * RS-32 (P6.1080) — the one-click gateway card a NEW user gets, and whether its
 * first turn answers.
 *
 * ## Why this needed a live case at all
 *
 * P6.1080's first defect is the release-critical one and it is a SEED, not a
 * behaviour: `NESSY_GATEWAY_MODEL_IDS[0]` was `tgpt/qwen35-397b-a17b-fp8`, which
 * is also the `defaultModel` every one-click gateway connection is created with,
 * and the gateway had retired that id — `POST …/chat/completions` for it answers
 * **404 `… больше не поддерживается …`**. So a fresh click produced a connection
 * whose FIRST TURN failed, and the remedy the gateway's own 404 body names
 * (`/auth`, `/model`) belongs to nessy-cli rather than to this product.
 *
 * `ModelRefreshService._doRefresh` repairs a stale default at startup — which is
 * exactly why a unit test cannot answer this: the repair is fire-and-forget with
 * a 3 s fetch timeout, it runs only on a SUCCESSFUL fetch, and every existing
 * profile on every developer machine has already been repaired by it. The claim
 * that is left — *a user who clicks the card today gets a model the gateway
 * still serves* — is only visible on a profile that has never been repaired,
 * i.e. a `NESSY_CONFIG_DIR` created for the run.
 *
 * ## The detector: the app's OWN record of what it seeded
 *
 * `listLlmConnections()[…].defaultModel`, read straight after the card exists.
 * Not the model picker's label (a renderer projection), not the model's prose. A
 * turn that answers is the second half and it is deliberately the WEAKER one: a
 * seeded id could be wrong and still answer if something repaired it in between,
 * so the id is read first and recorded verbatim.
 *
 * The two ids below are written out BY HAND rather than imported from
 * `config/nessy-gateway-models.ts`. A check that derives its expectation from the
 * constant under test passes whatever that constant says, a re-regression
 * included — the same rule `rs-30`'s `HOST_FRAME` is written under. If this file
 * and that constant ever disagree, THAT is the finding.
 *
 * ## The negative control, which is the point
 *
 * "A turn answered" is worthless on its own: it is equally true of a rig that
 * cannot see a failing turn at all. So a second session on the SAME card is
 * pointed at the retired id and asked the same question. One of two things is
 * then recorded, and both are readings rather than failures:
 *
 *  - the app REFUSES to select an id the gateway no longer lists — the failure
 *    mode is closed one layer earlier than the model call;
 *  - the turn runs and fails, and the 404 is quoted verbatim — which is the
 *    evidence that the positive arm above is measuring something.
 *
 * ## What this case creates
 *
 * Sessions (named `CDP RS-32 …`, like every case here) and, on a profile that
 * has never been set up, ONE connection — through the product's own onboarding
 * button, which is the path the row is about. It writes no config file of its
 * own, and it never reads or writes a credential: the one-click sign-in reads
 * `~/.nessy/dp_auth_creds.json` through the app's own `dp` module, outside the
 * config dir, and this case never touches that file.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { boundCard, listConnections, runtimeOf, selectModel, type ConnectionRow } from '../lib/runtime-switch.ts'
import { readPiSessionLog } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession, type TranscriptMessage } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { checkAbsence, positive, turnRoles } from '../lib/turn-evidence.ts'

const ID = 'RS-32'
const TITLE = 'the one-click gateway card a fresh profile seeds, and whether its first turn answers'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.1080',
  runtimes: ['pi'],
  credentials:
    'owner: the machine must already hold the shared dp sign-in the one-click cards use '
    + '(`~/.nessy/dp_auth_creds.json`, written by nessy-cli or by a previous sign-in and living OUTSIDE the config dir). '
    + 'The case never reads, prints or writes it. Launch the app with NESSY_CONFIG_DIR pointing at a directory '
    + 'created for the run: on any older profile the startup refresh has already repaired the seed and there is '
    + 'nothing left to measure.',
} as const satisfies CaseMeta

/**
 * The id the gateway RETIRED, spelled here so a re-regression is visible.
 *
 * Probed 2026-09-11 (P6.1080): `/cli/models` lists it nowhere and a completion
 * for it answers 404 `Модель … больше не поддерживается`.
 */
const RETIRED_MODEL = 'tgpt/qwen35-397b-a17b-fp8'

/** The id behind the `coder` alias on the same day — what the card should seed. */
const CODER_MODEL = 'tgpt/deepseek-v4-flash-0731'

/** The onboarding button this case may press, matched on the product's own words. */
const ONE_CLICK_LABEL = /pi agent/i

/**
 * The onboarding's LAST button — *"You're all set! … Get Started"*.
 *
 * Pressing the card is not the end of the new-user path: the app stays on the
 * onboarding until this is pressed, and while it is there the chat shell does
 * not exist. Measured 2026-09-11 on the first run of this case: the card was
 * created with the right id, then `freshSession()` dispatched
 * `nessy-agent-navigate` into a renderer with no shell to hear it, created
 * nothing, and fell through to `activeSession()` — which threw `no-sessions`
 * on a profile that by definition has none. The case died reporting a missing
 * precondition it had just been in the middle of creating.
 */
const DONE_LABEL = /get started/i

interface ButtonRect { x: number; y: number; text: string }

/** A button's centre by its visible text, or `undefined` when it is not on screen. */
async function buttonByText(session: CdpSession, pattern: RegExp): Promise<ButtonRect | undefined> {
  return session.call<ButtonRect | undefined>(`
    const wanted = ${pattern.toString()}
    const button = Array.from(document.querySelectorAll('button')).find(el => wanted.test(el.innerText || ''))
    if (!button) return undefined
    const r = button.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').replace(/\\s+/g, ' ').trim() }
  `)
}

/**
 * True once the onboarding screen is GONE.
 *
 * Deliberately not "the composer exists": a profile that has just finished
 * onboarding has ZERO sessions, so there is no composer and no session row to
 * wait for, and the first version of this check asserted both and failed on a
 * run whose every later step worked (measured 2026-09-11). The onboarding's own
 * absence is the thing that has to be true before `freshSession()` can be heard,
 * and it is observable without inventing a surface.
 */
async function onboardingIsGone(session: CdpSession): Promise<boolean> {
  return (await buttonByText(session, DONE_LABEL)) === undefined
    && (await buttonByText(session, ONE_CLICK_LABEL)) === undefined
}

/** Every gateway-shaped Pi card the app lists. */
function gatewayCards(rows: readonly ConnectionRow[]): ConnectionRow[] {
  return rows.filter(row => runtimeOf(row.providerType) === 'pi')
}

async function connectionsAfter(session: CdpSession, timeoutMs: number): Promise<ConnectionRow[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await listConnections(session)
    if (gatewayCards(rows).length > 0 || Date.now() >= deadline) return rows
    await Bun.sleep(1_000)
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- the seed -----------------------------------------------------------
  let rows = await listConnections(session)
  let seededHere = false
  if (gatewayCards(rows).length === 0) {
    const button = await buttonByText(session, ONE_CLICK_LABEL)
    if (!button) {
      blocked(
        'this profile lists no gateway card and the onboarding screen is not on screen, so there is no product path '
        + 'to the seed. Relaunch the app with NESSY_CONFIG_DIR pointing at a directory created for the run — the '
        + `app lists: ${rows.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
      )
    }
    run.observe('onboarding-button', button.text)
    await clickAt(session, { x: button.x, y: button.y }, 'the one-click Pi gateway card')
    rows = await connectionsAfter(session, 60_000)
    seededHere = true
  }

  // The rest of the new-user path. Pressed whether or not this run created the
  // card, because a profile can be left on the finished screen by an earlier run.
  const done = await buttonByText(session, DONE_LABEL)
  if (done) {
    run.observe('onboarding-done-button', done.text)
    await clickAt(session, { x: done.x, y: done.y }, 'the onboarding\'s Get Started button')
  }
  const shell = await (async () => {
    const deadline = Date.now() + 30_000
    for (;;) {
      if (await onboardingIsGone(session)) return true
      if (Date.now() >= deadline) return false
      await Bun.sleep(1_000)
    }
  })()
  run.check(
    'the app left the onboarding screen',
    shell,
    'the onboarding is still on screen 30 s after its last button was pressed — `freshSession()` dispatches its navigate '
    + 'event into a renderer with no shell to hear it, creates nothing, and the case then dies on `no-sessions`, '
    + 'reporting a missing precondition it was in the middle of creating',
  )
  run.observe('seed-path', seededHere
    ? 'clicked the product\'s own one-click button on a profile that had no connection'
    : 'a gateway card already existed — the seed is read off it, and the startup refresh may already have repaired it')
  run.observe('cards', rows.map(row => ({ slug: row.slug, providerType: row.providerType, defaultModel: row.defaultModel })))

  const card = gatewayCards(rows)[0]
  run.check(
    'the one-click card exists',
    card !== undefined,
    `no pi-runtime connection after the click; the app lists ${rows.map(row => row.slug).join(', ') || 'nothing'}`,
  )
  // A `check` plus an early return rather than `require`, because the narrowing
  // is what the twelve reads below need: `require` throws at run time and the
  // compiler cannot see it, so every one of them would be an `possibly
  // undefined` error on a line that can never run.
  if (!card) return
  run.observe('card', { slug: card.slug, name: card.name, providerType: card.providerType, defaultModel: card.defaultModel, models: card.models?.map(m => m.id) })

  // ---- THE DETECTOR -------------------------------------------------------
  run.check(
    'the seeded default model is NOT the id the gateway retired',
    card.defaultModel !== RETIRED_MODEL,
    card.defaultModel === RETIRED_MODEL
      ? `the card was created with ${RETIRED_MODEL}, which answers 404 "больше не поддерживается" — P6.1080's release-critical defect, back`
      : undefined,
  )
  run.check(
    `the seeded default model is the id behind the coder alias (${CODER_MODEL})`,
    card.defaultModel === CODER_MODEL,
    card.defaultModel === CODER_MODEL
      ? undefined
      : `it is ${String(card.defaultModel)}. The gateway rotates these ids — this is the second rotation the constant has met — `
        + 'so a mismatch here is a reason to re-read `/cli/models` and re-pin the seed, not automatically a defect.',
  )
  const listed = (card.models ?? []).map(m => m.id)
  run.check(
    'the seeded default is a model the card itself lists',
    listed.length === 0 || listed.includes(String(card.defaultModel)),
    `defaultModel=${String(card.defaultModel)} against ${JSON.stringify(listed)} — a default absent from the catalogue is the shape that 404s`,
  )

  // ---- THE FIRST TURN -----------------------------------------------------
  process.env.NESSY_CDP_CARD = card.slug
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  run.observe('bound', await boundCard(session, key.sessionId))

  const turn = await sendPrompt(session, key, 'Reply with the single word ready and nothing else.', 240_000)
  const answer = lastAssistantText(turn.added)
  run.observe('first-turn', { added: turn.added.length, answer: answer.slice(0, 400) })
  run.check(
    'the FIRST turn on the freshly seeded card answers',
    answer.trim().length > 0,
    `the turn produced no assistant text; the transcript gained ${turn.added.length} message(s). `
    + 'Quote any error row above — a gateway 404 for the seeded id is exactly P6.1080.',
  )

  // ---- THE NEGATIVE CONTROL ----------------------------------------------
  // Without it, "the turn answered" is equally true of a rig that cannot see a
  // failing turn. Recorded, never required: a refusal one layer earlier is a
  // legitimate — and better — product answer.
  const controlKey = await freshSession(session, `CDP ${ID} control ${new Date().toISOString().slice(11, 19)}`)
  run.observe('control-bound', await boundCard(session, controlKey.sessionId))
  const selected = await selectModel(session, controlKey, RETIRED_MODEL, 15_000)
  run.observe('control-model-selected', selected)
  if (selected !== RETIRED_MODEL) {
    run.observe(
      'negative-control',
      `the app would not put ${RETIRED_MODEL} on the session (it reports ${String(selected)}). `
      + 'The retired id is refused a layer before the model call, which is a stronger product answer than a quoted 404 — '
      + 'and it means this run cannot demonstrate a failing turn on this rig.',
    )
    return
  }
  const controlTurn = await sendPrompt(session, controlKey, 'Reply with the single word ready and nothing else.', 180_000)
    .catch(error => ({ added: [] as TranscriptMessage[], error: String(error instanceof Error ? error.message : error) }))
  // F1.504 — the turn's ERROR rows are read too: a turn the retired id failed
  // says so in an `error` row, which this text used to leave out — and the
  // empty text that produced was then accepted as a refusal.
  const controlText = 'error' in controlTurn
    ? String(controlTurn.error)
    : [lastAssistantText(controlTurn.added), ...controlTurn.added.filter(m => m.role === 'info' || m.role === 'error').map(m => m.content)].join('\n')

  // WHICH MODEL ANSWERED — read from the RUNTIME's own session file, never from
  // the app's stored `model` field. Measured 2026-09-11: the session record kept
  // `tgpt/qwen35-397b-a17b-fp8` while the Pi sidecar's first line is
  // `{"type":"model_change",…,"modelId":"tgpt/deepseek-v4-flash-0731"}`. The two
  // disagree BY DESIGN — `resolveModelForProvider` clears a session model the
  // refreshed catalogue no longer lists — and only the second one says what was
  // actually called.
  const controlLog = readPiSessionLog(controlKey)
  const wireModels = [...new Set(controlLog.entries
    .filter(entry => entry.type === 'model_change')
    .map(entry => String(entry.raw.modelId ?? '')))].filter(Boolean)
  const notices = 'error' in controlTurn ? [] : controlTurn.added.filter(m => m.role === 'info').map(m => m.content.slice(0, 400))
  run.observe('negative-control', {
    added: controlTurn.added.length,
    text: controlText.slice(0, 800),
    storedModel: RETIRED_MODEL,
    wireModels,
    sidecar: controlLog.file ?? controlLog.reason,
    infoRows: notices,
  })

  const substituted = wireModels.length > 0 && !wireModels.includes(RETIRED_MODEL)
  const refused = /404|не поддерж|unsupported|not found|error/i.test(controlText)
  // An EMPTY control turn is no longer a refusal (F1.504): the runtime's own
  // substitution, or text the turn surfaced, is the positive it needs.
  checkAbsence(
    run,
    'THE CONTROL — a RETIRED id does not reach the runtime unchanged',
    substituted || refused,
    substituted
      ? positive(true, 'runtime substitution', `the runtime's own session file records ${JSON.stringify(wireModels)}`)
      : positive(controlText.trim().length > 0, 'reply, error row or notice from the control turn',
        `${controlText.trim().length} chars; rows this turn added: ${turnRoles(controlTurn.added)}`),
    `the runtime's own session file records ${JSON.stringify(wireModels)} and the turn answered normally — `
    + 'the retired id went to the wire and was served, so this rig cannot tell a live model from a dead one '
    + 'and the positive arm above is uninterpretable',
  )
  // The third outcome, and on this build the one that happens. It is a READING,
  // not a failure: the product prevented the 404 rather than reporting it.
  run.observe(
    'control-verdict',
    substituted
      ? `the host substituted ${JSON.stringify(wireModels)} for the stored ${RETIRED_MODEL} before the call, and the transcript `
        + `carries ${notices.length} info row(s) about it. The 404 is therefore unreachable from the product's own surface — `
        + 'which is the fallback working, and it means this run demonstrates the substitution rather than the failure.'
      : refused
        ? 'the turn failed, and the text above is what a user meeting a retired id sees'
        : 'neither substituted nor refused — read the two fields above before recording anything',
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, one content panel. Launch it with NESSY_CONFIG_DIR pointing at a directory created for the run, so the profile has never been repaired by the startup refresh.',
    '2. `bun run scripts/cdp/cases/rs-32.ts` with NESSY_CDP_PORT pointed at the app. The case presses the onboarding\'s own "Nessy · Pi agent" button when no card exists yet.',
    '3. Read `card.defaultModel` off the result line — that is the seed — then `first-turn` for whether it answers, then `negative-control`.',
    '4. Delete the scratch config dir afterwards, by its full path.',
  ],
  expected: 'the seeded defaultModel is the id behind the `coder` alias (never the retired `tgpt/qwen35-397b-a17b-fp8`), and the first turn on the card answers.',
  detector: '`listLlmConnections()[…].defaultModel` — the app\'s own record of what it seeded — plus the transcript of one turn on it. The model picker\'s label is a renderer projection and is never read here.',
  positiveControl: 'the first turn itself: a seeded id that answers proves the card is usable, and it is read AFTER the id so a repaired default cannot launder a wrong seed.',
  doneMeans: 'one run on a profile created for it: the seeded id recorded verbatim, the first turn\'s outcome recorded, and the retired id\'s behaviour on the same card recorded as the control.',
  runOnlyIf: 'the config dir was created for this run. On an older profile `ModelRefreshService._doRefresh` has already replaced a stale default and the case measures the repair rather than the seed — it says so in `seed-path` rather than pretending otherwise.',
} as const satisfies SittingRecipe
