/**
 * The read-side credential floor: what an agent's file tools may never open.
 *
 * ## The contract
 *
 * `agent-sdk/secure-deployment.md#read-only-code-mounting` carries a ten-row
 * table headed "Even read-only access to a code directory can expose
 * credentials. Common files to exclude or sanitize before mounting". Every row
 * of it is a case below. Note how the page SPELLS them — `~/` on the tool-owned
 * dotfiles, and NO prefix on `.npmrc`, `.pypirc`, `*-service-account.json`,
 * `*.pem`, `*.key`. The unprefixed rows are the ones that turn up inside a
 * repository, so an entry anchored at `~` protects the copy nobody checks in
 * and leaves the copy that gets mounted.
 *
 * ## What was MEASURED at HEAD before this file existed (2026-08-28)
 *
 * Through the real `shouldAllowToolInMode`, tool `Read`, mode `default`:
 *   DENIED (positive controls) `~/.ssh/id_rsa`, `~/.aws/credentials`,
 *     `<proj>/.env`, `~/.npmrc`
 *   open   (negative controls) `<proj>/src/index.ts`, `<proj>/README.md`
 *   open   (THE DEFECT)        `~/.git-credentials`,
 *     `~/.config/git/credentials`, `~/.azure/msal_token_cache.json`,
 *     `~/.pypirc`, `<proj>/.pypirc`, `<proj>/gcp-service-account.json`,
 *     `<proj>/.npmrc`
 * Identical on tool `Edit`. Every "THE DEFECT" line is an assertion below that
 * fails against the pre-fix list, and the negative controls exist so that "it
 * passes" is not also satisfied by a floor that refuses everything.
 *
 * ## The two copies
 *
 * The list exists TWICE — `SAFE_MODE_CONFIG.deniedPaths` in `mode-types.ts` is
 * the fallback for a missing or corrupt file, and
 * `apps/electron/resources/permissions/default.json` is what a real install
 * reads. A pattern added to only one of them protects only half the installs,
 * so the parity of the two is pinned here rather than left to review.
 *
 * ## THE EVIDENCE FOR THIS FLOOR IS DARWIN-ONLY (P3.129, owner ruling 2026-09-01)
 *
 * Read this before quoting a green run here as "the credential floor holds".
 * It holds **on darwin**. No probe of it has ever executed on Windows, on any
 * runtime, and the deferral is a DECISION rather than an oversight: the owner
 * deferred a real Windows exercise until a Windows build actually ships, and
 * asked for the posture to be written down so the next reader does not conclude
 * we checked.
 *
 * The reason it matters here rather than in a release note is that **on darwin
 * the broken path is the IDENTITY FUNCTION.** Two shipped security defects were
 * invisible for exactly that reason: a directory deny that never matched its own
 * directory (P3.104 — the block right below this one) and ten credential entries
 * inert under a Windows home (P3.108). Both were found by reading, not by a
 * green suite, because every probe in this file resolves `~` through
 * `os.homedir()` and joins with `/`, so a separator or home-shape bug cannot
 * change any assertion above. `denied-path-windows-separators.test.ts` covers
 * the separator GRAMMAR as data; it is not a Windows run.
 * `P3.62` records the same blind spot on codex (darwin-arm64 only, win32 never
 * executed), so this is a host-wide gap, not a Pi-only one.
 *
 * A CDP case cannot discharge it either: the live checklist has no Windows case
 * and the driver runs on darwin. **A green checklist means nothing here.**
 *
 * THE PROBE IS DEFINED NOW, so shipping Windows is not also designing the test.
 * On a real Windows build, in mode `default`, attempt to reach `~/.ssh` and
 * `~/.aws` through all THREE read-shaped tools — `Read`, `Grep`, `Glob` — and
 * confirm all three refuse, with a negative control (`~/.ssh-backup`, a
 * neighbour that must stay open) proving the run is not a floor that refuses
 * everything. Three tools rather than one because P3.104's defect was
 * `Grep`/`Glob`-shaped while `Read` was already correct: a one-tool probe would
 * have passed against it. Whether that becomes a standing pre-release step is
 * an open call; on current evidence the answer is yes.
 *
 * SAFETY: every path here is DATA handed to a glob matcher. Nothing in this
 * file opens, creates or deletes a file.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { SAFE_MODE_CONFIG, PERMISSION_MODE_ORDER, type PermissionMode } from '../mode-types.ts';

// Same value and reason as `mode-gate.test.ts`: this suite stays on the file
// tools, but `shouldAllowToolInMode` is a heavy import and bun's 5s default sits
// close to its resting cost on a cold module graph.
setDefaultTimeout(30_000);

const HOME = homedir();
const PROJECT = '/tmp/nessy-credential-floor-project';
const home = (...parts: string[]): string => join(HOME, ...parts);
const proj = (...parts: string[]): string => join(PROJECT, ...parts);

/** Read-blocked, with the `secure-deployment.md` row each one answers. */
const MUST_BE_DENIED: ReadonlyArray<readonly [label: string, path: string]> = [
  // `.env`, `.env.local` — API keys, database passwords, secrets
  ['.env in the project', proj('.env')],
  ['.env.local in the project', proj('.env.local')],
  // `~/.git-credentials` — Git passwords/tokens in plaintext
  ['git credential store', home('.git-credentials')],
  // …and the second location git-credential-store(1) names for the SAME file.
  // Not on the page; denying only the first leaves a readable copy of the same
  // token, which is a bypass rather than a gap.
  ['git credential store, XDG location', home('.config', 'git', 'credentials')],
  // `~/.aws/credentials` — AWS access keys
  ['aws credentials', home('.aws', 'credentials')],
  // `~/.config/gcloud/application_default_credentials.json` — GCP ADC tokens
  ['gcloud ADC', home('.config', 'gcloud', 'application_default_credentials.json')],
  // `~/.azure/` — Azure CLI credentials
  ['azure cli token cache', home('.azure', 'msal_token_cache.json')],
  // `~/.docker/config.json` — Docker registry auth tokens
  ['docker registry auth', home('.docker', 'config.json')],
  // `~/.kube/config` — Kubernetes cluster credentials
  ['kubeconfig', home('.kube', 'config')],
  // `.npmrc`, `.pypirc` — package registry tokens. BOTH scopes, because the
  // page writes them unprefixed and a project `.npmrc` is where a CI token
  // actually sits.
  ['npmrc in the home directory', home('.npmrc')],
  ['npmrc in the project', proj('.npmrc')],
  ['npmrc in a nested package', proj('packages', 'thing', '.npmrc')],
  ['pypirc in the home directory', home('.pypirc')],
  ['pypirc in the project', proj('.pypirc')],
  // `*-service-account.json` — GCP service account keys
  ['gcp service account key', proj('gcp-service-account.json')],
  ['gcp service account key, nested', proj('infra', 'deploy-service-account.json')],
  // `*.pem`, `*.key` — private keys
  ['pem private key', proj('certs', 'server.pem')],
  ['key private key', proj('certs', 'server.key')],
  // Not on the page, already shipped, kept as regression cover for the rows the
  // pre-fix list already had.
  ['ssh private key', home('.ssh', 'id_rsa')],
  ['gnupg keyring', home('.gnupg', 'secring.gpg')],
  ['netrc', home('.netrc')],
  // The forge CLIs' token stores (P6.197). Not on the page — read from each
  // CLI's own source, which is what read-don't-invent orders above a page for a
  // path resolved through a precedence chain.
  ['gh forge token store', home('.config', 'gh', 'hosts.yml')],
  ['gh forge config beside it', home('.config', 'gh', 'config.yml')],
  ['glab forge token store', home('.config', 'glab-cli', 'config.yml')],
  // The one that is not in `$HOME`: glab reads `<git dir>/glab-cli/config.yml`
  // too, so the token sits inside the workspace already being read.
  ['glab repo-local token store', proj('.git', 'glab-cli', 'config.yml')],
  ['glab repo-local store in a nested checkout', proj('vendor', 'dep', '.git', 'glab-cli', 'config.yml')],
];

/**
 * Must stay readable. Each is one letter away from a denied pattern, which is
 * the shape an over-broad glob gets wrong.
 */
const MUST_STAY_READABLE: ReadonlyArray<readonly [label: string, path: string]> = [
  ['ordinary source file', proj('src', 'index.ts')],
  ['ordinary manifest', proj('package.json')],
  ['prose that merely mentions the word', proj('docs', 'service-account-setup.md')],
  ['a json file whose name only ENDS in the word', proj('service-account.json.md')],
  ['npmrc without the leading dot', proj('npmrc')],
  ['a file whose extension only starts like pem', proj('notes.pem.txt')],
  ['env in the name but not the file', proj('src', 'environment.ts')],
  ['this repo\'s own agent guide', proj('AGENTS.md')],
  // Near-misses for the three entries P6.197 added. The `.git` one is the load
  // bearing control: `**/.git/glab-cli/**` must not become a deny on `.git`.
  ['ordinary git metadata beside the glab store', proj('.git', 'config')],
  ['prose whose name only starts like the glab store', proj('docs', 'glab-cli-setup.md')],
  ['a gh-named source file', proj('src', 'gh.ts')],
];

function readDenied(path: string, tool: string, mode: PermissionMode): boolean {
  const result = shouldAllowToolInMode(tool, { file_path: path }, mode);
  return result.allowed === false && result.denyPathBlocked === true;
}

describe('the documented credential files are denied to the file tools', () => {
  // Read AND Edit: the floor's own docstring says "must not be read or written",
  // and a list that only covered reads would leave `Edit` able to truncate the
  // file it could not open.
  for (const tool of ['Read', 'Edit'] as const) {
    it.each(MUST_BE_DENIED)(`${tool} is denied: %s (%s)`, (_label, path) => {
      expect(readDenied(path, tool, 'default')).toBe(true);
    });
  }
});

describe('the floor does not swallow ordinary files', () => {
  for (const tool of ['Read', 'Edit'] as const) {
    it.each(MUST_STAY_READABLE)(`${tool} is allowed: %s (%s)`, (_label, path) => {
      expect(readDenied(path, tool, 'default')).toBe(false);
    });
  }
});

describe('the floor holds in every permission mode', () => {
  // `ModeConfig.deniedPaths` is documented as "File paths that must not be read
  // or written in ANY permission mode", and `getDeniedPathViolation` runs before
  // every mode branch. bypassPermissions is the row that matters: it is the mode
  // an operator reaches for when a floor is in the way.
  it.each(PERMISSION_MODE_ORDER)('denies a credential read in %s', mode => {
    expect(readDenied(home('.git-credentials'), 'Read', mode)).toBe(true);
    expect(readDenied(home('.azure', 'msal_token_cache.json'), 'Read', mode)).toBe(true);
    expect(readDenied(proj('.npmrc'), 'Read', mode)).toBe(true);
  });

  it('still allows an ordinary read in every mode', () => {
    // Negative control for the row above: a floor that denied everything would
    // satisfy it too.
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(readDenied(proj('src', 'index.ts'), 'Read', mode)).toBe(false);
    }
  });
});

describe('the two copies of the list agree', () => {
  const bundledPath = join(
    import.meta.dir,
    '..', '..', '..', '..', '..',
    'apps', 'electron', 'resources', 'permissions', 'default.json',
  );
  const bundled = JSON.parse(readFileSync(bundledPath, 'utf-8')) as {
    version: string;
    deniedPaths: string[];
  };

  it('the bundled default.json carries the same deniedPaths as the fallback', () => {
    // Order-sensitive on purpose: these are two hand-maintained copies of one
    // list, and an equality that ignored order would let a reordering hide a
    // substitution.
    expect(bundled.deniedPaths).toEqual(SAFE_MODE_CONFIG.deniedPaths ?? []);
  });

  it('the bundled version is newer than the one that shipped the pre-fix list', () => {
    // `installDefaultPermissions` migrates an existing install ONLY when
    // `bundledVersion > installedVersion` (string compare on YYYY-MM-DD). New
    // patterns added without bumping this field reach fresh installs and NO
    // existing one — a silent no-op that looks exactly like a fix.
    expect(bundled.version > '2026-07-06').toBe(true);
  });
});

/**
 * The CONTAINER half of the floor.
 *
 * Six shipped entries are `<dir>/**`-shaped (`~/.ssh/**`, `~/.gnupg/**`,
 * `~/.aws/**`, `~/.config/gcloud/**`, `~/.azure/**`, `~/.kube/**`) and the glob
 * compiler turns `X/**` into `^X/.*$` — a form that requires a slash and one
 * more character, so it never matched `X` itself. `Read` takes a file and was
 * covered; `Grep` and `Glob` take a DIRECTORY, and `getDeniedPathViolation`
 * hands their `path` argument to the same matcher. Measured at HEAD on
 * 2026-08-28, in the same run as `Read('~/.aws/credentials')` DENIED:
 *   OPEN Grep path `~/.ssh` · OPEN Grep path `~/.aws` · OPEN Bash
 *   `grep -r BEGIN ~/.ssh` · OPEN Read `~/.ssh` (the directory)
 * i.e. the search tools were handed the exact directory whose files the read
 * tool refuses, and they return matching lines.
 *
 * The documented semantics are container-inclusive.
 * `permissions.md#read-and-edit`: "**Deny and ask rules**: `Read(secrets/**)`
 * matches a directory named `secrets` at any depth under the current directory,
 * so the rule also applies to nested copies." And
 * `settings-reference.md#permissions-deny` states what that must buy: "Claude
 * Code excludes matching files from file discovery and search results, denies
 * reads of them, and blocks the Edit and Write tools on the matching paths."
 *
 * NOT closed here, and deliberately: a search rooted ABOVE a denied directory
 * (`Grep` at `$HOME`, `Glob` at `$HOME`, `grep -r` over `$HOME`) still returns
 * results from inside it. That is the "excludes … from search results" half and
 * it needs the tools to filter their OUTPUT, which is a different change.
 */
describe('a `<dir>/**` deny entry also denies the directory itself', () => {
  const containerDenied = (path: string, tool: string, input = 'path'): boolean => {
    const result = shouldAllowToolInMode(tool, { [input]: path }, 'default');
    return result.allowed === false && result.denyPathBlocked === true;
  };

  const DENIED_CONTAINERS: ReadonlyArray<readonly [label: string, path: string]> = [
    ['ssh key directory', home('.ssh')],
    ['gnupg keyring directory', home('.gnupg')],
    ['aws credential directory', home('.aws')],
    ['gcloud config directory', home('.config', 'gcloud')],
    ['azure cli directory', home('.azure')],
    ['kube config directory', home('.kube')],
  ];

  it.each(DENIED_CONTAINERS)('Grep may not be rooted at %s (%s)', (_label, path) => {
    expect(containerDenied(path, 'Grep')).toBe(true);
  });

  it.each(DENIED_CONTAINERS)('Glob may not be rooted at %s (%s)', (_label, path) => {
    expect(containerDenied(path, 'Glob')).toBe(true);
  });

  it('Read of the directory itself is denied too', () => {
    expect(containerDenied(home('.ssh'), 'Read', 'file_path')).toBe(true);
  });

  it('a shell command naming the directory is denied', () => {
    const result = shouldAllowToolInMode('Bash', { command: `grep -r BEGIN ${home('.ssh')}` }, 'default');
    expect(result.allowed === false && result.denyPathBlocked === true).toBe(true);
  });

  it('a trailing slash does not reopen it', () => {
    expect(containerDenied(`${home('.ssh')}/`, 'Grep')).toBe(true);
  });

  it('does not swallow a neighbouring directory', () => {
    // Negative controls: the container expansion is an exact match on the
    // stripped pattern, not a prefix test, so a directory that merely STARTS
    // like a denied one stays open. Without these, "it passes" is also
    // satisfied by a matcher that denies every directory.
    expect(containerDenied(home('.ssh-backup'), 'Grep')).toBe(false);
    expect(containerDenied(home('.awsx'), 'Grep')).toBe(false);
    expect(containerDenied(home('.config'), 'Grep')).toBe(false);
    expect(containerDenied(proj('src'), 'Grep')).toBe(false);
    expect(containerDenied(HOME, 'Grep')).toBe(false);
  });

  it('the expansion is reachable ONLY from the deny matcher', () => {
    // `globToRegex` is bidirectional: `matchesAllowedWritePath` is a GRANT built
    // from the same compiler, and widening `X/**` to cover `X` there would hand
    // out write access to the container directory. The expansion therefore lives
    // beside the deny matcher rather than inside the compiler, and this pins it.
    const source = readFileSync(join(import.meta.dir, '..', 'mode-manager.ts'), 'utf-8');
    const grantStart = source.indexOf('function matchesAllowedWritePath');
    expect(grantStart).toBeGreaterThan(-1);
    const grantBody = source.slice(grantStart, source.indexOf('\nfunction ', grantStart + 1));
    // Positive control for the instrument: the grant body IS being read, and it
    // does use the shared compiler.
    expect(grantBody).toContain('globToRegex');
    expect(grantBody).not.toContain('deniedContainerPattern');
  });
});
