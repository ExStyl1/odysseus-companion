/**
 * D11 — `sandbox.filesystem.allowRead`, on the one backend that can enforce it.
 *
 * `sandboxing.md:176` — "You can also deny write or read access using
 * `sandbox.filesystem.denyWrite` and `sandbox.filesystem.denyRead`, and re-allow
 * specific paths within a denied region using `sandbox.filesystem.allowRead`.
 * When read rules overlap, the more specific path wins".
 *
 * Both overlap directions from the table under that sentence are probed by
 * spawning a real command, not by comparing strings:
 *
 * - `:180` — `"denyRead": ["~/"]` with `"allowRead": ["~/projects"]` → "`~/projects`
 *   is readable and the rest of the home directory stays blocked."
 * - `:181` — `"allowRead": ["~/"]` with `"denyRead": ["~/.env"]` → "`~/.env` stays
 *   blocked and the rest of the home directory is readable. An exact deny holds
 *   inside a wider allow, so a broad allow can't silently re-expose a secret."
 *
 * And the rule this repo adds on top: the host credential floor outranks an
 * allow that names it EXACTLY, which specificity alone would not give.
 *
 * Every path here is inside a temp tree this test created. No real home
 * directory, credential file or browser profile is named, and no file content is
 * printed — the only observation is the child's exit status.
 */

import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyFilesystemIsolation } from '@nessy-agent/session-tools-core'
import { ISOLATION_UNAVAILABLE_PREFIX } from './isolation-remediation.ts'
import { resolveProcessIsolation } from './isolation.ts'

interface Tree {
  root: string
  home: string
  workspace: string
  scratch: string
}

function buildTree(files: readonly string[]): Tree {
  // Canonical, not lexical. macOS reaches its temp root through `/var` ->
  // `/private/var`, the kernel canonicalises before Seatbelt matches, and
  // `applyFilesystemIsolation` renders the path it is GIVEN — so a lexical
  // fixture path produces rules that match nothing and every read looks
  // permitted. `resolveProcessIsolation` pairs both forms for its callers;
  // a test that calls the renderer directly has to supply the real one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-read-allowlist-')))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const scratch = join(root, 'scratch')
  for (const dir of [home, workspace, scratch]) mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const absolute = join(home, file)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, 'probe-fixture-not-a-secret\n', 'utf8')
  }
  writeFileSync(join(workspace, 'README.md'), 'probe-fixture-not-a-secret\n', 'utf8')
  return { root, home, workspace, scratch }
}

/** Spawn `cat` under a profile built directly, so every root is a fixture path. */
function readsUnder(target: string, options: {
  sessionDir: string
  deniedReadRoots?: readonly string[]
  allowedReadRoots?: readonly string[]
  unconditionalDeniedReadRoots?: readonly string[]
}): boolean {
  const plan = applyFilesystemIsolation('/bin/cat', [target], options.sessionDir, {
    ...(options.deniedReadRoots ? { deniedReadRoots: options.deniedReadRoots } : {}),
    ...(options.allowedReadRoots ? { allowedReadRoots: options.allowedReadRoots } : {}),
    ...(options.unconditionalDeniedReadRoots
      ? { unconditionalDeniedReadRoots: options.unconditionalDeniedReadRoots }
      : {}),
  })
  expect(plan.status).toBe('enforced')
  return spawnSync(plan.command, plan.args, { stdio: 'ignore' }).status === 0
}

describe('a read allowlist on darwin', () => {
  // sandboxing.md:180 — the narrower allow re-opens that part of the denied
  // region, and the rest of the region stays blocked.
  it('re-opens a narrower path inside a denied region and blocks the rest', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree(['projects/notes.txt', 'other.txt'])
    try {
      const options = {
        sessionDir: tree.workspace,
        deniedReadRoots: [tree.home],
        allowedReadRoots: [join(tree.home, 'projects')],
      }
      expect(readsUnder(join(tree.home, 'projects', 'notes.txt'), options)).toBe(true)
      expect(readsUnder(join(tree.home, 'other.txt'), options)).toBe(false)
      // The same two files with no allowlist: both denied. Without this the
      // first assertion could pass on a profile where nothing was denied at all.
      const denyOnly = { sessionDir: tree.workspace, deniedReadRoots: [tree.home] }
      expect(readsUnder(join(tree.home, 'projects', 'notes.txt'), denyOnly)).toBe(false)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // sandboxing.md:181 — an exact deny holds inside a wider allow.
  it('keeps an exact deny blocked inside a wider allow', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree(['.env', 'notes.txt'])
    try {
      const options = {
        sessionDir: tree.workspace,
        deniedReadRoots: [join(tree.home, '.env')],
        allowedReadRoots: [tree.home],
      }
      expect(readsUnder(join(tree.home, '.env'), options)).toBe(false)
      expect(readsUnder(join(tree.home, 'notes.txt'), options)).toBe(true)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // The rule specificity alone does NOT give: an allow that names a credential
  // root exactly, or a path inside it, must still lose. Deny outranks allow.
  it('refuses a credential root even when the allowlist names it exactly', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree(['store/token.json', 'projects/notes.txt'])
    try {
      const credentialRoot = join(tree.home, 'store')
      const options = {
        sessionDir: tree.workspace,
        deniedReadRoots: [tree.home],
        // Both the exact root and a path inside it, which is the strongest form
        // an administrator could write, next to an ordinary re-opened path.
        allowedReadRoots: [
          credentialRoot,
          join(credentialRoot, 'token.json'),
          join(tree.home, 'projects'),
        ],
        unconditionalDeniedReadRoots: [credentialRoot],
      }
      expect(readsUnder(join(credentialRoot, 'token.json'), options)).toBe(false)
      // …while the allowlist still works for everything the floor does not name,
      // so the assertion above is not passing on a profile that denies all reads.
      expect(readsUnder(join(tree.home, 'projects', 'notes.txt'), options)).toBe(true)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // The built-in set, proven end to end through the funnel rather than by
  // reading the constant: with the home directory denied and an allowlist
  // configured, a workspace file is still readable.
  it('re-opens the workspace through the funnel when an allowlist is configured', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree(['other.txt'])
    try {
      const plan = resolveProcessIsolation({
        platform: 'darwin',
        profile: 'networked',
        command: '/bin/cat',
        args: [join(tree.workspace, 'README.md')],
        workspaceRoot: tree.workspace,
        workingDirectory: tree.workspace,
        scratchRoot: tree.scratch,
        deniedReadRoots: [tree.home],
        allowedReadRoots: [tree.workspace],
      })
      expect(spawnSync(plan.command, plan.args, { stdio: 'ignore' }).status).toBe(0)
      // The receipt stops claiming whole-filesystem read once a boundary exists.
      expect(plan.backend).toContain(':scoped-read:')
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  it('keeps saying host-read when no allowlist is configured', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree([])
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
      expect(plan.backend).toContain(':host-read:')
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })
})

describe('a read allowlist on a platform that cannot enforce it', () => {
  // The whole point of the row: a control that silently does nothing on two of
  // three platforms is worse than none, because the administrator who configured
  // it stops looking.
  it('refuses the spawn on linux and win32 rather than dropping the setting', () => {
    const tree = buildTree([])
    try {
      for (const platform of ['linux', 'win32'] as const) {
        expect(() => resolveProcessIsolation({
          platform,
          profile: 'networked',
          command: '/bin/true',
          args: [],
          workspaceRoot: tree.workspace,
          workingDirectory: tree.workspace,
          scratchRoot: tree.scratch,
          allowedReadRoots: [tree.workspace],
        })).toThrow(`${ISOLATION_UNAVAILABLE_PREFIX}:${platform}:networked:read-allowlist`)
      }
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  it('leaves those platforms untouched when no allowlist is configured', () => {
    const tree = buildTree([])
    try {
      // linux without a launcher fails for its own reason, never for this one.
      expect(() => resolveProcessIsolation({
        platform: 'linux',
        profile: 'networked',
        command: '/bin/true',
        args: [],
        workspaceRoot: tree.workspace,
        workingDirectory: tree.workspace,
        scratchRoot: tree.scratch,
      })).not.toThrow(/read-allowlist/)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })
})
