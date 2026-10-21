/**
 * F1.310 (origin WJ-ee verifier F1.236-b, 2026-09-23) — `source_test`'s
 * authenticated API probe must not hand a malformed stored credential back to
 * the model.
 *
 * `testApiConnectionWithAuth` builds the auth header (or query parameter) from
 * the stored token and calls the REAL fetch. When the runtime refuses a
 * malformed value — under bun a bearer carrying a zero-width space or smart
 * quotes, a header value carrying an LF — its error message quotes the value,
 * and the handler returned it verbatim as `✗ Connection failed: <message>` in
 * the tool result and in the `error` field. The fix masks the token and every
 * auth header value built from it out of that message with F1.309's helper
 * (`maskKnownCredentialValues`, `@nessy-agent/shared/agent/tool-result-secret-scan`).
 *
 * Driven in-process through the real `handleSourceTest` with the unstubbed
 * fetch; nothing leaves the machine (the malformed values are refused before a
 * socket opens, and the base URL is loopback). Every credential is built from
 * random bytes — none is real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSourceTest } from './source-test.ts';
import type { SessionToolContext } from '../context.ts';
import type { SourceConfig } from '../types.ts';

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

function createCtx(workspacePath: string, token: string): SessionToolContext {
  return {
    sessionId: 'f1310-session',
    workspacePath,
    get sourcesPath() {
      return join(workspacePath, 'sources');
    },
    get skillsPath() {
      return join(workspacePath, 'skills');
    },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    loadSourceConfig: (slug: string) => {
      const configPath = join(workspacePath, 'sources', slug, 'config.json');
      if (!existsSync(configPath)) return null;
      return JSON.parse(readFileSync(configPath, 'utf-8')) as SourceConfig;
    },
    saveSourceConfig: (source: SourceConfig) => {
      writeFileSync(join(workspacePath, 'sources', source.slug, 'config.json'), JSON.stringify(source, null, 2));
    },
    credentialManager: {
      hasValidCredentials: async () => true,
      getToken: async () => token,
      refresh: async () => null,
    },
  } as unknown as SessionToolContext;
}

function writeApiSource(workspacePath: string, slug: string, api: Record<string, unknown>): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config = {
    id: slug,
    slug,
    name: `Test ${slug}`,
    enabled: true,
    provider: 'test',
    type: 'api',
    tagline: 'An API source with a malformed stored credential',
    icon: '🧪',
    isAuthenticated: true,
    api: { baseUrl: 'http://127.0.0.1:9', testEndpoint: { method: 'GET', path: '/ping' }, ...api },
  };
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the credential scrub on the connection-failure path.',
  );
}

/** The whole value, and each printable run of it long enough to identify it. */
const fragments = (secret: string): string[] =>
  [secret, ...secret.split(/[^\x21-\x7e]+/u).filter((part) => part.length >= 8)];

const resultText = (result: Awaited<ReturnType<typeof handleSourceTest>>): string =>
  JSON.stringify(result);

describe('F1.310 — source_test does not return a malformed credential', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wjoo-f1310-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const ARMS: Array<{ label: string; api: Record<string, unknown>; token: string; secrets: (token: string) => string[] }> = [
    { label: 'bearer with U+200B', api: { authType: 'bearer' }, token: `zw${hex(10)}\u200B${hex(10)}`, secrets: (t) => [t] },
    { label: 'bearer with smart quotes', api: { authType: 'bearer' }, token: `sq${hex(10)}\u201C${hex(6)}\u201D`, secrets: (t) => [t] },
    { label: 'custom header with an LF', api: { authType: 'header', headerName: 'X-Api-Key' }, token: `lf${hex(10)}\n${hex(10)}`, secrets: (t) => [t] },
    {
      label: 'multi-header value with U+200B',
      api: { authType: 'header', headerNames: ['X-Api-Key'] },
      token: JSON.stringify({ 'X-Api-Key': `mh${hex(10)}\u200B${hex(10)}` }),
      secrets: (t) => [(JSON.parse(t) as Record<string, string>)['X-Api-Key']!],
    },
  ];

  for (const arm of ARMS) {
    it(`${arm.label}: the token is absent, the failure is still reported`, async () => {
      writeApiSource(tempDir, 'f1310-src', arm.api);
      const ctx = createCtx(tempDir, arm.token);
      const result = await handleSourceTest(ctx, { sourceSlug: 'f1310-src', autoEnable: false });
      const text = resultText(result);
      expect(text).toContain('Connection failed');
      for (const secret of arm.secrets(arm.token)) {
        for (const part of fragments(secret)) expect(text).not.toContain(JSON.stringify(part).slice(1, -1));
      }
    });
  }

  it('negative control: a well-formed token that fails for another reason reports that reason unmasked', async () => {
    // Port 9 on loopback refuses the connection; nothing about the credential is in the message.
    writeApiSource(tempDir, 'f1310-ok', { authType: 'bearer' });
    const ctx = createCtx(tempDir, `ok${hex(16)}`);
    const text = resultText(await handleSourceTest(ctx, { sourceSlug: 'f1310-ok', autoEnable: false }));
    expect(text).toContain('Connection failed');
    expect(text).not.toContain('[REDACTED:credential]');
  });
});
