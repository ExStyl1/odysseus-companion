import { describe, expect, test } from 'bun:test';
import { resolveSandboxSettings } from '../../config/sandbox-settings.ts';
import { foldSandboxRuleRoots, sandboxRootsFromClaudeRules, sandboxRootsFromDeniedPaths } from './sandbox-permission-rules.ts';

const home = '/home/tester';

describe('permission rules merge into the sandbox boundary', () => {
  // settings-reference.md#sandbox-filesystem-allowwrite / #sandbox-filesystem-denywrite
  // / #sandbox-filesystem-denyread - allowWrite <- Edit allow, denyWrite <- Edit
  // deny, denyRead <- Read deny. sandboxing.md:372 - "Paths from both
  // `sandbox.filesystem` settings and permission rules are merged together".
  test('the three documented rule forms convert to their documented keys', () => {
    const roots = sandboxRootsFromClaudeRules({
      allow: ['Edit(//tmp/build/**)', 'Edit(~/.kube)'],
      deny: ['Edit(//usr/local/bin/**)', 'Read(//etc/shadow)', 'Read(~/.aws/credentials)'],
      ask: ['Edit(//srv/asked/**)'],
    }, { home });
    expect(roots.additionalWritableRoots).toEqual(['/tmp/build', '/home/tester/.kube']);
    expect(roots.deniedWriteRoots).toEqual(['/usr/local/bin']);
    expect(roots.deniedReadRoots).toEqual(['/etc/shadow', '/home/tester/.aws/credentials']);
    // An ask rule has no sandbox state to express, so it converts to nothing.
    expect(roots.diagnostics).toEqual([]);
  });

  test('a Read allow opens nothing, because reads are already ambient', () => {
    expect(sandboxRootsFromClaudeRules({ allow: ['Read(//etc/**)'] }, { home }))
      .toMatchObject({ additionalWritableRoots: [], deniedWriteRoots: [], deniedReadRoots: [] });
  });

  test('rules the boundary cannot state exactly are skipped, never approximated', () => {
    const roots = sandboxRootsFromClaudeRules({
      allow: ['Edit(//tmp/*/build/**)', 'Edit(src/**)'],
      deny: ['Read(/project-relative/**)', 'Edit(//**)'],
    }, { home });
    expect(roots.additionalWritableRoots).toEqual([]);
    expect(roots.deniedWriteRoots).toEqual([]);
    expect(roots.deniedReadRoots).toEqual([]);
    // Interior glob, cwd-relative, source-anchored, whole-filesystem: four
    // refusals, four diagnostics, zero silently widened roots.
    expect(roots.diagnostics).toHaveLength(4);
  });

  test('non-path tools and unparseable entries are ignored', () => {
    expect(sandboxRootsFromClaudeRules({
      allow: ['Bash(git status)', 'WebFetch(domain:example.com)', 'Edit(', '', 'Write(//tmp/x)'],
      deny: ['Read()'],
    }, { home })).toMatchObject({
      additionalWritableRoots: [], deniedWriteRoots: [], deniedReadRoots: [], diagnostics: [],
    });
  });

  test('an absent rule list changes nothing', () => {
    expect(sandboxRootsFromClaudeRules(undefined)).toMatchObject({
      additionalWritableRoots: [], deniedWriteRoots: [], deniedReadRoots: [],
    });
  });
});

describe('folding rule roots keeps the floor a floor', () => {
  test('a rule grant does not cap a user layer the administrator left open', () => {
    const roots = sandboxRootsFromClaudeRules({ allow: ['Edit(//tmp/build/**)'] }, { home });
    const folded = foldSandboxRuleRoots({ deniedReadRoots: ['/seeded'] }, roots);
    const resolved = resolveSandboxSettings(
      [...folded.layers, { additionalWritableRoots: ['/home/tester/user-grant'] }],
      { floor: folded.floor },
    );
    expect(resolved.additionalWritableRoots).toEqual(['/tmp/build', '/home/tester/user-grant']);
  });

  test('a floor that already caps grants absorbs the rule grant inside the cap', () => {
    const roots = sandboxRootsFromClaudeRules({ allow: ['Edit(//tmp/build/**)'] }, { home });
    const folded = foldSandboxRuleRoots({ additionalWritableRoots: ['/opt/company'] }, roots);
    const resolved = resolveSandboxSettings(
      [...folded.layers, { additionalWritableRoots: ['/home/tester/user-grant'] }],
      { floor: folded.floor },
    );
    expect(resolved.additionalWritableRoots).toEqual(['/opt/company', '/tmp/build']);
  });

  test('a floor written in the documented nested spelling caps grants the same way', () => {
    const roots = sandboxRootsFromClaudeRules({ allow: ['Edit(//tmp/build/**)'] }, { home });
    const folded = foldSandboxRuleRoots({ filesystem: { allowWrite: ['/opt/company'] } }, roots);
    const resolved = resolveSandboxSettings(
      [...folded.layers, { additionalWritableRoots: ['/home/tester/user-grant'] }],
      { floor: folded.floor },
    );
    expect(resolved.additionalWritableRoots).toEqual(['/opt/company', '/tmp/build']);
  });

  test('rule denies are additive and no layer can remove them', () => {
    const roots = sandboxRootsFromClaudeRules({
      deny: ['Read(//etc/shadow)', 'Edit(//usr/local/bin/**)'],
    }, { home });
    const folded = foldSandboxRuleRoots({ deniedReadRoots: ['/seeded'] }, roots);
    const resolved = resolveSandboxSettings([...folded.layers, {}], { floor: folded.floor });
    expect(resolved.deniedReadRoots).toEqual(['/seeded', '/etc/shadow']);
    expect(resolved.deniedWriteRoots).toEqual(['/usr/local/bin']);
  });

  test('with no rules the folded floor and layers are the originals', () => {
    const floor = { deniedReadRoots: ['/seeded'], excludedCommands: ['docker *'] };
    const folded = foldSandboxRuleRoots(floor, sandboxRootsFromClaudeRules(undefined));
    expect(folded.floor).toEqual(floor);
    expect(folded.layers).toEqual([]);
  });
});

describe('deniedPaths convert to sandbox read denials (F1.107)', () => {
  // The two exactly-convertible forms, and the SHIPPED floor's own entries as
  // the sample rather than invented ones: `SAFE_MODE_CONFIG.deniedPaths` is
  // where an operator's list starts.
  test('home- and root-anchored whole-subtree entries become subpath roots', () => {
    const { roots, diagnostics } = sandboxRootsFromDeniedPaths(
      ['~/.ssh/' + '**', '~/.docker/config.json', '/etc/shadow', '/srv/vault/' + '**'],
      { home },
    );
    expect(roots).toEqual(['/home/tester/.ssh', '/home/tester/.docker/config.json', '/etc/shadow', '/srv/vault']);
    expect(diagnostics).toEqual([]);
  });

  // The subset is deliberate and the diagnostics say which entries it left
  // behind, so an operator is never told a pattern bound when it did not.
  test('any-depth and partial globs are skipped WITH a diagnostic naming them', () => {
    const anyDepthDotenv = '**' + '/.env';
    const partial = '~/proj' + '/*' + '/secret';
    const { roots, diagnostics } = sandboxRootsFromDeniedPaths([anyDepthDotenv, partial], { home });
    expect(roots).toEqual([]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toContain('not anchored');
    expect(diagnostics[1]).toContain('partial glob');
    for (const line of diagnostics) expect(line).toContain('the permission layer still enforces it');
  });

  // The refusal every sandbox-root producer in this file makes: nothing may
  // resolve to the filesystem root, because such a root denies everything.
  // MEASURED rather than assumed — the two obvious spellings never reach the
  // root check at all, they are refused one step earlier as a bare glob, and a
  // test that asserted the root wording on them would have been asserting a
  // branch it never ran. The branch's real reachable shape is traversal.
  test('nothing resolves to the filesystem root, by whichever refusal comes first', () => {
    const bareGlobs = sandboxRootsFromDeniedPaths(['/' + '**', '~/' + '**'], { home });
    expect(bareGlobs.roots).toEqual([]);
    expect(bareGlobs.diagnostics).toHaveLength(2);
    for (const line of bareGlobs.diagnostics) expect(line).toContain('partial glob');

    const traversal = sandboxRootsFromDeniedPaths(['~/../../' + '**'], { home });
    expect(traversal.roots).toEqual([]);
    expect(traversal.diagnostics).toHaveLength(1);
    expect(traversal.diagnostics[0]).toContain('filesystem root');
  });
});
