/**
 * Browser Tools (`browser_tool`)
 *
 * Session-scoped tooling that enables the agent to interact with built-in
 * in-app browser windows via a single CLI-like command wrapper.
 * Commands delegate to BrowserPaneFns callbacks wired by Electron's
 * SessionManager to BrowserPaneManager.
 *
 * The session → browser instance mapping is handled by the callback provider
 * (getOrCreateForSession pattern), so commands don't need instance IDs.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ToolResult } from '@nessy-agent/session-tools-core';
import { executeBrowserToolCommand } from './browser-tool-runtime.ts';
import { convertResult } from './session-tool-result.ts';

/**
 * C3.147 (QJ9 = A, owner 2026-09-11) — the result type this file used to
 * declare for itself is gone.
 *
 * It existed for one reason: the registry's `ToolResult` carried `TextContent[]`
 * and nothing else, so a tool that had to return a screenshot could not be
 * written against it. P6.345 (`5a181b9fc`) removed that ceiling by adding
 * `extraContent?: NonTextContent[]` to the registry type
 * (`packages/session-tools-core/src/types.ts`), and this file kept its
 * hand-rolled MCP shape anyway — legacy, not a sanctioned bypass.
 *
 * So these helpers now build the registry's `ToolResult` and the SDK handler
 * converts it at the boundary through the SAME `convertResult` every other
 * session tool goes through. The wire is byte-identical — `convertResult`
 * appends `extraContent` after `content`, so the screenshot still arrives as
 * `content[1]` behind its text — which is why the existing case asserting that
 * position is untouched.
 *
 * `errorResponse`/`successResponse` stay local rather than being taken from
 * `@nessy-agent/session-tools-core`: that module's `errorResponse` prefixes
 * `[ERROR]` for the codex wire, and these tools are claude-only, so adopting it
 * would change the text a user reads for no parity gain. That is a wording
 * choice, not a type, and it is the only thing this file still decides.
 */
function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function successResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

const BROWSER_RELEASE_HINT = '\n\nWhen you are done using the browser, call browser_tool with command "close" to close the window entirely, or "release" to dismiss the overlay and let the user continue browsing.';

// ============================================================================
// Browser Pane Function Interface
// ============================================================================

/** UB4.15 (v0.15.1) — how a click reached the element: trusted mouse input, or DOM events (`note` says why). */
export interface BrowserClickResult {
  via: 'mouse' | 'script'
  note?: string
  /** A popup the click opened, or a sign-in window refused because another browser window has one open. */
  popup?: string
}

/**
 * Abstraction over BrowserPaneManager for use in session-scoped tools.
 * The Electron session manager creates this by binding to a specific session's
 * browser instance via getOrCreateForSession(sessionId).
 */
export interface BrowserScreenshotArgs {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  /** Annotate screenshot with @eN labels on all interactive elements */
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: Record<string, unknown>
}

export interface BrowserConsoleArgs {
  level?: 'all' | 'log' | 'info' | 'warn' | 'error'
  limit?: number
}

export interface BrowserScreenshotRegionArgs {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserWindowResizeArgs {
  width: number
  height: number
}

export interface BrowserNetworkArgs {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadsArgs {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserLifecycleActionResult {
  action: 'closed' | 'hidden' | 'released' | 'noop'
  requestedInstanceId?: string
  resolvedInstanceId?: string
  affectedIds: string[]
  reason?: string
}

export interface BrowserPaneFns {
  openPanel: (options?: { background?: boolean }) => Promise<{ instanceId: string }>;
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  snapshot: () => Promise<{ url: string; title: string; nodes: Array<{ ref: string; role: string; name: string; value?: string; description?: string; focused?: boolean; checked?: boolean; disabled?: boolean }> }>;
  click: (ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }) => Promise<BrowserClickResult | void>;
  clickAt: (x: number, y: number) => Promise<void>;
  drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  fill: (ref: string, value: string) => Promise<void>;
  type: (text: string) => Promise<void>;
  select: (ref: string, value: string) => Promise<void>;
  setClipboard: (text: string) => Promise<void>;
  getClipboard: () => Promise<string>;
  screenshot: (args?: BrowserScreenshotArgs) => Promise<BrowserScreenshotResult>;
  screenshotRegion: (args: BrowserScreenshotRegionArgs) => Promise<BrowserScreenshotResult>;
  getConsoleLogs: (args?: BrowserConsoleArgs) => Promise<Array<{ timestamp: number; level: 'log' | 'info' | 'warn' | 'error'; message: string }>>;
  windowResize: (args: BrowserWindowResizeArgs) => Promise<{ width: number; height: number }>;
  getNetworkLogs: (args?: BrowserNetworkArgs) => Promise<Array<{ timestamp: number; method: string; url: string; status: number; resourceType: string; ok: boolean }>>;
  waitFor: (args: BrowserWaitArgs) => Promise<{ ok: true; kind: string; elapsedMs: number; detail: string }>;
  sendKey: (args: BrowserKeyArgs) => Promise<void>;
  getDownloads: (args?: BrowserDownloadsArgs) => Promise<Array<{ id: string; timestamp: number; url: string; filename: string; state: string; bytesReceived: number; totalBytes: number; mimeType: string; savePath?: string }>>;
  upload: (ref: string, filePaths: string[]) => Promise<void>;
  scroll: (direction: 'up' | 'down' | 'left' | 'right', amount?: number) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  evaluate: (expression: string) => Promise<unknown>;
  focusWindow: (instanceId?: string) => Promise<{ instanceId: string; title: string; url: string }>;
  releaseControl: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  closeWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  hideWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  listWindows: () => Promise<Array<{
    id: string;
    title: string;
    url: string;
    isVisible: boolean;
    ownerType: 'session' | 'manual';
    ownerSessionId: string | null;
    boundSessionId: string | null;
    agentControlActive?: boolean;
  }>>;
  detectChallenge: () => Promise<{ detected: boolean; provider: string; signals: string[]; suspected?: boolean }>;
}

// ============================================================================
// Tool Factory Options
// ============================================================================

export interface BrowserToolsOptions {
  sessionId: string;
  /**
   * Lazy resolver for browser pane functions.
   * Called at execution time to get the current callback from the session registry.
   */
  getBrowserPaneFns: () => BrowserPaneFns | undefined;
}

// ============================================================================
// Tool Descriptions
// ============================================================================

const BROWSER_TOOL_DESCRIPTION = `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

Examples:
- \`--help\`
- \`open\`
- \`navigate https://example.com\`
- \`snapshot\`
- \`find login button\` — search elements by keyword
- \`click @e12\`
- \`click-at 350 200\` — click at pixel coordinates (for canvas elements)
- \`drag 100 200 300 400\` — drag from (100,200) to (300,400)
- \`fill @e5 user@example.com\`
- \`type Hello World\` — type into currently focused element (no ref needed)
- \`select @e3 optionValue\`
- \`select @e75 CNAME --assert-text Target --timeout 3000\`
- \`set-clipboard Name\\tAge\\nAlice\\t30\` — write text to clipboard
- \`get-clipboard\` — read clipboard text content
- \`paste Name\\tAge\\nAlice\\t30\` — set clipboard and trigger Ctrl/Cmd+V
- \`upload @e3 /path/to/file.pdf\` — attach local file(s) to a file input
- \`scroll down 800\`
- \`evaluate document.title\`
- \`console 50 error\`
- \`screenshot\` — raw screenshot
- \`screenshot --annotated\` — screenshot with @eN labels overlaid on interactive elements
- \`screenshot-region 100 200 640 480\`
- \`screenshot-region --ref @e12 --padding 8\`
- \`screenshot-region --selector div[data-testid="chart"]\`
- \`window-resize 1440 900\`
- \`network 50 failed\`
- \`wait network-idle 8000\`
- \`key Enter\`
- \`key k meta\`
- \`downloads wait 15000\`
- \`focus [windowId]\` — focus existing browser window (no new window)
- \`windows\` — list current browser windows and ownership state
- \`release [windowId|all]\` — dismiss the agent control overlay when done
- \`close [windowId]\` — close and destroy the browser window
- \`hide [windowId]\` — hide the window while preserving state`;

// ============================================================================
// Tool Factories
// ============================================================================

export function createBrowserTools(options: BrowserToolsOptions) {
  function getBrowserFns(): BrowserPaneFns {
    const fns = options.getBrowserPaneFns();
    if (!fns) {
      throw new Error('Browser window controls are not available. This tool requires the desktop app.');
    }
    return fns;
  }

  return [
    // Single CLI-like tool for all browser actions
    tool(
      'browser_tool',
      BROWSER_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
      },
      async (args) => {
        try {
          const result = await executeBrowserToolCommand({
            command: args.command,
            fns: getBrowserFns(),
            sessionId: options.sessionId,
          });

          const text = result.appendReleaseHint
            ? result.output + BROWSER_RELEASE_HINT
            : result.output;

          if (result.image) {
            return convertResult({
              content: [{ type: 'text', text }],
              extraContent: [
                { type: 'image', data: result.image.data, mimeType: result.image.mimeType },
              ],
            });
          }

          return convertResult(successResponse(text));
        } catch (error) {
          return convertResult(errorResponse(error instanceof Error ? error.message : String(error)));
        }
      },
    ),
  ];
}
