import { createHash } from 'node:crypto'
// UA12.177: the audit append goes through appendJsonlRotating (imported at file end)
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import type { Logger } from '../runtime/platform'

export interface PrivilegedExecutionRequest {
  requestId: string
  /** Owning workspace — pairs with sessionId as the composite session identity so
   *  two workspaces reusing the same sessionId never share a privileged request. */
  workspaceId: string
  sessionId: string
  command: string
  commandHash: string
  reason?: string
  impact?: string
  approvalTtlSeconds: number
  createdAt: number
  expiresAt: number
}

interface PendingPrivilegedRequest extends PrivilegedExecutionRequest {
  policyAllowed: boolean
  policyReason?: string
}

const DEFAULT_APPROVAL_TTL_SECONDS = 120
const AUDIT_LOG_PATH = join(CONFIG_DIR, 'logs', 'privileged-actions.jsonl')

/**
 * PrivilegedExecutionBroker
 *
 * Owns privileged-execution approval binding and auditing.
 * Execution itself is delegated to backend tool execution paths.
 *
 * **This audit sink is deliberately NOT provider-gated, and it is local-only**
 * (P6.42, 2026-08-30). Every write — `createRequest`, `resolveApproval` and the
 * public `auditEvent` — is reached from `SessionManager`'s generic permission
 * paths (`handleAgentPermissionRequest`, `respondToPermission`), which hang off
 * `managed.agent.onPermissionRequest` and therefore run for Pi, the Claude SDK
 * and Codex alike. Measured: no `resolveManagedProvider` gate anywhere in those
 * methods, against 20 such gates elsewhere in the same file — a `grep -a` for
 * `resolveManagedProvider(managed) === 'pi'` and its negation returns 21 hits and
 * one of them (`:15308`) is a comment DESCRIBING a gate rather than a gate, so
 * read the hits before counting them.
 *
 * That makes this file the counterexample that gives the OTLP stream's Pi gate
 * its meaning. `pi-harness/otlp-telemetry.ts` is Pi-only; this is uniform; and
 * the two differ because of where they GO, not from house style. This one
 * appends to a JSONL under the host's own config dir and is never exported, so a
 * runtime contributing nothing to it is visibly missing to whoever opens the
 * file — whereas a partial SIEM stream reads as "nothing happened", which for an
 * audit surface is worse than no stream at all.
 *
 * So anything that starts EXPORTING this file inherits that problem, and must
 * carry a coverage marker the way the OTLP resource does. Note also that this
 * sink records `command` verbatim: that is defensible for a local operator log
 * and is NOT for a wire.
 */
export class PrivilegedExecutionBroker {
  private pending = new Map<string, PendingPrivilegedRequest>()

  constructor(private logger: Logger, private options: PrivilegedExecutionBrokerOptions = {}) {}

  createRequest(input: {
    requestId: string
    workspaceId: string
    sessionId: string
    command: string
    reason?: string
    impact?: string
    approvalTtlSeconds?: number
  }): PrivilegedExecutionRequest {
    const now = Date.now()
    const ttl = input.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS
    const policy = this.validatePolicy(input.command)

    const request: PendingPrivilegedRequest = {
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      command: input.command,
      commandHash: this.hashCommand(input.command),
      reason: input.reason,
      impact: input.impact,
      approvalTtlSeconds: ttl,
      createdAt: now,
      expiresAt: now + ttl * 1000,
      policyAllowed: policy.allowed,
      policyReason: policy.reason,
    }

    this.pending.set(input.requestId, request)
    void this.appendAudit({
      event: 'privileged_request_created',
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      commandHash: request.commandHash,
      command: request.command,
      policyAllowed: request.policyAllowed,
      policyReason: request.policyReason,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    })

    return request
  }

  resolveApproval(
    requestId: string,
    approved: boolean,
    options?: { expectedCommandHash?: string },
  ): {
    ok: boolean
    reason?: string
    request?: PrivilegedExecutionRequest
  } {
    const request = this.pending.get(requestId)
    if (!request) {
      return { ok: false, reason: 'No pending privileged request found' }
    }

    this.pending.delete(requestId)

    if (options?.expectedCommandHash && options.expectedCommandHash !== request.commandHash) {
      void this.appendAudit({
        event: 'privileged_request_hash_mismatch',
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        expectedCommandHash: options.expectedCommandHash,
        actualCommandHash: request.commandHash,
      })
      return { ok: false, reason: 'Command hash mismatch for privileged approval request' }
    }

    if (!request.policyAllowed) {
      void this.appendAudit({
        event: 'privileged_request_blocked_by_policy',
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
        policyReason: request.policyReason,
      })
      return { ok: false, reason: request.policyReason ?? 'Command is not allowed by privileged policy' }
    }

    if (Date.now() > request.expiresAt) {
      void this.appendAudit({
        event: 'privileged_request_expired',
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
        expiresAt: request.expiresAt,
      })
      return { ok: false, reason: 'Privileged approval request expired' }
    }

    void this.appendAudit({
      event: approved ? 'privileged_request_approved' : 'privileged_request_denied',
      requestId: request.requestId,
      sessionId: request.sessionId,
      commandHash: request.commandHash,
      resolvedAt: Date.now(),
    })

    return {
      ok: true,
      request: {
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        command: request.command,
        commandHash: request.commandHash,
        reason: request.reason,
        impact: request.impact,
        approvalTtlSeconds: request.approvalTtlSeconds,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      },
    }
  }

  private hashCommand(command: string): string {
    return createHash('sha256').update(command, 'utf8').digest('hex')
  }

  private validatePolicy(command: string): { allowed: boolean; reason?: string } {
    const normalized = command.trim().toLowerCase()
    const allowlisted =
      /^brew\s+install\s+--cask\s+/.test(normalized) ||
      /^brew\s+upgrade\s+--cask\s+/.test(normalized) ||
      /^installer\s+-pkg\s+.+\s+-target\s+\//.test(normalized)

    if (!allowlisted) {
      return {
        allowed: false,
        reason: 'Privileged execution policy only allows brew cask install/upgrade and installer -pkg -target / commands',
      }
    }

    return { allowed: true }
  }

  auditEvent(event: string, payload: Record<string, unknown>): void {
    void this.appendAudit({ event, ...payload })
  }

  private async appendAudit(payload: Record<string, unknown>): Promise<void> {
    const auditLogPath = this.options.auditLogPath ?? AUDIT_LOG_PATH
    const rotateBytes = this.options.auditRotateBytes ?? AUDIT_JSONL_ROTATE_BYTES
    try {
      // UA12.177 — serialized per path across every broker instance (module-level chain).
      await appendJsonlRotating(auditLogPath, JSON.stringify({ timestamp: new Date().toISOString(), ...payload }), rotateBytes)
    } catch (error) {
      this.logger.warn('[PrivilegedExecutionBroker] Failed to write audit log:', error)
    }
  }
}

/**
 * UA12.62 — the audit sink's test seams: the path (`AUDIT_LOG_PATH` by default) and the rotation
 * cap (`AUDIT_JSONL_ROTATE_BYTES` by default, `@nessy-agent/shared/audit-rotate`). Declared at
 * file end: the docs cite lines 51 and 63 above, which an insertion here would move.
 */
interface PrivilegedExecutionBrokerOptions {
  auditLogPath?: string
  auditRotateBytes?: number
}

// UA12.62 — appended below the highest lines the docs cite (51 and 63 of
// docs/superpowers/specs/2026-07-29-inert-worklist.md:74), so no anchor moves;
// import declarations are hoisted.
import { AUDIT_JSONL_ROTATE_BYTES, appendJsonlRotating } from '@nessy-agent/shared/audit-rotate'
