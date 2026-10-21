/**
 * RS-31 (P6.1064) — a codex approval frame whose `kind` is NOT `command`: what
 * the card says, and what is refused a durable grant.
 *
 * ## The guard this case is the live arm of
 *
 * `rust-v0.150.1` added `kind: CommandExecutionApprovalKind` to
 * `CommandExecutionRequestApprovalParams` — `"command" | "writeStdin"`,
 * documented *"Distinguishes a command approval from input sent to an existing
 * terminal"*, with *"Defaults to `command` for older servers"*. P7.2
 * (`4ea562c6e`) built the half that cannot be wrong: a non-`command` frame is
 * DESCRIBED as what it is (*"Send input to the running terminal — started by:
 * <command>"*) instead of as *"Run: <command>"*, and it is refused a durable
 * grant twice over — `noAlwaysAllow` on the card, and `null` out of
 * `execpolicyAmendmentForApproval`, so the two cannot drift apart. The
 * allow/deny decision itself is untouched: the frame still goes to the user.
 *
 * That commit says, in as many words, that it is UNMEASURED. This is the case
 * that would measure it.
 *
 * ## IT CANNOT DRIVE TODAY, and the reason is a reading rather than a guess
 *
 * Read at `rust-v0.150.1`, the shipped binary cannot produce the frame:
 *
 *  - `codex-rs/app-server/src/bespoke_event_handling.rs` builds the params with
 *    `kind: kind.into()`, forwarding the core event's own kind unchanged;
 *  - `ExecApprovalRequestEvent` is constructed in exactly ONE production site,
 *    `codex-rs/core/src/session/mod.rs`, and that site writes
 *    `kind: ExecApprovalKind::Command` as a literal;
 *  - `ExecApprovalKind::WriteStdin` is constructed NOWHERE in `codex-rs` at that
 *    tag — zero occurrences outside the enum's own declaration in
 *    `codex-rs/protocol/src/approvals.rs`.
 *
 * So the enum member is in the wire contract and is reachable by no code path we
 * ship. `4ea562c6e` is a forward guard, which is the correct shape for a field
 * upstream tells clients to read, and this file is its standing measurement
 * order rather than a run to schedule. It is a RECIPE, and therefore deliberately
 * absent from `run.ts`'s `SITTING` list — `runOne` reads a `##CDP-RESULT##` line
 * and would score a recipe FAIL for never having been meant to run.
 *
 * ## The precondition, and how to check it in one command
 *
 * Re-derive the three readings above against whatever tag is then pinned in
 * `packages/codex-protocol/manifest.json` before spending a sitting on this:
 *
 * ```sh
 * # from a checkout or tarball of openai/codex at the PINNED tag
 * grep -rn 'ExecApprovalKind::WriteStdin' codex-rs | grep -v '/tests/'
 * ```
 *
 * A non-empty answer is the moment this case becomes drivable, and the file that
 * answers names the path that produces it — which is also the shortest route to
 * a prompt that provokes one. An empty answer means a run here can only re-prove
 * what the source already says, and the honest outcome is to re-stamp this
 * docblock with the new tag rather than spend a turn.
 *
 * ## The SECOND precondition, which is the one a run is most likely to trip over
 *
 * P7.2 finding #1: with the sandbox master switch OFF — the owner's standing
 * default — no public codex `approval_policy` routes an ordinary command to our
 * approval bridge at all (`codex-rs/core/src/exec_policy.rs` answers `Allow` for
 * `Never`, `OnRequest` and `Granular(_)` under an unrestricted sandbox, and
 * `Prompt` only for the retired `UnlessTrusted`). So "no card appeared" has a
 * cause that has nothing to do with `kind`, and the positive control below is
 * what separates them: an ORDINARY command approval must be obtained first, in
 * the same sitting, or this case is measuring the approval routing.
 *
 * ## What the run scores, once it is possible
 *
 * Three things, and none of them is the model's prose:
 *
 *  1. the card's own description names the ACT — input sent to a terminal —
 *     rather than the command that started it;
 *  2. the card offers no Always Allow (`noAlwaysAllow`), which is the affordance
 *     whose presence would let a user consent to the wrong thing;
 *  3. the codex config the host writes gains NO execpolicy prefix for that
 *     command afterwards — the durable half, and the only one that outlives the
 *     session.
 *
 * (3) is the reading that matters most and the one a screen cannot give: a card
 * that merely LOOKS right while an amendment lands is exactly the failure
 * `4ea562c6e` split across two layers to prevent.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-31'
const TITLE = 'a codex approval whose kind is not a command: what the card says, and what stays ungranted'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.1064',
  runtimes: ['codex'],
  credentials:
    'owner: a codex-runtime card, already signed in, on a PACKAGED build. No key is read and none is '
    + 'written. The turns act in a scratch directory the operator creates and removes.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. CHECK THE PRECONDITION FIRST, before booking a sitting. Against a checkout of openai/codex at the '
    + 'tag pinned in `packages/codex-protocol/manifest.json`: `grep -rn \'ExecApprovalKind::WriteStdin\' '
    + 'codex-rs | grep -v \'/tests/\'`. An EMPTY answer means the binary cannot produce the frame and this '
    + 'case is not runnable — re-stamp its docblock with the new tag and stop. A non-empty answer names the '
    + 'path that produces it, which is where step 4\'s prompt comes from.',
    '2. PACKAGED build, dark theme, one content panel. New session on the codex card, in a scratch working '
    + 'directory you created for this run.',
    '3. THE POSITIVE CONTROL, and it is required: obtain an ORDINARY command approval card in this same '
    + 'session — ask for work that raises one, and record that it appeared. If it does not, STOP: with the '
    + 'sandbox off no codex approval reaches our bridge at all (P7.2 finding #1), and everything below would '
    + 'measure the approval routing rather than the frame\'s kind. Record which sandbox position was in force.',
    '4. Provoke a stdin write: start a process that reads from its own stdin and does not exit (the path '
    + 'found in step 1 says which surface produces the approval — a background terminal the model then types '
    + 'into), then ask the model to send input to it.',
    '5. Read the card WITHOUT touching it yet. Record its description text verbatim, and whether an Always '
    + 'Allow affordance is offered at all. The description must name sending input to the running terminal; '
    + 'a card reading "Run: <command>" is the defect `4ea562c6e` exists to prevent and it reopens that row.',
    '6. ANSWER IT ALLOW — deliberately, because the durable half can only be read after a yes.',
    '7. Read the codex config the host writes for this session and confirm NO execpolicy prefix was added '
    + 'for that command. This is the reading that outlives the session and the one the screen cannot give.',
    '8. Write PASS/FAIL with the card text quoted, a note of the sandbox position, and a narrative under '
    + '`docs/testing/cdp-runs/`. On FAIL, P7.2\'s `4ea562c6e` reopens — say which of the three readings failed.',
  ],
  expected:
    'a card whose description names sending input to the running terminal (never "Run: <command>"), with no '
    + 'Always Allow offered, and — after an explicit allow — no new execpolicy prefix for that command in '
    + 'the codex config the host wrote. The ordinary-approval control green in the same session.',
  detector:
    'the approval request the backend holds, not the screen: the card\'s own `description` and the presence '
    + 'or absence of the Always Allow affordance, read through `snapshot.security.pendingPermissions` the way '
    + '`RS-26` reads it — a card the renderer left up and a genuinely pending request look identical on '
    + 'screen. For the durable half, the codex config file the host writes for the session, compared before '
    + 'and after. The model saying it sent input is NOT evidence of anything scored here.',
  positiveControl:
    'an ORDINARY command approval card obtained in the same session before the probe. Without it, an absent '
    + 'or odd card measures whether any approval reaches our bridge at all — which with the sandbox off is a '
    + 'known and separate answer — rather than what the frame\'s kind did.',
  runOnlyIf:
    '`ExecApprovalKind::WriteStdin` is constructed somewhere in `codex-rs` at the pinned tag, outside tests. '
    + 'At `rust-v0.150.1` it is constructed nowhere: the single production site that builds an '
    + '`ExecApprovalRequestEvent` writes `kind: ExecApprovalKind::Command` as a literal, and the app-server '
    + 'forwards it unchanged. Until that changes the frame cannot exist and a run can only re-prove the source.',
  doNotConflate:
    'three different reasons for "no stdin card appeared", and only the third is a finding about this guard: '
    + '(a) the binary produces no `writeStdin` kind at all — the measured state at `rust-v0.150.1`, settled '
    + 'by the step-1 grep rather than by a turn; (b) the sandbox is off, so NO approval reaches our bridge — '
    + 'settled by the step-3 control; (c) the frame arrived and our bridge mishandled it, which is the only '
    + 'one that touches `4ea562c6e`.',
  safety:
    'the process started in step 4 reads stdin and does not exit on its own — kill it and close the terminal '
    + 'before ending the session, and run the turns in a scratch directory rather than a real project. '
    + 'Step 6 answers ALLOW on purpose; do it in that scratch directory and nowhere else.',
  doneMeans:
    'either the precondition re-checked at the then-pinned tag and recorded as still false — which closes '
    + 'P6.1064 as a standing order with a dated reading, not as a pass — or one driven codex session with '
    + 'the three readings recorded, the case added to `docs/testing/cdp-live-checklist.md` with PASS/FAIL on '
    + 'the packaged build, and P7.2\'s unmeasured clause retired.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
