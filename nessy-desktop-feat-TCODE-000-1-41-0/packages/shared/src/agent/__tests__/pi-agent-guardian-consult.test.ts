import { afterEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as configStorage from '../../config/storage.ts';

// Guardian settings are read LIVE from config storage per consult. Override the
// two guardian getters through a mutable holder so tests can flip the setting
// and the judge model without touching real user config. The mock is installed
// BEFORE pi-agent is imported so pi-agent's binding resolves to it. Everything
// else in the storage module keeps its real implementation.
const guardianSettings = {
  enabled: true,
  modelId: '',
  enabledReads: 0,
  useAutoModeDuringPlan: true,
  bypassAcknowledged: false,
};
mock.module('../../config/storage.ts', () => ({
  ...configStorage,
  getGuardianEnabled: () => { guardianSettings.enabledReads += 1; return guardianSettings.enabled; },
  getGuardianJudgeModelId: () => guardianSettings.modelId,
  // Documented default is ON — "the `useAutoModeDuringPlan` setting is on, which
  // it is by default" (permission-modes.md:240 on the 2026-08-23 fetch; the
  // sentence is the anchor, this cite said `:156`). Overridden through the
  // holder so a test can flip it without reading the real user config.
  getUseAutoModeDuringPlan: () => guardianSettings.useAutoModeDuringPlan,
  // P2.50 (OQ-3, owner 2026-08-23): the install-wide one-time responsibility
  // acknowledgment is the SECOND route to "bypass permissions available".
  // Default false — never acknowledged — matching the real getter.
  getBypassPermissionsAcknowledged: () => guardianSettings.bypassAcknowledged,
}));

const { PiAgent } = await import('../pi-agent.ts');
type PiAgent = InstanceType<typeof PiAgent>;
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import type { GuardianJudgeInput } from '../../prompts/guardian.ts';
import type { PermissionDslV1 } from '../pi-harness/permission-dsl.ts';
import type { PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';
import type { GuardianJudgePort, GuardianRunResult } from '../core/guardian-consult.ts';
import type { PermissionMode } from '../mode-types.ts';
// F1.462 (F1.133): every VALUE loads AFTER the storage stub above — a static
// import is hoisted above the module body, whatever line it is written on.
const { finalizePiExecutionManifest } = await import('../pi-harness/harness-manifest.ts');
const {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} = await import('../pi-harness/harness-tool-descriptor.ts');
const { parseManagedPiPolicyV1, resolveAutoMode } = await import('../pi-harness/managed-policy.ts');
const { GUARDIAN_BUILT_IN_AUTO_MODE_DEFAULTS } = await import('../../prompts/guardian.ts');
const { parsePermissionDslV1 } = await import('../pi-harness/permission-dsl.ts');
const { parseAndFreezePiPermissionReceipt } = await import('../pi-harness/permission-receipt.ts');
const { GuardianConsultState } = await import('../core/guardian-consult.ts');
const { shouldPromptInAskMode, shouldPromptInAutoMode } = await import('../core/pre-tool-use.ts');
const { i18n, setupI18n } = await import('../../i18n/index.ts');

// P2.254: every `shouldPromptIn*Mode`/`shouldAllowToolInMode('Bash', …)` below
// reaches `getDeniedPathViolation` -> `extractPowerShellWriteTarget`, and the
// `Remove-Item` ladder additionally routes through the PowerShell validator
// itself — so on a host with a real PowerShell each case spawns
// `powershell-parser.ps1` one or more times (P2.241 owns the ungated spawn).
// One spawn is 0.69-0.88s idle, so bun's 5s default sits BELOW this file's
// resting cost. Measured on this file alone: at HEAD before the fix, 14 pass /
// 139 fail in 2.32s, every failure the uncaught `PowerShell validator root not
// set`; with the fix and bun's 5s default, 112 pass / 41 fail in 666s, every
// failure a `timed out after 5000ms`. Same value and reason as
// `packages/shared/tests/mode-manager.test.ts`.
setDefaultTimeout(30_000);

function testPermissionService(): PiPermissionServicePort {
  return {
    async authorize(request) {
      // Honors the DECISION verbatim: allow -> allow receipt, deny -> deny
      // receipt, ask -> (no interactive handler here) deny. This lets tests read
      // the guardian's effect straight off the receipt outcome + reason.
      const outcome = request.decision.outcome === 'allow' ? 'allow' : 'deny';
      const reason = request.decision.outcome === 'allow'
        ? undefined
        : request.decision.outcome === 'deny'
          ? request.decision.reason
          : 'Interactive approval is unavailable.';
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
        decisionId: 'test-decision',
        outcome,
        canonicalInput: request.decision.outcome === 'allow' && request.decision.canonicalInput
          ? request.decision.canonicalInput
          : request.canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(reason ? { reason } : {}),
        ...(request.decision.additionalContext ? { additionalContext: request.decision.additionalContext } : {}),
      }, request.subject);
    },
  };
}

function scriptedGuardian(verdict: GuardianRunResult) {
  const calls: Array<{ command?: string; mcpTool?: string }> = [];
  const port: GuardianJudgePort = {
    async judge(request) {
      calls.push({ command: request.input.action.command, mcpTool: request.input.action.mcpTool });
      return verdict;
    },
  };
  return { port, calls };
}

/**
 * A permission service that APPROVES every `ask` (mints an allow receipt),
 * mirroring a user clicking "allow" on a permission prompt. `allow`/`deny`
 * decisions are still honored verbatim. Lets the post-denial override wiring
 * observe a human approval host-side.
 */
function approvingPermissionService(): PiPermissionServicePort {
  return {
    async authorize(request) {
      const outcome = request.decision.outcome === 'deny' ? 'deny' : 'allow';
      const reason = request.decision.outcome === 'deny' ? request.decision.reason : undefined;
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
        decisionId: 'test-decision',
        outcome,
        canonicalInput: request.decision.outcome === 'allow' && request.decision.canonicalInput
          ? request.decision.canonicalInput
          : request.canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(reason ? { reason } : {}),
        ...(request.decision.additionalContext ? { additionalContext: request.decision.additionalContext } : {}),
      }, request.subject);
    },
  };
}

function createConfig(
  guardianJudgePort?: GuardianJudgePort,
  permissionServicePort: PiPermissionServicePort = testPermissionService(),
  // P2.21: the workspace's SHIFT+TAB cycle is this fork's "bypass permissions
  // available". Absent = route 1 reads `undefined` and fails, which D1.369 did
  // not change: that row put bypass in the DEFAULT cycle, and route 1 reads the
  // workspace's OWN array. Route 2 (the acknowledgment) is the other door.
  // Typed as raw strings, not `PermissionMode[]`: the field is persisted on disk
  // and legacy spellings (`allow-all`, `ask`, `safe`) are permanent read-path
  // aliases, so a test must be able to write one.
  workspaceCyclableModes?: readonly string[],
): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
      ...(workspaceCyclableModes
        ? {
            config: {
              id: 'ws-test',
              name: 'Test Workspace',
              defaults: { cyclablePermissionModes: [...workspaceCyclableModes] },
            },
          }
        : {}),
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort,
    ...(guardianJudgePort ? { guardianJudgePort } : {}),
    contextProfile: 'bare',
  };
}

function installManifest(
  agent: PiAgent,
  toolName: string,
  // PiAgent CLEARS manifest authority on every setCapabilityTurnRuntime, so a
  // test that needs extra runtime state must supply it here rather than call the
  // setter afterwards.
  runtimeExtras: Partial<CapabilityTurnRuntime> = {},
): Record<string, unknown> {
  const generation = 'test-generation';
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'ws-test', sessionId: 'session-test' },
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
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === toolName);
  if (!tool) throw new Error(`missing test tool ${toolName}`);
  const runtime = {
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
    ...runtimeExtras,
  } as unknown as CapabilityTurnRuntime;
  agent.setCapabilityTurnRuntime(runtime);
  (agent as any).activeExecutionManifest = manifest;
  return {
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
  };
}

/** A borderline auto-mode Bash action: a network command reaches the ask band. */
const BORDERLINE = { toolName: 'Bash', input: { command: 'curl https://example.com/data.json' } };

async function runBorderline(
  mode: PermissionMode,
  guardianJudgePort: GuardianJudgePort | undefined,
  request: { toolName: string; input: Record<string, unknown> } = BORDERLINE,
  options: {
    /** Runtime extras for the pinned capability runtime (e.g. `autoModeUnavailable`). */
    runtimeExtras?: Partial<CapabilityTurnRuntime>;
    /** The workspace SHIFT+TAB cycle — see `createConfig`. */
    workspaceCyclableModes?: readonly string[];
  } = {},
): Promise<{ response: Record<string, unknown> }> {
  const agent = new PiAgent(createConfig(guardianJudgePort, testPermissionService(), options.workspaceCyclableModes));
  agent.setPermissionMode(mode);
  const sent: Array<Record<string, unknown>> = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
  (agent as any).setCurrentTurnUserMessage('please fetch the data file');
  const identity = installManifest(agent, request.toolName, options.runtimeExtras ?? {});
  await (agent as any).handlePreToolUseRequest({ requestId: 'req-1', ...identity, ...request });
  agent.destroy();
  return { response: sent.at(-1) ?? {} };
}

describe('PiAgent guardian consult — action construction (representative-action matrix)', () => {
  it('maps an MCP mutation tool to an mcpTool judge action (dotted name, params minus internal keys)', () => {
    // The mode-gate proves an MCP mutation reaches the auto/allow-all risky band;
    // this pins the host half — buildGuardianAction turns the SDK tool name +
    // input into the judge's MCP action shape (never a shell command), dropping
    // the internal `_intent`/`_displayName` keys the renderer threads through.
    const agent = new PiAgent(createConfig());
    const action = (agent as any).buildGuardianAction(
      'mcp__linear__createIssue',
      { title: 'Bug', _intent: 'file a bug', _displayName: 'Create Issue' },
      '/repo',
    );
    agent.destroy();
    expect(action).toEqual({ mcpTool: 'linear.createIssue', mcpParams: { title: 'Bug' }, cwd: '/repo' });
    expect(action.command).toBeUndefined();
  });

  it('maps a Bash tool to a command judge action', () => {
    const agent = new PiAgent(createConfig());
    const action = (agent as any).buildGuardianAction('Bash', { command: 'rm -rf build' }, '/repo');
    agent.destroy();
    expect(action).toEqual({ command: 'rm -rf build', cwd: '/repo' });
    expect(action.mcpTool).toBeUndefined();
  });
});

describe('PiAgent guardian consult — auto mode borderline band', () => {
  it('no_objection => the action runs (allow receipt), audited via the receipt', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'user-requested fetch' });
    const { response } = await runBorderline('auto', port);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('curl https://example.com/data.json');
    expect(response).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'allow',
      receipt: { outcome: 'allow', decisionId: 'test-decision' },
    });
  });

  it('deny => the action is blocked with the guardian category+reason diagnostic', async () => {
    const { port } = scriptedGuardian({ verdict: 'deny', category: 'data_exfiltration', reason: 'sends data off-box' });
    const { response } = await runBorderline('auto', port);
    expect(response.action).toBe('block');
    expect(response.receipt).toMatchObject({ outcome: 'deny' });
    expect(String(response.reason)).toContain('data_exfiltration');
    expect(String(response.reason)).toContain('sends data off-box');
  });

  it('unsure => today\'s ask flow (here: no interactive handler => deny with the ask message)', async () => {
    const { port } = scriptedGuardian({ verdict: 'unsure', reason: 'cannot decide' });
    const { response } = await runBorderline('auto', port);
    // The borderline band still resolves through the ASK decision — the guardian
    // did not convert it to allow or a guardian-authored block.
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('judge unavailable (no port) => identical to today: the band asks', async () => {
    const { response } = await runBorderline('auto', undefined);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });
});

describe('PiAgent auto mode self-downgrade (permission-modes.md: 3 in a row or 20 total)', () => {
  // "If the classifier blocks an action 3 times in a row or 20 times total,
  // auto mode pauses and Claude Code resumes prompting." The pause is a drop
  // to the manual mode, announced in the block reason the model reads.
  // Distinct commands per call: an identical action would hit the guardian's
  // verdict cache, and only FRESH classifier blocks count toward the pause
  // (a model re-issuing one denied action feeds the per-turn circuit instead).
  async function runOnce(agent: PiAgent, requestId: string, command: string): Promise<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('please fetch the data file');
    const identity = installManifest(agent, BORDERLINE.toolName);
    await (agent as any).handlePreToolUseRequest({
      requestId, ...identity, toolName: 'Bash', input: { command },
    });
    return sent.at(-1) ?? {};
  }

  it('three consecutive fresh classifier blocks pause auto and announce it', async () => {
    const { port } = scriptedGuardian({ verdict: 'deny', category: 'data_exfiltration', reason: 'no' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    try {
      await runOnce(agent, 'block-1', 'curl https://example.com/a.json');
      expect(agent.getPermissionMode()).toBe('auto');
      await runOnce(agent, 'block-2', 'curl https://example.com/b.json');
      expect(agent.getPermissionMode()).toBe('auto');
      const third = await runOnce(agent, 'block-3', 'curl https://example.com/c.json');
      expect(agent.getPermissionMode()).toBe('default');
      expect(String(third.reason)).toContain('Auto mode paused');
    } finally {
      agent.destroy();
    }
  });

  it('a non-blocked consult resets the consecutive counter', async () => {
    const deny = scriptedGuardian({ verdict: 'deny', category: 'data_exfiltration', reason: 'no' });
    const allow = scriptedGuardian({ verdict: 'no_objection', reason: 'fine' });
    // Alternate the wired port through a mutable holder.
    let active = deny.port;
    const port: GuardianJudgePort = { judge: request => active.judge(request) };
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    try {
      await runOnce(agent, 'seq-1', 'curl https://example.com/1.json');
      await runOnce(agent, 'seq-2', 'curl https://example.com/2.json');
      active = allow.port;
      await runOnce(agent, 'seq-3', 'curl https://example.com/3.json'); // resets the run
      active = deny.port;
      await runOnce(agent, 'seq-4', 'curl https://example.com/4.json');
      await runOnce(agent, 'seq-5', 'curl https://example.com/5.json');
      expect(agent.getPermissionMode()).toBe('auto');
    } finally {
      agent.destroy();
    }
  });
});

describe('PiAgent guardian consult — auto mode: EVERY uncertainty tag downgrades to ask (R21)', () => {
  // The net may only narrow. In `auto` the deterministic gate would have
  // PROMPTED, so a `no_objection` means only "that prompt is not required";
  // every uncertain outcome must still reach a human, never resolve to allow.
  // `unsure` and the missing-port `disabled` tag are covered above; these are
  // the two remaining `GuardianAskReason` values reachable with a wired port.
  const uncertain: Array<{ tag: 'failure' | 'circuit-open'; verdict: GuardianRunResult; runs: number }> = [
    // The runner's contract turns any timeout/malformed output into an
    // `unsure` verdict carrying a `failure` tag.
    { tag: 'failure', verdict: { verdict: 'unsure', failure: 'timeout', reason: 'judge timed out' }, runs: 1 },
    // 3 consecutive denies trip the per-turn breaker; the 4th consult of the
    // same action finds the circuit open and falls back to asking.
    { tag: 'circuit-open', verdict: { verdict: 'deny', category: 'destructive_action', reason: 'no' }, runs: 4 },
  ];

  for (const { tag, verdict, runs } of uncertain) {
    it(`${tag}: the borderline action still reaches the human ask flow, never allow`, async () => {
      const { port, calls } = scriptedGuardian(verdict);
      const agent = new PiAgent(createConfig(port));
      agent.setPermissionMode('auto');
      const sent: Array<Record<string, unknown>> = [];
      (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
      (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
      (agent as any).setCurrentTurnUserMessage('please fetch the data file');
      const identity = installManifest(agent, 'Bash');
      for (let attempt = 0; attempt < runs; attempt += 1) {
        await (agent as any).handlePreToolUseRequest({ requestId: `r${attempt}`, ...identity, ...BORDERLINE });
      }
      agent.destroy();

      // The band WAS consulted (this is not the zero-call fast path)…
      expect(calls.length).toBeGreaterThan(0);
      // …and the final outcome is the pre-guardian ask, which this permission
      // service resolves to a deny because it has no interactive handler. The
      // guardian never authored an allow.
      expect(sent.at(-1)).toMatchObject({ action: 'block' });
      expect(String(sent.at(-1)?.reason)).toBe('Interactive approval is unavailable.');
    });
  }
});

describe('PiAgent guardian consult — a non-negotiable prompt is never consulted (floors)', () => {
  // The consult gate skips prompts where `promptIsNonNegotiable(checkResult)`:
  // those go to the human, period. Without the check, in `auto` the judge could
  // convert ANY non-negotiable prompt into an allow.
  //
  // ONE exemption since P2.3 (owner decision 2026-08-22): the S4 removal circuit
  // breaker, in `auto` only, where the gate marks it `autoClassifierAdjudicated`
  // — `2026-w30.md:84`, "the checks for dangerous `rm` commands … no longer open
  // permission dialogs; the auto-mode classifier adjudicates them instead". Every
  // other mode keeps permissions.md:63 verbatim ("Removals targeting the
  // filesystem root or home directory … prompt as a circuit breaker against model
  // error"), which is the pair below.
  const BREAKER = { toolName: 'Bash', input: { command: 'rm -rf ~' } };

  it('the removal circuit breaker is adjudicated by the judge in auto (P2.3)', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
    const { response } = await runBorderline('auto', port, BREAKER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('rm -rf ~');
    expect(response.action).toBe('allow');
  });

  it('the removal circuit breaker reaches the human in allow-all, judge or no judge', async () => {
    // `bypassPermissions` is NOT auto: its deny-net never sees a prompt, and the
    // breaker outranking allow-all is why that mode still stops here.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('bypassPermissions', port, BREAKER);
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('a protected-path floor is still never consulted in auto — the exemption is one class wide', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'looks fine to me' });
    const { response } = await runBorderline('auto', port, {
      toolName: 'Write',
      input: { file_path: '/tmp/project-root/.claude/settings.json', content: '{}' },
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('an ordinary borderline prompt in the same mode still consults the judge', async () => {
    // The boundary pair for the floor test above: same mode, same tool, one
    // judge; only the non-negotiable marker differs.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'user-requested fetch' });
    const { response } = await runBorderline('auto', port, BORDERLINE);
    expect(calls).toHaveLength(1);
    expect(response.action).toBe('allow');
  });
});

/**
 * R21 — plan mode's shell band. The sentence is the anchor; the number is a
 * convenience that has decayed twice (`permission-modes.md:240` on the
 * 2026-08-23 fetch, where this header used to say `:156` — a UI-label table row
 * on that same fetch):
 *
 *   "When auto mode is available and the `useAutoModeDuringPlan` setting is on,
 *   which it is by default, the classifier reviews shell commands during
 *   planning instead of prompting you. Approved commands run, and rejected ones
 *   are blocked. Otherwise, commands outside the built-in read-only set prompt
 *   for approval, including when the sandbox's auto-allow mode is enabled."
 *
 * That is not the whole of `:240`: the same line carves bypass-available
 * sessions out of BOTH branches, which is why this fork is stricter than the
 * page there rather than exempt. The quote and the deviation are on the
 * acknowledged-install row far below.
 *
 * Before this, plan mode BLOCKED a non-read-only command outright: neither
 * branch of that sentence existed, and `useAutoModeDuringPlan` had zero
 * occurrences under any name.
 */
describe('PiAgent guardian consult — plan mode routes shell commands to the classifier', () => {
  afterEach(() => { guardianSettings.useAutoModeDuringPlan = true; });

  it('no_objection => the command runs', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'read-only exploration' });
    const { response } = await runBorderline('plan', port);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('curl https://example.com/data.json');
    expect(response).toMatchObject({ action: 'allow', receipt: { outcome: 'allow' } });
  });

  it('deny => the command is blocked with the guardian diagnostic', async () => {
    const { port } = scriptedGuardian({ verdict: 'deny', category: 'data_exfiltration', reason: 'sends data off-box' });
    const { response } = await runBorderline('plan', port);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toContain('data_exfiltration');
  });

  it('the setting off => it prompts instead, and the judge is never asked', async () => {
    guardianSettings.useAutoModeDuringPlan = false;
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure' });
    const { response } = await runBorderline('plan', port);
    expect(calls).toHaveLength(0);
    // The "Otherwise" branch is a PROMPT, not the old outright block: this
    // permission service has no interactive handler, so the ask settles here.
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('auto mode unavailable to the org => it prompts instead', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('plan');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('please fetch the data file');
    const identity = installManifest(agent, 'Bash', { autoModeUnavailable: true });
    await (agent as any).handlePreToolUseRequest({ requestId: 'req-1', ...identity, ...BORDERLINE });
    agent.destroy();
    expect(calls).toHaveLength(0);
    expect(String(sent.at(-1)?.reason)).toBe('Interactive approval is unavailable.');
  });

  it('a read-only call is unaffected — it runs without a consult', async () => {
    // The read-only side of the band. (`shouldAllowToolInMode` decides which
    // SHELL commands are read-only against the loaded allowlist, which this
    // harness does not load; mode-manager-plan-shell-review.test.ts covers that
    // half against a real allowlist.)
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'no' });
    const { response } = await runBorderline('plan', port, {
      toolName: 'Read',
      input: { file_path: '/repo/src/a.ts' },
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('allow');
  });

  it('a floor other than the removal breaker still reaches the human — the judge is never asked', async () => {
    // 8c2990ad's rule holds in plan mode exactly as it does in auto: a
    // non-negotiable prompt is never consulted, whatever the judge would say.
    // The ONE exemption (P2.21, the `:577` row) is the removal circuit breaker,
    // and it is covered by its own describe below.
    //
    // The witness is the `requiresUserInteraction` floor, NOT a protected-path
    // write: in plan the mode gate refuses `Write` BEFORE any floor is computed,
    // so a protected-path row here would settle on the mode block and pass even
    // if the floor had been exempted (measured — that precedence is pinned as
    // its own row in the P2.21 describe below).
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'looks fine to me' });
    const { response } = await runBorderline('plan', port, {
      toolName: 'ask_user',
      input: { question: 'which branch?' },
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('a file edit is still blocked outright — the route is about shell commands only', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'go ahead' });
    const { response } = await runBorderline('plan', port, {
      toolName: 'Write',
      input: { file_path: '/repo/src/a.ts', content: 'x' },
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).not.toBe('Interactive approval is unavailable.');
  });
});

/**
 * P2.21 — plan mode's critical-path removal row (OQ-1, owner said ALIGN on
 * 2026-08-23). `permission-modes.md:577`, the `plan` row of the `:574-580`
 * per-mode table, re-fetched 2026-08-23, verbatim:
 *
 *   "| `plan`                   | Asks you to approve it. With [auto mode
 *   available during planning](#analyze-before-you-edit-with-plan-mode) and no
 *   bypass permissions available, sends it to the classifier instead |"
 *
 * Before this the plan branch refused EVERY non-negotiable prompt, so a
 * critical-path removal asked even with `useAutoModeDuringPlan` on and no
 * bypass — measured by P2.3's reviewer (judgeCalls=0). The exemption seam is
 * P2.3's `autoClassifierAdjudicated` marker, widened by exactly one
 * mode-predicate; the mapping is auto's, unchanged: `no_objection` allows,
 * `deny` blocks, and EVERY other outcome lands on the breaker's own prompt.
 *
 * The prompt rows below settle as `block` with "Interactive approval is
 * unavailable." because this harness's permission service has no interactive
 * handler — that string IS the human prompt in this suite (same convention as
 * the auto rows above).
 */
describe('PiAgent guardian consult — plan mode sends a critical-path removal to the classifier (P2.21)', () => {
  const BREAKER = { toolName: 'Bash', input: { command: 'rm -rf ~' } };
  const ASK = 'Interactive approval is unavailable.';
  afterEach(() => {
    guardianSettings.useAutoModeDuringPlan = true;
    guardianSettings.enabled = true;
    guardianSettings.bypassAcknowledged = false;
  });

  it('no_objection => the removal runs, exactly as the `auto` row does', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('rm -rf ~');
    expect(response).toMatchObject({ action: 'allow', receipt: { outcome: 'allow' } });
  });

  it('deny => the removal is blocked with the guardian category+reason diagnostic', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'wipes the home directory' });
    const { response } = await runBorderline('plan', port, BREAKER);
    expect(calls).toHaveLength(1);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toContain('destructive_action');
    expect(String(response.reason)).toContain('wipes the home directory');
  });

  // The fail-closed half of the mapping: the judge was consulted and every
  // outcome that is not `no_objection`/`deny` lands on the breaker's own
  // unconditional prompt. One row per reachable `GuardianAskReason` source.
  const failClosed: Array<{ name: string; verdict: GuardianRunResult }> = [
    { name: 'unsure', verdict: { verdict: 'unsure', reason: 'cannot decide' } },
    { name: 'transport error', verdict: { verdict: 'unsure', failure: 'spawn-error', reason: 'judge port failed' } },
    { name: 'timeout', verdict: { verdict: 'unsure', failure: 'timeout', reason: 'judge timed out' } },
    { name: 'malformed verdict', verdict: { verdict: 'unsure', failure: 'malformed', reason: 'judge returned junk' } },
  ];
  for (const { name, verdict } of failClosed) {
    it(`${name} => the removal still reaches the human, never allow`, async () => {
      const { port, calls } = scriptedGuardian(verdict);
      const { response } = await runBorderline('plan', port, BREAKER);
      expect(calls).toHaveLength(1);
      expect(response.action).toBe('block');
      expect(String(response.reason)).toBe(ASK);
    });
  }

  it('no port => the removal prompts, exactly as before P2.21', async () => {
    const { response } = await runBorderline('plan', undefined, BREAKER);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('the guardian setting off => the judge is never asked and the removal prompts', async () => {
    guardianSettings.enabled = false;
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER);
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('circuit OPEN => the removal falls back to the human prompt', async () => {
    // 3 consecutive denies trip the per-turn breaker; the 4th consult of the
    // same action finds the circuit open and falls back to asking.
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'no' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('plan');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('clean up the machine');
    const identity = installManifest(agent, 'Bash');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await (agent as any).handlePreToolUseRequest({ requestId: `r${attempt}`, ...identity, ...BREAKER });
    }
    agent.destroy();
    expect(calls.length).toBeGreaterThan(0);
    expect(sent.at(-1)).toMatchObject({ action: 'block' });
    expect(String(sent.at(-1)?.reason)).toBe(ASK);
  });

  // ---- the ineligible plan states: unchanged behavior --------------------

  it('the setting off => the judge is never asked about the removal', async () => {
    guardianSettings.useAutoModeDuringPlan = false;
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER);
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('auto mode unavailable to the org => the judge is never asked about the removal', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER, {
      runtimeExtras: { autoModeUnavailable: true },
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('bypass permissions AVAILABLE to the session => the page\'s precondition fails and it asks', async () => {
    // The `:577` row routes to the classifier only "with auto mode available
    // during planning and NO bypass permissions available". This fork's
    // equivalent of Claude's launch-time enable is the workspace SHIFT+TAB
    // cycle naming `bypassPermissions` (mode-types.ts).
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER, {
      workspaceCyclableModes: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('a LEGACY spelling of bypass in the cycle fails the precondition too — `allow-all` is not a stranger', async () => {
    // The cycle is persisted on disk, and `mode-types.ts` keeps `allow-all` (and
    // `execute`, and case/separator variants) as PERMANENT read-path aliases for
    // `bypassPermissions`. A raw `cyclable.includes('bypassPermissions')` reads
    // this session as "no bypass available" and consults the judge about `rm -rf
    // ~` — fail-OPEN. The predicate therefore parses each entry.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER, {
      workspaceCyclableModes: ['safe', 'plan', 'ask', 'acceptEdits', 'auto', 'allow-all'],
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('a cycle WITHOUT bypass and NO acknowledgment is the eligible state — the same session consults', async () => {
    // The boundary pair for the row above: identical request, identical judge,
    // only the workspace cycle differs. Row 3 of P2.50's truth table — the ONLY
    // combination that still reaches the classifier once OQ-3 widened the
    // predicate, so this row is what proves the widening did not swallow the
    // whole route.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER, {
      workspaceCyclableModes: ['plan', 'default', 'acceptEdits', 'auto'],
    });
    expect(guardianSettings.bypassAcknowledged).toBe(false);
    expect(calls).toHaveLength(1);
    expect(response.action).toBe('allow');
  });

  // ---- P2.50: availability counts BOTH routes (OQ-3, owner 2026-08-23) ----
  //
  // The owner resolved OQ-3 STRICTER: "bypass permissions available" is the
  // workspace cycle naming `bypassPermissions` OR the install-wide
  // `bypassPermissionsAcknowledged`. After the one-time responsibility dialog
  // bypass is one click away in EVERY session on the install — the mode picker
  // never filters it — so an acknowledged user's plan session must ASK, which is
  // what `:577` says for sessions where bypass is available. Accepted cost,
  // stated on the predicate: such a user loses P2.21's classifier route
  // permanently.

  it('an ACKNOWLEDGED install fails the precondition even with a cycle that omits bypass', async () => {
    // Row 2 of the truth table, and the reason P2.50 exists: byte-for-byte the
    // eligible row above — same cycle, same judge, same command — with only the
    // install-wide acknowledgment flipped on. Before P2.50 this consulted the
    // judge and allowed `rm -rf ~`.
    guardianSettings.bypassAcknowledged = true;
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER, {
      workspaceCyclableModes: ['plan', 'default', 'acceptEdits', 'auto'],
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('an ACKNOWLEDGED install with NO workspace cycle configured at all also asks', async () => {
    // The default-cycle spelling of the row above: `cyclablePermissionModes` is
    // absent entirely, so route 1 reads `undefined` and only route 2 can fire.
    // Pinned separately because the absent-array branch returns before the
    // `.some()` in the old predicate, and an OR bolted on after that early
    // `return false` would leave exactly this shape broken.
    guardianSettings.bypassAcknowledged = true;
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER);
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('BOTH routes true => it asks, and asking is not doubled or weakened', async () => {
    // Row 4: the cycle names bypass AND the install is acknowledged. An OR that
    // was written as an XOR, or a second read that overwrote the first, would
    // show up here as a consult.
    guardianSettings.bypassAcknowledged = true;
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, wipe it' });
    const { response } = await runBorderline('plan', port, BREAKER, {
      workspaceCyclableModes: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });

  it('an ACKNOWLEDGED install still consults on plan\'s ordinary shell band — STRICTER than the page, which would just run it', async () => {
    // The boundary that keeps P2.50 one row wide, and a DELIBERATE deviation —
    // in the safe direction. This row's reason used to read "the shell band at
    // `:156` carries no such clause", which is wrong twice over. The band's
    // sentence is at `:240` on the 2026-08-23 fetch (`:156` there is a UI-label
    // table row), and `:240` does not stop where that quote stopped — two
    // sentences later, on the SAME line: "In sessions with bypass permissions
    // available, neither the classifier nor a prompt applies to planning
    // commands; [Skip all checks with bypassPermissions
    // mode](#skip-all-checks-with-bypasspermissions-mode) covers the few things
    // that still prompt there." Nor is the precondition the `:577` row's private
    // clause: the same fetch carries it on `:28`, `:238`, `:240`, `:494`, `:499`
    // and `:577` — page-wide.
    //
    // So the page would let this command RUN, unclassified and unprompted, in an
    // acknowledged session. We send it to a judge that can DENY it, which is
    // stricter, and teaching the band `bypassPermissionsAvailable()` would
    // LOOSEN it toward the page — the opposite direction from OQ-3. The
    // predicate therefore stays read on the floor branch of
    // `planClassifierEligible` and nowhere else, and what this row pins is that
    // widening: judge still consulted, ordinary plan-mode review intact.
    guardianSettings.bypassAcknowledged = true;
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'read-only exploration' });
    const { response } = await runBorderline('plan', port);
    expect(calls).toHaveLength(1);
    expect(response.action).toBe('allow');
  });

  // ---- the exemption is ONE class wide, in plan as in auto ---------------

  it('a protected-path write never reaches a floor prompt in plan — the mode gate blocks writes first', async () => {
    // Measured, not assumed (the response reason was printed): in plan a `Write`
    // is refused by the MODE gate — "File modifications are blocked … Effective
    // mode: Plan" — and that return precedes the protected-path floor entirely,
    // so `checkResult.type` is never `prompt` and `planClassifierEligible` is
    // never evaluated. A row claiming "the protected-path floor is still refused
    // in plan" would therefore be VACUOUS: it passes whether or not the floor is
    // exempted. The floor class is carried by the `requiresUserInteraction` row
    // below, which does reach a prompt, and by the gate-level row in
    // `core/__tests__/pre-tool-use-checks.isolated.ts`, which pins the marker's
    // absence on every other class directly.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'looks fine to me' });
    const { response } = await runBorderline('plan', port, {
      toolName: 'Write',
      input: { file_path: '/tmp/project-root/.claude/settings.json', content: '{}' },
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toContain('File modifications are blocked');
    expect(String(response.reason)).toContain('Effective mode: Plan');
    expect(String(response.reason)).not.toBe(ASK);
  });

  it('a requiresUserInteraction floor in the same eligible plan session is still never consulted', async () => {
    // THE floor witness for plan: the one non-negotiable class this harness can
    // drive to an actual PROMPT here, which is what makes the assertion below
    // mean "the consult was refused" rather than "the mode gate got there
    // first". (The R2 `worktreeApproval` floor cannot be driven here:
    // `EnterWorktree` carries no entry in `PI_STATIC_MODEL_CONTRACT_HASHES`, so
    // `installManifest` has no static tool to hand the request — measured, not
    // assumed.)
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'go ahead' });
    const { response } = await runBorderline('plan', port, {
      toolName: 'ask_user',
      input: { question: 'which branch?' },
    });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe(ASK);
  });
});

describe('PiAgent guardian consult — never consults outside the classifier bands', () => {
  const cases: PermissionMode[] = ['default', 'acceptEdits']; // F1.1050: the explore arm left with the mode (plan HAS a band)
  for (const mode of cases) {
    it(`mode ${mode}: never spawns the judge`, async () => {
      const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
      await runBorderline(mode, port);
      expect(calls).toHaveLength(0);
    });
  }

  it('auto mode, LOW-risk command: never reaches the band, never consults', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
    // A plain read-only command auto-runs in auto mode without prompting, so the
    // guardian is never consulted (no latency on the fast path).
    const { response } = await runBorderline('auto', port, { toolName: 'Bash', input: { command: 'ls -la' } });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('allow');
  });
});

describe('PiAgent guardian consult — cache', () => {
  it('a repeated identical borderline action hits the cache (one judge call)', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'ok' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('fetch it');
    const identity = installManifest(agent, 'Bash');
    const req = { requestId: 'r', ...identity, ...BORDERLINE };
    await (agent as any).handlePreToolUseRequest(req);
    await (agent as any).handlePreToolUseRequest({ ...req, requestId: 'r2' });
    agent.destroy();
    expect(calls).toHaveLength(1);
  });
});

describe('PiAgent guardian consult — verdict binds to the EXECUTED input (TOCTOU)', () => {
  it('a PreToolUse hook rewrite reaches the judge; the judge sees the UPDATED command', async () => {
    // A hook rewrites the borderline command via updatedInput on `ask`. The
    // executed input is the rewritten command, so the guardian MUST judge that
    // exact command — never the original the model proposed.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'ok' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    // Hook: ask + updatedInput rewrites the command AFTER the gate classified it.
    (agent as any).emitAutomationEvent = async () => ({
      matchedCount: 1,
      decision: { decision: 'ask', updatedInput: { command: 'curl https://example.com/REWRITTEN.json' } },
    });
    (agent as any).setCurrentTurnUserMessage('please fetch the data file');
    const identity = installManifest(agent, 'Bash');
    await (agent as any).handlePreToolUseRequest({ requestId: 'req-1', ...identity, ...BORDERLINE });
    agent.destroy();

    expect(calls).toHaveLength(1);
    // The judge saw the REWRITTEN command, not the original one.
    expect(calls[0]!.command).toBe('curl https://example.com/REWRITTEN.json');
    expect(calls[0]!.command).not.toBe('curl https://example.com/data.json');
  });

  it('original vs hook-rewritten forms are DISTINCT cache keys (no cross-hit)', async () => {
    // First turn: no hook, judge the ORIGINAL. Second turn: a hook rewrites the
    // command, judge the REWRITTEN. The two forms must not collide in the cache,
    // so both consults spawn the judge.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'ok' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    let rewrite = false;
    (agent as any).emitAutomationEvent = async () => (rewrite
      ? { matchedCount: 1, decision: { decision: 'ask', updatedInput: { command: 'curl https://example.com/OTHER.json' } } }
      : { matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('fetch it');
    const identity = installManifest(agent, 'Bash');
    await (agent as any).handlePreToolUseRequest({ requestId: 'orig', ...identity, ...BORDERLINE });
    rewrite = true;
    await (agent as any).handlePreToolUseRequest({ requestId: 'rewritten', ...identity, ...BORDERLINE });
    agent.destroy();

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe('curl https://example.com/data.json');
    expect(calls[1]!.command).toBe('curl https://example.com/OTHER.json');
  });
});

describe('PiAgent guardian consult — audit provenance', () => {
  it('a guardian-approved allow carries a distinguishable receipt marker', async () => {
    const { port } = scriptedGuardian({ verdict: 'no_objection', category: 'destructive_action', reason: 'user-requested fetch' });
    const { response } = await runBorderline('auto', port);
    expect(response.action).toBe('allow');
    // The receipt is distinguishable from a plain rule-allow by the marker.
    expect(String((response.receipt as any)?.additionalContext ?? '')).toContain('guardian-approved');
    expect(String((response.receipt as any)?.additionalContext ?? '')).toContain('destructive_action');
    // The additionalContext is also echoed on the response envelope.
    expect(String(response.additionalContext ?? '')).toContain('guardian-approved');
  });

  it('a plain rule-allow (low-risk, never consulted) carries NO guardian marker', async () => {
    const { port } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
    const { response } = await runBorderline('auto', port, { toolName: 'Bash', input: { command: 'ls -la' } });
    expect(response.action).toBe('allow');
    expect((response.receipt as any)?.additionalContext).toBeUndefined();
    expect(response.additionalContext).toBeUndefined();
  });
});

describe('PiAgent guardian consult — scoped MCP read policy', () => {
  it('keeps pinned source read rules out of Ask, Auto, and the allow-all deny-net', async () => {
    guardianSettings.enabled = true;
    const { port, calls } = scriptedGuardian({
      verdict: 'deny',
      category: 'destructive_action',
      reason: 'must not be consulted',
    });
    const agent = new PiAgent(createConfig(port));

    try {
      const permissionManager = (agent as any).permissionManager;
      permissionManager.setCapabilityPermissionLayers([{
        sourceSlug: 'dpGitlab',
        content: JSON.stringify({ allowedMcpPatterns: ['dp_gitlab_repos'] }),
      }], 'scoped-mcp-policy');
      const permissionsContext = permissionManager.getCapabilityPermissionsContext();
      if (!permissionsContext) throw new Error('missing pinned permissions context');

      const readTool = 'mcp__dpGitlab__dp_gitlab_repos';
      const mutationTool = 'mcp__dpGitlab__dp_gitlab_merge-request';

      expect(shouldPromptInAskMode(readTool, {}, permissionManager, permissionsContext)).toBeNull();
      expect(shouldPromptInAutoMode(readTool, {}, permissionManager, permissionsContext)).toBeNull();
      expect(shouldPromptInAskMode(mutationTool, {}, permissionManager, permissionsContext)?.promptType)
        .toBe('mcp_mutation');
      expect(shouldPromptInAutoMode(mutationTool, {}, permissionManager, permissionsContext)?.promptType)
        .toBe('mcp_mutation');

      const guardian = (agent as any).guardianConsultState();
      const result = await (agent as any).consultGuardianDenyNet(
        { type: 'allow' },
        {
          toolName: readTool,
          input: {},
          cwd: '/tmp/project-root',
          permissionsContext,
          guardian,
          modeVersion: 1,
        },
      );

      expect(result).toEqual({ type: 'allow' });
      expect(calls).toHaveLength(0);
    } finally {
      agent.destroy();
    }
  });
});

describe('PiAgent guardian consult — the autoMode sets cannot clear a deterministic deny (R21)', () => {
  const ORG_ALLOW = 'curl is fine, our egress proxy audits it';
  const orgRuntime = () => ({
    managedAutoMode: resolveAutoMode({ managed: { allow: [ORG_ALLOW] } }),
  });
  const denyCurl = (agent: PiAgent) => (agent as any).permissionManager.setCapabilityPermissionLayers(
    [],
    'deny-floor-generation',
    true,
    parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'deny-curl', action: 'deny', match: { kind: 'bash', executable: 'curl' } }],
    }),
  );

  function orgPolicyAgent(port: GuardianJudgePort) {
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('fetch the data file');
    return { agent, sent };
  }

  it('a managed deny rule outranks the judge, even when the judge clears the action', async () => {
    // `hard_deny` INSIDE the classifier is not the same thing as a deny rule
    // BEFORE it. The org's own prose allow entry reaches the judge, the judge
    // returns no_objection, and the managed deny rule still wins at authorize
    // time — the receipt is a deny. Nothing in autoMode can reopen the floor.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the org says curl is fine' });
    const { agent, sent } = orgPolicyAgent(port);
    denyCurl(agent);
    const identity = installManifest(agent, 'Bash', orgRuntime());
    await (agent as any).handlePreToolUseRequest({ requestId: 'denied', ...identity, ...BORDERLINE });
    agent.destroy();

    expect(calls).toHaveLength(1); // the judge DID clear it…
    expect(sent.at(-1)).toMatchObject({ action: 'block' }); // …and it is still blocked.
    expect(sent.at(-1)?.receipt).toMatchObject({ outcome: 'deny' });
  });

  it('a tool-level deny never reaches the judge at all', async () => {
    // The other deny shape: a gate `block` is neither of the guardian's two
    // eligible result types, so this one costs zero judge calls.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'must not be consulted' });
    const { agent, sent } = orgPolicyAgent(port);
    (agent as any).permissionManager.setCapabilityPermissionLayers(
      [{ sourceSlug: 'org', content: JSON.stringify({ deniedToolPatterns: ['Bash'] }) }],
      'tool-deny-generation',
      true,
    );
    const identity = installManifest(agent, 'Bash', orgRuntime());
    await (agent as any).handlePreToolUseRequest({ requestId: 'tool-denied', ...identity, ...BORDERLINE });
    agent.destroy();

    expect(calls).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ action: 'block' });
  });

  it('hands the org policy to the judge for an action the gate did NOT deny', async () => {
    // Proves the two tests above are about precedence, not about the wiring
    // being absent: with nothing in the way, the same prose reaches the judge.
    const seen: Array<string | undefined> = [];
    const port: GuardianJudgePort = {
      async judge(request) {
        seen.push(request.input.orgPolicy?.allow.join('|'));
        return { verdict: 'no_objection', reason: 'ok' };
      },
    };
    const { agent, sent } = orgPolicyAgent(port);
    const identity = installManifest(agent, 'Bash', orgRuntime());
    await (agent as any).handlePreToolUseRequest({ requestId: 'judged', ...identity, ...BORDERLINE });
    agent.destroy();

    expect(seen).toEqual([ORG_ALLOW]);
    expect(sent.at(-1)).toMatchObject({ action: 'allow' });
  });

  it('omits the policy section entirely when the admin declared no autoMode', async () => {
    // The usual case today. `orgPolicy` stays undefined rather than an empty
    // shell, so the judge task is byte-identical to the pre-R21 shape.
    const seen: Array<unknown> = [];
    const port: GuardianJudgePort = {
      async judge(request) {
        seen.push(request.input.orgPolicy);
        return { verdict: 'no_objection', reason: 'ok' };
      },
    };
    const { agent } = orgPolicyAgent(port);
    const identity = installManifest(agent, 'Bash');
    await (agent as any).handlePreToolUseRequest({ requestId: 'no-policy', ...identity, ...BORDERLINE });
    agent.destroy();

    expect(seen).toEqual([undefined]);
  });
});

describe('the built-in rule lists are what "$defaults" splices (f121)', () => {
  const D = GUARDIAN_BUILT_IN_AUTO_MODE_DEFAULTS;

  it('splices the built-ins at the sentinel, replaces on its absence, and keeps an empty list distinct', () => {
    // `auto-mode-config.md:182`: "The default rules are spliced in at that
    // position, so your custom rules can go before or after them". The splice
    // primitive was already right; before f121 the OPERAND was `[]`, so a
    // managed `['$defaults', 'x']` and a managed `['x']` produced a
    // byte-identical judge task.
    const CUSTOM = 'Never run database migrations outside the migrations CLI';
    const spliced = resolveAutoMode({ managed: { soft_deny: [CUSTOM, '$defaults'] } }, D);
    expect(spliced.soft_deny).toEqual([CUSTOM, ...D.soft_deny]);
    // `:218` — the other three sections are untouched and inherit whole.
    expect(spliced.hard_deny).toEqual([...D.hard_deny]);
    expect(spliced.environment).toEqual([...D.environment]);
    expect(spliced.allow).toEqual([...D.allow]);

    // `:212` Danger — no sentinel REPLACES that section, and only that section.
    const owned = resolveAutoMode({ managed: { soft_deny: [CUSTOM] } }, D);
    expect(owned.soft_deny).toEqual([CUSTOM]);
    expect(owned.hard_deny).toEqual([...D.hard_deny]);

    // An empty array is a clean slate; an ABSENT key is the defaults. The two
    // must stay distinguishable, or an administrator has no way to ask for one.
    expect(resolveAutoMode({ managed: { soft_deny: [] } }, D).soft_deny).toEqual([]);
    expect(resolveAutoMode({ managed: {} }, D).soft_deny).toEqual([...D.soft_deny]);
  });

  it('parses as managed policy prose, so the documented copy-back works', () => {
    // `:220`: "run `claude auto-mode defaults` to print the built-in rules, copy
    // them into your settings file". An entry we ship that our own parser refuses
    // would make that instruction fail on the paste.
    expect(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      autoMode: {
        environment: [...D.environment],
        hard_deny: [...D.hard_deny],
        soft_deny: [...D.soft_deny],
        allow: [...D.allow],
      },
    })).not.toThrow();
  });
});

describe('PiAgent guardian consult — a command that leaves the sandbox is judged (R21)', () => {
  // P10 landed `excludedCommands` as an admin escape hatch from ISOLATION. It
  // was never an escape hatch from PERMISSION, but in `auto` it became one by
  // accident: `docker ps` is low-risk, so the auto classifier silently dropped
  // its prompt, and the exclusion then dropped the sandbox too — no prompt, no
  // judge, no isolation. Claude's documented behaviour at that boundary is that
  // the classifier evaluates the underlying command instead of prompting, so an
  // unsandboxed-bound command now enters the risky band.
  const EXCLUDED = { toolName: 'Bash', input: { command: 'docker ps' } };
  const sandboxed = { unsandboxedCommandPatterns: ['docker *'] as readonly string[] };

  async function run(
    guardianJudgePort: GuardianJudgePort | undefined,
    request = EXCLUDED,
    runtimeExtras: Partial<CapabilityTurnRuntime> = sandboxed,
  ) {
    const agent = new PiAgent(createConfig(guardianJudgePort));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('check the containers');
    const identity = installManifest(agent, request.toolName, runtimeExtras);
    await (agent as any).handlePreToolUseRequest({ requestId: 'req-1', ...identity, ...request });
    agent.destroy();
    return sent.at(-1) ?? {};
  }

  it('consults the judge rather than running it blind, and runs on no_objection', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'read-only container listing' });
    const response = await run(port);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('docker ps');
    expect(response.action).toBe('allow');
  });

  it('refuses the command when the judge denies', async () => {
    const { port } = scriptedGuardian({ verdict: 'deny', category: 'persistent_security_weakening', reason: 'escapes isolation' });
    const response = await run(port);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toContain('escapes isolation');
  });

  it('falls back to a human, not to a silent run, when no judge is wired', async () => {
    // The pre-guardian behaviour for this band. Narrowing, and the honest
    // fallback: leaving the sandbox is not something to decide by default.
    const response = await run(undefined);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('leaves a command that matches no exclusion on the zero-judge-call fast path', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', reason: 'must not be consulted' });
    const response = await run(port, { toolName: 'Bash', input: { command: 'ls -la' } });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('allow');
  });

  it('changes nothing when the admin declared no exclusions', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', reason: 'must not be consulted' });
    const response = await run(port, EXCLUDED, {});
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('allow');
  });

  it('reaches the judge even when the read-only allowlist would have auto-allowed it', async () => {
    // The case a unit test alone missed and the live run caught: the SHIPPED
    // read-only allowlist already permits `docker ps`, so ask-mode auto-allowed
    // it and the exclusion check never ran. That allowlist says "read-only,
    // safe" about a SANDBOXED run; it must not authorize a sandbox escape.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'read-only listing' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('check the containers');
    (agent as any).permissionManager.setCapabilityPermissionLayers(
      // The app-wide tier the shipped allowlist lives in. It rode a SOURCE layer
      // (`sourceSlug: 'org'`) until F1.715, which drops a source's bash patterns.
      [{ scope: 'global', content: JSON.stringify({ allowedBashPatterns: ['^docker ps$'] }) }],
      'readonly-allowlist-generation',
      true,
    );
    const permissionsContext = (agent as any).permissionManager.getCapabilityPermissionsContext();
    // Precondition: ask mode really does auto-allow it, so this test is not
    // silently exercising the plain low-risk path.
    expect(shouldPromptInAskMode('Bash', { command: 'docker ps' }, (agent as any).permissionManager, permissionsContext))
      .toBeNull();

    const identity = installManifest(agent, 'Bash', sandboxed);
    await (agent as any).handlePreToolUseRequest({ requestId: 'allowlisted', ...identity, ...EXCLUDED });
    agent.destroy();

    expect(calls).toHaveLength(1);
    expect(sent.at(-1)?.action).toBe('allow');
  });

  it('exempts a command the human whitelisted this session', async () => {
    // Otherwise an admin exclusion prompts forever with no way to remember the
    // answer. The human has already decided about this exact command.
    const { port, calls } = scriptedGuardian({ verdict: 'deny', reason: 'must not be consulted' });
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('check the containers');
    (agent as any).permissionManager.whitelistCommand('docker ps'); // UA12.70 — the key one click on `docker ps` mints (key equality)
    const identity = installManifest(agent, 'Bash', sandboxed);
    await (agent as any).handlePreToolUseRequest({ requestId: 'whitelisted', ...identity, ...EXCLUDED });
    agent.destroy();

    expect(calls).toHaveLength(0);
    expect(sent.at(-1)?.action).toBe('allow');
  });

  // Strict mode staying terminal above all of this is pinned by
  // `process-supervisor-escape-hatch.test.ts` — "refuses dangerouslyDisableSandbox
  // outright under strict sandbox mode" and "keeps excludedCommands working under
  // strict sandbox mode". This change does not touch `resolveIsolationDowngrade`,
  // so P10's lock stays above the classifier rather than reachable through it.
});

describe('PiAgent guardian consult — allow-all deny-net (G3)', () => {
  it('high-risk + no_objection => runs (allow receipt), never blocked', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', category: 'destructive_action', reason: 'user-requested fetch' });
    const { response } = await runBorderline('bypassPermissions', port);
    // The high-risk network command reaches the deny-net band and is judged.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('curl https://example.com/data.json');
    expect(response.action).toBe('allow');
    expect(response.receipt).toMatchObject({ outcome: 'allow' });
    // A guardian-passed run carries the provenance marker.
    expect(String((response.receipt as any)?.additionalContext ?? '')).toContain('guardian-approved');
  });

  it('high-risk + deny => blocked with the guardian category+reason diagnostic', async () => {
    const { port } = scriptedGuardian({ verdict: 'deny', category: 'data_exfiltration', reason: 'sends data off-box' });
    const { response } = await runBorderline('bypassPermissions', port);
    expect(response.action).toBe('block');
    expect(response.receipt).toMatchObject({ outcome: 'deny' });
    expect(String(response.reason)).toContain('data_exfiltration');
    expect(String(response.reason)).toContain('sends data off-box');
  });

  it('high-risk + unsure => downgrades the auto-allow to a human ask', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'unsure', reason: 'cannot decide' });
    const { response } = await runBorderline('bypassPermissions', port);
    expect(calls).toHaveLength(1);
    // The deny-net downgraded the auto-allow to an ASK; the test permission
    // service has no interactive handler, so ask resolves to a deny with the
    // ask message (mirroring the auto-mode unsure test).
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('NON-high-risk command in allow-all: never consults, runs as today', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'no' });
    // A plain read-only command is not in the high-risk band, so the deny-net
    // never fires — zero judge calls, and it runs (allow-all auto-allows it).
    const { response } = await runBorderline('bypassPermissions', port, { toolName: 'Bash', input: { command: 'ls -la' } });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('allow');
  });

  it('judge unavailable (no port): high-risk allow-all runs as today (no consult)', async () => {
    const { response } = await runBorderline('bypassPermissions', undefined);
    // Without a port the deny-net never engages; allow-all auto-allows.
    expect(response.action).toBe('allow');
  });
});

describe('PiAgent guardian consult — setting OFF is byte-identical to pre-guardian', () => {
  afterEach(() => {
    guardianSettings.enabled = true;
    guardianSettings.modelId = '';
  });

  it('setting OFF: auto-mode borderline asks (no consult), allow-all high-risk runs (no consult)', async () => {
    // With the product setting disabled, guardianConsultState() returns
    // undefined, so NEITHER band consults — every path is byte-identical to the
    // pre-guardian behavior regardless of a wired port.
    guardianSettings.enabled = false;

    // Auto mode: the borderline network command falls straight to ask.
    const auto = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
    const autoResult = await runBorderline('auto', auto.port);
    expect(auto.calls).toHaveLength(0);
    expect(autoResult.response.action).toBe('block'); // ask -> deny (no handler)
    expect(String(autoResult.response.reason)).toBe('Interactive approval is unavailable.');

    // Allow-all: the high-risk command auto-allows with no deny-net consult.
    const exec = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'no' });
    const execResult = await runBorderline('bypassPermissions', exec.port);
    expect(exec.calls).toHaveLength(0);
    expect(execResult.response.action).toBe('allow');
    // No guardian provenance marker on a plain rule-allow.
    expect((execResult.response.receipt as any)?.additionalContext).toBeUndefined();
  });
});

describe('PiAgent guardian consult — judge model selection plumbing', () => {
  afterEach(() => {
    guardianSettings.enabled = true;
    guardianSettings.modelId = '';
  });

  it('the configured judge model id reaches the port (auto + allow-all)', async () => {
    guardianSettings.modelId = 'tgpt/custom-judge-model';

    const models: Array<string | undefined> = [];
    const port: GuardianJudgePort = {
      async judge(request) {
        models.push(request.modelId);
        return { verdict: 'no_objection', reason: 'ok' };
      },
    };
    await runBorderline('auto', port);
    await runBorderline('bypassPermissions', port);
    expect(models).toEqual(['tgpt/custom-judge-model', 'tgpt/custom-judge-model']);
  });

  it('an empty configured model id leaves modelId undefined (runner default resolution)', async () => {
    guardianSettings.modelId = '';

    const models: Array<string | undefined> = [];
    const port: GuardianJudgePort = {
      async judge(request) {
        models.push(request.modelId);
        return { verdict: 'no_objection', reason: 'ok' };
      },
    };
    await runBorderline('auto', port);
    expect(models).toEqual([undefined]);
  });
});

describe('PiAgent guardian consult — post-denial human override (G3 finding 1)', () => {
  it('judge deny → circuit opens → user approves the prompt → next identical action skips the judge; a different action still consults', async () => {
    // Judge always denies. Fire the SAME high-risk action repeatedly on ONE
    // agent (no turn boundary, so the circuit persists): the first denies count
    // toward the breaker, then the circuit opens and the band falls back to a
    // human prompt. The approving permission service resolves that prompt as an
    // ALLOW — the host observes the human overriding the guardian and arms the
    // post-denial override. A later identical action then SKIPS the judge and
    // follows the pre-guardian ask flow; a DIFFERENT action still consults.
    const calls: Array<string | undefined> = [];
    const port: GuardianJudgePort = {
      async judge(request) {
        calls.push(request.input.action.command);
        return { verdict: 'deny', category: 'destructive_action', reason: 'no' };
      },
    };
    const agent = new PiAgent(createConfig(port, approvingPermissionService()));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('do it');
    const identity = installManifest(agent, 'Bash');
    const run = async (requestId: string) =>
      (agent as any).handlePreToolUseRequest({ requestId, ...identity, ...BORDERLINE });

    // 3 consecutive denies trip the breaker (all hard blocks). The verdict cache
    // short-circuits the judge after the first, so exactly ONE judge call so far.
    await run('d1');
    await run('d2');
    await run('d3');
    expect(calls).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ action: 'block' });

    // Circuit now open: the same action falls to a human prompt, which the
    // approving service allows → the override is armed.
    await run('approve');
    expect(sent.at(-1)).toMatchObject({ action: 'allow' });

    // New turn boundary: the circuit resets, but the session-scoped override
    // (and denied set) persist. Re-issue the SAME action: the override makes it
    // skip the judge (no new judge call) and follow today's ask flow → allowed.
    (agent as any).resetPreToolHookLoopGuard();
    const judgeCallsBefore = calls.length;
    await run('after-override');
    expect(calls).toHaveLength(judgeCallsBefore); // no re-consult for the overridden action
    expect(sent.at(-1)).toMatchObject({ action: 'allow' });

    // A DIFFERENT borderline action still consults the judge (override is exact).
    await (agent as any).handlePreToolUseRequest({
      requestId: 'other',
      ...identity,
      toolName: 'Bash',
      input: { command: 'curl https://example.com/OTHER.json' },
    });
    expect(calls).toHaveLength(judgeCallsBefore + 1);
    agent.destroy();
  });

  it('a human approval of an action the guardian NEVER denied does not arm any override', async () => {
    // no_objection lets the action run outright (no prompt), so there is no human
    // approval to observe and nothing is added to the denied set. Re-issuing the
    // action still hits the cache (one judge call), never an override.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'ok' });
    const agent = new PiAgent(createConfig(port, approvingPermissionService()));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('do it');
    const identity = installManifest(agent, 'Bash');
    await (agent as any).handlePreToolUseRequest({ requestId: 'a', ...identity, ...BORDERLINE });
    await (agent as any).handlePreToolUseRequest({ requestId: 'b', ...identity, ...BORDERLINE });
    agent.destroy();
    expect(calls).toHaveLength(1); // cache hit, no override involvement
    expect(sent.at(-1)).toMatchObject({ action: 'allow' });
  });
});

describe('PiAgent guardian consult — config IO stays off the fast path (G3 finding 2)', () => {
  afterEach(() => {
    guardianSettings.enabled = true;
    guardianSettings.modelId = '';
    guardianSettings.enabledReads = 0;
  });

  // `plan` is deliberately absent: since R21 it has its own classifier band, so
  // a non-read-only command there IS eligible and does resolve the consult
  // state. Its zero-IO case is the read-only command below.
  const fastPathModes: PermissionMode[] = ['default', 'acceptEdits']; // F1.1050: the explore arm left with the mode
  for (const mode of fastPathModes) {
    it(`mode ${mode}: never reads the guardian setting (zero config IO)`, async () => {
      guardianSettings.enabledReads = 0;
      const { port } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
      await runBorderline(mode, port);
      expect(guardianSettings.enabledReads).toBe(0);
    });
  }

  it('plan mode, read-only call: never reads the guardian setting', async () => {
    guardianSettings.enabledReads = 0;
    const { port } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
    await runBorderline('plan', port, { toolName: 'Read', input: { file_path: '/repo/src/a.ts' } });
    expect(guardianSettings.enabledReads).toBe(0);
  });

  it('auto mode, ineligible result type (low-risk allow): never reads the guardian setting', async () => {
    guardianSettings.enabledReads = 0;
    const { port } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
    // A plain read-only command auto-allows in auto mode (result type `allow`),
    // which is NOT the auto borderline band → the setting is never read.
    await runBorderline('auto', port, { toolName: 'Bash', input: { command: 'ls -la' } });
    expect(guardianSettings.enabledReads).toBe(0);
  });

  it('allow-all, ineligible result type (low-risk allow): never reads the guardian setting', async () => {
    guardianSettings.enabledReads = 0;
    const { port } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
    // Low-risk allow in allow-all is not in the deny-net high-risk band, but the
    // result type IS eligible (allow), so the setting is read to resolve the
    // consult state; the deny-net then classifies it out with zero judge calls.
    // The fast-path guarantee is about ineligible MODE/RESULT-TYPE, which the
    // allow-all + allow combination is not — assert only that the JUDGE is not
    // called (no latency), consistent with the existing non-high-risk test.
    const { response } = await runBorderline('bypassPermissions', port, { toolName: 'Bash', input: { command: 'ls -la' } });
    expect(response.action).toBe('allow');
  });

  it('an eligible request (auto borderline) DOES read the setting exactly once', async () => {
    guardianSettings.enabledReads = 0;
    const { port } = scriptedGuardian({ verdict: 'no_objection', reason: 'x' });
    await runBorderline('auto', port);
    // The eligible path resolves the consult state → one setting read.
    expect(guardianSettings.enabledReads).toBe(1);
  });
});

/**
 * D1 — `autoMode.classifyAllShell`, end to end through the production gate.
 *
 * `auto-mode-config.md:226`, whole line:
 *
 *   "Set `autoMode.classifyAllShell` to `true` to suspend every Bash and
 *   PowerShell allow rule while auto mode is active, so the classifier
 *   evaluates every shell command regardless of your allow list."
 *
 * Only the judge port is faked here, so these run the real
 * `handlePreToolUseRequest` → `runPreToolUseChecks` → guardian consult path.
 * `ls -la` is the allow-matched command: the fast-path suite above pins that
 * auto mode allows it TODAY without ever reaching the judge.
 */
describe('PiAgent guardian consult — autoMode.classifyAllShell routes every shell command (D1)', () => {
  const ALLOW_MATCHED = { toolName: 'Bash', input: { command: 'ls -la' } };

  async function runWithKey(
    mode: PermissionMode,
    guardianJudgePort: GuardianJudgePort | undefined,
    request: { toolName: string; input: Record<string, unknown> },
    runtimeExtras: Partial<CapabilityTurnRuntime>,
    readableDsl?: PermissionDslV1,
  ): Promise<{ response: Record<string, unknown> }> {
    const agent = new PiAgent(createConfig(guardianJudgePort));
    agent.setPermissionMode(mode);
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('list the files');
    const identity = installManifest(agent, request.toolName, runtimeExtras);
    if (readableDsl) {
      // The readable policy is read off the PermissionManager's context, not the
      // turn runtime, so it has to be installed here — and at the manifest's own
      // generation, or `evaluatePermissionDslV1` answers stale with a deny.
      (agent as any).permissionManager.setCapabilityPermissionLayers(
        [], String(identity.manifestGeneration), false, readableDsl,
      );
    }
    await (agent as any).handlePreToolUseRequest({ requestId: 'req-1', ...identity, ...request });
    agent.destroy();
    return { response: sent.at(-1) ?? {} };
  }

  it('key OFF: the allow-matched command runs and the judge is never asked (today)', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'no' });
    const { response } = await runWithKey('auto', port, ALLOW_MATCHED, {});
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('allow');
  });

  it('key ON, classifier approves: the command is classified, then runs', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'listing a directory' });
    const { response } = await runWithKey('auto', port, ALLOW_MATCHED, { classifyAllShell: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('ls -la');
    expect(response).toMatchObject({ action: 'allow', receipt: { outcome: 'allow' } });
  });

  it('key ON, classifier rejects: the command is BLOCKED with the classifier diagnostic', async () => {
    // The documented answer, not a new one — `auto-mode-config.md` on a
    // classifier rejection: the call is blocked. Same mapping the auto
    // borderline band has always used, reached by a command that previously
    // never got there at all.
    const { port } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'wipes the tree' });
    const { response } = await runWithKey('auto', port, ALLOW_MATCHED, { classifyAllShell: true });
    expect(response.action).toBe('block');
    expect(String(response.reason)).toContain('destructive_action');
    expect(String(response.reason)).toContain('wipes the tree');
  });

  it('key ON: a non-negotiable floor is still emitted upstream of the key', async () => {
    // 8c2990ad narrowed the consult so a floor never reaches the judge, and
    // P2.3 re-opened exactly one class of it in `auto` — so `rm -rf ~` IS
    // judged here. What the key must not change is WHICH prompt was built: the
    // breaker is emitted upstream of the mode branch this key touches, so the
    // judged action is the breaker's, and the key's allow-rule suspension has
    // nothing to do with it.
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'wipes home' });
    const { response } = await runWithKey(
      'auto', port, { toolName: 'Bash', input: { command: 'rm -rf ~' } }, { classifyAllShell: true },
    );
    expect(calls).toHaveLength(1);
    expect(response.action).toBe('block');
    expect(String(response.reason)).toContain('destructive_action');
  });

  it('key ON, no judge: the floor falls back to the human prompt', async () => {
    // The fail-closed half of the pair above: with no port there is no verdict,
    // and the breaker's own unconditional prompt stands.
    const { response } = await runWithKey(
      'auto', undefined, { toolName: 'Bash', input: { command: 'rm -rf ~' } }, { classifyAllShell: true },
    );
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  it('key ON but the mode is not auto: the key does nothing ("while auto mode is active")', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'no' });
    const { response } = await runWithKey('bypassPermissions', port, ALLOW_MATCHED, { classifyAllShell: true });
    expect(calls).toHaveLength(0);
    expect(response.action).toBe('allow');
  });

  const ALLOW_LS_DSL: PermissionDslV1 = {
    version: 1,
    rules: [{ id: 'allow-ls', action: 'allow', match: { kind: 'bash', executable: 'ls' } }],
  };

  it('key OFF: a readable-DSL Bash allow rule clears the ask, as today', async () => {
    // The boundary pair for the test below: same rule, same absent judge, only
    // the key differs. Without the key the command is auto-allowed before the
    // band anyway, so the rule is simply consistent with today's outcome.
    const { response } = await runWithKey('auto', undefined, ALLOW_MATCHED, {}, ALLOW_LS_DSL);
    expect(response.action).toBe('allow');
  });

  it('key ON: a readable-DSL Bash allow rule no longer clears the prompt when the judge is unavailable', async () => {
    // `Bash(npm test)` is the doc's own example of the rule this key suspends,
    // and the readable DSL is where that class of rule lives. With no judge
    // port the band falls back to asking; the allow rule must not convert that
    // ask back into a run, or "every Bash allow rule" would be false for the
    // one kind the documentation names.
    const { response } = await runWithKey(
      'auto', undefined, ALLOW_MATCHED, { classifyAllShell: true }, ALLOW_LS_DSL,
    );
    expect(response.action).toBe('block');
    expect(String(response.reason)).toBe('Interactive approval is unavailable.');
  });

  /**
   * P6.191 — the DEFAULT-ON half, which needs no key at all. Same harness, same
   * absent judge; only the shape of the readable rule and the mode differ.
   *
   * `auto-mode-config.md#route-all-shell-commands-through-the-classifier`,
   * verbatim: "By default, narrow Bash and PowerShell allow rules such as
   * `Bash(npm test)` stay in effect in auto mode, and Claude Code resolves them
   * before the classifier runs. Claude Code suspends only the broad rules that
   * grant arbitrary code execution, such as `Bash(*)` or wildcarded
   * interpreters, together with every rule that names `Monitor`, because
   * Monitor commands run through the shell."
   */
  describe('P6.191 — broad shell grants are suspended in auto mode with no key set', () => {
    const BROAD_DSL: PermissionDslV1 = {
      version: 1,
      rules: [{ id: 'broad', action: 'allow', match: { kind: 'bash', pattern: '*' }, text: 'Bash(*)' }],
    };
    const NARROW_DSL: PermissionDslV1 = {
      version: 1,
      rules: [{ id: 'narrow', action: 'allow', match: { kind: 'bash', pattern: 'curl *' }, text: 'Bash(curl *)' }],
    };

    it('a `Bash(*)` allow rule no longer clears an auto-mode prompt', async () => {
      // The borderline command reaches the band; with no judge port the band
      // falls back to asking. Before this caller landed, the broad grant
      // converted that ask straight back into a run — the exact outcome the
      // page says auto mode suspends.
      const { response } = await runWithKey('auto', undefined, BORDERLINE, {}, BROAD_DSL);
      expect(response.action).toBe('block');
      expect(String(response.reason)).toBe('Interactive approval is unavailable.');
    });

    it('a NARROW rule still clears it — the half the page states first', async () => {
      const { response } = await runWithKey('auto', undefined, BORDERLINE, {}, NARROW_DSL);
      expect(response.action).toBe('allow');
    });

    it('outside auto mode the same broad rule grants again ("while auto mode is active")', async () => {
      // The rule text is untouched by the suspension — only its evaluation is
      // skipped — so leaving auto mode restores it by construction.
      const { response } = await runWithKey('default', undefined, BORDERLINE, {}, BROAD_DSL);
      expect(response.action).toBe('allow');
    });
  });
});

/**
 * P2.3 — the three moved check classes, adjudicated by the classifier in AUTO
 * mode only (owner decision 2026-08-22, `2026-08-22-runtime-parity-closure.md`).
 *
 * `2026-w30.md:84`: "the checks for dangerous `rm` commands, background jobs,
 * and suspicious Windows paths no longer open permission dialogs; the auto-mode
 * classifier adjudicates them instead".
 *
 * The table is class x (auto | manual) x classifier outcome. The invariant every
 * row exists to protect: the classifier can only CONFIRM safety (`no_objection`
 * -> the action continues without a dialog) or escalate (`deny` -> block). It
 * can never auto-approve when it is absent or broken — no port, the setting off,
 * an open circuit, a transport error and an `unsure` verdict each fall back to
 * the prompt the class produced before this change.
 */
describe('PiAgent guardian consult — the three moved check classes (P2.3)', () => {
  /**
   * One command per class, each chosen so the PRE-change behavior is the
   * documented one: `rm -rf ~` is the removal circuit breaker's unconditional
   * prompt, and the other two auto-ran with no consult at all (low-risk filter).
   */
  const MOVED_CLASSES = [
    { name: 'dangerous rm', command: 'rm -rf ~' },
    { name: 'background job', command: 'npm run dev &' },
    { name: 'suspicious Windows path', command: 'copy payload.exe C:\\Windows\\System32\\payload.exe' },
  ] as const;

  async function runMoved(
    mode: PermissionMode,
    guardianJudgePort: GuardianJudgePort | undefined,
    command: string,
    options: { runs?: number; readableDsl?: PermissionDslV1; layers?: string[] } = {},
  ): Promise<{ response: Record<string, unknown> }> {
    const agent = new PiAgent(createConfig(guardianJudgePort));
    agent.setPermissionMode(mode);
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('please set up the dev environment');
    const identity = installManifest(agent, 'Bash');
    if (options.readableDsl || options.layers) {
      (agent as any).permissionManager.setCapabilityPermissionLayers(
        (options.layers ?? []).map(content => ({ content })),
        String(identity.manifestGeneration),
        false,
        options.readableDsl,
      );
    }
    for (let attempt = 0; attempt < (options.runs ?? 1); attempt += 1) {
      await (agent as any).handlePreToolUseRequest({
        requestId: `moved-${attempt}`, ...identity, toolName: 'Bash', input: { command },
      });
    }
    agent.destroy();
    return { response: sent.at(-1) ?? {} };
  }

  for (const { name, command } of MOVED_CLASSES) {
    describe(name, () => {
      it('auto + no_objection: the action continues, no dialog', async () => {
        const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked for it' });
        const { response } = await runMoved('auto', port, command);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.command).toBe(command);
        expect(response).toMatchObject({ action: 'allow', receipt: { outcome: 'allow' } });
      });

      it('auto + deny: blocked with the classifier diagnostic (escalation, not a dialog)', async () => {
        const { port } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'wipes the tree' });
        const { response } = await runMoved('auto', port, command);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toContain('destructive_action');
        expect(String(response.reason)).toContain('wipes the tree');
      });

      it('auto + unsure: falls back to the human prompt', async () => {
        const { port, calls } = scriptedGuardian({ verdict: 'unsure', reason: 'cannot decide' });
        const { response } = await runMoved('auto', port, command);
        expect(calls).toHaveLength(1);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toBe('Interactive approval is unavailable.');
      });

      it('auto + NO judge port: falls back to the human prompt, nothing is consulted', async () => {
        const { response } = await runMoved('auto', undefined, command);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toBe('Interactive approval is unavailable.');
      });

      it('auto + classifier DISABLED: falls back to the human prompt, the judge is never asked', async () => {
        guardianSettings.enabled = false;
        try {
          const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure' });
          const { response } = await runMoved('auto', port, command);
          expect(calls).toHaveLength(0);
          expect(response.action).toBe('block');
          expect(String(response.reason)).toBe('Interactive approval is unavailable.');
        } finally {
          guardianSettings.enabled = true;
        }
      });

      it('auto + judge transport ERROR: falls back to the human prompt', async () => {
        const calls: string[] = [];
        const port: GuardianJudgePort = {
          async judge(request) {
            calls.push(request.input.action.command ?? '');
            throw new Error('judge transport died');
          },
        };
        const { response } = await runMoved('auto', port, command);
        expect(calls).toHaveLength(1);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toBe('Interactive approval is unavailable.');
      });

      it('auto + circuit OPEN: falls back to the human prompt', async () => {
        // 3 consecutive denies trip the per-turn breaker; the 4th consult of the
        // same action finds the circuit open and asks. (Only the first deny is
        // FRESH — the rest replay the verdict cache — so auto mode does not
        // self-downgrade underneath the assertion.)
        const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'destructive_action', reason: 'no' });
        const { response } = await runMoved('auto', port, command, { runs: 4 });
        expect(calls.length).toBeGreaterThan(0);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toBe('Interactive approval is unavailable.');
      });

      it('manual (default) mode: prompts exactly as today, and the judge is NEVER consulted', async () => {
        const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, go ahead' });
        const { response } = await runMoved('default', port, command);
        expect(calls).toHaveLength(0);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toBe('Interactive approval is unavailable.');
      });

      it('acceptEdits mode: prompts exactly as today, and the judge is NEVER consulted', async () => {
        const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, go ahead' });
        const { response } = await runMoved('acceptEdits', port, command);
        expect(calls).toHaveLength(0);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toBe('Interactive approval is unavailable.');
      });

      it('a deny RULE outranks the classifier: denied even on `no_objection`', async () => {
        // Measured ordering, not assumed: a `deniedToolPatterns` layer is read by
        // `shouldAllowToolInMode`, so the gate returns a BLOCK and the consult
        // never happens — the rule layer precedes the breaker layer.
        const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'sure, go ahead' });
        const { response } = await runMoved('auto', port, command, {
          layers: [JSON.stringify({ deniedToolPatterns: ['Bash'] })],
        });
        expect(calls).toHaveLength(0);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toContain('deniedToolPatterns');
      });

      it('a readable-DSL deny rule is terminal even after a `no_objection`', async () => {
        const { response } = await runMoved('auto', scriptedGuardian({
          verdict: 'no_objection', reason: 'sure, go ahead',
        }).port, command, {
          readableDsl: {
            version: 1,
            rules: [{ id: 'deny-all-bash', action: 'deny', match: { kind: 'bash', executable: '*' } }],
          },
        });
        expect(response.action).toBe('block');
        expect(String(response.reason)).not.toBe('Interactive approval is unavailable.');
      });
    });
  }
});

describe('PiAgent guardian consult — the two floorless moved classes stay out of allow-all (P2.3)', () => {
  // The deny-net reuses `shouldPromptInAutoMode` as its high-risk band, so
  // banding these two unconditionally would have handed `bypassPermissions` a
  // new downgrade-to-prompt whenever the judge is unavailable. The owner
  // decision changes AUTO; allow-all keeps today's behavior byte for byte.
  const FLOORLESS = [
    { name: 'background job', command: 'npm run dev &' },
    { name: 'suspicious Windows path', command: 'copy payload.exe C:\\Windows\\System32\\payload.exe' },
  ] as const;

  for (const { name, command } of FLOORLESS) {
    it(`${name}: allow-all runs it as today, with a judge that cannot answer`, async () => {
      const { port, calls } = scriptedGuardian({ verdict: 'unsure', reason: 'cannot decide' });
      const { response } = await runBorderline('bypassPermissions', port, {
        toolName: 'Bash', input: { command },
      });
      expect(calls).toHaveLength(0);
      expect(response.action).toBe('allow');
    });
  }
});

/**
 * P2.20 — a judge PORT that resolves nothing at all.
 *
 * `runGuardianJudgeCore` is contracted to always return a well-formed
 * `{verdict}`, so this class needs a hostile or broken PORT, not a malformed
 * model. Before the fix `applyVerdict`'s `switch (verdict.verdict)` dereferenced
 * the result outside every catch, and `handleLine`'s dispatch of
 * `handlePreToolUseRequest` was un-awaited and un-caught — so the rejection went
 * nowhere and NO `pre_tool_use_response` was ever sent. The subprocess waits on
 * that answer, so the tool call HUNG instead of failing closed. Liveness, not
 * authority: nothing was widened, but nothing answered either.
 */
describe('PiAgent guardian consult — a nullish judge verdict fails closed, never hangs (P2.20)', () => {
  /** A port whose `judge` resolves a non-verdict (the broken-port class). */
  function nullishGuardian(value: null | undefined) {
    const calls: Array<string | undefined> = [];
    const port: GuardianJudgePort = {
      async judge(request) {
        calls.push(request.input.action.command);
        return value as unknown as GuardianRunResult;
      },
    };
    return { port, calls };
  }

  for (const [name, value] of [['null', null], ['undefined', undefined]] as const) {
    it(`${name}: the borderline action reaches the human ask flow, and the judge was consulted`, async () => {
      const { port, calls } = nullishGuardian(value);
      const { response } = await runBorderline('auto', port);
      // The band WAS consulted — this is not the zero-call fast path.
      expect(calls).toEqual(['curl https://example.com/data.json']);
      // …and the outcome is the pre-guardian ask, which this permission service
      // resolves to a deny (it has no interactive handler). Never an allow, and
      // — the point of the row — an ANSWER rather than a hang.
      expect(response.action).toBe('block');
      expect(String(response.reason)).toBe('Interactive approval is unavailable.');
    });
  }

  it('the consult reports a judge FAILURE, not an honest `unsure`', async () => {
    // A broken port must not read as a judge doing its job carefully. The
    // normalized verdict carries a `failure` tag, and that tag is what makes the
    // host's `markJudgeFailure` decorate the prompt the human answers; an honest
    // `unsure` (the model looked and could not decide) is tagless and is left
    // undecorated. Read off `consult` rather than off the rendered prompt: this
    // case is about the VERDICT's tag, and the rendered prompt would fold the
    // judge's own reason into the same string. (Until D1.271 this sentence gave
    // a second reason — that the marker's `i18n.t(...)` answered nothing in a
    // bare test process — which was true and is now fixed at the source:
    // `markJudgeFailure` initialises the singleton before it reads the key, so
    // the prompt text IS a detector, and the describe below uses it as one.)
    const judgeInput: GuardianJudgeInput = {
      action: { command: 'curl https://example.com/data.json', cwd: '/repo' },
      trustedIntent: 'please fetch the data file',
      facts: { mode: 'auto' },
    };
    for (const value of [null, undefined] as const) {
      const state = new GuardianConsultState(
        action => JSON.stringify(action),
        nullishGuardian(value).port,
      );
      const outcome = await state.consult({ input: judgeInput, cwd: '/repo', modeVersion: 1 });
      expect(outcome).toMatchObject({ kind: 'ask', reason: 'failure' });
      expect((outcome as { verdict?: GuardianRunResult }).verdict)
        .toMatchObject({ verdict: 'unsure', failure: 'malformed' });
    }
    // The boundary pair: a judge that DID answer `unsure` is not a failure.
    const honest = new GuardianConsultState(
      action => JSON.stringify(action),
      scriptedGuardian({ verdict: 'unsure', reason: 'cannot decide' }).port,
    );
    expect(await honest.consult({ input: judgeInput, cwd: '/repo', modeVersion: 1 }))
      .toMatchObject({ kind: 'ask', reason: 'unsure' });
  });

  it('a nullish verdict registers with the circuit breaker exactly like a transport failure', async () => {
    // A consult that is not a deny calls `registerConsult(false)`, which RESETS
    // the consecutive-deny run. Two denies, one nullish verdict, two more denies
    // therefore leave the breaker CLOSED — while three straight denies open it
    // (the positive control on the same rig). If the nullish verdict were
    // dropped without registering, the run would never break.
    const runSequence = async (verdicts: Array<GuardianRunResult | null>): Promise<boolean> => {
      let index = 0;
      const port: GuardianJudgePort = {
        async judge() { return verdicts[index++] as GuardianRunResult; },
      };
      const agent = new PiAgent(createConfig(port));
      agent.setPermissionMode('auto');
      (agent as any).send = () => {};
      (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
      (agent as any).setCurrentTurnUserMessage('please fetch the data file');
      const identity = installManifest(agent, 'Bash');
      for (let i = 0; i < verdicts.length; i += 1) {
        // Distinct commands: an identical action replays the verdict cache and
        // would never reach the judge a second time.
        await (agent as any).handlePreToolUseRequest({
          requestId: `seq-${i}`,
          ...identity,
          toolName: 'Bash',
          input: { command: `curl https://example.com/${i}.json` },
        });
      }
      const open = (agent as any)._guardianConsult?.isCircuitOpen === true;
      agent.destroy();
      return open;
    };
    const deny: GuardianRunResult = { verdict: 'deny', category: 'destructive_action', reason: 'no' };
    expect(await runSequence([deny, deny, deny])).toBe(true);
    expect(await runSequence([deny, deny, null, deny, deny])).toBe(false);
  });

  it('a rejecting pre-tool handler still answers the subprocess (the dispatch belt)', async () => {
    // Belt two, at the dispatch site itself: whatever throws inside
    // `handlePreToolUseRequest` — today nothing, after some future edit
    // something — the subprocess is BLOCKED on this answer, so the rejection
    // must become a fail-closed response and not an unhandled rejection.
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).handlePreToolUseRequest = async () => { throw new Error('handler exploded'); };
    (agent as any).handleLine(JSON.stringify({
      type: 'pre_tool_use_request',
      requestId: 'belt-1',
      toolName: 'Bash',
      input: { command: 'echo hi' },
    }));
    await new Promise(resolve => setTimeout(resolve, 0));
    agent.destroy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'pre_tool_use_response',
      requestId: 'belt-1',
      action: 'block',
    });
    expect(String(sent[0]!.reason)).toContain('handler exploded');
  });
});

/**
 * D1.271 — the judge-failure marker is a SENTENCE, never the literal `undefined`.
 *
 * `markJudgeFailure` composes the card's clause from
 * `i18n.t('settings.ai.guardian.judgeFailedMarker')`, and an i18next singleton
 * nobody initialised answers **`undefined`** from `t()` — not the key. The
 * headless `nessy-server` entry never calls `setupI18n()` (only the four
 * renderer entries and `electron/src/main/index.ts` do), so the card a human
 * answered there read `undefined`, or `<reason> — undefined (<judge reason>)`:
 * strictly worse than no marker, because the marker exists to say the judge
 * could not answer. Measured in a plain `bun` child on 2026-09-18 (95.89 s
 * real, user 1.00 / sys 0.43, load 9.05) — importing `pi-agent.ts` and reading
 * that key answers `undefined`, and `i18n.isInitialized` answers `undefined`
 * too. The fix is the guard {@link PiAgent.authorizeAndSend}'s D1.256 twin and
 * `base-agent.ts:tokenCapReachedNotice` already carry.
 *
 * **THE CONTROL IS A COLD PROCESS, and that is a property of the RUN, not of
 * these two cases.** `setupI18n` is a process-wide singleton and nothing can
 * un-initialise it, so once any body in the batch has called it the positive
 * assertion below passes with the guard removed. This describe is therefore
 * placed AHEAD of every `setupI18n()` in this file (the first is D1.256's, ~400
 * lines below); to take the control back explicitly, run either case alone with
 * `-t`, which executes no other body. Mutant reading, taken cold: with the
 * guard removed the positive case fails on `undefined`.
 */
describe('D1.271 — a judge-failure marker minted before the locale loads is still a sentence', () => {
  /** The prompt shape PiAgent's Guardian consult failure arm hands `markJudgeFailure`. */
  const PROMPT = { type: 'prompt' as const, reason: 'Bash requires approval.' };

  it('the tagless ask (`unsure`) is returned UNCHANGED — no marker, nothing to render', () => {
    // The boundary: only `failure` is decorated. An honest `unsure` — the model
    // looked and could not decide — is tagless, and this arm never reaches
    // `i18n.t` at all, which is why the guard sits INSIDE the failure branch
    // rather than at the top of the method.
    const agent = new PiAgent(createConfig());
    const unchanged = (agent as any).markJudgeFailure(PROMPT, 'unsure');
    agent.destroy();
    expect(unchanged).toBe(PROMPT);
    expect(String(unchanged.reason)).toBe('Bash requires approval.');
  });

  it('the failure marker carries the judge\'s reason and never the word `undefined`', () => {
    const agent = new PiAgent(createConfig());
    const marked = (agent as any).markJudgeFailure(PROMPT, 'failure', {
      verdict: 'unsure', failure: 'malformed', reason: 'judge port returned nothing',
    } as unknown as GuardianRunResult);
    agent.destroy();
    const reason = String(marked.reason);
    // The defect, named: an unguarded `t()` put this word on the card.
    expect(reason).not.toContain('undefined');
    // …and the second failure mode a guard alone would not catch: an initialised
    // i18next answers the KEY for a key it does not have.
    expect(reason).not.toContain('settings.ai.guardian.judgeFailedMarker');
    // The whole composition, so the ` — ` join and the parenthesised judge reason
    // are pinned beside the sentence.
    expect(reason).toBe(
      `Bash requires approval. — ${i18n.t('settings.ai.guardian.judgeFailedMarker')} (judge port returned nothing)`,
    );
    expect(reason).toContain('judge port returned nothing');
  });
});

/**
 * P2.29 — the `Remove-Item` WILDCARD subclass never reaches the judge.
 *
 * `permission-modes.md:602`, whole bullet, fetched 2026-08-23:
 *
 *   "**Wildcards**: a bare `*`, or any target ending in `/*` or `\*`, including
 *   a glob under a shell variable such as `$dir/*`. Claude Code denies the
 *   command in every mode, without asking you, before the classifier sees it."
 *
 * The classifier's own page-level list says it from this side, `:379`, last
 * sentence of the shell-variable bullet: "`Remove-Item` targets that are a bare
 * `*` or end in `/*` or `\*` never reach the classifier: Claude Code denies them
 * outright".
 *
 * MEASURED BEFORE THE CHANGE (2026-08-23, this harness): `Remove-Item -Recurse
 * -Force $HOME/*` in `auto` and in eligible `plan` produced judgeCalls=1 and
 * action=allow, and in `default`/`bypassPermissions` it produced the prompt.
 * The scope pin below is measured too: `rm -rf /*` produced judgeCalls=1 in
 * `auto` before AND after, because the `rm` list is a different check — see the
 * scope paragraph on `findRemoveItemLadderDeny` in `core/pre-tool-use.ts` (the
 * predicate P2.29 named here, `isRemoveItemWildcardRemoval`, was replaced by
 * that matcher in P2.34 and no longer exists).
 */
describe('PiAgent guardian consult — a Remove-Item wildcard removal is denied before the classifier (P2.29)', () => {
  const WILDCARD = { toolName: 'Bash', input: { command: 'Remove-Item -Recurse -Force $HOME/*' } };

  for (const mode of ['auto', 'plan', 'default', 'bypassPermissions'] as const) {
    it(`denies without asking and without consulting in ${mode}`, async () => {
      const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
      const { response } = await runBorderline(mode, port, WILDCARD);
      expect(calls).toHaveLength(0);
      expect(response.action).toBe('block');
      // Not the prompt's "Interactive approval is unavailable." — this is the
      // deny itself, and its reason is what tells the two apart in a harness
      // that has no interactive handler.
      expect(String(response.reason)).toContain('denied in every permission mode');
    });
  }

  it('an `rm` glob is NOT this subclass — it still reaches the classifier in auto', async () => {
    // The scope line, pinned. `:591` keeps `rm -rf <dir>/*` inside the
    // critical-path LIST, whose per-mode answers are the `:574-580` table that
    // P2.3 and P2.21 built; `:599` gives `Remove-Item` a check "separate from
    // the `rm` critical-path list". Denying this one here would trade a
    // documented divergence for a new one.
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
    const { response } = await runBorderline('auto', port, { toolName: 'Bash', input: { command: 'rm -rf /*' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('rm -rf /*');
    expect(response.action).toBe('allow');
  });

  it('an `rm` removal of the home directory is still adjudicated in auto', async () => {
    // The other half of the same boundary, and the row that used to hold
    // `Remove-Item -Recurse -Force $HOME` — which P2.34 moved to a deny under
    // `:601`. The `rm` spelling stays on the `:574-580` table in every mode,
    // including on Windows, where PowerShell would alias it (gap (c), recorded).
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
    const { response } = await runBorderline('auto', port, {
      toolName: 'Bash',
      input: { command: 'rm -rf $HOME' },
    });
    expect(calls).toHaveLength(1);
    expect(response.action).toBe('allow');
  });
});

/**
 * P2.34 — the ladder's other two rungs, neither of which the judge ever sees.
 *
 * `permission-modes.md`, fetched 2026-08-23. `:601`, the FIRST case: "**System
 * paths**: the filesystem root and its top-level directories, drive roots and
 * their top-level directories, and your home directory. Claude Code denies the
 * command in every mode, without asking you." `:602`, the second, names two
 * forms the matcher could not resolve before this task: "a bare `*`" and "a glob
 * under a shell variable such as `$dir/*`".
 *
 * MEASURED BEFORE THE CHANGE on this harness (2026-08-23): every command below
 * reached the judge in `auto` (judgeCalls=1, action=allow) or settled on the
 * prompt in the modes that ask.
 */
describe('PiAgent guardian consult — the Remove-Item ladder denies its remaining rungs (P2.34)', () => {
  const FORMS: Array<[label: string, command: string]> = [
    ['a bare `*`', 'Remove-Item -Recurse -Force *'],
    // The same command to PowerShell as the row above, and the step around it
    // that the round-2 review of P2.34 probed and found ALLOWING in
    // `bypassPermissions`. Both separators, and the parent form, because
    // PowerShell resolves `.` and `..` against the current location and takes
    // `\` and `/` alike.
    ['a dot base', 'Remove-Item -Recurse -Force ./*'],
    ['a dot base spelled with a backslash', 'Remove-Item -Recurse -Force .\\*'],
    ['a parent-dot base', 'Remove-Item -Recurse -Force ../*'],
    ['a glob under a shell variable', 'Remove-Item -Recurse -Force $dir/*'],
    // P2.49: the carve-out that spared a relative base naming a subdirectory
    // is gone (owner decision on OQ-4, 2026-08-23 — `:602` names no exception
    // for it), so this form now takes the same "before the classifier sees it"
    // route as the rest of the bullet instead of reaching the judge.
    ['a glob under a relative base', 'Remove-Item -Recurse -Force ./build/*'],
    ['a system path', 'Remove-Item -Recurse -Force /usr'],
    ['the home directory itself', 'Remove-Item -Recurse -Force $HOME'],
  ];

  for (const [label, command] of FORMS) {
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      it(`denies ${label} without consulting in ${mode}`, async () => {
        const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
        const { response } = await runBorderline(mode, port, { toolName: 'Bash', input: { command } });
        expect(calls).toHaveLength(0);
        expect(response.action).toBe('block');
        expect(String(response.reason)).toContain('denied in every permission mode');
      });
    }
  }

  for (const mode of ['plan', 'default'] as const) {
    it(`denies the home directory itself in ${mode} too — every mode means every mode`, async () => {
      const { port, calls } = scriptedGuardian({ verdict: 'no_objection', reason: 'the user asked to wipe it' });
      const { response } = await runBorderline(mode, port, {
        toolName: 'Bash',
        input: { command: 'Remove-Item -Recurse -Force $HOME' },
      });
      expect(calls).toHaveLength(0);
      expect(response.action).toBe('block');
      expect(String(response.reason)).toContain('denied in every permission mode');
    });
  }
});

describe('PiAgent guardian consult — a degraded judge says WHAT degraded (P3.249)', () => {
  // `markJudgeFailure` is the one place a broken judge becomes visible to the
  // human it just fell back to. It marked the prompt but dropped the judge's own
  // `reason`, so a 15s timeout, a dead port, a judge whose SETUP threw and a
  // model that would not produce the schema all read identically — and the only
  // place they differed was the debug channel, which a packaged build does not
  // write. The deny path has always carried `verdict.reason` (`denyDiagnostic`);
  // this is the failure path catching up, not a new disclosure class.
  const mark = (reason: string, verdict?: GuardianRunResult): string => {
    const agent = new PiAgent(createConfig());
    try {
      const marked = (agent as any).markJudgeFailure(
        { type: 'prompt', promptType: 'bash', description: 'run a command', reason: 'ORIGINAL' },
        reason,
        verdict,
      );
      return String(marked.reason);
    } finally {
      agent.destroy();
    }
  };

  it('carries the judge failure reason into the prompt the human answers', () => {
    const marked = mark('failure', {
      verdict: 'unsure',
      failure: 'spawn-error',
      reason: 'judge setup failed: connection probe blew up',
    });
    expect(marked).toContain('ORIGINAL');
    expect(marked).toContain('judge setup failed: connection probe blew up');
  });

  it('distinguishes the four failure shapes from each other, which was the whole defect', () => {
    const shapes: GuardianRunResult[] = [
      { verdict: 'unsure', failure: 'timeout', reason: 'judge timed out after 15000ms' },
      { verdict: 'unsure', failure: 'spawn-error', reason: 'judge spawn failed: child crashed' },
      { verdict: 'unsure', failure: 'malformed', reason: 'judge output did not match the verdict schema: $.verdict is required' },
      { verdict: 'unsure', failure: 'aborted', reason: 'judge aborted before completing' },
    ];
    const marked = shapes.map(shape => mark('failure', shape));
    // Every one distinct — the property that did not hold before.
    expect(new Set(marked).size).toBe(shapes.length);
    for (const [index, text] of marked.entries()) {
      expect(text).toContain(shapes[index]!.reason);
    }
  });

  it('a judge that WORKED and said `unsure` is still not marked — the boundary control', () => {
    // `unsure` is the judge doing its job; only `failure` earns the marker. If
    // this ever starts marking, the marker stops meaning "something is broken".
    expect(mark('unsure', { verdict: 'unsure', reason: 'cannot decide' })).toBe('ORIGINAL');
    expect(mark('disabled')).toBe('ORIGINAL');
    expect(mark('override')).toBe('ORIGINAL');
    expect(mark('circuit-open')).toBe('ORIGINAL');
  });

  it('BOTH bands HAND the verdict to the marker — the wiring, not just the function', async () => {
    // The cases above prove `markJudgeFailure` CAN carry a reason. This proves
    // its two callers give it one. Drop `outcome.verdict` at either call site —
    // the auto band (`:5139`) or the allow-all deny-net (`:5033`) — and the
    // marker silently returns to a bare sentence, which is the defect this row
    // closed. Nothing else in this suite would notice: the test permission
    // service has no interactive handler, so an ask resolves to a fixed message
    // and the decorated prompt reason never reaches an assertion.
    const seen: Array<{ reason: unknown; verdict: unknown }> = [];
    const port: GuardianJudgePort = {
      async judge() {
        return { verdict: 'unsure', failure: 'timeout', reason: 'judge timed out after 15000ms' };
      },
    };
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      const agent = new PiAgent(createConfig(port));
      agent.setPermissionMode(mode);
      (agent as any).send = () => undefined;
      (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
      (agent as any).setCurrentTurnUserMessage('please fetch the data file');
      const original = (agent as any).markJudgeFailure.bind(agent);
      (agent as any).markJudgeFailure = (prompt: unknown, reason: unknown, verdict: unknown) => {
        seen.push({ reason, verdict });
        return original(prompt, reason, verdict);
      };
      const identity = installManifest(agent, BORDERLINE.toolName, {});
      await (agent as any).handlePreToolUseRequest({ requestId: 'req-1', ...identity, ...BORDERLINE });
      agent.destroy();
    }
    // One per band, each carrying the judge's own verdict rather than only the tag.
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.reason).toBe('failure');
      expect(call.verdict).toMatchObject({ reason: 'judge timed out after 15000ms', failure: 'timeout' });
    }
  });

  it('a failure with no verdict attached still marks, just without a why', () => {
    const marked = mark('failure');
    expect(marked).toContain('ORIGINAL');
    expect(marked).not.toBe('ORIGINAL');
    // No empty parenthetical when there is nothing to put in it.
    expect(marked).not.toContain('()');
  });
});
/**
 * D1.156 — a card raised AFTER the judge said `no_objection`, and what the
 * session records about it.
 *
 * The row reads "in auto mode a permission card can be raised AFTER the
 * guardian judge answered `no_objection`, and nothing on the session says which
 * floor asked" (W19-r, C3.4's retracted FAIL: the judge's own child thread
 * carried `{"verdict":"no_objection"}` for an explicitly-named
 * `git push --force`, twice across two drives, and the host still asked a
 * human).
 *
 * The ordering, measured by reading at HEAD: a `no_objection` turns the prompt
 * into `{ type: 'allow' }`, and on Pi exactly ONE producer can card that action
 * afterwards — the readable permission DSL's `ask` match, whose branch converts
 * `decision.outcome === 'allow'` back to `ask`. That is deliberate, and the
 * consult gate says so in its own comment. So the floor already names itself on
 * the card; what the session lost was the judge's half — both DSL override
 * branches rebuilt the decision without `decision.additionalContext`, which on
 * a consulted action IS the guardian provenance.
 *
 * These cases assert on the RECEIPT, because the receipt is what "the session
 * says" means for an audit, and the rig's permission service already forwards
 * `additionalContext` verbatim.
 */
describe('D1.156 — a DSL rule that overrides a guardian allow keeps the judge on the receipt', () => {
  /**
   * D1.270 — THE GENERATION HAS TO MATCH THE MANIFEST'S, and until this row it
   * did not, so the case named "the ASK branch" never reached the ask branch.
   *
   * `evaluatePermissionDslV1` is called with `generation: manifestOwner.generation`
   * — `'test-generation'`, minted by `installManifest` — and a policy layer filed
   * under ANY other name evaluates to `{ action: 'deny', diagnostic:
   * 'stale-generation' }`, whatever the rule says. These two helpers filed
   * theirs under `'ask-floor-generation'` and `'deny-floor-generation'`, so both
   * cases below were the same arm: `[deny] Permission DSL generation is stale.`
   * They passed because D1.156's own fix put `additionalContext` on BOTH
   * branches, so the assertion could not tell them apart. Found by WI-z while
   * building D1.256, measured three ways, and re-measured here: with the old
   * names the ask case's receipt reason is the stale-generation sentence.
   *
   * Two things move together, and neither alone is enough: the generation NAME,
   * and the CALL ORDER — `installManifest` calls `setCapabilityTurnRuntime`,
   * which clears manifest authority, so the layers go on AFTER it. Each case
   * below now pins its own arm by the receipt's reason, which is the only
   * observable that separates a real `ask`/`deny` from the stale deny.
   */
  const MANIFEST_GENERATION = 'test-generation';
  const curlRule = (agent: PiAgent, action: 'ask' | 'deny') => (agent as any).permissionManager
    .setCapabilityPermissionLayers(
      [],
      MANIFEST_GENERATION,
      true,
      parsePermissionDslV1({
        version: 1,
        rules: [{ id: `${action}-curl`, action, match: { kind: 'bash', executable: 'curl' } }],
      }),
    );
  const askCurl = (agent: PiAgent) => curlRule(agent, 'ask');
  const denyCurl = (agent: PiAgent) => curlRule(agent, 'deny');

  function autoAgent(port: GuardianJudgePort) {
    const agent = new PiAgent(createConfig(port));
    agent.setPermissionMode('auto');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('fetch the data file');
    return { agent, sent };
  }

  it('the ASK branch: the judge cleared it, the rule carded it, and the receipt says both', async () => {
    const { port, calls } = scriptedGuardian({
      verdict: 'no_objection',
      reason: 'reading a public data file',
      category: 'low_risk',
    } as GuardianRunResult);
    const { agent, sent } = autoAgent(port);
    const identity = installManifest(agent, 'Bash');
    askCurl(agent);
    await (agent as any).handlePreToolUseRequest({ requestId: 'asked', ...identity, ...BORDERLINE });
    agent.destroy();

    // The judge WAS consulted and cleared it…
    expect(calls).toHaveLength(1);
    // …and the ARM is pinned before anything is read off the receipt (D1.270).
    // This rig's permission service has no interactive handler, so a genuine
    // `ask` decision resolves to exactly this sentence; the stale-generation
    // deny this case used to measure resolves to its own diagnostic instead.
    const reason = String(sent.at(-1)?.reason);
    expect(reason).toBe('Interactive approval is unavailable.');
    expect(reason).not.toContain('stale');
    // …and the card was raised anyway, which is the row.
    const receipt = sent.at(-1)?.receipt as { additionalContext?: string } | undefined;
    // THE FIX: the session's own record of this action names the judge's
    // verdict. Before it, the ask branch rebuilt the decision without it.
    expect(receipt?.additionalContext).toContain('guardian-approved');
    expect(receipt?.additionalContext).toContain('reading a public data file');
  });

  it('the DENY branch: the same rule shape refusing outright keeps it too', async () => {
    // The uniform half. A deny rule outranking a judge allow is already pinned
    // elsewhere in this file; what is new is that its receipt no longer drops
    // the fact that the judge had cleared the action.
    const { port, calls } = scriptedGuardian({
      verdict: 'no_objection',
      reason: 'the org says curl is fine',
    } as GuardianRunResult);
    const { agent, sent } = autoAgent(port);
    const identity = installManifest(agent, 'Bash');
    denyCurl(agent);
    await (agent as any).handlePreToolUseRequest({ requestId: 'refused', ...identity, ...BORDERLINE });
    agent.destroy();

    expect(calls).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ action: 'block' });
    // D1.270 — the CONTROL for the case above, and it only controls anything
    // while it is a different arm: this refusal names the RULE, where the old
    // shared stale-generation deny named the generation.
    const denyReason = String(sent.at(-1)?.reason);
    expect(denyReason).toContain('deny-curl');
    expect(denyReason).not.toContain('stale');
    const receipt = sent.at(-1)?.receipt as { additionalContext?: string } | undefined;
    expect(receipt?.additionalContext).toContain('guardian-approved');
  });

  it('the control: an action the judge DENIED carries no such marker', async () => {
    // Non-vacuity. `guardian-approved` is minted only on a `no_objection`, so a
    // fix that stamped every receipt would fail here — and so would a rig whose
    // permission service invented the field.
    const { port } = scriptedGuardian({
      verdict: 'deny',
      reason: 'exfiltration shaped',
      category: 'data_exfiltration',
    } as GuardianRunResult);
    const { agent, sent } = autoAgent(port);
    const identity = installManifest(agent, 'Bash');
    askCurl(agent);
    await (agent as any).handlePreToolUseRequest({ requestId: 'judge-denied', ...identity, ...BORDERLINE });
    agent.destroy();

    const receipt = sent.at(-1)?.receipt as { additionalContext?: string } | undefined;
    expect(receipt?.additionalContext ?? '').not.toContain('guardian-approved');
  });
});

/**
 * D1.256 — the CARD says the judge cleared it, not only the receipt.
 *
 * D1.156 put the guardian provenance on the receipt and left the user's half
 * open, because whether to TELL the user is a product posture. The row decides
 * it, and the mechanism it names is already in this file: `markJudgeFailure`
 * appends exactly such a marker for the judge-FAILED case, from a locale key,
 * with ` — ` between. This is that method's twin for the judge-CLEARED case,
 * and the PAIR is the point — a marker on one outcome and silence on the other
 * teaches a user that an unmarked card means the judge passed.
 *
 * WHERE IT IS ASSERTED. The receipt is what an audit reads; the CARD is
 * `decision.request.description`, the sentence the human answers, and this
 * file's own permission service never saw it before (it reads `outcome`,
 * `reason` and `additionalContext`). So these cases wrap that service and
 * record the decision it was handed — the last observable point before the
 * host raises the dialog.
 *
 * THE BOUNDARY IS THE SECOND CASE. It drives the SAME branch (a DSL `ask` rule
 * over a gate `allow`) with NO judge in the session at all, so the rule
 * sentence is identical and the marker must be absent. Without it, a clause
 * that stamped every DSL card would pass the first case.
 */
describe('D1.256 — a card raised over a cleared action says the judge cleared it', () => {
  /** The card sentence, as the marker-free branch composes it. */
  const RULE_SENTENCE = 'requires approval by readable permission policy';

  /**
   * `i18n.t` answers `undefined` in a process nothing initialised — measured on
   * this rig — so the marker has to be resolved for real on both sides, and
   * {@link markerText} asserts it RESOLVED. Without that check the whole pair
   * passes vacuously on a missing key: i18next echoes the key back, the
   * producer puts the key on the card and the expectation is the same key.
   */
  function markerText(): string {
    if (!i18n.isInitialized) setupI18n();
    const marker = i18n.t('settings.ai.guardian.judgeClearedMarker');
    expect(typeof marker).toBe('string');
    expect(marker).not.toBe('settings.ai.guardian.judgeClearedMarker');
    return marker;
  }

  function recordingService(): { port: PiPermissionServicePort; cards: string[] } {
    const inner = testPermissionService();
    const cards: string[] = [];
    return {
      cards,
      port: {
        async authorize(request) {
          // Read into a local FIRST — never assert a shape on this object and
          // then read it again (AGENTS.md: `toMatchObject` with an asymmetric
          // matcher overwrites the field it matched).
          if (request.decision.outcome === 'ask') cards.push(request.decision.request.description);
          return inner.authorize(request);
        },
      },
    };
  }

  /**
   * THE GENERATION HAS TO MATCH THE MANIFEST'S, and this is not a detail.
   *
   * `evaluatePermissionDslV1` is called with `generation: manifestOwner.generation`
   * (`'test-generation'`, minted by `installManifest`), and a policy layer filed
   * under any other generation evaluates to
   * `{ action: 'deny', diagnostic: 'stale-generation' }` — the DENY arm, whatever
   * the rule says. So a rig that installs an `ask` rule under its own generation
   * name never reaches the `ask` branch at all. Measured here: with
   * `'ask-floor-generation'` this helper's card list is EMPTY and the decision
   * that reaches `authorize` is `[deny] Permission DSL generation is stale.`
   *
   * And `setCapabilityTurnRuntime` (which `installManifest` calls) clears
   * manifest authority, so the layers go on AFTER it, not before.
   */
  const askRuleFor = (agent: PiAgent, executable: string) => (agent as any).permissionManager
    .setCapabilityPermissionLayers(
      [],
      'test-generation',
      true,
      parsePermissionDslV1({
        version: 1,
        rules: [{ id: `ask-${executable}`, action: 'ask', match: { kind: 'bash', executable } }],
      }),
    );

  /**
   * Auto mode, a judge in the session, an `ask` rule over the command — and the
   * COMMAND is what varies. A borderline one (`curl`) is consulted and cleared;
   * an ordinary one (`ls`) never reaches the judge at all, so the same rule
   * cards it with no verdict behind it. That is the boundary, and it keeps the
   * judge PRESENT on both sides so the only difference is whether it spoke.
   */
  async function driveAuto(port: GuardianJudgePort | undefined, executable: string, command: string): Promise<string[]> {
    const { port: service, cards } = recordingService();
    const agent = new PiAgent(createConfig(port, service));
    agent.setPermissionMode('auto');
    (agent as any).send = () => {};
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    (agent as any).setCurrentTurnUserMessage('fetch the data file');
    const identity = installManifest(agent, 'Bash');
    askRuleFor(agent, executable);
    await (agent as any).handlePreToolUseRequest({
      requestId: 'carded', ...identity, toolName: 'Bash', input: { command },
    });
    agent.destroy();
    return cards;
  }

  it('appends the judge-cleared marker to the sentence the human answers', async () => {
    const { port, calls } = scriptedGuardian({
      verdict: 'no_objection',
      reason: 'reading a public data file',
      category: 'low_risk',
    } as GuardianRunResult);
    const cards = await driveAuto(port, 'curl', 'curl https://example.com/data.json');

    // The judge was consulted and cleared it, and a card was raised anyway.
    expect(calls).toHaveLength(1);
    expect(cards).toHaveLength(1);
    // The rule still names itself — the marker is an ADDITION, not a rewrite.
    expect(cards[0]).toContain(RULE_SENTENCE);
    expect(cards[0]).toContain('ask-curl');
    // And the judge's half, through the same locale key `markJudgeFailure`
    // reads its own marker from. Resolved here rather than spelled, so the
    // case pins the KEY and survives a wording change in either locale.
    expect(cards[0]).toContain(markerText());
  });

  it('the boundary: an action the judge never saw carries no marker', async () => {
    const { port, calls } = scriptedGuardian({
      verdict: 'no_objection',
      reason: 'this verdict is never asked for',
    } as GuardianRunResult);
    const cards = await driveAuto(port, 'ls', 'ls -la');

    // The judge is in the session and was NOT consulted — an ordinary command
    // never reaches the band.
    expect(calls).toHaveLength(0);
    // NON-VACUITY: the same branch ran and composed the same rule sentence.
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain(RULE_SENTENCE);
    expect(cards[0]).toContain('ask-ls');
    // MUTATION KILLED: appending the marker unconditionally, which would tell a
    // user a judge had cleared an action no judge ever looked at.
    expect(cards[0]).not.toContain(markerText());
  });
});
