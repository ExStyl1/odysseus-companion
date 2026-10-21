import { describe, test, expect } from 'bun:test'
import { getAllChannelValues, RPC_CHANNELS, TRANSPORT_INTERNAL_CHANNELS } from '../channels'
import { channelLocality, LOCAL_ONLY_CHANNELS, REMOTE_ELIGIBLE_CHANNELS } from '../routing'

describe('channel routing exhaustiveness', () => {
  const all = getAllChannelValues()

  test('every channel is classified exactly once', () => {
    for (const ch of all) {
      const inLocal = LOCAL_ONLY_CHANNELS.has(ch)
      const inRemote = REMOTE_ELIGIBLE_CHANNELS.has(ch)

      if (!inLocal && !inRemote) {
        throw new Error(`Channel "${ch}" is not classified in LOCAL_ONLY or REMOTE_ELIGIBLE. Add it to one set in routing.ts.`)
      }
      if (inLocal && inRemote) {
        throw new Error(`Channel "${ch}" is in BOTH LOCAL_ONLY and REMOTE_ELIGIBLE. It must be in exactly one.`)
      }
    }
  })

  test('no extra channels in LOCAL_ONLY', () => {
    for (const ch of LOCAL_ONLY_CHANNELS) {
      expect(all).toContain(ch)
    }
  })

  test('no extra channels in REMOTE_ELIGIBLE', () => {
    for (const ch of REMOTE_ELIGIBLE_CHANNELS) {
      expect(all).toContain(ch)
    }
  })

  test('sets are non-empty', () => {
    expect(LOCAL_ONLY_CHANNELS.size).toBeGreaterThan(0)
    expect(REMOTE_ELIGIBLE_CHANNELS.size).toBeGreaterThan(0)
  })

  test('total classified equals total channels', () => {
    expect(LOCAL_ONLY_CHANNELS.size + REMOTE_ELIGIBLE_CHANNELS.size).toBe(all.length)
  })
})

describe('channel routing behavior', () => {
  test('LOCAL_ONLY and REMOTE_ELIGIBLE have zero intersection', () => {
    const intersection: string[] = []
    for (const ch of LOCAL_ONLY_CHANNELS) {
      if (REMOTE_ELIGIBLE_CHANNELS.has(ch)) {
        intersection.push(ch)
      }
    }
    expect(intersection).toEqual([])
  })

  test('all server:* channels are REMOTE_ELIGIBLE', () => {
    const serverChannels = Object.values(RPC_CHANNELS.server)
    expect(serverChannels.length).toBeGreaterThan(0)

    for (const ch of serverChannels) {
      expect(REMOTE_ELIGIBLE_CHANNELS.has(ch)).toBe(true)
    }
  })

  test('no LOCAL_ONLY channel starts with server:', () => {
    for (const ch of LOCAL_ONLY_CHANNELS) {
      if (ch.startsWith('server:')) {
        throw new Error(`server:* channel "${ch}" must be REMOTE_ELIGIBLE, not LOCAL_ONLY`)
      }
    }
  })

  // P2.282. The two `workspace:importClaude*` channels shipped in NEITHER set,
  // and because routing was fail-open at the time (P2.296 closed that; see
  // routing.ts's header) they crossed to the workspace server with no decision
  // behind it — silently, and correctly only by luck. The global exhaustiveness
  // count above does catch that — but only as an off-by-two on a total of 350,
  // which says nothing about which side the channel belonged on. These two
  // guards are namespace-scoped, so they name the intent instead of a number,
  // and they mirror the `server:*` pair directly above.
  //
  // The distinction they pin is real and easy to miss by one letter:
  //   `workspace:*`  = content/config OF a workspace, owned by whichever server
  //                    runs it -> REMOTE_ELIGIBLE
  //   `workspaces:*` = the local app's registry of workspaces -> LOCAL_ONLY
  test('every workspace:* channel is REMOTE_ELIGIBLE', () => {
    const channels = Object.values(RPC_CHANNELS.workspace)
    expect(channels.length).toBeGreaterThan(0)

    for (const ch of channels) {
      if (!REMOTE_ELIGIBLE_CHANNELS.has(ch)) {
        throw new Error(
          `workspace:* channel "${ch}" is not REMOTE_ELIGIBLE. A workspace:* channel acts on `
          + 'the content of a workspace, which lives on whichever server owns it. If this one '
          + "genuinely needs the client's own machine (a native dialog, a client-supplied path), "
          + 'it belongs in a local namespace like `workspaces:*` or `dialog:*` — move it there '
          + 'rather than making this an exception.',
        )
      }
    }
  })

  test('every workspaces:* channel is LOCAL_ONLY', () => {
    const channels = Object.values(RPC_CHANNELS.workspaces)
    expect(channels.length).toBeGreaterThan(0)

    for (const ch of channels) {
      if (!LOCAL_ONLY_CHANNELS.has(ch)) {
        throw new Error(
          `workspaces:* channel "${ch}" is not LOCAL_ONLY. The workspace registry is local app `
          + 'config — the list of workspaces this install knows about, including remote ones.',
        )
      }
    }
  })
})

// P2.296. Before this, `RoutedClient` consulted `isLocalOnly()` alone, so
// "not local" and "may leave this machine" were one predicate: the complement
// of LOCAL_ONLY crossed, unclassified channels included, and REMOTE_ELIGIBLE
// had zero production readers. These tests pin the property that replaced it —
// crossing requires membership, and the absence of a decision is its own
// answer rather than the permissive one.
describe('channelLocality — the single routing decision', () => {
  test('every LOCAL_ONLY channel resolves to local', () => {
    expect(LOCAL_ONLY_CHANNELS.size).toBeGreaterThan(0)
    for (const ch of LOCAL_ONLY_CHANNELS) {
      expect(channelLocality(ch)).toBe('local')
    }
  })

  test('every REMOTE_ELIGIBLE channel resolves to workspace', () => {
    expect(REMOTE_ELIGIBLE_CHANNELS.size).toBeGreaterThan(0)
    for (const ch of REMOTE_ELIGIBLE_CHANNELS) {
      expect(channelLocality(ch)).toBe('workspace')
    }
  })

  // The load-bearing assertion. A channel that is in neither set must NOT
  // inherit 'workspace' — that inheritance was the defect.
  test('a channel in neither set is unclassified, not workspace', () => {
    const unlisted = 'invented:channelThatWasNeverClassified'
    expect(LOCAL_ONLY_CHANNELS.has(unlisted)).toBe(false)
    expect(REMOTE_ELIGIBLE_CHANNELS.has(unlisted)).toBe(false)
    expect(channelLocality(unlisted)).toBe('unclassified')
  })

  // Same shape, but using a string that looks like it belongs: a plausible new
  // member of an existing REMOTE_ELIGIBLE namespace. Namespace prefix must buy
  // a channel nothing.
  test('a plausible sibling of a crossing channel does not inherit its locality', () => {
    expect(channelLocality(RPC_CHANNELS.sessions.GET)).toBe('workspace')
    expect(channelLocality('sessions:getSomethingNobodyClassified')).toBe('unclassified')
  })

  // Found while reviewing the fix, before it shipped. The transport-internal
  // lookup was an object index, and `TRANSPORT_INTERNAL_LOCALITY['constructor']`
  // resolves off the prototype chain to a FUNCTION — not `'unclassified'`, so
  // the fallback never fires and RoutedClient routes the call onward. That is
  // the fail-open this function exists to close, reachable with exactly the
  // strings someone probing the boundary would reach for first.
  test('inherited Object properties are unclassified, not routable', () => {
    for (const ch of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(channelLocality(ch)).toBe('unclassified')
    }
  })

  test('transport-internal pseudo-channels are classified explicitly', () => {
    const reconnected = TRANSPORT_INTERNAL_CHANNELS.RECONNECTED

    // It routes, so it needed a decision...
    expect(channelLocality(reconnected)).toBe('workspace')

    // ...but it is not an RPC channel, so it must stay out of both RPC sets and
    // out of the exhaustiveness denominator, or the totals stop balancing.
    expect(LOCAL_ONLY_CHANNELS.has(reconnected)).toBe(false)
    expect(REMOTE_ELIGIBLE_CHANNELS.has(reconnected)).toBe(false)
    expect(getAllChannelValues()).not.toContain(reconnected)
  })
})
