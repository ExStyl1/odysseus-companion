import * as React from 'react'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import type { PermissionRequest as PermissionRequestData } from '../../../../../../shared/types'
import type { PermissionResponse } from '../types'
import { bashAlwaysAllowRememberScope } from '@nessy-agent/shared/agent/core/bash-remember-scope'
import {
  alwaysAllowIsSessionOnly,
  alwaysAllowKeepsSessionKeyOnly,
  answerNoteOffered,
  permissionAnswerResponse,
  PermissionRequest,
  permissionRememberScope,
  shouldOfferAutoModeSwitch,
} from '../PermissionRequest'
import {
  ComposerCapabilitiesProvider,
  DEFAULT_COMPOSER_CAPABILITIES,
} from '../../composer-capabilities-context'
import { StructuredInput } from '../../StructuredInput'
import { DecisionActions, DecisionDetails, DecisionFoot, DecisionPreview, DecisionSpacer } from '../DecisionCard'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'

/**
 * P6.208 (A40) — the permission card's third documented answer.
 *
 * `permission-modes.md#switch-permission-modes`, verbatim: *"**From a Bash
 * permission prompt**: in the Manual and `acceptEdits` permission modes, when
 * auto mode is available, Claude Code adds **Yes, and switch to auto mode** to a
 * Bash command's permission prompt."* and *"Claude Code doesn't add the option
 * to prompts forced by one of your `ask` rules or by a hook, because auto mode
 * still shows you those prompts, so switching wouldn't remove them."*
 *
 * The decision is asserted through the exported predicate rather than only
 * through markup, because the markup can only show that the button is there —
 * the four conditions and the ORIGIN carve-out are what the row's done_means
 * names, and each of them has to be able to fail on its own.
 */

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    // Empty bundle on purpose: `t(key)` returns the key, so an assertion names
    // the key contract rather than today's English copy.
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  })
})

const ALL_MODES = DEFAULT_COMPOSER_CAPABILITIES.permissions.modes

function bashRequest(overrides: Partial<PermissionRequestData> = {}): PermissionRequestData {
  return {
    // `shared/types`' `PermissionRequest` carries the routing `sessionId`; the
    // card never reads it, but the type does.
    sessionId: 'session-a',
    requestId: 'perm-1',
    toolName: 'Bash',
    command: 'npm run build',
    description: 'Run the build',
    type: 'bash',
    ...overrides,
  }
}

function withoutAutoMode(): ComposerCapabilities {
  return {
    ...DEFAULT_COMPOSER_CAPABILITIES,
    permissions: {
      modes: DEFAULT_COMPOSER_CAPABILITIES.permissions.modes.filter(m => m !== 'auto'),
    },
  }
}

function renderCard(
  request: PermissionRequestData,
  permissionMode: PermissionMode | undefined,
  opts: { capabilities?: ComposerCapabilities; withSetter?: boolean; appShell?: Partial<AppShellContextType> } = {},
): string {
  const { capabilities = DEFAULT_COMPOSER_CAPABILITIES, withSetter = true, appShell } = opts
  const card = (
    <PermissionRequest
      request={request}
      onResponse={() => {}}
      permissionMode={permissionMode}
      onPermissionModeChange={withSetter ? () => {} : undefined}
    />
  )
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <ComposerCapabilitiesProvider value={capabilities}>
        {appShell
          // A minimal value is enough for a static render; the card reads only
          // `isFocusedPanel` from it.
          ? <AppShellProvider value={appShell as AppShellContextType}>{card}</AppShellProvider>
          : card}
      </ComposerCapabilitiesProvider>
    </I18nextProvider>,
  )
}

describe('PermissionRequest — the reopen dialog\'s third answer (P6.950)', () => {
  /**
   * `sessions.md#resume-from-a-summary` offers THREE ways to continue a resumed
   * session and this card shipped two. The third — *"**Don't ask me again**:
   * resumes the full session and stops showing the dialog on all future
   * resumes"* — is the as-is answer plus `alwaysAllow`, which
   * `respondToPermission` reads as the host effect that turns the dialog off.
   */
  const reopenRequest = (): PermissionRequestData => bashRequest({
    toolName: 'ResumeConversation',
    type: 'ask_user',
    command: undefined,
    noAlwaysAllow: true,
    reopenCompact: { contextTokens: 150_000, thresholdTokens: 100_000, idleHours: 24 },
  })

  test('all three answers are on the card, and the generic Always Allow is not', () => {
    const markup = renderCard(reopenRequest(), 'default')
    expect(markup).toContain('chat.reopenCompact.summary')
    expect(markup).toContain('chat.reopenCompact.asIs')
    expect(markup).toContain('chat.reopenCompact.dontAsk')
    expect(markup).toContain('reopen-compact-dont-ask')
    // `noAlwaysAllow` still withholds the GENERIC button, whose label and scope
    // are the wrong question here. The third answer is this card's own.
    expect(markup).not.toMatch(/chat\.permissionAlwaysAllow(?!\.)/)
  })

  test('no other card grows a third button — the control', () => {
    // NEGATIVE: the button is gated on the PAYLOAD, not on the `ask_user` type,
    // which several unrelated prompts share.
    const markup = renderCard(bashRequest({ type: 'ask_user', noAlwaysAllow: true }), 'default')
    expect(markup).not.toContain('reopen-compact-dont-ask')
    expect(markup).not.toContain('chat.reopenCompact.dontAsk')
  })
})

describe('PermissionRequest — "Yes, and switch to auto mode" (P6.208 A40)', () => {
  test('offered on a runtime-raised Bash prompt in Manual and in acceptEdits', () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      for (const origin of ['claude_native', 'codex_approval'] as const) {
        expect(
          shouldOfferAutoModeSwitch({
            type: 'bash',
            origin,
            permissionMode: mode,
            availableModes: ALL_MODES,
          }),
        ).toBe(true)
      }
    }

    const markup = renderCard(bashRequest({ origin: 'claude_native' }), 'default')
    expect(markup).toContain('chat.permissionSwitchToAuto')
    expect(markup).toContain('permission-switch-to-auto')
  })

  test('absent on a prompt our own gate raised that the mode did not force — the ask-rule/hook carve-out', () => {
    // `host_gate` is the origin every prompt OUR permission gate carries, and it
    // does NOT separate "the mode asked" from "an ask rule or a hook asked" —
    // that is what `modePrompt` does since P6.863. Without the field the origin
    // alone stays conservative in the safe direction, which covers both the
    // class the page excludes ("forced by one of your `ask` rules or by a
    // hook") and the host-owned surfaces auto mode also still shows.
    expect(
      shouldOfferAutoModeSwitch({
        type: 'bash',
        origin: 'host_gate',
        permissionMode: 'default',
        availableModes: ALL_MODES,
      }),
    ).toBe(false)

    // An UNKNOWN origin must not manufacture the affordance either — the same
    // reading P6.709 gave the field at the band (absent means unknown, never
    // "the host did not raise it").
    expect(
      shouldOfferAutoModeSwitch({
        type: 'bash',
        origin: undefined,
        permissionMode: 'default',
        availableModes: ALL_MODES,
      }),
    ).toBe(false)

    const markup = renderCard(bashRequest({ origin: 'host_gate' }), 'default')
    expect(markup).not.toContain('chat.permissionSwitchToAuto')
    // Positive control on the same markup: the card itself rendered.
    expect(markup).toContain('chat.permissionRequired')
  })

  test('P6.863: the gate\'s own MODE prompt offers the switch, and only the mode prompt does', () => {
    // POSITIVE. The two places switching to auto mode really would remove the
    // prompt — a Pi mode prompt and claude's PreToolUse-branch prompt, both
    // `host_gate` — say so with `modePrompt`, which the gate sets only when
    // nothing forced the prompt.
    expect(
      shouldOfferAutoModeSwitch({
        type: 'bash',
        origin: 'host_gate',
        modePrompt: true,
        permissionMode: 'default',
        availableModes: ALL_MODES,
      }),
    ).toBe(true)
    const markup = renderCard(bashRequest({ origin: 'host_gate', modePrompt: true }), 'default')
    expect(markup).toContain('chat.permissionSwitchToAuto')

    // NEGATIVE. The field widens NOTHING else: the other three conditions still
    // each refuse on their own, so a forced prompt, a non-Bash prompt and a mode
    // that cannot switch are all unaffected by it.
    const withField = {
      type: 'bash' as const,
      origin: 'host_gate' as const,
      modePrompt: true as const,
      permissionMode: 'default' as PermissionMode,
      availableModes: ALL_MODES,
    }
    expect(shouldOfferAutoModeSwitch({ ...withField, type: 'file_write' })).toBe(false)
    expect(shouldOfferAutoModeSwitch({ ...withField, permissionMode: 'auto' })).toBe(false)
    expect(
      shouldOfferAutoModeSwitch({ ...withField, availableModes: ALL_MODES.filter(m => m !== 'auto') }),
    ).toBe(false)
    // And a prompt the gate FORCED never carries the field, so the host surfaces
    // and the ask-rule/hook class stay exactly where they were.
    expect(
      shouldOfferAutoModeSwitch({
        type: 'bash',
        origin: 'host_gate',
        permissionMode: 'default',
        availableModes: ALL_MODES,
      }),
    ).toBe(false)
  })

  test('the other three conditions each fail on their own', () => {
    const base = {
      type: 'bash' as const,
      origin: 'claude_native' as const,
      permissionMode: 'default' as PermissionMode,
      availableModes: ALL_MODES,
    }
    expect(shouldOfferAutoModeSwitch(base)).toBe(true)

    // Not a Bash prompt: the page scopes the answer to "a Bash command's
    // permission prompt".
    expect(shouldOfferAutoModeSwitch({ ...base, type: 'file_write' })).toBe(false)
    expect(shouldOfferAutoModeSwitch({ ...base, type: undefined })).toBe(false)

    // Any mode other than Manual / acceptEdits, including auto itself.
    for (const mode of ['auto', 'plan', 'dontAsk', 'bypassPermissions'] as const) {
      expect(shouldOfferAutoModeSwitch({ ...base, permissionMode: mode })).toBe(false)
    }
    expect(shouldOfferAutoModeSwitch({ ...base, permissionMode: undefined })).toBe(false)

    // "when auto mode is available" — read from the composer's own capability
    // list, so the button can never offer a mode the picker refuses.
    expect(
      shouldOfferAutoModeSwitch({ ...base, availableModes: ALL_MODES.filter(m => m !== 'auto') }),
    ).toBe(false)
  })

  test('a card with no mode setter never grows the button', () => {
    // Half a click is worse than none: the label promises an approval AND a
    // switch, so a card mounted without the composer's setter must not offer it.
    const markup = renderCard(bashRequest({ origin: 'claude_native' }), 'default', {
      withSetter: false,
    })
    expect(markup).not.toContain('chat.permissionSwitchToAuto')

    const withoutAuto = renderCard(bashRequest({ origin: 'claude_native' }), 'default', {
      capabilities: withoutAutoMode(),
    })
    expect(withoutAuto).not.toContain('chat.permissionSwitchToAuto')
  })
})

/**
 * P6.202 clause (3) — auto mode's first read outside the working directories.
 *
 * `permission-modes.md#first-read-outside-the-working-directories` (an explicit
 * `<h3 id=…>` on the rendered page): *"Whatever you answer, Claude keeps
 * working: **Keep allowing** … **Block from now on** … **Ask again next time**"*.
 * Three answers, and the two Deny-shaped ones do different things — which is why
 * the card cannot be the ordinary Allow / Always Allow / Deny row relabeled.
 */
describe('PermissionRequest — the first read outside the working directories (P6.202 (3))', () => {
  const outsideRead = {
    path: '/etc/hosts',
    tool: 'Read',
    workingDirectory: '/Users/dev/project',
  }

  test('renders the three documented answers, the path, and the base', () => {
    const markup = renderCard(
      bashRequest({ type: 'file_write', command: undefined, outsideWorkingDirectoryRead: outsideRead }),
      'auto',
    )
    expect(markup).toContain('chat.outsideRead.header')
    expect(markup).toContain('chat.outsideRead.keepAllowing')
    expect(markup).toContain('chat.outsideRead.blockFromNowOn')
    expect(markup).toContain('chat.outsideRead.askAgain')
    expect(markup).toContain('/etc/hosts')
    expect(markup).toContain('/Users/dev/project')
    // The generic row is REPLACED, not decorated: "Deny" would be a fourth
    // answer to a three-answer question.
    expect(markup).not.toMatch(/chat\.permissionAlwaysAllow(?!\.)/)
    expect(markup).not.toContain('>chat.permissionDeny<')
    expect(markup).not.toContain('chat.permissionRequired')
  })

  test('an ordinary card is untouched by the payload being absent', () => {
    const markup = renderCard(bashRequest({ origin: 'host_gate' }), 'default')
    expect(markup).toContain('chat.permissionRequired')
    expect(markup).not.toContain('chat.outsideRead.')
    expect(markup).toMatch(/chat\.permissionAlwaysAllow(?!\.)/)

    // ...and the auto-mode escalation is never offered on this card, because it
    // is not a Bash prompt and the session is already in auto mode.
    const outside = renderCard(
      bashRequest({ origin: 'claude_native', outsideWorkingDirectoryRead: outsideRead }),
      'auto',
    )
    expect(outside).not.toContain('chat.permissionSwitchToAuto')
  })
})

/**
 * P6.951 + P6.864 — the note an ANSWER carries, either way.
 *
 * `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`: *"**Yes**:
 * Claude Code runs the action, then sends your comment to Claude after the
 * result. **No**: Claude Code sends your comment to Claude as the reason for the
 * denial, and Claude continues working."*
 *
 * The two halves are asserted apart on purpose. The four exclusions are four
 * ways the affordance must NOT appear and markup can only show that it does, so
 * they go through the predicate; the response SHAPE is what reaches the host, so
 * it goes through the builder.
 */
describe('PermissionRequest — the answer note (P6.951, P6.864)', () => {
  const carries = { answerNote: true as const }

  test('offered on an ordinary card, and on none of the four whose Deny is a choice', () => {
    expect(answerNoteOffered({ type: 'bash' }, carries)).toBe(true)
    expect(answerNoteOffered({ type: 'file_write' }, carries)).toBe(true)
    // Each of these RENAMES the deny button because the answer is a choice, not
    // a refusal — "the reason for your denial" is the wrong question for them.
    expect(answerNoteOffered({ type: 'outside_root' }, carries)).toBe(false)
    expect(answerNoteOffered({ type: 'worktree_cleanup' }, carries)).toBe(false)
    expect(answerNoteOffered({ type: 'bash', reopenCompact: { idleMs: 1, contextTokens: 2 } as never }, carries))
      .toBe(false)
    expect(answerNoteOffered({
      type: 'file_write',
      outsideWorkingDirectoryRead: { path: '/etc/hosts', tool: 'Read', workingDirectory: '/p' } as never,
    }, carries)).toBe(false)
  })

  test('never offered on a runtime that carries the note to nobody', () => {
    // The fifth exclusion, and the one a markup test cannot state: a runtime
    // where neither half reaches the model must not ask the user to write a
    // sentence to nobody. The capability carries that verdict, resolved
    // server-side — the remote agent is the one that has it off today.
    expect(answerNoteOffered({ type: 'bash' }, {})).toBe(false)
    expect(answerNoteOffered({ type: 'bash' }, { answerNote: undefined })).toBe(false)
  })

  test('sends the note trimmed, on either answer, and sends no options without one', () => {
    expect(permissionAnswerResponse({ allowed: false }, '  force-pushing main is never ok here  '))
      .toEqual({
        type: 'permission',
        allowed: false,
        alwaysAllow: false,
        options: { comment: 'force-pushing main is never ok here' },
      })
    // P6.864 — the same field on the other answer. The host queues this one for
    // the next turn instead of filling a deny reason with it, which is the whole
    // difference between the halves and is invisible from here.
    expect(permissionAnswerResponse({ allowed: true }, 'use the staging bucket'))
      .toEqual({
        type: 'permission',
        allowed: true,
        alwaysAllow: false,
        options: { comment: 'use the staging bucket' },
      })
    // NEGATIVE, and it is the page's own carve-out: *"The options that allow the
    // action for the rest of the session or save a rule don't take one either."*
    // A note explains one answer; a rule outlives it.
    expect(permissionAnswerResponse({ allowed: true, alwaysAllow: true }, 'only this once'))
      .toEqual({ type: 'permission', allowed: true, alwaysAllow: true })
    // Byte-identical to an answer from before these rows — the boundary that
    // keeps a stray space from becoming the reason the model is given.
    const bare: PermissionResponse = { type: 'permission', allowed: false, alwaysAllow: false }
    expect(permissionAnswerResponse({ allowed: false }, '')).toEqual(bare)
    expect(permissionAnswerResponse({ allowed: false }, '   ')).toEqual(bare)
  })

  test('the affordance is drawn on an ordinary card and on none of the four', () => {
    const ordinary = renderCard(bashRequest({ origin: 'host_gate' }), 'default', {
      capabilities: { ...DEFAULT_COMPOSER_CAPABILITIES, answerNote: true },
    })
    expect(ordinary).toContain('permission-answer-note-open')
    expect(ordinary).toContain('chat.permissionComment.add')
    // The field itself is revealed by the button, so it is not in the first paint.
    expect(ordinary).not.toContain('permission-answer-note"')

    const outsideRead = renderCard(
      bashRequest({
        type: 'file_write',
        command: undefined,
        outsideWorkingDirectoryRead: { path: '/etc/hosts', tool: 'Read', workingDirectory: '/p' },
      }),
      'auto',
      { capabilities: { ...DEFAULT_COMPOSER_CAPABILITIES, answerNote: true } },
    )
    expect(outsideRead).not.toContain('permission-answer-note-open')

    const cleanup = renderCard(bashRequest({ type: 'worktree_cleanup' }), 'default', {
      capabilities: { ...DEFAULT_COMPOSER_CAPABILITIES, answerNote: true },
    })
    expect(cleanup).not.toContain('permission-answer-note-open')

    // And the default capabilities carry no `answerNote`, so an ordinary card
    // on a runtime that has not turned the arm on draws nothing.
    expect(renderCard(bashRequest({ origin: 'host_gate' }), 'default'))
      .not.toContain('permission-answer-note-open')
  })
})
describe('PermissionRequest — what "Always Allow" promises, per runtime (C3.365)', () => {
  /**
   * One card, two behaviours, measured on the packaged 1.36.0 with both controls
   * green in each arm: on claude the branch asks AGAIN with the same
   * `["Bash(touch *)"]` already on disk (R6a, RS-36), and on Pi the same grant
   * TRAVELS the branch from the same file in the same build (R7, RS-36 PASS).
   *
   * The predicate is asserted directly as well as through markup because four
   * arms are four ways one sentence can be wrong, and markup can only show which
   * one was rendered.
   */
  const scopeOf = (
    type: PermissionRequestData['type'],
    activeRuntime: ComposerCapabilities['connection']['activeRuntime'] | undefined,
  ) => permissionRememberScope({ type, activeRuntime })

  test('a Bash grant is repository-scoped exactly where the runtime evaluates the rule file', () => {
    // Pi and codex compile `.claude/settings.local.json` into the readable
    // permission DSL and let an `allow` match clear the ask, so the rule the
    // host writes really does outlive the session there.
    expect(scopeOf('bash', 'pi')).toBe('repository')
    expect(scopeOf('bash', 'codex-runtime')).toBe('repository')
    // claude never evaluates that DSL — our gate runs there as a PreToolUse
    // hook — so what survives is the session command whitelist alone.
    expect(scopeOf('bash', 'anthropic')).toBe('session')
  })

  test('an unknown or unrepresented runtime takes the WEAKER promise', () => {
    expect(scopeOf('bash', undefined)).toBe('session')
    expect(scopeOf('bash', 'nestor-cloud-agent')).toBe('session')
  })

  test('the runtime alone never promises a repository, and the host consent record always does', () => {
    // The negative control the runtime arms need: were the rule simply "Pi means
    // repository", this would be repository too — a file write is remembered for
    // the session on every runtime.
    expect(scopeOf('file_write', 'pi')).toBe('session')
    expect(scopeOf('mcp_mutation', 'codex-runtime')).toBe('session')
    // The setup-script consent is the HOST's own per-project record, written the
    // same way whichever runtime is in the session — including claude, where the
    // Bash arm is deliberately the weaker one.
    expect(scopeOf('worktree_setup', 'anthropic')).toBe('repository')
    expect(scopeOf('worktree_setup', 'pi')).toBe('repository')
  })

  test('F1.128 — the card READS the table the write reads: one answer per runtime, and no copy of its own', () => {
    // Every runtime the vocabulary has today, plus the unknown one. Were the card
    // still spelling its own list, a runtime added to the leaf's table would
    // leave this arm to catch the disagreement; with the call it cannot arise.
    const runtimes = ['pi', 'codex-runtime', 'anthropic', 'nestor-cloud-agent', undefined] as const
    expect(runtimes.map(runtime => [runtime, scopeOf('bash', runtime)]))
      .toEqual(runtimes.map(runtime => [runtime, bashAlwaysAllowRememberScope(runtime)]))
    // And the ONE place is the call, not a second table: the CALL is pinned and
    // the retired expression is absent from the module's source.
    const source = readFileSync(new URL('../PermissionRequest.tsx', import.meta.url), 'utf8')
    expect(source).toContain('return bashAlwaysAllowRememberScope(activeRuntime)')
    expect(source).not.toContain("activeRuntime === 'pi' || activeRuntime === 'codex-runtime'")
  })

  test('the card RENDERS the runtime-correct sentence, not merely computes it', () => {
    const onClaude = renderCard(bashRequest({ origin: 'host_gate' }), 'default', {
      capabilities: {
        ...DEFAULT_COMPOSER_CAPABILITIES,
        connection: { switchable: false, activeRuntime: 'anthropic' },
      },
    })
    expect(onClaude).toContain('chat.permissionRemember.session')
    expect(onClaude).not.toContain('chat.permissionRemember.repository')

    const onPi = renderCard(bashRequest({ origin: 'host_gate' }), 'default', {
      capabilities: {
        ...DEFAULT_COMPOSER_CAPABILITIES,
        connection: { switchable: false, activeRuntime: 'pi' },
      },
    })
    expect(onPi).toContain('chat.permissionRemember.repository')
    expect(onPi).not.toContain('chat.permissionRemember.session')
  })
  test('F1.1236 — a codex card whose Always Allow saves a workspace rule SAYS so; without the statement it keeps the session sentence', () => {
    // The codex command card carries no `type` (`mapCommandApprovalToRequest`), so the producer's
    // own statement is the only thing that can name the workspace rule F1.1057 made it write.
    const codexCapabilities = {
      ...DEFAULT_COMPOSER_CAPABILITIES,
      connection: { switchable: false, activeRuntime: 'codex-runtime' as const },
    }
    const codexCard = (overrides: Partial<PermissionRequestData>) => renderCard(
      bashRequest({ type: undefined, toolName: 'shell', origin: 'codex_approval', ...overrides }), 'default', { capabilities: codexCapabilities },
    )
    expect(permissionRememberScope({ type: undefined, activeRuntime: 'codex-runtime', alwaysAllowScope: 'workspace' })).toBe('workspace')
    const saved = codexCard({ alwaysAllowScope: 'workspace' })
    expect(saved).toContain('chat.permissionRemember.workspace')
    expect(saved).not.toContain('chat.permissionRemember.session')
    // BOUNDARY: no statement (a file change, a sandbox-retained command, no proposed prefix) — the
    // session sentence, which is what codex's own acceptForSession gives.
    expect(permissionRememberScope({ type: undefined, activeRuntime: 'codex-runtime' })).toBe('session')
    const sessionOnly = codexCard({})
    expect(sessionOnly).toContain('chat.permissionRemember.session')
    expect(sessionOnly).not.toContain('chat.permissionRemember.workspace')
  })
})

/**
 * D1.262 — Always Allow stops promising what the product never grants.
 *
 * RS-54 pressed it on `curl -s https://example.invalid/` on `claude-gateway` in
 * `default`: the card cleared and no rule was written, while `touch` in the same
 * case wrote `Bash(touch *)` — the control. The refusal is the host's and it is
 * the same on every runtime, so the card says so rather than hiding the button:
 * the answer still allows the call, and on curl/wget it still whitelists the
 * domain for the session.
 */
describe('PermissionRequest — a dangerous command is never remembered (D1.262)', () => {
  test('the predicate answers for both of the host\'s spellings', () => {
    // Positive: the base command itself.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'rm -rf build' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'curl -s https://example.invalid/' })).toBe(true)
    // Positive: the LITERAL head, which is `persistBashAlwaysAllowRule`'s own
    // second test — `sudo apt install x` has base command `apt`, and a rule
    // keyed on that would grant unprivileged `apt` forever off one privileged
    // answer.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'sudo apt install ripgrep' })).toBe(true)
    // Case-folded, as the host folds it.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'RM -rf build' })).toBe(true)
    // Negative: the control from the same sitting.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'touch a.txt' })).toBe(false)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'npm run build' })).toBe(false)
    // Boundary: an unparseable command is refused by the host too, so the card
    // takes the weaker promise; a non-Bash card is not this rule's business.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: '   ' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'file_write', command: 'rm -rf build' })).toBe(false)
    expect(alwaysAllowIsSessionOnly({ type: 'worktree_setup', command: 'rm -rf build' })).toBe(false)
  })

  test('D1.285 — the four two-word names, and the narrowed rule that is still worth a click', () => {
    // Positive: the entries that matched NOWHERE until D1.285, here and in the
    // host alike. The host now persists nothing for them.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git push origin main' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git reset --hard HEAD~1' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git rebase main' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'GIT Checkout -f .' })).toBe(true)
    // Positive: a second token that cannot narrow the key. `Bash(git -C *)`
    // would cover the pushes again, so the host writes nothing — and a bare
    // `git` has no second token at all.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git -C /somewhere push origin main' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git' })).toBe(true)
    // NEGATIVE, and it is the one that keeps the card honest in the other
    // direction: a safe subcommand still buys a repository rule, narrowed to
    // `Bash(git status *)`. Saying "session only" here would under-promise.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git status --short' })).toBe(false)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git log' })).toBe(false)
  })

  test('D1.402 + D1.403 — the resolved head, and a head that runs its own argument', () => {
    // D1.402 — the host's floor now resolves a path-qualified or
    // assignment-prefixed head before looking it up, so the card must stop
    // offering the repository hint for these. Driven at HEAD `dfc462e3c` they
    // all answered `false` here while the plain spellings answered `true`, and
    // the host obliged with `Bash(/bin/rm *)`.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: '/bin/rm -rf dist' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: '/usr/bin/sudo apt install ripgrep' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: '/usr/bin/git push origin main' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'NODE_ENV=production rm -rf dist' })).toBe(true)
    // D1.403 — a shell or exec wrapper. `bash -c "rm -rf dist"` was shown with
    // the repository hint and the host wrote `Bash(bash *)`, which then matched
    // `bash -c '<any script at all>'` for ever in that repository.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'bash -c "rm -rf dist"' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'bash -c "echo hi"' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'sh -c "npm test"' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'zsh -lc "git push origin main"' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'env FOO=1 npm test' })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: '/bin/bash -c "echo hi"' })).toBe(true)
    // NEGATIVE, so this is not "the mirror started saying session-only about
    // everything": the host still writes a repository rule for these, and a
    // name that merely CONTAINS an interpreter name is not one.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: '/usr/local/bin/npm test' })).toBe(false)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'bashfoo --help' })).toBe(false)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'shellcheck x.sh' })).toBe(false)
  })

  test('UA12.84 follow-up — the card answers from the host\'s own key and rule-text functions', () => {
    // Positive: a leading-words line holding a quoted `*`. Since UA12.84 the host
    // persists a leading-words key as the exact line, and a line with a `*` would
    // be read back as a wildcard, so `bashAlwaysAllowRuleContent` returns null and
    // `persistBashAlwaysAllowRule` writes nothing. The card used to answer `false`
    // here and promise a repository rule on Pi.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: "git log -- '*.ts'" })).toBe(true)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: "echo '*'" })).toBe(true)
    // Positive: no key at all (`bashSessionWhitelistKey` is null), so the host
    // stops at "no key narrows it". This pin used to say `false` under D1.402.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'NODE_ENV=production npm test' })).toBe(true)
    // NEGATIVE: the same line without the `*` still buys the exact-line rule, and
    // a by-name key keeps `<name> *` whatever the line holds, so a quoted `*`
    // after `touch` is still worth the repository hint.
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: 'git log -- src/a.ts' })).toBe(false)
    expect(alwaysAllowIsSessionOnly({ type: 'bash', command: "touch '*.txt'" })).toBe(false)
  })

  // D1.284 — the set-equality pin that used to sit here is GONE, and its
  // deletion is the row: it read `permission-manager.ts` as source text to
  // prove two hand-kept copies of one list still agreed. There is one list now
  // (`@nessy-agent/shared/agent/core/dangerous-commands`), imported by the card
  // and by `PermissionManager` alike, so the thing it guarded cannot happen.

  test('the card RELABELS the button and changes the sentence — including where the runtime says repository', () => {
    const dangerousOnPi = renderCard(bashRequest({ command: 'rm -rf build', origin: 'host_gate' }), 'default', {
      capabilities: {
        ...DEFAULT_COMPOSER_CAPABILITIES,
        connection: { switchable: false, activeRuntime: 'pi' },
      },
    })
    expect(dangerousOnPi).toContain('chat.permissionAlwaysAllow.sessionOnly')
    expect(dangerousOnPi).toContain('chat.permissionRemember.dangerous')
    // The two sentences it replaces, and the literal label it replaces. Pi is
    // the arm that makes this test worth having: its scope is `repository`, so
    // without the D1.262 branch this card would promise a rule the host refuses
    // to write.
    expect(dangerousOnPi).not.toContain('chat.permissionRemember.repository')
    expect(dangerousOnPi).not.toMatch(/chat\.permissionAlwaysAllow(?!\.)/)
  })

  test('and an ordinary command keeps every word it had — the control', () => {
    const ordinaryOnPi = renderCard(bashRequest({ command: 'touch a.txt', origin: 'host_gate' }), 'default', {
      capabilities: {
        ...DEFAULT_COMPOSER_CAPABILITIES,
        connection: { switchable: false, activeRuntime: 'pi' },
      },
    })
    expect(ordinaryOnPi).toMatch(/chat\.permissionAlwaysAllow(?!\.)/)
    expect(ordinaryOnPi).toContain('chat.permissionRemember.repository')
    expect(ordinaryOnPi).not.toContain('chat.permissionAlwaysAllow.sessionOnly')
    expect(ordinaryOnPi).not.toContain('chat.permissionRemember.dangerous')
  })
})

/**
 * F1.1219 — the Claude Agent SDK's `defaultToNo` hint, rendered.
 *
 * `agent-sdk/typescript.md#canusetool`: *"When `true`, a single stray keystroke
 * must not approve this request: open your prompt on its decline option, don't
 * pre-select approve, and offer no one-key approve shortcut."* The card has no
 * approve key binding at all, so the two clauses it can break are the focus and
 * the default styling — both asserted on the markup, with today's card as the
 * control. (`suppressAlwaysAllowRule` arrives as `noAlwaysAllow`, whose button
 * rule the C3.365 and D1.262 blocks above already cover.)
 */
describe('PermissionRequest — a defaultToNo ask opens on Deny (F1.1219)', () => {
  /** The opening tag of the button carrying `marker`, or '' when none does. */
  function buttonTag(html: string, marker: string): string {
    return html.match(new RegExp(`<button[^>]*${marker}[^>]*>`))?.[0] ?? ''
  }
  const ALLOW = 'data-tutorial="permission-allow-button"'
  const DENY = 'data-testid="permission-deny"'
  /**
   * The solid primary of `ui/button.tsx` — `bg-foreground text-background` until UB13.10 made the
   * primary the accent solid, which left this constant naming a class no button draws (the control
   * below went red with the old card); UB14.24 re-reads it from today's variant.
   */
  const FILLED = 'bg-accent-solid text-on-accent'

  test('focus starts on Deny, and Allow is not drawn as the default', () => {
    const html = renderCard(bashRequest({ origin: 'claude_native', defaultToNo: true }), 'default')
    expect(buttonTag(html, DENY)).toContain('autofocus')
    const allow = buttonTag(html, ALLOW)
    expect(allow).not.toBe('')
    expect(allow).not.toContain(FILLED)
    // UB14.24 — on the decision anatomy the declined default is the raised secondary.
    expect(allow).toContain('data-variant="secondary"')
    expect(allow).not.toContain('autofocus')
  })

  // CL-2 follow-up 2 — the shell gives each open panel its own composer, and
  // only the focused panel may take focus (ChatDisplay's textarea rule). A
  // `defaultToNo` card raised in a panel the user is not in must leave focus
  // where the user is typing, or their next Space or Enter declines an ask
  // they never saw. Allow stays outline there: nothing pre-selects approve.
  test('a card in a panel the user is not in takes no focus, and still does not draw Allow as the default', () => {
    const html = renderCard(bashRequest({ origin: 'claude_native', defaultToNo: true }), 'default', {
      appShell: { isFocusedPanel: false },
    })
    expect(buttonTag(html, DENY)).not.toBe('')
    expect(html).not.toContain('autofocus')
    expect(buttonTag(html, ALLOW)).not.toContain(FILLED)
  })

  test('a card in the focused panel opens on Deny — the boundary', () => {
    const html = renderCard(bashRequest({ origin: 'claude_native', defaultToNo: true }), 'default', {
      appShell: { isFocusedPanel: true },
    })
    expect(buttonTag(html, DENY)).toContain('autofocus')
  })

  test('without the hint the card is today\'s — the control', () => {
    const html = renderCard(bashRequest({ origin: 'claude_native' }), 'default')
    expect(buttonTag(html, DENY)).not.toBe('')
    expect(buttonTag(html, DENY)).not.toContain('autofocus')
    expect(buttonTag(html, ALLOW)).toContain(FILLED)
    expect(buttonTag(html, ALLOW)).toContain('data-variant="primary"')
    expect(html).not.toContain('autofocus')
  })
})

/**
 * F1.1219 follow-up — every queued ask mounts its OWN card.
 *
 * React applies `autoFocus` only when the element mounts. The renderer keeps a
 * real queue per session (`lib/pending-permissions.ts`) and shows its head, and
 * the input layer above is keyed by the input TYPE only, so without a per-request
 * key answering ask A swaps ask B into the same card instance: a `defaultToNo`
 * B would keep focus on the Allow button just clicked, and one stray Enter
 * approves it. There is no DOM test environment here, so the router's element
 * key — what makes React remount — is the observable.
 */
describe('StructuredInput — each permission ask mounts its own card (F1.1219 follow-up)', () => {
  const route = (request: PermissionRequestData) =>
    StructuredInput({ state: { type: 'permission', data: request }, onResponse: () => {} }) as React.ReactElement

  test('the next queued ask, carrying defaultToNo, gets a fresh card', () => {
    const first = route(bashRequest({ origin: 'claude_native', requestId: 'perm-a' }))
    const next = route(bashRequest({ origin: 'claude_native', requestId: 'perm-b', defaultToNo: true }))
    expect(first.key).toBe('perm-a')
    expect(next.key).toBe('perm-b')
  })

  test('a re-render of the same ask keeps its card (a typed note survives)', () => {
    const once = route(bashRequest({ requestId: 'perm-a' }))
    const again = route(bashRequest({ requestId: 'perm-a', description: 'Run the build again' }))
    expect(again.key).toBe(once.key)
  })
})

/**
 * UA12.105 `[permissions]` — the UA12.84 re-check's two residue-wording notes: the
 * sentence under a Bash card says exactly what an answer saves when that is
 * NOTHING or a SESSION KEY ONLY.
 *
 * - A Bash card with no Always Allow (the host sends `noAlwaysAllow` because
 *   `bashRememberKey` mints no key: `rm -rf build`, `npm --silent test`) read
 *   "applies to this one connection" — the Monitor WebSocket copy.
 * - A line holding a quoted `*` (`git log -- '*.ts'`) keeps its session key but no
 *   rule for later can spell it (UA12.70 follow-up); it read the dangerous-command
 *   sentence, "This command is never saved for later", beside a button that does
 *   remember it for the session.
 */
describe('PermissionRequest — the sentence names what is saved: nothing, or a session key only (UA12.105)', () => {
  const onPi = {
    capabilities: { ...DEFAULT_COMPOSER_CAPABILITIES, connection: { switchable: false, activeRuntime: 'pi' as const } },
  }

  test('a Bash card with no Always Allow says nothing is remembered, not "this one connection"', () => {
    for (const command of ['rm -rf build', 'npm --silent test']) {
      const card = renderCard(bashRequest({ command, origin: 'host_gate', noAlwaysAllow: true }), 'default', onPi)
      expect(card, command).toContain('chat.permissionRemember.bashOnce')
      expect(card, command).not.toContain('chat.permissionRemember.never')
      expect(card, command).not.toMatch(/chat\.permissionAlwaysAllow(?!\.)/)
    }
    // CONTROL: a non-Bash card that cannot be remembered keeps its own sentence.
    const monitor = renderCard(bashRequest({ type: undefined, toolName: 'Monitor', command: undefined, noAlwaysAllow: true }), 'default', onPi)
    expect(monitor).toContain('chat.permissionRemember.never')
    expect(monitor).not.toContain('chat.permissionRemember.bashOnce')
  })

  test('a quoted-* line says it is remembered for the session only, and why nothing is saved for later', () => {
    expect(alwaysAllowKeepsSessionKeyOnly({ type: 'bash', command: "git log -- '*.ts'" })).toBe(true)
    expect(alwaysAllowKeepsSessionKeyOnly({ type: 'bash', command: 'node -e "x*"' })).toBe(true)
    const card = renderCard(bashRequest({ command: "git log -- '*.ts'", origin: 'host_gate' }), 'default', onPi)
    expect(card).toContain('chat.permissionAlwaysAllow.sessionOnly')
    expect(card).toContain('chat.permissionRemember.quotedStar')
    expect(card).not.toContain('chat.permissionRemember.dangerous')
    expect(card).not.toContain('chat.permissionRemember.repository')
  })

  test('CONTROLS: a dangerous line keeps the dangerous sentence; a plain line and a by-name `*` keep the repository one', () => {
    for (const command of ['rm -rf build', 'curl https://example.invalid/', 'NODE_ENV=production npm test', 'git log -- src/a.ts', "touch '*.txt'"]) {
      expect(alwaysAllowKeepsSessionKeyOnly({ type: 'bash', command }), command).toBe(false)
    }
    expect(alwaysAllowKeepsSessionKeyOnly({ type: undefined, command: "git log -- '*.ts'" })).toBe(false)
    const curl = renderCard(bashRequest({ command: 'curl https://example.invalid/', origin: 'host_gate' }), 'default', onPi)
    expect(curl).toContain('chat.permissionRemember.dangerous')
    expect(curl).not.toContain('chat.permissionRemember.quotedStar')
    const plain = renderCard(bashRequest({ command: 'git log -- src/a.ts', origin: 'host_gate' }), 'default', onPi)
    expect(plain).toContain('chat.permissionRemember.repository')
    expect(plain).not.toContain('chat.permissionRemember.quotedStar')
  })

  test('the two sentences exist in every locale and name what is saved', () => {
    const read = (lang: string) => JSON.parse(readFileSync(new URL(`../../../../../../../../../packages/shared/src/i18n/locales/${lang}.json`, import.meta.url), 'utf-8')) as Record<string, string>
    for (const lang of ['en', 'ru']) {
      const messages = read(lang)
      expect(messages['chat.permissionRemember.bashOnce'], lang).toBeTruthy()
      expect(messages['chat.permissionRemember.quotedStar'], lang).toBeTruthy()
    }
    const en = read('en')
    expect(en['chat.permissionRemember.bashOnce']).toContain('Nothing is remembered')
    expect(en['chat.permissionRemember.quotedStar']).toContain('this session only')
    expect(en['chat.permissionRemember.quotedStar']).toContain('nothing is saved for later')
  })
})

describe('PermissionRequest — decision-model risk badges (UB6.10)', () => {
  test('positive — a card carrying risks shows the chips and takes the danger tone', () => {
    const markup = renderCard(bashRequest({ command: 'rm -rf dist', risks: ['deletes'] }), 'default')
    expect(markup).toContain('chat.permissionRisk.deletes')
    expect(markup).toContain('bg-destructive-tint')
    expect(markup).toContain('chat.permissionRiskHint')
    // The danger tone (UB14.24: on the decision anatomy): the card's tone, the
    // destructive ring of a standalone card and the destructive tile; the info
    // ring and tile gone.
    expect(markup).toContain('data-decision-tone="danger"')
    expect(markup).toContain('ring-[color:var(--destructive-border)]')
    expect(markup).toContain('bg-destructive-tint text-destructive')
    expect(markup).not.toContain('ring-[color:var(--info-border)]')
    expect(markup).not.toContain('bg-info-tint text-info')
    // The chips sit in their own slot BEFORE the command preview — the buttons
    // keep their slot either way (the fixed-slot control, below).
    const chipAt = markup.indexOf('chat.permissionRisk.deletes')
    const commandAt = markup.indexOf('rm -rf dist')
    expect(chipAt).toBeGreaterThan(-1)
    expect(commandAt).toBeGreaterThan(chipAt)
  })

  test('a risk name this client cannot label is dropped, not rendered raw', () => {
    const markup = renderCard(bashRequest({ risks: ['deletes', 'nuclear'] as never }), 'default')
    expect(markup).toContain('chat.permissionRisk.deletes')
    expect(markup).not.toContain('nuclear')
    // One chip span, not two (UB14.24: the danger tile carries the tint as well,
    // so the chips are counted by their own pill class).
    expect(markup.split('rounded-full bg-destructive-tint').length - 1).toBe(1)
  })

  test('control — no risks (the layer off or unsure): no slot, the info tone, and the buttons unchanged', () => {
    const plain = renderCard(bashRequest(), 'default')
    expect(plain).not.toContain('chat.permissionRisk')
    expect(plain).toContain('data-decision-tone="info"')
    expect(plain).toContain('ring-[color:var(--info-border)]')
    expect(plain).not.toContain('bg-destructive-tint')
    // The fixed slot: the action row is byte-identical in its shape — the same
    // Allow and Deny hooks exist with and without the chips, so nothing
    // reflows under the cursor and the outcome wiring is untouched.
    const withRisks = renderCard(bashRequest({ risks: ['deletes'] }), 'default')
    for (const marker of ['data-tutorial="permission-allow-button"', 'data-testid="permission-deny"']) {
      expect(plain).toContain(marker)
      expect(withRisks).toContain(marker)
    }
  })
})

/**
 * UB14.24 — the card on v0.15.1's decision anatomy, LOOK only: every variant keeps its answers and its
 * sentence, now placed in `DecisionDetails` / `DecisionActions` / `DecisionFoot`. The regions are found by
 * the anatomy's OWN opening tags (rendered here from `DecisionCard.tsx`, never copied), so a variant that
 * drew its answers outside the actions row — or its sentence outside the foot — fails on position.
 */
describe('PermissionRequest — on the decision anatomy, every variant kept (UB14.24)', () => {
  const MARK = '§'
  /** The first opening tag a primitive renders around `MARK`. */
  const openTag = (node: React.ReactElement): string => {
    const tag = renderToStaticMarkup(node).match(/^<[a-z]+[^>]*>/)?.[0] ?? ''
    expect(tag).not.toBe('')
    return tag
  }
  const DETAILS = openTag(<DecisionDetails>{MARK}</DecisionDetails>)
  const ACTIONS = openTag(<DecisionActions>{MARK}</DecisionActions>)
  const FOOT = openTag(<DecisionFoot>{MARK}</DecisionFoot>)
  const PREVIEW = openTag(<DecisionPreview>{MARK}</DecisionPreview>)
  const SPACER = renderToStaticMarkup(<DecisionSpacer />)

  /** The card's three regions, in the anatomy's order (each exactly once). */
  function regions(markup: string): { details: string; actions: string; foot: string } {
    for (const tag of [DETAILS, ACTIONS, FOOT]) expect(markup.split(tag).length - 1).toBe(1)
    const details = markup.indexOf(DETAILS)
    const actions = markup.indexOf(ACTIONS)
    const foot = markup.indexOf(FOOT)
    expect(details).toBeLessThan(actions)
    expect(actions).toBeLessThan(foot)
    return { details: markup.slice(details, actions), actions: markup.slice(actions, foot), foot: markup.slice(foot) }
  }
  /** The opening tag of the button carrying `marker` (an attribute or its label). */
  const buttonWith = (html: string, marker: string): string =>
    html.match(new RegExp(`<button[^>]*${marker}[^>]*>`))?.[0]
      ?? html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${marker}`))?.[0]?.match(/^<button[^>]*>/)?.[0]
      ?? ''

  test('POSITIVE — an outside-read card renders its three answers inside DecisionActions: keep allowing primary, the refusals ghosts after the spacer', () => {
    const markup = renderCard(
      bashRequest({
        type: 'file_write',
        command: undefined,
        outsideWorkingDirectoryRead: { path: '/etc/hosts', tool: 'Read', workingDirectory: '/Users/dev/project' },
      }),
      'auto',
    )
    const { details, actions, foot } = regions(markup)
    const ids = ['outside-read-keep-allowing', 'outside-read-block', 'outside-read-ask-again']
    const at = ids.map(id => actions.indexOf(`data-testid="${id}"`))
    for (const [i, id] of ids.entries()) {
      expect({ id, inActions: at[i]! > -1, inDetails: details.includes(id) }).toEqual({ id, inActions: true, inDetails: false })
    }
    // The page's order is kept, with the spacer between the affirmative answer and the two refusals.
    expect(at[0]!).toBeLessThan(actions.indexOf(SPACER))
    expect(actions.indexOf(SPACER)).toBeLessThan(at[1]!)
    expect(at[1]!).toBeLessThan(at[2]!)
    expect(buttonWith(actions, 'data-testid="outside-read-keep-allowing"')).toContain('data-variant="primary"')
    for (const id of ids.slice(1)) expect(buttonWith(actions, `data-testid="${id}"`)).toContain('data-variant="ghost"')
    // The path is the decision: it sits in the sunken well, inside the details; the hint is the foot's.
    expect(details).toContain(`${PREVIEW}/etc/hosts</div>`)
    expect(foot).toContain('chat.outsideRead.hint')
    expect(actions).not.toContain('chat.outsideRead.hint')
  })

  test('POSITIVE — the auto-mode switch shows when offered, inside the actions, a secondary between Allow and Always Allow', () => {
    const { actions } = regions(renderCard(bashRequest({ origin: 'claude_native' }), 'default'))
    const allow = actions.indexOf('data-tutorial="permission-allow-button"')
    const toAuto = actions.indexOf('data-testid="permission-switch-to-auto"')
    const always = actions.search(/>chat\.permissionAlwaysAllow</)
    const deny = actions.indexOf('data-testid="permission-deny"')
    expect(allow).toBeGreaterThan(-1)
    expect(toAuto).toBeGreaterThan(allow)
    expect(always).toBeGreaterThan(toAuto)
    expect(actions.indexOf(SPACER)).toBeGreaterThan(always)
    expect(deny).toBeGreaterThan(actions.indexOf(SPACER))
    expect(buttonWith(actions, 'data-testid="permission-switch-to-auto"')).toContain('data-variant="secondary"')
    expect(buttonWith(actions, '>chat\\.permissionAlwaysAllow<')).toContain('data-variant="secondary"')
    expect(buttonWith(actions, 'data-testid="permission-deny"')).toContain('data-variant="ghost"')
    // BOUNDARY: the same card in plan mode is not offered the switch, and its row is otherwise the same.
    const planned = regions(renderCard(bashRequest({ origin: 'claude_native' }), 'plan')).actions
    expect(planned).not.toContain('permission-switch-to-auto')
    expect(planned).toMatch(/>chat\.permissionAlwaysAllow</)
  })

  test('NEGATIVE (control) — a worktree-cleanup card renders no Always Allow; an ordinary card renders it in the same row', () => {
    const cleanup = regions(renderCard(bashRequest({ type: 'worktree_cleanup', toolName: 'WorktreeCleanup', command: undefined }), 'default'))
    expect(cleanup.actions).not.toMatch(/chat\.permissionAlwaysAllow/)
    expect(buttonWith(cleanup.actions, 'data-tutorial="permission-allow-button"')).toContain('data-variant="primary"')
    expect(cleanup.actions).toContain('worktree.cleanup.remove')
    // The KEEP half is the refusal's ghost, after the spacer — no dashed destructive treatment.
    expect(buttonWith(cleanup.actions, 'data-testid="permission-deny"')).toContain('data-variant="ghost"')
    expect(cleanup.actions.indexOf(SPACER)).toBeLessThan(cleanup.actions.indexOf('worktree.cleanup.keep'))
    expect(cleanup.foot).toContain('worktree.cleanup.hint')
    expect(cleanup.foot).not.toContain('lucide-refresh-cw') // nothing is remembered, so no repeat glyph
    const ordinary = regions(renderCard(bashRequest({ origin: 'host_gate' }), 'default'))
    expect(ordinary.actions).toMatch(/>chat\.permissionAlwaysAllow</)
    expect(ordinary.foot).toContain('lucide-refresh-cw')
  })

  test('the card IS the decision card: tone and tutorial hook on one element; standalone draws the material, hosted does not; the old tinted block is gone', () => {
    const standalone = renderCard(bashRequest(), 'default')
    const root = standalone.match(/^<div[^>]*>/)?.[0] ?? ''
    for (const part of ['data-decision-tone="info"', 'data-tutorial="permission-banner"', 'rounded-xl', 'bg-raised', 'shadow-elev-2']) {
      expect(root).toContain(part)
    }
    const hosted = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <ComposerCapabilitiesProvider value={DEFAULT_COMPOSER_CAPABILITIES}>
          <PermissionRequest request={bashRequest()} onResponse={() => {}} unstyled />
        </ComposerCapabilitiesProvider>
      </I18nextProvider>,
    )
    const hostedRoot = hosted.match(/^<div[^>]*>/)?.[0] ?? ''
    expect(hostedRoot).toContain('data-decision-tone="info"')
    for (const part of ['shadow-elev-2', 'ring-1', 'bg-raised']) expect(hostedRoot).not.toContain(part)
    for (const old of ['bg-info/5', 'border-info/30', 'rounded-[8px]', 'border-dashed', 'shadow-middle']) {
      expect({ old, standalone: standalone.includes(old), hosted: hosted.includes(old) }).toEqual({ old, standalone: false, hosted: false })
    }
    // The tool name is in mono, as upstream draws it; our "Tool:" key keeps its colon.
    expect(standalone).toContain('chat.permissionTool:</span> <span class="font-mono text-mono-ui text-foreground">Bash</span>')
  })

  test('the subagent label leads the details and the impact block sits above the command well, all inside DecisionDetails', () => {
    const { details } = regions(renderCard(
      bashRequest({ agentLabel: 'reviewer #2', impact: 'Runs outside the sandbox.', command: 'rsync -a ./dist/ host:/srv/' }),
      'default',
    ))
    const agent = details.indexOf('reviewer #2')
    const tool = details.indexOf('chat.permissionTool')
    const impact = details.indexOf('Runs outside the sandbox.')
    const command = details.indexOf(`${PREVIEW}rsync -a ./dist/ host:/srv/</div>`)
    expect(agent).toBeGreaterThan(-1)
    expect(tool).toBeGreaterThan(agent)
    expect(impact).toBeGreaterThan(tool)
    expect(command).toBeGreaterThan(impact)
    expect(details).toContain('chat.permissionFromAgent')
  })
})
