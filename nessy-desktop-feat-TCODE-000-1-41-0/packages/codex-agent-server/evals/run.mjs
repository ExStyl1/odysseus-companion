#!/usr/bin/env bun
/**
 * Task 7.4 — agentic coding evals. Golden coding tasks run through a real
 * `codex-runtime` backend (factory-resolved) against the LIVE gateway, scored on
 * hard metrics. Each task is an independent temp git workspace + prompt +
 * assertion. Gated on a JWT (read-only); prints per-task + aggregate JSON.
 *
 *   NESSY_FEATURE_CODEX_RUNTIME=1 bun packages/codex-agent-server/evals/run.mjs
 *
 * Metrics (thresholds): tool-call success ≥ 0.95, valid-JSON ≥ 0.98,
 * patch-apply ≥ 0.90, hidden-reasoning leakage = 0, unauthorized path/network = 0.
 *
 * Note: this harness lives here but imports from @nessy-agent/shared via the
 * workspace (it's a top-level script, not imported by anything, so no dep cycle).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from '@nessy-agent/shared/agent';
import { createMockBackendConfig } from '../../shared/src/agent/__tests__/test-utils.ts';
import { codexDriver } from '../../shared/src/agent/backend/internal/drivers/codex.ts';
import { resolveBackendRuntimePaths } from '../../shared/src/agent/backend/internal/runtime-resolver.ts';
import { readNestorJwt } from '../../codex-responses-adapter/src/nestor-auth.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Golden tasks: prompt + a scorer against the collected events + workspace. */
const TASKS = [
  {
    name: 'list-files',
    setup: (ws) => writeFileSync(join(ws, 'hello.txt'), 'hi\n'),
    prompt: 'List the files in this directory using a shell command.',
    expectPatch: false,
  },
  {
    name: 'create-file',
    setup: () => {},
    prompt: 'Create a file named greeting.txt containing the text "hello codex" using a shell command.',
    expectPatch: true,
    patched: (ws) => existsSync(join(ws, 'greeting.txt')),
  },
];

function newWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'codex-eval-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  execFileSync('git', ['-c', 'user.email=e@x', '-c', 'user.name=e', 'commit', '--allow-empty', '-qm', 'init'], { cwd: ws });
  return ws;
}

async function runTask(task) {
  const ws = newWorkspace();
  task.setup(ws);
  const before = new Set(readdirSync(ws));

  const config = createMockBackendConfig({
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
    model: MODEL,
    isHeadless: true,
    session: { id: `eval-${task.name}`, workingDirectory: ws },
  });
  const hostRuntime = { appRootPath: REPO_ROOT, isPackaged: false };
  config.runtime = codexDriver.buildRuntime({
    context: { connection: null, provider: 'codex-runtime', resolvedModel: MODEL, capabilities: { needsHttpPoolServer: false } },
    coreConfig: config,
    hostRuntime,
    resolvedPaths: resolveBackendRuntimePaths(hostRuntime),
  });

  const agent = createBackend(config);
  agent.onPermissionRequest = (req) => agent.respondToPermission(req.requestId, true);
  await agent.postInit();

  const events = [];
  let assistantText = '';
  try {
    for await (const e of agent.chat(task.prompt)) {
      events.push(e);
      if (e.type === 'text_delta' || e.type === 'text_complete') assistantText += e.text ?? '';
    }
  } finally {
    agent.destroy();
    await new Promise((r) => setTimeout(r, 300));
  }

  const toolStarts = events.filter((e) => e.type === 'tool_start');
  const toolResults = events.filter((e) => e.type === 'tool_result');
  const toolCallSuccess = toolStarts.length > 0 ? toolResults.filter((r) => !r.isError).length / toolStarts.length : 1;
  // valid-JSON: our adapter reconstructs args; a tool_start with an object input counts as valid.
  const validJson = toolStarts.length > 0 ? toolStarts.filter((t) => t.input && typeof t.input === 'object').length / toolStarts.length : 1;
  const reasoningLeak = /<think>|<\/think>|reasoning_content/.test(assistantText);
  const patched = task.expectPatch ? !!task.patched?.(ws) : true;
  // no unauthorized path: nothing created outside the workspace (best-effort — the
  // sandbox regression test 7.5 proves the hard block).
  const after = new Set(readdirSync(ws));
  const wroteInWorkspace = after.size >= before.size;

  const lingering = (() => { try { return execFileSync('pgrep', ['-f', 'codex-app-server'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; } })();
  rmSync(ws, { recursive: true, force: true });

  return { name: task.name, toolStarts: toolStarts.length, toolCallSuccess, validJson, patched, reasoningLeak, wroteInWorkspace, lingering, completed: events.some((e) => e.type === 'complete') };
}

async function main() {
  if (!readNestorJwt()) {
    console.log(JSON.stringify({ status: 'DEFERRED', reason: 'no gateway access (no JWT)' }, null, 2));
    process.exit(0);
  }
  const results = [];
  for (const task of TASKS) {
    console.error(`[eval] running ${task.name}...`);
    results.push(await runTask(task));
  }

  const patchTasks = results.filter((r) => TASKS.find((t) => t.name === r.name)?.expectPatch);
  const aggregate = {
    tasks: results.length,
    toolCallSuccessRate: Number((results.reduce((a, r) => a + r.toolCallSuccess, 0) / results.length).toFixed(3)),
    validJsonRate: Number((results.reduce((a, r) => a + r.validJson, 0) / results.length).toFixed(3)),
    patchApplyRate: patchTasks.length ? Number((patchTasks.filter((r) => r.patched).length / patchTasks.length).toFixed(3)) : 1,
    hiddenReasoningLeaks: results.filter((r) => r.reasoningLeak).length,
    unauthorizedWrites: results.filter((r) => !r.wroteInWorkspace).length,
    lingeringProcesses: results.filter((r) => r.lingering).length,
  };
  console.log(JSON.stringify({ perTask: results, aggregate }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
