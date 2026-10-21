/**
 * P6.68 — a stricter `useAutoModeDuringPlan` from a lower scope, refused at the
 * lax pole rather than at parse.
 *
 * ## What the page says, and the asymmetry that makes this key unusual
 *
 * `settings.md#exceptions-to-managed-settings-precedence`, verbatim: a
 * "`false` from any managed source, `--settings`, `~/.claude/settings.json`, or
 * `.claude/settings.local.json` … a `false` in `.claude/settings.json` is
 * ignored". Two halves, and BOTH are the contract:
 *
 * 1. A `false` from a LOWER scope wins over an operator `true` — the only
 *    direction it can win in, because the setting's off position is the stricter
 *    one (the classifier stops reviewing plan-mode shell commands and the
 *    documented "Otherwise" branch PROMPTS instead).
 * 2. A `false` in the project-owned `.claude/settings.json` is **ignored**. The
 *    page names the local file and the user file as exception sources and
 *    deliberately not the project one, so a repository cannot turn the
 *    classifier off for whoever clones it. That is not our rule to relax.
 *
 * A `true` from either file is inert in both halves: it can only agree with an
 * operator `true`, and it must never lift an operator `false`. So every
 * reachable outcome here is at least as strict as the operator asked for, which
 * is the single property `managed-composition.ts` requires of anything touching
 * these seven exception keys.
 *
 * ## NATIVE-FIRST, asked per runtime — the answer is the HOST seam
 *
 * - **Pi** has no scope-exception machinery of its own; the setting is ours.
 * - **claude** reads the three scope files natively (`claude-agent.ts`
 *   `settingSources: ['user','project','local']`) — but only for the keys IT
 *   owns, and this decision is taken on OUR permission path before any child
 *   sees it.
 * - **codex** has only admin-wins `Constrained<T>` (`codex-config-requirements.ts`,
 *   source tier `rust-v0.148.0`) with no lower-scope-stricter concept at all.
 *
 * No runtime publishes a mechanism we could enable, and the host can supply one
 * uniformly for all three — so this is tier 2, exactly as it already was for
 * `crossSessionInbound` (`server-core/sessions/cross-session-inbound.ts`), and
 * this module is deliberately shaped like that one.
 *
 * ## THE SWITCH VERDICT IS EARNED AT THE RESOLVER, NOT AT BEHAVIOUR — say so
 *
 * `getUseAutoModeDuringPlan` has exactly one production caller in the tree and
 * it is `PiAgent`'s. `ClaudeAgent` and `CodexAgent` are siblings, and
 * `planClassifierEligible` / `guardianConsultState` /
 * `consultGuardianForBorderline` score zero outside `pi-agent.ts` in non-test
 * code — the shared pipeline stops at `core/pre-tool-use.ts`'s
 * `{ type: 'prompt', … planShellReview: true }`. So after this module the
 * setting TIGHTENS identically on three runtimes and CHANGES WHAT HAPPENS on
 * one. That is `UNIFORM` at the resolver and unchanged at behaviour, and stating
 * it here is the difference between closing a gap and manufacturing a new silent
 * divergence while claiming to close one.
 *
 * ## Three decisions the page does not make, stated rather than hidden
 *
 * 1. **No `--settings` and no separate user scope.** The page lists both among
 *    the sources the exception is honoured from; our own stored setting stands in
 *    for them, and calling its parameter `operatorEnabled` keeps that
 *    substitution visible. Same substitution, same wording, as
 *    `cross-session-inbound.ts`'s decision 3.
 * 2. **No project-trust gate.** The influence is monotone-restrictive: the worst
 *    a hostile repository can do through the file we DO read is make this session
 *    prompt more often. And `.claude/settings.local.json` is the user's own file,
 *    not shipped by the repository — gating it on folder trust would discard the
 *    user's own stricter value, the laxer-than-asked outcome this key exists to
 *    prevent. The page states no trust condition either. (The project file, which
 *    a repository DOES ship, is ignored outright by rule 2 above, so the trust
 *    question never arises for it.)
 * 3. **Read per decision, not cached.** The caller already resolves this on a
 *    permission-floor route that is evaluated lazily, after the mode check, so a
 *    cache would make a settings edit take effect at an unpredictable moment for
 *    no measurable gain.
 *
 * The ignored project `false` is REPORTED rather than dropped
 * ({@link AutoModeDuringPlanVerdict.ignoredProjectFalse}): a refusal nobody can
 * see is indistinguishable from a defect, which is this fork's largest defect
 * class.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePermissionJsonc } from '../agent/pi-harness/permission-dsl.ts';

/** The settings-file key, spelled exactly as the page names it. */
export const AUTO_MODE_DURING_PLAN_SETTING_KEY = 'useAutoModeDuringPlan';

/** Where each `.claude` settings file lives, relative to the project directory. */
export const AUTO_MODE_DURING_PLAN_SETTINGS_FILES = {
  /** Repository-owned. A `false` here is IGNORED — the page's own asymmetry. */
  project: join('.claude', 'settings.json'),
  /** The user's own file. A `false` here TIGHTENS. */
  local: join('.claude', 'settings.local.json'),
} as const;

/** A settings file this size is not a settings file; refuse to read it. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

export interface AutoModeDuringPlanVerdict {
  /** The effective value. Never laxer than `operatorEnabled`. */
  readonly enabled: boolean;
  /** Set only when a lower scope actually tightened the operator value. */
  readonly tightenedBy?: 'local';
  /**
   * A `false` we READ in the project file and deliberately did not honour. Kept
   * so the caller can say so — a silent refusal reads as a bug.
   */
  readonly ignoredProjectFalse?: true;
}

/**
 * One settings document's `useAutoModeDuringPlan`, or `undefined` for absent,
 * unreadable, or any non-boolean value.
 *
 * Read with `parsePermissionJsonc`, the reader `claude-settings-store.ts`,
 * `skill-overrides.ts` and `agent/memory/instruction-excludes.ts` already use for
 * these files, so a document with comments or trailing commas is read the same
 * way by every consumer. Fails open in every failure mode: this file is co-owned
 * with real Claude Code, and a document we cannot parse must never take a
 * permission decision down.
 */
function readSetting(path: string): boolean | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
  if (raw.length > MAX_SETTINGS_FILE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = parsePermissionJsonc(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = (parsed as Record<string, unknown>)[AUTO_MODE_DURING_PLAN_SETTING_KEY];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Resolve `useAutoModeDuringPlan` across the operator value and the two project
 * scope files, at the STRICTER pole.
 *
 * Provider-free by construction — there is no runtime term anywhere on this
 * path, which is what makes one call site serve Pi, claude and codex alike.
 */
export function resolveUseAutoModeDuringPlanWithScopes(scopes: {
  readonly operatorEnabled: boolean;
  /**
   * The project directory holding the two files. Absent — an unopened or
   * directory-less session — contributes neither scope, and the operator's value
   * stands.
   */
  readonly workingDirectory?: string | undefined;
}): AutoModeDuringPlanVerdict {
  const { operatorEnabled, workingDirectory } = scopes;
  if (!workingDirectory) return { enabled: operatorEnabled };

  const local = readSetting(join(workingDirectory, AUTO_MODE_DURING_PLAN_SETTINGS_FILES.local));
  const project = readSetting(join(workingDirectory, AUTO_MODE_DURING_PLAN_SETTINGS_FILES.project));

  // The project file's `false` is read only so the refusal can be NAMED. It
  // never reaches `enabled`.
  const ignoredProjectFalse = project === false ? { ignoredProjectFalse: true as const } : {};

  // The one honoured tightening. A `true` in either file cannot appear here,
  // which is the whole asymmetry: these files can only make it stricter.
  if (local === false && operatorEnabled) {
    return { enabled: false, tightenedBy: 'local', ...ignoredProjectFalse };
  }
  return { enabled: operatorEnabled, ...ignoredProjectFalse };
}
