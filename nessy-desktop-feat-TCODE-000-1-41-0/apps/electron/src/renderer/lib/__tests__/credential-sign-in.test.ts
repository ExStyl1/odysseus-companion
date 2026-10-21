/**
 * D1.194 — one sign-in affordance for an expired credential, on every runtime.
 *
 * The row's complaint is a three-way divergence, verified at HEAD before this
 * landed: claude yields a `typed_error` whose only action navigates to the BARE
 * settings route with a backend-English label; Pi's `onBackendAuthRequired`
 * becomes `{ type: 'info', level: 'error' }` in `SessionManager`, a transcript
 * line with no action at all; the corporate credential gets `AuthRequestCard`'s
 * dp variant with a reason and one button.
 *
 * The rule below is what makes the three one: the card is chosen by the CODE, so
 * no runtime has to be recognised, and the button names the connection the
 * session was using — which only became expressible with D1.254.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {
  CREDENTIAL_ERROR_CODES,
  isReplacedByCredentialSignIn,
  resolveCredentialSignIn,
} from '../credential-sign-in'

describe('resolveCredentialSignIn', () => {
  it('offers the button for every credential-shaped code, pointing at the session\'s own connection', () => {
    for (const code of CREDENTIAL_ERROR_CODES) {
      const view = resolveCredentialSignIn(code, 'claude-subscription')
      expect(view, code).not.toBeNull()
      expect(view!.route).toBe('settings/ai/connection/claude-subscription')
      expect(view!.labelKey).toBe('chat.credentialSignIn')
    }
  })

  it('falls back to the AI settings page when the session names no connection', () => {
    // Never worse than what it replaces: the claude action navigated to the bare
    // settings route, so a session with no slug still gets a button.
    expect(resolveCredentialSignIn('token_expired', undefined)?.route).toBe('settings/ai')
  })

  it('is null for an error that is not about a credential', () => {
    // The boundary the cases above are only meaningful against — every other
    // error keeps exactly the actions it arrived with.
    expect(resolveCredentialSignIn('rate_limited', 'x')).toBeNull()
    expect(resolveCredentialSignIn('mcp_unreachable', 'x')).toBeNull()
    expect(resolveCredentialSignIn(undefined, 'x')).toBeNull()
    expect(resolveCredentialSignIn('', 'x')).toBeNull()
  })

  it('replaces the backend\'s settings action and nothing else', () => {
    // The row asks for ONE button. Retry and an OAuth `open_url` are different
    // offers and survive beside it.
    expect(isReplacedByCredentialSignIn({ action: 'settings' })).toBe(true)
    expect(isReplacedByCredentialSignIn({ action: 'retry' })).toBe(false)
    expect(isReplacedByCredentialSignIn({ action: 'open_url' })).toBe(false)
    expect(isReplacedByCredentialSignIn({})).toBe(false)
  })

  it('has its one key in both locales', () => {
    expect((en as Record<string, string>)['chat.credentialSignIn']).toBeTruthy()
    expect((ru as Record<string, string>)['chat.credentialSignIn']).toBeTruthy()
    // Translated, not copied: the whole point of a KEY here is that the button
    // is not backend English in every locale, which is what it replaced.
    expect((ru as Record<string, string>)['chat.credentialSignIn'])
      .not.toBe((en as Record<string, string>)['chat.credentialSignIn'])
  })
})

/**
 * The CHAIN, pinned by source for the reason every renderer suite in this tree
 * pins one: the error marker's graph reaches the `@nessy-agent/ui` barrel and its
 * Vite-only `pdfjs-dist/...?url` specifier, which `bun test` cannot resolve
 * without the pdfjs recipe. The rule above is exercised for real; these lines
 * are the links between it and the screen, and this repo's recurring failure
 * mode is a chain with correct code at both ends. UB14.14 moved the marker with
 * v0.15.1's message renderer into `chat-display/ErrorMessage.tsx` (the rendered
 * arm — sign-in first, primary — is `chat-display/__tests__/message-bubble.test.tsx`).
 */
describe('the error marker is what renders it', () => {
  const chatDisplay = readFileSync(
    fileURLToPath(new URL('../../components/app-shell/chat-display/ErrorMessage.tsx', import.meta.url)),
    'utf8',
  )

  it('resolves the card from the code and the session\'s connection, and navigates to its route', () => {
    expect(chatDisplay).toContain('resolveCredentialSignIn(')
    expect(chatDisplay).toContain('sessionMetaMap.get(sessionId)?.llmConnection')
    expect(chatDisplay).toContain('navigate(credentialSignIn.route)')
    expect(chatDisplay).toContain("t(credentialSignIn.labelKey)")
    expect(chatDisplay).toContain('data-testid="credential-sign-in"')
  })

  it('drops the backend action the card replaces, and still renders the card when it was the only one', () => {
    // Both halves matter: without the filter the user gets two buttons for one
    // offer, and without the widened guard an error whose ONLY action was the
    // replaced one would render no buttons at all.
    expect(chatDisplay).toContain('isReplacedByCredentialSignIn(a)')
    expect(chatDisplay).toContain('{(credentialSignIn || (actions && actions.length > 0)) && (')
  })
})
