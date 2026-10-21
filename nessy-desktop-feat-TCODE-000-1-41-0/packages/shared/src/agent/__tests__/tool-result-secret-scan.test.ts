import { describe, expect, it } from 'bun:test'

import {
  buildSecretNotice,
  COARSE_ONLY_TOKEN_PREFIXES,
  scanToolResultForSecrets,
  scrubToolResultPayload,
  TOOL_RESULT_SECRET_RULES,
  TOOL_RESULT_SECRET_RULE_NAMES,
  TOOL_RESULT_SECRET_TOKEN_PREFIXES,
} from '../tool-result-secret-scan.ts'
// Static, not `await import` inside the test: the Pi adapter's module graph
// costs seconds to load and a dynamic import spends them against the 5 s
// per-test timer, which reads as a failure and is a load cost (measured
// 2026-09-08: two Pi cases timed out at 5 s dynamic, both green static).
import { PiEventAdapter } from '../backend/pi/event-adapter.ts'

// Synthetic values only: every literal below is a prefix plus filler that has
// never been issued by anybody. Never put a real credential in a fixture.
const FAKE_GITLAB_PAT = 'glpat-AAAAAAAAAAAAAAAAAAAA'
const FAKE_GITLAB_RUNNER = 'glrt-BBBBBBBBBBBBBBBBBBBB'
const FAKE_GITHUB_PAT = 'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
const FAKE_AWS = 'AKIAQQQQQQQQQQQQQQQQ'

describe('scanToolResultForSecrets', () => {
  // POSITIVE — the row's own first additions, GitLab's two, plus the marker and
  // the count-only notice.
  it('redacts a credential-shaped value, names the rule, and never echoes the match', () => {
    const scan = scanToolResultForSecrets(
      `remote configured\ntoken=${FAKE_GITLAB_PAT}\nrunner=${FAKE_GITLAB_RUNNER}\ndone`,
    )

    expect(scan.text).toContain('[REDACTED:gitlab-pat]')
    expect(scan.text).toContain('[REDACTED:gitlab-runner-authentication-token]')
    // The match itself is gone from the text, from the notice, and from the counts.
    expect(scan.text).not.toContain(FAKE_GITLAB_PAT)
    expect(scan.text).not.toContain(FAKE_GITLAB_RUNNER)
    expect(scan.notice).toBeDefined()
    expect(scan.notice).not.toContain(FAKE_GITLAB_PAT)
    expect(scan.notice).not.toContain('AAAAAAAA')
    expect(JSON.stringify(scan.counts)).not.toContain('AAAAAAAA')
    // Everything that was not a credential survives byte-for-byte.
    expect(scan.text.startsWith('remote configured\n')).toBe(true)
    expect(scan.text.endsWith('\ndone')).toBe(true)
    expect(scan.counts).toEqual([
      { rule: 'gitlab-pat', count: 1 },
      { rule: 'gitlab-runner-authentication-token', count: 1 },
    ])
  })

  // NEGATIVE / BOUNDARY — ordinary output must come back IDENTICAL, and the
  // notice must be absent rather than empty, or every clean result grows a line.
  it('leaves ordinary tool output byte-identical and raises no notice', () => {
    const output = [
      'src/index.ts',
      'const sk = 1 // sk- is not a token, and neither is ghp_',
      'AKIA is a prefix on its own line',
      'Bearer with no value',
      '',
    ].join('\n')

    const scan = scanToolResultForSecrets(output)

    expect(scan.text).toBe(output)
    expect(scan.counts).toEqual([])
    expect(scan.notice).toBeUndefined()
  })

  it('counts every occurrence of one rule and is not confused by its own marker', () => {
    const scan = scanToolResultForSecrets(
      `${FAKE_GITHUB_PAT} ${FAKE_GITHUB_PAT} ${FAKE_AWS}`,
    )

    expect(scan.counts).toEqual([
      { rule: 'github-pat', count: 2 },
      { rule: 'aws-access-token', count: 1 },
    ])
    // A second pass over the already-redacted text finds nothing: the marker
    // carries no token prefix, so the scan is idempotent.
    expect(scanToolResultForSecrets(scan.text).counts).toEqual([])
  })

  it('is not stateful across calls — a `g` regex carries lastIndex and this must not', () => {
    const input = `a ${FAKE_GITLAB_PAT} b`
    const first = scanToolResultForSecrets(input)
    const second = scanToolResultForSecrets(input)

    expect(second.text).toBe(first.text)
    expect(second.counts).toEqual(first.counts)
  })

  it('reports the more specific rule when two prefixes nest', () => {
    const admin = 'sk-ant-admin01-DDDDDDDDDDDDDDDDDDDD'
    const scan = scanToolResultForSecrets(admin)

    expect(scan.counts).toEqual([{ rule: 'anthropic-admin-api-key', count: 1 }])
    expect(scan.text).toBe('[REDACTED:anthropic-admin-api-key]')
  })

  it('returns an empty input unchanged without building a notice', () => {
    expect(scanToolResultForSecrets('')).toEqual({ text: '', counts: [] })
  })
})

describe('the rule table itself', () => {
  it('has unique names and a global pattern on every rule', () => {
    expect(new Set(TOOL_RESULT_SECRET_RULE_NAMES).size).toBe(TOOL_RESULT_SECRET_RULE_NAMES.length)
    for (const rule of TOOL_RESULT_SECRET_RULES) {
      expect(rule.pattern.flags).toContain('g')
    }
  })

  // The coarse list and the precise table are allowed to differ in exactly one
  // direction, and the difference is named rather than discovered. Asserted
  // BEHAVIOURALLY — a text search over `pattern.source` would call `ghu_`
  // missing because the table spells it `gh[us]_`.
  it('recognises every coarse prefix except the ones declared coarse-only', () => {
    const filler = 'A'.repeat(24)
    for (const prefix of TOOL_RESULT_SECRET_TOKEN_PREFIXES) {
      const redacted = scanToolResultForSecrets(`${prefix}${filler}`).counts.length > 0
      expect({ prefix, redacted })
        .toEqual({ prefix, redacted: !COARSE_ONLY_TOKEN_PREFIXES.includes(prefix) })
    }
  })

  it('keeps the coarse-only list non-empty and genuinely coarse-only', () => {
    // A positive control on the claim above: if someone adds a bare `sk-` rule
    // to the table, this goes red rather than the difference quietly closing.
    expect(COARSE_ONLY_TOKEN_PREFIXES.length).toBeGreaterThan(0)
    for (const prefix of COARSE_ONLY_TOKEN_PREFIXES) {
      expect(TOOL_RESULT_SECRET_TOKEN_PREFIXES).toContain(prefix)
    }
  })
})

describe('buildSecretNotice', () => {
  it('is count-only and reads as one sentence', () => {
    expect(buildSecretNotice([{ rule: 'gitlab-pat', count: 1 }]))
      .toBe('[nessy] 1 credential-shaped value redacted from this tool result (gitlab-pat×1). The values were not shown to the model.')
    expect(buildSecretNotice([{ rule: 'gitlab-pat', count: 2 }, { rule: 'github-pat', count: 1 }]))
      .toContain('3 credential-shaped values redacted')
  })
})

/**
 * P6.574 — the CLAUDE arm, where the scanner is wired rather than where it is
 * defined.
 *
 * It lives beside the scanner because the row is about the three arms being the
 * same: Pi's is pinned in `pi-agent-server`, codex's in
 * `codex-event-adapter.test.ts`, and this one closes the set. Until all three
 * landed, whether a credential reached the model depended on which runtime the
 * user happened to pick — a divergence the host manufactured, not one any
 * runtime asked for.
 */
describe('ClaudeEventAdapter — tool results are scanned for secrets', () => {
  async function claudeToolResult(output: string): Promise<string> {
    const { ClaudeEventAdapter } = await import('../backend/claude/event-adapter.ts')
    const adapter = new ClaudeEventAdapter({
      onDebug: undefined,
      mapSDKError: async () => ({
        type: 'typed_error' as const,
        error: {
          code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false,
        },
      }),
    } as never)
    adapter.startTurn()
    await adapter.adapt({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'bash-scan', name: 'Bash', input: { command: 'cat .env' } }],
        usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: 'sess-scan',
      isReplay: false,
    } as never)
    const events = await adapter.adapt({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'bash-scan', content: output }] },
      parent_tool_use_id: null,
      session_id: 'sess-scan',
      isReplay: false,
    } as never)
    const result = events.find(event => event.type === 'tool_result') as { result?: string } | undefined
    if (!result) throw new Error('the adapter produced no tool_result')
    return result.result ?? ''
  }

  it('redacts a credential-shaped value before the model turn, count-only', async () => {
    const text = await claudeToolResult(`GITLAB_TOKEN=${FAKE_GITLAB_PAT}\n`)

    expect(text).not.toContain(FAKE_GITLAB_PAT)
    expect(text).toContain('[REDACTED:gitlab-pat]')
    expect(text).toContain('gitlab-pat×1')
  })

  it('leaves an ordinary result exactly as it was', async () => {
    const clean = 'file1.txt\nfile2.txt'

    expect(await claudeToolResult(clean)).toBe(clean)
  })
})

/**
 * P6.753 — the MACHINE payload, on every arm that has one.
 *
 * P6.574 scanned the text and stated `structuredContent` as a known exclusion.
 * The exclusion was the residue: an MCP tool's own record rides the same
 * `tool_result` event and is persisted with the session, so a credential that
 * arrives only there was carried in full on codex and on Pi.
 */
describe('scrubToolResultPayload — the record beside the text (P6.753)', () => {
  it('redacts a string leaf however deeply it is nested, and keeps the shape', () => {
    const scrubbed = scrubToolResultPayload('nothing to see here', {
      status: 'ok',
      attempts: 3,
      enabled: true,
      missing: null,
      credentials: { primary: `Bearer ${FAKE_GITLAB_PAT}` },
      history: ['clean', { note: `runner=${FAKE_GITLAB_RUNNER}` }],
    })

    const record = scrubbed.structuredContent as Record<string, unknown>
    const credentials = record.credentials as Record<string, unknown>
    const history = record.history as unknown[]
    const historyEntry = history[1] as Record<string, unknown>

    // The bytes are gone and the rule is named where they were.
    expect(credentials.primary).toBe('Bearer [REDACTED:gitlab-pat]')
    expect(historyEntry.note).toBe('runner=[REDACTED:gitlab-runner-authentication-token]')
    // Every non-string leaf, every key and the array's length survive exactly.
    expect(record.status).toBe('ok')
    expect(record.attempts).toBe(3)
    expect(record.enabled).toBe(true)
    expect(record.missing).toBe(null)
    expect(Object.keys(record)).toEqual([
      'status', 'attempts', 'enabled', 'missing', 'credentials', 'history',
    ])
    expect(history.length).toBe(2)
    expect(history[0]).toBe('clean')
  })

  it('appends ONE notice for both halves, count-only, on the text', () => {
    const scrubbed = scrubToolResultPayload(
      `text token ${FAKE_GITLAB_PAT}`,
      { record: { token: FAKE_GITLAB_PAT }, other: FAKE_GITHUB_PAT },
    )

    // Three matches across two halves, one sentence, no bytes.
    expect(scrubbed.text).toContain('3 credential-shaped values redacted')
    expect(scrubbed.text).toContain('gitlab-pat×2')
    expect(scrubbed.text).toContain('github-pat×1')
    expect(scrubbed.text.match(/\[nessy\]/g)?.length).toBe(1)
    expect(scrubbed.text).not.toContain(FAKE_GITLAB_PAT)
    expect(JSON.stringify(scrubbed.structuredContent)).not.toContain(FAKE_GITHUB_PAT)
  })

  it('returns BOTH halves by identity when nothing fires', () => {
    const text = 'file1\nfile2'
    const record = { rows: [{ id: 1, name: 'clean' }], total: 1 }

    const scrubbed = scrubToolResultPayload(text, record)

    // Reference identity, not deep equality: a clean turn must be the very
    // objects that went in — not re-keyed, not re-serialised.
    expect(scrubbed.text).toBe(text)
    expect(scrubbed.structuredContent).toBe(record)
  })

  it('leaves the record absent when the caller had none', () => {
    expect(scrubToolResultPayload('clean')).toEqual({ text: 'clean' })
    expect(Object.hasOwn(scrubToolResultPayload('clean'), 'structuredContent')).toBe(false)
  })
})

/**
 * The PI arm — and it is the only scan Pi has for either payload here.
 *
 * `createPiToolResultTransformer` runs in the subprocess and is wired on
 * `createToolExecutor`, the LOCAL tool path; an MCP result reaches Pi through
 * the SDK's own client and never meets it. Both payloads cross this adapter.
 */
describe('PiEventAdapter — tool results are scanned for secrets (P6.753)', () => {
  function piToolResult(
    result: unknown,
  ): { result?: string; structuredContent?: Record<string, unknown> } {
    const adapter = new PiEventAdapter()
    adapter.startTurn()
    const events = [...adapter.adaptEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-scan',
      isError: false,
      result,
    } as never)]
    const event = events.find(entry => entry.type === 'tool_result')
    if (!event) throw new Error('the adapter produced no tool_result')
    return event as { result?: string; structuredContent?: Record<string, unknown> }
  }

  it('redacts a credential that arrives ONLY in the structured payload', () => {
    const event = piToolResult({
      content: [{ type: 'text', text: 'issue fetched' }],
      details: { structuredContent: { auth: { header: `token ${FAKE_GITLAB_PAT}` } } },
    })

    const auth = (event.structuredContent as { auth: { header: string } }).auth
    expect(auth.header).toBe('token [REDACTED:gitlab-pat]')
    // The notice is on the text, count-only, and the text itself was clean.
    expect(event.result).toContain('gitlab-pat×1')
    expect(event.result).not.toContain(FAKE_GITLAB_PAT)
  })

  it('leaves an ordinary result byte-identical — no notice, no marker', () => {
    const event = piToolResult({
      content: [{ type: 'text', text: 'issue fetched' }],
      details: { structuredContent: { issue: 'ISSUE-1' } },
    })

    expect(event.result).toBe('issue fetched')
    expect(event.structuredContent).toEqual({ issue: 'ISSUE-1' })
  })
})

/**
 * The CLAUDE arm needs no structured scan, and the absence is MEASURED.
 *
 * `extractToolResults` builds every claude `tool_result` event by hand and sets
 * no `structuredContent` on either of its branches, so a claude result has no
 * machine payload for a credential to hide in. Pinned here so the day the SDK
 * starts reporting one, this goes red instead of the comment quietly becoming
 * false.
 */
describe('ClaudeEventAdapter — there is no structured payload to scan (P6.753)', () => {
  it('emits a tool_result with no structuredContent at all', async () => {
    const { extractToolResults } = await import('../tool-matching.ts')
    const events = extractToolResults(
      [{ type: 'tool_result', tool_use_id: 'bash-scan', content: 'file1' }] as never,
      null,
      undefined,
      { getEntry: () => undefined } as never,
      'turn-1',
    )

    const result = events.find(event => event.type === 'tool_result')
    expect(result).toBeDefined()
    expect(Object.hasOwn(result as object, 'structuredContent')).toBe(false)
  })
})
