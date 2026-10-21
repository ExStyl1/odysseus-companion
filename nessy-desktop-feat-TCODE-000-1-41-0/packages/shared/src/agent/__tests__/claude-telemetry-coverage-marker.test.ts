/**
 * P2.423 — claude's audit telemetry is a configuration, and the configuration
 * has to say what it covers.
 *
 * The shipped SDK already carries the whole exporter, and
 * `buildClaudeSubprocessEnv` spreads `process.env`, so an operator who exports
 * `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*` already gets `claude_code.*` events
 * out of a Nessy session. Two things had to be established before that could be
 * called done, and this suite pins both:
 *
 * 1. **The two settings do not fight.** The gateway path writes
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'`, whose documentation is
 *    undecidable on whether it suppresses telemetry. Measured in the shipped
 *    binary it gates a DIFFERENT branch of `initializeTelemetry` — Anthropic's
 *    own first-party metric reader — while the operator's OTLP exporters hang
 *    off `CLAUDE_CODE_ENABLE_TELEMETRY` alone. So both envs must be present
 *    together on an exporting gateway session, and the row below asserts
 *    exactly that pairing rather than assuming it.
 * 2. **Coverage is marked, because the vocabularies are disjoint.** The SDK
 *    emits `claude_code.*`; the host's Pi stream emits `session.started` /
 *    `permission.decided` / `tool.completed` and is already stamped
 *    `nessy.telemetry.coverage = pi-sessions-only`. A SIEM query written for
 *    one returns silence for the other, and silence that explains itself is the
 *    whole point (P6.42: partial coverage nobody can see is worse than none).
 *
 * ## P3.52 — the asymmetry these tests pin is a POSTURE, and it stays
 *
 * Two of the assertions below are the whole of `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`'s
 * placement in this product: the GATEWAY tail sets it to `'1'`, the DIRECT-Anthropic
 * tail never writes it at all. Until now nothing said why, and a reader who
 * noticed the difference had two equally plausible repairs available — set it on
 * both, or unset it on both — each of which changes what the product can DO.
 *
 * Owner-delegated controller decision 2026-09-02 (§E3): **keep the asymmetry,
 * and record why.** Both halves:
 *
 * - **Do not remove it from the gateway path.** Per `env-vars.md#variables`,
 *   re-curled 2026-09-11 (C3.63), the variable disables far more than telemetry:
 *   *"auto-updates, telemetry, error reporting, the `/feedback` command,
 *   Claude-drafted feedback, release notes, the PR and MR status badge checks,
 *   and availability checks such as the fast mode check"*, plus *"background runs
 *   of plugin `command` sources"*, and it *"Also disables feature-flag fetching,
 *   which makes Remote Control … unavailable"*. On this path the child's only
 *   reachable upstream is a loopback port answering `/v1/messages`; unsetting the
 *   variable would re-open every one of those egresses, deliberately closed. Note
 *   the page's own trap while you are here: *"Setting it to `0` or `false` still
 *   disables this traffic"* — the opt-out is UNSETTING, so there is no "turn it
 *   off politely" middle option.
 *
 *   **One clause of that list is GONE from the page and is struck here rather
 *   than carried.** It used to read *"… the PR and MR status badge checks,
 *   gateway model discovery refreshes, and availability checks …"*; today the
 *   same row ends *"Doesn't affect gateway model discovery, which has its own
 *   opt-in"*. So this variable buys us nothing on that egress, and what closes
 *   it is our never setting the separate opt-in — measured and recorded at
 *   `packages/shared/src/config/claude-provider-routing-env.ts` symbol
 *   `CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS`. A second carve-out arrived with
 *   it, recorded because this fork does not rely on it either: *"Official plugin
 *   marketplace auto-install isn't covered; disable it with
 *   `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`"*.
 * - **Do not add it to the subscription path.** Provider subscription surfaces
 *   are GATED for this plan — not built, not deleted, not tidied — so writing a
 *   posture onto that path would be building on a surface nobody has decided
 *   about. It stays untouched.
 *
 * One documented exception rides with the gateway half and is written out at the
 * site rather than here: `data-usage.md#webfetch-domain-safety-check` — the
 * WebFetch hostname pre-check *"is not affected by
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`"*.
 *
 * The `claude-agent.ts` env block is the primary site; this suite is where the
 * asymmetry is CHECKED, which is why the reason is recorded beside the check —
 * a posture whose only record is a comment rots faster than one an assertion
 * holds.
 *
 * Hermetic: connection storage, credentials, validation and the adapter
 * launcher are faked. Nothing opens a socket or spawns the SDK.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as configStorage from '../../config/storage.ts';
import * as credentialsIndex from '../../credentials/index.ts';
import * as llmValidation from '../../config/llm-validation.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import { gatewayModelFixture } from '../../config/__tests__/fixtures/gateway-connection-fixture.ts';

const COVERAGE_KEY = 'nessy.telemetry.coverage';
const COVERAGE_VALUE = 'claude-sdk-events-only';
const MARKER = `${COVERAGE_KEY}=${COVERAGE_VALUE}`;

// ============================================================
// Fakes
// ============================================================

let storedConnection: LlmConnection | null = null;
let storedApiKey: string | null = null;

const realStorage = { ...configStorage };
const realCredentials = { ...credentialsIndex };
const realValidation = { ...llmValidation };
const realAdapter = { ...adapterPackage };

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getLlmConnection: (slug: string) => (
    storedConnection && slug === storedConnection.slug
      ? storedConnection
      : realStorage.getLlmConnection(slug)
  ),
}));

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => storedApiKey }),
}));

mock.module('../../config/llm-validation.ts', () => ({
  ...realValidation,
  validateAnthropicConnection: async () => ({ success: true }),
}));

mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => (
    { port: 46071, close: async () => { /* nothing bound */ } }
  ),
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('../../config/llm-validation.ts', () => realValidation);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

// ============================================================
// Fixtures
// ============================================================

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';

function gatewayConnection(): LlmConnection {
  return {
    slug: 'nessy-claude',
    name: 'Nessy Claude',
    providerType: 'claude-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: MODEL,
    models: [
      // P6.784 — the row comes from the card's own builder, which is what puts
      // `supportsThinking: false` into it. Written by hand the field was absent,
      // and `ModelDefinition` documents it *"Defaults to true when undefined"*
      // while both shipped gateway rows declare `false`.
      { ...gatewayModelFixture({ id: MODEL, contextWindow: 262_144 }), name: 'Qwen', shortName: 'Qwen' },
    ] as unknown as LlmConnection['models'],
    createdAt: Date.now(),
  } as LlmConnection;
}

function agentConfig(): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'claude-runtime',
    connectionSlug: 'nessy-claude',
    model: MODEL,
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-p2423',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-p2423',
      workspaceRootPath: '/tmp/ws-p2423',
      sessionRootPath: '/tmp/ws-p2423/sessions',
    } as never,
    session: {
      id: 'session-p2423',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-p2423',
    } as never,
  } as BackendConfig;
}

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_RESOURCE_ATTRIBUTES',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  storedConnection = gatewayConnection();
  storedApiKey = null;
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  delete process.env.OTEL_RESOURCE_ATTRIBUTES;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A DIRECT-Anthropic connection: `postInit`'s other tail, not the adapter's. */
function directConnection(): LlmConnection {
  return {
    slug: 'direct-anthropic',
    name: 'Direct Anthropic',
    providerType: 'anthropic',
    authType: 'api_key',
    defaultModel: 'claude-opus-4-5',
    createdAt: Date.now(),
  } as LlmConnection;
}

/** Run `postInit` and hand back the per-session env the subprocess will see. */
async function overridesAfterPostInit(
  overrides: Partial<BackendConfig> = {},
): Promise<Record<string, string>> {
  const agent = new ClaudeAgent({ ...agentConfig(), ...overrides } as BackendConfig);
  try {
    const result = await agent.postInit();
    expect(result.authInjected).toBe(true);
    return (agent as unknown as { config: BackendConfig }).config.envOverrides ?? {};
  } finally {
    agent.destroy();
  }
}

// ============================================================

describe('P2.423 — the coverage marker rides the SDK telemetry the operator enabled', () => {
  it('stamps the marker when the child will export, alongside the essential-traffic flag', async () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';

    const overrides = await overridesAfterPostInit();

    expect(overrides.OTEL_RESOURCE_ATTRIBUTES).toBe(MARKER);
    // The measured pairing: the flag that suppresses ANTHROPIC's own first-party
    // reader stays on, and it does not suppress the operator's exporters. If a
    // later change makes these mutually exclusive, this row is where it shows.
    expect(overrides.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('writes nothing at all when the child will not export', async () => {
    const overrides = await overridesAfterPostInit();

    // A coverage marker on a session that emits nothing is not merely noise —
    // it would assert a stream that does not exist.
    expect(overrides.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    expect(overrides.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('appends after the operator’s own attributes instead of replacing them', async () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = 'true';
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'department=engineering,team.id=platform';

    const overrides = await overridesAfterPostInit();

    expect(overrides.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `department=engineering,team.id=platform,${MARKER}`,
    );
  });

  it('does not produce an empty pair when the operator’s value ends in a comma', async () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'department=engineering,';

    const overrides = await overridesAfterPostInit();

    expect(overrides.OTEL_RESOURCE_ATTRIBUTES).toBe(`department=engineering,${MARKER}`);
    expect(overrides.OTEL_RESOURCE_ATTRIBUTES).not.toContain(',,');
  });

  it('leaves an operator who already declared the key completely alone', async () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_RESOURCE_ATTRIBUTES = `${COVERAGE_KEY}=our-own-pipeline,team.id=platform`;

    const overrides = await overridesAfterPostInit();

    // They are describing their pipeline; we are not.
    expect(overrides.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
  });

  it('marks the DIRECT-Anthropic tail too, which is a separate call site', async () => {
    // `postInit` has two tails: the local-adapter branch returns early, so a
    // marker written only there would leave every subscription/BYO Anthropic
    // session exporting unlabelled events.
    storedConnection = directConnection();
    storedApiKey = 'sk-not-a-real-key';
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';

    const overrides = await overridesAfterPostInit({
      providerType: 'anthropic',
      connectionSlug: 'direct-anthropic',
    } as Partial<BackendConfig>);

    expect(overrides.OTEL_RESOURCE_ATTRIBUTES).toBe(MARKER);
    // …and this path never wrote the essential-traffic flag, so the marker is
    // not riding on it.
    expect(overrides.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });

  it('reads the flag with the shipped binary’s own truthiness set, both directions', async () => {
    // `tr()` in the native binary: falsy → false, else lowercase+trim and match
    // ["1","true","yes","on"]. A spelling the SDK accepts and we reject would
    // mean an exporting child with no marker on it.
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'on', 'On']) {
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY = on;
      const overrides = await overridesAfterPostInit();
      expect({ on, attrs: overrides.OTEL_RESOURCE_ATTRIBUTES }).toEqual({ on, attrs: MARKER });
    }

    for (const off of ['0', 'false', 'no', 'off', '']) {
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY = off;
      const overrides = await overridesAfterPostInit();
      expect({ off, attrs: overrides.OTEL_RESOURCE_ATTRIBUTES }).toEqual({ off, attrs: undefined });
    }
  });
});
