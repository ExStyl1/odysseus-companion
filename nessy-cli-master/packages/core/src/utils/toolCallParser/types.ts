/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';

export type ToolCallParseResult = {
  functionCalls: FunctionCall[];
  content: string;
  segments?: ToolCallParseSegment[];
};

export type ToolCallParseSegment =
  | { type: 'content'; value: string }
  | { type: 'tool_call'; value: FunctionCall };

export type ToolCallMarker = { index: number; type: 'open' | 'close' };

export type ValueContainer = {
  type: string;
  value: unknown;
};
