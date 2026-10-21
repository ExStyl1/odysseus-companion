import { createHash } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AgentProvider } from '../agent/backend/types.ts'
import type { HarnessToolDescriptor } from '../agent/pi-harness/harness-tool-descriptor.ts'
import {
  CHECKPOINT_RETENTION,
  planCheckpointGc,
  type CheckpointGcBaseline,
} from './checkpoint-gc.ts'
import { debug } from '../utils/debug.ts'
// P6.272 — read INSIDE `createFileCheckpoint`, never at module scope; see there.
import { getFileCheckpointingEnabled } from '../config/storage.ts'

const CHECKPOINT_DIR = 'file_checkpoints'
const CHECKPOINT_FILES_DIR = 'files'
const MANIFEST_FILE = 'manifest.json'

/**
 * Which runtimes actually PRODUCE file checkpoints — the fact every rewind
 * surface has been reporting as if it were universal.
 *
 * `createFileCheckpoint` has exactly two non-test callers in this tree, and this
 * record is their inventory rather than a wish list:
 *
 * | runtime | producer |
 * | :-- | :-- |
 * | `pi` | `packages/pi-agent-server/src/index.ts` — `beforeDispatch`, keyed by `descriptor.checkpointAdapter` |
 * | `nestor-cloud-agent` | `packages/shared/src/agent/backend/nestor-cloud/tool-executor.ts` |
 * | `anthropic` | none of OURS. Since P6.851 the SDK checkpoints natively when `fileCheckpointingEnabled` is on, into its own store; `Query.rewindFiles` still has no call site here |
 * | `codex-runtime` | `packages/shared/src/agent/codex-agent.ts` — `checkpointCodexFileChange`, on codex's own pre-write `item/started` for a `fileChange` item |
 *
 * The consumers — the session menu's revert, the conversation rewind's
 * `restoreFiles`, and the `rewind_checkpoint` runtime request — were written
 * against the manifest alone, which is EMPTY rather than absent on the two
 * runtimes with no producer. An empty manifest is indistinguishable from "the
 * agent edited nothing", so the rewind reported success for an operation that
 * could not have happened. This record is what lets a caller tell the two apart
 * and say so.
 *
 * It is a `Record<AgentProvider, …>` on purpose, per `runtime-vocabulary.ts`'s
 * property: a new runtime must BREAK THE BUILD here rather than inherit a
 * silent `true`. Defaulting open would re-create the exact lie.
 *
 * C3.67 (2026-09-12) turned `codex-runtime` TRUE, and the order matters: the
 * boolean followed a call site rather than the other way round, because two
 * booleans are not a switch. The previous entry read *"none, and no upstream API
 * to wire"* and the second half of that was the part to re-ask — codex's own
 * generated `ThreadRevertParams` says *"It does not revert local file changes"*
 * (`ThreadRollbackParams` said so until `rust-v0.156.1` removed it), and `item/started` for a `fileChange` is its pre-write
 * announcement of every path a patch is about to touch. The producer takes the
 * pre-image there and closes it on `item/completed`, through THIS function, so
 * the manifest, the rewind, the skip reasons and the per-turn diff are the same
 * ones Pi uses. The residue — codex does not wait for our snapshot — is stated
 * at the call site and measured by `codex-file-change-preimage-e2e.test.ts`.
 *
 * P6.851 (2026-09-10) turned the SDK's OWN checkpointing on for claude, behind
 * the same `fileCheckpointingEnabled` setting. `anthropic` stays `false` here,
 * and that is not an oversight: this record answers *"does OUR manifest have
 * entries for this runtime"*, which is what every consumer below actually reads,
 * and the SDK's store is reachable only through `Query.rewindFiles()`, which
 * this tree still never calls. `file-checkpoint-producers.test.ts` pins the
 * record against the real `createFileCheckpoint` call sites, so it cannot drift
 * into a claim either way.
 */
export const RUNTIME_FILE_CHECKPOINT_PRODUCERS = Object.freeze({
  pi: true,
  'nestor-cloud-agent': true,
  anthropic: false,
  'codex-runtime': true,
} as const) satisfies Record<AgentProvider, boolean>

/**
 * Does a session on `provider` get its file edits checkpointed at all?
 *
 * A runtime this build does not know answers `false` — the honest answer for a
 * producer nobody has written, and the one that makes a surface say "not
 * tracked" instead of promising a restore. `getLlmConnections()` returns stored
 * config with no per-field validation, so an unknown provider really can arrive
 * here (P2.205).
 */
export function runtimeProducesFileCheckpoints(provider: string | undefined): boolean {
  if (!provider) return false
  return (RUNTIME_FILE_CHECKPOINT_PRODUCERS as Readonly<Record<string, boolean>>)[provider] === true
}

/**
 * Why a rewind refused to touch a tracked path.
 *
 * The taxonomy is the documented one. `agent-sdk/typescript.md` (found at :4266
 * on 2026-07-29) defines `skippedLinks` as counting "a symlink, hard link, or
 * other non-regular file at the tracked path, a parent directory that no longer
 * resolves to where it pointed when the checkpoint was taken, or a backup that
 * couldn't be read safely".
 */
export type FileCheckpointSkipReason =
  | 'symlink'
  | 'hard-link'
  | 'not-a-regular-file'
  | 'parent-directory-missing'
  | 'parent-directory-moved'
  | 'snapshot-unreadable'

/** One tracked path a rewind declined to restore or delete, and why. */
export interface FileCheckpointSkippedPath {
  filePath: string
  reason: FileCheckpointSkipReason
}

/**
 * One plain sentence per {@link FileCheckpointSkipReason}.
 *
 * EXPORTED since P6.279, because the headless rewind (`nessy-general-agent
 * session rewind`) has to name the same reasons the app names and has no i18n
 * bundle to name them from. The renderer keeps its own key map
 * (`renderer/utils/checkpoint-skip.ts`) so it can translate; that map and this
 * one are the same taxonomy rendered for two audiences, and both are exhaustive
 * over the union, so a new reason cannot ship without a sentence on either
 * surface.
 */
export const SKIP_REASON_TEXT: Readonly<Record<FileCheckpointSkipReason, string>> = Object.freeze({
  'symlink': 'the tracked path is now a symlink',
  'hard-link': 'the tracked path now shares its inode with another name',
  'not-a-regular-file': 'the tracked path is no longer a regular file',
  'parent-directory-missing': 'the parent directory no longer exists',
  'parent-directory-moved': 'the parent directory no longer resolves to its checkpoint-time location',
  'snapshot-unreadable': 'the checkpoint snapshot could not be read safely',
})

export interface FileCheckpointEntry {
  id: string
  adapter: NonNullable<HarnessToolDescriptor['checkpointAdapter']>
  toolName: string
  toolCallId?: string
  filePath: string
  /**
   * Canonical location of the tracked file's parent directory at checkpoint
   * time. A rewind re-resolves the parent and refuses when it no longer lands
   * here. Absent on manifests written before link safety existed, and on
   * checkpoints whose parent did not exist yet; the weaker "the parent path is
   * still a real directory" check covers those.
   */
  parentRealPath?: string
  existed: boolean
  snapshotFile?: string
  mode?: number
  preimageDigest?: string
  postimageDigest?: string
  postimageExists?: boolean
  postimageMode?: number
  outcome?: 'applied' | 'no-op' | 'failed'
  changed?: boolean
  createdAt: string
  completedAt?: string
  revertedAt?: string
}

export interface FileCheckpointRuntimeEntry extends FileCheckpointEntry {
  currentDigest?: string
  currentExists: boolean
  currentMode?: number
  conflict: boolean
}

interface FileCheckpointManifest {
  version: 1
  entries: FileCheckpointEntry[]
  /**
   * Per-file first snapshots the GC pinned after their checkpoint aged out of
   * the retention window — the session-diff baseline. Absent on manifests
   * written before the GC existed, which reads as "no pins yet".
   */
  baselines?: CheckpointGcBaseline[]
}

/** Outcome of one checkpoint GC pass. Identical shape for a dry run and a real one. */
export interface FileCheckpointGcResult {
  dryRun: boolean
  discardedCheckpointIds: string[]
  /** Snapshot files removed (or, in a dry run, the exact set that would be). */
  deletedSnapshotFiles: string[]
  /** Snapshot files kept only by the first-snapshot pin. */
  pinnedSnapshotFiles: string[]
  /** Snapshot files the plan named but that could not be removed. */
  failedSnapshotFiles: string[]
}

export interface CreateFileCheckpointOptions {
  sessionPath: string
  adapter: NonNullable<HarnessToolDescriptor['checkpointAdapter']>
  toolName: string
  toolCallId?: string
  baseDirectory?: string
  input: Record<string, unknown>
  /** Exact canonical target already admitted by the session filesystem scope. */
  authorizedTarget?: string
}

export interface FinalizeFileCheckpointOptions {
  sessionPath: string
  checkpointId: string
  succeeded: boolean
}

export interface RevertFileCheckpointOptions {
  sessionPath: string
  checkpointId?: string
}

export interface FileCheckpointRevertResult {
  success: boolean
  checkpointId?: string
  filePath?: string
  restored?: boolean
  deleted?: boolean
  error?: string
  irreversibleEffects?: readonly string[]
  contentRestored?: boolean
  modeRestored?: boolean
  targetExistedAtRewind?: boolean
  deletionCompleted?: boolean
  manifestPersisted?: boolean
  alreadyAbsent?: boolean
  alreadyReverted?: boolean
  conflict?: boolean
  expectedDigest?: string
  currentDigest?: string
  partial?: boolean
  /**
   * How many tracked paths this rewind refused to touch for link safety —
   * `RewindFilesResult.skippedLinks` in Claude's shape. One checkpoint owns one
   * path, so this is 0 or 1 here; the aggregate belongs to whatever walks a set
   * of checkpoints.
   */
  skippedLinks?: number
  /** The skipped paths behind `skippedLinks`, so a report can name them. */
  skippedPaths?: readonly FileCheckpointSkippedPath[]
}

export const FILE_CHECKPOINT_REWIND_LIMITS = Object.freeze([
  'bash', 'mcp', 'network', 'external',
] as const)

const checkpointMutations = new Map<string, Promise<void>>()

async function serializeCheckpointMutation<T>(sessionPath: string, run: () => Promise<T>): Promise<T> {
  const previous = checkpointMutations.get(sessionPath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = previous.catch(() => undefined).then(() => current)
  checkpointMutations.set(sessionPath, queued)
  await previous.catch(() => undefined)
  try { return await run() }
  finally {
    release()
    if (checkpointMutations.get(sessionPath) === queued) checkpointMutations.delete(sessionPath)
  }
}

function getCheckpointPath(sessionPath: string): string {
  return join(sessionPath, CHECKPOINT_DIR)
}

function getManifestPath(sessionPath: string): string {
  return join(getCheckpointPath(sessionPath), MANIFEST_FILE)
}

function getFilePathFromInput(input: Record<string, unknown>): string | null {
  const filePath = input.file_path ?? input.notebook_path ?? input.path
  return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath : null
}

function safeSnapshotName(filePath: string): string {
  const name = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  return name || 'file'
}

function makeCheckpointId(toolCallId: string | undefined, filePath: string, index: number): string {
  const seed = `${Date.now()}:${toolCallId ?? ''}:${filePath}:${index}`
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

/**
 * The id seed includes the entry index, which used to be strictly increasing.
 * The GC trims entries, so an index can be re-issued — and a re-issued id inside
 * the same millisecond for the same tool call and path would collide with a live
 * checkpoint or a pinned baseline. Walk the index forward until it does not.
 */
function makeUniqueCheckpointId(
  manifest: FileCheckpointManifest,
  toolCallId: string | undefined,
  filePath: string,
): string {
  const taken = new Set<string>([
    ...manifest.entries.map(entry => entry.id),
    ...(manifest.baselines ?? []).map(baseline => baseline.checkpointId),
  ])
  let index = manifest.entries.length
  let id = makeCheckpointId(toolCallId, filePath, index)
  while (taken.has(id)) id = makeCheckpointId(toolCallId, filePath, ++index)
  return id
}

interface FileState {
  exists: boolean
  digest?: string
  mode?: number
  bytes?: Buffer
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readFileState(filePath: string, includeBytes = false): Promise<FileState> {
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) throw new Error('Checkpoint target is not a regular file')
    const bytes = await readFile(filePath)
    return {
      exists: true,
      digest: digestBytes(bytes),
      mode: fileStat.mode & 0o777,
      ...(includeBytes ? { bytes } : {}),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
}

/**
 * `O_NOFOLLOW` is POSIX-only. Windows has no symlink-at-final-component race to
 * close here, and `?? 0` keeps the open flags valid there.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

interface RewindTargetInspection {
  present: boolean
  skip?: FileCheckpointSkipReason
}

/**
 * What sits at the tracked path RIGHT NOW, seen with `lstat` so a symlink is a
 * symlink rather than whatever it points at. `stat` cannot answer either
 * question this asks: it follows links, and it reports the target's `nlink`
 * without the caller ever learning a second name exists.
 */
async function inspectRewindTarget(filePath: string): Promise<RewindTargetInspection> {
  let linkStat: Awaited<ReturnType<typeof lstat>>
  try {
    linkStat = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false }
    throw error
  }
  if (linkStat.isSymbolicLink()) return { present: true, skip: 'symlink' }
  if (!linkStat.isFile()) return { present: true, skip: 'not-a-regular-file' }
  // A hard link has no second path for the filesystem scope to check — the
  // aliases are indistinguishable — so the link count is the only signal.
  if (linkStat.nlink > 1) return { present: true, skip: 'hard-link' }
  return { present: true }
}

/**
 * Re-resolve the tracked file's parent against its checkpoint-time location.
 * A missing parent is a refusal, not an invitation to `mkdir -p`: recreating a
 * directory the user deleted restores into a tree that no longer exists.
 */
async function inspectRewindParent(entry: FileCheckpointEntry): Promise<FileCheckpointSkipReason | undefined> {
  const parent = dirname(entry.filePath)
  let parentStat: Awaited<ReturnType<typeof lstat>>
  try {
    parentStat = await lstat(parent)
  } catch {
    return 'parent-directory-missing'
  }
  // `lstat` reports a symlink as a link, never a directory, so a parent swapped
  // for a link to somewhere else is caught even without a recorded location.
  if (!parentStat.isDirectory()) return 'parent-directory-moved'
  if (entry.parentRealPath === undefined) return undefined
  let resolved: string
  try {
    resolved = await realpath(parent)
  } catch {
    return 'parent-directory-missing'
  }
  return resolved === entry.parentRealPath ? undefined : 'parent-directory-moved'
}

/** The stored pre-image, or `undefined` when it is not a readable regular file. */
async function readSnapshotBytes(snapshotPath: string): Promise<Buffer | undefined> {
  try {
    const snapshotStat = await lstat(snapshotPath)
    if (!snapshotStat.isFile() || snapshotStat.nlink > 1) return undefined
    return await readFile(snapshotPath)
  } catch {
    return undefined
  }
}

/**
 * Write the pre-image into the tracked path without ever following a link.
 *
 * `O_NOFOLLOW` closes the window between the `lstat` guard and the write, and
 * the post-open `fstat` re-checks the inode we actually hold — a path swapped
 * for a hard link in between fails here instead of mutating the alias. The old
 * `copyFile` had neither guard: it opened the destination with `O_TRUNC` and
 * rewrote whatever inode the name resolved to.
 */
async function writePreimageWithoutFollowingLinks(
  filePath: string,
  bytes: Buffer,
  mode: number,
): Promise<FileCheckpointSkipReason | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | O_NOFOLLOW, mode)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ELOOP on Linux and macOS, EMLINK on the BSDs: the final component was a
    // symlink and O_NOFOLLOW refused to traverse it.
    if (code === 'ELOOP' || code === 'EMLINK') return 'symlink'
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return 'not-a-regular-file'
    if (opened.nlink > 1) return 'hard-link'
    await handle.truncate(0)
    await handle.write(bytes, 0, bytes.length, 0)
    await handle.chmod(mode)
    return undefined
  } finally {
    await handle.close()
  }
}

function statesMatch(
  expectedExists: boolean,
  expectedDigest: string | undefined,
  expectedMode: number | undefined,
  current: FileState,
): boolean {
  if (current.exists !== expectedExists) return false
  if (!expectedExists) return true
  return current.digest === expectedDigest && current.mode === expectedMode
}

async function readManifest(sessionPath: string): Promise<FileCheckpointManifest> {
  const manifestPath = getManifestPath(sessionPath)
  if (!existsSync(manifestPath)) {
    return { version: 1, entries: [] }
  }

  const raw = await readFile(manifestPath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<FileCheckpointManifest>
  return {
    version: 1,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    ...(Array.isArray(parsed.baselines) ? { baselines: parsed.baselines } : {}),
  }
}

async function writeManifest(sessionPath: string, manifest: FileCheckpointManifest): Promise<void> {
  const checkpointPath = getCheckpointPath(sessionPath)
  await mkdir(checkpointPath, { recursive: true, mode: 0o700 })

  const manifestPath = getManifestPath(sessionPath)
  const tmpPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
  const serializable: FileCheckpointManifest = {
    version: 1,
    entries: manifest.entries,
    // Omit the key entirely while nothing is pinned, so a session that never
    // trips the cap keeps a byte-identical manifest shape.
    ...(manifest.baselines?.length ? { baselines: manifest.baselines } : {}),
  }
  await writeFile(tmpPath, `${JSON.stringify(serializable, null, 2)}\n`, { mode: 0o600 })
  await rename(tmpPath, manifestPath)
}

/**
 * The pinned session-diff baselines for a session. Exposed because a pin whose
 * only trace is a blob on disk is not a baseline anybody can find.
 */
export async function listFileCheckpointBaselines(sessionPath: string): Promise<CheckpointGcBaseline[]> {
  return (await readManifest(sessionPath)).baselines ?? []
}

async function sweepFileCheckpointsUnlocked(
  sessionPath: string,
  options: { retention?: number; dryRun?: boolean } = {},
): Promise<FileCheckpointGcResult> {
  const manifest = await readManifest(sessionPath)
  const retention = options.retention ?? CHECKPOINT_RETENTION
  const dryRun = options.dryRun === true
  const plan = planCheckpointGc({
    checkpoints: manifest.entries.map(entry => ({
      id: entry.id,
      filePath: entry.filePath,
      createdAt: entry.createdAt,
      ...(entry.snapshotFile ? { snapshotFile: entry.snapshotFile } : {}),
    })),
    ...(manifest.baselines ? { baselines: manifest.baselines } : {}),
    retention,
  })

  const result: FileCheckpointGcResult = {
    dryRun,
    discardedCheckpointIds: [...plan.discardedCheckpointIds],
    deletedSnapshotFiles: [],
    pinnedSnapshotFiles: [...plan.pinnedSnapshotFiles],
    failedSnapshotFiles: [],
  }
  if (plan.discardedCheckpointIds.length === 0) return result

  // Log the intent BEFORE anything is removed: this deletes user data, and a
  // dry run has to report exactly what a real run would do.
  debug(
    `[checkpoints] GC ${dryRun ? 'would discard' : 'discarding'} ${plan.discardedCheckpointIds.length}`
    + ` checkpoint(s) past the ${retention} most recent in ${sessionPath};`
    + ` ${dryRun ? 'would delete' : 'deleting'} snapshots: ${plan.deletedSnapshotFiles.join(', ') || '(none)'};`
    + ` pinned as first-snapshot baselines: ${plan.pinnedSnapshotFiles.join(', ') || '(none)'}`,
  )

  if (dryRun) {
    result.deletedSnapshotFiles = [...plan.deletedSnapshotFiles]
    return result
  }

  for (const snapshotFile of plan.deletedSnapshotFiles) {
    const snapshotPath = join(sessionPath, snapshotFile)
    try {
      await rm(snapshotPath, { force: true })
      // Each snapshot owns a `files/<checkpointId>/` directory; drop it once its
      // single blob is gone. `rmdir` refuses a non-empty directory, so a shared
      // directory is left alone rather than taken with it.
      await rmdir(dirname(snapshotPath)).catch(() => undefined)
      result.deletedSnapshotFiles.push(snapshotFile)
    } catch (error) {
      result.failedSnapshotFiles.push(snapshotFile)
      debug(`[checkpoints] GC could not delete ${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const discarded = new Set(plan.discardedCheckpointIds)
  await writeManifest(sessionPath, {
    version: 1,
    entries: manifest.entries.filter(entry => !discarded.has(entry.id)),
    baselines: [...plan.baselines],
  })
  return result
}

/**
 * Apply the documented 100-checkpoint cap to one session.
 *
 * Called on every checkpoint write, which is where the cap belongs — "keeps
 * file snapshots for the 100 most recent checkpoints" is a write-time invariant,
 * not a startup pass. Exposed so it can be run standalone and, crucially, dry.
 */
export function sweepFileCheckpoints(
  sessionPath: string,
  options: { retention?: number; dryRun?: boolean } = {},
): Promise<FileCheckpointGcResult> {
  return serializeCheckpointMutation(sessionPath, () => sweepFileCheckpointsUnlocked(sessionPath, options))
}

/**
 * P2.524 — WHAT "EPHEMERAL" MEANS FOR THE BYTES THIS MODULE WRITES.
 *
 * `createFileCheckpoint` makes its directory unconditionally and has never
 * consulted the session's `ephemeral` flag, so a session the user was told
 * leaves nothing behind writes file snapshots to disk anyway. P2.500 found it in
 * both branches at once and deliberately MIRRORED the behaviour rather than
 * fixing one side, because the question underneath is a product one.
 *
 * ## The question, and the answer taken
 *
 * *Does ephemeral mean nothing is written, or that everything written is
 * removed on exit?* Owner-delegated controller decision 2026-09-02 (§F4):
 * **everything written is removed on exit.** The alternative — never writing —
 * costs the user their ability to revert an edit INSIDE the session, which is
 * the only thing these snapshots are for, and an ephemeral session is still a
 * session someone is working in.
 *
 * ## What the flag promises elsewhere, MEASURED rather than assumed
 *
 * The decision asked for this check first, and it is worth reading before
 * anyone "corrects" the choice above:
 *
 * - `cli-reference.md`, the `--no-session-persistence` row: *"Disable session
 *   persistence so sessions are not saved to disk and cannot be resumed."*
 * - `env-vars.md#variables`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`: *"Set to `1` to
 *   skip writing prompt history and session transcripts to disk."*
 *
 * Both promises are about the **session record** — prompt history, transcript,
 * resumability — and both say SKIP WRITING. Neither mentions file snapshots,
 * which are ours and not upstream's. Our own CLI mapping already reads the
 * record half literally (`apps/cli/src/index.ts`: *"never written, not
 * written-then-removed"*), and that stays true: nothing here changes how the
 * session record is persisted. So the documentation is silent exactly where this
 * decision applies, and the transparent-and-simple rule governs: the smallest
 * honest thing is to keep the in-session capability and remove its bytes at the
 * end, with the residue stated.
 *
 * ## The residue, stated once so it is not discovered later
 *
 * Removal on exit leaves a **crash window**: a process killed between a snapshot
 * write and this call leaves file contents on disk that the user was told would
 * not persist. That is one sentence in the setting's own text
 * (`apps/cli/src/index.ts`'s `--no-session-persistence` help), not a reason to
 * take the in-session revert away.
 *
 * ## This function is the capability, and its caller is elsewhere
 *
 * The session lifecycle lives in `server-core`'s `SessionManager`, which is where
 * an ephemeral session learns that it has ended; this module owns the bytes and
 * nothing else. Wiring is one call on the ephemeral disposal path — it is
 * idempotent, it never throws, and a session that produced no checkpoints
 * answers `removed: false` rather than failing.
 */
export interface FileCheckpointStoreRemoval {
  /** Whether a checkpoint store existed and is now gone. */
  removed: boolean
  /** The directory that was removed, or would have been. */
  path: string
}

export function removeFileCheckpointStore(sessionPath: string): Promise<FileCheckpointStoreRemoval> {
  return serializeCheckpointMutation(sessionPath, async () => {
    const path = getCheckpointPath(sessionPath)
    // `existsSync` BEFORE the removal, so the verdict distinguishes "there was
    // nothing to remove" from "something was removed" — a caller that logs this
    // on an ephemeral teardown wants to know which, and `rm --force` collapses
    // the two into silence.
    const existed = existsSync(path)
    try {
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      // A teardown path must not be able to fail a session's exit. The honest
      // report is `removed: false` — the bytes may still be there, which is
      // exactly what a caller needs to be able to say out loud.
      debug(`file-checkpoints: could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return { removed: false, path }
    }
    return { removed: existed, path }
  })
}

export async function listFileCheckpoints(sessionPath: string): Promise<FileCheckpointRuntimeEntry[]> {
  const manifest = await readManifest(sessionPath)
  return Promise.all(manifest.entries.map(async entry => {
    let current: FileState
    try {
      current = await readFileState(entry.filePath)
    } catch {
      return {
        ...entry,
        currentExists: existsSync(entry.filePath),
        conflict: true,
      }
    }
    const finalized = entry.postimageExists !== undefined
    return {
      ...entry,
      currentExists: current.exists,
      ...(current.digest ? { currentDigest: current.digest } : {}),
      ...(current.mode !== undefined ? { currentMode: current.mode } : {}),
      conflict: !entry.revertedAt && (!finalized || !statesMatch(
        entry.postimageExists!,
        entry.postimageDigest,
        entry.postimageMode,
        current,
      )),
    }
  }))
}

async function createFileCheckpointUnlocked(options: CreateFileCheckpointOptions): Promise<FileCheckpointEntry[]> {
  if (options.adapter !== 'file') throw new Error(`Unsupported checkpoint adapter: ${String(options.adapter)}`)

  const target = options.authorizedTarget ?? getFilePathFromInput(options.input)
  if (!target) return []
  if (options.authorizedTarget !== undefined && !isAbsolute(options.authorizedTarget)) {
    throw new Error('Authorized checkpoint target must be absolute')
  }
  const filePath = options.authorizedTarget ?? resolve(options.baseDirectory ?? process.cwd(), target)
  const manifest = await readManifest(options.sessionPath)
  const id = makeUniqueCheckpointId(manifest, options.toolCallId, filePath)
  const createdAt = new Date().toISOString()
  // Pin where the parent directory resolves to now, so a rewind can tell "the
  // same directory" from "a link that has since been pointed somewhere else".
  const parentRealPath = await realpath(dirname(filePath)).catch(() => undefined)
  const entry: FileCheckpointEntry = {
    id,
    adapter: options.adapter,
    toolName: options.toolName,
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    filePath,
    ...(parentRealPath ? { parentRealPath } : {}),
    existed: false,
    createdAt,
  }

  const preimage = await readFileState(filePath, true)
  if (preimage.exists) {

    const snapshotRelPath = join(
      CHECKPOINT_DIR,
      CHECKPOINT_FILES_DIR,
      id,
      `0-${safeSnapshotName(filePath)}`,
    )
    const snapshotPath = join(options.sessionPath, snapshotRelPath)
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await writeFile(snapshotPath, preimage.bytes!, { mode: 0o600 })
    await chmod(snapshotPath, 0o600).catch(() => undefined)

    entry.existed = true
    entry.snapshotFile = snapshotRelPath
    entry.mode = preimage.mode
    entry.preimageDigest = preimage.digest
  }

  manifest.entries.push(entry)
  await writeManifest(options.sessionPath, manifest)
  // Enforce the cap at write time. Already inside the session's mutation lock,
  // so the unlocked form is the correct one here.
  await sweepFileCheckpointsUnlocked(options.sessionPath)
  return [entry]
}

/**
 * P6.272 · the host's off switch, applied at the ONE place both host-side
 * producers pass through.
 *
 * `RUNTIME_FILE_CHECKPOINT_PRODUCERS` above records exactly two of them — Pi
 * (in the subprocess) and `nestor-cloud-agent` (in this process) — and both
 * reach the disk through this function, in different PROCESSES. A gate at the
 * two call sites would have been two spellings of one rule with no way to keep
 * them equal; a gate here is one rule that both processes read from the same
 * `config.json`.
 *
 * Refusing returns `[]`, which is the answer both callers already handle: each
 * one does `const [checkpoint] = await createFileCheckpoint(...)` followed by
 * `if (!checkpoint) return`. Nothing is written, nothing is finalized, and no
 * caller learns a new shape.
 *
 * The read is inside the function and never at module scope: `config/storage.ts`
 * imports `sessions/index.ts`, which re-exports this file, so a top-level use
 * would be a genuine initialization cycle. Called per authorized file edit,
 * which is the same cadence the manifest write below already pays.
 */
export function createFileCheckpoint(options: CreateFileCheckpointOptions): Promise<FileCheckpointEntry[]> {
  if (!getFileCheckpointingEnabled()) return Promise.resolve([])
  return serializeCheckpointMutation(options.sessionPath, () => createFileCheckpointUnlocked(options))
}

async function finalizeFileCheckpointUnlocked(
  options: FinalizeFileCheckpointOptions,
): Promise<FileCheckpointEntry> {
  const manifest = await readManifest(options.sessionPath)
  const entry = manifest.entries.find(candidate => candidate.id === options.checkpointId)
  if (!entry) throw new Error('File checkpoint not found')
  if (entry.completedAt) return entry

  const postimage = await readFileState(entry.filePath)
  const changed = !statesMatch(entry.existed, entry.preimageDigest, entry.mode, postimage)
  entry.postimageExists = postimage.exists
  entry.postimageDigest = postimage.digest
  entry.postimageMode = postimage.mode
  entry.changed = changed
  entry.outcome = options.succeeded ? (changed ? 'applied' : 'no-op') : 'failed'
  entry.completedAt = new Date().toISOString()
  await writeManifest(options.sessionPath, manifest)
  return entry
}

export function finalizeFileCheckpoint(options: FinalizeFileCheckpointOptions): Promise<FileCheckpointEntry> {
  return serializeCheckpointMutation(options.sessionPath, () => finalizeFileCheckpointUnlocked(options))
}

function findCheckpoint(
  entries: FileCheckpointEntry[],
  checkpointId?: string,
): FileCheckpointEntry | undefined {
  if (checkpointId) {
    return entries.find(entry => entry.id === checkpointId)
  }
  return [...entries].reverse().find(entry => !entry.revertedAt)
}

/**
 * A refusal, not a failure and never a silent success.
 *
 * The checkpoint keeps its un-reverted state so the user can remove the link and
 * rewind for real, and the count travels out of the API — a rewind that quietly
 * declines has told the user their files are back when they are not.
 */
function skippedLinkResult(
  entry: FileCheckpointEntry,
  reason: FileCheckpointSkipReason,
): FileCheckpointRevertResult {
  return {
    success: false,
    checkpointId: entry.id,
    filePath: entry.filePath,
    error: `Rewind skipped ${entry.filePath}: ${SKIP_REASON_TEXT[reason]}`,
    skippedLinks: 1,
    skippedPaths: [{ filePath: entry.filePath, reason }],
    irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
  }
}

async function revertFileCheckpointUnlocked(
  options: RevertFileCheckpointOptions,
): Promise<FileCheckpointRevertResult> {
  const manifest = await readManifest(options.sessionPath)
  const entry = findCheckpoint(manifest.entries, options.checkpointId)

  if (!entry) {
    return { success: false, error: 'No file checkpoint found', irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS }
  }

  if (entry.revertedAt) {
    return {
      success: true,
      checkpointId: entry.id,
      filePath: entry.filePath,
      alreadyReverted: true,
      irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
    }
  }
  if (entry.postimageExists === undefined) {
    return {
      success: false,
      checkpointId: entry.id,
      filePath: entry.filePath,
      conflict: true,
      error: 'Checkpoint dispatch did not finalize; rewind refused',
      irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
    }
  }

  // Link safety runs BEFORE the digest comparison. A symlink whose target
  // happens to match the post-image passes every content check there is, and a
  // hard link matches by construction — neither is a conflict, and reporting one
  // as a conflict would send the user looking for an edit that never happened.
  let current: FileState
  try {
    const target = await inspectRewindTarget(entry.filePath)
    if (target.skip) return skippedLinkResult(entry, target.skip)
    current = await readFileState(entry.filePath)
  } catch (error) {
    return {
      success: false,
      checkpointId: entry.id,
      filePath: entry.filePath,
      conflict: true,
      error: `Checkpoint target cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
    }
  }
  if (!statesMatch(entry.postimageExists, entry.postimageDigest, entry.postimageMode, current)) {
    return {
      success: false,
      checkpointId: entry.id,
      filePath: entry.filePath,
      conflict: true,
      error: 'Checkpoint target changed after tool execution; rewind refused',
      ...(entry.postimageDigest ? { expectedDigest: entry.postimageDigest } : {}),
      ...(current.digest ? { currentDigest: current.digest } : {}),
      targetExistedAtRewind: current.exists,
      irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
    }
  }

  let contentRestored = false
  let modeRestored = false
  let deletionCompleted = false
  let manifestPersisted = false
  const targetExistedAtRewind = current.exists
  try {
    if (entry.existed) {
      if (!entry.snapshotFile) {
        return { success: false, checkpointId: entry.id, error: 'Checkpoint snapshot is missing' }
      }
      const snapshotPath = join(options.sessionPath, entry.snapshotFile)
      const preimage = await readSnapshotBytes(snapshotPath)
      if (!preimage) return skippedLinkResult(entry, 'snapshot-unreadable')
      const parentSkip = await inspectRewindParent(entry)
      if (parentSkip) return skippedLinkResult(entry, parentSkip)
      const writeSkip = await writePreimageWithoutFollowingLinks(
        entry.filePath,
        preimage,
        entry.mode ?? 0o600,
      )
      if (writeSkip) return skippedLinkResult(entry, writeSkip)
      contentRestored = true
      modeRestored = true
      entry.revertedAt = new Date().toISOString()
      await writeManifest(options.sessionPath, manifest)
      manifestPersisted = true
      return {
        success: true,
        checkpointId: entry.id,
        filePath: entry.filePath,
        restored: true,
        irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
        contentRestored,
        modeRestored,
        targetExistedAtRewind,
        manifestPersisted,
      }
    }

    if (targetExistedAtRewind) {
      // Unlink never follows a link, but it also never removes the CONTENT of a
      // hard-linked file — the created bytes would survive under the alias while
      // the rewind reported the file deleted. The guard above already refused
      // that case; the parent check keeps the unlink inside the same directory
      // the checkpoint was taken in.
      const parentSkip = await inspectRewindParent(entry)
      if (parentSkip) return skippedLinkResult(entry, parentSkip)
      await rm(entry.filePath)
      deletionCompleted = true
    }
    entry.revertedAt = new Date().toISOString()
    await writeManifest(options.sessionPath, manifest)
    manifestPersisted = true
    return {
      success: true,
      checkpointId: entry.id,
      filePath: entry.filePath,
      deleted: deletionCompleted,
      deletionCompleted,
      targetExistedAtRewind,
      alreadyAbsent: !targetExistedAtRewind,
      manifestPersisted,
      irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
    }
  } catch (error) {
    return {
      success: false,
      checkpointId: entry.id,
      filePath: entry.filePath,
      error: error instanceof Error ? error.message : String(error),
      contentRestored,
      modeRestored,
      targetExistedAtRewind,
      deletionCompleted,
      manifestPersisted,
      partial: contentRestored || modeRestored || deletionCompleted,
      irreversibleEffects: FILE_CHECKPOINT_REWIND_LIMITS,
    }
  }
}


export function revertFileCheckpoint(options: RevertFileCheckpointOptions): Promise<FileCheckpointRevertResult> {
  return serializeCheckpointMutation(options.sessionPath, () => revertFileCheckpointUnlocked(options))
}
