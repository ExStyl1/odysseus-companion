/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmod, mkdir, open } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Per-session external control channel files. */
export interface SessionControlPaths {
  dir: string;
  /** Structured JSON event stream (DualOutputBridge target). */
  eventsFile: string;
  /** Remote input commands (RemoteInputWatcher target). */
  inputFile: string;
}

/**
 * Create (or reuse) the per-session control directory
 * `~/.nessy/ctl/<sessionId>/` with `events.jsonl` and `input.jsonl`.
 *
 * Paths are derived from the session id alone — an external consumer
 * (menu-bar notifier, IDE extension) discovers them from the
 * `state.control` block of the session's runtime.json without any
 * settings coordination. Shared files from settings would let two
 * watchers race over one input file, so control paths are strictly
 * per-session.
 *
 * The directory is created with mode 700 and the files with 600 (chmod
 * is applied even when the files already exist from an earlier run of
 * the same session id). Existing file contents are preserved — the
 * dual-output bridge appends, the input watcher resumes from its own
 * offset.
 *
 * Best-effort by contract: callers wrap failures in a warning; a
 * read-only home directory must not prevent the TUI from starting.
 */
export async function createSessionControlDir(
  sessionId: string,
  nessyDir: string = path.join(os.homedir(), '.nessy'),
): Promise<SessionControlPaths> {
  // Session ids are UUID-shaped, but defend the path anyway — the id
  // must never escape the ctl directory via traversal characters.
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(nessyDir, 'ctl', safeId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const eventsFile = path.join(dir, 'events.jsonl');
  const inputFile = path.join(dir, 'input.jsonl');
  for (const file of [eventsFile, inputFile]) {
    const handle = await open(file, 'a', 0o600);
    await handle.close();
    await chmod(file, 0o600);
  }
  return { dir, eventsFile, inputFile };
}
