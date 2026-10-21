/**
 * A3.3 — which credential authorized this session, as the child answers it.
 *
 * `apiKeySource` is a REQUIRED field of `SDKSystemMessage` and had **0** readers
 * across `packages` and `apps`: the init message carried the answer and the host
 * discarded it. The producer is `ClaudeAgent.captureChildApiKeySource`, whose
 * docblock carries the enum, the two members this fork can produce, and why a
 * DISAGREEMENT is the whole value of reading a nearly-constant field.
 *
 * The rig is P6.263's, deliberately: one `ClaudeAgent`, the private capture fed
 * a raw `system/init`, no slot open — which is also the respawn case, since the
 * capture sits above `routeLiveMessage`'s slot guard.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';

const WORKSPACE_ROOT = '/tmp/nessy-a33';

let counter = 0;

function agentConfig(): BackendConfig {
  counter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-a33',
      name: 'A3.3',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-a33-${counter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

function feedInit(agent: unknown, fields: Record<string, unknown>): void {
  (agent as { captureChildApiKeySource(message: unknown): void })
    .captureChildApiKeySource({ type: 'system', subtype: 'init', session_id: 'sdk-1', ...fields });
}

describe('A3.3 · the session says which credential authorized it', () => {
  it('answers null before any init, and the child’s own value after one', () => {
    const agent = new ClaudeAgent(agentConfig());

    // `null` is an ANSWER — "no init seen yet" — and must not read as `'none'`,
    // which is a real member meaning a bearer/OAuth credential.
    expect(agent.childApiKeySource()).toBeNull();

    feedInit(agent, { apiKeySource: 'ANTHROPIC_API_KEY' });
    expect(agent.childApiKeySource()).toBe('ANTHROPIC_API_KEY');
  });

  it('keeps the value an unknown or absent field would have blanked', () => {
    const agent = new ClaudeAgent(agentConfig());
    feedInit(agent, { apiKeySource: 'none' });
    expect(agent.childApiKeySource()).toBe('none');

    // The two ways a child can fail to say: a CLI that predates the field, and a
    // transport that delivers it empty. Neither may overwrite the last answer
    // with a blank — the same guard the init roster fields carry.
    feedInit(agent, {});
    feedInit(agent, { apiKeySource: '' });
    expect(agent.childApiKeySource()).toBe('none');

    // A LATER init that really says something else DOES move it: the field is
    // session-scoped and re-read per init, so a respawn onto another credential
    // is exactly what this must be able to report.
    feedInit(agent, { apiKeySource: 'apiKeyHelper' });
    expect(agent.childApiKeySource()).toBe('apiKeyHelper');
  });

  it('ignores a message that is not a system/init', () => {
    const agent = new ClaudeAgent(agentConfig());

    // The negative control for the guard itself. Without it, a capture that read
    // every message would pass both cases above and still be wrong.
    (agent as unknown as { captureChildApiKeySource(message: unknown): void })
      .captureChildApiKeySource({ type: 'system', subtype: 'status', apiKeySource: 'ANTHROPIC_API_KEY' });
    (agent as unknown as { captureChildApiKeySource(message: unknown): void })
      .captureChildApiKeySource({ type: 'assistant', apiKeySource: 'ANTHROPIC_API_KEY' });

    expect(agent.childApiKeySource()).toBeNull();
  });
});

/**
 * D1.208 — the runtime's own telemetry verdict for this session.
 *
 * The same shape as A3.3 above and for the same reason: the binary publishes
 * `analytics_disabled` on the `system`/`init` object — measured on the vendored
 * darwin-arm64 binary 2026-09-18, `grep -aoF … | wc -l` answering **5**, a
 * fabricated needle **0**, `DO_NOT_TRACK` **14** as the positive control — while
 * `sdk.d.ts` declares it **0** times and this repo read it **0** times. So it is
 * read OFF the object, which is AGENTS.md's membership rule: extra fields
 * survive at runtime whether or not a `.d.ts` mentions them, and a guard derived
 * from the typings is narrower than the bundle.
 *
 * The `[product]` posture — diagnostic always, a user-visible line only on the
 * DISAGREEMENT — is on the capture's own docblock. These arms are its controls,
 * and the negative ones are what make the positive mean anything: a notice on
 * every session would satisfy "the verdict is surfaced" just as well.
 *
 * D1.277 moved the SENTENCE to the host: the agent answers
 * `childTelemetryOptOutIgnored()` and `SessionManager.announceChildTelemetryVerdict`
 * renders the localised settings-tiers clause, so the app's own words about its
 * own host reach the user in their language and on one channel rather than two.
 * These arms therefore drive the ANSWER; the sentence is pinned next door in
 * `packages/server-core/src/sessions/__tests__/child-telemetry-verdict-notice.test.ts`.
 */
describe('D1.208 · the child\'s analytics verdict, and when it is worth a line', () => {
  interface Internals {
    captureChildAnalyticsDisabled(message: unknown): void
    pendingDegradationNotices: string[]
  }

  /**
   * The agent's whole user-visible output for this fact after D1.277: the names
   * the operator set, or `null` when there is no disagreement. The degradation
   * queue is asserted EMPTY beside it in every arm, because "the sentence moved
   * to the host" and "the sentence was deleted" look the same from here.
   */
  function optOutIgnored(agent: ClaudeAgent): string | null {
    return agent.childTelemetryOptOutIgnored();
  }

  function feedAnalyticsInit(agent: ClaudeAgent, fields: Record<string, unknown>): void {
    (agent as unknown as Internals).captureChildAnalyticsDisabled({
      type: 'system', subtype: 'init', session_id: 'sdk-1', ...fields,
    });
  }

  function notices(agent: ClaudeAgent): string[] {
    return (agent as unknown as Internals).pendingDegradationNotices;
  }

  /**
   * The two names are read from the REAL `process.env`, so each arm sets and
   * restores them itself. DELETE BEFORE ASSIGN and delete again on the restore
   * path: a name introduced by bare assignment is readable by property and
   * INVISIBLE to `Object.keys`/`{...process.env}` on bun 1.3.14 (AGENTS.md), and
   * the restore has to leave the process exactly as it was for the next file.
   */
  function withEnv(entries: Record<string, string | undefined>, body: () => void): void {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(entries)) {
      previous[key] = process.env[key];
      delete process.env[key];
      if (value !== undefined) process.env[key] = value;
    }
    try {
      body();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        delete process.env[key];
        if (value !== undefined) process.env[key] = value;
      }
    }
  }

  it('answers null before any init, and the child\'s own boolean after one', () => {
    withEnv({ DISABLE_TELEMETRY: undefined, DO_NOT_TRACK: undefined }, () => {
      const agent = new ClaudeAgent(agentConfig());

      // `null` is an ANSWER — "no init seen yet" — and must not read as `false`,
      // which would claim the runtime said telemetry is on.
      expect(agent.childAnalyticsDisabled()).toBeNull();

      feedAnalyticsInit(agent, { analytics_disabled: true });
      expect(agent.childAnalyticsDisabled()).toBe(true);
      // The reassuring direction is never a line: nothing to act on.
      expect(optOutIgnored(agent)).toBeNull();
      expect(notices(agent)).toEqual([]);
    });
  });

  it('BOUNDARY — a CLI that omits the field leaves the last answer standing', () => {
    withEnv({ DISABLE_TELEMETRY: undefined, DO_NOT_TRACK: undefined }, () => {
      const agent = new ClaudeAgent(agentConfig());

      feedAnalyticsInit(agent, { analytics_disabled: true });
      // "Absent on older CLIs" is the binary's own wording for this family, so
      // an init without it must not overwrite a real answer with a guess.
      feedAnalyticsInit(agent, {});
      feedAnalyticsInit(agent, { analytics_disabled: 'yes' });
      expect(agent.childAnalyticsDisabled()).toBe(true);
    });
  });

  it('POSITIVE — the operator asked for no telemetry and the runtime says it is on', () => {
    withEnv({ DISABLE_TELEMETRY: '0', DO_NOT_TRACK: undefined }, () => {
      const agent = new ClaudeAgent(agentConfig());

      feedAnalyticsInit(agent, { analytics_disabled: false });

      // It names what THEY set, because that is the thing they can change — and
      // `0` is the concrete case the sitting's truthiness reading predicts.
      expect(optOutIgnored(agent)).toBe('DISABLE_TELEMETRY');
      // D1.277 — and the agent no longer writes the English sentence itself.
      expect(notices(agent)).toEqual([]);
    });
  });

  it('NEGATIVE — analytics on with NO opt-out set is the documented default, and says nothing', () => {
    withEnv({ DISABLE_TELEMETRY: undefined, DO_NOT_TRACK: undefined }, () => {
      const agent = new ClaudeAgent(agentConfig());

      feedAnalyticsInit(agent, { analytics_disabled: false });

      expect(agent.childAnalyticsDisabled()).toBe(false);
      // Without this arm the posture is indistinguishable from a per-session
      // telemetry nag, which is the thing the posture exists to refuse.
      expect(optOutIgnored(agent)).toBeNull();
      expect(notices(agent)).toEqual([]);
    });
  });

  it('NEGATIVE — a name that is present but EMPTY is not a request', () => {
    withEnv({ DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' }, () => {
      const agent = new ClaudeAgent(agentConfig());

      feedAnalyticsInit(agent, { analytics_disabled: false });

      expect(optOutIgnored(agent)).toBeNull();
      expect(notices(agent)).toEqual([]);
    });
  });

  it('BOUNDARY — a later init that says analytics is OFF withdraws the disagreement', () => {
    withEnv({ DISABLE_TELEMETRY: '1', DO_NOT_TRACK: undefined }, () => {
      const agent = new ClaudeAgent(agentConfig());

      feedAnalyticsInit(agent, { analytics_disabled: false });
      expect(optOutIgnored(agent)).toBe('DISABLE_TELEMETRY');

      // The value is re-read per init, so the ANSWER has to be too — a stale
      // `requested` would keep the host printing a line about a state that has
      // since been corrected.
      feedAnalyticsInit(agent, { analytics_disabled: true });
      expect(optOutIgnored(agent)).toBeNull();
    });
  });
});
