import type { SessionKey } from '../../sessions/types.ts'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type {
  AuthorizedLocalToolRuntime,
  LocalToolCall,
  LocalToolExecutionResult,
} from '../local-tools/types.ts'
import { getHarnessToolDescriptor, type HarnessToolDescriptor } from './harness-tool-descriptor.ts'
import {
  boundExecutionProgress,
  boundExecutionResult,
  freezeExecutionReceipt,
  toolCallHeartbeatProgress,
  type ToolExecutionOutcome,
  type ToolExecutionProgress,
  type ToolExecutionCorrelation,
  type ToolExecutionReceipt,
} from './execution-receipt.ts'
import { ToolScheduler } from './tool-scheduler.ts'

/**
 * How long a dispatched tool call may stay SILENT before the executor emits an
 * elapsed heartbeat on its behalf. The window restarts on every progress event
 * the tool itself pushes, so a chatty tool never beats.
 *
 * Upstream parity: Claude Code ships a "periodic progress heartbeat for
 * long-running tool calls" (`w30.md:87`, recorded in
 * `docs/superpowers/specs/2026-08-22-weekly-changelog-findings-w30-w32.md`).
 * Our progress bridge was push-only (`tool-wrapper.ts` `createPiToolProgressBridge`),
 * so a tool that never calls `emitProgress` stayed silent for its whole runtime.
 *
 * This is NOT the transport keepalive — `HEARTBEAT_INTERVAL_MS`
 * (`packages/shared/src/protocol/types.ts`) and `heartbeatTimer`
 * (`packages/server-core/src/transport/server.ts`) keep a WebSocket open and
 * know nothing about tool calls. Same number, unrelated mechanism.
 */
export const TOOL_CALL_HEARTBEAT_INTERVAL_MS = 30_000

export interface ToolManifestIdentity {
  generation: string
  manifestHash: string
  responseEpoch: number
}

export interface ToolExecutionRequest {
  executionId: string
  sessionKey: SessionKey
  manifestIdentity: ToolManifestIdentity
  semanticId: string
  canonicalInput: unknown
  source: 'pi' | 'nestor-a2a'
  presentedName: string
  abortSignal: AbortSignal
}

export interface ToolExecutionAuthority {
  sessionKey: SessionKey
  manifestIdentity: ToolManifestIdentity
  getCurrentResponseEpoch(): number
}

export interface ToolPermissionDecision {
  allowed: boolean
  decisionId: string
  canonicalInput?: unknown
  reason?: string
  additionalContext?: string
}

export type ToolPermissionBridge = (
  request: ToolExecutionRequest,
  canonicalInput: Record<string, unknown>,
) => Promise<ToolPermissionDecision>

export interface ToolExecutionContext {
  request: ToolExecutionRequest
  signal: AbortSignal
  emitProgress(value: ToolExecutionProgress): void
}

export interface ToolExecutionPort {
  semanticId: string
  canonicalize(input: unknown, request: ToolExecutionRequest): Record<string, unknown>
  dispatch:
    | {
        kind: 'local'
        toLocalCall(
          input: Record<string, unknown>,
          request: ToolExecutionRequest,
          signal: AbortSignal,
        ): LocalToolCall
        mapResult?(
          result: LocalToolExecutionResult,
          input: Record<string, unknown>,
        ): Promise<LocalToolExecutionResult> | LocalToolExecutionResult
      }
    | {
        kind: 'select'
        useSemantic(input: Record<string, unknown>): boolean
        toLocalCall(
          input: Record<string, unknown>,
          request: ToolExecutionRequest,
          signal: AbortSignal,
        ): LocalToolCall
        executeSemantic(
          input: Record<string, unknown>,
          context: ToolExecutionContext,
        ): Promise<LocalToolExecutionResult>
        mapResult?(
          result: LocalToolExecutionResult,
          input: Record<string, unknown>,
        ): Promise<LocalToolExecutionResult> | LocalToolExecutionResult
      }
    | {
        kind: 'semantic'
        execute(
          input: Record<string, unknown>,
          context: ToolExecutionContext,
        ): Promise<LocalToolExecutionResult>
      }
}

export interface ToolExecutor {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionReceipt>
}

export function createToolInputValidator(
  schema: Record<string, unknown>,
  label: string,
): (input: unknown) => Record<string, unknown> {
  const validate = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(schema as never)
  return (input: unknown) => {
    const result = validate(input)
    if (!result.valid) throw new Error(`Invalid input for ${label}: ${result.errorMessage}`)
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw new Error(`Invalid input for ${label}: expected an object`)
    }
    return { ...result.data }
  }
}

export interface ToolExecutorOptions {
  runtime: AuthorizedLocalToolRuntime
  authority: ToolExecutionAuthority
  ports: readonly ToolExecutionPort[]
  permissionBridge?: ToolPermissionBridge
  beforeDispatch?: (
    request: ToolExecutionRequest,
    descriptor: HarnessToolDescriptor,
    canonicalInput: Record<string, unknown>,
  ) => Promise<ToolExecutionCorrelation | void> | ToolExecutionCorrelation | void
  afterDispatch?: (
    request: ToolExecutionRequest,
    descriptor: HarnessToolDescriptor,
    canonicalInput: Record<string, unknown>,
    outcome: { result?: LocalToolExecutionResult; error?: unknown },
  ) => Promise<ToolExecutionCorrelation | void> | ToolExecutionCorrelation | void
  transformResult?: (
    request: ToolExecutionRequest,
    canonicalInput: Record<string, unknown>,
    result: LocalToolExecutionResult,
  ) => Promise<LocalToolExecutionResult> | LocalToolExecutionResult
  scheduler?: ToolScheduler
  onReceipt?: (receipt: ToolExecutionReceipt) => void
  onProgress?: (executionId: string, value: ToolExecutionProgress) => void
  maxProgressEvents?: number
  maxResultBytes?: number
  now?: () => number
  timers?: {
    setTimeout(callback: () => void, timeoutMs: number): unknown
    clearTimeout(timer: unknown): void
  }
}

/**
 * The outer bound on any single tool result, in BYTES.
 *
 * Named and exported by P2.366, which found it as a bare `64 * 1024` inline in
 * the line below — the only one of the three 64 KiB caps on this path with no
 * name at all, while `child-session-service.ts` exports `MAX_RESULT_BYTES` and
 * `ProcessSupervisor` publishes `MAX_FOREGROUND_STREAM_BYTES`. Nobody chose that
 * asymmetry; a constant a sibling module cannot cite is a constant that drifts.
 *
 * **It is not a documented limit, and it is not the Bash output limit.**
 * `tools-reference.md#output-limits` states the Bash numbers in CHARACTERS and
 * this one counts bytes; it applies to EVERY tool result, not just Bash; and the
 * documented Bash shaping now happens upstream, in
 * `config/bash-output-limits.ts`, before a result reaches here. This is the
 * host-survival floor underneath all of that — the thing that stops one runaway
 * result from entering a receipt — and it should be read as such rather than as
 * an implementation of any published number.
 */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 64 * 1024

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  const ports = new Map<string, ToolExecutionPort>()
  for (const port of options.ports) {
    if (ports.has(port.semanticId)) throw new Error(`Duplicate tool execution port: ${port.semanticId}`)
    getHarnessToolDescriptor(port.semanticId)
    ports.set(port.semanticId, port)
  }
  const scheduler = options.scheduler ?? new ToolScheduler()
  const permissionBridge = options.permissionBridge
  const now = options.now ?? Date.now
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs),
    clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
  const maxProgressEvents = options.maxProgressEvents ?? 32
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_TOOL_RESULT_MAX_BYTES

  return Object.freeze({
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionReceipt> {
      const startedAt = now()
      let decisionId = 'not-requested'
      let additionalContext: string | undefined
      let progress: ToolExecutionProgress[] = []
      let descriptor: HarnessToolDescriptor | undefined
      let correlation: ToolExecutionCorrelation | undefined
      let finished = false
      const finish = (
        outcome: ToolExecutionOutcome,
        result: LocalToolExecutionResult,
        code?: string,
        reason?: string,
      ): ToolExecutionReceipt => {
        if (finished) throw new Error(`Tool execution completed twice: ${request.executionId}`)
        finished = true
        const duplicatesResult = reason !== undefined && (reason === result.error || reason === result.content)
        const boundedResult = boundExecutionResult(
          result,
          duplicatesResult ? Math.floor(maxResultBytes / 2) : maxResultBytes,
        )
        const boundedReason = duplicatesResult
          ? boundedResult.error ?? boundedResult.content
          : reason
        const finalCorrelation = mergeCorrelation(correlation, deriveCorrelation(request, result))
        const receipt = freezeExecutionReceipt({
          executionId: request.executionId,
          semanticId: request.semanticId,
          decisionId,
          isolationProfile: result.isolationProfile ?? 'no-host-isolation',
          ...(result.environmentProfile ? { environmentProfile: result.environmentProfile } : {}),
          ...(result.environmentDigest ? { environmentDigest: result.environmentDigest } : {}),
          manifestGeneration: request.manifestIdentity.generation,
          responseEpoch: request.manifestIdentity.responseEpoch,
          effect: descriptor?.effect ?? 'unknown',
          ...(finalCorrelation ? { correlation: finalCorrelation } : {}),
          startedAt,
          completedAt: now(),
          outcome,
          result: boundedResult,
          ...(code ? { code } : {}),
          ...(boundedReason ? { reason: boundedReason } : {}),
          ...(additionalContext ? { additionalContext } : {}),
          ...(progress.length ? { progress: [...progress] } : {}),
        })
        try {
          options.onReceipt?.(receipt)
        } catch {
          // Observers cannot change the terminal execution outcome.
        }
        return receipt
      }
      const fail = (outcome: ToolExecutionOutcome, code: string, reason: string) => finish(
        outcome,
        { content: reason, isError: true, error: reason },
        code,
        reason,
      )

      const authorityError = validateAuthority(request, options.authority)
      if (authorityError) return fail('cancelled', authorityError, authorityError)
      if (request.source !== 'pi' && request.source !== 'nestor-a2a') {
        return fail('error', 'unsupported_execution_source', String(request.source))
      }
      const port = ports.get(request.semanticId)
      if (!port) return fail('error', 'missing_execution_port', request.semanticId)
      descriptor = getHarnessToolDescriptor(request.semanticId)

      let canonicalInput: Record<string, unknown>
      try {
        canonicalInput = port.canonicalize(request.canonicalInput, request)
      } catch (error) {
        return fail('error', 'invalid_canonical_input', errorMessage(error))
      }

      if (!permissionBridge) {
        return fail('denied', 'missing_permission_bridge', 'Tool permission bridge is unavailable')
      }

      let decision: ToolPermissionDecision
      try {
        decision = await raceAbort(permissionBridge(request, canonicalInput), request.abortSignal)
      } catch (error) {
        if (error instanceof CodedError && error.code === 'aborted') {
          return fail('cancelled', 'aborted', 'Tool execution cancelled')
        }
        return fail('error', 'permission_bridge_error', errorMessage(error))
      }
      decisionId = decision.decisionId
      additionalContext = decision.additionalContext
      const afterPermission = validateAuthority(request, options.authority)
      if (afterPermission) return fail('cancelled', afterPermission, afterPermission)
      if (!decision.allowed) return fail('denied', 'permission_denied', decision.reason ?? 'Permission denied')
      try {
        canonicalInput = port.canonicalize(decision.canonicalInput ?? canonicalInput, request)
      } catch (error) {
        return fail('error', 'invalid_approved_input', errorMessage(error))
      }
      const controller = new AbortController()
      let abortCode: 'cancelled' | 'timed-out' | null = null
      const abort = () => {
        abortCode ??= 'cancelled'
        controller.abort()
      }
      if (request.abortSignal.aborted) abort()
      else request.abortSignal.addEventListener('abort', abort, { once: true })
      let timer: unknown
      let heartbeatTimer: unknown
      let dispatchedAt = 0
      const clearHeartbeat = () => {
        if (heartbeatTimer === undefined) return
        timers.clearTimeout(heartbeatTimer)
        heartbeatTimer = undefined
      }
      const beat = () => {
        heartbeatTimer = undefined
        if (finished || controller.signal.aborted) return
        if (validateAuthority(request, options.authority)) return
        const elapsedSeconds = Math.max(0, Math.round((now() - dispatchedAt) / 1000))
        try {
          options.onProgress?.(request.executionId, toolCallHeartbeatProgress(elapsedSeconds))
        } catch {
          // Observers cannot cancel or fail tool execution.
        }
        armHeartbeat()
      }
      const armHeartbeat = () => {
        // No observer, no timer: the A2A executor takes no `onProgress`, and a
        // beat nobody receives is pure handle debt for the call's whole life.
        if (!options.onProgress) return
        heartbeatTimer = timers.setTimeout(beat, TOOL_CALL_HEARTBEAT_INTERVAL_MS)
        // The session owns the call's lifetime, not the timer — the same
        // discipline `SESSION_CRON_TICK_MS` follows in session-cron-service.ts.
        ;(heartbeatTimer as { unref?: () => void } | undefined)?.unref?.()
      }
      // A push from the tool restarts the quiet window: the heartbeat fires
      // after 30s of SILENCE, not every 30s regardless.
      const restartHeartbeat = () => {
        if (heartbeatTimer === undefined) return
        clearHeartbeat()
        armHeartbeat()
      }

      try {
        if (controller.signal.aborted) {
          return fail(abortCode ?? 'cancelled', abortCode === 'timed-out' ? 'deadline_exceeded' : 'aborted', 'Tool execution cancelled')
        }
        timer = timers.setTimeout(() => {
          abortCode = 'timed-out'
          controller.abort()
        }, descriptor.timeoutMs)
        // Armed with the deadline, on the same seam: from here the call is
        // outstanding as far as the user is concerned (scheduler queueing
        // included), and the `finally` below always disarms it.
        dispatchedAt = now()
        armHeartbeat()
        const result = await scheduler.run(descriptor, async () => {
          const afterWait = validateAuthority(request, options.authority)
          if (afterWait) throw coded(afterWait)
          if (controller.signal.aborted) throw coded(abortCode === 'timed-out' ? 'deadline_exceeded' : 'aborted')
          const emitProgress = (value: ToolExecutionProgress): void => {
            if (controller.signal.aborted || validateAuthority(request, options.authority)) return
            if (progress.length >= maxProgressEvents) return
            const bounded = boundExecutionProgress(value, maxResultBytes)
            progress.push(bounded)
            try {
              options.onProgress?.(request.executionId, bounded)
            } catch {
              // Observers cannot cancel or fail tool execution.
            }
            restartHeartbeat()
          }
          const context = { request, signal: controller.signal, emitProgress }
          let dispatch: Promise<LocalToolExecutionResult>
          let mapResult: (
            (result: LocalToolExecutionResult, input: Record<string, unknown>) => Promise<LocalToolExecutionResult> | LocalToolExecutionResult
          ) | undefined
          let dispatchFinalized = false
          let preEffectStarted = false
          const runPostEffect = async (outcome: { result?: LocalToolExecutionResult; error?: unknown }): Promise<void> => {
            if (dispatchFinalized) return
            dispatchFinalized = true
            const postEffect = await Promise.resolve(
              options.afterDispatch?.(request, descriptor, canonicalInput, outcome),
            )
            correlation = mergeCorrelation(correlation, postEffect)
          }
          const runPreEffect = async (): Promise<void> => {
            preEffectStarted = options.beforeDispatch !== undefined
            // A checkpoint pre-effect may have persisted a preimage before its
            // promise settles. It is therefore intentionally non-detached and
            // non-cancellable: await it, then finalize every later failure.
            const preEffect = await Promise.resolve(
              options.beforeDispatch?.(request, descriptor, canonicalInput),
            )
            correlation = mergeCorrelation(correlation, preEffect)
            const afterHook = validateAuthority(request, options.authority)
            if (afterHook) throw coded(afterHook)
            if (controller.signal.aborted) throw coded(abortCode === 'timed-out' ? 'deadline_exceeded' : 'aborted')
          }
          let resolved: LocalToolExecutionResult
          try {
            await runPreEffect()
            if (port.dispatch.kind === 'semantic') {
              dispatch = port.dispatch.execute(canonicalInput, context)
            } else if (port.dispatch.kind === 'select' && port.dispatch.useSemantic(canonicalInput)) {
              dispatch = port.dispatch.executeSemantic(canonicalInput, context)
            } else {
              dispatch = options.runtime.executeAuthorized(port.dispatch.toLocalCall(canonicalInput, request, controller.signal))
              mapResult = port.dispatch.mapResult
            }
            resolved = await raceAbort(dispatch, controller.signal)
            if (mapResult) {
              resolved = await raceAbort(Promise.resolve(mapResult(resolved, canonicalInput)), controller.signal)
            }
            await runPostEffect({ result: resolved })
          } catch (error) {
            if (preEffectStarted) await runPostEffect({ error })
            throw error
          }
          const beforeTransform = validateAuthority(request, options.authority)
          if (beforeTransform) {
            progress = []
            throw coded(beforeTransform)
          }
          if (options.transformResult) {
            resolved = await raceAbort(
              Promise.resolve(options.transformResult(request, canonicalInput, resolved)),
              controller.signal,
            )
          }
          const beforeResult = validateAuthority(request, options.authority)
          if (beforeResult) {
            progress = []
            throw coded(beforeResult)
          }
          return resolved
        }, controller.signal)
        return finish(result.isError ? 'error' : 'success', result, result.isError ? 'execution_error' : undefined, result.error)
      } catch (error) {
        progress = []
        const code = error instanceof CodedError
          ? error.code
          : abortCode === 'timed-out'
            ? 'deadline_exceeded'
            : controller.signal.aborted
              ? 'aborted'
              : 'execution_error'
        if (code === 'stale_response_epoch' || code.endsWith('_mismatch')) {
          return fail('cancelled', code, code)
        }
        if (abortCode === 'timed-out' || code === 'deadline_exceeded') {
          return fail('timed-out', 'deadline_exceeded', 'Tool execution timed out')
        }
        if (controller.signal.aborted || code === 'aborted') {
          return fail('cancelled', 'aborted', 'Tool execution cancelled')
        }
        return fail('error', 'execution_error', errorMessage(error))
      } finally {
        if (timer !== undefined) timers.clearTimeout(timer)
        clearHeartbeat()
        request.abortSignal.removeEventListener('abort', abort)
      }
    },
  })
}

function mergeCorrelation(
  left: ToolExecutionCorrelation | undefined,
  right: ToolExecutionCorrelation | void,
): ToolExecutionCorrelation | undefined {
  if (!right) return left
  const childIds = [...new Set([...(left?.childIds ?? []), ...(right.childIds ?? [])])].slice(0, 8)
  return {
    ...left,
    ...right,
    ...(childIds.length ? { childIds } : {}),
  }
}

function deriveCorrelation(
  request: ToolExecutionRequest,
  result: LocalToolExecutionResult,
): ToolExecutionCorrelation | undefined {
  const details = result.structuredContent
  const nestedResult = asRecord(details?.result)
  const progress = asRecord(details?.progress)
  const processId = firstText(details?.shellId, details?.processId, details?.handle)
  const parentExecutionId = firstText(details?.parentExecutionId)
  const checkpointId = firstText(details?.checkpointId)
  const workflowId = firstText(details?.workflowId, progress?.runId, nestedResult?.runId)
  const childIds = childIdList(details)
  const mcp = mcpCorrelation(request.presentedName)
  if (!processId && !parentExecutionId && !checkpointId && !workflowId && childIds.length === 0 && !mcp) return undefined
  return {
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(processId ? { processId } : {}),
    ...(childIds.length ? { childIds } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...mcp,
  }
}

function mcpCorrelation(presentedName: string): Pick<ToolExecutionCorrelation, 'mcpServer' | 'mcpTool'> | undefined {
  if (!presentedName.startsWith('mcp__')) return undefined
  const [server, ...tool] = presentedName.slice(5).split('__')
  if (!server || tool.length === 0) return undefined
  return { mcpServer: server, mcpTool: tool.join('__') }
}

function childIdList(details: Record<string, unknown> | undefined): string[] {
  if (!details) return []
  const values = Array.isArray(details.agentIds) ? details.agentIds : []
  const single = firstText(details.agentId)
  return [...new Set([...(single ? [single] : []), ...values.filter((value): value is string => typeof value === 'string')])].slice(0, 8)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function validateAuthority(request: ToolExecutionRequest, authority: ToolExecutionAuthority): string | undefined {
  if (request.sessionKey.workspaceId !== authority.sessionKey.workspaceId) return 'workspace_id_mismatch'
  if (request.sessionKey.sessionId !== authority.sessionKey.sessionId) return 'session_id_mismatch'
  if (request.manifestIdentity.generation !== authority.manifestIdentity.generation) return 'manifest_generation_mismatch'
  if (request.manifestIdentity.manifestHash !== authority.manifestIdentity.manifestHash) return 'manifest_hash_mismatch'
  if (request.manifestIdentity.responseEpoch !== authority.manifestIdentity.responseEpoch
    || request.manifestIdentity.responseEpoch !== authority.getCurrentResponseEpoch()) return 'stale_response_epoch'
  return undefined
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(coded('aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(coded('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

class CodedError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function coded(code: string): CodedError {
  return new CodedError(code)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
