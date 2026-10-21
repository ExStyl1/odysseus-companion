/**
 * The age-based retention sweep.
 *
 * `claude-directory.md` § "Cleaned up automatically": the sweep "deletes session
 * files and other application data older than this period at startup". There is
 * no archive predicate in that sentence, and that omission is the point of this
 * module — our previous sweep (`deleteOldArchivedSessions`) only touched
 * ARCHIVED sessions, so raising the retention default to 30 days would still
 * have retained every unarchived transcript forever.
 *
 * ## This deletes user data, so the shape is deliberate
 *
 * The sweep is an ALLOWLIST. It walks named path classes and nothing else, so a
 * file nobody named survives by construction rather than by an exclusion list
 * somebody has to remember to extend. Every pass is dry-runnable and logs the
 * full removal set before removing anything.
 *
 * ## Path classes, mapped from the documented set to our layout
 *
 * | Documented                                     | Here                                              |
 * | ---------------------------------------------- | ------------------------------------------------- |
 * | `projects/<project>/<session>.jsonl`           | `sessions/<workspaceId>/<sessionId>/session.jsonl` |
 * | `projects/<project>/<session>/tool-results/`   | …`/long_responses/`                                |
 * | `file-history/<session>/`                      | …`/file_checkpoints/`                              |
 * | `plans/`                                       | …`/plans/`                                         |
 * | `debug/` and legacy `logs/`                    | `<configDir>/logs/` (contents only; dir kept)      |
 * | `feedback-bundles/`                            | `<configDir>/feedback/`                            |
 * | "contents and then the empty directory"        | `sessions/<workspaceId>/` once its last session goes |
 * | `projects/…` again, the vendor's OWN copy      | `workspaces/<workspaceId>/claude-config/projects/` — see below |
 * | `sessions/<session>`, the live-process markers | `sessions/.pi-processes/process_<handle>.{json,log}` — see below |
 * | the project `.claude` scheduled-task file       | `workspaces/<workspaceId>/.nessy-agent/crons/<sessionId>.json` — see below |
 *
 * The first four are children of ONE directory here, so the sweep unit is the
 * session directory.
 *
 * No counterpart in this layout: `paste-cache/`, `image-cache/` (pasted images
 * land in the session's own `attachments/`), `session-env/`, `tasks/` (R20's
 * store is not built), `shell-snapshots/`, legacy `todos/` and `statsig/`.
 * `backups/` is excluded deliberately: `config.json.bak-*` is already
 * COUNT-capped at three by `backupConfigFile()` and is the only disaster-recovery
 * copy of the workspace registry. Our own `subagents/` has no counterpart either
 * — subagent turns are inline in the parent transcript — but the VENDOR tree
 * below has a real one.
 *
 * ## The vendor transcript tree — the documented layout, kept verbatim by the SDK
 *
 * `buildClaudeSubprocessEnv` points every Claude Agent SDK subprocess at a
 * per-Workspace `CLAUDE_CONFIG_DIR` (`agent/options.ts`, `workspaceClaudeConfigDir`
 * → `<configDir>/workspaces/<workspaceId>/claude-config`), so the SDK writes its
 * OWN `projects/<sanitized-cwd>/<sdkSessionId>.jsonl` there — the documented
 * layout, unmapped, beside ours. Nothing in this repo used to touch it: this
 * sweep did not name it, and `deleteSession` removes only
 * `sessions/<workspaceId>/<sessionId>`. Measured on one machine 2026-08-20:
 * 166 project directories holding 200 transcripts, ~8.0 MiB, none older than six
 * days — and of the 165 whose name maps to a Nessy session, 37 name a session
 * that no longer exists.
 *
 * The vendor binary runs a cleanup of its own (it leaves a `.last-cleanup` stamp
 * in that directory), but it cannot be relied on here: it only runs when that
 * Workspace's subprocess runs, it reads the settings of the redirected config dir
 * rather than OUR `retentionDays`, and it is age-based, so an orphan whose
 * session was deleted yesterday still waits out the full window. Sweeping the
 * tree ourselves under `cleanupPeriodDays` is what makes the user's retention
 * setting mean the same thing in both trees.
 *
 * ## P6.261 (denominator C24) — what else the vendor may drop in that tree
 *
 * The walker below enters `projects/` and nothing else, deliberately: it is an
 * allowlist, so anything the vendor adds next survives by construction. C24 asks
 * whether one of those additions — the feedback bundle the runtime writes when it
 * cannot upload — therefore outlives the retention period the user set. Measured
 * at HEAD, and the row's own premise needs correcting:
 *
 * - `feedback-bundles` scores **0** across everything this tree installs, the
 *   vendored `@anthropic-ai/claude-agent-sdk` JS core (`sdk.mjs`, 1 321 427 bytes)
 *   included. The sweep's `-> 4` was a probe of the NATIVE binary, and the
 *   `@anthropic-ai/claude-agent-sdk-binary` package is not installed in a dev
 *   tree at all — so that reading cannot be reproduced from source and is not
 *   the artifact a developer can check.
 * - What the JS core DOES carry is a `feedbackDraft` storage namespace keyed by
 *   `draftId`, one of thirty-one such namespaces, and a settings key
 *   `feedbackDrafts` whose documented values are `notify` | `quiet` | `off`:
 *   "Model-drafted feedback (the SendFeedback tool). \"notify\" (default) shows a
 *   one-line notice when a draft is queued; \"quiet\" shows only the footer
 *   counter; \"off\" disables the tool entirely so drafts are never queued."
 *
 * Two consequences, and neither is "widen the allowlist".
 *
 * **The trigger is ON by default** — `notify` — so this is not a rare
 * cannot-upload path; a queued draft is the ordinary case for any session where
 * the model reaches for that tool.
 *
 * **The runtime already owns the control, so native-first says configure before
 * building.** `feedbackDrafts: "off"` stops the drafts being written at all,
 * which beats sweeping them afterwards: data never produced needs no retention
 * period. Deciding whether we set it, and at which settings tier, is the
 * claude-settings seam's call and not this module's — recorded here so the next
 * reader of this walker does not reach for the allowlist first.
 *
 * What stays true either way: a sibling of `projects/` inside the redirected
 * config dir is NEVER swept, at any age. The test file pins that as a control
 * rather than leaving it implied, so a lane that does widen the walker flips a
 * test instead of passing silently.
 *
 * REJECTED, so nobody "finishes" it later: unlinking the previous transcript at
 * the moment of a runtime switch. It means deleting inside a VENDOR-OWNED
 * directory, on a code path where the user asked to switch runtimes and not to
 * delete anything — which contradicts the recorded mirror precedent, "the host
 * never deletes from a mirror on its sweep" — and it would not touch a single one
 * of the 37 orphans, which exist independently of any switch. The age sweep is
 * the one mechanism here already designed to delete user data: allowlist-shaped,
 * dry-runnable, and it logs the full removal set before removing anything.
 *
 * ## The Pi process-marker store — a class this module used to disclaim
 *
 * `<sessionsDir>/.pi-processes/` is the live-process marker store, our
 * counterpart of Claude's `sessions/`. It sits inside the swept root and its
 * name satisfies `assertStorageId`, so it would read as a workspace id — which
 * is what {@link NEVER_SWEPT_SESSION_ROOT_ENTRIES} exists for, and that
 * exclusion still holds: the directory is never a workspace and is never
 * removed.
 *
 * What this header used to claim ON TOP of that was that the store needs no
 * retention at all, because it is "lifecycle-managed": Claude "removes each file
 * when its session exits and clears crash leftovers on the next launch."
 * MEASURED FALSE on the owner's profile 2026-08-21 — nothing clears the
 * leftovers here, and the store had grown to **807 records (1 615 files)**, all
 * of them terminal (`exited` ×803, `stopped` ×4) and none of them ever swept. It
 * killed two live runs outright: `ProcessStore.list()` opens every `.json` in
 * the directory in one `Promise.all`, and at that size the fan-out raised
 * `EMFILE: too many open files, scandir …/.pi-processes` on the FIRST runtime
 * switch of a freshly-launched app.
 *
 * So a terminal record now ages out under the same `cleanupPeriodDays` as the
 * rest of the session data — the precedent the 1.31.0 close-out set when it
 * brought the vendor transcript tree in here rather than growing a second
 * sweeper. The unit is one HANDLE (`<handle>.json` plus its `<handle>.log`),
 * aged from the NEWER of the two so a process still writing output cannot lose
 * its record: `ProcessStore.append` re-writes the record on every chunk, so a
 * live handle's mtime is fresh by construction.
 *
 * **Retention alone does not prevent that EMFILE, and this module must not be
 * read as if it did.** At the measured rate (~100 records/day) a 30-day window
 * settles around 3 000 records — more than the ~800 that already broke
 * `list()`. The proximate defect is the unbounded fan-out in `ProcessStore.list`,
 * which is not this module's to fix; recorded in the plan's §P.9 rather than
 * absorbed here.
 *
 * ## The scheduled-task store — UNOWNED and UNTOUCHED, both (T8, floored by T10,
 * widened by T11)
 *
 * `cron-store.ts` writes one file per session under the session's workspace root
 * (`<configDir>/workspaces/<id>/.nessy-agent/crons/<sessionId>.json`). Deleting a
 * loaded session takes its file with it — `SessionManager` calls the service's
 * `clear()` — but nothing did so for a session deleted COLD, and this sweep's own
 * session tier is the largest cold deleter there is. Measured on the owner's
 * profile 2026-08-23: three such stores existed and five of the files in the
 * largest one belonged to sessions that were already gone.
 *
 * Ownership is the first half of the predicate, because ownership and age are
 * not the same question here. A weekly schedule that has not fired for six days
 * is a LIVE record on a live session, and an age tier alone would delete it;
 * conversely a file whose session no longer exists is garbage the day it is
 * orphaned. So the tier asks the session store, and never removes a file some
 * session still claims.
 *
 * T10 added the second half — the file must ALSO have been untouched since
 * `cutoffMs` — because "the session store does not list it" is NOT "no session
 * owns it". `listSessions` omits two kinds of LIVE session, both silently:
 *
 * - an EPHEMERAL session writes no `session.jsonl` at all (`store-v2.ts`'s
 *   `create` skips the write; `list` skips a directory without the file), and
 *   nothing refuses such a session a cron store — the service is built from the
 *   same `getOrCreateSessionCronService` every other session uses;
 * - a session whose `session.jsonl` has not landed yet, or whose header does not
 *   parse, is skipped by that same `list` with no error.
 *
 * A second process sharing `CONFIG_DIR` (a headless server beside the app, a
 * second window, a CDP rig) sweeps at ITS startup, which can fall inside either
 * window — and the deletion is invisible from the live side, because the store
 * re-reads the file on every call, so `list()` simply goes empty.
 *
 * The floor is what makes that unreachable rather than unlikely — but it is NOT
 * `cutoffMs`, and this header claimed it was until the T10 review. The claim was
 * "every writer in `cron-store.ts` rewrites the whole file (`create`,
 * `markFired`, `rearm`, `replace`), so a live schedule's mtime is fresh by
 * construction, exactly as the Pi process tier's records are". Only the first
 * half survives inspection. A Pi record is rewritten on every output chunk; a
 * cron file is rewritten on the RECORD's own cadence, so a weekly schedule
 * touches it once a week and a store that is merely armed and waiting is not
 * touched at all. `retentionDays` is user-settable down to 1, which puts
 * `cutoffMs` at a day old — well inside the quiet stretch of a live store, whose
 * schedule the sweep would then eat.
 *
 * So the tier compares against `Math.min(cutoffMs, now − SESSION_CRON_EXPIRY_MS)`
 * instead: never collect a cron file touched within the seven-day record
 * lifetime the scheduler itself enforces (`:187`), whatever the retention
 * setting says. Seven days is the right constant and not a guess — it is the
 * longest a live store can legitimately sit unwritten, because past it every
 * record in the file has expired anyway. The one exception is the `owedFire`
 * class, whose residual is named at the field in `cron-store.ts` rather than
 * papered over here. The price is stated plainly: a genuinely orphaned file
 * younger than that floor survives until a later sweep finds it old — one
 * window of delay on garbage, in exchange for never deleting a live session's
 * schedule.
 *
 * The alternative predicate (refuse a cron store to `managed.ephemeral`
 * sessions) was MEASURED and rejected: an ephemeral session can legitimately
 * schedule. `spawn_session` takes `ephemeral` and `permissionMode` together, and
 * an automation's prompt action carries `ephemeral` beside the matcher's own
 * permission mode — in any mode but Explore/Safe the model in that session has
 * `CronCreate`, so refusing it a store would break a capability the product
 * offers rather than close a hole.
 *
 * T11 corrects WHERE the tier looks, which was the last thing keeping a class of
 * these files immortal. The tier used to iterate the workspaces the SESSION tier
 * had enumerated, and production hands that tier `config.workspaceRefs`
 * (`config/storage.ts`) — so a workspace the user REMOVED from the registry was
 * invisible to every tier here and kept its `crons/` directory, and every file
 * in it, forever. The tier now enumerates workspace directories under
 * `<configDir>/workspaces/` itself, the same anchor `cron-store.ts` writes
 * under. Only the enumeration widened: both halves of the predicate are the
 * ones T8 and T10 left, and the ownership half is still ASKED for a workspace
 * the session tier skipped, because `listSessions` is keyed by PATH
 * (`getWorkspaceSessionRootPath`) and never consults the registry — a dropped
 * workspace whose session directories are still on disk still lists those
 * sessions, and they still own their stores. Dropped from the config is not
 * unowned.
 *
 * T11 claimed the same widening for neither the session tier nor the vendor
 * tier, and said so here: "a dropped workspace's transcripts outlive its
 * schedules", a separate hole with a separate blast radius. T13a closes the
 * VENDOR half of it — see that tier — on the same argument plus one more: an
 * unregistered workspace's `claude-config/` is unreachable by the app, so no
 * subprocess is ever pointed there and the vendor's own cleanup never runs on it
 * either.
 *
 * The SESSION tier still honours `options.workspaceIds`, and that is a decision
 * rather than an omission. It is not the same change: this tier and the vendor
 * one age a FILE by its mtime, while a session's sole predicate is the
 * `lastUsedAt` in a header the app itself writes, against a cutoff the user
 * sets, with no second gate underneath it — sessions ARE the owners the other
 * two tiers ask about. Widening it safely needs a POSITIVE orphan signal (a
 * `workspaces/<id>` that is absent or unresolvable) rather than "absent from a
 * list", because an empty `workspaceIds` is a fresh install or a recovery, not
 * a registry with nothing worth keeping. Tracked as its own row.
 *
 * ## Never swept
 *
 * - Everything in `.pi-processes/` that is not a handle-shaped record pair —
 *   `scratch/` and anything the store grows next. Allowlist-shaped like every
 *   other tier here.
 * - `crons/<sessionId>.json.damaged`, the PERMANENT quarantine class
 *   `adoptLegacySessionCronStore` creates when a legacy store will not parse
 *   (`cron-store.ts`'s `DAMAGED_LEGACY_CRON_SUFFIX`). Its whole purpose is
 *   to be readable by a human and by nothing else, so no age retires it: the
 *   cron tier's `<sessionId>.json` allowlist already cannot name it, and that
 *   is now stated here rather than only at the constant. It survives the T11
 *   widening for the same reason — the enumeration changed, the allowlist did
 *   not.
 * - Everything else under `<configDir>` — `history.jsonl` by name in the docs
 *   ("Every prompt you've typed", kept until the user deletes it), plus
 *   `config.json`, credentials, preferences and the rest. Allowlist-shaped, so
 *   this holds by construction; the tests pin it anyway.
 *
 * That last boundary is about NAMES, and one thing it does not survive is worth
 * recording rather than papering over: every tier here resolves through
 * SYMLINKS — `existsSync`, `readdirSync` and `rmSync` all follow a linked
 * DIRECTORY — so a `crons/` (or `.nessy-agent/`, or any config-root class)
 * directory replaced by a link makes the sweep delete outside `<configDir>`
 * while every path it logs still reads as being inside it. It is module-wide and
 * predates T11 and T13a, which only widened which workspaces are reached; a
 * linked WORKSPACE directory is already excluded, because `listWorkspaceDirectories`
 * types entries off the `Dirent` and `isDirectory()` is false for a link.
 * Planting either link needs write access to the user's own config directory, so
 * the guard that would close it — `lstat` before descending, on every tier —
 * belongs to a deliberate hardening pass and not to a row that was about
 * enumeration.
 */

import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { debug } from '../utils/debug.ts'
// A DURATION, not a path: the path segments below are spelled out to keep this
// module parameterised by `options.configDir`, and that reason does not apply to
// the record lifetime the cron tier's floor is built on. Importing it is what
// keeps the floor and the expiry the scheduler enforces the same number.
import { SESSION_CRON_EXPIRY_MS } from './cron-store.ts'
import { deleteSession, listSessions } from './storage.ts'

/** Which documented class a removal belongs to, for the report and the log. */
export type RetentionPathClass =
  | 'session'
  | 'workspace-session-root'
  | 'logs'
  | 'feedback'
  /**
   * R20 task lists (`<configDir>/tasks/<listId>`). `agent-teams.md`: "Retention
   * is governed by the same `cleanupPeriodDays` you already control for session
   * transcripts" — so it joins THIS sweep under THIS cutoff rather than getting
   * a sweeper of its own.
   */
  | 'tasks'
  /**
   * One Claude Agent SDK transcript in the per-Workspace vendor tree —
   * `workspaces/<workspaceId>/claude-config/projects/<cwd>/<sdkSessionId>.jsonl`
   * — and, as a SECOND removal under the same class, the same-named sidecar
   * directory `<sdkSessionId>/subagents/` when the session ran subagents. Two
   * entries rather than one hidden recursive delete: the log has to name every
   * path it is about to remove. T13a — the workspaces are enumerated from the
   * filesystem, so `options.workspaceIds` no longer decides which of them this
   * class can be about.
   */
  | 'vendor-transcript'
  /** A vendor project directory removed once the sweep emptied it. */
  | 'vendor-project-root'
  /**
   * One settled Pi process record — `<handle>.json` and, as a SECOND removal
   * under the same class, its `<handle>.log`. Two entries rather than one hidden
   * pair-delete: the log has to name every path it is about to remove.
   */
  | 'pi-process-record'
  /**
   * One session's scheduled-task file —
   * `workspaces/<workspaceId>/.nessy-agent/crons/<sessionId>.json`. Unlike every
   * other class here the decision leads with OWNERSHIP: the file belongs to a
   * session, so it goes when that session does — and then, T10, it must be past
   * the tier's own cron cutoff as well (`min(cutoffMs, now −
   * SESSION_CRON_EXPIRY_MS)`), because the session list omits some LIVE
   * sessions. See the tier for both halves. T11 — the workspaces are enumerated
   * from the filesystem, so `options.workspaceIds` no longer decides which of
   * them this class can be about.
   */
  | 'session-cron'

/** The Pi process-marker store, directly under the sessions root. */
const PI_PROCESS_STORE_DIR_NAME = '.pi-processes'

/**
 * Entries directly under the sessions root that are NOT workspaces, and are
 * therefore never enumerated as one or removed as one. `.pi-processes` is the Pi
 * process-marker store; the DIRECTORY is never removed, while the settled
 * records inside it age out under the tier in `runRetentionSweep` — see the
 * module header for why that used to be the opposite.
 */
export const NEVER_SWEPT_SESSION_ROOT_ENTRIES: ReadonlySet<string> = new Set([PI_PROCESS_STORE_DIR_NAME])

/**
 * One process record's two file names. The handle shape is `ProcessStore`'s own
 * (`process_${randomUUID without dashes}`, pinned there by `PROCESS_HANDLE`);
 * spelled out here for the same reason the vendor path segments are — this
 * module stays parameterised by `options.sessionsDir` and must not import a
 * server-core module bound to the real store root. A store rename therefore
 * fails the test that builds its fixture from the real names, rather than
 * quietly sweeping nothing.
 */
const PI_PROCESS_RECORD_SUFFIX = '.json'
const PI_PROCESS_LOG_SUFFIX = '.log'
const PI_PROCESS_RECORD_NAME = /^process_[0-9a-f]{32}\.json$/

/**
 * The path segments between `configDir` and one vendor transcript.
 *
 * Spelled out here rather than imported, because this module has to stay
 * parameterised by `options.configDir`: `WORKSPACES_DIR` and
 * `workspaceClaudeConfigDir` are bound to the process's real config root, which a
 * test of a destructive sweep must never be pointed at. The sources of truth are
 * `workspaces/paths.ts` (`WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces')`) and
 * `agent/options.ts` (`CLAUDE_CONFIG_DIR_NAME = 'claude-config'`), and the test
 * builds its fixture from `workspaceClaudeConfigDir()` itself — so a rename over
 * there fails the tests here instead of quietly sweeping nothing.
 */
const WORKSPACES_DIR_NAME = 'workspaces'
const VENDOR_CONFIG_DIR_NAME = 'claude-config'
const VENDOR_PROJECTS_DIR_NAME = 'projects'
const VENDOR_TRANSCRIPT_SUFFIX = '.jsonl'

/**
 * The scheduled-task store's segments under one workspace root, spelled out for
 * the same reason the vendor segments above are: this module stays parameterised
 * by `options.configDir`, and `cron-store.ts` binds its helpers to a caller-given
 * project directory. The test builds its fixture from `sessionCronFile()` itself,
 * so a rename over there fails a test here instead of quietly sweeping nothing.
 */
const CRON_PROJECT_DIR_NAME = '.nessy-agent'
const CRON_STORE_DIR_NAME = 'crons'
const CRON_FILE_SUFFIX = '.json'

/** Config-root directories whose CONTENTS are swept while the directory itself stays. */
const CONFIG_DIR_CLASSES: readonly { dir: string; pathClass: RetentionPathClass }[] = [
  { dir: 'logs', pathClass: 'logs' },
  { dir: 'feedback', pathClass: 'feedback' },
  // One entry per task list; the `tasks` root itself is kept, exactly like
  // `logs` and `feedback`.
  { dir: 'tasks', pathClass: 'tasks' },
]

export interface RetentionSweepRemoval {
  readonly pathClass: RetentionPathClass
  readonly path: string
  /** Epoch ms the age decision was made on. */
  readonly lastUsedAt: number
  /** Set on `session` removals so applying the plan never re-parses the path. */
  readonly session?: { readonly workspaceId: string; readonly sessionId: string }
}

export interface RetentionSweepReport {
  readonly dryRun: boolean
  /** What was removed — or, in a dry run, exactly what a real run would remove. */
  readonly removed: RetentionSweepRemoval[]
  readonly failed: { path: string; error: string }[]
}

export interface RetentionSweepOptions {
  /** Root of the config directory. Production passes `CONFIG_DIR`. */
  readonly configDir: string
  /** Root of the session store. Production passes `SESSIONS_DIR`. */
  readonly sessionsDir: string
  /** Epoch ms; anything last used strictly before this is removed. */
  readonly cutoffMs: number
  /** Report only. Nothing is touched. */
  readonly dryRun?: boolean
  /**
   * Restrict the SESSION tier to these workspaces. Omitted means every workspace
   * directory under `sessionsDir`, the root that tier deletes from.
   *
   * It is the session tier's list ALONE, and the two corrections that got it
   * there are worth keeping visible because both were shipped wrong. The
   * sentence named `sessionsDir` for the vendor tier as well until T11's review
   * — that tier has never enumerated that root; its own is
   * `<configDir>/workspaces/`, where the vendor tree lives. And it then said the
   * vendor tier was restricted by this at all, which stopped being true at T13a.
   *
   * Neither workspace-rooted tier is restricted by this any more, for the same
   * reason: the scheduled-task tier (T11) and the vendor transcript tier (T13a)
   * both enumerate `<configDir>/workspaces/` from the filesystem, so a workspace
   * dropped from the registry is reachable by both whatever this list says.
   * Passing it still decides which workspaces the cron tier gets its ownership
   * set from for free rather than by asking the store again — never which files
   * either tier may consider.
   */
  readonly workspaceIds?: readonly string[]
}

/** Workspace/session ids are constrained; anything else under the root is not ours. */
const STORAGE_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Workspace-id-shaped directories under `root`. Called for BOTH roots a workspace
 * has — `sessions/` for the session tier, `workspaces/` for the cron and vendor
 * tiers — so each tier enumerates the root it actually deletes from.
 * `.pi-processes` never appears under `workspaces/`; excluding it there is a
 * harmless no-op that keeps one filter instead of two.
 */
function listWorkspaceDirectories(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => !NEVER_SWEPT_SESSION_ROOT_ENTRIES.has(name))
      .filter(isSweepableWorkspaceId)
  } catch {
    return []
  }
}

/**
 * The cron and vendor tiers build a filesystem path out of the workspace id and
 * delete by path, where the session tier hands the id to `deleteSession` and gets
 * `assertStorageId` for free. So the id is validated HERE too, inside
 * {@link listWorkspaceDirectories} — which since T13a is the ONLY source of ids
 * for both path-building tiers, so neither can be reached by an id nothing
 * pattern-checked. (Until then the vendor tier could take an explicit
 * `options.workspaceIds` entry, which is pattern-checked nowhere upstream, and
 * this filter was applied a second time at that tier to cover it.)
 */
function isSweepableWorkspaceId(name: string): boolean {
  return STORAGE_ID_PATTERN.test(name) && name !== '.' && name !== '..'
}

function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0
  } catch {
    return false
  }
}

/**
 * Plan every removal, then apply it. Planning first is what makes the dry run
 * exact instead of an approximation: both modes run the same enumeration and
 * differ only in whether the removals are executed.
 */
export function runRetentionSweep(options: RetentionSweepOptions): RetentionSweepReport {
  const dryRun = options.dryRun === true
  const removed: RetentionSweepRemoval[] = []
  const failed: { path: string; error: string }[] = []

  const workspaceIds = options.workspaceIds
    ? options.workspaceIds.filter(id => !NEVER_SWEPT_SESSION_ROOT_ENTRIES.has(id))
    : listWorkspaceDirectories(options.sessionsDir)

  // 1. Session tier. Age-based, NOT archive-based — this is the hole R12 exists
  //    to close. Goes through the store's own listSessions/deleteSession so the
  //    sweep deletes what the app considers a session, not what a path glob does.
  const emptied = new Set<string>()
  // Which sessions each workspace still owns once this sweep is applied. A
  // workspace only gets an entry when `listSessions` SUCCEEDED — the cron tier
  // below deletes on the strength of "no session owns this file", and an
  // enumeration that threw would make every file look unowned.
  const survivingSessionIds = new Map<string, Set<string>>()
  // …and the ones whose enumeration THREW, which the cron tier needs to tell
  // apart from "never asked": it enumerates its own workspaces now, so without
  // this it would re-ask — and re-fail — for the same workspace, reporting the
  // failure twice.
  const unreadableSessionLists = new Set<string>()
  for (const workspaceId of workspaceIds) {
    let sessions
    try {
      sessions = listSessions(workspaceId)
    } catch (error) {
      failed.push({ path: join(options.sessionsDir, workspaceId), error: message(error) })
      unreadableSessionLists.add(workspaceId)
      continue
    }
    const surviving = new Set(sessions.map(session => session.id))
    survivingSessionIds.set(workspaceId, surviving)
    for (const session of sessions) {
      // An ARCHIVED session ages from when it was archived — archiving is the
      // "done with this" signal, and it is what the previous archived-only sweep
      // used. An UNARCHIVED one ages from its last use, which is the half that
      // did not exist before and is the whole point of this module.
      const lastUsedAt = session.isArchived === true
        ? (session.archivedAt ?? session.lastUsedAt)
        : session.lastUsedAt
      if (!Number.isFinite(lastUsedAt) || lastUsedAt >= options.cutoffMs) continue
      removed.push({
        pathClass: 'session',
        path: join(options.sessionsDir, workspaceId, session.id),
        lastUsedAt,
        session: { workspaceId, sessionId: session.id },
      })
      surviving.delete(session.id)
      emptied.add(workspaceId)
    }
  }

  // Both remaining workspace-rooted tiers — the scheduled-task store and the
  // vendor transcript tree — hang off this one root.
  const workspacesRoot = join(options.configDir, WORKSPACES_DIR_NAME)

  // 1b. Scheduled-task tier (T8 (c), floored by T10, widened by T11). One file
  //     per session under the workspace's own project namespace, so the unit is
  //     a session and the leading question is OWNERSHIP rather than age: a live
  //     session's schedule can sit untouched for weeks and must not be swept,
  //     while a session deleted COLD — by this sweep, or by any delete that ran
  //     while the session was not loaded and so had no live service to `clear()`
  //     — orphans its file forever. `crons/` is kept like `logs` and `feedback`;
  //     the store recreates it on demand.
  //
  //     Allowlist-shaped like every other tier: only `<sessionId>.json` names are
  //     ever considered, and only inside a workspace whose session list was read
  //     successfully, so anything else in that directory survives by
  //     construction — the quarantined `<sessionId>.json.damaged` files
  //     `adoptLegacySessionCronStore` leaves behind among them. `surviving`
  //     already has this run's tier-1 removals taken out of it, which is what
  //     makes an aged-out session take its schedule with it in the SAME pass.
  //
  //     T10 — "not in `listSessions`" is NOT "no session owns it". That list
  //     silently omits an EPHEMERAL session (no `session.jsonl` is ever written,
  //     and nothing refuses such a session a cron store) and a session whose
  //     header has not landed or does not parse. Both are LIVE, and a second
  //     process sharing this `CONFIG_DIR` sweeps at its own startup, which can
  //     land inside either window — deleting the store out from under a running
  //     session with no error anywhere, because the store re-reads per call and
  //     `list()` just goes empty. So an unowned file must ALSO be untouched since
  //     the CRON cutoff below. See the module header for the measured reason the
  //     other candidate predicate (refuse ephemeral sessions a store) was
  //     rejected.
  //
  //     That floor is NOT `options.cutoffMs` — the T10 review's correction.
  //     `retentionDays` is user-settable down to 1, while a live store is only
  //     rewritten on its records' own fire cadence, which can be a whole week
  //     apart, and an armed store waiting to fire is not rewritten at all. A
  //     one-day cutoff therefore sits well inside a live store's quiet stretch.
  //     `SESSION_CRON_EXPIRY_MS` is the right floor rather than a padded guess:
  //     past seven days with no write, every record in the file has expired
  //     under `:187` anyway.
  //
  //     T11 — WHERE the tier looks is the filesystem, not the registry. This
  //     loop used to walk `survivingSessionIds`, i.e. the workspaces the session
  //     tier was given, and production gives it `config.workspaceRefs`
  //     (`config/storage.ts`). A workspace REMOVED from the registry was
  //     therefore invisible to every tier and kept its `crons/` directory, and
  //     every file in it, forever. It now walks the workspaces root — the same
  //     anchor `cron-store.ts` writes under — so a dropped workspace's store is
  //     reachable. Only the enumeration widened: both halves of the predicate
  //     below are unchanged, and the ownership half is still ASKED for a
  //     workspace the session tier skipped, because `listSessions` is keyed by
  //     path rather than by the registry — a dropped workspace whose session
  //     directories are still on disk still lists them, and they still own their
  //     stores.
  const cronCutoff = Math.min(options.cutoffMs, Date.now() - SESSION_CRON_EXPIRY_MS)
  for (const workspaceId of listWorkspaceDirectories(workspacesRoot)) {
    // An enumeration that THREW above is not "no session owns this file", and
    // re-asking here would only fail again.
    if (unreadableSessionLists.has(workspaceId)) continue
    const cronRoot = join(workspacesRoot, workspaceId, CRON_PROJECT_DIR_NAME, CRON_STORE_DIR_NAME)
    if (!existsSync(cronRoot)) continue
    // The session tier's map first: it already has THIS run's removals taken out
    // of it, which is what makes an aged-out session take its schedule with it in
    // the same pass. A workspace the session tier never enumerated gets its
    // ownership set from the same store, under the same rule — a failure means
    // this workspace is skipped, never that its files look unowned.
    let surviving = survivingSessionIds.get(workspaceId)
    if (!surviving) {
      try {
        surviving = new Set(listSessions(workspaceId).map(session => session.id))
      } catch (error) {
        failed.push({ path: join(options.sessionsDir, workspaceId), error: message(error) })
        continue
      }
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(cronRoot, { withFileTypes: true })
    } catch (error) {
      failed.push({ path: cronRoot, error: message(error) })
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(CRON_FILE_SUFFIX)) continue
      const sessionId = entry.name.slice(0, -CRON_FILE_SUFFIX.length)
      if (surviving.has(sessionId)) continue
      const path = join(cronRoot, entry.name)
      let lastUsedAt: number
      try {
        lastUsedAt = statSync(path).mtimeMs
      } catch (error) {
        failed.push({ path, error: message(error) })
        continue
      }
      // The T10 floor, against `cronCutoff` and never `options.cutoffMs`. It
      // runs AFTER the ownership check, so the tier's meaning is unchanged for
      // everything the session list can see.
      if (lastUsedAt >= cronCutoff) continue
      removed.push({ pathClass: 'session-cron', path, lastUsedAt })
    }
  }

  // 2. Config-root tier: contents older than the cutoff; the directory stays.
  for (const { dir, pathClass } of CONFIG_DIR_CLASSES) {
    const root = join(options.configDir, dir)
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch (error) {
      failed.push({ path: root, error: message(error) })
      continue
    }
    for (const name of entries) {
      const path = join(root, name)
      let lastUsedAt: number
      try {
        lastUsedAt = statSync(path).mtimeMs
      } catch (error) {
        failed.push({ path, error: message(error) })
        continue
      }
      if (lastUsedAt >= options.cutoffMs) continue
      removed.push({ pathClass, path, lastUsedAt })
    }
  }

  // 2b. Pi process-record tier. Inside the sessions root but never a workspace,
  //     so it is enumerated here rather than by the tier above. The unit is one
  //     HANDLE — `<handle>.json` and its `<handle>.log` — aged from the NEWER of
  //     the two, which can only ever keep a record longer. Allowlist-shaped: only
  //     the two handle-shaped names are ever named, so `scratch/` and anything
  //     the store grows next survive by construction. The directory itself is
  //     kept, exactly like `logs` and `feedback`.
  const piProcessRoot = join(options.sessionsDir, PI_PROCESS_STORE_DIR_NAME)
  if (existsSync(piProcessRoot)) {
    let entries: string[] = []
    try {
      entries = readdirSync(piProcessRoot)
    } catch (error) {
      failed.push({ path: piProcessRoot, error: message(error) })
    }
    const present = new Set(entries)
    for (const name of entries) {
      if (!PI_PROCESS_RECORD_NAME.test(name)) continue
      const handle = name.slice(0, -PI_PROCESS_RECORD_SUFFIX.length)
      const recordPath = join(piProcessRoot, name)
      const logName = `${handle}${PI_PROCESS_LOG_SUFFIX}`
      const logPath = present.has(logName) ? join(piProcessRoot, logName) : undefined
      let lastUsedAt: number
      try {
        lastUsedAt = statSync(recordPath).mtimeMs
        // `ProcessStore.append` re-writes the record on every chunk, so these two
        // move together for a live handle; taking the max is belt AND braces on
        // a destructive pass.
        if (logPath) lastUsedAt = Math.max(lastUsedAt, statSync(logPath).mtimeMs)
      } catch (error) {
        failed.push({ path: recordPath, error: message(error) })
        continue
      }
      if (lastUsedAt >= options.cutoffMs) continue
      removed.push({ pathClass: 'pi-process-record', path: recordPath, lastUsedAt })
      if (logPath) removed.push({ pathClass: 'pi-process-record', path: logPath, lastUsedAt })
    }
  }

  // 3. Vendor transcript tier. FILE-level, not directory-level, because the two
  //    existing tiers disagree — the session tier's unit is a directory, the
  //    config-root tier's unit is one entry under a kept root — and a project
  //    directory here is keyed by CWD, not by session: `-Users-…-react-ui-kit`
  //    holds five transcripts of five different ages on the machine this was
  //    measured on. Directory-level would hold all five hostage to the newest.
  //    The emptied project directory is then removed by step 4, the same way
  //    step 5 removes an emptied workspace session root, so nothing lingers.
  //
  //    T13a — WHERE the tier looks is the filesystem, not the registry, the same
  //    correction T11 made to the cron tier and deliberately did not claim here.
  //    This loop used to honour `options.workspaceIds` when it was given, and
  //    production gives it `config.workspaceRefs` (`config/storage.ts`) — so a
  //    workspace the user REMOVED from the registry kept its whole
  //    `claude-config/projects/` tree, every transcript in it, forever. Nothing
  //    else would ever collect them either: no Workspace means no subprocess
  //    pointed at that config dir, so the vendor's own cleanup never runs there.
  //    It now enumerates the workspaces root unconditionally — the root this
  //    tier already deleted from, and the only root this tree lives under.
  //
  //    Only the enumeration widened. There is no ownership half to widen here,
  //    unlike the cron tier: a vendor transcript is keyed by CWD rather than by
  //    a Nessy session, so age against the same `cutoffMs` is the whole
  //    predicate, and the `<sdkSessionId>.jsonl` allowlist still decides what a
  //    name may even be about. No new wall-clock read.
  const sweptProjectDirs = new Set<string>()
  for (const workspaceId of listWorkspaceDirectories(workspacesRoot)) {
    const projectsRoot = join(
      workspacesRoot, workspaceId, VENDOR_CONFIG_DIR_NAME, VENDOR_PROJECTS_DIR_NAME,
    )
    let projectDirs: Dirent[]
    try {
      if (!existsSync(projectsRoot)) continue
      projectDirs = readdirSync(projectsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch (error) {
      failed.push({ path: projectsRoot, error: message(error) })
      continue
    }
    for (const projectDir of projectDirs) {
      const projectPath = join(projectsRoot, projectDir.name)
      let entries: Dirent[]
      try {
        entries = readdirSync(projectPath, { withFileTypes: true })
      } catch (error) {
        failed.push({ path: projectPath, error: message(error) })
        continue
      }
      // Sidecars are matched by NAME against the directory entries of this same
      // listing, so an unrelated directory can never be swept: only
      // `<sdkSessionId>/` beside a `<sdkSessionId>.jsonl` we already decided to
      // remove. Everything else in here — anything the vendor adds next — survives
      // by construction, which is the whole point of an allowlist.
      const sidecars = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
      let plannedInThisDir = 0
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(VENDOR_TRANSCRIPT_SUFFIX)) continue
        const path = join(projectPath, entry.name)
        const sdkSessionId = entry.name.slice(0, -VENDOR_TRANSCRIPT_SUFFIX.length)
        const sidecar = sidecars.has(sdkSessionId) ? join(projectPath, sdkSessionId) : undefined
        let lastUsedAt: number
        try {
          lastUsedAt = statSync(path).mtimeMs
          // Age from the NEWER of the two. A directory's mtime moves when a
          // subagent file is added, so this can only ever keep data longer.
          if (sidecar) lastUsedAt = Math.max(lastUsedAt, statSync(sidecar).mtimeMs)
        } catch (error) {
          failed.push({ path, error: message(error) })
          continue
        }
        if (lastUsedAt >= options.cutoffMs) continue
        removed.push({ pathClass: 'vendor-transcript', path, lastUsedAt })
        if (sidecar) removed.push({ pathClass: 'vendor-transcript', path: sidecar, lastUsedAt })
        plannedInThisDir += 1
      }
      if (plannedInThisDir > 0) sweptProjectDirs.add(projectPath)
    }
  }

  logPlan(removed, options, dryRun)
  if (dryRun) return { dryRun, removed, failed }

  for (const removal of removed) {
    if (removal.session) {
      if (!deleteSession(removal.session.workspaceId, removal.session.sessionId)) {
        failed.push({ path: removal.path, error: 'deleteSession refused' })
      }
      continue
    }
    try {
      rmSync(removal.path, { recursive: true, force: true })
    } catch (error) {
      failed.push({ path: removal.path, error: message(error) })
    }
  }

  // 4. Same rule for a vendor project directory the tier above just emptied. The
  //    `projects` root itself is KEPT, exactly like `logs` and `feedback`: it is
  //    vendor-owned and the SDK recreates the per-cwd directory on demand.
  for (const projectPath of sweptProjectDirs) {
    if (!existsSync(projectPath) || !isEmptyDirectory(projectPath)) continue
    try {
      rmdirSync(projectPath)
      removed.push({ pathClass: 'vendor-project-root', path: projectPath, lastUsedAt: options.cutoffMs })
    } catch (error) {
      failed.push({ path: projectPath, error: message(error) })
    }
  }

  // 5. "The sweep removes their contents and then the empty directory." A
  //    workspace session root whose last session just went is exactly that case;
  //    `ensureSessionsDir` recreates it on demand.
  for (const workspaceId of emptied) {
    const root = join(options.sessionsDir, workspaceId)
    if (!existsSync(root) || !isEmptyDirectory(root)) continue
    try {
      // `rmdirSync` refuses a non-empty directory, so the emptiness check above
      // is belt AND braces on a destructive pass.
      rmdirSync(root)
      removed.push({ pathClass: 'workspace-session-root', path: root, lastUsedAt: options.cutoffMs })
    } catch (error) {
      failed.push({ path: root, error: message(error) })
    }
  }

  return { dryRun, removed, failed }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Log the full removal set BEFORE anything is removed. Non-negotiable for a destructive pass. */
function logPlan(
  removed: readonly RetentionSweepRemoval[],
  options: RetentionSweepOptions,
  dryRun: boolean,
): void {
  if (removed.length === 0) {
    debug(`[retention] sweep found nothing older than ${new Date(options.cutoffMs).toISOString()}`)
    return
  }
  debug(
    `[retention] ${dryRun ? 'would remove' : 'removing'} ${removed.length} path(s) last used before`
    + ` ${new Date(options.cutoffMs).toISOString()}:`
    + removed.map(entry => `\n  [${entry.pathClass}] ${entry.path} (${new Date(entry.lastUsedAt).toISOString()})`).join(''),
  )
}
