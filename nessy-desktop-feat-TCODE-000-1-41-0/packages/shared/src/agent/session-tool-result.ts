/**
 * The one translation from the registry's `ToolResult` to MCP's
 * `CallToolResult`.
 *
 * It lived inside `session-scoped-tools.ts` until C3.121's neighbour C3.147
 * needed it from `browser-tools.ts`, which `session-scoped-tools.ts` itself
 * imports — a leaf is what keeps that from becoming an import cycle. Nothing
 * else moved: the body, and the rule it applies, are P6.345's.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { withoutEmptyStructuredContent, type ToolResult } from '@nessy-agent/session-tools-core';

/**
 * Convert shared ToolResult to SDK format.
 *
 * P6.345 — this used to return text and nothing else, so two things the SDK
 * accepts were thrown away on the claude path while the codex path carried
 * them: the `structuredContent` record, and any non-text block.
 *
 * The SDK's `tool()` handler returns MCP's own `CallToolResult`, so both are
 * native there — nothing needed building on the runtime side, the host adapter
 * was simply dropping them. `extraContent` is appended AFTER `content`: the
 * text a model reads first stays first, and an image or an embedded resource
 * follows it.
 *
 * `structuredContent` is forwarded only when it carries a record.
 * `withoutEmptyStructuredContent` states the rule the codex boundary already
 * applies and it holds here for the same reason: a present-but-empty field
 * makes a codex client hand the model `{}` INSTEAD of the reply text, so absent
 * is the neutral value and `{}` is not
 * (`packages/session-tools-core/src/response.ts` symbol `errorResponse` carries
 * the upstream rule and the live measurement).
 *
 * Exported for focused unit tests.
 */
export function convertResult(result: ToolResult): CallToolResult {
  const text = result.content.map(c => ({ type: 'text' as const, text: c.text }));
  const converted = {
    content: [...text, ...(result.extraContent ?? [])],
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
  return withoutEmptyStructuredContent(converted) as CallToolResult;
}
