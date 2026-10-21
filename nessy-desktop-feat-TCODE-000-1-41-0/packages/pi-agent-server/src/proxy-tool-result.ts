import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

/**
 * MCP's image block, re-declared here because this is a WIRE shape crossing a
 * process boundary — the same reason `content`/`isError`/`structuredContent`
 * are re-declared rather than imported from the host's `PiProxyToolResult`.
 *
 * It is byte-identical to Pi's OWN `ImageContent`
 * (`@earendil-works/pi-ai`: `{ type: "image"; data: string; mimeType: string }`),
 * which is why an image can be merged straight into `content` below with no
 * translation.
 */
interface ProxyImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** MCP's embedded-resource block. Pi's content union has no member for it. */
interface ProxyResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

type ProxyNonTextContent = ProxyImageContent | ProxyResourceContent;

export interface ProxyExecutionResult {
  content: string;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  /**
   * The non-text blocks a registry tool returned alongside its text (P6.345's
   * `ToolResult.extraContent`), set by the host at the producer in
   * `pi-agent.ts` and merged here — P6.617.
   *
   * Pi's direct sidecar path is the LAST of the four adapters to honour it:
   * `session-scoped-tools.ts:convertResult` (claude) and
   * `session-mcp-server/src/index.ts:withMergedExtraContent` (codex, and Pi
   * over MCP) already did, so the same registry tool answered differently
   * depending on which route reached it.
   */
  extraContent?: ProxyNonTextContent[];
}

export interface ProxyToolResultDetails {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  /**
   * Resource blocks that had nowhere to go in `content` — see the merge below.
   * Carried rather than dropped, so a tool that returns one is inspectable
   * instead of silently truncated.
   */
  extraContent?: ProxyResourceContent[];
}

function hasStructuredContent(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

export function proxyExecutionResultToAgentToolResult(
  result: ProxyExecutionResult,
): AgentToolResult<ProxyToolResultDetails> {
  const details: ProxyToolResultDetails = {};
  if (result.isError) {
    details.isError = true;
  }
  // Delivery shape: keep the text in content and attach structured MCP payloads
  // as a details sidecar, which is where Pi's own `AgentToolResult` puts
  // structured output — visible to logs and the renderer, and NOT on any
  // provider wire. Measured 2026-09-09 over the vendored `@earendil-works/pi-ai`:
  // `.details` occurs 0 times in `dist/api/anthropic-messages.js` and 0 times in
  // `dist/api/openai-completions.js` (`.content` 34 and 24 as positive controls),
  // and `convertToolResult` builds the Anthropic `tool_result` from `msg.content`
  // and `msg.isError` alone. So "strict tool_result parsers" here means ours, not
  // the model's: a strict parser on the wire never sees this field at all.
  if (hasStructuredContent(result.structuredContent)) {
    details.structuredContent = result.structuredContent;
  }

  // P6.617 — the merge, split by what Pi's own content union can carry.
  //
  // NATIVE-FIRST, measured rather than assumed: `AgentToolResult.content` is
  // `(TextContent | ImageContent)[]`, so Pi already accepts an image block and
  // needs no host mechanism for one — it is appended AFTER the text, the same
  // order the other three adapters use.
  //
  // A RESOURCE block has no member in that union, and there is nothing to
  // enable: inventing an encoding (a data: URI, a JSON dump in the text) would
  // put a second truth beside MCP's own shape for a block no shipped tool
  // returns yet. So it rides the details sidecar `structuredContent` already
  // uses — visible in logs and to the renderer, never silently dropped, and
  // ready to move into `content` the day Pi's union grows a member for it.
  const extra = result.extraContent ?? [];
  const images = extra.filter((block): block is ProxyImageContent => block.type === 'image');
  const resources = extra.filter((block): block is ProxyResourceContent => block.type === 'resource');
  if (resources.length > 0) {
    details.extraContent = resources;
  }

  return {
    content: [{ type: 'text', text: result.content }, ...images],
    details,
  };
}
