import { describe, expect, it } from 'bun:test';
import { ElicitationDialogGate, detachAfter } from './elicitation-dialog-gate.ts';

const tick = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * `mcp.md:261` — "A call waiting on an open elicitation dialog isn't
 * backgrounded while the dialog is open; the server is blocked on your input,
 * not slow, so Claude Code defers the move until the dialog closes."
 */
describe('the auto-background detach clock', () => {
  it('detaches at the threshold when no dialog is open', async () => {
    const gate = new ElicitationDialogGate();
    let detached = false;

    const timer = detachAfter(20, gate);
    void timer.promise.then(() => { detached = true; });

    await tick(60);
    expect(detached).toBe(true);
    timer.cancel();
  });

  it('stays attached past the threshold while a dialog is open', async () => {
    const gate = new ElicitationDialogGate();
    gate.set('dialog-1', true);
    let detached = false;

    const timer = detachAfter(20, gate);
    void timer.promise.then(() => { detached = true; });

    // Several thresholds' worth of waiting: the human is thinking, not the server.
    await tick(120);
    expect(detached).toBe(false);

    // Closing re-arms the clock rather than detaching instantly — the time
    // spent in the dialog is not evidence that the call is slow.
    gate.set('dialog-1', false);
    await tick(5);
    expect(detached).toBe(false);

    await tick(60);
    expect(detached).toBe(true);
    timer.cancel();
  });

  it('holds until the LAST of several dialogs closes', async () => {
    const gate = new ElicitationDialogGate();
    gate.set('a', true);
    gate.set('b', true);
    let detached = false;

    const timer = detachAfter(20, gate);
    void timer.promise.then(() => { detached = true; });

    await tick(60);
    gate.set('a', false);
    await tick(60);
    expect(detached).toBe(false);

    gate.set('b', false);
    await tick(60);
    expect(detached).toBe(true);
    timer.cancel();
  });

  it('never detaches after cancel, even once a dialog closes', async () => {
    const gate = new ElicitationDialogGate();
    gate.set('dialog-1', true);
    let detached = false;

    const timer = detachAfter(20, gate);
    void timer.promise.then(() => { detached = true; });

    await tick(40);
    timer.cancel();
    gate.set('dialog-1', false);

    await tick(80);
    expect(detached).toBe(false);
  });
});

describe('the elicitation dialog gate', () => {
  it('is idempotent on repeated opens and closes', () => {
    const gate = new ElicitationDialogGate();
    expect(gate.isOpen()).toBe(false);

    gate.set('a', true);
    gate.set('a', true);
    expect(gate.isOpen()).toBe(true);

    gate.set('a', false);
    expect(gate.isOpen()).toBe(false);
    // A close for an id that is not open must not disturb another dialog.
    gate.set('b', true);
    gate.set('a', false);
    expect(gate.isOpen()).toBe(true);
  });

  it('resolves whenClosed immediately when nothing is open', async () => {
    const gate = new ElicitationDialogGate();
    await gate.whenClosed();
    expect(gate.isOpen()).toBe(false);
  });

  it('releases every waiter on reset', async () => {
    const gate = new ElicitationDialogGate();
    gate.set('a', true);
    let released = false;
    void gate.whenClosed().then(() => { released = true; });

    gate.reset();
    await tick(1);
    expect(released).toBe(true);
    expect(gate.isOpen()).toBe(false);
  });
});
