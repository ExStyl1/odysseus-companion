/**
 * UA12.191 (P-LF-5-2) — two docblocks that described the background-work seams before UA12.101 (`eb84bef6d`) say
 * what the code does since:
 *  - `BackendConfig.onBetweenTurnsEvent` names codex among its users (codex's out-of-turn terminal refresh hands its
 *    events to the host door; fixed by `6c39e7e01`, pinned here);
 *  - `withClaudeHostTaskRegistry` no longer says the host's copy of a Claude shell "never retires": SessionManager's
 *    `task_completed` case retires it on the CLI's `task_notification` (keyed on the shell id).
 *
 * Read from the source text, docblock by docblock (the comment that ends right above the declaration), so a later
 * edit elsewhere in either file cannot satisfy or break an arm.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_DIR = join(import.meta.dir, '..');

/** The `/** … *\/` block that ends on the line right above the first line matching `declaration`. */
function docblockAbove(file: string, declaration: RegExp): string {
  const lines = readFileSync(join(AGENT_DIR, file), 'utf8').split('\n');
  const at = lines.findIndex(line => declaration.test(line));
  if (at < 1) throw new Error(`${file}: no declaration matching ${declaration}`);
  let end = at - 1;
  if (!lines[end]!.trim().endsWith('*/')) throw new Error(`${file}: no docblock right above ${declaration}`);
  let start = end;
  while (start > 0 && !lines[start]!.trim().startsWith('/**')) start -= 1;
  end += 1;
  return lines.slice(start, end).join('\n');
}

describe('UA12.191 — the background-work docblocks match the code since UA12.101', () => {
  it('onBetweenTurnsEvent names CodexAgent among its users (control: the same reader on a block known to be current)', () => {
    const doc = docblockAbove('backend/types.ts', /^\s*onBetweenTurnsEvent\?: \(event: AgentEvent\) => void;/);
    expect(doc).toContain('`CodexAgent`');
    expect(doc).not.toMatch(/Absent: Pi and Claude drop the events\.\s*\*\/?$/m);
  });

  it('withClaudeHostTaskRegistry names the retire path and no longer says the host copy never retires', () => {
    const doc = docblockAbove('claude-agent.ts', /^export function withClaudeHostTaskRegistry\(/);
    expect(doc).toContain('UNION of what each side OWNS'); // the reader found the right block
    expect(doc).not.toContain('never retires');
    expect(doc).toContain('task_notification');
  });
});
