import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';
import { AGENT_EVENTS, UNEMITTED_HOOK_EVENT_REASONS, HOOK_NOTIFICATION_TYPES_WITHOUT_EMITTER, type AgentEvent, type AutomationMatcher, type AutomationsConfig } from './types.ts';
import { validateAutomationsConfig } from './validation.ts';

export const HOOKS_CONFIG_FILE = 'hooks.json';
export const USER_GLOBAL_HOOKS_CONFIG_FILE = 'hooks.json';

export interface HooksLoadResult {
  config: AutomationsConfig;
  errors: string[];
  /**
   * C3.90 — non-fatal matcher diagnostics, kept OUT of {@link errors} on
   * purpose: `AutomationSystem.reloadConfig` then treated a non-empty `errors`
   * as a failed reload (F1.229 turned a hook `errors` entry into a note there,
   * one saying its hooks will not run), so a comma in a matcher must not travel
   * that way. The loader prints these on its config-warnings channel.
   *
   * C3.284 — and the two notes that were already travelling that way now ride
   * here too. `parseHooksConfig` pushed the unemitted-EVENT note and P6.293's
   * Notification-with-no-emitter note into `errors`, and each of them says, in
   * as many words, that the hook is correct and simply has no producer HERE. A
   * portable hook therefore made a reload apply nothing at all. C3.90 routed
   * its own warnings around that path rather than widening it, and named the
   * defect while leaving it; this is the widening it named.
   */
  warnings?: string[];
  sources: string[];
  /**
   * hooks.md:612 — "To temporarily disable all hooks without removing them,
   * set `\"disableAllHooks\": true` in your settings file." Root-level key on
   * the hooks settings document; present only when the file spelled `true`
   * (omission and `false` are both absent — no drop, no behavior change).
   * This is the USER/PROJECT half of the documented pair; the managed half
   * lives on `ManagedPiPolicyV1.disableAllHooks` and outranks it.
   */
  disableAllHooks?: boolean;
}

const AGENT_EVENT_SET = new Set<string>(AGENT_EVENTS);

function emptyConfig(): AutomationsConfig {
  return { automations: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeMatchers(
  target: Record<string, AutomationMatcher[]>,
  source: Record<string, AutomationMatcher[]>,
): void {
  for (const [event, matchers] of Object.entries(source)) {
    target[event] = [...(target[event] ?? []), ...matchers];
  }
}

export function mergeAutomationsConfigs(...configs: AutomationsConfig[]): AutomationsConfig {
  const merged: Record<string, AutomationMatcher[]> = {};
  for (const config of configs) {
    mergeMatchers(merged, config.automations as Record<string, AutomationMatcher[]>);
  }
  return { automations: merged };
}

export function getUserGlobalHooksConfigPath(configDir = CONFIG_DIR): string {
  return join(configDir, USER_GLOBAL_HOOKS_CONFIG_FILE);
}

export function loadHooksConfigFile(filePath: string, sourceName = filePath): HooksLoadResult {
  if (!existsSync(filePath)) {
    return {
      config: emptyConfig(),
      errors: [],
      sources: [],
    };
  }
  try {
    const result = parseHooksConfigContent(readFileSync(filePath, 'utf-8'), sourceName);
    return {
      ...result,
      sources: result.sources.length > 0 ? [filePath] : [],
    };
  } catch (error) {
    return {
      config: emptyConfig(),
      errors: [`${sourceName}: ${error instanceof Error ? error.message : String(error)}`],
      sources: [],
    };
  }
}

/** Parse an already captured hooks/automations document without rediscovering disk. */
export function parseHooksConfigContent(content: string, sourceName = 'pinned capability'): HooksLoadResult {
  try {
    return parseHooksConfig(JSON.parse(content) as unknown, sourceName);
  } catch (error) {
    return {
      config: emptyConfig(),
      errors: [`${sourceName}: ${error instanceof Error ? error.message : String(error)}`],
      sources: [],
    };
  }
}

export function loadUserGlobalLifecycleHooksConfig(configDir = CONFIG_DIR): HooksLoadResult {
  const hooksPath = getUserGlobalHooksConfigPath(configDir);
  return loadHooksConfigFile(hooksPath, hooksPath);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function extractHooksMap(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.hooks !== undefined || raw.automations !== undefined) return raw.hooks ?? raw.automations;
  // The bare-map form doubles the root object as the event map; the root-level
  // settings key must not be read as an event name there.
  const { disableAllHooks: _disableAllHooks, ...map } = raw;
  return map;
}

function parseHooksConfig(raw: unknown, sourceName: string): HooksLoadResult {
  const disableAllHooks = isRecord(raw) && raw.disableAllHooks === true;
  const hookMap = extractHooksMap(raw);
  const disabledField = disableAllHooks ? { disableAllHooks: true as const } : {};
  if (!isRecord(hookMap)) {
    return {
      config: emptyConfig(),
      errors: [`${sourceName}: hooks must be an object keyed by lifecycle event name`],
      sources: [],
      ...disabledField,
    };
  }

  // Read BEFORE validation: the schema transform drops an event it does not
  // know, so by the time the `AGENT_EVENT_SET` loop below runs, a documented
  // event we deliberately do not emit is already gone and would leave the
  // author with nothing but a console line. Named here, it reaches the
  // `[AutomationSystem] Automation/hook config warnings` channel with the
  // reason attached.
  //
  // C3.284 — a NOTE, not an error. The document parsed, the matcher is valid,
  // and the only thing wrong with it is that this fork has no producer for that
  // event; making that fatal cost a reload EVERY automation in the file.
  const unemittedNotes = Object.keys(hookMap)
    .filter(event => UNEMITTED_HOOK_EVENT_REASONS[event])
    .map(event => `${sourceName}: ${event} is not supported by Nessy — ${UNEMITTED_HOOK_EVENT_REASONS[event]}`)
    // F1.1177 — the same kind of note for a Claude-shape handler this file loads and never runs (read here, before
    // the adapter renames the list), see {@link claudeHandlerTypeNotes}.
    .concat(claudeHandlerTypeNotes(hookMap, sourceName));

  const validation = validateAutomationsConfig({ automations: adaptClaudeHookGroups(hookMap) });
  if (!validation.valid || !validation.config) {
    // C3.284 — the notes stay notes even here. The document is genuinely
    // invalid and `errors` is non-empty on its own account, so carrying them
    // separately changes no verdict; it keeps ONE rule about where a note goes
    // instead of two that differ by branch.
    return {
      config: emptyConfig(),
      errors: validation.errors.map(error => `${sourceName}: ${error}`),
      warnings: unemittedNotes,
      sources: [],
      ...disabledField,
    };
  }

  const automations: Partial<Record<AgentEvent, AutomationMatcher[]>> = {};
  const errors: string[] = [];
  // C3.90 — the matcher diagnostics the validator raised, carried out under the
  // file's own name. A hooks document is authored by hand rather than through
  // the editor, so without this the comma warning would exist only for someone
  // who went looking for it in a file validator.
  // C3.284 — the unemitted-event notes join them, for the reason above.
  const warnings: string[] = [
    ...unemittedNotes,
    ...(validation.warnings ?? []).map(warning => `${sourceName}: ${warning}`),
  ];

  for (const [event, matchers] of Object.entries(validation.config.automations)) {
    if (!AGENT_EVENT_SET.has(event)) {
      errors.push(`${sourceName}: ${event} is not an agent lifecycle hook event`);
      continue;
    }
    // P6.293 — a Notification matcher naming a type this runtime never emits
    // VALIDATES and can never run. Registering it is not an error (the hook is
    // portable and correct; it simply has no producer here), so it is reported
    // on the same warnings channel as an unemitted EVENT rather than rejected.
    //
    // C3.284 — and that sentence is finally true of the MACHINE. It went into
    // `errors` until 2026-09-12, which was then the array `reloadConfig` read as
    // "apply nothing", so a hook the comment calls portable and correct turned
    // every automation in the workspace off on the next reload.
    //
    // Exact-match only, and that is deliberate: `matcher` is an unanchored regex
    // by default, so deciding whether an arbitrary pattern can only ever select
    // emitterless types would mean reasoning about the regex. The narrow form
    // catches the case people actually write — the type name typed literally —
    // and never misreports a broad matcher that also covers `permission_prompt`.
    if (event === 'Notification') {
      for (const matcher of matchers) {
        const reason = matcher.matcher ? HOOK_NOTIFICATION_TYPES_WITHOUT_EMITTER[matcher.matcher] : undefined;
        if (reason) {
          warnings.push(
            `${sourceName}: Notification matcher "${matcher.matcher}" is a documented type Nessy never emits, `
            + `so this hook will never run — ${reason}`,
          );
        }
      }
    }
    automations[event as AgentEvent] = [...(automations[event as AgentEvent] ?? []), ...matchers];
  }

  return {
    config: { automations: automations as AutomationsConfig['automations'] },
    errors,
    warnings,
    sources: Object.keys(automations).length > 0 ? [sourceName] : [],
    ...disabledField,
  };
}

export function loadLifecycleHooksConfig(workspaceRootPath: string): HooksLoadResult {
  const merged: AutomationsConfig[] = [];
  const errors: string[] = [];
  // C3.90 — carried beside `errors` rather than inside it; see the field's own
  // docblock for why; since F1.229 neither array reaches `reloadConfig`'s verdict.
  const warnings: string[] = [];
  const sources: string[] = [];
  let disableAllHooks = false;

  const workspaceConfigPath = join(workspaceRootPath, 'config.json');
  if (existsSync(workspaceConfigPath)) {
    try {
      const raw = readJsonFile(workspaceConfigPath);
      // The settings key is a root-level sibling of `hooks` and is honored even
      // when the file declares no hooks of its own.
      if (isRecord(raw) && raw.disableAllHooks === true) disableAllHooks = true;
      if (isRecord(raw) && raw.hooks !== undefined) {
        const result = parseHooksConfig({ hooks: raw.hooks }, 'config.json hooks');
        merged.push(result.config);
        errors.push(...result.errors);
        warnings.push(...(result.warnings ?? []));
        sources.push(...result.sources);
      }
    } catch (error) {
      errors.push(`config.json hooks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const hooksPath = join(workspaceRootPath, HOOKS_CONFIG_FILE);
  if (existsSync(hooksPath)) {
    try {
      const result = parseHooksConfig(readJsonFile(hooksPath), HOOKS_CONFIG_FILE);
      merged.push(result.config);
      errors.push(...result.errors);
      warnings.push(...(result.warnings ?? []));
      sources.push(...result.sources);
      if (result.disableAllHooks) disableAllHooks = true;
    } catch (error) {
      errors.push(`${HOOKS_CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    config: mergeAutomationsConfigs(...merged),
    errors,
    warnings,
    sources,
    ...(disableAllHooks ? { disableAllHooks: true } : {}),
  };
}

/**
 * F1.898 (origin SIT-ab, 2026-09-25) — a hooks document in CLAUDE'S settings
 * shape loads through every native door (the user-global, workspace and
 * project `hooks.json`, a workspace `config.json` `hooks` block).
 *
 * `hooks.md#configuration` nests a matcher group's handlers in an inner
 * `hooks: [...]` array; ours keys them off `actions`. The handler objects are
 * the same shape (`HookCommandActionSchema`), so a group carrying `hooks` and
 * no `actions` is renamed and tagged `matchMode: 'claude'`: its matcher was
 * written against the documented two-mode compare, which that tag selects.
 * This is the adapter `capabilities/claude-setup-import.ts` applied to an
 * imported `~/.claude/settings.json`, moved here so the import and a
 * hand-written file read one way. Before, such a file was refused whole
 * (`PermissionDenied.0.actions: expected array`) and none of its hooks ran.
 *
 * A handler's `if` (`hooks.md#common-fields`) is a HANDLER field there and a
 * MATCHER field here (`ifRule`, whose documented spelling `if` the schema
 * accepts), and the command schema strips a key it does not declare — left on
 * the handler, the filter would vanish and the hook would run on every call.
 * It is lifted onto the matcher; handlers whose `if` differ become one matcher
 * each, because one matcher carries one rule.
 *
 * A group spelling BOTH `actions` and `hooks` is left as written, so the strict
 * matcher schema names `hooks` rather than one list silently winning (the rule
 * `acceptDocumentedIfSpelling` keeps for `if`/`ifRule`). Our own `actions`
 * shape is never touched. (F1.1177: `args` is declared there now, so an
 * exec-form handler keeps its argument vector.) F1.1094 — `hooks.md#common-fields`:
 * a command handler's `timeout` (seconds) becomes `timeoutMs`, clamped to the
 * command schema's 120 s ceiling (the skill tier's rule, `runtime-skill-content.ts`),
 * a spelled `timeoutMs` winning; `statusMessage` is declared on the schema and rides
 * the action as on the plugin tier; `once` is dropped, which IS the contract here:
 * "Only honored for hooks declared in skill frontmatter; ignored in settings files
 * and agent frontmatter".
 *
 * F1.1176 — the EXIT-CODE contract is the authored format's too.
 * `hooks.md#other-exit-codes`: "For most hook events, exit code 2 is the only exit
 * code that blocks through the code alone. Without valid JSON on stdout, Claude
 * Code treats exit code 1 as a non-blocking error and proceeds with the
 * action." Ours blocks on ANY non-zero exit unless `blockOnNonZero` is `false`
 * (`getHookCommandPreToolDecision`), so a command handler in this shape gets
 * that `false` — the plugin tier's rule for `exitCodeContract: 'claude-three-way'`
 * (`pluginHookAction`, `capabilities/runtime-automations.ts`), with its
 * `WorktreeCreate` exemption: the same note says "any non-zero exit code from
 * `WorktreeCreate` aborts worktree creation". A handler that spells
 * `blockOnNonZero` itself keeps what it spelled. Before, an `exit 1` Stop hook
 * kept the agent working on its output and an `exit 1` PreToolUse hook blocked.
 */
export function adaptClaudeHookGroups(map: Record<string, unknown>): Record<string, unknown> {
  const adapted: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(map)) {
    adapted[event] = Array.isArray(groups) ? groups.flatMap(group => adaptClaudeHookGroup(group, event)) : groups;
  }
  return adapted;
}

function adaptClaudeHookGroup(group: unknown, event: string): unknown[] {
  if (!isRecord(group) || group.actions !== undefined || !Array.isArray(group.hooks)) return [group];
  const { hooks: handlers, ...rest } = group;
  const ruleOf = (handler: unknown): unknown => (isRecord(handler) ? handler.if : undefined);
  const toAction = (handler: unknown): unknown => {
    if (!isRecord(handler)) return handler;
    const { if: _rule, ...spelled } = handler;
    const action = spelled.type === 'command' ? claudeCommandTimeout(spelled) : spelled; // F1.1094
    const claudeExitContract = action.type === 'command' && !('blockOnNonZero' in action) && event !== 'WorktreeCreate';
    return claudeExitContract ? { ...action, blockOnNonZero: false } : action;
  };
  const toMatcher = (list: unknown[]): Record<string, unknown> => {
    const rule = ruleOf(list[0]);
    return { ...(rule !== undefined ? { if: rule } : {}), ...rest, matchMode: 'claude', actions: list.map(toAction) };
  };
  return new Set(handlers.map(ruleOf)).size <= 1
    ? [toMatcher(handlers)]
    : handlers.map(handler => toMatcher([handler]));
}

/**
 * F1.1177 — the Claude handler types a hooks file loads and never runs.
 * `hooks.md#common-fields`, `type`: "`"command"`, `"http"`, `"mcp_tool"`, `"prompt"`, or `"agent"`". The action
 * schema's passthrough member admits the four that are not `command`, and the settings tier's executor
 * (`executePluginHookAutomations`) runs `http`, `mcp_tool`, `prompt` and `agent` only as a plugin's typed actions,
 * so a hand-written one matched and did nothing, with no word anywhere. Each is named on the warnings channel, as
 * an unemitted event is. Residue, stated rather than built: they still do not run from a hooks file.
 */
const CLAUDE_HANDLER_TYPES_NOT_RUN: ReadonlySet<string> = new Set(['http', 'mcp_tool', 'prompt', 'agent']);

export function claudeHandlerTypeNotes(map: Record<string, unknown>, sourceName: string): string[] {
  const notes: string[] = [];
  for (const [event, groups] of Object.entries(map)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || group.actions !== undefined || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        const type = isRecord(handler) ? handler.type : undefined;
        if (typeof type !== 'string' || !CLAUDE_HANDLER_TYPES_NOT_RUN.has(type)) continue;
        notes.push(`${sourceName}: ${event} has a "${type}" handler, which Nessy does not run from a hooks file; `
          + 'of Claude\'s handler types only "command" runs there, so this one never runs');
      }
    }
  }
  return notes;
}

/** F1.1094 — a Claude command handler's `timeout` (seconds) as our `timeoutMs`; `once` dropped (ignored outside skills). */
function claudeCommandTimeout(handler: Record<string, unknown>): Record<string, unknown> {
  const { timeout, once: _once, ...action } = handler;
  if ('timeoutMs' in action || typeof timeout !== 'number' || !(timeout > 0)) return action;
  return { ...action, timeoutMs: Math.min(Math.round(timeout * 1000), 120_000) };
}
