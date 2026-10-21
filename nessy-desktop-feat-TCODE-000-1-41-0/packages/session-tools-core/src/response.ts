/**
 * Session Tools Core - Response Helpers
 *
 * Helper functions for creating standardized tool responses.
 * Used by both Claude and Codex implementations.
 */

import type { ToolResult, TextContent } from './types.ts';

/**
 * Create a successful text response.
 *
 * No `structuredContent`: an EMPTY one is not a neutral default on the codex
 * wire, it REPLACES the text. See `errorResponse` below for the measurement and
 * the upstream rule; a handler with a real record to carry (`handleMonitor`,
 * `handleCronCreate`, …) sets the field itself and keeps winning.
 */
export function successResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/**
 * Create an error response.
 *
 * IMPORTANT — OpenAI Responses API limitation (discovered 2025-02):
 * The `function_call_output` input item only has `type`, `call_id`, and
 * `output` (a plain string). There is NO `success`, `status`, or `error`
 * field. Our Codex fork's FunctionCallOutputPayload has a `success: bool`
 * field, but its custom Serialize impl (codex-rs/protocol/src/models.rs)
 * drops it entirely — only the content string is serialized to the API.
 *
 * This means `isError: true` is invisible to the model. To make errors
 * distinguishable from successes, we prefix the output text with "[ERROR]".
 * The model can then parse this prefix to understand the tool call failed.
 *
 * This covers all session MCP tool errors (source_test, config_validate,
 * skill_validate, SubmitPlan, credential_prompt, oauth triggers, etc.).
 *
 * See also: blockWithReason() in packages/shared/src/agent/mode-manager.ts
 * which applies the same prefix for permission-mode blocks.
 *
 * P3.11 — and the prefix only helps if the TEXT arrives. It did not. This
 * result used to carry `structuredContent: {}`, and codex reads a result like
 * this (`codex-rs/protocol/src/models.rs`,
 * `CallToolResult::as_function_call_output_payload`, at the tag
 * `packages/codex-protocol/manifest.json` pins):
 *
 *   if let Some(structured_content) = &self.structured_content
 *       && !structured_content.is_null()
 *   { ... return FunctionCallOutputBody::Text(serialized_structured_content) }
 *   // only if that branch is not taken is `content` serialized
 *
 * The test is `is_null()`, NOT "is empty" — so an empty object is a present one
 * and the model was handed the two characters `{}` instead of the refusal. T6
 * measured the consequence live
 * (`docs/testing/cdp-runs/2026-08-23-t6-codex-scheduling.md`): a `Monitor` deny
 * was enforced — no watch started, the rule named here — and the model twice
 * reported that it had "started a watch successfully".
 *
 * So: no `structuredContent` unless a handler has a real record to put in it.
 * `withoutEmptyStructuredContent()` below re-applies the same rule at the codex
 * MCP boundary for results this factory did not build.
 */
export function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `[ERROR] ${message}` }],
    isError: true,
  };
}

/**
 * Create a text content block
 */
export function textContent(text: string): TextContent {
  return { type: 'text', text };
}

/**
 * Create a multi-block response (e.g., for multiple sections)
 */
export function multiBlockResponse(texts: string[], isError?: boolean): ToolResult {
  return {
    content: texts.map(text => ({ type: 'text' as const, text })),
    isError,
  };
}

/**
 * True for a structured payload worth sending: a non-null object with at least
 * one key. The same shape `hasStructuredContent()` already applies host-side
 * (`shared/src/mcp/mcp-pool.ts`, `shared/src/agent/pi-agent.ts`), where an empty
 * one is likewise treated as nothing to carry.
 */
function carriesStructuredContent(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length > 0
  );
}

/**
 * P3.11 — drop an empty `structuredContent` before a result crosses the codex
 * MCP wire.
 *
 * `errorResponse` and `successResponse` no longer produce one, but they are not
 * the only sources: a handler bound onto the context builds its own result, and
 * so does any tool added later. Codex's rule is `is_null()` (quoted in
 * `errorResponse` above), so a present-but-empty payload silently replaces the
 * reply text with `{}` — the honest default is to send no payload at all rather
 * than an empty one. A NON-empty payload is passed through untouched: that is
 * the path T6 measured working, and it stays byte-identical.
 *
 * One deliberate over-reach: an ARRAY payload is dropped too — including a
 * non-empty one, which codex would have delivered — because
 * `carriesStructuredContent()` mirrors the host-side predicate exactly rather
 * than diverging from it; `ToolResult.structuredContent` is a `Record`, so the
 * case is unreachable through the type in the first place.
 */
export function withoutEmptyStructuredContent<T extends object>(result: T): T {
  // `T extends object`, not `{ structuredContent?: unknown }`: the dispatcher
  // this guards returns a UNION, and a member that never declares the field is
  // exactly the shape that must pass through untouched.
  const candidate = result as { structuredContent?: unknown };
  if (!('structuredContent' in result) || carriesStructuredContent(candidate.structuredContent)) {
    return result;
  }
  const { structuredContent: _dropped, ...rest } = result as T & { structuredContent?: unknown };
  return rest as T;
}
