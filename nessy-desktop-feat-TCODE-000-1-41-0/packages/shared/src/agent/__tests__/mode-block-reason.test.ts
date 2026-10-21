/**
 * P2.32 — the mode block names the real mode.
 *
 * `shouldAllowToolInMode`'s blocked-tool branch built its whole message out of
 * `config` — and `config.displayName` is `SAFE_MODE_CONFIG`'s `'Explore'` on
 * EVERY path, because `SAFE_MODE_CONFIG` is both the no-`permissionsContext`
 * fallback and the base `buildMergedConfig` copies `displayName`/`shortcutHint`
 * from. Measured before the fix, for BOTH `plan` and `dontAsk`:
 *
 *   "File modifications are blocked in Explore. Switch to Manual or Bypass
 *    permissions mode (SHIFT+TAB) to make changes."
 *
 * Both halves were wrong: the mode name, and the escape hint (a plan user was
 * told to switch modes rather than to approve the plan; an Unattended session,
 * which `permission-modes.md:132` says "never appears in the cycle", was handed
 * a SHIFT+TAB shortcut instead of the allow rule that would actually admit the
 * call — `permission-modes.md:474`).
 *
 * Three modes reach this branch: `bypassPermissions` and the interactive write
 * modes return `allowed` above it, so only `dontAsk`, `explore` and `plan` can
 * get here. That enumeration is pinned below.
 *
 * The fix wave added the second half. `getBlockReasonWithConfig` was not the
 * only message `shouldAllowToolInMode` builds: four siblings in the same
 * function (session-config, API-via-MCP, MCP write, API) already named the
 * right mode but still offered `formatModeSwitchHint`, so ONE dontAsk session
 * read two different escapes depending on which tool it reached for —
 * "Pre-approve it with an explicit allow rule…" for `Write` and "…(SHIFT+TAB)"
 * for `mcp__foo__write_file`, the shortcut permission-modes.md:132 says
 * Unattended "never appears in the cycle" of. Every escape below is asserted as
 * a SET per mode, deliberately: a future divergence fails as a set of two.
 *
 * WHICH of these EIGHT a live session can actually hit (six until P2.47 —
 * the set below covered 6 of the 8 reachable branches, so a divergence in
 * either of the other two could not fail against it). When P2.32 measured this,
 * `config.blockedTools` was hardcoded to Write/Edit/MultiEdit/NotebookEdit and a
 * user's own `blockedTools` was parsed but never merged, so three branches were
 * dead. P2.39 merged the user's list, and the map is now:
 *
 * - REACHABLE with no configuration: the file-modification message
 *   (Write/Edit/MultiEdit), the generic message (NotebookEdit — blocked with no
 *   message of its own), and all FOUR siblings, which are keyed on the tool NAME
 *   and not on `blockedTools`.
 * - REACHABLE ONLY through a declared `blockedTools`: the `mcp__` and `api_`
 *   branches, both pinned below. A name in `blockedTools` is answered at the
 *   blocked-tool branch, which sits ABOVE the two siblings that used to answer
 *   those names first.
 * - STILL UNREACHABLE: the `Bash` branch. `shouldAllowToolInMode`'s
 *   `toolName === 'Bash'` arm returns on every path — allowed, rejected, or the
 *   missing-command message — so `Bash` never falls through to the blocked-tool
 *   branch, whatever `blockedTools` says.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { shouldAllowToolInMode } from '../mode-manager.ts';
import { PERMISSION_MODE_ORDER, type PermissionMode } from '../mode-types.ts';
import { parsePermissionsJson, permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';

afterEach(() => { permissionsConfigCache.clear(); });

const WRITE_INPUT = { file_path: '/tmp/p2.32/a.ts', content: 'x' };

function blockReason(
  mode: PermissionMode,
  toolName = 'Write',
  options?: { permissionsContext?: PermissionsContext; toolInput?: unknown }
): string {
  const { toolInput = WRITE_INPUT, ...checkOptions } = options ?? {};
  const result = shouldAllowToolInMode(toolName, toolInput, mode, checkOptions);
  if (result.allowed) throw new Error(`expected ${toolName} to be blocked in ${mode}`);
  return result.reason;
}

/** The merged-config path — same `displayName`, so the same defect. */
function context(): PermissionsContext {
  return {
    workspaceRootPath: '/nonexistent/p2.32-block-reason',
    pinnedRevision: 'gen',
    pinnedConfigs: [{
      config: parsePermissionsJson(JSON.stringify({ allowedBashPatterns: ['^ls\\b'] })),
      scope: 'workspace' as const,
    }],
  };
}

describe('a blocked write names the mode that actually blocked it', () => {
  it('plan is named Plan and is pointed at its own way out', () => {
    const reason = blockReason('plan');
    expect(reason).toBe(
      'File modifications are blocked in Plan. Call SubmitPlan and let the user approve the plan, '
      + 'or ask them to leave Plan mode (SHIFT+TAB) to make changes.'
    );
    expect(reason).not.toContain('Explore');
  });

  it('dontAsk is named Don\'t ask (F1.1052) and is pointed at an allow rule, not at a shortcut it has no place in', () => {
    const reason = blockReason('dontAsk');
    expect(reason).toBe(
      'File modifications are blocked in Don\'t ask. This call needs an explicit allow rule, '
      + 'or a switch to Manual or Bypass permissions mode to make changes.'
    );
    expect(reason).not.toContain('Explore');
    expect(reason).not.toContain('SHIFT+TAB');
  });

  // F1.1050 (DN-272) deleted the "explore is unchanged" arm and the explore halves below with the retired mode;
  // plan and dontAsk keep their whole-message anchors.

  it('the generic branch carries the real mode too — NotebookEdit is blocked without a message of its own', () => {
    expect(blockReason('plan', 'NotebookEdit')).toBe(
      'NotebookEdit is blocked in Plan. Call SubmitPlan and let the user approve the plan, '
      + 'or ask them to leave Plan mode (SHIFT+TAB) to use this tool.'
    );
  });

  it('a merged permissions config does not put Explore back — its displayName is the same copy', () => {
    expect(blockReason('plan', 'Write', { permissionsContext: context() })).toContain('blocked in Plan.');
    expect(blockReason('dontAsk', 'Write', { permissionsContext: context() })).toContain("blocked in Don't ask.");
  });

  it('exactly two modes reach this branch (three before F1.1050 retired explore), and each one names itself', () => {
    const blocking: PermissionMode[] = [];
    for (const mode of PERMISSION_MODE_ORDER) {
      const result = shouldAllowToolInMode('Write', WRITE_INPUT, mode);
      if (result.allowed) continue;
      blocking.push(mode);
    }
    expect(blocking).toEqual(['dontAsk', 'plan']);
    expect(blockReason('dontAsk')).toContain("blocked in Don't ask.");
    expect(blockReason('plan')).toContain('blocked in Plan.');
  });
});

const API_INPUT = { method: 'GET', path: '/v1/reports' };
const MCP_TOOL = 'mcp__linear__read_issue';

/**
 * The declared list rides in the REVISION as well as in the layer.
 *
 * This note used to end "…and a pinned layer's CONTENT is not part of that
 * key, so a control and its subject sharing one revision would be served the
 * same merged config and prove nothing." That was true when it was written and
 * is now stale: P2.45 added a `canonicalJson` digest of `pinnedConfigs` to the
 * cache key, so content alone already separates a control from its subject.
 * The distinct revision stays because it is free and because it keeps each
 * case readable at the call site — not because the cache still needs it.
 *
 * Hoisted to module scope by P2.47 so {@link BLOCK_CASES} can reach the two
 * branches that only a declared `blockedTools` makes reachable.
 */
function declaring(...blockedTools: string[]): PermissionsContext {
  return {
    workspaceRootPath: '/nonexistent/p2.39-blocked-tools',
    pinnedRevision: `gen-${blockedTools.join('|') || 'none'}`,
    pinnedConfigs: [{
      config: parsePermissionsJson(JSON.stringify({ allowedMcpPatterns: ['read_issue'], blockedTools })),
      scope: 'workspace' as const,
    }],
  };
}

/**
 * Mode → the ONE escape hint P2.32's fix wave gives every branch of that mode,
 * and mode → the label its messages name it by.
 *
 * P2.47 — these two maps were hand-copied into a THIRD place in this file: the
 * `hintsFor` describe wrote each hint out as a literal argument to
 * `everyBranch`, and the `blockedTools` describe kept its own `ESCAPE`/`LABEL`
 * pair. Three copies of a string whose whole invariant is "there is exactly one
 * of me" is the defect wearing the shape of its own test. One copy now, read by
 * both describes.
 *
 * The exact, whole messages stay written out longhand in the first describe and
 * in the byte-equality row below — those are the anchors, and collapsing THEM
 * into this map would leave nothing pinning the map itself.
 */
const ESCAPE: Record<'dontAsk' | 'plan', string> = {
  dontAsk: 'This call needs an explicit allow rule, or a switch to Manual or Bypass permissions mode',
  plan: 'Call SubmitPlan and let the user approve the plan, or ask them to leave Plan mode (SHIFT+TAB)',
};
const LABEL: Record<'dontAsk' | 'plan', string> = {
  dontAsk: "Don't ask",
  plan: 'Plan',
};

// F1.1050 (DN-272) — the retired `explore` left both maps above. It was the one
// mode whose escape was "Switch to Manual or Bypass permissions mode (SHIFT+TAB)"
// on every branch below; that wording now belongs to no blocking mode, and
// `mode-manager.test.ts` keeps it in its escape registry as a tripwire. The two
// modes that still reach these branches — `dontAsk` and `plan` — each keep the
// whole-message anchors in the first describe and the per-branch set here.
// (These lines also keep this file's line numbers where the plan cites them:
// the blockedTools cases below.)

/**
 * The EIGHT block messages ONE `shouldAllowToolInMode` call can produce, each
 * from a different branch of the same function. The first two go through
 * `getBlockReasonWithConfig`; the next four are the siblings that used to offer
 * Explore's escape to every mode; the last two are the blocked-tool branch's
 * own `mcp__`/`api_` arms, which P2.39 brought back to life.
 *
 * P2.47 — it held SIX until 2026-09-03, and the set-shaped invariant it feeds
 * is what a divergence has to fail against, so covering 6 of 8 reachable
 * branches made the guard quietly partial. The two additions need a
 * `permissionsContext` declaring the tool's name in `blockedTools` (that is the
 * only way those arms are reachable at all — see the header's reachability
 * map), which is why each case carries its own optional context rather than the
 * set sharing one.
 *
 * The header's own map says which of these a live session can hit and how; the
 * `Bash` arm stays absent because it is still unreachable, and the last
 * describe pins that separately.
 */
const BLOCK_CASES: ReadonlyArray<{
  label: string;
  tool: string;
  input: unknown;
  permissionsContext?: PermissionsContext;
}> = [
  { label: 'file modification', tool: 'Write', input: WRITE_INPUT },
  { label: 'generic (NotebookEdit)', tool: 'NotebookEdit', input: { notebook_path: '/tmp/p2.32/a.ipynb', new_source: 'x' } },
  { label: 'session configuration', tool: 'mcp__session__spawn_session', input: {} },
  { label: 'API via MCP', tool: 'mcp__foo__api_thing', input: { method: 'POST', path: '/v1/things' } },
  { label: 'MCP write', tool: 'mcp__foo__write_file', input: { path: '/tmp/p2.32/x' } },
  { label: 'API', tool: 'api_request', input: { method: 'POST', path: '/v1/things' } },
  {
    label: 'blockedTools (api_)',
    tool: 'api_reports',
    input: API_INPUT,
    permissionsContext: declaring('api_reports'),
  },
  {
    label: 'blockedTools (mcp__)',
    tool: MCP_TOOL,
    input: {},
    permissionsContext: declaring(MCP_TOOL),
  },
];

/** The sentence tails these messages end with — a new one must be named here. */
const MESSAGE_TAILS = [
  'to make changes',
  'to use this tool',
  'to create, update, or delete sources and agents',
  'to make this change',
  'to create, cancel, or change scheduled tasks',
  'to send messages to other sessions',
  'to run batch work in parallel worktrees',
] as const;

/**
 * Split one message into its escape hint, which is what must not vary within a
 * mode. The subject and the tail DO vary by branch, so both are stripped.
 */
function escapeHintOf(reason: string, modeLabel: string): string {
  const marker = ` blocked in ${modeLabel}. `;
  const at = reason.indexOf(marker);
  if (at < 0) throw new Error(`message does not name ${modeLabel}: ${reason}`);
  const rest = reason.slice(at + marker.length);
  const tail = MESSAGE_TAILS.find(candidate => rest.endsWith(`${candidate}.`));
  if (!tail) throw new Error(`unrecognized message tail — add it to MESSAGE_TAILS: ${reason}`);
  return rest.slice(0, rest.length - (tail.length + 1)).trimEnd();
}

/** One case's refusal message, with the case's own reachability context. */
function reasonForCase(mode: 'dontAsk' | 'plan', block: (typeof BLOCK_CASES)[number]): string {
  return blockReason(mode, block.tool, {
    toolInput: block.input,
    ...(block.permissionsContext ? { permissionsContext: block.permissionsContext } : {}),
  });
}

describe('one escape hint per session, not two', () => {
  /** Branch label → its escape hint, so a divergence names the branch that broke ranks. */
  function hintsFor(mode: 'dontAsk' | 'plan'): Record<string, string> {
    return Object.fromEntries(BLOCK_CASES.map(block =>
      [block.label, escapeHintOf(reasonForCase(mode, block), LABEL[mode])]));
  }

  /** The same hint under every branch label — the singleton, stated as a shape. */
  function everyBranch(hint: string): Record<string, string> {
    return Object.fromEntries(BLOCK_CASES.map(({ label }) => [label, hint]));
  }

  it('dontAsk offers the allow rule everywhere, and the SHIFT+TAB cycle it has no place in nowhere', () => {
    expect(hintsFor('dontAsk')).toEqual(everyBranch(ESCAPE.dontAsk));
    for (const block of BLOCK_CASES) {
      expect(reasonForCase('dontAsk', block), block.label).not.toContain('SHIFT+TAB');
    }
  });

  it('plan points at SubmitPlan everywhere — the one exit the model itself can take', () => {
    expect(hintsFor('plan')).toEqual(everyBranch(ESCAPE.plan));
  });

  it('plan is byte-equal on all eight (F1.1050: this arm measured the retired explore)', () => {
    const hint = ESCAPE.plan;
    expect(BLOCK_CASES.map(block => reasonForCase('plan', block))).toEqual([
      `File modifications are blocked in Plan. ${hint} to make changes.`,
      `NotebookEdit is blocked in Plan. ${hint} to use this tool.`,
      // UA12.12 — spawn_session names no object of its own in mode-manager.ts's
      // tail map, so it reads the true generic rather than the source family's ending.
      `Session configuration changes are blocked in Plan. ${hint} to make this change.`,
      `API POST /v1/things is blocked in Plan. ${hint} to make changes.`,
      `MCP write operations are blocked in Plan. ${hint} to make changes.`,
      `API POST /v1/things is blocked in Plan. ${hint} to make changes.`,
      // The two blocked-tool arms. They word the same refusal differently from
      // their siblings on purpose — that wording is the proof of WHICH branch
      // answered, and the last describe leans on it.
      `API mutations are blocked in Plan. ${hint} to make changes.`,
      `${MCP_TOOL} is blocked in Plan. ${hint} to use this tool.`,
    ]);
  });

  it('the set covers every REACHABLE branch, and says which one it does not', () => {
    // P2.47 — the invariant above is set-shaped so a divergence fails naming
    // its branch; a set that covers 6 of 8 reachable branches cannot do that
    // for the other two. Eight here, plus `Bash`, which the header's map
    // records as still unreachable and the last describe pins as such.
    expect(BLOCK_CASES).toHaveLength(8);
    expect(BLOCK_CASES.filter(block => block.permissionsContext !== undefined)).toHaveLength(2);
    expect(BLOCK_CASES.map(({ tool }) => tool)).not.toContain('Bash');
  });
});

/**
 * P2.39 — the two branches a declared `blockedTools` brings back to life.
 *
 * Both names below are ALLOWED by the very config that blocks them: the API
 * call is a GET (`isApiCallAllowedWithConfig` allows every GET) and the MCP tool
 * matches an `allowedMcpPatterns` entry. Each test states that control first, so
 * the block it then asserts can only have come from `blockedTools` — and the
 * message proves WHICH branch answered, because the blocked-tool branch and the
 * sibling below it word the same refusal differently.
 */
describe('a declared blockedTools entry reaches the branch its name selects', () => {
  // `API_INPUT`, `MCP_TOOL`, `declaring`, `ESCAPE` and `LABEL` are at module
  // scope since P2.47: `BLOCK_CASES` needs the first three to reach these two
  // branches, and the last two were a third hand-written copy of a string whose
  // whole invariant is that there is exactly one of it.
  const MODES: Array<'dontAsk' | 'plan'> = ['dontAsk', 'plan'];

  it('the api_ branch: a GET the config allows is refused once its name is declared', () => {
    for (const mode of MODES) {
      const allowedWithoutIt = shouldAllowToolInMode('api_reports', API_INPUT, mode, {
        permissionsContext: declaring(),
      });
      expect(allowedWithoutIt.allowed).toBe(true);

      const reason = blockReason(mode, 'api_reports', {
        permissionsContext: declaring('api_reports'),
        toolInput: API_INPUT,
      });
      expect(reason).toBe(`API mutations are blocked in ${LABEL[mode]}. ${ESCAPE[mode]} to make changes.`);
      // The sibling API branch names the method and path; this one does not, so
      // the wording is also the proof that the blocked-tool branch answered.
      expect(reason).not.toContain('/v1/reports');
    }
  });

  /**
   * P2.214 — the message named the wrong operation, and this is the case that
   * proves it: `mcp__linear__read_issue` is a READ tool, allowed by the very
   * `allowedMcpPatterns` entry in the config that blocks it, and it was refused
   * with "MCP write operations are blocked in X". The blocked-tool branch matches
   * on the NAME and establishes nothing about the operation, so it now names the
   * tool. The sibling below still earns the write wording, which keeps the
   * message a proof of WHICH branch answered.
   */
  it('the mcp__ branch: a read-only MCP tool is refused BY NAME, and the message says so', () => {
    for (const mode of MODES) {
      const allowedWithoutIt = shouldAllowToolInMode(MCP_TOOL, {}, mode, { permissionsContext: declaring() });
      expect(allowedWithoutIt.allowed).toBe(true);

      const reason = blockReason(mode, MCP_TOOL, { permissionsContext: declaring(MCP_TOOL), toolInput: {} });
      expect(reason).toBe(`${MCP_TOOL} is blocked in ${LABEL[mode]}. ${ESCAPE[mode]} to use this tool.`);
      expect(reason).not.toContain('write operations');

      // The control: an MCP tool this config does NOT hold read-only reaches the
      // sibling branch, where `isReadOnlyMcpToolWithConfig` has already answered
      // false, and keeps the write wording. Without this the assertion above
      // could pass by the wording being deleted everywhere.
      expect(blockReason(mode, 'mcp__linear__write_issue', {
        permissionsContext: declaring(), toolInput: {},
      })).toBe(`MCP write operations are blocked in ${LABEL[mode]}. ${ESCAPE[mode]} to make changes.`);
    }
  });

  it('Bash stays with its own rejection family — its blocked-tool branch is still dead', () => {
    const permissionsContext = declaring('Bash');
    // `ls` is not in this layer's read-only set, so the refusal is the bash
    // rejection message, not `getBlockReasonWithConfig`'s Bash branch.
    const reason = blockReason('plan', 'Bash', { permissionsContext, toolInput: { command: 'ls' } });
    expect(reason).not.toBe(`Bash commands are blocked in Plan. ${ESCAPE.plan} to run commands.`);
  });
});

/**
 * UA12.12 (origin UA-c / UA1.8 (2), 2026-10-02) — the session-config refusal's
 * tail names the object the refused tool actually acts on, drawn from the tool's
 * own shipped description in `tool-defs.ts`, instead of the one fixed "sources
 * and agents" ending every blocked `mcp__session__*` tool used to read. The
 * sentence reaches the model on claude and Pi (on codex it is the debug log).
 *
 * One arm per object the map in `mode-manager.ts` names beyond the source
 * family; the control is the row's — `source_manage` keeps the original
 * wording. A blocked tool the map does not name takes the true generic, which
 * is what the byte-equal arm above pins for `spawn_session`. The tools carry no
 * `toolInput` this branch reads — the refusal fires on the name.
 */
describe('UA12.12 — the session-config refusal names the object the tool acts on', () => {
  const NAMED_OBJECT_CASES = [
    { label: 'cron', tool: 'mcp__session__CronCreate', tail: 'to create, cancel, or change scheduled tasks' },
    { label: 'agent message', tool: 'mcp__session__send_agent_message', tail: 'to send messages to other sessions' },
    { label: 'worktree batch', tool: 'mcp__session__WorktreeBatch', tail: 'to run batch work in parallel worktrees' },
  ] as const;

  for (const { label, tool, tail } of NAMED_OBJECT_CASES) {
    it(`${label}: ${tool} is refused with its own object, not sources and agents`, () => {
      const reason = blockReason('plan', tool, { toolInput: {} });
      expect(reason).toBe(`Session configuration changes are blocked in Plan. ${ESCAPE.plan} ${tail}.`);
      expect(reason).not.toContain('sources and agents');
    });
  }

  it('CONTROL: source_manage keeps naming sources and agents', () => {
    expect(blockReason('plan', 'mcp__session__source_manage', { toolInput: {} })).toBe(
      `Session configuration changes are blocked in Plan. ${ESCAPE.plan} to create, update, or delete sources and agents.`
    );
  });

  it('a blocked tool with no named object gets the true generic, in dontAsk too', () => {
    for (const mode of ['dontAsk', 'plan'] as const) {
      expect(blockReason(mode, 'mcp__session__remember', { toolInput: {} })).toBe(
        `Session configuration changes are blocked in ${LABEL[mode]}. ${ESCAPE[mode]} to make this change.`
      );
    }
  });
});

/**
 * F1.1228 — Plan mode's browser-command block built its own reason with no
 * escape hint, although {@link formatModeBlockEscapeHint}'s docblock says every
 * Plan or Don't ask refusal routes through it. It now ends with Plan's one
 * escape, like its eight siblings above.
 */
describe('F1.1228 · the plan-mode browser block carries the mode\'s escape hint', () => {
  const CLICK = { command: 'click @e1' };

  it('a state-changing browser command refused in Plan points at SubmitPlan', () => {
    const reason = blockReason('plan', 'browser_tool', { toolInput: CLICK });
    expect(reason).toStartWith('Browser command blocked (Plan mode): "click @e1" changes page or browser state.');
    expect(reason).toEndWith(` ${ESCAPE.plan} to run it.`);
  });

  it('BOUNDARY — Don\'t ask keeps its own permission sentence, and neither mode offers the other\'s escape', () => {
    const reason = blockReason('dontAsk', 'browser_tool', { toolInput: CLICK });
    expect(reason).toContain('An explicit allow rule can pre-approve it.');
    expect(reason).not.toContain('SubmitPlan');
    expect(blockReason('plan', 'browser_tool', { toolInput: CLICK })).not.toContain('explicit allow rule');
  });
});
