import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SupervisedProcessResult } from '../../../shared/src/agent/pi-harness/process-supervisor-port.ts'

export interface BackgroundBashDetails {
  shellId?: string
  command?: string
  isError?: boolean
  error?: string
  isolationProfile?: string
}

interface BackgroundBashInput { command?: string }

export interface ShellBackgroundedEvent {
  type: 'shell_backgrounded'
  toolUseId: string
  shellId: string
  command: string
}

interface CreateBackgroundBashToolOptions {
  emitEvent(event: ShellBackgroundedEvent): void
  start(command: string, toolCallId: string, signal?: AbortSignal): Promise<SupervisedProcessResult>
}

function textResult(text: string, details: BackgroundBashDetails = {}): AgentToolResult<BackgroundBashDetails> {
  return { content: [{ type: 'text', text }], details }
}

export function createBackgroundBashTool(options: CreateBackgroundBashToolOptions): ToolDefinition<BackgroundBashInput, BackgroundBashDetails> {
  return {
    name: 'bash_background',
    label: 'Background Bash',
    description: 'Run a shell command in the background and return a shell_id for later inspection or termination.',
    promptSnippet: 'Use bash_background for long-running shell commands that should continue while you do other work. Pass command. The result includes shell_id; use mcp__session__ProcessStop to stop it.',
    parameters: {
      type: 'object', required: ['command'], additionalProperties: false,
      properties: { command: { type: 'string', description: 'Shell command to run in the background.' } },
    } as any,
    prepareArguments: args => args as BackgroundBashInput,
    async execute(toolCallId, params, signal) {
      const input = params as BackgroundBashInput
      const command = typeof input.command === 'string' ? input.command.trim() : ''
      if (!command) return textResult('bash_background requires a non-empty command.', { isError: true, error: 'bash_background requires a non-empty command.' })
      if (signal?.aborted) return textResult('bash_background was aborted before start.', { isError: true, error: 'bash_background was aborted before start.' })
      try {
        const started = await options.start(command, toolCallId, signal)
        options.emitEvent({ type: 'shell_backgrounded', toolUseId: toolCallId, shellId: started.handle, command })
        return textResult(`Started background shell\nshell_id: ${started.handle}`, {
          shellId: started.handle, command, isolationProfile: started.isolationProfile,
        })
      } catch (error) {
        const message = `Failed to start background shell: ${error instanceof Error ? error.message : String(error)}`
        return textResult(message, { isError: true, error: message })
      }
    },
  }
}
