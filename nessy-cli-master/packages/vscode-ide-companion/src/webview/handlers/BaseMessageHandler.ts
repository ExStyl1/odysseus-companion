/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NessyAgentManager } from '../../services/nessyAgentManager.js';
import type { ConversationStore } from '../../services/conversationStore.js';

/**
 * Base message handler interface
 * All sub-handlers should implement this interface
 */
export interface IMessageHandler {
  /**
   * Handle message
   * @param message - Message object
   * @returns Promise<void>
   */
  handle(message: { type: string; data?: unknown }): Promise<void>;

  /**
   * Check if this handler can handle the message type
   * @param messageType - Message type
   * @returns boolean
   */
  canHandle(messageType: string): boolean;
}

/**
 * Base message handler class
 * Provides common dependency injection and helper methods
 */
export abstract class BaseMessageHandler implements IMessageHandler {
  constructor(
    protected agentManager: NessyAgentManager,
    protected conversationStore: ConversationStore,
    protected currentConversationId: string | null,
    protected sendToWebView: (message: unknown) => void,
    private readonly syncCurrentConversationId?: (id: string | null) => void,
  ) {}

  abstract handle(message: { type: string; data?: unknown }): Promise<void>;
  abstract canHandle(messageType: string): boolean;

  /**
   * Update current conversation ID
   */
  setCurrentConversationId(id: string | null): void {
    this.currentConversationId = id;
  }

  /**
   * Update current conversation ID through the owning router when available.
   */
  protected updateCurrentConversationId(id: string | null): void {
    if (this.syncCurrentConversationId) {
      this.syncCurrentConversationId(id);
      return;
    }

    this.currentConversationId = id;
  }

  /**
   * Get current conversation ID
   */
  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }
}
