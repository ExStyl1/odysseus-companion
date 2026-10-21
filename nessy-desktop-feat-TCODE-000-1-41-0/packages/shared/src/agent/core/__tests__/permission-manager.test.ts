/**
 * Tests for PermissionManager
 *
 * Tests the centralized permission evaluation system used by both
 * ClaudeAgent and PiAgent.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PermissionManager } from '../permission-manager.ts';
import { headsDangerousCommandPair } from '../dangerous-commands.ts';
import { initializeModeState, cleanupModeState } from '../../mode-manager.ts';
import { DEFAULT_CYCLABLE_PERMISSION_MODES } from '../../mode-types.ts';
import { permissionsConfigCache } from '../../permissions-config.ts';
import type { SessionKey } from '../../../sessions/session-key.ts';

// Test session ID
const TEST_SESSION_ID = 'test-session-12345';
// Composite key the PermissionManager under test resolves to (same workspaceId).
const TEST_KEY: SessionKey = { workspaceId: 'test-workspace', sessionId: TEST_SESSION_ID };

describe('PermissionManager', () => {
  let permissionManager: PermissionManager;

  beforeEach(() => {
    // Clean up any previous mode state
    cleanupModeState(TEST_KEY);

    // Initialize mode state for test session
    initializeModeState(TEST_KEY, 'default');

    // Create a fresh PermissionManager
    permissionManager = new PermissionManager({
      workspaceId: 'test-workspace',
      sessionId: TEST_SESSION_ID,
      workingDirectory: '/test/workspace',
      plansFolderPath: '/test/workspace/plans',
    });
  });

  describe('Permission Mode Management', () => {
    it('should return the current permission mode', () => {
      const mode = permissionManager.getPermissionMode();
      expect(mode).toBe('default');
    });

    it('should set the permission mode', () => {
      permissionManager.setPermissionMode('plan');
      expect(permissionManager.getPermissionMode()).toBe('plan');

      permissionManager.setPermissionMode('bypassPermissions');
      expect(permissionManager.getPermissionMode()).toBe('bypassPermissions');
    });

    /**
     * D1.414 — this pin asserted the cycle D1.369 REPLACED, and it had been red
     * at HEAD ever since.
     *
     * It read `expect(nextMode3).toBe('explore')` under the comment
     * "bypassPermissions is NOT in the default cycle (explicit enable only), so
     * the rotation wraps from auto back to explore", and received
     * `"bypassPermissions"`. Run alone under the lock at `4333cd155`:
     * `29 pass / 1 fail`, `Ran 30 tests across 1 file` — reproducible, the
     * file's other 29 cases the control, and not in
     * `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
     *
     * READ BEFORE CHANGED, because the row allowed for the cycler being the
     * wrong half: it is not. `DEFAULT_CYCLABLE_PERMISSION_MODES`
     * (`agent/mode-types.ts`) says in its own docblock that *"`bypassPermissions`
     * IS here, since D1.369 (owner, 2026-09-18: it must be offered rather than
     * hidden) … the desktop's enable is the first-activation responsibility
     * dialog, which every entry point still passes through"*. So the decided
     * rotation is the one the cycler walks and the PIN is what was stale. Driven
     * 2026-09-20: the constant is
     * `["explore","plan","default","acceptEdits","auto","bypassPermissions"]`
     * and seven cycles from `default` give
     * `acceptEdits, auto, bypassPermissions, explore, plan, default, acceptEdits`.
     *
     * It is now DERIVED as well as literal, so it cannot go stale silently a
     * second time: the literal list is what a reader checks against the owner's
     * decision, and the derived arm fails if the cycler stops walking its own
     * constant in order. A flipped default is the one change with no instrument
     * (its stale pins go GREEN, not red) — this one went red, which is why it
     * was findable at all.
     */
    it('should cycle through permission modes', () => {
      permissionManager.setPermissionMode('default');

      const rotation = DEFAULT_CYCLABLE_PERMISSION_MODES.map(
        () => permissionManager.cyclePermissionMode(),
      );

      // The decided cycle, spelled out: `dontAsk` is absent (cycling into a mode
      // that silently denies would be a surprise mid-session) and
      // `bypassPermissions` is present (D1.369 — offered rather than hidden,
      // with the first-activation responsibility dialog as the enable).
      expect(rotation).toEqual([
        'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'default', // F1.1050: explore left the cycle
      ]);
      // One full turn returns where it started, so the rotation is a cycle over
      // exactly the configured set and nothing is visited twice or skipped.
      expect(permissionManager.getPermissionMode()).toBe('default');
      expect([...rotation].sort()).toEqual([...DEFAULT_CYCLABLE_PERMISSION_MODES].sort());
      // The negative that makes the presence of bypass mean something: `dontAsk`
      // is never cycled into, whatever else moves.
      expect(rotation).not.toContain('dontAsk');
    });

    it('supports setting auto mode', () => {
      permissionManager.setPermissionMode('auto');
      expect(permissionManager.getPermissionMode()).toBe('auto');
    });

    it('uses dangerous command detection for auto bash permissions', () => {
      // D1.307 — through `isDangerousCommand`, the predicate that does the
      // work. This case used to drive `requiresBashPermission`, whose mode
      // branches were the only thing it added and which no product code called.
      permissionManager.setPermissionMode('auto');
      expect(permissionManager.isDangerousCommand('rm file.txt')).toBe(true);
      expect(permissionManager.isDangerousCommand('echo hello')).toBe(false);
    });
  });

  describe('Command Analysis', () => {
    it('should extract base command from simple commands', () => {
      expect(permissionManager.getBaseCommand('ls -la')).toBe('ls');
      expect(permissionManager.getBaseCommand('git status')).toBe('git');
      expect(permissionManager.getBaseCommand('npm install')).toBe('npm');
    });

    it('should handle sudo prefix', () => {
      expect(permissionManager.getBaseCommand('sudo rm -rf /')).toBe('rm');
      expect(permissionManager.getBaseCommand('sudo apt-get update')).toBe('apt-get');
    });

    it('should detect dangerous commands', () => {
      expect(permissionManager.isDangerousCommand('rm')).toBe(true);
      expect(permissionManager.isDangerousCommand('sudo')).toBe(true);
      expect(permissionManager.isDangerousCommand('chmod')).toBe(true);
      expect(permissionManager.isDangerousCommand('curl')).toBe(true);
      expect(permissionManager.isDangerousCommand('wget')).toBe(true);

      expect(permissionManager.isDangerousCommand('ls')).toBe(false);
      expect(permissionManager.isDangerousCommand('cat')).toBe(false);
      expect(permissionManager.isDangerousCommand('echo')).toBe(false);
    });

    it('should extract domain from network commands', () => {
      expect(permissionManager.extractDomainFromNetworkCommand('curl https://api.example.com/data'))
        .toBe('api.example.com');
      expect(permissionManager.extractDomainFromNetworkCommand('wget http://download.example.org/file.zip'))
        .toBe('download.example.org');
      expect(permissionManager.extractDomainFromNetworkCommand('ssh user@server.example.com'))
        .toBe('server.example.com');
      expect(permissionManager.extractDomainFromNetworkCommand('ls -la'))
        .toBe(null);
    });
  });

  describe('Session-Scoped Whitelisting', () => {
    it('should start with no whitelisted commands', () => {
      expect(permissionManager.isCommandWhitelisted('ls')).toBe(false);
      expect(permissionManager.isCommandWhitelisted('git')).toBe(false);
    });

    it('should whitelist commands', () => {
      permissionManager.whitelistCommand('ls');
      expect(permissionManager.isCommandWhitelisted('ls')).toBe(true);
      expect(permissionManager.isCommandWhitelisted('git')).toBe(false);
    });

    it('should be case-insensitive for command whitelisting', () => {
      permissionManager.whitelistCommand('Git');
      expect(permissionManager.isCommandWhitelisted('git')).toBe(true);
      expect(permissionManager.isCommandWhitelisted('GIT')).toBe(true);
    });

    it('should whitelist domains', () => {
      permissionManager.whitelistDomain('api.example.com');
      expect(permissionManager.isDomainWhitelisted('api.example.com')).toBe(true);
      expect(permissionManager.isDomainWhitelisted('other.example.com')).toBe(false);
    });

    it('should be case-insensitive for domain whitelisting', () => {
      permissionManager.whitelistDomain('API.Example.COM');
      expect(permissionManager.isDomainWhitelisted('api.example.com')).toBe(true);
    });

    it('should clear all whitelists', () => {
      permissionManager.whitelistCommand('ls');
      permissionManager.whitelistDomain('example.com');

      permissionManager.clearWhitelists();

      expect(permissionManager.isCommandWhitelisted('ls')).toBe(false);
      expect(permissionManager.isDomainWhitelisted('example.com')).toBe(false);
    });

    it('should return copies of whitelisted sets for debugging', () => {
      permissionManager.whitelistCommand('ls');
      permissionManager.whitelistDomain('example.com');

      const commands = permissionManager.getWhitelistedCommands();
      const domains = permissionManager.getWhitelistedDomains();

      expect(commands.has('ls')).toBe(true);
      expect(domains.has('example.com')).toBe(true);

      // Verify they are copies (modifying shouldn't affect internal state).
      // BOTH halves, because the title says "sets": with only the command half
      // checked, `getWhitelistedDomains` could hand out the live session
      // whitelist and this suite stayed green — measured, 159 pass / 0 fail with
      // that exact substitution. A caller deleting from the returned set would
      // then be editing the session's always-allow domains through a getter.
      commands.delete('ls');
      expect(permissionManager.isCommandWhitelisted('ls')).toBe(true);
      domains.delete('example.com');
      expect(permissionManager.isDomainWhitelisted('example.com')).toBe(true);
    });
  });

  // D1.307 — the `Bash Permission Requirements` describe lived here and is GONE
  // with its subject. Its five cases asserted `requiresBashPermission`, a method
  // with zero product callers: three of them pinned its MODE branches (bypass and
  // explore answer `false`), which nothing else read, and the other two pinned
  // the dangerous-command answer, which `isDangerousCommand` gives directly and
  // which the D1.285 block at the end of this file drives on the whole command
  // line — including the `sudo …` case those two could not see.

  describe('Context Management', () => {
    it('exposes only revision-pinned capability permissions while active', () => {
      expect(permissionManager.getCapabilityPermissionsContext()).toBeNull();
      permissionManager.setCapabilityPermissionLayers([
        { content: JSON.stringify({ allowedBashPatterns: ['^git status$'] }) },
      ], 'generation-1');
      expect(permissionManager.getCapabilityPermissionsContext()).toMatchObject({
        pinnedRevision: 'generation-1',
        pinnedConfigs: [{ config: { allowedBashPatterns: [{ pattern: '^git status$' }] } }],
      });
      permissionManager.clearCapabilityPermissionLayers();
      expect(permissionManager.getCapabilityPermissionsContext()).toBeNull();
    });

    it('keeps pinned Source MCP patterns scoped to that Source', () => {
      permissionManager.setCapabilityPermissionLayers([{
        content: JSON.stringify({ allowedMcpPatterns: ['list'] }),
        sourceSlug: 'linear',
      }], 'generation-source');
      const merged = permissionsConfigCache.getMergedConfig(
        permissionManager.getCapabilityPermissionsContext()!,
      );
      // F1.287 (999d4ba7f): a source pattern names the tool's LEADING verb, so the
      // tool names here lead with it; the SCOPING is the slug, and only the slug differs.
      expect(merged.readOnlyMcpPatterns.some(pattern => pattern.test('mcp__linear__list_issues'))).toBe(true);
      expect(merged.readOnlyMcpPatterns.some(pattern => pattern.test('mcp__github__list_issues'))).toBe(false);
      // Boundary: the verb in a non-leading position no longer matches (the pre-F1.287 compile did).
      expect(merged.readOnlyMcpPatterns.some(pattern => pattern.test('mcp__linear__issues_list'))).toBe(false);
    });

    it('moves the command/file cwd without moving the workspace permissions root', () => {
      // Baseline: no explicit workspaceRootPath, so the permissions root falls
      // back to the initial workingDirectory.
      expect(permissionManager.getPermissionsContext().workspaceRootPath).toBe('/test/workspace');

      permissionManager.updateWorkingDirectory('/new/path');
      // Changing the project cwd must NOT relocate the workspace permissions
      // lookup — that root is a managed-storage invariant (W6 Step 8).
      expect(permissionManager.getPermissionsContext().workspaceRootPath).toBe('/test/workspace');
    });

    /**
     * P2.81 — the two hops `setCapabilityPermissionLayers` makes on the way to
     * the merge had NO test anywhere, and both are privilege decisions.
     * Measured, not argued: with the managed-only forwarding deleted the nearby
     * suites answered 225 pass / 0 fail, and with the `builtin`→`managed`
     * translation replaced by a pass-through, 196 pass / 0 fail. The lock family
     * itself is covered thoroughly one layer down (`managed-only-locks.test.ts`),
     * but every one of those rows builds its `PermissionsContext` by hand — so
     * the only path a real session's lock actually travels was untested, and
     * removable.
     *
     * Each row below pairs its claim with a control on the SAME layer content,
     * because "the grant is present" and "the grant is absent" are both reachable
     * for reasons that have nothing to do with the hop under test (a layer that
     * failed to parse contributes nothing and looks exactly like a locked one).
     */
    it('forwards the managed-only lock into the pinned context', () => {
      const grant = JSON.stringify({ allowedWritePaths: ['granted/**'] });
      // Control: the same layer, same scope, lock OFF. This is what proves the
      // layer parses and reaches the merge at all — without it, "the grant is
      // gone" is equally consistent with "the grant never arrived".
      permissionManager.setCapabilityPermissionLayers(
        [{ content: grant, scope: 'workspace' }], 'gen-lock-open', false, undefined, false,
      );
      const open = permissionsConfigCache.getMergedConfig(
        permissionManager.getCapabilityPermissionsContext()!,
      );
      expect(open.allowedWritePaths).toContain('granted/**');

      permissionManager.setCapabilityPermissionLayers(
        [{ content: grant, scope: 'workspace' }], 'gen-lock-open', false, undefined, true,
      );
      const lockedContext = permissionManager.getCapabilityPermissionsContext()!;
      // The field must actually be on the context: `underLock` reads it off the
      // context, and `buildCacheKey`'s `rulesOnly` segment is what keeps the two
      // answers in separate cache entries. Drop the forwarding and this is the
      // same key, hence the same object, hence the same verdict.
      expect(lockedContext.managedPermissionRulesOnly).toBe(true);
      const locked = permissionsConfigCache.getMergedConfig(lockedContext);
      expect(locked).not.toBe(open);
      expect(locked.allowedWritePaths).not.toContain('granted/**');
    });

    it('publishes a builtin layer at the managed scope, which is what survives the lock', () => {
      const grant = JSON.stringify({ allowedWritePaths: ['builtin-grant/**'] });
      // Control on the same content: at `workspace` scope the lock strips the
      // grant. So a surviving grant below can only be the `managed` privilege.
      permissionManager.setCapabilityPermissionLayers(
        [{ content: grant, scope: 'workspace' }], 'gen-builtin', false, undefined, true,
      );
      expect(permissionsConfigCache.getMergedConfig(
        permissionManager.getCapabilityPermissionsContext()!,
      ).allowedWritePaths).not.toContain('builtin-grant/**');

      permissionManager.setCapabilityPermissionLayers(
        [{ content: grant, scope: 'builtin' }], 'gen-builtin', false, undefined, true,
      );
      const context = permissionManager.getCapabilityPermissionsContext()!;
      expect(context.pinnedConfigs?.[0]?.scope).toBe('managed');
      expect(permissionsConfigCache.getMergedConfig(context).allowedWritePaths)
        .toContain('builtin-grant/**');
    });

    /**
     * P2.55 / P2.78 — the cache identifies a pinned context by a sha256 over the
     * CONTENT of `pinnedConfigs`, and any memo of that digest can only be keyed
     * on the array. A later in-place edit would leave the reference intact and
     * the digest stale, so the session would keep being policed by its previous
     * rule set. The published set is frozen so that edit throws instead.
     */
    it('publishes an immutable layer set, all the way down', () => {
      permissionManager.setCapabilityPermissionLayers([
        { content: JSON.stringify({ allowedWritePaths: ['frozen/**'] }), scope: 'workspace' },
      ], 'gen-frozen');
      const pinned = permissionManager.getCapabilityPermissionsContext()!.pinnedConfigs!;

      // Positive control: the frozen set is a real, loaded layer, not an empty
      // array that would be trivially immutable.
      expect(pinned[0]!.config.allowedWritePaths).toEqual(['frozen/**']);
      // The array: no layer may be appended to a published set.
      expect(() => pinned.push({ config: pinned[0]!.config, scope: 'managed' })).toThrow();
      // The entry: no layer's config or scope may be swapped.
      expect(() => { (pinned[0] as { scope?: string }).scope = 'managed'; }).toThrow();
      // The nested content — the case a shallow freeze misses and the one that
      // actually poisons a content digest.
      expect(() => pinned[0]!.config.allowedWritePaths.push('smuggled/**')).toThrow();
      // And the merge still reads it: freezing must not have cost the feature.
      expect(permissionsConfigCache.getMergedConfig(
        permissionManager.getCapabilityPermissionsContext()!,
      ).allowedWritePaths).toContain('frozen/**');
    });

    it('compiles a frozen layer\'s permission DSL without writing to it', () => {
      // The freeze above is only safe if NOTHING downstream writes into a
      // published layer, and the suites that exercise
      // `setCapabilityPermissionLayers` all publish either an empty layer list
      // or a plain allow-list layer — none of them carries a `permissions`
      // block, so their green said nothing about the compile path. This row is
      // that missing control: the DSL compiler stamps `order` onto rules, and if
      // it stamped them onto the INPUT the freeze would throw here.
      permissionManager.setCapabilityPermissionLayers([
        { content: JSON.stringify({ permissions: { deny: ['Read(./secret/**)'], allow: ['Read(./public/**)'] } }), scope: 'workspace', sourceRoot: '/test/workspace' },
      ], 'gen-frozen-dsl');
      const context = permissionManager.getCapabilityPermissionsContext()!;
      // The rule list lives at `permissionDsl.document.rules`, NOT
      // `permissionDsl.rules` — a layer's `permissionDsl` carries only
      // `{sourceDigest, document}`. The first draft of this row asserted
      // `Object.isFrozen(permissionDsl?.rules)` and passed with the freeze
      // REMOVED, because `Object.isFrozen(undefined)` is `true`: a
      // match-anything assertion against the very substitution it claimed to
      // catch. So the target is read out and checked for existence first.
      const document = context.pinnedConfigs![0]!.config.permissionDsl!.document as { rules: unknown[] };
      expect(document.rules).toHaveLength(2);
      expect(() => document.rules.push({})).toThrow();

      const compiled = permissionsConfigCache.getMergedConfig(context).permissionDsl!;
      // Both directions compiled and are distinguishable — a compile that
      // silently dropped the layer would leave an empty program, which is not
      // what "did not throw" means.
      expect(compiled.rules.map(rule => rule.action).sort()).toEqual(['allow', 'deny']);
      expect(compiled.rules.map(rule => rule.order)).toEqual([0, 1]);
    });

    it('should update plans folder path', () => {
      permissionManager.updatePlansFolderPath('/new/plans/path');
      // The plans folder path is used internally for permission checks
      // No direct getter, but we can verify no errors occur
    });

    it('should return the session ID', () => {
      expect(permissionManager.getSessionId()).toBe(TEST_SESSION_ID);
    });
  });
});

/**
 * D1.285 (`[safety]`) — the four TWO-word entries on `DANGEROUS_COMMANDS` used
 * to match nothing at all, because every caller looked the set up with a
 * one-word base command. Driven at HEAD with `rm` as the control:
 * `git push origin main` answered `false` on both of the spellings
 * `SessionManager.persistBashAlwaysAllowRule` checks. D1.307 then DELETED
 * `requiresBashPermission` — the method that carried the list's stated purpose
 * ("always require permission in 'ask' mode") and had zero product callers — and
 * moved that sentence onto `isDangerousCommandLine`, which these cases drive.
 */
describe('PermissionManager — the two-word dangerous entries (D1.285)', () => {
  const D1285_KEY: SessionKey = { workspaceId: 'test-workspace-d1285', sessionId: 'session-d1285' };
  let manager: PermissionManager;

  beforeEach(() => {
    cleanupModeState(D1285_KEY);
    initializeModeState(D1285_KEY, 'default');
    manager = new PermissionManager({
      workspaceId: D1285_KEY.workspaceId,
      sessionId: D1285_KEY.sessionId,
      workingDirectory: '/test/workspace',
    });
  });

  it('matches a two-word entry as a prefix of the first two tokens', () => {
    for (const command of [
      'git push origin main',
      'git reset --hard HEAD~1',
      'git rebase main',
      'git checkout -f .',
    ]) {
      expect(manager.isDangerousCommand(command)).toBe(true);
    }
    // The control: a one-word entry matched before this row and still does,
    // through the base command and through the whole line alike.
    expect(manager.isDangerousCommand('rm')).toBe(true);
    expect(manager.isDangerousCommand('rm -rf build')).toBe(true);
    // `sudo` is on the list and `getBaseCommand` strips it, so a caller that
    // hands over a BASE command cannot see it — which is why the contract
    // sentence now sits on the predicate and says "hand it the whole line".
    expect(manager.isDangerousCommand('sudo apt install ripgrep')).toBe(true);
  });

  it('D1.316 — a FLAG between the head and the verb does not walk past the floor', () => {
    // Measured at HEAD before this row: SIX spellings of one command answered
    // `false` where `git push origin main` answered `true`, and with a broad
    // `git` session key every one of them was auto-allowed. This is the floor
    // D1.291, D1.305 and D1.314 all lean on.
    for (const command of [
      'git -C /repo push',
      'git --no-pager reset --hard',
      'git --git-dir=/x push',
      'git -c user.name=x push',
      'git --git-dir /x push',
      // A BOOLEAN short option, which takes no value: the step-over must not
      // eat its `push` on the assumption that it does. That is the clause which
      // lets the rule work with no per-command option table.
      'git -p push',
    ]) {
      expect({ command, dangerous: manager.isDangerousCommand(command) })
        .toEqual({ command, dangerous: true });
    }
  });

  it('D1.316 — and the step-over cannot widen what is refused — the negative', () => {
    // It can only ever step over tokens the list does not name, so the same
    // flags in front of a HARMLESS verb stay harmless. Without this the fix
    // would refuse every `git -C …`, which is the direction that would be met
    // as "the app stopped letting me work".
    for (const command of [
      'git -C /repo status',
      'git -C /repo log --oneline',
      'git --bare status',
      'git --no-pager diff',
    ]) {
      expect({ command, dangerous: manager.isDangerousCommand(command) })
        .toEqual({ command, dangerous: false });
    }
  });

  it('does not widen a base command into its whole family — the negative', () => {
    // `git` is not on the list; only four of its subcommands are. A pair arm
    // that fired on the head alone would refuse every git command in the app.
    expect(manager.isDangerousCommand('git')).toBe(false);
    expect(manager.isDangerousCommand('git status --short')).toBe(false);
    expect(manager.isDangerousCommand('npm run build')).toBe(false);
    expect(manager.isDangerousCommand('')).toBe(false);
    expect(manager.isDangerousCommand('   ')).toBe(false);
  });

  it('names the bases whose durable rule must be narrowed, and only those', () => {
    // F1.98 — these five cases used to read `PermissionManager.isDangerousCommandPrefix`,
    // a one-line wrapper with no production caller left after D1.404. They now
    // read the predicate that does the work, so the coverage survives the
    // wrapper's deletion unchanged.
    expect(headsDangerousCommandPair('git')).toBe(true);
    expect(headsDangerousCommandPair('GIT')).toBe(true);
    // `rm` is dangerous outright and heads no pair: a rule for it is refused
    // by the other predicate, never narrowed by this one.
    expect(headsDangerousCommandPair('rm')).toBe(false);
    expect(headsDangerousCommandPair('git push')).toBe(false);
    expect(headsDangerousCommandPair('')).toBe(false);
  });

  it('F1.98 — carries no caller-less isDangerousCommandPrefix wrapper', () => {
    // Read off the prototype rather than called, so the arm fails on the
    // wrapper's PRESENCE and not on a call that would type-check either way.
    // The census that decided the deletion (2026-09-23, HEAD `1b01e1c27`):
    // `git grep -n isDangerousCommandPrefix -- packages apps` named this suite's
    // five assertions and the declaration, and nothing else.
    expect('isDangerousCommandPrefix' in PermissionManager.prototype).toBe(false);
    // CONTROL on the same instrument: a live method IS seen.
    expect('isDangerousCommand' in PermissionManager.prototype).toBe(true);
  });
});
