/**
 * F1.1254 (origin: the final CDP sitting, 2026-10-01, TRIAGE D-4, the F1.256 posture) — in Bypass permissions Pi still
 * raised the outside-root "Filesystem access required" card for a READ (it waited 80 s), while Bash read the same
 * folder without one; Claude and codex do not ask for such a read in Bypass.
 *
 * Decided (owner rule 2026-10-08): in Bypass a Pi outside-root READ is granted for that one request without a card,
 * and the floors stay — a path the host's read check refuses in Bypass (`deniedPaths`, the operator's read fence) and
 * anything inside Nessy's own data folder still raise the card, as does every write and every other mode.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1254',
      name: 'F1.1254 Workspace',
      rootPath: '/tmp/nessy-f1254',
      workspaceRootPath: '/tmp/nessy-f1254',
      sessionRootPath: '/tmp/nessy-f1254-sessions/ws-f1254',
    } as any,
    session: {
      id: 'session-f1254',
      workspaceRootPath: '/tmp/nessy-f1254',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    skipConfigWatcher: true,
  };
}

function rig(mode: string) {
  const agent = new PiAgent(createConfig());
  const sent: Array<Record<string, unknown>> = [];
  const published: Array<Record<string, unknown>> = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).debug = () => {};
  (agent as any).subprocess = {};
  (agent as any).emitAutomationEvent = async () => {};
  agent.onPermissionRequest = (request: any) => { published.push(request); };
  agent.setPermissionMode(mode as never);
  const ask = (canonicalTarget: string, access: 'read' | 'write') =>
    (agent as any).handleLine(JSON.stringify({ type: 'outside_root_request', requestId: 'pi-oroot-1', canonicalTarget, access }));
  return { agent, sent, published, ask, dispose: () => { (agent as any).subprocess = null; agent.destroy(); } };
}

describe('F1.1254 · Bypass grants a Pi outside-root read for the request, floors kept', () => {
  it('Bypass + read: no card, the read is granted for this request only', async () => {
    const r = rig('bypassPermissions');
    try {
      await r.ask('/Users/someone/other-project/README.md', 'read');
      expect(r.published).toEqual([]);
      expect(r.sent).toEqual([{
        type: 'outside_root_response',
        requestId: 'pi-oroot-1',
        root: { canonicalRoot: '/Users/someone/other-project/README.md', access: 'read', receiptId: 'pi-oroot-1', expires: 'request' },
      }]);
    } finally {
      r.dispose();
    }
  });

  it('CONTROL: a write in Bypass, and a read in Manual, still raise the card', async () => {
    for (const [mode, access] of [['bypassPermissions', 'write'], ['default', 'read'], ['auto', 'read']] as const) {
      const r = rig(mode);
      try {
        await r.ask('/Users/someone/other-project/README.md', access);
        expect(`${mode}/${access}:${r.published.length}:${r.sent.length}`).toBe(`${mode}/${access}:1:0`);
      } finally {
        r.dispose();
      }
    }
  });

  it('FLOORS: Nessy\'s data folder and a deniedPaths match still raise the card in Bypass', async () => {
    for (const target of [join(CONFIG_DIR, 'workspaces', 'other', 'session.jsonl'), '/Users/someone/.ssh/id_ed25519']) {
      const r = rig('bypassPermissions');
      try {
        await r.ask(target, 'read');
        expect(`${target}:${r.published.length}:${r.sent.length}`).toBe(`${target}:1:0`);
      } finally {
        r.dispose();
      }
    }
  });
});
