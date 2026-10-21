/**
 * R85 · f141 — the write half of the hook env-file channel is only real if the
 * hook can actually write the file.
 *
 * hooks.md § SessionStart: "To set individual environment variables, write
 * `export` statements to `CLAUDE_ENV_FILE`. Use append (`>>`) to preserve
 * variables set by other hooks."
 *
 * `SessionManager.pluginCommandHookRunner` spawns the hook with
 * `profile: 'workspace'` rooted at the project directory, so the env file — which
 * deliberately lives OUTSIDE every model-writable root — is unwritable unless its
 * directory is handed to `additionalWritableRoots`. This runs the real sandbox
 * profile both ways on the same rig: the second arm is the positive control, and
 * it is the arm that fails today without the grant.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureHookEnvFile, hookEnvFileDirPath, hookEnvFilePath } from '@nessy-agent/shared/automations'
import { getSessionStoragePath } from '@nessy-agent/shared/workspaces/paths'
import { resolveProcessIsolation } from './isolation.ts'

const WORKSPACE_ID = 'ws-r85-writable-root'
const SESSION_ID = 'session-r85-writable-root'

/** The documented recipe, run under the real profile the hook spawn resolves. */
function appendUnderWorkspaceProfile(input: {
  workspaceRoot: string
  scratchRoot: string
  envFile: string
  additionalWritableRoots?: readonly string[]
}): number | null {
  const plan = resolveProcessIsolation({
    platform: 'darwin',
    profile: 'workspace',
    command: '/bin/sh',
    args: ['-c', `echo 'export FOO=bar' >> ${JSON.stringify(input.envFile)}`],
    workspaceRoot: input.workspaceRoot,
    workingDirectory: input.workspaceRoot,
    scratchRoot: input.scratchRoot,
    ...(input.additionalWritableRoots ? { additionalWritableRoots: input.additionalWritableRoots } : {}),
  })
  return spawnSync(plan.command, plan.args, { stdio: 'ignore' }).status
}

describe('the hook env file is writable only because its directory is granted', () => {
  it('appends with the grant and is refused without it', () => {
    if (process.platform !== 'darwin') return
    const root = mkdtempSync(join(tmpdir(), 'nessy-r85-writable-'))
    const workspaceRoot = join(root, 'workspace')
    const scratchRoot = join(root, 'scratch')
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(scratchRoot, { recursive: true })
    try {
      expect(ensureHookEnvFile(WORKSPACE_ID, SESSION_ID)).toBe(hookEnvFilePath(WORKSPACE_ID, SESSION_ID))
      const envFile = hookEnvFilePath(WORKSPACE_ID, SESSION_ID)

      expect(appendUnderWorkspaceProfile({
        workspaceRoot,
        scratchRoot,
        envFile,
        // Exactly what `pluginCommandHookRunner` now passes: the `hook-env/`
        // subdirectory, never the session directory itself.
        additionalWritableRoots: [hookEnvFileDirPath(WORKSPACE_ID, SESSION_ID)],
      })).toBe(0)
      expect(readFileSync(envFile, 'utf8')).toBe('export FOO=bar\n')

      // The control: the same command, the same sandbox, the grant removed.
      expect(appendUnderWorkspaceProfile({ workspaceRoot, scratchRoot, envFile })).not.toBe(0)
      expect(readFileSync(envFile, 'utf8')).toBe('export FOO=bar\n')
    } finally {
      rmSync(getSessionStoragePath(WORKSPACE_ID, SESSION_ID), { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not make the rest of the session directory writable', () => {
    if (process.platform !== 'darwin') return
    const root = mkdtempSync(join(tmpdir(), 'nessy-r85-writable-sibling-'))
    const workspaceRoot = join(root, 'workspace')
    const scratchRoot = join(root, 'scratch')
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(scratchRoot, { recursive: true })
    try {
      ensureHookEnvFile(WORKSPACE_ID, SESSION_ID)
      // `session.jsonl` is the transcript. A hook granted the env file must not
      // reach it, which is why the grant is the subdirectory and not the parent.
      const sibling = join(getSessionStoragePath(WORKSPACE_ID, SESSION_ID), 'session.jsonl')

      expect(appendUnderWorkspaceProfile({
        workspaceRoot,
        scratchRoot,
        envFile: sibling,
        additionalWritableRoots: [hookEnvFileDirPath(WORKSPACE_ID, SESSION_ID)],
      })).not.toBe(0)
    } finally {
      rmSync(getSessionStoragePath(WORKSPACE_ID, SESSION_ID), { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
