/**
 * P2.276 — the CONSUMER half. The carrier and its reader land together or not
 * at all; this file is the "not at all" guard.
 *
 * The previous lane refused to add `permissionDslDiagnostics` on its own, on the
 * grounds that a field with no reader is the exact defect its parent row was
 * fixing. That reasoning is preserved here as a test rather than as a comment:
 * remove the call from `sendMessage` and this goes red.
 *
 * ## Two halves, because the wiring and the message fail differently
 *
 * 1. **Wiring** is asserted against the source, because this runner has no
 *    session store, no capability resolver and no process supervisor, and
 *    constructing a `SessionManager` to prove one call site would test the
 *    fixture. Every assertion carries a positive control so a renamed symbol
 *    fails loudly instead of matching nothing.
 * 2. **The message** is exercised for real, in a FRESH process with i18next
 *    uninitialised — which is the state a headless `nessy-server` starts in.
 *    P2.196 measured that an uninitialized i18next returns `undefined` rather
 *    than the key, so 15 of 17 keys rendered BLANK on that path. A notice that
 *    renders empty is the same silence this row exists to end, so the guard
 *    asserts NON-EMPTY rather than key-equality: key-equality is a statement
 *    about an initialized instance and can only be written in a file that has
 *    already initialized i18n — the exact state production lacked.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { permissionPolicyNoticeParts } from '@nessy-agent/shared/agent/permissions-config'

const source = readFileSync(
  fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
  'utf-8',
)

describe('P2.276 — the permission-policy notice is wired to a real send', () => {
  it('the reader exists and reads the CARRIER, not a re-derivation', () => {
    expect(source).toContain('private announcePermissionPolicyDiagnostics(')
    expect(source).toContain('.permissionDslDiagnostics')
    // The scope join belongs to `reportPermissionDslDiagnostics`; a consumer
    // that rebuilt it from `droppedRules` could name a different file than the
    // log line does.
    expect(source).not.toContain('scopeByDiagnostic')
  })

  it('`sendMessage` calls it — this is the assertion the carrier is not allowed to ship without', () => {
    const sendMessage = source.slice(source.indexOf('  async sendMessage('))
    expect(sendMessage.length).toBeGreaterThan(0)
    // Within the first stretch of the method, before any await: a notice that
    // only fires after the turn succeeds is not a notice the user gets when the
    // turn is the thing their broken rule affected.
    const head = sendMessage.slice(0, 4000)
    expect(head).toContain('this.announcePermissionPolicyDiagnostics(managed)')
  })

  it('it emits on the user-visible event channel at warning level, not to a log', () => {
    const method = source.slice(
      source.indexOf('private announcePermissionPolicyDiagnostics('),
      source.indexOf('private announcePermissionPolicyDiagnostics(') + 3000,
    )
    expect(method).toContain("type: 'info'")
    expect(method).toContain("level: 'warning'")
    expect(method).toContain('this.sendEvent(')
    // Positive control for the slice: a wrong offset would make every
    // `toContain` above vacuous by searching an empty string.
    expect(method).toContain('announcePermissionPolicyDiagnostics')
  })

  it('it is deduped on WHAT was dropped, so a second defect is still announced', () => {
    const method = source.slice(source.indexOf('private announcePermissionPolicyDiagnostics('))
    expect(method).toContain('announcedPermissionPolicyDrops')
    // Keyed on the diagnostics, not on the session alone.
    expect(method).toContain('const fingerprint =')
    expect(method).toContain('diagnostic.code')
  })

  it('it cannot cost a turn: the read is guarded', () => {
    const method = source.slice(
      source.indexOf('private announcePermissionPolicyDiagnostics('),
      source.indexOf('private announcePermissionPolicyDiagnostics(') + 3000,
    )
    expect(method).toContain('try {')
    expect(method).toContain('} catch (error) {')
  })
})

describe('P2.276 — the notice renders text on a headless start', () => {
  it('is non-empty and interpolates the scope, from an uninitialised i18next', () => {
    // The production guard, reproduced: `SessionManager` calls exactly this
    // before `t()`. Running it here proves the keys exist AND that the guard is
    // sufficient — an uninitialised instance returns `undefined`, not the key.
    if (!i18n.isInitialized) setupI18n()

    const one = i18n.t('chat.permissionPolicy.rulesDropped', { count: 1, scopes: 'project' })
    expect(typeof one).toBe('string')
    expect(one.length).toBeGreaterThan(0)
    expect(one).not.toContain('rulesDropped')
    expect(one).toContain('project')

    const many = i18n.t('chat.permissionPolicy.rulesDropped', { count: 3, scopes: 'project, workspace' })
    expect(many.length).toBeGreaterThan(0)
    expect(many).toContain('3')
    expect(many).toContain('workspace')
    // Singular and plural must actually differ, or the plural forms are dead
    // weight and `{{count}}` was never wired.
    expect(many).not.toBe(one)

    const fallback = i18n.t('chat.permissionPolicy.scopeUnknown')
    expect(fallback.length).toBeGreaterThan(0)
    expect(fallback).not.toContain('scopeUnknown')
  })
})

describe('F1.1002 — the notice says FILE for a whole ignored document, and REFUSED for a policy that fails closed', () => {
  const render = (parts: ReturnType<typeof permissionPolicyNoticeParts>) => {
    if (!i18n.isInitialized) setupI18n()
    return parts.map(part => i18n.t(part.key, { count: part.count, scopes: part.scopes.join(', ') })).join(' ')
  }

  it('a dropped document is announced as a file, not as "a permission rule"', () => {
    const text = render(permissionPolicyNoticeParts([{ code: 'invalid-document', scope: 'workspace', document: true }]))
    expect(text).toContain('permission settings file in workspace was ignored as a whole')
    expect(text).not.toContain('permission rule')
  })

  it('boundary: a dropped rule keeps its sentence, and both kinds side by side get one sentence each', () => {
    expect(permissionPolicyNoticeParts([{ code: 'invalid-document', scope: 'project' }]).map(part => part.key))
      .toEqual(['chat.permissionPolicy.rulesDropped'])
    const both = permissionPolicyNoticeParts([
      { code: 'invalid-document', scope: 'workspace', document: true },
      { code: 'invalid-document', scope: 'project' },
    ])
    expect(both.map(part => [part.key, part.scopes])).toEqual([
      ['chat.permissionPolicy.documentsDropped', ['workspace']],
      ['chat.permissionPolicy.rulesDropped', ['project']],
    ])
  })

  it('a policy that fails closed says calls are refused, and says nothing about other rules still applying', () => {
    const text = render(permissionPolicyNoticeParts([{ code: 'invalid-document' }], 'managed'))
    expect(text).toContain('in managed could not be applied, so tool calls are refused')
    expect(text).not.toContain('still applies')
    expect(text).not.toContain('policyFailedClosed')
  })

  it('the reader passes the fail-closed scope and renders every part', () => {
    const method = source.slice(source.indexOf('private announcePermissionPolicyDiagnostics('))
    expect(method).toContain('permissionPolicyNoticeParts(diagnostics, failedClosedScope)')
    expect(method).toContain('invalidSource?.scope')
  })
})
