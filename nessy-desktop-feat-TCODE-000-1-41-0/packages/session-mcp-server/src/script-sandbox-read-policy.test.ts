/**
 * F1.196 (origin WJ-l P-WJ-l-1) + F1.191's codex half — codex's
 * `script_sandbox` honours the host's read policy and anchors its credential
 * floor on the host's LATCHED home, driven through the REAL session-MCP
 * subprocess a codex session spawns.
 *
 * Before these rows `createCodexContext` bound neither `sandboxReadFloor` nor
 * `credentialHomeDir`, so on codex the sandbox profile carried the credential
 * floor alone, anchored on the child's own `HOME` — which codex hands the child
 * from its own environment (`create_env_for_mcp_server`, `DEFAULT_ENV_VARS`), so
 * after a confirmed managed `HOME` it is the administrator's home, not the one
 * the credential store is latched to. The why, and the flags, are
 * `CodexSandboxReadArgs`'s docblock in `index.ts`.
 *
 * ## Two children, one exchange each
 *
 * The FLAGGED child is the argv the host now writes; the BARE child is the argv
 * it wrote before, and it is the CONTROL: the same reads come back there, which
 * is what makes the flagged arm able to fail, and the credential floor is
 * refused on BOTH (the row's own control). Each child answers every request in
 * one exchange (the boot is a cold module graph, 28–70 s measured by P6.901).
 *
 * ## The rig gate, as a derived verdict
 *
 * On a host with no usable isolation backend the handler fails closed and EVERY
 * read is refused, which reads exactly like a floor that binds. So each exchange
 * carries the F1.107 pair — a credential-floor read (`<configRoot>/credentials.enc`,
 * this test's own temp file) that must be refused and an undenied read that must
 * succeed — and the policy arms are asserted only on a rig where both hold.
 *
 * SAFETY: every file read here is one this test created under its own temp dir.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPool, type PooledRpcResponse } from './__tests__/child-pool.ts';

interface ToolReply {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
type RpcResponse = PooledRpcResponse<ToolReply | undefined>;

const pool = createChildPool<ToolReply | undefined>();

const VAULT_SECRET = 'WJ-L-F1-196-VAULT';
const CREDS_SECRET = 'WJ-L-F1-196-LATCHED-CREDS';
const OPEN_MARKER = 'WJ-L-F1-196-OPEN';

let root: string;
let workspace: string;
let configRoot: string;
let vaultDir: string;
let launchHome: string;

beforeAll(() => {
  // Canonical, for F1.107's measured reason: the darwin profile renders deny
  // roots lexically, and `$TMPDIR` is a symlink on macOS.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'smcp-f1196-')));
  workspace = join(root, 'ws');
  configRoot = join(root, 'cfg');
  vaultDir = join(root, 'vault');
  launchHome = join(root, 'launch-home');
  for (const dir of [workspace, configRoot, vaultDir, join(launchHome, '.nessy')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(configRoot, 'credentials.enc'), 'control-credential');
  writeFileSync(join(vaultDir, 'secret.txt'), VAULT_SECRET);
  writeFileSync(join(launchHome, '.nessy', 'dp_auth_creds.json'), CREDS_SECRET);
  writeFileSync(join(root, 'open.txt'), OPEN_MARKER);
});

afterAll(async () => {
  await pool.killAll();
  rmSync(root, { recursive: true, force: true });
});

function codexArgs(sessionId: string, extra: string[] = []): string[] {
  return [
    '--session-id', sessionId,
    '--workspace-root', workspace,
    '--plans-folder', join(workspace, 'plans'),
    '--config-root', configRoot,
    '--external-standalone-only',
    ...extra,
  ];
}

function readCall(id: number, path: string): object {
  const script = `try { process.stdout.write('READ:' + require('node:fs').readFileSync(${JSON.stringify(path)}, 'utf8')) }`
    + ` catch (e) { process.stdout.write('DENIED:' + String(e && e.code)) }`;
  return {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'script_sandbox', arguments: { language: 'node', script, timeoutMs: 15_000 } },
  };
}

function textOf(response: RpcResponse | undefined): string {
  return (response?.result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

async function exchange(args: string[]): Promise<Map<number, RpcResponse>> {
  return pool.runMcpSession(args, [
    readCall(2, join(configRoot, 'credentials.enc')),
    readCall(3, join(root, 'open.txt')),
    readCall(4, join(vaultDir, 'secret.txt')),
    readCall(5, join(launchHome, '.nessy', 'dp_auth_creds.json')),
  ]);
}

/** `enforced`, `no-backend`, or a sentence naming what is wrong with the rig. */
function rigVerdict(responses: Map<number, RpcResponse>): string {
  const floor = textOf(responses.get(2));
  const open = textOf(responses.get(3));
  if (!floor.includes('filesystemIsolation: enforced')) return 'no-backend';
  if (!floor.includes('DENIED:')) return `the credential floor did not bind: ${floor}`;
  if (!open.includes(`READ:${OPEN_MARKER}`)) return `an undenied read was refused: ${open}`;
  return 'enforced';
}

describe('F1.196 + F1.191 · codex script_sandbox carries the host read policy and the latched home', () => {
  test('the flagged child denies the host roots and the latched-home creds; the bare child is the control', async () => {
    const flagged = await exchange(codexArgs('f1196-flagged', [
      '--credential-home', launchHome,
      '--sandbox-reads-fenced', 'false',
      '--sandbox-denied-read-root', vaultDir,
    ]));
    const bare = await exchange(codexArgs('f1196-bare'));

    const verdict = rigVerdict(flagged);
    // Both rigs must agree, and each must be usable or honestly backend-less.
    expect(rigVerdict(bare)).toBe(verdict);
    expect(['enforced', 'no-backend']).toContain(verdict);
    if (verdict === 'no-backend') return;

    // THE ARM — before F1.196 the child ignored both flags and read both back.
    expect(textOf(flagged.get(4))).not.toContain(VAULT_SECRET);
    expect(textOf(flagged.get(4))).toContain('DENIED:');
    expect(textOf(flagged.get(5))).not.toContain(CREDS_SECRET);
    expect(textOf(flagged.get(5))).toContain('DENIED:');
    expect(textOf(flagged.get(3))).toMatch(/readFloor: \d+ denied roots \(\d+ credential floor, 1 host read policy\)/);

    // CONTROL — the pre-F1.196 argv: the same two files read back, and the
    // receipt still says the runtime declared nothing.
    expect(textOf(bare.get(4))).toContain(`READ:${VAULT_SECRET}`);
    expect(textOf(bare.get(5))).toContain(`READ:${CREDS_SECRET}`);
    expect(textOf(bare.get(3))).toContain('this runtime declares no read policy');
  }, 400_000);

  test('the fence flag reaches the child: the tool refuses by naming the setting', async () => {
    const responses = await pool.runMcpSession(
      codexArgs('f1196-fenced', ['--sandbox-reads-fenced', 'true']),
      [readCall(2, join(root, 'open.txt'))],
    );
    const text = textOf(responses.get(2));
    expect(responses.get(2)?.result?.isError).toBe(true);
    expect(text).toContain('permissions.blockReadsOutsideWorkingDirectories');
    expect(text).not.toContain(OPEN_MARKER);
  }, 400_000);
});
