/**
 * @nessy-agent/shared
 *
 * Shared business logic for Nessy Desktop.
 * Used by the Electron app.
 *
 * Import specific modules via subpath exports:
 *   import { NessyAgent } from '@nessy-agent/shared/agent';
 *   import { loadStoredConfig } from '@nessy-agent/shared/config';
 *   import { getCredentialManager } from '@nessy-agent/shared/credentials';
 *   import { NessyMcpClient } from '@nessy-agent/shared/mcp';
 *   import { debug } from '@nessy-agent/shared/utils';
 *   import { loadSource, createSource, getSourceCredentialManager } from '@nessy-agent/shared/sources';
 *   import { createWorkspace, loadWorkspace } from '@nessy-agent/shared/workspaces';
 *
 * Available modules:
 *   - agent: NessyAgent SDK wrapper, plan tools
 *   - auth: OAuth, token management, auth state
 *   - clients: Nessy API client
 *   - config: Storage, models, preferences
 *   - credentials: Encrypted credential storage
 *   - mcp: MCP client, connection validation
 *   - prompts: System prompt generation
 *   - sources: Workspace-scoped source management (MCP, API, local)
 *   - utils: Debug logging, file handling, summarization
 *   - validation: URL validation
 *   - version: Version and installation management
 *   - workspaces: Workspace management (top-level organizational unit)
 */

// Export branding (standalone, no dependencies)
export * from './branding.ts';
