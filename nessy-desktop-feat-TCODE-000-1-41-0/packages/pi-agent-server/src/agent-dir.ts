/**
 * UB1.19 — copied from craft-agents-oss `v0.15.1:packages/pi-agent-server/src/agent-dir.ts`
 * (Apache-2.0, first shipped v0.15.0), rebranded (`resolveNessyAgentDir`, the
 * `nessy-pi-agent-` scratch prefix). The adapter's loader takes its `agentDir`
 * from here, so a session-less agent (no session path) no longer falls back to
 * the process cwd (B2-07 residue 1).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pi `agentDir` for Nessy sessions.
 *
 * The SDK default (`~/.pi/agent`) holds the user's global Pi setup: extensions
 * (code that runs in this process and can hook every provider request), skills,
 * prompts and `SYSTEM.md`. None of it belongs in a Nessy session, so every Pi
 * session in this subprocess — the main chat and the utility sessions behind
 * `call_llm`, titles and summaries — resolves resources against an empty folder
 * under its own session path. A host-provided `agentDir` wins; sessionless agents
 * (no session path) get a per-process temporary folder.
 */
export function resolveNessyAgentDir(options: { agentDir?: string; sessionPath?: string }): string {
  const dir = options.agentDir
    || (options.sessionPath ? join(options.sessionPath, '.pi-agent') : processScratchAgentDir());
  mkdirSync(dir, { recursive: true });
  return dir;
}

let scratchAgentDir: string | undefined;

function processScratchAgentDir(): string {
  if (!scratchAgentDir) {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-pi-agent-'));
    scratchAgentDir = dir;
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return scratchAgentDir;
}
