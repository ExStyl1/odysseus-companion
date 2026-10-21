/**
 * The one translation from Nessy's permission mode to the Claude SDK's own.
 *
 * ## Why this file exists at all
 *
 * Until R3 the Claude runtime pinned `permissionMode: 'bypassPermissions'` for
 * every session regardless of what the user had chosen, so no translation was
 * needed: whatever the user picked, the SDK was told "skip everything" and our
 * PreToolUse gate decided alone. Measured 2026-08-16 by unbounded `grep -a`
 * over `packages` and `apps` (node_modules, dist and release excluded): the
 * only site that ever set the SDK's `permissionMode` was
 * `claude-agent.ts:1995`, with the literal `'bypassPermissions'`, and no
 * mapping from our vocabulary to theirs existed anywhere in the product.
 *
 * With the pin gone, the user's mode has to mean something to the runtime that
 * is now deciding again. This file is that table.
 *
 * ## Where the other two columns live (R5, 2026-08-16)
 *
 * The user sees ONE set of permission modes on every runtime; each runtime
 * translates it, and each translation has exactly one home. R5 settled that
 * this file IS the Claude home rather than something to be folded into a
 * fourth place — a per-runtime table belongs next to the code that consumes it,
 * and the codex one cannot move here at all (it lives in a dep-free adapter
 * leaf that must not import shared).
 *
 * - **Pi** — identity. The vocabulary is Pi's and the pre-tool-use gate IS the
 *   translation: `runPreToolUseChecks` takes the mode verbatim.
 * - **Claude** — this file, plus that same gate as a PreToolUse hook.
 * - **Codex** — `CODEX_PERMISSION_MODE_TABLE` in
 *   `codex-responses-adapter/src/config-writer.ts`, two knobs per mode.
 *
 * The cross-runtime assertions — one row per mode covering all three, the
 * no-widening invariant per runtime, and the measured record of what codex
 * cannot express — are in
 * `__tests__/permission-mode-runtime-translations.test.ts`.
 *
 * ## The two vocabularies
 *
 * Ours (`mode-types.ts`), least to most permissive:
 * `dontAsk < plan < default < acceptEdits < auto < bypassPermissions`.
 *
 * Theirs (`sdk.d.ts`): `PermissionMode = 'default' | 'acceptEdits' |
 * 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'` — the same six names since
 * F1.1050 retired Nessy's own `explore` (a stored one is read as `plan`).
 *
 * So five of six translate by identity and mean what they say. The one that
 * does not is `plan`, which maps to `'default'` for reasons written out below
 * rather than assumed.
 *
 * ## What each SDK mode does, quoted rather than remembered
 *
 * `agent-sdk/permissions.md` § Available modes:
 *
 *   `default` — "No auto-approvals; unmatched tools trigger your `canUseTool`
 *   callback"
 *
 *   `dontAsk` — "Anything not pre-approved by `allowed_tools` or rules is
 *   denied; connector tools your organization set to `ask` and tools that
 *   require user interaction are denied even if you've pre-approved them.
 *   `canUseTool` is never called"
 *
 *   `acceptEdits` — "File edits and filesystem operations (`mkdir`, `rm`, `mv`,
 *   etc.) are automatically approved"
 *
 *   `bypassPermissions` — "Tools run without permission prompts, except tools
 *   matched by an explicit `ask` rule, connector tools your organization set to
 *   `ask`, and tools that require user interaction."
 *
 *   `plan` — "Claude explores and plans without editing your source files; file
 *   edits are never auto-approved and prompt through your `canUseTool`
 *   callback"
 *
 *   `auto` — "A model classifier approves or denies permission prompts."
 *
 * And the step this option feeds, from § How permissions are evaluated: "Apply
 * the active permission mode. `bypassPermissions` approves everything that
 * reaches this step. `acceptEdits` approves file operations. `plan` routes
 * file-edit and shell-write tools to your `canUseTool` callback regardless of
 * allow rules, so write operations cannot be auto-approved while planning.
 * Other modes fall through."
 *
 * ## Why `plan` maps to `'default'` and not to SDK `'plan'`
 *
 * Three reasons, in order of weight.
 *
 * 1. **The plan already refutes handing plan mode to the SDK**, in a row
 *    recorded REFUTED specifically so it is not retried: `permissionMode` is a
 *    single scalar, Claude Code does not enforce plan blocking where bypass is
 *    available, and `plan` is our no-write floor when a session switches
 *    runtime while Codex has no native plan mode at all. Mapping `plan` onto
 *    SDK `'plan'` here would be that row through the back door.
 *
 * 2. **SDK `plan` would add prompts our modes deliberately do not have.** It
 *    "routes file-edit and shell-write tools to your `canUseTool` callback
 *    regardless of allow rules". In `plan` the agent still writes
 *    its plan and session-data files — that is what `plansFolderPath` and
 *    `dataFolderPath` are for in `shouldAllowToolInMode` — so those writes,
 *    which our gate approves today with no card, would each raise one.
 *
 * 3. **Neither mode loses anything by mapping to `'default'`.** The no-write
 *    floor for both is our PreToolUse gate, which returns `deny` for a write in
 *    either mode, and a hook deny is the one decision no mode can override:
 *    "hooks run before every other step, and a hook deny applies even in
 *    `bypassPermissions` mode" (`agent-sdk/permissions.md`). `'default'` adds
 *    no auto-approval of its own — it is the only SDK mode that neither
 *    approves nor denies anything by itself — so the floor is exactly as strict
 *    as it was under the bypass, while everything our gate allows still skips
 *    the prompt through R1's `permissionDecision: 'allow'`.
 *
 * `explore` needs no row any more: F1.1050 retired it, and every door that can
 * carry a stored `explore` reads it as `plan` through `parsePermissionMode`
 * before this table is consulted, so a former explore session maps as plan
 * does (`'default'`, our gate on top).
 *
 * ## The invariant this file must never break
 *
 * A stricter Nessy mode must never map to a more permissive SDK mode. That is
 * the same class of silent widening `PERMISSION_MODE_ORDER`'s clamp exists to
 * prevent, and it is asserted over the whole table rather than per row, because
 * a single wrong entry is invisible at the call site.
 *
 * ## What `auto` actually buys today: NOTHING, measured (P3.93/P3.96)
 *
 * The `auto: 'auto'` row below is not a passive rename. In that mode the SDK
 * runs its own classifier — `permission-modes.md#eliminate-prompts-with-auto-mode`,
 * verbatim: *"A separate classifier model reviews actions before they run,
 * blocking anything that escalates beyond your request, targets unrecognized
 * infrastructure, or appears driven by hostile content Claude read."* We have
 * enabled it here since R3 and never configured it, and two things about it
 * were measured on 2026-08-28 against the vendored binary (2.1.223) on the
 * gateway card's own model. Both came out opposite to what the pages predict,
 * so read the measurement rather than re-deriving from the docs:
 *
 * 1. **It IS available here.** The page's requirements name Anthropic models
 *    and Anthropic providers, and `tgpt/qwen35-397b-a17b-fp8` behind a custom
 *    base URL is on neither list — but `ModelInfo.supportsAutoMode` comes back
 *    `true` for it, because the binary's gate is a DENY list of legacy Claude
 *    ids rather than an allow list.
 * 2. **And our own gate silences it completely.** In auto mode the classifier
 *    IS the permission prompt, and `hooks.md#pretooluse-decision-control` says
 *    a hook's `"allow"` *"skips the permission prompt"*. Since
 *    `buildClaudePreToolUseContinue` returns `permissionDecision: 'allow'` for
 *    everything our gate approves, the classifier is consulted on nothing:
 *    measured, a `curl … | sh` at an unrecognized host produced zero classifier
 *    requests, zero prompts, zero denials — and executed.
 *
 * **Do not "fix" this by returning `ask`.** That was the obvious repair and it
 * is measurably wrong: with no matching ask RULE, a hook `ask` does not reach
 * the classifier either — it raises a real prompt to a real person. The only
 * shape measured to keep the classifier is a hook that names NO
 * `permissionDecision`, which is the pre-R1 payload this file's PreToolUse
 * sibling deliberately moved away from because in `default` mode it starts
 * prompting. So any repair is mode-conditional by construction, and it is owed
 * one more measurement first — whether the gateway's own model can return a
 * verdict the classifier can parse, since a classifier that cannot answer
 * fails CLOSED and would deny every shell and network call in this mode.
 *
 * All five arms, with their controls, are pinned in
 * `__tests__/claude-auto-mode-classifier-e2e.test.ts`.
 *
 * ## The honest limit
 *
 * The SDK's *interpretation* of this option runs inside the native `claude`
 * binary. Nothing here can execute it, so what is proven in the unit tests is
 * that the option we hand over is the one the documented table says it should
 * be. The behavioural half — Safe Mode still running a read-only command with
 * no card, an `ask` rule now raising one — belongs to a live case, and for
 * `auto` specifically to the e2e file named above.
 */
import type { Options, PermissionMode as ClaudeSdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from './mode-types.ts';

export type { ClaudeSdkPermissionMode };

/**
 * The SDK's own modes ordered least to most permissive, the mirror of
 * `PERMISSION_MODE_ORDER`. Used to assert the no-widening invariant; the
 * positions are the assertion's index, so a reorder here is as load-bearing as
 * a reorder there.
 *
 * `plan` sits between `dontAsk` and `default` for the same reason it does in
 * our own order: it can prompt (which `dontAsk` cannot) and it withholds writes
 * (which `default` does not).
 */
export const CLAUDE_SDK_PERMISSION_MODE_ORDER: readonly ClaudeSdkPermissionMode[] = Object.freeze([
  'dontAsk',
  'plan',
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
] as const);

/**
 * Nessy mode → Claude SDK mode. The whole translation, in one literal, typed
 * against the SDK's own union so a member rename fails at compile time here
 * rather than shipping an option the runtime rejects.
 */
export const CLAUDE_SDK_PERMISSION_MODE_TABLE: Readonly<Record<PermissionMode, ClaudeSdkPermissionMode>> =
  Object.freeze({
    // Identity: the SDK's `dontAsk` denies rather than prompting, which is this
    // mode's whole contract. Our gate already returns `block` instead of
    // `prompt` in it, so the SDK's step is reached only by calls our gate
    // allowed.
    dontAsk: 'dontAsk',
    // F1.1050: no `explore` row — the mode is retired (a stored one is read
    // as `plan` upstream), and its `'default'` mapping is plan's below.
    // No-write floor stays ours; see the file comment, reason 1 especially.
    plan: 'default',
    default: 'default',
    acceptEdits: 'acceptEdits',
    auto: 'auto',
    bypassPermissions: 'bypassPermissions',
  });

/** Translate one Nessy mode into the SDK's vocabulary. */
export function toClaudeSdkPermissionMode(mode: PermissionMode): ClaudeSdkPermissionMode {
  return CLAUDE_SDK_PERMISSION_MODE_TABLE[mode];
}

/**
 * The permission options for one Claude query.
 *
 * `allowDangerouslySkipPermissions` is not a second knob and must not be set
 * unconditionally: the SDK types it "Must be set to `true` when using
 * `permissionMode: 'bypassPermissions'`. This is a safety measure to ensure
 * intentional bypassing of permissions." So it rides with that one mode and
 * with no other — which is exactly what "the user chose bypass" means, and
 * exactly what the removed pin said for all seven modes.
 */
export function buildClaudePermissionModeOptions(
  mode: PermissionMode,
): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions'> {
  const permissionMode = toClaudeSdkPermissionMode(mode);
  return {
    permissionMode,
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
  };
}
