import { describe, expect, it, mock } from 'bun:test'
import { handleErrorMessageAction, type ErrorMessageAction } from '../error-message-actions'

describe('handleErrorMessageAction', () => {
  it('routes retry through the session-scoped focus handler', () => {
    const onRetryFocus = mock(() => {})
    const action: ErrorMessageAction = {
      key: 'r',
      label: 'Retry',
      action: 'retry',
    }

    handleErrorMessageAction(action, {
      sessionId: 'session-123',
      onRetryFocus,
    })

    expect(onRetryFocus).toHaveBeenCalledTimes(1)
    expect(onRetryFocus).toHaveBeenCalledWith({ sessionId: 'session-123' })
  })

  it('opens the provided URL for open_url actions', () => {
    const onOpenUrl = mock(() => {})
    const action: ErrorMessageAction = {
      key: 'docs',
      label: 'Open docs',
      action: 'open_url',
      url: 'https://example.com/status',
    }

    handleErrorMessageAction(action, { onOpenUrl })

    expect(onOpenUrl).toHaveBeenCalledTimes(1)
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/status')
  })

  it('calls onRetry instead of onRetryFocus when provided', () => {
    const onRetry = mock(() => {})
    const onRetryFocus = mock(() => {})
    const action: ErrorMessageAction = {
      key: 'r',
      label: 'Retry',
      action: 'retry',
    }

    handleErrorMessageAction(action, {
      sessionId: 'session-123',
      onRetry,
      onRetryFocus,
    })

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetryFocus).not.toHaveBeenCalled()
  })

  it('runs the settings handler for settings actions', () => {
    const onOpenSettings = mock(() => {})
    const action: ErrorMessageAction = {
      key: 'settings',
      label: 'Settings',
      action: 'settings',
    }

    handleErrorMessageAction(action, { onOpenSettings })

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})

/**
 * D1.272 — the `reauth` action, and the promise that nothing is dropped.
 *
 * The action is the one `expired_oauth_token`'s `ERROR_DEFINITIONS` entry
 * declares FIRST (`{ key: 'r', label: 'Re-authenticate', action: 'reauth' }`),
 * and claude has produced that code since D1.194. The shape below is that
 * entry's, written out rather than imported: `packages/shared/src/agent/errors.ts`
 * is not on the renderer's import surface, and a copy that drifts fails the
 * union's own type check at this call site.
 */
describe('handleErrorMessageAction — reauth (D1.272)', () => {
  const reauth: ErrorMessageAction = { key: 'r', label: 'Re-authenticate', action: 'reauth' }

  it('opens the session connection\'s own setup — D1.254\'s named-connection route', () => {
    const onReauth = mock((_route: string) => {})
    const onUnhandled = mock((_action: ErrorMessageAction) => {})

    handleErrorMessageAction(reauth, {
      sessionId: 'session-123',
      connectionSlug: 'claude-gateway',
      onReauth,
      onUnhandled,
    })

    expect(onReauth).toHaveBeenCalledTimes(1)
    expect(onReauth).toHaveBeenCalledWith('settings/ai/connection/claude-gateway')
    expect(onUnhandled).not.toHaveBeenCalled()
  })

  it('falls back to the AI settings page when the session names no connection', () => {
    const onReauth = mock((_route: string) => {})
    const onUnhandled = mock((_action: ErrorMessageAction) => {})

    handleErrorMessageAction(reauth, { sessionId: 'session-123', onReauth, onUnhandled })

    expect(onReauth).toHaveBeenCalledWith('settings/ai')
    // Never the BARE settings navigator, which is what the backend's own
    // `settings` action does and what this row exists to improve on.
    expect(onReauth).not.toHaveBeenCalledWith('settings')
    expect(onUnhandled).not.toHaveBeenCalled()
  })

  it('escapes a slug that needs it, because the segment is a URL path', () => {
    const onReauth = mock((_route: string) => {})
    handleErrorMessageAction(reauth, { connectionSlug: 'my custom/endpoint', onReauth })
    expect(onReauth).toHaveBeenCalledWith('settings/ai/connection/my%20custom%2Fendpoint')
  })
})

/**
 * The other half of "never falls through silently": the shape this handler
 * cannot execute is REPORTED. It is live — the command-only entry is
 * `token_expired`'s *Open workspace menu*, which reaches the renderer today and
 * renders a button that did nothing and said nothing.
 *
 * D1.293 retired the OTHER one. The wire declared a fifth action code with no
 * producer and no destination, and the case that used to sit here asserted the
 * handler refusing it. There is nothing left to refuse: the code cannot be
 * typed, and the case below that answers one arm per member of the union is
 * what says so — it now has four rows and every one of them executes.
 */
describe('handleErrorMessageAction — an action it cannot run says so (D1.272)', () => {
  it('reports an actionless entry — and D1.283 leaves it with no live producer', () => {
    const onUnhandled = mock((_action: ErrorMessageAction) => {})
    // The shape `token_expired` used to send. `event-processor/handlers/session.ts`
    // dropped `command` on the way, so it arrived with nothing at all to do; the
    // mapper carries it now, which is what lets the refusal NAME the command
    // instead of saying "(command-only)". No `ERROR_DEFINITIONS` entry produces
    // this shape any more — `errors.test.ts` holds that — so it is a producer
    // defect the handler reports rather than a case it dispatches.
    const action: ErrorMessageAction = { key: 'w', label: 'Open workspace menu', command: '/workspace' }

    handleErrorMessageAction(action, { onUnhandled })

    expect(onUnhandled).toHaveBeenCalledTimes(1)
    expect(onUnhandled).toHaveBeenCalledWith(action)
  })

  it('answers every member of the wire union, and only the command-only shape refuses (D1.293)', () => {
    // One case per action code, because a handler that grew a branch and a wire
    // that grew a member are the two ways this family has gone dead before.
    const seen: Array<[string, 'executed' | 'refused']> = []
    const record = (code: string, run: (onUnhandled: () => void) => void): void => {
      let refused = false
      run(() => { refused = true })
      seen.push([code, refused ? 'refused' : 'executed'])
    }

    record('retry', onUnhandled => handleErrorMessageAction(
      { key: 'r', label: 'Retry', action: 'retry' }, { onRetry: () => {}, onUnhandled }))
    record('settings', onUnhandled => handleErrorMessageAction(
      { key: 's', label: 'Settings', action: 'settings' }, { onOpenSettings: () => {}, onUnhandled }))
    record('reauth', onUnhandled => handleErrorMessageAction(
      { key: 'a', label: 'Re-auth', action: 'reauth' }, { onReauth: () => {}, onUnhandled }))
    record('open_url', onUnhandled => handleErrorMessageAction(
      { key: 'd', label: 'Docs', action: 'open_url', url: 'https://example.invalid/' },
      { onOpenUrl: () => {}, onUnhandled }))
    record('(command-only)', onUnhandled => handleErrorMessageAction(
      { key: 'w', label: 'Workspace', command: '/workspace' }, { onUnhandled }))

    expect(seen).toEqual([
      ['retry', 'executed'],
      ['settings', 'executed'],
      ['reauth', 'executed'],
      ['open_url', 'executed'],
      // No producer since D1.283, and refusing it is what keeps it that way.
      ['(command-only)', 'refused'],
    ])
    // D1.293 — the row list is the union's own size, so a member added to the
    // wire and forgotten here cannot leave this case looking complete. The
    // handler's own compile-time binding is the other half; this is the one a
    // reader meets.
    expect(seen.filter(([, outcome]) => outcome === 'executed')).toHaveLength(4)
  })

  it('and an executed action never reaches it — the control', () => {
    const onUnhandled = mock((_action: ErrorMessageAction) => {})
    const onRetry = mock(() => {})
    const onOpenSettings = mock(() => {})
    const onOpenUrl = mock((_url: string) => {})

    handleErrorMessageAction({ key: 'r', label: 'Retry', action: 'retry' }, { onRetry, onUnhandled })
    handleErrorMessageAction({ key: 's', label: 'Settings', action: 'settings' }, { onOpenSettings, onUnhandled })
    handleErrorMessageAction(
      { key: 'd', label: 'Docs', action: 'open_url', url: 'https://example.invalid/status' },
      { onOpenUrl, onUnhandled },
    )

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onOpenUrl).toHaveBeenCalledTimes(1)
    expect(onUnhandled).not.toHaveBeenCalled()
  })
})
