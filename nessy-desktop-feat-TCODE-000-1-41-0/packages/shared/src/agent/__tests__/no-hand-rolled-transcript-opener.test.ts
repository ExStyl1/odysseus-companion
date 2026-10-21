/**
 * The P2.86 lint rule, and the three corrections measuring it produced.
 *
 * The rule exists because `prompts/untrusted-text.ts:renderTranscriptEntry`'s
 * own commit claimed a hand-rolled `User: ` opener "physically cannot" survive
 * in-tree while `utils/title-generator.ts` was doing exactly that. Routing that
 * site through the seam fixes the site; the rule is what makes the claim true
 * for the next one.
 *
 * Every ACCEPT row below is a real string this rule reported before it was
 * narrowed, which is why they are pinned rather than assumed:
 *
 *  - two ordinary sentences ending `…reached a user: ${detail}` — fixed by
 *    anchoring the opener to a line start, the way the seam's own pattern is;
 *  - `Tool ${toolName} matched toolRules pattern …` — fixed by dropping the
 *    `Tool ` shape entirely, since without a colon it cannot be told from prose.
 *
 * The rule is loaded and run through ESLint's own `RuleTester`-free path: a
 * `Linter` instance with the rule registered, which is the smallest thing that
 * exercises the real `create()` rather than a re-implementation of it.
 */
import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';

import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';

const require_ = createRequire(import.meta.url);
const rule = require_('../../../eslint-rules/no-hand-rolled-transcript-opener.cjs');

const linter = new Linter({ configType: 'flat' });

function lint(code: string, filename = 'src/agent/subject.ts'): string[] {
  const messages = linter.verify(code, [
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tsParser as never, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
      plugins: { 'nessy-shared': { rules: { 'no-hand-rolled-transcript-opener': rule } } },
      rules: { 'nessy-shared/no-hand-rolled-transcript-opener': 'error' },
    },
  ], filename);
  return messages.map(message => message.message);
}

describe('no-hand-rolled-transcript-opener — REJECT', () => {
  it('rejects the concatenation the row was opened on', () => {
    // `title-generator.ts:72` as it stood.
    expect(lint("const p = 'User: ' + snippet;")).toHaveLength(1);
  });

  it('rejects the template form and the bracketed form', () => {
    expect(lint('const p = `User: ${snippet}`;')).toHaveLength(1);
    expect(lint('const p = `[Assistant]: ${body}`;')).toHaveLength(1);
    expect(lint("const p = '[System]: ' + body;")).toHaveLength(1);
  });

  it('rejects an opener that is not the first line of the string', () => {
    // The seam's pattern is multiline, so a forged opener on a LATER line of a
    // hand-built block is the same hazard.
    expect(lint('const p = `preamble\\nUser: ${snippet}`;')).toHaveLength(1);
  });

  it('rejects an indented opener and a lowercase one', () => {
    // Both are defanged by the seam, so both must be caught here.
    expect(lint('const p = `  User: ${snippet}`;')).toHaveLength(1);
    expect(lint("const p = 'user: ' + snippet;")).toHaveLength(1);
  });
});

describe('no-hand-rolled-transcript-opener — ACCEPT', () => {
  it('accepts the seam call itself', () => {
    expect(lint("const p = renderTranscriptEntry('User: ', snippet);")).toEqual([]);
  });

  it('accepts the two English sentences the unanchored draft reported', () => {
    // Measured false positives, verbatim from `elicitation-ask-user.ts` and
    // `pi-agent.ts`. `user:` mid-line is not an opener to the seam either.
    expect(lint('const m = `The elicitation never reached a user: ${detail}`;')).toEqual([]);
    expect(lint('const m = `The question could not be put to the user: ${detail}`;')).toEqual([]);
  });

  it('accepts prose beginning with the word Tool', () => {
    // `mode-manager.ts:formatToolRuleDescription`, the third measured false
    // positive and the reason the `Tool ` shape is out of scope. If the `Tool `
    // shape is ever added back, this row is where the trade gets re-argued.
    expect(lint('const d = `Tool ${toolName} matched toolRules pattern ${rule.pattern}.`;')).toEqual([]);
  });

  it('accepts a bare System: , which the seam does not defang either', () => {
    // `TRANSCRIPT_ENTRY_OPENER`'s unbracketed alternation is User|Assistant|Human.
    // Demanding the seam for a string the seam ignores would be a rule that
    // cannot be satisfied.
    expect(lint('const p = `System: ${body}`;')).toEqual([]);
  });

  it('accepts a literal on the RIGHT of a concatenation', () => {
    expect(lint("const p = body + 'User: ';")).toEqual([]);
  });

  it('accepts test files, which spell openers on purpose', () => {
    expect(lint("const p = 'User: ' + snippet;", 'src/agent/__tests__/x.test.ts')).toEqual([]);
    expect(lint("const p = 'User: ' + snippet;", 'src/prompts/untrusted-text.ts')).toEqual([]);
  });
});
