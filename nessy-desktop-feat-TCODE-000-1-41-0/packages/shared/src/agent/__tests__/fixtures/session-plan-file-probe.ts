/**
 * F1.725 (WJ-crit-u, 2026-09-25) — the child probe behind `session-plan-file-write.test.ts`.
 *
 * It runs in a CHILD so each config-dir layout gets its own `CONFIG_DIR`, which is
 * frozen at import: the parent exports `NESSY_CONFIG_DIR` (and a scratch `HOME`)
 * BEFORE bun starts, the one form AGENTS.md measures as isolating on every
 * invocation. It never touches the real data folder; `configDir` is printed so the
 * parent can assert the provenance before reading any verdict.
 *
 * What it drives, per layout, with a project folder OUTSIDE the data folder (the
 * sitting's shape — a sibling repo):
 *
 *  1. the one gate claude's PreToolUse hook and Pi's `pre_tool_use` bridge both
 *     call (`runPreToolUseChecks`) — a Write / Edit of the session's own plan file,
 *     and the controls;
 *  2. Pi's file tool itself (`LocalToolRuntime` over the scope the host builds,
 *     `buildSessionFilesystemScope`) — the write the gate admitted, plus a Read of
 *     the session's own attachment (SIT-d's sibling finding);
 *  3. `SubmitPlan`'s own handler (`handleSubmitPlan`) on the file the runtime
 *     wrote, with a plan-mode port — the step that opens the plan card.
 *
 * F1.762 (DN-245, 2026-09-28) adds explore's OTHER exception, the session's own
 * `data/` folder, through the same layers 1 and 2: the four write tools at the
 * gate, then Pi's Write and Read of the file, plus the session's records and
 * another session's data folder as controls.
 *
 * Every side effect is behind `import.meta.main` (AGENTS.md: a fixture whose body
 * exits kills the runner at import time).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { handleSubmitPlan } from '@nessy-agent/session-tools-core'
import { CONFIG_DIR } from '../../../config/paths.ts'
import { ensureConfigDir } from '../../../config/storage.ts'
import { getSessionAttachmentsPath, getSessionDataPath, getSessionPlansDir } from '../../../sessions/storage.ts'
import { runPreToolUseChecks, type PermissionManagerLike } from '../../core/pre-tool-use.ts'
import { LocalToolRuntime } from '../../local-tools/runtime.ts'
import { cleanupModeState, initializeModeState } from '../../mode-manager.ts'
import type { PermissionMode } from '../../mode-types.ts'
import { buildSessionFilesystemScope } from '../../session-filesystem-scope.ts'

const KEY = { workspaceId: 'ws-f1725', sessionId: 'session-f1725' }
const OTHER_SESSION = 'session-f1725-other'

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

function gate(toolName: string, input: Record<string, unknown>, mode: PermissionMode, ctx: { workspaceRoot: string; project: string; plans: string; data: string }): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const r = runPreToolUseChecks({
    toolName, input, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: ctx.workspaceRoot, workspaceId: KEY.workspaceId, workingDirectory: ctx.project,
    plansFolderPath: ctx.plans, dataFolderPath: ctx.data,
    activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
  })
  cleanupModeState(KEY)
  if (r.type === 'prompt') return r.nonNegotiable === 'protectedPath' ? 'floor' : `card(${r.promptType})`
  if (r.type === 'block') return /protected path/.test(r.reason) ? 'floor-deny' : `block:${r.reason.split('\n')[0]}`
  return r.type
}

async function main(): Promise<void> {
  // The scratch data folder's bundled defaults, as the app's startup and the test preload seed them.
  ensureConfigDir()
  const workspaceRoot = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
  const plans = getSessionPlansDir(KEY.workspaceId, KEY.sessionId)
  const data = getSessionDataPath(KEY.workspaceId, KEY.sessionId)
  const attachments = getSessionAttachmentsPath(KEY.workspaceId, KEY.sessionId)
  const otherPlans = getSessionPlansDir(KEY.workspaceId, OTHER_SESSION)
  const otherAttachments = getSessionAttachmentsPath(KEY.workspaceId, OTHER_SESSION)
  const otherData = getSessionDataPath(KEY.workspaceId, OTHER_SESSION)
  for (const dir of [workspaceRoot, plans, data, attachments, otherPlans, otherAttachments, otherData, join(CONFIG_DIR, 'skills')]) mkdirSync(dir, { recursive: true })
  const attachment = join(attachments, 'a1_notes.txt')
  writeFileSync(attachment, 'attached text')
  writeFileSync(join(otherAttachments, 'a2_secret.txt'), 'another session')
  const project = mkdtempSync(join(tmpdir(), 'f1725-project-'))
  writeFileSync(join(project, 'math.ts'), 'export const add = (a: number, b: number) => a + b\n')
  const ctx = { workspaceRoot, project, plans, data }

  const planFile = join(plans, 'add-subtract.md')
  const out: Record<string, unknown> = { configDir: CONFIG_DIR, plans }

  // 1. The gate — claude's PreToolUse and Pi's pre_tool_use bridge both call it.
  const verdicts: Record<string, string> = {}
  for (const mode of ['plan'] as const) { // F1.1050: the retired explore's arms left with the mode
    verdicts[`${mode} Write own plan .md`] = gate('Write', { file_path: planFile, content: '# Plan' }, mode, ctx)
    verdicts[`${mode} Edit own plan .md`] = gate('Edit', { file_path: planFile, old_string: 'a', new_string: 'b' }, mode, ctx)
    verdicts[`${mode} Write another session's plan`] = gate('Write', { file_path: join(otherPlans, 'x.md'), content: 'x' }, mode, ctx)
    verdicts[`${mode} Write data-folder skill`] = gate('Write', { file_path: join(CONFIG_DIR, 'skills', 'evil', 'SKILL.md'), content: 'x' }, mode, ctx)
    verdicts[`${mode} Write project source`] = gate('Write', { file_path: join(project, 'math.ts'), content: 'x' }, mode, ctx)
  }
  verdicts['plan Write own plans folder non-md'] = gate('Write', { file_path: join(plans, 'run.sh'), content: 'x' }, 'plan', ctx)
  verdicts['plan Write own plan via ..'] = gate('Write', { file_path: join(plans, '..', 'plans', 'add-subtract.md'), content: 'x' }, 'plan', ctx)
  verdicts['plan Write escape via ..'] = gate('Write', { file_path: join(plans, '..', 'x.md'), content: 'x' }, 'plan', ctx)
  verdicts['acceptEdits Write own plan .md'] = gate('Write', { file_path: planFile, content: '# Plan' }, 'acceptEdits', ctx)
  verdicts['dontAsk Write own plan .md'] = gate('Write', { file_path: planFile, content: '# Plan' }, 'dontAsk', ctx)
  // F1.762 — the session's data-folder exception, the four write tools, and its controls. F1.1050: explore held
  // it until it was retired; plan absorbed it, so the arms drive plan.
  const findings = join(data, 'findings.md')
  verdicts['plan Write own data'] = gate('Write', { file_path: findings, content: '# Findings' }, 'plan', ctx)
  verdicts['plan MultiEdit own data'] = gate('MultiEdit', { file_path: findings, edits: [{ old_string: 'a', new_string: 'b' }] }, 'plan', ctx)
  // F1.1050 — plan absorbs the retired explore's data-folder exception (the four file tools), and only that.
  verdicts['plan Edit own data'] = gate('Edit', { file_path: findings, old_string: 'a', new_string: 'b' }, 'plan', ctx)
  verdicts['plan NotebookEdit own data'] = gate('NotebookEdit', { notebook_path: join(data, 'n.ipynb'), new_source: 'x' }, 'plan', ctx)
  verdicts['plan Write own session.jsonl'] = gate('Write', { file_path: join(dirname(data), 'session.jsonl'), content: 'x' }, 'plan', ctx)
  verdicts["plan Write another session's data"] = gate('Write', { file_path: join(otherData, 'x.md'), content: 'x' }, 'plan', ctx)
  out.gate = verdicts

  // 2. Pi's file tool over the scope the host builds (SessionManager's arguments).
  const scope = buildSessionFilesystemScope({
    workspaceId: KEY.workspaceId, sessionId: KEY.sessionId, projectKey: 'p', projectCanonicalPath: project,
    workspaceRootPath: workspaceRoot, workingDirectory: project, managedConfigDir: CONFIG_DIR,
  })
  const runtime = new LocalToolRuntime({ filesystemScope: scope, permissionManager: { evaluateToolCall: () => ({ allowed: true }) } })
  const call = (id: string, operation: Record<string, unknown>) => runtime.executeAuthorized({
    id, displayName: id, operation, permission: { kind: 'tool', toolName: id },
  } as never)
  const tool: Record<string, { isError: boolean; content: string }> = {}
  const pick = (r: { isError: boolean; content: string }) => ({ isError: r.isError, content: r.content.slice(0, 160) })
  tool['write own plan'] = pick(await call('Write', { kind: 'write_file', path: planFile, content: '# Plan: add subtract\n\n1. Add it.\n' }))
  tool['write another session plan'] = pick(await call('Write', { kind: 'write_file', path: join(otherPlans, 'x.md'), content: 'x' }))
  tool['write data-folder hooks.json'] = pick(await call('Write', { kind: 'write_file', path: join(CONFIG_DIR, 'hooks.json'), content: '{}' }))
  tool['read own attachment'] = pick(await call('Read', { kind: 'read_file', path: attachment }))
  tool['write own attachment'] = pick(await call('Write', { kind: 'write_file', path: join(attachments, 'a3.txt'), content: 'x' }))
  tool['read another session attachment'] = pick(await call('Read', { kind: 'read_file', path: join(otherAttachments, 'a2_secret.txt') }))
  tool['write own data'] = pick(await call('Write', { kind: 'write_file', path: findings, content: '# Findings\n\n- subtract is missing.\n' }))
  tool['read own data'] = pick(await call('Read', { kind: 'read_file', path: findings }))
  tool['write another session data'] = pick(await call('Write', { kind: 'write_file', path: join(otherData, 'x.md'), content: 'x' }))
  tool['write own session.jsonl'] = pick(await call('Write', { kind: 'write_file', path: join(dirname(data), 'session.jsonl'), content: 'x' }))
  tool['write own long_responses'] = pick(await call('Write', { kind: 'write_file', path: join(dirname(data), 'long_responses', 'x.txt'), content: 'x' }))
  out.tool = tool
  out.dataFileWritten = existsSync(findings) ? readFileSync(findings, 'utf8') : null
  out.otherDataWritten = existsSync(join(otherData, 'x.md'))
  out.planFileWritten = existsSync(planFile) ? readFileSync(planFile, 'utf8') : null
  out.otherPlanWritten = existsSync(join(otherPlans, 'x.md'))

  // 3. SubmitPlan's own handler on that file, with a plan-mode port.
  const submitted: string[] = []
  const submitCtx = {
    fs: { exists: (p: string) => existsSync(p), readFile: (p: string) => readFileSync(p, 'utf8') },
    planModePort: { submit: async ({ planPath }: { planPath: string }) => { submitted.push(planPath) } },
    callbacks: { onPlanSubmitted: (p: string) => { submitted.push(`callback:${p}`) } },
  }
  const submit = await handleSubmitPlan(submitCtx as never, { planPath: planFile })
  out.submit = { isError: Boolean((submit as { isError?: boolean }).isError), text: JSON.stringify(submit).slice(0, 200), submitted }

  process.stdout.write(`${JSON.stringify(out)}\n`)
}

if (import.meta.main) {
  await main()
}
