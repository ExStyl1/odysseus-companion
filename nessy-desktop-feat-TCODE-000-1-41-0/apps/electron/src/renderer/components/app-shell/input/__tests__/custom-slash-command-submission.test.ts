import { describe, expect, it } from 'bun:test'
import type { CustomSlashCommand } from '@nessy-agent/shared/slash-commands/common'
import {
  customSlashCommandInputSubmission,
  customSlashCommandMenuSubmission,
} from '../custom-slash-command-submission'

const PLUGIN_COMMAND: CustomSlashCommand = {
  id: 'custom:plugin:linear-helper:summarize',
  name: 'summarize',
  label: '/linear-helper:summarize',
}

describe('custom slash command renderer submission', () => {
  it('sends only the empty argument tail when selected from the menu', () => {
    expect(customSlashCommandMenuSubmission([PLUGIN_COMMAND], PLUGIN_COMMAND.id)).toEqual({
      message: '',
      customSlashCommandId: PLUGIN_COMMAND.id,
    })
  })

  it('matches a typed plugin command by its namespaced label and sends only its argument tail', () => {
    expect(customSlashCommandInputSubmission(
      [PLUGIN_COMMAND],
      '  /linear-helper:summarize release readiness  ',
    )).toEqual({
      message: 'release readiness',
      customSlashCommandId: PLUGIN_COMMAND.id,
    })
    expect(customSlashCommandInputSubmission([PLUGIN_COMMAND], '/summarize')).toBeNull()
  })
})
