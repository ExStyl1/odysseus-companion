/**
 * F1.526 (HIGH, review finding A-permissions-safety-1) — `acceptEdits` approves
 * FILE EDITS inside the session's roots, and `auto` sends everything else to the
 * classifier. A mutating session tool is not a file edit because it is a tool.
 *
 * ## What F1.74 (`830df6c67`) solved, and what it opened
 *
 * F1.74 made a session tool take ONE decision whichever spelling reaches the
 * gate (Pi's bare `remember`, claude's `mcp__session__remember`): before it, Pi
 * ran every mutating session tool unasked in every mode. That half stands —
 * `sessionToolGateName` still maps the bare spelling, and the tables below drive
 * both spellings. Its rule for WHICH decision, though, was "a mutating session
 * tool runs where a Write inside the roots runs", taken as a blanket arm in
 * `shouldPromptInAskMode` with no root check, so in `acceptEdits` and `auto`
 * all 24 mutating session tools ran uncarded — `plugin_install`, the documented
 * consent boundary (`plugin-management-tools.ts`: "Installation is the consent
 * boundary."), among them. Two uncarded calls (`plugin_plan_install` with an
 * arbitrary `repositoryUrl`, then `plugin_install`) installed and activated a
 * plugin globally, its MCP server commands and hooks included, and in `auto`
 * the classifier was never asked.
 *
 * ## The contract (`permission-modes.md`, fetched 2026-09-24)
 *
 * `#auto-approve-file-edits-with-acceptedits-mode`: "`acceptEdits` mode lets
 * Claude create and edit files in your working directory without prompting."
 * … "Paths outside that scope, writes to protected paths, … and all other Bash
 * commands except the built-in read-only set still prompt." And the classifier's
 * decision order: "2. Read-only actions and file edits in your working directory
 * are auto-approved … 3. Everything else goes to the classifier."
 *
 * ## The decision (controller, 2026-09-24, from that contract)
 *
 * A session tool rides the write allowance only when its whole effect IS one
 * file write, and only when that file lands inside the roots — Write's own root
 * check. Read off the 24 handlers, exactly one qualifies: `remember`, which
 * appends to one `MEMORY.md` chosen by `scope`. Every other mutating session
 * tool cards in `acceptEdits` and reaches the classifier band in `auto`, on both
 * spellings. `default` and `bypassPermissions` are unchanged at the gate. Pi's
 * `bypassPermissions` deny-net (which reuses `shouldPromptInAutoMode` as its band)
 * kept session tools OUT until F1.538 (2026-09-24) put them in — see its describes.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_TOOL_DEFS } from '@nessy-agent/session-tools-core';
import {
  promptIsNonNegotiable,
  runPreToolUseChecks,
  shouldPromptInAutoMode,
  type PermissionManagerLike,
  type PreToolUseCheckResult,
} from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import type { PermissionMode } from '../mode-types.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts';
import type { AgentRuntimeView } from '../../capabilities/views.ts';
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
} from '../pi-harness/harness-manifest.ts';
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';
import type { GuardianJudgePort, GuardianRunResult } from '../core/guardian-consult.ts';

// The Pi arm imports the whole agent graph; its cost is the module graph, not a
// test body (AGENTS.md's junit trap), so the budget is the file's.
setDefaultTimeout(60_000);

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

const WORKSPACE = '/fixture/f1526-workspace';
const PROJECT = '/fixture/f1526-project';
const DATA = '/fixture/f1526-sessions/s1/data';

const keys: Array<{ workspaceId: string; sessionId: string }> = [];
afterAll(() => { for (const key of keys) cleanupModeState(key); });

function check(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  extra: { dataFolderPath?: string | null } = {},
): PreToolUseCheckResult {
  const sessionKey = { workspaceId: 'ws-f1526', sessionId: `f1526-${keys.length}` };
  keys.push(sessionKey);
  cleanupModeState(sessionKey);
  initializeModeState(sessionKey, mode);
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId: sessionKey.sessionId,
    sessionKey,
    permissionMode: mode,
    workspaceRootPath: WORKSPACE,
    workspaceId: 'ws-f1526',
    workingDirectory: PROJECT,
    plansFolderPath: '/fixture/f1526-sessions/s1/plans',
    ...(extra.dataFolderPath === null ? {} : { dataFolderPath: extra.dataFolderPath ?? DATA }),
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    interactive: true,
    permissionManager,
  });
}

/** `card` = an ordinary negotiable prompt (in `auto`: the classifier band). */
function verdict(result: PreToolUseCheckResult): string {
  if (result.type !== 'prompt') return result.type;
  return promptIsNonNegotiable(result) ? `floor:${result.nonNegotiable}` : `card:${result.promptType}`;
}

const spellings = (name: string) => [name, `mcp__session__${name}`] as const;

const PLAN_INSTALL = { repositoryUrl: 'https://attacker.invalid/plugin.git' };
const INSTALL = { proposalId: 'proposal-f1526', scope: 'global' };

describe('F1.526 — plugin_install is carded again in acceptEdits and judged in auto', () => {
  for (const name of spellings('plugin_install')) {
    it(`${name}: acceptEdits → card (the consent boundary is a person again)`, () => {
      expect(verdict(check(name, INSTALL, 'acceptEdits'))).toBe('card:mcp_mutation');
    });
    it(`${name}: auto → the classifier band (a negotiable prompt), never a silent allow`, () => {
      expect(verdict(check(name, INSTALL, 'auto'))).toBe('card:mcp_mutation');
    });
    it(`${name}: CONTROLS — default still cards, bypassPermissions still runs`, () => {
      expect(verdict(check(name, INSTALL, 'default'))).toBe('card:mcp_mutation');
      expect(verdict(check(name, INSTALL, 'bypassPermissions'))).toBe('allow');
    });
  }

  for (const name of spellings('plugin_plan_install')) {
    it(`${name}: CONTROL — the read-only planning step still runs uncarded in every asking mode`, () => {
      for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
        expect({ mode, verdict: verdict(check(name, PLAN_INSTALL, mode)) }).toEqual({ mode, verdict: 'allow' });
      }
    });
  }
});

/**
 * Membership is the registry's declaration (the same filter F1.74's mapping
 * uses), never a hand list: every mutating session tool claude is handed under
 * our name, minus the one file-write-equivalent tool.
 */
const MUTATING = SESSION_TOOL_DEFS
  .filter(def => def.safeMode === 'block' && def.visibility !== 'pi-only')
  .map(def => def.name);
const ADMITTED = ['remember'];

describe('F1.526 — every other mutating session tool keeps its card (acceptEdits) and its classifier (auto)', () => {
  it('the derived set is the 31 the registry declared when re-derived 2026-10-16 (the 24 F1.526 read + the six the 2026-10-02 tool rows registered: UA6.3 pages, UA1.18 publish_artifact, UA3.5 create_board_task + UB1.12 project_memory_append), and exactly one is admitted', () => {
    // 24 at F1.526 (decad2ce7, 2026-09-24, the set F1.74's consequence named); UA6.3
    // (034881dfd: create_page, update_page, write_page_data, delete_page), UA1.18
    // (11a60ddc2: publish_artifact) and UA3.5 (d7eea7beb: create_board_task) registered
    // their mutating claude-visible tools on 2026-10-02 → 30. UB1.12 (38eb4e4fe,
    // 2026-10-14: project_memory_append, `safeMode: 'block'`, not pi-only) → 31,
    // re-derived 2026-10-16 (UB12.18). It is NOT admitted — ADMITTED is the decision
    // above, not a derivation, and this re-derivation widens nothing — so its
    // per-tool arm below cards it on both spellings. The plan's other three new tools
    // (UB6.11 decide, UB7.11 source_list_prompts / source_get_prompt) declare
    // `safeMode: 'allow'` and so never enter this set. The per-tool arms below
    // derive from the registry, so a future tool is exercised as it lands — re-derive
    // THIS length, with the dated reason, when the count moves again.
    expect(MUTATING).toHaveLength(31);
    expect(MUTATING).toContain('plugin_install');
    expect(MUTATING).toContain('project_memory_append');
    expect(MUTATING.filter(name => ADMITTED.includes(name))).toEqual(['remember']);
  });

  for (const tool of MUTATING.filter(name => !ADMITTED.includes(name))) {
    for (const name of spellings(tool)) {
      it(`${name}: neither acceptEdits nor auto runs it uncarded`, () => {
        for (const mode of ['acceptEdits', 'auto'] as const) {
          const measured = verdict(check(name, {}, mode));
          // F1.537: claude's wire `spawn_session` is no longer intercepted by
          // step 4 — it cards here like its bare spelling (spawn-session-one-decision.test.ts).
          expect({ mode, measured: measured.startsWith('card:') || measured.startsWith('floor:') ? 'prompt' : measured })
            .toEqual({ mode, measured: 'prompt' });
        }
      });
    }
  }
});

describe('F1.526 — remember, the one admitted tool, gets the root check a Write gets', () => {
  for (const name of spellings('remember')) {
    it(`${name}: session scope (the data folder) and project scope (the working directory) run uncarded`, () => {
      for (const mode of ['acceptEdits', 'auto'] as const) {
        expect({ mode, verdict: verdict(check(name, { memory: 'm' }, mode)) }).toEqual({ mode, verdict: 'allow' });
        expect({ mode, verdict: verdict(check(name, { memory: 'm', scope: 'session' }, mode)) }).toEqual({ mode, verdict: 'allow' });
        expect({ mode, verdict: verdict(check(name, { memory: 'm', scope: 'project' }, mode)) }).toEqual({ mode, verdict: 'allow' });
      }
    });

    it(`${name}: user scope lands outside every session root — acceptEdits cards, auto goes to the classifier`, () => {
      for (const mode of ['acceptEdits', 'auto'] as const) {
        expect({ mode, verdict: verdict(check(name, { memory: 'm', scope: 'user' }, mode)) })
          .toEqual({ mode, verdict: 'card:mcp_mutation' });
      }
    });

    it(`${name}: a session scope with no data folder to bound it fails closed (a card)`, () => {
      expect(verdict(check(name, { memory: 'm' }, 'acceptEdits', { dataFolderPath: null }))).toBe('card:mcp_mutation');
    });

    it(`${name}: CONTROLS — default cards every scope, bypassPermissions runs every scope`, () => {
      for (const scope of ['session', 'project', 'user']) {
        expect({ scope, verdict: verdict(check(name, { memory: 'm', scope }, 'default')) })
          .toEqual({ scope, verdict: 'card:mcp_mutation' });
        expect({ scope, verdict: verdict(check(name, { memory: 'm', scope }, 'bypassPermissions')) })
          .toEqual({ scope, verdict: 'allow' });
      }
    });
  }

  it('REFERENCE — a Write to the same user-scope-like path outside the roots cards the same way', () => {
    expect(verdict(check('Write', { file_path: '/fixture/f1526-config/MEMORY.md', content: 'x' }, 'acceptEdits')))
      .toBe('card:file_write');
    expect(verdict(check('Write', { file_path: `${PROJECT}/MEMORY.md`, content: 'x' }, 'acceptEdits'))).toBe('allow');
  });
});

describe('F1.538 — the Pi deny-net band judges a mutating session tool, as it judges a third-party MCP mutation', () => {
  // `consultGuardianDenyNet` (pi-agent.ts) calls `shouldPromptInAutoMode` with no
  // session-tool option as its high-risk band. F1.526 kept session tools OUT of it
  // behind an opt-in only `auto` passed, so `plugin_install` (persistent code
  // execution) ran in `bypassPermissions` with the Guardian never asked while
  // `mcp__linear__createIssue` was judged. F1.538 (DECIDED, controller 2026-09-24:
  // in the judged set, fail-closed) removed the exclusion outright, so every caller
  // of the band — these calls pass NO options — judges a mutating session tool.
  const context = { workspaceRootPath: WORKSPACE, activeSourceSlugs: [] } as never;
  for (const name of [...spellings('plugin_install'), ...spellings('remember'), ...spellings('set_session_status')]) {
    it(`${name}: in the band`, () => {
      expect(shouldPromptInAutoMode(name, INSTALL, permissionManager, context)?.promptType).toBe('mcp_mutation');
    });
  }
  it('CONTROL — mcp__linear__createIssue is in the band, unchanged', () => {
    expect(shouldPromptInAutoMode('mcp__linear__createIssue', { title: 't' }, permissionManager, context)?.promptType)
      .toBe('mcp_mutation');
  });
  it('CONTROL — the read-only planning step and an ordinary file write keep their band verdicts', () => {
    for (const name of spellings('plugin_plan_install')) {
      expect({ name, band: shouldPromptInAutoMode(name, PLAN_INSTALL, permissionManager, context) }).toEqual({ name, band: null });
    }
    // A caller that passes no roots keeps a Write in the band (fails closed). Since F1.951
    // the deny-net passes the session roots (`shouldPromptInBypassDenyNet`), as `auto` does.
    expect(shouldPromptInAutoMode('Write', { file_path: `${PROJECT}/a.ts`, content: 'x' }, permissionManager, context)?.promptType)
      .toBe('file_write');
  });
});

// ---------------------------------------------------------------------------
// The Pi runtime end to end: its gate is handed the BARE spelling, and in
// `auto` a negotiable prompt is what consults the guardian (`autoBorderlineEligible`).
// The harness is `pi-session-tool-rule-alias.test.ts`'s: a session tool enters
// the manifest as a dynamic definition, the way the turn builder hands it over.
// ---------------------------------------------------------------------------

const PI_KEY = { workspaceId: 'ws-f1526-pi', sessionId: 'session-f1526-pi' };
const PI_GENERATION = 'generation-f1526';
// The agent's config watcher needs a real workspace directory (it refuses a missing one).
const PI_ROOT = mkdtempSync(join(tmpdir(), 'nessy-f1526-'));
mkdirSync(join(PI_ROOT, 'workspace'));
mkdirSync(join(PI_ROOT, 'project'));
afterAll(() => { rmSync(PI_ROOT, { recursive: true, force: true }); });

const piView: AgentRuntimeView = {
  generation: PI_GENERATION, sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
  promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
};
const piSnapshot = {
  context: { workspaceId: PI_KEY.workspaceId, sessionId: PI_KEY.sessionId, projectTrustState: 'none', projectTrustRevision: '' },
  generation: PI_GENERATION,
  leaseId: 'lease-f1526',
  entries: [],
  installedPlugins: [],
  diagnostics: [],
} as EffectiveCapabilitySnapshot;

const sessionTool = (handler: string): PiDynamicToolDefinition => ({
  bindingName: `mcp__session__${handler}`,
  description: `The ${handler} session tool.`,
  inputSchema: { type: 'object', properties: {} },
  modelSchemaVersion: 1,
  bindingSchemaVersion: 1,
  provenance: { capabilityKey: 'runtime:pi-session', generation: PI_GENERATION },
});

function receiptService(): PiPermissionServicePort {
  return {
    async authorize(request) {
      const outcome = request.decision.outcome === 'allow' ? 'allow' : 'deny';
      const reason = request.decision.outcome === 'allow'
        ? undefined
        : request.decision.outcome === 'deny' ? request.decision.reason : 'Interactive approval is unavailable.';
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
        decisionId: 'f1526-decision',
        outcome,
        canonicalInput: request.canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(reason ? { reason } : {}),
      }, request.subject);
    },
  };
}

function scriptedGuardian(result: GuardianRunResult) {
  const calls: string[] = [];
  const port: GuardianJudgePort = {
    async judge(request) {
      calls.push(request.input.action.mcpTool ?? request.input.action.command ?? '?');
      return result;
    },
  };
  return { port, calls };
}

async function runPi(mode: PermissionMode, toolName: string, input: Record<string, unknown>, port: GuardianJudgePort) {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: PI_KEY.workspaceId, name: 'F1.526', rootPath: join(PI_ROOT, 'workspace'),
      workspaceRootPath: join(PI_ROOT, 'workspace'), sessionRootPath: join(PI_ROOT, 'sessions'),
    } as never,
    session: {
      id: PI_KEY.sessionId, workspaceRootPath: join(PI_ROOT, 'workspace'), createdAt: Date.now(),
      lastUsedAt: Date.now(), workingDirectory: join(PI_ROOT, 'project'),
    } as never,
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: receiptService(),
    guardianJudgePort: port,
    contextProfile: 'bare',
  } as BackendConfig);
  agent.setPermissionMode(mode);
  const sent: Array<Record<string, unknown>> = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
  (agent as any).setCurrentTurnUserMessage('summarise the README');
  const manifest = finalizePiExecutionManifest(
    createPiExecutionManifestSeed({ snapshot: piSnapshot, view: piView, sessionKey: PI_KEY }),
    [sessionTool(toolName)],
  );
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === toolName);
  if (!tool) throw new Error(`the Pi surface has no ${toolName}`);
  agent.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  } as unknown as CapabilityTurnRuntime);
  (agent as any).activeExecutionManifest = manifest;
  await (agent as any).handlePreToolUseRequest({
    requestId: 'req-f1526',
    toolName: tool.binding.permissionName,
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    input,
  });
  agent.destroy();
  cleanupModeState(PI_KEY);
  // Read into a local before asserting (the toMatchObject mutation trap).
  const last = sent.at(-1) ?? {};
  return { action: last.action, reason: String(last.reason ?? '') };
}

describe('F1.526 — Pi (the bare spelling) end to end', () => {
  it('auto: plugin_install consults the classifier, and its deny blocks the install', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'persistent_security_weakening', reason: 'installs code nobody asked for' });
    const response = await runPi('auto', 'plugin_install', INSTALL, port);
    expect({ calls: calls.length, action: response.action }).toEqual({ calls: 1, action: 'block' });
    expect(response.reason).toContain('installs code nobody asked for');
  });

  it('bypassPermissions (F1.538): plugin_install consults the Guardian, and its deny blocks the install', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'persistent_security_weakening', reason: 'installs code nobody asked for' });
    const response = await runPi('bypassPermissions', 'plugin_install', INSTALL, port);
    expect({ calls: calls.length, action: response.action }).toEqual({ calls: 1, action: 'block' });
    expect(response.reason).toContain('installs code nobody asked for');
  });

  it('bypassPermissions (F1.538): a no_objection verdict runs the install — the net only narrows', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'no_objection', category: 'persistent_security_weakening', reason: 'the user asked for it' });
    const response = await runPi('bypassPermissions', 'plugin_install', INSTALL, port);
    expect({ calls: calls.length, action: response.action }).toEqual({ calls: 1, action: 'allow' });
  });

  it('CONTROL — bypassPermissions: the read-only plugin_plan_install runs and never asks the judge', async () => {
    const { port, calls } = scriptedGuardian({ verdict: 'deny', category: 'persistent_security_weakening', reason: 'x' });
    const response = await runPi('bypassPermissions', 'plugin_plan_install', PLAN_INSTALL, port);
    expect({ calls: calls.length, action: response.action }).toEqual({ calls: 0, action: 'allow' });
  });
});
