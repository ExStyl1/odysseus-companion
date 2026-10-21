/**
 * D1.211 — the spawner's stdout seam, and the credential control on it.
 *
 * Its own file rather than a case in `run.test.ts`, because that file stubs
 * `./server-spawner.ts` with `mock.module`: asserting a module's real behaviour
 * in the same file that replaces it is the shape AGENTS.md's spread rule exists
 * to stop. Here the module is imported for real.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isServerHandshakeLine, shouldForwardServerStdoutLine } from './server-spawner.ts'

const TOKEN = 'a7c1-not-a-real-token-0123456789'

describe('the spawned server handshake', () => {
  it('claims exactly the two lines the parent consumes, and the token is one of them', () => {
    expect(isServerHandshakeLine('NESSY_SERVER_URL=ws://127.0.0.1:1234')).toBe(true)
    expect(isServerHandshakeLine(`NESSY_SERVER_TOKEN=${TOKEN}`)).toBe(true)
  })

  it('claims nothing else, so an ordinary server line is forwarded rather than swallowed', () => {
    // The negative arm matters more than the positive one: a filter that
    // over-matched would silently restore the swallowed-stdout defect this
    // change exists to close.
    expect(isServerHandshakeLine('Nessy Desktop server listening on ws://127.0.0.1:1234')).toBe(false)
    expect(isServerHandshakeLine('Shutting down...')).toBe(false)
    expect(isServerHandshakeLine('Cleaning up resources...')).toBe(false)
    expect(isServerHandshakeLine('')).toBe(false)
  })
})

describe('which stdout lines reach the operator', () => {
  it('forwards the server INFO lines this change exists for', () => {
    expect(shouldForwardServerStdoutLine('Shutting down...', TOKEN)).toBe(true)
    expect(shouldForwardServerStdoutLine('Cleaning up resources...', TOKEN)).toBe(true)
    expect(shouldForwardServerStdoutLine('Nessy Desktop server listening on ws://127.0.0.1:1', TOKEN)).toBe(true)
  })

  it('refuses the handshake, the blank line, and ANY line carrying the token', () => {
    expect(shouldForwardServerStdoutLine('NESSY_SERVER_URL=ws://127.0.0.1:1', TOKEN)).toBe(false)
    expect(shouldForwardServerStdoutLine(`NESSY_SERVER_TOKEN=${TOKEN}`, TOKEN)).toBe(false)
    expect(shouldForwardServerStdoutLine('', TOKEN)).toBe(false)
    // The two cases the handshake prefix alone does NOT catch, which is why the
    // value is matched as a substring: a near-miss key, and an ordinary log
    // line that happens to quote the token.
    expect(isServerHandshakeLine(`NESSY_SERVER_TOKENS=${TOKEN}`)).toBe(false)
    expect(shouldForwardServerStdoutLine(`NESSY_SERVER_TOKENS=${TOKEN}`, TOKEN)).toBe(false)
    expect(shouldForwardServerStdoutLine(`[auth] accepted bearer ${TOKEN} from 127.0.0.1`, TOKEN)).toBe(false)
    // And the control that the substring rule is not simply refusing
    // everything: the same sentence without the token is forwarded.
    expect(shouldForwardServerStdoutLine('[auth] accepted bearer <redacted> from 127.0.0.1', TOKEN)).toBe(true)
  })

  it('an empty token cannot make every line look like a credential', () => {
    // A defensive rule that matched the empty string would drop the whole
    // stream, which is the defect being fixed, arriving through the fix.
    expect(shouldForwardServerStdoutLine('Shutting down...', '')).toBe(true)
  })

  /**
   * The forwarder itself is inside a promise executor over a live
   * `ReadableStream`, so there is no seam to drive it without spawning a real
   * server. What IS assertable without one — and what a regression would
   * actually look like — is that the stdout loop routes through the filter and
   * writes to STDERR. `run.test.ts` uses the same source-text shape for the two
   * save paths it cannot reach without an Electron window.
   */
  it('the stdout loop forwards through the filter, and to stderr', () => {
    const source = readFileSync(join(import.meta.dir, 'server-spawner.ts'), 'utf8')
    const code = source
      .split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')

    expect(code).toContain('if (isServerHandshakeLine(line)) {')
    expect(code).toContain('forwardServerStdout(line)')
    expect(code).toContain('function forwardServerStdout')
    const body = code.split('function forwardServerStdout')[1] ?? ''
    expect(body).toContain('shouldForwardServerStdoutLine(line, token)')
    // To stderr, never to stdout: this CLI's stdout is the run's own output and
    // `--output-format stream-json` has a consumer parsing it.
    expect(body).toContain('process.stderr.write')
    expect(body.split('}')[0]).not.toContain('process.stdout')
  })
})
