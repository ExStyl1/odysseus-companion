/**
 * UB14.48 — the stored connection verdict, normalised and reduced for the capability summary.
 *
 * The `normalizeStoredStatus` cases are copied from craft-agents-oss
 * `v0.15.1:apps/electron/src/renderer/components/ui/__tests__/source-connection-status.test.ts`
 * (Apache-2.0) and adapted: upstream's `deriveConnectionStatus` arms are not taken (P6.768 deleted ours;
 * the renderer's verdict over the safe row is pinned in `source-status-indicator.test.tsx`). The
 * `sanitizeStoredConnectionError` arms are ours.
 */

import { describe, expect, it } from 'bun:test';
import {
  STORED_CONNECTION_ERROR_MAX,
  normalizeStoredStatus,
  sanitizeStoredConnectionError,
} from '../connection-status.ts';
import type { SourceConnectionStatus } from '../types.ts';

const FAKE_GITHUB_PAT = 'ghp_' + 'C'.repeat(36);

describe('normalizeStoredStatus (v0.15.1)', () => {
  it('keeps the app statuses', () => {
    for (const s of ['connected', 'needs_auth', 'failed', 'untested', 'local_disabled']) {
      expect(normalizeStoredStatus(s)).toBe(s as SourceConnectionStatus);
    }
  });

  it("maps source_test's vocabulary onto the app's", () => {
    expect(normalizeStoredStatus('error')).toBe('failed');
    expect(normalizeStoredStatus('disconnected')).toBe('failed');
    expect(normalizeStoredStatus('unknown')).toBe('untested');
    expect(normalizeStoredStatus('something-new')).toBe('untested');
  });
});

describe('sanitizeStoredConnectionError (UB14.48)', () => {
  it('reduces a URL to scheme and host: no userinfo, path, query or fragment', () => {
    const out = sanitizeStoredConnectionError(
      'HTTP 502 from https://user:pw@mcp.example.com:8443/api/s/abc123secret/mcp?api_key=Q1W2E3#frag. Retry later.',
    );
    expect(out).toBe('HTTP 502 from https://mcp.example.com:8443/…. Retry later.');
    for (const leaked of ['user:pw', 'abc123secret', 'api_key', 'Q1W2E3', 'frag']) {
      expect(out).not.toContain(leaked);
    }
    // Boundary: a bare origin gains no elision marker.
    expect(sanitizeStoredConnectionError('fetch failed: https://mcp.example.com')).toBe(
      'fetch failed: https://mcp.example.com',
    );
  });

  it('keeps only the last segment of an absolute filesystem path', () => {
    expect(sanitizeStoredConnectionError('spawn /Users/alice/.nvm/versions/node/v20/bin/npx ENOENT')).toBe(
      'spawn …/npx ENOENT',
    );
    expect(sanitizeStoredConnectionError('C:\\Users\\alice\\tools\\server.exe was not found')).toBe(
      '…\\server.exe was not found',
    );
    expect(sanitizeStoredConnectionError('cannot read file:///home/alice/cfg/settings.json')).toBe(
      'cannot read file://…/settings.json',
    );
  });

  it('control — an HTTP route and plain prose are left as the server wrote them', () => {
    const route = 'POST /api/v1/tools returned 500 (HTTP/1.1, and/or upstream timeout)';
    expect(sanitizeStoredConnectionError(route)).toBe(route);
  });

  it('replaces a recognised secret with its rule marker', () => {
    const out = sanitizeStoredConnectionError(`Auth failed with token ${FAKE_GITHUB_PAT}`);
    expect(out).toBe('Auth failed with token [REDACTED:github-pat]');
    expect(out).not.toContain(FAKE_GITHUB_PAT);
  });

  it('drops control characters but keeps line breaks, and caps the length', () => {
    expect(sanitizeStoredConnectionError('  line one\u0007\nline two\u001b  ')).toBe('line one\nline two');
    const long = sanitizeStoredConnectionError('x'.repeat(STORED_CONNECTION_ERROR_MAX * 2));
    expect(long).toHaveLength(STORED_CONNECTION_ERROR_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('is absent for a non-string or blank value', () => {
    expect(sanitizeStoredConnectionError(undefined)).toBeUndefined();
    expect(sanitizeStoredConnectionError(42)).toBeUndefined();
    expect(sanitizeStoredConnectionError({ message: 'x' })).toBeUndefined();
    expect(sanitizeStoredConnectionError('  \n\t ')).toBeUndefined();
  });
});
