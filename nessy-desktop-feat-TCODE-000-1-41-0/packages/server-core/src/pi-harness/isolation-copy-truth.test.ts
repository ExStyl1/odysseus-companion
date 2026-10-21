/**
 * P2.331 — the Process Isolation copy is asserted against the ISOLATION PLAN,
 * not against a second copy of the prose.
 *
 * ## Why this file exists
 *
 * Three strings in the Permissions settings page each stated as universal
 * something the isolation resolver scopes, and a user reading them was told the
 * opposite of what the host does:
 *
 * - `isolationDisabled` said *"Isolation is turned off … so none of the profiles
 *   below are applied"*. Measured 2026-08-28: with the master switch OFF a Codex
 *   session still ships `default_permissions = "nessy_runtime"` with its
 *   credential denies, the pinned binary ACCEPTS the profile, and the decoy read
 *   is REFUSED — identical to the switch being on. Pinned by
 *   `codex-responses-adapter/src/__tests__/sandbox-enforcement.test.ts`
 *   ("SHIPPED DEFAULT (sandbox master switch OFF): the profile is ACCEPTED and
 *   the decoy read is REFUSED"), which is a different package and cannot be
 *   imported here — `server-core` does not depend on it. So THAT half is
 *   asserted there and only its shape is guarded below.
 * - `isolationSectionDesc` said *"Every profile grants whole-filesystem read"*.
 *   Measured below: every available profile emits a read deny naming a
 *   credential root, composed inside `resolveProcessIsolation` from
 *   `credentialDenyRoots` and NOT defeatable by a caller who passes none.
 * - `isolationEgressOpenDesc` said *"A sandboxed command can reach any host"*.
 *   Measured below: `read-only` and `workspace` emit `(deny network*)`.
 *
 * ## What makes a green here mean something
 *
 * Every claim is checked against the plan `resolveProcessIsolation` actually
 * returns for that profile — the same function `probeIsolationCapabilities` and
 * a real supervised process go through — so a copy edit that re-introduces the
 * overclaim fails, and so does a resolver change that makes the corrected copy
 * false. A string-only assertion would pass with the resolver deleted.
 *
 * The copy is written against MEASUREMENT, not against intent: whether the
 * master switch OUGHT to disable the Codex profile is an open owner decision
 * (OQ-11). If that behaviour changes, these strings change with it.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { resolveProcessIsolation } from './isolation.ts'
import { PROBED_ISOLATION_PROFILES, probeIsolationCapabilities } from './isolation-capabilities.ts'

/**
 * Whether this host can RENDER a darwin isolation plan at all.
 *
 * `seatbeltProfile` below pins `platform: 'darwin'` because the copy under test
 * describes the profile SHAPE and seatbelt is the backend whose rules are
 * readable as text. The launcher, though, is chosen from the real
 * `process.platform`: on a host with no usable `/usr/bin/sandbox-exec` EVERY
 * profile answers `undefined`, the first case's own positive control
 * (`checked.length > 0`) fires, and the second's `toBeDefined()` fails. Both
 * are then reporting the absence of a launcher, not a copy defect, and their
 * message asks the runner to install something it cannot.
 *
 * The verdict is the product's own: `probeIsolationCapabilities` resolves each
 * profile through the same `resolveProcessIsolation` and never throws. Never a
 * platform list — a macOS host with the binary removed is as unable as a Linux
 * container, and that is the case a host list gets wrong.
 *
 * The THIRD case is deliberately left running. It reads only locale strings, it
 * passed on the CI runner while these two failed, and a suite that skips its
 * platform-free half wherever the platform is wrong has stopped guarding the
 * copy everywhere it could.
 */
const darwinPlansRender = (await probeIsolationCapabilities({ platform: 'darwin' })).profiles.workspace
if (!darwinPlansRender.available) {
  // stderr, so the reason travels with the run rather than living only here.
  console.warn(
    '[isolation-copy-truth.test.ts] the two cases that read an isolation PLAN are SKIPPED: '
    + `this host cannot render a darwin plan — ${darwinPlansRender.reason ?? 'no reason reported'}`
    + ` (${darwinPlansRender.remediation ?? 'no remediation reported'}). The copy-only case still runs.`,
  )
}

/** A throwaway root, torn down per file. Nothing is spawned. */
function probeRoots(): { root: string; workspaceRoot: string; scratchRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'nessy-isolation-copy-'))
  const workspaceRoot = join(root, 'workspace')
  const scratchRoot = join(root, 'scratch')
  for (const path of [workspaceRoot, scratchRoot]) mkdirSync(path, { recursive: true })
  return { root, workspaceRoot, scratchRoot }
}

/**
 * The seatbelt profile for one isolation profile, or `undefined` when this host
 * cannot run it. Deliberately platform-pinned to `darwin`: the copy under test
 * describes the profile SHAPE, and the backend that renders it as text here is
 * the one whose rules are readable. `isolated-code` is unavailable on this host
 * and is skipped rather than asserted about.
 */
function seatbeltProfile(profile: string, roots: ReturnType<typeof probeRoots>): string | undefined {
  try {
    const plan = resolveProcessIsolation({
      platform: 'darwin',
      profile: profile as never,
      command: process.execPath,
      args: [],
      workspaceRoot: roots.workspaceRoot,
      workingDirectory: roots.workspaceRoot,
      scratchRoot: roots.scratchRoot,
      windowsSandboxStateRoot: join(roots.root, 'windows-sandbox'),
    })
    return plan.args.join('\n')
  } catch {
    return undefined
  }
}

describe('P2.331 — the isolation copy matches the isolation plan', () => {
  test.skipIf(!darwinPlansRender.available)('NO profile grants whole-filesystem read: every one denies a credential root, with no caller input', () => {
    const roots = probeRoots()
    try {
      const credentialRoot = join(homedir(), '.ssh')
      const checked: string[] = []
      for (const profile of PROBED_ISOLATION_PROFILES) {
        const rendered = seatbeltProfile(profile, roots)
        if (rendered === undefined) continue
        checked.push(profile)
        // The caller passes NO `deniedReadRoots`; the floor is composed inside
        // `resolveProcessIsolation`, which is the whole property.
        expect(rendered).toContain(credentialRoot)
      }
      // Positive control for the loop itself: an empty `checked` would make the
      // assertion above vacuous, and a host with no available profile at all is
      // a rig failure rather than a passing measurement.
      expect(checked.length).toBeGreaterThan(0)

      // The copy therefore may not claim unrestricted reads.
      expect(en['settings.permissions.isolationSectionDesc']).not.toContain('whole-filesystem read')
      for (const copy of [en['settings.permissions.isolationSectionDesc'], ru['settings.permissions.isolationSectionDesc']]) {
        expect(copy.length).toBeGreaterThan(0)
      }
      expect(en['settings.permissions.isolationSectionDesc']).toContain('credential')
      expect(ru['settings.permissions.isolationSectionDesc']).toContain('учётными данными')
    } finally {
      rmSync(roots.root, { recursive: true, force: true })
    }
  })

  test.skipIf(!darwinPlansRender.available)('a sandboxed command canNOT reach any host: read-only and workspace deny network outright', () => {
    const roots = probeRoots()
    try {
      const denies = ['read-only', 'workspace']
      const allows = ['networked', 'plugin-mcp']
      for (const profile of denies) {
        const rendered = seatbeltProfile(profile, roots)
        expect(rendered).toBeDefined()
        expect(rendered).toContain('(deny network*')
      }
      // The discriminating half. Without it, a resolver that denied network on
      // EVERY profile would pass the block above while making the copy wrong in
      // the other direction.
      for (const profile of allows) {
        const rendered = seatbeltProfile(profile, roots)
        expect(rendered).toBeDefined()
        expect(rendered).toContain('(allow network*')
      }

      // So the open-egress copy must name the profiles it is true of rather
      // than speaking for every sandboxed command.
      expect(en['settings.permissions.isolationEgressOpenDesc']).not.toContain('A sandboxed command can reach any host')
      expect(en['settings.permissions.isolationEgressOpenDesc']).toContain('read-only')
      expect(ru['settings.permissions.isolationEgressOpenDesc']).toContain('read-only')
    } finally {
      rmSync(roots.root, { recursive: true, force: true })
    }
  })

  test('the master-switch copy scopes itself to host process isolation and names the runtime it does not cover', () => {
    // The behavioural half is pinned in `codex-responses-adapter`; what is
    // guarded here is that the string stopped making the global claim the
    // measurement refutes.
    for (const copy of [en['settings.permissions.isolationDisabled'], ru['settings.permissions.isolationDisabled']]) {
      expect(copy).toContain('sandbox.enabled')
      expect(copy).toContain('Codex')
    }
    expect(en['settings.permissions.isolationDisabled'])
      .not.toContain('none of the profiles below are applied')
    // F1.1071 (after F1.1057, which took the credential floor out of codex's profile): the copy
    // credits what the host still writes, the protected-folder profile, and no credential deny.
    // The needles are spellable in this corpus: both locales carried them until F1.1071.
    expect(en['settings.permissions.isolationDisabled']).toContain('.git and the other protected folders read-only')
    expect(ru['settings.permissions.isolationDisabled']).toContain('.git и другие защищённые папки только для чтения')
    expect(en['settings.permissions.isolationDisabled']).not.toMatch(/credential/i)
    expect(ru['settings.permissions.isolationDisabled']).not.toContain('учётных данных')
    // F1.787: Plan and Explore resolve codex's read-only sandbox with the switch off, so the copy no
    // longer says the switch widens it there.
    expect(en['settings.permissions.isolationDisabled']).toContain('read-only in Plan and Don\'t ask,') // F1.1052: Explore retired; F1.1056
    expect(ru['settings.permissions.isolationDisabled']).toContain('read-only в режимах «План» и «Не спрашивать»') // F1.1056: dontAsk is read-only too
    expect(en['settings.permissions.isolationDisabled']).not.toContain('widens')
    // 2026-09-11 (W12-c, attribution corrected by W13-a) · two lines pinning
    // `config.json` stood here and outlived their own subject. NOT at the hands
    // of `461961d99` (P2.331), which kept the where-to-set-it sentence: the
    // remover is `dee76327a` (P6.327, 2026-09-06), which put the master switch
    // on screen directly above this notice and dropped a sentence that then
    // pointed past a control standing next to it. The pin was red from
    // 2026-09-06, not from 2026-08-28.
    //
    // Deleted rather than re-spelled, in BOTH directions on purpose. The half
    // it stood for — "it still has to tell the user how to turn it back on" —
    // is the SETTING KEY, and that is already asserted for both locales in the
    // loop above, so nothing is weakened. And the obvious re-spelling, a
    // `not.toContain('config.json')`, would go red on the day somebody
    // correctly puts the where-to-set-it sentence back: a guard that fires when
    // its subject is FIXED. Whether the copy should name the file again is a
    // product-copy decision, reported as a row rather than taken here.
  })
})
