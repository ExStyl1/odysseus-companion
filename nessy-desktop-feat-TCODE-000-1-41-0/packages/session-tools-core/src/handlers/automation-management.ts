import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod/v3';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';

export const AutomationKindSchema = z.enum(['scheduled', 'event', 'agentic']);

export const AutomationActionInputSchema = z.object({
  type: z.string().min(1),
}).passthrough();

export const AutomationCreateSchema = z.object({
  kind: AutomationKindSchema,
  event: z.string().optional(),
  name: z.string().optional(),
  matcher: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  // F1.115 (origin `D1.430`'s residue) — the CEILING belongs on the field a
  // model reads, not only in the tool description. The enum keeps all six
  // members deliberately (F1.1050 retired `explore`): this list is the second spelling of
  // `PERMISSION_MODE_ORDER` (see below), and dropping the two refused ones
  // here would turn a named refusal into a spelling complaint while leaving
  // `assertPermissionModeWithinCeiling` the only real gate. So the schema
  // still accepts them and the description says what happens.
  permissionMode: z.enum(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']).optional()
    .describe('Permission mode for each run. "acceptEdits" or narrower; "auto" and "bypassPermissions" are refused for model-written automations because their runs are unattended. Omitted starts each run in "plan".'),
  /** desktop-scheduled-tasks.md:34 — per-task worktree isolation, default off. */
  worktree: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(z.unknown()).optional(),
  actions: z.array(AutomationActionInputSchema).min(1),
});

export const AutomationUpdateSchema = z.object({
  automationId: z.string().min(1),
  patch: AutomationCreateSchema.partial().extend({
    kind: AutomationKindSchema.optional(),
    actions: z.array(AutomationActionInputSchema).min(1).optional(),
  }),
});

export const AutomationListSchema = z.object({
  includeDisabled: z.boolean().optional(),
});

export const AutomationValidateSchema = z.object({});

export type AutomationCreateArgs = z.infer<typeof AutomationCreateSchema>;
export type AutomationUpdateArgs = z.infer<typeof AutomationUpdateSchema>;
export type AutomationListArgs = z.infer<typeof AutomationListSchema>;
export type AutomationValidateArgs = z.infer<typeof AutomationValidateSchema>;

type AutomationKind = z.infer<typeof AutomationKindSchema>;
type Matcher = Record<string, unknown> & {
  id?: string;
  enabled?: boolean;
  actions: Array<Record<string, unknown>>;
};
type Config = { version?: number; automations: Record<string, Matcher[]> };

const APP_EVENTS: readonly string[] = SHARED_APP_EVENTS; // F1.1206: shared's own lists (automations/types.ts, imported below), which the
const AGENT_EVENTS: readonly string[] = SHARED_AGENT_EVENTS; // manager path (automations/management.ts) reads too; a hand copy here had kept 12 of them (2026-10-01).

/**
 * Documented Claude hook events Nessy does not emit, so an automation on one
 * could only ever sit in the config and never run: shared's
 * `UNEMITTED_HOOK_EVENT_REASONS` itself, imported below (F1.1193 follow-up — no
 * longer a hand-synced copy; the copy had already dropped part of the reason).
 * That module has type-only imports, so it adds no runtime edge and no cycle.
 *
 * Named separately from "unknown event" on purpose: `Setup` is a real Claude
 * event, and an agent that reaches for it deserves the reason and the
 * replacement rather than a spelling complaint.
 */
export const UNEMITTED_AGENT_EVENTS: Readonly<Record<string, string>> = UNEMITTED_HOOK_EVENT_REASONS;

/**
 * D1.430 — the permission modes, least to most permissive: `PERMISSION_MODE_ORDER`
 * itself, imported below from `shared/src/agent/mode-types.ts` (F1.1193 — no
 * longer a hand-synced copy, so a mode change cannot drift it). Exported only so
 * a test can pin that identity. `AutomationCreateSchema.permissionMode` above is
 * the second spelling of the same list — a mode in the schema and not here is
 * refused by name rather than admitted silently, which is the safe direction.
 */
export const PERMISSION_MODES_LEAST_TO_MOST_PERMISSIVE: readonly string[] = PERMISSION_MODE_ORDER;

/**
 * D1.430 — the highest permission mode the MODEL-facing automation tools will
 * store, and the reason it is lower than the one a person gets.
 *
 * `automation_create` and `automation_update` are invocable by the model, the
 * field is stored verbatim, and `SessionManager.executePromptAutomation` hands
 * it to `createSession`, where `options.permissionMode` OUTRANKS the project
 * default and the workspace floor. Nothing clamped it:
 * `clampPermissionModeToParent` is applied to SUBAGENTS only, and the
 * first-activation responsibility dialog that guards `bypassPermissions`
 * everywhere else lives in the renderer, which this path never reaches. So a
 * model could write itself a scheduled automation whose runs are fresh sessions
 * in the mode where nothing prompts at all, carrying a prompt it wrote.
 *
 * The SHAPE of the answer is this fork's own `REMOTE_CLIENT_PERMISSION_MODE_CEILING`
 * (`shared/src/agent/mode-types.ts`): a caller that is not the person at the
 * machine gets a ceiling enforced on the SERVER rather than a control hidden in
 * a picker, "because the client is the one piece of this system an attacker can
 * replace". The model is such a caller.
 *
 * The VALUE is one rung lower than the remote client's `auto`, and the
 * difference is stated rather than assumed: a remote client is still a person
 * who answers cards, while an automation run is unattended BY CONSTRUCTION —
 * it fires on a cron tick or an event with nobody at the keyboard. `auto`
 * admits every tool up front and defers to a classifier, so under `auto` an
 * automation's shell can run on a judge's verdict with no one to see it;
 * `acceptEdits` and below still raise a card for anything that is not a write
 * inside the session's own roots.
 *
 * A REFUSAL, not a silent clamp: a model that asked for bypass and quietly got
 * `plan` would write a prompt for a mode its automation does not have and
 * meet the mismatch later, at run time, as a puzzling failure. The refusal
 * names the ceiling so the next call can be right.
 *
 * NOT applied to the RPC route (`server-core/src/handlers/rpc/automations.ts`),
 * which is a person acting in their own app through the Automations page. Their
 * records reach these handlers on the next edit and are preserved: the ceiling
 * is checked against the PATCH, so an unrelated `automation_update` leaves a
 * mode a person chose exactly as they left it.
 */
const TOOL_PERMISSION_MODE_CEILING = 'acceptEdits';

function assertPermissionModeWithinCeiling(mode: unknown): void {
  if (mode === undefined) return;
  const ceiling = PERMISSION_MODES_LEAST_TO_MOST_PERMISSIVE.indexOf(TOOL_PERMISSION_MODE_CEILING);
  const requested = PERMISSION_MODES_LEAST_TO_MOST_PERMISSIVE.indexOf(String(mode));
  // An unknown spelling is refused too — `indexOf` answers -1, which would read
  // as the narrowest mode and admit a name the order has not been taught.
  if (requested >= 0 && requested <= ceiling) return;
  throw new Error(
    `permissionMode "${String(mode)}" is above what this tool may set. An automation's runs are unattended, `
    + `so a mode wider than "${TOOL_PERMISSION_MODE_CEILING}" would execute tools with no approval and no dialog `
    + `anyone saw. Use "${TOOL_PERMISSION_MODE_CEILING}" or narrower, or ask the user to set the mode on the `
    + 'automation themselves in Automations.',
  );
}

/**
 * F1.113 + F1.228 — what `D1.430` left open, and the ONE test the permission
 * gate needs to close it.
 *
 * `D1.430` refuses a model that asks for a mode above {@link TOOL_PERMISSION_MODE_CEILING}.
 * It deliberately does NOT refuse an edit of an automation a PERSON set above
 * it (the Automations page is not ceilinged), so `automation_update` could still
 * change an automation that runs unattended under a mode the model could never
 * have set itself.
 *
 * DECIDED by the controller 2026-09-23 under the owner's delegation, balance
 * rule: **anything that changes WHAT or WHEN an automation stored above the
 * ceiling runs unattended asks the person** — a named card, not a refusal (that
 * would block the person's own edits) and not open. F1.113 covered WHAT (the
 * `actions`); F1.228 adds WHEN: re-enabling a disabled one (`enabled` false →
 * true), and its trigger or schedule (`kind`, `event`, `matcher`, `cron`,
 * `timezone`, and `conditions`, which gate whether a trigger fires at all).
 * Everything else — `name`, `labels`, `worktree`, disabling it — stays on the
 * ordinary path: none of it widens what runs or when.
 *
 * A field counts only when it CHANGES the stored value (a model that resends the
 * record unchanged is not asking for anything). A patch that also sets a mode is
 * left alone: that mode is either within the ceiling — then that is what will
 * run — or refused by the handler. F1.1166: the stored mode is read through the one alias table first, so
 * `explore` ranks as `plan` and `ask` as `default`; a spelling the table cannot resolve counts as ABOVE.
 *
 * This package answers only WHETHER a call is such an edit; the card is raised
 * by the host's permission gate (`shared/src/agent/core/pre-tool-use.ts`,
 * `runPreToolUseChecks`), the one place claude and Pi reach before a session
 * tool runs. `storedConfig` is the parsed `automations.json` — passed in rather
 * than read here so the gate owns the one file read.
 */
export interface UnattendedAutomationEdit {
  readonly automationId: string;
  readonly name?: string;
  readonly permissionMode: string;
  /** The patch fields that change what or when it runs, in a fixed order. */
  readonly changes: readonly string[];
}

/** The fields that decide WHAT an automation runs or WHEN (F1.113 + F1.228). */
const WHAT_OR_WHEN_FIELDS = ['actions', 'kind', 'event', 'matcher', 'cron', 'timezone', 'conditions'] as const;

/** Key-order-independent JSON, so a resent unchanged value compares equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

// F1.1166 — imported HERE, not at the top: `docs/**` cites this file's lines 1-56. `mode-types` is import-free
// apart from zod, the `source-test.ts` precedent for reaching one light shared module instead of copying it.
import { PERMISSION_MODE_ORDER, parsePermissionMode } from '@nessy-agent/shared/agent/mode-types';
// F1.1193 follow-up and F1.1206 — same placement; `automations/types` has type-only imports, so no runtime edge.
import { AGENT_EVENTS as SHARED_AGENT_EVENTS, APP_EVENTS as SHARED_APP_EVENTS, DEPRECATED_EVENT_ALIASES, formatAutomationListText, UNEMITTED_HOOK_EVENT_REASONS } from '@nessy-agent/shared/automations/types';

export function findUnattendedAutomationEdit(
  args: unknown,
  storedConfig: unknown,
): UnattendedAutomationEdit | undefined {
  const call = args as { automationId?: unknown; patch?: Record<string, unknown> } | null;
  if (!call || typeof call.automationId !== 'string' || !call.patch || typeof call.patch !== 'object') return undefined;
  const patch = call.patch;
  if (patch.permissionMode !== undefined) return undefined;
  const automations = (storedConfig as { automations?: unknown } | null)?.automations;
  if (!automations || typeof automations !== 'object') return undefined;
  for (const [event, matchers] of Object.entries(automations as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers as Array<Record<string, unknown>>) {
      if (!matcher || matcher.id !== call.automationId) continue;
      if (matcher.permissionMode === undefined) return undefined;
      // F1.1166 — as the store reads it (`shared/src/automations/management.ts`): a stored `explore` is `plan`.
      const stored = parsePermissionMode(String(matcher.permissionMode)) ?? String(matcher.permissionMode);
      const ceiling = PERMISSION_MODES_LEAST_TO_MOST_PERMISSIVE.indexOf(TOOL_PERMISSION_MODE_CEILING);
      const rank = PERMISSION_MODES_LEAST_TO_MOST_PERMISSIVE.indexOf(stored);
      if (rank >= 0 && rank <= ceiling) return undefined;
      let storedKind: string | undefined;
      try { storedKind = kindForEvent(event); } catch { storedKind = undefined; }
      const current: Record<string, unknown> = { ...matcher, event, kind: storedKind };
      const changes: string[] = WHAT_OR_WHEN_FIELDS.filter(field =>
        patch[field] !== undefined && stableJson(patch[field]) !== stableJson(current[field]));
      if (patch.enabled === true && matcher.enabled === false) changes.push('enabled');
      if (changes.length === 0) return undefined;
      return {
        automationId: call.automationId,
        ...(typeof matcher.name === 'string' && matcher.name.trim() ? { name: matcher.name } : {}),
        permissionMode: stored,
        changes,
      };
    }
  }
  return undefined;
}

export async function handleAutomationList(ctx: SessionToolContext, args: AutomationListArgs): Promise<ToolResult> {
  try {
    const parsed = AutomationListSchema.parse(args);
    if (ctx.automationManager) return ctx.automationManager.list(parsed);

    const state = loadConfig(ctx);
    if (state.changed) writeConfig(ctx, state.path, state.config);
    const automations = listEntries(state.path, state.config)
      .filter((entry) => parsed.includeDisabled || entry.enabled);
    return toolResult(formatAutomationListText(automations), { automations }); // F1.1265
  } catch (error) {
    return errorResponse(`automation_list failed: ${message(error)}`);
  }
}

export async function handleAutomationCreate(ctx: SessionToolContext, args: AutomationCreateArgs): Promise<ToolResult> {
  try {
    const parsed = AutomationCreateSchema.parse(args);
    // D1.430 — BEFORE the manager delegation, because both host managers
    // (`session-mcp-server`'s and `claude-context`'s) are reached through this
    // function and persist what they are handed. One check, all three routes.
    assertPermissionModeWithinCeiling(parsed.permissionMode);
    if (ctx.automationManager) return ctx.automationManager.create(parsed);

    const state = loadConfig(ctx);
    const event = resolveEvent(parsed.kind, parsed);
    const matcher = buildMatcher(parsed, event, state.config);
    const matchers = state.config.automations[event] ?? [];
    matchers.push(matcher);
    state.config.automations[event] = matchers;
    writeConfig(ctx, state.path, state.config);
    return resultFor('Created', state.path, event, matchers.length - 1, matcher);
  } catch (error) {
    return errorResponse(`automation_create failed: ${message(error)}`);
  }
}

export async function handleAutomationUpdate(ctx: SessionToolContext, args: AutomationUpdateArgs): Promise<ToolResult> {
  try {
    const parsed = AutomationUpdateSchema.parse(args);
    // D1.430 — the PATCH's own field, never the merged record's: the merge
    // below carries an existing `permissionMode` through from `found.matcher`,
    // so checking the result would refuse every later edit of an automation a
    // person deliberately set to bypass through the Automations page.
    assertPermissionModeWithinCeiling(parsed.patch.permissionMode);
    if (ctx.automationManager) return ctx.automationManager.update(parsed);

    const state = loadConfig(ctx);
    const found = findMatcher(state.config, parsed.automationId);
    const currentKind = kindForEvent(found.event);
    const nextKind = parsed.patch.kind ?? currentKind;
    const base: { event: string; [key: string]: unknown } = { event: found.event, ...found.matcher };
    if (nextKind !== 'scheduled' && nextKind !== currentKind && parsed.patch.cron === undefined) {
      delete base.cron;
    }
    const merged = { ...base, ...withoutUndefined(parsed.patch) };
    const event = resolveEvent(nextKind, { ...merged, kind: nextKind });
    const matcher = buildMatcher({ ...merged, kind: nextKind, actions: merged.actions }, event, state.config, parsed.automationId);

    // F1.1269 — same event: replace in place, so an edit keeps the automation's position (as shared's writer does).
    if (event === found.event) {
      found.matchers[found.matcherIndex] = matcher;
      writeConfig(ctx, state.path, state.config);
      return resultFor('Updated', state.path, event, found.matcherIndex, matcher);
    }
    found.matchers.splice(found.matcherIndex, 1);
    if (found.matchers.length === 0) delete state.config.automations[found.event];
    const target = state.config.automations[event] ?? [];
    target.push(matcher);
    state.config.automations[event] = target;
    writeConfig(ctx, state.path, state.config);
    return resultFor('Updated', state.path, event, target.length - 1, matcher);
  } catch (error) {
    return errorResponse(`automation_update failed: ${message(error)}`);
  }
}

export async function handleAutomationValidate(ctx: SessionToolContext, args: AutomationValidateArgs): Promise<ToolResult> {
  try {
    AutomationValidateSchema.parse(args);
    if (ctx.automationManager) return ctx.automationManager.validate({});

    const state = loadConfig(ctx);
    validateConfig(state.config);
    return toolResult('Automations config is valid.', { valid: true, message: 'Automations config is valid.' });
  } catch (error) {
    return errorResponse(`automation_validate failed: ${message(error)}`);
  }
}

function loadConfig(ctx: SessionToolContext): { path: string; config: Config; changed: boolean } {
  const path = join(ctx.workspacePath, 'automations.json');
  const config = ctx.fs.exists(path)
    ? normalizeConfig(JSON.parse(ctx.fs.readFile(path)))
    : { version: 2, automations: {} };
  return { path, config, changed: ensureIds(config) };
}

function normalizeConfig(value: unknown): Config {
  const input = value as Partial<Config>;
  return { version: input.version ?? 2, automations: rewriteDeprecatedEvents(input.automations ?? {}) };
}

/**
 * F1.1212 — a deprecated event key (`TodoStateChange`) is read as its canonical name, and the two lists merge in the
 * file's key order, exactly as shared's schema does on load (`automations/schemas.ts`, `DEPRECATED_EVENT_ALIASES`);
 * the next write then stores the canonical name. Before it, this fallback refused the key the manager path accepts.
 * A list that is not an array is kept as written, so `validateConfig` still names it. Only the table's OWN keys alias
 * and the result is built from a Map, so a key named `constructor` or a raw `__proto__` is refused under its own name.
 */
function rewriteDeprecatedEvents(automations: Record<string, Matcher[]>): Record<string, Matcher[]> {
  const out = new Map<string, Matcher[]>();
  for (const [event, matchers] of Object.entries(automations)) {
    const canonical = Object.hasOwn(DEPRECATED_EVENT_ALIASES, event) ? DEPRECATED_EVENT_ALIASES[event]! : event;
    const before = out.get(canonical);
    out.set(canonical, before === undefined ? matchers
      : Array.isArray(before) && Array.isArray(matchers) ? [...before, ...matchers]
        : Array.isArray(matchers) ? before : matchers);
  }
  return Object.fromEntries(out);
}

function ensureIds(config: Config): boolean {
  let changed = false;
  const seen = new Set<string>();
  for (const matchers of Object.values(config.automations)) {
    for (const matcher of matchers) {
      if (!matcher.id || seen.has(matcher.id)) {
        matcher.id = newId(seen);
        changed = true;
      }
      seen.add(matcher.id);
    }
  }
  return changed;
}

function resolveEvent(kind: AutomationKind, fields: Record<string, unknown>): string {
  const event = typeof fields.event === 'string' ? fields.event : undefined;
  const cron = typeof fields.cron === 'string' ? fields.cron : undefined;
  if (kind === 'scheduled') {
    if (event && event !== 'SchedulerTick') throw new Error('Scheduled automations must use SchedulerTick.');
    if (!cron) throw new Error('Scheduled automations require cron.');
    return 'SchedulerTick';
  }
  if (kind === 'event') {
    if (!event || event === 'SchedulerTick' || !APP_EVENTS.includes(event)) throw new Error('Event automations require an app event excluding SchedulerTick.');
    if (cron) throw new Error('Event automations cannot set cron.');
    return event;
  }
  if (event && UNEMITTED_AGENT_EVENTS[event]) throw new Error(`${event} automations are not supported: ${UNEMITTED_AGENT_EVENTS[event]}`);
  if (!event || !AGENT_EVENTS.includes(event)) throw new Error('Agentic automations require an agent event.');
  if (cron) throw new Error('Agentic automations cannot set cron.');
  return event;
}

function buildMatcher(
  fields: Record<string, unknown>,
  event: string,
  config: Config,
  automationId?: string,
): Matcher {
  const actions = fields.actions;
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('Automation actions are required.');

  const matcher: Matcher = { id: automationId ?? newId(existingIds(config)), actions: actions as Array<Record<string, unknown>> };
  assign(matcher, 'name', fields.name);
  assign(matcher, 'matcher', event === 'SchedulerTick' ? undefined : fields.matcher);
  assign(matcher, 'cron', event === 'SchedulerTick' ? fields.cron : undefined);
  assign(matcher, 'timezone', fields.timezone);
  assign(matcher, 'permissionMode', fields.permissionMode);
  assign(matcher, 'worktree', fields.worktree);
  assign(matcher, 'labels', fields.labels);
  assign(matcher, 'enabled', fields.enabled);
  assign(matcher, 'conditions', fields.conditions);
  return matcher;
}

function writeConfig(ctx: SessionToolContext, path: string, config: Config): void {
  validateConfig(config);
  const content = `${JSON.stringify({ version: config.version ?? 2, automations: config.automations }, null, 2)}\n`;
  if (ctx.fs.atomicWriteFile) {
    ctx.fs.atomicWriteFile(path, content);
  } else {
    ctx.fs.writeFile(path, content);
  }
}

function validateConfig(config: Config): void {
  for (const [event, matchers] of Object.entries(config.automations)) {
    if (Object.hasOwn(UNEMITTED_AGENT_EVENTS, event)) throw new Error(`Unsupported automation event: ${event} — ${UNEMITTED_AGENT_EVENTS[event]}`);
    if (![...APP_EVENTS, ...AGENT_EVENTS].includes(event)) throw new Error(`Unsupported automation event: ${event}`);
    if (!Array.isArray(matchers)) throw new Error(`Invalid automation matcher list for ${event}.`);
    for (const matcher of matchers) {
      if (!Array.isArray(matcher.actions) || matcher.actions.length === 0) throw new Error('At least one action required.');
      for (const action of matcher.actions) {
        if (!action || typeof action.type !== 'string' || action.type.length === 0) throw new Error('Automation action type is required.');
      }
      if (event === 'SchedulerTick' && typeof matcher.cron !== 'string') throw new Error('SchedulerTick automations require cron.');
      if (event !== 'SchedulerTick' && typeof matcher.cron === 'string') throw new Error('Cron is only valid for SchedulerTick automations.');
    }
  }
}

function listEntries(path: string, config: Config): Array<Record<string, unknown> & { enabled: boolean }> {
  const entries = [];
  for (const [event, matchers] of Object.entries(config.automations)) {
    for (let matcherIndex = 0; matcherIndex < matchers.length; matcherIndex++) {
      const matcher = matchers[matcherIndex];
      if (!matcher) continue;
      entries.push({
        automationId: matcher.id,
        event,
        matcherIndex,
        configPath: path,
        automation: { ...matcher },
        enabled: matcher.enabled !== false,
      });
    }
  }
  return entries;
}

function resultFor(action: string, path: string, event: string, matcherIndex: number, matcher: Matcher): ToolResult {
  const structuredContent = {
    automationId: matcher.id,
    event,
    matcherIndex,
    configPath: path,
    automation: { ...matcher },
  };
  return toolResult(`${action} automation ${matcher.id} under ${event}[${matcherIndex}].`, structuredContent);
}

function toolResult(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent, isError: false };
}

function findMatcher(config: Config, automationId: string) {
  for (const [event, matchers] of Object.entries(config.automations)) {
    const matcherIndex = matchers.findIndex((matcher) => matcher.id === automationId);
    if (matcherIndex >= 0) {
      const matcher = matchers[matcherIndex];
      if (matcher) return { event, matchers, matcherIndex, matcher };
    }
  }
  throw new Error(`Automation not found: ${automationId}`);
}

function kindForEvent(event: string): AutomationKind {
  if (event === 'SchedulerTick') return 'scheduled';
  if (APP_EVENTS.includes(event)) return 'event';
  if (AGENT_EVENTS.includes(event)) return 'agentic';
  throw new Error(`Unsupported automation event: ${event}`);
}

function existingIds(config: Config): Set<string> {
  return new Set(Object.values(config.automations).flatMap((matchers) =>
    matchers.map((matcher) => matcher.id).filter((id): id is string => Boolean(id))
  ));
}

function newId(seen: Set<string>): string {
  let id = randomBytes(3).toString('hex');
  while (seen.has(id)) id = randomBytes(3).toString('hex');
  return id;
}

function assign(target: Matcher, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
