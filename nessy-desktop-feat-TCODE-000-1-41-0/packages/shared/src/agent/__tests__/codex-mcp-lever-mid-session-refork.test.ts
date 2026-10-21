/**
 * F1.1019 (origin DN-183) — a codex MCP deny or ask rule added mid-session must reach the live thread at the
 * next turn head, including where the host is never asked (a `readOnlyHint` tool, auto-review on): there only
 * codex's own levers hold (F1.378), and they were written once, into `config.toml` at `createRuntime`.
 *
 * Measured first on the shipped `codex-app-server` 0.156.1 (DN-238, `work/dn238/lever-probe.ts`; the
 * measurement is in the docblock on `codexMcpLeverOverrideForTurn`): a `thread/fork` whose `config` carries
 * `mcp_servers.sources.disabled_tools` stops handing the read-only tool to the model, `approval_mode = "prompt"`
 * makes codex ask for it, `disabled_tools = []` hands it back, and a second fork WITHOUT the override hands a
 * disabled tool back — so the override rides every later fork.
 *
 * This file drives the turn-head seam (`applySelectedPluginSkillRuntimePolicy`) with a double for the
 * app-server channel, a real `CODEX_HOME` written by `writeCodexConfig` through `noteCodexMcpLeverBuild` (as
 * `createRuntime` does), and a real workspace store changed the way the config watcher sees it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexConfig } from '@nessy-agent/codex-responses-adapter/config-writer';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { CodexAgent, noteCodexMcpLeverBuild } from '../codex-agent.ts';

const SESSION_KEY: SessionKey = { workspaceId: 'ws-f1019', sessionId: 'session-f1019' };
const RAW = 'linear__save_issue';
const DENY = { id: 'deny-linear-save', action: 'deny', match: { kind: 'mcp', server: 'linear', tool: 'save_issue' } };
const ASK = { id: 'ask-linear-save', action: 'ask', match: { kind: 'mcp', server: 'linear', tool: 'save_issue' } };

const dirs: string[] = [];
beforeEach(() => { permissionsConfigCache.clear(); });
afterEach(() => {
  cleanupModeState(SESSION_KEY);
  permissionsConfigCache.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openSession(startRules: unknown[] | null, withPool = true, codexSearchCard = false) {
  cleanupModeState(SESSION_KEY);
  const root = mkdtempSync(join(tmpdir(), 'f1019-ws-'));
  const home = mkdtempSync(join(tmpdir(), 'f1019-home-'));
  dirs.push(root, home);
  const setRules = (rules: unknown[]) => {
    writeFileSync(join(root, 'permissions.json'), JSON.stringify({ permissionDsl: { version: 1, rules } }));
    permissionsConfigCache.invalidateWorkspace(root);
  };
  if (startRules) setRules(startRules);
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: { id: SESSION_KEY.workspaceId, name: 'F1.1019', rootPath: root, workspaceRootPath: root, sessionRootPath: join(root, 'sessions') } as any,
    session: { id: SESSION_KEY.sessionId, workspaceRootPath: root, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  agent.onDebug = () => {};
  // The runtime build: the same projection `createRuntime` hands the writer, recorded on the way.
  const projection = noteCodexMcpLeverBuild(agent, (agent as any).codexMcpRuleProjection(), codexSearchCard);
  writeCodexConfig({
    codexHome: home,
    model: 'codex/test-model',
    adapterPort: 1,
    mode: 'bypassPermissions',
    sandboxGloballyEnabled: false,
    deniedReadPaths: [join(root, 'credentials.enc')],
    ...(withPool ? { poolMcpUrl: 'http://127.0.0.1:1/mcp' } : {}),
    ...(codexSearchCard ? { declaredModelProvider: 'openai' } : {}),
    ...projection,
  });
  const forks: Array<Record<string, any>> = [];
  (agent as any).client = {
    request(method: string, params: any) {
      if (method === 'thread/fork') {
        forks.push(params.config);
        return Promise.resolve({ thread: { id: `thread-forked-${forks.length}` } });
      }
      return Promise.resolve({ thread: { id: 'thread-fresh' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).threadId = 'thread-original';
  (agent as any).codexHome = home;
  (agent as any).runtimeConfigSignature = 'stale-signature';
  const turnHead = (): Promise<void> => (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] });
  await turnHead();
  forks.length = 0;
  return { agent, root, forks, setRules, turnHead, forceDrift: () => { (agent as any).runtimeConfigSignature = 'another-drift'; } };
}

describe('F1.1019 · an MCP rule changed mid-session rides the turn-head re-fork as codex\'s own lever', () => {
  it('FAILING ARM: no rule at start, a deny added → the next turn head re-forks with disabled_tools, and every later fork keeps it', async () => {
    const h = await openSession(null);
    h.setRules([DENY]);
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    expect(h.forks[0]!.mcp_servers).toEqual({ sources: { disabled_tools: [RAW] } });
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    // Another drift (an effort change, say): a fork does not inherit its parent's override (measured), so it rides again.
    h.forceDrift();
    await h.turnHead();
    expect(h.forks).toHaveLength(2);
    expect(h.forks[1]!.mcp_servers).toEqual({ sources: { disabled_tools: [RAW] } });
    h.agent.destroy();
  });

  it('an ask added mid-session → approval_mode "prompt" on the re-fork (codex then asks even for a read-only tool)', async () => {
    const h = await openSession(null);
    h.setRules([ASK]);
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    expect(h.forks[0]!.mcp_servers).toEqual({ sources: { disabled_tools: [], tools: { [RAW]: { approval_mode: 'prompt' } } } });
    h.agent.destroy();
  });

  it('CONTROL: a deny present at start forks nothing and adds no override; removed mid-session → disabled_tools = [] hands the tool back', async () => {
    const h = await openSession([DENY]);
    await h.turnHead();
    expect(h.forks).toHaveLength(0);
    h.forceDrift();
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    expect(h.forks[0]!.mcp_servers).toBeUndefined();
    h.setRules([]);
    await h.turnHead();
    expect(h.forks).toHaveLength(2);
    expect(h.forks[1]!.mcp_servers).toEqual({ sources: { disabled_tools: [] } });
    h.agent.destroy();
  });

  it('BOUNDARY: an ask turned into a deny → the prompt entry is dropped in favour of the deny; a malformed store then loosens nothing', async () => {
    const h = await openSession([ASK]);
    h.setRules([DENY]);
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    expect(h.forks[0]!.mcp_servers).toEqual({ sources: { disabled_tools: [RAW] } });
    writeFileSync(join(h.root, 'permissions.json'), '{ "permissionDsl": ');
    permissionsConfigCache.invalidateWorkspace(h.root);
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    h.agent.destroy();
  });

  it('BOUNDARY: a session whose config.toml has no [mcp_servers.sources] gets no sources override (codex would read a transport-less entry)', async () => {
    const h = await openSession(null, false);
    h.setRules([DENY]);
    await h.turnHead();
    expect(h.forks).toHaveLength(0);
    h.agent.destroy();
  });
});

// F1.1072 — codex's OWN web search (the ChatGPT (Codex) card) rides the same re-fork as a top-level key.
const DENY_SEARCH = { id: 'deny-search', action: 'deny', match: { kind: 'tool', semanticId: 'WebSearch' } };

describe('F1.1072 · a WebSearch deny added mid-session switches codex\'s own search off at the next turn head', () => {
  it('FAILING ARM: the codex-search card, no rule at start, a deny added → the re-fork carries web_search = "disabled", and a later drift fork keeps it', async () => {
    const h = await openSession(null, true, true);
    h.setRules([DENY_SEARCH]);
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    expect(h.forks[0]!.web_search).toBe('disabled');
    h.forceDrift();
    await h.turnHead();
    expect(h.forks).toHaveLength(2);
    expect(h.forks[1]!.web_search).toBe('disabled');
    h.agent.destroy();
  });

  it('CONTROL: a card whose search is not codex\'s gets no key (its config.toml already disables it); an unrelated deny adds none on the card', async () => {
    const gateway = await openSession(null, true, false);
    gateway.setRules([DENY_SEARCH]);
    gateway.forceDrift();
    await gateway.turnHead();
    expect(gateway.forks).toHaveLength(1);
    expect('web_search' in gateway.forks[0]!).toBe(false);
    gateway.agent.destroy();
    const card = await openSession(null, true, true);
    card.setRules([DENY]);
    await card.turnHead();
    expect(card.forks).toHaveLength(1);
    expect('web_search' in card.forks[0]!).toBe(false);
    card.agent.destroy();
  });

  it('BOUNDARY: a deny present at build forks nothing new; removed mid-session it adds no key (codex\'s search stays off until the next build, the fail-closed side)', async () => {
    const h = await openSession([DENY_SEARCH], true, true);
    await h.turnHead();
    expect(h.forks).toHaveLength(0);
    h.setRules([]);
    h.forceDrift();
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    expect('web_search' in h.forks[0]!).toBe(false);
    h.agent.destroy();
  });
});

// F1.1175 (origin the do-now adversarial review, 2026-09-29) — the same deny written as a `toolRules` entry, the
// per-tool form permissions.md documents beside the readable policy. The projection read the readable program only,
// so `{ pattern: 'WebSearch', action: 'deny' }` left both the app's `web_search` and codex's own search on.
describe('F1.1175 · a toolRules WebSearch deny reaches codex\'s levers like the readable one', () => {
  const setToolRules = (root: string, toolRules: unknown[]) => {
    writeFileSync(join(root, 'permissions.json'), JSON.stringify({ toolRules }));
    permissionsConfigCache.invalidateWorkspace(root);
  };
  const sessionLevers = (agent: CodexAgent) => (agent as any).codexMcpRuleProjection().mcpToolLevers?.session;

  it('FAILING ARM: at build the app\'s web_search is disabled and codex\'s own search is off; added mid-session it rides the re-fork', async () => {
    const h = await openSession(null, true, true);
    setToolRules(h.root, [{ pattern: 'Web*', action: 'deny' }]);
    expect(sessionLevers(h.agent)).toMatchObject({ disabledTools: ['web_search'], webSearchDenied: true });
    await h.turnHead();
    expect(h.forks).toHaveLength(1);
    expect(h.forks[0]!.web_search).toBe('disabled'); // (this rig's config.toml has no session entry to override)
    h.agent.destroy();
  });

  it('BOUNDARY: an allow or an ask of WebSearch, an allow listed first (first match wins), or a deny of another tool projects nothing', async () => {
    const h = await openSession(null, true, true);
    for (const toolRules of [
      [{ pattern: 'WebSearch', action: 'allow' }],
      [{ pattern: 'WebSearch', action: 'ask' }],
      [{ pattern: 'WebSearch', action: 'allow' }, { pattern: 'WebSearch', action: 'deny' }],
      [{ pattern: 'WebFetch', action: 'deny' }],
    ]) {
      setToolRules(h.root, toolRules);
      expect(sessionLevers(h.agent), JSON.stringify(toolRules)).toBeUndefined();
    }
    h.agent.destroy();
  });
});
