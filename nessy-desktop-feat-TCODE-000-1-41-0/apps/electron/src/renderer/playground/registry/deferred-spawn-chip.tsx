/**
 * Playground registry for the DEFERRED SPAWN CHIP — P6.334.
 *
 * The chip exists to stop something: today a `spawn_session` fires immediately,
 * and the row asks that out-of-scope work the agent notices become an offer
 * instead. So the states worth reviewing are not decorative — they are the ones
 * that decide whether the offer reads as an offer:
 *
 *  - **none** is the default a session lives in, and it must be invisible; a
 *    plate that reserves height would put a permanent empty box above the
 *    composer.
 *  - **several** is where an offer turns into a nag. Three chips is the count to
 *    look at, because that is where "the agent noticed something" starts reading
 *    as a queue the user owes work to.
 *  - **a long name** is the realistic case: agents propose sentences, not
 *    labels, and the chip truncates rather than wrapping into a paragraph.
 *
 * `onStart` is a no-op here on purpose. In the app it navigates to a route that
 * runs git and takes a host lease; a playground that could do that would be a
 * playground that creates worktrees.
 */

import * as React from 'react'
import {
  DeferredSpawnChips,
  deferredSpawnRoute,
  type DeferredSpawnProposal,
} from '@/components/app-shell/deferred-spawn-chip'
import type { ComponentEntry } from './types'

const LONG_NAME =
  'Extract the duplicated retry logic in the three gateway fetchers into one helper and cover it'

function proposalsFor(count: number, longName: boolean): DeferredSpawnProposal[] {
  const names = [
    'Update the stale README badge',
    'Add a test for the empty-allowlist branch',
    'Remove the dead NESSY_LEGACY_TASKS flag',
  ]
  return Array.from({ length: Math.max(0, count) }, (_, index) => ({
    id: `proposal-${index + 1}`,
    name: longName && index === 0 ? LONG_NAME : (names[index % names.length] ?? `Task ${index + 1}`),
    prompt: 'Do the thing the name says, then report what changed.',
  }))
}

interface ChipKnobs {
  count: number
  longName: boolean
  showRoute: boolean
}

function ChipsPreview({ count, longName, showRoute }: ChipKnobs) {
  const proposals = proposalsFor(count, longName)
  return (
    <div className="w-[560px] space-y-2">
      <DeferredSpawnChips proposals={proposals} onStart={() => {}} onResolve={() => {}} />
      {showRoute && proposals[0] && (
        <div className="rounded border border-dashed border-border/60 p-2 font-mono text-[11px] text-muted-foreground break-all">
          {deferredSpawnRoute(proposals[0])}
        </div>
      )}
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'count',
    description: 'How many proposals are outstanding — 0 is the state every session starts in',
    control: { type: 'number', min: 0, max: 5 },
    defaultValue: 1,
  },
  {
    name: 'longName',
    description: 'Give the first proposal a sentence-length name, which is what an agent actually writes',
    control: { type: 'boolean' },
    defaultValue: false,
  },
  {
    name: 'showRoute',
    description: 'Print the route the Start button navigates to — the worktree=true is the whole point',
    control: { type: 'boolean' },
    defaultValue: false,
  },
]

export const deferredSpawnChipComponents: ComponentEntry[] = [
  {
    id: 'deferred-spawn-chip',
    name: 'Deferred Spawn Chip',
    category: 'Chat',
    description:
      'Work the agent proposed and did NOT start (P6.334). Nothing runs until the click, and the click starts the session isolated in its own git worktree — which the chip says on its face, because that is what bounds the click.',
    component: ChipsPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'One proposal', description: 'The ordinary case: the agent noticed one thing', props: { count: 1, longName: false, showRoute: false } },
      { name: 'Nothing proposed', description: 'The default — renders nothing at all, so the plate collapses', props: { count: 0, longName: false, showRoute: false } },
      { name: 'Three proposals', description: 'Where an offer starts reading as a queue the user owes work to', props: { count: 3, longName: false, showRoute: false } },
      { name: 'A sentence for a name', description: 'What an agent actually writes — truncated, not wrapped', props: { count: 2, longName: true, showRoute: false } },
      { name: 'With the route shown', description: 'The worktree=true the handler matches on, printed beside the chip', props: { count: 1, longName: false, showRoute: true } },
    ],
  },
]
