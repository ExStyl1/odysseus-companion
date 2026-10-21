/**
 * Playground registry for the BACKGROUND-SESSION-FINISHED CHIP — UA1.15
 * (upstream v0.13.4 `BackgroundFinishedChip.tsx`; owner 2026-09-23, OQ-20 item 3:
 * an Appearance preference, OFF by default).
 *
 * The chip floats just ABOVE the composer card, right-aligned (it is mounted by
 * `InputContainer`, not by the composer; v0.15.0 moved it out of the box so it
 * never covers the draft — UB14.27). The stand-in box below is v0.15.1's raised
 * composer card. The states worth reviewing, in dark theme too:
 *
 *  - **one background completion** — the chip, on the floating material with the
 *    accent check, with the session title;
 *  - **a long title** — truncated at 150px, never wrapped over the composer;
 *  - **preference off** (the default) — nothing renders, even with a completion
 *    queued;
 *  - **the session on screen finished** — nothing renders: a row never announces
 *    its own session.
 *
 * Each knob change builds a fresh store, so a clicked (dismissed) chip comes back
 * by toggling any knob. A click here dissolves the chip and dismisses the entry;
 * the navigation it then attempts has no listener in the playground.
 */

import * as React from 'react'
import { Provider, createStore } from 'jotai'
import { BackgroundFinishedChip } from '@/components/app-shell/BackgroundFinishedChip'
import { queueBackgroundFinished, showBackgroundFinishedChipAtom } from '@/atoms/background-finished'
import { focusedPanelIdAtom, panelStackAtom } from '@/atoms/panel-stack'
import { routes } from '../../../shared/routes'
import type { ComponentEntry } from './types'

const ON_SCREEN = 'playground-session'
const IN_BACKGROUND = 'playground-background-session'
const LONG_TITLE = 'Migrate the three gateway fetchers to the shared retry helper and cover the empty-allowlist branch'

interface ChipKnobs {
  enabled: boolean
  finished: 'background' | 'on-screen' | 'none'
  longTitle: boolean
}

function ChipPreview({ enabled, finished, longTitle }: ChipKnobs) {
  const store = React.useMemo(() => {
    const s = createStore()
    s.set(panelStackAtom, [
      { id: 'panel-1', route: routes.view.allSessions(ON_SCREEN), proportion: 1, panelType: 'session', laneId: 'main' },
    ])
    s.set(focusedPanelIdAtom, 'panel-1')
    // Queue under ON (the detector's own gate), then apply the knob: the render
    // gate is then exercised on its own.
    s.set(showBackgroundFinishedChipAtom, true)
    if (finished !== 'none') {
      const id = finished === 'background' ? IN_BACKGROUND : ON_SCREEN
      queueBackgroundFinished(s, id, { id, name: longTitle ? LONG_TITLE : 'Refactor the importer' })
    }
    s.set(showBackgroundFinishedChipAtom, enabled)
    return s
  }, [enabled, finished, longTitle])

  return (
    <Provider store={store}>
      {/* Room above the card: the chip sits `bottom-full mb-2` over it */}
      <div className="pt-10">
        <div className="relative w-[560px]">
          <div className="input-container rounded-xl bg-raised shadow-elev-1 h-[96px] px-4 py-3 text-sm text-tertiary">
            Message Nessy...
          </div>
          <BackgroundFinishedChip sessionId={ON_SCREEN} />
        </div>
      </div>
    </Provider>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'enabled',
    description: 'Appearance → "Background session alerts" (default OFF in the app)',
    control: { type: 'boolean' },
    defaultValue: true,
  },
  {
    name: 'finished',
    description: 'Which session finished',
    control: {
      type: 'select',
      options: [
        { label: 'A background session', value: 'background' },
        { label: 'The session on screen', value: 'on-screen' },
        { label: 'None', value: 'none' },
      ],
    },
    defaultValue: 'background',
  },
  {
    name: 'longTitle',
    description: 'A sentence-length session title — truncated, not wrapped',
    control: { type: 'boolean' },
    defaultValue: false,
  },
]

export const backgroundFinishedChipComponents: ComponentEntry[] = [
  {
    id: 'background-finished-chip',
    name: 'Background Finished Chip',
    category: 'Chat Inputs',
    description:
      'UA1.15 — a background session finished while you were looking at another one. Floats just above the composer card, right-aligned, never over the draft (v0.15.0, UB14.27); a click opens that session. An Appearance preference, off by default.',
    component: ChipPreview,
    layout: 'centered',
    previewOverflow: 'visible',
    props: KNOBS,
    variants: [
      { name: 'One background completion', description: 'The ordinary case', props: { enabled: true, finished: 'background', longTitle: false } },
      { name: 'A long title', description: 'Truncated at 150px', props: { enabled: true, finished: 'background', longTitle: true } },
      { name: 'Preference off (default)', description: 'Nothing renders, even with a completion queued', props: { enabled: false, finished: 'background', longTitle: false } },
      { name: 'The session on screen finished', description: 'Never announced: a row does not announce its own session', props: { enabled: true, finished: 'on-screen', longTitle: false } },
    ],
  },
]
