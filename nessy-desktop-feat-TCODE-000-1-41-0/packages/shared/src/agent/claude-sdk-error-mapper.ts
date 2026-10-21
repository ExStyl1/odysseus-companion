import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentError } from './errors.ts';
import type { LastApiError } from '../interceptor-common.ts';
import { getProviderMetadata, getProviderDisplayName } from '../config/provider-metadata.ts';
import { IMAGE_REFUSAL_DETAIL_PREFIX, isNamedImageRefusal } from '../config/llm-connections.ts'; import { readClaudeCliVersion } from './claude-transcript-rebuild.ts';

export interface ClaudeSdkApiError {
  errorType: string;
  message: string;
  requestId?: string;
}

export interface ClaudeSdkErrorContext {
  actualError: ClaudeSdkApiError | null;
  capturedApiError: LastApiError | null;
  providerType?: string;
  piAuthProvider?: string;
  /**
   * The upstream mode the claude-runtime local adapter resolved at postInit
   * ('nestor' | 'openai-compatible' | 'anthropic-messages'). Gates the
   * "gateway sign-in expired" wording to the gateway upstream only — a BYO
   * connection has its own credentials and no gateway sign-in (T28). Absent
   * means unresolved; the mapper then keeps its historical gateway wording.
   */
  claudeRuntimeUpstreamKind?: string;
  /**
   * True when the just-sent user turn included image/PDF attachments. Used to
   * decide whether the generic invalid_request fallback should mention
   * attachments at all — when the user sent a plain-text turn, attachment
   * advice is misleading.
   */
  userTurnHadAttachments?: boolean;
}

type FailureKind = 'provider' | 'network' | 'unknown';

const PROVIDER_HINTS = [
  'internal server error',
  'overloaded',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'api_error',
  'overloaded_error',
  'upstream',
] as const;

const NETWORK_HINTS = [
  'fetch failed',
  'network',
  'econnrefused',
  'enotfound',
  'timed out',
  'timeout',
  'dns',
  'connection reset',
  'connection refused',
] as const;

// Signals specific to 1M context access. F1.1241: there is no Extended Context
// switch to point at any more (each model's own window decides), so the advice
// names the model, /compact and the operator's cap — the matcher stays precise.
const ONE_M_CONTEXT_HINTS = [
  'context-1m',
  'context_1m',
] as const;

// Phrases that, when paired with the word "tier", confirm the error is about
// 1M context access specifically (vs. tier-gated images, models, audio,
// document support, etc.). The bare word "tier" is far too broad on its own.
const ONE_M_TIER_PHRASES = [
  'context',
  '1m',
  'extended',
  '200k',
  '1000k',
] as const;

// Signals that the request exceeded the model's context window in general,
// not specifically 1M. These map to a "Context Window Exceeded" error with
// /compact + new-session advice — appropriate for any tier.
const CONTEXT_OVERFLOW_HINTS = [
  'context window',
  'context_window',
  'exceeds the context',
  'prompt is too long',
  'prompt exceeds',
  'too many tokens',
  'maximum context',
  'context length',
  'input is too long',
] as const;

// Phrases that indicate the API actually rejected an attachment (vs. a
// generic context/format issue mislabeled as invalid_request). Only when one
// of these fires — or the user-sent turn included an attachment — do we
// surface attachment-specific advice.
const ATTACHMENT_REJECTION_HINTS = [
  'image',
  'attachment',
  'media',
  'unsupported format',
  'could not process',
] as const;

function isOneMContextError(context: ClaudeSdkErrorContext): boolean {
  const haystack = [
    normalize(context.capturedApiError?.message),
    normalize(context.actualError?.message),
  ].join(' ');
  if (includesAny(haystack, ONE_M_CONTEXT_HINTS)) return true;
  // "tier" alone is ambiguous — only counts as 1M when it co-occurs with a
  // context-window-specific phrase. Image/model/audio/feature-tier errors
  // are deliberately excluded.
  if (haystack.includes('tier') && includesAny(haystack, ONE_M_TIER_PHRASES)) {
    return true;
  }
  return false;
}

function isContextOverflowError(context: ClaudeSdkErrorContext): boolean {
  const haystack = [
    normalize(context.capturedApiError?.message),
    normalize(context.actualError?.message),
  ].join(' ');
  return includesAny(haystack, CONTEXT_OVERFLOW_HINTS);
}

function isAttachmentRejection(context: ClaudeSdkErrorContext): boolean {
  const haystack = [
    normalize(context.capturedApiError?.message),
    normalize(context.actualError?.message),
  ].join(' ');
  return includesAny(haystack, ATTACHMENT_REJECTION_HINTS);
}

function normalize(value?: string | null): string {
  return value?.toLowerCase() ?? '';
}

function includesAny(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function formatStatus(error: LastApiError): string {
  return error.statusText?.trim()
    ? `${error.status} ${error.statusText}`
    : String(error.status);
}

function buildApiDetails(context: ClaudeSdkErrorContext): string[] {
  const details: string[] = [];

  const add = (value?: string) => {
    if (!value) return;
    if (!details.includes(value)) details.push(value);
  };

  if (context.capturedApiError) {
    add(`Status: ${formatStatus(context.capturedApiError)}`);
    if (context.capturedApiError.message && context.capturedApiError.message !== context.capturedApiError.statusText) {
      // P6.584, the whole of the turn-error seam: a NAMED image refusal is
      // anchored instead of being filed under the generic `API message:`
      // prefix, so the renderer's learn-writer has something exact to match
      // and the panel still prints the endpoint's sentence exactly once. Every
      // other message — a generic 400 included — takes the branch it always
      // took, which is what "never on a generic 400" means here.
      add(isNamedImageRefusal(context.capturedApiError.message)
        ? `${IMAGE_REFUSAL_DETAIL_PREFIX}${context.capturedApiError.message}`
        : `API message: ${context.capturedApiError.message}`);
    }
  }

  if (context.actualError?.message) {
    add(`Error: ${context.actualError.message}`);
  }

  if (context.actualError?.errorType) {
    add(`Type: ${context.actualError.errorType}`);
  }

  if (context.actualError?.requestId) {
    add(`Request ID: ${context.actualError.requestId}`);
  }

  return details;
}

function classifyFailure(errorCode: SDKAssistantMessageError, context: ClaudeSdkErrorContext): FailureKind {
  const status = context.capturedApiError?.status;
  const actualType = normalize(context.actualError?.errorType);
  const actualMessage = normalize(context.actualError?.message);
  const capturedMessage = normalize(context.capturedApiError?.message);

  const hasProviderStatus = typeof status === 'number' && (status >= 500 || status === 529);
  const hasProviderType =
    actualType.includes('api_error') ||
    actualType.includes('overloaded') ||
    actualType.includes('server_error');
  const hasProviderText =
    includesAny(actualMessage, PROVIDER_HINTS) ||
    includesAny(capturedMessage, PROVIDER_HINTS);
  const hasNetworkText =
    includesAny(actualMessage, NETWORK_HINTS) ||
    includesAny(capturedMessage, NETWORK_HINTS);

  // SDK explicit server_error should be treated as provider-side unless we have strong
  // evidence of local network failure and no provider-side signal.
  if (errorCode === 'server_error') {
    if (hasNetworkText && !hasProviderStatus && !hasProviderType && !hasProviderText) {
      return 'network';
    }
    return 'provider';
  }

  if (hasProviderStatus || hasProviderType || hasProviderText) {
    return 'provider';
  }

  if (hasNetworkText) {
    return 'network';
  }

  return 'unknown';
}

export function mapClaudeSdkAssistantError(
  errorCode: SDKAssistantMessageError,
  context: ClaudeSdkErrorContext,
): AgentError {
  const apiDetails = buildApiDetails(context);
  const failureKind = classifyFailure(errorCode, context);
  const providerInfo = getProviderMetadata(
    context.providerType ?? 'anthropic',
    context.piAuthProvider,
  ) ?? undefined;

  const retryAction = [{ key: 'r', label: 'Retry', action: 'retry' as const }];

  const providerError: AgentError = {
    code: 'provider_error',
    title: 'AI Provider Issue',
    message: 'The AI provider may be experiencing temporary issues. Please retry in a moment.',
    details: [
      ...apiDetails,
      'Your credentials and local setup may still be correct.',
    ],
    actions: retryAction,
    canRetry: true,
    retryDelayMs: 5000,
    providerInfo,
  };

  const networkError: AgentError = {
    code: 'network_error',
    title: 'Connection Error',
    message: 'Unable to connect to the API server. Check your internet connection.',
    details: [
      ...apiDetails,
      'Verify your network connection is active',
      'Firewall or VPN may be blocking the connection',
    ],
    actions: retryAction,
    canRetry: true,
    retryDelayMs: 2000,
    providerInfo,
  };

  /**
   * A 403 IS NOT AN AUTH FAILURE, and telling the user it is sends them to
   * re-enter a working key.
   *
   * Measured 2026-08-15: llm-proxy answers a Claude-runtime turn with
   * `403 {"error":"… Security Guardrail Triggered: Malicious MCP detected.
   * Invalid tools: …"}` — the request WAS authenticated, and the endpoint then
   * refused its tool list. The SDK reports that as `authentication_failed`, so
   * this mapper produced "Your API key may be invalid or expired" and a
   * planner spent an hour hunting a credential bug that did not exist.
   *
   * 401 keeps the credential wording. 403 means authenticated-but-refused, and
   * the upstream body is the only thing that knows why, so it is carried
   * through instead of being replaced with a guess.
   */
  const status = context.capturedApiError?.status;
  const upstreamReason = context.capturedApiError?.message?.trim();
  if (errorCode === 'authentication_failed' && status === 403) {
    return {
      code: 'provider_error',
      title: 'Request Refused',
      message: upstreamReason
        ? `The endpoint accepted your credentials and refused the request: ${upstreamReason.slice(0, 300)}`
        : 'The endpoint accepted your credentials and refused this request.',
      details: [
        ...apiDetails,
        'This is not a credential problem — the request authenticated and was then rejected.',
        'A gateway or proxy in front of the model may be filtering requests by policy.',
      ],
      actions: retryAction,
      canRetry: false,
      providerInfo,
    };
  }

  switch (errorCode) {
    case 'authentication_failed':
      // The Claude Code (Nessy Gateway) card authenticates through the
      // one-click dp sign-in — it has no API key field. Measured support
      // complaint: a user hit `401 {"error":"fail parse token claims: ...
      // token is malformed"}` on that card and was told "Your API key may be
      // invalid or expired", then went hunting for a credential field that
      // does not exist on this card. Every other providerType (including
      // none at all) keeps the API-key wording below unchanged.
      //
      // Scoped to the GATEWAY upstream (T28, measured 2026-08-21): a BYO
      // claude-runtime connection (llm-proxy) hit the guardrail 403 with no
      // captured status and was told its "Nessy Gateway sign-in is missing or
      // expired" — a sign-in that connection does not have. A BYO upstream
      // keeps the API-key wording below, which names the credential the card
      // actually carries. An UNRESOLVED kind keeps the gateway wording — the
      // gateway is the only claude-runtime card that exists out of the box.
      if (
        context.providerType === 'claude-runtime'
        && context.claudeRuntimeUpstreamKind !== 'openai-compatible'
        && context.claudeRuntimeUpstreamKind !== 'anthropic-messages'
      ) {
        return {
          code: 'invalid_api_key',
          title: 'Authentication Failed',
          message: 'Your Nessy Gateway sign-in is missing or expired. Open Settings → AI and click Sign in on the gateway card.',
          details: [
            'This connection authenticates through the one-click Nessy Gateway sign-in — it has no API key.',
            'Using a custom endpoint on this card? Check that endpoint\'s own credentials instead.',
          ],
          actions: [
            { key: 's', label: 'Settings', action: 'settings' },
            { key: 'r', label: 'Retry', action: 'retry' },
          ],
          canRetry: true,
          retryDelayMs: 1000,
          providerInfo,
        };
      }
      return {
        code: 'invalid_api_key',
        title: 'Authentication Failed',
        message: 'Unable to authenticate. Your API key may be invalid or expired.',
        details: ['Check your API key in settings', 'Ensure your API key has not been revoked'],
        actions: [
          { key: 's', label: 'Settings', action: 'settings' },
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 1000,
        providerInfo,
      };

    case 'billing_error':
      return {
        code: 'billing_error',
        title: 'Billing Error',
        message: 'Your account has a billing issue.',
        details: ['Check your account billing status'],
        actions: [{ key: 's', label: 'Update credentials', action: 'settings' }],
        canRetry: false,
        providerInfo,
      };

    // I2.10 - `account_on_hold` is the ELEVENTH `SDKAssistantMessageError`
    // value, arrived at the 0.3.247 lift and byte-identical at the vendored
    // 0.3.251. Without an arm it fell to `default`, which tells the user "An
    // unexpected error occurred ... This may be a temporary issue ... Check your
    // network connection" and offers a retry at 2 s. Every one of those four
    // clauses is wrong for this code: an account on hold is not unexpected, not
    // temporary, not a network condition, and retrying cannot clear it. That is
    // worse than no arm, because it sends the user to diagnose their wifi.
    //
    // It sits beside `billing_error` deliberately: both are account-state
    // refusals the user resolves outside this app, and neither is retryable. It
    // is NOT merged into that arm, because the remedies differ - a billing issue
    // is a payment method, a hold is an account the provider has suspended - and
    // a message naming the wrong one costs the same support thread twice.
    //
    // The three siblings this arm's first version named as still falling to
    // `default` - `oauth_org_not_allowed`, `model_not_found` and `overloaded` -
    // are the row D1.199 below, and they have their own arms now. Derived from
    // the union in `sdk.d.ts` - eleven members - not from a count in prose.
    //
    // I2.10 landed this comment and this arm TWICE in one commit (`34aa88785`),
    // which `no-duplicate-case` rejects and `lint:shared` reddened on until
    // D1.199 deleted the second copy. The two differed only in ASCII hyphen vs
    // em dash, so the surviving copy is the one that was reachable and nothing
    // a user reads changed.
    case 'account_on_hold':
      return {
        code: 'billing_error',
        title: 'Account On Hold',
        message: 'The provider has put this account on hold, so it cannot serve requests.',
        details: [
          ...apiDetails,
          'This is an account state, not a temporary failure - retrying will not clear it',
          'Resolve the hold with the account provider, then start a new turn',
        ],
        actions: [{ key: 's', label: 'Update credentials', action: 'settings' }],
        canRetry: false,
        providerInfo,
      };

    /**
     * D1.199 — the last three `SDKAssistantMessageError` members that had no
     * arm. With the eleven-member union above and eight arms below them, these
     * three fell to `default`: `code: 'unknown_error'`, "An unexpected error
     * occurred", "This may be a temporary issue", "Check your network
     * connection", retry at 2 s. For the first two every clause is wrong; for
     * `overloaded` only the title is, and a title reading "Unknown Error" for
     * the one condition the provider has NAMED is what sends a user to their
     * router.
     *
     * The host's own reverse map was the nearest documented solution and is
     * where these `ErrorCode`s come from, rather than being chosen here:
     * `STOP_FAILURE_DOCUMENTED_ERROR` (`automations/utils.ts`) already carries
     * `invalid_model` → `model_not_found` and `provider_error` → `overloaded`.
     * That map runs the OTHER way (ours → the documented name) and its comment
     * saying `oauth_org_not_allowed` has no Nessy producer stays true: nothing
     * maps ONTO that name. Consuming a documented code and emitting one are
     * different directions and neither of these arms changes the other.
     *
     * With these three the switch covers all eleven members, so `default` is
     * now reachable only for a member a LATER SDK adds — which is what it is
     * for, and what the test's forward-compat case pins.
     */
    case 'oauth_org_not_allowed':
      return {
        code: 'invalid_credentials',
        title: 'Organization Not Allowed',
        message: 'The account signed in, but its organization is not allowed to use this API.',
        details: [
          ...apiDetails,
          'The credentials are valid — the organization behind them is not permitted, so retrying cannot clear it',
          'Sign in with an account in an allowed organization, or ask your organization administrator for access',
        ],
        actions: [{ key: 's', label: 'Update credentials', action: 'settings' }],
        canRetry: false,
        providerInfo,
      };

    case 'model_not_found':
      return {
        code: 'invalid_model',
        title: 'Model Not Found',
        message: 'The provider does not recognize the selected model, or this account cannot use it.',
        details: [
          ...apiDetails,
          'This is not a temporary failure — resending the same model will fail the same way',
          'Pick a different model for this connection in Settings → AI',
        ],
        actions: [{ key: 's', label: 'Settings', action: 'settings' }],
        canRetry: false,
        providerInfo,
      };

    // `overloaded` IS the provider saying so, so unlike `server_error` this arm
    // does not consult `classifyFailure`: with no captured status and no
    // message text that classifier answers `unknown`, and the SDK's own code is
    // the stronger signal. `providerError` is already the right shape — "may be
    // experiencing temporary issues", retry at 5 s — so this is a reuse rather
    // than a fourth copy of it.
    case 'overloaded':
      return providerError;

    case 'rate_limit':
      return {
        code: 'rate_limited',
        title: 'Rate Limit Exceeded',
        message: 'Too many requests. Please wait a moment before trying again.',
        details: ['Rate limits reset after a short period', 'Consider upgrading your plan for higher limits'],
        actions: retryAction,
        canRetry: true,
        retryDelayMs: 5000,
        providerInfo,
      };

    case 'invalid_request': {
      const versionFloor = claudeCodeVersionTooOld(context);
      if (versionFloor) return versionTooOldError(versionFloor, apiDetails, providerInfo);
      if (isOneMContextError(context)) {
        return {
          code: 'invalid_request',
          title: '1M Context Not Available',
          message: 'The request exceeded the standard 200K context window, and 1M context is not available for this model on your account.',
          details: [
            ...apiDetails,
            'Run /compact to reduce context, or start a new conversation',
            'Or pick a model with a smaller context window',
            'An administrator can cap every session at 200K with CLAUDE_CODE_DISABLE_1M_CONTEXT=1',
          ],
          actions: [
            { key: 'c', label: 'Compact', command: '/compact' },
          ],
          // Retrying the same payload won't help — the user must compact history
          // or change model first. Hiding the button is correct UX.
          canRetry: false,
          providerInfo,
        };
      }

      if (isContextOverflowError(context)) {
        return {
          code: 'invalid_request',
          title: 'Context Window Exceeded',
          message: 'The conversation has grown larger than the model can handle.',
          details: [
            ...apiDetails,
            'Run /compact to summarize history and free up context',
            'Or start a new conversation to keep going',
          ],
          actions: [
            { key: 'c', label: 'Compact', command: '/compact' },
          ],
          // Same as 1M case: retrying without changing the payload hits the
          // same wall, so suppress the button.
          canRetry: false,
          providerInfo,
        };
      }

      // Generic fallback. Only surface attachment hints when the API actually
      // mentioned an attachment-shaped problem OR the user-sent turn included
      // attachments. Otherwise the "remove attachments" advice misleads users
      // whose conversation history is poisoned by oversized tool results.
      const showAttachmentHints =
        context.userTurnHadAttachments === true || isAttachmentRejection(context);
      const fallbackHints: string[] = [];
      if (showAttachmentHints) {
        fallbackHints.push('Try removing any attachments and resending');
        fallbackHints.push('Check if images are in a supported format (PNG, JPEG, GIF, WebP)');
      } else {
        fallbackHints.push('If this keeps repeating, the conversation may have grown too large — try /compact or start a new session');
      }
      // When neither error source provided detail, tell the user where to look
      // instead of leaving them with vague advice.
      if (apiDetails.length === 0) {
        fallbackHints.push("No detailed error info available — check the app's main process log for the raw response");
      }

      return {
        code: 'invalid_request',
        title: 'Invalid Request',
        message: 'The API rejected this request.',
        details: [...apiDetails, ...fallbackHints],
        actions: retryAction,
        canRetry: true,
        retryDelayMs: 1000,
        providerInfo,
      };
    }

    case 'server_error':
      return failureKind === 'network' ? networkError : providerError;

    case 'max_output_tokens':
      return {
        code: 'invalid_request',
        title: 'Output Too Large',
        message: 'The response exceeded the maximum output token limit.',
        details: ['Try breaking the task into smaller parts', 'Reduce the scope of the request'],
        actions: retryAction,
        canRetry: true,
        retryDelayMs: 1000,
        providerInfo,
      };

    case 'unknown': {
      if (failureKind === 'provider') {
        return providerError;
      }

      if (failureKind === 'network') {
        return networkError;
      }

      return {
        code: 'unknown_error',
        title: 'Unknown Error',
        message: 'An unexpected error occurred.',
        details: [
          ...apiDetails,
          'This may be a temporary issue',
          'Check your network connection',
        ],
        actions: retryAction,
        canRetry: true,
        retryDelayMs: 2000,
        providerInfo,
      };
    }

    /**
     * F1.255 — the TWELFTH `SDKAssistantMessageError` member, arrived at the
     * 0.3.267 lift; `EVERY_SDK_ERROR_CODE` in the test stopped compiling, which
     * is the instrument D1.199 built for this day. Without an arm it fell to
     * `default` and told the user to check their network.
     *
     * Read from the vendored 2.1.267 binary rather than guessed: the classifier
     * answers `cloud_credential_error` when a cloud provider's credential chain
     * cannot be LOADED (Bedrock, Vertex, Foundry), and the CLI's own message is
     * *"Could not load <provider> credentials · <cause>. Check or refresh your
     * <provider> credentials and try again."*, marked transient — refreshing
     * the credentials and retrying is the documented remedy. So: a credential
     * problem, not a network one, and retryable once refreshed.
     */
    case 'cloud_credential_error':
      return {
        code: 'invalid_credentials',
        title: 'Cloud Credentials Unavailable',
        message: 'The cloud provider credentials for this model could not be loaded.',
        details: [
          ...apiDetails,
          'Check or refresh the cloud provider credentials this connection uses (for example an expired AWS or Google Cloud sign-in)',
          'This is a credential problem, not a network one — retry once the credentials are refreshed',
        ],
        actions: [
          { key: 's', label: 'Settings', action: 'settings' },
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 1000,
        providerInfo,
      };

    /**
     * F1.1213 — the THIRTEENTH member, `verification_required` (SDK 0.3.268,
     * vendored at the 0.3.274 lift; `EVERY_SDK_ERROR_CODE` stopped compiling
     * again, TS2741). No docs page names it, so it was read from the vendored
     * 2.1.274 binary (`grep -a` over the native `claude`, 20 occurrences): the
     * CLI answers it for a 403 `permission_error` whose
     * `details.error_code` is `verification_required`, labels it
     * "organization verification required", shows the server's own message
     * (sanitised, keeping its https link), throws it out of the retry loop
     * without a retry, and a goal loop STOPS on it. So: an organization account
     * state the user must clear outside Nessy, never a network problem, and no
     * retry until it is cleared. The server's sentence — the only place the
     * next step is named — reaches the card through `apiDetails`.
     */
    case 'verification_required':
      return {
        code: 'invalid_credentials',
        title: 'Organization Verification Required',
        message: 'The provider requires this organization to complete a verification step before it serves this request.',
        details: [
          ...apiDetails,
          'Complete the verification the provider message names (it usually carries a link), then start a new turn',
          'This is an account state, not a temporary failure - retrying will not clear it',
        ],
        actions: [{ key: 's', label: 'Settings', action: 'settings' }],
        canRetry: false,
        providerInfo,
      };

    default:
      return {
        code: 'unknown_error',
        title: 'Unknown Error',
        message: 'An unexpected error occurred.',
        details: [
          ...apiDetails,
          'This may be a temporary issue',
          'Check your network connection',
        ],
        actions: retryAction,
        canRetry: true,
        retryDelayMs: 2000,
        providerInfo,
      };
  }
}

/**
 * F1.1213 (H7) — the 400 `claude_code_version_too_old`.
 *
 * Contract: errors.md, section "Claude Code does not support this model"
 * (https://code.claude.com/docs/en/errors#claude-code-does-not-support-this-model):
 * "The API refused the request with a 400 because your Claude Code version is
 * below a required minimum. Either the model you selected requires a newer
 * version, which the server checks per model, or your organization's policy
 * requires one. The 400 carries the error code `claude_code_version_too_old`,
 * and the message says which minimum applies."
 *
 * The SDK reports it as `invalid_request` (vendored 2.1.274:
 * `…{error:"invalid_request",apiError:"claude_code_version_too_old"}`; the
 * typed `api_error` is internal and not on `SDKAssistantMessage`), so the
 * mapper recognises it by the documented code — present in a raw upstream body
 * — or by the two documented message forms. Without this it read "Invalid
 * Request" with a Retry that cannot succeed: the bundled Claude Code changes
 * only with a Nessy release.
 */
interface ClaudeCodeVersionFloor {
  /** The minimum the per-model wording names; absent for the organization-policy wording. */
  required?: string;
  organizationPolicy: boolean;
}

const VERSION_TOO_OLD_CODE = 'claude_code_version_too_old';
const PER_MODEL_FLOOR = /claude code \S+ does not support this model; version (\d+(?:\.\d+)+) or newer is required/i;
const ORGANIZATION_FLOOR = /claude code \S+ is older than the minimum version required by your organization/i;

function claudeCodeVersionTooOld(context: ClaudeSdkErrorContext): ClaudeCodeVersionFloor | null {
  const haystack = [context.capturedApiError?.message, context.actualError?.message, context.actualError?.errorType]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const perModel = PER_MODEL_FLOOR.exec(haystack);
  if (perModel) return { required: perModel[1], organizationPolicy: false };
  if (ORGANIZATION_FLOOR.test(haystack)) return { organizationPolicy: true };
  if (haystack.includes(VERSION_TOO_OLD_CODE)) return { organizationPolicy: false };
  return null;
}

function versionTooOldError(
  floor: ClaudeCodeVersionFloor,
  apiDetails: string[],
  providerInfo: AgentError['providerInfo'],
): AgentError {
  const bundled = readClaudeCliVersion();
  const message = floor.organizationPolicy
    ? `Your organization requires a newer Claude Code than the bundled runtime (${bundled}).`
    : floor.required
      ? `This model needs Claude Code ${floor.required} or newer; the bundled runtime is ${bundled}.`
      : `This model needs a newer Claude Code; the bundled runtime is ${bundled}.`;
  return {
    code: 'invalid_request',
    title: 'Claude Code Update Required',
    message,
    details: [
      ...apiDetails,
      'The Claude Code runtime ships inside Nessy, so it is updated only by a newer Nessy release - retrying will not help',
      ...(floor.organizationPolicy
        ? ['Update Nessy when a newer release is available, or ask your organization administrator about the policy']
        : ['Pick another model for this connection in Settings → AI to keep working, or update Nessy when a newer release is available']),
    ],
    actions: [{ key: 's', label: 'Settings', action: 'settings' }],
    canRetry: false,
    providerInfo,
  };
}
