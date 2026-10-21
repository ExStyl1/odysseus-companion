import { basename, dirname, join, resolve } from 'node:path'
import type { StorageReadinessBlockedCode } from '@nessy-agent/shared/workspaces'
// P6.741 — the copy table and the options builder live beside the renderer, so
// the playground can render this dialog's wording; a renderer never imports from
// `main/`. The blocked-code allowlist and the diagnostics-path containment stay
// HERE: the second is a security boundary deciding what `shell.openPath` may be
// handed, and a boundary with two implementations has none.
import {
  buildStorageReadinessDialog,
  STORAGE_READINESS_DIAGNOSTICS_BUTTON,
  STORAGE_READINESS_RETRY_BUTTON,
  type StorageReadinessDialogOptions,
} from '../shared/storage-readiness-dialog'

export type { StorageReadinessDialogOptions }

const BLOCKED_CODES = new Set<StorageReadinessBlockedCode>([
  'host-lease-missing',
  'unsafe-root',
  'custom-root-reset-required',
  'invalid-marker',
  'path-collision',
  'corrupt-v2',
  'unsupported-version',
  'sharing-violation',
  'durability-failed',
])

const QUARANTINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i


export interface StorageReadinessUiDependencies {
  configDir: string
  dialog: {
    showMessageBox(options: StorageReadinessDialogOptions): Promise<{ response: number }>
  }
  shell: {
    openPath(path: string): Promise<string>
  }
  app: {
    getLocale(): string
    quit(): void
  }
}

export interface StorageReadinessBlockedInput {
  code: unknown
  diagnosticPath?: unknown
}

export type StorageReadinessBlockedAction = 'retry' | 'quit'

function safeCode(value: unknown): StorageReadinessBlockedCode | 'storage-readiness-blocked' {
  return typeof value === 'string' && BLOCKED_CODES.has(value as StorageReadinessBlockedCode)
    ? value as StorageReadinessBlockedCode
    : 'storage-readiness-blocked'
}

function markerPath(configDir: string): string {
  return join(dirname(configDir), `.${basename(configDir).replace(/^\./, '')}.cutover-v2.json`)
}

function safeDiagnosticPath(value: unknown, configDir: string): string {
  const root = resolve(configDir)
  if (typeof value !== 'string' || value.length > 4096) return root

  let candidate: string
  try {
    candidate = resolve(value)
  } catch {
    return root
  }

  if (candidate === root || candidate === markerPath(root)) return candidate
  if (dirname(candidate) !== dirname(root)) return root

  const quarantinePrefix = `${basename(root)}.legacy-v1.`
  const name = basename(candidate)
  return name.startsWith(quarantinePrefix) && QUARANTINE_ID.test(name.slice(quarantinePrefix.length))
    ? candidate
    : root
}

export async function showStorageReadinessBlockedDialog(
  blocked: StorageReadinessBlockedInput,
  deps: StorageReadinessUiDependencies,
): Promise<StorageReadinessBlockedAction> {
  const locale = (() => {
    try {
      return deps.app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en'
    } catch {
      return 'en'
    }
  })()
  const diagnostics = safeDiagnosticPath(blocked.diagnosticPath, deps.configDir)
  const options = buildStorageReadinessDialog(
    { code: safeCode(blocked.code), diagnostics },
    locale,
  )

  while (true) {
    let response: number
    try {
      response = (await deps.dialog.showMessageBox(options)).response
    } catch {
      deps.app.quit()
      return 'quit'
    }

    if (response === STORAGE_READINESS_RETRY_BUTTON) return 'retry'
    if (response === STORAGE_READINESS_DIAGNOSTICS_BUTTON) {
      try {
        await deps.shell.openPath(diagnostics)
      } catch {
        // Keep the process blocked and let the user retry or quit.
      }
      continue
    }

    deps.app.quit()
    return 'quit'
  }
}
