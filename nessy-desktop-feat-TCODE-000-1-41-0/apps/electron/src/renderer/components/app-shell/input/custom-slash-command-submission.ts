import {
  findCustomSlashCommand,
  type CustomSlashCommand,
  type CustomSlashCommandId,
} from '@nessy-agent/shared/slash-commands/common'

export interface CustomSlashCommandSubmission {
  message: string
  customSlashCommandId: CustomSlashCommandId
}

export function customSlashCommandMenuSubmission(
  commands: readonly CustomSlashCommand[],
  commandId: string,
): CustomSlashCommandSubmission | null {
  const command = findCustomSlashCommand(commands, commandId)
  return command ? { message: '', customSlashCommandId: command.id } : null
}

export function customSlashCommandInputSubmission(
  commands: readonly CustomSlashCommand[],
  input: string,
): CustomSlashCommandSubmission | null {
  const invocation = input.trim()
  const command = commands.find(candidate =>
    invocation === candidate.label
    || (invocation.startsWith(candidate.label) && /\s/.test(invocation[candidate.label.length] ?? '')))
  if (!command) return null

  return {
    message: invocation.slice(command.label.length).trim(),
    customSlashCommandId: command.id,
  }
}
