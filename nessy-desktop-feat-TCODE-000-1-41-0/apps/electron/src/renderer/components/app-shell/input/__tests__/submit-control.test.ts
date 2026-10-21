/**
 * L11's actual severity: the composer's one primary control changing function
 * while the user's finger is still on it.
 *
 * An explicit Stop deliberately refills the composer with the in-flight prompt
 * (`ChatDisplay.handleStop(silent=false)`, so the user can tweak and resend).
 * The moment that restore lands, `hasContent` is true while `isProcessing` is
 * still true — `cancelProcessing` is an async round trip and the turn settles
 * only on its terminal event — so the control flipped straight from Stop to
 * Queue/Steer and a second press re-sent the stopped prompt into the
 * still-winding-down turn.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { isUnsteerableQueueRow, resolveSubmitControl } from '../submit-control'

const idle = {
  isProcessing: false,
  hasContent: false,
  queueSupported: true,
  sessionId: 'session-a',
  stopRequestedFor: null,
}

describe('resolveSubmitControl — the ordinary modes', () => {
  it('is Send when no turn is running, content or not', () => {
    expect(resolveSubmitControl(idle)).toEqual({ mode: 'send', inert: false })
    expect(resolveSubmitControl({ ...idle, hasContent: true })).toEqual({
      mode: 'send',
      inert: false,
    })
  })

  it('is Stop on an empty composer during a turn, and Queue/Steer once there is content', () => {
    expect(resolveSubmitControl({ ...idle, isProcessing: true })).toEqual({
      mode: 'stop',
      inert: false,
    })
    expect(resolveSubmitControl({ ...idle, isProcessing: true, hasContent: true })).toEqual({
      mode: 'queue',
      inert: false,
    })
    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: true,
        hasContent: true,
        queueSupported: false,
      }),
    ).toEqual({ mode: 'steer', inert: false })
  })
})

describe('resolveSubmitControl — a stop in flight (L11)', () => {
  it('stays an inert Stop after the restore refills the composer, instead of becoming Queue', () => {
    // The exact live sequence: Stop pressed → prompt restored into the composer
    // → `isProcessing` has NOT settled yet.
    const afterStop = resolveSubmitControl({
      ...idle,
      isProcessing: true,
      hasContent: true,
      stopRequestedFor: 'session-a',
    })

    expect(afterStop.mode).toBe('stop')
    expect(afterStop.inert).toBe(true)
  })

  it('stays inert for a steer-only runtime too, and while the composer is still empty', () => {
    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: true,
        hasContent: true,
        queueSupported: false,
        stopRequestedFor: 'session-a',
      }),
    ).toEqual({ mode: 'stop', inert: true })

    // Empty composer: the mode was already Stop, but the control must still not
    // re-issue the stop — `ChatDisplay.handleStop` appends the restored prompt
    // every time it runs, so a second stop duplicates the text.
    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: true,
        hasContent: false,
        stopRequestedFor: 'session-a',
      }),
    ).toEqual({ mode: 'stop', inert: true })
  })

  it('releases into Send the moment the turn settles, so the restored prompt is resendable', () => {
    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: false,
        hasContent: true,
        stopRequestedFor: 'session-a',
      }),
    ).toEqual({ mode: 'send', inert: false })
  })

  it('does not leak across a session switch — the composer is not remounted', () => {
    // Stop issued on session A; the user switches to session B, which is running
    // its own turn. B's control must still be a live Queue.
    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: true,
        hasContent: true,
        sessionId: 'session-b',
        stopRequestedFor: 'session-a',
      }),
    ).toEqual({ mode: 'queue', inert: false })

    // …and switching back to A, still winding down, is inert again.
    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: true,
        hasContent: true,
        sessionId: 'session-a',
        stopRequestedFor: 'session-a',
      }),
    ).toEqual({ mode: 'stop', inert: true })
  })

  it('matches a composer with no session id against the empty-string marker the component writes', () => {
    // `handleStop` records `sessionId ?? ''`, so a session-less composer (the
    // pre-session placeholder) still guards itself, and a real session id never
    // collides with it.
    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: true,
        hasContent: true,
        sessionId: undefined,
        stopRequestedFor: '',
      }),
    ).toEqual({ mode: 'stop', inert: true })

    expect(
      resolveSubmitControl({
        ...idle,
        isProcessing: true,
        hasContent: true,
        sessionId: 'session-a',
        stopRequestedFor: '',
      }),
    ).toEqual({ mode: 'queue', inert: false })
  })
})

describe('F1.92 (D1.397) — a composer over a session the HOST does not own', () => {
  // The `/btw` panel mounts a whole composer over a synthetic id
  // (`side-question:<real id>`), and `EditPopover`'s inline mode over the stub
  // `'pending'`. No server session answers either, so a Stop there would call
  // `cancelProcessing` with an id nothing knows — which is why the panel used
  // to keep `isProcessing: false` and say "thinking" in words instead of using
  // the composer's own affordance. Both halves are pinned here. (F1.179 then
  // flipped the panel to `isProcessing: pending`, so the minted `isProcessing`
  // arm below is now the panel's LIVE path rather than a defensive one.)
  const minted = { ...idle, sessionId: 'side-question:session-a' }
  const stub = { ...idle, sessionId: 'pending' }

  it('THE DEFECT — a minted composer waiting for its answer shows LOADING, not a live Send', () => {
    expect(resolveSubmitControl({ ...minted, awaitingAnswer: true }))
      .toEqual({ mode: 'loading', inert: true })
    expect(resolveSubmitControl({ ...stub, awaitingAnswer: true }))
      .toEqual({ mode: 'loading', inert: true })
    // …and with the question still in the box, which is the live shape: the
    // panel keeps the text until the answer lands.
    expect(resolveSubmitControl({ ...minted, awaitingAnswer: true, hasContent: true }))
      .toEqual({ mode: 'loading', inert: true })
  })

  it("THE ROW'S CONTROL — never `stop` for a minted id, still `stop` for a real one", () => {
    // Even if something ever made such a session report a turn in flight, the
    // control must not arm a Stop that no server session would answer.
    expect(resolveSubmitControl({ ...minted, isProcessing: true }).mode).toBe('loading')
    expect(resolveSubmitControl({ ...stub, isProcessing: true }).mode).toBe('loading')
    // The same call shape on a real id — the positive control that the rule is
    // keyed on the ID and not on something every arm happens to share.
    expect(resolveSubmitControl({ ...idle, isProcessing: true }))
      .toEqual({ mode: 'stop', inert: false })
  })

  it('CONTROL — an explicit `disableStop` opts any composer in, minted or not', () => {
    expect(resolveSubmitControl({ ...idle, isProcessing: true, disableStop: true }))
      .toEqual({ mode: 'loading', inert: true })
    expect(resolveSubmitControl({ ...idle, awaitingAnswer: true, disableStop: true }))
      .toEqual({ mode: 'loading', inert: true })
  })

  it('CONTROL — nothing in flight: a minted composer is an ordinary live Send', () => {
    expect(resolveSubmitControl(minted)).toEqual({ mode: 'send', inert: false })
    expect(resolveSubmitControl({ ...minted, hasContent: true }))
      .toEqual({ mode: 'send', inert: false })
  })

  it('CONTROL (negative) — `awaitingAnswer` does nothing to a real session', () => {
    // A real session's in-flight state is `isProcessing`; `awaitingAnswer` is
    // the signal a host-unknown surface has instead, and it must not leak.
    expect(resolveSubmitControl({ ...idle, awaitingAnswer: true }))
      .toEqual({ mode: 'send', inert: false })
    expect(resolveSubmitControl({ ...idle, isProcessing: true, awaitingAnswer: true }))
      .toEqual({ mode: 'stop', inert: false })
    expect(resolveSubmitControl({ ...idle, isProcessing: true, hasContent: true, awaitingAnswer: true }))
      .toEqual({ mode: 'queue', inert: false })
  })
})

describe('FreeFormInput wires the control through this module', () => {
  // `bun test` has no DOM (no happy-dom/jsdom/testing-library in this repo), so
  // the rule is tested as a function and the wiring is pinned by source match.
  // The rule itself — the part a mutation would silently delete — is behavioural
  // above.
  const source = readFileSync(
    fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)),
    'utf8',
  )
  // `expect(source).toContain(needle)` prints the whole 3 000-line component on
  // failure. Report the needle instead.
  const present = (needle: string) => ({ needle, inSource: source.includes(needle) })
  const found = (needle: string) => ({ needle, inSource: true })
  const absent = (needle: string) => ({ needle, inSource: false })

  it('computes the mode here and lets `inert` disable the control and drop its handler', () => {
    for (const needle of [
      'const submitControl = resolveSubmitControl({',
      'const submitMode: SubmitMode = submitControl.mode',
      // UB14.28 — the control is `SendButton` now; the mode, `inert`, the
      // disabled verdict and the Stop path are all handed to it from here.
      // A press must reach neither the stop handler nor a form submit: the
      // handler rule is `SendButton`'s, pinned in `sendButton` below and
      // pressed for real in `send-button.test.tsx`.
      'mode={submitMode}',
      'inert={submitControl.inert}',
      'disabled={submitDisabled}',
      'onStop={() => handleStop(false)}',
      'const submitDisabled = submitControl.inert',
      // The stop this composer issued is what arms `inert`, and only the turn
      // actually settling disarms it.
      // BOTH LINES OF `handleStop`, because the second one is the button. A
      // reviewer deleted `onStop?.(silent)` and the whole zone suite stayed
      // green at 158/0 while Stop became completely inoperative — the needle
      // stopped at the line above it.
      "if (!silent) setStopRequestedFor(sessionId ?? '')",
      'onStop?.(silent)',
      // THE DEPENDENCY ARRAY IS PART OF THE NEEDLE, not decoration. The whole
      // fix's liveness rests on this effect re-running when the turn settles:
      // mutating `}, [isProcessing])` to `}, [])` left the zone suite
      // byte-identically green at 158 pass / 368 expect while the button stayed
      // inert for the rest of the session. A needle that stops one character
      // before the array does not guard the array.
      'if (!isProcessing) setStopRequestedFor(null)\n  }, [isProcessing])',
      // The tooltip must not blame "nothing to send" for a disabled control
      // whose real reason is the stop in flight.
      'if (submitControl.inert) return null',
      // F1.92 — the in-flight signal a host-unknown surface has instead of
      // `isProcessing`, and the three places the loading mode has to land: the
      // label, the button TYPE (a `loading` button must not submit the form),
      // and the icon.
      'stopRequestedFor, awaitingAnswer: disableSend,',
      'busy={isShellCommandRunning}',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }

    // …and `SendButton` lands them (UB14.28): the label, the button TYPE (a
    // `loading` button must not submit the form), the icon, and the handler.
    const sendButton = readFileSync(fileURLToPath(new URL('../SendButton.tsx', import.meta.url)), 'utf8')
    for (const needle of [
      "mode === 'loading' ? t('chat.processing.thinking')",
      "type={mode === 'stop' || mode === 'loading' ? 'button' : 'submit'}",
      "busy || mode === 'loading'",
      'onClick={resolveSendButtonPress(mode, inert, onStop)}',
      "return mode === 'stop' && !inert ? onStop : undefined",
    ]) {
      expect({ needle, inSource: sendButton.includes(needle) }).toEqual(found(needle))
    }

    // The pre-fix shape: the mode as a bare ternary in the component.
    const stale = 'const submitMode: SubmitMode = !isProcessing'
    expect(present(stale)).toEqual(absent(stale))
  })
})

/**
 * F1.331 — the composer said "Steer" for a draft the server was going to QUEUE.
 *
 * Since F1.244 a mid-turn send carrying files is queued on every connection
 * (`canSteerTextPayload`: a steer is a text door on all three runtimes), but the
 * control read only the connection's default, so a steer-default connection
 * labelled a draft with staged files "Steer" — breaking P6.946's rule that the
 * control and the send agree.
 */
describe('F1.331 — a mid-turn draft with files is labelled Queue', () => {
  it('THE ROW: on a steer-default connection, staged files make the control Queue', () => {
    expect(
      resolveSubmitControl({ ...idle, isProcessing: true, hasContent: true, queueSupported: false, hasAttachments: true }),
    ).toEqual({ mode: 'queue', inert: false })
  })

  it('CONTROLS — a text-only draft keeps Steer; files change neither an idle Send nor the empty-composer Stop', () => {
    expect(
      resolveSubmitControl({ ...idle, isProcessing: true, hasContent: true, queueSupported: false, hasAttachments: false }),
    ).toEqual({ mode: 'steer', inert: false })
    expect(resolveSubmitControl({ ...idle, hasContent: true, hasAttachments: true })).toEqual({ mode: 'send', inert: false })
    expect(resolveSubmitControl({ ...idle, isProcessing: true, queueSupported: false, hasAttachments: true }))
      .toEqual({ mode: 'stop', inert: false })
  })

  it('FreeFormInput hands the staged files to the control, and hides the steer/queue chord while files are staged', () => {
    const src = readFileSync(fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)), 'utf-8')
    const call = src.slice(src.indexOf('resolveSubmitControl({'), src.indexOf('})', src.indexOf('resolveSubmitControl({')))
    expect(call.length).toBeLessThan(400)
    expect(call).toContain('hasAttachments: attachments.length > 0')
    // With files staged the chord cannot steer (the host queues them), so the line
    // naming its effect would be false in one direction or the other.
    expect(src).toContain('midStreamOverride={midStreamOverrideHotkey && attachments.length === 0 && !queueHoldsUnsteerableRow')
  })
})

/**
 * F1.481 (3) — P-qqb-4: a TEXT draft behind a queued row the host will not
 * steer (files, a workflow) is QUEUED by F1.338's FIFO rule (`queueHoldsUnsteerablePayload`
 * in `effectiveMidStreamBehavior`, above the chord), and the control still said
 * Steer. The composer is now told whether the queue holds such a row.
 */
describe('F1.481 (3) — a text draft behind an unsteerable queued row is labelled Queue', () => {
  const mid = { ...idle, isProcessing: true, hasContent: true, queueSupported: false, hasAttachments: false }

  it('THE ROW: text draft + a queued file or workflow row → Queue', () => {
    expect(resolveSubmitControl({ ...mid, queueHoldsUnsteerableRow: true })).toEqual({ mode: 'queue', inert: false })
  })

  it('CONTROL — text draft + a queued text row (or no queue) → Steer, as before', () => {
    expect(resolveSubmitControl({ ...mid, queueHoldsUnsteerableRow: false })).toEqual({ mode: 'steer', inert: false })
    expect(resolveSubmitControl(mid)).toEqual({ mode: 'steer', inert: false })
  })

  it('isUnsteerableQueueRow: the host verdict first, the file count for an older host', () => {
    expect(isUnsteerableQueueRow({ attachmentsCount: 0, steerable: false })).toBe(true) // a workflow row
    expect(isUnsteerableQueueRow({ attachmentsCount: 1, steerable: false })).toBe(true) // a file row
    expect(isUnsteerableQueueRow({ attachmentsCount: 1 })).toBe(true) // an older host, files
    expect(isUnsteerableQueueRow({ attachmentsCount: 0, steerable: true })).toBe(false)
    expect(isUnsteerableQueueRow({ attachmentsCount: 0 })).toBe(false) // an older host, text
  })

  it('ChatInputZone hands the queue\'s answer to the composer, and FreeFormInput to the control', () => {
    const zone = readFileSync(fileURLToPath(new URL('../ChatInputZone.tsx', import.meta.url)), 'utf-8')
    expect(zone).toContain('queueHoldsUnsteerableRow={queueState.queue.some(isUnsteerableQueueRow)}')
    const src = readFileSync(fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)), 'utf-8')
    const call = src.slice(src.indexOf('resolveSubmitControl({'), src.indexOf('})', src.indexOf('resolveSubmitControl({')))
    expect(call).toContain('queueHoldsUnsteerableRow,')
  })
})
