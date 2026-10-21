import { describe, expect, it } from 'bun:test';
import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import { mapClaudeSdkAssistantError } from '../claude-sdk-error-mapper.ts';
import { readClaudeCliVersion } from '../claude-transcript-rebuild.ts';

const baseContext = {
  actualError: null,
  capturedApiError: null,
} as const;

describe('mapClaudeSdkAssistantError', () => {
  it('maps server_error to provider_error', () => {
    const error = mapClaudeSdkAssistantError('server_error', baseContext);

    expect(error.code).toBe('provider_error');
    expect(error.message.toLowerCase()).toContain('provider');
  });

  it('maps unknown + captured 500 to provider_error', () => {
    const error = mapClaudeSdkAssistantError('unknown', {
      ...baseContext,
      capturedApiError: {
        status: 500,
        statusText: 'Internal Server Error',
        message: 'Internal server error',
        timestamp: Date.now(),
      },
    });

    expect(error.code).toBe('provider_error');
    expect(error.details?.some((detail) => detail.includes('Status: 500 Internal Server Error'))).toBe(true);
  });

  it('maps unknown + captured 529 overloaded to provider_error', () => {
    const error = mapClaudeSdkAssistantError('unknown', {
      ...baseContext,
      capturedApiError: {
        status: 529,
        statusText: '',
        message: 'Overloaded',
        timestamp: Date.now(),
      },
    });

    expect(error.code).toBe('provider_error');
    expect(error.details?.some((detail) => detail.includes('Status: 529'))).toBe(true);
  });

  it('keeps unknown network failures as network_error', () => {
    const error = mapClaudeSdkAssistantError('unknown', {
      ...baseContext,
      actualError: {
        errorType: 'error',
        message: 'fetch failed: ECONNREFUSED',
      },
    });

    expect(error.code).toBe('network_error');
    expect(error.message.toLowerCase()).toContain('internet connection');
  });

  describe('invalid_request — 1M context specialization', () => {
    it('maps invalid_request with context-1m hint to 1M-context-specific error', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'The beta header context-1m-2025-08-07 is not available on your tier',
          timestamp: Date.now(),
        },
      });

      expect(error.code).toBe('invalid_request');
      expect(error.title).toBe('1M Context Not Available');
      expect(error.message).toContain('200K');
      // F1.1241 — no switch to point at: the advice names the operator's cap instead.
      expect(error.details?.some(d => d.includes('Extended Context'))).toBe(false);
      expect(error.details?.some(d => d.includes('CLAUDE_CODE_DISABLE_1M_CONTEXT'))).toBe(true);
      expect(error.actions?.some(a => a.action === 'settings')).toBe(false);
    });

    it('routes generic context_window phrasing to Context Window Exceeded (not 1M)', () => {
      // Generic context-overflow without tier/1M-specific hints. The user
      // shouldn't be told to disable 1M when they may not have it enabled.
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        actualError: {
          errorType: 'invalid_request_error',
          message: 'prompt exceeds the context window for this model',
        },
      });

      expect(error.title).toBe('Context Window Exceeded');
      expect(error.details?.some(d => /compact|new session/i.test(d))).toBe(true);
    });

    it('Context Window Exceeded suppresses Retry and offers /compact', () => {
      // Retrying the same payload hits the same wall. The action should be
      // /compact, not Retry — and canRetry must be false so the UI hides
      // the retry button entirely.
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        actualError: {
          errorType: 'invalid_request_error',
          message: 'prompt is too long',
        },
      });

      expect(error.title).toBe('Context Window Exceeded');
      expect(error.canRetry).toBe(false);
      expect(error.actions?.some(a => a.action === 'retry')).toBe(false);
      expect(error.actions?.some(a => a.command === '/compact')).toBe(true);
    });

    it('1M Context Not Available offers Compact only, no Retry and no Settings (F1.1241)', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'context-1m beta requires a higher tier',
          timestamp: Date.now(),
        },
      });

      expect(error.title).toBe('1M Context Not Available');
      expect(error.canRetry).toBe(false);
      expect(error.actions?.some(a => a.action === 'retry')).toBe(false);
      expect(error.actions?.some(a => a.action === 'settings')).toBe(false);
      expect(error.actions?.some(a => a.command === '/compact')).toBe(true);
    });

    it('matches on tier hint when paired with a context phrase', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'Your tier does not have access to 1M context',
          timestamp: Date.now(),
        },
      });

      expect(error.title).toBe('1M Context Not Available');
    });

    it('matches on tier + extended phrase', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'Extended context is not available on your tier',
          timestamp: Date.now(),
        },
      });

      expect(error.title).toBe('1M Context Not Available');
    });

    it('does NOT route bare "tier does not have access to this feature" to 1M', () => {
      // Reviewer-flagged regression: bare "tier" used to fire 1M routing,
      // misleading users whose tier blocks something unrelated (audio,
      // documents, beta tools, etc.).
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'Your tier does not have access to this feature',
          timestamp: Date.now(),
        },
      });

      expect(error.title).not.toBe('1M Context Not Available');
      expect(error.title).toBe('Invalid Request');
    });

    it('does NOT route "tier does not have access to this model" to 1M', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'Your tier does not have access to this model',
          timestamp: Date.now(),
        },
      });

      expect(error.title).not.toBe('1M Context Not Available');
    });

    it('does NOT route "image input is not available on your tier" to 1M', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'Image input is not available on your tier',
          timestamp: Date.now(),
        },
      });

      expect(error.title).not.toBe('1M Context Not Available');
      // "image" appears in the error → attachment-rejection path fires,
      // which is the correct disambiguation here.
      expect(error.title).toBe('Invalid Request');
      expect(error.details?.some(d => d.toLowerCase().includes('attachments'))).toBe(true);
    });

    it('does NOT route "this feature requires a higher tier" to 1M', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'This feature requires a higher tier',
          timestamp: Date.now(),
        },
      });

      expect(error.title).not.toBe('1M Context Not Available');
    });

    it('routes "prompt is too long" to Context Window Exceeded', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        actualError: {
          errorType: 'invalid_request_error',
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
        },
      });

      expect(error.title).toBe('Context Window Exceeded');
    });

    it('shows attachment hints when API explicitly mentions image format', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        capturedApiError: {
          status: 400,
          statusText: 'Bad Request',
          message: 'image format not supported',
          timestamp: Date.now(),
        },
      });

      expect(error.code).toBe('invalid_request');
      expect(error.title).toBe('Invalid Request');
      expect(error.details?.some(d => d.toLowerCase().includes('attachments'))).toBe(true);
    });

    it('shows attachment hints when the user-sent turn had attachments', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', {
        ...baseContext,
        userTurnHadAttachments: true,
      });

      expect(error.title).toBe('Invalid Request');
      expect(error.details?.some(d => d.toLowerCase().includes('attachments'))).toBe(true);
    });

    it('does NOT show attachment hints for plain-text turns with no attachment signal', () => {
      // This is the poisoned-session case: history grew too large, but the
      // current turn had no attachments and the API gave no detail. Showing
      // "remove attachments" advice misleads the user.
      const error = mapClaudeSdkAssistantError('invalid_request', baseContext);

      expect(error.title).toBe('Invalid Request');
      expect(error.details?.some(d => d.toLowerCase().includes('attachments'))).toBe(false);
      expect(error.details?.some(d => /compact|new session/i.test(d))).toBe(true);
    });

    it('appends a diagnostic pointer when no error detail is available', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', baseContext);

      expect(error.details?.some(d => /main process log/i.test(d))).toBe(true);
    });

    it('falls back to generic invalid_request when no captured/actual error info exists', () => {
      const error = mapClaudeSdkAssistantError('invalid_request', baseContext);

      expect(error.title).toBe('Invalid Request');
    });
  });
});

/**
 * A 403 is authenticated-and-refused, not a bad key.
 *
 * Measured live 2026-08-15: llm-proxy answers a Claude-runtime turn with
 * `403 { "error": "… Security Guardrail Triggered: Malicious MCP detected.
 * Invalid tools: …" }`. The SDK reports that as `authentication_failed`, this
 * mapper said "Your API key may be invalid or expired", and an hour went into
 * hunting a credential bug that did not exist. The key was fine; the endpoint
 * refused the request's TOOL LIST.
 */
describe('403 versus 401', () => {
  const guardrail = 'Security Guardrail Triggered: Malicious MCP detected. Invalid tools: mcp__session__TodoWrite';

  it('does not blame the credential for a 403, and carries the upstream reason', () => {
    const error = mapClaudeSdkAssistantError('authentication_failed', {
      ...baseContext,
      capturedApiError: { status: 403, statusText: 'Forbidden', message: guardrail, timestamp: Date.now() },
    });

    expect(error.code).toBe('provider_error');
    expect(error.message).toContain('Security Guardrail Triggered');
    // The words that sent the reader to the wrong place must be gone.
    expect(error.message.toLowerCase()).not.toContain('api key');
    expect(error.message.toLowerCase()).not.toContain('invalid or expired');
    expect(error.details?.some(d => d.includes('not a credential problem'))).toBe(true);
    // Retrying an unchanged request against a policy refusal is not an action.
    expect(error.canRetry).toBe(false);
  });

  it('still blames the credential for a real 401 — the branch is narrow', () => {
    // The positive control: without it, a fix that swallowed every
    // authentication_failed would pass the case above.
    const error = mapClaudeSdkAssistantError('authentication_failed', {
      ...baseContext,
      capturedApiError: { status: 401, statusText: 'Unauthorized', message: 'invalid x-api-key', timestamp: Date.now() },
    });

    expect(error.code).toBe('invalid_api_key');
    expect(error.message.toLowerCase()).toContain('api key');
  })

  it('and for an authentication_failed with no captured status at all', () => {
    const error = mapClaudeSdkAssistantError('authentication_failed', baseContext);
    expect(error.code).toBe('invalid_api_key');
  })
})

/**
 * The gateway cards (Claude Code (Nessy Gateway), providerType
 * `claude-runtime`) authenticate through the one-click dp sign-in, not an API
 * key. Measured support complaint: a user hit
 * `401 {"error":"fail parse token claims: ... token is malformed"}` on that
 * card and was told "Your API key may be invalid or expired" — there is no
 * API-key field on this card, so they went hunting for one that doesn't
 * exist. This block is the fix: on `claude-runtime`, name the gateway sign-in
 * instead. Every other providerType (including no providerType at all) must
 * keep today's wording byte-for-byte.
 */
describe('authentication_failed on claude-runtime — gateway sign-in wording', () => {
  it('names the gateway sign-in, not an API key', () => {
    const error = mapClaudeSdkAssistantError('authentication_failed', {
      ...baseContext,
      capturedApiError: { status: 401, statusText: 'Unauthorized', message: 'fail parse token claims', timestamp: Date.now() },
      providerType: 'claude-runtime',
    });

    expect(error.code).toBe('invalid_api_key');
    expect(error.message).toContain('Nessy Gateway');
    expect(error.message).not.toContain('API key');
  });

  it('elsewhere keeps the API-key wording', () => {
    const error = mapClaudeSdkAssistantError('authentication_failed', baseContext);

    expect(error.message).toContain('API key');
  });

  /**
   * T28 (plan 2026-08-20, measured 2026-08-21): a BYO claude-runtime
   * connection (llm-proxy) hit the guardrail 403 with no captured status and
   * was told its "Nessy Gateway sign-in is missing or expired" — that card has
   * its own key and no gateway sign-in. The wording is scoped by the upstream
   * kind the adapter itself resolved; unresolved keeps the gateway wording,
   * because the gateway is the only out-of-the-box claude-runtime card.
   */
  it.each(['openai-compatible', 'anthropic-messages'])(
    'a BYO upstream (%s) keeps the API-key wording, never the gateway sign-in',
    (kind) => {
      const error = mapClaudeSdkAssistantError('authentication_failed', {
        ...baseContext,
        providerType: 'claude-runtime',
        claudeRuntimeUpstreamKind: kind,
      });

      expect(error.message).not.toContain('Nessy Gateway');
      expect(error.message).toContain('API key');
    },
  );

  it('the gateway upstream (nestor) and an unresolved kind both keep the sign-in wording', () => {
    for (const kind of ['nestor', undefined]) {
      const error = mapClaudeSdkAssistantError('authentication_failed', {
        ...baseContext,
        providerType: 'claude-runtime',
        ...(kind ? { claudeRuntimeUpstreamKind: kind } : {}),
      });

      expect(error.message).toContain('Nessy Gateway');
    }
  });
})

/**
 * I2.10 — `account_on_hold`, the eleventh `SDKAssistantMessageError` value.
 *
 * Before this arm it fell to `default`, whose every clause is wrong for it: "An
 * unexpected error occurred", "This may be a temporary issue", "Check your
 * network connection", and a retry at 2 s. The control is the point of the
 * second case — `oauth_org_not_allowed` STILL takes that default, so a green
 * first case means this arm fired rather than that the default arm's wording
 * changed underneath it. Those three siblings are a proposed row, and this pin
 * is what would go red if someone "fixed" them by rewording `default`.
 */
describe('I2.10 · account_on_hold is an account state, not a temporary failure', () => {
  it('names the hold, refuses the retry, and sends the user to credentials', () => {
    const error = mapClaudeSdkAssistantError('account_on_hold', baseContext);

    expect(error.title).toBe('Account On Hold');
    expect(error.canRetry).toBe(false);
    expect(error.retryDelayMs).toBeUndefined();
    expect(error.message.toLowerCase()).toContain('on hold');
    // The advice the default arm would have given, and must not.
    expect(error.details?.some(detail => detail.toLowerCase().includes('network'))).toBe(false);
    expect(error.details?.some(detail => detail.toLowerCase().includes('temporary failure'))).toBe(true);
    expect(error.actions?.some(action => action.action === 'settings')).toBe(true);
  });

  it('CONTROL — the default arm still exists and still reads that way, for a code the union does not have', () => {
    // D1.199 gave the three siblings this control used to name their own arms,
    // so the control is narrowed to what is left: the `default` arm, reachable
    // now only for a member a LATER SDK adds. Reaching it needs a cast — that
    // is the point, and it is why this is a boundary case rather than a live
    // one. If a reworded `default` is what someone "fixes" next, this reddens.
    const error = mapClaudeSdkAssistantError(
      'a_member_no_sdk_has_yet' as SDKAssistantMessageError,
      baseContext,
    );

    expect(error.code).toBe('unknown_error');
    expect(error.canRetry).toBe(true);
    expect(error.retryDelayMs).toBe(2000);
    expect(error.details?.some(detail => detail.includes('Check your network connection'))).toBe(true);
  });
})

/**
 * D1.199 — the last three members of `SDKAssistantMessageError` to get an arm.
 *
 * The denominator is the SDK's own union and not a number in prose: the
 * `Record<SDKAssistantMessageError, true>` below fails to compile the day the
 * vendored SDK adds a twelfth member, which is the only instrument that can see
 * such an addition before a user meets its wording.
 */
const EVERY_SDK_ERROR_CODE: Record<SDKAssistantMessageError, true> = {
  authentication_failed: true,
  oauth_org_not_allowed: true,
  account_on_hold: true,
  billing_error: true,
  rate_limit: true,
  overloaded: true,
  invalid_request: true,
  model_not_found: true,
  server_error: true,
  unknown: true,
  max_output_tokens: true,
  // F1.255 — the twelfth, arrived at 0.3.267; this literal stopped compiling
  // until it was added, which is the whole instrument.
  cloud_credential_error: true,
  // F1.1213 — the thirteenth, arrived at 0.3.268 and vendored at the 0.3.274
  // lift; the same instrument fired (TS2741) until this line was added.
  verification_required: true,
}

describe('D1.199 · the three members that blamed the network', () => {
  it('oauth_org_not_allowed names the organization and refuses the retry', () => {
    const error = mapClaudeSdkAssistantError('oauth_org_not_allowed', baseContext);

    expect(error.code).toBe('invalid_credentials');
    expect(error.title).toBe('Organization Not Allowed');
    expect(error.canRetry).toBe(false);
    expect(error.retryDelayMs).toBeUndefined();
    expect(error.message.toLowerCase()).toContain('organization');
    // The three clauses the default arm would have given, and must not.
    expect(error.details?.some(detail => detail.toLowerCase().includes('network'))).toBe(false);
    expect(error.details?.some(detail => detail.toLowerCase().includes('temporary issue'))).toBe(false);
    expect(error.actions?.some(action => action.action === 'settings')).toBe(true);
  });

  it('model_not_found sends the user to the model, not to the network', () => {
    const error = mapClaudeSdkAssistantError('model_not_found', baseContext);

    expect(error.code).toBe('invalid_model');
    expect(error.title).toBe('Model Not Found');
    expect(error.canRetry).toBe(false);
    expect(error.details?.some(detail => detail.toLowerCase().includes('network'))).toBe(false);
    expect(error.details?.some(detail => detail.toLowerCase().includes('model'))).toBe(true);
  });

  it('overloaded keeps the retry but stops being called an Unknown Error', () => {
    const error = mapClaudeSdkAssistantError('overloaded', baseContext);

    expect(error.code).toBe('provider_error');
    expect(error.title).toBe('AI Provider Issue');
    expect(error.canRetry).toBe(true);
    expect(error.retryDelayMs).toBe(5000);
  });

  it('BOUNDARY — every member of the SDK union has an arm of its own', () => {
    // `unknown` is the one member whose own arm produces the default shape with
    // an empty context, so it is the expected exception rather than a miss.
    for (const code of Object.keys(EVERY_SDK_ERROR_CODE) as SDKAssistantMessageError[]) {
      const error = mapClaudeSdkAssistantError(code, baseContext);
      if (code === 'unknown') {
        expect(error.code).toBe('unknown_error');
        continue;
      }
      expect(error.code).not.toBe('unknown_error');
    }
  });
})

describe('F1.255 · cloud_credential_error, the twelfth member', () => {
  it('names a credential problem and never blames the network', () => {
    const error = mapClaudeSdkAssistantError('cloud_credential_error', baseContext);

    expect(error.code).toBe('invalid_credentials');
    expect(error.title).toBe('Cloud Credentials Unavailable');
    expect(error.canRetry).toBe(true);
    expect(error.details?.some(detail => detail.toLowerCase().includes('refresh'))).toBe(true);
    // The default arm's clause this one exists to replace.
    expect(error.details?.some(detail => detail.includes('Check your network connection'))).toBe(false);
    expect(error.actions?.some(action => action.action === 'settings')).toBe(true);
  });

  it('CONTROL — every member of the vendored union but `unknown` itself reaches a named arm, none the default', () => {
    const named = (Object.keys(EVERY_SDK_ERROR_CODE) as SDKAssistantMessageError[]).filter(code => code !== 'unknown');
    expect(named).toHaveLength(12);
    for (const code of named) {
      expect(mapClaudeSdkAssistantError(code, baseContext).title, code).not.toBe('Unknown Error');
    }
  });
});

/**
 * F1.1213 — `verification_required`, the thirteenth member (0.3.268). Its
 * meaning is undocumented on the docs pages, so it was read from the vendored
 * 2.1.274 binary (`grep -a`, 20 occurrences): the CLI answers it for a 403
 * `permission_error` whose `details.error_code` is `verification_required`,
 * labels it "organization verification required", shows the server's message
 * with its https link, never retries the request, and stops a goal loop on it.
 */
describe('F1.1213 · verification_required, the thirteenth member', () => {
  const verificationContext = {
    actualError: {
      errorType: 'permission_error',
      message: 'Your organization must complete verification before using this model. Visit https://console.anthropic.com/settings/verification to continue.',
    },
    capturedApiError: null,
  } as const;

  it('names the organization verification step, carries the server message, and refuses the retry', () => {
    const error = mapClaudeSdkAssistantError('verification_required', verificationContext);

    expect(error.code).toBe('invalid_credentials');
    expect(error.title).toBe('Organization Verification Required');
    expect(error.canRetry).toBe(false);
    expect(error.retryDelayMs).toBeUndefined();
    // The server's own sentence — and its link — is the only place the next
    // step is named, so it must reach the card.
    expect(error.details?.some(detail => detail.includes('https://console.anthropic.com/settings/verification'))).toBe(true);
    expect(error.details?.some(detail => detail.toLowerCase().includes('verification'))).toBe(true);
  });

  it('BOUNDARY — with no server message it still never blames the network or calls itself temporary', () => {
    const error = mapClaudeSdkAssistantError('verification_required', baseContext);

    expect(error.title).not.toBe('Unknown Error');
    expect(error.details?.some(detail => detail.includes('Check your network connection'))).toBe(false);
    expect(error.details?.some(detail => detail.toLowerCase().includes('temporary issue'))).toBe(false);
  });
});

/**
 * F1.1213 (H7) — a 400 `claude_code_version_too_old`. errors.md, section
 * "Claude Code does not support this model" (Request errors): "The API refused
 * the request with a 400 because your Claude Code version is below a required
 * minimum." The SDK reports it as `invalid_request` (the vendored 2.1.274
 * binary: `if(<isVersionTooOld>(e))return …{error:"invalid_request",apiError:
 * "claude_code_version_too_old"}`), so without its own branch it read as a
 * generic "Invalid Request" with a retry button that can never succeed: the
 * bundled Claude Code moves only with a Nessy release.
 */
describe('F1.1213 · claude_code_version_too_old names the version, not a generic rejection', () => {
  it('per-model minimum: names the required version AND the bundled one, and refuses the retry', () => {
    const error = mapClaudeSdkAssistantError('invalid_request', {
      ...baseContext,
      actualError: {
        errorType: 'invalid_request_error',
        // The documented wording (errors.md), versions as a 0.3.274 user would meet them.
        message: "Claude Code 2.1.274 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
      },
    });

    expect(error.title).toBe('Claude Code Update Required');
    expect(error.message).toContain('2.1.280');
    // The bundled version is READ from the installed SDK, never written here.
    const bundled = readClaudeCliVersion();
    expect(bundled).not.toBe('unknown');
    expect(error.message).toContain(bundled);
    expect(error.canRetry).toBe(false);
    expect(error.details?.some(detail => detail.toLowerCase().includes('another model'))).toBe(true);
  });

  it('organization floor, seen only as the error code in the raw upstream body', () => {
    const error = mapClaudeSdkAssistantError('invalid_request', {
      ...baseContext,
      capturedApiError: {
        status: 400,
        statusText: 'Bad Request',
        message: JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: "Claude Code 2.1.274 is older than the minimum version required by your organization's policy. Run 'claude update', or update the Claude desktop app, to continue.",
            details: { error_code: 'claude_code_version_too_old' },
          },
        }),
        timestamp: Date.now(),
      },
    });

    expect(error.title).toBe('Claude Code Update Required');
    expect(error.message.toLowerCase()).toContain('organization');
    expect(error.message).toContain(readClaudeCliVersion());
    expect(error.canRetry).toBe(false);
  });

  it('BOUNDARY — an ordinary 400 that merely mentions Claude Code keeps the generic arm', () => {
    const error = mapClaudeSdkAssistantError('invalid_request', {
      ...baseContext,
      actualError: {
        errorType: 'invalid_request_error',
        message: 'Claude Code sent a tool_use block without a matching tool_result.',
      },
    });

    expect(error.title).toBe('Invalid Request');
    expect(error.canRetry).toBe(true);
  });
});
