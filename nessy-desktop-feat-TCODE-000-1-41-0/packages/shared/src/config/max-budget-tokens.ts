/**
 * P6.645 — the operator's TOKEN ceiling, the twin of `maxBudgetUsd`.
 *
 * ## Why it is a host setting and not a runtime one
 *
 * Step 1 of native-first was measured absent on all three runtimes: codex
 * refused all three ceilings at `rust-v0.148.0` (P6.507), claude's
 * `Options.taskBudget` has zero production references, and Pi's per-turn cap is
 * USD-only. Step 2 — the host supplying it uniformly — is the answer here, and
 * it is a GOOD answer rather than a fallback: all three already report token
 * counts, so unlike the USD cap this ceiling is never unenforceable. That is
 * also why it is a separate setting rather than a mode of the USD one: a
 * runtime that reports no money at all can still honour this.
 *
 * ## One rule, two readers
 *
 * `BaseAgent` compares the session's own turns against it; the Pi execution
 * manifest seeds a child's budget from it, so a subagent under a capped session
 * inherits the cap instead of the spawner's 100 000 default. Both read THIS
 * function rather than the config field, so the "absent or non-positive means
 * no cap" rule cannot drift into two answers — the defect
 * `buildPiExecutionManifest` already records for the managed model allowlist
 * ("read here rather than at the call site so a second call site cannot ship a
 * manifest that forgets it").
 *
 * ## Read defensively, deliberately
 *
 * The DECLARATION half — `workspaceDefaults.maxBudgetTokens` in
 * `apps/electron/resources/config-defaults.json`, `config-defaults-schema.ts`
 * and `validators.ts`'s `ConfigDefaultsSchema` — belongs to the config lane and
 * lands separately. Until it does, `loadConfigDefaults()` simply does not carry
 * the field, and an absent field reads as 0, which is "no cap": exactly the
 * value the USD cap uses for off, so a tree without the declaration behaves
 * precisely as it did before this row.
 */

import { loadConfigDefaults } from './storage.ts';

/**
 * The field name the declaration must use, exported so the config lane and the
 * readers cannot disagree about the spelling.
 *
 * NOT named `…_SETTING_KEY`, and that is a rule rather than a preference:
 * `__tests__/stored-config-envelope-guard.test.ts` scans `config/*.ts` for
 * `export const …_SETTING_KEY = '<key>'` and requires every hit to be declared
 * in BOTH stored-config envelopes, because that suffix means *a top-level key
 * of `config.json`* everywhere else it is used. This one is
 * `workspaceDefaults.maxBudgetTokens` in `config-defaults.json` — a different
 * file and a nested field — so the guard was right to complain and the name was
 * wrong. Its two siblings `maxBudgetUsd` and `maxAgentTurns` sit in
 * `ConfigDefaultsSchema` and in neither stored-config envelope, and declaring
 * this one top-level would have claimed `config.json` accepts a key nothing
 * reads. (P6.645 / P6.765 wave, renamed 2026-09-08.)
 */
export const MAX_BUDGET_TOKENS_DEFAULTS_FIELD = 'maxBudgetTokens';

/** The configured token ceiling, or 0 when the cap is off (the default). */
export function resolveMaxBudgetTokens(): number {
  const defaults = loadConfigDefaults().workspaceDefaults as Record<string, unknown>;
  const raw = defaults[MAX_BUDGET_TOKENS_DEFAULTS_FIELD];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * P6.821 — the USD ceiling, read as a FUNCTION so the disclosure and the
 * enforcement cannot answer differently.
 *
 * Its twin above exists because two readers needed one rule. This one exists
 * for the same reason and a newer one: the ceilings are **operator-owned** —
 * neither can be set from the app — and P6.821 discloses both on the settings
 * page so the two notices that used to tell a user to "set a token limit" can
 * stop asking for something the user cannot do. A disclosure that computed the
 * ceiling its own way would be the worst possible version of that: a number the
 * product presents as authoritative and does not enforce.
 *
 * THE SECOND COPY IS STILL OUT THERE, and naming it is the point of this
 * paragraph. `BaseAgent.getMaxBudgetUsd` (`agent/base-agent.ts`) holds the same
 * three-clause rule inline and is the reader that actually STOPS a turn. It is
 * not converted here because `base-agent.ts` was another lane's file for the
 * whole of wave 10 and this row is explicitly forbidden from editing it; the
 * one-line delegation is offered as a hand-off in W10-c's report, and
 * `__tests__/settings-budget-ceilings.test.ts` (server-core) pins the two
 * against each other at source level meanwhile, so a change to either that
 * leaves the other behind is a red rather than a silent divergence.
 *
 * `Number.isFinite` is not ceremony: `config.json` is JSON a human edits, and
 * `NaN` arrives from an arithmetic default elsewhere reaching this field. A
 * non-finite ceiling would compare `false` against every spend and read as "no
 * cap" anyway — this makes that answer explicit rather than emergent.
 */
export function resolveMaxBudgetUsd(): number {
  const raw = loadConfigDefaults().workspaceDefaults.maxBudgetUsd;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}
