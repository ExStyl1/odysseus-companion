/**
 * AI-powered URL validation using Claude Agent SDK
 *
 * Uses Claude Haiku for lightweight, cost-efficient URL validation
 * with contextual understanding of safe HTTP MCP/API URL patterns.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultOptions } from '../agent/options.ts';
import { getDefaultSummarizationModel } from '../config/models.ts';

import { debug } from '../utils/debug.ts';
import { parseError, parseSDKErrorText, type AgentError } from '../agent/errors.ts';
import { getLastApiError } from '../interceptor-common.ts';

export interface UrlValidationResult {
  valid: boolean;
  /** Simple error message for validation failures */
  error?: string;
  /** Typed error for API/billing failures - display as ErrorBanner */
  typedError?: AgentError;
}

const SYSTEM_PROMPT = `You are a URL validator for HTTP MCP/API sources. Your ONLY job is to validate if a URL is safe and syntactically valid.

VALID URL EXAMPLES:
- https://mcp.example.com/my/mcp
- https://api.example.com/v1/
- https://example.internal/tools/mcp

INVALID URL EXAMPLES AND WHY:
- mcp.example.com/my/mcp → Missing https:// protocol
- http://mcp.example.com/my/mcp → Must use https://, not http://
- https://user:pass@mcp.example.com/my/mcp → Credentials in URL not allowed
- not-a-url → Not a syntactically valid URL

VALIDATION RULES:
1. Protocol must be https://
2. Hostname must be present
3. No credentials (user:pass@) in the URL
4. Must be a syntactically valid URL
5. The input should only be the URL string, nothing else NO sentences OR extra text

RESPONSE FORMAT:
Respond with ONLY a JSON object, no other text:
{"valid": true}
or
{"valid": false, "error": "Helpful error message for the user"}

ERROR MESSAGES should be user-friendly and suggest how to fix the issue.`;

/**
 * Validate a URL using Claude Haiku
 */
export async function validateMcpUrl(
  url: string,
  apiKey?: string,
  oauthToken?: string,
): Promise<UrlValidationResult> {
  debug('[url-validator] Validating URL:', url);

  try {
    const options: Options = {
      ...getDefaultOptions(),
      model: getDefaultSummarizationModel(),
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 1,
      tools: [], // No tools needed - pure text analysis
      ...(apiKey ? { apiKey } : {}),
      ...(oauthToken ? { oauthToken } : {}),
    };

    let responseText = '';

    for await (const message of query({ prompt: `Validate this URL: ${url}`, options })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            responseText += block.text;
          }
        }
      }
    }

    debug('[url-validator] Response:', responseText);

    // Check for SDK error text (emitted as text before throwing)
    const sdkError = parseSDKErrorText(responseText);
    if (sdkError) {
      debug('[url-validator] Detected SDK error in response');
      return { valid: false, typedError: sdkError };
    }

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      debug('[url-validator] Failed to parse JSON from response');
      return { valid: false, error: 'Unable to validate URL' };
    }

    const result = JSON.parse(jsonMatch[0]);
    return {
      valid: result.valid === true,
      error: result.error,
    };
  } catch (err) {
    debug('[url-validator] Error:', err);

    // Check for captured API error from interceptor (most reliable source)
    const apiError = getLastApiError();
    if (apiError) {
      debug('[url-validator] Found captured API error:', apiError.status, apiError.message);
      // Create error with status code for accurate detection
      const typedError = parseError(new Error(`${apiError.status} ${apiError.message}`));
      if (typedError.code !== 'unknown_error') {
        return { valid: false, typedError };
      }
    }

    // Fall back to parsing the thrown error
    const typedError = parseError(err);

    // Return typed error for ErrorBanner display (for API/billing errors)
    // For unknown errors, fall back to simple error message
    if (typedError.code !== 'unknown_error') {
      return { valid: false, typedError };
    }

    // For unknown errors, return a simple message
    return { valid: false, error: `URL validation failed: ${typedError.originalError || 'Unknown error'}` };
  }
}
