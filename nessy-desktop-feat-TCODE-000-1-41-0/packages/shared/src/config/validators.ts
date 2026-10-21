/**
 * Config Validators
 *
 * Zod schemas and validation utilities for config files.
 * Used by agents to validate config changes before they take effect.
 *
 * Validates:
 * - config.json: Main app configuration
 * - preferences.json: User preferences
 * - sources/{slug}/config.json: Workspace-scoped source configs
 * - permissions.json: Permission rules (the read-only allowlist Plan and Don't ask use, deny rules)
 * - tool-icons/tool-icons.json: CLI tool icon mappings
 */

import { z } from 'zod';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from './paths.ts';
import { safeJsonParse, readJsonFileSync } from '../utils/files.ts';
import { EntityColorSchema } from '../colors/validate.ts';
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';
import { isValidProviderAuthCombination } from './llm-connections.ts';
import { SUPPORTED_LANGUAGE_CODES } from '../i18n/languages.ts';
import type { LanguageCode } from '../i18n/languages.ts';

// ============================================================
// Config Directory
// ============================================================

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// ============================================================
// Validation Result Types
// ============================================================

export interface ValidationIssue {
  file: string;
  path: string;  // JSON path like "workspaces[0].name"
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  fixed?: string[];
}

// ============================================================
// Zod Schemas
// ============================================================

// --- config.json ---

const StoredWorkspaceRefSchema = z.object({
  id: z.string().min(1),
  lastAccessedAt: z.number().int().nonnegative(),
}).strict();

// --- LLM Connection schema for config validation ---

const LlmProviderTypeSchema = z.enum([
  'anthropic', 'openai', 'openai_compat', 'pi', 'pi_compat', 'codex-runtime', 'claude-runtime',
  'nestor-cloud-agent', 'copilot',
  // Legacy values kept for config parsing tolerance (migrated at runtime):
  'anthropic_compat', 'bedrock', 'vertex',
]);

const LlmAuthTypeSchema = z.enum([
  'api_key', 'api_key_with_endpoint', 'oauth', 'iam_credentials',
  'bearer_token', 'service_account_file', 'environment', 'none',
]);

const CustomEndpointSchema = z.object({
  api: z.enum(['openai-completions', 'anthropic-messages']),
  // P6.258. Enumerated rather than a free header name, and optional so every
  // stored connection keeps parsing with the bearer default it has always had.
  credentialHeader: z.enum(['authorization', 'x-api-key']).optional(),
  supportsImages: z.boolean().optional(),
  // Added properly rather than left to ride the non-strict object: an
  // unvalidated key survives a round trip by accident, not by contract, and
  // nothing would catch a typo'd value.
  dialect: z.literal('qwen').optional(),
});

const LlmConnectionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  providerType: LlmProviderTypeSchema,
  authType: LlmAuthTypeSchema,
  baseUrl: z.string().optional(),
  models: z.array(z.union([z.string(), z.object({ id: z.string() }).passthrough()])).optional(),
  defaultModel: z.string().optional(),
  // P6.362 — an id this connection serves under another name. Declared rather
  // than left to `.passthrough()`: the envelope is what a reader can rely on.
  modelAliases: z.record(z.string(), z.string()).optional(),
  miniModel: z.string().optional(),
  modelSelectionMode: z.enum(['automaticallySyncedFromProvider', 'userDefined3Tier']).optional(),
  modelsSyncedAt: z.number().nullable().optional(),
  // DA2.12 — the catalogue refresh STAMP, which is not the enrolment marker
  // above; declared rather than left to `.passthrough()` for the reason this
  // block states: the envelope is what a reader can rely on.
  catalogueRefreshedAt: z.number().optional(),
  customEndpoint: CustomEndpointSchema.optional(),
  createdAt: z.number(),
  // Allow additional fields (codexPath, awsRegion, gcpProjectId, etc.)
}).passthrough();

// Alias-resolved through the shared mode table BEFORE the enum: persisted
// configs predate the vocabulary flip, so `safe`/`ask`/`allow-all`/`execute`
// must keep validating (they resolve to the internal keys). An unresolvable
// string passes through raw and the enum rejects it exactly as before.
const PermissionModeSchema = z.preprocess(
  value => (typeof value === 'string' ? parsePermissionMode(value) ?? value : value),
  z.enum(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']), // F1.1050: a stored `explore`/`safe` is read as `plan` by the preprocess above
);

export const ConfigDefaultsSchema = z.object({
  version: z.string(),
  description: z.string(),
  defaults: z.object({
    notificationsEnabled: z.boolean(),
    notificationTiming: z.enum(['never', 'background', 'always']),
    notificationPermissionAlerts: z.boolean(),
    notificationQuestionAlerts: z.boolean(),
    colorTheme: z.string(),
    autoCapitalisation: z.boolean(),
    sendMessageKey: z.enum(['enter', 'cmd-enter']),
    spellCheck: z.boolean(),
    keepAwakeWhileRunning: z.boolean(),
    richToolDescriptions: z.boolean(),
    extendedPromptCache: z.boolean(),
    browserToolEnabled: z.boolean(),
    allowRemoteEvaluate: z.boolean(),
    memoryEnabled: z.boolean(),
    macosSeatbeltBashSandboxEnabled: z.boolean(),
    // P6.202 — the read-side working-directory floor, shipped off.
    blockReadsOutsideWorkingDirectories: z.boolean(),
    mcpChannelPushEnabled: z.boolean(),
    autoCompactEnabled: z.boolean(),
    guardianEnabled: z.boolean(),
    // P3.2 — codex native auto-review. Both also live in config-defaults.json,
    // FALLBACK_CONFIG_DEFAULTS and the ConfigDefaults type.
    //
    // CORRECTED 2026-09-08 (P6.739): this comment used to say the declaration
    // stops `loadConfigDefaults` stripping the keys off the parsed defaults. It
    // does not — `loadConfigDefaults` reads the file with `readJsonFileSync`
    // and never parses it through this schema, so nothing is stripped at
    // runtime. What the declaration buys is the SHAPE GUARD: this schema is what
    // every `ConfigDefaults` fixture and both shipped copies are checked
    // against, so a key declared here cannot go missing from one of them.
    //
    // P6.811 — and since that row this schema ALSO runs at load, in
    // `syncConfigDefaults`, as a DIAGNOSTIC and never a rejection: a key
    // declared here but misspelled in the shipped file is now named to the
    // operator instead of silently not taking effect.
    codexAutoReviewEnabled: z.boolean(),
    codexAutoReviewPolicy: z.string(),
    // C3.109 — codex's delegation off-switch, declared at the same four sites.
    codexSubagentsEnabled: z.boolean(),
    // P2.1 — the advisor's two defaults. Both live here, in
    // `FALLBACK_CONFIG_DEFAULTS` and in the `ConfigDefaults` type: the
    // three-site rule the P0.2 lesson records at storage.ts.
    advisorEnabled: z.boolean(),
    advisorModel: z.string(),
    // P6.739 — P6.531's unattended floor, declared at the fourth site.
    // `unattended-approval-defaults.test.ts` pins this, the bundled asset,
    // `FALLBACK_CONFIG_DEFAULTS` and the resolver's own
    // `UNATTENDED_APPROVAL_FALLBACK_DEFAULT` equal, so a shipped floor cannot be
    // described one way and enforced another.
    unattendedApprovalFallback: z.enum(['deny', 'allow']),
    // settings.md: "Default: 30 days, minimum 1. … Setting 0 fails with a
    // validation error." A 0 already on disk is migrated, not rejected —
    // see resolveRetentionDecision in config/storage.ts.
    retentionDays: z.number().int().min(1),
    // P6.502 — the never-persist floor, declared at the fourth site so the
    // shipped asset, FALLBACK_CONFIG_DEFAULTS, the ConfigDefaults type and this
    // schema cannot disagree about whether it is on.
    neverPersistSessions: z.boolean(),
  }),
  workspaceDefaults: z.object({
    // OPTIONAL since R52: the bundled asset ships no `thinkingLevel`, so the
    // per-model default from `model-config.md:453` is reachable. A value
    // written by an older build still parses.
    thinkingLevel: z.enum([...THINKING_LEVEL_IDS, 'think'] as [string, ...string[]]).optional(),
    permissionMode: PermissionModeSchema,
    cyclablePermissionModes: z.array(PermissionModeSchema).min(2),
    maxAgentTurns: z.number().int().min(0),
    // P6.912 — `sessionAllowedTools` and `sessionDisallowedTools` USED TO BE
    // HERE, and being here is what made them unreachable: `syncConfigDefaults`
    // (`storage.ts`) writes the bundled asset over the user copy on every
    // launch and the bundled asset ships neither key, so a hand-written entry
    // was gone by the next start and P6.217's input was permanently empty on
    // every install. They live in `config.json` now, on the strict envelope
    // below. Declared nowhere in this object on purpose: a second home nobody
    // reads is the drift this whole file exists to prevent.
    maxBudgetUsd: z.number().min(0),
    // P6.645 — REQUIRED like its USD twin, not optional like `thinkingLevel`:
    // the bundled asset ships the key, and `syncConfigDefaults` rewrites the
    // user copy from the bundle on every launch, so an install can never be
    // left without it. Integer because a token ceiling is a count.
    maxBudgetTokens: z.number().int().min(0),
    // `model-config.md:364`'s chain. The legacy scalar keeps parsing forever;
    // `loadConfigDefaults` (storage.ts) is the real gate for the VALUE — this
    // schema decides no runtime value. Since P6.811 it is no longer test-only:
    // `syncConfigDefaults` runs it over the bundled file to name a missing or
    // misspelled key, and warns rather than rejecting.
    fallbackModel: z.union([z.string(), z.array(z.string())]),
    deferredMcpToolLoading: z.boolean(),
    localMcpServers: z.object({
      enabled: z.boolean(),
    }),
  }),
});


// DA1.72 — `StoredConfigKnownFields` and `StoredConfigTopLevelSchema` MOVED to
// `config/stored-config-load.ts`, beside the refusal that enforces them. They
// are re-exported from here so every existing importer is unchanged, and
// `StoredConfigSchema` below still spreads the same field map.
//
// WHY THEY MOVED, because it is not tidying: `loadStoredConfig` is the one
// reader of the strict envelope, and importing it from THIS module put the
// whole product graph behind every settings read — this file reaches
// `agent/permissions-config.ts` and `automations/index.ts`, each of which
// reaches 158 files including `credentials/index.ts`, `sessions/index.ts` and
// `docs/index.ts`. The field map is `z.unknown().optional()` throughout and
// needs nothing but zod, so it is the half that can leave.
//
// AGENTS.md rule 19 ("the strict envelope") still applies word for word; only
// the file changed. A new settings key is declared in
// `stored-config-load.ts`'s `StoredConfigKnownFields` AND in
// `StoredConfigSchema` below, in the SAME commit as its reader and the guard's
// fixture.
export { StoredConfigKnownFields, StoredConfigTopLevelSchema } from './stored-config-load.ts';
import { StoredConfigKnownFields } from './stored-config-load.ts';

export const StoredConfigSchema = z.object({
  ...StoredConfigKnownFields,
  storageLayoutVersion: z.literal(STORAGE_LAYOUT_VERSION),
  workspaceRefs: z.array(StoredWorkspaceRefSchema),
  activeWorkspaceId: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  llmConnections: z.array(LlmConnectionSchema).optional(),
  defaultLlmConnection: z.string().optional(),
  defaultThinkingLevel: z.enum([...THINKING_LEVEL_IDS, 'think'] as [string, ...string[]]).transform(v => v === 'think' ? 'medium' : v).optional(),
  defaultThinkingLevelExplicit: z.boolean().optional(),
  heldThinkingLevelModelId: z.string().optional(),
  // I2.5 — per-model effort, keyed by the model id this host resolves. Typed as
  // a record of the SAME enum `defaultThinkingLevel` uses minus the `think`
  // alias, because nothing writes it but our own setter, which normalizes
  // first. `validateConfig()` therefore names a hand-edited bad level.
  modelThinkingLevels: z.record(z.string(), z.enum([...THINKING_LEVEL_IDS] as [string, ...string[]])).optional(),
  // Typed to the same enum as `defaultThinkingLevel`, minus the `think` alias:
  // nothing writes this but our own setter, which normalizes first.
  lastReviewEffortLevel: z.enum([...THINKING_LEVEL_IDS] as [string, ...string[]]).optional(),
  retentionDays: z.number().int().min(1).optional(),
  retentionSweepEnabled: z.boolean().optional(),
  // Typed so validateConfig() reports a non-boolean here, rather than the
  // reader silently resolving it to "persist normally".
  neverPersistSessions: z.boolean().optional(),
  // settings-reference.md#crosssessioninbound: "string, one of" the three.
  // Typed so validateConfig() names a typo, which the page also warns about —
  // and since P6.939 it names it in the PAGE'S OWN WORDS rather than in zod's
  // bare enum list. The three clauses zod cannot carry are the point: the value
  // was ignored, messages are HELD while it is there, and fixing it clears the
  // hold. The enforcement module says the same sentence for the two `.claude/`
  // files, from the same function, so a user who meets both surfaces meets one
  // explanation.
  crossSessionInbound: z.enum(['accept', 'hold', 'refuse'], {
    error: issue => crossSessionInboundUnrecognizedSentence(
      describeUnrecognizedCrossSessionInbound((issue as { input?: unknown }).input),
    ),
  }).optional(),
  memoryEnabled: z.boolean().optional(),
  fileCheckpointingEnabled: z.boolean().optional(),
  autoMemoryDirectory: z.string().optional(),
  plansDirectory: z.string().optional(),
  bypassPermissionsAcknowledged: z.boolean().optional(),
  macosSeatbeltBashSandboxEnabled: z.boolean().optional(),
  // settings.md askUserQuestionTimeout: user settings only, default "never".
  askUserQuestionTimeout: z.enum(['60s', '5m', '10m', 'never']).optional(),
  // Typed here for the same reason `askUserQuestionTimeout` above is: the
  // production load path stays unknown-tolerant, and this shape only decides
  // what `validateConfig()` reports. Worth reporting because the reader's own
  // rule is that an unrecognised value resolves to `deny` — silently, and
  // deliberately, since a typo in a restriction must not open it. Reporting the
  // typo is the only way the operator learns their "allow" never took effect.
  unattendedApprovalFallback: z.enum(['deny', 'allow']).optional(),
  // P6.370, typed here for the same reason as the line above: the production
  // load path stays unknown-tolerant, so a non-boolean resolves to unset —
  // silently, and deliberately, because an unset value is the vendor's own
  // default. `validateConfig()` is then the only place a user learns their
  // `"false"` (a string) never turned the model switch off.
  claudeSwitchModelsOnFlag: z.boolean().optional(),
  // P6.313, typed for the same reason as the line above: the production load
  // path stays unknown-tolerant, so a non-boolean resolves to unset — silently,
  // and deliberately, because unset is the vendor's own default.
  // `validateConfig()` is then the only place a user learns their `"false"` (a
  // string) never removed Explore and Plan.
  claudeExplorePlanAgentsEnabled: z.boolean().optional(),
  // P6.515, typed for the same reason: the production load path stays
  // unknown-tolerant, so a value that is not a string resolves to unset and the
  // append silently never travels. `validateConfig()` is where a user learns
  // their array or object was ignored.
  systemPromptAppend: z.string().optional(),
  // P6.912, typed for the same reason: the production load path stays
  // unknown-tolerant, so a value that is not an array of strings resolves to
  // "no restriction" and the universe silently never binds — the failure
  // direction that leaves a session WIDER than the user asked for.
  // `validateConfig()` is where they learn it.
  sessionAllowedTools: z.array(z.string()).optional(),
  sessionDisallowedTools: z.array(z.string()).optional(),
  // P6.312, typed for the same reason: the production load path stays
  // unknown-tolerant, so an object or an array here resolves to "no pinned
  // agent" and the session silently runs as itself. `validateConfig()` is where
  // a user learns their value never took effect. The NAME is not checked
  // against the roster here — the roster is per session (a workspace's own
  // agent files) and this schema reads one file with no session in hand; an
  // unknown name is reported where the roster is known, on the same
  // degradation channel the runtime uses for every other agent it drops.
  sessionAgent: z.string().optional(),
  // P6.500, typed for the same reason: the production load path stays
  // unknown-tolerant, so a string `"100000"` here silently leaves the dialog on
  // the default threshold. `validateConfig()` is where a user learns the value
  // they wrote never took effect. Not bounded to a positive number: zero and
  // negative are the DOCUMENTED off switch, and a schema that refused them
  // would report the supported way to turn the dialog off as an error.
  reopenCompactPromptTokens: z.number().optional(),
  // P6.202, typed for the same reason: the production load path stays
  // unknown-tolerant, so a string `"true"` leaves the fence DOWN silently —
  // and a fence a user believes is up and is not is worse than no fence.
  // `validateConfig()` is where they learn it.
  blockReadsOutsideWorkingDirectories: z.boolean().optional(),
  // Extra filesystem roots for the permission gate. Validated and canonicalized
  // at read time by agent/additional-directories.ts, not here.
  additionalDirectories: z.array(z.string()).optional(),
  // C3.178 — which of those roots is primary. A path, typed here so
  // `validateConfig()` reports a non-string; the production load path stays
  // unknown-tolerant above and `resolveSessionPrimaryRoot` decides the VALUE.
  primaryDirectory: z.string().optional(),
  // `claudeMdExcludes` (large-codebases.md:155) and our own spelling. Glob
  // patterns or absolute paths; the production load path stays unknown-tolerant
  // above, so this shape only decides what validateConfig() reports.
  instructionExcludes: z.array(z.string()).optional(),
  claudeMdExcludes: z.array(z.string()).optional(),
  // env-vars.md:78's `env` block. Reported as malformed here when it is not a
  // string map, so `claude doctor`'s equivalent can say so — the value is not
  // applied to the process either way (R31 · f163a).
  env: z.record(z.string(), z.string()).optional(),
  // Note: tokenDisplay, showCost, cumulativeUsage, defaultPermissionMode removed
  // Permission mode and cyclable modes are now per-workspace in workspace config.json
}).strict();

// --- preferences.json ---

const LocationSchema = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
});

export const UserPreferencesSchema = z.object({
  name: z.string().optional(),
  timezone: z.string().optional(),  // TODO: Could validate against IANA timezone list
  location: LocationSchema.optional(),
  notes: z.string().optional(),
  // Internal: mirrors Appearance → Language. Not user-editable.
  // Validated against the registry-derived supported set.
  uiLanguage: z.enum([...SUPPORTED_LANGUAGE_CODES] as [LanguageCode, ...LanguageCode[]]).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).passthrough();

// ============================================================
// Validation Functions
// ============================================================

/**
 * Convert Zod error to ValidationIssues
 */
function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * Validate config.json
 */
export function validateConfig(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists
  if (!existsSync(CONFIG_FILE)) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: 'Config file does not exist',
        severity: 'error',
        suggestion: 'Run setup to create initial configuration',
      }],
      warnings: [],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = StoredConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'config.json'));
  } else {
    const config = result.data;

    // Semantic validations
    if (config.activeWorkspaceId) {
      const activeExists = config.workspaceRefs.some(w => w.id === config.activeWorkspaceId);
      if (!activeExists) {
        errors.push({
          file: 'config.json',
          path: 'activeWorkspaceId',
          message: `Active workspace ID '${config.activeWorkspaceId}' does not exist in workspaceRefs`,
          severity: 'error',
          suggestion: 'Set activeWorkspaceId to an existing workspace ID or null',
        });
      }
    }

    const seenWorkspaceRefs = new Set<string>();
    for (const [index, ref] of config.workspaceRefs.entries()) {
      if (seenWorkspaceRefs.has(ref.id)) {
        errors.push({
          file: 'config.json',
          path: `workspaceRefs.${index}.id`,
          message: `Duplicate workspace ref ID '${ref.id}'`,
          severity: 'error',
        });
      }
      seenWorkspaceRefs.add(ref.id);
    }

    // Validate LLM connections
    if (config.llmConnections) {
      const seenSlugs = new Set<string>();
      for (const [i, conn] of config.llmConnections.entries()) {
        // Check for duplicate slugs
        if (seenSlugs.has(conn.slug)) {
          errors.push({
            file: 'config.json',
            path: `llmConnections[${i}].slug`,
            message: `Duplicate connection slug '${conn.slug}'`,
            severity: 'error',
            suggestion: 'Each connection must have a unique slug',
          });
        }
        seenSlugs.add(conn.slug);

        // Validate provider/auth combination
        if (!isValidProviderAuthCombination(conn.providerType as any, conn.authType as any)) {
          warnings.push({
            file: 'config.json',
            path: `llmConnections[${i}]`,
            message: `Invalid provider/auth combination: providerType='${conn.providerType}' with authType='${conn.authType}'`,
            severity: 'warning',
            suggestion: 'Check supported auth types for this provider',
          });
        }
      }

      // Validate defaultLlmConnection references an existing connection
      if (config.defaultLlmConnection) {
        const exists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
        if (!exists) {
          warnings.push({
            file: 'config.json',
            path: 'defaultLlmConnection',
            message: `Default LLM connection '${config.defaultLlmConnection}' does not exist in llmConnections array`,
            severity: 'warning',
            suggestion: 'Set defaultLlmConnection to an existing connection slug',
          });
        }
      }
    }

  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate preferences.json
 */
export function validatePreferences(): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Check if file exists (preferences are optional)
  if (!existsSync(PREFERENCES_FILE)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'preferences.json',
        path: '',
        message: 'Preferences file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Parse JSON
  let content: unknown;
  try {
    const raw = readFileSync(PREFERENCES_FILE, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'preferences.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = UserPreferencesSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, 'preferences.json'));
  } else {
    const prefs = result.data;

    // Warn about missing recommended fields
    if (!prefs.name) {
      warnings.push({
        file: 'preferences.json',
        path: 'name',
        message: 'User name is not set',
        severity: 'warning',
        suggestion: 'Setting a name helps personalize agent responses',
      });
    }

    if (!prefs.timezone) {
      warnings.push({
        file: 'preferences.json',
        path: 'timezone',
        message: 'Timezone is not set',
        severity: 'warning',
        suggestion: 'Setting timezone helps with date/time formatting',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate the app-level config files, plus every workspace-scoped one when a
 * workspace root is given.
 *
 * ONE parameter, deliberately (P6.894). This used to read
 * `validateAll(workspaceId?, workspaceRoot?)` and gate the sources check on the
 * first argument and the other five on the second — but the two were never
 * different values. The first was only ever handed to `validateAllSources`,
 * which resolves it through `getWorkspaceSourcesPath(rootPath)` and therefore
 * wants a workspace ROOT PATH; its `workspaceId` name was simply wrong, and it
 * is what made a two-argument signature look meaningful.
 *
 * The cost of the split was silent: every caller reaches this through
 * `ValidatorInterface.validateAll(workspaceRootPath)`
 * (`session-tools-core/src/context.ts`), which has always declared exactly ONE
 * path argument, so both session contexts passed one — and skills, statuses,
 * labels, automations and permissions never ran on `config_validate --target
 * all`, on any runtime. Collapsing the parameters is what stops the two halves
 * drifting apart again: there is no second argument left to forget.
 *
 * @param workspaceRootPath - Optional absolute path to the workspace root
 *   folder. Omitted, only the three app-level files are checked.
 */
export function validateAll(workspaceRootPath?: string): ValidationResult {
  const results: ValidationResult[] = [
    validateConfig(),
    validatePreferences(),
    validateToolIcons(),
  ];

  // Every workspace-scoped validator takes the same workspace root path.
  if (workspaceRootPath) {
    results.push(validateAllSources(workspaceRootPath));
    results.push(validateAllSkills(workspaceRootPath));
    results.push(validateStatuses(workspaceRootPath));
    results.push(validateLabels(workspaceRootPath));
    results.push(validateAutomations(workspaceRootPath));
    results.push(validateAllPermissions(workspaceRootPath));
  }

  const allErrors = results.flatMap(r => r.errors);
  const allWarnings = results.flatMap(r => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// ============================================================
// Source & Agent Validators (Folder-Based Architecture)
// ============================================================

import { getWorkspaceSourcesPath } from '../workspaces/storage.ts';

// --- sources/{slug}/config.json ---

const SourceTypeSchema = z.enum(['mcp', 'api', 'local']);

// MCP source supports two transport types:
// - HTTP/SSE: requires url and authType
// - Stdio: requires command (and optional args, env)
const McpSourceConfigSchema = z.object({
  transport: z.enum(['http', 'sse', 'stdio']).optional(),
  // HTTP/SSE fields
  url: z.string().url().optional(),
  authType: z.enum(['oauth', 'bearer', 'none']).optional(),
  clientId: z.string().optional(),
  // Stdio fields
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Custom headers for HTTP/SSE transport (e.g., API keys, custom auth)
  headers: z.record(z.string(), z.string()).optional(),
  // Header names for credential-store auth (values stored in credential store as JSON)
  headerNames: z.array(z.string()).optional(),
}).refine(
  (data) => {
    if (data.transport === 'stdio') {
      // Stdio transport requires command
      return !!data.command;
    } else {
      // HTTP/SSE transport (default) requires url and authType
      return !!data.url && !!data.authType;
    }
  },
  {
    message: 'MCP config requires either (url + authType) for HTTP/SSE or (command) for stdio transport',
  }
);

const ApiOAuthConfigSchema = z.object({
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
});

const ApiSourceConfigSchema = z.object({
  baseUrl: z.string().url(),
  authType: z.enum(['bearer', 'header', 'query', 'basic', 'oauth', 'none']),
  headerName: z.string().optional(),
  headerNames: z.array(z.string()).optional(),
  queryParam: z.string().optional(),
  authScheme: z.string().optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  testEndpoint: z
    .object({
      method: z.enum(['GET', 'POST']),
      path: z.string(),
      body: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  googleService: z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'youtube', 'searchconsole']).optional(),
  googleScopes: z.array(z.string()).optional(),
  googleOAuthClientId: z.string().optional(),
  googleOAuthClientSecret: z.string().optional(),
  oauth: ApiOAuthConfigSchema.optional(),
});

const LocalSourceConfigSchema = z.object({
  path: z.string().min(1),
  format: z.string().optional(),
});

// Source brand schema
const SourceBrandSchema = z.object({
  color: EntityColorSchema.optional(),
});

export const FolderSourceConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  enabled: z.boolean(),
  provider: z.string().min(1),
  type: SourceTypeSchema,
  mcp: McpSourceConfigSchema.optional(),
  api: ApiSourceConfigSchema.optional(),
  local: LocalSourceConfigSchema.optional(),
  brand: SourceBrandSchema.optional(),
  connectorOrigin: z.object({
    pluginKey: z.string().min(1),
    connectorId: z.string().min(1),
    serverName: z.string().min(1),
    authTiming: z.enum(['ON_INSTALL', 'ON_FIRST_USE']).optional(),
  }).optional(),
  isAuthenticated: z.boolean().optional(),
  lastTestedAt: z.number().int().min(0).optional(),
  // Timestamps are optional - manually created configs may not have them
  // Storage functions add these automatically when saving
  createdAt: z.number().int().min(0).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).refine(
  (data) => {
    // Ensure correct config block exists for type
    switch (data.type) {
      case 'mcp': return !!data.mcp;
      case 'api': return !!data.api;
      case 'local': return !!data.local;
    }
  },
  { message: 'Config must include type-specific configuration (mcp, api, or local)' }
);

/**
 * Validate a source config object (in-memory, no disk reads)
 */
export function validateSourceConfig(config: unknown): ValidationResult {
  const result = FolderSourceConfigSchema.safeParse(config);

  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }

  return {
    valid: false,
    errors: zodErrorToIssues(result.error, 'config.json'),
    warnings: [],
  };
}

/**
 * Validate source config from a JSON string.
 * Used by PreToolUse hook to validate before writing to disk.
 */
export function validateSourceConfigContent(jsonString: string): ValidationResult {
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validateSourceConfig(content);
}

/**
 * Validate a source folder (workspace-scoped)
 */
export function validateSource(workspaceRootPath: string, slug: string): ValidationResult {
  // Renamed from `workspaceId` with its `validateAllSources` sibling (P6.894):
  // the value is a workspace ROOT PATH, which is what `getWorkspaceSourcesPath`
  // and the `ValidatorInterface.validateSource(workspaceRootPath, …)` port both
  // say, and the wrong name is what made a second `validateAll` argument look
  // like a second value.
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath);
  const file = `sources/${slug}/config.json`;
  const configPath = join(sourcesDir, slug, 'config.json');

  if (!existsSync(join(sourcesDir, slug))) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Source folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  if (!existsSync(configPath)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'config.json not found',
        severity: 'error',
        suggestion: 'Create a config.json file in the source folder',
      }],
      warnings: [],
    };
  }

  let content: unknown;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    content = safeJsonParse(raw);
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

  const result = validateSourceConfig(content);

  // Add warnings for missing guide.md
  const guidePath = join(sourcesDir, slug, 'guide.md');
  if (!existsSync(guidePath)) {
    result.warnings.push({
      file: `sources/${slug}/guide.md`,
      path: '',
      message: 'guide.md not found (recommended for usage guidelines)',
      severity: 'warning',
    });
  }

  return result;
}

/**
 * Validate all sources in a workspace
 *
 * @param workspaceRootPath - Absolute path to the workspace root folder. It was
 *   named `workspaceId` until P6.894 and never was one: the only thing done with
 *   it is `getWorkspaceSourcesPath(rootPath)`, and every caller — both session
 *   contexts and `ValidatorInterface.validateAllSources(workspaceRootPath)` —
 *   passes a path. The wrong name is what made `validateAll`'s two arguments
 *   look like two different values, and cost the five workspace-scoped
 *   validators their run on `--target all`.
 */
export function validateAllSources(workspaceRootPath: string): ValidationResult {
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(sourcesDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'Sources directory does not exist (no sources configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(sourcesDir);
  const sourceFolders = entries.filter((entry) => {
    const entryPath = join(sourcesDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (sourceFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'No sources configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of sourceFolders) {
    const result = validateSource(workspaceRootPath, folder);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Skill Validators
// ============================================================

import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { basename, extname } from 'path';
import {
  SkillMetadataSchema as SharedSkillMetadataSchema,
  validateSkillContent as validateSkillContentCore,
  type ValidationIssue as CoreValidationIssue,
} from '@nessy-agent/session-tools-core';

/**
 * Schema for skill metadata (SKILL.md frontmatter).
 *
 * ONE schema, shared with `session-tools-core`. This used to be a second,
 * narrower `z.object` that knew only `name`/`description`/`globs`/`alwaysAllow`
 * and silently stripped everything else, so the write-time PreToolUse check
 * passed a skill the runtime would reject — including a misspelt
 * `allowed-tool`, which since R17b is an enforced permission grant.
 */
export const SkillMetadataSchema = SharedSkillMetadataSchema;

/**
 * Find icon file in skill directory
 */
function findSkillIconForValidation(skillDir: string): string | null {
  const iconExtensions = ['.svg', '.png', '.jpg', '.jpeg'];

  for (const ext of iconExtensions) {
    const iconPath = join(skillDir, `icon${ext}`);
    if (existsSync(iconPath)) {
      return iconPath;
    }
  }

  return null;
}

/**
 * Validate a skill folder
 * @param workspaceRoot - Absolute path to workspace root folder
 * @param slug - Skill directory name
 */
export function validateSkill(workspaceRoot: string, slug: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');
  const file = `skills/${slug}/SKILL.md`;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 1. Check directory exists (slug format is validated by validateSkillContent below)
  if (!existsSync(skillDir)) {
    return {
      valid: false,
      errors: [{
        file: `skills/${slug}`,
        path: '',
        message: `Skill folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // 3. Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'SKILL.md not found',
        severity: 'error',
        suggestion: 'Create a SKILL.md file with YAML frontmatter',
      }],
      warnings: [],
    };
  }

  // 4. Read and validate content using content-based validator
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
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

  // Delegate content validation (frontmatter schema + body non-empty + slug format)
  const contentResult = validateSkillContent(content, slug);
  errors.push(...contentResult.errors);
  // ...including its warnings: an unknown frontmatter key is reported as a
  // warning, and dropping it here would silently re-hide the typo.
  warnings.push(...contentResult.warnings);

  // 5. FS-only checks: icon existence (warnings)
  const iconPath = findSkillIconForValidation(skillDir);
  if (iconPath) {
    const ext = extname(iconPath).toLowerCase();
    if (!['.svg', '.png', '.jpg', '.jpeg'].includes(ext)) {
      warnings.push({
        file: `skills/${slug}/${basename(iconPath)}`,
        path: '',
        message: `Unexpected icon format: ${ext}`,
        severity: 'warning',
        suggestion: 'Use .svg, .png, or .jpg for icons',
      });
    }
  } else {
    const searchTerm = slug.replace(/-/g, ' ');
    warnings.push({
      file: `skills/${slug}/`,
      path: 'icon',
      message: 'No icon found',
      severity: 'warning',
      suggestion: `Search for '${searchTerm} icon' on heroicons.com, lucide.dev, or icons8.com. Save as icon.svg in the skill folder.`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** Re-tag a `session-tools-core` issue with this package's file/severity fields. */
function skillIssues(
  issues: readonly CoreValidationIssue[],
  file: string,
  severity: 'error' | 'warning',
): ValidationIssue[] {
  return issues.map(issue => ({
    file,
    path: issue.path,
    message: issue.message,
    severity,
    ...(issue.suggestion === undefined ? {} : { suggestion: issue.suggestion }),
  }));
}

/**
 * Validate skill SKILL.md content from a string (no disk reads).
 * Used by the PreToolUse hook to validate before writing to disk.
 *
 * Delegates to the ONE skill validator (`session-tools-core`) and re-tags its
 * issues with this package's `file`/`severity` fields. It used to be a second
 * implementation over a second, narrower schema, so a skill the runtime would
 * reject validated clean at write time — a misspelt frontmatter key, an
 * unbalanced `allowed-tools` parenthesis (an enforced permission grant since
 * R17b) and an out-of-range `effort` all passed.
 *
 * @param markdownContent - The full SKILL.md file content
 * @param slug - The skill slug (folder name), used for slug format validation
 */
export function validateSkillContent(markdownContent: string, slug: string): ValidationResult {
  const file = `skills/${slug}/SKILL.md`;
  const result = validateSkillContentCore(markdownContent, slug);
  return {
    valid: result.valid,
    errors: skillIssues(result.errors, file, 'error'),
    warnings: skillIssues(result.warnings, file, 'warning'),
  };
}

/**
 * Validate all skills in a workspace
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateAllSkills(workspaceRoot: string): ValidationResult {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(skillsDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'Skills directory does not exist (no skills configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(skillsDir);
  const skillFolders = entries.filter((entry) => {
    const entryPath = join(skillsDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (skillFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'skills/',
        path: '',
        message: 'No skills configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of skillFolders) {
    const result = validateSkill(workspaceRoot, folder);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Status Validators
// ============================================================

const STATUS_CONFIG_FILE = 'statuses/config.json';

/** Required fixed statuses that must always exist */
const REQUIRED_FIXED_STATUS_IDS = ['todo', 'done', 'cancelled'] as const;

/**
 * Status icons are simple strings: emoji characters, URLs, or local filenames
 * such as "in-progress.svg" which resolve to statuses/icons/in-progress.svg.
 * When icon is omitted, local icon files (statuses/icons/{id}.svg) are still
 * auto-discovered at runtime.
 */
const StatusIconSchema = z.string();

/**
 * Zod schema for individual status configuration
 */
const StatusConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Status ID must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1, 'Status label is required'),
  color: EntityColorSchema.optional(),
  icon: StatusIconSchema.optional(),
  category: z.enum(['open', 'closed']),
  isFixed: z.boolean(),
  isDefault: z.boolean(),
  order: z.number().int().min(0),
});

/**
 * Zod schema for workspace status configuration
 */
const WorkspaceStatusConfigSchema = z.object({
  version: z.number().int().min(1),
  statuses: z.array(StatusConfigSchema),
  defaultStatusId: z.string().min(1),
});

/**
 * Validate statuses configuration for a workspace
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateStatuses(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, STATUS_CONFIG_FILE);
  const file = STATUS_CONFIG_FILE;

  // Check if config file exists (optional - defaults are used if missing)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Status config does not exist (using defaults)',
        severity: 'warning',
        suggestion: 'Statuses will use default configuration. Edit to customize.',
      }],
    };
  }

  // Read file and delegate to content-based validator
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

  // Icons are auto-discovered from statuses/icons/{id}.{ext} at runtime,
  // not referenced in config, so no FS checks needed here.
  return validateStatusesContent(raw);
}

/**
 * Validate statuses config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Runs schema validation and semantic checks. Skips icon file existence checks.
 */
export function validateStatusesContent(jsonString: string): ValidationResult {
  const file = 'statuses/config.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
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
  const result = WorkspaceStatusConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validations (same as validateStatuses but without FS checks)

  // 1. Check required fixed statuses exist
  const statusIds = new Set(config.statuses.map(s => s.id));
  for (const requiredId of REQUIRED_FIXED_STATUS_IDS) {
    if (!statusIds.has(requiredId)) {
      errors.push({
        file,
        path: 'statuses',
        message: `Required fixed status '${requiredId}' is missing`,
        severity: 'error',
        suggestion: `Add the '${requiredId}' status - it's required for the system to function`,
      });
    }
  }

  // 2. Check for duplicate IDs
  const seenIds = new Set<string>();
  for (const status of config.statuses) {
    if (seenIds.has(status.id)) {
      errors.push({
        file,
        path: `statuses[id=${status.id}]`,
        message: `Duplicate status ID '${status.id}'`,
        severity: 'error',
        suggestion: 'Each status must have a unique ID',
      });
    }
    seenIds.add(status.id);
  }

  // 3. Check defaultStatusId references an existing status
  if (!statusIds.has(config.defaultStatusId)) {
    errors.push({
      file,
      path: 'defaultStatusId',
      message: `Default status '${config.defaultStatusId}' does not exist in statuses array`,
      severity: 'error',
      suggestion: 'Set defaultStatusId to an existing status ID (typically "todo")',
    });
  }

  // 4. Check fixed statuses have correct isFixed flag
  for (const status of config.statuses) {
    const shouldBeFixed = (REQUIRED_FIXED_STATUS_IDS as readonly string[]).includes(status.id);
    if (shouldBeFixed && !status.isFixed) {
      warnings.push({
        file,
        path: `statuses[id=${status.id}].isFixed`,
        message: `Status '${status.id}' should have isFixed: true`,
        severity: 'warning',
        suggestion: 'This is a required system status and should be marked as fixed',
      });
    }
  }

  // 5. Check that at least one status is in each category
  const hasOpen = config.statuses.some(s => s.category === 'open');
  const hasClosed = config.statuses.some(s => s.category === 'closed');
  if (!hasOpen) {
    errors.push({
      file,
      path: 'statuses',
      message: 'No status with category "open" - sessions will not appear in inbox',
      severity: 'error',
    });
  }
  if (!hasClosed) {
    warnings.push({
      file,
      path: 'statuses',
      message: 'No status with category "closed" - sessions cannot be archived',
      severity: 'warning',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Labels Validators
// ============================================================

import { validateAutoLabelRule, validateSemanticAutoLabelRule } from '../labels/auto/validation.ts';

const LABEL_CONFIG_FILE = 'labels/config.json';

/** Maximum nesting depth for label tree (prevents excessively deep hierarchies) */
const MAX_LABEL_DEPTH = 5;

/**
 * Zod schema for individual label configuration.
 * Recursive: each label can have optional children forming a tree.
 * IDs are simple slugs (lowercase alphanumeric + hyphens).
 */
/**
 * Zod schema for auto-label rules. UB6.8 — the semantic (decision-model) kind joins the
 * regex kind as an alternative: a rule carries "pattern" OR "semantic" (a yes/no question
 * the decision model answers), never both (upstream v0.15.1's AutoLabelRuleSchema;
 * regex validity is checked semantically below).
 */
const AutoLabelRuleSchema = z.object({
  pattern: z.string().min(1, 'Auto-label rule pattern must not be empty').optional(),
  flags: z.string().optional(),
  valueTemplate: z.string().optional(),
  semantic: z.string().min(1, 'Semantic auto-label rule question must not be empty').optional(),
  threshold: z.number().gt(0, 'threshold must be greater than 0').max(1, 'threshold must be at most 1').optional(),
  value: z.string().optional(),
  description: z.string().optional(),
}).superRefine((rule, ctx) => {
  const hasPattern = rule.pattern !== undefined;
  const hasSemantic = rule.semantic !== undefined;
  if (!hasPattern && !hasSemantic) {
    ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'Auto-label rule needs a "pattern" (regex) or a "semantic" (yes/no question for the decision model)' });
  } else if (hasPattern && hasSemantic) {
    ctx.addIssue({ code: 'custom', path: ['semantic'], message: 'Auto-label rule must be either a regex rule ("pattern") or a semantic rule ("semantic"), not both' });
  }
  if (hasSemantic && !hasPattern) {
    if (rule.flags !== undefined) ctx.addIssue({ code: 'custom', path: ['flags'], message: 'Semantic rules have no regex flags' });
    if (rule.valueTemplate !== undefined) ctx.addIssue({ code: 'custom', path: ['valueTemplate'], message: 'Semantic rules use "value", not "valueTemplate"' });
  }
});

const BaseLabelConfigSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Label ID must be a simple slug (lowercase alphanumeric + hyphens, e.g., "bug", "frontend")'
  ),
  name: z.string().min(1, 'Label name is required'),
  color: EntityColorSchema.optional(),
  icon: z.string().optional(),
  /** Optional hint: what type of value this label carries (omit for boolean labels) */
  valueType: z.enum(['string', 'number', 'date', 'link']).optional(),
  /** Auto-label rules: regex patterns that scan messages and apply labels automatically */
  autoRules: z.array(AutoLabelRuleSchema).optional(),
});

// Recursive schema: LabelConfig can have children which are also LabelConfigs.
// Zod supports lazy() for recursive types.
type LabelConfigSchemaType = z.ZodType<{
  id: string;
  name: string;
  color?: unknown;
  icon?: string;
  valueType?: 'string' | 'number' | 'date' | 'link';
  autoRules?: Array<{ pattern: string; flags?: string; valueTemplate?: string; description?: string }>;
  children?: LabelConfigSchemaType[];
}>;

const LabelConfigSchema: z.ZodType<any> = BaseLabelConfigSchema.extend({
  children: z.lazy(() => z.array(LabelConfigSchema)).optional(),
});

/**
 * Zod schema for workspace label configuration (recursive tree)
 */
const WorkspaceLabelConfigSchema = z.object({
  version: z.number().int().min(1),
  labels: z.array(LabelConfigSchema),
});

/**
 * Validate labels configuration for a workspace (reads from disk)
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateLabels(workspaceRoot: string): ValidationResult {
  const configPath = join(workspaceRoot, LABEL_CONFIG_FILE);
  const file = LABEL_CONFIG_FILE;

  // Labels config is optional — no config means no labels (valid state)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Labels config does not exist (no labels configured)',
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

  return validateLabelsContent(raw);
}

/**
 * Validate labels config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks schema validation and semantic rules (unique IDs, max depth).
 */
export function validateLabelsContent(jsonString: string): ValidationResult {
  const file = 'labels/config.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
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

  // Validate schema (recursive, includes EntityColor validation via Zod)
  const result = WorkspaceLabelConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // 1. Check for globally unique IDs across the entire tree
  const seenIds = new Set<string>();
  function checkUniqueIds(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (seenIds.has(label.id)) {
        errors.push({
          file,
          path: `${path}[${i}].id`,
          message: `Duplicate label ID '${label.id}' — IDs must be globally unique across the tree`,
          severity: 'error',
          suggestion: 'Each label must have a unique ID regardless of nesting level',
        });
      }
      seenIds.add(label.id);
      if (label.children && label.children.length > 0) {
        checkUniqueIds(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkUniqueIds(config.labels, 'labels');

  // 2. Check max nesting depth (prevents excessively deep hierarchies)
  function checkDepth(labels: any[], depth: number, path: string): void {
    if (depth > MAX_LABEL_DEPTH) {
      errors.push({
        file,
        path,
        message: `Label tree exceeds maximum depth of ${MAX_LABEL_DEPTH} levels`,
        severity: 'error',
        suggestion: `Flatten the hierarchy — ${MAX_LABEL_DEPTH} levels should be sufficient for any organization scheme`,
      });
      return;
    }
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.children && label.children.length > 0) {
        checkDepth(label.children, depth + 1, `${path}[${i}].children`);
      }
    }
  }
  checkDepth(config.labels, 1, 'labels');

  // 3. Validate auto-label rules (regex patterns on regular labels)
  function checkAutoRules(labels: any[], path: string): void {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label.autoRules && Array.isArray(label.autoRules)) {
        for (let j = 0; j < label.autoRules.length; j++) {
          const rule = label.autoRules[j];
          // UB6.8 — a semantic (decision-model) rule: a question + threshold, validated as its own kind
          // (the "value is ignored" warning rides the label's valueType, per the row's RT-b hunk).
          if (rule && typeof rule.semantic === 'string' && rule.pattern === undefined) {
            const ruleResult = validateSemanticAutoLabelRule(rule, { valueType: label.valueType });
            for (const err of ruleResult.errors) {
              errors.push({
                file,
                path: `${path}[${i}].autoRules[${j}].semantic`,
                message: err,
                severity: 'error',
                suggestion: 'Fix the semantic question or remove the rule',
              });
            }
            for (const warn of ruleResult.warnings) {
              warnings.push({
                file,
                path: `${path}[${i}].autoRules[${j}].semantic`,
                message: warn,
                severity: 'warning',
              });
            }
          } else if (rule && rule.pattern) {
            const ruleResult = validateAutoLabelRule(rule.pattern, rule.flags, { valueType: label.valueType, valueTemplate: rule.valueTemplate });
            for (const err of ruleResult.errors) {
              errors.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: err,
                severity: 'error',
                suggestion: 'Fix the regex pattern or remove the rule',
              });
            }
            for (const warn of ruleResult.warnings) {
              warnings.push({
                file,
                path: `${path}[${i}].autoRules[${j}].pattern`,
                message: warn,
                severity: 'warning',
              });
            }
          } else {
            errors.push({
              file,
              path: `${path}[${i}].autoRules[${j}]`,
              message: 'Auto-label rule must have a "pattern" field',
              severity: 'error',
              suggestion: 'Add a regex pattern string to the rule',
            });
          }
        }
      }
      if (label.children && label.children.length > 0) {
        checkAutoRules(label.children, `${path}[${i}].children`);
      }
    }
  }
  checkAutoRules(config.labels, 'labels');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================
// Permissions Validators
// ============================================================

import { PermissionsConfigSchema } from '../agent/mode-types.ts';
import { isParseableColor } from './theme-roles.ts';
import {
  validatePermissionsConfig,
  getWorkspacePermissionsPath,
  getSourcePermissionsPath,
  getAppPermissionsDir,
} from '../agent/permissions-config.ts';
import { validateAutomationsContent, validateAutomations, AUTOMATIONS_CONFIG_FILE } from '../automations/index.ts';

/**
 * Internal: Validate a single permissions.json file
 * Checks JSON syntax, Zod schema, and regex pattern validity.
 */
function validatePermissionsFile(filePath: string, displayFile: string): ValidationResult {
  // File is optional - missing is just a warning
  if (!existsSync(filePath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: displayFile,
        path: '',
        message: 'Permissions file does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content-based validator
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  return validatePermissionsContent(raw, displayFile);
}

/**
 * Validate permissions config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Runs Zod schema validation and regex pattern compilation checks.
 *
 * @param jsonString - The raw JSON content of the permissions file
 * @param displayFile - File name for error messages (e.g., 'permissions.json' or 'sources/github/permissions.json')
 */
export function validatePermissionsContent(jsonString: string, displayFile: string = 'permissions.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = PermissionsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  // Validate regex patterns (semantic validation)
  const regexErrors = validatePermissionsConfig(result.data);
  for (const regexError of regexErrors) {
    errors.push({
      file: displayFile,
      path: regexError.split(':')[0] || '',
      message: regexError,
      severity: 'error',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

/**
 * Validate workspace-level permissions.json
 * @param workspaceRoot - Absolute path to workspace root folder
 */
export function validateWorkspacePermissions(workspaceRoot: string): ValidationResult {
  const permissionsPath = getWorkspacePermissionsPath(workspaceRoot);
  return validatePermissionsFile(permissionsPath, 'permissions.json');
}

/**
 * Validate source-level permissions.json
 * @param workspaceRoot - Absolute path to workspace root folder
 * @param sourceSlug - Source slug
 */
export function validateSourcePermissions(workspaceRoot: string, sourceSlug: string): ValidationResult {
  const permissionsPath = getSourcePermissionsPath(workspaceRoot, sourceSlug);
  return validatePermissionsFile(permissionsPath, `sources/${sourceSlug}/permissions.json`);
}

/**
 * Validate app-level default permissions
 */
export function validateDefaultPermissions(): ValidationResult {
  const permissionsPath = join(getAppPermissionsDir(), 'default.json');
  return validatePermissionsFile(permissionsPath, 'permissions/default.json');
}

/**
 * Validate all permissions files in a workspace
 * Includes: app-level default, workspace-level, and all source-level permissions
 */
export function validateAllPermissions(workspaceRoot: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Validate app-level default permissions
  const defaultResult = validateDefaultPermissions();
  errors.push(...defaultResult.errors);
  warnings.push(...defaultResult.warnings);

  // Validate workspace-level permissions
  const wsResult = validateWorkspacePermissions(workspaceRoot);
  errors.push(...wsResult.errors);
  warnings.push(...wsResult.warnings);

  // Validate all source-level permissions
  const sourcesDir = join(workspaceRoot, 'sources');
  if (existsSync(sourcesDir)) {
    const entries = readdirSync(sourcesDir);
    for (const entry of entries) {
      const entryPath = join(sourcesDir, entry);
      if (statSync(entryPath).isDirectory()) {
        const srcResult = validateSourcePermissions(workspaceRoot, entry);
        errors.push(...srcResult.errors);
        warnings.push(...srcResult.warnings);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check if a permissions file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidPermissionsFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validatePermissionsContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Theme Validators
// ============================================================

const CSSColorSchema = z.string().min(1);

const ThemeDarkOverrideSchema = z.object({
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
}).strict();

/**
 * Zod schema for app-level theme override files (~/.nessy-agent/theme.json).
 * Allows partial overrides but rejects unknown keys.
 */
export const ThemeOverrideSchema = z.object({
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: ThemeDarkOverrideSchema.optional(),
}).strict()
  .refine(
    (data) => {
      const keys = Object.keys(data);
      return keys.length > 0;
    },
    { message: 'Theme override must include at least one supported field' }
  )
  .refine(
    (data) => data.mode !== 'scenic' || Boolean(data.backgroundImage),
    { message: 'backgroundImage is required when mode is scenic', path: ['backgroundImage'] }
  );

/**
 * Zod schema for preset theme files.
 * Validates theme structure and requires at least one color property.
 */
export const PresetThemeSchema = z.object({
  name: z.string().min(1, 'Theme name is required'),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  source: z.string().optional(),
  supportedModes: z.array(z.enum(['light', 'dark'])).optional(),
  // Semantic colors
  background: CSSColorSchema.optional(),
  foreground: CSSColorSchema.optional(),
  accent: CSSColorSchema.optional(),
  info: CSSColorSchema.optional(),
  success: CSSColorSchema.optional(),
  destructive: CSSColorSchema.optional(),
  // Surface colors
  paper: CSSColorSchema.optional(),
  navigator: CSSColorSchema.optional(),
  input: CSSColorSchema.optional(),
  popover: CSSColorSchema.optional(),
  popoverSolid: CSSColorSchema.optional(),
  // Scenic mode
  mode: z.enum(['solid', 'scenic']).optional(),
  backgroundImage: z.string().optional(),
  // Dark mode overrides
  dark: z.object({}).passthrough().optional(),
  // Shiki theme for syntax highlighting
  shikiTheme: z.object({
    light: z.string().optional(),
    dark: z.string().optional(),
  }).optional(),
}).refine(
  (data) => {
    const colorProps = ['background', 'foreground', 'accent', 'info', 'success', 'destructive'];
    return colorProps.some(prop => prop in data);
  },
  { message: 'Theme must have at least one color property (background, foreground, accent, info, success, or destructive)' }
);

/**
 * Warn (never fail) about theme colors the solver cannot parse: `themeToCSS` falls back to
 * DEFAULT_THEME per color, so a typo like `lab(…)` or `var(--brand)` silently changes the look.
 * Source hunk: v0.15.1:packages/shared/src/config/validators.ts `collectThemeColorWarnings` (UB13.3).
 */
function collectThemeColorWarnings(content: unknown, displayFile: string): ValidationIssue[] {
  if (!content || typeof content !== 'object') return [];
  const keys = ['background', 'foreground', 'accent', 'info', 'success', 'destructive', 'paper', 'navigator', 'input', 'popover', 'popoverSolid'];
  const warnings: ValidationIssue[] = [];
  const check = (obj: Record<string, unknown>, prefix: string) => {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value !== 'string' || isParseableColor(value)) continue;
      warnings.push({
        file: displayFile,
        path: prefix + key,
        message: `"${value}" is not a supported CSS color; the default theme's color is used instead`,
        severity: 'warning',
        suggestion: 'Use hex, rgb(), hsl(), oklch(), oklab() or a CSS color name',
      });
    }
  };
  const record = content as Record<string, unknown>;
  check(record, '');
  if (record.dark && typeof record.dark === 'object') check(record.dark as Record<string, unknown>, 'dark.');
  return warnings;
}

/**
 * Validate theme content from a JSON string (no disk reads).
 * Used to check if an existing theme file is valid before deciding to overwrite.
 */
export function validateThemeContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = PresetThemeSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: collectThemeColorWarnings(content, displayFile),
  };
}

/**
 * Validate app-level theme override content from a JSON string (no disk reads).
 * Unlike preset validation, this accepts partial ThemeOverrides objects and rejects unknown keys.
 */
export function validateThemeOverrideContent(jsonString: string, displayFile: string = 'theme.json'): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: displayFile,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = ThemeOverrideSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, displayFile));
    return { valid: false, errors, warnings: [] };
  }

  return {
    valid: true,
    errors: [],
    warnings: collectThemeColorWarnings(content, displayFile),
  };
}

/**
 * Check if a theme file at the given path is valid.
 * Returns true if the file exists and passes schema validation.
 */
export function isValidThemeFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = validateThemeContent(content);
    return result.valid;
  } catch {
    return false;
  }
}

// ============================================================
// Tool Icons Validators
// ============================================================

// DA1.72 — FROM THE LEAVES, NOT FROM `storage.ts`, and this is load-bearing
// rather than tidy: this module is imported by `config/stored-config-load.ts`
// (for `StoredConfigTopLevelSchema`), so an edge from here back to `storage.ts`
// puts `credentials/index.ts`, `sessions/index.ts` and `docs/index.ts` behind
// every `loadStoredConfig` in the product. These three symbols MOVED to the
// modules that own what they describe; `storage.ts` re-exports them, so nothing
// else changed. Do not re-point either line at `./storage.ts`;
// `__tests__/stored-config-load-leaf.test.ts` fails when the edge comes back.
import { getToolIconsDir } from './paths.ts';
// P6.939 · the page's warn-and-hold sentence, shared with the enforcement
// module so one typo gets ONE voice.
import {
  crossSessionInboundUnrecognizedSentence,
  describeUnrecognizedCrossSessionInbound,
} from './cross-session-inbound-vocabulary.ts';

/**
 * Zod schema for a single tool icon entry in tool-icons.json.
 * Each entry maps CLI commands to an icon file.
 */
const ToolIconEntrySchema = z.object({
  id: z.string().min(1, 'Tool ID is required').regex(
    /^[a-z0-9-]+$/,
    'ID must be lowercase alphanumeric with hyphens (e.g., "my-tool")'
  ),
  displayName: z.string().min(1, 'Display name is required'),
  icon: z.string().min(1, 'Icon filename is required'),
  commands: z.array(z.string().min(1)).min(1, 'At least one command is required'),
});

/**
 * Zod schema for the full tool-icons.json config.
 * Contains a version number and array of tool icon mappings.
 */
const ToolIconsConfigSchema = z.object({
  version: z.number().int().min(1, 'Version must be a positive integer'),
  tools: z.array(ToolIconEntrySchema),
});

/**
 * Validate tool-icons config from a JSON string (no disk reads).
 * Used by PreToolUse hook to validate before writing to disk.
 * Checks JSON syntax, Zod schema, duplicate IDs, and duplicate commands.
 */
export function validateToolIconsContent(jsonString: string): ValidationResult {
  const file = 'tool-icons/tool-icons.json';
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
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

  // Validate against Zod schema
  const result = ToolIconsConfigSchema.safeParse(content);
  if (!result.success) {
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic validation: check for duplicate tool IDs
  const seenIds = new Set<string>();
  for (const tool of config.tools) {
    if (seenIds.has(tool.id)) {
      errors.push({
        file,
        path: `tools[id=${tool.id}]`,
        message: `Duplicate tool ID '${tool.id}'`,
        severity: 'error',
        suggestion: 'Each tool must have a unique ID',
      });
    }
    seenIds.add(tool.id);
  }

  // Semantic validation: warn on duplicate commands across tools
  const seenCommands = new Map<string, string>();
  for (const tool of config.tools) {
    for (const cmd of tool.commands) {
      if (seenCommands.has(cmd)) {
        warnings.push({
          file,
          path: `tools[id=${tool.id}].commands`,
          message: `Command '${cmd}' is also mapped by tool '${seenCommands.get(cmd)}'`,
          severity: 'warning',
          suggestion: 'Commands should be unique across tools for unambiguous icon resolution',
        });
      } else {
        seenCommands.set(cmd, tool.id);
      }
    }
  }

  // Validate icon file extensions
  const validIconExtensions = new Set(['.png', '.ico', '.svg', '.jpg', '.jpeg']);
  for (const tool of config.tools) {
    const ext = tool.icon.includes('.') ? '.' + tool.icon.split('.').pop()!.toLowerCase() : '';
    if (!validIconExtensions.has(ext)) {
      warnings.push({
        file,
        path: `tools[id=${tool.id}].icon`,
        message: `Icon '${tool.icon}' has unrecognized extension '${ext}'`,
        severity: 'warning',
        suggestion: 'Supported formats: .png, .ico, .svg, .jpg',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate tool-icons/tool-icons.json from disk.
 * Reads the file, runs content validation, and also checks that referenced icon files exist.
 */
export function validateToolIcons(): ValidationResult {
  const toolIconsDir = getToolIconsDir();
  const configPath = join(toolIconsDir, 'tool-icons.json');
  const file = 'tool-icons/tool-icons.json';

  // File is optional — missing is just a warning
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'Tool icons config does not exist (using defaults)',
        severity: 'warning',
      }],
    };
  }

  // Read file and delegate to content validator
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

  const result = validateToolIconsContent(raw);

  // Filesystem-specific check: verify referenced icon files exist
  try {
    const parsed = safeJsonParse(raw) as Record<string, unknown>;
    if (parsed.tools && Array.isArray(parsed.tools)) {
      for (const tool of parsed.tools) {
        if (tool.icon) {
          const iconPath = join(toolIconsDir, tool.icon);
          if (!existsSync(iconPath)) {
            result.warnings.push({
              file: `tool-icons/${tool.icon}`,
              path: `tools[id=${tool.id}].icon`,
              message: `Icon file '${tool.icon}' not found in tool-icons directory`,
              severity: 'warning',
              suggestion: `Place '${tool.icon}' in ~/.nessy-agent/tool-icons/`,
            });
          }
        }
      }
    }
  } catch {
    // JSON parse errors already reported by content validator
  }

  return result;
}

// ============================================================
// Formatting
// ============================================================

/**
 * Format validation result as text for agent response
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid && result.warnings.length === 0) {
    lines.push('All configuration files are valid.');
    return lines.join('\n');
  }

  if (result.valid) {
    lines.push('Configuration is valid with warnings:');
  } else {
    lines.push('Configuration has errors:');
  }

  lines.push('');

  // Errors first
  if (result.errors.length > 0) {
    lines.push('**Errors:**');
    for (const error of result.errors) {
      lines.push(`- \`${error.file}\` at \`${error.path}\`: ${error.message}`);
      if (error.suggestion) {
        lines.push(`  → ${error.suggestion}`);
      }
    }
    lines.push('');
  }

  // Then warnings
  if (result.warnings.length > 0) {
    lines.push('**Warnings:**');
    for (const warning of result.warnings) {
      lines.push(`- \`${warning.file}\` at \`${warning.path}\`: ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`  → ${warning.suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================
// PreToolUse Content Validation
// ============================================================
// These utilities are used by the PreToolUse hook to detect config files
// being written and validate their content before it reaches disk.

/**
 * Result of detecting what type of config file a path corresponds to.
 */
export interface ConfigFileDetection {
  type: 'source' | 'skill' | 'statuses' | 'labels' | 'permissions' | 'tool-icons' | 'automations';
  /** Slug of the source or skill (if applicable) */
  slug?: string;
  /** Display file path for error messages */
  displayFile: string;
}

/**
 * Detect if a file path corresponds to a known config file type within a workspace.
 * Returns null if the path is not a recognized config file.
 *
 * Matches patterns:
 * - .../sources/{slug}/config.json → source config
 * - .../skills/{slug}/SKILL.md → skill definition
 * - .../statuses/config.json → status workflow config
 * - .../labels/config.json → label config
 * - .../permissions.json (workspace or source-level) → permission rules
 */
export function detectConfigFileType(filePath: string, workspaceRootPath: string): ConfigFileDetection | null {
  // Normalize to consistent forward slashes and ensure root ends with /
  // so startsWith doesn't false-match on path prefixes (e.g., /workspace vs /workspacefoo)
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedRoot = workspaceRootPath.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only validate files within the workspace root
  if (!normalizedPath.startsWith(normalizedRoot)) {
    return null;
  }

  // Get the relative path from workspace root (no leading slash since root ends with /)
  const relativePath = normalizedPath.slice(normalizedRoot.length);

  // Match: sources/{slug}/config.json
  const sourceMatch = relativePath.match(/^sources\/([^/]+)\/config\.json$/);
  if (sourceMatch) {
    return { type: 'source', slug: sourceMatch[1], displayFile: `sources/${sourceMatch[1]}/config.json` };
  }

  // Match: skills/{slug}/SKILL.md
  const skillMatch = relativePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch) {
    return { type: 'skill', slug: skillMatch[1], displayFile: `skills/${skillMatch[1]}/SKILL.md` };
  }

  // Match: statuses/config.json
  if (relativePath === 'statuses/config.json') {
    return { type: 'statuses', displayFile: 'statuses/config.json' };
  }

  // Match: labels/config.json
  if (relativePath === 'labels/config.json') {
    return { type: 'labels', displayFile: 'labels/config.json' };
  }

  // Match: automations config file
  if (relativePath === AUTOMATIONS_CONFIG_FILE) {
    return { type: 'automations', displayFile: relativePath };
  }

  // Match: permissions.json (workspace-level)
  if (relativePath === 'permissions.json') {
    return { type: 'permissions', displayFile: 'permissions.json' };
  }

  // Match: sources/{slug}/permissions.json (source-level)
  const sourcePermMatch = relativePath.match(/^sources\/([^/]+)\/permissions\.json$/);
  if (sourcePermMatch) {
    return { type: 'permissions', slug: sourcePermMatch[1], displayFile: `sources/${sourcePermMatch[1]}/permissions.json` };
  }

  return null;
}

/**
 * Detect if a file path corresponds to an app-level config file (outside workspace scope).
 * Checks paths relative to CONFIG_DIR (~/.nessy-agent/).
 * Returns null if the path is not a recognized app-level config file.
 *
 * Matches patterns:
 * - ~/.nessy-agent/tool-icons/tool-icons.json → tool icon mappings
 */
export function detectAppConfigFileType(filePath: string): ConfigFileDetection | null {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedConfigDir = CONFIG_DIR.replace(/\\/g, '/').replace(/\/?$/, '/');

  // Only check files within CONFIG_DIR
  if (!normalizedPath.startsWith(normalizedConfigDir)) {
    return null;
  }

  const relativePath = normalizedPath.slice(normalizedConfigDir.length);

  // Match: tool-icons/tool-icons.json
  if (relativePath === 'tool-icons/tool-icons.json') {
    return { type: 'tool-icons', displayFile: 'tool-icons/tool-icons.json' };
  }

  return null;
}

/**
 * Validate config file content based on its detected type.
 * Dispatches to the appropriate content-based validator.
 * Returns null if the detection type is unrecognized.
 */
export function validateConfigFileContent(
  detection: ConfigFileDetection,
  content: string
): ValidationResult | null {
  switch (detection.type) {
    case 'source':
      return validateSourceConfigContent(content);
    case 'skill':
      return validateSkillContent(content, detection.slug || 'unknown');
    case 'statuses':
      return validateStatusesContent(content);
    case 'labels':
      return validateLabelsContent(content);
    case 'automations':
      return validateAutomationsContent(content, detection.displayFile);
    case 'permissions':
      return validatePermissionsContent(content, detection.displayFile);
    case 'tool-icons':
      return validateToolIconsContent(content);
    default:
      return null;
  }
}
