/**
 * P6.345 (J48) — `readOnly` reaches the session MCP server as
 * `annotations.readOnlyHint`.
 *
 * The claude adapter has always taken the documented opt-in — it passes
 * `annotations: { readOnlyHint: true }` into the SDK's `tool()`. The MCP
 * advertisement this server publishes, which is what codex and Pi see, carried
 * only `{ name, description, inputSchema }`, so the same fact reached one
 * runtime and not the other two. `readOnly` scored zero in this whole `src`
 * before this row.
 *
 * `index.ts` runs `main()` at import, so a real process over MCP stdio is the
 * only way to read what a client is actually handed — the same reason
 * `external-standalone.test.ts` gives.
 */
import { test, expect, describe } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER = resolve(import.meta.dir, 'index.ts');

/** The last line `main()` prints; the only signal the dispatcher is connected. */
const READY_LINE = 'Session MCP Server started';
/** Against the measured 70.7 s floor (P6.893), with headroom — never zero. */
const READY_TIMEOUT_MS = 240_000;

interface AdvertisedTool {
  name: string;
  annotations?: { readOnlyHint?: boolean };
}

async function listTools(args: string[]): Promise<AdvertisedTool[]> {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let tools: AdvertisedTool[] | undefined;
  // P6.893 — drained AND read. Drained because an undrained stderr pipe can
  // block the child; read because the readiness line below is the only thing
  // that says the dispatcher exists yet.
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: { tools?: AdvertisedTool[] } };
        if (msg.id === 2 && msg.result?.tools) tools = msg.result.tools;
      } catch {
        /* non-JSON line */
      }
    }
  });

  // Wait for the server's OWN readiness line instead of a fixed sleep. Measured
  // 2026-09-08 at load ~12: this child needs 28.3–46.6 s to reach that line in a
  // direct probe, and W9-ba measured 70 689 ms for it under `bun test` at load
  // 12.8 — a cold, I/O-bound module graph at ~1 % cpu, not contention. A 300 ms
  // handshake writes into a process that has not built its dispatcher yet, and
  // the failure then reads as a hang caused by whatever was just changed. The
  // window is set against that measured floor, never against zero.
  const ready = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < ready && !stderr.includes(READY_LINE)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!stderr.includes(READY_LINE)) {
    child.kill('SIGKILL');
    // Loud and named: the empty-map-plus-confusing-assertion shape this row was
    // born from is what a silent return produces.
    throw new Error(`session-mcp-server never printed its readiness line within ${READY_TIMEOUT_MS} ms; stderr was: ${stderr}`);
  }

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !tools) await new Promise((r) => setTimeout(r, 100));
  child.kill('SIGKILL');
  return tools ?? [];
}

describe('P6.345 — the MCP advertisement carries readOnlyHint', () => {
  test('a read-only tool is hinted and a state-changing one is not', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'smcp-ro-'));
    try {
      const tools = await listTools([
        '--session-id', 'ro1',
        '--workspace-root', ws,
        '--plans-folder', join(ws, 'plans'),
        '--config-root', ws,
      ]);
      expect(tools.length).toBeGreaterThan(0);

      const byName = new Map(tools.map((t) => [t.name, t]));

      // Positive: `config_validate` is `readOnly: true` in the canonical
      // registry (`tool-defs.ts`). Its hint must now be on the wire.
      const readOnly = byName.get('config_validate');
      expect(readOnly).toBeDefined();
      expect(readOnly?.annotations?.readOnlyHint).toBe(true);

      // Negative control, and it is the half that matters: an unhinted tool
      // must stay unhinted, or the annotation means nothing. `automation_create`
      // writes.
      const writer = byName.get('automation_create');
      expect(writer).toBeDefined();
      expect(writer?.annotations?.readOnlyHint).toBeUndefined();

      // At least one more read-only tool carries it, so the positive above is
      // not a single hand-wired case.
      const hinted = tools.filter((t) => t.annotations?.readOnlyHint === true);
      expect(hinted.length).toBeGreaterThan(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 330_000);
});
