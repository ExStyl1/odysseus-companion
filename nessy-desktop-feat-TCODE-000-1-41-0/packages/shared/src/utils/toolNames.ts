/**
 * User-friendly display names for tools.
 *
 * Internal tool names are developer-facing and can be cryptic.
 * This mapping provides cleaner names for the UI.
 */

/**
 * Display names for specific tools that need custom names
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Built-in tools
  'Glob': 'Finding Files',
  'Grep': 'Searching Files',
  'Read': 'Reading File',
  'Write': 'Writing File',
  'Edit': 'Editing File',
  'Bash': 'Running Command',
  'Task': 'Running Agent',
  'Agent': 'Running Agent',
  'WebFetch': 'Fetching URL',
  'WebSearch': 'Searching Web',
  'TodoWrite': 'Updating Tasks',
  'NotebookEdit': 'Editing Notebook',

  // Documentation tools
  'SearchNessyAgents': 'Search Documentation',
};

/**
 * Set of tool names that represent parent task tools (subagent launchers).
 * The SDK renamed 'Task' to 'Agent' in v0.2.72 — both must be recognised.
 * Add future renames here instead of scattering checks across the codebase.
 */
export const PARENT_TASK_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** Check whether a tool name is a parent task tool (Task or Agent). */
export const isParentTaskTool = (name: string): boolean => PARENT_TASK_TOOLS.has(name);

/**
 * P3.24 — codex's COLLAB (multi-agent) tools, by the WIRE spelling the model
 * uses. These are codex's equivalent of `Task`/`Agent`: `spawn_agent` starts a
 * real child thread, the rest steer or close one.
 *
 * This set exists because the renderer had no way to recognise them. P3.4 made
 * `OrchestrationProgress` reach the transcript row for a codex spawn, but
 * `ChatDisplay` routed the subagent card on the single literal
 * `toolName === 'subagent'` — Pi's spelling — so the data was live and the card
 * never rendered. It lives HERE, next to {@link PARENT_TASK_TOOLS}, for that
 * file's own stated reason: a runtime's tool-name vocabulary belongs in one
 * place rather than scattered across the checks that consume it.
 *
 * Pinned to the adapter's own mapping by
 * `codex-collab-tool-routing.test.ts` — `COLLAB_TOOL_WIRE_NAMES`
 * (`agent/backend/codex/event-adapter.ts`) is what STAMPS these names onto the
 * transcript row, so a name added there and not here would reproduce exactly the
 * defect this set was added to fix, silently.
 */
export const CODEX_COLLAB_TOOLS: ReadonlySet<string> = new Set([
  'spawn_agent',
  'send_input',
  'resume_agent',
  'wait_agent',
  'close_agent',
]);

/** Check whether a tool name is one of codex's collab (multi-agent) tools. */
export const isCodexCollabTool = (name: string): boolean => CODEX_COLLAB_TOOLS.has(name);

/**
 * P3.295 — codex's PLAN tool, by the wire spelling the model uses.
 *
 * Here for the same reason as {@link CODEX_COLLAB_TOOLS} one block above, and
 * against the same measured failure: the host has two plan/todo views, both
 * routed on a TOOL NAME, and both knew only `TodoWrite`. Pi and claude reach
 * them by calling a tool; codex calls `update_plan`, and the app-server emits no
 * thread item for that call at all — so `backend/codex/event-adapter.ts`
 * synthesizes the row from `turn/plan/updated` and stamps THIS name on it. A
 * name spelled here and not there (or the reverse) reproduces exactly the defect
 * this constant exists to close, so `codex-plan-tool-routing.test.ts` pins the
 * adapter's constant against this one.
 */
export const CODEX_PLAN_TOOL_NAME = 'update_plan';

/**
 * Does this tool name write the session's plan/todo list?
 *
 * The two accepted vocabularies, and why the two comparisons differ:
 *  - `TodoWrite` — Pi and claude. Matched loosely (case-folded, `_`/`-`
 *    stripped, suffix) because it also arrives as `mcp__session__TodoWrite`
 *    depending on which surface served it.
 *  - {@link CODEX_PLAN_TOOL_NAME} — codex. Matched exactly, or with an
 *    `mcp__…__` prefix, and NOT case-folded: it is a lowercase wire name whose
 *    loose form (`updateplan`) would start matching unrelated future tools.
 */
export function isPlanWritingTool(name: string | undefined): boolean {
  if (!name) return false;
  if (name === CODEX_PLAN_TOOL_NAME || name.endsWith(`__${CODEX_PLAN_TOOL_NAME}`)) return true;
  return name.toLowerCase().replace(/[_-]/g, '').endsWith('todowrite');
}

/**
 * Tools that should be hidden from the UI (purely internal state changes)
 */
export const HIDDEN_TOOLS = new Set<string>([
  // Currently empty - safe mode is toggled via UI, not tools
]);

/**
 * Format tool name for display (snake_case to Title Case)
 * Generic fallback for tools without explicit mappings
 */
function formatToolName(name: string): string {
  // Handle MCP tools (mcp__server__tool)
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const tool = parts[2] || parts[1] || name;
    return tool.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Handle api_* tools
  if (name.startsWith('api_')) {
    const apiName = name.slice(4); // Remove 'api_' prefix
    return `API: ${apiName.charAt(0).toUpperCase() + apiName.slice(1)}`;
  }

  // Default: convert to title case
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get user-friendly display name for a tool.
 *
 * @param toolName - The internal tool name (e.g., "mcp__linear__list_issues")
 * @returns User-friendly display name
 */
export function getToolDisplayName(toolName: string): string {
  // Check explicit mappings first (full name)
  if (TOOL_DISPLAY_NAMES[toolName]) {
    return TOOL_DISPLAY_NAMES[toolName];
  }

  // For MCP tools, also check mapping with just the base tool name
  // e.g., "mcp__linear__list_issues" -> check "list_issues"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const baseName = parts[parts.length - 1] || toolName;
    if (baseName && TOOL_DISPLAY_NAMES[baseName]) {
      return TOOL_DISPLAY_NAMES[baseName];
    }
  }

  // Fallback to generic formatting
  return formatToolName(toolName);
}

/**
 * Check if a tool should be hidden from the UI
 */
export function shouldHideTool(toolName: string): boolean {
  // Check full name first
  if (HIDDEN_TOOLS.has(toolName)) {
    return true;
  }

  // For MCP tools, also check the base name
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const baseName = parts[parts.length - 1] || '';
    return HIDDEN_TOOLS.has(baseName);
  }

  return false;
}

/**
 * F1.434 / F1.435 — THE display names of the session server's own tools, one
 * table read by both the renderer (`getToolDisplayName`, packages/ui
 * `turn-preview.ts`) and the host (`resolveToolDisplayMeta`, server-core
 * `SessionManager.ts`).
 *
 * Until this table the two kept private copies that disagreed — the host knew
 * fourteen names the renderer did not, the renderer five the host did not — and
 * fifteen snake_case tools were in neither, so their rows showed the raw wire
 * name. `utils/__tests__/session-tool-display-names.test.ts` keeps it complete:
 * every snake_case entry of `SESSION_TOOL_DEFS` must have a label here, and every
 * key here must still be a session tool.
 *
 * The first block is the host's labels and the second the renderer's, both
 * verbatim (upstream craft-agents-oss v0.13.4 carries the same names in its two
 * tables, Apache-2.0). The third block is DERIVED — the snake_case name
 * title-cased, the rule `mapToolEventToActivity` already applies — with acronyms
 * written the way this table already writes them (`LLM Query`), because neither
 * upstream nor this repo named those fifteen anywhere.
 */
export const SESSION_TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // The host's table (resolveToolDisplayMeta), verbatim.
  'SubmitPlan': 'Submit Plan',
  'call_llm': 'LLM Query',
  'config_validate': 'Validate Config',
  'skill_validate': 'Validate Skill',
  'mermaid_validate': 'Validate Mermaid',
  'source_test': 'Test Source',
  'source_oauth_trigger': 'OAuth',
  'source_google_oauth_trigger': 'Google Auth',
  'source_credential_prompt': 'Enter Credentials',
  'transform_data': 'Transform Data',
  'render_template': 'Render Template',
  'update_user_preferences': 'Update Preferences',
  'send_developer_feedback': 'Send Feedback',
  'browser_tool': 'Browser',
  'spawn_session': 'Spawn Session',
  'archive_session': 'Archive Session',
  // UA1.18 — the t-artifacts pair; the turn header and the host's display meta read this one table.
  'publish_artifact': 'Publish Artifact',
  'list_artifacts': 'List Artifacts',
  // UA3.5 — the board task tool.
  'create_board_task': 'Create Board Task',
  // UB1.12 — the append-only project-memory note (upstream v0.15.1's label, verbatim).
  'project_memory_append': 'Add Project Note',
  // UB7.11 — the MCP prompt pair (upstream v0.15.1's labels, verbatim).
  // UB6.11 — the decide tool (upstream v0.15.1's label, verbatim).
  'decide': 'Decide',
  'source_list_prompts': 'List Source Prompts',
  'source_get_prompt': 'Get Source Prompt',
  // UA6.3 — the six page tools.
  'list_pages': 'List Pages',
  'get_page': 'Get Page',
  'create_page': 'Create Page',
  'update_page': 'Update Page',
  'write_page_data': 'Write Page Data',
  'delete_page': 'Delete Page',
  'send_agent_message': 'Send Agent Message',
  // The renderer's table (getToolDisplayName), verbatim.
  'TodoWrite': 'Todo List Updated',
  'set_session_labels': 'Set Session Labels',
  'set_session_status': 'Set Session Status',
  'get_session_info': 'Get Session Info',
  'list_sessions': 'List Sessions',
  // Derived (F1.434): title-cased from the tool-defs registry.
  'advisor_consult': 'Advisor Consult',
  'automation_create': 'Automation Create',
  'automation_list': 'Automation List',
  'automation_update': 'Automation Update',
  'automation_validate': 'Automation Validate',
  'list_mcp_resources': 'List MCP Resources',
  'plugin_install': 'Plugin Install',
  'plugin_manage': 'Plugin Manage',
  'plugin_plan_install': 'Plugin Plan Install',
  'plugin_status': 'Plugin Status',
  'read_mcp_resource': 'Read MCP Resource',
  'read_skill_resource': 'Read Skill Resource',
  'script_sandbox': 'Script Sandbox',
  'source_manage': 'Source Manage',
  'web_search': 'Web Search',
};

/**
 * The MCP server segments the session server is mounted under. Every runtime
 * says `session` today; `nessy_session` is the segment Codex used before its
 * config key was renamed, kept so a session recorded then still reads its
 * labels (the host's own comment on `internalMcpServers` records the history).
 */
export const SESSION_MCP_SERVER_SLUGS: ReadonlySet<string> = new Set(['session', 'nessy_session']);
