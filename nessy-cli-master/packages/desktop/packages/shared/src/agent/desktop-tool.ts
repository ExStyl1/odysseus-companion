import {
  DesktopToolSchema,
  TOOL_DESCRIPTIONS,
} from '@craft-agent/session-tools-core';
import { localTool } from '../mcp/local-tools.ts';

// [nessy-fork] desktop-workspace-file-control
export type DesktopAction =
  | { action: 'open_file'; path: string }
  | { action: 'open_url'; url: string }
  | { action: 'show_workspace' };

export type DesktopActionFn = (action: DesktopAction) => Promise<void>;

export function createDesktopTool(options: {
  getDesktopActionFn: () => DesktopActionFn | undefined;
}) {
  return localTool(
    'desktop_tool',
    TOOL_DESCRIPTIONS.desktop_tool,
    // session-tools-core uses Zod 3 while the desktop MCP runtime uses Zod 4.
    DesktopToolSchema.shape as any,
    async (input: Record<string, unknown>) => {
      const args = DesktopToolSchema.parse(input);
      const desktopAction = options.getDesktopActionFn();
      if (!desktopAction) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Desktop interface is not available in this context.',
            },
          ],
          isError: true,
        };
      }

      try {
        if (args.action === 'open_file') {
          if (!args.path) throw new Error('path is required for open_file');
          await desktopAction({ action: args.action, path: args.path });
        } else if (args.action === 'open_url') {
          if (!args.url) throw new Error('url is required for open_url');
          await desktopAction({ action: args.action, url: args.url });
        } else {
          await desktopAction({ action: args.action });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Desktop action "${args.action}" completed.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
