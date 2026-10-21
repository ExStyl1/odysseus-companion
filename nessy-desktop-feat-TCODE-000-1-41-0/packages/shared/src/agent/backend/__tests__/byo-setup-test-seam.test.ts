/**
 * C3 — the setup-form Test button reaches the runtime drivers.
 *
 * This is the RPC→driver SEAM, not a driver unit. The handler
 * (`server-core/handlers/rpc/llm-connections.ts`, `settings.TEST_LLM_CONNECTION_SETUP`)
 * does exactly two things with the form's payload:
 * `const hint = resolveSetupTestConnectionHint(` and `await testBackendConnection({`
 * with `connection: hint,` among its arguments. Both are exercised here in that
 * order, with only the credential store faked.
 *
 * P6.624 — this paragraph used to cite that handler by a line range, and by the
 * time anyone read it the seam had moved roughly a hundred lines down the file,
 * so the citation pointed at unrelated code. That is the rot AGENTS.md's *quote
 * the sentence, not the line number* rule exists for, sitting inside the test
 * whose whole job is to pin this seam. The citation is now the RPC channel
 * constant plus the two expressions, and the last case below asserts both
 * expressions are really in the handler's source and that this docblock carries
 * no line-range citation to go stale again.
 *
 * Before C3 the resolver could emit nothing but `'pi' | 'pi_compat' |
 * 'anthropic'`, so a BYO runtime endpoint arrived at `testBackendConnection` as
 * a `pi_compat` custom endpoint:
 *
 *  - `anthropicDriver.testConnection`'s `claude-runtime` branch (T6) never ran,
 *    and the generic fallback pointed the direct Claude SDK at an OpenAI-shaped
 *    endpoint — reporting a healthy connection as broken;
 *  - the codex driver was not reachable at all (`resolveDriverRuntime` keyed off
 *    the RPC's `provider`, which cannot name it).
 *
 * The rows below therefore assert *which* driver saw the call and *with which*
 * providerType, plus the structural verdict it returned.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as credentialsIndex from '../../../credentials/index.ts';

// ------------------------------------------------------------
// Fakes — the credential store only. Drivers stay real.
// ------------------------------------------------------------

const credentialWrites: Array<{ slug: string; key: string }> = [];
const credentialDeletes: string[] = [];

const realCredentials = { ...credentialsIndex };
mock.module('../../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({
    setLlmApiKey: async (slug: string, key: string) => { credentialWrites.push({ slug, key }); },
    deleteLlmApiKey: async (slug: string) => { credentialDeletes.push(slug); },
    getLlmApiKey: async () => null,
  }),
}));

afterAll(() => {
  mock.module('../../../credentials/index.ts', () => realCredentials);
});

const { resolveSetupTestConnectionHint, testBackendConnection } = await import('../factory.ts');
const driversAnthropic = await import('../internal/drivers/anthropic.ts');
const driversCodex = await import('../internal/drivers/codex.ts');

// ------------------------------------------------------------
// Driver spies — delegate to the REAL implementation and record the call, so
// the recorded providerType and the returned verdict are both production code.
// ------------------------------------------------------------

interface DriverCall { driver: 'anthropic' | 'codex'; providerType?: string; baseUrl?: string }
const driverCalls: DriverCall[] = [];

const realAnthropicTest = driversAnthropic.anthropicDriver.testConnection!;
const realCodexTest = driversCodex.codexDriver.testConnection!;

beforeEach(() => {
  driverCalls.length = 0;
  credentialWrites.length = 0;
  credentialDeletes.length = 0;
  process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '1';
  process.env.NESSY_FEATURE_CODEX_RUNTIME = '1';

  driversAnthropic.anthropicDriver.testConnection = async (args) => {
    driverCalls.push({ driver: 'anthropic', providerType: args.connection?.providerType, baseUrl: args.baseUrl });
    return realAnthropicTest(args);
  };
  driversCodex.codexDriver.testConnection = async (args) => {
    driverCalls.push({ driver: 'codex', providerType: args.connection?.providerType, baseUrl: args.baseUrl });
    return realCodexTest(args);
  };
});

afterEach(() => {
  driversAnthropic.anthropicDriver.testConnection = realAnthropicTest;
  driversCodex.codexDriver.testConnection = realCodexTest;
  delete process.env.NESSY_FEATURE_CLAUDE_RUNTIME;
  delete process.env.NESSY_FEATURE_CODEX_RUNTIME;
});

const BYO_URL = 'https://llm-proxy.internal.example.com/v1';
const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';

/** Exactly what TEST_LLM_CONNECTION_SETUP does with the form's payload. */
async function runSetupTest(params: {
  provider: 'anthropic' | 'pi';
  apiKey: string;
  baseUrl?: string;
  runtimeProviderType?: 'codex-runtime' | 'claude-runtime';
  customEndpoint?: { api: 'openai-completions' | 'anthropic-messages' };
}) {
  const hint = resolveSetupTestConnectionHint({
    provider: params.provider,
    baseUrl: params.baseUrl,
    customEndpoint: params.customEndpoint,
    runtimeProviderType: params.runtimeProviderType,
  });
  const result = await testBackendConnection({
    provider: params.provider,
    apiKey: params.apiKey,
    model: 'deepseek-v3',
    baseUrl: params.baseUrl,
    allowEmptyApiKey: false,
    hostRuntime: { appRootPath: process.cwd(), isPackaged: false },
    connection: hint,
  });
  return { hint, result };
}

describe('setup-test seam — BYO runtime endpoints reach their own driver', () => {
  it('claude-runtime: the anthropic driver answers structurally for a keyed BYO endpoint', async () => {
    const { hint, result } = await runSetupTest({
      provider: 'anthropic',
      apiKey: 'sk-user-own-key',
      baseUrl: BYO_URL,
      runtimeProviderType: 'claude-runtime',
    });

    expect(hint).toEqual({ providerType: 'claude-runtime' });
    expect(driverCalls).toEqual([{ driver: 'anthropic', providerType: 'claude-runtime', baseUrl: BYO_URL }]);
    expect(result).toEqual({ success: true });
  });

  it('codex-runtime: the codex driver answers structurally for a keyed BYO endpoint', async () => {
    const { hint, result } = await runSetupTest({
      provider: 'anthropic',
      apiKey: 'sk-user-own-key',
      baseUrl: BYO_URL,
      runtimeProviderType: 'codex-runtime',
    });

    expect(hint).toEqual({ providerType: 'codex-runtime' });
    // The RPC's `provider` field says 'anthropic'; the hint is what decides.
    expect(driverCalls).toEqual([{ driver: 'codex', providerType: 'codex-runtime', baseUrl: BYO_URL }]);
    expect(result).toEqual({ success: true });
  });

  for (const runtimeProviderType of ['codex-runtime', 'claude-runtime'] as const) {
    it(`${runtimeProviderType}: a keyless remote BYO endpoint fails closed with a named reason`, async () => {
      const { result } = await runSetupTest({
        provider: 'anthropic',
        apiKey: '   ',
        baseUrl: BYO_URL,
        runtimeProviderType,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('API key');
    });

    it(`${runtimeProviderType}: the gateway URL short-circuits in the driver (dp creds answer at turn time)`, async () => {
      // Not reachable from the BYO form — it blocks that URL — but the driver
      // arm must still classify it as gateway mode rather than probing it.
      const { result } = await runSetupTest({
        provider: 'anthropic',
        apiKey: 'irrelevant-for-gateway-mode',
        baseUrl: GATEWAY_URL,
        runtimeProviderType,
      });

      expect(driverCalls).toHaveLength(1);
      expect(result).toEqual({ success: true });
    });
  }

  it('never spawns a backend for a runtime hint — the credential store is written and cleaned, nothing else', async () => {
    await runSetupTest({
      provider: 'anthropic',
      apiKey: 'sk-user-own-key',
      baseUrl: BYO_URL,
      runtimeProviderType: 'codex-runtime',
    });

    expect(credentialWrites).toHaveLength(1);
    expect(credentialDeletes).toEqual([credentialWrites[0]!.slug]);
  });

  for (const runtimeProviderType of ['codex-runtime', 'claude-runtime'] as const) {
    it(`DA1.13 — ${runtimeProviderType} on the gateway URL stages NO key under the __test- slug`, async () => {
      // `testBackendConnection` is the second production writer of a gateway JWT
      // into the credential store, and the only one whose delete can silently
      // fail: its `finally` is `.catch(() => {})`, so a store that refuses would
      // leave a real corporate token under a slug no connection owns. The cards
      // are zero-form, but `ApiKeyInput` PREFILLS the JWT on the gateway preset,
      // so the form's Test button arrives here carrying one.
      await runSetupTest({
        provider: 'anthropic',
        apiKey: 'header.payload.signature',
        baseUrl: GATEWAY_URL,
        runtimeProviderType,
      });

      expect(credentialWrites).toEqual([]);
      // The driver still answered, so this is "not staged", not "not tested".
      expect(driverCalls).toHaveLength(1);
    });
  }

  it('DA1.13 POSITIVE CONTROL: the same key on a BYO endpoint is still staged', async () => {
    // Without this the row above would pass against a build that had stopped
    // staging for every connection, which is the failure it is guarding.
    await runSetupTest({
      provider: 'anthropic',
      apiKey: 'header.payload.signature',
      baseUrl: BYO_URL,
      runtimeProviderType: 'claude-runtime',
    });

    expect(credentialWrites).toHaveLength(1);
    expect(credentialWrites[0]!.key).toBe('header.payload.signature');
  });

  it('POSITIVE CONTROL: without the runtime hint the same payload is classified pi_compat and the anthropic driver declines', async () => {
    // The pre-C3 behavior, asserted at the driver boundary so the generic
    // fallback (a real Claude SDK subprocess) never runs in this suite. This is
    // what made the runtime branches unreachable.
    const hint = resolveSetupTestConnectionHint({ provider: 'anthropic', baseUrl: BYO_URL });
    expect(hint).toEqual({ providerType: 'pi_compat' });

    const declined = await realAnthropicTest({
      provider: 'anthropic',
      apiKey: 'sk-user-own-key',
      model: 'deepseek-v3',
      baseUrl: BYO_URL,
      connection: hint,
      hostRuntime: { appRootPath: process.cwd(), isPackaged: false },
      resolvedPaths: {} as never,
      timeoutMs: 1000,
    });
    expect(declined).toBeNull();
  });
});

/**
 * P6.624 — the citation pin, in the shape `llm-connections-bedrock-region.test.ts`
 * uses: quote the expression, never the line number. A moved seam now turns this
 * red instead of leaving a docblock that points at unrelated code.
 */
describe('P6.624 — the seam is cited by expression, not by line range', () => {
  const HANDLER = join(
    import.meta.dir,
    '../../../../../..',
    'packages/server-core/src/handlers/rpc/llm-connections.ts',
  );

  it('finds both quoted expressions in the handler that owns the seam', () => {
    const source = readFileSync(HANDLER, 'utf-8');
    expect(source).toContain('const hint = resolveSetupTestConnectionHint(');
    expect(source).toContain('await testBackendConnection({');
    // The binding between them: the hint is what the driver call is given.
    expect(source).toContain('connection: hint,');
  });

  it('NEGATIVE: this docblock carries no line-range citation to go stale', () => {
    const own = readFileSync(join(import.meta.dir, 'byo-setup-test-seam.test.ts'), 'utf-8');
    // Positive control, so a renamed handler cannot read as "nothing to check".
    expect(own).toContain('llm-connections.ts');
    expect(own).not.toMatch(/llm-connections\.ts:\d/);
  });
});
