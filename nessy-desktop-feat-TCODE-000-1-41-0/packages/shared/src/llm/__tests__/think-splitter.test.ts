import { describe, expect, test } from 'bun:test';

import { extractReasoning, StreamingThinkSplitter } from '../think-splitter.ts';

describe('think splitter', () => {
  test('extractReasoning splits complete spans', () => {
    expect(extractReasoning('<think>plan</think>answer')).toEqual({ reasoning: 'plan', answer: 'answer' });
    expect(extractReasoning('a<think>b</think>c<think>d</think>e')).toEqual({ reasoning: 'bd', answer: 'ace' });
  });

  test('unclosed think spans put the remainder in reasoning', () => {
    expect(extractReasoning('<think>still thinking')).toEqual({ reasoning: 'still thinking', answer: '' });
  });

  test('streaming splitter routes across fragment boundaries', () => {
    const splitter = new StreamingThinkSplitter();
    let reasoning = '';
    let answer = '';

    for (const fragment of ['<thi', 'nk>x</thi', 'nk>hi']) {
      const result = splitter.push(fragment);
      reasoning += result.reasoning;
      answer += result.answer;
    }
    const flushed = splitter.flush();
    reasoning += flushed.reasoning;
    answer += flushed.answer;

    expect(reasoning).toBe('x');
    expect(answer).toBe('hi');
  });
});
