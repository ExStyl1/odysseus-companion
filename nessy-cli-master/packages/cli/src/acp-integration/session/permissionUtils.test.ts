/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolConfirmationOutcome } from '@nestor/nessy-cli-core';
import {
  // [nessy-fork] acp-elicitation-ask-user-question
  buildElicitationRequestedSchema,
  elicitationContentToAnswers,
  resolveAskUserQuestionOptionId,
  toPermissionOptions,
} from './permissionUtils.js';

describe('permissionUtils', () => {
  describe('toPermissionOptions', () => {
    it('uses permissionRules for exec always-allow labels when available', () => {
      const options = toPermissionOptions({
        type: 'exec',
        title: 'Confirm Shell Command',
        command: 'git add package.json',
        rootCommand: 'git',
        permissionRules: ['Bash(git add *)'],
        onConfirm: async () => undefined,
      });

      expect(options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
          name: 'Always Allow in project: git add *',
        }),
      );
      expect(options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
          name: 'Always Allow for user: git add *',
        }),
      );
    });

    it('returns plan options with RestorePrevious including prePlanMode', () => {
      const options = toPermissionOptions({
        type: 'plan',
        title: 'Would you like to proceed?',
        plan: 'Test plan',
        prePlanMode: 'auto',
        onConfirm: async () => undefined,
      });

      expect(options).toHaveLength(4);
      expect(options[0]).toMatchObject({
        optionId: ToolConfirmationOutcome.RestorePrevious,
        name: 'Yes, restore previous mode (auto)',
        kind: 'allow_once',
      });
      expect(options[1]).toMatchObject({
        optionId: ToolConfirmationOutcome.ProceedAlways,
        name: 'Yes, and auto-accept edits',
      });
      expect(options[2]).toMatchObject({
        optionId: ToolConfirmationOutcome.ProceedOnce,
        name: 'Yes, and manually approve edits',
      });
      expect(options[3]).toMatchObject({
        optionId: ToolConfirmationOutcome.Cancel,
        name: 'No, keep planning (esc)',
      });
    });

    it('defaults prePlanMode to "default" when not provided in plan options', () => {
      const options = toPermissionOptions({
        type: 'plan',
        title: 'Would you like to proceed?',
        plan: 'Test plan',
        onConfirm: async () => undefined,
      });

      expect(options[0]).toMatchObject({
        optionId: ToolConfirmationOutcome.RestorePrevious,
        name: 'Yes, restore previous mode (default)',
      });
    });

    it('falls back to rootCommand when exec permissionRules are unavailable', () => {
      const options = toPermissionOptions({
        type: 'exec',
        title: 'Confirm Shell Command',
        command: 'git add package.json',
        rootCommand: 'git',
        onConfirm: async () => undefined,
      });

      expect(options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
          name: 'Always Allow in project: git',
        }),
      );
    });
  });

  describe('buildElicitationRequestedSchema', () => {
    // [nessy-fork] acp-elicitation-ask-user-question
    it('maps single-select questions to string enum properties', () => {
      const schema = buildElicitationRequestedSchema({
        type: 'ask_user_question',
        title: 'Please answer',
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            options: [
              { label: 'PostgreSQL', description: 'Relational DB' },
              { label: 'MongoDB', description: 'NoSQL DB' },
            ],
          },
        ],
        onConfirm: async () => undefined,
      });

      expect(schema).toMatchObject({
        type: 'object',
        title: 'Please answer',
        required: ['0'],
        properties: {
          '0': {
            type: 'string',
            title: 'Library',
            description: 'Which library?',
            enum: ['PostgreSQL', 'MongoDB'],
          },
        },
      });
    });

    // [nessy-fork] acp-elicitation-ask-user-question
    it('maps multiSelect questions to array enum properties', () => {
      const schema = buildElicitationRequestedSchema({
        type: 'ask_user_question',
        title: 'Please answer',
        questions: [
          {
            question: 'Which features?',
            header: 'Features',
            options: [
              { label: 'Console', description: 'stdout' },
              { label: 'File', description: 'to file' },
            ],
            multiSelect: true,
          },
        ],
        onConfirm: async () => undefined,
      });

      expect(schema.properties?.['0']).toEqual({
        type: 'array',
        title: 'Features',
        description: 'Which features?',
        items: { type: 'string', enum: ['Console', 'File'] },
      });
    });

    // [nessy-fork] acp-elicitation-ask-user-question
    it('maps several questions to several keyed properties and required', () => {
      const schema = buildElicitationRequestedSchema({
        type: 'ask_user_question',
        title: 'Please answer',
        questions: [
          {
            question: 'Approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
          },
          {
            question: 'Env?',
            header: 'Env',
            options: [
              { label: 'prod', description: 'prod' },
              { label: 'test', description: 'test' },
            ],
          },
        ],
        onConfirm: async () => undefined,
      });

      expect(schema.required).toEqual(['0', '1']);
      expect(Object.keys(schema.properties ?? {})).toEqual(['0', '1']);
    });
  });

  // [nessy-fork] acp-elicitation-ask-user-question
  describe('elicitationContentToAnswers', () => {
    // [nessy-fork] acp-elicitation-ask-user-question
    it('maps string content by question index', () => {
      expect(elicitationContentToAnswers({ '0': 'PostgreSQL' })).toEqual({
        '0': 'PostgreSQL',
      });
    });

    // [nessy-fork] acp-elicitation-ask-user-question
    it('joins multiSelect arrays with ", "', () => {
      expect(elicitationContentToAnswers({ '0': ['Console', 'File'] })).toEqual(
        { '0': 'Console, File' },
      );
    });

    // [nessy-fork] acp-elicitation-ask-user-question
    it('stringifies number and boolean content values', () => {
      expect(elicitationContentToAnswers({ '0': 5, '1': true })).toEqual({
        '0': '5',
        '1': 'true',
      });
    });

    // [nessy-fork] acp-elicitation-ask-user-question
    it('returns empty record for null/undefined/empty content', () => {
      expect(elicitationContentToAnswers(undefined)).toEqual({});
      expect(elicitationContentToAnswers(null)).toEqual({});
      expect(elicitationContentToAnswers({})).toEqual({});
    });
  });

  describe('resolveAskUserQuestionOptionId', () => {
    const questions = [
      {
        question: 'Which library?',
        header: 'Library',
        options: [
          { label: 'PostgreSQL', description: 'Relational' },
          { label: 'MongoDB', description: 'NoSQL' },
        ],
      },
    ];

    it('maps q0_opt0 to the selected option label', () => {
      expect(
        resolveAskUserQuestionOptionId('q0_opt0', questions, undefined),
      ).toEqual({
        outcome: ToolConfirmationOutcome.ProceedOnce,
        answers: { '0': 'PostgreSQL' },
      });
    });

    it('keeps client-supplied answers when present', () => {
      expect(
        resolveAskUserQuestionOptionId('q0_opt1', questions, {
          '0': 'Client-provided',
        }),
      ).toEqual({
        outcome: ToolConfirmationOutcome.ProceedOnce,
        answers: { '0': 'Client-provided' },
      });
    });

    it('returns undefined for non q*_opt* option ids', () => {
      expect(
        resolveAskUserQuestionOptionId(
          ToolConfirmationOutcome.ProceedOnce,
          questions,
          undefined,
        ),
      ).toBeUndefined();
      expect(
        resolveAskUserQuestionOptionId('proceed_always', questions, undefined),
      ).toBeUndefined();
    });
  });
});
