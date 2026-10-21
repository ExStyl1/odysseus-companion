/**
 * Child-process probe for `managed-env-subprocess-spread.test.ts` (P2.487).
 *
 * A FILE rather than a string the test writes at run time, for the two reasons
 * its sibling `proxy-env-spread-probe.ts` records: a freshly created temp script
 * pays macOS's first-execution scan on every run, and a fixture under `src/` is
 * typechecked like everything else.
 *
 * It must run in a process whose managed names have NEVER been deleted — that
 * is the whole point. The unlock is STICKY for the rest of the process, so an
 * in-process assertion passes with the fix removed and proves nothing.
 *
 * Two hops, deliberately:
 *  - `spread` is the operation every spawn site in this repo performs
 *    (`buildPiSubprocessEnv`, `buildClaudeSubprocessEnv`,
 *    `CodexRuntimeManager.spawn` are all `{ ...process.env }`).
 *  - `inherited` is a REAL grandchild launched with that spread as its `env`,
 *    so the verdict is "the subprocess received it", not "an object literal
 *    contained it".
 */
import { applyManagedEnv } from '../../managed-env.ts'

/** The names the probe applies and reports on. */
export const MANAGED_ENV_PROBE_NAMES = [
  // Special-cased by Bun; the measured case in AGENTS.md.
  'HTTPS_PROXY',
  'NO_PROXY',
  // ALSO special-cased and NOT a proxy name — the premise correction P2.487
  // measured. It is in this module's `transport` category for a security
  // reason, so an admin setting it and it not reaching a child is not cosmetic.
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // Positive control: an arbitrary name is unaffected either way, so a run in
  // which this one is ALSO missing is a broken rig rather than a caught defect.
  'P2487_ARBITRARY_CONTROL',
] as const

const APPLIED: Record<string, string> = {
  HTTPS_PROXY: 'http://managed.proxy:3128',
  NO_PROXY: 'internal.corp',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  P2487_ARBITRARY_CONTROL: 'control',
}

/**
 * EVERY side effect below is behind `import.meta.main`, and that guard is not
 * tidiness. The test file imports {@link MANAGED_ENV_PROBE_NAMES} from here so
 * the two halves cannot drift; without the guard that import runs this module's
 * body — including its `process.exit(0)` — inside the TEST process, which
 * terminated the runner at import time and reported **exit 0 with zero tests
 * executed**. A green run that asserted nothing is the exact failure this whole
 * fixture exists to rule out, so it is worth the four extra lines. Its sibling
 * `proxy-env-spread-probe.ts` avoids the question by exporting nothing.
 */
if (import.meta.main) {
  if (process.argv.includes('--report-inherited')) {
    // The grandchild arm: report what THIS process actually inherited.
    const inherited: Record<string, string | undefined> = {}
    for (const name of MANAGED_ENV_PROBE_NAMES) inherited[name] = process.env[name]
    console.log(JSON.stringify(inherited))
    process.exit(0)
  }

  // `managed-file` is the passthrough source — nothing is withheld, so every
  // name above reaches `writeResolution`, the function under test.
  const application = applyManagedEnv(APPLIED, { source: 'managed-file', confirmed: false })

  const spread: Record<string, string | undefined> = { ...process.env }
  const read: Record<string, string | undefined> = {}
  const inSpread: Record<string, boolean> = {}
  for (const name of MANAGED_ENV_PROBE_NAMES) {
    read[name] = process.env[name]
    inSpread[name] = name in spread
  }

  const grandchild = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, '--report-inherited'],
    // EXACTLY what every spawn site in this repo does.
    env: spread as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const grandchildOut = grandchild.stdout.toString().trim()

  console.log(JSON.stringify({
    read,
    inSpread,
    set: [...application.set],
    inherited: grandchildOut === '' ? null : JSON.parse(grandchildOut.split('\n').at(-1)!),
    grandchildStderr: grandchildOut === '' ? grandchild.stderr.toString() : '',
  }))
  // The config graph leaves the loop alive; exit rather than wait it out.
  process.exit(0)
}
