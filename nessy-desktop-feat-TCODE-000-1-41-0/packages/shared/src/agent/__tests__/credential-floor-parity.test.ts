/**
 * The two credential floors, pinned against each other on the ONE thing they
 * must never disagree about: the host's OWN secrets (P6.674).
 *
 * ## What was measured, and how it surfaced
 *
 * It surfaced as a mis-specified control. W8-x's P6.544 probe named
 * `~/.nessy-agent/credentials.json` as the file a shell-variable spelling would
 * reach, and it came back ALLOWED even as a plain literal absolute path — not
 * because the spelling defeated anything, but because the file was in no floor
 * at all. Re-measured here at HEAD on 2026-09-07, tool `Read`, mode `default`,
 * with `~/.aws/credentials` REFUSED in the same run as the positive control:
 *
 *   ALLOWED  ~/.nessy/dp_auth_creds.json         the gateway JWT
 *   ALLOWED  ~/.nessy/dp_auth_creds.json.bak     a sibling copy of the same JWT
 *   ALLOWED  ~/.nessy/oauth_creds.json
 *   ALLOWED  <config dir>/credentials.enc        this app's encrypted store
 *
 * ## Why nothing else covered them
 *
 * `credentialDenyRoots` (`session-tools-core/src/runtime/credential-deny-roots.ts`)
 * DOES list `~/.nessy` and `<configDir>/credentials.enc` — but that list is
 * enforced by the OS isolation profile, and isolation is OFF by default by
 * standing owner decision (2026-08-12/13). So in a default install the
 * request-side `deniedPaths` array is the only read-side protection there is,
 * and it was the one missing them. Two floors, one of them switched off, and the
 * gap fell exactly on our own credentials.
 *
 * ## What this file pins, and what it deliberately does NOT
 *
 * It does NOT assert the two lists are equal. `SAFE_MODE_CONFIG.deniedPaths`'
 * own docblock says they are not, and names the reason: `credentialDenyRoots`
 * denies a much wider set (browser cookie stores, the OS keychain, the whole of
 * `~/.docker`) because an OS profile can afford to, and a request-side floor
 * that refused all of it would be refusing paths a model has legitimate reason
 * to read. A totality assertion here would be a false pin — it would go red on
 * every honest widening of either side.
 *
 * What it pins is the OVERLAP the row is about: every location the host itself
 * writes a credential to must be denied by BOTH. That set is small, it is ours,
 * and it is the one place where a difference between the two lists is a defect
 * rather than a design.
 *
 * ## Two spellings that are deliberately different, and why
 *
 * - `~/.nessy` is denied WHOLE by both, and the reason is already written out
 *   and measured in `credential-deny-roots.ts`: the `dp` tool keeps
 *   `dp_auth_creds.json.bak` and `.bak2` copies of the same token beside it, so
 *   denying one filename leaves readable copies. Rotated backup names are not
 *   ours to predict.
 * - `credentials.enc` is UNPREFIXED in `deniedPaths` — a double-star, a slash,
 *   then the filename —
 *   while `credentialDenyRoots` writes it as `join(configDir, …)`. That is not
 *   drift: the config dir is relocatable through `NESSY_CONFIG_DIR`, and
 *   `credentialDenyRoots` is a FUNCTION that receives it while `deniedPaths` is
 *   a static array that cannot. Anchoring the glob at `~` would protect the
 *   default install and leave every relocated one open — the same asymmetry
 *   the unprefixed npmrc entry was corrected for on 2026-08-28. (Both spellings
 *   are written out in words here because a star followed by a slash inside a
 *   block comment CLOSES it — AGENTS.md § Traps.)
 *
 * SAFETY: every path here is DATA handed to a glob matcher. Nothing in this file
 * opens, creates, deletes or executes anything, and no real credential value
 * appears in it.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialDenyRoots } from '@nessy-agent/session-tools-core';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { PERMISSION_MODE_ORDER } from '../mode-types.ts';
import { getNessyDir, NESSY_HOME_ENV } from '../../auth/dp/creds-store.ts';

// Same value and reason as `credential-read-floor.test.ts`.
setDefaultTimeout(30_000);

const HOME = homedir();
/** Where an ordinary install keeps it. */
const DEFAULT_CONFIG_DIR = join(HOME, '.nessy-agent');
/** And where `NESSY_CONFIG_DIR` can move it, which is the harder case. */
const RELOCATED_CONFIG_DIR = '/tmp/nessy-relocated-config-dir';

function isRefused(path: string): boolean {
  const result = shouldAllowToolInMode('Read', { file_path: path }, 'default');
  return result.allowed === false && result.denyPathBlocked === true;
}

/**
 * Every location the HOST ITSELF writes a credential to. Each entry names the
 * writer, so a future reader can check the list against the code rather than
 * against this comment.
 */
const OUR_OWN_CREDENTIAL_FILES: ReadonlyArray<readonly [
  label: string,
  path: string,
  // The config dir the SANDBOX floor is built with for this case. It is a
  // parameter of `credentialDenyRoots` and not of `deniedPaths`, which is the
  // whole reason the two spell `credentials.enc` differently — so each case has
  // to name the one it is about rather than share a single value.
  configDir: string,
]> = [
  // `auth/dp/` — the ONLY writer of this file, shared with nessy-cli.
  ['the gateway JWT', join(HOME, '.nessy', 'dp_auth_creds.json'), DEFAULT_CONFIG_DIR],
  // Not written by us, and that is the point: `dp` leaves these beside it.
  ['a sibling backup of the same JWT', join(HOME, '.nessy', 'dp_auth_creds.json.bak'), DEFAULT_CONFIG_DIR],
  ['a second sibling backup', join(HOME, '.nessy', 'dp_auth_creds.json.bak2'), DEFAULT_CONFIG_DIR],
  ['nessy-cli oauth creds in the same directory', join(HOME, '.nessy', 'oauth_creds.json'), DEFAULT_CONFIG_DIR],
  // `credentials/backends/secure-storage.ts`.
  ['the encrypted store, default location', join(DEFAULT_CONFIG_DIR, 'credentials.enc'), DEFAULT_CONFIG_DIR],
  ['the encrypted store, relocated config dir', join(RELOCATED_CONFIG_DIR, 'credentials.enc'), RELOCATED_CONFIG_DIR],
];

/**
 * Must stay READABLE. `~/.nessy-agent` is the app's config directory and it also
 * holds `skills/`, `plugins/`, `agents/`, `output-styles/` and `docs/` — content
 * a model has every reason to read. The first draft of this row proposed denying
 * `~/.nessy-agent/**` wholesale; these cases are why it does not, and they are
 * the boundary a later "tighten it" would cross without noticing.
 */
const MUST_STAY_OPEN: ReadonlyArray<readonly [label: string, path: string]> = [
  ['an installed skill', join(HOME, '.nessy-agent', 'skills', 'demo', 'SKILL.md')],
  ['an installed plugin manifest', join(HOME, '.nessy-agent', 'plugins', 'demo', 'plugin.json')],
  ['a subagent definition', join(HOME, '.nessy-agent', 'agents', 'reviewer.md')],
  ['the permissions file the operator edits', join(HOME, '.nessy-agent', 'permissions', 'default.json')],
  ['a release note', join(HOME, '.nessy-agent', 'release-notes', '1.0.2.md')],
  ['an ordinary project file', '/tmp/nessy-parity-project/src/index.ts'],
  ['a directory one letter off', join(HOME, '.nessyx', 'notes.txt')],
  ['a file whose name only starts like the store', '/tmp/nessy-parity-project/credentials.encoded'],
];

describe('the two credential floors agree about the host\'s own credentials (P6.674)', () => {
  describe.each(OUR_OWN_CREDENTIAL_FILES)('%s', (_label, path, configDir) => {
    it('is refused by the request-side floor', () => {
      expect(isRefused(path)).toBe(true);
    });

    it('is denied by the sandbox floor too', () => {
      // The other half of the pin. Together these two cases are what makes a
      // one-sided widening impossible: adding a credential location to either
      // list without the other turns one of them red.
      const roots = credentialDenyRoots(HOME, configDir, 'darwin');
      expect(roots.some((root) => path === root || path.startsWith(`${root}/`))).toBe(true);
    });
  });

  describe.each(MUST_STAY_OPEN)('%s stays readable', (_label, path) => {
    it('is not refused', () => {
      // Without these, "our credentials are denied" is also satisfied by a floor
      // that refuses the whole config directory — which would take the skills,
      // plugins and subagents with it.
      expect(isRefused(path)).toBe(false);
    });
  });

  it('holds in every mode, and the positive control still fires', () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      const jwt = shouldAllowToolInMode(
        'Read',
        { file_path: join(HOME, '.nessy', 'dp_auth_creds.json') },
        mode,
      );
      expect(jwt.allowed).toBe(false);
      // The control that says the run is a verdict rather than a floor that
      // refuses everything: an ordinary file, same tool, same mode.
      const ordinary = shouldAllowToolInMode(
        'Read',
        { file_path: '/tmp/nessy-parity-project/README.md' },
        mode,
      );
      expect(ordinary.allowed === false && ordinary.denyPathBlocked === true).toBe(false);
    }
  });

  it('reaches the JWT through the shell spellings P6.673 taught it to read', () => {
    // The two rows are one hole seen twice: a floor that covers the file is
    // useless if the command that reads it is spelled with a variable, and an
    // expansion that resolves the variable is useless if the file is in no
    // floor. Both halves, one case.
    for (const command of [
      'cat $HOME/.nessy/dp_auth_creds.json',
      'cat "$HOME"/.nessy/dp_auth_creds.json',
      'cat ${HOME}/.nessy/dp_auth_creds.json',
      'cat ~/.nessy/dp_auth_creds.json',
    ]) {
      const result = shouldAllowToolInMode('Bash', { command }, 'default');
      expect(result.allowed === false && result.denyPathBlocked === true).toBe(true);
    }
  });
});

/**
 * DA1.5 — the same pin, for a nessy directory that `NESSY_HOME` has MOVED.
 *
 * Honouring nessy-cli's own variable without teaching the floors about it would
 * make it a switch that takes the gateway JWT out of every read-side
 * protection, so the store and both floors are asserted together: what
 * `getNessyDir` returns is what each floor covers. Every path is under a temp
 * dir and nothing here opens a file; `HOME` is never touched.
 */
describe('a relocated nessy directory is covered by BOTH floors (DA1.5)', () => {
  let relocated: string;
  const savedNessyHome = process.env[NESSY_HOME_ENV];

  beforeAll(() => {
    // `realpathSync` because the request-side comparison resolves symlinks, and
    // `/var` is a link to `/private/var` on darwin.
    relocated = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-relocated-home-')));
    // delete-then-assign, and the restore takes the same shape (AGENTS.md § Traps).
    delete process.env[NESSY_HOME_ENV];
    process.env[NESSY_HOME_ENV] = relocated;
  });

  afterAll(() => {
    delete process.env[NESSY_HOME_ENV];
    if (savedNessyHome !== undefined) process.env[NESSY_HOME_ENV] = savedNessyHome;
    rmSync(relocated, { recursive: true, force: true });
  });

  it('the store moves, and both floors move with it', () => {
    // The store. If this drifts from the two assertions below, the variable has
    // become the hole this case exists to prevent.
    expect(getNessyDir()).toBe(relocated);

    for (const name of ['dp_auth_creds.json', 'dp_auth_creds.json.bak', 'oauth_creds.json']) {
      const path = join(relocated, name);
      // Request-side floor — the one that matters, because isolation is off by
      // default. A `~`-anchored glob cannot reach this path at all.
      expect(isRefused(path), path).toBe(true);
      // Sandbox floor.
      const roots = credentialDenyRoots(HOME, DEFAULT_CONFIG_DIR, 'darwin');
      expect(roots.some((root) => path === root || path.startsWith(`${root}/`)), path).toBe(true);
    }
  });

  it('the refusal names the variable that moved the directory', () => {
    const decision = shouldAllowToolInMode(
      'Read',
      { file_path: join(relocated, 'dp_auth_creds.json') },
      'default',
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toContain(`$${NESSY_HOME_ENV}`);
  });

  it('ADDS the relocated root — the default directory stays denied in both', () => {
    // The boundary: a value set mid-session must not un-deny the directory the
    // session has been writing to, so neither floor substitutes.
    const defaultJwt = join(HOME, '.nessy', 'dp_auth_creds.json');
    expect(isRefused(defaultJwt)).toBe(true);
    expect(credentialDenyRoots(HOME, DEFAULT_CONFIG_DIR, 'darwin')).toContain(join(HOME, '.nessy'));
  });

  it('an ordinary file under the relocated tree is still readable — the control', () => {
    // Without this, "the relocated credential is refused" would also be
    // satisfied by a floor that refuses the whole temp directory.
    expect(isRefused(join(tmpdir(), 'nessy-parity-not-a-credential.txt'))).toBe(false);
  });
});

describe('a NESSY_HOME value that is not absolute moves nothing (DA1.5)', () => {
  const savedNessyHome = process.env[NESSY_HOME_ENV];

  afterAll(() => {
    delete process.env[NESSY_HOME_ENV];
    if (savedNessyHome !== undefined) process.env[NESSY_HOME_ENV] = savedNessyHome;
  });

  it('leaves the store at the default and adds no root to either floor', () => {
    // The stated divergence from nessy-cli, asserted on all three resolvers at
    // once: a relative or tilde value is IGNORED rather than expanded, so the
    // store cannot end up somewhere a floor did not follow.
    for (const value of ['relative/nessy', '~/custom-nessy', '~']) {
      delete process.env[NESSY_HOME_ENV];
      process.env[NESSY_HOME_ENV] = value;
      expect(getNessyDir(), value).toBe(join(HOME, '.nessy'));
      const roots = credentialDenyRoots(HOME, DEFAULT_CONFIG_DIR, 'darwin');
      expect(roots.filter((root) => root.includes('custom-nessy') || root.includes('relative')), value)
        .toEqual([]);
      // …and the default is still covered, so "nothing moved" is not "nothing
      // is denied".
      expect(isRefused(join(HOME, '.nessy', 'dp_auth_creds.json')), value).toBe(true);
    }
  });
});

/**
 * F1.1057 (owner decision 2026-09-28) — codex runs with its OWN sandbox defaults, so the
 * floor above is NOT handed to codex any more: `CodexAgent.credentialFloorPatterns` reads
 * `deniedPathsBeyondShippedFloor`, which leaves the shipped entries out BY LAYER. Pi and
 * Claude Code keep reading `deniedPaths`, so the floor this file pins is unchanged there.
 */
describe('F1.1057 — the shipped floor stays host-side; only a user or operator entry reaches codex', () => {
  const merged = async (layers: Array<{ content: string; scope: 'global' | 'workspace' | 'builtin' }>) => {
    const { permissionsConfigCache } = await import('../permissions-config.ts');
    const { PermissionManager } = await import('../core/permission-manager.ts');
    const manager = new PermissionManager({ workspaceRootPath: tmpdir() } as never);
    manager.setCapabilityPermissionLayers(layers, 'gen-f1057', true);
    return permissionsConfigCache.getMergedConfig(manager.getCapabilityPermissionsContext()!);
  };

  it('the shipped entries (seed and app default file) stay in deniedPaths and never reach codex\'s list', async () => {
    const { SAFE_MODE_CONFIG } = await import('../mode-types.ts');
    const shipped = SAFE_MODE_CONFIG.deniedPaths!;
    const config = await merged([{ content: JSON.stringify({ deniedPaths: shipped }), scope: 'global' }]);
    expect(config.deniedPaths).toEqual(expect.arrayContaining(['~/.nessy/**', '**/credentials.enc', '~/.ssh/**']));
    expect(config.deniedPathsBeyondShippedFloor ?? []).toEqual([]);
  });

  it('a user\'s own entry lands, even spelled exactly like a shipped one, and so does an addition to the app default file', async () => {
    const config = await merged([
      { content: JSON.stringify({ deniedPaths: ['~/.ssh/**', '/srv/f1057-app/**'] }), scope: 'global' },
      { content: JSON.stringify({ deniedPaths: ['~/.ssh/**', '/srv/f1057-ws/**'] }), scope: 'workspace' },
      { content: JSON.stringify({ deniedPaths: ['~/.aws/**'] }), scope: 'builtin' },
    ]);
    // The global file's `~/.ssh/**` is the shipped line; the workspace's identical one is the user's.
    expect([...(config.deniedPathsBeyondShippedFloor ?? [])].sort())
      .toEqual(['/srv/f1057-app/**', '/srv/f1057-ws/**', '~/.aws/**', '~/.ssh/**']);
  });
});
