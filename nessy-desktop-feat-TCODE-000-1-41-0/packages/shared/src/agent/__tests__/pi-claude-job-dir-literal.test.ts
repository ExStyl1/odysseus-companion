/**
 * F1.899 — on Pi, `echo x > "$CLAUDE_JOB_DIR/tmp/x"` wrote the SYSTEM `/tmp/x`
 * with no approval card.
 *
 * Measured live by SIT-ad (2026-09-25, packaged RC `69a6d33da`, Pi session
 * `28d27bc5` in Manual): the Bash call ran with no card, `/tmp/x` was created,
 * `<session>/job/tmp/` stayed empty, and `echo "JOBDIR=[$CLAUDE_JOB_DIR]"`
 * printed `JOBDIR=[]`. The same command on claude landed in
 * `<session>/job/tmp/x`, which is right.
 *
 * The cause is a premise the gate held for every caller and only one runtime
 * meets. The gate resolves the literal `$CLAUDE_JOB_DIR` (P6.783) to this
 * session's job directory because the host writes that name into the claude
 * child's environment (`buildClaudeSubprocessEnv`). Pi's `bash` is not a child
 * of the Pi subprocess at all: it is a HOST-supervised start
 * (`PiAgent.handleProcessStartRequest` → the supervisor port), whose environment
 * is the supervisor's `restricted` host allowlist plus the `env` the host builds
 * for that start. `buildPiSubprocessEnv` never reaches it, and neither name —
 * `CLAUDE_JOB_DIR` nor the P6.535 Pi spelling `NESSY_SESSION_JOB_DIR` — was in
 * either layer. So on Pi the gate approved a write to a path it had not checked.
 * F1.916 (2026-09-26) then put the P6.535 name, and ONLY that one, into the
 * per-start `env`, so parallel Pi sessions get separate scratch roots in their
 * shells too; `CLAUDE_JOB_DIR` stays absent, and the literal still asks.
 *
 * Two halves, both on the real Pi code rather than on a hand-built gate input:
 *  1. the DECISION, through `PiAgent.handlePreToolUseRequest` with a capturing
 *     permission service — "a card was shown" is the outcome `ask` that service
 *     receives, and "no card" is `allow`;
 *  2. the PREMISE, through `PiAgent.handleProcessStartRequest` with a capturing
 *     supervisor port: the env a Pi `bash` start is given names no
 *     `CLAUDE_JOB_DIR`. If that ever changes, this arm goes red, and whoever
 *     changed it decides whether Pi's gate call may then claim the opt-in.
 *     The same arm pins F1.916: the start DOES name `NESSY_SESSION_JOB_DIR`,
 *     created before it is named, and names nothing when it cannot be made.
 *
 * The claude half of the same contract — the literal still resolves, and every
 * P6.783 negative control still runs against a resolving gate — stays in
 * `session-scratch-no-prompt.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../pi-harness/harness-tool-descriptor.ts';
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';
import { saveWorkspacePermissions } from '../permissions-config.ts';
import { getSessionDirPath, getSessionJobDir, SESSION_JOB_DIR_ENV_VAR } from '../../sessions/storage.ts';

// The file's budget, not a test's: importing `pi-agent.ts` is an I/O-bound
// module graph charged to whichever hook runs first (AGENTS.md §Traps).
setDefaultTimeout(120_000);

const WORKSPACE_ID = 'ws-f1-899';
const SESSION_ID = 'session-f1-899';
// F1.916 — a session whose job directory does not exist before the start, and
// one whose `job` path is a FILE, so `ensureSessionJobDir` cannot make it.
const FRESH_SESSION_ID = 'session-f1-916-fresh';
const BLOCKED_SESSION_ID = 'session-f1-916-blocked';

let sandbox: string;
let workspaceRoot: string;
let projectDir: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1-899-')));
  workspaceRoot = join(sandbox, 'workspace');
  projectDir = join(sandbox, 'project');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // The job directory the gate resolves the literal to, created as the three
  // env builders create it (`ensureSessionJobDir` makes `tmp/`).
  mkdirSync(join(getSessionJobDir(WORKSPACE_ID, SESSION_ID), 'tmp'), { recursive: true });
  // The redirect arm bounds itself by the READ-ONLY classifier, whose allowlist
  // is empty in the `bun test` isolate — seeded at this sandbox's WORKSPACE
  // scope only, as `session-scratch-no-prompt.test.ts` does, so `echo` is the
  // read-only remainder the shipped `default.json` makes it.
  saveWorkspacePermissions(workspaceRoot, {
    version: '2026-09-08',
    allowedBashPatterns: [{ pattern: '^echo\\b', comment: 'Print text to stdout (as the shipped default.json has it)' }],
  } as never);
});

afterAll(() => {
  for (const id of [SESSION_ID, FRESH_SESSION_ID, BLOCKED_SESSION_ID]) {
    rmSync(getSessionDirPath(WORKSPACE_ID, id), { recursive: true, force: true });
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function piConfig(
  permissionServicePort: PiPermissionServicePort,
  extra: Partial<BackendConfig> = {},
  sessionId: string = SESSION_ID,
): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: WORKSPACE_ID,
      name: 'F1.899',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: join(sandbox, 'sessions'),
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: projectDir,
    } as never,
    isHeadless: true,
    contextProfile: 'bare',
    permissionServicePort,
    ...extra,
  } as BackendConfig;
}

/** A permission service that records the gate's decision and grants it as-is. */
function capturingPermissionService(decisions: string[]): PiPermissionServicePort {
  return {
    async authorize(request) {
      decisions.push(String((request.decision as { outcome?: unknown }).outcome));
      const outcome = request.decision.outcome === 'deny' ? 'deny' : 'allow';
      return parseAndFreezePiPermissionReceipt({
        version: 1,
        sessionKey: request.subject.sessionKey,
        binding: {
          provider: 'pi',
          surfaceVersion: request.subject.surfaceVersion,
          piName: request.subject.piName,
          bindingName: request.subject.bindingName,
          semanticId: request.subject.semanticId,
          descriptorId: request.subject.descriptorId,
        },
        manifest: {
          generation: request.subject.manifestGeneration,
          hash: request.subject.manifestHash,
          provenance: request.subject.manifestProvenance,
          responseEpoch: request.subject.responseEpoch,
        },
        decisionId: 'f1-899-decision',
        outcome,
        canonicalInput: request.canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(request.decision.outcome === 'deny' ? { reason: request.decision.reason } : {}),
      }, request.subject);
    },
  };
}

function installBashManifest(agent: PiAgent): Record<string, unknown> {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-f1-899',
    sessionKey: { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName];
      return modelContractHash ? [{
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash,
      }] : [];
    }),
  };
  const manifest = finalizePiExecutionManifest(seed, []);
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'Bash');
  if (!tool) throw new Error('missing Bash test tool');
  agent.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  } as unknown as CapabilityTurnRuntime);
  (agent as never as { activeExecutionManifest: unknown }).activeExecutionManifest = manifest;
  return {
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
  };
}

/** One Pi Bash call through the real gate: the outcome the permission service saw, and the gate's debug lines. */
async function piBash(command: string): Promise<{ outcome: string | undefined; debug: string[] }> {
  const decisions: string[] = [];
  const debug: string[] = [];
  const agent = new PiAgent(piConfig(capturingPermissionService(decisions)));
  // Manual — the mode SIT-ad measured in.
  agent.setPermissionMode('default');
  const state = agent as never as Record<string, unknown> & { debug: (message: string) => void };
  state.send = () => {};
  state.emitAutomationEvent = async () => ({ matchedCount: 0 });
  const originalDebug = state.debug.bind(agent);
  state.debug = (message: string) => { debug.push(message); originalDebug(message); };
  const identity = installBashManifest(agent);
  try {
    await (agent as never as { handlePreToolUseRequest: (request: unknown) => Promise<void> }).handlePreToolUseRequest({
      requestId: 'f1-899-request',
      ...identity,
      toolName: 'Bash',
      input: { command },
    });
  } finally {
    agent.destroy();
  }
  return { outcome: decisions[0], debug };
}

const scratchDiagnostic = (debug: readonly string[]) => debug.some(line => line.includes('session scratch directory'));

describe('F1.899 — the Pi gate does not approve `$CLAUDE_JOB_DIR` toward a path its shell will not write', () => {
  it('cards the quoted literal redirect — the exact SIT-ad command', async () => {
    const { outcome, debug } = await piBash('echo SITAD-JOBDIR > "$CLAUDE_JOB_DIR/tmp/x"');
    expect(outcome).toBe('ask');
    // And the scratch exemption did not claim it: its own diagnostic is absent.
    expect(scratchDiagnostic(debug)).toBe(false);
  });

  it('cards the unquoted spelling too', async () => {
    const { outcome } = await piBash('echo x > $CLAUDE_JOB_DIR/tmp/x');
    expect(outcome).toBe('ask');
  });

  it('CONTROL (F1.916): the Pi shell\'s own `$NESSY_SESSION_JOB_DIR` is not resolved by the gate either, so its write asks', async () => {
    // The shell now HAS this name; the gate still does not claim to know its
    // value, so the `$` stays and the write is carded (fail closed, unchanged).
    const { outcome, debug } = await piBash('echo x > "$NESSY_SESSION_JOB_DIR/tmp/x"');
    expect(outcome).toBe('ask');
    expect(scratchDiagnostic(debug)).toBe(false);
  });

  it('CONTROL: the same redirect written as the literal session scratch path reaches the scratch exemption (F1.1098)', async () => {
    // The literal path needs no variable, so nothing about F1.899 moves it. Measured at HEAD `e4d255395`: `ask`,
    // and not the exemption's answer: the real scratch folder sits under `<config>/sessions/`, and the
    // protected-directory floor, which runs first, carded it on claude as on Pi. F1.1098 (BK-10, 2026-10-09)
    // carves the session's own working folder out of that floor for a shell command whose every target lies
    // there, so the literal spelling now meets P6.535's exemption ("writes here don't prompt") on Pi too,
    // which names the folder in its diagnostic. The `$CLAUDE_JOB_DIR` spelling above still asks on Pi (F1.899).
    const target = join(getSessionJobDir(WORKSPACE_ID, SESSION_ID), 'tmp', 'x');
    const { outcome, debug } = await piBash(`echo x > ${target}`);
    expect(outcome).toBe('allow');
    expect(scratchDiagnostic(debug)).toBe(true);
  });

  it('CONTROL: a `..` escape out of the scratch root is carded, before and after', async () => {
    const { outcome } = await piBash('echo x > "$CLAUDE_JOB_DIR/tmp/../../escape.txt"');
    expect(outcome).toBe('ask');
  });
});

/** The `env` the host hands the supervisor for one Pi `bash` start in `sessionId`. */
async function piBashStartEnv(sessionId: string): Promise<Record<string, string>> {
  const starts: { env?: Record<string, string> }[] = [];
  const port = {
    start: async (request: { env?: Record<string, string> }) => {
      starts.push(request);
      return {
        handle: 'process_0123456789abcdef0123456789abcdef',
        output: '', nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
        isolationProfile: 'workspace:test', environmentProfile: 'restricted' as const,
        environmentDigest: 'a'.repeat(64),
      };
    },
    write: async () => {},
    read: async () => { throw new Error('unused'); },
    stop: async () => {},
    drainSession: async () => [],
  };
  const agent = new PiAgent(piConfig(capturingPermissionService([]), { processSupervisorPort: port } as Partial<BackendConfig>, sessionId));
  (agent as never as { subprocess: unknown }).subprocess = { stdin: { writable: true, write: () => {} } };
  (agent as never as { capabilityTurnRuntime: unknown }).capabilityTurnRuntime = { view: { skills: [] } };
  try {
    await (agent as never as { handleProcessStartRequest: (message: unknown) => Promise<void> }).handleProcessStartRequest({
      requestId: 'f1-899-start',
      request: {
        executionId: 'f1-899-start', semanticId: 'bash',
        command: '/bin/sh', args: ['-lc', 'true'],
        cwd: projectDir, profile: 'workspace' as const,
        background: false, timeoutMs: 1000,
      },
    });
  } finally {
    agent.destroy();
  }
  // The seam ran — every negative below is only as strong as this.
  expect(starts).toHaveLength(1);
  const env = starts[0]!.env ?? {};
  expect(env.CLAUDE_EFFORT).toBe('medium');
  return env;
}

describe('F1.899 — the premise: a Pi `bash` start is given no `CLAUDE_JOB_DIR`', () => {
  it('the env the host hands the supervisor for a Pi bash start names no CLAUDE_JOB_DIR', async () => {
    const env = await piBashStartEnv(SESSION_ID);
    expect(env).not.toHaveProperty('CLAUDE_JOB_DIR');
  });
});

describe('F1.916 — a Pi `bash` start is given the session\'s own `NESSY_SESSION_JOB_DIR`', () => {
  it('names this session\'s job directory, created before it is named', async () => {
    const jobDir = getSessionJobDir(WORKSPACE_ID, FRESH_SESSION_ID);
    // Absent before the start, so the assertion below proves the mkdir, not a leftover.
    expect(existsSync(jobDir)).toBe(false);
    const env = await piBashStartEnv(FRESH_SESSION_ID);
    expect(env[SESSION_JOB_DIR_ENV_VAR]).toBe(jobDir);
    expect(statSync(join(jobDir, 'tmp')).isDirectory()).toBe(true);
    // Two parallel sessions, two roots: the collision P6.535 exists to remove.
    expect((await piBashStartEnv(SESSION_ID))[SESSION_JOB_DIR_ENV_VAR]).toBe(getSessionJobDir(WORKSPACE_ID, SESSION_ID));
    // Still not claude's name (an owner question, pre-tool-use.ts `claudeJobDirInShell`).
    expect(env).not.toHaveProperty('CLAUDE_JOB_DIR');
  });

  it('BOUNDARY: names nothing when the job directory cannot be made', async () => {
    const jobDir = getSessionJobDir(WORKSPACE_ID, BLOCKED_SESSION_ID);
    mkdirSync(getSessionDirPath(WORKSPACE_ID, BLOCKED_SESSION_ID), { recursive: true });
    writeFileSync(jobDir, 'a file where the job directory would go');
    const env = await piBashStartEnv(BLOCKED_SESSION_ID);
    expect(env).not.toHaveProperty(SESSION_JOB_DIR_ENV_VAR);
    expect(statSync(jobDir).isFile()).toBe(true);
  });
});
