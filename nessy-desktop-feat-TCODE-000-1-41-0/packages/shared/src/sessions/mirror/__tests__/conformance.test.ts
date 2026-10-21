/**
 * The portable conformance suite must (a) bite — a deliberately broken adapter
 * fails it — and (b) pass on both shipped adapters. Written by us from the
 * documented contract (agent-sdk/session-storage.md); Claude's example suite is
 * NOT vendored (licence unchecked — doc-verification § R6 fact 8). The key
 * shape is parameterized (fact 13): the suite builds keys only through the
 * caller's factory.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { runSessionMirrorConformance } from '../conformance.ts'
import { DirectorySessionMirrorStore } from '../directory.ts'
import { InMemorySessionMirrorStore } from '../in-memory.ts'
import type { MirrorSessionKey, SessionMirrorEntry, SessionMirrorStore } from '../types.ts'

function makeKey(sessionId: string, subpath?: string): MirrorSessionKey {
  return { workspaceId: 'ws-conformance', sessionId, ...(subpath === undefined ? {} : { subpath }) }
}

/** Drops every second entry — a store that loses data must not pass. */
class EntryDroppingStore implements SessionMirrorStore {
  private readonly inner = new InMemorySessionMirrorStore()

  async append(key: MirrorSessionKey, entries: SessionMirrorEntry[]): Promise<void> {
    await this.inner.append(key, entries.filter((_, index) => index % 2 === 0))
  }

  async load(key: MirrorSessionKey): Promise<SessionMirrorEntry[] | null> {
    return this.inner.load(key)
  }
}

describe('runSessionMirrorConformance', () => {
  it('bites: an adapter that drops entries fails the suite', async () => {
    await expect(runSessionMirrorConformance({
      createStore: () => new EntryDroppingStore(),
      makeKey,
      listScope: 'ws-conformance',
    })).rejects.toThrow(/conformance/)
  })

  it('passes on the InMemory store, exercising the optional methods', async () => {
    await runSessionMirrorConformance({
      createStore: () => new InMemorySessionMirrorStore(),
      makeKey,
      listScope: 'ws-conformance',
    })
  })

  it('passes on the directory adapter', async () => {
    await runSessionMirrorConformance({
      createStore: () => new DirectorySessionMirrorStore({
        root: mkdtempSync(join(tmpdir(), 'nessy-mirror-conformance-')),
      }),
      makeKey,
      listScope: 'ws-conformance',
    })
  })

  it('skips optional-method checks for a minimal two-method adapter', async () => {
    class MinimalStore implements SessionMirrorStore {
      private readonly inner = new InMemorySessionMirrorStore()
      append(key: MirrorSessionKey, entries: SessionMirrorEntry[]): Promise<void> {
        return this.inner.append(key, entries)
      }
      load(key: MirrorSessionKey): Promise<SessionMirrorEntry[] | null> {
        return this.inner.load(key)
      }
    }
    await runSessionMirrorConformance({
      createStore: () => new MinimalStore(),
      makeKey,
      listScope: 'ws-conformance',
    })
  })
})
