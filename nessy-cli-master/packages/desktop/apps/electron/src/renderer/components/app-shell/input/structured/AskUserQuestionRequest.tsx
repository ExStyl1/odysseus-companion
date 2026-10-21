import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, HelpCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PermissionRequest as PermissionRequestType } from '../../../../../shared/types'

interface AskUserQuestionRequestProps {
  request: PermissionRequestType
  onSubmit: (answers: Record<string, string>) => void
  onCancel: () => void
  /** When true, removes container styling (shadow, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
}

type AskUserQuestion = NonNullable<PermissionRequestType['questions']>[number]

function answerForQuestion(question: AskUserQuestion | undefined, index: number, selectedOptions: Record<number, string[]>, customInputs: Record<number, string>): string | undefined {
  if (!question) return undefined
  const selected = selectedOptions[index] ?? []
  const custom = customInputs[index]?.trim()
  if (!question.multiSelect) return custom || selected[0]

  const answers = custom ? [...selected, custom] : selected
  return answers.length > 0 ? answers.join(', ') : undefined
}

export function AskUserQuestionRequest({ request, onSubmit, onCancel, unstyled = false }: AskUserQuestionRequestProps) {
  const { t } = useTranslation()
  const questions = request.questions ?? []
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [selectedOptions, setSelectedOptions] = React.useState<Record<number, string[]>>({})
  const [customInputs, setCustomInputs] = React.useState<Record<number, string>>({})

  const activeQuestion = questions[activeIndex]
  const hasMultipleQuestions = questions.length > 1
  const allAnswered = questions.every((question, index) => answerForQuestion(question, index, selectedOptions, customInputs))
  // [nessy-fork] acp-elicitation-ask-user-question
  const rootRef = React.useRef<HTMLDivElement>(null)
  const optionsRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    let secondFrame: number | undefined
    const focusDialog = () => {
      if (!rootRef.current?.contains(document.activeElement)) {
        rootRef.current?.focus({ preventScroll: true })
      }
    }
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(focusDialog)
    })
    const afterExpand = window.setTimeout(focusDialog, 250)
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame)
      }
      window.clearTimeout(afterExpand)
    }
  }, [activeIndex])

  const toggleOption = (label: string) => {
    if (!activeQuestion) return

    if (!activeQuestion.multiSelect) {
      setCustomInputs((prev) => {
        if (!prev[activeIndex]) return prev
        return { ...prev, [activeIndex]: '' }
      })
    }

    setSelectedOptions((prev) => {
      const current = prev[activeIndex] ?? []
      if (activeQuestion.multiSelect) {
        const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
        return { ...prev, [activeIndex]: next }
      }

      const next = current.includes(label) ? [] : [label]
      return { ...prev, [activeIndex]: next }
    })
  }

  const updateCustomInput = (value: string) => {
    if (!activeQuestion) return

    setCustomInputs((prev) => ({
      ...prev,
      [activeIndex]: value
    }))

    if (!activeQuestion.multiSelect && value.length > 0) {
      setSelectedOptions((prev) => {
        if (!(prev[activeIndex] ?? []).length) return prev
        return { ...prev, [activeIndex]: [] }
      })
    }
  }

  const handleSubmit = (answerOverride?: { index: number; answer: string }) => {
    const answers: Record<string, string> = {}
    questions.forEach((question, index) => {
      const answer = answerOverride?.index === index
        ? answerOverride.answer
        : answerForQuestion(question, index, selectedOptions, customInputs)
      if (answer) {
        answers[String(index)] = answer
      }
    })
    onSubmit(answers)
  }

  // Enter advances to the next unanswered question without submitting the
  // whole form; on the last question (all answered) it submits. Shift+Enter
  // inside the "Other" textarea keeps its newline behaviour.
  const advanceToNext = () => {
    if (!activeQuestion) return
    const answered = !!answerForQuestion(activeQuestion, activeIndex, selectedOptions, customInputs)
    if (!answered) return
    if (activeIndex < questions.length - 1) {
      setActiveIndex(activeIndex + 1)
    } else if (allAnswered) {
      handleSubmit()
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return

    if (
      hasMultipleQuestions &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      (event.target as HTMLElement).tagName !== 'TEXTAREA'
    ) {
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 1 : -1
      setActiveIndex((current) => (current + delta + questions.length) % questions.length)
      return
    }

    // Arrow up/down moves focus between the option buttons.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!activeQuestion) return
      event.preventDefault()
      const container = optionsRef.current
      if (!container) return
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-option-index]'))
      if (buttons.length === 0) return
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = current === -1 ? (delta > 0 ? 0 : buttons.length - 1) : Math.min(Math.max(current + delta, 0), buttons.length - 1)
      buttons[next].focus()
      return
    }

    const optionButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-option-index]')

    if (event.key === ' ' && optionButton) {
      event.preventDefault()
      const option = activeQuestion?.options[Number(optionButton.dataset.optionIndex)]
      if (option) {
        toggleOption(option.label)
      }
      return
    }

    if (event.key !== 'Enter') return
    if (event.shiftKey) return
    event.preventDefault()

    if (optionButton && !activeQuestion?.multiSelect) {
      const option = activeQuestion?.options[Number(optionButton.dataset.optionIndex)]
      if (!option) return
      toggleOption(option.label)
      if (activeIndex < questions.length - 1) {
        setActiveIndex(activeIndex + 1)
      } else {
        handleSubmit({ index: activeIndex, answer: option.label })
      }
      return
    }

    advanceToNext()
  }

  if (!activeQuestion) {
    return (
      <div className={cn('overflow-hidden h-full flex flex-col bg-info/5', unstyled ? 'border-0' : 'border border-info/30 rounded-[8px] shadow-middle')}>
        <div className="p-4 text-xs text-muted-foreground">{request.description || 'The agent is asking for input.'}</div>
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
          <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn('overflow-hidden h-full flex flex-col bg-info/5', unstyled ? 'border-0' : 'border border-info/30 rounded-[8px] shadow-middle')}
    >
      <div className="p-4 space-y-3 flex-1 min-h-0 flex flex-col">
        <div className="space-y-2 pb-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <HelpCircle className="h-3.5 w-3.5 text-info" />
            <span>{request.description || 'Please answer the question'}</span>
          </div>

          {hasMultipleQuestions && (
            <div className="flex flex-wrap items-center gap-1.5">
              {questions.map((question, index) => {
                const answered = !!answerForQuestion(question, index, selectedOptions, customInputs)
                const active = index === activeIndex
                return (
                  <button
                    key={`${question.header}-${index}`}
                    type="button"
                    onClick={() => setActiveIndex(index)}
                    className={cn(
                      'h-6 rounded-[5px] px-2 text-[11px] transition-colors',
                      'border border-foreground/10 hover:bg-foreground/5',
                      active && 'bg-foreground/8 text-foreground',
                      !active && 'text-muted-foreground'
                    )}
                  >
                    {question.header}
                    {answered ? ' done' : ''}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-3 min-h-0 overflow-y-auto pr-1">
          <div>
            <div className="text-sm leading-5 text-foreground">{activeQuestion.question}</div>
            {activeQuestion.multiSelect ? (
              <div className="mt-1 text-[11px] text-muted-foreground">Select one or more options.</div>
            ) : (
              <div className="mt-1 text-[11px] text-muted-foreground">Select one option.</div>
            )}
          </div>

          <div ref={optionsRef} className="space-y-1.5">
            {activeQuestion.options.map((option, optionIndex) => {
              const selected = (selectedOptions[activeIndex] ?? []).includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  data-option-index={optionIndex}
                  onClick={(event) => {
                    if (event.detail === 0) return
                    toggleOption(option.label)
                  }}
                  className={cn(
                    'w-full rounded-[6px] border px-3 py-2 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-info/60',
                    selected ? 'border-info/40 bg-info/10 text-foreground' : 'border-foreground/10 bg-background/40 hover:bg-foreground/5'
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[10px]',
                        activeQuestion.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                        selected ? 'border-info bg-info text-info-foreground' : 'border-foreground/20'
                      )}
                    >
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium leading-4">{option.label}</span>
                      {option.description && <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{option.description}</span>}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] text-muted-foreground">Other</span>
            <textarea
              value={customInputs[activeIndex] ?? ''}
              onChange={(event) => updateCustomInput(event.target.value)}
              placeholder={t('Type something...')}
              className={cn(
                'min-h-16 w-full resize-none rounded-[6px] border border-foreground/10',
                'bg-background/60 px-3 py-2 text-xs leading-5 text-foreground outline-none',
                'placeholder:text-muted-foreground focus:border-info/50 focus:ring-1 focus:ring-info/30'
              )}
            />
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
        <Button size="sm" variant="default" className="h-7 gap-1.5" onClick={() => handleSubmit()} disabled={!allAnswered}>
          <Check className="h-3.5 w-3.5" />
          Submit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-destructive hover:text-destructive border border-dashed border-destructive/50 hover:bg-destructive/10 hover:border-destructive/70 active:bg-destructive/20"
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {hasMultipleQuestions && activeIndex < questions.length - 1 ? 'Enter → next' : 'Enter → submit'}
          </span>
          <span className="text-[10px] text-muted-foreground">↑↓ options</span>
          {hasMultipleQuestions && (
            <span className="text-[10px] text-muted-foreground">
              {activeIndex + 1} / {questions.length}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
