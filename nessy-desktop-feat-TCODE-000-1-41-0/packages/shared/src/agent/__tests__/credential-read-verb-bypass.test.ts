/**
 * F1.292 (origin WJ-dd's F1.258 verifier, F1.258-cred) — the path-based
 * credential floor was bypassed through allow-listed READ verbs that print a
 * denied file's secrets without naming the file.
 *
 * ## The defect, measured 2026-09-23 on a migrated install through `runPreToolUseChecks`
 *
 * `cat ~/.kube/config` and `cat ~/.npmrc` block in Explore, `default` and
 * `dontAsk` (`~/.kube/**` and every `.npmrc` are shipped `deniedPaths`), while
 * `kubectl config view --raw` and `npm config get //registry.npmjs.org/:_authToken`
 * answered allow / allow / allow: the bash allow-list admitted them as reads, and
 * the floor, which reads PATHS named in a command, has no path to see.
 *
 * ## The fix
 *
 * The shipped allow strings refuse the credential-printing forms, and the old
 * strings are retired from installed copies (`RETIRED_SHIPPED_PATTERNS`, keyed to
 * the bundle that tightened them), or the append-only merge would keep them:
 *
 * - `kubectl config view` with `--raw` or `--flatten` — without them kubectl
 *   prints `REDACTED` / `DATA+OMITTED` for every secret, so the bare form stays.
 * - `npm config get` of a key carrying `_auth` or `_password` (`_auth`,
 *   `_authToken`, `_password` and their `//<registry>/:` scoped forms).
 * - Siblings of the same class, found while reading the row's list: `gh auth
 *   status` with `-t`/`--show-token` (prints the token `~/.config/gh/**` holds)
 *   and `gh config get` of a key naming a token.
 *
 * Read and pinned as they are, not changed: `yarn config get` and `pnpm config
 * get` were never allow-listed (they card); `git config` reads files no floor
 * denies, and its `--file <path>` form names the path, which the floor sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { getAppPermissionsDir, permissionsConfigCache } from '../permissions-config.ts'

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)

const KEY = { workspaceId: 'ws-f1292', sessionId: 'session-f1292' }

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

/** F1.258's measured floor for gate arms, same budget. */
const GATE_BUDGET_MS = 120_000

let workspace: string
let appDefaultPath: string
let priorAppDefault: string | null = null

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1292-')))
  const dir = getAppPermissionsDir()
  mkdirSync(dir, { recursive: true })
  appDefaultPath = join(dir, 'default.json')
  priorAppDefault = existsSync(appDefaultPath) ? readFileSync(appDefaultPath, 'utf-8') : null
  writeFileSync(appDefaultPath, SHIPPED_TEXT, 'utf-8')
  permissionsConfigCache.clear()
})

afterAll(() => {
  cleanupModeState(KEY)
  if (priorAppDefault === null) rmSync(appDefaultPath, { force: true })
  else writeFileSync(appDefaultPath, priorAppDefault, 'utf-8')
  permissionsConfigCache.clear()
  rmSync(workspace, { recursive: true, force: true })
})

function verdict(command: string, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName: 'Bash',
    input: { command },
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: workspace,
    workspaceId: KEY.workspaceId,
    workingDirectory: workspace,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const threeModes = (command: string) => ({
  plan: verdict(command, 'plan'),
  default: verdict(command, 'default'),
  dontAsk: verdict(command, 'dontAsk'),
})
type Verdicts = ReturnType<typeof threeModes>
const table = (commands: string[]): Record<string, Verdicts> => Object.fromEntries(commands.map(command => [command, threeModes(command)]))
const ALLOWED: Verdicts = { plan: 'allow', default: 'allow', dontAsk: 'allow' }
/**
 * Not on the allow-list: dontAsk refuses, `default` asks, and `plan` hands it to its shell band (the classifier or a
 * card — `permission-modes.md`'s plan-mode shell sentence). F1.1050 moved this column from the retired explore,
 * which refused outright; neither arm lets the command run unasked.
 */
const NOT_LISTED: Verdicts = { plan: 'prompt:bash', default: 'prompt:bash', dontAsk: 'block' }
const all = (commands: string[], value: Verdicts): Record<string, Verdicts> => Object.fromEntries(commands.map(command => [command, value]))

describe('F1.292 · a read verb that prints a denied file\'s secret is not a read', () => {
  it('kubectl --raw/--flatten, npm config get of an auth key, gh auth status -t and gh config get of a token leave the allow-list', () => {
    const commands = [
      'kubectl config view --raw',
      'kubectl config view --flatten',
      'kubectl config view --minify --raw -o yaml',
      'kubectl config view --raw=true',
      'npm config get //registry.npmjs.org/:_authToken',
      'npm config get _authToken',
      'npm config get _auth',
      'npm config get //registry.npmjs.org/:_password',
      'gh auth status --show-token',
      'gh auth status -t',
      'gh auth status -h github.com -t',
      'gh config get oauth_token -h github.com',
    ]
    expect(table(commands)).toEqual(all(commands, NOT_LISTED))
  }, GATE_BUDGET_MS)

  it('CONTROL: the redacted and non-credential forms stay allowed in all three modes', () => {
    const commands = [
      'kubectl config view',
      'kubectl config view --minify',
      'npm config get registry',
      'npm config list',
      'gh auth status',
      'gh auth status -h github.com',
      'gh config get git_protocol',
      'git config --get user.email',
    ]
    expect(table(commands)).toEqual(all(commands, ALLOWED))
  }, GATE_BUDGET_MS)

  it('the siblings read and pinned as they are: yarn/pnpm config get card, a git --file read of a denied file blocks', () => {
    expect(table([
      'yarn config get npmAuthToken',
      'pnpm config get //registry.npmjs.org/:_authToken',
    ])).toEqual(all(['yarn config get npmAuthToken', 'pnpm config get //registry.npmjs.org/:_authToken'], NOT_LISTED))
    const viaFile = threeModes('git config --list --file ~/.pypirc')
    expect(viaFile.plan).toBe('block')
    expect(viaFile.dontAsk).toBe('block')
    expect(viaFile.default).not.toBe('allow')
  }, GATE_BUDGET_MS)
})
