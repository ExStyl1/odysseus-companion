/**
 * D1.375 — the `/btw` side-question panel, on a screen a reviewer can open.
 *
 * The owner met this surface in use on 2026-09-18 and photographed the defect:
 * a small box whose whole body was the compact chat's empty state — "What would
 * you like to change?" / "Just describe it — I'll handle the rest" — with no
 * input anywhere in it. That state is the FIRST variant below, deliberately, so
 * the fix can be read the way the bug was: open the panel with nothing in it and
 * see the composer sitting under the invitation to type.
 *
 * The playground renders the shipped {@link SideQuestionPanel} itself, not a
 * mock of it — the panel was split out of `SideQuestionOverlay` for exactly this
 * reason, so the design surface and the app cannot drift. What the playground
 * supplies is the ring state (module-level renderer state, seeded per variant
 * below) and the callbacks.
 */

import * as React from 'react'
import type { ComponentEntry } from './types'
import { SideQuestionPanel } from '../../components/app-shell/SideQuestionOverlay'
import { ChatDisplay } from '../../components/app-shell/ChatDisplay'
import { CompactChatCard } from '../../components/ui/compact-chat-card'
import type { Session } from '../../../shared/types'
import {
  SIDE_QUESTION_PANEL_WIDTH,
  sideQuestionPanelHeight,
} from '../../components/app-shell/side-question-composer'
import {
  appendExchange,
  resolveExchange,
  updateSideQuestionRing,
} from '../../components/app-shell/side-question-ring'
import { FocusProvider } from '../../context/FocusContext'
import { EscapeInterruptProvider } from '../../context/EscapeInterruptContext'
import { AppShellProvider } from '../../context/AppShellContext'
import { ensureMockElectronAPI } from '../mock-utils'

ensureMockElectronAPI()

// ---------------------------------------------------------------------------
// Ring fixtures — one session id per state, seeded once at module scope so the
// first paint is already the state the variant is named after.
// ---------------------------------------------------------------------------

const EMPTY_SESSION = 'playground-btw-empty'
const PENDING_SESSION = 'playground-btw-pending'
const ANSWERED_SESSION = 'playground-btw-answered'
const THREAD_SESSION = 'playground-btw-thread'

const ANSWER = [
  'A `git rebase` rewrites the commits of your branch onto a new base, so the',
  'history reads as one line. `git merge` keeps both histories and records the',
  'join as a commit.',
  '',
  '- **rebase** — linear history, rewritten shas, never on a shared branch',
  '- **merge** — true history, a merge commit, safe on a shared branch',
].join('\n')

function seed(): void {
  updateSideQuestionRing(PENDING_SESSION, state => appendExchange(state, {
    id: 'pending-1',
    question: 'What is the difference between rebase and merge?',
    timestamp: Date.now(),
  }))

  updateSideQuestionRing(ANSWERED_SESSION, state => resolveExchange(
    appendExchange(state, {
      id: 'answered-1',
      question: 'What is the difference between rebase and merge?',
      timestamp: Date.now(),
    }),
    'answered-1',
    { text: ANSWER },
  ))

  // D1.399 — a THREAD of three, which is the state the owner photographed as a
  // dimmed stack scrolling at the top of the card. Every exchange is a pair of
  // messages now, so this variant reads like the main chat.
  const threadQuestions = [
    'What does `--frozen-lockfile` do?',
    'Is `bun test` parallel by default?',
    'What is the difference between rebase and merge?',
  ]
  threadQuestions.forEach((question, index) => {
    const id = `thread-${index}`
    updateSideQuestionRing(THREAD_SESSION, state => resolveExchange(
      appendExchange(state, { id, question, timestamp: Date.now() + index }),
      id,
      { text: index === threadQuestions.length - 1 ? ANSWER : 'Short answer.' },
    ))
  })
}

seed()

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Enough AppShell context for the compact ChatDisplay the panel embeds. */
const mockAppShellContext = {
  sessions: [],
  workspaces: [{ id: 'playground-workspace', name: 'Playground' }],
  activeWorkspaceId: 'playground-workspace',
  activeSessionId: null,
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  currentModel: 'fast',
  connectionDefaultModel: null,
  sessionOptions: new Map(),
  getDraft: () => '',
  onSelectSession: () => {},
  onSelectWorkspace: () => {},
  onOpenSettings: () => {},
  onOpenKeyboardShortcuts: () => {},
  onOpenStoredUserPreferences: () => {},
  onReset: () => {},
  onSessionOptionsChange: () => {},
  onInputChange: () => {},
  onOpenFile: () => {},
  onOpenUrl: () => {},
  onModelChange: () => {},
  onRefreshWorkspaces: () => {},
  onCreateSession: async (workspaceId: string) => ({
    id: 'mock-session',
    workspaceId,
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }),
  onSendMessage: () => {},
  onRenameSession: () => {},
  onFlagSession: () => {},
  onUnflagSession: () => {},
  onMarkSessionRead: () => {},
  onMarkSessionUnread: () => {},
  onSetActiveViewingSession: () => {},
  onSessionStatusChange: () => {},
  onDeleteSession: async () => true,
}

/**
 * D1.392 — the REFERENCE card, rendered from the same frame the popover uses.
 *
 * `EditPopover`'s inline mode is what the Sources page's "+" opens, and it is
 * the surface the owner pointed at. Driving the real component here would need
 * a trigger, a click and a hidden session, so the side-by-side variant renders
 * its CARD — {@link CompactChatCard} with the compact `ChatDisplay` inside it,
 * exactly as `EditPopover` composes it, at the width the "+" call site gets
 * (it passes no `width`, so the prop default 400 is the reference).
 */
const REFERENCE_SESSION: Session = {
  id: 'playground-add-source',
  workspaceId: 'playground-workspace',
  workspaceName: 'Playground',
  messages: [],
  isProcessing: false,
  lastMessageAt: Date.now(),
}

function AddPopoverReferenceCard() {
  return (
    <CompactChatCard transform="translate(0px, 0px)" onGripMouseDown={() => {}}>
      <ChatDisplay
        session={REFERENCE_SESSION}
        onSendMessage={() => {}}
        onOpenFile={() => {}}
        onOpenUrl={() => {}}
        currentModel="fast"
        onModelChange={() => {}}
        compactMode={true}
        // `editPopover.placeholder1..3`, the popover's own rotating tips.
        placeholder={['Just tell me what to change', 'Describe the update', 'What should I modify?']}
      />
    </CompactChatCard>
  )
}

interface SideQuestionPanelPreviewProps {
  /** Which seeded ring the panel reads. */
  state?: 'empty' | 'pending' | 'answered' | 'thread' | 'side-by-side'
}

const SESSION_BY_STATE: Record<string, string> = {
  empty: EMPTY_SESSION,
  pending: PENDING_SESSION,
  answered: ANSWERED_SESSION,
  thread: THREAD_SESSION,
}

/** `ChatDisplay`'s providers come from the entry frame (F1.281) — see `./playground-chat-providers`. */
function SideQuestionPanelPreview(props: SideQuestionPanelPreviewProps) {
  return <SideQuestionPanelPreviewBody {...props} />
}

function SideQuestionPanelPreviewBody({ state = 'empty' }: SideQuestionPanelPreviewProps) {
  const sessionId = SESSION_BY_STATE[state] ?? EMPTY_SESSION
  const hasExchange = state !== 'empty' && state !== 'side-by-side'
  const box = {
    width: SIDE_QUESTION_PANEL_WIDTH,
    height: sideQuestionPanelHeight(hasExchange),
  }

  if (state === 'side-by-side') {
    // The whole point of D1.392, in one screen: the add popover's card and the
    // side question's card, same width, same frame, same grip dots. If a
    // reviewer can tell which is which by its chrome, the row is not done.
    return (
      <AppShellProvider value={mockAppShellContext as never}>
        <FocusProvider>
          <EscapeInterruptProvider>
            <div className="flex flex-wrap items-start gap-6">
              <div className="space-y-2">
                <div className="text-[11px] text-foreground/40">Agent-driven add (the reference)</div>
                <div style={box}><AddPopoverReferenceCard /></div>
              </div>
              <div className="space-y-2">
                <div className="text-[11px] text-foreground/40">Side question (/btw)</div>
                <div style={box}>
                  <SideQuestionPanel
                    sessionId={EMPTY_SESSION}
                    onDismiss={() => {}}
                    onAsk={() => {}}
                    autoFocus={false}
                  />
                </div>
              </div>
            </div>
          </EscapeInterruptProvider>
        </FocusProvider>
      </AppShellProvider>
    )
  }

  return (
    <AppShellProvider value={mockAppShellContext as never}>
      <FocusProvider>
        <EscapeInterruptProvider>
          <div style={box}>
            <SideQuestionPanel
              sessionId={sessionId}
              onDismiss={() => console.log('[Playground] side question dismissed')}
              onAsk={question => console.log('[Playground] side question asked:', question)}
              // The panel is one of several on the page here; stealing focus on
              // mount would fight the playground's own controls.
              autoFocus={false}
            />
          </div>
        </EscapeInterruptProvider>
      </FocusProvider>
    </AppShellProvider>
  )
}

export const sideQuestionComponents: ComponentEntry[] = [
  {
    id: 'side-question-panel',
    name: 'Side Question Panel (/btw)',
    category: 'Chat',
    description:
      'The /btw panel. D1.392 — it now wears the agent-driven add popover\'s own card: grip dots, no title row, no footer, the reference 400x480, and its own rotating placeholder (it used to leak the main composer\'s "Press ⌘ + B to toggle the sidebar"). Compare them in the last variant. D1.399 — and it is a THREAD: every question and answer in order, newest at the bottom, where earlier questions used to pile up as a dimmed list at the top of the card.',
    component: SideQuestionPanelPreview,
    props: [
      {
        name: 'state',
        description: 'Which seeded exchange ring the panel reads',
        control: {
          type: 'select',
          options: [
            { label: 'Empty (the owner’s screenshot, fixed)', value: 'empty' },
            { label: 'Answer in flight', value: 'pending' },
            { label: 'Answered', value: 'answered' },
            { label: 'A thread of three', value: 'thread' },
            { label: 'Beside the add popover (one shell)', value: 'side-by-side' },
          ],
        },
        defaultValue: 'empty',
      },
    ],
    variants: [
      {
        name: 'Empty — the state the bug was photographed in',
        description:
          'Nothing asked yet: the composer under the panel\'s OWN empty-state sentence (D1.382 — it used to borrow the edit popover\'s "What would you like to change?" / "Just describe it — I\'ll handle the rest"), and no hint line at all, because every key it names needs a thread to act on.',
        props: { state: 'empty' },
      },
      {
        name: 'Answer in flight',
        description:
          'The question is on the wire. The main chat\'s own in-flight line — spinner, cycling status word, elapsed time — sits in the thread directly under its question (F1.179; it replaced a plain "Thinking…" bubble), and the composer folds to its toolbar with an inert spinner — the panel answers one question at a time and never draws a Stop it could not honour.',
        props: { state: 'pending' },
      },
      {
        name: 'Answered',
        description: 'Markdown answer rendered by the same compact ChatDisplay the chat uses, with the composer ready for the next question.',
        props: { state: 'answered' },
      },
      {
        name: 'A thread of three (D1.399)',
        description:
          'Three questions and their three answers, in order, newest at the bottom — the same compact ChatDisplay the main chat uses, with its own auto-scroll. This variant used to be "Earlier exchanges above": a dimmed, truncated list of the older questions stacked over the one current answer, with the arrow keys to step between them. The owner met that in use on 2026-09-19 and ruled the panel must behave like an ordinary chat, so the list, the stepping and its hint are gone and the hint line is three keys — c copies the latest answer, x clears the thread, Escape dismisses.',
        props: { state: 'thread' },
      },
      {
        name: 'Beside the add popover — one shell (D1.392)',
        description:
          'The card the Sources "+" opens, left; the /btw panel, right; same width (EditPopover\'s own default 400), same frame, same grip dots, no title row and no footer on either. The owner put these two side by side on 2026-09-19 and ruled they must be one component; CompactChatCard is that component, and EditPopover\'s rendered markup is pinned byte-for-byte so extracting it changed nothing on the reference.',
        props: { state: 'side-by-side' },
      },
    ],
    layout: 'top',
  },
]
