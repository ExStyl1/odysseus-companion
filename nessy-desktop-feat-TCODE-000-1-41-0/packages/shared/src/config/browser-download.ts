/**
 * P6.360 + P6.564 — where a browser-pane download lands, and who chooses.
 *
 * ## What was already true, and is deliberately kept
 *
 * `BrowserPaneManager`'s `will-download` handler is not Electron's default: it
 * resolves a deterministic, session-scoped directory, de-duplicates the
 * filename, calls `item.setSavePath` — which SUPPRESSES the native save dialog
 * on purpose — and logs the result. That policy is good for an agent-driven
 * pane, where a modal dialog per download would stop the run. What it never had
 * is a way for the person using the app to say otherwise.
 *
 * ## Native mechanism, asked and answered
 *
 * One host pane serves all three runtimes, so this is a step-2 row: the host
 * supplies it once and nothing differs at a switch. Inside the host the
 * ask-each-time half IS Electron's own mechanism — leaving `setSavePath` unset
 * makes Electron raise its own save dialog, seeded through
 * `item.setSaveDialogOptions` — so nothing is re-implemented beside it.
 *
 * ## Why this module lives in `shared/config` (P6.564)
 *
 * P6.360 put it in `apps/electron/src/main`, because the main process was the
 * only reader. P6.564 adds a second one: the settings RPC handler in
 * `server-core` must answer "is an environment variable overriding what I
 * typed?", and that question cannot be answered without these two NAMES. A
 * second copy of the names in the handler is exactly the drift this repository
 * has paid for before, so the module moved instead.
 *
 * ## The layer order, and why the environment wins
 *
 * Environment, then `config.json`, then the session-scoped default. The
 * environment is how an operator constrains a machine they do not sit at, and a
 * user setting must not be able to escape it — the same direction every managed
 * setting in this tree takes. A variable that is SET decides its field even
 * when its VALUE is unusable: falling through to the file in that case would
 * mean an operator's typo silently hands the choice back to the user.
 *
 * The resolver stays pure — both layers are arguments, neither is read here —
 * so the same function answers for the live process, for the settings form and
 * for a test, and cannot disagree with itself. In Bun 1.3.14 assigning to
 * `process.env` leaves the name invisible to a spread, so a test that had to
 * mutate the environment would be measuring the wrong thing anyway.
 *
 * ## Total, and silent only when it has nothing to say
 *
 * Every malformed value degrades to today's behaviour and REPORTS itself — an
 * ignored setting that says nothing is indistinguishable from a defect. The
 * unset state produces no problems and no change at all.
 */

import { isAbsolute } from 'path'
import { parseBooleanEnv } from '../feature-flags.ts'

/** Absolute directory every browser download is written into. */
export const BROWSER_DOWNLOAD_ROOT_ENV = 'NESSY_BROWSER_DOWNLOAD_DIR'

/** `1`/`true`/`yes`/`on` to raise Electron's own save dialog per download. */
export const BROWSER_DOWNLOAD_ASK_ENV = 'NESSY_BROWSER_DOWNLOAD_ASK'

/** The `browserDownload` block of `config.json`, already type-checked. */
export interface StoredBrowserDownloadSettings {
  readonly root?: string
  readonly ask?: boolean
}

export interface BrowserDownloadPolicy {
  /** The resolved download root, or `undefined` for the session-scoped default. */
  readonly root: string | undefined
  /** Ask the user per download instead of saving automatically. */
  readonly ask: boolean
  /**
   * Which layer DECIDED each field: `'env'` when the variable was set — even if
   * its value could not be used — `'config'` when the stored block supplied it,
   * `undefined` when neither did. The settings form reads these to say when an
   * operator's environment is overriding what the user typed, rather than
   * letting the field look accepted and do nothing.
   */
  readonly rootLayer: 'env' | 'config' | undefined
  readonly askLayer: 'env' | 'config' | undefined
  /** One sentence per value that was set and could not be used. */
  readonly problems: readonly string[]
}

/** Today's behaviour, byte for byte: no root, no dialog, nothing to report. */
const DEFAULT_POLICY: BrowserDownloadPolicy = Object.freeze({
  root: undefined,
  ask: false,
  rootLayer: undefined,
  askLayer: undefined,
  problems: Object.freeze([]),
})

const NO_STORED_SETTINGS: StoredBrowserDownloadSettings = Object.freeze({})

export function resolveBrowserDownloadPolicy(
  env: Record<string, string | undefined> = process.env,
  stored: StoredBrowserDownloadSettings = NO_STORED_SETTINGS,
): BrowserDownloadPolicy {
  const envRoot = (env[BROWSER_DOWNLOAD_ROOT_ENV] ?? '').trim()
  const envAsk = (env[BROWSER_DOWNLOAD_ASK_ENV] ?? '').trim()
  const storedRoot = (typeof stored.root === 'string' ? stored.root : '').trim()
  const storedAsk = stored.ask === true
  if (envRoot.length === 0 && envAsk.length === 0 && storedRoot.length === 0 && !storedAsk) {
    return DEFAULT_POLICY
  }

  const problems: string[] = []
  let root: string | undefined
  let rootLayer: 'env' | 'config' | undefined
  // A relative root would resolve against the main process's cwd, which is not
  // a place the user can point at — refuse it by name rather than silently
  // writing somewhere neither of us meant.
  if (envRoot.length > 0) {
    rootLayer = 'env'
    if (isAbsolute(envRoot)) root = envRoot
    else {
      problems.push(
        `${BROWSER_DOWNLOAD_ROOT_ENV}=${JSON.stringify(envRoot)} is not an absolute path — `
        + 'ignored; downloads keep the session-scoped default',
      )
    }
  } else if (storedRoot.length > 0) {
    rootLayer = 'config'
    if (isAbsolute(storedRoot)) root = storedRoot
    else {
      problems.push(
        `config.json browserDownload.root=${JSON.stringify(storedRoot)} is not an absolute path — `
        + 'ignored; downloads keep the session-scoped default',
      )
    }
  }

  let ask = false
  let askLayer: 'env' | 'config' | undefined
  if (envAsk.length > 0) {
    askLayer = 'env'
    const parsed = parseBooleanEnv(envAsk)
    if (parsed === undefined) {
      problems.push(
        `${BROWSER_DOWNLOAD_ASK_ENV}=${JSON.stringify(envAsk)} is not a boolean — ignored; `
        + 'downloads are still saved without asking (use 1/true/yes/on or 0/false/no/off)',
      )
    } else ask = parsed
  } else if (storedAsk) {
    askLayer = 'config'
    ask = true
  }

  return Object.freeze({ root, ask, rootLayer, askLayer, problems: Object.freeze(problems) })
}

/**
 * What the settings form needs in one read: the stored value (so the field
 * shows what the USER set), the effective value, and whether the environment is
 * the layer in force. Without the last two a user could type a root, see it
 * saved, and have every download ignore it.
 */
export interface BrowserDownloadSettingsView {
  /** `config.json`'s own root, echoed back. Empty string when unset. */
  readonly root: string
  /** `config.json`'s own ask-each-time switch. */
  readonly ask: boolean
  /** The root actually in force, whichever layer supplied it. Empty when none. */
  readonly effectiveRoot: string
  /** The ask-each-time value actually in force. */
  readonly effectiveAsk: boolean
  /** The environment decides this field, so the stored one is not in force. */
  readonly rootFromEnv: boolean
  readonly askFromEnv: boolean
  /** One sentence per value that was set and could not be used. */
  readonly problems: readonly string[]
}

export function describeBrowserDownloadSettings(
  stored: StoredBrowserDownloadSettings,
  env: Record<string, string | undefined> = process.env,
): BrowserDownloadSettingsView {
  const policy = resolveBrowserDownloadPolicy(env, stored)
  return {
    root: stored.root ?? '',
    ask: stored.ask === true,
    effectiveRoot: policy.root ?? '',
    effectiveAsk: policy.ask,
    rootFromEnv: policy.rootLayer === 'env',
    askFromEnv: policy.askLayer === 'env',
    problems: policy.problems,
  }
}
