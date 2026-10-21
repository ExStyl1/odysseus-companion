/**
 * `assertBypassPermittedForProcess` — bypassPermissions refuses root/sudo
 * outside a recognized container.
 *
 * Contract source: `code.claude.com/docs/en/permission-modes.md`: "On Linux
 * and macOS, Claude Code refuses to start in this mode when running as root
 * or under sudo … The check is skipped automatically inside a recognized
 * sandbox."
 *
 * Every case injects `euid`/`platform`/`containerMarker`/`env`/`readInitCgroup`
 * explicitly rather than reading the real process/filesystem, so the suite's
 * result never depends on the uid or container state of whatever machine runs
 * it.
 *
 * **Every permissive case carries a same-fixture REFUSAL control** — the
 * identical options with only the one signal the case NAMES removed. Without
 * that control a `not.toThrow()` cannot tell "permitted for the named reason"
 * from "permitted for any reason at all", and P2.186 measured both halves of
 * that on this exact file: a guard mutated to permit EVERYTHING left all nine
 * permissive blocks green (8 pass / 2 fail), and deleting `/.dockerenv` from
 * `CONTAINER_MARKERS` left the whole suite green (10/10) whenever
 * `KUBERNETES_SERVICE_HOST` was set — i.e. on this repo's own CI, where the
 * job runs as root in a Kubernetes pod. The three blocks that leaked were the
 * ones that left `env`/`readInitCgroup` at their real defaults, which is the
 * hazard the note on {@link NO_CONTAINER} was already written to prevent.
 */
import { describe, expect, test } from 'bun:test'
import {
  assertBypassPermittedForProcess,
  BypassPermissionsRootRefusedError,
} from './bypass-root-guard.ts'

describe('assertBypassPermittedForProcess', () => {
  /**
   * Every signal pinned closed, not just the marker files: the refusal test
   * itself runs on this repo's CI inside a root Kubernetes pod, so leaving
   * `env`/`readInitCgroup` to their real defaults would make THIS test find a
   * genuine container and stop refusing — the guard's fix would fail its own
   * regression test in the very environment that motivated it.
   *
   * Spread it FIRST in every fixture, then override the single signal under
   * test, so the case's own signal is the only one live.
   */
  const NO_CONTAINER = {
    containerMarker: () => false,
    env: {} as Record<string, string | undefined>,
    readInitCgroup: () => '',
  }

  /** The one refusal every control below asserts, by identity of the coded error. */
  const refuses = (options: Parameters<typeof assertBypassPermittedForProcess>[0]) => {
    expect(() => assertBypassPermittedForProcess(options)).toThrow(BypassPermissionsRootRefusedError)
  }

  test('refuses root with no container signal present: coded error, Claude-mirrored text', () => {
    let caught: unknown
    try {
      assertBypassPermittedForProcess({ euid: 0, ...NO_CONTAINER })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BypassPermissionsRootRefusedError)
    expect((caught as BypassPermissionsRootRefusedError).code).toBe('bypass-permissions-root-refused')
    expect((caught as Error).message).toBe(
      'bypassPermissions cannot be used with root/sudo privileges for security reasons',
    )
  })

  test('allows root inside Docker BECAUSE of /.dockerenv — the same fixture without that marker refuses', () => {
    const inDocker = { euid: 0, ...NO_CONTAINER, containerMarker: (path: string) => path === '/.dockerenv' }
    expect(() => assertBypassPermittedForProcess(inDocker)).not.toThrow()
    refuses({ ...inDocker, containerMarker: () => false })
    // A marker path that is NOT one of the two recognized ones is not a signal:
    // the allow is keyed on the marker's identity, not on the callback existing.
    refuses({ ...inDocker, containerMarker: (path: string) => path === '/.not-a-container-marker' })
  })

  test('allows root inside Podman BECAUSE of /run/.containerenv — the same fixture without that marker refuses', () => {
    const inPodman = { euid: 0, ...NO_CONTAINER, containerMarker: (path: string) => path === '/run/.containerenv' }
    expect(() => assertBypassPermittedForProcess(inPodman)).not.toThrow()
    refuses({ ...inPodman, containerMarker: () => false })
  })

  test('allows a non-root effective uid BECAUSE it is non-root — euid 0 on the same fixture refuses', () => {
    const nonRoot = { euid: 501, ...NO_CONTAINER }
    expect(() => assertBypassPermittedForProcess(nonRoot)).not.toThrow()
    refuses({ ...nonRoot, euid: 0 })
  })

  test('skips the check on win32 BECAUSE of the platform — the same options on linux refuse', () => {
    const onWindows = { platform: 'win32' as const, euid: 0, ...NO_CONTAINER }
    expect(() => assertBypassPermittedForProcess(onWindows)).not.toThrow()
    refuses({ ...onWindows, platform: 'linux' })
    refuses({ ...onWindows, platform: 'darwin' })
  })

  test('allows root in a Kubernetes pod BECAUSE of KUBERNETES_SERVICE_HOST — the same fixture without it refuses', () => {
    // The CI shape that disproved marker-only detection: no marker files at all.
    const inPod = { euid: 0, ...NO_CONTAINER, env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' } }
    expect(() => assertBypassPermittedForProcess(inPod)).not.toThrow()
    refuses({ ...inPod, env: {} })
  })

  test('allows root under a runtime that sets `container` BECAUSE of that var — the same fixture without it refuses', () => {
    const inNspawn = { euid: 0, ...NO_CONTAINER, env: { container: 'podman' } }
    expect(() => assertBypassPermittedForProcess(inNspawn)).not.toThrow()
    refuses({ ...inNspawn, env: {} })
    // An unrelated env var is not a container signal — the allow is keyed on the
    // NAME, not on the environment being non-empty.
    refuses({ ...inNspawn, env: { CONTAINER_HINT: 'podman' } })
  })

  test('allows root BECAUSE /proc/1/cgroup names a container runtime — a cgroup naming none refuses', () => {
    const inCgroup = {
      euid: 0,
      ...NO_CONTAINER,
      readInitCgroup: () => '12:pids:/kubepods/burstable/pod1234/abcd',
    }
    expect(() => assertBypassPermittedForProcess(inCgroup)).not.toThrow()
    // cgroup v2's bare root, and an ordinary systemd slice: neither names a runtime.
    refuses({ ...inCgroup, readInitCgroup: () => '0::/' })
    refuses({ ...inCgroup, readInitCgroup: () => '0::/user.slice/user-1000.slice/session-3.scope' })
  })

  test('an empty container env value is not a container signal', () => {
    expect(() => assertBypassPermittedForProcess({
      euid: 0,
      ...NO_CONTAINER,
      env: { container: '' },
      readInitCgroup: () => '0::/',
    })).toThrow(BypassPermissionsRootRefusedError)
  })

  test('allows BECAUSE no euid is knowable when geteuid is missing — an explicit euid 0 still refuses', () => {
    const original = process.geteuid
    // Simulate a runtime where `geteuid` does not exist, matching the
    // `process.geteuid?.()` optional-chain the guard falls back to.
    process.geteuid = undefined
    try {
      expect(() => assertBypassPermittedForProcess({ ...NO_CONTAINER })).not.toThrow()
      // The fallback is about ABSENCE, not a blanket pass: a caller that knows
      // the uid is still refused on the very same host.
      refuses({ euid: 0, ...NO_CONTAINER })
    } finally {
      process.geteuid = original
    }
  })
})
