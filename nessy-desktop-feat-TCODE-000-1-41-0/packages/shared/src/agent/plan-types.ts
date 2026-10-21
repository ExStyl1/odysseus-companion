/**
 * Plan Types
 *
 * Defines the structure for plans and plan-related types.
 * Plans are used for structured task execution with user review.
 */

import { randomUUID } from 'crypto';

/**
 * The current state of a plan
 */
export type PlanState =
  | 'creating'    // Claude is generating the plan
  | 'refining'    // User is providing feedback, Claude is refining
  | 'ready'       // Plan is approved and ready to execute
  | 'executing'   // Plan is being executed
  | 'completed'   // Plan execution finished
  | 'cancelled';  // User cancelled the plan

/**
 * A single step in a plan
 */
export interface PlanStep {
  /** Unique identifier for this step */
  id: string;
  /** Human-readable description of what this step does */
  description: string;
  /** Current status of this step */
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  /** Optional detailed implementation notes */
  details?: string;
  /** Files that will be modified in this step */
  files?: string[];
  /** Estimated complexity (for UI display) */
  complexity?: 'low' | 'medium' | 'high';
}

/**
 * A complete plan for a task
 */
export interface Plan {
  /** Unique identifier */
  id: string;
  /** Short title describing the plan */
  title: string;
  /** Current state of the plan */
  state: PlanState;
  /** Ordered list of steps to execute */
  steps: PlanStep[];
  /** Original user request that triggered this plan */
  context: string;
  /** Current refinement iteration (0 = initial, 1+ = after feedback) */
  refinementRound: number;
  /** Timestamp when plan was created */
  createdAt: number;
  /** Timestamp when plan was last modified */
  updatedAt: number;
  /** History of refinements for reference */
  refinementHistory?: PlanRefinementEntry[];
}

/**
 * A single refinement round entry
 */
export interface PlanRefinementEntry {
  /** Round number */
  round: number;
  /** Questions Claude asked */
  questions: string[];
  /** User's feedback/answers */
  feedback: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Request for user to review and potentially refine a plan
 */
export interface PlanRefinementRequest {
  /** The current plan */
  plan: Plan;
  /** Questions from Claude that need user input */
  questions: string[];
  /** Optional suggestions for improvement */
  suggestions?: string[];
}

/**
 * Events emitted during plan mode
 */
export type PlanEvent =
  | { type: 'plan_creating'; message: string }
  | { type: 'plan_ready'; plan: Plan; questions?: string[] }
  | { type: 'plan_refining'; plan: Plan; feedback: string }
  | { type: 'plan_approved'; plan: Plan }
  | { type: 'plan_cancelled' }
  | { type: 'plan_step_start'; stepId: string; description: string }
  | { type: 'plan_step_complete'; stepId: string }
  | { type: 'plan_complete'; plan: Plan };

/**
 * Options for starting plan mode
 */
export interface PlanModeOptions {
  /** The task to plan for */
  task: string;
  /** Skip refinement and auto-approve (for simple tasks) */
  autoApprove?: boolean;
  /** Maximum refinement rounds before forcing a decision */
  maxRefinementRounds?: number;
}

/**
 * Result of checking if a task should trigger plan mode
 */
export interface PlanSuggestion {
  /** Whether planning is suggested */
  shouldPlan: boolean;
  /** Reason for the suggestion */
  reason?: string;
  /** Complexity assessment */
  complexity?: 'simple' | 'moderate' | 'complex';
}

/**
 * Request sent to UI when a plan is ready for review
 */
export interface PlanReviewRequest {
  /** Unique identifier for this review request */
  requestId: string;
  /** The plan to review */
  plan: Plan;
  /** Optional questions from Claude that need user input */
  questions?: string[];
}

/**
 * Result of a plan review from the user
 */
export type PlanReviewResult =
  | { action: 'approve'; modifiedPlan?: Plan }
  | { action: 'refine'; feedback: string }
  | { action: 'saveOnly'; modifiedPlan?: Plan }
  | { action: 'cancel' };

/**
 * Helper to create a new plan
 */
export function createPlan(title: string, context: string): Plan {
  return {
    id: randomUUID(),
    title,
    state: 'creating',
    steps: [],
    context,
    refinementRound: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Helper to create a plan step
 */
export function createPlanStep(description: string, details?: string): PlanStep {
  return {
    id: randomUUID(),
    description,
    status: 'pending',
    details,
  };
}

/**
 * Helper to update plan state
 */
export function updatePlanState(plan: Plan, state: PlanState): Plan {
  return {
    ...plan,
    state,
    updatedAt: Date.now(),
  };
}

/**
 * Helper to add refinement entry to plan
 */
export function addRefinementEntry(
  plan: Plan,
  questions: string[],
  feedback: string
): Plan {
  const entry: PlanRefinementEntry = {
    round: plan.refinementRound + 1,
    questions,
    feedback,
    timestamp: Date.now(),
  };

  return {
    ...plan,
    refinementRound: plan.refinementRound + 1,
    refinementHistory: [...(plan.refinementHistory || []), entry],
    updatedAt: Date.now(),
  };
}

// ============================================
// Permission Mode UI Messages (single source of truth)
// ============================================
// Permission modes control tool execution behavior.
// User can cycle via SHIFT+TAB: Explore -> Plan -> Ask -> Accept edits -> Auto -> Execute -> Explore

import type { PermissionMode } from './mode-manager.ts';
import { PERMISSION_MODE_AGENT_LABELS } from './mode-types.ts';

/** User-visible messages for each permission mode */
export const PERMISSION_MODE_MESSAGES: Record<PermissionMode, string> = {
  'dontAsk': `${PERMISSION_MODE_AGENT_LABELS['dontAsk']} mode active. Nothing prompts; only pre-approved tools run.`,
  'plan': `${PERMISSION_MODE_AGENT_LABELS['plan']} mode active. Read-only planning enabled.`,
  'default': `${PERMISSION_MODE_AGENT_LABELS['default']} mode active. Prompts for dangerous operations.`,
  'acceptEdits': `${PERMISSION_MODE_AGENT_LABELS['acceptEdits']} mode active. File edits are accepted automatically; other mutations still prompt.`,
  'auto': `${PERMISSION_MODE_AGENT_LABELS['auto']} mode active. Low-risk actions run automatically; risky operations still prompt.`,
  'bypassPermissions': `${PERMISSION_MODE_AGENT_LABELS['bypassPermissions']} mode active. All operations permitted.`,
};

/** System prompts sent to Claude when mode changes */
export const PERMISSION_MODE_PROMPTS: Record<PermissionMode, string> = {
  'dontAsk': `The user has switched to ${PERMISSION_MODE_AGENT_LABELS['dontAsk']} mode. Nobody is available to answer prompts: tools the permission rules pre-approve run, everything else is denied, and asking the user is unavailable. Report what was blocked rather than retrying it.`,
  'plan': `The user has switched to ${PERMISSION_MODE_AGENT_LABELS['plan']} mode. You can read files, search, and use SubmitPlan, but must not make file changes or run mutating commands.`,
  'default': `The user has switched to ${PERMISSION_MODE_AGENT_LABELS['default']} mode. Most operations are allowed, but dangerous bash commands will prompt for user approval. You have access to write operations.`,
  'acceptEdits': `The user has switched to ${PERMISSION_MODE_AGENT_LABELS['acceptEdits']} mode. File edits are accepted automatically, but shell, network, and MCP mutations still require approval.`,
  'auto': `The user has switched to ${PERMISSION_MODE_AGENT_LABELS['auto']} mode. File edits and low-risk actions are accepted automatically, but risky shell, network, MCP, and API mutations still require approval.`,
  'bypassPermissions': `The user has switched to ${PERMISSION_MODE_AGENT_LABELS['bypassPermissions']} mode. All operations are permitted without prompts. Use with care.`,
};
