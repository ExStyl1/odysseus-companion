/**
 * Playground registry for the SAVED ACTIONS menu — P6.361.
 *
 * The states that decide whether this surface is right are all about ABSENCE,
 * which is why it needs a screen at all: in the app the menu renders nothing on
 * every install that has not declared an action, so a reviewer opening the chat
 * header sees the same thing whether the feature exists or not.
 *
 *  - **none** is the shipped default AND the state an operator's
 *    `disableSkillShellExecution` produces. The host answers `[]` for both and
 *    the component cannot tell them apart on purpose — a surface that could
 *    would be leaking the existence of a policy.
 *  - **refused** is the case worth looking at hardest. The command's output goes
 *    to the transcript when it RAN; when it did not — explore/plan mode, a
 *    denied approval, a permission rule — the only thing the user gets is this
 *    toast, so it has to name the action and carry the host's reason.
 *  - **a long name** is realistic: an action is named by a person, and the menu
 *    must not turn into a paragraph.
 *
 * `list` and `run` are injected here. In the app they are `window.electronAPI`
 * calls that resolve an id against the host store and run a shell command under
 * approval; a playground that could do that would be a playground that runs your
 * dev server.
 */

import * as React from 'react'
import { WorkspaceActionsMenu } from '@/components/app-shell/workspace-actions-menu'
import type { ComponentEntry } from './types'

const LONG_NAME = 'Run the full test suite with coverage and open the HTML report'

interface MenuKnobs {
  count: number
  longName: boolean
  outcome: 'ran' | 'refused'
}

function actionsFor(count: number, longName: boolean) {
  const names = ['Dev server', 'Run tests', 'Build', 'Typecheck', 'Lint']
  return Array.from({ length: Math.max(0, count) }, (_, index) => ({
    id: `action-${index + 1}`,
    name: longName && index === 0 ? LONG_NAME : (names[index % names.length] ?? `Action ${index + 1}`),
    command: 'echo "the playground never runs this"',
  }))
}

function MenuPreview({ count, longName, outcome }: MenuKnobs) {
  const actions = React.useMemo(() => actionsFor(count, longName), [count, longName])
  return (
    <div className="flex h-24 w-[520px] items-start justify-end gap-2 rounded border border-dashed border-border/60 p-3">
      <WorkspaceActionsMenu
        sessionId="session-playground"
        workspaceId="workspace-playground"
        list={async () => actions}
        run={async () => outcome === 'ran'
          ? { executed: true }
          : { executed: false, blocked: true, error: 'Direct shell commands are blocked in Plan mode.' }}
      />
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'count',
    description: 'How many actions this project declares — 0 is every install that declared none, and every install where an operator turned actions off',
    control: { type: 'number', min: 0, max: 5 },
    defaultValue: 2,
  },
  {
    name: 'longName',
    description: 'Give the first action a sentence-length name, which is what people actually write',
    control: { type: 'boolean' },
    defaultValue: false,
  },
  {
    name: 'outcome',
    description: 'What the host answers on click — a command that ran writes to the transcript, one that did not has only the toast',
    control: { type: 'select', options: [{ label: 'Ran', value: 'ran' }, { label: 'Refused', value: 'refused' }] },
    defaultValue: 'ran',
  },
]

export const workspaceActionsMenuComponents: ComponentEntry[] = [
  {
    id: 'workspace-actions-menu',
    name: 'Saved Actions Menu',
    category: 'Chat',
    description:
      "A project's own commands, launched from the header (P6.361). The menu carries ids and names and never a command; the host resolves the id and runs it on the same approval path the agent's Bash takes.",
    component: MenuPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'Two actions', description: 'The ordinary case — a dev server and a test run', props: { count: 2, longName: false, outcome: 'ran' } },
      { name: 'Nothing declared', description: 'The shipped default, and what an operator kill switch produces: no button at all', props: { count: 0, longName: false, outcome: 'ran' } },
      { name: 'A sentence for a name', description: 'What a person actually writes — the item must not become a paragraph', props: { count: 3, longName: true, outcome: 'ran' } },
      { name: 'Refused on click', description: 'The state with no transcript message behind it, so the toast is the whole of what the user gets', props: { count: 2, longName: false, outcome: 'refused' } },
    ],
  },
]
