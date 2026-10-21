/**
 * P2.192 — the sixth floating emission, the one `53849b319` stopped at because
 * it lives in a file another lane held.
 *
 * `emitAutomationEvent` is `async`, so it has no synchronous throw for a belt to
 * catch: every failure inside it arrives as a REJECTION. `emitInstructionsLoaded`
 * fired `void this.emitAutomationEvent('InstructionsLoaded', …)` per loaded file
 * with no rejection handler, so a hook the user configured could fail to run
 * and leave no trace but an unhandled rejection — which Electron logs without
 * exiting, a packaged build does not log outside debug mode, and the headless
 * server prints under a generic `[server] Unhandled rejection` line that names
 * neither the event nor the agent.
 *
 * MEASURED at the surface a user or a headless run actually sees, not asserted:
 * with a rejecting emitter, BEFORE the fix the agent's own debug channel — the
 * one `SessionManager` wires to `sessionLog.info`, always on — received
 * `[]`, and two rejections escaped, one per instruction file. AFTER, two named
 * lines and zero escapes.
 *
 * The channel is the record this class ALREADY writes: `emitAutomationEvent`'s
 * own `onError` logs `Automation event <event> failed: …` on `this.debug`. A
 * delivery failure is a label on that same record, distinguished by wording,
 * not a second one.
 */
import { describe, expect, it } from 'bun:test';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

interface InstructionFile {
  file_path: string;
  memory_type: 'User' | 'Project' | 'Local' | 'Managed';
  load_reason: 'startup';
}

const FILES: InstructionFile[] = [
  { file_path: '/w/CLAUDE.md', memory_type: 'Project', load_reason: 'startup' },
  { file_path: '/w/.claude/CLAUDE.md', memory_type: 'Local', load_reason: 'startup' },
];

/** Build an agent whose automation emitter behaves as `emit` says. */
function agentWith(emit: () => Promise<unknown>) {
  const debugLines: string[] = [];
  const agent = new TestAgent(createMockBackendConfig());
  agent.onDebug = (message: string) => { debugLines.push(message); };
  (agent as unknown as { emitAutomationEvent: unknown }).emitAutomationEvent = emit;
  const loadInstructions = (files: InstructionFile[] = FILES): void => {
    (agent as unknown as { emitInstructionsLoaded(f: InstructionFile[]): void })
      .emitInstructionsLoaded(files);
  };
  return { agent, debugLines, loadInstructions };
}

/**
 * Drop comment lines before scanning for call sites.
 *
 * The comments in `base-agent.ts` QUOTE the shape they are warning about — a
 * detector that does not strip them counts the warning as the defect, which is
 * how this one first measured 3 call sites where there is 1.
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter(line => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

/** Let the detached emissions settle without sleeping on a clock. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('a detached InstructionsLoaded emission has a failure channel', () => {
  it('names the undelivered event on the debug record, once per file', async () => {
    const { debugLines, loadInstructions } = agentWith(async () => {
      throw new Error('automation system is gone');
    });

    loadInstructions();
    await settle();

    // Identity on the whole sentence, not "something was logged" — the before
    // state was an EMPTY channel, and any weaker assertion would also accept a
    // line that fails to say which event or why.
    expect(debugLines).toEqual([
      'Automation event InstructionsLoaded could not be delivered: automation system is gone',
      'Automation event InstructionsLoaded could not be delivered: automation system is gone',
    ]);
  });

  it('renders a thrown value that has no default conversion', async () => {
    // `String(Object.create(null))` raises (P2.65), and this renderer runs
    // inside the rejection handler that exists to stop a rejection vanishing —
    // a throw there would be one more unhandled rejection.
    const { debugLines, loadInstructions } = agentWith(async () => {
      throw Object.create(null) as never;
    });

    loadInstructions([FILES[0]!]);
    await settle();

    expect(debugLines).toEqual([
      'Automation event InstructionsLoaded could not be delivered: (unrenderable error)',
    ]);
  });

  it('a host debug sink that throws does not become a SYNCHRONOUS throw', async () => {
    // P2.304 — THIS TEST NO LONGER CLAIMS TO MEASURE THE ESCAPE, and the
    // paragraph that used to stand here was wrong in a way that mattered.
    //
    // It said the assertion "has to be on the unhandled rejection itself", and
    // asserted `expect(escaped).toEqual([])` over a
    // `process.on('unhandledRejection')` listener. MEASURED on bun 1.3.14, with
    // a positive control on the same rig (the same listener DOES fire under a
    // plain `bun run`): under `bun test` that listener is never consulted —
    // `process.listenerCount('unhandledRejection')` reads 0 before registration,
    // so the runner intercepts below `process` rather than racing a listener.
    // **The assertion could not fail.** It is nonetheless the measurement
    // P2.192's commit message cites as its proof, and the family grew
    // 5 -> 7 -> 8 -> 14 underneath it, every increment found by a person reading.
    //
    // What is left here is the half that IS observable in process: the caller
    // sees no synchronous throw. The escape half moved to
    // `floating-emission-escape.test.ts`, which runs the same scenario in a
    // plain `bun` child process — where the listener works, and where a
    // deliberately re-broken control must fail before any assertion is believed.
    const agent = new TestAgent(createMockBackendConfig());
    agent.onDebug = () => { throw new Error('log sink exploded'); };
    (agent as unknown as { emitAutomationEvent: unknown }).emitAutomationEvent =
      async () => { throw new Error('automation system is gone'); };

    expect(() => {
      (agent as unknown as { emitInstructionsLoaded(f: InstructionFile[]): void })
        .emitInstructionsLoaded(FILES);
    }).not.toThrow();
    await settle();
  });

  it('POSITIVE CONTROL: a delivered event logs nothing at all', async () => {
    // Without this, "a line appeared" could be satisfied by a channel that
    // always writes, and every assertion above would mean nothing.
    const { debugLines, loadInstructions } = agentWith(async () => undefined);

    loadInstructions();
    await settle();

    expect(debugLines).toEqual([]);
  });

  it('no bare `void this.emitAutomationEvent(` call sites are left in the class', async () => {
    // The class sweep, mechanical rather than narrative: the point of P2.192 is
    // that the LAST one is gone, so a reintroduction anywhere in the file fails
    // here and not in production. Read as bytes — this file carries a NUL and a
    // line-oriented tool skips it silently.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../base-agent.ts', import.meta.url), 'utf-8');
    // Exactly ONE `void` on each detached call, and it is the wrapper's own —
    // the one place where a detached promise is legitimate, because that is the
    // line that attaches the `.catch`. Counted rather than line-anchored: `\s`
    // spans newlines under `m`, so a `^\s*` detector silently over-matches, and
    // this one was wrong in that exact way on its first write.
    const emitVoids = codeOnly(source).match(/void this\.emitAutomationEvent\(/g) ?? [];
    expect(emitVoids).toHaveLength(1);
    expect(source).toContain('void this.emitAutomationEvent(event, input)\n      .catch(');
    const flushVoids = codeOnly(source).match(/void this\.flushPendingHookSessionDirectives\(/g) ?? [];
    expect(flushVoids).toHaveLength(1);
    expect(source).toContain('void this.flushPendingHookSessionDirectives()\n      .catch(');
    // Anti-vacuity: the file really was read, and it really does emit the event.
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain("this.emitDetachedAutomationEvent('InstructionsLoaded'");
  });

  it('POSITIVE CONTROL: the call-site detector flags a reintroduced bare void', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../base-agent.ts', import.meta.url), 'utf-8');
    const reintroduced = source.replace(
      "      this.emitDetachedAutomationEvent('InstructionsLoaded', {",
      "      void this.emitAutomationEvent('InstructionsLoaded', {",
    );
    expect(codeOnly(reintroduced).match(/void this\.emitAutomationEvent\(/g) ?? []).toHaveLength(2);
    // ...and the unmutated source still measures 1, so the control is a delta.
    expect(codeOnly(source).match(/void this\.emitAutomationEvent\(/g) ?? []).toHaveLength(1);
  });
});
