/**
 * P2.345 — Pi's Bash deadline now takes an operator ceiling, not only the
 * model's number.
 *
 * `env-vars.md#variables`, verbatim:
 *
 * - "`BASH_MAX_TIMEOUT_MS` | Maximum timeout the model can set for long-running
 *   bash commands (default: 600000, or 10 minutes). The effective ceiling is the
 *   larger of this and `BASH_DEFAULT_TIMEOUT_MS`"
 * - "`BASH_DEFAULT_TIMEOUT_MS` | Default timeout for long-running bash commands
 *   (default: 120000, or 2 minutes)"
 * - "Numeric variables such as timeouts, token budgets, and retry counts accept
 *   scientific notation and digit-separator spellings in addition to plain
 *   digits … Claude Code reads `2e3` as 2000 and `64_000` as 64000."
 *
 * Before this the supervisor's deadline was `Date.now() + request.timeoutMs`
 * with no `Math.min` anywhere in it, so an operator who set a maximum had
 * bounded nothing.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import {
  BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR,
  BASH_DEFAULT_TIMEOUT_ENV_VAR,
  BASH_MAX_TIMEOUT_COMPAT_ENV_VAR,
  BASH_MAX_TIMEOUT_ENV_VAR,
  DEFAULT_BASH_DEFAULT_TIMEOUT_MS,
  DEFAULT_BASH_MAX_TIMEOUT_MS,
  clampSupervisedChildTimeoutMs,
  declaredBashTimeoutCeiling,
  resolveBashDefaultTimeoutMs,
  resolveBashTimeoutCeilingMs,
} from '../pi-harness/process-supervisor-port.ts';

/** The 24 h `BACKGROUND_PROCESS_MAX_LIFETIME_MS` the Pi subprocess stamps. */
const BACKGROUND_LIFETIME_MS = 24 * 60 * 60 * 1000;

const TOUCHED = [
  BASH_MAX_TIMEOUT_ENV_VAR,
  BASH_MAX_TIMEOUT_COMPAT_ENV_VAR,
  BASH_DEFAULT_TIMEOUT_ENV_VAR,
  BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR,
] as const;
const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const envBinding = { environmentProfile: 'restricted' as const, environmentDigest: 'a'.repeat(64) };

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  };
}

function childRequest(overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'execution-1',
    semanticId: 'bash',
    command: '/bin/sh',
    args: ['-lc', 'true'],
    cwd: '/tmp/nessy-general-agent-test',
    workspaceRoot: '/malicious',
    profile: 'workspace',
    background: false,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('resolveBashTimeoutCeilingMs / resolveBashDefaultTimeoutMs', () => {
  it('uses the documented defaults when the operator set nothing', () => {
    expect(resolveBashTimeoutCeilingMs({})).toBe(600_000);
    expect(DEFAULT_BASH_MAX_TIMEOUT_MS).toBe(600_000);
    expect(resolveBashDefaultTimeoutMs({})).toBe(120_000);
    expect(DEFAULT_BASH_DEFAULT_TIMEOUT_MS).toBe(120_000);
  });

  it('reads the documented Claude spelling and lets the Nessy spelling win', () => {
    expect(resolveBashTimeoutCeilingMs({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '900000' })).toBe(900_000);
    expect(resolveBashTimeoutCeilingMs({
      [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '900000',
      [BASH_MAX_TIMEOUT_ENV_VAR]: '700000',
    })).toBe(700_000);
    expect(resolveBashDefaultTimeoutMs({ [BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR]: '300000' })).toBe(300_000);
    expect(resolveBashDefaultTimeoutMs({
      [BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR]: '300000',
      [BASH_DEFAULT_TIMEOUT_ENV_VAR]: '240000',
    })).toBe(240_000);
  });

  it('reads the documented numeric spellings — `2e3` as 2000 and `64_000` as 64000', () => {
    // The trap the page names: a naive `parseInt` reads `64_000` as 64, which is
    // the exact class of bug it says shipped ("`1e6` setting a timeout to 1").
    expect(resolveBashDefaultTimeoutMs({ [BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR]: '2e3' })).toBe(2000);
    expect(resolveBashDefaultTimeoutMs({ [BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR]: '64_000' })).toBe(64_000);
    expect(resolveBashTimeoutCeilingMs({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '1e6' })).toBe(1_000_000);
    expect(resolveBashTimeoutCeilingMs({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: ' 1_800_000 ' })).toBe(1_800_000);
  });

  it('falls back to the documented default rather than to "no bound"', () => {
    // Negative/boundary half. `0` is the interesting one: read as "unlimited" it
    // would turn a typo into exactly the unbounded deadline this change closes.
    for (const raw of ['', '   ', 'abc', '0x3', '0', '-5', '+600000', '1_', '_1', '1__0', 'Infinity', 'NaN']) {
      expect(resolveBashTimeoutCeilingMs({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: raw })).toBe(600_000);
    }
  });

  it('is the LARGER of the two, so lowering only the maximum yields the default', () => {
    // "The effective ceiling is the larger of this and `BASH_DEFAULT_TIMEOUT_MS`"
    // — a command must never be born already over the limit.
    expect(resolveBashTimeoutCeilingMs({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '60000' })).toBe(120_000);
    expect(resolveBashTimeoutCeilingMs({
      [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '60000',
      [BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR]: '30000',
    })).toBe(60_000);
    expect(resolveBashTimeoutCeilingMs({ [BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR]: '1800000' })).toBe(1_800_000);
  });
});

/**
 * P6.146's hand-off, applied — the "did the operator set one" reader that
 * `codex-agent.ts` used to spell a second time, now beside its resolver.
 *
 * Every case here is a BEHAVIOUR-PRESERVING pin of what that duplicate did, so
 * the extraction cannot have quietly changed the honest surface it feeds.
 */
describe('declaredBashTimeoutCeiling', () => {
  it('says nothing when the operator set nothing', () => {
    expect(declaredBashTimeoutCeiling({})).toBeUndefined();
  });

  it('counts a present-but-blank value as unset, like every explicit-only reader here', () => {
    expect(declaredBashTimeoutCeiling({ [BASH_MAX_TIMEOUT_ENV_VAR]: '' })).toBeUndefined();
    expect(declaredBashTimeoutCeiling({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '   ' })).toBeUndefined();
  });

  it('names the Nessy spelling when both are set — the resolver’s own precedence', () => {
    expect(declaredBashTimeoutCeiling({
      [BASH_MAX_TIMEOUT_ENV_VAR]: ' 700000 ',
      [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '900000',
    })).toEqual({ envVar: BASH_MAX_TIMEOUT_ENV_VAR, raw: '700000', ceilingMs: 700_000 });
  });

  it('names the compat spelling when only that one is set', () => {
    expect(declaredBashTimeoutCeiling({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '900000' }))
      .toEqual({ envVar: BASH_MAX_TIMEOUT_COMPAT_ENV_VAR, raw: '900000', ceilingMs: 900_000 });
  });

  it('still reports a MALFORMED explicit value, quoting it beside the ceiling in force', () => {
    // Presence, not parseability: the operator did set the knob, and on codex it
    // is still not honoured, so the surface must still say so. Reporting nothing
    // here would answer a question they did not ask.
    expect(declaredBashTimeoutCeiling({ [BASH_MAX_TIMEOUT_ENV_VAR]: 'off' }))
      .toEqual({ envVar: BASH_MAX_TIMEOUT_ENV_VAR, raw: 'off', ceilingMs: DEFAULT_BASH_MAX_TIMEOUT_MS });
  });

  it('reports the EFFECTIVE ceiling, so a maximum under the default reads as the default', () => {
    expect(declaredBashTimeoutCeiling({ [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '60000' }))
      .toEqual({
        envVar: BASH_MAX_TIMEOUT_COMPAT_ENV_VAR,
        raw: '60000',
        ceilingMs: DEFAULT_BASH_DEFAULT_TIMEOUT_MS,
      });
  });
});

describe('clampSupervisedChildTimeoutMs', () => {
  const base = { timeoutMs: 0, background: false, command: '/bin/sh', executionId: 'e1' };

  it('lowers a foreground deadline to the ceiling and leaves every other field alone', () => {
    const clamped = clampSupervisedChildTimeoutMs(
      { ...base, timeoutMs: 3_600_000 },
      { [BASH_MAX_TIMEOUT_COMPAT_ENV_VAR]: '600000' },
    );
    expect(clamped).toEqual({ ...base, timeoutMs: 600_000 });
  });

  it('only ever lowers — a request at or under the ceiling is the same object', () => {
    const under = { ...base, timeoutMs: 5_000 };
    expect(clampSupervisedChildTimeoutMs(under, {})).toBe(under);
    const exact = { ...base, timeoutMs: 600_000 };
    expect(clampSupervisedChildTimeoutMs(exact, {})).toBe(exact);
  });

  it('exempts a background start, whose 24h lifetime is ours and not the model’s', () => {
    const background = { ...base, background: true, timeoutMs: BACKGROUND_LIFETIME_MS };
    expect(clampSupervisedChildTimeoutMs(background, {})).toBe(background);
    expect(clampSupervisedChildTimeoutMs(background, {}).timeoutMs).toBe(BACKGROUND_LIFETIME_MS);
  });
});

describe('PiAgent.handleProcessStartRequest applies the ceiling on the host side', () => {
  async function startWith(request: Record<string, unknown>) {
    const starts: any[] = [];
    const port = {
      start: async (input: any) => {
        starts.push(input);
        return {
          handle: 'process_0123456789abcdef0123456789abcdef',
          output: '', nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
          isolationProfile: 'workspace:test', ...envBinding,
        };
      },
      write: async () => { throw new Error('unused') },
      read: async () => { throw new Error('unused') },
      stop: async () => {},
      drainSession: async () => [],
    };
    const agent = new PiAgent(createConfig({ processSupervisorPort: port }));
    (agent as any).subprocess = { stdin: { writable: true, write: () => {} } };
    try {
      await (agent as any).handleProcessStartRequest({ requestId: 'request-1', request });
    } finally {
      (agent as any).subprocess = null;
      agent.destroy();
    }
    return starts;
  }

  it('clamps a model-chosen deadline that exceeds the operator maximum', async () => {
    // Both variables set, because the ceiling is the LARGER of the two — setting
    // only the maximum would leave the 120000 default as the effective bound and
    // the assertion would be measuring the wrong number.
    process.env[BASH_MAX_TIMEOUT_COMPAT_ENV_VAR] = '5000';
    process.env[BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR] = '5000';

    const starts = await startWith(childRequest({ timeoutMs: 3_600_000 }));

    expect(starts).toHaveLength(1);
    expect(starts[0].timeoutMs).toBe(5_000);
  });

  it('passes an unbounded-by-default request through at the documented 600000', async () => {
    // The positive control on the clamp: with no operator variables set at all,
    // an hour-long request still lands bounded, and at the DOCUMENTED number
    // rather than at whatever the previous assertion happened to set.
    for (const key of TOUCHED) delete process.env[key];

    const starts = await startWith(childRequest({ timeoutMs: 3_600_000 }));

    expect(starts[0].timeoutMs).toBe(600_000);
  });

  it('leaves a request under the ceiling exactly as the model sent it', async () => {
    for (const key of TOUCHED) delete process.env[key];

    const starts = await startWith(childRequest({ timeoutMs: 3_000 }));

    expect(starts[0].timeoutMs).toBe(3_000);
  });

  it('does not shorten a background task to the Bash ceiling', async () => {
    process.env[BASH_MAX_TIMEOUT_COMPAT_ENV_VAR] = '5000';
    process.env[BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR] = '5000';

    const starts = await startWith(childRequest({
      semanticId: 'bash_background',
      background: true,
      timeoutMs: BACKGROUND_LIFETIME_MS,
    }));

    expect(starts[0].timeoutMs).toBe(BACKGROUND_LIFETIME_MS);
  });

  it('never composes a `persistent` start from a child request', async () => {
    // The supervisor gives `persistent` requests `Number.MAX_SAFE_INTEGER` and a
    // clamp applied before that branch would kill long-lived MCP/LSP children.
    // The exemption is structural — `persistent` is omitted from the child
    // request type — so this asserts the structure rather than a branch, and it
    // would fail if the allowlist ever started threading the field.
    process.env[BASH_MAX_TIMEOUT_COMPAT_ENV_VAR] = '5000';
    process.env[BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR] = '5000';

    const starts = await startWith(childRequest({ persistent: true, timeoutMs: 3_600_000 }));

    expect(starts[0].persistent).toBeUndefined();
    expect(starts[0].timeoutMs).toBe(5_000);
  });
});
