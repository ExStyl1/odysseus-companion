import { describe, expect, it } from 'bun:test';
import { piDriver, classifyModelsProbe } from './pi.ts';

// F1.59 CI (MR !49 rows 11-15): since F1.727 (5b2578294) the driver resolves the
// search service's rg from `hostRuntime.appRootPath`, so an empty host crashed every
// build here in `resolveUpwards`. No real host lacks the field: it is a required
// string on `BackendHostRuntimeContext`, and the factory resolves every other runtime
// path from it before `buildRuntime` runs. This is the headless server's own default.
const HOST_RUNTIME = { appRootPath: process.cwd(), isPackaged: false };

describe('piDriver.buildRuntime custom endpoint models', () => {
  it('preserves explicit per-model supportsImages values', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key',
        resolvedModel: 'vision-model',
        capabilities: { needsHttpPoolServer: false },
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi',
          authType: 'api_key',
          baseUrl: 'http://127.0.0.1:11111/v1',
          customEndpoint: { api: 'anthropic-messages', supportsImages: true },
          models: [
            { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
            { id: 'text-only-model', supportsImages: false },
            { id: 'plain-model' },
          ],
          createdAt: Date.now(),
        } as any,
      },
      coreConfig: {} as any,
      hostRuntime: HOST_RUNTIME,
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      { id: 'text-only-model', supportsImages: false },
      'plain-model',
    ]);
  });
});

describe('P6.367 — the whitelist carries the operator capability declaration', () => {
  const build = (models: unknown[]) => piDriver.buildRuntime({
    context: {
      provider: 'pi',
      authType: 'api_key',
      resolvedModel: 'reasoning-model',
      capabilities: { needsHttpPoolServer: false },
      connection: {
        slug: 'custom-endpoint',
        name: 'Custom Endpoint',
        providerType: 'pi',
        authType: 'api_key',
        baseUrl: 'http://127.0.0.1:11111/v1',
        models,
        createdAt: Date.now(),
      } as any,
    },
    coreConfig: {} as any,
    hostRuntime: HOST_RUNTIME,
    resolvedPaths: {
      piServerPath: '/tmp/pi-agent-server.js',
      interceptorBundlePath: '/tmp/interceptor.cjs',
      nodeRuntimePath: '/usr/bin/node',
    },
  });

  it('carries `supportsThinking` through, on its own and beside the other overrides', () => {
    // On its own is the case the whitelist used to lose: with no window and no
    // image flag the entry collapsed to a bare id string and the declaration
    // vanished without anything failing.
    expect(build([
      { id: 'reasoning-model', supportsThinking: true },
      { id: 'both-model', contextWindow: 40_960, supportsImages: true, supportsThinking: true },
      { id: 'refuses-model', supportsThinking: false },
    ]).customModels).toEqual([
      { id: 'reasoning-model', supportsThinking: true },
      { id: 'both-model', contextWindow: 40_960, supportsImages: true, supportsThinking: true },
      { id: 'refuses-model', supportsThinking: false },
    ]);
  });

  it('leaves an undeclared model a bare id — the control that this is a declaration, not a default', () => {
    expect(build([{ id: 'plain-model' }, 'string-model']).customModels)
      .toEqual(['plain-model', 'string-model']);
  });
});

describe('DA1.22 — the whitelist carries the catalogue\'s sampling params', () => {
  const build = (models: unknown[]) => piDriver.buildRuntime({
    context: {
      provider: 'pi',
      authType: 'api_key',
      resolvedModel: 'tgpt/deepseek-v4-flash-0731',
      capabilities: { needsHttpPoolServer: false },
      connection: {
        slug: 'nessy-gateway',
        name: 'Nessy Gateway',
        providerType: 'pi',
        authType: 'api_key',
        baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
        models,
        createdAt: Date.now(),
      } as any,
    },
    coreConfig: {} as any,
    hostRuntime: HOST_RUNTIME,
    resolvedPaths: {
      piServerPath: '/tmp/pi-agent-server.js',
      interceptorBundlePath: '/tmp/interceptor.cjs',
      nodeRuntimePath: '/usr/bin/node',
    },
  });

  // On its OWN is the case this whitelist loses first: with no window, no image
  // flag and no thinking declaration, an entry carrying only sampling params
  // would collapse to a bare id and the catalogue's recommendation would vanish
  // between the connection and the subprocess with nothing failing. Fixture
  // values are WA-e's live reading of 2026-09-13.
  it('carries samplingParams on its own and beside the other declarations', () => {
    expect(build([
      { id: 'tgpt/deepseek-v4-flash-0731', samplingParams: { temperature: 1, top_p: 0.95 } },
      { id: 'tgpt/qwen36-35b-a3b-fp8', contextWindow: 262_000, samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 } },
    ]).customModels).toEqual([
      { id: 'tgpt/deepseek-v4-flash-0731', samplingParams: { temperature: 1, top_p: 0.95 } },
      { id: 'tgpt/qwen36-35b-a3b-fp8', contextWindow: 262_000, samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 } },
    ]);
  });

  it('an empty or non-object value is not a recommendation and collapses to a bare id', () => {
    expect(build([
      { id: 'a', samplingParams: {} },
      { id: 'b', samplingParams: [1, 2] },
      { id: 'c' },
    ]).customModels).toEqual(['a', 'b', 'c']);
  });
});

describe('classifyModelsProbe (OpenAI-compatible /v1/models probe)', () => {
  it('treats 2xx as reachable + authorized → pass', () => {
    expect(classifyModelsProbe(200)).toEqual({ success: true });
    expect(classifyModelsProbe(204)).toEqual({ success: true });
  });

  it('treats 3xx as reachable → pass', () => {
    expect(classifyModelsProbe(302)).toEqual({ success: true });
  });

  it('treats 404/405 (endpoint up, /v1/models route absent) as pass', () => {
    expect(classifyModelsProbe(404)).toEqual({ success: true });
    expect(classifyModelsProbe(405)).toEqual({ success: true });
  });

  it('treats other 4xx (400 bad request, 429 throttled) as reachable → pass', () => {
    // The endpoint is up and authenticating (else it would 401/403); a bare-GET
    // rejection or rate-limit must not false-negative the connection test (#783).
    expect(classifyModelsProbe(400)).toEqual({ success: true });
    expect(classifyModelsProbe(429)).toEqual({ success: true });
  });

  it('treats 401/403 as auth failure', () => {
    expect(classifyModelsProbe(401).success).toBe(false);
    expect(classifyModelsProbe(401).error).toMatch(/401/);
    expect(classifyModelsProbe(403).success).toBe(false);
  });

  it('treats 5xx as service error → fail', () => {
    expect(classifyModelsProbe(500).success).toBe(false);
    expect(classifyModelsProbe(503).success).toBe(false);
  });
});
