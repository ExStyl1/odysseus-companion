/**
 * P6.579 — `PermissionDenied` was the last event in OUR vocabulary that codex
 * did not mint.
 *
 * ## What was wrong
 *
 * `runtime-hook-events.ts` marked the cell `unwired`: the moment exists on codex
 * — our answer path denies, and codex's own auto-review denies — and nothing
 * emitted the event, so a plugin whose `PermissionDenied` hook was installed and
 * reported enabled did nothing after a switch onto codex.
 *
 * ## What these cases pin
 *
 * The two ELIGIBLE causes, and the ones that must stay silent. Pi's own rule is
 * `guardianDenied || dont_ask_would_prompt`, "never for floors or ordinary gate
 * blocks" — so a hook body written against Pi must see the same causes here or
 * the switch changes how often it runs. A floor refusal firing the event would
 * be just as wrong as the absence this row closes.
 *
 * P6.1073 — a THIRD silent cause, and the reason the yes-case below carries an
 * escape hatch. Every harness here leaves `onPermissionRequest` unset, so every
 * case runs UNATTENDED, and since P6.531 an unattended turn refuses whatever no
 * rule and no floor covered. That refusal is neither of Pi's causes, so it too
 * must stay silent — and until this row the "answered yes" case was answering
 * NO and passing on the same silence, proving nothing at all.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-perm-denied',
      name: 'Codex PermissionDenied Workspace',
      rootPath: '/tmp/ws-codex-perm-denied',
      workspaceRootPath: '/tmp/ws-codex-perm-denied',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-perm-denied',
    } as never,
    session: {
      id: 'session-codex-perm-denied',
      workspaceRootPath: '/tmp/ws-codex-perm-denied',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface Emitted { event: string; input: Record<string, unknown> }

function harness(mode: string) {
  const agent = new CodexAgent(createConfig());
  const emitted: Emitted[] = [];
  const internals = agent as unknown as {
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>;
    handleServerRequest: (method: string, params: unknown) => unknown;
    handleNotification: (method: string, params: unknown) => void;
    getPermissionMode: () => string;
    activeThreadId: string | null;
    debug: (message: string) => void;
  };
  internals.emitAutomationEvent = async (event, input) => { emitted.push({ event, input }); return undefined; };
  internals.debug = () => {};
  internals.getPermissionMode = () => mode;
  return { agent, emitted, internals, destroy: () => agent.destroy() };
}

/** One macrotask, so a detached emission has run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const denied = (emitted: Emitted[]) => emitted.filter(e => e.event === 'PermissionDenied');

/**
 * P6.1073 · every harness here leaves `onPermissionRequest` unset, so EVERY
 * case in this file runs on the unattended path and an inherited value of the
 * escape hatch would silently move the verdicts under the assertions. The
 * shipped default is `deny`; the one case that needs a yes opens the hatch for
 * itself.
 *
 * `delete` rather than an assignment of `undefined`: a name Bun pre-created a
 * slot for stays readable by property and invisible to every spread otherwise
 * (AGENTS.md §Traps).
 */
beforeEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});

describe('P6.579 · codex mints PermissionDenied on Pi’s own two causes', () => {
  it('fires on the dontAsk denial with Pi’s four fields and the card’s own tool name', async () => {
    const h = harness('dontAsk');
    try {
      await h.internals.handleServerRequest('item/commandExecution/requestApproval', {
        command: 'echo hello', cwd: '/tmp/project-root',
      });
      await settle();

      const events = denied(h.emitted);
      expect(events).toHaveLength(1);
      expect(events[0]!.input).toEqual({
        hook_event_name: 'PermissionDenied',
        // `mapCommandApprovalToRequest`'s own name, so the event and the card
        // the user would have seen agree.
        tool_name: 'shell',
        tool_input: { command: 'echo hello', cwd: '/tmp/project-root' },
        permission_mode: 'dontAsk',
        error: 'Denied by the dontAsk permission mode: no permission rule pre-approves this, '
          + 'and the mode never prompts.',
      });
    } finally { h.destroy(); }
  });

  it('fires on codex’s auto-review denial — the judge Pi calls the guardian', async () => {
    const h = harness('default');
    try {
      h.internals.activeThreadId = 'thread-1';
      h.internals.handleNotification('item/autoApprovalReview/completed', {
        threadId: 'thread-1',
        review: { status: 'denied' },
        action: { type: 'command', command: 'rm -rf build', cwd: '/tmp/project-root' },
      });
      await settle();

      const events = denied(h.emitted);
      expect(events).toHaveLength(1);
      expect(events[0]!.input.hook_event_name).toBe('PermissionDenied');
      expect(events[0]!.input.tool_name).toBe('shell');
      expect(events[0]!.input.permission_mode).toBe('default');
      expect(String(events[0]!.input.error)).toContain('Auto-review denied this action');
      expect(String(events[0]!.input.error)).toContain('rm -rf build');
    } finally { h.destroy(); }
  });

  it('names an MCP tool rather than the variant when the review action carries one', async () => {
    const h = harness('default');
    try {
      h.internals.activeThreadId = 'thread-1';
      h.internals.handleNotification('item/autoApprovalReview/completed', {
        threadId: 'thread-1',
        review: { status: 'denied' },
        action: { type: 'mcpToolCall', server: 'gh', toolName: 'create_issue' },
      });
      await settle();
      expect(denied(h.emitted)[0]!.input.tool_name).toBe('mcp__gh__create_issue'); // F1.382 — the host's name
    } finally { h.destroy(); }
  });

  it('stays SILENT on a floor refusal — the exclusion Pi states in its own words', async () => {
    // Pi never fires the event for a floor or an ordinary gate block, so neither
    // may codex: a hook that ran on one runtime and not the other is the
    // divergence this row exists to close, and firing MORE often is one too.
    // The assertion checks the answer really WAS a refusal, so a silent pass
    // cannot come from the call being allowed instead.
    const h = harness('default');
    try {
      const answer = await h.internals.handleServerRequest('item/commandExecution/requestApproval', {
        command: 'rm -rf /', cwd: '/tmp/project-root',
      }) as { decision?: string };
      await settle();
      expect(answer.decision).not.toBe('accept');
      expect(denied(h.emitted)).toHaveLength(0);
    } finally { h.destroy(); }
  });

  it('stays SILENT on an approval that is answered yes', async () => {
    // P6.1073 — THE HATCH IS OPENED HERE so the approval really IS answered yes,
    // and the decision is now asserted rather than assumed.
    //
    // This harness attaches no `onPermissionRequest`, so every case in the file
    // is unattended; P6.531 then put the unattended refusal AHEAD of the
    // `bypassPermissions` mode answer. At the shipped default this call is
    // therefore DECLINED — and no `PermissionDenied` is minted for that refusal
    // either, so the case went on passing while proving nothing about a yes.
    // The sibling below pins the default arm on purpose, so the two verdicts
    // are separable instead of being one silence.
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const h = harness('bypassPermissions');
    try {
      const answer = await h.internals.handleServerRequest('item/commandExecution/requestApproval', {
        command: 'echo hello', cwd: '/tmp/project-root',
      }) as { decision?: string };
      await settle();
      expect(answer.decision).toBe('accept');
      expect(denied(h.emitted)).toHaveLength(0);
    } finally {
      h.destroy();
      delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    }
  });

  it('stays SILENT on the unattended refusal too — it is neither of Pi’s two causes', async () => {
    // P6.1073 / P6.531 · the shipped default, hatch shut. The refusal that made
    // the case above need a hatch must ITSELF be silent: Pi fires the event for
    // `guardianDenied || dont_ask_would_prompt` and "never for floors or
    // ordinary gate blocks", and an unattended-fallback refusal is neither. It
    // is also the arm that proves the case above is not vacuous — same command,
    // same mode, opposite verdict, the hatch the only difference.
    const h = harness('bypassPermissions');
    try {
      const answer = await h.internals.handleServerRequest('item/commandExecution/requestApproval', {
        command: 'echo hello', cwd: '/tmp/project-root',
      }) as { decision?: string };
      await settle();
      expect(answer.decision).toBe('decline');
      expect(denied(h.emitted)).toHaveLength(0);
    } finally { h.destroy(); }
  });
});
