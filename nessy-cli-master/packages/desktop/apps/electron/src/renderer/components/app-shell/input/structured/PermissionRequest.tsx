// [nessy-fork] desktop-permission-request-ui
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, Check, X, RefreshCw, Terminal, Database, Globe, Shield, Code, FileText, Braces } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
// [nessy-fork] desktop-mcp-permission-args-preview
import { formatMcpToolName, parseMcpArguments } from '@/lib/mcp-permission'
import type { PermissionRequest as PermissionRequestType } from '../../../../../shared/types'
import type { PermissionResponse } from './types'

interface PermissionRequestProps {
  request: PermissionRequestType
  onResponse: (response: PermissionResponse) => void
  /** When true, removes container styling (shadow, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
}

/**
 * PermissionRequest - Self-contained structured input for permission approval
 *
 * Supports multiple permission types:
 * - bash: Shell command execution with command preview
 * - file_write: File modifications with unified diff rendering
 * - mcp_mutation: MCP server tool calls with server/tool info
 * - api_mutation: API endpoint calls with URL/method details
 * - admin_approval: System-level changes with impact description
 * - ask_user_question: Structured questions with options
 *
 * Shows:
 * - Icon + "Permission Required" header
 * - Tool name badge
 * - Type-specific details (diff, command, API endpoint, etc.)
 * - Action buttons: Allow, Always Allow, Deny
 */
export function PermissionRequest({ request, onResponse, unstyled = false }: PermissionRequestProps) {
  const { t } = useTranslation()
  const appShellContext = useOptionalAppShellContext()
  const onOpenPermissionDiff = appShellContext?.onOpenPermissionDiff
  const onClosePermissionDiff = appShellContext?.onClosePermissionDiff
  // [nessy-fork] desktop-plan-permission-flow
  const isPlanApproval = request.toolName === 'ExitPlanMode'
  const planMarkdown =
    request.impact || request.description.replace(/^Plan:\s*/i, '')
  const onOpenPermissionPlan = appShellContext?.onOpenPermissionPlan
  const onClosePermissionPlan = appShellContext?.onClosePermissionPlan
  // [nessy-fork] desktop-terminal-command-preview
  const onOpenPermissionCommand = appShellContext?.onOpenPermissionCommand
  const onClosePermissionCommand = appShellContext?.onClosePermissionCommand

  // Check permission type for rendering
  const isFileWrite = request.type === 'file_write'
  const isBash = request.type === 'bash' || (!request.type && !!request.command)
  const isMcpMutation = request.type === 'mcp_mutation'
  const isApiMutation = request.type === 'api_mutation'
  const isAdminApproval = request.type === 'admin_approval'

  // Show side panel button for any bash command with content
  const showSidePanelButton = Boolean(
    isBash && request.command && request.command.length > 0 && onOpenPermissionCommand,
  )

  // [nessy-fork] desktop-mcp-permission-args-preview
  // ACP ships the MCP tool arguments as the stringified request description.
  const mcpToolName = formatMcpToolName(request.toolName)
  const mcpArguments = isMcpMutation ? parseMcpArguments(request.description) : null
  const showMcpArgumentsButton = Boolean(mcpArguments && onOpenPermissionCommand)

  useEffect(
    () => () => onClosePermissionCommand?.(request.requestId),
    [onClosePermissionCommand, request.requestId],
  )

  useEffect(() => {
    if (!isPlanApproval || !planMarkdown || !onOpenPermissionPlan) {
      return
    }

    onOpenPermissionPlan({
      requestId: request.requestId,
      content: planMarkdown,
    })

    return () => onClosePermissionPlan?.(request.requestId)
  }, [
    isPlanApproval,
    onClosePermissionPlan,
    onOpenPermissionPlan,
    planMarkdown,
    request.requestId,
  ])

  useEffect(() => {
    if (
      !isFileWrite ||
      (request.newText === undefined && !request.diff) ||
      !onOpenPermissionDiff
    ) {
      return
    }

    onOpenPermissionDiff({
      requestId: request.requestId,
      filePath: request.filePath,
      oldText: request.oldText,
      newText: request.newText,
      diff: request.diff,
    })

    return () => onClosePermissionDiff?.(request.requestId)
  }, [
    isFileWrite,
    onClosePermissionDiff,
    onOpenPermissionDiff,
    request.diff,
    request.filePath,
    request.newText,
    request.oldText,
    request.requestId,
  ])

  const handleAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: false })
  }

  const handleAlwaysAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: true })
  }

  const handleDeny = () => {
    onResponse({ type: 'permission', allowed: false, alwaysAllow: false })
  }

  // Get icon based on permission type
  const getTypeIcon = () => {
    if (isBash) return <Terminal className="h-3.5 w-3.5 text-info" />
    if (isFileWrite) return <Code className="h-3.5 w-3.5 text-info" />
    if (isMcpMutation) return <Database className="h-3.5 w-3.5 text-info" />
    if (isApiMutation) return <Globe className="h-3.5 w-3.5 text-info" />
    if (isAdminApproval) return <Shield className="h-3.5 w-3.5 text-info" />
    return <ShieldAlert className="h-3.5 w-3.5 text-info" />
  }

  return (
    <div
      className={cn(
        'overflow-hidden h-full flex flex-col bg-info/5',
        unstyled
          ? 'border-0'
          : 'border border-info/30 rounded-[8px] shadow-middle'
      )}
      data-tutorial="permission-banner"
    >
      {/* Content - grows to fill available space */}
      <div className="p-4 space-y-3 flex-1 min-h-0 flex flex-col">
        <div className="space-y-2 pb-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            {getTypeIcon()}
            <span>{t('chat.permissionRequired')}</span>
          </div>
          <div className="text-xs leading-[18px] text-muted-foreground">
            <span className="font-medium text-foreground">Tool:</span>{' '}
            {/* [nessy-fork] desktop-mcp-permission-args-preview */}
            {isMcpMutation ? mcpToolName : request.toolName}
            {isPlanApproval ? (
              <div className="mt-2 text-foreground">
                Review the proposed plan in the side panel.
              </div>
            ) : isFileWrite ? (
              <div className="mt-2 text-foreground">
                {request.description}
              </div>
            ) : isBash ? (
              // Render bash command - command IS the description for bash
              <div className="mt-2 flex gap-2">
                <div className="flex-1 min-w-0">
                  {request.command && (
                    <div
                      className="truncate rounded-md border border-border/30 bg-foreground/5 px-3 py-2 font-mono text-xs text-foreground/90"
                    >
                      <span className="text-muted-foreground">$ </span>
                      {request.command}
                    </div>
                  )}
                </div>
                {/* Show side panel toggle for bash commands */}
                {showSidePanelButton && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0 cursor-pointer"
                    onClick={() =>
                      onOpenPermissionCommand?.({
                        requestId: request.requestId,
                        command: request.command!,
                        description: request.description,
                      })
                    }
                    title="Show full command in side panel"
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ) : isMcpMutation ? (
              // [nessy-fork] desktop-mcp-permission-args-preview
              // Render MCP arguments as a single truncated line; the full payload
              // goes to the side panel through the same channel bash commands use.
              <div className="mt-2 flex gap-2">
                <div className="flex-1 min-w-0">
                  {mcpArguments ? (
                    <div className="truncate rounded-md border border-border/30 bg-foreground/5 px-3 py-2 font-mono text-xs text-foreground/90">
                      {mcpArguments.compact}
                    </div>
                  ) : (
                    <div className="text-foreground">{request.description}</div>
                  )}
                </div>
                {showMcpArgumentsButton && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0 cursor-pointer"
                    onClick={() =>
                      onOpenPermissionCommand?.({
                        requestId: request.requestId,
                        command: mcpArguments!.pretty,
                        description: mcpToolName,
                        variant: 'mcp',
                      })
                    }
                    title="Show full arguments in side panel"
                  >
                    <Braces className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ) : isApiMutation ? (
              // Render API call details
              <div className="mt-2 space-y-2">
                <div className="text-foreground">
                  {request.description}
                </div>
                {request.command && (
                  <div className="bg-muted/50 rounded-md p-3 font-mono text-xs border border-border/30">
                    <div className="text-muted-foreground mb-1">API Request:</div>
                    <pre className="whitespace-pre-wrap break-all text-foreground/90">
                      {request.command}
                    </pre>
                  </div>
                )}
              </div>
            ) : isAdminApproval ? (
              // Render admin approval with impact details
              <div className="mt-2 space-y-2">
                {request.reason && (
                  <div>
                    <span className="font-medium text-foreground">Reason:</span>
                    <div className="text-foreground/90 mt-0.5">{request.reason}</div>
                  </div>
                )}
                {request.impact && (
                  <div>
                    <span className="font-medium text-foreground">Impact:</span>
                    <div className="text-foreground/90 mt-0.5">{request.impact}</div>
                  </div>
                )}
                {request.appName && (
                  <div>
                    <span className="font-medium text-foreground">Application:</span>
                    <div className="text-foreground/90 mt-0.5">{request.appName}</div>
                  </div>
                )}
              </div>
            ) : (
              // Default: show description
              <>
                <br />
                {request.description}
              </>
            )}
          </div>
        </div>

        {/* Command preview for bash commands (not shown for file_write with diff) */}
        {request.command && !isFileWrite && !isBash && !isMcpMutation && !isApiMutation && (
          <div className="bg-foreground/5 rounded-md p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
            {request.command}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1.5"
          onClick={handleAllow}
          data-tutorial="permission-allow-button"
        >
          <Check className="h-3.5 w-3.5" />
          Allow
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10"
          onClick={handleAlwaysAllow}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Always Allow
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-destructive hover:text-destructive border border-dashed border-destructive/50 hover:bg-destructive/10 hover:border-destructive/70 active:bg-destructive/20"
          onClick={handleDeny}
        >
          <X className="h-3.5 w-3.5" />
          Deny
        </Button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Tip text */}
        <span className="text-[10px] text-muted-foreground">
          "Always Allow" remembers this command for the session
        </span>
      </div>
    </div>
  )
}
