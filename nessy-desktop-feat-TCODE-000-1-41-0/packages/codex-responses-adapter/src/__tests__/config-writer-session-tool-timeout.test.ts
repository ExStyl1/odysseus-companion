/**
 * UA12.24 — the `[mcp_servers.session]` entry always carries a
 * `tool_timeout_sec` at or above the host's card window.
 *
 * P-UA-n-1 (UA wave 2, UA-n / UA1.18): codex's own default for the key was
 * shorter than the publish card's 110 s window (`server-core`
 * `PUBLISH_ARTIFACT_CARD_TIMEOUT_MS`), so a card answered after it decided on
 * the host after codex had already told the model the call timed out. The
 * writer now emits the floor unconditionally on `session`; `sources` stays
 * explicit-set-only (P6.140, pinned in
 * `config-writer-mcp-startup-timeout.test.ts`, whose control this row split).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_SESSION_TOOL_TIMEOUT_SEC, writeCodexConfig } from '../config-writer.ts';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Both `[mcp_servers.*]` entries emitted, sliced into their table bodies. */
function entrySections(over: Record<string, unknown> = {}): { session: string; sources: string } {
  const home = mkdtempSync(join(tmpdir(), 'ua1224-home-'));
  try {
    writeCodexConfig({
      codexHome: home,
      model: MODEL,
      adapterPort: 45123,
      sessionMcp: { command: '/opt/node', args: ['/opt/session-mcp-server.js'], env: { NESSY_X: '1' } },
      poolMcpUrl: 'http://127.0.0.1:41234/mcp',
      ...over,
    });
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    const sectionAt = (header: string): string => {
      const start = toml.indexOf(header);
      if (start === -1) return '';
      const after = toml.slice(start + header.length);
      const nextAt = after.search(/^\[/m);
      return nextAt === -1 ? after : after.slice(0, nextAt);
    };
    return { session: sectionAt('[mcp_servers.session]'), sources: sectionAt('[mcp_servers.sources]') };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('UA12.24 — the session entry always carries the card-window deadline', () => {
  test('the row\'s control: the floor covers a publish card answered at 90 s, and sources stays explicit-set-only', () => {
    const { session, sources } = entrySections();
    expect(session).toContain(`tool_timeout_sec = ${CODEX_SESSION_TOOL_TIMEOUT_SEC}`);
    expect(CODEX_SESSION_TOOL_TIMEOUT_SEC).toBeGreaterThan(90);
    expect(sources).not.toContain('tool_timeout_sec');
  });

  test('the operator lever may loosen the session deadline, never tighten it below the floor', () => {
    const { session, sources } = entrySections({ mcpToolTimeoutSec: 42 });
    expect(session).toContain(`tool_timeout_sec = ${CODEX_SESSION_TOOL_TIMEOUT_SEC}`);
    expect(sources).toContain('tool_timeout_sec = 42');
  });

  test('a lever looser than the floor passes through to both entries', () => {
    const { session, sources } = entrySections({ mcpToolTimeoutSec: 3600 });
    expect(session).toContain('tool_timeout_sec = 3600');
    expect(sources).toContain('tool_timeout_sec = 3600');
  });

  test('the floor is derived from the session bridge\'s own callback ceiling, and that ceiling is still the literal the derivation names', () => {
    // 120 000 ms (`session-mcp-server/src/host-callback-bridge-client.ts`
    // `BRIDGE_TIMEOUT_MS`, the abort of every bridged route — publish, archive,
    // page delete; UA12.24 follow-up: the pin used to read index.ts
    // `CALLBACK_TOOL_TIMEOUT_MS`, the dead /call-llm channel's) + 1: every host
    // outcome on a session tool call — a verdict, the 110 s card timeout that
    // resolves a publish/archive/delete card to a deny, or this ceiling's own
    // abort — beats codex's clock. Reading the bridge client's source is the
    // drift alarm: if that ceiling moves without this floor, the pin reddens.
    expect(CODEX_SESSION_TOOL_TIMEOUT_SEC).toBe(121);
    const bridge = readFileSync(join(import.meta.dir, '../../../session-mcp-server/src/host-callback-bridge-client.ts'), 'utf8');
    expect(bridge).toContain('const BRIDGE_TIMEOUT_MS = 120000;');
    expect(bridge).toContain('AbortSignal.timeout(BRIDGE_TIMEOUT_MS)');
  });
});
