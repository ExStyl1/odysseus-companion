/**
 * `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` — pin the claude runtime's PRESET prompt
 * length instead of inheriting whichever pole the binary picks (P6.395).
 *
 * ## What this variable actually decides, read from the shipped binary
 *
 * The name is a registry entry in the vendored `sdk.mjs`/`bridge.mjs`, but the
 * READER is in the native binary. Measured there at `claudeCodeVersion 2.1.233`
 * (`grep -a` over `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`), the
 * decision function is (re-probed at the vendored `2.1.247` on 2026-09-12,
 * C3.252: the `simple_system_prompt` cohort marker is still there, 2 lines / 2
 * occurrences, so the shape below still describes the binary we ship):
 *
 *     X0=mu((e)=>{
 *       if(!e)return!1;
 *       if(Ln(V.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT))return!0;
 *       if(af(V.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT))return!1;
 *       if(!d2_(e))return!0;
 *       if(rt("tengu_velvet_tide",!1))return!0;
 *       return Pad("simple_system_prompt",zo(e))
 *     });
 *
 * Two things follow, and the second is the reason this file exists.
 *
 * **It is a real two-way switch.** A truthy value pins the SHORT preset; an
 * explicitly falsy one pins the FULL preset. Both poles are reachable, which is
 * unusual — most variables in this family only turn something off (compare
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, where the page states that `0` and
 * `false` still disable).
 *
 * **Unset, the pole is decided by things the host cannot see.** The last three
 * lines are a model predicate, a gate flag (`tengu_velvet_tide`), and a
 * `simple_system_prompt` COHORT lookup. So with the variable absent — which is
 * what this fork shipped, `git grep -ac` over `packages` + `apps` scoring 0
 * files — two sessions on the same build can compose different preset prompts,
 * and nothing on our side records which one happened. That is not a feature we
 * are declining; it is a variable in the answer that no log can name.
 *
 * ## The posture, stated rather than queued (AGENTS.md § where the documentation
 * is silent)
 *
 * `env-vars.md` does not carry this name, so there is no page to defer to. The
 * pin is therefore a decision, and it goes to the FULL preset:
 *
 *  - it is the pole under which every other behaviour in this fork was measured,
 *    so pinning the short one would silently invalidate prior readings;
 *  - Pi and codex both compose the full guidance, so full is the only pole that
 *    leaves the three runtimes comparable — the host's job is to make the
 *    residual difference uniform or honest;
 *  - it costs prompt tokens, and that cost is the trade being taken. An operator
 *    who wants the short preset sets the variable themselves: an inherited value
 *    is respected, so this pin is a DEFAULT, not an override.
 *
 * The subtraction a user actually asks for — an output style with
 * `keep-coding-instructions: false` — is a different mechanism and is unaffected:
 * that one edits OUR appended prompt through `getSafetyAndEngineeringSections`,
 * on all three runtimes.
 */

/** The variable the native binary reads. Exported so no call site respells it. */
export const CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR = 'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT';

/**
 * `'0'` — the binary's `af(...)` (explicitly-falsy) arm, which returns `false`
 * and therefore keeps the FULL preset prompt. Not `''`: an empty string would
 * take the `if(!e)` path in some readers and is not what `af` is testing.
 */
export const CLAUDE_FULL_SYSTEM_PROMPT_VALUE = '0';

/**
 * The env fragment to spread into the claude SDK child's environment.
 *
 * Returns `{}` when the launch environment already carries the name, so an
 * operator's own setting — either pole — survives. Read the value out of the
 * spread you are building the child from, never with `in`: `in` is true for
 * names Bun pre-creates a slot for even when they are unset, so it cannot
 * answer "was this set at launch".
 */
export function buildClaudeSimpleSystemPromptEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const declared = env[CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR];
  if (declared !== undefined && declared !== '') return {};
  return { [CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR]: CLAUDE_FULL_SYSTEM_PROMPT_VALUE };
}
