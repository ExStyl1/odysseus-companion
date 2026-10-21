import { describe, expect, it } from 'bun:test';

import {
  REVIEW_FINDING_TITLE_MAX_LENGTH,
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_RUBRIC_PROMPT,
} from '../review.ts';

describe('review rubric prompt', () => {
  it('matches the adversarial findings-first rubric snapshot', () => {
    // Snapshot the load-bearing rubric contract: adversarial, findings-first,
    // only defects INTRODUCED by the change, no speculation, P0-P3 severity,
    // file:line references, and the JSON output shape.
    expect(REVIEW_RUBRIC_PROMPT).toMatchSnapshot();
    expect(REVIEW_RUBRIC_PROMPT).toContain('acting as a reviewer');
    expect(REVIEW_RUBRIC_PROMPT).toContain('introduced in the change under review');
    expect(REVIEW_RUBRIC_PROMPT).toContain('pre-existing bugs must not be flagged');
    expect(REVIEW_RUBRIC_PROMPT).toContain('Speculation is not enough');
    expect(REVIEW_RUBRIC_PROMPT).toContain('provably affected');
    expect(REVIEW_RUBRIC_PROMPT).toContain('at most 80 characters');
    expect(REVIEW_RUBRIC_PROMPT).toContain('file:line');
    for (const priority of ['P0', 'P1', 'P2', 'P3']) {
      expect(REVIEW_RUBRIC_PROMPT).toContain(priority);
    }
    expect(REVIEW_RUBRIC_PROMPT).toContain('most severe first');
  });

  it('pins the findings schema title length to the imperative-title contract', () => {
    expect(REVIEW_FINDING_TITLE_MAX_LENGTH).toBe(80);
    const props = REVIEW_FINDINGS_SCHEMA.properties.findings.items.properties;
    expect(props.title.maxLength).toBe(REVIEW_FINDING_TITLE_MAX_LENGTH);
    expect(props.priority.minimum).toBe(0);
    expect(props.priority.maximum).toBe(3);
    expect(REVIEW_FINDINGS_SCHEMA.required).toEqual(['findings', 'verdict', 'explanation']);
    expect(REVIEW_FINDINGS_SCHEMA.properties.verdict.enum).toEqual([
      'patch is correct', 'patch is incorrect',
    ]);
  });
});
