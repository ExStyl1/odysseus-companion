/**
 * P3.1 — a codex "Always Allow" on a command persists as a DURABLE execpolicy
 * rule in the workspace `permissions.json`, and the `CODEX_HOME/rules/` layer is
 * a pure projection of that store, re-derived on every home build.
 *
 * Two stores, one direction:
 *   - MERGE writes the durable store (`mergeExecpolicyAllowGrant` +
 *     `saveWorkspacePermissions`);
 *   - COLLECT reads it back for the projection
 *     (`collectExecpolicyAllowPrefixes` → `buildCodexExecpolicyRules`);
 *   - a home REBUILD re-derives the projection from the store, so the grant
 *     survives (the CODEX_HOME the previous build wrote is gone).
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execpolicyAmendmentForApproval } from '@nessy-agent/codex-agent-server';
import {
  writeCodexConfig,
  CODEX_RULES_DIR,
  CODEX_RULES_FILE,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  collectExecpolicyAllowPrefixes,
  collectExecpolicyDenyPrefixes,
  collectExecpolicyPromptPrefixes,
  loadRawWorkspacePermissions,
  mergeExecpolicyAllowGrant,
  permissionsConfigCache,
  saveWorkspacePermissions,
  getWorkspacePermissionsPath,
} from '../permissions-config.ts';

const EXEC_METHOD = 'item/commandExecution/requestApproval';

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'p31-ws-'));
}
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'p31-home-'));
}

beforeEach(() => {
  permissionsConfigCache.clear();
});

// ============================================================
// The pure helpers (the load-bearing merge/collect/extract logic)
// ============================================================

describe('mergeExecpolicyAllowGrant + collectExecpolicyAllowPrefixes round-trip', () => {
  it('adds a structural bash allow rule that collects back as the same prefix', () => {
    const merged = mergeExecpolicyAllowGrant(null, ['git', 'status']);
    const dsl = merged.permissionDsl as { version: number; rules: Array<Record<string, unknown>> };
    expect(dsl.version).toBe(1);
    expect(dsl.rules).toHaveLength(1);
    expect(dsl.rules[0]).toMatchObject({
      action: 'allow',
      match: { kind: 'bash', executable: 'git', args: ['status'] },
    });
    expect(collectExecpolicyAllowPrefixes(merged)).toEqual([['git', 'status']]);
  });

  it('is idempotent — re-granting the same prefix does not duplicate the rule', () => {
    const once = mergeExecpolicyAllowGrant(null, ['git', 'status']);
    const twice = mergeExecpolicyAllowGrant(once, ['git', 'status']);
    expect((twice.permissionDsl as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it('preserves unrelated fields and unrelated DSL rules (merge-preserve)', () => {
    const existing = {
      allowedBashPatterns: [{ pattern: '^ls' }],
      permissionDsl: {
        version: 1,
        rules: [{ id: 'keep-me', action: 'deny', match: { kind: 'bash', executable: 'rm' } }],
      },
    };
    const merged = mergeExecpolicyAllowGrant(existing as never, ['git', 'status']);
    expect(merged.allowedBashPatterns).toEqual([{ pattern: '^ls' }]);
    const rules = (merged.permissionDsl as { rules: Array<Record<string, unknown>> }).rules;
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ id: 'keep-me', action: 'deny' });
    // The ALLOW collector projects only allows. A deny IS expressible as a
    // `prefix_rule` — `decision` is `allow|prompt|forbidden` — and is projected
    // by `collectExecpolicyDenyPrefixes` instead (P2.141); this file used to say
    // "a prefix_rule only expresses allow", which is false.
    expect(collectExecpolicyAllowPrefixes(merged)).toEqual([['git', 'status']]);
  });

  it('never projects the Claude pattern form or non-string args', () => {
    const file = {
      permissionDsl: {
        version: 1,
        rules: [
          { id: 'a', action: 'allow', match: { kind: 'bash', pattern: 'git status:*' } },
          { id: 'b', action: 'allow', match: { kind: 'bash', executable: 'x', args: [42] } },
          { id: 'c', action: 'allow', match: { kind: 'tool', semanticId: 'edit' } },
          { id: 'd', action: 'allow', match: { kind: 'bash', executable: 'echo', args: ['hi'] } },
        ],
      },
    };
    expect(collectExecpolicyAllowPrefixes(file as never)).toEqual([['echo', 'hi']]);
  });

  it('degrades to an empty list on a missing or malformed store', () => {
    expect(collectExecpolicyAllowPrefixes(null)).toEqual([]);
    expect(collectExecpolicyAllowPrefixes({})).toEqual([]);
    expect(collectExecpolicyAllowPrefixes({ permissionDsl: { rules: 'nope' } } as never)).toEqual([]);
  });
});

describe('execpolicyAmendmentForApproval — where the prefix comes from', () => {
  it('reads the app-server\'s proposedExecpolicyAmendment for a v2 command', () => {
    expect(execpolicyAmendmentForApproval('command', {
      command: 'git status', proposedExecpolicyAmendment: ['git', 'status'],
    })).toEqual(['git', 'status']);
  });
  it('reads argv for a v1 command', () => {
    expect(execpolicyAmendmentForApproval('commandV1', { command: ['git', 'status'] })).toEqual(['git', 'status']);
  });
  it('returns null when there is nothing faithful to persist', () => {
    // v2 command with no proposed amendment: keep the session-only grant.
    expect(execpolicyAmendmentForApproval('command', { command: 'git status' })).toBeNull();
    // non-command families carry no command prefix.
    expect(execpolicyAmendmentForApproval('fileChange', { grantRoot: '/w' })).toBeNull();
    expect(execpolicyAmendmentForApproval('command', { proposedExecpolicyAmendment: [] })).toBeNull();
  });
});

// ============================================================
// Persistence through the agent (durable store receives the grant)
// ============================================================

function commandAgent(workspaceRootPath: string) {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws', name: 'WS', rootPath: workspaceRootPath, workspaceRootPath,
      sessionRootPath: join(workspaceRootPath, 'sessions'),
    } as never,
    session: {
      id: 'sess', workspaceRootPath, createdAt: Date.now(), lastUsedAt: Date.now(),
      workingDirectory: workspaceRootPath,
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  // Empty capability layer set: the card surfaces (no rule pre-approves), the
  // same negative-control posture the R6 suite uses.
  agent.getPermissionManager().setCapabilityPermissionLayers([], 'gen-p31', true);
  // F1.780 — while a deny entry reaches codex's profile, codex keeps every command
  // sandboxed, so Always Allow mints NO durable rule
  // (`codex-sandbox-retained-approval.test.ts` pins that arm). Since F1.1057 a
  // default session denies nothing (the shipped floor stays host-side, so this file
  // also fails if it came back); the stub only undoes this suite's `$TMPDIR` config
  // dir, which F1.664 denies. Each refusal below is the only thing that can stop the write.
  (agent as never as { codexDeniedReadPaths: () => string[] }).codexDeniedReadPaths = () => [];
  return { agent, surfaced };
}

describe('an Always Allow on a command is persisted to the workspace store', () => {
  it('writes a durable bash allow rule that saveWorkspacePermissions receives', async () => {
    const ws = freshWorkspace();
    try {
      const { agent, surfaced } = commandAgent(ws);
      void (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
        .handleServerRequest(EXEC_METHOD, { command: 'git status', proposedExecpolicyAmendment: ['git', 'status'] });
      expect(surfaced).toHaveLength(1);

      agent.respondToPermission(surfaced[0]!.requestId, true, true);

      // The file saveWorkspacePermissions wrote IS the config it received.
      const path = getWorkspacePermissionsPath(ws);
      expect(existsSync(path)).toBe(true);
      const saved = loadRawWorkspacePermissions(ws)!;
      expect(collectExecpolicyAllowPrefixes(saved)).toEqual([['git', 'status']]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('does NOT persist a plain accept, or an always-allow without an amendment', async () => {
    const ws = freshWorkspace();
    try {
      const { agent, surfaced } = commandAgent(ws);
      // Plain accept (alwaysAllow=false): session-only, nothing durable.
      void (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
        .handleServerRequest(EXEC_METHOD, { command: 'git status', proposedExecpolicyAmendment: ['git', 'status'] });
      agent.respondToPermission(surfaced[0]!.requestId, true, false);
      expect(existsSync(getWorkspacePermissionsPath(ws))).toBe(false);

      // Always-allow but the app-server proposed no amendment: still session-only.
      void (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
        .handleServerRequest(EXEC_METHOD, { command: 'npm publish' });
      agent.respondToPermission(surfaced[1]!.requestId, true, true);
      expect(collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(ws))).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ============================================================
// A home REBUILD re-derives the projection from the durable store
// ============================================================

describe('the persisted grant survives a home rebuild', () => {
  it('re-projects the durable store into a fresh CODEX_HOME on every build', () => {
    const ws = freshWorkspace();
    const first = freshHome();
    const second = freshHome();
    try {
      // Persist a grant to the durable store.
      saveWorkspacePermissions(ws, mergeExecpolicyAllowGrant(loadRawWorkspacePermissions(ws), ['git', 'status']));

      // BUILD 1 — projection from the store.
      const build = (home: string) => writeCodexConfig({
        codexHome: home,
        model: 'tgpt/qwen35-397b-a17b-fp8',
        adapterPort: 4321,
        execpolicyAllowPrefixes: collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(ws)),
      });
      build(first);
      const rules1 = readFileSync(join(first, CODEX_RULES_DIR, CODEX_RULES_FILE), 'utf8');
      expect(rules1).toContain('prefix_rule(pattern=["git", "status"], decision="allow")');

      // REBUILD into a DIFFERENT fresh home (mode change = teardown + respawn):
      // the first home is irrelevant now; the grant lives in the store.
      build(second);
      const rules2 = readFileSync(join(second, CODEX_RULES_DIR, CODEX_RULES_FILE), 'utf8');
      expect(rules2).toBe(rules1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

/**
 * P2.141b — the DENY half of the same projection.
 *
 * The shape read here is MEASURED, not assumed: `parseClaudeRuleString('Bash(rm:*)',
 * 'deny', …)` produces `{action:'deny', match:{kind:'bash', pattern:'rm:*'}}`
 * (2026-08-25), i.e. the PATTERN form of the bash matcher — exactly the field
 * `collectExecpolicyAllowPrefixes` skips. `claude-setup-import.ts` writes those
 * rules into the durable workspace store, so this collector is not speculative.
 */
describe('collectExecpolicyDenyPrefixes — the deny half of the projection', () => {
  const denyFile = (matches: unknown[]) => ({
    permissionDsl: {
      version: 1,
      rules: matches.map((match, index) => ({ id: `d${index}`, action: 'deny', match })),
    },
  });

  /** KILLS: reading `match.executable` only, which is the shape denies never have. */
  it('reads the pattern form a user deny rule actually parses to', () => {
    expect(collectExecpolicyDenyPrefixes(denyFile([
      { kind: 'bash', pattern: 'rm:*' },
      { kind: 'bash', pattern: 'sudo rm:*' },
      { kind: 'bash', pattern: 'rm -rf /tmp/x' },
    ]))).toEqual([['rm'], ['sudo', 'rm'], ['rm', '-rf', '/tmp/x']]);
  });

  /** KILLS: dropping the structural form, which `mergeExecpolicyAllowGrant`'s shape uses. */
  it('reads the structural form too', () => {
    expect(collectExecpolicyDenyPrefixes(denyFile([
      { kind: 'bash', executable: 'rm', args: ['-rf'] },
    ]))).toEqual([['rm', '-rf']]);
  });

  /**
   * KILLS: projecting a pattern's literal head. `rm -rf *` denies nothing that
   * `rm -rf build` matches, but `prefix_rule(["rm","-rf"])` forbids it — an
   * over-tightening is still a wrong answer, so the honest projection is none.
   */
  it('refuses a pattern with an interior wildcard rather than over-tightening', () => {
    expect(collectExecpolicyDenyPrefixes(denyFile([
      { kind: 'bash', pattern: 'rm -rf *' },
      { kind: 'bash', pattern: 'git * push' },
      { kind: 'bash', pattern: 'rm -?f x' },
    ]))).toEqual([]);
  });

  /**
   * THE NEGATIVE CONTROL. Nothing but a bash deny projects — an allow rule, an
   * ask rule and a path matcher all yield nothing. Without this, the tests above
   * are equally satisfied by a collector that returns every rule it sees.
   */
  it('projects nothing from an allow, an ask, or a path rule', () => {
    expect(collectExecpolicyDenyPrefixes({
      permissionDsl: {
        version: 1,
        rules: [
          { id: 'a', action: 'allow', match: { kind: 'bash', pattern: 'rm:*' } },
          { id: 'b', action: 'ask', match: { kind: 'bash', pattern: 'rm:*' } },
          { id: 'c', action: 'deny', match: { kind: 'pathGlob', pattern: 's/**' } },
        ],
      },
    })).toEqual([]);
  });

  /** KILLS: throwing on protocol drift instead of degrading to nothing. */
  it('degrades to an empty list on malformed input', () => {
    expect(collectExecpolicyDenyPrefixes(null)).toEqual([]);
    expect(collectExecpolicyDenyPrefixes({})).toEqual([]);
    expect(collectExecpolicyDenyPrefixes({ permissionDsl: { rules: 'nope' } })).toEqual([]);
    expect(collectExecpolicyDenyPrefixes(denyFile([{ kind: 'bash' }]))).toEqual([]);
  });

  /**
   * KILLS: an allow collector that starts picking up denies (or vice versa)
   * after this change — the two halves must stay disjoint on one document.
   */
  it('stays disjoint from the allow collector on one document', () => {
    const file = {
      permissionDsl: {
        version: 1,
        rules: [
          { id: 'a', action: 'allow', match: { kind: 'bash', executable: 'git', args: ['status'] } },
          { id: 'd', action: 'deny', match: { kind: 'bash', pattern: 'rm:*' } },
        ],
      },
    };
    expect(collectExecpolicyAllowPrefixes(file)).toEqual([['git', 'status']]);
    expect(collectExecpolicyDenyPrefixes(file)).toEqual([['rm']]);
  });
});

/**
 * P2.140 — the durable store is the one place a floor bypass would OUTLIVE the
 * session, so the persist path refuses independently of the answer path.
 */
describe('a floor command is never persisted as a durable allow (P2.140)', () => {
  /** Built by `join` so no line of this file is itself a runnable removal. */
  const HOME_RM_TOKENS = ['rm', '-rf', '~'];

  /**
   * KILLS: removing the guard inside `persistExecpolicyGrant`. Reached by calling
   * it directly, so it fails even if `respondToPermission`'s own drop is intact —
   * a single mutation must not be able to hide behind the other layer.
   */
  it('refuses a grant whose tokens a floor refuses', () => {
    const ws = freshWorkspace();
    try {
      const { agent } = commandAgent(ws);
      const debug: string[] = [];
      agent.onDebug = (message) => { debug.push(message); };

      (agent as never as { persistExecpolicyGrant(k: string, p: unknown): void })
        .persistExecpolicyGrant('command', {
          command: HOME_RM_TOKENS.join(' '),
          proposedExecpolicyAmendment: HOME_RM_TOKENS,
        });

      expect(debug.some(line => line.includes('not persisted: the removalCircuitBreaker floor refuses'))).toBe(true);
      expect(existsSync(getWorkspacePermissionsPath(ws))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  /** NEGATIVE CONTROL: an ordinary grant still persists through the same call. */
  it('still persists an ordinary grant', () => {
    const ws = freshWorkspace();
    try {
      const { agent } = commandAgent(ws);

      (agent as never as { persistExecpolicyGrant(k: string, p: unknown): void })
        .persistExecpolicyGrant('command', {
          command: 'git status',
          proposedExecpolicyAmendment: ['git', 'status'],
        });

      expect(collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(ws))).toEqual([['git', 'status']]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  /**
   * KILLS: dropping `alwaysAllow` at the answer site without the persist guard,
   * or the reverse. This is the whole round trip through the real card: a floor
   * card answered with Always Allow leaves the durable store untouched, while the
   * same answer on a benign command writes it.
   */
  it('leaves the durable store untouched when a floor card is Always-Allowed', () => {
    const ws = freshWorkspace();
    try {
      const { agent, surfaced } = commandAgent(ws);
      void (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
        .handleServerRequest(EXEC_METHOD, {
          command: HOME_RM_TOKENS.join(' '),
          proposedExecpolicyAmendment: HOME_RM_TOKENS,
        });
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]!.noAlwaysAllow).toBe(true);

      agent.respondToPermission(surfaced[0]!.requestId, true, true);

      expect(existsSync(getWorkspacePermissionsPath(ws))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/**
 * P6.1 — the MIDDLE tier of the DSL, which had no collector at all.
 *
 * `allow` and `deny` were projected into `CODEX_HOME/rules/`; `ask` was not, so
 * for every command codex auto-approves the user's ask rule decided nothing.
 * The shapes read here are the same two the deny collector reads, and for the
 * same measured reason: a Claude `ask: ['Bash(git push:*)']` entry parses to the
 * PATTERN form of the bash matcher, while `mergeExecpolicyAllowGrant`'s own
 * writes use the structural form.
 */
describe('collectExecpolicyPromptPrefixes — the ask half of the projection (P6.1)', () => {
  const askFile = (matches: unknown[]) => ({
    permissionDsl: {
      version: 1,
      rules: matches.map((match, index) => ({ id: `k${index}`, action: 'ask', match })),
    },
  });

  /** KILLS: reading `match.executable` only, which is the shape a Claude ask entry never has. */
  it('reads the pattern form a user ask rule actually parses to', () => {
    expect(collectExecpolicyPromptPrefixes(askFile([
      { kind: 'bash', pattern: 'git push:*' },
      { kind: 'bash', pattern: 'curl' },
    ]))).toEqual([['git', 'push'], ['curl']]);
  });

  /** KILLS: dropping the structural form. */
  it('reads the structural form too', () => {
    expect(collectExecpolicyPromptPrefixes(askFile([
      { kind: 'bash', executable: 'git', args: ['push'] },
    ]))).toEqual([['git', 'push']]);
  });

  /**
   * KILLS: projecting a pattern's literal head. The deny half refuses this to
   * avoid over-DENYING; the ask half refuses it to avoid over-ASKING, which is
   * its own wrong answer — `git push * --force` never covered `git push origin`.
   */
  it('refuses a pattern with an interior wildcard rather than over-asking', () => {
    expect(collectExecpolicyPromptPrefixes(askFile([
      { kind: 'bash', pattern: 'git push * --force' },
      { kind: 'bash', pattern: 'rm -?f x' },
    ]))).toEqual([]);
  });

  /**
   * THE NEGATIVE CONTROL, and it is the one that matters most here: an ALLOW and
   * a DENY rule must not leak into the ask list. Without it, a collector that
   * returned every bash rule it saw would pass every test above — and would
   * force a prompt on every command the user pre-approved, since a projected
   * `prompt` outranks a projected `allow` in codex's own merge.
   */
  it('projects nothing from an allow, a deny, or a path rule', () => {
    expect(collectExecpolicyPromptPrefixes({
      permissionDsl: {
        version: 1,
        rules: [
          { id: 'a', action: 'allow', match: { kind: 'bash', pattern: 'git push:*' } },
          { id: 'b', action: 'deny', match: { kind: 'bash', pattern: 'git push:*' } },
          { id: 'c', action: 'ask', match: { kind: 'pathGlob', pattern: 's/**' } },
        ],
      },
    })).toEqual([]);
  });

  /** Malformed input degrades to an empty list rather than throwing, as its siblings do. */
  it('degrades to an empty list on a malformed document', () => {
    expect(collectExecpolicyPromptPrefixes(null)).toEqual([]);
    expect(collectExecpolicyPromptPrefixes({})).toEqual([]);
    expect(collectExecpolicyPromptPrefixes({ permissionDsl: { rules: 'nope' } } as never)).toEqual([]);
  });
});

/**
 * P2.400's sibling finding — a cwd-SCOPED rule projects NOTHING, on all three
 * tiers.
 *
 * The structural bash matcher's `cwdRoot` narrows a rule to requests whose cwd
 * is inside that root (`pi-harness/permission-dsl.ts`, `matchesRule`), and
 * execpolicy has no directory field to project it onto — the bundled binary's
 * parser builtins are `pattern`/`match`/`not_match`/`justification`/
 * `prefix_rule`/`network_rule`/`paths`/`host_executable`. So a projected
 * `cwdRoot` rule is the user's rule with its condition deleted: an unconditional
 * grant that also unsandboxes its prefix (P3.80), a deny that forbids outside
 * the root, an ask that asks outside it.
 *
 * Nothing is lost by skipping: `consultPermissionRules` evaluates the same rule
 * WITH its cwd on codex's approval path.
 */
describe('a cwd-scoped bash rule is never projected (P2.400)', () => {
  /**
   * A MATCHER root, never an executed string — no rule below is ever run, and
   * the path names no real home or root.
   */
  const SCOPED_ROOT = '/workspace/project';
  const oneRule = (action: string, match: unknown) => ({
    permissionDsl: { version: 1, rules: [{ id: 'r0', action, match }] },
  });

  /** KILLS: dropping the skip in the ALLOW collector — the widening direction. */
  it('skips a cwd-scoped grant, which would otherwise allow (and unsandbox) everywhere', () => {
    expect(collectExecpolicyAllowPrefixes(
      oneRule('allow', { kind: 'bash', executable: 'git', args: ['status'], cwdRoot: SCOPED_ROOT }),
    )).toEqual([]);
  });

  /** KILLS: dropping the skip in the DENY collector — over-tightening. */
  it('skips a cwd-scoped deny rather than forbidding outside its root', () => {
    expect(collectExecpolicyDenyPrefixes(
      oneRule('deny', { kind: 'bash', executable: 'rm', args: ['-rf'], cwdRoot: SCOPED_ROOT }),
    )).toEqual([]);
  });

  /** KILLS: dropping the skip in the PROMPT collector — over-asking. */
  it('skips a cwd-scoped ask rather than asking outside its root', () => {
    expect(collectExecpolicyPromptPrefixes(
      oneRule('ask', { kind: 'bash', executable: 'git', args: ['push'], cwdRoot: SCOPED_ROOT }),
    )).toEqual([]);
  });

  /**
   * KILLS: putting the check AFTER the pattern branch. `compileMatcher` rejects
   * a matcher carrying both, so the host enforces no such rule and projecting
   * one would invent it.
   */
  it('skips a matcher carrying both a pattern and a cwdRoot, which the compiler rejects', () => {
    const match = { kind: 'bash', pattern: 'rm:*', cwdRoot: SCOPED_ROOT };
    expect(collectExecpolicyDenyPrefixes(oneRule('deny', match))).toEqual([]);
    expect(collectExecpolicyPromptPrefixes(oneRule('ask', match))).toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL. The same three rules WITHOUT `cwdRoot` still project,
   * so the four assertions above are not satisfied by a collector that has
   * simply stopped collecting.
   */
  it('POSITIVE CONTROL: the same rules without cwdRoot still project', () => {
    expect(collectExecpolicyAllowPrefixes(
      oneRule('allow', { kind: 'bash', executable: 'git', args: ['status'] }),
    )).toEqual([['git', 'status']]);
    expect(collectExecpolicyDenyPrefixes(
      oneRule('deny', { kind: 'bash', executable: 'rm', args: ['-rf'] }),
    )).toEqual([['rm', '-rf']]);
    expect(collectExecpolicyPromptPrefixes(
      oneRule('ask', { kind: 'bash', executable: 'git', args: ['push'] }),
    )).toEqual([['git', 'push']]);
    expect(collectExecpolicyDenyPrefixes(oneRule('deny', { kind: 'bash', pattern: 'rm:*' })))
      .toEqual([['rm']]);
  });
});

/**
 * P6.1 — the WIRING, which no test held for any of the three tiers.
 *
 * The collectors are covered and the projector is covered, and a lane could
 * still delete the line that hands one of them to `writeCodexConfig`: the store
 * would keep the rule, the writer would keep the ability to project it, and the
 * session would ship a rules file missing a whole tier with nothing red. That is
 * the "control that silently stops controlling" shape, and for the deny tier it
 * would drop every projected floor.
 *
 * Asserted against the SOURCE because the alternative is booting a real codex
 * home per tier; the repo already uses this shape where a seam is cheap to
 * delete and expensive to miss (`SessionManager.process-supervisor.test.ts`).
 */
describe('the execpolicy projection is actually handed to the config writer (P6.1)', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'codex-agent.ts'), 'utf8');

  it('passes all three tiers into writeCodexConfig', () => {
    // `includes(...)` rather than `toContain`, deliberately: on failure
    // `toContain` prints the whole 250 KB file as the "received" value, which
    // buries the one line that went missing. The tier name is in the assertion
    // label instead.
    for (const tier of ['Allow', 'Deny', 'Prompt'] as const) {
      const wiring = `execpolicy${tier}Prefixes: this.collectExecpolicy${tier}Prefixes(),`;
      expect(`${tier}: ${source.includes(wiring)}`).toBe(`${tier}: true`);
    }
  });

  /**
   * NEGATIVE CONTROL for the assertion above: the file really is the one being
   * read, and a tier name absent from it fails. Without this, a mistyped path
   * would make all three `toContain` calls vacuous in the same direction.
   */
  it('does not claim a tier that does not exist', () => {
    expect(source.length).toBeGreaterThan(10_000);
    expect(source.includes('execpolicyWarnPrefixes: this.')).toBe(false);
  });
});
