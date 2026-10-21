/**
 * F1.512 (origin WJ-af P-WJ-af-4) — the vendored SDK's OWN writes to the host's
 * `process.env` must not read as a construction drift of the claude child.
 *
 * ## The defect, measured before this file existed
 *
 * `claudeLiveSessionSignature` (`backend/claude/live-session.ts`) hashes the
 * whole `options.env`, and every turn head builds that env from
 * `{ ...process.env, … }` (`buildClaudeSubprocessEnv`, `agent/options.ts`). The
 * vendored SDK's `query()` writes `process.env.CLAUDE_AGENT_SDK_VERSION` on
 * EVERY call, before it spawns anything. So the first turn of an app run hashes
 * an env WITHOUT the name, `query()` adds it, and the second turn hashes an env
 * WITH it: a drift, `ensureLiveSession` logs "Live session options drifted —
 * respawning", and `endLiveSession` takes every background task turn 1 started
 * down with the child. WJ-af measured it on the vendored claude 2.1.251 driven
 * through `ClaudeAgent` (its probe's `envDrift` reading, never committed):
 * exactly ONE name differed between turn 1's and turn 2's `options.env`, this
 * one, and the cold arms printed "A background task did not survive the Claude
 * session restart." at turn 2.
 *
 * ## The bundle is the denominator
 *
 * The names excluded from the hash are not chosen here: the first arm re-derives
 * them from the vendored `sdk.mjs` and fails on a lift that adds, drops or
 * re-values a write, so the next reader re-decides instead of inheriting a list.
 *
 * The real-SDK arms call the real `query()` with an ALREADY-ABORTED controller:
 * at 0.3.251 it performs its write and then throws "Operation aborted" before any
 * child exists (measured 2026-09-24; `sdkQueryWritesAndStops` pins the throw, so
 * a lift that starts spawning first fails loudly), and the write under test is
 * the SDK's own.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import * as liveSession from '../backend/claude/live-session.ts';
import { buildClaudeSubprocessEnv } from '../options.ts';

const STAMP = 'CLAUDE_AGENT_SDK_VERSION';
const priorStamp = process.env[STAMP];

afterEach(() => {
  // Delete first, then assign — the Bun 1.3.14 slot trap (AGENTS.md) applies to
  // a restore as much as to a write.
  delete process.env[STAMP];
  if (priorStamp !== undefined) process.env[STAMP] = priorStamp;
});

const sdkRoot = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk/package.json'));
const sdkVersion = (JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')) as { version: string }).version;
const sdkSource = readFileSync(join(sdkRoot, 'sdk.mjs'), 'utf8');

/** The signature a turn head computes, over the env a turn head builds. */
function turnSignature(): string {
  return liveSession.claudeLiveSessionSignature({ cwd: '/f1512/work', env: buildClaudeSubprocessEnv() } as never);
}

/** The SDK's own `query()`, made to write and stop before it can spawn. */
function sdkQueryWritesAndStops(): void {
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    query({
      prompt: 'F1.512',
      options: { abortController: controller, pathToClaudeCodeExecutable: '/nonexistent/f1512/claude', env: {} },
    }),
  ).toThrow('aborted');
}

describe('F1.512 — what the vendored SDK writes onto the HOST process.env (the bundle is the denominator)', () => {
  it('names exactly the writes the constant excludes, and no others', () => {
    // Every NAMED assignment (`process.env.X=`, never `==`/`===`) in the bundle.
    const named = [...new Set([...sdkSource.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)=(?!=)/g)].map(m => m[1]))].sort();
    // A reading with a date (0.3.251, 2026-09-24). DEBUG is the `debug`
    // library's `save(load())` at init — it writes the value it just read, and
    // its only other writer (`disable()`) has no caller — so it can never move
    // the hash and is deliberately NOT excluded.
    expect(named).toEqual(['CLAUDE_AGENT_SDK_VERSION', 'DEBUG', 'NoDefaultCurrentDirectoryInExePath']);
    // The ones that ORIGINATE a value (a string literal on the right) are what
    // the hash must not see.
    const originating = [...sdkSource.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)="[^"]*"/g)].map(m => m[1]).sort();
    expect(originating).toEqual([...(liveSession.CLAUDE_SDK_SELF_WRITTEN_ENV_NAMES ?? [])].sort());
    // Anti-vacuum: the stamp really carries this package's version.
    expect(sdkSource).toContain(`process.env.${STAMP}="${sdkVersion}"`);
    // One COMPUTED write: the env-config object's `set`, whose three instances
    // have no `.set(` caller in the bundle. Pinned as a count so a lift that
    // adds a second computed writer is read, not inherited.
    expect(sdkSource.match(/process\.env\[[^\]]+\]=(?!=)/g)?.length).toBe(1);
  });
});

describe('F1.512 — the SDK\'s own write does not drift the claude child', () => {
  it('turn 2 hashes like turn 1 after the real query() stamps a process that had no stamp (the packaged-app shape)', () => {
    delete process.env[STAMP];
    const turn1 = turnSignature();
    sdkQueryWritesAndStops();
    // The SDK did write it, enumerably, so the next turn head's spread carries it…
    expect(process.env[STAMP]).toBe(sdkVersion);
    expect(Object.keys(process.env)).toContain(STAMP);
    expect(buildClaudeSubprocessEnv()[STAMP]).toBe(sdkVersion);
    // …and the child is still reusable.
    expect(turnSignature()).toBe(turn1);
  });

  it('an INHERITED stamp the SDK overwrites (the rig\'s shape) does not drift it either', () => {
    delete process.env[STAMP];
    process.env[STAMP] = '0.0.0-inherited-f1512';
    const turn1 = turnSignature();
    sdkQueryWritesAndStops();
    expect(process.env[STAMP]).toBe(sdkVersion);
    expect(turnSignature()).toBe(turn1);
  });

  it('the names leave the HASH only — the child env still carries them', () => {
    delete process.env[STAMP];
    sdkQueryWritesAndStops();
    const env = buildClaudeSubprocessEnv();
    expect(env[STAMP]).toBe(sdkVersion);
    // Written at SDK module load (the static import above ran it), and a
    // Windows executable-search hardening the child must keep.
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });
});

describe('F1.512 — CONTROL: a real drift still respawns', () => {
  it('a changed proxy name moves the signature', () => {
    const env = buildClaudeSubprocessEnv();
    const base = liveSession.claudeLiveSessionSignature({ cwd: '/f1512/work', env } as never);
    const proxied = liveSession.claudeLiveSessionSignature({
      cwd: '/f1512/work',
      env: { ...env, HTTPS_PROXY: 'http://proxy.f1512.invalid:3128' },
    } as never);
    expect(proxied).not.toBe(base);
  });

  it('a changed value of an existing name moves it, and an absent env still hashes', () => {
    const a = liveSession.claudeLiveSessionSignature({ cwd: '/f1512/work', env: { NO_PROXY: 'a' } } as never);
    const b = liveSession.claudeLiveSessionSignature({ cwd: '/f1512/work', env: { NO_PROXY: 'b' } } as never);
    expect(a).not.toBe(b);
    const none = liveSession.claudeLiveSessionSignature({ cwd: '/f1512/work' } as never);
    expect(JSON.parse(none).env).toBeNull();
  });
});
