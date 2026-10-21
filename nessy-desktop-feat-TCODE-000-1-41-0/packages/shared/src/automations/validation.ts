/**
 * Automation System Validation
 *
 * Validators for automations.json configuration files.
 * Used by PreToolUse automations and workspace validators.
 */

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveAutomationsConfigPath } from './resolve-config-path.ts';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';
import { AutomationsConfigSchema, zodErrorToIssues, DEPRECATED_EVENT_ALIASES } from './schemas.ts';
import { isValidLabelId } from '../labels/storage.ts';
import { extractLabelId } from '../labels/values.ts';
import { getLlmConnection } from '../config/storage.ts';
import { getDefaultModelsForConnection } from '../config/llm-connections.ts';
import type { ModelDefinition } from '../config/models.ts';
import { Cron } from 'croner';
import type { ValidationResult, ValidationIssue } from '../config/validators.ts';
import { AGENT_EVENTS, APP_EVENTS, UNEMITTED_HOOK_EVENT_REASONS, hookTypeSupportedForEvent } from './types.ts';
import { isClaudeLiteralMatcher } from './utils.ts';
import type { AgentEvent, AutomationsConfig, AutomationsValidationResult } from './types.ts';
import { MAX_CONDITION_DEPTH_EXCLUSIVE, CONDITION_DEPTH_WARNING_THRESHOLD } from './conditions-constants.ts';

/**
 * Validate automations config (internal - returns parsed config)
 */
export function validateAutomationsConfig(content: unknown): AutomationsValidationResult {
  const result = AutomationsConfigSchema.safeParse(content);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { valid: false, errors, config: null };
  }

  const schemaConfig = result.data as AutomationsConfig;
  const semanticErrors: ValidationIssue[] = [];
  // C3.90 — the warnings used to be thrown away here (`[]` was passed in), so
  // every matcher diagnostic this function raises was invisible on the THREE
  // paths that load a config rather than validate a file: the automation
  // system, the hooks documents, and the management reader. They are carried
  // out now and the two loaders put them on the channel they already print
  // config warnings to.
  const semanticWarnings: ValidationIssue[] = [];
  runMatcherSemanticValidations(schemaConfig, AUTOMATIONS_CONFIG_FILE, semanticErrors, semanticWarnings);
  const warnings = semanticWarnings.map(issue => issue.path ? `${issue.path}: ${issue.message}` : issue.message);

  if (semanticErrors.length > 0) {
    const errors = semanticErrors.map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message);
    return { valid: false, errors, warnings, config: null };
  }

  return { valid: true, errors: [], warnings, config: schemaConfig };
}

/**
 * Run semantic validation checks for matcher definitions.
 * Shared by both object-based runtime validation and JSON-content validation.
 */
function runMatcherSemanticValidations(
  config: AutomationsConfig,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  for (const [event, matchers] of Object.entries(config.automations)) {
    if (!matchers) continue;
    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i];
      if (!matcher) continue;
      // Warn about the bypassPermissions permission mode
      if (matcher.permissionMode === 'bypassPermissions') {
        warnings.push({
          file,
          path: `automations.${event}[${i}].permissionMode`,
          message: 'permissionMode "bypassPermissions" bypasses all security checks — use with caution',
          severity: 'warning',
          suggestion: 'Consider using "plan" or "default" permission mode instead',
        });
      }

      if (matcher.matcher) {
        // C3.90 (owner answer QG5 = A, 2026-09-11) — the two spellings the page
        // gives one meaning and this product gives another, named where the
        // matcher is authored instead of only in the parity ledger.
        //
        // A NATIVE matcher (no `matchMode`) is an unanchored regex, which every
        // stored automation was written against; flipping that default would
        // silently re-scope them, which is why option B was refused and why this
        // row is a diagnostic rather than a semantics change.
        const claudeMode = matcher.matchMode === 'claude';
        if (!claudeMode && matcher.matcher.includes(',')) {
          warnings.push({
            file,
            path: `automations.${event}[${i}].matcher`,
            message: `Matcher "${matcher.matcher}" contains a comma. hooks.md#matcher-patterns reads a list as `
              + '"Exact string, or list of exact strings separated by `|` or `,` with optional surrounding whitespace", '
              + 'but that is the imported-hook contract; a native automation matcher is evaluated as an unanchored '
              + `regular expression, so the comma is a literal character and this matches only the text "${matcher.matcher}"`,
            severity: 'warning',
            suggestion: 'Use `|` to separate alternatives — the regex path reads it as alternation — or remove the matcher to match every occurrence',
          });
        }
        if (!claudeMode && matcher.matcher === '*') {
          // Kept an ERROR rather than demoted to a warning, because it already
          // is one: `new RegExp('*')` throws and the catch below returns false,
          // so this matcher can never fire. What C3.90 changes is that the
          // message now says WHY the documented spelling failed instead of
          // reporting "nothing to repeat".
          errors.push({
            file,
            path: `automations.${event}[${i}].matcher`,
            message: 'Matcher "*" is not a valid regular expression, and a native automation matcher is one. '
              + 'hooks.md#matcher-patterns gives `*` the meaning "matches every occurrence of the event", which is '
              + 'spelled here by omitting the matcher entirely',
            severity: 'error',
            suggestion: 'Remove the `matcher` field to match every occurrence, or write `.*`',
          });
        }
        // An imported matcher on the documented LITERAL path is not a regex at
        // all, so compiling it as one is a category error — and it was a live
        // defect: `*` (the page's own "matches every occurrence" spelling) threw
        // "nothing to repeat" here and `parseHooksConfig` drops the WHOLE hooks
        // document when validation fails, so one documented hook silently took
        // every other hook in the file with it. The length cap below still
        // applies; only the regex compile and the ReDoS heuristics are skipped,
        // and they are meaningless for a string that is compared literally.
        // The native `*` is skipped here too, so the author reads ONE sentence:
        // the specific refusal above instead of it plus "nothing to repeat".
        const skipRegexChecks = (claudeMode && isClaudeLiteralMatcher(matcher.matcher))
          || (!claudeMode && matcher.matcher === '*');
        // ReDoS prevention: limit regex complexity
        const MAX_REGEX_LENGTH = 500;
        if (matcher.matcher.length > MAX_REGEX_LENGTH) {
          errors.push({
            file,
            path: `automations.${event}[${i}].matcher`,
            message: `Regex pattern too long (${matcher.matcher.length} chars, max ${MAX_REGEX_LENGTH})`,
            severity: 'error',
            suggestion: 'Simplify the regex pattern or split into multiple matchers',
          });
        } else if (!skipRegexChecks) {
          try {
            // Validate regex syntax
            new RegExp(matcher.matcher);

            // Reject catastrophic backtracking (ReDoS) patterns
            // Detect nested quantifiers: a group containing a quantifier that itself has a quantifier
            const nestedQuantifiers = /\([^)]*[+*][^)]*\)[+*{]/;
            // Also detect repeated alternation like (a|a)+ and adjacent greedy quantifiers like .*.*
            const riskyPatterns = /(\.\*){2,}|(\.\+){2,}|\([^)]*\|[^)]*\)[+*{]/;
            if (nestedQuantifiers.test(matcher.matcher) || riskyPatterns.test(matcher.matcher)) {
              errors.push({
                file,
                path: `automations.${event}[${i}].matcher`,
                message: 'Regex pattern rejected: potential catastrophic backtracking (ReDoS)',
                severity: 'error',
                suggestion: 'Avoid nested quantifiers like (a+)+, (.*)+, (.+)*, ([a-z]+)+, and repeated alternation like (a|a)+',
              });
            }
          } catch (e) {
            errors.push({
              file,
              path: `automations.${event}[${i}].matcher`,
              message: `Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`,
              severity: 'error',
              suggestion: 'Fix the regex pattern or remove the matcher to match all events',
            });
          }
        }
      }

      // Validate cron expressions
      if (matcher.cron) {
        try {
          new Cron(matcher.cron);
        } catch (e) {
          errors.push({
            file,
            path: `automations.${event}[${i}].cron`,
            message: `Invalid cron expression: ${e instanceof Error ? e.message : 'Unknown error'}`,
            severity: 'error',
            suggestion: 'Use standard 5-field cron format: minute hour day-of-month month day-of-week',
          });
        }
      }

      // Validate timezone
      if (matcher.timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: matcher.timezone });
        } catch {
          errors.push({
            file,
            path: `automations.${event}[${i}].timezone`,
            message: `Invalid timezone: ${matcher.timezone}`,
            severity: 'error',
            suggestion: 'Use IANA timezone format like "Europe/Budapest" or "America/New_York"',
          });
        }
      }

      // Warn about webhook URLs with $VAR templates (can't validate until runtime)
      if (matcher.actions) {
        for (let j = 0; j < matcher.actions.length; j++) {
          const action = matcher.actions[j];
          // F1.1177 — a command's `args` that is not a list of strings fails `HookCommandActionSchema` and the
          // union's passthrough member keeps it as written, so the runner would read it as an argument vector.
          // Refused by path here instead, like any other malformed field (`hooks.md#command-hook-fields`, `args`).
          const args = action && typeof action === 'object' && action.type === 'command' && 'args' in action
            ? (action as { args?: unknown }).args
            : undefined;
          if (args !== undefined && !(Array.isArray(args) && args.every(arg => typeof arg === 'string'))) {
            errors.push({
              file,
              path: `automations.${event}[${i}].actions[${j}].args`,
              message: '`args` must be a list of strings, one argument each',
              severity: 'error',
              suggestion: 'Write the arguments as a JSON array of strings, or drop `args` to run `command` through the shell',
            });
          }
          // UB12.67 — the same passthrough hole for `onFailure`: a misspelled `"Block"` would be kept as written
          // and read as the default, so a policy hook its author meant to fail closed would fail open in silence.
          const onFailure = action && typeof action === 'object' && action.type === 'command' && 'onFailure' in action
            ? (action as { onFailure?: unknown }).onFailure
            : undefined;
          if (onFailure !== undefined && onFailure !== 'continue' && onFailure !== 'block') {
            errors.push({
              file,
              path: `automations.${event}[${i}].actions[${j}].onFailure`,
              message: '`onFailure` must be "continue" or "block"',
              severity: 'error',
              suggestion: 'Write "block" to block the action when the hook fails, or drop `onFailure` to let it go on',
            });
          }
          // UA8.1 — a script action runs only on App events (the host ScriptHandler); the runtime hook dispatch
          // never runs one, so on an agent event it is inert. Said here, where the author can act on it.
          // UB12.49 — a native prompt action is the same case: the PromptHandler takes App events only and the
          // runtime hook dispatch runs `plugin-prompt` judges, never a session-starting `prompt` (isInertHookBinding).
          if (action && typeof action === 'object' && (action.type === 'script' || action.type === 'prompt') && !(APP_EVENTS as string[]).includes(event)) {
            warnings.push({
              file,
              path: `automations.${event}[${i}].actions[${j}]`,
              message: `A ${action.type} action runs only on App events (${APP_EVENTS.join(', ')}); on ${event} it never runs`,
              severity: 'warning',
              suggestion: `Move the ${action.type} action to an App event such as SchedulerTick or LabelAdd`,
            });
          }
          // UB12.52 — on an agent event a webhook runs as an http hook, and hooks.md's per-event matrix withholds
          // http on SessionStart (hookTypeSupportedForEvent, isInertHookBinding), so there it never runs: said here,
          // and the template warning below (which promises a runtime check) is not printed for it.
          const webhookNeverRuns = action && typeof action === 'object' && action.type === 'webhook'
            && (AGENT_EVENTS as string[]).includes(event) && !hookTypeSupportedForEvent(event as AgentEvent, 'http');
          if (webhookNeverRuns) {
            warnings.push({
              file,
              path: `automations.${event}[${i}].actions[${j}]`,
              message: `A webhook action runs as an HTTP hook, and ${event} does not run HTTP hooks; on ${event} it never runs`,
              severity: 'warning',
              suggestion: 'Move the webhook action to another event such as UserPromptSubmit or PostToolUse, or use a command action',
            });
          }
          // UB12.52 — true on agent events as well since the hook executor expands a native webhook's url, headers
          // and body from the hook input and NESSY_WH_* before its safe-url and credential guards read them.
          if (!webhookNeverRuns && action && typeof action === 'object' && 'type' in action && action.type === 'webhook' && 'url' in action && typeof action.url === 'string' && action.url.includes('$')) {
            warnings.push({
              file,
              path: `automations.${event}[${i}].actions[${j}].url`,
              message: 'Webhook URL contains variable templates — will be validated at runtime after expansion',
              severity: 'warning',
              suggestion: 'Ensure the referenced NESSY_WH_* variables are set in your shell profile',
            });
          }
        }
      }

      // Warn if cron is used on non-SchedulerTick event
      if (matcher.cron && event !== 'SchedulerTick') {
        warnings.push({
          file,
          path: `automations.${event}[${i}].cron`,
          message: 'Cron expressions are only used for SchedulerTick events',
          severity: 'warning',
          suggestion: 'Move this automation to the SchedulerTick event or use matcher instead',
        });
      }

      // Validate conditions
      if (matcher.conditions && Array.isArray(matcher.conditions)) {
        validateConditionsArray(matcher.conditions, `automations.${event}[${i}].conditions`, event, file, errors, warnings, 0);
      }
    }
  }
}

/**
 * Validate automations config from a JSON string (no disk reads).
 * Used by PreToolUse automation to validate before writing to disk.
 * Follows the same pattern as other config validators in validators.ts.
 */
export function validateAutomationsContent(jsonString: string, fileName?: string): ValidationResult {
  const file = fileName ?? AUTOMATIONS_CONFIG_FILE;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = JSON.parse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = AutomationsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  // Semantic validations
  const config = result.data;

  // Check for empty automations
  const matcherCount = Object.values(config.automations).reduce(
    (sum, matchers) => sum + (matchers?.length ?? 0),
    0
  );
  if (matcherCount === 0) {
    warnings.push({
      file,
      path: 'automations',
      message: 'No automations configured',
      severity: 'warning',
      suggestion: 'Add automation definitions under event names like SessionStatusChange, LabelAdd, etc.',
    });
  }

  // Check for deprecated event aliases in the raw JSON (before transform rewrites them)
  try {
    const rawConfig = JSON.parse(jsonString) as { automations?: Record<string, unknown> };
    if (rawConfig.automations) {
      for (const event of Object.keys(rawConfig.automations)) {
        const canonical = DEPRECATED_EVENT_ALIASES[event];
        if (canonical) {
          warnings.push({
            file,
            path: `automations.${event}`,
            message: `Event '${event}' has been renamed to '${canonical}'. The old name still works but is deprecated.`,
            severity: 'warning',
            suggestion: `Rename '${event}' to '${canonical}' in your config`,
          });
        }
        // Same raw-JSON pass, same reason: the transform has already dropped a
        // documented event we do not emit, so this is the only place left that
        // can tell the author their entry is inert AND why. Read here rather
        // than from `config.automations`, which no longer contains it.
        const unemittedReason = UNEMITTED_HOOK_EVENT_REASONS[event];
        if (unemittedReason) {
          warnings.push({
            file,
            path: `automations.${event}`,
            message: `Event '${event}' is not supported by Nessy and never runs. ${unemittedReason}`,
            severity: 'warning',
            suggestion: `Remove the '${event}' entry from your config`,
          });
        }
      }
    }
  } catch {
    // JSON already validated above, this shouldn't happen
  }

  runMatcherSemanticValidations(config, file, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate automations.json from workspace path (reads from disk).
 * Follows the same pattern as other validators in validators.ts.
 */
export function validateAutomations(workspaceRoot: string): ValidationResult {
  const configPath = resolveAutomationsConfigPath(workspaceRoot);
  const file = 'automations.json';

  // Automations config is optional - no config means no automations (valid state)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'No automations configuration found (no automations configured)',
        severity: 'warning',
      }],
    };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Parse JSON once — validateAutomationsContent also parses, but we need the
  // parsed object for workspace-aware validations below
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate content (schema + semantic checks)
  const contentResult = validateAutomationsContent(raw);
  if (!contentResult.valid) {
    return contentResult;
  }

  // Additional workspace-aware validations
  const errors: ValidationIssue[] = [];
  const warnings = [...contentResult.warnings];

  // Validate labels, llmConnection slugs, and model compatibility
  try {
    const config = content as { automations?: Record<string, Array<{ labels?: string[]; actions?: Array<{ type: string; llmConnection?: string; model?: string; script?: string }> }>> };
    const labelEntries = config.automations;
    if (labelEntries) {
      for (const [event, matchers] of Object.entries(labelEntries)) {
        if (!matchers) continue;
        for (let i = 0; i < matchers.length; i++) {
          const matcher = matchers[i];
          if (matcher?.labels) {
            for (const label of matcher.labels) {
              // Extract label ID (handles "priority::3" -> "priority")
              const labelId = extractLabelId(label);
              if (!isValidLabelId(workspaceRoot, labelId)) {
                warnings.push({
                  file,
                  path: `automations.${event}[${i}].labels`,
                  message: `Label "${labelId}" does not exist in workspace`,
                  severity: 'warning',
                  suggestion: `Create this label in labels/config.json or use an existing label ID`,
                });
              }
            }
          }
          // Validate llmConnection slugs and model compatibility in prompt actions
          const actions = matcher?.actions;
          if (actions) {
            for (let j = 0; j < actions.length; j++) {
              const action = actions[j]!;

              // UA8.1 (upstream v0.13.4): warn when the workspace-relative script is missing — a warning, not an
              // error, since the file may be created later. Containment and approval are checked at run time.
              if (action.type === 'script' && typeof action.script === 'string' && action.script && !isAbsolute(action.script)) {
                if (!existsSync(join(workspaceRoot, action.script))) {
                  warnings.push({
                    file,
                    path: `automations.${event}[${i}].actions[${j}].script`,
                    message: `Script file not found in workspace: ${action.script}`,
                    severity: 'warning',
                    suggestion: 'Create the script or fix the path (relative to the workspace root)',
                  });
                }
              }

              if (action.type !== 'prompt') continue;

              if (action.llmConnection) {
                const connection = getLlmConnection(action.llmConnection);
                if (!connection) {
                  // Missing connection is an error — the automation will fail at runtime
                  // (falls back to default connection, which likely doesn't support the model)
                  errors.push({
                    file,
                    path: `automations.${event}[${i}].actions`,
                    message: `LLM connection "${action.llmConnection}" not found in config`,
                    severity: 'error',
                    suggestion: 'Check the connection slug in AI Settings or config.json',
                  });
                } else if (action.model) {
                  // Validate model is available for this connection
                  const availableModels = connection.models ?? getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider);
                  const modelIds = availableModels.map(m => typeof m === 'string' ? m : (m as ModelDefinition).id);
                  // Check exact match or suffix match (e.g. "haiku" matches "claude-haiku-4-5-20251001")
                  const modelValue = action.model;
                  const isAvailable = modelIds.some(id =>
                    id === modelValue || id.endsWith(`/${modelValue}`) ||
                    // Also match short aliases: "haiku" → any id containing "haiku", "sonnet" → "sonnet", etc.
                    id.toLowerCase().includes(modelValue.toLowerCase())
                  );
                  if (!isAvailable) {
                    warnings.push({
                      file,
                      path: `automations.${event}[${i}].actions`,
                      message: `Model "${modelValue}" may not be available on connection "${action.llmConnection}" (${connection.providerType})`,
                      severity: 'warning',
                      suggestion: `Available models: ${modelIds.slice(0, 5).join(', ')}${modelIds.length > 5 ? `, ... (${modelIds.length} total)` : ''}`,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // JSON already validated, this shouldn't happen
  }

  const allErrors = [...contentResult.errors, ...errors];
  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings,
  };
}

// ============================================================================
// Condition Validation Helpers
// ============================================================================

const VALID_WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const HH_MM_RE = /^\d{2}:\d{2}$/;

/** Events that have transition fields (from/to) */
const TRANSITION_EVENTS = new Set(['PermissionModeChange', 'SessionStatusChange']);

function validateConditionsArray(
  conditions: unknown[],
  basePath: string,
  event: string,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  depth: number,
): void {
  // Depth starts at 0 for top-level conditions; allowed depth indexes are
  // 0..MAX_CONDITION_DEPTH_EXCLUSIVE-1.
  if (depth > CONDITION_DEPTH_WARNING_THRESHOLD) {
    warnings.push({
      file,
      path: basePath,
      message: `Condition nesting depth ${depth} — consider simplifying`,
      severity: 'warning',
    });
  }
  if (depth >= MAX_CONDITION_DEPTH_EXCLUSIVE) {
    errors.push({
      file,
      path: basePath,
      message: `Condition nesting exceeds maximum depth of ${MAX_CONDITION_DEPTH_EXCLUSIVE}`,
      severity: 'error',
    });
    return;
  }

  for (let j = 0; j < conditions.length; j++) {
    const cond = conditions[j] as Record<string, unknown>;
    if (!cond || typeof cond !== 'object') continue;
    const path = `${basePath}[${j}]`;

    switch (cond.condition) {
      case 'time':
        validateTimeCondition(cond, path, file, errors);
        break;
      case 'state':
        validateStateCondition(cond, path, event, file, errors, warnings);
        break;
      case 'and':
      case 'or':
      case 'not':
        if (Array.isArray(cond.conditions) && cond.conditions.length > 0) {
          validateConditionsArray(cond.conditions, `${path}.conditions`, event, file, errors, warnings, depth + 1);
        }
        break;
    }
  }
}

function validateTimeCondition(
  cond: Record<string, unknown>,
  path: string,
  file: string,
  errors: ValidationIssue[],
): void {
  if (cond.after !== undefined && typeof cond.after === 'string') {
    if (!HH_MM_RE.test(cond.after)) {
      errors.push({ file, path: `${path}.after`, message: `Invalid time format: "${cond.after}" (expected HH:MM)`, severity: 'error' });
    } else {
      const [h, m] = cond.after.split(':').map(Number);
      if ((h ?? 0) > 23 || (m ?? 0) > 59) {
        errors.push({ file, path: `${path}.after`, message: `Invalid time value: "${cond.after}"`, severity: 'error' });
      }
    }
  }
  if (cond.before !== undefined && typeof cond.before === 'string') {
    if (!HH_MM_RE.test(cond.before)) {
      errors.push({ file, path: `${path}.before`, message: `Invalid time format: "${cond.before}" (expected HH:MM)`, severity: 'error' });
    } else {
      const [h, m] = cond.before.split(':').map(Number);
      if ((h ?? 0) > 23 || (m ?? 0) > 59) {
        errors.push({ file, path: `${path}.before`, message: `Invalid time value: "${cond.before}"`, severity: 'error' });
      }
    }
  }
  if (cond.weekday !== undefined && Array.isArray(cond.weekday)) {
    for (const day of cond.weekday) {
      if (typeof day === 'string' && !VALID_WEEKDAYS.has(day)) {
        errors.push({ file, path: `${path}.weekday`, message: `Invalid weekday: "${day}" (expected mon-sun)`, severity: 'error' });
      }
    }
  }
  if (cond.timezone !== undefined && typeof cond.timezone === 'string') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: cond.timezone });
    } catch {
      errors.push({ file, path: `${path}.timezone`, message: `Invalid timezone: "${cond.timezone}"`, severity: 'error' });
    }
  }
}

function validateStateCondition(
  cond: Record<string, unknown>,
  path: string,
  event: string,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  // Check operator exclusivity
  const hasValue = cond.value !== undefined;
  const hasFrom = cond.from !== undefined;
  const hasTo = cond.to !== undefined;
  const hasContains = cond.contains !== undefined;
  const hasNotValue = cond.not_value !== undefined;

  const operatorCount = (hasValue ? 1 : 0) + ((hasFrom || hasTo) ? 1 : 0) + (hasContains ? 1 : 0) + (hasNotValue ? 1 : 0);
  if (operatorCount === 0) {
    errors.push({ file, path, message: 'State condition must have at least one operator (value, from/to, contains, or not_value)', severity: 'error' });
  } else if (operatorCount > 1) {
    errors.push({ file, path, message: 'State condition must use exactly one operator group (value, from/to, contains, or not_value)', severity: 'error' });
  }

  // Warn if from/to used on non-transition events
  if ((hasFrom || hasTo) && !TRANSITION_EVENTS.has(event)) {
    warnings.push({
      file,
      path,
      message: `from/to transition checks are typically used with PermissionModeChange or SessionStatusChange events, not ${event}`,
      severity: 'warning',
    });
  }
}
