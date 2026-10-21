/**
 * What the collapsed turn header SAYS — the decision, out of the component that
 * cannot be loaded. P2.493.
 *
 * **UB14.11 (v0.15.1's work log):** the header's one line moved to
 * `turn/work-log-summary.ts` (`getWorkLogPreview`, upstream's signature with the
 * run summary below as its settled text, and the error count a separate "N failed"
 * chip rather than a tail of the text). `getPreviewText` retired with it and its
 * value tests moved to `turn/__tests__/work-log-summary.test.ts`. What stays here
 * is the tool display name and the structural input type, which that module, the
 * row's `formatToolDisplay` and `turn/tool-display.ts` all read.
 *
 * ## Why this file exists
 *
 * `TurnCard.tsx` cannot be imported by the bun runner at all. Probed in a CHILD
 * process (a caught import failure is not a contained one — P3.316), it fails
 * with `Missing 'default' export in module '…/pdf.worker.min.mjs?url'`, reached
 * through `Markdown` → `MarkdownPdfBlock`; stubbing that specifier only moves the
 * failure to `ReferenceError: DOMMatrix is not defined` inside `react-pdf`'s
 * nested `pdfjs-dist`, and mocking THAT reaches `import.meta.glob`, which is not
 * mockable. It is a Vite-only specifier in a runner that is not Vite, and no
 * amount of stubbing gets past it.
 *
 * The consequence is what this row exists to fix: for as long as the decision
 * lived inside that file, the only thing a test could do was read its SOURCE —
 * and **a source assertion cannot tell a painted value from a dropped one**,
 * which is precisely the defect class the two P4 rows found. One of them would
 * have shipped a row rendering a label where the content belonged, and every
 * source-text assertion over it would have passed.
 *
 * ## The convention, stated once so it can be followed rather than rediscovered
 *
 * **A presentation DECISION does not live in an unloadable component.** It moves
 * to a plain module beside it and is asserted on VALUES. This directory already
 * did it five times before this row named it — `run-summary.ts`, `tool-elapsed.ts`,
 * `intermediate-row.ts`, `task-checklist.ts`, `mcp-tool-name.ts` — and each has a
 * test that drives real inputs instead of reading text. The component keeps the
 * JSX and imports the answer.
 *
 * Two things stay behind on purpose, because they are NOT decisions: the class
 * names on an element (what `turn-preview-label.test.ts` still reads from source,
 * correctly — `truncate`, and the absence of a responsive variant), and the JSX
 * shape itself. Reading source for a className is a statement about the markup;
 * reading source for a STRING is a statement about behaviour made by the wrong
 * instrument.
 *
 * ## The input type is structural, deliberately
 *
 * `ActivityItem` is declared inside `TurnCard.tsx`. Importing it from here would
 * name the unloadable module in this module's own import list, and whether that
 * survives to runtime depends on type-elision settings rather than on intent —
 * exactly the kind of thing that works until it does not. So this module declares
 * the six fields it actually reads. `ActivityItem` is assignable to it.
 */
import { SESSION_MCP_SERVER_SLUGS, SESSION_TOOL_DISPLAY_NAMES } from '@nessy-agent/shared/utils/toolNames'

import { parseMcpToolName } from './mcp-tool-name'

/** The fields of an activity that the header's label actually reads. */
export interface PreviewActivity {
  readonly type?: string
  readonly status?: string
  readonly toolName?: string
  readonly toolInput?: Record<string, unknown>
  readonly content?: string
  readonly intent?: string
}

/**
 * Display name for a tool: MCP prefixes stripped, then the session server's
 * friendly-name table. Moved here with its only caller; it is a display
 * decision, and it was unreachable by a test while it sat in the component.
 *
 * F1.434 / F1.435 — the table is `SESSION_TOOL_DISPLAY_NAMES`
 * (`@nessy-agent/shared/utils/toolNames`), the SAME one the host's
 * `resolveToolDisplayMeta` reads, so the row and the host can no longer name a
 * tool differently. It applies to a bare name and to the session server's own
 * `mcp__session__…` names; another server's tool that shares a name (a source's
 * own `web_search`) stays raw, and an unknown name falls through unchanged.
 */
export function getToolDisplayName(name: string): string {
  const parts = parseMcpToolName(name)
  const stripped = parts?.tool ?? name
  const sessionScoped = !parts || SESSION_MCP_SERVER_SLUGS.has(parts.server)
  return (sessionScoped ? SESSION_TOOL_DISPLAY_NAMES[stripped] : undefined) || stripped
}
