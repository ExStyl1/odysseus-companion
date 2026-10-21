/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters } from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  ContentGeneratorConfig,
  InputModalities,
} from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import type { OpenAIResponseParsingOptions } from './responseParsingOptions.js';
import type { StreamingToolCallParser } from './streamingToolCallParser.js';
import type { TaggedThinkingParser } from './taggedThinkingParser.js';

export interface StreamingTextDeltaState {
  /**
   * Rolling baseline used for prefix/exact-repeat detection. Once the stream
   * has been classified as incremental and the buffer reaches
   * CUMULATIVE_DETECTION_WINDOW_BYTES bytes it is frozen at the cap to bound
   * memory; the true emitted total is tracked separately in `emittedLength`.
   * In cumulative mode this always reflects the full accumulated text.
   */
  emittedText: string;
  /**
   * Monotonic count of user-visible bytes already emitted on this channel.
   * Diverges from `emittedText.length` only on long incremental streams where
   * `emittedText` is capped at CUMULATIVE_DETECTION_WINDOW_BYTES. Used to slice
   * the correct suffix when an incremental-then-cumulative hybrid stream
   * transitions into cumulative mode after the cap (otherwise the suffix would
   * re-include bytes between the cap and the true emitted length, producing
   * visible duplication).
   */
  emittedLength: number;
  cumulativeMode: boolean;
  /**
   * Rolling tail of the last EMITTED_TAIL_LOOKBACK_BYTES of visible output on
   * this channel. Used for suffix/prefix overlap-dedup when a chunk re-plays
   * the end of what was already streamed — a pattern seen on Qwen35-class
   * providers that emit half-overlapping chunks. Separate from `emittedText`
   * because that buffer is capped at the HEAD (first 1024 bytes), which is
   * useless for tail-overlap detection past the cap.
   */
  emittedTail?: string;
}

export interface RequestContext {
  model: string;
  modalities: InputModalities;
  startTime: number;
  toolCallParser?: StreamingToolCallParser;
  responseParsingOptions?: OpenAIResponseParsingOptions;
  taggedThinkingParser?: TaggedThinkingParser;
  // When true, media parts in tool-result messages are split into a follow-up
  // user message for strict OpenAI-compat servers. See ContentGeneratorConfig
  // for details.
  splitToolMedia?: boolean;
  // Default keeps tool result text as content parts; "string" is an opt-in
  // compatibility mode for older OpenAI-compatible tool templates.
  toolResultContentFormat?: ContentGeneratorConfig['toolResultContentFormat'];
  /**
   * Per-stream mutable state for cumulative-delta normalization on the visible
   * content channel. Initialised lazily on first use. Must NOT be shared or
   * reused across requests — stale state will silently corrupt text output.
   */
  textDeltaState?: StreamingTextDeltaState;
  /**
   * Same as textDeltaState but for the reasoning/thinking content channel.
   * The two channels are tracked independently so interleaved chunks on each
   * channel are deduplicated correctly.
   */
  reasoningDeltaState?: StreamingTextDeltaState;
  /**
   * True once any chunk/response has carried a structured `reasoning_content`
   * (or `reasoning`) field. When true, the provider has already separated
   * thinking from visible output upstream, so the tagged-thinking parser is
   * bypassed for `content` and visible text is emitted without buffering.
   */
  structuredReasoningSeen?: boolean;
}

export interface ErrorHandler {
  handle(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): never;
  shouldSuppressErrorLogging(
    error: unknown,
    request: GenerateContentParameters,
  ): boolean;
}

export interface PipelineConfig {
  cliConfig: Config;
  provider: OpenAICompatibleProvider;
  contentGeneratorConfig: ContentGeneratorConfig;
  errorHandler: ErrorHandler;
}
