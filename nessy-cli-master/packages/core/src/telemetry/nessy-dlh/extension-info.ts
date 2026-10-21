import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';

/**
 * Extension attribution for DLH telemetry, resolved entirely from
 * `Config.getActiveExtensions()` so this stays a fork-owned module with no
 * edits to upstream managers (SkillManager / SubagentManager / loaders).
 *
 * Each loaded `Extension` already carries the entities it provides
 * (`mcpServers`, `skills`, `agents`, `commands`) plus its `installMetadata`,
 * so we attribute an event by matching the dispatched entity's name against
 * those collections.
 *
 * Caveat: matching is by name only and does not model cross-level precedence.
 * If a project/user skill (or subagent/command) shadows an equally-named
 * extension one, this may attribute the event to the extension. That collision
 * is rare and only affects telemetry attribution, not behaviour.
 */

// Derive the Extension shape from Config to avoid importing extensionManager
// (keeps this leaf module free of heavier/circular deps).
type Extension = ReturnType<Config['getActiveExtensions']>[number];

export interface ExtensionInfo {
  extension_name: string | null;
  extension_source: string | null;
}

const NONE: ExtensionInfo = { extension_name: null, extension_source: null };

function toInfo(ext: Extension | undefined): ExtensionInfo {
  if (!ext) return NONE;
  return {
    extension_name: ext.name,
    extension_source: ext.installMetadata?.source ?? null,
  };
}

function findActiveExtension(
  config: Config | undefined,
  predicate: (ext: Extension) => boolean,
): Extension | undefined {
  if (!config) return undefined;
  return config.getActiveExtensions().find(predicate);
}

/** Resolve attribution for an MCP tool by its server name. */
export function resolveMcpExtensionInfo(
  config: Config | undefined,
  mcpServerName: string | null | undefined,
): ExtensionInfo {
  if (!mcpServerName) return NONE;
  return toInfo(
    findActiveExtension(config, (e) => e.mcpServers?.[mcpServerName] != null),
  );
}

/** Resolve attribution for a skill dispatched via the native `Skill` tool. */
export function resolveSkillExtensionInfo(
  config: Config | undefined,
  skillName: string | null | undefined,
): ExtensionInfo {
  if (!skillName) return NONE;
  return toInfo(
    findActiveExtension(
      config,
      (e) => e.skills?.some((s) => s.name === skillName) ?? false,
    ),
  );
}

/** Resolve attribution for a subagent (Agent tool_call and agent_request). */
export function resolveSubagentExtensionInfo(
  config: Config | undefined,
  subagentName: string | null | undefined,
): ExtensionInfo {
  if (!subagentName) return NONE;
  return toInfo(
    findActiveExtension(
      config,
      (e) => e.agents?.some((a) => a.name === subagentName) ?? false,
    ),
  );
}

/** Command directories an extension loads from (mirrors FileCommandLoader). */
function extensionCommandDirs(ext: Extension): string[] {
  const spec = ext.config?.commands;
  const rel = spec == null ? ['commands'] : Array.isArray(spec) ? spec : [spec];
  return rel.map((p) => (path.isAbsolute(p) ? p : path.join(ext.path, p)));
}

/**
 * Whether an extension provides a command of the given name.
 *
 * `ext.commands` (from the extension manager) only enumerates `.md` files, so
 * `.toml` commands — the common custom-command format — are missing from it.
 * We instead check the command file on disk for both formats. Nested commands
 * use `:` which maps to a path separator (segment-level `:`→`_` escaping from
 * the loader is a rare edge we don't model).
 */
function extensionProvidesCommand(
  ext: Extension,
  commandName: string,
): boolean {
  const rel = commandName.split(':').join(path.sep);
  for (const dir of extensionCommandDirs(ext)) {
    for (const extn of ['.toml', '.md']) {
      try {
        if (fs.existsSync(path.join(dir, rel + extn))) return true;
      } catch {
        // ignore unreadable dirs
      }
    }
  }
  return false;
}

/** Resolve attribution for a slash command by its (top-level) name. */
export function resolveCommandExtensionInfo(
  config: Config | undefined,
  commandName: string | null | undefined,
): ExtensionInfo {
  if (!commandName) return NONE;
  return toInfo(
    findActiveExtension(config, (e) =>
      extensionProvidesCommand(e, commandName),
    ),
  );
}
