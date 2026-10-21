/**
 * R73 · what a `UserPromptExpansion` hook is told about the command being
 * expanded, derived from the command id ALONE.
 *
 * hooks.md#userpromptexpansion: "Runs when a user-typed command expands into a
 * prompt before reaching Claude […] Matches on `command_name`. Leave the
 * matcher empty to fire on every prompt-type command", and the input carries
 * "`expansion_type`, `command_name`, `command_args`, `command_source`, and the
 * original `prompt` string. The `expansion_type` field is `slash_command` for
 * skill and custom commands, or `mcp_prompt` for MCP server prompts."
 *
 * WHY FROM THE ID AND NOT FROM THE RESOLVED COMMAND. hooks.md gives the event a
 * real block — "`decision: \"block\"` prevents the command from expanding" —
 * and for an MCP prompt command the expansion IS the remote `getPrompt` call
 * that `SessionManager.resolveCustomSlashCommand` makes. A hook that only runs
 * after resolution could not prevent it. The id is the one thing the caller
 * holds before resolution, and it is enough: every id shape below is built by a
 * named constructor in `slash-commands/custom-commands.ts`, and both middle
 * segments that could otherwise swallow a delimiter are colon-free by
 * construction (`pluginKey` is `<base64url>.<base64url>`, an MCP server slug is
 * a source slug).
 */

import { CUSTOM_SLASH_COMMAND_PREFIX, type CustomSlashCommandSource } from '@nessy-agent/shared/slash-commands'

export interface CustomCommandExpansionDescriptor {
  /** hooks.md: `slash_command` for skill and custom commands, `mcp_prompt` for MCP server prompts. */
  expansionType: 'slash_command' | 'mcp_prompt'
  /** The matcher value — the bare command name, without the leading `/`. */
  commandName: string
  commandSource: CustomSlashCommandSource
}

/**
 * Split `<head>:<tail>` where `head` is known colon-free. Returns the tail
 * unsplit so a namespaced logical name (`review:security`) survives whole.
 */
function tailAfterKeySegment(remainder: string): string {
  const separator = remainder.indexOf(':')
  return separator === -1 ? remainder : remainder.slice(separator + 1)
}

/**
 * `command_source` is reported with Nessy's own `CustomSlashCommandSource`
 * vocabulary. hooks.md gives no vocabulary for the field beyond its single
 * example value `"plugin"`, which our `plugin` spelling matches exactly;
 * `skill` and `mcp` line up with the two `expansion_type` cases the page does
 * name. The two native sources (`nessy-agent`, `agents`) and `workflow` have no
 * documented counterpart, so they keep their Nessy spelling rather than being
 * bent onto a word the page never uses.
 *
 * A native id (`custom:<name>`) cannot say which of the two native directories
 * the command came from — that is only known after resolution — so it reports
 * the primary one, `nessy-agent`.
 */
export function describeCustomSlashCommandId(commandId: string): CustomCommandExpansionDescriptor {
  const remainder = commandId.startsWith(CUSTOM_SLASH_COMMAND_PREFIX)
    ? commandId.slice(CUSTOM_SLASH_COMMAND_PREFIX.length)
    : commandId

  if (remainder.startsWith('mcp:')) {
    return {
      expansionType: 'mcp_prompt',
      commandName: tailAfterKeySegment(remainder.slice('mcp:'.length)),
      commandSource: 'mcp',
    }
  }
  if (remainder.startsWith('skill:')) {
    return { expansionType: 'slash_command', commandName: remainder.slice('skill:'.length), commandSource: 'skill' }
  }
  // Checked BEFORE `plugin:` — `plugin-workflow:` also starts with `plugin`,
  // and the shorter test first would classify every plugin workflow as a
  // prompt command whose name still carried the `-workflow:` prefix.
  if (remainder.startsWith('plugin-workflow:')) {
    return {
      expansionType: 'slash_command',
      commandName: tailAfterKeySegment(remainder.slice('plugin-workflow:'.length)),
      commandSource: 'workflow',
    }
  }
  if (remainder.startsWith('plugin:')) {
    return {
      expansionType: 'slash_command',
      commandName: tailAfterKeySegment(remainder.slice('plugin:'.length)),
      commandSource: 'plugin',
    }
  }
  if (remainder.startsWith('workflow:')) {
    return { expansionType: 'slash_command', commandName: remainder.slice('workflow:'.length), commandSource: 'workflow' }
  }
  return { expansionType: 'slash_command', commandName: remainder, commandSource: 'nessy-agent' }
}
