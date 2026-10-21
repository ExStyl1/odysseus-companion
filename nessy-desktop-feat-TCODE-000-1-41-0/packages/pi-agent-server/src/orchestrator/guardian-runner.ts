/**
 * Guardian command-judge runner (plan: guardian-command-judge G1/G2) — it has NO
 * PRODUCTION CALLER (F1.829). The SHARED core (`runGuardianJudgeCore`) has two live
 * callers, both in server-core's SessionManager (F1.1195): `createGuardianJudgePort`
 * over the host child-session authority, and `consultAgentMessageGuardian` (the
 * send_agent_message judge, every runtime) over `queryLlm`. This wrapper adapts the
 * orchestrator spawner (`spawnChildSession`) to that core and is reached only from
 * `guardian-runner.test.ts`, which drives the core through it; kept, and recorded on
 * the inert worklist (`docs/superpowers/specs/2026-07-29-inert-worklist.md`). Its outer
 * `scanSubagentOutput` pass is on NO live path — the core's `sanitizeReason` is.
 * Wire a caller and this header is wrong: that test's importer guard goes red.
 *
 * FAIL-CLOSED CONTRACT: ANY failure — timeout, spawn error, aborted, malformed
 * output, or a model refusal — resolves to verdict `unsure`, NEVER
 * `no_objection`.
 */

import {
  GUARDIAN_DEFAULT_TIMEOUT_MS,
  runGuardianJudgeCore,
  type GuardianRunResult,
} from '../../../shared/src/agent/core/guardian-judge-core.ts';
import type { LlmConnection } from '../../../shared/src/config/llm-connections.ts';
import type { GuardianJudgeInput } from '../../../shared/src/prompts/guardian.ts';
import { scanSubagentOutput } from '../../../shared/src/prompts/untrusted-text.ts';
import { spawnChildSession, type ChildSessionResult, type SpawnChildSessionArgs } from './spawner.ts';

export { GUARDIAN_DEFAULT_TIMEOUT_MS } from '../../../shared/src/agent/core/guardian-judge-core.ts';
export type { GuardianRunResult } from '../../../shared/src/agent/core/guardian-judge-core.ts';

export interface RunGuardianJudgeOptions {
  input: GuardianJudgeInput;
  cwd: string;
  /**
   * Judge model id. When omitted, resolves to the gateway `fast` alias via the
   * shared core when a connection is supplied; otherwise the spawner default.
   */
  modelId?: string;
  /** Optional gateway connection used to default the model to the `fast` alias. */
  connection?: Pick<LlmConnection, 'models'>;
  /** Hard timeout in ms (default {@link GUARDIAN_DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Depth of the CALLING session; the judge child is one deeper. */
  depth?: number;
  /** Caller abort signal; the judge aborts when it fires or on timeout. */
  signal?: AbortSignal;
  getWorkspaceRootPath?: () => string | undefined;
  /** Injectable for tests — defaults to the real spawner. */
  spawn?: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>;
}

/**
 * Run one guardian judge evaluation. Never throws — every path returns a
 * verdict, and every failure path returns `unsure` (never `no_objection`).
 */
export async function runGuardianJudge(options: RunGuardianJudgeOptions): Promise<GuardianRunResult> {
  const spawn = options.spawn ?? spawnChildSession;
  return runGuardianJudgeCore({
    input: options.input,
    cwd: options.cwd,
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.getWorkspaceRootPath ? { getWorkspaceRootPath: options.getWorkspaceRootPath } : {}),
    // Adapt the orchestrator spawner's richer result to the core's minimal
    // contract. The spawner accepts a superset of GuardianSpawnArgs (same field
    // names), so forwarding the args object is byte-compatible.
    spawn: async args => {
      // Same reason as the review judge: a guardian verdict is a host-run child,
      // not an Agent-tool spawn, so it neither consumes nor is refused by the
      // subagent ceiling (`sub-agents.md:905`).
      const result = await spawn({ ...(args as SpawnChildSessionArgs), limitScope: 'internal' });
      // Judge output is child text. The core defangs the parsed `reason` (which
      // is what reaches a model, via the permission diagnostic), so this is the
      // outer layer: it also covers text that never parses as a verdict.
      return {
        status: result.status,
        text: scanSubagentOutput(result.text),
        ...(result.error ? { error: scanSubagentOutput(result.error) } : {}),
      };
    },
  });
}
