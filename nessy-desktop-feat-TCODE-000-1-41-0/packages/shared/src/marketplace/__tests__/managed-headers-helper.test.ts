/**
 * P6.479 — the managed tier's `headersHelper`, the one command shape this app
 * runs.
 *
 * Every assertion here is a sentence of
 * `plugins/host-marketplace.md#write-the-headershelper-command` or
 * `#when-claude-code-skips-a-headershelper-command-or-drops-its-output`, quoted
 * on the case it governs. The commands are real: the point of the row is that a
 * shell runs, so a stubbed runner would prove nothing about the gates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearManagedHeadersHelperReuse,
  isDocumentedHelperCommandText,
  MANAGED_HEADERS_HELPER_MAX_COMMAND_CHARS,
  MANAGED_HEADERS_HELPER_REUSE_MS,
  resolveManagedMarketplaceHeaders,
} from '../managed-headers-helper.ts';

const URL_SOURCE = 'https://registry.example.com/plugins/marketplace.json';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'managed-headers-helper-'));
  clearManagedHeadersHelperReuse();
});

afterEach(() => {
  clearManagedHeadersHelperReuse();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('the documented command-text shape', () => {
  it('accepts what the page allows and refuses each clause it forbids', () => {
    // "at most 500 characters of printable ASCII, with no run of four or more
    // spaces."
    expect(isDocumentedHelperCommandText('a'.repeat(MANAGED_HEADERS_HELPER_MAX_COMMAND_CHARS))).toBe(true);
    expect(isDocumentedHelperCommandText('a'.repeat(MANAGED_HEADERS_HELPER_MAX_COMMAND_CHARS + 1))).toBe(false);
    expect(isDocumentedHelperCommandText('/opt/bin/mint --scope plugins')).toBe(true);
    // Three spaces is a run of three, which the sentence permits.
    expect(isDocumentedHelperCommandText('mint   token')).toBe(true);
    expect(isDocumentedHelperCommandText('mint    token')).toBe(false);
    expect(isDocumentedHelperCommandText('mint\ttoken')).toBe(false);
    expect(isDocumentedHelperCommandText('mint\ntoken')).toBe(false);
    expect(isDocumentedHelperCommandText('mint —token')).toBe(false);
    expect(isDocumentedHelperCommandText('')).toBe(false);
  });
});

describe('resolveManagedMarketplaceHeaders', () => {
  it('runs the command and sends the JSON object it prints, with both documented variables set', async () => {
    // "**Variables Claude Code sets**: `CLAUDE_CODE_MARKETPLACE_URL` and
    // `CLAUDE_CODE_MARKETPLACE_NAME` for a `url` source's command".
    const outcome = await resolveManagedMarketplaceHeaders(
      {
        marketplaceName: 'acme-internal',
        url: URL_SOURCE,
        command: 'printf \'{"Authorization":"Bearer %s","X-Registry-Url":"%s"}\''
          + ' "$CLAUDE_CODE_MARKETPLACE_NAME" "$CLAUDE_CODE_MARKETPLACE_URL"',
      },
      { cwd: tempDir },
    );
    expect(outcome).toEqual({
      state: 'headers',
      headers: { Authorization: 'Bearer acme-internal', 'X-Registry-Url': URL_SOURCE },
      fromCache: false,
    });
  });

  it('runs it from the configuration directory the caller names', async () => {
    // "**Shell and working directory**: Claude Code runs the command through
    // `sh` … from the configuration directory".
    writeFileSync(join(tempDir, 'token.txt'), 'from-the-config-dir');
    const outcome = await resolveManagedMarketplaceHeaders(
      {
        marketplaceName: 'acme',
        url: URL_SOURCE,
        // A RELATIVE path, which is the whole point: "a relative path resolves
        // against that directory, not the user's project."
        command: 'printf \'{"Authorization":"Bearer %s"}\' "$(cat token.txt)"',
      },
      { cwd: tempDir },
    );
    expect(outcome).toEqual({
      state: 'headers',
      headers: { Authorization: 'Bearer from-the-config-dir' },
      fromCache: false,
    });
  });

  it('drops routing and identity names from the command OUTPUT, keeping the authentication one', async () => {
    // "Claude Code drops request-routing and client-identity names such as
    // `Host`, `Cookie`, and `X-Forwarded-*` from an entry's `headers` and
    // command output, and keeps authentication names such as `Authorization`."
    const outcome = await resolveManagedMarketplaceHeaders(
      {
        marketplaceName: 'acme',
        url: URL_SOURCE,
        command: 'printf \'{"Authorization":"Bearer keep","Cookie":"session=drop","X-Forwarded-For":"10.0.0.1"}\'',
      },
      { cwd: tempDir },
    );
    expect(outcome).toEqual({
      state: 'headers',
      headers: { Authorization: 'Bearer keep' },
      fromCache: false,
    });
  });

  it('reuses one run\'s output for up to 60 seconds, and runs again once that window closes', async () => {
    // "Claude Code reuses one run's output for up to 60 seconds."
    const counter = join(tempDir, 'runs');
    writeFileSync(counter, '');
    const request = {
      marketplaceName: 'acme',
      url: URL_SOURCE,
      command: `printf '{"Authorization":"Bearer minted"}'; printf x >> ${counter}`,
    };
    let clock = 1_000;
    const options = { cwd: tempDir, now: () => clock };
    const runs = () => readFileSync(counter, 'utf-8').length;

    const first = await resolveManagedMarketplaceHeaders(request, options);
    expect(first).toMatchObject({ state: 'headers', fromCache: false });
    expect(runs()).toBe(1);

    clock += MANAGED_HEADERS_HELPER_REUSE_MS - 1;
    const reused = await resolveManagedMarketplaceHeaders(request, options);
    expect(reused).toEqual({ state: 'headers', headers: { Authorization: 'Bearer minted' }, fromCache: true });
    expect(runs()).toBe(1);

    clock += 2;
    const afterExpiry = await resolveManagedMarketplaceHeaders(request, options);
    expect(afterExpiry).toMatchObject({ state: 'headers', fromCache: false });
    expect(runs()).toBe(2);
  });

  it('keys the reuse on the COMMAND, so a rewritten policy is not served the old token', async () => {
    const clock = 1_000;
    const options = { cwd: tempDir, now: () => clock };
    const first = await resolveManagedMarketplaceHeaders(
      { marketplaceName: 'acme', url: URL_SOURCE, command: 'printf \'{"Authorization":"one"}\'' },
      options,
    );
    const second = await resolveManagedMarketplaceHeaders(
      { marketplaceName: 'acme', url: URL_SOURCE, command: 'printf \'{"Authorization":"two"}\'' },
      options,
    );
    expect(first).toMatchObject({ headers: { Authorization: 'one' }, fromCache: false });
    expect(second).toMatchObject({ headers: { Authorization: 'two' }, fromCache: false });
  });

  it('does not run the command when the marketplace URL is not https', async () => {
    // "**Marketplace URL doesn't start with `https://`**: Claude Code doesn't
    // run that `url` source's command and sends only the headers listed in its
    // `headers` field."
    const marker = join(tempDir, 'ran');
    const outcome = await resolveManagedMarketplaceHeaders(
      {
        marketplaceName: 'acme',
        url: 'http://registry.example.com/marketplace.json',
        command: `printf '{"Authorization":"Bearer minted"}'; printf x >> ${marker}`,
      },
      { cwd: tempDir },
    );
    expect(outcome).toEqual({ state: 'not-run', reason: 'not-https' });
    expect(() => readFileSync(marker, 'utf-8')).toThrow();
  });

  it('does not run a command outside the documented text shape', async () => {
    const outcome = await resolveManagedMarketplaceHeaders(
      { marketplaceName: 'acme', url: URL_SOURCE, command: `printf '{}'    ${'x'.repeat(4)}` },
      { cwd: tempDir },
    );
    expect(outcome).toEqual({ state: 'not-run', reason: 'command-text' });
  });

  it('fails CLOSED on a non-zero exit, on a timeout, and on stdout that is not a JSON object', async () => {
    // "**Command fails**: if the command exits non-zero, runs past 10 seconds,
    // or prints anything other than a JSON object of string values, Claude Code
    // doesn't make the fetch or download it ran the command for."
    expect(await resolveManagedMarketplaceHeaders(
      { marketplaceName: 'acme', url: URL_SOURCE, command: 'exit 3' },
      { cwd: tempDir },
    )).toEqual({ state: 'failed', reason: 'non-zero-exit' });

    expect(await resolveManagedMarketplaceHeaders(
      { marketplaceName: 'acme', url: URL_SOURCE, command: 'printf \'["Authorization"]\'' },
      { cwd: tempDir },
    )).toEqual({ state: 'failed', reason: 'malformed-stdout' });

    expect(await resolveManagedMarketplaceHeaders(
      { marketplaceName: 'acme', url: URL_SOURCE, command: 'printf \'{"Authorization":7}\'' },
      { cwd: tempDir },
    )).toEqual({ state: 'failed', reason: 'malformed-stdout' });

    expect(await resolveManagedMarketplaceHeaders(
      { marketplaceName: 'acme', url: URL_SOURCE, command: 'sleep 5' },
      { cwd: tempDir, timeoutMs: 50 },
    )).toEqual({ state: 'failed', reason: 'timeout' });
  });

  it('never caches a failure — the next fetch runs the command again', async () => {
    const clock = 1_000;
    const options = { cwd: tempDir, now: () => clock };
    const request = { marketplaceName: 'acme', url: URL_SOURCE, command: 'exit 1' };
    expect(await resolveManagedMarketplaceHeaders(request, options)).toEqual({ state: 'failed', reason: 'non-zero-exit' });
    expect(await resolveManagedMarketplaceHeaders(request, options)).toEqual({ state: 'failed', reason: 'non-zero-exit' });
  });
});
