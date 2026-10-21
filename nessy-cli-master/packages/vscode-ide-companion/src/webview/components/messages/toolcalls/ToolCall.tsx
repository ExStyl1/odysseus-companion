/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Main ToolCall component - uses factory pattern to route to specialized components
 *
 * This file serves as the public API for tool call rendering.
 * It re-exports the router and types from the toolcalls module.
 */

import type { FC } from 'react';
import type { ToolCallData } from '@nestor/nessy-cli-webui';
import { ToolCallRouter } from './index.js';

// Re-export types from webui for backward compatibility
export type {
  ToolCallData,
  BaseToolCallProps as ToolCallProps,
  ToolCallContent,
} from '@nestor/nessy-cli-webui';

export const ToolCall: FC<{
  toolCall: ToolCallData;
  isFirst?: boolean;
  isLast?: boolean;
}> = ({ toolCall, isFirst, isLast }) => (
  <ToolCallRouter toolCall={toolCall} isFirst={isFirst} isLast={isLast} />
);
