/**
 * D1.359 — what `mcp__session__remember` really does on the codex transport,
 * driven through the REAL subprocess rather than by calling the handler.
 *
 * ## The row's premise, and what the transport actually answers
 *
 * SIT-5e measured `mcp__session__remember` sitting at `toolStatus: "executing"`
 * with an empty result through a 240 s ceiling on claude AND codex, on both
 * seeds, while `mcp__session__get_session_info` on the same card completed in
 * 15 658 ms / 9 342 ms. The row was born reading that as a broken tool or a
 * broken bridge.
 *
 * It is neither, and this file is the instrument that says so: the same tool,
 * over the same stdio MCP transport a codex child uses, answers EVERY scope in
 * the same exchange as a read-only control. Nothing here can hang — a reply
 * that does not arrive inside the pool's work window is simply absent from the
 * map, so `expect(responses.get(id)).toBeDefined()` IS the "it returned"
 * assertion and needs no wall-clock number beside it.
 *
 * What made the packaged turn sit was a PERMISSION CARD nobody answered: on
 * claude our own `PreToolUse` gate classifies `mcp__session__remember` as an
 * `mcp_mutation` (auto mode) and awaits a card, and on codex the app-server
 * raises its own `Allow the session MCP server to run tool "remember"?`
 * elicitation because the tool carries no `readOnlyHint` — which
 * `read-only-hint.test.ts` pins and which `get_session_info`, being
 * `readOnly: true`, does carry. That is why the control returned and this one
 * did not. Neither card is this file's subject; both are recorded in D1.359.
 *
 * ## The defect this file DOES fail on, before the fix
 *
 * `createCodexContext` bound `dataPath` and no `userMemoryPath`, so
 * `scope: "user"` — the scope auto memory itself uses, and the scope RS-79
 * drives — was refused BY NAME on codex however the card was answered:
 * `remember with scope=user requires userMemoryPath in context.` The session
 * scope beside it has always worked, which is what makes the pair a clean
 * before/after: one arm moves, the other must not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '@nessy-agent/shared/config/paths';
import { createChildPool, type PooledRpcResponse } from './__tests__/child-pool.ts';

/** This file's reply shape; the pool is generic in exactly this (P6.908). */
interface ToolReply {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
type RpcResponse = PooledRpcResponse<ToolReply | undefined>;

/**
 * ONE child for the whole file (P6.901): this server's boot is a cold,
 * I/O-bound module graph — 28.3–46.6 s in a direct probe and 70 689 ms under
 * `bun test` at load 12.8 — and all four calls below share one argv, so they
 * share one process and one exchange.
 */
const pool = createChildPool<ToolReply | undefined>();

let workspace: string;
let configRoot: string;
/** D1.371's own workspace, so the switch arm cannot read the scopes arm's file. */
let groundWorkspace: string;
/**
 * D1.372's project directory, deliberately OUTSIDE `workspace` and not a prefix
 * of it: the defect this arm closes is a scope that could only ever have been
 * written to the workspace root, so a project dir nested inside the workspace
 * would make "saved to the project" and "saved to the workspace" the same
 * reading.
 */
let projectRoot: string;
/**
 * F1.104's moved memory directory, outside every other root in this file so a
 * write landing there cannot be confused with any other scope's index.
 */
let chosenMemoryDir: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'smcp-mem-ws-'));
  groundWorkspace = mkdtempSync(join(tmpdir(), 'smcp-mem-gws-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'smcp-mem-proj-'));
  chosenMemoryDir = mkdtempSync(join(tmpdir(), 'smcp-mem-moved-'));
  // A config root of its OWN, never the workspace: the whole point of the fix is
  // that the user index lands under `--config-root`, and a rig that passed the
  // same directory twice could not tell the two scopes apart.
  configRoot = mkdtempSync(join(tmpdir(), 'smcp-mem-cfg-'));
});

afterAll(async () => {
  await pool.killAll();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(groundWorkspace, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(chosenMemoryDir, { recursive: true, force: true });
  rmSync(join(CONFIG_DIR, 'config.json'), { force: true });
  // F1.104's arm writes the USER index into this process's own config
  // directory, which is shared with every other file in this bun process.
  rmSync(join(CONFIG_DIR, 'MEMORY.md'), { force: true });
});

/**
 * The argv a codex session's `[mcp_servers.session]` spawns, minus the bridge.
 *
 * The session id is a parameter since D1.372: that arm takes one of its own so
 * its session-scope control cannot read the file this file's first test wrote.
 * Default `mem1` keeps every existing caller byte-identical.
 */
function codexArgs(sessionId = 'mem1'): string[] {
  return [
    '--session-id', sessionId,
    '--workspace-root', workspace,
    '--plans-folder', join(workspace, 'plans'),
    '--config-root', configRoot,
    '--external-standalone-only',
  ];
}

function textOf(response: RpcResponse | undefined): string {
  return (response?.result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

describe('D1.359 — the session MCP transport answers `remember` on every scope', () => {
  test('user scope writes the config-root index; session scope and a read-only control answer in the same exchange', async () => {
    const responses = await pool.runMcpSession(
      codexArgs(),
      [
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1359-USER', scope: 'user' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1359-SESSION', scope: 'session' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1359-PROJECT', scope: 'project' } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'config_validate', arguments: { target: 'config' } } },
      ],
    );

    // THE CONTROL the sitting's `get_session_info` played, on this instrument:
    // a read-only session tool answers on the same child, in the same exchange.
    // Without it, "remember answered" is equally true of a rig whose child was
    // simply alive and would say yes to anything.
    const control = responses.get(5);
    expect(control).toBeDefined();
    expect(textOf(control).length).toBeGreaterThan(0);

    // (1) USER scope — the arm that is RED before the fix, where it answers
    // `remember with scope=user requires userMemoryPath in context.`
    const user = responses.get(2);
    expect(user).toBeDefined();
    expect(user?.result?.isError).toBe(false);
    const userIndex = join(configRoot, 'MEMORY.md');
    expect(textOf(user)).toContain(`Saved memory to ${userIndex}`);
    expect(existsSync(userIndex)).toBe(true);
    expect(readFileSync(userIndex, 'utf-8')).toContain('D1359-USER');

    // (2) SESSION scope — true at HEAD and it must STAY true: the fix binds a
    // second path and must not move the one that already worked.
    const session = responses.get(3);
    expect(session).toBeDefined();
    expect(session?.result?.isError).toBe(false);
    const sessionIndex = join(workspace, 'sessions', 'mem1', 'data', 'MEMORY.md');
    expect(textOf(session)).toContain(`Saved memory to ${sessionIndex}`);
    expect(readFileSync(sessionIndex, 'utf-8')).toContain('D1359-SESSION');

    // (3) PROJECT scope on an argv with NO `--working-directory` — since
    // D1.372 this is the NEGATIVE arm rather than a stated residue, and it is
    // the arm a `this.workingDirectory` spelling in the emitter would fail.
    // A session that chose no project sends no flag, this context binds no
    // `workingDirectory`, and `handleRemember` refuses BY NAME — which is what
    // pi and claude answer for the same session, instead of writing
    // `<workspace>/MEMORY.md`. The describe below drives the flagged argv.
    const project = responses.get(4);
    expect(project).toBeDefined();
    expect(project?.result?.isError).toBe(true);
    expect(textOf(project)).toContain('requires workingDirectory in context');
    expect(existsSync(join(workspace, 'MEMORY.md'))).toBe(false);
  }, 330_000);
});

describe('D1.372 — a session that HAS a project directory can remember for it', () => {
  /**
   * The positive half of the arm above, on the argv a codex session with a
   * project directory now spawns. It costs ONE more pooled child (~20–70 s of
   * cold, I/O-bound module graph): `child-pool.ts` keys children by argv, and
   * the extra flag IS the argv difference under test, so it cannot share the
   * first exchange's child.
   *
   * The `session`-scope call in the same exchange is the control — without it,
   * "project scope answered" is equally true of a child that was simply alive.
   * The session id is its own (`mem4`), because the session-scope index is
   * `<workspace>/sessions/<id>/data/MEMORY.md` and a shared id would let this
   * arm read the file the first test wrote and call it its own evidence.
   */
  test('project scope writes the project index, and the workspace root is left alone', async () => {
    const responses = await pool.runMcpSession(
      [...codexArgs('mem4'), '--working-directory', projectRoot],
      [
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1372-PROJECT', scope: 'project' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1372-SESSION', scope: 'session' } } },
      ],
    );

    const project = responses.get(2);
    expect(project).toBeDefined();
    expect(project?.result?.isError).toBe(false);
    const projectIndex = join(projectRoot, 'MEMORY.md');
    expect(textOf(project)).toContain(`Saved memory to ${projectIndex}`);
    expect(existsSync(projectIndex)).toBe(true);
    expect(readFileSync(projectIndex, 'utf-8')).toContain('D1372-PROJECT');

    // THE CONTROL: this child is alive and this scope still works, so the line
    // above is the project binding and not a child that says yes to anything.
    const session = responses.get(3);
    expect(session).toBeDefined();
    expect(session?.result?.isError).toBe(false);
    expect(readFileSync(join(workspace, 'sessions', 'mem4', 'data', 'MEMORY.md'), 'utf-8'))
      .toContain('D1372-SESSION');

    // The WORKSPACE ROOT stays empty, which is the thing a fix reading
    // `this.workingDirectory` (defaulted to the workspace root by `BaseAgent`'s
    // constructor) would have written instead — measured here rather than only
    // at the emitter, because this is the process that would create the file.
    expect(existsSync(join(workspace, 'MEMORY.md'))).toBe(false);
  }, 330_000);
});

/**
 * The argv whose `--config-root` IS this process's `CONFIG_DIR`, so
 * `codexMemoryWriteAxis`'s ground comparison opens.
 *
 * `child-pool.ts` spawns with no `env` of its own, so the child inherits this
 * process's `NESSY_CONFIG_DIR` — the one the root `bunfig.toml` preload made
 * private to this test process — and computes the same `CONFIG_DIR` from it.
 * The rig control below asserts that, because the whole arm is meaningless if
 * the two grounds are not the same directory.
 */
function groundedArgs(options: { sessionId?: string; memoryScopeWrite?: boolean } = {}): string[] {
  return [
    // D1.426's arms take a session of their own: the session-scope index is
    // `<workspace>/sessions/<id>/data/MEMORY.md`, so a shared id would let one
    // arm read the file another arm wrote and call it its own evidence.
    '--session-id', options.sessionId ?? 'mem2',
    '--workspace-root', groundWorkspace,
    '--plans-folder', join(groundWorkspace, 'plans'),
    '--config-root', CONFIG_DIR,
    '--external-standalone-only',
    // Absent by default, so D1.371's arm below spawns the SAME child it always
    // did — a flag added to every argv would have rebuilt its evidence silently.
    ...(options.memoryScopeWrite === undefined ? [] : ['--memory-scope-write', String(options.memoryScopeWrite)]),
  ];
}

/**
 * A `config.json` this build's loader accepts, carrying only the switch — plus,
 * since F1.104, an optional `autoMemoryDirectory`. Omitted, the file is
 * byte-identical to the one every existing caller planted.
 */
function plantMemorySwitch(enabled: boolean, autoMemoryDirectory?: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    memoryEnabled: enabled,
    ...(autoMemoryDirectory === undefined ? {} : { autoMemoryDirectory }),
  }), 'utf-8');
}

describe('D1.371 — the memory OFF switch reaches codex', () => {
  /**
   * ON FIRST, then OFF, on the SAME child — which is what makes this one test
   * rather than two.
   *
   * The ON exchange is the control: it proves this child, this workspace and
   * this scope can write at all, so the refusal that follows is the switch and
   * not the rig. Doing it on one child also makes the GETTER part of the
   * assertion — the context is built once per process, so a value captured at
   * construction would answer ON for both exchanges (`loadStoredConfig` reads
   * the file every call and caches nothing, which is what the flip between the
   * two exchanges exercises).
   *
   * What this arm deliberately does NOT cover, and the production docblock says
   * so too: the PER-CHAT memory override, which is host state no argv carries
   * into this subprocess, and the unequal-ground case, where the key stays
   * absent and the write proceeds exactly as it did before D1.371.
   */
  test('with the grounds equal, a write is saved with the switch on and refused with it off', async () => {
    // THE RIG CONTROL. If the preload's private config dir and the frozen
    // `CONFIG_DIR` ever part company, the ground comparison under test can
    // never open and every assertion below would pass for the wrong reason.
    expect(process.env.NESSY_CONFIG_DIR).toBe(CONFIG_DIR);

    const index = join(groundWorkspace, 'sessions', 'mem2', 'data', 'MEMORY.md');

    plantMemorySwitch(true);
    const on = await pool.runMcpSession(
      groundedArgs(),
      [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1371-ON', scope: 'session' } } }],
    );
    expect(on.get(2)).toBeDefined();
    expect(on.get(2)?.result?.isError).toBe(false);
    expect(textOf(on.get(2))).toContain('Saved memory to');
    expect(readFileSync(index, 'utf-8')).toContain('D1371-ON');

    plantMemorySwitch(false);
    const off = await pool.runMcpSession(
      groundedArgs(),
      [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1371-OFF', scope: 'session' } } }],
    );
    expect(off.get(3)).toBeDefined();
    expect(off.get(3)?.result?.isError).toBe(true);
    // The wording is `handleRemember`'s own, so it is byte-identical to what a
    // claude session is told — the shared handler is the reason there is only
    // one sentence to assert.
    expect(textOf(off.get(3))).toContain('Memory is disabled for this workspace.');
    expect(readFileSync(index, 'utf-8')).not.toContain('D1371-OFF');
  }, 330_000);
});

describe('D1.426 — the PER-CHAT override reaches codex too', () => {
  /**
   * The residue D1.371 named in its own docblock — *"a chat that closed its own
   * memory can still write one through a codex `remember`"* — driven on the real
   * transport.
   *
   * The two exchanges are one test for D1.371's reason and for one more: the
   * APP-WIDE switch is ON for both of them, so the only thing that can refuse
   * the write is the per-chat axis the argv carried. The first exchange is the
   * control that this child, this workspace and this scope can write at all.
   */
  test('with the app-wide switch ON, a chat whose own write axis is closed is refused', async () => {
    expect(process.env.NESSY_CONFIG_DIR).toBe(CONFIG_DIR);
    plantMemorySwitch(true);

    const openIndex = join(groundWorkspace, 'sessions', 'mem3-open', 'data', 'MEMORY.md');
    const open = await pool.runMcpSession(
      groundedArgs({ sessionId: 'mem3-open' }),
      [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1426-CHAT-OPEN', scope: 'session' } } }],
    );
    expect(open.get(2)).toBeDefined();
    expect(open.get(2)?.result?.isError).toBe(false);
    expect(readFileSync(openIndex, 'utf-8')).toContain('D1426-CHAT-OPEN');

    const closedIndex = join(groundWorkspace, 'sessions', 'mem3-closed', 'data', 'MEMORY.md');
    const closed = await pool.runMcpSession(
      groundedArgs({ sessionId: 'mem3-closed', memoryScopeWrite: false }),
      [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1426-CHAT-CLOSED', scope: 'session' } } }],
    );
    expect(closed.get(3)).toBeDefined();
    expect(closed.get(3)?.result?.isError).toBe(true);
    // `handleRemember`'s own sentence, so a codex user is told exactly what a
    // claude user is told about the same chat.
    expect(textOf(closed.get(3))).toContain('Memory is disabled for this workspace.');
    expect(existsSync(closedIndex)).toBe(false);
  }, 330_000);

  /**
   * THE POSTURE, pinned where it can be read and reversed in one place.
   *
   * `resolveSessionMemoryScope` resolves the per-chat override over the
   * app-wide switch **in either direction**, which is not this fork's invention
   * — `settings-reference.md#automemoryenabled` says the per-session override
   * *"takes precedence over this key for one session, in either direction"* —
   * and it is what every other memory seam in this product already does
   * (`SessionManager.resolveSessionMemoryScopeFor`, `claude-context.ts`,
   * `codexMemoriesOption`, `applyCodexThreadMemoryMode`). Binding this one
   * runtime to a floor instead would mean the session menu showing a check mark
   * on a chat whose `remember` refuses — the exact class of defect D1.426 is,
   * one direction over — and the host tool disagreeing with codex's own
   * `[memories]` table inside one session.
   *
   * So: app-wide OFF, this chat ON, and the write is SAVED. A reviewer who
   * wants the app-wide switch to be a floor changes `codexMemoryWriteAxis` and
   * `claude-context.ts`'s `resolveMemoryWriteAxis` together, and this arm is
   * what tells them the decision was made rather than overlooked.
   */
  test('with the app-wide switch OFF, a chat that opened its own write axis is saved', async () => {
    plantMemorySwitch(false);

    const index = join(groundWorkspace, 'sessions', 'mem3-opted-in', 'data', 'MEMORY.md');
    const responses = await pool.runMcpSession(
      groundedArgs({ sessionId: 'mem3-opted-in', memoryScopeWrite: true }),
      [{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'D1426-OPTED-IN', scope: 'session' } } }],
    );
    expect(responses.get(4)).toBeDefined();
    expect(responses.get(4)?.result?.isError).toBe(false);
    expect(readFileSync(index, 'utf-8')).toContain('D1426-OPTED-IN');
  }, 330_000);
});

/**
 * F1.104 (origin D1.427, safety-review finding #20) — the USER-scope index
 * follows the operator's `autoMemoryDirectory`, driven over the real transport.
 *
 * `getUserMemoryFilePath` (`agent/memory/memory-store.ts`) has been the one
 * answer to where this app keeps that index since P6.390(2) —
 * `getAutoMemoryDirectory() ?? CONFIG_DIR` — and the loader, the cleanup pass
 * and the memory RPC all read it. This context joined `--config-root` instead,
 * so a user who had moved their memory directory got a SECOND, invisible index:
 * the agent's own `remember` wrote one file while everything that LOADS
 * memories read another.
 *
 * ON THE GROUNDED ARGV, deliberately: the setting can only be honoured where
 * `--config-root` and this subprocess's own `CONFIG_DIR` are the same
 * directory, and the first test in this file is the standing control for the
 * other side — an UNGROUNDED child still answers `join(configRoot, MEMORY.md)`,
 * which is HEAD's behaviour — and claude's file only while no directory is set.
 *
 * Both exchanges run on the SAME child as D1.371's arm (identical argv), which
 * is what makes the second half a liveness assertion too: the context is built
 * once per process, so a path captured at construction would answer the first
 * exchange's directory for the second.
 */
describe('F1.104 — the USER scope honours `autoMemoryDirectory`', () => {
  test('unset, the index is byte-identical; set, the index moves with it', async () => {
    expect(process.env.NESSY_CONFIG_DIR).toBe(CONFIG_DIR);

    // (1) THE CONTROL, and D1.427's own: with no `autoMemoryDirectory` nothing
    // moves for anyone who set nothing — which is almost everyone, and why the
    // split was silent.
    plantMemorySwitch(true);
    const unset = await pool.runMcpSession(
      groundedArgs(),
      [{ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1104-UNSET', scope: 'user' } } }],
    );
    expect(unset.get(6)).toBeDefined();
    expect(unset.get(6)?.result?.isError).toBe(false);
    const defaultIndex = join(CONFIG_DIR, 'MEMORY.md');
    expect(textOf(unset.get(6))).toContain(`Saved memory to ${defaultIndex}`);
    expect(readFileSync(defaultIndex, 'utf-8')).toContain('F1104-UNSET');

    // (2) the arm that is RED before the fix, where the child answers the
    // config root and the operator's own directory is never written at all.
    plantMemorySwitch(true, chosenMemoryDir);
    const moved = await pool.runMcpSession(
      groundedArgs(),
      [{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1104-MOVED', scope: 'user' } } }],
    );
    expect(moved.get(7)).toBeDefined();
    expect(moved.get(7)?.result?.isError).toBe(false);
    const movedIndex = join(chosenMemoryDir, 'MEMORY.md');
    expect(textOf(moved.get(7))).toContain(`Saved memory to ${movedIndex}`);
    expect(readFileSync(movedIndex, 'utf-8')).toContain('F1104-MOVED');

    // THE SPLIT ITSELF: the second write must not ALSO have landed in the
    // config root. Without this line a fix that wrote both files would pass.
    expect(readFileSync(defaultIndex, 'utf-8')).not.toContain('F1104-MOVED');
  }, 330_000);
});

/**
 * F1.118 (origin WI-by; D1.371's declined fail-closed branch) — the app-wide
 * switch on an UNEQUAL-ground install, where D1.371's comparison can answer
 * nothing at all.
 *
 * D1.371 gated `getMemoryEnabled()` on `CONFIG_DIR === configRoot` because
 * codex's `create_env_for_mcp_server` allowlist does not carry
 * `NESSY_CONFIG_DIR` into a stdio MCP child, so on any host that moved its
 * config directory this subprocess resolves a DIFFERENT config file from the
 * host's. Its docblock states the residue plainly — unequal grounds return
 * `undefined`, the key stays absent and the write proceeds — and it declined
 * fail-closed for a stated reason: refusing would break `remember` outright on
 * every dev rig and every moved-config install, a larger fault than the one
 * being closed.
 *
 * This row is the third option that argument did not have. **The host knows the
 * answer**, and since D1.426 it already puts host state this child cannot read
 * on the argv, so the app-wide switch crosses the same way — which retires the
 * ground comparison for this key WITHOUT fail-closing anything: an install
 * whose switch is ON still emits nothing and still writes.
 *
 * ## Why the grounds are UNEQUAL here, and why that is asserted
 *
 * Every arm below uses `codexArgs(...)`, whose `--config-root` is this file's
 * own temp directory and NOT this process's `CONFIG_DIR` — the opposite of
 * `groundedArgs`. A rig in which those two ever became the same directory would
 * make every assertion here pass through D1.371's own branch instead, so the
 * inequality is asserted rather than assumed (AGENTS.md: a control taken over a
 * different scope than its probe cannot fail).
 */
describe('F1.118 — the APP-WIDE switch reaches codex on a moved-config install', () => {
  /** `codexArgs` plus the two memory flags, so that helper stays byte-identical. */
  function ungroundedMemoryArgs(
    sessionId: string,
    options: { appWrite?: boolean; scopeWrite?: boolean } = {},
  ): string[] {
    return [
      ...codexArgs(sessionId),
      ...(options.appWrite === undefined ? [] : ['--memory-app-write', String(options.appWrite)]),
      ...(options.scopeWrite === undefined ? [] : ['--memory-scope-write', String(options.scopeWrite)]),
    ];
  }

  test('with the app-wide switch OFF, the flag refuses the write the ground comparison could not', async () => {
    // THE RIG CONTROL, and it is the whole arm: these two directories must
    // DIFFER, or the refusal below would be D1.371's branch and not this one.
    expect(configRoot).not.toBe(CONFIG_DIR);
    plantMemorySwitch(false);

    // (1) HEAD's behaviour, unchanged and kept as the discriminator: with no
    // flag the child has nothing to read, the key stays absent and the write
    // SUCCEEDS. This is the hole the row names, and it is what makes the second
    // exchange evidence about the flag rather than about the switch.
    const silentIndex = join(workspace, 'sessions', 'mem5-silent', 'data', 'MEMORY.md');
    const silent = await pool.runMcpSession(
      ungroundedMemoryArgs('mem5-silent'),
      [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1118-SILENT', scope: 'session' } } }],
    );
    expect(silent.get(2)).toBeDefined();
    expect(silent.get(2)?.result?.isError).toBe(false);
    expect(readFileSync(silentIndex, 'utf-8')).toContain('F1118-SILENT');

    // (2) The row: the host states the switch, and the same child on the same
    // unequal ground refuses.
    const statedIndex = join(workspace, 'sessions', 'mem5-stated', 'data', 'MEMORY.md');
    const stated = await pool.runMcpSession(
      ungroundedMemoryArgs('mem5-stated', { appWrite: false }),
      [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1118-STATED', scope: 'session' } } }],
    );
    expect(stated.get(3)).toBeDefined();
    expect(stated.get(3)?.result?.isError).toBe(true);
    // `handleRemember`'s own sentence, so a codex user on a moved-config host
    // is told exactly what every other user is told.
    expect(textOf(stated.get(3))).toContain('Memory is disabled for this workspace.');
    expect(existsSync(statedIndex)).toBe(false);
  }, 330_000);

  /**
   * THE POSTURE, on the unequal ground, pinned beside D1.426's grounded twin.
   *
   * The two axes reach this child as two separate flags and are resolved ONCE
   * here, by `resolveSessionMemoryScope`, so the documented either-direction
   * precedence (`settings-reference.md#automemoryenabled`) holds on a
   * moved-config install exactly as it holds on an ordinary one. A host that
   * pre-resolved them would have decided it twice and this arm would be the
   * only place the divergence showed.
   */
  test('with the app-wide switch OFF stated by flag, a chat that opened its own axis is still saved', async () => {
    expect(configRoot).not.toBe(CONFIG_DIR);
    plantMemorySwitch(false);

    const index = join(workspace, 'sessions', 'mem5-opted-in', 'data', 'MEMORY.md');
    const responses = await pool.runMcpSession(
      ungroundedMemoryArgs('mem5-opted-in', { appWrite: false, scopeWrite: true }),
      [{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1118-OPTED-IN', scope: 'session' } } }],
    );
    expect(responses.get(4)).toBeDefined();
    expect(responses.get(4)?.result?.isError).toBe(false);
    expect(readFileSync(index, 'utf-8')).toContain('F1118-OPTED-IN');
  }, 330_000);
});

/**
 * F1.194 (F1.104's residue) — on the UNEQUAL ground the child cannot resolve the
 * host's user-memory root, because `create_env_for_mcp_server` does not carry
 * `NESSY_CONFIG_DIR`; with `autoMemoryDirectory` set, `join(configRoot, …)` was a
 * second index the host never loads. The host now states its root by argv, and
 * the child writes there. The control is D1.359's own first arm above: no flag,
 * same unequal ground, and the index still lands under `--config-root`.
 */
describe('F1.194 — the USER scope follows the host root stated by argv on a moved-config install', () => {
  test('with --user-memory-root the index lands there, and not under --config-root', async () => {
    expect(configRoot).not.toBe(CONFIG_DIR);
    plantMemorySwitch(true);
    const hostRoot = mkdtempSync(join(tmpdir(), 'smcp-mem-hostroot-'));
    try {
      const responses = await pool.runMcpSession(
        [...codexArgs('mem6-hostroot'), '--user-memory-root', hostRoot],
        [{ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1194-HOST-ROOT', scope: 'user' } } }],
      );
      expect(responses.get(8)).toBeDefined();
      expect(responses.get(8)?.result?.isError).toBe(false);
      const hostIndex = join(hostRoot, 'MEMORY.md');
      expect(textOf(responses.get(8))).toContain(`Saved memory to ${hostIndex}`);
      expect(readFileSync(hostIndex, 'utf-8')).toContain('F1194-HOST-ROOT');
      // THE SPLIT: the config-root index must not ALSO have taken the write.
      const configIndex = join(configRoot, 'MEMORY.md');
      expect(existsSync(configIndex) ? readFileSync(configIndex, 'utf-8') : '').not.toContain('F1194-HOST-ROOT');
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
    }
  }, 330_000);

  test('a RELATIVE --user-memory-root is refused and the old answer stands', async () => {
    expect(configRoot).not.toBe(CONFIG_DIR);
    plantMemorySwitch(true);
    const responses = await pool.runMcpSession(
      [...codexArgs('mem6-relative'), '--user-memory-root', 'relative/dir'],
      [{ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'remember', arguments: { memory: 'F1194-RELATIVE', scope: 'user' } } }],
    );
    expect(responses.get(9)).toBeDefined();
    expect(responses.get(9)?.result?.isError).toBe(false);
    expect(textOf(responses.get(9))).toContain(`Saved memory to ${join(configRoot, 'MEMORY.md')}`);
  }, 330_000);
});
