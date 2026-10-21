import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AskUserAnswer, AskUserQuestionItem } from '@nessy-agent/core/types';
import { validateAskUserQuestions } from '@nessy-agent/core/utils';

export interface AskUserInput {
  question: string;
  options: string[];
  allowFreeText: boolean;
  /** Batched AskUserQuestion superset (R7): 1-4 questions x 2-4 options. */
  questions?: AskUserQuestionItem[];
}

export interface AskUserRequest extends AskUserInput {
  requestId: string;
  /**
   * Auto-continue clock. Absent by default: questions never expire unless the
   * user configured askUserQuestionTimeout (host-side) or the
   * NESSY_ASK_USER_TIMEOUT_MS demo/test override armed the subprocess race.
   */
  timeoutMs?: number;
}

export interface AskUserToolDetails {
  question: string;
  options: string[];
  allowFreeText: boolean;
  /** Batched envelope: questions echoed verbatim from the tool input. */
  questions?: AskUserQuestionItem[];
  /** Batched envelope: answers keyed by question TEXT → selected label(s). */
  answers?: Record<string, string | string[]>;
  /** Batched envelope: freeform reply replacing the per-question list. */
  response?: string;
  /** Set when an askUserQuestionTimeout expiry auto-continued the call. */
  autoContinued?: boolean;
  answer?: AskUserAnswer;
  isError?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  error?: string;
}

interface CreateAskUserToolOptions {
  askUser: (request: AskUserRequest, signal: AbortSignal) => Promise<AskUserAnswer>;
  timeoutMs?: number;
  makeRequestId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeQuestions(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw)) {
    throw new Error('ask_user questions must be an array');
  }
  const questions = raw.map((entry): AskUserQuestionItem => {
    if (!isRecord(entry)) throw new Error('ask_user questions must be objects');
    const options = Array.isArray(entry.options)
      ? entry.options.map(option => {
          if (!isRecord(option)) throw new Error('ask_user question options must be objects');
          return {
            label: typeof option.label === 'string' ? option.label.trim() : '',
            ...(typeof option.description === 'string' ? { description: option.description } : {}),
            ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
          };
        })
      : [];
    return {
      question: typeof entry.question === 'string' ? entry.question.trim() : '',
      ...(typeof entry.header === 'string' ? { header: entry.header } : {}),
      options,
      multiSelect: Boolean(entry.multiSelect),
    };
  });
  validateAskUserQuestions(questions);
  return questions;
}

function normalizeInput(params: unknown): AskUserInput {
  if (!isRecord(params)) {
    throw new Error('ask_user requires an object input');
  }

  if (params.questions !== undefined) {
    const questions = normalizeQuestions(params.questions);
    const first = questions[0]!;
    // Legacy projection of the first question so downgraded consumers still
    // render something sane; the full batch travels in `questions`.
    return {
      question: first.question,
      options: first.options.map(option => option.label),
      allowFreeText: true,
      questions,
    };
  }

  const question = typeof params.question === 'string' ? params.question.trim() : '';
  const rawOptions = Array.isArray(params.options) ? params.options : [];
  const options = rawOptions
    .map(option => typeof option === 'string' ? option.trim() : '')
    .filter(Boolean);

  if (!question) {
    throw new Error('ask_user requires a non-empty question');
  }
  if (options.length < 2 || options.length > 4) {
    throw new Error('ask_user requires 2 to 4 non-empty options');
  }

  return {
    question,
    options,
    allowFreeText: Boolean(params.allowFreeText),
  };
}

function errorResult(
  input: AskUserInput,
  message: string,
  flags: Pick<AskUserToolDetails, 'timedOut' | 'aborted'> = {},
): AgentToolResult<AskUserToolDetails> {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      ...input,
      ...flags,
      isError: true,
      error: message,
    },
  };
}

const AWAY_NOTE = 'The user may be away from their keyboard, so the question auto-continued with the selections made so far. Proceed on your own judgment; you can re-ask later if needed.';

function formatSelection(value: string | string[]): string {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Documented answer envelope rendering (user-input.md "Response format"):
 * a freeform `response` replaces the per-question list with neutral wording;
 * otherwise each answered question renders as `question: label(s)` with
 * multi-select labels joined by ", ".
 */
function formatBatchedAnswer(
  input: AskUserInput,
  answer: Extract<AskUserAnswer, { type: 'batched' }>,
): string {
  if (answer.response !== undefined) {
    return `The user responded: ${answer.response}`;
  }
  const order = input.questions?.map(question => question.question)
    ?? Object.keys(answer.answers);
  const lines = order
    .filter(question => answer.answers[question] !== undefined)
    .map(question => `${question}: ${formatSelection(answer.answers[question]!)}`);
  if (answer.autoContinued) {
    return lines.length > 0
      ? `${AWAY_NOTE}\n${lines.join('\n')}`
      : `${AWAY_NOTE}\nNo options were selected.`;
  }
  return lines.join('\n');
}

function formatAnswer(input: AskUserInput, answer: AskUserAnswer): string {
  if (answer.type === 'batched') return formatBatchedAnswer(input, answer);
  return answer.type === 'option'
    ? `User selected option ${answer.optionIndex + 1}: ${answer.value}`
    : `User answered: ${answer.value}`;
}

function answerDetails(input: AskUserInput, answer: AskUserAnswer): AskUserToolDetails {
  if (answer.type !== 'batched') {
    return { ...input, answer };
  }
  return {
    ...input,
    // Envelope contract: questions echoed verbatim + answers keyed by
    // question text (+ optional response / autoContinued).
    ...(input.questions ? { questions: input.questions } : {}),
    answers: answer.answers,
    ...(answer.response !== undefined ? { response: answer.response } : {}),
    ...(answer.autoContinued ? { autoContinued: true } : {}),
    answer,
  };
}

export function createAskUserTool(options: CreateAskUserToolOptions): ToolDefinition<any, AskUserToolDetails> {
  return {
    name: 'ask_user',
    label: 'Ask User',
    description: 'Ask the user up to 4 multiple-choice questions and wait for their answers.',
    promptSnippet: 'Use ask_user when you need the user to decide before continuing. Provide 1 to 4 questions, each with 2 to 4 options ({label, description}), a short header (max 12 characters), and multiSelect when several options may apply. The legacy single question/options form also works.',
    promptGuidelines: [
      'Use ask_user only when progress depends on a user choice.',
      'Batch related questions into one call: 1 to 4 questions, each with 2 to 4 clear options.',
      'Keep each header at 12 characters or less.',
      'Set multiSelect only when several options may be chosen together.',
    ],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: { type: 'string' },
        },
        allowFreeText: { type: 'boolean' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            required: ['question', 'options'],
            additionalProperties: false,
            properties: {
              question: { type: 'string' },
              header: { type: 'string', maxLength: 12 },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  required: ['label'],
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              multiSelect: { type: 'boolean' },
            },
          },
        },
      },
    } as any,
    prepareArguments: args => args as any,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<AskUserToolDetails>> {
      let input: AskUserInput;
      try {
        input = normalizeInput(params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult({ question: '', options: [], allowFreeText: false }, message);
      }
      // No default expiry: with askUserQuestionTimeout unset the question
      // waits indefinitely (settings.md default "never"). The host arms the
      // user-configured auto-continue clock; this subprocess race exists only
      // for the explicit NESSY_ASK_USER_TIMEOUT_MS demo/test override, and
      // when it fires the result is an auto-continue, never a tool error.
      const timeoutMs = options.timeoutMs;
      const requestId = options.makeRequestId?.()
        ?? `ask-user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      let timedOut = false;
      let aborted = false;

      const abortFromParent = () => {
        aborted = true;
        controller.abort('aborted');
      };

      if (signal?.aborted) {
        return errorResult(input, 'ask_user was aborted.', { aborted: true });
      }

      signal?.addEventListener('abort', abortFromParent, { once: true });
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort('timed_out');
          }, timeoutMs);

      const abortPromise = new Promise<AskUserAnswer>((resolveExpiry, reject) => {
        controller.signal.addEventListener('abort', () => {
          if (timedOut) {
            resolveExpiry({ type: 'batched', answers: {}, autoContinued: true });
          } else {
            reject(new Error('ask_user was aborted.'));
          }
        }, { once: true });
      });

      try {
        const answer = await Promise.race([
          options.askUser({ ...input, requestId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, controller.signal),
          abortPromise,
        ]);
        return {
          content: [{ type: 'text', text: formatAnswer(input, answer) }],
          details: answerDetails(input, answer),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(input, message, { timedOut, aborted });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromParent);
      }
    },
  };
}
