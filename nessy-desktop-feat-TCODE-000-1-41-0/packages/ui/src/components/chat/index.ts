/**
 * Chat component exports for @nessy-agent/ui
 */

// Turn utilities (pure functions, no React)
export * from './turn-utils'
export * from './follow-up-helpers'
// P6.469 — the one transcript verbosity, shared by every runtime's transcript.
export * from './transcript-verbosity'

// Components
export { TurnCard, ResponseCard, SIZE_CONFIG, ActivityStatusIcon, type TurnCardProps, type ResponseCardProps, type ActivityItem, type ActivityRenderProps, type ActivityStatus, type ResponseContent, type TodoItem } from './TurnCard'
export { formatToolDisplay } from './tool-display' // F1.477 (P4)
export { InlineExecution, mapToolEventToActivity, type InlineExecutionProps, type InlineExecutionStatus, type InlineActivityItem } from './InlineExecution'
export { TurnCardActionsMenu, type TurnCardActionsMenuProps } from './TurnCardActionsMenu'
export { SessionViewer, NessyLogo, type SessionViewerProps, type SessionViewerMode } from './SessionViewer'
export { UserMessageBubble, type UserMessageBubbleProps } from './UserMessageBubble'
export { SystemMessage, type SystemMessageProps, type SystemMessageType } from './SystemMessage'

// Attachment helpers
export { FileTypeIcon, getFileTypeLabel, type FileTypeIconProps } from './attachment-helpers'

// Accept plan dropdown (for plan cards)
export { AcceptPlanDropdown } from './AcceptPlanDropdown'
