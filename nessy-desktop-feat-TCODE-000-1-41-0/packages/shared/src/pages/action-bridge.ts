/**
 * Page Action Bridge — mediated source actions for Pages
 *
 * Page JS never talks to sources. It posts a request up to the host, and this
 * broker decides whether the host executes it. Mirrors (and extends) the
 * privilegedExecutionBroker pattern:
 *
 *   render lease  — in-memory, per render instance. Issued when the host
 *                   mounts a page; carries a nonce the page must echo on
 *                   every request (frame identity without a trustable
 *                   Origin). Bound to the page's content digest — content
 *                   changes end the lease.
 *   grant         — persisted in the host-approvals ledger, user-approved,
 *                   content-digest bound (like commandHash) AND expiring.
 *                   Describes a class of calls (api method + path regex, one
 *                   mcp tool, or one pinned script).
 *   request       — one concrete invocation. Must carry a valid lease
 *                   (id + nonce), a fresh unique requestId (replay check),
 *                   and a grant that matches the invocation.
 *
 * Execution is delegated to injected executors (built by the host from the
 * shared source machinery), always under an AbortSignal: every action has a
 * timeout and can be cancelled mid-flight. Credentials are resolved inside
 * the executors at call time and never appear in requests, results, or the
 * audit log.
 *
 * Every decision — lease issued, action executed/rejected/cancelled — is
 * appended to a durable JSONL audit log ({CONFIG_DIR}/logs/page-actions.jsonl),
 * with caller-supplied objects redacted by key name.
 *
 * UA9.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/action-bridge.ts` (Apache-2.0),
 * adapted to our system (plan UA9.2, spec §3 and §16, Review Focus 6):
 * - **Grants live in the host ledger, read per invocation** (reason (b): an agent can write page.json, so the
 *   upstream `page.grants` array is never read — `storage.ts` strips it). A grant is a `page-grant` entry of
 *   `approvals/host-approvals.ts`, MAC-verified on every read; {@link pageGrantRecord} is the one writer shape
 *   (UA9.3's `issueGrant` records it, `revokeGrant` removes it), {@link readPageGrant} the one reader. A grant
 *   revoked while a render lease is live is therefore refused at the next invocation. A host with no ledger key
 *   refuses every grant (`grant-not-found`), the closed failure.
 * - **The content digest is read from the page's bytes**, not from page.json's `contentDigest` field, which an
 *   agent able to write page.json could pin to an old value while changing index.html (codex writes never pass
 *   the Pi/Claude guard on `pages/<slug>/page.json`). With no `workspaceRootPath` (unit tests of the
 *   lease/grant logic alone) the broker falls back to page.json's field.
 * - **Script grants pin the script's bytes** (`scriptSha256`): the entry's `digest` is the script's sha256 and
 *   its `data` carries `{ path, args, runtime }`, the binding `runApprovedScript` (UA8.1) verifies, so a script
 *   edited after the grant is refused (the executor re-hashes first and reports `grant-script-changed`, audited
 *   here) and the swap window between check and spawn is closed by `runApprovedScript`'s private copy. The
 *   page-content binding of a script grant is `data.contentDigest`.
 * - **The API policy annotation names the API tool** (`api_<slug>`): our `evaluateApiEndpointPolicy` scopes a
 *   source's own `allowedApiEndpoints` to that source's tool and fails closed for a call that names none (F1.1152),
 *   so the annotation passes the grant's source. The MCP annotation uses our pool's proxy-name builder
 *   (`buildPoolProxyBaseName`) — upstream's `proxyToolName` is the sanitize half of it (UA9.2 premise, measured).
 * - The MCP executor receives the page's slug, so the host can lease the workspace pool as `page:<slug>`
 *   (`server-core/src/pages/mcp-executor.ts`).
 * - Audit: `{CONFIG_DIR}/logs/page-actions.jsonl`, append-only exactly like `logs/privileged-actions.jsonl`
 *   (`server-core/src/services/privileged-execution-broker.ts`); both size-capped at 10 MB with one `.1`
 *   generation (UA12.62, `audit-rotate.ts` — the "rotated like privileged-actions.jsonl" premise was
 *   refuted at HEAD and both now rotate), every append serialized per path (UA12.177).
 */

import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  PageActionDescriptor,
  PageActionInvocation,
  PageActionRequest,
  PageActionResult,
  PageActionHttpMethod,
  PageScriptRuntime,
  PageConfig,
  PageRenderLease,
} from '@nessy-agent/core';
import { CONFIG_DIR } from '../config/paths.ts';
import { createLogger } from '../utils/debug.ts';
import { redactSensitiveValues } from '../utils/redaction.ts';
import { evaluateApiEndpointPolicy, evaluateMcpToolPolicy, type SourceActionPolicyDecision } from '../agent/source-policy.ts';
import type { PermissionsContext } from '../agent/permissions-config.ts';
import { AUDIT_JSONL_ROTATE_BYTES, appendJsonlRotating } from '../audit-rotate.ts';
import { buildPoolProxyBaseName } from '../mcp/mcp-pool.ts';
import {
  findHostApproval,
  getHostApprovalsKeyProvider,
  readHostApprovals,
  recordHostApproval,
  revokeHostApproval,
  type HostApprovalEntry,
  type HostApprovalKind,
  type HostApprovalsKeyProvider,
  type JsonValue,
} from '../approvals/host-approvals.ts';
import { hasPathTraversal } from './types.ts';
import { computePageContentDigest, loadPageContent } from './storage.ts';
import { PageActionDescriptorSchema } from './validation.ts';

const log = createLogger('page-action-broker');

/** Default render-lease lifetime; re-mounting a page issues a fresh lease */
export const DEFAULT_PAGE_LEASE_TTL_MS = 12 * 60 * 60 * 1000;
/** Default per-action timeout */
export const DEFAULT_PAGE_ACTION_TIMEOUT_MS = 30_000;
/** Default grant lifetime (upstream `DEFAULT_PAGE_GRANT_TTL_MS`, v0.13.4 storage.ts): 30 days */
export const DEFAULT_PAGE_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Replay-cache cap per lease — beyond this the lease must be re-issued */
const MAX_SEEN_REQUEST_IDS_PER_LEASE = 5_000;
/**
 * Host-side per-lease budget. The renderer runs its own PageActionRateLimiter
 * with the same numbers, but that one is advisory — anything that can reach
 * the executeAction RPC bypasses it, so the broker enforces the real cap.
 * Matching the renderer's budget means a well-behaved page never hits this.
 */
export const PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE = 5;
export const PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE = 30;
const PAGE_ACTION_RATE_WINDOW_MS = 60_000;
/**
 * Cap on simultaneously live leases. Expiry alone (12h TTL) lets a re-mount
 * loop grow the lease + replay-cache maps unbounded; past the cap the
 * oldest-issued lease is evicted (audited) — old renders lose their lease and
 * recover by re-mounting, new mounts always work.
 */
export const MAX_LIVE_LEASES = 256;
/**
 * UA12.178 — renderer-gate refusal lines ONE page may write per sliding minute (the same figure as the
 * per-lease action budget). The renderer reports a gate refusal BEFORE its own limiter, so without this
 * a page script looping wrong-nonce messages wrote unbounded lines (and could rotate the real trail out
 * of both generations in seconds — the 2026-10-08 verification). Past the budget the broker counts the
 * reports and writes the count as ONE `page_gate_refusals_suppressed` line at most once per minute (the
 * first report the budget admits a minute after the last such line), or when one of the page's leases
 * is released, expires or is evicted. A count still pending when the app quits is not written.
 */
export const PAGE_GATE_REFUSAL_AUDITS_PER_MINUTE = PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE;

// ============================================================
// Grants (host-approvals ledger, kind `page-grant`)
// ============================================================

/** The ledger kind a page grant is recorded under. */
export const PAGE_GRANT_KIND: HostApprovalKind = 'page-grant';

/** Prefix of the error a script executor throws when the script's bytes no longer match the grant. */
export const PAGE_GRANT_SCRIPT_CHANGED = 'grant-script-changed';

/**
 * A user-approved capability, as the host reads it back from the ledger (upstream's `PageActionGrant`, which
 * core no longer carries). Bound to the page content digest at approval time and to an expiry; a script grant
 * also to the script's bytes.
 */
export interface PageActionGrant {
  /** Stable id, e.g. grant_1a2b3c4d */
  id: string;
  /** Page-supplied purpose shown at approval time — never the authority (UA9.3 shows the descriptor). */
  description?: string;
  action: PageActionDescriptor;
  /** sha256 hex of the page content this grant was approved for */
  contentDigest: string;
  /** sha256 hex of the script's bytes (script grants only) */
  scriptSha256?: string;
  createdAt: number;
  /** Hard expiry (epoch ms) — expired grants are rejected, never auto-renewed */
  expiresAt: number;
}

/** What UA9.3's `issueGrant` passes in: the validated descriptor plus the digests it approved. */
export interface PageGrantInput {
  id: string;
  description?: string;
  action: PageActionDescriptor;
  contentDigest: string;
  /** Required for a script grant: the sha256 of the bytes the user approved (`scriptSha256` of automations). */
  scriptSha256?: string;
  /** Hard expiry (epoch ms); default now + {@link DEFAULT_PAGE_GRANT_TTL_MS}. */
  expiresAt?: number;
}

/** The ledger subject of one page grant: `page:<slug>#<grantId>`. */
export function pageGrantSubject(pageSlug: string, grantId: string): string {
  return `page:${pageSlug}#${grantId}`;
}

/**
 * UA12.112 — what the renderer reports when ITS gate refused a page request before the broker saw it
 * (`page-frame-gates.ts` `checkPageAction` / `checkPageGrantRequest`): such a refusal never reaches
 * {@link PageActionBroker.validate}, so without this report it leaves no line in the audit trail at
 * all (upstream the same; owner posture). The `pageSlug` is the renderer's own; the frame-supplied
 * ids and invocation travel as sent — the line is marked `stage: 'renderer-gate'` so its provenance
 * reads.
 */
export interface PageGateRefusalReport {
  /** Actions (`page_action_rejected`) or grant requests (`page_grant_request_refused`). */
  kind: 'action' | 'grant-request'
  pageSlug: string
  /** The gate's refusal code, in `PageActionRefusal`/`PageGrantRequestRefusal` spelling. */
  code: string
  /** The reason the frame was shown (an action's error text; a grant-request refusal is code-only). */
  reason?: string
  /** Action reports: the frame's correlation id and the lease/grant the request named — unverified. */
  requestId?: string
  leaseId?: string
  grantId?: string
  /** Action reports: the raw invocation; the HOST summarizes and redacts it for the line. */
  invocation?: PageActionInvocation
  /** Grant-request reports: how many requests the refused message carried. */
  requestCount?: number
}

/**
 * The writer shape (`recordHostApproval` input) of a page grant, so writer and reader agree. For a script
 * grant `digest` is the script's sha256 and `data` carries the `{ path, args, runtime }` binding
 * `runApprovedScript` verifies (the default runtime `bun` and empty args spelled out, as the executor runs it).
 */
export function pageGrantRecord(
  pageSlug: string,
  input: PageGrantInput,
  now: number = Date.now(),
): { kind: HostApprovalKind; subject: string; digest: string; expiresAt: string; data: { [key: string]: JsonValue } } {
  const action = PageActionDescriptorSchema.parse(input.action) as PageActionDescriptor;
  const expiresAt = new Date(input.expiresAt ?? now + DEFAULT_PAGE_GRANT_TTL_MS).toISOString();
  const data: { [key: string]: JsonValue } = {
    id: input.id,
    action: JSON.parse(JSON.stringify(action)) as JsonValue,
    contentDigest: input.contentDigest,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  if (action.kind === 'script') {
    if (!input.scriptSha256) throw new TypeError('pageGrantRecord: a script grant needs the sha256 of the approved script');
    data.path = action.script;
    data.args = [...(action.args ?? [])];
    data.runtime = action.runtime ?? 'bun';
    data.scriptSha256 = input.scriptSha256;
  }
  return {
    kind: PAGE_GRANT_KIND,
    subject: pageGrantSubject(pageSlug, input.id),
    digest: action.kind === 'script' ? input.scriptSha256! : input.contentDigest,
    expiresAt,
    data,
  };
}

/** Rebuild a grant from a verified ledger entry; undefined when its data is not a page grant's. */
function grantFromEntry(entry: HostApprovalEntry): PageActionGrant | undefined {
  const data = entry.data;
  if (!data || typeof data.id !== 'string' || typeof data.contentDigest !== 'string') return undefined;
  const parsed = PageActionDescriptorSchema.safeParse(data.action);
  if (!parsed.success) return undefined;
  const action = parsed.data as PageActionDescriptor;
  if (action.kind === 'script' && entry.digest !== data.scriptSha256) return undefined;
  const createdAt = Date.parse(entry.createdAt);
  const expiresAt = entry.expiresAt === undefined ? Number.NaN : Date.parse(entry.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return undefined;
  return {
    id: data.id,
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    action,
    contentDigest: data.contentDigest,
    ...(action.kind === 'script' ? { scriptSha256: entry.digest } : {}),
    createdAt,
    expiresAt,
  };
}

/** The verified, unexpired grant `grantId` of a page, read from the ledger now; undefined otherwise. */
export function readPageGrant(
  workspaceRootPath: string,
  key: Buffer,
  pageSlug: string,
  grantId: string,
  now: number = Date.now(),
): PageActionGrant | undefined {
  const entry = findHostApproval(workspaceRootPath, key, PAGE_GRANT_KIND, pageGrantSubject(pageSlug, grantId), now);
  return entry ? grantFromEntry(entry) : undefined;
}

/** Every verified grant of a page (expired ones included, so a grants dialog can show them as expired). */
export function listPageGrants(workspaceRootPath: string, key: Buffer, pageSlug: string): PageActionGrant[] {
  const prefix = `page:${pageSlug}#`;
  return readHostApprovals(workspaceRootPath, key).entries
    .filter(entry => entry.kind === PAGE_GRANT_KIND && entry.subject.startsWith(prefix))
    .map(grantFromEntry)
    .filter((grant): grant is PageActionGrant => grant !== undefined);
}

/** Record (or replace) a grant in the ledger. Host-side only; the caller has the user's approval. */
export function issuePageGrant(
  workspaceRootPath: string,
  key: Buffer,
  pageSlug: string,
  input: PageGrantInput,
  now: number = Date.now(),
): PageActionGrant {
  const record = pageGrantRecord(pageSlug, input, now);
  const entry = recordHostApproval(workspaceRootPath, key, record, new Date(now));
  const grant = grantFromEntry(entry);
  if (!grant) throw new TypeError('issuePageGrant: the recorded entry does not read back as a grant');
  return grant;
}

/** Remove a grant from the ledger. True when one was removed. */
export function revokePageGrant(workspaceRootPath: string, key: Buffer, pageSlug: string, grantId: string): boolean {
  return revokeHostApproval(workspaceRootPath, key, PAGE_GRANT_KIND, pageGrantSubject(pageSlug, grantId));
}

// ============================================================
// Broker
// ============================================================

export type PageActionValidationErrorCode =
  | 'lease-not-found'
  | 'lease-page-mismatch'
  | 'lease-expired'
  | 'nonce-mismatch'
  | 'replay'
  | 'replay-cache-full'
  | 'content-missing'
  | 'content-changed'
  | 'grant-not-found'
  | 'grant-stale'
  | 'grant-expired'
  | 'grant-mismatch'
  | 'grant-pattern-invalid'
  | 'invocation-path-unsafe'
  | 'rate-limited'
  | 'executor-unavailable';

type ValidationOutcome =
  | { ok: true; grant: PageActionGrant }
  | { ok: false; code: PageActionValidationErrorCode; reason: string };

/**
 * Execution backends, injected by the host process. Implementations resolve
 * credentials lazily (inside the call) and must honor `signal`.
 */
export interface PageActionExecutors {
  /** Execute an api-kind invocation against an API source */
  executeApi?: (
    invocation: { sourceSlug: string; method: PageActionHttpMethod; path: string; params?: Record<string, unknown> },
    options: { signal: AbortSignal },
  ) => Promise<{ status: number; ok: boolean; body: unknown }>;
  /** Execute an mcp-kind invocation against an MCP source (`pageSlug` names the pool leaser, `page:<slug>`) */
  executeMcp?: (
    invocation: { pageSlug: string; sourceSlug: string; toolName: string; args: Record<string, unknown> },
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
  /**
   * Execute a script-kind invocation: run the grant's pinned script on the
   * host. Resolves with the process outcome even on a non-zero exit (the page
   * still wants stdout/stderr); throws only when the script could not run at
   * all (path escape, missing runtime, changed bytes, a refusal).
   */
  executeScript?: (
    invocation: {
      pageSlug: string;
      grantId: string;
      script: string;
      runtime?: PageScriptRuntime;
      args?: string[];
      /** The sha256 the grant pinned */
      scriptSha256: string;
    },
    options: { signal: AbortSignal },
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export interface PageActionBrokerOptions {
  executors: PageActionExecutors;
  /**
   * Workspace root: where the ledger is read and the page's bytes are hashed. Omitted only by tests of the
   * lease logic alone — then no grant can be read (every request is `grant-not-found`) unless `readGrant` is
   * injected, and the content digest falls back to page.json's field.
   */
  workspaceRootPath?: string;
  /** The ledger key's provider; default: the one the host installed (`getHostApprovalsKeyProvider`). */
  keyProvider?: HostApprovalsKeyProvider;
  /** Test seam: replaces the ledger read. */
  readGrant?: (pageSlug: string, grantId: string, now: number) => Promise<PageActionGrant | undefined>;
  /** Audit log path (default: {CONFIG_DIR}/logs/page-actions.jsonl) */
  auditLogPath?: string;
  /** UA12.62 — the audit log's rotation cap (default: {@link AUDIT_JSONL_ROTATE_BYTES} from `../audit-rotate.ts`); a test rotates at a few hundred bytes. */
  auditRotateBytes?: number;
  /** Render-lease lifetime in ms */
  leaseTtlMs?: number;
  /** Per-action timeout in ms */
  actionTimeoutMs?: number;
  /**
   * Workspace context for policy annotation in the audit trail. UA12.102 — a function is read once
   * per ACTION (a broker lives as long as its workspace, so a source added after its build must
   * still have its own rules merged); a plain object is fixed at construction (tests). A throwing
   * getter is logged and annotates with no context (a diagnostics lookup never fails a granted action).
   */
  permissionsContext?: PermissionsContext | (() => PermissionsContext | undefined);
  /**
   * UA12.64 — resolves the pool WIRE name a source's MCP tools are registered under: the
   * resolver-minted `<wire>` of `mcp__<wire>__<tool>` that the MCP executor calls through
   * (`RuntimeSourceHandle.mcpWireName`, read by logicalName — the host reads it from the same
   * workspace capability view). The MCP policy annotation names the call by it, because an
   * `allowedMcpPatterns` rule is written against the spelling a transcript shows — the wire
   * name, not the config slug. Unwired, or undefined for a source the view cannot name, the
   * annotation falls back to the grant's config slug — exact whenever the slug is already a
   * legal wire name (ASCII, no `_`-run edge, ≤ 40 chars). Must not throw; a throwing lookup is
   * logged and reads as no wire name (a diagnostics lookup never fails a granted action).
   */
  resolveMcpWireName?: (sourceSlug: string) => Promise<string | undefined>;
  /** Test hook */
  now?: () => number;
}

export interface CreateLeaseInput {
  pageSlug: string;
  /** Digest of the content actually being rendered */
  contentDigest: string;
}

export class PageActionBroker {
  private readonly executors: PageActionExecutors;
  private readonly workspaceRootPath?: string;
  private readonly keyProvider?: HostApprovalsKeyProvider;
  private readonly readGrantSeam?: PageActionBrokerOptions['readGrant'];
  private readonly auditLogPath: string;
  private readonly auditRotateBytes: number;
  private readonly leaseTtlMs: number;
  private readonly actionTimeoutMs: number;
  private readonly permissionsContextSource?: PageActionBrokerOptions['permissionsContext'];
  private readonly resolveMcpWireName?: PageActionBrokerOptions['resolveMcpWireName'];
  private readonly now: () => number;

  private readonly leases = new Map<string, PageRenderLease>();
  private readonly seenRequestIds = new Map<string, Set<string>>();
  private readonly inFlight = new Map<string, AbortController>();
  /** leaseId → number of actions currently executing */
  private readonly inFlightByLease = new Map<string, number>();
  /** leaseId → start timestamps within the sliding rate window */
  private readonly startTimesByLease = new Map<string, number[]>();
  /** UA12.178 — per page: when its last refusal lines were written, the reports suppressed since, and the last summary line. */
  private readonly gateRefusalBudget = new Map<
    string,
    { written: number[]; suppressed: number; since?: number; lastFlushAt?: number }
  >();

  constructor(options: PageActionBrokerOptions) {
    this.executors = options.executors;
    this.workspaceRootPath = options.workspaceRootPath;
    this.keyProvider = options.keyProvider;
    this.readGrantSeam = options.readGrant;
    this.auditLogPath = options.auditLogPath ?? join(CONFIG_DIR, 'logs', 'page-actions.jsonl');
    this.auditRotateBytes = options.auditRotateBytes ?? AUDIT_JSONL_ROTATE_BYTES;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_PAGE_LEASE_TTL_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_PAGE_ACTION_TIMEOUT_MS;
    this.permissionsContextSource = options.permissionsContext;
    this.resolveMcpWireName = options.resolveMcpWireName;
    this.now = options.now ?? Date.now;
  }

  /** UA12.102 — the annotation's context as of THIS action (see {@link PageActionBrokerOptions.permissionsContext}). */
  private currentPermissionsContext(): PermissionsContext | undefined {
    const source = this.permissionsContextSource;
    if (typeof source !== 'function') return source;
    try {
      return source();
    } catch (error) {
      log.warn(`[PageActionBroker] permissionsContext lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  // ==========================================================
  // Leases
  // ==========================================================

  /**
   * Issue a render lease for one mount of a page. The returned nonce travels
   * into the iframe and must be echoed on every action request.
   */
  createLease(input: CreateLeaseInput): PageRenderLease {
    this.pruneExpiredLeases();

    if (this.leases.size >= MAX_LIVE_LEASES) {
      let oldest: PageRenderLease | undefined;
      for (const lease of this.leases.values()) {
        if (!oldest || lease.issuedAt < oldest.issuedAt) oldest = lease;
      }
      if (oldest) {
        this.dropLease(oldest.leaseId);
        void this.appendAudit({
          event: 'page_lease_evicted',
          pageSlug: oldest.pageSlug,
          leaseId: oldest.leaseId,
          reason: 'lease-store-full',
        });
      }
    }

    const now = this.now();
    const lease: PageRenderLease = {
      leaseId: randomUUID(),
      nonce: randomBytes(16).toString('hex'),
      pageSlug: input.pageSlug,
      contentDigest: input.contentDigest,
      issuedAt: now,
      expiresAt: now + this.leaseTtlMs,
    };

    this.leases.set(lease.leaseId, lease);
    this.seenRequestIds.set(lease.leaseId, new Set());
    void this.appendAudit({
      event: 'page_lease_created',
      pageSlug: lease.pageSlug,
      leaseId: lease.leaseId,
      contentDigest: lease.contentDigest,
      expiresAt: lease.expiresAt,
    });
    return lease;
  }

  /** Drop a lease (page unmounted). Idempotent. */
  releaseLease(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.dropLease(leaseId);
    void this.appendAudit({ event: 'page_lease_released', pageSlug: lease.pageSlug, leaseId });
  }

  /** Every way a lease ends (release, expiry, eviction) comes here — so does the page's pending refusal count. */
  private dropLease(leaseId: string): void {
    const pageSlug = this.leases.get(leaseId)?.pageSlug;
    // UA12.178 / UA12.112 follow-up: a page that goes quiet, or whose lease expires or is evicted, still
    // leaves its total (before 2026-10-08 only releaseLease flushed it, and expiry/eviction lost it).
    if (pageSlug !== undefined) this.flushSuppressedGateRefusals(pageSlug);
    this.leases.delete(leaseId);
    this.seenRequestIds.delete(leaseId);
    this.inFlightByLease.delete(leaseId);
    this.startTimesByLease.delete(leaseId);
  }

  // ==========================================================
  // Per-lease rate limiting (host-side; the renderer limiter is advisory)
  // ==========================================================

  private rateLimitRejection(leaseId: string): { code: 'rate-limited'; reason: string } | null {
    if ((this.inFlightByLease.get(leaseId) ?? 0) >= PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE) {
      return {
        code: 'rate-limited',
        reason: `Too many actions in flight for this render (max ${PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE})`,
      };
    }
    const now = this.now();
    const starts = (this.startTimesByLease.get(leaseId) ?? []).filter(
      (t) => now - t < PAGE_ACTION_RATE_WINDOW_MS,
    );
    this.startTimesByLease.set(leaseId, starts);
    if (starts.length >= PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE) {
      return {
        code: 'rate-limited',
        reason: `Too many actions this minute for this render (max ${PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE}/minute)`,
      };
    }
    return null;
  }

  private noteActionStart(leaseId: string): void {
    this.inFlightByLease.set(leaseId, (this.inFlightByLease.get(leaseId) ?? 0) + 1);
    const starts = this.startTimesByLease.get(leaseId) ?? [];
    starts.push(this.now());
    this.startTimesByLease.set(leaseId, starts);
  }

  private noteActionEnd(leaseId: string): void {
    const current = this.inFlightByLease.get(leaseId) ?? 0;
    if (current <= 1) this.inFlightByLease.delete(leaseId);
    else this.inFlightByLease.set(leaseId, current - 1);
  }

  private pruneExpiredLeases(): void {
    const now = this.now();
    for (const [leaseId, lease] of this.leases) {
      if (now > lease.expiresAt) this.dropLease(leaseId);
    }
  }

  // ==========================================================
  // Validation
  // ==========================================================

  /** The digest of the bytes the page serves NOW (module header); page.json's field only without a workspace. */
  private liveContentDigest(page: PageConfig): string | undefined {
    if (!this.workspaceRootPath) return page.contentDigest;
    const content = loadPageContent(this.workspaceRootPath, page.slug);
    return content === null ? undefined : computePageContentDigest(content);
  }

  /** The grant from the ledger, read per invocation. A key the host cannot load reads as no grant (closed). */
  private async loadGrant(pageSlug: string, grantId: string, now: number): Promise<PageActionGrant | undefined> {
    if (this.readGrantSeam) return this.readGrantSeam(pageSlug, grantId, now);
    if (!this.workspaceRootPath) return undefined;
    let key: Buffer;
    try {
      key = await (this.keyProvider ?? getHostApprovalsKeyProvider()).getKey();
    } catch (error) {
      log.warn(`[PageActionBroker] host-approvals key unavailable; refusing grants: ${error instanceof Error ? error.name : 'error'}`);
      return undefined;
    }
    return readPageGrant(this.workspaceRootPath, key, pageSlug, grantId, now);
  }

  private async validate(page: PageConfig, request: PageActionRequest): Promise<ValidationOutcome> {
    const now = this.now();

    const lease = this.leases.get(request.leaseId);
    if (!lease) {
      return { ok: false, code: 'lease-not-found', reason: 'No render lease for this request — re-mount the page' };
    }
    if (lease.pageSlug !== request.pageSlug || page.slug !== request.pageSlug) {
      return { ok: false, code: 'lease-page-mismatch', reason: 'Lease belongs to a different page' };
    }
    if (now > lease.expiresAt) {
      this.dropLease(request.leaseId);
      return { ok: false, code: 'lease-expired', reason: 'Render lease expired — re-mount the page' };
    }
    if (lease.nonce !== request.nonce) {
      return { ok: false, code: 'nonce-mismatch', reason: 'Request nonce does not match the render lease' };
    }

    const contentDigest = this.liveContentDigest(page);
    if (!contentDigest) {
      return { ok: false, code: 'content-missing', reason: 'Page has no content digest' };
    }
    if (lease.contentDigest !== contentDigest) {
      return { ok: false, code: 'content-changed', reason: 'Page content changed since this render — re-mount the page' };
    }

    const seen = this.seenRequestIds.get(request.leaseId);
    if (seen?.has(request.requestId)) {
      return { ok: false, code: 'replay', reason: 'Request id was already used on this lease' };
    }
    if (seen && seen.size >= MAX_SEEN_REQUEST_IDS_PER_LEASE) {
      return { ok: false, code: 'replay-cache-full', reason: 'Lease exhausted its request budget — re-mount the page' };
    }

    // Read the ledger now (never page.json): a revoked grant is refused at the very next invocation. The
    // `now` passed through lets an expired entry read as expired (below) instead of as missing.
    const grant = await this.loadGrant(page.slug, request.grantId, Number.NEGATIVE_INFINITY);
    if (!grant) {
      return { ok: false, code: 'grant-not-found', reason: `No grant ${request.grantId} on this page` };
    }
    if (grant.contentDigest !== contentDigest) {
      return { ok: false, code: 'grant-stale', reason: 'Grant was approved for older page content — re-approval required' };
    }
    if (now > grant.expiresAt) {
      return { ok: false, code: 'grant-expired', reason: 'Grant expired — re-approval required' };
    }

    const mismatch = this.invocationMismatch(grant, request.invocation);
    if (mismatch) return mismatch;

    return { ok: true, grant };
  }

  /**
   * The lease and replay checks of {@link validate}, repeated synchronously after its awaited grant read: a lease
   * released meanwhile is refused, and a duplicate requestId that raced the read is refused as a replay.
   */
  private recheckAfterGrantRead(request: PageActionRequest): ValidationOutcome | null {
    const seen = this.seenRequestIds.get(request.leaseId);
    if (!this.leases.has(request.leaseId) || !seen) {
      return { ok: false, code: 'lease-not-found', reason: 'No render lease for this request — re-mount the page' };
    }
    if (seen.has(request.requestId)) {
      return { ok: false, code: 'replay', reason: 'Request id was already used on this lease' };
    }
    if (seen.size >= MAX_SEEN_REQUEST_IDS_PER_LEASE) {
      return { ok: false, code: 'replay-cache-full', reason: 'Lease exhausted its request budget — re-mount the page' };
    }
    return null;
  }

  /** Check the concrete invocation against the grant's descriptor. */
  private invocationMismatch(grant: PageActionGrant, invocation: PageActionInvocation): ValidationOutcome | null {
    if (grant.action.kind !== invocation.kind) {
      return { ok: false, code: 'grant-mismatch', reason: `Grant allows ${grant.action.kind} actions, request is ${invocation.kind}` };
    }

    if (grant.action.kind === 'api' && invocation.kind === 'api') {
      if (grant.action.method !== invocation.method) {
        return { ok: false, code: 'grant-mismatch', reason: `Grant allows ${grant.action.method}, request is ${invocation.method}` };
      }
      // Reject traversal BEFORE the pattern match. fetch normalizes `..`, so a
      // raw path that matches the anchored pattern could still resolve to a
      // different endpoint with the real credential. Rejecting here guarantees
      // the (raw) path later forwarded to executeApi is traversal-free — match
      // and execution agree without transforming the forwarded path.
      if (hasPathTraversal(invocation.path)) {
        return { ok: false, code: 'invocation-path-unsafe', reason: 'Request path contains a directory-traversal segment' };
      }
      let pattern: RegExp;
      try {
        // Anchored: the grant's pattern must match the WHOLE path.
        pattern = new RegExp(`^(?:${grant.action.pathPattern})$`);
      } catch {
        return { ok: false, code: 'grant-pattern-invalid', reason: 'Grant path pattern is not a valid regex' };
      }
      const path = invocation.path.startsWith('/') ? invocation.path : `/${invocation.path}`;
      if (!pattern.test(path)) {
        return { ok: false, code: 'grant-mismatch', reason: `Path ${path} does not match the granted pattern` };
      }
      return null;
    }

    if (grant.action.kind === 'mcp' && invocation.kind === 'mcp') {
      if (grant.action.toolName !== invocation.toolName) {
        return { ok: false, code: 'grant-mismatch', reason: `Grant allows tool ${grant.action.toolName}, request is ${invocation.toolName}` };
      }
      return null;
    }

    if (grant.action.kind === 'script' && invocation.kind === 'script') {
      // Nothing to compare: the trigger carries no script/args, so the grant's
      // descriptor is authoritative and any script-for-script pair matches.
      return null;
    }

    return { ok: false, code: 'grant-mismatch', reason: 'Unsupported action kind' };
  }

  // ==========================================================
  // Execution
  // ==========================================================

  /**
   * Validate and execute one page action request against the ledger's grants
   * and the page's current bytes. Never throws — failures come back as { ok: false }.
   */
  async executeAction(page: PageConfig, request: PageActionRequest): Promise<PageActionResult> {
    const startTime = this.now();
    const invocationSummary = this.summarizeInvocation(request.invocation);

    let validation = await this.validate(page, request);
    // validate() awaits the ledger read; upstream's was synchronous. Re-check what that await let another call
    // change, in the same tick as burning the id below — or two concurrent duplicates would both run.
    if (validation.ok) validation = this.recheckAfterGrantRead(request) ?? validation;
    if (!validation.ok) {
      void this.appendAudit({
        event: 'page_action_rejected',
        pageSlug: request.pageSlug,
        requestId: request.requestId,
        leaseId: request.leaseId,
        grantId: request.grantId,
        invocation: invocationSummary,
        code: validation.code,
        reason: validation.reason,
      });
      return {
        requestId: request.requestId,
        ok: false,
        error: `${validation.code}: ${validation.reason}`,
        durationMs: this.now() - startTime,
      };
    }

    const { grant } = validation;

    // Rate check AFTER validation (a throttled caller learns nothing about
    // lease/grant validity it didn't already prove) and BEFORE burning the
    // requestId — a throttled request never executed, so its id stays usable.
    const limited = this.rateLimitRejection(request.leaseId);
    if (limited) {
      void this.appendAudit({
        event: 'page_action_rejected',
        pageSlug: request.pageSlug,
        requestId: request.requestId,
        leaseId: request.leaseId,
        grantId: request.grantId,
        invocation: invocationSummary,
        code: limited.code,
        reason: limited.reason,
      });
      return {
        requestId: request.requestId,
        ok: false,
        error: `${limited.code}: ${limited.reason}`,
        durationMs: this.now() - startTime,
      };
    }

    this.seenRequestIds.get(request.leaseId)?.add(request.requestId);
    this.noteActionStart(request.leaseId);

    // Policy annotation: grants ARE the user approval, so a
    // requires-approval verdict does not block a granted call — but the
    // audit trail records how the same call would classify for an agent.
    // UA12.64: the MCP annotation names the call the way the pool names it —
    // `mcp__<wire>__<tool>` over the resolver-minted wire name — because an
    // `allowedMcpPatterns` rule is written against that spelling; the config
    // slug annotates differently whenever it is not already the wire name.
    let mcpWireName: string | undefined;
    if (grant.action.kind === 'mcp' && this.resolveMcpWireName) {
      try {
        mcpWireName = await this.resolveMcpWireName(grant.action.sourceSlug);
      } catch (error) {
        log.warn(`[PageActionBroker] resolveMcpWireName(${grant.action.sourceSlug}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const permissionsContext = this.currentPermissionsContext();
    const policy: SourceActionPolicyDecision =
      grant.action.kind === 'api'
        ? evaluateApiEndpointPolicy(
            grant.action.method,
            request.invocation.kind === 'api' ? request.invocation.path : undefined,
            permissionsContext,
            // Ours scopes a source's own rules to its API tool (F1.1152) — name it, or they never apply.
            `api_${grant.action.sourceSlug}`,
          )
        : grant.action.kind === 'mcp'
          ? evaluateMcpToolPolicy(
              buildPoolProxyBaseName(mcpWireName ?? grant.action.sourceSlug, grant.action.toolName),
              (request.invocation.kind === 'mcp' ? request.invocation.args : undefined) ?? {},
              permissionsContext ? { permissionsContext } : undefined,
            )
          : // script: host command execution — always approval-worthy for an agent,
            // annotated here purely for the audit trail (the grant is the approval).
            { decision: 'requires-approval', description: `script: ${grant.action.script}` };

    const controller = new AbortController();
    this.inFlight.set(request.requestId, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.actionTimeoutMs)]);

    let result: PageActionResult;
    let errorCode: string | undefined;
    try {
      if (grant.action.kind === 'api' && request.invocation.kind === 'api') {
        if (!this.executors.executeApi) {
          result = this.unavailableResult(request, startTime, 'API executor not wired in this host');
        } else {
          const outcome = await this.executors.executeApi(
            {
              sourceSlug: grant.action.sourceSlug,
              method: request.invocation.method,
              path: request.invocation.path,
              params: request.invocation.params,
            },
            { signal },
          );
          result = {
            requestId: request.requestId,
            ok: outcome.ok,
            status: outcome.status,
            body: outcome.body,
            ...(outcome.ok ? {} : { error: `API responded with status ${outcome.status}` }),
            durationMs: this.now() - startTime,
          };
        }
      } else if (grant.action.kind === 'mcp' && request.invocation.kind === 'mcp') {
        if (!this.executors.executeMcp) {
          result = this.unavailableResult(request, startTime, 'MCP executor not wired in this host');
        } else {
          const body = await this.executors.executeMcp(
            {
              pageSlug: page.slug,
              sourceSlug: grant.action.sourceSlug,
              toolName: request.invocation.toolName,
              args: request.invocation.args ?? {},
            },
            { signal },
          );
          result = {
            requestId: request.requestId,
            ok: true,
            body,
            durationMs: this.now() - startTime,
          };
        }
      } else if (grant.action.kind === 'script' && request.invocation.kind === 'script') {
        if (!this.executors.executeScript || !grant.scriptSha256) {
          result = this.unavailableResult(request, startTime, 'Script executor not wired in this host');
        } else {
          const outcome = await this.executors.executeScript(
            {
              pageSlug: page.slug,
              grantId: grant.id,
              script: grant.action.script,
              runtime: grant.action.runtime,
              args: grant.action.args,
              scriptSha256: grant.scriptSha256,
            },
            { signal },
          );
          const ok = outcome.exitCode === 0;
          result = {
            requestId: request.requestId,
            ok,
            // The page sees stdout/stderr/exit even on failure — a script that
            // exits non-zero with a useful message should surface that message.
            body: { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr },
            ...(ok ? {} : { error: `Script exited with code ${outcome.exitCode ?? 'null'}` }),
            durationMs: this.now() - startTime,
          };
        }
      } else {
        // invocationMismatch() makes this unreachable; keep a safe fallback.
        result = this.unavailableResult(request, startTime, 'Invocation kind does not match grant');
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? 'Cancelled'
        : error instanceof Error ? error.message : 'Unknown error';
      if (!aborted && message.startsWith(`${PAGE_GRANT_SCRIPT_CHANGED}:`)) errorCode = PAGE_GRANT_SCRIPT_CHANGED;
      result = {
        requestId: request.requestId,
        ok: false,
        error: message,
        durationMs: this.now() - startTime,
      };
    } finally {
      this.inFlight.delete(request.requestId);
      this.noteActionEnd(request.leaseId);
    }

    void this.appendAudit({
      event: 'page_action_executed',
      pageSlug: request.pageSlug,
      requestId: request.requestId,
      leaseId: request.leaseId,
      grantId: grant.id,
      invocation: invocationSummary,
      policyDecision: policy.decision,
      ok: result.ok,
      ...(errorCode ? { code: errorCode } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error ? { error: result.error } : {}),
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Abort an in-flight action. Returns false when the request is unknown or
   * already settled.
   */
  cancelAction(requestId: string): boolean {
    const controller = this.inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    void this.appendAudit({ event: 'page_action_cancelled', requestId });
    return true;
  }

  /**
   * UA12.112 — append the audit line for a request the RENDERER's gate refused: an action reads
   * `page_action_rejected` (the broker's own rejection event, `stage: 'renderer-gate'` — the same
   * codes the broker refuses with, decided one hop earlier) and a refused grant request reads
   * `page_grant_request_refused`, an event the broker alone cannot write (no dialog ever opened).
   * The invocation is summarized and redacted HERE, so the redaction authority stays host-side.
   * Fire-and-forget like every audit write; the report shape is the wire's (`PageGateRefusalReport`).
   * UA12.178: budgeted per page ({@link PAGE_GATE_REFUSAL_AUDITS_PER_MINUTE}); the overflow is coalesced
   * into at most one `page_gate_refusals_suppressed` line a minute — host-side, so a renderer that skips
   * its own limiter is held too.
   */
  auditGateRefusal(report: PageGateRefusalReport): void {
    if (!this.takeGateRefusalBudget(report.pageSlug)) return; // UA12.178
    void this.appendAudit(
      report.kind === 'action'
        ? {
            event: 'page_action_rejected',
            stage: 'renderer-gate',
            pageSlug: report.pageSlug,
            ...(report.requestId !== undefined ? { requestId: report.requestId } : {}),
            ...(report.leaseId !== undefined ? { leaseId: report.leaseId } : {}),
            ...(report.grantId !== undefined ? { grantId: report.grantId } : {}),
            ...(report.invocation !== undefined ? { invocation: this.summarizeInvocation(report.invocation) } : {}),
            code: report.code,
            ...(report.reason !== undefined ? { reason: report.reason } : {}),
          }
        : {
            event: 'page_grant_request_refused',
            stage: 'renderer-gate',
            pageSlug: report.pageSlug,
            code: report.code,
            ...(report.reason !== undefined ? { reason: report.reason } : {}),
            ...(report.requestCount !== undefined ? { requests: report.requestCount } : {}),
          },
    );
  }

  /**
   * UA12.178 — take one line of `pageSlug`'s refusal budget ({@link PAGE_GATE_REFUSAL_AUDITS_PER_MINUTE} per
   * sliding minute). Over budget the report is only counted; a report the budget admits again first
   * writes the coalesced count — but at most once per {@link PAGE_ACTION_RATE_WINDOW_MS}: under a
   * staggered flood the sliding budget frees one slot at a time, and flushing on every freed slot wrote
   * one summary line per slot (the UA12.112 follow-up, 2026-10-08). The map is bounded: past
   * {@link MAX_LIVE_LEASES} pages, entries whose minute has passed are flushed and dropped.
   */
  private takeGateRefusalBudget(pageSlug: string): boolean {
    const now = this.now();
    const entry = this.gateRefusalBudget.get(pageSlug) ?? { written: [], suppressed: 0 };
    entry.written = entry.written.filter((t) => now - t < PAGE_ACTION_RATE_WINDOW_MS);
    this.gateRefusalBudget.set(pageSlug, entry);
    if (entry.written.length >= PAGE_GATE_REFUSAL_AUDITS_PER_MINUTE) {
      entry.suppressed += 1;
      entry.since ??= now;
      return false;
    }
    if (entry.lastFlushAt === undefined || now - entry.lastFlushAt >= PAGE_ACTION_RATE_WINDOW_MS) {
      this.flushSuppressedGateRefusals(pageSlug);
    }
    entry.written.push(now);
    if (this.gateRefusalBudget.size > MAX_LIVE_LEASES) {
      for (const [slug, other] of this.gateRefusalBudget) {
        if (slug === pageSlug || other.written.some((t) => now - t < PAGE_ACTION_RATE_WINDOW_MS)) continue;
        this.flushSuppressedGateRefusals(slug);
        this.gateRefusalBudget.delete(slug);
      }
    }
    return true;
  }

  /** UA12.178 — write the pending suppressed count of `pageSlug` as ONE line, if there is one. */
  private flushSuppressedGateRefusals(pageSlug: string): void {
    const entry = this.gateRefusalBudget.get(pageSlug);
    if (!entry || entry.suppressed === 0) return;
    void this.appendAudit({
      event: 'page_gate_refusals_suppressed',
      stage: 'renderer-gate',
      pageSlug,
      suppressed: entry.suppressed,
      ...(entry.since !== undefined ? { since: new Date(entry.since).toISOString() } : {}),
    });
    entry.suppressed = 0;
    entry.since = undefined;
    entry.lastFlushAt = this.now();
  }

  /** Number of live leases (diagnostics/tests). */
  get leaseCount(): number {
    this.pruneExpiredLeases();
    return this.leases.size;
  }

  private unavailableResult(request: PageActionRequest, startTime: number, reason: string): PageActionResult {
    return {
      requestId: request.requestId,
      ok: false,
      error: `executor-unavailable: ${reason}`,
      durationMs: this.now() - startTime,
    };
  }

  /** Audit-safe summary of an invocation: shape + redacted params, no bodies. */
  private summarizeInvocation(invocation: PageActionInvocation): Record<string, unknown> {
    if (invocation.kind === 'api') {
      return {
        kind: 'api',
        method: invocation.method,
        path: invocation.path,
        ...(invocation.params ? { params: redactSensitiveValues(invocation.params) } : {}),
      };
    }
    if (invocation.kind === 'mcp') {
      return {
        kind: 'mcp',
        toolName: invocation.toolName,
        ...(invocation.args ? { args: redactSensitiveValues(invocation.args) } : {}),
      };
    }
    // script is a bare trigger — the resolved grantId in the same audit row
    // carries the script path/runtime/args, so there is nothing to summarize.
    return { kind: 'script' };
  }

  /**
   * Append an audit event (fire-and-forget, mirrors privileged-execution-broker:
   * audit failures are logged but never fail the action). UA12.177: through the per-path
   * serialized {@link appendJsonlRotating}, so back-to-back appends (createLease's evicted +
   * created) cannot race the rotation.
   */
  private async appendAudit(payload: Record<string, unknown>): Promise<void> {
    try {
      await appendJsonlRotating(
        this.auditLogPath,
        JSON.stringify({ timestamp: new Date().toISOString(), ...payload }),
        this.auditRotateBytes,
      );
    } catch (error) {
      log.warn(`[PageActionBroker] Failed to write audit log: ${error}`);
    }
  }
}
