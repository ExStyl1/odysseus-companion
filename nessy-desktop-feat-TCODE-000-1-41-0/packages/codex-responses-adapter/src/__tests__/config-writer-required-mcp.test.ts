/**
 * P2.508 — `required` is not written, and this pins the reason so that adding
 * it later has to be a decision rather than an oversight.
 *
 * ## The mechanism is real; the granularity is what settles it
 *
 * Measured against the shipped `darwin-arm64` `codex-app-server` (SHA-256
 * byte-identical to `codex-protocol/manifest.json`'s pinned `binarySha256`),
 * on both transports this writer emits:
 *
 * | config | `thread/start` |
 * | --- | --- |
 * | a server that cannot start, no `required` | succeeds |
 * | the same server, `required = true` | fails: "required MCP servers failed to initialize: …" |
 *
 * So this is configuration and not construction, which is normally where
 * native-first ends the argument. It does not end here, because `required` is a
 * per-ENTRY key and this writer emits exactly two entries. Every MCP server an
 * operator configured reaches codex aggregated behind `sources`, one loopback
 * HTTP endpoint, so the key could only ever mark OUR two infrastructure
 * servers. An operator's own server, marked essential, failing inside the pool
 * leaves `sources` healthy and codex's mechanism never fires.
 *
 * That is why the arms below assert the ENTRY LIST and not only the absence of
 * the key: the absence is a choice that is only defensible while the list stays
 * two servers long, and a future change that projected pool members as their
 * own entries would make the same absence indefensible. Pinning both together
 * is what makes this file fail at the moment the reasoning stops holding rather
 * than at the moment someone remembers to re-read a comment.
 *
 * The soft half we take instead lives in `shared/src/agent/codex-agent.ts` —
 * see `codexMcpStartupFailureNotice` and
 * `codex-mcp-startup-failure-surface.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexConfig } from '../config-writer.ts';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Both MCP surfaces on, which is what a real session with sources looks like. */
function emit(): string {
  const home = mkdtempSync(join(tmpdir(), 'p2508-required-'));
  try {
    writeCodexConfig({
      codexHome: home,
      model: MODEL,
      adapterPort: 54321,
      sessionMcp: { command: '/usr/bin/true', args: ['--session'] },
      poolMcpUrl: 'http://127.0.0.1:59999/mcp',
    });
    return readFileSync(join(home, 'config.toml'), 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function mcpEntryNames(toml: string): string[] {
  return [...toml.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map(m => m[1]!);
}

describe('the codex `required` MCP key', () => {
  /**
   * KILLS: writing `required` on either entry without meeting the comment above
   * — which would trade a degraded session for a session that refuses to open,
   * for two servers no operator ever marked.
   */
  it('is not emitted on any MCP entry', () => {
    const toml = emit();
    // Positive control that this config really carries the MCP blocks, so the
    // absence is about the key and not about an empty file.
    expect(mcpEntryNames(toml).length).toBeGreaterThan(0);
    expect(/^\s*required\s*=/m.test(toml)).toBe(false);
  });

  /**
   * KILLS: the granularity premise going stale in silence. While this list is
   * `session` and `sources`, `required` can only mark our own infrastructure;
   * the day a pool member becomes its own entry, the absence above needs
   * re-deciding and this arm is what says so.
   */
  it('could only ever mark our own two servers, because those are the only entries', () => {
    expect(mcpEntryNames(emit())).toEqual(['session', 'sources']);
  });
});
