/**
 * Playground registry for `SourceStatusIndicator` — P6.681.
 *
 * The component rendered the right five-status vocabulary and had never been on
 * a screen anyone could open: zero production callers, hardcoded English labels
 * and a Radix tooltip that threw without a `TooltipProvider` ancestor. Two of
 * those three are now fixed in the component; this entry is the third, because
 * the playground is the design surface and a status vocabulary is exactly the
 * kind of thing that is reviewed by SEEING all of it at once.
 *
 * So the default variant is the WALL — all five statuses side by side, at the
 * size a row uses — rather than one dot with a knob. A palette that reads well
 * one dot at a time can still be indistinguishable in a list, and that is
 * exactly what the wall caught.
 *
 * **P6.774 — the pair this entry was pointing at is fixed, and the wall is how
 * it was seen.** This paragraph used to read: *"`untested` (`bg-foreground/40`)
 * against `local_disabled` (`bg-foreground/30`) is the pair to look at: they
 * differ by one opacity step and by nothing else."* True when written, and it
 * stayed true through P6.769 giving `local_disabled` a producer — so the
 * distinction the product had just built was legible only to a reader who
 * hovers for the tooltip or runs a screen reader. `local_disabled` is now a
 * HOLLOW RING against every other status's filled dot, which is a difference in
 * SHAPE rather than in shade and survives all three sizes. Keep the wall as the
 * default variant: a second status arriving as a ring would make the mark
 * ambiguous again, and this screen is where that is seen first.
 *
 * The single-status variants exist for the tooltip, which is per-dot and cannot
 * be seen five at a time — including `failed` WITH a reason, the one branch that
 * composes two strings.
 *
 * **UB12.87 — a sixth dot, and it IS a second ring, on purpose.** `disabled` (a
 * source the user switched off) joins the map so the pip can say "Disabled" as
 * the Sources list's line 2 and the detail pill do. It wears `local_disabled`'s
 * hollow ring because both are *switched off* — the half of the pair P6.774
 * separated from *nobody has tried it* — and both print the one word "Disabled"
 * on line 2 and the pill. The ambiguity the paragraph above warns about is a
 * ring that means something else; the wall is still where that would be seen.
 */

import * as React from 'react'
import {
  SourceStatusIndicator,
  STATUS_CONFIG,
  type SourceDisplayStatus,
} from '@/components/ui/source-status-indicator'
import type { ComponentEntry } from './types'

/**
 * Derived from the component's own map, never restated: a status added to
 * `SourceDisplayStatus` appears here the day it is added (UB12.87's `disabled`
 * did), which is the whole reason this entry exists.
 */
const ALL_STATUSES = Object.keys(STATUS_CONFIG) as SourceDisplayStatus[]

interface IndicatorKnobs {
  status: string
  size: string
  errorMessage: string
  showAll: boolean
}

function IndicatorPreview({ status, size, errorMessage, showAll }: IndicatorKnobs) {
  const sizeProp = (size as 'xs' | 'sm' | 'md') ?? 'sm'
  if (showAll) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        {ALL_STATUSES.map(entry => (
          <div key={entry} className="flex items-center gap-2">
            <SourceStatusIndicator status={entry} size={sizeProp} />
            <span className="text-foreground/70 font-mono text-xs">{entry}</span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <SourceStatusIndicator
      status={(status as SourceDisplayStatus) ?? 'untested'}
      size={sizeProp}
      {...(errorMessage ? { errorMessage } : {})}
    />
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'showAll',
    description: 'Show every status at once — the review that a single dot cannot give',
    control: { type: 'boolean' },
    defaultValue: true,
  },
  {
    name: 'status',
    description: 'The one status to render when the wall is off',
    control: {
      type: 'select',
      options: ALL_STATUSES.map(entry => ({ label: entry, value: entry })),
    },
    defaultValue: 'connected',
  },
  {
    name: 'size',
    description: 'Dot size: xs on a dense list row, sm on a card, md on a detail header',
    control: {
      type: 'select',
      options: [
        { label: 'xs', value: 'xs' },
        { label: 'sm', value: 'sm' },
        { label: 'md', value: 'md' },
      ],
    },
    defaultValue: 'sm',
  },
  {
    name: 'errorMessage',
    description: 'Appended to the tooltip on `failed` only — the one branch that joins two strings',
    control: { type: 'string', placeholder: 'ECONNREFUSED 127.0.0.1:8931' },
    defaultValue: '',
  },
]

export const sourceStatusIndicatorComponents: ComponentEntry[] = [
  {
    id: 'source-status-indicator',
    name: 'Source Status Indicator',
    category: 'Sources',
    description:
      'The connection dot — five statuses plus a source the user switched off (UB12.87) — with a localized tooltip (P6.681). Carries its own TooltipProvider, so it works wherever it is mounted rather than only under one. Hover a dot to read its label and description.',
    component: IndicatorPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      {
        name: 'All statuses',
        description: 'The wall — the only view in which the grey states (filled untested, the two hollow switched-off rings) can be compared',
        props: { showAll: true, status: 'connected', size: 'sm', errorMessage: '' },
      },
      {
        name: 'Connected (pulses)',
        description: 'The one status with an animation: a 2s ping ring behind the dot',
        props: { showAll: false, status: 'connected', size: 'md', errorMessage: '' },
      },
      {
        name: 'Needs authentication',
        description: 'The state the import panel lists — the component’s first production caller',
        props: { showAll: false, status: 'needs_auth', size: 'md', errorMessage: '' },
      },
      {
        name: 'Failed, with a reason',
        description: 'The tooltip joins the translated description and the untranslated error text',
        props: { showAll: false, status: 'failed', size: 'md', errorMessage: 'ECONNREFUSED 127.0.0.1:8931' },
      },
      {
        name: 'Local MCP disabled',
        description: 'Not a failure: the server is fine and the setting is off',
        props: { showAll: false, status: 'local_disabled', size: 'md', errorMessage: '' },
      },
      {
        name: 'Switched off (Disabled)',
        description: 'UB12.87: a source the user turned off — the ring and the word "Disabled" its list row and detail pill print, not "Not Tested"',
        props: { showAll: false, status: 'disabled', size: 'md', errorMessage: '' },
      },
      {
        name: 'Row size (xs)',
        description: 'What a dense list row gets — the size the import panel mounts',
        props: { showAll: true, status: 'untested', size: 'xs', errorMessage: '' },
      },
    ],
  },
]
