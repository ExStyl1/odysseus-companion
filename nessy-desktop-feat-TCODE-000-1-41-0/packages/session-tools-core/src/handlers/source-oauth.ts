/**
 * Source OAuth Handlers
 *
 * Handlers for triggering OAuth authentication flows.
 * Supports MCP OAuth, Google OAuth, and generic API OAuth.
 */

import type { SessionToolContext } from '../context.ts';
import type {
  ToolResult,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  GoogleService,
  SourceConfig,
} from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { generateRequestId } from '../source-helpers.ts';
import { basename } from 'node:path';

function toLoadedSource(ctx: SessionToolContext, config: SourceConfig) {
  return {
    config,
    guide: null,
    folderPath: '',
    workspaceRootPath: ctx.workspacePath,
    workspaceId: basename(ctx.workspacePath) || '',
  };
}

function refreshedMessage(sourceSlug: string): string {
  return `Token for source '${sourceSlug}' has been refreshed successfully. The source is ready — proceed with using its tools directly.`;
}

/**
 * For an authenticated source, report a usable token without asking the user to sign in
 * (UB3.11, upstream v0.15.1 `reuseOrRefreshToken`): the stored token if it is still
 * valid, else a refreshed one. Returns null when only a new sign-in will do — the
 * caller then raises its card.
 */
async function reuseOrRefreshToken(ctx: SessionToolContext, config: SourceConfig): Promise<ToolResult | null> {
  if (!config.isAuthenticated || !ctx.credentialManager) return null;
  const loadedSource = toLoadedSource(ctx, config);
  if (await ctx.credentialManager.getToken(loadedSource)) {
    return successResponse(`Source '${config.slug}' is already authenticated.`);
  }
  if (await ctx.credentialManager.refresh(loadedSource)) {
    return successResponse(refreshedMessage(config.slug));
  }
  return null;
}

// ============================================================
// MCP OAuth Trigger
// ============================================================

export interface SourceOAuthTriggerArgs {
  /** User-created source target. */
  sourceSlug?: string;
  /** Capability-path plugin-server target (C2): pass with serverName. */
  pluginKey?: string;
  /** Capability-path plugin-server target (C2): pass with pluginKey. */
  serverName?: string;
}

/**
 * Handle the source_oauth_trigger tool call.
 * Triggers OAuth 2.0 + PKCE flow for MCP sources OR (capability path) for a
 * plugin-owned MCP server's global credential slot.
 */
export async function handleSourceOAuthTrigger(
  ctx: SessionToolContext,
  args: SourceOAuthTriggerArgs
): Promise<ToolResult> {
  const { sourceSlug, pluginKey, serverName } = args;

  // Plugin-server target: authenticates the server's GLOBAL slot, never a source.
  if (pluginKey !== undefined || serverName !== undefined) {
    if (!pluginKey || !serverName) {
      return errorResponse('A plugin MCP server target requires BOTH pluginKey and serverName.');
    }
    if (sourceSlug) {
      return errorResponse('Pass either sourceSlug or pluginKey+serverName, not both.');
    }
    if (!ctx.resolvePluginMcpServer) {
      return errorResponse('Plugin MCP server authentication is not available in this session runtime.');
    }
    const server = ctx.resolvePluginMcpServer(pluginKey, serverName);
    if (!server) {
      return errorResponse(`Plugin MCP server '${serverName}' of plugin '${pluginKey}' not found or not enabled.`);
    }
    if (server.authType !== 'oauth') {
      return errorResponse(`Plugin MCP server '${serverName}' is not configured for OAuth authentication.`);
    }
    const pluginAuthRequest: McpOAuthAuthRequest = {
      type: 'oauth',
      requestId: generateRequestId('oauth'),
      sessionId: ctx.sessionId,
      // Display identity only — completion routes by pluginServer.
      sourceSlug: serverName,
      sourceName: server.displayName,
      pluginServer: { pluginKey, serverName },
    };
    ctx.callbacks.onAuthRequest(pluginAuthRequest);
    return successResponse(
      `OAuth authentication requested for '${server.displayName}'. Opening browser for authentication.`
    );
  }

  if (!sourceSlug) {
    return errorResponse('Provide sourceSlug, or pluginKey+serverName for a plugin MCP server.');
  }

  // Load source config
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // Validate source uses OAuth — supports MCP OAuth and generic API OAuth (with or without oauth config block)
  const isMcpOAuth = source.type === 'mcp' && source.mcp?.authType === 'oauth';
  const isApiOAuth = source.type === 'api' && source.api?.authType === 'oauth';

  if (!isMcpOAuth && !isApiOAuth) {
    return errorResponse(
      `Source '${sourceSlug}' is not configured for OAuth authentication.`
    );
  }

  // Try silent refresh only if source is already authenticated.
  // If connectionStatus is 'needs_auth' or isAuthenticated is false,
  // skip refresh and go straight to browser authorization flow.
  if (source.isAuthenticated && ctx.credentialManager) {
    const refreshedToken = await ctx.credentialManager.refresh(toLoadedSource(ctx, source));
    if (refreshedToken) {
      return successResponse(refreshedMessage(sourceSlug));
    }
  }

  // Build auth request
  const authRequest: McpOAuthAuthRequest = {
    type: 'oauth',
    requestId: generateRequestId('oauth'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
  };

  // Trigger auth request (will cause forceAbort)
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `OAuth authentication requested for '${source.name}'. Opening browser for authentication.`
  );
}

// ============================================================
// Google OAuth Trigger
// ============================================================

export interface GoogleOAuthTriggerArgs {
  sourceSlug: string;
}

/**
 * Handle the source_google_oauth_trigger tool call.
 * Triggers Google OAuth for Gmail, Calendar, Drive, etc.
 */
export async function handleGoogleOAuthTrigger(
  ctx: SessionToolContext,
  args: GoogleOAuthTriggerArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;

  // Load source config
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // Verify this is a Google source
  if (source.provider !== 'google') {
    const hint = !source.provider
      ? `Add "provider": "google" to config.json and retry.`
      : `This source has provider '${source.provider}'. Use source_oauth_trigger for MCP sources.`;
    return errorResponse(
      `Source '${sourceSlug}' is not configured as a Google API source. ${hint}`
    );
  }

  // Check if Google OAuth is configured (if method available)
  if (ctx.isGoogleOAuthConfigured) {
    const api = source.api;
    if (!ctx.isGoogleOAuthConfigured(api?.googleOAuthClientId, api?.googleOAuthClientSecret)) {
      return errorResponse(
        `Google OAuth credentials not configured for source '${sourceSlug}'.

To authenticate with Google services, you need to provide your own OAuth credentials.

**Option 1: Add credentials to source config**
Edit the source's config.json and add:
\`\`\`json
{
  "api": {
    "googleOAuthClientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "googleOAuthClientSecret": "YOUR_CLIENT_SECRET"
  }
}
\`\`\`

**Option 2: Set environment variables**
\`\`\`bash
export GOOGLE_OAUTH_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
export GOOGLE_OAUTH_CLIENT_SECRET="YOUR_CLIENT_SECRET"
\`\`\``
      );
    }
  }

  // A valid or refreshable token needs no sign-in card (UB3.11, upstream
  // v0.15.1): the stored token if still valid, else a refreshed one — an
  // expired token with a working refresh token must not raise the card. Null
  // means only a new sign-in will do.
  const ready = await reuseOrRefreshToken(ctx, source);
  if (ready) return ready;

  // Determine service from config
  let service: GoogleService | undefined;
  if (source.api?.googleService) {
    service = source.api.googleService;
  } else if (ctx.inferGoogleService) {
    service = ctx.inferGoogleService(source.api?.baseUrl);
  }

  // Build auth request
  const authRequest: GoogleOAuthAuthRequest = {
    type: 'oauth-google',
    requestId: generateRequestId('google-oauth'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
    service,
  };

  // Trigger auth request
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `Google OAuth requested for '${source.name}'. Opening browser for authentication.`
  );
}
