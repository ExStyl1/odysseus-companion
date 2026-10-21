/**
 * F1.141 (origin SIT-10 P-SIT10-4) — D1.438's "the user can still do it" half,
 * driven end to end through the product's own writer, in the SAME workspace
 * where the model's write is refused.
 *
 * ## What SIT-10 could not drive, and why
 *
 * D1.438 blocks a MODEL write into `<workspaceRoot>/permissions.json` in every
 * mode. Its other half — the USER's own writer still lands there — had one
 * product route, codex's Always-Allow (`CodexAgent.persistExecpolicyGrant` →
 * `saveWorkspacePermissions`), and the sitting could not reach it: codex raised
 * no card for `echo` or `curl` (`attempted: true`, `asked: false`), the preload
 * exposes no `saveWorkspacePermissions`, and Settings › Permissions is the
 * Explore-rules page. Read from the source (2026-09-23, WJ-w), the reason is
 * structural, not flaky:
 *
 *  - every mode but `dontAsk` runs codex with `approval_policy = "on-request"`
 *    (`CODEX_PERMISSION_MODE_TABLE`, `codex-responses-adapter/src/config-writer.ts`),
 *    and with the sandbox master switch off the degradation lands on
 *    `on-request` too since upstream retired `untrusted`
 *    (`UNBOUNDED_ON_REQUEST_DEGRADES_TO`, P7.2). The measured table in that
 *    file reads 0 approvals for `echo` AND for `touch ~/…` under `on-request`:
 *    codex asks only for a MODEL-requested escalation and for what it classes
 *    dangerous itself;
 *  - in `bypassPermissions` the host answers any codex request itself, with no
 *    card ("codex approval auto-allowed by the bypassPermissions mode",
 *    `CodexAgent`), and the sitting drove its arms in bypass (D1.385);
 *  - the Always-Allow persists only a COMMAND approval that carries a prefix —
 *    `execpolicyAmendmentForApproval` answers `null` for a file change and for a
 *    v2 command without `proposedExecpolicyAmendment` — and a request refused by
 *    a non-negotiable floor (an explicit ask rule among them) drops the
 *    Always-Allow before it gets there.
 *
 * So the only card that reaches the writer is a model-requested escalation, and
 * a live case has to ask for one (the recipe is handed back with the row). This
 * suite drives the same request shape codex sends for it, through the REAL
 * agent's approval path, and reads the file.
 *
 * ## The pair
 *
 * In ONE workspace root (an overridden config dir, so the protected-path floor
 * cannot answer for the directory's name): the model's `Write` of the record is
 * BLOCKED by the gate, and the user's Always-Allow on a command card lands a
 * structural allow rule IN THAT FILE, which the codex projection then reads
 * back. CONTROL: a plain accept of the identical card writes nothing, so the
 * arm can tell "the user's writer ran" from "a file happened to exist".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BackendConfig, PermissionCallback } from '../backend/types.ts'
import { CodexAgent } from '../codex-agent.ts'
import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import {
  collectExecpolicyAllowPrefixes,
  getWorkspacePermissionsPath,
  loadRawWorkspacePermissions,
  permissionsConfigCache,
} from '../permissions-config.ts'

const EXEC_METHOD = 'item/commandExecution/requestApproval'
const KEY = { workspaceId: 'ws-f1141', sessionId: 'session-f1141' }

let sandbox: string
let workspaceRoot: string

const gatePermissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1141-')))
  workspaceRoot = join(sandbox, 'nessy-config', 'workspaces', KEY.workspaceId)
  mkdirSync(workspaceRoot, { recursive: true })
})

beforeEach(() => {
  permissionsConfigCache.clear()
  rmSync(getWorkspacePermissionsPath(workspaceRoot), { force: true })
})

afterAll(() => {
  cleanupModeState(KEY)
  permissionsConfigCache.clear()
  rmSync(sandbox, { recursive: true, force: true })
})

/** The model's write, through the gate every runtime calls. */
function modelWriteVerdict(): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, 'acceptEdits')
  const result = runPreToolUseChecks({
    toolName: 'Write',
    input: { file_path: getWorkspacePermissionsPath(workspaceRoot), content: '{"allowedBashPatterns":[".*"]}' },
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: 'acceptEdits',
    workspaceRootPath: workspaceRoot,
    workspaceId: KEY.workspaceId,
    workingDirectory: workspaceRoot,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager: gatePermissionManager,
  })
  return result.type === 'block' && /permissions\.json are blocked/.test(result.reason) ? 'blocked' : result.type
}

/** The real codex agent, with the card surfaced to a recorder the way the host surfaces it. */
function codexAgent() {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: KEY.workspaceId, name: 'WS', rootPath: workspaceRoot, workspaceRootPath: workspaceRoot,
      sessionRootPath: join(workspaceRoot, 'sessions'),
    } as never,
    session: {
      id: KEY.sessionId, workspaceRootPath: workspaceRoot, createdAt: Date.now(), lastUsedAt: Date.now(),
      workingDirectory: workspaceRoot,
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  }
  const agent = new CodexAgent(config)
  const surfaced: Array<Parameters<PermissionCallback>[0]> = []
  agent.onPermissionRequest = request => { surfaced.push(request) }
  // No capability rule pre-approves anything, so the card surfaces — the same
  // posture `codex-execpolicy-persistence.test.ts` drives.
  agent.getPermissionManager().setCapabilityPermissionLayers([], 'gen-f1141', true)
  // F1.780 — while a deny entry reaches codex, its Always Allow writes NO durable
  // rule (`codex-sandbox-retained-approval.test.ts`). Since F1.1057 a default
  // session denies nothing, so this route reaches the file in production again;
  // the stub only undoes this suite's `$TMPDIR` config dir, which F1.664 denies.
  ;(agent as never as { codexDeniedReadPaths: () => string[] }).codexDeniedReadPaths = () => []
  return { agent, surfaced }
}

/** The request codex sends when the model asks to run a command outside its sandbox. */
function escalationCard(agent: CodexAgent): void {
  void (agent as never as { handleServerRequest(method: string, params: unknown): unknown })
    .handleServerRequest(EXEC_METHOD, { command: 'make deploy', proposedExecpolicyAmendment: ['make', 'deploy'] })
}

describe('F1.141 · the user writes the permission record the model may not', () => {
  it('in one workspace: the model\'s Write is blocked, the user\'s Always-Allow lands a rule the codex projection reads', () => {
    expect(modelWriteVerdict()).toBe('blocked')

    const { agent, surfaced } = codexAgent()
    escalationCard(agent)
    expect(surfaced).toHaveLength(1)
    agent.respondToPermission(surfaced[0]!.requestId, true, true)

    const saved = loadRawWorkspacePermissions(workspaceRoot)
    expect({
      fileExists: existsSync(getWorkspacePermissionsPath(workspaceRoot)),
      projected: collectExecpolicyAllowPrefixes(saved),
    }).toEqual({ fileExists: true, projected: [['make', 'deploy']] })
    // And the model's door is still shut on the file the user just wrote.
    expect(modelWriteVerdict()).toBe('blocked')
  })

  it('CONTROL: a plain accept of the identical card writes nothing', () => {
    const { agent, surfaced } = codexAgent()
    escalationCard(agent)
    expect(surfaced).toHaveLength(1)
    agent.respondToPermission(surfaced[0]!.requestId, true, false)
    expect(existsSync(getWorkspacePermissionsPath(workspaceRoot))).toBe(false)
  })
})
