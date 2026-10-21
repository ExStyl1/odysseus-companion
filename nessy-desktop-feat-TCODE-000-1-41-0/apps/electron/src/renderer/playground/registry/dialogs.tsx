/* UB14.36 (R6-07) — the shipped upstream dialogs and the inline colour row on v0.15.1's button vocabulary: Cancel is
   the ghost, the forward action is the primary with an aria-hidden Enter keycap, the irreversible Reset is
   danger-solid. Ours: v0.15.1 ships no playground entry for any of them, so each entry mounts the SHIPPED component
   (never a mock-up beside it), and every state is swept in dark by `../__tests__/dialogs-registry.test.ts`. Every
   dialog is forced open, as `primitives-dialog` is; the `ModalProvider` their `useRegisterModal` needs is the one
   `PlaygroundEntryFrame` mounts for every entry (F1.281). Not here: `ColorPicker`'s swatches live in a closed popover
   it exposes no `open` for, and `CompactWorkingDirectorySelector`'s rows in a drawer whose state is its own, so both
   are pinned at the source by `components/ui/__tests__/dialog-buttons.test.tsx` instead. */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { ResetConfirmationDialog } from '@/components/ResetConfirmationDialog'
import { CreateProjectDialog } from '@/components/projects/CreateProjectDialog'
import { InlineColorPickerRow } from '@/components/ui/inline-color-picker-row'
import { PROJECT_COLOR_PALETTE } from '@/utils/project-colors'

/** The palette's first swatch (indigo), what a new project row opens with. */
const FIRST_PRESET = PROJECT_COLOR_PALETTE[0] ?? '#6366f1'

const log = (what: string) => () => console.log(`[Playground] ${what}`)

function RenameDialogPreview({ open = true, title = 'Rename session', value = '' }: { open?: boolean; title?: string; value?: string }) {
  // The field is live: the knob seeds it, typing edits it, and Save follows `value.trim()` as on the session list.
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])
  return (
    <RenameDialog
      open={open}
      onOpenChange={log('RenameDialog onOpenChange')}
      title={title}
      value={draft}
      onValueChange={setDraft}
      onSubmit={log('RenameDialog submit')}
    />
  )
}

function ResetConfirmationDialogPreview({ open = true }: { open?: boolean }) {
  return <ResetConfirmationDialog open={open} onConfirm={log('ResetConfirmationDialog confirm')} onCancel={log('ResetConfirmationDialog cancel')} />
}

function CreateProjectDialogPreview({ open = true }: { open?: boolean }) {
  return <CreateProjectDialog open={open} onCancel={log('CreateProjectDialog cancel')} onSubmit={log('CreateProjectDialog submit')} />
}

function InlineColorPickerRowPreview({ value = FIRST_PRESET }: { value?: string }) {
  const { t } = useTranslation()
  const [color, setColor] = React.useState(value)
  React.useEffect(() => setColor(value), [value])
  // The labels ProjectInfoPage passes, so the row reads as it does on the project page.
  return (
    <div className="w-[360px]">
      <InlineColorPickerRow
        value={color}
        onChange={setColor}
        presets={PROJECT_COLOR_PALETTE}
        onClear={() => setColor('')}
        clearLabel={t('projectInfo.colorClear')}
        customAriaLabel={t('projectInfo.colorCustom')}
      />
    </div>
  )
}

const OPEN_PROP = { name: 'open', description: 'Force open', control: { type: 'boolean' as const }, defaultValue: true }

export const dialogComponents: ComponentEntry[] = [
  {
    id: 'rename-dialog',
    name: 'Rename dialog',
    category: 'Primitives',
    description: 'UB14.36 (v0.15.1 1:1): Cancel ghost, Save primary with an aria-hidden ↵ keycap (Enter in the field submits); Save is disabled for an empty or whitespace-only name.',
    component: RenameDialogPreview,
    props: [
      OPEN_PROP,
      { name: 'title', description: 'The dialog title', control: { type: 'string', placeholder: 'Rename session' }, defaultValue: 'Rename session' },
      { name: 'value', description: 'The name the field opens with', control: { type: 'string', placeholder: 'Quarterly planning notes' }, defaultValue: 'Quarterly planning notes' },
    ],
    variants: [
      { name: 'Empty name', description: 'Save is disabled', props: { value: '' } },
      { name: 'Whitespace only', description: 'Save is still disabled: the name is trimmed before it counts', props: { value: '   ' } },
    ],
  },
  {
    id: 'reset-confirmation-dialog',
    name: 'Reset confirmation dialog',
    category: 'Primitives',
    description: 'UB14.36 (v0.15.1 hunks): the irreversible Reset is danger-solid and stays disabled until the sum is answered; the backup note sits on the info tint; Cancel ghost.',
    component: ResetConfirmationDialogPreview,
    props: [OPEN_PROP],
  },
  {
    id: 'create-project-dialog',
    name: 'Create project dialog',
    category: 'Primitives',
    description: 'UB14.36 (v0.15.1 hunks): Cancel ghost, Create primary with an aria-hidden ↵ keycap; Create is disabled until the name has a non-space character.',
    component: CreateProjectDialogPreview,
    props: [OPEN_PROP],
  },
  {
    id: 'inline-color-picker-row',
    name: 'Inline colour row',
    category: 'Primitives',
    description: 'UB14.36 (v0.15.1 hunks): the project colour row; presets and the custom (rainbow) swatch transition scale and ring only. The indicator\'s label is ours (t(), UA12.119).',
    component: InlineColorPickerRowPreview,
    props: [
      {
        name: 'value',
        description: 'The colour the row opens with',
        control: {
          type: 'select',
          options: [
            { value: FIRST_PRESET, label: 'First preset' },
            { value: '#0EA5A4', label: 'A custom colour' },
            { value: '', label: 'No colour' },
          ],
        },
        defaultValue: FIRST_PRESET,
      },
    ],
    variants: [
      { name: 'No colour', description: 'The empty dashed indicator; Clear is absent', props: { value: '' } },
      { name: 'Custom colour', description: 'A colour off the palette', props: { value: '#0EA5A4' } },
    ],
  },
]
