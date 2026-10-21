import { PI_TOOL_BINDINGS } from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'

const MAX_MESSAGES = 10_000
const MAX_PARTS_PER_MESSAGE = 1_000
const MAX_TOOL_NAME_BYTES = 512

/**
 * Every persisted spelling that is no longer the name Pi dispatches on, mapped
 * to the one that is.
 *
 * Two families, and they point in OPPOSITE directions — which is why the table
 * is derived rather than written out:
 *
 * 1. The two NATIVE bindings whose host spelling differs from their piName
 *    (`NotebookEdit` → `notebook_edit`, `stopTask` → `stop_task`). Older
 *    transcripts recorded the host spelling. These are listed verbatim: the
 *    divergence is deliberate and permanent, not a rename in flight.
 * 2. Every SESSION tool whose piName used to be the snake_case DESCRIPTOR id
 *    (`mcp__session__submit_plan`) and is now the registry id verbatim
 *    (`mcp__session__SubmitPlan`). A session recorded before the wire-name
 *    unification carries the old spelling; without this, a resumed session
 *    would show two different names for one tool across its turns.
 *
 * The predicate for family 2 is `bindingName.startsWith('mcp__session__')` AND
 * `descriptorId !== handlerName`. The second half alone is NOT the rule — it
 * also matches `notebook_edit`, `stopTask`, `mcp_tool_search` and
 * `mcp_tool_load`, whose bindings are natives and two of which must keep the
 * hand-written direction above rather than acquire a reversed one.
 *
 * Derived from `PI_TOOL_BINDINGS`, never hand-maintained: a session tool added
 * or respelled later gets its legacy entry from the same registry that decides
 * its live name, so the two cannot drift.
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  NotebookEdit: 'notebook_edit',
  stopTask: 'stop_task',
  ...Object.fromEntries(PI_TOOL_BINDINGS
    .filter(binding => binding.bindingName.startsWith('mcp__session__')
      && binding.descriptorId !== binding.handlerName)
    .map(binding => [`mcp__session__${binding.descriptorId}`, binding.piName])),
})

const encodedBytes = (value: string): number => new TextEncoder().encode(value).byteLength

export function normalizePiSdkToolCallRecordsV1<T>(value: T): T {
  if (!Array.isArray(value)) throw new Error('Pi SDK history must be an array')
  if (value.length > MAX_MESSAGES) throw new Error('Pi SDK history message limit exceeded')

  for (const message of value as Array<{ content?: unknown }>) {
    if (!Array.isArray(message?.content)) continue
    if (message.content.length > MAX_PARTS_PER_MESSAGE) {
      throw new Error('Pi SDK history parts limit exceeded')
    }
    for (const part of message.content as Array<{ type?: unknown; name?: unknown }>) {
      if (part?.type !== 'toolCall') continue
      if (typeof part.name !== 'string' || part.name.length === 0) {
        throw new Error('Pi SDK history tool name must be a non-empty string')
      }
      if (encodedBytes(part.name) > MAX_TOOL_NAME_BYTES) {
        throw new Error('Pi SDK history tool name limit exceeded')
      }
    }
  }

  const clone = structuredClone(value)
  for (const message of clone as Array<{ content?: unknown }>) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== 'toolCall' || typeof part.name !== 'string') continue
      const current = TOOL_NAME_ALIASES[part.name]
      if (!current || current === part.name) continue
      part.originalName = part.name
      part.name = current
    }
  }
  return clone
}
