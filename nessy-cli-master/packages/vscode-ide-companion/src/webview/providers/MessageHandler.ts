/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { NessyAgentManager } from '../../services/nessyAgentManager.js';
import type { ConversationStore } from '../../services/conversationStore.js';
import type {
  PermissionResponseMessage,
  AskUserQuestionResponseMessage,
} from '../../types/webviewMessageTypes.js';
import { MessageRouter } from '../handlers/MessageRouter.js';

/**
 * MessageHandler (Refactored Version)
 * This is a lightweight wrapper class that internally uses MessageRouter and various sub-handlers
 * Maintains interface compatibility with the original code
 */
export class MessageHandler {
  private router: MessageRouter;

  constructor(
    agentManager: NessyAgentManager,
    conversationStore: ConversationStore,
    currentConversationId: string | null,
    sendToWebView: (message: unknown) => void,
  ) {
    this.router = new MessageRouter(
      agentManager,
      conversationStore,
      currentConversationId,
      sendToWebView,
    );
  }

  /**
   * Route messages to the corresponding handler
   */
  async route(message: { type: string; data?: unknown }): Promise<void> {
    await this.router.route(message);
  }

  /**
   * Set current session ID
   */
  setCurrentConversationId(id: string | null): void {
    this.router.setCurrentConversationId(id);
  }

  /**
   * Get current session ID
   */
  getCurrentConversationId(): string | null {
    return this.router.getCurrentConversationId();
  }

  /**
   * Set permission handler
   */
  setPermissionHandler(
    handler: (message: PermissionResponseMessage) => void,
  ): void {
    this.router.setPermissionHandler(handler);
  }

  /**
   * Set ask user question handler
   */
  setAskUserQuestionHandler(
    handler: (message: AskUserQuestionResponseMessage) => void,
  ): void {
    this.router.setAskUserQuestionHandler(handler);
  }

  /**
   * Set auth interactive handler — interactive auth flow.
   */
  setAuthInteractiveHandler(
    handler: (
      config: import('@nestor/nessy-cli-core').ProviderConfig,
      inputs: import('@nestor/nessy-cli-core').ProviderSetupInputs,
    ) => Promise<void>,
  ): void {
    this.router.setAuthInteractiveHandler(handler);
  }

  /**
   * Append stream content
   */
  appendStreamContent(chunk: string): void {
    this.router.appendStreamContent(chunk);
  }

  setupFileWatchers(): vscode.Disposable {
    return this.router.setupFileWatchers();
  }
}
