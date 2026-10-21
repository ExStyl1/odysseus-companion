/**
 * RS-04 (row P6.93) — `view_image` on a SWITCHED codex session, the one leg of
 * the D4 design that has only ever been read from source.
 *
 * The design's third leg: an image cannot cross a runtime switch as bytes, so
 * the rebuilt transcript sends a POINTER — `[Attached image: …]`,
 * `[Stored at: <path>]`, and `HANDOFF_IMAGE_NOTE` — and the model is expected to
 * open the path itself. On codex that opening is `view_image`, which ships
 * `Stage::Stable, default_enabled: true` and is drift-guarded in both directions
 * against the shipped binary (P3.116, `8afdf2c87`). **Nothing is built for this
 * row: `view_image` is codex's own mechanism.** What has never happened is a run.
 *
 * ## The condition is per-MODEL, which is why the control is a second card
 *
 * P3.280 made the note state its condition rather than branch on it: *"A model
 * that accepts image input receives it there as visual content, not raw bytes; a
 * model that does not is offered no way to open it."* codex GATES `view_image`
 * on the model's declared modality, and the Nessy Gateway's model declares none —
 * measured, it answers an image content part with `400 Invalid Chat Message
 * Part: Model Does Not Support Image Inputs` (P3.114, pinned by P3.127).
 *
 * So the two arms are two CARDS on the same codex runtime:
 *
 *  - **subject** — a BYO `openai-compatible` upstream with a vision-capable
 *    model. `view_image` on the pointer's path must return the image as visual
 *    content.
 *  - **control** — the gateway card. The same request must NOT succeed, and the
 *    refusal is quoted verbatim rather than paraphrased. A control that merely
 *    "did not obviously work" cannot separate a model without vision from a
 *    network that was down.
 *
 * ## What the operator supplies, and why the harness will not create it
 *
 * An image attachment. The composer's attach path is a native file picker, which
 * CDP cannot drive, and a case that wrote an attachment row directly would be
 * measuring its own fixture rather than the app's own attachment pipeline —
 * which is exactly the surface the pointer is derived from. So the operator
 * attaches the image, runs one turn, leaves that session open, and runs this
 * case against it.
 *
 * ## The detectors, and what each one cannot do alone
 *
 * 1. **The pointer crossed** — the model, asked from the conversation only,
 *    names the stored path. This proves the handoff block arrived. It does NOT
 *    prove the image is readable: the note is emitted for a model that cannot
 *    open it too.
 * 2. **The tool ran** — a `view_image` call appears among the transcript's tool
 *    messages. This proves the tool is on the surface. It does NOT prove the
 *    model saw anything: a call that errored is still a call.
 * 3. **The image was seen** — the model reports something about the picture that
 *    it can only have got by looking. The operator supplies that expected
 *    observation in `NESSY_CDP_IMAGE_FACT`, because only the person who chose
 *    the image knows what is in it, and a case that accepted any description
 *    would pass on a model that guessed from the filename.
 */

import { resolveAppUnderTest } from '../lib/bundle.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { activeSession, transcript, type SessionKey } from '../lib/state.ts'
import { assertElectronApi } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-04'
const TITLE = 'A switched codex session opens the image the handoff pointed at, and the gateway model cannot'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.93',
  runtimes: ['codex'],
  credentials: 'owner: a BYO codex-runtime card on a vision-capable openai-compatible upstream, plus the '
    + 'gateway codex card for the control. Name the CARDS in the env vars below; never a key.',
} as const satisfies CaseMeta

/** The note's own opening words — the feature's record that an image was pointed at. */
const IMAGE_NOTE_MARKER = 'The image itself did not cross the runtime switch'

/** The pointer line the rebuilt transcript writes above the note. */
const POINTER_MARKER = 'Stored at:'

interface ArmReading {
  card: string
  pointerNamed: boolean
  viewImageCalls: { tool: string; status?: string; resultLength: number }[]
  factReported: boolean
  refusalText: string
}

async function runArm(
  session: CdpSession,
  run: CaseRun,
  key: SessionKey,
  card: string,
  fact: string | undefined,
): Promise<ArmReading> {
  const moved = await switchRuntime(session, key.sessionId, card)
  run.observe(`switch onto ${card}`, moved)
  run.check(`the switch onto ${card} was accepted`, moved.ok, moved.error ?? '')
  const active = await waitForConnection(session, key.sessionId, card)
  run.check(`the session reports ${card}`, active === card, `llmConnection=${String(active)}`)

  // Detector 1 — the pointer, from the conversation only.
  const pointed = await sendPrompt(
    session,
    key,
    'Answer from our conversation only, in one line: what filesystem path is the attached image stored at? '
    + 'Quote the path exactly as it was given to you.',
    300_000,
  ).catch(() => undefined)
  const pointerAnswer = pointed ? lastAssistantText(pointed.added) : ''
  run.observe(`${card} — pointer answer`, pointerAnswer.slice(0, 300))

  // Detectors 2 and 3 — one turn, so the tool call and the observation are the
  // same act. Phrased positively: it asks for a look, it forbids nothing.
  const before = (await transcript(session, key)).length
  const looked = await sendPrompt(
    session,
    key,
    'Please open that image file at the path you just quoted and describe what is actually in the picture. '
    + 'If the attempt reports a problem, quote the problem verbatim.',
    300_000,
  ).catch(() => undefined)
  const added = (await transcript(session, key)).slice(before)
  const viewImageCalls = added
    .filter(message => typeof message.toolName === 'string' && /view_image|viewimage|image/i.test(message.toolName))
    .map(message => ({
      tool: message.toolName!,
      status: message.toolStatus,
      resultLength: (message.toolResult ?? '').length,
    }))
  const description = looked ? lastAssistantText(looked.added) : ''
  run.observe(`${card} — description`, description.slice(0, 400))
  run.observe(`${card} — image tool calls`, viewImageCalls)

  return {
    card,
    pointerNamed: pointerAnswer.includes('/') && /\.(png|jpe?g|gif|webp|bmp|tiff?)\b/i.test(pointerAnswer),
    viewImageCalls,
    factReported: fact ? description.toLowerCase().includes(fact.toLowerCase()) : false,
    refusalText: [
      ...added.filter(m => m.role === 'error').map(m => m.content),
      ...added.filter(m => (m.toolStatus ?? '') !== 'success').map(m => m.toolResult ?? ''),
      description,
    ].join(' \n ').slice(0, 1200),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const visionCard = process.env.NESSY_CDP_CODEX_VISION_CARD?.trim()
  const gatewayCard = process.env.NESSY_CDP_CODEX_GATEWAY_CARD?.trim()
  const fact = process.env.NESSY_CDP_IMAGE_FACT?.trim()
  const connections = await listConnections(session)
  const codexCards = connections.filter(row => runtimeOf(row.providerType) === 'codex-runtime')
  run.observe('codex cards on this host', codexCards.map(row => row.slug))

  if (!visionCard || !gatewayCard) {
    blocked(
      'this case needs TWO codex-runtime cards named by slug: NESSY_CDP_CODEX_VISION_CARD (a BYO '
      + 'openai-compatible upstream whose model accepts image input) and NESSY_CDP_CODEX_GATEWAY_CARD '
      + '(the gateway card, which is the control — its model declares no image modality and answers '
      + '400 Invalid Chat Message Part). Name the cards, never a key. '
      + `The host lists ${codexCards.map(row => row.slug).join(', ') || 'no codex cards'}.`,
    )
  }
  for (const slug of [visionCard, gatewayCard]) {
    if (!codexCards.some(row => row.slug === slug)) {
      blocked(`"${slug}" is not a codex-runtime connection here; available: ${codexCards.map(row => row.slug).join(', ') || 'none'}`)
    }
  }
  if (!fact) {
    blocked(
      'set NESSY_CDP_IMAGE_FACT to a short phrase that is true of the picture you attached and could not be '
      + 'guessed from its filename. Detector 3 is the only one that separates "the model looked" from '
      + '"the model called a tool"; without it this case can prove a tool ran and nothing more.',
    )
  }

  // The prepared session, NOT a fresh one: the attachment is the precondition the
  // harness cannot create, so the case measures the session the operator built.
  const key = await activeSession(session)
  run.observe('session under test', key)
  const existing = (await transcript(session, key)).length
  run.observe('messages already in it', existing)
  run.require(
    'the open session already carries a conversation',
    existing >= 2,
    `${existing} messages — attach an image in the composer, run one turn, leave the session open, and re-run`,
  )

  const subject = await runArm(session, run, key, visionCard, fact)
  run.check(
    'DETECTOR 1 — the handoff pointer crossed onto the vision card',
    subject.pointerNamed,
    subject.pointerNamed ? undefined
      : `the model named no stored path, so the "${POINTER_MARKER}" / "${IMAGE_NOTE_MARKER}" block did not `
        + 'reach it and nothing below is about view_image',
  )
  run.check(
    'DETECTOR 2 — an image tool ran on the pointer path',
    subject.viewImageCalls.length > 0,
    subject.viewImageCalls.length > 0 ? undefined : 'no image tool call in the transcript',
  )
  run.check(
    'DETECTOR 3 — the model reported something it could only get by looking',
    subject.factReported,
    subject.factReported ? undefined
      : 'the description does not contain the operator-supplied fact, so the image was not seen '
        + '(a tool call that errored is still a tool call)',
  )

  const control = await runArm(session, run, key, gatewayCard, fact)
  run.check(
    'THE CONTROL — the gateway model does NOT get the image',
    !control.factReported,
    control.factReported
      ? 'the gateway card described the picture, which contradicts the measured 400 Invalid Chat Message '
        + 'Part and means the control cannot separate a vision model from a non-vision one'
      : undefined,
  )
  run.observe('control refusal, verbatim', control.refusalText)
}

/**
 * What the owner does before the case runs. Everything below is the app's own
 * attachment pipeline, which is the surface the pointer is derived from.
 */
export const manual = {
  why: 'the composer attach path is a native file picker, which CDP cannot drive',
  steps: [
    'Open a session on any runtime and attach an image whose content is not guessable from its filename.',
    'Send one turn that talks about the image, so the session carries a real conversation.',
    'Leave that session selected, with a single content panel open.',
    'Export NESSY_CDP_CODEX_VISION_CARD, NESSY_CDP_CODEX_GATEWAY_CARD (slugs, not keys) and '
      + 'NESSY_CDP_IMAGE_FACT (a short phrase true of the picture).',
    'Run: bun run scripts/cdp/cases/rs-04.ts',
  ],
  expected: 'on the vision card the pointer crosses, an image tool runs, and the description contains the '
    + 'operator fact; on the gateway card the description does NOT contain it and the refusal is quoted',
  detector: 'the transcript tool messages for the image tool call, and the operator-supplied fact in the reply',
  positiveControl: 'the vision arm itself is the positive control for the gateway arm — a run where neither '
    + 'card sees the image proves nothing about modality',
  doneMeans: 'ledger D4/Codex third leg recorded as driven, with the gateway refusal quoted verbatim',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
