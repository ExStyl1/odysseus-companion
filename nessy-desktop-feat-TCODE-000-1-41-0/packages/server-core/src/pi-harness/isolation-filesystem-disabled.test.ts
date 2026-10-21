/**
 * N10 — `sandbox.filesystem.disabled` actually turns the filesystem layer off.
 *
 * Every `sandboxing.md` citation in THIS FILE names the page's own SECTION
 * ANCHOR, not a line number, and every quote was re-measured verbatim against
 * the 2026-08-25 fetch (`curl -s https://code.claude.com/docs/en/sandboxing.md`,
 * HTTP 200, 677 lines, md5 `3538c3dd04b83d8bbaa35d0fad0ccb88`). Numbers are gone
 * because this page's have moved on three consecutive fetches — the whole
 * "Protected paths" section shifted up 14 lines between the 2026-08-23 and
 * 2026-08-25 fetches — so a number is stale before the next reader opens the
 * file, while a section anchor is part of the page's own link contract. No claim
 * is made here about citations to any OTHER page.
 *
 * `sandboxing.md#protected-paths` — "The only way to turn the protection off is
 * `filesystem.disabled`, which turns off filesystem isolation for every path."
 * (The older wording this file quoted, "unless you disable filesystem isolation,
 * which turns these deny rules off", is not on the 2026-08-25 page.) The key
 * parsed,
 * resolved and was reported by `doctor` while `resolveProcessIsolation` still
 * composed `selfConfigDenyWriteRoots` unconditionally, so the layer was
 * DESCRIBED as off while every deny root still bound.
 *
 * The write probes spawn for real, against a temp workspace this file created.
 * The credential floor is asserted on the RENDERED PROFILE instead, for the same
 * reason `isolation-read-exposure.test.ts` gives: the funnel composes it from the
 * host's own `homedir()`, and a probe must never read the developer's real
 * credentials. The network probe connects to a listener this file opened on
 * 127.0.0.1 and to nothing else.
 */

import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialDenyRoots, credentialDenyWriteRoots } from '@nessy-agent/session-tools-core'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { resolveProcessIsolation, type ProcessIsolationInput } from './isolation.ts'
import { ProcessStore } from './process-store.ts'
import { ProcessSupervisor } from './process-supervisor.ts'

interface Tree {
  root: string
  workspace: string
  scratch: string
}

function buildTree(): Tree {
  const root = mkdtempSync(join(tmpdir(), 'nessy-fs-disabled-'))
  const workspace = join(root, 'workspace')
  const scratch = join(root, 'scratch')
  for (const dir of [workspace, scratch]) mkdirSync(dir, { recursive: true })
  // Canonical, because the funnel realpaths and the profile is written in
  // canonical paths: on macOS the temp root is reached through /var -> /private/var.
  return { root, workspace: realpathSync(workspace), scratch: realpathSync(scratch) }
}

function plan(tree: Tree, command: string, args: string[], extra: Partial<ProcessIsolationInput> = {}) {
  return resolveProcessIsolation({
    platform: 'darwin',
    profile: 'networked',
    command,
    args,
    workspaceRoot: tree.workspace,
    workingDirectory: tree.workspace,
    scratchRoot: tree.scratch,
    ...extra,
  })
}

/** The project-scope settings file `sandboxing.md#protected-paths` names. */
function writesProjectSettings(tree: Tree, extra: Partial<ProcessIsolationInput>): boolean {
  const target = join(tree.workspace, '.claude', 'settings.json')
  rmSync(join(tree.workspace, '.claude'), { recursive: true, force: true })
  const resolved = plan(
    tree,
    '/bin/sh',
    ['-c', `mkdir -p ${JSON.stringify(join(tree.workspace, '.claude'))} && printf '{}' > ${JSON.stringify(target)}`],
    extra,
  )
  spawnSync(resolved.command, resolved.args, { stdio: 'ignore' })
  return existsSync(target)
}

describe('sandbox.filesystem.disabled at the isolation funnel', () => {
  it('releases the self-config write deny it is documented to release, and only when set', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      // The negative half first: this is the protection `:478` describes, and a
      // release test that never saw it bind would pass on a broken sandbox.
      expect(writesProjectSettings(tree, {})).toBe(false)
      expect(writesProjectSettings(tree, { filesystemIsolationDisabled: true })).toBe(true)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  it('keeps network isolation — the whole point of the key', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open(socket) { socket.end() } },
    })
    const connect = [
      '-e',
      `const net = require('net');`
      + `const s = net.connect(${server.port}, '127.0.0.1');`
      + `s.on('connect', () => { s.destroy(); process.exit(0) });`
      + `s.on('error', () => process.exit(3));`
      + `setTimeout(() => process.exit(4), 5000)`,
    ]
    const connects = (extra: Partial<ProcessIsolationInput>): number | null => {
      const resolved = plan(tree, process.execPath, connect, extra)
      // `cwd` is the temp workspace on purpose: bunfig is resolved from the CWD,
      // so a child started at the repo root would inherit this repo's own test
      // preload and die on its config-dir guard rather than on the sandbox.
      return spawnSync(resolved.command, resolved.args, { stdio: 'ignore', cwd: tree.workspace }).status
    }
    try {
      // With the layer off and no managed egress deny, a `networked` profile is
      // still networked — the key changes the filesystem dimension and nothing
      // else. Without this the deny below could be passing for the wrong reason.
      expect(connects({ filesystemIsolationDisabled: true })).toBe(0)
      expect(connects({ filesystemIsolationDisabled: true, denyNetworkEgress: true })).not.toBe(0)
    } finally {
      server.stop(true)
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  it('keeps the host credential floor, and says so in the receipt', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      const off = plan(tree, '/bin/true', [], { filesystemIsolationDisabled: true })
      const profile = off.args[1] ?? ''
      // The read half. `:478` names the settings-file deny rules and is silent on
      // a credential floor because Claude ships none (`:271`); ours is composed in
      // the funnel, not from a settings file, so the key does not release it.
      for (const root of credentialDenyRoots(homedir(), CONFIG_DIR, 'darwin')) {
        expect(profile).toContain(`(deny file-read* (subpath "${root}"))`)
      }
      // The write half — reachable through EVERY path now, not just a grant.
      for (const root of credentialDenyWriteRoots(homedir())) {
        expect(profile).toContain(`(deny file-write* (subpath "${root}"))`)
      }
      expect(profile).toContain('(allow file-write*)')
      expect(profile).not.toContain('(deny file-write* (subpath "' + join(tree.workspace, '.claude') + '"))')
      expect(off.backend).toContain('filesystem-off')
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  it('changes nothing for an install that never sets the key', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      const on = plan(tree, '/bin/true', [], { deniedWriteRoots: ['/opt/policy'] })
      const profile = on.args[1] ?? ''
      expect(profile).toContain('(deny file-write*)')
      expect(profile).toContain(`(allow file-write* (subpath "${tree.workspace}"))`)
      expect(profile).toContain(`(deny file-write* (subpath "${join(tree.workspace, '.claude')}"))`)
      expect(profile).toContain('(deny file-write* (subpath "/opt/policy"))')
      expect(on.backend).toBe('sandbox-exec:host-read:write-workspace+scratch')
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  // The half that made the key inert: it parsed and resolved and nothing carried
  // it to the funnel. Asserted at the supervisor seam, which is the only path a
  // supervised command takes.
  it('reaches the funnel through the supervisor, and only when the host set it', async () => {
    const tree = buildTree()
    const seen: Array<boolean | undefined> = []
    const store = new ProcessStore({ root: join(tree.root, 'store') })
    const run = async (filesystemIsolationDisabled?: boolean) => {
      const supervisor = new ProcessSupervisor({
        store,
        ...(filesystemIsolationDisabled === undefined ? {} : { filesystemIsolationDisabled }),
        resolveIsolation: input => {
          seen.push(input.filesystemIsolationDisabled)
          return { profile: 'workspace', backend: 'test', command: '/bin/true', args: [] } as never
        },
      })
      await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' },
        executionId: `e-${seen.length}`,
        semanticId: 'bash',
        command: '/bin/true',
        cwd: tree.workspace,
        workspaceRoot: tree.workspace,
        profile: 'workspace',
        timeoutMs: 5_000,
        stdin: 'ignore',
      } as never)
    }
    try {
      await run(true)
      await run(undefined)
      expect(seen).toEqual([true, undefined])
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  it('drops a read allowlist rather than refusing the spawn for it', () => {
    if (process.platform !== 'darwin') return
    const tree = buildTree()
    try {
      // A rule that binds nothing anywhere must not become an outage on the two
      // platforms that cannot express it: `resolveSandboxReadAllowlist` already
      // reports that allowRead does not bind while the layer is off.
      expect(() => resolveProcessIsolation({
        platform: 'linux',
        profile: 'networked',
        command: '/bin/true',
        args: [],
        workspaceRoot: tree.workspace,
        workingDirectory: tree.workspace,
        scratchRoot: tree.scratch,
        allowedReadRoots: [tree.workspace],
        filesystemIsolationDisabled: true,
      })).not.toThrow()
      const off = plan(tree, '/bin/true', [], {
        allowedReadRoots: [tree.workspace],
        filesystemIsolationDisabled: true,
      })
      expect(off.backend).toContain(':host-read:')
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })
})
