/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tool call component factory - routes to specialized components by kind
 * All UI components are now imported from @nestor/nessy-cli-webui
 */

import { shouldShowToolCall, getToolCallComponent } from '@nestor/nessy-cli-webui';
import type { FC } from 'react';
import type { BaseToolCallProps } from '@nestor/nessy-cli-webui';

/**
 * Main tool call component that routes to specialized implementations
 */
export const ToolCallRouter: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  // Check if we should show this tool call (hide internal ones)
  if (!shouldShowToolCall(toolCall.kind)) {
    return null;
  }

  // Get the appropriate component for this kind
  const Component = getToolCallComponent(toolCall);

  // Render the specialized component
  return <Component toolCall={toolCall} isFirst={isFirst} isLast={isLast} />;
};

// Re-export types for convenience
export type { BaseToolCallProps, ToolCallData } from '@nestor/nessy-cli-webui';
