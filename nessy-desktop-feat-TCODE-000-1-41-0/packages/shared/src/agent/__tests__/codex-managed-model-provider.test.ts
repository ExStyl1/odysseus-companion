/**
 * F1.589 (origin WJ-lift proposed row 4, 2026-09-24) — a MANAGED codex
 * `model_provider` / `model_providers` requirement re-points a session this host
 * configured, and before this row nothing said so.
 *
 * ## Measured on the shipped `codex-app-server` 0.156.1 (2026-09-24, WJ-bt)
 *
 * The requirement reached the binary through its OWN macOS MDM reader
 * (`config/src/loader/macos.rs` at `rust-v0.156.1`, which since that tag reads
 * ONLY a preference `CFPreferencesAppValueIsForced` calls forced — WJ-ag's
 * 0.154.0 stand-in answered `CopyAppValue` alone and is not consulted any more,
 * so the rig answers both), inside the child only. The config was the product's
 * own `buildCodexConfigToml` (`[model_providers.nessy_gateway]` → OUR loopback
 * adapter), and a SECOND loopback adapter stood in for the administrator's
 * endpoint; each counted the model calls it received. Four arms, control first:
 *
 * | arm | `configRequirements/read` | `thread/start`'s `modelProvider` | calls ours / managed | codex warning |
 * | --- | --- | --- | --- | --- |
 * | no requirement (control) | `requirements: null` | `nessy_gateway` | 1 / 0 | none |
 * | `model_provider = "nessy_gateway"` | `modelProvider: "nessy_gateway"` | `nessy_gateway` | 1 / 0 | none |
 * | `model_provider = "wjbt_managed"` + its table | both fields | `wjbt_managed` | **0 / 1** | {@link MEASURED_SELECTION_WARNING} |
 * | `[model_providers.nessy_gateway]` (OUR key) | `modelProviders.nessy_gateway` | `nessy_gateway` | **0 / 1** | **none** |
 *
 * The last arm is the one the row is about: codex `extend`s a managed
 * definition over ours (`core/src/config/requirements.rs` `apply_to_config`),
 * so a table under OUR key sends the whole session elsewhere while `thread/start`
 * still reports the key we wrote and no warning is raised — invisible from every
 * signal but the requirements document itself. The selection arm is audible
 * (codex's own `configWarning`) but only once the thread exists, after which the
 * first prompt is already on its way.
 *
 * So the host now reads both fields off the same `configRequirements/read` it
 * already takes, and REFUSES to open the thread when either one re-points the
 * provider it configured — before anything is sent, naming the requirement.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAgent } from '../codex-agent.ts';
import {
  codexManagedModelProviderRedirect,
  codexOpenedModelProviderRefusal,
  codexReforkedModelProviderRefusal,
  formatCodexManagedModelProviderRefusal,
} from '../codex-config-requirements.ts';
import { recordAndPersistCodexManagedApprovalsReviewers } from '../../config/codex-managed-requirement-cache.ts';

// The recording channel this file drives also remembers the F1.514 reviewer list; clear it (that file's rule).
afterEach(() => { recordAndPersistCodexManagedApprovalsReviewers(undefined); });

/** codex's own start-up warning in the selection arm, verbatim. */
const MEASURED_SELECTION_WARNING = 'Configured value for `model_provider` is overridden by the required value '
  + '"wjbt_managed" from MDM com.openai.codex:requirements_toml_base64.';

const MANAGED_TABLE = (baseUrl: string) => ({
  name: 'Managed by MDM', base_url: baseUrl, model_catalog_url: null, env_key: 'COMPANY_LLM_API_KEY',
  env_key_instructions: null, experimental_bearer_token: null, auth: null, gateway_oauth: null, aws: null,
  wire_api: 'responses', query_params: null, http_headers: null, env_http_headers: null,
  request_max_retries: null, stream_max_retries: null, stream_idle_timeout_ms: null,
  websocket_connect_timeout_ms: null, requires_openai_auth: false, supports_websockets: false,
  supports_standalone_web_search: false,
});

/** The four `configRequirements/read` results the shipped binary answered, provider fields verbatim. */
const MEASURED = {
  none: { requirements: null },
  selectSame: { requirements: { modelProvider: 'nessy_gateway', modelProviders: null, featureRequirements: null } },
  selectOther: {
    requirements: {
      modelProvider: 'wjbt_managed',
      modelProviders: { wjbt_managed: MANAGED_TABLE('http://127.0.0.1:58450/v1') },
      featureRequirements: null,
    },
  },
  replaceKey: {
    requirements: {
      modelProvider: null,
      modelProviders: { nessy_gateway: MANAGED_TABLE('http://127.0.0.1:58462/v1') },
      featureRequirements: null,
    },
  },
} as const;

const LOOPBACK = { provider: 'nessy_gateway', hostDefined: true } as const;

describe('F1.589 codexManagedModelProviderRedirect — what the requirement does to the provider we configured', () => {
  it('a managed SELECTION of another provider re-points the session (measured: 0 calls ours, 1 managed)', () => {
    expect(codexManagedModelProviderRedirect(MEASURED.selectOther, LOOPBACK)).toEqual({
      kind: 'selection',
      configured: 'nessy_gateway',
      required: 'wjbt_managed',
      destination: 'http://127.0.0.1:58450',
    });
  });

  it('a managed DEFINITION under our own key re-points it too, silently (measured: no warning, 0 / 1)', () => {
    expect(codexManagedModelProviderRedirect(MEASURED.replaceKey, LOOPBACK)).toEqual({
      kind: 'definition',
      configured: 'nessy_gateway',
      required: 'nessy_gateway',
      destination: 'http://127.0.0.1:58462',
    });
  });

  it('CONTROL — no requirement, and a requirement naming the provider we configured, change nothing', () => {
    expect(codexManagedModelProviderRedirect(MEASURED.none, LOOPBACK)).toBeUndefined();
    expect(codexManagedModelProviderRedirect(MEASURED.selectSame, LOOPBACK)).toBeUndefined();
  });

  it('a declared codex provider: its selection is still guarded, but a table under the loopback key is not ours to lose', () => {
    const bedrock = { provider: 'amazon-bedrock', hostDefined: false } as const;
    expect(codexManagedModelProviderRedirect(MEASURED.replaceKey, bedrock)).toBeUndefined();
    expect(codexManagedModelProviderRedirect(MEASURED.selectOther, bedrock)).toMatchObject({
      kind: 'selection', configured: 'amazon-bedrock', required: 'wjbt_managed',
    });
  });

  it('is total — a document of any shape reads as no redirect rather than a throw on the spawn path', () => {
    for (const result of [undefined, null, 'x', [], {}, { requirements: [] }, { requirements: { modelProvider: 7 } },
      { requirements: { modelProvider: '  ' } }, { requirements: { modelProviders: ['nessy_gateway'] } }]) {
      expect(codexManagedModelProviderRedirect(result, LOOPBACK)).toBeUndefined();
    }
    // A selection of a provider the document does not define (a built-in) has no destination to name.
    expect(codexManagedModelProviderRedirect({ requirements: { modelProvider: 'openai' } }, LOOPBACK)).toEqual({
      kind: 'selection', configured: 'nessy_gateway', required: 'openai',
    });
  });
});

describe('F1.589 formatCodexManagedModelProviderRefusal — the sentence the user meets', () => {
  it('names the requirement, where the requests would go, and that nothing was sent', () => {
    const selection = formatCodexManagedModelProviderRefusal(
      codexManagedModelProviderRedirect(MEASURED.selectOther, LOOPBACK)!,
    );
    expect(selection).toContain('model_provider = "wjbt_managed"');
    expect(selection).toContain('http://127.0.0.1:58450');
    expect(selection).toContain('nothing was sent');

    const definition = formatCodexManagedModelProviderRefusal(
      codexManagedModelProviderRedirect(MEASURED.replaceKey, LOOPBACK)!,
    );
    expect(definition).toContain('model_providers.nessy_gateway');
    expect(definition).toContain('http://127.0.0.1:58462');
    expect(definition).toContain('nothing was sent');
  });
});

function createConfig(): any {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-managed-provider',
      name: 'Codex Managed Provider Workspace',
      rootPath: '/tmp/ws-codex-managed-provider',
      workspaceRootPath: '/tmp/ws-codex-managed-provider',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-managed-provider',
    } as any,
    session: {
      id: 'session-codex-managed-provider',
      workspaceRootPath: '/tmp/ws-codex-managed-provider',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** Drive the requirements channel the probe uses, then the refusal the start-up calls. */
async function readThenRefuse(result: unknown | Error): Promise<Error | undefined> {
  const agent = new CodexAgent(createConfig());
  const channel = (agent as any).recordManagedApprovalsReviewers({
    request: async () => { if (result instanceof Error) throw result; return result; },
  });
  await channel.request('configRequirements/read', undefined, { timeoutMs: 1_000 }).catch(() => undefined);
  try {
    (agent as any).refuseManagedModelProviderRedirect();
    return undefined;
  } catch (error) {
    return error as Error;
  } finally {
    await agent.destroy?.();
  }
}

describe('F1.589 the codex start-up refuses a re-pointed provider before any thread opens', () => {
  it('refuses on the measured selection and definition arms, in the sentence above', async () => {
    const selection = await readThenRefuse(MEASURED.selectOther);
    expect(selection?.message).toBe(formatCodexManagedModelProviderRefusal(
      codexManagedModelProviderRedirect(MEASURED.selectOther, LOOPBACK)!,
    ));
    const definition = await readThenRefuse(MEASURED.replaceKey);
    expect(definition?.message).toBe(formatCodexManagedModelProviderRefusal(
      codexManagedModelProviderRedirect(MEASURED.replaceKey, LOOPBACK)!,
    ));
  });

  it('CONTROL — no requirement, the same provider, and an unanswered read all start the session', async () => {
    expect(await readThenRefuse(MEASURED.none)).toBeUndefined();
    expect(await readThenRefuse(MEASURED.selectSame)).toBeUndefined();
    expect(await readThenRefuse(new Error('timed out'))).toBeUndefined();
  });

  it('the refusal sits between the requirements probe and the thread/start request', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'codex-agent.ts'), 'utf8');
    const probe = source.indexOf('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client)');
    const call = source.indexOf('this.refuseManagedModelProviderRedirect();');
    const open = source.indexOf("client.request('thread/start', openThreadParams)");
    expect(probe).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(probe);
    expect(call).toBeLessThan(open);
    expect(source.split('this.refuseManagedModelProviderRedirect();').length - 1).toBe(1);
  });
});

/**
 * F1.634 (origin WJ-bt P-WJbt-1) — F1.589's check reads `configRequirements/read`, so a read that did not answer
 * (the 5 s deadline, a refusal) left the session unverified. The second reading is codex's own: every thread open
 * answers `modelProvider` (a required field of `ThreadStartResponse`, `ThreadResumeResponse` and
 * `ThreadForkResponse`), and in the measured selection arm above it said `wjbt_managed`. It is compared on EVERY
 * start-up open, answered read or not: at `rust-v0.156.1` a legacy managed configuration
 * (`/etc/codex/managed_config.toml` or its MDM twin, `config/src/loader/mod.rs`) sits above every layer this host
 * writes and never reaches the requirements document except for its approval and sandbox keys. The same-key table
 * arm reports OUR key, so it stays invisible without the read — the residue these controls pin.
 */
describe('F1.634 codexOpenedModelProviderRefusal — the provider codex says it opened the thread on', () => {
  const timedOut = { status: 'failed', detail: 'configRequirements/read timed out after 5000ms' } as const;

  it('refuses a thread codex opened on another provider (the measured selection arm), naming both keys', () => {
    const unanswered = codexOpenedModelProviderRefusal(
      { thread: { id: 'thr_1' }, modelProvider: 'wjbt_managed' }, 'nessy_gateway', timedOut,
    );
    expect(unanswered).toContain('"wjbt_managed"');
    expect(unanswered).toContain('("nessy_gateway")');
    expect(unanswered).toContain('timed out after 5000ms');
    expect(unanswered).toContain('Your first message was not sent');
    // The thread exists by now, so the sentence must not borrow F1.589's "nothing was sent".
    expect(unanswered).not.toContain('nothing was sent');
    expect(codexOpenedModelProviderRefusal({ modelProvider: 'wjbt_managed' }, 'nessy_gateway', { status: 'unsupported' }))
      .toContain('was refused by this codex');
    // An answered read that selected nothing: the choice came from a layer the requirements document does not carry.
    expect(codexOpenedModelProviderRefusal({ modelProvider: 'openai' }, 'nessy_gateway', { status: 'none' }))
      .toContain('does not select another model provider');
  });

  it('CONTROL — our own key (the control arm and the same-key table arm alike) or no field at all start the session', () => {
    for (const requirements of [timedOut, { status: 'none' }, { status: 'read' }] as const) {
      expect(codexOpenedModelProviderRefusal({ modelProvider: 'nessy_gateway' }, 'nessy_gateway', requirements)).toBeUndefined();
    }
    expect(codexOpenedModelProviderRefusal({ modelProvider: 'amazon-bedrock' }, 'amazon-bedrock', timedOut)).toBeUndefined();
    for (const opened of [undefined, null, {}, { modelProvider: 7 }, { modelProvider: '  ' }, 'nessy_gateway']) {
      expect(codexOpenedModelProviderRefusal(opened, 'nessy_gateway', timedOut)).toBeUndefined();
    }
  });

  it('runs once, on the key this host wrote, after the thread opens and before the host adopts it', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'codex-agent.ts'), 'utf8');
    const call = 'codexOpenedModelProviderRefusal(threadResult, declaredModelProvider ?? CODEX_PROVIDER_KEY, requirements)';
    const at = source.indexOf(call);
    expect(at).toBeGreaterThan(0);
    expect(source.split('codexOpenedModelProviderRefusal(').length - 1).toBe(1);
    expect(at).toBeGreaterThan(source.indexOf("threadResult = (await client.request('thread/start', openThreadParams))"));
    expect(at).toBeLessThan(source.indexOf('this.config.onSdkSessionIdUpdate?.(threadId);'));
    expect(at).toBeLessThan(source.indexOf('      this.client = client;\n'));
  });
});

/**
 * F1.1030 (origin DN-224) — F1.634 compared the provider only on the START-UP open. The turn-head re-fork
 * (F1.928's rules drift, a sandbox or plugin drift, an effort change) opens a NEW thread through `thread/fork` — or,
 * for a thread with no rollout yet, `thread/start` — and codex loads a fresh config layer for it, so a managed
 * configuration that appears or changes between turns re-points the forked thread while the start-up check has long
 * passed. Both responses carry the same required `modelProvider`, so the walk now makes F1.634's comparison before
 * the host adopts the forked thread, and a difference fails the turn: the old thread, the recorded signature and the
 * host's anchor stay as they were, so the next turn re-forks and is checked again.
 */
describe('F1.1030 the turn-head re-fork is refused when codex re-opens the thread on another provider', () => {
  function reforkHarness(answer: { fork?: unknown; forkRefusesNoRollout?: boolean; start?: unknown }) {
    const adopted: string[] = [];
    const methods: string[] = [];
    const agent = new CodexAgent({ ...createConfig(), onSdkSessionIdUpdate: (id: string) => { adopted.push(id); } });
    (agent as any).client = {
      request: async (method: string, params: any) => {
        methods.push(method);
        if (method === 'thread/fork') {
          if (answer.forkRefusesNoRollout) throw new Error(`no rollout found for thread id ${params.threadId}`);
          return answer.fork;
        }
        if (method === 'thread/start') return answer.start;
        return {};
      },
      notify() {},
      close() {},
    };
    (agent as any).threadId = 'thread-original';
    // The drift that makes the walk fork at all.
    (agent as any).runtimeConfigSignature = 'stale-signature';
    const refork = () => (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] }, 2_000);
    return { agent, adopted, methods, refork };
  }

  it('the sentence names both keys and the turn, not the session start-up', () => {
    const refusal = codexReforkedModelProviderRefusal({ thread: { id: 'thr_2' }, modelProvider: 'wjbt_managed' }, 'nessy_gateway');
    expect(refusal).toContain('"wjbt_managed"');
    expect(refusal).toContain('("nessy_gateway")');
    expect(refusal).toContain('this turn was not started');
    expect(refusal).toContain('Your message was not sent');
    // The session DID start on our provider (F1.634 checked it), so neither start-up sentence may be borrowed.
    expect(refusal).not.toContain('did not start this session');
    expect(refusal).not.toContain('first message');
  });

  it('refuses a fork codex put on another provider, and adopts nothing', async () => {
    const { agent, adopted, refork } = reforkHarness({ fork: { thread: { id: 'thread-forked' }, modelProvider: 'wjbt_managed' } });
    await expect(refork()).rejects.toThrow(codexReforkedModelProviderRefusal({ modelProvider: 'wjbt_managed' }, 'nessy_gateway')!);
    expect((agent as any).threadId).toBe('thread-original');
    expect((agent as any).runtimeConfigSignature).toBe('stale-signature');
    expect(adopted).toEqual([]);
    await agent.destroy?.();
  });

  it('refuses the rollout-less fallback too — its thread/start answers the same field', async () => {
    const { agent, adopted, methods, refork } = reforkHarness({
      forkRefusesNoRollout: true,
      start: { thread: { id: 'thread-fresh' }, modelProvider: 'openai' },
    });
    await expect(refork()).rejects.toThrow('"openai"');
    expect(methods).toContain('thread/start');
    expect((agent as any).threadId).toBe('thread-original');
    expect(adopted).toEqual([]);
    await agent.destroy?.();
  });

  it('CONTROL — a fork on our own key, or a response without the field, is adopted as before', async () => {
    for (const fork of [{ thread: { id: 'thread-forked' }, modelProvider: 'nessy_gateway' }, { thread: { id: 'thread-forked' } }]) {
      const { agent, adopted, refork } = reforkHarness({ fork });
      await refork();
      expect((agent as any).threadId).toBe('thread-forked');
      expect((agent as any).runtimeConfigSignature).not.toBe('stale-signature');
      expect(adopted).toEqual(['thread-forked']);
      await agent.destroy?.();
    }
    expect(codexReforkedModelProviderRefusal({ modelProvider: 'amazon-bedrock' }, 'amazon-bedrock')).toBeUndefined();
    for (const reforked of [undefined, null, {}, { modelProvider: 7 }, { modelProvider: '  ' }]) {
      expect(codexReforkedModelProviderRefusal(reforked, 'nessy_gateway')).toBeUndefined();
    }
  });
});
