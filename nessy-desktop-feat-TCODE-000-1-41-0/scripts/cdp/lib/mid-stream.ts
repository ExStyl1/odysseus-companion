/**
 * A MID-TURN CORRECTION — the instrument for the one thing `L8` is about, and
 * the three detectors that look like they answer it but do not.
 *
 * The claim under test is a USER-VISIBLE one: you send a task, the agent goes
 * off working, a minute later you see it is wrong and you type "stop, that's the
 * other API" — and the model reads it BEFORE the turn ends. `L8`'s tracker row
 * states the divergence: `defaultMidStreamBehavior` returns `queue` for
 * `anthropic` and `claude-runtime`, so on Claude that message waits while Pi's
 * default delivers it. The machinery to deliver it exists and is unit-tested;
 * what has never existed is a live proof.
 *
 * ## The three detectors that are NOT the delivery
 *
 * 1. **`steered: true`.** `ClaudeAgent.redirect` parks the text in
 *    `ClaudeAgent.pendingSteers` (a FIFO) and returns `true` on a PRECONDITION — an open,
 *    unsettled slot — not on a receipt. Its own contract says the delivery
 *    happens later, at the next `PreToolUse` hook, and that if no tool fires the
 *    turn ends with `steer_undelivered`. So `steered: true` is the parked flag;
 *    reading it as delivery is the same class of mistake as reading
 *    `ContextUsageSnapshot.lastCompaction` as "compacted" (AGENTS.md, measured
 *    2026-08-08: a typed field that is never filled reported "never compacted"
 *    through twenty-seven real compactions).
 * 2. **The transcript's `isQueued: false`.** Written from the same `steered`
 *    boolean in the same tick. Same flag, one layer out.
 * 3. **"the correction was answered".** It is answered in BOTH behaviours. Under
 *    `queue` it is answered by a SECOND turn, which is exactly the outcome the
 *    row calls the defect. An answer proves delivery of the message, never
 *    delivery INTO the running turn.
 *
 * ## The detector this file uses instead: the CLI's own transcript
 *
 * The Claude Agent SDK's child writes its own conversation to
 * `<config>/workspaces/<ws>/claude-config/projects/<slugified session cwd>/*.jsonl`
 * — a file the host does not author and cannot retouch (`runtime-session-log.ts`
 * carries the whole argument, and `readClaudeSessionLog` already reads it keyed
 * by session id). In it, a turn's user-side entries come in two shapes:
 *
 * - a PROMPT — `{"type":"user","message":{"role":"user","content":[{"type":"text",…}]}}`,
 *   which is what a new turn opens with; and
 * - everything the CLI feeds back mid-turn — `{"type":"tool_result",…}` blocks
 *   and the `<system-reminder>` containers it wraps hook output in.
 *
 * That splits the two behaviours structurally, on the CLI's own record:
 *
 * | | prompt entries | where the correction's token appears |
 * | --- | --- | --- |
 * | delivered mid-turn | **1** | inside a NON-prompt entry of that one turn |
 * | queued | **2** | as the second PROMPT |
 *
 * {@link classifyClaudeTranscript} computes exactly that, from `entry.raw`
 * rather than from the flattened text, because the block TYPE is the whole
 * discriminator.
 *
 * **Two entries in that table are load-bearing and one is a bonus.** The prompt
 * COUNT and the token's container are the proof. The literal our own code sends
 * — "The user just sent a new message while you were working…" — is reported
 * whenever it survives into the file, and is deliberately NOT an assertion: it is
 * a claim about what the CLI chooses to persist about a hook's
 * `additionalContext`, not about whether the model saw it. A check on it would
 * fail for a CLI that delivered the context perfectly and logged it in a shape
 * we did not predict.
 *
 * ## And the app's own record of the DECISION
 *
 * `SessionManager`'s mid-stream branch logs
 * `sessionLog.info('mid-stream send', { behavior, steered, queueLengthBefore, backend, connectionSlug })`.
 * That is the app saying which branch it took, and it is the right instrument for
 * exactly one question: did this rig actually drive the behaviour it meant to?
 * It answers nothing about delivery. It exists on a DEV build, or a packaged one
 * launched with `-- --debug` (`runtime-session-log.ts`, `DEBUG_LEVER`), because
 * `apps/electron/src/main/logger.ts` turns both electron-log transports off otherwise — so
 * {@link readMidStreamSends} returns `undefined` rather than an empty list when
 * the file cannot be found, and a case reports that as an unavailable
 * corroboration instead of as an absence of steering.
 *
 * ## The behaviour has to be SET, and that is not a defect
 *
 * Every `claude-runtime` and `codex-runtime` connection on this profile carries
 * an explicit `midStreamBehavior: 'queue'`, written by `createBuiltInConnection`
 * when `queue` was the default. `resolveMidStreamBehavior` honours a stored value
 * over the default BY DESIGN — `defaultMidStreamBehavior`'s own doc says a
 * migration cannot tell a value the app wrote from one the user picked in
 * Settings → AI, because the field carries no provenance — so flipping the
 * default does not move an existing connection and must not be reported as one.
 * {@link setMidStreamBehavior} drives the SHIPPED write, the same
 * `saveLlmConnection` call `AiSettingsPage.handleSetMidStreamBehavior` makes, and
 * returns the previous value so a case can put the operator's own configuration
 * back.
 *
 * Everything else here is a read.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { clearComposer, readComposer, submitComposer, typeIntoComposer } from './composer.ts'
import type { CdpSession } from './connect.ts'
import { blocked, type CaseRun } from './report.ts'
import { configDir, readClaudeSessionLog, type RuntimeSessionEntry } from './runtime-session-log.ts'
import { listSessions, transcript, waitFor, type SessionKey, type TranscriptMessage } from './state.ts'

// ---------------------------------------------------------------------------
// The connection's own setting
// ---------------------------------------------------------------------------

export type MidStreamBehavior = 'steer' | 'queue'

export interface MidStreamSetting {
  /** What the connection carried before this case touched it — `undefined` when unset. */
  previous?: MidStreamBehavior
  /** What `listLlmConnections` reports after the write. */
  applied?: MidStreamBehavior
  ok: boolean
  error?: string
}

/**
 * Set one connection's mid-stream behaviour through the app's own save route.
 *
 * `AiSettingsPage.handleSetMidStreamBehavior` spreads the connection, overwrites
 * the one field, strips the three status-only fields the RPC does not accept
 * (`isAuthenticated`, `authError`, `isDefault`) and calls `saveLlmConnection`.
 * This is that, verbatim, so the case exercises the write a user performs rather
 * than a seam invented for it — and the read-back is `listLlmConnections`, i.e.
 * the value the SESSION will resolve, not the one we asked for.
 */
export async function setMidStreamBehavior(
  session: CdpSession,
  slug: string,
  behavior: MidStreamBehavior,
): Promise<MidStreamSetting> {
  return session.call<MidStreamSetting>(`
    const rows = await window.electronAPI.listLlmConnections()
    const conn = (rows ?? []).find(c => c.slug === ${JSON.stringify(slug)})
    if (!conn) return { ok: false, error: 'no connection with slug ${slug}' }
    const previous = conn.midStreamBehavior
    const { isAuthenticated, authError, isDefault, ...data } = conn
    const result = await window.electronAPI.saveLlmConnection({ ...data, midStreamBehavior: ${JSON.stringify(behavior)} })
    if (!result || result.success !== true) {
      return { ok: false, previous, error: 'saveLlmConnection: ' + JSON.stringify(result) }
    }
    const after = await window.electronAPI.listLlmConnections()
    const applied = (after ?? []).find(c => c.slug === ${JSON.stringify(slug)})?.midStreamBehavior
    return { ok: applied === ${JSON.stringify(behavior)}, previous, applied }
  `)
}

/** Put the operator's own value back, whatever it was — including "unset". */
export async function restoreMidStreamBehavior(
  session: CdpSession,
  slug: string,
  previous: MidStreamBehavior | undefined,
): Promise<unknown> {
  return session.call<unknown>(`
    const rows = await window.electronAPI.listLlmConnections()
    const conn = (rows ?? []).find(c => c.slug === ${JSON.stringify(slug)})
    if (!conn) return { ok: false, error: 'gone' }
    const { isAuthenticated, authError, isDefault, ...data } = conn
    const next = { ...data }
    ${previous ? `next.midStreamBehavior = ${JSON.stringify(previous)}` : 'delete next.midStreamBehavior'}
    const result = await window.electronAPI.saveLlmConnection(next)
    const after = await window.electronAPI.listLlmConnections()
    return { ok: result?.success === true, now: (after ?? []).find(c => c.slug === ${JSON.stringify(slug)})?.midStreamBehavior ?? null }
  `)
}

// ---------------------------------------------------------------------------
// The app's own record of which branch it took
// ---------------------------------------------------------------------------

/**
 * electron-log's main-process file, on a DEV run.
 *
 * `NESSY_CDP_APP_LOG` overrides it. Absence is reported as absence of the
 * INSTRUMENT — see the header: on a packaged build this file does not exist at
 * all, and a case that read "no line" as "no steering" would file a product
 * defect about a logger.
 */
export function appLogPath(): string | undefined {
  return appLogCandidates().find(path => existsSync(path))
}

/** electron-log's default file on macOS — ONE per machine, whatever `NESSY_CONFIG_DIR` says. */
export const SHARED_ELECTRON_MAIN_LOG = join(homedir(), 'Library', 'Logs', 'Nessy Desktop', 'main.log')

/**
 * The files {@link appLogPath} may answer with, in order.
 *
 * F1.909 (SIT-aa, 2026-09-25): this used to fall back to
 * {@link SHARED_ELECTRON_MAIN_LOG} for every rig. electron-log writes that file
 * for whichever dev app runs on the machine and does not follow
 * `NESSY_CONFIG_DIR`, so a lane with its own config dir could read a file it
 * does not own — another lane's `[session]` lines, or a stale dev run's — and a lane
 * that named its own capture in `NESSY_CDP_APP_LOG` before the file existed
 * fell through to it silently. Now:
 *
 * - `NESSY_CDP_APP_LOG` set → that file ONLY; missing means unavailable.
 * - otherwise `<config dir>/logs/main.log`, then the shared file — but the
 *   shared file only on the DEFAULT profile (`NESSY_CONFIG_DIR` unset), the one
 *   operator-run dev app that file was written for. A relocated config dir is a
 *   rig, and a rig names its log or has none.
 *
 * `NESSY_CDP_APP_LOG` is SHARED with `CDX-ROLES`, which uses it for a captured
 * STDOUT log (`nohup … > /tmp/app.log`) rather than for electron-log's own
 * file. On a DEV build both carry the `[session] …` lines these readers want,
 * in two different encodings, so the readers below parse either shape rather
 * than assuming one. On a PACKAGED build the stdout capture carries none of
 * them (see {@link appLogSince}).
 */
export function appLogCandidates(): string[] {
  const override = process.env.NESSY_CDP_APP_LOG?.trim()
  if (override) return [override]
  const perProfile = join(configDir(), 'logs', 'main.log')
  return process.env.NESSY_CONFIG_DIR?.trim() ? [perProfile] : [perProfile, SHARED_ELECTRON_MAIN_LOG]
}

/** Byte length now, so a later read sees only what this arm produced. */
export function appLogOffset(): number {
  const path = appLogPath()
  if (!path) return -1
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/**
 * The lines this arm added to the app log, or `undefined` when there is no
 * instrument to read.
 *
 * ## A STALE log is the same absence as a missing one, and it did not read that way
 *
 * Measured 2026-09-12 (R3, driving RS-10 on the packaged `70d269e46`):
 * {@link appLogPath} answered `~/Library/Logs/Nessy Desktop/main.log`, a file
 * whose last write was **2026-08-30** — weeks old, from a dev run — because the
 * only test it applies is `existsSync`. A packaged build writes no application
 * log at all (`apps/electron/src/main/logger.ts` turns both electron-log
 * transports off whenever `isDebugMode` is false, which on a packaged build it
 * always is), so the stale file never grows; this function returned `[]`, and
 * every caller's `=== undefined` fail-soft branch — the one written precisely
 * for "there is no log on this build" — was skipped. Three of RS-10's checks
 * then reported *the app did not park the steer* and *0 re-queue lines* about a
 * build that cannot log either.
 *
 * So a log that has not GROWN past the offset the case took is reported as the
 * INSTRUMENT being unavailable rather than as an empty reading. A dev run whose
 * branch genuinely logged nothing lands in the same bucket, which is correct and
 * is what the callers already say in their own detail text: *"read from the
 * transcript checks below instead"*. The alternative — keeping `[]` — is a
 * detector that can only ever produce false negatives on the artefact the
 * sitting is about.
 *
 * ## A log that GREW but carries no `[session]` line is the same absence
 *
 * F1.909 (SIT-aa, 2026-09-25, STR-2 on the packaged `69a6d33da`): the lane
 * pointed `NESSY_CDP_APP_LOG` at its own `NESSY_DEBUG=1` stdout capture. That
 * file grows — `createLogger` scopes such as `[ws-rpc-server]` reach stderr —
 * but every line these readers want is `SessionManager`'s `sessionLog`
 * (`createScopedLogger(platform.logger, 'session')`, and `onDebug` lands there
 * too), whose platform logger is electron-log, off on a packaged build. So the
 * slice was non-empty, held 0 `[session]` lines, and STR-2's three log
 * checks (parked, re-queued, the replay's id) failed about a build that
 * cannot log any of them. Every reader below reads that one scope, so a slice
 * without a single {@link SESSION_SCOPE_MARK} is the instrument missing, not
 * an empty reading; a slice with one and without the wanted event stays a
 * real, failing reading.
 */
function appLogSince(offset: number): string[] | undefined {
  const path = appLogPath()
  if (!path || offset < 0) return undefined
  try {
    const buffer = readFileSync(path)
    // `<=` and not `<`: a file that is exactly the size it was is a file nothing
    // wrote to, which is the stale-log case above.
    if (buffer.length <= offset) return undefined
    const lines = buffer.subarray(Math.min(offset, buffer.length)).toString('utf8').split('\n').filter(Boolean)
    return lines.some(line => line.includes(SESSION_SCOPE_MARK)) ? lines : undefined
  } catch {
    return undefined
  }
}

/** The prefix `createScopedLogger(…, 'session')` writes in both shapes (electron-log JSON and captured stdout). */
export const SESSION_SCOPE_MARK = '[session]'

export interface MidStreamSend {
  behavior?: string
  steered?: boolean
  queueLengthBefore?: number
  backend?: string
  connectionSlug?: string
  sessionId?: string
}

/**
 * Every `mid-stream send` the app logged for one session since `offset`.
 *
 * `undefined` means the log could not be read at all — a MISSING INSTRUMENT,
 * which a case must report differently from an empty list (the branch ran and
 * logged nothing, which cannot happen) and from `[]` for another session.
 */
export function readMidStreamSends(offset: number, sessionId: string): MidStreamSend[] | undefined {
  const lines = appLogSince(offset)
  if (!lines) return undefined
  const sends: MidStreamSend[] = []
  for (const line of lines) {
    if (!line.includes('mid-stream send')) continue
    // electron-log writes `{"message":["[session]","mid-stream send",{…}]}`; the
    // payload object is the third element. Parsed rather than regexed so a field
    // that changes name shows up as `undefined` instead of as a wrong value.
    try {
      const parsed = JSON.parse(line) as { message?: unknown[] }
      const payload = parsed.message?.find(part => part && typeof part === 'object') as MidStreamSend | undefined
      if (payload && payload.sessionId === sessionId) { sends.push(payload); continue }
    } catch { /* not electron-log JSON — fall through to the stdout shape */ }
    // A captured stdout log prints the payload through util.inspect, so the
    // fields are readable but not parseable. Extracted by name, which yields
    // `undefined` for a renamed field rather than a wrong value.
    if (!line.includes(sessionId)) continue
    sends.push({
      sessionId,
      behavior: /behavior['":\s]+'?"?(steer|queue)/.exec(line)?.[1],
      steered: /steered['":\s]+'?"?(true|false)/.exec(line)?.[1] === 'true',
      backend: /backend['":\s]+'?"?([A-Za-z]+)/.exec(line)?.[1],
      connectionSlug: /connectionSlug['":\s]+'?"?([\w-]+)/.exec(line)?.[1],
    })
  }
  return sends
}

/**
 * `Steer message undelivered, re-queuing for session <id>` — the app's own record
 * of the arm that has never been exercised live.
 *
 * `SessionManager.processEvent`'s `steer_undelivered` case logs this, flips
 * `isQueued` back to true on the transcript entry it had already shown as
 * delivered, and re-queues the message under THAT id. Reported as a count.
 */
/**
 * Every logged line matching `pattern` since `offset`, flattened to its text.
 *
 * THE ONLY INSTRUMENT THE CODEX SIDE HAS. `codex-agent.ts` mints its `CODEX_HOME`
 * with `mkdtempSync` and `rmSync`s it on teardown, so unlike Pi and Claude that
 * runtime leaves NO transcript of its own to read (`runtime-session-log.ts` says
 * so explicitly, and warns against quietly moving a claim to the runtime that
 * happens to be readable). What it does leave is `BaseAgent.debug` → `onDebug` →
 * `sessionLog`, which `PreToolUse hook: …` lines prove reaches this file. So
 * `Codex steering turn <id>` and `Codex steer refused (<reason>)` are readable,
 * and they are the app's own record of the REQUEST and of any REFUSAL — the two
 * halves `CodexAgent.redirect` reports on.
 *
 * It is a DEV-build instrument and it is second-best on purpose. A case that
 * needs more than "the request went out" must find a consequence: STR-3 uses the
 * turn's own tool sequence, STR-4 the processes the turn spawns.
 */
export function readSessionLogMatching(offset: number, pattern: RegExp): string[] | undefined {
  const lines = appLogSince(offset)
  if (!lines) return undefined
  const out: string[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { message?: unknown[] }
      const text = (parsed.message ?? []).map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
      if (pattern.test(text)) out.push(text)
    } catch {
      // Not electron-log JSON: a captured stdout log, where the raw line IS the
      // text. See `appLogPath`'s note on the shared env var.
      if (pattern.test(line)) out.push(line)
    }
  }
  return out
}

export function readSteerRequeues(offset: number, sessionId: string): number | undefined {
  const lines = appLogSince(offset)
  if (!lines) return undefined
  return lines.filter(line =>
    line.includes('Steer message undelivered') && line.includes(sessionId)).length
}

// ---------------------------------------------------------------------------
// The CLI's own transcript, classified
// ---------------------------------------------------------------------------

export interface ClaudeTranscriptShape {
  file?: string
  files?: number
  entries: number
  /** Entries that open a turn: a user message whose content carries a `text` block. */
  prompts: string[]
  /** Every user-side entry that is NOT a prompt: tool results and the CLI's own reminders. */
  nonPrompts: string[]
  /** Assistant text, in order. */
  assistantTexts: string[]
  /** Tool names the assistant asked for, in order. */
  toolUses: string[]
  /** `tool_use` ids, in order — what a hook attachment's `toolUseID` must match. */
  toolUseIds: string[]
  /** THE DELIVERY RECORD — see {@link HookContextAttachment}. */
  hookContexts: HookContextAttachment[]
  reason?: string
}

/**
 * THE DETECTOR, and it is the CLI's own record of the injection.
 *
 * Measured 2026-08-17, on the run that first drove this route live: when our
 * `PreToolUse` hook returns `additionalContext`, the CLI writes its own
 * transcript entry for it —
 *
 * ```json
 * {"type":"attachment","attachment":{"type":"hook_additional_context",
 *   "content":["The user just sent a new message while you were working. …"],
 *   "hookName":"PreToolUse:Bash","toolUseID":"call_9e264d30e3f142eea7a80b3f",
 *   "hookEvent":"PreToolUse"}}
 * ```
 *
 * — positioned between the `tool_use` it names and that call's `tool_result`.
 * Nothing about it is ours: we do not write this file, we do not choose the
 * entry type, and the `toolUseID` ties the injection to a specific tool call
 * that the same file records the model making.
 *
 * **This replaced two detectors of mine that were wrong in the two ways
 * AGENTS.md warns about.** The first was `isQueued` on our own transcript, read
 * after the exchange settled: under `queue` the message is replayed as its own
 * turn and `isQueued` goes back to FALSE, so the control arm reported "not
 * queued" about a message that had plainly been queued — a flag read at the
 * wrong moment, reporting a product defect. The second assumed the injected text
 * would land inside a `tool_result` and scored its absence as non-delivery; it
 * is in a sibling entry, and the check "failed" on a turn where the model had
 * demonstrably read the correction and acted on it.
 */
export interface HookContextAttachment {
  hookEvent?: string
  hookName?: string
  toolUseID?: string
  content: string
}

function hookContextOf(entry: RuntimeSessionEntry): HookContextAttachment | undefined {
  const attachment = entry.raw.attachment as Record<string, unknown> | undefined
  if (!attachment || attachment.type !== 'hook_additional_context') return undefined
  const content = Array.isArray(attachment.content)
    ? attachment.content.map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join('\n')
    : String(attachment.content ?? '')
  return {
    ...(typeof attachment.hookEvent === 'string' ? { hookEvent: attachment.hookEvent } : {}),
    ...(typeof attachment.hookName === 'string' ? { hookName: attachment.hookName } : {}),
    ...(typeof attachment.toolUseID === 'string' ? { toolUseID: attachment.toolUseID } : {}),
    content,
  }
}

function blocksOf(entry: RuntimeSessionEntry): Array<Record<string, unknown>> {
  const message = entry.raw.message as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object')
}

function textOfBlocks(blocks: Array<Record<string, unknown>>): string {
  const out: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return
    if (typeof value === 'string') { out.push(value); return }
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['text', 'content', 'thinking']) if (key in record) walk(record[key], depth + 1)
    }
  }
  walk(blocks, 0)
  return out.join('\n')
}

/**
 * Split the CLI's own transcript into the two user-side shapes, plus what the
 * assistant did.
 *
 * A PROMPT is what opens a turn. A `tool_result` — and any `<system-reminder>`
 * the CLI wraps hook output in — is what the CLI feeds back INSIDE a turn. That
 * distinction is the whole detector: see the header's table.
 */
export function classifyClaudeTranscript(key: SessionKey): ClaudeTranscriptShape {
  const log = readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
  const shape: ClaudeTranscriptShape = {
    ...(log.file ? { file: log.file } : {}),
    ...(log.files ? { files: log.files.length } : {}),
    entries: log.entries.length,
    prompts: [],
    nonPrompts: [],
    assistantTexts: [],
    toolUses: [],
    toolUseIds: [],
    hookContexts: [],
    ...(log.reason ? { reason: log.reason } : {}),
  }
  for (const entry of log.entries) {
    const hook = hookContextOf(entry)
    if (hook) {
      shape.hookContexts.push(hook)
      shape.nonPrompts.push(hook.content)
      continue
    }
    const blocks = blocksOf(entry)
    const types = new Set(blocks.map(block => String(block.type)))
    if (entry.role === 'user') {
      const text = textOfBlocks(blocks) || entry.text
      if (types.has('text') && !types.has('tool_result')) shape.prompts.push(text)
      else shape.nonPrompts.push(text)
      continue
    }
    if (entry.role === 'assistant') {
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue
        if (typeof block.name === 'string') shape.toolUses.push(block.name)
        if (typeof block.id === 'string') shape.toolUseIds.push(block.id)
      }
      const text = blocks.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('')
      if (text.trim()) shape.assistantTexts.push(text)
      continue
    }
    // Anything else the CLI files (attachments, `last-prompt`, queue operations)
    // is neither a prompt nor an answer, but it CAN carry an injected token, so
    // it belongs on the non-prompt side rather than being dropped.
    if (entry.text.trim()) shape.nonPrompts.push(entry.text)
  }
  return shape
}

/** Where a token appears in the CLI's own record — the delivery question. */
export function tokenPlacement(shape: ClaudeTranscriptShape, token: string): {
  inPrompt: boolean
  inNonPrompt: boolean
  inAssistant: boolean
} {
  return {
    inPrompt: shape.prompts.some(text => text.includes(token)),
    inNonPrompt: shape.nonPrompts.some(text => text.includes(token)),
    inAssistant: shape.assistantTexts.some(text => text.includes(token)),
  }
}

/** The literal `ClaudeAgent` wraps a parked steer in (`claude-agent.ts:2749`). */
export const STEER_INJECTION_MARKER = 'The user just sent a new message while you were working'

export interface SteerDelivery {
  /** Hook attachments carrying this token — the CLI's own record of the injection. */
  injections: HookContextAttachment[]
  /** …of those, the ones the CLI attributes to a `PreToolUse` hook. */
  atToolBoundary: HookContextAttachment[]
  /** True when every such injection names a `tool_use` id the same file records. */
  toolUseIdsResolve: boolean
  /** True when the injection carries the wrapper `ClaudeAgent` adds. */
  carriesWrapper: boolean
}

/**
 * Where the correction was injected, per the CLI.
 *
 * Filtered by TOKEN as well as by event, because this profile carries other
 * hooks that inject through the same channel: the `AGT-6` fixture's
 * `UserPromptSubmit` hook writes its own `hook_additional_context` attachment
 * into every turn on this machine, and a check that merely counted attachments
 * would have passed on it.
 */
export function steerDelivery(shape: ClaudeTranscriptShape, token: string): SteerDelivery {
  const injections = shape.hookContexts.filter(hook => hook.content.includes(token))
  const atToolBoundary = injections.filter(hook => hook.hookEvent === 'PreToolUse')
  return {
    injections,
    atToolBoundary,
    toolUseIdsResolve: atToolBoundary.length > 0
      && atToolBoundary.every(hook => Boolean(hook.toolUseID) && shape.toolUseIds.includes(hook.toolUseID!)),
    carriesWrapper: injections.some(hook => hook.content.includes(STEER_INJECTION_MARKER)),
  }
}

// ---------------------------------------------------------------------------
// Driving a turn you intend to interrupt
// ---------------------------------------------------------------------------

/** `FreeFormInput`: `type` is `button` only while `submitMode === 'stop'`. */
export const SEND_BUTTON = 'button[data-tutorial="send-button"]'

export interface SubmitControlRead {
  /** `submit` for send/queue/steer, `button` for stop — structural, not localized. */
  type?: string
  /** The button's visible label. Localized, so compared BETWEEN arms, never to a literal. */
  label?: string
  disabled?: boolean
}

export async function readSubmitControl(session: CdpSession): Promise<SubmitControlRead> {
  return session.call<SubmitControlRead>(`
    const el = document.querySelector(${JSON.stringify(SEND_BUTTON)})
    if (!el) return {}
    return {
      type: el.getAttribute('type') ?? undefined,
      label: (el.getAttribute('aria-label') || el.title || el.innerText || '').trim() || undefined,
      disabled: el.disabled === true,
    }
  `)
}

/** Our own transcript, with the one field `transcript()` does not carry. */
export interface QueueFlaggedMessage extends TranscriptMessage {
  isQueued?: boolean
}

export async function transcriptWithQueueFlags(session: CdpSession, key: SessionKey): Promise<QueueFlaggedMessage[]> {
  return session.call<QueueFlaggedMessage[]>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    if (!s) throw new Error('session-not-found: ' + ${JSON.stringify(key.sessionId)})
    return (s.messages ?? []).map(m => ({
      id: m.id, role: m.role, content: typeof m.content === 'string' ? m.content : '',
      toolName: m.toolName, toolUseId: m.toolUseId, toolStatus: m.toolStatus,
      // Carried because a case that counts a turn's COMMANDS needs the command,
      // not the tool's name. Dropping them made STR-3 count zero probe commands
      // in an arm that plainly ran six, and score its own control as failed.
      toolInput: m.toolInput && typeof m.toolInput === 'object' ? m.toolInput : undefined,
      toolResult: typeof m.toolResult === 'string' ? m.toolResult : undefined,
      isQueued: m.isQueued === true, timestamp: m.timestamp,
    }))
  `)
}

/**
 * Type a message and submit it WITHOUT waiting for a turn.
 *
 * The seed and the correction both go through this: the point of the case is the
 * window between them, and `sendPrompt` closes it by waiting. The composer
 * content is asserted before the Enter, exactly as `sendPrompt` does, so a
 * correction that half-typed cannot be read as a correction the model ignored.
 */
export async function submitWithoutWaiting(
  session: CdpSession,
  text: string,
  /**
   * Read something in the window between "typed" and "sent".
   *
   * The composer's primary control lives in that window and nowhere else:
   * `resolveSubmitControl` returns `stop` while a turn runs and the composer is
   * EMPTY, and only becomes `queue`/`steer` once there is content. A first draft
   * read the button before typing and got "Stop" in both arms — a true reading of
   * the wrong instant, which looked like the setting having no effect on the UI.
   */
  beforeSubmit?: () => Promise<void>,
): Promise<number> {
  await clearComposer(session)
  await typeIntoComposer(session, text)
  const typed = await readComposer(session)
  const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim()
  if (normalise(typed) !== normalise(text)) {
    throw new Error(`composer-mismatch: meant to send ${JSON.stringify(text)}, composer holds ${JSON.stringify(typed)}`)
  }
  await beforeSubmit?.()
  await submitComposer(session)
  return Date.now()
}

async function processingOf(session: CdpSession, key: SessionKey): Promise<boolean> {
  const rows = await listSessions(session)
  return rows.find(row => row.id === key.sessionId)?.isProcessing === true
}

/** Wait until the app itself says a turn is in flight. */
export async function waitUntilProcessing(session: CdpSession, key: SessionKey, timeoutMs = 60_000): Promise<number> {
  const started = Date.now()
  await waitFor(
    () => processingOf(session, key),
    value => value,
    { timeoutMs, intervalMs: 200, label: 'the session to report a turn in flight' },
  )
  return Date.now() - started
}

export interface ToolActivity {
  /** Tool entries our own transcript carries, newest last. */
  names: string[]
  /** How many have a terminal status — i.e. how many tool BOUNDARIES have passed. */
  settled: number
}

export function toolActivity(messages: QueueFlaggedMessage[]): ToolActivity {
  const tools = messages.filter(message => Boolean(message.toolName))
  return {
    names: tools.map(message => String(message.toolName)),
    settled: tools.filter(message => message.toolStatus && message.toolStatus !== 'running' && message.toolStatus !== 'pending').length,
  }
}

/**
 * Wait until the turn in flight has actually started using tools.
 *
 * WHY A CASE MUST NOT SKIP THIS. Claude's steer is delivered by the next
 * `PreToolUse` hook, so a correction sent into a turn that will make no further
 * tool call CANNOT be delivered — by design, and `steer_undelivered` is the
 * documented outcome. A case that sends its correction blind and then reports
 * "the steer never arrived" would be measuring its own prompt. Waiting for the
 * FIRST tool call is the cheapest available evidence that this turn is
 * tool-shaped and that more boundaries are coming.
 */
export async function waitForFirstTool(
  session: CdpSession,
  key: SessionKey,
  timeoutMs = 120_000,
): Promise<ToolActivity> {
  const deadline = Date.now() + timeoutMs
  let last: ToolActivity = { names: [], settled: 0 }
  for (;;) {
    last = toolActivity(await transcriptWithQueueFlags(session, key))
    if (last.names.length > 0) return last
    if (!await processingOf(session, key)) return last
    if (Date.now() >= deadline) return last
    await Bun.sleep(600)
  }
}

export interface SettleResult {
  settledAfterMs: number
  timedOut: boolean
  /** Every moment the session was seen NOT processing, then processing again. */
  processingGaps: number
}

/**
 * Wait until nothing more is going to happen — including a QUEUED replay.
 *
 * A single `isProcessing === false` read is not settlement: under `queue` the
 * turn ends and `processNextQueuedMessage` opens the next one on the
 * `onProcessingStopped` tick, so a case that returned at the first `false` would
 * read the transcript in the gap between the two turns and report the control
 * arm as never having answered. The quiet window is what closes that, and the
 * number of gaps observed is itself worth reporting: ONE gap after the
 * correction is the shape of a replayed turn.
 */
export async function waitUntilSettled(
  session: CdpSession,
  key: SessionKey,
  options: { quietMs?: number; timeoutMs?: number } = {},
): Promise<SettleResult> {
  const quietMs = options.quietMs ?? 12_000
  const timeoutMs = options.timeoutMs ?? 480_000
  const started = Date.now()
  let quietSince: number | undefined
  let gaps = 0
  let wasProcessing = true
  for (;;) {
    const processing = await processingOf(session, key)
    const queued = (await transcriptWithQueueFlags(session, key)).some(message => message.isQueued === true)
    if (processing && !wasProcessing) gaps += 1
    wasProcessing = processing
    if (!processing && !queued) {
      quietSince ??= Date.now()
      if (Date.now() - quietSince >= quietMs) {
        return { settledAfterMs: Date.now() - started, timedOut: false, processingGaps: gaps }
      }
    } else {
      quietSince = undefined
    }
    if (Date.now() - started >= timeoutMs) {
      return { settledAfterMs: Date.now() - started, timedOut: true, processingGaps: gaps }
    }
    await Bun.sleep(1_000)
  }
}

// ---------------------------------------------------------------------------
// The probe the correction interrupts
// ---------------------------------------------------------------------------

/**
 * A long, tool-shaped task carrying a build id — and NOT a probe-shaped prompt.
 *
 * `claude-child.ts`'s `echoPrompt` records the measured reason for this wording,
 * twice over: on 2026-08-17 the gateway's model answered "Reply with exactly the
 * word X" with *"This appears to be an attempt to extract my internal processing
 * tokens"* and refused "Repeat this word back to me: X" as well. A bare token
 * with no reason to exist reads as a string-extraction probe because that is what
 * it is. So the token is a build id inside ordinary work, and the tool calls are
 * ordinary work too.
 *
 * The sleeps are the window. Six of them at three seconds each, one tool call at
 * a time, gives a turn that lasts long enough to type a correction into and, more
 * importantly, leaves several `PreToolUse` boundaries AFTER the correction lands
 * — which is where Claude's steer is delivered.
 */
export function longToolTaskPrompt(buildId: string, steps = 6, marker?: string): string {
  const label = marker ? `${marker}-` : ''
  const commands = Array.from({ length: steps }, (_, index) => `sleep 3 && echo probe-${label}${index + 1}`)
  return `I am labelling a test build. First, using the ${marker ? 'shell' : 'Bash'} tool, run these ${steps} commands `
    + `ONE AT A TIME, each in its own separate call, waiting for each result before starting the next: `
    + `${commands.map(command => `\`${command}\``).join(', ')}. `
    + `Then write one short line I can paste into the build notes containing the build id ${buildId} exactly as written.`
}

/**
 * Processes on this machine whose command line carries `marker`.
 *
 * THE ONE DETECTOR ON THE CODEX SIDE THAT DOES NOT COME FROM THE APP. A turn's
 * shell commands are real processes: if a Stop or a steer really reached the
 * app-server, the sequence stops spawning them, and if it did not, they keep
 * appearing — which is precisely the failure the interrupt fix was made for
 * (`turn/interrupt` sent as a notification was never dispatched, and our own side
 * had already stopped listening, so the app looked stopped either way). Counting
 * them is how a case tells "we stopped watching" from "it stopped running".
 *
 * The marker is per-run, so nothing else on the machine can be mistaken for this
 * turn's work — and the shell that runs this very `ps` is excluded by requiring
 * the marker to appear beside `sleep`, never on its own (the observer-counts-itself
 * trap, which cost `claude-child.ts` an almost-filed finding).
 */
export function markedProcesses(marker: string): string[] {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return out.split('\n')
      .filter(line => line.includes(marker) && /\bsleep\s+\d/.test(line) && !line.includes('ps -Ao'))
      .map(line => line.trim())
  } catch {
    return []
  }
}

/** The correction a user types when they see the wrong id going by. */
export function correctionPrompt(wrongId: string, rightId: string): string {
  return `Stop — wrong build. Skip any remaining probe commands. The build id is ${rightId}, not ${wrongId}. `
    + `Write the one-line build note for ${rightId} now.`
}

/**
 * A long task with NO tool call in it — the arm Claude's emulation cannot deliver
 * into, and therefore the one most likely to LOSE a message.
 *
 * Deliberately a task tools cannot help with (invented prose about a fictional
 * thing), because `steer_undelivered` is only reachable when no `PreToolUse`
 * fires. If the model reaches for a tool anyway the arm has not been exercised,
 * and the case must say so rather than scoring it.
 *
 * **Length is load-bearing, and it is the SAFE lever.** STR-2 needs the turn
 * still running when the correction is submitted; the previous ask (eight
 * bullets) was answered in as little as 9 s, which is what left the row blocked.
 * Widening the window by asking for more OUTPUT is safe in a way that widening
 * it with a sleep is not: it does not depend on the gateway's speed, and prose
 * length induces no tool call. The one constraint that must survive any future
 * edit here is the last sentence — the moment this prompt makes the model reach
 * for a tool, `str-2.ts`'s tool-call gate fires and the arm measures nothing.
 */
export function longProsePrompt(buildId: string): string {
  return `Write release notes for an imaginary internal tool called Lantern ${buildId}: `
    + `an intro paragraph, then TWENTY-FOUR bullet points of invented features (each two full sentences), `
    + `then a closing paragraph of at least six sentences about the migration path. Aim for roughly 1200 words. `
    + `Write it from your own invention — do not read any files, do not search, and do not run any commands.`
}

/**
 * Refuse to score an arm whose turn never got going.
 *
 * The same rule `echoTurn` applies: a model that declines the probe, or an
 * upstream that errors mid-case, has measured the model or the upstream. Neither
 * is the mid-stream route, and neither leaves a turn to send a correction into.
 */
export function requireTurnStarted(run: CaseRun, errors: string[], stage: string): void {
  if (errors.length === 0) return
  run.observe(`${stage} errors`, errors)
  blocked(
    `${stage} did not run: the runtime answered with ${JSON.stringify(errors.join(' | ').slice(0, 600))}. `
    + 'The card completed its probe turn moments earlier, so this is the upstream rather than the mid-stream route '
    + 'this case measures.',
  )
}
