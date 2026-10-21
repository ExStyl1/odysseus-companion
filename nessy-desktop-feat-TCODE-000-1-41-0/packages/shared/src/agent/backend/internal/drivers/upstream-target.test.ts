/**
 * `attachUpstreamCredential`'s slug contract (C3).
 *
 * C1 left a slugless BYO target as a silent keyless fallback, on the reasoning
 * that no caller could produce one while BYO connections could not be created.
 * The endpoint form makes them user-creatable, and a keyless request to the
 * user's own endpoint comes back 401 — indistinguishable, from where they sit,
 * from a bad key. It now fails closed and names the real problem.
 *
 * Keyless is still legitimate when the slug IS present and the store simply has
 * no key for it (Ollama and friends, `authType: 'none'`); that row is the
 * boundary the throw must not swallow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  _resetModelTargetNoticesForTesting,
  attachUpstreamCredential,
  classifyModelTarget,
  isNessyGatewayBaseUrl,
  modelTargetBaseUrlForConnection,
  modelTargetForEndpoint,
  modelTargetForModel,
  modelTargetOperatorLog,
  modelTargetToolEgressNotice,
  noteModelTargetToolEgress,
  noteModelTargetVerdictEgress,
  normalizeUpstreamBaseUrl,
  type ModelTargetClass,
} from './upstream-target.ts';

const BYO_URL = 'https://llm-proxy.internal.example.com/v1';
const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';

function manager(apiKey: string | null) {
  return () => ({ getLlmApiKey: async () => apiKey });
}

describe('attachUpstreamCredential', () => {
  it('attaches the stored key to a BYO target', async () => {
    expect(await attachUpstreamCredential({
      target: { kind: 'openai-compatible', baseUrl: BYO_URL },
      slug: 'codex-custom',
      credentialManager: manager('sk-user-own-key'),
    })).toEqual({ kind: 'openai-compatible', baseUrl: BYO_URL, apiKey: 'sk-user-own-key' });
  });

  it('leaves a BYO target keyless when the store has no key for the slug', async () => {
    expect(await attachUpstreamCredential({
      target: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
      slug: 'codex-custom',
      credentialManager: manager(null),
    })).toEqual({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' });
  });

  it('throws for a BYO target with no slug instead of sending an unauthenticated request', async () => {
    await expect(attachUpstreamCredential({
      target: { kind: 'openai-compatible', baseUrl: BYO_URL },
      credentialManager: manager('sk-user-own-key'),
    })).rejects.toThrow('connection slug missing');
  });

  it('never constructs the credential manager for a gateway target, slug or not', async () => {
    // The gateway authenticates with dp creds inside the adapter; constructing
    // the manager here would both add a second reader and throw on an
    // uninitialized store (the C1 review's row).
    const exploding = () => { throw new Error('credential store not initialized'); };

    expect(await attachUpstreamCredential({
      target: { kind: 'nestor' },
      slug: 'codex-gateway',
      credentialManager: exploding as never,
    })).toEqual({ kind: 'nestor' });

    expect(await attachUpstreamCredential({
      target: { kind: 'nestor' },
      credentialManager: exploding as never,
    })).toEqual({ kind: 'nestor' });
  });
});

describe('isNessyGatewayBaseUrl / normalizeUpstreamBaseUrl', () => {
  const GATEWAY = GATEWAY_URL;

  it('is a whole-URL match, normalized for trailing slashes', () => {
    expect(isNessyGatewayBaseUrl(GATEWAY)).toBe(true);
    expect(isNessyGatewayBaseUrl(`${GATEWAY}/`)).toBe(true);
    expect(isNessyGatewayBaseUrl(`${GATEWAY}/proxy`)).toBe(false);
    expect(isNessyGatewayBaseUrl('https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1')).toBe(false);
    expect(isNessyGatewayBaseUrl('')).toBe(false);
    expect(isNessyGatewayBaseUrl(undefined)).toBe(false);
  });

  it('normalizes by trimming space and trailing slashes only', () => {
    expect(normalizeUpstreamBaseUrl('  https://x.test/v1//  ')).toBe('https://x.test/v1');
  });
});

/**
 * P3.363 - the model-target classifier and its disclosure.
 *
 * The table is written the way the source plan's W1 asked for it, plus the two
 * rows a substring test would get wrong: a host whose PATH contains a proxy
 * name, and an id whose namespace nobody has listed. Both must land on the
 * fail-closed side without the vendor list having anything to say about them,
 * because that list can never be complete and this suite is the fence that
 * keeps it from becoming load-bearing.
 */
describe('classifyModelTarget', () => {
  const GATEWAY = GATEWAY_URL;

  const rows: Array<[string, { baseUrl?: string; model?: string; providerType?: string }, ModelTargetClass, boolean]> = [
    ['the verified gateway, any model', { baseUrl: GATEWAY, model: 'anthropic/claude-sonnet-4-5' }, 'nessy-gateway', false],
    ['a loopback endpoint', { baseUrl: 'http://localhost:11434/v1', model: 'llama3' }, 'loopback', false],
    ['loopback by address', { baseUrl: 'http://127.0.0.1:8080/v1', model: 'whatever' }, 'loopback', false],
    ['an in-perimeter namespace off-gateway', { baseUrl: 'https://proxy.example.test/v1', model: 'tgpt/qwen35-397b-a17b-fp8' }, 'vendor-internal', false],
    ['an external vendor namespace', { baseUrl: 'https://proxy.example.test/v1', model: 'anthropic/claude-sonnet-4-5' }, 'external-vendor', true],
    // DA2.1 — NOT the "un-resolved state" this row used to record. The
    // resolution is namespace-only, so a BYO endpoint discloses like any other:
    // see the DA2.1 section of the module docblock and the pin below.
    ['a BYO endpoint at the vendor itself', { baseUrl: 'https://api.openai.com/v1', model: 'openai/gpt-5' }, 'external-vendor', true],
    ['an unlisted namespace', { baseUrl: 'https://proxy.example.test/v1', model: 'newvendor/model-1' }, 'unclassified', true],
    ['an unprefixed id off-gateway', { baseUrl: 'https://proxy.example.test/v1', model: 'gpt-5' }, 'unclassified', true],
    // D1.191 — the two SUBSCRIPTION cards, whose ids carry no namespace at all.
    // Both were reaching the fallback arm; the Claude one disclosed with the
    // reason "the model id carries no vendor namespace" ABOUT `api.anthropic.com`,
    // and the ChatGPT one (endpoint-less until the factory's second named
    // default) never reached this function with a host. `restricted` is
    // unchanged on both — the host vocabulary moves the WORDING, not the axis.
    ['an unprefixed id at the Anthropic API', { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-8' }, 'external-vendor', true],
    ['an unprefixed id at the ChatGPT backend', { baseUrl: 'https://chatgpt.com/backend-api', model: 'gpt-5-codex' }, 'external-vendor', true],
    ['an unparseable endpoint', { baseUrl: 'not a url', model: 'tgpt/x' }, 'unclassified', true],
    // D1.221 — an endpoint-less verdict from a caller that names NO provider is
    // unchanged, deliberately: the one such caller is the renderer's picker
    // helper, and its own under-disclosure predates this row. See the arm's
    // comment in `upstream-target.ts` and the hand-off it names.
    ['no endpoint at all, no provider named', { model: 'tgpt/x' }, 'provider-default', false],
    // With the provider NAMED — which is what `backend/factory.ts` passes on the
    // path that both discloses and withholds — the arm is FAIL-CLOSED. It read
    // `false` until this row, so an endpoint-less Pi card on `openai` or
    // `github-copilot` disclosed nothing although Pi sends it to that vendor's
    // own API, and since DA2.14 withheld nothing either.
    ['no endpoint, a named provider', { model: 'gpt-5', providerType: 'pi' }, 'provider-default', true],
    // The ONE measured exception, and the control that makes the flip above a
    // decision rather than a blanket: the Nessy Cloud Agent is created with no
    // baseUrl and its egress is internal by declaration, not by URL.
    ['no endpoint, the Nessy Cloud Agent', { model: 'nessy-cloud', providerType: 'nestor-cloud-agent' }, 'provider-default', false],
    // ...and the exception is keyed on THAT providerType and no other: an
    // endpoint-less adapter-runtime card stays restricted too.
    ['no endpoint, a claude-runtime card', { model: 'claude-opus-4-8', providerType: 'claude-runtime' }, 'provider-default', true],
  ];

  for (const [name, input, expectedClass, expectedRestricted] of rows) {
    it(`classifies ${name}`, () => {
      const verdict = classifyModelTarget(input);
      expect(verdict.class).toBe(expectedClass);
      expect(verdict.restricted).toBe(expectedRestricted);
    });
  }

  /**
   * D1.191 — the wording arm, and its negative.
   *
   * The positive says the reason NAMES the vendor host instead of reporting the
   * vendor's own front door as unplaceable; the negative says an unknown host
   * with the same unprefixed id is still `unclassified`, so the vocabulary is a
   * vocabulary and not a gate. Both stay restricted, which is the third
   * assertion: this row changed no verdict, only what the user is told.
   */
  it('names the vendor host in the reason instead of calling it unplaceable', () => {
    const atTheVendor = classifyModelTarget({ baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-8' });
    expect(atTheVendor.reason).toContain('api.anthropic.com');
    expect(atTheVendor.reason).not.toContain('carries no vendor namespace');
    expect(atTheVendor.restricted).toBe(true);
  });

  it('leaves an unprefixed id at an UNKNOWN host unplaceable, and still restricted', () => {
    const unknown = classifyModelTarget({ baseUrl: 'https://proxy.example.test/v1', model: 'claude-opus-4-8' });
    expect(unknown.class).toBe('unclassified');
    expect(unknown.reason).toBe('the model id carries no vendor namespace');
    expect(unknown.restricted).toBe(true);
  });

  it('parses the host instead of matching a substring of the URL', () => {
    // nessy-cli's `baseUrl.includes('llm-proxy')` accepts this URL as the corp
    // proxy. Ours reads the HOST, so the path segment decides nothing; the
    // model namespace does, and an in-perimeter one stays unrestricted.
    const verdict = classifyModelTarget({
      baseUrl: 'https://evil.example.test/llm-proxy.t-tech.team/v1',
      model: 'tgpt/qwen35-397b-a17b-fp8',
    });
    expect(verdict.host).toBe('evil.example.test');
    expect(verdict.restricted).toBe(false);
  });

  /**
   * DA2.1 — the connection is NOT an axis, and this is the pin that says so.
   *
   * The BYO card's own default endpoint IS the corporate proxy channel
   * (`byo-runtime.ts` symbol `DEFAULT_ENDPOINT_URL`), which is why a
   * connection-KIND axis cannot separate the population DP-5 restricts from the
   * one it exempts. Under the resolution, both endpoints answer identically and
   * the MODEL decides — so this pair fails the day a kind axis is added, which
   * is the whole point of asserting it.
   */
  it('gives the BYO default corp-proxy endpoint and a BYO endpoint at the vendor the same verdict', () => {
    const corpProxy = classifyModelTarget({ baseUrl: 'https://llm-proxy.t-tech.team/v1', model: 'anthropic/claude-sonnet-4-5' });
    const atTheVendor = classifyModelTarget({ baseUrl: 'https://api.anthropic.com/v1', model: 'anthropic/claude-sonnet-4-5' });
    expect(corpProxy.class).toBe('external-vendor');
    expect(atTheVendor.class).toBe('external-vendor');
    expect(corpProxy.restricted).toBe(atTheVendor.restricted);
  });

  it('lets the NAMESPACE move that verdict on the very same BYO endpoint', () => {
    // The negative control for the pin above: same endpoint, in-perimeter model,
    // and the verdict flips — so the assertion is testing the namespace axis and
    // not an endpoint that could never be restricted.
    const verdict = classifyModelTarget({ baseUrl: 'https://llm-proxy.t-tech.team/v1', model: 'tgpt/qwen36-35b-a3b-fp8' });
    expect(verdict.class).toBe('vendor-internal');
    expect(verdict.restricted).toBe(false);
  });

  it('never puts the path or query of an endpoint in the verdict', () => {
    const verdict = classifyModelTarget({
      baseUrl: 'https://proxy.example.test/v1?key=sk-secret-value',
      model: 'anthropic/claude-sonnet-4-5',
    });
    expect(verdict.host).toBe('proxy.example.test');
    expect(JSON.stringify(verdict)).not.toContain('sk-secret-value');
  });
});

/**
 * D1.425 — the verdict must follow a MID-SESSION model change.
 *
 * `classifyModelTarget` runs once, in `createBackendFromResolvedContext`, and pi
 * and codex outlive it (they answer `updateRuntimeConfig` in place, so
 * `SessionManager` keeps the agent instead of rebuilding it). `modelTargetForModel`
 * is what `BaseAgent.setSourceServers` calls to ask the same question again for
 * the model the turn is actually about to send with.
 *
 * THE LOAD-BEARING ARM IS THE EQUIVALENCE, not the two flip cases: the whole
 * design is that this is the SAME classification re-run, never a second one, so
 * the pin is that re-deriving is indistinguishable from classifying afresh —
 * over every endpoint shape the table above enumerates, both directions.
 */
describe('modelTargetForModel', () => {
  /** Every endpoint shape `classifyModelTarget`'s own table carries. */
  const endpoints: Array<[string, { baseUrl?: string; providerType?: string }]> = [
    ['the verified gateway', { baseUrl: GATEWAY_URL }],
    ['a loopback endpoint', { baseUrl: 'http://localhost:11434/v1' }],
    ['a corporate proxy', { baseUrl: BYO_URL }],
    ['the vendor\'s own API', { baseUrl: 'https://api.openai.com/v1' }],
    ['the Anthropic API', { baseUrl: 'https://api.anthropic.com' }],
    ['an unparseable endpoint', { baseUrl: 'not a url' }],
    ['no endpoint, no provider named', {}],
    ['no endpoint, a named provider', { providerType: 'pi' }],
    ['no endpoint, the Nessy Cloud Agent', { providerType: 'nestor-cloud-agent' }],
  ];
  /** In-perimeter, external-by-namespace, and two that carry no namespace at all. */
  const models = ['tgpt/deepseek-v4-flash-0731', 'anthropic/claude-sonnet-4-5', 'gpt-4o', 'newvendor/model-1'];

  for (const [name, endpoint] of endpoints) {
    for (const from of models) {
      for (const to of models) {
        it(`re-derives ${name} from "${from}" to "${to}" exactly as a fresh classification would`, () => {
          const reDerived = modelTargetForModel(classifyModelTarget({ ...endpoint, model: from }), to);
          expect(reDerived).toEqual(classifyModelTarget({ ...endpoint, model: to }));
        });
      }
    }
  }

  it('is the identity when the model has not moved', () => {
    const verdict = classifyModelTarget({ baseUrl: BYO_URL, model: 'tgpt/deepseek-v4-flash-0731' });
    expect(modelTargetForModel(verdict, 'tgpt/deepseek-v4-flash-0731')).toEqual(verdict);
  });

  it('flips an unrestricted in-perimeter session to restricted on a switch to an external model', () => {
    const before = classifyModelTarget({ baseUrl: BYO_URL, model: 'tgpt/deepseek-v4-flash-0731' });
    expect(before.restricted).toBe(false);
    const after = modelTargetForModel(before, 'gpt-4o');
    expect(after?.restricted).toBe(true);
    expect(after?.host).toBe(before.host);
  });

  it('releases the lock-out on the way BACK to an in-perimeter model', () => {
    // The other direction, and it is not cosmetic: without it a session that
    // once touched an external model keeps the seven-name whitelist in force
    // over its own servers until it is restarted.
    const before = classifyModelTarget({ baseUrl: BYO_URL, model: 'anthropic/claude-sonnet-4-5' });
    expect(before.restricted).toBe(true);
    expect(modelTargetForModel(before, 'tgpt/deepseek-v4-flash-0731')?.restricted).toBe(false);
  });

  it('never MINTS a verdict — undefined in, undefined out', () => {
    // `BackendConfig.modelTarget` absent means "classified nothing", and a
    // backend built outside the factory must keep withholding nothing.
    expect(modelTargetForModel(undefined, 'gpt-4o')).toBeUndefined();
  });

  it('leaves a gateway session unrestricted whatever model it picks', () => {
    // The negative control for the flip arms: on the verified gateway the
    // ENDPOINT decides, so no model pick may start withholding there.
    const gateway = classifyModelTarget({ baseUrl: GATEWAY_URL, model: 'tgpt/deepseek-v4-flash-0731' });
    expect(modelTargetForModel(gateway, 'anthropic/claude-sonnet-4-5')).toEqual(gateway);
  });

  it('keeps the providerType carve-out an endpoint-less verdict was given', () => {
    // The Nessy Cloud Agent is unrestricted by DECLARATION, not by URL, and the
    // providerType that carves it out is not on the verdict — so re-deriving
    // must return it untouched rather than re-running without that input.
    const cloud = classifyModelTarget({ providerType: 'nestor-cloud-agent', model: 'nessy-cloud' });
    expect(cloud.restricted).toBe(false);
    expect(modelTargetForModel(cloud, 'gpt-4o')).toEqual(cloud);
  });
});

describe('modelTargetToolEgressNotice', () => {
  const external = classifyModelTarget({ baseUrl: 'https://proxy.example.test/v1', model: 'anthropic/claude-sonnet-4-5' });

  it('says nothing for an unrestricted target', () => {
    expect(modelTargetToolEgressNotice(classifyModelTarget({ baseUrl: 'http://localhost:11434/v1', model: 'llama3' })))
      .toBeNull();
  });

  it('states the allow-list withholding when no tool names are available (F1.908)', () => {
    // Since DA2.14 the host DOES filter: the pool withholds every MCP server
    // outside the external-model allow list on this same `restricted` flag. The
    // notice used to say the opposite ("sent to it unfiltered - no host control
    // exists yet") on the line right above the withholding receipt.
    const notice = modelTargetToolEgressNotice(external)!;
    expect(notice).toContain('proxy.example.test');
    expect(notice).toContain('outside the external-model allow list are withheld');
    expect(notice).toContain('external_model_mcp.withheld');
    // The residue the pool cannot reach is named, not implied away.
    expect(notice).toContain('mcp__session__');
    expect(notice).not.toContain('unfiltered');
    expect(notice).not.toContain('no host control');
  });

  it('names only the mcp tools, sorted and deduplicated, and never a schema', () => {
    const notice = modelTargetToolEgressNotice(external, {
      toolNames: ['Bash', 'mcp__session__TodoWrite', 'mcp__dpGitlab__x', 'mcp__session__TodoWrite'],
    });
    expect(notice).toContain('2 MCP tool schemas');
    expect(notice).toContain('mcp__dpGitlab__x, mcp__session__TodoWrite');
    expect(notice).not.toContain('Bash');
    // F1.908 — the names come off the outbound body, i.e. AFTER the pool's
    // withholding, so they are what is sent, not an unfiltered set.
    expect(notice).toContain('outside the external-model allow list are withheld');
    expect(notice).not.toContain('unfiltered');
    expect(notice).not.toContain('no host control');
  });

  it('summarises the tail beyond the cap instead of printing every name', () => {
    const many = Array.from({ length: 25 }, (_, index) => `mcp__srv__t${String(index).padStart(2, '0')}`);
    const notice = modelTargetToolEgressNotice(external, { toolNames: many })!;
    expect(notice).toContain('25 MCP tool schemas');
    expect(notice).toContain('(+5 more)');
    expect(notice).not.toContain('mcp__srv__t24');
  });
});

describe('noteModelTargetToolEgress', () => {
  beforeEach(() => { _resetModelTargetNoticesForTesting(); });

  it('emits once per class+host+namespace and stays quiet afterwards', () => {
    const lines: string[] = [];
    const emit = (line: string) => { lines.push(line); };
    const input = { baseUrl: 'https://proxy.example.test/v1', model: 'anthropic/claude-sonnet-4-5', emit };

    expect(noteModelTargetToolEgress(input)).not.toBeNull();
    expect(noteModelTargetToolEgress(input)).toBeNull();
    expect(lines).toHaveLength(1);

    // A different namespace on the same host is a different fact and says so.
    expect(noteModelTargetToolEgress({ ...input, model: 'newvendor/m' })).not.toBeNull();
    expect(lines).toHaveLength(2);
  });

  it('emits nothing for the gateway or for loopback', () => {
    const lines: string[] = [];
    const emit = (line: string) => { lines.push(line); };
    expect(noteModelTargetToolEgress({ baseUrl: GATEWAY_URL, model: 'anthropic/claude-sonnet-4-5', emit })).toBeNull();
    expect(noteModelTargetToolEgress({ baseUrl: 'http://localhost:11434/v1', model: 'llama3', emit })).toBeNull();
    expect(lines).toHaveLength(0);
  });

  /**
   * The tools tier, added 2026-09-04 after W5-b measured the sink WIRED and
   * SILENT. `backend/factory.ts` calls this at BACKEND CONSTRUCTION — before any
   * turn exists, so with no tool names — and claimed the key; the adapter's own
   * `onOutboundTools` call, which is the only one that can NAME the tools, then
   * deduped away. A reader of that call site saw a working path.
   */
  it('lets a NAMED notice through after an unnamed one for the same target', () => {
    const lines: string[] = [];
    const emit = (line: string) => { lines.push(line); };
    const target = { baseUrl: 'https://proxy.example.test/v1', model: 'anthropic/claude-sonnet-4-5', emit };

    // What `factory.ts` does, first and with nothing to name.
    expect(noteModelTargetToolEgress(target)).not.toBeNull();
    // What the adapter does later, with the tools in hand.
    const named = noteModelTargetToolEgress({ ...target, toolNames: ['mcp__sources__whoami', 'Read'] });
    expect(named).not.toBeNull();
    expect(named).toContain('mcp__sources__whoami');
    expect(lines).toHaveLength(2);

    // Strictly-more-informative ONCE, not once per turn: a second named call for
    // the same target is still suppressed, which is what keeps this a disclosure
    // and not a log line.
    expect(noteModelTargetToolEgress({ ...target, toolNames: ['mcp__sources__whoami', 'Read'] })).toBeNull();
    expect(noteModelTargetToolEgress(target)).toBeNull();
    expect(lines).toHaveLength(2);
  });

  it('never throws, whatever it is handed', () => {
    expect(noteModelTargetToolEgress({
      baseUrl: 'https://proxy.example.test/v1',
      model: 'anthropic/x',
      emit: () => { throw new Error('sink exploded'); },
    })).toBeNull();
  });
});

/**
 * D1.221 — what a restricted `provider-default` actually SAYS.
 *
 * The notice builder had two heads, and the one an endpoint-less verdict would
 * have taken called it "an unparseable endpoint" — false in a way a reader
 * would act on, because there was no URL to parse.
 */
describe('D1.221 · the endpoint-less notice names what is known', () => {
  it('says the provider default rather than reporting an unparseable endpoint', () => {
    const notice = modelTargetToolEgressNotice(classifyModelTarget({ model: 'gpt-5', providerType: 'pi' }));
    expect(notice).toBeTruthy();
    expect(notice).toContain("provider's own default endpoint");
    expect(notice).not.toContain('unparseable');
  });

  it('says nothing at all for the Nessy Cloud Agent', () => {
    expect(modelTargetToolEgressNotice(
      classifyModelTarget({ model: 'nessy-cloud', providerType: 'nestor-cloud-agent' }),
    )).toBeNull();
  });
});

/**
 * F1.110 - the ENDPOINT half of the verdict, and the extraction it rests on.
 *
 * `modelTargetForModel` above pins the model half: a mid-session model pick
 * re-runs the model-sensitive tail against the verdict's own `host`. The verdict
 * keeps no URL, so the endpoint half needs the endpoint on both sides, which is
 * what `PiAgent.updateRuntimeConfig` has and nothing else does.
 */
describe('F1.110 · modelTargetBaseUrlForConnection - the factory\'s three terms, extracted', () => {
  it('prefers the connection endpoint, trimmed', () => {
    expect(modelTargetBaseUrlForConnection({ baseUrl: '  https://a.test/v1  ', providerType: 'anthropic' }))
      .toBe('https://a.test/v1');
  });

  it('substitutes the SDK default for an endpoint-less `anthropic` connection (D1.191)', () => {
    expect(modelTargetBaseUrlForConnection({ providerType: 'anthropic' })).toBe('https://api.anthropic.com');
  });

  it('substitutes Pi\'s own DEFAULT_CODEX_BASE_URL for the ChatGPT card (D1.191)', () => {
    expect(modelTargetBaseUrlForConnection({ providerType: 'pi', piAuthProvider: 'openai-codex' }))
      .toBe('https://chatgpt.com/backend-api');
  });

  it('names nothing for every OTHER endpoint-less connection - deliberately not a vocabulary', () => {
    expect(modelTargetBaseUrlForConnection({ providerType: 'pi', piAuthProvider: 'github-copilot' })).toBeUndefined();
    expect(modelTargetBaseUrlForConnection({})).toBeUndefined();
  });
});

describe('F1.110 · modelTargetForEndpoint', () => {
  const AT_PROXY = { baseUrl: BYO_URL, providerType: 'pi_compat' };
  const AT_VENDOR = { baseUrl: 'https://api.openai.com/v1', providerType: 'pi_compat' };

  it('re-classifies from the NEW endpoint, and equals a fresh classification of it', () => {
    const before = classifyModelTarget({ baseUrl: BYO_URL, model: 'gpt-4o', providerType: 'pi_compat' });
    const after = modelTargetForEndpoint(before, AT_PROXY, AT_VENDOR, 'gpt-4o');
    // The equivalence is the whole design: one derivation, not two.
    expect(after).toEqual(classifyModelTarget({ baseUrl: AT_VENDOR.baseUrl, model: 'gpt-4o', providerType: 'pi_compat' }));
    expect(after!.class).toBe('external-vendor');
  });

  it('returns the SAME OBJECT when the derived endpoint did not move', () => {
    const before = classifyModelTarget({ baseUrl: BYO_URL, model: 'tgpt/x', providerType: 'pi_compat' });
    // A trailing slash is the same endpoint; `normalizeUpstreamBaseUrl` decides.
    expect(modelTargetForEndpoint(before, AT_PROXY, { ...AT_PROXY, baseUrl: `${BYO_URL}/` }, 'tgpt/x')).toBe(before);
    expect(modelTargetForEndpoint(before, AT_PROXY, AT_PROXY, 'gpt-4o')).toBe(before);
  });

  it('never MINTS a verdict: undefined in, undefined out', () => {
    expect(modelTargetForEndpoint(undefined, AT_PROXY, AT_VENDOR, 'gpt-4o')).toBeUndefined();
  });

  it('follows the GATEWAY whole-URL rule, which a host comparison could not', () => {
    const before = classifyModelTarget({ baseUrl: GATEWAY_URL, model: 'gpt-4o', providerType: 'pi_compat' });
    expect(before.class).toBe('nessy-gateway');
    const after = modelTargetForEndpoint(
      before,
      { baseUrl: GATEWAY_URL, providerType: 'pi_compat' },
      { baseUrl: `${GATEWAY_URL}/not-the-gateway`, providerType: 'pi_compat' },
      'gpt-4o',
    );
    // Same host, different class - the reason the guard compares the derived URL.
    expect(after!.host).toBe(before.host);
    expect(after!.class).toBe('unclassified');
    expect(after!.restricted).toBe(true);
  });

  it('keeps the providerType carve-out when an endpoint is REMOVED', () => {
    const before = classifyModelTarget({ baseUrl: BYO_URL, model: 'x', providerType: 'nestor-cloud-agent' });
    const after = modelTargetForEndpoint(before, AT_PROXY, { providerType: 'nestor-cloud-agent' }, 'x');
    expect(after!.class).toBe('provider-default');
    expect(after!.restricted).toBe(false);
  });
});

/**
 * F1.908 (origin SIT-aa F7) - a mid-session move printed the disclosure TWICE,
 * in the same millisecond, on a packaged build.
 *
 * `noteModelTargetVerdictEgress` wrote the operator line AND called the host
 * port, because when F1.111 landed the port was bound to `sessionLog`, which a
 * packaged build drops. F1.177 then re-bound the port to
 * `createLogger('model-target')` - the very scope `modelTargetOperatorLog` is -
 * so one decision reached the same stream twice. The arms below stand in for
 * that host by writing the port and the operator log into ONE array.
 */
describe('F1.908 · noteModelTargetVerdictEgress prints one decision once', () => {
  const external = classifyModelTarget({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', providerType: 'pi_compat' });
  const originalWarn = modelTargetOperatorLog.warn;
  let stream: string[];

  beforeEach(() => {
    _resetModelTargetNoticesForTesting();
    stream = [];
    modelTargetOperatorLog.warn = (message: string) => { stream.push(message); };
  });
  afterEach(() => { modelTargetOperatorLog.warn = originalWarn; });

  it('a host port on the operator channel gets the line once, not twice', () => {
    const notice = noteModelTargetVerdictEgress({
      verdict: external,
      model: 'gpt-4o',
      emit: (line: string) => { stream.push(line); },
    });
    expect(notice).not.toBeNull();
    expect(stream).toEqual([notice!]);
  });

  it('BOUNDARY: with no host port the operator log still carries it, exactly once', () => {
    // The fallback is what the packaged-build child arm in
    // `model-target-mid-session-disclosure.test.ts` reads on stderr.
    const notice = noteModelTargetVerdictEgress({ verdict: external, model: 'gpt-4o' });
    expect(notice).not.toBeNull();
    expect(stream).toEqual([notice!]);
    // Same key again: the per-process dedupe still holds.
    expect(noteModelTargetVerdictEgress({ verdict: external, model: 'gpt-4o' })).toBeNull();
    expect(stream).toHaveLength(1);
  });

  it('CONTROL: an unrestricted target prints nothing on either sink', () => {
    const gateway = classifyModelTarget({ baseUrl: GATEWAY_URL, model: 'tgpt/deepseek-v4-flash-0731' });
    expect(noteModelTargetVerdictEgress({
      verdict: gateway,
      model: 'tgpt/deepseek-v4-flash-0731',
      emit: (line: string) => { stream.push(line); },
    })).toBeNull();
    expect(stream).toEqual([]);
  });
});
