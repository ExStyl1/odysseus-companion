/**
 * Typed errors for better error handling and user-friendly messages.
 *
 * These error types map HTTP status codes and error patterns to
 * actionable error information that can be displayed to users.
 *
 * The `ErrorCode` union is owned by `@nessy-agent/core` so the wire
 * format (which crosses package boundaries) stays in one place; this
 * file owns the user-facing text and recovery actions for each code.
 */

import type { ErrorCode } from '@nessy-agent/core/types';
import { getProviderMetadata } from '../config/provider-metadata.ts';
import { IMAGE_REFUSAL_DETAIL_PREFIX, isNamedImageRefusal } from '../config/llm-connections.ts';

export type { ErrorCode };

/** Provider info attached to errors for user-facing context */
export interface ProviderInfo {
  name: string;
  statusPageUrl?: string;
  dashboardUrl?: string;
}

export interface RecoveryAction {
  /** Keyboard shortcut (single letter) */
  key: string;
  /** Description of the action */
  label: string;
  /** Slash command to execute (e.g., '/settings') */
  command?: string;
  /**
   * Custom action type for special handling.
   *
   * D1.293 — this union had a fifth member with no producer and no handler; it
   * is retired, together with the `sourceSlug` field that existed only for it.
   * The reasoning is on the wire twin in `packages/core/src/types/message.ts`,
   * which this shape is copied to by the renderer's event processor.
   */
  action?: 'retry' | 'settings' | 'reauth' | 'open_url';
  /** URL to open (for 'open_url' action) */
  url?: string;
}

export interface AgentError {
  /** Error code for programmatic handling */
  code: ErrorCode;
  /** User-friendly title */
  title: string;
  /** Detailed message explaining what went wrong */
  message: string;
  /** Suggested recovery actions */
  actions: RecoveryAction[];
  /** Whether auto-retry is possible */
  canRetry: boolean;
  /** Retry delay in ms (if canRetry is true) */
  retryDelayMs?: number;
  /** Original error message for debugging */
  originalError?: string;
  /** Diagnostic check results for debugging */
  details?: string[];
  /** Provider info for user-facing context */
  providerInfo?: ProviderInfo;
}

/**
 * D1.283 — EVERY action here carries an `action` the renderer can execute, and
 * `errors.test.ts` holds that as a guard.
 *
 * `token_expired` and `mcp_auth_required` declared `command: '/workspace'` and
 * no `action`. Two things were wrong with it and only the first had been seen:
 * the wire's `errorActions` shape dropped `command` at the mapper, so the
 * button arrived carrying nothing but a label; and `/workspace` is a command
 * this product does not have — it appears in no `SlashCommandId`, in no
 * `parseSessionCommand` branch, and in no handler — so carrying the field would
 * only have delivered a button that dispatched a slash command nobody
 * implements. (D1.233 met the same class in the CLI, where a notice named two
 * flags the parser rejects.) `command` is now carried BECAUSE the wire declared
 * it and silently dropping a declared field is its own defect, and both actions
 * name the destination the product really has. For `token_expired` D1.194's
 * card replaces this action anyway, so that error still shows ONE button.
 */

/**
 * Error definitions with user-friendly messages and recovery actions
 */
const ERROR_DEFINITIONS: Record<ErrorCode, Omit<AgentError, 'code' | 'originalError' | 'details'>> = {
  invalid_api_key: {
    title: 'Invalid API Key',
    message: 'Your API key was rejected. It may be invalid or expired.',
    actions: [
      { key: 's', label: 'Update API key', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  invalid_credentials: {
    title: 'Invalid Credentials',
    message: 'Your API key or OAuth token is missing or invalid.',
    actions: [
      { key: 's', label: 'Update credentials', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  // response_too_large is set by the UI tool-result handler; parseError
  // never produces it, but the union requires a definition entry.
  response_too_large: {
    title: 'Response Too Large',
    message: 'The tool response was too large to display inline. The full output has been saved to disk.',
    actions: [],
    canRetry: false,
  },
  expired_oauth_token: {
    title: 'Session Expired',
    message: 'Your session has expired. Please try signing in again.',
    actions: [
      { key: 'r', label: 'Re-authenticate', action: 'reauth' },
      { key: 's', label: 'Switch API setup', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  token_expired: {
    title: 'Workspace Session Expired',
    message: 'Your workspace authentication has expired. Please re-authenticate the workspace.',
    actions: [
      { key: 'w', label: 'Re-authenticate the workspace', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  rate_limited: {
    title: 'Rate Limited',
    message: 'Rate limit reached. Wait a moment, then retry.', // F1.1090 — nothing auto-retries: Retry is a click
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 5000,
  },
  service_error: {
    title: 'Service Error',
    message: 'The AI service is temporarily unavailable. This usually resolves on its own.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  service_unavailable: {
    title: 'Service Unavailable',
    message: 'The AI service is experiencing issues. All credentials appear valid. Try again in a moment.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  network_error: {
    title: 'Connection Error',
    message: 'Could not reach the AI service. Check your internet connection or VPN settings.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 1000,
  },
  proxy_error: {
    title: 'Network Proxy Error',
    message: 'A proxy, firewall, or captive portal intercepted the API request and returned an HTML page instead of the expected response.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
      { key: 's', label: 'Check proxy settings', command: '/settings', action: 'settings' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  mcp_auth_required: {
    title: 'Workspace Authentication Required',
    message: 'Your workspace connection needs to be re-authenticated.',
    actions: [
      { key: 'w', label: 'Re-authenticate the workspace', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  mcp_unreachable: {
    title: 'MCP Server Unreachable',
    message: 'Cannot connect to the Nessy MCP server. Check your network connection.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 2000,
  },
  billing_error: {
    title: 'Payment Required',
    message: 'Your account has a billing issue. Check your provider account status.',
    actions: [
      { key: 's', label: 'Update credentials', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  model_no_tool_support: {
    title: 'Model Does Not Support Tools',
    message: 'The selected model does not support tool/function calling, which is required for Nessy Desktop. Please choose a model with tool support (e.g., Claude, GPT-4, Gemini).',
    actions: [
      { key: 's', label: 'Change model', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  invalid_model: {
    title: 'Invalid Model',
    message: 'The selected model was not found. Please check your model configuration in settings.',
    actions: [
      { key: 's', label: 'Change model', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  data_policy_error: {
    title: 'Data Policy Restriction',
    message: 'OpenRouter blocked this request due to your data policy settings. Configure your privacy settings at openrouter.ai/settings/privacy to allow this model.',
    actions: [
      { key: 's', label: 'Open Settings', command: '/settings', action: 'settings' },
    ],
    canRetry: false,
  },
  invalid_request: {
    title: 'Invalid Request',
    message: 'The API rejected this request.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
  },
  image_too_large: {
    title: 'Image Too Large',
    message: 'The image exceeds API limits (max 8000px or 5MB). Please resize or use a smaller image.',
    actions: [],
    canRetry: false,
  },
  provider_error: {
    title: 'AI Provider Error',
    message: 'The AI provider is experiencing issues. This usually resolves on its own — retry in a moment.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 5000,
  },
  queued_message_replay_failed: {
    title: 'Queued message could not be sent',
    message: 'A message you sent while the agent was running could not be re-sent automatically. Tap retry to send it now.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
  },
  sdk_binary_missing: {
    title: 'Claude Code binary missing from app bundle',
    message:
      'The Claude Agent SDK binary expected on disk is not present. ' +
      'This usually means the app bundle is incomplete (interrupted download, partial update, ' +
      'or a security tool removed it). Reinstalling Nessy Desktop typically fixes this.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 1000,
  },
  sdk_cwd_missing: {
    title: 'Branch source unavailable on this machine',
    message:
      "The folder this branched session was forked from doesn't exist on this machine. " +
      'This typically happens after importing a session from another workspace. ' +
      'Retrying will start a fresh fork from a summary of the parent conversation.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
    retryDelayMs: 1000,
  },
  unknown_error: {
    title: 'Error',
    message: 'Something went wrong. If this persists, check the provider status page or retry.',
    actions: [
      { key: 'r', label: 'Retry', action: 'retry' },
    ],
    canRetry: true,
  },
};

/**
 * Extract all error messages from an error object, including nested causes.
 */
function extractErrorMessages(error: unknown): string {
  const messages: string[] = [];

  if (error instanceof Error) {
    messages.push(error.message);

    // Check for nested cause (ES2022 Error.cause)
    if ('cause' in error && error.cause) {
      messages.push(extractErrorMessages(error.cause));
    }

    // Check for stdout/stderr (common in subprocess errors)
    const anyError = error as unknown as Record<string, unknown>;
    if (typeof anyError.stdout === 'string') messages.push(anyError.stdout);
    if (typeof anyError.stderr === 'string') messages.push(anyError.stderr);
    if (typeof anyError.output === 'string') messages.push(anyError.output);
  } else {
    messages.push(String(error));
  }

  return messages.join(' ');
}

const HTML_DOC_HINTS = ['<html', '<!doctype html', '<head', '<body', '<title', '<h1'] as const;
const HTML_PROXY_HINTS = [
  'cloudflare',
  'cf-ray',
  'captcha',
  'security check',
  'access denied',
  'attention required',
  'web application firewall',
  'waf',
  'proxy authentication required',
  'sucuri',
  'imperva',
  'akamai',
] as const;
const HTML_STATUS_PATTERN = /\b(400|401|403|407|408|409|429|500|502|503|504)\b/;

function looksLikeHtmlPayload(textLower: string): boolean {
  if (textLower.includes('<!doctype html') || textLower.includes('<html')) {
    return true;
  }

  let hintCount = 0;
  for (const hint of HTML_DOC_HINTS) {
    if (textLower.includes(hint)) hintCount++;
  }

  return hintCount >= 3;
}

function hasHtmlErrorPageSignals(textLower: string): boolean {
  const hasKnownHttpTitle =
    textLower.includes('bad request') ||
    textLower.includes('unauthorized') ||
    textLower.includes('forbidden') ||
    textLower.includes('service unavailable') ||
    textLower.includes('bad gateway') ||
    textLower.includes('gateway timeout') ||
    textLower.includes('proxy authentication required');

  return HTML_STATUS_PATTERN.test(textLower) && hasKnownHttpTitle;
}

function isLikelyProxyInterception(textLower: string): boolean {
  if (textLower.includes('unexpected html error page') || textLower.includes('network proxy')) {
    return true;
  }

  if (!looksLikeHtmlPayload(textLower)) {
    return false;
  }

  if (HTML_PROXY_HINTS.some((hint) => textLower.includes(hint))) {
    return true;
  }

  return hasHtmlErrorPageSignals(textLower);
}

function buildProxyErrorMessage(errorMessage: string, fullErrorText: string): string {
  const lowerErrorMessage = errorMessage.toLowerCase();
  if (!looksLikeHtmlPayload(lowerErrorMessage)) {
    // Interceptor-produced proxy messages are already user-safe and actionable.
    return errorMessage;
  }

  const details: string[] = [];
  const statusMatch = fullErrorText.match(HTML_STATUS_PATTERN);
  if (statusMatch?.[1]) {
    details.push(`HTTP ${statusMatch[1]}`);
  }
  if (fullErrorText.toLowerCase().includes('cloudflare')) {
    details.push('Cloudflare');
  }

  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `Received an unexpected HTML error page${suffix} instead of a JSON API response. This is usually caused by a proxy, firewall, or captive portal intercepting the request. Check your proxy settings in Settings > Network.`;
}

/**
 * F1.932 — A QUOTA REFUSAL IS NOT A RATE LIMIT, and the runtime already knows it.
 *
 * The gateway answers a spent token quota with `429 insufficient_quota`
 * (SIT-ag, 2026-09-25: `лимит токенов исчерпан`). Every 429 used to land in
 * `rate_limited`, whose copy said "Will auto-retry shortly." Nothing retried:
 * the Pi SDK declines on purpose. pi-ai's `isRetryableAssistantError`
 * (`@earendil-works/pi-ai` `dist/utils/retry.js`) checks
 * `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` BEFORE its retryable set, and
 * that list carries `insufficient_quota` and `quota exceeded` under its own
 * heading "Generic quota/budget/billing exhaustion". The codex route splits it
 * too: `classifyError` in `codex-responses-adapter/src/errors.ts` (vendored from
 * opencodex) tests the quota phrases BEFORE `status === 429`. So the host was
 * the only layer promising a retry. It now repeats the runtime's verdict.
 *
 * The phrases are the union of those two sources, which is how this set
 * was chosen: codex's quota table (`insufficient_quota`, `exceeded your
 * current quota`, `quota exhausted`, and three `… quota exceeded` variants that
 * `quota exceeded` covers) and pi-ai's two quota entries. pi-ai's broader
 * entries (`billing`, `out of budget`, subscription limits) are left alone:
 * they are not quota wording, and `billing` already has `billing_error`.
 * `errors-insufficient-quota.test.ts` pins that pi-ai itself declines to retry
 * the quota shape and still retries a plain 429, so a lift that moves either
 * half is caught.
 *
 * WHY THE CODE STAYS `rate_limited`: this is the choice with the smaller
 * surface, and it is written down here. The documented `StopFailure` vocabulary
 * has no quota value (`automations/utils.ts`, `STOP_FAILURE_DOCUMENTED_ERROR`).
 * Codex already reports its usage limit there as `rate_limit`
 * (`codex-agent.ts`, `usageLimitExceeded: 'rate_limit'`), so a hook matcher
 * keeps meeting the same word. The fallback-model chain excludes the code, as
 * `model-config.md#fallback-model-chains` excludes rate-limit and billing.
 * `account_on_hold` is the precedent for this shape: it keeps `billing_error`
 * and gets its own copy. What changes is what the user reads:
 * no auto-retry promise, `canRetry: false`, no `retryDelayMs`. A manual Retry
 * stays, because this gateway's quota resets (a resend a minute later worked).
 * That action is `retry`, which the renderer runs only on a click
 * (`handleErrorMessageAction`); D1.283's census reads `ERROR_DEFINITIONS` only,
 * so it does not see this definition, and `retry` is one it already allows.
 */
const QUOTA_EXHAUSTED_DEFINITION: Omit<AgentError, 'code' | 'originalError' | 'details'> = {
  title: 'Quota Exhausted',
  message: 'The provider reports that the quota for this model or account is used up, so the request was refused. Switch to another model, or wait for the quota to reset and send the message again.',
  actions: [
    { key: 'r', label: 'Retry', action: 'retry' },
  ],
  canRetry: false,
};

const QUOTA_EXHAUSTED_PHRASES = [
  'insufficient_quota',
  'exceeded your current quota',
  'quota exhausted',
  'quota exceeded',
] as const;

/** F1.932 — true when provider error text names a spent quota (see above). */
export function isQuotaExhaustedText(text: string): boolean {
  const lower = text.toLowerCase();
  return QUOTA_EXHAUSTED_PHRASES.some(phrase => lower.includes(phrase));
}

/**
 * P3.138 — THE ENDPOINT'S OWN SENTENCE, for the `invalid_request` branch.
 *
 * ## What was wrong
 *
 * The owner ruling of 2026-08-28 — *carry the modality faithfully, let the
 * ENDPOINT refuse* — holds only while the refusal stays LEGIBLE, and the third
 * arm was measured failing (W3-h, 2026-09-03, `pi-image-refusal-legibility.test.ts`).
 * On Pi the gateway refuses an image with
 * `Invalid Chat Message Part: Model Does Not Support Image Inputs`; this
 * function classified it `invalid_request` — correctly — and then replaced its
 * words, so the user read `Invalid Request: The API rejected this request.`,
 * which is true of every 400 ever sent and tells them nothing about what the
 * policy actually refused.
 *
 * ## Why `details` and NOT the message
 *
 * Read rather than invented: the SIBLING ARM already solved this and its shape
 * is the one to match. `mapClaudeSdkAssistantError`'s `invalid_request` case
 * keeps the very same generic message and puts the upstream sentence in
 * `details`, as `API message: <sentence>` (`buildApiDetails`). Copying that
 * prefix verbatim is the point of the change: the two arms then say the same
 * thing in the same field in the same words, which is what "the refusal stays
 * legible on all three arms" means. Overriding `message` here — the treatment
 * `proxy_error` and `model_no_tool_support` get a few lines below — would make
 * Pi LOUDER than claude and re-open the asymmetry from the other side.
 *
 * ## Nothing new crosses to the user
 *
 * This is a legibility change, not a disclosure one. The raw text is ALREADY on
 * the same screen: `originalError` is carried to the renderer and
 * `ChatDisplay`'s error card renders it as `Raw: …` inside the same collapsed
 * technical-details section this detail line lands in. The sentence moves from
 * an unnamed truncated dump into a named line; no field gains a reader it did
 * not have.
 *
 * That is also why the cap is 200 characters and not a number of this
 * function's own choosing: `ChatDisplay` truncates the `Raw:` line at exactly
 * 200, so a longer detail line would print more of the payload than the panel
 * beside it already does.
 *
 * ## The two guards, and why each is here
 *
 * HTML is refused (`looksLikeHtmlPayload`, the same predicate `proxy_error`
 * uses): a captive-portal page reaching this branch would otherwise put markup
 * in a details line. Most such payloads are caught by
 * `isLikelyProxyInterception` several branches earlier, so this is the residue
 * rather than the primary defence. And a sentence identical to the generic
 * definition message is dropped, so the panel never says the same thing twice.
 *
 * RESIDUE, recorded rather than assumed closed: `packages/ui`'s `SessionViewer`
 * renders NEITHER `errorDetails` nor `errorOriginal`, so on that surface this
 * refusal is still invisible — but so is claude's, and so is every other typed
 * error's. That is one surface missing the disclosure for all arms, not a
 * per-arm asymmetry, and it is a different repair from this one.
 */
function extractApiMessage(errorMessage: string, fullErrorText: string): string | undefined {
  const fromEnvelope = (): string | undefined => {
    const start = fullErrorText.indexOf('{');
    const end = fullErrorText.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      const parsed: unknown = JSON.parse(fullErrorText.slice(start, end + 1));
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      // Two wire shapes, both real: OpenAI-style `{ message, type, code }` (what
      // the gateway returns and pi-ai forwards) and Anthropic-style
      // `{ type: 'error', error: { type, message } }`.
      const flat = (parsed as { message?: unknown }).message;
      if (typeof flat === 'string' && flat.trim()) return flat.trim();
      const nested = (parsed as { error?: { message?: unknown } }).error?.message;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    } catch {
      // Not JSON, or a payload with braces in it. The prefix strip below is the
      // fallback; a throw here would lose the whole detail line for a formatting
      // difference.
    }
    return undefined;
  };

  // `<status>: <body>` and `<status> <body>` are both produced upstream —
  // pi-ai's `formatProviderError` uses the first, the Anthropic-style raw text
  // the second — and neither prefix belongs in a line labelled `API message`.
  const candidate = fromEnvelope()
    ?? errorMessage.trim().replace(/^\d{3}\s*:?\s*/, '').trim();

  if (!candidate) return undefined;
  if (looksLikeHtmlPayload(candidate.toLowerCase())) return undefined;
  if (candidate === ERROR_DEFINITIONS.invalid_request.message) return undefined;
  return candidate.length > 200 ? `${candidate.slice(0, 200)}...` : candidate;
}

/**
 * D1.283 — every code's recovery actions, read-only, for the guard that holds
 * each of them executable by the renderer.
 *
 * `ERROR_DEFINITIONS` stays private: this is the one accessor, it copies
 * nothing and answers pairs so a census can name the code beside the action it
 * found. The guard lives in `__tests__/errors.test.ts`.
 */
export function allErrorRecoveryActions(): ReadonlyArray<readonly [ErrorCode, readonly RecoveryAction[]]> {
  return Object.entries(ERROR_DEFINITIONS).map(
    ([code, definition]) => [code as ErrorCode, definition.actions] as const,
  );
}

/**
 * Parse an error and return a typed AgentError with user-friendly info
 */
export function parseError(
  error: unknown,
  providerContext?: { providerType?: string; piAuthProvider?: string },
): AgentError {
  // Extract all error messages including nested causes and subprocess output
  const fullErrorText = extractErrorMessages(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = fullErrorText.toLowerCase();

  // Detect error type from message/status
  let code: ErrorCode = 'unknown_error';
  let quotaExhausted = false;

  // Check for OpenRouter data policy errors first (these contain "no endpoints" which could confuse other checks)
  if (lowerMessage.includes('data policy') || lowerMessage.includes('privacy')) {
    code = 'data_policy_error';
  // Check for model-specific errors (OpenRouter, etc.)
  // Tool support errors must be checked BEFORE model errors since tool errors often contain "model"
  } else if (
    lowerMessage.includes('no endpoints found that support tool use') ||
    lowerMessage.includes('does not support tool') ||
    lowerMessage.includes('tool_use is not supported') ||
    lowerMessage.includes('function calling not available') ||
    lowerMessage.includes('tools are not supported') ||
    lowerMessage.includes('doesn\'t support tool') ||
    lowerMessage.includes('tool use is not supported')
    // NOTE: do NOT match on `invalid_request_error + tool` or `tool + not + support`
    // alone. Anthropic 400 errors frequently mention `tools` (e.g. the cache_control
    // ordering error "blocks are processed in the following order: `tools`, `system`,
    // `messages`") which would otherwise be misclassified as "Model Does Not Support
    // Tools". The specific phrases above are tight enough to catch real tool-support
    // refusals without these broad fallbacks.
  ) {
    code = 'model_no_tool_support';
  } else if (lowerMessage.includes('is not a valid model') || lowerMessage.includes('model not found') || lowerMessage.includes('invalid model') || lowerMessage.includes('model identifier is invalid')) {
    code = 'invalid_model';
  // HTML-intercepted responses (proxy/firewall/captive portal).
  // Must be checked BEFORE status codes: a 502 Cloudflare page or 401 proxy login
  // page would otherwise be misclassified as service_error or invalid_api_key.
  } else if (isLikelyProxyInterception(lowerMessage)) {
    code = 'proxy_error';
  // F1.932 — a named quota refusal comes before the bare-digit status checks
  // below (`includes('402')` / `('401')` also match digits inside a JSON body),
  // and it must come before the 429 branch. See `QUOTA_EXHAUSTED_DEFINITION`.
  } else if (isQuotaExhaustedText(lowerMessage)) {
    code = 'rate_limited';
    quotaExhausted = true;
  // Check for specific HTTP status codes or patterns
  } else if (lowerMessage.includes('402') || lowerMessage.includes('payment required')) {
    code = 'billing_error';
  } else if (lowerMessage.includes('401') || lowerMessage.includes('unauthorized') || lowerMessage.includes('invalid api key') || lowerMessage.includes('invalid x-api-key') || lowerMessage.includes('authentication failed') || lowerMessage.includes('token is expired') || lowerMessage.includes('token expired')) {
    // Distinguish between API key and OAuth errors
    if (lowerMessage.includes('oauth') || lowerMessage.includes('token') || lowerMessage.includes('session')) {
      code = 'expired_oauth_token';
    } else {
      code = 'invalid_api_key';
    }
  } else if (lowerMessage.includes('429') || lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    code = 'rate_limited';
  } else if (lowerMessage.includes('500') || lowerMessage.includes('502') || lowerMessage.includes('503') || lowerMessage.includes('504') || lowerMessage.includes('529') || lowerMessage.includes('internal server error') || lowerMessage.includes('service unavailable') || lowerMessage.includes('overloaded')) {
    code = 'service_error';
  } else if (lowerMessage.includes('network') || lowerMessage.includes('econnrefused') || lowerMessage.includes('enotfound') || lowerMessage.includes('fetch failed') || lowerMessage.includes('connection')) {
    code = 'network_error';
  } else if (lowerMessage.includes('mcp') && (lowerMessage.includes('auth') || lowerMessage.includes('401'))) {
    code = 'mcp_auth_required';
  } else if (
    lowerMessage.includes('image') &&
    (lowerMessage.includes('dimension') || lowerMessage.includes('8000') || lowerMessage.includes('5mb')) &&
    (lowerMessage.includes('exceed') || lowerMessage.includes('too large'))
  ) {
    code = 'image_too_large';
  } else if (lowerMessage.includes('exited with code') || lowerMessage.includes('process exited')) {
    // SDK subprocess crashed - likely auth/setup issue
    // Check if the error contains more specific info
    if (lowerMessage.includes('api') || lowerMessage.includes('key') || lowerMessage.includes('credential')) {
      code = 'invalid_api_key';
    } else {
      code = 'service_error';
    }
  } else if (lowerMessage.includes('invalid_request_error') || lowerMessage.includes('400 ')) {
    // Generic Anthropic-style API validation failures (cache_control ordering, malformed
    // payloads, etc.). Lands here only after all the more specific branches above have
    // declined; better than falling through to "unknown_error" which hides the message.
    code = 'invalid_request';
  }

  // ErrorCode is a finite union and ERROR_DEFINITIONS covers every member,
  // so the lookup is exhaustive — non-null assert to satisfy the
  // noUncheckedIndexedAccess compiler option after the cross-module import.
  const definition = ERROR_DEFINITIONS[code]!;

  // Resolve provider info from context
  const providerInfo = providerContext
    ? getProviderMetadata(
        providerContext.providerType ?? 'anthropic',
        providerContext.piAuthProvider,
      ) ?? undefined
    : undefined;

  // F1.932 — the quota copy, with the endpoint's own sentence in `details` the
  // way P3.138 carries it, so the user also reads the provider's words.
  if (quotaExhausted) {
    const apiMessage = extractApiMessage(errorMessage, fullErrorText);
    return {
      code,
      ...QUOTA_EXHAUSTED_DEFINITION,
      ...(apiMessage ? { details: [`API message: ${apiMessage}`] } : {}),
      originalError: errorMessage,
      providerInfo,
    };
  }

  // For proxy_error, prefer safe user-facing text over raw HTML payloads.
  if (code === 'proxy_error') {
    return {
      code,
      ...definition,
      message: buildProxyErrorMessage(errorMessage, fullErrorText),
      originalError: errorMessage,
      providerInfo,
    };
  }

  // P3.138 — the endpoint's own words, in the field claude's arm already uses.
  // See `extractApiMessage` for why this is `details` and not a message override.
  if (code === 'invalid_request') {
    const apiMessage = extractApiMessage(errorMessage, fullErrorText);
    if (apiMessage) {
      return {
        code,
        ...definition,
        // P6.707 — the SAME anchor `mapClaudeSdkAssistantError` writes, so the
        // learned image-refusal seam is uniform on Pi and codex instead of
        // claude-only. This is the turn-error path both of the other runtimes
        // take, and the refusal it matches is the ENDPOINT's, not a runtime's:
        // the gateway's `Model Does Not Support Image Inputs` arrives the same
        // way whichever binary asked for it. Anchored INSTEAD of the generic
        // prefix, never beside it — P3.138's rule that the panel never says the
        // same thing twice. Every other message, a generic 400 included, keeps
        // the branch it always took, which is what owner Q12's "never on a
        // generic 400" means here.
        details: [isNamedImageRefusal(apiMessage)
          ? `${IMAGE_REFUSAL_DETAIL_PREFIX}${apiMessage}`
          : `API message: ${apiMessage}`],
        originalError: errorMessage,
        providerInfo,
      };
    }
  }

  // For model_no_tool_support errors, try to extract the model name for a more helpful message
  if (code === 'model_no_tool_support') {
    // Try to extract model name from various error message formats
    // Common patterns: "model: xxx", "model 'xxx'", "model \"xxx\"", "model xxx does not"
    const modelMatch = fullErrorText.match(/model[:\s]+["']?([a-zA-Z0-9\-_/:.]+)["']?/i) ||
                       fullErrorText.match(/["']([a-zA-Z0-9\-_/:.]+)["']\s+does not support/i);
    if (modelMatch?.[1]) {
      return {
        code,
        ...definition,
        message: `Model "${modelMatch[1]}" does not support tool/function calling, which is required for Nessy Desktop. Please choose a different model with tool support in Settings.`,
        originalError: errorMessage,
        providerInfo,
      };
    }
  }

  return {
    code,
    ...definition,
    originalError: errorMessage,
    providerInfo,
  };
}

/**
 * Build a typed {@link AgentError} for a code the caller has already
 * determined, e.g. when a backend-specific classifier (the Pi SDK's
 * `isRetryableAssistantError`) recognizes a transient failure that
 * {@link parseError}'s generic text matching does not.
 *
 * Same shape as a `parseError` result: user-facing text and recovery actions
 * come from `ERROR_DEFINITIONS`, the raw provider text is kept in
 * `originalError` for diagnostics. F1.350 — ported verbatim from
 * craft-agents-oss v0.13.3 (`packages/shared/src/agent/errors.ts`, Apache-2.0).
 */
export function createAgentError(
  code: ErrorCode,
  originalError?: string,
  providerContext?: { providerType?: string; piAuthProvider?: string },
): AgentError {
  const definition = ERROR_DEFINITIONS[code]!;
  const providerInfo = providerContext
    ? getProviderMetadata(
        providerContext.providerType ?? 'anthropic',
        providerContext.piAuthProvider,
      ) ?? undefined
    : undefined;
  return {
    code,
    ...definition,
    originalError,
    providerInfo,
  };
}

/**
 * Check if an error is a billing/auth error that blocks usage
 */
export function isBillingError(error: AgentError): boolean {
  return error.code === 'billing_error' || error.code === 'invalid_api_key' || error.code === 'expired_oauth_token';
}

/**
 * Check if an error can be automatically retried
 */
export function canAutoRetry(error: AgentError): boolean {
  return error.canRetry && error.retryDelayMs !== undefined;
}

/**
 * Parse SDK error text and return a typed AgentError if detected.
 *
 * The SDK emits errors in two distinctive formats:
 * 1. "Error title · Action hint" - using middle dot (·, U+00B7) separator
 *    e.g., "Invalid API key · Fix external API key"
 * 2. "API Error: {status} {json}" - raw API error dump
 *    e.g., "API Error: 402 {"error":{"code":402,"message":"Payment required"}}"
 *
 * Returns null if text is not an SDK error.
 */
export function parseSDKErrorText(text: string): AgentError | null {
  const trimmed = text.trim();
  const isSingleLine = !trimmed.includes('\n');
  const isShortMessage = trimmed.length < 200;

  // Format 1: Raw API error (e.g., "API Error: 402 {...}")
  // Extract status code and use it to determine error type
  if (trimmed.startsWith('API Error:') && isSingleLine) {
    const statusMatch = trimmed.match(/API Error:\s*(\d{3})/);
    if (statusMatch) {
      const statusCode = parseInt(statusMatch[1]!, 10);
      // Create error message with status code for parseError to detect
      return parseError(new Error(`${statusCode} ${trimmed}`));
    }
    // Fallback: just use the raw message
    return parseError(new Error(trimmed));
  }

  // Format 2: Middle dot separator (e.g., "Invalid API key · Fix external API key")
  if (trimmed.includes(' · ') && isShortMessage && isSingleLine) {
    // The text before · is the error title, use it for parsing
    return parseError(new Error(trimmed));
  }

  return null;
}

/**
 * Quick check if text looks like an SDK error (for filtering).
 */
export function isSDKErrorText(text: string): boolean {
  return parseSDKErrorText(text) !== null;
}
