/**
 * [nessy-fork] desktop-pet-session-aggregation
 *
 * Pure phase → pet-state / notification-card mappings shared by
 * usePetActivityState and usePetNotifications. External CLI sessions
 * (terminal TUI / ACP) arrive as `pet:sessionUpdate` snapshots with a
 * coarse phase; desktop sessions keep using `session:event`. Both feed
 * these helpers so the animation and card logic exist exactly once.
 */
import type {
  PermissionRequest,
  PetSessionOption,
  PetSessionPhase,
  PetSessionUpdate,
} from '@craft-agent/shared/protocol';
import type { PetState } from './pet-animation';
import type { PetNotificationKind } from './usePetNotifications';

/**
 * A running (activity) card never evicts a pending DESKTOP question card:
 * activity events trail the question push out of order (observed live: a
 * late text_complete wiped a just-created card), and desktop cards are
 * cleared by *_resolved events instead. External (terminal/ACP) cards have
 * NO resolution event — for them the phase push itself (working after
 * waiting_input) is the answer signal and must replace the card.
 */
export function canReplaceCardKind(
  cur: { kind: PetNotificationKind; source?: string },
  next: PetNotificationKind,
): boolean {
  if (
    cur.kind === 'permission' &&
    cur.source === 'desktop' &&
    next === 'running'
  ) {
    return false;
  }
  return true;
}

/** Animation state for an external session phase; null ⇒ pet idles. */
export function mapPhaseToPetState(phase: PetSessionPhase): PetState | null {
  switch (phase) {
    case 'working':
      return 'running';
    case 'waiting_input':
      return 'waiting';
    case 'done':
      return 'jumping';
    default:
      // idle | gone — nothing to animate.
      return null;
  }
}

export interface PetSessionCard {
  kind: PetNotificationKind;
  /** i18n key for the card title. */
  titleKey: string;
}

/**
 * Card for an external session snapshot; null ⇒ drop the card (gone) or
 * don't show one (idle — a live-but-idle session is not newsworthy).
 */
export function mapPhaseToPetNotification(
  phase: PetSessionPhase,
): PetSessionCard | null {
  switch (phase) {
    case 'working':
      return { kind: 'running', titleKey: 'pet.notify.terminalRunning' };
    case 'waiting_input':
      return { kind: 'permission', titleKey: 'pet.notify.terminalApproval' };
    case 'done':
      return { kind: 'success', titleKey: 'pet.notify.terminalDone' };
    default:
      return null;
  }
}

/** How a permission card can be answered inline from the pet. */
export type PermissionAnswerStyle = 'options' | 'allow_deny' | 'none';

/** Unified inline-answer descriptor for a desktop permission_request. */
export interface DesktopPermissionCard {
  requestId: string;
  toolName?: string;
  summary: string;
  /**
   * respondToPermission answers key — the question INDEX as a string
   * ('0'), matching the chat UI (AskUserQuestionRequest) and the CLI's
   * resolveAskUserQuestionOptionId. The header is NOT the key.
   */
  answerKey?: string;
  options?: PetSessionOption[];
  answerStyle: PermissionAnswerStyle;
}

/**
 * Structural subset consumed from PermissionRequest and ElicitationRequest
 * (ask_user_question arrives as either depending on the AIDT-8203 routing).
 */
export type PermissionCardSource = Pick<
  PermissionRequest,
  'requestId' | 'description' | 'questions'
> & {
  toolName?: PermissionRequest['toolName'];
  /** The question arrived as an ACP elicitation form (AIDT-8203). */
  elicitation?: boolean;
};

/**
 * Normalizes a desktop PermissionRequest / ElicitationRequest (bash approval /
 * ask_user_question) into the unified option format. One non-multiSelect
 * question renders its options as buttons; multi-question / multiSelect
 * questionnaires are too complex for a 300px card — the user answers in the
 * app (click focuses it).
 */
export function permissionRequestToNotification(
  request: PermissionCardSource,
): DesktopPermissionCard {
  const questions = request.questions ?? [];
  const single = questions.length === 1 ? questions[0]! : null;
  // Any questionnaire: summarize with its first question, else description.
  const summary = questions[0]?.question || request.description;

  if (single && !single.multiSelect) {
    const options = single.options
      .filter((o) => typeof o.label === 'string' && o.label !== '')
      .map((o) => ({
        optionId: o.label,
        name: o.label,
        description: o.description || undefined,
      }));
    return {
      requestId: request.requestId,
      toolName: request.toolName,
      summary: single.question || request.description,
      // Single-question card → question index 0 (the only answers key the
      // agent and the chat UI accept).
      answerKey: '0',
      options: options.length > 0 ? options : undefined,
      answerStyle:
        options.length > 0
          ? 'options'
          : // A free-text elicitation form cannot be answered from a 300px
            // card — offer "open in app" instead of a misleading Answer
            // button that would decline the question.
            request.elicitation
            ? 'none'
            : 'allow_deny',
    };
  }

  if (questions.length === 0) {
    // Plain tool approval — no per-option buttons, just Allow / Cancel.
    return {
      requestId: request.requestId,
      toolName: request.toolName,
      summary: request.description,
      answerStyle: 'allow_deny',
    };
  }

  return {
    requestId: request.requestId,
    toolName: request.toolName,
    summary,
    answerStyle: 'none',
  };
}

/**
 * Answer affordance of an external waiting_input snapshot. Terminal
 * pending_requests list their options in runtime.json (MR1/MR2); ACP cards
 * are display-only (no input.jsonl to answer through).
 */
export function terminalAnswerStyle(update: PetSessionUpdate): PermissionAnswerStyle {
  if (update.source === 'acp') return 'none';
  // A questionnaire (multi-question/multiSelect ask): a single option or a
  // binary allow maps to the "custom answer" branch remote input can never
  // fill — the only honest affordance is opening the app.
  if (update.questionnaire) return 'none';
  // No input channel advertised (pre-MR2 sidecar / option-less snapshot):
  // buttons would silently no-op in answer() — offer open-in-app instead.
  if (!update.controlInputFile) return 'none';
  return update.options && update.options.length > 0 ? 'options' : 'allow_deny';
}
