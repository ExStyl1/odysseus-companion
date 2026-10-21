/**
 * Unified fetch interceptor for AI API requests (Anthropic + OpenAI format).
 *
 * **"all" was wrong, and in the direction that misleads.** Measured 2026-09-04:
 * this is preloaded into the **Pi subprocess only**. The Claude SDK stopped
 * running under Bun at 0.2.113 (it spawns a per-platform native binary), so
 * `--preload` is not available there and `drivers/anthropic.ts` sets up no
 * preload of any kind; codex runs its own binary. `packages/shared/AGENTS.md`
 * already says so — this header did not, and a reader composing an error-capture
 * or metadata story from it would have assumed three runtimes where there is one.
 *
 * Loaded via --preload (Bun) or --require (Node) into the Pi subprocess and,
 * additionally, into the headless server's own process by `bin/nessy-server`.
 * Patches globalThis.fetch before any SDK captures it.
 *
 * Features:
 * - Adds _intent and _displayName metadata to all tool schemas (request)
 * - Re-injects stored metadata into conversation history (request)
 * - Processes SSE response streams per API format:
 *   - Anthropic: STRIPS metadata from stream (SDK validates immediately)
 *   - OpenAI: CAPTURES metadata passthrough (hook strips before execution)
 * - Captures API errors (4xx/5xx) for error handler
 * - Fast mode support for Anthropic (Opus 4.7)
 *
 * Auto-detects API format based on request URL:
 * - Anthropic: baseUrl + /messages
 * - OpenAI: /chat/completions
 */

import { readFileSync, statSync } from 'node:fs';
// Shared infrastructure (toolMetadataStore, error capture, logging, config)
import {
  DEBUG,
  debugLog,
  // UB1.10 — the body opt-in and its cap (upstream v0.13.6 #1033).
  DEBUG_FULL_BODIES,
  MAX_LOGGED_BODY_CHARS,
  isRichToolDescriptionsEnabled,
  resolvePromptCacheTtl,
  // F1.1241 — `is1MContextEnabled` is gone with the Extended context switch.
  setStoredError,
  toolMetadataStore,
  displayNameSchema,
  intentSchema,
} from './interceptor-common.ts';
import { FEATURE_FLAGS } from './feature-flags.ts';
import { resolveRequestContext } from './interceptor-request-utils.ts';
import {
  NESTOR_CLI_BASE_PREFIX,
  NESTOR_GATEWAY_HOST,
  isNestorGatewayCredentialUrl,
} from './auth/nestor.ts';
import {
  customHeaderNames,
  customHeaders,
  gatewayCorrelationHeaders,
} from './telemetry/gateway-headers.ts';
export {
  NESTOR_CLI_BASE_PREFIX,
  NESTOR_GATEWAY_HOST,
} from './auth/nestor.ts';

// Type alias for fetch's HeadersInit
type HeadersInitType = Headers | Record<string, string> | string[][];
export type HeadersLike = HeadersInitType | undefined;

/**
 * When `NESSY_DEBUG_SSE_RAW=1`, the OpenAI strip streams dump every raw SSE
 * line they see (in) and emit (out) to interceptor.log. Used to diagnose
 * upstream SSE shape issues (e.g. DeepSeek's two-phase tool_call emission).
 * Independent of the broader DEBUG flag — opt-in only because raw chunks are
 * verbose and may contain user prompts/tool args.
 */
const DEBUG_SSE_RAW = process.env.NESSY_DEBUG_SSE_RAW === '1';

/**
 * Debug-only capture of the EXACT bytes sent upstream.
 *
 * Off unless `NESSY_WIRE_CAPTURE` names a file; there is no default path and no
 * on-by-default behaviour, because this writes a request body verbatim and a
 * request body carries the conversation.
 *
 * It exists because the accounting and the endpoint disagree about what is on
 * the wire, and the repo's own rule is that a typed field is not a filled field
 * — the only way to settle "does this text reach the model" is to read the
 * bytes that left. Reading the composer instead measures what we BELIEVE we
 * send, which is the thing in dispute.
 *
 * One JSON line per request: the URL, the byte length, and the body. Appended
 * with `\n` so a partial write cannot corrupt earlier lines, and failures are
 * swallowed — a diagnostic that can break a turn is worse than no diagnostic.
 */
function captureWireBody(url: string, body: string): void {
  const target = process.env.NESSY_WIRE_CAPTURE?.trim();
  if (!target) return;
  try {
    // Required lazily: this module preloads into the Pi subprocess and must not
    // pull `node:fs` into every run for a path nobody enabled.
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(target, `${JSON.stringify({ url, bytes: body.length, body })}\n`);
  } catch {
    // A capture that throws would turn a diagnostic into an outage.
  }
}

// ============================================================================
// PROXY CONFIGURATION (from env vars injected by parent process)
// ============================================================================

/**
 * P6.255 — the documented precedence, which this constant had upside down.
 *
 * `network-config.md`, verbatim: *"Lowercase variants also work, and Claude Code
 * uses the first one that's set in the order `https_proxy`, `HTTPS_PROXY`,
 * `http_proxy`, `HTTP_PROXY`."* The pairs were the other way up here, so a rig
 * exporting BOTH spellings routed through the UPPERCASE value on pi and codex
 * while claude's own SDK child applied the documented order — one setting, two
 * answers either side of a runtime switch, invisible from either side.
 *
 * `NO_PROXY` below is deliberately NOT reordered: the page documents both
 * spellings and states no precedence between them, so a rule here would be
 * invented rather than read. Leave it, and do not "finish" this fix.
 */
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY
  || process.env.http_proxy || process.env.HTTP_PROXY || '';
const NO_PROXY = process.env.NO_PROXY || process.env.no_proxy || '';

/**
 * Strip credentials from a proxy URL, returning only scheme://host:port.
 *
 * **The third copy of one rule, and it stays a copy — measured, not assumed
 * (P6.789).** `config/config-doctor.ts` exports the canonical `redactProxyUrl`
 * and `agent/diagnostics.ts` imports it from there; this module cannot, because
 * it is preloaded into the Pi subprocess and bundled standalone. Bundled with
 * esbuild exactly as `scripts/build-server.ts` does, 2026-09-08:
 *
 * | Bundle | Modules | Bytes |
 * | --- | ---: | ---: |
 * | this module at HEAD | 8 | 76 154 |
 * | with `import { redactProxyUrl } from './config/config-doctor.ts'` | 116 | 665 967 |
 *
 * 108 added modules — zod v4 and about forty of its locale files among them —
 * for six lines, into the module that replaces `globalThis.fetch` before
 * anything else in the subprocess evaluates. The `.ts` copy path pays for it a
 * second time: every module added here is a module `copyInterceptor`
 * (`scripts/build/common.ts`) stages and `electron-builder.yml` ships. That list
 * used to be written by hand in four packaging manifests and was two files
 * short; since P6.805/P6.820 it is DERIVED from the imports below, so the cost
 * of an import here is now automatic rather than forgotten.
 *
 * **What DID change is the fallback string.** It read `(invalid proxy URL)`
 * where both other copies read `(unparseable proxy URL)`; one rule printing two
 * words is how a reader concludes two different things happened. And the
 * divergence was not confined to a log: `config-doctor.ts`'s note calls this
 * copy's fallback "a debug-log string", and it is not — the second call site
 * below puts it in the HTML-error-page message a USER reads, so the same person
 * could meet both spellings of one condition. Aligning the word is the whole
 * change; the six lines stay here deliberately.
 *
 * Exported for its test, the way `getProxyForUrl` and `prepareOutboundHeaders`
 * already are: a copy nobody can call directly is a copy nobody can pin.
 */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '(unparseable proxy URL)';
  }
}

/**
 * Parse NO_PROXY into hostname patterns for bypass matching.
 *
 * Entries split on commas OR whitespace: network-config.md:30-33 documents
 * both spellings of the variable. This is the inline twin of
 * `config/network-proxy-utils.ts:splitNoProxyEntries` — kept inline because
 * this module is preloaded into the Pi subprocess and bundled standalone
 * (dist/interceptor.cjs); the next separator change must touch both.
 */
const noProxyPatterns: string[] = NO_PROXY
  ? NO_PROXY.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

/**
 * F1.518 — THIS machine's loopback, brackets off: the inline twin of
 * `config/network-proxy-utils.ts` `LOOPBACK_NO_PROXY_HOSTS`, kept inline for the
 * bundling reason above; `server-launcher-loopback-no-proxy.test.ts` checks every
 * spelling on that list against {@link getProxyForUrl}.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Check if a URL should bypass the proxy: loopback always, then the NO_PROXY rules.
 *
 * The loopback clause is `network-proxy-utils.ts` `shouldBypassProxy`'s (P2.263),
 * which this twin lacked (F1.518): on the headless server, launched with only
 * `HTTPS_PROXY`, the proxy was put on the server's own `http://127.0.0.1` requests,
 * which Bun alone would have sent direct.
 */
function shouldBypassProxy(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(hostname.startsWith('[') ? hostname.slice(1, -1) : hostname)) return true;
    if (noProxyPatterns.length === 0) return false;
    return noProxyPatterns.some(pattern => {
      if (pattern === '*') return true;
      // .example.com matches any subdomain of example.com
      if (pattern.startsWith('.')) return hostname.endsWith(pattern);
      // exact match or subdomain match
      return hostname === pattern || hostname.endsWith('.' + pattern);
    });
  } catch {
    return false;
  }
}

/**
 * Get the proxy URL for a given request URL, or undefined to go direct.
 *
 * EXPORTED for one reason: `PROXY_URL` above is a module-scope constant read at
 * import time, so the documented precedence it now implements cannot be asserted
 * from inside a suite that has already imported this file. The pin
 * (`__tests__/unified-network-interceptor.proxy-precedence.test.ts`) runs a
 * child with the four names set in the launch environment and calls this.
 */
export function getProxyForUrl(url: string): string | undefined {
  if (!PROXY_URL || shouldBypassProxy(url)) return undefined;
  return PROXY_URL;
}

if (PROXY_URL) {
  debugLog(`[proxy] Configured: ${redactProxyUrl(PROXY_URL)}${NO_PROXY ? `, NO_PROXY: ${NO_PROXY}` : ''}`);
}

// ============================================================================
// mTLS CLIENT IDENTITY (from env vars injected by parent process)
// ============================================================================
//
// The parent projects the documented spellings (CLAUDE_CODE_CLIENT_CERT /
// CLAUDE_CODE_CLIENT_KEY / CLAUDE_CODE_CLIENT_KEY_PASSPHRASE). The CA path
// needs no wiring here: NODE_EXTRA_CA_CERTS is honored natively by Bun and
// Node. The identity is presented through Bun's per-request `tls` fetch
// option; the files are re-read whenever their mtime changes, so replacing
// them at the same paths rotates the credential without a subprocess restart.
//
// SECURITY: never log key bytes or the passphrase. Failures are reported to
// stderr (path + errno only) — a missing identity must fail loudly, not
// silently downgrade to an unauthenticated handshake.

const CLIENT_CERT_PATH = process.env.CLAUDE_CODE_CLIENT_CERT || '';
const CLIENT_KEY_PATH = process.env.CLAUDE_CODE_CLIENT_KEY || '';
const CLIENT_KEY_PASSPHRASE = process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE || '';

type ClientTlsIdentity = { cert: string; key: string; passphrase?: string };
let cachedClientTls: { identity: ClientTlsIdentity; certMtimeMs: number; keyMtimeMs: number } | null = null;
let lastClientTlsError: string | null = null;

function getClientTlsIdentity(): ClientTlsIdentity | undefined {
  if (!CLIENT_CERT_PATH || !CLIENT_KEY_PATH) return undefined;
  try {
    const certMtimeMs = statSync(CLIENT_CERT_PATH).mtimeMs;
    const keyMtimeMs = statSync(CLIENT_KEY_PATH).mtimeMs;
    if (cachedClientTls && cachedClientTls.certMtimeMs === certMtimeMs && cachedClientTls.keyMtimeMs === keyMtimeMs) {
      return cachedClientTls.identity;
    }
    const identity: ClientTlsIdentity = {
      cert: readFileSync(CLIENT_CERT_PATH, 'utf8'),
      key: readFileSync(CLIENT_KEY_PATH, 'utf8'),
      ...(CLIENT_KEY_PASSPHRASE ? { passphrase: CLIENT_KEY_PASSPHRASE } : {}),
    };
    cachedClientTls = { identity, certMtimeMs, keyMtimeMs };
    lastClientTlsError = null;
    return identity;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== lastClientTlsError) {
      lastClientTlsError = message;
      // Reported-error contract: stderr reaches the parent's ring buffer.
      console.error(`[interceptor] mTLS client certificate could not be read; requests will NOT present a client identity: ${message}`);
    }
    return undefined;
  }
}

// ============================================================================
// API ADAPTER INTERFACE
// ============================================================================

/**
 * Adapter interface for API-format-specific behavior.
 * Each adapter handles the differences between Anthropic and OpenAI API formats.
 */
interface ApiAdapter {
  name: string;
  shouldIntercept(url: string): boolean;
  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown>;
  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown>;
  createSseProcessor(): TransformStream<Uint8Array, Uint8Array>;
  /** Whether SSE processing strips metadata (Anthropic) or passes through (OpenAI) */
  stripsSseMetadata: boolean;
  /** Optional request modifications (e.g., fast mode headers) */
  modifyRequest?(url: string, init: RequestInit, body: Record<string, unknown>): { init: RequestInit; body: Record<string, unknown> };
  /**
   * Optional pre-flight validation of the outgoing body. Adapters that opt in
   * throw {@link MalformedBodyError} when the body would cause a deterministic
   * upstream 400 (duplicate tool_call_id, missing call_id, etc.). The
   * interceptor turns the throw into a synthetic 400 response so the SDK
   * surfaces a clear error instead of dying on an opaque upstream failure.
   */
  validateOutgoingBody?(body: Record<string, unknown>): void;
}

// ============================================================================
// MALFORMED BODY ERROR
// ============================================================================

/**
 * Thrown by {@link ApiAdapter.validateOutgoingBody} when the request body would
 * be rejected by the upstream API for a structural reason we can detect locally
 * (duplicate `tool_call_id`, missing `call_id`, orphaned tool result, etc.).
 *
 * The interceptor catches this and turns it into a synthetic 400 response with
 * a structured error body that the SDK treats as a normal API error — far more
 * useful than the opaque `400 status code (no body)` users see today.
 */
export class MalformedBodyError extends Error {
  /** Stable error code for telemetry/UX */
  readonly code: 'duplicate_tool_call_id' | 'missing_tool_call_id' | 'missing_call_id' | 'orphaned_function_call_output' | 'empty_tool_name';
  /** Human-readable detail to show in logs and surface to the user */
  readonly detail: string;
  /** Adapter name (for diagnostics) */
  readonly adapter: string;

  constructor(args: {
    code: MalformedBodyError['code'];
    detail: string;
    adapter: string;
  }) {
    super(`[${args.adapter}] Outgoing body rejected: ${args.code} — ${args.detail}`);
    this.name = 'MalformedBodyError';
    this.code = args.code;
    this.detail = args.detail;
    this.adapter = args.adapter;
  }
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Inject _displayName and _intent into a tool's properties object.
 * Shared by both Anthropic and OpenAI adapters (same logic, different schema paths).
 */
function injectMetadataFields(
  properties: Record<string, unknown>,
  required: string[] | undefined,
): { properties: Record<string, unknown>; required: string[] } {
  const { _displayName, _intent, ...rest } = properties as {
    _displayName?: unknown;
    _intent?: unknown;
    [key: string]: unknown;
  };
  const newProperties = {
    _displayName: _displayName || displayNameSchema,
    _intent: _intent || intentSchema,
    ...rest,
  };
  const otherRequired = (required || []).filter(r => r !== '_displayName' && r !== '_intent');
  return { properties: newProperties, required: ['_displayName', '_intent', ...otherRequired] };
}

/**
 * Normalize a tool schema so metadata can always be injected, including zero-arg
 * tools whose schema may be `{ type: "object" }` without a `properties` key.
 *
 * Exported for focused unit tests.
 */
export function injectMetadataIntoToolSchema<T extends {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}>(
  schema: T,
): T & { properties: Record<string, unknown>; required: string[] } {
  const normalizedProperties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const normalizedRequired = Array.isArray(schema.required) ? schema.required : [];
  const result = injectMetadataFields(normalizedProperties, normalizedRequired);
  return {
    ...schema,
    properties: result.properties,
    required: result.required,
  };
}

/**
 * Extract _intent/_displayName from a parsed tool input and store in toolMetadataStore.
 * Shared by both SSE processors (Anthropic strips, OpenAI captures).
 *
 * @returns true if metadata was found and stored
 */
function captureMetadataFromInput(toolId: string, toolName: string, parsed: Record<string, unknown>): boolean {
  const intent = typeof parsed._intent === 'string' ? parsed._intent : undefined;
  const displayName = typeof parsed._displayName === 'string' ? parsed._displayName : undefined;
  if (intent || displayName) {
    toolMetadataStore.set(toolId, { intent, displayName, timestamp: Date.now() });
    debugLog(`[SSE] Stored metadata for ${toolName} (${toolId}): intent=${!!intent}, displayName=${!!displayName}`);
    return true;
  }
  return false;
}

/**
 * Best-effort regex removal of metadata fields from raw JSON string.
 * Used as fallback when JSON.parse fails — ensures _intent/_displayName
 * never leak to the SDK even with malformed JSON.
 *
 * Exported for focused unit tests.
 */
export function stripMetadataFieldsFromRawJson(json: string): string {
  return json
    .replace(/"_intent"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*/g, '')
    .replace(/"_displayName"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*/g, '')
    .replace(/,\s*}/g, '}');
}

// ============================================================================
// ANTHROPIC ADAPTER
// ============================================================================

/**
 * Get the configured API base URL at request time.
 * Reads from env var (set by auth/sessions before SDK starts) with Anthropic default fallback.
 */
function getConfiguredBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
}

const FAST_MODE_BETA = 'fast-mode-2026-02-01';

/**
 * Model families the PAGE says fast mode runs on — P6.244.
 *
 * `fast-mode.md` (re-read 2026-10-01, F1.1214): "Fast mode is supported on Opus
 * 5.5, Opus 5, and Opus 4.8. It is not available on Sonnet, Haiku, or other models."
 * and, about the id this gate used to name: "Claude Code treats Opus 4.7 like
 * any other model without fast mode support: switching to it turns fast mode
 * off. Fast mode for Opus 4.7 was deprecated on June 25, 2026, and removed on
 * July 24, 2026."
 *
 * So the previous gate (`model === 'claude-opus-4-7'`) named the ONE Opus the
 * feature was removed from. Kept as PREFIXES because ids arrive both bare
 * (`claude-opus-5`) and dated/versioned (`claude-opus-5-20260…`, `…-v1`), and
 * a bare-equality list would silently stop matching on the next dated id.
 * `unified-network-interceptor.fast-mode.test.ts` pins the list against the
 * page, so a future edit that narrows it fails rather than going quiet.
 */
const FAST_MODE_MODEL_PREFIXES = ['claude-opus-5', 'claude-opus-4-8'] as const;

/**
 * Strip cache_control from empty text blocks in API request bodies.
 *
 * The Claude Agent SDK's auto-mode classifier can assign cache_control to
 * content blocks without checking whether their text is empty. The Anthropic
 * API rejects this with "cache_control cannot be set for empty text blocks".
 *
 * Exported for focused unit tests.
 */
export function sanitizeEmptyTextCacheControl(body: Record<string, unknown>): number {
  const messages = body.messages as Array<{ content?: Array<Record<string, unknown>> }> | undefined;
  if (!messages) return 0;

  let stripped = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type === 'text' &&
        block.cache_control &&
        (typeof block.text !== 'string' || !block.text.trim())
      ) {
        delete block.cache_control;
        stripped++;
      }
    }
  }

  if (stripped > 0) {
    debugLog(`[Anthropic] Stripped cache_control from ${stripped} empty text block(s)`);
  }
  return stripped;
}

/**
 * Strip explicit TTL from all ephemeral cache_control blocks.
 *
 * When extendedPromptCache is disabled, the SDK may still send ttl: "1h"
 * natively (via prompt-caching-scope beta). This function removes the ttl
 * field so blocks fall back to the API default (5 min).
 *
 * Walks tools, system, message content, and top-level cache_control. The
 * Anthropic API processes blocks in order `tools → system → messages` and
 * rejects requests where a 1h block appears after a 5m block, so the tools
 * walk must stay in sync with the upgrade path below.
 *
 * **The stated intent, kept deliberately (C3.158).** This is step 5b of
 * `interceptor-common.ts` symbol `resolvePromptCacheTtl` — a user who turned
 * `extendedPromptCache` OFF chose the cheaper write rate, so letting the SDK's
 * own `1h` through would spend their money for them. It is a refusal, not a
 * default, which is why `5m` strips rather than writes. See
 * {@link upgradePromptCacheTtl} for the processes this binds in.
 */
function stripPromptCacheTtl(body: Record<string, unknown>): number {
  let stripped = 0;

  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const cc = tool.cache_control as Record<string, unknown> | undefined;
      if (cc?.type === 'ephemeral' && 'ttl' in cc) {
        delete cc.ttl;
        stripped++;
      }
    }
  }

  const system = body.system as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(system)) {
    for (const block of system) {
      const cc = block.cache_control as Record<string, unknown> | undefined;
      if (cc?.type === 'ephemeral' && 'ttl' in cc) {
        delete cc.ttl;
        stripped++;
      }
    }
  }

  const messages = body.messages as Array<{ content?: unknown }> | undefined;
  if (messages) {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        const cc = block.cache_control as Record<string, unknown> | undefined;
        if (cc?.type === 'ephemeral' && 'ttl' in cc) {
          delete cc.ttl;
          stripped++;
        }
      }
    }
  }

  const topLevel = body.cache_control as Record<string, unknown> | undefined;
  if (topLevel?.type === 'ephemeral' && 'ttl' in topLevel) {
    delete topLevel.ttl;
    stripped++;
  }

  if (stripped > 0) {
    debugLog(`[Anthropic] Stripped TTL from ${stripped} cache_control block(s) (extendedPromptCache=false)`);
  }
  return stripped;
}

/**
 * Upgrade all cache_control blocks from 5m (default) to 1h TTL.
 * Only active when extendedPromptCache is enabled in config.
 * When disabled, actively strips any SDK-injected TTL so blocks
 * fall back to the API default (5 min).
 *
 * Walks tools, system prompt blocks, message content blocks, and the
 * top-level cache_control field (auto-caching mode). Only upgrades blocks
 * with type: "ephemeral" — leaves other types untouched.
 *
 * The tools walk is required for correctness, not just completeness: the
 * Anthropic API processes blocks in order `tools → system → messages` and
 * rejects requests where a 1h cache_control block appears after a 5m one.
 * If we upgrade only system+messages, a 5m block on a tool (added by the
 * SDK or user) ahead of a 1h block on system produces a 400 with message
 * "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block."
 *
 * **WHERE THIS BINDS — C3.158, measured 2026-09-11, and written here because two
 * OTHER modules assert it about this one** (`interceptor-common.ts`'s
 * `PROMPT_CACHE_TTL_ENV` docblock and `__tests__/interceptor-prompt-cache-ttl.test.ts`).
 * An assertion about a different module has no guard and nothing makes the
 * falsifying edit look at it, so this is the back-pointer.
 *
 * The rewrite runs in whatever PROCESS preloads this file and never inside a
 * runtime's own child: the **Pi subprocess** (Bun `--preload` / Node `--require`,
 * `agent/backend/internal/runtime-resolver.ts` symbol `resolveInterceptorBundlePath`)
 * and the **headless server's own process**, which `bin/nessy-server` preloads
 * with the same bundle (`scripts/build/interceptor-pairing.ts` symbol
 * `interceptorPreloadFragment`). The claude native binary accepts no such flag
 * and codex runs its own binary, so neither child is patched — and the packaged
 * Electron app's main process installs nothing, which is the arm where the claude
 * runtime has exactly ONE reader.
 *
 * *"Never reaches a claude request"* is therefore one deployment too strong. On
 * the headless server a `claude-runtime` session's PASSTHROUGH hop is forwarded
 * by this process's own `fetch` — `telemetry/gateway-headers.ts` symbol
 * `gatewaySessionFetch` defaults its `inner` to the global, and
 * `@nessy-agent/codex-responses-adapter` symbol `postAnthropicMessages` takes it
 * as `fetchImpl` — so an `anthropic-messages` upstream under the configured base
 * URL meets {@link anthropicAdapter}'s `shouldIntercept` like any other request.
 *
 * The two channels cannot DISAGREE, which is the property worth keeping rather
 * than the coincidence worth removing: both read one resolver,
 * `interceptor-common.ts` symbol `resolvePromptCacheTtl`. `applyPromptCacheTtl`
 * (`agent/options.ts`) hands the claude child the same answer under the
 * documented env name, and the page's step 6 — `undefined`, "the default for the
 * request's bucket" — makes both do nothing at all. Pinned as an agreement, one
 * arm each way, by `agent/__tests__/claude-child-cache-ttl-and-marketplace.test.ts`.
 *
 * Exported for focused unit tests.
 */
export function upgradePromptCacheTtl(body: Record<string, unknown>): number {
  // P6.378 — the CONVERSATION bucket's control, resolved in the page's own
  // precedence order (`resolvePromptCacheTtl`). `undefined` is the page's step
  // 6, "the default for the request's bucket": no host control applies, so the
  // runtime's own choice stands and we touch nothing. It is reachable only when
  // config.json is unreadable or predates `extendedPromptCache`, and in both
  // cases we genuinely do not know what the user chose.
  //
  // THE SUBAGENT BUCKET IS NOT REACHABLE FROM HERE, and that is a measured null
  // rather than an omission: the Anthropic wire carries no marker saying which
  // bucket a request belongs to, and the page never describes one — it assumes
  // the RUNTIME decides, because the runtime is the thing that knows. So the
  // subagent control travels to the claude child by its documented env name
  // (`PROMPT_CACHE_TTL_ENV.subagent`) instead of being guessed at here.
  const ttl = resolvePromptCacheTtl('conversation');
  if (ttl === undefined) return 0;
  if (ttl === '5m') return stripPromptCacheTtl(body);

  let upgraded = 0;

  // Upgrade tool cache_control (must run first — tools is processed before
  // system, and a stale 5m block here would invalidate any later 1h upgrade).
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool.cache_control && (tool.cache_control as Record<string, unknown>).type === 'ephemeral') {
        (tool.cache_control as Record<string, unknown>).ttl = '1h';
        upgraded++;
      }
    }
  }

  // Upgrade system prompt cache_control
  const system = body.system as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block.cache_control && (block.cache_control as Record<string, unknown>).type === 'ephemeral') {
        (block.cache_control as Record<string, unknown>).ttl = '1h';
        upgraded++;
      }
    }
  }

  // Upgrade message content cache_control
  const messages = body.messages as Array<{ content?: unknown }> | undefined;
  if (messages) {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.cache_control && (block.cache_control as Record<string, unknown>).type === 'ephemeral') {
          (block.cache_control as Record<string, unknown>).ttl = '1h';
          upgraded++;
        }
      }
    }
  }

  // Upgrade top-level cache_control (auto-caching mode)
  const topLevel = body.cache_control as Record<string, unknown> | undefined;
  if (topLevel?.type === 'ephemeral') {
    topLevel.ttl = '1h';
    upgraded++;
  }

  if (upgraded > 0) {
    debugLog(`[Anthropic] Upgraded ${upgraded} cache_control block(s) to 1h TTL`);
  }
  return upgraded;
}

/**
 * Check if the HOST's fast path should be applied to this request.
 *
 * This is NOT claude's `fastMode` settings key (the claude child reads that one
 * itself) and NOT codex's `features.fast_mode` (codex enforces that one
 * itself) — it is this fork's own `speed: "fast"` + beta-header decoration on
 * the Anthropic wire. See {@link FEATURE_FLAGS.fastMode}.
 *
 * Gated on {@link FAST_MODE_MODEL_PREFIXES}, which is the page's current list;
 * the flag itself is operator-settable through `NESSY_FEATURE_FAST_MODE`.
 */
export function shouldEnableFastMode(model: unknown): boolean {
  if (!FEATURE_FLAGS.fastMode) return false;
  if (typeof model !== 'string') return false;
  return FAST_MODE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/**
 * Append a beta value to the anthropic-beta header, preserving existing values.
 */
function appendBetaHeader(headers: HeadersInitType | undefined, beta: string): Record<string, string> {
  let headerObj: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { headerObj[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      headerObj[key as string] = value as string;
    }
  } else if (headers) {
    headerObj = { ...headers };
  }

  const existing = headerObj['anthropic-beta'];
  headerObj['anthropic-beta'] = existing ? `${existing},${beta}` : beta;

  return headerObj;
}

/**
 * Remove a beta value from the anthropic-beta header, preserving other values.
 */
function stripBetaHeader(headers: HeadersInitType | undefined, beta: string): Record<string, string> {
  let headerObj: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { headerObj[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      headerObj[key as string] = value as string;
    }
  } else if (headers) {
    headerObj = { ...headers };
  }

  const existing = headerObj['anthropic-beta'];
  if (existing) {
    headerObj['anthropic-beta'] = existing.split(',').filter(b => b.trim() !== beta).join(',');
  }

  return headerObj;
}

function headersToRecord(headers: HeadersLike): Record<string, string> {
  let headerObj: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { headerObj[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      headerObj[key as string] = value as string;
    }
  } else if (headers) {
    headerObj = { ...headers };
  }
  return headerObj;
}

function findHeaderKey(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).find(key => key.toLowerCase() === lowerName);
}

function readHeader(headers: HeadersLike, name: string): string | undefined {
  const headerObj = headersToRecord(headers);
  const key = findHeaderKey(headerObj, name);
  return key ? headerObj[key] : undefined;
}

function setHeader(headers: HeadersLike, name: string, value: string): Record<string, string> {
  const headerObj = headersToRecord(headers);
  const existingKey = findHeaderKey(headerObj, name);
  if (existingKey) {
    delete headerObj[existingKey];
  }
  headerObj[name] = value;
  return headerObj;
}

function deleteHeader(headers: HeadersLike, name: string): Record<string, string> {
  const headerObj = headersToRecord(headers);
  const existingKey = findHeaderKey(headerObj, name);
  if (existingKey) {
    delete headerObj[existingKey];
  }
  return headerObj;
}

/**
 * Turn the Bearer a runtime built into the gateway's own `Nestor-Token`.
 *
 * **DA1.10 — scoped to the NAMED gateway endpoints, not to the whole CLI
 * prefix.** This is the only seam on which the corporate JWT can leave the
 * machine, so its audience is the two URLs the gateway actually serves
 * (`auth/nestor.ts` symbol `isNestorGatewayCredentialUrl`) rather than every
 * path under `…/api/v1/cli/`. A BYO `pi_compat` connection pointed at some other
 * path under that prefix used to have its own Bearer rewritten here — a
 * credential leaving under a header the user never chose, to an endpoint the
 * host never verified.
 *
 * Its two neighbours below deliberately keep the WIDE prefix and must not be
 * swept along: {@link rewriteCredentialHeader} uses it to EXCLUDE and
 * {@link isProviderApiUrl} to WIDEN, so narrowing either one moves the boundary
 * the wrong way. The per-site reasoning for all twelve prefix readers is in
 * `isNestorGatewayCredentialUrl`'s own docblock.
 */
export function rewriteNestorAuthHeaders(urlStr: string, headers: HeadersLike): HeadersLike {
  if (!isNestorGatewayCredentialUrl(urlStr)) return headers;

  const auth = readHeader(headers, 'authorization');
  const bearer = auth?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) return headers;

  const withNestorToken = setHeader(headers, 'Nestor-Token', bearer);
  return deleteHeader(withNestorToken, 'authorization');
}

/**
 * P6.691 — the env name carrying a BYO connection's chosen credential header
 * into the Pi subprocess, set by `buildPiSubprocessEnv` and read here.
 *
 * It exists because Pi's LLM request headers are built inside a VENDORED
 * dependency. `LlmConnection.customEndpoint.credentialHeader` is threaded to the
 * anthropic and codex drivers directly (`drivers/anthropic.ts:35`,
 * `drivers/codex.ts:43`), and on Pi there is no host builder to thread it
 * through: `x-api-key` scores zero across `packages/pi-agent-server`, and in
 * `@earendil-works/pi-ai` the string occurs only under `providers/cloudflare-auth`,
 * never on the openai-compatible path. So the SDK sends `Authorization: Bearer`
 * with no knob, and the setup form — which offers the choice since P6.586 — was
 * offering something Pi silently ignored.
 *
 * The interceptor is the only host seam that sees the child's outbound request,
 * which makes it step 2 of native-first (the host supplies uniformly) rather
 * than a per-runtime build.
 */
const UPSTREAM_CREDENTIAL_HEADER_ENV = 'NESSY_UPSTREAM_CREDENTIAL_HEADER';

/**
 * Move a Bearer credential onto `x-api-key` when the connection asked for it.
 *
 * ## Four guards, and each one is a way this could leak a token
 *
 * 1. **Only `x-api-key`.** `authorization` is carried as ABSENCE at every other
 *    reader (P6.586: writing the default explicitly would rewrite every stored
 *    connection to say what it already meant), so anything that is not exactly
 *    the opt-in value leaves the request alone.
 * 2. **Never on the verified gateway prefix.** That path has its own scheme —
 *    {@link rewriteNestorAuthHeaders} turns the Bearer into `Nestor-Token` — and
 *    a second rewrite would either fight it or strip the header it just wrote.
 * 3. **Provider API traffic only**, the same boundary the operator-header layer
 *    uses and for the same reason: this file is the Pi child's global `fetch`,
 *    so it also sees MCP calls, plugin fetches and anything a tool reaches for.
 *    A credential must not ride an arbitrary egress because the same process
 *    made the request.
 * 4. **Never over an `x-api-key` that is already there.** A request that already
 *    carries one was built by something that knew what it was doing, and
 *    overwriting it would replace a working credential with a different one.
 *
 * Returns the SAME object when it does nothing, which is what keeps
 * {@link prepareOutboundHeaders}'s default path byte-identical.
 */
export function rewriteCredentialHeader(urlStr: string, headers: HeadersLike): HeadersLike {
  if (process.env[UPSTREAM_CREDENTIAL_HEADER_ENV]?.trim().toLowerCase() !== 'x-api-key') return headers;
  // DA1.10 — the WIDE prefix, deliberately, and NOT
  // `isNestorGatewayCredentialUrl`. This line EXCLUDES, so narrowing it would
  // start rewriting Bearer to `x-api-key` on gateway-host paths it leaves alone
  // today. Guard 2 above is the sentence; this comment is the reason it did not
  // move with its neighbour.
  if (urlStr.startsWith(NESTOR_CLI_BASE_PREFIX)) return headers;
  if (!isProviderApiUrl(urlStr)) return headers;
  const bearer = readHeader(headers, 'authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) return headers;
  if (readHeader(headers, 'x-api-key') !== undefined) return headers;
  return deleteHeader(setHeader(headers, 'x-api-key', bearer), 'authorization');
}

/**
 * Whether this URL is model-provider API traffic, for the purpose of deciding
 * where an operator-supplied header may go.
 *
 * The interceptor is installed as the Pi subprocess's global `fetch`, so it also
 * sees MCP HTTP calls, plugin fetches and anything a tool reaches for. An
 * operator header channel is where a token lives, and a token must not ride an
 * arbitrary egress just because the same process made it. This reuses the
 * adapters' own `shouldIntercept` URL patterns — the boundary this file already
 * treats as "provider API traffic" everywhere else — plus the verified gateway
 * prefix, and deliberately does NOT use `findAdapter`, which can select an
 * adapter from the `NESSY_PI_MODEL_API` hint without looking at the URL at all.
 */
function isProviderApiUrl(urlStr: string): boolean {
  // DA1.10 — the WIDE prefix, deliberately. This line WIDENS the boundary an
  // operator header may ride on; narrowing it to the named endpoints would
  // SHRINK a documented allowance rather than close a credential hole. Only the
  // two credential sites moved.
  return urlStr.startsWith(NESTOR_CLI_BASE_PREFIX)
    || adapters.some(adapter => adapter.shouldIntercept(urlStr));
}

/**
 * Is this process the Pi subprocess? This file is preloaded into TWO kinds of process, and since
 * F1.531 the discriminator is `NESSY_PI_SUBPROCESS=1`, written once by the Pi spawn site
 * (`agent/pi-agent.ts` `buildPiSubprocessEnv`) and never touched after: the model hint
 * `NESSY_PI_MODEL_API` alone lost Pi's shape, because pi-agent-server's `setInterceptorApiHints`
 * DELETES it when a `set_model` cannot resolve or a session has no model, and Pi runs on. The hint
 * still counts (a rig spawning Pi without that builder); the headless server (`bin/nessy-server`)
 * carries neither. Shared by {@link urlFallbackAdapter} (F1.315) and {@link operatorHeadersMayRide}
 * (F1.517), so the two Pi-only decisions cannot disagree. Residue, named once for both: a headless
 * server launched from INSIDE a Pi tool call inherits both names and reads as Pi.
 */
function runsInPiSubprocess(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.NESSY_PI_SUBPROCESS === '1' || env.NESSY_PI_MODEL_API !== undefined;
}

/**
 * F1.517 — where layer (1) of {@link prepareOutboundHeaders}, the operator's
 * `NESSY_CUSTOM_HEADERS`, may go.
 *
 * - **In the Pi subprocess:** any URL {@link isProviderApiUrl} recognises,
 *   unchanged. Pi's SDK talks to its provider directly, and this file's adapter
 *   list is the only provider boundary Pi has.
 * - **Anywhere else — the headless server:** the verified gateway prefix only,
 *   which is `telemetry/gateway-headers.ts` `gatewayRequestHeaders`' own rule.
 *   There this file meets a codex or claude-runtime session's upstream hop, made
 *   by the host's loopback adapter through `gatewaySessionFetch` — which has
 *   already added the operator's headers on the gateway and deliberately nowhere
 *   else (P6.180: an operator header channel is where an operator puts a token,
 *   and a BYO endpoint is one nothing verified). Offering them to a BYO URL here
 *   re-widened that on the headless server alone: the desktop's main process
 *   preloads nothing, so the same session sent them nowhere but the gateway, and
 *   the per-session notice (`customHeadersOffGatewayNotice`) told the operator
 *   so on both hosts. Measured by WJ-ai, 2026-09-24 (codex BYO: headless sent,
 *   desktop did not); `unified-network-interceptor.headless-operator-headers.test.ts`
 *   pins the narrowed hop and the Pi control.
 */
function operatorHeadersMayRide(urlStr: string): boolean {
  if (!isProviderApiUrl(urlStr)) return false;
  return runsInPiSubprocess() || urlStr.startsWith(NESTOR_CLI_BASE_PREFIX);
}

/**
 * The three header layers of one outbound request, applied in the order that
 * keeps each authoritative over the one it should beat:
 *
 * 1. **Operator-supplied** (`NESSY_CUSTOM_HEADERS`) — last-writer over what the
 *    SDK built, which is what `env-vars.md:332` relies on when it says a proxy's
 *    `Authorization` can be supplied "for example through
 *    `ANTHROPIC_CUSTOM_HEADERS`". Scoped to provider API traffic: Claude's
 *    variable adds headers to the requests it sends to its configured provider,
 *    and `isProviderApiUrl` is the nearest boundary this file can name — in the
 *    Pi subprocess; elsewhere, the verified gateway only
 *    ({@link operatorHeadersMayRide}, F1.517).
 * 2. **Gateway credential rewrite** — runs after (1) so a `Bearer` an operator
 *    supplied still becomes the gateway's `Nestor-Token` on the gateway path.
 * 3. **Correlation** — last, so the identifier the gateway aggregates on is ours
 *    and cannot be spoofed through layer (1). Scoped to the verified gateway
 *    URL prefix, so it never rides onto a custom endpoint on the same host.
 *
 * When neither layer (1) nor (3) applies — the default — this is exactly
 * `rewriteNestorAuthHeaders`, including its identity return for a non-gateway
 * URL, so the common path stays byte-identical.
 *
 * **Layer (3) only ever fires where one process means one session.** It reads
 * `NESSY_SESSION_ID` out of the environment, which is true of the Pi subprocess
 * this file preloads into and false of every host process — the Electron main
 * and the headless server both serve many sessions at once, and the headless
 * server DOES preload this file. So a claude-runtime turn, whose upstream
 * gateway request is made by the host's loopback adapter rather than by the SDK
 * child, reaches this function with no session id available to it. The
 * per-request form is `telemetry/gateway-headers.ts:gatewayRequestHeaders`,
 * which takes the id as an argument; see that module's header for the wiring.
 *
 * Layer (1) can no longer spoof layer (3)'s header name even in a process that
 * has no session id of its own — `parseCustomHeaders` reserves it — so the
 * ordering here is defence in depth rather than the only guard.
 */
export function prepareOutboundHeaders(urlStr: string, headers: HeadersLike): HeadersLike {
  const custom = operatorHeadersMayRide(urlStr) ? customHeaders() : {};
  const correlation = gatewayCorrelationHeaders(urlStr);
  const customNames = Object.keys(custom);
  if (customNames.length === 0 && Object.keys(correlation).length === 0) {
    return rewriteCredentialHeader(urlStr, rewriteNestorAuthHeaders(urlStr, headers));
  }

  let result = headersToRecord(headers);
  for (const name of customNames) {
    result = setHeader(result, name, custom[name]!);
  }
  result = headersToRecord(rewriteNestorAuthHeaders(urlStr, result));
  // P6.691 · layer (2b): AFTER the gateway rewrite, so the gateway path has
  // already taken its Bearer and this cannot fight it, and after layer (1), so a
  // Bearer an OPERATOR supplied moves onto the chosen header too — the operator
  // set a credential, not a header name. Before layer (3), which must stay last.
  result = headersToRecord(rewriteCredentialHeader(urlStr, result));
  for (const [name, value] of Object.entries(correlation)) {
    result = setHeader(result, name, value);
  }
  return result;
}

function mergeRequestAndInitHeaders(
  request: Request,
  initHeaders: HeadersLike,
): Record<string, string> {
  return {
    ...headersToRecord(request.headers),
    ...headersToRecord(initHeaders),
  };
}

/** State for a tracked tool_use block during Anthropic SSE streaming */
interface TrackedToolBlock {
  id: string;
  name: string;
  index: number;
  bufferedJson: string;
}

const SSE_EVENT_RE = /^event:\s*(.+)$/;
const SSE_DATA_RE = /^data:\s*(.+)$/;

/**
 * Creates a TransformStream that intercepts Anthropic SSE events,
 * buffers tool_use input deltas, extracts _intent/_displayName into the metadata
 * store, and re-emits clean events without those fields.
 */
export function createAnthropicSseStrippingStream(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const trackedBlocks = new Map<number, TrackedToolBlock>();
  let lineBuffer = '';
  let currentEventType = '';
  let currentData = '';
  let eventCount = 0;

  function processEvent(eventType: string, dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    eventCount++;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    if (eventType === 'content_block_start') {
      const contentBlock = data.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (contentBlock?.type === 'tool_use' && contentBlock.id && contentBlock.name != null) {
        const index = data.index as number;
        trackedBlocks.set(index, {
          id: contentBlock.id,
          name: contentBlock.name,
          index,
          bufferedJson: '',
        });
      }
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = data.index as number;
      const delta = data.delta as { type?: string; partial_json?: string } | undefined;

      if (delta?.type === 'input_json_delta' && trackedBlocks.has(index)) {
        const block = trackedBlocks.get(index)!;
        block.bufferedJson += delta.partial_json ?? '';
        return;
      }
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = data.index as number;
      const block = trackedBlocks.get(index);

      if (block) {
        trackedBlocks.delete(index);
        emitBufferedBlock(block, index, controller);
        emitSseEvent(eventType, dataStr, controller);
        return;
      }
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    emitSseEvent(eventType, dataStr, controller);
  }

  function emitBufferedBlock(
    block: TrackedToolBlock,
    index: number,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (!block.bufferedJson) {
      return;
    }

    try {
      const parsed = JSON.parse(block.bufferedJson);

      captureMetadataFromInput(block.id, block.name, parsed);
      delete parsed._intent;
      delete parsed._displayName;

      const cleanJson = JSON.stringify(parsed);

      const deltaEvent = {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: cleanJson,
        },
      };
      emitSseEvent('content_block_delta', JSON.stringify(deltaEvent), controller);
    } catch {
      debugLog(`[SSE Strip] Failed to parse buffered JSON for ${block.name} (${block.id}), stripping via regex`);
      const stripped = stripMetadataFieldsFromRawJson(block.bufferedJson);
      const deltaEvent = {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: stripped,
        },
      };
      emitSseEvent('content_block_delta', JSON.stringify(deltaEvent), controller);
    }
  }

  function emitSseEvent(
    eventType: string,
    dataStr: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    const sseText = `event: ${eventType}\ndata: ${dataStr}\n\n`;
    controller.enqueue(encoder.encode(sseText));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = lineBuffer + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') {
          if (currentEventType && currentData) {
            processEvent(currentEventType, currentData, controller);
          }
          currentEventType = '';
          currentData = '';
          continue;
        }

        const eventMatch = trimmed.match(SSE_EVENT_RE);
        if (eventMatch) {
          currentEventType = eventMatch[1]!.trim();
          continue;
        }

        const dataMatch = trimmed.match(SSE_DATA_RE);
        if (dataMatch) {
          currentData = currentData ? `${currentData}\n${dataMatch[1]!}` : dataMatch[1]!;
          continue;
        }
      }
    },

    flush(controller) {
      if (lineBuffer.trim()) {
        const lines = lineBuffer.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') {
            if (currentEventType && currentData) {
              processEvent(currentEventType, currentData, controller);
            }
            currentEventType = '';
            currentData = '';
            continue;
          }
          const eventMatch = trimmed.match(SSE_EVENT_RE);
          if (eventMatch) {
            currentEventType = eventMatch[1]!.trim();
            continue;
          }
          const dataMatch = trimmed.match(SSE_DATA_RE);
          if (dataMatch) {
            currentData = currentData ? `${currentData}\n${dataMatch[1]!}` : dataMatch[1]!;
          }
        }

        if (currentEventType && currentData) {
          processEvent(currentEventType, currentData, controller);
        }
      }

      for (const [index, block] of trackedBlocks) {
        emitBufferedBlock(block, index, controller);
      }
      trackedBlocks.clear();
      lineBuffer = '';
      debugLog(`[SSE] Stream flush complete. Total events processed: ${eventCount}`);
    },
  });
}

const anthropicAdapter: ApiAdapter = {
  name: 'anthropic',

  shouldIntercept(url: string): boolean {
    const baseUrl = getConfiguredBaseUrl();
    return url.startsWith(baseUrl) && url.includes('/messages');
  },

  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown> {
    const tools = body.tools as Array<{
      name?: string;
      input_schema?: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }> | undefined;

    if (!tools || !Array.isArray(tools)) {
      return body;
    }

    const richDescriptions = isRichToolDescriptionsEnabled();
    let modifiedCount = 0;
    for (const tool of tools) {
      // MCP tools always get metadata regardless of the feature flag — they're
      // lower-volume than built-in tools and the metadata drives source-specific
      // UI (tool intents, display names in the sidebar).
      const isMcpTool = tool.name?.startsWith('mcp__');
      if (!richDescriptions && !isMcpTool) {
        continue;
      }

      if (!tool.input_schema || typeof tool.input_schema !== 'object') {
        continue;
      }

      const updatedSchema = injectMetadataIntoToolSchema(tool.input_schema);
      tool.input_schema.properties = updatedSchema.properties;
      tool.input_schema.required = updatedSchema.required;
      // External MCP servers may set additionalProperties: false which would
      // cause the API to reject _intent/_displayName in tool inputs.
      if ((tool.input_schema as Record<string, unknown>).additionalProperties === false) {
        delete (tool.input_schema as Record<string, unknown>).additionalProperties;
      }
      modifiedCount++;
    }

    if (modifiedCount > 0) {
      debugLog(`[Anthropic Schema] Added _intent and _displayName to ${modifiedCount} tools`);
    }

    return body;
  },

  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown> {
    const messages = body.messages as Array<{
      role?: string;
      content?: Array<{
        type?: string;
        id?: string;
        input?: Record<string, unknown>;
      }>;
    }> | undefined;

    if (!messages) return body;

    let injectedCount = 0;

    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        if (block.type !== 'tool_use' || !block.id || !block.input) continue;

        const hasIntent = '_intent' in block.input;
        const hasDisplayName = '_displayName' in block.input;
        if (hasIntent && hasDisplayName) continue;

        const stored = toolMetadataStore.get(block.id);
        if (stored) {
          const newInput: Record<string, unknown> = {};
          if (!hasDisplayName && stored.displayName) newInput._displayName = stored.displayName;
          if (!hasIntent && stored.intent) newInput._intent = stored.intent;
          if (Object.keys(newInput).length > 0) {
            Object.assign(newInput, block.input);
            block.input = newInput;
            injectedCount++;
          }
        }
      }
    }

    if (injectedCount > 0) {
      debugLog(`[Anthropic History] Re-injected metadata into ${injectedCount} tool_use blocks`);
    }

    return body;
  },

  createSseProcessor(): TransformStream<Uint8Array, Uint8Array> {
    return createAnthropicSseStrippingStream();
  },

  stripsSseMetadata: true,

  modifyRequest(_url: string, init: RequestInit, body: Record<string, unknown>): { init: RequestInit; body: Record<string, unknown> } {
    sanitizeEmptyTextCacheControl(body);
    upgradePromptCacheTtl(body);

    // F1.1241 — the `context-1m-2025-08-07` beta strip is gone with the Extended
    // context switch. It was dead on Pi (pi-ai 0.85.1 never sends that header: 0
    // hits in its dist, `getBetaFeatures` never adds it), and on Claude the window
    // is now each model's own: platform context-windows.md says "For every model
    // with a 1M-token context window, 1M is the default: you don't need a beta
    // header". An operator who must cap the window sets the vendor's own
    // CLAUDE_CODE_DISABLE_1M_CONTEXT or CLAUDE_CODE_AUTO_COMPACT_WINDOW, which
    // reach the Claude child unchanged. `stripBetaHeader` above is kept for the
    // next beta that needs removing; this comment is kept at the old block's
    // length so the line citations into this file stay put.

    const fastMode = shouldEnableFastMode(body.model);
    if (fastMode) {
      body.speed = 'fast';
      debugLog(`[Fast Mode] Enabled for model=${body.model}`);
      return {
        init: {
          ...init,
          headers: appendBetaHeader(init?.headers as HeadersInitType | undefined, FAST_MODE_BETA),
        },
        body,
      };
    }
    return { init, body };
  },
};

// ============================================================================
// OPENAI ADAPTER
// ============================================================================

/** Tracked tool call during OpenAI SSE streaming */
interface TrackedToolCall {
  id: string;
  name: string;
  type: string;
  choiceIndex: number;
  toolIndex: number;
  /** Args accumulated from same-index deltas (partial JSON pieces). */
  arguments: string;
  /** Phase-2 args (DeepSeek-style "shifted index" chunks). Each element is
   * a complete JSON string that should be merged at the OBJECT level into
   * the final args, not concatenated as a string. */
  shiftedArgs: string[];
}

/**
 * Creates a TransformStream that intercepts OpenAI SSE events,
 * buffers tool_call argument deltas across all upstream chunks, extracts
 * `_intent` / `_displayName` into the metadata store, and emits one
 * consolidated SSE event per logical tool call with `id + name + cleanArgs`
 * together.
 *
 * Output contract — important:
 * - Each logical tool call produces EXACTLY ONE outbound SSE event with
 *   `delta.tool_calls: [{index, id, type, function: {name, arguments}}]`.
 * - We never emit args-only deltas (no id, no name). Some downstream SDKs
 *   (notably Pi SDK) treat such deltas as new tool_calls instead of merging
 *   by index, which produced duplicate empty-id entries on parallel-tool
 *   turns from DeepSeek and other relays.
 * - Non-tool events pass through immediately.
 * - All upstream tool_call chunks are suppressed; the consolidated events
 *   are emitted just before the original `[DONE]` / `finish_reason` event.
 */
export function createOpenAiSseStrippingStream(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const trackedCalls = new Map<string, TrackedToolCall>();
  /**
   * Per-choice fallback for relays that drop `tc.index` on argument-delta
   * chunks. We pin argument deltas to the most recently opened tool call in
   * the same choice instead of letting them collide on key 0.
   */
  const lastOpenedToolIndexByChoice = new Map<number, number>();
  let lineBuffer = '';
  /** Track whether we're currently buffering tool_call argument deltas */
  let bufferingToolCalls = false;

  function emitSseLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW OUT openai] ${dataStr.slice(0, 4000)}`);
    controller.enqueue(encoder.encode(`data: ${dataStr}\n\n`));
  }

  function flushTrackedCalls(controller: TransformStreamDefaultController<Uint8Array>): void {
    // Iterate in toolIndex order so downstream sees a stable sequence.
    const sorted = Array.from(trackedCalls.values()).sort((a, b) => {
      if (a.choiceIndex !== b.choiceIndex) return a.choiceIndex - b.choiceIndex;
      return a.toolIndex - b.toolIndex;
    });

    for (const tc of sorted) {
      // Merge in this priority: phase-1 args (partial-JSON concatenation)
      // first, then any phase-2 "shifted index" args (each a complete JSON
      // object) via object spread. Phase-2 wins on key conflicts since it
      // carries the model's actual content (DeepSeek emits real args there;
      // phase-1 carries only `_intent` / `_displayName` for those calls).
      let merged: Record<string, unknown> = {};
      let parseFailed = false;

      if (tc.arguments) {
        try {
          const parsed = JSON.parse(tc.arguments);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            merged = { ...merged, ...(parsed as Record<string, unknown>) };
          }
        } catch {
          parseFailed = true;
          debugLog(`[OpenAI SSE] Failed to parse phase-1 arguments for ${tc.name} (${tc.id}), passing through raw`);
        }
      }

      for (const piece of tc.shiftedArgs) {
        try {
          const parsed = JSON.parse(piece);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            merged = { ...merged, ...(parsed as Record<string, unknown>) };
          }
        } catch {
          parseFailed = true;
          debugLog(`[OpenAI SSE] Failed to parse phase-2 arguments for ${tc.name} (${tc.id}), passing through raw`);
        }
      }

      let outArgs: string;
      if (parseFailed && !tc.shiftedArgs.length) {
        // Pure phase-1 parse failure with no phase-2 to recover from —
        // pass through the raw concatenation so downstream sees something.
        outArgs = tc.arguments;
      } else {
        captureMetadataFromInput(tc.id, tc.name, merged);
        delete merged._intent;
        delete merged._displayName;
        outArgs = JSON.stringify(merged);
      }

      // Consolidated tool_call event: id + type + name + cleanArgs together.
      // Downstream SDKs see one event per logical tool call — no merging
      // by index, no orphan args-only deltas.
      const consolidatedEvent = {
        choices: [{
          index: tc.choiceIndex,
          delta: {
            tool_calls: [{
              index: tc.toolIndex,
              id: tc.id,
              type: tc.type,
              function: { name: tc.name, arguments: outArgs },
            }],
          },
        }],
      };
      emitSseLine(JSON.stringify(consolidatedEvent), controller);
    }
    trackedCalls.clear();
    bufferingToolCalls = false;
  }

  function processDataLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW IN  openai] ${dataStr.slice(0, 4000)}`);
    if (dataStr === '[DONE]') {
      flushTrackedCalls(controller);
      emitSseLine(dataStr, controller);
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      emitSseLine(dataStr, controller);
      return;
    }

    const choices = data.choices as Array<{
      index?: number;
      delta?: {
        tool_calls?: Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
      finish_reason?: string | null;
    }> | undefined;

    if (!choices || choices.length === 0) {
      emitSseLine(dataStr, controller);
      return;
    }

    let handledToolCalls = false;
    let strippedEmptyToolCalls = false; // F1.237 — see the loop's first lines
    // Buffer tool_call argument deltas (across all choices). All upstream
    // tool_call chunks are suppressed; we emit one consolidated event per
    // logical tool call at flush time — see flushTrackedCalls.
    //
    // Relay quirks handled here:
    //   - id-repeat relays (DeepSeek, some Chinese OpenAI-compat hosts) send
    //     `tc.id` on every chunk instead of only the first. We treat the
    //     second-and-later occurrences with a matching id as argument-only
    //     deltas (no new tracked entry).
    //   - index-dropping relays send argument-delta chunks without `tc.index`.
    //     We fall back to "the most recently opened tracked call for this
    //     choice" so parallel tool calls don't collide on key 0.
    //   - index-shifting relays (DeepSeek extended-thinking) emit the
    //     argument payload at a NEW `tc.index` with empty id/name. We attach
    //     those args to the matching phase-1 entry by walking the open calls
    //     in order rather than allocating a new bucket for them.
    for (const choice of choices) {
      // F1.237 / F1.317 — `tool_calls: []` or a truthy non-array (`{}`) is NOT a tool-call delta; its key is dropped (pi-ai
      // iterates it); `null` stays verbatim (pi-ai skips it). craft-agents-oss #995, v0.11.3, Apache-2.0.
      const toolCalls = choice?.delta?.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        if (toolCalls && choice.delta) { delete choice.delta.tool_calls; strippedEmptyToolCalls = true; }
        continue;
      }
      handledToolCalls = true;
      const choiceIndex = choice.index ?? 0;
      for (const tc of toolCalls) {
        // Resolve the bucket key. If `tc.index` is missing, prefer the most
        // recently opened call in this choice so we don't collide on key 0.
        const fallbackIndex = lastOpenedToolIndexByChoice.get(choiceIndex);
        const toolIndex = tc.index ?? fallbackIndex ?? 0;
        const key = `${choiceIndex}:${toolIndex}`;

        if (tc.id) {
          const existing = trackedCalls.get(key);
          if (existing && existing.id === tc.id) {
            // Relay repeated the id on a subsequent chunk. Treat this as an
            // argument-delta only.
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            // If a later chunk carries the function name we hadn't seen yet,
            // upgrade the tracked entry rather than letting it stay 'unknown'.
            if (tc.function?.name && existing.name === 'unknown') {
              existing.name = tc.function.name;
            }
            continue;
          }

          // First chunk for a logical tool call — record id/name/type and
          // any initial args. We do NOT emit an init event; the consolidated
          // event is emitted on flush.
          trackedCalls.set(key, {
            id: tc.id,
            name: tc.function?.name || 'unknown',
            type: tc.type || 'function',
            choiceIndex,
            toolIndex,
            arguments: tc.function?.arguments || '',
            shiftedArgs: [],
          });
          lastOpenedToolIndexByChoice.set(choiceIndex, toolIndex);
          bufferingToolCalls = true;
        } else {
          // Subsequent argument delta with no id. Three patterns to handle:
          //  (a) Same `tc.index` as a phase-1 entry → append (partial JSON).
          //  (b) Missing `tc.index` → fall back to last-opened, append.
          //  (c) NEW `tc.index` past the last-opened (DeepSeek's
          //      "phase-2 args at shifted index" shape). Attach to the
          //      matching phase-1 entry by ordinal position. These chunks
          //      carry a COMPLETE JSON object, not a partial string — store
          //      them separately and merge at the object level on flush.
          const existingByKey = trackedCalls.get(key);
          if (existingByKey) {
            // (a) or (b) — partial JSON delta, append.
            if (tc.function?.arguments) {
              existingByKey.arguments += tc.function.arguments;
            }
          } else {
            // (c) — find the phase-1 entry in this choice by position.
            const phase1 = Array.from(trackedCalls.values())
              .filter(t => t.choiceIndex === choiceIndex)
              .sort((a, b) => a.toolIndex - b.toolIndex);
            const lastOpened = lastOpenedToolIndexByChoice.get(choiceIndex);
            if (
              typeof lastOpened === 'number' &&
              tc.index !== undefined &&
              tc.index > lastOpened &&
              phase1.length > 0 &&
              tc.function?.arguments
            ) {
              const ord = tc.index - (lastOpened + 1);
              if (ord >= 0 && ord < phase1.length) {
                phase1[ord]!.shiftedArgs.push(tc.function.arguments);
              }
            }
          }
        }
      }
    }

    // The tool_call payloads are buffered (emitted on flush); F1.313 / F1.314 — the chunk's REST is not dropped.
    if (handledToolCalls) return emitHandledChunkRest(data, () => flushTrackedCalls(controller), (line) => emitSseLine(line, controller));
    // F1.237 — forward with the empty tool_calls key removed (re-serialized), else verbatim.
    const forwardStr = strippedEmptyToolCalls ? JSON.stringify(data) : dataStr;
    // On finish, flush buffered tool calls with clean args BEFORE emitting finish event
    const hasFinish = choices.some(choice => choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop');
    if (hasFinish) {
      if (bufferingToolCalls) flushTrackedCalls(controller);
      emitSseLine(forwardStr, controller);
      return;
    }
    // Non-tool events pass through
    emitSseLine(forwardStr, controller);
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = lineBuffer + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        if (trimmed.startsWith('data: ')) {
          processDataLine(trimmed.slice(6), controller);
        } else {
          // Pass through non-data SSE lines (comments, event types, etc.)
          controller.enqueue(encoder.encode(trimmed + '\n'));
        }
      }
    },

    flush(controller) {
      if (lineBuffer.trim()) {
        const trimmed = lineBuffer.trim();
        if (trimmed.startsWith('data: ')) {
          processDataLine(trimmed.slice(6), controller);
        }
      }
      // Flush any remaining tracked calls on stream end
      if (trackedCalls.size > 0) {
        flushTrackedCalls(controller);
      }
      lineBuffer = '';
    },
  });
}

const openAiAdapter: ApiAdapter = {
  name: 'openai',

  shouldIntercept(url: string): boolean {
    return url.includes('/chat/completions');
  },

  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown> {
    const tools = body.tools as Array<{
      type?: string;
      function?: {
        name?: string;
        parameters?: {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
        };
      };
    }> | undefined;

    if (!tools || !Array.isArray(tools)) {
      return body;
    }

    const richDescriptions = isRichToolDescriptionsEnabled();
    let modifiedCount = 0;

    for (const tool of tools) {
      if (tool.type !== 'function' || !tool.function?.parameters) continue;

      // MCP tools always get metadata regardless of the feature flag — they're
      // lower-volume than built-in tools and the metadata drives source-specific
      // UI (tool intents, display names in the sidebar).
      const isMcpTool = tool.function.name?.startsWith('mcp__');
      if (!richDescriptions && !isMcpTool) {
        continue;
      }

      const params = tool.function.parameters;
      const updatedSchema = injectMetadataIntoToolSchema(params);
      params.properties = updatedSchema.properties;
      params.required = updatedSchema.required;
      // External MCP servers may set additionalProperties: false which would
      // cause validation to reject _intent/_displayName in tool inputs.
      if ((params as Record<string, unknown>).additionalProperties === false) {
        delete (params as Record<string, unknown>).additionalProperties;
      }
      modifiedCount++;
    }

    if (modifiedCount > 0) {
      debugLog(`[OpenAI Schema] Added _intent and _displayName to ${modifiedCount} tools`);
    }

    return body;
  },

  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown> {
    sanitizeOpenAiHistoryInPlace(body);

    const messages = body.messages as Array<{
      role?: string;
      tool_call_id?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    }> | undefined;

    if (!messages) return body;

    let injectedCount = 0;

    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;

      for (const tc of message.tool_calls) {
        if (!tc.id || !tc.function?.arguments) continue;

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          continue;
        }

        const hasIntent = '_intent' in args;
        const hasDisplayName = '_displayName' in args;
        if (hasIntent && hasDisplayName) continue;

        const stored = toolMetadataStore.get(tc.id);
        if (stored) {
          const newArgs: Record<string, unknown> = {};
          if (!hasDisplayName && stored.displayName) newArgs._displayName = stored.displayName;
          if (!hasIntent && stored.intent) newArgs._intent = stored.intent;
          if (Object.keys(newArgs).length > 0) {
            Object.assign(newArgs, args);
            tc.function.arguments = JSON.stringify(newArgs);
            injectedCount++;
          }
        }
      }
    }

    if (injectedCount > 0) {
      debugLog(`[OpenAI History] Re-injected metadata into ${injectedCount} tool_calls`);
    }

    return body;
  },

  validateOutgoingBody(body: Record<string, unknown>): void {
    validateOpenAiChatBody(body);
  },

  createSseProcessor(): TransformStream<Uint8Array, Uint8Array> {
    return createOpenAiSseStrippingStream();
  },

  stripsSseMetadata: true,
};

/**
 * Creates a TransformStream for OpenAI Responses API SSE.
 *
 * We capture metadata and strip it at the stable "done" boundaries where full
 * function-call arguments are available as JSON strings:
 * - response.function_call_arguments.done
 * - response.output_item.done (item.type === 'function_call')
 */
export function createOpenAiResponsesSseStrippingStream(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let lineBuffer = '';

  function emitSseLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW OUT openai-responses] ${dataStr.slice(0, 4000)}`);
    controller.enqueue(encoder.encode(`data: ${dataStr}\n\n`));
  }

  function processDataLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW IN  openai-responses] ${dataStr.slice(0, 4000)}`);
    if (dataStr === '[DONE]') {
      emitSseLine(dataStr, controller);
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      emitSseLine(dataStr, controller);
      return;
    }

    const eventType = data.type;
    if (eventType === 'response.function_call_arguments.done') {
      const callId = typeof data.call_id === 'string' ? data.call_id : undefined;
      const argsStr = typeof data.arguments === 'string' ? data.arguments : undefined;
      if (callId && argsStr) {
        try {
          const parsed = JSON.parse(argsStr) as Record<string, unknown>;
          captureMetadataFromInput(callId, 'response:function_call', parsed);
          delete parsed._intent;
          delete parsed._displayName;
          data.arguments = JSON.stringify(parsed);
        } catch {
          // pass through unchanged
        }
      }
      emitSseLine(JSON.stringify(data), controller);
      return;
    }

    if (eventType === 'response.output_item.done') {
      const item = data.item as {
        type?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      } | undefined;

      if (item?.type === 'function_call' && typeof item.arguments === 'string') {
        const toolId = typeof item.call_id === 'string' ? item.call_id : undefined;
        const toolName = typeof item.name === 'string' ? item.name : 'response:function_call';
        if (toolId) {
          try {
            const parsed = JSON.parse(item.arguments) as Record<string, unknown>;
            captureMetadataFromInput(toolId, toolName, parsed);
            delete parsed._intent;
            delete parsed._displayName;
            item.arguments = JSON.stringify(parsed);
          } catch {
            // pass through unchanged
          }
        }
      }

      emitSseLine(JSON.stringify(data), controller);
      return;
    }

    emitSseLine(dataStr, controller);
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = lineBuffer + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        if (trimmed.startsWith('data: ')) {
          processDataLine(trimmed.slice(6), controller);
        } else {
          controller.enqueue(encoder.encode(trimmed + '\n'));
        }
      }
    },

    flush(controller) {
      if (lineBuffer.trim()) {
        const trimmed = lineBuffer.trim();
        if (trimmed.startsWith('data: ')) {
          processDataLine(trimmed.slice(6), controller);
        }
      }
      lineBuffer = '';
    },
  });
}

const openAiResponsesAdapter: ApiAdapter = {
  name: 'openai-responses',

  shouldIntercept(url: string): boolean {
    return url.includes('/responses');
  },

  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown> {
    const tools = body.tools as Array<{
      type?: string;
      name?: string;
      parameters?: {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }> | undefined;

    if (!tools || !Array.isArray(tools)) return body;

    const richDescriptions = isRichToolDescriptionsEnabled();
    let modifiedCount = 0;

    for (const tool of tools) {
      if (tool.type !== 'function' || !tool.parameters) continue;

      const isMcpTool = tool.name?.startsWith('mcp__');
      if (!richDescriptions && !isMcpTool) continue;

      const params = tool.parameters;
      const updatedSchema = injectMetadataIntoToolSchema(params);
      params.properties = updatedSchema.properties;
      params.required = updatedSchema.required;
      if ((params as Record<string, unknown>).additionalProperties === false) {
        delete (params as Record<string, unknown>).additionalProperties;
      }
      modifiedCount++;
    }

    if (modifiedCount > 0) {
      debugLog(`[OpenAI Responses Schema] Added _intent and _displayName to ${modifiedCount} tools`);
    }

    return body;
  },

  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown> {
    const input = body.input as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(input)) return body;

    // Pass 1: repair structurally-broken history before metadata injection.
    // Real-world cause: some Pi SDK code paths (notably DeepSeek + custom
    // OpenAI-compatible endpoints) occasionally drop `call_id` on replayed
    // function_call entries, or emit a function_call_output that doesn't
    // reference any earlier function_call. The upstream replies with an
    // opaque 400 (#613). We synthesize a deterministic id and drop true
    // orphans so the request reaches the API in a usable shape.
    repairResponsesHistoryInPlace(input);

    let injectedCount = 0;

    for (const entry of input) {
      if (entry.type !== 'function_call' || typeof entry.call_id !== 'string' || typeof entry.arguments !== 'string') continue;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(entry.arguments) as Record<string, unknown>;
      } catch {
        continue;
      }

      const hasIntent = '_intent' in args;
      const hasDisplayName = '_displayName' in args;
      if (hasIntent && hasDisplayName) continue;

      const stored = toolMetadataStore.get(entry.call_id);
      if (!stored) continue;

      const newArgs: Record<string, unknown> = {};
      if (!hasDisplayName && stored.displayName) newArgs._displayName = stored.displayName;
      if (!hasIntent && stored.intent) newArgs._intent = stored.intent;
      if (Object.keys(newArgs).length > 0) {
        Object.assign(newArgs, args);
        entry.arguments = JSON.stringify(newArgs);
        injectedCount++;
      }
    }

    if (injectedCount > 0) {
      debugLog(`[OpenAI Responses History] Re-injected metadata into ${injectedCount} function_call items`);
    }

    return body;
  },

  validateOutgoingBody(body: Record<string, unknown>): void {
    validateOpenAiResponsesBody(body);
  },

  createSseProcessor(): TransformStream<Uint8Array, Uint8Array> {
    return createOpenAiResponsesSseStrippingStream();
  },

  stripsSseMetadata: true,
};

/**
 * Validate an outgoing OpenAI Chat Completions body before it hits the wire.
 * Throws {@link MalformedBodyError} on the structural problems that produce
 * `400 Duplicate value for 'tool_call_id'` and similar opaque upstream
 * failures (#613). Exported for focused unit tests.
 */
/**
 * Strip `tool_calls` entries with an empty/missing `id` from assistant
 * messages, and drop orphan `role: "tool"` results that reference them.
 *
 * Recovers sessions whose history was persisted by the pre-fix strip stream
 * — that version emitted args-only SSE deltas (no id, no name) which Pi SDK
 * recorded as separate empty-id tool_calls. Without this sanitizer, every
 * replay of such history hits `validateOpenAiChatBody` with
 * `missing_tool_call_id` and the session is bricked.
 *
 * Mutates `body.messages` in place. Logs structured info if anything was
 * dropped. Exported for focused unit tests.
 */
export function sanitizeOpenAiHistoryInPlace(body: Record<string, unknown>): {
  droppedToolCalls: number;
  droppedToolResults: number;
} {
  const messages = body.messages as Array<{
    role?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }> | undefined;
  if (!Array.isArray(messages)) {
    return { droppedToolCalls: 0, droppedToolResults: 0 };
  }

  let droppedToolCalls = 0;
  const knownIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const cleaned = message.tool_calls.filter(tc => {
        if (typeof tc.id !== 'string' || tc.id === '') {
          droppedToolCalls++;
          return false;
        }
        knownIds.add(tc.id);
        return true;
      });
      if (cleaned.length !== message.tool_calls.length) {
        if (cleaned.length === 0) {
          delete message.tool_calls;
        } else {
          message.tool_calls = cleaned;
        }
      }
    }
  }

  let droppedToolResults = 0;
  if (droppedToolCalls > 0) {
    const filtered = messages.filter(message => {
      if (message.role !== 'tool') return true;
      const tcid = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (!tcid || !knownIds.has(tcid)) {
        droppedToolResults++;
        return false;
      }
      return true;
    });
    if (filtered.length !== messages.length) {
      body.messages = filtered;
    }
    debugLog(`[OpenAI History] Sanitized poisoned history: dropped ${droppedToolCalls} empty-id tool_call(s) and ${droppedToolResults} orphan tool result(s)`);
  }

  return { droppedToolCalls, droppedToolResults };
}

export function validateOpenAiChatBody(body: Record<string, unknown>): void {
  const messages = body.messages as Array<{
    role?: string;
    tool_call_id?: unknown;
    tool_calls?: Array<{
      id?: unknown;
      type?: string;
      function?: { name?: unknown };
    }>;
  }> | undefined;
  if (!Array.isArray(messages)) return;

  // Track every tool_call id we've seen on assistant messages. Duplicates
  // across messages are also illegal — OpenAI requires globally unique ids
  // within a single request.
  const seenIds = new Set<string>();
  const knownIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const id = typeof tc.id === 'string' ? tc.id : '';
        if (!id) {
          throw new MalformedBodyError({
            code: 'missing_tool_call_id',
            detail: `messages[${i}].tool_calls[*] missing id`,
            adapter: 'openai',
          });
        }
        if (seenIds.has(id)) {
          throw new MalformedBodyError({
            code: 'duplicate_tool_call_id',
            detail: `messages[${i}].tool_calls[*] reuses id "${id}" already seen earlier`,
            adapter: 'openai',
          });
        }
        seenIds.add(id);
        knownIds.add(id);

        const fnName = typeof tc.function?.name === 'string' ? tc.function.name.trim() : '';
        if (!fnName) {
          throw new MalformedBodyError({
            code: 'empty_tool_name',
            detail: `messages[${i}].tool_calls[*] (id="${id}") has empty function.name`,
            adapter: 'openai',
          });
        }
      }
    }

    if (msg.role === 'tool') {
      const tcid = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      if (!tcid) {
        throw new MalformedBodyError({
          code: 'missing_tool_call_id',
          detail: `messages[${i}] (role=tool) missing tool_call_id`,
          adapter: 'openai',
        });
      }
      if (!knownIds.has(tcid)) {
        // Tool result references an id that no preceding assistant message
        // emitted — usually the symptom of a failed reassembly.
        throw new MalformedBodyError({
          code: 'orphaned_function_call_output',
          detail: `messages[${i}] (role=tool) references unknown tool_call_id "${tcid}"`,
          adapter: 'openai',
        });
      }
    }
  }
}

/**
 * Validate an outgoing OpenAI Responses-API body before it hits the wire.
 * Throws {@link MalformedBodyError} on the structural problems that produce
 * `400 Missing required parameter: input[N].call_id` (#613). Run after
 * {@link repairResponsesHistoryInPlace}, which fixes the recoverable cases.
 * Exported for focused unit tests.
 */
export function validateOpenAiResponsesBody(body: Record<string, unknown>): void {
  const input = body.input as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(input)) return;

  const seenCallIds = new Set<string>();
  const knownCallIds = new Set<string>();

  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    if (!entry) continue;
    if (entry.type === 'function_call') {
      const callId = typeof entry.call_id === 'string' ? entry.call_id : '';
      if (!callId) {
        throw new MalformedBodyError({
          code: 'missing_call_id',
          detail: `input[${i}] (type=function_call) missing call_id`,
          adapter: 'openai-responses',
        });
      }
      if (seenCallIds.has(callId)) {
        throw new MalformedBodyError({
          code: 'duplicate_tool_call_id',
          detail: `input[${i}] (type=function_call) reuses call_id "${callId}"`,
          adapter: 'openai-responses',
        });
      }
      seenCallIds.add(callId);
      knownCallIds.add(callId);

      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name) {
        throw new MalformedBodyError({
          code: 'empty_tool_name',
          detail: `input[${i}] (type=function_call, call_id="${callId}") has empty name`,
          adapter: 'openai-responses',
        });
      }
    } else if (entry.type === 'function_call_output') {
      const callId = typeof entry.call_id === 'string' ? entry.call_id : '';
      if (!callId) {
        throw new MalformedBodyError({
          code: 'missing_call_id',
          detail: `input[${i}] (type=function_call_output) missing call_id`,
          adapter: 'openai-responses',
        });
      }
      if (!knownCallIds.has(callId)) {
        throw new MalformedBodyError({
          code: 'orphaned_function_call_output',
          detail: `input[${i}] (type=function_call_output) references unknown call_id "${callId}"`,
          adapter: 'openai-responses',
        });
      }
    }
  }
}

/**
 * In-place repair of Responses-API `input[]` arrays that arrive with structural
 * defects we can recover from. Mutates `input` and returns the number of repairs.
 *
 * - `function_call` entries missing `call_id` get a deterministic synthesized id.
 * - `function_call_output` entries referencing an unknown `call_id` are dropped
 *   (the upstream would 400 anyway; better to lose one tool result than the turn).
 *
 * Exported for focused unit tests.
 */
export function repairResponsesHistoryInPlace(input: Array<Record<string, unknown>>): {
  synthesizedCallIds: number;
  droppedOrphans: number;
} {
  let synthesizedCallIds = 0;
  let droppedOrphans = 0;
  const knownCallIds = new Set<string>();

  // First pass: synthesize missing call_ids on function_call entries so later
  // entries can reference them.
  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    if (!entry) continue;
    if (entry.type !== 'function_call') continue;
    if (typeof entry.call_id === 'string' && entry.call_id.length > 0) {
      knownCallIds.add(entry.call_id);
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name : 'unknown';
    const argsHash = typeof entry.arguments === 'string'
      ? hashShortString(entry.arguments)
      : '0';
    const synthetic = `repaired_${i}_${name}_${argsHash}`;
    entry.call_id = synthetic;
    knownCallIds.add(synthetic);
    synthesizedCallIds++;
    debugLog(`[OpenAI Responses Repair] Synthesized call_id "${synthetic}" for input[${i}] (name=${name})`);
  }

  if (synthesizedCallIds === 0 && input.every(e => e.type !== 'function_call_output')) {
    return { synthesizedCallIds, droppedOrphans };
  }

  // Second pass: drop orphan function_call_output entries.
  for (let i = input.length - 1; i >= 0; i--) {
    const entry = input[i];
    if (!entry) continue;
    if (entry.type !== 'function_call_output') continue;
    const callId = typeof entry.call_id === 'string' ? entry.call_id : '';
    if (!callId || !knownCallIds.has(callId)) {
      input.splice(i, 1);
      droppedOrphans++;
      debugLog(`[OpenAI Responses Repair] Dropped orphan function_call_output at input[${i}] (call_id="${callId}")`);
    }
  }

  return { synthesizedCallIds, droppedOrphans };
}

/** Tiny stable hash for synthesizing deterministic call_ids. Not a security primitive. */
function hashShortString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// ============================================================================
// ADAPTER REGISTRY
// ============================================================================

const adapters: ApiAdapter[] = [anthropicAdapter, openAiResponsesAdapter, openAiAdapter];

/**
 * Resolve Pi model API hint (if provided by pi-agent-server).
 * Example values: anthropic-messages, openai-completions, openai-responses.
 */
function getPiApiHint(): string | undefined {
  const hint = process.env.NESSY_PI_MODEL_API?.trim();
  return hint || undefined;
}

/**
 * Map Pi API hint to adapter name.
 * Exported for focused unit testing.
 */
export function resolveAdapterNameFromPiApiHint(piApiHint?: string): 'anthropic' | 'openai' | 'openai-responses' | undefined {
  if (!piApiHint) return undefined;
  if (piApiHint === 'anthropic-messages') return 'anthropic';
  if (piApiHint === 'openai-completions') return 'openai';
  if (piApiHint === 'openai-responses' || piApiHint === 'azure-openai-responses' || piApiHint === 'openai-codex-responses') {
    return 'openai-responses';
  }
  return undefined;
}

/**
 * Find the matching adapter for a request.
 * Priority:
 * 1) Pi API hint (robust, provider-native)
 * 2) URL pattern fallback — never `openAiAdapter` outside Pi ({@link urlFallbackAdapter}, F1.315)
 */
function findAdapter(url: string): ApiAdapter | undefined {
  const piApiHint = getPiApiHint();
  const hintedAdapter = resolveAdapterNameFromPiApiHint(piApiHint);
  if (hintedAdapter === 'anthropic') return anthropicAdapter;
  if (hintedAdapter === 'openai') return openAiAdapter;
  if (hintedAdapter === 'openai-responses') return openAiResponsesAdapter;

  return urlFallbackAdapter(url, process.env);
}

// ============================================================================
// ERROR CAPTURE (shared across all adapters)
// ============================================================================

/**
 * Capture API errors from responses for the error handler.
 */
async function captureApiError(response: Response, url: string): Promise<void> {
  if (response.status < 400) return;

  debugLog(`[Attempting to capture error for ${response.status} response]`);
  const errorClone = response.clone();
  try {
    const errorText = await errorClone.text();
    let errorMessage = response.statusText;
    let isHtmlResponse = false;

    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.error?.message) {
        errorMessage = errorJson.error.message;
      } else if (errorJson.message) {
        errorMessage = errorJson.message;
      }
    } catch {
      if (errorText) {
        isHtmlResponse = errorText.trimStart().startsWith('<');
        errorMessage = errorText;
      }
    }

    // An HTML response to a JSON API call means something intercepted the request —
    // a proxy, CDN, captive portal, or firewall. Never show raw HTML to the user.
    if (isHtmlResponse) {
      if (PROXY_URL) {
        errorMessage = `Received an unexpected HTML error page (HTTP ${response.status}) instead of a JSON API response. This may be caused by your network proxy (${redactProxyUrl(PROXY_URL)}). Check your proxy settings in Settings > Network.`;
      } else {
        errorMessage = `Received an unexpected HTML error page (HTTP ${response.status}) instead of a JSON API response. This could be caused by a firewall, captive portal, or network issue.`;
      }
      debugLog(`[Detected HTML error response — replaced raw HTML with clean message]`);
    }

    // Empty-body 400 (#613): some upstreams (Chinese OpenAI-compat relays,
    // misconfigured DeepSeek endpoints) return 400 with no body, leaving
    // users with `400 status code (no body)` and nothing to debug. Attach
    // a sanitized summary of the last outgoing request so the user — and
    // we — have something concrete to act on.
    if (response.status === 400 && !errorText.trim()) {
      const summary = getLastOutgoingRequest(url);
      if (summary) {
        const emptyNames = summary.toolNames.filter(n => n === '<empty>').length;
        const dupIds = summary.toolCallIds.length - new Set(summary.toolCallIds).size;
        const hints: string[] = [];
        if (emptyNames > 0) hints.push(`${emptyNames} tool call(s) with empty name`);
        if (dupIds > 0) hints.push(`${dupIds} duplicate tool_call_id(s)`);
        if (hints.length > 0) {
          errorMessage = `Endpoint rejected the request with no body. Likely cause: ${hints.join(', ')}. ` +
            `This usually means the upstream relay's tool-call streaming is broken — try a different ` +
            `model or endpoint. Last request had ${summary.toolCallIds.length} tool call(s) and ` +
            `${summary.toolResults} tool result(s) over ${summary.historyLength} history entries.`;
        } else {
          errorMessage = `Endpoint rejected the request with no body (no obvious shape problem). ` +
            `Last request: ${summary.toolCallIds.length} tool call(s), ${summary.toolResults} tool ` +
            `result(s), ${summary.historyLength} history entries. Try a different endpoint.`;
        }
        debugLog(`[Empty-body 400 enriched: ${errorMessage}]`);
      }
    }

    setStoredError({
      status: response.status,
      statusText: response.statusText,
      message: errorMessage,
      timestamp: Date.now(),
    });
    debugLog(`[Captured API error: ${response.status} ${errorMessage}]`);
  } catch (e) {
    setStoredError({
      status: response.status,
      statusText: response.statusText,
      message: response.statusText,
      timestamp: Date.now(),
    });
    debugLog(`[Error reading body, capturing basic info: ${e}]`);
  }
}

// ============================================================================
// DEBUG LOGGING (shared)
// ============================================================================

/**
 * Convert headers to cURL -H flags, redacting sensitive values
 */
function headersToCurl(headers: HeadersInitType | undefined): string {
  if (!headers) return '';

  const headerObj: Record<string, string> =
    headers instanceof Headers
      ? Object.fromEntries(Array.from(headers as unknown as Iterable<[string, string]>))
      : Array.isArray(headers)
        ? Object.fromEntries(headers)
        : (headers as Record<string, string>);

  const sensitiveKeys = ['x-api-key', 'authorization', 'cookie'];

  return Object.entries(headerObj)
    .map(([key, value]) => {
      const redacted = sensitiveKeys.includes(key.toLowerCase())
        ? '[REDACTED]'
        : value;
      return `-H '${key}: ${redacted}'`;
    })
    .join(' \\\n  ');
}

/**
 * Format a fetch request as a cURL command.
 *
 * UB1.10 (upstream v0.13.6, OSS #1033): request bodies are replaced by a size
 * placeholder unless `fullBodies` is set — they carry user prompts, tool
 * arguments and base64 image payloads, and logging them in full is what let
 * this log grow into the tens of GiB upstream. Opt in with
 * `NESSY_DEBUG_FULL_BODIES=1` (upstream's `CRAFT_DEBUG_FULL_BODIES`), or per
 * call through `fullBodies`. Exported for the curl contract test.
 */
export function toCurl(url: string, init?: RequestInit, fullBodies: boolean = DEBUG_FULL_BODIES): string {
  const method = init?.method?.toUpperCase() ?? 'GET';
  const headers = headersToCurl(init?.headers as HeadersInitType | undefined);

  let curl = `curl -X ${method}`;
  if (headers) {
    curl += ` \\\n  ${headers}`;
  }
  if (init?.body && typeof init.body === 'string') {
    const body = init.body;
    if (fullBodies) {
      const truncated = body.length > MAX_LOGGED_BODY_CHARS;
      const shown = truncated ? body.slice(0, MAX_LOGGED_BODY_CHARS) : body;
      const escapedBody = shown.replace(/'/g, "'\\''");
      const marker = truncated ? `... [BODY TRUNCATED: ${body.length} chars total]` : '';
      curl += ` \\\n  -d '${escapedBody}${marker}'`;
    } else {
      curl += ` \\\n  -d '[REQUEST BODY OMITTED: ${body.length} chars]'`;
    }
  }
  curl += ` \\\n  '${url}'`;

  return curl;
}

/**
 * Log response and capture API errors.
 */
async function logResponse(response: Response, url: string, startTime: number, adapter?: ApiAdapter): Promise<Response> {
  const duration = Date.now() - startTime;

  // Capture API errors (runs regardless of DEBUG mode)
  if (adapter) {
    await captureApiError(response, url);
  }

  if (!DEBUG) return response;

  debugLog(`\n\u2190 RESPONSE ${response.status} ${response.statusText} (${duration}ms)`);
  debugLog(`  URL: ${url}`);

  const respHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    respHeaders[key] = value;
  });
  debugLog('  Headers:', respHeaders);

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    debugLog('  Body: [SSE stream - not logged]');
    return response;
  }

  const clone = response.clone();
  try {
    const text = await clone.text();
    const maxLogSize = 5000;
    if (text.length > maxLogSize) {
      debugLog(`  Body (truncated to ${maxLogSize} chars):\n${text.substring(0, maxLogSize)}...`);
    } else {
      debugLog(`  Body:\n${text}`);
    }
  } catch (e) {
    debugLog('  Body: [failed to read]', e);
  }

  return response;
}

// ============================================================================
// REQUEST DIAGNOSTICS
// ============================================================================

/**
 * Sanitized snapshot of the most recent intercepted request body. Captured so
 * the empty-body 400 diagnostic can attach actionable context (which tools the
 * model tried to call) instead of letting users see "400 status code (no
 * body)" with nothing to act on.
 *
 * Tool arguments are NEVER stored — only counts, ids, and names. The data
 * never leaves this process; it's read by {@link captureApiError} and woven
 * into the stored error message.
 */
interface OutgoingRequestSummary {
  url: string;
  adapter: string;
  /** Timestamp the request was prepared (not sent). Used to expire stale entries. */
  preparedAt: number;
  /** Tool-call ids visible in the assistant tool_calls / function_call entries. */
  toolCallIds: string[];
  /** Tool names referenced. Empty strings are reported as "<empty>". */
  toolNames: string[];
  /** Number of tool result / function_call_output entries. */
  toolResults: number;
  /** Number of messages or input entries (whichever the adapter uses). */
  historyLength: number;
}

let lastOutgoingRequest: OutgoingRequestSummary | undefined;

function rememberLastOutgoingRequest(
  url: string,
  body: Record<string, unknown>,
  adapter: ApiAdapter,
): void {
  const summary: OutgoingRequestSummary = {
    url,
    adapter: adapter.name,
    preparedAt: Date.now(),
    toolCallIds: [],
    toolNames: [],
    toolResults: 0,
    historyLength: 0,
  };

  if (adapter.name === 'openai') {
    const messages = body.messages as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(messages)) {
      summary.historyLength = messages.length;
      for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls as Array<{ id?: unknown; function?: { name?: unknown } }>) {
            if (typeof tc.id === 'string') summary.toolCallIds.push(tc.id);
            const name = typeof tc.function?.name === 'string' ? tc.function.name : '';
            summary.toolNames.push(name || '<empty>');
          }
        }
        if (msg.role === 'tool') summary.toolResults++;
      }
    }
  } else if (adapter.name === 'openai-responses') {
    const input = body.input as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(input)) {
      summary.historyLength = input.length;
      for (const entry of input) {
        if (entry.type === 'function_call') {
          if (typeof entry.call_id === 'string') summary.toolCallIds.push(entry.call_id);
          const name = typeof entry.name === 'string' ? entry.name : '';
          summary.toolNames.push(name || '<empty>');
        } else if (entry.type === 'function_call_output') {
          summary.toolResults++;
        }
      }
    }
  }

  lastOutgoingRequest = summary;
}

/** Read by captureApiError; null when no recent request or summary is stale (>30s). */
function getLastOutgoingRequest(forUrl: string): OutgoingRequestSummary | undefined {
  if (!lastOutgoingRequest) return undefined;
  if (Date.now() - lastOutgoingRequest.preparedAt > 30_000) return undefined;
  if (lastOutgoingRequest.url !== forUrl) return undefined;
  return lastOutgoingRequest;
}

/**
 * Build a synthetic 400 Response that mimics OpenAI's error envelope so the
 * SDK surfaces the structured error instead of dying on a generic 400. Used
 * when {@link MalformedBodyError} fires before the request hits the wire.
 */
function synthesizeMalformedBodyResponse(
  err: MalformedBodyError,
  url: string,
  startTime: number,
  adapter: ApiAdapter,
): Promise<Response> {
  const body = JSON.stringify({
    error: {
      type: 'invalid_request_error',
      code: err.code,
      message: `Nessy Desktop blocked an outgoing request that the API would reject: ${err.detail}. ` +
        `This typically indicates a streaming-reassembly bug in the upstream endpoint or a stale ` +
        `tool history. Try starting a new session or switching to a different model/endpoint.`,
      param: 'tool_calls',
    },
  });

  debugLog(`[${adapter.name}] Outgoing body validation failed (${err.code}); synthesizing 400 response`);

  setStoredError({
    status: 400,
    statusText: 'Bad Request (blocked by Nessy Desktop)',
    message: err.detail,
    timestamp: Date.now(),
  });

  return logResponse(
    new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
    }),
    url,
    startTime,
    adapter,
  );
}

// ============================================================================
// INTERCEPTED FETCH
// ============================================================================

const originalFetch = globalThis.fetch.bind(globalThis);

async function interceptedFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  const startTime = Date.now();

  if (DEBUG) {
    debugLog('\n' + '='.repeat(80));
    debugLog('\u2192 REQUEST');
    debugLog(toCurl(url, init));
  }

  // Find matching adapter for this URL
  const adapter = findAdapter(url);

  if (
    adapter &&
    ((init?.method ?? (input instanceof Request ? input.method : undefined))?.toUpperCase() === 'POST')
  ) {
    try {
      const { bodyStr, normalizedInit } = await resolveRequestContext(input, init);
      if (bodyStr) {
        let parsed = JSON.parse(bodyStr);

        // Add _intent and _displayName to all tool schemas
        parsed = adapter.addMetadataToTools(parsed);
        // Re-inject stored metadata into conversation history (also runs the
        // Responses-API repair pass before metadata)
        parsed = adapter.injectMetadataIntoHistory(parsed);

        // Pre-flight validation. If the body is structurally invalid for this
        // adapter (duplicate tool_call_id, missing call_id, empty function
        // name, orphan tool result), short-circuit with a synthetic 400 the
        // SDK can surface clearly instead of dying on `400 status code (no
        // body)` from the upstream.
        if (adapter.validateOutgoingBody) {
          try {
            adapter.validateOutgoingBody(parsed);
          } catch (err) {
            if (err instanceof MalformedBodyError) {
              return synthesizeMalformedBodyResponse(err, url, startTime, adapter);
            }
            throw err;
          }
        }

        // Adapter-specific request modifications (e.g., fast mode)
        let modifiedInit = normalizedInit;
        if (adapter.modifyRequest) {
          const result = adapter.modifyRequest(url, normalizedInit, parsed);
          modifiedInit = result.init;
          parsed = result.body;
        }

        // F1.498 — a per-request `proxy` a caller already chose wins over this
        // module's launch-time copy; see `explicitProxy` below.
        const proxy = explicitProxy(init) ?? getProxyForUrl(url);
        // F1.519 item 3 — the caller's `tls` is kept; see `composedRequestTls`.
        const clientTls = url.startsWith('https:') ? composedRequestTls(init, getClientTlsIdentity()) : undefined;
        const finalBody = JSON.stringify(parsed);
        captureWireBody(url, finalBody);
        const finalInit = {
          ...modifiedInit,
          headers: prepareOutboundHeaders(url, modifiedInit.headers as HeadersLike),
          body: finalBody,
          ...(proxy ? { proxy } : {}),
          ...(clientTls ? { tls: clientTls } : {}),
        };

        // Cache a sanitized request summary for the 400-empty-body diagnostic
        // pathway in captureApiError. Plain-text bodies (sensitive arguments)
        // never leave this process.
        rememberLastOutgoingRequest(url, parsed, adapter);

        debugLog(`[${adapter.name}] Intercepted request to ${url}`);
        const response = await originalFetch(url, finalInit);

        // Process SSE response through adapter's stream processor
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/event-stream') && response.body) {
          debugLog(`[${adapter.name}] Creating SSE processor (${adapter.stripsSseMetadata ? 'strip' : 'capture'})`);
          const processor = adapter.createSseProcessor();
          const processedBody = response.body.pipeThrough(processor);
          const processedResponse = new Response(processedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          return logResponse(processedResponse, url, startTime, adapter);
        }

        // Non-SSE response — strip metadata from JSON body if present
        if (contentType.includes('application/json') && response.body) {
          const text = await response.text();
          const stripped = stripMetadataFieldsFromRawJson(text);
          return logResponse(new Response(stripped, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }), url, startTime, adapter);
        }

        return logResponse(response, url, startTime, adapter);
      }
    } catch (e) {
      debugLog(`[${adapter?.name}] FETCH modification failed:`, e);
    }
  }

  const proxy = explicitProxy(init) ?? getProxyForUrl(url);
  const clientTls = url.startsWith('https:') ? composedRequestTls(init, getClientTlsIdentity()) : undefined;
  let proxyInit: (RequestInit & { proxy?: string; tls?: RequestTlsOptions }) | undefined = (proxy || clientTls)
    ? { ...init, ...(proxy ? { proxy } : {}), ...(clientTls ? { tls: clientTls } : {}) }
    : init;
  if (input instanceof Request) {
    proxyInit = {
      ...(proxyInit ?? {}),
      headers: prepareOutboundHeaders(
        url,
        mergeRequestAndInitHeaders(input, proxyInit?.headers as HeadersLike),
      ),
    };
  } else {
    // No `proxyInit.headers` guard: a correlation or operator header has to
    // reach a request that carried no headers of its own, and the no-op path
    // inside prepareOutboundHeaders keeps an unconfigured process unchanged.
    const prepared = prepareOutboundHeaders(url, proxyInit?.headers as HeadersLike);
    if (prepared !== undefined) {
      proxyInit = { ...(proxyInit ?? {}), headers: prepared };
    }
  }
  const response = await originalFetch(input, proxyInit);
  return logResponse(response, url, startTime);
}

/**
 * F1.498 — the `proxy` a caller already put on this request, if any.
 *
 * On the headless server this module is the INNER layer: `config/network-runtime.ts`
 * wraps it and resolves each request's proxy per request (managed `env` block,
 * then Settings, then the environment — `resolveHostProxySelection`). This
 * module's `PROXY_URL` is a copy of the LAUNCH environment frozen at preload,
 * and overwriting the wrapper's choice with it inverted that ladder: a managed or
 * Settings proxy lost to whatever the server was launched with, on every codex
 * and claude-runtime upstream request (the loopback adapter's, made in that
 * process). An explicit choice now wins. In the Pi subprocess nothing sets one,
 * so Pi is unchanged.
 */
function explicitProxy(init: RequestInit | undefined): string | undefined {
  const value = (init as { proxy?: unknown } | undefined)?.proxy;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Bun's per-request TLS options, as far as this module reads them. */
type RequestTlsOptions = { ca?: unknown; cert?: string; key?: string; passphrase?: string } & Record<string, unknown>;

/**
 * F1.519 item 3 (P-WJai-3, DECIDED 2026-09-24) — the TLS options a request leaves
 * with, the `explicitProxy` rule applied to `tls`.
 *
 * On the headless server this module is the INNER layer, and the wrapper
 * (`config/network-runtime.ts`) hands each request the composed trust: the CA
 * set (a Settings, managed or bundled CA) plus the managed or Settings identity (F1.563).
 * Spreading `{ tls: <the environment's identity> }` after it REPLACED all of
 * that, so an operator with a Settings CA and an environment client certificate
 * got the certificate and lost the CA — a hop through a TLS-inspecting proxy
 * then failed its handshake. Now the caller's `tls` is kept; the environment's
 * identity only fills in an identity it lacks; a stored identity (a caller
 * `cert` or `key`) wins whole, never mixed with the environment's passphrase.
 * The desktop host hop follows the same rule (`network-proxy.ts`
 * `resolveHostClientIdentity`). In the Pi subprocess no caller passes `tls`, so
 * Pi is unchanged.
 */
function composedRequestTls(
  init: RequestInit | undefined,
  envIdentity: ClientTlsIdentity | undefined,
): RequestTlsOptions | undefined {
  const explicit = (init as { tls?: unknown } | undefined)?.tls;
  if (!explicit || typeof explicit !== 'object') return envIdentity;
  const chosen = explicit as RequestTlsOptions;
  if (!envIdentity || chosen.cert !== undefined || chosen.key !== undefined) return chosen;
  return { ...chosen, ...envIdentity };
}

// Create proxy to handle both function calls and static properties (e.g., fetch.preconnect in Bun)
const fetchProxy = new Proxy(interceptedFetch, {
  apply(target, thisArg, args) {
    return Reflect.apply(target, thisArg, args);
  },
  get(target, prop, receiver) {
    if (prop in originalFetch) {
      return (originalFetch as unknown as Record<string | symbol, unknown>)[
        prop
      ];
    }
    return Reflect.get(target, prop, receiver);
  },
});

// Auto-install in runtime subprocesses. Tests can disable this side effect.
if (process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL !== '1') {
  (globalThis as unknown as { fetch: unknown }).fetch = fetchProxy;
  debugLog('Unified fetch interceptor installed');
  // Names only, once, and never per request: an operator-supplied header
  // channel is where a token goes, so the value never reaches a log. A name
  // prefixed `!` was dropped as malformed.
  const configuredCustomHeaders = customHeaderNames();
  if (configuredCustomHeaders.length > 0) {
    debugLog(`[custom-headers] configured: ${configuredCustomHeaders.join(', ')}`);
  }
}

/**
 * F1.313 / F1.314 — the rest of an SSE chunk whose non-empty `tool_calls`
 * `createOpenAiSseStrippingStream` has just buffered. That branch used to drop
 * the whole chunk, which is right for the tool-call payload (it is re-emitted
 * once, consolidated, on flush) and wrong for everything riding beside it:
 *
 * - F1.314 — `content` / reasoning in the same delta ("Let me read." + a Read
 *   call) was lost silently. Emitted FIRST, as its own chunk, because the text
 *   precedes the call it introduces. A delta whose only other field is `role`
 *   (or empty values) carries nothing and emits nothing, so an ordinary
 *   tool-call stream stays byte-identical.
 * - F1.313 — a `finish_reason` (and `usage`) in the same chunk was lost, so
 *   pi-ai ended a well-formed tool-call turn with `Stream ended without
 *   finish_reason` (its openai-completions `stream()` requires one). On a
 *   finish the buffered calls are flushed, then a synthesized
 *   `{ choices: [{ index, delta: {}, finish_reason }], usage }` follows — the
 *   same order the non-tool finish branch keeps. `usage` without a finish is
 *   forwarded on its own chunk WITHOUT flushing, since more argument deltas for
 *   the same call may still come.
 *
 * craft-agents-oss v0.13.4 carries the same early return (nothing to port);
 * the shape is ours, decided by the F1.313 / F1.314 rows.
 */
function emitHandledChunkRest(
  data: Record<string, unknown>,
  flushBufferedCalls: () => void,
  emit: (dataStr: string) => void,
): void {
  const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
  const { choices: _choices, usage, ...top } = data;
  const rest = choices.flatMap((choice) => {
    const delta: Record<string, unknown> = { ...(choice.delta as Record<string, unknown> | undefined) };
    delete delta.tool_calls;
    const carries = Object.entries(delta).some(
      ([key, value]) => key !== 'role' && value !== null && value !== undefined && value !== '',
    );
    return carries ? [{ index: choice.index ?? 0, delta }] : [];
  });
  if (rest.length > 0) emit(JSON.stringify({ ...top, choices: rest }));

  const finishing = choices.some((choice) => !!choice.finish_reason);
  const choiceUsage = choices.some((choice) => choice.usage !== undefined);
  if (!finishing && usage === undefined && !choiceUsage) return;
  if (finishing) flushBufferedCalls();
  emit(JSON.stringify({
    ...top,
    ...(usage !== undefined ? { usage } : {}),
    choices: choices.map((choice) => ({
      index: choice.index ?? 0,
      delta: {},
      finish_reason: choice.finish_reason ?? null,
      ...(choice.usage !== undefined ? { usage: choice.usage } : {}),
    })),
  }));
}

/**
 * F1.315 — the URL-pattern fallback of {@link findAdapter}, with `openAiAdapter` scoped to
 * the process it was designed for: the Pi subprocess.
 *
 * This file is preloaded into TWO kinds of process. The Pi subprocess carries the spawn-site
 * marker from birth (F1.531, {@link runsInPiSubprocess}) and `NESSY_PI_MODEL_API` while it has
 * a model (pi-agent-server's `setInterceptorApiHints` deletes it with the model). The headless server
 * (`bin/nessy-server`, `scripts/build/interceptor-pairing.ts` symbol
 * `interceptorPreloadFragment`) never does, and there a codex or `claude-runtime`
 * session's OpenAI-wire upstream hop — the host's loopback adapter, through
 * `gatewaySessionFetch`, whose `inner` is this process's global fetch — met
 * `openAiAdapter` by URL: `_intent`/`_displayName` injected into MCP tool schemas, tool
 * calls consolidated, `tool_calls: []` keys deleted. The packaged desktop app's main
 * process preloads nothing, so the SAME sessions never met it there.
 *
 * Read before scoping, as decided: nothing on those two runtimes relies on it. Their
 * translator reads the chat stream itself (`codex-responses-adapter` `from-chat-stream.ts`
 * iterates `delta.tool_calls ?? []`), nothing reads the `_intent` metadata it would capture
 * for them, and the desktop — the deployment every such session also runs on — has always
 * run them without it. So outside Pi a `/chat/completions` request takes the pass-through
 * branch: proxy, TLS identity and the outbound header layers still apply, the rewrite does
 * not. The Anthropic and Responses adapters keep their URL fallback — the Anthropic one is
 * the headless half of an agreement `upgradePromptCacheTtl`'s docblock pins, and no
 * codex/claude hop posts to a `/responses` upstream. Residue, named: a headless server
 * launched from INSIDE a Pi tool call inherits the hint and reads as Pi.
 *
 * Exported for focused unit testing.
 */
export function urlFallbackAdapter(url: string, env: Readonly<Record<string, string | undefined>>): ApiAdapter | undefined {
  const byUrl = adapters.find(a => a.shouldIntercept(url));
  if (byUrl === openAiAdapter && !runsInPiSubprocess(env)) return undefined;
  return byUrl;
}
