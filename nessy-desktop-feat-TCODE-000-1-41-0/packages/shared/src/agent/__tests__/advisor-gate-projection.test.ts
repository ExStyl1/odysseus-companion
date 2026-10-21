/**
 * P2.1 fix wave — the advisor is OPT-IN, so a disabled advisor must be INVISIBLE.
 *
 * `advisorEnabled` ships FALSE. The first cut consulted it only inside
 * `BaseAgent.executeAdvisorConsult`, which meant every pi and claude session
 * advertised `advisor_consult` — a schema, a /context row and a tool the model
 * could call — in order to be told "the advisor is turned off". The gate now
 * sits at BOTH build sites, exactly where `browser_tool`'s already sits, and
 * these rows measure the EFFECTIVE surface each runtime is handed rather than
 * the source text that produces it.
 *
 * On the numbers: `getSessionToolNames` is the REGISTRY projection and is
 * deliberately unmoved by this gate — `session-tools-core` has no dependency on
 * `shared` and cannot read a host setting. The literals that used to stand here
 * (`54 pi / 44 claude`, then `46 claude` after P2.2 moved `Goal`/`GoalGet` off
 * `pi-only`) are gone for the same reason the built ones below are: see the
 * comment on the first row.
 *
 * THE BUILT SURFACES ARE NO LONGER WRITTEN DOWN (W2-p, 2026-09-03). They were —
 * as `45`/`44` for claude and `53`/`52` for Pi — and the claude pair went stale
 * the day P3.276 landed `ReviewDiff`: the built surface reached 46/45 while this
 * file still asserted 45/44, a registry-count drift with zero references to the
 * gate it names. `derivedSurface` below states the same claim as a DERIVATION
 * off the registry with each subtraction named, so a tool added or removed
 * anywhere moves both sides together and only a change to THIS GATE can redden
 * the row. It also compares the whole set rather than its size, which a count
 * cannot do: two simultaneous moves in opposite directions leave the length
 * untouched.
 *
 * The storage module is mocked with a SPREAD and restored from functions
 * captured BEFORE the mock is installed — a bare `mock.module` amputates the
 * module for every later test file in the process, and restoring by re-spreading
 * the (already mutated) namespace re-installs the mocks permanently.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realStorage from '../../config/storage.ts';

const originals = {
  getAdvisorEnabled: realStorage.getAdvisorEnabled,
  getBrowserToolEnabled: realStorage.getBrowserToolEnabled,
};

let advisorEnabled = false;

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getAdvisorEnabled: () => advisorEnabled,
  // Pinned ON so the absolute counts below measure the advisor's gate and not
  // the browser one; the browser tool's own toggle has its own coverage.
  getBrowserToolEnabled: () => true,
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => ({
    ...realStorage,
    getAdvisorEnabled: originals.getAdvisorEnabled,
    getBrowserToolEnabled: originals.getBrowserToolEnabled,
  }));
});

const { getSessionToolNames, TOOL_DESCRIPTIONS } = await import('@nessy-agent/session-tools-core');
const { ADVISOR_MOMENTS } = await import('../advisor.ts');
const { PiAgent } = await import('../pi-agent.ts');
const {
  getSessionScopedTools,
  invalidateAllSessionToolsCaches,
  mergeSessionScopedToolCallbacks,
} = await import('../session-scoped-tools.ts');
const { getSystemPrompt } = await import('../../prompts/system.ts');

const ADVISOR = 'advisor_consult';
const PI_ADVISOR = `mcp__session__${ADVISOR}`;

/**
 * What each runtime's built surface MUST contain, derived from the registry the
 * host projects from rather than transcribed as a number.
 *
 * Three differences separate a built surface from its registry projection, and
 * each is named here so a fourth one appearing cannot hide inside a count:
 *
 *  - `send_developer_feedback` rides `FEATURE_FLAGS.developerFeedback`, which
 *    ships off, so it is never built on either runtime;
 *  - `advisor_consult` rides the setting this file exists to measure;
 *  - `ReviewDiff` (P3.276) is gated on a per-SESSION host binding, so the bare
 *    `getSessionToolNames()` projection cannot see it while a real claude
 *    session — which is what `claudeSurface()` builds — has the port bound.
 *    `reviewDiffPort: true` is therefore the claude projection's honest form,
 *    and Pi does not take it at all (`visibility: 'not-pi'`).
 */
function derivedSurface(projection: 'pi' | 'claude', advisorOn: boolean): string[] {
  const names = projection === 'pi'
    ? getSessionToolNames({ projection: 'pi' })
    : getSessionToolNames({ reviewDiffPort: true });
  return [...names]
    .filter(name => name !== 'send_developer_feedback' && (advisorOn || name !== ADVISOR))
    .sort();
}

/**
 * The names Pi is actually handed this turn: the real
 * `buildCurrentProxyToolDefinitions`, which is where the filter lives and which
 * runs once per turn from `buildExecutionManifestForCurrentTurn`.
 */
function piSurface(): string[] {
  const agent = new PiAgent({
    provider: 'pi',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws',
    },
    session: { id: 'advisor-gate', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 },
    mcpPool: {
      setElicitationHandler() {},
      getProxyToolDefs: () => [],
      alwaysLoadProxyToolNames: () => new Set<string>(),
      // TRUE so the two MCP resource tools stay in the count — otherwise the
      // absolute numbers below would be measuring that filter instead.
      hasResourceCapability: () => true,
      slugsForLeaser: () => new Set<string>(),
    },
  } as any);
  try {
    const defs = (agent as any).buildCurrentProxyToolDefinitions() as Array<{ name: string }>;
    return defs.map(def => def.name).filter(name => name.startsWith('mcp__session__'));
  } finally {
    agent.destroy();
  }
}

/**
 * The names the Claude SDK is actually handed: the real `getSessionScopedTools`
 * factory, read off the MCP server it returns. The cache is cleared first
 * because the tools array is cached per session — the same clearing
 * `setAdvisorEnabled` now performs.
 */
function claudeSurface(): string[] {
  invalidateAllSessionToolsCaches();
  // P6.895 — the diff port is BOUND here because `derivedSurface` above takes
  // `reviewDiffPort: true`, and until P6.895 the builder ignored the option
  // entirely: the two sides agreed by accident, on a session that had bound
  // nothing. Binding it makes this what the comment above always claimed it was
  // — a real claude session — and makes the pair a live check of the gate.
  mergeSessionScopedToolCallbacks(
    { workspaceId: 'ws', sessionId: 'advisor-gate' },
    { reviewDiff: { compute: async () => ({ diff: '' }) } as any },
  );
  const server = getSessionScopedTools('advisor-gate', '/tmp/ws', 'ws', '/tmp/ws') as any;
  return Object.keys(server.instance._registeredTools as Record<string, unknown>);
}

beforeEach(() => {
  advisorEnabled = false;
});

describe('the registry projection is unmoved — the gate is a HOST gate', () => {
  /**
   * THE COUNTS ARE GONE TOO (W9-be, 2026-09-08), for the reason the header
   * gives about the built ones. They read `54 pi / 46 claude / 16 codex` while
   * the live registry was `57 / 48 / 16`: two literals rotted the moment wave 9
   * added tools, and a red that says "57 is not 54" reports nothing about the
   * SUBJECT of this file, which is that the advisor flag moves the registry
   * projection by zero. The absolute surface is pinned where it belongs — the
   * 82-row fixture in `pi-harness-baseline.test.ts`, which is regenerated on
   * purpose; a second, hand-maintained copy of it here could only ever disagree.
   *
   * Stated as a WHOLE-SET comparison rather than a size, which a count cannot
   * do: two simultaneous moves in opposite directions leave the length alone.
   *
   * The codex projection is read for the same reason it always was: P3.222
   * moved it 18 → 16 by removing `list_sessions` and `get_session_info`, which
   * were bound by no codex context and answered "not available in this context"
   * on every call. Nothing a codex session could DO changed — two dishonest
   * offers went away — and the advisor flag was not what moved them.
   */
  it('the three projections are IDENTICAL with the advisor on and off', () => {
    const read = () => ({
      pi: [...getSessionToolNames({ projection: 'pi' })].sort(),
      claude: [...getSessionToolNames()].sort(),
      codex: [...getSessionToolNames({ externalStandaloneOnly: true })].sort(),
    });
    advisorEnabled = true;
    const on = read();
    advisorEnabled = false;
    expect(read()).toEqual(on);
    // …and the tool IS in the two projections the host gate later subtracts it
    // from, which is what makes "unmoved" a measurement rather than a tautology
    // over three sets that never contained it. Codex does not take it at all.
    expect(on.pi).toContain(ADVISOR);
    expect(on.claude).toContain(ADVISOR);
    expect(on.codex).not.toContain(ADVISOR);
  });
});

describe('Pi — advisor_consult is advertised only when the advisor is on', () => {
  it('an ENABLED advisor is on the surface: the whole derived set including it', () => {
    advisorEnabled = true;
    const names = piSurface();
    expect(names).toContain(PI_ADVISOR);
    expect(names.map(name => name.replace('mcp__session__', '')).sort())
      .toEqual(derivedSurface('pi', true));
  });

  it('a DISABLED advisor is absent: the derived set minus it, and nothing else', () => {
    advisorEnabled = false;
    const names = piSurface();
    expect(names).not.toContain(PI_ADVISOR);
    expect(names.map(name => name.replace('mcp__session__', '')).sort())
      .toEqual(derivedSurface('pi', false));
  });

  // The counts above are only meaningful with the DIFFERENCE named: the gate
  // must move exactly one tool, not shift the surface some other way.
  it('the two states differ by exactly advisor_consult', () => {
    advisorEnabled = true;
    const on = piSurface();
    advisorEnabled = false;
    const off = piSurface();
    expect(on.filter(name => !off.includes(name))).toEqual([PI_ADVISOR]);
    expect(off.filter(name => !on.includes(name))).toEqual([]);
  });

  // Positive control: `browser_tool` is the tool this gate was modelled on and
  // is pinned ON, so "absent" above is the advisor's gate and not a build that
  // quietly stopped producing backend tools.
  it('the other backend tools are on the surface in both states', () => {
    for (const enabled of [true, false]) {
      advisorEnabled = enabled;
      const names = piSurface();
      expect(names).toContain('mcp__session__browser_tool');
      expect(names).toContain('mcp__session__call_llm');
      expect(names).toContain('mcp__session__spawn_session');
    }
  });
});

describe('claude-runtime — the same gate at the SDK build site', () => {
  it('an ENABLED advisor is on the surface: the whole derived set including it', () => {
    advisorEnabled = true;
    const names = claudeSurface();
    expect(names).toContain(ADVISOR);
    expect(names.slice().sort()).toEqual(derivedSurface('claude', true));
  });

  it('a DISABLED advisor is absent: the derived set minus it, and nothing else', () => {
    advisorEnabled = false;
    const names = claudeSurface();
    expect(names).not.toContain(ADVISOR);
    expect(names.slice().sort()).toEqual(derivedSurface('claude', false));
  });

  it('the two states differ by exactly advisor_consult', () => {
    advisorEnabled = true;
    const on = claudeSurface();
    advisorEnabled = false;
    const off = claudeSurface();
    expect(on.filter(name => !off.includes(name))).toEqual([ADVISOR]);
    expect(off.filter(name => !on.includes(name))).toEqual([]);
  });

  it('the other backend tools are on the surface in both states', () => {
    for (const enabled of [true, false]) {
      advisorEnabled = enabled;
      const names = claudeSurface();
      expect(names).toContain('browser_tool');
      expect(names).toContain('call_llm');
      expect(names).toContain('spawn_session');
    }
  });
});

/**
 * Three call sites read the same setting — the two tool build sites and the
 * system prompt's `## Advisor` block. They can drift apart, and each direction
 * is its own bug: a prompt telling the model to consult a tool it was not given
 * ("Tool not found"), or a tool nothing ever tells the model to use.
 */
describe('the prompt block and the tool agree', () => {
  it.each([['an enabled', true], ['a disabled', false]] as const)(
    '%s advisor puts the block and the tool in the same state',
    (_label, enabled) => {
      advisorEnabled = enabled;
      const prompt = getSystemPrompt();
      expect(prompt.includes('## Advisor (`advisor_consult`)')).toBe(enabled);
      expect(piSurface().includes(PI_ADVISOR)).toBe(enabled);
      expect(claudeSurface().includes(ADVISOR)).toBe(enabled);
    },
  );
});

/**
 * P3.29 — THE SAME AGREEMENT, FOR CODEX, WHOSE CARRIER IS A DIFFERENT TEXT.
 *
 * ## Why codex needs its own arm rather than a row in the block above
 *
 * The arm above compares a STATE (block present ⇔ tool advertised). Codex
 * cannot be measured that way and is NOT exempt for it — the reason is that it
 * never receives the block at all. `getSystemPrompt` has exactly two production
 * importers, `pi-agent.ts` and `claude-agent.ts`; `codex-agent.ts` imports no
 * prompt builder, because codex composes its own system prompt inside the
 * app-server and takes project guidance from `AGENTS.md`. So on codex the TOOL
 * DESCRIPTION is the whole carrier of the advisor's triggering guidance — the
 * same three moments, the same three rules, in a text nothing else checks.
 *
 * That is a gap in ENFORCEMENT, not in behaviour, and it is the gap this
 * describe closes: an editor who tightens "consult on the second identical
 * failure" in the prompt block and not in the description leaves codex on the
 * old guidance, silently and forever, because codex reads only the half they
 * did not touch. Both directions are the same bug.
 *
 * ## What is deliberately NOT pinned here, and where it is pinned instead
 *
 * The codex GATE — `advisorEnabled` ⇔ the `--advisor-consult` spawn flag on
 * `[mcp_servers.session]` — is not measurable from this file without importing
 * the codex runtime stack into a module that mocks host storage. It is covered
 * in `codex-advisor-advertisement.test.ts`, which drives `buildSessionMcpSpec`
 * under both settings and additionally pins P3.28's mid-session correction.
 *
 * ## The two texts, by file
 *
 * - the block: `prompts/system.ts`, `advisorSection`
 * - the description: `session-tools-core/tool-defs.ts`, `TOOL_DESCRIPTIONS.advisor_consult`
 */
describe('codex reads the tool description, so the two texts must agree', () => {
  /** The `## Advisor` block alone, which only exists with the advisor ON. */
  function advisorBlock(): string {
    advisorEnabled = true;
    const prompt = getSystemPrompt();
    const start = prompt.indexOf('## Advisor (`advisor_consult`)');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = prompt.indexOf('\n## ', start + 1);
    return end === -1 ? prompt.slice(start) : prompt.slice(start, end);
  }

  const description = () => TOOL_DESCRIPTIONS.advisor_consult;

  it('the description names every moment in the vocabulary, and no others', () => {
    const text = description();
    for (const moment of ADVISOR_MOMENTS) {
      expect(text).toContain(`\`${moment}\``);
    }
    // The count, not just the presence: a fourth moment added to the schema and
    // the prompt but not here would leave codex unable to ask for it.
    const bullets = text.split('\n').filter(line => line.startsWith('- `'));
    expect(bullets).toHaveLength(ADVISOR_MOMENTS.length);
  });

  it('both texts offer the SAME NUMBER of moments', () => {
    const promptBullets = advisorBlock().split('\n').filter(line => line.startsWith('- **'));
    expect(promptBullets).toHaveLength(ADVISOR_MOMENTS.length);
  });

  /**
   * The clauses that are guidance rather than vocabulary. Each is present
   * verbatim in both texts today, and each is a rule a user would notice the
   * loss of: when to consult, when NOT to, what the reply is worth, and what
   * the advisor cannot do.
   *
   * Kept to phrases the two texts genuinely share. The `before-done` moment is
   * worded differently on purpose (the prompt addresses the model mid-task, the
   * description addresses a tool caller), which is why the moment BULLETS are
   * pinned by count and id above rather than by wording.
   */
  it.each([
    ['the "not routinely" ceiling', 'not routinely'],
    ['the no-repeat rule', 'do not consult twice for the same question'],
    ['the advice-not-instruction contract', 'advice, not an instruction'],
    ['the no-tools statement', 'has no tools and cannot act'],
    ['the recurring-error threshold', 'has come back after you already tried to fix it'],
  ])('%s is in BOTH texts', (_label, clause) => {
    expect(advisorBlock()).toContain(clause);
    expect(description()).toContain(clause);
  });
});
