import * as React from 'react'
import type { ComponentEntry } from './types'
import { buildBrokenConfigDialog } from '../../../shared/broken-config-dialog'

// =============================================================================
// The broken-`config.json` dialog (P6.725)
//
// This is the one startup surface a reviewer can never reach on purpose: it
// needs a `config.json` the app refuses to load, at which point there is no
// window, no renderer and no way to open a playground. It is also a NATIVE OS
// dialog, built in the main process from a local en/ru table — the same reason
// `boot-fatal.ts` and `storage-readiness-ui.ts` carry their own copy: it runs
// before user-owned configuration, and therefore the persisted UI language, can
// be read.
//
// So what is rendered here is the dialog's own OPTIONS OBJECT, produced by the
// same `buildBrokenConfigDialog` the dialog is built from — never a hand-copied
// mock-up of it. The playground is where this product's copy is reviewed, and a
// second copy of these three sentences beside the real one is exactly how the
// two drift. What a reviewer is looking at here is the wording and the button
// order; the OS draws the frame.
//
// The states are the two languages and the two failure shapes a user actually
// meets: a file that is not JSON at all, and a file that parses but declares a
// storage layout this build refuses.
// =============================================================================

const CONFIG_FILE = '/Users/dev/.nessy-agent/config.json'

const PROBLEMS = {
  'not-json':
    'UnsupportedStorageLayoutError: config.json exists but is not valid JSON — refusing to load or '
    + `overwrite it: Unexpected token t in JSON at position 2. The refused file is ${CONFIG_FILE}. `
    + 'Nessy did not modify it: repair the file by hand, or move it aside to start from the default '
    + 'configuration.',
  'legacy-layout':
    'UnsupportedStorageLayoutError: config.json has storageLayoutVersion 1, but this build only supports '
    + `v2. Refusing to load or overwrite a legacy config. The refused file is ${CONFIG_FILE}. Nessy did `
    + 'not modify it: repair the file by hand, or move it aside to start from the default configuration.',
} as const

type ProblemKind = keyof typeof PROBLEMS

function BrokenConfigDialogPreview({
  problem = 'not-json',
  locale = 'en',
}: {
  problem?: ProblemKind
  locale?: string
}) {
  // A fixed instant, so the `.broken-<timestamp>` name in the detail does not
  // change under a reviewer between renders.
  const options = buildBrokenConfigDialog(
    { configFile: CONFIG_FILE },
    PROBLEMS[problem],
    locale,
    new Date('2026-09-07T18:30:00.000Z'),
  )

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
        The OS draws this frame; only the copy and the button order are ours. Cancelling picks
        “{options.buttons[options.cancelId]}”, never the middle button.
      </div>
    </div>
  )
}

export const brokenConfigDialogComponents: ComponentEntry[] = [
  {
    id: 'broken-config-dialog',
    name: 'Broken configuration dialog',
    category: 'Settings',
    description:
      'P6.725: the two ways out of a `config.json` the app refuses to load — open it, or rename it to `config.json.broken-<timestamp>` and quit. No reset, nothing erased. Built from the same function the real dialog is built from.',
    component: BrokenConfigDialogPreview,
    layout: 'top',
    props: [
      {
        name: 'problem',
        description: 'Which refusal the user met',
        control: {
          type: 'select',
          options: [
            { value: 'not-json', label: 'The file is not JSON at all' },
            { value: 'legacy-layout', label: 'A storage layout this build refuses' },
          ],
        },
        defaultValue: 'not-json',
      },
      {
        name: 'locale',
        description: 'The dialog reads the OS locale, not the persisted UI language — see the module header',
        control: {
          type: 'select',
          options: [
            { value: 'en', label: 'English' },
            { value: 'ru-RU', label: 'Русский' },
          ],
        },
        defaultValue: 'en',
      },
    ],
  },
]
