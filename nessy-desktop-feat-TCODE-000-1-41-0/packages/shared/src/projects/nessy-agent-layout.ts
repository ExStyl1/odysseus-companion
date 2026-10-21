/**
 * Canonical Nessy project namespace (P2 cutover,
 * plan deleted at release 1.2.0; recover with
 * `git show 4d038f04^:docs/current-plans/project-local-nessy-agent-and-workspace-roots.md`).
 *
 * `<project>/.nessy-agent` is the ONLY Nessy-native project scope. The
 * superseded `.nessy` directory has no legacy status: no reader, alias,
 * fallback or migration may reference it. Portable standards (`AGENTS.md`,
 * `MEMORY.md`, `.agents/*`, `.mcp.json`) are separate explicit inputs, not
 * part of this namespace.
 */
export const NESSY_AGENT_PROJECT_DIR = '.nessy-agent';
