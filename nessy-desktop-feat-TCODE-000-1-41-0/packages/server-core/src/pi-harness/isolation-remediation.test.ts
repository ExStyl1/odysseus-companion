/**
 * The remediation sentences, asserted as user-visible text.
 *
 * `isolation-capabilities.ts` renders `remediation` straight into the
 * Permissions settings list, so these strings are the only thing an operator
 * reads when isolation refuses to run. They are English-only by construction:
 * they are appended to the machine-parseable
 * `process-isolation-unavailable:<platform>:<profile>[:<reason>]` head, so they
 * carry no locale keys and drift silently unless pinned here.
 */

import { describe, expect, it } from 'bun:test'
import {
  ISOLATION_UNAVAILABLE_PREFIX,
  READ_GRANT_IS_LAUNCH_TIME,
  REMEDIATION_SEPARATOR,
  isolationUnavailable,
  isolationUnavailableReason,
  isolationUnavailableRemediation,
} from './isolation-remediation.ts'

describe('the win32 toolchain remediation names the diagnostics the binaries write', () => {
  // P6.456. Path read from the codex SOURCE at `rust-v0.148.0`, which outranks
  // the page for this runtime: `windows-sandbox-rs/src/setup.rs` `sandbox_dir`
  // joins `.sandbox` onto CODEX_HOME and `windows-sandbox-rs/src/logging.rs`
  // rotates `sandbox.<date>.log` daily with `MAX_LOG_FILES = 90`.
  it('names the .sandbox directory, the daily log shape and its retention', () => {
    const remediation = isolationUnavailableRemediation(
      isolationUnavailable('win32', 'workspace', 'runtime'),
    )
    expect(remediation).toContain('.sandbox\\')
    expect(remediation).toContain('sandbox.<YYYY-MM-DD>.log')
    expect(remediation).toContain('90 files')
    expect(remediation).toContain('setup_error.json')
    expect(remediation).toContain('CODEX_HOME')
  })

  // The negative half, and the reason this row exists at all: the page's
  // `windows-sandbox.log` is the feedback ATTACHMENT override
  // (`feedback/src/lib.rs` `WINDOWS_SANDBOX_LOG_ATTACHMENT_FILENAME`), never a
  // filename on disk. Naming it would send an operator looking for a file that
  // does not exist.
  it('does not name windows-sandbox.log, which is only the upload attachment name', () => {
    const remediation = isolationUnavailableRemediation(
      isolationUnavailable('win32', 'workspace', 'runtime'),
    )
    expect(remediation).not.toContain('windows-sandbox.log')
  })

  it('warns the operator off the DPAPI secrets directory beside it', () => {
    const remediation = isolationUnavailableRemediation(
      isolationUnavailable('win32', 'workspace', 'runtime'),
    )
    expect(remediation).toContain('.sandbox-secrets\\')
    expect(remediation).toMatch(/never read or copy/)
  })

  // The structured head is a separate contract and the added sentence must not
  // reach into it: `isolationUnavailableRemediation` splits on ` — `, so a dash
  // inside the remediation would move the boundary.
  it('leaves the parseable head and the separator untouched', () => {
    const message = isolationUnavailable('win32', 'workspace', 'runtime')
    expect(message.split(REMEDIATION_SEPARATOR)[0])
      .toBe(`${ISOLATION_UNAVAILABLE_PREFIX}:win32:workspace:runtime`)
    expect(message.split(REMEDIATION_SEPARATOR)).toHaveLength(2)
  })

  // The state-root case is a host wiring fault: no root exists, so there is no
  // directory to name. The negative control that the text is attached to the
  // toolchain branch alone.
  it('says nothing about a log directory when no state root was supplied', () => {
    const remediation = isolationUnavailableRemediation(
      isolationUnavailable('win32', 'workspace', 'state-root'),
    )
    expect(remediation).not.toContain('.sandbox\\')
    expect(remediation).toContain('host wiring fault')
  })
})

describe('the read-allowlist refusal says a grant cannot reach a running session', () => {
  // P6.331. The static `allowRead` case already had a sentence; the mid-session
  // grant had none, on any runtime, and this is the only place the host speaks
  // about read grants at all.
  it('names the new session and keeps the macOS setting that re-opens a subtree', () => {
    const remediation = isolationUnavailableRemediation(
      isolationUnavailable('linux', 'workspace', 'read-allowlist'),
    )
    expect(remediation).toContain(READ_GRANT_IS_LAUNCH_TIME)
    expect(remediation).toMatch(/NEW session/)
    expect(remediation).toContain('sandbox.filesystem.allowRead')
    expect(remediation).toContain('macOS sandbox-exec')
  })

  // Each runtime is named because the claim is per runtime and each was
  // measured: pi resolves once per spawn, claude has only the launch flag
  // (`add_directory`/`addDirectory` are 0 lines / 0 occurrences in the vendored
  // 0.3.247 `sdk.mjs` AND `sdk.d.ts` against `set_permission_mode` and `setModel`
  // at 1/1 in both — re-measured 2026-09-12, C3.252; the module's own docblock
  // carries why the name being NON-zero in the native 2.1.247 binary does not
  // move the verdict), and codex's slash command lives
  // in the TUI binary, not the app-server we drive.
  it('names all three runtimes rather than generalising from one', () => {
    expect(READ_GRANT_IS_LAUNCH_TIME).toContain('Pi')
    expect(READ_GRANT_IS_LAUNCH_TIME).toContain('claude')
    expect(READ_GRANT_IS_LAUNCH_TIME).toContain('codex')
    expect(READ_GRANT_IS_LAUNCH_TIME).toContain('--add-dir')
    expect(READ_GRANT_IS_LAUNCH_TIME).toContain('sandbox-add-read-dir')
  })

  // The sentence is appended AFTER the separator, so an em dash inside it would
  // move the boundary `isolationUnavailableReason` splits on. The whole point of
  // the constant is that it carries none.
  it('carries no copy of the remediation separator', () => {
    expect(READ_GRANT_IS_LAUNCH_TIME).not.toContain(REMEDIATION_SEPARATOR)
    const message = isolationUnavailable('linux', 'workspace', 'read-allowlist')
    expect(message.split(REMEDIATION_SEPARATOR)).toHaveLength(2)
    expect(isolationUnavailableReason(message, 'linux', 'workspace')).toBe('read-allowlist')
  })

  // Negative control: the sentence belongs to the read-grant case only. A
  // toolchain or state-root failure has nothing to do with read boundaries.
  it('is absent from the unrelated isolation failures', () => {
    for (const message of [
      isolationUnavailable('linux', 'workspace'),
      isolationUnavailable('win32', 'workspace', 'state-root'),
      isolationUnavailable('darwin', 'workspace'),
    ]) {
      expect(isolationUnavailableRemediation(message)).not.toContain('NEW session')
    }
  })
})
