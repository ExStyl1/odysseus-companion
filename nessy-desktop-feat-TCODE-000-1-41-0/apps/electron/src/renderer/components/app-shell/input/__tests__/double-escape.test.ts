/**
 * P2.447 — double-Esc in the composer, all THREE documented behaviours.
 *
 * `checkpointing.md#rewind-and-summarize` is one sentence for the opener and one
 * for the branch that gets forgotten:
 *
 *   "Run `/rewind`, or press `Esc` twice when the prompt input is empty, to
 *    open the rewind menu."
 *   "If the prompt input contains text, double `Esc` clears it instead of
 *    opening the menu. The cleared text is saved to your input history, so
 *    press `Up` to recall it after you finish in the rewind menu."
 *
 * So: OPEN when empty, CLEAR when not, and the cleared text must really land
 * where `Up` can reach it. Each has its own describe below, and each has a
 * mutant recorded in the commit message.
 *
 * `bun test` has no DOM here (no testing-library, no happy-dom/jsdom in this
 * repo, and the renderer's component tests are `renderToStaticMarkup`-only,
 * which runs no effects), so the state machine is driven through the module the
 * composer delegates to — plus a source-read arm that the composer really calls
 * it, and calls it with the arguments these tests assume. Without that arm the
 * tests above would be a PARALLEL MODEL of the composer rather than a test of
 * it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import {
  COMPOSER_INPUT_HISTORY_LIMIT,
  DOUBLE_ESCAPE_WINDOW_MS,
  pushComposerInputHistory,
  recallComposerInputHistory,
  resolveDoubleEscape,
  type DoubleEscapeOutcome,
} from '../double-escape'
import { REWIND_COMMAND_LABEL, parseRewindCommand } from '@nessy-agent/shared/slash-commands/rewind'

/**
 * The composer's whole double-Esc state machine, as the component holds it: one
 * armed-at timestamp, one draft, one history. Nothing here is a re-implementation
 * of a decision — every decision is delegated to the module, and the source-read
 * arm at the bottom pins that the component delegates the same ones.
 */
function makeComposer(initialDraft = '') {
  let draft = initialDraft
  let armedAt: number | null = null
  let history: string[] = []
  const rewindOpens: string[] = []
  let clock = 1_000_000

  const tick = (ms: number) => { clock += ms }

  const pressEscape = (): DoubleEscapeOutcome['kind'] => {
    const outcome = resolveDoubleEscape({
      now: clock,
      armedAt,
      hasDraftText: draft.trim().length > 0,
    })
    armedAt = outcome.armedAt
    if (outcome.kind === 'clear-draft') {
      history = pushComposerInputHistory(history, draft)
      draft = ''
    } else if (outcome.kind === 'open-rewind-menu') {
      // What the component does: submit the documented command through the one
      // seam that already answers it. Recorded as the submitted string so the
      // assertion can check it is a command `ChatDisplay` really intercepts.
      rewindOpens.push(REWIND_COMMAND_LABEL)
    }
    return outcome.kind
  }

  const pressUp = (): boolean => {
    const recalled = recallComposerInputHistory({ entries: history, draftText: draft })
    if (recalled === null) return false
    draft = recalled
    return true
  }

  return {
    tick,
    pressEscape,
    pressUp,
    type: (text: string) => { draft = text },
    get draft() { return draft },
    get history() { return [...history] },
    get rewindOpens() { return [...rewindOpens] },
    get armed() { return armedAt !== null },
  }
}

describe('behaviour 1 — Esc Esc on an EMPTY input opens the rewind menu', () => {
  it('opens on the second press, and not on the first', () => {
    const composer = makeComposer('')

    expect(composer.pressEscape()).toBe('arm')
    expect(composer.rewindOpens).toEqual([])
    expect(composer.armed).toBe(true)

    expect(composer.pressEscape()).toBe('open-rewind-menu')
    expect(composer.rewindOpens).toEqual(['/rewind'])
    // Disarmed by the acting press: a THIRD lone Escape must not re-open.
    expect(composer.armed).toBe(false)
    expect(composer.pressEscape()).toBe('arm')
    expect(composer.rewindOpens).toEqual(['/rewind'])
  })

  it('routes through a string the existing `/rewind` interception really answers', () => {
    // The opener is a second way IN, not a second implementation: the submitted
    // text has to be something `ChatDisplay.handleSubmit`'s parser accepts, or
    // the double-Esc would reach the model as prose instead of opening a menu.
    const composer = makeComposer('')
    composer.pressEscape()
    composer.pressEscape()

    expect(composer.rewindOpens).toHaveLength(1)
    expect(parseRewindCommand(composer.rewindOpens[0]!)).toEqual({ kind: 'rewind' })
  })

  it('re-arms instead of opening once the window has passed', () => {
    const composer = makeComposer('')
    expect(composer.pressEscape()).toBe('arm')
    composer.tick(DOUBLE_ESCAPE_WINDOW_MS + 1)
    expect(composer.pressEscape()).toBe('arm')
    expect(composer.rewindOpens).toEqual([])

    // …and the boundary itself still counts as a double press.
    const onBoundary = makeComposer('')
    expect(onBoundary.pressEscape()).toBe('arm')
    onBoundary.tick(DOUBLE_ESCAPE_WINDOW_MS)
    expect(onBoundary.pressEscape()).toBe('open-rewind-menu')
  })

  it('re-arms rather than firing when the wall clock steps backwards', () => {
    // `Date.now()` is a wall clock. Without this, an NTP correction leaves the
    // composer armed for the length of the offset and the next lone Escape
    // silently wipes a draft.
    expect(resolveDoubleEscape({ now: 500, armedAt: 900, hasDraftText: true }))
      .toEqual({ kind: 'arm', armedAt: 500 })
  })

  it('window matches the app’s other double-Esc', () => {
    // Pinned against a LITERAL, not against the constant: `expect(ms).toBe(MS)`
    // is a tautology that holds for any window. 2 s is `ESC_TIMEOUT_MS` in
    // `EscapeInterruptContext` — one product, one double-press feel.
    expect(DOUBLE_ESCAPE_WINDOW_MS).toBe(2000)
  })
})

describe('behaviour 2 — Esc Esc with TEXT clears the draft instead of opening', () => {
  it('clears, and never opens the menu', () => {
    const composer = makeComposer('the prompt I was still writing')

    expect(composer.pressEscape()).toBe('arm')
    expect(composer.draft).toBe('the prompt I was still writing')

    expect(composer.pressEscape()).toBe('clear-draft')
    expect(composer.draft).toBe('')
    expect(composer.rewindOpens).toEqual([])
  })

  it('decides on the branch by the draft at the SECOND press, not the first', () => {
    // A user who types during the arm window gets the clear branch, and one who
    // clears theirs some other way gets the opener. The page's condition is a
    // condition on the input, not on when the sequence started.
    const typed = makeComposer('')
    expect(typed.pressEscape()).toBe('arm')
    typed.type('typed between the two presses')
    expect(typed.pressEscape()).toBe('clear-draft')

    const emptied = makeComposer('was here a moment ago')
    expect(emptied.pressEscape()).toBe('arm')
    emptied.type('')
    expect(emptied.pressEscape()).toBe('open-rewind-menu')
  })

  it('treats a whitespace-only draft as EMPTY — it opens the menu', () => {
    // "contains text" is not "contains characters": a stray newline left behind
    // by an edit must not turn the documented opener into a no-op the user
    // cannot explain.
    const composer = makeComposer('\n  \t ')
    expect(composer.pressEscape()).toBe('arm')
    expect(composer.pressEscape()).toBe('open-rewind-menu')
  })
})

describe('behaviour 3 — the cleared text lands in input history and `Up` recalls it', () => {
  it('walks the documented round trip: clear, go to the menu, come back, press Up', () => {
    const composer = makeComposer('a prompt worth getting back')

    composer.pressEscape()
    expect(composer.pressEscape()).toBe('clear-draft')
    expect(composer.draft).toBe('')
    expect(composer.history).toEqual(['a prompt worth getting back'])

    expect(composer.pressUp()).toBe(true)
    expect(composer.draft).toBe('a prompt worth getting back')
  })

  it('hands back the text VERBATIM, trailing whitespace included', () => {
    const composer = makeComposer('two lines\nand a trailing newline\n')
    composer.pressEscape()
    composer.pressEscape()
    composer.pressUp()
    expect(composer.draft).toBe('two lines\nand a trailing newline\n')
  })

  it('leaves `Up` alone whenever the input has any content', () => {
    // The composer is multi-line: `Up` is caret movement, and an input holding
    // even a lone newline has a caret with somewhere to go.
    expect(recallComposerInputHistory({ entries: ['recorded'], draftText: 'x' })).toBeNull()
    expect(recallComposerInputHistory({ entries: ['recorded'], draftText: '\n' })).toBeNull()
    expect(recallComposerInputHistory({ entries: ['recorded'], draftText: '' })).toBe('recorded')

    const composer = makeComposer('still typing')
    expect(composer.pressUp()).toBe(false)
    expect(composer.draft).toBe('still typing')
  })

  it('declines `Up` when nothing has been cleared, so the key keeps its old meaning', () => {
    const composer = makeComposer('')
    expect(composer.pressUp()).toBe(false)
    expect(recallComposerInputHistory({ entries: [], draftText: '' })).toBeNull()
  })

  it('does not grow by one on every clear→recall→clear lap', () => {
    const composer = makeComposer('the same prompt')
    composer.pressEscape(); composer.pressEscape()
    composer.pressUp()
    composer.pressEscape(); composer.pressEscape()
    composer.pressUp()

    expect(composer.history).toEqual(['the same prompt'])
    expect(composer.draft).toBe('the same prompt')
  })

  it('records nothing for a whitespace-only draft, and keeps the newest first', () => {
    expect(pushComposerInputHistory([], '   \n ')).toEqual([])
    expect(pushComposerInputHistory(['older'], 'newer')).toEqual(['newer', 'older'])
  })

  it('is bounded, and drops the oldest first', () => {
    let entries: string[] = []
    for (let i = 0; i < COMPOSER_INPUT_HISTORY_LIMIT + 5; i++) {
      entries = pushComposerInputHistory(entries, `draft ${i}`)
    }
    expect(entries).toHaveLength(COMPOSER_INPUT_HISTORY_LIMIT)
    expect(entries[0]).toBe(`draft ${COMPOSER_INPUT_HISTORY_LIMIT + 4}`)
    expect(entries).not.toContain('draft 0')
  })

  it('returns a new array rather than mutating the caller’s', () => {
    // The composer holds this in a ref; a mutated array would let a stale render
    // see the new head.
    const before = ['older']
    const after = pushComposerInputHistory(before, 'newer')
    expect(before).toEqual(['older'])
    expect(after).not.toBe(before)
  })
})

describe('the composer really ships this, and ships it in the composer', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)),
    'utf8',
  )
  // `expect(source).toContain(needle)` prints the whole 3 000-line component on
  // failure. Report the needle instead.
  const present = (needle: string) => ({ needle, inSource: source.includes(needle) })
  const found = (needle: string) => ({ needle, inSource: true })
  const absent = (needle: string) => ({ needle, inSource: false })

  it('calls every entry point, with the arguments these tests assume', () => {
    for (const needle of [
      // The decision, delegated whole — including the emptiness test the page's
      // two branches turn on.
      "hasDraftText: inputRef.current.trim().length > 0",
      'escapeArmedAtRef.current = outcome.armedAt',
      // Behaviour 1: the opener routes to the EXISTING `/rewind` seam.
      'onSubmit(REWIND_COMMAND_LABEL, undefined)',
      // Behaviour 2: the clear.
      'clearDraftIntoInputHistory()',
      // Behaviour 3: the cleared text — the LIVE draft, not a placeholder — is
      // what reaches the history, and `Up` reads that history back.
      'pushComposerInputHistory(inputHistoryRef.current, inputRef.current)',
      'recallClearedDraft()',
      'entries: inputHistoryRef.current,',
      'draftText: inputRef.current,',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
  })

  it('holds no second copy of the decision, and no window-level Escape listener', () => {
    for (const needle of [
      // The refused mechanism. A window Escape consumer would race the action
      // registry's capture-phase listener; P2.425 refused it and so does this.
      "addEventListener('keydown'",
      'DOUBLE_ESCAPE_WINDOW_MS',
      // The shape a re-implementation takes: the component comparing timestamps
      // itself instead of asking the module.
      'Date.now() - escapeArmedAtRef.current',
    ]) {
      expect(present(needle)).toEqual(absent(needle))
    }
  })

  it('drops both the history and a pending arm on a session switch', () => {
    // This component is not remounted when the session changes, so without the
    // reset a half-typed prompt from one conversation is recallable in another.
    // D1.111 — bounded by the effect's OWN terminator rather than by 200 and 260
    // characters. The second assertion here used to BE the second window: it read
    // 60 more characters than the first and looked for `}, [sessionId])`, i.e. it
    // was asking where the effect ends. So the end is read once, the region is
    // the effect, and nothing has to be maintained when a line is added to it.
    const reset = source.indexOf('inputHistoryRef.current = []')
    expect(reset).toBeGreaterThan(-1)
    const END = '}, [sessionId])'
    const end = source.indexOf(END, reset)
    expect(end, 'the reset is not inside a session-keyed effect').toBeGreaterThan(-1)
    const effect = source.slice(reset, end + END.length)
    expect(effect).toContain('escapeArmedAtRef.current = null')
    // The boundary control: the region stops AT the effect, so the next thing the
    // file declares is outside it. A brace scan or an end anchor that ran away
    // would make the assertion above pass for a match anywhere below.
    expect(effect).not.toContain('const handleKeyDown')
  })

  it('no longer blurs on the first Escape — the change that makes a second press reachable', () => {
    // Stated as a behaviour change, not left to be discovered: a blur on the
    // first press moves focus to `body`, an ancestor of the React root, so no
    // second Escape can reach this handler at all. Hearing it would have needed
    // the window-level consumer the test above forbids.
    expect(present('richInputRef.current?.blur()')).toEqual(absent('richInputRef.current?.blur()'))
  })

  it('is NOT an action-registry binding, so nothing claims it is rebindable', () => {
    const definitions = readFileSync(
      fileURLToPath(new URL('../../../../actions/definitions.ts', import.meta.url)),
      'utf8',
    )
    // The product statement, machine-checked: P6.49's map canonicalises to ONE
    // accelerator and has no grammar for a double press, so an action here would
    // fire on the FIRST Escape and print a chord the user cannot actually use.
    // `chat.stopProcessing` is the one `escape` action and it stays the only one.
    const escapeBindings = definitions.match(/defaultHotkey: 'escape'/g) ?? []
    expect(escapeBindings).toHaveLength(2) // chat.stopProcessing + navigator.clearSelection
    expect(definitions.includes('rewind')).toBe(false)
    expect(definitions.includes('doubleEscape')).toBe(false)
  })
})

/**
 * F1.166 (origin WJ-b P-WJ-b-1) — a chat the RENDERER minted has no rewind, so
 * the chord must not synthesise one.
 *
 * The opener works by SUBMITTING `/rewind` through the composer's `onSubmit`,
 * trusting `ChatDisplay.handleSubmit` to intercept it. F1.87 taught that
 * interception to let a `/rewind` typed into a renderer-minted chat (the `/btw`
 * panel's synthetic id, `EditPopover`'s `'pending'` stub) through as ordinary
 * text — right for text the user TYPED, and wrong for text the chord made up: in
 * the `/btw` panel it becomes a side question the user never asked.
 *
 * In the shipped panel the route is guarded by accident: the composer sits in a
 * Radix popover, so `hasOpenOverlay()` answers true, the handler returns before
 * the chord, and Radix dismisses the panel on the first press. But that is a
 * live DOM fact about WHERE the panel is mounted — the playground renders the
 * same panel outside any popover — so the decision is made here instead, from
 * a property of the id: no rewind to open means the chord's opener declines.
 * The clear branch is left alone; it is the draft's, not the session's.
 */
describe('F1.166 — Esc Esc in a chat with no rewind asks nothing', () => {
  const now = 5_000_000

  it('THE DEFECT — the second press on an EMPTY input declines instead of opening', () => {
    const outcome = resolveDoubleEscape({ now, armedAt: now - 100, hasDraftText: false, rewindAvailable: false })
    expect(outcome).toEqual({ kind: 'decline', armedAt: null })
  })

  it('the first press still arms, and the clear branch is untouched in such a chat', () => {
    expect(resolveDoubleEscape({ now, armedAt: null, hasDraftText: false, rewindAvailable: false }))
      .toEqual({ kind: 'arm', armedAt: now })
    expect(resolveDoubleEscape({ now, armedAt: now - 100, hasDraftText: true, rewindAvailable: false }))
      .toEqual({ kind: 'clear-draft', armedAt: null })
  })

  it('CONTROL — the main composer (a host session: rewind available, and the default) still opens the menu', () => {
    expect(resolveDoubleEscape({ now, armedAt: now - 100, hasDraftText: false, rewindAvailable: true }))
      .toEqual({ kind: 'open-rewind-menu', armedAt: null })
    expect(resolveDoubleEscape({ now, armedAt: now - 100, hasDraftText: false }))
      .toEqual({ kind: 'open-rewind-menu', armedAt: null })
  })

  it('the composer hands the chord the minted-id fact, and submits `/rewind` only from the opener', () => {
    const source = readFileSync(fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)), 'utf8')
    const escapeAt = source.indexOf("if (e.key === 'Escape') {")
    expect(escapeAt).toBeGreaterThan(-1)
    const call = source.indexOf('const outcome = resolveDoubleEscape({', escapeAt)
    const opener = source.indexOf("if (outcome.kind === 'open-rewind-menu') {", call)
    const submit = source.indexOf('onSubmit(REWIND_COMMAND_LABEL, undefined)', opener)
    // Positive control on the region: the three anchors are one handler, in order.
    expect(call).toBeGreaterThan(escapeAt)
    expect(opener).toBeGreaterThan(call)
    expect(submit).toBeGreaterThan(opener)
    expect(submit - escapeAt).toBeLessThan(8_000) // measured 5 380 at F1.166: the handler's own comments are long
    const callRegion = source.slice(call, opener)
    expect(callRegion).toContain("rewindAvailable: !isRendererMintedSessionId(sessionId ?? '')")
  })
})
