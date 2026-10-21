/**
 * F1.288 (origin WJ-dd's F1.258 verifier, F1.258-b + P-WJ-dd-2) — the builtin dp
 * servers' READ tools are read-only again, by exact name.
 *
 * ## The defect, measured 2026-09-23 on `runPreToolUseChecks`
 *
 * Every builtin dp MCP tool name leads with `dp_<service>_` (or with the service's
 * own prefix, `dp_code-search_`) and carries its verb LAST or in the middle, so
 * F1.258's leading-verb anchoring took read-only status from every one of them:
 * `mcp__dpJira__dp_jira_jql_search` and `dp_jira_version_list` went from allow to
 * block / card / block, unstated.
 *
 * ## The decision, and the part of it this row could not take
 *
 * The controller decided (2026-09-23) to read the tool's own MCP `readOnlyHint`
 * as a read-only signal at the gate, so the three runtimes would agree with
 * codex. That reading is REFUSED here, because the owner already ruled on it:
 * posture D1 of the parity-closure plan (§"Set 1 — the fifteen postures", option
 * A) — "a server's tool annotation is advisory and never an authorization signal,
 * and there is no gate-skip, not even behind an operator allowlist" — and the
 * pool pins the same invariant in its own docblock (`ProxyToolDef.annotations`,
 * `mcp/mcp-pool.ts`). The row's own fallback is taken instead: exact read-only
 * NAMES for the builtin dp servers, enumerated from their catalogue. The same
 * store shows why D1 holds: a third-party server there (xcodebuildmcp) marks
 * `tap`, `swipe` and `type_text` readOnlyHint:true, and dpJira's own earlier
 * catalogue (2026-07-30) marked `dp_jira_version_list` readOnlyHint:false.
 *
 * The catalogue is the servers' own `tools/list` as the pool's descriptor store
 * kept it on this machine (the latest descriptor per server, 2026-09-22), and the
 * enumeration is its `readOnlyHint: true` subset — dp is first-party, the hint
 * is used ONCE, by us, to author a host-owned list, and nothing at runtime reads
 * it. The snapshot below is that catalogue, so the derivation can be re-run and
 * the shipped entries checked against it. Stated residue: ten of the 28 builtin
 * servers (dpCmd, dpGit, dpKaas, dpNezabudka, dpQwarium, dpRepo, dpRtd, dpS3aas,
 * dpSkills, SpiritK8s) were never connected here, so their catalogue was not read
 * and their tools keep the card; a dp release that adds or renames a read tool
 * keeps the card for it until this list is refreshed (the safe direction).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { getAppPermissionsDir, permissionsConfigCache } from '../permissions-config.ts'
import { BUILTIN_DP_MCP_SERVERS } from '../../mcp/builtin-dp-servers.ts'

const AGENT_DIR = join(import.meta.dir, '..')
const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)
const shipped = JSON.parse(SHIPPED_TEXT) as { allowedMcpPatterns: Array<{ pattern: string; comment?: string }> }

/**
 * The builtin dp servers' catalogue, per tool: whether the server's own
 * `tools/list` marked it `readOnlyHint: true`. Read 2026-09-23 from
 * `~/.nessy-agent/mcp/tool-descriptors/*.json` (the pool's descriptor store), the
 * latest descriptor per server; servers never connected on that machine are absent.
 */
const DP_CATALOGUE: Record<string, { readOnly: readonly string[]; notReadOnly: readonly string[] }> = {
  codeSearch: {
    readOnly: [
      'dp_code-search_commits', 'dp_code-search_exact', 'dp_code-search_groups', 'dp_code-search_search',
    ],
    notReadOnly: [],
  },
  dpAllure: {
    readOnly: [
      'dp_allure_get_attachment', 'dp_allure_get_customfield', 'dp_allure_get_customfield-values',
      'dp_allure_get_integrations', 'dp_allure_get_issue-keys', 'dp_allure_get_launch',
      'dp_allure_get_launch-results', 'dp_allure_get_launch-statistic', 'dp_allure_get_launches',
      'dp_allure_get_projects', 'dp_allure_get_scenario', 'dp_allure_get_search-testcases',
      'dp_allure_get_tenant', 'dp_allure_get_testcase-overview', 'dp_allure_get_testlayer',
      'dp_allure_get_testresult', 'dp_allure_get_testresult-execution', 'dp_allure_get_workflow',
    ],
    notReadOnly: [
      'dp_allure_add_testcase-customfield', 'dp_allure_add_testcase-tag', 'dp_allure_create_testcase',
      'dp_allure_get_token', 'dp_allure_remove_testcase-customfield', 'dp_allure_remove_testcase-tag',
      'dp_allure_reserve_testcase', 'dp_allure_update_testcase-details', 'dp_allure_update_testcase-issue',
      'dp_allure_update_testcase-parameters', 'dp_allure_update_testcase-scenario',
    ],
  },
  dpArtifacts: {
    readOnly: [],
    notReadOnly: [
      'dp_artifacts_auth_get-token', 'dp_artifacts_brew_configure', 'dp_artifacts_composer_configure',
      'dp_artifacts_conan_configure', 'dp_artifacts_docker_archive', 'dp_artifacts_docker_configure',
      'dp_artifacts_docker_search', 'dp_artifacts_docker_tag', 'dp_artifacts_docker_unarchive',
      'dp_artifacts_gradle_configure', 'dp_artifacts_kaniko_configure',
      'dp_artifacts_maven_configure_add-release-repository', 'dp_artifacts_npm_configure',
      'dp_artifacts_nuget_configure', 'dp_artifacts_poetry_configure_add-source',
      'dp_artifacts_sbt_configure',
    ],
  },
  dpCdn: {
    readOnly: [],
    notReadOnly: [
      'dp_cdn_certificate_get', 'dp_cdn_certificate_list', 'dp_cdn_certificate_list-eligible',
      'dp_cdn_location_copy', 'dp_cdn_location_create', 'dp_cdn_location_delete', 'dp_cdn_location_get',
      'dp_cdn_location_list', 'dp_cdn_location_update', 'dp_cdn_operation_get', 'dp_cdn_operation_list',
      'dp_cdn_operation_list-location', 'dp_cdn_operation_list-resource', 'dp_cdn_resource_copy',
      'dp_cdn_resource_create', 'dp_cdn_resource_delete', 'dp_cdn_resource_get', 'dp_cdn_resource_list',
      'dp_cdn_resource_purge', 'dp_cdn_resource_update', 'dp_cdn_s3aas-bucket_list',
    ],
  },
  dpCodeInterpreter: {
    readOnly: [],
    notReadOnly: [
      'dp_code-interpreter_execute-code',
    ],
  },
  dpDbAuth: {
    readOnly: [],
    notReadOnly: [
      'dp_dbauth_configure-dbeaver', 'dp_dbauth_cross-shards', 'dp_dbauth_delete-accounts',
      'dp_dbauth_jdbc-url', 'dp_dbauth_psql',
    ],
  },
  dpDeploy: {
    readOnly: [],
    notReadOnly: [
      'dp_deploy_bootstrap', 'dp_deploy_status',
    ],
  },
  dpFinedog: {
    readOnly: [
      'dp_finedog_get_group-incident', 'dp_finedog_get_incident', 'dp_finedog_get_incident-summary',
      'dp_finedog_get_post-analysis', 'dp_finedog_get_suspicion', 'dp_finedog_get_team',
      'dp_finedog_get_team-members', 'dp_finedog_get_unit', 'dp_finedog_get_units-state',
      'dp_finedog_list_incidents', 'dp_finedog_list_schedules', 'dp_finedog_list_suspicions',
      'dp_finedog_list_teams', 'dp_finedog_list_units', 'dp_finedog_search_freezes',
      'dp_finedog_search_pages', 'dp_finedog_search_post-analyses', 'dp_finedog_search_releases',
    ],
    notReadOnly: [
      'dp_finedog_create_incident', 'dp_finedog_edit_incident',
    ],
  },
  dpFs: {
    readOnly: [],
    notReadOnly: [
      'copy_file', 'create_directory', 'delete_file', 'get_file_info', 'list_allowed_directories',
      'list_directory', 'modify_file', 'move_file', 'read_file', 'read_multiple_files', 'search_files',
      'search_within_files', 'tree', 'write_file',
    ],
  },
  dpGitlab: {
    readOnly: [
      'dp_gitlab_whoami',
    ],
    notReadOnly: [
      'dp_gitlab_create-merge-request', 'dp_gitlab_create-merge-request-note', 'dp_gitlab_fork',
      'dp_gitlab_job', 'dp_gitlab_merge-request', 'dp_gitlab_merge-requests', 'dp_gitlab_pipeline',
      'dp_gitlab_pipelines', 'dp_gitlab_repos', 'dp_gitlab_update-merge-request',
    ],
  },
  dpJira: {
    readOnly: [
      'dp_jira_editmeta', 'dp_jira_field', 'dp_jira_issue', 'dp_jira_jql_search', 'dp_jira_link-types',
      'dp_jira_links', 'dp_jira_sprint_current', 'dp_jira_transitions', 'dp_jira_version_list',
      'dp_jira_workflow_available', 'dp_jira_workflow_history',
    ],
    notReadOnly: [
      'dp_jira_comment', 'dp_jira_create', 'dp_jira_sprint_add-issue', 'dp_jira_sprint_remove-issue',
      'dp_jira_unlink', 'dp_jira_update', 'dp_jira_workflow_move',
    ],
  },
  dpMR: {
    readOnly: [],
    notReadOnly: [
      'create_merge_request',
    ],
  },
  dpMail: {
    readOnly: [
      'dp_mail_get-attachment-content', 'dp_mail_get-message-details', 'dp_mail_list-attachments',
      'dp_mail_list-messages', 'dp_mail_search-messages',
    ],
    notReadOnly: [],
  },
  dpSage: {
    readOnly: [
      'dp_sage_completion', 'dp_sage_groups', 'dp_sage_logs', 'dp_sage_systems',
    ],
    notReadOnly: [
      'dp_sage_query',
    ],
  },
  dpTihon: {
    readOnly: [],
    notReadOnly: [
      'dp_tihon_chat',
    ],
  },
  dpWiki: {
    readOnly: [],
    notReadOnly: [
      'dp_wixie_comments', 'dp_wixie_create', 'dp_wixie_edit', 'dp_wixie_get', 'dp_wixie_search',
    ],
  },
  't-tracker': {
    readOnly: [],
    notReadOnly: [
      'dp_tracker_api_delete', 'dp_tracker_api_get', 'dp_tracker_api_patch', 'dp_tracker_api_post',
      'dp_tracker_api_put', 'dp_tracker_board_get', 'dp_tracker_field_categories',
      'dp_tracker_field_category-create', 'dp_tracker_field_category-delete',
      'dp_tracker_field_category-update', 'dp_tracker_field_list', 'dp_tracker_field_multicategories',
      'dp_tracker_jira_field_list', 'dp_tracker_jira_issue-link_create', 'dp_tracker_jira_issue-link_delete',
      'dp_tracker_jira_issue-link_get', 'dp_tracker_jira_issue_create', 'dp_tracker_jira_issue_get',
      'dp_tracker_jira_issue_update', 'dp_tracker_jira_issuetype_list', 'dp_tracker_jira_priority_list',
      'dp_tracker_jira_project_get', 'dp_tracker_jira_remote-link_delete',
      'dp_tracker_jira_remote-link_list', 'dp_tracker_jira_remote-link_upsert', 'dp_tracker_jira_search',
      'dp_tracker_jira_sprint_add-tasks', 'dp_tracker_jira_sprint_create', 'dp_tracker_jira_sprint_delete',
      'dp_tracker_jira_sprint_get', 'dp_tracker_jira_sprint_tasks', 'dp_tracker_jira_sprint_update',
      'dp_tracker_jira_status_list', 'dp_tracker_link_create', 'dp_tracker_link_delete',
      'dp_tracker_link_get', 'dp_tracker_link_remote-delete', 'dp_tracker_link_remote-list',
      'dp_tracker_link_remote-upsert', 'dp_tracker_release_add-task', 'dp_tracker_release_create',
      'dp_tracker_release_delete', 'dp_tracker_release_get', 'dp_tracker_release_list',
      'dp_tracker_release_remove-task', 'dp_tracker_release_tasks', 'dp_tracker_release_update',
      'dp_tracker_space-group_get', 'dp_tracker_space-group_list', 'dp_tracker_space-group_spaces',
      'dp_tracker_space_get', 'dp_tracker_sprint_add-tasks', 'dp_tracker_sprint_create',
      'dp_tracker_sprint_delete', 'dp_tracker_sprint_get', 'dp_tracker_sprint_list',
      'dp_tracker_sprint_remove-tasks', 'dp_tracker_sprint_tasks', 'dp_tracker_sprint_update',
      'dp_tracker_task_create', 'dp_tracker_task_get', 'dp_tracker_task_search', 'dp_tracker_task_update',
      'dp_tracker_tql_docs',
    ],
  },
  time: {
    readOnly: [],
    notReadOnly: [
      'dp_time_call-tool', 'dp_time_list-tools',
    ],
  },
}

const KEY = { workspaceId: 'ws-f1288', sessionId: 'session-f1288' }
const SERVERS = Object.keys(DP_CATALOGUE)

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
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1288-')))
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

function verdict(toolName: string, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input: {},
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: workspace,
    workspaceId: KEY.workspaceId,
    workingDirectory: workspace,
    activeSourceSlugs: [...SERVERS, 'acme'],
    allSourceSlugs: [...SERVERS, 'acme'],
    hasSourceActivation: false,
    permissionManager,
  })
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const threeModes = (toolName: string) => ({
  plan: verdict(toolName, 'plan'),
  default: verdict(toolName, 'default'),
  dontAsk: verdict(toolName, 'dontAsk'),
})

type Verdicts = ReturnType<typeof threeModes>
const REFUSED: Verdicts = { plan: 'block', default: 'prompt:mcp_mutation', dontAsk: 'block' }
const ALLOWED: Verdicts = { plan: 'allow', default: 'allow', dontAsk: 'allow' }

const shippedRegexes = () => shipped.allowedMcpPatterns.map(entry => new RegExp(entry.pattern))
const shippedAdmits = (name: string) => shippedRegexes().some(regex => regex.test(name))
/** F1.258's verb rules carry the generic server segment; F1.288's entries name one dp server each. */
const VERB_RULE_PREFIX = '^mcp__[^_]+(?:_[^_]+)*__'
const exactNameRegexes = () => shipped.allowedMcpPatterns
  .filter(entry => !entry.pattern.startsWith(VERB_RULE_PREFIX))
  .map(entry => new RegExp(entry.pattern))
const exactNamesAdmit = (name: string) => exactNameRegexes().some(regex => regex.test(name))

describe('F1.288 · the builtin dp servers\' read tools are read-only by exact name', () => {
  it('the snapshot names only builtin dp servers', () => {
    const builtin = new Set(BUILTIN_DP_MCP_SERVERS.map(server => server.name))
    expect(SERVERS.filter(server => !builtin.has(server))).toEqual([])
  })

  it('the exact-name entries admit EXACTLY each server\'s readOnlyHint:true tools — none of the others', () => {
    const wronglyRefused: string[] = []
    const wronglyAdmitted: string[] = []
    for (const [server, tools] of Object.entries(DP_CATALOGUE)) {
      for (const tool of tools.readOnly) if (!shippedAdmits(`mcp__${server}__${tool}`)) wronglyRefused.push(`${server}/${tool}`)
      for (const tool of tools.notReadOnly) if (exactNamesAdmit(`mcp__${server}__${tool}`)) wronglyAdmitted.push(`${server}/${tool}`)
    }
    expect({ wronglyRefused, wronglyAdmitted }).toEqual({ wronglyRefused: [], wronglyAdmitted: [] })
    expect(exactNameRegexes()).toHaveLength(7)
  })

  it('the whole file admits no other catalogued dp tool than F1.258\'s verb rules already did: dpFs\'s seven verb-led reads', () => {
    // dpFs marks EVERY tool readOnlyHint:false AND destructiveHint:true, `read_file` and
    // `write_file` alike — a blanket value, not a per-tool statement. Its names carry no
    // `dp_` prefix, so the verb rules judge them exactly as they judge any server's, before
    // this row and after it; the stated residue, pinned by name so a change is visible.
    const admittedDespiteTheCatalogue = Object.entries(DP_CATALOGUE).flatMap(([server, tools]) =>
      tools.notReadOnly.filter(tool => shippedAdmits(`mcp__${server}__${tool}`)).map(tool => `${server}/${tool}`))
    expect(admittedDespiteTheCatalogue).toEqual([
      'dpFs/get_file_info', 'dpFs/list_allowed_directories', 'dpFs/list_directory', 'dpFs/read_file',
      'dpFs/read_multiple_files', 'dpFs/search_files', 'dpFs/search_within_files',
    ])
  })

  it('the verifier\'s dp reads are allowed in all three modes again', () => {
    const names = ['mcp__dpJira__dp_jira_jql_search', 'mcp__dpJira__dp_jira_version_list', 'mcp__dpMail__dp_mail_search-messages']
    expect(Object.fromEntries(names.map(name => [name, threeModes(name)])))
      .toEqual(Object.fromEntries(names.map(name => [name, ALLOWED])))
  }, GATE_BUDGET_MS)

  it('CONTROL: a dp write, a tool the server marks readOnlyHint:false, and a dp name on another server keep the write path', () => {
    const names = [
      'mcp__dpJira__dp_jira_update',
      'mcp__dpAllure__dp_allure_get_token',
      'mcp__dpGitlab__dp_gitlab_merge-requests',
      'mcp__acme__dp_jira_jql_search',
    ]
    expect(Object.fromEntries(names.map(name => [name, threeModes(name)])))
      .toEqual(Object.fromEntries(names.map(name => [name, REFUSED])))
  }, GATE_BUDGET_MS)

  it('CONTROL: F1.258\'s leading-verb read (`search_issues`) is unaffected', () => {
    expect(threeModes('mcp__acme__search_issues')).toEqual(ALLOWED)
  }, GATE_BUDGET_MS)

  it('owner D1 stands: no gate module\'s CODE names a tool annotation', () => {
    // The host gate decides from the tool NAME only; a server's readOnlyHint never
    // reaches it. Comments are stripped first, so a docblock explaining D1 is not a read.
    const code = (file: string) => readFileSync(join(AGENT_DIR, file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const names = (file: string) => ({ file, readOnlyHint: code(file).includes('readOnlyHint'), annotations: /\bannotations\b/.test(code(file)) })
    for (const file of ['mode-manager.ts', 'permissions-config.ts', 'core/pre-tool-use.ts']) {
      expect(names(file)).toEqual({ file, readOnlyHint: false, annotations: false })
    }
    // POSITIVE CONTROL on the same instrument: a module whose code DOES write the annotation.
    expect(names('session-scoped-tools.ts')).toEqual({ file: 'session-scoped-tools.ts', readOnlyHint: true, annotations: true })
  })
})
