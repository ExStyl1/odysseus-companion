/**
 * D1.426 — the per-chat memory override, carried into the ONE runtime whose
 * `remember` is served by a subprocess.
 *
 * Pi and claude read `SessionToolContext.memoryEnabled` in process, so the
 * backend config's new `memoryScopeOverride` reaches their `remember` through
 * `createClaudeContext`'s live getter the moment `SessionManager` populates it.
 * Codex does not: its `remember` is served by `session-mcp-server`, a child
 * codex itself spawns from `[mcp_servers.session]`, and D1.371's own docblock
 * names the consequence as residue #1 — *"the PER-CHAT override ... is host
 * state that no argv carries into this subprocess ... A chat that closed its own
 * memory can still write one through a codex `remember`."*
 *
 * So the argv carries it, which is this file's subject. The shape is
 * `--advisor-consult`'s, deliberately: a host value the child cannot read, sent
 * as a spawn flag, emitted only when the host has something to say. Three
 * things are pinned here, and the third is the one that keeps the flag honest
 * over time:
 *
 *  1. an override that closes the write axis emits `--memory-scope-write false`;
 *  2. a chat that never touched the control emits NOTHING, so every existing
 *     session's argv is byte-identical to HEAD's — the subprocess then follows
 *     the app-wide switch exactly as D1.371 left it;
 *  3. the value is read from the config at the moment the spec is built, not
 *     captured earlier, which is what lets the P3.28 re-advertisement seam carry
 *     a mid-session flip if a later row wires it (see the method's docblock for
 *     the residue as it stands today).
 *
 * The READ axis is deliberately absent from the argv: this subprocess loads no
 * memories: it only writes them through `handleRemember`, whose sole gate is
 * `ctx.memoryEnabled`. A flag nothing reads would be a surface to keep in sync
 * for nothing.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CodexAgent } from '../codex-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionMemoryScopeOverride } from '../memory/session-memory-scope.ts';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../../config/paths.ts';

const WORKSPACE_ID = 'ws-memory-argv';
const SESSION_ID = 'session-memory-argv';

/** A live record the config reads through, as `SessionManager`'s own getter does. */
interface Record_ { memoryScopeOverride?: SessionMemoryScopeOverride }

function createAgent(record: Record_): any {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Memory Argv Workspace',
      rootPath: '/tmp/ws-memory-argv-root',
      workspaceRootPath: '/tmp/ws-memory-argv-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-memory-argv',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-memory-argv-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
      // The production shape: `SessionManager` builds this field as a getter
      // over the `ManagedSession`, so the rig is a getter too — a plain copy
      // here would make case 3 untestable and let a copy-based fix pass.
      get memoryScopeOverride() { return record.memoryScopeOverride },
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;
  return new CodexAgent(config);
}

function valueAfter(args: string[] | undefined, flag: string): string | undefined {
  if (!args) return undefined;
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('D1.426 — the codex session MCP argv carries this chat memory write axis', () => {
  it('a chat with memory closed spawns the subprocess with the axis closed', () => {
    const args = createAgent({ memoryScopeOverride: { write: false } }).buildSessionMcpSpec(undefined)?.args;
    expect(valueAfter(args, '--memory-scope-write')).toBe('false');
  });

  it('a chat that never touched the control spawns exactly the argv HEAD spawns', () => {
    const args = createAgent({}).buildSessionMcpSpec(undefined)?.args;
    expect(args).not.toContain('--memory-scope-write');
    // The positive control on the same instrument: this argv is a real one, so
    // the absence above is an absence rather than a spec that failed to build.
    expect(args).toContain('--config-root');
  });

  it('a chat that opened its own axis says so rather than falling silent', () => {
    // The app-wide switch is the subprocess's own live read, so BOTH values
    // have to cross: the resolver's precedence is "in either direction"
    // (`settings-reference.md#automemoryenabled`), and a flag emitted only for
    // `false` would silently drop half of it.
    const args = createAgent({ memoryScopeOverride: { write: true } }).buildSessionMcpSpec(undefined)?.args;
    expect(valueAfter(args, '--memory-scope-write')).toBe('true');
  });

  it('reads the record at spec time, so a mid-session flip is in the next spawn', () => {
    const record: Record_ = {};
    const agent = createAgent(record);
    expect(agent.buildSessionMcpSpec(undefined)?.args).not.toContain('--memory-scope-write');
    record.memoryScopeOverride = { write: false };
    expect(valueAfter(agent.buildSessionMcpSpec(undefined)?.args, '--memory-scope-write')).toBe('false');
  });

  it('the READ axis alone changes nothing this subprocess can act on', () => {
    const args = createAgent({ memoryScopeOverride: { read: false } }).buildSessionMcpSpec(undefined)?.args;
    expect(args).not.toContain('--memory-scope-write');
  });
});

/**
 * F1.118 (origin WI-by; D1.371's declined fail-closed branch) — the APP-WIDE
 * switch, on the argv, for the one install the child's ground comparison cannot
 * answer for.
 *
 * `codexMemoryWriteAxis` (`session-mcp-server/src/index.ts`) reads the app-wide
 * switch with `getMemoryEnabled()`, which resolves its config file from shared's
 * module-level `CONFIG_DIR` — the CHILD's, not the host's. D1.371 gated that
 * read on `CONFIG_DIR === configRoot` because codex's own
 * `create_env_for_mcp_server` allowlist does not carry `NESSY_CONFIG_DIR` into a
 * stdio MCP child, so on any host that moved its config directory the two
 * grounds differ and the child answers `undefined` — the key stays absent and
 * `handleRemember` writes. Fail-CLOSED was considered and declined there for a
 * stated reason (it would break `remember` outright on every dev rig), and this
 * row is the third option D1.371 did not have: **the host knows the answer, so
 * the host says it.**
 *
 * Three propositions, and the third is what keeps the flag honest:
 *
 *  1. an app-wide switch reading OFF emits `--memory-app-write false`;
 *  2. an app-wide switch reading ON emits NOTHING, so every ordinary session's
 *     argv is byte-identical to HEAD's — `codexMemoriesOption`'s own rule
 *     ("only the OFF position is written … writing `true` would re-assert a
 *     default we did not choose"), and the state the child already reads as
 *     "nothing withholds this write";
 *  3. the two axes cross SEPARATELY and are resolved once, in the child.
 *     Pre-resolving them here would resolve `resolveSessionMemoryScope` twice
 *     over one session and make the documented either-direction precedence
 *     (`settings-reference.md#automemoryenabled`) unreadable from either end.
 *
 * The switch is planted as a REAL `config.json` through the production loader
 * for WJ-f's reason in `user-memory-directory-binding.test.ts`: `loadStoredConfig`
 * reads the file on every call and caches nothing, while `mock.module` on
 * `config/storage.ts` would amputate that module for every other file sharing
 * this bun process (AGENTS.md's spread-and-restore trap) to buy nothing a file
 * write does not already give. The original bytes are restored in a `finally`.
 */
describe('F1.118 — the codex session MCP argv carries the APP-WIDE memory write axis', () => {
  const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

  /** Run `body` with `memoryEnabled` planted, and put the directory back exactly as it was. */
  function withMemoryEnabled<T>(memoryEnabled: boolean, body: () => T): T {
    const before = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify({
        storageLayoutVersion: STORAGE_LAYOUT_VERSION,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        memoryEnabled,
      }), 'utf-8');
      return body();
    } finally {
      if (before === null) rmSync(CONFIG_FILE, { force: true });
      else writeFileSync(CONFIG_FILE, before, 'utf-8');
    }
  }

  it('an app-wide switch reading OFF is stated on the argv', () => {
    const args = withMemoryEnabled(false, () => createAgent({}).buildSessionMcpSpec(undefined)?.args);
    expect(valueAfter(args, '--memory-app-write')).toBe('false');
  });

  it("an app-wide switch reading ON emits nothing, so an ordinary argv is HEAD's", () => {
    const args = withMemoryEnabled(true, () => createAgent({}).buildSessionMcpSpec(undefined)?.args);
    expect(args).not.toContain('--memory-app-write');
    // The positive control on the same instrument: this is a real argv, so the
    // absence above is an absence and not a spec that failed to build.
    expect(args).toContain('--config-root');
  });

  it('the two axes cross separately, so the child resolves the precedence once', () => {
    // App-wide OFF and a chat that opened its own axis: BOTH values are on the
    // argv, unresolved. A host that pre-resolved them would emit one, and the
    // documented either-direction precedence would then be decided twice.
    const args = withMemoryEnabled(
      false,
      () => createAgent({ memoryScopeOverride: { write: true } }).buildSessionMcpSpec(undefined)?.args,
    );
    expect(valueAfter(args, '--memory-app-write')).toBe('false');
    expect(valueAfter(args, '--memory-scope-write')).toBe('true');
  });

  it('reads the switch at spec time, so a flip is in the next spawn and in the drift check', () => {
    const agent = createAgent({});
    expect(withMemoryEnabled(true, () => agent.buildSessionMcpSpec(undefined)?.args))
      .not.toContain('--memory-app-write');
    expect(valueAfter(withMemoryEnabled(false, () => agent.buildSessionMcpSpec(undefined)?.args), '--memory-app-write'))
      .toBe('false');
  });
});
