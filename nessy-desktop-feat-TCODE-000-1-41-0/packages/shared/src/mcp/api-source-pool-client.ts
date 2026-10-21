/**
 * Pool client for API sources.
 *
 * Connects to an in-process McpServer (created by createSdkMcpServer) via
 * in-memory transport, exposing it through the same PoolClient interface
 * that NessyMcpClient uses for remote MCP sources.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpDeclaredServerCapabilities, McpPromptGetResult, McpPromptListPage, McpResourceListPage, McpResourceReadResult, McpToolCallOptions, PoolClient } from './client.ts'; // UB7.11 — McpPromptListPage joined the list; UB7.10 — McpResourceListPage did too

export class ApiSourcePoolClient implements PoolClient {
  private client: Client;
  private connected = false;

  constructor(private mcpServer: McpServer) {
    this.client = new Client({ name: 'nessy-pool-api-source', version: '1.0.0' });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Connect both ends
    await this.mcpServer.connect(serverTransport);
    await this.client.connect(clientTransport);

    this.connected = true;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) await this.connect();
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: McpToolCallOptions,
  ): Promise<unknown> {
    if (!this.connected) await this.connect();
    // UB3.9 (upstream v0.15.1 `ApiSourcePoolClient.callTool`): API tools declare
    // `_intent` (it steers their large-result handling); the agent's copy may
    // have been stripped before the call reached the pool. The transported
    // intent fills that gap and NEVER overrides an `_intent` the caller still
    // carries (`args._intent === undefined` is the guard upstream ships).
    const withIntent = options?.intent && args._intent === undefined ? { ...args, _intent: options.intent } : args;
    return this.client.callTool({ name, arguments: withIntent }, undefined, { signal });
  }

  async listResources(cursor?: string): Promise<McpResourceListPage> {
    if (!this.connected) await this.connect()
    // UB7.10 — the PoolClient member grew a cursor and a page shape (the pool's
    // page walker); an API source's in-memory server publishes one page and no
    // cursor, so the parameter is read and dropped here.
    void cursor
    const page = (await this.client.listResources()) as { resources?: unknown[]; nextCursor?: string }
    return { resources: page.resources ?? [], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  async listPrompts(cursor?: string): Promise<McpPromptListPage> {
    if (!this.connected) await this.connect()
    // UB7.11 — the PoolClient member grew a cursor (the pool's page walker);
    // an API source's in-memory server publishes one page and no cursor, so the
    // parameter is read and dropped here.
    void cursor
    const page = (await this.client.listPrompts()) as { prompts?: unknown[]; nextCursor?: string }
    return { prompts: page.prompts ?? [], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    if (!this.connected) await this.connect()
    return (await this.client.readResource({ uri })) as McpResourceReadResult
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptGetResult> {
    if (!this.connected) await this.connect()
    return (await this.client.getPrompt({ name, ...(args ? { arguments: args } : {}) })) as McpPromptGetResult
  }

  getServerCapabilities(): McpDeclaredServerCapabilities | undefined {
    return this.client.getServerCapabilities()
  }

  /**
   * The in-process server's `instructions`. `createSdkMcpServer` accepts the
   * field and `McpServer` returns it from `initialize`, and the in-memory
   * transport carries a real handshake — so an API source is NOT exempt from
   * the instructions the model is told about a server.
   */
  getInstructions(): string | undefined {
    return this.client.getInstructions()
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close().catch(() => {});
      this.connected = false;
    }
  }
}
