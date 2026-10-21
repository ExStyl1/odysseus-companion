/**
 * Portable conformance suite for `SessionMirrorStore` adapters, written from
 * the documented contract (code.claude.com/docs/en/agent-sdk/session-storage.md)
 * — Claude's example suite is NOT vendored (licence unchecked,
 * doc-verification § R6 fact 8).
 *
 * Framework-agnostic: `runSessionMirrorConformance` throws on the first
 * violation with a `mirror conformance:` message, so any test runner can host
 * it. Checks for optional methods skip automatically when the adapter does not
 * implement them, matching the documented suites. The key shape is
 * PARAMETERIZED (fact 13): keys are built exclusively through the caller's
 * `makeKey`, so an adapter bound to a different projectKey encoding (Claude's
 * cwd encoding, our workspace id) runs the same suite.
 */
import { deepStrictEqual } from 'assert'

import type { MirrorSessionKey, SessionMirrorEntry, SessionMirrorStore } from './types.ts'

export interface MirrorConformanceOptions {
  /** A FRESH, isolated store per run. */
  createStore: () => SessionMirrorStore | Promise<SessionMirrorStore>
  /** Key factory — the suite never assumes a key shape beyond `subpath` semantics. */
  makeKey: (sessionId: string, subpath?: string) => MirrorSessionKey
  /** The scope value the adapter's listSessions/listSessionSummaries take. */
  listScope: string
}

function fail(check: string, detail: string): never {
  throw new Error(`mirror conformance: ${check} — ${detail}`)
}

function assertDeepEqual(check: string, actual: unknown, expected: unknown): void {
  try {
    deepStrictEqual(actual, expected)
  } catch (error) {
    fail(check, error instanceof Error ? error.message : String(error))
  }
}

function entry(uuid: string, extra: Record<string, unknown> = {}): SessionMirrorEntry {
  return { uuid, type: 'message', ...extra }
}

export async function runSessionMirrorConformance(options: MirrorConformanceOptions): Promise<void> {
  const { makeKey, listScope } = options
  const store = await options.createStore()

  // load: "Return null if the session is unknown."
  if (await store.load(makeKey('unknown-session')) !== null) {
    fail('load(unknown)', 'expected null for a session the store has never seen')
  }

  // append/load: entries persist in order and return deep-equal (byte-equal
  // serialization is NOT required; jsonb-style key reordering is fine).
  const mainKey = makeKey('session-a')
  const first = [
    entry('a-1', { nested: { deep: [1, 2, { three: 3 }] }, text: 'first' }),
    entry('a-2', { text: 'second' }),
  ]
  await store.append(mainKey, first)
  assertDeepEqual('append/load round-trip', await store.load(mainKey), first)

  // uuid dedup: "Because a retried batch can re-deliver entries that already
  // landed, deduplicate by entry.uuid in your append() implementation."
  await store.append(mainKey, [entry('a-2', { text: 'second' }), entry('a-3', { text: 'third' })])
  assertDeepEqual(
    'uuid dedup on re-delivered batch',
    await store.load(mainKey),
    [...first, entry('a-3', { text: 'third' })],
  )

  // subpath: an absent subpath is the main transcript; a subpath addresses a
  // separate transcript that must not leak into the main one.
  const subKey = makeKey('session-a', 'subagents/agent-1')
  const subEntries = [entry('sub-1', { text: 'subagent line' })]
  await store.append(subKey, subEntries)
  assertDeepEqual('subpath transcript isolation (subpath load)', await store.load(subKey), subEntries)
  assertDeepEqual(
    'subpath transcript isolation (main load unchanged)',
    await store.load(mainKey),
    [...first, entry('a-3', { text: 'third' })],
  )

  // Optional listSubkeys: resume uses it to discover subagent transcripts.
  if (store.listSubkeys) {
    const subkeys = await store.listSubkeys(makeKey('session-a'))
    if (!subkeys.includes('subagents/agent-1')) {
      fail('listSubkeys', `expected 'subagents/agent-1' in ${JSON.stringify(subkeys)}`)
    }
  }

  // Optional listSessionSummaries: maintained inside append, main batches only.
  if (store.listSessionSummaries) {
    const summaries = await store.listSessionSummaries(listScope)
    const summary = summaries.find(candidate => candidate.sessionId === mainKey.sessionId)
    if (!summary) {
      fail('listSessionSummaries', `no summary for ${mainKey.sessionId} in ${JSON.stringify(summaries)}`)
    }
    if (typeof summary.mtime !== 'number' || summary.mtime <= 0) {
      fail('listSessionSummaries mtime', `expected a persist-time stamp, got ${String(summary.mtime)}`)
    }
    if (!summary.data || typeof summary.data !== 'object') {
      fail('listSessionSummaries data', 'expected an object data payload')
    }
  }

  // Optional listSessions: sessionId + numeric mtime per known session.
  if (store.listSessions) {
    const sessions = await store.listSessions(listScope)
    const listed = sessions.find(candidate => candidate.sessionId === mainKey.sessionId)
    if (!listed) fail('listSessions', `session ${mainKey.sessionId} missing from ${JSON.stringify(sessions)}`)
    if (typeof listed.mtime !== 'number') fail('listSessions mtime', 'expected a numeric mtime')
  }

  // Optional delete: a main-key delete "must cascade to all subkeys for that
  // session and also remove the session's summary entry".
  if (store.delete) {
    await store.delete(makeKey('session-a'))
    if (await store.load(mainKey) !== null) fail('delete cascade', 'main transcript survived delete')
    if (await store.load(subKey) !== null) fail('delete cascade', 'subkey transcript survived main-key delete')
    if (store.listSessionSummaries) {
      const summaries = await store.listSessionSummaries(listScope)
      if (summaries.some(candidate => candidate.sessionId === mainKey.sessionId)) {
        fail('delete cascade', 'summary entry survived main-key delete')
      }
    }
  }
}
