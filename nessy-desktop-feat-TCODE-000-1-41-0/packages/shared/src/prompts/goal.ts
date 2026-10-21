/**
 * P6.322 half 2 (ledger H50) · the goal INTERVIEW macro.
 *
 * ## What the row asked for, and what was actually missing
 *
 * `done_means` (2): *"`/plan` interviews the user about constraints and turns
 * the answers into a goal carrying a measurable `condition`."* The native
 * mechanism recorded on the cell is verbatim: *"none reachable — codex's
 * `/plan` is a TUI slash command and we drive the app-server, not the TUI;
 * host-side `GoalService` already takes a `condition`, so what is missing is
 * the interview that produces one."* So the goal machinery is complete — the
 * `Goal` tool (`session-tools-core/tool-defs.ts`) takes `action: 'create'` with
 * a `condition` and optional `budgets`, and P2.2 removed its `pi-only`
 * visibility so it reaches Pi, claude and codex alike. The gap was the front
 * door.
 *
 * ## Mechanism: a PROMPT MACRO, the exact `/init` and `/create-skill` precedent
 *
 * The command expands this constant into an ordinary user message. The agent
 * interviews the user and then creates the goal through the tool it already
 * has, under the permission gate it already passes. No new tool, no new RPC, no
 * elevated access — and no per-runtime code, which is what makes the answer the
 * same on all three by construction rather than by three implementations that
 * agree today.
 *
 * ## Two decisions where the documentation is silent, both stated rather than hidden
 *
 * **1. The command is `/goal`, not `/plan`, and this is a MEASURED collision,
 * not a preference.** `plan` is a `PermissionMode`
 * (`agent/mode-types.ts:38`), every `PermissionMode` is a `SlashCommandId`
 * (`slash-command-menu.tsx`), and `dispatchSlashCommandAction` routes a mode id
 * to `onPermissionModeChange` in a branch that runs BEFORE the message-command
 * table. A second `/plan` meaning would therefore be unreachable by
 * construction — and even reachable it would give one name two behaviours in
 * one composer, which is the confusion this plan keeps removing. `/goal` names
 * what the command produces and the host service that owns it
 * (`server-core/pi-harness/goal-service.ts`), and it was free: `git grep` for
 * the literal over `packages` + `apps` returned nothing. If the owner wants the
 * name re-pointed, this constant and two rows move; nothing else does.
 *
 * **2. The macro deliberately does NOT name an ask-user tool.** `ask_user` is a
 * Pi HARNESS tool (`pi-harness/harness-manifest.ts:185`), not a session tool, so
 * naming it would make this command behave differently on two of the three
 * runtimes — the divergence the row exists to close. The interview is therefore
 * ordinary conversation, which every runtime can hold; a runtime whose model
 * has a structured question tool is free to reach for it, and that is the
 * model's choice rather than the macro's instruction.
 *
 * ## Why the interview is the product and not a nicety
 *
 * The row's title is *"a goal waits forever and can only be stated precisely by
 * a user who already knows the answer"*. A `condition` the goal evaluator can
 * settle is a testable sentence; a wish is not. The prompt spends most of its
 * length on that one conversion, and on the budgets, because half 1's check-in
 * notice can only tell the user a goal has stopped moving — it cannot rescue a
 * goal whose condition was never decidable in the first place.
 */

/** The four budget fields `Goal`'s `create` action accepts, with their real caps. */
export const GOAL_INTERVIEW_BUDGET_FIELDS = 'turnLimit, tokenLimit, costLimitUsd, elapsedLimitMs';

/**
 * The user-message body `/goal` expands to. English by design, like every other
 * prompt constant in this directory.
 */
export const GOAL_INTERVIEW_PROMPT = `Help me set a session goal. Interview me first; do not create anything until I have answered.

Ask me, one short question at a time and waiting for my answer each time:
1. What outcome do I actually want from this session — stated as something that will be either true or false when you are done, not as an activity.
2. How will we know it is done? Name the concrete check: a command whose output you can read, a file that must exist and contain something specific, a test that must pass. If I answer with a feeling ("it works", "it's clean"), keep asking until we have a check you could run yourself.
3. What must NOT change or be touched along the way, and anything else that constrains the work.
4. How much of this session may it use before you stop and report back — turns, tokens, spend, or wall-clock time. Offer to leave it unbounded if I do not care.

Then repeat the goal back to me in one sentence, in the "done when ..." form, and let me correct it.

Once I have agreed, call the Goal tool with action "create" and put that agreed sentence in \`condition\`. Write the condition so it names the check and not just the aim, and keep every constraint I gave you inside it — the goal record is the only place they survive. If I gave a budget, pass it in \`budgets\` (${GOAL_INTERVIEW_BUDGET_FIELDS}); leave \`budgets\` out entirely when I did not.

Finally, tell me the condition that was recorded, in one line, so I can see exactly what the session is now working towards. Then start on it.`;
