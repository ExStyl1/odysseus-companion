/**
 * P3.168 — Pi's floor anchors read the latched home, not `os.homedir()`.
 *
 * `resolveProcessIsolation` composes the credential floor HERE, on the one
 * funnel every backend and the capability probe pass through, and it anchors
 * four things on the home: the deny-read roots, the built-in read allowlist,
 * the deny-write roots, and the self-config `home`. The whole point of that
 * floor is to name the tree holding `~/.nessy/dp_auth_creds.json`. On Node —
 * which the process resolving this is — a confirmed managed `HOME` moves
 * `os.homedir()` mid-session (P3.143's measurement: Node and Electron follow it,
 * Bun does not), so an un-latched floor denies a directory the credential is no
 * longer in and leaves the one it IS in ambient-readable.
 *
 * This moves the LATCH rather than `process.env.HOME`, because under `bun test`
 * the environment variable moves nothing at all (P3.169). The end-to-end claim
 * needs a Node-hosted or packaged check.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { latchedHomeDir, relatchHomeDirForTests } from '@nessy-agent/shared/config/home-latch'
import { resolveProcessIsolation } from './isolation.ts'
import { probeIsolationCapabilities } from './isolation-capabilities.ts'

/**
 * The case below asks for the `darwin` plan because the boundary it reads is
 * carried in the seatbelt launcher's own arguments. The backend, though, is
 * chosen from the REAL `process.platform` — the `platform` argument selects the
 * composition, not the launcher — so on a host with no usable
 * `/usr/bin/sandbox-exec` (a Linux CI container, or a macOS host where it has
 * been removed) `resolveProcessIsolation` throws
 * `process-isolation-unavailable:darwin:networked` before anything about the
 * latch can be observed, and the failure names a remediation the runner cannot
 * perform.
 *
 * So the verdict is asked of `probeIsolationCapabilities` — the product's own
 * capability report, which resolves through the same function and never throws
 * — and printed. Never a platform list: what makes this case runnable is a
 * working launcher, not a platform name, and `darwin` with the binary removed
 * is exactly the case a host list would get wrong.
 */
const darwinNetworked = (await probeIsolationCapabilities({ platform: 'darwin' })).profiles.networked
if (!darwinNetworked.available) {
  // stderr, so the reason travels with the run rather than living only here.
  console.warn(
    '[isolation-home-latch.test.ts] SKIPPED: this host cannot render a darwin isolation plan — '
    + `${darwinNetworked.reason ?? 'no reason reported'}`
    + ` (${darwinNetworked.remediation ?? 'no remediation reported'})`,
  )
}

afterEach(() => {
  relatchHomeDirForTests()
})

function tree(): { root: string; workspace: string; scratch: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'p3168-isolation-'))
  const workspace = join(root, 'workspace')
  const scratch = join(root, 'scratch')
  const home = join(root, 'home')
  for (const dir of [workspace, scratch, join(home, '.nessy')]) mkdirSync(dir, { recursive: true })
  return { root, workspace, scratch, home }
}

describe('P3.168 — the Pi credential floor anchors on the latched home', () => {
  it.skipIf(!darwinNetworked.available)('names the latched home in the boundary, and not the real one', () => {
    const t = tree()
    try {
      relatchHomeDirForTests(t.home)
      // Negative control: the two homes genuinely differ, so a pass cannot come
      // from the latch and `os.homedir()` being the same string.
      expect(latchedHomeDir()).toBe(t.home)
      expect(homedir()).not.toBe(t.home)

      const plan = resolveProcessIsolation({
        platform: 'darwin',
        profile: 'networked',
        command: '/bin/true',
        args: [],
        workspaceRoot: t.workspace,
        workingDirectory: t.workspace,
        scratchRoot: t.scratch,
      })

      // The boundary is carried in the launcher's own arguments on darwin, so
      // the assertion is on the emitted plan rather than on an internal list.
      const emitted = plan.args.join('\n')
      expect(emitted).toContain(join(t.home, '.nessy'))
      // And the real home's credential tree is NOT what got denied. Pre-fix
      // this pair was inverted: the floor named a home the session had left.
      expect(emitted).not.toContain(join(homedir(), '.nessy'))
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })
})
