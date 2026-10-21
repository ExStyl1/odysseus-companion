/**
 * The handoff payload → Codex Responses items mapping (T1a text, T1b tools).
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`. This is a
 * separate module rather than a private method on `CodexAgent` for one reason:
 * the plan's DONE criterion is that a fact whose ONLY source is a tool result
 * survives the whole pipeline — SessionManager arms, `buildRuntimeHandoffPayload`
 * projects, this maps — and a test that restated the mapping by hand would
 * certify nothing. `runtime-handoff-payload.test.ts` calls THIS function; so
 * does the agent.
 *
 * Pure: no I/O, no runtime, no client.
 */
import type { RuntimeHandoffHistoryItem, RuntimeHandoffPayload } from './backend/types.ts';

/**
 * A raw Responses API item, as `thread/inject_items` takes it.
 *
 * `ThreadInjectItemsParams` (`packages/codex-protocol/generated/`) types the
 * array as `Array<JsonValue>` with the docstring *"Raw Responses API items to
 * append to the thread's model-visible history"*, so there is no generated type
 * to reach for and the shape below is the contract we hold ourselves to.
 */
export type CodexInjectItem = Record<string, unknown>;

function messageItem(role: 'user' | 'assistant', text: string): CodexInjectItem {
  // The mapping is not symmetric and Codex rejects it the other way round: a
  // user turn is `input_text`, an assistant turn is `output_text`.
  return role === 'user'
    ? { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

/**
 * Map an armed handoff to the items `thread/inject_items` appends.
 *
 * Prefers `history` (T1b's row projection — tool traffic included, present only
 * on a `native` plan) and falls back to `messages` (T1a's text projection) when
 * the payload carries none. The fallback is not dead code: a payload armed
 * before T1b existed, or one whose transcript held nothing but text, has no
 * `history` field at all.
 *
 * **A tool row becomes a PAIR, emitted adjacent and in wire order**:
 * `function_call` then `function_call_output`, joined by `call_id`. The order
 * and the adjacency are the contract — an unpaired or out-of-order
 * `function_call` in model-visible history is a hard provider error, not a
 * degraded read. Verified on the shipped `rust-v0.148.0` app-server against a
 * loopback Responses provider: both halves reach the model's request body, in
 * order, ahead of the new user message (`codex-inject-items-e2e.test.ts`).
 *
 * **REASONING IS CARRIED — P6.481, and the reason it was not used to be wrong.**
 *
 * The recorded premise was *"the corpus holds zero, and the app-server writes
 * `encrypted_content: null` for them"*. Measured against the pinned schema
 * (`packages/codex-protocol/schema/ClientRequest.json`, `rust-v0.148.0`):
 * `ReasoningResponseItem` is `"required": ["summary","type"]`, its `summary` an
 * array of `ReasoningItemReasoningSummary` (`{type:"summary_text", text}`),
 * `encrypted_content` a NULLABLE string and `content` a nullable array of
 * `ReasoningItemContent`. So the attestation is OPTIONAL and the reasoning TEXT
 * is plain, required and expressible; `thread/inject_items` takes
 * `{type:'reasoning', summary:[…], encrypted_content:null}` with nothing to
 * enable. That is codex's own documented replay shape — the opposite of
 * invented — and native-first puts it at case (1).
 *
 * `encrypted_content: null` is written deliberately and is not a placeholder:
 * we hold no attestation for a reasoning block, ours or anyone's, and the
 * schema's own type for the field is `["string","null"]`. Sending a fabricated
 * one would be the only dishonest option available here.
 *
 * **SAME-RUNTIME ONLY, and the gate is NOT here.** A `reasoning` entry reaches
 * this mapper only when `buildRuntimeHandoffHistory` established that the row
 * was produced by the runtime taking over (owner Q10/Q16 = (b)); foreign-origin
 * reasoning is dropped there, with P6.87's honest sentence covering the loss.
 * Keeping provenance in one place is deliberate — a second origin test here
 * would be a second rule to keep in step.
 *
 * **The gateway leg drops it, so the switch line is per-MODEL.** Reasoning
 * injected on the Responses leg has no slot on chat-completions
 * (`anthropic/to-chat.ts`), so a codex connection running through the gateway
 * carries no reasoning across a switch while a Responses one does — the shape
 * P3.280 already had to adopt for images. That is a property of the model's
 * wire, not of the runtime, and the switch-cost surface has to say so.
 */
export function buildCodexInjectItems(handoff: RuntimeHandoffPayload): CodexInjectItem[] {
  if (handoff.history && handoff.history.length > 0) {
    const items: CodexInjectItem[] = [];
    for (const entry of handoff.history) {
      if (entry.kind === 'reasoning') {
        items.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: entry.content }],
          encrypted_content: null,
        });
        continue;
      }
      if (entry.kind === 'tool') {
        items.push({
          type: 'function_call',
          name: entry.name,
          arguments: JSON.stringify(entry.input),
          call_id: entry.callId,
        });
        items.push({
          type: 'function_call_output',
          call_id: entry.callId,
          output: entry.output,
        });
        continue;
      }
      items.push(messageItem(entry.role, entry.content));
    }
    return items;
  }

  return handoff.messages.map(m => messageItem(m.type === 'user' ? 'user' : 'assistant', m.content));
}
