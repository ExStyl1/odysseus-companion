/**
 * Automations Schema Definitions
 *
 * Zod schemas for validating automations.json configuration.
 * Extracted from index.ts for better separation of concerns.
 */

import { z } from 'zod';
import type { ValidationIssue } from '../config/validators.ts';
import { APP_EVENTS, AGENT_EVENTS, UNEMITTED_HOOK_EVENT_REASONS } from './types.ts';
import { THINKING_LEVEL_IDS, normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';

// ============================================================================
// Zod Schemas
// ============================================================================

// Mirrors the workspace-default pattern in `config/storage.ts` so that the
// legacy 'think' value is silently migrated to a current thinking level.
const ThinkingLevelInputSchema = z
  .enum([...THINKING_LEVEL_IDS, 'think'])
  .transform((value) => normalizeThinkingLevel(value))
  .optional();

export const PromptActionSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().min(1, 'Prompt cannot be empty'),
  llmConnection: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: ThinkingLevelInputSchema,
  ephemeral: z.boolean().optional(),
});

export const WebhookActionSchema = z.object({
  type: z.literal('webhook'),
  url: z.string().min(1, 'URL cannot be empty').refine(
    (url) => {
      // Allow env var templates — validated at runtime after expansion
      if (url.includes('$')) return true;
      // Literal URLs must be valid http/https
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    'URL must be a valid http/https URL or contain $VAR templates'
  ),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyFormat: z.enum(['json', 'form', 'raw']).optional(),
  body: z.unknown().optional(),
  captureResponse: z.boolean().optional(),
  auth: z.union([
    z.object({
      type: z.literal('basic'),
      username: z.string().min(1),
      password: z.string(),
    }),
    z.object({
      type: z.literal('bearer'),
      token: z.string().min(1),
    }),
  ]).optional(),
});

export const HookCommandActionSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1, 'Command cannot be empty'),
  // F1.1177 — `hooks.md#command-hook-fields`, `args`: "When present, `command` is resolved as an executable and
  // spawned directly with `args` as the argument vector". Undeclared, every document tier below stripped it and an
  // exec-form hook ran as `sh -c <command>` with no arguments (`resolveExecFormHookInvocation` spawns exec form). A
  // non-list is refused in `validation.ts`, since the union's passthrough member would otherwise keep it as written.
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  blockOnNonZero: z.boolean().optional(),
  // hooks.md § Command hook fields, `shell`: accepts "bash" or "powershell";
  // an unknown value fails validation with the field path — never a silent
  // platform default. Ignored at spawn when `args` selects exec form.
  shell: z.enum(['bash', 'powershell']).optional(),
  // C3.334 — the two background fields, declared HERE because this schema is the single gate every DOCUMENT tier
  // passes through (`parseHooksConfig`): skill and subagent frontmatter, the user-global and project `hooks.json`,
  // and a workspace `config.json` hooks block. A zod object strips what it does not declare, so until 2026-09-12 the
  // flags were dropped from every one of them and a hook the author marked `async` blocked its event. The plugin tier
  // never hit this — `pluginHookAction` builds the action object directly — which is why `async` appeared to work.
  //
  // `hooks.md#command-hook-fields`, verbatim: *"`async` … If `true`, runs in the background without blocking"* and
  // *"`asyncRewake` … If `true`, runs in the background and wakes Claude on exit code 2"*.
  // `hooks.md#configure-an-async-hook`: *"This field is only available on `type: "command"` hooks."* — which is
  // exactly this schema and no other. `hooks.md#hooks-in-skills-and-agents`: frontmatter hooks are declared *"in the
  // same configuration format as settings-based hooks"*, so one schema answering for both tiers is the documented
  // shape rather than a shortcut.
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(), statusMessage: z.string().optional(), // F1.1094 — `hooks.md#common-fields`: "Custom spinner message displayed while the hook runs"
  // UB12.67 — `hooks.md#command-hook-fields`, `onFailure`: "`"continue"`, the default, or `"block"`". Declared here
  // so every document tier keeps it; another value is refused by path in `validation.ts`, as `args` is.
  onFailure: z.enum(['continue', 'block']).optional(),
});

export const PreToolUseDecisionActionSchema = z.object({
  type: z.literal('decision'),
  decision: z.enum(['allow', 'ask', 'block', 'deny']).optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  additionalContext: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
}).refine(
  (action) => action.decision !== undefined || action.updatedInput !== undefined || action.additionalContext !== undefined,
  'Decision action must set decision, updatedInput, or additionalContext',
);

/** Prompt, webhook, command and decision actions strictly; a `script` action through ScriptActionSchema (UA8.1, see refineScriptAction); other types pass through */
export const ActionDefinitionSchema = z.union([
  PromptActionSchema,
  WebhookActionSchema,
  HookCommandActionSchema,
  PreToolUseDecisionActionSchema,
  z.object({ type: z.string() }).passthrough().superRefine(refineScriptAction),
]);

// ============================================================================
// Condition Schemas
// ============================================================================

const VALID_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const TimeConditionSchema = z.object({
  condition: z.literal('time'),
  after: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  before: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  weekday: z.array(z.enum(VALID_WEEKDAYS)).optional(),
  timezone: z.string().optional(),
});

export const StateConditionSchema = z.object({
  condition: z.literal('state'),
  field: z.string().min(1, 'Field name cannot be empty'),
  value: z.unknown().optional(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  contains: z.string().optional(),
  not_value: z.unknown().optional(),
}).superRefine((data, ctx) => {
  const hasValue = data.value !== undefined;
  const hasFromOrTo = data.from !== undefined || data.to !== undefined;
  const hasContains = data.contains !== undefined;
  const hasNotValue = data.not_value !== undefined;

  const operatorCount =
    (hasValue ? 1 : 0) +
    (hasFromOrTo ? 1 : 0) +
    (hasContains ? 1 : 0) +
    (hasNotValue ? 1 : 0);

  if (operatorCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'State condition must have at least one operator (value, from/to, contains, or not_value)',
      path: ['field'],
    });
    return;
  }

  if (operatorCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'State condition must use exactly one operator group (value, from/to, contains, or not_value)',
      path: ['field'],
    });
  }
});

export const AutomationConditionSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('condition', [
    TimeConditionSchema,
    StateConditionSchema,
    z.object({
      condition: z.enum(['and', 'or', 'not']),
      conditions: z.array(AutomationConditionSchema).min(1, 'Logical condition must have at least one sub-condition'),
    }),
  ])
);

// ============================================================================
// Matcher Schema
// ============================================================================

const AutomationMatcherObjectSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  matcher: z.string().optional(),
  /**
   * The imported-plugin two-mode matcher, opt-in per matcher (P3.322).
   *
   * `'claude'` selects hooks.md#matcher-patterns' semantics — a plain
   * alternation list of names is compared EXACTLY, anything containing other
   * characters stays an unanchored regex, `*` matches all. Absent keeps this
   * repo's older unanchored-regex behaviour, which every stored native
   * automation was written against.
   *
   * Admitted, not defaulted, and the distinction is the whole point:
   * `AutomationMatcher.matchMode`'s own docblock records that flipping the
   * DEFAULT "would silently re-scope saved automations". An author writing the
   * key opts one matcher in deliberately; nothing already on disk moves. Until
   * this row the key was stripped, so the documented semantics were reachable
   * only through an imported plugin hook and not at all from a config a person
   * writes.
   */
  matchMode: z.literal('claude').optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  // Alias-resolved through the shared mode table BEFORE the enum, so a
  // persisted automation written in a pre-migration spelling (`ask`, `safe`,
  // `allow-all`, `execute`) validates to the internal key. An unresolvable
  // string passes through raw and the enum rejects it exactly as before.
  permissionMode: z.preprocess(
    value => (typeof value === 'string' ? parsePermissionMode(value) ?? value : value),
    z.enum(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']), // F1.1050: a stored `explore`/`safe` validates as `plan` via the preprocess
  ).optional(),
  /**
   * desktop-scheduled-tasks.md:34 — the per-task worktree toggle. The object is
   * a plain `z.object`, so before this key existed a hand-added `worktree` was
   * silently STRIPPED at validation; it has to land here before any consumer can
   * read it.
   */
  worktree: z.boolean().optional(),
  /**
   * hooks.md#common-fields, the `if` row (anchor verified against the rendered
   * page 2026-09-03 — `id="common-fields"` scores 1): "Permission rule syntax to
   * filter when this hook runs, such as `\"Bash(git *)\"` or `\"Edit(*.ts)\"`. The
   * hook command only runs if the tool call matches the pattern." It is a
   * COMMON field of a hook handler in a SETTINGS file, and this schema is the
   * gate every native ingress passes (`automations.json`, `hooks.json`,
   * `config.json`'s `hooks`, `.nessy-agent/hooks.json`, resource bundles).
   *
   * P3.322 — it was in NEITHER this object nor `matchMode` below, and a plain
   * `z.object` STRIPS what it does not declare. So an author who wrote the
   * documented field got a hook that ran UNFILTERED, on every tool call, with no
   * trace anywhere: P2.288's registration diagnostic cannot fire (that is the
   * plugin reader, not this one) and P2.277's evaluation notice cannot either,
   * because by evaluation there is no `ifRule` left to be unparseable. A control
   * that silently stopped controlling.
   *
   * The documented spelling is `if`; ours is `ifRule`, and the preprocess below
   * accepts both, exactly as the plugin reader (`plugins/schema.ts`) already
   * does. A matcher that spells BOTH is refused rather than silently resolved —
   * `if` then survives into the strict check and is named there.
   *
   * ANCHORING, and the residue this schema cannot close. The page's own example
   * is working-directory-relative ("a single-segment directory pattern like
   * `\"Edit(src/**)\"` matches only the `src` directory in the working directory"),
   * and `hookIfFilterRuns` already supplies that `cwd`. A SOURCE-anchored `/x`
   * rule is the case with no answer here: permissions.md anchors `/path` "at a
   * directory associated with the settings source that defines it", which for a
   * native config is the file's own workspace — but this schema does not know
   * which file it came from. Such a rule still compiles to `invalid-policy` and
   * fails open, now audibly (P2.277 reports it). Giving it the settings-source
   * anchor belongs where the source path is known — `hooks-config.ts` and
   * `plugins/project-config.ts` — not here.
   */
  ifRule: z.string().optional(),
  /**
   * HOST-SUPPLIED, and refused BY NAME rather than dropped (P3.322).
   *
   * `ifSourceRoot` is the anchor a source-anchored `/x` rule inside `ifRule`
   * resolves against, and for the one shape that has it — an imported plugin
   * hook — the host sets it to the plugin's OWN installed bundle (owner
   * decision 2026-07-29), so that `Edit(/**)` reads as narrow instead of
   * matching the whole workspace. A user-authored file naming its own anchor
   * would be a semantic no page publishes, so it is not admitted; but it is not
   * dropped either, because a key that vanishes is the defect this row exists to
   * close. `z.never` carries the reason to the author instead of the generic
   * unrecognized-key line.
   */
  ifSourceRoot: z.never({
    error: 'ifSourceRoot is set by the host for imported plugin hooks and cannot be written here.'
      + ' A native `if` rule anchors on the working directory (hooks.md, Common fields);'
      + ' remove the key, or use a working-directory-relative pattern such as "Edit(src/**)".',
  }).optional(),
  labels: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(AutomationConditionSchema).optional(),
  // UB6.9 — decision-model yes/no condition; inert when the decision model is
  // off (craft-agents-oss v0.15.1:packages/shared/src/automations/schemas.ts,
  // first shipped v0.14.0; Apache-2.0). A plain z.object strips what it does
  // not declare, so the field has to be declared HERE before any consumer can
  // read it from a native config — the same defect P3.322 closed for ifRule.
  semanticCondition: z.object({
    question: z.string().trim().min(1, 'Question cannot be empty').max(500),
    threshold: z.number().gt(0).lte(1).optional(),
  }).strict().optional(),
  actions: z.array(ActionDefinitionSchema).min(1, 'At least one action required'),
})
  /**
   * P3.322 — REFUSE an unknown key BY NAME instead of dropping it silently.
   *
   * This object was a plain `z.object`, which strips. Three keys of
   * `AutomationMatcher` were therefore unreachable from every native config
   * (`ifRule`, `ifSourceRoot`, `matchMode`), and a typo in any other key was
   * indistinguishable from a key that did nothing. The enclosing
   * `AutomationsConfigSchema` has always been `.strict()`, so this makes the
   * matcher agree with the file it sits in rather than introducing a new
   * posture.
   *
   * The COST, stated because it is a real one: an unknown key now fails the
   * whole document, and `validateAutomationsConfig`'s callers return an empty
   * config plus the errors. That is the same trade the top level already makes,
   * and it is the direction this plan keeps choosing — a refusal an author can
   * read beats a silent drop they cannot.
   */
  .strict();

/**
 * Accept the DOCUMENTED spelling of the `if` filter (P3.322).
 *
 * hooks.md#common-fields calls the field `if`; this repo's internal name is
 * `ifRule`, and `plugins/schema.ts` has always read both for imported hooks
 * (`readString(hookRecord, 'ifRule') ?? readString(hookRecord, 'if')`). A native
 * config is written against the same page, so it accepts both here too — one
 * reader, one pair of spellings.
 *
 * When BOTH are present the `if` key is left in place on purpose: the strict
 * check then names it, which is a refusal the author can act on, where picking a
 * winner would silently discard the other. Any non-object passes through
 * untouched so the object schema reports the real type error.
 */
function acceptDocumentedIfSpelling(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!('if' in record) || 'ifRule' in record) return record;
  const { if: documentedSpelling, ...rest } = record;
  return { ...rest, ifRule: documentedSpelling };
}

export const AutomationMatcherSchema = z.preprocess(
  acceptDocumentedIfSpelling,
  AutomationMatcherObjectSchema,
);

/**
 * Deprecated event name aliases.
 * Old names are accepted during schema validation and silently rewritten to canonical names.
 * A console.warn() is emitted at runtime so users know to update their configs.
 * The table lives in `types.ts` since F1.1212, so the session tools' fallback reads the same one.
 */
import { DEPRECATED_EVENT_ALIASES } from './types.ts';
export { DEPRECATED_EVENT_ALIASES };

/** All valid event names: canonical events + deprecated aliases. Derived from types.ts. */
export const VALID_EVENTS: readonly string[] = [
  ...APP_EVENTS,
  ...AGENT_EVENTS,
  ...Object.keys(DEPRECATED_EVENT_ALIASES),
];

export const AutomationsConfigSchema = z.object({
  version: z.number().optional(),
  automations: z.record(z.string(), z.array(AutomationMatcherSchema)).optional(),
}).strict().transform((data) => {
  const automations = data.automations ?? {};

  // Filter out invalid event names, rewrite deprecated aliases, and warn
  const validAutomations: Record<string, z.infer<typeof AutomationMatcherSchema>[]> = {};
  const invalidEvents: string[] = [];

  for (const [event, matchers] of Object.entries(automations)) {
    if (VALID_EVENTS.includes(event)) {
      // Rewrite deprecated aliases to canonical names
      const canonical = DEPRECATED_EVENT_ALIASES[event];
      if (canonical) {
        console.warn(`[automations] Deprecated event name "${event}" — use "${canonical}" instead`);
        validAutomations[canonical] = [...(validAutomations[canonical] ?? []), ...matchers];
      } else {
        validAutomations[event] = [...(validAutomations[event] ?? []), ...matchers];
      }
    } else {
      invalidEvents.push(event);
    }
  }

  // A documented event we deliberately do not emit is not a typo, and must not
  // be reported as one: the author wrote a real Claude event name and deserves
  // the reason it cannot run here. Everything else keeps the unknown-name
  // warning. Both are still dropped — a matcher that can never fire has no
  // business in the loaded config.
  const unemitted = invalidEvents.filter(event => UNEMITTED_HOOK_EVENT_REASONS[event]);
  const unknown = invalidEvents.filter(event => !UNEMITTED_HOOK_EVENT_REASONS[event]);
  for (const event of unemitted) {
    console.warn(`[automations] "${event}" is not supported by Nessy and was ignored: ${UNEMITTED_HOOK_EVENT_REASONS[event]}`);
  }
  if (unknown.length > 0) {
    console.warn(`[automations] Unknown event types ignored: ${unknown.join(', ')}`);
  }

  return { version: data.version, automations: validAutomations };
});

// ============================================================================
// Schema Utilities
// ============================================================================

/**
 * Convert Zod error to ValidationIssues (matches validators.ts pattern)
 */
export function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

// ============================================================================
// Script action (UA8.1)
// ============================================================================

/**
 * UA8.1 — the script action, from craft-agents-oss v0.13.4:packages/shared/src/automations/schemas.ts (Apache-2.0).
 * Upstream made the whole action union a strict `discriminatedUnion`; ours keeps the passthrough member (hook and
 * plugin action kinds this union does not name ride it), so the script schema is applied FROM that member by
 * {@link refineScriptAction} — a `type: 'script'` action that fails it fails the document with the script schema's
 * own message instead of passing through unvalidated. The executor re-validates containment with symlink
 * resolution, and nothing runs without a host-approvals ledger entry (`script-executor.ts`).
 */
export const ScriptActionSchema = z.object({
  type: z.literal('script'),
  script: z.string().min(1, 'Script path cannot be empty').superRefine((script, ctx) => {
    // Workspace-relative only; the executor re-validates with symlink resolution.
    if (script.startsWith('/') || script.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(script)) {
      ctx.addIssue({ code: 'custom', message: 'Script path must be relative to the workspace root' });
    }
    if (script.split(/[\\/]/).includes('..')) {
      ctx.addIssue({ code: 'custom', message: 'Script path must not contain ".." segments' });
    }
  }),
  args: z.array(z.string()).optional(),
  runtime: z.enum(['bun', 'node', 'python3']).optional(),
  timeoutMs: z.number().int().positive().optional(),
  page: z.string().min(1).optional(),
}).strict();

/**
 * The union's passthrough member hands every `type: 'script'` action to {@link ScriptActionSchema} and reports its
 * issues (a function declaration, so the union above can name it before this point of the file).
 */
function refineScriptAction(action: { type: string }, ctx: z.RefinementCtx): void {
  if (action.type !== 'script') return;
  const parsed = ScriptActionSchema.safeParse(action);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  }
}
