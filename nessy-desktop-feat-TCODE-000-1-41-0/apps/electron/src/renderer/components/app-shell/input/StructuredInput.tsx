import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import type { PermissionRequest as PermissionRequestType, CredentialRequest as CredentialRequestType } from '../../../../shared/types'
import { PermissionRequest } from './structured/PermissionRequest'
import { AskUserRequest } from './structured/AskUserRequest'
import { CredentialRequest } from './structured/CredentialRequest'
import { AdminApprovalRequest } from './structured/AdminApprovalRequest'
import { WorkflowLaunchRequest } from './structured/WorkflowLaunchRequest'
import type { StructuredInputState, StructuredResponse } from './structured/types'

interface StructuredInputProps {
  state: StructuredInputState
  onResponse: (response: StructuredResponse) => void
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
  /**
   * The session's live permission mode and its setter, forwarded to the
   * permission card only. P6.208 (A40): the documented **Yes, and switch to auto
   * mode** answer is offered "in the Manual and `acceptEdits` permission modes",
   * and it both approves and switches — so the card needs the mode it is being
   * shown under and the same setter the composer's picker uses.
   */
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
}

/**
 * StructuredInput - Router component for structured input UIs
 *
 * Routes to the appropriate component based on the input type:
 * - permission: PermissionRequest (bash command approval)
 * - credential: CredentialRequest (secure auth input)
 */
export function StructuredInput({
  state,
  onResponse,
  unstyled = false,
  permissionMode,
  onPermissionModeChange,
}: StructuredInputProps) {
  switch (state.type) {
    case 'permission':
      // F1.1219 follow-up: keyed per ask, so each queued request mounts its own
      // card. React honours `autoFocus` only on mount, so a reused instance
      // would leave a `defaultToNo` ask focused on the Allow just clicked; the
      // key also drops a note typed for the previous ask.
      return (
        <PermissionRequest
          key={(state.data as PermissionRequestType).requestId}
          request={state.data as PermissionRequestType}
          onResponse={onResponse}
          unstyled={unstyled}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
        />
      )
    case 'ask_user':
      return (
        <AskUserRequest
          request={state.data as PermissionRequestType}
          onResponse={onResponse}
          unstyled={unstyled}
        />
      )
    case 'credential':
      return (
        <CredentialRequest
          request={state.data as CredentialRequestType}
          onResponse={onResponse}
          unstyled={unstyled}
        />
      )
    case 'admin_approval':
      return (
        <AdminApprovalRequest
          request={state.data as import('./structured/AdminApprovalRequest').AdminApprovalRequestData}
          onApprove={({ rememberForMinutes }) => onResponse({ type: 'admin_approval', approved: true, rememberForMinutes })}
          onCancel={() => onResponse({ type: 'admin_approval', approved: false })}
          unstyled={unstyled}
        />
      )
    case 'workflow_launch':
      return (
        <WorkflowLaunchRequest
          request={state.data as PermissionRequestType}
          onRespond={(approved, always) => onResponse({ type: 'workflow_launch', approved, always })}
          unstyled={unstyled}
        />
      )
    default:
      return null
  }
}
