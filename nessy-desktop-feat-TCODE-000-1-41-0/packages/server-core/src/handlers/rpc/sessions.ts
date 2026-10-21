import { readFile, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { RPC_CHANNELS, parsePiAgentViewControlRequestV1, parsePiAgentViewPageRequestV1, parsePiHarnessRuntimeControlRequestV1, type FileAttachment, type MemoryAppendResult, type MemoryAppendScope, type SendMessageOptions, type SessionEvent } from '@nessy-agent/shared/protocol'
import type { PiHarnessRuntimeSnapshotResultV1 } from '@nessy-agent/core/types'
import type { SessionAttachmentDto } from '@nessy-agent/core/types'
import { getMemoryEnabled } from '@nessy-agent/shared/config'
import {
  PERMISSION_MODE_ORDER, REMOTE_CLIENT_PERMISSION_MODE_CEILING,
  isPermissionModeAllowedForRemoteClient, parsePermissionMode,
} from '@nessy-agent/shared/agent/mode-types'
import { isLocalClient } from '../../transport/capabilities'
import { appendMemoryFile, getProjectMemoryFilePath, getUserMemoryFilePath } from '@nessy-agent/shared/agent/memory'
import { perf } from '@nessy-agent/shared/utils'
import { isValidThinkingLevel, THINKING_LEVEL_IDS } from '@nessy-agent/shared/agent/thinking-levels'
import { checkoutBranch, listBranches } from '../../workspace/git-branches'
import { computeReviewDiffWithGit } from '@nessy-agent/shared/prompts/review-diff'
import { splitUnifiedDiffByFile } from '@nessy-agent/shared/slash-commands'
import type { WorkingTreeDiffResult } from '@nessy-agent/shared/protocol'
import { SessionFileHandleRegistry } from '../../domain/session-file-handles'
import { resolveContainedPath } from '@nessy-agent/shared/workspaces'
import type { SessionKey } from '@nessy-agent/shared/sessions'
import type { CustomSlashCommandId, CustomSlashCommandSource } from '@nessy-agent/shared/slash-commands/common'
import { expandSkillArguments } from '@nessy-agent/shared/capabilities/runtime-skill-content'
import {
  MAX_STACKED_SKILL_COMMANDS,
  leadingSlashCommandTokens,
  skillEndsCommandStack,
  skillSlashCommandId,
  skillSlashCommandName,
  type ResolvedCustomSlashCommand,
} from '@nessy-agent/shared/slash-commands'
import { describeCustomSlashCommandId } from '../../sessions/custom-command-expansion'
import { fenceHookBand } from '@nessy-agent/shared/automations'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrThrow } from '../utils'
import { setTransferableHandler } from './transfer'

interface ClientSessionWatchState {
  watcher: import('fs').FSWatcher
  sessionId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>()
const sessionFileHandles = new SessionFileHandleRegistry()

const SESSION_GET_LOG_ID_LIMIT = 25

/**
 * Expand a resolved custom command's body against the invocation tail.
 *
 * `skills.md:16` — "**Custom commands have been merged into skills.** A file at
 * `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md`
 * both create `/deploy` and work the same way. Your existing `.claude/commands/`
 * files keep working. Skills add optional features: a directory for supporting
 * files, frontmatter to control whether you or Claude invokes them, and the
 * ability for Claude to load them automatically when relevant." So the command
 * path owes the SAME substitution table as the skill path, which
 * `claude-directory.md:304` states for the `commands/` folder in its own words:
 * "`$ARGUMENTS` substitutes whatever you typed after the command name. For
 * positional access, use `$0` `$1` and so on." (The other half of that same
 * line describes `` !`...` `` shell execution, which stays out of scope — the
 * plugin importer detects and DEFERS it rather than evaluating it.)
 *
 * The table is implemented once, in `expandSkillArguments`
 * (`packages/shared/src/capabilities/runtime-skill-content.ts`) — `$ARGUMENTS`,
 * `$ARGUMENTS[N]` (0-based), the `$N` shorthand, shell-style quoting of the
 * tail, an indexed placeholder with no argument left "unchanged"
 * (`skills.md:353`), and a single backslash escaping the token
 * (`skills.md:355`). Reusing it is the point: a second matcher here would drift
 * from the skill path, and the two would disagree on the same `/name`.
 *
 * Three things this function is deliberately responsible for:
 *
 *  - LEGACY TOKEN. Nessy's own `{{args}}` is normalised in the AUTHORED BODY
 *    only, never in the arguments. That keeps the one-pass guarantee: the
 *    expander writes substituted text to the output and never re-scans it, so an
 *    argument that itself contains `$0`, `{{args}}` or `${HOME}` stays inert
 *    text rather than a second substitution round driven by whoever typed it.
 *  - NO DECLARED NAMES. The third argument is `[]`. `parseCustomCommand` reads
 *    only `description` and `model` from command frontmatter, so there is no
 *    `arguments:` list to map `$name` onto on this path (skills have one).
 *  - MCP IS EXEMPT. An MCP prompt command consumes the tail at RESOLUTION time
 *    (`mapMcpPromptArguments` maps it onto the server's declared parameters and
 *    `getPrompt` renders it), so the body reaching here is server-authored prose
 *    with the arguments already inside it. Running the table over that would
 *    rewrite a `$1.00` or a `$0` that the MCP server meant literally, using
 *    arguments that were already consumed. Left byte-for-byte alone.
 *
 * No shell invocation, no env/file interpolation, and no recursion anywhere.
 */
function expandCustomCommandArguments(
  command: { body: string; source: CustomSlashCommandSource },
  args: string,
): string {
  if (command.source === 'mcp') return command.body
  const body = command.body.replace(/\{\{args\}\}/g, () => '$ARGUMENTS')
  return expandSkillArguments(body, args, []).text
}

/**
 * Expand a leading RUN of stacked skill commands, per `commands.md:13` and
 * `skills.md:488`-`:490`.
 *
 * `skills.md:488`, whole line: "You can also stack several skills at the start
 * of one message. Typing `/write-tests /fix-issue 123` loads both skills and
 * passes the trailing text `123` as `$ARGUMENTS` to each of them. Before
 * v2.1.199, only the first skill loaded and received `/fix-issue 123` as literal
 * argument text." — which is precisely what this fork did until now.
 *
 * Four rules, each with its own guard below:
 *
 *  1. ONLY SKILLS START A RUN. `commands.md:13` makes skills "the exception" to
 *     the one-command rule; a native, plugin, workflow or MCP command keeps the
 *     whole tail. The MCP and workflow branches would in any case be wrong to
 *     share a tail with a sibling — one consumes `args` at resolution, the other
 *     dispatches it as `{ input }`.
 *  2. STOP AT THE FIRST NON-SKILL TOKEN. Resolution IS the test: only an inline
 *     user-invocable skill ever gets a `custom:skill:<name>` id minted for it
 *     (`selectSkillSlashCommands` drops `user-invocable: false` and a
 *     `skillOverrides` state of `off`), so a token that fails to resolve is
 *     exactly the doc's "first token that isn't an inline user-invocable skill".
 *  3. A STACK-ENDING SKILL ENDS THE RUN (`skillEndsCommandStack`) — `/loop`,
 *     whose own first argument may itself be a slash command.
 *  4. SIX AT MOST, and never the same skill twice (a duplicate token is consumed
 *     as part of the run but materialises once).
 *
 * Cost note: each accepted token costs one extra `resolveCustomSlashCommand`,
 * which resolves a capability snapshot. Bounded at five, and paid only when the
 * leading command is a skill AND its tail begins with `/` — a plain
 * `/my-skill 123` pays nothing.
 */
async function resolveStackedSkillCommands(
  sessionManager: HandlerDeps['sessionManager'],
  session: SessionKey,
  leadingCommandId: CustomSlashCommandId,
  leadingCommand: ResolvedCustomSlashCommand,
  tail: string,
): Promise<{ commands: ResolvedCustomSlashCommand[]; args: string }> {
  // Both halves of rule 1: the id the caller sent must be a skill id, and what
  // it resolved to must actually be a skill. Either check alone would be enough
  // today, and keeping both is what makes the workflow branch below provably
  // safe — `args` is only ever shortened on a route that has no `workflowInvocation`.
  if (leadingCommand.source !== 'skill') return { commands: [], args: tail }
  const leadingName = skillSlashCommandName(leadingCommandId)
  if (leadingName === null || skillEndsCommandStack(leadingName)) return { commands: [], args: tail }

  const commands: ResolvedCustomSlashCommand[] = []
  const claimed = new Set<string>([leadingCommandId])
  let args = tail
  for (const token of leadingSlashCommandTokens(tail, MAX_STACKED_SKILL_COMMANDS - 1)) {
    if (skillEndsCommandStack(token.name)) break
    const id = skillSlashCommandId(token.name)
    if (claimed.has(id)) {
      args = token.rest
      continue
    }
    const resolved = await sessionManager.resolveCustomSlashCommand(session, id)
    if (!resolved || resolved.source !== 'skill') break
    claimed.add(id)
    commands.push(resolved)
    args = token.rest
  }
  return { commands, args }
}

function resolveMemoryAppendPath(
  sessionManager: HandlerDeps['sessionManager'],
  sessionId: string,
  scope: MemoryAppendScope,
  workspaceId?: string,
): string | null {
  if (scope === 'user') {
    // P6.704 — no argument, deliberately.
    //
    // This used to pass `process.env.NESSY_CONFIG_DIR`, which was merely
    // redundant until P6.390(2) and is LOSSY since: `CONFIG_DIR`
    // (`config/paths.ts`) already derives from that variable, and
    // `getUserMemoryFilePath`'s contract is that an EXPLICIT directory outranks
    // the setting — so on a machine that sets `NESSY_CONFIG_DIR` (every
    // multi-instance dev run, and every test rig) this one RPC wrote the user's
    // memory somewhere other than their `autoMemoryDirectory`, while every
    // other reader honoured it. Unset, the two are byte-identical, which is why
    // it went unnoticed.
    return getUserMemoryFilePath()
  }

  const workingDirectory = sessionManager.getWorkingDirectory(sessionId, workspaceId)
  return workingDirectory ? getProjectMemoryFilePath(workingDirectory) : null
}

function appendMemoryForSession(
  sessionManager: HandlerDeps['sessionManager'],
  sessionId: string,
  scope: MemoryAppendScope,
  text: string,
  workspaceId?: string,
): MemoryAppendResult {
  const memory = text.trim()
  if (!memory) {
    return { success: false, scope, error: 'memory must not be empty.' }
  }

  try {
    if (!getMemoryEnabled()) {
      return { success: false, scope, error: 'Memory is disabled for this workspace.' }
    }
  } catch {
    // Match prompt loading behavior: memory defaults on if config cannot be read.
  }

  const filePath = resolveMemoryAppendPath(sessionManager, sessionId, scope, workspaceId)
  if (!filePath) {
    return {
      success: false,
      scope,
      error: scope === 'project'
        ? 'Project memory requires a session working directory.'
        : 'User memory path is unavailable.',
    }
  }

  try {
    appendMemoryFile(filePath, memory)
    return { success: true, scope }
  } catch {
    return {
      success: false,
      scope,
      error: 'Failed to append memory.',
    }
  }
}

function summarizeIds(ids: Iterable<string>, limit = SESSION_GET_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function sessionWorkspaceDistribution(sessions: Array<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/**
 * Clean up session file watcher for a client.
 * Called from main process disconnect hooks to prevent watcher leaks.
 */
export function cleanupSessionFileWatchForClient(clientId: string): void {
  sessionFileHandles.clearClient(clientId)
  const state = clientSessionWatches.get(clientId)
  if (!state) return

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }

  state.watcher.close()
  clientSessionWatches.delete(clientId)
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_PI_HARNESS_RUNTIME,
  RPC_CHANNELS.sessions.CONTROL_PI_HARNESS_RUNTIME,
  RPC_CHANNELS.sessions.LIST_PI_AGENT_VIEW,
  RPC_CHANNELS.sessions.CONTROL_PI_AGENT_VIEW,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.FUZZY_FILE_SEARCH,
  RPC_CHANNELS.sessions.QUEUE_GET,
  RPC_CHANNELS.sessions.QUEUE_DELETE,
  RPC_CHANNELS.sessions.QUEUE_REORDER,
  RPC_CHANNELS.sessions.QUEUE_SEND_NOW,
  RPC_CHANNELS.sessions.QUEUE_RESUME,
  RPC_CHANNELS.sessions.GIT_BRANCHES,
  RPC_CHANNELS.sessions.GIT_CHECKOUT,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.sessions.STOP_AGENT_TASK,
  RPC_CHANNELS.sessions.READ_TASK_OUTPUT,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.REVOKE_FILESYSTEM_ROOT,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.GET_CAPABILITY_INVENTORY,
  RPC_CHANNELS.sessions.SAVE_WORKFLOW_RECIPE,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.OPEN_FILE,
  RPC_CHANNELS.sessions.PREVIEW_FILE,
  RPC_CHANNELS.sessions.OPEN_ATTACHMENT,
  RPC_CHANNELS.sessions.REVEAL_STORAGE,
  RPC_CHANNELS.sessions.COPY_STORAGE_PATH,
  RPC_CHANNELS.sessions.OPEN_ARTIFACT,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
  // P6.750's pair. Both were REGISTERED below and declared nowhere — the
  // `lspServers` shape AGENTS.md names, and the second time this table has been
  // short (P3.317 declared the two notification channels for the same reason).
  // The declaration is what the registration guard, the channel inventory and
  // every reader of this profile see, so a handler missing from it is a live
  // verb nothing can account for.
  RPC_CHANNELS.sessions.RECONNECT_MCP_SERVER,
  RPC_CHANNELS.sessions.GET_MCP_SERVER_STATUSES,
] as const

export function registerSessionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager, platform } = deps
  const log = platform.logger

  /**
   * Resolve the caller's Workspace ID from the transport envelope (W5).
   * Every RPC connection is workspace-scoped: `ctx.workspaceId` comes from the
   * connection handshake; on Electron each renderer window is additionally bound
   * to one workspace via the window manager. Session-addressed calls pass this
   * alongside the bare sessionId so SessionManager resolves the composite
   * SessionKey (duplicate session IDs across live workspaces never collide).
   */
  const ctxWorkspace = (ctx: { workspaceId?: string | null; webContentsId?: number | null }): string | undefined => {
    const windowWorkspaceId = ctx.webContentsId != null
      ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
      : undefined
    return ctx.workspaceId ?? windowWorkspaceId ?? undefined
  }

  const sessionKeyFor = (
    ctx: { workspaceId?: string | null; webContentsId?: number | null },
    ref: SessionKey | string,
  ): SessionKey => {
    const envelopeWorkspaceId = ctxWorkspace(ctx)
    const session = typeof ref === 'string'
      ? { workspaceId: envelopeWorkspaceId ?? '', sessionId: ref }
      : ref
    if (!session.workspaceId || !session.sessionId || session.workspaceId !== envelopeWorkspaceId) {
      throw new Error('session-scope-mismatch')
    }
    return session
  }

  // Get all sessions for the calling window's workspace
  // Waits for initialization to complete so sessions are never returned empty during startup
  server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_SESSIONS continuing after initialization failure:', error)
    }
    const end = perf.start('rpc.getSessions')
    const windowWorkspaceId = ctx.webContentsId != null
      ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
      : undefined
    const workspaceId = ctxWorkspace(ctx) ?? windowWorkspaceId
    const sessions = sessionManager.getSessions(workspaceId ?? undefined)
    end()

    log.info('[sessions:get] result', {
      ctxWorkspaceId: ctx.workspaceId,
      webContentsId: ctx.webContentsId,
      windowWorkspaceId,
      resolvedWorkspaceId: workspaceId,
      returnedCount: sessions.length,
      returnedWorkspaceIds: sessionWorkspaceDistribution(sessions),
      returnedIds: summarizeIds(sessions.map(s => s.id)),
    })

    return sessions
  })

  server.handle(RPC_CHANNELS.sessions.GET_PI_HARNESS_RUNTIME, async (ctx, ref: SessionKey | string): Promise<PiHarnessRuntimeSnapshotResultV1> => {
    const session = sessionKeyFor(ctx, ref)
    const barrierSeq = server.getClientLastSentSeq?.(ctx.clientId)
    if (barrierSeq === undefined) throw new Error('rpc-client-not-connected')
    const snapshot = await sessionManager.getPiHarnessRuntimeSnapshot(session)
    return { snapshot, barrierSeq }
  })

  server.handle(RPC_CHANNELS.sessions.CONTROL_PI_HARNESS_RUNTIME, async (ctx, value: unknown) => {
    const request = parsePiHarnessRuntimeControlRequestV1(value)
    const session = sessionKeyFor(ctx, request.session)
    return sessionManager.controlPiHarnessRuntime({ ...request, session })
  })

  /**
   * P6.57 — this pair IS the "what is running in my session" surface, and the
   * measurement that matters is that it already exists.
   *
   * `listPiAgentView` projects, per session, `active: { children, processes,
   * workflows }`, the live task counts, `needsInput`, `state` and `residency`;
   * `controlPiAgentView` carries the actions. The ledger row that opened P6.57
   * scored the capability `absent` on all three runtimes because it looked for
   * the COMMANDS (`/tasks`, `/workflows`, `/plugin`) and found none — and no
   * command opens this, so the user cannot reach it.
   *
   * TWO things are missing, and they are different sizes:
   *  - a command that opens it. That needs a `SessionCommand` kind, a parse arm
   *    and a renderer route, none of which is here.
   *  - the LISTING is Pi-only: `SessionManager.listPiAgentView` filters on
   *    `resolveManagedProvider(managed) === 'pi'`, so on a claude or codex
   *    session it answers an empty page rather than "not supported". Some of
   *    what it reports is genuinely a Pi construct (child sessions, supervised
   *    processes, workflow evaluators); `isProcessing`, `needsInput`, the task
   *    counts and the context usage are not. That asymmetry is a switch
   *    divergence, and it is stated here rather than left to be re-measured,
   *    because the filter lives in a file this lane does not hold.
   */
  server.handle(RPC_CHANNELS.sessions.LIST_PI_AGENT_VIEW, async (ctx, value: unknown) => {
    await sessionManager.waitForInit()
    const workspaceId = ctxWorkspace(ctx)
    if (!workspaceId) throw new Error('workspace-scope-required')
    return sessionManager.listPiAgentView(workspaceId, parsePiAgentViewPageRequestV1(value))
  })

  server.handle(RPC_CHANNELS.sessions.CONTROL_PI_AGENT_VIEW, async (ctx, value: unknown) => {
    const request = parsePiAgentViewControlRequestV1(value)
    const session = sessionKeyFor(ctx, request.session)
    return sessionManager.controlPiAgentView({ ...request, session })
  })

  // Get unread summary across all workspaces
  server.handle(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY, async () => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_UNREAD_SUMMARY continuing after initialization failure:', error)
    }
    return sessionManager.getUnreadSummary()
  })

  server.handle(RPC_CHANNELS.sessions.MARK_ALL_READ, async (_ctx, workspaceId: string) => {
    return sessionManager.markAllSessionsRead(workspaceId)
  })

  // Get a single session with messages (for lazy loading)
  server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async (ctx, sessionId: string) => {
    const end = perf.start('rpc.getSessionMessages')
    const session = await sessionManager.getSession(sessionId, ctxWorkspace(ctx))
    end()
    return session
  })

  // Create a new session. F1.1000: options.permissionMode is alias-resolved or refused first ({@link resolveWireCreatePermissionMode}).
  server.handle(RPC_CHANNELS.sessions.CREATE, async (_ctx, workspaceId: string, options?: import('@nessy-agent/shared/protocol').CreateSessionOptions) => {
    const end = perf.start('rpc.createSession', { workspaceId })
    const session = await sessionManager.createSession(workspaceId, resolveWireCreatePermissionMode(options))
    end()
    return session
  })

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (ctx, sessionId: string) => {
    return sessionManager.deleteSession(sessionId, ctxWorkspace(ctx))
  })

  // Send a message to a session (with optional file attachments).
  //
  // Behavior:
  //   - Awaits until the user message is persisted to disk, then returns
  //     `{ accepted: true, messageId }`. This guarantees the message survives
  //     a mid-stream crash (#616).
  //   - The actual model-streaming work continues in the background; results
  //     flow back via SESSION_EVENT as before.
  //   - Pre-persist errors (session not found, etc.) reject the RPC so the
  //     caller can show a synchronous error.
  //   - Post-persist errors (model API failures, etc.) are routed via the
  //     event stream as today.
  // Stored attachment paths remain server-side; renderer returns only staged handles.
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, async (ctx, sessionId: string, message: string, attachments?: FileAttachment[], attachmentRefs?: SessionAttachmentDto[], options?: SendMessageOptions, customSlashCommandId?: CustomSlashCommandId) => {
    // Capture the caller's clientId for error routing
    const callerClientId = ctx.clientId
    const workspaceId = ctxWorkspace(ctx)
    if (!workspaceId) throw new Error('workspace-required')
    let modelMessage: string | undefined
    let workflowInvocation: import('@nessy-agent/shared/agent/backend/types').WorkflowInvocation | undefined
    if (customSlashCommandId) {
      // Preserve the invocation tail (whatever the caller sent as `message`) as
      // the command's arguments. An MCP prompt command consumes them at
      // resolution (quote-aware, mapped onto declared parameters via getPrompt);
      // every other command type gets the documented placeholder table applied
      // by `expandCustomCommandArguments` below.
      let args = message.trim()
      // R73 · hooks.md#userpromptexpansion — "Runs when a user-typed command
      // expands into a prompt before reaching Claude", carrying
      // `expansion_type`, `command_name`, `command_args`, `command_source` and
      // "the original `prompt` string".
      //
      // BEFORE `resolveCustomSlashCommand`, not after, because the page gives
      // the event a real block ("`decision: \"block\"` prevents the command
      // from expanding") and resolution is where the expansion actually
      // happens: an MCP prompt command calls the server's `getPrompt` inside
      // it, and a command carrying `model:` switches the session model right
      // after. Emitting later would let a "blocked" command still have
      // rendered remotely and moved the user's model.
      const expansion = describeCustomSlashCommandId(customSlashCommandId)
      const expansionDecision = await sessionManager.emitUserPromptExpansion?.(
        { workspaceId, sessionId },
        {
          hook_event_name: 'UserPromptExpansion',
          expansion_type: expansion.expansionType,
          command_name: expansion.commandName,
          command_args: args,
          command_source: expansion.commandSource,
          prompt: args ? `/${expansion.commandName} ${args}` : `/${expansion.commandName}`,
        },
      )
      if (expansionDecision?.blocked) throw new Error(expansionDecision.blocked)
      const command = await sessionManager.resolveCustomSlashCommand(
        { workspaceId, sessionId },
        customSlashCommandId,
        args,
      )
      if (!command) throw new Error('custom-slash-command-unavailable')
      // `commands.md:13` — "A command is only recognized at the start of your
      // message. Text that follows the command name becomes its arguments. As of
      // v2.1.199, skills are the exception: a skill invocation followed by more
      // skills, such as `/skill-a /skill-b do XYZ`, loads every skill named at
      // the start and passes the trailing text to each as arguments. Up to six
      // skills can be chained."
      //
      // The renderer is deliberately NOT the place this run is parsed. It sends
      // one id plus the untouched tail, so the tail after `/skill-a` is literally
      // `/skill-b do XYZ`; the stop rule ("the first token that isn't an inline
      // user-invocable skill", `skills.md:490`) is a RESOLUTION question, and
      // resolution lives here. Parsing it here also keeps `SEND_MESSAGE`'s
      // positional wire shape unchanged — a scalar id, as every existing client
      // and the frozen adjacent-backend contract already send.
      const stacked = await resolveStackedSkillCommands(
        sessionManager,
        { workspaceId, sessionId },
        customSlashCommandId,
        command,
        args,
      )
      args = stacked.args
      const commands = [command, ...stacked.commands]
      const labels = commands.map(entry => entry.label).join(' ')
      message = args ? `${labels} ${args}` : labels
      // The SAME argument text into EVERY body, per `commands.md:13` ("passes the
      // trailing text to each as arguments") — not partitioned between them. That
      // yields `[skill:a] do XYZ\n[skill:b] do XYZ`, which `runtimeSkillArguments`
      // (whose contract is "arguments following the last matching `[skill:...]`
      // reference, up to the next skill mention") then reads back as `do XYZ` for
      // both. The naive `[skill:a] [skill:b] do XYZ` would silently hand the first
      // skill an EMPTY argument string.
      modelMessage = commands.map(entry => expandCustomCommandArguments(entry, args)).join('\n')
      // hooks.md#userpromptexpansion-decision-control — `additionalContext` is
      // "String added to Claude's context alongside the expanded prompt", so it
      // rides the expanded body rather than replacing it (the page's `decision`
      // table gives this event no rewrite channel at all).
      //
      // UB12.103 — and it rides it FENCED. The text is a hook's bytes (exit-0
      // plain stdout included, `UserPromptExpansion` being one of the four
      // context events), and hooks.md#add-context-for-claude has Claude Code
      // wrap the string in a system reminder and turn a `<system-reminder>`
      // tag's `<` into `&lt;`. `fenceHookBand` is this fork's one expression
      // for that, the same `hook_context` element, notice, untrusted fence and
      // defang every runtime's other hook band and `PostModelSwitch`'s
      // (UB12.69) carry. Appended raw, a forged `</system-reminder>` reached
      // the model as harness text, the D1.237 defect class in a file the
      // `hook-band-fence.test.ts` census (`packages/shared/src` only) cannot see.
      const expansionBand = fenceHookBand({
        element: 'hook_context',
        source: 'hook_context',
        body: expansionDecision?.additionalContext,
        attributes: { event: 'UserPromptExpansion' },
      })
      if (expansionBand) modelMessage = `${modelMessage}\n\n${expansionBand}`
      if (command.source === 'workflow') {
        if (!command.workflowInvocation) throw new Error('workflow-command-dispatch-unavailable')
        // `workflows.md:225` — "If `args` is omitted, the global is `undefined`
        // inside the script." `args` is already `message.trim()` (above), so a
        // tail-less `/my-workflow` is exactly `args === ''`; attaching
        // `{ input: '' }` for it made the script's `args ?? default`,
        // `if (!args)` and `args === undefined` branches unreachable on the one
        // route a user actually takes. Omitting the key instead leaves it absent
        // on the wire — JSON cannot carry `undefined` — and the workflow tool
        // forwards the absence verbatim.
        workflowInvocation = {
          ...command.workflowInvocation,
          ...(args ? { args: { input: args } } : {}),
        }
      }
      // FIRST resolved command only. A stack is skills, which carry no `model`
      // hint at all; taking a last-wins model from a later entry would silently
      // reorder a model switch the user did not ask for.
      if (command.model) await sessionManager.updateSessionModel(sessionId, workspaceId, command.model)
    }
    const storedAttachments = attachmentRefs?.length
      ? sessionManager.resolveStagedAttachments(
          callerClientId,
          sessionId,
          workspaceId,
          attachmentRefs.map(attachment => attachment.handleId),
        )
      : undefined

    return await new Promise<{ accepted: true; messageId: string }>((resolve, reject) => {
      let acked = false
      const onAck = (messageId: string) => {
        if (!acked) {
          acked = true
          resolve({ accepted: true, messageId })
        }
      }

      sessionManager
        .sendMessage(
          sessionId,
          message,
          attachments,
          storedAttachments,
          options,
          undefined,
          undefined,
          onAck,
          { callerClientId, workspaceId },
          modelMessage,
          workflowInvocation,
        )
        .then(() => {
          // sendMessage finished without firing onAck — should not happen in
          // practice (every code path that creates a user message acks).
          // Treat as a defensive failure rather than silently dropping.
          if (!acked) {
            acked = true
            reject(new Error('sendMessage completed without persisting a user message'))
          }
        })
        .catch(async err => {
          // An Error JSON-serializes to {}, and one empty log line cost a live
          // diagnosis (2026-07-31): eight wave cases failed on one hidden cause.
          // Log the parts that survive serialization.
          log.error('Error in sendMessage:', err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : err)
          if (!acked) {
            // Pre-persist error — surface synchronously to the caller.
            acked = true
            reject(err)
            return
          }
          // Post-persist error — route via the event stream as today.
          //
          // P3.19 · this is the TENTH renderer-facing `complete`, and the only one
          // emitted outside `SessionManager`. It cannot go through
          // `sendTurnEndEvent` — that broadcasts to the workspace and this report
          // is addressed to one client — so it takes the door's flush half
          // explicitly, and the queued-text decision stays in the one place that
          // owns it. Without this, a delta still in the 50 ms batcher is delivered
          // by its own timer AFTER this `complete`, which is the shape P3.16
          // measured through the real renderer: a second bubble with a duplicated
          // prefix, or one that spins until a later turn heals it.
          //
          // NOT theoretical, and the exemption this row first considered does not
          // survive measurement: the post-turn cleanup block in `sendMessage`'s
          // `finally` runs OUTSIDE the chat loop's own catch and its throws are
          // rethrown to here — after the model streamed, with text still queued.
          // The rig, the control and the three cleanup members are in
          // `sessions/post-turn-cleanup-failure.test.ts`.
          //
          // F1.994 · the report itself (the flush, then `error` + `complete` to
          // the calling client) is `reportPostPersistTurnFailure` at the end of
          // this file, because `capabilities:submitManagedEdit` answers at the
          // same ack and needs the same arm (`capabilities.ts` symbol
          // `untilTurnDispatched`). One function in this file, so the P3.21
          // bench still sees the one out-of-door emitter it declares here, not
          // an eleventh renderer-facing `complete` somewhere else. A failing
          // flush still must not swallow the error report it precedes.
          await reportPostPersistTurnFailure(
            server,
            sessionManager,
            log,
            { clientId: callerClientId, sessionId, workspaceId },
            err,
          )
        })
    })
  })

  // Cancel processing
  //
  // D1.377 — a Stop the host could not deliver is REPORTED, never ignored. Both
  // renderer call sites used to end in `.catch(error => console.error(…))`, so a
  // rejected cancel left the button looking like it had worked, the turn still
  // running, and nothing anywhere a user or a support read could find. The
  // rejection still travels to the caller (which now surfaces it); this is the
  // host's own record of the same event, on the one seam every Stop passes
  // through — the composer button, Esc-Esc and the CLI alike.
  server.handle(RPC_CHANNELS.sessions.CANCEL, async (ctx, sessionId: string, silent?: boolean) => {
    try {
      return await sessionManager.cancelProcessing(sessionId, silent, ctxWorkspace(ctx))
    } catch (error) {
      log.warn(`Stop could not be delivered for session ${sessionId}:`, error)
      throw error
    }
  })

  server.handle(RPC_CHANNELS.sessions.FUZZY_FILE_SEARCH, async (ctx, sessionId: string, query: string) =>
    sessionManager.fuzzyFileSearch(sessionId, query, ctxWorkspace(ctx)))

  server.handle(RPC_CHANNELS.sessions.QUEUE_GET, async (ctx, sessionId: string) =>
    sessionManager.getQueuedMessages(sessionId, ctxWorkspace(ctx)))

  server.handle(RPC_CHANNELS.sessions.QUEUE_DELETE, async (ctx, sessionId: string, messageId: string) =>
    sessionManager.deleteQueuedMessage(sessionId, messageId, ctxWorkspace(ctx)))

  server.handle(RPC_CHANNELS.sessions.QUEUE_REORDER, async (ctx, sessionId: string, messageId: string, toIndex: number) =>
    sessionManager.reorderQueuedMessage(sessionId, messageId, toIndex, ctxWorkspace(ctx)))

  server.handle(RPC_CHANNELS.sessions.QUEUE_SEND_NOW, async (ctx, sessionId: string, messageId: string) =>
    sessionManager.sendQueuedNow(sessionId, messageId, ctxWorkspace(ctx)))

  server.handle(RPC_CHANNELS.sessions.QUEUE_RESUME, async (ctx, sessionId: string) =>
    sessionManager.resumeQueue(sessionId, ctxWorkspace(ctx)))

  server.handle(RPC_CHANNELS.sessions.GIT_BRANCHES, async (ctx, sessionId: string) => {
    const cwd = sessionManager.getWorkingDirectory(sessionId, ctxWorkspace(ctx))
    return cwd ? listBranches(cwd) : { status: 'no-cwd' as const }
  })

  server.handle(RPC_CHANNELS.sessions.GIT_CHECKOUT, async (ctx, sessionId: string, branch: string, autoStash?: boolean) => {
    const cwd = sessionManager.getWorkingDirectory(sessionId, ctxWorkspace(ctx))
    return cwd
      ? checkoutBranch(cwd, branch, { autoStash: autoStash === true })
      : { status: 'error' as const, error: 'Session has no working directory' }
  })

  // Kill background shell
  server.handle(RPC_CHANNELS.sessions.KILL_SHELL, async (ctx, sessionId: string, shellId: string) => {
    return sessionManager.killShell(sessionId, shellId, ctxWorkspace(ctx))
  })

  // Stop a background AGENT task (L9). The shell half is KILL_SHELL above; this
  // one is the half the renderer used to fake with a console warning.
  server.handle(RPC_CHANNELS.sessions.STOP_AGENT_TASK, async (ctx, sessionId: string, taskId: string) => {
    return sessionManager.stopAgentTask(sessionId, taskId, ctxWorkspace(ctx))
  })

  // L9 — read a RUNNING background task's output. Session-scoped like KILL_SHELL
  // above, and it never throws for an id nothing owns: the reason code is the
  // answer, because the renderer must be able to say "we cannot read this" rather
  // than render an empty terminal that claims the command printed nothing.
  server.handle(
    RPC_CHANNELS.sessions.READ_TASK_OUTPUT,
    async (ctx, sessionId: string, taskId: string, cursor?: number) => {
      return sessionManager.readBackgroundTaskOutput(sessionId, taskId, cursor, ctxWorkspace(ctx))
    },
  )

  // Get background task output
  server.handle(RPC_CHANNELS.tasks.GET_OUTPUT, async (_ctx, taskId: string) => {
    try {
      const output = await sessionManager.getTaskOutput(taskId)
      return output
    } catch (err) {
      log.error('Failed to get task output:', err)
      throw err
    }
  })

  // Respond to a permission request (bash command approval)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, async (
    ctx,
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('@nessy-agent/shared/protocol').PermissionResponseOptions,
  ) => {
    return sessionManager.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options, ctxWorkspace(ctx))
  })

  // P6: revoke one approved session filesystem root receipt (server-owned).
  server.handle(RPC_CHANNELS.sessions.REVOKE_FILESYSTEM_ROOT, async (
    ctx,
    sessionId: string,
    receiptId: string,
  ) => {
    return sessionManager.revokeFilesystemRoot(sessionId, receiptId, ctxWorkspace(ctx))
  })

  // Respond to a credential request (secure auth input)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, async (ctx, sessionId: string, requestId: string, response: import('@nessy-agent/shared/protocol').CredentialResponse) => {
    return sessionManager.respondToCredential(sessionId, requestId, response, ctxWorkspace(ctx))
  })

  // ==========================================================================
  // Consolidated Command Handlers
  // ==========================================================================

  // Session commands - consolidated handler for session operations
  server.handle(RPC_CHANNELS.sessions.COMMAND, async (
    ctx,
    sessionId: string,
    command: import('@nessy-agent/shared/protocol').SessionCommand
  ) => {
    // Composite identity: bare sessionId + the caller's envelope workspace.
    const workspaceId = ctxWorkspace(ctx)
    switch (command.type) {
      case 'flag':
        return sessionManager.flagSession(sessionId, workspaceId)
      case 'unflag':
        return sessionManager.unflagSession(sessionId, workspaceId)
      case 'archive':
        return sessionManager.archiveSession(sessionId, workspaceId)
      case 'unarchive':
        return sessionManager.unarchiveSession(sessionId, workspaceId)
      case 'rename':
        return sessionManager.renameSession(sessionId, command.name, workspaceId)
      case 'setSessionStatus':
        return sessionManager.setSessionStatus(sessionId, command.state, workspaceId)
      case 'markRead':
        return sessionManager.markSessionRead(sessionId, workspaceId)
      case 'markUnread':
        return sessionManager.markSessionUnread(sessionId, workspaceId)
      case 'setActiveViewing':
        // Track which session user is actively viewing (for unread state machine)
        return sessionManager.setActiveViewingSession(sessionId, command.workspaceId)
      case 'setPermissionMode': {
        // F1.800: the wire string is alias-resolved FIRST (`ask` → `default`, the shared table) so the F8 ceiling judges
        // the real mode, and a string naming no mode is refused, not stored raw (codex then failed every turn). F8: a
        // remote client may not raise a session above the ceiling — enforced HERE, not by a picker (clients are replaceable).
        const mode = typeof command.mode === 'string' ? parsePermissionMode(command.mode) : null
        if (!mode) throw new Error(`Invalid permission mode: ${String(command.mode)}. Valid values: ${PERMISSION_MODE_ORDER.join(', ')}`)
        if (!isPermissionModeAllowedForRemoteClient(mode) && !isLocalClient(server, ctx.clientId)) {
          const error = new Error(`Permission mode "${mode}" cannot be set from a remote device. ` +
            `The highest a remote client may set is "${REMOTE_CLIENT_PERMISSION_MODE_CEILING}".`)
          ;(error as any).code = 'CAPABILITY_UNAVAILABLE'
          throw error
        }
        return sessionManager.setSessionPermissionMode(sessionId, mode, workspaceId)
      }
      case 'setThinkingLevel':
        // Validate thinking level before passing to session manager
        if (!isValidThinkingLevel(command.level)) {
          throw new Error(`Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
        }
        return sessionManager.setSessionThinkingLevel(sessionId, command.level, workspaceId)
      // QK5 — the ultracode toggle. Its own command rather than a seventh
      // effort level, because `model-config.md#adjust-effort-level` says
      // "Ultracode is a Claude Code setting rather than a model effort level"
      // and three recorded decisions in this fork say the same. No validation
      // arm beside `setThinkingLevel`'s: the payload is a boolean, and what the
      // session's runtime and model can actually do with it is answered by
      // `resolveUltracodeAvailability` inside the manager rather than guessed at
      // this seam.
      case 'setUltracode':
        return sessionManager.setSessionUltracode(sessionId, command.enabled, workspaceId)
      case 'updateWorkingDirectory':
        return await sessionManager.updateWorkingDirectory(sessionId, command.dir, workspaceId)
      case 'setSources':
        return sessionManager.setSessionSources(sessionId, command.sourceSlugs, workspaceId)
      case 'setLabels':
        return sessionManager.setSessionLabels(sessionId, command.labels, workspaceId)
      case 'shareToViewer':
        return sessionManager.shareToViewer(sessionId, workspaceId)
      case 'updateShare':
        return sessionManager.updateShare(sessionId, workspaceId)
      case 'revokeShare':
        return sessionManager.revokeShare(sessionId, workspaceId)
      case 'revertFileCheckpoint':
        return sessionManager.revertFileCheckpoint(sessionId, command.checkpointId, workspaceId)
      case 'refreshTitle':
        log.info(`IPC: refreshTitle received for session ${sessionId}`)
        return sessionManager.refreshTitle(sessionId, workspaceId)
      // Connection selection. Both routes reach the same operation; only
      // `switchRuntime` returns the `RuntimeSwitchResult` the picker reads.
      case 'setConnection':
        log.info(`IPC: setConnection received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.setSessionConnection(sessionId, command.connectionSlug, workspaceId)
      case 'switchRuntime':
        log.info(`IPC: switchRuntime received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.switchSessionRuntime(sessionId, command.connectionSlug, workspaceId)
      // Read-only sibling of the above: the confirmation modal asks this first
      // so it can name what will cross. Not logged at info — it fires on every
      // pick that opens the dialog, including the ones the user cancels.
      case 'previewRuntimeSwitch':
        return sessionManager.previewRuntimeSwitch(sessionId, command.connectionSlug, workspaceId)
      // Pending plan execution (Accept & Compact flow)
      case 'setPendingPlanExecution':
        return sessionManager.setPendingPlanExecution(sessionId, command.planHandleId, command.draftInputSnapshot, workspaceId)
      case 'markCompactionComplete':
        return sessionManager.markCompactionComplete(sessionId, workspaceId)
      case 'markPendingPlanExecutionDispatched':
        return sessionManager.markPendingPlanExecutionDispatched(sessionId, workspaceId)
      case 'clearPendingPlanExecution':
        return sessionManager.clearPendingPlanExecution(sessionId, workspaceId)
      case 'addAnnotation':
        return sessionManager.addMessageAnnotation(sessionId, command.messageId, command.annotation, workspaceId)
      case 'removeAnnotation':
        return sessionManager.removeMessageAnnotation(sessionId, command.messageId, command.annotationId, workspaceId)
      case 'updateAnnotation':
        return sessionManager.updateMessageAnnotation(sessionId, command.messageId, command.annotationId, command.patch, workspaceId)
      case 'appendMemory':
        return appendMemoryForSession(sessionManager, sessionId, command.scope, command.text, workspaceId)
      case 'runShellCommand':
        return sessionManager.runShellCommand(sessionId, command.command, workspaceId)
      case 'rewindToMessage':
        return sessionManager.rewindToMessage(sessionId, command.messageId, { restoreFiles: command.restoreFiles }, workspaceId)
      // P6.103 — the read the rewind menu makes BEFORE it draws its buttons.
      case 'rewindTrackedChanges':
        return sessionManager.listRewindTrackedChanges(sessionId, workspaceId)
      case 'exportTranscript':
        return sessionManager.exportSessionTranscript(sessionId, command.format, workspaceId)
      // P6.278 — the working-tree patch for the diff VIEWER. Same producer the
      // seam's `/diff` summary uses (`computeReviewDiffWithGit` with
      // `mode: 'uncommitted'`, the isolated reviewer's own working-tree half),
      // and the same parser cuts it per file, so the two surfaces cannot
      // describe different trees.
      case 'workingTreeDiff':
        return readWorkingTreeDiff(sessionManager.getWorkingDirectory(sessionId, workspaceId))
      case 'refreshContextUsage':
        return sessionManager.refreshContextUsage(sessionId, workspaceId)
      // `/btw` and `/recap` are answered out-of-band: they deliberately do NOT
      // ride the sendMessage ack/persist path and emit NO transcript events —
      // the whole point (interactive-mode.md:365) is that they never enter the
      // conversation history.
      case 'sideQuestion':
        return sessionManager.askSideQuestion(sessionId, command.question, workspaceId)
      case 'recap':
        return sessionManager.generateSessionRecap(sessionId, workspaceId)
      // `/heapdump` (troubleshooting.md:39) — unlike the two above it DOES
      // persist one summary message; it still never becomes a model turn.
      // P6.793 — the trigger for the SDK's own `Query.backgroundTasks`. A
      // session command rather than a new channel, for the reason
      // `workingTreeDiff` gives: it is a control request to the session's own
      // child and the channel already exists.
      case 'backgroundInFlightTasks':
        return sessionManager.backgroundInFlightTasks(sessionId, command.toolUseId, workspaceId)
      case 'heapdump': return sessionManager.heapdump(sessionId, workspaceId)
      case 'setKanbanColumn': return sessionManager.setKanbanColumn(sessionId, command.column, workspaceId); case 'setProjectId': return sessionManager.setSessionProjectId(sessionId, command.projectId, workspaceId) // UA2.1, UA5.3 (v0.13.4); on one line, so no cited line below moves
      default: {
        const _exhaustive: never = command
        throw new Error(`Unknown session command: ${JSON.stringify(command)}`)
      }
    }
  })

  // Get pending plan execution state (for reload recovery)
/**
 * P6.278 — the working-tree patch, cut per file, for the diff viewer.
 *
 * `success: false` is git declining to answer (no working directory, not a
 * repository, git unavailable) and is deliberately NOT the same value as a
 * clean tree: the viewer must be able to say "nothing has changed" without
 * saying it about a directory it could not read. That is the same absent-versus-
 * empty distinction `formatWorkingTreeDiffReport` draws for the seam's summary,
 * and both are fed by the same producer so they cannot disagree about a tree.
 */
async function readWorkingTreeDiff(cwd: string | undefined | null): Promise<WorkingTreeDiffResult> {
  if (!cwd) return { success: false, files: [], error: 'no-working-directory' }
  try {
    const patch = await computeReviewDiffWithGit({ mode: 'uncommitted' }, cwd)
    return { success: true, files: [...splitUnifiedDiffByFile(patch ?? '')] }
  } catch (error) {
    return {
      success: false,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

  server.handle(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, async (
    ctx,
    sessionId: string
  ) => {
    return sessionManager.getPendingPlanExecution(sessionId, ctxWorkspace(ctx))
  })

  // Get authoritative permission mode diagnostics for renderer reconciliation
  server.handle(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, async (
    ctx,
    sessionId: string
  ) => {
    return sessionManager.getSessionPermissionModeState(sessionId, ctxWorkspace(ctx))
  })

  /**
   * P6.411 — the read path for what this session withheld.
   *
   * `getSessionCapabilityInventory` is synchronous and returns an empty array
   * for an unknown session, so there is nothing to guard here: the honest
   * answer for a session that has not resolved a turn yet, and for one that
   * does not exist, is the same empty list. The reasons are VALUES
   * (`disabled` / `review-required` / `blocked` / `unsupported-runtime`), so
   * the surface owns the wording and the locale keys.
   *
   * Identical on all three runtimes by construction, not by agreement: the
   * record is written at `toAgentRuntime`, the single point Pi, claude and
   * codex converge on.
   */
  server.handle(RPC_CHANNELS.sessions.GET_CAPABILITY_INVENTORY, async (
    ctx,
    sessionId: string
  ) => {
    return sessionManager.getSessionCapabilityInventory(sessionId, ctxWorkspace(ctx))
  })

  /**
   * P6.711 — reconnect one of this session's MCP servers, on the user's word.
   *
   * Two lines on purpose. Every refusal is the POOL's, named and returned
   * (`unknown-server` / `no-config` / `in-process` / `failed`), so there is
   * nothing to translate here: re-deriving "is this server in this session"
   * would be a second answer that can disagree with the one the pool gives
   * itself while restarting.
   *
   * The workspace comes from the CONNECTION, never from the caller, exactly as
   * every other session verb here: it is what confines the reconnect to a
   * session this client may address.
   */
  server.handle(RPC_CHANNELS.sessions.RECONNECT_MCP_SERVER, async (
    ctx,
    sessionId: string,
    slug: string
  ) => {
    return sessionManager.reconnectMcpServer(sessionId, slug, ctxWorkspace(ctx))
  })

  /**
   * P6.750 — the live MCP inventory for one session.
   *
   * A pure pass-through for the same reason the reconnect above is: the manager
   * asks the runtime that owns the session, and re-deriving anything here would
   * be a second answer that can disagree with the one `/mcp` prints. The
   * workspace comes from the CONNECTION, never from the caller, which is what
   * confines the read to a session this client may address.
   */
  server.handle(RPC_CHANNELS.sessions.GET_MCP_SERVER_STATUSES, async (
    ctx,
    sessionId: string
  ) => {
    return sessionManager.mcpServerStatuses(sessionId, ctxWorkspace(ctx))
  })

  /**
   * P6.318 — keep this run.
   *
   * Every refusal is the MANAGER's and every refusal THROWS, by design: the two
   * runtimes that cannot dispatch a recipe, a host with workflows turned off,
   * and a project scope with no trusted directory each name themselves in the
   * message the renderer shows. Re-deriving any of those here would be a second
   * answer that can disagree with the one the resolver and
   * `BaseAgent.canDispatchWorkflowCommands` already share.
   *
   * The scope is validated because it selects a WRITE LOCATION: an unrecognised
   * value must not silently fall through to the project branch, which is the
   * one that touches a repository.
   */
  server.handle(RPC_CHANNELS.sessions.SAVE_WORKFLOW_RECIPE, async (
    ctx,
    sessionId: string,
    source: string,
    scope: unknown,
  ) => {
    if (scope !== 'project' && scope !== 'personal') {
      throw new TypeError('Invalid workflow save scope')
    }
    return sessionManager.saveSessionWorkflowRecipe(sessionId, source, scope, ctxWorkspace(ctx))
  })

  // ============================================================
  // Session Content Search
  // ============================================================

  // Search session content using ripgrep
  server.handle(RPC_CHANNELS.sessions.SEARCH_CONTENT, async (_ctx, workspaceId: string, query: string, searchId?: string) => {
    const id = searchId || Date.now().toString(36)
    log.info('[search]','ipc:request', { searchId: id, query })

    try {
      getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    } catch {
      log.warn('SEARCH_SESSIONS: Workspace not found:', workspaceId)
      return []
    }

    const { searchSessions } = await import('@nessy-agent/server-core/services')
    const { getWorkspaceSessionRootPath } = await import('@nessy-agent/shared/workspaces')

    // Global v2 session storage: SESSIONS_DIR/<workspaceId> (never the workspace root path)
    const sessionsDir = getWorkspaceSessionRootPath(workspaceId)
    log.debug(`SEARCH_SESSIONS: Searching "${query}" in ${sessionsDir}`)

    const results = await searchSessions(query, sessionsDir, {
      timeout: 5000,
      maxMatchesPerSession: 3,
      maxSessions: 50,
      searchId: id,
    })

    // Filter out hidden sessions (e.g., mini edit sessions)
    const allSessions = await sessionManager.getSessions()
    const hiddenSessionIds = new Set(
      allSessions.filter(s => s.hidden).map(s => s.id)
    )
    const filteredResults = results.filter(r => !hiddenSessionIds.has(r.sessionId))

    log.info('[search]','ipc:response', { searchId: id, resultCount: filteredResults.length, totalFound: results.length })
    return filteredResults
  })

  // ============================================================
  // Session Info Panel (files, notes, file watching)
  // ============================================================

  // List managed session files as backend-issued handles; absolute paths stay server-side.
  server.handle(RPC_CHANNELS.sessions.GET_FILES, async (ctx, ref: SessionKey | string) => {
    const session = sessionKeyFor(ctx, ref)
    const sessionPath = sessionManager.getSessionPath(session.sessionId, session.workspaceId)
    if (!sessionPath) return []

    try {
      return sessionFileHandles.list(ctx.clientId, session, sessionPath)
    } catch (error) {
      log.error('Failed to get session files:', error)
      return []
    }
  })

  server.handle(RPC_CHANNELS.sessions.OPEN_FILE, async (
    ctx,
    input: { session: SessionKey; handleId: string },
  ) => {
    const session = sessionKeyFor(ctx, input.session)
    const absolutePath = sessionFileHandles.resolve(ctx.clientId, session, input.handleId)
    await platform.openPath?.(absolutePath)
  })

  server.handle(RPC_CHANNELS.sessions.PREVIEW_FILE, async (
    ctx,
    input: { session: SessionKey; handleId: string },
  ) => {
    const session = sessionKeyFor(ctx, input.session)
    return sessionFileHandles.preview(ctx.clientId, session, input.handleId)
  })

  server.handle(RPC_CHANNELS.sessions.OPEN_ATTACHMENT, async (
    ctx,
    input: { session: SessionKey; handleId: string },
  ) => {
    const session = sessionKeyFor(ctx, input.session)
    const absolutePath = await sessionManager.getSessionAttachmentPath(
      session.sessionId,
      input.handleId,
      session.workspaceId,
    )
    await platform.openPath?.(absolutePath)
  })

  server.handle(RPC_CHANNELS.sessions.REVEAL_STORAGE, async (ctx, ref: SessionKey) => {
    const session = sessionKeyFor(ctx, ref)
    const sessionPath = sessionManager.getSessionPath(session.sessionId, session.workspaceId)
    if (!sessionPath) throw new Error('session-not-found')
    platform.showItemInFolder?.(sessionPath)
  })

  server.handle(RPC_CHANNELS.sessions.COPY_STORAGE_PATH, async (ctx, ref: SessionKey) => {
    const session = sessionKeyFor(ctx, ref)
    const sessionPath = sessionManager.getSessionPath(session.sessionId, session.workspaceId)
    if (!sessionPath) throw new Error('session-not-found')
    platform.writeClipboardText?.(sessionPath)
  })

  server.handle(RPC_CHANNELS.sessions.OPEN_ARTIFACT, async (
    ctx,
    input: {
      session: SessionKey
      kind: 'memory' | 'plans' | 'attachments' | 'data' | 'downloads'
    },
  ) => {
    const session = sessionKeyFor(ctx, input.session)
    const sessionPath = sessionManager.getSessionPath(session.sessionId, session.workspaceId)
    if (!sessionPath) throw new Error('session-not-found')
    const artifactPath = input.kind === 'memory'
      ? resolveContainedPath(sessionPath, 'data', 'MEMORY.md')
      : resolveContainedPath(sessionPath, input.kind)
    await platform.openPath?.(artifactPath)
  })

  // Start watching a session directory for file changes (per client)
  server.handle(RPC_CHANNELS.sessions.WATCH_FILES, async (ctx, sessionId: string) => {
    const clientId = ctx.clientId
    cleanupSessionFileWatchForClient(clientId)

    const sessionPath = sessionManager.getSessionPath(sessionId, ctxWorkspace(ctx))
    if (!sessionPath) return

    try {
      const { watch } = await import('fs')

      const state: ClientSessionWatchState = {
        watcher: null as unknown as import('fs').FSWatcher,
        sessionId,
        debounceTimer: null,
      }

      state.watcher = watch(sessionPath, { recursive: true }, (_eventType, filename) => {
        // Ignore internal files and hidden files
        if (filename && (filename.includes('session.jsonl') || filename.startsWith('.'))) {
          return
        }

        // Debounce: wait 100ms before notifying to batch rapid changes
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }

        state.debounceTimer = setTimeout(() => {
          pushTyped(server, RPC_CHANNELS.sessions.FILES_CHANGED, { to: 'client', clientId }, state.sessionId)
        }, 100)
      })

      clientSessionWatches.set(clientId, state)
    } catch (error) {
      log.error('Failed to start session file watcher:', error)
    }
  })

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId)
  })

  // Get session notes (reads notes.md from session directory)
  server.handle(RPC_CHANNELS.sessions.GET_NOTES, async (ctx, sessionId: string) => {
    const sessionPath = sessionManager.getSessionPath(sessionId, ctxWorkspace(ctx))
    if (!sessionPath) return ''

    try {
      const notesPath = join(sessionPath, 'notes.md')
      const content = await readFile(notesPath, 'utf-8')
      return content
    } catch {
      // File doesn't exist yet - return empty string
      return ''
    }
  })

  // Set session notes (writes to notes.md in session directory)
  server.handle(RPC_CHANNELS.sessions.SET_NOTES, async (ctx, sessionId: string, content: string) => {
    const sessionPath = sessionManager.getSessionPath(sessionId, ctxWorkspace(ctx))
    if (!sessionPath) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    try {
      const notesPath = join(sessionPath, 'notes.md')
      await writeFile(notesPath, content, 'utf-8')
    } catch (error) {
      log.error('Failed to save session notes:', error)
      throw error
    }
  })

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(RPC_CHANNELS.sessions.EXPORT, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctxWorkspace(ctx)
    if (!workspaceId) throw new Error('No workspace context')

    const bundle = await sessionManager.exportSession(sessionId, workspaceId)
    if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
    return bundle
  })

  // Import a session bundle into a target workspace
  // targetWorkspaceId is passed explicitly (not from context) so the renderer
  // can import into any workspace the server manages, not just the active one.
  const importHandler = async (_ctx: any, targetWorkspaceId: string, bundle: unknown, mode: string) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    if (mode !== 'move' && mode !== 'fork') throw new Error(`Invalid dispatch mode: ${mode}`)

    return sessionManager.importSession(targetWorkspaceId, bundle as import('@nessy-agent/shared/sessions').SessionBundle, mode)
  }
  server.handle(RPC_CHANNELS.sessions.IMPORT, importHandler)
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler)

  // Export a session as a summarized remote-transfer payload.
  server.handle(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctxWorkspace(ctx)
    if (!workspaceId) throw new Error('No workspace context')

    const payload = await sessionManager.exportRemoteSessionTransfer(sessionId, workspaceId)
    if (!payload) throw new Error(`Failed to export remote transfer for session ${sessionId}`)
    return payload
  })

  // Import a summarized remote-transfer payload into a target workspace.
  server.handle(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, async (_ctx, targetWorkspaceId: string, payload: import('@nessy-agent/shared/protocol').RemoteSessionTransferPayload) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    return sessionManager.importRemoteSessionTransfer(targetWorkspaceId, payload)
  })
}

/**
 * P3.19 · F1.994 — end, on the calling client's event stream, a turn that
 * failed AFTER its user message was persisted. The caller was already
 * answered at `SessionManager.sendMessage`'s `onAck`, so the failure cannot
 * reach it as a rejection any more.
 *
 * Two handlers answer at that ack and share this: `sessions:sendMessage`'s
 * post-persist arm (above) and `capabilities:submitManagedEdit`
 * (`capabilities.ts` symbol `untilTurnDispatched`, the Add Source / Add Skill
 * popover). Until F1.994 the second one only logged, so the popover's inline
 * session never heard that its turn had ended and kept spinning.
 *
 * The report is addressed to ONE client, so it cannot go through
 * `sendTurnEndEvent`, which broadcasts to the workspace. It takes the door's
 * flush half explicitly instead, and a failing flush does not swallow the error
 * report it precedes. The P3.21 bench
 * (`__tests__/conformance/turn-end-conformance.test.ts`, `DECLARED`) names this
 * file as the channel's one writer outside `SessionManager`, which is why the
 * helper lives here and not in a module of its own.
 */
export async function reportPostPersistTurnFailure(
  server: RpcServer,
  sessionManager: Pick<HandlerDeps['sessionManager'], 'flushBeforeTurnEndEvent'>,
  log: Pick<HandlerDeps['platform']['logger'], 'warn'> | undefined,
  target: { clientId: string; sessionId: string; workspaceId: string },
  err: unknown,
): Promise<void> {
  const { clientId, sessionId, workspaceId } = target
  try {
    await sessionManager.flushBeforeTurnEndEvent(sessionId, workspaceId)
  } catch (flushError) {
    log?.warn('Delta flush before the post-persist complete failed:', flushError)
  }
  pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId }, {
    type: 'error',
    sessionId,
    error: err instanceof Error ? err.message : 'Unknown error'
  } as SessionEvent)
  pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId }, {
    type: 'complete',
    sessionId
  } as SessionEvent)
}

/**
 * F1.1000 — the `sessions.CREATE` twin of F1.800's `setPermissionMode` parse. The wire string goes through
 * `parsePermissionMode`, the same table every other mode reader uses, so `ask` is stored as `default`. A string that
 * names no mode is refused with the same message, and no session is created. Before this, the raw spelling became the
 * session's mode. Codex then failed every turn on `ask` or on junk. Also, `execute` and `allow-all` name
 * `bypassPermissions` but were NOT compared as it by `createSession`'s two create-time checks that use canonical
 * names: the managed `disabledPermissionModes` ladder and the root/sudo refusal.
 *
 * Deliberately NOT here: the F8 remote ceiling. `apps/cli` classifies as remote (no `client:showItemInFolder`), and
 * its documented `--dangerously-skip-permissions` creates sessions through this door. The carve-out is recorded in
 * `docs/architecture/transport-locality.md`. Closing it is a product posture for the owner (F1.1000), and
 * `create-permission-mode-door.test.ts` pins the residue.
 */
function resolveWireCreatePermissionMode<T extends { permissionMode?: unknown } | null | undefined>(options: T): T {
  const raw = options?.permissionMode
  if (raw === undefined || raw === null) return options
  const mode = typeof raw === 'string' ? parsePermissionMode(raw) : null
  if (!mode) throw new Error(`Invalid permission mode: ${String(raw)}. Valid values: ${PERMISSION_MODE_ORDER.join(', ')}`)
  return { ...options, permissionMode: mode }
}
