/**
 * Tests for the PageActionBroker — lease/nonce/replay checks, grant
 * validation (digest + expiry + descriptor matching), execution via
 * injected executors, cancellation, and the audit trail.
 *
 * UA9.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/action-bridge.test.ts` (Apache-2.0),
 * adapted: upstream puts grants in `page.grants`; ours are read from the host ledger per invocation, so the
 * upstream cases (kept as written) reach their grants through the broker's `readGrant` seam — `makePage({ grants })`
 * sets what the seam answers — and a second block drives the REAL ledger (`approvals/host-approvals.ts`) and the
 * page's bytes on disk for the UA9.2 arms:
 * - positive: a ledger grant authorizes its call; the API policy annotation names `api_<slug>`, so a source's own
 *   `allowedApiEndpoints` allow the page's POST on its own source and ask on another (F1.1152);
 * - negative: a content change (bytes on disk, page.json's field untouched) invalidates the grant; a replay is
 *   refused, also when two requests with one id race the awaited grant read; a grant written into page.json with
 *   the right digest is refused; a forged (un-MACed) ledger entry is refused; a grant revoked while its render
 *   lease is live is refused at the next invocation; a script whose bytes changed after the grant is refused and audited as `grant-script-changed`; no ledger key → refused.
 */

import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { PageActionRequest, PageConfig, PageRenderLease } from '@nessy-agent/core';
import {
  MAX_LIVE_LEASES,
  PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE,
  PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE,
  PAGE_GRANT_SCRIPT_CHANGED,
  PageActionBroker,
  issuePageGrant,
  listPageGrants,
  pageGrantRecord,
  readPageGrant,
  revokePageGrant,
  type PageActionExecutors,
  type PageActionGrant,
} from './action-bridge.ts';
import { HOST_APPROVALS_FILE, type HostApprovalsKeyProvider } from '../approvals/host-approvals.ts';
import { settleJsonlAppends } from '../audit-rotate.ts';
import { computePageContentDigest } from './storage.ts';
import { permissionsConfigCache, type PermissionsContext } from '../agent/permissions-config.ts';
import { evaluateMcpToolPolicy } from '../agent/source-policy.ts';
import { buildPoolProxyBaseName } from '../mcp/mcp-pool.ts';

/** source-policy pulls the mode-manager graph: a cold start of seconds on this machine (UA9.1's budget). */
setDefaultTimeout(120_000);

const DIGEST_V1 = 'a'.repeat(64);
const DIGEST_V2 = 'b'.repeat(64);

describe('pages/action-bridge', () => {
  let tempDir: string;
  let auditPath: string;
  let clock: { now: number };
  /** What the `readGrant` seam answers — set by `makePage({ grants })` (upstream kept grants on the page). */
  let grantStore: PageActionGrant[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'page-action-bridge-test-'));
    auditPath = join(tempDir, 'page-actions.jsonl');
    clock = { now: 1_000_000 };
    grantStore = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeBroker(executors: PageActionExecutors = {}) {
    return new PageActionBroker({
      executors,
      auditLogPath: auditPath,
      readGrant: async (_pageSlug, grantId) => grantStore.find((g) => g.id === grantId),
      now: () => clock.now,
    });
  }

  function makeGrant(overrides: Partial<PageActionGrant> = {}): PageActionGrant {
    return {
      id: 'grant_test0001',
      action: { kind: 'api', sourceSlug: 'github', method: 'GET', pathPattern: '/repos/.*' },
      contentDigest: DIGEST_V1,
      createdAt: clock.now,
      expiresAt: clock.now + 60_000,
      ...overrides,
    };
  }

  function makePage(overrides: Partial<PageConfig> & { grants?: PageActionGrant[] } = {}): PageConfig {
    const { grants = [makeGrant()], ...rest } = overrides;
    grantStore = grants;
    return {
      schemaVersion: 1,
      id: 'page_test0001',
      slug: 'dash',
      name: 'Dash',
      kind: 'interactive',
      createdAt: 1,
      updatedAt: 1,
      contentDigest: DIGEST_V1,
      ...rest,
    };
  }

  function makeRequest(lease: PageRenderLease, overrides: Partial<PageActionRequest> = {}): PageActionRequest {
    return {
      requestId: `req_${Math.random().toString(36).slice(2)}`,
      pageSlug: 'dash',
      leaseId: lease.leaseId,
      nonce: lease.nonce,
      grantId: 'grant_test0001',
      invocation: { kind: 'api', method: 'GET', path: '/repos/craft/agents' },
      ...overrides,
    };
  }

  async function readAudit(): Promise<Array<Record<string, unknown>>> {
    // Audit writes are fire-and-forget; give the microtask queue a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  describe('happy path', () => {
    it('executes a granted api action through the injected executor', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation, { signal }) => {
          calls.push({ invocation, aborted: signal.aborted });
          return { status: 200, ok: true, body: { repos: 3 } };
        },
      });

      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makePage(), makeRequest(lease));

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ repos: 3 });
      expect(calls).toHaveLength(1);
      expect((calls[0] as { invocation: { sourceSlug: string } }).invocation.sourceSlug).toBe('github');

      const audit = await readAudit();
      const executed = audit.find((e) => e.event === 'page_action_executed');
      expect(executed?.ok).toBe(true);
      expect(executed?.policyDecision).toBe('allow');
      expect((executed?.invocation as { path: string }).path).toBe('/repos/craft/agents');
    });
  });

  describe('api path traversal (grant path canonicalization)', () => {
    it('rejects a `..` path before the match and never runs the executor', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation); return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      // Grant is GET /repos/.* — this matches the anchored pattern raw, but fetch
      // would normalize it to /admin with the real credential.
      const literal = await broker.executeAction(makePage(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/../../admin' },
      }));
      expect(literal.ok).toBe(false);
      expect(literal.error).toContain('invocation-path-unsafe');

      // Percent-encoded form (%2e%2e) is decoded and caught too.
      const encoded = await broker.executeAction(makePage(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/%2e%2e/admin' },
      }));
      expect(encoded.ok).toBe(false);
      expect(encoded.error).toContain('invocation-path-unsafe');
      expect(calls).toHaveLength(0);
    });

    it('still allows a legitimate nested path under the grant', async () => {
      const calls: Array<{ path: string }> = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation as { path: string }); return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const ok = await broker.executeAction(makePage(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/craft/agents' },
      }));
      expect(ok.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe('/repos/craft/agents');
    });
  });

  describe('lease + replay validation', () => {
    it('rejects unknown leases, wrong nonces, and cross-page leases', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const noLease = await broker.executeAction(makePage(), makeRequest(lease, { leaseId: 'nope' }));
      expect(noLease.ok).toBe(false);
      expect(noLease.error).toContain('lease-not-found');

      const badNonce = await broker.executeAction(makePage(), makeRequest(lease, { nonce: 'wrong' }));
      expect(badNonce.ok).toBe(false);
      expect(badNonce.error).toContain('nonce-mismatch');

      const otherPage = await broker.executeAction(
        makePage({ slug: 'other' }),
        makeRequest(lease, { pageSlug: 'other' }),
      );
      expect(otherPage.ok).toBe(false);
      expect(otherPage.error).toContain('lease-page-mismatch');
    });

    it('rejects expired leases', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      clock.now += 13 * 60 * 60 * 1000; // past the 12h default TTL
      const result = await broker.executeAction(makePage(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('lease-expired');
    });

    it('rejects replayed request ids on the same lease', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(lease);

      const first = await broker.executeAction(makePage(), request);
      expect(first.ok).toBe(true);

      const replay = await broker.executeAction(makePage(), request);
      expect(replay.ok).toBe(false);
      expect(replay.error).toContain('replay');
    });

    it('rejects actions after the page content changed under the lease', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const result = await broker.executeAction(
        makePage({ contentDigest: DIGEST_V2 }),
        makeRequest(lease),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('content-changed');
    });

    it('releasing a lease invalidates it', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      broker.releaseLease(lease.leaseId);

      const result = await broker.executeAction(makePage(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('lease-not-found');
    });
  });

  describe('grant validation', () => {
    async function expectRejection(page: PageConfig, requestPatch: Partial<PageActionRequest>, code: string) {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: page.contentDigest! });
      const result = await broker.executeAction(page, makeRequest(lease, requestPatch));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(code);
    }

    it('rejects unknown grants', async () => {
      await expectRejection(makePage(), { grantId: 'grant_missing' }, 'grant-not-found');
    });

    it('rejects grants bound to older content (stale)', async () => {
      const page = makePage({
        contentDigest: DIGEST_V2,
        grants: [makeGrant()], // grant still bound to v1
      });
      await expectRejection(page, {}, 'grant-stale');
    });

    it('rejects expired grants', async () => {
      const page = makePage({ grants: [makeGrant({ expiresAt: clock.now - 1 })] });
      await expectRejection(page, {}, 'grant-expired');
    });

    it('rejects method and kind mismatches', async () => {
      await expectRejection(
        makePage(),
        { invocation: { kind: 'api', method: 'POST', path: '/repos/x' } },
        'grant-mismatch',
      );
      await expectRejection(
        makePage(),
        { invocation: { kind: 'mcp', toolName: 'create_issue' } },
        'grant-mismatch',
      );
    });

    it('anchors the path pattern (no substring matches)', async () => {
      await expectRejection(
        makePage(),
        { invocation: { kind: 'api', method: 'GET', path: '/evil/prefix/repos/x' } },
        'grant-mismatch',
      );
      // Normalization: leading slash optional in requests
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const ok = await broker.executeAction(
        makePage(),
        makeRequest(lease, { invocation: { kind: 'api', method: 'GET', path: 'repos/x' } }),
      );
      expect(ok.ok).toBe(true);
    });

    it('rejects mcp tool-name mismatches and honors mcp grants', async () => {
      const mcpGrant = makeGrant({
        id: 'grant_mcp00001',
        action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
      });
      const page = makePage({ grants: [mcpGrant] });

      const seen: unknown[] = [];
      const broker = makeBroker({
        executeMcp: async (invocation) => { seen.push(invocation); return { echoed: invocation.toolName }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      const wrongTool = await broker.executeAction(
        page,
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'delete_issue' } }),
      );
      expect(wrongTool.ok).toBe(false);
      expect(wrongTool.error).toContain('grant-mismatch');

      const ok = await broker.executeAction(
        page,
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'create_issue', args: { title: 'x' } } }),
      );
      expect(ok.ok).toBe(true);
      expect(ok.body).toEqual({ echoed: 'create_issue' });
      // Ours: the executor learns the page, so the host leases the pool as `page:<slug>`.
      expect(seen[0]).toEqual({ pageSlug: 'dash', sourceSlug: 'linear', toolName: 'create_issue', args: { title: 'x' } });
    });
  });

  describe('execution edges', () => {
    it('returns a structured error when the executor is not wired', async () => {
      const mcpGrant = makeGrant({
        id: 'grant_mcp00001',
        action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
      });
      const broker = makeBroker({}); // no executors
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(
        makePage({ grants: [mcpGrant] }),
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'create_issue' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('executor-unavailable');
    });

    it('folds executor throws into failed results', async () => {
      const broker = makeBroker({
        executeApi: async () => {
          throw new Error('connection reset');
        },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makePage(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toBe('connection reset');
    });

    it('cancelAction aborts an in-flight request', async () => {
      const broker = makeBroker({
        executeApi: (_invocation, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(lease);

      const pending = broker.executeAction(makePage(), request);
      // Give the broker a tick to register the in-flight controller
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(broker.cancelAction(request.requestId)).toBe(true);

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Cancelled');
      expect(broker.cancelAction(request.requestId)).toBe(false);
    });
  });

  describe('script actions', () => {
    const SCRIPT_SHA = 'c'.repeat(64);
    const scriptGrant = () =>
      makeGrant({
        id: 'grant_script001',
        action: { kind: 'script', script: 'pages/dash/run.sh', runtime: 'bun', args: ['--once'] },
        scriptSha256: SCRIPT_SHA,
      });
    const scriptRequest = (lease: PageRenderLease) =>
      makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });

    it('runs the grant-pinned script and returns stdout/stderr/exit on success', async () => {
      const seen: unknown[] = [];
      const broker = makeBroker({
        executeScript: async (invocation) => {
          seen.push(invocation);
          return { exitCode: 0, stdout: 'hello', stderr: '' };
        },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makePage({ grants: [scriptGrant()] }), scriptRequest(lease));

      expect(result.ok).toBe(true);
      expect(result.body).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' });
      // The executor receives the grant's pinned script/runtime/args and digest, never page input.
      expect(seen[0]).toEqual({
        pageSlug: 'dash',
        grantId: 'grant_script001',
        script: 'pages/dash/run.sh',
        runtime: 'bun',
        args: ['--once'],
        scriptSha256: SCRIPT_SHA,
      });

      const audit = await readAudit();
      const executed = audit.find((e) => e.event === 'page_action_executed');
      expect(executed?.ok).toBe(true);
      expect((executed?.invocation as { kind: string }).kind).toBe('script');
    });

    it('reports ok:false but still surfaces output on a non-zero exit', async () => {
      const broker = makeBroker({
        executeScript: async () => ({ exitCode: 2, stdout: '', stderr: 'boom' }),
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makePage({ grants: [scriptGrant()] }), scriptRequest(lease));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('code 2');
      expect(result.body).toEqual({ exitCode: 2, stdout: '', stderr: 'boom' });
    });

    it('returns executor-unavailable when no script executor is wired', async () => {
      const broker = makeBroker({}); // no executors
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makePage({ grants: [scriptGrant()] }), scriptRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('executor-unavailable');
    });

    it('folds a blocked/throwing executor into a failed result', async () => {
      const broker = makeBroker({
        executeScript: async () => {
          throw new Error('Script path escapes the workspace');
        },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makePage({ grants: [scriptGrant()] }), scriptRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('escapes the workspace');
    });
  });

  describe('audit trail', () => {
    it('records rejections with codes and redacts sensitive params', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      await broker.executeAction(
        makePage(),
        makeRequest(lease, {
          nonce: 'wrong',
          invocation: { kind: 'api', method: 'GET', path: '/repos/x', params: { apiToken: 'sk-super-secret', page: 2 } },
        }),
      );

      const audit = await readAudit();
      const rejected = audit.find((e) => e.event === 'page_action_rejected');
      expect(rejected?.code).toBe('nonce-mismatch');
      const params = (rejected?.invocation as { params: Record<string, unknown> }).params;
      expect(params.apiToken).toBe('[REDACTED]');
      expect(params.page).toBe(2);
    });
  });

  describe('host-side per-lease rate limiting', () => {
    it('caps in-flight actions per lease, audits the rejection, and frees slots on completion', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const broker = makeBroker({
        executeApi: async () => { await gate; return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      const page = makePage();

      // Fill every in-flight slot. Ours reads the grant asynchronously, so let every call reach the executor
      // await before the overflow request is sent.
      const inFlight = Array.from({ length: PAGE_ACTION_MAX_IN_FLIGHT_PER_LEASE }, () =>
        broker.executeAction(page, makeRequest(lease)),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const overflowRequest = makeRequest(lease);
      const overflow = await broker.executeAction(page, overflowRequest);
      expect(overflow.ok).toBe(false);
      expect(overflow.error).toContain('rate-limited');

      // The rejection is part of the audit contract, same as validation rejections.
      const audit = await readAudit();
      const rejected = audit.find(
        (e) => e.event === 'page_action_rejected' && e.requestId === overflowRequest.requestId,
      );
      expect(rejected?.code).toBe('rate-limited');

      release();
      const settled = await Promise.all(inFlight);
      expect(settled.every((r) => r.ok)).toBe(true);

      // Slots freed → the same lease accepts actions again.
      const after = await broker.executeAction(page, makeRequest(lease));
      expect(after.ok).toBe(true);
    });

    it('caps starts per sliding minute, refills after the window, and isolates leases', async () => {
      const broker = makeBroker({
        executeApi: async () => ({ status: 200, ok: true, body: null }),
      });
      // Long-lived grant: the test advances the clock past the default 60s expiry.
      const grant = makeGrant({ expiresAt: clock.now + 3_600_000 });
      const page = makePage({ grants: [grant] });
      const leaseA = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      for (let i = 0; i < PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE; i++) {
        expect((await broker.executeAction(page, makeRequest(leaseA))).ok).toBe(true);
      }
      const throttled = await broker.executeAction(page, makeRequest(leaseA));
      expect(throttled.ok).toBe(false);
      expect(throttled.error).toContain('rate-limited');

      // A different render (lease) has its own budget.
      const leaseB = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect((await broker.executeAction(page, makeRequest(leaseB))).ok).toBe(true);

      // The window slides: a minute later the first lease works again.
      clock.now += 61_000;
      expect((await broker.executeAction(page, makeRequest(leaseA))).ok).toBe(true);
    });
  });

  describe('lease store cap', () => {
    it('evicts the oldest lease past MAX_LIVE_LEASES (audited) and keeps new mounts working', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const page = makePage();

      const first = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      for (let i = 1; i < MAX_LIVE_LEASES; i++) {
        clock.now += 1; // strictly increasing issuedAt → deterministic oldest
        broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      }
      expect(broker.leaseCount).toBe(MAX_LIVE_LEASES);

      clock.now += 1;
      const newest = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      expect(broker.leaseCount).toBe(MAX_LIVE_LEASES);

      // The oldest render lost its lease (a re-mount recovers)…
      const evicted = await broker.executeAction(page, makeRequest(first));
      expect(evicted.ok).toBe(false);
      expect(evicted.error).toContain('lease-not-found');

      // …the newest works, and the eviction is on the audit trail.
      expect((await broker.executeAction(page, makeRequest(newest))).ok).toBe(true);
      // Ours: 257 fire-and-forget appends race the reader under a loaded machine (measured: the 20 ms tick
      // missed the row), so poll for the row, bounded, instead of one tick.
      let eviction: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100 && !eviction; attempt++) {
        eviction = (await readAudit()).find((e) => e.event === 'page_lease_evicted');
      }
      expect(eviction?.leaseId).toBe(first.leaseId);
      expect(eviction?.reason).toBe('lease-store-full');
    });
  });

  describe('UA12.62 — the audit log rotates past its size cap', () => {
    it('past the cap the file rotates to .1 and the new event lands in a fresh file', async () => {
      writeFileSync(auditPath, '{"event":"page_lease_created","pageSlug":"pre-rotation"}\n', 'utf-8');
      const broker = new PageActionBroker({
        executors: {},
        auditLogPath: auditPath,
        auditRotateBytes: 32,
        readGrant: async (_pageSlug, grantId) => grantStore.find((g) => g.id === grantId),
        now: () => clock.now,
      });

      broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });

      // UA12.177: the append is fire-and-forget; wait on its chain, not on a clock.
      await settleJsonlAppends(auditPath);
      const fresh = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(existsSync(`${auditPath}.1`)).toBe(true);
      expect(readFileSync(`${auditPath}.1`, 'utf-8')).toBe('{"event":"page_lease_created","pageSlug":"pre-rotation"}\n');
      expect(fresh).toHaveLength(1);
      expect((fresh[0] as { pageSlug: string }).pageSlug).toBe('dash');
    });

    it('below the cap nothing rotates', async () => {
      writeFileSync(auditPath, '{"event":"page_lease_created","pageSlug":"pre-existing"}\n', 'utf-8');
      const broker = new PageActionBroker({
        executors: {},
        auditLogPath: auditPath,
        auditRotateBytes: 10_000,
        readGrant: async (_pageSlug, grantId) => grantStore.find((g) => g.id === grantId),
        now: () => clock.now,
      });

      broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
      await settleJsonlAppends(auditPath);

      expect(existsSync(`${auditPath}.1`)).toBe(false);
      const lines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });

    it('UA12.177: overlapping appends at the cap crossing keep .1 byte-identical and land every new line once', async () => {
      // Unserialized, this clobbered .1 in most trials (2026-10-08 verification: 75/100 on the eviction
      // path); four trials make the arm fail on such a writer, and the serialized one passes every time.
      for (let trial = 0; trial < 4; trial++) {
        rmSync(`${auditPath}.1`, { force: true });
        // Seeded exactly AT the cap: the first append rotates, the rest land in the fresh file (far below it).
        const seed = Array.from({ length: 40 }, (_, n) => `{"event":"page_lease_created","pageSlug":"old-${trial}-${n}"}`).join('\n') + '\n';
        writeFileSync(auditPath, seed, 'utf-8');
        const broker = new PageActionBroker({
          executors: {},
          auditLogPath: auditPath,
          auditRotateBytes: Buffer.byteLength(seed),
          readGrant: async (_pageSlug, grantId) => grantStore.find((g) => g.id === grantId),
          now: () => clock.now,
        });

        // Five back-to-back fire-and-forget appends — createLease's own shape (evicted + created).
        const leases = Array.from({ length: 5 }, () => broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 }));
        await settleJsonlAppends(auditPath);

        expect(readFileSync(`${auditPath}.1`, 'utf-8')).toBe(seed);
        const fresh = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { leaseId: string });
        expect(fresh.map((e) => e.leaseId).sort()).toEqual(leases.map((l) => l.leaseId).sort());
      }
    });
  });
});

// ============================================================================
// UA9.2 — the real ledger, the page's bytes, and the api_<slug> annotation
// ============================================================================

describe('UA9.2 · page grants in the host-approvals ledger', () => {
  const HTML_V1 = '<!doctype html><p>v1</p>';
  const HTML_V2 = '<!doctype html><p>v2 — edited after the grant</p>';
  let root: string;
  let auditPath: string;
  const key = randomBytes(32);
  const keyProvider: HostApprovalsKeyProvider = { getKey: async () => key };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua92-')));
    auditPath = join(root, 'logs', 'page-actions.jsonl');
    mkdirSync(join(root, 'pages', 'dash'), { recursive: true });
    writeFileSync(join(root, 'pages', 'dash', 'index.html'), HTML_V1);
    permissionsConfigCache.clear();
  });

  afterEach(() => {
    permissionsConfigCache.clear();
    rmSync(root, { recursive: true, force: true });
  });

  const digestV1 = computePageContentDigest(HTML_V1);

  function page(overrides: Record<string, unknown> = {}): PageConfig {
    return {
      schemaVersion: 1, id: 'page_dash', slug: 'dash', name: 'Dash', kind: 'interactive',
      createdAt: 1, updatedAt: 1, contentDigest: digestV1, ...overrides,
    } as PageConfig;
  }

  function broker(executors: PageActionExecutors, extra: { permissionsContext?: PermissionsContext; keyProvider?: HostApprovalsKeyProvider } = {}) {
    return new PageActionBroker({
      executors,
      workspaceRootPath: root,
      keyProvider: extra.keyProvider ?? keyProvider,
      auditLogPath: auditPath,
      ...(extra.permissionsContext ? { permissionsContext: extra.permissionsContext } : {}),
    });
  }

  function request(lease: PageRenderLease, grantId: string, invocation: PageActionRequest['invocation']): PageActionRequest {
    return { requestId: `req_${randomBytes(6).toString('hex')}`, pageSlug: 'dash', leaseId: lease.leaseId, nonce: lease.nonce, grantId, invocation };
  }

  async function audit(): Promise<Array<Record<string, unknown>>> {
    await settleJsonlAppends(auditPath); // every append issued so far has landed (UA12.177's chain)
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  const apiGrant = { id: 'grant_api', action: { kind: 'api' as const, sourceSlug: 'github', method: 'GET' as const, pathPattern: '/repos/.*' }, contentDigest: digestV1 };
  const ok200 = { executeApi: async () => ({ status: 200, ok: true, body: null }) };

  it('positive: a ledger grant authorizes its call, read back with every field the writer recorded', async () => {
    const issued = issuePageGrant(root, key, 'dash', { ...apiGrant, description: 'list repos' });
    expect(readPageGrant(root, key, 'dash', 'grant_api')).toEqual(issued);
    expect(listPageGrants(root, key, 'dash').map((g) => g.id)).toEqual(['grant_api']);

    const b = broker(ok200);
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const result = await b.executeAction(page(), request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' }));
    expect(result.ok).toBe(true);
  });

  it('negative: a content change on disk invalidates the grant even when page.json still names the old digest', async () => {
    issuePageGrant(root, key, 'dash', apiGrant);
    const b = broker(ok200);
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    writeFileSync(join(root, 'pages', 'dash', 'index.html'), HTML_V2);
    // page.json's field is left at v1 — an agent pinning it cannot keep the grant alive.
    const result = await b.executeAction(page({ contentDigest: digestV1 }), request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('content-changed');

    // A fresh render of the new bytes still cannot use the grant: it was approved for v1.
    const fresh = b.createLease({ pageSlug: 'dash', contentDigest: computePageContentDigest(HTML_V2) });
    const stale = await b.executeAction(page(), request(fresh, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' }));
    expect(stale.error).toContain('grant-stale');
  });

  it('negative: a replay is refused', async () => {
    issuePageGrant(root, key, 'dash', apiGrant);
    const b = broker(ok200);
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const req = request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' });
    expect((await b.executeAction(page(), req)).ok).toBe(true);
    const replay = await b.executeAction(page(), req);
    expect(replay.ok).toBe(false);
    expect(replay.error).toContain('replay');
  });

  it('negative: two concurrent requests with one requestId run once — the other is refused as a replay across the awaited grant read', async () => {
    issuePageGrant(root, key, 'dash', { ...apiGrant, id: 'grant_post', action: { ...apiGrant.action, method: 'POST' as const } });
    let runs = 0;
    const b = broker({ executeApi: async () => { runs += 1; return { status: 201, ok: true, body: null }; } });
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const req = request(lease, 'grant_post', { kind: 'api', method: 'POST', path: '/repos/x' });
    const results = await Promise.all([b.executeAction(page(), req), b.executeAction(page(), req)]);
    expect(runs).toBe(1);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.find((r) => !r.ok)?.error).toContain('replay');
  });

  // UA12.68 (origin the UA9.2 re-verifier, 2026-10-02) — the recheck's LEASE half, which no arm
  // covered: narrowing `recheckAfterGrantRead` to the replay check alone stayed green before this
  // arm. The gated key provider parks `loadGrant` mid-await; the page unmounts (releaseLease)
  // while the read is pending; when the gate opens, the grant reads fine — only the recheck's
  // lease check stands between the call and the executor.
  it('negative: a lease released while the grant read is pending is refused lease-not-found, with runs 0 and one audited row', async () => {
    issuePageGrant(root, key, 'dash', apiGrant);
    let runs = 0;
    let releaseKey!: () => void;
    const keyGate = new Promise<Buffer>((resolve) => { releaseKey = () => resolve(key); });
    const b = broker(
      { executeApi: async () => { runs += 1; return { status: 200, ok: true, body: null }; } },
      { keyProvider: { getKey: () => keyGate } },
    );
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const pending = b.executeAction(page(), request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' }));
    b.releaseLease(lease.leaseId); // the page unmounts while the read is parked
    releaseKey();
    const result = await pending;
    expect(runs).toBe(0); // the executor never ran
    expect(result.ok).toBe(false);
    expect(result.error).toContain('lease-not-found');
    // UA12.68 follow-up (2026-10-08 verification): a COUNT, not .find — a doubled audit write stayed green.
    const rejected = (await audit()).filter((e) => e.event === 'page_action_rejected');
    expect(rejected).toHaveLength(1); // one audited row…
    expect(rejected[0]?.code).toBe('lease-not-found'); // …with that code
  });

  it('negative: a grant written into page.json with the right digest is refused — the ledger is the only authority', async () => {
    const b = broker(ok200);
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const forgedPage = page({
      grants: [{ ...apiGrant, createdAt: Date.now(), expiresAt: Date.now() + 3_600_000 }],
    });
    const result = await b.executeAction(forgedPage, request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('grant-not-found');
  });

  it('negative: a ledger entry without a valid MAC (agent-written) is refused; so is every grant when the key is unavailable', async () => {
    const record = pageGrantRecord('dash', apiGrant);
    writeFileSync(join(root, HOST_APPROVALS_FILE), JSON.stringify({
      version: 1,
      entries: [{ ...record, createdAt: new Date().toISOString(), mac: '0'.repeat(64) }],
    }));
    const b = broker(ok200);
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const forged = await b.executeAction(page(), request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' }));
    expect(forged.error).toContain('grant-not-found');

    issuePageGrant(root, key, 'dash', apiGrant);
    const keyless = broker(ok200, { keyProvider: { getKey: async () => { throw new Error('no key') } } });
    const lease2 = keyless.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const closed = await keyless.executeAction(page(), request(lease2, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/x' }));
    expect(closed.error).toContain('grant-not-found');
  });

  it('negative: a grant revoked while its render lease is live is refused at the next invocation', async () => {
    issuePageGrant(root, key, 'dash', apiGrant);
    const b = broker(ok200);
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    expect((await b.executeAction(page(), request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/a' }))).ok).toBe(true);
    expect(revokePageGrant(root, key, 'dash', 'grant_api')).toBe(true);
    const after = await b.executeAction(page(), request(lease, 'grant_api', { kind: 'api', method: 'GET', path: '/repos/b' }));
    expect(after.ok).toBe(false);
    expect(after.error).toContain('grant-not-found');
  });

  it('script grants: the record pins the script bytes in the binding runApprovedScript reads; a changed script is audited as grant-script-changed', async () => {
    const sha = 'd'.repeat(64);
    const scriptAction = { kind: 'script' as const, script: 'pages/dash/run.ts' };
    const record = pageGrantRecord('dash', { id: 'grant_s', action: scriptAction, contentDigest: digestV1, scriptSha256: sha });
    expect(record.digest).toBe(sha);
    expect(record.data).toMatchObject({ path: 'pages/dash/run.ts', args: [], runtime: 'bun', contentDigest: digestV1 });
    expect(() => pageGrantRecord('dash', { id: 'grant_s', action: scriptAction, contentDigest: digestV1 })).toThrow();

    issuePageGrant(root, key, 'dash', { id: 'grant_s', action: scriptAction, contentDigest: digestV1, scriptSha256: sha });
    const b = broker({
      executeScript: async () => { throw new Error(`${PAGE_GRANT_SCRIPT_CHANGED}: pages/dash/run.ts changed since the grant`) },
    });
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    const result = await b.executeAction(page(), request(lease, 'grant_s', { kind: 'script' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(PAGE_GRANT_SCRIPT_CHANGED);
    const row = (await audit()).find((e) => e.event === 'page_action_executed');
    expect(row?.code).toBe(PAGE_GRANT_SCRIPT_CHANGED);
  });

  it("the API annotation names api_<slug>: a source rule allows the page's POST on its own source and asks on another", async () => {
    for (const slug of ['linear', 'other']) mkdirSync(join(root, 'sources', slug), { recursive: true });
    writeFileSync(join(root, 'sources', 'linear', 'permissions.json'), JSON.stringify({ allowedApiEndpoints: [{ method: 'POST', path: '^/issues' }] }));
    const permissionsContext: PermissionsContext = { workspaceRootPath: root, activeSourceSlugs: ['linear', 'other'] };
    for (const slug of ['linear', 'other']) {
      issuePageGrant(root, key, 'dash', { id: `grant_${slug}`, action: { kind: 'api', sourceSlug: slug, method: 'POST', pathPattern: '/issues' }, contentDigest: digestV1 });
    }
    const b = broker({ executeApi: async () => ({ status: 201, ok: true, body: null }) }, { permissionsContext });
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: digestV1 });
    for (const slug of ['linear', 'other']) {
      expect((await b.executeAction(page(), request(lease, `grant_${slug}`, { kind: 'api', method: 'POST', path: '/issues' }))).ok).toBe(true);
    }
    const rows = (await audit()).filter((e) => e.event === 'page_action_executed');
    expect(rows.find((e) => e.grantId === 'grant_linear')?.policyDecision).toBe('allow');
    expect(rows.find((e) => e.grantId === 'grant_other')?.policyDecision).toBe('requires-approval');
  });
});

// ============================================================================
// UA12.64 — the MCP policy annotation speaks the pool's WIRE name, not the
// config slug: the pool registers a call as `mcp__<wire>__<tool>` (the
// resolver-minted wire name the MCP executor calls through), and an
// `allowedMcpPatterns` rule is written against that spelling. A source whose
// wire name differs from its config slug must therefore annotate exactly what
// the hook answers for the same call.
// ============================================================================

describe('UA12.64 · the MCP policy annotation speaks the pool wire name', () => {
  /** The resolver's own F3 specimen (`my server.v2`): its minted wire name is `my_server_v2` — sanitize, then cap. */
  const SLUG = 'my server.v2';
  const WIRE = 'my_server_v2';
  /** A tool the shipped rules refuse (no read verb, no write token, not always-allowed) — only the workspace rule can allow it, so the annotated NAME is the whole verdict. */
  const TOOL = 'preview_render';

  let root: string;
  let auditPath: string;
  let grantStore: PageActionGrant[];
  const clock = { now: 1_000_000 };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua1264-')));
    auditPath = join(root, 'logs', 'page-actions.jsonl');
    grantStore = [];
    permissionsConfigCache.clear();
  });

  afterEach(() => {
    permissionsConfigCache.clear();
    rmSync(root, { recursive: true, force: true });
  });

  function wireBroker(executors: PageActionExecutors, resolveMcpWireName?: (sourceSlug: string) => Promise<string | undefined>) {
    return new PageActionBroker({
      executors,
      auditLogPath: auditPath,
      readGrant: async (_pageSlug, grantId) => grantStore.find((g) => g.id === grantId),
      permissionsContext: { workspaceRootPath: root, activeSourceSlugs: [] },
      ...(resolveMcpWireName ? { resolveMcpWireName } : {}),
      now: () => clock.now,
    });
  }

  async function readAudit(): Promise<Array<Record<string, unknown>>> {
    // Audit writes are fire-and-forget; poll bounded — the one-tick read missed the row beside
    // parallel file runs (measured 2026-10-04), the reason UA12.62's arms poll the same way.
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (existsSync(auditPath)) {
        const parsed = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
          .map((l) => JSON.parse(l)) as Array<Record<string, unknown>>;
        if (parsed.some((e) => e.event === 'page_action_executed')) return parsed;
      }
    }
    return [];
  }

  function mcpGrant(): PageActionGrant {
    return {
      id: 'grant_mcp6401',
      action: { kind: 'mcp', sourceSlug: SLUG, toolName: TOOL },
      contentDigest: DIGEST_V1,
      createdAt: clock.now,
      expiresAt: clock.now + 60_000,
    };
  }

  async function executeOnce(b: PageActionBroker): Promise<{ resultOk: boolean; policyDecision: unknown }> {
    grantStore = [mcpGrant()];
    const page: PageConfig = {
      schemaVersion: 1, id: 'page_dash', slug: 'dash', name: 'Dash', kind: 'interactive',
      createdAt: 1, updatedAt: 1, contentDigest: DIGEST_V1,
    };
    const lease = b.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
    const result = await b.executeAction(page, {
      requestId: `req_${randomBytes(6).toString('hex')}`,
      pageSlug: 'dash',
      leaseId: lease.leaseId,
      nonce: lease.nonce,
      grantId: 'grant_mcp6401',
      invocation: { kind: 'mcp', toolName: TOOL, args: {} },
    });
    const row = (await readAudit()).find((e) => e.event === 'page_action_executed');
    return { resultOk: result.ok, policyDecision: row?.policyDecision };
  }

  /** The hook's own verdict for the name the pool registers — what the audit must equal (the row's control). */
  function hookDecision(permissionsContext: PermissionsContext) {
    return evaluateMcpToolPolicy(
      buildPoolProxyBaseName(WIRE, TOOL),
      {},
      { permissionsContext },
    ).decision;
  }

  it('the audit policyDecision equals the hook for a source whose wire name differs (rule written against the wire name)', async () => {
    writeFileSync(join(root, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: [`^mcp__${WIRE}__`] }));
    const permissionsContext: PermissionsContext = { workspaceRootPath: root, activeSourceSlugs: [] };
    expect(hookDecision(permissionsContext)).toBe('allow'); // the rule does allow, on the wire spelling

    const b = wireBroker({ executeMcp: async () => ({ echoed: true }) }, async () => WIRE);
    const { resultOk, policyDecision } = await executeOnce(b);
    expect(resultOk).toBe(true);
    expect(policyDecision).toBe('allow');
    expect(policyDecision).toBe(hookDecision(permissionsContext));
  });

  it('control: without the seam the fallback keeps the config-slug spelling — the wire rule does not reach it', async () => {
    writeFileSync(join(root, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: [`^mcp__${WIRE}__`] }));
    const b = wireBroker({ executeMcp: async () => ({ echoed: true }) });
    const { resultOk, policyDecision } = await executeOnce(b);
    // The call still runs (the grant is the approval); only the annotation differs.
    expect(resultOk).toBe(true);
    expect(policyDecision).toBe('requires-approval');
  });

  it('control: the fallback is exact — a rule spelled against the config slug annotates allow with no seam', async () => {
    writeFileSync(join(root, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: ['^mcp__my server\\.v2__'] }));
    const b = wireBroker({ executeMcp: async () => ({ echoed: true }) });
    const { resultOk, policyDecision } = await executeOnce(b);
    expect(resultOk).toBe(true);
    expect(policyDecision).toBe('allow');
  });

  it('a seam that cannot name the source (undefined) falls back to the config slug', async () => {
    writeFileSync(join(root, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: ['^mcp__my server\\.v2__'] }));
    const b = wireBroker({ executeMcp: async () => ({ echoed: true }) }, async () => undefined);
    const { resultOk, policyDecision } = await executeOnce(b);
    expect(resultOk).toBe(true);
    expect(policyDecision).toBe('allow');
  });
});

// ============================================================================
// UA12.112 — a request the RENDERER's gate refused never reaches validate(),
// so without a report it leaves no line in the trail at all. The broker
// appends the line it is told about, marked stage 'renderer-gate'.
// ============================================================================

describe('UA12.112 · the broker audits renderer-gate refusals it is told about', () => {
  let auditPath: string;

  beforeEach(() => {
    auditPath = join(realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua12112-'))), 'page-actions.jsonl');
  });

  afterEach(() => {
    rmSync(join(auditPath, '..'), { recursive: true, force: true });
  });

  function refusalBroker() {
    return new PageActionBroker({
      executors: {},
      auditLogPath: auditPath,
      now: () => 1_000_000,
    });
  }

  async function lines(): Promise<Array<Record<string, unknown>>> {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (existsSync(auditPath)) break;
    }
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('an action refusal lands as page_action_rejected, stage renderer-gate, with the invocation summarized and redacted', async () => {
    refusalBroker().auditGateRefusal({
      kind: 'action',
      pageSlug: 'dash',
      code: 'frame-focus-required',
      reason: 'frame-focus-required: mutating actions need a gesture inside the page',
      requestId: 'req_timer1',
      leaseId: 'lease_1',
      grantId: 'grant_1',
      invocation: { kind: 'api', method: 'POST', path: '/issues', params: { apiToken: 'sk-super-secret', page: 2 } },
    });
    const row = (await lines()).find((e) => e.event === 'page_action_rejected');
    expect(row).toMatchObject({
      stage: 'renderer-gate',
      pageSlug: 'dash',
      code: 'frame-focus-required',
      reason: 'frame-focus-required: mutating actions need a gesture inside the page',
      requestId: 'req_timer1',
      leaseId: 'lease_1',
      grantId: 'grant_1',
    });
    const invocation = row?.invocation as { kind: string; params: Record<string, unknown> };
    expect(invocation.kind).toBe('api');
    expect(invocation.params.apiToken).toBe('[REDACTED]');
    expect(invocation.params.page).toBe(2);
  });

  it('a refused grant-request lands as page_grant_request_refused with the gate code and the request count', async () => {
    refusalBroker().auditGateRefusal({
      kind: 'grant-request',
      pageSlug: 'dash',
      code: 'no-user-activation',
      requestCount: 2,
    });
    const row = (await lines()).find((e) => e.event === 'page_grant_request_refused');
    expect(row).toMatchObject({ stage: 'renderer-gate', pageSlug: 'dash', code: 'no-user-activation', requests: 2 });
  });

  it('boundary: absent optionals stay absent from the line', async () => {
    refusalBroker().auditGateRefusal({ kind: 'action', pageSlug: 'dash', code: 'nonce-mismatch' });
    const row = (await lines()).find((e) => e.event === 'page_action_rejected');
    expect(row).toMatchObject({ stage: 'renderer-gate', pageSlug: 'dash', code: 'nonce-mismatch' });
    for (const absent of ['requestId', 'leaseId', 'grantId', 'invocation', 'reason']) {
      expect(row).not.toHaveProperty(absent);
    }
  });
});

// ============================================================================
// UA12.178 — the renderer gate reports BEFORE the frame's 30/min limiter, so a
// page script looping wrong-nonce messages reached the audit unthrottled (the
// 2026-10-08 verification: 200 refusals in 610 ms rotated a seeded executed
// line out of both generations). The broker budgets refusal lines per page.
// ============================================================================

describe('UA12.178 · renderer-gate refusal lines are budgeted per page', () => {
  // The broker's PAGE_GATE_REFUSAL_AUDITS_PER_MINUTE — the same figure as the per-lease action budget.
  const BUDGET = PAGE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE;
  let auditPath: string;
  let clock: { now: number };

  beforeEach(() => {
    auditPath = join(realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua12178-'))), 'page-actions.jsonl');
    clock = { now: 1_000_000 };
  });

  afterEach(() => {
    rmSync(join(auditPath, '..'), { recursive: true, force: true });
  });

  function budgetBroker(auditRotateBytes?: number) {
    return new PageActionBroker({
      executors: {},
      auditLogPath: auditPath,
      ...(auditRotateBytes !== undefined ? { auditRotateBytes } : {}),
      now: () => clock.now,
    });
  }

  function refuse(broker: PageActionBroker, pageSlug = 'dash', params?: Record<string, unknown>) {
    broker.auditGateRefusal({
      kind: 'action',
      pageSlug,
      code: 'nonce-mismatch',
      ...(params ? { invocation: { kind: 'api', method: 'GET', path: '/x', params } } : {}),
    });
  }

  async function auditLines(path = auditPath): Promise<Array<Record<string, unknown>>> {
    await settleJsonlAppends(path);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('a burst past the budget writes at most 30 refusal lines, then ONE coalesced suppressed line when the budget frees', async () => {
    const broker = budgetBroker();
    for (let n = 0; n < 200; n++) refuse(broker);
    let rows = await auditLines();
    expect(rows.filter((e) => e.event === 'page_action_rejected')).toHaveLength(BUDGET);
    expect(rows.filter((e) => e.event === 'page_gate_refusals_suppressed')).toHaveLength(0);

    clock.now += 61_000; // the sliding minute has passed
    refuse(broker);
    rows = await auditLines();
    const suppressed = rows.filter((e) => e.event === 'page_gate_refusals_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({ pageSlug: 'dash', stage: 'renderer-gate', suppressed: 200 - BUDGET });
    expect(rows.filter((e) => e.event === 'page_action_rejected')).toHaveLength(BUDGET + 1);
  });

  it('boundary: exactly the budget writes every line and no suppressed line; another page keeps its own budget', async () => {
    const broker = budgetBroker();
    for (let n = 0; n < BUDGET; n++) refuse(broker);
    for (let n = 0; n < 3; n++) refuse(broker, 'other');
    const rows = await auditLines();
    expect(rows.filter((e) => e.event === 'page_action_rejected' && e.pageSlug === 'dash')).toHaveLength(BUDGET);
    expect(rows.filter((e) => e.event === 'page_action_rejected' && e.pageSlug === 'other')).toHaveLength(3);
    expect(rows.filter((e) => e.event === 'page_gate_refusals_suppressed')).toHaveLength(0);
  });

  it('releasing the page\'s lease writes the pending suppressed count (a page that goes quiet still leaves its total)', async () => {
    const broker = budgetBroker();
    const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
    for (let n = 0; n < BUDGET + 7; n++) refuse(broker);
    broker.releaseLease(lease.leaseId);
    const suppressed = (await auditLines()).filter((e) => e.event === 'page_gate_refusals_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({ pageSlug: 'dash', suppressed: 7 });
  });

  it('a seeded page_action_executed line survives a refusal flood at a small rotation cap', async () => {
    const executed = '{"event":"page_action_executed","pageSlug":"dash","requestId":"req_real_evidence"}\n';
    writeFileSync(auditPath, executed, 'utf-8');
    const broker = budgetBroker(64 * 1024); // ~64 refusal lines of ~1 KiB fill one generation
    const params = { filler: 'x'.repeat(1000) };
    for (let n = 0; n < 500; n++) refuse(broker, 'dash', params);
    await settleJsonlAppends(auditPath);
    const kept = [auditPath, `${auditPath}.1`].filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf-8')).join('');
    expect(kept).toContain('req_real_evidence');
  });

  // UA12.112 follow-up (2026-10-08 verification): 30 reports spaced 1 s apart, then a 100 ms flood, made
  // every freed sliding slot write a suppressed line of its own (~30 + 30 lines a minute).
  it('a staggered flood writes at most one suppressed line a minute, and no report is lost from the totals', async () => {
    const broker = budgetBroker();
    const lease = broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
    let sent = 0;
    for (let n = 0; n < BUDGET; n++, sent++, clock.now += 1_000) refuse(broker);
    while (clock.now < 1_000_000 + 120_000) {
      refuse(broker);
      sent++;
      clock.now += 100;
    }
    let rows = await auditLines();
    expect(rows.filter((e) => e.event === 'page_action_rejected')).toHaveLength(2 * BUDGET);
    expect(rows.filter((e) => e.event === 'page_gate_refusals_suppressed')).toHaveLength(1);

    broker.releaseLease(lease.leaseId);
    rows = await auditLines();
    const suppressed = rows.filter((e) => e.event === 'page_gate_refusals_suppressed');
    expect(suppressed).toHaveLength(2);
    const counted = suppressed.reduce((sum, e) => sum + Number(e.suppressed), 0);
    expect(rows.filter((e) => e.event === 'page_action_rejected').length + counted).toBe(sent);
  });

  it('a lease that EXPIRES (not released) still writes the page\'s pending suppressed count', async () => {
    const broker = new PageActionBroker({ executors: {}, auditLogPath: auditPath, leaseTtlMs: 5_000, now: () => clock.now });
    broker.createLease({ pageSlug: 'dash', contentDigest: DIGEST_V1 });
    for (let n = 0; n < BUDGET + 4; n++) refuse(broker);
    clock.now += 6_000;
    expect(broker.leaseCount).toBe(0); // the prune drops the expired lease
    const suppressed = (await auditLines()).filter((e) => e.event === 'page_gate_refusals_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({ pageSlug: 'dash', suppressed: 4 });
  });
});
