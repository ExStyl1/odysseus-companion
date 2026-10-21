/**
 * D10 — what a sandboxed command can actually READ under the shipped default.
 *
 * `sandboxing.md:312` — "**Default read behavior**: read access to the entire
 * computer, except certain denied directories. Note that this default still
 * allows reading credential files such as `~/.aws/credentials` and `~/.ssh/`."
 * That is our posture too, so the credential floor is the only protection those
 * files have, and a floor of four entries left the rest readable: the probe below
 * found 19 of 22 enumerated locations readable before this change.
 *
 * The probe runs against a FAKE home tree built in a temp directory and points
 * the floor at it. It never reads the developer's real credentials, real browser
 * profile or real home directory, and it never prints file content: the only
 * observation is the child's exit status. `networked` is the profile under test
 * because it is the shipped default for the foreground shell — the one case where
 * a read and an outbound connection are available to the same command.
 */

import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { credentialDenyRoots, credentialDenyWriteRoots } from '@nessy-agent/session-tools-core'
import { resolveProcessIsolation } from './isolation.ts'

/** Nothing in these fixtures resembles a credential; only the PATH is realistic. */
const FIXTURE_BODY = 'probe-fixture-not-a-secret\n'

/**
 * One row per credential location the enumeration found, with the documentation
 * that named it recorded beside the entry in `credential-deny-roots.ts`. Kept as
 * data so a new location is one line and the probe covers it.
 */
const PORTABLE_FIXTURES: readonly string[] = [
  '.ssh/id_ed25519',
  '.aws/credentials',
  '.aws/sso/cache/token.json',
  '.nessy/dp_auth_creds.json',
  '.netrc',
  '_netrc',
  '.docker/config.json',
  '.docker/contexts/meta/x/meta.json',
  '.git-credentials',
  '.config/git/credentials',
  '.npmrc',
  '.pypirc',
  '.kube/config',
  '.gnupg/private-keys-v1.d/key.key',
  '.config/gh/hosts.yml',
  '.config/gcloud/credentials.db',
  '.azure/msal_token_cache.json',
]

const DARWIN_FIXTURES: readonly string[] = [
  'Library/Keychains/login.keychain-db',
  'Library/Cookies/Cookies.binarycookies',
  'Library/Safari/History.db',
  'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies',
  'Library/Application Support/Google/Chrome/Default/Cookies',
  'Library/Application Support/Google/Chrome/Default/Login Data',
  'Library/Application Support/Google/Chrome Canary/Default/Cookies',
  'Library/Application Support/Chromium/Default/Cookies',
  'Library/Application Support/Microsoft Edge/Default/Cookies',
  'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies',
  'Library/Application Support/Arc/User Data/Default/Cookies',
  'Library/Application Support/Vivaldi/Default/Cookies',
  'Library/Application Support/com.operasoftware.Opera/Cookies',
  'Library/Application Support/Firefox/Profiles/a.default/logins.json',
]

/**
 * The two backends this probe cannot spawn on are covered by string comparison
 * against the same constant, which is all a darwin host can prove about them.
 */
const OTHER_PLATFORM_FIXTURES: readonly { platform: NodeJS.Platform; path: string }[] = [
  { platform: 'linux', path: '.config/google-chrome/Default/Cookies' },
  { platform: 'linux', path: '.config/chromium/Default/Cookies' },
  { platform: 'linux', path: '.config/microsoft-edge/Default/Cookies' },
  { platform: 'linux', path: '.config/BraveSoftware/Brave-Browser/Default/Cookies' },
  { platform: 'linux', path: '.mozilla/firefox/a.default/logins.json' },
  { platform: 'linux', path: '.local/share/keyrings/login.keyring' },
  { platform: 'linux', path: '.pki/nssdb/key4.db' },
  { platform: 'win32', path: 'AppData/Local/Google/Chrome/User Data/Default/Cookies' },
  { platform: 'win32', path: 'AppData/Local/Microsoft/Edge/User Data/Default/Cookies' },
  { platform: 'win32', path: 'AppData/Roaming/Mozilla/Firefox/Profiles/a/logins.json' },
  { platform: 'win32', path: 'AppData/Roaming/Microsoft/Credentials/blob' },
  { platform: 'win32', path: 'AppData/Roaming/Microsoft/Protect/S-1-5-21/masterkey' },
]

/**
 * Paths that must stay READABLE. `~/.gitconfig` is the deliberate one: see
 * `credential-deny-roots.ts`. The workspace file proves the probe can observe a
 * success at all, so a refusal everywhere is not mistaken for a passing gate.
 */
const READABLE_FIXTURES: readonly string[] = ['.gitconfig', '.config/git/config']

interface Tree {
  root: string
  home: string
  configDir: string
  workspace: string
  scratch: string
}

function buildTree(): Tree {
  const root = mkdtempSync(join(tmpdir(), 'nessy-read-exposure-'))
  const home = join(root, 'home')
  const configDir = join(home, '.nessy-agent')
  const workspace = join(root, 'workspace')
  const scratch = join(root, 'scratch')
  for (const dir of [home, configDir, workspace, scratch]) mkdirSync(dir, { recursive: true })
  for (const path of [...PORTABLE_FIXTURES, ...DARWIN_FIXTURES, ...READABLE_FIXTURES]) {
    const absolute = join(home, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, FIXTURE_BODY, 'utf8')
  }
  writeFileSync(join(configDir, 'credentials.enc'), FIXTURE_BODY, 'utf8')
  writeFileSync(join(workspace, 'README.md'), FIXTURE_BODY, 'utf8')
  return { root, home, configDir, workspace, scratch }
}

function readsUnderNetworkedProfile(tree: Tree, target: string): boolean {
  const plan = resolveProcessIsolation({
    platform: 'darwin',
    profile: 'networked',
    command: '/bin/cat',
    args: [target],
    workspaceRoot: tree.workspace,
    workingDirectory: tree.workspace,
    scratchRoot: tree.scratch,
    deniedReadRoots: credentialDenyRoots(tree.home, tree.configDir, 'darwin'),
  })
  return spawnSync(plan.command, plan.args, { stdio: 'ignore' }).status === 0
}

describe('the credential floor under the networked profile', () => {
  it('refuses every enumerated credential location a darwin host can hold', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      const stillReadable = [...PORTABLE_FIXTURES, ...DARWIN_FIXTURES]
        .filter(path => readsUnderNetworkedProfile(tree, join(tree.home, path)))
      expect(stillReadable).toEqual([])
      expect(readsUnderNetworkedProfile(tree, join(tree.configDir, 'credentials.enc'))).toBe(false)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // The other half of the gate: a floor that refuses everything is not a pass.
  // `git` reads its own config on every invocation, and a sandbox that breaks
  // `git` gets switched off — and then it protects nothing.
  it('keeps git config readable and keeps the workspace readable', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      const refusedButNeeded = READABLE_FIXTURES
        .filter(path => !readsUnderNetworkedProfile(tree, join(tree.home, path)))
      expect(refusedButNeeded).toEqual([])
      expect(readsUnderNetworkedProfile(tree, join(tree.workspace, 'README.md'))).toBe(true)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // A read deny already implies a write deny on every backend. This covers the
  // path that must stay READABLE and must not be WRITABLE: a `~/.gitconfig` a
  // sandboxed command can rewrite is code execution on the next `git`
  // invocation (`core.pager`, `alias.x = !cmd`, `credential.helper = !cmd`).
  it('denies writes to the git config it deliberately leaves readable', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      const gitconfig = join(tree.home, '.gitconfig')
      const plan = resolveProcessIsolation({
        platform: 'darwin',
        profile: 'networked',
        command: '/bin/sh',
        args: ['-c', `printf x >> ${JSON.stringify(gitconfig)}`],
        workspaceRoot: tree.workspace,
        workingDirectory: tree.workspace,
        scratchRoot: tree.scratch,
        // The home directory is granted for write, which is the only way this
        // floor is reachable: without it `(deny file-write*)` already covers it.
        additionalWritableRoots: [tree.home],
        deniedReadRoots: credentialDenyRoots(tree.home, tree.configDir, 'darwin'),
        deniedWriteRoots: credentialDenyWriteRoots(tree.home),
      })
      expect(spawnSync(plan.command, plan.args, { stdio: 'ignore' }).status).not.toBe(0)
      expect(readsUnderNetworkedProfile(tree, gitconfig)).toBe(true)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // And the funnel composes it for the host's OWN home without being asked, so
  // the deny does not depend on a caller remembering to pass it. Asserted on the
  // rendered profile because the real home directory is never probed.
  it('composes the host git-config write deny in the isolation funnel', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      const plan = resolveProcessIsolation({
        platform: 'darwin',
        profile: 'networked',
        command: '/bin/true',
        args: [],
        workspaceRoot: tree.workspace,
        workingDirectory: tree.workspace,
        scratchRoot: tree.scratch,
      })
      const profile = plan.args[1] ?? ''
      for (const root of credentialDenyWriteRoots(homedir())) {
        expect(profile).toContain(`(deny file-write* (subpath "${root}"))`)
        expect(profile).not.toContain(`(deny file-read* (subpath "${root}"))`)
      }
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // linux and win32 cannot be spawned from here; the floor they compose can
  // still be asserted, and a missing entry is the whole defect.
  it('names the linux and win32 credential stores in the same constant', () => {
    for (const { platform, path } of OTHER_PLATFORM_FIXTURES) {
      const roots = credentialDenyRoots('/home/x', '/home/x/.nessy-agent', platform)
      const covered = roots.some(root => join('/home/x', path).startsWith(root))
      expect({ platform, path, covered }).toEqual({ platform, path, covered: true })
    }
  })
})
