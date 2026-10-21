/**
 * P6.72, claude arm — does a managed MCP denial actually stop the SPAWN?
 *
 * ## Why this is a question the host gate cannot answer
 *
 * Our own gate (`mcp/runtime-pool-servers.ts:applyManagedMcpPolicy`) decides
 * which servers we HAND the runtime. It says nothing about what the vendored
 * child does with a server it has already been handed — and the claude child has
 * three MCP entry points of its own: the programmatic `mcpServers` option, its
 * settings cascade, and a project `.mcp.json`. F69.1 of the claude sweep triage
 * is exactly that gap: *does `allowManagedMcpServersOnly` govern a
 * programmatically-supplied server?*
 *
 * ## The delivery channel, and why it is NOT the env var
 *
 * P6.73 measured `CLAUDE_CODE_MANAGED_SETTINGS_PATH` DEAD on an SDK-spawned
 * child: with a managed `env` block as the only source of `ANTHROPIC_BASE_URL`
 * the child reached no stub at all, under both the directory and the file
 * spelling, and an unparseable managed document drew no diagnostic. So a rig
 * that delivered the policy that way would measure the channel, not the gate.
 *
 * This probe uses the channel THIS PRODUCT actually uses:
 * `Options.managedSettings`, the SDK's own parent policy tier
 * (`sdk.d.ts:1978`), which `buildClaudeManagedSettingsOptions` fills from our
 * managed floor. `deniedMcpServers` passes through it byte-identically
 * (`claude-managed-settings.ts` copies the entry shape rather than translating
 * it), so what is measured here is what an administrator's `managed-policy.json`
 * would produce.
 *
 * ## The observable is the SPAWN, never the map
 *
 * The MCP server is a fixture executable that writes a marker file the instant
 * it starts and then speaks just enough MCP to complete a handshake. A marker is
 * host-side execution: it cannot be faked by a server list, and it is unaffected
 * by whether the child later reports the server as connected or failed. Every
 * absence arm is paired with a positive control on the same rig — "no marker" is
 * otherwise indistinguishable from a rig that materialized nothing.
 *
 * Every side effect is behind `import.meta.main`: a fixture whose module body
 * exits kills the runner at import time and reports exit 0 with ZERO tests
 * executed (AGENTS.md, measured 2026-09-01).
 *
 * Provenance is asserted rather than assumed — the child's own `user-agent`,
 * checked against the vendored `package.json`, because a sibling rig in this
 * tree once measured a runtime this repo does not ship.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startStub, vendoredClaudeBinary, vendoredVersions } from './claude-policy-helper-probe.ts';

export { vendoredClaudeBinary, vendoredVersions };

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** The wire name the policy arms aim at. */
export const SERVER_NAME = 'corpmcp';

export type ManagedMcpArm =
  /** POSITIVE CONTROL: programmatic server, no policy tier at all. */
  | 'programmatic-no-policy'
  /** The subject, denied by NAME through `Options.managedSettings`. */
  | 'programmatic-denied-by-name'
  /** The subject, denied by the exact spawn ARGV. */
  | 'programmatic-denied-by-command'
  /** NEGATIVE CONTROL: a denial aimed at a different server must not touch it. */
  | 'programmatic-denied-elsewhere'
  /** F69.1: an admin allowlist that does not name it, with allow-managed-only on. */
  | 'programmatic-allow-managed-only'
  /** CONTROL for the discovery channel: a project `.mcp.json`, no policy. */
  | 'discovered-no-policy'
  /** done_means control (b): the same server, discovered, under the same denial. */
  | 'discovered-denied-by-name';

export interface ManagedMcpOutcome {
  arm: ManagedMcpArm;
  /** Did the MCP server RUN? The marker file is the only thing that can say so. */
  markerWritten: boolean;
  /** Its own record of the argv it was spawned with, when it ran. */
  markerArgv: string[] | null;
  /** Requests that reached the stub upstream — proves the turn actually ran. */
  requests: number;
  ended: 'result' | 'throw';
  detail: string;
  userAgent: string | null;
}

const DISCOVERED = new Set<ManagedMcpArm>(['discovered-no-policy', 'discovered-denied-by-name']);

type DenyEntry = { serverName?: string; serverCommand?: [string, ...string[]]; serverUrl?: string };

function managedSettingsFor(arm: ManagedMcpArm, command: string): Record<string, unknown> | undefined {
  const deny = (entries: DenyEntry[]) => ({ deniedMcpServers: entries });
  switch (arm) {
    case 'programmatic-no-policy':
    case 'discovered-no-policy':
      return undefined;
    case 'programmatic-denied-by-name':
    case 'discovered-denied-by-name':
      return deny([{ serverName: SERVER_NAME }]);
    case 'programmatic-denied-by-command':
      return deny([{ serverCommand: [command] }]);
    case 'programmatic-denied-elsewhere':
      // Same SHAPE, different subject, on the same instrument: a rig that
      // withholds here is withholding for some reason other than the policy.
      return deny([{ serverName: 'someothermcp' }, { serverCommand: ['/nowhere/nothing'] }]);
    case 'programmatic-allow-managed-only':
      return {
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverName: 'someothermcp' }],
      };
  }
}

/**
 * A stdio MCP server that records its own execution and then completes a
 * handshake, so a connect neither hangs nor pays a deadline.
 *
 * It answers `initialize` and `tools/list` and ignores everything else, which is
 * the whole of what a child needs to consider it connected.
 */
function writeMcpFixture(path: string, markerPath: string): void {
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('node:fs')",
    // Written FIRST: the marker is about the spawn, not about the handshake.
    `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ argv: process.argv.slice(1), pid: process.pid }))`,
    "let buffer = ''",
    "process.stdin.on('data', chunk => {",
    '  buffer += chunk',
    "  let index = buffer.indexOf('\\n')",
    '  while (index >= 0) {',
    '    const line = buffer.slice(0, index).trim()',
    '    buffer = buffer.slice(index + 1)',
    "    index = buffer.indexOf('\\n')",
    '    if (!line) continue',
    '    let message',
    '    try { message = JSON.parse(line) } catch { continue }',
    '    if (message.id === undefined) continue',
    '    const result = message.method === \'initialize\'',
    "      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'p6072-fixture', version: '0.0.1' } }",
    "      : message.method === 'tools/list' ? { tools: [] } : {}",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
    '  }',
    '})',
    '// Self-terminate so a refused or timed-out connect cannot leak a process.',
    'setTimeout(() => process.exit(0), 20000)',
  ].join('\n'));
  chmodSync(path, 0o755);
}

export async function runManagedMcpArm(arm: ManagedMcpArm): Promise<ManagedMcpOutcome> {
  const stub = await startStub();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p6072-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'p6072-cwd-')));
  const configDir = mkdtempSync(join(tmpdir(), 'p6072-cfg-'));
  const marker = join(root, 'MCP_SPAWNED.json');
  const command = join(root, 'corp-mcp-server');
  writeMcpFixture(command, marker);

  const serverConfig = { type: 'stdio' as const, command, args: [] as string[] };
  const discovered = DISCOVERED.has(arm);
  if (discovered) {
    // The SDK's own discovery channel: a project-scoped `.mcp.json` in the cwd,
    // which only exists for the child when `settingSources` names `project`.
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args: [] } } }),
    );
  }

  const managedSettings = managedSettingsFor(arm, command);
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|API_)/i.test(key)),
  ) as Record<string, string>;

  let ended: ManagedMcpOutcome['ended'] = 'result';
  let detail = '';
  const query = sdk.query({
    prompt: 'say hello',
    options: {
      cwd,
      model: MODEL,
      // `project` only for the discovery arms: everywhere else the programmatic
      // option must be the ONLY way this server can reach the child, or the arm
      // cannot say which entry point the policy governed.
      settingSources: discovered ? ['project'] : [],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: vendoredClaudeBinary() ?? undefined,
      ...(discovered ? {} : { mcpServers: { [SERVER_NAME]: serverConfig } }),
      ...(managedSettings ? { managedSettings } : {}),
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    } as never,
  });

  try {
    for await (const message of query) {
      const typed = message as { type: string; subtype?: string; result?: unknown; is_error?: boolean };
      if (typed.type === 'result') {
        detail = JSON.stringify({
          subtype: typed.subtype,
          is_error: typed.is_error,
          result: String(typed.result ?? '').slice(0, 200),
        });
        break;
      }
    }
  } catch (error) {
    ended = 'throw';
    detail = String(error).slice(0, 400);
  }

  // A spawn the child started but had not finished writing is a race, not an
  // absence: give the marker the same short grace the sibling pool rig gives it.
  const deadline = Date.now() + 3_000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const outcome: ManagedMcpOutcome = {
    arm,
    markerWritten: existsSync(marker),
    markerArgv: existsSync(marker)
      ? (JSON.parse(readFileSync(marker, 'utf8')) as { argv: string[] }).argv
      : null,
    requests: stub.requests,
    ended,
    detail,
    userAgent: stub.userAgent,
  };
  try {
    await (query as unknown as { interrupt?: () => Promise<void> }).interrupt?.();
  } catch { /* the verdict is already taken */ }
  await stub.close();
  return outcome;
}

if (import.meta.main) {
  const arm = (process.argv[2] ?? 'programmatic-no-policy') as ManagedMcpArm;
  console.log(JSON.stringify(await runManagedMcpArm(arm)));
  process.exit(0);
}
