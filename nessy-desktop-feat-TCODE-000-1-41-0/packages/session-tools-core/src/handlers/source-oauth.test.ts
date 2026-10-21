/**
 * UB3.11 (upstream v0.15.1 `source-oauth.test.ts`, ported onto our triggers):
 * a provider OAuth trigger refreshes before asking the user to sign in.
 *
 * The Google trigger used to check ONLY `getToken` — null on expiry — so an
 * expired token with a perfectly good refresh token raised a sign-in card
 * while the MCP trigger beside it refreshed first. Both now share
 * `reuseOrRefreshToken`: valid token → "already authenticated", refreshable →
 * "refreshed successfully", else the card.
 *
 * Slack/Microsoft arms are absent BY DESIGN: those triggers are removed in
 * ours (the row's Runtimes line records them N/A); upstream's suite covers
 * them, ours has nothing to cover.
 */

import { describe, expect, it } from 'bun:test';
import {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
} from './source-oauth.ts';
import type { SessionToolContext, CredentialManagerInterface } from '../context.ts';
import type { AuthRequest, SourceConfig } from '../types.ts';

const SOURCES: Record<string, SourceConfig> = {
  gmail: {
    id: 'gmail', name: 'Gmail', slug: 'gmail', enabled: true, provider: 'google', type: 'api',
    isAuthenticated: true,
    api: { baseUrl: 'https://gmail.googleapis.com', authType: 'oauth', googleService: 'gmail' },
  } as SourceConfig,
  linear: {
    id: 'linear', name: 'Linear', slug: 'linear', enabled: true, provider: 'linear', type: 'mcp',
    isAuthenticated: true,
    mcp: { url: 'https://mcp.linear.app', authType: 'oauth' },
  } as SourceConfig,
};

function createCtx(opts: {
  token?: string | null;
  refreshed?: string | null;
  isAuthenticated?: boolean;
}): { ctx: SessionToolContext; authRequests: AuthRequest[]; calls: string[] } {
  const authRequests: AuthRequest[] = [];
  const calls: string[] = [];
  const credentialManager: CredentialManagerInterface = {
    hasValidCredentials: async () => !!opts.token,
    getToken: async source => { calls.push(`getToken:${source.workspaceId}:${source.config.slug}`); return opts.token ?? null; },
    refresh: async source => { calls.push(`refresh:${source.workspaceId}:${source.config.slug}`); return opts.refreshed ?? null; },
  };
  const ctx = {
    sessionId: 'session-1',
    workspacePath: '/workspaces/ws-1',
    loadSourceConfig: (slug: string) => {
      const config = SOURCES[slug];
      return config ? { ...config, isAuthenticated: opts.isAuthenticated ?? config.isAuthenticated } : null;
    },
    credentialManager,
    callbacks: { onAuthRequest: (request: AuthRequest) => authRequests.push(request) },
  } as unknown as SessionToolContext;
  return { ctx, authRequests, calls };
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe('provider OAuth triggers refresh before asking the user to sign in', () => {
  it('Google: a valid token needs no sign-in', async () => {
    const { ctx, authRequests, calls } = createCtx({ token: 'still-valid' });
    const result = await handleGoogleOAuthTrigger(ctx, { sourceSlug: 'gmail' });

    expect(text(result)).toBe(`Source 'gmail' is already authenticated.`);
    expect(authRequests).toHaveLength(0);
    expect(calls).toEqual(['getToken:ws-1:gmail']);
  });

  it('Google: an expired token that refreshes needs no sign-in card (the row\'s fix)', async () => {
    const { ctx, authRequests, calls } = createCtx({ token: null, refreshed: 'fresh-token' });
    const result = await handleGoogleOAuthTrigger(ctx, { sourceSlug: 'gmail' });

    expect(result.isError).toBe(false);
    expect(text(result)).toContain('refreshed successfully');
    expect(authRequests).toHaveLength(0);
    expect(calls).toEqual(['getToken:ws-1:gmail', 'refresh:ws-1:gmail']);
  });

  it('Google: a failed refresh asks the user to sign in (the control)', async () => {
    const { ctx, authRequests, calls } = createCtx({ token: null, refreshed: null });
    const result = await handleGoogleOAuthTrigger(ctx, { sourceSlug: 'gmail' });

    expect(text(result)).toContain('requested');
    expect(calls).toEqual(['getToken:ws-1:gmail', 'refresh:ws-1:gmail']);
    expect(authRequests).toHaveLength(1);
    expect(authRequests[0]).toMatchObject({ type: 'oauth-google', sourceSlug: 'gmail', sessionId: 'session-1' });
  });

  it('Google: a source that needs auth skips the refresh and asks to sign in', async () => {
    const { ctx, authRequests, calls } = createCtx({ isAuthenticated: false, refreshed: 'would-refresh' });
    await handleGoogleOAuthTrigger(ctx, { sourceSlug: 'gmail' });

    expect(calls).toEqual([]);
    expect(authRequests).toHaveLength(1);
  });

  it('MCP: still refreshes before asking to sign in (the pre-existing control, unchanged)', async () => {
    const refreshed = createCtx({ refreshed: 'fresh-token' });
    expect(text(await handleSourceOAuthTrigger(refreshed.ctx, { sourceSlug: 'linear' }))).toContain('refreshed successfully');
    expect(refreshed.authRequests).toHaveLength(0);

    const failed = createCtx({ refreshed: null });
    await handleSourceOAuthTrigger(failed.ctx, { sourceSlug: 'linear' });
    expect(failed.calls).toEqual(['refresh:ws-1:linear']);
    expect(failed.authRequests[0]).toMatchObject({ type: 'oauth', sourceSlug: 'linear' });
  });
});
