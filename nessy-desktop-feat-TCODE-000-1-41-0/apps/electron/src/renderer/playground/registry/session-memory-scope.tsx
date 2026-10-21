/**
 * Playground registry for the PER-CHAT MEMORY SCOPE menu — P6.703.
 *
 * Every state that matters here is a state the app cannot be put into on demand:
 * the section is inside a session menu, its content depends on what the host has
 * recorded for that one chat, and one of its four states exists only while
 * another lane's session-record field is missing.
 *
 *  - **follows the app-wide setting** is what every chat starts in, and the one
 *    most easily confused with "off". Unset is not off; it is deference.
 *  - **one axis off** is the state that produces the residue line: codex's
 *    `ThreadMemoryMode` and claude's `CLAUDE_CODE_DISABLE_AUTO_MEMORY` are each
 *    ONE switch, so the runtime's own store goes off while the host still
 *    honours the axis the user kept. The sentence has to be readable in place.
 *  - **both off** is lossless — one enum can say exactly that — so the residue
 *    line must NOT appear, and that is the assertion worth being able to see.
 *  - **unavailable** is the read refusing. The section renders nothing at all;
 *    a switch that does nothing would be worse than an absent one.
 *
 * ## D1.215 — the runtime notices, on a SECOND knob
 *
 * A second knob rather than five more entries in the first one, because the two
 * axes are genuinely independent: any memory state can arrive on a claude
 * session or on a pi one, and the pair that matters most is a state whose memory
 * switches say one thing while the runtime's own notice says another. The
 * "none" value is every non-claude session and is the DEFAULT, so the entries
 * written before this row keep showing what they were written to show.
 */

import * as React from 'react'
import {
  SessionMemoryScopeMenuItems,
  type SessionMemoryScopeState,
} from '@/components/app-shell/session-memory-scope-menu'
import type { SessionRuntimeNoticeV1 } from '@nessy-agent/shared/protocol/session-runtime-notices'
import type { ComponentEntry } from './types'

type StateName = 'follows-global' | 'read-only' | 'write-only' | 'both-off' | 'unavailable'
type NoticesName = 'none' | 'claude' | 'claude-memory-off' | 'claude-forced-on' | 'claude-restricted'

/** The parent the runtime writes its per-project leaves under, as the host sends it. */
const PROJECTS_ROOT = '/Users/you/Library/Application Support/Nessy/workspaces/w-1/claude-config/projects'

const STANDING: SessionRuntimeNoticeV1[] = [
  { id: 'claude-search-results-filtered' },
  { id: 'claude-worktree-cwd-may-move' },
]

const NOTICES: Record<NoticesName, readonly SessionRuntimeNoticeV1[]> = {
  none: [],
  claude: [{ id: 'claude-auto-memory-runtime-default', path: PROJECTS_ROOT }, ...STANDING],
  'claude-memory-off': [{ id: 'claude-auto-memory-off-by-host', path: PROJECTS_ROOT }, ...STANDING],
  'claude-forced-on': [{ id: 'claude-auto-memory-forced-on', path: PROJECTS_ROOT }, ...STANDING],
  'claude-restricted': [
    { id: 'claude-auto-memory-runtime-default', path: PROJECTS_ROOT },
    { id: 'claude-restricted-mode' },
    ...STANDING,
  ],
}

const STATES: Record<Exclude<StateName, 'unavailable'>, SessionMemoryScopeState> = {
  'follows-global': { scope: { read: true, write: true }, override: {} },
  'read-only': { scope: { read: true, write: false }, override: { write: false } },
  'write-only': { scope: { read: false, write: true }, override: { read: false } },
  'both-off': { scope: { read: false, write: false }, override: { read: false, write: false } },
}

function ScopePreview({ state, notices = 'none' }: { state: StateName; notices?: NoticesName }) {
  const [current, setCurrent] = React.useState<SessionMemoryScopeState | null>(
    state === 'unavailable' ? null : STATES[state],
  )
  React.useEffect(() => {
    setCurrent(state === 'unavailable' ? null : STATES[state])
  }, [state])

  return (
    <div className="w-[420px] rounded border border-dashed border-border/60 p-2">
      <SessionMemoryScopeMenuItems
        sessionId="session-playground"
        workspaceId="workspace-playground"
        read={async () => {
          if (state === 'unavailable') throw new Error('Per-chat memory scope is not available on this server')
          return { ...(current ?? STATES[state]), notices: NOTICES[notices] }
        }}
        write={async override => {
          const next: SessionMemoryScopeState = {
            override,
            scope: { read: override.read ?? true, write: override.write ?? true },
            // The host recomputes the notices on the write too, which is why the
            // preview must: a memory notice that survived a switch unchanged
            // would be exactly the bug the wiring test pins.
            notices: NOTICES[notices],
          }
          setCurrent(next)
          return next
        }}
      />
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'state',
    description: 'What the host has recorded for this one chat — "unavailable" is the read refusing, which renders nothing',
    control: {
      type: 'select',
      options: [
        { label: 'Follows the app-wide setting', value: 'follows-global' },
        { label: 'Read only (write off)', value: 'read-only' },
        { label: 'Write only (read off)', value: 'write-only' },
        { label: 'Both off', value: 'both-off' },
        { label: 'Unavailable', value: 'unavailable' },
      ],
    },
    defaultValue: 'follows-global',
  },
  {
    name: 'notices',
    description: 'D1.215 — the runtime postures the host resolved for this session; "none" is every non-claude session',
    control: {
      type: 'select',
      options: [
        { label: 'None (pi / codex)', value: 'none' },
        { label: 'Claude, memory on', value: 'claude' },
        { label: 'Claude, memory off for this chat', value: 'claude-memory-off' },
        { label: 'Claude, memory forced on by the environment', value: 'claude-forced-on' },
        { label: 'Claude, restricted mode', value: 'claude-restricted' },
      ],
    },
    defaultValue: 'none',
  },
]

export const sessionMemoryScopeComponents: ComponentEntry[] = [
  {
    id: 'session-memory-scope',
    name: 'Per-Chat Memory Scope',
    category: 'Session List',
    description:
      'Two axes with three states each (P6.703): read, write, and unset — where unset FOLLOWS the app-wide switch rather than meaning off. The residue line appears only when the two axes disagree, because that is the only case a runtime with one switch cannot express.',
    component: ScopePreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'Follows the app-wide setting', description: 'Where every chat starts — and the state most easily read as "off"', props: { state: 'follows-global' } },
      { name: 'Write off, read kept', description: 'The lossy case: the runtime store goes off, the host still honours reading', props: { state: 'read-only' } },
      { name: 'Read off, write kept', description: 'The other lossy half, so the sentence is checked in both directions', props: { state: 'write-only' } },
      { name: 'Both off', description: 'Lossless — one enum says exactly this, so NO residue line may appear', props: { state: 'both-off' } },
      { name: 'Unavailable', description: 'The read refused: no section at all, rather than a switch that does nothing', props: { state: 'unavailable' } },
      { name: 'Claude runtime notes', description: 'D1.215 — where the runtime keeps its own notes, plus the postures that are not about memory', props: { state: 'follows-global', notices: 'claude' } },
      { name: 'Claude, memory off for this chat', description: 'The memory switches and the runtime notice have to agree, and this is where they are read together', props: { state: 'both-off', notices: 'claude-memory-off' } },
      { name: 'Claude, memory FORCED on', description: 'The state this app never writes: an administrator set it in the environment, and the chat cannot override it', props: { state: 'both-off', notices: 'claude-forced-on' } },
      { name: 'Claude, restricted mode', description: 'The longest notice in the set, so the wrapping is checked where it actually breaks', props: { state: 'follows-global', notices: 'claude-restricted' } },
    ],
  },
]
