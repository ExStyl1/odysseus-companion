/**
 * P6.207 — the SDK announces that our own bypass has shadowed the permission
 * callback, and until now nothing listened.
 *
 * ## What was wrong
 *
 * `agent-sdk/permissions.md` names two configurations that make `canUseTool`
 * unreachable, and the SDK emits `process.emitWarning(…, { code:
 * 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' })` for both. `process.on('warning'`
 * scored zero files across `packages` and `apps`, so the sentence went to
 * Node's default stderr handler — which a packaged desktop build has no reader
 * for. The runtime was telling us the host gate had been bypassed and nobody
 * heard it.
 *
 * ## What these cases pin
 *
 * The subscriber, the code filter, and the teardown. The code filter is the one
 * to read twice: `process.emitWarning` is a shared channel and Node itself
 * raises `MaxListenersExceededWarning`, `DeprecationWarning` and more on it, so
 * a subscriber that took every warning would put unrelated Node noise into a
 * user's transcript.
 *
 * ## F1.596 — the bypass arm states the DOCUMENTED rule, not the SDK's sentence
 *
 * The SDK's bypass sentence says `canUseTool` "will not be invoked" because the
 * mode "auto-approves every tool call (except explicit deny rules)". Measured on
 * the vendored 2.1.267 (WJ-bb's rig, arm `native-bypass`): with a user-tier ask
 * rule `Bash(ls:*)` the CLI DID call `canUseTool` for `Bash ls` in
 * `bypassPermissions` and our card was raised (origin `claude_native`) — and
 * `permission-modes.md` agrees, so relaying the sentence verbatim told the user
 * less was asked than is. The bypass arm now quotes the page instead; the
 * vendor's words stay in the debug log. The other arm and any shape this file
 * does not know are still relayed verbatim, so a vendor rewording can never
 * silence the warning.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';

function createConfig(sessionSuffix = ''): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: {
      id: 'ws-claude-shadow-warning',
      name: 'Claude Shadow Warning Workspace',
      rootPath: '/tmp/ws-claude-shadow-warning',
      workspaceRootPath: '/tmp/ws-claude-shadow-warning',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-claude-shadow-warning',
    } as never,
    session: {
      id: `session-claude-shadow-warning${sessionSuffix}`, // F1.759 — the permission mode is per session id
      workspaceRootPath: '/tmp/ws-claude-shadow-warning',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'claude-sonnet-4-5',
    isHeadless: true,
  } as BackendConfig;
}

interface Internals { pendingDegradationNotices: string[]; debug: (message: string) => void }

function harness(mode?: Parameters<ClaudeAgent['setPermissionMode']>[0]) {
  const agent = new ClaudeAgent(createConfig(mode ? `-${mode}` : ''));
  if (mode) agent.setPermissionMode(mode); // F1.759
  const internals = agent as unknown as Internals;
  internals.debug = () => {};
  return { agent, internals, destroy: () => agent.destroy() };
}

/** `process.emitWarning` fires on `nextTick`; two macrotasks is generous. */
const settle = async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

/** The SDK's own message for the arm our `bypassPermissions` mapping can reach (vendored `sdk.mjs`, 0.3.267). */
const SDK_BYPASS_MESSAGE = "canUseTool will not be invoked: permissionMode 'bypassPermissions' "
  + 'auto-approves every tool call (except explicit deny rules) before the callback is consulted. '
  + 'To gate every tool call, use a PreToolUse hook instead.';

/** The SDK's message for the bare-`allowedTools` arm (vendored `sdk.mjs`, 0.3.267), for two bare names. */
const SDK_ALLOWED_TOOLS_MESSAGE = 'canUseTool will not be invoked for: Read, Bash. Bare allowedTools entries '
  + 'auto-approve the whole tool before the callback is consulted. To gate every tool call, use a PreToolUse hook; '
  + 'or remove the bare names from allowedTools so they fall through to canUseTool. Allow rules from settings files '
  + 'can also shadow the callback but are not visible here.';

/**
 * F1.596 — the documented rule, VERBATIM as the rendered `permission-modes.md` reads on 2026-09-24: the first two
 * are the opening paragraphs of §"Skip all checks with bypassPermissions mode", the third is the first bullet of
 * §"Actions no mode auto-approves", the fourth is §"Available modes".
 */
const DOC_BYPASS_EXECUTES = 'bypassPermissions mode disables permission prompts and safety checks so tool calls '
  + 'execute immediately, including writes to protected paths.';
const DOC_EXCEPTIONS_STILL_PROMPT = 'The actions no mode auto-approves still prompt in this mode.';
const DOC_ASK_RULE = 'Tools matched by an explicit ask rule';
const DOC_DENY_RULES = 'Deny rules block in every mode, including bypassPermissions.';

/**
 * F1.638 — the lead-in of every non-bypass shape: the claim attributed to Claude Code, and the host gate's standing in
 * the page's own words (`agent-sdk/permissions.md#allow-and-deny-rules`, verbatim as read on 2026-09-25).
 */
const ALLOWED_ARM_LEAD_IN = 'Claude runtime: Claude Code warns that its permission callback is skipped for some calls.';
const DOC_HOOKS_RUN_FIRST = 'hooks run before every other step';

describe('P6.207 · the SDK’s shadowed-callback warning reaches a reader', () => {
  it('turns the warning into exactly one named diagnostic, carrying the vendor’s sentence verbatim', async () => {
    const h = harness();
    try {
      // F1.596: the bare-allowedTools arm — the one whose sentence names tools — is still relayed whole.
      process.emitWarning(SDK_ALLOWED_TOOLS_MESSAGE, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      await settle();

      expect(h.internals.pendingDegradationNotices).toHaveLength(1);
      const notice = h.internals.pendingDegradationNotices[0]!;
      // Named, so the reader knows what it means for THIS product. F1.638: the
      // lead-in used to say "the host permission gate is bypassed for the tools
      // named below", and it was false — WJ-bv measured our PreToolUse gate still
      // raising its card for a bare-`allowedTools` tool, and the page says why.
      expect(notice).toContain(ALLOWED_ARM_LEAD_IN);
      expect(notice).toContain(DOC_HOOKS_RUN_FIRST);
      expect(notice).not.toContain('permission gate is bypassed');
      // …and verbatim, so we are not paraphrasing someone else's behaviour.
      expect(notice).toContain(SDK_ALLOWED_TOOLS_MESSAGE);

      // Latched: a second emission of the same sentence is the same fact.
      process.emitWarning(SDK_ALLOWED_TOOLS_MESSAGE, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      await settle();
      expect(h.internals.pendingDegradationNotices).toHaveLength(1);
    } finally { h.destroy(); }
  });

  it('F1.596 — the bypass arm states the documented rule, and no longer says canUseTool is never asked', async () => {
    const h = harness('bypassPermissions'); // F1.759 — the arm reaches a session in bypass only
    try {
      process.emitWarning(SDK_BYPASS_MESSAGE, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      await settle();

      expect(h.internals.pendingDegradationNotices).toHaveLength(1);
      const notice = h.internals.pendingDegradationNotices[0]!;
      // The page and the section, then its sentences word for word — a quotation, so English by design (C3.331).
      expect(notice).toContain('permission-modes.md');
      expect(notice).toContain('Skip all checks with bypassPermissions mode');
      for (const sentence of [DOC_BYPASS_EXECUTES, DOC_EXCEPTIONS_STILL_PROMPT, DOC_ASK_RULE, DOC_DENY_RULES]) {
        expect(notice).toContain(sentence);
      }
      // The overstatement is gone: measured on 2.1.267, an ask-rule call DOES reach canUseTool in this mode.
      expect(notice).not.toContain('canUseTool will not be invoked');
      expect(notice).not.toContain('auto-approves every tool call');
      expect(notice).not.toContain('the host permission gate is bypassed');

      // Still latched: a second emission is the same fact.
      process.emitWarning(SDK_BYPASS_MESSAGE, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      await settle();
      expect(h.internals.pendingDegradationNotices).toHaveLength(1);
    } finally { h.destroy(); }
  });

  it('F1.596 — a sentence of neither known shape is still relayed verbatim, so a vendor rewording cannot silence it', async () => {
    const h = harness();
    try {
      const reworded = 'canUseTool is shadowed by a configuration this build does not describe yet.';
      process.emitWarning(reworded, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      await settle();
      expect(h.internals.pendingDegradationNotices).toHaveLength(1);
      expect(h.internals.pendingDegradationNotices[0]).toContain(reworded);
      expect(h.internals.pendingDegradationNotices[0]).toContain(ALLOWED_ARM_LEAD_IN);
    } finally { h.destroy(); }
  });

  it('is SILENT for every other warning on the same shared channel — the control', async () => {
    const h = harness();
    try {
      process.emitWarning('an unrelated deprecation', { code: 'DEP0999' });
      process.emitWarning('a warning with no code at all');
      await settle();
      expect(h.internals.pendingDegradationNotices).toEqual([]);
    } finally { h.destroy(); }
  });

  it('drops the subscription with the session, so a destroyed agent stops hearing it', async () => {
    const h = harness();
    h.destroy();
    process.emitWarning(SDK_BYPASS_MESSAGE, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
    await settle();
    expect(h.internals.pendingDegradationNotices).toEqual([]);
  });
});

// F1.759 (origin: the 1.41.0 release sitting, lane SIT-g) — the warning is a PROCESS event that names no session, and the
// listener fanned it to every live claude session: a plan/Manual session received the bypass notice twice, each 4–7 ms
// after a NEW bypass session's own copy. The bypass arm can only be caused by a child launched in bypassPermissions, so
// a session in any other mode ignores it; every other shape still reaches every session (no producer names one).
describe('F1.759 — the bypass notice lands only in a session that is in bypassPermissions', () => {
  it('a plan session and a default session beside a bypass session never get it; the bypass session does', async () => {
    const bypass = harness('bypassPermissions');
    const plan = harness('plan');
    const manual = harness('default');
    try {
      process.emitWarning(SDK_BYPASS_MESSAGE, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      await settle();
      expect(bypass.internals.pendingDegradationNotices).toHaveLength(1);
      expect(plan.internals.pendingDegradationNotices).toEqual([]);
      expect(manual.internals.pendingDegradationNotices).toEqual([]);
    } finally { bypass.destroy(); plan.destroy(); manual.destroy(); }
  });

  it('CONTROL: a shape that is not the bypass arm still reaches a session in any mode', async () => {
    const plan = harness('plan');
    try {
      process.emitWarning(SDK_ALLOWED_TOOLS_MESSAGE, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      await settle();
      expect(plan.internals.pendingDegradationNotices).toHaveLength(1);
    } finally { plan.destroy(); }
  });
});
