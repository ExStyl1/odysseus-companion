/**
 * R18: render the structured-output schema into prompt text, so the model is
 * SHOWN the schema it is judged against.
 *
 * Contract (code.claude.com/docs/en/agent-sdk/structured-outputs.md): "Define
 * a JSON Schema for the structure you need, and the SDK validates the output
 * against it, re-prompting on mismatch." Validation without disclosure orders
 * the model to match a schema it has never seen — the refuted half of R18.
 *
 * Channel decision: the Nessy Gateway is OpenAI-like with fragile tool shapes
 * (AGENTS.md — Gateway Facts), so the safe floor is prompt injection rather
 * than a wire-level `response_format`/`json_schema` field. The rendering is
 * NOT a second renderer: `buildCallLlmRequest` (shared llm-tool.ts) already
 * owns the one schema-injection block for the call_llm path, and this module
 * obtains the block by calling it, so both paths show the model an identical
 * schema text.
 */

import { buildCallLlmRequest } from '../../shared/src/agent/llm-tool.ts';

/**
 * The schema block `buildCallLlmRequest` injects for `outputSchema`, alone.
 * With an empty input system prompt the builder's returned `systemPrompt` IS
 * exactly the injected block ("You MUST respond with valid JSON matching this
 * schema: …"), so no wording is duplicated here.
 */
export async function renderStructuredOutputSchemaBlock(
  outputSchema: Record<string, unknown>,
): Promise<string> {
  const rendered = await buildCallLlmRequest(
    // The builder requires a non-empty prompt; only the systemPrompt (the
    // schema block) is consumed from the result.
    { prompt: 'render-schema-block', outputSchema },
    { backendName: 'Pi' },
  );
  return rendered.systemPrompt ?? '';
}

/** Prompt text with the schema block appended (unchanged when no block). */
export function withSchemaBlock(text: string, schemaBlock: string): string {
  return schemaBlock ? `${text}\n\n${schemaBlock}` : text;
}
