import type { PermissionRequest, CredentialRequest, CredentialResponse } from '../../../../../shared/types'
import type { AdminApprovalRequestData } from './AdminApprovalRequest'

/**
 * Input mode determines which component is rendered in InputContainer
 */
export type InputMode = 'freeform' | 'structured'

/**
 * Types of structured input UIs
 */
export type StructuredInputType = 'permission' | 'ask_user' | 'credential' | 'admin_approval' | 'workflow_launch'

/**
 * Union type for structured input data
 */
export type StructuredInputData =
  | { type: 'permission'; data: PermissionRequest }
  | { type: 'ask_user'; data: PermissionRequest }
  | { type: 'credential'; data: CredentialRequest }
  | { type: 'admin_approval'; data: AdminApprovalRequestData }
  | { type: 'workflow_launch'; data: PermissionRequest }

/**
 * State for structured input
 */
export interface StructuredInputState {
  type: StructuredInputType
  data: PermissionRequest | CredentialRequest | AdminApprovalRequestData
}

/**
 * Response from permission request
 */
export interface PermissionResponse {
  type: 'permission'
  allowed: boolean
  alwaysAllow: boolean
  options?: import('../../../../../shared/types').PermissionResponseOptions
}

/**
 * Response from admin approval request
 */
export interface AdminApprovalResponse {
  type: 'admin_approval'
  approved: boolean
  rememberForMinutes?: number
}

/**
 * Response from a workflow launch consent card. `always` records the durable
 * per-workflow-per-project consent host-side ("don't ask again for <name> in <path>").
 */
export interface WorkflowLaunchResponse {
  type: 'workflow_launch'
  approved: boolean
  always?: boolean
}

/**
 * Union type for all structured responses
 */
export type StructuredResponse = PermissionResponse | CredentialResponse | AdminApprovalResponse | WorkflowLaunchResponse

// Re-export CredentialResponse for convenience
export type { CredentialResponse }
