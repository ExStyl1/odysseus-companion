/**
 * F1.311 (origin WJ-ee verifier F1.236-c, 2026-09-23) — `getApiCredential`
 * must not write a stored credential into the debug log when it fails to parse
 * it as the multi-header JSON.
 *
 * For a source with `headerNames`, the stored value is tried as JSON first; a
 * plain key fails, and the catch logged `JSON parse failed: ${e}` — and bun's
 * `SyntaxError` message quotes the leading token of the input
 * (`JSON Parse error: Unexpected identifier "<key>"`), so every read of such a
 * source put the key in the log. The fix logged the error's NAME and a fixed
 * sentence only; UB3.1 (OSS #1067) moved the parsing itself into the shared
 * `parseStoredApiCredential` (`@nessy-agent/session-tools-core/api-auth`),
 * which never logs at all — the one debug line left names the credential's
 * SHAPE (`string` / `header map (N headers)` / `basic auth`), and this pin
 * holds against it: the shape line is the only stderr, and the key is in none
 * of it.
 *
 * WHY A CHILD — `utils/debug.ts` reads `NESSY_DEBUG` once at module load and has
 * no inverse (see `api-tools-debug-redaction.test.ts`), so the call runs in a
 * throwaway bun child started with `NESSY_DEBUG=1`, and the assertions read its
 * STDERR, the logger's own sink. The real `getApiCredential` runs; only the
 * vault read (`load`) is replaced on the instance, returning a key built from
 * random bytes.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../../testing/module-graph-budgets.ts';

const CREDENTIAL_MANAGER = resolve(import.meta.dir, '..', 'credential-manager.ts');

/** Alphanumeric and leading with a letter, so bun's parser reports it as an identifier. */
const STORED_KEY = `k${randomBytes(16).toString('hex')}`;

const CHILD_SOURCE = `
import { SourceCredentialManager } from ${JSON.stringify(CREDENTIAL_MANAGER)};

const manager = new SourceCredentialManager();
manager.load = async () => ({ value: ${JSON.stringify(STORED_KEY)} });
const source = {
  config: {
    id: 'f1311', slug: 'f1311-src', name: 'F1.311', type: 'api', enabled: true,
    api: { baseUrl: 'https://api.example.test/', authType: 'header', headerNames: ['X-Api-Key'] },
  },
  guide: null,
  folderPath: '/tmp/f1311/sources/f1311-src',
  workspaceRootPath: '/tmp/f1311',
  workspaceId: 'f1311-ws',
};
const credential = await manager.getApiCredential(source);
process.stdout.write('CREDENTIAL ' + JSON.stringify(credential) + '\\n');
`;

let dir = '';
let stdout = '';
let stderr = '';
let exitCode: number | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wjoo-f1311-'));
  const script = join(dir, 'child.ts');
  writeFileSync(script, CHILD_SOURCE);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  delete env.NESSY_CLI_JSON_ONLY;
  env.NESSY_DEBUG = '1';
  env.NESSY_CONFIG_DIR = join(dir, 'config');
  // cwd = the temp dir, so the repo root's bunfig preloads do not run in the child.
  const child = Bun.spawn([process.execPath, script], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  // UB12.31 — the child pays the `credential-manager.ts` graph: whole-file
  // totals of 30.87 s to 45.96 s on 2026-10-16/17 (scripts/module-graph-hook-costs.txt),
  // the largest 0.38 of the hand-written 120 000 this replaced. It is killed
  // 30 s inside the hook budget, so a hang fails here with its own stderr.
  let killed = false;
  const killer = setTimeout(() => { killed = true; child.kill(); }, MODULE_GRAPH_HOOK_BUDGET_MS - 30_000);
  [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  exitCode = await child.exited;
  clearTimeout(killer);
  if (killed) throw new Error(`child killed at its ${MODULE_GRAPH_HOOK_BUDGET_MS - 30_000} ms deadline:\n${stderr.slice(-4000)}`);
}, MODULE_GRAPH_HOOK_BUDGET_MS);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('F1.311 — a failed multi-header parse logs no credential', () => {
  // UB3.1 (OSS #1067) adapted the pin: parsing moved to the shared
  // `parseStoredApiCredential`, which is silent — the only debug line
  // getApiCredential writes is the credential's SHAPE, never its value. The
  // shape line is still the instrument marker that the real code path ran.
  test('instrument: the real getApiCredential ran with debug on and fell through to the raw value', () => {
    expect(exitCode).toBe(0);
    expect(stderr).toContain('getApiCredential for f1311-src: string');
    expect(stdout).toContain(`CREDENTIAL ${JSON.stringify(STORED_KEY)}`);
  });

  test('the only debug line is the shape, and the stored key is not in the log', () => {
    expect(stderr).toContain('[SourceCredentialManager] getApiCredential for f1311-src');
    expect(stderr).not.toContain(STORED_KEY);
    expect(stderr).not.toContain(STORED_KEY.slice(0, 12));
  });
});
