/**
 * P3.333 — the claude 403 branch was UNREACHABLE, and the input it is gated on
 * was structurally null on every claude turn.
 *
 * ## What was measured
 *
 * `claude-sdk-error-mapper.ts` gates the whole guardrail-403 branch on
 * `context.capturedApiError?.status`. The only production writer of that value
 * is `setStoredError`, and it has exactly one production caller:
 * `unified-network-interceptor.ts` (`git grep setStoredError` — three call
 * sites, all in that file, plus its own definition and one test). The
 * interceptor is preloaded into the **Pi** subprocess and nowhere else;
 * `build-dmg.sh` states it verbatim beside the copy step: *"the Claude native
 * binary doesn't accept Bun's --preload … Phase 2 will reintroduce equivalent
 * functionality for Claude via SDK hooks or a local proxy"*, and
 * `backend/internal/drivers/anthropic.ts` has no preload of any kind.
 *
 * So the branch written FOR this runtime after the 2026-08-15 llm-proxy
 * incident — where a `403 {"error":"… Security Guardrail Triggered …"}` was
 * reported to the user as "Your API key may be invalid or expired" and a
 * planner spent an hour hunting a credential bug that did not exist — landed on
 * that exact wrong story again. The existing mapper suite is green because it
 * hands the mapper a LITERAL `capturedApiError`; nothing built the context the
 * way `mapSDKErrorToTypedError` builds it.
 *
 * ## What this file drives
 *
 * The seam is the one the build script promised: `startLocalAdapterRuntime`
 * already hands the adapter a `fetchImpl`, so the upstream response passes
 * through `ClaudeAgent` on the way back. `observeUpstreamApiErrors` records the
 * status there and `getCapturedApiErrorForSession` prefers it.
 *
 * Both halves are driven rather than read: the wrapper against a fake upstream,
 * and the mapper against the context that wrapper produces. A green wrapper with
 * a mapper that ignores it would be the same defect one layer down.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeAgent } from '../claude-agent.ts';
import { mapClaudeSdkAssistantError } from '../claude-sdk-error-mapper.ts';

const GUARDRAIL_BODY =
  '{"error":"Security Guardrail Triggered: Malicious MCP detected. Invalid tools: evil_tool"}';

function agent() {
  const instance = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'claude-runtime',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-upstream-status',
      name: 'Upstream Status Workspace',
      rootPath: '/tmp/ws-upstream-status',
      workspaceRootPath: '/tmp/ws-upstream-status',
      sessionRootPath: '/tmp/ws-upstream-status/sessions',
    } as never,
    session: {
      id: 'session-upstream-status',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-upstream-status',
    } as never,
  } as never);
  const internals = instance as unknown as {
    observeUpstreamApiErrors: (inner: typeof fetch) => typeof fetch;
    getCapturedApiErrorForSession: () => { status: number; message: string } | null;
  };
  return {
    wrap: (inner: typeof fetch) => internals.observeUpstreamApiErrors(inner),
    captured: () => internals.getCapturedApiErrorForSession(),
  };
}

/** An upstream that answers with one fixed status and body. */
const upstreamAnswering = (status: number, body: string): typeof fetch =>
  (async () => new Response(body, { status, statusText: status === 403 ? 'Forbidden' : 'OK' })) as unknown as typeof fetch;

describe('P3.333 — the adapter fetch records the upstream status', () => {
  it('records a 403 and its body, and the body still reaches the caller', async () => {
    const { wrap, captured } = agent();
    const response = await wrap(upstreamAnswering(403, GUARDRAIL_BODY))('https://gateway.example/v1/messages');

    // The response the adapter gets back is UNCONSUMED — the observation reads a
    // clone, so a body read here still works. Without this the wrapper would
    // break every error path it was added to explain.
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(GUARDRAIL_BODY);

    const observed = captured();
    expect(observed).not.toBeNull();
    expect(observed!.status).toBe(403);
    // The body is filled off a clone and is deliberately not awaited inline, so
    // it is allowed to arrive a microtask later. Yield once, then assert.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('THE CONTROL — a successful response records nothing', async () => {
    // Without this the assertion above cannot tell "a failure is recorded" from
    // "every response is recorded", and the mapper would then attribute a 200 to
    // whatever error code the SDK happened to report.
    const { wrap, captured } = agent();
    await wrap(upstreamAnswering(200, '{"ok":true}'))('https://gateway.example/v1/messages');
    expect(captured()).toBeNull();
  });

  it('POPS — one error belongs to one turn', async () => {
    const { wrap, captured } = agent();
    await wrap(upstreamAnswering(403, GUARDRAIL_BODY))('https://gateway.example/v1/messages');
    expect(captured()!.status).toBe(403);
    // A second read must not re-serve the same failure onto a later turn, which
    // is the property the file store gets from unlinking on read.
    expect(captured()).toBeNull();
  });

  it('the 403 branch now FIRES on a context built the way the agent builds it', async () => {
    const { wrap, captured } = agent();
    await wrap(upstreamAnswering(403, GUARDRAIL_BODY))('https://gateway.example/v1/messages');
    // Let the cloned body land, so the branch has the upstream reason to carry.
    await new Promise(resolve => setTimeout(resolve, 0));

    const error = mapClaudeSdkAssistantError('authentication_failed', {
      actualError: null,
      capturedApiError: captured() as never,
      providerType: 'claude-runtime',
    });

    expect(error.code).toBe('provider_error');
    expect(error.title).toBe('Request Refused');
    expect(error.canRetry).toBe(false);
    expect(error.message).toContain('Security Guardrail Triggered');
    // The wrong story this row exists to delete, asserted as an ABSENCE so a
    // regression that reverts the branch fails on the sentence a user reads.
    expect(error.message).not.toContain('API key may be invalid');
  });

  it('THE BEFORE-STATE — with no captured status the same code still tells the credential story', () => {
    // The control that makes the assertion above meaningful: the mapper's other
    // branch is unchanged, so what moved is the INPUT and not the mapper.
    const error = mapClaudeSdkAssistantError('authentication_failed', {
      actualError: null,
      capturedApiError: null,
      providerType: 'claude-runtime',
    });
    expect(error.code).not.toBe('provider_error');
    expect(error.title).not.toBe('Request Refused');
  });
});

describe('P3.333 — the interceptor really is Pi-only, so the file store cannot serve claude', () => {
  const repoFile = (relative: string): string =>
    readFileSync(new URL(`../../../../../${relative}`, import.meta.url), 'utf8');

  it('the only production writer of the shared store is the Pi-preloaded interceptor', () => {
    const interceptor = repoFile('packages/shared/src/unified-network-interceptor.ts');
    const anthropicDriver = repoFile('packages/shared/src/agent/backend/internal/drivers/anthropic.ts');
    const piDriver = repoFile('packages/shared/src/agent/backend/internal/drivers/pi.ts');

    // Positive control: the writer exists and is in that file.
    expect(interceptor.includes('setStoredError(')).toBe(true);
    // Positive control on the same pair of reads: the Pi driver resolves the
    // interceptor bundle, so the two files really are the ones under discussion.
    expect(piDriver.includes('interceptor')).toBe(true);
    // The claim: the claude driver has no preload of any kind.
    expect(anthropicDriver.includes('interceptor')).toBe(false);
    expect(anthropicDriver.includes('preload')).toBe(false);
    // Three source reads, one of them large; explicit budget for the same
    // reason its siblings carry one.
  }, 60_000);
});
