import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateAutomationsConfig, validateAutomationsContent } from './validation.ts';
import { generateShortId, resolveAutomationsConfigPath } from './resolve-config-path.ts';
import { AGENT_EVENTS, APP_EVENTS } from './types.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { parsePermissionMode, type PermissionMode } from '../agent/mode-types.ts';

export type AutomationKind = 'scheduled' | 'event' | 'agentic';

export interface AutomationMutationAction {
  type: string;
  [key: string]: unknown;
}

export interface AutomationMutationFields {
  kind?: AutomationKind;
  event?: string;
  name?: string;
  matcher?: string;
  cron?: string;
  timezone?: string;
  permissionMode?: PermissionMode;
  /** Give each run of this task its own isolated worktree (desktop-scheduled-tasks.md:34). */
  worktree?: boolean;
  labels?: string[];
  enabled?: boolean;
  conditions?: unknown[];
  actions?: AutomationMutationAction[];
}

export interface AutomationCreateInput extends AutomationMutationFields {
  kind: AutomationKind;
  actions: AutomationMutationAction[];
}

export interface AutomationUpdateInput {
  automationId: string;
  patch: AutomationMutationFields;
}

export interface AutomationManagementResult {
  automationId: string;
  event: string;
  matcherIndex: number;
  configPath: string;
  automation: Record<string, unknown>;
}

export interface AutomationListEntry extends AutomationManagementResult {
  enabled: boolean;
}

type StoredMatcher = Record<string, unknown> & {
  id?: string;
  actions: AutomationMutationAction[];
  enabled?: boolean;
};

interface StoredAutomationsConfig {
  version?: number;
  automations: Record<string, StoredMatcher[]>;
}

const DEFAULT_CONFIG: StoredAutomationsConfig = {
  version: 2,
  automations: {},
};

const workspaceLocks = new Map<string, Promise<void>>();

export async function listAutomationEntries(workspaceRootPath: string): Promise<AutomationListEntry[]> {
  return withWorkspaceLock(workspaceRootPath, () => {
    const state = loadConfig(workspaceRootPath);
    if (state.changed) {
      writeConfig(state.configPath, state.config);
    }

    const entries: AutomationListEntry[] = [];
    for (const [event, matchers] of Object.entries(state.config.automations)) {
      for (let matcherIndex = 0; matcherIndex < matchers.length; matcherIndex++) {
        const matcher = matchers[matcherIndex];
        if (!matcher) continue;
        entries.push({
          automationId: matcher.id!,
          event,
          matcherIndex,
          configPath: state.configPath,
          automation: { ...matcher },
          enabled: matcher.enabled !== false,
        });
      }
    }
    return entries;
  });
}

export async function createAutomationEntry(
  workspaceRootPath: string,
  input: AutomationCreateInput,
): Promise<AutomationManagementResult> {
  return withWorkspaceLock(workspaceRootPath, () => {
    const state = loadConfig(workspaceRootPath);
    const event = resolveEventForMutation(input.kind, input);
    const matcher = buildMatcher(input, event, state.config);
    const matchers = state.config.automations[event] ?? [];
    matchers.push(matcher);
    state.config.automations[event] = matchers;
    writeConfig(state.configPath, state.config);
    return toResult(state.configPath, event, matchers.length - 1, matcher);
  });
}

export async function updateAutomationEntry(
  workspaceRootPath: string,
  input: AutomationUpdateInput,
): Promise<AutomationManagementResult> {
  return withWorkspaceLock(workspaceRootPath, () => {
    const state = loadConfig(workspaceRootPath);
    const found = findMatcherById(state.config, input.automationId);
    const currentKind = getKindForEvent(found.event);
    const nextKind = input.patch.kind ?? currentKind;
    const base = { ...found.matcher };

    if (nextKind !== 'scheduled' && nextKind !== currentKind && input.patch.cron === undefined) {
      delete base.cron;
    }

    const merged = { event: input.patch.event ?? found.event, ...base, ...withoutUndefined(input.patch) };
    const event = resolveEventForMutation(nextKind, { ...merged, kind: nextKind });
    const matcher = buildMatcher({ ...merged, kind: nextKind, actions: merged.actions }, event, state.config, input.automationId);

    // F1.1269 — same event: replace in place, so an edit keeps the automation's position in its list.
    if (event === found.event) {
      found.matchers[found.matcherIndex] = matcher;
      writeConfig(state.configPath, state.config);
      return toResult(state.configPath, event, found.matcherIndex, matcher);
    }

    found.matchers.splice(found.matcherIndex, 1);
    if (found.matchers.length === 0) {
      delete state.config.automations[found.event];
    }

    const target = state.config.automations[event] ?? [];
    target.push(matcher);
    state.config.automations[event] = target;
    writeConfig(state.configPath, state.config);
    return toResult(state.configPath, event, target.length - 1, matcher);
  });
}

export async function setAutomationEntryEnabled(
  workspaceRootPath: string,
  automationId: string,
  enabled: boolean,
): Promise<AutomationManagementResult> {
  return withWorkspaceLock(workspaceRootPath, () => {
    const state = loadConfig(workspaceRootPath);
    const found = findMatcherById(state.config, automationId);
    found.matcher.enabled = enabled;
    writeConfig(state.configPath, state.config);
    return toResult(state.configPath, found.event, found.matcherIndex, found.matcher);
  });
}

export async function duplicateAutomationEntry(
  workspaceRootPath: string,
  automationId: string,
): Promise<AutomationManagementResult> {
  return withWorkspaceLock(workspaceRootPath, () => {
    const state = loadConfig(workspaceRootPath);
    const found = findMatcherById(state.config, automationId);
    const matcher = { ...found.matcher, id: createUniqueId(state.config) };
    found.matchers.splice(found.matcherIndex + 1, 0, matcher);
    writeConfig(state.configPath, state.config);
    return toResult(state.configPath, found.event, found.matcherIndex + 1, matcher);
  });
}

export async function deleteAutomationEntry(workspaceRootPath: string, automationId: string): Promise<void> {
  return withWorkspaceLock(workspaceRootPath, () => {
    const state = loadConfig(workspaceRootPath);
    const found = findMatcherById(state.config, automationId);
    found.matchers.splice(found.matcherIndex, 1);
    if (found.matchers.length === 0) {
      delete state.config.automations[found.event];
    }
    writeConfig(state.configPath, state.config);
  });
}

export async function validateAutomationConfigFile(
  workspaceRootPath: string,
): Promise<{ valid: boolean; message: string }> {
  const configPath = resolveAutomationsConfigPath(workspaceRootPath);
  const json = existsSync(configPath)
    ? readFileSync(configPath, 'utf8')
    : serializeConfig(DEFAULT_CONFIG);
  const result = validateAutomationsContent(json);
  return {
    valid: result.valid,
    message: result.valid ? 'Automations config is valid.' : formatValidationErrors(result.errors),
  };
}

async function withWorkspaceLock<T>(workspaceRootPath: string, fn: () => T): Promise<T> {
  const previous = workspaceLocks.get(workspaceRootPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  workspaceLocks.set(workspaceRootPath, queued);

  await previous;
  try {
    return fn();
  } finally {
    release();
    if (workspaceLocks.get(workspaceRootPath) === queued) {
      workspaceLocks.delete(workspaceRootPath);
    }
  }
}

function loadConfig(workspaceRootPath: string): {
  configPath: string;
  config: StoredAutomationsConfig;
  changed: boolean;
} {
  const configPath = resolveAutomationsConfigPath(workspaceRootPath);
  const config = existsSync(configPath)
    ? parseConfig(readFileSync(configPath, 'utf8'))
    : structuredClone(DEFAULT_CONFIG);
  const changed = ensureMatcherIds(config);
  return { configPath, config, changed };
}

function parseConfig(json: string): StoredAutomationsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid automations config: ${message}`);
  }

  const validation = validateAutomationsConfig(parsed);
  if (!validation.valid) {
    throw new Error(`Invalid automations config: ${validation.errors.join('; ')}`);
  }

  const stored = parsed as Partial<StoredAutomationsConfig>;
  const automations = stored.automations ?? {};
  resolveStoredPermissionModes(automations);
  return {
    version: stored.version ?? 2,
    automations,
  };
}

/**
 * F1.1053 — every stored `permissionMode` is held as `parsePermissionMode` reads it, the one alias table every other
 * mode reader uses, so a retired spelling (F1.1050: `explore`, and its older `safe`) is held as `plan` and every
 * write in this module persists `plan`. The validator above reads it the same way, but this module keeps the RAW
 * JSON (so fields the schema does not name survive), and that is how an `explore` saved before F1.1050 was written
 * back verbatim by any later edit, of that automation or of any other in the file. A value the table cannot
 * resolve never gets here: the validator has already refused it.
 */
function resolveStoredPermissionModes(automations: Record<string, StoredMatcher[]>): void {
  for (const matchers of Object.values(automations)) {
    for (const matcher of Array.isArray(matchers) ? matchers : []) {
      if (typeof matcher?.permissionMode !== 'string') continue;
      const mode = parsePermissionMode(matcher.permissionMode);
      if (mode) matcher.permissionMode = mode;
    }
  }
}

function ensureMatcherIds(config: StoredAutomationsConfig): boolean {
  let changed = false;
  const seen = new Set<string>();

  for (const matchers of Object.values(config.automations)) {
    for (const matcher of matchers) {
      if (!matcher.id || seen.has(matcher.id)) {
        matcher.id = createUniqueId(config, seen);
        changed = true;
      }
      seen.add(matcher.id);
    }
  }

  return changed;
}

function resolveEventForMutation(kind: AutomationKind, fields: AutomationMutationFields): string {
  if (kind === 'scheduled') {
    if (fields.event && fields.event !== 'SchedulerTick') {
      throw new Error('Scheduled automations must use SchedulerTick.');
    }
    if (!fields.cron) {
      throw new Error('Scheduled automations require cron.');
    }
    return 'SchedulerTick';
  }

  if (kind === 'event') {
    if (!fields.event || !isAppEvent(fields.event)) {
      throw new Error('Event automations require an app event excluding SchedulerTick.');
    }
    if (fields.cron) {
      throw new Error('Event automations cannot set cron.');
    }
    return fields.event;
  }

  if (!fields.event || !isAgentEvent(fields.event)) {
    throw new Error('Agentic automations require an agent event.');
  }
  if (fields.cron) {
    throw new Error('Agentic automations cannot set cron.');
  }
  return fields.event;
}

function buildMatcher(
  fields: AutomationMutationFields & { actions?: AutomationMutationAction[] },
  event: string,
  config: StoredAutomationsConfig,
  automationId?: string,
): StoredMatcher {
  if (!fields.actions?.length) {
    throw new Error('Automation actions are required.');
  }

  const matcher: StoredMatcher = {
    id: automationId ?? createUniqueId(config),
    actions: fields.actions,
  };

  assignIfDefined(matcher, 'name', fields.name);
  assignIfDefined(matcher, 'matcher', event === 'SchedulerTick' ? undefined : fields.matcher);
  assignIfDefined(matcher, 'cron', event === 'SchedulerTick' ? fields.cron : undefined);
  assignIfDefined(matcher, 'timezone', fields.timezone);
  assignIfDefined(matcher, 'permissionMode', fields.permissionMode);
  assignIfDefined(matcher, 'worktree', fields.worktree);
  assignIfDefined(matcher, 'labels', fields.labels);
  assignIfDefined(matcher, 'enabled', fields.enabled);
  assignIfDefined(matcher, 'conditions', fields.conditions);

  return matcher;
}

function assignIfDefined(target: StoredMatcher, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function findMatcherById(config: StoredAutomationsConfig, automationId: string): {
  event: string;
  matchers: StoredMatcher[];
  matcherIndex: number;
  matcher: StoredMatcher;
} {
  for (const [event, matchers] of Object.entries(config.automations)) {
    const matcherIndex = matchers.findIndex((matcher) => matcher.id === automationId);
    if (matcherIndex >= 0) {
      const matcher = matchers[matcherIndex];
      if (matcher) return { event, matchers, matcherIndex, matcher };
    }
  }
  throw new Error(`Automation not found: ${automationId}`);
}

function getKindForEvent(event: string): AutomationKind {
  if (event === 'SchedulerTick') return 'scheduled';
  if (isAppEvent(event)) return 'event';
  if (isAgentEvent(event)) return 'agentic';
  throw new Error(`Unsupported automation event: ${event}`);
}

function isAppEvent(event: string): boolean {
  return event !== 'SchedulerTick' && (APP_EVENTS as string[]).includes(event);
}

function isAgentEvent(event: string): boolean {
  return (AGENT_EVENTS as string[]).includes(event);
}

function createUniqueId(config: StoredAutomationsConfig, extraSeen?: Set<string>): string {
  const existing = extraSeen ?? new Set(
    Object.values(config.automations).flatMap((matchers) =>
      matchers.map((matcher) => matcher.id).filter((id): id is string => Boolean(id))
    )
  );

  let id = generateShortId();
  while (existing.has(id)) {
    id = generateShortId();
  }
  return id;
}

function writeConfig(configPath: string, config: StoredAutomationsConfig): void {
  const json = serializeConfig(config);
  const result = validateAutomationsContent(json);
  if (!result.valid) {
    throw new Error(`Invalid automations config: ${formatValidationErrors(result.errors)}`);
  }
  mkdirSync(dirname(configPath), { recursive: true });
  atomicWriteFileSync(configPath, `${json}\n`);
}

function serializeConfig(config: StoredAutomationsConfig): string {
  return JSON.stringify({
    version: config.version ?? 2,
    automations: config.automations,
  }, null, 2);
}

function formatValidationErrors(errors: Array<{ path: string; message: string }>): string {
  return errors.map((error) => error.path ? `${error.path}: ${error.message}` : error.message).join('; ');
}

function toResult(
  configPath: string,
  event: string,
  matcherIndex: number,
  matcher: StoredMatcher,
): AutomationManagementResult {
  return {
    automationId: matcher.id!,
    event,
    matcherIndex,
    configPath,
    automation: { ...matcher },
  };
}

function withoutUndefined(fields: AutomationMutationFields): AutomationMutationFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as AutomationMutationFields;
}
