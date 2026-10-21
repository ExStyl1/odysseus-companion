/**
 * P6.536 — the process-wide holder for the per-origin browser trust store.
 *
 * The DECISIONS live in `@nessy-agent/shared/config/browser-origin-trust`,
 * which is pure and has no imports; this file is only where they are kept, read
 * from disk and written back. Splitting it that way is what lets the whole rule
 * set be asserted on values under `bun test` while the electron half stays a
 * thin holder — the same containment the renderer's pure modules use.
 *
 * ## Where it is stored, and why not in the managed policy
 *
 * `<config dir>/browser-origin-trust.json`, beside the app's other state. This
 * is a USER's record of what they approved, not an operator's policy: the
 * operator half is the managed CDP lock (`isBrowserCdpManagedDisabled`) and,
 * separately, P6.338's managed navigation allowlist. Mixing a person's answers
 * into a document an administrator deploys would make one of the two
 * unmaintainable.
 *
 * ## Two lifetimes in one holder
 *
 * The persisted verdicts survive a restart. The `allow-once` grants live in
 * {@link sessionGrants} and die with the process — which is the only shape in
 * which "once" cannot decay into "always" — and the same set answers the row's
 * *"which origins did this session touch"*, together with the persisted
 * `lastSeenAt`.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import {
  EMPTY_BROWSER_ORIGIN_TRUST,
  applyBrowserTrustDecision,
  browserTrustOriginOf,
  listBrowserOriginTrust,
  noteBrowserOriginSeen,
  normalizeBrowserOriginTrust,
  resolveBrowserTrust,
  revokeBrowserOriginTrust,
  sessionGrantKey,
  type BrowserOriginTrustStateV1,
  type BrowserTrustDecision,
  type BrowserTrustGate,
  type BrowserTrustListEntry,
  type BrowserTrustVerdict,
} from '@nessy-agent/shared/config/browser-origin-trust'
import { mainLog } from './logger'

/**
 * `let` for one reason: {@link resetBrowserTrustForTests} redirects it. A suite
 * that exercised the DENY path against the real config directory would write a
 * verdict into the developer's own browser trust file, which is a test that
 * changes the machine it runs on.
 */
let trustFile = join(CONFIG_DIR, 'browser-origin-trust.json')

let state: BrowserOriginTrustStateV1 = EMPTY_BROWSER_ORIGIN_TRUST
let loaded = false

/** Origins allowed for this process only, keyed by `<gate>:<origin>`. */
const sessionGrants = new Set<string>()

/** Every origin the pane actually loaded this run, in first-seen order. */
const originsSeenThisSession = new Set<string>()

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    state = normalizeBrowserOriginTrust(JSON.parse(readFileSync(trustFile, 'utf-8')))
  } catch (err) {
    // A missing file is the ordinary first run. A corrupt one costs the user a
    // prompt, never a silent grant — `normalizeBrowserOriginTrust` drops what it
    // cannot read and everything unknown resolves to `ask`.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      mainLog.warn(`[browser-trust] could not read ${trustFile}, starting from empty: ${String(err)}`)
    }
    state = EMPTY_BROWSER_ORIGIN_TRUST
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(trustFile), { recursive: true })
    const tmp = `${trustFile}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    try { unlinkSync(trustFile) } catch { /* absent on first write, and Windows rename needs it gone */ }
    renameSync(tmp, trustFile)
  } catch (err) {
    // A trust decision that cannot be written still HOLDS for this process — the
    // in-memory state is already updated — so the user is not asked twice in one
    // run. It is the persistence that failed, and saying so is better than
    // pretending the click did nothing.
    mainLog.warn(`[browser-trust] could not persist ${trustFile}: ${String(err)}`)
  }
}

/** What a gate should do about this URL. `undefined` origin means never ask. */
export function browserTrustDecisionFor(url: string, gate: BrowserTrustGate): {
  origin: string | undefined
  decision: BrowserTrustDecision
} {
  const origin = browserTrustOriginOf(url)
  if (!origin) return { origin: undefined, decision: 'allow' }
  ensureLoaded()
  return { origin, decision: resolveBrowserTrust(state, sessionGrants, origin, gate) }
}

/** Record a person's answer from the card. */
export function recordBrowserTrustDecision(
  origin: string,
  gate: BrowserTrustGate,
  verdict: BrowserTrustVerdict,
): void {
  ensureLoaded()
  const applied = applyBrowserTrustDecision(state, origin, gate, verdict)
  state = applied.state
  if (applied.sessionGrant) sessionGrants.add(applied.sessionGrant)
  if (applied.persisted) persist()
  mainLog.info(`[browser-trust] ${gate} ${verdict} for ${origin}`)
}

/** Note that the pane actually loaded this origin. */
export function noteBrowserOriginVisited(url: string): void {
  const origin = browserTrustOriginOf(url)
  if (!origin) return
  ensureLoaded()
  originsSeenThisSession.add(origin)
  const applied = noteBrowserOriginSeen(state, origin)
  state = applied.state
  if (applied.persisted) persist()
}

/** The row's *"which origins did this session touch"*. */
export function browserOriginsSeenThisSession(): string[] {
  return [...originsSeenThisSession]
}

/** The settings list. */
export function listBrowserTrust(): BrowserTrustListEntry[] {
  ensureLoaded()
  return listBrowserOriginTrust(state)
}

/**
 * Revoke one origin — back to `ask` on both gates, and the session grant with
 * it. Revoking that left an allow-once behind would leave the user's click
 * doing nothing until they restarted.
 */
export function revokeBrowserTrust(origin: string): void {
  ensureLoaded()
  state = revokeBrowserOriginTrust(state, origin)
  sessionGrants.delete(sessionGrantKey(origin, 'navigation'))
  sessionGrants.delete(sessionGrantKey(origin, 'cdp'))
  persist()
  mainLog.info(`[browser-trust] revoked ${origin}`)
}

/**
 * Test seam: forget everything held in this process, and optionally write
 * somewhere other than the real config directory.
 *
 * `loaded = true` is the important half — it means no suite ever reads the
 * developer's own trust file, so a test cannot pass because of a decision they
 * made in the app yesterday.
 */
export function resetBrowserTrustForTests(file?: string): void {
  state = EMPTY_BROWSER_ORIGIN_TRUST
  loaded = true
  sessionGrants.clear()
  originsSeenThisSession.clear()
  if (file) trustFile = file
}
