/**
 * P2.425 — the rewind menu, and the `/rewind` that opens it.
 *
 * The gap this pins was never that the rewind ACTIONS were missing. They exist,
 * on a per-message right-click context menu. What was missing is both documented
 * ways IN — `checkpointing.md#rewind-and-summarize`: "Run `/rewind`, or press
 * `Esc` twice when the prompt input is empty, to open the rewind menu." — which
 * made our rewind a thing you find rather than a thing you open, and made the
 * difference invisible to anyone comparing feature lists.
 *
 * Two arms, because there is no React DOM harness in this tree: pure functions
 * exercised directly, the panel rendered to static markup, and a SOURCE READ for
 * the one claim neither can make — that `ChatDisplay` intercepts `/rewind`
 * before it can reach `onSendMessage` and become a model turn.
 */
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import { parseSessionCommand } from '@nessy-agent/shared/slash-commands/session-command'
import {
  REWIND_MENU_DOCUMENTED_ITEMS,
  RewindMenuPanel,
  collectRewindPrompts,
  formatRewindPromptTime,
  rewindComposerText,
  rewindMenuKeyAction,
  rewindOffersCodeRestore,
  rewindAnchorId,
  rewindCommandOpensMenu,
  rewindPromptPreview,
  rewindSummarizeCommand,
  type RewindCandidateMessage,
} from '../rewind-menu'
import { sideQuestionSessionId } from '../side-question-composer'
import { EDIT_POPOVER_STUB_SESSION_ID } from '../input/stub-session'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: enMessages } },
    interpolation: { escapeValue: false },
  })
})

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: testI18n }, node),
  )
}

const messages: RewindCandidateMessage[] = [
  { id: 'u1', role: 'user', content: 'first prompt', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: 'an answer', timestamp: 2 },
  { id: 'u2', role: 'user', content: 'second prompt', timestamp: 3 },
  { id: 'sys', role: 'system', content: 'a notice', timestamp: 4 },
  { id: 'u3', role: 'user', content: 'queued prompt', timestamp: 5, isQueued: true },
  { id: 'u4', role: 'user', content: 'pending prompt', timestamp: 6, isPending: true },
]

describe('collectRewindPrompts', () => {
  it('lists only the user prompts the server has accepted, oldest first', () => {
    // Chronological on purpose: the list sits under the transcript, and a
    // reversed one would make the reader re-map what they are looking at.
    expect(collectRewindPrompts(messages).map(p => p.id)).toEqual(['u1', 'u2'])
  })

  it('drops the rows a rewind cannot anchor on', () => {
    // `isPending` / `isQueued` mirror the per-message context menu's own gate.
    // A row for a message the server has not accepted is a row that fails on
    // click — worse than an absent one, because the user has already chosen it.
    const ids = collectRewindPrompts(messages).map(p => p.id)
    expect(ids).not.toContain('u3')
    expect(ids).not.toContain('u4')
    expect(ids).not.toContain('a1')
    expect(ids).not.toContain('sys')
  })

  /**
   * UB12.53 — UB2.14's source-activation auto-retry is a HIDDEN user row the
   * transcript never draws. Offered here, picking it anchored the rewind on a
   * row the user never saw and put `[<slug> activated]` in the composer.
   */
  it('does not offer a hidden user row, while the visible original before it stays offered', () => {
    const prompts = collectRewindPrompts([
      { id: 'orig', role: 'user', content: 'list my issues', timestamp: 1 },
      { id: 'act', role: 'assistant', content: 'activating linear', timestamp: 2 },
      { id: 'retry', role: 'user', content: 'list my issues\n\n[linear activated]', timestamp: 3, hidden: true },
      { id: 'ans', role: 'assistant', content: 'here they are', timestamp: 4 },
    ])
    expect(prompts.map(p => p.id)).toEqual(['orig'])
    expect(prompts.map(p => p.preview).join('\n')).not.toContain('activated')
  })

  it('still offers a user row whose hidden flag is explicitly false', () => {
    // The control: only a truthy `hidden` drops a row, as `groupMessagesByTurn`'s
    // `!m.hidden` does, so `hidden: false` renders and must stay rewindable.
    const prompts = collectRewindPrompts([
      { id: 'shown', role: 'user', content: 'a normal prompt', timestamp: 1, hidden: false },
    ])
    expect(prompts.map(p => p.id)).toEqual(['shown'])
  })

  it('skips a prompt with no text to show, and survives an empty session', () => {
    expect(collectRewindPrompts([{ id: 'blank', role: 'user', content: '   ' }])).toEqual([])
    expect(collectRewindPrompts([])).toEqual([])
  })

  /**
   * C3.384 — the pair R7 asked to pin, and it is the whole row.
   *
   * `RewindMenuPrompt.id` is documented as "the message id `rewindToMessage`
   * takes", and `rewindToMessage` looks it up in the SERVER's `managed.messages`.
   * The renderer's user rows carry the OPTIMISTIC id the composer minted, by the
   * reconciler's own deliberate choice, so the anchor has to be translated here
   * or the server answers `Message not found` — the string R7 measured on the
   * packaged 1.36.0 (C5.2 / RS-05).
   */
  it('anchors on the id the SERVER knows, not the one the bubble renders under', () => {
    const prompts = collectRewindPrompts([
      { id: 'optimistic-1', serverId: 'server-1', role: 'user', content: 'sent this session', timestamp: 1 },
      { id: 'server-2', role: 'user', content: 'loaded from the server', timestamp: 2 },
    ])
    expect(prompts.map(p => p.id)).toEqual(['server-1', 'server-2'])
  })

  /**
   * The negative arm, and the reason the translation is a FALLBACK rather than a
   * swap: a row the renderer never reconciled — every row of a reopened session
   * — carries no `serverId`, and its own id is already the canonical one. A
   * resolution that returned `serverId` unconditionally would blank those.
   */
  it('leaves a row with no serverId exactly as it is', () => {
    expect(rewindAnchorId({ id: 'only-one' })).toBe('only-one')
    expect(rewindAnchorId({ id: 'optimistic', serverId: 'canonical' })).toBe('canonical')
  })

  /**
   * The SECOND symptom of the same cause, pinned at its own site: the menu hides
   * "Rewind and restore files" unless the selected anchor is in the server's
   * `rewindTrackedChanges` answer, which is a list of SERVER ids. Before the
   * translation the comparison could never match, which is why R7 read the
   * action for no anchor at all.
   */
  it('offers the file-restoring action once the anchor is the SERVER id', () => {
    const [prompt] = collectRewindPrompts([
      { id: 'optimistic-1', serverId: 'server-1', role: 'user', content: 'edit the parser', timestamp: 1 },
    ])
    const trackedFromServer = ['server-1']
    expect(rewindOffersCodeRestore(prompt!.id, trackedFromServer)).toBe(true)
    // The control: the optimistic id is what the panel used to compare, and it
    // is absent from the server's answer — so the action was hidden.
    expect(rewindOffersCodeRestore('optimistic-1', trackedFromServer)).toBe(false)
  })
})

describe('rewindPromptPreview', () => {
  it('flattens a multi-line prompt instead of cutting at the first line', () => {
    // "Fix this:" as a whole row identifies nothing, and the row is the only
    // thing the user picks by.
    expect(rewindPromptPreview('Fix this:\n\n  the parser drops trailing args'))
      .toBe('Fix this: the parser drops trailing args')
  })

  it('truncates with an ellipsis and never exceeds the budget', () => {
    const preview = rewindPromptPreview('x'.repeat(400), 20)
    expect(preview.length).toBe(20)
    expect(preview.endsWith('…')).toBe(true)
    expect(rewindPromptPreview('short', 20)).toBe('short')
  })
})

describe('rewindMenuKeyAction', () => {
  it('clamps movement rather than wrapping', () => {
    // Wrapping from the newest prompt to the oldest is how a held arrow key
    // rewinds a session to its beginning.
    expect(rewindMenuKeyAction('ArrowUp', { index: 0, count: 3 })).toEqual({ type: 'move', index: 0 })
    expect(rewindMenuKeyAction('ArrowDown', { index: 2, count: 3 })).toEqual({ type: 'move', index: 2 })
    expect(rewindMenuKeyAction('ArrowUp', { index: 2, count: 3 })).toEqual({ type: 'move', index: 1 })
    expect(rewindMenuKeyAction('ArrowDown', { index: 0, count: 3 })).toEqual({ type: 'move', index: 1 })
    expect(rewindMenuKeyAction('Home', { index: 2, count: 3 })).toEqual({ type: 'move', index: 0 })
    expect(rewindMenuKeyAction('End', { index: 0, count: 3 })).toEqual({ type: 'move', index: 2 })
  })

  it('closes on Escape even with no prompts, and confirms on Enter', () => {
    expect(rewindMenuKeyAction('Escape', { index: 0, count: 0 })).toEqual({ type: 'close' })
    expect(rewindMenuKeyAction('Enter', { index: 1, count: 3 })).toEqual({ type: 'confirm' })
    // Nothing to move to or confirm on an empty list.
    expect(rewindMenuKeyAction('Enter', { index: 0, count: 0 })).toBeNull()
    expect(rewindMenuKeyAction('ArrowDown', { index: 0, count: 0 })).toBeNull()
    expect(rewindMenuKeyAction('a', { index: 0, count: 3 })).toBeNull()
  })
})

describe('formatRewindPromptTime', () => {
  it('renders nothing for a row with no usable timestamp', () => {
    expect(formatRewindPromptTime(undefined, 'en')).toBe('')
    expect(formatRewindPromptTime(Number.NaN, 'en')).toBe('')
  })

  it('does not blank a row because the locale tag is unusable', () => {
    expect(formatRewindPromptTime(Date.UTC(2026, 0, 1, 12, 30), 'not a locale')).not.toBe('')
  })
})

describe('RewindMenuPanel', () => {
  const prompts = collectRewindPrompts(messages)
  const noop = () => {}

  it('renders one row per prompt and both actions we actually have', () => {
    const html = render(
      <RewindMenuPanel
        prompts={prompts}
        selectedId="u2"
        onSelect={noop}
        onRewind={noop}
        onClose={noop}
        // D1.378 · the answer is what puts the file-restoring action on the
        // panel now; before that row an absent prop offered it too, which is
        // exactly the press this suite's `FAILS CLOSED` arm took away.
        trackedChangeIds={['u2']}
        locale="en"
      />,
    )
    expect(html).toContain('first prompt')
    expect(html).toContain('second prompt')
    expect(html).toContain(enMessages['messageMenu.rewindToHere'])
    expect(html).toContain(enMessages['messageMenu.rewindToHereRestoreFiles'])
    // The selected row is the one marked, not merely the one styled.
    expect(html).toContain('aria-selected="true"')
    // Not a per-runtime surface: the file-restoring action is offered on every
    // runtime because a session that ran on Pi and later switched still has
    // revertable checkpoints in its manifest. Hiding it would destroy something
    // that works (P6.56).
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  })

  it('says why it can do nothing mid-turn instead of failing silently', () => {
    const busy = render(
      <RewindMenuPanel
        prompts={prompts}
        selectedId="u2"
        onSelect={noop}
        onRewind={noop}
        onClose={noop}
        busy
        locale="en"
      />,
    )
    expect(busy).toContain(enMessages['chat.rewindMenu.busy'])
    expect(busy).toContain('disabled=""')

    const idle = render(
      <RewindMenuPanel
        prompts={prompts}
        selectedId="u2"
        onSelect={noop}
        onRewind={noop}
        onClose={noop}
        locale="en"
      />,
    )
    expect(idle).not.toContain(enMessages['chat.rewindMenu.busy'])
    expect(idle).not.toContain('disabled=""')
  })

  it('explains an empty session rather than rendering a bare frame', () => {
    const html = render(
      <RewindMenuPanel
        prompts={[]}
        selectedId={null}
        onSelect={noop}
        onRewind={noop}
        onClose={noop}
        locale="en"
      />,
    )
    expect(html).toContain(enMessages['chat.rewindMenu.empty'])
    expect(html).not.toContain('role="option"')
    // Both actions stay visible but inert — the menu explains, it does not hide.
    expect(html).toContain('disabled=""')
  })
})

describe('ChatDisplay wiring (source read)', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'ChatDisplay.tsx'), 'utf-8')

  it('intercepts `/rewind` at the composer seam, before onSendMessage', () => {
    const submitIndex = source.indexOf('const handleSubmit = (message: string')
    // D1.390 · the guard is now ONE predicate carrying both questions, so the
    // ordering this case used to assert between them cannot be got wrong; what
    // is left to pin is that it still sits between the seam and the send.
    const guardIndex = source.indexOf('rewindCommandOpensMenu(message, session?.id)')
    const sendIndex = source.indexOf('onSendMessage(normalizedMessage', submitIndex)
    expect(submitIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(submitIndex)
    // The whole point: the check sits ABOVE the send, so a `/rewind` never
    // becomes a model turn on any runtime.
    expect(guardIndex).toBeLessThan(sendIndex)
    // D1.390 · and there is no SECOND route into this file for the raw parse,
    // which would reach the menu without the renderer-minted-id question. The
    // CALL is guarded rather than the bare identifier (a comment explaining a
    // removal spells the name, and would fail this on the very commit that
    // makes it true), and the successor is asserted in the same case, so the
    // pair cannot be satisfied by deleting both.
    expect(source).not.toContain('parseRewindCommand(')
  })

  it('opens the menu on the newest prompt and routes both actions to the one rewind handler', () => {
    expect(source).toContain('handleOpenRewindMenu')
    expect(source).toContain("setOverlayState({ type: 'rewind'")
    // One implementation of the actions, two ways in. A second call path would
    // be a second place for the toast semantics to drift.
    expect(source).toContain('void handleRewindConversation(messageId, restoreFiles)')
  })
})

/**
 * D1.390 — a typed `/rewind` INSIDE a chat the renderer invented is ordinary
 * text.
 *
 * `SideQuestionOverlay` mounts a whole `ChatDisplay` over a session whose id is
 * `sideQuestionSessionId(realId)`, and `EditPopover`'s inline mode mounts the
 * same component over {@link EDIT_POPOVER_STUB_SESSION_ID} before its hidden
 * session exists. Both ids are ones the HOST has never heard of, so the rewind
 * menu opened over them addresses a session no server can look up — and the
 * one action it offers would be answered by a transcript the product only
 * invented.
 *
 * Driven here rather than through a mount, and that is a measurement and not a
 * convenience: `ChatDisplay.tsx` cannot be imported in a bare bun process (its
 * own sibling modules record why), so the honest instrument is to make the
 * decision an exported predicate and drive THAT, with the source read above
 * pinning that `handleSubmit` is the thing asking it.
 */
describe('D1.390 · the rewind guard and the sessions the renderer minted', () => {
  it('opens the menu for a real session and never for a minted one', () => {
    // The POSITIVE CONTROL first: the predicate can still say yes, so a false
    // below is a decision rather than a function that answers false for
    // everything.
    expect(rewindCommandOpensMenu('/rewind', 'session-the-host-minted')).toBe(true)
    // The `/btw` panel (D1.375) and the agent-driven install popover (D1.383),
    // by their own id spellings rather than by a literal copied here.
    expect(rewindCommandOpensMenu('/rewind', sideQuestionSessionId('session-the-host-minted'))).toBe(false)
    expect(rewindCommandOpensMenu('/rewind', EDIT_POPOVER_STUB_SESSION_ID)).toBe(false)
    // Prose stays prose on every surface — the whole-message rule the parser
    // already applies is not weakened by the new question.
    expect(rewindCommandOpensMenu('what does /rewind do?', 'session-the-host-minted')).toBe(false)
    expect(rewindCommandOpensMenu('what does /rewind do?', sideQuestionSessionId('s'))).toBe(false)
    // NO session is not a minted session, and this arm is deliberately
    // unchanged behaviour: `handleOpenRewindMenu` already returns early once it
    // finds no id to ask about, and narrowing this here would hide the menu on
    // a surface nobody measured.
    expect(rewindCommandOpensMenu('/rewind', undefined)).toBe(true)
  })

  it('reads the renderer-minted question from the module that owns it', () => {
    // The pair-diff this guard could drift against: `isRendererMintedSessionId`
    // is the one spelling of that fact, so the predicate must ask IT rather
    // than sniff a prefix of its own — a second spelling is free to drift the
    // day either id is renamed, which is the reason D1.383 built the module.
    const source = readFileSync(join(import.meta.dir, '..', 'rewind-menu.tsx'), 'utf-8')
    expect(source).toContain('isRendererMintedSessionId')
    expect(source).not.toContain(`'${EDIT_POPOVER_STUB_SESSION_ID}'`)
    expect(source).not.toContain('side-question:')
  })
})

/**
 * P6.56 · the page's rewind surface, item by item, with this build's verdict.
 *
 * The row said "four of the rewind menu's six documented actions exist on no
 * runtime". Both halves were wrong in opposite directions — three of six are
 * missing, and the page documents three FURTHER items nobody had counted — so
 * the record is a list rather than a count, and this pins it against the menu
 * it describes. A record that drifts from the panel is worse than no record.
 */
describe('P6.56 · the documented rewind surface', () => {
  it('gives every item a verdict and a measured note', () => {
    expect(REWIND_MENU_DOCUMENTED_ITEMS.length).toBeGreaterThan(0)
    for (const item of REWIND_MENU_DOCUMENTED_ITEMS) {
      expect(item.label.trim().length, item.label).toBeGreaterThan(0)
      // The note is the whole value of the record: a verdict with no
      // measurement behind it is the "candidate" this plan forbids.
      expect(item.note.trim().length, item.label).toBeGreaterThan(20)
    }
    expect(new Set(REWIND_MENU_DOCUMENTED_ITEMS.map(item => item.label)).size)
      .toBe(REWIND_MENU_DOCUMENTED_ITEMS.length)
  })

  it('marks the two restore actions, and the consequence P6.104 built, as offered', () => {
    const offered = REWIND_MENU_DOCUMENTED_ITEMS
      .filter(item => item.verdict === 'offered')
      .map(item => item.label)

    // Only the first two are BUTTONS, and the rest never will be: the others are
    // consequences of an action or a command typed into the composer, which is
    // why the verdict's own definition had to be widened rather than those items
    // left unbuilt. The panel-render row below still asserts exactly two action
    // buttons, so this widening cannot smuggle a third one in.
    //
    // The last entry joined this list in `786754cc2` (P6.106), which built the
    // `/resume` offer — `/clear` reads the runtime session anchor before the
    // reset that drops it and names the id in its own reply — and moved the
    // label off the unbuilt list below without moving it onto this one.
    expect(offered).toEqual([
      'Restore code and conversation',
      'Restore conversation',
      'Code restore options appear only when the checkpoint has tracked changes',
      'The selected prompt is restored into the input field afterwards',
      '`/resume <session-id> (previous session)` after a /clear',
    ])
  })

  it('agrees with what the panel actually renders', () => {
    // The join: two action buttons plus Cancel. A record claiming a third
    // action, or a panel that grew one, fails here rather than in prose.
    const markup = render(
      <RewindMenuPanel
        prompts={[{ id: 'm1', preview: 'first' }]}
        selectedId="m1"
        onSelect={() => {}}
        onRewind={() => {}}
        onClose={() => {}}
        // D1.378 · this case's subject is the VOCABULARY, so it renders the
        // panel in the state that offers the whole of it — which since that row
        // needs a definite answer naming this anchor. An absent answer now
        // withholds the file-restoring action, and asserting five buttons
        // without the prop would be asserting the pre-D1.378 default instead.
        trackedChangeIds={['m1']}
        locale="en"
      />,
    )
    const buttons = markup.match(/<button/g) ?? []
    // the close X + one prompt row + Cancel + the two restore actions
    expect(buttons).toHaveLength(5)
    // Neither summarize action can be rendered, so neither label may appear.
    expect(markup).not.toContain('Summarize')
  })

  /**
   * AMENDED by P6.280, and the amendment is the row: this case used to assert
   * that BOTH summarize items were impossible, which froze a verdict that had
   * stopped being the whole truth. No runtime gained anchored compaction — that
   * measurement is unchanged and is still asserted below — but the HOST has a
   * channel the row named, so one of the pair is now offered over it. The other
   * genuinely cannot be: `/compact [instructions]` can say where detail starts,
   * it cannot make a runtime discard what came after.
   */
  it('records the one item that remains impossible, and keeps the measurement behind it', () => {
    const impossible = REWIND_MENU_DOCUMENTED_ITEMS
      .filter(item => item.verdict === 'documented-and-impossible')
      .map(item => item.label)

    expect(impossible).toEqual(['Summarize up to here'])
    // The measurement that made the PAIR impossible is not softened by the one
    // that moved: it still has to be readable on the item that moved.
    expect(REWIND_MENU_DOCUMENTED_ITEMS.find(i => i.label === 'Summarize from here')?.note)
      .toContain('no compact or summarize control request')
  })

  it('has one item left unbuilt, and it is the one that is NOT host-side', () => {
    const unbuilt = REWIND_MENU_DOCUMENTED_ITEMS.filter(item => item.verdict === 'documented-and-unbuilt')
    // The title used to read "leaves the host-side items as the open work, none
    // of them runtime-blocked", and that stopped being true: P6.104 removed
    // "restored into the input field" from this list by building it, and
    // `786754cc2` (P6.106) removed `/resume <session-id>` the same way — it sits
    // in the offered list above now, because `/clear` reads the runtime session
    // anchor before the reset that drops it. Both were the host-side ones. What
    // is left is the opposite kind, so a title claiming otherwise would describe
    // an empty set.
    //
    // The list is asserted whole rather than by count, so the next row to close
    // this cannot satisfy the test by editing a number; it has to move the label
    // between the two lists, which is precisely what neither of those two
    // commits did — and this red is what that costs.
    expect(unbuilt.map(item => item.label)).toEqual([
      'Restore code',
    ])
    // Not vacuous: the reason it is still open is a runtime one, and it has to
    // stay readable on the item. `Query.rewindFiles` has zero call sites here
    // and codex refuses file reverts in its own generated contract.
    expect(unbuilt[0]?.note).toContain('claude-only')
    expect(unbuilt[0]?.note).toContain('rewindFiles')
  })

  it('F1.620 · quotes the codex contract that exists, read from the generated file', () => {
    // The note used to quote the `thread/rollback` params sentence that left
    // file reverts to the client, and that type was removed at
    // `rust-v0.156.1` (F1.590) — a quote with no source left in the tree. Its
    // replacement is `ThreadRevertParams`, so the paragraph is READ from that
    // file rather than copied into this test: the next codex bump that rewords
    // it turns this red instead of leaving a second dead quote behind.
    const generated = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..',
        'packages', 'codex-protocol', 'generated', 'v2', 'ThreadRevertParams.ts'),
      'utf-8',
    )
    const docblock = generated.slice(generated.indexOf('/**'), generated.indexOf('*/'))
    const paragraphs = docblock.split(/\n\s*\*\s*\n/)
      .map(paragraph => paragraph.replace(/^\s*\/?\*+\s?/gm, '').replace(/\s+/g, ' ').trim())
    const fileSentence = paragraphs.find(paragraph => /local file/.test(paragraph))
    expect(fileSentence).toBeDefined()

    const note = REWIND_MENU_DOCUMENTED_ITEMS.find(item => item.label === 'Restore code')?.note ?? ''
    expect(note).toContain('ThreadRevertParams')
    expect(note).toContain(fileSentence!)
    // The removed sentence, which no generated file carries any more. Joined
    // from two halves so the row's control — `git grep` for the sentence over
    // `apps` and `packages/shared` returning 0 — does not count this needle.
    const removedSentence = ['Clients are', 'responsible for reverting'].join(' ')
    expect(generated).not.toContain(removedSentence)
    expect(note).not.toContain(removedSentence)
  })

  // ---------------------------------------------------------------------------
  // P6.103 — the code-restore action is gated PER ANCHOR
  // ---------------------------------------------------------------------------

  describe('rewindOffersCodeRestore', () => {
    it('offers the action for an anchor the server says has tracked changes', () => {
      // The page: "The two code restore options appear only when the selected
      // checkpoint has tracked file changes to revert."
      expect(rewindOffersCodeRestore('u2', ['u1', 'u2'])).toBe(true)
    })

    it('withholds it for an anchor with none, which is the whole row', () => {
      // "If no file edits were captured after that point, the menu offers only
      // Restore conversation, the summarize options, and Never mind."
      expect(rewindOffersCodeRestore('u3', ['u1', 'u2'])).toBe(false)
      // …including when the server answered that NOTHING is revertable.
      expect(rewindOffersCodeRestore('u1', [])).toBe(false)
    })

    it('D1.378 · FAILS CLOSED while the server has not answered', () => {
      // The boundary that decides which way this row is dangerous, REVERSED by
      // measurement. SIT-6a drove RS-05 on the packaged 1.40.0 and read the
      // button on the FIRST open of a session and not on the second, on all
      // three runtimes: `handleOpenRewindMenu` clears the answer at every open,
      // so between the open and the answer the panel offered an action it
      // withheld a moment later, and a fast press pressed a button the product
      // would not have offered. The CONTROL in that run says the read is not
      // the fragile half: `rewindTrackedChanges` answered `success: true` on
      // every arm.
      //
      // The reason this function originally failed open — "hiding a working
      // button on a failed read is worse than showing an inert one" — is
      // refuted by a route that row never weighed: the per-message context
      // menu in `ChatDisplay.tsx` offers `messageMenu.rewindToHereRestoreFiles`
      // UNGATED, so a user whose read failed keeps the action. Withholding it
      // HERE removes a press that does nothing and removes no capability.
      expect(rewindOffersCodeRestore('u3', undefined)).toBe(false)
      expect(rewindOffersCodeRestore(null, undefined)).toBe(false)
      // CONTROLS, same function and same minute — a definite answer still
      // decides, both ways, so this is a changed UNKNOWN and not a dead gate.
      expect(rewindOffersCodeRestore('u3', ['u3'])).toBe(true)
      expect(rewindOffersCodeRestore('u3', [])).toBe(false)
      // A known answer with no selection still offers: `canAct` disables the
      // button in that state, and hiding it as well would make the panel
      // reflow while the user arrows through the list.
      expect(rewindOffersCodeRestore(null, ['u1'])).toBe(true)
    })

    it('reads the ANCHOR and never the runtime — the control the row names', () => {
      // A session that ran on Pi and later switched has real revertable
      // checkpoints, and a rewind reverts them whatever runtime is current. The
      // signature is the proof: there is no provider to pass, and the source
      // carries no provider term at all.
      const source = readFileSync(join(import.meta.dir, '..', 'rewind-menu.tsx'), 'utf-8')
      expect(source).not.toContain('AgentProvider')
      // Every mention of the word must be PROSE — a comment or a note string —
      // never a term this module computes on. Written as "which lines mention
      // it" rather than a bare `not.toContain`, because the notes have to be
      // allowed to say WHY the gate is not per runtime.
      const codeLines = source.split('\n')
        .filter(line => /\bprovider\b/i.test(line))
        .filter(line => !/^\s*(\*|\/\/)/.test(line))
        .filter(line => !/^\s*\+?\s*'/.test(line))
      expect(codeLines).toEqual([])
    })

    it('drops the file-restoring button from the rendered panel, and only that one', () => {
      // The join, on real markup: five buttons become four, and the survivor is
      // the conversation-only action rather than whichever one happened to be
      // removed.
      const withChanges = render(
        <RewindMenuPanel
          prompts={[{ id: 'm1', preview: 'first' }]}
          selectedId="m1"
          onSelect={() => {}}
          onRewind={() => {}}
          onClose={() => {}}
          trackedChangeIds={['m1']}
          locale="en"
        />,
      )
      const without = render(
        <RewindMenuPanel
          prompts={[{ id: 'm1', preview: 'first' }]}
          selectedId="m1"
          onSelect={() => {}}
          onRewind={() => {}}
          onClose={() => {}}
          trackedChangeIds={[]}
          locale="en"
        />,
      )
      // D1.378 · and the same markup for an answer that has NOT ARRIVED: the
      // panel the user meets in the first frames of every open is the
      // four-button one, not the five-button one.
      const pending = render(
        <RewindMenuPanel
          prompts={[{ id: 'm1', preview: 'first' }]}
          selectedId="m1"
          onSelect={() => {}}
          onRewind={() => {}}
          onClose={() => {}}
          locale="en"
        />,
      )
      expect((withChanges.match(/<button/g) ?? []).length).toBe(5)
      expect((without.match(/<button/g) ?? []).length).toBe(4)
      expect((pending.match(/<button/g) ?? []).length).toBe(4)
      expect(without).toContain(enMessages['messageMenu.rewindToHere'])
      expect(without).not.toContain(enMessages['messageMenu.rewindToHereRestoreFiles'])
      expect(pending).toContain(enMessages['messageMenu.rewindToHere'])
      expect(pending).not.toContain(enMessages['messageMenu.rewindToHereRestoreFiles'])
    })

    it('is asked for by ChatDisplay when the menu opens, and cleared first', () => {
      // The source read for the ordering the pure function cannot see: a stale
      // answer from a previous open must not gate this one.
      const source = readFileSync(join(import.meta.dir, '..', 'ChatDisplay.tsx'), 'utf-8')
      const clearAt = source.indexOf('setRewindTrackedIds(undefined)')
      const askAt = source.indexOf("type: 'rewindTrackedChanges'")
      expect(clearAt).toBeGreaterThan(0)
      expect(askAt).toBeGreaterThan(clearAt)
      expect(source).toContain('trackedChangeIds={rewindTrackedIds}')
    })
  })

  // ---------------------------------------------------------------------------
  // P6.104 — the prompt goes back into the composer
  // ---------------------------------------------------------------------------

  describe('rewindComposerText', () => {
    it('restores the selected prompt into an empty composer', () => {
      // The page's own sentence, as behaviour: "the original prompt from the
      // selected message is restored into the input field so you can re-send or
      // edit it."
      expect(rewindComposerText('', 'the original prompt')).toBe('the original prompt')
      expect(rewindComposerText(undefined, 'the original prompt')).toBe('the original prompt')
    })

    it('never destroys an unsent draft, because our menu can open over one', () => {
      // The negative, and the reason this is append rather than overwrite: the
      // page's flow guarantees an empty input (double-Esc with text clears it
      // into history INSTEAD of opening the menu) and ours does not. Same
      // convention `handleStop` uses for an interrupted prompt.
      expect(rewindComposerText('half a thought', 'the original prompt'))
        .toBe('half a thought\n\nthe original prompt')
    })

    it('leaves the composer alone when there is nothing to restore', () => {
      // The boundary: an empty or whitespace-only prompt must not write `''`
      // over a draft the user still has, and a missing message must not either.
      expect(rewindComposerText('half a thought', '   ')).toBeUndefined()
      expect(rewindComposerText('half a thought', undefined)).toBeUndefined()
      expect(rewindComposerText('', '')).toBeUndefined()
    })

    it('is applied by ChatDisplay on the rewind SUCCESS path, from the full content', () => {
      // The one claim the pure function cannot make, so it is a source read —
      // the arm this suite's header already uses for `/rewind` interception.
      // Two things are checked, and the second is the trap: the row's `preview`
      // is cut at REWIND_PREVIEW_MAX_CHARS, so the caller must read `content`.
      const source = readFileSync(
        join(import.meta.dir, '..', 'ChatDisplay.tsx'),
        'utf-8',
      )
      expect(source).toContain('const restoredComposer = rewindComposerText(inputValue, rewoundPrompt)')
      expect(source).toContain('if (restoredComposer !== undefined) onInputChange?.(restoredComposer)')
      // Read BEFORE the await: the transcript is truncated under this handler.
      const readAt = source.indexOf('const rewoundPrompt = session.messages.find')
      const callAt = source.indexOf("type: 'rewindToMessage'")
      expect(readAt).toBeGreaterThan(0)
      expect(callAt).toBeGreaterThan(readAt)
    })
  })
})

/**
 * P6.280 — the menu offers Summarize, and says what it actually does.
 *
 * The affordance is "strictly downstream of F2's missing summarize actions", and
 * no open row builds them — so this row carries the ANCHOR and the AFFORDANCE.
 * The anchor is not a new control request: at SDK 0.3.233 the complete
 * control-request enumeration is 36 named types with no compaction entry of any
 * kind, and codex's `thread/compact/start` takes a thread id and no anchor. What
 * exists is the host channel the row's own native-mechanism clause names —
 * `/compact [instructions]`, honoured on all three runtimes — so this is tier 2.
 */
describe('P6.280 · summarize from the rewind menu', () => {
  const prompts = collectRewindPrompts(messages)
  const noop = () => {}

  it('composes a /compact that NAMES the selected prompt', () => {
    const command = rewindSummarizeCommand('rewrite the auth middleware')

    expect(command.startsWith('/compact ')).toBe(true)
    expect(command).toContain('"rewrite the auth middleware"')
    // It must parse as the session command it claims to be, or it reaches the
    // model as prose — the exact defect `parseSessionCommand`'s own docblock
    // records for `^\/compact`.
    expect(parseSessionCommand(command)).toMatchObject({ kind: 'compact' })
  })

  it('puts the user\'s own instructions LAST, so they get the final word', () => {
    const command = rewindSummarizeCommand('rewrite the auth middleware', 'keep every file path')
    expect(command.endsWith('keep every file path')).toBe(true)
    expect(command.indexOf('rewrite the auth middleware')).toBeLessThan(command.indexOf('keep every file path'))
  })

  /** The row's own control: an empty instruction is the unguided summary. */
  it('CONTROL: empty instructions add nothing, and blank ones are the same as none', () => {
    const bare = rewindSummarizeCommand('a prompt')
    expect(rewindSummarizeCommand('a prompt', '')).toBe(bare)
    expect(rewindSummarizeCommand('a prompt', '   ')).toBe(bare)
  })

  it('degrades to a plain /compact when the anchor has no readable preview', () => {
    expect(rewindSummarizeCommand('')).toBe('/compact')
    expect(rewindSummarizeCommand('', 'keep the stack traces')).toBe('/compact keep the stack traces')
  })

  it('strips quotes and newlines from the anchor rather than escaping them', () => {
    const command = rewindSummarizeCommand('say "hello"\nthen stop')
    expect(command).toContain('"say hello then stop"')
    expect(parseSessionCommand(command)).toMatchObject({ kind: 'compact' })
  })

  it('renders the button, the instruction field and the sentence that says it guides rather than cuts', () => {
    const html = render(
      <RewindMenuPanel
        prompts={prompts}
        selectedId="u2"
        onSelect={noop}
        onRewind={noop}
        onSummarize={noop}
        onClose={noop}
        locale="en"
      />,
    )

    expect(html).toContain(enMessages['chat.rewindMenu.summarize'])
    expect(html).toContain(enMessages['chat.rewindMenu.summarizeInstructionsPlaceholder'])
    // The honesty half. Without it the button claims the documented action.
    expect(html).toContain(enMessages['chat.rewindMenu.summarizeNote'])
  })

  /**
   * The row's second control: "the two rewind actions that exist today are
   * unchanged". The prop is OPTIONAL, so a caller that has not wired the send
   * path gets exactly the panel it had — which is also what keeps the P6.56
   * five-button render case above meaningful rather than merely passing.
   */
  it('CONTROL: without the prop the panel is byte-identical to before', () => {
    // "The prop" is `onSummarize`. `trackedChangeIds` is passed because D1.378
    // made an ABSENT answer withhold the file-restoring action: without it this
    // control would be asserting the new default rather than the old panel.
    const before = render(
      <RewindMenuPanel prompts={prompts} selectedId="u2" onSelect={noop} onRewind={noop} onClose={noop} trackedChangeIds={['u2']} locale="en" />,
    )
    expect(before).not.toContain(enMessages['chat.rewindMenu.summarize'])
    expect(before).toContain(enMessages['messageMenu.rewindToHere'])
    expect(before).toContain(enMessages['messageMenu.rewindToHereRestoreFiles'])
  })

  it('is wired into ChatDisplay through the one send path it already owns', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'ChatDisplay.tsx'), 'utf-8')
    expect(source).toContain('onSummarize={(command) => {')
    expect(source).toContain('onSendMessage(command)')
  })

  it('records the item as offered-by-approximation, never as plainly offered', () => {
    const item = REWIND_MENU_DOCUMENTED_ITEMS.find(entry => entry.label === 'Summarize from here')
    expect(item?.verdict).toBe('offered-by-approximation')
    // Calling it `offered` would erase the measurement that no runtime has it.
    expect(item?.note).toContain('guided toward the anchor, not cut at it')
  })
})
