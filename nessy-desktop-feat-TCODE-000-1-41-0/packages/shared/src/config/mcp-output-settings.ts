/**
 * The MCP tool-output size thresholds (doc-sweep § R58, finding f038).
 *
 * Claude env name maps to ours, the way `background-task-settings.ts` records
 * its family:
 *
 * - `MAX_MCP_OUTPUT_TOKENS` → `NESSY_MCP_OUTPUT_TOKENS`
 *   (the Claude spelling is accepted as a compat alias; the Nessy name wins
 *   when both are set — the `subagent-spawn-depth.ts` aliased-pair discipline)
 *
 * `agent-sdk/mcp.md:894`: "When a tool result is larger than 25,000 tokens, the
 * full output is saved to a file and the tool result is replaced with an error
 * message that names the file path … Raise the limit with the
 * `MAX_MCP_OUTPUT_TOKENS` environment variable."
 *
 * `mcp.md:1040`: "the default maximum is 25,000 tokens"; `:1039` names the env
 * var as the way to adjust it.
 *
 * `mcp.md:1041`: "the environment variable applies to tools that don't declare
 * their own limit. Tools that set `anthropic/maxResultSizeChars` use that value
 * instead for text content, regardless of what `MAX_MCP_OUTPUT_TOKENS` is set
 * to. Tools that return image data are still subject to
 * `MAX_MCP_OUTPUT_TOKENS`." That composition lives in
 * `utils/large-response.ts` (`exceedsResultSizeLimit`), not here — this module
 * only resolves the number.
 *
 * `mcp.md:246`: "Claude Code displays a warning when MCP tool output exceeds
 * 10,000 tokens and limits output to 25,000 tokens by default … the warning
 * threshold is fixed." Fixed means fixed: {@link MCP_OUTPUT_WARN_TOKENS} has no
 * env knob and deliberately takes no `env` argument anywhere.
 *
 * ## The parse
 *
 * `env-vars.md#variables`, the paragraph opening the Variables list: "Numeric
 * variables such as timeouts, token budgets, and retry counts accept scientific
 * notation and digit-separator spellings in addition to plain digits, except
 * where a variable's row notes it takes plain digits only. For example, Claude
 * Code reads `2e3` as 2000 and `64_000` as 64000." A token budget is named in
 * that sentence, and the `MAX_MCP_OUTPUT_TOKENS` row notes no restriction, so
 * the general rule governs: `2e3` is 2000 here. `resolveMaxSubagentSpawnDepth`
 * is the OTHER side of the exception and stays plain-digits-only, which is why
 * these two no longer share one reader.
 *
 * The doc offers no disable value, only a raise, so `0` is not a legal limit
 * and never means "unlimited": the reader requires `>= 1` and falls back
 * otherwise, saying so rather than swallowing it. There is no ceiling clamp on
 * the token limit itself — the per-tool annotation carries the only documented
 * hard ceiling (`MAX_DECLARED_RESULT_SIZE_CHARS`, `mcp.md:1058`).
 *
 * ## Where the value is read
 *
 * At the three guard sites that decide whether an MCP result is persisted to
 * `<session>/long_responses/` instead of being returned inline:
 * `mcp/mcp-pool.ts` `callTool` (the site the doc sentence is about), the
 * `tool_result` guard in `agent/claude-agent.ts` for `mcp__`-prefixed tools,
 * and `agent/local-tools/runtime.ts` `guardResult` for the MCP proxy branch.
 * All three read it through this one function so the number cannot differ per
 * backend.
 */

import { resolveNumericSetting } from './numeric-setting'

export type McpOutputEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the MCP output token limit. */
export const MCP_OUTPUT_TOKENS_ENV = 'NESSY_MCP_OUTPUT_TOKENS'

/** The documented Claude spelling (`mcp.md:1039`), accepted as a compat alias. */
export const MCP_OUTPUT_TOKENS_COMPAT_ENV = 'MAX_MCP_OUTPUT_TOKENS'

/** "the default maximum is 25,000 tokens" — `mcp.md:1040`, `agent-sdk/mcp.md:894`. */
export const MCP_OUTPUT_TOKEN_LIMIT_DEFAULT = 25_000

/**
 * "Claude Code displays a warning when MCP tool output exceeds 10,000 tokens …
 * the warning threshold is fixed" — `mcp.md:246`. No env knob, by contract.
 */
export const MCP_OUTPUT_WARN_TOKENS = 10_000

/**
 * The effective MCP output token limit. A malformed value falls back to the
 * documented default and `0` falls back rather than meaning unlimited — the doc
 * describes only raising the limit, never removing it. The Nessy name wins when
 * both spellings are set.
 */
export function mcpOutputTokenLimit(
  env: McpOutputEnvRecord = process.env,
  write?: (message: string) => void,
): number {
  // Presence decides which name is read, and the SAME choice names the value in
  // the rejection sentence.
  const name = env[MCP_OUTPUT_TOKENS_ENV] !== undefined
    ? MCP_OUTPUT_TOKENS_ENV
    : MCP_OUTPUT_TOKENS_COMPAT_ENV
  return resolveNumericSetting(name, env[name], MCP_OUTPUT_TOKEN_LIMIT_DEFAULT, { min: 1 }, write)
}
