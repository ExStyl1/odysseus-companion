/**
 * I2.15 — the ALLOW path reads `CommandExecutionApprovalKind`, which the card
 * and the durable-grant paths already do.
 *
 * ## What P7.2 closed, and the one half it did not
 *
 * `rust-v0.150.1` gave `CommandExecutionRequestApprovalParams` a `kind` field
 * (`"command" | "writeStdin"`, re-read at `rust-v0.154.0` from
 * `packages/codex-protocol/generated/v2/CommandExecutionApprovalKind.ts`), whose
 * own generated doc says *"Kind of action under review. Defaults to `command`
 * for older servers"*. P7.2 taught TWO layers to read it:
 *
 *  - `mapCommandApprovalToRequest` names the act on the card (*"Send input to
 *    the running terminal"*) and sets `noAlwaysAllow` for any non-`command`
 *    kind;
 *  - `execpolicyAmendmentForApproval` returns `null` for one, so no durable
 *    command-prefix rule is minted from an act that is not running a command.
 *
 * The THIRD layer answers before either of them runs. `approvalKindForMethod`
 * maps `item/commandExecution/requestApproval` to the host `ApprovalKind`
 * `'command'` for every frame on that method — `params.kind` is not consulted
 * there and should not be, since it is the wire kind and not the method — and
 * `CodexAgent.consultPermissionRules` reaches `codexApprovalRuleRequests` with
 * that value. A `writeStdin` frame carries `command` as the command that
 * STARTED the terminal, so the projection emitted `Bash(<that command>)` and a
 * user rule written for the command silently approved sending arbitrary input
 * into the process it started — with no card, because the rule consult returns
 * above the card.
 *
 * That is the widening direction, it is silent, and it needs no durable grant
 * and no unattended session to happen: one ordinary `allow:` rule is enough.
 *
 * ## Why `[]` rather than a `writeStdin` rule vocabulary
 *
 * `[]` is this function's own documented "unmatched → ask the user" answer, and
 * its docblock already lists three kinds that take it for the same reason: a
 * request we cannot render faithfully goes to the human. There is no rule form
 * that speaks about stdin — inventing `Stdin(...)` would be a mechanism where
 * the documentation is silent, and it would be a mechanism that can only WIDEN.
 * The FLOOR projection (`codexApprovalFloorSubjects`) is deliberately left
 * untouched: it may only tighten, so a wider rendering there is safe by
 * construction.
 */
import { describe, expect, it } from 'bun:test';
import { codexApprovalRuleRequests } from '../codex-agent.ts';

const CWD = '/tmp/project-root';

describe('I2.15 — a non-`command` approval kind never reaches the allow path', () => {
  /**
   * The control that proves the probe can see: an ordinary frame, and a frame
   * that spells the default explicitly, both still project the `Bash` request a
   * user rule is written against. Without this the negative below is satisfied
   * by a projection that answers `[]` for everything.
   */
  it('POSITIVE — an ordinary command frame still projects its Bash rule request', () => {
    const implicit = codexApprovalRuleRequests('command', { command: 'npm test' }, CWD);
    const explicit = codexApprovalRuleRequests('command', { command: 'npm test', kind: 'command' }, CWD);

    expect(implicit).toEqual([{ toolName: 'Bash', semanticId: 'bash', input: { command: 'npm test' }, cwd: CWD }]);
    // An absent `kind` IS `command` — the field's own generated doc says so for
    // older servers, and the two must not diverge.
    expect(explicit).toEqual(implicit);
  });

  it('NEGATIVE — a writeStdin frame projects nothing, so no Bash rule can answer it', () => {
    // The frame as the app-server sends it: `command` is what STARTED the
    // terminal, which is exactly why it is plausible and wrong.
    const requests = codexApprovalRuleRequests(
      'command',
      { command: 'npm test', kind: 'writeStdin', approvalId: 'cb-1', processId: 'proc-1', stdin: 'rm -rf /\n' },
      CWD,
    );

    expect(requests).toEqual([]);
  });

  it('NEGATIVE — an unrecognised kind takes the same refusal, so a third member is safe on arrival', () => {
    expect(codexApprovalRuleRequests('command', { command: 'npm test', kind: 'nessyNotAKind' }, CWD)).toEqual([]);
  });
});
