export const CUSTOM_SLASH_COMMAND_PREFIX = 'custom:';

export type CustomSlashCommandId = `${typeof CUSTOM_SLASH_COMMAND_PREFIX}${string}`;
export type CustomSlashCommandSource = 'nessy-agent' | 'agents' | 'plugin' | 'skill' | 'mcp' | 'workflow';

export interface CustomSlashCommand {
  id: CustomSlashCommandId;
  name: string;
  label: string;
  description?: string;
  model?: string;
  /**
   * What the command expects after its name — `"<file>"`, `"[environment]"` —
   * P6.406.
   *
   * One type serves all six {@link CustomSlashCommandSource}s, so a field
   * missing here is a field missing on every surface at once, whatever the
   * source knew. This one was: the capability resolver already resolves
   * `argumentHint` for a plugin prompt-command
   * (`capabilities/resolver.ts` — `RuntimePromptCommandDefinition`), the SDK
   * sends it on `system/commands_changed` for every claude command, and both
   * were narrowed to a name on the way to the composer.
   *
   * Optional in the honest sense: a source that has no hint omits it rather
   * than sending an empty string, so a surface can tell "no hint" from "".
   */
  argumentHint?: string;
  /**
   * Alternate names that resolve to this same command — the SDK's example is
   * `/cost` and `/stats` both resolving to `/usage`.
   *
   * Carried, not yet resolved BY: dispatch still matches the primary name. It
   * is here because the claude roster receives them and had nowhere to put
   * them, and because a listing that shows a command under one name while the
   * runtime answers to three is the divergence this field makes visible.
   */
  aliases?: readonly string[];
}

/**
 * The two id prefixes a WORKFLOW-derived slash command is minted with —
 * `workflowSlashCommandId` for a saved recipe, `pluginWorkflowCommandId` for a
 * plugin's. They live here, in the fs-free module, because
 * `ComposerCapabilities.slash.excludedCommandIdPrefixes` names the family from
 * the resolver (P2.279) and the resolver must not pull `node:fs` into the
 * renderer's bundle. Both id builders derive their prefix from these constants,
 * so the family name and the minted id cannot drift.
 */
export const WORKFLOW_SLASH_COMMAND_ID_PREFIX = `${CUSTOM_SLASH_COMMAND_PREFIX}workflow:`;
export const PLUGIN_WORKFLOW_SLASH_COMMAND_ID_PREFIX = `${CUSTOM_SLASH_COMMAND_PREFIX}plugin-workflow:`;

export function isCustomSlashCommandId(value: string): value is CustomSlashCommandId {
  return value.startsWith(CUSTOM_SLASH_COMMAND_PREFIX) && value.length > CUSTOM_SLASH_COMMAND_PREFIX.length;
}

export function findCustomSlashCommand<T extends CustomSlashCommand>(
  commands: readonly T[],
  commandId: string,
): T | undefined {
  if (!isCustomSlashCommandId(commandId)) {
    return undefined;
  }
  return commands.find(command => command.id === commandId);
}
