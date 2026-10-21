/**
 * P6.885 — the codex path runs the FULL Zod validators when the ground agrees,
 * and keeps the honest basic tier when it does not.
 *
 * The row's premise, measured: the shared validators resolve `CONFIG_FILE` from
 * their own module-level `CONFIG_DIR` (`NESSY_CONFIG_DIR` or `~/.nessy-agent`,
 * frozen at import), while every handler reads `ctx.configRoot` — the
 * `--config-root` argv. Codex cannot make those agree by itself:
 * `create_env_for_mcp_server` (`codex-rs/rmcp-client/src/utils.rs`,
 * `rust-v0.148.0`) builds a stdio MCP server's environment from an allowlist
 * (`DEFAULT_ENV_VARS` = HOME, LOGNAME, PATH, SHELL, USER,
 * `__CF_USER_TEXT_ENCODING`, LANG, LC_ALL, TERM, TMPDIR, TZ) plus the server's
 * own `env_vars` and literal `env` entries, and `NESSY_CONFIG_DIR` is in none of
 * them.
 *
 * So `createCodexValidators` compares the two grounds, and both arms are pinned
 * here — through the REAL process, because `index.ts` calls `main()` at module
 * scope and cannot be imported. Both arms plant the SAME typo in the SAME
 * shape, so what separates them is the ground and nothing else:
 *
 * - POSITIVE (grounds equal): `crossSessionInbound: 'hodl'` is REFUSED by name.
 *   The basic tier structurally cannot see it — the field is not required and
 *   its value is not a shape `validateJsonFileHasFields` inspects — so this
 *   assertion fails the day the gate stops opening.
 * - NEGATIVE (grounds differ): the same file passes, and the answer says which
 *   validation produced that pass (P6.879's lines). No validator reports on a
 *   file the caller did not ask about, which is the failure the gate exists to
 *   prevent.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STORAGE_LAYOUT_VERSION } from '@nessy-agent/shared/config/paths';

const SERVER = resolve(import.meta.dir, 'index.ts');

interface RpcResponse {
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
}

/**
 * Run one `config_validate` call against a real server process.
 *
 * `NESSY_CONFIG_DIR` is passed EXPLICITLY rather than inherited: it is the
 * variable that decides the shared validators' ground, so a test that let the
 * ambient value through would be measuring the rig instead of the gate.
 */
async function validateConfigTarget(
  configRoot: string,
  sharedConfigDir: string,
): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), 'p6885-ws-'));
  const child = spawn(
    process.execPath,
    [
      SERVER,
      '--session-id', 's1',
      '--workspace-root', ws,
      '--plans-folder', join(ws, 'plans'),
      '--config-root', configRoot,
      '--external-standalone-only',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NESSY_CONFIG_DIR: sharedConfigDir },
    },
  );

  const responses = new Map<number, RpcResponse>();
  // Drained and kept: an undrained stderr pipe can block a child, and when the
  // handshake does not answer this is the only thing that says why.
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RpcResponse;
        if (typeof msg.id === 'number') responses.set(msg.id, msg);
      } catch {
        /* non-JSON line */
      }
    }
  });

  // Wait for the server's OWN readiness line rather than a fixed sleep.
  // Measured 2026-09-08 at load 12.8: this child takes **70.7 s** to reach that
  // line — a cold, I/O-bound module graph, 1 % cpu, the shape AGENTS.md §Traps
  // describes. A fixed 300 ms handshake writes into a process that has not
  // built its dispatcher yet, and the run then looks like a hang with an empty
  // stderr, which is a defect-shaped reading of a slow machine.
  const ready = Date.now() + 240_000;
  while (Date.now() < ready && !stderr.includes('Session MCP Server started')) {
    await new Promise((r) => setTimeout(r, 250));
  }

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  })}\n`);
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'config_validate', arguments: { target: 'config' } },
  })}\n`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !responses.has(2)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  rmSync(ws, { recursive: true, force: true });

  const answer = responses.get(2)?.result?.content?.map((part) => part.text ?? '').join('\n');
  // The positive control on the harness itself: an empty answer would make every
  // `toContain` below vacuous, and a `not.toContain` PASS on nothing at all.
  expect(answer, `the server answered config_validate; stderr was: ${stderr}`).toBeTruthy();
  return answer ?? '';
}

/** A `config.json` the schema accepts except for one value it refuses. */
function plantConfig(dir: string): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    // Unknown-tolerant load path: this resolves to the default in silence, and
    // the full validator is the only reader that ever says so.
    crossSessionInbound: 'hodl',
  }), 'utf-8');
}

describe('codex config_validate runs the full validator when the ground agrees (P6.885)', () => {
  test('POSITIVE — same ground: the typo the basic tier cannot see is refused by name', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'p6885-same-'));
    plantConfig(configRoot);
    try {
      const answer = await validateConfigTarget(configRoot, configRoot);
      expect(answer).toContain('crossSessionInbound');
      // And it is the FULL tier's answer: P6.879's two lines belong to the other
      // branch, so their absence is what says which validator ran.
      expect(answer).not.toContain('basic validation');
      expect(answer).not.toContain('checked:');
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  }, 330_000);

  test('NEGATIVE — different ground: no validator reports on a file the caller did not name', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'p6885-asked-'));
    const sharedConfigDir = mkdtempSync(join(tmpdir(), 'p6885-shared-'));
    plantConfig(configRoot);
    plantConfig(sharedConfigDir);
    try {
      const answer = await validateConfigTarget(configRoot, sharedConfigDir);
      // The basic tier passes the same bytes the full one refuses — the whole
      // reason the gate must not open on a mismatched ground.
      expect(answer).toContain('basic validation');
      expect(answer).toContain('checked:');
      expect(answer).not.toContain('crossSessionInbound');
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
      rmSync(sharedConfigDir, { recursive: true, force: true });
    }
  }, 330_000);
});
