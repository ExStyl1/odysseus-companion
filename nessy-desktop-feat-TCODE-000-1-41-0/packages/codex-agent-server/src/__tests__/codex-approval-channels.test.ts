/**
 * P2.407 — three codex approval channels that arrived and were read partially or
 * not at all.
 *
 * (a) The event adapter consumes `item/autoApprovalReview/{started,completed}`
 *     and reads `review` — the verdict — never `action`, the subject. A guardian
 *     denial therefore changed a permission outcome and left behind a sentence
 *     naming nothing.
 * (b) `networkApprovalContext` and (c) `proposedNetworkPolicyAmendments` on
 *     `CommandExecutionRequestApprovalParams` were consumed in ZERO files.
 *
 * ## Evidence, and the tier it belongs in
 *
 * The SHAPES are strong: `packages/codex-protocol/generated/v2/` is ts-rs output
 * generated from the codex source at `rust-v0.148.0`, the tag shipped when this
 * was read (today's is `manifest.json`'s `upstream.tag`), and every field below
 * is string-probed present in the shipped
 * artifact `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` —
 * `networkApprovalContext` 2, `proposedNetworkPolicyAmendments` 2,
 * `applyNetworkPolicyAmendment` 3, `socks5Tcp`/`socks5Udp` 2 each, against
 * `zzz_not_a_real_field` = 0 as the negative control.
 *
 * The ARRIVAL of (b) and (c) is UNMEASURED. Every frame carrying them needs
 * codex's managed network proxy running, and P2.384 pinned `network_proxy`
 * unwritten — enabling it to obtain a live sample is exactly what this lane is
 * forbidden to do. So these payloads are built from the generated types, and
 * that is said out loud rather than dressed up as a capture. (a)'s payload is
 * likewise built from the type: auto-review is setting-gated and off by default.
 *
 * ## The zeros, re-verified here with their controls
 *
 * `git grep` outside `packages/codex-protocol` and `docs`, on this tree:
 * `proposedNetworkPolicyAmendments` 0 hits; `networkApprovalContext` exactly 1,
 * and that one is P2.384's own docblock recording the zero;
 * `GuardianApprovalReviewAction` exactly 1, likewise a docblock. Positive
 * controls on the same rig, sibling fields of the same params object:
 * `proposedExecpolicyAmendment` 3 files, `commandActions` 2, `environmentId` 3.
 */
import { describe, expect, test } from 'bun:test';
import {
  CODEX_STRICT_REVIEW_REQUIRED_METHOD,
  buildApprovalResponse,
  describeGuardianReviewAction,
  describeNetworkApprovalContext,
  describeStrictReviewRequired,
  isApprovalMethod,
  execpolicyAmendmentForApproval,
  mapCommandApprovalToRequest,
  readNetworkApprovalContext,
  readProposedNetworkPolicyAmendments,
} from '../approval-bridge.ts';

// ============================================================
// (b) networkApprovalContext
// ============================================================

/**
 * The managed-network variant: a host, a protocol, and — per the generated
 * type's own docstring for `reason` ("e.g. request for network access") — no
 * command at all.
 */
const NETWORK_ONLY = {
  threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 0, environmentId: null,
  reason: 'request for network access',
  networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
};

/** The same, with a command beside it — the fields are independent optionals. */
const NETWORK_WITH_COMMAND = {
  ...NETWORK_ONLY,
  command: 'curl https://registry.npmjs.org/left-pad',
  proposedExecpolicyAmendment: ['curl'],
  proposedNetworkPolicyAmendments: [
    { host: 'registry.npmjs.org', action: 'allow' },
    { host: 'evil.example', action: 'deny' },
  ],
};

/** An ordinary command approval — the ONLY kind this build can currently receive. */
const PLAIN_COMMAND = {
  threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 0, environmentId: null,
  command: 'ls -la', cwd: '/repo', reason: 'needs escalation',
  proposedExecpolicyAmendment: ['ls'],
};

describe('networkApprovalContext', () => {
  /** KILLS: not reading the field at all, which is the state this row found. */
  test('is read off the params codex sends', () => {
    expect(readNetworkApprovalContext(NETWORK_ONLY))
      .toEqual({ host: 'registry.npmjs.org', protocol: 'https' });
    expect(describeNetworkApprovalContext(NETWORK_ONLY)).toBe('registry.npmjs.org over https');
  });

  /** KILLS: inventing a protocol, or dropping the host when the protocol is absent. */
  test('degrades to the bare host when the protocol is missing, and never invents a port', () => {
    expect(describeNetworkApprovalContext({ networkApprovalContext: { host: 'example.com' } }))
      .toBe('example.com');
    expect(describeNetworkApprovalContext(NETWORK_ONLY)).not.toContain(':');
  });

  /**
   * NEGATIVE CONTROL. Without it, "the card names the host" is satisfiable by a
   * card that names something on every approval, which would be a regression on
   * the only path this build actually runs.
   */
  test('is null for an ordinary command approval and for junk', () => {
    for (const params of [PLAIN_COMMAND, {}, null, undefined, { networkApprovalContext: {} }, 'nope']) {
      expect(readNetworkApprovalContext(params)).toBeNull();
      expect(describeNetworkApprovalContext(params)).toBeNull();
    }
  });
});

describe('the command approval card', () => {
  /**
   * THE CONSENT DEFECT THIS ROW FIXES. A managed-network approval with no
   * command rendered as `Run a command` — a Yes/No on something invisible.
   *
   * KILLS: reverting the card to the command-only description.
   */
  test('names the host when the approval is about reaching one', () => {
    const req = mapCommandApprovalToRequest('r1', NETWORK_ONLY as never);
    expect(req.description).toContain('registry.npmjs.org');
    expect(req.description).toContain('https');
    expect(req.description).not.toBe('Run a command');
    expect(req.command).toBe('registry.npmjs.org over https');
    // Nothing can honour an Always Allow scoped to one host here; the button
    // must not promise it.
    expect(req.noAlwaysAllow).toBe(true);
  });

  /** KILLS: showing the host and losing the command the user also needs to see. */
  test('shows the host AND the command when both are present', () => {
    const req = mapCommandApprovalToRequest('r2', NETWORK_WITH_COMMAND as never);
    expect(req.description).toContain('registry.npmjs.org');
    expect(req.description).toContain('curl https://registry.npmjs.org/left-pad');
  });

  /**
   * REGRESSION FLOOR on the only path this build runs today: an ordinary command
   * approval must be byte-identical to what it was before this row.
   */
  test('is unchanged for an ordinary command approval', () => {
    expect(mapCommandApprovalToRequest('r3', PLAIN_COMMAND as never)).toEqual({
      requestId: 'r3',
      toolName: 'shell',
      command: 'ls -la',
      description: 'Run: ls -la',
      reason: 'needs escalation',
    });
  });

  /**
   * P7.2 — `CommandExecutionApprovalKind`, new at `rust-v0.150.1` (#40528).
   *
   * The hazard is not that a stdin approval is unhandled; it is that it is
   * handled AS A COMMAND. The frame arrives on the same method with the same
   * fields, and `command` then carries the command that STARTED the terminal —
   * so the card would read "Run: <command>" about an act that is typing into a
   * process already running, and an Always Allow would mint a durable
   * command-prefix rule off a consent to something else. Plausible and wrong.
   *
   * Three arms plus the older-server default, because the default is the half
   * that must not regress.
   */
  test('a writeStdin approval is described as terminal input and mints no durable grant', () => {
    const stdin = { ...PLAIN_COMMAND, kind: 'writeStdin' };
    expect(mapCommandApprovalToRequest('r4', stdin as never)).toEqual({
      requestId: 'r4',
      toolName: 'shell',
      command: 'ls -la',
      description: 'Send input to the running terminal — started by: ls -la',
      reason: 'needs escalation',
      noAlwaysAllow: true,
    });
    // With no command on the frame the sentence still names the act.
    expect(mapCommandApprovalToRequest('r5', { kind: 'writeStdin' } as never).description)
      .toBe('Send input to the running terminal');
  });

  test('an unrecognised kind is named rather than described as a command', () => {
    // FORWARD-SAFE: a third member added upstream must not inherit the command
    // sentence. It is still put to the user — refusing outright would break a
    // session on a field we do not understand — but it cannot be made durable.
    const req = mapCommandApprovalToRequest('r6', { ...PLAIN_COMMAND, kind: 'nessyNotAKind' } as never);
    expect(req.description).toBe(
      'Approve a codex action of an unrecognised kind ("nessyNotAKind") — related command: ls -la',
    );
    expect(req.noAlwaysAllow).toBe(true);
  });

  test('POSITIVE CONTROL: an absent kind is the older-server default and changes nothing', () => {
    // The field's own doc: "Defaults to `command` for older servers." An
    // explicit `kind: "command"` and an absent one must produce the same object,
    // and neither may carry `noAlwaysAllow`.
    const absent = mapCommandApprovalToRequest('r7', PLAIN_COMMAND as never);
    const explicit = mapCommandApprovalToRequest('r7', { ...PLAIN_COMMAND, kind: 'command' } as never);
    expect(explicit).toEqual(absent);
    expect(absent.noAlwaysAllow).toBeUndefined();
  });
});

// ============================================================
// (c) proposedNetworkPolicyAmendments
// ============================================================

describe('proposedNetworkPolicyAmendments', () => {
  /** KILLS: not reading the field at all — its state before this row. */
  test('are read and normalised', () => {
    expect(readProposedNetworkPolicyAmendments(NETWORK_WITH_COMMAND)).toEqual([
      { host: 'registry.npmjs.org', action: 'allow' },
      { host: 'evil.example', action: 'deny' },
    ]);
  });

  /**
   * KILLS: coercing an unrecognised action. `NetworkPolicyRuleAction` is
   * `"allow" | "deny"`, and guessing which way a third value points is the one
   * mistake an egress rule must not make — so an unreadable entry is dropped,
   * not defaulted.
   */
  test('drop an entry whose action is not one of the two, and bound the list', () => {
    expect(readProposedNetworkPolicyAmendments({
      proposedNetworkPolicyAmendments: [
        { host: 'a.example', action: 'allow' },
        { host: 'b.example', action: 'maybe' },
        { host: '', action: 'deny' },
        { action: 'deny' },
        'nope',
      ],
    })).toEqual([{ host: 'a.example', action: 'allow' }]);
    expect(readProposedNetworkPolicyAmendments({
      proposedNetworkPolicyAmendments: Array.from({ length: 40 }, (_, i) => ({ host: `h${i}`, action: 'deny' })),
    })).toHaveLength(16);
  });

  /** NEGATIVE CONTROL: nothing proposed, nothing invented. */
  test('are empty for an ordinary approval and for junk', () => {
    for (const params of [PLAIN_COMMAND, {}, null, undefined, 'nope']) {
      expect(readProposedNetworkPolicyAmendments(params)).toEqual([]);
    }
  });
});

describe('a host-scoped consent must not mint a command-scoped rule', () => {
  /**
   * THE OVER-GRANT THIS ROW CLOSES, and the reason (b) is worth reading beyond
   * the card. `networkApprovalContext` and `proposedExecpolicyAmendment` are
   * independent optionals on one params object, so a managed-network approval
   * can carry both — and persisting the execpolicy prefix off it would durably
   * allow `curl` ANYWHERE on the strength of a user agreeing to reach one host.
   * Silent, durable, and in the widening direction.
   *
   * KILLS: dropping the `readNetworkApprovalContext` guard from
   * `execpolicyAmendmentForApproval`.
   */
  test('an Always Allow on a network approval persists nothing', () => {
    expect(execpolicyAmendmentForApproval('command', NETWORK_WITH_COMMAND)).toBeNull();
  });

  /**
   * POSITIVE CONTROL on the same rig: the guard must not have turned the whole
   * function off. An ordinary command approval still persists its prefix.
   */
  test('POSITIVE CONTROL: an ordinary command approval still persists its prefix', () => {
    expect(execpolicyAmendmentForApproval('command', PLAIN_COMMAND)).toEqual(['ls']);
    expect(execpolicyAmendmentForApproval('commandV1', { command: ['git', 'status'] })).toEqual(['git', 'status']);
  });

  /**
   * P7.2 — the same refusal one layer down, so the card and the durable write
   * cannot drift apart. The card sets `noAlwaysAllow` for a non-`command`
   * `CommandExecutionApprovalKind`; this is what runs if anything ever reaches
   * the amendment without going through the card.
   */
  test('a non-command approval kind persists nothing, whatever the frame carries', () => {
    const stdin = { ...PLAIN_COMMAND, kind: 'writeStdin' };
    expect(execpolicyAmendmentForApproval('command', stdin)).toBeNull();
    expect(execpolicyAmendmentForApproval('command', { ...PLAIN_COMMAND, kind: 'nessyNotAKind' })).toBeNull();
    // The control that proves the guard reads `kind` and not something else: the
    // identical frame with the documented older-server default still persists.
    expect(execpolicyAmendmentForApproval('command', { ...PLAIN_COMMAND, kind: 'command' })).toEqual(['ls']);
  });
});

// ============================================================
// (a) GuardianApprovalReviewAction — the subject of an auto-review
// ============================================================

describe('describeGuardianReviewAction', () => {
  /**
   * All six variants of the union, at `rust-v0.148.0`. `networkAccess` is the one
   * P2.384 singled out as unconsumed; it is covered here WITH the other five,
   * because a describer that knew one variant would leave the rest in the same
   * silence one row later.
   *
   * KILLS: handling only the variant a single sample happened to carry.
   */
  test('names every variant of the union', () => {
    expect(describeGuardianReviewAction({
      type: 'command', source: 'shell', command: 'rm -rf build', cwd: '/repo',
    })).toBe('run `rm -rf build` in /repo');

    expect(describeGuardianReviewAction({
      type: 'execve', source: 'shell', program: '/bin/sh', argv: ['-c', 'echo hi'], cwd: '/repo',
    })).toBe('execute `/bin/sh -c echo hi` in /repo');

    expect(describeGuardianReviewAction({
      type: 'applyPatch', cwd: '/repo', files: ['/repo/a.ts', '/repo/b.ts'],
    })).toBe('patch /repo/a.ts, /repo/b.ts');

    // F1.724 — the measured misname: one file outside the turn's folder was reported "under" that folder.
    expect(describeGuardianReviewAction({ type: 'applyPatch', cwd: '/proj', files: ['/other/x.txt'] }))
      .toBe('patch /other/x.txt');
    expect(describeGuardianReviewAction({ type: 'applyPatch', cwd: '/r', files: ['/r/a', '/r/b', '/r/c', '/r/d', '/r/e'] }))
      .toBe('patch /r/a, /r/b, /r/c and 2 more files');
    expect(describeGuardianReviewAction({ type: 'applyPatch', cwd: '/r', files: [] })).toBe('patch files in /r');

    expect(describeGuardianReviewAction({
      type: 'networkAccess', target: 'api', host: 'api.example.com', protocol: 'https', port: 443,
    })).toBe('reach api.example.com:443 over https');

    expect(describeGuardianReviewAction({
      type: 'mcpToolCall', server: 'github', toolName: 'create_issue',
      connectorId: null, connectorName: null, toolTitle: null,
    })).toBe('call MCP tool github/create_issue');

    expect(describeGuardianReviewAction({
      type: 'requestPermissions', reason: 'install deps', permissions: { network: { enabled: true } },
    })).toBe("widen this turn's permissions (network access) — install deps");
  });

  /**
   * KILLS: a describer that returns an empty string on a variant it does not
   * know — the exact silence this function exists to end, reintroduced one
   * binary version later.
   */
  test('still names an unknown future variant', () => {
    expect(describeGuardianReviewAction({ type: 'somethingNew', detail: 'x' })).toBe('somethingNew');
  });

  /** KILLS: a throw on the notification path, and a name conjured from nothing. */
  test('is null when there is no readable action, and never throws', () => {
    for (const action of [undefined, null, {}, 'nope', 42, { type: '' }, []]) {
      expect(describeGuardianReviewAction(action)).toBeNull();
    }
  });

  /** KILLS: dropping the bounds, i.e. letting a payload put a paragraph in a log line. */
  test('bounds what it will render', () => {
    const described = describeGuardianReviewAction({
      type: 'command', command: 'x'.repeat(5_000), cwd: '/y'.repeat(500),
    })!;
    expect(described.length).toBeLessThan(420);
    expect(described).toContain('…');
  });
});

// ============================================================
// P2.418 — the fourth field, and why it stays unread
// ============================================================

/**
 * `approvalId` exists to stop a routing collision: for zsh-exec-bridge
 * subcommand approvals, MULTIPLE CALLBACKS BELONG TO ONE PARENT `itemId`, and
 * `approvalId` is the distinct callback id "used to disambiguate routing". The
 * row asked whether that collision is reachable HERE before deciding to key on
 * it. It is not — the full measurement, its evidence tiers and its two residues
 * are on `CommandApprovalParams.itemId` — and these two tests are what keep the
 * answer true, because both reasons that live in this module are one edit from
 * being untrue.
 *
 * (The third reason is `CodexAgent`'s `randomUUID()` per server request, which
 * is not this module's to pin.)
 */
describe('P2.418 · approvalId is the server\'s routing key, not ours', () => {
  const parent = (approvalId: string, command: string) => ({
    threadId: 't', turnId: 'u',
    // The whole hazard in one line: ONE parent item, two callbacks.
    itemId: 'call-zsh-fork-parent',
    startedAtMs: 0, environmentId: null, approvalId, command, cwd: '/repo',
  });

  /**
   * KILLS: deriving a card's identity from `itemId` (or from `approvalId`).
   * Two callbacks of one parent must produce two independently answerable cards,
   * distinguished ONLY by the requestId the caller minted — and neither routing
   * id may leak onto the card, where it would become a second thing to key on.
   */
  test('two callbacks under one itemId map to two cards keyed only by the caller\'s requestId', () => {
    const first = mapCommandApprovalToRequest('nessy-req-1', parent('uuid-a', 'npm ci'));
    const second = mapCommandApprovalToRequest('nessy-req-2', parent('uuid-b', 'npm run build'));

    expect(first.requestId).toBe('nessy-req-1');
    expect(second.requestId).toBe('nessy-req-2');
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.command).toBe('npm ci');
    expect(second.command).toBe('npm run build');

    // Neither routing id appears anywhere on either card.
    for (const card of [first, second]) {
      const rendered = JSON.stringify(card);
      expect(rendered).not.toContain('call-zsh-fork-parent');
      expect(rendered).not.toContain('uuid-a');
      expect(rendered).not.toContain('uuid-b');
    }
  });

  /**
   * KILLS: echoing a routing key back on the answer.
   * `CommandExecutionRequestApprovalResponse = { decision }` at rust-v0.148.0 —
   * there is nowhere to put `approvalId`, and a response that grew one would be
   * inventing a wire field. Both polarities, because a key added on only one
   * branch is the shape that survives a single-case test.
   */
  test('a command approval answers with the decision alone, whatever the params carried', () => {
    for (const allowed of [true, false]) {
      const answer = buildApprovalResponse('command', parent('uuid-a', 'npm ci'), allowed);
      expect(Object.keys(answer)).toEqual(['decision']);
    }
  });
});

// ============================================================
// P6.1065 · the strict review codex's own reviewer demands
// ============================================================

/**
 * The frame is `StrictReviewRequiredNotification` — `{ threadId, turnId,
 * startedAtMs }` and nothing else — so these cases pin the two things a host
 * can honestly say (that strict review was demanded, and when the review
 * started) and the two it must refuse to say (a sentence about no turn, and a
 * timestamp it did not receive).
 */
describe('describeStrictReviewRequired', () => {
  const FRAME = { threadId: 't', turnId: 'u', startedAtMs: 1_757_000_000_000 };

  test('names the turn and the moment the review started', () => {
    expect(describeStrictReviewRequired(FRAME)).toBe(
      'Auto-review requires a strict review of this turn'
      + ' (review started 2025-09-04T15:33:20.000Z).'
      + " The runtime's own reviewer could not approve from its cached assessment.",
    );
  });

  /**
   * KILLS: inventing a timestamp. A frame from a future binary that drops
   * `startedAtMs`, or sends it as a string, still gets the demand — the part
   * that matters for safety — and simply does not get a parenthetical.
   */
  test('keeps the demand and drops the parenthetical when the moment is unreadable', () => {
    const expected = 'Auto-review requires a strict review of this turn.'
      + " The runtime's own reviewer could not approve from its cached assessment.";
    expect(describeStrictReviewRequired({ threadId: 't', turnId: 'u' })).toBe(expected);
    expect(describeStrictReviewRequired({ threadId: 't', turnId: 'u', startedAtMs: 'soon' })).toBe(expected);
    expect(describeStrictReviewRequired({ threadId: 't', turnId: 'u', startedAtMs: Number.NaN })).toBe(expected);
  });

  /** KILLS: a sentence about a turn the frame never named, and a non-frame. */
  test('refuses a frame that names no turn', () => {
    expect(describeStrictReviewRequired({ threadId: 't', startedAtMs: 1 })).toBeNull();
    expect(describeStrictReviewRequired({ threadId: 't', turnId: '  ' })).toBeNull();
    expect(describeStrictReviewRequired(null)).toBeNull();
    expect(describeStrictReviewRequired('autoApprovalReview/strictReviewRequired')).toBeNull();
  });

  /**
   * It is a NOTIFICATION, not an approval. Nothing answers it, so admitting it
   * to `isApprovalMethod` would make `handleServerRequest` try to build a
   * response for a frame that expects none.
   */
  test('the method is not an approval method', () => {
    expect(isApprovalMethod(CODEX_STRICT_REVIEW_REQUIRED_METHOD)).toBe(false);
    expect(CODEX_STRICT_REVIEW_REQUIRED_METHOD).toBe('autoApprovalReview/strictReviewRequired');
  });
});
