import type { PiExecutionManifestV2 } from './harness-manifest.ts'
import { COMPACTION_HANDOFF_INSTRUCTIONS, COMPACTION_TRUNCATION_MARKER } from '../../prompts/compaction.ts'
import { composeContinuationEnvelopePrompt, type ContinuationEnvelopeV1 } from './continuation-envelope.ts'

export interface PiCompactionReferences {
  taskIds: readonly string[]
  plan?: { revision: number; status: string }
  pendingAskUserRequestId?: string
  capabilityRefs: readonly string[]
  permissionRefs: readonly string[]
  resourceRefs: readonly string[]
  /**
   * P3.367 · the subagent definitions pinned into this session's capability
   * generation, as OPAQUE identifiers — carried in a field of their own rather
   * than folded into {@link resourceRefs}, which is where they used to ride.
   *
   * The producer mints `agent:<capabilityKey>@<generation>:<digest>`. Under the
   * old field that string sat in a list called `resourceRefs` beside real MCP
   * resource ids, with an `agent:` prefix and a plugin key inside it, in the
   * LIVE Pi system prompt on every turn — and a model that reads `agent:` as a
   * type and the rest as a name produces
   * `Unknown agent "agent:plugin://…@workspace:…:@…:…"`, character for
   * character, junction included (the `:@` is the scope token's empty trailing
   * project key meeting the `@generation`).
   *
   * The repair is here, on the PRODUCER side, and deliberately not in
   * `resolveAgentDefinition`: that file records matching-widenings as shadowing
   * hazards, and a digest must never be allowed to select a definition.
   *
   * Optional because every other consumer of this interface predates the field
   * and an absent list must render exactly as it did before.
   */
  agentDefinitionRefs?: readonly string[]
  continuationEnvelope?: ContinuationEnvelopeV1
}

export function composePiHarnessPrompt(
  base: string,
  manifest: PiExecutionManifestV2,
  references?: PiCompactionReferences,
): string {
  const hidden = new Set(manifest.deferredMcp.candidatePiNames)
  // One line per tool, carrying only what the tool SCHEMA does not already say.
  //
  // This block used to append `promptSnippet` plus the `promptGuidelines`, and
  // both were restatements — measured, not assumed:
  //
  // - `promptSnippet` IS the tool's `description`, truncated to 200 characters
  //   (`harness-manifest.ts` `derivePiPromptMetadata`). The model already has
  //   that description in the tool schema, so every tool's description was
  //   being sent twice in the same request.
  // - `Effect: …` was a repeat of the `effect` already in this line's own
  //   parenthetical — a second copy inside a single line. The plan named the
  //   snippet and missed this one.
  //
  // `scheduling` is the ONLY fact here that appears nowhere else, so it moves
  // INTO the parenthetical rather than being dropped with the prose. Following
  // the plan's literal wording — keep `effect` and `sandboxProfile` — would
  // have silently lost it, which is why this is a correction to coordinates
  // rather than to the approach.
  //
  // No debug flag for the long form: the plan offers one if the executor judges
  // the prose load-bearing for a specific tool, and it is not — the prose is
  // the schema's own description, reachable by the model either way. An opt-in
  // to re-send a duplicate is a switch nobody can correctly decide to use.
  const tools = manifest.tools
    .filter(tool => !hidden.has(tool.binding.piName))
    .map(tool => {
      // Each fact is included only when it is actually there. A descriptor
      // missing one used to be harmless because the value was interpolated
      // into prose; in a bare parenthetical an absent field renders the
      // literal string `undefined` INTO THE MODEL'S PROMPT, which is worse
      // than omitting it and looks like a value.
      const facts = [tool.descriptor.effect, tool.descriptor.sandboxProfile, tool.descriptor.scheduling]
        .filter(value => typeof value === 'string' && value.length > 0)
      return facts.length ? `${tool.binding.piName} (${facts.join(', ')})` : tool.binding.piName
    })
  const refs = references ? composePiReferenceReinjection(references) : undefined
  return [base, tools.length ? `## Active Nessy tool contract\n${tools.map(value => `- ${value}`).join('\n')}` : '', refs ?? '']
    .filter(Boolean).join('\n\n')
}

/**
 * Bounded, durable-reference reinjection block. Used both to seed the live Pi
 * system prompt (via `composePiHarnessPrompt`) and, during compaction, appended
 * after the handoff prompt so the summarizing model preserves these refs.
 */
export function composePiReferenceReinjection(references: PiCompactionReferences): string {
  if (references.continuationEnvelope) return composeContinuationEnvelopePrompt(references.continuationEnvelope)
  const agentDefinitionRefs = (references.agentDefinitionRefs ?? []).slice(0, 64)
  const bounded = {
    taskIds: references.taskIds.slice(0, 64),
    ...(references.plan ? { plan: references.plan } : {}),
    ...(references.pendingAskUserRequestId ? { pendingAskUserRequestId: references.pendingAskUserRequestId } : {}),
    capabilityRefs: references.capabilityRefs.slice(0, 64),
    permissionRefs: references.permissionRefs.slice(0, 32),
    resourceRefs: references.resourceRefs.slice(0, 64),
    // P3.367 · the KEY NAME is the fix. It used to be `resourceRefs`, which
    // says nothing about what the value is for, so an `agent:`-prefixed string
    // in it reads as an agent the model may dispatch. `opaqueAgentDefinitionIds`
    // says what it is in the one place the model is guaranteed to look: right
    // beside the value.
    ...(agentDefinitionRefs.length ? { opaqueAgentDefinitionIds: agentDefinitionRefs } : {}),
  }
  // The sentence is appended only when the field is present. A standing warning
  // about a field that is not there teaches the model a rule it cannot apply
  // and costs tokens on every turn of every session that has no subagents.
  const agentNote = agentDefinitionRefs.length
    ? ' The opaqueAgentDefinitionIds are internal capability identifiers, not agent names —'
      + ' never pass one as a subagent type; use the agent NAME from the tool schema.'
    : ''
  return `Preserve these durable Nessy references only; do not replay actions or promises: ${JSON.stringify(bounded)}${agentNote}`
}

/**
 * Upper bound on explicit `/compact <text>` custom instructions folded into the
 * compaction prompt. Parity with the bounded reference-reinjection block: a
 * runaway paste must not crowd out the handoff prompt or the summarizer's own
 * budget. Truncated instructions keep a visible marker so the model does not
 * treat a cut-off sentence as complete.
 */
export const PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX = 8192
// P6.54 · one marker for every bounded block in this prompt — the project's
// standing `Compact Instructions` section cuts with the same mark. See
// `COMPACTION_TRUNCATION_MARKER`.
const PI_COMPACTION_TRUNCATION_MARKER = COMPACTION_TRUNCATION_MARKER

/**
 * Bound explicit user compaction instructions. Returns the input unchanged when
 * within budget; otherwise trims to the cap (leaving room for the marker) and
 * appends a truncation marker.
 */
export function capPiCompactionCustomInstructions(custom: string): string {
  if (custom.length <= PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX) return custom
  const keep = PI_COMPACTION_CUSTOM_INSTRUCTIONS_MAX - PI_COMPACTION_TRUNCATION_MARKER.length
  return `${custom.slice(0, keep)}${PI_COMPACTION_TRUNCATION_MARKER}`
}

/**
 * Compaction instructions fed to the Pi SDK's single compaction owner
 * (`session.compact(instructions)`). Always leads with the context-checkpoint
 * handoff prompt (K1) so the summary is a prior-model handoff, then layers any
 * explicit user `/compact <text>` instructions (capped) and the bounded
 * reference reinjection. No second compaction lifecycle is introduced — this
 * only shapes the instructions the existing owner already passes to the SDK.
 *
 * The manual `/compact` RPC and the subprocess auto-compaction replacement both
 * use this composer. Pi still hardcodes `customInstructions: undefined` for its
 * built-in auto summarizer, so the auto path owns the summary request inside
 * `session_before_compact` and returns the SDK's supported full `{compaction}`
 * replacement on the auto controller's AbortSignal.
 */
export function composePiCompactionInstructions(
  custom: string | undefined,
  references: PiCompactionReferences | undefined,
): string {
  const parts = [COMPACTION_HANDOFF_INSTRUCTIONS]
  if (custom) parts.push(capPiCompactionCustomInstructions(custom))
  if (references) parts.push(composePiReferenceReinjection(references))
  return parts.join('\n\n')
}
