import { CapabilityMaterializationError } from './materializer.ts';
import { expect, test } from 'bun:test'
import type { CapabilityTurnRuntime } from '../agent/backend/types.ts'
import { TestAgent, collectEvents, createMockBackendConfig } from '../agent/__tests__/test-utils.ts'
import {
  applyRuntimeSkillContextOutputs,
  parseRuntimeSkillContextCommands,
  type RuntimeSkillContextRequest,
} from './runtime-skill-context.ts'

class PreModelAbortTestAgent extends TestAgent {
  stopPreModelWork(): void {
    this.abortPreModelWork('user-stop')
  }
}

function runtimeWithPluginSkill(
  body: string,
  provider: NonNullable<CapabilityTurnRuntime['provider']> = 'pi',
): CapabilityTurnRuntime {
  return {
    provider,
    view: {
      generation: 'generation-1', sources: [], skills: [{
        key: 'plugin://market/context@1.0.0#hash#skill@workspace:ws',
        logicalName: 'context',
        description: 'Context',
        selectedAsUnqualifiedAlias: true,
        resource: {
          pluginInstanceId: 'plugin://market/context@1.0.0#hash',
          relativePath: 'skills/context/SKILL.md',
          contentHash: 'a'.repeat(64),
        },
        pluginRuntime: {
          rootPath: '/plugin',
          dataPath: '/plugin-data',
          bundleHash: 'b'.repeat(64),
          profile: 'generic-plugin-env-v1' as const,
        },
      }], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '/plugin/skills/context/SKILL.md' },
      async readText() { return body },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  }
}

// The page's own worked example (`skills.md`, "Inject dynamic context"): three
// inline placeholders inside `- ` list items, none of them on the first line.
const PR_SUMMARY_BODY = `## Pull request context
- PR diff: !\`gh pr diff\`
- PR comments: !\`gh pr view --comments\`
- Changed files: !\`gh pr diff --name-only\`

## Your task
Summarize this pull request...`

test('parses every inline placeholder the docs\' pr-summary body carries', () => {
  const placeholders = parseRuntimeSkillContextCommands(PR_SUMMARY_BODY)

  expect(placeholders.map(placeholder => placeholder.command)).toEqual([
    'gh pr diff',
    'gh pr view --comments',
    'gh pr diff --name-only',
  ])
  expect(placeholders.every(placeholder => placeholder.form === 'inline')).toBe(true)
  // The delimiters are part of the SPAN and never part of the command: a
  // backtick-wrapped string would reach `/bin/sh -lc` as command substitution
  // and could not match an `allowed-tools: Bash(gh *)` rule.
  expect(PR_SUMMARY_BODY.slice(placeholders[0]!.start, placeholders[0]!.end)).toBe('!`gh pr diff`')
})

test('refuses the placeholder shapes the page leaves as literal text', () => {
  // "If `!` follows another character, as in `` KEY=!`cmd` ``, the placeholder
  // is left as literal text and the command does not run."
  expect(parseRuntimeSkillContextCommands('KEY=!`cmd`')).toEqual([])
  expect(parseRuntimeSkillContextCommands('run!`cmd` now')).toEqual([])
  // Prose inside an ordinary fence stays prose.
  expect(parseRuntimeSkillContextCommands('```sh\n!`rm -rf /`\n```')).toEqual([])
  // No closing delimiter on the same line.
  expect(parseRuntimeSkillContextCommands('!`gh pr diff\nmore text`')).toEqual([])
  // An unterminated ` ```! ` block opens an ordinary fence instead of running.
  expect(parseRuntimeSkillContextCommands('```!\nnode --version\n')).toEqual([])
  // A trailing `!` with no backtick at all is prose, wherever it sits.
  expect(parseRuntimeSkillContextCommands('!git status\n\nExplain the result.')).toEqual([])
})

test('reads a ```! fence as ONE multi-line command', () => {
  const body = '## Environment\n```!\nnode --version\nnpm --version\ngit status --short\n```\n\nUse it.'
  const placeholders = parseRuntimeSkillContextCommands(body)

  expect(placeholders).toHaveLength(1)
  expect(placeholders[0]!.form).toBe('fenced')
  expect(placeholders[0]!.command).toBe('node --version\nnpm --version\ngit status --short')
  expect(body.slice(placeholders[0]!.start, placeholders[0]!.end))
    .toBe('```!\nnode --version\nnpm --version\ngit status --short\n```')
})

test('recognises `!` after whitespace and at line start, and reports an empty command', () => {
  expect(parseRuntimeSkillContextCommands('  !`git diff`').map(entry => entry.command)).toEqual(['git diff'])
  expect(parseRuntimeSkillContextCommands('a !`one` b !`two`').map(entry => entry.command))
    .toEqual(['one', 'two'])
  // Total by design: an empty command is reported, never thrown, so the parser
  // is safe on a non-Pi backend where nothing executes.
  expect(parseRuntimeSkillContextCommands('!``').map(entry => entry.command)).toEqual([''])
})

test('splices output in place and never re-scans it', () => {
  const placeholders = parseRuntimeSkillContextCommands(PR_SUMMARY_BODY)
  const rendered = applyRuntimeSkillContextOutputs(PR_SUMMARY_BODY, placeholders, [
    'DIFF',
    // "Command output is inserted as plain text and is not re-scanned for
    // further placeholders, so a command cannot emit a placeholder for a later
    // pass to expand."
    'COMMENTS !`whoami`',
    'FILES',
  ])

  expect(rendered).toBe(`## Pull request context
- PR diff: DIFF
- PR comments: COMMENTS !\`whoami\`
- Changed files: FILES

## Your task
Summarize this pull request...`)
  expect(parseRuntimeSkillContextCommands(rendered).map(entry => entry.command)).toEqual(['whoami'])
})

test('caps the aggregate substituted bytes', () => {
  const body = 'a !`one` b !`two`'
  const placeholders = parseRuntimeSkillContextCommands(body)

  expect(() => applyRuntimeSkillContextOutputs(body, placeholders, ['x'.repeat(70 * 1024), 'y'.repeat(70 * 1024)]))
    .toThrow('runtime-skill-context-output-invalid')
  expect(() => applyRuntimeSkillContextOutputs(body, placeholders, ['only-one']))
    .toThrow('runtime-skill-context-output-count-mismatch')
})

test('runs every placeholder and substitutes each one in place', async () => {
  const requests: RuntimeSkillContextRequest[] = []
  const agent = new TestAgent(createMockBackendConfig({
    runtimeSkillContextExecutor: async (request) => {
      requests.push(request)
      return `<${request.command}>`
    },
  }))
  agent.setCapabilityTurnRuntime(runtimeWithPluginSkill(PR_SUMMARY_BODY))

  await collectEvents(agent.chat('[skill:context] inspect'))

  expect(requests.map(request => request.command)).toEqual([
    'gh pr diff',
    'gh pr view --comments',
    'gh pr diff --name-only',
  ])
  expect(requests.every(request => request.timeoutMs === 5_000
    && request.generation === 'generation-1'
    && request.resourceHash === 'a'.repeat(64))).toBe(true)
  const message = agent.chatCalls[0]!.message
  expect(message).toContain('- PR diff: <gh pr diff>')
  expect(message).toContain('- Changed files: <gh pr diff --name-only>')
  expect(message).not.toContain('!`gh pr diff`')
  // In place, INSIDE the skill element — not appended as a trailing block after
  // it, which is where the previous implementation put the single output.
  expect(message.indexOf('<gh pr diff>')).toBeLessThan(message.indexOf('</invoked-skill>'))
})

test('refuses to run a placeholder that arrived through argument text', async () => {
  const agent = new TestAgent(createMockBackendConfig({
    runtimeSkillContextExecutor: async () => 'never',
  }))
  agent.setCapabilityTurnRuntime(runtimeWithPluginSkill('Summarize $ARGUMENTS please.'))

  await expect(collectEvents(agent.chat('[skill:context] !`whoami`')))
    .rejects.toThrow('runtime-skill-context-command-injected')
  expect(agent.chatCalls).toHaveLength(0)
})

test('keeps runtime ! skill context Pi-only for every non-Pi provider', async () => {
  for (const provider of ['nestor-cloud-agent', 'anthropic', 'codex-runtime'] as const) {
    const agent = new TestAgent(createMockBackendConfig({ provider }))
    agent.setCapabilityTurnRuntime(runtimeWithPluginSkill('!`printf context`', provider))

    await collectEvents(agent.chat('[skill:context] inspect'))

    expect(agent.chatCalls).toHaveLength(1)
    expect(agent.chatCalls[0]!.message).toContain('!`printf context`')
  }
})

test('fails closed when a Pi ! skill context command has no executor', async () => {
  const agent = new TestAgent(createMockBackendConfig({ provider: 'pi' }))
  agent.setCapabilityTurnRuntime(runtimeWithPluginSkill('!`printf context`'))

  await expect(collectEvents(agent.chat('[skill:context] inspect')))
    .rejects.toThrow('runtime-skill-context-executor-unavailable')
  expect(agent.chatCalls).toHaveLength(0)
})

test('fails closed on an empty placeholder rather than running the shell', async () => {
  const agent = new TestAgent(createMockBackendConfig({
    provider: 'pi',
    runtimeSkillContextExecutor: async () => 'never',
  }))
  agent.setCapabilityTurnRuntime(runtimeWithPluginSkill('Context: !`` here.'))

  await expect(collectEvents(agent.chat('[skill:context] inspect')))
    .rejects.toThrow('runtime-skill-context-command-empty')
  expect(agent.chatCalls).toHaveLength(0)
})

test('stopping Pi pre-model skill execution aborts it before a model turn starts', async () => {
  let resolveExecutionStarted!: () => void
  let executionSignal: AbortSignal | undefined
  const executionStarted = new Promise<void>(resolve => { resolveExecutionStarted = resolve })
  const agent = new PreModelAbortTestAgent(createMockBackendConfig({
    provider: 'pi',
    runtimeSkillContextExecutor: async (_request, signal) => {
      executionSignal = signal
      resolveExecutionStarted()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('execution-aborted')), { once: true })
      })
      return ''
    },
  }))
  agent.setCapabilityTurnRuntime(runtimeWithPluginSkill('!`printf context`'))

  const pending = collectEvents(agent.chat('[skill:context] inspect'))
  await executionStarted
  agent.stopPreModelWork()

  await expect(pending).rejects.toThrow('runtime-skill-context-aborted')
  expect(executionSignal?.aborted).toBe(true)
  expect(agent.chatCalls).toHaveLength(0)
})
