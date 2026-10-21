/**
 * Playground registry for the PLUGIN SPINNER TIP — P6.424, the third of the
 * page's three suggestion surfaces.
 *
 * The tip is the one suggestion surface that appears while the user is waiting
 * rather than between turns, so the states worth reviewing are the ones that
 * decide whether it reads as a helpful aside or as an advertisement printed over
 * a live signal:
 *
 *  - **none** is what every shipped install renders. `pluginSuggestionMarketplaces`
 *    is managed-settings-only, so a machine with no managed policy has no
 *    suggestion-allowed marketplace and this surface is silent forever. A
 *    playground that only showed the filled state would make the default look
 *    like the exception.
 *  - **beside the processing label** is the whole design question: the tip is a
 *    second line indented under `ProcessingIndicator`'s own label, never in its
 *    place, so the preview mounts the SHIPPED live line
 *    (`chat-display/ProcessingIndicator`, v0.15.1's 28px row) with the tip as its
 *    `suggestion` rather than showing the tip floating on its own. UB12.73: until
 *    then it drew a hand-made stand-in label (`text-[13px]` plus a pulse dot)
 *    that UB14.15's restyle of the real line left behind, so the playground
 *    reviewed an arrangement no user sees.
 *  - **a long topic** is the realistic case. `topic` is a relevance signal's own
 *    phrase, not a slug, so it can be a noun phrase rather than a word.
 *
 * The component takes no callback and starts nothing — it is a sentence — so
 * unlike the deferred-spawn chip beside it there is nothing here to stub out.
 */

import * as React from 'react'
import { ProcessingIndicator } from '@/components/app-shell/chat-display/ProcessingIndicator'
import { PluginSuggestionTip } from '@/components/app-shell/plugin-suggestion-tip'
import type { ComponentEntry } from './types'

const LONG_TOPIC = 'Terraform modules with remote state in an S3 backend'

interface TipKnobs {
  shown: boolean
  topic: string
  reference: string
  withSpinnerLabel: boolean
}

function TipPreview({ shown, topic, reference, withSpinnerLabel }: TipKnobs) {
  const suggestion = shown ? { topic, reference } : undefined
  return (
    <div className="w-[520px] max-w-full">
      {withSpinnerLabel ? (
        // UB12.73 — the shipped line itself: the tip is ITS second line, so the
        // indent, type and colour reviewed here are the ones the chat draws.
        <ProcessingIndicator suggestion={suggestion} />
      ) : (
        suggestion && <PluginSuggestionTip topic={suggestion.topic} reference={suggestion.reference} />
      )}
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  {
    name: 'shown',
    description: 'Whether a suggestion was decided at all — false is every install without a managed allowlist',
    control: { type: 'boolean' },
    defaultValue: true,
  },
  {
    name: 'topic',
    description: 'The phrase the relevance signal chose, filling "Working with topic?"',
    control: { type: 'string' },
    defaultValue: 'Kubernetes manifests',
  },
  {
    name: 'reference',
    description: 'plugin@marketplace — the same id the session-start notice and the Discover pin print',
    control: { type: 'string' },
    defaultValue: 'k8s-helper@acme-plugins',
  },
  {
    name: 'withSpinnerLabel',
    description: 'Mount the shipped live line (ProcessingIndicator) with the tip as its suggestion — the tip goes BELOW the spinner, never instead of it',
    control: { type: 'boolean' },
    defaultValue: true,
  },
]

export const pluginSuggestionTipComponents: ComponentEntry[] = [
  {
    id: 'plugin-suggestion-tip',
    name: 'Plugin Spinner Tip',
    category: 'Chat',
    description:
      'The suggestion shown below the spinner while a turn runs (P6.424). Structural on the wire — topic and reference — so the renderer owns the wording, and silent on every install without a managed suggestion allowlist.',
    component: TipPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      {
        name: 'Under the spinner',
        description: 'The shipped arrangement: a second line under the processing label, indented past the glyph',
        props: { shown: true, topic: 'Kubernetes manifests', reference: 'k8s-helper@acme-plugins', withSpinnerLabel: true },
      },
      {
        name: 'No suggestion',
        description: 'What every install without a managed allowlist renders — the live line alone: no tip, and no reserved height under it',
        props: { shown: false, topic: 'Kubernetes manifests', reference: 'k8s-helper@acme-plugins', withSpinnerLabel: true },
      },
      {
        name: 'A sentence for a topic',
        description: 'topic is a phrase, not a slug — this is where the line wraps',
        props: { shown: true, topic: LONG_TOPIC, reference: 'terraform-tools@acme-plugins', withSpinnerLabel: true },
      },
      {
        name: 'The tip alone',
        description: 'The component on its own, with no label above it, for reading the sentence itself',
        props: { shown: true, topic: 'Kubernetes manifests', reference: 'k8s-helper@acme-plugins', withSpinnerLabel: false },
      },
    ],
  },
]
