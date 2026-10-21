import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  RPC_CHANNELS,
  type SafeAutomationAction,
  type SafeAutomationMatcher,
  type SafeAutomationMutationResult,
  type SafeAutomationsConfig,
  type SafeAutomationHistoryEntry,
  type TestAutomationAction,
} from '@nessy-agent/shared/protocol'
import {
  appendAutomationHistoryEntry,
  createAutomationEntry,
  deleteAutomationEntry,
  duplicateAutomationEntry,
  listAutomationEntries,
  setAutomationEntryEnabled,
  updateAutomationEntry,
  type AutomationCreateInput,
  type AutomationManagementResult,
  type AutomationUpdateInput,
} from '@nessy-agent/shared/automations'
import { AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER, AUTOMATION_LOOP_GUARD_SKIPS } from '@nessy-agent/shared/automations/constants'
import { redactUrl } from '@nessy-agent/shared/automations/webhook-utils'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrThrow } from '../utils'

// History file name — matches AUTOMATIONS_HISTORY_FILE from @nessy-agent/shared/automations/constants
const HISTORY_FILE = 'automations-history.jsonl'
function getWorkspaceRoot(deps: HandlerDeps, workspaceId: string): string {
  return getWorkspaceOrThrow(deps.workspaceService, workspaceId).workspaceRootPath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeWebhookUrl(url: string): string {
  try {
    new URL(url)
    return redactUrl(url)
  } catch {
    return '[redacted]'
  }
}

function serializeAutomationHistoryEntry(value: unknown, automationId: string): SafeAutomationHistoryEntry | null {
  if (!isRecord(value)
    || value.id !== automationId
    || typeof value.ts !== 'number'
    || typeof value.ok !== 'boolean') {
    return null
  }

  // UB12.20 — which loop-guard arm skipped the run, passed only when it is a code
  // the renderer has a key for; anything else leaves the stored English `skipped`.
  const skippedLoopGuard = AUTOMATION_LOOP_GUARD_SKIPS.find(code => code === value.skippedLoopGuard)
  const entry: SafeAutomationHistoryEntry = {
    id: automationId,
    ts: value.ts,
    ok: value.ok,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(!value.ok ? { error: scriptHistoryRefusal(value) ?? 'Automation failed' } : {}), ...scriptHistoryFields(value), // UA8.3
    // UB4.8 — the loop guard's skip reason (a `skipped` row is ok:true with no session).
    ...(typeof value.skipped === 'string' ? { skipped: value.skipped } : {}),
    // UB6.9 — the semantic-condition skip's "yes" probability, structured so the
    // renderer can localise the reason instead of parsing `skipped`.
    ...(typeof value.skippedProbability === 'number' ? { skippedProbability: value.skippedProbability } : {}),
    ...(skippedLoopGuard ? { skippedLoopGuard } : {}),
  }
  const webhook = value.webhook
  if (isRecord(webhook)
    && typeof webhook.method === 'string'
    && typeof webhook.url === 'string'
    && typeof webhook.statusCode === 'number'
    && typeof webhook.durationMs === 'number') {
    entry.webhook = {
      method: webhook.method,
      url: safeWebhookUrl(webhook.url),
      statusCode: webhook.statusCode,
      durationMs: webhook.durationMs,
      ...(typeof webhook.attempts === 'number' ? { attempts: webhook.attempts } : {}),
      // UB4.27 — the failure reason and response body reach the timeline again;
      // both were capped at HISTORY_FIELD_MAX_LENGTH when the host wrote them.
      ...(typeof webhook.error === 'string' ? { error: webhook.error } : {}),
      ...(typeof webhook.responseBody === 'string' ? { responseBody: webhook.responseBody } : {}),
    }
  }
  return entry
}

function serializeAutomationAction(action: unknown): SafeAutomationAction | null {
  if (!isRecord(action)) return null
  if (action.type === 'prompt' && typeof action.prompt === 'string') {
    return {
      type: 'prompt',
      prompt: action.prompt,
      ...(typeof action.llmConnection === 'string' ? { llmConnection: action.llmConnection } : {}),
      ...(typeof action.model === 'string' ? { model: action.model } : {}),
      ...(typeof action.thinkingLevel === 'string'
        ? { thinkingLevel: action.thinkingLevel as Extract<SafeAutomationAction, { type: 'prompt' }>['thinkingLevel'] }
        : {}),
      ...(typeof action.ephemeral === 'boolean' ? { ephemeral: action.ephemeral } : {}),
    }
  }
  if (action.type === 'webhook' && typeof action.url === 'string') {
    return {
      type: 'webhook',
      url: safeWebhookUrl(action.url),
      ...(typeof action.method === 'string' ? { method: action.method } : {}),
      ...(action.bodyFormat === 'json' || action.bodyFormat === 'form' || action.bodyFormat === 'raw'
        ? { bodyFormat: action.bodyFormat }
        : {}),
      ...(typeof action.captureResponse === 'boolean' ? { captureResponse: action.captureResponse } : {}),
    }
  }
  return serializeScriptAction(action) // UA8.3 — null for anything else, as before
}

function serializeAutomationsForRenderer(config: unknown): SafeAutomationsConfig {
  const record = isRecord(config) ? config : {}
  const source = isRecord(record.automations) ? record.automations : {}
  const automations: Record<string, SafeAutomationMatcher[]> = {}

  for (const [event, matchers] of Object.entries(source)) {
    automations[event] = Array.isArray(matchers)
      ? matchers.flatMap((matcher) => {
        if (!isRecord(matcher)) return []
        const actions = Array.isArray(matcher.actions)
          ? matcher.actions.map(serializeAutomationAction).filter((action): action is SafeAutomationAction => action !== null)
          : []
        return [{
          ...(typeof matcher.id === 'string' ? { id: matcher.id } : {}),
          ...(typeof matcher.name === 'string' ? { name: matcher.name } : {}),
          ...(typeof matcher.matcher === 'string' ? { matcher: matcher.matcher } : {}),
          ...(typeof matcher.cron === 'string' ? { cron: matcher.cron } : {}),
          ...(typeof matcher.timezone === 'string' ? { timezone: matcher.timezone } : {}),
          ...(typeof matcher.permissionMode === 'string' ? { permissionMode: matcher.permissionMode as SafeAutomationMatcher['permissionMode'] } : {}),
          ...(Array.isArray(matcher.labels) ? { labels: matcher.labels.filter((label): label is string => typeof label === 'string') } : {}),
          ...(Array.isArray(matcher.conditions) ? { conditions: matcher.conditions } : {}),
          ...(typeof matcher.enabled === 'boolean' ? { enabled: matcher.enabled } : {}),
          actions,
        }]
      })
      : []
  }

  return {
    ...(typeof record.version === 'number' ? { version: record.version } : {}),
    automations,
  }
}

function serializeAutomationMutation(result: AutomationManagementResult): SafeAutomationMutationResult {
  return {
    automationId: result.automationId,
    event: result.event,
    matcherIndex: result.matcherIndex,
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.TEST,
  RPC_CHANNELS.automations.CREATE,
  RPC_CHANNELS.automations.UPDATE,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.REPLAY, RPC_CHANNELS.automations.APPROVE_SCRIPT, // UA8.3
] as const

export function registerAutomationsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // Get automations config for a workspace (read-only, resolves path server-side)
  server.handle(RPC_CHANNELS.automations.GET, async (_ctx, workspaceId: string) => {
    log.info(`AUTOMATIONS_GET: Loading automations for workspace: ${workspaceId}`)
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    try {
      const { resolveAutomationsConfigPath } = await import('@nessy-agent/shared/automations/resolve-config-path')
      const configPath = resolveAutomationsConfigPath(workspace.workspaceRootPath)
      log.info(`AUTOMATIONS_GET: Reading config from: ${configPath}`)
      if (!existsSync(configPath)) {
        log.info(`AUTOMATIONS_GET: No automations.json found for workspace ${workspaceId}`)
        return null
      }
      await listAutomationEntries(workspace.workspaceRootPath)
      const content = await readFile(configPath, 'utf-8')
      const parsed = JSON.parse(content)
      const eventCount = parsed?.automations ? Object.keys(parsed.automations).length : 0
      log.info(`AUTOMATIONS_GET: Loaded ${eventCount} event type(s) from ${configPath}`)
      return withManagedLocalAutomationFlag(await withScriptApprovals(serializeAutomationsForRenderer(parsed), workspace.workspaceRootPath)) // UA8.3; F1.795
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info(`AUTOMATIONS_GET: No automations.json found for workspace ${workspaceId}`)
        return null // No automations configured yet
      }
      log.error(`AUTOMATIONS_GET: Error loading automations:`, error)
      throw error
    }
  })

  server.handle(RPC_CHANNELS.automations.TEST, async (_ctx, payload: import('@nessy-agent/shared/protocol').TestAutomationPayload) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, payload.workspaceId)
    let actions: TestAutomationAction[] = payload.actions
    // desktop-scheduled-tasks.md:34 makes worktree isolation a property of the
    // TASK, so "Run now" has to honour it too. Read from the saved matcher
    // rather than the payload: the flag is not on the wire DTO, and taking it
    // from a client would let a caller opt a task out of the isolation its
    // owner configured.
    let worktree: boolean | undefined
    if (payload.automationId) {
      const saved = (await listAutomationEntries(workspace.workspaceRootPath))
        .find((entry) => entry.automationId === payload.automationId)
      if (!saved || !Array.isArray(saved.automation.actions)) {
        throw new Error('Automation not found')
      }
      actions = saved.automation.actions
        .filter((action) => action.type === 'prompt' || action.type === 'webhook' || action.type === 'script') as TestAutomationAction[] // UA8.1: a saved script action runs through testScriptAction
      if (typeof saved.automation.worktree === 'boolean') worktree = saved.automation.worktree
    }

    const results: import('@nessy-agent/shared/protocol').TestAutomationActionResult[] = []
    const { parsePromptReferences } = await import('@nessy-agent/shared/automations')
    const { executeWebhookRequest, createWebhookHistoryEntry, createPromptHistoryEntry } = await import('@nessy-agent/shared/automations/webhook-utils')

    for (const action of actions) { if ((action as { type: string }).type === 'script') { results.push(await testScriptAction(payload, workspace.workspaceRootPath, action as unknown as ScriptAction, log)); continue }
      const start = Date.now()

      if (action.type === 'webhook') {
        // Execute webhook action using shared utility (no env expansion for test — raw URLs)
        // Cast needed: protocol DTO uses loose `method?: string`, WebhookAction uses strict union
        const result = await executeWebhookRequest(action as import('@nessy-agent/shared/automations').WebhookAction)
        const method = action.method ?? 'POST'

        results.push({
          type: 'webhook',
          success: result.success,
          url: redactUrl(result.url),
          statusCode: result.statusCode,
          ...(!result.success ? {
            error: result.statusCode > 0 ? `HTTP ${result.statusCode}` : 'Webhook request failed',
          } : {}),
          duration: Date.now() - start,
        })

        if (payload.automationId) {
          const entry = createWebhookHistoryEntry({
            matcherId: payload.automationId,
            ok: result.success,
            method,
            url: action.url as string,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            error: result.error,
            responseBody: result.responseBody,
          })
          try {
            await appendAutomationHistoryEntry(workspace.workspaceRootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
        continue
      }

      // Prompt action
      // Parse @mentions from the prompt to resolve source/skill references
      const references = parsePromptReferences(action.prompt)

      try {
        const { sessionId } = await deps.sessionManager.executePromptAutomation({
          workspaceId: payload.workspaceId,
          workspaceRootPath: workspace.workspaceRootPath,
          prompt: action.prompt,
          labels: payload.labels,
          permissionMode: payload.permissionMode,
          mentions: references.mentions,
          llmConnection: action.llmConnection,
          model: action.model,
          thinkingLevel: action.thinkingLevel,
          ephemeral: action.ephemeral,
          worktree,
          automationName: payload.automationName,
          // Return once the session exists; drain the run in the background so
          // the RPC doesn't hit the transport's 30s timeout (#736/#943).
          awaitCompletion: false,
          matcherId: payload.automationId,
        })
        results.push({
          type: 'prompt',
          success: true,
          sessionId,
          duration: Date.now() - start,
        })

        // History is written by the background run in executePromptAutomation
        // (ok:true on success, ok:false on failure) so a failed run isn't recorded
        // as a completed one (#736/#943). Session creation succeeding here only
        // means the run was accepted, not finished — so no ok:true entry now.
      } catch (err: unknown) {
        results.push({
          type: 'prompt',
          success: false,
          stderr: (err as Error).message,
          duration: Date.now() - start,
        })

        // Write failed history entry
        if (payload.automationId) {
          const entry = createPromptHistoryEntry({ matcherId: payload.automationId, ok: false, error: (err as Error).message, prompt: action.prompt })
          try {
            await appendAutomationHistoryEntry(workspace.workspaceRootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
      }
    }

    return { actions: results } satisfies import('@nessy-agent/shared/protocol').TestAutomationResult
  })

  server.handle(RPC_CHANNELS.automations.CREATE, async (_ctx, workspaceId: string, input: AutomationCreateInput) => {
    return serializeAutomationMutation(await createAutomationEntry(getWorkspaceRoot(deps, workspaceId), input))
  })

  server.handle(RPC_CHANNELS.automations.UPDATE, async (_ctx, workspaceId: string, input: AutomationUpdateInput) => {
    return serializeAutomationMutation(await updateAutomationEntry(getWorkspaceRoot(deps, workspaceId), input))
  })

  // Automation enabled state management (toggle enabled/disabled in automations.json)
  server.handle(RPC_CHANNELS.automations.SET_ENABLED, async (_ctx, workspaceId: string, automationId: string, enabled: boolean) => {
    return serializeAutomationMutation(await setAutomationEntryEnabled(getWorkspaceRoot(deps, workspaceId), automationId, enabled))
  })

  // Duplicate an automation matcher
  server.handle(RPC_CHANNELS.automations.DUPLICATE, async (_ctx, workspaceId: string, automationId: string) => {
    return serializeAutomationMutation(await duplicateAutomationEntry(getWorkspaceRoot(deps, workspaceId), automationId))
  })

  // Delete an automation matcher
  server.handle(RPC_CHANNELS.automations.DELETE, async (_ctx, workspaceId: string, automationId: string) => {
    await deleteAutomationEntry(getWorkspaceRoot(deps, workspaceId), automationId)
  })

  // Read execution history for a specific automation
  server.handle(RPC_CHANNELS.automations.GET_HISTORY, async (_ctx, workspaceId: string, automationId: string, limit = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const clampedLimit = Math.max(1, Math.min(limit, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER))
    const historyPath = join(workspace.workspaceRootPath, HISTORY_FILE)
    try {
      const content = await readFile(historyPath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)

      return lines
        .map(line => { try { return JSON.parse(line) } catch { return null } })
        .map(entry => serializeAutomationHistoryEntry(entry, automationId))
        .filter((entry): entry is SafeAutomationHistoryEntry => entry !== null)
        .slice(-clampedLimit)
        .reverse()
    } catch {
      return [] // File doesn't exist yet
    }
  })

  // Replay webhook actions for a specific automation matcher
  server.handle(RPC_CHANNELS.automations.REPLAY, async (_ctx, workspaceId: string, automationId: string, eventName: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { resolveAutomationsConfigPath } = await import('@nessy-agent/shared/automations/resolve-config-path')
    const configPath = resolveAutomationsConfigPath(workspace.workspaceRootPath)
    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as { automations?: Record<string, Array<{ id?: string; actions?: Array<{ type: string; [key: string]: unknown }> }>> }

    const matchers = config.automations?.[eventName] ?? []
    const matcher = matchers.find(m => m.id === automationId)
    if (!matcher) throw new Error('Automation not found')

    const webhookActions = (matcher.actions ?? []).filter(a => a.type === 'webhook')
    if (webhookActions.length === 0) throw new Error((matcher.actions ?? []).some(a => a.type === 'script') ? 'No webhook actions to replay — script actions re-run via "Run test"' : 'No webhook actions to replay') // UA8.1 (upstream v0.13.4)

    const { executeWebhookRequest, createWebhookHistoryEntry } = await import('@nessy-agent/shared/automations/webhook-utils')
    const results = await Promise.all(
      webhookActions.map(a => executeWebhookRequest(a as unknown as import('@nessy-agent/shared/automations').WebhookAction))
    )

    // Write history entries for replay — use index to correctly attribute method per action
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!
      const action = webhookActions[i]!
      const entry = createWebhookHistoryEntry({
        matcherId: automationId,
        ok: result.success,
        method: (action as { method?: string }).method,
        url: result.url,
        statusCode: result.statusCode,
        durationMs: result.durationMs ?? 0,
        error: result.error,
      })
      try {
        await appendAutomationHistoryEntry(workspace.workspaceRootPath, entry)
      } catch (e) {
        log.warn('[Automations] Failed to write replay history:', e)
      }
    }

    return {
      results: results.map(result => ({
        type: 'webhook' as const,
        url: safeWebhookUrl(result.url),
        statusCode: result.statusCode,
        success: result.success,
        ...(!result.success ? {
          error: result.statusCode > 0 ? `HTTP ${result.statusCode}` : 'Webhook request failed',
        } : {}),
        duration: result.durationMs ?? 0,
      })),
    }
  })

  // Return last execution timestamp for all automations
  server.handle(RPC_CHANNELS.automations.GET_LAST_EXECUTED, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const historyPath = join(workspace.workspaceRootPath, HISTORY_FILE)
    try {
      const content = await readFile(historyPath, 'utf-8')
      const result: Record<string, number> = {}
      for (const line of content.trim().split('\n')) {
        try {
          const entry = JSON.parse(line)
          if (entry.id && entry.ts) result[entry.id] = entry.ts
        } catch { /* skip malformed lines */ }
      }
      return result
    } catch {
      return {}
    }
  })

  registerScriptApprovalHandler(server, deps) // UA8.3 — below the file's cited lines
}

// ============================================================================
// UA8.1 — the Test hunk for a script action (craft-agents-oss v0.13.4 rpc/automations.ts, adapted)
// ============================================================================

/*
 * Kept below the file's highest doc-cited line (409): the handler gains three changed lines, the rest is here.
 */
import type { ScriptAction } from '@nessy-agent/shared/automations'
import { PrivilegedExecutionBroker } from '../../services/privileged-execution-broker'

/** The audit sink for Test runs: the same `logs/privileged-actions.jsonl` `SessionManager`'s broker writes. */
let testScriptAuditBroker: PrivilegedExecutionBroker | undefined

/**
 * "Run test" of a SAVED script action, through `runApprovedScript` — the one script entry — so the Test button
 * follows the same rule as the automation (spec §15 item 1): the managed policy, containment, the approval bound
 * to `{ path, sha256, args, runtime }`, the verified bytes from a private copy, the allowlisted env (a synthesized
 * SchedulerTick, as upstream: tests simulate the cron path) and the audit. A script action sent in the payload
 * without its saved automation is refused — the definition Test runs is the one on disk, never the client's.
 * Upstream's timeout clamp below the 30 s RPC timeout is kept (craft-agents-oss#943).
 */
async function testScriptAction(
  payload: import('@nessy-agent/shared/protocol').TestAutomationPayload,
  workspaceRootPath: string,
  action: ScriptAction,
  log: HandlerDeps['platform']['logger'],
): Promise<import('@nessy-agent/shared/protocol').TestScriptActionResult> {
  const start = Date.now()
  if (!payload.automationId) {
    return { type: 'script', success: false, script: action.script, exitCode: null, blocked: true, error: 'A script action is tested from its saved automation', duration: 0 }
  }
  const { runApprovedScript, createScriptHistoryEntry, buildScriptEnv } = await import('@nessy-agent/shared/automations')
  const env = buildScriptEnv(
    'SchedulerTick',
    { workspaceId: payload.workspaceId, timestamp: Date.now() },
    { workspaceRootPath, page: action.page },
  )
  testScriptAuditBroker ??= new PrivilegedExecutionBroker(log)
  const broker = testScriptAuditBroker
  const result = await runApprovedScript({
    action: {
      type: 'script',
      script: action.script,
      args: action.args,
      runtime: action.runtime,
      timeoutMs: Math.min(action.timeoutMs ?? 25_000, 25_000),
      page: action.page,
    },
    workspaceRootPath,
    env,
    trigger: 'test',
    workspaceId: payload.workspaceId,
    matcherId: payload.automationId,
    audit: (event, fields) => broker.auditEvent(event, fields),
  })

  const entry = createScriptHistoryEntry({ matcherId: payload.automationId, result })
  try {
    await appendAutomationHistoryEntry(workspaceRootPath, entry)
  } catch (e) {
    log.warn('[Automations] Failed to write history:', e)
  }

  return {
    type: 'script',
    success: result.success,
    script: result.script,
    exitCode: result.exitCode,
    ...(result.blocked ? { blocked: true } : {}),
    ...(result.stdout ? { stdout: result.stdout.slice(0, 2000) } : {}),
    ...(result.success || !result.stderr ? {} : { error: result.stderr.slice(0, 2000) }),
    duration: Date.now() - start,
  }
}

// ============================================================================
// UA8.3 — the script action on the wire: its approval state, its history, and `automations:approveScript` (ours —
// upstream v0.13.4 has no approval; spec §15 item 3)
// ============================================================================

/*
 * Kept below the file's highest doc-cited line (409) for the reason above: the serializers and the GET handler each
 * gained ONE changed line that calls into here.
 */
import { assertCallerWorkspace } from './caller-workspace'
import type { SafeAutomationHistoryEntry as HistoryEntryDto, SafeScriptAutomationAction } from '@nessy-agent/shared/protocol'

/** The refusal every new handler raises for a caller bound to another workspace (UA1.9). */
const AUTOMATIONS_WORKSPACE_MISMATCH = 'automations-workspace-mismatch'

const SCRIPT_RUNTIMES = new Set(['bun', 'node', 'python3'])

/** A saved script action as the renderer sees it (the approval state is added by {@link withScriptApprovals}). */
function serializeScriptAction(action: Record<string, unknown>): SafeScriptAutomationAction | null {
  if (action.type !== 'script' || typeof action.script !== 'string') return null
  return {
    type: 'script',
    script: action.script,
    ...(Array.isArray(action.args) ? { args: action.args.filter((arg): arg is string => typeof arg === 'string') } : {}),
    ...(typeof action.runtime === 'string' && SCRIPT_RUNTIMES.has(action.runtime)
      ? { runtime: action.runtime as SafeScriptAutomationAction['runtime'] }
      : {}),
    ...(typeof action.timeoutMs === 'number' ? { timeoutMs: action.timeoutMs } : {}),
    ...(typeof action.page === 'string' ? { page: action.page } : {}),
  }
}

/**
 * The script part of a history line (`createScriptHistoryEntry`). Its `error` is NOT forwarded in general — a
 * failed run's stderr is the script's own output — except for a run the HOST refused (`blocked`) or skipped, whose
 * text is the host's reason ({@link scriptHistoryRefusal}).
 */
function scriptHistoryFields(value: Record<string, unknown>): Pick<HistoryEntryDto, 'script'> {
  const script = value.script
  if (!isRecord(script) || typeof script.script !== 'string') return {}
  return {
    script: {
      script: script.script,
      exitCode: typeof script.exitCode === 'number' ? script.exitCode : null,
      durationMs: typeof script.durationMs === 'number' ? script.durationMs : 0,
      ...(typeof script.page === 'string' ? { page: script.page } : {}),
      ...(script.blocked === true ? { blocked: true } : {}),
      ...(script.skipped === true ? { skipped: true } : {}),
      ...(script.timedOut === true ? { timedOut: true } : {}),
    },
  }
}

/** The host's refusal reason of a blocked or skipped script run (unapproved, changed, managed policy, …), or undefined. */
function scriptHistoryRefusal(value: Record<string, unknown>): string | undefined {
  const script = value.script
  if (!isRecord(script) || (script.blocked !== true && script.skipped !== true)) return undefined
  return typeof script.error === 'string' && script.error ? script.error : undefined
}

/**
 * Add each script action's approval state (read against the MACed ledger) to the GET result. The ledger key is
 * asked only when some action is a script; a key the host cannot load leaves the state out (the row then offers no
 * approval, and the run is refused at use time anyway).
 */
async function withScriptApprovals(config: SafeAutomationsConfig, workspaceRootPath: string): Promise<SafeAutomationsConfig> {
  const scripts = Object.values(config.automations).flatMap(matchers => matchers.flatMap(matcher => matcher.actions))
    .filter((action): action is SafeScriptAutomationAction => action.type === 'script')
  if (scripts.length === 0) return config
  try {
    const { getHostApprovalsKeyProvider } = await import('@nessy-agent/shared/approvals/host-approvals')
    const { readScriptActionApproval } = await import('@nessy-agent/shared/automations')
    const key = await getHostApprovalsKeyProvider().getKey()
    for (const action of scripts) action.approval = readScriptActionApproval(workspaceRootPath, key, action)
  } catch {
    // No key: no state (module comment).
  }
  return config
}

/**
 * UA12.131 — the approval line's sink. `platform.logger` is DROPPED by a packaged build unless it is
 * launched with the debug lever (F1.767; the llm-connections handler's `credentialLog` docblock records
 * the posture), and an approval of script bytes is the one line in this handler an operator needs when
 * an approved script is later questioned — the same diagnosis-sink decision DA2.15/F1.177 made, and the
 * gate's own remedy for a line that is more than chatter. `createLogger` is gated by `NESSY_DEBUG=1` and
 * mirrors into `electron-log`, so a dev build keeps it in `main.log` as before; the MACed ledger entry
 * (the durable audit record) is unaffected. Headless nuance, stated: the headless host's `platform.logger`
 * always writes, so under headless this line is now debug-gated where it was always printed.
 */
const approvalLog = createLogger('automations-approval')

/**
 * `automations:approveScript(workspaceId, automationId, actionIndex, sha256)` — record the person's approval of a
 * SAVED script action's current bytes. The action is read from automations.json on disk, never from the client; the
 * digest is the one the row showed, so bytes that changed since are refused.
 */
function registerScriptApprovalHandler(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.automations.APPROVE_SCRIPT, async (
    ctx,
    workspaceId: string,
    automationId: string,
    actionIndex: number,
    sha256?: string,
  ) => {
    assertCallerWorkspace(ctx, deps, workspaceId, AUTOMATIONS_WORKSPACE_MISMATCH)
    const root = getWorkspaceRoot(deps, workspaceId)
    const saved = (await listAutomationEntries(root)).find(entry => entry.automationId === automationId)
    const action = saved && Array.isArray(saved.automation.actions) ? saved.automation.actions[actionIndex] : undefined
    if (!action || action.type !== 'script') throw new Error('Script action not found')
    const { getHostApprovalsKeyProvider } = await import('@nessy-agent/shared/approvals/host-approvals')
    const { approveScriptAction } = await import('@nessy-agent/shared/automations')
    const key = await getHostApprovalsKeyProvider().getKey()
    const status = approveScriptAction(root, key, action, typeof sha256 === 'string' ? sha256 : undefined)
    approvalLog.info(`Automation script approved: ${action.script} (${automationId})`)
    return status
  })
}

// UA12.131 — imports are hoisted; appended at the file's end so every docs-cited line above keeps its
// anchor (this file carries 78 `automations.ts:<line>` citations, highest 497 — the hot-file rule).
import { createLogger } from '@nessy-agent/shared/utils'

/**
 * F1.795 (origin: release sitting SIT-m F8) — automations:get says when the managed codex policy
 * (`[features] in_app_local_automation = false`, possibly restored from the F1.101 cache at startup) keeps this app's
 * local automations from running, so the Automations page can mark them instead of listing a declined schedule as
 * "Scheduled". The same predicate every entry point asks (`isLocalAutomationManagedDisabled`); absent otherwise.
 */
async function withManagedLocalAutomationFlag(config: SafeAutomationsConfig): Promise<SafeAutomationsConfig> {
  const { isLocalAutomationManagedDisabled } = await import('@nessy-agent/shared/config/managed-local-automation')
  return isLocalAutomationManagedDisabled() ? { ...config, managedLocalAutomationDisabled: true } : config
}
