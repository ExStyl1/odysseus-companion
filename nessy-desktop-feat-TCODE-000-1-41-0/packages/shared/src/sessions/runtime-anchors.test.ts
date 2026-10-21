import { describe, expect, it } from 'bun:test'
import type { AgentProvider } from '../agent/backend/types.ts'
import {
  ANCHORED_PROVIDERS,
  RUNTIME_ANCHOR_SUPPORT,
  migrateLegacyAnchor,
  readAgentResumeAnchor,
  readRuntimeAnchor,
  writeRuntimeAnchor,
} from './runtime-anchors.ts'

describe('runtime anchors', () => {
  it('reads nothing from an empty map', () => {
    expect(readRuntimeAnchor(undefined, 'pi')).toBeUndefined()
  })

  it('keeps one anchor per provider', () => {
    let anchors = writeRuntimeAnchor(undefined, 'pi', 'pi-123')
    anchors = writeRuntimeAnchor(anchors, 'anthropic', 'claude-abc')
    expect(readRuntimeAnchor(anchors, 'pi')).toBe('pi-123')
    expect(readRuntimeAnchor(anchors, 'anthropic')).toBe('claude-abc')
  })

  it('clears one provider without disturbing the others', () => {
    const anchors = writeRuntimeAnchor(writeRuntimeAnchor(undefined, 'pi', 'pi-123'), 'anthropic', 'claude-abc')
    const cleared = writeRuntimeAnchor(anchors, 'anthropic', undefined)
    expect(readRuntimeAnchor(cleared, 'anthropic')).toBeUndefined()
    expect(readRuntimeAnchor(cleared, 'pi')).toBe('pi-123')
  })

  it('adopts a legacy sdkSessionId for the session\'s current provider', () => {
    expect(readRuntimeAnchor(migrateLegacyAnchor(undefined, 'pi-legacy', 'pi'), 'pi')).toBe('pi-legacy')
  })

  it('never lets a legacy id overwrite an anchor already recorded for that provider', () => {
    const anchors = writeRuntimeAnchor(undefined, 'pi', 'pi-current')
    expect(readRuntimeAnchor(migrateLegacyAnchor(anchors, 'pi-legacy', 'pi'), 'pi')).toBe('pi-current')
  })

  it('never records an anchor for the remote provider', () => {
    expect(writeRuntimeAnchor(undefined, 'nestor-cloud-agent', 'x')).toEqual({})
  })

  // Audit correction A5: `BaseAgent.getSessionId()` returns the NESSY session id
  // and `CodexAgent` does not override it, so the SessionManager fallback writes
  // that id into the legacy `sdkSessionId` slot after the first Codex turn.
  // Anchoring Codex would migrate that garbage into the map and let a
  // Codex→Codex change claim "history preserved" while the runtime starts on a
  // brand-new thread in a fresh mkdtemp CODEX_HOME. This pins the decision so a
  // later editor cannot quietly add `codex-runtime` to ANCHORED_PROVIDERS.
  it('never records or adopts an anchor for codex-runtime', () => {
    expect(writeRuntimeAnchor(undefined, 'codex-runtime', 'nessy-session-id')).toEqual({})
    expect(migrateLegacyAnchor(undefined, 'nessy-session-id', 'codex-runtime')).toEqual({})
    expect(readRuntimeAnchor({ 'codex-runtime': 'nessy-session-id' }, 'codex-runtime')).toBeUndefined()
  })

  // F1.1235 — a relaunched codex chat must reach its own thread. Codex is out of
  // the map (above), so the id it published lives only in the legacy slot, and
  // the agent-build read takes it from there; the anchored runtimes still read
  // their map entry and nothing else.
  it('hands a new codex agent the thread id its own legacy slot holds, and no other runtime that slot', () => {
    expect(readAgentResumeAnchor({}, 'codex-thread-1', 'codex-runtime')).toBe('codex-thread-1')
    expect(readAgentResumeAnchor(undefined, 'codex-thread-1', 'codex-runtime')).toBe('codex-thread-1')
    // A fresh codex session has nothing to resume, and the switch planner's
    // read is untouched: codex still has no anchor in the map.
    expect(readAgentResumeAnchor({}, undefined, 'codex-runtime')).toBeUndefined()
    expect(readAgentResumeAnchor({}, '', 'codex-runtime')).toBeUndefined()
    expect(readRuntimeAnchor({}, 'codex-runtime')).toBeUndefined()
    // Pi and Claude: the map entry, never the legacy slot (SessionManager
    // adopts that slot through migrateLegacyAnchor first, scoped to the map).
    const anchors = writeRuntimeAnchor(writeRuntimeAnchor(undefined, 'pi', 'pi-1'), 'anthropic', 'claude-1')
    expect(readAgentResumeAnchor(anchors, 'other-id', 'pi')).toBe('pi-1')
    expect(readAgentResumeAnchor(anchors, 'other-id', 'anthropic')).toBe('claude-1')
    expect(readAgentResumeAnchor({}, 'other-id', 'pi')).toBeUndefined()
    expect(readAgentResumeAnchor({}, 'other-id', 'nestor-cloud-agent')).toBeUndefined()
  })

  // P2.283 — this module was one of two sites where P2.124's "adding a runtime
  // BREAKS THE BUILD" was false. `ANCHORED_PROVIDERS` was a hand-written array,
  // so a new member of `ModelProvider` compiled clean here and was silently NOT
  // anchored; it is now derived from a `Record<AgentProvider, boolean>`, whose
  // missing arm is a type error. The compiler half binds at
  // `bun run typecheck:shared`, not here — `bun test` does not typecheck — so
  // these two cover the halves a type cannot: that the derivation is real, and
  // that the behaviour for a value outside the union has not moved.
  describe('P2.283 · anchoring is decided per runtime, not by a hand-kept list', () => {
    it('ANCHORED_PROVIDERS is derived from the record and excludes its false arms', () => {
      const anchored = Object.entries(RUNTIME_ANCHOR_SUPPORT)
        .filter(([, supported]) => supported)
        .map(([provider]) => provider as AgentProvider)
        .sort()
      expect([...ANCHORED_PROVIDERS].sort()).toEqual(anchored)
      // Negative half, so the equality above cannot pass vacuously: the record
      // really does refuse someone, and the refused runtimes really are absent.
      const refused = Object.entries(RUNTIME_ANCHOR_SUPPORT)
        .filter(([, supported]) => !supported)
        .map(([provider]) => provider)
      expect(refused.length).toBeGreaterThan(0)
      expect(refused.filter(provider => ANCHORED_PROVIDERS.includes(provider as AgentProvider)))
        .toEqual([])
    })

    it('a runtime outside the union is still refused, exactly as the array refused it', () => {
      // `getLlmConnections()` returns stored config with no per-field
      // validation, so a string in no union really can reach here. The array
      // form answered `false` by `.includes`; the record form answers `false`
      // because the lookup is `undefined`. Same answer, and the record must not
      // have turned a missing key into a truthy read.
      const unknown = 'sonnet-of-nobody' as AgentProvider
      expect(writeRuntimeAnchor(undefined, unknown, 'x')).toEqual({})
      expect(migrateLegacyAnchor(undefined, 'x', unknown)).toEqual({})
      expect(readRuntimeAnchor({ [unknown]: 'x' }, unknown)).toBeUndefined()
      // Positive control on the same rig: a real anchored runtime round-trips.
      expect(readRuntimeAnchor(writeRuntimeAnchor(undefined, 'pi', 'x'), 'pi')).toBe('x')
    })
  })
})
