/**
 * P3.138 — the Pi half of the legibility pin: the half that FAILED, and the
 * remedy that closed it.
 *
 * THE CONDITION THE 2026-08-28 OWNER RULING DEPENDS ON. *"Carry the modality
 * faithfully, let the ENDPOINT refuse"* replaces our guess about a model's
 * modality with the endpoint's own answer — and that holds only while the
 * endpoint's answer REACHES the user as something they can act on. It was
 * pinned on `claude-runtime` (`config/__tests__/model-supports-images.test.ts`)
 * and then on codex
 * (`codex-responses-adapter/src/__tests__/image-refusal-legibility.test.ts`).
 * Pi was the unmeasured third, and this file is the measurement.
 *
 * THE VERDICT WHEN THIS FILE WAS WRITTEN, measured 2026-09-03 (W3-h): **on Pi
 * the gateway's named refusal did not reach the user at all.** `parseError`
 * classified it correctly and then REPLACED its words — the user read
 * `Invalid Request: The API rejected this request.`, true of every 400 ever
 * sent — and the gateway's own sentence survived only in `originalError`. Pi
 * was a THIRD outcome, not a mirror of the other two: claude carried the
 * upstream sentence into `details`, codex passed the 400 through the loopback
 * adapter, and Pi told the user something generic.
 *
 * **THE REMEDY LANDED THE SAME DAY (W3-d, P3.138), and this file is now the
 * pin that the three arms agree rather than the pin that they do not.** The
 * two `not.toContain` assertions this docblock said must flip have flipped;
 * what replaced them is below, and the cross-arm control is unchanged, which
 * is the point — the assertion about Pi and the assertion about claude now
 * read the same field, with the same `API message: ` prefix, because
 * `parseError`'s `invalid_request` branch was given the shape
 * `mapClaudeSdkAssistantError` already had rather than a new one of its own.
 *
 * WHAT DELIBERATELY DID NOT CHANGE, because it is what keeps the arms equal:
 * the user-visible `message` is still the generic sentence on BOTH arms. A
 * message override — the treatment `proxy_error` and `model_no_tool_support`
 * get in the same function — would have made Pi louder than claude and
 * re-opened the asymmetry from the other side.
 *
 * THE RESIDUE, still true and still measured here: `packages/ui`'s
 * `SessionViewer` reads NEITHER `errorDetails` NOR `errorOriginal` (0
 * occurrences of each; `errorCode` at `chat/turn-utils.ts:199` is the positive
 * control that the probe reads that tree), so on that surface the refusal is
 * invisible — and so is claude's, and so is every other typed error's. That is
 * one surface missing the disclosure for ALL arms, which is a different repair
 * from this one. The Electron renderer does read both
 * (`ChatDisplay.tsx`'s error card), which is where this detail line lands.
 *
 * ONE THRESHOLD FACT, because it decides what this pin is even about. Pi is
 * `pi_compat` for the gateway connection, and `pi_compat` is the one carve-out
 * where an UNDECLARED `supportsImages` means `false`
 * (`config/compat-image-default.ts`), so on an undeclared model two gates strip
 * the image before it leaves the machine and the gateway never refuses at all.
 * The refusal below is therefore the declared-`true` path. That asymmetry with
 * every other provider is `compat-image-default.ts`'s own recorded decision and
 * is not re-litigated here.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseError } from '../errors.ts'
import { mapClaudeSdkAssistantError } from '../claude-sdk-error-mapper.ts'
import {
  IMAGE_REFUSAL_DETAIL_PREFIX,
  imageRefusalSentenceFromErrorDetails,
} from '../../config/llm-connections.ts'

/** The gateway's own words, verbatim, measured live 2026-08-28 (darwin-arm64). */
const REFUSAL = 'Invalid Chat Message Part: Model Does Not Support Image Inputs'

/**
 * The exact string that reaches `parseError` on the Pi arm. pi-ai's
 * `formatProviderError` renders an OpenAI-wire error as `<status>: <body>`,
 * and the body is the whole envelope — so both of the classifying branch's
 * disjuncts (`invalid_request_error` and `400 `) are present, which is why the
 * classification does not depend on which pi-ai formatting arm ran.
 */
const PI_WIRE_MESSAGE = `400: ${JSON.stringify({ message: REFUSAL, type: 'invalid_request_error', code: null })}`

describe('P3.138 · the Pi arm and the endpoint refusal', () => {
  it('classifies the refusal rather than dropping it into unknown_error', () => {
    // The near-misses matter: `image_too_large` wants a dimension or a size
    // beside the word "image", and the tool-support branch wants "does not
    // support tool". Landing on `invalid_request` is the correct branch — what
    // that branch then DOES with the words was the defect, and is asserted
    // below.
    expect(parseError(new Error(PI_WIRE_MESSAGE)).code).toBe('invalid_request')
  })

  it('positive control — the classifier is reading the string, not answering by rote', () => {
    const unrecognised = parseError(new Error('something entirely unrecognised'))
    expect(unrecognised.code).toBe('unknown_error')
    // And it keeps the unrecognised text, which is what makes the assertions
    // below a statement about the CLASSIFIED path rather than about the field.
    expect(unrecognised.originalError).toBe('something entirely unrecognised')
  })

  it('carries the endpoint\'s words to the user, in the field claude uses (P3.138 remedy)', () => {
    const error = parseError(new Error(PI_WIRE_MESSAGE))

    // THE FLIP. Both of these were `not.toContain` until the remedy landed.
    expect(error.details?.some(detail => detail.includes(REFUSAL))).toBe(true)
    // P6.707 — and the PREFIX moved, on both arms at once. This line read
    // `API message: ${REFUSAL}` until then; it now reads the anchor, and the
    // cross-arm control below asserts claude writes the identical string, which
    // is the property this file exists to hold. A generic 400 keeps the old
    // prefix on both arms (`errors.test.ts`, the status-prefix arm).
    expect(error.details).toContain(`${IMAGE_REFUSAL_DETAIL_PREFIX}${REFUSAL}`)
  })

  /**
   * P6.707 — the seam is uniform, and this is the assertion that says so.
   *
   * P6.584 wired the LEARNED image-refusal writer to
   * `mapClaudeSdkAssistantError`, which is the claude arm alone. Pi and codex
   * reach the renderer through `parseError`, so the refusal they carried was
   * legible (P3.138) but unlearnable: `imageRefusalSentenceFromErrorDetails`
   * matches the anchor, and only claude wrote one. Two lines closed it.
   *
   * `codex-runtime` is the third arm and takes the same branch — this function
   * reads the message, not the provider, which is what makes ONE writer for
   * three runtimes possible at all.
   */
  it('P6.707 — the anchored line is what the renderer\'s learn-writer reads back', () => {
    for (const providerType of ['pi_compat', 'codex-runtime']) {
      const error = parseError(new Error(PI_WIRE_MESSAGE), { providerType })
      expect(imageRefusalSentenceFromErrorDetails(error.details)).toBe(REFUSAL)
    }
  })

  it('P6.707 negative — a generic 400 anchors nothing and stays on the old prefix', () => {
    // Owner Q12: never on a generic 400. The message below is classified into
    // the SAME `invalid_request` branch, so this is a statement about the
    // anchor and not about the classification.
    const generic = parseError(new Error(
      `400: ${JSON.stringify({ message: 'request was malformed', type: 'invalid_request_error' })}`,
    ))
    expect(generic.code).toBe('invalid_request')
    expect(generic.details).toContain('API message: request was malformed')
    expect(imageRefusalSentenceFromErrorDetails(generic.details)).toBeUndefined()
  })

  it('P6.707 control — claude has not moved; the two arms write the same string', () => {
    const claude = mapClaudeSdkAssistantError('invalid_request', {
      actualError: null,
      capturedApiError: { status: 400, statusText: 'Bad Request', message: REFUSAL, timestamp: 1 },
      providerType: 'claude-runtime',
      claudeRuntimeUpstreamKind: 'nestor',
      userTurnHadAttachments: true,
    })
    const pi = parseError(new Error(PI_WIRE_MESSAGE))
    expect(imageRefusalSentenceFromErrorDetails(claude.details))
      .toBe(imageRefusalSentenceFromErrorDetails(pi.details))
    // And neither says it twice.
    expect(claude.details?.filter(d => d.includes(REFUSAL))).toHaveLength(1)
    expect(pi.details?.filter(d => d.includes(REFUSAL))).toHaveLength(1)
  })

  it('leaves the user-visible sentence generic, so Pi says exactly what claude says', () => {
    const error = parseError(new Error(PI_WIRE_MESSAGE))
    const userVisible = [error.title, error.message].filter(Boolean).join(': ')

    // This is verbatim what `SessionManager` composes into the message content,
    // and it is UNCHANGED by the remedy on purpose: the claude arm's own
    // `invalid_request` case keeps this same sentence and puts the upstream
    // words in `details`. A message override here would make the two arms
    // differ again, in the other direction.
    expect(userVisible).toBe('Invalid Request: The API rejected this request.')
    expect(JSON.stringify(error.actions ?? [])).not.toContain(REFUSAL)
  })

  it('still keeps them in `originalError` too, and packages/ui still reads neither field', () => {
    // Not a redundancy: `originalError` is what `ChatDisplay` renders as the
    // `Raw:` line, and the remedy adds a NAMED line beside it rather than
    // moving the raw text out from under a surface that already showed it.
    expect(parseError(new Error(PI_WIRE_MESSAGE)).originalError).toContain(REFUSAL)

    // THE RESIDUE, and the half a field assertion alone cannot show.
    // Source-read with its own positive control: the same probe finds a sibling
    // error field that IS consumed, so a zero here is an absence in the package
    // rather than a broken probe. This is NOT per-arm — claude's `details` are
    // equally unread here — so it is recorded, not fixed by this row.
    const ui = resolve(import.meta.dir, '..', '..', '..', '..', 'ui', 'src')
    const turnUtils = readFileSync(resolve(ui, 'components', 'chat', 'turn-utils.ts'), 'utf-8')
    const viewer = readFileSync(resolve(ui, 'components', 'chat', 'SessionViewer.tsx'), 'utf-8')
    expect(turnUtils).toContain('errorCode')
    expect(viewer).not.toContain('originalError')
    expect(viewer).not.toContain('errorOriginal')
    expect(viewer).not.toContain('errorDetails')
  })

  /**
   * The cross-arm control, on the same rig and in the same file, and it is
   * UNCHANGED by the remedy — which is now its whole value. It was written
   * when the claim was comparative ("Pi swallows it" is only meaningful beside
   * an arm that does not); it is now the definition the Pi assertions above
   * were made to match, field for field and prefix for prefix. If this goes
   * red, claude's arm moved and Pi's convergence with it is stale.
   */
  it('cross-arm control — claude-runtime carries the same refusal through verbatim', () => {
    const claude = mapClaudeSdkAssistantError('invalid_request', {
      actualError: null,
      capturedApiError: { status: 400, statusText: 'Bad Request', message: REFUSAL, timestamp: 1 },
      providerType: 'claude-runtime',
      claudeRuntimeUpstreamKind: 'nestor',
      userTurnHadAttachments: true,
    })

    expect(claude.details?.some(detail => detail.includes(REFUSAL))).toBe(true)
  })
})
