/**
 * Per-category context accounting for the `/context` breakdown.
 *
 * ACCOUNTING, NOT A PROMPT PATH: every measurement here runs `estimateTokens`
 * (the shared skill-budget estimator) over the SAME strings production already
 * composed and sent — the system prompt the host shipped with the turn, the
 * adapted tool definitions the Pi SDK received, the runtime agent definitions,
 * the materialized instruction/memory resources, and the session's own message
 * history. Nothing here re-composes a part for measurement; a drift between
 * measured and sent would be a silent lie in the UI.
 *
 * The category set is the documented seven (debug-your-config.md): system
 * prompt, system tools, MCP tools, custom subagents (with the source each
 * loaded from), memory files, skills, conversation messages.
 */
import { estimateTokens } from '../../shared/src/utils/large-response.ts';
import { isSessionProxyToolName } from '../../shared/src/agent/backend/pi/session-tool-defs.ts';
import type {
  ContextUsageCategory,
  ContextUsageLoadedFile,
  ContextUsageSuggestion,
} from '../../shared/src/protocol/dto.ts';

/** The tagged block PromptBuilder.buildSkillListingPart emits into the prompt. */
const SKILL_LISTING_PATTERN = /<available_skills>[\s\S]*?<\/available_skills>/;

export interface ContextCategoryToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ContextCategoryAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** Descriptor provenance — the source this subagent loaded from. */
  provenance?: string;
}

export interface ContextCategoryContextResource {
  id: string;
  kind: 'prompt' | 'agent-instruction' | 'context';
  content: string;
  /** `key@generation`; the key half names the loaded layer. */
  provenance: string;
}

export interface ContextCategoryInputs {
  /** The composed system prompt exactly as sent to the runtime. */
  systemPrompt?: string;
  /** The adapted tool definitions the session advertises to the model. */
  toolDefinitions?: readonly ContextCategoryToolDefinition[];
  /** Runtime (imported) subagent definitions active for this session. */
  agentDefinitions?: readonly ContextCategoryAgentDefinition[];
  /** Materialized instruction/memory (and MCP) context resources. */
  contextResources?: readonly ContextCategoryContextResource[];
  /** The session's message history (Pi SDK AgentMessage values). */
  messages?: readonly unknown[];
}

export interface ContextCategoryBreakdown {
  categories: ContextUsageCategory[];
  loadedFiles: ContextUsageLoadedFile[];
  /** May be empty; see {@link buildContextCategorySuggestions}. */
  suggestions: ContextUsageSuggestion[];
}

/**
 * A category has to cost at least this much before it is worth a sentence.
 *
 * Below it the advice costs the reader more than the fix would save, and the
 * `/context` overlay is the one surface where a false alarm teaches the user to
 * stop reading it.
 */
const SUGGESTION_MIN_TOKENS = 2_000;

/**
 * ...and it has to be at least this large a share of the CONFIGURED context.
 *
 * The denominator deliberately excludes `conversation_messages`: that row is
 * the work, not a setting, and including it would silence every configuration
 * suggestion in exactly the long sessions where trimming the configuration is
 * worth most. Every other row is something the user chose and can change.
 */
const SUGGESTION_MIN_SHARE_OF_CONFIGURED = 0.2;

/** One `- [skill:…]` line of the listing block PromptBuilder composed. */
const SKILL_LISTING_ENTRY_PATTERN = /- \[skill:/g;

function toolDefinitionText(tool: ContextCategoryToolDefinition): string {
  let parameters = '';
  try {
    parameters = tool.parameters === undefined ? '' : JSON.stringify(tool.parameters) ?? '';
  } catch {
    // Unserializable schemas still advertise a name and description.
  }
  return [tool.name, tool.description ?? '', parameters].filter(Boolean).join('\n');
}

/**
 * Message history cost. The serialized message is the closest available proxy
 * for what the provider tokenizes (text, tool calls and tool results all count),
 * and it is the session's own production data — not a re-composition.
 */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(message) ?? '';
  } catch {
    return '';
  }
}

/** The `key` half of a context resource's `key@generation` provenance. */
function resourceName(resource: ContextCategoryContextResource): string {
  const separator = resource.provenance.lastIndexOf('@');
  return separator > 0 ? resource.provenance.slice(0, separator) : resource.provenance;
}

export function buildContextCategoryBreakdown(inputs: ContextCategoryInputs): ContextCategoryBreakdown {
  const systemPrompt = inputs.systemPrompt ?? '';
  // The skill listing is measured as the tagged block INSIDE the sent system
  // prompt — sliced out of the production string, never rebuilt from the skill
  // set. The system-prompt row is the remainder of that same string.
  const skillsBlock = SKILL_LISTING_PATTERN.exec(systemPrompt)?.[0] ?? '';
  const systemPromptRest = skillsBlock ? systemPrompt.replace(skillsBlock, '') : systemPrompt;

  // The MCP-tools row means MCP-SERVER tools (context-window.md's "MCP tools"
  // row is the servers' tool listing). Nessy's ~50 internal session tools are
  // advertised in MCP spelling (`mcp__session__*`) for the Pi SDK's benefit,
  // but no user MCP server supplies them — they are system tools. A bare
  // `mcp__` prefix split filed all of them under `mcp_tools`, reporting ~12K
  // tokens of "MCP tools" with zero servers connected. Same predicate the
  // capability catalog's `kind` uses; never a second copy of the prefix.
  const isMcpServerTool = (name: string): boolean => name.startsWith('mcp__') && !isSessionProxyToolName(name);
  const systemTools = (inputs.toolDefinitions ?? []).filter(tool => !isMcpServerTool(tool.name));
  const mcpTools = (inputs.toolDefinitions ?? []).filter(tool => isMcpServerTool(tool.name));

  // Agent definitions cost NOTHING on the Pi wire, so this row reports what is
  // sent rather than what exists.
  //
  // It used to sum `description + systemPrompt` per agent, which is text this
  // runtime never transmits: the Pi SDK session options carry `{ customTools,
  // tools }` and no `agents` field, the `subagent` tool's schema declares
  // `agent: { type: 'string' }` with no enum and no per-agent text, and the
  // prompt is resolved at SPAWN time. That made the row the second-largest
  // line in a breakdown of where the window goes, for bytes nobody pays.
  //
  // Measured rather than reasoned (C1, packaged build, real gateway): seven
  // agents were seeded with unique markers in both their description and their
  // body, and **0 of 7 description markers and 0 of 7 body markers** appear
  // anywhere in the request — not in the tools array, not in the system
  // message, not in the body. The seeding came first on purpose: this machine
  // had no agents at all, so measuring before seeding would have found no
  // agent text and "confirmed" the same verdict while proving only that there
  // was nothing to find.
  //
  // The names are kept so the roster stays visible and its absence is not read
  // as a bug; only the cost claim is corrected. Pi-scoped by construction —
  // this file is the Pi accounting path, and the Claude runtime ships agent
  // bodies to its SDK, so its answer is its own.
  const subagentItems = (inputs.agentDefinitions ?? []).map(definition => ({
    name: definition.name,
    tokens: 0,
    ...(definition.provenance ? { source: definition.provenance } : {}),
  }));

  // Capability instruction/memory layers are the loaded files; MCP-sourced
  // resources (`mcp-*` ids) match no documented category and deliberately stay
  // in the unattributed remainder rather than being mislabeled as files.
  const capabilityResources = (inputs.contextResources ?? []).filter(resource => resource.id.startsWith('cap-'));
  const loadedFiles: ContextUsageLoadedFile[] = capabilityResources.map(resource => ({
    name: resourceName(resource),
    kind: resource.kind === 'agent-instruction' ? 'instruction' : 'memory',
    tokens: estimateTokens(resource.content),
  }));

  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

  const categories: ContextUsageCategory[] = [
    { id: 'system_prompt', tokens: systemPromptRest ? estimateTokens(systemPromptRest) : 0 },
    { id: 'system_tools', tokens: sum(systemTools.map(tool => estimateTokens(toolDefinitionText(tool)))) },
    { id: 'mcp_tools', tokens: sum(mcpTools.map(tool => estimateTokens(toolDefinitionText(tool)))) },
    {
      id: 'custom_subagents',
      tokens: sum(subagentItems.map(item => item.tokens)),
      ...(subagentItems.length > 0 ? { items: subagentItems } : {}),
    },
    { id: 'memory_files', tokens: sum(loadedFiles.map(file => file.tokens)) },
    { id: 'skills', tokens: skillsBlock ? estimateTokens(skillsBlock) : 0 },
    {
      id: 'conversation_messages',
      tokens: sum((inputs.messages ?? []).map(message => estimateTokens(messageText(message)))),
    },
  ];

  return {
    categories,
    loadedFiles,
    suggestions: buildContextCategorySuggestions(categories, {
      mcpToolCount: mcpTools.length,
      loadedFileCount: loadedFiles.length,
      skillCount: (skillsBlock.match(SKILL_LISTING_ENTRY_PATTERN) ?? []).length,
    }),
  };
}

interface SuggestionCounts {
  mcpToolCount: number;
  loadedFileCount: number;
  skillCount: number;
}

/**
 * Optimization suggestions, from the numbers the rows above were built from.
 *
 * `context-window.md:1616` whole: "The visualization uses representative
 * numbers. To see your actual context usage at any point, run `/context` for a
 * live breakdown by category with optimization suggestions, including which
 * CLAUDE.md and auto memory files loaded. Run `/memory` to open and edit those
 * files."
 *
 * Three constraints this function exists to satisfy:
 *
 * 1. It reads the FINISHED `categories` array, so a suggestion's `tokens` is
 *    byte-identical to the row it names — the two cannot drift.
 * 2. Every rule names a control that exists in this product. `mcp_tools` is the
 *    row AFTER R11 split the internal session tools out into `system_tools`, so
 *    a suggestion can no longer advise removing MCP servers a user never had.
 * 3. A category with nothing behind it is never advised about: zero MCP tools,
 *    zero loaded files or zero listed skills means the cost is not where the
 *    suggestion would send the user.
 */
export function buildContextCategorySuggestions(
  categories: readonly ContextUsageCategory[],
  counts: SuggestionCounts,
): ContextUsageSuggestion[] {
  const tokensOf = (id: ContextUsageCategory['id']): number =>
    categories.find(category => category.id === id)?.tokens ?? 0;
  const configuredTotal = categories
    .filter(category => category.id !== 'conversation_messages')
    .reduce((total, category) => total + category.tokens, 0);

  const isWorthAdvising = (tokens: number): boolean =>
    tokens >= SUGGESTION_MIN_TOKENS
    && configuredTotal > 0
    && tokens / configuredTotal >= SUGGESTION_MIN_SHARE_OF_CONFIGURED;

  const suggestions: ContextUsageSuggestion[] = [];

  const mcpTokens = tokensOf('mcp_tools');
  if (counts.mcpToolCount > 0 && isWorthAdvising(mcpTokens)) {
    suggestions.push({
      id: 'defer_mcp_tools',
      category: 'mcp_tools',
      tokens: mcpTokens,
      count: counts.mcpToolCount,
    });
  }

  const memoryTokens = tokensOf('memory_files');
  if (counts.loadedFileCount > 0 && isWorthAdvising(memoryTokens)) {
    suggestions.push({
      id: 'trim_memory_files',
      category: 'memory_files',
      tokens: memoryTokens,
      count: counts.loadedFileCount,
    });
  }

  const skillTokens = tokensOf('skills');
  if (counts.skillCount > 0 && isWorthAdvising(skillTokens)) {
    suggestions.push({
      id: 'gate_skill_listing',
      category: 'skills',
      tokens: skillTokens,
      count: counts.skillCount,
    });
  }

  return suggestions;
}

/** Sum of the category estimates, for the unattributed remainder. */
export function contextCategoryTotal(categories: readonly ContextUsageCategory[]): number {
  return categories.reduce((total, category) => total + category.tokens, 0);
}
