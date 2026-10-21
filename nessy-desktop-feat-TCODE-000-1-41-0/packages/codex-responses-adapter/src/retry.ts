/**
 * Retry ladder for the gateway's flaky tool parser. The gateway
 * non-deterministically 400s tool requests with the misleading text
 * `"model is required"` (00-context). On exactly that signal we retry with
 * progressive tool-schema simplification; any other 4xx/5xx surfaces
 * immediately. Cap: 3 attempts total.
 *
 * Rungs:
 *   0. as-is (already tool_choice-free)
 *   1. drop every `parameters.required` (incl. nested)
 *   2. also blank tool + parameter `description` fields
 *
 * The ladder is upstream-agnostic: `opts` (a `PostChatOptions`) carries the
 * `upstream` target, so every rung re-posts to the SAME endpoint with the SAME
 * mode-scoped auth. Against a non-gateway upstream the ladder is inert — only
 * the gateway emits the `"model is required"` 400 that advances it.
 */
import { postChat, type PostChatOptions } from './nestor-client.ts';
import type { ChatRequest } from './to-chat.ts';

export interface RetryOutcome {
  response: Response;
  /** 0-based rung that produced this response (for the Phase 7 success-rate eval). */
  rung: number;
}

const MODEL_REQUIRED = /model is required/i;

type ParamObj = Record<string, unknown>;

/** Recursively delete `required` arrays from a JSON-schema-ish object. */
function deleteRequired(node: unknown): void {
  if (Array.isArray(node)) {
    for (const el of node) deleteRequired(el);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as ParamObj;
    delete obj.required;
    for (const v of Object.values(obj)) deleteRequired(v);
  }
}

/** Recursively blank `description` fields in a JSON-schema-ish object. */
function blankDescriptions(node: unknown): void {
  if (Array.isArray(node)) {
    for (const el of node) blankDescriptions(el);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as ParamObj;
    if (typeof obj.description === 'string') delete obj.description;
    for (const v of Object.values(obj)) blankDescriptions(v);
  }
}

function withoutRequired(body: ChatRequest): ChatRequest {
  const clone = structuredClone(body);
  for (const tool of clone.tools ?? []) deleteRequired(tool.function.parameters);
  return clone;
}

function withoutDescriptions(body: ChatRequest): ChatRequest {
  const clone = withoutRequired(body);
  for (const tool of clone.tools ?? []) {
    delete (tool.function as ParamObj).description;
    blankDescriptions(tool.function.parameters);
  }
  return clone;
}

export async function sendWithRetry(body: ChatRequest, opts: PostChatOptions): Promise<RetryOutcome> {
  const rungs: ChatRequest[] = [body, withoutRequired(body), withoutDescriptions(body)];
  let last: Response | null = null;
  for (let rung = 0; rung < rungs.length; rung++) {
    const rungBody = rungs[rung];
    if (!rungBody) continue;
    const response = await postChat(rungBody, opts);
    last = response;
    if (response.ok) return { response, rung };
    if (response.status === 400) {
      const text = await response.clone().text();
      if (MODEL_REQUIRED.test(text) && rung < rungs.length - 1) {
        continue; // advance the ladder
      }
    }
    // Non-flaky error, or ladder exhausted: surface this response.
    return { response, rung };
  }
  // Unreachable (rungs is non-empty), but satisfy the type checker.
  return { response: last as Response, rung: rungs.length - 1 };
}
