/**
 * Config Validate Handler
 *
 * Validates Nessy Desktop configuration files.
 * Uses the full Zod validators when the context binds them, otherwise a basic
 * field-and-parse tier that says so. Both contexts bind them now: claude always
 * (`shared/agent/claude-context.ts`), codex when the config-root ground agrees
 * (`session-mcp-server/src/index.ts`, P6.885).
 */

import { join } from 'node:path';

const AUTOMATIONS_CONFIG_FILE = 'automations.json';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult, ValidationResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import {
  formatValidationResult,
  validateJsonFileHasFields,
  mergeResults,
} from '../validation.ts';
import { getSourceConfigPath } from '../source-helpers.ts';

/**
 * P6.879 — the fallback answer says WHICH validation ran.
 *
 * The defect: on the codex path `ctx.validators` is absent, so `target: 'config'`
 * ran `validateJsonFileHasFields(config.json, ['workspaceRefs'])` and answered
 * `✓ Validation passed` — the same sentence the full Zod validator emits — on a
 * file that validator calls invalid. `preferences`, `permissions` and
 * `automations` are weaker still: their required-field list is EMPTY, so those
 * answers mean only "the file parses as JSON". A caller could not tell any of
 * that from the output, and the difference is the whole reason
 * `validators.ts`'s own comments call the full validator *"the only place a
 * user learns their value never took effect"*.
 *
 * Why NAMING the validation rather than running the full one here: this package
 * (`@nessy-agent/session-tools-core`) does not depend on `@nessy-agent/shared`,
 * where the Zod validators live — its dependencies are `zod`, `gray-matter`,
 * `zod-to-json-schema` and `beautiful-mermaid`. The full validators reach a
 * context only through `shared/agent/claude-context.ts`, which builds
 * `ctx.validators`. Supplying them on the codex path means changing
 * `createCodexContext` in `packages/session-mcp-server` (which does depend on
 * `shared`), and that carries a real hazard rather than a package move: the
 * shared validators resolve `CONFIG_FILE` from their own module-level
 * `CONFIG_DIR`, while every fallback branch here reads `ctx.configRoot`, which
 * arrives as the `--config-root` argv the host passed. In a subprocess that did
 * not inherit `NESSY_CONFIG_DIR` those are DIFFERENT files, and a validator
 * silently reporting on another file is worse than one that says what it
 * checked. See this lane's report for the proposed row.
 *
 * P6.885 SETTLED that: `createCodexValidators` (`session-mcp-server/src/index.ts`)
 * now binds the full interface whenever the two grounds agree, which is every
 * ordinary install. So this tier is no longer "the codex path" — it is the path
 * where no validators were bound, for either of two reasons, and the note below
 * stopped naming a cause it can no longer know. The reason it CAN name, and the
 * one a reader needs, is the tier itself.
 */
const BASIC_VALIDATION_NOTE =
  'note: basic validation — no full schema validators are bound on this path, so a file that'
  + ' parses and carries the fields above passes here, including values the full validator refuses.';

/**
 * A fallback answer plus the two sentences that make it readable: what was
 * checked, and what that tier cannot see.
 */
function basicValidationResponse(result: ValidationResult, checked: string): ToolResult {
  return successResponse(
    `${formatValidationResult(result)}\n\nchecked: ${checked}\n${BASIC_VALIDATION_NOTE}`
  );
}

export interface ConfigValidateArgs {
  target: 'config' | 'sources' | 'statuses' | 'preferences' | 'permissions' | 'automations' | 'tool-icons' | 'all';
  sourceSlug?: string;
}

/**
 * Handle the config_validate tool call.
 *
 * If ctx.validators is available, uses full Zod validators.
 * Otherwise falls back to basic JSON field checking.
 */
export async function handleConfigValidate(
  ctx: SessionToolContext,
  args: ConfigValidateArgs
): Promise<ToolResult> {
  const { target, sourceSlug } = args;
  const appConfigRoot = ctx.configRoot;

  // Full Zod validators, when the context bound them (claude always; codex when
  // its config-root ground agrees — P6.885).
  if (ctx.validators) {
    try {
      let result;

      switch (target) {
        case 'config':
          result = ctx.validators.validateConfig();
          break;
        case 'sources':
          if (sourceSlug) {
            result = ctx.validators.validateSource(ctx.workspacePath, sourceSlug);
          } else {
            result = ctx.validators.validateAllSources(ctx.workspacePath);
          }
          break;
        case 'statuses':
          result = ctx.validators.validateStatuses(ctx.workspacePath);
          break;
        case 'preferences':
          result = ctx.validators.validatePreferences();
          break;
        case 'permissions':
          result = ctx.validators.validatePermissions(ctx.workspacePath, sourceSlug);
          break;
        case 'automations':
          result = ctx.validators.validateAutomations(ctx.workspacePath);
          break;
        case 'tool-icons':
          result = ctx.validators.validateToolIcons();
          break;
        case 'all':
          result = ctx.validators.validateAll(ctx.workspacePath);
          break;
      }

      return successResponse(formatValidationResult(result!));
    } catch (error) {
      return errorResponse(
        `Config validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Fallback: the basic tier, for a context that bound no validators. Not "the
  // Codex path" since P6.885 — codex binds them too, unless its config-root
  // ground disagrees with the shared validators' own.
  switch (target) {
    case 'config': {
      const result = validateJsonFileHasFields(
        join(appConfigRoot, 'config.json'),
        ['workspaceRefs']
      );
      return basicValidationResponse(result, 'config.json parses and has workspaceRefs');
    }

    case 'sources': {
      if (sourceSlug) {
        const sourcePath = getSourceConfigPath(ctx.workspacePath, sourceSlug);
        const result = validateJsonFileHasFields(sourcePath, ['slug', 'name', 'type']);
        return basicValidationResponse(
          result,
          `sources/${sourceSlug}/config.json parses and has slug, name, type`
        );
      } else {
        // Validate all sources
        const sourcesDir = join(ctx.workspacePath, 'sources');
        if (!ctx.fs.exists(sourcesDir)) {
          return successResponse('✓ No sources directory (no sources to validate)');
        }

        const results = [];
        const entries = ctx.fs.readdir(sourcesDir);
        for (const entry of entries) {
          const entryPath = join(sourcesDir, entry);
          if (ctx.fs.isDirectory(entryPath)) {
            const sourceResult = validateJsonFileHasFields(
              join(entryPath, 'config.json'),
              ['slug', 'name', 'type']
            );
            if (!sourceResult.valid) {
              // Prefix errors with source name
              sourceResult.errors = sourceResult.errors.map(e => ({
                ...e,
                path: `${entry}/${e.path}`,
              }));
            }
            results.push(sourceResult);
          }
        }

        const merged = mergeResults(...results);
        return basicValidationResponse(
          merged,
          `${results.length} source config.json file(s) parse and have slug, name, type`
        );
      }
    }

    case 'statuses': {
      const result = validateJsonFileHasFields(
        join(ctx.workspacePath, 'statuses', 'config.json'),
        ['statuses']
      );
      return basicValidationResponse(result, 'statuses/config.json parses and has statuses');
    }

    case 'preferences': {
      const result = validateJsonFileHasFields(
        join(appConfigRoot, 'preferences.json'),
        []
      );
      // No required fields at all, so this answer means only that the file
      // parses — the weakest tier in this switch, and the one whose bare
      // "Validation passed" was most misleading.
      return basicValidationResponse(result, 'preferences.json parses (no field is required here)');
    }

    case 'permissions': {
      // Check workspace-level permissions.json
      const workspacePermsPath = join(ctx.workspacePath, 'permissions.json');
      if (!ctx.fs.exists(workspacePermsPath)) {
        return successResponse('✓ No workspace permissions.json (using defaults)');
      }
      const result = validateJsonFileHasFields(workspacePermsPath, []);
      return basicValidationResponse(result, 'permissions.json parses (no field is required here)');
    }

    case 'automations': {
      const automationsPath = join(ctx.workspacePath, AUTOMATIONS_CONFIG_FILE);
      if (ctx.fs.exists(automationsPath)) {
        const result = validateJsonFileHasFields(automationsPath, []);
        return basicValidationResponse(
          result,
          `${AUTOMATIONS_CONFIG_FILE} parses (no field is required here)`
        );
      }
      return successResponse(`✓ No ${AUTOMATIONS_CONFIG_FILE} (no automations configured)`);
    }

    case 'tool-icons': {
      const result = validateJsonFileHasFields(
        join(appConfigRoot, 'tool-icons', 'tool-icons.json'),
        ['version', 'tools']
      );
      return basicValidationResponse(
        result,
        'tool-icons/tool-icons.json parses and has version, tools'
      );
    }

    case 'all': {
      const configResult = validateJsonFileHasFields(
        join(appConfigRoot, 'config.json'),
        ['workspaceRefs']
      );
      const prefsResult = validateJsonFileHasFields(
        join(appConfigRoot, 'preferences.json'),
        []
      );
      const merged = mergeResults(configResult, prefsResult);
      // `all` on this path is TWO files, not the set `validateAll` covers
      // (`shared/config/validators.ts` — read its body rather than a number
      // here; P6.894 changed it) — naming them is the difference between an answer
      // and a claim.
      return basicValidationResponse(
        merged,
        'config.json (workspaceRefs) and preferences.json (parses only)'
      );
    }

    default:
      return errorResponse(
        `Unknown validation target: ${target}. Valid targets: config, sources, statuses, preferences, permissions, automations, tool-icons, all`
      );
  }
}
