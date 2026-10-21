/**
 * P3.268 — the model capability self-report retires a string match.
 *
 * `resolveClaudeThinkingOptions` decided adaptive thinking, effort eligibility
 * and the effort ceiling from `isClaudeModel(model) && !model.includes('haiku')`
 * while the SDK publishes `ModelInfo.supportsAdaptiveThinking`,
 * `supportsEffort`, `supportedEffortLevels` and `supportsFastMode` on the
 * `initialize` response every session already waits for.
 *
 * Pinned here, each failing in its own direction:
 *  - the recorder reads the four fields and keys rows by `value` AND
 *    `resolvedModel`, with the `[1m]` selector stripped;
 *  - "not told" and "told no" are different — an absent field must not read as
 *    `false`, or an older CLI would silently disable thinking everywhere;
 *  - the runtime OVERRIDES the heuristic, in both directions, and says so;
 *  - an unsupported effort level is clamped HERE rather than downgraded silently
 *    inside the Anthropic SDK;
 *  - a model the runtime never listed (every gateway/BYO id) changes nothing.
 *
 * The bundle assertion is the one a version bump can take away silently: the
 * rows are only free because `supportedModels()` reads the cached initialize
 * response rather than issuing a control request.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeAgent, resolveClaudeThinkingOptions } from '../claude-agent.ts';
import { enableDebug } from '../../utils/debug.ts';
import {
  clampClaudeEffortLevel,
  lookupClaudeModelCapabilities,
  recordClaudeModelCapabilities,
  resetClaudeModelCapabilities,
} from '../claude-model-capabilities.ts';

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

afterEach(() => {
  resetClaudeModelCapabilities();
});

describe('P3.268 — recording what the runtime says about its models', () => {
  it('reads the four capability fields and keys the row by value and resolvedModel', () => {
    const informative = recordClaudeModelCapabilities([
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
      },
    ]);
    expect(informative).toBe(1);
    const byAlias = lookupClaudeModelCapabilities('sonnet');
    const byWireId = lookupClaudeModelCapabilities('claude-sonnet-5');
    expect(byAlias).toEqual({
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
    });
    // The documented reason both keys exist: "Lets hosts match a persisted
    // explicit id against the alias row that covers it."
    expect(byWireId).toEqual(byAlias!);
  });

  it('strips the `[1m]` selector, which is not a different model', () => {
    recordClaudeModelCapabilities([
      { value: 'claude-opus-4-6', displayName: '', description: '', supportsAdaptiveThinking: true },
    ]);
    // `claude-agent.ts` appends the suffix to opt into the 1M beta, so the string
    // that reaches `options.model` is not the string the runtime listed.
    expect(lookupClaudeModelCapabilities('claude-opus-4-6[1m]')?.supportsAdaptiveThinking).toBe(true);
  });

  it('BOUNDARY — a row with none of the four fields is recorded as nothing, not as false', () => {
    // An older CLI publishes models without the capability fields. Storing an
    // all-`false` row would disable adaptive thinking for every model it lists.
    const informative = recordClaudeModelCapabilities([
      { value: 'legacy-model', displayName: '', description: '' },
    ]);
    expect(informative).toBe(0);
    expect(lookupClaudeModelCapabilities('legacy-model')).toBeUndefined();
  });

  it('BOUNDARY — an empty supportedEffortLevels is "unusable", not "no levels"', () => {
    recordClaudeModelCapabilities([
      { value: 'odd-model', displayName: '', description: '', supportsEffort: true, supportedEffortLevels: [] },
    ]);
    // Treating `[]` as a ceiling would refuse every effort level on that model.
    expect(lookupClaudeModelCapabilities('odd-model')?.supportedEffortLevels).toBeUndefined();
  });

  it('an alias never overwrites an explicit row for the same wire id', () => {
    recordClaudeModelCapabilities([
      { value: 'claude-sonnet-5', displayName: '', description: '', supportsAdaptiveThinking: true },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: '', description: '', supportsAdaptiveThinking: false },
    ]);
    expect(lookupClaudeModelCapabilities('claude-sonnet-5')?.supportsAdaptiveThinking).toBe(true);
    expect(lookupClaudeModelCapabilities('sonnet')?.supportsAdaptiveThinking).toBe(false);
  });
});

describe('P3.268 — clamping an effort level the model does not accept', () => {
  it('leaves the request alone when the runtime published nothing', () => {
    expect(clampClaudeEffortLevel('xhigh', undefined, EFFORT_ORDER)).toBe('xhigh');
    expect(clampClaudeEffortLevel('xhigh', { supportsAdaptiveThinking: true }, EFFORT_ORDER)).toBe('xhigh');
  });

  it('drops the effort entirely when the model says it takes none', () => {
    expect(clampClaudeEffortLevel('high', { supportsEffort: false }, EFFORT_ORDER)).toBeNull();
  });

  it('clamps DOWN to the highest supported level at or below the request', () => {
    // `thinking-levels.ts`: "On models that don't accept `xhigh`, the Anthropic
    // SDK silently falls back to `high`." Deciding it here is what makes the
    // degradation visible.
    const row = { supportedEffortLevels: ['low', 'medium', 'high'] };
    expect(clampClaudeEffortLevel('max', row, EFFORT_ORDER)).toBe('high');
    expect(clampClaudeEffortLevel('xhigh', row, EFFORT_ORDER)).toBe('high');
    expect(clampClaudeEffortLevel('medium', row, EFFORT_ORDER)).toBe('medium');
  });

  it('BOUNDARY — a model supporting only HIGHER levels gets its lowest, not an unsupported one', () => {
    expect(clampClaudeEffortLevel('low', { supportedEffortLevels: ['high', 'max'] }, EFFORT_ORDER)).toBe('high');
  });
});

describe('P3.268 — the self-report reaches the thinking options', () => {
  it('overrides the id heuristic in BOTH directions, and reports which authority answered', () => {
    const said: string[] = [];
    // Heuristic would say a haiku model has no adaptive thinking. The runtime
    // says it does.
    const enabled = resolveClaudeThinkingOptions({
      thinkingLevel: 'high',
      model: 'claude-haiku-4-5',
      minimizeThinking: false,
      capabilities: { supportsAdaptiveThinking: true },
      onDiagnostic: message => said.push(message),
    });
    expect(enabled).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' });
    expect(said.join('\n')).toContain('the runtime wins');

    // And the other way: a non-haiku claude model the runtime says cannot take
    // adaptive thinking falls to the token budget.
    const budgeted = resolveClaudeThinkingOptions({
      thinkingLevel: 'high',
      model: 'claude-opus-4-6',
      minimizeThinking: false,
      capabilities: { supportsAdaptiveThinking: false },
    });
    expect('maxThinkingTokens' in budgeted).toBe(true);
    expect('thinking' in budgeted).toBe(false);
  });

  it('clamps the effort the options carry, and says so', () => {
    const said: string[] = [];
    const options = resolveClaudeThinkingOptions({
      thinkingLevel: 'max',
      model: 'claude-sonnet-5',
      minimizeThinking: false,
      capabilities: { supportsAdaptiveThinking: true, supportedEffortLevels: ['low', 'medium', 'high'] },
      onDiagnostic: message => said.push(message),
    });
    expect(options).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' });
    expect(said.join('\n')).toContain('requested max → high');
  });

  it('an unlisted model — every gateway and BYO id — changes nothing', () => {
    // The gateway's own default coder model is not in the CLI's catalogue, so a
    // lookup misses and the string match keeps deciding. This is the fork's
    // DEFAULT path, so a regression here is a regression for most sessions.
    const before = resolveClaudeThinkingOptions({
      thinkingLevel: 'high',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      minimizeThinking: false,
    });
    recordClaudeModelCapabilities([
      { value: 'claude-sonnet-5', displayName: '', description: '', supportsAdaptiveThinking: true },
    ]);
    const after = resolveClaudeThinkingOptions({
      thinkingLevel: 'high',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      minimizeThinking: false,
    });
    expect(after).toEqual(before);
  });

  it('the process-scoped record is consulted with no explicit injection', () => {
    // The production path passes no `capabilities` — it reads the module record
    // that `captureModelCapabilities` fills. If that lookup were dropped, every
    // assertion above would still pass through the injected argument.
    const heuristic = resolveClaudeThinkingOptions({
      thinkingLevel: 'high', model: 'claude-haiku-4-5', minimizeThinking: false,
    });
    expect('maxThinkingTokens' in heuristic).toBe(true);
    recordClaudeModelCapabilities([
      { value: 'claude-haiku-4-5', displayName: '', description: '', supportsAdaptiveThinking: true },
    ]);
    expect(resolveClaudeThinkingOptions({
      thinkingLevel: 'high', model: 'claude-haiku-4-5', minimizeThinking: false,
    })).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' });
  });
});

describe('P3.268 — the native mechanism, measured on the shipped bundle', () => {
  it('supportedModels() reads the cached initialize response, so the rows are free', () => {
    const bundle = readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk'), 'utf8');
    const typings = readFileSync(
      require.resolve('@anthropic-ai/claude-agent-sdk').replace(/sdk\.mjs$/, 'sdk.d.ts'),
      'utf8',
    );
    // The reason `captureModelCapabilities` is fire-and-forget rather than a
    // control round trip on every spawn. If a bump makes this a request, the
    // spawn path should be revisited.
    expect(bundle).toContain('async supportedModels(){return(await this.initialization).models}');

    // WHICH SIDE IS THE DENOMINATOR HERE, measured rather than assumed.
    // AGENTS.md's rule is that the vendored bundle is the denominator for what
    // the runtime can already do — but the four capability fields appear
    // **0 times** in `sdk.mjs` and once each in `sdk.d.ts` at 0.3.233: they are
    // minted by the CLI binary and pass through the SDK as opaque JSON. So a
    // guard derived from the bundle would read as absent, and the typings are
    // the contract for this surface.
    for (const field of ['supportsEffort', 'supportedEffortLevels', 'supportsAdaptiveThinking', 'supportsFastMode']) {
      expect(bundle.includes(field)).toBe(false);
      expect(typings).toContain(field);
    }
    // POSITIVE CONTROL for that absence claim: a field of the SAME message that
    // the bundle DOES carry, so a zero above is a real zero and not a bad read.
    expect(bundle).toContain('displayName');
  });

  it('is wired into the spawn path', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toContain('void this.captureModelCapabilities(live);');
    expect(source).toContain('recordClaudeModelCapabilities(models)');
  });
});

/**
 * F1.822 (origin WJ-crit-ii P-WJcritii-3) — the P3.268 lines reach the one sink a packaged build keeps.
 *
 * `ClaudeAgent`'s `this.debug` is the `onDebug` callback, which the desktop host points at `sessionLog` — electron-log,
 * whose transports `apps/electron/src/main/logger.ts` sets to `level = false` outside debug mode, which a packaged
 * build always is. Release sitting SIT-p found `model capability self-report: …` and the `… the runtime wins` line
 * 0 times in its launch log while the module `debug()` lines beside them were there (stderr under `NESSY_DEBUG=1`), so
 * the sitting could not see the capability record land. Both now go through the module `debug()`.
 *
 * `captureModelCapabilities` is driven through the real method with a `Query` double and a `this` whose `debug` is a
 * spy: before the fix the spy got the line and stderr did not. `debug()` writes through `process.stderr.write`
 * directly (`utils/debug.ts` `output`), so the stub sees it; `enableDebug()` stands in for `NESSY_DEBUG=1`.
 */
describe('F1.822 — the capability self-report lines reach the module debug() sink', () => {
  type Capture = (this: unknown, live: unknown) => Promise<void>;
  const capture = (ClaudeAgent.prototype as unknown as { captureModelCapabilities: Capture }).captureModelCapabilities;

  async function run(live: unknown): Promise<{ stderr: string[]; onDebug: string[] }> {
    enableDebug();
    const stderr: string[] = [];
    const onDebug: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      await capture.call({ debug: (message: string) => onDebug.push(message) }, live);
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }
    return { stderr, onDebug };
  }

  it('the self-report line goes to debug(), not to the dropped onDebug channel', async () => {
    const { stderr, onDebug } = await run({
      supportedModels: async () => [
        { value: 'claude-sonnet-5', displayName: '', description: '', supportsAdaptiveThinking: true },
      ],
    });
    expect(stderr.filter(line => line.includes('model capability self-report: 1 model(s), 1 carrying'))).toHaveLength(1);
    expect(onDebug.filter(line => line.includes('model capability self-report'))).toEqual([]);
  });

  it('BOUNDARY — the failure line (a child that died before initialize) takes the same sink', async () => {
    const { stderr, onDebug } = await run({
      supportedModels: async () => { throw new Error('F1.822 child gone'); },
    });
    expect(stderr.filter(line => line.includes('model capability self-report unavailable (F1.822 child gone)'))).toHaveLength(1);
    expect(onDebug).toEqual([]);
  });

  it('the thinking resolver\'s authority line ("… the runtime wins") is bound to debug() on the spawn path', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // Booleans, not `toContain`: a failing `toContain` prints the whole 14k-line source.
    expect(source.includes('onDiagnostic: message => debug(message),')).toBe(true);
    expect(source.includes('onDiagnostic: message => this.debug(message),')).toBe(false);
  });
});

/**
 * F1.1106 (origin DN-065; P3.268) — the `context window (spawn/setModel)` lines of `refreshSdkContextWindow` take the
 * same sink F1.822 gave the capability lines: the module `debug()`, which a packaged build keeps under `NESSY_DEBUG=1`,
 * and not `this.debug` (`onDebug`, electron-log, dropped outside debug mode). Driven through the real method with a
 * `Query` double and a `this` carrying a spy `debug` and the one adapter call the method makes.
 */
describe('F1.1106 — the context-window diagnostic lines reach the module debug() sink', () => {
  type Refresh = (this: unknown, live: unknown, occasion: string) => Promise<void>;
  const refresh = (ClaudeAgent.prototype as unknown as { refreshSdkContextWindow: Refresh }).refreshSdkContextWindow;

  async function run(live: unknown, applied: boolean): Promise<{ stderr: string[]; onDebug: string[] }> {
    enableDebug();
    const stderr: string[] = [];
    const onDebug: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      await refresh.call({
        debug: (message: string) => onDebug.push(message),
        eventAdapter: { applySdkContextUsage: () => applied },
      }, live, 'spawn');
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }
    return { stderr, onDebug };
  }

  it('the resolved-window line goes to debug(), not to the dropped onDebug channel', async () => {
    const { stderr, onDebug } = await run({
      getContextUsage: async () => ({ rawMaxTokens: 1_000_000, model: 'claude-opus-4-8' }),
    }, true);
    expect(stderr.filter(line => line.includes('context window (spawn): 1000000 for claude-opus-4-8'))).toHaveLength(1);
    expect(onDebug).toEqual([]);
  });

  it('BOUNDARY — the unavailable line (a child whose control request failed) takes the same sink', async () => {
    const { stderr, onDebug } = await run({
      getContextUsage: async () => { throw new Error('F1.1106 child gone'); },
    }, false);
    expect(stderr.filter(line => line.includes('context window (spawn) unavailable (F1.1106 child gone)'))).toHaveLength(1);
    expect(onDebug).toEqual([]);
  });
});
