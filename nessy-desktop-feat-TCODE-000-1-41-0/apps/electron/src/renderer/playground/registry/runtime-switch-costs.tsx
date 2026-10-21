/**
 * The runtime-switch confirmation, as it actually ships — P2.486.
 *
 * ## Why this entry exists, and why it is not in `runtime-switch.tsx`
 *
 * That file holds four DRAFT entries: a hand-built copy of a picker, with
 * hand-written prose about context, memory, reasoning level and background
 * tasks. Nothing in it imports `runtimeSwitchCosts`, so across nineteen
 * playground states **zero** rendered a single row of the real cost table —
 * while the dialog that actually tells a user what a switch costs them had no
 * entry at all. Every cost row this plan has re-cut was reviewed as source and
 * never as a screen, and P4.6 found six stale claims in the draft module, which
 * is what an unreviewable surface accumulates.
 *
 * So this entry imports the REAL `RuntimeSwitchDialog`. Nothing here re-draws
 * it, and nothing here re-words a cost: the rows come from
 * `runtimeSwitchCosts(from, to)` through the component's own call, and the
 * sentences come from the locale files through its own `t()`. A playground
 * entry that copied either would be a second surface to keep true, which is the
 * defect it exists to catch.
 *
 * ## What the knobs are
 *
 * The DIRECTION, because the cost list is per-ordered-pair and the interesting
 * ones are the asymmetric returns. And the carry plan plus its reason, because
 * `runtimeSwitchCopyKey` chooses a different body and a different explanatory
 * line for each — P3.266's whole point was that the reason had never reached a
 * screen.
 *
 * ## The return legs changed shape on 2026-09-06, and so did this entry
 *
 * Until W6-d the two return legs onto Pi rendered NOTHING, and this file said so
 * in three places. `credentialShellFloor` (P6.65 — codex enforces the credential
 * deny list in the OS, where ours is tool-mediated) and `policyKeys` (P6.170 —
 * 32 documented Claude switches the vendored binary honours and nothing of ours
 * reads) are the first two rows a runtime other than Pi holds, so **Codex → Pi
 * and Claude → Pi stopped being blank**, and Claude → Pi is offered here for the
 * first time because it was a blank screen before and is a claim now. (It said
 * *"one line each"* until P6.346(a) put a second line on the Claude leg — the
 * same prose-beside-a-list rot the cost module's own header records, one file
 * over.)
 *
 * ## And a row can now say it does not know — P6.562 (2026-09-06)
 *
 * `RuntimeSwitchClaim` gained a fourth value, `'unmeasured'`, for a cell nobody
 * has driven: before it, the only way to write "we do not know" was `null`,
 * which removed the runtime from every direction and rendered as an empty block
 * — "nothing to lose here", the opposite of what the cell meant. The first such
 * cell is `toolMemoryCap` (P6.346(a)), and it renders as a `(not measured)`
 * marker after its sentence. Both legs OUT of Claude therefore carry it, which
 * is why those two variants are the ones to review: this entry is the only place
 * the marker can be seen next to ordinary rows.
 *
 * ## P6.597 — the marker stopped being a corner case (2026-09-06)
 *
 * The sweep that asked every `false` cell to show its measurement moved two
 * more: `worktreeMove` and `scheduledRun`'s claude cells. So the marker is no
 * longer one row on two quiet return legs. It now appears on **Pi → Claude**,
 * the busiest screen in the product, and on **Claude → Codex**, where several
 * rows carry it INTERLEAVED with measurements rather than trailing them. That
 * second shape is new and is the one to look at: a marker survives being last
 * by position alone, and these do not. (The fractions this paragraph used to
 * quote are dropped rather than re-counted: every leg's length is asserted by
 * RUNNING `runtimeSwitchCosts`, and a count beside a list is the one thing this
 * family of files has been wrong about repeatedly.)
 *
 * ## C3.251 — one of that pair left the class by being DRIVEN (2026-09-12)
 *
 * RS-28 drove claude's native `EnterWorktree` against a real repository at the
 * packaged 1.36.0 sitting and it succeeded, so `worktreeMove.anthropic` is
 * `true`: the row no longer appears on Pi → Claude at all, and on Claude → Codex
 * it is a plain measurement. `scheduledRun` is unmoved and is now the marker's
 * main carrier on the Pi → Claude screen, which is the variant to review — a
 * marker that used to arrive in pairs now arrives alone, and "one odd line among
 * measurements" is a different reading task from "two".
 *
 * The EMPTY block is still a state worth looking at — "nothing listed" must not
 * read as "we did not check" — and it is now reachable only through the
 * same-runtime variant, which is why that one keeps its place at the end.
 *
 * The dialog renders `null` for a `model` switch and for a session with no
 * history, by design; those are silent in the product and are therefore not
 * offered as states here.
 */

import * as React from 'react'
import type { ComponentEntry } from './types'
import type { LlmConnectionWithStatus, LlmProviderType } from '@config/llm-connections'
import type { HistoryCarryPlan, HistoryCarryReason } from '@nessy-agent/shared/protocol'
import { ModalProvider } from '@/context/ModalContext'
import {
  RuntimeSwitchDialog,
  type RuntimeSwitchPending,
} from '@/components/app-shell/input/RuntimeSwitchDialog'

/**
 * `useRegisterModal` throws without a provider and the playground shell mounts
 * none globally — the same reason `runtime-switch.tsx` carries its own.
 */
function WithModalProvider({ children }: { children: React.ReactNode }) {
  return <ModalProvider>{children}</ModalProvider>
}

/** One connection per runtime, named as a user would see them. */
const CONNECTIONS: Record<string, LlmConnectionWithStatus> = {
  pi: {
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi' as LlmProviderType,
    authType: 'api_key',
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    isAuthenticated: true,
    createdAt: 0,
  },
  claude: {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime' as LlmProviderType,
    authType: 'api_key',
    defaultModel: 'claude-sonnet-4-6',
    isAuthenticated: true,
    createdAt: 0,
  },
  codex: {
    slug: 'codex-gateway',
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime' as LlmProviderType,
    authType: 'api_key',
    defaultModel: 'gpt-5.1-codex',
    isAuthenticated: true,
    createdAt: 0,
  },
}

type DirectionId =
  | 'pi-to-codex' | 'pi-to-claude' | 'claude-to-codex'
  | 'codex-to-pi' | 'claude-to-pi' | 'same-runtime'

const DIRECTIONS: Record<DirectionId, { from: keyof typeof CONNECTIONS; to: keyof typeof CONNECTIONS; cross: boolean }> = {
  'pi-to-codex': { from: 'pi', to: 'codex', cross: true },
  'pi-to-claude': { from: 'pi', to: 'claude', cross: true },
  'claude-to-codex': { from: 'claude', to: 'codex', cross: true },
  // The two return legs, which are no longer blank. Codex → Pi is the
  // single-bullet layout case — the heading, one bullet, and the carry line
  // under it; Claude → Pi carries two since P6.346(a), the second of them
  // marked `(not measured)`.
  'codex-to-pi': { from: 'codex', to: 'pi', cross: true },
  'claude-to-pi': { from: 'claude', to: 'pi', cross: true },
  'same-runtime': { from: 'pi', to: 'pi', cross: false },
}

function RuntimeSwitchCostsDemo({
  direction = 'pi-to-codex',
  historyCarry = 'text',
  historyCarryReason = 'does-not-fit',
}: {
  direction?: DirectionId
  historyCarry?: HistoryCarryPlan | 'none'
  historyCarryReason?: HistoryCarryReason | 'none'
}) {
  const spec = DIRECTIONS[direction] ?? DIRECTIONS['pi-to-codex']
  const pending: RuntimeSwitchPending = {
    kind: spec.cross ? 'connection-cross-runtime' : 'connection-same-runtime',
    from: CONNECTIONS[spec.from]!,
    to: (spec.from === spec.to
      ? { ...CONNECTIONS[spec.to]!, slug: 'ollama-local', name: 'Ollama (local)' }
      : CONNECTIONS[spec.to]!),
    historyCarry: historyCarry === 'none' ? null : historyCarry,
    historyCarryReason: historyCarryReason === 'none' ? null : historyCarryReason,
  }
  return (
    <div className="w-full min-h-[520px]">
      <RuntimeSwitchDialog pending={pending} onCancel={() => {}} onConfirm={() => {}} />
    </div>
  )
}

export const runtimeSwitchCostsComponents: ComponentEntry[] = [
  {
    id: 'runtime-switch-dialog-costs',
    name: 'Runtime Switch — confirmation (shipped)',
    category: 'Chat Inputs',
    description:
      'THE dialog the app shows before a mid-session runtime change, not a draft of one. The cost rows are read from `runtimeSwitchCosts(from, to)` and the sentences from the locale files, so this entry cannot say anything the product does not — which is the point: until P2.486 every cost row had been reviewed as source and never as a screen.',
    component: RuntimeSwitchCostsDemo,
    wrapper: WithModalProvider,
    layout: 'full',
    previewOverflow: 'visible',
    props: [
      {
        name: 'direction',
        description: 'The ordered pair. The list is per-direction, so the return leg is a different screen from the outbound one.',
        control: {
          type: 'select',
          options: [
            { label: 'Pi → Codex', value: 'pi-to-codex' },
            { label: 'Pi → Claude', value: 'pi-to-claude' },
            { label: 'Claude → Codex', value: 'claude-to-codex' },
            { label: 'Codex → Pi (one row)', value: 'codex-to-pi' },
            { label: 'Claude → Pi (one row)', value: 'claude-to-pi' },
            { label: 'Same runtime (Pi → Pi)', value: 'same-runtime' },
          ],
        },
        defaultValue: 'pi-to-codex',
      },
      {
        name: 'historyCarry',
        description: 'What the server said would cross. `none` is the preview declining to answer — the dialog then omits the line rather than guessing.',
        control: {
          type: 'select',
          options: [
            { label: 'native — the whole conversation', value: 'native' },
            { label: 'anchor', value: 'anchor' },
            { label: 'text — the trimmed tail', value: 'text' },
            { label: 'none — preview did not answer', value: 'none' },
          ],
        },
        defaultValue: 'text',
      },
      {
        name: 'historyCarryReason',
        description: 'WHY (P3.266). Only a degradation has one; a native carry that fits has nothing to explain.',
        control: {
          type: 'select',
          options: [
            { label: 'does-not-fit', value: 'does-not-fit' },
            { label: 'no-native-carry-implemented', value: 'no-native-carry-implemented' },
            { label: 'context-window-unknown', value: 'context-window-unknown' },
            { label: 'context-window-unenforced', value: 'context-window-unenforced' },
            { label: 'target-already-anchored', value: 'target-already-anchored' },
            { label: 'fits', value: 'fits' },
            { label: 'none — nothing to explain', value: 'none' },
          ],
        },
        defaultValue: 'does-not-fit',
      },
    ],
    variants: [
      {
        name: 'Pi → Codex, trimmed tail',
        description: 'The longest cost list this product produces, under the carry that shortens the conversation. The screen a user most often actually sees.',
        props: { direction: 'pi-to-codex', historyCarry: 'text', historyCarryReason: 'does-not-fit' },
      },
      {
        name: 'Pi → Claude, native carry',
        description: 'The whole conversation crosses, so the carry line promises rather than warns — and the cost list beneath it is still not empty. Since P6.597 two of its five rows are `(not measured)`: this is the busiest leg in the product and therefore where a marker is most likely to be skimmed past.',
        props: { direction: 'pi-to-claude', historyCarry: 'native', historyCarryReason: 'fits' },
      },
      {
        name: 'Claude → Codex — the marker inside a long list',
        description: 'Neither endpoint is Pi. The rows here are the ones nobody reads in source because the direction is unusual — and since P6.597 this is the hardest state the marker has: ELEVEN rows carrying THREE `(not measured)` cautions, INTERLEAVED with the measurements rather than trailing them. P6.346(a) put one at the end of nine, which a marker can survive by being last; two of these now sit in the middle of the list, so the review question is whether a caution reads as a caution when a measurement follows it on the next line.',
        props: { direction: 'claude-to-codex', historyCarry: 'text', historyCarryReason: 'no-native-carry-implemented' },
      },
      {
        name: 'Codex → Pi — the shortest list there is',
        description: 'A return leg that used to render nothing. Since P6.65 it carries exactly one row — the OS-enforced credential exclusion codex has and we do not — so this is the single-bullet layout, the case a list designed for ten rows never had to hold.',
        props: { direction: 'codex-to-pi', historyCarry: 'native', historyCarryReason: 'fits' },
      },
      {
        name: 'Claude → Pi — a counted row and an UNMEASURED one',
        description: 'The other return leg, and the only screen in the product that carries P6.562\'s marker. Two rows: `policyKeys` states a count (32 documented Claude policy and security switches stop being read — the one cost sentence with a number in it, so this is where to look at wrapping), and `toolMemoryCap` (P6.346(a)) is the first cost whose claim is neither yes nor no, so it renders with a quiet `(not measured)` after the sentence. The two side by side are the state to review: a caution must not read like a measurement, and a measurement must not read like a caution.',
        props: { direction: 'claude-to-pi', historyCarry: 'native', historyCarryReason: 'fits' },
      },
      {
        name: 'Same runtime — the empty block',
        description: 'Nessy Gateway → Ollama, both Pi. Different copy and NO cost list, which since 2026-09-06 is the only way to see that state: every cross-runtime leg now carries at least one row. The absence must still not read as "we did not check".',
        props: { direction: 'same-runtime', historyCarry: 'native', historyCarryReason: 'fits' },
      },
      {
        name: 'Preview declined to answer',
        description: 'No carry plan and no reason. The dialog omits the line instead of guessing one — the state a broken or slow preview produces.',
        props: { direction: 'pi-to-codex', historyCarry: 'none', historyCarryReason: 'none' },
      },
    ],
    mockData: () => ({}),
  },
]
