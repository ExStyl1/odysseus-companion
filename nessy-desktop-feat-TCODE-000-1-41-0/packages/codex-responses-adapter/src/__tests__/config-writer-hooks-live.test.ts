/**
 * P6.14 / P2.414 — the `[hooks]` claims, driven against the binary we SHIP.
 *
 * ## Why this file exists beside `config-writer-hooks.test.ts`
 *
 * That sibling settles SHAPE — which keys this writer emits, under which
 * header, and what it refuses. It cannot settle "the binary accepts this", and
 * that half matters more than usual here: codex fails a config OPEN and
 * WHOLE-FILE, so one unknown key costs `[permissions]`, the execpolicy pointer
 * and every deny floor at once. Until now the accepting half lived only as a
 * DATED PROSE READING in `buildCodexHooksToml`'s docblock — taken 2026-08-29
 * against `rust-v0.148.0`, a binary this repo no longer ships. A dated reading
 * decays silently across a lift; a boot does not.
 *
 * So this file is the same three arms, executable. It re-drives itself on every
 * codex lift instead of being re-typed, which is the whole point: the 2026-09-11
 * lift to `rust-v0.150.1` moved the `mcp_tool` handler kind from "refused" to
 * "run" one docblock away from here, and nothing failed when it did.
 *
 * ## What was measured, 2026-09-11, on the shipped `codex-app-server 0.150.1`
 *
 * Every 2026-08-29 claim SURVIVED the two-tag lift, unchanged. Two things the
 * older reading did not record and this suite now pins:
 *
 *  - `currentHash` is published with a literal `sha256:` PREFIX
 *    (`sha256:2f64925f…`), and `trusted_hash` must carry it verbatim — a state
 *    entry written with the bare hex would name nothing;
 *  - the whole-file fail-open is legible through `hooks/list` ITSELF, not only
 *    through `configWarning`: the malformed arm returns `hooks: []` with an
 *    `errors` entry carrying `<config path>:<line>:<col>`. That is what makes
 *    the two-pass trust protocol safe — the second pass can SEE that the file
 *    failed to parse instead of writing state for a table nobody loaded.
 *
 * ## The rig
 *
 * The shipped `codex-app-server` for this host, a `CODEX_HOME` the REAL
 * `buildCodexConfigToml` writes, `initialize` then `hooks/list`. **No network
 * and no credential**: no turn is started, so the adapter port in the config is
 * never dialled. Skips where the binary is absent — it is a build-time download
 * and gitignored, so CI's Linux container has none; the armed-check below makes
 * that skip deliberate rather than invisible, in the idiom
 * `sandbox-enforcement.test.ts` established.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexConfigToml,
  mintHostAuthoredCodexHooks,
  type CodexHostAuthoredHooksPlan,
} from '../config-writer.ts';
import { AppServer } from './app-server-rig.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);

/**
 * Per-test budget. Spawning a ~185 MB binary and waiting out `initialize`
 * dominates (~6 s observed, `user 0.04 sys 0.03` — it is process start and I/O,
 * not compute); the assertions are milliseconds. Generous because this branch
 * runs several lanes at once and timing is part of no claim here.
 */
const BUDGET_MS = 180_000;

/** Unique per RUN, so two concurrent `bun test` processes cannot share a home. */
const ROOT = HAVE_BIN ? mkdtempSync(join(tmpdir(), 'nessy-codex-hooks-live-')) : '';
const WS = join(ROOT, 'ws');

afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

/** A port that is never dialled: no turn is started in this file. */
const UNDIALLED_ADAPTER_PORT = 1;

/**
 * The three entries the 2026-08-29 reading used, rebuilt through the real mint.
 *
 * The second command carries an embedded quote AND a backslash on purpose —
 * `tomlString` escaping them wrongly is the failure this arm is shaped to catch,
 * and a round trip through the binary is the only thing that can see it.
 */
function hooksPlan(state?: Record<string, string>): CodexHostAuthoredHooksPlan {
  return mintHostAuthoredCodexHooks(
    { origin: 'codexHooksLiveRig', revocation: { kind: 'next-runtime-build' } },
    {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ command: 'printf %s "hi"', timeoutSec: 12, async: true, statusMessage: 'nessy pre-tool' }],
      }],
      PostToolUse: [{
        matcher: 'mcp__session__Monitor',
        hooks: [{ command: 'printf %s "a\\"b\\\\c"', timeoutSec: 3, async: false, statusMessage: 'nessy post' }],
      }],
      SessionStart: [{ hooks: [{ command: '/usr/bin/true', timeoutSec: 5 }] }],
      ...(state ? { state } : {}),
    },
  );
}

interface HookMetadata {
  key: string;
  eventName: string;
  handlerType: string;
  command?: string;
  async?: boolean;
  matcher: string | null;
  timeoutSec: number;
  statusMessage: string | null;
  source: string;
  enabled: boolean;
  currentHash: string;
  trustStatus: string;
}

interface HooksListEntry {
  cwd: string;
  hooks: HookMetadata[];
  warnings: string[];
  errors: { path: string; message: string }[];
}

interface BootResult {
  home: string;
  entry: HooksListEntry;
  /** Every notification method, in order — `configWarning` is the one that matters. */
  methods: string[];
  configWarnings: { summary?: string; details?: string }[];
}

/** One boot of the shipped binary on a home this writer built, then `hooks/list`. */
async function boot(
  name: string,
  opts: { state?: Record<string, string>; corrupt?: boolean; reuseHome?: boolean } = {},
): Promise<BootResult> {
  const home = join(ROOT, name);
  if (!opts.reuseHome) rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(WS, { recursive: true });
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    adapterPort: UNDIALLED_ADAPTER_PORT,
    mode: 'default',
    sandboxGloballyEnabled: false,
    hooks: hooksPlan(opts.state),
  }));
  if (opts.corrupt) appendFileSync(join(home, 'config.toml'), '\nthis is not = = valid toml [[[\n');

  const child = spawn(BIN, [], {
    cwd: WS,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const server = new AppServer(child);
  let listed: { data?: HooksListEntry[] };
  try {
    await server.request('initialize', {
      clientInfo: { name: 'nessy-codex-hooks-live', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.notify('initialized');
    // `configWarning` is emitted around initialize; give it room to arrive
    // before the list, so the two readings describe the same moment.
    await new Promise(r => setTimeout(r, 1_500));
    listed = await server.request('hooks/list', { cwds: [WS] }) as { data?: HooksListEntry[] };
  } finally {
    server.kill();
  }
  const entry = listed.data?.[0];
  if (!entry) throw new Error(`hooks/list returned no entry: ${JSON.stringify(listed)}`);
  return {
    home,
    entry,
    methods: server.notifications.map(n => n.method),
    configWarnings: server.notifications
      .filter(n => n.method === 'configWarning')
      .map(n => (n.params ?? {}) as { summary?: string; details?: string }),
  };
}

describe('codex [hooks] live — the detector is armed', () => {
  test('the bundled codex binary is present, or the skip is deliberate', () => {
    if (HAVE_BIN) {
      expect(HAVE_BIN).toBe(true);
      return;
    }
    console.warn(
      `[codex-hooks-live] SKIPPED: no codex binary at ${BIN}. The claims in buildCodexHooksToml's`
      + ' §"Proven against the bundled binary" were NOT re-driven in this run; they remain a dated reading.',
    );
    expect(HAVE_BIN).toBe(false);
  });
});

describe.if(HAVE_BIN)('codex [hooks] live — what the shipped binary does with the table we project', () => {
  test('the projected table boots with NO configWarning and round-trips through hooks/list', async () => {
    const result = await boot('accepted');

    // (1) The table is accepted whole. The control below is what makes this mean something.
    expect(result.methods).not.toContain('configWarning');
    expect(result.entry.warnings).toEqual([]);
    expect(result.entry.errors).toEqual([]);
    expect(result.entry.hooks).toHaveLength(3);

    // (2) Every field round-trips, including the two whose TOML spelling differs
    // from the wire spelling (`timeout` -> `timeoutSec`) and the group-level
    // `matcher`, which must sit between the group header and the first handler.
    const pre = result.entry.hooks[0]!;
    expect(pre.eventName).toBe('preToolUse');
    expect(pre.handlerType).toBe('command');
    expect(pre.matcher).toBe('Bash');
    expect(pre.timeoutSec).toBe(12);
    expect(pre.async).toBe(true);
    expect(pre.statusMessage).toBe('nessy pre-tool');
    expect(pre.source).toBe('user');
    expect(pre.enabled).toBe(true);

    // (3) The escaping arm: a command carrying a quote AND a backslash comes
    // back BYTE-EXACT. `tomlString` getting this wrong is invisible to a string
    // assertion, because the assertion would compare against the same mistake.
    const post = result.entry.hooks[1]!;
    expect(post.eventName).toBe('postToolUse');
    expect(post.matcher).toBe('mcp__session__Monitor');
    expect(post.command).toBe('printf %s "a\\"b\\\\c"');

    // (4) A group with no matcher is a matcher-LESS group, not one carrying an
    // unknown `matcher` key — the failure the emitter's line ordering avoids.
    const start = result.entry.hooks[2]!;
    expect(start.eventName).toBe('sessionStart');
    expect(start.matcher).toBeNull();

    // (5) Without `[hooks.state]` every entry is UNTRUSTED, and the hash the
    // second pass needs is published with its `sha256:` prefix.
    for (const hook of result.entry.hooks) {
      expect(hook.trustStatus).toBe('untrusted');
      expect(hook.currentHash.startsWith('sha256:')).toBe(true);
    }
    // The key format the two-pass protocol reads back, not one we re-derive.
    // Asserted by SHAPE rather than by the whole path: macOS reports this home
    // through `/private/var/...` while `tmpdir()` hands out `/var/...`, and the
    // path half of the key is the binary's to canonicalise, not ours to predict.
    expect(pre.key.endsWith('config.toml:pre_tool_use:0:0')).toBe(true);
  }, BUDGET_MS);

  test('POSITIVE CONTROL: one malformed line fails the WHOLE file open, and hooks/list says so', async () => {
    const result = await boot('malformed', { corrupt: true });

    // This is why the green above is evidence and not a tautology: the same rig,
    // one bad line, and the binary discards the entire config.
    expect(result.methods).toContain('configWarning');
    expect(result.configWarnings[0]?.summary).toBe('Invalid configuration; using defaults.');

    // Recorded 2026-09-11 and NOT in the 2026-08-29 reading: the fail-open is
    // legible through the list itself. The two-pass trust protocol depends on
    // this — the read-back pass can tell "no hooks" from "the file did not load".
    expect(result.entry.hooks).toEqual([]);
    expect(result.entry.errors).toHaveLength(1);
    expect(result.entry.errors[0]?.message).toContain('config.toml:');
  }, BUDGET_MS);

  test('the [hooks.state] half flips untrusted -> trusted, and a key naming no hook is inert', async () => {
    // Pass one: the same home, read the keys and hashes the BINARY assigned.
    const first = await boot('trust');
    const state: Record<string, string> = {};
    for (const hook of first.entry.hooks) state[hook.key] = hook.currentHash;
    expect(Object.keys(state)).toHaveLength(3);

    // Pass two: the same home and the same table, plus that state and one key
    // that names no hook at all.
    // Derived from a REAL key so only the group/handler indices are bogus —
    // inventing the path half would test our spelling of it, not the binary's.
    const bogusKey = first.entry.hooks[0]!.key.replace(/:\d+:\d+$/, ':9:9');
    const second = await boot('trust', {
      reuseHome: true,
      state: { ...state, [bogusKey]: `sha256:${'de'.repeat(32)}` },
    });

    expect(second.methods).not.toContain('configWarning');
    expect(second.entry.warnings).toEqual([]);
    expect(second.entry.errors).toEqual([]);
    // The bogus entry adds no hook and removes none: it is inert, not rejected.
    expect(second.entry.hooks).toHaveLength(3);
    for (const hook of second.entry.hooks) {
      expect(hook.trustStatus).toBe('trusted');
      expect(hook.enabled).toBe(true);
    }
  }, BUDGET_MS);
});
