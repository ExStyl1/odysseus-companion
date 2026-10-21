/**
 * F1.289 (origin WJ-dd's F1.258 verifier, F1.258-c) — a tool whose name carries
 * a WRITE TOKEN after its leading verb is never read-only by pattern.
 *
 * ## The defect, measured 2026-09-23 on `runPreToolUseChecks`
 *
 * F1.258 anchored the shipped read-only MCP patterns to the tool's leading verb
 * (`^mcp__<server>__<verb>(_<word>)*$`), and F1.287 gave a source's own patterns
 * the same shape. Both still admit a WRITE whose name happens to START with a
 * read verb: `mcp__acme__get_or_create_user`, `find_and_replace`,
 * `status_update` and `fetch_and_delete` answered allow / allow / allow in
 * Explore, `default` and `dontAsk`, and nothing stated the residue.
 *
 * ## The decision (controller, 2026-09-23) and where it lives
 *
 * `isReadOnlyMcpToolWithConfig` (`mode-manager.ts`) — the one place every
 * read-only MCP pattern is consulted, shipped, source-level and user-written
 * alike — refuses the read-only verdict when a word of the tool segment AFTER
 * its first one is a write token (`MCP_WRITE_TOKENS`, the same module).
 *
 * Amended by UB1.8 (2026-10-15, upstream v0.15.1 `mcp-tool-names.ts`): the
 * token list is upstream's `MCP_WRITE_WORDS` plus our `push`/`upload`, and the
 * split is upstream's — camelCase and any non-alphanumeric separator — so
 * `fetch-and-ack`, `fetchAndAck` and `get_and_archive_thread` now carry a
 * token where the old `_`-only split read them read-only. The leading word is
 * still excluded (the anchoring F1.258 chose: the patterns judge the verb),
 * upstream's two POSITION widenings (a read verb after the source slug; a
 * trailing read verb) are not adopted, and the shipped Explore rules stay
 * `_`-anchored (a camelCase read is carded by F1.258's narrowing, pinned by
 * `shipped-mcp-read-only-anchoring.test.ts` — unchanged here).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import * as modeManager from '../mode-manager.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { getAppPermissionsDir, permissionsConfigCache } from '../permissions-config.ts'
import { mcpToolCarriesWriteToken, mcpToolNameReadsAsReadOnly } from '../mcp-tool-name-verbs.ts'

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
)

const KEY = { workspaceId: 'ws-f1289', sessionId: 'session-f1289' }
const SOURCE_SLUGS = ['acme', 'linear']

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
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1289-')))
  mkdirSync(join(workspace, 'sources', 'linear'), { recursive: true })
  writeFileSync(join(workspace, 'sources', 'linear', 'permissions.json'), JSON.stringify({
    allowedMcpPatterns: [{ pattern: 'lookup', comment: 'Lookups (a verb the shipped file does not carry)' }],
  }))
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
    activeSourceSlugs: SOURCE_SLUGS,
    allSourceSlugs: SOURCE_SLUGS,
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
const table = (names: string[]): Record<string, Verdicts> => Object.fromEntries(names.map(name => [name, threeModes(name)]))
const all = (names: string[], value: Verdicts): Record<string, Verdicts> => Object.fromEntries(names.map(name => [name, value]))

describe('F1.289 · a write token after the leading verb is never read-only by pattern', () => {
  it('the verifier\'s four (shipped patterns) and a source-level twin take the write path — block / card / block', () => {
    const names = [
      'mcp__acme__get_or_create_user',
      'mcp__acme__find_and_replace',
      'mcp__acme__status_update',
      'mcp__acme__fetch_and_delete',
      'mcp__linear__lookup_and_delete',
    ]
    expect(table(names)).toEqual(all(names, REFUSED))
  }, GATE_BUDGET_MS)

  it('CONTROL: reads led by a read verb with no write token stay allowed in all three modes', () => {
    const names = ['mcp__acme__get_open_items', 'mcp__acme__search_issues', 'mcp__linear__lookup_user']
    expect(table(names)).toEqual(all(names, ALLOWED))
  }, GATE_BUDGET_MS)

  it('UB1.8: the row\'s three names MATCH the shipped read patterns and now take the write path through the gate', () => {
    // Each name leads with a shipped read verb, so before UB1.8 the pattern half
    // allowed it and the `_`-only token half saw nothing: allow in all three
    // modes. With upstream's word list + splitting the token half refuses.
    const names = [
      'mcp__acme__get_and_archive_thread',
      'mcp__acme__fetch_and_ack',
      'mcp__acme__list_and_cancel_jobs',
    ]
    expect(table(names)).toEqual(all(names, REFUSED))
  }, GATE_BUDGET_MS)

  it('reads the tool segment only, UB1.8\'s camel/hyphen words, and not its leading word', () => {
    // Read off the namespace so this arm fails on its own assertion, not at import, where the helper is absent.
    const mcpToolCarriesWriteToken = (name: string): unknown => (modeManager as unknown as Record<string, unknown>).mcpToolCarriesWriteToken
      ? (modeManager as unknown as { mcpToolCarriesWriteToken: (n: string) => boolean }).mcpToolCarriesWriteToken(name)
      : 'helper absent'
    expect(mcpToolCarriesWriteToken('mcp__acme__get_or_create_user')).toBe(true)
    expect(mcpToolCarriesWriteToken('mcp__acme__status_Update')).toBe(true)
    // The server segment is not the tool's name.
    expect(mcpToolCarriesWriteToken('mcp__update-hub__get_items')).toBe(false)
    // A word that merely CONTAINS a token is not the token (whole-word match).
    expect(mcpToolCarriesWriteToken('mcp__acme__list_updates')).toBe(false)
    // UB1.8: the hyphenated (and camel) forms now split — `post-analyses` reads
    // as `post` (upstream v0.15.1's splitting); this arm's expectation FLIPPED
    // from false, by the row, with the amendment recorded in the header.
    expect(mcpToolCarriesWriteToken('mcp__dpFinedog__dp_finedog_search_post-analyses')).toBe(true)
    expect(mcpToolCarriesWriteToken('mcp__acme__fetchAndAck')).toBe(true)
    // CONTROL on the same instrument: a hyphenated word that is NOT a token stays false.
    expect(mcpToolCarriesWriteToken('mcp__acme__list_thread-updates')).toBe(false)
    // The leading word is the verb the patterns already judge (F1.258's anchoring, kept).
    expect(mcpToolCarriesWriteToken('mcp__acme__delete')).toBe(false)
    // A `__`-namespaced tool segment (nestor-cloud) is read whole.
    expect(mcpToolCarriesWriteToken('mcp__srv__ns__get_and_delete')).toBe(true)
  })

  describe('UB1.8 · upstream v0.15.1 word list and splitting (SEC-6)', () => {
    const token = (name: string): boolean => mcpToolCarriesWriteToken(name)
    const readsAsReadOnly = (name: string): boolean => mcpToolNameReadsAsReadOnly(name)

    it('the row\'s three measured names now carry a token (positive)', () => {
      expect(token('mcp__acme__get_and_archive_thread')).toBe(true)
      expect(token('mcp__acme__fetch_and_ack')).toBe(true)
      expect(token('mcp__acme__list_and_cancel_jobs')).toBe(true)
    })

    it('CONTROL: the row\'s reads stay token-free through camel and hyphen splitting (positive)', () => {
      expect(token('mcp__acme__list_issues')).toBe(false)
      expect(token('mcp__acme__getUser')).toBe(false)
      expect(token('mcp__acme__search-docs')).toBe(false)
      // `list_issues` is a read by the full name model too (a shipped verb leads it);
      // the camel/hyphen reads are carded by the shipped `_`-anchored Explore rules
      // (F1.258's deliberate narrowing, unchanged and pinned elsewhere) — the token
      // table's contract is only that it never calls them writes.
      expect(readsAsReadOnly('mcp__acme__list_issues')).toBe(true)
    })

    it('CONTROL: names the old split missed are writes by the name model (negative)', () => {
      for (const name of [
        'mcp__acme__archiveThread', // camel write, no `_` boundary
        'mcp__acme__ack-alert', // hyphen write
        'mcp__acme__submitForm', // camel write
        'mcp__acme__delete_account', // the leading word is no read verb
      ]) {
        expect(readsAsReadOnly(name)).toBe(false)
      }
    })

    it('CONTROL: upstream\'s two position widenings are NOT adopted (negative)', () => {
      // a read verb after the source slug (upstream: mcp__slack__slack_get_channel_history is a read)
      expect(readsAsReadOnly('mcp__slack__slack_get_channel_history')).toBe(false)
      // a trailing read verb in a two-word name (upstream: mcp__github__issue_read is a read)
      expect(readsAsReadOnly('mcp__github__issue_read')).toBe(false)
      // the widening's own boundary control: a trailing write word is still a write
      expect(readsAsReadOnly('mcp__acme__issues_list_and_delete')).toBe(false)
    })

    it('upstream\'s MCP_WRITE_WORDS are each present, and our two stay (the union only refuses)', () => {
      const tokens = (modeManager as unknown as { MCP_WRITE_TOKENS?: ReadonlySet<string> }).MCP_WRITE_TOKENS
      // The words of upstream v0.15.1 mcp-tool-names.ts that our pre-UB1.8 list lacked.
      const FROM_UPSTREAM = [
        'upsert', 'del', 'rm', 'truncate', 'purge', 'wipe', 'erase', 'append', 'modify', 'copy',
        'duplicate', 'clone', 'rebase', 'revert', 'unpublish', 'unarchive', 'reopen', 'cancel',
        'approve', 'reject', 'dismiss', 'assign', 'unassign', 'kick', 'ban', 'unban', 'unblock',
        'mute', 'unmute', 'follow', 'unfollow', 'react', 'upvote', 'downvote', 'enable', 'disable',
        'activate', 'deactivate', 'restart', 'kill', 'terminate', 'exec', 'trigger', 'invoke', 'pay',
        'buy', 'subscribe', 'unsubscribe', 'grant', 'revoke', 'authorize', 'login', 'logout', 'reply',
        'forward', 'mark', 'submit', 'save', 'apply', 'uninstall', 'upgrade', 'downgrade', 'rollback',
        'reboot', 'shutdown', 'provision', 'allocate', 'accept', 'decline', 'attach', 'detach',
        'notify', 'compose', 'archive', 'publish', 'deploy', 'restore', 'toggle', 'rebuild', 'refresh',
        'flush', 'optimize', 'install', 'sync', 'ack', 'confirm', 'reindex', 'enqueue', 'dequeue', 'retry',
      ]
      expect({
        missingFromList: FROM_UPSTREAM.filter(word => !tokens?.has(word)),
      }).toEqual({ missingFromList: [] })
      // Ours, beyond upstream — dropping either would widen what runs card-free.
      expect(tokens?.has('push')).toBe(true)
      expect(tokens?.has('upload')).toBe(true)
    })
  })

  it('the token list is re-derivable: the shipped file\'s write-side verbs are each in it, and each is in that file', () => {
    // Source (1) of `MCP_WRITE_TOKENS`: every verb default.json's bash side names as a
    // refused WRITE (its fd, git, gh, kubectl, sed, yq, xmllint, ss, ip and `-h` comments).
    // A verb that leaves the file, or one the list drops, turns this red.
    const FROM_SHIPPED_WRITE_SIDE = [
      'create', 'add', 'remove', 'set', 'write', 'delete', 'drop', 'destroy', 'expire', 'post', 'edit',
      'push', 'execute', 'run',
    ]
    const tokens = (modeManager as unknown as { MCP_WRITE_TOKENS?: ReadonlySet<string> }).MCP_WRITE_TOKENS
    const inFile = (verb: string) => new RegExp(`(?<![A-Za-z])${verb}(?:s|es|d|ed)?(?![A-Za-z])`, 'i').test(SHIPPED_TEXT)
    expect({
      missingFromList: FROM_SHIPPED_WRITE_SIDE.filter(verb => !tokens?.has(verb)),
      missingFromFile: FROM_SHIPPED_WRITE_SIDE.filter(verb => !inFile(verb)),
    }).toEqual({ missingFromList: [], missingFromFile: [] })
    // CONTROL on the same instrument: a token the file never names is not found in it.
    // The probe was `upload` until 2026-10-10: UA12.184's gh api entry comment
    // (c69a1ef76, `default.json`'s "writes and uploads" prose) put the word in the
    // file as a NOUN, so the probe moved to `update` — still a list member (the
    // decision's own eleven, the verb of the row's measured `status_update`), still
    // absent from the shipped file.
    expect(inFile('update')).toBe(false)
  })
})
