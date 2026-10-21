/**
 * F1.669 — the Claude Code built-in tool a Pi built-in tool name stands for.
 *
 * One `sessionAllowedTools` list serves both runtimes, and Pi spells its built-in tools in lower case (`read`,
 * `bash`, `edit`, `write`, `grep`, `find`, `ls` — `agents/definitions.ts`'s `FULL_TOOLS`). Claude Code's `tools`
 * option takes its own names and drops a name it does not know without a word ({@link
 * buildClaudeSessionToolsOption}'s docblock in `claude-agent.ts`), so before this map a Pi-spelled whitelist left
 * the claude child with no built-in tool but `ToolSearch`. Decided under the owner's rule (2026-10-08, simplest and
 * runtime-native): translate the spellings and keep handing the list to the SDK's own `tools` option.
 *
 * Claude Code has no directory-listing tool of its own, so Pi's `find` and `ls` both stand for `Glob`
 * (`tools-reference.md`: "Finds files based on pattern matching"). Only Pi's BUILT-IN names are here: a host session
 * tool such as `web_search` is an MCP tool on claude (`mcp__session__web_search`), which the whitelist does not govern
 * there (`cli-reference.md#cli-flags`, `--tools`: "doesn't affect MCP tools").
 */
export const PI_TO_CLAUDE_BUILTIN_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  read: 'Read',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  ls: 'Glob',
});

/** The whitelist with every Pi built-in spelling replaced by its Claude name, first occurrence kept, order kept. */
export function claudeToolNamesForWhitelist(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const claudeName = Object.hasOwn(PI_TO_CLAUDE_BUILTIN_TOOL_NAMES, name) ? PI_TO_CLAUDE_BUILTIN_TOOL_NAMES[name]! : name;
    if (!out.includes(claudeName)) out.push(claudeName);
  }
  return out;
}
