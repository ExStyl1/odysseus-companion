/**
 * F1.196 (origin WJ-l P-WJ-l-1) + F1.191's codex half — the HOST writes
 * `script_sandbox`'s read policy onto the session-MCP argv, because the child
 * cannot resolve it (`CodexSandboxReadArgs` in `session-mcp-server/src/index.ts`
 * carries the codex-rs reading: `HOME` reaches the child as the host's LIVE
 * value, `NESSY_CONFIG_DIR` not at all).
 *
 * The child half — that the flags reach a real sandbox profile — is
 * `session-mcp-server/src/script-sandbox-read-policy.test.ts`. This file pins the
 * emitter: the latched home (moved through the latch's own test seam, since
 * under `bun test` writing `HOME` moves nothing, P3.169), the fence flag written
 * every time, and the roots being the SAME resolution claude and Pi read.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAgent } from '../codex-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { relatchHomeDirForTests } from '../../config/home-latch.ts';
import { resolveSessionToolSandboxReadFloor } from '../pi-harness/session-tool-sandbox-read-floor.ts';

const WORKSPACE_ROOT = '/tmp/ws-sandbox-argv-root';
const LAUNCH_HOME = join(tmpdir(), 'wjl-f1196-launch-home');

afterEach(() => {
  relatchHomeDirForTests();
});

function createAgent(): any {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-sandbox-argv',
      name: 'Sandbox Argv Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-sandbox-argv',
    } as any,
    session: {
      id: 'session-sandbox-argv',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;
  return new CodexAgent(config);
}

function valuesAfter(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && index + 1 < args.length ? [args[index + 1]!] : []));
}

describe('F1.196 · the codex session-MCP argv carries the host read policy and the latched home', () => {
  it('names the LATCHED home, not the live one', () => {
    relatchHomeDirForTests(LAUNCH_HOME);
    // Rig control: the two resolvers really disagree, or the arm is vacuous.
    expect(homedir()).not.toBe(LAUNCH_HOME);
    const args: string[] = createAgent().buildSessionMcpSpec(undefined)?.args ?? [];
    expect(args).toContain('--config-root');
    expect(valuesAfter(args, '--credential-home')).toEqual([LAUNCH_HOME]);
  });

  it('writes the fence flag every time, carrying its value, so the child can tell empty from undeclared', () => {
    const args: string[] = createAgent().buildSessionMcpSpec(undefined)?.args ?? [];
    const fence = valuesAfter(args, '--sandbox-reads-fenced');
    expect(fence).toHaveLength(1);
    expect(['true', 'false']).toContain(fence.join(''));
  });

  it('carries exactly the roots claude and Pi resolve, in order, anchored on the latch', () => {
    relatchHomeDirForTests(LAUNCH_HOME);
    const args: string[] = createAgent().buildSessionMcpSpec(undefined)?.args ?? [];
    const expected = resolveSessionToolSandboxReadFloor(WORKSPACE_ROOT).deniedReadRoots;
    // Positive control on the same instrument: the shipped floor's home-anchored
    // entries convert, so the list is not vacuously empty — and they convert
    // under the LATCHED home, which is the property F1.191 is about.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.some((root) => root.startsWith(LAUNCH_HOME))).toBe(true);
    expect(valuesAfter(args, '--sandbox-denied-read-root')).toEqual([...expected]);
  });
});
