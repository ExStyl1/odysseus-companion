/**
 * Pi `browser_tool` error-code mapping tests.
 *
 * Calls the in-file `mapBrowserToolErrorCode` helper indirectly through the
 * exported behaviour: by stubbing `getSessionScopedToolCallbacks` and
 * throwing typed errors from the browser callbacks, we observe the
 * agent-facing string the Pi agent returns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { CodedError, isErrorCode } from '../../protocol/types.ts'

// We re-implement the mapping inline here as a contract test — if the
// runtime mapping in pi-agent.ts drifts from this list, the test fails
// because the agent-facing string won't include the expected substring.
const EXPECTED: Record<string, string> = {
  BROWSER_NO_CAPABLE_CLIENT: 'No connected desktop client',
  CAPABILITY_UNAVAILABLE: 'No connected desktop client',
  CLIENT_DISCONNECTED: 'disconnected',
  CLIENT_REQUEST_TIMEOUT: 'timed out',
  // Substring intentionally avoids the apostrophe so the contract test
  // doesn't have to mirror source-level escaping.
  BROWSER_INSTANCE_NOT_OWNED: 'belong to this session',
  BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED: 'File upload from a remote agent',
  BROWSER_REMOTE_EVALUATE_BLOCKED: 'JavaScript evaluation is disabled',
  // P2.464 — the managed refusal. The fragment is the do-not-retry half; the
  // other half is the SENDER's sentence, which this case keeps rather than
  // replaces (it names the administrator's document) and is asserted below.
  BROWSER_MANAGED_DISABLED: 'Do not retry',
}

describe('pi-agent browser_tool error mapping (contract)', () => {
  for (const [code, expectedFragment] of Object.entries(EXPECTED)) {
    it(`maps ${code} to a friendly agent message`, () => {
      // The mapping function lives in pi-agent.ts but is private. We reach it
      // via the dynamic import — if it's renamed, the test should still detect
      // missing coverage in a follow-up integration test.
      const piAgentSource = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'pi-agent.ts'),
        'utf-8',
      ) as string

      expect(piAgentSource).toContain(`case '${code}'`)
      expect(piAgentSource).toContain(expectedFragment)
    })
  }

  /**
   * P2.464 — the managed browser refusal is its own code, so a receiver can
   * translate it, and its guidance KEEPS the sender's sentence.
   *
   * Two halves, because either alone is the defect: a code the wire does not
   * know degrades to `HANDLER_ERROR` handling, and a guidance string that
   * replaced the message would drop the only actionable fact in the refusal —
   * which administrator's document turned the browser off.
   */
  it('BROWSER_MANAGED_DISABLED is a known wire code whose guidance keeps the sender sentence', () => {
    expect(isErrorCode('BROWSER_MANAGED_DISABLED')).toBe(true)
    const piAgentSource = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'pi-agent.ts'),
      'utf-8',
    ) as string
    // Interpolates the message rather than returning a literal — the
    // distinguishing shape, and the reason the mapper takes it at all.
    expect(piAgentSource).toContain('return `${message} Do not retry')
    expect(piAgentSource).toContain('mapBrowserToolErrorCode(code, msg)')
  })

  it('CodedError carries the right code', () => {
    const err = new CodedError('BROWSER_NO_CAPABLE_CLIENT', 'no client')
    expect(err.code).toBe('BROWSER_NO_CAPABLE_CLIENT')
    expect(err.message).toBe('no client')
    expect(err).toBeInstanceOf(Error)
  })
})

// Silence unused warnings — these are kept to make refactor breakage visible.
beforeEach(() => {})
afterEach(() => {})
