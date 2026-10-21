/**
 * R28 Task 4 — `paths:` rules fire on the FILE BEING READ.
 *
 * `memory.md`: "Path-scoped rules trigger when Claude reads files matching the
 * pattern, not on every tool use." Ours compiled the rule's globs against the
 * WORKING DIRECTORY (`getWorkingDirectoryMatchPath` → `.` or `packages/api`),
 * so a documented glob such as `src/api/**` + `*.ts` could never match and NO
 * path-scoped rule has ever fired.
 *
 * Everything here runs through `runPreToolUseChecks` — the production gate, with
 * real tool inputs. A matcher a unit calls with a file path while production
 * still passes the working directory is exactly the defect this file exists to
 * prevent.
 *
 * Hardening, same page: a rule's whole `paths` list "shares one budget of 1,000
 * expanded patterns and 4 MiB, and patterns without braces don't count against
 * it"; over-budget patterns are used unexpanded so "its literal braces match no
 * files"; and a pattern with an unreadable `[` "matches nothing, and the rule's
 * other patterns keep working".
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { afterAll, describe, expect, it } from 'bun:test';
import {
  runPreToolUseChecks,
  type PathScopedRuleActivation,
  type PathScopedRuleDefinition,
  type PermissionManagerLike,
  type PreToolUseInput,
} from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import { collectPathScopedRuleActivations } from '../memory/rule-matching.ts';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';
import {
  TestAgent,
  collectEvents,
  createMockBackendConfig,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const PROJECT = '/fixture/project';

/** Exposes the two protected seams a backend spreads into its check args. */
class RuleTestAgent extends TestAgent {
  pathScopedRuleGateContext() { return this.getPathScopedRulePreToolUseContext(); }
  pendingRuleContext() { return this.consumePendingPathScopedRuleContext(); }
}

/** A capability generation whose memory layers are these rule files. */
function runtimeWithRuleFiles(
  files: Record<string, string>,
  generation = 'generation-paths-1',
): CapabilityTurnRuntime {
  const resource = (absolutePath: string): NativeResourceRef => ({
    source: 'project',
    scope: { kind: 'project', workspaceId: 'ws' },
    resourceId: absolutePath,
    absolutePath,
    revision: '1',
    contentHash: 'd'.repeat(64),
  });
  return {
    provider: 'pi',
    view: {
      generation,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [],
      memory: Object.keys(files).map(path => ({
        key: `memory::project::ws::-::rules::${path}`,
        resource: resource(path),
        readOnly: false,
        format: 'rule' as const,
      })),
      permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(res: unknown) { return (res as NativeResourceRef).absolutePath; },
      async readText(res: unknown) { return files[(res as NativeResourceRef).absolutePath] ?? ''; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

const sessionKeys: Array<{ workspaceId: string; sessionId: string }> = [];

afterAll(() => {
  for (const key of sessionKeys) cleanupModeState(key);
});

function rule(name: string, patterns: string[], body = `Body of ${name}`): PathScopedRuleDefinition {
  return {
    key: `memory::project::ws::-::rules::${name}`,
    filePath: `${PROJECT}/.claude/rules/${name}`,
    matchRoot: PROJECT,
    patterns,
    body,
  };
}

let sessionCounter = 0;

/** One real gate call. Returns whatever the per-read rule trigger activated. */
function readFile(
  filePath: string,
  rules: PathScopedRuleDefinition[],
  toolName = 'Read',
  inputOverride?: Record<string, unknown>,
  workingDirectory = PROJECT,
): PathScopedRuleActivation[] {
  const sessionKey = { workspaceId: 'ws-rules', sessionId: `rules-session-${sessionCounter++}` };
  sessionKeys.push(sessionKey);
  cleanupModeState(sessionKey);
  initializeModeState(sessionKey, 'bypassPermissions');

  const activated: PathScopedRuleActivation[] = [];
  const ctx: PreToolUseInput = {
    toolName,
    input: inputOverride ?? { file_path: filePath },
    sessionId: sessionKey.sessionId,
    sessionKey,
    permissionMode: 'bypassPermissions',
    workspaceRootPath: PROJECT,
    workspaceId: 'ws-rules',
    workingDirectory,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    pathScopedRules: {
      rules,
      onActivated: activations => { activated.push(...activations); },
    },
  };
  runPreToolUseChecks(ctx);
  return activated;
}

describe('a path-scoped rule fires on the file being read', () => {
  it('injects the rule when the read file matches the documented glob', () => {
    const api = rule('api.md', ['src/api/**/*.ts']);
    const activated = readFile(`${PROJECT}/src/api/users.ts`, [api]);
    expect(activated.map(a => a.rule.key)).toEqual([api.key]);
    expect(activated[0]!.body).toBe('Body of api.md');
    expect(activated[0]!.triggerFilePath).toBe(`${PROJECT}/src/api/users.ts`);
    expect(activated[0]!.matchedPatterns).toEqual(['src/api/**/*.ts']);
  });

  it('does not inject the rule for a non-matching file', () => {
    const api = rule('api.md', ['src/api/**/*.ts']);
    expect(readFile(`${PROJECT}/src/ui/button.tsx`, [api])).toEqual([]);
    expect(readFile(`${PROJECT}/docs/api.md`, [api])).toEqual([]);
  });

  it('no longer matches a working-directory-shaped pattern by accident', () => {
    // The old compile matched the rule's globs against the working directory,
    // so `packages/app/**` fired for every tool call made from that directory.
    // It must now fire only for a FILE under it.
    const legacy = rule('legacy.md', ['packages/app/**']);
    expect(readFile(`${PROJECT}/packages/other/index.ts`, [legacy])).toEqual([]);
    expect(readFile(`${PROJECT}/packages/app/index.ts`, [legacy]).map(a => a.rule.key))
      .toEqual([legacy.key]);
  });

  it('matches the documented glob table', () => {
    const cases: Array<[string, string, boolean]> = [
      ['**/*.ts', 'src/deep/a.ts', true],
      ['**/*.ts', 'a.ts', true],
      ['**/*.ts', 'a.tsx', false],
      ['src/**/*', 'src/a/b/c.ts', true],
      ['src/**/*', 'lib/a.ts', false],
      ['*.md', 'README.md', true],
      ['*.md', 'docs/README.md', false],
      ['src/components/*.tsx', 'src/components/Button.tsx', true],
      ['src/components/*.tsx', 'src/components/nested/Button.tsx', false],
    ];
    for (const [pattern, relative, expected] of cases) {
      const activated = readFile(`${PROJECT}/${relative}`, [rule('r.md', [pattern])]);
      expect(activated.length > 0, `${pattern} vs ${relative}`).toBe(expected);
    }
  });

  it('fires for every file-path tool, not only Read', () => {
    const api = rule('api.md', ['src/**/*.ts']);
    expect(readFile(`${PROJECT}/src/a.ts`, [api], 'Edit').length).toBe(1);
    expect(readFile(`${PROJECT}/src/a.ipynb`, [rule('nb.md', ['src/**/*.ipynb'])], 'NotebookEdit', {
      notebook_path: `${PROJECT}/src/a.ipynb`,
    }).length).toBe(1);
    // A tool that opens no file never triggers a rule.
    expect(readFile(`${PROJECT}/src/a.ts`, [api], 'Bash', { command: 'cat src/a.ts' })).toEqual([]);
  });
});

describe('brace-expansion budget', () => {
  it('expands a brace list that fits the budget', () => {
    const r = rule('multi.md', ['src/**/*.{ts,tsx}']);
    expect(readFile(`${PROJECT}/src/a.tsx`, [r]).length).toBe(1);
    expect(readFile(`${PROJECT}/src/a.ts`, [r]).length).toBe(1);
    expect(readFile(`${PROJECT}/src/a.js`, [r]).length).toBe(0);
  });

  it('uses an over-budget brace list UNEXPANDED, so its literal braces match nothing', () => {
    // Each group multiplies: 4 groups of 10 already exceed 1,000 expansions.
    const alternatives = (n: number) => `{${Array.from({ length: n }, (_, i) => `a${i}`).join(',')}}`;
    const huge = `src/${alternatives(10)}/${alternatives(10)}/${alternatives(10)}/${alternatives(10)}/*.ts`;
    const r = rule('huge.md', [huge]);
    // No expansion happened, so no real file matches …
    expect(readFile(`${PROJECT}/src/a0/a0/a0/a0/x.ts`, [r])).toEqual([]);
    // … and the pattern is used literally, braces and all.
    expect(readFile(`${PROJECT}/src/${alternatives(10)}/${alternatives(10)}/${alternatives(10)}/${alternatives(10)}/x.ts`, [r]).length).toBe(1);
  });

  it('shares one budget across the whole `paths` list, and brace-free patterns do not charge it', () => {
    const nearBudget = `src/{${Array.from({ length: 999 }, (_, i) => `d${i}`).join(',')}}/x.ts`;
    const r = rule('shared.md', [
      'lib/**/*.ts',      // brace-free: never charged
      nearBudget,          // 999 expansions — fits
      'app/{a,b}/y.ts',    // 2 more would exceed 1,000 → used unexpanded
    ]);
    expect(readFile(`${PROJECT}/lib/deep/a.ts`, [r]).length).toBe(1);
    expect(readFile(`${PROJECT}/src/d0/x.ts`, [r]).length).toBe(1);
    expect(readFile(`${PROJECT}/app/a/y.ts`, [r])).toEqual([]);
    expect(readFile(`${PROJECT}/app/{a,b}/y.ts`, [r]).length).toBe(1);
  });
});

describe('an unreadable bracket expression', () => {
  it('matches nothing while the rule’s other patterns keep working', () => {
    // `photos [2024/**` is the documented invalid example.
    const r = rule('brackets.md', ['photos [2024/**', 'src/**/*.ts']);
    expect(readFile(`${PROJECT}/photos [2024/a.jpg`, [r])).toEqual([]);
    expect(readFile(`${PROJECT}/src/a.ts`, [r]).length).toBe(1);
  });

  it('honours a valid bracket expression and the documented escape', () => {
    expect(readFile(`${PROJECT}/src/a.ts`, [rule('cls.md', ['src/[ab].ts'])]).length).toBe(1);
    expect(readFile(`${PROJECT}/src/c.ts`, [rule('cls.md', ['src/[ab].ts'])])).toEqual([]);
    expect(readFile(`${PROJECT}/photos [2024/a.jpg`, [rule('esc.md', ['photos \\[2024/**'])]).length).toBe(1);
  });
});

describe('compaction', () => {
  it('a `paths:` rule is absent until a matching file is read again', () => {
    // The gate is the ONLY producer: nothing is standing behind it re-adding
    // the rule, so after compaction drops the message history the rule stays
    // gone until the next matching read re-activates it. Asserted as the gate
    // contract: a turn with no matching read activates nothing.
    const api = rule('api.md', ['src/api/**/*.ts']);
    expect(readFile(`${PROJECT}/README.md`, [api])).toEqual([]);
    expect(readFile(`${PROJECT}/src/api/users.ts`, [api]).length).toBe(1);
    expect(readFile(`${PROJECT}/README.md`, [api])).toEqual([]);
  });

  it('BaseAgent delivers a matched rule once, and again only after compaction', async () => {
    // The other half of the same contract, through the agent that owns the
    // catalog: the rule is collected from the capability generation (never into
    // the pinned block), delivered once on the hidden per-tool channel, and
    // forgotten when compaction resets the session's post-compaction state.
    const agent = new RuleTestAgent(createMockBackendConfig({
      workspace: createMockWorkspace({ workspaceRootPath: PROJECT }),
      session: createMockSession({ workingDirectory: PROJECT }),
    }));
    agent.setCapabilityTurnRuntime(runtimeWithRuleFiles({
      [`${PROJECT}/.claude/rules/api.md`]: '---\npaths:\n  - "src/api/**/*.ts"\n---\n\nValidate every API input.',
      [`${PROJECT}/.claude/rules/style.md`]: 'Always use tabs.',
    }));
    await collectEvents(agent.chat('go'));

    // Unscoped rule is pinned; the `paths:` rule is not.
    expect(agent.chatCalls[0]!.message).toContain('Always use tabs.');
    expect(agent.chatCalls[0]!.message).not.toContain('Validate every API input.');

    const gate = agent.pathScopedRuleGateContext();
    expect(gate.pathScopedRules?.rules.map(r => r.filePath)).toEqual([`${PROJECT}/.claude/rules/api.md`]);

    const activate = (filePath: string) => {
      const activations = collectPathScopedRuleActivations(gate.pathScopedRules!.rules, [filePath]);
      gate.pathScopedRules!.onActivated(activations);
    };

    activate(`${PROJECT}/src/api/users.ts`);
    expect(agent.pendingRuleContext()).toContain('Validate every API input.');
    // Delivered once: a second matching read adds nothing while it is still in
    // context.
    activate(`${PROJECT}/src/api/orders.ts`);
    expect(agent.pendingRuleContext()).toBeUndefined();

    // Compaction summarised the message history away — the rule is gone with
    // it, so the next matching read must re-inject it.
    agent.resetPrerequisiteState();
    activate(`${PROJECT}/src/api/users.ts`);
    expect(agent.pendingRuleContext()).toContain('Validate every API input.');
  });
});

describe('an edited rule', () => {
  it('delivers its NEW body once the capability generation changes', async () => {
    // CDP pass 14 found this the hard way: a rule that had already fired was
    // edited on disk, and its replacement body could never reach the model.
    // The catalog is rebuilt (new content hash → new generation), but the
    // activation set is keyed on the rule KEY, which does not change when the
    // file's contents do — so the stale entry suppressed the new body forever.
    // Delivery is "once per generation", not "once per agent".
    const rulePath = `${PROJECT}/.claude/rules/frontend/scoped.md`;
    const withBody = (body: string) => ({
      [rulePath]: `---\npaths: ["packages/ui/**/*.ts"]\n---\n\n${body}`,
    });
    const agent = new RuleTestAgent(createMockBackendConfig({
      workspace: createMockWorkspace({ workspaceRootPath: PROJECT }),
      session: createMockSession({ workingDirectory: PROJECT }),
    }));

    const readMatchingFile = () => {
      const gate = agent.pathScopedRuleGateContext();
      gate.pathScopedRules?.onActivated(
        collectPathScopedRuleActivations(
          gate.pathScopedRules.rules,
          [`${PROJECT}/packages/ui/src/components/chat/turn-utils.ts`],
        ),
      );
      return agent.pendingRuleContext();
    };

    agent.setCapabilityTurnRuntime(runtimeWithRuleFiles(withBody('Say SCOPED_RULE_ACTIVE.'), 'gen-1'));
    await collectEvents(agent.chat('first'));
    expect(readMatchingFile()).toContain('SCOPED_RULE_ACTIVE');
    // Still once per generation: a second matching read adds nothing.
    expect(readMatchingFile()).toBeUndefined();

    // The author edits the rule; the inventory re-hashes it into a new
    // generation and the pinned catalog is recomposed with the new body.
    agent.setCapabilityTurnRuntime(runtimeWithRuleFiles(withBody('Say ZEBRA7741.'), 'gen-2'));
    await collectEvents(agent.chat('second'));

    const delivered = readMatchingFile();
    expect(delivered).toContain('ZEBRA7741');
    expect(delivered).not.toContain('SCOPED_RULE_ACTIVE');
  });
});

describe('F1.1253: a relative tool path resolves against the session working directory', () => {
  // Pi's file tools take a `path` relative to the session's folder, and the gate
  // runs in the host process, whose own cwd is not that folder.
  const SUBDIR = `${PROJECT}/packages/app`;

  it('a relative read activates the rule, and the trigger is the absolute file', () => {
    const api = rule('api.md', ['packages/app/src/**/*.ts']);
    const activated = readFile('src/users.ts', [api], 'Read', { path: 'src/users.ts' }, SUBDIR);
    expect(activated.map(a => a.rule.key)).toEqual([api.key]);
    expect(activated[0]!.triggerFilePath).toBe(`${SUBDIR}/src/users.ts`);
  });

  it('a relative read outside the rule\'s globs stays silent', () => {
    const api = rule('api.md', ['packages/app/src/**/*.ts']);
    expect(readFile('docs/users.md', [api], 'Read', { path: 'docs/users.md' }, SUBDIR)).toEqual([]);
  });

  it('CONTROL: an absolute path is matched as it is, whatever the working directory', () => {
    const api = rule('api.md', ['packages/app/src/**/*.ts']);
    const activated = readFile(`${SUBDIR}/src/users.ts`, [api], 'Read', undefined, `${PROJECT}/elsewhere`);
    expect(activated.map(a => a.triggerFilePath)).toEqual([`${SUBDIR}/src/users.ts`]);
    expect(readFile(`/other/packages/app/src/users.ts`, [api], 'Read', undefined, SUBDIR)).toEqual([]);
  });
});
