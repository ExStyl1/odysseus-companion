import path from 'node:path';
import { makeRelative, shortenPath } from '../utils/paths.js';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { IdeClient } from '../ide/ide-client.js';

export interface OpenFileInIdeToolParams {
  file_path: string;
  line?: number;
  column?: number;
}

class OpenFileInIdeToolInvocation extends BaseToolInvocation<
  OpenFileInIdeToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: OpenFileInIdeToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    const shortPath = shortenPath(relativePath);
    if (this.params.line) {
      return `${shortPath}:${this.params.line}`;
    }
    return shortPath;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path, line: this.params.line }];
  }

  async execute(): Promise<ToolResult> {
    const ideClient = await IdeClient.getInstance();

    if (!ideClient.isOpenFileEnabled()) {
      return {
        llmContent:
          'Error: IDE is not connected or does not support opening files.',
        returnDisplay: 'IDE not connected',
        error: {
          message: 'IDE is not connected or does not support opening files.',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    try {
      await ideClient.openFile(
        this.params.file_path,
        this.params.line,
        this.params.column,
      );

      const relativePath = makeRelative(
        this.params.file_path,
        this.config.getTargetDir(),
      );
      const location = this.params.line
        ? `${relativePath}:${this.params.line}`
        : relativePath;

      return {
        llmContent: `Opened ${location} in the IDE.`,
        returnDisplay: `Opened ${location} in the IDE`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error opening file in IDE: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

export class OpenFileInIdeTool extends BaseDeclarativeTool<
  OpenFileInIdeToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.OPEN_FILE_IN_IDE;

  constructor(private config: Config) {
    super(
      OpenFileInIdeTool.Name,
      ToolDisplayNames.OPEN_FILE_IN_IDE,
      `Opens a file in the user's connected IDE (e.g., IntelliJ IDEA, VS Code). Use this tool when the user explicitly asks to open a file in their IDE. Optionally navigates to a specific line and column.`,
      Kind.Other,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to open in the IDE (e.g., '/home/user/project/file.txt').",
            type: 'string',
          },
          line: {
            description:
              'Optional: The 1-based line number to navigate to after opening the file.',
            type: 'number',
          },
          column: {
            description:
              'Optional: The 1-based column number to navigate to after opening the file.',
            type: 'number',
          },
        },
        required: ['file_path'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: OpenFileInIdeToolParams,
  ): string | null {
    if (!params.file_path || params.file_path.trim() === '') {
      return "The 'file_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute, but was relative: ${params.file_path}.`;
    }
    return null;
  }

  protected createInvocation(
    params: OpenFileInIdeToolParams,
  ): ToolInvocation<OpenFileInIdeToolParams, ToolResult> {
    return new OpenFileInIdeToolInvocation(this.config, params);
  }
}
