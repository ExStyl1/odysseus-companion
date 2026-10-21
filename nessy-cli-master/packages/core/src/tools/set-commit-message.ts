import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { Config } from '../config/config.js';
import { IdeClient } from '../ide/ide-client.js';

export interface SetCommitMessageToolParams {
  message: string;
}

class SetCommitMessageToolInvocation extends BaseToolInvocation<
  SetCommitMessageToolParams,
  ToolResult
> {
  constructor(params: SetCommitMessageToolParams) {
    super(params);
  }

  getDescription(): string {
    const preview =
      this.params.message.length > 80
        ? this.params.message.substring(0, 80) + '...'
        : this.params.message;
    return `Set commit message: "${preview}"`;
  }

  async execute(): Promise<ToolResult> {
    const ideClient = await IdeClient.getInstance();

    if (!ideClient.isSetCommitMessageEnabled()) {
      return {
        llmContent:
          'Error: IDE is not connected or does not support setting commit messages.',
        returnDisplay: 'IDE not connected',
        error: {
          message:
            'IDE is not connected or does not support setting commit messages.',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    try {
      await ideClient.setCommitMessage(this.params.message);
      return {
        llmContent: `Commit message has been set in the IDE.`,
        returnDisplay: `Commit message set in IDE`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error setting commit message in IDE: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

export class SetCommitMessageTool extends BaseDeclarativeTool<
  SetCommitMessageToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.SET_COMMIT_MESSAGE;

  constructor(_config: Config) {
    super(
      SetCommitMessageTool.Name,
      ToolDisplayNames.SET_COMMIT_MESSAGE,
      `Sets the commit message in the user's connected IDE commit panel (e.g., IntelliJ IDEA, VS Code). Use this tool when you need to fill in a commit message for the user.`,
      Kind.Other,
      {
        properties: {
          message: {
            description: 'The commit message to set in the IDE commit panel.',
            type: 'string',
          },
        },
        required: ['message'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: SetCommitMessageToolParams,
  ): string | null {
    if (!params.message || params.message.trim() === '') {
      return "The 'message' parameter must be non-empty.";
    }
    return null;
  }

  protected createInvocation(
    params: SetCommitMessageToolParams,
  ): ToolInvocation<SetCommitMessageToolParams, ToolResult> {
    return new SetCommitMessageToolInvocation(params);
  }
}
