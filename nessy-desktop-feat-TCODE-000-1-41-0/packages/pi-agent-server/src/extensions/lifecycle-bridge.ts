import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'; import { rewriteWholeToolDenyNotFound } from './whole-tool-deny-context.ts' // F1.1100
import {
  AGENT_EVENT_CONTRACTS_V1,
  type AgentEvent,
  type AgentEventContractV1,
  type SdkAutomationInput,
} from '../../../shared/src/automations/types.ts'

export const PI_LIFECYCLE_COMPONENT_ID = 'nessy.lifecycle-bridge' as const

/**
 * Frozen per-hook semantic contract table (hooks-semantics / hooks-complete-inventory).
 *
 * Every documented lifecycle hook is represented exactly once, in the canonical
 * inventory order, with:
 * - `owner`: the single authority that triggers the hook (one hook authority — this
 *   bridge and the existing X4A/X5/X6/X7 owners, never a second dispatcher).
 * - `kind`: `decision` for the frozen decision-bearing hooks (PreToolUse receipt/epoch
 *   and PermissionRequest); every other hook is `observational` and can never block or
 *   bypass a permission receipt.
 * - `ordering`: the delivery-order guarantee relative to the surrounding lifecycle.
 * - `terminalDelivery`: how many times the hook fires for one occurrence/turn/session.
 */
export type PiLifecycleHookContract = AgentEventContractV1
export const PI_LIFECYCLE_HOOK_CONTRACTS: readonly PiLifecycleHookContract[] = AGENT_EVENT_CONTRACTS_V1

export interface PiLifecycleBridgeOptions {
  emit(event: AgentEvent, input: SdkAutomationInput): Promise<void> | void
  /**
   * The session working directory, used as the resolution base for
   * `FileChanged.file_path`. hooks.md § FileChanged input requires an
   * "Absolute path to the file that changed", and a model's tool argument is
   * absolute only by luck. REQUIRED rather than defaulted to `process.cwd()`:
   * a missed call site must be a typecheck error, not a silently wrong base.
   */
  cwd: string
  getOriginalUserPrompt(): string | null
  transformToolResult?(input: {
    toolName: string
    toolInput: Record<string, unknown>
    toolResponse: string
    isError: boolean
  }): Promise<{ updatedToolOutput?: string } | void> | { updatedToolOutput?: string } | void
  /**
   * R73 · the AWAITED half of `PreCompact`.
   *
   * hooks.md#precompact: "Exit with code 2 to block compaction. For a manual
   * `/compact`, the stderr message is shown to the user. You can also block by
   * returning JSON with `\"decision\": \"block\"`", and hooks.md's exit-code
   * table row is "`PreCompact` | Yes | Blocks compaction".
   *
   * `emit` cannot carry that: it is `Promise<void> | void` and its sink is a
   * fire-and-forget `send()`, so a decision the contract layer already produced
   * had no path back to this handler's return value. When this callback is
   * present the bridge awaits IT INSTEAD OF `emit` — one emission per
   * compaction, never both, or the host would run the hook twice.
   */
  requestCompactionDecision?(input: {
    trigger: 'manual' | 'auto'
    source: string
    /** D1.115 — `null` on `auto`, and on a `manual` the user passed nothing to. */
    customInstructions: string | null
  }): Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void
}

export function createPiLifecycleSinkGate(
  emit: PiLifecycleBridgeOptions['emit'],
  initiallyOpen = false,
): { emit: PiLifecycleBridgeOptions['emit']; open(): void } {
  let open = initiallyOpen
  return Object.freeze({
    emit: async (event: AgentEvent, input: SdkAutomationInput) => {
      if (open) await emit(event, input)
    },
    open: () => { open = true },
  })
}

/**
 * Tools whose successful completion means a file was written on disk.
 *
 * The trigger is TOOL COMPLETION, not the disk watch hooks.md#filechanged
 * describes ("Runs when a watched file changes on disk"). One documented
 * `event` value is therefore structurally unreachable: `unlink` needs a
 * deletion, and no tool in this set deletes. A file removed by bash, by an
 * external editor, or by any tool outside this set produces no event at all.
 * Recorded here so a reader does not file the missing value as a defect of the
 * mapping below — it is a defect of the trigger, tracked separately.
 */
const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'replace_in_file', 'multi_edit'])

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Extract the source slug from a genuine external `mcp__<server>__<tool>` proxy
 * name. Nessy's own session tools present as `mcp__session__*` and are excluded
 * (they own dedicated lifecycle hooks such as TaskCreated/TaskCompleted), matching
 * the deferred-mcp exclusion so internal proxies never emit MCP hooks.
 */
function mcpServerFromToolName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__') || toolName.startsWith('mcp__session__')) return undefined
  const server = toolName.slice('mcp__'.length).split('__')[0]
  return server && server.length > 0 ? server : undefined
}

/**
 * Project Pi's compaction reason onto `PreCompact`/`PostCompact`'s documented
 * matcher vocabulary. Pi's `SessionBeforeCompactEvent`/`SessionCompactEvent`
 * declare `reason: "manual" | "threshold" | "overflow"` ("manual /compact, the
 * context threshold, or context overflow recovery"); hooks.md#precompact
 * defines exactly two matcher values, `manual` for `/compact` and `auto` for
 * "Auto-compact when the context window is full". Both non-manual Pi reasons
 * are context-driven, so both are `auto`. An absent reason is `auto` too: only
 * `/compact` is user-initiated, and mislabelling an automatic compaction as
 * manual would fire a `/compact`-only hook on every threshold compaction.
 */
function compactTrigger(reason: unknown): 'manual' | 'auto' {
  return reason === 'manual' ? 'manual' : 'auto'
}

function mutatedPath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  return optionalString(record.path) ?? optionalString(record.file_path) ?? optionalString(record.filePath)
}

export function createPiLifecycleExtension(options: PiLifecycleBridgeOptions): ExtensionFactory {
  return pi => {
    let lastCwd: string | undefined
    let sessionStarted = false
    let turnCounter = 0
    let currentTurnCorrelation = 'turn-0'
    // The Pi SDK only carries tool args on `tool_execution_start`; `tool_execution_end`
    // has no args. Correlate the mutated path across the pair by tool call id so
    // FileChanged can carry a real path (mirrors the session-tool correlation the
    // adapter already does for session_tool_completed).
    // `existed` is probed BEFORE the tool runs, which is the only moment the
    // documented `add` / `change` split is observable: after the write every
    // path exists. See the FileChanged emit below.
    const pendingFilePaths = new Map<string, { filePath?: string; existed: boolean }>()
    const pendingMcp = new Map<string, { server: string; tool: string; correlation: string }>()

    pi.on('session_start', async () => {
      if (sessionStarted) return
      sessionStarted = true
      // R73 · f001 · `Setup` is NOT emitted here any more, and no longer exists
      // as an event at all. hooks.md#setup: "Fires only when you launch Claude
      // Code with `--init-only`, or with `--init` or `--maintenance` in
      // non-interactive mode with the `-p` flag. It doesn't fire on normal
      // startup." A Pi runtime start IS a normal startup, so this emit was not
      // an approximation of the documented occurrence — it was the one case the
      // page excludes, and the page's next sentence says why that matters: "For
      // per-session initialization, use SessionStart instead." An author
      // reaches for Setup to keep a dependency install OFF the per-session
      // path; we ran it there every time. Nessy has no such launch mode, so
      // there is no correct occurrence to emit instead — the event left the
      // inventory rather than keep a producer the page forbids. See
      // `UNEMITTED_HOOK_EVENT_REASONS` in `shared/automations/types.ts`.
      // `InstructionsLoaded` is NOT emitted here. hooks.md#instructionsloaded
      // fires it once per LOADED FILE with `file_path`, `memory_type` and
      // `load_reason`; this subprocess has no instruction inventory, so the only
      // event it could ever produce was one content-free session-scoped ping.
      // The host owns it now — `BaseAgent.emitInstructionsLoaded`, which reads
      // the pinned capability layers it is describing.
      await options.emit('SessionStart', { hook_event_name: 'SessionStart', source: 'startup' })
    })
    pi.on('before_agent_start', async () => {
      currentTurnCorrelation = `turn-${++turnCounter}`
      const prompt = options.getOriginalUserPrompt()
      if (prompt !== null) {
        await options.emit('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt })
      }
      // R73 · `UserPromptExpansion` is NOT emitted here any more, for the same
      // reason `InstructionsLoaded` moved host-side above.
      // `hooks.md#userpromptexpansion` fires it "when a user-typed command
      // expands into a prompt" (fetched 2026-08-25; the anchor read
      // `#userprompt` because a line wrap split the slug in two),
      // once per expanded command, carrying `expansion_type`, `command_name`,
      // `command_args`, `command_source` and the original `prompt`. This
      // subprocess has no command inventory, so the only event it could produce
      // was one content-free per-TURN ping — fired even for a plain message
      // that expanded nothing, and matchable by nothing. The host owns it now:
      // `SessionManager.emitUserPromptExpansion`, called from the SEND_MESSAGE
      // handler before the command is resolved, so a block can still prevent
      // the expansion.
    })
    // Unlike the later tool_execution_end notification, tool_result is a
    // decision-free middleware seam: hooks may replace model-visible output,
    // but cannot authorize, block, or re-run the completed tool.
    pi.on('tool_result', async event => {
      if (!options.transformToolResult) return undefined
      const toolResponse = event.content
        .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
        .map(item => item.text)
        .join('\n')
      try {
        const transformed = await options.transformToolResult({
          toolName: event.toolName,
          toolInput: event.input,
          toolResponse,
          isError: event.isError,
        })
        if (transformed?.updatedToolOutput === undefined) return undefined
        return { content: [{ type: 'text', text: transformed.updatedToolOutput }] }
      } catch {
        return undefined
      }
    })
    // hooks.md#precompact-input — "In addition to the common input fields,
    // PreCompact hooks receive `trigger` and `custom_instructions`. For
    // `manual`, `custom_instructions` contains what the user passes into
    // `/compact` and is `null` when they pass nothing. For `auto`,
    // `custom_instructions` is `null`." (Verbatim 2026-09-11, anchor verified
    // on the rendered page. The line-numbered citation this block carried until
    // then quoted an OLDER sentence, ending "is empty", beside a JSON example
    // carrying `""` — the page has since moved both to `null`.)
    //
    // D1.115 — the divergence this block used to record IS NOW CLOSED. It read
    // "we still emit `''`, deliberately and for now", because the field was
    // typed `string` and the superseded wording was quoted twice more in
    // `shared/src/automations/types.ts`. Both quotes and the declaration moved
    // with this change, and so did the four other carriers that spell
    // `customInstructions` between Pi's own event and the hook payload — which
    // is why it was a payload contract change rather than a one-line edit.
    //
    // The page moved FURTHER than the row that noticed. It is `null` on `auto`
    // AND on a `manual` compaction the user passed nothing to, so `''` was
    // wrong on both triggers. That is what the mapping below now says.
    //
    // `optionalString` is deliberately NOT used — it drops empty strings and
    // would make the key VANISH, the one shape no version of the page has ever
    // described: the documented absence is a present `null`. Pi supplies the
    // value on `SessionBeforeCompactEvent.customInstructions` (set on the
    // manual path, `undefined` on the auto path), which is exactly the
    // documented split, and an empty manual string is the user passing
    // nothing.
    pi.on('session_before_compact', async (event: { reason?: string; customInstructions?: string; signal?: AbortSignal }) => {
      const source = optionalString(event?.reason) ?? 'compact'
      const trigger = compactTrigger(event?.reason)
      const customInstructions = typeof event?.customInstructions === 'string' && event.customInstructions !== ''
        ? event.customInstructions
        : null
      // R73 · one emission, not two. With the awaited callback present the
      // fire-and-forget `emit` is skipped entirely: running both would fire the
      // hook twice for one compaction, and the second run would be the one that
      // could not decide anything.
      if (options.requestCompactionDecision) {
        // F1.591 — Pi 0.85 made `AgentSession.abort()` cancel a running compaction
        // and then WAIT for it to end (`isIdle` is false while compacting), and the
        // compaction awaits this handler. So the host's verdict must not hold a Stop:
        // Pi hands every `session_before_compact` handler the compaction's `signal`,
        // and once it aborts the answer is Pi's own cancel — a manual `/compact` then
        // throws `Compaction cancelled`, the string `handleCompact` already reads as
        // the Stop's. A compaction cancelled before this runs never asks the host.
        const signal = event?.signal
        if (signal?.aborted) return { cancel: true }
        let decision: { block?: boolean; reason?: string } | void | typeof COMPACTION_ABORTED
        try {
          decision = await untilAborted(options.requestCompactionDecision({ trigger, source, customInstructions }), signal)
        } catch {
          // FAIL OPEN, and swallow here rather than letting it reach
          // `runner.emit` — the runner swallows a handler throw itself, so an
          // escaping error would lose the reason AND still fail open, just
          // silently.
          return undefined
        }
        if (decision === COMPACTION_ABORTED) return { cancel: true }
        return decision?.block ? { cancel: true } : undefined
      }
      await options.emit('PreCompact', {
        hook_event_name: 'PreCompact',
        trigger,
        custom_instructions: customInstructions,
        source,
      })
      return undefined
    })
    // hooks.md#postcompact-input — "In addition to the common input fields,
    // PostCompact hooks receive `trigger` and `compact_summary`. The
    // `compact_summary` field contains the conversation summary generated by
    // the compact operation." (Verbatim 2026-09-11; the anchor replaces a line
    // number that had already moved.) Read off the compaction entry Pi already
    // saved (`CompactionEntry.summary`), never recomputed.
    pi.on('session_compact', async (event: { reason?: string; compactionEntry?: { summary?: string } }) => {
      await options.emit('PostCompact', {
        hook_event_name: 'PostCompact',
        trigger: compactTrigger(event?.reason),
        compact_summary: typeof event?.compactionEntry?.summary === 'string' ? event.compactionEntry.summary : '',
        source: optionalString(event?.reason) ?? 'compact',
      })
    })
    // P6.1078 · a FAILED compaction gets NO terminal hook event, and that is
    // the posture, not an oversight. `session_compact_failed` is reachable from
    // exactly here and nowhere else in this fork; no handler is registered for
    // it.
    //
    // Pi fires it on the very surface this bridge listens on —
    // `on(event: "session_compact_failed", handler)` in
    // `core/extensions/types.d.ts` — carrying `reason`, `errorMessage`,
    // `aborted`, `willRetry` and `fromExtension` ("True when the failing
    // compaction content came from a session_before_compact handler"), which is
    // the one field the host cannot learn from Pi's own `compaction_end`. The
    // session-event adapter structurally cannot receive it (it consumes
    // `AgentSessionEvent`, which the event is absent from —
    // `shared/src/agent/backend/pi/compaction-failure-surface.test.ts` pins
    // that), so this module is the whole of the opportunity. It is declined:
    //
    // 1. hooks.md#hook-events lists `PostCompact` as "After context compaction
    //    completes", and hooks.md#postcompact opens "Runs after Claude Code
    //    completes a compact operation." A failed compaction is not a completed
    //    one.
    // 2. That same table publishes a failure sibling exactly where upstream
    //    wanted one — `PostToolUseFailure`, "After a tool call fails";
    //    `StopFailure`, "When the turn ends due to an API error" — and none for
    //    compaction. The absence is a decision upstream took, not a hole. (Read
    //    the table, never a count of it: it held 33 rows on 2026-09-11 and has
    //    grown twice this year.)
    // 3. The page documents a `PreCompact` with no compaction after it and
    //    names the terminal such a turn DOES get. hooks.md#precompact:
    //    "Blocking automatic compaction has different effects depending on when
    //    it fires. If compaction was triggered proactively before the context
    //    limit, Claude Code skips it and the conversation continues
    //    uncompacted. If compaction was triggered to recover from a
    //    context-limit error already returned by the API, the underlying error
    //    surfaces and the current request fails." A request that fails ends the
    //    turn, which is `StopFailure` — and both runtimes already mint it
    //    (`PiAgent.emitStopFailureHookOnce`, `CodexAgent.emitCodexStopFailureHook`).
    //    So a dangling `PreCompact` is Claude's own documented shape.
    // 4. Codex agrees at the host seam, which is what makes this the UNIFORM
    //    answer rather than the quiet one: `CodexAgent.emitCodexPostCompactHook`
    //    fires only from a compaction codex ANNOUNCED, and codex announces only
    //    completed ones. Minting a failure `PostCompact` on Pi alone would
    //    CREATE a cross-runtime divergence, not close one.
    // 5. A marker in the payload could not be opted out of. `PostCompact`'s
    //    matcher vocabulary is `manual`/`auto` (hooks.md#postcompact), so a hook
    //    written to the page would still RUN on the failure and read
    //    `compact_summary` — `''`, which is also what a SUCCESSFUL codex
    //    compaction carries — with no matcher able to exclude it.
    //
    // Deciding otherwise is an owner call, and these are the two shapes it would
    // choose between, both wire changes outside this module: a new
    // `PostCompactFailure` member of the frozen `AGENT_EVENT_CONTRACTS_V1` table
    // (its own matcher, no page behind it), or `PostCompact` plus an
    // `outcome`/`error_details` marker (in the page's vocabulary, unfilterable).
    // Neither is smaller than silence, so silence ships. `lifecycle-bridge.test.ts`
    // pins the absence with a success control beside it, so a handler added here
    // without reading this block turns that test red.
    // Observational: a user bash run reports its effective cwd; emit only on delta.
    //
    // hooks.md:2562 — "In addition to the common input fields, CwdChanged hooks
    // receive `old_cwd` and `new_cwd`." The page's own JSON example carries
    // `cwd` AND `new_cwd` holding the SAME value, with `old_cwd` holding the
    // directory left behind, so these are ADDITIVE aliases and not renames.
    // `previous_cwd` stays as a permanent read-path alias of `old_cwd` — stored
    // native automations and hook scripts were authored against it, the same
    // convention `mode-types.ts` uses for legacy permission-mode spellings.
    pi.on('user_bash', async (event: { cwd?: string }) => {
      const cwd = optionalString(event?.cwd)
      if (cwd && cwd !== lastCwd) {
        const previous = lastCwd
        lastCwd = cwd
        await options.emit('CwdChanged', {
          hook_event_name: 'CwdChanged',
          cwd,
          new_cwd: cwd,
          ...(previous ? { old_cwd: previous, previous_cwd: previous } : {}),
        })
      }
    })
    // Observational: MCP tool interactions begin; also stash the file path for
    // mutating tools so the completion event can report it (end carries no args).
    pi.on('tool_execution_start', async (event: { toolCallId?: string; toolName?: string; args?: unknown }) => {
      const toolName = optionalString(event?.toolName)
      if (!toolName) return
      const server = mcpServerFromToolName(toolName)
      if (server) {
        const toolCallId = optionalString(event?.toolCallId)
        const correlation = toolCallId ?? `${currentTurnCorrelation}:mcp`
        if (toolCallId) pendingMcp.set(toolCallId, { server, tool: toolName, correlation })
        await options.emit('McpElicitation', {
          hook_event_name: 'McpElicitation',
          mcp_server: server,
          mcp_tool: toolName,
          lifecycle_version: 1,
          correlation_id: correlation,
        })
        return
      }
      const toolCallId = optionalString(event?.toolCallId)
      if (toolCallId && FILE_MUTATING_TOOLS.has(toolName)) {
        const raw = mutatedPath(event?.args)
        const filePath = raw ? resolve(options.cwd, raw) : undefined
        pendingFilePaths.set(toolCallId, {
          ...(filePath ? { filePath } : {}),
          existed: filePath ? existsSync(filePath) : false,
        })
      }
    })
    // Observational: a completed tool means a file changed (mutating tools) or an
    // MCP interaction produced a result.
    pi.on('tool_execution_end', async (event: { toolCallId?: string; toolName?: string; isError?: boolean }) => {
      const toolName = optionalString(event?.toolName)
      if (!toolName) return
      const server = mcpServerFromToolName(toolName)
      if (server) {
        const toolCallId = optionalString(event?.toolCallId)
        const pending = toolCallId ? pendingMcp.get(toolCallId) : undefined
        if (toolCallId) pendingMcp.delete(toolCallId)
        const correlation = pending?.correlation ?? toolCallId ?? `${currentTurnCorrelation}:mcp`
        await options.emit('McpResult', {
          hook_event_name: 'McpResult',
          mcp_server: server,
          mcp_tool: toolName,
          lifecycle_version: 1,
          correlation_id: correlation,
        })
        await options.emit('ElicitationResult', {
          hook_event_name: 'ElicitationResult', mcp_server: server, mcp_tool: toolName,
          lifecycle_version: 1, correlation_id: correlation,
          outcome: event?.isError ? 'failure' : 'success',
        })
        return
      }
      const toolCallId = optionalString(event?.toolCallId)
      const pending = toolCallId ? pendingFilePaths.get(toolCallId) : undefined
      if (toolCallId) pendingFilePaths.delete(toolCallId)
      if (!event?.isError && FILE_MUTATING_TOOLS.has(toolName)) {
        const filePath = pending?.filePath
        await options.emit('FileChanged', {
          hook_event_name: 'FileChanged',
          // hooks.md:2636 — "In addition to the common input fields, FileChanged
          // hooks receive `file_path` and `event`"; `file_path` is the
          // "Absolute path to the file that changed" (resolved against the
          // session cwd above) and `event` is `"change"` for a modified file,
          // `"add"` for a created file, `"unlink"` for a deleted file. `add`
          // vs `change` comes from the pre-write existence probe, the only
          // moment the distinction is observable; `unlink` is unreachable under
          // this trigger — see FILE_MUTATING_TOOLS.
          ...(filePath ? { file_path: filePath, event: pending?.existed ? 'change' : 'add' } : {}),
          // Emitted ALIASES, deliberately kept rather than renamed away:
          // `change_kind` (the mutating tool name) and `path` are on the frozen
          // AGENT_EVENT_CONTRACTS_V1 row and stored native automations and hook
          // scripts were authored against them. `path` now carries the same
          // resolved absolute value as `file_path`, so the two cannot disagree.
          change_kind: toolName,
          ...(filePath ? { path: filePath } : {}),
        })
      }
    })
    pi.on('turn_end', async (event: { toolResults?: Array<{ isError?: boolean }> }) => {
      const results = Array.isArray(event?.toolResults) ? event.toolResults : []
      await options.emit('PostToolBatch', {
        hook_event_name: 'PostToolBatch', lifecycle_version: 1,
        correlation_id: currentTurnCorrelation,
        batch_count: results.length,
        error_count: results.filter(result => result?.isError === true).length,
      })
    })
    pi.on('session_shutdown', async () => {
      for (const pending of pendingMcp.values()) {
        await options.emit('ElicitationResult', {
          hook_event_name: 'ElicitationResult', mcp_server: pending.server, mcp_tool: pending.tool,
          lifecycle_version: 1, correlation_id: pending.correlation, outcome: 'cancelled',
        })
      }
      pendingMcp.clear()
      pendingFilePaths.clear()
    })
    // F1.1100 — before every model call: a deny-removed tool's "Tool <name> not found" reads as its rule
    // (`whole-tool-deny-context.ts`). Returns nothing when nothing changed, so Pi keeps its own array.
    pi.on('context', event => {
      const messages = rewriteWholeToolDenyNotFound(event.messages)
      return messages ? { messages } : undefined
    })
  }
}

/** F1.591 — what {@link untilAborted} settles with when the compaction's signal aborts first. */
const COMPACTION_ABORTED: unique symbol = Symbol('compaction aborted')

/**
 * F1.591 — settle with `pending`, or with {@link COMPACTION_ABORTED} the moment
 * `signal` aborts, whichever comes first. The host's answer, if it arrives later,
 * is dropped here; the server's own drain (`clearPendingPreToolUse`) settles its
 * pending request after the Stop.
 */
function untilAborted<T>(
  pending: Promise<T> | T,
  signal: AbortSignal | undefined,
): Promise<T | typeof COMPACTION_ABORTED> {
  if (!signal) return Promise.resolve(pending)
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(COMPACTION_ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(pending).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}
