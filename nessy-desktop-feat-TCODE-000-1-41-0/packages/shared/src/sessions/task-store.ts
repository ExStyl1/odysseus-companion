/**
 * The file-backed task store (R20 Task 3).
 *
 * Contract source:
 * - `interactive-mode.md:396` — "To share a task list across sessions, set
 *   `CLAUDE_CODE_TASK_LIST_ID` to use a named directory in `~/.claude/tasks/`."
 *   Ours is `NESSY_TASK_LIST_ID` under `<configDir>/tasks/`.
 * - `agent-teams.md` — the default directory name is `session-` plus the first
 *   eight characters of the session ID; the list "persists locally and is never
 *   uploaded, so resumed sessions keep their tasks"; and "Retention is governed
 *   by the same `cleanupPeriodDays` you already control for session
 *   transcripts."
 * - `interactive-mode.md:394` — "Tasks persist across context compactions."
 *
 * Why a separate root instead of the session record: the list must be shareable
 * BETWEEN sessions, which a per-session record cannot express. Compaction
 * persistence falls out of the same choice — compaction rewrites transcript
 * history and never reaches this root.
 *
 * Retention rides R12's existing sweep: `runRetentionSweep` gained a `tasks`
 * config-root class, so the same `cleanupPeriodDays` cutoff and the same single
 * pass age out abandoned lists. There is deliberately no second sweeper.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createDocumentedTaskState,
  formatTaskId,
  runDocumentedTaskCommand,
  type DocumentedTaskCommand,
  type DocumentedTaskListState,
  type DocumentedTaskRecord,
  type DocumentedTaskResult,
} from '@nessy-agent/session-tools-core'
import { CONFIG_DIR } from '../config/paths.ts'
import { debug } from '../utils/debug.ts'

/** Directory under the config root that holds every task list. */
export const DEFAULT_TASK_LIST_ROOT = 'tasks'

/**
 * How far past the read `nextId` a claim probes before giving up. Only a peer
 * holding a run of consecutive ids pushes past a handful, so a bound this size
 * turns a corrupt directory into an error instead of an infinite loop.
 */
const MAX_ID_CLAIM_ATTEMPTS = 1_000

/** Per-list bookkeeping that is not itself a task. */
const META_FILE = 'list.json'
const TASK_FILE = 'task.json'

/**
 * Same constraint the retention sweep applies to workspace/session ids. A list
 * id reaches the filesystem, so a traversal or an empty segment is refused here
 * rather than sanitised into something surprising.
 */
const LIST_ID_PATTERN = /^[A-Za-z0-9._-]+$/

export function assertTaskListId(listId: string): string {
  if (!LIST_ID_PATTERN.test(listId) || listId === '.' || listId === '..') {
    throw new Error(`Invalid task list id: ${JSON.stringify(listId)}`)
  }
  return listId
}

/** `<configDir>/tasks/<listId>` — the documented per-list directory. */
export function taskListDirectory(listId: string, configDir: string = CONFIG_DIR): string {
  return join(configDir, DEFAULT_TASK_LIST_ROOT, assertTaskListId(listId))
}

/**
 * `NESSY_TASK_LIST_ID` wins; otherwise `session-` + the first eight characters
 * of the session id, which is the documented default naming.
 */
export function resolveTaskListId(
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const shared = env.NESSY_TASK_LIST_ID?.trim()
  if (shared) return assertTaskListId(shared)
  return assertTaskListId(`session-${sessionId.slice(0, 8)}`)
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Atomic within a directory: a torn write must never become a torn task list. */
function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temporary, path)
}

interface TaskListMeta {
  schemaVersion: 1
  nextId: number
}

/**
 * Read the whole list off disk. One directory per task, so a partially written
 * or hand-deleted task degrades to "that task is gone" instead of losing the
 * list — which is the reason for the per-task layout rather than one blob.
 */
function loadState(dir: string): DocumentedTaskListState {
  if (!existsSync(dir)) return createDocumentedTaskState()
  const meta = readJson<TaskListMeta>(join(dir, META_FILE))
  const tasks: DocumentedTaskRecord[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    debug(`[task-store] unreadable task list ${dir}: ${String(error)}`)
    return createDocumentedTaskState()
  }
  for (const name of entries) {
    const record = readJson<DocumentedTaskRecord>(join(dir, name, TASK_FILE))
    if (!record || record.id !== name) continue
    tasks.push({ ...record, blocks: record.blocks ?? [], blockedBy: record.blockedBy ?? [] })
  }
  // Ids are zero-padded and monotonic, so lexicographic order is creation order
  // — the order `TaskList` reports and the checklist renders.
  tasks.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const highest = tasks.reduce((max, task) => {
    const parsed = Number.parseInt(task.id.replace(/^task-/, ''), 10)
    return Number.isFinite(parsed) && parsed > max ? parsed : max
  }, 0)
  return {
    schemaVersion: 1,
    // A missing/corrupt meta must never rewind the counter into reusing an id.
    nextId: Math.max(meta?.nextId ?? 1, highest + 1),
    tasks,
  }
}

/** Write only what changed; a no-op command must not churn the directory. */
function persistState(
  dir: string,
  previous: DocumentedTaskListState,
  next: DocumentedTaskListState,
): void {
  mkdirSync(dir, { recursive: true })
  if (previous.nextId !== next.nextId || !existsSync(join(dir, META_FILE))) {
    writeJson(join(dir, META_FILE), { schemaVersion: 1, nextId: next.nextId } satisfies TaskListMeta)
  }
  const before = new Map(previous.tasks.map(task => [task.id, JSON.stringify(task)]))
  for (const task of next.tasks) {
    // A tombstoned task leaves the disk entirely: it is unreadable through every
    // documented read, so keeping its directory would only leak subjects.
    if (task.deleted) {
      rmSync(join(dir, task.id), { recursive: true, force: true })
      continue
    }
    const serialized = JSON.stringify(task)
    if (before.get(task.id) === serialized) continue
    mkdirSync(join(dir, task.id), { recursive: true })
    writeJson(join(dir, task.id, TASK_FILE), task)
  }
}

/**
 * Reserve the next free id by creating its directory exclusively. `mkdir`
 * WITHOUT `recursive` fails with EEXIST when the directory already exists,
 * which makes it an atomic claim across processes on POSIX and Windows alike —
 * no lock file, no daemon. Returns the state whose `nextId` is the claim, so
 * the reducer mints exactly the id we hold.
 */
function claimTaskId(dir: string, from: number): DocumentedTaskListState {
  mkdirSync(dir, { recursive: true })
  const start = Math.max(1, from)
  for (let candidate = start; candidate < start + MAX_ID_CLAIM_ATTEMPTS; candidate += 1) {
    try {
      mkdirSync(join(dir, formatTaskId(candidate)))
      return { schemaVersion: 1, nextId: candidate, tasks: loadState(dir).tasks }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`task-store: no free task id after ${MAX_ID_CLAIM_ATTEMPTS} attempts in ${dir}`)
}

export interface TaskStore {
  readonly listId: string
  readonly directory: string
  /** Run one documented command, persisting whatever it changed. */
  run(command: DocumentedTaskCommand): { state: DocumentedTaskListState; result: DocumentedTaskResult }
  /** Current list, re-read from disk. */
  snapshot(): DocumentedTaskListState
}

/**
 * Open the list at `listId`. Every call re-reads from disk before running, so
 * two sessions sharing one `NESSY_TASK_LIST_ID` genuinely share a list instead
 * of racing two in-memory copies of it.
 */
export function openTaskStore(listId: string, configDir: string = CONFIG_DIR): TaskStore {
  const directory = taskListDirectory(listId, configDir)
  return {
    listId,
    directory,
    snapshot: () => loadState(directory),
    run(command) {
      const previous = loadState(directory)
      // A create CLAIMS its id on disk before the reducer mints it. `loadState`
      // derives `nextId` from what it can read, so two writers on a shared list
      // (`NESSY_TASK_LIST_ID`) would both pick the same number and the second
      // write would overwrite the first — and a directory a peer claimed but
      // has not filled yet is invisible to that scan, so the number looks free.
      const claimed = command.op === 'create' ? claimTaskId(directory, previous.nextId) : previous
      const outcome = runDocumentedTaskCommand(claimed, command)
      if (command.op === 'create' || command.op === 'update') {
        persistState(directory, claimed, outcome.state)
      }
      return outcome
    },
  }
}
