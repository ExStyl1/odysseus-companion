/**
 * Tests for the centralized PreToolUse pipeline.
 *
 * Tests `runPreToolUseChecks()` (6-step pipeline) and prompt classifiers
 * which are shared by both agent backends (ClaudeAgent, PiAgent).
 */
import { afterAll, describe, it, expect, beforeEach, mock } from 'bun:test';
// Type-only: erased at emit, so it runs no module body and cannot disturb the
// mock ordering the block below depends on.
import type { PermissionMode } from '../../mode-types.ts';
import type { PermissionManagerLike, PreToolUseInput, PrerequisiteManagerLike } from '../pre-tool-use.ts';
import type { CapabilityContext, CapabilityResolutionInputs } from '../../../capabilities/resolver.ts';
import type { NativeCapabilitySourceRecord } from '../../../capabilities/types.ts';
// F1.552: the nine REAL modules the stubs below replace, loaded and snapshotted
// BEFORE the first stub. `pre-tool-use.ts` now loads AFTER the stubs (`await
// import`, below) and must LINK against every name it imports. Measured on bun
// 1.3.14, 2026-09-24: a narrow stub of a module NOT yet loaded carries only its
// listed names, so the link failed (`Export named 'extractFileToolTargetPath'
// not found`) — and still fails with this block in place minus mode-manager's own
// snapshot; a narrow stub over a module ALREADY loaded keeps every unlisted
// export real, so with the real module loaded first even a narrow stub linked
// (215 pass). Each stub also SPREADS its snapshot, so the stub itself carries
// every name rather than leaning on that behaviour. A snapshot, never the
// namespace: `mock.module` mutates the namespace in place, so `ns` would hand
// back the mock, which is also why `afterAll` restores from these.
import * as modeManagerNs from '../../mode-manager.ts';
import * as additionalDirectoriesNs from '../../additional-directories.ts';
import * as permissionsConfigNs from '../../permissions-config.ts';
import * as pathsNs from '../../../utils/paths.ts';
import * as fsNs from 'node:fs';
import * as validatorsNs from '../../../config/validators.ts';
import * as storageNs from '../../../config/storage.ts';
import * as skillTypesNs from '../../../skills/types.ts';
import * as skillStorageNs from '../../../skills/storage.ts';
const realModeManager = { ...modeManagerNs };
const realAdditionalDirectories = { ...additionalDirectoriesNs };
const realPermissionsConfig = { ...permissionsConfigNs };
const realPaths = { ...pathsNs };
const realFs = { ...fsNs };
const realValidators = { ...validatorsNs };
const realStorage = { ...storageNs };
const realSkillTypes = { ...skillTypesNs };
const realSkillStorage = { ...skillStorageNs };

// ============================================================
// Module mocks (must be before imports of the module under test)
// ============================================================

let mockShouldAllowToolInMode = mock(
  (_toolName: string, _input: Record<string, unknown>, _mode: string, _opts?: any) =>
    ({ allowed: true, reason: '' })
);

let mockIsApiEndpointAllowed = mock(
  (_method: string, _path: string | undefined, _ctx: any) => false
);

let mockIsReadOnlyBashCommandWithConfig = mock(
  (_command: string, _config: any) => false
);

/**
 * The mode `getPermissionModeDiagnostics` reports.
 *
 * CANONICAL SPELLINGS ONLY, and that is load-bearing rather than cosmetic
 * (P3.355, 2026-09-04). `runPreToolUseChecks` reads this value VERBATIM — the
 * mock replaces the very function that would have folded a legacy alias — so a
 * pre-2026-07-31 spelling (`safe`, `ask`, `allow-all`) reached the gate
 * unnormalized and matched no branch at all. `isInteractiveWritePermissionMode`
 * (`mode-types.ts`) accepts `default`, `acceptEdits` and `auto` and nothing
 * else, so a test that set `'ask'` skipped the whole interactive branch and
 * fell through to `allow` while reading, name and all, as an ask-mode test.
 * FIFTEEN of this file's eighteen standing failures were exactly that, and two
 * of the fifteen were its sharpest form: a `shouldAllowToolInMode` double keyed
 * on `mode === 'safe'` while production probes with `'plan'`, so the two
 * cases named for the MCP-mutation prompt asserted nothing about it.
 *
 * Typed as the product's own {@link PermissionMode} rather than as a local
 * union carrying both vocabularies, so the next drift is a compile error rather
 * than a silent fall to `allow`. The alias table that maps the legacy spellings
 * (`safe` → `explore`, `ask` → `default`, `allow-all` → `bypassPermissions`)
 * lives in `mode-types.ts` and exists for VALUES READ OFF DISK — never for a
 * test double that bypasses the parser.
 */
let mockEffectivePermissionMode: PermissionMode = 'plan';

// Paths resolve from THIS file's location (core/__tests__/)
/**
 * P6.202 clause (3) — the first-read-outside resolver, mocked for the same
 * reason every other member of this module is: P6.202 recorded this stub, with
 * no spread, handing an unlisted export over as `undefined` (not reproduced on
 * 2026-09-24: a narrow stub over a loaded module kept it real); F1.552 spreads
 * the real module under it. `null` is the
 * resolver's own "do not ask" answer and is what it really returns for every
 * mode this suite drives.
 */
let mockResolveFirstOutsideRead = mock(
  (_key: any, _toolName: string, _input: unknown, _opts: any):
    { path: string; tool: string; workingDirectory?: string } | null => null
);

mock.module('../../mode-manager.ts', () => ({
  ...realModeManager,
  shouldAllowToolInMode: (a: any, b: any, c: any, d?: any) => mockShouldAllowToolInMode(a, b, c, d),
  resolveFirstOutsideWorkingDirectoryRead: (a: any, b: any, c: any, d: any) => mockResolveFirstOutsideRead(a, b, c, d),
  isApiEndpointAllowed: (a: any, b: any, c?: any) => mockIsApiEndpointAllowed(a, b, c),
  isReadOnlyBashCommandWithConfig: (a: any, b: any) => mockIsReadOnlyBashCommandWithConfig(a, b),
  getPermissionModeDiagnostics: () => ({
    permissionMode: mockEffectivePermissionMode,
    modeVersion: 7,
    lastChangedAt: '2026-02-28T18:00:00.000Z',
    lastChangedBy: 'user',
  }),
}));

// The configured additional roots the production gate must forward. Mocked so
// the assertion does not depend on the developer's own config.json.
let mockConfiguredAdditionalDirectories: string[] = [];

mock.module('../../additional-directories.ts', () => ({
  ...realAdditionalDirectories,
  getConfiguredAdditionalDirectories: () => mockConfiguredAdditionalDirectories,
}));

// Mock permissionsConfigCache for read-only bash pattern checks
let mockReadOnlyBashPatterns: Array<{ regex: RegExp }> = [];

mock.module('../../permissions-config.ts', () => ({
  ...realPermissionsConfig,
  permissionsConfigCache: {
    getMergedConfig: () => ({
      readOnlyBashPatterns: mockReadOnlyBashPatterns,
    }),
  },
}));

// Mock expandPath to avoid real home directory resolution
mock.module('../../../utils/paths.ts', () => ({
  ...realPaths,
  expandPath: (p: string) => p.replace(/^~/, '/Users/test'),
}));

// Mock filesystem for config validation and skill qualification
mock.module('node:fs', () => ({
  ...realFs,
  existsSync: (_path: string) => false,
  readFileSync: (_path: string) => '',
}));

// Mock config validators (used by validateConfigWrite + CLI redirect)
let mockDetectConfigFileType = mock((_path: string, _workspaceRootPath?: string) => null as any);
let mockDetectAppConfigFileType = mock((_path: string) => null as any);
let mockValidateConfigFileContent = mock((_type: any, _content: string) => null as any);

mock.module('../../../config/validators.ts', () => ({
  ...realValidators,
  detectConfigFileType: (a: any, b: any) => mockDetectConfigFileType(a, b),
  detectAppConfigFileType: (a: any) => mockDetectAppConfigFileType(a),
  validateConfigFileContent: (a: any, b: any) => mockValidateConfigFileContent(a, b),
  formatValidationResult: () => '',
}));

// The real `PrerequisiteManager` drives the step-6b grant tests (a double would
// pass while production kept prompting). Its ONLY config dependency is the
// browser-tool rule's `getBrowserToolEnabled`, which would otherwise read the
// isolated temp config dir and throw on the absent config-defaults.json.
mock.module('../../../config/storage.ts', () => ({
  ...realStorage,
  getBrowserToolEnabled: () => false,
  // P6.202's read fence (`cb35373f4`) added a SECOND config read to
  // `evaluatePreToolUseChecks` itself, and this mock did not list it — so the real
  // `getBlockReadsOutsideWorkingDirectories` kept running, and it throws here
  // because `node:fs`'s `existsSync` is mocked to `false` above and
  // `loadConfigDefaults` refuses an absent `config-defaults.json`. That took the
  // file from the 205/0 the known-failing register records on 2026-09-04 to
  // 39 pass / 170 fail, in a suite `bun test` does not discover by filename.
  // `false` is `config-defaults.json`'s own shipped default for the key.
  getBlockReadsOutsideWorkingDirectories: () => false,
}));

// Mock skill constants
mock.module('../../../skills/types.ts', () => ({
  ...realSkillTypes,
  AGENTS_PLUGIN_NAME: '.agents',
}));

mock.module('../../../skills/storage.ts', () => ({
  ...realSkillStorage,
  GLOBAL_AGENT_SKILLS_DIR: '/Users/test/.agents/skills',
  PROJECT_AGENT_SKILLS_DIR: '.agents/skills',
}));

// F1.552: every stub restored from its snapshot, never from a namespace (which
// now holds the mock). `test:isolated` gives this file its own process, so the
// restore protects no other file today; it keeps the recipe whole.
afterAll(() => {
  mock.module('../../mode-manager.ts', () => realModeManager);
  mock.module('../../additional-directories.ts', () => realAdditionalDirectories);
  mock.module('../../permissions-config.ts', () => realPermissionsConfig);
  mock.module('../../../utils/paths.ts', () => realPaths);
  mock.module('node:fs', () => realFs);
  mock.module('../../../config/validators.ts', () => realValidators);
  mock.module('../../../config/storage.ts', () => realStorage);
  mock.module('../../../skills/types.ts', () => realSkillTypes);
  mock.module('../../../skills/storage.ts', () => realSkillStorage);
});

// ============================================================
// Import module under test (after mocks)
// ============================================================
// F1.552 (F1.133): every VALUE loads by `await import` AFTER the stubs above — a
// static import is hoisted above the module body, whatever line it is written
// on, and would link these modules against the REAL ones before any stub ran.

const { operandPolicyProvesRead, undeclaredProvenReadCommands } = await import('../../bash-validator.ts');
const {
  promptIsClassifierAdjudicated,
  promptIsNonNegotiable,
  runPreToolUseChecks,
  shouldPromptInAskMode,
  shouldPromptInAutoMode,
} = await import('../pre-tool-use.ts');
const { PrerequisiteManager } = await import('../prerequisite-manager.ts');
const { createCapabilityResolver } = await import('../../../capabilities/resolver.ts');
const { toAgentRuntime } = await import('../../../capabilities/views.ts');

// ============================================================
// Test helpers
// ============================================================

function createMockPermissionManager(overrides?: Partial<PermissionManagerLike>): PermissionManagerLike {
  return {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
    ...overrides,
  };
}

function createMockPrerequisiteManager(overrides?: Partial<PrerequisiteManagerLike>): PrerequisiteManagerLike {
  return {
    checkPrerequisites: () => ({ allowed: true }),
    checkBashPrerequisites: () => ({ allowed: true }),
    ...overrides,
  };
}

function createInput(overrides?: Partial<PreToolUseInput>): PreToolUseInput {
  return {
    toolName: 'Read',
    input: { file_path: '/test/file.ts' },
    sessionId: 'test-session',
    sessionKey: { workspaceId: 'test-ws-id', sessionId: 'test-session' },
    permissionMode: 'bypassPermissions',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-ws',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: true,
    permissionManager: createMockPermissionManager(),
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('runPreToolUseChecks', () => {
  beforeEach(() => {
    mockEffectivePermissionMode = 'plan';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockIsApiEndpointAllowed.mockReset();
    mockIsApiEndpointAllowed.mockImplementation(() => false);
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockReadOnlyBashPatterns = [];
    mockConfiguredAdditionalDirectories = [];
    mockResolveFirstOutsideRead.mockReset();
    mockResolveFirstOutsideRead.mockImplementation(() => null);
  });

  // ============================================================
  // P6.202 clause (3): auto mode's first read outside the working directories
  // ============================================================

  describe('P6.202 (3): the first read outside the working directories', () => {
    it('turns the resolver\'s payload into the outside_root prompt, with the gate\'s own two inputs attached', () => {
      // The defect this pins is a MISSING PRODUCER, not missing logic: the
      // resolver and the card both shipped and nothing called the one from the
      // other. So drive the real gate and assert the CALL and the prompt.
      mockConfiguredAdditionalDirectories = ['/other/repo'];
      mockResolveFirstOutsideRead.mockImplementation(() => ({
        path: '/elsewhere/notes.md',
        tool: 'Read',
        workingDirectory: '/test/project',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/elsewhere/notes.md' },
        workingDirectory: '/test/project',
        interactive: true,
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('outside_root');
        expect(result.outsideWorkingDirectoryRead).toEqual({
          path: '/elsewhere/notes.md',
          tool: 'Read',
          workingDirectory: '/test/project',
        });
        // The three answers persist a SETTING, so a hook `allow` must never
        // stand in for the human here.
        expect(result.nonNegotiable).toBeUndefined();
      }

      const options = mockResolveFirstOutsideRead.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(options?.interactive).toBe(true);
      expect(options?.workingDirectory).toBe('/test/project');
      expect(options?.blockReadsOutsideWorkingDirectories).toBe(false);
      expect(options?.additionalDirectories).toEqual(['/other/repo']);
    });

    it('says the session is NOT interactive when the caller did not answer, and prompts nothing', () => {
      // "The prompt doesn't appear in non-interactive `-p` runs or background
      // sessions; reads there run as before." Absence is that sentence's own
      // outcome, so an untaught caller keeps HEAD's behaviour exactly.
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/elsewhere/notes.md' },
        workingDirectory: '/test/project',
      }));

      expect(result.type).not.toBe('prompt');
      const options = mockResolveFirstOutsideRead.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(options?.interactive).toBeUndefined();
    });

    it('never asks about a read the mode already refused', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Read is not allowed here',
      }));
      mockResolveFirstOutsideRead.mockImplementation(() => ({
        path: '/elsewhere/notes.md',
        tool: 'Read',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/elsewhere/notes.md' },
        workingDirectory: '/test/project',
        interactive: true,
      }));

      expect(result.type).toBe('block');
      expect(mockResolveFirstOutsideRead).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Step 1: Permission mode check
  // ============================================================

  describe('step 1: permission mode check', () => {
    it('uses only the pinned capability permission context when present', () => {
      const pinned = {
        workspaceRootPath: '/pinned/workspace',
        pinnedRevision: 'generation-1',
        pinnedConfigs: [],
      };
      runPreToolUseChecks(createInput({
        activeSourceSlugs: ['disk-source'],
        permissionManager: createMockPermissionManager({
          getCapabilityPermissionsContext: () => pinned,
        }),
      }));

      expect(mockShouldAllowToolInMode.mock.calls[0]?.[3]).toMatchObject({
        permissionsContext: pinned,
      });
    });

    it('reaches shouldAllowToolInMode with the roots actually configured', () => {
      // The defect this pins is a MISSING ARGUMENT, not missing logic:
      // shouldAllowToolInMode already implements additionalDirectories end to
      // end, so a test that drove it directly would pass while production kept
      // passing nothing. Drive the real gate and assert the argument arrives.
      mockConfiguredAdditionalDirectories = ['/other/repo'];
      runPreToolUseChecks(createInput());
      expect(mockShouldAllowToolInMode.mock.calls[0]?.[3]?.additionalDirectories).toEqual(['/other/repo']);
    });

    it('blocks when shouldAllowToolInMode returns not allowed', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Bash is not allowed in Explore mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'plan',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Bash is not allowed in Explore mode');
        expect(result.reason).toContain('Effective mode: Plan');
        expect(result.reason).toContain('Last mode change: user at 2026-02-28T18:00:00.000Z (modeVersion=7)');
      }
    });

    it('passes through when shouldAllowToolInMode allows', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('prompts when shouldAllowToolInMode requires permission', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: true,
        reason: '',
        requiresPermission: true,
        description: 'Tool requires approval by rule',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm install left-pad' },
        permissionMode: 'plan',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
        expect(result.description).toBe('Tool requires approval by rule');
        expect(result.command).toBe('npm install left-pad');
      }
    });

    it('passes correct args to shouldAllowToolInMode', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'plan',
        plansFolderPath: '/test/plans',
        dataFolderPath: '/test/data',
        workspaceRootPath: '/test/workspace',
        activeSourceSlugs: ['linear'],
      }));

      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'plan',
        {
          plansFolderPath: '/test/plans',
          dataFolderPath: '/test/data',
          additionalDirectories: [],
          permissionsContext: {
            workspaceRootPath: '/test/workspace',
            activeSourceSlugs: ['linear'],
          },
          // P6.202's read fence (`cb35373f4`) — the second half of the same
          // omission as the storage mock above: the fence's two inputs are
          // forwarded on EVERY call and this exact-shape pin was never updated,
          // so the case reported them as unexpected. `undefined` because
          // `createInput` names no `workingDirectory`.
          workingDirectory: undefined,
          blockReadsOutsideWorkingDirectories: false,
          // R21: plan mode's shell band is opt-in and THIS is the only caller
          // that opts in, because it is the model's own gate. The three
          // host-side callers (plugin command hooks, skill-context commands,
          // plugin hooks) must NOT set it — they cannot reach the classifier,
          // and an unscoped band turned every plan-mode plugin hook into an
          // unconditional modal. Pinned here so a future caller cannot quietly
          // inherit it.
          allowPlanShellReview: true,
        }
      );
    });

    it('uses effective mode from mode-manager diagnostics when incoming mode is stale', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'bypassPermissions', // stale incoming value
      }));

      // Mocked diagnostics returns permissionMode='plan', which must be
      // authoritative over the stale incoming `bypassPermissions`.
      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'plan',
        expect.any(Object)
      );
    });
  });

  // ============================================================
  // Step 2: Source blocking
  // ============================================================

  describe('step 2: source blocking', () => {
    /**
     * P3.355, 2026-09-04 — this case's PREMISE was removed on purpose, and this
     * file never ran where the removing commit could see it.
     *
     * It used to build a two-record collision (`source:ws:fs` + `mcp:ws:fs`,
     * same logical name) and read a live, collision-qualified wire name off the
     * SOURCE. `8e27f1a23` ("connect a duplicate MCP name once, from the nearest
     * scope") ended that shape: the scoped tier now picks ONE winner, which
     * keeps the BARE name, and shadows the rest (`enabled: false`,
     * `unavailableReason: 'shadowed-by-mcp-precedence'`), and `toAgentRuntime`
     * filters shadowed entries out of the runtime view. Its own message says it
     * rewrote *"two tests [that] pinned the old two-survivor shape"* — this was
     * the third, and it was invisible to `bun test` because `.isolated.ts` is
     * not a discovered filename. So there is no such thing as a LIVE
     * collision-qualified scoped source any more: it either wins the bare name
     * or leaves the view. Only plugin-origin entries carry a qualified name and
     * stay live, and they never contend for the bare one.
     *
     * The SUBJECT survives and is what this case now drives: step 2 must accept
     * an MCP tool addressed by the wire name the resolver actually minted for a
     * source-transport MCP capability. The collision's documented outcome is
     * pinned as its own case below rather than deleted.
     */
    it('allows a Source MCP tool addressed by the wire name the resolver minted', async () => {
      const scope = { kind: 'workspace' as const, workspaceId: 'test-ws' };
      const records: NativeCapabilitySourceRecord[] = [
        {
          key: 'source:ws:fs',
          kind: 'source',
          logicalName: 'fs',
          sourceType: 'mcp',
          scope,
          sourcePath: '/abs/source-fs',
          revision: 'r1',
          contentHash: 'a'.repeat(64),
          mutable: true,
        },
      ];
      const inputs: CapabilityResolutionInputs = {
        nativeInventory: { records, blockedLayers: [] },
        installedPlugins: [],
        activePluginInstances: {},
        pluginCandidates: [],
        resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
        resolveTrust: () => 'trusted',
      };
      const context: CapabilityContext = {
        workspaceId: 'test-ws',
        sessionId: 'test-session',
        projectTrustState: 'trusted',
        projectTrustRevision: 'trust-r1',
      };
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(context);

      try {
        const runtime = toAgentRuntime(snapshot);
        const wireName = runtime.sources.find(source => source.key === 'source:ws:fs')?.mcpWireName;
        expect(wireName).toBeTruthy();
        expect(wireName).not.toContain('__');

        const result = runPreToolUseChecks(createInput({
          toolName: `mcp__${wireName}__read`,
          input: {},
          activeSourceSlugs: [wireName!],
          allSourceSlugs: [wireName!],
        }));

        expect(result.type).toBe('allow');
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId);
      }
    });

    /**
     * The documented collision outcome, kept here so the case above cannot be
     * mistaken for the whole story. `mcp.md`: *"When the same server is defined
     * in more than one place, Claude Code connects to it once, using the
     * definition from the highest-precedence source."*
     *
     * The emptiness half is not asserted alone — a projection that returned
     * nothing at all would satisfy it. The `mcpServers` assertions are its
     * positive control: the winner IS projected, under the bare name.
     */
    it('connects a duplicate MCP name once and shadows the loser out of the runtime view', async () => {
      const scope = { kind: 'workspace' as const, workspaceId: 'test-ws' };
      const records: NativeCapabilitySourceRecord[] = [
        {
          key: 'source:ws:fs',
          kind: 'source',
          logicalName: 'fs',
          sourceType: 'mcp',
          scope,
          sourcePath: '/abs/source-fs',
          revision: 'r1',
          contentHash: 'a'.repeat(64),
          mutable: true,
        },
        {
          key: 'mcp:ws:fs',
          kind: 'mcp',
          logicalName: 'fs',
          scope,
          sourcePath: '/abs/mcp-fs',
          revision: 'r1',
          contentHash: 'b'.repeat(64),
          mutable: true,
        },
      ];
      const inputs: CapabilityResolutionInputs = {
        nativeInventory: { records, blockedLayers: [] },
        installedPlugins: [],
        activePluginInstances: {},
        pluginCandidates: [],
        resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
        resolveTrust: () => 'trusted',
      };
      const context: CapabilityContext = {
        workspaceId: 'test-ws',
        sessionId: 'test-session',
        projectTrustState: 'trusted',
        projectTrustRevision: 'trust-r1',
      };
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(context);

      try {
        const runtime = toAgentRuntime(snapshot);
        // POSITIVE CONTROL: the projection ran, and the winner is connected
        // under the BARE name — not a qualified one.
        expect(runtime.mcpServers.map(server => server.key)).toEqual(['mcp:ws:fs']);
        expect(runtime.mcpServers[0]?.wireName).toBe('fs');
        // THE FINDING: the shadowed source does not reach the runtime view.
        expect(runtime.sources).toEqual([]);
        // And it says so, naming the winner.
        expect(snapshot.diagnostics.some(diagnostic =>
          diagnostic.code === 'capability.collision.mcp-scope-precedence'
          && diagnostic.capabilityKey === 'mcp:ws:fs')).toBe(true);
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId);
      }
    });

    it('returns source_activation_needed for inactive MCP source (exists)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('source_activation_needed');
      if (result.type === 'source_activation_needed') {
        expect(result.sourceSlug).toBe('linear');
        expect(result.sourceExists).toBe(true);
      }
    });

    it('returns source_activation_needed for inactive MCP source (not exists)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__notion__search',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: [],
      }));

      expect(result.type).toBe('source_activation_needed');
      if (result.type === 'source_activation_needed') {
        expect(result.sourceSlug).toBe('notion');
        expect(result.sourceExists).toBe(false);
      }
    });

    it('allows active MCP source tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('allow');
    });

    it('skips source activation for capability-projected MCP servers', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__dpGitlab__dp_gitlab_merge-request',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: [],
        nonSourceMcpServerNames: ['dpGitlab'],
      }));

      expect(result.type).toBe('allow');
    });

    it('skips source check for built-in MCP servers (session)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input: {},
        activeSourceSlugs: [],
      }));

      // Should reach step 4 (call_llm intercept), not blocked at step 2
      expect(result.type).toBe('call_llm_intercept');
    });

    it('requires activation for non-builtin MCP servers', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__docs__search',
        input: {},
        activeSourceSlugs: [],
      }));

      expect(result.type).toBe('source_activation_needed');
    });

    it('skips source check for non-MCP tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 3: Prerequisite check
  // ============================================================

  describe('step 3: prerequisite check', () => {
    it('blocks when prerequisites are not met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({
          allowed: false,
          blockReason: 'Please read the guide.md for linear before using its tools.',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('guide.md');
      }
    });

    it('passes when prerequisites are met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({ allowed: true }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('allow');
    });

    // UB7.12 — Bash goes to checkBashPrerequisites with its command, so a shell
    // read of a guide counts like the Read tool (upstream v0.15.1).
    it('sends Bash calls to checkBashPrerequisites with their command', () => {
      const checkBashPrerequisites = mock((_command: string) => ({ allowed: true }));
      const checkPrerequisites = mock((_toolName: string) => ({ allowed: true }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'cat ~/.nessy/docs/browser-tools.md' },
        prerequisiteManager: createMockPrerequisiteManager({ checkBashPrerequisites, checkPrerequisites }),
      }));

      expect(result.type).toBe('allow');
      expect(checkBashPrerequisites).toHaveBeenCalledWith('cat ~/.nessy/docs/browser-tools.md');
      expect(checkPrerequisites).not.toHaveBeenCalled();
    });

    it('blocks a Bash call that checkBashPrerequisites holds back', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        prerequisiteManager: createMockPrerequisiteManager({
          checkBashPrerequisites: () => ({ allowed: false, blockReason: 'You must read the guide first.' }),
        }),
      }));

      expect(result).toEqual({ type: 'block', reason: 'You must read the guide first.', source: 'prerequisite' });
    });

    it('passes an empty command when the Bash input has none', () => {
      const checkBashPrerequisites = mock((_command: string) => ({ allowed: true }));

      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: {},
        prerequisiteManager: createMockPrerequisiteManager({ checkBashPrerequisites }),
      }));

      expect(checkBashPrerequisites).toHaveBeenCalledWith('');
    });

    it('skips when no prerequisiteManager provided', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        // No prerequisiteManager
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 4: call_llm interception
  // ============================================================

  describe('step 4: call_llm interception', () => {
    it('intercepts mcp__session__call_llm', () => {
      const input = { model: 'haiku', prompt: 'summarize' };
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input,
      }));

      expect(result.type).toBe('call_llm_intercept');
      if (result.type === 'call_llm_intercept') {
        expect(result.input).toEqual(input);
      }
    });

    it('does not intercept other session tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__SubmitPlan',
        input: {},
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 5: Input transforms
  // ============================================================

  describe('step 5: input transforms', () => {
    it('expands tilde paths and returns modify', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/Documents/file.ts' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/Documents/file.ts');
      }
    });

    it('does not modify non-tilde paths', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/absolute/path/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('strips _intent and _displayName metadata', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: { title: 'Bug fix', _intent: 'create issue', _displayName: 'Create Issue' },
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.title).toBe('Bug fix');
        expect(result.input._intent).toBeUndefined();
        expect(result.input._displayName).toBeUndefined();
      }
    });

    it('combines path expansion and metadata stripping', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/test.ts', _intent: 'reading a file' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/test.ts');
        expect(result.input._intent).toBeUndefined();
      }
    });

    it('allows direct label folder reads', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/workspace/labels/config.json' },
      }));

      expect(result.type).toBe('allow');
    });

    it('allows direct label config writes', () => {
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('allow');
    });

    it('allows direct source config edits', () => {
      mockDetectConfigFileType.mockImplementation(() => ({
        type: 'source',
        slug: 'linear',
        displayFile: 'sources/linear/config.json',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/sources/linear/config.json',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('allow');
    });

    it('allows direct skill file edits', () => {
      mockDetectConfigFileType.mockImplementation(() => ({
        type: 'skill',
        slug: 'commit-helper',
        displayFile: 'skills/commit-helper/SKILL.md',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/skills/commit-helper/SKILL.md',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('allow');
    });

    it('allows bash commands touching labels paths', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py labels/config.json' },
        permissionMode: 'bypassPermissions',
      }));

      expect(result.type).toBe('allow');
    });

    it('allows direct automations config reads', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/workspace/automations.json' },
      }));

      expect(result.type).toBe('allow');
    });

    for (const toolName of ['Write', 'Edit'] as const) {
      it(`blocks direct ${toolName} operations on automations.json with tool guidance`, () => {
        const result = runPreToolUseChecks(createInput({
          toolName,
          input: toolName === 'Write'
            ? { file_path: '/test/workspace/automations.json', content: '{}' }
            : {
              file_path: '/test/workspace/automations.json',
              old_string: 'A',
              new_string: 'B',
            },
        }));

        expect(result.type).toBe('block');
        if (result.type === 'block') {
          expect(result.reason).toContain('automations.json');
          expect(result.reason).toContain('automation_create');
          expect(result.reason).toContain('automation_update');
          expect(result.reason).toContain('automation_validate');
          expect(result.reason).not.toContain('nessy-general-agent automation');
        }
      });
    }

    it('blocks direct writes to automations-history.jsonl with tool guidance', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/automations-history.jsonl', content: '{}' },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('automations-history.jsonl');
        expect(result.reason).toContain('automation_create');
        expect(result.reason).toContain('automation_update');
        expect(result.reason).toContain('automation_validate');
        expect(result.reason).not.toContain('nessy-general-agent automation');
      }
    });

    it('blocks bash commands touching automations.json with tool guidance', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'bypassPermissions',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('automations.json');
        expect(result.reason).toContain('automation_create');
        expect(result.reason).toContain('automation_update');
        expect(result.reason).toContain('automation_validate');
        expect(result.reason).not.toContain('nessy-general-agent automation');
      }
    });

    it('blocks bash commands touching automations-history.jsonl with tool guidance', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'node scripts/read-history.js automations-history.jsonl' },
        permissionMode: 'bypassPermissions',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('automations-history.jsonl');
        expect(result.reason).toContain('automation_create');
        expect(result.reason).toContain('automation_update');
        expect(result.reason).toContain('automation_validate');
        expect(result.reason).not.toContain('nessy-general-agent automation');
      }
    });

    it('does not block unrelated non-workspace labels paths in bash commands', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 script.py /tmp/labels/config.json' },
        permissionMode: 'bypassPermissions',
      }));

      expect(result.type).toBe('allow');
    });

    it('wraps approved Bash commands with macOS seatbelt when opt-in is enabled', () => {
      mockEffectivePermissionMode = 'bypassPermissions';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'printf ok' },
        permissionMode: 'bypassPermissions',
        workingDirectory: '/test/workspace',
        bashSeatbeltSandboxContext: {
          enabled: true,
          cwd: '/test/workspace',
          platform: 'darwin',
          sandboxExecAvailable: true,
        },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.command).toContain('sandbox-exec -p');
        expect(result.input.command).toContain('/bin/bash -lc');
        expect(result.input.command).toContain('printf ok');
      }
    });

    it('wraps approved Bash commands with session plans and data write paths', () => {
      mockEffectivePermissionMode = 'bypassPermissions';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'printf ok > /test/session/data/result.txt' },
        permissionMode: 'bypassPermissions',
        workingDirectory: '/test/workspace',
        bashSeatbeltSandboxContext: {
          enabled: true,
          cwd: '/test/workspace',
          writablePaths: ['/test/session/plans', '/test/session/data'],
          platform: 'darwin',
          sandboxExecAvailable: true,
        },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        if (typeof result.input.command === 'string' && result.input.command.includes('(allow default)')) {
          expect(result.input.command).toContain('(version 1) (allow default)');
          return;
        }
        expect(result.input.command).toContain('(allow file-write* (subpath "/test/workspace"))');
        expect(result.input.command).toContain('(allow file-write* (subpath "/test/session/plans"))');
        expect(result.input.command).toContain('(allow file-write* (subpath "/test/session/data"))');
      }
    });

    it('leaves approved Bash commands unchanged when macOS seatbelt opt-in is disabled', () => {
      mockEffectivePermissionMode = 'bypassPermissions';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'printf ok' },
        permissionMode: 'bypassPermissions',
        bashSeatbeltSandboxContext: {
          enabled: false,
          cwd: '/test/workspace',
          platform: 'darwin',
          sandboxExecAvailable: true,
        },
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 6: Ask-mode prompt decision
  // ============================================================

  describe('step 6: ask-mode prompt decision', () => {
    beforeEach(() => {
      mockEffectivePermissionMode = 'default';
    });

    it('prompts for bash commands in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm install express' },
        permissionMode: 'default',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
        expect(result.command).toBe('npm install express');
      }
    });

    it('prompts for file write tools in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/file.ts', content: 'hello' },
        permissionMode: 'default',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
        expect(result.description).toContain('/test/file.ts');
      }
    });

    it('prompts for Edit in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: { file_path: '/test/file.ts', old_string: 'a', new_string: 'b' },
        permissionMode: 'default',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
      }
    });

    it('auto-allows file writes inside the session roots in acceptEdits mode', () => {
      mockEffectivePermissionMode = 'acceptEdits';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/file.ts', content: 'hello' },
        permissionMode: 'acceptEdits',
      }));

      expect(result.type).toBe('allow');
    });

    it('prompts for a file write outside every root in acceptEdits mode', () => {
      // acceptEdits used to auto-approve a write anywhere on disk.
      mockEffectivePermissionMode = 'acceptEdits';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/elsewhere/file.ts', content: 'hello' },
        permissionMode: 'acceptEdits',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
      }
    });

    it('still prompts for bash commands in acceptEdits mode', () => {
      mockEffectivePermissionMode = 'acceptEdits';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm install express' },
        permissionMode: 'acceptEdits',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
      }
    });

    it('auto-allows low-risk bash commands in auto mode', () => {
      mockEffectivePermissionMode = 'auto';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm test' },
        permissionMode: 'auto',
      }));

      expect(result.type).toBe('allow');
    });

    it('still prompts for risky bash commands in auto mode', () => {
      mockEffectivePermissionMode = 'auto';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        permissionMode: 'auto',
        permissionManager: createMockPermissionManager({
          isDangerousCommand: (cmd) => cmd === 'rm',
        }),
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
      }
    });

    // NOT `rm -rf /`, which this case used to carry: root and home removals are
    // the one documented exception that prompts in allow-all too (see the
    // "removal circuit breaker" suite at the end of this file).
    it('does not prompt in allow-all mode', () => {
      mockEffectivePermissionMode = 'bypassPermissions';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        permissionMode: 'bypassPermissions',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not prompt in safe mode (blocked at step 1 instead)', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Blocked in safe mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'plan',
      }));

      expect(result.type).toBe('block');
    });

    it('includes modifiedInput in prompt when transforms changed the input', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '~/test.ts', content: 'hello', _intent: 'write file' },
        permissionMode: 'default',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeDefined();
        expect(result.modifiedInput!.file_path).toBe('/Users/test/test.ts');
        expect(result.modifiedInput!._intent).toBeUndefined();
      }
    });

    it('omits modifiedInput in prompt when no transforms applied', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm test' },
        permissionMode: 'default',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeUndefined();
      }
    });

    it('keeps ask-mode Bash prompt on the original command while passing sandboxed input', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm test' },
        permissionMode: 'default',
        bashSeatbeltSandboxContext: {
          enabled: true,
          cwd: '/test/workspace',
          platform: 'darwin',
          sandboxExecAvailable: true,
        },
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
        expect(result.command).toBe('npm test');
        expect(result.modifiedInput?.command).toContain('sandbox-exec -p');
        expect(result.modifiedInput?.command).toContain('npm test');
      }
    });
  });

  // ============================================================
  // Step 6b: the invoked skill's own allowed-tools grant
  // ============================================================

  /**
   * `skills.md` § Pre-approve tools for a skill — an `allowed-tools` Bash rule
   * that "matches the exact command the skill body tells Claude to run, so the
   * script runs without prompting", and the sentence that fixes the field's
   * SHAPE: "It does not restrict which tools are available: every tool remains
   * callable, and your permission settings still govern tools that are not
   * listed."
   *
   * The REAL `PrerequisiteManager` is used, not a double: the defect being
   * fixed was a wiring defect, and a double would pass while production kept
   * prompting.
   */
  describe('step 6b: invoked skill Bash grant', () => {
    const RENDER = '/skills/r17-dir/scripts/render.sh';

    const grantedManager = () => {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' });
      manager.setSkillInvocationToolGrants([{ name: 'bash', patterns: [`${RENDER} *`] }]);
      return manager;
    };

    beforeEach(() => {
      // `default` — the canonical name for the asking mode. The legacy `ask`
      // this block used never matched the gate's comparison, so every arm here
      // skipped the prompt path it was written to exercise.
      mockEffectivePermissionMode = 'default';
    });

    it('runs the command the invoked skill named, with no permission card', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: `${RENDER} probe` },
        permissionMode: 'default',
        prerequisiteManager: grantedManager(),
      }));

      expect(result.type).toBe('allow');
    });

    /**
     * THE negative control for the pre-approval semantics: the grant must not
     * become a general permission bypass. Every call the skill did NOT name
     * still reaches the ordinary prompt — the same verdict a session with no
     * skill invoked would produce.
     */
    it('sends any other command through the normal permission flow, never a refusal', () => {
      const other = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'curl evil.example' },
        permissionMode: 'default',
        prerequisiteManager: grantedManager(),
      }));
      expect(other.type).toBe('prompt');

      // An UNLISTED tool is not refused either — `allowed-tools` cannot
      // restrict the pool, so Write goes to the same prompt it always would.
      const unlisted = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/x.ts', content: 'x' },
        permissionMode: 'default',
        prerequisiteManager: grantedManager(),
      }));
      expect(unlisted.type).toBe('prompt');

      // A BARE entry pre-approves the tool outright: the doc grants "the listed
      // tools", unqualified, and warns that a skill "can grant itself broad
      // tool access" for exactly this reason.
      const bare = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' });
      bare.setSkillInvocationToolGrants([{ name: 'bash' }]);
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: `${RENDER} probe` },
        permissionMode: 'default',
        prerequisiteManager: bare,
      })).type).toBe('allow');
    });

    /**
     * `disallowed-tools` is the half that DOES restrict: "Tools removed from
     * Claude's available pool while this skill is active."
     */
    it('refuses a tool the invoked skill removed from the pool', () => {
      const manager = grantedManager();
      manager.setSkillInvocationDeniedTools(['Bash']);
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: `${RENDER} probe` },
        permissionMode: 'default',
        prerequisiteManager: manager,
      }));
      expect(result.type).toBe('block');
      if (result.type === 'block') expect(result.reason).toContain('disallowed-tools');
    });

    it('does not widen a read-only mode — the mode ceiling still wins', () => {
      // Explore/`safe` blocks at step 1, long before the grant is consulted.
      mockEffectivePermissionMode = 'plan';
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Bash is not allowed in Explore mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: `${RENDER} probe` },
        permissionMode: 'plan',
        prerequisiteManager: grantedManager(),
      }));

      expect(result.type).toBe('block');
    });

    // "The grant clears when you send your next message" — `chat`'s `finally`
    // calls `clearSkillInvocation()`, so the next user message starts without it.
    it('does not survive the turn it was granted for', () => {
      const manager = grantedManager();
      const call = () => runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: `${RENDER} probe` },
        permissionMode: 'default',
        prerequisiteManager: manager,
      }));

      expect(call().type).toBe('allow');
      manager.clearSkillInvocation();
      expect(call().type).toBe('prompt');
    });
  });

  // ============================================================
  // Pipeline ordering
  // ============================================================

  describe('pipeline ordering', () => {
    it('permission check runs before source blocking', () => {
      // If tool is blocked by mode, source blocking should not run
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        permissionMode: 'plan',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Not allowed');
        expect(result.reason).toContain('Effective mode: Plan');
      }
    });

    it('source blocking runs before prerequisite check', () => {
      // Inactive source → source_activation_needed (not prerequisite block)
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({
          allowed: false,
          blockReason: 'Read guide.md first',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('source_activation_needed');
    });

    it('prerequisite check runs before call_llm interception', () => {
      // This scenario is contrived (call_llm is from session server which is exempt
      // from prerequisites), but validates pipeline order for other session tools
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: (toolName: string) => {
          if (toolName === 'mcp__custom__some_tool') {
            return { allowed: false, blockReason: 'blocked' };
          }
          return { allowed: true };
        },
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__custom__some_tool',
        input: {},
        activeSourceSlugs: ['custom'],
        allSourceSlugs: ['custom'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
    });

    it('call_llm interception runs before transforms', () => {
      // call_llm should be intercepted even if input has metadata
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input: { model: 'haiku', _intent: 'summarize' },
      }));

      expect(result.type).toBe('call_llm_intercept');
      if (result.type === 'call_llm_intercept') {
        // Input should be passed through unmodified (no stripping)
        expect(result.input._intent).toBe('summarize');
      }
    });
  });

  // ============================================================
  // Debug callback
  // ============================================================

  describe('debug callback', () => {
    it('calls onDebug when tool is blocked by mode', () => {
      const debugMessages: string[] = [];
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed in Explore mode',
      }));

      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'plan',
        onDebug: (msg) => debugMessages.push(msg),
      }));

      // The incoming mode and the effective mode agree here, so no `[ModeSync]`
      // line is emitted and `debugMessages[0]` IS the blocking line this case is
      // named for. While the effective mode was the unnormalized `'safe'` the
      // two disagreed, the ModeSync line took index 0, and the case failed on
      // the tool name — a vocabulary artefact, not a debug-callback defect.
      expect(debugMessages.length).toBeGreaterThan(0);
      expect(debugMessages[0]).toContain('plan');
      expect(debugMessages[0]).toContain('Bash');
    });

    it('calls onDebug for source activation', () => {
      const debugMessages: string[] = [];

      runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        onDebug: (msg) => debugMessages.push(msg),
      }));

      expect(debugMessages.some(m => m.includes('linear'))).toBe(true);
    });
  });
});

// ============================================================
// shouldPromptInAskMode
// ============================================================

describe('shouldPromptInAskMode', () => {
  let pm: PermissionManagerLike;

  beforeEach(() => {
    pm = createMockPermissionManager();
    mockShouldAllowToolInMode.mockReset();
    mockIsApiEndpointAllowed.mockReset();
    mockIsApiEndpointAllowed.mockImplementation(() => false);
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockReadOnlyBashPatterns = [];
  });

  // --- File writes ---

  describe('file write tools', () => {
    it('prompts for Write tool', () => {
      const result = shouldPromptInAskMode('Write', { file_path: '/test/file.ts', content: 'x' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/file.ts');
    });

    it('prompts for Edit tool', () => {
      const result = shouldPromptInAskMode('Edit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for MultiEdit tool', () => {
      const result = shouldPromptInAskMode('MultiEdit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for NotebookEdit with notebook_path', () => {
      const result = shouldPromptInAskMode('NotebookEdit', { notebook_path: '/test/nb.ipynb' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/nb.ipynb');
    });

    it('auto-allows whitelisted file write tools', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'Write',
      });

      const result = shouldPromptInAskMode('Write', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    /**
     * P3.355, 2026-09-04 — NOT a vocabulary failure, and the third of this
     * file's three causes. This case used to pass `autoAllowFileWrites: true`
     * ALONE, which is the pre-fix unbounded shape: `isInsideAutoAllowRoots`
     * answered true with no roots, and `acceptEdits` auto-approved a write
     * anywhere on disk. The roots check now FAILS CLOSED by design
     * (`pre-tool-use.ts`, `isInsideAutoAllowRoots`: *"No roots FAILS CLOSED …
     * a caller that supplies none gets no auto-approval at all"*), so the test
     * was asserting behaviour the product deliberately removed. Fixed by
     * driving it the way the production caller does — `runPreToolUseChecks`
     * builds `autoAllowWriteRoots` from working directory / workspace root /
     * plans / data / additional directories and passes `cwd` beside it — and
     * the fail-closed half is pinned as its own case below rather than lost.
     */
    it('auto-allows file write tools when requested by acceptEdits', () => {
      const result = shouldPromptInAskMode('Write', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      }, undefined, undefined, {
        autoAllowFileWrites: true,
        autoAllowWriteRoots: ['/test'],
        cwd: '/test',
      });

      expect(result).toBeNull();
    });

    /**
     * THE SEPARATING CONTROL for the case above, and the shape that reaches
     * real users: a session whose caller can name no root at all. The
     * auto-approval is withheld and the ordinary write prompt stands — the safe
     * direction, and the one an unbounded `autoAllowFileWrites` silently lost.
     */
    it('withholds the acceptEdits auto-allow when the caller names no roots', () => {
      const result = shouldPromptInAskMode('Write', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      }, undefined, undefined, { autoAllowFileWrites: true });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    /** The other half of the bound: inside the roots is not everywhere. */
    it('withholds the acceptEdits auto-allow for a write outside every root', () => {
      const result = shouldPromptInAskMode('Write', { file_path: '/elsewhere/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      }, undefined, undefined, {
        autoAllowFileWrites: true,
        autoAllowWriteRoots: ['/test'],
        cwd: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });
  });

  // --- Bash ---

  describe('bash commands', () => {
    it('prompts for bash commands', () => {
      const result = shouldPromptInAskMode('Bash', { command: 'npm install express' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('npm install express');
      expect(result!.rememberForMinutes).toBe(10);
      expect(result!.commandHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('auto-allows read-only bash commands (AST-validated)', () => {
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => true);

      const result = shouldPromptInAskMode('Bash', { command: 'ls -la' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('does NOT auto-allow bash commands with redirects (e.g. cat > file)', () => {
      // isReadOnlyBashCommandWithConfig uses AST validation which catches redirects
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);

      const result = shouldPromptInAskMode('Bash', { command: 'cat /etc/hosts > /tmp/test' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('cat /etc/hosts > /tmp/test');
    });

    it('auto-allows whitelisted non-dangerous commands', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (key) => key === bashRememberKey('npm install lodash'), // UA12.85 — the key the click mints (UA12.70), not `npm`
        isDangerousCommand: () => false,
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'npm install lodash --save-dev' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });
      expect(result).toBeNull(); // a flag after the key rides the key (key equality) …
      expect(shouldPromptInAskMode('Bash', { command: 'npm install lodash evil-pkg' }, pm, { workspaceRootPath: '/test', activeSourceSlugs: [] })).not.toBeNull(); // … an extra positional word does not
    });

    it('still prompts for whitelisted dangerous commands', () => {
      // D1.439 — the DOUBLE was falsified by D1.401, not the behaviour. That row
      // made the floor ask per SEGMENT of the whole line, through the durable
      // engine's own splitter, so `isDangerousCommand` is now consulted with
      // `'rm -rf /important'` and never with the bare `'rm'`. A double written
      // as `cmd === 'rm'` therefore answered "not dangerous", the whitelisted
      // prefix covered the line, and this arm PASSED against a build with no
      // dangerous floor at all — the default-flip shape, where a stale pin stops
      // discriminating instead of going red. It expresses "rm is dangerous" the
      // way the production predicate does, and discriminates again.
      pm = createMockPermissionManager({
        isCommandWhitelisted: (key) => key === bashRememberKey('npm test') || key === bashRememberKey('make deploy'), // UA12.85 — keys the clicks mint
        isDangerousCommand: (cmd) => /^(rm|make deploy)\b/.test(cmd), // `make deploy` mints a key, so only the floor stands between it and allow
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'rm -rf /important' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });
      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(shouldPromptInAskMode('Bash', { command: 'make deploy' }, pm, { workspaceRootPath: '/test', activeSourceSlugs: [] })).not.toBeNull(); // whitelisted AND dangerous: the floor wins

      // The SUCCESSOR D1.401 actually added (the per-SEGMENT floor), asserted
      // beside its own positive control: a whitelisted non-dangerous command
      // still auto-allows on its own. UA12.85: under key equality (UA12.70) an
      // `rm` segment mints no key, so the `rm` chain asks with or without the
      // floor — a behaviour check, not the floor's guard. The guard is
      // `npm test && make deploy`: both segments hold a key and the whole line
      // misses the double's regex, so only the per-segment floor makes it ask
      // (removing `if (isDangerous(segment)) return null;` turns it red).
      expect(shouldPromptInAskMode('Bash', { command: 'npm test' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      })).toBeNull();
      expect(shouldPromptInAskMode('Bash', { command: 'npm test && rm -rf /important' }, pm, { workspaceRootPath: '/test', activeSourceSlugs: [] })).not.toBeNull();
      expect(shouldPromptInAskMode('Bash', { command: 'npm test && make deploy' }, pm, { workspaceRootPath: '/test', activeSourceSlugs: [] })).not.toBeNull(); // D1.401's floor alone
    });

    it('auto-allows curl to whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'api.example.com',
        isDomainWhitelisted: (domain) => domain === 'api.example.com',
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://api.example.com/data' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('prompts for curl to non-whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'evil.com',
        isDomainWhitelisted: () => false,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://evil.com/data' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
    });

    it('uses the same remember hash for curl commands to the same domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'api.example.com',
        isDomainWhitelisted: () => false,
      });

      const first = shouldPromptInAskMode('Bash', { command: 'curl https://api.example.com/data' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });
      const second = shouldPromptInAskMode('Bash', { command: 'curl https://api.example.com/other' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.commandHash).toBe(second!.commandHash);
      expect(first!.rememberForMinutes).toBe(10);
    });
  });

  // --- MCP mutations ---

  describe('MCP mutations', () => {
    it('prompts for MCP mutations (blocked in safe mode)', () => {
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
          mode === 'plan' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('mcp_mutation');
      expect(result!.description).toContain('linear');
    });

    it('auto-allows MCP read-only tools (not blocked in safe mode)', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));

      const result = shouldPromptInAskMode('mcp__linear__listIssues', {}, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows whitelisted MCP mutations', () => {
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
          mode === 'plan' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'mcp__linear__createIssue',
      });

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).toBeNull();
    });
  });

  // --- API mutations ---

  describe('API mutations', () => {
    it('prompts for non-GET API calls', () => {
      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('api_mutation');
      expect(result!.description).toContain('POST');
    });

    it('auto-allows GET API calls', () => {
      const result = shouldPromptInAskMode('api_github', { method: 'GET', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows API mutations whitelisted in permissions.json', () => {
      mockIsApiEndpointAllowed.mockImplementation(() => true);

      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows API mutations whitelisted in session', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'POST /repos',
      });

      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('defaults to GET for missing method', () => {
      const result = shouldPromptInAskMode('api_github', { path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      // GET → no prompt
      expect(result).toBeNull();
    });
  });

  // --- Non-prompting tools ---

  describe('non-prompting tools', () => {
    it('returns null for Read tool', () => {
      const result = shouldPromptInAskMode('Read', { file_path: '/test/file.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Glob tool', () => {
      const result = shouldPromptInAskMode('Glob', { pattern: '**/*.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Grep tool', () => {
      const result = shouldPromptInAskMode('Grep', { pattern: 'TODO' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Task tool', () => {
      const result = shouldPromptInAskMode('Task', {}, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });
  });
});

describe('shouldPromptInAutoMode', () => {
  let pm: PermissionManagerLike;

  beforeEach(() => {
    pm = createMockPermissionManager();
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockIsApiEndpointAllowed.mockReset();
    mockIsApiEndpointAllowed.mockImplementation(() => false);
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
  });

  /**
   * P3.355 — the `auto` twin of the `acceptEdits` case above, and stale for the
   * same reason: `auto`'s write auto-approval is bounded by the SAME session
   * roots, and a caller that names none gets prompts rather than silent
   * approvals. Driven the way `runPreToolUseChecks`'s `auto` branch drives it.
   */
  it('auto-allows file write tools', () => {
    const result = shouldPromptInAutoMode('Write', { file_path: '/test/a.ts' }, pm, {
      workspaceRootPath: '/test',
      activeSourceSlugs: [],
    }, undefined, undefined, { autoAllowWriteRoots: ['/test'], cwd: '/test' });

    expect(result).toBeNull();
  });

  /** THE SEPARATING CONTROL: no roots, no auto-approval. */
  it('withholds auto\'s write auto-allow when the caller names no roots', () => {
    const result = shouldPromptInAutoMode('Write', { file_path: '/test/a.ts' }, pm, {
      workspaceRootPath: '/test',
      activeSourceSlugs: [],
    });

    expect(result).not.toBeNull();
    expect(result!.promptType).toBe('file_write');
  });

  it('auto-allows low-risk bash commands', () => {
    const result = shouldPromptInAutoMode('Bash', { command: 'npm test' }, pm, {
      workspaceRootPath: '/test',
      activeSourceSlugs: [],
    });

    expect(result).toBeNull();
  });

  it('prompts for risky bash commands', () => {
    pm = createMockPermissionManager({
      isDangerousCommand: (cmd) => cmd === 'rm',
    });

    const result = shouldPromptInAutoMode('Bash', { command: 'rm -rf build' }, pm, {
      workspaceRootPath: '/test',
      activeSourceSlugs: [],
    });

    expect(result).not.toBeNull();
    expect(result!.promptType).toBe('bash');
  });

  it('prompts for MCP and API mutations', () => {
    mockShouldAllowToolInMode.mockImplementation(
      (_tool: string, _input: Record<string, unknown>, mode: string) =>
        mode === 'plan' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
    );

    const mcp = shouldPromptInAutoMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
      workspaceRootPath: '/test',
      activeSourceSlugs: ['linear'],
    });
    const api = shouldPromptInAutoMode('api_github', { method: 'POST', path: '/repos' }, pm, {
      workspaceRootPath: '/test',
      activeSourceSlugs: [],
    });

    expect(mcp?.promptType).toBe('mcp_mutation');
    expect(api?.promptType).toBe('api_mutation');
  });
});

/**
 * The `EnterWorktree` approval floor.
 *
 * tools-reference.md: "A `path` outside `.claude/worktrees/` prompts for your
 * approval before entering, since it moves the session's working directory and
 * write access to that location. New-worktree creation and paths under
 * `.claude/worktrees/` don't prompt." worktrees.md turns it into a floor: "An
 * `EnterWorktree` permission rule or choosing 'don't ask again' doesn't suppress
 * this prompt; only `bypassPermissions` mode skips it."
 *
 * A third non-negotiable class, and the only one `allow-all` (our
 * `bypassPermissions`) is allowed to skip.
 */
describe('EnterWorktree approval floor', () => {
  const repoRoot = '/projects/app';
  const insideWorktree = '/projects/.nessy-worktrees/app/lease-1';

  function enterInput(overrides?: Partial<PreToolUseInput>): PreToolUseInput {
    return createInput({
      toolName: 'EnterWorktree',
      input: {},
      worktree: { repoRoot },
      ...overrides,
    });
  }

  beforeEach(() => {
    mockEffectivePermissionMode = 'default';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
  });

  it('does not prompt for new-worktree creation', () => {
    expect(runPreToolUseChecks(enterInput()).type).toBe('allow');
  });

  it('does not prompt for a path inside the repository worktree namespace', () => {
    expect(runPreToolUseChecks(enterInput({
      toolName: 'EnterWorktree',
      input: { path: insideWorktree },
      worktree: { repoRoot },
    })).type).toBe('allow');
  });

  it('prompts for a path outside the worktree namespace, non-negotiably', () => {
    const result = runPreToolUseChecks(enterInput({
      toolName: 'EnterWorktree',
      input: { path: '/somewhere/else' },
      worktree: { repoRoot },
    }));

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    expect(result.nonNegotiable).toBe('worktreeApproval');
    // Its OWN prompt type, never `admin_approval` (R2): the admin type routes
    // every answer through the privileged-execution broker, which fails closed
    // on a request that was never registered (registration requires a
    // `command`, which the floor does not have) — so a floor emitted as
    // `admin_approval` could not be approved at all.
    expect(result.promptType).toBe('worktree_approval');
    // No "don't ask again": a remembered approval is exactly what the floor
    // forbids, and the remember window is keyed off these two fields.
    expect(result.rememberForMinutes).toBeUndefined();
    expect(result.commandHash).toBeUndefined();
  });

  it('prompts even when the mode would otherwise allow everything but bypass', () => {
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto'] as const) {
      mockEffectivePermissionMode = mode;
      const result = runPreToolUseChecks(enterInput({
        toolName: 'EnterWorktree',
        input: { path: '/somewhere/else' },
        worktree: { repoRoot },
      }));
      expect(result.type, mode).toBe('prompt');
    }
  });

  it('is skipped by allow-all, our bypassPermissions', () => {
    mockEffectivePermissionMode = 'bypassPermissions';
    expect(runPreToolUseChecks(enterInput({
      toolName: 'EnterWorktree',
      input: { path: '/somewhere/else' },
      worktree: { repoRoot },
    })).type).toBe('allow');
  });

  it('denies in dontAsk, which cannot prompt', () => {
    mockEffectivePermissionMode = 'dontAsk';
    const result = runPreToolUseChecks(enterInput({
      toolName: 'EnterWorktree',
      input: { path: '/somewhere/else' },
      worktree: { repoRoot },
    }));

    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    // NOT marked would-prompt: a PermissionRequest hook allow must not be able
    // to re-open a floor the human never saw.
    expect(result.source).toBeUndefined();
  });

  it('refuses the create form and an out-of-namespace path from inside a worktree', () => {
    const create = runPreToolUseChecks(enterInput({
      worktree: { repoRoot, insideWorktree: true },
    }));
    expect(create.type).toBe('block');

    const outside = runPreToolUseChecks(enterInput({
      toolName: 'EnterWorktree',
      input: { path: '/somewhere/else' },
      worktree: { repoRoot, insideWorktree: true },
    }));
    // Refused outright, not prompted: the scoped form has no approval path.
    expect(outside.type).toBe('block');

    const inside = runPreToolUseChecks(enterInput({
      toolName: 'EnterWorktree',
      input: { path: insideWorktree },
      worktree: { repoRoot, insideWorktree: true },
    }));
    expect(inside.type).toBe('allow');
  });

  it('never prompts for ExitWorktree', () => {
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto'] as const) {
      mockEffectivePermissionMode = mode;
      expect(runPreToolUseChecks(createInput({
        toolName: 'ExitWorktree',
        input: {},
        worktree: { repoRoot },
      })).type, mode).toBe('allow');
    }
  });

  // P6.843 — every case above binds `worktree: { repoRoot }`, which is the PI
  // shape: `worktreeGateContext()` is provider-agnostic on `base-agent.ts` but
  // has exactly one call site, `pi-agent.ts`. So the shape every OTHER runtime
  // presents to this gate — no worktree context at all — had no case, and the
  // floor's behaviour there was the whole of P6.799's premise.
  it('refuses when the session has no worktree context, and judges only EnterWorktree', () => {
    // Fail-CLOSED. This is why lifting the tools off `pi-only` could never have
    // "shipped the write-access move with nothing guarding it" (P6.799): it
    // would have advertised a permanently-refusing tool instead.
    const blocked = runPreToolUseChecks(createInput({ toolName: 'EnterWorktree', input: {} }));
    expect(blocked.type).toBe('block');
    if (blocked.type !== 'block') throw new Error('expected a block');
    expect(blocked.reason).toContain('no repository to create or enter a worktree in');

    // The negative, and the other half of the correction: the floor's tool set
    // is `ENTER_WORKTREE_TOOLS` alone, so the two siblings that inherited its
    // reason in `tool-defs.ts` were never judged by it in either context shape.
    expect(runPreToolUseChecks(createInput({ toolName: 'ExitWorktree', input: {} })).type).toBe('allow');
    expect(runPreToolUseChecks(createInput({ toolName: 'WorktreeBatch', input: {} })).type).toBe('allow');
  });

  // P6.839 — the claim the owner's decision rests on, pinned rather than assumed.
  it('decides the same with and without `bgIsolation`, which is why claude is given the facts alone', () => {
    // Claude enforces the main-checkout write block ITSELF (the SDK reads
    // `worktree.bgIsolation` from the settings seam `buildClaudeWorktreeSettings`
    // writes), so the host binds the repository facts and NOT that field —
    // option A minus one, decided 2026-09-10. This pins the premise: the ENTER
    // floor never reads `bgIsolation`, so omitting it costs the floor nothing.
    const cases: Array<{ name: string; input: Record<string, unknown>; inside?: true }> = [
      { name: 'create', input: {} },
      { name: 'in namespace', input: { path: insideWorktree } },
      { name: 'outside', input: { path: '/somewhere/else' } },
      { name: 'create from inside', input: {}, inside: true },
    ];
    for (const { name, input, inside } of cases) {
      const facts = runPreToolUseChecks(enterInput({
        toolName: 'EnterWorktree',
        input,
        worktree: { repoRoot, ...(inside ? { insideWorktree: true } : {}) },
      }));
      for (const bgIsolation of ['worktree', 'none'] as const) {
        const withField = runPreToolUseChecks(enterInput({
          toolName: 'EnterWorktree',
          input,
          worktree: { repoRoot, ...(inside ? { insideWorktree: true } : {}), bgIsolation },
        }));
        expect({ name, bgIsolation, type: withField.type }).toEqual({ name, bgIsolation, type: facts.type });
      }
    }
    // The instrument's control: this loop would prove nothing if every case
    // answered the same way, so the four cases must not collapse to one verdict.
    expect(new Set(cases.map(({ input, inside }) => runPreToolUseChecks(enterInput({
      toolName: 'EnterWorktree',
      input,
      worktree: { repoRoot, ...(inside ? { insideWorktree: true } : {}) },
    })).type)).size).toBeGreaterThan(1);
  });
});

/**
 * `worktree.bgIsolation: "worktree"` — settings.md § Worktree settings:
 * "blocks `Edit`/`Write` in the main checkout until `EnterWorktree` is called."
 *
 * The block and its release valve are one mechanism. These tests drive the real
 * gate so the block cannot be green against a helper the gate never calls.
 */
describe('worktree.bgIsolation write block', () => {
  const repoRoot = '/projects/app';
  const inWorktree = '/projects/.nessy-worktrees/app/lease-1';

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
  });

  function edit(worktree: PreToolUseInput['worktree'], filePath = '/projects/app/src/a.ts') {
    return runPreToolUseChecks(createInput({
      toolName: 'Edit',
      input: { file_path: filePath, old_string: 'a', new_string: 'b' },
      worktree,
    }));
  }

  it('does not block when bgIsolation is off — our default', () => {
    expect(edit({ repoRoot }).type).toBe('allow');
    expect(edit({ repoRoot, bgIsolation: 'none' }).type).toBe('allow');
  });

  it('refuses an Edit in the main checkout and names the release valve', () => {
    const result = edit({ repoRoot, bgIsolation: 'worktree' });
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain('EnterWorktree');
  });

  it('refuses Write and NotebookEdit the same way', () => {
    for (const toolName of ['Write', 'NotebookEdit'] as const) {
      expect(runPreToolUseChecks(createInput({
        toolName,
        input: { file_path: '/projects/app/src/a.ts', content: 'x' },
        worktree: { repoRoot, bgIsolation: 'worktree' },
      })).type, toolName).toBe('block');
    }
  });

  it('allows the same edit once the session has entered a worktree', () => {
    expect(edit({ repoRoot, bgIsolation: 'worktree', insideWorktree: true }, `${inWorktree}/src/a.ts`).type)
      .toBe('allow');
  });

  /**
   * P6.323 — the block was INVERTED: `insideWorktree` exempted the session
   * entirely, so the one state the setting exists to protect protected nothing.
   * `worktrees.md` § How Claude Code enforces isolation blocks "an `Edit`,
   * `Write`, or `NotebookEdit` that targets a path in the main checkout" — and
   * upstream's session is precisely one that IS inside a worktree.
   */
  it('refuses an absolute main-checkout write from INSIDE the worktree (P6.323)', () => {
    const inside = { repoRoot, bgIsolation: 'worktree' as const, insideWorktree: true };
    const result = edit(inside, '/projects/app/src/a.ts');
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain('main checkout');
    // Write and NotebookEdit take the same path.
    for (const toolName of ['Write', 'NotebookEdit'] as const) {
      expect(runPreToolUseChecks(createInput({
        toolName,
        input: { file_path: '/projects/app/src/a.ts', content: 'x' },
        worktree: inside,
      })).type, toolName).toBe('block');
    }
    // CONTROL — the worktree itself and a path off the repository stay writable,
    // so the block above is about the main checkout and not about being inside.
    expect(edit(inside, `${inWorktree}/src/a.ts`).type).toBe('allow');
    expect(edit(inside, '/tmp/scratch.ts').type).toBe('allow');
  });

  it('leaves a RELATIVE target alone inside a worktree, because its base is unknown here (P6.323)', () => {
    // The stated residue, pinned so it reads as a decision. A relative target
    // resolves against the session's working directory, which this gate context
    // does not carry; resolving it against `repoRoot` would report a write to
    // the main checkout that is not one — the mirror of the defect fixed above.
    expect(edit({ repoRoot, bgIsolation: 'worktree', insideWorktree: true }, 'src/a.ts').type)
      .toBe('allow');
    // And OUTSIDE a worktree the relative target is still judged, because there
    // the base IS the main checkout.
    expect(edit({ repoRoot, bgIsolation: 'worktree' }, 'src/a.ts').type).toBe('block');
  });

  it('blocks only the main checkout, not every write on the machine', () => {
    // "blocks Edit/Write in the MAIN CHECKOUT" — a scratch file elsewhere is
    // not what the isolation is protecting.
    expect(edit({ repoRoot, bgIsolation: 'worktree' }, '/tmp/scratch.ts').type).toBe('allow');
    // And a write into another worktree of this repository is the isolated
    // target the setting is steering toward.
    expect(edit({ repoRoot, bgIsolation: 'worktree' }, `${inWorktree}/src/a.ts`).type).toBe('allow');
  });

  it('does not block a read', () => {
    expect(runPreToolUseChecks(createInput({
      toolName: 'Read',
      input: { file_path: '/projects/app/src/a.ts' },
      worktree: { repoRoot, bgIsolation: 'worktree' },
    })).type).toBe('allow');
  });

  it('does not block a session with no repository', () => {
    expect(runPreToolUseChecks(createInput({
      toolName: 'Edit',
      input: { file_path: '/projects/app/src/a.ts', old_string: 'a', new_string: 'b' },
    })).type).toBe('allow');
  });
});

/**
 * `worktree.bgIsolation: "worktree"` widened from Edit/Write to Bash + git
 * redirects (P2.6). `whats-new/2026-w32.md` (fetched 2026-08-24): "Worktree
 * isolation now blocks not only file edits but also Bash commands and git
 * redirects that reach the main checkout, in every session type and in the
 * session's subagents." The detailed four-check contract is `worktrees.md` §
 * How Claude Code enforces isolation.
 *
 * These drive the real gate with the real bash-parser AST and the real
 * read-only git/echo/cat patterns, so the block cannot be green against a helper
 * the gate never calls.
 */
describe('worktree.bgIsolation Bash + git redirect block', () => {
  const repoRoot = '/projects/app';
  // The namespace of `/projects/app` is the sibling `/projects/.nessy-worktrees/app/`.
  const inWorktree = '/projects/.nessy-worktrees/app/lease-1';
  // The production read-only patterns for the commands under test (copied from
  // apps/electron/resources/permissions/default.json), so `git status`/`cat`/
  // `echo` classify as reads and `git add`/`touch` as writes exactly as the
  // shipped gate does.
  const READ_ONLY_PATTERNS = [
    { regex: /^echo\b/ },
    { regex: /^cat\b/ },
    { regex: /^ls\b/ },
    { regex: /^git\s+((-[A-Za-z]|--[a-z][-a-z]*)(\s+[^\s-][^\s]*)?\s+)*(status|log|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|config\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\b/ },
  ];

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
    mockReadOnlyBashPatterns = READ_ONLY_PATTERNS;
  });

  const active: PreToolUseInput['worktree'] = { repoRoot, bgIsolation: 'worktree' };
  const bash = (command: string, worktree: PreToolUseInput['worktree'] = active) =>
    runPreToolUseChecks(createInput({ toolName: 'Bash', input: { command }, worktree }));

  // (a) a Bash write to the main checkout → blocked.
  it('blocks a Bash write to the main checkout', () => {
    const redirected = bash('echo pwned > secret.txt');
    expect(redirected.type).toBe('block');
    if (redirected.type !== 'block') throw new Error('expected a block');
    expect(redirected.reason).toContain('main checkout');
    expect(redirected.reason).toContain('EnterWorktree');
    expect(redirected.reason).toContain('secret.txt');
    // A plain write command with no redirect writes relative to the working
    // directory, which is the main checkout — "can't verify it stays outside".
    expect(bash('touch newfile').type).toBe('block');
    // git that operates on the current tree (no -C/--work-tree) writes the main
    // checkout.
    expect(bash('git add .').type).toBe('block');
  });

  // (b) a `git -C <main-checkout>` redirect → blocked.
  it('blocks a git redirect into the main checkout', () => {
    const result = bash(`git -C ${repoRoot} add .`);
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain(repoRoot);
    // A subdirectory of the main checkout is still the main checkout.
    expect(bash(`git -C ${repoRoot}/packages commit -m x`).type).toBe('block');
    // `--work-tree` into the main checkout is the same redirect by another flag.
    expect(bash(`git --work-tree=${repoRoot} add .`).type).toBe('block');
  });

  // (c) a Bash write INSIDE the worktree → allowed (control).
  it('allows a Bash write steered into a worktree of the repository', () => {
    expect(bash(`git -C ${inWorktree} add .`).type).toBe('allow');
    expect(bash(`echo x > ${inWorktree}/note.txt`).type).toBe('allow');
    // A scratch file outside the repository entirely is not what isolation guards.
    expect(bash('echo x > /tmp/scratch.txt').type).toBe('allow');
  });

  // (d) isolation `'none'` → the Bash write is NOT blocked (no behaviour change).
  it('does not block any Bash command when bgIsolation is off — our default', () => {
    expect(bash('echo pwned > secret.txt', { repoRoot, bgIsolation: 'none' }).type).toBe('allow');
    expect(bash('touch newfile', { repoRoot, bgIsolation: 'none' }).type).toBe('allow');
    // Absent bgIsolation resolves to the same default.
    expect(bash('git add .', { repoRoot }).type).toBe('allow');
  });

  // (e) the block applies in a subagent session. The gate has NO session-type
  // branch: main sessions and subagents route through the identical
  // `runPreToolUseChecks`, so the same worktree context blocks a subagent's
  // Bash write.
  //
  // P6.323 narrowed what `insideWorktree` releases. It used to release
  // everything; it now releases only the two vectors whose base is the
  // session's working directory — the fail-closed `cwd` vector and a relative
  // target — because this context carries `repoRoot` and no cwd. An ABSOLUTE
  // main-checkout write is blocked in both states.
  it('blocks a subagent Bash write to the main checkout, and lifts when pinned to a worktree', () => {
    // A subagent running in the main checkout (not pinned to a worktree).
    expect(bash('touch newfile', { repoRoot, bgIsolation: 'worktree' }).type).toBe('block');
    expect(bash(`git -C ${repoRoot} add .`, { repoRoot, bgIsolation: 'worktree' }).type).toBe('block');
    // The same subagent once it is inside its worktree: the cwd vector is the
    // worktree, which is the isolated target.
    expect(bash('touch newfile', { repoRoot, bgIsolation: 'worktree', insideWorktree: true }).type)
      .toBe('allow');
  });

  it('blocks an ABSOLUTE Bash write into the main checkout from inside the worktree (P6.323)', () => {
    const inside = { repoRoot, bgIsolation: 'worktree' as const, insideWorktree: true };
    // `worktrees.md` names git redirects into the main checkout explicitly, and
    // this is the case the old `insideWorktree` exemption let straight through.
    expect(bash(`git -C ${repoRoot} add .`, inside).type).toBe('block');
    // An output redirect is the other vector that names a concrete path.
    expect(bash(`echo pwned > ${repoRoot}/secret.txt`, inside).type).toBe('block');
    // CONTROL — a read of the main checkout is still allowed from inside, and a
    // redirect into the worktree is the isolated target.
    expect(bash(`git -C ${repoRoot} status`, inside).type).toBe('allow');
    expect(bash(`echo ok > ${inWorktree}/secret.txt`, inside).type).toBe('allow');
    // AND THE SCOPE, stated so it is not read as coverage it does not have:
    // `touch <abs>` is NOT blocked from inside, because this fork's scanner
    // traces arguments for `git` and for redirects only — every other write
    // command yields the fail-closed `cwd` vector (`bash-validator.ts`: "Any
    // other write command (touch, sed -i, npm, a bare interpreter, ...) writes
    // relative to the working directory"), and inside a worktree that cwd is
    // the worktree. Closing this needs a `cwd` field on the gate context, not a
    // change here.
    expect(bash(`touch ${repoRoot}/newfile`, inside).type).toBe('allow');
  });

  it('does not block a read, even one that touches the main checkout', () => {
    expect(bash('git status').type).toBe('allow');
    expect(bash(`git -C ${repoRoot} status`).type).toBe('allow');
    expect(bash(`cat ${repoRoot}/src/a.ts`).type).toBe('allow');
    expect(bash(`ls ${repoRoot}`).type).toBe('allow');
    // A read redirected to /dev/null writes nothing.
    expect(bash('echo hi > /dev/null').type).toBe('allow');
  });

  it('fails closed on a command it cannot trace', () => {
    // A command substitution can write anywhere; its target is untraceable.
    expect(bash('echo $(touch pwned)').type).toBe('block');
    // An unsupported shell construct (a loop) can hide a write.
    expect(bash('for i in 1 2; do touch $i; done').type).toBe('block');
  });

  it('does not block a Bash command in a session with no repository', () => {
    expect(runPreToolUseChecks(createInput({
      toolName: 'Bash',
      input: { command: 'touch newfile' },
    })).type).toBe('allow');
  });
});

/**
 * P2.6 fix wave — the write-scan fails closed on find, awk, and laundered
 * redirects, and covers Monitor. The first review reproduced five fail-OPEN
 * escapes under `bgIsolation:'worktree'`, each writing/deleting the main
 * checkout: the read/write decision was a raw regex (so write-capable
 * `find`/`awk` classified as reads), redirect targets weren't scanned for
 * substitution (so `$(echo ..)` laundered a climb past `normalize`), and Monitor
 * was uncovered though `worktrees.md:90/91` name Bash/PowerShell/Monitor.
 *
 * These drive the real gate with the real bash-parser AST and the real
 * dangerous-arg / awk machinery (`DANGEROUS_COMMAND_ARGS`, `getDangerousAwkReason`).
 */
describe('worktree.bgIsolation fail-closed hardening', () => {
  const repoRoot = '/projects/app';
  const inWorktree = '/projects/.nessy-worktrees/app/lease-1';
  // Production read-only patterns for the commands under test, including `find`
  // and `awk`, so the ONLY reason a write-capable `find`/`awk` blocks is the
  // dangerous-arg / awk machinery — not a missing allowlist entry.
  const READ_ONLY_PATTERNS = [
    { regex: /^echo\b/ },
    { regex: /^cat\b/ },
    { regex: /^ls\b/ },
    { regex: /^find\b/ },
    { regex: /^(?:gawk|mawk|nawk|awk)\b/ },
    { regex: /^git\s+((-[A-Za-z]|--[a-z][-a-z]*)(\s+[^\s-][^\s]*)?\s+)*(status|log|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|config\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\b/ },
  ];

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
    mockReadOnlyBashPatterns = READ_ONLY_PATTERNS;
  });

  const active: PreToolUseInput['worktree'] = { repoRoot, bgIsolation: 'worktree' };
  const bash = (command: string) =>
    runPreToolUseChecks(createInput({ toolName: 'Bash', input: { command }, worktree: active }));
  const monitor = (command: string) =>
    runPreToolUseChecks(createInput({ toolName: 'Monitor', input: { command, description: 'd' }, worktree: active }));

  // The five reproduced fail-OPEN escapes, each of which writes/deletes the main
  // checkout, now blocked.
  it('blocks find -delete (a dangerous arg, not a read)', () => {
    expect(bash('find . -delete').type).toBe('block');
  });
  it('blocks find -exec (runs an arbitrary command)', () => {
    expect(bash('find . -exec touch pwned \\;').type).toBe('block');
  });
  it('blocks awk system() (executes a shell command)', () => {
    expect(bash(`awk 'BEGIN{system("touch pwned")}'`).type).toBe('block');
  });
  it('blocks awk print-to-file (writes the filesystem)', () => {
    expect(bash(`awk 'BEGIN{print "x" > "${repoRoot}/secret"}'`).type).toBe('block');
  });
  it('blocks a laundered redirect target (a substitution climbs into the main checkout)', () => {
    expect(bash(`echo pwned > /tmp/$(echo ..)/$(echo ..)${repoRoot}/secret`).type).toBe('block');
  });

  // MEDIUM — Monitor is covered (worktrees.md:90/91; Monitor uses the same Bash
  // rules and carries its shell script in the same `command` field).
  it('blocks a Monitor command that writes the main checkout', () => {
    const result = monitor('touch newfile');
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain('Monitor');
    expect(monitor(`git -C ${repoRoot} add .`).type).toBe('block');
  });
  it('does not block a read-only Monitor command', () => {
    expect(monitor('git status').type).toBe('allow');
  });

  // Controls that MUST stay allowed — a fail-closed gate that blocks these is
  // just as broken as one that opens the escapes above.
  it('allows genuine reads that only look dangerous', () => {
    expect(bash('find . -type f').type).toBe('allow');
    expect(bash(`awk '{print}'`).type).toBe('allow');
  });
  it('allows a git write steered into a worktree', () => {
    expect(bash(`git -C ${inWorktree} add .`).type).toBe('allow');
  });
  it('allows a redirect to an absolute non-main path', () => {
    expect(bash('echo x > /tmp/x').type).toBe('allow');
  });
});

/**
 * P2.6 fix wave 2 — under isolation a command must PROVE it is read-only.
 *
 * Round 1 disqualified writes via a NEGATIVE list (`DANGEROUS_COMMAND_ARGS`,
 * which holds only `find`), so any allowlisted command whose write flag was not
 * in that table classified as a read: `sort -o`, `yq -i`, `xq -i`. The class
 * regrew with the allowlist. The stance is now positive — a command yields no
 * write vector only if its head is a known-read AND every flag is proven safe —
 * so an unrecognised command or flag falls to the write side.
 *
 * The last test is the point of the whole wave: it proves a FUTURE allowlist
 * addition cannot reopen the class.
 */
describe('worktree.bgIsolation requires proof of read-only', () => {
  const repoRoot = '/projects/app';
  const inWorktree = '/projects/.nessy-worktrees/app/lease-1';
  // Real production patterns for every command under test, PLUS a hypothetical
  // newly-allowlisted `frobnicate` — the regression proof below needs a command
  // that the allowlist accepts and this file has never heard of.
  const READ_ONLY_PATTERNS = [
    { regex: /^echo\b/ }, { regex: /^cat\b/ }, { regex: /^ls\b/ },
    { regex: /^find\b/ }, { regex: /^(?:gawk|mawk|nawk|awk)\b/ },
    { regex: /^sort\b/ }, { regex: /^yq\b/ }, { regex: /^xq\b/ },
    { regex: /^xmllint\b/ }, { regex: /^sed\b/ }, { regex: /^jq\b/ },
    { regex: /^grep\b/ }, { regex: /^head\b/ }, { regex: /^wc\b/ },
    { regex: /^frobnicate\b/ },
    { regex: /^git\s+((-[A-Za-z]|--[a-z][-a-z]*)(\s+[^\s-][^\s]*)?\s+)*(status|log|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|config\s+-l|ls-files|ls-tree|shortlog|blame|annotate|reflog|cherry|whatchanged|ls-remote|history)\b/ },
  ];

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
    mockReadOnlyBashPatterns = READ_ONLY_PATTERNS;
  });

  const active: PreToolUseInput['worktree'] = { repoRoot, bgIsolation: 'worktree' };
  const bash = (command: string) =>
    runPreToolUseChecks(createInput({ toolName: 'Bash', input: { command }, worktree: active }));

  // The five escapes the re-review reproduced.
  it('blocks sort -o with an absolute main-checkout target', () => {
    expect(bash(`sort -o ${repoRoot}/secret input.txt`).type).toBe('block');
  });
  it('blocks sort -o wherever the flag sits in the argv', () => {
    expect(bash(`sort input.txt -o ${repoRoot}/secret`).type).toBe('block');
  });
  it('blocks sort -o with a cwd-relative target', () => {
    expect(bash('sort -o secret input.txt').type).toBe('block');
  });
  it('blocks yq -i (in-place edit)', () => {
    expect(bash(`yq -i '.a=1' ${repoRoot}/config.yaml`).type).toBe('block');
  });
  it('blocks xq -i (in-place edit)', () => {
    expect(bash(`xq -i '.a=1' ${repoRoot}/config.xml`).type).toBe('block');
  });

  // Same class, invented here — including git's OWN write flags, found while
  // measuring this wave.
  it('blocks the long and bundled spellings of the same write flag', () => {
    expect(bash(`sort --output=${repoRoot}/secret input.txt`).type).toBe('block');
    expect(bash('sort -no secret input.txt').type).toBe('block');
    expect(bash(`yq --inplace '.a=1' config.yaml`).type).toBe('block');
  });
  it('blocks other allowlisted commands that can write a file', () => {
    expect(bash(`xmllint --output ${repoRoot}/x.xml in.xml`).type).toBe('block');
    expect(bash(`sed -i 's/a/b/' ${repoRoot}/src/a.ts`).type).toBe('block');
    expect(bash(`find . -fprintf ${repoRoot}/out .`).type).toBe('block');
  });
  it('blocks git read subcommands carrying git own write flags', () => {
    expect(bash(`git diff --output=${repoRoot}/x`).type).toBe('block');
    expect(bash(`git format-patch -o ${repoRoot} HEAD`).type).toBe('block');
    // `git -c <key>=<value>` injects configuration — not a proven read flag.
    expect(bash('git -c core.hooksPath=/tmp/h status').type).toBe('block');
  });

  // THE CLASS-CLOSURE PROOF: a command the read-only allowlist accepts but the
  // proof map has never heard of is a WRITE. This is what stops the next
  // allowlist addition from silently reopening the hole — round 1 failed here.
  it('blocks a newly allowlisted command with an unknown write flag', () => {
    const result = bash(`frobnicate -o ${repoRoot}/secret`);
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain('main checkout');
    // …and blocks it even with no flag at all: it is not proven read-only.
    expect(bash('frobnicate input.txt').type).toBe('block');
  });

  // Controls: the legitimate reads the re-review requires keep working.
  it('allows the legitimate isolation-time reads', () => {
    expect(bash('git status').type).toBe('allow');
    expect(bash(`git -C ${inWorktree} add .`).type).toBe('allow');
    expect(bash('git log --oneline').type).toBe('allow');
    expect(bash('git log -5 --stat').type).toBe('allow');
    expect(bash('find . -type f').type).toBe('allow');
    expect(bash(`awk '{print}'`).type).toBe('allow');
    expect(bash('jq .').type).toBe('allow');
    expect(bash(`yq '.a'`).type).toBe('allow');
    expect(bash('sort input').type).toBe('allow');
    expect(bash('sort -nr data.txt').type).toBe('allow');
    expect(bash('grep -ln pattern file').type).toBe('allow');
    expect(bash('head -n5 f').type).toBe('allow');
    expect(bash('wc -l f').type).toBe('allow');
    expect(bash(`sed -n '1,5p' f`).type).toBe('allow');
    expect(bash(`cat ${repoRoot}/src/a.ts`).type).toBe('allow');
    expect(bash('ls -la').type).toBe('allow');
    expect(bash('echo x > /tmp/x').type).toBe('allow');
  });

  it('stays a no-op when isolation is off — our default', () => {
    for (const command of [`sort -o ${repoRoot}/secret input.txt`, `yq -i '.a=1' config.yaml`, 'frobnicate -o secret']) {
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot, bgIsolation: 'none' },
      })).type, command).toBe('allow');
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot },
      })).type, command).toBe('allow');
    }
  });

  it('covers Monitor with the same proof', () => {
    expect(runPreToolUseChecks(createInput({
      toolName: 'Monitor', input: { command: `sort -o ${repoRoot}/secret in.txt`, description: 'd' }, worktree: active,
    })).type).toBe('block');
    expect(runPreToolUseChecks(createInput({
      toolName: 'Monitor', input: { command: 'git status', description: 'd' }, worktree: active,
    })).type).toBe('allow');
  });
});

/**
 * P2.6 fix wave 3 — a POSITIONAL argument can be a write destination.
 *
 * Wave 2's positive flag stance held on the flag axis (11 spellings thrown at
 * it, none broke through) but rested on a FALSE invariant in its own security
 * comment: "a positional argument is an input, never a destination". Two
 * measured counter-examples, both of which RAN and truncated a real file:
 * `uniq in.txt OUTPUT` (POSIX `uniq [OPTION]... [INPUT [OUTPUT]]` — the second
 * operand is an output file) and `sed -n 'w FILE' in.txt` (the positional
 * SCRIPT carries sed's own write primitive).
 *
 * Bounded by an audit of all proof-map keys: `uniq` is the only output-operand
 * command, `sed` the only unguarded script carrier. Tests use the PRODUCTION
 * patterns — `^sed\s+-n\b` (the `-n` form the allowlist blesses IS the hole)
 * and `^uniq\b`.
 */
describe('worktree.bgIsolation guards write-capable positionals', () => {
  const repoRoot = '/projects/app';
  const READ_ONLY_PATTERNS = [
    { regex: /^uniq\b/ },
    { regex: /^sed\s+-n\b/ },   // production spelling, verbatim
    { regex: /^sort\b/ }, { regex: /^cat\b/ }, { regex: /^ls\b/ },
  ];

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
    mockReadOnlyBashPatterns = READ_ONLY_PATTERNS;
  });

  const active: PreToolUseInput['worktree'] = { repoRoot, bgIsolation: 'worktree' };
  const bash = (command: string) =>
    runPreToolUseChecks(createInput({ toolName: 'Bash', input: { command }, worktree: active }));

  // The three escapes the re-review RAN for real on Darwin.
  it('blocks uniq output operand with an absolute main-checkout target', () => {
    const result = bash(`uniq in.txt ${repoRoot}/secret`);
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain('main checkout');
  });
  it('blocks uniq output operand with a cwd-relative target', () => {
    // The reviewer's probe TRUNCATED an existing file through this exact shape.
    expect(bash('uniq in.txt secret').type).toBe('block');
  });
  it('blocks a sed script carrying the w write primitive', () => {
    expect(bash(`sed -n 'w ${repoRoot}/secret' in.txt`).type).toBe('block');
  });

  // Same axis, invented here — every place `w` can hide.
  it('blocks every spelling that hides sed w', () => {
    for (const script of ["1,5w out", "s/a/b/w out", "/x/w out", "W out", "wout"]) {
      expect(bash(`sed -n '${script}' in.txt`).type, script).toBe('block');
    }
  });
  it('blocks a sed w script arriving through -e and --expression', () => {
    expect(bash(`sed -n -e 'w ${repoRoot}/x' in.txt`).type).toBe('block');
    expect(bash(`sed -n --expression=w ${repoRoot}/x`).type).toBe('block');
  });
  it('blocks the uniq output operand even behind flags', () => {
    expect(bash('uniq -c in.txt secret').type).toBe('block');
    expect(bash('uniq -w 5 in.txt out').type).toBe('block');
  });

  // Controls: the reads the re-review requires stay ALLOWED.
  it('allows uniq as a read, including the pipeline idiom', () => {
    expect(bash('uniq in.txt').type).toBe('allow');
    expect(bash('uniq').type).toBe('allow');
    expect(bash('uniq -c').type).toBe('allow');
    // A value-taking flag must not have its value miscounted as the operand.
    expect(bash('uniq -w 5 in.txt').type).toBe('allow');
    expect(bash('uniq -f 1 in.txt').type).toBe('allow');
  });
  it('allows sed read scripts', () => {
    expect(bash(`sed -n 'p' in.txt`).type).toBe('allow');
    expect(bash(`sed -n '1,5p' in.txt`).type).toBe('allow');
    expect(bash(`sed -n 's/a/b/p' in.txt`).type).toBe('allow');
    expect(bash(`sed -n '$p' in.txt`).type).toBe('allow');
    // A FILENAME containing `w` must not be mistaken for a write primitive:
    // only the SCRIPT is scanned.
    expect(bash(`sed -n 'p' warnings.txt`).type).toBe('allow');
  });

  it('stays a no-op when isolation is off — our default', () => {
    for (const command of ['uniq in.txt secret', `sed -n 'w ${repoRoot}/secret' in.txt`]) {
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot, bgIsolation: 'none' },
      })).type, command).toBe('allow');
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot },
      })).type, command).toBe('allow');
    }
  });

  it('covers Monitor on this axis too', () => {
    expect(runPreToolUseChecks(createInput({
      toolName: 'Monitor', input: { command: 'uniq in.txt secret', description: 'd' }, worktree: active,
    })).type).toBe('block');
    expect(runPreToolUseChecks(createInput({
      toolName: 'Monitor', input: { command: 'uniq in.txt', description: 'd' }, worktree: active,
    })).type).toBe('allow');
  });
});

/**
 * P2.6 fix wave 4 — an unresolvable operand fails closed to the cwd vector.
 *
 * Wave 3's operand budget claimed to be "exact, because POSIX bounds the form at
 * two operands". POSIX bounds the OPERAND count; the budget counts AST WORDS,
 * and the shell expands one word into many. A live probe truncated
 * `PRECIOUS-SOURCE-FILE-CONTENT` through `uniq *.txt` — one word, two operands.
 *
 * The fix treats a glob/brace operand as unresolvable (fail closed), scoped to
 * commands WITH a budget so a glob in a genuinely read-only position keeps
 * working. Wave 4 also closes the map's own caveat: the operand axis must now be
 * DECLARED, so a newly added command cannot inherit unrestricted operands.
 */
describe('worktree.bgIsolation fails closed on unresolvable operands', () => {
  const repoRoot = '/projects/app';
  const READ_ONLY_PATTERNS = [
    { regex: /^uniq\b/ }, { regex: /^sort\b/ }, { regex: /^ls\b/ },
    { regex: /^cat\b/ }, { regex: /^grep\b/ }, { regex: /^wc\b/ },
  ];

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
    mockReadOnlyBashPatterns = READ_ONLY_PATTERNS;
  });

  const active: PreToolUseInput['worktree'] = { repoRoot, bgIsolation: 'worktree' };
  const bash = (command: string) =>
    runPreToolUseChecks(createInput({ toolName: 'Bash', input: { command }, worktree: active }));

  // The four forms the re-review ran for real; two truncated a file.
  it('blocks a glob operand that the shell expands into an output', () => {
    const result = bash('uniq *.txt');
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain('main checkout');
  });
  it('blocks the single-character glob form', () => {
    expect(bash('uniq ?.txt').type).toBe('block');
  });
  it('blocks the brace-expansion form', () => {
    expect(bash('uniq {a,b}.txt').type).toBe('block');
  });
  it('blocks a glob anchored at the main checkout', () => {
    expect(bash(`uniq ${repoRoot}/*.txt`).type).toBe('block');
  });

  // Same axis, invented here.
  it('blocks the bracket class and mixed literal/glob arities', () => {
    expect(bash('uniq [ab].txt').type).toBe('block');
    expect(bash('uniq in.txt *.bak').type).toBe('block');
    expect(bash('uniq -c {x,y}.txt').type).toBe('block');
  });

  // Controls the re-review requires.
  it('keeps the uniq reads, including the pipeline idiom', () => {
    expect(bash('uniq in.txt').type).toBe('allow');
    expect(bash('uniq -c').type).toBe('allow');
    expect(bash('uniq').type).toBe('allow');
    expect(bash('uniq -w 5 in.txt').type).toBe('allow');
    // In a pipeline `uniq` is its own Command node and must prove itself.
    expect(bash('sort f | uniq -c').type).toBe('allow');
  });
  it('keeps a glob in a genuinely read-only position', () => {
    // These commands declare OPERANDS_ARE_INPUTS, so an expansion cannot create
    // a destination and the glob stays allowed (not sort: see UA12.212 below).
    expect(bash('ls *.ts').type).toBe('allow');
    expect(bash('cat *.md').type).toBe('allow');
    expect(bash('grep -n foo src/*.ts').type).toBe('allow');
    expect(bash('wc -l *.txt').type).toBe('allow');
    expect(bash('sort *.txt').type).toBe('block'); // UA12.212: a file named -o.txt makes it sort -o .txt
  });

  it('stays a no-op when isolation is off — our default', () => {
    for (const command of ['uniq *.txt', 'uniq {a,b}.txt']) {
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot, bgIsolation: 'none' },
      })).type, command).toBe('allow');
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot },
      })).type, command).toBe('allow');
    }
  });

  it('covers Monitor on this axis too', () => {
    expect(runPreToolUseChecks(createInput({
      toolName: 'Monitor', input: { command: 'uniq *.txt', description: 'd' }, worktree: active,
    })).type).toBe('block');
  });

  /**
   * The self-closing property, pinned. A command added to the proof map without
   * declaring its operand policy already fails closed (it is not proven
   * read-only) — this converts that silent over-block into a named failure that
   * tells the author which decision is missing, so the operand axis stays
   * self-closing exactly like the flag axis.
   */
  it('leaves no proof-map command without an operand declaration', () => {
    expect(undeclaredProvenReadCommands()).toEqual([]);
  });
});

/**
 * P2.6 fix wave 5 — an unresolvable sed SCRIPT is a write.
 *
 * Wave 4 gave globs the fail-closed treatment but reached it only from
 * `operandsWithinLimit`, i.e. budget-carrying commands. `sed` is declared
 * OPERANDS_ARE_INPUTS, yet its first operand is a SCRIPT, so the glob check
 * never saw it. Live: in a directory whose alphabetically-first match starts
 * with `w`, `sed -n *.txt` expanded to `warnings.txt`, which sed parsed as `w` +
 * `arnings.txt` and CREATED that file — sed's `w` opens and truncates at
 * script-compile time, so it writes even with zero input lines.
 */
describe('worktree.bgIsolation treats an unresolvable sed script as a write', () => {
  const repoRoot = '/projects/app';
  const READ_ONLY_PATTERNS = [
    { regex: /^sed\s+-n\b/ },   // production spelling
    { regex: /^uniq\b/ }, { regex: /^ls\b/ }, { regex: /^cat\b/ },
  ];

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockConfiguredAdditionalDirectories = [];
    mockReadOnlyBashPatterns = READ_ONLY_PATTERNS;
  });

  const active: PreToolUseInput['worktree'] = { repoRoot, bgIsolation: 'worktree' };
  const bash = (command: string) =>
    runPreToolUseChecks(createInput({ toolName: 'Bash', input: { command }, worktree: active }));

  // The two forms the re-review ran for real.
  it('blocks a glob in the sed script position', () => {
    const result = bash('sed -n *.txt');
    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    expect(result.reason).toContain('main checkout');
  });
  it('blocks a bare glob as the sed script', () => {
    expect(bash('sed -n *').type).toBe('block');
  });

  // Same axis, invented here — every expansion metacharacter, and via -e.
  it('blocks every unresolvable script spelling', () => {
    for (const script of ['?.sed', '{a,b}.sed', '[ab].sed']) {
      expect(bash(`sed -n ${script}`).type, script).toBe('block');
    }
    expect(bash('sed -n -e * in.txt').type).toBe('block');
  });

  // Controls: a QUOTED glob in an INPUT position is a read (only the SCRIPT texts
  // are scanned); an UNQUOTED one is a write since UA12.212 (GNU sed: -i.log).
  it('keeps a quoted input glob, refuses an unquoted one (UA12.212)', () => {
    expect(bash(`sed -n '1,5p' '*.log'`).type).toBe('allow');
    expect(bash(`sed -n 'p' *.txt`).type).toBe('block');
  });
  it('keeps the sed read scripts', () => {
    expect(bash(`sed -n '1,5p' in.txt`).type).toBe('allow');
    expect(bash(`sed -n 'p' warnings.txt`).type).toBe('allow');
  });

  it('stays a no-op when isolation is off — our default', () => {
    for (const command of ['sed -n *.txt', 'sed -n *']) {
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot, bgIsolation: 'none' },
      })).type, command).toBe('allow');
      expect(runPreToolUseChecks(createInput({
        toolName: 'Bash', input: { command }, worktree: { repoRoot },
      })).type, command).toBe('allow');
    }
  });

  it('covers Monitor on this axis too', () => {
    expect(runPreToolUseChecks(createInput({
      toolName: 'Monitor', input: { command: 'sed -n *.txt', description: 'd' }, worktree: active,
    })).type).toBe('block');
  });
});

/**
 * P2.117 taken: the operand axis' FAIL-CLOSED branch, now driven directly.
 *
 * The declarations are module-private and cover all 63 keys, so no test on the
 * old surface could reach the branch that makes the axis self-closing. The
 * policy is now a pure exported function whose two collections are parameters,
 * so a synthetic name can exercise it.
 */
describe('operandPolicyProvesRead — the self-closing branch', () => {
  it('refuses a command that declares neither policy', () => {
    expect(operandPolicyProvesRead('wc', ['wc', '-l', 'f'], new Set(), new Map())).toBe(false);
  });
  it('accepts a command declared operands-are-inputs', () => {
    expect(operandPolicyProvesRead('wc', ['wc', '-l', 'f'], new Set(['wc']), new Map())).toBe(true);
  });
  it('enforces a declared budget, including its unresolvable-operand rule', () => {
    const budgets = new Map([['u', { maxOperands: 1, valueFlags: new Set<string>() }]]);
    expect(operandPolicyProvesRead('u', ['u', 'a'], new Set(), budgets)).toBe(true);
    expect(operandPolicyProvesRead('u', ['u', 'a', 'b'], new Set(), budgets)).toBe(false);
    expect(operandPolicyProvesRead('u', ['u', '*.txt'], new Set(), budgets)).toBe(false);
  });
  it('defaults to the shipped declarations, which cover every proof-map key', () => {
    expect(undeclaredProvenReadCommands()).toEqual([]);
    expect(operandPolicyProvesRead('wc', ['wc', '-l', 'f'])).toBe(true);
    expect(operandPolicyProvesRead('uniq', ['uniq', 'a', 'b'])).toBe(false);
  });
});

// ============================================================
// R4 Task 5 — workflow launch consent
// ============================================================

describe('workflow launch consent', () => {
  const plan = { name: 'audit-routes', phases: ['Discover', 'Audit'] };

  const launch = (overrides?: Partial<PreToolUseInput>) => runPreToolUseChecks(createInput({
    toolName: 'workflow',
    input: { name: 'audit-routes' },
    workflowLaunch: { plan, consented: false },
    ...overrides,
  }));

  beforeEach(() => {
    mockEffectivePermissionMode = 'default';
  });

  it('prompts before the run with the workflow name and its planned phases', () => {
    const result = launch();
    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') return;
    // Its own prompt type: `admin_approval` routed the approval into the
    // privileged-execution broker (which rejects non-installer commands and
    // hung the approved launch) and rendered the admin/Touch ID template.
    expect(result.promptType).toBe('workflow_launch');
    expect(result.description).toContain('audit-routes');
    expect(result.description).toContain('Discover');
    expect(result.description).toContain('Audit');
    // The launch prompt is REMEMBER-ABLE. It is not the worktree-style floor,
    // so it must never be marked non-negotiable — `workflows.md` offers
    // "Yes, and don't ask again for <name> in <path>".
    expect(result.nonNegotiable).toBeUndefined();
    expect(promptIsNonNegotiable(result)).toBe(false);
  });

  it('stops prompting once this workflow is remembered for this project', () => {
    const remembered = launch({ workflowLaunch: { plan, consented: true } });
    if (remembered.type === 'prompt') {
      expect(remembered.description).not.toContain('Discover');
    }
  });

  it('never prompts in allow-all, matching "bypass permissions: the run starts immediately"', () => {
    mockEffectivePermissionMode = 'bypassPermissions';
    const result = launch();
    if (result.type === 'prompt') {
      expect(result.description).not.toContain('Discover');
    }
  });

  it('denies rather than prompting in a mode that never prompts', () => {
    mockEffectivePermissionMode = 'dontAsk';
    const result = launch();
    expect(result.type).toBe('block');
    if (result.type !== 'block') return;
    // Marked as a would-have-prompted denial, so a PermissionRequest hook can
    // still approve it — the same treatment every other remember-able prompt
    // gets in this mode.
    expect(result.source).toBe('dont_ask_would_prompt');
  });

  it('leaves other tools untouched', () => {
    const result = runPreToolUseChecks(createInput({
      toolName: 'Read',
      input: { file_path: '/test/file.ts' },
      workflowLaunch: { plan, consented: false },
    }));
    if (result.type === 'prompt') {
      expect(result.description).not.toContain('Discover');
    }
  });
});

// ============================================================
// The removal circuit breaker
// ============================================================

/**
 * permissions.md:58, the `bypassPermissions` row: "Root and home directory
 * removals such as `rm -rf /` also still prompt as a circuit breaker".
 * permissions.md:63 adds the home form and the substitution clause, and
 * permission-modes.md:401 puts it above plan mode's suspended blocks.
 *
 * The mode that matters here is `allow-all`, our `bypassPermissions`. A test
 * that only exercised `ask` would prove nothing: the whole point of a circuit
 * breaker is the modes that skip prompts. `shouldAllowToolInMode` is mocked to
 * allow everything, which is both an explicit `allow` rule and the shape
 * `allow-all` produces in production.
 */
describe('removal circuit breaker', () => {
  const bash = (command: string, overrides?: Partial<PreToolUseInput>) =>
    runPreToolUseChecks(createInput({ toolName: 'Bash', input: { command }, ...overrides }));

  beforeEach(() => {
    mockEffectivePermissionMode = 'bypassPermissions';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
  });

  it('prompts for a home removal in allow-all, where nothing else prompts', () => {
    const result = bash('rm -rf ~');

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    expect(result.nonNegotiable).toBe('removalCircuitBreaker');
    expect(promptIsNonNegotiable(result)).toBe(true);
    // No "don't ask again": a remembered bypass of a circuit breaker is not a
    // circuit breaker, and the remember window is keyed off these two fields.
    expect(result.rememberForMinutes).toBeUndefined();
    expect(result.commandHash).toBeUndefined();
    // The description must say WHAT is removed and WHY the mode did not skip it.
    expect(result.description).toContain('home directory');
    expect(result.description).toContain('every permission mode');
    expect(result.command).toBe('rm -rf ~');
  });

  it('prompts for a root removal in allow-all', () => {
    const result = bash('rm -rf /');
    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    expect(result.description).toContain('filesystem root');
  });

  it('prompts in allow-all through wrappers and substitutions', () => {
    for (const command of ['sudo rm -rf ~', 'echo "$(rm -rf ~)"', 'ls -la && rm -rf /*']) {
      expect(bash(command).type, command).toBe('prompt');
    }
  });

  it('prompts in every mode, including the ones that suspend their own blocks', () => {
    // Production `safe`/`plan` block a removal outright at step 1, which is
    // stricter than the documented prompt and therefore consistent; the mock
    // proves the floor sits BEFORE every mode branch rather than inside one.
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      mockEffectivePermissionMode = mode;
      expect(bash('rm -rf ~').type, mode).toBe('prompt');
    }
  });

  it('marks the prompt classifier-adjudicated in `auto` and `plan`, and in no other mode', () => {
    // The mode predicate itself (P2.3 for `auto`, P2.21 for `plan` — the
    // `permission-modes.md:577` row). The marker authorizes the guardian
    // CONSULT and nothing else: `nonNegotiable` rides along in every mode, so a
    // rule, a remembered click and a PermissionRequest hook `allow` are still
    // refused everywhere.
    for (const mode of ['auto', 'plan'] as const) {
      mockEffectivePermissionMode = mode;
      const result = bash('rm -rf ~');
      if (result.type !== 'prompt') throw new Error(`expected a prompt in ${mode}`);
      expect(promptIsClassifierAdjudicated(result), mode).toBe(true);
      expect(promptIsNonNegotiable(result), mode).toBe(true);
    }
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) { // F1.1050: explore's arm left with the mode
      mockEffectivePermissionMode = mode;
      const result = bash('rm -rf ~');
      if (result.type !== 'prompt') throw new Error(`expected a prompt in ${mode}`);
      expect(promptIsClassifierAdjudicated(result), mode).toBe(false);
      expect(promptIsNonNegotiable(result), mode).toBe(true);
    }
  });

  it('prompts even when an allow rule whitelists the command', () => {
    mockEffectivePermissionMode = 'default';
    // UA12.85 — the double holds the keys the clicks mint (UA12.70). An `rm` line
    // mints none (the dangerous list), so a whitelist could never reach the breaker
    // through it and the old `rm -rf ./build` control went red; `find` stands in:
    // `find / -delete` mints an exact key AND is a root removal.
    const whitelisted = createMockPermissionManager({
      isCommandWhitelisted: (key) => key === bashRememberKey('find ./build -delete') || key === bashRememberKey('find / -delete'),
    });
    // Control: the whitelist really does clear an ordinary prompt in this mode.
    expect(bash('find ./build -delete', { permissionManager: whitelisted }).type).toBe('allow');
    const root = bash('find / -delete', { permissionManager: whitelisted });
    expect(root.type).toBe('prompt');
    if (root.type !== 'prompt') throw new Error('expected a prompt');
    expect(root.nonNegotiable).toBe('removalCircuitBreaker');
    expect(bash('rm -rf ~', { permissionManager: whitelisted }).type).toBe('prompt');
  });

  it('denies in dontAsk, which cannot prompt', () => {
    mockEffectivePermissionMode = 'dontAsk';
    const result = bash('rm -rf ~');

    expect(result.type).toBe('block');
    if (result.type !== 'block') throw new Error('expected a block');
    // NOT marked would-prompt: a PermissionRequest hook allow must not re-open
    // a home wipe no human ever saw.
    expect(result.source).toBeUndefined();
  });

  it('leaves ordinary cleanup alone in allow-all', () => {
    // The rows that decide whether this feature survives contact with users.
    for (const command of [
      'rm -rf ~/projects/scratch',
      'rm -rf ./build',
      'rm file.txt',
      'echo "rm -rf ~"',
    ]) {
      expect(bash(command).type, command).toBe('allow');
    }
  });

  /**
   * D16. The floor has to exist on every platform we ship a build for, and the
   * new spellings have to land on the SAME non-negotiable prompt the sh ones do
   * — not a parallel path. `promptIsNonNegotiable` is the exact predicate
   * `PiAgent`'s `autoBorderlineEligible` gate reads (`8c2990ad`), so asserting
   * it here IS the assertion that a rule, a remembered click and a
   * PermissionRequest hook `allow` cannot clear these in any mode.
   *
   * It is NO LONGER the assertion that the guardian never sees them: since P2.3
   * (`auto`) and P2.21 (`plan`) the same prompt also carries
   * `autoClassifierAdjudicated` in those two modes, and the row above is where
   * that predicate is pinned. The two markers are independent on purpose.
   */
  it('raises the same non-negotiable prompt for the spellings the ladder does not reach', () => {
    // Was `Remove-Item -Recurse -Force $HOME` until P2.34, and that is now a
    // DENY one rung earlier (`:601`, pinned below) — as is every other root or
    // home target the WINDOWS scan recognises, which leaves this D16 claim
    // carried by the heads the ladder deliberately skips: `rm`, `rmdir` and
    // `find` stay on the `rm` critical-path table (`:599`, gap (c) recorded).
    const result = bash('rmdir ~');

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    expect(result.nonNegotiable).toBe('removalCircuitBreaker');
    expect(promptIsNonNegotiable(result)).toBe(true);
    expect(result.rememberForMinutes).toBeUndefined();
    expect(result.commandHash).toBeUndefined();
    expect(result.description).toContain('home directory');
  });

  it('raises the same non-negotiable prompt for find … -delete, in auto', () => {
    mockEffectivePermissionMode = 'auto';
    const result = bash('find ~ -delete');

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    // The guardian is consulted only for a prompt this predicate says is
    // negotiable; a `no_objection` verdict must never be able to reach one.
    expect(promptIsNonNegotiable(result)).toBe(true);
  });

  it('stays silent on the innocent neighbours of the new spellings', () => {
    for (const command of [
      "find ~ -name '*.pyc' -delete",
      'find ~/build -delete',
      'find ~ -name "*.ts"',
      'Remove-Item -Recurse -Force $HOME/projects/scratch',
      'Get-ChildItem $HOME',
      'echo "Remove-Item -Recurse -Force $HOME"',
    ]) {
      expect(bash(command).type, command).toBe('allow');
    }
  });

  /**
   * P2.29 — the `Remove-Item` WILDCARD subclass, which is a DENY and not a
   * prompt. `permission-modes.md:602`, whole bullet, fetched 2026-08-23:
   *
   *   "**Wildcards**: a bare `*`, or any target ending in `/*` or `\*`,
   *   including a glob under a shell variable such as `$dir/*`. Claude Code
   *   denies the command in every mode, without asking you, before the
   *   classifier sees it."
   *
   * `mockShouldAllowToolInMode` allows everything here, so the mode branch can
   * never be the thing that blocks: every block below is this deny.
   */
  it('denies a Remove-Item wildcard removal in every mode, without asking', () => {
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as const) {
      mockEffectivePermissionMode = mode;
      const result = bash('Remove-Item -Recurse -Force $HOME/*');
      expect(result.type, mode).toBe('block');
      if (result.type !== 'block') throw new Error(`expected a block in ${mode}`);
      // NOT marked would-prompt: the page denies "without asking you", so a
      // `PermissionRequest` hook must not be handed a prompt to answer either.
      expect(result.source, mode).toBeUndefined();
      expect(result.reason, mode).toContain('denied in every permission mode');
      expect(result.reason, mode).toContain('home directory');
    }
  });

  it('denies the other spellings of the same wildcard target', () => {
    // All three are `Remove-Item` spellings the breaker already resolves: the
    // alias-only heads (`ri`, `del`, `rd`) are unreachable off Windows for a
    // different reason — `looksLikePowerShell` gates the Windows scan there, and
    // it recognises this command by its Verb-Noun head.
    mockEffectivePermissionMode = 'auto';
    for (const command of [
      'Remove-Item -Recurse -Force ~/*',
      'Remove-Item -Recurse -Force "$HOME/*"',
      'Remove-Item -Recurse -Force ${env:USERPROFILE}/*',
    ]) {
      expect(bash(command).type, command).toBe('block');
    }
  });

  /**
   * The scope line, pinned in the mode where it is easiest to get wrong. `:602`
   * is the second case of the `Remove-Item` ladder opened at `:599` — "Claude
   * Code gives `Remove-Item` its own check, separate from the `rm` critical-path
   * list" — and `:591` keeps `rm -rf <dir>/*` inside the critical-path LIST,
   * whose per-mode answers are the `:574-580` table. An `rm` glob therefore
   * still PROMPTS (and, in `auto`/`plan`, is adjudicated by the classifier).
   */
  it('leaves an `rm` glob on the critical-path table — prompt, not deny', () => {
    for (const mode of ['auto', 'plan', 'default', 'bypassPermissions'] as const) {
      mockEffectivePermissionMode = mode;
      const result = bash('rm -rf /*');
      expect(result.type, mode).toBe('prompt');
      if (result.type !== 'prompt') throw new Error(`expected a prompt in ${mode}`);
      expect(result.nonNegotiable, mode).toBe('removalCircuitBreaker');
      expect(promptIsClassifierAdjudicated(result), mode).toBe(mode === 'auto' || mode === 'plan');
    }
  });

  it('leaves a non-critical wildcard cleanup alone', () => {
    mockEffectivePermissionMode = 'bypassPermissions';
    for (const command of [
      'rm -rf build/*',
      // A NARROWER glob names specific children and was never in the breaker.
      'Remove-Item -Recurse -Force $HOME/*.log',
      // No trailing `/*` at all, so `:602` never had a claim on it — and the
      // relative SPELLING is no longer what spares it. `./build/*` and
      // `build/*` were pinned on this list as the recorded `:602` carve-out
      // until 2026-08-23; they are now pinned as denies below.
      'Remove-Item -Recurse -Force ./build',
    ]) {
      expect(bash(command).type, command).toBe('allow');
    }
  });

  /**
   * P2.34 — the ladder's other two rungs, both denies and neither a prompt.
   * `permission-modes.md`, fetched 2026-08-23:
   *
   *   `:601` — "**System paths**: the filesystem root and its top-level
   *   directories, drive roots and their top-level directories, and your home
   *   directory. Claude Code denies the command in every mode, without asking
   *   you."
   *
   *   `:602` — "**Wildcards**: a bare `*`, or any target ending in `/*` or
   *   `\*`, including a glob under a shell variable such as `$dir/*`. Claude
   *   Code denies the command in every mode, without asking you, before the
   *   classifier sees it."
   *
   * MEASURED BEFORE THE CHANGE (2026-08-23, `scratchpad/sdd/p2.34-precheck.ts`):
   * the matcher returned NO MATCH for `Remove-Item *`, `Remove-Item $dir/*` and
   * `Remove-Item /usr`, so nothing could deny them, and it returned a
   * root/home HIT for `Remove-Item $HOME` — which is a PROMPT, not the deny
   * `:601` requires.
   */
  /**
   * CANONICAL spellings, all seven of them, and that is load-bearing rather
   * than cosmetic: `mockEffectivePermissionMode` replaces the very function
   * that would have folded a legacy alias, so the pre-2026-07-31 spellings
   * this list used to carry (`safe`, `ask`, `allow-all` — see the union's own
   * docstring at the top of this file) reached `runPreToolUseChecks`
   * unnormalized and matched no branch at all. `bypassPermissions` is the
   * whole point of the ladder: `:603` grants "`bypassPermissions` mode skips
   * this check" to the THIRD case alone, so a row that never spelled it
   * proved nothing about the two that deny.
   */
  const LADDER_MODES = [
    'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
  ] as const;

  it('denies a bare `*` Remove-Item target in every mode, without asking', () => {
    for (const mode of LADDER_MODES) {
      mockEffectivePermissionMode = mode;
      const result = bash('Remove-Item -Recurse -Force *');
      expect(result.type, mode).toBe('block');
      if (result.type !== 'block') throw new Error(`expected a block in ${mode}`);
      expect(result.source, mode).toBeUndefined();
      expect(result.reason, mode).toContain('denied in every permission mode');
    }
  });

  it('denies a glob under a shell variable, wherever it points', () => {
    for (const mode of LADDER_MODES) {
      mockEffectivePermissionMode = mode;
      for (const command of [
        'Remove-Item -Recurse -Force $dir/*',
        'Remove-Item -Recurse -Force $HOME/projects/scratch/*',
      ]) {
        const result = bash(command);
        expect(result.type, `${mode} ${command}`).toBe('block');
        if (result.type !== 'block') throw new Error(`expected a block in ${mode}`);
        expect(result.source, `${mode} ${command}`).toBeUndefined();
        expect(result.reason, `${mode} ${command}`).toContain('denied in every permission mode');
      }
    }
  });

  /**
   * The round-2 review of P2.34 probed this at the gate and it ALLOWED in
   * `bypassPermissions`: `Remove-Item -Recurse -Force *` denied in every mode
   * while `./*`, `.\*` and `../*` — the same command to PowerShell, which
   * resolves `.` and `..` against the current location and accepts either
   * separator — walked straight past, a one-character step around an
   * every-mode deny. Reachable on win32 through spellings the ladder does
   * claim (`del .\*`, `rd /s /q .\*`), which is the platform where this scan
   * runs for EVERY command rather than only for one `looksLikePowerShell`
   * recognises. The refusal text made it worse: it told the model a bare `*`
   * or a target ending in `/*` or `\*` is denied everywhere, which is how a
   * model finds the spelling that is not.
   */
  it('denies a dot-only base, which is the bare `*` in another spelling', () => {
    for (const mode of LADDER_MODES) {
      mockEffectivePermissionMode = mode;
      for (const command of [
        'Remove-Item -Recurse -Force ./*',
        'Remove-Item -Recurse -Force .\\*',
        'Remove-Item -Recurse -Force ../*',
        'Remove-Item -Recurse -Force ..\\*',
      ]) {
        const result = bash(command);
        expect(result.type, `${mode} ${command}`).toBe('block');
        if (result.type !== 'block') throw new Error(`expected a block in ${mode}`);
        expect(result.source, `${mode} ${command}`).toBeUndefined();
        expect(result.reason, `${mode} ${command}`).toContain('denied in every permission mode');
      }
    }
  });

  /**
   * P2.49 — the carve-out that used to spare these, deleted by owner decision
   * (OQ-4, 2026-08-23) in favour of the page's literal width. `:602` says "any
   * target ending in `/*` or `\*`" with no exception for a relative base, and
   * P2.34 shipped one: a glob under a relative base that NAMED a subdirectory
   * kept the ordinary permission flow. These three rows were ALLOWED in
   * `bypassPermissions` on the shipped matcher before this change
   * (`scratchpad/sdd/p2.49-precheck.ts`, 2026-08-23: NO MATCH on `./build/*`,
   * `build/*`, `src/generated/*`).
   *
   * The absolute spelling of the same cleanup —
   * `Remove-Item -Recurse -Force /Users/…/project/build/*` — already denied in
   * every mode, so this makes the answer UNIFORM across spellings rather than
   * stricter in a place nothing was strict before.
   */
  it('denies a glob under a relative base, which no longer buys a carve-out', () => {
    for (const mode of LADDER_MODES) {
      mockEffectivePermissionMode = mode;
      for (const command of [
        'Remove-Item -Recurse -Force ./build/*',
        'Remove-Item -Recurse -Force build/*',
        'Remove-Item -Recurse -Force src/generated/*',
      ]) {
        const result = bash(command);
        expect(result.type, `${mode} ${command}`).toBe('block');
        if (result.type !== 'block') throw new Error(`expected a block in ${mode}`);
        expect(result.source, `${mode} ${command}`).toBeUndefined();
        expect(result.reason, `${mode} ${command}`).toContain('denied in every permission mode');
      }
    }
  });

  it("denies a system path — the ladder's FIRST case — in every mode", () => {
    for (const mode of LADDER_MODES) {
      mockEffectivePermissionMode = mode;
      for (const command of [
        'Remove-Item -Recurse -Force /usr',
        'Remove-Item -Recurse -Force C:\\Windows',
        'Remove-Item -Recurse -Force /',
      ]) {
        const result = bash(command);
        expect(result.type, `${mode} ${command}`).toBe('block');
        if (result.type !== 'block') throw new Error(`expected a block in ${mode}`);
        expect(result.source, `${mode} ${command}`).toBeUndefined();
        expect(result.reason, `${mode} ${command}`).toContain('denied in every permission mode');
      }
    }
  });

  it('denies the home directory itself, which used to be a prompt', () => {
    for (const mode of LADDER_MODES) {
      mockEffectivePermissionMode = mode;
      const result = bash('Remove-Item -Recurse -Force $HOME');
      expect(result.type, mode).toBe('block');
      if (result.type !== 'block') throw new Error(`expected a block in ${mode}`);
      expect(result.source, mode).toBeUndefined();
      expect(result.reason, mode).toContain('home directory');
      expect(result.reason, mode).toContain('denied in every permission mode');
    }
  });

  /**
   * Gap (c), RECORDED rather than implemented (P2.34, and the reasoning is on
   * `REMOVE_ITEM_LADDER_SKIPPED_HEADS` in the matcher): on Windows PowerShell
   * `rm` IS `Remove-Item`, but `:599` gives the ladder to `Remove-Item` "separate
   * from the `rm` critical-path list", the fork cannot know which shell will run
   * the command, and on win32 it spawns `cmd.exe`, where `rm` is not a command
   * at all. So an `rm` glob stays on the `:574-580` table. Pinned so a future
   * flip is a loud failure, not a silent widening.
   */
  it('does not extend the ladder to the sh spellings of the same removal', () => {
    mockEffectivePermissionMode = 'default';
    const result = bash('rm -rf ~/*');
    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    expect(result.nonNegotiable).toBe('removalCircuitBreaker');
  });
});

// ============================================================
// The protected-path floor
// ============================================================

/**
 * "`permissions.allow` rules in settings files do not pre-approve protected-path
 * writes. The safety check runs before Claude Code evaluates allow rules from
 * settings, so an entry such as `Edit(.claude/**)` in `~/.claude/settings.json`
 * or `.claude/settings.json` does not change the per-mode outcome in the table
 * above." The sentence is the anchor and the number a convenience:
 * `permission-modes.md:527` on the 2026-08-25 fetch, where the `:541` cited here
 * on 2026-08-23 has moved and the `:443` before that is a blank line.
 *
 * `mockShouldAllowToolInMode` returning `{ allowed: true }` IS the production
 * shape of an `allow` rule match (`matchesToolPermissionRule` → `{allowed:true}`,
 * mode-manager.ts:2118), which is why the allow-rule assertions below are
 * meaningful rather than a mock artefact. In `dontAsk` that shape is only
 * reachable THROUGH a rule — the mode otherwise blocks every write — so the
 * `dontAsk` case is the sharpest form of the same assertion.
 *
 * No path here is a real file on the machine running the suite: the floor does no
 * filesystem access, and the targets sit under the fake `/test/workspace` root the
 * rest of this file uses.
 */
describe('protected-path floor', () => {
  const write = (filePath: string, overrides?: Partial<PreToolUseInput>) =>
    runPreToolUseChecks(createInput({ toolName: 'Write', input: { file_path: filePath }, ...overrides }));

  beforeEach(() => {
    mockEffectivePermissionMode = 'default';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
  });

  it('prompts for a protected-path write and offers no don\'t-ask-again', () => {
    const result = write('/test/workspace/.claude/settings.json');

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    expect(result.nonNegotiable).toBe('protectedPath');
    expect(promptIsNonNegotiable(result)).toBe(true);
    expect(result.rememberForMinutes).toBeUndefined();
    expect(result.commandHash).toBeUndefined();
    expect(result.description).toContain('.claude');
  });

  // THE assertion that proves the floor is a floor. A deny rule cannot substitute,
  // because a deny rule is read in the same pass as the allows; this check runs
  // before that pass exists.
  it('is unchanged by an allow rule naming the same path', () => {
    const whitelisted = createMockPermissionManager({ isCommandWhitelisted: () => true });

    // Control: the same allow shape really does clear an ordinary write prompt.
    expect(write('/test/workspace/src/index.ts', { permissionManager: whitelisted }).type)
      .toBe('allow');

    for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
      mockEffectivePermissionMode = mode;
      const result = write('/test/workspace/.npmrc', { permissionManager: whitelisted });
      expect(result.type, mode).toBe('prompt');
      if (result.type !== 'prompt') throw new Error('expected a prompt');
      expect(result.nonNegotiable, mode).toBe('protectedPath');
    }

    // `acceptEdits` auto-approves writes inside the session's roots; the floor
    // still outranks that, since it is evaluated before the branch that reads it.
    mockEffectivePermissionMode = 'acceptEdits';
    expect(write('/test/workspace/.zshrc', { workingDirectory: '/test/workspace' }).type)
      .toBe('prompt');

    // `dontAsk` + `{allowed: true}` is ONLY reachable through an allow rule, and
    // the documented answer for that mode is a denial, not the rule's allow.
    mockEffectivePermissionMode = 'dontAsk';
    const denied = write('/test/workspace/.claude.json', { permissionManager: whitelisted });
    expect(denied.type).toBe('block');
    if (denied.type !== 'block') throw new Error('expected a block');
    expect(denied.reason).toContain('protected path');
    // Not marked would-prompt: a PermissionRequest hook allow is auto-approval,
    // and these writes are "never auto-approved" outside bypassPermissions.
    expect(denied.source).toBeUndefined();
  });

  it('allows the write in allow-all, unlike the removal circuit breaker', () => {
    mockEffectivePermissionMode = 'bypassPermissions';
    expect(write('/test/workspace/.claude/settings.json').type).toBe('allow');
  });

  it('permits the worktrees carve-out and leaves siblings alone', () => {
    for (const target of [
      '/test/workspace/.claude/worktrees/lease-1/src/index.ts',
      '/test/workspace/.nessy-agent/worktrees/lease-1/src/index.ts',
      '/test/workspace/src/index.ts',
      '/test/workspace/.gitignore',
    ]) {
      expect(write(target).type, target).toBe('prompt');
      const result = write(target);
      if (result.type !== 'prompt') throw new Error('expected a prompt');
      // Still an ordinary, rememberable ask-mode prompt — not the floor.
      expect(result.nonNegotiable, target).toBeUndefined();
      expect(result.rememberForMinutes, target).toBe(10);
    }
  });

  it('fires for a Bash redirect into a protected FILE, and still not for `.git` (C4.50)', () => {
    // D1.439 — this arm used to assert the OPPOSITE, and its own comment
    // predicted its falsification: *"the residue is `.npmrc` here, the closure
    // is `.codex` there, and a later widening has to move one of them."* C4.50
    // (owner decision 2026-09-13, option B) IS that widening — the shell gate
    // reads the whole of `PROTECTED_FILES` through `findProtectedFileWrite` —
    // and the arm was not moved, so it sat red once the bun crash was gone.
    //
    // What it pins now is C4.50's own sentence: the same byte written two ways
    // gets ONE answer, which is the hole the row was born for (`>> ~/.zshrc`
    // through `Bash` raised no card while `Write {file_path:'~/.zshrc'}` raised
    // the floor). And it keeps the pair honest by asserting what did NOT move:
    // `.git` is a protected DIRECTORY and is deliberately OUT of the shell
    // gate's `SHELL_GATED_AGENT_CONFIG_DIRS`, because a `.git` entry would
    // refuse the `git commit` that `session-filesystem-scope.ts` calls the only
    // writer. Deleting this arm instead of moving it would have dropped both.
    const shell = runPreToolUseChecks(createInput({
      toolName: 'Bash',
      input: { command: 'echo x > /test/workspace/.npmrc' },
    }));
    const fileTool = write('/test/workspace/.npmrc');
    const gitCommit = runPreToolUseChecks(createInput({
      toolName: 'Bash',
      input: { command: 'git commit -m x' },
    }));
    expect({
      shell: shell.type === 'prompt' ? shell.nonNegotiable : shell.type,
      fileTool: fileTool.type === 'prompt' ? fileTool.nonNegotiable : fileTool.type,
      gitCommit: gitCommit.type === 'prompt' ? gitCommit.nonNegotiable : gitCommit.type,
    }).toEqual({ shell: 'protectedPath', fileTool: 'protectedPath', gitCommit: undefined });
  });

  it('DOES fire for a Bash write into an agent-config directory (C3.353)', () => {
    // Rig day R2 measured the agent writing `<repo>/.codex/rules/*.rules` through
    // `Bash` with no card, and codex then ENFORCING the rule it had written. The
    // unit-level shapes live in `agent-config-shell-write-floor.test.ts`; this is
    // the PIPELINE answer — that the floor reaches the card the user meets.
    const result = runPreToolUseChecks(createInput({
      toolName: 'Bash',
      input: { command: 'printf x > /test/workspace/.codex/rules/x.rules' },
    }));

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('expected a prompt');
    expect(result.nonNegotiable).toBe('protectedPath');
    expect(promptIsNonNegotiable(result)).toBe(true);
    // The card carries the COMMAND and the shell type: `extractFileToolTargetPath`
    // reads no path out of a Bash input, so the file-tool spelling would have put
    // the bare word `Bash` on a card for a command the user cannot see.
    expect(result.promptType).toBe('bash');
    expect(result.command).toContain('.codex/rules/x.rules');
    expect(result.description).toContain('.codex');
    // No don't-ask-again, exactly like the file-tool arm: those two fields ARE
    // the remember mechanism, and this write is never auto-approved.
    expect(result.rememberForMinutes).toBeUndefined();
    expect(result.commandHash).toBeUndefined();
  });

  it('leaves a READ of that same path alone', () => {
    // The half the row's `done_means` names. A floor keyed on "the command
    // mentions `.codex`" would fail here, which is why the shell reading is
    // write-shaped rather than a substring test.
    const result = runPreToolUseChecks(createInput({
      toolName: 'Bash',
      input: { command: 'cat /test/workspace/.codex/rules/x.rules' },
    }));
    if (result.type === 'prompt') expect(result.nonNegotiable).not.toBe('protectedPath');
  });
});

// UA12.85 — loaded at the end so every line cited above (highest 2180) keeps its place; `await import`, not a static import, per F1.552 (F1.133); read only inside `it` bodies, which run after this line.
const { bashRememberKey } = await import('../dangerous-commands.ts');
