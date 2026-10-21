import * as React from 'react'
import type { ComponentEntry } from './types'
import { buildBootFatalDialog } from '../../../shared/boot-fatal-dialog'
import { buildStorageReadinessDialog } from '../../../shared/storage-readiness-dialog'

// =============================================================================
// The two other startup dialogs (P6.741)
//
// P6.725 gave the broken-`config.json` dialog a playground entry. Its two
// neighbours — the boot-fatal refusal (`main/boot-fatal.ts`) and the storage-
// readiness block (`main/storage-readiness-ui.ts`) — each carried a local en/ru
// copy table and neither was reachable from here, so their copy had no runnable
// evidence at all.
//
// Both are surfaces a reviewer cannot reach on purpose: one needs a startup that
// has already failed, the other needs storage that cannot be made ready, and in
// both cases there is no window and no renderer in which to open a playground.
// Both are NATIVE OS dialogs, built in the main process from a local table
// because they run before user-owned configuration — and therefore the persisted
// UI language — can be read; they follow the OS locale instead, which is why
// each entry has a language knob rather than inheriting the app's.
//
// What is rendered here is each dialog's own OPTIONS OBJECT, from the same
// builder the real dialog is built from. A hand-copied mock-up beside the real
// copy is exactly how the two drift, and copy is the only thing these entries
// exist to review. The OS draws the frame.
// =============================================================================

const CONFIG_DIR = '/Users/dev/.nessy-agent'

/**
 * The shared chrome. Deliberately one component for both entries: the two
 * dialogs differ in their copy and their button count, which is the whole point
 * of reviewing them side by side, and a second preview shell would let the two
 * previews diverge in ways the real dialogs do not.
 */
function DialogPreview({
  options,
  note,
}: {
  options: {
    title: string
    message: string
    detail: string
    buttons: string[]
    defaultId: number
    cancelId: number
  }
  note: string
}) {
  return (
    <div className="max-w-xl rounded-xl border border-border bg-card p-5 text-sm">
      <div className="text-base font-semibold">{options.title}</div>
      <div className="mt-2">{options.message}</div>
      <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        {options.detail}
      </pre>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {options.buttons.map((label, index) => (
          <span
            key={label}
            className={
              index === options.defaultId
                ? 'rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground'
                : 'rounded-md border border-border px-3 py-1.5 text-xs'
            }
          >
            {label}
          </span>
        ))}
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {note} Cancelling picks “{options.buttons[options.cancelId]}”.
      </div>
    </div>
  )
}

const BOOT_FAILURES = {
  'storage-layout': {
    name: 'UnsupportedStorageLayoutError',
    message:
      'The configuration directory uses a storage layout this build does not support. '
      + 'Nessy did not modify it.',
  },
  'lease-held': {
    name: 'Error',
    message: 'Another Nessy instance holds the host lease for this configuration directory.',
  },
  'non-error': {
    // The path a thrown non-Error takes: `describeBootFatalError` labels it
    // `Error` and stringifies it, so the dialog still names something.
    name: 'Error',
    message: 'undefined is not an object (evaluating \'runtime.start\')',
  },
} as const

type BootFailureKind = keyof typeof BOOT_FAILURES

function BootFatalDialogPreview({
  failure = 'storage-layout',
  locale = 'en',
}: {
  failure?: BootFailureKind
  locale?: string
}) {
  const options = buildBootFatalDialog(
    { configDir: CONFIG_DIR, described: BOOT_FAILURES[failure] },
    locale,
    new Date('2026-09-08T09:00:00.000Z'),
  )
  return (
    <DialogPreview
      options={options}
      note="One button, because there is nothing to decide: this failure has no repair to offer, and a button that cannot help is worse than none."
    />
  )
}

// The codes are `StorageReadinessBlockedCode` members. The allowlist that
// narrows an arbitrary value to one of them stays in `main/`, beside the check
// that produces them — these are three of its outputs, chosen because they are
// the three a user meets for different reasons.
const BLOCKED_CODES = ['unsafe-root', 'corrupt-v2', 'sharing-violation'] as const

type BlockedCode = typeof BLOCKED_CODES[number]

function StorageReadinessDialogPreview({
  code = 'unsafe-root',
  locale = 'en',
}: {
  code?: BlockedCode
  locale?: string
}) {
  const options = buildStorageReadinessDialog({ code, diagnostics: CONFIG_DIR }, locale)
  return (
    <DialogPreview
      options={options}
      note="Three buttons, because this one CAN be retried: the block may clear while the dialog is up, and Open diagnostics returns to this same dialog rather than ending anything."
    />
  )
}

const LOCALE_PROP = {
  name: 'locale',
  description: 'These dialogs read the OS locale, not the persisted UI language — see the module header',
  control: {
    type: 'select' as const,
    options: [
      { value: 'en', label: 'English' },
      { value: 'ru-RU', label: 'Русский' },
    ],
  },
  defaultValue: 'en',
}

export const startupDialogComponents: ComponentEntry[] = [
  {
    id: 'boot-fatal-dialog',
    name: 'Startup failure dialog',
    category: 'Settings',
    description:
      'P6.741: the refusal shown when startup cannot continue — no window, no services, one Quit. Built from the same function the real dialog is built from.',
    component: BootFatalDialogPreview,
    layout: 'top',
    props: [
      {
        name: 'failure',
        description: 'Which startup failure the user met',
        control: {
          type: 'select',
          options: [
            { value: 'storage-layout', label: 'An unsupported storage layout' },
            { value: 'lease-held', label: 'Another instance holds the host lease' },
            { value: 'non-error', label: 'A thrown value that is not an Error' },
          ],
        },
        defaultValue: 'storage-layout',
      },
      LOCALE_PROP,
    ],
  },
  {
    id: 'storage-readiness-dialog',
    name: 'Storage unavailable dialog',
    category: 'Settings',
    description:
      'P6.741: the block shown when storage cannot be made ready — Retry, Open diagnostics, Quit. Built from the same function the real dialog is built from.',
    component: StorageReadinessDialogPreview,
    layout: 'top',
    props: [
      {
        name: 'code',
        description: 'Which readiness block the user met',
        control: {
          type: 'select',
          options: [
            { value: 'unsafe-root', label: 'The configuration root is unsafe' },
            { value: 'corrupt-v2', label: 'The v2 store is corrupt' },
            { value: 'sharing-violation', label: 'Another process holds the store' },
          ],
        },
        defaultValue: 'unsafe-root',
      },
      LOCALE_PROP,
    ],
  },
]
