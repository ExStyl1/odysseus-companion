/**
 * Pages script action executor.
 *
 * Backs PageActionBroker.executors.executeScript for script-kind grants: runs
 * the grant's pinned workspace-relative script through the SAME hardened runner
 * automations and page refreshes use — argv/no-shell, workspace-contained
 * (symlink-aware), allowlisted env, SIGTERM→SIGKILL timeout. The broker has
 * already validated the lease, nonce, replay cache, and grant before this runs,
 * and enforces the per-action timeout by aborting `signal`.
 *
 * Contract with the broker: resolve with the process outcome even on a non-zero
 * exit (the page still wants stdout/stderr); throw only when the script could
 * not run at all (path escape, missing runtime, changed bytes, a refusal) —
 * which the broker turns into an `ok:false` action result.
 *
 * NOTE: this deliberately does NOT set `ScriptAction.page`. That field makes the
 * runner overwrite the page's scheduled-refresh completion marker
 * (recordPageRefresh); an on-demand run a user clicks must not masquerade as a
 * refresh. NESSY_PAGE_* env is still injected via buildBaseScriptEnv so the
 * script can find its own data dir.
 *
 * UA9.2 — copied from craft-agents-oss `v0.13.4:packages/server-core/src/pages/script-executor-bridge.ts`
 * (Apache-2.0), adapted (plan UA9.2, spec §15, Review Focus 6):
 * - **`runApprovedScript` is the only entry** (UA8.1; upstream called its raw executor). The
 *   approval it verifies is the page grant itself (`page-grant` / `page:<slug>#<grantId>`), whose `digest` is the
 *   script's sha256 and whose `data` carries `{ path, args, runtime }` (`pageGrantRecord`), so the bytes that run
 *   are the bytes the user granted, read once and spawned from a private copy (the swap window is closed there).
 * - **Re-hash first.** The bridge hashes the script before the run and refuses with `grant-script-changed:` when
 *   the bytes no longer match the grant's `scriptSha256` — the broker audits that code. `runApprovedScript`
 *   verifies again on the bytes it actually runs, so this early check is the readable refusal, not the guarantee.
 * - **The managed policy still applies** (`isLocalAutomationManagedDisabled`, asked by `runApprovedScript` at use
 *   time): an administrator who turned local automations off has turned page scripts off too, grant or not —
 *   managed deny beats a grant.
 * - Its refusals and runs reach the injected audit port with `trigger: 'page-action'` (the host wires it to
 *   `logs/privileged-actions.jsonl`, as for automations).
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  buildBaseScriptEnv,
  runApprovedScript,
  scriptSha256,
  type ScriptAction,
  type ScriptActionResult,
  type ApprovedScriptRequest,
  type ScriptAuditPort,
} from '@nessy-agent/shared/automations'
import { PAGE_GRANT_KIND, PAGE_GRANT_SCRIPT_CHANGED, pageGrantSubject } from '@nessy-agent/shared/pages'
import type { PageScriptRuntime } from '@nessy-agent/core'
import type { HostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import type { Logger } from '../runtime/platform'

export interface PagesScriptExecutorDeps {
  workspaceRootPath: string
  workspaceId?: string
  log: Logger
  /** Audit sink for the runner's refusal/run events (production: the privileged broker's `auditEvent`). */
  audit?: ScriptAuditPort
  /** The ledger key's provider; default: the one the host installed. */
  keyProvider?: HostApprovalsKeyProvider
  /** Test seam — defaults to the real runner. */
  runScript?: (request: ApprovedScriptRequest) => Promise<ScriptActionResult>
}

export function createPagesScriptExecutor(deps: PagesScriptExecutorDeps) {
  const runScript = deps.runScript ?? runApprovedScript

  return async (
    invocation: {
      pageSlug: string
      grantId: string
      script: string
      runtime?: PageScriptRuntime
      args?: string[]
      scriptSha256: string
    },
    options: { signal: AbortSignal },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
    // Re-hash before the run: a script edited after the grant gets the coded refusal the broker audits.
    if (!isAbsolute(invocation.script)) {
      const scriptPath = join(deps.workspaceRootPath, invocation.script)
      if (existsSync(scriptPath)) {
        let current: string | undefined
        try {
          current = scriptSha256(readFileSync(scriptPath))
        } catch {
          current = undefined // unreadable: let the runner give its own reason
        }
        if (current !== undefined && current !== invocation.scriptSha256) {
          deps.log.warn(`[pages] script changed since its grant for ${invocation.pageSlug}: ${invocation.script}`)
          throw new Error(`${PAGE_GRANT_SCRIPT_CHANGED}: ${invocation.script} changed since it was granted — approve it again`)
        }
      }
    }

    const action: ScriptAction = {
      type: 'script',
      script: invocation.script,
      ...(invocation.runtime ? { runtime: invocation.runtime } : {}),
      ...(invocation.args ? { args: invocation.args } : {}),
      // No `page` — see file header (must not clobber the refresh marker).
    }

    const env = buildBaseScriptEnv({
      workspaceRootPath: deps.workspaceRootPath,
      page: invocation.pageSlug,
    })

    // Forward the broker's abort signal so its per-action deadline / cancel
    // actually kills the subprocess (the runner SIGTERMs then SIGKILLs).
    const result = await runScript({
      action,
      workspaceRootPath: deps.workspaceRootPath,
      env,
      trigger: 'page-action',
      approval: { kind: PAGE_GRANT_KIND, subject: pageGrantSubject(invocation.pageSlug, invocation.grantId) },
      signal: options.signal,
      ...(deps.workspaceId ? { workspaceId: deps.workspaceId } : {}),
      ...(deps.audit ? { audit: deps.audit } : {}),
      ...(deps.keyProvider ? { keyProvider: deps.keyProvider } : {}),
    })

    if (result.blocked) {
      // Could not run at all (refusal / path escape / runtime missing) — surface as a
      // throw so the broker reports ok:false with this message.
      deps.log.warn(`[pages] script blocked for ${invocation.pageSlug}: ${result.stderr}`)
      throw new Error(result.stderr || `Script could not run: ${invocation.script}`)
    }

    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}
