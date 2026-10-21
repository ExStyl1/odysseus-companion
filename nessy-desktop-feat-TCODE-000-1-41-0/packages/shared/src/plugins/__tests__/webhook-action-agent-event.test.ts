/**
 * F1.786 (origin SIT-l E20 / WJ-crit-ee proposed row 3; fix row UB12.28) — a
 * native `webhook` action under an AGENT event now RUNS, as the `http` hook the
 * binding view has always called it.
 *
 * MEASURED (2026-10-11, packaged RC4 `b72bb163d`, lane L5F3, port 9343), and
 * pinned here green at `281b40e18` as the failing arm the fix had to flip: a
 * user-tier `PreToolUse` matcher whose actions are `[command, webhook]` RAN the
 * command action (its hit file's mtime moved per turn) while the webhook action
 * delivered **0 bodies** to a loopback sink — twice. The SAME sink received the
 * body (HTTP 200, marker verbatim) through the product's own automations "Run
 * test" path, so loopback is NOT refused by egress policy: the gap was the
 * dispatcher. `executePluginHookAutomations`'s action loop collected
 * `command`, `plugin-prompt`, `plugin-agent`, `plugin-mcp-tool`, `plugin-http`
 * and `decision` — a bare `webhook` action matched no branch and was dropped
 * with no `hookErrors` entry, on the host tiers and on the claude SDK route
 * alike (`buildSdkHooksForConfig` funnels into the same executor).
 *
 * UB12.28 took QUESTIONS.md TL5F3-1's default (a): the action joins the
 * `plugin-http` entries (`webhookAsHttpHookAction`), so it reaches the injected
 * http runner with the existing safe-url and credential guards in front of it.
 * The planted runner below has the host runner's shape
 * (`SessionManager.pluginHttpHookRunner`: the descriptor minus
 * `allowedEnvVars` into `executeWebhookRequest`, the captured body returned as
 * the answer) without the host's trust/permission/receipt half, which this
 * package cannot reach.
 *
 * The arms:
 *   A. the direct executor: command runs AND the webhook delivers exactly one
 *      body to the loopback sink, no diagnostic (was: 0 bodies, runner never
 *      consulted);
 *   A2/A3. the two routes a session dispatches through — the host tiers
 *      (`PluginScopedAutomationSystem.executeAgentEvent`, Pi/codex and claude's
 *      PreToolUse pipeline) and the claude SDK route (`buildSdkHooks`) — each
 *      deliver one body;
 *   B. the executor itself still delivers via the Run-test path (unchanged);
 *   C. the `plugin-http` spelling still reaches the runner (unchanged control);
 *   N1. a webhook whose URL is not http(s) is refused by the safe-url guard and
 *       REPORTED in `hookErrors`, never reaching the runner — once per action
 *       object, not once per dispatch;
 *   N2. a webhook carrying `auth` is refused by the credential guard and
 *       reported, never sent without its credentials;
 *   D. the view half: live on `PreToolUse`, INERT on `SessionStart` (hooks.md's
 *      matrix withholds `http` there) and not dispatched there either.
 */
import { describe, expect, it } from 'bun:test';
import { executePluginHookAutomations, isInertHookBinding, PluginScopedAutomationSystem, type CommandHookRunner, type PluginHttpHookRunner } from '../hooks-automation.ts';
import { executeWebhookRequest } from '../../automations/webhook-utils.ts';
import { hookTypeSupportedForEvent } from '../../automations/types.ts';
import type { AgentEvent, AgentEventExecutionResult, AutomationsConfig, HookCommandActionResult, SdkAutomationInput } from '../../automations/types.ts';
import { buildAgentEventWebhookEnv } from '../../automations/utils.ts';
import { buildHookCommandEnv } from '../../automations/hook-command.ts';
import { validateAutomationsContent } from '../../automations/validation.ts';

const PRE_TOOL_USE_INPUT = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo f1786' } } as const;

/** A loopback sink on an ephemeral port; used where no body count is read. */
const sink = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    await request.text();
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
const SINK_URL = `http://127.0.0.1:${sink.port}/f1786-hook`;

/**
 * A counting loopback sink for one arm. It answers 2xx with an EMPTY body —
 * hooks.md#http-response-handling: "equivalent to exit code 0 with no output" —
 * so the run is clean and the arm reads delivery alone.
 */
async function withObserver(run: (url: (path: string) => string, bodies: string[]) => Promise<void>): Promise<void> {
  const bodies: string[] = [];
  const observer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      bodies.push(await request.text());
      return new Response('', { status: 200 });
    },
  });
  try {
    await run(path => `http://127.0.0.1:${observer.port}${path}`, bodies);
  } finally {
    observer.stop(true);
  }
}

/** The command half of the planted host authority; records every command it was asked to run. */
function commandSpy(commands: string[]): CommandHookRunner {
  return async action => {
    commands.push(action.command);
    return {
      type: 'command',
      command: action.command,
      success: true,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: 'ok\n',
    } as HookCommandActionResult;
  };
}

/** The http half, records urls only (no request) — the arm-C control's runner. */
function httpSpy(urls: string[]): PluginHttpHookRunner {
  return async request => {
    urls.push(request.http.url);
    return undefined;
  };
}

/**
 * The http half with the host runner's SHAPE: the descriptor (minus its header
 * env allowlist) through the existing webhook executor, the captured body
 * handed back as the hook's answer, a non-2xx as the non-blocking failure.
 */
function deliveringHttpRunner(urls: string[]): PluginHttpHookRunner {
  return async request => {
    urls.push(request.http.url);
    const { allowedEnvVars: _allowedEnvVars, ...http } = request.http;
    const result = await executeWebhookRequest({ type: 'webhook', ...http, captureResponse: true });
    return result.success ? { body: result.responseBody ?? '' } : { failed: true, code: 'http-hook-error' };
  };
}

function config(actions: readonly unknown[], event: AgentEvent = 'PreToolUse'): AutomationsConfig {
  return {
    automations: { [event]: [{ id: 'f1786', ...(event === 'PreToolUse' ? { matcher: 'Bash' } : {}), actions: structuredClone(actions) }] },
  } as unknown as AutomationsConfig;
}

async function dispatch(
  hookConfig: AutomationsConfig,
  planted: { commands: string[]; urls: string[] },
  httpRunner: PluginHttpHookRunner,
  event: AgentEvent = 'PreToolUse',
  input: SdkAutomationInput = PRE_TOOL_USE_INPUT,
): Promise<AgentEventExecutionResult> {
  return executePluginHookAutomations(hookConfig, event, input, {
    workspaceRootPath: '/tmp/f1-786-workspace',
    runner: commandSpy(planted.commands),
    httpRunner,
    hookSource: 'user',
  });
}

const MARKER_BODY = { marker: 'F1786', event: 'PreToolUse' };

describe('F1.786 — a native webhook action under an agent event runs as an http hook', () => {
  it('arm A: the command action runs AND the webhook delivers exactly one body to the loopback sink, with no diagnostic', async () => {
    await withObserver(async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const webhookUrl = url('/pretooluse-hook');
      const result = await dispatch(
        config([
          { type: 'command', command: 'true' },
          { type: 'webhook', url: webhookUrl, method: 'POST', body: MARKER_BODY },
        ]),
        planted,
        deliveringHttpRunner(planted.urls),
      );

      // The command action's control is unchanged — the live drive's hit file.
      expect(planted.commands).toEqual(['true']);
      expect(result.matchedCount).toBe(1);
      // The flip: the runner was consulted for the webhook's URL and the sink
      // received the declared body verbatim, once.
      expect(planted.urls).toEqual([webhookUrl]);
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]!)).toEqual(MARKER_BODY);
      // A clean 2xx-empty run leaves no notice and decides nothing.
      expect(result.hookErrors ?? []).toEqual([]);
      expect(result.decision).toBeUndefined();
    });
  });

  it('arm A2: the host tiers (PluginScopedAutomationSystem.executeAgentEvent) deliver one body from a user-tier webhook', async () => {
    await withObserver(async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const system = new PluginScopedAutomationSystem({
        workspaceRootPath: '/tmp/f1-786-workspace',
        userGlobalHookConfig: config([{ type: 'webhook', url: url('/host-tier'), body: { marker: 'F1786-A2' } }]),
        pluginHookConfig: { automations: {} },
        pluginCommandRunner: commandSpy(planted.commands),
        pluginHttpRunner: deliveringHttpRunner(planted.urls),
      });
      const result = await system.executeAgentEvent('PreToolUse', PRE_TOOL_USE_INPUT);
      expect(result.matchedCount).toBe(1);
      expect(bodies.map(body => JSON.parse(body))).toEqual([{ marker: 'F1786-A2' }]);
      expect(result.hookErrors ?? []).toEqual([]);
    });
  });

  it('arm A3: the claude SDK route (buildSdkHooks) delivers one body from the same tier', async () => {
    await withObserver(async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const system = new PluginScopedAutomationSystem({
        workspaceRootPath: '/tmp/f1-786-workspace',
        // PostToolUse: `buildSdkHooks` is the claude route for every event but
        // PreToolUse (that one runs through `executeAgentEvent`, arm A2).
        userGlobalHookConfig: config([{ type: 'webhook', url: url('/sdk-route'), body: { marker: 'F1786-A3' } }], 'PostToolUse'),
        pluginHookConfig: { automations: {} },
        pluginCommandRunner: commandSpy(planted.commands),
        pluginHttpRunner: deliveringHttpRunner(planted.urls),
      });
      const callbacks = (system.buildSdkHooks().PostToolUse ?? []).flatMap(matcher => matcher.hooks);
      expect(callbacks).toHaveLength(1);
      await callbacks[0]!({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 'tool-use-f1786', { signal: new AbortController().signal });
      expect(bodies.map(body => JSON.parse(body))).toEqual([{ marker: 'F1786-A3' }]);
    });
  });

  it('arm B: the same executor delivers to the same loopback sink — loopback is not refused by design', async () => {
    await withObserver(async (url, bodies) => {
      const result = await executeWebhookRequest({
        type: 'webhook',
        url: url('/run-test'),
        method: 'POST',
        body: { marker: 'F1786-B', via: 'automation-test' },
      });
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]!)).toEqual({ marker: 'F1786-B', via: 'automation-test' });
    });
  });

  it('arm C: the SAME matcher spelled plugin-http reaches the planted http runner', async () => {
    const planted = { commands: [] as string[], urls: [] as string[] };
    const result = await dispatch(
      config([{ type: 'plugin-http', http: { url: SINK_URL, method: 'POST' } }]),
      planted,
      httpSpy(planted.urls),
    );
    expect(result.matchedCount).toBe(1);
    expect(planted.urls).toEqual([SINK_URL]);
  });

  it('arm N1: a webhook whose URL is not http(s) is refused by the safe-url guard and REPORTED, once per action', async () => {
    const planted = { commands: [] as string[], urls: [] as string[] };
    // One config object dispatched twice: a PreToolUse hook fires on every tool
    // call, so the notice is per stored action, not per dispatch.
    const blocked = config([{ type: 'webhook', url: 'file:///etc/hosts', body: MARKER_BODY }]);
    const first = await dispatch(blocked, planted, httpSpy(planted.urls));
    const second = await dispatch(blocked, planted, httpSpy(planted.urls));

    expect(planted.urls).toEqual([]);
    expect(first.hookErrors?.map(notice => notice.summary)).toEqual(['http hook did not run: its URL is not an http(s) URL']);
    expect(first.hookRunFailed).toBe(true);
    expect(second.hookErrors ?? []).toEqual([]);
  });

  it('arm N2: a webhook carrying auth is refused by the credential guard and REPORTED, never sent', async () => {
    await withObserver(async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const result = await dispatch(
        config([{ type: 'webhook', url: url('/with-auth'), auth: { type: 'bearer', token: 'fixture-not-a-secret' } }]),
        planted,
        deliveringHttpRunner(planted.urls),
      );
      expect(planted.urls).toEqual([]);
      expect(bodies).toEqual([]);
      expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['http hook did not run: its request carries credentials, or could not be inspected']);
    });
  });

  it('arm D: the binding view shows the webhook live where http runs and INERT on SessionStart, where it is not dispatched', async () => {
    const webhookAction = { type: 'webhook' as const, url: SINK_URL, method: 'POST' as const };
    expect(isInertHookBinding(webhookAction, 'PreToolUse')).toBe(false);
    expect(hookTypeSupportedForEvent('PreToolUse', 'http')).toBe(true);
    // hooks.md's matrix withholds `http` on SessionStart, so the one place a
    // webhook still cannot run is shown as such — and the dispatch agrees.
    expect(hookTypeSupportedForEvent('SessionStart', 'http')).toBe(false);
    expect(isInertHookBinding(webhookAction, 'SessionStart')).toBe(true);
    // UA12.33's case is unchanged beside it.
    expect(isInertHookBinding({ type: 'script', script: 'scripts/x.ts' } as never, 'PreToolUse')).toBe(true);

    const planted = { commands: [] as string[], urls: [] as string[] };
    const result = await dispatch(
      config([{ type: 'webhook', url: SINK_URL }], 'SessionStart'),
      planted,
      httpSpy(planted.urls),
      'SessionStart',
      { hook_event_name: 'SessionStart', source: 'startup' },
    );
    expect(result.matchedCount).toBe(1);
    expect(planted.urls).toEqual([]);
  });
});

/**
 * UB12.68 — a native `webhook` action whose endpoint answers 2xx plain text
 * (Slack incoming webhooks answer `ok`) is a delivered notification: a clean
 * run, with no `http-hook-error` notice on every dispatch and nothing added to
 * the context. A plugin `type: "http"` hook keeps hooks.md § HTTP response
 * handling ("2xx with any other body, such as plain text: non-blocking error").
 * Each arm uses a real loopback endpoint and the host runner's shape
 * ({@link deliveringHttpRunner}).
 */
async function withAnsweringSink(
  answer: { status: number; body: string; contentType?: string },
  run: (url: string, bodies: string[]) => Promise<void>,
): Promise<void> {
  const bodies: string[] = [];
  const endpoint = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      bodies.push(await request.text());
      return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.contentType ?? 'text/html' } });
    },
  });
  try {
    await run(`http://127.0.0.1:${endpoint.port}/ub12-68`, bodies);
  } finally {
    endpoint.stop(true);
  }
}

const POST_TOOL_USE_INPUT = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo ub12-68' } } as const;

describe('UB12.68 — a native webhook answering 2xx plain text is a clean run; a plugin http hook keeps the notice', () => {
  it('POSITIVE: a native webhook answering `ok` on PostToolUse raises no notice on any dispatch, and its run is a success', async () => {
    await withAnsweringSink({ status: 200, body: 'ok' }, async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      // One stored config dispatched twice, as two tool calls would.
      const hookConfig = config([{ type: 'webhook', url, body: { text: 'tool ran' } }], 'PostToolUse');
      for (let call = 0; call < 2; call++) {
        const result = await dispatch(hookConfig, planted, deliveringHttpRunner(planted.urls), 'PostToolUse', POST_TOOL_USE_INPUT);
        expect(result.matchedCount).toBe(1);
        expect(result.hookErrors ?? []).toEqual([]);
        expect(result.decision).toBeUndefined();
        expect(result.hookRuns).toEqual([{ runtime: 'host', event: 'PostToolUse', name: expect.any(String), outcome: 'success' }]);
      }
      expect(bodies).toHaveLength(2);
    });
  });

  it('POSITIVE (host tier): PluginScopedAutomationSystem.executeAgentEvent gives the same clean PostToolUse run', async () => {
    await withAnsweringSink({ status: 200, body: 'ok' }, async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const system = new PluginScopedAutomationSystem({
        workspaceRootPath: '/tmp/ub12-68-workspace',
        userGlobalHookConfig: config([{ type: 'webhook', url, body: { text: 'tool ran' } }], 'PostToolUse'),
        pluginHookConfig: { automations: {} },
        pluginCommandRunner: commandSpy(planted.commands),
        pluginHttpRunner: deliveringHttpRunner(planted.urls),
      });
      const result = await system.executeAgentEvent('PostToolUse', POST_TOOL_USE_INPUT);
      expect(result.matchedCount).toBe(1);
      expect(bodies).toHaveLength(1);
      expect(result.hookErrors ?? []).toEqual([]);
    });
  });

  it('BOUNDARY: the text still never reaches the context on UserPromptSubmit (UB12.51 holds for a native webhook)', async () => {
    await withAnsweringSink({ status: 200, body: 'The deployment target is staging.' }, async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const result = await dispatch(
        config([{ type: 'webhook', url }], 'UserPromptSubmit'),
        planted,
        deliveringHttpRunner(planted.urls),
        'UserPromptSubmit',
        { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' },
      );
      expect(bodies).toHaveLength(1);
      expect(result.decision).toBeUndefined();
      expect(result.hookErrors ?? []).toEqual([]);
    });
  });

  it('BOUNDARY: a native webhook answering non-2xx is still the notice, and its JSON deny still decides', async () => {
    await withAnsweringSink({ status: 500, body: 'ok' }, async url => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const result = await dispatch(config([{ type: 'webhook', url }], 'PostToolUse'), planted, deliveringHttpRunner(planted.urls), 'PostToolUse', POST_TOOL_USE_INPUT);
      expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['http-hook-error']);
      expect(result.hookRuns?.map(run => run.outcome)).toEqual(['error']);
    });
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'policy says no' } });
    await withAnsweringSink({ status: 200, body: deny, contentType: 'application/json' }, async url => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const result = await dispatch(config([{ type: 'webhook', url }]), planted, deliveringHttpRunner(planted.urls));
      expect(result.decision?.decision).toBe('deny');
      expect(result.hookErrors ?? []).toEqual([]);
    });
  });

  it('NEGATIVE: a plugin http hook answering the same `ok` on PostToolUse still raises http-hook-error on every dispatch', async () => {
    await withAnsweringSink({ status: 200, body: 'ok' }, async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const hookConfig = config([{ type: 'plugin-http', http: { url, method: 'POST' } }], 'PostToolUse');
      for (let call = 0; call < 2; call++) {
        const result = await dispatch(hookConfig, planted, deliveringHttpRunner(planted.urls), 'PostToolUse', POST_TOOL_USE_INPUT);
        expect(result.decision).toBeUndefined();
        expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['http-hook-error']);
        expect(result.hookRuns?.map(run => [run.outcome, run.stderr])).toEqual([['error', 'http-hook-error']]);
      }
      expect(bodies).toHaveLength(2);
    });
  });
});

/**
 * UB12.105 — the rest of a native `webhook` action's 2xx answers. UB12.68 made
 * its plain text a delivered notification; a body that opens `{` was still read
 * as an http hook's answer, so an object that fails the output schema raised
 * one notice per dispatch, and a body that opens `{` and does not parse failed
 * CLOSED on PreToolUse, blocking every tool call for a notification endpoint.
 * Posture (b) (delegated rule: upstream v0.15.1's `executeWebhookRequest`
 * counts every 2xx as success and never reads the body): a native webhook's
 * 2xx answer that is not valid hook output is a clean run with nothing from it
 * applied. Valid hook output still decides (UB12.28). A plugin `type: "http"`
 * hook keeps hooks.md § HTTP response handling and this executor's fail-closed
 * read of an unreadable verdict.
 */
const SCHEMA_FAILING_OBJECT = '{"continue":"yes"}';
/** NDJSON: opens `{`, closes `}`, and is not one JSON object. */
const UNREADABLE_OBJECT = '{"status":"queued"}\n{"status":"sent"}';

describe('UB12.105 — a native webhook\'s schema-failing or unreadable 2xx object is a clean run; a plugin http hook keeps the notice', () => {
  it('POSITIVE: a native webhook answering {"continue":"yes"} on PostToolUse raises no notice on any dispatch, and its run is a success', async () => {
    await withAnsweringSink({ status: 200, body: SCHEMA_FAILING_OBJECT, contentType: 'application/json' }, async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const hookConfig = config([{ type: 'webhook', url, body: { text: 'tool ran' } }], 'PostToolUse');
      for (let call = 0; call < 2; call++) {
        const result = await dispatch(hookConfig, planted, deliveringHttpRunner(planted.urls), 'PostToolUse', POST_TOOL_USE_INPUT);
        expect(result.matchedCount).toBe(1);
        expect(result.hookErrors ?? []).toEqual([]);
        expect(result.decision).toBeUndefined();
        expect(result.hookRuns).toEqual([{ runtime: 'host', event: 'PostToolUse', name: expect.any(String), outcome: 'success' }]);
      }
      expect(bodies).toHaveLength(2);
    });
  });

  it('POSITIVE: a native webhook answering an unreadable object on PreToolUse does not block the tool call and raises no notice', async () => {
    await withAnsweringSink({ status: 200, body: UNREADABLE_OBJECT, contentType: 'application/x-ndjson' }, async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const result = await dispatch(config([{ type: 'webhook', url }]), planted, deliveringHttpRunner(planted.urls));
      expect(bodies).toHaveLength(1);
      expect(result.decision).toBeUndefined();
      expect(result.hookErrors ?? []).toEqual([]);
      expect(result.hookRuns?.map(run => run.outcome)).toEqual(['success']);
    });
  });

  it('BOUNDARY: a native webhook\'s VALID object still decides — {"continue":false} on PostToolUse stops, with no notice', async () => {
    await withAnsweringSink({ status: 200, body: '{"continue":false,"stopReason":"halt"}', contentType: 'application/json' }, async url => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const result = await dispatch(config([{ type: 'webhook', url }], 'PostToolUse'), planted, deliveringHttpRunner(planted.urls), 'PostToolUse', POST_TOOL_USE_INPUT);
      expect(result.decision?.decision).toBe('block');
      expect(result.hookErrors ?? []).toEqual([]);
    });
  });

  it('NEGATIVE: a plugin http hook answering the same bodies keeps the schema notice on every dispatch and still fails closed on PreToolUse', async () => {
    await withAnsweringSink({ status: 200, body: SCHEMA_FAILING_OBJECT, contentType: 'application/json' }, async (url, bodies) => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const hookConfig = config([{ type: 'plugin-http', http: { url, method: 'POST' } }], 'PostToolUse');
      for (let call = 0; call < 2; call++) {
        const result = await dispatch(hookConfig, planted, deliveringHttpRunner(planted.urls), 'PostToolUse', POST_TOOL_USE_INPUT);
        expect(result.decision).toBeUndefined();
        expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['Hook output failed schema validation: continue must be true or false']);
        expect(result.hookRuns?.map(run => run.outcome)).toEqual(['error']);
      }
      expect(bodies).toHaveLength(2);
    });
    await withAnsweringSink({ status: 200, body: UNREADABLE_OBJECT, contentType: 'application/x-ndjson' }, async url => {
      const planted = { commands: [] as string[], urls: [] as string[] };
      const result = await dispatch(config([{ type: 'plugin-http', http: { url, method: 'POST' } }]), planted, deliveringHttpRunner(planted.urls));
      expect(result.decision?.decision).toBe('block');
      expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['http-hook-response-unreadable']);
      expect(result.hookRuns?.map(run => [run.outcome, run.stderr])).toEqual([['error', 'http-hook-response-unreadable']]);
    });
  });
});

/**
 * UB12.52 — a native `webhook` action on an agent event expands its templates
 * the way the App-event `WebhookHandler` does (url, header values, body), from
 * the hook input (`buildAgentEventWebhookEnv`) and the `NESSY_WH_*` secrets,
 * BEFORE the safe-url and credential guards read the request. Until this row
 * the templates went out as written: docs-site's own `UserPromptSubmit`
 * example (`"url": "${NESSY_WH_SLACK_URL}"`, body `$NESSY_PROMPT`) was refused
 * as a non-http URL on every prompt.
 *
 * Arms: P1 the docs example delivers with the prompt in a valid JSON body; P2
 * url, header and body expand in ONE pass (an inserted tool input keeps its
 * `$HOME` and a secret reference literal), on the executor and on the claude
 * SDK route; N1 a secret that expands into `?api_key=` is refused by the
 * credential guard (before: by the safe-url guard, unexpanded); N2 nothing of
 * process.env but `NESSY_WH_*` expands; C a plugin `type: "http"` hook keeps
 * its url and body as declared; E the env carries every name a command hook
 * reads, raw; V validation keeps the template warning where the webhook runs
 * and says it never runs on SessionStart.
 */

interface RecordedRequest { url: string; headers: Record<string, string>; body: string }

async function withRecordingSink(run: (base: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
  const requests: RecordedRequest[] = [];
  const endpoint = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      requests.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: await request.text() });
      return new Response('', { status: 200 });
    },
  });
  try {
    await run(`http://127.0.0.1:${endpoint.port}`, requests);
  } finally {
    endpoint.stop(true);
  }
}

/** Bun 1.3.14: delete first, then assign (docs/agents/traps.md); restored the same way. */
async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    delete process.env[name];
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      delete process.env[name];
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/** The http half recording the whole descriptor the executor handed over; sends nothing. */
function descriptorSpy(seen: Array<Record<string, unknown>>): PluginHttpHookRunner {
  return async request => {
    seen.push(structuredClone(request.http) as Record<string, unknown>);
    return undefined;
  };
}

describe('UB12.52 — a native webhook on an agent event expands its templates before the guards', () => {
  it('P1: the docs-site UserPromptSubmit example delivers: ${NESSY_WH_*} url, $NESSY_PROMPT in a body that stays valid JSON', async () => {
    await withRecordingSink(async (base, requests) => {
      await withEnv({ NESSY_WH_UB1252_SINK: `${base}/ub12-52-prompt` }, async () => {
        const planted = { commands: [] as string[], urls: [] as string[] };
        const prompt = 'ship "v2"\nnow';
        const result = await dispatch(
          config([{ type: 'webhook', url: '${NESSY_WH_UB1252_SINK}', body: { text: 'Prompt submitted: $NESSY_PROMPT' } }], 'UserPromptSubmit'),
          planted,
          deliveringHttpRunner(planted.urls),
          'UserPromptSubmit',
          { hook_event_name: 'UserPromptSubmit', prompt },
        );
        expect(result.hookErrors ?? []).toEqual([]);
        expect(planted.urls).toEqual([`${base}/ub12-52-prompt`]);
        expect(requests).toHaveLength(1);
        expect(JSON.parse(requests[0]!.body)).toEqual({ text: `Prompt submitted: ${prompt}` });
      });
    });
  });

  it('P2: url, header and body expand in ONE pass, on the executor and on the claude SDK route', async () => {
    await withRecordingSink(async (base, requests) => {
      await withEnv({ NESSY_WH_UB1252_SINK: `${base}/ub12-52-tool` }, async () => {
        const action = {
          type: 'webhook',
          url: '${NESSY_WH_UB1252_SINK}?tool=$NESSY_TOOL_NAME',
          headers: { 'X-Nessy-Event': '$NESSY_EVENT' },
          body: { input: '${NESSY_TOOL_INPUT}', list: ['$NESSY_TOOL_NAME', 7] },
        };
        // The inserted tool input spells `$HOME` and the secret's own reference: both stay literal.
        const toolInput = { command: 'echo $HOME ${NESSY_WH_UB1252_SINK}' };
        const expected = { input: JSON.stringify(toolInput), list: ['Bash', 7] };

        const planted = { commands: [] as string[], urls: [] as string[] };
        const result = await dispatch(config([action]), planted, deliveringHttpRunner(planted.urls), 'PreToolUse', {
          hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput,
        });
        expect(result.hookErrors ?? []).toEqual([]);
        expect(planted.urls).toEqual([`${base}/ub12-52-tool?tool=Bash`]);

        // The claude SDK route funnels into the same executor (arm A3's shape).
        const system = new PluginScopedAutomationSystem({
          workspaceRootPath: '/tmp/ub12-52-workspace',
          userGlobalHookConfig: config([action], 'PostToolUse'),
          pluginHookConfig: { automations: {} },
          pluginCommandRunner: commandSpy(planted.commands),
          pluginHttpRunner: deliveringHttpRunner(planted.urls),
        });
        const callbacks = (system.buildSdkHooks().PostToolUse ?? []).flatMap(matcher => matcher.hooks);
        expect(callbacks).toHaveLength(1);
        await callbacks[0]!({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: toolInput }, 'tool-use-ub12-52', { signal: new AbortController().signal });

        expect(requests.map(request => new URL(request.url).search)).toEqual(['?tool=Bash', '?tool=Bash']);
        expect(requests.map(request => request.headers['x-nessy-event'])).toEqual(['PreToolUse', 'PostToolUse']);
        expect(requests.map(request => JSON.parse(request.body))).toEqual([expected, expected]);
      });
    });
  });

  it('N1: a secret that expands into ?api_key= is refused by the credential guard, reported, and never sent', async () => {
    await withRecordingSink(async (base, requests) => {
      await withEnv({ NESSY_WH_UB1252_CRED: `${base}/ub12-52-cred?api_key=fixture-not-a-secret` }, async () => {
        const planted = { commands: [] as string[], urls: [] as string[] };
        const result = await dispatch(
          config([{ type: 'webhook', url: '${NESSY_WH_UB1252_CRED}', body: MARKER_BODY }]),
          planted,
          deliveringHttpRunner(planted.urls),
        );
        expect(planted.urls).toEqual([]);
        expect(requests).toEqual([]);
        expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['http hook did not run: its request carries credentials, or could not be inspected']);
      });
    });
  });

  it('N2: nothing of process.env but NESSY_WH_* expands, and an unknown name is empty', async () => {
    await withRecordingSink(async (base, requests) => {
      await withEnv({ NESSY_UB1252_NOT_WH: 'visible-to-commands-only' }, async () => {
        const planted = { commands: [] as string[], urls: [] as string[] };
        const result = await dispatch(
          config([{ type: 'webhook', url: `${base}/ub12-52-isolation`, body: { leak: '[$HOME][${PATH}][$NESSY_UB1252_NOT_WH][$NESSY_NO_SUCH_FIELD]' } }]),
          planted,
          deliveringHttpRunner(planted.urls),
        );
        expect(result.hookErrors ?? []).toEqual([]);
        expect(requests.map(request => JSON.parse(request.body))).toEqual([{ leak: '[][][][]' }]);
      });
    });
  });

  it('C: a plugin type:"http" hook keeps its url and body as declared (hooks.md: only headers interpolate, through allowedEnvVars)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const planted = { commands: [] as string[], urls: [] as string[] };
    await dispatch(
      config([{ type: 'plugin-http', http: { url: `${SINK_URL}?tool=$NESSY_TOOL_NAME`, body: { t: '$NESSY_TOOL_NAME' } } }]),
      planted,
      descriptorSpy(seen),
    );
    expect(seen).toEqual([{ url: `${SINK_URL}?tool=$NESSY_TOOL_NAME`, body: { t: '$NESSY_TOOL_NAME' } }]);
  });

  it('E: the env carries every NESSY_* name a command hook reads, raw, with NESSY_EVENT never shadowed and secrets from NESSY_WH_* only', async () => {
    const input: SdkAutomationInput = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo "$HOME"' },
      tool_response: 'it\'s done',
      error: 'none',
      prompt: 'say "hi"',
      source: 'startup',
      model: 'coder',
      agent_id: 'a1',
      agent_type: 'Explore',
      task_id: 't1',
      task_subject: 'subject',
      task_description: 'description',
      message: 'm',
      title: 't',
      effort: { level: 'high' },
    };
    await withEnv({ NESSY_WH_UB1252_SECRET: 'wh-fixture', NESSY_UB1252_NOT_WH: 'not-for-webhooks' }, async () => {
      const webhookEnv = buildAgentEventWebhookEnv('PostToolUse', input);
      const commandNames = Object.keys(buildHookCommandEnv('PostToolUse', input)).filter(name => name.startsWith('NESSY_'));
      expect(commandNames.length).toBeGreaterThan(10);
      expect(commandNames.filter(name => !(name in webhookEnv))).toEqual([]);
      // Raw values: an http request reaches no shell.
      expect(webhookEnv.NESSY_PROMPT).toBe('say "hi"');
      expect(webhookEnv.NESSY_TOOL_INPUT).toBe(JSON.stringify(input.tool_input));
      expect(webhookEnv.NESSY_EFFORT).toBe('high');
      expect(webhookEnv.NESSY_WH_UB1252_SECRET).toBe('wh-fixture');
      expect(webhookEnv.NESSY_UB1252_NOT_WH).toBeUndefined();
      expect(webhookEnv.HOME).toBeUndefined();
    });
    // FileChanged's input carries its own `event` field; NESSY_EVENT stays the hook event.
    const fileChanged = buildAgentEventWebhookEnv('FileChanged', { hook_event_name: 'FileChanged', event: 'change', file_path: '/w/a.ts' });
    expect(fileChanged.NESSY_EVENT).toBe('FileChanged');
    expect(fileChanged.NESSY_FILE_PATH).toBe('/w/a.ts');
  });

  it('V: validation keeps the template warning where the webhook runs and says it never runs on SessionStart', () => {
    const TEMPLATE = 'Webhook URL contains variable templates — will be validated at runtime after expansion';
    const warningsFor = (event: string) => validateAutomationsContent(JSON.stringify({
      automations: { [event]: [{ actions: [{ type: 'webhook', url: '${NESSY_WH_SLACK_URL}' }] }] },
    })).warnings.map(warning => warning.message);

    expect(warningsFor('UserPromptSubmit')).toContain(TEMPLATE);
    expect(warningsFor('LabelAdd')).toContain(TEMPLATE);
    const sessionStart = warningsFor('SessionStart');
    expect(sessionStart).not.toContain(TEMPLATE);
    expect(sessionStart).toContain('A webhook action runs as an HTTP hook, and SessionStart does not run HTTP hooks; on SessionStart it never runs');
    expect(warningsFor('UserPromptSubmit').some(message => message.includes('never runs'))).toBe(false);
  });
});
