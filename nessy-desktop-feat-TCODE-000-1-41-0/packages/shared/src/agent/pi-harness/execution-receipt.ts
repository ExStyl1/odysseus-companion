import type { LocalToolExecutionResult } from '../local-tools/types.ts'
import type { ToolEffect } from './harness-tool-descriptor.ts'

export type ToolExecutionOutcome = 'success' | 'error' | 'denied' | 'cancelled' | 'timed-out'

export interface ToolExecutionProgress {
  text: string
  details?: Record<string, unknown>
}

export interface ToolExecutionReceipt {
  executionId: string
  semanticId: string
  decisionId: string
  isolationProfile: string
  environmentProfile?: string
  environmentDigest?: string
  manifestGeneration: string
  responseEpoch: number
  effect: ToolEffect | 'unknown'
  correlation?: ToolExecutionCorrelation
  startedAt: number
  completedAt: number
  outcome: ToolExecutionOutcome
  result: LocalToolExecutionResult
  code?: string
  reason?: string
  additionalContext?: string
  progress?: readonly ToolExecutionProgress[]
}

/**
 * Details key stamped on the executor's own liveness heartbeat, so every
 * consumer of the progress channel can tell "this call is still alive" apart
 * from output the tool itself pushed. A tool cannot forge it usefully: the key
 * carries no authority, it only routes the payload to the elapsed display.
 */
export const TOOL_CALL_HEARTBEAT_DETAIL_KEY = 'toolCallHeartbeat'

/** The one shape a heartbeat takes on the progress channel. */
export function toolCallHeartbeatProgress(elapsedSeconds: number): ToolExecutionProgress {
  return {
    text: `Still running (${elapsedSeconds}s)`,
    details: { [TOOL_CALL_HEARTBEAT_DETAIL_KEY]: true, elapsedSeconds },
  }
}

/**
 * Elapsed seconds off a heartbeat payload, or `null` for ordinary tool
 * progress. Backends map the non-null case onto `task_progress`'s
 * `elapsedSeconds` and must NOT accumulate the text as tool output.
 */
export function readToolCallHeartbeatElapsedSeconds(details: unknown): number | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const record = details as Record<string, unknown>
  if (record[TOOL_CALL_HEARTBEAT_DETAIL_KEY] !== true) return null
  const elapsedSeconds = record.elapsedSeconds
  return typeof elapsedSeconds === 'number' && Number.isFinite(elapsedSeconds) ? elapsedSeconds : null
}

export interface ToolExecutionCorrelation {
  parentExecutionId?: string
  checkpointId?: string
  processId?: string
  childIds?: readonly string[]
  workflowId?: string
  goalId?: string
  goalRevision?: number
  mcpServer?: string
  mcpTool?: string
}

export function boundExecutionProgress(
  progress: ToolExecutionProgress,
  maxBytes: number,
): ToolExecutionProgress {
  let details: Record<string, unknown> | undefined
  if (progress.details) {
    try {
      details = structuredClone(progress.details)
    } catch {
      details = { truncated: true, originalBytes: maxBytes + 1 }
    }
  }
  const bounded = boundExecutionResult({
    content: progress.text,
    isError: false,
    ...(details ? { structuredContent: details } : {}),
  }, maxBytes)
  return {
    text: bounded.content,
    ...(bounded.structuredContent ? { details: bounded.structuredContent } : {}),
  }
}

/**
 * P2.391 — A DUPLICATED PAYLOAD IS BUDGETED ONCE, NOT TWICE.
 *
 * `LocalToolRuntime`'s own `result()` helper sets `error: content` — the SAME
 * string — for every failing result it builds, so a failure arrived here
 * carrying one payload under two names. This function charged both, then split
 * the remaining budget in half between them, so **a failure received half the
 * bytes a success of the same size received** and the half it lost was its
 * TAIL, which is where a failure's diagnostic value is.
 *
 * That is not theoretical after P2.366. `tools-reference.md#output-limits`
 * specifies a failure as "a head-and-tail excerpt" of roughly 10,000
 * CHARACTERS; `config/bash-output-limits.ts` now cuts one. This cap counts
 * BYTES, and `tool-executor.ts` halves it again when `reason` duplicates the
 * result, so a non-ASCII excerpt met ~16 KiB: 10,000 Cyrillic characters are
 * about 20,000 bytes, and the head-only cut here removed exactly the tail the
 * excerpt had just been shaped to keep.
 *
 * ## Which consumer reads which field — measured, because collapsing them is a
 * wire change
 *
 * All three readers take **one** of the two, error first, and never both:
 *
 * - `pi-agent-server/src/local-tools/runtime-backed-tools.ts`:
 *   `throw new Error(result.error ?? result.content)`
 * - `pi-agent-server/src/local-tools/tool-wrapper.ts`:
 *   `throw new Error(receipt.reason ?? receipt.result.error ?? receipt.result.content)`
 * - `agent/backend/nestor-cloud/tool-executor.ts`: the same
 *   `reason ?? error ?? content` chain
 *
 * So the duplicate buys no consumer anything, and the halving cost every one of
 * them. The field is KEPT rather than dropped — dropping it is the wire change
 * the row warned about, and this is the smaller half of the row's own two
 * options.
 *
 * ## POSTURE, stated rather than slipped in
 *
 * The ceiling on DISTINCT payload is unchanged at `maxBytes`. What changes is
 * the SERIALIZED size of a duplicate-payload receipt: the same string now
 * appears at full budget under both names, so a JSON encoding of such a receipt
 * can reach about twice `maxBytes` (about three times, with a `reason` that
 * duplicates it as well) where it previously stayed at one. In memory it is one
 * string under two references, and it was already two references before. This
 * is a deliberate trade of serialized bytes for the tail of a failure message,
 * taken because a model that cannot see why a command failed is the cost on the
 * other side.
 */
export function boundExecutionResult(
  result: LocalToolExecutionResult,
  maxBytes: number,
): LocalToolExecutionResult {
  const encoder = new TextEncoder()
  const encodedContent = encoder.encode(result.content)
  const encodedError = typeof result.error === 'string' ? encoder.encode(result.error) : undefined
  // The duplicate is compared as a STRING, before encoding: two equal strings
  // encode identically, and comparing bytes would cost a second scan to learn
  // the same thing.
  const errorDuplicatesContent = typeof result.error === 'string' && result.error === result.content
  let structuredBytes = 0
  try {
    structuredBytes = result.structuredContent
      ? encoder.encode(JSON.stringify(result.structuredContent)).byteLength
      : 0
  } catch {
    structuredBytes = maxBytes + 1
  }
  const distinctErrorBytes = errorDuplicatesContent ? 0 : (encodedError?.byteLength ?? 0)
  const originalBytes = encodedContent.byteLength + distinctErrorBytes + structuredBytes
  if (originalBytes <= maxBytes) return { ...result }
  const marker = { truncated: true, originalBytes }
  const markerBytes = encoder.encode(JSON.stringify(marker)).byteLength
  const keepMarker = markerBytes <= maxBytes
  const textBudget = Math.max(0, maxBytes - (keepMarker ? markerBytes : 0))
  const splitBudget = encodedError !== undefined && !errorDuplicatesContent
  const contentBudget = splitBudget ? Math.floor(textBudget / 2) : textBudget
  const errorBudget = splitBudget ? textBudget - contentBudget : 0
  const boundedContent = truncateUtf8(encodedContent, contentBudget)
  return {
    ...result,
    content: boundedContent,
    // A duplicate stays a duplicate of the BOUNDED content, so the two fields
    // still carry one payload and every `error ?? content` reader is served the
    // same bytes whichever branch it takes.
    ...(encodedError
      ? { error: errorDuplicatesContent ? boundedContent : truncateUtf8(encodedError, errorBudget) }
      : {}),
    structuredContent: keepMarker ? marker : undefined,
  }
}

function truncateUtf8(encoded: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = Math.min(maxBytes, encoded.byteLength); end > 0; end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end))
    } catch {
      // Back up to the previous complete UTF-8 code point.
    }
  }
  return ''
}

export function freezeExecutionReceipt(receipt: ToolExecutionReceipt): ToolExecutionReceipt {
  if (receipt.correlation) {
    if (receipt.correlation.childIds) Object.freeze(receipt.correlation.childIds)
    Object.freeze(receipt.correlation)
  }
  if (receipt.result.structuredContent) Object.freeze(receipt.result.structuredContent)
  Object.freeze(receipt.result)
  if (receipt.progress) {
    for (const progress of receipt.progress) {
      if (progress.details) Object.freeze(progress.details)
      Object.freeze(progress)
    }
    Object.freeze(receipt.progress)
  }
  return Object.freeze(receipt)
}
