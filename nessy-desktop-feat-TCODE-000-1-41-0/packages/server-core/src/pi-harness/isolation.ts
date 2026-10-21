import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { credentialDenyRoots, credentialDenyWriteRoots } from '@nessy-agent/session-tools-core'
import type { ProcessIsolationProfile } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import type { WindowsSandboxRuntimeBinding } from '@nessy-agent/shared/agent/backend'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { latchedHomeDir } from '@nessy-agent/shared/config/home-latch'
import { isolationUnavailable } from './isolation-remediation.ts'
import { resolveDarwinIsolation } from './isolation/darwin.ts'
import { resolveLinuxIsolation } from './isolation/linux.ts'
import { selfConfigDenyWriteRoots } from './isolation/self-config-deny.ts'
import { sharedGitDirectoryGrant } from './isolation/shared-git.ts'
import { resolveWindowsIsolation } from './isolation/windows.ts'

/**
 * Every `sandboxing.md` citation in THIS FILE names the page's own SECTION
 * ANCHOR, not a line number, and every quote was re-measured verbatim against
 * the 2026-08-25 fetch (`curl -s https://code.claude.com/docs/en/sandboxing.md`,
 * HTTP 200, 677 lines, md5 `3538c3dd04b83d8bbaa35d0fad0ccb88`). Numbers are gone
 * because this page's have moved on three consecutive fetches — the whole
 * "Protected paths" section shifted up 14 lines between the 2026-08-23 and
 * 2026-08-25 fetches — so a number is stale before the next reader opens the
 * file, while a section anchor is part of the page's own link contract. No claim
 * is made here about citations to any OTHER page.
 */
export interface ProcessIsolationInput {
  platform?: NodeJS.Platform
  profile: ProcessIsolationProfile
  command: string
  args: string[]
  workspaceRoot: string
  workingDirectory: string
  scratchRoot?: string
  additionalWritableRoots?: readonly string[]
  deniedReadRoots?: readonly string[]
  /**
   * `sandbox.filesystem.allowRead` — paths re-opened for READ inside a
   * `deniedReadRoots` region (`sandboxing.md#configure-sandboxing`, the
   * `denyRead`/`allowRead` example table).
   *
   * Empty or absent leaves the ambient-read posture exactly as it was, which is
   * every install that never wrote the key. Non-empty is enforceable on darwin
   * ONLY; the other two platforms refuse the spawn rather than run a command
   * under a policy they cannot apply.
   */
  allowedReadRoots?: readonly string[]
  /** Readable-but-unwritable roots (`denyWrite` / `Edit(...)` deny rules). */
  deniedWriteRoots?: readonly string[]
  /**
   * `sandbox.filesystem.disabled` — resolved by
   * {@link resolveSandboxSettings}, threaded through the supervisor, and acted
   * on HERE because this is the funnel that composes the filesystem layer.
   *
   * `sandboxing.md#protected-paths`: "There is no way to exempt one of these
   * paths: an `allowWrite` entry or an `Edit` allow rule that covers the path
   * doesn't lift the protection. The only way to turn the protection off is
   * `filesystem.disabled`, which turns off filesystem isolation for every path."
   * (The older wording this comment quoted — "unless you disable filesystem
   * isolation, which turns these deny rules off" — is not on the 2026-08-25
   * page; the coupling it asserted is.) So with this set the
   * funnel does not compose the layer at all — no self-config denies, no
   * shared-git carve-outs, no configured `deniedWriteRoots`/`deniedReadRoots`,
   * no read allowlist — rather than composing an empty one, so the receipt says
   * `filesystem-off` instead of claiming a write scope it is not enforcing.
   *
   * Two things survive, deliberately:
   *
   * - **Network isolation.** That is the whole point of the key
   *   (`sandboxing.md#disable-filesystem-isolation`: "Set
   *   `sandbox.filesystem.disabled` to `true` to skip filesystem isolation while
   *   keeping network isolation."), and nothing below touches the network
   *   dimension.
   * - **The host credential floor**, read and write. `#protected-paths` names
   *   exactly one thing the key turns off — the deny rules a settings file wrote
   *   — and it is silent on a credential floor because Claude ships none
   *   (`#protect-credentials`: "There is no built-in credential deny list, so
   *   only the files and variables you list are restricted."). Ours is composed in this funnel, not
   *   from a settings file, precisely so no caller and no layer can undo it, and
   *   `filesystem.disabled` is settable at USER scope: releasing the floor with
   *   it would let one boolean in a user settings file hand `~/.ssh`, `~/.aws`
   *   and the gateway token under `~/.nessy` to every sandboxed command.
   *   `resolveSandboxFilesystemConsequences` reports the same decision.
   */
  filesystemIsolationDisabled?: boolean
  /**
   * Cut outbound network for this process whatever profile it asked for.
   *
   * The host's answer to `sandbox.network.allowManagedDomainsOnly`
   * (`resolveSandboxNetworkEnforcement`). It is a boolean because every backend
   * we have is a boolean: Seatbelt's address filter accepts no host but `*` or
   * `localhost`, `unshare -n` and `firejail --net=none` switch the whole
   * namespace, and the Windows profile carries one `network.enabled` key. A
   * `networked` profile under this flag becomes network-denied; nothing else
   * about the profile changes.
   */
  denyNetworkEgress?: boolean
  environment?: Readonly<Record<string, string>>
  windowsSandboxRuntime?: WindowsSandboxRuntimeBinding
  windowsSandboxStateRoot?: string
  /** Test seam; production always uses the pinned-manifest verifier. */
  verifyWindowsSandboxRuntime?: (runtime: WindowsSandboxRuntimeBinding) => void
}

export interface ProcessIsolationPlan {
  command: string
  args: string[]
  /** Optional host-owned environment replacement required by the isolation launcher. */
  environment?: Readonly<Record<string, string>>
  backend: string
  profile: Exclude<ProcessIsolationProfile, 'none'>
}

/**
 * The nearest existing ancestor's realpath with the missing tail re-appended.
 *
 * The old form realpathed the parent on `ENOENT` and stopped there, which THREW
 * for a deny root two levels below anything that exists — and the built-in set
 * names `/etc/nessy` and `<workspace>/.claude`, neither of which most machines
 * have. A deny for a path that does not exist yet is not a no-op: the path can be
 * created inside a writable root, and the boundary has to already name it.
 *
 * A path this process may not even STAT falls back to the path as written.
 * Measured, not assumed: on macOS `lstat("~/Library/Cookies")` returns EPERM to
 * any process without Full Disk Access, and the credential floor names that
 * directory precisely because it holds a live cookie store. Walking up on EPERM
 * would resolve the parent and re-append a tail whose real target was never
 * learned, and rethrowing would fail every spawn on a normally-configured Mac —
 * a deny-set builder must never be the reason a process cannot start. The path AS
 * WRITTEN is still denied, which is the half that stops the read; only the
 * symlink-target half is unavailable, and a path we cannot stat is one the child
 * inherits no more access to than we have.
 */
function nearestExistingRealpath(path: string): string {
  const tail: string[] = []
  let base = path
  for (;;) {
    try {
      return join(realpathSync(base), ...tail)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') return path
      if (code !== 'ENOENT') throw error
    }
    const parent = dirname(base)
    if (parent === base) return path
    tail.unshift(basename(base))
    base = parent
  }
}

/**
 * One deny entry becomes every path a write can reach it through: the path as
 * WRITTEN, and its symlink target.
 *
 * `sandboxing.md#protected-paths` — "If a symlink appears at a protected settings
 * file's path during the session, the sandbox also denies writes to the file it
 * points to, starting with the next command." (This comment used to quote a
 * longer sentence beginning "The deny rules resolve symlinks"; that wording is
 * not on the 2026-08-25 page, and the number it hung on, `:478`, is now the
 * network-proxy line. The behaviour quoted above is the same one.) Both halves of
 * the pairing are load-bearing and each covers a bypass the
 * other misses:
 *
 * - Without the TARGET, a symlink at the protected path is a hole. The kernel
 *   canonicalises before Seatbelt matches (and bwrap resolves the mount), so a
 *   write through `<workspace>/.claude -> <workspace>/real` lands on a path the
 *   deny list never named, inside a tree the profile made writable.
 * - Without the PATH AS WRITTEN, the link itself is unprotected. `unlink` acts on
 *   the link, not its target, so the link can be removed and replaced with an
 *   ordinary file of the command's choosing at the same protected name.
 *
 * "for the next command" is per-command re-resolution, and that is where this
 * runs: `ProcessSupervisor.start` resolves isolation once per spawn, so a link
 * created after startup is paired before the next command sees it.
 */
/**
 * The same lexical/canonical pair for an ALLOW root.
 *
 * Separate from {@link denyRootPair} in one way only: an allow of a filesystem
 * root is pointless rather than dangerous — reads are ambient by default — so it
 * is not refused as "too broad", and the specificity ordering makes every deny
 * deeper than it win anyway. The pair itself is needed for the same reason:
 * Seatbelt matches the canonical path, and a toolchain reached through a symlink
 * would otherwise be re-opened under only one of its two names.
 */
export function readAllowRootPair(root: string): string[] {
  if (!isAbsolute(root)) throw new Error('process-read-allow-root-not-absolute')
  const lexical = resolve(root)
  const canonical = nearestExistingRealpath(lexical)
  return lexical === canonical ? [lexical] : [lexical, canonical]
}

/**
 * Roots every supervised command needs to READ, re-opened whenever an
 * administrator configures an allowlist.
 *
 * Enumerated from a real run, not guessed. With `deniedReadRoots: [$HOME]` and
 * nothing re-opened, on this machine: `/bin/sh`, `node --version`,
 * `bun --version`, `python3 --version` and `env true` all still succeed — a
 * binary under a denied path still EXECUTES, because the profile's
 * `(allow process*)` covers `process-exec` independently of `file-read*` — and
 * exactly one command fails:
 *
 *     fatal: unable to access '/Users/…/.gitconfig': Operation not permitted
 *
 * `git` aborts with status 128 on `git --version`. It does not degrade. That is
 * the measured half of the `~/.gitconfig` decision in `credential-deny-roots.ts`:
 * the floor keeps that file readable because git cannot run without it, and an
 * administrator's `denyRead: ["~/"]` would otherwise take it away again through
 * the other door.
 *
 * Every entry is SHALLOW on purpose. Read rules are emitted least- to
 * most-specific, so a deeper deny an administrator writes still wins over each of
 * these, and the host credential floor is emitted after all of them. They re-open
 * only what a broad deny would otherwise have swept up.
 *
 * The workspace, working directory, scratch root and every writable grant are
 * added by {@link resolveProcessIsolation} from the values it already resolved —
 * a writable root that cannot be read is useless, and a command that cannot read
 * its own working directory cannot start.
 */
export function builtInReadAllowRoots(home: string): readonly string[] {
  return [
    // The OS and package-manager trees a process links and reads data from.
    '/bin', '/sbin', '/usr', '/opt', '/etc', '/private/etc', '/System', '/Library', '/dev',
    '/var/db', '/private/var/db',
    // Measured above: without these, `git` exits 128 before doing anything.
    join(home, '.gitconfig'),
    join(home, '.config', 'git', 'config'),
  ]
}

export function denyRootPair(root: string, kind: 'read' | 'write'): string[] {
  if (!isAbsolute(root)) throw new Error(`process-denied-${kind}-root-not-absolute`)
  const lexical = resolve(root)
  const canonical = nearestExistingRealpath(lexical)
  for (const path of [lexical, canonical]) {
    if (dirname(path) === path) throw new Error(`process-denied-${kind}-root-too-broad`)
  }
  return lexical === canonical ? [lexical] : [lexical, canonical]
}

/**
 * Lexical containment that is correct for both POSIX paths and Windows drive/
 * UNC paths. `path.relative()` returns an absolute path when roots are on
 * different Windows volumes; checking only for `..` would therefore accept a
 * cross-volume escape.
 */
export function isPathContained(
  root: string,
  candidate: string,
  pathApi: {
    relative(from: string, to: string): string
    isAbsolute(path: string): boolean
    sep: string
  } = { relative, isAbsolute, sep },
): boolean {
  const rel = pathApi.relative(root, candidate)
  return !pathApi.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`)
}

export function resolveProcessIsolation(input: ProcessIsolationInput): ProcessIsolationPlan {
  if (input.profile === 'none') throw new Error('process-isolation-none-is-in-process-only')
  const platform = input.platform ?? process.platform
  if (input.profile === 'isolated-code') {
    throw new Error(isolationUnavailable(platform, 'isolated-code', 'declared-input-read-boundary'))
  }
  // The loud refusal. `sandbox-exec` is the only backend with a rule that
  // re-opens a subtree inside a denied one; bwrap's read scope is the
  // `--ro-bind / /` it starts from, firejail's `--whitelist` is a write scope,
  // and the Windows profile's per-path values have no re-allow. Running the
  // command anyway would leave an administrator believing a read boundary is in
  // force on two of three platforms when nothing binds.
  const filesystemDisabled = input.filesystemIsolationDisabled === true
  // A read allowlist only ever re-opened a subtree inside a `deniedReadRoots`
  // region, and with the layer off there is no such region left to re-open. It
  // is dropped rather than refused: `resolveSandboxReadAllowlist` already tells
  // the administrator that "allowRead does not bind while
  // sandbox.filesystem.disabled is true", and refusing every spawn on a platform
  // that cannot bind a rule which now binds nothing anywhere would be an outage
  // in place of a diagnostic.
  const configuredReadAllowRoots = filesystemDisabled ? [] : (input.allowedReadRoots ?? [])
  if (configuredReadAllowRoots.length > 0 && platform !== 'darwin') {
    throw new Error(isolationUnavailable(platform, input.profile, 'read-allowlist'))
  }
  const workspaceRoot = realpathSync(input.workspaceRoot)
  const workingDirectory = realpathSync(input.workingDirectory)
  if (!isPathContained(workspaceRoot, workingDirectory)) {
    throw new Error('process-working-directory-outside-workspace')
  }
  if (!input.scratchRoot) throw new Error('process-isolation-host-scratch-required')
  const scratchRoot = input.scratchRoot
  mkdirSync(scratchRoot, { recursive: true })
  // `sandboxing.md#filesystem-isolation`: a linked worktree's `.git` is a FILE
  // pointing outside the workspace root, so ordinary git is broken unless the
  // shared directory joins the write scope — "the sandbox also allows writes to
  // the main repository's shared `.git` directory so commands such as `git commit`
  // can update refs and the index. Writes to `hooks/` and `config` inside that
  // directory remain denied." Resolved per spawn, from the workspace root the host
  // already canonicalised — never from a caller-supplied path.
  // Skipped whole with the layer off: the grant carves a write hole nobody needs
  // when every write is already allowed, and its `.git/hooks`/`.git/config` denies
  // are part of what `#protected-paths` surrenders to `filesystem.disabled`.
  const sharedGit = filesystemDisabled ? undefined : sharedGitDirectoryGrant(workspaceRoot)
  const additionalWritableRoots = [
    ...(input.additionalWritableRoots ?? []).map(root => realpathSync(root)),
    ...(sharedGit ? [sharedGit.writableRoot] : []),
  ]
  // The credential floor is composed HERE, on the same rule the write floor
  // below states: this is the one funnel every backend and the capability probe
  // pass through, so a supervised process cannot be started without it, and a
  // caller that forgets to pass `deniedReadRoots` cannot undo it. It is kept in
  // its OWN list rather than merged, because it must be emitted after every read
  // rule an administrator can write — `sandboxing.md#configure-sandboxing`'s "The
  // deny holds inside a wider allow, so a broad allow can't silently re-expose a
  // secret", extended to an `allowRead` that names a credential root exactly.
  //
  // `latchedHomeDir()` and not `homedir()` — P3.168, and it is the same shape
  // P3.143 fixed one runtime over, in `config/sandbox-settings.ts`. The floor's
  // whole job is to name the tree holding `~/.nessy/dp_auth_creds.json`; on Node
  // — which this process is — a confirmed managed `HOME` moves `os.homedir()`
  // mid-session, so an un-latched floor would deny a directory the credential is
  // no longer in and leave the one it IS in ambient-readable. The four anchors in
  // this function (deny-read, the built-in read allows, deny-write, and the
  // self-config `home`) take the same latch so they cannot describe four
  // different homes.
  const credentialFloor = [...new Set(
    credentialDenyRoots(latchedHomeDir(), CONFIG_DIR, platform).flatMap(root => denyRootPair(root, 'read')),
  )]
  const deniedReadRoots = [...new Set([
    ...(filesystemDisabled ? [] : (input.deniedReadRoots ?? []).flatMap(root => denyRootPair(root, 'read'))),
    ...credentialFloor,
  ])]
  const allowedReadRoots = configuredReadAllowRoots.length === 0
    ? undefined
    : [...new Set([
        ...builtInReadAllowRoots(latchedHomeDir()).flatMap(root => readAllowRootPair(root)),
        ...[workspaceRoot, workingDirectory, scratchRoot].flatMap(root => readAllowRootPair(root)),
        ...additionalWritableRoots.flatMap(root => readAllowRootPair(root)),
        ...configuredReadAllowRoots.flatMap(root => readAllowRootPair(root)),
      ])]
  // The built-in set is composed HERE, not at the caller: this is the one funnel
  // every backend and the capability probe pass through, so a supervised process
  // cannot be started without it. It is emitted after the write allows on every
  // backend, so it also overrides a `sandbox.filesystem.allowWrite` that names the
  // same tree — which is `sandboxing.md#protected-paths`'s "an `allowWrite` entry
  // or an `Edit` allow rule that covers the path doesn't lift the protection",
  // whose only documented escape is disabling filesystem isolation entirely.
  const deniedWriteRoots = [...new Set([
    // Readable-but-never-writable credential-adjacent config. Composed in the
    // same funnel and for the same reason as the self-config set: a writable
    // `~/.gitconfig` is code execution on the next `git` invocation, and it is
    // only reachable when an `allowWrite` grant overlaps the home directory.
    // It is the write half of the credential floor, so it outlives the layer for
    // the same reason the read half does — and with the layer off it is reachable
    // through EVERY path rather than only through a grant.
    ...credentialDenyWriteRoots(latchedHomeDir()),
    // `sandboxing.md#protected-paths` names this set as what the key surrenders:
    // "The only way to turn the protection off is `filesystem.disabled`, which
    // turns off filesystem isolation for every path." Composing it anyway is what
    // made the layer describable as off while every deny root still bound.
    ...(filesystemDisabled ? [] : [
      ...selfConfigDenyWriteRoots({
        platform,
        workspaceRoot,
        home: latchedHomeDir(),
        configDir: CONFIG_DIR,
        ...(platform === 'win32' ? { windowsEnvironment: process.env } : {}),
        join,
      }),
      ...(sharedGit?.deniedWriteRoots ?? []),
      ...(input.deniedWriteRoots ?? []),
    ]),
  ].flatMap(root => denyRootPair(root, 'write')))]
  if (platform === 'win32') {
    if (!input.windowsSandboxStateRoot) {
      throw new Error(isolationUnavailable('win32', input.profile, 'state-root'))
    }
    mkdirSync(input.windowsSandboxStateRoot, { recursive: true })
    return resolveWindowsIsolation({
      ...input,
      workspaceRoot,
      workingDirectory,
      scratchRoot: realpathSync(scratchRoot),
      windowsSandboxStateRoot: realpathSync(input.windowsSandboxStateRoot),
      additionalWritableRoots,
      ...(sharedGit ? { sharedGitDirectory: sharedGit.writableRoot } : {}),
      deniedReadRoots,
      deniedWriteRoots,
      profile: input.profile,
    })
  }
  const common = {
    ...input,
    workspaceRoot,
    scratchRoot: realpathSync(scratchRoot),
    additionalWritableRoots,
    // darwin alone splits the floor out of the merged read denies, so it can be
    // emitted after every administrator read rule. linux and win32 keep it in
    // `deniedReadRoots` — neither has an allow rule that could outrank it.
    unconditionalDeniedReadRoots: credentialFloor,
    // Assigned rather than conditionally spread: `...input` carries the caller's
    // raw `allowedReadRoots`, so a spread that adds nothing would leave the
    // unresolved list in place — and with the layer off the resolved answer is
    // "none", which the receipt has to read as `host-read`.
    allowedReadRoots,
    ...(sharedGit ? { sharedGitDirectory: sharedGit.writableRoot } : {}),
    deniedReadRoots,
    deniedWriteRoots,
    profile: input.profile,
  }
  if (platform === 'darwin') return resolveDarwinIsolation(common)
  if (platform === 'linux') return resolveLinuxIsolation(common)
  throw new Error(isolationUnavailable(platform, input.profile))
}
