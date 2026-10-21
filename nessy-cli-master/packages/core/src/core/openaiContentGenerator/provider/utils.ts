/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ExtendedChatCompletionAssistantMessageParam } from '../converter.js';

// Some thinking-mode OpenAI-compatible APIs require `reasoning_content` to be
// replayed on every prior assistant turn, even when the model returned no
// visible reasoning text for that turn.
export function ensureReasoningContentOnAssistantMessage(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }

  const assistant = message as ExtendedChatCompletionAssistantMessageParam;
  if (typeof assistant.reasoning_content === 'string') {
    return message;
  }

  return {
    ...assistant,
    reasoning_content: '',
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

// Some providers accept a flat top-level `reasoning_effort` body parameter
// (e.g. DeepSeek: high/max) rather than the standard nessy-cli config shape
// `reasoning: { effort, ... }` which the OpenAI pipeline passes through
// verbatim. Translate to the flat shape the provider expects so
// user-configured effort levels actually take effect; otherwise the nested
// `reasoning` object is ignored and the server silently defaults to `high`.
// The configured effort is passed through verbatim — no normalization, so the
// wire value matches what the user/backend configured. No-ops (returns the
// request untouched) when no `reasoning.effort` string is present, so callers
// can apply it unconditionally.
// [nessy-fork] reasoning-effort-wire-translation
export function translateReasoningEffort(
  request: OpenAI.Chat.ChatCompletionCreateParams,
): OpenAI.Chat.ChatCompletionCreateParams {
  // The SDK type narrows reasoning_effort to 'low'|'medium'|'high', but
  // DeepSeek extends it with 'max'. Treat the request as a loose record
  // here so we can set 'max' without fighting the upstream union.
  const r = request as unknown as Record<string, unknown>;
  const nested = r['reasoning'] as { effort?: unknown } | undefined;
  const nestedEffort = nested?.effort;
  if (typeof nestedEffort !== 'string' || !nestedEffort) {
    return request;
  }

  const next: Record<string, unknown> = { ...r };
  // Don't clobber an already-set top-level reasoning_effort (user override
  // via samplingParams or extra_body). Pass the configured effort through
  // verbatim — no low/medium→high normalization — so the wire value matches
  // the settings the user/backend configured.
  if (
    typeof next['reasoning_effort'] !== 'string' ||
    !next['reasoning_effort']
  ) {
    next['reasoning_effort'] = nestedEffort;
  }

  // Drop only the duplicated `effort` key from the nested form so we don't
  // ship two competing values for the same knob. Other keys inside
  // `reasoning` (e.g. an extra_body-injected `budget_tokens`) stay intact —
  // they're orthogonal data the server can ignore or honor on its own, and
  // silently swallowing them here would be a surprise. Drop `undefined`
  // values so a `{ budget_tokens: undefined }` remainder doesn't serialize
  // to a stray `reasoning: {}` on the wire/logs.
  if (nested) {
    const { effort: _drop, ...rest } = nested as Record<string, unknown>;
    const cleaned = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(cleaned).length === 0) {
      delete next['reasoning'];
    } else {
      next['reasoning'] = cleaned;
    }
  }
  return next as unknown as OpenAI.Chat.ChatCompletionCreateParams;
}
