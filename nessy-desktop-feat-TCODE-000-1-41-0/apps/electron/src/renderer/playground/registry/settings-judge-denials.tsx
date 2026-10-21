/**
 * Playground registry for the AUTO-MODE DENIALS list — P6.209 (A42).
 *
 * Every state here is one a reviewer cannot produce on a real machine without
 * arranging for a safety judge to refuse something: the receipts are minted only
 * by a Claude Code session in auto mode, only when the classifier declines, and
 * they live in a bounded in-memory ring that dies with the session.
 *
 *  - **no chat open** is the state the settings page is in most of the time. It
 *    must NOT render an empty list — an empty list claims the judge refused
 *    nothing, which is the one thing this section may never say when it does not
 *    know.
 *  - **empty** is the honest empty: a chat was read and refused nothing. It is a
 *    different sentence from the one above, and that difference is the whole
 *    design.
 *  - **unavailable** is the read failing. Also its own sentence, for the same
 *    reason.
 *  - **unsupported** (P6.721) is the runtime keeping no such record at all —
 *    Pi's Guardian and codex's reviewer mint nothing. Before the answer carried
 *    its own capability this state did not exist and a Pi session rendered the
 *    "refused nothing" sentence, which was false.
 *  - **listed** is the working case, and the one to look at for density: a
 *    refusal is four facts (what, under which mode, in whose words, when) and
 *    they have to be readable at a glance without the refused arguments, which
 *    deliberately never leave the host.
 */

import * as React from 'react'
import { AutoModeDenialsList } from '@/pages/settings/AutoModeDenialsSection'
import { SettingsCard } from '@/components/settings/SettingsCard'
import type { SafeAutoModeDenialView } from '@nessy-agent/shared/protocol/capabilities'
import type { ComponentEntry } from './types'

type StateName = 'no-session' | 'empty' | 'unavailable' | 'unsupported' | 'listed' | 'many'

const SAMPLE: SafeAutoModeDenialView[] = [
  {
    toolName: 'Bash',
    reason: 'Blocked by classifier',
    permissionMode: 'auto',
    deniedAt: '2026-09-07T12:04:11.000Z',
  },
  {
    toolName: 'Write',
    reason: 'Auto mode could not evaluate this action and is blocking it for safety.',
    permissionMode: 'auto',
    deniedAt: '2026-09-07T12:09:52.000Z',
  },
  {
    toolName: 'Bash',
    reason: 'Classifier unavailable',
    permissionMode: 'acceptEdits',
    deniedAt: '2026-09-07T12:18:03.000Z',
  },
]

function DenialsPreview({ state }: { state: StateName }) {
  const listed = state === 'many'
    ? Array.from({ length: 12 }, (_, index) => ({
        ...SAMPLE[index % SAMPLE.length]!,
        deniedAt: `2026-09-07T12:${String(index).padStart(2, '0')}:00.000Z`,
      }))
    : SAMPLE
  // UB15.7 — inside the page's card, as the section renders it (the list draws card-ready blocks).
  return (
    <div className="w-[560px] max-w-full">
      <SettingsCard>
        <AutoModeDenialsList
          state={
            state === 'no-session' ? { kind: 'no-session' }
            : state === 'unavailable' ? { kind: 'unavailable' }
            : state === 'unsupported' ? { kind: 'unsupported', runtime: 'pi' }
            : state === 'empty' ? { kind: 'listed', denials: [] }
            : { kind: 'listed', denials: listed }
          }
        />
      </SettingsCard>
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'state',
    description: 'Five sentences and one list — "no chat open", "refused nothing", "could not read" and "this runtime keeps no record" are four different facts and must not share a rendering',
    control: {
      type: 'select',
      options: [
        { label: 'No chat open', value: 'no-session' },
        { label: 'Refused nothing', value: 'empty' },
        { label: 'Could not be read', value: 'unavailable' },
        { label: 'Runtime keeps no record', value: 'unsupported' },
        { label: 'Three refusals', value: 'listed' },
        { label: 'A full ring', value: 'many' },
      ],
    },
    defaultValue: 'listed',
  },
]

export const settingsJudgeDenialsComponents: ComponentEntry[] = [
  {
    id: 'settings-judge-denials',
    name: 'Auto-Mode Denials',
    category: 'Settings',
    description:
      "What the Claude Code auto-mode judge refused in the open chat (P6.209, A42). Read-only by design: re-issuing a call a safety judge declined is a product posture, so no retry ships with the viewer. The refused arguments never leave the host.",
    component: DenialsPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'Three refusals', description: 'The working case — what, under which mode, in whose words, when', props: { state: 'listed' } },
      { name: 'No chat open', description: 'What the settings page shows most of the time, and it must not be an empty list', props: { state: 'no-session' } },
      { name: 'Refused nothing', description: 'The honest empty: a chat was read and the judge declined nothing', props: { state: 'empty' } },
      { name: 'Could not be read', description: 'The read failed — its own sentence, never an empty list', props: { state: 'unavailable' } },
      { name: 'Runtime keeps no record', description: 'A Pi or codex session: the judge refuses and keeps no receipt, so an empty list would be a false claim (P6.721)', props: { state: 'unsupported' } },
      { name: 'A full ring', description: 'Twelve rows, for density: the ring holds fifty and a busy auto-mode session fills it', props: { state: 'many' } },
    ],
  },
]
