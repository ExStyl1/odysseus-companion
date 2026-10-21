/**
 * What the RUNTIME itself wrote down — the only instrument for "a session
 * command goes out bare" that survives on a packaged build.
 *
 * ## The detector that died, and why
 *
 * The 2026-08-11 run proved `/compact` reaches the runtime undecorated by
 * reading `[session] Message: /compact` out of the dev app's stdout and then
 * confirming `<available_skills>` appeared in no logged outgoing text. That line
 * comes from `sessionLog.info('Message:', message)` in `SessionManager`, and it
 * does not exist on the artifact users download: `apps/electron/src/main/logger.ts`
 * sets `log.transports.file.level = false` and `log.transports.console.level = false`
 * whenever `isDebugMode` is false, which on a packaged Electron build it always
 * is. The independent audit of the signed 1.25.0 looked for it and found only
 * `<config>/logs/auto-update.log`, which is written by a separate always-on
 * logger for exactly that reason.
 *
 * Two further things are worth knowing before anyone rebuilds that detector:
 * the log line prints `message`, the RAW incoming text, not the `effectiveMessage`
 * that is actually handed to `agent.chat()` — so on its own it never proved
 * "bare" at all; the proof was the ABSENCE of context markers in the other
 * logged outgoing text. And a detector that needs a lever is a detector that
 * changes the thing it measures — and the lever this file used to name was not
 * even real (see {@link DEBUG_LEVER} below).
 *
 * ## The instrument that does exist on the shipped artifact
 *
 * Both runtimes that implement session commands persist their own conversation
 * as they produce it, in a file the HOST does not write and cannot retouch:
 *
 * - **Pi** — `<config>/sessions/<workspaceId>/<sessionId>/.pi-sessions/*.jsonl`.
 *   The Pi SDK appends one JSON line per entry: a `{"type":"session"}` header,
 *   then `{"type":"message","message":{role,content}}` for every message it
 *   receives or produces, plus `{"type":"compaction","summary","tokensBefore"}`
 *   when it compacts. `SessionManager.resolveForkBranchOptions` documents the
 *   append-as-produced behaviour, measured against a real subprocess on
 *   2026-07-29, and `AGT-9` already reads the compaction entries out of it.
 * - **Claude runtime** — `<config>/workspaces/<workspaceId>/claude-config/projects/…/*.jsonl`,
 *   the Agent SDK's own transcript under the per-workspace `CLAUDE_CONFIG_DIR`
 *   (`agent/options.ts`, `CLAUDE_CONFIG_DIR_NAME = 'claude-config'`).
 * - **Codex — its own rollout file, and this bullet said "nothing" until
 *   2026-09-12.** `lib/codex-session-log.ts` symbol `readCodexSessionLog` reads
 *   it — a separate module, and not by accident: see the note at the end of this
 *   docblock. The refuted half was the
 *   INFERENCE, not the facts: `codex-agent.ts` does mint its `CODEX_HOME` with
 *   `mkdtempSync` and does `rmSync` it on teardown, and the conclusion drawn
 *   from that — *"gone before a case could read it"* — is wrong, because
 *   teardown is when the SESSION ends and a case reads while it is live.
 *   Measured on the packaged 1.36.0 (HEAD `70d269e46`): four
 *   `nessy-codex-home-*` directories under the OS temp dir, the newest holding
 *   `sessions/2026/09/12/rollout-2026-09-12T08-34-06-<uuid>.jsonl` written by a
 *   turn one minute earlier. So the Codex arm of a bare-command claim is NOT
 *   instrument-less, and the 2026-08-11 measurement can be re-taken rather than
 *   moved to the runtime that happened to be readable.
 *
 * ## The codex reader lives next door, and this file carried a SECOND one (C3.367)
 *
 * Two `readCodexSessionLog` implementations were written from one measurement
 * inside one hour on 2026-09-12 — R4's in `lib/codex-session-log.ts`, keyed by
 * the SESSION ID, and R6a's here, keyed by `session_meta.cwd`. They are not
 * interchangeable and the difference is the whole reason only one survives: the
 * app-server's cwd is `<config>/workspaces/<workspaceId>`, the WORKSPACE root,
 * which every session in that workspace shares — so a cwd key cannot tell two of
 * this app's own sessions apart, and with no cwd at all the reader returned the
 * newest rollout on the machine, which on a rig running three packaged instances
 * is as likely to be a sibling lane's as yours. The session-id key is exact (32
 * occurrences of the driving session's id in its own rollout, none in any
 * sibling's, measured the same hour), so R6a's was collapsed into it and its two
 * callers (`cases/rs-17.ts`, `cases/rs-21.ts`) now key by session. The one thing
 * R6a's had that R4's did not — the `originator === 'nessy-codex'` check, which
 * keeps a rollout from a codex the OPERATOR ran by hand out of the read — moved
 * across with it.
 *
 * ## What "bare" looks like in that file
 *
 * A session command never becomes a model turn — `SessionManager.sendMessage`
 * says so and `BaseAgent.chat` is the seam that executes it — so the runtime
 * writes **no new user message entry** for the command's turn, only the
 * command's own effect (a `compaction` entry for `/compact`). If the command had
 * gone out decorated, the seam would not have recognized it, the decorated text
 * would have been sent as an ordinary prompt, and a user entry carrying BOTH the
 * command and the preamble would appear. Positive and negative in one read, on
 * the shipped build, from a file the feature writes itself — which is the
 * standard AGENTS.md sets for an absence claim.
 *
 * Everything here is a READ. No case may write into a session directory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { blocked } from './report.ts'
import type { SessionKey } from './state.ts'

/**
 * The lever that brings the old log-based detector back on a packaged build, and
 * the reason it is still the SECOND choice.
 *
 * **A BARE `--debug` does not work.** Measured 2026-08-12 on packaged 1.25.1
 * (Electron 39.2.7) and again 2026-09-25 (SIT-b, SIT-am): Node claims the flag
 * before the app sees it and rejects it — `[DEP0062] node --debug and
 * --debug-brk are invalid` — and the app exits at start. **`-- --debug` does**
 * (F1.767, SIT-b's third launch, packaged `5896a66d2`): written AFTER the
 * Chromium switches and a `--` (measured, not derived), it reaches
 * `process.argv`, `resolveDebugMode()`'s FIRST arm turns both electron-log
 * transports on, and `INFO [main]`/`[session]` lines appear on stdout:
 *
 * ```bash
 * NESSY_CONFIG_DIR=/private/tmp/…/config \
 *   "release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" \
 *   --remote-debugging-port=9333 --user-data-dir=/private/tmp/…/ud -- --debug
 * ```
 *
 * The SECOND arm, `NESSY_IS_PACKAGED=false` (`packagedEnv === 'false'`), also
 * turns the transports on and was this note's recipe until F1.767 — but SIT-b's
 * one launch with it on the 1.41.0 RC never loaded a session ("Workspace
 * connection is unavailable", persistent after Retry), so it is the fallback.
 * Use `-- --debug`, and say in the reading which of the two routes produced it.
 *
 * It is not free either, and the cost is the ORIGINAL note's, which stands:
 * `logger.ts` is evaluated at import, and `main/index.ts:95` then sets
 * `process.env.NESSY_DEBUG = '1'` for any `isDebugMode` run — the Pi subprocess
 * inherits it and `isDevRuntime()` (`feature-flags.ts`) turns true, so the
 * packaged build is no longer in exactly the configuration a user gets. Only the
 * `NESSY_IS_PACKAGED` half is repaired downstream (`main/index.ts:119` overwrites
 * it with `'1'` before any subprocess spawns); the observer effect is reduced,
 * not removed. Prefer the runtime's own session file; reach for this only when
 * the question really is about the outgoing TEXT rather than about the effect.
 */
export const DEBUG_LEVER = '-- --debug'

/** One line of a runtime-written session file, flattened to what a case asserts on. */
export interface RuntimeSessionEntry {
  /** `session`, `message`, `compaction`, … — the file's own discriminator. */
  type: string
  /** Present on message entries. */
  role?: string
  /** Every text fragment of the entry, joined — '' when the entry carries none. */
  text: string
  raw: Record<string, unknown>
}

export interface RuntimeSessionLog {
  /** The file read, for the report. `undefined` when none exists yet. */
  file?: string
  /** Every file the entries came from, when more than one was read. */
  files?: string[]
  entries: RuntimeSessionEntry[]
  /** Why the log could not be read, when it could not. */
  reason?: string
}

/**
 * Has {@link configDir} already said which directory it resolved?
 *
 * Per PROCESS, not per call: the line exists so a run's log carries the answer
 * once, and a helper called forty times that says so forty times is noise a
 * reader learns to skip.
 */
let configDirAnnounced = false

/**
 * `NESSY_CONFIG_DIR` or the default — the same resolution `config/paths.ts` does.
 *
 * **It announces the directory it resolved, once per run, on stderr (D1.210).**
 * A CASE is a second process: `run.ts` spawns `bun run cases/<id>.ts` with the
 * operator's environment, and the app's own `NESSY_CONFIG_DIR` reaches it only
 * if the operator exported it too. Measured 2026-09-17 (WI-f): `RS-32`'s first
 * run on the first measure sitting scored FAIL on its own negative control
 * because this function answered `~/.nessy-agent` — the OWNER's profile — while
 * the app was writing to the rig, and the verdict came back *"neither
 * substituted nor refused"*, which is uninterpretable rather than wrong. The
 * same case was PASS 8/8 minutes later with the variable exported. Nothing in
 * the run said which profile had been read, so the only way to find it was to
 * suspect it.
 *
 * stderr and not stdout: `run.ts` parses one stdout line per case
 * (`##CDP-RESULT##`) and `stderr` is inherited, so this lands in front of the
 * operator without entering anything a parser reads.
 */
export function configDir(): string {
  const override = process.env.NESSY_CONFIG_DIR?.trim()
  const resolved = resolve(override || join(homedir(), '.nessy-agent'))
  if (!configDirAnnounced) {
    configDirAnnounced = true
    console.error(
      override
        ? `[cdp] config dir: ${resolved} (from NESSY_CONFIG_DIR)`
        : `[cdp] config dir: ${resolved} (NESSY_CONFIG_DIR is UNSET — this is the DEFAULT profile, i.e. the owner's; `
          + 'every read below is of that profile and not of any rig)',
    )
  }
  return resolved
}

/**
 * The config dir for a case that WRITES into it — refuses when it is the default.
 *
 * The other half of D1.210, and the reason it is a function rather than a note:
 * a read of the wrong profile is a confusing verdict, while a WRITE into it puts
 * a case's fixture inside the owner's own `~/.nessy-agent`. `rs-48.ts` plants a
 * Pi sidecar and refused by hand for exactly that reason; this is that refusal
 * where the next case can reach it.
 *
 * It throws {@link blocked}'s `BlockedError`, so the case reports BLOCKED — a
 * missing precondition — rather than FAIL, which would read as the product.
 */
export function writableConfigDir(purpose: string): string {
  const override = process.env.NESSY_CONFIG_DIR?.trim()
  if (!override) {
    blocked(
      `NESSY_CONFIG_DIR is unset in this case process, so ${purpose} would land in the DEFAULT profile — the `
      + 'owner\'s `~/.nessy-agent`. Export the SAME directory the app was launched with and run again; the app\'s own '
      + 'environment does not reach this process, because a case is a second process.',
    )
  }
  return configDir()
}

/** `<config>/sessions/<workspaceId>/<sessionId>` — `workspaces/paths.ts`. */
export function sessionStoragePath(key: SessionKey, root = configDir()): string {
  return join(root, 'sessions', key.workspaceId, key.sessionId)
}

/**
 * Text out of one entry, whatever content shape it uses.
 *
 * The Pi SDK's `AgentMessage.content` is a parts array of `{type:'text',text}`
 * and friends; the Claude SDK writes the same idea with its own field names, and
 * both also occur as a bare string. Anything that is not text (an image part, a
 * tool-use block) contributes nothing rather than a `[object Object]` that a
 * `.includes()` assertion would then match on.
 */
function textOf(value: unknown, depth = 0): string {
  if (depth > 6) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => textOf(item, depth + 1)).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of ['text', 'content', 'summary', 'message']) {
      if (key in record) parts.push(textOf(record[key], depth + 1))
    }
    return parts.filter(Boolean).join('\n')
  }
  return ''
}

function parseJsonl(file: string): RuntimeSessionEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return []
      }
      if (!parsed || typeof parsed !== 'object') return []
      const record = parsed as Record<string, unknown>
      const message = record.message && typeof record.message === 'object'
        ? record.message as Record<string, unknown>
        : undefined
      const role = typeof message?.role === 'string'
        ? message.role
        : typeof record.role === 'string' ? record.role : undefined
      return [{
        type: typeof record.type === 'string' ? record.type : 'unknown',
        ...(role ? { role } : {}),
        text: textOf(message ?? record),
        raw: record,
      }]
    })
}

/** Newest `.jsonl` under `dir`, or `undefined` when the directory has none. */
function newestJsonl(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => join(dir, name))
  if (files.length === 0) return undefined
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/**
 * The Pi SDK's sidecar for one session.
 *
 * A session with more than one sidecar is a FORKED one (a child inherits by
 * branching from the parent's file); the newest is this session's own, and the
 * count is reported so a case can refuse an ambiguous read rather than average
 * two conversations.
 */
export function readPiSessionLog(key: SessionKey, root = configDir()): RuntimeSessionLog & { sidecarCount: number } {
  const dir = join(sessionStoragePath(key, root), '.pi-sessions')
  if (!existsSync(dir)) {
    return {
      entries: [],
      sidecarCount: 0,
      reason: `no-pi-sidecar: ${dir} does not exist — this session has not run a Pi turn, or its runtime is not Pi`,
    }
  }
  const count = readdirSync(dir).filter(name => name.endsWith('.jsonl')).length
  const file = newestJsonl(dir)
  if (!file) return { entries: [], sidecarCount: 0, reason: `empty-pi-sidecar-dir: ${dir} holds no .jsonl` }
  return { file, entries: parseJsonl(file), sidecarCount: count }
}

/**
 * The Claude Agent SDK's own transcript for a workspace.
 *
 * Keyed by workspace, not by session: the SDK files its transcripts under
 * `projects/<cwd hash>/` inside the per-workspace `CLAUDE_CONFIG_DIR`, so the
 * newest file under that tree is the right one only when the case has just
 * driven the session it is asking about. Read it immediately after the turn.
 *
 * **Pass `sessionId` and that caveat goes away.** The `<cwd hash>` is not a
 * hash: the SDK slugifies the session's own working directory, which for a
 * Nessy session is `<config>/sessions/<workspaceId>/<sessionId>`, so the
 * directory name ENDS with the session id — measured on this profile, e.g.
 * `-Users-…--nessy-agent-sessions-d98cc70e-…-d7735ed8-1c1e-4ced-947e-e44f086ef5d6`.
 * A case that knows which session it drove should say so; "newest across the
 * whole workspace" is the fallback for one that does not, and it is exactly the
 * ambiguity that once let a PREVIOUS run's marker be read as this run's.
 *
 * **One Nessy session is MANY SDK transcripts, and reading only the newest
 * loses history that is still true.** The SDK opens a new `<uuid>.jsonl` in the
 * same directory whenever it starts a fresh conversation — measured 2026-08-15,
 * when an upstream 400 made it abandon `861f0767…` mid-run and continue in
 * `ce345927…` 0.6 s later. A case counting `compact_boundary` entries then read
 * 1 → 0 across a step that added none, because the boundary was in the file it
 * had stopped looking at. Every `.jsonl` in the directory belongs to the one
 * Nessy session the directory is named for, so all of them are read, oldest
 * first, and `files` reports how many there were — a count above one is itself
 * worth seeing.
 *
 * ## `cwd` — because the session-id key holds only while the session has no
 * working directory, and EVERY reading goes to zero when it does
 *
 * Measured 2026-09-12 (R6a) driving `RS-17` on the packaged 1.36.0 (HEAD
 * `70d269e46`). The paragraph above is right about the slug — the SDK slugifies
 * the session's *cwd* — and wrong about what that cwd always is. A Nessy session
 * runs in `<config>/sessions/<ws>/<session>` **until someone sets a working
 * directory**, which `setWorkingDirectory` does and which most interesting cases
 * need. `RS-17` binds its session to a fixture root, so the SDK wrote
 * `projects/-private-var-folders-…-nessy-rs17-Stn9IF/202aa152-….jsonl` (297 KB,
 * on disk the whole time) while {@link directoryIsFor} looked for a directory
 * ending in the SESSION id, matched none, and this function answered
 * `no-claude-transcript-for-session`.
 *
 * **The cost is not a smaller number, it is a control that stopped
 * discriminating.** Every reading of that run came back 0 — `0 of 6 paths`,
 * `added: 0`, E7 `returned: 0`, E9 `found: false` — and the case's CONTROL A
 * ("a compaction with zero files read returns no path") PASSED, because no path
 * can leak out of an empty log. Both arms of the control agreed, so it was a
 * deleted test that still ran green.
 *
 * So a caller that set a working directory passes it here. The key is EXACT —
 * the slug is `cwd.replace(/[^a-zA-Z0-9]/g, '-')`, verified against all three
 * directories this profile held — and it is tried only when the session-id key
 * matches nothing, so no existing caller's reading moves. `reason` names which
 * key answered, because a cwd-keyed read can merge SEVERAL Nessy sessions that
 * share one working directory (`RS-17`'s subject and its two controls do) and
 * that is worth seeing rather than trusting: the sessions run in sequence, so a
 * before/after diff stays honest, while a single absolute count does not.
 */
export function readClaudeSessionLog(
  workspaceId: string,
  root = configDir(),
  sessionId?: string,
  cwd?: string,
): RuntimeSessionLog {
  const projects = join(root, 'workspaces', workspaceId, 'claude-config', 'projects')
  if (!existsSync(projects)) {
    return { entries: [], reason: `no-claude-transcript: ${projects} does not exist — no Claude-runtime turn has run in this workspace` }
  }
  // The session-id key first, and the cwd key only if it answered nothing: a
  // caller that passes both must keep the reading it had before this parameter
  // existed whenever the session-id key still works.
  const bySession = sessionId
    ? readdirSync(projects).filter(entry => directoryIsFor(entry, sessionId))
    : undefined
  const keyedByCwd = cwd !== undefined && (bySession?.length ?? 0) === 0
  const matcher = keyedByCwd
    ? (entry: string) => directoryIsForCwd(entry, cwd)
    : sessionId ? (entry: string) => directoryIsFor(entry, sessionId) : undefined
  const narrowed = matcher !== undefined
  const candidates: string[] = []
  let matchedBy: 'suffix' | 'truncated-prefix' | 'cwd' | 'cwd-truncated' | undefined
  for (const entry of readdirSync(projects)) {
    if (matcher && !matcher(entry)) continue
    if (keyedByCwd) matchedBy = entry === claudeProjectSlug(cwd!) ? 'cwd' : 'cwd-truncated'
    else if (sessionId) matchedBy = entry.endsWith(sessionId) ? 'suffix' : 'truncated-prefix'
    const child = join(projects, entry)
    if (!statSync(child).isDirectory()) continue
    // Narrowed to one session: read the whole directory. Un-narrowed: the
    // newest per directory, because those directories are different sessions
    // and merging them is the ambiguity this parameter exists to remove.
    if (narrowed) {
      for (const name of readdirSync(child)) {
        if (name.endsWith('.jsonl')) candidates.push(join(child, name))
      }
    } else {
      const file = newestJsonl(child)
      if (file) candidates.push(file)
    }
  }
  if (candidates.length === 0) {
    return {
      entries: [],
      reason: sessionId
        ? `no-claude-transcript-for-session: nothing under ${projects} whose directory name ends with ${sessionId}`
          + ' — or with a truncated prefix of it, which is what a long config path produces'
          + (cwd === undefined
            ? '. The session-id key holds only while the session has NO working directory; pass `cwd` if it has one'
            : `, and nothing keyed to the working directory ${cwd} either (slug ${claudeProjectSlug(cwd)})`)
        : `empty-claude-transcript: no .jsonl under ${projects}`,
    }
  }
  const ordered = candidates.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  const newest = ordered[ordered.length - 1]!
  if (!narrowed) return { file: newest, entries: parseJsonl(newest) }
  const caveat = matchedBy === 'truncated-prefix'
    ? `matched by a TRUNCATED directory name: the slug was cut before the end of ${sessionId} and a short suffix appended`
    : matchedBy === 'cwd' || matchedBy === 'cwd-truncated'
      ? `matched by the WORKING DIRECTORY (${matchedBy}), not the session id: ${cwd}`
        + ' — every Nessy session sharing this working directory is in this reading, so score a before/after'
        + ' DIFF rather than an absolute count'
      : undefined
  return {
    file: newest,
    files: ordered,
    entries: ordered.flatMap(parseJsonl),
    ...(caveat ? { reason: caveat } : {}),
  }
}

/**
 * The SDK's own `projects/` directory name for a working directory.
 *
 * `cwd.replace(/[^a-zA-Z0-9]/g, '-')`, verified 2026-09-12 against all three
 * directories one profile held — including `/private/tmp/claude-503/-Users-…`,
 * where the DOUBLE hyphen is the path's own leading `-` surviving beside the
 * separator, which is the case a hand-written slug rule gets wrong.
 */
function claudeProjectSlug(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Does this `projects/` directory belong to the session running in `cwd`?
 *
 * The exact slug first. A long path is CUT and given a short random suffix by
 * the SDK exactly as {@link directoryIsFor} describes for a session id — this
 * profile held `…-sessions-b4b2101a-…-f1c42dd4-cba5-awufrg` for a cwd whose slug
 * is 40 characters longer — so the truncated form is accepted too: the entry
 * minus its `-<6 chars>` tail must be a prefix of the slug, and at least 24
 * characters of it, which is longer than any prefix two different working
 * directories in this harness share.
 */
function directoryIsForCwd(entry: string, cwd: string): boolean {
  const slug = claudeProjectSlug(cwd)
  if (entry === slug) return true
  if (entry.length < 31) return false
  const head = entry.slice(0, entry.length - 7)
  return head.length >= 24 && slug.startsWith(head)
}

/**
 * Does this `projects/` directory belong to `sessionId`?
 *
 * The docblock above says the slug ENDS with the session id, and on a
 * `~/.nessy-agent` profile it does. It does NOT when the path is long: measured
 * 2026-09-11 against a config dir under the lane scratchpad, the directory is
 *
 *   `…-sessions-e8e9c3d1-6972-4880-b340-fb7b739fb291-45c4e24a-3567-4730-b-is5c1n`
 *
 * for session `45c4e24a-3567-4730-b…` — the slug is CUT mid-session-id and a
 * short suffix is appended, so `endsWith` can never match and the narrowed read
 * returns nothing. `RS-20` scored *"on anthropic the successor is not told"*
 * against a transcript that was on disk the whole time, which is the shape of
 * finding this harness exists to prevent: a detector's own miss, reported as the
 * product's.
 *
 * So: the exact suffix first, and otherwise a PREFIX of the session id at least
 * 12 characters long — long enough that no two of this app's session ids collide
 * (a v4 uuid's first 12 characters carry ~48 bits), short enough to survive the
 * cut. `readClaudeSessionLog` reports which rule matched, because a truncated
 * match is worth seeing rather than silently trusting.
 */
function directoryIsFor(entry: string, sessionId: string): boolean {
  if (entry.endsWith(sessionId)) return true
  for (let length = sessionId.length - 1; length >= 12; length -= 1) {
    if (entry.includes(`-${sessionId.slice(0, length)}`)) return true
  }
  return false
}

/**
 * The markers that prove a turn's outgoing text carried MODEL-ONLY context.
 *
 * Each is a literal the PromptBuilder emits around a context block; a session
 * command that reached the runtime decorated would drag at least one of them
 * into the message the runtime recorded. Written out by hand rather than
 * imported from the builder: a check that derives its expectation from the code
 * under test passes whatever that code does, including a regression.
 */
export const CONTEXT_PREAMBLE_MARKERS = [
  '<available_skills>',
  '<session_state>',
  '<system-reminder>',
  '<capability-generation>',
] as const

export interface BareCommandEvidence {
  /** Entries the runtime wrote while the command ran. */
  added: RuntimeSessionEntry[]
  /** Added user MESSAGE entries — a session command must add none. */
  addedUserMessages: RuntimeSessionEntry[]
  /** Added entries carrying the command's own literal text. */
  echoedCommand: RuntimeSessionEntry[]
  /** Added entries carrying a model-only context marker, with the marker found. */
  leakedContext: { marker: string; type: string; excerpt: string }[]
  /** Added `compaction` entries — `/compact`'s own effect. */
  compactions: number
}

/**
 * Diff two reads of the same runtime log around one session command.
 *
 * Take `before` immediately before dispatching the command and `after` once the
 * session goes idle, then assert on the result:
 *
 *   - `compactions > 0` for `/compact` — the command reached the seam and ran
 *     (the effect the product promises, not a field that merely ought to be set);
 *   - `addedUserMessages` EMPTY and `echoedCommand` EMPTY — it was never sent to
 *     the model as prose, which is what a decorated command would have caused;
 *   - `leakedContext` EMPTY — no model-only block rode it.
 *
 * The three together are the claim. `compactions > 0` alone is satisfied by an
 * automatic compaction that happened to land in the same window, so a case that
 * asserts only that has measured the auto-compactor.
 */
export function bareCommandEvidence(
  before: RuntimeSessionLog,
  after: RuntimeSessionLog,
  command: string,
): BareCommandEvidence {
  const seen = new Set(before.entries.map(entryIdentity))
  const added = after.entries.filter(entry => !seen.has(entryIdentity(entry)))
  const leaked: BareCommandEvidence['leakedContext'] = []
  for (const entry of added) {
    for (const marker of CONTEXT_PREAMBLE_MARKERS) {
      if (entry.text.includes(marker)) {
        leaked.push({ marker, type: entry.type, excerpt: entry.text.slice(0, 200) })
      }
    }
  }
  return {
    added,
    addedUserMessages: added.filter(entry => entry.type === 'message' && entry.role === 'user'),
    echoedCommand: added.filter(entry => entry.text.includes(command)),
    leakedContext: leaked,
    compactions: added.filter(entry => entry.type === 'compaction').length,
  }
}

/**
 * Identity for the diff.
 *
 * The entry `id` when the file carries one — both SDKs write one — and the
 * type+text pair otherwise. Never the array index: a compaction REWRITES the
 * conversation the file replays, so positions move under a case that trusted
 * them.
 */
export function entryIdentity(entry: RuntimeSessionEntry): string {
  const id = entry.raw.id
  return typeof id === 'string' && id ? `id:${id}` : `text:${entry.type}:${entry.text}`
}
