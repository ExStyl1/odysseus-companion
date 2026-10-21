/**
 * P6.548 — codex's two MCP **startup** deadlines stay unwritten, and the reason
 * is in the assertion so a later lane cannot reverse it by accident.
 *
 * `RawMcpServerConfig` declares three transport deadlines. P6.140 took one of
 * them: `tool_timeout_sec` is written on `sources` for an operator who set
 * `NESSY_MCP_TOOL_TIMEOUT` explicitly, and — since UA12.24 — ALWAYS on
 * `session` at the card-window floor (`CODEX_SESSION_TOOL_TIMEOUT_SEC`, pinned
 * in `config-writer-session-tool-timeout.test.ts`). The other two —
 * `startup_timeout_sec` (`format: double`) and `startup_timeout_ms`
 * (`format: uint64`) — are
 * deliberately not written, and until this row nothing FAILED if someone started
 * writing them on a different reading. This file is that failure.
 *
 * ## What the shipped binary says the keys bound (measured 2026-09-07)
 *
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, the strings
 * around `codex-mcp/src/mcp/mod.rs:636`, verbatim:
 *
 *     handshaking with MCP server
 *     MCP client startup timed out.
 *     MCP client for `…` timed out after … seconds. Add or adjust
 *     `startup_timeout_sec` in your config.toml:
 *     [mcp_servers.…]
 *     startup_timeout_sec = …
 *
 * So the pair bounds **codex's own MCP client startup and `initialize`
 * handshake** for an entry — not, as the row's note had it, only a spawn.
 *
 * ## The row's stated reason is HALF-WRONG, and the decision survives anyway
 *
 * The note said both keys "bound codex's own spawn of those entries — a connect
 * the host pool never makes, since the pool is already running when codex
 * attaches". That is true of `[mcp_servers.sources]` and **false** of
 * `[mcp_servers.session]`: `session` is a stdio entry with `command`/`args`, so
 * codex really does spawn that child itself, and this deadline really does bound
 * it. The correct reason is the one this file asserts:
 *
 * - `session` — codex spawns and handshakes a child the HOST never touches.
 *   `NESSY_MCP_TIMEOUT` is the host pool's connect deadline for servers the host
 *   opens; it is not a value about this connection, so there is nothing to
 *   project and a number here would be invented.
 * - `sources` — one aggregated loopback HTTP endpoint that is already listening
 *   when codex attaches. `NESSY_MCP_TIMEOUT` governs the pool's connect to the
 *   real servers ONE HOP FURTHER OUT; bounding a loopback handshake by a
 *   deadline sized for arbitrary remote servers measures the wrong thing.
 *
 * And P3.348's explicit-set-only rule applies with full force: a wrong-TYPED
 * value in this file is not an ignored key — measured for `compact_prompt = 42`
 * it yields *"Invalid configuration; using defaults."*, discarding the provider
 * block, the sandbox mode and every denied path with it.
 *
 * ## How to reverse it
 *
 * Not by deleting these assertions. Reverse it with a MEASUREMENT: a host lever
 * whose deadline is about the same connection codex is opening. Then this file
 * changes to pin the projection, and its docblock records what was measured.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexConfig } from '../config-writer.ts';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Both `[mcp_servers.*]` entries emitted — the only shape where the keys could appear. */
function configWithBothEntries(over: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'p6548-home-'));
  try {
    writeCodexConfig({
      codexHome: home,
      model: MODEL,
      adapterPort: 45123,
      sessionMcp: { command: '/opt/node', args: ['/opt/session-mcp-server.js'], env: { NESSY_X: '1' } },
      poolMcpUrl: 'http://127.0.0.1:41234/mcp',
      ...over,
    });
    return readFileSync(join(home, 'config.toml'), 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('P6.548 — the startup pair stays unwritten, deliberately', () => {
  test('neither key is emitted on either entry, and the emitted sibling is the control', () => {
    // The positive control comes FIRST: with the operator lever set,
    // `tool_timeout_sec` IS written on `sources` (and `session` carries the
    // UA12.24 card-window floor unconditionally). Without it, "no startup key
    // here" would also be true of a writer that emitted no MCP table at all.
    const toml = configWithBothEntries({ mcpToolTimeoutSec: 42 });
    expect(toml).toContain('[mcp_servers.session]');
    expect(toml).toContain('[mcp_servers.sources]');
    expect(toml.match(/^tool_timeout_sec = 42$/gm)?.length).toBe(1);
    expect(toml).toContain('tool_timeout_sec = 121');

    // The pin. Substring rather than line-anchored on purpose: a lane writing
    // `startup_timeout_sec` under a profile table, inside an inline table, or
    // with different spacing must redden here too.
    //
    // `session` is a stdio entry codex SPAWNS — the arm the row's note got
    // wrong — and it stays unwritten because `NESSY_MCP_TIMEOUT` is a deadline
    // about a different connection, not because codex makes no connect here.
    expect(toml).not.toContain('startup_timeout_sec');
    // `sources` is the loopback pool endpoint, already listening; the host's
    // deadline governs the hop beyond it.
    expect(toml).not.toContain('startup_timeout_ms');
  });

  test('and no option on the writer can make them appear', () => {
    // The reverse direction: a caller that passes the keys through by any of the
    // three spellings a future lane would reach for gets nothing. If a lane adds
    // a real option it must change this test by name, which is the point.
    const toml = configWithBothEntries({
      startupTimeoutSec: 30,
      startup_timeout_sec: 30,
      mcpStartupTimeoutMs: 30_000,
    });
    expect(toml).not.toContain('startup_timeout');
    expect(toml).not.toContain('30000');
  });
});
