/**
 * Child-process probe for `agent/__tests__/claude-launch-base-url.test.ts` —
 * F1.966, the LAUNCH-environment `ANTHROPIC_BASE_URL` against a direct Claude
 * connection that names no endpoint.
 *
 * WHY A CHILD AT ALL. The defect lives in the launch environment of the host
 * process: `MANAGED_ANTHROPIC_AUTH_ENV_BASELINE` (`config/llm-connections.ts`)
 * freezes the value at module load, and `resetManagedAnthropicAuthEnvVars`
 * restores it on every connection save. Assigning `process.env` inside a test
 * body happens AFTER that snapshot, so an in-suite rig would never see the
 * restore that makes the defect. The test launches this file WITH (and, as the
 * control, WITHOUT) a fabricated value, and the arms below walk the real host
 * lifecycle in order: boot reset → `postInit`'s delete → a save's reset.
 *
 * Every side effect is behind `import.meta.main`, so importing the table below
 * from the test never runs the probe (or its `process.exit`) in the runner.
 */
import { resetManagedAnthropicAuthEnvVars } from '../../../config/llm-connections.ts'
import { collectRejectedUserSettingsLayers } from '../../../config/storage.ts'
import { getProviderLabelFromType } from '../../diagnostics.ts'
import { buildClaudeSubprocessEnv } from '../../options.ts'

/** The loopback address a `claude-runtime` session's adapter would carry. */
export const LOOPBACK_BASE_URL = 'http://127.0.0.1:65530'

/** Fabricated, never a real key. */
const DIRECT_OVERRIDES = { ANTHROPIC_API_KEY: 'sk-ant-f1966-fabricated' }

if (import.meta.main) {
  const hostHas = (): boolean => ({ ...process.env }).ANTHROPIC_BASE_URL !== undefined
  const direct = (): string | null => buildClaudeSubprocessEnv({ ...DIRECT_OVERRIDES }).ANTHROPIC_BASE_URL ?? null
  const arms: Record<string, { hostHas: boolean; child: string | null }> = {}

  // `SessionManager.initialize()` — the boot reset.
  resetManagedAnthropicAuthEnvVars()
  arms['boot-reset'] = { hostHas: hostHas(), child: direct() }

  // A direct session's `postInit` deletes the name from the shared env.
  delete process.env.ANTHROPIC_BASE_URL
  arms['after-postInit-delete'] = { hostHas: hostHas(), child: direct() }
  // Collected HERE, while the host copy is gone: the record must follow the
  // launch presence, not whichever of the delete and the reset ran last.
  const record = collectRejectedUserSettingsLayers().find(layer => layer.key === 'ANTHROPIC_BASE_URL')

  // SETUP / SAVE of the default / SET_DEFAULT — `reinitializeAuth`'s reset,
  // which restores the launch value under the live direct session.
  resetManagedAnthropicAuthEnvVars()
  arms['after-save-reset'] = { hostHas: hostHas(), child: direct() }

  // CONTROL: a `claude-runtime` session's loopback base URL is the connection's.
  const runtimeChild = buildClaudeSubprocessEnv({
    ANTHROPIC_API_KEY: 'not-needed',
    ANTHROPIC_BASE_URL: LOOPBACK_BASE_URL,
  }).ANTHROPIC_BASE_URL ?? null

  console.log(JSON.stringify({
    arms,
    runtimeChild,
    // The diagnostics label for a connection with no base URL, AFTER the save
    // put the launch value back into the host env.
    providerLabel: getProviderLabelFromType(undefined, undefined),
    record: record ? { source: record.source, reason: record.reason } : null,
  }))
  // The config graph leaves the loop alive; exit rather than wait it out.
  process.exit(0)
}
