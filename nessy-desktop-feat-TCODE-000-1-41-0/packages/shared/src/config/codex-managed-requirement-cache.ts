/**
 * P3.261 — the last ANSWERED codex `in_app_updates` requirement, on disk.
 *
 * ## The defect
 *
 * `recordCodexInAppUpdatesRequirement` writes a MODULE-SCOPE tier, so it can
 * only ever be armed once the first codex runtime of the process has started.
 * `checkForUpdatesOnLaunch()` runs before that. **On a codex-only fleet the
 * launch update check therefore runs UNGATED at every boot** — an organisation
 * running codex alone gets a weaker guarantee than a mixed fleet, which inverts
 * what an operator would assume. `codex-agent.ts` named this in a comment and
 * could not close it from its own file.
 *
 * ## Why this module exists rather than a field on the tier module
 *
 * `config/managed-in-app-updates.ts` is deliberately import-free — its own
 * header says a transitive `node:` import through the `config` barrel breaks the
 * Vite renderer build. Persistence needs `node:fs`. So the cache is its own
 * module, it is NOT added to the `config` barrel, and the tier module stays
 * exactly as it was.
 *
 * ## The rule that carries over unchanged, and must not be relaxed
 *
 * **ONLY AN ANSWERED REQUIREMENT MAY WRITE.** P2.137 is the row where the
 * distinction was measured to matter: `inAppUpdatesDisabled` is `undefined` for
 * `status:'failed'` (a transport hiccup, a timeout) exactly as it is for
 * `status:'none'` (the server answered and reported nothing), and treating those
 * as one meant a single failed probe re-opened an update channel an
 * administrator had closed. So the caller writes inside its own
 * `requirementAnswered` guard, and the two ANSWERS are stored distinguishably:
 * a boolean is a requirement, `null` is "the server answered and asked for
 * nothing" — which must CLEAR the tier on restore, because an administrator
 * withdrawing the requirement has to take effect too.
 *
 * A non-answer writes nothing at all, so the last known value stands, which is
 * the same conservative direction the in-memory tier already takes.
 *
 * ## What is deliberately NOT cached
 *
 * The in-app-BROWSER requirement. It shares the lateness and not the
 * consequence: its subscriber closes a pane that is already open, so a window
 * opened before the first codex runtime is retracted rather than left running
 * (the reason P2.399 built it that way, recorded at the write site). An update
 * already installed cannot be retracted, which is what makes the update tier the
 * one worth persisting. Caching both would be more symmetric and would buy
 * nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './paths.ts'
import { recordCodexInAppUpdatesRequirement } from './managed-in-app-updates.ts'

/** The cache file, beside the app's other config. */
export const CODEX_MANAGED_REQUIREMENT_CACHE_FILE = 'codex-managed-requirements.json'

/**
 * The stored shape. Versioned because it is read by a DIFFERENT process
 * generation than the one that wrote it — that is the whole point of the file —
 * and an unrecognised version must be ignored rather than guessed at.
 */
export interface CodexManagedRequirementCacheV1 {
  v: 1
  /** `true`/`false` — the answered requirement. `null` — answered, no requirement. */
  inAppUpdatesDisabled: boolean | null
}

function cachePath(configDir: string): string {
  return join(configDir, CODEX_MANAGED_REQUIREMENT_CACHE_FILE)
}

/**
 * Store an ANSWERED reading. Call ONLY from inside the caller's own
 * answered-status guard — this function cannot tell an answer from a failure,
 * and that is the distinction P2.137 exists for.
 *
 * Best-effort: a write failure leaves the previous file standing and is
 * reported to the caller as `false` rather than thrown. A cache that cannot be
 * written must never stop a runtime from starting.
 */
export function persistCodexInAppUpdatesRequirement(
  disabled: boolean | undefined,
  configDir: string = CONFIG_DIR,
): boolean {
  const payload: CodexManagedRequirementCacheV1 = {
    v: 1,
    inAppUpdatesDisabled: typeof disabled === 'boolean' ? disabled : null,
  }
  try {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(cachePath(configDir), `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Read the cache without applying it. Returns `undefined` when there is nothing
 * usable — absent file, unreadable, unparseable, wrong version, or a field of
 * the wrong type. Every one of those is "we do not know", never "there is no
 * requirement": the two are different facts and only one of them may clear a
 * deployed policy.
 */
export function readCodexInAppUpdatesRequirementCache(
  configDir: string = CONFIG_DIR,
): CodexManagedRequirementCacheV1 | undefined {
  let raw: string
  try {
    raw = readFileSync(cachePath(configDir), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexManagedRequirementCacheV1> | null
    if (!parsed || parsed.v !== 1) return undefined
    const value = parsed.inAppUpdatesDisabled
    if (typeof value !== 'boolean' && value !== null) return undefined
    return { v: 1, inAppUpdatesDisabled: value }
  } catch {
    return undefined
  }
}

/**
 * Apply the cached requirement to the codex tier, and say whether it did.
 *
 * THIS IS THE READER THAT MAKES THE WRITE ABOVE A MECHANISM RATHER THAN A DEAD
 * FILE — persistence with nothing reading it reproduces, in mirror image, the
 * exact defect this row is about (a codex tier that nothing ever writes). It
 * must be called at host bootstrap BEFORE the launch update check and before
 * `registerEnforcedManagedInAppUpdatesProvider()`; composition is unchanged
 * (tightest wins), so a live codex runtime answering later simply overwrites it
 * with a fresher answer.
 *
 * Returns `true` when a cached ANSWER was applied — including the answered
 * "no requirement", which clears the tier so a withdrawn policy takes effect.
 */
export function restoreCodexInAppUpdatesRequirement(configDir: string = CONFIG_DIR): boolean {
  const cached = readCodexInAppUpdatesRequirementCache(configDir)
  if (!cached) return false
  recordCodexInAppUpdatesRequirement(
    cached.inAppUpdatesDisabled === null ? undefined : cached.inAppUpdatesDisabled,
  )
  return true
}

/**
 * F1.101 (origin D1.419, D1.409's named residue) — the managed LOCAL-AUTOMATION
 * tier, persisted beside the in-app-updates one and for the mirror of its reason.
 *
 * `recordCodexLocalAutomationRequirement` writes a module-scope tier that only the
 * codex probe writes, so in a process where no codex runtime starts — a Pi-only or
 * claude-only launch — schedulers an administrator forbade ran ungated and
 * unreported. D1.409 refused to reuse this module for one measured reason: the
 * updates reader ran from the ELECTRON bootstrap only. The local-automation reader
 * is instead called from `bootstrapServer`'s config-artifacts step
 * (`server-core/src/bootstrap/headless-start.ts`), which BOTH hosts run ahead of
 * the session manager that builds the schedulers.
 *
 * A file of its OWN rather than a second field in the updates file: two writers
 * of one file would need a read-modify-write, and an interleaving of the two
 * would lose an answer. The rules are the twin's, unchanged — only an ANSWERED
 * requirement is written (the caller's `requirementAnswered` guard), `null` is
 * "answered, no requirement" and CLEARS the tier on restore, and anything
 * unreadable is "we do not know" and leaves it alone.
 */
export const CODEX_MANAGED_LOCAL_AUTOMATION_CACHE_FILE = 'codex-managed-local-automation.json'

/** The stored shape; versioned for the twin's reason. */
export interface CodexManagedLocalAutomationCacheV1 {
  v: 1
  /** `true`/`false` — the answered requirement. `null` — answered, no requirement. */
  localAutomationDisabled: boolean | null
}

/** Store an ANSWERED reading; best-effort, `false` on failure, never throws. */
export function persistCodexLocalAutomationRequirement(
  disabled: boolean | undefined,
  configDir: string = CONFIG_DIR,
): boolean {
  const payload: CodexManagedLocalAutomationCacheV1 = {
    v: 1,
    localAutomationDisabled: typeof disabled === 'boolean' ? disabled : null,
  }
  try {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, CODEX_MANAGED_LOCAL_AUTOMATION_CACHE_FILE), `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Apply the cached tier, and say whether it did. `false` for an absent,
 * unreadable, unparseable, mis-versioned or mistyped file — the tier is then left
 * exactly as it was.
 */
export function restoreCodexLocalAutomationRequirement(configDir: string = CONFIG_DIR): boolean {
  let parsed: Partial<CodexManagedLocalAutomationCacheV1> | null
  try {
    parsed = JSON.parse(readFileSync(join(configDir, CODEX_MANAGED_LOCAL_AUTOMATION_CACHE_FILE), 'utf8'))
  } catch {
    return false
  }
  if (!parsed || parsed.v !== 1) return false
  const value = parsed.localAutomationDisabled
  if (typeof value !== 'boolean' && value !== null) return false
  recordCodexLocalAutomationRequirement(value === null ? undefined : value)
  return true
}

/**
 * The codex probe's one call: record the answered tier in this process AND
 * persist it for the next one. Called ONLY inside `CodexAgent`'s
 * `requirementAnswered` guard — P2.137's rule. A persist failure leaves the
 * in-memory tier applied and the previous file standing.
 */
export function recordAndPersistCodexLocalAutomationRequirement(
  disabled: boolean | undefined,
  configDir: string = CONFIG_DIR,
): boolean {
  recordCodexLocalAutomationRequirement(disabled)
  return persistCodexLocalAutomationRequirement(disabled, configDir)
}

// F1.101 — imported at the end so every line above keeps its place.
import { recordCodexLocalAutomationRequirement } from './managed-local-automation.ts'

/**
 * F1.514 (origin WJ-ag P-WJ-ag-1; DECIDED by the controller 2026-09-24) — the
 * administrator's `allowed_approvals_reviewers`, as the last ANSWERED codex
 * `configRequirements/read` reported it, remembered in this file's F1.101 shape.
 *
 * Why it has to be remembered at all: codex asks its hooks BEFORE its reviewer
 * (`core/src/tools/approvals.rs`, "1. Hooks 2. … Guardian"), so F1.386's
 * unattended-automation floor is a `PermissionRequest` hook written into
 * `config.toml` — which codex reads when the app-server STARTS — and the list is
 * readable only once it is up. With the Settings toggle off and a list that
 * leaves out `user`, codex's reviewer answers anyway (measured on the shipped
 * 0.154.0 through its own MDM reader, `work/wjag/`, `work/wjan/`), and a runtime
 * build that decided from the written config alone projected no hook: the
 * reviewer approved a floored `automation_update` and the edit landed, in the
 * first session AND in the next. So the list is recorded here by every answered
 * read and read by the NEXT runtime build
 * (`CodexAgent.unattendedAutomationFloorHookProjection`).
 *
 * The rules are the twins', unchanged: only an ANSWERED read writes (the caller
 * records inside the resolved arm of its requirements channel, never on a
 * rejection); an answered read with no list is `null` and CLEARS the tier and the
 * file, so a withdrawn policy stops projecting the hook; anything unreadable is
 * "we do not know" and leaves the tier alone. A file of its own, for the twins'
 * reason (two writers of one file would need a read-modify-write). Kept here
 * rather than in an import-free tier module: its only reader is the codex agent,
 * which is never in the renderer's graph.
 */
export const CODEX_MANAGED_APPROVALS_REVIEWERS_CACHE_FILE = 'codex-managed-approvals-reviewers.json'

/** A reviewer as this host spells it (`codexManagedApprovalsReviewers` normalises codex's spellings). */
export type CodexManagedApprovalsReviewer = 'user' | 'auto_review'

/** The stored shape; versioned for the twins' reason. */
export interface CodexManagedApprovalsReviewersCacheV1 {
  v: 1
  /** The answered list, or `null` — answered, no list. */
  allowedApprovalsReviewers: CodexManagedApprovalsReviewer[] | null
}

/** The in-process tier: the list, or `undefined` when none is known or none is required. */
let managedApprovalsReviewersTier: readonly CodexManagedApprovalsReviewer[] | undefined

/** The remembered list, or `undefined` when none is known or the last answer carried none. */
export function getCodexManagedApprovalsReviewers(): readonly CodexManagedApprovalsReviewer[] | undefined {
  return managedApprovalsReviewersTier
}

/**
 * Record an ANSWERED list in this process and persist it for the next one;
 * `undefined` records "answered, no list" and clears both. Best-effort on disk:
 * `false` on a write failure, which leaves the in-process tier applied and the
 * previous file standing; never throws.
 */
export function recordAndPersistCodexManagedApprovalsReviewers(
  list: readonly CodexManagedApprovalsReviewer[] | undefined,
  configDir: string = CONFIG_DIR,
): boolean {
  managedApprovalsReviewersTier = list && list.length > 0 ? [...list] : undefined
  const payload: CodexManagedApprovalsReviewersCacheV1 = {
    v: 1,
    allowedApprovalsReviewers: managedApprovalsReviewersTier ? [...managedApprovalsReviewersTier] : null,
  }
  try {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, CODEX_MANAGED_APPROVALS_REVIEWERS_CACHE_FILE), `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Apply the cached list, and say whether it did — called by `bootstrapServer`'s
 * config-artifacts step on BOTH hosts, beside the F1.101 twin. `false` for an
 * absent, unreadable, unparseable, mis-versioned or mistyped file (an entry that
 * is not a reviewer included) — the tier is then left exactly as it was.
 */
export function restoreCodexManagedApprovalsReviewers(configDir: string = CONFIG_DIR): boolean {
  let parsed: Partial<CodexManagedApprovalsReviewersCacheV1> | null
  try {
    parsed = JSON.parse(readFileSync(join(configDir, CODEX_MANAGED_APPROVALS_REVIEWERS_CACHE_FILE), 'utf8'))
  } catch {
    return false
  }
  if (!parsed || parsed.v !== 1) return false
  const value = parsed.allowedApprovalsReviewers
  if (value === null) {
    managedApprovalsReviewersTier = undefined
    return true
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(entry => entry === 'user' || entry === 'auto_review')) return false
  managedApprovalsReviewersTier = [...value]
  return true
}
