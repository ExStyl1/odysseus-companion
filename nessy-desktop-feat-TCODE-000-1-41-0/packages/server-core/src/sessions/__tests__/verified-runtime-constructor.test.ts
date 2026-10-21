import { describe, expect, it } from 'bun:test'
import { SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

describe('SessionManager verified runtime', () => {
  it('fails closed without an injected session store and runtime services', () => {
    const UnsafeConstructor = SessionManager as unknown as new () => SessionManager
    expect(() => new UnsafeConstructor()).toThrow('verified-session-runtime-required')
  })

  // RELABELLED, not strengthened. The old name credited a mechanism these four
  // `toBeDefined()` calls cannot see: that fallback construction is confined to
  // test-only code is proven by the test ABOVE (the production constructor
  // fails closed), not here. What this test actually checks is that the test
  // factory hands back a manager with its runtime services wired.
  it('the test-only factory returns a manager with its runtime services wired', () => {
    const manager = createTestSessionManager()
    expect(manager.getCapabilityResolver()).toBeDefined()
    expect(manager.getProjectHandleService()).toBeDefined()
    expect(manager.getRecentProjectStore()).toBeDefined()
    expect(manager.getWorkspaceQuiescence()).toBeDefined()
    manager.cleanup()
  })
})
