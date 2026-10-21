/**
 * C3.362 — the `Write` card `acceptEdits` "should have auto-approved" on claude,
 * measured. **It should not have, and the page says so in the same breath it
 * grants the mode.**
 *
 * ## The reading that closes the row
 *
 * `permission-modes.md`, § "Auto-approve file edits with acceptEdits mode",
 * verbatim: *"Like file edits, auto-approval applies only to paths inside your
 * working directory or `additionalDirectories`. Paths outside that scope, writes
 * to protected paths, `rm` and `rmdir` removals targeting a critical path, and
 * all other Bash commands except the built-in read-only set still prompt."*
 * (fetched 2026-09-12). So `acceptEdits` was never a promise to stop asking
 * about every write — it is scoped, and a protected path is named as an
 * exception inside the grant itself.
 *
 * ## Why the write landed where it did, which is the part worth knowing
 *
 * A claude session's child is spawned in `resolveClaudeTranscriptCwd`'s answer,
 * and `createSession` seeds that from `options?.workingDirectory ?? the session's
 * own storage directory` (`packages/shared/src/sessions/storage.ts`). So a
 * session created with NO working directory runs its claude child inside its own
 * storage directory — and a prompt asking for a file "in the current working
 * directory" then means a file in the host's session store. On the default
 * install that path carries a `.nessy-agent` segment, which is a
 * `PROTECTED_DIRECTORIES` entry.
 *
 * That is claude-only for a reason no other runtime shares: only claude's spawn
 * cwd is the session storage directory, because the SDK derives its transcript's
 * project key from the cwd and the host pins it so a resume can find the file.
 *
 * ## Two mechanisms, and BOTH must be pinned or the refutation reads as luck
 *
 * The two arms below prompt for DIFFERENT reasons, and which one fires depends
 * on where `NESSY_CONFIG_DIR` points:
 *
 *  1. the default install — the target carries `.nessy-agent`, so the
 *     PROTECTED-PATH floor answers before the mode is consulted at all;
 *  2. an overridden config dir with no such segment — the floor does not fire
 *     and the ordinary `acceptEdits` root check answers, because the session
 *     storage directory is not one of the roots (`workingDirectory`,
 *     `workspaceRootPath`, the plans folder, the data folder,
 *     `additionalDirectories`).
 *
 * A test that pinned only the first would go green on a machine whose config dir
 * happens to be named `.nessy-agent` and prove nothing about the mechanism the
 * rig actually met.
 *
 * ## The posture, stated rather than decided quietly
 *
 * **Neither arm is widened.** Auto-approving writes into the session storage
 * directory would let a model rewrite the host's own session state with no card,
 * and it would be a widening of the page's rule rather than a reading of it. The
 * two roots inside that directory that ARE auto-approved (`plans/`, `data/`) are
 * there because they are the session's own scratch surfaces; the store around
 * them is not. What the rig actually met — a card replacing the composer with
 * nobody to answer it — is an operator-absence problem, and the rig's own case
 * note now says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'

const KEY = { workspaceId: 'ws-c3362', sessionId: 'session-c3362' }

let sandbox: string
let workspaceRoot: string
let project: string
/** A session store under a DEFAULT-shaped config dir: carries a `.nessy-agent` segment. */
let defaultInstallSessionDir: string
/** A session store under an OVERRIDDEN config dir: no protected segment anywhere. */
let overriddenConfigSessionDir: string

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-c3362-')))
  workspaceRoot = join(sandbox, 'workspace')
  project = join(sandbox, 'project')
  defaultInstallSessionDir = join(sandbox, '.nessy-agent', 'workspaces', 'ws-c3362', 'sessions', 'session-c3362')
  overriddenConfigSessionDir = join(sandbox, 'nessy-config', 'workspaces', 'ws-c3362', 'sessions', 'session-c3362')
  for (const dir of [workspaceRoot, project, defaultInstallSessionDir, overriddenConfigSessionDir]) {
    mkdirSync(dir, { recursive: true })
  }
  cleanupModeState(KEY)
  initializeModeState(KEY, 'acceptEdits')
})

afterAll(() => {
  cleanupModeState(KEY)
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * The gate as the claude path calls it. `workingDirectory` is optional exactly
 * as `ClaudeAgent` passes it — `this.config.session?.workingDirectory` — so the
 * session that has none is expressible here rather than only describable.
 */
function check(input: Record<string, unknown>, workingDirectory?: string) {
  const ctx: PreToolUseInput = {
    toolName: 'Write',
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: 'acceptEdits',
    workspaceRootPath: workspaceRoot,
    workspaceId: KEY.workspaceId,
    ...(workingDirectory ? { workingDirectory } : {}),
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  }
  return runPreToolUseChecks(ctx)
}

describe('C3.362 · acceptEdits and the claude child’s own cwd', () => {
  it('is the POSITIVE CONTROL first: acceptEdits really does auto-approve inside the working directory', () => {
    // Without this arm the two refusals below are indistinguishable from a gate
    // that refuses everything, and the row would close on a dead harness.
    const result = check({ file_path: join(project, 'notes.txt'), content: 'x' }, project)
    expect(result.type === 'allow' || result.type === 'modify').toBe(true)
  })

  it('prompts on the DEFAULT install because the session store is a protected path', () => {
    const result = check({ file_path: join(defaultInstallSessionDir, 'rs05-claude.txt'), content: 'x' })

    // Read the verdict into locals before asserting the shape — an asymmetric
    // matcher handed to `toMatchObject` overwrites the field it matched.
    const type = result.type
    const nonNegotiable = result.type === 'prompt' ? result.nonNegotiable : undefined
    expect({ type, nonNegotiable }).toEqual({ type: 'prompt', nonNegotiable: 'protectedPath' })
  })

  it('prompts with an OVERRIDDEN config dir too, by the root check rather than the floor', () => {
    const result = check({ file_path: join(overriddenConfigSessionDir, 'rs05-claude.txt'), content: 'x' })

    const type = result.type
    const promptType = result.type === 'prompt' ? result.promptType : undefined
    const nonNegotiable = result.type === 'prompt' ? result.nonNegotiable : undefined
    // An ordinary, remember-able file-write card — NOT the floor. That is the
    // whole point of this second arm: the refusal survives a config dir whose
    // name carries no protected segment, so it is the acceptEdits SCOPE and not
    // one machine's directory naming.
    expect({ type, promptType, nonNegotiable }).toEqual({
      type: 'prompt',
      promptType: 'file_write',
      nonNegotiable: undefined,
    })
  })

  it('still auto-approves the two session roots that ARE scratch surfaces', () => {
    // The boundary that keeps the posture honest in the other direction: the
    // refusal above is about the STORE, not about the session directory being
    // untouchable. `plans/` and `data/` are auto-approve roots and stay so.
    const plans = join(overriddenConfigSessionDir, 'plans')
    const data = join(overriddenConfigSessionDir, 'data')
    mkdirSync(plans, { recursive: true })
    mkdirSync(data, { recursive: true })

    const ctx = (filePath: string): PreToolUseInput => ({
      toolName: 'Write',
      input: { file_path: filePath, content: 'x' },
      sessionId: KEY.sessionId,
      sessionKey: KEY,
      permissionMode: 'acceptEdits',
      workspaceRootPath: workspaceRoot,
      workspaceId: KEY.workspaceId,
      plansFolderPath: plans,
      dataFolderPath: data,
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager,
    })

    for (const target of [join(plans, 'a.md'), join(data, 'b.json')]) {
      const result = runPreToolUseChecks(ctx(target))
      expect(result.type === 'allow' || result.type === 'modify', target).toBe(true)
    }
  })
})
