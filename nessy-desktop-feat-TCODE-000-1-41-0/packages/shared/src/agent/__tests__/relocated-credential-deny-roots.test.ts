/**
 * P6.678 — the request-side floor and a RELOCATED credential directory.
 *
 * `SAFE_MODE_CONFIG.deniedPaths` is a static array of `~`-anchored globs; the
 * sandbox floor is a FUNCTION, `credentialDenyRoots(homeDir, configDir)`. The
 * gap between the two shapes is a real hole, because isolation is off by
 * default (standing owner decision 2026-08-12/13) and the request-side gate is
 * therefore the only read-side credential protection a default install has.
 *
 * `deniedPaths`' own comment already recorded the residue: *"`$GH_CONFIG_DIR`,
 * `$GLAB_CONFIG_DIR`, a relocated `$XDG_CONFIG_HOME` and `$XDG_CONFIG_DIRS` are
 * unreachable from a `~`-anchored glob, so a host that relocates either CLI's
 * config keeps a readable token."*
 *
 * Every path here is under a temp dir. `HOME` is never touched and no real home
 * is named — the roots are handed to `relocatedCredentialDenyRoots` as an
 * explicit env map, and the end-to-end assertions use absolute temp paths that
 * no `~`-anchored entry can match, so a pass cannot be borrowed from the
 * shipped globs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relocatedCredentialDenyRoots, shouldAllowToolInMode } from '../mode-manager.ts';

let sandbox: string;
let ghDir: string;
let glabDir: string;
let xdgHome: string;
let xdgDirsEntry: string;
let configDir: string;
let nessyHome: string;
let ordinary: string;
const ENV_NAMES = ['NESSY_CONFIG_DIR', 'NESSY_HOME', 'GH_CONFIG_DIR', 'GLAB_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS'] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(
  ENV_NAMES.map(name => [name, process.env[name]]),
);

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-relocated-creds-')));
  ghDir = join(sandbox, 'opt', 'gh-config');
  glabDir = join(sandbox, 'opt', 'glab-config');
  xdgHome = join(sandbox, 'opt', 'xdg');
  xdgDirsEntry = join(sandbox, 'opt', 'xdg-system');
  configDir = join(sandbox, 'opt', 'nessy-config');
  // DA1.5 — the directory `NESSY_HOME` moves `~/.nessy` to.
  nessyHome = join(sandbox, 'opt', 'nessy-home');
  ordinary = join(sandbox, 'project');
  for (const dir of [
    ghDir,
    glabDir,
    join(xdgHome, 'gh'),
    join(xdgHome, 'glab-cli'),
    join(xdgDirsEntry, 'glab-cli'),
    configDir,
    nessyHome,
    ordinary,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(ordinary, 'notes.md'), 'not a secret');
  // DELETE THEN ASSIGN — AGENTS.md § Traps: assigning to `process.env.X` in
  // Bun 1.3.14 can leave the name readable by property and invisible to
  // enumeration, and the `delete` is unconditional because a list of the
  // affected names cannot be complete. The restore path takes the same shape.
  for (const [name, value] of Object.entries(env())) {
    delete process.env[name];
    if (value !== undefined) process.env[name] = value;
  }
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    delete process.env[name];
    if (value !== undefined) process.env[name] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

/** The env map the roots are derived from. Never `process.env` in this file. */
function env(): Record<string, string | undefined> {
  return {
    NESSY_CONFIG_DIR: configDir,
    NESSY_HOME: nessyHome,
    GH_CONFIG_DIR: ghDir,
    GLAB_CONFIG_DIR: glabDir,
    XDG_CONFIG_HOME: xdgHome,
    XDG_CONFIG_DIRS: `${xdgDirsEntry}:${join(sandbox, 'opt', 'xdg-system-2')}`,
  };
}

describe('relocatedCredentialDenyRoots', () => {
  it('takes its roots from the environment the way credentialDenyRoots takes configDir', () => {
    const roots = relocatedCredentialDenyRoots(env());
    const byOrigin = roots.map(entry => `${entry.origin}:${entry.root}`);
    expect(byOrigin).toContain(`NESSY_CONFIG_DIR:${join(configDir, 'credentials.enc')}`);
    expect(byOrigin).toContain(`NESSY_CONFIG_DIR:${join(configDir, 'dp_auth_creds.json')}`);
    // DA1.5 · the WHOLE relocated nessy directory, not one filename inside it:
    // `dp` leaves `.bak` / `.bak2` copies of the same token beside it and the
    // nessy-cli seed `oauth_creds.json` lives there too.
    expect(byOrigin).toContain(`NESSY_HOME:${nessyHome}`);
    // `$GH_CONFIG_DIR` IS gh's directory (`cli/go-gh/pkg/config/config.go`
    // precedence: "GH_CONFIG_DIR, XDG_CONFIG_HOME, AppData (windows only),
    // HOME"), while `$XDG_CONFIG_HOME` is its PARENT — so the two are joined
    // differently, and getting that backwards would deny the wrong directory.
    expect(byOrigin).toContain(`GH_CONFIG_DIR:${ghDir}`);
    expect(byOrigin).toContain(`XDG_CONFIG_HOME:${join(xdgHome, 'gh')}`);
    expect(byOrigin).toContain(`GLAB_CONFIG_DIR:${glabDir}`);
    expect(byOrigin).toContain(`XDG_CONFIG_HOME:${join(xdgHome, 'glab-cli')}`);
    // Every entry of the colon-separated search path, not just the first.
    expect(byOrigin).toContain(`XDG_CONFIG_DIRS:${join(xdgDirsEntry, 'glab-cli')}`);
    expect(byOrigin).toContain(`XDG_CONFIG_DIRS:${join(sandbox, 'opt', 'xdg-system-2', 'glab-cli')}`);
  });

  it('yields nothing for an empty, blank or RELATIVE value', () => {
    // `process.cwd()` in this package is the app's own directory, not the
    // session's, so resolving a relative value would deny a path nobody meant
    // and leave the real directory open.
    expect(relocatedCredentialDenyRoots({})).toEqual([]);
    expect(relocatedCredentialDenyRoots({ GH_CONFIG_DIR: '   ', GLAB_CONFIG_DIR: '' })).toEqual([]);
    expect(relocatedCredentialDenyRoots({ GH_CONFIG_DIR: './gh', XDG_CONFIG_DIRS: 'a:b' })).toEqual([]);
    // DA1.5 · and that rule is exactly `getNessyDir`'s whole rule, which is why
    // the store and this floor can resolve the same variable identically with
    // no shared code across the package boundary between them.
    expect(relocatedCredentialDenyRoots({ NESSY_HOME: '~/custom-nessy' })).toEqual([]);
    expect(relocatedCredentialDenyRoots({ NESSY_HOME: 'relative/nessy' })).toEqual([]);
  });
});

describe('the request-side gate refuses a relocated credential directory', () => {
  function read(path: string) {
    return shouldAllowToolInMode('Read', { file_path: path }, 'default');
  }

  it('refuses a token under a relocated gh, glab or XDG directory, naming the variable', () => {
    // Driven through the production gate rather than the matcher, so a root
    // that never reaches `getDeniedPathViolation` cannot pass this. Every path
    // here was ALLOWED at HEAD, measured 2026-09-07 with a fake HOME and these
    // same variables under a temp dir.
    const secrets: Array<[string, string]> = [
      [join(ghDir, 'hosts.yml'), 'GH_CONFIG_DIR'],
      [join(glabDir, 'config.yml'), 'GLAB_CONFIG_DIR'],
      [join(xdgHome, 'gh', 'hosts.yml'), 'XDG_CONFIG_HOME'],
      [join(xdgHome, 'glab-cli', 'config.yml'), 'XDG_CONFIG_HOME'],
      [join(xdgDirsEntry, 'glab-cli', 'config.yml'), 'XDG_CONFIG_DIRS'],
      [join(configDir, 'dp_auth_creds.json'), 'NESSY_CONFIG_DIR'],
      [join(nessyHome, 'dp_auth_creds.json'), 'NESSY_HOME'],
      [join(nessyHome, 'dp_auth_creds.json.bak'), 'NESSY_HOME'],
      [join(nessyHome, 'oauth_creds.json'), 'NESSY_HOME'],
    ];
    for (const [secret, origin] of secrets) {
      const decision = read(secret);
      expect(decision.allowed, secret).toBe(false);
      if (decision.allowed) throw new Error(`unreachable: ${secret}`);
      // The refusal names the VARIABLE that moved the directory. A user told
      // "matched deniedPaths pattern `~/.config/gh/**`" for a file under
      // `/opt/gh-config` would go looking for a rule that did not fire.
      expect(decision.reason, secret).toContain(`$${origin}`);
    }
  });

  it('leaves the GLOB refusal alone where a shipped pattern already reaches', () => {
    // Order matters and is asserted rather than assumed: the relocated roots are
    // consulted AFTER the globs, so `<config dir>/credentials.enc` — already
    // covered by the unprefixed shipped entry — keeps naming the operator's own
    // pattern instead of an environment variable.
    const decision = read(join(configDir, 'credentials.enc'));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toContain('credentials.enc');
    expect(decision.reason).not.toContain('$NESSY_CONFIG_DIR');
  });

  it('still allows an ordinary file under the same temp tree — the negative control', () => {
    // Without this the assertions above would pass for a gate that denied
    // everything inside the sandbox.
    expect(read(join(ordinary, 'notes.md')).allowed).toBe(true);
  });

  it('the DEFAULT location still refuses, so the widening did not replace the globs', () => {
    // The control the row asks for: `credentials.enc` is denied by the
    // unprefixed shipped glob wherever it sits, relocation or not.
    expect(read(join(sandbox, 'anywhere', 'credentials.enc')).allowed).toBe(false);
  });
});
