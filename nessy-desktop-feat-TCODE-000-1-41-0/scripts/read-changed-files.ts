/**
 * F1.622 — read the files a blob-reading gate cannot take from git, all at
 * once instead of one after another.
 *
 * Four `lint:chain` gates (`check-conditional-expect`, `check-nul-bytes`,
 * `check-comment-globs`, `check-shape-pointer-reasons`) read every clean file
 * as its index blob through one `git cat-file --batch` and open only the rest —
 * the files `git status` names, the untracked ones, an explicit enumeration.
 * They opened that rest with `readFileSync` in a loop, and on this rig an open
 * costs the same whoever makes it, so the loop became each gate's whole
 * remaining cost: 25 such files took 12.22 s one by one and 0.19 s in parallel
 * (WJ-bz, 2026-09-24, load ~12). The waiting overlaps; the CPU is the same.
 *
 * `readFile` from `node:fs/promises` rather than `Bun.file().text()`: it hands
 * back a `Buffer` (the NUL gate's subject is a byte, never decoded) and fails
 * with the same `code` `readFileSync` did (`ENOENT`, `EISDIR`), so each gate
 * keeps its own verdict on a failed read unchanged — this module reports a
 * failure, it never forgives one.
 *
 * At most {@link READ_CONCURRENCY} reads are in flight: a dirty tree or an
 * explicit enumeration can name hundreds of files, and an unbounded
 * `Promise.all` would ask for a descriptor each at once.
 */

import { readFile } from 'node:fs/promises'

/** One file's read: its bytes, or the error its read failed with. */
export type FileRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly error: NodeJS.ErrnoException }

/** Reads in flight at once — enough to overlap this rig's per-open wait, far below any descriptor limit. */
export const READ_CONCURRENCY = 32

/**
 * Read every path, at most `concurrency` at a time. The result is aligned with
 * `paths` (index `i` is `paths[i]`'s read), so a caller keeps its own order,
 * and a failed read is returned rather than thrown, so one missing file cannot
 * abandon its siblings' reads mid-flight.
 */
export async function readFilesConcurrently(
  paths: readonly string[],
  concurrency: number = READ_CONCURRENCY,
): Promise<FileRead[]> {
  const out = new Array<FileRead>(paths.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next++
      try {
        out[index] = { ok: true, bytes: await readFile(paths[index]!) }
      } catch (error) {
        out[index] = { ok: false, error: error as NodeJS.ErrnoException }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker))
  return out
}
