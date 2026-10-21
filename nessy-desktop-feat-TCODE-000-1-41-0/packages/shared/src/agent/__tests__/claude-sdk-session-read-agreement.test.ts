/**
 * P3.269 (2) — THE HOST AND THE SDK AGREE ABOUT WHERE A CLAUDE TRANSCRIPT LIVES.
 *
 * `claude-transcript-rebuild.ts` re-implements three things read out of the
 * minified bundle: the djb2 project-key hash, the platform-gated NFC cwd
 * normalizer, and the JSONL record layout. The row's verdict was that the WRITE
 * side genuinely has no SDK API while the READ side does
 * (`getSessionMessages` / `listSessions` / `getSessionInfo`) and is unused — and
 * that the hash duplication is the one that "silently diverges on an SDK bump".
 *
 * ## What the row asked for, and what it got
 *
 * "Switch the read to the SDK, keep the host write where no API exists, and
 * **pin that the two agree on the day of the switch**."
 *
 * The switch is refuted for both of the host's own read predicates, measured:
 *
 *  - `claudeTranscriptIsLoadable` is a SYNCHRONOUS `size > 0` stat deliberately
 *    mirroring the SDK's own locator, and its caller
 *    (`ClaudeAgent.shouldSuppressTextHandoff`) is a `boolean`-returning override
 *    of a base-class method. `getSessionInfo` is async AND has different
 *    semantics — its own typing says it "Returns undefined if the session file
 *    is not found, **is a sidechain session, or has no extractable summary**",
 *    so a perfectly loadable rebuilt transcript with no summary would read as
 *    absent and deliver a text handoff over a good file.
 *  - The three SDK readers resolve their root from `process.env.CLAUDE_CONFIG_DIR`
 *    at call time, and this host points each WORKSPACE's child at its own config
 *    dir while the host process keeps none. Calling them from the host means
 *    mutating a process-global for the duration of the call — a race across
 *    concurrent workspaces in the headless server.
 *
 * So what lands is the half the row said mattered: the AGREEMENT PIN. If a bump
 * changes the hash, the sanitizer, the length ceiling, the NFC gate or the
 * record layout, the SDK's own reader stops finding the file the host wrote —
 * and that is the failure this test exists to make loud, because in production
 * it presents as a silently empty resume.
 *
 * The probe runs in a CHILD (see the fixture's header) so `CLAUDE_CONFIG_DIR`
 * is never mutated in the shared test runner.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeTranscriptSdkReaderProbeResult } from './fixtures/claude-transcript-sdk-reader-probe.ts';

const PROBE = new URL('./fixtures/claude-transcript-sdk-reader-probe.ts', import.meta.url).pathname;

async function runProbe(arm: 'short' | 'hashed' = 'short'): Promise<ClaudeTranscriptSdkReaderProbeResult> {
  // NESSY_CONFIG_DIR is exported BEFORE bun starts in the child — the only form
  // that isolates on every invocation shape (AGENTS.md: the root bunfig's own
  // top-level preload runs ahead of any CLI `--preload`, so `bun <file>` is not
  // isolated by the runner's mechanism and the child would refuse to run).
  const isolated = mkdtempSync(join(tmpdir(), 'nessy-w2b-cfg-'));
  const child = Bun.spawn(['bun', PROBE, arm], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NESSY_CONFIG_DIR: isolated },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`);
  const line = out.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`probe produced no result line. stderr: ${err}`);
  return JSON.parse(line) as ClaudeTranscriptSdkReaderProbeResult;
}

describe("P3.269 — the SDK's own readers find what the host's rebuild wrote", () => {
  it('getSessionMessages recovers every record, chained, from the host-derived path', async () => {
    const result = await runProbe();
    // The host wrote 2 records at a path IT derived. The SDK found them by
    // deriving the same path from the same cwd — which is the whole agreement.
    expect(result.hostRecords).toBe(2);
    expect(result.sdkMessages).toBe(2);
    // Chained, in order: the SDK's loader walks `parentUuid` and DROPS unlinked
    // records, so a count that matches is also a chaining verdict.
    expect(result.sdkRoles).toEqual(['user', 'assistant']);
  }, 30_000);

  it('listSessions and getSessionInfo resolve the same project directory and id', async () => {
    const result = await runProbe();
    expect(result.sdkListed).toBe(1);
    expect(result.sdkSessionIdFound).toBe(result.sdkSessionId);
    // The cwd the SDK read back out of the file is the one the host stamped —
    // the normalizer agreeing in the direction that matters on darwin.
    expect(result.sdkCwd).toBe(result.hostCwd);
  }, 30_000);

  it('THE HASHED ARM — a >200-character cwd, where the djb2 suffix is the path', async () => {
    // `claudeProjectKey` appends `-<base36 djb2 of the ORIGINAL path>` only once
    // the sanitized form passes 200 characters. A re-break proved this arm is
    // the ONLY coverage the hash has: mutating djb2's shift left the short-arm
    // probe entirely green, because on a short path the hash is dead code — and
    // the hash is the half the row calls out as "the one that silently diverges
    // on an SDK bump".
    const result = await runProbe('hashed');
    expect(result.arm).toBe('hashed');
    expect(result.projectKey.length).toBeGreaterThan(200);
    // Truncated at 200 and suffixed — the shape the SDK's own `Yo` produces.
    expect(result.projectKey.slice(200, 201)).toBe('-');
    expect(result.projectKey.slice(201)).toMatch(/^[0-9a-z]+$/);
    // And the SDK finds it there.
    expect(result.sdkMessages).toBe(2);
    expect(result.sdkSessionIdFound).toBe(result.sdkSessionId);
  }, 60_000);

  it('the host path is the SDK-shaped one, and the derivation is still hand-written', () => {
    // The pin above only means something while the host is still deriving the
    // path itself; if a future change adopts an SDK path helper this assertion
    // is the reminder to retire the agreement test with it.
    const source = readFileSync(new URL('../claude-transcript-rebuild.ts', import.meta.url), 'utf8');
    for (const marker of ['function djb2', 'claudeProjectKey', 'normalizeClaudeTranscriptCwd', "'projects'", 'CLAUDE_PROJECT_KEY_MAX_LENGTH = 200']) {
      expect(source).toContain(marker);
    }
  });

  it('THE REFUTATION, quoted from the shipped typings rather than argued', () => {
    const typings = readFileSync(
      require.resolve('@anthropic-ai/claude-agent-sdk').replace(/sdk\.mjs$/, 'sdk.d.ts'),
      'utf8',
    );
    // Why `claudeTranscriptIsLoadable` cannot become `getSessionInfo`.
    expect(typings).toContain('is a sidechain session');
    expect(typings).toContain('has no extractable summary');
    // And why the write side stays: there is no writer in the module surface —
    // `forkSession` copies an EXISTING session, and the store APIs are `@alpha`
    // and require a `SessionStore` this host does not implement.
    expect(typings).not.toContain('export declare function writeSessionMessages');
    // POSITIVE CONTROL for that absence: the readers the row named DO exist.
    for (const reader of ['export declare function getSessionMessages', 'export declare function listSessions', 'export declare function getSessionInfo']) {
      expect(typings).toContain(reader);
    }
  });
});
