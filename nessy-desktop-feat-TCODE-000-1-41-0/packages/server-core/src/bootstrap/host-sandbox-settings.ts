/**
 * The ONE sandbox composition this host enforces, and the shape a
 * `/doctor`-class report needs to describe it.
 *
 * Split out of `SessionManager` for the same reason `managed-policy-resolution`
 * was split out of `storage-runtime`: `debug-your-config.md:46` requires the
 * terminal doctor to print "read-only installation and settings diagnostics
 * without starting a session", and the composition used to be a private static
 * on a class that cannot be constructed without a session store, a capability
 * resolver and a process supervisor.
 *
 * It MOVED rather than being copied. A diagnosis surface that derives the policy
 * a second time is a surface that can report something other than what is
 * enforced — the exact failure R25c shipped, and the reason this file has one
 * definition with two readers.
 */

import { latchedHomeDir } from '@nessy-agent/shared/config/home-latch'
import { credentialDenyRoots } from '@nessy-agent/session-tools-core'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import {
  documentedUncarriedSandboxKeys,
  getUserSandboxSettings,
  loadStoredConfig,
  resolveSandboxSettings,
  type ResolvedSandboxSettings,
} from '@nessy-agent/shared/config'
import {
  foldSandboxRuleRoots,
  sandboxRootsFromClaudeRules,
} from '@nessy-agent/shared/agent/pi-harness/sandbox-permission-rules'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { dpStateRootDeniedBy, resolveDpStateRoot } from '@nessy-agent/shared/auth/dp'

export interface HostSandboxSettingsOptions {
  /**
   * Where a rule that cannot be restated as a filesystem boundary is reported.
   *
   * Injected because the two readers log differently — a session manager has a
   * logger, a terminal report has stdout — and because a diagnosis surface must
   * not emit a warning as a side effect of being asked a question.
   */
  onDiagnostic?: (message: string) => void
  /** DI seam for tests only; production resolves the real dp state root. */
  dpStateRoot?: () => string | undefined
}

/**
 * Sandbox settings for every supervised process on this host.
 *
 * The managed policy is the FLOOR, so its denies are a minimum, its grants are
 * a maximum, and `allowUnsandboxedCommands: false` cannot be unlocked by the
 * user layer. The seeded credential denies ride the same floor: they are the
 * only protection those files have, because no isolation profile bounds reads.
 *
 * Permission rules merge in here too, not only `sandbox.*` keys —
 * `sandboxing.md:372`: "Paths from both `sandbox.filesystem` settings and
 * permission rules are merged together into the final sandbox configuration."
 * The policy carries both halves (`policy.sandbox` and `policy.claudeRules`),
 * so the conversion is local and needs no new input.
 */
export function resolveHostSandboxSettings(
  policy: ManagedPiPolicyV1,
  options: HostSandboxSettingsOptions = {},
): ResolvedSandboxSettings {
  const seeded = hostCredentialDenyRoots()
  // P6.233 — the NAMING half of accept-and-name. The parser stopped throwing for
  // a key Claude Code documents and this product does not carry, because one
  // such key used to cost the operator every other key in the same block; the
  // key is still not silently swallowed. Emitted from the RAW user layer,
  // before the parse strips them, on the same channel `debug-your-config.md`
  // requires the terminal doctor to be able to print without starting a
  // session. It projects nothing, and the sentence says so.
  for (const key of documentedUncarriedSandboxKeys(loadStoredConfig()?.sandbox)) {
    options.onDiagnostic?.(
      `${key} is documented by Claude Code and is accepted here without effect: this product's OS `
      + 'isolation is off by owner decision and its wrapper is its own, so the key reaches no layer. '
      + 'Every other key in the same block still applies.',
    )
  }
  const managed = policy.sandbox ?? {}
  const ruleRoots = sandboxRootsFromClaudeRules(policy.claudeRules)
  for (const diagnostic of ruleRoots.diagnostics) options.onDiagnostic?.(diagnostic)
  const folded = foldSandboxRuleRoots(
    { ...managed, deniedReadRoots: [...seeded, ...(managed.deniedReadRoots ?? [])] },
    ruleRoots,
  )
  const resolved = resolveSandboxSettings([...folded.layers, getUserSandboxSettings()], { floor: folded.floor })
  return withDpStateRootWriteGrant(resolved, options.onDiagnostic, options.dpStateRoot)
}

/**
 * dp refreshes its ~1-hour access token by WRITING into its state root, so a
 * seatbelt-sandboxed `dp ...` that cannot write there reports "not authorized"
 * while the user's own terminal says they are (the Desktop-vs-terminal split
 * this grant closes; owner decision 2026-08-06). Host-owned like the credential
 * deny floor: appended AFTER resolution, so a managed grant cap cannot discard
 * it. existsSync-gated inside resolveDpStateRoot — no ~/.dp is created for
 * users who never ran dp; a first dp install mid-session binds on restart.
 * The helper guarantees an absolute, realpathed, non-root, non-home path, so
 * skipping filesystemRoots validation here is sound.
 */
export function withDpStateRootWriteGrant(
  resolved: ResolvedSandboxSettings,
  onDiagnostic?: (message: string) => void,
  dpStateRoot: () => string | undefined = resolveDpStateRoot,
): ResolvedSandboxSettings {
  const root = dpStateRoot()
  if (!root || resolved.additionalWritableRoots.includes(root)) return resolved
  // DA1.49 · the predicate moved into `shared` so this refusal and the plugin
  // binding's grant (`agent/backend/internal/runtime-resolver.ts` symbol
  // `resolvePluginDpRuntime`, which had no deny check at all) are ONE mechanism
  // rather than two that happen to agree.
  const denied = dpStateRootDeniedBy(root, [...resolved.deniedReadRoots, ...resolved.deniedWriteRoots])
  if (denied) {
    // Seatbelt emits denies after allows, so this grant would never bind —
    // say so once instead of shipping a silent no-op.
    onDiagnostic?.(`dp state root ${root} lies inside the denied root ${denied}; dp commands in sandboxed shells cannot refresh their session.`)
    return resolved
  }
  return Object.freeze({
    ...resolved,
    additionalWritableRoots: Object.freeze([...resolved.additionalWritableRoots, root]),
  }) as ResolvedSandboxSettings
}

/**
 * F1.193 — the credential read floor's seed for server-core, and the ONE resolver
 * both of its bootstrap readers use: {@link resolveHostSandboxSettings} (the
 * ProcessSupervisor's sandbox) and the doctor's `collectSandboxFilesystem`
 * (`managed-policy-resolution.ts`).
 *
 * Anchored on `latchedHomeDir()`, not `os.homedir()` — P3.168's reason, the same
 * one `pi-harness/isolation.ts` states beside its own seed: on Node a confirmed
 * managed `HOME` moves `os.homedir()` mid-session, and the floor's whole job is to
 * name the tree holding `~/.nessy/dp_auth_creds.json`, which stays under the latch.
 * Before this, these two sites read the live home while the funnel read the latch,
 * so the three could describe two homes — ORDER-dependent, and unmeasured.
 *
 * `isolation.ts` keeps its own identical expression rather than importing this:
 * the isolation funnel sits under every capability probe, and pulling this
 * module's settings graph into it would buy nothing a shared argument does not.
 */
export function hostCredentialDenyRoots(platform: NodeJS.Platform = process.platform): string[] {
  return credentialDenyRoots(latchedHomeDir(), CONFIG_DIR, platform)
}
