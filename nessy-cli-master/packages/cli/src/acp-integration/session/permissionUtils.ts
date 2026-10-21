/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallConfirmationDetails } from '@nestor/nessy-cli-core';
import { ToolConfirmationOutcome } from '@nestor/nessy-cli-core';
import type {
  // [nessy-fork] acp-elicitation-ask-user-question
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
  PermissionOption,
  ToolCallContent,
} from '@agentclientprotocol/sdk';

type AskUserQuestionQuestions = Extract<
  ToolCallConfirmationDetails,
  { type: 'ask_user_question' }
>['questions'];

const basicPermissionOptions = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
] as const satisfies readonly PermissionOption[];

function supportsHideAlwaysAllow(
  confirmation: ToolCallConfirmationDetails,
): confirmation is Exclude<
  ToolCallConfirmationDetails,
  { type: 'ask_user_question' }
> {
  return confirmation.type !== 'ask_user_question';
}

function filterAlwaysAllowOptions(
  confirmation: ToolCallConfirmationDetails,
  options: PermissionOption[],
  forceHideAlwaysAllow = false,
): PermissionOption[] {
  const hideAlwaysAllow =
    forceHideAlwaysAllow ||
    (supportsHideAlwaysAllow(confirmation) &&
      confirmation.hideAlwaysAllow === true);
  return hideAlwaysAllow
    ? options.filter((option) => option.kind !== 'allow_always')
    : options;
}

function formatExecPermissionScopeLabel(
  confirmation: Extract<ToolCallConfirmationDetails, { type: 'exec' }>,
): string {
  const permissionRules = confirmation.permissionRules ?? [];
  const bashRules = permissionRules
    .map((rule) => {
      const match = /^Bash\((.*)\)$/.exec(rule.trim());
      return match?.[1]?.trim() || undefined;
    })
    .filter((rule): rule is string => Boolean(rule));

  const uniqueRules = [...new Set(bashRules)];
  if (uniqueRules.length === 1) {
    return uniqueRules[0];
  }
  if (uniqueRules.length > 1) {
    return uniqueRules.join(', ');
  }
  return confirmation.rootCommand;
}

export function buildPermissionRequestContent(
  confirmation: ToolCallConfirmationDetails,
): ToolCallContent[] {
  const content: ToolCallContent[] = [];

  if (confirmation.type === 'edit') {
    content.push({
      type: 'diff',
      path: confirmation.filePath ?? confirmation.fileName,
      oldText: confirmation.originalContent ?? '',
      newText: confirmation.newContent,
    });
  }

  if (confirmation.type === 'plan') {
    content.push({
      type: 'content',
      content: {
        type: 'text',
        text: confirmation.plan,
      },
    });
  }

  if (confirmation.type === 'ask_user_question') {
    const text = confirmation.questions
      .map((q) => {
        const heading = q.header
          ? `**${q.header}** — ${q.question}`
          : `**${q.question}**`;
        const opts = q.options
          .map((opt) => `- **${opt.label}** — ${opt.description}`)
          .join('\n');
        const note = q.multiSelect ? '\n\n_(multiple choices allowed)_' : '';
        return `${heading}\n\n${opts}${note}`;
      })
      .join('\n\n---\n\n');
    content.push({
      type: 'content',
      content: {
        type: 'text',
        text,
      },
    });
  }

  return content;
}

export function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
  forceHideAlwaysAllow = false,
): PermissionOption[] {
  switch (confirmation.type) {
    case 'edit':
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlways,
            name: 'Allow All Edits',
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    case 'exec': {
      const label = formatExecPermissionScopeLabel(confirmation);
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: `Always Allow in project: ${label}`,
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
            name: `Always Allow for user: ${label}`,
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    }
    case 'mcp':
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: `Always Allow in project: ${confirmation.toolName}`,
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
            name: `Always Allow for user: ${confirmation.toolName}`,
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    case 'info':
      return filterAlwaysAllowOptions(
        confirmation,
        [
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Always Allow in project',
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
            name: 'Always Allow for user',
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ],
        forceHideAlwaysAllow,
      );
    case 'plan':
      return [
        {
          optionId: ToolConfirmationOutcome.RestorePrevious,
          name: `Yes, restore previous mode (${confirmation.prePlanMode ?? 'default'})`,
          kind: 'allow_once',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Yes, and auto-accept edits',
          kind: 'allow_always',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          name: 'Yes, and manually approve edits',
          kind: 'allow_once',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          name: 'No, keep planning (esc)',
          kind: 'reject_once',
        },
      ];
    case 'ask_user_question': {
      const options: PermissionOption[] = [];
      confirmation.questions.forEach((q, qIdx) => {
        q.options.forEach((opt, optIdx) => {
          const isFirst = options.length === 0;
          options.push({
            optionId: `q${qIdx}_opt${optIdx}`,
            name: opt.label,
            kind: 'allow_once',
            description: opt.description,
            questionIndex: qIdx,
            questionHeader: q.header,
            questionText: q.question,
            multiSelect: q.multiSelect,
            ...(isFirst && {
              questions: confirmation.questions,
              metadata: confirmation.metadata,
            }),
          } as unknown as PermissionOption);
        });
      });
      options.push({
        optionId: ToolConfirmationOutcome.ProceedOnce,
        name: "I'll specify my own answer",
        kind: 'allow_once',
      });
      return options;
    }
    default: {
      const unreachable: never = confirmation;
      throw new Error(`Unexpected: ${unreachable}`);
    }
  }
}

/**
 * Maps `ask_user_question` questions into the JSON Schema the ACP
 * `elicitation/create` (mode `form`) protocol expects. Each question becomes
 * one property keyed by its index; `multiSelect` questions become `array`
 * properties (enum items), the rest become `string` properties with an enum.
 */
// [nessy-fork] acp-elicitation-ask-user-question
export function buildElicitationRequestedSchema(
  confirmation: Extract<
    ToolCallConfirmationDetails,
    { type: 'ask_user_question' }
  >,
): ElicitationSchema {
  // [nessy-fork] acp-elicitation-ask-user-question
  const properties: Record<string, ElicitationPropertySchema> = {};
  confirmation.questions.forEach((q, idx) => {
    const labels = q.options.map((opt) => opt.label);
    if (q.multiSelect) {
      properties[String(idx)] = {
        type: 'array',
        title: q.header,
        description: q.question,
        items: { type: 'string', enum: labels },
      };
    } else {
      properties[String(idx)] = {
        type: 'string',
        title: q.header,
        description: q.question,
        enum: labels,
      };
    }
  });
  return {
    type: 'object',
    title: confirmation.title,
    required: confirmation.questions.map((_, idx) => String(idx)),
    properties,
  };
}

/**
 * Converts the `content` of an accepted elicitation into the
 * `Record<questionIndex, answer>` shape `ask_user_question` expects.
 * `multiSelect` answers (arrays) are joined with ", " to match the format
 * produced by the AskUserQuestionDialog UI.
 */
// [nessy-fork] acp-elicitation-ask-user-question
export function elicitationContentToAnswers(
  content: Record<string, ElicitationContentValue> | null | undefined,
): Record<string, string> {
  const answers: Record<string, string> = {};
  if (!content) return answers;
  for (const [key, value] of Object.entries(content)) {
    if (Array.isArray(value)) {
      answers[key] = value.join(', ');
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      answers[key] = String(value);
    }
  }
  return answers;
}

export interface AskUserQuestionOptionResolution {
  outcome: ToolConfirmationOutcome;
  answers: Record<string, string>;
}

/**
 * Maps a permission-fallback `optionId` of the form `q<qIdx>_opt<oIdx>` back
 * into the question index → option label answers shape. Falls back to the
 * pre-existing `answers` (already sent by modern clients) and only fills in
 * the label from the question/option when the client did not supply it. Returns
 * `undefined` for option ids that are not `q*_opt*` (e.g. the "I'll specify my
 * own answer" option), letting the caller resolve them via the outcome enum.
 */
export function resolveAskUserQuestionOptionId(
  optionId: string,
  questions: AskUserQuestionQuestions,
  existingAnswers?: Record<string, string>,
): AskUserQuestionOptionResolution | undefined {
  const match = /^q(\d+)_opt(\d+)$/.exec(optionId);
  if (!match) return undefined;
  const qIdx = Number(match[1]);
  const oIdx = Number(match[2]);
  const answers = { ...(existingAnswers ?? {}) };
  const option = questions[qIdx]?.options?.[oIdx];
  if (option && answers[String(qIdx)] === undefined) {
    answers[String(qIdx)] = option.label;
  }
  return { outcome: ToolConfirmationOutcome.ProceedOnce, answers };
}
