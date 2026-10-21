import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivilegedExecutionBroker } from './privileged-execution-broker'
import { settleJsonlAppends } from '@nessy-agent/shared/audit-rotate'
import type { Logger } from '../runtime/platform'

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

// An allowlisted privileged command so the request passes policy validation.
const ALLOWED = 'brew install --cask some-app'

describe('PrivilegedExecutionBroker composite session identity', () => {
  it('carries workspaceId so two workspaces reusing a sessionId stay isolated', () => {
    const broker = new PrivilegedExecutionBroker(silentLogger)

    const a = broker.createRequest({ requestId: 'req-a', workspaceId: 'ws-a', sessionId: 'dup', command: ALLOWED })
    const b = broker.createRequest({ requestId: 'req-b', workspaceId: 'ws-b', sessionId: 'dup', command: ALLOWED })

    // Same bare sessionId, different owning workspaces.
    expect(a.sessionId).toBe('dup')
    expect(b.sessionId).toBe('dup')
    expect(a.workspaceId).toBe('ws-a')
    expect(b.workspaceId).toBe('ws-b')
    expect(a.commandHash).toBe(b.commandHash) // identical command

    // Each request resolves independently, returning its own workspace identity.
    const resolvedA = broker.resolveApproval('req-a', true, { expectedCommandHash: a.commandHash })
    expect(resolvedA.ok).toBe(true)
    expect(resolvedA.request?.workspaceId).toBe('ws-a')
    expect(resolvedA.request?.sessionId).toBe('dup')

    const resolvedB = broker.resolveApproval('req-b', true, { expectedCommandHash: b.commandHash })
    expect(resolvedB.ok).toBe(true)
    expect(resolvedB.request?.workspaceId).toBe('ws-b')
    expect(resolvedB.request?.sessionId).toBe('dup')
  })

  it('resolving one workspace request does not consume the other', () => {
    const broker = new PrivilegedExecutionBroker(silentLogger)
    const a = broker.createRequest({ requestId: 'req-a', workspaceId: 'ws-a', sessionId: 'dup', command: ALLOWED })
    broker.createRequest({ requestId: 'req-b', workspaceId: 'ws-b', sessionId: 'dup', command: ALLOWED })

    expect(broker.resolveApproval('req-a', true, { expectedCommandHash: a.commandHash }).ok).toBe(true)
    // req-a is consumed; req-b is still pending and resolvable.
    expect(broker.resolveApproval('req-a', true).ok).toBe(false)
    expect(broker.resolveApproval('req-b', true).request?.workspaceId).toBe('ws-b')
  })

  it('UA12.62: past the cap the audit log rotates to .1 and the new event lands in a fresh file; below the cap nothing rotates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'privileged-audit-rotate-'))
    try {
      const auditPath = join(dir, 'privileged-actions.jsonl')

      // Past the cap: the pre-existing trail becomes .1, the new event starts a fresh file.
      writeFileSync(auditPath, '{"event":"privileged_request_created","command":"old"}\n', 'utf-8')
      const rotating = new PrivilegedExecutionBroker(silentLogger, { auditLogPath: auditPath, auditRotateBytes: 32 })
      rotating.auditEvent('privileged_request_created', { command: 'new' })
      await settleJsonlAppends(auditPath) // UA12.177: wait on the append chain, not on a clock
      expect(existsSync(`${auditPath}.1`)).toBe(true)
      expect(readFileSync(`${auditPath}.1`, 'utf-8')).toBe('{"event":"privileged_request_created","command":"old"}\n')
      const fresh = JSON.parse(readFileSync(auditPath, 'utf-8')) as { event: string; command: string }
      expect(fresh.event).toBe('privileged_request_created')
      expect(fresh.command).toBe('new')

      // Below the cap: events append to the same file, no rotation. (A cap of 32 bytes sits
      // BELOW one audit line, so every append rotates — the tiny cap is only for the arm above.)
      const belowPath = join(dir, 'below-cap.jsonl')
      const below = new PrivilegedExecutionBroker(silentLogger, { auditLogPath: belowPath, auditRotateBytes: 1024 })
      below.auditEvent('privileged_request_created', { command: 'first' })
      below.auditEvent('privileged_request_created', { command: 'second' })
      await settleJsonlAppends(belowPath)
      expect(existsSync(`${belowPath}.1`)).toBe(false)
      const lines = readFileSync(belowPath, 'utf-8').trim().split('\n').filter(Boolean)
      expect(lines).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('UA12.177: two broker instances appending at the cap crossing keep .1 byte-identical and land every new line once', async () => {
    // Unserialized, a microtask-interleaved burst clobbered .1 in 26/40 trials and misplaced new lines
    // in 40/40 (VF-6 probe, 2026-10-08); five trials make the arm fail on such a writer.
    for (let trial = 0; trial < 5; trial++) {
      const dir = mkdtempSync(join(tmpdir(), 'privileged-audit-race-'))
      try {
        const auditPath = join(dir, 'privileged-actions.jsonl')
        // Seeded exactly AT the cap: the first append rotates, the rest land in the fresh file.
        const seed = Array.from({ length: 40 }, (_, n) => `{"event":"privileged_request_created","command":"old-${n}"}`).join('\n') + '\n'
        writeFileSync(auditPath, seed, 'utf-8')
        // Production builds three brokers over the same trail (SessionManager, rpc/automations, rpc/pages).
        const a = new PrivilegedExecutionBroker(silentLogger, { auditLogPath: auditPath, auditRotateBytes: Buffer.byteLength(seed) })
        const b = new PrivilegedExecutionBroker(silentLogger, { auditLogPath: auditPath, auditRotateBytes: Buffer.byteLength(seed) })
        const commands = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']
        for (const [i, command] of commands.entries()) {
          ;(i % 2 === 0 ? a : b).auditEvent('privileged_request_created', { command })
          await Promise.resolve()
        }
        await settleJsonlAppends(auditPath)

        expect(readFileSync(`${auditPath}.1`, 'utf-8')).toBe(seed)
        const fresh = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { command: string }).command)
        expect(fresh.sort()).toEqual([...commands].sort())
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
