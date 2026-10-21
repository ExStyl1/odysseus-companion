/**
 * Ours (no upstream counterpart: v0.15.1's `structured/` has no ask-user card). UB14.25 restyles it onto
 * v0.15.1's decision anatomy (`./DecisionCard`, UB14.20; spec §7.6): the info tile and title, the question and
 * its answers in the indented details, the answer that moves the user forward as the primary (Submit on a
 * batched card, the free-text Send), the server's options as raised answer rows, Cancel the ghost after the
 * spacer, and the auto-continue countdown in the quiet foot. Restyle only: every answer envelope, the
 * multi-question / multi-select / "Other" / general-reply behaviour (R7), the option preview (P6.471), the
 * URL-consent panel (`elicitation.md`) and the host-anchored countdown (F1.818) are unchanged. The hooks the
 * CDP harness reads stay: `data-tutorial="ask-user-banner"`, the options in one `grid gap-2` whose buttons are
 * its direct children (`scripts/cdp/lib/ask-user.ts`), and `data-testid="url-consent"`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Globe, MessageCircleQuestion, Send, Timer, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { AskUserAnswer, AskUserQuestionItem, AskUserUrlConsent, PermissionRequest as PermissionRequestType } from '../../../../../shared/types'
import type { PermissionResponse } from './types'
import {
  DECISION_ACTION,
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionFoot,
  DecisionHeader,
  DecisionSpacer,
} from './DecisionCard'

/** An answer row: wraps, left-aligned, at least a 32px control tall (UB14.25). */
const ANSWER_ROW = 'h-auto min-h-control-lg w-full justify-start whitespace-normal py-1.5 text-left'

interface AskUserRequestProps {
  request: PermissionRequestType
  onResponse: (response: PermissionResponse) => void
  unstyled?: boolean
}

export interface BatchedQuestionSelection {
  selected: string[]
  other?: string
}

/** Countdown becomes visible only for the last 20 s before auto-continue. */
export const ASK_USER_COUNTDOWN_WINDOW_MS = 20_000

/**
 * `askUserQuestionTimeout` on-screen countdown (settings.md): `null` while no
 * timeout is configured (the default — questions never expire) or while more
 * than 20 s remain; otherwise the whole seconds left, clamped at 0.
 */
export function askUserAutoContinueCountdown(
  timeoutMs: number | undefined,
  elapsedMs: number,
): number | null {
  if (timeoutMs === undefined) return null
  const remaining = timeoutMs - elapsedMs
  if (remaining > ASK_USER_COUNTDOWN_WINDOW_MS) return null
  return Math.max(0, Math.ceil(remaining / 1000))
}

/**
 * Arms the auto-continue countdown (ticks the last 20 s, fires `onExpire` once at
 * the deadline). The AUTHORITATIVE clock is the host's (F1.818 — armed when the
 * question was asked); `askedAt` anchors this countdown to that same deadline.
 */
function useAskUserAutoContinue(timeoutMs: number | undefined, onExpire: () => void, askedAt?: number): number | null {
  const [countdown, setCountdown] = useState<number | null>(() => askUserAutoContinueCountdown(timeoutMs, 0))
  const expiredRef = useRef(false)
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire

  useEffect(() => {
    if (timeoutMs === undefined) return
    const startedAt = askedAt ?? Date.now()
    const tick = () => {
      const elapsed = Date.now() - startedAt
      setCountdown(askUserAutoContinueCountdown(timeoutMs, elapsed))
      if (elapsed >= timeoutMs && !expiredRef.current) {
        expiredRef.current = true
        clearInterval(interval)
        onExpireRef.current()
      }
    }
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [timeoutMs, askedAt])

  return countdown
}

/**
 * Build the documented AskUserQuestion answer envelope
 * (user-input.md "Response format"): answers keyed by question TEXT → the
 * selected label, an array of labels for multi-select, or the user's own
 * "Other" text; a non-empty general `response` replaces the per-question list.
 */
export function buildBatchedAskUserAnswer(
  questions: AskUserQuestionItem[],
  selections: Record<string, BatchedQuestionSelection>,
  response?: string,
): Extract<AskUserAnswer, { type: 'batched' }> {
  const trimmedResponse = response?.trim()
  if (trimmedResponse) {
    return { type: 'batched', answers: {}, response: trimmedResponse }
  }
  const answers: Record<string, string | string[]> = {}
  for (const question of questions) {
    const selection = selections[question.question]
    if (!selection) continue
    const other = selection.other?.trim()
    if (other) {
      answers[question.question] = other
      continue
    }
    if (selection.selected.length === 0) continue
    answers[question.question] = question.multiSelect
      ? selection.selected
      : selection.selected[0]!
  }
  return { type: 'batched', answers }
}

/**
 * The URL a URL-mode MCP elicitation is asking consent to open.
 *
 * Three things have to be true of this panel at once, and they pull against
 * each other, so they are spelled out:
 *
 * - the FULL url stays on screen and untruncated (`elicitation.md:726`), which
 *   is why it wraps and breaks rather than ellipsing;
 * - the registrable domain is the visually dominant element (`:729`), because
 *   that is the party the browser will actually talk to;
 * - the warnings (`:730`) sit ABOVE the buttons and have no dismiss control.
 *   This is a decision surface: making the warning easier to close than to read
 *   would defeat the reason it exists.
 */
function UrlConsentPanel({ consent }: { consent: AskUserUrlConsent }) {
  const { t } = useTranslation()
  const hasWarnings = consent.warnings.length > 0

  return (
    <div
      className={cn(
        'mt-2.5 space-y-2 rounded-md p-2.5 ring-1 ring-inset',
        hasWarnings
          ? 'bg-destructive-tint ring-[color:var(--destructive-border)]'
          : 'bg-sunken ring-separator'
      )}
      data-testid="url-consent"
    >
      <div className="space-y-1">
        <span className="flex items-center gap-1.5 text-label-sm font-medium text-tertiary [&_svg]:size-3.5 [&_svg]:shrink-0">
          <Globe />
          {t('chat.askUser.urlConsent.domainLabel')}
        </span>
        <p
          className="break-all text-label-lg font-semibold text-foreground"
          data-testid="url-consent-domain"
        >
          {consent.registrableDomain ?? consent.host}
        </p>
      </div>

      {hasWarnings && (
        <ul className="space-y-1.5" role="alert" data-testid="url-consent-warnings">
          {consent.warnings.map(warning => (
            <li
              key={warning.kind}
              className="flex items-start gap-1.5 text-label text-destructive [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              <TriangleAlert className="mt-[2px]" />
              <span className="min-w-0">
                {t(`chat.askUser.urlConsent.warning.${warning.kind}`)}
                {warning.kind === 'punycode' && consent.decodedHost && (
                  <span className="mt-0.5 block break-all font-mono text-mono-ui text-foreground">
                    {consent.decodedHost}
                  </span>
                )}
                {warning.kind === 'mixed-script' && warning.detail && (
                  <span className="mt-0.5 block text-label-sm text-secondary">
                    {warning.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1">
        <span className="text-label-sm font-medium text-tertiary">
          {t('chat.askUser.urlConsent.fullUrlLabel')}
        </span>
        <p
          className="break-all font-mono text-mono-ui text-secondary"
          data-testid="url-consent-full"
        >
          {consent.url}
        </p>
      </div>
    </div>
  )
}

/**
 * The batched (multi-question) card's body, actions and foot. It owns the selections, so it draws its own
 * `DecisionActions` (Submit primary · spacer · Cancel ghost) inside the parent's `DecisionCard`.
 */
function BatchedAskUser({
  header,
  questions,
  timeoutMs,
  askedAt,
  onResponse,
  onCancel,
}: {
  header: ReactNode
  questions: AskUserQuestionItem[]
  timeoutMs?: number
  askedAt?: number
  onResponse: (response: PermissionResponse) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [selections, setSelections] = useState<Record<string, BatchedQuestionSelection>>({})
  const [response, setResponse] = useState('')
  const latest = useRef({ selections, response })
  latest.current = { selections, response }

  // Expiry submits whatever is already selected, flagged as auto-continued —
  // the documented away-note flow, never an error. (The authoritative clock is
  // the host's since F1.818; with a host that stamps `askedAt` the host always
  // fires first and this late expiry lands on a settled id.)
  const countdown = useAskUserAutoContinue(timeoutMs, () => {
    onResponse({
      type: 'permission',
      allowed: true,
      alwaysAllow: false,
      options: {
        askUserAnswer: {
          ...buildBatchedAskUserAnswer(questions, latest.current.selections, latest.current.response),
          autoContinued: true,
        },
      },
    })
  }, askedAt)

  const toggleOption = (question: AskUserQuestionItem, label: string) => {
    setSelections(previous => {
      const current = previous[question.question] ?? { selected: [] }
      const selected = question.multiSelect
        ? current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        : current.selected.includes(label) ? [] : [label]
      return { ...previous, [question.question]: { ...current, selected } }
    })
  }

  const setOther = (question: AskUserQuestionItem, other: string) => {
    setSelections(previous => ({
      ...previous,
      [question.question]: { ...(previous[question.question] ?? { selected: [] }), other },
    }))
  }

  const answer = buildBatchedAskUserAnswer(questions, selections, response)
  const canSubmit = answer.response !== undefined || Object.keys(answer.answers).length > 0

  const submit = () => {
    if (!canSubmit) return
    onResponse({
      type: 'permission',
      allowed: true,
      alwaysAllow: false,
      options: { askUserAnswer: answer },
    })
  }

  return (
    <>
      <DecisionBody>
        {header}
        <DecisionDetails>
          <div className="space-y-4">
            {questions.map(question => {
              const selection = selections[question.question] ?? { selected: [] }
              return (
                <div key={question.question} className="space-y-2">
                  <div className="space-y-1">
                    {question.header && (
                      <span className="inline-flex h-5 items-center rounded-full bg-info-tint px-2 text-label-sm font-medium text-info">
                        {question.header}
                      </span>
                    )}
                    <p className="text-label text-foreground">
                      {question.question}
                    </p>
                  </div>
                  <div className="grid gap-2">
                    {question.options.map(option => {
                      const isSelected = selection.selected.includes(option.label)
                      return (
                        <div key={option.label} className="grid gap-1">
                        <Button
                          type="button"
                          size="lg"
                          variant="ghost"
                          aria-pressed={isSelected}
                          className={cn(
                            ANSWER_ROW,
                            'ring-1 ring-inset',
                            isSelected
                              ? 'bg-info-tint ring-[color:var(--info-border)] hover:bg-info-tint'
                              : 'ring-separator'
                          )}
                          onClick={() => toggleOption(question, option.label)}
                        >
                          <span className="flex w-full items-start gap-2">
                            {isSelected && <Check className="mt-[3px] size-3.5 shrink-0 text-info" />}
                            <span className="flex-1">
                              <span className="font-medium">{option.label}</span>
                              {option.description && (
                                <span className="block text-label-sm font-normal text-secondary">{option.description}</span>
                              )}
                            </span>
                          </span>
                        </Button>
                        {/* P6.471 — `preview` has been on the wire and produced by Pi's
                            `ask_user` since the tool shipped, and NOTHING rendered it:
                            this component read `label` and `description` only.

                            A MONOSPACE BOX, and that is the SDK's own instruction rather
                            than our compromise: `ToolConfig.askUserQuestion.previewFormat`
                            documents `'markdown'` as "Markdown/ASCII content (CLI
                            default, rendered in a monospace box)". A preview is a short
                            ASCII visual — a diff, a tree, a table — and running it
                            through the full markdown pipeline would reflow exactly the
                            alignment that carries its meaning.

                            Drawn BESIDE the button rather than inside it: a `<pre>` is a
                            block element, invalid inside a `<button>`, and a preview
                            wide enough to scroll must not swallow the click that picks
                            the option. UB14.25: the anatomy's sunken mono well, but it
                            scrolls sideways instead of wrapping (wrapping is the reflow). */}
                        {option.preview && (
                          <pre className="overflow-x-auto rounded-md bg-sunken px-2.5 py-1.5 font-mono text-mono-ui text-secondary ring-1 ring-inset ring-separator">
                            {option.preview}
                          </pre>
                        )}
                        </div>
                      )
                    })}
                  </div>
                  <Input
                    value={selection.other ?? ''}
                    onChange={event => setOther(question, event.target.value)}
                    placeholder={t('chat.askUser.otherPlaceholder')}
                    aria-label={`${t('chat.askUser.otherLabel')}: ${question.question}`}
                  />
                </div>
              )
            })}
          </div>

          <div className="mt-3 border-t border-separator pt-3">
            <Input
              value={response}
              onChange={event => setResponse(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submit()
              }}
              placeholder={t('chat.askUser.responsePlaceholder')}
              aria-label={t('chat.askUser.responseLabel')}
            />
          </div>
        </DecisionDetails>
      </DecisionBody>

      <DecisionActions>
        <Button
          type="button"
          size="lg"
          variant="primary"
          className={DECISION_ACTION}
          onClick={submit}
          disabled={!canSubmit}
        >
          {t('chat.askUser.submit')}
        </Button>
        <DecisionSpacer />
        <Button
          type="button"
          size="lg"
          variant="ghost"
          className={DECISION_ACTION}
          onClick={onCancel}
        >
          {t('chat.askUser.cancel')}
        </Button>
      </DecisionActions>

      {countdown !== null && (
        <DecisionFoot icon={<Timer />}>
          <span role="status">{t('chat.askUser.autoContinueCountdown', { seconds: countdown })}</span>
        </DecisionFoot>
      )}
    </>
  )
}

/**
 * The prompt text without the trailing full URL that URL-mode elicitation
 * appends for clients with no `urlConsent` support. When the panel is rendered
 * the URL is shown there, in full, with the domain called out — repeating it in
 * the message body would be a second, less legible copy of the same string.
 */
export function askUserMessageText(question: string, consent?: AskUserUrlConsent): string {
  if (!consent) return question
  const suffix = `\n\n${consent.url}`
  return question.endsWith(suffix) ? question.slice(0, -suffix.length) : question
}

export function AskUserRequest({ request, onResponse, unstyled = false }: AskUserRequestProps) {
  const { t } = useTranslation()
  const [freeText, setFreeText] = useState('')
  const askUser = request.askUser

  const batchedQuestions = askUser?.questions

  // Legacy single-question card: expiry auto-continues with no selections
  // (clicking an option answers immediately, so there is no partial state).
  const legacyCountdown = useAskUserAutoContinue(
    askUser && !batchedQuestions?.length ? askUser.timeoutMs : undefined,
    () => {
      onResponse({
        type: 'permission',
        allowed: true,
        alwaysAllow: false,
        options: { askUserAnswer: { type: 'batched', answers: {}, autoContinued: true } },
      })
    },
    askUser && !batchedQuestions?.length ? askUser.askedAt : undefined,
  )

  if (!askUser) return null

  const answerWithOption = (value: string, optionIndex: number) => {
    onResponse({
      type: 'permission',
      allowed: true,
      alwaysAllow: false,
      options: {
        askUserAnswer: {
          type: 'option',
          value,
          optionIndex,
        },
      },
    })
  }

  const answerWithFreeText = () => {
    const value = freeText.trim()
    if (!value) return
    onResponse({
      type: 'permission',
      allowed: true,
      alwaysAllow: false,
      options: {
        askUserAnswer: {
          type: 'free_text',
          value,
        },
      },
    })
  }

  const cancel = () => {
    onResponse({ type: 'permission', allowed: false, alwaysAllow: false })
  }

  const header = (
    <DecisionHeader tone="info" icon={<MessageCircleQuestion />} title={t('chat.askUser.title')} />
  )

  return (
    <DecisionCard tone="info" standalone={!unstyled} data-tutorial="ask-user-banner">
      {batchedQuestions?.length ? (
        <BatchedAskUser
          header={header}
          questions={batchedQuestions}
          timeoutMs={askUser.timeoutMs}
          askedAt={askUser.askedAt}
          onResponse={onResponse}
          onCancel={cancel}
        />
      ) : (
        <>
          <DecisionBody>
            {header}
            <DecisionDetails>
              <p className="text-label text-secondary">
                {askUserMessageText(askUser.question, askUser.urlConsent)}
              </p>

              {askUser.urlConsent && <UrlConsentPanel consent={askUser.urlConsent} />}

              {/* The server's options, each an answer on its own: one `grid gap-2` whose buttons are its
                  direct children — the CDP harness reads them as exactly that (`lib/ask-user.ts`). */}
              <div className="mt-3 grid gap-2">
                {askUser.options.map((option, index) => (
                  <Button
                    key={`${index}-${option}`}
                    type="button"
                    size="lg"
                    variant="secondary"
                    className={ANSWER_ROW}
                    onClick={() => answerWithOption(option, index)}
                  >
                    {option}
                  </Button>
                ))}
              </div>

              {askUser.allowFreeText && (
                <div className="mt-2 flex gap-2">
                  <Input
                    value={freeText}
                    onChange={event => setFreeText(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') answerWithFreeText()
                    }}
                    placeholder={t('chat.askUser.freeTextPlaceholder')}
                    aria-label={t('chat.askUser.freeTextLabel')}
                  />
                  <Button
                    type="button"
                    size="icon-lg"
                    variant="primary"
                    onClick={answerWithFreeText}
                    disabled={!freeText.trim()}
                    aria-label={t('chat.askUser.send')}
                  >
                    <Send />
                  </Button>
                </div>
              )}
            </DecisionDetails>
          </DecisionBody>

          <DecisionActions>
            <DecisionSpacer />
            <Button
              type="button"
              size="lg"
              variant="ghost"
              className={DECISION_ACTION}
              onClick={cancel}
            >
              {t('chat.askUser.cancel')}
            </Button>
          </DecisionActions>

          {legacyCountdown !== null && (
            <DecisionFoot icon={<Timer />}>
              <span role="status">{t('chat.askUser.autoContinueCountdown', { seconds: legacyCountdown })}</span>
            </DecisionFoot>
          )}
        </>
      )}
    </DecisionCard>
  )
}
