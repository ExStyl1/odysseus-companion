/**
 * R28 — `InstructionsLoaded` fires ONCE PER LOADED FILE with the documented
 * payload (hooks.md#instructionsloaded, fetched raw 2026-07-29).
 *
 * Before this, the event was emitted once per session by the Pi lifecycle bridge
 * with `{ source, lifecycle_version }` — no `file_path`, no `memory_type`, no
 * `load_reason`, so the documented matcher (which runs against `load_reason`)
 * could never match anything and no hook could tell which file was loaded.
 *
 * Documented fields:
 *   file_path         — absolute path to the instruction file that was loaded
 *   memory_type       — "User" | "Project" | "Local" | "Managed"
 *   load_reason       — session_start | nested_traversal | path_glob_match
 *                       | include | compact
 *   globs             — present only for `path_glob_match` loads
 *   trigger_file_path — the file whose access triggered a lazy load
 *   parent_file_path  — the instruction file that included this one
 *
 * Plus the COMMON input fields, which is where P6.974 landed.
 * `hooks.md#instructionsloaded-input` (re-fetched 2026-09-10): *"In addition to
 * the common input fields, InstructionsLoaded hooks receive these fields"*, and
 * the page's own `InstructionsLoaded` JSON example carries `transcript_path`
 * beside `session_id` and `cwd`. So the field is documented for this event and
 * is no leak; P6.300 (`5dcc08249`) began filling it in the one funnel every
 * backend's automation events pass through, and these exact-object assertions,
 * written before it, went red on a field none of them is about. They gain it —
 * and `pins the session's own transcript` below is the case that checks the
 * VALUE, so the four constants above it cannot all be wrong together.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { describe, expect, it } from 'bun:test';
import { TestAgent, createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts';
import { getMatchValueForSdkInput } from '../../automations/utils.ts';
import type { AgentAutomationSystem, SdkAutomationInput } from '../../automations/types.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';
import type { PathScopedRuleActivation } from '../memory/rule-matching.ts';
import { getSessionFilePath } from '../../sessions/storage.ts';

const PROJECT = '/fixture/project';
const USER_HOME = '/fixture/home/.nessy-agent';
/**
 * The common `transcript_path` every event below carries. Derived from the same
 * helper the emitter uses, so these four assertions stay about the EVENT's own
 * fields; the case at the end is the one that states what the path must be.
 */
const TRANSCRIPT_PATH = getSessionFilePath('test-workspace-id', 'test-session-id');

class InstructionsAgent extends TestAgent {
  buildPinned() { return this.buildPinnedCapabilityContext(); }
  ruleGateContext() { return this.getPathScopedRulePreToolUseContext(); }
}

function resource(absolutePath: string, kind: 'global' | 'workspace' | 'project'): NativeResourceRef {
  return {
    source: kind === 'project' ? 'project' : kind === 'workspace' ? 'workspace' : 'managed-global',
    scope: { kind, workspaceId: 'ws' },
    resourceId: absolutePath,
    absolutePath,
    revision: '1',
    contentHash: 'e'.repeat(64),
  };
}

const RULE_PATH = `${PROJECT}/.claude/rules/api.md`;
const MANAGED_PATH = '/Library/Application Support/Nessy/CLAUDE.md';
const FILES: Record<string, string> = {
  [MANAGED_PATH]: 'company-wide standards',
  // P6.387 — the `@path` that exercises the documented `include` load lives in
  // the CLAUDE.md family, which is the family `memory.md:95` states it for
  // ("Imported files are expanded and loaded into context at launch alongside
  // the CLAUDE.md that references them"). It used to hang off the user
  // MEMORY.md, where the page says the opposite: an auto-memory index's `@path`
  // names a TOPIC file, and a topic file is not loaded at startup — so that
  // fixture asserted an eager load for the one case that must not be one.
  [`${PROJECT}/CLAUDE.md`]: 'project instructions\n@./imported.md',
  [`${PROJECT}/imported.md`]: 'imported instructions',
  [`${USER_HOME}/MEMORY.md`]: 'user memory\n@./topic.md',
  [`${USER_HOME}/topic.md`]: 'topic body',
  [RULE_PATH]: '---\npaths:\n  - "src/api/**"\n---\napi rule body',
};

function runtime(generation = 'generation-instructions-1'): CapabilityTurnRuntime {
  return {
    provider: 'pi',
    projectTrustState: 'trusted',
    view: {
      generation,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [
        { key: 'instruction::project::CLAUDE.md', resource: resource(`${PROJECT}/CLAUDE.md`, 'project'), order: 3 },
        {
          key: 'instruction::project::imported.md',
          resource: resource(`${PROJECT}/imported.md`, 'project'),
          order: 3,
          importParentPath: `${PROJECT}/CLAUDE.md`,
        },
      ],
      memory: [
        { key: 'memory::global::MEMORY.md', resource: resource(`${USER_HOME}/MEMORY.md`, 'global'), readOnly: false },
        {
          // An auto-memory TOPIC file: reported by NOTHING, because it is not
          // loaded at startup (P6.387).
          key: 'memory::global::topic.md',
          resource: resource(`${USER_HOME}/topic.md`, 'global'),
          readOnly: false,
          importParentPath: `${USER_HOME}/MEMORY.md`,
        },
        { key: 'memory::project::rules::api.md', resource: resource(RULE_PATH, 'project'), readOnly: false, format: 'rule' as const },
      ],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(res: unknown) { return (res as NativeResourceRef).absolutePath; },
      async readText(res: unknown) { return FILES[(res as NativeResourceRef).absolutePath] ?? ''; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

function createAgent(): { agent: InstructionsAgent; events: SdkAutomationInput[] } {
  const events: SdkAutomationInput[] = [];
  const agent = new InstructionsAgent(createMockBackendConfig({
    workspace: createMockWorkspace(),
    session: createMockSession(),
  }));
  const automationSystem: AgentAutomationSystem = {
    async executeAgentEvent(event, input) {
      if (event === 'InstructionsLoaded') events.push(input);
      return { matchedCount: 0 };
    },
  };
  agent.setAutomationSystem(automationSystem);
  agent.setCapabilityTurnRuntime(runtime());
  return { agent, events };
}

/** Let the fire-and-forget observational emits settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('InstructionsLoaded', () => {
  it('fires once per eagerly loaded file with the documented payload', async () => {
    const { agent, events } = createAgent();

    await agent.buildPinned();
    await settle();

    // Three files enter the pinned block: the project instruction file, the file
    // that instruction file imports, and the user memory. TWO do not — the
    // `paths:` rule, which is a lazy load and reports itself when a matching
    // file is read, and the auto-memory TOPIC file, which is not loaded at
    // startup at all (P6.387).
    expect(events.map(event => event.file_path)).toEqual([
      `${PROJECT}/CLAUDE.md`,
      `${PROJECT}/imported.md`,
      `${USER_HOME}/MEMORY.md`,
    ]);
    expect(events.some(event => event.file_path === `${USER_HOME}/topic.md`)).toBe(false);
    expect(events.every(event => event.hook_event_name === 'InstructionsLoaded')).toBe(true);

    expect(events[0]).toEqual({
      hook_event_name: 'InstructionsLoaded',
      transcript_path: TRANSCRIPT_PATH,
      file_path: `${PROJECT}/CLAUDE.md`,
      memory_type: 'Project',
      load_reason: 'session_start',
    });
    // An `@path` import is the documented `include` load, and it names its
    // importer as `parent_file_path`.
    expect(events[1]).toEqual({
      hook_event_name: 'InstructionsLoaded',
      transcript_path: TRANSCRIPT_PATH,
      file_path: `${PROJECT}/imported.md`,
      memory_type: 'Project',
      load_reason: 'include',
      parent_file_path: `${PROJECT}/CLAUDE.md`,
    });
    expect(events[2]).toEqual({
      hook_event_name: 'InstructionsLoaded',
      transcript_path: TRANSCRIPT_PATH,
      file_path: `${USER_HOME}/MEMORY.md`,
      memory_type: 'User',
      load_reason: 'session_start',
    });
    // No file is reported with a `globs` or `trigger_file_path`: those are
    // "present only for `path_glob_match` loads".
    expect(events.some(event => event.globs || event.trigger_file_path)).toBe(false);

    agent.destroy();
  });

  it('reports a path-scoped rule as path_glob_match with globs and the trigger file', async () => {
    const { agent, events } = createAgent();
    await agent.buildPinned();
    await settle();
    events.length = 0;

    const gate = agent.ruleGateContext();
    const rule = gate.pathScopedRules?.rules.find(candidate => candidate.filePath === RULE_PATH);
    expect(rule).toBeDefined();
    const activation: PathScopedRuleActivation = {
      rule: rule!,
      body: 'api rule body',
      triggerFilePath: `${PROJECT}/src/api/handler.ts`,
      matchedPatterns: ['src/api/**'],
    };
    gate.pathScopedRules!.onActivated([activation]);
    await settle();

    expect(events).toEqual([{
      hook_event_name: 'InstructionsLoaded',
      transcript_path: TRANSCRIPT_PATH,
      file_path: RULE_PATH,
      memory_type: 'Project',
      load_reason: 'path_glob_match',
      globs: ['src/api/**'],
      trigger_file_path: `${PROJECT}/src/api/handler.ts`,
    }]);

    agent.destroy();
  });

  it('re-reports every eagerly loaded file as compact when compaction reloads them', async () => {
    const { agent, events } = createAgent();
    await agent.buildPinned();
    await settle();
    events.length = 0;

    agent.resetPrerequisiteState();
    await settle();

    expect(events.map(event => [event.file_path, event.load_reason])).toEqual([
      [`${PROJECT}/CLAUDE.md`, 'compact'],
      [`${PROJECT}/imported.md`, 'compact'],
      [`${USER_HOME}/MEMORY.md`, 'compact'],
    ]);

    agent.destroy();
  });

  /**
   * R65 · f207. `memory_type: 'Managed'` was an unreachable arm of
   * `instructionMemoryType`: it is returned only for `scope.kind === 'builtin'`,
   * and until the system-directory tier existed no instruction or memory record
   * was ever emitted at that scope, so no hook could observe the value.
   */
  it('reports the organization-wide system-directory file as Managed', async () => {
    const managedPath = MANAGED_PATH;
    const { agent, events } = createAgent();
    agent.setCapabilityTurnRuntime({
      ...runtime('generation-managed-1'),
      view: {
        ...runtime('generation-managed-1').view,
        promptLayers: [
          {
            key: 'instruction::builtin::-::-::managed::CLAUDE.md',
            resource: { ...resource(managedPath, 'global'), scope: { kind: 'builtin' } },
            order: 0,
          },
        ],
        memory: [],
      },
    } as unknown as CapabilityTurnRuntime);

    await agent.buildPinned();
    await settle();

    expect(events).toEqual([{
      hook_event_name: 'InstructionsLoaded',
      transcript_path: TRANSCRIPT_PATH,
      file_path: managedPath,
      memory_type: 'Managed',
      load_reason: 'session_start',
    }]);

    agent.destroy();
  });

  /**
   * R77 · f099 part B. The `include` load reason and its `parent_file_path` were
   * reachable only from a MEMORY.md import; an instruction file's `@path` import
   * became no record at all, so the file family `memory.md:95` is about could
   * never produce the documented pair.
   */
  it('reports an instruction file pulled in by a CLAUDE.md `@path` as an include', async () => {
    const importerPath = `${PROJECT}/CLAUDE.md`;
    const importedPath = `${PROJECT}/docs/git-instructions.md`;
    FILES[importerPath] = '- git workflow @docs/git-instructions.md';
    FILES[importedPath] = 'git body';
    const { agent, events } = createAgent();
    agent.setCapabilityTurnRuntime({
      ...runtime('generation-instruction-import-1'),
      view: {
        ...runtime('generation-instruction-import-1').view,
        promptLayers: [
          { key: 'instruction::project::CLAUDE.md', resource: resource(importerPath, 'project'), order: 3 },
          {
            key: 'instruction::project::import::git-instructions.md',
            resource: resource(importedPath, 'project'),
            order: 3,
            importParentPath: importerPath,
          },
        ],
        memory: [],
      },
    } as unknown as CapabilityTurnRuntime);

    await agent.buildPinned();
    await settle();

    // Both files are LOADED — the imported one rides inside its importer's body
    // rather than shipping its own block, and it still reports itself.
    expect(events).toEqual([
      {
        hook_event_name: 'InstructionsLoaded',
        transcript_path: TRANSCRIPT_PATH,
        file_path: importerPath,
        memory_type: 'Project',
        load_reason: 'session_start',
      },
      {
        hook_event_name: 'InstructionsLoaded',
        transcript_path: TRANSCRIPT_PATH,
        file_path: importedPath,
        memory_type: 'Project',
        load_reason: 'include',
        parent_file_path: importerPath,
      },
    ]);

    agent.destroy();
    FILES[importerPath] = 'project instructions';
    delete FILES[importedPath];
  });

  /**
   * P6.974 — the common field, and the question the four exact-object
   * assertions above cannot answer on their own: is this a documented field or
   * a session path leaking into a hook payload?
   *
   * `hooks.md#common-input-fields` lists `transcript_path` — *"Path to
   * conversation JSON"* — and the `InstructionsLoaded` example under
   * `#instructionsloaded-input` carries it. Documented, then. What is left to
   * check is the VALUE: it must be THIS session's transcript, and nothing from
   * the instruction files the event is about.
   */
  it('pins the session\'s own transcript on every event, and nothing else', async () => {
    const { agent, events } = createAgent();

    await agent.buildPinned();
    await settle();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const path = event.transcript_path;
      expect(typeof path).toBe('string');
      // The session store's own file for this workspace and this session — not
      // the project, not the user's instruction tree, not another session.
      expect(path!.endsWith('/sessions/test-workspace-id/test-session-id/session.jsonl')).toBe(true);
      expect(path!.startsWith(PROJECT)).toBe(false);
      expect(path!.startsWith(USER_HOME)).toBe(false);
    }

    agent.destroy();
  });

  it('matches on load_reason, not on a source string', () => {
    // hooks.md#instructionsloaded: "The matcher runs against `load_reason`."
    expect(getMatchValueForSdkInput('InstructionsLoaded', {
      hook_event_name: 'InstructionsLoaded',
      file_path: `${PROJECT}/CLAUDE.md`,
      load_reason: 'path_glob_match',
    })).toBe('path_glob_match');
    expect(getMatchValueForSdkInput('InstructionsLoaded', {
      hook_event_name: 'InstructionsLoaded',
    })).toBe('');
  });
});
