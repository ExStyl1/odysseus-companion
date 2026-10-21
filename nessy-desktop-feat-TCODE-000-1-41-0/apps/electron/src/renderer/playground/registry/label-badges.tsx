/**
 * Playground registry entry for LabelBadgeRow.
 *
 * Demonstrates label value badges with interactive editing:
 * - Boolean labels (no value)
 * - Number-valued labels
 * - Date-valued labels
 * - String-valued labels
 * - Popover editing (click badge → edit value / remove)
 *
 * UB14.35 (v0.15.1) adds the entries the label/status restyle touches, each drawn in the state it changes:
 * the session-row chip (`EntityListLabelBadge`: tint, duplicate ids), the chip with its value editor OPEN
 * (header, fields, actions; either side), the `#` menu over a stand-in composer (states + labels, and the
 * "Add new label" fallback), and the status menu (active, cleared, archived).
 */

import * as React from 'react'
import type { ComponentEntry } from './types'
import { sessionLabelChips, type LabelConfig } from '@nessy-agent/shared/labels'
import { LabelBadgeRow } from '@/components/ui/label-badge-row'
import { EntityListLabelBadge } from '@/components/ui/entity-list-label-badge'
import { InlineLabelMenu, createLabelMenuItems } from '@/components/ui/label-menu'
import { SessionStatusMenu, type SessionStatus } from '@/components/ui/session-status-menu'
import { mockStatuses } from '../demos/kanban/mock-kanban-data'

// ============================================================================
// Mock label configurations matching the workspace format
// ============================================================================

const MOCK_LABELS: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  { id: 'due-date', name: 'Due Date', color: { light: '#3B82F6', dark: '#60A5FA' }, valueType: 'date' },
  { id: 'sprint', name: 'Sprint', color: { light: '#8B5CF6', dark: '#A78BFA' }, valueType: 'string' },
  { id: 'feature', name: 'Feature', color: { light: '#10B981', dark: '#34D399' } },
  { id: 'estimate', name: 'Estimate', color: { light: '#EC4899', dark: '#F472B6' }, valueType: 'number' },
  { id: 'docs', name: 'Docs', color: { light: '#0EA5E9', dark: '#38BDF8' }, valueType: 'link' },
]

// ============================================================================
// Playground Wrapper Component
// ============================================================================

interface LabelBadgeRowPlaygroundProps {
  showValues: boolean
  labelCount: number
}

function LabelBadgeRowPlayground({ showValues, labelCount }: LabelBadgeRowPlaygroundProps) {
  // Build initial session labels based on props
  const initialLabels = React.useMemo(() => {
    const base: string[] = []
    const configs = MOCK_LABELS.slice(0, Math.max(1, labelCount))

    for (const config of configs) {
      if (!showValues || !config.valueType) {
        // Boolean label — just the ID
        base.push(config.id)
      } else {
        // Valued label — add a sample value
        switch (config.valueType) {
          case 'number':
            base.push(`${config.id}::${config.id === 'priority' ? '3' : '5'}`)
            break
          case 'date':
            base.push(`${config.id}::2026-02-01`)
            break
          case 'string':
            base.push(`${config.id}::Q1-Sprint-3`)
            break
          case 'link':
            base.push(`${config.id}::https://example.com/docs/getting-started`)
            break
        }
      }
    }
    return base
  }, [showValues, labelCount])

  const [sessionLabels, setSessionLabels] = React.useState<string[]>(initialLabels)

  // Reset when props change
  React.useEffect(() => {
    setSessionLabels(initialLabels)
  }, [initialLabels])

  // UB12.97 — the input area this simulates wears v0.15.1's raised card (`bg-raised`, UB14.27); `bg-sidebar` named no colour.
  return (
    <div className="w-[500px] rounded-[12px] border border-border bg-raised overflow-hidden">
      {/* Simulated input area header */}
      <LabelBadgeRow
        sessionLabels={sessionLabels}
        labels={MOCK_LABELS}
        onLabelsChange={setSessionLabels}
      />
      {/* Simulated input area */}
      <div className="px-5 py-4 min-h-[80px] text-foreground/30 text-[14px]">
        Message...
      </div>
      {/* Simulated bottom bar */}
      <div className="border-t border-border/50 px-3 py-2 flex items-center">
        <span className="text-[12px] text-foreground/40">
          {sessionLabels.length} label{sessionLabels.length !== 1 ? 's' : ''} applied
        </span>
      </div>
    </div>
  )
}

// ============================================================================
// UB14.35 — the session-row chip, its value editor, the # menu, the status menu
// ============================================================================

/** The chip set: coloured and uncoloured, plain and valued, a link, a valued label with no value, two ids twice. */
const CHIP_LABELS: LabelConfig[] = [
  ...MOCK_LABELS,
  { id: 'customer', name: 'Customer', color: { light: '#0D9488', dark: '#2DD4BF' }, valueType: 'string' },
  { id: 'research', name: 'Research' },
]

const CHIP_ENTRIES = {
  mixed: ['bug', 'priority::3', 'due-date::2026-02-01', 'docs::https://example.com/docs/getting-started', 'estimate', 'research'],
  // `customer` twice: each chip carries its own `entryIndex`, so editing one never rewrites the other (UB4.13).
  duplicates: ['customer::Acme', 'bug', 'customer::Globex', 'bug::bug', 'priority::3'],
} as const

const withoutColor = (labels: LabelConfig[]): LabelConfig[] => labels.map(({ color: _color, ...rest }) => rest)

interface EntityListChipsPlaygroundProps {
  colored: boolean
  entries: keyof typeof CHIP_ENTRIES
}

/** The session row's chips, resolved the way SessionBadges resolves them (`sessionLabelChips`). */
function EntityListChipsPlayground({ colored, entries }: EntityListChipsPlaygroundProps) {
  const labels = React.useMemo(() => (colored ? CHIP_LABELS : withoutColor(CHIP_LABELS)), [colored])
  const initial = React.useMemo(() => [...CHIP_ENTRIES[entries]], [entries])
  const [sessionLabels, setSessionLabels] = React.useState<string[]>(initial)
  React.useEffect(() => { setSessionLabels(initial) }, [initial])
  const chips = sessionLabelChips(sessionLabels, labels)
  return (
    <div className="flex w-[440px] flex-wrap items-center gap-1 rounded-xl bg-background p-3 shadow-elev-1">
      {chips.map(chip => (
        <EntityListLabelBadge
          key={chip.key}
          label={chip.label}
          rawValue={chip.rawValue}
          entryIndex={chip.entryIndex}
          sessionLabels={sessionLabels}
          onLabelsChange={setSessionLabels}
        />
      ))}
    </div>
  )
}

const EDITOR_SAMPLES: Record<string, { labelId: string; entry: string }> = {
  string: { labelId: 'sprint', entry: 'sprint::Q1-Sprint-3' },
  number: { labelId: 'priority', entry: 'priority::3' },
  date: { labelId: 'due-date', entry: 'due-date::2026-02-01' },
  link: { labelId: 'docs', entry: 'docs::https://example.com/docs/getting-started' },
  plain: { labelId: 'bug', entry: 'bug' },
}

interface LabelValueEditorPlaygroundProps {
  valueType: keyof typeof EDITOR_SAMPLES
  popoverSide: 'top' | 'bottom'
}

/**
 * One chip with its value editor held OPEN through the chip's controlled `open` / `onOpenChange` (the props the
 * chat header uses to pin a chip while it edits). The header names the label; plain labels show only Remove.
 */
function LabelValueEditorPlayground({ valueType, popoverSide }: LabelValueEditorPlaygroundProps) {
  const sample = EDITOR_SAMPLES[valueType] ?? EDITOR_SAMPLES.string!
  const label = CHIP_LABELS.find(candidate => candidate.id === sample.labelId)!
  const [sessionLabels, setSessionLabels] = React.useState<string[]>([sample.entry])
  const [open, setOpen] = React.useState(true)
  React.useEffect(() => { setSessionLabels([sample.entry]); setOpen(true) }, [sample.entry, popoverSide])
  const chip = sessionLabelChips(sessionLabels, CHIP_LABELS)[0]
  return (
    <div className={popoverSide === 'top' ? 'flex h-[300px] w-[320px] items-end' : 'flex h-[300px] w-[320px] items-start'}>
      {chip ? (
        <EntityListLabelBadge
          label={chip.label}
          rawValue={chip.rawValue}
          entryIndex={chip.entryIndex}
          sessionLabels={sessionLabels}
          onLabelsChange={setSessionLabels}
          open={open}
          onOpenChange={setOpen}
          sessionId="playground-session"
          popoverSide={popoverSide}
        />
      ) : (
        <span className="text-label text-tertiary">{label.name} removed</span>
      )}
    </div>
  )
}

const MENU_LABELS: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  {
    id: 'area', name: 'Area', children: [
      { id: 'frontend', name: 'Frontend', color: { light: '#3B82F6', dark: '#60A5FA' } },
      { id: 'backend', name: 'Backend', color: { light: '#10B981', dark: '#34D399' } },
    ],
  },
  { id: 'research', name: 'Research' },
]

interface InlineLabelMenuPlaygroundProps {
  withStates: boolean
  filter: string
}

/** The `#` menu, open above a stand-in composer the way FreeFormInput anchors it (caret position). */
function InlineLabelMenuPlayground({ withStates, filter }: InlineLabelMenuPlaygroundProps) {
  const anchorRef = React.useRef<HTMLDivElement>(null)
  const [caret, setCaret] = React.useState({ x: 0, y: 0 })
  const [activeStateId, setActiveStateId] = React.useState('todo')
  React.useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) setCaret({ x: rect.left + 24, y: rect.top })
  }, [withStates, filter])
  const items = React.useMemo(() => createLabelMenuItems(MENU_LABELS, ['bug']), [])
  const noop = React.useCallback(() => {}, [])
  return (
    <div className="flex h-[360px] w-full max-w-[520px] flex-col justify-end p-6">
      <div ref={anchorRef} className="h-[88px] rounded-xl bg-raised p-3 text-label text-tertiary shadow-elev-1">
        #{filter}
      </div>
      <InlineLabelMenu
        open
        onOpenChange={noop}
        items={items}
        onSelect={noop}
        onAddLabel={noop}
        filter={filter}
        position={caret}
        states={withStates ? mockStatuses : []}
        activeStateId={activeStateId}
        onSelectState={setActiveStateId}
      />
    </div>
  )
}

/** A custom status: its configured label is shown as-is in every language (`statusDisplayLabel`). */
const CUSTOM_STATUS: SessionStatus = { ...mockStatuses[0]!, id: 'blocked-on-review', label: 'Blocked on review' }

interface SessionStatusMenuPlaygroundProps {
  activeState: string
  archived: boolean
}

/** The status menu as the session row's icon and the kanban tile open it (clear + archive rows included). */
function SessionStatusMenuPlayground({ activeState, archived }: SessionStatusMenuPlaygroundProps) {
  // '' is "no status": the Clear row is then the active one.
  const [active, setActive] = React.useState(activeState)
  React.useEffect(() => { setActive(activeState) }, [activeState])
  const noop = React.useCallback(() => {}, [])
  return (
    <SessionStatusMenu
      states={[...mockStatuses, CUSTOM_STATUS]}
      activeState={active}
      onSelect={setActive}
      onClear={() => setActive('')}
      isArchived={archived}
      onArchive={noop}
      onUnarchive={noop}
    />
  )
}

// ============================================================================
// Registry Entry
// ============================================================================

export const labelBadgeComponents: ComponentEntry[] = [
  {
    id: 'label-badge-row-standalone',
    name: 'LabelBadgeRow (Standalone)',
    category: 'Chat Inputs',
    description: 'Standalone label badge row primitive. Session label chips in the chat header use ChatHeaderLabels (whole chips + "+N").',
    component: LabelBadgeRowPlayground,
    props: [
      {
        name: 'showValues',
        description: 'Whether valued labels show their typed values',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'labelCount',
        description: 'Number of labels to display (1-6)',
        control: { type: 'number', min: 1, max: 6, step: 1 },
        defaultValue: 4,
      },
    ],
    variants: [
      {
        name: 'Single boolean label',
        description: 'One label without a value',
        props: { showValues: false, labelCount: 1 },
      },
      {
        name: 'Mixed labels with values',
        description: 'Multiple labels — some boolean, some with number/date/string values',
        props: { showValues: true, labelCount: 4 },
      },
      {
        name: 'Many labels (wrap)',
        description: 'Six labels to demonstrate flex-wrap behavior',
        props: { showValues: true, labelCount: 6 },
      },
      {
        name: 'All boolean',
        description: 'Multiple labels without values',
        props: { showValues: false, labelCount: 4 },
      },
    ],
  },
  {
    id: 'entity-list-label-badge',
    name: 'EntityListLabelBadge (session-row chips)',
    category: 'Session List',
    description: 'UB14.35 (v0.15.1) — the label chip: tinted with the label\'s own colour at 18% (text stays in the foreground/secondary roles), neutral fill when uncoloured; Enter/Space opens its editor; a repeated id keeps one chip per entry.',
    component: EntityListChipsPlayground,
    props: [
      {
        name: 'colored',
        description: 'Labels carry their configured colours',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'entries',
        description: 'The session\'s label entries',
        control: { type: 'select', options: [{ label: 'Mixed', value: 'mixed' }, { label: 'Duplicate ids', value: 'duplicates' }] },
        defaultValue: 'mixed',
      },
    ],
    variants: [
      {
        name: 'Uncoloured',
        description: 'The same chips without colours: the neutral fill and the secondary/tertiary text roles.',
        props: { colored: false, entries: 'mixed' },
      },
      {
        name: 'Duplicate ids',
        description: 'customer::Acme and customer::Globex stay two chips; the legacy bug::bug collapses into the plain Bug chip.',
        props: { colored: true, entries: 'duplicates' },
      },
    ],
  },
  {
    id: 'label-value-editor',
    name: 'Label value editor (open)',
    category: 'Session List',
    description: 'UB14.35 (v0.15.1) — the chip\'s value editor, held open through the chip\'s controlled open state: a header naming the label, the sunken field, Open link, and Remove on the destructive tint.',
    component: LabelValueEditorPlayground,
    props: [
      {
        name: 'valueType',
        description: 'Which label the chip shows',
        control: {
          type: 'select',
          options: [
            { label: 'String', value: 'string' },
            { label: 'Number', value: 'number' },
            { label: 'Date', value: 'date' },
            { label: 'Link', value: 'link' },
            { label: 'Plain (no value)', value: 'plain' },
          ],
        },
        defaultValue: 'string',
      },
      {
        name: 'popoverSide',
        description: 'Side the editor opens on (the chat header opens downward)',
        control: { type: 'select', options: [{ label: 'Top', value: 'top' }, { label: 'Bottom', value: 'bottom' }] },
        defaultValue: 'top',
      },
    ],
    variants: [
      { name: 'Number', props: { valueType: 'number', popoverSide: 'top' } },
      { name: 'Date', props: { valueType: 'date', popoverSide: 'top' } },
      { name: 'Link', props: { valueType: 'link', popoverSide: 'top' } },
      { name: 'Plain label', description: 'Presence-only: the header and Remove.', props: { valueType: 'plain', popoverSide: 'top' } },
      { name: 'Opens downward', props: { valueType: 'string', popoverSide: 'bottom' } },
    ],
  },
  {
    id: 'inline-label-menu',
    name: 'InlineLabelMenu (# menu)',
    category: 'Chat Inputs',
    description: 'UB14.35 (v0.15.1) — the # menu on the caret-menu material (floating surface, 30px rows, tertiary section labels); the applied plain label (Bug) is not listed.',
    component: InlineLabelMenuPlayground,
    props: [
      {
        name: 'withStates',
        description: 'Show the States section above the labels',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'filter',
        description: 'Text typed after #',
        control: { type: 'string', placeholder: 'filter...' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'Labels only', props: { withStates: false, filter: '' } },
      { name: 'No match: add new label', description: 'Nothing matches the filter: the "Add new label" row.', props: { withStates: false, filter: 'zzz' } },
    ],
  },
  {
    id: 'session-status-menu',
    name: 'SessionStatusMenu',
    category: 'Session List',
    description: 'UB14.35 (v0.15.1) — the status menu on the floating material: 30px rows, the active row on the selected fill, hairline separators before Clear and Archive; built-in statuses translated, custom ones as configured.',
    component: SessionStatusMenuPlayground,
    props: [
      {
        name: 'activeState',
        description: 'The session\'s current status (empty = none)',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: '' },
            ...mockStatuses.map(status => ({ label: status.label, value: status.id })),
            { label: CUSTOM_STATUS.label, value: CUSTOM_STATUS.id },
          ],
        },
        defaultValue: 'todo',
      },
      {
        name: 'archived',
        description: 'The session is archived (the last row reads Unarchive)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'No status', description: 'Clear is the active row.', props: { activeState: '', archived: false } },
      { name: 'Custom status active', props: { activeState: CUSTOM_STATUS.id, archived: false } },
      { name: 'Archived', props: { activeState: 'done', archived: true } },
    ],
  },
]
