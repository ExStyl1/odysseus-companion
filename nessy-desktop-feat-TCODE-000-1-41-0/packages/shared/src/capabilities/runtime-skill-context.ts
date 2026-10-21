import type { RuntimeSkillHandle } from './views.ts'

export interface RuntimeSkillContextRequest {
  skillKey: string
  command: string
  cwd: string
  generation: string
  resourceHash: string
  timeoutMs: number
}

export type RuntimeSkillContextExecutor = (
  request: RuntimeSkillContextRequest,
  signal: AbortSignal,
) => Promise<string>

export const RUNTIME_SKILL_CONTEXT_TIMEOUT_MS = 5_000
export const RUNTIME_SKILL_CONTEXT_MAX_BYTES = 32 * 1024
/**
 * Per-body ceilings the page does not state but a shell-executing preprocessor
 * needs, because `skills.md` puts no limit on the count: "Each `` !`<command>` ``
 * executes immediately (before Claude sees anything)".
 *
 * The rendered body is therefore bounded by the skill body's own 256 KiB cap
 * (`MAX_SKILL_BODY_BYTES`, enforced on the record at materialization) plus these
 * 128 KiB of command output — the per-command 32 KiB cap alone would allow
 * sixteen times that.
 */
export const RUNTIME_SKILL_CONTEXT_MAX_COMMANDS = 16
export const RUNTIME_SKILL_CONTEXT_MAX_TOTAL_BYTES = 128 * 1024

/** `inline` is `` !`cmd` ``; `fenced` is the multi-line ` ```! ` block. */
export type RuntimeSkillContextForm = 'inline' | 'fenced'

export interface RuntimeSkillContextPlaceholder {
  /** The command text with its delimiters STRIPPED — what reaches the shell. */
  readonly command: string
  /** Half-open span in the body the output replaces. */
  readonly start: number
  readonly end: number
  readonly form: RuntimeSkillContextForm
}

/**
 * `skills.md` — "The inline form is only recognized when `!` appears at the
 * start of a line or immediately after whitespace. If `!` follows another
 * character, as in `` KEY=!`cmd` ``, the placeholder is left as literal text and
 * the command does not run."
 *
 * Exported so a detector and this executor cannot drift apart. `[^`\n]*` keeps a
 * placeholder inside one line: the inline form's closing delimiter is the next
 * backtick on the SAME line, and the multi-line case has its own fenced form.
 */
export const RUNTIME_SKILL_CONTEXT_INLINE_PATTERN = /(?:^|(?<=\s))!`[^`\n]*`/

const FENCED_COMMAND_OPEN = /^\s*```!\s*$/
const FENCE_CLOSE = /^\s*```\s*$/
const ANY_FENCE = /^\s*```/

/**
 * Every executable placeholder in a skill body, in source order.
 *
 * TOTAL by design — it never throws. An empty command is returned with
 * `command: ''` and refused by the execution path instead, so the parser is safe
 * to call on any body (including a non-Pi backend's, where nothing executes) and
 * on both the raw and the expanded body for the injection check in
 * `materializeRuntimeSkillInvocation`.
 *
 * What is EXECUTED: the text between the delimiters of an inline `` !`cmd` ``
 * whose `!` sits at line start or immediately after whitespace, and the whole
 * inner text of a ` ```! ` fenced block. What is REFUSED, left as literal prose:
 * a `!` preceded by any non-whitespace character, anything inside an ordinary
 * fence, an inline form with no closing backtick on its own line, and an
 * unterminated ` ```! ` block.
 */
export function parseRuntimeSkillContextCommands(body: string): RuntimeSkillContextPlaceholder[] {
  const placeholders: RuntimeSkillContextPlaceholder[] = []
  let index = 0
  let fenced = false
  for (;;) {
    const newline = body.indexOf('\n', index)
    const lineEnd = newline === -1 ? body.length : newline
    // `trimEnd` rather than a `\r\n` normalization pass: the offsets on every
    // placeholder index into the ORIGINAL body, which a rewrite would shift.
    const line = body.slice(index, lineEnd).trimEnd()
    if (!fenced && FENCED_COMMAND_OPEN.test(line)) {
      const block = readFencedCommand(body, index, lineEnd)
      if (block) {
        placeholders.push(block.placeholder)
        if (block.next > body.length) break
        index = block.next
        continue
      }
      // An unterminated ` ```! ` never runs — it opens an ordinary fence and the
      // rest of the body stays prose, which is the fail-closed direction.
      fenced = true
    } else if (ANY_FENCE.test(line)) {
      fenced = !fenced
    } else if (!fenced) {
      collectInlineCommands(body.slice(index, lineEnd), index, placeholders)
    }
    if (newline === -1) break
    index = newline + 1
  }
  return placeholders
}

function readFencedCommand(
  body: string,
  openStart: number,
  openEnd: number,
): { placeholder: RuntimeSkillContextPlaceholder; next: number } | undefined {
  const lines: string[] = []
  let index = openEnd === body.length ? -1 : openEnd + 1
  while (index !== -1) {
    const newline = body.indexOf('\n', index)
    const lineEnd = newline === -1 ? body.length : newline
    const line = body.slice(index, lineEnd)
    if (FENCE_CLOSE.test(line.trimEnd())) {
      return {
        placeholder: {
          command: lines.join('\n').trim(),
          start: openStart,
          end: lineEnd,
          form: 'fenced',
        },
        next: newline === -1 ? body.length + 1 : newline + 1,
      }
    }
    lines.push(line.replace(/\r$/, ''))
    if (newline === -1) break
    index = newline + 1
  }
  return undefined
}

function collectInlineCommands(
  line: string,
  offset: number,
  into: RuntimeSkillContextPlaceholder[],
): void {
  let cursor = 0
  for (;;) {
    const bang = line.indexOf('!`', cursor)
    if (bang === -1) return
    // The documented left boundary: line start, or whitespace. Anything else
    // (`KEY=!`cmd``) leaves the placeholder literal.
    if (bang > 0 && !/\s/.test(line[bang - 1]!)) {
      cursor = bang + 1
      continue
    }
    const close = line.indexOf('`', bang + 2)
    if (close === -1) return
    into.push({
      command: line.slice(bang + 2, close).trim(),
      start: offset + bang,
      end: offset + close + 1,
      form: 'inline',
    })
    cursor = close + 1
  }
}

/**
 * Splice command output into the placeholder spans.
 *
 * `skills.md` — "Substitution runs once over the original file. Command output
 * is inserted as plain text and is not re-scanned for further `` !`<command>` ``
 * placeholders, so a command cannot emit a placeholder for a later pass to
 * expand." The single right-to-left pass over spans computed against the
 * ORIGINAL body is that guarantee: no output is ever parsed, and no earlier
 * splice can move a later span.
 */
export function applyRuntimeSkillContextOutputs(
  body: string,
  placeholders: readonly RuntimeSkillContextPlaceholder[],
  outputs: readonly string[],
): string {
  if (placeholders.length !== outputs.length) {
    throw new Error('runtime-skill-context-output-count-mismatch')
  }
  let total = 0
  for (const output of outputs) total += Buffer.byteLength(output, 'utf8')
  if (total > RUNTIME_SKILL_CONTEXT_MAX_TOTAL_BYTES) {
    throw new Error('runtime-skill-context-output-invalid')
  }
  let rendered = body
  for (let index = placeholders.length - 1; index >= 0; index -= 1) {
    const placeholder = placeholders[index]!
    rendered = rendered.slice(0, placeholder.start) + outputs[index]! + rendered.slice(placeholder.end)
  }
  return rendered
}

export interface RuntimeSkillContextRenderInput {
  invocations: readonly { readonly key: string; readonly body: string }[]
  skills: readonly RuntimeSkillHandle[]
  generation: string
  cwd: string
  executor: RuntimeSkillContextExecutor | undefined
  signal: AbortSignal
  assertActive: () => void
}

/**
 * THE one renderer. Every route that turns a skill body into model-visible text
 * — the invoking turn's pinned block, the model-invocation continuation, and the
 * child session's prompt — takes its rendered body from here, so a forked skill
 * and an inline skill cannot disagree about whether the page's own `pr-summary`
 * example ships substituted.
 *
 * Returns a body only for the skills that actually had a placeholder executed;
 * every other consumer falls back to `invocation.body`.
 *
 * The plugin-runtime gate is unchanged from the single-command implementation
 * this replaces (finding f059, refuted as its own row): only a skill carrying a
 * verified plugin bundle executes, because the executor's staleness and bundle
 * checks are keyed on it.
 */
export async function renderRuntimeSkillContextBodies(
  input: RuntimeSkillContextRenderInput,
): Promise<Map<string, string>> {
  const rendered = new Map<string, string>()
  for (const invocation of input.invocations) {
    const skill = input.skills.find(candidate => candidate.key === invocation.key)
    if (!skill?.pluginRuntime) continue
    const placeholders = parseRuntimeSkillContextCommands(invocation.body)
    if (placeholders.length === 0) continue
    if (placeholders.length > RUNTIME_SKILL_CONTEXT_MAX_COMMANDS) {
      throw new Error('runtime-skill-context-command-limit')
    }
    const executor = input.executor
    if (!executor) throw new Error('runtime-skill-context-executor-unavailable')
    const outputs: string[] = []
    for (const placeholder of placeholders) {
      if (!placeholder.command) throw new Error('runtime-skill-context-command-empty')
      input.assertActive()
      outputs.push(await runOneCommand(input, skill, placeholder.command, executor))
    }
    rendered.set(invocation.key, applyRuntimeSkillContextOutputs(invocation.body, placeholders, outputs))
  }
  return rendered
}

async function runOneCommand(
  input: RuntimeSkillContextRenderInput,
  skill: RuntimeSkillHandle,
  command: string,
  executor: RuntimeSkillContextExecutor,
): Promise<string> {
  const turnSignal = input.signal
  const controller = new AbortController()
  const abort = () => controller.abort(turnSignal.reason)
  if (turnSignal.aborted) abort()
  else turnSignal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), RUNTIME_SKILL_CONTEXT_TIMEOUT_MS)
  try {
    if (controller.signal.aborted) throw new Error('runtime-skill-context-aborted')
    const output = await executor({
      skillKey: skill.key,
      command,
      cwd: input.cwd,
      generation: input.generation,
      resourceHash: skill.resource.contentHash,
      timeoutMs: RUNTIME_SKILL_CONTEXT_TIMEOUT_MS,
    }, controller.signal)
    if (turnSignal.aborted) throw new Error('runtime-skill-context-aborted')
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > RUNTIME_SKILL_CONTEXT_MAX_BYTES) {
      throw new Error('runtime-skill-context-output-invalid')
    }
    return output
  } catch (error) {
    if (turnSignal.aborted) throw new Error('runtime-skill-context-aborted')
    if (controller.signal.aborted) throw new Error('runtime-skill-context-timeout')
    throw error
  } finally {
    clearTimeout(timer)
    turnSignal.removeEventListener('abort', abort)
  }
}
