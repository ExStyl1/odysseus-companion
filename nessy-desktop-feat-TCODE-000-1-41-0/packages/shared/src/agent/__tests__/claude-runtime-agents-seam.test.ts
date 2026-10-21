/**
 * Q8-D3 — the `agents` option must arrive at `query()`, not merely be BUILT.
 *
 * `claude-runtime-agents.test.ts` asserts what the builder produces. That is
 * what the Q7 fix already had, and the live gate
 * (`.superpowers/sdd/q8-regate-report.md`, Q8-D3) then measured the Claude
 * runtime answering, on a packaged build proven to contain the fix:
 *
 *   Agent type 'q8-control' not found. Available agents: claude,
 *   claude-code-guide, Explore, general-purpose, Plan, statusline-setup
 *
 * character-identical to the run before it. The cause was `ClaudeAgent`'s
 * constructor: it rebuilds a `BackendConfig` from a hand-written field list
 * instead of passing the caller's object through the way `PiAgent` and
 * `CodexAgent` do, so `piRuntimeAgentDefinitions` was dropped before
 * `chatImpl` could read it, and `buildClaudeRuntimeAgentOptions` was handed
 * `undefined` on every turn.
 *
 * So this file asserts at the SEAM: it fakes the SDK's `query` and inspects
 * the options object a real `chatImpl` turn hands it. It fails if the
 * definitions stop surviving the constructor, if the spread is removed from
 * the options literal, or if `optionsWithAbort` stops carrying it — none of
 * which the builder's own tests can see.
 *
 * That the SDK then HONOURS the option was measured separately, offline,
 * against the pinned `@anthropic-ai/claude-agent-sdk@0.3.218` and its native
 * binary: a programmatic agent appears in the CLI's own init roster. It is not
 * re-measured here — that would spawn the 255 MB binary in a unit suite.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { BackendConfig } from '../backend/types.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';
import { recordClaudeModelCapabilities, resetClaudeModelCapabilities } from '../claude-model-capabilities.ts';

// `mock.module` is process-global and bun runs every file in one process, so the
// real module is spread back in and restored in `afterAll` — the pattern
// `claude-gateway-adapter.test.ts:79` records, and the one whose absence made a
// `getMemoryEnabled` stub outlive its own suite.
const realSdk = { ...sdkPackage };

/** Every options object a turn handed `query()`, in call order. */
const capturedOptions: Record<string, unknown>[] = [];

/**
 * Every `AgentEvent` the driven turn yielded, in order.
 *
 * R12's announcement is not visible in the options object at all — it is an
 * event on the way OUT — so the seam has to watch both halves of the turn.
 */
const capturedEvents: { type: string; message?: string; level?: string }[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { options: Record<string, unknown> }) => {
    capturedOptions.push(input.options);
    return (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    })();
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
  // D1.440 — the SECOND process-global this file writes, and it had no restore.
  //
  // The self-report store is module scope, so the last `recordClaudeModelCapabilities`
  // below — `claude-sonnet-4-6` with `supportsAdaptiveThinking: false`, which is
  // this file's own degradation fixture — outlived the file and was still there
  // when `claude-thinking-config.test.ts` asked about the SAME model id. That
  // suite's `disables thinking entirely when level is off on adaptive backends`
  // then read the false branch and got `{ maxThinkingTokens: 0 }` where it
  // expects `{ thinking: { type: 'disabled' } }`. Green alone, red in company,
  // on CI and on a developer machine alike — the shape the SDK spread three
  // lines above was already written to prevent, met on a different global.
  resetClaudeModelCapabilities();
});

const { ClaudeAgent } = await import('../claude-agent.ts');

function descriptor(
  overrides: Partial<PiRuntimeAgentDefinitionDescriptor> & { key: string; name: string },
): PiRuntimeAgentDefinitionDescriptor {
  return {
    schemaVersion: 2,
    description: 'reviews code',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'You are an auditor.',
    sha256: 'deadbeef',
    provenance: `${overrides.key}@gen-1`,
    capabilityGeneration: 'gen-1',
    definitionDigest: 'digest-1',
    ...overrides,
  } as PiRuntimeAgentDefinitionDescriptor;
}

function agentConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-agents-seam',
      name: 'Seam Workspace',
      rootPath: '/tmp/ws-agents-seam',
      workspaceRootPath: '/tmp/ws-agents-seam',
      sessionRootPath: '/tmp/ws-agents-seam/sessions',
    } as never,
    session: {
      id: 'session-agents-seam',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-agents-seam',
    } as never,
    ...overrides,
  } as BackendConfig;
}

/** Drive one real turn on an already-built agent and return its options. */
async function drive(agent: object): Promise<Record<string, unknown>> {
  const chatImpl = (agent as unknown as {
    chatImpl: (message: string) => AsyncGenerator<unknown>;
  }).chatImpl.bind(agent);
  // Recorded rather than discarded since R12: the faked stream is still
  // deliberately minimal, but the turn's OWN yields are now the only place a
  // degradation announcement can be observed.
  for await (const event of chatImpl('hi')) {
    capturedEvents.push(event as { type: string; message?: string; level?: string });
  }
  expect(capturedOptions.length).toBe(1);
  return capturedOptions[0]!;
}

/**
 * The `info` events a driven turn yielded — R12's user-visible channel.
 *
 * CRU-7's session-level `claude-webfetch-preflight-disabled` notice (`9af3a92c4`,
 * `buildClaudeWebFetchPreflightSettings` in `claude-agent.ts`) is emitted on EVERY
 * turn whose config configures no `sandbox.network` domain control — which is every
 * config this file builds — so it is unrelated background for each case here, all of
 * which count or enumerate the turn's info events exactly. Filtered out in the one
 * helper rather than at eighteen call sites (P6.831). Its own coverage lives with the
 * function that produces it; a case in THIS file that ever wants to assert on it must
 * read `capturedEvents` directly.
 */
function infoEvents(): { type: string; message?: string; level?: string }[] {
  return capturedEvents.filter(
    event => event.type === 'info'
      && !(event.message ?? '').startsWith('claude-webfetch-preflight-disabled:'),
  );
}

/** Drive one real turn and return the options that reached `query()`. */
async function runTurn(config: BackendConfig): Promise<Record<string, unknown>> {
  return drive(new ClaudeAgent(config));
}

/**
 * The pinned capability view a real turn would already hold. Installed directly
 * because `chatImpl` is driven here without the `chat()` wrapper that normally
 * builds one — the subject is what `chatImpl` DOES with the view, not how the
 * view is built.
 */
function installCapabilityRuntime(agent: object, bodies: Record<string, string>): void {
  (agent as { capabilityTurnRuntime: unknown }).capabilityTurnRuntime = {
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource: { resourceId: string }) {
        return `/skills/${resource.resourceId}/SKILL.md`;
      },
      async resolveSkillDirectory(resource: { resourceId: string }) {
        return `/skills/${resource.resourceId}`;
      },
      async readText(resource: { resourceId: string }) {
        const body = bodies[resource.resourceId];
        if (body === undefined) throw new Error(`no fixture for ${resource.resourceId}`);
        return body;
      },
      resolveCredential() { throw new Error('credential-not-ready'); },
    },
    view: {
      generation: 'gen-1',
      skills: Object.keys(bodies).map(key => ({
        key,
        logicalName: key.replace('skill:native:', ''),
        description: 'a skill',
        selectedAsUnqualifiedAlias: true,
        resource: {
          source: 'managed-global',
          scope: { kind: 'global' },
          resourceId: key,
          absolutePath: `/skills/${key}/SKILL.md`,
          revision: '1',
          contentHash: createHash('sha256').update(key).digest('hex'),
        },
      })),
    },
  };
}

beforeEach(() => {
  capturedOptions.length = 0;
  capturedEvents.length = 0;
  // Each case records its own capabilities below; starting clean keeps the two
  // degradation arms from reading each other's fixture as well.
  resetClaudeModelCapabilities();
});

describe('the agents option at the query() seam', () => {
  it('carries the session definitions the config was constructed with', async () => {
    const options = await runTurn(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({ key: 'agent.auditor', name: 'auditor', tools: ['Read', 'Grep'] }),
      ],
    }));

    expect((options.agents as Record<string, unknown>).auditor).toEqual({
      description: 'reviews code',
      prompt: 'You are an auditor.',
      tools: ['Read', 'Grep'],
    });
    // P3.277 — the bundled four ride the same option, which is what makes
    // `scout`/`planner`/`worker`/`reviewer` invocable on this runtime at all.
    expect(Object.keys(options.agents as object).sort())
      .toEqual(['auditor', 'planner', 'reviewer', 'scout', 'worker']);
  });

  it('omits the key entirely when the session has no definitions', async () => {
    // Not `agents: {}` — an empty record would still be a different request
    // from no request, and a definition-less session must keep the SDK's own
    // built-in set (`general-purpose`, `Explore`, `Plan`, …).
    const options = await runTurn(agentConfig());
    expect('agents' in options).toBe(false);
  });

  /**
   * R10 — THE WIRING, which is the half a green composition suite cannot prove.
   *
   * `claude-runtime-agent-skills.test.ts` proves the composition is correct.
   * This proves `chatImpl` actually CALLS it: the first version of R10 landed a
   * fully tested composition that no production path invoked, so a Claude
   * subagent still received a bare `systemPrompt` on every real turn while 23
   * tests passed. The review caught it; this is the assertion that would have.
   */
  it('inlines a declared skill into the agent the turn actually sends', async () => {
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: ['skill:native:house-style'] }),
      ],
    }));
    installCapabilityRuntime(agent, {
      'skill:native:house-style': '---\ndescription: house style\n---\nAlways use tabs.',
    });

    const options = await drive(agent);
    const auditor = (options.agents as Record<string, { prompt: string }>).auditor!;

    expect(auditor.prompt).toContain('<invoked-skill');
    expect(auditor.prompt).toContain('Always use tabs.');
    // The agent's own prompt is still first — the skill blocks are appended.
    expect(auditor.prompt.startsWith('You are an auditor.')).toBe(true);
  });

  it('THE CONTROL — the same turn carries no skill block when none is declared', async () => {
    // Without this, the test above cannot distinguish "the wiring works" from
    // "the assertion is vacuous": both fail the same way on a broken rig.
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [descriptor({ key: 'agent.auditor', name: 'auditor' })],
    }));
    installCapabilityRuntime(agent, {
      'skill:native:house-style': '---\ndescription: house style\n---\nAlways use tabs.',
    });

    const options = await drive(agent);
    const auditor = (options.agents as Record<string, { prompt: string }>).auditor!;

    expect(auditor.prompt).toBe('You are an auditor.');
    expect(auditor.prompt).not.toContain('<invoked-skill');
  });
});

/**
 * R12 — the two fields that were dropped with no reason recorded anywhere, and
 * which are NOT one verdict. They were found together; that is all they share.
 *
 * - `isolation` IS representable, so it is carried. The pinned SDK's own schema
 *   for the agents JSON takes `isolation:b.enum(["worktree","remote"])` and
 *   `sub-agents.md:221` lists it among the fields that JSON accepts, even though
 *   `AgentDefinition` in `sdk.d.ts` declares no such field. Before this row an
 *   agent whose author wrote "give me an isolated copy of the repository" wrote
 *   into the user's real checkout instead.
 * - `componentHooks` is NOT representable from the value we hold — the
 *   descriptor carries Nessy's normalized `AutomationsConfig`, not the author's
 *   block — so the agent still runs and the user is TOLD, on the channel a user
 *   actually reads. The builder's own comment carries the measurement.
 *
 * Asserted at the seam, not on the builder, for the reason this file exists:
 * R10 shipped a correct composition that no production path invoked.
 */
describe('R12 — isolation and hooks at the query() seam', () => {
  const hooksBlock = {
    child: { automations: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: './guard.sh' }] }] } },
  } as never;

  it('carries an agent-declared worktree isolation into the turn', async () => {
    const options = await runTurn(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({
          key: 'agent.migrator',
          name: 'migrator',
          tools: ['Read', 'Write', 'Edit'],
          isolation: 'worktree',
        }),
      ],
    }));

    expect((options.agents as Record<string, unknown>).migrator).toEqual({
      description: 'reviews code',
      prompt: 'You are an auditor.',
      tools: ['Read', 'Write', 'Edit'],
      isolation: 'worktree',
    });
  });

  it('THE CONTROL — an agent that declares no isolation sends no isolation key', async () => {
    // Without this the assertion above cannot tell "the field is forwarded"
    // from "the field is always present": both would pass on a builder that
    // hard-coded `isolation: 'worktree'`, which would silently move every
    // subagent's writes out of the user's checkout.
    const options = await runTurn(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({ key: 'agent.migrator', name: 'migrator', tools: ['Read', 'Write', 'Edit'] }),
      ],
    }));

    const migrator = (options.agents as Record<string, Record<string, unknown>>).migrator!;
    expect('isolation' in migrator).toBe(false);
  });

  it('announces a dropped hooks block on a channel the user sees, and still registers the agent', async () => {
    const options = await runTurn(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({ key: 'agent.migrator', name: 'migrator', componentHooks: hooksBlock }),
      ],
    }));

    // NOT a refusal. Pi runs this agent and dispatches its hooks; withholding it
    // here would be a new Claude-only degradation, which is the overshoot R10's
    // review had to unwind.
    // P3.277 seeds the bundled four into the same record, so the claim here is
    // that the hooks-declaring agent is REGISTERED rather than withheld — not a
    // count of the record.
    expect(Object.keys(options.agents as object)).toContain('migrator');
    // And the hooks are not smuggled through in some other shape.
    expect('hooks' in (options.agents as Record<string, object>).migrator!).toBe(false);

    const warnings = infoEvents();
    expect(warnings.length).toBe(1);
    // `level: 'warning'` is the load-bearing half: `SessionManager`'s `case
    // 'info'` only PERSISTS the message into the transcript at that level. An
    // `info`-level yield would flash in the renderer and be gone on reload.
    expect(warnings[0]!.level).toBe('warning');
    expect(warnings[0]!.message).toContain('migrator');
    expect(warnings[0]!.message).toContain('hooks');
  });

  it('THE CONTROL — the same turn announces nothing when no hooks are declared', async () => {
    await runTurn(agentConfig({
      piRuntimeAgentDefinitions: [descriptor({ key: 'agent.migrator', name: 'migrator' })],
    }));

    expect(infoEvents()).toEqual([]);
  });

  it('announces once per definition, not once per turn', async () => {
    // A banner is persisted into the transcript, so a per-turn re-announcement
    // would fill the conversation with copies of itself.
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({ key: 'agent.migrator', name: 'migrator', componentHooks: hooksBlock }),
      ],
    }));

    await drive(agent);
    expect(infoEvents().length).toBe(1);

    capturedOptions.length = 0;
    capturedEvents.length = 0;
    await drive(agent);
    expect(infoEvents()).toEqual([]);
  });

  it('re-announces when the definition itself changed', async () => {
    // The dedupe key is the definition DIGEST, not the agent key: an author who
    // edits the very hooks block the banner is about must hear about it again.
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({
          key: 'agent.migrator',
          name: 'migrator',
          componentHooks: hooksBlock,
          definitionDigest: 'digest-before-edit',
        }),
      ],
    }));

    await drive(agent);
    expect(infoEvents().length).toBe(1);

    capturedOptions.length = 0;
    capturedEvents.length = 0;
    (agent as unknown as { config: { piRuntimeAgentDefinitions: unknown[] } })
      .config.piRuntimeAgentDefinitions = [
        descriptor({
          key: 'agent.migrator',
          name: 'migrator',
          componentHooks: hooksBlock,
          definitionDigest: 'digest-after-edit',
        }),
      ];
    await drive(agent);
    expect(infoEvents().length).toBe(1);
  });

  /**
   * The pair R10's refusal path and R12's notice now share one loop body, so
   * their ORDER is load-bearing and was held only by a comment. An agent that is
   * withheld has already announced its own reason; a second banner about the
   * hooks of an agent that will never run names a consequence that does not
   * exist. Moving the notice above the `continue` would produce exactly that,
   * with nothing red — until now.
   */
  it('says nothing about the hooks of an agent it refused to register', async () => {
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({
          key: 'agent.migrator',
          name: 'migrator',
          componentHooks: hooksBlock,
          // A skill key the pinned view does not carry: the refusal path.
          skillKeys: ['skill:native:not-in-the-view'],
        }),
      ],
    }));
    installCapabilityRuntime(agent, {
      'skill:native:house-style': '---\ndescription: house style\n---\nAlways use tabs.',
    });

    const options = await drive(agent);

    // Withheld, so it is not on the wire at all.
    expect(options.agents === undefined || !('migrator' in (options.agents as object))).toBe(true);
    // And no hooks banner was raised about it.
    expect(infoEvents().some(event => event.message?.includes('declares hooks'))).toBe(false);
  });
});

/**
 * P3.267 — `onDiagnostic → this.debug` reaches nobody on a packaged build.
 *
 * A3 §1.3 graded honesty as one thing and it is three channels reaching three
 * audiences: the `info`+`warning` banner reaches the USER and survives a
 * reload, `recordSessionFact` reaches a diagnostic reader, and
 * `onDiagnostic → this.debug` ends at an OPTIONAL callback pointed at a file
 * log that a packaged build never writes. Rows resting on the third read two
 * grades stronger than they are.
 *
 * W2-a's sweep found five switch-visible bindings on that channel — three in
 * `codex-agent.ts`, two here. Nothing new is built: R12's banner already
 * exists ten lines below one of the two call sites. These tests watch the
 * EVENTS, because a binding is invisible in the options object.
 */
describe('P3.267 — switch-visible degradations reach the banner, not only the log', () => {
  it('announces an imported agent this runtime could not give its declared skills', async () => {
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({
          key: 'agent.auditor',
          name: 'auditor',
          skillKeys: ['skill:native:not-in-the-view'],
        }),
      ],
    }));
    installCapabilityRuntime(agent, {
      'skill:native:house-style': '---\ndescription: house style\n---\nAlways use tabs.',
    });

    await drive(agent);

    const warnings = infoEvents();
    expect(warnings.length).toBe(1);
    // `level: 'warning'` is what makes `SessionManager` PERSIST it into the
    // transcript; an `info` level would flash and be gone on reload.
    expect(warnings[0]!.level).toBe('warning');
    expect(warnings[0]!.message).toContain('agent.auditor');
    expect(warnings[0]!.message).toContain('unavailable this turn');
  });

  it('THE CONTROL — a turn with nothing degraded yields no banner at all', async () => {
    // Without this arm the assertion above cannot tell "the degradation is
    // announced" from "every turn announces something", and the second would
    // put a warning on the transcript of every session in the product.
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [descriptor({ key: 'agent.auditor', name: 'auditor' })],
    }));
    installCapabilityRuntime(agent, {});

    await drive(agent);

    expect(infoEvents()).toEqual([]);
  });

  it('announces the same fact once per session, not once per turn', async () => {
    const agent = new ClaudeAgent(agentConfig({
      piRuntimeAgentDefinitions: [
        descriptor({ key: 'agent.auditor', name: 'auditor', skillKeys: ['skill:native:not-in-the-view'] }),
      ],
    }));
    installCapabilityRuntime(agent, {});

    await drive(agent);
    expect(infoEvents().length).toBe(1);

    capturedOptions.length = 0;
    capturedEvents.length = 0;
    await drive(agent);
    expect(infoEvents()).toEqual([]);
  });

  it('announces a clamped thinking effort, and NOT the authority line beside it', async () => {
    // The split is made inside `resolveClaudeThinkingOptions` (`onDegradation`),
    // so this asserts the two messages are graded differently rather than
    // matched apart by prose. A clamp changes what the user asked for; the
    // "the runtime wins" line attributes a source and changes nothing.
    recordClaudeModelCapabilities([{
      value: 'claude-sonnet-4-6',
      displayName: 'Sonnet',
      description: '',
      supportsAdaptiveThinking: true,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    } as never]);
    const agent = new ClaudeAgent(agentConfig({ thinkingLevel: 'max' }));

    await drive(agent);

    const warnings = infoEvents();
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.level).toBe('warning');
    expect(warnings[0]!.message).toContain('requested max → high');
    expect(warnings[0]!.message).not.toContain('the runtime wins');
  });

  it('THE OTHER SIDE OF THE SPLIT — the authority line fires and reaches no banner', async () => {
    // The `not.toContain` above is not enough on its own, and the re-break
    // proved it: a mutant that ALSO bannered the authority line survived,
    // because in that arm the runtime AGREES with the id heuristic and the
    // line never runs. So this arm makes it run — a non-haiku claude model the
    // runtime says has no adaptive thinking, with an effort the model accepts
    // so nothing clamps — and asserts the transcript stays empty.
    recordClaudeModelCapabilities([{
      value: 'claude-sonnet-4-6',
      displayName: 'Sonnet',
      description: '',
      supportsAdaptiveThinking: false,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    } as never]);
    const agent = new ClaudeAgent(agentConfig({ thinkingLevel: 'high' }));

    const options = await drive(agent);

    // The line ran: the heuristic would have said this model has adaptive
    // thinking, the runtime said otherwise, and the runtime won — which is
    // visible in the options the turn built.
    expect('maxThinkingTokens' in options).toBe(true);
    expect(infoEvents()).toEqual([]);
  });
});

/**
 * P3.267 + P3.310 — the child's own "your permission mode was overridden" line.
 *
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` makes the runtime discard the CLI mode, an
 * agent's frontmatter mode and `dangerouslySkipPermissions` alike and pin the
 * mode to `default`; it announces that on stderr. W2-x classified and honoured
 * the variable host-side (P3.310); the audience was the hole. `stderr` reached
 * `debug()` — an optional callback pointed at a file log a packaged build never
 * writes — `console.error` (no terminal in the desktop app) and a 20-line ring
 * buffer read ONLY on process failure, so a user whose `plan` mode was
 * discarded was told nothing at all.
 *
 * Driven through the REAL callback the agent hands the SDK, so the test fails
 * if the binding is removed or the callback is rebuilt without it.
 */
describe('P3.310 — the forced-default-mode warning leaves stderr for the banner', () => {
  /** The vendored 0.3.233 binary's own sentence, as it writes it. */
  const SCRUB_LINE = '⚠ Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set'
    + ' (allowed_non_write_users hardening). Declare allowedTools explicitly, or set'
    + ' CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to opt out.';

  function stderrOf(options: Record<string, unknown>): (data: string) => void {
    const sink = options.stderr;
    expect(typeof sink).toBe('function');
    return sink as (data: string) => void;
  }

  it('relays the vendor sentence onto the transcript, once per session', async () => {
    const agent = new ClaudeAgent(agentConfig());
    const options = await drive(agent);
    // Nothing on the first turn: the child had not said it yet.
    expect(infoEvents()).toEqual([]);

    stderrOf(options)(`${SCRUB_LINE}\n`);
    // Between turns there is no open slot, so it waits for the next one rather
    // than being dropped — the same defer queue codex uses.
    capturedOptions.length = 0;
    capturedEvents.length = 0;
    await drive(agent);

    const warnings = infoEvents();
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.level).toBe('warning');
    // Verbatim but for the leading glyph: the sentence names both the reason
    // and the opt-out, and paraphrasing someone else's runtime message is a
    // chance to be wrong about their behaviour.
    expect(warnings[0]!.message).toBe(SCRUB_LINE.replace(/^⚠\s*/, ''));

    // Latched: a session says it once, however many times the child repeats it.
    stderrOf(options)(`${SCRUB_LINE}\n`);
    capturedOptions.length = 0;
    capturedEvents.length = 0;
    await drive(agent);
    expect(infoEvents()).toEqual([]);
  });

  it('THE CONTROL — ordinary stderr reaches no transcript row', async () => {
    // Without this the assertion above cannot tell "the one switch-visible line
    // is lifted" from "stderr is echoed to the user", and the second would put
    // every warning the child mutters on screen.
    const agent = new ClaudeAgent(agentConfig());
    const options = await drive(agent);
    stderrOf(options)('node:internal/deps/undici: some noisy warning\n');
    stderrOf(options)('[DEBUG] cache miss\n');

    capturedOptions.length = 0;
    capturedEvents.length = 0;
    await drive(agent);
    expect(infoEvents()).toEqual([]);
  });
});

/**
 * F1.919 — the SDK's agent summary fork is NOT asked for (owner decision 2026-09-26, option (c)).
 *
 * P6.305 sent `agentProgressSummaries: true`, so the vendored `claude` forked a running subagent every ~30 s to
 * write its progress line. That fork's model re-issued the worker's pending tool call through our PreToolUse hook,
 * so one action raised TWO cards; an Allow on the fork's card runs nothing (the binary logs "Hook approved tool use
 * for Bash, but canUseTool is required" — F1.901, `8eb2b456f`), and on the RC #4 build (SIT-an2, SIT-an3) the
 * worker's real card expired at 540 s and the model reported it unanswered. The option is now sent as `false`, the
 * SDK's documented default ("Defaults to false."), rather than left out, so a lift that flips the default cannot
 * bring the fork back unseen. The progress line falls back to `task_progress.last_tool_name`, which the runtime
 * sends with no option (`claude-child-state-producer.test.ts`, "falls back to the tool name").
 */
describe('F1.919 — the agent summary fork is not asked for at the query() seam', () => {
  it('sends agentProgressSummaries: false, beside the sibling flag of the same options literal', async () => {
    const options = await runTurn(agentConfig());
    const summaries = options.agentProgressSummaries;
    const forwardSubagentText = options.forwardSubagentText;

    // POSITIVE CONTROL: the literal the option lives in is the one that reached `query()` — P6.561's neighbour
    // flag is there — so the assertion below cannot pass over an options object built somewhere else.
    expect(forwardSubagentText).toBe(true);
    // Exactly `false`: `true` is the fork and its duplicate card; absent would hand the answer to the SDK default.
    expect(summaries).toBe(false);
  });
});
