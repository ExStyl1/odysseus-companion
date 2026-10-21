/**
 * UA9.3 — PageFrame's grant and action gates (spec §15 "Page actions", "Grant requests"; S25).
 *
 * - Negative: a mutating action without user activation is refused; one WITH activation but without frame focus (a
 *   click on the host's toolbar) is refused too; a wrong nonce is refused whatever the gesture.
 * - Positive: an API GET runs with no gesture (upstream's one exemption); a mutating action with activation and focus
 *   passes to the broker.
 * - Negative: a `grant-request` with no activation opens no dialog, nor one without frame focus; a second request while
 *   one is open is dropped; past `GRANT_DIALOGS_PER_MINUTE` in a minute nothing opens, and a minute later it does.
 * - Wiring (read from source — `bun test` here has no DOM): PageFrame runs these gates before it calls the host, asks
 *   the host to validate each requested descriptor before the dialog shows it, and issues the grant with the digest on
 *   screen and the script sha256 the dialog showed. Each wiring needle has a control that fails on the source with the
 *   gate removed.
 *
 * The dialog row's rendering (the host descriptor as the authority even when the page's description contradicts it)
 * is in `page-source-auth-banner.test.tsx`, beside the other renders.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GRANT_DIALOGS_PER_MINUTE,
  checkPageAction,
  checkPageGrantRequest,
  descriptorSignature,
} from '../page-frame-gates'

const NONCE = 'n'.repeat(32)
const action = (over: Partial<Parameters<typeof checkPageAction>[0]> = {}) =>
  checkPageAction({ nonce: NONCE, leaseNonce: NONCE, mutating: true, userActivation: true, frameFocused: true, ...over })

describe('checkPageAction — mutations need a gesture INSIDE the frame', () => {
  it('positive: a mutating action with activation and frame focus passes; an API GET needs neither', () => {
    expect(action()).toEqual({ ok: true })
    expect(action({ mutating: false, userActivation: false, frameFocused: false })).toEqual({ ok: true })
  })

  it('negative: a mutation without activation is refused (a timer or onload POST)', () => {
    const verdict = action({ userActivation: false })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.error).toStartWith('user-activation-required:')
  })

  it('negative: a mutation with activation but without frame focus is refused (a click on the host toolbar)', () => {
    const verdict = action({ frameFocused: false })
    expect(verdict.ok === false && verdict.reason).toBe('frame-focus-required')
    expect(verdict.ok === false && verdict.error).toStartWith('frame-focus-required:')
  })

  it('negative: a wrong nonce is refused even with a gesture', () => {
    expect(action({ nonce: 'x'.repeat(32) })).toMatchObject({ ok: false, reason: 'nonce-mismatch' })
  })
})

const request = (over: Partial<Parameters<typeof checkPageGrantRequest>[0]> = {}) =>
  checkPageGrantRequest({
    nonce: NONCE,
    leaseNonce: NONCE,
    userActivation: true,
    frameFocused: true,
    dialogOpen: false,
    recentDialogs: [],
    now: 1_000_000,
    ...over,
  })

describe('checkPageGrantRequest — no prompt without a gesture, one at a time, bounded', () => {
  it('positive: a request from a click inside the frame may open a dialog', () => {
    expect(request()).toEqual({ ok: true })
  })

  it('negative: a grant-request with no activation opens no dialog', () => {
    expect(request({ userActivation: false })).toEqual({ ok: false, reason: 'no-user-activation' })
  })

  it('negative: a grant-request without frame focus opens no dialog', () => {
    expect(request({ frameFocused: false })).toEqual({ ok: false, reason: 'frame-not-focused' })
  })

  it('negative: a second request while one is open is dropped', () => {
    expect(request({ dialogOpen: true })).toEqual({ ok: false, reason: 'dialog-open' })
  })

  it('negative: past the per-minute cap nothing opens; boundary: a minute later it may', () => {
    const now = 1_000_000
    const recent = Array.from({ length: GRANT_DIALOGS_PER_MINUTE }, (_, i) => now - 1_000 * (i + 1))
    expect(request({ recentDialogs: recent, now })).toEqual({ ok: false, reason: 'rate-limited' })
    expect(request({ recentDialogs: recent.slice(1), now })).toEqual({ ok: true })
    expect(request({ recentDialogs: recent, now: now + 60_000 })).toEqual({ ok: true })
  })

  it('negative: a wrong nonce opens nothing', () => {
    expect(request({ nonce: 'x' })).toEqual({ ok: false, reason: 'nonce-mismatch' })
  })
})

describe('descriptorSignature — deny memory identity', () => {
  it('distinguishes script args and runtime, and the three kinds', () => {
    const a = descriptorSignature({ kind: 'script', script: 's.ts', args: ['a', 'b'] })
    expect(a).not.toBe(descriptorSignature({ kind: 'script', script: 's.ts', args: ['a b'] }))
    expect(a).not.toBe(descriptorSignature({ kind: 'script', script: 's.ts', args: ['a', 'b'], runtime: 'node' }))
    expect(descriptorSignature({ kind: 'mcp', sourceSlug: 's', toolName: 't' })).toBe('mcp:s:t')
    expect(descriptorSignature({ kind: 'api', sourceSlug: 's', method: 'GET', pathPattern: '/x' })).toBe('api:s:GET:/x')
  })
})

function code(file: string): string {
  return readFileSync(join(import.meta.dir, '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

describe('wiring: PageFrame runs the gates before it reaches the host', () => {
  const ACTION_GATED = /const gate = checkPageAction\(\{[\s\S]*?frameFocused: frameFocused\(\),[\s\S]*?if \(!gate\.ok\) \{\s*reject\(gate\.error\)[\s\S]*?window\.electronAPI\.executePageAction\(/
  const REQUEST_GATED = /const gate = checkPageGrantRequest\(\{[\s\S]*?userActivation: hasUserActivation\(\),[\s\S]*?frameFocused: frameFocused\(\),[\s\S]*?dialogOpen: grantDialogOpenRef\.current,[\s\S]*?if \(!gate\.ok\) \{[\s\S]*?return\s*\}[\s\S]*?describePageGrantRequest\([\s\S]*?setPendingRequest\(validated\)/
  const ISSUE_BOUND = /issuePageGrant\(workspaceId, pageSlug, \{\s*action: entry\.action,\s*contentDigest: lease\.contentDigest,\s*\.\.\.\(entry\.scriptSha256 \? \{ scriptSha256: entry\.scriptSha256 \} : \{\}\)/

  it('positive: the action is gated, the grant request is gated and host-validated, the issue is bound', () => {
    const frame = code('PageFrame.tsx')
    expect(frame).toMatch(ACTION_GATED)
    expect(frame).toMatch(REQUEST_GATED)
    expect(frame).toMatch(ISSUE_BOUND)
    // The frame reads its grants from the ledger prop, never page.json.
    expect(frame).not.toContain('config.grants')
  })

  it('NEGATIVE (controls): each pattern fails on the source with its gate removed', () => {
    const frame = code('PageFrame.tsx')
    const noActionGate = frame.replace(/if \(!gate\.ok\) \{\s*reject\(gate\.error\)[\s\S]*?return\s*\}/, '')
    expect(noActionGate).not.toBe(frame)
    expect(noActionGate).not.toMatch(ACTION_GATED)
    const noFocus = frame.replace('dialogOpen: grantDialogOpenRef.current,', 'dialogOpen: false,')
    expect(noFocus).not.toBe(frame)
    expect(noFocus).not.toMatch(REQUEST_GATED)
    const noHostCheck = frame.replace('window.electronAPI.describePageGrantRequest(', 'Promise.resolve(')
    expect(noHostCheck).not.toBe(frame)
    expect(noHostCheck).not.toMatch(REQUEST_GATED)
    const unbound = frame.replace('contentDigest: lease.contentDigest,', '')
    expect(unbound).not.toMatch(ISSUE_BOUND)
  })
})

describe('UA12.112 wiring: a refusal the renderer itself decided is reported for the audit', () => {
  // The action gate's refusal branch reports before it answers the frame; the report carries the
  // gate's code and the frame-supplied identity, fire-and-forget.
  const ACTION_REFUSAL_AUDITED =
    /if \(!gate\.ok\) \{\s*reject\(gate\.error\)\s*void window\.electronAPI\.auditPageGateRefusal\(workspaceId, \{[^}]*?kind: 'action',[^}]*?code: gate\.reason,[^}]*?invocation: msg\.invocation,[^}]*?\}\)\.catch\(\(\) => \{\}\)\s*return\s*\}/
  // The grant-request refusal branch reports too — before the state-only answer to the frame.
  const REQUEST_REFUSAL_AUDITED =
    /if \(!gate\.ok\) \{\s*void window\.electronAPI\.auditPageGateRefusal\(workspaceId, \{[^}]*?kind: 'grant-request',[^}]*?code: gate\.reason,[^}]*?requestCount: msg\.requests\.length,[^}]*?\}\)\.catch\(\(\) => \{\}\)/

  it('POSITIVE: both refusal branches report the refusal to the host, fire-and-forget', () => {
    const frame = code('PageFrame.tsx')
    expect(frame).toMatch(ACTION_REFUSAL_AUDITED)
    expect(frame).toMatch(REQUEST_REFUSAL_AUDITED)
  })

  it('NEGATIVE (controls): each needle fails on the source with its report removed', () => {
    const frame = code('PageFrame.tsx')
    const silentAction = frame.replace(/void window\.electronAPI\.auditPageGateRefusal\(workspaceId, \{\s*kind: 'action',[^}]*?\}\)\.catch\(\(\) => \{\}\)/, '')
    expect(silentAction).not.toBe(frame)
    expect(silentAction).not.toMatch(ACTION_REFUSAL_AUDITED)
    const silentRequest = frame.replace(/void window\.electronAPI\.auditPageGateRefusal\(workspaceId, \{\s*kind: 'grant-request',[^}]*?\}\)\.catch\(\(\) => \{\}\)/, '')
    expect(silentRequest).not.toBe(frame)
    expect(silentRequest).not.toMatch(REQUEST_REFUSAL_AUDITED)
  })
})
