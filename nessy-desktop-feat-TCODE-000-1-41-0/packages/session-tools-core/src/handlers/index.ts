/**
 * Session Tools Core - Handlers
 *
 * Exports all handler functions for session-scoped tools.
 * These handlers are used by both Claude and Codex implementations.
 */

// SubmitPlan
export { handleSubmitPlan } from './submit-plan.ts';
export type { SubmitPlanArgs } from './submit-plan.ts';

// Config Validate
export { handleConfigValidate } from './config-validate.ts';
export { handleDecide, DECIDE_UNAVAILABLE, DECIDE_MAX_QUESTIONS, DECIDE_MAX_ITEMS, DECIDE_BATCH_CONCURRENCY, DECIDE_DEFAULT_DEADLINE_MS, DECIDE_MAX_BATCH_WALL_MS, compactDecisionAnswers, formatDecisionError } from './decide.ts'; // UB6.11
export type { ConfigValidateArgs } from './config-validate.ts';

// Skill Validate
export { handleSkillValidate } from './skill-validate.ts';
export type { SkillValidateArgs } from './skill-validate.ts';

// Mermaid Validate
export { handleMermaidValidate } from './mermaid-validate.ts';
export type { MermaidValidateArgs } from './mermaid-validate.ts';

// Source Test
export { handleSourceTest } from './source-test.ts';
export type { SourceTestArgs } from './source-test.ts';

// OAuth Triggers
export {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
} from './source-oauth.ts';
export type {
  SourceOAuthTriggerArgs,
  GoogleOAuthTriggerArgs,
} from './source-oauth.ts';

// Credential Prompt
export { handleCredentialPrompt } from './credential-prompt.ts';
export type { CredentialPromptArgs } from './credential-prompt.ts';

// Update Preferences
export { handleUpdatePreferences } from './update-preferences.ts';
export type { UpdatePreferencesArgs } from './update-preferences.ts';

// Memory
export { handleRemember, MEMORY_FILE_NAME } from './remember.ts';
export type { RememberArgs } from './remember.ts';

// Todo
export { handleTodoWrite } from './todo-write.ts';
export type { TodoWriteArgs } from './todo-write.ts';
export { handleTask } from './task.ts';
export type { TaskArgs } from './task.ts';
export {
  handleTaskCreate,
  handleTaskUpdate,
  handleTaskGet,
  handleTaskList,
  repairTaskToolInput,
} from './task-tools.ts';
export { handleGoal, handleGoalGet } from './goal.ts';
// R27b — session-scoped scheduling.
export { handleCronCreate, handleCronDelete, handleCronList } from './cron-tools.ts';
export { handleReportFindings } from './report-findings.ts';
export type { ReportedFinding } from './report-findings.ts';
export {
  handlePushNotification,
  resetPushNotificationRateLimit,
  PUSH_NOTIFICATION_MAX_PER_WINDOW,
  PUSH_NOTIFICATION_WINDOW_MS,
} from './push-notification.ts';
export { handleSendUserFile, SEND_USER_FILE_MAX_BYTES } from './send-user-file.ts';
export type { DeliveredFile } from './send-user-file.ts';

// Transform Data
export { handleTransformData } from './transform-data.ts';
export type { TransformDataArgs } from './transform-data.ts';

// Script Sandbox
export { handleScriptSandbox } from './script-sandbox.ts';
export type { ScriptSandboxArgs } from './script-sandbox.ts';

// Render Template
export { handleRenderTemplate } from './render-template.ts';
export type { RenderTemplateArgs } from './render-template.ts';

// Send Developer Feedback
export { handleSendDeveloperFeedback } from './send-developer-feedback.ts';
export type { SendDeveloperFeedbackArgs } from './send-developer-feedback.ts';

// Slash Commands
export { handleSlashCommand } from './slash-command.ts';
export type { SlashCommandArgs } from './slash-command.ts';

// Background Bash Output
export { handleBashOutput } from './bash-output.ts';
export type { BashOutputArgs } from './bash-output.ts';
export { handleProcessStop } from './process-stop.ts';
export type { ProcessStopArgs } from './process-stop.ts';
export { handleMonitor, MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS } from './monitor.ts';
export type { MonitorArgs } from './monitor.ts';

// Session Self-Management
export { handleSetSessionLabels } from './set-session-labels.ts';
export type { SetSessionLabelsArgs } from './set-session-labels.ts';
export { handleSetSessionStatus } from './set-session-status.ts';
export type { SetSessionStatusArgs } from './set-session-status.ts';
export { handleGetSessionInfo } from './get-session-info.ts';
export type { GetSessionInfoArgs } from './get-session-info.ts';
export { handleListSessions } from './list-sessions.ts';
export type { ListSessionsArgs } from './list-sessions.ts';

// Automation Management
export {
  AutomationActionInputSchema,
  AutomationCreateSchema,
  AutomationKindSchema,
  AutomationListSchema,
  AutomationUpdateSchema,
  AutomationValidateSchema,
  handleAutomationCreate,
  handleAutomationList,
  handleAutomationUpdate,
  handleAutomationValidate, findUnattendedAutomationEdit,
} from './automation-management.ts';
export type {
  AutomationCreateArgs,
  AutomationListArgs,
  AutomationUpdateArgs, UnattendedAutomationEdit,
  AutomationValidateArgs,
} from './automation-management.ts';

// Skill Resources (R17 — dereference a `skill-resource:` handle)
export { handleReadSkillResource } from './skill-resources.ts';
export type { ReadSkillResourceArgs } from './skill-resources.ts';

// Pages (UA6.3 — v0.13.4 handlers/index.ts L82–L98; appended, the schemas and descriptions ride with the handlers)
export {
  handleListPages,
  handleGetPage,
  handleCreatePage,
  handleUpdatePage,
  handleWritePageData,
  handleDeletePage,
} from './pages.ts';
export type {
  ListPagesArgs,
  GetPageArgs,
  CreatePageArgs,
  UpdatePageArgs,
  WritePageDataArgs,
  DeletePageArgs,
} from './pages.ts';
