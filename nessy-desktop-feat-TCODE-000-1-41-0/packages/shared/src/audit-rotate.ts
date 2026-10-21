/**
 * UA12.62 — the size-capped rotation the two JSONL audit trails share: `logs/page-actions.jsonl`
 * (`packages/shared/src/pages/action-bridge.ts`) and `logs/privileged-actions.jsonl`
 * (`packages/server-core/src/services/privileged-execution-broker.ts`). Neither was rotated
 * (P-UAad-1, UA-ad 2026-10-02): an append-only operator log that grows without bound is an
 * operator cost nobody chose. ONE generation (`.1`) keeps the worst case at 2× the cap; the
 * constant is the DEFAULT — both writers take an `auditRotateBytes` override so a test rotates
 * at a few hundred bytes.
 *
 * UA12.177 — writers append ONLY through {@link appendJsonlRotating}: one promise chain per path
 * (module-level, so the three `PrivilegedExecutionBroker` instances over one trail share it) runs
 * each append's rotate → mkdir → append to completion before the next starts. Unserialized, two
 * fire-and-forget appends at the cap crossing both saw the over-cap size and the second renamed
 * the first's FRESH file over `.1`, destroying the retained generation (and with three or more
 * in flight, new lines too — measured by the 2026-10-08 verification). Residue, stated: writers
 * in SEPARATE processes are not serialized (both trails are written by the server process only).
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** The default rotation cap for the audit JSONL trails (10 MB ≈ tens of thousands of events). */
export const AUDIT_JSONL_ROTATE_BYTES = 10 * 1024 * 1024;

/**
 * Rotate `path` to `<path>.1` (replacing a previous `.1`) once it has reached `capBytes`, so the
 * caller's append lands in a fresh file. Below the cap nothing happens, and a file that does not
 * exist yet is not an error. ONE generation — the second rotation overwrites the first `.1`.
 * NOT safe for overlapping callers on one path (a stat-then-rename): writers go through
 * {@link appendJsonlRotating}, which serializes it with the append.
 */
export async function rotateJsonlPastCap(path: string, capBytes: number): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return; // no file yet — nothing to rotate
  }
  if (size < capBytes) return;
  try {
    await rename(path, `${path}.1`);
  } catch {
    // the file went away between stat and rename (deleted outside this process) — the append
    // then starts a fresh file, which is what a rotation would have produced anyway
  }
}

/** The tail of each path's append chain; an entry is dropped when its chain goes idle. */
const appendChains = new Map<string, Promise<void>>();

/**
 * UA12.177 — append `line` (one JSON record, without its newline) to `path`, rotating it first
 * past `capBytes`, strictly after every earlier append to the same path has finished. The returned
 * promise rejects with this append's own error (the caller logs it); a failed link never wedges
 * the chain for later appends.
 */
export function appendJsonlRotating(path: string, line: string, capBytes: number): Promise<void> {
  const key = resolve(path);
  const run = async (): Promise<void> => {
    await rotateJsonlPastCap(path, capBytes);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, 'utf8');
  };
  const link = (appendChains.get(key) ?? Promise.resolve()).then(run);
  const tail = link.then(
    () => undefined,
    () => undefined,
  );
  appendChains.set(key, tail);
  void tail.then(() => {
    if (appendChains.get(key) === tail) appendChains.delete(key);
  });
  return link;
}

/** UA12.177 — resolves once every append to `path` issued so far has finished (a test's settle seam). */
export function settleJsonlAppends(path: string): Promise<void> {
  return appendChains.get(resolve(path)) ?? Promise.resolve();
}
