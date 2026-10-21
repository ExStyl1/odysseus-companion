/**
 * UA1.18 — the ORDER of `publish_artifact`'s host chain (`sessions/artifact-publishing.ts` `runArtifactPublish`),
 * driven with the REAL publish guard (UA1.17), the REAL normaliser and the REAL registry (UA1.16) over a temporary
 * workspace, and a fake service client that records every request. Only the card (`raiseCard`) and the client are
 * stubs — they are the two seams `SessionManager.publishArtifactForAgent` binds; `publish-artifact-host-card.test.ts`
 * drives the real binding.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PublishRequest, TArtifactsClient, ArtifactRecord } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { ArtifactClientError } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { keepArtifactPendingDelete, readArtifactRegistry, recordArtifactPublish } from '@nessy-agent/shared/artifacts/registry'
import { NESSY_HOME_ENV, saveCreds } from '@nessy-agent/shared/auth/dp'
import { makeTestJwt } from '@nessy-agent/shared/auth/dp/__tests__/test-jwt.ts'
import {
  artifactUnattendedReason,
  formatArtifactAuditLine,
  listSessionArtifactSummaries,
  runArtifactPublish,
  type ArtifactAuditRecord,
  type ArtifactCardAnswer,
  type ArtifactPublishCard,
  type ArtifactPublishPorts,
  type ArtifactUnattendedReason,
} from '../artifact-publishing.ts'

const ID = 'abcdefghijklmnopqrstuv'
const URL_ = `https://t-artifacts.t-tech.team/a/${ID}`

let root: string
let cwd: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ua118-ws-'))
  cwd = mkdtempSync(join(tmpdir(), 'ua118-cwd-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

interface Sent { method: 'create' | 'update'; id?: string; request: PublishRequest }

function fakeClient(
  sent: Sent[],
  fail?: ArtifactClientError,
  answer: { withoutExpiry?: boolean; expiresAt?: string } = {},
): TArtifactsClient {
  const record = (request: PublishRequest): ArtifactRecord => {
    // The DEPLOYED service's create/update answer (P-UA-i-4, measured live on RC4, S7-D 2026-10-10):
    // no `expires_at`, no `retention_days` — while the service does expire the link. Shown as the
    // client's own `parseArtifactRecord` reads it: the missing `expires_at` becomes `expiresAt: null`,
    // the missing `retention_days` falls back to the value the request SENT.
    if (answer.withoutExpiry === true) {
      return { id: ID, url: URL_, title: request.title, expiresAt: null, retentionDays: request.retentionDays ?? 7 };
    }
    return {
      id: ID,
      url: URL_,
      title: request.title,
      expiresAt: answer.expiresAt
        ?? (request.retentionDays === undefined ? '2026-12-01T00:00:00.000Z' : '2026-10-09T00:00:00.000Z'),
      retentionDays: request.retentionDays ?? 7,
    };
  }
  return {
    createArtifact: async request => { sent.push({ method: 'create', request }); if (fail) throw fail; return record(request) },
    updateArtifact: async (target, request) => {
      sent.push({ method: 'update', id: 'id' in target ? target.id : undefined, request })
      if (fail) throw fail
      return record(request)
    },
    listOwnedArtifacts: async () => { throw new Error('not used') },
    patchArtifact: async () => { throw new Error('not used') },
    deleteArtifact: async () => { throw new Error('not used') },
  }
}

function harness(options: {
  unattended?: ArtifactUnattendedReason | null
  answers?: Array<ArtifactCardAnswer | ((card: ArtifactPublishCard) => ArtifactCardAnswer)>
  pending?: boolean
  fail?: ArtifactClientError
  deployedAnswer?: boolean
  answerExpiresAt?: string
} = {}) {
  const sent: Sent[] = []
  const cards: ArtifactPublishCard[] = []
  const audits: ArtifactAuditRecord[] = []
  let notified = 0
  const answers = [...(options.answers ?? [{ allowed: true }])]
  const ports: ArtifactPublishPorts = {
    workspaceRoot: root,
    sessionId: 'caller',
    runtime: 'codex',
    permissionMode: 'bypassPermissions',
    sessionCwd: cwd,
    addedRoots: [],
    unattendedReason: () => options.unattended ?? null,
    cardPending: () => options.pending === true,
    raiseCard: async card => {
      cards.push(card)
      const next = answers.shift() ?? { allowed: false }
      return typeof next === 'function' ? next(card) : next
    },
    createClient: () => fakeClient(sent, options.fail, {
      ...(options.deployedAnswer === true ? { withoutExpiry: true } : {}),
      ...(options.answerExpiresAt !== undefined ? { expiresAt: options.answerExpiresAt } : {}),
    }),
    audit: record => { audits.push(record) },
    // UA12.52 — the host's `artifacts:changed` push port; the arms below pin when it fires.
    notifyArtifactChanged: () => { notified += 1 },
    now: () => new Date('2026-10-02T00:00:00.000Z'),
  }
  return { ports, sent, cards, audits, notified: () => notified }
}

const PAGE = '<!doctype html><html><head><title>Q3</title></head><body><h1>Q3</h1><script>x()</script><img src="https://cdn.example/a.png"></body></html>'

describe('positive — approve sends exactly the previewed bytes, once', () => {
  test('a create: one card, one POST carrying the card\'s preview, a registry entry, one approved audit row', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, sent, cards, audits } = harness()
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('published')
    expect(verdict.url).toBe(URL_)
    expect(cards).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('create')
    expect(sent[0]!.request.content).toBe(cards[0]!.previewContent)
    expect(sent[0]!.request.retentionDays).toBe(7)
    expect(cards[0]!.mode).toBe('create')
    expect(cards[0]!.scriptCount).toBe(1)
    expect(cards[0]!.externalHosts).toEqual(['cdn.example'])
    expect(cards[0]!.expiresAt).toBe('2026-10-09T00:00:00.000Z')
    expect(cards[0]!.sourceHead).toBe(PAGE)
    const entries = readArtifactRegistry(root)
    expect(entries.map(entry => [entry.id, entry.sourceSessionId, entry.sourcePath, entry.contentDigest])).toEqual([
      [ID, 'caller', 'report.html', cards[0]!.sha256],
    ])
    expect(entries[0]!.byteLength).toBe(cards[0]!.byteLength)
    expect(audits.map(record => record.decision)).toEqual(['approved'])
    // The audit row carries no content and no token-shaped value — only the facts.
    const line = formatArtifactAuditLine(audits[0]!)
    expect(line).toContain('decision: approved')
    expect(line).toContain('runtime: codex')
    expect(line).toContain('mode: bypassPermissions')
    expect(line).toContain('external hosts: cdn.example')
    expect(line).not.toContain('<h1>')
  })

  test('an approved update is ONE PUT to the registry\'s id; omitted retention is not sent and the expiry is kept', async () => {
    writeFileSync(join(cwd, 'report.md'), '# Q3\n\nnew numbers\n')
    recordArtifactPublish(root, {
      record: { id: ID, url: URL_, title: 'Q3', expiresAt: '2026-12-01T00:00:00.000Z', retentionDays: 30 },
      sourceSessionId: 'caller', sourcePath: 'report.md', contentDigest: 'f'.repeat(64), byteLength: 5, lineCount: 1,
    })
    const { ports, sent, cards } = harness()
    const verdict = await runArtifactPublish(ports, { filePath: 'report.md', url: URL_ })
    expect(verdict.status).toBe('updated')
    expect(sent.map(entry => [entry.method, entry.id])).toEqual([['update', ID]])
    expect(sent[0]!.request.retentionDays).toBeUndefined()
    expect(cards[0]!.mode).toBe('update')
    expect(cards[0]!.expiresAt).toBe('2026-12-01T00:00:00.000Z')
    expect(cards[0]!.previous).toEqual({ sha256: 'f'.repeat(64), byteLength: 5, lineCount: 1 })
    expect(readArtifactRegistry(root)[0]!.expiresAt).toBe('2026-12-01T00:00:00.000Z')
  })
})

// P-UA-i-4 — the deployed service answers create and update WITHOUT `expires_at` (measured live on
// RC4, S7-D 2026-10-10: the answer's expiry read null, the note said "It does not expire.", while the
// SAME flow's card had promised the retention's date and the service does expire the link). The app
// always sends `retention_days` on a create, so an answer without an expiry must be shown as the
// EXPECTATION — never "does not expire" while a retention governs the link.
describe('P-UA-i-4 — the service answer carries no expires_at', () => {
  test('a create shows the SENT retention as the expectation — the note and the registry never read "does not expire"', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, cards } = harness({ deployedAnswer: true })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('published')
    expect(cards[0]!.expiresAt).toBe('2026-10-09T00:00:00.000Z') // the card promised it (sent 7 days)
    expect(verdict.expiresAt).toBe('2026-10-09T00:00:00.000Z')
    expect(verdict.note).toContain('It expires on 2026-10-09T00:00:00.000Z.')
    expect(verdict.note).not.toContain('does not expire')
    expect(readArtifactRegistry(root)[0]!.expiresAt).toBe('2026-10-09T00:00:00.000Z')
  })

  test('a retention-less update falls back to the registry\'s previous expiry — not "does not expire"', async () => {
    writeFileSync(join(cwd, 'report.md'), '# Q3\n\nnew numbers\n')
    recordArtifactPublish(root, {
      record: { id: ID, url: URL_, title: 'Q3', expiresAt: '2026-12-01T00:00:00.000Z', retentionDays: 30 },
      sourceSessionId: 'caller', sourcePath: 'report.md', contentDigest: 'f'.repeat(64),
    })
    const { ports } = harness({ deployedAnswer: true })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.md', url: URL_ })
    expect(verdict.status).toBe('updated')
    expect(verdict.expiresAt).toBe('2026-12-01T00:00:00.000Z')
    expect(verdict.note).not.toContain('does not expire')
    expect(readArtifactRegistry(root)[0]!.expiresAt).toBe('2026-12-01T00:00:00.000Z')
  })

  test('control: an answer that CARRIES expires_at wins — the expectation is never invented over it', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports } = harness({ answerExpiresAt: '2026-11-01T00:00:00.000Z' })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.expiresAt).toBe('2026-11-01T00:00:00.000Z')
    expect(readArtifactRegistry(root)[0]!.expiresAt).toBe('2026-11-01T00:00:00.000Z')
  })
})

describe('negative — nothing is sent', () => {
  test('deny → no request, a refusal to the model, a denied audit row', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, sent, audits } = harness({ answers: [{ allowed: false, refusal: 'Publishing report.html was declined; nothing was sent.' }] })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict).toEqual({ status: 'denied', note: 'Publishing report.html was declined; nothing was sent.' })
    expect(sent).toEqual([])
    expect(readArtifactRegistry(root)).toEqual([])
    expect(audits.map(record => record.decision)).toEqual(['denied'])
  })

  for (const reason of ['dont-ask', 'no-interactive-client', 'automation', 'schedule', 'goal-continuation', 'subagent', 'workflow-child'] as const) {
    test(`unattended (${reason}) → refused before any card and any read, zero requests`, async () => {
      writeFileSync(join(cwd, 'report.html'), PAGE)
      const { ports, sent, cards, audits } = harness({ unattended: reason })
      const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
      expect(verdict.status).toBe('refused')
      expect(verdict.note).toContain('nothing was published and no request was made')
      expect(cards).toEqual([])
      expect(sent).toEqual([])
      expect(audits.map(record => [record.decision, record.rule])).toEqual([['refused-unattended', reason]])
    })
  }

  for (const days of [0, 31, 2.5, -1]) {
    test(`retention_days ${days} from the model → refused, no card, no request`, async () => {
      writeFileSync(join(cwd, 'report.html'), PAGE)
      const { ports, sent, cards } = harness()
      const verdict = await runArtifactPublish(ports, { filePath: 'report.html', retentionDays: days })
      expect(verdict.status).toBe('refused')
      expect(verdict.note).toContain('from 1 to 30')
      expect(cards).toEqual([])
      expect(sent).toEqual([])
    })
  }

  test('boundary: retention_days 1 and 30 are accepted and sent', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    for (const days of [1, 30]) {
      const { ports, sent } = harness()
      expect((await runArtifactPublish(ports, { filePath: 'report.html', retentionDays: days })).status).toBe('published')
      expect(sent[0]!.request.retentionDays).toBe(days)
    }
  })

  test('an id the user owns (/mine) but this workspace never published → refused, "publish a new page instead"', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, sent, cards } = harness()
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html', url: 'https://t-artifacts.t-tech.team/a/zzzzzzzzzzzzzzzzzzzzzz' })
    expect(verdict.status).toBe('refused')
    expect(verdict.note).toContain('Publish a new page instead')
    expect(cards).toEqual([])
    expect(sent).toEqual([])
    // A link on another origin is refused the same way.
    const other = await runArtifactPublish(harness().ports, { filePath: 'report.html', url: `https://claude.ai/a/${ID}` })
    expect(other.status).toBe('refused')
  })

  test('UA1.19: an entry kept only as a pending deletion (no source session), or one owed a DELETE → refused as an update target', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    // A page published outside this workspace whose DELETE failed: the registry keeps it ONLY so the deletion is
    // retried — it must not become a page a model may now overwrite.
    keepArtifactPendingDelete(root, { id: ID, url: URL_, title: 'Q3', expiresAt: null, retentionDays: 7 }, 'needs-login')
    const foreign = harness()
    expect((await runArtifactPublish(foreign.ports, { filePath: 'report.html', url: URL_ })).status).toBe('refused')
    expect(foreign.cards).toEqual([])
    expect(foreign.sent).toEqual([])
    // This workspace's own page, once the user asked to delete it, is refused the same way.
    rmSync(join(root, 'artifacts'), { recursive: true, force: true })
    recordArtifactPublish(root, {
      record: { id: ID, url: URL_, title: 'Q3', expiresAt: null, retentionDays: 7 },
      sourceSessionId: 'caller', sourcePath: 'report.html', contentDigest: 'f'.repeat(64),
    })
    keepArtifactPendingDelete(root, { id: ID, url: URL_, title: 'Q3', expiresAt: null, retentionDays: 7 }, 'network')
    const owed = harness()
    expect((await runArtifactPublish(owed.ports, { filePath: 'report.html', url: URL_ })).status).toBe('refused')
    expect(owed.sent).toEqual([])
    // Control: the same page with no deletion owed IS an update target.
    rmSync(join(root, 'artifacts'), { recursive: true, force: true })
    recordArtifactPublish(root, {
      record: { id: ID, url: URL_, title: 'Q3', expiresAt: null, retentionDays: 7 },
      sourceSessionId: 'caller', sourcePath: 'report.html', contentDigest: 'f'.repeat(64),
    })
    const live = harness()
    expect((await runArtifactPublish(live.ports, { filePath: 'report.html', url: URL_ })).status).toBe('updated')
  })

  test('a second call while a card is pending → refused with a sentence, no new card', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, sent, cards } = harness({ pending: true })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('refused')
    expect(verdict.note).toContain('already waiting')
    expect(cards).toEqual([])
    expect(sent).toEqual([])
  })

  test('the publish guard refuses before any card: a path outside the roots, a token in the page', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ua118-outside-'))
    try {
      writeFileSync(join(outside, 'x.html'), PAGE)
      const first = harness()
      expect((await runArtifactPublish(first.ports, { filePath: join(outside, 'x.html') })).status).toBe('refused')
      expect(first.cards).toEqual([])
      expect(first.audits.map(record => record.decision)).toEqual(['refused-guard'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    // An ory token, assembled at runtime so no token-shaped literal sits in this file.
    writeFileSync(join(cwd, 'leak.html'), `<p>${['ory', 'at', 'A'.repeat(24)].join('_')}</p>`)
    const second = harness()
    const verdict = await runArtifactPublish(second.ports, { filePath: 'leak.html' })
    expect(verdict.status).toBe('refused')
    expect(second.cards).toEqual([])
    expect(second.sent).toEqual([])
  })

  test('a file rewritten after the card was raised → nothing sent, a NEW card; approving that one sends the new bytes', async () => {
    const path = join(cwd, 'report.html')
    writeFileSync(path, '<p>one</p>')
    const { ports, sent, cards } = harness({
      answers: [
        () => { writeFileSync(path, '<p>two</p>'); return { allowed: true } },
        { allowed: true },
      ],
    })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('published')
    expect(cards.map(card => card.previewContent)).toEqual(['<p>one</p>', '<p>two</p>'])
    expect(sent.map(entry => entry.request.content)).toEqual(['<p>two</p>'])
  })

  test('a file that changes under BOTH cards → refused, nothing sent', async () => {
    const path = join(cwd, 'report.html')
    writeFileSync(path, '<p>one</p>')
    let n = 0
    const { ports, sent, cards } = harness({
      answers: [
        () => { writeFileSync(path, `<p>${++n}x</p>`); return { allowed: true } },
        () => { writeFileSync(path, `<p>${++n}x</p>`); return { allowed: true } },
      ],
    })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('refused')
    expect(verdict.note).toContain('changed again')
    expect(cards).toHaveLength(2)
    expect(sent).toEqual([])
  })

  test('approved but the service says needs-login → failed with the kind, nothing recorded, the audit names it', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, audits } = harness({ fail: new ArtifactClientError('needs-login', 'dp is not signed in.') })
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('failed')
    expect(verdict.note).toContain('needs-login')
    expect(readArtifactRegistry(root)).toEqual([])
    expect(audits.map(record => [record.decision, record.failure])).toEqual([['approved', 'needs-login']])
  })
})

describe('the unattended predicate (defined once; UA6.2 takes it in)', () => {
  const attended = {
    permissionMode: 'default',
    interactiveClientAttached: true,
    calledFromSubagent: false,
    isChildSession: false,
  }
  test('an attended call is null in every mode a person can answer — bypassPermissions included', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
      expect(artifactUnattendedReason({ ...attended, permissionMode: mode }), mode).toBeNull()
    }
  })
  test('each unattended fact answers its own reason', () => {
    expect(artifactUnattendedReason({ ...attended, permissionMode: 'dontAsk' })).toBe('dont-ask')
    expect(artifactUnattendedReason({ ...attended, interactiveClientAttached: false })).toBe('no-interactive-client')
    expect(artifactUnattendedReason({ ...attended, turnDispatchedBy: 'automation' })).toBe('automation')
    expect(artifactUnattendedReason({ ...attended, turnDispatchedBy: 'schedule' })).toBe('schedule')
    expect(artifactUnattendedReason({ ...attended, turnDispatchedBy: 'goal-continuation' })).toBe('goal-continuation')
    expect(artifactUnattendedReason({ ...attended, calledFromSubagent: true })).toBe('subagent')
    expect(artifactUnattendedReason({ ...attended, isChildSession: true })).toBe('workflow-child')
  })
})

describe('list_artifacts', () => {
  test('returns only the calling session\'s entries, titles decoded for reading', () => {
    recordArtifactPublish(root, {
      record: { id: ID, url: URL_, title: 'Q3 &amp; Q4', expiresAt: null, retentionDays: 0 },
      sourceSessionId: 'caller', sourcePath: 'a.html', contentDigest: 'a'.repeat(64),
    })
    recordArtifactPublish(root, {
      record: { id: 'zzzzzzzzzzzzzzzzzzzzzz', url: 'https://t-artifacts.t-tech.team/a/zzzzzzzzzzzzzzzzzzzzzz', title: 'Other', expiresAt: null, retentionDays: 0 },
      sourceSessionId: 'someone-else', sourcePath: 'b.html', contentDigest: 'b'.repeat(64),
    })
    expect(listSessionArtifactSummaries(root, 'caller')).toEqual({
      artifacts: [{ id: ID, title: 'Q3 & Q4', url: URL_, expiresAt: null }],
    })
    expect(listSessionArtifactSummaries(root, 'nobody')).toEqual({ artifacts: [] })
  })
})

describe('UA12.27 — the card names the last known dp login', () => {
  // The dp credential path resolves through NESSY_HOME live, so each arm moves
  // ONLY that variable (delete-then-assign; AGENTS.md § Traps) and seeds through
  // the real writer — never a hand-written creds file shape.
  let origNessyHome: string | undefined

  beforeEach(() => {
    origNessyHome = process.env[NESSY_HOME_ENV]
    delete process.env[NESSY_HOME_ENV]
  })

  afterEach(() => {
    delete process.env[NESSY_HOME_ENV]
    if (origNessyHome !== undefined) process.env[NESSY_HOME_ENV] = origNessyHome
  })

  test('positive: the card carries the last known dp login (cached Nessy Gateway credential), and never the token', async () => {
    process.env[NESSY_HOME_ENV] = mkdtempSync(join(tmpdir(), 'ua1227-home-'))
    const jwt = makeTestJwt({})
    saveCreds({ jwt, expiresAt: Date.now() + 600_000, username: 'ivanov.iv', userId: 'u-1' })
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, cards } = harness()
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('published')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.ownerLogin).toBe('ivanov.iv')
    expect(JSON.stringify(cards[0])).not.toContain(jwt)
  })

  test('negative: no cached dp credential — the card carries no owner login, so the generic line renders', async () => {
    process.env[NESSY_HOME_ENV] = mkdtempSync(join(tmpdir(), 'ua1227-signed-out-'))
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const { ports, cards } = harness()
    const verdict = await runArtifactPublish(ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('published')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.ownerLogin).toBeUndefined()
  })
})

// UA12.52 — a publish that lands a registry row notifies the host (`notifyArtifactChanged`, which pushes
// `artifacts:changed` to the workspace's windows), so an OPEN Published pages section reloads without its Retry
// button — the row's control: publish while the section is open → the row appears without Retry. The notify fires
// only when the REGISTRY write succeeded: never on a refusal, a deny or a failed send.
describe('UA12.52 — a successful publish notifies the host for the artifacts:changed push', () => {
  test('a create and an approved update each notify exactly once; a declined card never does', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const created = harness()
    const verdict = await runArtifactPublish(created.ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('published')
    expect(created.notified()).toBe(1)

    writeFileSync(join(cwd, 'report.md'), '# Q3\n\nnew numbers\n')
    recordArtifactPublish(root, {
      record: { id: ID, url: URL_, title: 'Q3', expiresAt: '2026-12-01T00:00:00.000Z', retentionDays: 30 },
      sourceSessionId: 'caller', sourcePath: 'report.md', contentDigest: 'f'.repeat(64), byteLength: 5, lineCount: 1,
    })
    const updated = harness()
    const update = await runArtifactPublish(updated.ports, { filePath: 'report.md', url: URL_ })
    expect(update.status).toBe('updated')
    expect(updated.notified()).toBe(1)

    const declined = harness({ answers: [{ allowed: false }] })
    const denied = await runArtifactPublish(declined.ports, { filePath: 'report.html' })
    expect(denied.status).toBe('denied')
    expect(declined.notified()).toBe(0)
  })

  test('a failed send notifies nothing — the registry row never appeared', async () => {
    writeFileSync(join(cwd, 'report.html'), PAGE)
    const failed = harness({ fail: new ArtifactClientError('server', 'The artifact service failed.', 500) })
    const verdict = await runArtifactPublish(failed.ports, { filePath: 'report.html' })
    expect(verdict.status).toBe('failed')
    expect(failed.notified()).toBe(0)
  })
})
