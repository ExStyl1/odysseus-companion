import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessIsolationProfile } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import type { WindowsSandboxRuntimeBinding } from '@nessy-agent/shared/agent/backend'
import type { IsolationCapabilityReportV1, IsolationProfileCapabilityV1 } from '@nessy-agent/core/types'
import {
  resolveSandboxNetworkEnforcement,
  type ResolvedSandboxSettings,
} from '@nessy-agent/shared/config'
import { resolveProcessIsolation, type ProcessIsolationInput, type ProcessIsolationPlan } from './isolation.ts'
import {
  isolationUnavailableReason,
  isolationUnavailableRemediation,
} from './isolation-remediation.ts'

export {
  ISOLATION_UNAVAILABLE_PREFIX,
  isolationUnavailable,
} from './isolation-remediation.ts'

/**
 * Profiles a supervised process can actually be asked for.
 *
 * `none` is in-process only and never reaches an isolation backend. Ordered
 * least-to-most privileged for display.
 */
export const PROBED_ISOLATION_PROFILES: readonly Exclude<ProcessIsolationProfile, 'none'>[] = Object.freeze([
  'read-only', 'workspace', 'networked', 'plugin-mcp', 'isolated-code',
])

/**
 * Server-side view of the wire DTO: the profile keys are narrowed to the
 * profiles that actually exist, and `platform` to the Node platform union.
 * Structurally assignable to {@link IsolationCapabilityReportV1}, which is what
 * crosses the RPC boundary.
 */
export type IsolationProfileCapability = IsolationProfileCapabilityV1

export interface IsolationCapabilityReport extends IsolationCapabilityReportV1 {
  platform: NodeJS.Platform
  profiles: Record<Exclude<ProcessIsolationProfile, 'none'>, IsolationProfileCapability>
}

/**
 * Report which isolation profiles this host can actually run, without starting
 * a turn.
 *
 * Resolves each profile through the SAME `resolveProcessIsolation` a real
 * supervised process uses, against a throwaway root — so an available entry
 * carries the backend string a real run would record, and an unavailable one
 * carries the reason a real run would throw. Nothing is spawned by the probe
 * itself: the launcher checks underneath are cached `spawnSync` calls on `true`,
 * and the win32 path only stats and verifies the pinned toolchain. That is also
 * the only report of the win32 case where `resolveWindowsSandboxRuntime`
 * returns `undefined` silently and the absence otherwise surfaces as a spawn
 * failure much later.
 *
 * NEVER throws. An unavailable backend is a REPORT at probe time; failing
 * closed is the job of the execution path, not of the diagnosis.
 */
export async function probeIsolationCapabilities(options: {
  platform?: NodeJS.Platform
  windowsSandboxRuntime?: WindowsSandboxRuntimeBinding
  /** Throwaway root for the probe's workspace/scratch dirs. */
  probeRoot?: string
  /** Test seam; production always uses the real resolver. */
  resolve?: (input: ProcessIsolationInput) => ProcessIsolationPlan
  /**
   * The host's resolved `sandbox.network`, when the caller has it. Supplied so
   * the report can DISCLOSE the egress posture; the answer is computed by
   * `resolveSandboxNetworkEnforcement`, the same unit the supervisor enforces
   * from, so this surface cannot drift from what actually runs. Omitting it
   * leaves `network` absent rather than guessing a posture.
   */
  network?: ResolvedSandboxSettings['network']
  /**
   * The host's resolved `sandbox.enabled`. Disclosed for the same reason
   * `network` is: everything else here answers "what COULD run", and since the
   * switch ships off by default a report of available profiles describes a
   * layer that is not applied. Omitting it leaves the field absent rather than
   * implying the layer is on.
   */
  sandboxEnabled?: boolean
} = {}): Promise<IsolationCapabilityReport> {
  const platform = options.platform ?? process.platform
  const resolve = options.resolve ?? resolveProcessIsolation
  const profiles = {} as Record<Exclude<ProcessIsolationProfile, 'none'>, IsolationProfileCapability>

  let workspaceRoot: string | undefined
  let scratchRoot: string | undefined
  let windowsSandboxStateRoot: string | undefined
  try {
    const root = options.probeRoot ?? mkdtempSync(join(tmpdir(), 'nessy-isolation-probe-'))
    workspaceRoot = join(root, 'workspace')
    scratchRoot = join(root, 'scratch')
    windowsSandboxStateRoot = join(root, 'windows-sandbox')
    for (const path of [workspaceRoot, scratchRoot]) mkdirSync(path, { recursive: true })
  } catch {
    // A probe that cannot even make a scratch root still reports; it does not throw.
  }

  for (const profile of PROBED_ISOLATION_PROFILES) {
    if (workspaceRoot === undefined || scratchRoot === undefined) {
      profiles[profile] = {
        available: false,
        remediation: 'the probe could not create a temporary root, so isolation could not be checked',
      }
      continue
    }
    try {
      const plan = resolve({
        platform,
        profile,
        command: process.execPath,
        args: [],
        workspaceRoot,
        workingDirectory: workspaceRoot,
        scratchRoot,
        windowsSandboxStateRoot,
        ...(options.windowsSandboxRuntime ? { windowsSandboxRuntime: options.windowsSandboxRuntime } : {}),
      })
      profiles[profile] = { available: true, backend: plan.backend }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = isolationUnavailableReason(message, platform, profile)
      profiles[profile] = {
        available: false,
        ...(reason ? { reason } : {}),
        remediation: isolationUnavailableRemediation(message),
      }
    }
  }

  const switchState = options.sandboxEnabled === undefined ? {} : { sandboxEnabled: options.sandboxEnabled }
  if (!options.network) return { platform, profiles, ...switchState }
  const enforcement = resolveSandboxNetworkEnforcement(options.network)
  return {
    platform,
    profiles,
    ...switchState,
    network: {
      egress: enforcement.egress,
      source: enforcement.source,
      unenforceable: enforcement.unenforceable,
    },
  }
}
