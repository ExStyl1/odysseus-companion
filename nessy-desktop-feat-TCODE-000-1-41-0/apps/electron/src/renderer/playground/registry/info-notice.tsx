/**
 * Playground registry for the TRANSCRIPT INFO NOTICE — P6.712.
 *
 * The `info` row is the transcript's general-purpose notice line, and since
 * P3.158 it is also where every host-answered seam command lands: `/help`,
 * `/config`, `/mcp` and `/diff` all arrive as an `info` message. Those answers
 * are lists, and the row used to collapse every newline in them, so the state
 * worth reviewing is the one nobody could see before: what a multi-line answer
 * looks like beside a single-line notice, at each of the four levels.
 *
 * UB14.14 — the preview renders the REAL row: v0.15.1 extracted the message
 * renderer into `chat-display/MessageBubble.tsx`, so the notice is an exported
 * component now and this screen mounts it with an `info` message instead of
 * mirroring its markup. A change to the row or to `infoNoticeLayout` moves this
 * screen with it by construction.
 */

import * as React from 'react'
import { MessageBubble } from '@/components/app-shell/chat-display/MessageBubble'
import type { Message } from '../../../shared/types'
import type { ComponentEntry } from './types'

/** A real `/mcp` inventory shape — the answer that motivated the row. */
const MCP_ANSWER = [
  'MCP servers for this session',
  '',
  '  github — connected, 14 tools',
  '  postgres — connected, 6 tools',
  '  figma — needs sign-in',
  '  internal-docs — failed to start',
].join('\n')

/** A three-line `/help` extract. */
const HELP_ANSWER = [
  '/help — this list',
  '/mcp — the MCP servers this session can reach',
  '/diff — what is uncommitted in the working tree',
].join('\n')

type NoticeLevel = NonNullable<Message['infoLevel']>

interface NoticeKnobs {
  content: string
  level: NoticeLevel
  withNeighbours: boolean
}

const noop = () => {}

function InfoNoticeRow({ content, level }: { content: string; level: NoticeLevel }) {
  const message: Message = { id: `playground-info-${level}`, role: 'info', content, timestamp: 0, infoLevel: level }
  return <MessageBubble message={message} onOpenFile={noop} onOpenUrl={noop} />
}

function InfoNoticePreview({ content, level, withNeighbours }: NoticeKnobs) {
  return (
    <div className="w-[560px] space-y-1">
      {withNeighbours && <InfoNoticeRow content="Conversation compacted." level="info" />}
      <InfoNoticeRow content={content} level={level} />
      {withNeighbours && <InfoNoticeRow content="Plan approved." level="success" />}
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'content',
    description: 'The notice text. A newline in it is what makes the row a list rather than a sentence.',
    control: { type: 'textarea', rows: 6 },
    defaultValue: HELP_ANSWER,
  },
  {
    name: 'level',
    description: 'infoLevel — picks the icon and the tone; it does not affect the layout rule',
    control: {
      type: 'select',
      options: [
        { label: 'info', value: 'info' },
        { label: 'warning', value: 'warning' },
        { label: 'error', value: 'error' },
        { label: 'success', value: 'success' },
      ],
    },
    defaultValue: 'info',
  },
  {
    name: 'withNeighbours',
    description: 'Mount an ordinary one-line notice above and below — the control that must not move',
    control: { type: 'boolean' },
    defaultValue: true,
  },
]

export const infoNoticeComponents: ComponentEntry[] = [
  {
    id: 'chat-info-notice',
    name: 'Transcript Info Notice',
    category: 'Chat Messages',
    description:
      'The transcript notice line, and the surface every host-answered seam command reaches (P6.712). A multi-line answer keeps its lines and top-aligns against the icon; a one-line notice stays centred, unchanged.',
    component: InfoNoticePreview,
    layout: 'top',
    props: KNOBS,
    variants: [
      {
        name: 'A multi-line /help',
        description: 'Three lines, rendered as three lines — before P6.712 this arrived as one paragraph',
        props: { content: HELP_ANSWER, level: 'info', withNeighbours: true },
      },
      {
        name: 'A /mcp inventory',
        description: 'Indentation and a blank line survive too, which is what pre-wrap buys over a br-split',
        props: { content: MCP_ANSWER, level: 'info', withNeighbours: false },
      },
      {
        name: 'One line (the control)',
        description: 'The overwhelming majority of info rows: centred against the icon, no wrap class, untouched',
        props: { content: 'Conversation compacted.', level: 'info', withNeighbours: false },
      },
      {
        name: 'A long line that merely wraps',
        description: 'No newline, so it is a sentence: it keeps centring even though the viewport breaks it',
        props: {
          content:
            'The working directory moved to a path outside the workspace root, so the session kept its previous project selection until you confirm the change.',
          level: 'warning',
          withNeighbours: false,
        },
      },
      {
        name: 'Multi-line at the error level',
        description: 'The layout rule is independent of the level — the icon nudge holds for all four',
        props: {
          content: 'Two MCP servers failed to start\n\n  internal-docs — spawn ENOENT\n  figma — auth expired',
          level: 'error',
          withNeighbours: false,
        },
      },
    ],
  },
]
