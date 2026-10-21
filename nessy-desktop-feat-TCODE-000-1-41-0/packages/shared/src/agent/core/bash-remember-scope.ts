/**
 * D1.436 `[safety]` — what one Bash "Always Allow" can be remembered as, per
 * runtime, spelled ONCE.
 *
 * ## The defect this table exists to end
 *
 * Measured end to end on the packaged 1.40.0 (SIT-9, 2026-09-20, P-SIT9-2),
 * both runtimes in one app run and one repository. On **claude-gateway** the
 * permission card's sentence reads *"Always Allow remembers this for the
 * session"* and the host wrote a permanent `Bash(npm test *)` into
 * `.claude/settings.local.json` anyway; a NEW **pi** session in that repository
 * then ran `npm test` with **no card at all**. So one click on a card labelled
 * *session* durably granted a command to every future pi session there — the
 * widest grant class, with the sandbox off by standing decision.
 *
 * ## Why the answer is the RUNTIME and not the card's origin
 *
 * C4.46's cut was keyed on `origin !== 'claude_native'`, and that term is TRUE
 * and cannot answer this: `claude_native` is reserved for the SDK's own
 * `canUseTool` request, while the gateway's Bash card is raised by this fork's
 * `runPreToolUseChecks` running as a PreToolUse hook INSIDE the claude child and
 * is stamped `host_gate` — "the host gate wearing claude's clothes", as
 * `claude-agent.ts` puts it at the card site.
 *
 * What decides the scope is whether the written rule is ever READ BACK. A
 * `.claude/settings.local.json` `permissions.allow` block is compiled into the
 * readable permission DSL and evaluated by the pi and codex gates; the claude
 * arm never evaluates it (C3.365, re-measured live by SIT-9: the rule did not
 * suppress claude's own later card). On claude the user therefore pays the
 * widening and gets none of the convenience, which is the exact trade C4.46
 * refuses.
 *
 * ## The posture, stated because it is a product one
 *
 * The BEHAVIOUR follows the LABEL. `PermissionRequest.tsx` symbol
 * `permissionRememberScope` is the sentence half of this same answer and keys on
 * the same runtimes; its docblock states the standing rule — where the two
 * answers could disagree the card takes the WEAKER promise, because
 * under-promising costs a user one extra click and over-promising teaches them
 * that the dialog lies. Nothing here changes what the card SAYS; it makes the
 * write stop being wider than what was said. Since F1.128 the card's Bash arm
 * READS this table (`permissionRememberScope` calls the function below), so the
 * sentence and the write are one answer, and this table being compiler-total
 * (below) is what makes a new runtime a build break in that one place.
 *
 * ## Total over the runtime vocabulary, on purpose
 *
 * `agent/backend/runtime-vocabulary.ts` states the property this obeys: *"A
 * per-runtime capability site must be TOTAL over this vocabulary: adding a
 * runtime must BREAK THE BUILD at the site, never inherit a silent default."*
 * So the table is `satisfies Record<AgentProvider, BashRememberScope>` and a new
 * runtime cannot be defaulted into the permanent write — it has to be decided
 * here, beside the reason. The runtime lookup still falls back to `'session'`,
 * which is the fail-closed direction: a scope this table cannot name costs a
 * user the convenience, where the other direction mints a permanent rule.
 *
 * A leaf module with one type-only import, for `dangerous-commands.ts`'s reason:
 * the permission card reads these answers too, and nothing of the permission
 * engine's graph may come with them.
 */
import type { AgentProvider } from '../backend/types.ts';

/**
 * How long one Always Allow on a Bash card can honestly last.
 *
 *  - `repository` — a rule in `.claude/settings.local.json` at the repository
 *    root, read back by this product's own gate on every later session there.
 *    `permissions.md#permission-system`'s tier table calls the Bash row
 *    *"Permanently per repository and command"*.
 *  - `session` — the in-session whitelist and nothing on disk.
 */
export type BashRememberScope = 'repository' | 'session';

/**
 * The one table. A runtime is `repository` only where this fork's own gate
 * evaluates the rule that would be written; see the file docblock.
 */
const BASH_REMEMBER_SCOPE_BY_PROVIDER = {
  // Pi evaluates the compiled DSL, so the saved rule is what stops the next
  // card in the next session — measured by C3.365 and again by SIT-9.
  pi: 'repository',
  // Codex likewise.
  'codex-runtime': 'repository',
  // The claude backend (direct `anthropic` and the `claude-runtime` gateway,
  // which maps onto it) never evaluates it: this fork's PreToolUse gate asks
  // again regardless, so the write buys nothing here and widens every other
  // runtime in the repository.
  anthropic: 'session',
  // A remote cloud agent runs nothing locally and reads no repository settings
  // file, so there is nothing for a rule to suppress.
  'nestor-cloud-agent': 'session',
} as const satisfies Record<AgentProvider, BashRememberScope>;

/**
 * The other half of the anchor, in `runtime-vocabulary.ts`'s own shape:
 * `satisfies` rejects a member this table FORGOT, and this rejects one it
 * INVENTED — a key outside the union makes the constant `never` and fails
 * `bun run typecheck:shared`.
 */
type KeysAreInUnion<K extends string, Union extends string> = [K] extends [Union] ? true : never;

const bashRememberScopeKeysAreExact: KeysAreInUnion<
  keyof typeof BASH_REMEMBER_SCOPE_BY_PROVIDER,
  AgentProvider
> = true;
void bashRememberScopeKeysAreExact;

/**
 * What an Always Allow on a Bash card may be remembered as, on this runtime.
 *
 * @param provider - the session's resolved runtime (`ResolvedBackendContext.provider`)
 * @returns `'repository'` only where the durable rule is read back
 */
export function bashAlwaysAllowRememberScope(
  provider: AgentProvider | undefined,
): BashRememberScope {
  if (provider === undefined) return 'session';
  return BASH_REMEMBER_SCOPE_BY_PROVIDER[provider] ?? 'session';
}
