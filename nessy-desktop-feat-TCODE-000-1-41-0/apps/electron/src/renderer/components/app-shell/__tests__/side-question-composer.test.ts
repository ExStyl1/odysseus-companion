/**
 * D1.375 — THE `/btw` PANEL CAN BE TYPED INTO.
 *
 * The owner met the defect in use on 2026-09-18 (screenshot): the side-question
 * panel opened as a 420x440 box whose whole body was the compact chat's own
 * empty state — "What would you like to change?" — with no input anywhere in it.
 * R36 had hidden the composer deliberately, on `interactive-mode.md:369`; the
 * owner ruled the other way, and a side question is now a chat.
 *
 * TWO INSTRUMENTS, and the split is not arbitrary. The three decisions the panel
 * makes are pure and live in `side-question-composer.ts`, so they are DRIVEN
 * here. The wiring — which component mounts where, with which prop — cannot be:
 * `SideQuestionOverlay` imports `ChatDisplay`, and importing `ChatDisplay` in a
 * bare bun process throws `import.meta.glob is not a function` from
 * `ThemeContext.tsx` (measured by `never-persist-badge-mount.test.tsx` and
 * `session-goal-mount.test.tsx`, re-confirmed by this row: the renderer graph
 * under it also carries the 136 s `pdfjs`/`DOMMatrix` trap AGENTS.md records).
 * So the mount is pinned against the SOURCE, the same way its two neighbours
 * pin theirs.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { typedOutOfBandCommandSubmission } from '../input/slash-command-actions'
import {
  SIDE_QUESTION_COMPOSER_SELECTOR,
  SIDE_QUESTION_PANEL_WIDTH,
  SIDE_QUESTION_PLACEHOLDER_KEYS,
  SIDE_QUESTION_SESSION_PREFIX,
  isSideQuestionSessionId,
  nestedSideQuestionText,
  sideQuestionComposerCapabilities,
  sideQuestionPanelHeight,
  sideQuestionSessionId,
} from '../side-question-composer'

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const RUNTIME_CAPABILITIES: ComposerCapabilities = {
  attachments: { files: true, images: 'per-model', folders: true },
  mentions: { files: true, skills: true, sources: true },
  slash: { commandIds: 'all', excludedCommandIds: ['compact'] },
  submit: { queue: true, steer: false },
  reasoning: { levels: ['medium'] },
  permissions: { modes: ['default', 'plan'] },
  connection: { switchable: true, activeRuntime: 'anthropic' },
  contextMeter: true,
  externalFooter: { gitBranch: true },
}

describe('the /btw panel composer (D1.375)', () => {
  it('keeps the runtime submit posture and drops what the ask cannot carry', () => {
    const narrowed = sideQuestionComposerCapabilities(RUNTIME_CAPABILITIES)

    // POSITIVE — the row asks for queue/steer "per the runtime's composer
    // capabilities", so `submit` is passed through UNTOUCHED, as is `reasoning`.
    expect(narrowed?.submit).toEqual({ queue: true, steer: false })
    expect(narrowed?.reasoning).toEqual({ levels: ['medium'] })

    // NEGATIVE — everything the one `sessionCommand` string cannot carry is off,
    // rather than drawn and silently dropped.
    expect(narrowed?.attachments).toEqual({ files: false, images: 'no', folders: false })
    expect(narrowed?.mentions).toEqual({ files: false, skills: false, sources: false })
    expect(narrowed?.slash).toEqual({ commandIds: [] })
    expect(narrowed?.contextMeter).toBe(false)
    // Both of these act on the REAL session, which this panel is not.
    expect(narrowed?.permissions.locked).toBe(true)
    expect(narrowed?.connection.switchable).toBe(false)
    // …and the runtime it names is still the runtime, so nothing downstream has
    // to guess which one answered.
    expect(narrowed?.connection.activeRuntime).toBe('anthropic')
  })

  it('UB14.34 — the runtime\'s background shell does not reach the panel (its ask has no tools)', () => {
    const withShell: ComposerCapabilities = { ...RUNTIME_CAPABILITIES, backgroundShell: true }
    // Control: the session's own capabilities DO carry it, so the absence below is the narrowing's.
    expect(withShell.backgroundShell).toBe(true)
    const narrowed = sideQuestionComposerCapabilities(withShell)
    expect(narrowed && 'backgroundShell' in narrowed).toBe(false)
    // …and the rest still passes through.
    expect(narrowed?.submit).toEqual({ queue: true, steer: false })
  })

  it('BOUNDARY: no capabilities in, no capabilities out', () => {
    // An older server that reported nothing must leave the composer on its own
    // conservative default (`DEFAULT_COMPOSER_CAPABILITIES`), never on one this
    // function invented.
    expect(sideQuestionComposerCapabilities(undefined)).toBeUndefined()
  })

  it('the panel grows with content, and both sizes are viewport fractions', () => {
    const empty = sideQuestionPanelHeight(false)
    const answered = sideQuestionPanelHeight(true)
    expect(empty).not.toBe(answered)
    for (const size of [empty, answered, SIDE_QUESTION_PANEL_WIDTH]) {
      expect(size).toContain('min(')
      expect(size).toMatch(/\d+v[hw]/)
    }
    // NEGATIVE, and it is the measurement the bug was: the fixed 440 px box the
    // owner photographed is gone from every one of them.
    for (const size of [empty, answered, SIDE_QUESTION_PANEL_WIDTH]) {
      expect(size).not.toContain('440')
    }
  })

  it('the synthetic session id is recognisable, so the panel cannot nest in itself', () => {
    const id = sideQuestionSessionId('abc-123')
    expect(id).toBe(`${SIDE_QUESTION_SESSION_PREFIX}abc-123`)
    expect(isSideQuestionSessionId(id)).toBe(true)
    // NEGATIVE: a real session id, and the two absences the predicate must
    // survive — an undefined id (no session yet) and a name that merely
    // CONTAINS the prefix somewhere other than the start.
    expect(isSideQuestionSessionId('abc-123')).toBe(false)
    expect(isSideQuestionSessionId(undefined)).toBe(false)
    expect(isSideQuestionSessionId(`real-${SIDE_QUESTION_SESSION_PREFIX}abc`)).toBe(false)
  })
})

describe('the /btw panel mounts the composer and submits into the side session', () => {
  const overlay = stripped('../SideQuestionOverlay.tsx')
  const display = stripped('../ChatDisplay.tsx')
  const composer = stripped('../input/FreeFormInput.tsx')

  it('POSITIVE: the panel embeds the same compact ChatDisplay, input included', () => {
    // The mount itself, and the send wired to the ask — not to a no-op, which is
    // what it was ( `onSendMessage={() => {}}` ) while the composer was hidden.
    expect(overlay).toContain('<ChatDisplay')
    expect(overlay).toContain('onSendMessage={onAsk}')
    expect(overlay).toContain('compactMode')
    expect(overlay).not.toContain('onSendMessage={() => {}}')
    // The capabilities reach the embedded chat through the narrowing above.
    expect(overlay).toContain('composerCapabilities: sideQuestionComposerCapabilities(composerCapabilities)')
    // And the box is the fraction, never the literal.
    expect(overlay).toContain('width: SIDE_QUESTION_PANEL_WIDTH')
    expect(overlay).toContain('height: sideQuestionPanelHeight(hasExchange)')
  })

  it('POSITIVE: the submit reaches the ONE producer, which is the side-question command', () => {
    // `onAsk` is `askSideQuestion`, and `askSideQuestion` rides the
    // SessionCommand union — never `sendMessage`, so a side question still
    // cannot become a transcript entry or a model turn.
    expect(composer).toContain('onAsk={askSideQuestion}')
    expect(composer).toContain("{ type: 'sideQuestion', question: trimmed }")
    expect(composer).toContain('composerCapabilities={composerCapabilities}')
  })

  it('NEGATIVE: nothing can hide the composer any more, and the panel cannot nest', () => {
    // The flipped posture. `hideInput` was a prop on `ChatDisplay` with exactly
    // one caller — this panel — so the prop is gone rather than left as a
    // supported way to ship a chat with no input.
    expect(display).not.toContain('hideInput')
    expect(overlay).not.toContain('hideInput')
    // The panel's composer is itself a `FreeFormInput`, and `FreeFormInput`
    // mounts the panel: without this guard the panel would nest one level deep.
    expect(composer).toContain('!isSideQuestionSessionId(sessionId) && (')
  })

  it('NEGATIVE: typing is never eaten, and the panel never draws a Stop it cannot honour', () => {
    // `:378` binds Space and Enter to dismiss. With a composer in the box that
    // would close the panel on the first word, so the handler returns BEFORE it
    // reads the key whenever the event came from somewhere the user is typing.
    const handler = overlay.slice(overlay.indexOf('const handleKeyDown'))
    const guard = handler.indexOf("target?.closest('input, textarea, [contenteditable=\"true\"]')")
    const read = handler.indexOf('sideQuestionOverlayKeyAction(event.key)')
    expect(guard).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(guard)
    // …and the panel opens with the composer focused, which is why the ordinary
    // path never reaches those keys at all. It is focused through the SHARED
    // selector, not a hand-written one: the composer's editable element is a
    // `contentEditable` div and a `'textarea'` query finds nothing under it, so a
    // second spelling here is a live way back to the bug.
    expect(overlay).toContain('querySelector<HTMLElement>(SIDE_QUESTION_COMPOSER_SELECTOR)')
    expect(SIDE_QUESTION_COMPOSER_SELECTOR).toContain('[contenteditable="true"]')
    // …and the key guard accepts everything the focus selector can return, so
    // whatever gets focused is also a target the guard declines to act on.
    for (const shape of SIDE_QUESTION_COMPOSER_SELECTOR.split(', ')) {
      expect('input, textarea, [contenteditable="true"]').toContain(shape)
    }
    // A Stop in the panel would cancel a session id no server knows. D1.375
    // answered that by never letting the synthetic session process; F1.179
    // answers it on the far side instead — `resolveSubmitControl` never offers
    // `stop` for a renderer-minted id — so the session reports its pending answer
    // (`side-question-in-flight.test.ts` carries the whole of that row).
    expect(overlay).toContain('isProcessing: pending,')
    expect(overlay).toContain('disableSend={pending}')
  })
})

/**
 * D1.384 — A `/btw` TYPED INSIDE THE PANEL IS AN ORDINARY QUESTION.
 *
 * The panel's composer is a `FreeFormInput` like every other, so
 * `typedOutOfBandCommandSubmission` intercepts a typed `/btw <q>` there too —
 * and the interception then acts on the SYNTHETIC session id: it appends to a
 * ring nobody reads, calls `sessionCommand` with an id no server knows, and
 * opens an overlay that is not mounted (D1.375's mount guard, which is what
 * keeps the whole thing SILENT rather than visibly broken). Measured by WI-bj
 * and proposed as P-WI-bj-3.
 *
 * THE POSTURE, decided here: inside the panel there is nothing left to nest
 * into — the panel already IS the side question — so a typed out-of-band
 * command is ordinary text, with the single exception that a `/btw ` prefix is
 * stripped, because the user plainly means to ask what follows it and a
 * question that begins with the command that opened the panel is noise. Nothing
 * is swallowed: every one of these submits, and the submit is the panel's own
 * `onAsk`, which is the REAL session's `askSideQuestion`.
 */
describe('a typed out-of-band command INSIDE the /btw panel (D1.384)', () => {
  const composer = stripped('../input/FreeFormInput.tsx')

  it('POSITIVE: `/btw hello` typed in the panel is the question "hello"', () => {
    // Driven through the REAL classifier the composer uses, not a hand-built
    // literal, so this cannot pass against a shape `handleSubmit` never sees.
    const typed = '/btw hello'
    expect(nestedSideQuestionText(typedOutOfBandCommandSubmission(typed), typed)).toBe('hello')
  })

  it('the other typed forms travel as the ordinary text they are', () => {
    // `/recap` and `/heapdump` act on the REAL session and cannot reach it from
    // here either, so they are not commands in this composer — they are text.
    // Nothing is eaten: each one is asked, visibly, rather than doing nothing.
    for (const typed of ['/recap', '/heapdump', '/btw']) {
      expect(nestedSideQuestionText(typedOutOfBandCommandSubmission(typed), typed)).toBe(typed)
    }
    // BOUNDARY: ordinary prose is not a command at all, and comes back whole.
    expect(nestedSideQuestionText(null, 'what is a git rebase')).toBe('what is a git rebase')
    // …and a `/btw` whose question is only whitespace has nothing to unwrap.
    expect(nestedSideQuestionText(typedOutOfBandCommandSubmission('/btw   '), '/btw')).toBe('/btw')
  })

  it('POSITIVE: the panel branch submits, so the text reaches the REAL session', () => {
    // `onSubmit` in the panel is `ChatDisplay.onSendMessage`, which is the
    // panel's `onAsk` — `FreeFormInput.askSideQuestion` on the REAL session id.
    // So the one producer still owns the ask; this branch only stops the panel
    // asking a question of itself.
    expect(composer).toContain('onSubmit(nestedSideQuestionText(outOfBandCommand, trimmedInput))')
  })

  it('NEGATIVE: the panel never reaches the routes that act on a session id no server knows', () => {
    // The ordering IS the defect: before this row the block went straight to
    // `askSideQuestion`/`openSideQuestionOverlay` with the synthetic id. The
    // guard must therefore be read BEFORE them, inside the same block — and
    // both anchors are below the block's start, so a runaway region cannot make
    // this pass by accident (AGENTS.md §Traps).
    const block = composer.slice(composer.indexOf('const outOfBandCommand = typedOutOfBandCommandSubmission'))
    const guard = block.indexOf('isSideQuestionSessionId(sessionId)')
    const ask = block.indexOf('askSideQuestion(outOfBandCommand.question)')
    const reopen = block.indexOf('openSideQuestionOverlay()')
    expect(guard).toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(guard)
    expect(reopen).toBeGreaterThan(guard)
  })
})

/**
 * D1.382 — THE PANEL'S EMPTY STATE IS ITS OWN SENTENCE.
 *
 * `ChatDisplay.emptyStateLabel` was declared, destructured and read by NOTHING:
 * both production callers passed one and the compact empty state rendered
 * `editPopover.whatToChange` / `editPopover.justDescribe` regardless. So the
 * `/btw` panel greeted the user with "What would you like to change?" — copy
 * written for an edit popover, in a surface that is not one, and the first thing
 * the owner's screenshot of D1.375 shows. Measured by WI-bj as P-WI-bj-1 and
 * held back there because the copy is a product call.
 *
 * THE CALL, taken here: the prop is READ, and a caller that names its own empty
 * state owns the WHOLE of it — heading instead of `whatToChange`, and no
 * `justDescribe` hint underneath, because that sentence is the edit popover's
 * own voice ("I'll handle the rest" promises an edit) and not a frame for every
 * compact chat. `EditPopover` keeps exactly the wording it ships today by
 * passing nothing: what it used to pass was a RESOURCE LABEL ("Permission
 * Settings"), which is not an empty-state sentence and is why reading the prop
 * as the heading had to start by removing that argument.
 */
describe('the /btw panel says what IT is about when empty (D1.382)', () => {
  const display = stripped('../ChatDisplay.tsx')
  // UB14.14 — the compact empty state is v0.15.1's `CompactEmptyState`, which carries the label rule.
  const states = stripped('../chat-display/TranscriptStates.tsx')
  const overlay = stripped('../SideQuestionOverlay.tsx')
  const editPopover = stripped('../../ui/EditPopover.tsx')

  it('POSITIVE: the prop is read as the empty-state heading', () => {
    // The defect was that no expression anywhere read the value. ChatDisplay
    // hands it to the compact empty state…
    expect(display).toContain('<CompactEmptyState label={emptyStateLabel} />')
    // …whose fallback keeps every caller that names nothing on the shipped default…
    expect(states).toContain('{label || t("editPopover.whatToChange")}')
    // …and whose hint line is the default's, so a caller's own sentence is not
    // followed by the edit popover's promise to handle the rest.
    expect(states).toContain('{!label && (')
  })

  it('POSITIVE: the panel passes a side-question sentence, in both locales', () => {
    expect(overlay).toContain("emptyStateLabel={t('chat.sideQuestion.emptyState')}")
    const key = 'chat.sideQuestion.emptyState'
    const english = (en as Record<string, string>)[key]
    const russian = (ru as Record<string, string>)[key]
    expect(english).toBeString()
    expect(russian).toBeString()
    expect(english?.length).toBeGreaterThan(0)
    expect(russian?.length).toBeGreaterThan(0)
    // NEGATIVE, and it is the defect in one line: the panel's sentence is not
    // the edit popover's, in either locale.
    expect(english).not.toBe((en as Record<string, string>)['editPopover.whatToChange'])
    expect(russian).not.toBe((ru as Record<string, string>)['editPopover.whatToChange'])
  })

  it("NEGATIVE: EditPopover's own wording is untouched — it passes no label at all", () => {
    // Its old argument was `displayLabel || managedResource?.label ||
    // context?.label` — a resource name, never a sentence. Rendering THAT as the
    // heading is what reading the prop would otherwise have shipped, so the
    // argument is gone and the popover falls to the default two lines it has
    // today. `displayLabel` still feeds `buildEditPrompt`, which is its job.
    expect(editPopover).not.toContain('emptyStateLabel=')
    expect(editPopover).toContain('buildEditPrompt(context, message, displayLabel)')
  })
})

/**
 * D1.392 — THE PANEL WEARS THE AGENT-DRIVEN ADD POPOVER'S SHELL.
 *
 * The owner met the shipped panel on 2026-09-19 beside the popover the Sources
 * page's "+" opens and ruled they must be ONE card. What D1.375/D1.382 shipped
 * was a wide 560 px box with its own title header ("Side question" / "Close
 * (Esc)"), a four-hint footer, and — the reason this is a bug and not a taste —
 * a composer whose placeholder read "Press B to toggle the sidebar": the MAIN
 * composer's rotating tip, leaked into a panel that has no sidebar to toggle,
 * because no `placeholder` was ever passed to the embedded chat.
 *
 * The placeholder pin below is the failing arm, and it is one read: the mount
 * carried no `placeholder` prop at all.
 */
describe('the /btw panel wears the add popover shell (D1.392)', () => {
  const overlay = stripped('../SideQuestionOverlay.tsx')
  const editPopover = stripped('../../ui/EditPopover.tsx')

  it('POSITIVE: the panel names its OWN rotating placeholder, in both locales', () => {
    // The defect: `EditPopover` passes `placeholder={placeholder}` to the same
    // compact chat and the panel passed nothing, so `ChatInputZone` fell through
    // to the main composer's rotating tips — a sidebar shortcut, in a popover.
    expect(overlay).toContain('placeholder={SIDE_QUESTION_PLACEHOLDER_KEYS.map(key => t(key))}')
    expect(SIDE_QUESTION_PLACEHOLDER_KEYS).toHaveLength(3)
    for (const key of SIDE_QUESTION_PLACEHOLDER_KEYS) {
      const english = (en as Record<string, string>)[key]
      const russian = (ru as Record<string, string>)[key]
      expect(english).toBeString()
      expect(russian).toBeString()
      expect(english?.length).toBeGreaterThan(0)
      expect(russian?.length).toBeGreaterThan(0)
      // NEGATIVE: not the edit popover's own three, which ask what to CHANGE.
      expect(english).not.toBe((en as Record<string, string>)['editPopover.placeholder2'])
    }
  })

  it('POSITIVE: both cards render through the ONE shared frame', () => {
    // `SideQuestionOverlay` must NOT mount `EditPopover` itself — that component
    // mints hidden sessions and builds edit prompts, where a side question rides
    // `sessionCommand({ type: 'sideQuestion' })`. The SHELL is what is shared.
    expect(overlay).toContain('<CompactChatCard')
    expect(editPopover).toContain('<CompactChatCard')
    expect(overlay).not.toContain('<EditPopover')
    // The card's classes live in the frame now, in neither caller.
    expect(overlay).not.toContain('shadow-modal-small')
    expect(editPopover).not.toContain('shadow-modal-small')
  })

  it('POSITIVE: the panel is sized from EditPopover\'s OWN default width', () => {
    // Read, not guessed: the Sources "+" call site passes no `width`, so the
    // reference card is the prop default. A change there goes red here.
    expect(editPopover).toContain('width = 400')
    expect(SIDE_QUESTION_PANEL_WIDTH).toContain('400px')
    // Height stays a viewport fraction so the answer's scroll area keeps a
    // definite height, capped at the reference card's own 480.
    expect(sideQuestionPanelHeight(false)).toContain('480px')
  })

  it('NEGATIVE: no title header and no hint footer in the empty state', () => {
    // Screenshot 2 is a card with grip dots and nothing else above the content.
    // GUARD THE CALL SITE, NOT THE KEY (AGENTS.md: a bare-identifier guard fails
    // on the very commit that removes the name). The title survives as the
    // card's accessible name, so the key is still spelled once — what must be
    // gone is the header ROW that drew it and the close hint beside it.
    expect(overlay).not.toContain('text-[13px] font-medium text-foreground')
    expect(overlay).not.toContain("t('common.closeEsc')")
    expect(overlay.split("t('chat.sideQuestion.title')").length - 1).toBe(1)
    // The one hint line exists, and it is gated on the thread having anything
    // in it. D1.399 re-gated this from `earlier.length` (the dimmed
    // earlier-answers list, which is gone) and dropped the step hint with the
    // `←`/`→` keys it described — that key is deleted from both locales, so a
    // reader reappearing here would be a key with no sentence.
    expect(overlay).toContain('{ring.exchanges.length > 0 && (')
    expect(overlay).not.toContain('sideQuestion.stepHint')
    expect(overlay).toContain("t('chat.sideQuestion.copyHint')")
    // Every hint key keeps a reader, so none of them falls out of the locales.
    expect(overlay).toContain("t('chat.sideQuestion.dismissHint')")
    // The title survives as the card's accessible name: a dialog with no visible
    // title still needs one, and Radix does not invent it.
    expect(overlay).toContain("ariaLabel={t('chat.sideQuestion.title')}")
  })

  it('POSITIVE: the in-flight state lives in the card body, under the question', () => {
    // It used to be the right half of the header. The header is gone, so D1.392
    // moved it into the message list as a forked "thinking" word; F1.179 then
    // replaced the word with the compact chat's own `ProcessingIndicator`, drawn
    // because the synthetic session reports `isProcessing` while it waits. The
    // thread's shape is DRIVEN in `side-question-ring.test.ts` and the flip in
    // `side-question-in-flight.test.ts`; what is pinned here is the panel's half
    // — it delegates the thread and no longer supplies a word for it.
    expect(overlay).toContain('sideQuestionThreadMessages(')
    expect(overlay).not.toContain("thinking: t('chat.processing.thinking')")
  })

  it('NEGATIVE: the key bindings and the ask path are untouched', () => {
    // The row reshapes the SHELL. The ring, the synthetic session and `onAsk`
    // stay exactly as D1.375/D1.384 left them.
    expect(overlay).toContain('sideQuestionOverlayKeyAction(event.key)')
    expect(overlay).toContain('onSendMessage={onAsk}')
    expect(overlay).toContain('sideQuestionComposerCapabilities(composerCapabilities)')
    expect(overlay).toContain('disableSend={pending}')
  })
})
