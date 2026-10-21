/**
 * Shared validation for the batched AskUserQuestion contract (R7).
 *
 * Contract source: code.claude.com/docs/en/agent-sdk/user-input.md — 1-4
 * questions per call, 2-4 options each, `header` capped at 12 characters;
 * the answer envelope is keyed by question TEXT, multi-select answers are an
 * array (or a ", "-join), free text is a legal per-question answer (the
 * "Other" row), and a freeform `response` replaces the per-question list.
 *
 * One implementation used by the subprocess tool (pi-agent-server), the host
 * agent (shared/pi-agent), and the durable pending reducer (server-core) so
 * the three seams cannot drift.
 */

import type { AskUserAnswer, AskUserQuestionItem } from '../types/message.ts';

export const ASK_USER_MIN_QUESTIONS = 1;
export const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 4;
export const ASK_USER_MAX_HEADER_CHARS = 12;

export type BatchedAskUserAnswer = Extract<AskUserAnswer, { type: 'batched' }>;

/** Throws `invalid-questions: …` when the batch violates the documented bounds. */
export function validateAskUserQuestions(questions: readonly AskUserQuestionItem[]): void {
  if (!Array.isArray(questions)
    || questions.length < ASK_USER_MIN_QUESTIONS
    || questions.length > ASK_USER_MAX_QUESTIONS) {
    throw new Error('invalid-questions: 1-4 questions required');
  }
  const texts = new Set<string>();
  for (const question of questions) {
    const text = typeof question?.question === 'string' ? question.question.trim() : '';
    if (!text) throw new Error('invalid-questions: empty question text');
    if (texts.has(text)) throw new Error('invalid-questions: duplicate question text');
    texts.add(text);
    if (question.header !== undefined
      && (typeof question.header !== 'string' || question.header.length > ASK_USER_MAX_HEADER_CHARS)) {
      throw new Error(`invalid-questions: header longer than ${ASK_USER_MAX_HEADER_CHARS} characters`);
    }
    const options: readonly AskUserQuestionItem['options'][number][] = Array.isArray(question.options) ? question.options : [];
    const labels = options.map(option => typeof option?.label === 'string' ? option.label.trim() : '');
    if (labels.length < ASK_USER_MIN_OPTIONS || labels.length > ASK_USER_MAX_OPTIONS) {
      throw new Error('invalid-questions: 2-4 options required per question');
    }
    if (labels.some(label => !label) || new Set(labels).size !== labels.length) {
      throw new Error('invalid-questions: option labels must be non-empty and unique');
    }
  }
}

/**
 * Throws `invalid-answer` when a batched answer does not fit the pending
 * questions. Free text is always a legal per-question value (the documented
 * "Other" flow); arrays are legal only for multi-select questions; a
 * non-empty `response` alone settles the call; an `autoContinued` expiry may
 * settle any pending with whatever was already selected — including nothing.
 */
export function validateBatchedAskUserAnswer(
  questions: readonly AskUserQuestionItem[] | undefined,
  answer: BatchedAskUserAnswer,
): void {
  const entries = Object.entries(answer.answers ?? {});
  if (answer.response !== undefined) {
    if (typeof answer.response !== 'string' || !answer.response.trim()) throw new Error('invalid-answer');
  }
  const byText = new Map((questions ?? []).map(question => [question.question, question] as const));
  for (const [text, value] of entries) {
    const question = byText.get(text);
    if (!question) throw new Error('invalid-answer');
    if (Array.isArray(value)) {
      if (!question.multiSelect
        || value.length === 0
        || value.some(item => typeof item !== 'string' || !item.trim())) {
        throw new Error('invalid-answer');
      }
    } else if (typeof value !== 'string' || !value.trim()) {
      throw new Error('invalid-answer');
    }
  }
  if (entries.length === 0 && answer.response === undefined && !answer.autoContinued) {
    throw new Error('invalid-answer');
  }
}
