/**
 * What the CODEX app-server itself wrote down — the third runtime's own session
 * file, which this harness has been saying does not exist (C5.25, R4
 * 2026-09-12).
 *
 * ## The claim this file refutes, and what was actually measured
 *
 * `runtime-session-log.ts`'s own docblock says, of the three runtimes:
 *
 * > **Codex — nothing.** `codex-agent.ts` mints its `CODEX_HOME` with
 * > `mkdtempSync` and `rmSync`es it on teardown, so whatever the app-server
 * > rolled out is gone before a case could read it.
 *
 * Both halves of that sentence are true and the conclusion does not follow.
 * Measured on the packaged 1.36.0 (HEAD `70d269e46`) at 08:38 on this rig: five
 * `sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` files under three
 * `$TMPDIR/nessy-codex-home-*` directories, 15–31 lines each — and three of
 * those directories belonged to lanes whose apps had already QUIT. The `rmSync`
 * lives in `teardownRuntime` (`packages/shared/src/agent/codex-agent.ts`), which
 * a quit does not reach; and more to the point, a CASE reads this file while its
 * own session is still live, which is the only window any successor/decoration
 * question has ever needed. `RS-20`'s codex arm was reporting
 * *"not scored on codex-runtime: … this harness has a runtime session reader for
 * pi and claude only"* against a file that was on disk the whole time.
 *
 * ## Why a separate module and not the two lines beside its siblings
 *
 * Two reasons, and the second is the durable one. `runtime-session-log.ts` was
 * held by a sibling lane with an uncommitted hunk when this was written, and the
 * shared-file rule forbids editing across that. But the instrument is also a
 * genuinely different one: the Pi and Claude readers resolve a path INSIDE the
 * config dir the case already knows, while this one scans the OS temp directory
 * for a per-session directory whose name is random — so its failure modes,
 * its attribution key and its ambiguity reporting are its own.
 *
 * ## Attribution is exact, not newest-wins — and NOT by `cwd`
 *
 * The first thing tried here was the rollout's own `session_meta.cwd`, on the
 * assumption that it is the session's storage path. **It is not**, measured the
 * same hour: the app-server's cwd is `<config>/workspaces/<workspaceId>`, the
 * WORKSPACE root, which every session in that workspace shares — so a cwd key
 * cannot tell two of our own sessions apart, and the first run of the reader
 * answered `no-codex-rollout-for-session` for a file that was its own.
 *
 * What IS exact is the session id, which the rollout carries in its prompt
 * preamble — `<session_state> sessionId: <id>` — and again as the session
 * storage path inside the environment context. Measured: **32** occurrences of
 * the driving session's id in its own rollout, and none in any sibling's. So the
 * key is the id, the workspace-root cwd is kept as the secondary (it still
 * narrows to this app instance, which is worth reporting), and when several
 * files match, every one is read and `files` says how many: three sibling rig
 * lanes were driving codex turns on this machine while this was measured, and
 * one of their rollouts is exactly what a newest-mtime reader would have
 * returned.
 *
 * Everything here is a READ. No case may write into a CODEX_HOME.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeSessionEntry, RuntimeSessionLog } from './runtime-session-log.ts'
import { configDir, sessionStoragePath } from './runtime-session-log.ts'
import type { SessionKey } from './state.ts'

/** The prefix `codex-agent.ts` mints its per-session `CODEX_HOME` with. */
export const CODEX_HOME_PREFIX = 'nessy-codex-home-'

/**
 * F1.652 — the directory under the config dir that holds the per-session homes
 * (`codex-agent.ts` `CODEX_HOME_ROOT`). Since F1.652 a home is minted there, OUTSIDE
 * every root an agent command can write, and falls back to the OS temp dir only when
 * the session's project folder contains the config dir (the session then says so on
 * its facts channel, `codex-home-location`). So a reader scans both.
 */
export const CODEX_HOME_ROOT_DIR = 'codex-home'

/** Where a per-session `CODEX_HOME` can be: the host root first, then the OS temp dir (the fallback, and every pre-F1.652 build). */
export function codexHomeRoots(configRoot: string = configDir()): string[] {
  return [...new Set([join(configRoot, CODEX_HOME_ROOT_DIR), tmpdir()])]
}

/** Every `nessy-codex-home-*` directory under `roots`, in root order. A root that is absent or unreadable contributes nothing. */
export function listCodexHomes(roots: readonly string[] = codexHomeRoots()): string[] {
  const homes: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) if (name.startsWith(CODEX_HOME_PREFIX)) homes.push(join(root, name))
  }
  return homes
}

/** What this app writes as codex's `session_meta.originator`. */
export const CODEX_ORIGINATOR = 'nessy-codex'

/** Every text fragment of a rollout payload, joined — '' when it carries none. */
function textOf(value: unknown, depth = 0): string {
  if (depth > 6) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => textOf(item, depth + 1)).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const field of ['text', 'message', 'summary', 'content', 'last_agent_message', 'arguments', 'output']) {
      if (field in record) parts.push(textOf(record[field], depth + 1))
    }
    return parts.filter(Boolean).join('\n')
  }
  return ''
}

function parseRollout(file: string): RuntimeSessionEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(line) as Record<string, unknown>
      } catch {
        return []
      }
      const payload = (raw.payload ?? {}) as Record<string, unknown>
      const kind = typeof payload.type === 'string' ? payload.type : String(raw.type ?? '')
      const role = typeof payload.role === 'string' ? payload.role : undefined
      return [{ type: kind, ...(role ? { role } : {}), text: textOf(payload), raw }]
    })
}

/** Every rollout file under every per-session `CODEX_HOME` on this machine (F1.652: under every one of `roots`). */
function rolloutFiles(roots: readonly string[]): string[] {
  const found: string[] = []
  for (const home of listCodexHomes(roots)) {
    const sessions = join(home, 'sessions')
    if (!existsSync(sessions)) continue
    // `sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` — walked rather than globbed
    // so a layout change shows up as "no candidates" and not as a throw.
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return
      for (const name of readdirSync(dir)) {
        const child = join(dir, name)
        if (name.endsWith('.jsonl')) { found.push(child); continue }
        if (statSync(child).isDirectory()) walk(child, depth + 1)
      }
    }
    walk(sessions, 0)
  }
  return found
}

/**
 * The `cwd` the app-server recorded for itself, off the file's `session_meta`.
 *
 * The WORKSPACE root, not the session's — see the docblock. Kept because it
 * still separates this app instance from a sibling lane's, which is the thing
 * worth saying when a read is ambiguous.
 *
 * `originator` is checked with it (C3.367, carried across from the reader this
 * one replaced): codex writes who launched it, this app writes `nessy-codex`,
 * and a rollout from a codex the OPERATOR ran by hand in the same workspace
 * would otherwise be counted as ours in the ambiguity report.
 */
function rolloutCwd(file: string): string | undefined {
  for (const entry of parseRollout(file)) {
    if (entry.type !== 'session_meta') continue
    const payload = (entry.raw.payload ?? {}) as Record<string, unknown>
    if (payload.originator !== undefined && payload.originator !== CODEX_ORIGINATOR) return undefined
    if (typeof payload.cwd === 'string') return payload.cwd
  }
  return undefined
}

export interface CodexSessionLogOptions {
  /** ONE root to scan instead of {@link codexHomeRoots} (a rig's; the product uses two since F1.652). */
  tmpRoot?: string
  /** The config dir the session's storage path is derived from. */
  configRoot?: string
  /** The session's working directory, when the case set one. */
  cwd?: string
}

/**
 * The codex app-server's own rollout for one session.
 *
 * Returns the same {@link RuntimeSessionLog} shape the Pi and Claude readers do,
 * so `RS-20`'s `runtimeLog()` switch gains a third arm and nothing else moves.
 * `reason` is set — and `entries` left empty — for every way this can fail to
 * answer, because "no file" and "a file that is not this session's" are
 * different findings and a case that scores an absence must be able to tell them
 * apart.
 */
export function readCodexSessionLog(key: SessionKey, options: CodexSessionLogOptions = {}): RuntimeSessionLog {
  const roots = options.tmpRoot ? [options.tmpRoot] : codexHomeRoots(options.configRoot ?? configDir())
  const tmpRoot = roots.join(' and ')
  const candidates = rolloutFiles(roots)
  if (candidates.length === 0) {
    return {
      entries: [],
      reason: `no-codex-rollout: no ${CODEX_HOME_PREFIX}*/sessions/**/*.jsonl under ${tmpRoot}`
        + ' — no codex turn has run on this machine, or the per-session CODEX_HOME was already torn down',
    }
  }
  // The SESSION ID, which the rollout carries in its prompt preamble and in the
  // environment context's session storage path. The cwd is the workspace root
  // and cannot separate two of our own sessions — see the docblock.
  const storage = sessionStoragePath(key, options.configRoot ?? configDir())
  const matched = candidates.filter(file => readFileSync(file, 'utf8').includes(key.sessionId))
  if (matched.length === 0) {
    const instanceCwd = options.cwd ?? storage
    const sameInstance = candidates.filter(file => {
      const cwd = rolloutCwd(file)
      return cwd !== undefined && (instanceCwd.startsWith(cwd) || cwd.startsWith(instanceCwd))
    })
    return {
      entries: [],
      reason: `no-codex-rollout-for-session: ${candidates.length} rollout file(s) under ${tmpRoot},`
        + ` ${sameInstance.length} of them from this app instance, none naming session ${key.sessionId}`
        + ' — either no codex turn has run in this session yet, or its per-session CODEX_HOME is already gone.'
        + ' Reading the newest instead would measure another session',
    }
  }
  const ordered = matched.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  const newest = ordered[ordered.length - 1]!
  return {
    file: newest,
    files: ordered,
    entries: ordered.flatMap(parseRollout),
    ...(ordered.length > 1
      ? { reason: `${ordered.length} rollout files match this session — all are read, oldest first` }
      : {}),
  }
}
