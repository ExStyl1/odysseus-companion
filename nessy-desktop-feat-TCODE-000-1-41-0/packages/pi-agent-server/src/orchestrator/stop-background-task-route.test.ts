/**
 * L9 — THE SUBPROCESS END OF THE HOST'S ROUTE TO `BackgroundTaskRegistry`.
 *
 * The registry is the only mechanism that can stop two of the three background
 * kinds: an auto-backgrounded MCP call registers HERE and creates no child-session
 * record, and a background workflow's entry owns the DAG script's own
 * `AbortController` — stop the current node's child and the script schedules the
 * next node. The host had no way in, so this file pins that it does now, and pins
 * the three properties of the handler that make it safe to press on a wedged
 * session.
 *
 * Source-contract shaped, like `pi-runtime-protocol.test.ts`: the handler reads
 * module-scope generation state inside a 5 000-line entry point, so its behaviour
 * cannot be reached without booting the whole server. What CAN be asserted without
 * that — and is what would actually regress — is the wiring and the three
 * deliberate omissions. The registry's own `stop` semantics are covered by
 * `background-task-registry.test.ts`, and the correlation/settlement half by
 * `packages/shared/src/agent/__tests__/pi-stop-background-task.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BackgroundTaskRegistry } from './background-task-registry.ts';

const server = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

/**
 * The function BODY only.
 *
 * Ends at the function's own closing brace and not at the next declaration: the
 * next thing in the file is a doc comment that itself says "Deliberately NO
 * `ensureSession()`", which made the absence assertion below pass on the neighbour's
 * prose. Measured — that is exactly how it failed on the first run.
 */
function handlerSource(): string {
  const start = server.indexOf('async function handleStopBackgroundTask(');
  expect(start).toBeGreaterThan(0);
  const end = server.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return server.slice(start, end);
}

describe('stop_background_task — the wire', () => {
  it('is a member of the InboundMessage union', () => {
    const start = server.indexOf('type InboundMessage =');
    const end = server.indexOf("| { type: 'shutdown' };", start);
    expect(start).toBeGreaterThan(0);
    expect(server.slice(start, end)).toContain("| { type: 'stop_background_task'; id: string; taskId: string }");
  });

  it('has a correlated result on the OutboundMessage union', () => {
    const start = server.indexOf('type OutboundMessage =');
    const end = server.indexOf('| OutboundError;', start);
    expect(server.slice(start, end)).toContain('| OutboundStopBackgroundTaskResult');
    expect(server).toContain("type: 'stop_background_task_result';");
  });

  it('is dispatched to the handler', () => {
    const start = server.indexOf("case 'stop_background_task':");
    expect(start).toBeGreaterThan(0);
    // D1.111 — bounded by the NEXT `case` rather than by 200 characters, so a
    // growing arm cannot push the dispatch out of the region and a neighbour's
    // dispatch cannot drift into it. `packages/pi-agent-server` has no
    // dependency on `@nessy-agent/shared`, so this is the derived end anchor
    // rather than the shared brace matcher the sibling suites use.
    const next = server.indexOf("\n    case '", start + 1);
    expect(next).toBeGreaterThan(start);
    expect(server.slice(start, next)).toContain('handleStopBackgroundTask(msg)');
  });
});

describe('stop_background_task — the handler', () => {
  it('reaches the PUBLISHED generation registry, not a captured one', () => {
    // A generation swap replaces the instance, so a stop must hit the registry the
    // running work is registered in — the same reason `/subtask` reads it here.
    const handler = handlerSource();
    expect(handler).toContain('activeBackgroundTasks');
    expect(handler).toContain('registry.stop(msg.taskId)');
  });

  it('never starts a session to answer a stop', () => {
    // A stop must work on a session too wedged to answer anything else, and a
    // registry that does not exist holds no task.
    expect(handlerSource()).not.toContain('ensureSession()');
  });

  it('answers on every path, including the no-registry one', () => {
    const handler = handlerSource();
    // Three `send`s: no registry, the registry's answer, and a thrown registry.
    expect([...handler.matchAll(/send\(\{ type: 'stop_background_task_result'/g)]).toHaveLength(3);
    expect(handler).toContain('catch (error)');
  });

  it('distinguishes "not mine" from "mine and it failed"', () => {
    // The host falls through to the durable child service on the first and must
    // NOT on the second, so `errorMessage` may only ride the thrown path.
    const handler = handlerSource();
    const thrown = handler.slice(handler.indexOf('catch (error)'));
    expect(thrown).toContain('errorMessage');
    expect(handler.slice(0, handler.indexOf('catch (error)'))).not.toContain('errorMessage');
  });
});

/**
 * THE PROPERTY THE HOST'S DE-DUPLICATION LEANS ON, measured rather than assumed:
 * a second stop for the same id joins the first operation instead of running it
 * again. `SessionManager.stopAgentTask` has its own in-flight map, and this is the
 * floor underneath it.
 */
describe('BackgroundTaskRegistry.stop — the idempotence the route relies on', () => {
  it('joins an in-flight stop rather than aborting a second time', async () => {
    const registry = new BackgroundTaskRegistry();
    const controller = new AbortController();
    let aborts = 0;
    controller.signal.addEventListener('abort', () => { aborts += 1; });
    let release: () => void = () => {};
    const settled = new Promise<void>(resolve => { release = resolve });
    registry.register({ taskId: 'bg-1', controller, settled });

    const first = registry.stop('bg-1');
    const second = registry.stop('bg-1');
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(aborts).toBe(1);
  });

  it('returns false for an id it does not hold, which is the host\'s cue to fall through', async () => {
    const registry = new BackgroundTaskRegistry();
    expect(await registry.stop('bg-unknown')).toBe(false);
  });
});
