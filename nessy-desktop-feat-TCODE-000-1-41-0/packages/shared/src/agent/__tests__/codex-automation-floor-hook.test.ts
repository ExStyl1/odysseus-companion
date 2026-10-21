/**
 * F1.386 — the host half of the unattended-automation floor hook, without the
 * binary: the minted plan, the exact command line, and the one-boot trust pass
 * (`hooks/list` → `config/batchWrite` of `hooks.state` → `hooks/list`), driven
 * over a stub client. The binary's own reading is
 * `mcp/__tests__/codex-automation-floor-hook-live.test.ts`; the probe that
 * measured the one-boot trust is `work/wjrr/probe/hook-trust-batchwrite.ts`
 * (2026-09-24: `untrusted` → `status: "ok"` → `trusted`, no `configWarning`).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildCodexConfigToml, CODEX_HOOK_PROJECTION_NOTICE } from '@nessy-agent/codex-responses-adapter/config-writer';
import { CodexAgent } from '../codex-agent.ts';
import { recordAndPersistCodexManagedApprovalsReviewers } from '../../config/codex-managed-requirement-cache.ts';
import {
  CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE,
  CODEX_AUTOMATION_FLOOR_HOOK_MATCHER,
  CODEX_AUTOMATION_FLOOR_HOOK_NOTICE,
  CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE,
  codexAutomationFloorHookCommand,
  codexAutomationFloorHookPlan,
  trustCodexHostAuthoredHooks,
} from '../backend/codex/automation-floor-hook.ts';

const NODE = '/opt/nessy/bun';
const SERVER = '/opt/nessy/session-mcp-server/index.js';
const ROOT = '/work/space';
const OURS = codexAutomationFloorHookCommand(NODE, SERVER, ROOT);

describe('F1.386 · the minted plan', () => {
  it('is one PermissionRequest group on the session automation tool, emitted into [hooks]', () => {
    const toml = buildCodexConfigToml({
      codexHome: '/tmp/f1386', model: 'm', adapterPort: 1, mode: 'default', sandboxGloballyEnabled: false,
      approvalsReviewer: 'auto_review', hooks: codexAutomationFloorHookPlan(NODE, SERVER, ROOT),
    });
    const parsed = Bun.TOML.parse(toml) as {
      hooks?: { PermissionRequest?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }> };
    };
    const groups = parsed.hooks?.PermissionRequest ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe(CODEX_AUTOMATION_FLOOR_HOOK_MATCHER);
    expect(groups[0]!.hooks?.[0]).toMatchObject({ type: 'command', command: OURS, timeout: 30 });
  });

  it('quotes every argument for the login shell codex runs it through', () => {
    // F1.1066 — NODE is a Bun path, so Bun's two project-file switches come first (the hook runs in the session folder).
    expect(OURS).toBe(`'${NODE}' '--no-env-file' '--config=/dev/null' '${SERVER}' '--permission-request-hook' '--workspace-root' '${ROOT}'`);
  });
});

interface Call { method: string; params: any }

function stubClient(lists: unknown[], opts: { throwOn?: string } = {}) {
  const calls: Call[] = [];
  let listIndex = 0;
  return {
    calls,
    client: {
      async request(method: string, params?: unknown) {
        calls.push({ method, params });
        if (opts.throwOn === method) throw new Error(`${method} failed`);
        if (method === 'hooks/list') return lists[Math.min(listIndex++, lists.length - 1)];
        if (method === 'config/batchWrite') return { status: 'ok' };
        throw new Error(`unexpected ${method}`);
      },
    },
  };
}

const entry = (command: string, trustStatus: string, key: string) => ({
  key, eventName: 'permissionRequest', handlerType: 'command', command, currentHash: `sha256:${key}`, trustStatus,
});
const list = (...hooks: unknown[]) => ({ data: [{ cwd: ROOT, hooks, warnings: [], errors: [] }] });

describe('F1.386 · trustCodexHostAuthoredHooks — one boot, only what the host minted', () => {
  it('trusts OUR untrusted entry through config/batchWrite + reloadUserConfig, and reports it trusted', async () => {
    const foreign = entry(`${OURS} # not ours`, 'untrusted', 'foreign');
    const { client, calls } = stubClient([
      list(entry(OURS, 'untrusted', 'k1'), foreign),
      list(entry(OURS, 'trusted', 'k1'), foreign),
    ]);
    expect(await trustCodexHostAuthoredHooks(client, ROOT, [OURS], () => {})).toBe(1);
    const write = calls.find(call => call.method === 'config/batchWrite');
    expect(write?.params).toEqual({
      edits: [{ keyPath: 'hooks.state', value: { k1: { enabled: true, trusted_hash: 'sha256:k1' } }, mergeStrategy: 'upsert' }],
      reloadUserConfig: true,
    });
  });

  it('CONTROL: an already-trusted entry is not re-written', async () => {
    const { client, calls } = stubClient([list(entry(OURS, 'trusted', 'k1'))]);
    expect(await trustCodexHostAuthoredHooks(client, ROOT, [OURS], () => {})).toBe(1);
    expect(calls.map(call => call.method)).toEqual(['hooks/list']);
  });

  it('CONTROL: no entry of ours → 0 and nothing written; a failing request → 0, never a throw', async () => {
    const none = stubClient([list(entry('/usr/bin/true', 'untrusted', 'user'))]);
    const lines: string[] = [];
    expect(await trustCodexHostAuthoredHooks(none.client, ROOT, [OURS], line => lines.push(line))).toBe(0);
    expect(none.calls.map(call => call.method)).toEqual(['hooks/list']);
    expect(lines.join('\n')).toContain('did not report the projected automation floor hook');

    const failing = stubClient([list(entry(OURS, 'untrusted', 'k1'))], { throwOn: 'config/batchWrite' });
    expect(await trustCodexHostAuthoredHooks(failing.client, ROOT, [OURS], () => {})).toBe(0);
  });
});

// ---- the agent half: CodexAgent projects the hook only under a configured reviewer ----

function agentAt(root: string): CodexAgent {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: 'ws-f1386', name: 'F1.386', rootPath: root, workspaceRootPath: root, sessionRootPath: `${root}/sessions` } as any,
    session: { id: 'session-f1386', workspaceRootPath: root, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: SERVER, node: NODE } },
  } as never);
  agent.onDebug = () => {};
  return agent;
}

/**
 * F1.1200 — since F1.1169 the reviewer answers (and so the hook refuses) only in Auto and Bypass permissions with
 * the toggle on, or in every mode under a list that requires the reviewer; Manual and Accept edits card a person.
 * The session fact said "while Codex auto-review is on … except in bypassPermissions", i.e. a refusal in every mode.
 */
describe('F1.1200 · the projection notice names when the reviewer answers', () => {
  it('names Auto and Bypass, the policy case, and the card in Manual and Accept edits', () => {
    expect(CODEX_AUTOMATION_FLOOR_HOOK_NOTICE).toContain('in Auto and Bypass permissions with auto-review on in Settings');
    expect(CODEX_AUTOMATION_FLOOR_HOOK_NOTICE).toContain('in every mode when your organisation\'s policy requires the reviewer');
    expect(CODEX_AUTOMATION_FLOOR_HOOK_NOTICE).toContain('In Manual and Accept edits with no such policy the reviewer is not asked');
    expect(CODEX_AUTOMATION_FLOOR_HOOK_NOTICE).toContain('except in bypassPermissions'); // F1.532 kept
  });

  it('CONTROL: the mode-free claim is gone from all three floor-hook notices', () => {
    for (const notice of [CODEX_AUTOMATION_FLOOR_HOOK_NOTICE, CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE, CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE]) {
      expect(notice).not.toContain('while Codex auto-review is on (in Settings, or required');
    }
  });
});

describe('F1.386 · CodexAgent.hostAuthoredHookProjection', () => {
  it('with auto_review in the written config: one PermissionRequest hook on the session server\'s own entry point, and the notice says so', () => {
    const agent = agentAt(ROOT);
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      const projected = (agent as any).hostAuthoredHookProjection() as { hooks?: { PermissionRequest?: Array<{ hooks: Array<{ command: string }> }> } };
      expect(projected.hooks?.PermissionRequest?.[0]?.hooks[0]?.command).toBe(OURS);
      expect((agent as any).sessionFacts.get('codex-hooks-projection')).toBe(CODEX_AUTOMATION_FLOOR_HOOK_NOTICE);
    } finally { agent.destroy(); }
  });

  it('CONTROL: without the reviewer nothing is projected — HEAD\'s config and HEAD\'s notice', () => {
    // F1.514 — "without the reviewer" includes no remembered administrator list that requires one.
    recordAndPersistCodexManagedApprovalsReviewers(undefined);
    const agent = agentAt(ROOT);
    try {
      expect((agent as any).hostAuthoredHookProjection()).toEqual({});
      expect((agent as any).sessionFacts.get('codex-hooks-projection')).toBe(CODEX_HOOK_PROJECTION_NOTICE);
    } finally { agent.destroy(); }
  });

  it('the trust pass runs only for a projected hook, and an untrusted one is SAID', async () => {
    const agent = agentAt(ROOT);
    try {
      const idle = stubClient([list(entry(OURS, 'untrusted', 'k1'))]);
      await (agent as any).trustProjectedHostHooks(idle.client);
      expect(idle.calls).toEqual([]);

      (agent as any).configuredApprovalsReviewer = 'auto_review';
      (agent as any).hostAuthoredHookProjection();
      const refused = stubClient([list(entry(OURS, 'untrusted', 'k1'))], { throwOn: 'config/batchWrite' });
      await (agent as any).trustProjectedHostHooks(refused.client);
      expect((agent as any).sessionFacts.get('codex-hooks-projection')).toBe(CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE);
    } finally { agent.destroy(); }
  });

  it('the trust pass sits after initialize and before any thread (source pin: the spawn cannot run here)', () => {
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf-8');
    const notify = source.indexOf("client.notify('initialized');\n      await this.trustProjectedHostHooks(client);");
    expect(notify).toBeGreaterThan(-1);
    expect(notify).toBeLessThan(source.indexOf("await client.request('thread/start', openThreadParams)"));
  });
});
