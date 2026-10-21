/**
 * UB1.10 — adapted from craft-agents-oss v0.13.6
 * `packages/shared/src/__tests__/unified-network-interceptor.curl.test.ts`
 * (Apache-2.0), rebranded: `NESSY_DEBUG_FULL_BODIES`, `NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL`.
 *
 * Regression for OSS #1033: request bodies (prompts, tool arguments, base64
 * images) were logged in full; they are now omitted unless
 * `NESSY_DEBUG_FULL_BODIES=1`.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { MAX_LOGGED_BODY_CHARS } from '../interceptor-common.ts';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../testing/module-graph-budgets.ts';

let toCurl: typeof import('../unified-network-interceptor.ts').toCurl;

const URL_ = 'https://api.example.com/v1/chat/completions';

describe('UB1.10 · toCurl request body logging', () => {
  beforeAll(async () => {
    // Keep the interceptor from patching globalThis.fetch.
    process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ toCurl } = await import('../unified-network-interceptor.ts'));
    // The interceptor graph's cluster budget (scripts/module-graph-hook-baseline.txt, cluster 1:
    // 15.16 s with 0 cases on a quiet tree, 3x bun's 5 000 ms default; UB12.26).
  }, MODULE_GRAPH_HOOK_BUDGET_MS);

  it('omits the request body by default (a base64 image becomes a byte count)', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'SENTINEL_PROMPT' }],
      image: 'data:image/png;base64,QUJDRA==',
    });

    const curl = toCurl(URL_, { method: 'POST', body });

    expect(curl).toContain(`[REQUEST BODY OMITTED: ${body.length} chars]`);
    expect(curl).not.toContain('SENTINEL_PROMPT');
    expect(curl).not.toContain('base64');
  });

  it('omits the body when the opt-in flag is explicitly off', () => {
    const curl = toCurl(URL_, { method: 'POST', body: 'SECRET' }, false);

    expect(curl).toContain('[REQUEST BODY OMITTED: 6 chars]');
    expect(curl).not.toContain('SECRET');
  });

  it('still redacts sensitive headers', () => {
    const curl = toCurl(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-live-secret',
        'x-api-key': 'sk-ant-secret',
        cookie: 'session=abc',
      },
      body: '{}',
    });

    expect(curl).toContain("-H 'authorization: [REDACTED]'");
    expect(curl).toContain("-H 'x-api-key: [REDACTED]'");
    expect(curl).toContain("-H 'cookie: [REDACTED]'");
    expect(curl).toContain("-H 'content-type: application/json'");
    expect(curl).not.toContain('sk-live-secret');
    expect(curl).not.toContain('sk-ant-secret');
  });

  it('positive: includes the body when the opt-in flag is on', () => {
    const curl = toCurl(URL_, { method: 'POST', body: '{"prompt":"SENTINEL_PROMPT"}' }, true);

    expect(curl).toContain('SENTINEL_PROMPT');
    expect(curl).not.toContain('[REQUEST BODY OMITTED');
  });

  it('negative: truncates an oversized body on the opt-in path', () => {
    const body = 'b'.repeat(MAX_LOGGED_BODY_CHARS + 10);

    const curl = toCurl(URL_, { method: 'POST', body }, true);

    expect(curl).toContain(`[BODY TRUNCATED: ${body.length} chars total]`);
    // The logged command stays bounded regardless of how large the real body was.
    expect(curl.length).toBeLessThan(MAX_LOGGED_BODY_CHARS + 500);
  });

  it('the env opt-in reaches the default parameter (subprocess: NESSY_DEBUG_FULL_BODIES=1)', () => {
    const moduleUrl = new URL('../unified-network-interceptor.ts', import.meta.url).href;
    const script = `
      process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
      const { toCurl } = await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify(toCurl('https://api.example.com/v1', { method: 'POST', body: 'ENV_SENTINEL' }).includes('ENV_SENTINEL')));
    `;
    const on = Bun.spawnSync([process.execPath, '--eval', script], {
      env: { ...process.env, NESSY_DEBUG_FULL_BODIES: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(on.exitCode, on.stderr.toString()).toBe(0);
    expect(on.stdout.toString().trim()).toBe('true');
    const off = Bun.spawnSync([process.execPath, '--eval', script], {
      env: { ...process.env, NESSY_DEBUG_FULL_BODIES: undefined as unknown as string },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(off.exitCode, off.stderr.toString()).toBe(0);
    expect(off.stdout.toString().trim()).toBe('false');
  });
});
