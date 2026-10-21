/**
 * UA1.21 (OQ-22 (d), the default "redirect") — on Pi and Claude a shell command that reaches for the t-artifacts
 * service directly, or for the `artifact-publish` skill/package, is refused with a pointer to `publish_artifact`.
 *
 * Both runtimes reach this through the ONE gate their pre-tool hooks call, `runPreToolUseChecks` (claude's PreToolUse
 * hook; Pi's pre_tool_use bridge, where the `bash` binding carries `permissionName: 'Bash'`), so driving that function
 * with `Bash` and `Monitor` is driving both. Codex shell commands never reach it: a stated residue
 * (`apps/electron/resources/docs/artifacts.md`).
 *
 * Positive: the plan's own probe (`curl https://t-artifacts.t-tech.team/api/artifacts`) and the skill/package
 * spellings are BLOCKED with the pointer in every permission mode, bypass included. Negative: `curl https://example.com`
 * (the plan's control), this repository's own `artifact-publish-flow.test.ts`, and an `artifact-publishing` word are
 * not touched by the rule; a non-shell tool is not either.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { ARTIFACT_PUBLISH_SHELL_REDIRECT, artifactPublishShellRedirect, runPreToolUseChecks, T_ARTIFACTS_SHELL_HOST, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import type { PermissionMode } from '../mode-types.ts'
import { T_ARTIFACTS_ORIGIN } from '../../artifacts/t-artifacts-client.ts'

const KEY = { workspaceId: 'ws-ua121', sessionId: 'session-ua121' }
const ROOT = '/tmp/nessy-ua121-workspace'

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

/** The gate as both runtimes call it; the reason is read into a local before any assertion. */
function check(toolName: string, command: string, mode: PermissionMode): { type: string; reason: string; source: string | undefined } {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input: { command },
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: ROOT,
    workspaceId: KEY.workspaceId,
    workingDirectory: ROOT,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  })
  const reason = result.type === 'block' ? result.reason : ''
  const source = result.type === 'block' ? result.source : undefined
  return { type: result.type, reason, source }
}

/** The modes that reach step 5b for a shell command; `dontAsk` refuses it earlier, in the mode block (its own arm). */
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions']

const REDIRECTED = [
  'curl https://t-artifacts.t-tech.team/api/artifacts',
  'curl -s -X POST HTTPS://T-Artifacts.T-Tech.Team/api/artifacts -H "Authorization: Bearer $(dp auth print-token)" -d @page.json',
  'npx @loyalty-personalization/artifact-publish ./report.html',
  'npx -y artifact-publish@1.0.13 report.html',
  'bash ~/.agents/skills/artifact-publish/scripts/publish.sh report.html',
]

const UNTOUCHED = [
  'curl https://example.com',
  'bun test ./packages/server-core/src/sessions/__tests__/artifact-publish-flow.test.ts',
  'echo artifact-publishing && ls my-artifact-publish',
]

describe('UA1.21 the t-artifacts shell redirect', () => {
  it('names the same host the client sends to (one origin, two spellings)', () => {
    expect(new URL(T_ARTIFACTS_ORIGIN).hostname).toBe(T_ARTIFACTS_SHELL_HOST)
  })

  it('positive: the plan probe and the skill/package spellings are refused with the publish_artifact pointer, every mode, Bash and Monitor', () => {
    for (const toolName of ['Bash', 'Monitor']) {
      for (const mode of MODES) {
        for (const command of REDIRECTED) {
          const { type, reason } = check(toolName, command, mode)
          expect(type, `${toolName} ${mode} ${command}`).toBe('block')
          expect(reason, `${toolName} ${mode} ${command}`).toContain('Use the publish_artifact tool instead')
        }
      }
    }
    expect(ARTIFACT_PUBLISH_SHELL_REDIRECT).toContain('list_artifacts')
    expect(ARTIFACT_PUBLISH_SHELL_REDIRECT).toContain('nothing was run')
  })

  it('dontAsk: the mode block refuses first, and the refusal is FINAL — no would-prompt marker a PermissionRequest hook could re-open', () => {
    for (const command of REDIRECTED) {
      const { type, source } = check('Bash', command, 'dontAsk')
      expect(type, command).toBe('block')
      expect(source, command).toBeUndefined()
    }
    // The control on the same instrument: an ordinary network command IS marked re-openable in dontAsk.
    expect(check('Bash', 'curl https://example.com', 'dontAsk').source).toBe('dont_ask_would_prompt')
  })

  it('negative: another host, this repo\'s own artifact-publish-flow test file and an artifact-publishing word are not redirected', () => {
    for (const command of UNTOUCHED) {
      expect(artifactPublishShellRedirect('Bash', { command }), command).toBeNull()
      for (const mode of MODES) {
        const { reason } = check('Bash', command, mode)
        expect(reason, `${mode} ${command}`).not.toContain('publish_artifact')
      }
    }
    // In bypass the control is not merely "not this message" but a plain allow.
    expect(check('Bash', 'curl https://example.com', 'bypassPermissions').type).toBe('allow')
  })

  it('negative: only the shell spellings are read — a file tool naming the host is not this rule\'s business', () => {
    expect(artifactPublishShellRedirect('Read', { command: 'curl https://t-artifacts.t-tech.team/api/artifacts' })).toBeNull()
    expect(artifactPublishShellRedirect('Bash', {})).toBeNull()
  })
})
