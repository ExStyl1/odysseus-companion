/**
 * F1.533 — measured: a Pi TOOL child does not inherit the Pi-process names.
 *
 * The row (WJ-at's F1.531 residue P-WJat-1) said Pi's tool child processes
 * inherit `NESSY_PI_SUBPROCESS` and `NESSY_PI_MODEL_*`, so a Nessy process
 * launched from inside a Pi tool call would read as the Pi subprocess to the
 * network interceptor (`runsInPiSubprocess`). Read and measured 2026-09-24
 * (WJ-au), it does not, on two independent grounds:
 *
 * 1. The Pi subprocess starts no tool process itself. Every Bash, grep and glob
 *    command leaves it as a `process_start_request`
 *    (`packages/pi-agent-server/src/index.ts` symbol `requestSupervisedProcess`),
 *    and the HOST starts it (`PiAgent.handleProcessStartRequest` → this
 *    supervisor). The Pi child's environment — where `buildPiSubprocessEnv`
 *    writes the marker and where pi-agent-server writes the three model hints —
 *    is never a tool child's parent environment.
 * 2. The host starts that child under the `restricted` profile (the request Pi's
 *    host builds names no profile), whose host half is the
 *    `isRestrictedHostEnvironmentKey` allowlist. So even a HOST that carried the
 *    four names — a Nessy launched from inside another Nessy's Pi tool — would
 *    not pass them on.
 *
 * This file measures (2) with a real child, plus the positive control that the
 * instrument sees a host name when the profile lets it through. (1) is a census
 * recorded in the row's note. Written in the shape of `process-supervisor.test.ts`'s
 * credential-family case, whose restore it follows.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessStore } from './process-store.ts'
import { isRestrictedHostEnvironmentKey, ProcessSupervisor } from './process-supervisor.ts'

const PI_NAMES = ['NESSY_PI_SUBPROCESS', 'NESSY_PI_MODEL_API', 'NESSY_PI_MODEL_PROVIDER', 'NESSY_PI_MODEL_BASE_URL'] as const

describe('F1.533 — a supervised tool child under the restricted profile never sees the Pi-process names', () => {
  test('restricted: none of the four reaches the child, even from a host that carries them; trusted-host (CONTROL): all four do', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-f1533-'))
    const previous = new Map(PI_NAMES.map(name => [name, process.env[name]]))
    // Delete, then assign (AGENTS.md's Bun env-slot trap), on the restore path as well.
    for (const name of PI_NAMES) {
      delete process.env[name]
      process.env[name] = name === 'NESSY_PI_SUBPROCESS' ? '1' : `host-${name}`
    }
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const base = {
        sessionKey: { workspaceId: 'w', sessionId: 's' }, semanticId: 'bash',
        command: process.execPath, cwd: root, workspaceRoot: root,
        profile: 'networked' as const, background: false, timeoutMs: 10_000,
        args: ['-e', `process.stdout.write(JSON.stringify(${JSON.stringify(PI_NAMES)}.filter(name => process.env[name] !== undefined)))`],
      }
      // The request shape Pi's host sends: no profile named, so `restricted`.
      const restricted = await supervisor.start({ ...base, executionId: 'f1533-restricted' })
      const trusted = await supervisor.start({ ...base, executionId: 'f1533-trusted', environmentProfile: 'trusted-host' })
      expect({
        restrictedProfile: restricted.environmentProfile,
        restrictedSees: JSON.parse(restricted.output),
        allowlisted: PI_NAMES.filter(name => isRestrictedHostEnvironmentKey(name)),
        trustedSees: JSON.parse(trusted.output),
      }).toEqual({
        restrictedProfile: 'restricted',
        restrictedSees: [],
        allowlisted: [],
        trustedSees: [...PI_NAMES],
      })
    } finally {
      for (const [name, value] of previous) {
        delete process.env[name]
        if (value !== undefined) process.env[name] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
