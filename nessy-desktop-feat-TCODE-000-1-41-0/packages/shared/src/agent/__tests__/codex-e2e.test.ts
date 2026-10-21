/**
 * Phase 3 Task 3.7 — end-to-end: a factory-resolved `codex-runtime` backend
 * runs a real turn through the bundled app-server + the Phase 2 adapter against
 * the LIVE Nestor gateway (JWT read-only from ~/.nessy/dp_auth_creds.json).
 *
 * Gated on NESSY_CODEX_E2E=1 (spawns a real subprocess + hits the network), so
 * the default `bun test` run skips it. Run manually:
 *
 *   NESSY_CODEX_E2E=1 NESSY_FEATURE_CODEX_RUNTIME=1 \
 *     bun test packages/shared/src/agent/__tests__/codex-e2e.test.ts
 */
import { test, expect, describe } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@nessy-agent/core/types';
import { createBackend } from '../backend/factory.ts';
import { codexDriver } from '../backend/internal/drivers/codex.ts';
import { resolveBackendRuntimePaths } from '../backend/internal/runtime-resolver.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { ResolvedBackendConfig } from '../backend/internal/driver-types.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

describe.if(process.env.NESSY_CODEX_E2E === '1')('codex-runtime e2e (live)', () => {
  test('factory-resolved CodexAgent runs a real turn + clean teardown', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codex-e2e-ws-'));
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    writeFileSync(join(workspace, 'hello.txt'), 'hi\n');
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'add', '-A'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: workspace });

    const config: ResolvedBackendConfig = createMockBackendConfig({
      provider: 'codex-runtime',
      providerType: 'codex-runtime',
      authType: 'api_key_with_endpoint',
      model: MODEL,
      isHeadless: true,
      session: { id: 'e2e-session', workingDirectory: workspace } as never,
    });
    // Populate config.runtime the way the connection-resolution path does.
    const hostRuntime = { appRootPath: REPO_ROOT, isPackaged: false };
    config.runtime = codexDriver.buildRuntime({
      context: { connection: null, provider: 'codex-runtime', resolvedModel: MODEL, capabilities: { needsHttpPoolServer: false } },
      coreConfig: config,
      hostRuntime,
      resolvedPaths: resolveBackendRuntimePaths(hostRuntime),
    });
    expect(config.runtime.paths?.codexBinary).toBeTruthy();

    const agent = createBackend(config); // proves createBackend routes codex-runtime → CodexAgent
    expect(agent.constructor.name).toBe('CodexAgent');
    agent.onDebug = (m) => console.log(`[codex-debug] ${m}`);
    // Exercise the real approval bridge (not headless auto-approve): any approval
    // request routes onPermissionRequest → respondToPermission(allow).
    let approvals = 0;
    agent.onPermissionRequest = (req) => {
      approvals += 1;
      console.log(`[e2e] approval request: ${req.toolName} ${req.command ?? ''}`);
      agent.respondToPermission(req.requestId, true);
    };
    await agent.postInit();

    const events: AgentEvent[] = [];
    for await (const e of agent.chat('List the files in this directory.')) {
      events.push(e);
      console.log(`[e2e] AgentEvent ${JSON.stringify(e).slice(0, 200)}`);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('complete');
    const hadText = types.includes('text_delta') || types.includes('text_complete');
    const hadTool = types.includes('tool_start');
    expect(hadText || hadTool).toBe(true);
    if (!hadTool) {
      console.warn('[e2e] model answered without a shell tool call this run (non-deterministic).');
    }
    // If codex requested approval, the bridge handled it and the turn still completed.
    console.log(`[e2e] approval requests handled via bridge: ${approvals}`);

    agent.destroy();
    await new Promise((r) => setTimeout(r, 500));
    // No lingering app-server child.
    let lingering = '';
    try {
      lingering = execFileSync('pgrep', ['-f', 'codex-app-server'], { encoding: 'utf8' }).trim();
    } catch {
      lingering = '';
    }
    expect(lingering).toBe('');
    rmSync(workspace, { recursive: true, force: true });
  }, 120_000);
});
