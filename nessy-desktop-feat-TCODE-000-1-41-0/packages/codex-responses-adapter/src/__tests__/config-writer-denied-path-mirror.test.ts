/**
 * P3.175 — the `deniedPaths` credential floor, mirrored onto codex's own
 * `[permissions.<profile>.filesystem]` map.
 *
 * These are STRING-BUILDER assertions: what this file proves is that the floor
 * we hold is translated into the keys codex's parser accepts, and that an entry
 * it cannot express is dropped BY NAME rather than silently. Whether the binary
 * HONOURS those keys is a separate proposition, measured in
 * `sandbox-enforcement.test.ts` — the two have already diverged once on this
 * runtime (P2.306), which is why they are separate files.
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexConfigToml,
  buildCodexRuntimeConfigOverride,
  mapDeniedPathsToCodexFilesystemKeys,
  formatCodexCredentialFloorShellDiagnostics,
  formatCodexDeniedPathDiagnostics,
  formatCodexInstructionExcludeDiagnostics,
  formatCodexExecpolicyGrantSandboxDiagnostics,
  validateConfigAgainstSchema,
  writeCodexConfig,
} from '../config-writer.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCHEMA = join(REPO_ROOT, 'packages', 'codex-protocol', 'schema', 'config-schema.json');
const SHIPPED_FLOOR = join(REPO_ROOT, 'apps', 'electron', 'resources', 'permissions', 'default.json');

const BASE = { codexHome: '/tmp/nessy-codex-mirror', model: 'gpt-5-codex', adapterPort: 4242 } as const;

describe('P3.175 — translating one floor pattern into a codex filesystem key', () => {
  test('a `~/`-anchored pattern is passed through so CODEX expands the home, not us', () => {
    // The whole point of the `~/` form: `AbsolutePathBuf::maybe_expand_home_directory`
    // joins with the platform separator, so P3.108's Windows defect class cannot
    // arise — no pattern string ever meets a normalized candidate here.
    expect(mapDeniedPathsToCodexFilesystemKeys(['~/.netrc']).keys).toEqual(['~/.netrc']);
    expect(mapDeniedPathsToCodexFilesystemKeys(['~/.docker/config.json']).keys)
      .toEqual(['~/.docker/config.json']);
  });

  test('a trailing `/**` is STRIPPED to its container — the spelling that also hides the NAME', () => {
    // Measured (see sandbox-enforcement.test.ts): a file-scoped deny closes the
    // search RESULTS half and leaves the name listable; a DIRECTORY-scoped deny
    // closes both. Our own matcher already means the container by this pattern
    // (`deniedContainerPattern`, mode-manager.ts), so this is faithful, not wider.
    expect(mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/**']).keys).toEqual(['~/.ssh']);
    expect(mapDeniedPathsToCodexFilesystemKeys(['/opt/secrets/**']).keys).toEqual(['/opt/secrets']);
  });

  test('an absolute pattern with no glob is passed through', () => {
    expect(mapDeniedPathsToCodexFilesystemKeys(['/etc/nessy/token']).keys).toEqual(['/etc/nessy/token']);
  });

  test('a `**/`-prefixed glob mirrors WORKSPACE-SCOPED instead of being dropped (P3.175)', () => {
    // The root-anchored spelling `/**` + `/.env` stays refused — Windows rejects
    // it (`is_windows_absolute_path`) and Linux makes it FATAL
    // (`split_pattern_for_ripgrep` returns None for a `"/"` static prefix). The
    // `:workspace_roots` scoped form never meets either parser: the base key is a
    // special, and the subpath goes through `parse_relative_subpath`.
    const mapping = mapDeniedPathsToCodexFilesystemKeys(['**/.env', '**/*.pem']);
    expect(mapping.keys).toEqual([]);
    expect(mapping.workspaceGlobs).toEqual(['**/*.pem', '**/.env']);
    expect(mapping.mirrored).toEqual(['**/.env', '**/*.pem']);
    expect(mapping.workspaceScoped).toEqual(['**/.env', '**/*.pem']);
    expect(mapping.rejected).toEqual([]);
  });

  test('a glob that is NOT `**/`-prefixed is still REJECTED, not narrowed', () => {
    // `**/X` anchored at a workspace root is a provable SUBSET of "any path
    // ending /X". Any other glob shape is not: `~/*.key` anchored there would
    // deny `<ws>/anything.key`, which the pattern never named. A silent widening
    // reads as a bug; a named drop does not.
    const mapping = mapDeniedPathsToCodexFilesystemKeys(['~/*.key', '/opt/*/x']);
    expect(mapping.keys).toEqual([]);
    expect(mapping.workspaceGlobs).toEqual([]);
    expect(mapping.rejected.map(r => r.reason)).toEqual(['glob-not-portable', 'glob-not-portable']);
  });

  test('a `**/` subpath codex would REFUSE is dropped here, because a refusal discards the WHOLE config', () => {
    // `parse_relative_subpath` (permissions.rs:862-886) admits only
    // `Component::Normal` components. A `.`/`..` component makes
    // `compile_permission_profile` return Err, and the app-server answers
    // "Invalid configuration; using defaults" on STDERR ONLY while discarding
    // every other floor entry with it. So the guard lives on our side.
    const mapping = mapDeniedPathsToCodexFilesystemKeys(['**/../x', '**/./x', '**//x']);
    expect(mapping.workspaceGlobs).toEqual([]);
    expect(mapping.rejected.map(r => r.reason)).toEqual([
      'workspace-subpath-invalid', 'workspace-subpath-invalid', 'workspace-subpath-invalid',
    ]);
  });

  test('a character class is REJECTED because it would WIDEN past the floor', () => {
    // Ours escapes `[`/`]` (globToRegex); codex's `contains_glob_chars` treats
    // them as a class. Mirroring would deny paths our own gate allows.
    expect(mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/id_[rd]sa']).rejected)
      .toEqual([{ pattern: '~/.ssh/id_[rd]sa', reason: 'glob-class-widens' }]);
  });

  test('bare home is a policy decision, not a translation', () => {
    for (const pattern of ['~', '~/', '~/**']) {
      expect(mapDeniedPathsToCodexFilesystemKeys([pattern]).rejected)
        .toEqual([{ pattern, reason: 'bare-home' }]);
    }
  });

  test('the filesystem root is refused through the same door', () => {
    expect(mapDeniedPathsToCodexFilesystemKeys(['/**']).rejected)
      .toEqual([{ pattern: '/**', reason: 'bare-home' }]);
  });

  test('a relative pattern is REJECTED — codex\'s key parser refuses it outright', () => {
    for (const pattern of ['secrets/**', '.env', '']) {
      expect(mapDeniedPathsToCodexFilesystemKeys([pattern]).rejected)
        .toEqual([{ pattern, reason: 'unanchored' }]);
    }
  });

  test('a key that cannot survive as a path is REJECTED', () => {
    for (const pattern of ['~/a\\b', '~/a\nb', '~/a\r', '~/a\0b']) {
      expect(mapDeniedPathsToCodexFilesystemKeys([pattern]).rejected)
        .toEqual([{ pattern, reason: 'unsafe-in-config-key' }]);
    }
  });

  test('a key that IS a grant is dropped rather than silently revoking the grant', () => {
    // `deny` beats `write` on codex's side (FileSystemAccessMode's own doc
    // comment), so emitting both would revoke a write the host asked for.
    const mapping = mapDeniedPathsToCodexFilesystemKeys(['/data/plugin/**'], ['/data/plugin']);
    expect(mapping.keys).toEqual([]);
    expect(mapping.rejected).toEqual([{ pattern: '/data/plugin/**', reason: 'conflicts-with-grant' }]);
  });

  test('every input lands on exactly one side — the mapping is total', () => {
    const patterns = ['~/.ssh/**', '**/.env', '~', 'secrets/**', '~/a\\b', '~/x[0-9]', '/etc/t'];
    const mapping = mapDeniedPathsToCodexFilesystemKeys(patterns);
    expect(mapping.mirrored.length + mapping.rejected.length).toBe(patterns.length);
    expect([...mapping.mirrored, ...mapping.rejected.map(r => r.pattern)].sort())
      .toEqual([...patterns].sort());
  });

  test('keys are deduplicated and sorted so the config is stable across spawns', () => {
    const mapping = mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/**', '~/.ssh', '~/.aws/**']);
    expect(mapping.keys).toEqual(['~/.aws', '~/.ssh']);
    expect(mapping.mirrored).toEqual(['~/.ssh/**', '~/.ssh', '~/.aws/**']);
  });

  test('workspace globs are deduplicated and sorted for the same reason', () => {
    const mapping = mapDeniedPathsToCodexFilesystemKeys(['**/.env', '**/*.pem', '**/.env']);
    expect(mapping.workspaceGlobs).toEqual(['**/*.pem', '**/.env']);
    expect(mapping.workspaceScoped).toEqual(['**/.env', '**/*.pem', '**/.env']);
  });

  test('a workspace glob is NOT suppressed by a grant, and that is the intended resolution', () => {
    // `deny` beats `write` on codex's side, so `**/*.key` under a granted
    // workspace makes those files unreadable AND unwritable there. Our own gate
    // already refuses Read, Edit and Write on that pattern, so suppressing the
    // deny to protect the grant would make codex WEAKER than the floor it mirrors.
    const mapping = mapDeniedPathsToCodexFilesystemKeys(['**/*.key'], ['/repo']);
    expect(mapping.workspaceGlobs).toEqual(['**/*.key']);
    expect(mapping.rejected).toEqual([]);
  });
});

describe('P3.175 — the SHIPPED floor, pinned against the file that ships it', () => {
  const deniedPaths: string[] = JSON.parse(readFileSync(SHIPPED_FLOOR, 'utf8')).deniedPaths;

  /**
   * P6.1063 — the partition, pinned by MEMBERSHIP and never again by a bare
   * count.
   *
   * Four assertions in this block spelled their sizes as literals — ten, nine,
   * nineteen — and all four went red when the shipped floor grew for reasons
   * that had nothing to do with this file: `7b7582387` added the `gh` and
   * `glab-cli` credential stores, `e6296c0f7` added our own `~/.nessy` token
   * store and `credentials.enc`. A literal told the reader the floor was the
   * wrong SIZE; it never named the entry that had arrived, and a reader who
   * bumps the number learns nothing about what it now covers.
   *
   * So the two lists below ARE the pin, every count is derived from them, and a
   * new floor entry fails on the name it added in exactly one place.
   */
  const HOME_ANCHORED_KEYS = [
    '~/.aws',
    '~/.azure',
    '~/.config/gcloud',
    '~/.config/gh',
    '~/.config/git/credentials',
    '~/.config/glab-cli',
    '~/.docker/config.json',
    '~/.git-credentials',
    '~/.gnupg',
    '~/.kube',
    '~/.nessy',
    '~/.netrc',
    '~/.ssh',
  ];
  const WORKSPACE_SCOPED_GLOBS = [
    '**/*-service-account.json',
    '**/*.key',
    '**/*.pem',
    '**/.env',
    '**/.env.*',
    '**/.git/glab-cli',
    '**/.npmrc',
    '**/.pypirc',
    '**/credentials.enc',
    '**/id_ed25519',
    '**/id_rsa',
    '**/workspaces/*/artifacts/registry.json', // UA1.16 — the host's t-artifacts registry
  ];

  test('the default install ships exactly the partition pinned here', () => {
    expect(deniedPaths.length).toBe(HOME_ANCHORED_KEYS.length + WORKSPACE_SCOPED_GLOBS.length);
  });

  test('the `~/`-anchored entries reach codex as absolute keys — the class P3.108 found INERT on Windows', () => {
    const mapping = mapDeniedPathsToCodexFilesystemKeys(deniedPaths);
    expect(mapping.keys).toEqual(HOME_ANCHORED_KEYS);
    expect(mapping.mirrored.length - mapping.workspaceScoped.length).toBe(HOME_ANCHORED_KEYS.length);
  });

  test('the `**\\/`-anchored entries reach codex WORKSPACE-SCOPED — P3.175\'s open half', () => {
    const mapping = mapDeniedPathsToCodexFilesystemKeys(deniedPaths);
    expect(mapping.workspaceGlobs).toEqual(WORKSPACE_SCOPED_GLOBS);
    expect(mapping.workspaceScoped.length).toBe(WORKSPACE_SCOPED_GLOBS.length);
  });

  test('the five entries the floor grew by are each mirrored BY NAME, not by a count', () => {
    // The successor asserted PRESENT. A count going 19 → 24 says nothing about
    // which side of the partition the five landed on, and the answer is not
    // obvious from the pattern: `**/.git/glab-cli` reads like a home-anchored
    // sibling of `~/.config/glab-cli` and is workspace-scoped, while
    // `**/credentials.enc` is deliberately UNPREFIXED because `NESSY_CONFIG_DIR`
    // relocates the store (`e6296c0f7`'s own reason).
    const mapping = mapDeniedPathsToCodexFilesystemKeys(deniedPaths);
    for (const key of ['~/.config/gh', '~/.config/glab-cli', '~/.nessy']) {
      expect(mapping.keys, key).toContain(key);
    }
    for (const glob of ['**/.git/glab-cli', '**/credentials.enc']) {
      expect(mapping.workspaceGlobs, glob).toContain(glob);
    }
  });

  test('NOTHING in the shipped floor is dropped any more — every entry reaches codex', () => {
    // The counted reason P3.175 was held at partial: the `~/`-anchored half
    // mirrored and the `**\/`-anchored half reached no enforcement anywhere on
    // codex, because our own gate never denies independently there. This is that
    // count going to zero — and it is stated as `rejected` being EMPTY rather
    // than as a size, so it cannot rot when the floor grows.
    const mapping = mapDeniedPathsToCodexFilesystemKeys(deniedPaths);
    expect(mapping.rejected).toEqual([]);
    expect(mapping.mirrored.length).toBe(deniedPaths.length);
  });
});

describe('P3.175 — the floor reaches the emitted config', () => {
  test('mirrored keys become `deny` lines in the profile', () => {
    const toml = buildCodexConfigToml({ ...BASE, deniedReadPatterns: ['~/.ssh/**', '~/.netrc'] });
    expect(toml).toContain('default_permissions = "nessy_runtime"');
    expect(toml).toContain('[permissions.nessy_runtime.filesystem]');
    expect(toml).toContain('"~/.netrc" = "deny"');
    expect(toml).toContain('"~/.ssh" = "deny"');
  });

  test('patterns ALONE raise the profile — no host deny or grant required', () => {
    // The writer used to emit `[permissions]` only when `deniedReadPaths` or
    // `writablePaths` was non-empty. A floor-only config has to raise it too, or
    // the whole mirror is inert on any install with no plugin runtime.
    const toml = buildCodexConfigToml({ ...BASE, deniedReadPatterns: ['~/.aws/**'] });
    expect(toml).toContain('[permissions.nessy_runtime]');
    expect(toml).toContain('"~/.aws" = "deny"');
  });

  test('a floor whose every entry is rejected emits BYTE-IDENTICAL config to none at all', () => {
    const none = buildCodexConfigToml({ ...BASE });
    const allRejected = buildCodexConfigToml({ ...BASE, deniedReadPatterns: ['~/*.key', 'secrets/**'] });
    expect(allRejected).toBe(none);
    expect(none).not.toContain('default_permissions');
  });

  test('a workspace-glob-ONLY floor raises the profile and emits the scoped table', () => {
    // The gate used to read `mapping.keys` alone. A floor whose only mirrorable
    // entries are the nine would then emit no `[permissions]` block at all and
    // the mirror would be silently absent.
    const toml = buildCodexConfigToml({ ...BASE, deniedReadPatterns: ['**/.env', '**/*.pem'] });
    expect(toml).toContain('default_permissions = "nessy_runtime"');
    expect(toml).toContain('[permissions.nessy_runtime.filesystem.":workspace_roots"]');
    expect(toml).toContain('"**/.env" = "deny"');
    expect(toml).toContain('"**/*.pem" = "deny"');
  });

  test('the scoped table comes AFTER every scalar entry of its parent — TOML would reparent them', () => {
    // In TOML a bare `key = value` following a sub-table header belongs to the
    // SUB-table. An absolute deny emitted after this header would silently become
    // a workspace-relative subpath, and `parse_relative_subpath` would refuse it,
    // discarding the whole config.
    const toml = buildCodexConfigToml({
      ...BASE,
      deniedReadPaths: ['/private/nessy/credentials.enc'],
      deniedReadPatterns: ['~/.ssh/**', '**/.env'],
    });
    const lines = toml.split('\n');
    const scoped = lines.indexOf('[permissions.nessy_runtime.filesystem.":workspace_roots"]');
    expect(scoped).toBeGreaterThan(-1);
    expect(lines.indexOf('"/private/nessy/credentials.enc" = "deny"')).toBeLessThan(scoped);
    expect(lines.indexOf('"~/.ssh" = "deny"')).toBeLessThan(scoped);
    expect(lines.indexOf('"**/.env" = "deny"')).toBeGreaterThan(scoped);
  });

  test('the host deny and the floor mirror coexist, deny both times', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      deniedReadPaths: ['/private/nessy/credentials.enc'],
      deniedReadPatterns: ['~/.ssh/**'],
    });
    expect(toml).toContain('"/private/nessy/credentials.enc" = "deny"');
    expect(toml).toContain('"~/.ssh" = "deny"');
  });

  test('the per-thread override carries the same keys, so a floor change moves the signature', () => {
    const override = buildCodexRuntimeConfigOverride({
      mode: 'default',
      deniedReadPaths: ['/private/nessy/credentials.enc'],
      deniedReadPatterns: ['~/.ssh/**'],
    }) as { permissions: { nessy_runtime: { filesystem: Record<string, string> } } };
    expect(override.permissions.nessy_runtime.filesystem).toEqual({
      '/private/nessy/credentials.enc': 'deny',
      '~/.ssh': 'deny',
    });
  });

  test('the override carries the scoped table as a NESTED map, matching FilesystemPermissionToml', () => {
    // `#[serde(untagged)] Access(FileSystemAccessMode) | Scoped(BTreeMap<String,
    // FileSystemAccessMode>)` — permissions_toml.rs, `enum
    // FilesystemPermissionToml`, rust-v0.150.1 (byte-identical across the lift).
    const override = buildCodexRuntimeConfigOverride({
      mode: 'default',
      deniedReadPatterns: ['~/.ssh/**', '**/.env', '**/*.pem'],
    }) as { permissions: { nessy_runtime: { filesystem: Record<string, unknown> } } };
    expect(override.permissions.nessy_runtime.filesystem).toEqual({
      '~/.ssh': 'deny',
      ':workspace_roots': { '**/*.pem': 'deny', '**/.env': 'deny' },
    });
  });

  test('a workspace-glob-ONLY config still validates against the release config schema', () => {
    expect(() => validateConfigAgainstSchema({ ...BASE, deniedReadPatterns: ['**/.env'] }, SCHEMA))
      .not.toThrow();
  });

  test('a floor-only config still validates against the release config schema', () => {
    expect(() => validateConfigAgainstSchema({ ...BASE, deniedReadPatterns: ['~/.ssh/**'] }, SCHEMA))
      .not.toThrow();
  });

  // P3.273 · the two `.not.toThrow()` assertions above are the shape that can
  // pass for free, and one of them did. Moving the floor into its own module
  // made the four withheld mutants runnable, and the one that reads
  // `hasCodexRuntimePathPolicy`'s workspace-glob arm SURVIVED the whole 26-file
  // adapter suite: nothing it changes reaches the emitted TOML — the builder
  // gates on `hasCodexFilesystemPolicy(policy)` instead — so its ONLY observable
  // effect is that `default_permissions` and `permissions` stop being demanded
  // of the release schema, and no test demanded them. These two arms arm that
  // guard, in the shape `config-writer-compact-prompt.test.ts` established: a
  // schema with the property deleted must FAIL for a workspace-glob-only floor
  // and stay SILENT for a config that writes no profile at all.
  test.each(['permissions', 'default_permissions'])(
    'the workspace-glob-only guard is ARMED: a schema missing %s is refused', key => {
      const drifted = JSON.parse(readFileSync(SCHEMA, 'utf8')) as { properties: Record<string, unknown> };
      delete drifted.properties[key];
      const patched = join(tmpdir(), `p3273-schema-${key}-${process.pid}-${Date.now()}.json`);
      writeFileSync(patched, JSON.stringify(drifted), 'utf8');
      try {
        expect(() => validateConfigAgainstSchema({ ...BASE, deniedReadPatterns: ['**/.env'] }, patched))
          .toThrow(new RegExp(`no top-level property "${key}"`));
        // …and not vacuously: a config with no path policy writes neither key,
        // so the same drifted schema must pass.
        expect(() => validateConfigAgainstSchema({ ...BASE }, patched)).not.toThrow();
      } finally {
        rmSync(patched, { force: true });
      }
    });
});

describe('P3.175 — what did NOT reach codex names itself', () => {
  test('diagnostics report the mirror AND every drop, with the reason', () => {
    const lines = formatCodexDeniedPathDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/**', '~/*.key']),
    );
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('1 pattern(s) → 1 deny key(s)');
    expect(lines[0]).toContain('~/.ssh');
    expect(lines[1]).toContain('"~/*.key"');
    expect(lines[1]).toContain('glob-not-portable');
    expect(lines[1]).toContain('our own gate still denies it');
  });

  test('the workspace half gets its OWN line, and that line states what it does NOT cover', () => {
    // Two promises, two lines. Folded into one number, a reader would take the
    // weaker promise ("under a workspace root") for the stronger one ("anywhere").
    const lines = formatCodexDeniedPathDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/**', '**/.env']),
    );
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('1 pattern(s) → 1 deny key(s)');
    expect(lines[1]).toContain('WORKSPACE-SCOPED');
    expect(lines[1]).toContain(':workspace_roots');
    expect(lines[1]).toContain('**/.env');
    expect(lines[1]).toContain('NOT outside them');
    expect(lines[1]).toContain('our own request gate stays the only');
  });

  test('nothing to mirror and nothing to report emits no lines', () => {
    expect(formatCodexDeniedPathDiagnostics(mapDeniedPathsToCodexFilesystemKeys([]))).toEqual([]);
  });

  test('`writeCodexConfig` emits them once, on the sink the agent already reads', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-codex-mirror-'));
    try {
      const seen: string[] = [];
      writeCodexConfig({
        ...BASE,
        codexHome: home,
        deniedReadPatterns: ['~/.ssh/**', '**/.env'],
        onDiagnostic: (m) => seen.push(m),
      });
      expect(seen.filter(m => m.includes('credential floor mirrored to permissions.filesystem')).length).toBe(1);
      expect(seen.filter(m => m.includes('WORKSPACE-SCOPED')).length).toBe(1);
      expect(seen.filter(m => m.includes('codex-credential-floor-os-enforced')).length).toBe(1);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('"~/.ssh" = "deny"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * P3.184 + P3.221 — the OS deny also stops the user's own tools, and the only
 * thing that can say so is us.
 *
 * Measured on the shipped `darwin-arm64` `codex-app-server 0.148.0`, two arms
 * over one fixture HOME (no real credential was read). Every command below
 * returned the fixture marker in the control arm and refused in the treatment:
 *
 *   ssh -F ~/.ssh/config -G <host>   Can't open user config file …: Operation not permitted
 *   ssh-keygen -y -f ~/.ssh/id_...   exit 255, Operation not permitted
 *   git push (ssh remote)            Can't open user config file …; fatal: Could not read from remote
 *   git credential fill (store)      exit 128, fatal: unable to open ~/.git-credentials
 *   kubectl config view --raw        error: error loading config file "~/.kube/config"
 *   docker context ls                WARNING: Error loading config file: … operation not permitted
 *   cat ~/.aws|.config/gcloud|.azure|.netrc|.gnupg    Operation not permitted
 *
 * `aws`, `gcloud` and `az` are not installed on the measuring host, so that last
 * row is the read those CLIs perform rather than the CLIs themselves. `npm` was
 * probed as the NEGATIVE control and is unaffected: `~/.npmrc` is deliberately
 * absent from the floor.
 *
 * These are assertions about the SENTENCE, not about the binary — the binary half
 * lives in `sandbox-enforcement.test.ts`, for the same reason the mirror's two
 * halves are separate files.
 */
describe('P3.184 + P3.221 — the shell-scope consequence is stated, not left to be discovered', () => {
  test('a mirrored floor produces exactly one line, and it names both scopes', () => {
    const lines = formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/**', '**/.env']),
    );
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('1 absolute/home path(s)');
    expect(lines[0]).toContain('1 workspace-scoped glob(s)');
  });

  test('it names the OPERATING SYSTEM as the enforcer, which is the fact that explains the breadth', () => {
    const [line] = formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/**']),
    );
    expect(line).toContain('OPERATING SYSTEM');
    expect(line).toContain("not only to the model's tools");
  });

  test('it names the measured casualties, so a failing CLI has an explanation', () => {
    const [line] = formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/.ssh/**']),
    );
    for (const tool of ['ssh', 'git credential', 'kubectl', 'docker', 'aws/gcloud/az']) {
      expect(line).toContain(tool);
    }
    expect(line).toContain('Operation not permitted');
  });

  test('it says the OTHER TWO RUNTIMES behave differently — P3.221 is a switch question', () => {
    // Goal 1: the same turn must be describable truthfully after a switch. On Pi
    // and claude this floor is tool-mediated, so every command above still works
    // there. A user hitting `Operation not permitted` cannot infer that.
    const [line] = formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['**/.env']),
    );
    expect(line).toContain('Pi and claude');
    expect(line).toContain('tool-side only');
    expect(line).toContain('per-runtime difference, not a fault');
  });

  test('it names the setting that relaxes it — P3.184\'s "which setting" half', () => {
    const [line] = formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/.netrc']),
    );
    expect(line).toContain('deniedPaths');
  });

  test('it records that codex HAS the classifier and never puts it on the wire', () => {
    // Native-first, answered rather than assumed: classify_filesystem_sandbox_violation
    // recognises this refusal and extracts the path, and record_sandbox_violation
    // only `tracing::warn!`s it inside the codex process. All four call sites
    // discard the return value.
    const [line] = formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/.netrc']),
    );
    expect(line).toContain('classify_filesystem_sandbox_violation');
    expect(line).toContain('never reaches the wire');
  });

  test('a workspace glob COUNTS as a denied-read entry for the execpolicy-bypass verdict', () => {
    // codex's `unsandboxed_execution_allowed` is `!has_denied_read_restrictions()`,
    // and a `:workspace_roots` deny glob compiles to a Deny entry like any other.
    // Counting only the flat map would tell a session with nine of them that it
    // has none — and this function's whole job is to say which of the two states
    // holds, so the wrong count is the wrong LINE, not a smaller number.
    const [line] = formatCodexExecpolicyGrantSandboxDiagnostics({
      execpolicyAllowPrefixes: [['git', 'status']],
      mode: 'default',
      // The master switch ON, so a sandbox exists for the grant to bypass:
      // `danger-full-access` returns no line at all, by design.
      sandboxGloballyEnabled: true,
      deniedReadPatterns: ['**/.env'],
    });
    expect(line).toContain('codex-execpolicy-grant-sandbox-retained');
    expect(line).toContain('1 denied-read entry');
    expect(line).not.toContain('codex-execpolicy-grant-unsandboxed');
  });

  test('nothing mirrored says nothing — the line describes a state, and the state is absent', () => {
    expect(formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys([]),
    )).toEqual([]);
    expect(formatCodexCredentialFloorShellDiagnostics(
      mapDeniedPathsToCodexFilesystemKeys(['~/*.key']),
    )).toEqual([]);
  });
})

describe('P3.257 (a) — instruction exclusions have no codex projection, so they get a sentence', () => {
  test('names the patterns, the reason, and what still reaches the model', () => {
    const [line, ...rest] = formatCodexInstructionExcludeDiagnostics(['docs/**/*.md', 'AGENTS.override.md']);
    expect(rest).toEqual([]);
    expect(line).toContain('2 instruction-file exclusion(s)');
    expect(line).toContain('docs/**/*.md, AGENTS.override.md');
    // The measured REASON, not just the fact: both codex knobs are named, so a
    // reader who wants to "just add a config key" learns why there isn't one.
    expect(line).toContain('project_doc_max_bytes');
    expect(line).toContain('project_doc_fallback_filenames');
    expect(line).toContain('neither can drop one file and keep another');
    // The switch-visible half — this is the sentence's whole point.
    expect(line).toContain('unlike on Pi and claude');
  });

  test('says nothing when the session excluded nothing, or only blanks', () => {
    // A line that always prints is a line nobody reads — the same rule its three
    // siblings in this file follow.
    expect(formatCodexInstructionExcludeDiagnostics(undefined)).toEqual([]);
    expect(formatCodexInstructionExcludeDiagnostics([])).toEqual([]);
    expect(formatCodexInstructionExcludeDiagnostics(['', '   '])).toEqual([]);
  });
});
;

/**
 * F1.1027 — the deny-read floor makes every codex thread open spawn one sandboxed
 * helper per AGENTS.md probe (13-49 s measured on 0.156.1), and the floor is kept.
 * The measurement and the source reading are on the function's docblock; these pin
 * that the price is SAID whenever a deny entry reaches codex, and only then.
 */
describe('F1.1027 — the thread-open price of the deny-read floor is stated, not left to be felt', () => {
  test('one exact deny path produces one line naming the helper and that the entry is the user\'s (F1.1057)', async () => {
    const { formatCodexDenyReadDiscoveryCostDiagnostics } = await import('../config-writer-permissions.ts');
    const lines = formatCodexDenyReadDiscoveryCostDiagnostics({ deniedReadPaths: ['/tmp/nessy-f1-1027/credentials.enc'] });
    expect(lines.length).toBe(1);
    const [line] = lines;
    expect(line).toStartWith('codex-deny-read-slows-thread-open: 1 deny-read entry ');
    expect(line).toContain('sandboxed file-system helper');
    expect(line).toContain('13-49 s on codex 0.156.1');
    // F1.1057 — the host adds no credential entry of its own on codex any more, so the
    // line attributes the entry to the user and says how to get fast opens back.
    expect(line).toContain('Nessy adds no credential entry of its own on codex');
    expect(line).toContain('remove the entry from deniedPaths');
    expect(line).not.toContain('kept on purpose');
    // A pattern is the same `Deny` entry in codex's `has_denied_read_restrictions`.
    expect(formatCodexDenyReadDiscoveryCostDiagnostics({ deniedReadPatterns: ['~/.ssh/**', '**/.env'] })[0])
      .toStartWith('codex-deny-read-slows-thread-open: 2 deny-read entries ');
  });

  test('F1.1057 — codexDenyReadEntryCount counts what the profile writes: exact, mirrored key, workspace glob', async () => {
    const { codexDenyReadEntryCount } = await import('../config-writer.ts');
    expect(codexDenyReadEntryCount({})).toBe(0);
    expect(codexDenyReadEntryCount({ writablePaths: ['/tmp/nessy-f1-1057/out'] })).toBe(0);
    expect(codexDenyReadEntryCount({ deniedReadPatterns: ['~/*.key'] })).toBe(0); // rejected by the mapper
    expect(codexDenyReadEntryCount({ deniedReadPaths: ['/tmp/nessy-f1-1057/secret'] })).toBe(1);
    expect(codexDenyReadEntryCount({ deniedReadPatterns: ['~/.ssh/**', '**/.env'] })).toBe(2);
    // An exact path and a mirrored key naming the same path are ONE TOML key.
    expect(codexDenyReadEntryCount({ deniedReadPaths: ['/srv/f1057'], deniedReadPatterns: ['/srv/f1057/**'] })).toBe(1);
  });

  test('no deny entry says nothing: a write grant alone keeps full-disk read, so no helper is spawned', async () => {
    const { formatCodexDenyReadDiscoveryCostDiagnostics } = await import('../config-writer-permissions.ts');
    expect(formatCodexDenyReadDiscoveryCostDiagnostics({})).toEqual([]);
    expect(formatCodexDenyReadDiscoveryCostDiagnostics({ writablePaths: ['/tmp/nessy-f1-1027/out'] })).toEqual([]);
    // A floor pattern the mapper REJECTS reaches codex as nothing, so it costs nothing.
    expect(formatCodexDenyReadDiscoveryCostDiagnostics({ deniedReadPatterns: ['~/*.key'] })).toEqual([]);
  });

  test('`writeCodexConfig` emits it once on the diagnostic sink when the floor is on', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-codex-f1-1027-'));
    try {
      const seen: string[] = [];
      writeCodexConfig({ ...BASE, codexHome: home, deniedReadPaths: [join(home, 'credentials.enc')], onDiagnostic: (m) => seen.push(m) });
      expect(seen.filter(m => m.startsWith('codex-deny-read-slows-thread-open:')).length).toBe(1);
      const quiet: string[] = [];
      writeCodexConfig({ ...BASE, codexHome: home, onDiagnostic: (m) => quiet.push(m) });
      expect(quiet.filter(m => m.startsWith('codex-deny-read-slows-thread-open:'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
