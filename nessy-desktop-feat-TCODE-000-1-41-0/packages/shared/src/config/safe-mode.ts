/**
 * Safe mode — a session that loads NO third-party code, while managed policy
 * still binds.
 *
 * `env-vars.md:318`, quoted whole:
 *
 * > | `CLAUDE_CODE_SAFE_MODE` | Set to `1` to start in safe mode: CLAUDE.md,
 * > skills, plugins, hooks, MCP servers, custom commands and agents, output
 * > styles, workflows, custom themes, custom keybindings, status line and
 * > file-suggestion commands, LSP servers, and auto-memory do not load, for
 * > troubleshooting a broken configuration. Managed settings policy still
 * > applies, including policy-configured hooks, status line, and
 * > file-suggestion commands; managed plugins, managed skills, managed
 * > CLAUDE.md, and policy-configured MCP servers do not. Equivalent to passing
 * > [`--safe-mode`](/docs/en/cli-reference#cli-flags). Directly spawned child
 * > processes inherit the variable |
 *
 * ## This is a posture, not a debug flag
 *
 * The half that makes it a security posture is the second sentence: the
 * organization's policy still binds. An incident response can start a session
 * that runs none of the code a compromised plugin, skill or MCP server could
 * have supplied, WITHOUT also dropping the deny rules the organization relies
 * on. A flag that turned both off would be a bypass, not a recovery mode.
 *
 * ## One gate, not eleven
 *
 * The switch is read in exactly ONE production decision point:
 * `buildCapabilityResolutionInputsV2` (`server-core/src/bootstrap/storage-runtime.ts`),
 * the single funnel where every capability input is gathered before the
 * resolver runs. Safe mode returns the EMPTY input set there, so every
 * downstream projection — the agent runtime view, the user catalog, the
 * composer catalog — is empty by construction.
 *
 * A scatter of `if (safeMode)` checks across the eleven loaders would be a
 * latent hole: the twelfth subsystem, added later, would silently escape it.
 * Gating the inputs instead means a new capability KIND is covered on the day
 * it is added, because it has no record to be resolved from.
 *
 * Managed policy does NOT travel through this funnel. Managed permission rules
 * are resolved by `bootstrap/managed-policy-resolution.ts` and applied by the
 * permission layer; the managed inputs this funnel does carry
 * (`managedPiPolicy`) are RESTRICTIONS applied to discovered records — allow
 * lists, deny lists, force-enable/block activations. With no records left to
 * filter they have nothing to do, and nothing they would have permitted is
 * loaded. That asymmetry is exactly the doc's "managed plugins, managed skills,
 * managed CLAUDE.md, and policy-configured MCP servers do not [load]" while
 * "managed settings policy still applies".
 *
 * ## Naming
 *
 * NOT related to `SAFE_MODE_CONFIG` in `agent/mode-types.ts`, which is the
 * "safe" PERMISSION mode (a per-turn tool policy). This is a start-up posture
 * for the whole session and the two are independent.
 */

export type SafeModeEnvRecord = Record<string, string | undefined>

/**
 * The Nessy spelling. Set by `--safe-mode` on the CLI so directly spawned
 * child processes inherit it, which is what the doc's last sentence requires.
 */
export const SAFE_MODE_ENV_VAR = 'NESSY_SAFE_MODE'

/** The documented Claude spelling, accepted as a compat alias. */
export const SAFE_MODE_COMPAT_ENV_VAR = 'CLAUDE_CODE_SAFE_MODE'

/**
 * The surfaces `env-vars.md:318` names, in doc order. Exported so the gate's
 * per-surface proof enumerates the contract rather than whatever the runtime
 * view happens to expose today.
 */
export const SAFE_MODE_SUPPRESSED_SURFACES = Object.freeze([
  'instructions',
  'skills',
  'plugins',
  'hooks',
  'mcp-servers',
  'commands',
  'agents',
  'output-styles',
  'workflows',
  'lsp-servers',
  'memory',
] as const)

function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/**
 * Whether this process starts in safe mode.
 *
 * Follows the `isCronDisabled` precedent for an aliased pair: the Nessy name
 * wins when both are present, so a wrapper that exports our spelling is not
 * silently overridden by an inherited Claude one, and the accepted values are
 * `1/true/yes/on`.
 */
export function isSafeModeEnabled(env: SafeModeEnvRecord = process.env): boolean {
  if (env[SAFE_MODE_ENV_VAR] !== undefined) return isTruthyFlag(env[SAFE_MODE_ENV_VAR])
  return isTruthyFlag(env[SAFE_MODE_COMPAT_ENV_VAR])
}
