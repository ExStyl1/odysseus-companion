/**
 * The session-scoped scheduled-task store (R27b Task 1).
 *
 * Contract source, `scheduled-tasks.md` read raw:
 * - `:11`, `:216` — tasks "live in the current conversation and stop when you
 *   start a new one"; resuming "restores tasks that have not expired: recurring
 *   tasks within seven days of creation, and one-shot tasks whose scheduled time
 *   has not yet passed."
 * - `:168` — "Each scheduled task has an 8-character ID you can pass to
 *   `CronDelete`. A session can hold up to 50 scheduled tasks at once."
 * - `:217` — "Claude Code stores the scheduled task list in the project's
 *   `.claude` directory, and scheduling a task fails with an error when that
 *   directory, or the task file inside it, is a symlink."
 *
 * Shape follows R20's `task-store.ts`, which is the nearest existing design: an
 * id-keyed store under a validated path, re-read from disk on every call so two
 * writers cannot race two in-memory copies, written through a temp file and a
 * rename so a torn write is never a torn list.
 *
 * It differs in two ways that come straight from the contract, and both are why
 * this is a second store rather than a mode of the first. R20's list is keyed by
 * `NESSY_TASK_LIST_ID` and deliberately SHAREABLE between sessions under the
 * config root; this one is keyed by session id under a per-workspace project
 * namespace, because `:217` puts it in the project directory and `:216` says a
 * fresh conversation clears it. And R20 has no expiry of its own — it rides the
 * retention sweep — whereas these records carry a seven-day lifetime the
 * scheduler enforces per record (`:187`).
 *
 * ## Which directory, and why it is not the session's cwd (T8)
 *
 * "The project's directory" was read as `workingDirectory ?? workspace.rootPath`
 * until 2026-08-23, and the working-directory half is not stable for the life of
 * a session: a worktree session wrote `<worktree>/.nessy-agent/crons/`, and a
 * runtime switch forces an `ExitWorktree` BEFORE the teardown, so the `restore()`
 * on the other side of the switch read a different file from the one the records
 * were written to — the records simply vanished, which is what T6 observed live.
 * The anchor is now the session's WORKSPACE root, which no session-level action
 * moves; {@link adoptLegacySessionCronStore} carries a store forward from the old
 * anchor once. R20's list-id store and this one therefore agree on the property
 * that matters for scheduling: the path is a function of identity, not of cwd.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { THINKING_LEVEL_IDS, type ThinkingLevel } from '../agent/thinking-levels.ts'
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts'
import { debug } from '../utils/debug.ts'

/** `:168` — "A session can hold up to 50 scheduled tasks at once." */
export const MAX_SESSION_CRON_TASKS = 50

/** `:168` — "Each scheduled task has an 8-character ID". */
export const SESSION_CRON_ID_LENGTH = 8

/** `:187` — "Recurring tasks automatically expire 7 days after creation." */
export const SESSION_CRON_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

/** Subdirectory of the project namespace that holds one file per session. */
export const SESSION_CRON_DIR = 'crons'

/**
 * What {@link adoptLegacySessionCronStore} appends to a DAMAGED legacy store's
 * name when it moves it out of the way. Deliberately not a `.json` name: the
 * quarantined file must not be picked up by anything that enumerates stores —
 * not this module, not the retention sweep's `<sessionId>.json` allowlist.
 */
export const DAMAGED_LEGACY_CRON_SUFFIX = '.damaged'

/**
 * One scheduled task.
 *
 * `id`, `schedule`, `recurring` and `prompt` are exactly the four fields
 * `hooks.md:2205-2210` gives a `session_crons` entry, so the Stop-hook
 * projection is a field selection rather than a translation. The R39 optional
 * fields below (`dynamic`, `nextFireAt`, `fallbackArmed`, `promptSource`) are
 * deliberately NOT part of that four-field projection — a hook script keeps
 * seeing the documented shape, dynamic loop or not.
 */
export interface SessionCronRecord {
  readonly id: string
  /**
   * A 5-field expression in the documented dialect — or the literal `dynamic`
   * for a self-paced loop, whose fire time never comes from this field.
   */
  readonly schedule: string
  /** `false` for a one-shot whose schedule encodes a single fire time. */
  readonly recurring: boolean
  readonly prompt: string
  /** Epoch ms. The origin of the seven-day expiry and of the resume decision. */
  readonly createdAt: number
  /** Epoch ms of the last delivered fire; absent until the first one. */
  readonly lastFiredAt?: number
  /**
   * R39 — a self-paced `/loop`. The fire time comes from `nextFireAt`, never
   * from `schedule`, and `scheduled-tasks.md:74` exempts the record from
   * jitter while keeping the seven-day expiry.
   */
  readonly dynamic?: boolean
  /**
   * Epoch ms of the pending wakeup for a dynamic record. Absent on a dynamic
   * record means the loop is over — nothing is armed.
   */
  readonly nextFireAt?: number
  /**
   * R39 — the service's one ~20-minute fallback wakeup is armed
   * (`scheduled-tasks.md:130`); a second unrescheduled iteration ends the loop.
   */
  readonly fallbackArmed?: boolean
  /**
   * R39 — the prompt is re-resolved (loop.md, or the builtin maintenance
   * prompt) at every DELIVERY (`:120`); the stored `prompt` keeps the
   * create-time resolution so `CronList` still shows something.
   */
  readonly promptSource?: 'loop-md'
  /**
   * T8 (e) — this record's FINAL fire (`:187`'s last fire of a recurring task,
   * or a one-shot's only one) has been enqueued and not yet delivered.
   *
   * The marker exists because the two moments are separated by an arbitrary
   * gap: a fire that comes due mid-turn waits for the turn to end, and a
   * runtime switch or a quit in that window used to destroy the in-memory
   * queue AND find nothing on disk, because the record had already deleted
   * itself at enqueue time. A record carrying this marker is kept by
   * `planCronRestore` whatever its schedule says and fired immediately by
   * `planCronTick`, so the owed prompt survives exactly one more time and the
   * record is removed at DELIVERY instead of at enqueue.
   *
   * T10 — say the consequence out loud, because it is a NEW retention class and
   * the only one in this file: a marked record is exempt from `:187`'s seven-day
   * expiry FOREVER, not for another seven days. That is deliberate. The marker
   * means the user's prompt was already accepted for delivery and never
   * delivered, so an expiry that discarded it would be discarding the one thing
   * the marker exists to protect; and "expired" is the wrong question anyway,
   * since the record is due NOW rather than on any schedule. The bound is the
   * SESSION, not the clock — the record dies with the store file, which goes
   * when the session goes (`clear()` on delete, the retention tier when the
   * session was deleted cold), and it survives at most one more fire because
   * `flush` removes it at delivery. A record that never fires again is a session
   * that is never resumed, and that session's whole store is garbage the sweep
   * already collects.
   *
   * What holds that bound up, and where it leaks (T10 fix wave): for a session
   * the retention sweep's session list cannot see — an ephemeral one, or one
   * whose header has not landed — the only thing standing between this record
   * and that sweep is the T10 floor in `retention-sweep.ts`, which refuses to
   * collect a cron file touched within {@link SESSION_CRON_EXPIRY_MS}. The
   * residual is therefore named rather than denied: such a session, idle past
   * that floor, still loses the owed prompt to the sweep, because nothing
   * rewrites the file while the fire sits owed. The floor buys a bounded window,
   * not permanence.
   */
  readonly owedFire?: boolean
  /**
   * P6.295 arm (2) — the task is PAUSED: it keeps its schedule and its prompt,
   * fires nothing, and is not deleted.
   *
   * Before this the store had exactly two states, armed and gone, so the only
   * way to stop a task for an afternoon was to cancel it and retype it. It is a
   * host surface on all three runtimes for the same reason the recurrence rules
   * are — no runtime ships an embeddable scheduler.
   *
   * **A paused record is neither FIRED nor SWEPT, and the second half is the
   * decision.** The service shields it from `planCronTick` by riding the same
   * `pending` set a dueless dynamic record uses, which skips the record for both
   * outcomes. Stopping only the fire would leave the sweeps running: a one-shot's
   * fire is FINAL and a final fire deletes the record at delivery (`:187`), so a
   * half-implemented pause quietly becomes a slower delete — the one outcome a
   * user who chose pause over `CronDelete` was avoiding. Pinned by the one-shot
   * pair in `session-cron-service.test.ts`. The bound is still the SESSION: the
   * record dies with the store file.
   */
  readonly paused?: boolean
  /**
   * P6.295 arm (2) — deliveries this task has made that nobody has looked at
   * yet. Incremented at every non-final DELIVERY (never at enqueue, for the same
   * cursor reason `markFired` is stamped at delivery), cleared by
   * {@link SessionCronStore.acknowledgeRuns}.
   *
   * `lastFiredAt` alone cannot answer "has this run since I last looked": it is
   * one timestamp with no reader-side cursor, so a task that fired four times
   * overnight and one that fired once are indistinguishable in a list. The count
   * is what makes `CronList` able to say which runs have not been read.
   *
   * Absent means zero. A final fire increments nothing, because the record is
   * removed at that delivery and there is nothing left to list.
   */
  readonly unreadRuns?: number
  /**
   * P6.376 — the model this task's runs dispatch on, instead of whatever the
   * session happens to be set to when the fire lands.
   *
   * A model ID, the same vocabulary `ManagedSession.model` carries. Absent
   * means "the session's", which is exactly today's behaviour, so an existing
   * record is byte-identical and behaves identically.
   */
  readonly model?: string
  /**
   * P6.376 — the effort LEVEL this task's runs dispatch on. A
   * {@link ThinkingLevel} value, never a tier: on claude a TIER cannot travel
   * (the SDK takes only `model`), so a tier-valued cron field would diverge
   * there while pi and codex honoured it. The level is the vocabulary all
   * three already share.
   *
   * The reason the field exists is a COST the operator did not choose: an
   * unattended nightly run inherits whatever effort the session was left on,
   * and the person who set that effort was doing something else at the time.
   *
   * Typed as the level union rather than `string` so a tier can never be
   * stored; a stored value outside it is dropped by {@link isRecord}, the same
   * posture every other optional field takes.
   */
  readonly effort?: ThinkingLevel
}

export interface SessionCronListState {
  readonly schemaVersion: 1
  readonly tasks: readonly SessionCronRecord[]
}

/**
 * A refusal the model must see verbatim: `:217` makes a symlinked store a hard
 * error, and the 50-task cap is a documented bound rather than a soft limit.
 */
export class SessionCronStoreError extends Error {
  constructor(message: string, readonly code: 'symlink' | 'capacity' | 'not-found') {
    super(message)
    this.name = 'SessionCronStoreError'
  }
}

/** Same constraint the R20 store puts on a list id — a session id reaches the filesystem. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

export function assertCronSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`Invalid cron session id: ${JSON.stringify(sessionId)}`)
  }
  return sessionId
}

/**
 * `:217` — the project directory, the store directory, and the task file are
 * each refused when they are a symlink. Checked with `lstat`, never `stat`, so
 * the link itself is inspected rather than its target; a missing path is fine,
 * because it is about to be created as a real directory.
 */
function assertNotSymlink(path: string, label: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false })
  if (stats?.isSymbolicLink()) {
    throw new SessionCronStoreError(
      `Scheduling is unavailable: ${label} (${path}) is a symlink. Replace it with a real ${label.endsWith('file') ? 'file' : 'directory'} and try again.`,
      'symlink',
    )
  }
}

export function sessionCronDirectory(projectDir: string): string {
  return join(projectDir, NESSY_AGENT_PROJECT_DIR, SESSION_CRON_DIR)
}

export function sessionCronFile(projectDir: string, sessionId: string): string {
  return join(sessionCronDirectory(projectDir), `${assertCronSessionId(sessionId)}.json`)
}

/**
 * Run the whole `:217` check for one store path: the project namespace
 * directory, the crons directory inside it, and this session's task file.
 * Exported so a caller can decide scheduling is unavailable BEFORE it builds a
 * record it would then have to throw away.
 */
export function assertCronPathWritable(projectDir: string, sessionId: string): void {
  assertNotSymlink(join(projectDir, NESSY_AGENT_PROJECT_DIR), `the ${NESSY_AGENT_PROJECT_DIR} directory`)
  assertNotSymlink(sessionCronDirectory(projectDir), 'the scheduled-task directory')
  assertNotSymlink(sessionCronFile(projectDir, sessionId), 'the scheduled-task file')
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * An 8-character id (`:168`). Lowercase alphanumeric so it survives being typed
 * back by the model into `CronDelete` without case ambiguity.
 */
export function generateSessionCronId(
  taken: ReadonlySet<string> = new Set(),
  random: () => number = Math.random,
): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    let id = ''
    for (let index = 0; index < SESSION_CRON_ID_LENGTH; index += 1) {
      id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? '0'
    }
    if (!taken.has(id)) return id
  }
  throw new Error('cron-store: could not mint a free 8-character task id')
}

function emptyState(): SessionCronListState {
  return { schemaVersion: 1, tasks: [] }
}

function isRecord(value: unknown): value is SessionCronRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SessionCronRecord>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length === SESSION_CRON_ID_LENGTH &&
    typeof candidate.schedule === 'string' &&
    typeof candidate.recurring === 'boolean' &&
    typeof candidate.prompt === 'string' &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    // The R39 fields stay OPTIONAL in both directions: a record without them
    // (written by an older build) loads unchanged, and a record carrying them
    // survives this filter. Present-but-mistyped degrades to "dropped", the
    // same posture the corrupt-file path takes.
    (candidate.dynamic === undefined || typeof candidate.dynamic === 'boolean') &&
    (candidate.nextFireAt === undefined ||
      (typeof candidate.nextFireAt === 'number' && Number.isFinite(candidate.nextFireAt))) &&
    (candidate.fallbackArmed === undefined || typeof candidate.fallbackArmed === 'boolean') &&
    (candidate.promptSource === undefined || candidate.promptSource === 'loop-md') &&
    (candidate.owedFire === undefined || typeof candidate.owedFire === 'boolean') &&
    // P6.376 — same posture. `effort` is checked against the LEVEL union
    // rather than `typeof string`, so a record carrying a tier (or any other
    // word) is dropped here instead of reaching the dispatch and being handed
    // to a setter that would refuse it mid-delivery.
    (candidate.model === undefined || typeof candidate.model === 'string') &&
    (candidate.effort === undefined
      || (THINKING_LEVEL_IDS as readonly string[]).includes(candidate.effort as string))
  )
}

/**
 * `readState` plus the one fact the adoption path needs and no reader does:
 * whether anything in the file was UNREADABLE — the JSON did not parse, `tasks`
 * was not an array, or an entry failed {@link isRecord}. Every normal caller
 * wants the degrade-to-empty behaviour below; only {@link
 * adoptLegacySessionCronStore} has to tell "this store legitimately holds no
 * tasks" from "this store holds something we could not read", because it is
 * about to DELETE the file it read.
 */
function readStateDetailed(file: string): { state: SessionCronListState; damaged: boolean } {
  if (!existsSync(file)) return { state: emptyState(), damaged: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionCronListState>
    if (!Array.isArray(parsed?.tasks)) return { state: emptyState(), damaged: true }
    const tasks = parsed.tasks.filter(isRecord)
    return { state: { schemaVersion: 1, tasks }, damaged: tasks.length !== parsed.tasks.length }
  } catch (error) {
    // A corrupt file degrades to "no scheduled tasks" rather than taking the
    // session down: nothing here is user data that cannot be recreated.
    debug(`[cron-store] unreadable scheduled-task file ${file}: ${String(error)}`)
    return { state: emptyState(), damaged: true }
  }
}

function readState(file: string): SessionCronListState {
  return readStateDetailed(file).state
}

function writeState(file: string, state: SessionCronListState): void {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

export interface SessionCronStore {
  readonly file: string
  /** Every stored task, oldest first. */
  list(): readonly SessionCronRecord[]
  /**
   * Add one task. Refuses past the documented cap and refuses a symlinked path;
   * both throw {@link SessionCronStoreError}.
   */
  create(input: {
    schedule: string
    recurring: boolean
    prompt: string
    now?: number
    dynamic?: boolean
    nextFireAt?: number
    promptSource?: 'loop-md'
    /** P6.376 — the model and effort level this task's runs dispatch on. */
    model?: string
    effort?: ThinkingLevel
  }): SessionCronRecord
  /** Remove by id. Returns the removed record, or `undefined` when unknown. */
  remove(id: string): SessionCronRecord | undefined
  /** Record a fire so the no-catch-up rule has a last-fired stamp to read. */
  markFired(id: string, at: number): void
  /**
   * Rewrite a dynamic record's pending wakeup the way `markFired` rewrites
   * `lastFiredAt`. `nextFireAt: undefined` clears it (the loop is over unless
   * the running iteration reschedules). `fallbackArmed` REPLACES the marker
   * outright: `true` when the service arms its one ~20-minute fallback
   * (`scheduled-tasks.md:130`), `false`/omitted for a model reschedule, which
   * always returns the loop to normal. Unknown ids are ignored.
   */
  rearm(id: string, nextFireAt: number | undefined, fallbackArmed?: boolean): void
  /**
   * P6.295 arm (2) — pause or resume one task without deleting it. Returns the
   * updated record, or `undefined` for an unknown id, so a caller can report
   * "no such task" rather than silently succeeding.
   *
   * Setting the state it is already in is a no-op that still returns the record:
   * pausing a paused task is not an error, and refusing it would make an
   * idempotent control fail on a retry.
   */
  setPaused(id: string, paused: boolean): SessionCronRecord | undefined
  /**
   * P6.295 arm (2) — mark this task's deliveries as read, clearing
   * {@link SessionCronRecord.unreadRuns}. Returns `false` for an unknown id.
   */
  acknowledgeRuns(id: string): boolean
  /** Replace the whole list — used by the resume sweep, which drops expired records. */
  replace(tasks: readonly SessionCronRecord[]): void
  /** Delete the store file entirely. A fresh conversation clears everything (`:216`). */
  clear(): void
}

/**
 * Where a store's project namespace lives — either a fixed path, or a function
 * the store calls every time it is about to touch the filesystem.
 *
 * T8 (b): the function form exists because the caller used to capture
 * `managed.workingDirectory ?? managed.workspace.rootPath` ONCE, in the closure
 * that built the service, and hold it for the service's whole lifetime. A
 * session whose anchor moved afterwards kept reading and writing the old path.
 * Resolving at store open — meaning at each operation, which is when the store
 * opens the file — is what removes that class of staleness entirely.
 */
export type SessionCronProjectDir = string | (() => string)

/**
 * Open (without creating) this session's store. Every method re-reads the file,
 * so a store handle holds no state that can go stale against another writer —
 * and, with a resolver, not even the DIRECTORY is held.
 */
export function openSessionCronStore(
  projectDir: SessionCronProjectDir,
  sessionId: string,
): SessionCronStore {
  const resolveProjectDir = typeof projectDir === 'function' ? projectDir : () => projectDir

  const persist = (tasks: readonly SessionCronRecord[]): void => {
    const root = resolveProjectDir()
    assertCronPathWritable(root, sessionId)
    mkdirSync(sessionCronDirectory(root), { recursive: true })
    writeState(sessionCronFile(root, sessionId), { schemaVersion: 1, tasks })
  }
  const currentFile = (): string => sessionCronFile(resolveProjectDir(), sessionId)

  return {
    get file() { return currentFile() },
    list: () => readState(currentFile()).tasks,

    create({ schedule, recurring, prompt, now, dynamic, nextFireAt, promptSource, model, effort }) {
      // The path check runs FIRST, before the cap and before the id: `:217`
      // makes a symlinked store a refusal to schedule at all, and a record
      // minted against a path we will not write to is a lie in the result.
      assertCronPathWritable(resolveProjectDir(), sessionId)
      const tasks = readState(currentFile()).tasks
      if (tasks.length >= MAX_SESSION_CRON_TASKS) {
        throw new SessionCronStoreError(
          `This session already holds the maximum of ${MAX_SESSION_CRON_TASKS} scheduled tasks. Cancel one with CronDelete before scheduling another.`,
          'capacity',
        )
      }
      const record: SessionCronRecord = {
        id: generateSessionCronId(new Set(tasks.map(task => task.id))),
        schedule,
        recurring,
        prompt,
        createdAt: now ?? Date.now(),
        ...(dynamic ? { dynamic: true } : {}),
        ...(nextFireAt !== undefined ? { nextFireAt } : {}),
        ...(promptSource ? { promptSource } : {}),
        // P6.376 — dropped at rest, so a record with neither field is
        // byte-identical to one written before they existed.
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }
      persist([...tasks, record])
      return record
    },

    remove(id) {
      const tasks = readState(currentFile()).tasks
      const found = tasks.find(task => task.id === id)
      if (!found) return undefined
      persist(tasks.filter(task => task.id !== id))
      return found
    },

    markFired(id, at) {
      const tasks = readState(currentFile()).tasks
      if (!tasks.some(task => task.id === id)) return
      // P6.295 arm (2) — the unread counter rides the SAME write as the cursor,
      // because they record the same event. A separate store call would be a
      // second read-modify-write of the same file and could land on its own.
      persist(tasks.map(task => (
        task.id === id
          ? { ...task, lastFiredAt: at, unreadRuns: (task.unreadRuns ?? 0) + 1 }
          : task
      )))
    },

    setPaused(id, paused) {
      const tasks = readState(currentFile()).tasks
      const found = tasks.find(task => task.id === id)
      if (!found) return undefined
      // The field is DROPPED rather than written `false`, the same shape `rearm`
      // uses for its markers: an absent optional is the resting state, so a
      // resumed record is byte-identical to one that was never paused and the
      // store file does not grow a key per lifecycle event.
      const updated: SessionCronRecord = paused
        ? { ...found, paused: true }
        : (({ paused: _paused, ...rest }) => rest)(found)
      persist(tasks.map(task => (task.id === id ? updated : task)))
      return updated
    },

    acknowledgeRuns(id) {
      const tasks = readState(currentFile()).tasks
      const found = tasks.find(task => task.id === id)
      if (!found) return false
      if (found.unreadRuns === undefined) return true
      persist(tasks.map(task => (
        task.id === id ? (({ unreadRuns: _unread, ...rest }) => rest)(task) : task
      )))
      return true
    },

    rearm(id, nextFireAt, fallbackArmed) {
      const tasks = readState(currentFile()).tasks
      if (!tasks.some(task => task.id === id)) return
      persist(tasks.map(task => {
        if (task.id !== id) return task
        const { nextFireAt: _next, fallbackArmed: _marker, ...rest } = task
        return {
          ...rest,
          ...(nextFireAt !== undefined ? { nextFireAt } : {}),
          ...(fallbackArmed ? { fallbackArmed: true } : {}),
        }
      }))
    },

    replace(tasks) {
      persist(tasks)
    },

    clear() {
      rmSync(currentFile(), { force: true })
    },
  }
}

/**
 * T8 (a) — adopt a store left behind at a legacy anchor.
 *
 * The anchor moved from `workingDirectory ?? workspace.rootPath` to
 * `workspace.rootPath` alone, because the working directory is not stable for
 * the life of a session: a worktree session wrote
 * `<worktree>/.nessy-agent/crons/`, and every runtime switch forces an
 * `ExitWorktree` first, so the store the next `restore()` read was a different
 * file from the one the records were written to.
 *
 * The adoption is deliberately the SIMPLE product decision rather than a
 * general merge policy: legacy records that the root store does not already
 * hold are appended (root wins on a shared id, and the documented 50-task cap
 * is still the cap), the merged list is written to the ROOT first, and only
 * then is the legacy file removed. Failure order matters — a crash before the
 * root write leaves the legacy file untouched and the next open retries.
 *
 * T10 — the removal is skipped outright whenever ANYTHING was dropped, and the
 * answer is then `'partial'`. Two ways that happens, and the first `rmSync`
 * treated both as success: the merge hit the 50-task cap, so the tail of the
 * legacy list never reached the root; or the legacy file was DAMAGED (bad JSON,
 * a `tasks` that is not an array, an entry that failed validation), which
 * `readState` reports as an empty list and the old code read as "an empty
 * legacy file carries nothing to lose". Deleting it costs the user their
 * schedule with no trace, which is the failure this whole row exists to stop.
 *
 * T10 fix wave — but "keep the file as it was" was the wrong shape of not
 * deleting, and it RESURRECTED cancelled schedules. A retained file is re-read
 * by the next adoption (a service rebuilt after a restart or a runtime switch is
 * a map miss, so the adoption runs again), and the records it still holds are
 * appended to the root a second time — including the one the user cancelled at
 * the root with `CronDelete` in between. Probed end to end: merge → `CronDelete`
 * → re-adopt put the cancelled record back. So neither drop keeps the file as it
 * was:
 *
 * - a DAMAGED file is QUARANTINED — renamed to `<sessionId>.json{@link
 *   DAMAGED_LEGACY_CRON_SUFFIX}` — after its readable records are merged. It
 *   still exists for a human to inspect or salvage, and it is never read again
 *   by anything, so it can neither re-merge nor keep costing a read on every
 *   service open;
 * - the CAP case REWRITES the legacy file with the un-merged TAIL only. An id
 *   that reached the root is no longer in the file, so it cannot come back; the
 *   records that did not fit are still exactly where a later attempt — after the
 *   user cancels a task at the root — will find them, and the file disappears on
 *   its own once the tail fits.
 *
 * Damage wins when both apply: rewriting a damaged file with its readable tail
 * would discard the unreadable entries silently, which is the one thing keeping
 * the file was for.
 *
 * Measured before it was written (2026-08-23, owner profile + both CDP config
 * dirs): every `.nessy-agent/crons` directory in existence sat at a WORKSPACE
 * root, i.e. on sessions that had no working directory and already resolved to
 * the new anchor. Zero stores existed under a project or worktree path, so this
 * path is a safety net for sessions created between then and the upgrade, not a
 * bulk migration.
 *
 * Never throws: a symlinked or unreadable legacy path is reported as `'failed'`
 * and scheduling continues against the root store.
 */
export function adoptLegacySessionCronStore(input: {
  legacyProjectDir: string
  projectDir: string
  sessionId: string
}): 'not-needed' | 'adopted' | 'partial' | 'failed' {
  const { legacyProjectDir, projectDir, sessionId } = input
  try {
    const legacyFile = sessionCronFile(legacyProjectDir, sessionId)
    if (legacyFile === sessionCronFile(projectDir, sessionId)) return 'not-needed'
    if (!existsSync(legacyFile)) return 'not-needed'

    const { state, damaged } = readStateDetailed(legacyFile)
    const legacyTasks = state.tasks
    // A record the ROOT already holds under the same id is not stranded: the id
    // survives the adoption, deliberately in the root's version. Only the cap
    // strands a record, and only damage makes one unreadable.
    const stranded: SessionCronRecord[] = []
    if (legacyTasks.length > 0) {
      const store = openSessionCronStore(projectDir, sessionId)
      const held = store.list()
      const known = new Set(held.map(task => task.id))
      const merged = [...held]
      for (const task of legacyTasks) {
        if (known.has(task.id)) continue
        if (merged.length >= MAX_SESSION_CRON_TASKS) { stranded.push(task); continue }
        merged.push(task)
      }
      if (merged.length !== held.length) store.replace(merged)
    }
    if (damaged) {
      // Quarantine, not retention: the file leaves the adoption path for good,
      // so what was merged out of it can never be merged a second time, and the
      // unreadable remainder is still on disk under a name only a human reads.
      // The rename REPLACES an existing quarantine, which needs a downgrade to
      // a pre-T8 build to reach at all and by then both sides are unreadable.
      renameSync(legacyFile, `${legacyFile}${DAMAGED_LEGACY_CRON_SUFFIX}`)
      debug(`[cron-store] quarantined the damaged legacy store for ${sessionId}: ${legacyFile}${DAMAGED_LEGACY_CRON_SUFFIX}`)
      return 'partial'
    }
    if (stranded.length > 0) {
      // The un-merged TAIL, and nothing else. `writeState` writes a temp file and
      // renames over the target, so a symlinked legacy file is replaced rather
      // than written through — the same posture `rmSync` had here before.
      writeState(legacyFile, { schemaVersion: 1, tasks: stranded })
      debug(`[cron-store] kept ${stranded.length} un-adopted record(s) at the legacy anchor for ${sessionId}`)
      return 'partial'
    }
    // Only after the root store holds them. An empty legacy file that PARSED
    // carries nothing to lose, so it is simply cleared away.
    rmSync(legacyFile, { force: true })
    return 'adopted'
  } catch (error) {
    debug(`[cron-store] could not adopt the legacy store for ${sessionId}: ${String(error)}`)
    return 'failed'
  }
}
