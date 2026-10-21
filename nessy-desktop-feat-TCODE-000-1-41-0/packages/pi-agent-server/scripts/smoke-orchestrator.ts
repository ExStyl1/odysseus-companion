#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const DEFAULT_ENTRYPOINT = join(ROOT, 'packages/pi-agent-server/dist/index.js');
const CREDS_PATH = join(homedir(), '.nessy/dp_auth_creds.json');
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
const DEFAULT_MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const CASE_TIMEOUT_MS = Number(process.env.NESSY_ORCH_SMOKE_TIMEOUT_MS ?? 180_000);

type SmokeMode = 'single' | 'parallel' | 'chain';

interface SmokeCase {
  id: string;
  mode: SmokeMode;
  expectedChildren: number;
  message: string;
  systemPrompt: string;
}

interface SmokeResult {
  id: string;
  mode: SmokeMode;
  subagentCalls: number;
  completedChildren: number;
  correct: boolean;
  malformed: boolean;
  thinkLeak: boolean;
  failure: string;
}

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function readJwt(): string {
  const envJwt = process.env.NESSY_GATEWAY_JWT || process.env.NESTOR_JWT;
  if (envJwt?.trim()) return envJwt.trim();

  const raw = readFileSync(CREDS_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as { jwt?: unknown };
  if (typeof parsed.jwt !== 'string' || !parsed.jwt.trim()) {
    throw new Error(`${CREDS_PATH} does not contain a non-empty jwt field`);
  }
  return parsed.jwt.trim();
}

function buildCases(): SmokeCase[] {
  const baseSystem = [
    'You are running a live orchestration smoke test.',
    'You MUST call the subagent tool before answering.',
    'Do not answer directly before the tool call.',
    'After the tool result, answer in one short sentence.',
    'Do not emit <think> tags.',
  ].join(' ');

  return [
    {
      id: 'single-1',
      mode: 'single',
      expectedChildren: 1,
      systemPrompt: `${baseSystem} Use single mode with agent scout.`,
      message: "Call subagent with top-level agent='scout' and task='Return exactly: single scout ok.'.",
    },
    {
      id: 'single-2',
      mode: 'single',
      expectedChildren: 1,
      systemPrompt: `${baseSystem} Use single mode with agent reviewer.`,
      message: "Call subagent with top-level agent='reviewer' and task='Return exactly: single reviewer ok.'.",
    },
    {
      id: 'single-3',
      mode: 'single',
      expectedChildren: 1,
      systemPrompt: `${baseSystem} Use single mode with agent planner.`,
      message: "Call subagent with top-level agent='planner' and task='Return exactly: single planner ok.'.",
    },
    {
      id: 'single-4',
      mode: 'single',
      expectedChildren: 1,
      systemPrompt: `${baseSystem} Use single mode with agent scout.`,
      message: "Call subagent with top-level agent='scout' and task='Return exactly: single facts ok.'.",
    },
    {
      id: 'parallel-1',
      mode: 'parallel',
      expectedChildren: 2,
      systemPrompt: `${baseSystem} Use parallel mode with a tasks array.`,
      message: "Call subagent with tasks=[{agent:'scout',task:'Return exactly: parallel scout ok.'},{agent:'reviewer',task:'Return exactly: parallel reviewer ok.'}].",
    },
    {
      id: 'parallel-2',
      mode: 'parallel',
      expectedChildren: 3,
      systemPrompt: `${baseSystem} Use parallel mode with a tasks array.`,
      message: "Call subagent with three tasks for scout, planner, and reviewer. Each child should return a short line ending with 'parallel three ok'.",
    },
    {
      id: 'parallel-3',
      mode: 'parallel',
      expectedChildren: 2,
      systemPrompt: `${baseSystem} Use parallel mode with a tasks array.`,
      message: "Call subagent with tasks=[{agent:'planner',task:'Return exactly: parallel plan ok.'},{agent:'scout',task:'Return exactly: parallel read ok.'}].",
    },
    {
      id: 'chain-1',
      mode: 'chain',
      expectedChildren: 2,
      systemPrompt: `${baseSystem} Use chain mode with a chain array.`,
      message: "Call subagent with chain=[{agent:'scout',task:'Return exactly: chain first ok.'},{agent:'reviewer',task:'Read previous: {previous}. Return exactly: chain second ok.'}].",
    },
    {
      id: 'chain-2',
      mode: 'chain',
      expectedChildren: 3,
      systemPrompt: `${baseSystem} Use chain mode with a chain array.`,
      message: "Call subagent with a three-step chain: scout returns 'chain scout ok', planner receives {previous} and returns 'chain planner ok', reviewer receives {previous} and returns 'chain reviewer ok'.",
    },
    {
      id: 'chain-3',
      mode: 'chain',
      expectedChildren: 2,
      systemPrompt: `${baseSystem} Use chain mode with a chain array.`,
      message: "Call subagent with chain=[{agent:'planner',task:'Return exactly: chain plan ok.'},{agent:'reviewer',task:'Check this previous result: {previous}. Return exactly: chain review ok.'}].",
    },
  ];
}

function tail(text: string, maxLength = 1200): string {
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectText).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value as Record<string, unknown>).map(collectText).join('\n');
}

async function runCase(testCase: SmokeCase, jwt: string, entrypoint: string): Promise<SmokeResult> {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), `nessy-orch-smoke-${testCase.id}-workspace-`));
  const sessionPath = mkdtempSync(join(tmpdir(), `nessy-orch-smoke-${testCase.id}-session-`));
  const child = spawn(process.execPath, [entrypoint], {
    cwd: ROOT,
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = createInterface({ input: child.stdout });
  const messages: any[] = [];
  let stderr = '';
  let promptSent = false;

  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });

  try {
    const done = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`timeout after ${CASE_TIMEOUT_MS}ms; stderr tail:\n${tail(stderr)}`));
      }, CASE_TIMEOUT_MS);

      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('exit', code => {
        if (!promptSent || code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`server exited with code ${code}; stderr tail:\n${tail(stderr)}`));
        }
      });

      stdout.on('line', line => {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        messages.push(message);

        if (message.type === 'ready' && !promptSent) {
          promptSent = true;
          writeJson(child, {
            type: 'prompt',
            id: `prompt-${testCase.id}`,
            message: testCase.message,
            systemPrompt: testCase.systemPrompt,
          });
          return;
        }

        if (message.type === 'pre_tool_use_request') {
          writeJson(child, {
            type: 'pre_tool_use_response',
            requestId: message.requestId,
            action: 'allow',
          });
          return;
        }

        if (message.type === 'event' && message.event?.type === 'agent_end' && promptSent) {
          clearTimeout(timeout);
          resolvePromise();
        }

        if (message.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(`${message.code}: ${message.message}; stderr tail:\n${tail(stderr)}`));
        }
      });
    });

    writeJson(child, {
      type: 'init',
      apiKey: jwt,
      model: DEFAULT_MODEL,
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      sessionId: `smoke-${testCase.id}-${Date.now()}`,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: GATEWAY_BASE_URL,
      customEndpoint: { api: 'openai-completions' },
      customModels: [DEFAULT_MODEL],
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: jwt } },
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8 },
    });

    await done;
  } catch (error) {
    messages.push({ smokeError: error instanceof Error ? error.message : String(error) });
  } finally {
    writeJson(child, { type: 'shutdown' });
    child.kill();
    stdout.close();
    rmSync(workspaceRootPath, { recursive: true, force: true });
    rmSync(sessionPath, { recursive: true, force: true });
  }

  const events = messages.filter(message => message.type === 'event').map(message => message.event);
  const subagentEnds = events.filter(event => event?.type === 'tool_execution_end' && event.toolName === 'subagent');
  const result = subagentEnds.at(-1)?.result?.details?.result;
  const childResults = Array.isArray(result?.results) ? result.results : [];
  const completedChildren = childResults.filter((childResult: any) => childResult?.status === 'done').length;
  const error = messages.find(message => message.smokeError)?.smokeError;
  const thinkLeak = /<think\b/i.test(collectText(messages));
  const correct = result?.status === 'done' && completedChildren >= testCase.expectedChildren;
  const malformed = subagentEnds.length === 0 || result?.status === 'error';

  return {
    id: testCase.id,
    mode: testCase.mode,
    subagentCalls: subagentEnds.length,
    completedChildren,
    correct,
    malformed,
    thinkLeak,
    failure: correct ? '' : String(error || result?.error || result?.status || 'missing completed subagent result'),
  };
}

function printReport(results: SmokeResult[]): void {
  const correct = results.filter(result => result.correct).length;
  const malformed = results.filter(result => result.malformed).length;
  const thinkLeaks = results.filter(result => result.thinkLeak).length;
  const verdict = correct >= 8 ? 'PASS' : 'FAIL';

  console.log(`Nessy orchestrator live smoke: ${verdict}`);
  console.log(`success_rate=${correct}/${results.length}`);
  console.log(`malformed_call_rate=${malformed}/${results.length}`);
  console.log(`think_leakage_sightings=${thinkLeaks}`);
  console.log('');
  console.log('| Case | Mode | Subagent calls | Completed children | Correct | Malformed | <think> leak | Failure |');
  console.log('| --- | --- | ---: | ---: | --- | --- | --- | --- |');
  for (const result of results) {
    console.log(`| ${result.id} | ${result.mode} | ${result.subagentCalls} | ${result.completedChildren} | ${result.correct ? 'yes' : 'no'} | ${result.malformed ? 'yes' : 'no'} | ${result.thinkLeak ? 'yes' : 'no'} | ${result.failure.replaceAll('\n', '<br>')} |`);
  }
}

async function main(): Promise<void> {
  const entrypoint = resolve(process.env.NESSY_PI_SERVER_ENTRYPOINT || DEFAULT_ENTRYPOINT);
  if (!existsSync(entrypoint)) {
    throw new Error(`pi-agent-server entrypoint not found: ${entrypoint}. Run bun run --cwd packages/pi-agent-server build first.`);
  }

  const jwt = readJwt();
  const cases = buildCases();
  const results: SmokeResult[] = [];

  for (const testCase of cases) {
    console.error(`[smoke] running ${testCase.id} (${testCase.mode})`);
    results.push(await runCase(testCase, jwt, entrypoint));
  }

  printReport(results);
  const passCount = results.filter(result => result.correct).length;
  if (passCount < 8) {
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
