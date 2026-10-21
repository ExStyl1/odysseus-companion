import * as React from 'react'
import type { ComponentEntry, ComponentVariant } from './types'
import { AgentPanel, toAgentPanelRows } from '@/components/app-shell/AgentPanel'
import { AttachmentPreview } from '@/components/app-shell/AttachmentPreview'
import { SetupAuthBanner } from '@/components/app-shell/SetupAuthBanner'
import { TurnCard, type ActivityItem } from '@nessy-agent/ui'
import type { BackgroundTask } from '@/components/app-shell/ActiveTasksBar'
import { BackgroundTaskChip } from '@/components/app-shell/BackgroundTaskChip'
import { TaskOutputOverlay } from '@/components/app-shell/chat-display/TaskOutputOverlay'
import type { AgentTaskOutput, TaskOutputOverlayState } from '@/components/app-shell/task-output'
import { useTheme } from '@/hooks/useTheme'
import { PastedCommandChip } from '@/components/app-shell/input/PastedCommandChip'
import { ActiveOptionBadges } from '@/components/app-shell/ActiveOptionBadges'
import { ChatInputZone, InputContainer, QueuedMessageList } from '@/components/app-shell/input'
import type { StructuredResponse } from '@/components/app-shell/input/structured/types'
import { EmptyStateHint, getHintCount, getHintTemplate } from '@/components/chat/EmptyStateHint'
import { Button } from '@/components/ui/button'
import { motion } from 'motion/react'
import { ArrowUp, Paperclip, ChevronDown, Circle, Sparkles } from 'lucide-react'
import { PERMISSION_MODE_ORDER } from '@nessy-agent/shared/agent/modes'
import type { LabelConfig } from '@nessy-agent/shared/labels'
import type { SessionStatus } from '@/config/session-status-config'
import type { QueuedMessageDto } from '@nessy-agent/shared/protocol'
import type { CredentialRequest, FileAttachment, PermissionRequest, PermissionMode } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { AppShellProvider } from '@/context/AppShellContext'
import { ModalProvider } from '@/context/ModalContext'
import {
  ensureMockElectronAPI,
  overrideElectronApiMethod,
  mockInputCallbacks,
  mockAttachmentCallbacks,
  mockSources,
  filterMockMcpResources,
  sampleImageAttachment,
  samplePdfAttachment,
  PLAYGROUND_SHELL_ID,
  PLAYGROUND_FAILED_SHELL_ID,
} from '../mock-utils'
import { mockAdminApprovalRequest } from '../adapters/input-adapters'
import { ComposerCapabilitiesProvider, DEFAULT_COMPOSER_CAPABILITIES } from '@/components/app-shell/input/composer-capabilities-context'
import { getRecentProjectsForScenario, type RecentProjectScenario } from '../recent-working-dirs'
/**
 * The panel's states, refusals included.
 *
 * A refused control (`child-session-not-active`,
 * `child-session-not-running`, `pi-child-service-unavailable`) used to render as
 * a cleared input box, so the failed states are canonical entries here rather
 * than something only a live session can produce.
 *
 * Every row also carries the run parameters the panel now shows — `effort` and
 * `model` (`statusline.md` § `subagentStatusLine`). The last entry deliberately
 * carries NEITHER: that is what a summary from a host predating those fields
 * looks like, and the row has to stay legible in that state too.
 */
const agentPanelVariants: ComponentVariant[] = [
  {
    name: 'One running fork',
    props: {
      rows: toAgentPanelRows([
        { agentId: 'fork-1', agent: 'fork', task: 'draft unit tests for the parser changes', status: 'running', background: true, effort: 'medium', model: 'claude-opus-4-8' },
      ]),
      errors: {},
    },
  },
  {
    name: 'Fork and named subagent',
    props: {
      rows: toAgentPanelRows([
        { agentId: 'fork-1', agent: 'fork', task: 'draft unit tests', status: 'running', background: true, effort: 'medium', model: 'claude-opus-4-8' },
        // The frontmatter-override case: a subagent running ABOVE its session.
        { agentId: 'scout-1', agent: 'scout', task: 'survey the repo', status: 'completed', background: true, effort: 'xhigh', model: 'claude-opus-4-8' },
      ]),
      errors: {},
    },
  },
  {
    name: 'Follow-up refused (settled fork)',
    props: {
      rows: toAgentPanelRows([
        { agentId: 'fork-1', agent: 'fork', task: 'draft unit tests', status: 'completed', background: true, effort: 'low', model: 'claude-opus-4-8' },
      ]),
      errors: { 'fork-1': 'child-session-not-active' },
    },
  },
  {
    name: 'Runtime unavailable',
    props: {
      rows: toAgentPanelRows([
        { agentId: 'fork-1', agent: 'fork', task: 'draft unit tests', status: 'running', background: true, effort: 'high', model: 'claude-opus-4-8' },
      ]),
      errors: { 'fork-1': 'pi-child-service-unavailable' },
    },
  },
  {
    // The width case: a gateway model id is long and unbranded, and the row is
    // compact — this is the state that proves the label truncates instead of
    // pushing the status and the controls off the row.
    name: 'Long model id and a long task',
    props: {
      rows: toAgentPanelRows([
        { agentId: 'coder-1', agent: 'worker', task: 'rewrite the interceptor stream so parallel tool calls stop duplicating', status: 'running', background: true, effort: 'xhigh', model: 'pi/tgpt/qwen35-397b-a17b-fp8' },
      ]),
      errors: {},
    },
  },
  {
    name: 'Host predating effort and model',
    props: {
      rows: toAgentPanelRows([
        { agentId: 'fork-1', agent: 'fork', task: 'draft unit tests', status: 'running', background: true },
      ]),
      errors: {},
    },
  },
]

const sampleCodeAttachment: FileAttachment = {
  type: 'text',
  path: '/Users/test/app.tsx',
  name: 'App.tsx',
  mimeType: 'text/typescript',
  size: 8500,
}

// UB14.27 — the one-line FileName's three shapes (v0.15.1 AttachmentPreview).
const sampleLongNameAttachment: FileAttachment = {
  type: 'text',
  path: '/Users/test/q3-planning-notes-for-the-gateway-migration.md',
  name: 'q3-planning-notes-for-the-gateway-migration.md',
  mimeType: 'text/markdown',
  size: 4200,
}
const sampleNoExtensionAttachment: FileAttachment = {
  type: 'text',
  path: '/Users/test/Makefile-for-the-release-rehearsal-pipeline',
  name: 'Makefile-for-the-release-rehearsal-pipeline',
  mimeType: 'text/plain',
  size: 900,
}
const sampleLongExtensionAttachment: FileAttachment = {
  type: 'text',
  path: '/Users/test/settings.reference-snapshot',
  name: 'settings.reference-snapshot',
  mimeType: 'text/plain',
  size: 1300,
}
const samplePastedTextAttachment: FileAttachment = {
  type: 'text',
  path: 'pasted-text-1.txt',
  name: 'pasted-text-1.txt',
  mimeType: 'text/plain',
  text: 'A long paste the composer kept as a chip.',
  size: 41,
  origin: 'pasted-text',
}

const samplePermissionRequest: PermissionRequest = {
  requestId: 'perm-1',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run shell command',
  command: 'npm install --save-dev typescript @types/react',
}

// The sandbox-escape band: the server attaches `impact` when the call carries
// a consequence the description does not state, and the card must show it.
const sampleImpactPermissionRequest: PermissionRequest = {
  requestId: 'perm-impact-1',
  sessionId: 'session-1',
  toolName: 'bash',
  type: 'bash',
  description: 'Run shell command',
  command: 'rsync -a ./dist/ deploy@staging:/srv/app/',
  impact: 'Runs outside the sandbox: matched the administrator\'s excludedCommands pattern "rsync".',
}

// UB14.27 — a call the decision model labelled (UB6.10 risk badges): the composer card
// swaps the info ring for the destructive one (`getDecisionTone` → 'danger').
const sampleRiskyPermissionRequest: PermissionRequest = {
  requestId: 'perm-risky-1',
  sessionId: 'session-1',
  toolName: 'bash',
  type: 'bash',
  description: 'Remove the build output',
  command: 'rm -rf ./dist ./build',
  risks: ['deletes'],
}

// UB14.23 — the credential card on the decision anatomy: a header-auth API key (label + header
// name, description, hint, 1Password `sourceUrl`) and a basic-auth pair with an optional password.
const sampleCredentialRequest: CredentialRequest = {
  type: 'credential',
  requestId: 'cred-1',
  sessionId: 'session-1',
  sourceSlug: 'linear-api',
  sourceName: 'Linear',
  mode: 'header',
  headerName: 'Authorization',
  labels: { credential: 'API Key' },
  description: 'Paste a personal API key so the agent can read and update issues.',
  hint: 'Linear → Settings → Security & access → Personal API keys',
  sourceUrl: 'https://linear.app',
}

const sampleBasicCredentialRequest: CredentialRequest = {
  type: 'credential',
  requestId: 'cred-2',
  sessionId: 'session-1',
  sourceSlug: 'jira-server',
  sourceName: 'Jira Server',
  mode: 'basic',
  passwordRequired: false,
  description: 'Sign in with your Jira account.',
}

// UB14.24 — every variant of the permission card on the decision anatomy: the answers it offers
// and the sentence in its foot are its own, the material is upstream's. One sample per variant.
const PLAYGROUND_PERMISSION_VARIANTS = {
  // P6.208 — a runtime-raised Bash prompt in Manual: "Yes, and switch to auto mode" is offered.
  permission_auto_switch: {
    requestId: 'perm-auto-1',
    sessionId: 'session-1',
    toolName: 'Bash',
    type: 'bash',
    origin: 'claude_native',
    description: 'Run the test suite',
    command: 'bun test ./packages/shared',
  },
  // UA12.105 — a Bash card the host minted no remember key for: no Always Allow, "nothing is remembered".
  permission_no_remember: {
    requestId: 'perm-no-remember-1',
    sessionId: 'session-1',
    toolName: 'Bash',
    type: 'bash',
    origin: 'host_gate',
    description: 'Remove the build output',
    command: 'rm -rf build',
    noAlwaysAllow: true,
  },
  // sub-agents.md — a subagent's prompt names the agent; curl buys a session-only Always Allow (D1.262).
  permission_subagent: {
    requestId: 'perm-subagent-1',
    sessionId: 'session-1',
    toolName: 'Bash',
    type: 'bash',
    origin: 'host_gate',
    agentLabel: 'release-auditor (child 2)',
    description: 'Fetch the release feed',
    command: 'curl -s https://updates.example.invalid/feed.json',
  },
  // P6.202 (3) — auto mode's first read outside the working directories: three answers.
  permission_outside_read: {
    requestId: 'perm-outside-read-1',
    sessionId: 'session-1',
    toolName: 'Read',
    type: 'file_write',
    description: 'Read a file outside the working directory',
    outsideWorkingDirectoryRead: { path: '/etc/hosts', tool: 'Read', workingDirectory: '/Users/demo/projects/nessy-general-agent' },
    noAlwaysAllow: true,
  },
  // P6 — a path outside the workspace root: Allow once · Allow for this session · Deny.
  permission_outside_root: {
    requestId: 'perm-outside-root-1',
    sessionId: 'session-1',
    toolName: 'Write',
    type: 'outside_root',
    description: 'Write /Users/demo/elsewhere/notes.txt, outside the workspace root',
  },
  // P6.135 — keep or remove the worktree at close; never remembered.
  permission_worktree_cleanup: {
    requestId: 'perm-worktree-cleanup-1',
    sessionId: 'session-1',
    toolName: 'WorktreeCleanup',
    type: 'worktree_cleanup',
    description: 'This chat is closing while it still holds the worktree at /repo/.nessy-worktrees/app/w, on branch `nessy/session-1/lease`. Remove it, or keep it for later?',
    impact: 'The worktree still has uncommitted or untracked changes.',
  },
  // P6.500 / P6.950 — the reopen dialog: summary · as is · don't ask again.
  permission_reopen_compact: {
    requestId: 'perm-reopen-1',
    sessionId: 'session-1',
    toolName: 'ResumeConversation',
    type: 'ask_user',
    description: 'This conversation is large and has been idle. Continue from a summary, or as is?',
    noAlwaysAllow: true,
    reopenCompact: { contextTokens: 150_000, thresholdTokens: 100_000, idleHours: 26 },
  },
  // UA1.18 — the publish card: the details, Publish as the affirmative answer, no remembering answer.
  permission_artifact_publish: {
    requestId: 'perm-publish-1',
    sessionId: 'session-1',
    toolName: 'publish_artifact',
    origin: 'host_gate',
    description: 'Publish "Release notes" (notes.md) on https://artifacts.example.invalid.',
    noAlwaysAllow: true,
    artifactPublish: {
      mode: 'create',
      sourcePath: 'notes.md',
      contentType: 'markdown',
      title: 'Release notes',
      emoji: '📝',
      byteLength: 412,
      lineCount: 14,
      sha256: 'abcdef0123456789'.repeat(4),
      serviceOrigin: 'https://artifacts.example.invalid',
      expiresAt: '2026-10-23T12:00:00.000Z',
      retentionDays: 7,
      previewContent: '# Release notes\n\n- The permission card moves onto the decision anatomy.',
      previewTruncated: false,
      sourceHead: '# Release notes',
      scriptCount: 0,
      externalHosts: [],
      scanSentence: 'Automatic check found no known token formats; it does not detect encoded or free-form secrets or client data.',
      emailCount: 0,
      phoneCount: 0,
    },
  },
  // F1.1219 — a `defaultToNo` ask: Allow is not the solid primary and focus opens on Deny.
  permission_default_to_no: {
    requestId: 'perm-default-no-1',
    sessionId: 'session-1',
    toolName: 'Bash',
    type: 'bash',
    origin: 'claude_native',
    description: 'Force-push the branch',
    command: 'git push --force-with-lease origin feature',
    defaultToNo: true,
  },
} satisfies Record<string, PermissionRequest>

type PlaygroundPermissionVariant = keyof typeof PLAYGROUND_PERMISSION_VARIANTS

const sampleWorkflowLaunchRequest: PermissionRequest = {
  requestId: 'perm-workflow-1',
  sessionId: 'session-1',
  toolName: 'workflow',
  type: 'workflow_launch',
  command: 'release-audit',
  description: 'Run the workflow "release-audit"? Planned phases: Discover → Audit → Report. It orchestrates subagents in the background and can use substantially more tokens than one conversation.',
}

/** UB14.25 — a workflow that declares no phases (`describeWorkflowLaunchConsent`'s other sentence): the three answers stay. */
const sampleWorkflowLaunchNoPhasesRequest: PermissionRequest = {
  requestId: 'perm-workflow-2',
  sessionId: 'session-1',
  toolName: 'workflow',
  type: 'workflow_launch',
  command: 'scratch-run',
  description: 'Run the workflow "scratch-run"? This workflow declares no phases up front. It orchestrates subagents in the background and can use substantially more tokens than one conversation.',
}

/** UB14.25 — the ask-user card hosted by the composer slot: one question with options and a free-text answer. */
const sampleAskUserRequest: PermissionRequest = {
  requestId: 'perm-ask-1',
  sessionId: 'session-1',
  toolName: 'ask_user',
  type: 'ask_user',
  description: 'Ask the user a question',
  askUser: {
    question: 'Which implementation path should the agent take?',
    options: ['Ship the focused fix', 'Broaden the refactor', 'Stop and summarize'],
    allowFreeText: true,
  },
}

/** UB14.25 — AskUserQuestion with two questions (one single-select, one multi-select) in the composer slot. */
const sampleAskUserBatchedRequest: PermissionRequest = {
  requestId: 'perm-ask-2',
  sessionId: 'session-1',
  toolName: 'AskUserQuestion',
  type: 'ask_user',
  description: 'Clarifying questions',
  askUser: {
    question: 'How should the agent format the output?',
    options: ['Summary', 'Detailed'],
    allowFreeText: true,
    questions: [
      {
        question: 'How should the agent format the output?',
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief overview of key points' },
          { label: 'Detailed', description: 'Full explanation with examples' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which sections should the agent include?',
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Opening context' },
          { label: 'Conclusion', description: 'Final summary' },
        ],
        multiSelect: true,
      },
    ],
  },
}

const longPermissionRequest: PermissionRequest = {
  requestId: 'perm-2',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run shell command',
  command: 'find /Users/test/project -type f -name "*.ts" | xargs grep -l "deprecated" | head -20',
}

const veryLongPermissionRequest: PermissionRequest = {
  requestId: 'perm-3',
  sessionId: 'session-1',
  toolName: 'bash',
  description: 'Run complex deployment script',
  command: `#!/bin/bash
set -e

echo "Starting deployment..."
cd /Users/project/app

# Build the application
npm run build
npm run test

# Docker operations
docker build -t myapp:latest .
docker tag myapp:latest registry.example.com/myapp:latest
docker push registry.example.com/myapp:latest

# Deploy to kubernetes
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/myapp`,
}

// UB14.7 (v0.15.1's set) — a running Claude agent with its live step count (`listed`: named by the CLI's live level,
// so its card reads the digest), a running Pi command, a finished agent whose end left a record, and a failed Pi
// command. The playground's `readBackgroundTaskOutput` mock answers per id.
const sampleBackgroundTasks: BackgroundTask[] = [
  {
    id: 'agent-abc123',
    type: 'agent',
    toolUseId: 'tool-1',
    startTime: Date.now() - 169000, // 2m 49s ago
    elapsedSeconds: 169,
    status: 'running',
    intent: 'Adversarial review of label fix',
    listed: true,
    activity: { lastToolName: 'Grep', toolUses: 23 },
  },
  {
    id: PLAYGROUND_SHELL_ID,
    type: 'shell',
    toolUseId: 'tool-2',
    startTime: Date.now() - 154000, // 2m 34s ago
    elapsedSeconds: 154,
    status: 'running',
    intent: 'bun test --watch',
  },
  {
    id: 'agent-done789',
    type: 'agent',
    toolUseId: 'tool-3',
    startTime: Date.now() - 192000,
    elapsedSeconds: 190,
    status: 'completed',
    completedAt: Date.now() - 2000,
    intent: 'Research Radix popover focus rules',
    listed: true,
    endOutput: true,
  },
  {
    id: PLAYGROUND_FAILED_SHELL_ID,
    type: 'shell',
    toolUseId: 'tool-4',
    startTime: Date.now() - 20000,
    elapsedSeconds: 18,
    status: 'failed',
    completedAt: Date.now() - 1000,
    intent: 'bun run lint',
  },
]

const singleBackgroundTask: BackgroundTask[] = [
  {
    id: 'task-123456',
    type: 'agent',
    toolUseId: 'tool-single',
    startTime: Date.now() - 23000,
    elapsedSeconds: 23,
    status: 'running',
    intent: 'Search for TypeScript files',
  },
]

const longRunningTasks: BackgroundTask[] = [
  {
    id: 'task-long-1',
    type: 'agent',
    toolUseId: 'tool-long-1',
    startTime: Date.now() - 3723000, // 1h 2m 3s
    elapsedSeconds: 3723,
    status: 'running',
    intent: 'Refactor authentication system',
  },
  {
    id: 'shell-long-2',
    type: 'shell',
    toolUseId: 'tool-long-2',
    startTime: Date.now() - 245000, // 4m 5s
    elapsedSeconds: 245,
    status: 'running',
  },
  {
    id: 'task-long-3',
    type: 'agent',
    toolUseId: 'tool-long-3',
    startTime: Date.now() - 12000, // 12s
    elapsedSeconds: 12,
    status: 'running',
    intent: 'Run tests',
  },
]

// UA12.18 — every chip lifecycle state, one chip each: running (spinner + shimmer + wall-clock), a workflow, the three
// terminal states as they linger after their end (status word, no clock; failed tinted), stale (info tint, "No signal",
// hint on hover), and a chip with no captured intent (its id is the label). UB14.7 adds Stopping… (spinner, no
// shimmer) after a Stop the host accepted.
const lifecycleBackgroundTasks: BackgroundTask[] = [
  { id: 'task-stop-req-1', type: 'agent', toolUseId: 'tool-lc-8', startTime: Date.now() - 50_000, elapsedSeconds: 50, status: 'running', intent: 'Index the monorepo', stopping: true },
  { id: 'task-run-1', type: 'agent', toolUseId: 'tool-lc-1', startTime: Date.now() - 95_000, elapsedSeconds: 60, status: 'running', intent: 'Review the diff' },
  { id: 'wf-spec-1', type: 'workflow', toolUseId: 'tool-lc-2', startTime: Date.now() - 300_000, elapsedSeconds: 0, status: 'running', intent: 'spec' },
  { id: 'task-done-1', type: 'agent', toolUseId: 'tool-lc-3', startTime: Date.now() - 42_000, elapsedSeconds: 40, status: 'completed', completedAt: Date.now(), intent: 'Scan inventory' },
  { id: 'task-fail-1', type: 'agent', toolUseId: 'tool-lc-4', startTime: Date.now() - 12_000, elapsedSeconds: 11, status: 'failed', completedAt: Date.now(), intent: 'Migrate the schema' },
  { id: 'shell-stop-1', type: 'shell', toolUseId: 'tool-lc-5', startTime: Date.now() - 30_000, elapsedSeconds: 0, status: 'stopped', completedAt: Date.now(), intent: 'npm run dev' },
  { id: 'task-stale-1', type: 'agent', toolUseId: 'tool-lc-6', startTime: Date.now() - 25 * 60_000, elapsedSeconds: 0, status: 'stale', intent: 'Long research pass' },
  { id: 'bash-9f3a2c71', type: 'shell', toolUseId: 'tool-lc-7', startTime: Date.now() - 7_000, elapsedSeconds: 0, status: 'running' },
]

const mockQueuedMessages: QueuedMessageDto[] = [
  {
    id: 'queue-1',
    text: 'Add a regression test for queued follow-up replay.',
    attachmentsCount: 0,
  },
  {
    id: 'queue-2',
    text: 'Check the interrupted paused queue state before merging.',
    attachmentsCount: 1,
  },
]

const inputContainerSampleLabels: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  { id: 'due-date', name: 'Due Date', color: { light: '#3B82F6', dark: '#60A5FA' }, valueType: 'date' },
  { id: 'sprint', name: 'Sprint', color: { light: '#8B5CF6', dark: '#A78BFA' }, valueType: 'string' },
]

const inputContainerSampleStatuses: SessionStatus[] = [
  {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--muted-foreground)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'in-progress',
    label: 'In Progress',
    resolvedColor: 'var(--info)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'done',
    label: 'Done',
    resolvedColor: 'var(--success)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'closed',
  },
]

const playgroundAppShellContext = {
  workspaces: [{ id: 'playground-workspace', name: 'Playground' }],
  activeWorkspaceId: 'playground-workspace',
  llmConnections: [],
  workspaceDefaultLlmConnection: undefined,
  refreshLlmConnections: async () => {},
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  getDraft: () => '',
  sessionOptions: new Map(),
  onCreateSession: async () => ({
    id: 'playground-session',
    workspaceId: 'playground-workspace',
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }),
  onSendMessage: () => {},
  onRenameSession: () => {},
  onFlagSession: () => {},
  onUnflagSession: () => {},
  onArchiveSession: () => {},
  onUnarchiveSession: () => {},
  onMarkSessionRead: () => {},
  onMarkSessionUnread: () => {},
  onSetActiveViewingSession: () => {},
  // The # menu's status picker reads these from the shell context (v0.15.1; UB14.55 — the zone no longer takes them)
  sessionStatuses: inputContainerSampleStatuses,
  onSessionStatusChange: () => {},
  onDeleteSession: async () => true,
  onOpenFile: () => {},
  onOpenUrl: () => {},
  onSelectWorkspace: () => {},
  onRefreshWorkspaces: () => {},
  onOpenSettings: () => {},
  onOpenKeyboardShortcuts: () => {},
  onOpenStoredUserPreferences: () => {},
  onReset: () => {},
  onSessionOptionsChange: () => {},
  onInputChange: () => {},
}

// ============================================================================
// Sample Nested Tool Activities (Task subagent with child tools)
// ============================================================================

/** Flat list of tools (no nesting) */
const flatActivities: ActivityItem[] = [
  {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-1',
    toolInput: { file_path: 'src/components/App.tsx' },
    content: 'File contents...',
    timestamp: Date.now() - 3000,
    depth: 0,
  },
  {
    id: 'tool-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolUseId: 'grep-1',
    toolInput: { pattern: 'useState', path: 'src/' },
    content: '15 matches found',
    timestamp: Date.now() - 2000,
    depth: 0,
  },
  {
    id: 'tool-3',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-1',
    toolInput: { file_path: 'src/components/App.tsx' },
    content: 'File updated',
    timestamp: Date.now() - 1000,
    depth: 0,
  },
]

/** Task with nested child tools (completed) */
const nestedActivitiesCompleted: ActivityItem[] = [
  {
    id: 'task-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-parent-1',
    toolInput: { description: 'Explore codebase structure', subagent_type: 'Explore' },
    content: 'Exploration complete',
    timestamp: Date.now() - 5000,
    depth: 0,
  },
  {
    id: 'read-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-child-1',
    toolInput: { file_path: 'package.json' },
    content: '{ "name": "my-app", ... }',
    timestamp: Date.now() - 4500,
    parentId: 'task-parent-1',
    depth: 1,
  },
  {
    id: 'glob-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Glob',
    toolUseId: 'glob-child-1',
    toolInput: { pattern: 'src/**/*.tsx' },
    content: '24 files matched',
    timestamp: Date.now() - 4000,
    parentId: 'task-parent-1',
    depth: 1,
  },
  {
    id: 'grep-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolUseId: 'grep-child-1',
    toolInput: { pattern: 'export function' },
    content: '156 matches',
    timestamp: Date.now() - 3500,
    parentId: 'task-parent-1',
    depth: 1,
  },
  {
    id: 'read-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-child-2',
    toolInput: { file_path: 'src/index.tsx' },
    content: 'Entry point file...',
    timestamp: Date.now() - 3000,
    parentId: 'task-parent-1',
    depth: 1,
  },
]

/** Task with nested child tools (in progress) */
const nestedActivitiesInProgress: ActivityItem[] = [
  {
    id: 'task-2',
    type: 'tool',
    status: 'running',
    toolName: 'Task',
    toolUseId: 'task-parent-2',
    toolInput: { description: 'Implement new feature', subagent_type: 'general-purpose' },
    timestamp: Date.now() - 3000,
    depth: 0,
  },
  {
    id: 'read-3',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-child-3',
    toolInput: { file_path: 'src/components/Button.tsx' },
    content: 'Component file...',
    timestamp: Date.now() - 2500,
    parentId: 'task-parent-2',
    depth: 1,
  },
  {
    id: 'edit-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-child-1',
    toolInput: { file_path: 'src/components/Button.tsx' },
    content: 'Added onClick handler',
    timestamp: Date.now() - 2000,
    parentId: 'task-parent-2',
    depth: 1,
  },
  {
    id: 'write-1',
    type: 'tool',
    status: 'running',
    toolName: 'Write',
    toolUseId: 'write-child-1',
    toolInput: { file_path: 'src/components/NewFeature.tsx' },
    timestamp: Date.now() - 500,
    parentId: 'task-parent-2',
    depth: 1,
  },
]

/** Multiple nested Task tools */
const multipleNestedTasks: ActivityItem[] = [
  {
    id: 'task-a',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-a-id',
    toolInput: { description: 'Analyze code quality', subagent_type: 'Explore' },
    content: 'Analysis complete',
    timestamp: Date.now() - 10000,
    depth: 0,
  },
  {
    id: 'grep-a1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolUseId: 'grep-a1-id',
    toolInput: { pattern: 'TODO|FIXME' },
    content: '23 issues found',
    timestamp: Date.now() - 9500,
    parentId: 'task-a-id',
    depth: 1,
  },
  {
    id: 'read-a1',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-a1-id',
    toolInput: { file_path: 'src/legacy/OldComponent.tsx' },
    content: 'Legacy code...',
    timestamp: Date.now() - 9000,
    parentId: 'task-a-id',
    depth: 1,
  },
  {
    id: 'task-b',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-b-id',
    toolInput: { description: 'Fix identified issues', subagent_type: 'general-purpose' },
    content: 'Issues fixed',
    timestamp: Date.now() - 5000,
    depth: 0,
  },
  {
    id: 'edit-b1',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-b1-id',
    toolInput: { file_path: 'src/legacy/OldComponent.tsx' },
    content: 'Removed deprecated code',
    timestamp: Date.now() - 4500,
    parentId: 'task-b-id',
    depth: 1,
  },
  {
    id: 'bash-b1',
    type: 'tool',
    status: 'completed',
    toolName: 'Bash',
    toolUseId: 'bash-b1-id',
    toolInput: { command: 'npm run lint:fix', description: 'Auto-fix linting issues' },
    content: 'Fixed 12 issues',
    timestamp: Date.now() - 4000,
    parentId: 'task-b-id',
    depth: 1,
  },
  {
    id: 'write-b1',
    type: 'tool',
    status: 'completed',
    toolName: 'Write',
    toolUseId: 'write-b1-id',
    toolInput: { file_path: 'src/components/ModernComponent.tsx' },
    content: 'Created new component',
    timestamp: Date.now() - 3500,
    parentId: 'task-b-id',
    depth: 1,
  },
]

/** Deep nesting example (2+ levels) */
const deepNestedActivities: ActivityItem[] = [
  {
    id: 'task-outer',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-outer-id',
    toolInput: { description: 'Refactor authentication', subagent_type: 'Plan' },
    content: 'Refactoring complete',
    timestamp: Date.now() - 8000,
    depth: 0,
  },
  {
    id: 'task-inner',
    type: 'tool',
    status: 'completed',
    toolName: 'Task',
    toolUseId: 'task-inner-id',
    toolInput: { description: 'Implement OAuth flow', subagent_type: 'general-purpose' },
    content: 'OAuth implemented',
    timestamp: Date.now() - 7500,
    parentId: 'task-outer-id',
    depth: 1,
  },
  {
    id: 'read-deep',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: 'read-deep-id',
    toolInput: { file_path: 'src/auth/oauth.ts' },
    content: 'OAuth config...',
    timestamp: Date.now() - 7000,
    parentId: 'task-inner-id',
    depth: 2,
  },
  {
    id: 'edit-deep',
    type: 'tool',
    status: 'completed',
    toolName: 'Edit',
    toolUseId: 'edit-deep-id',
    toolInput: { file_path: 'src/auth/oauth.ts' },
    content: 'Added PKCE support',
    timestamp: Date.now() - 6500,
    parentId: 'task-inner-id',
    depth: 2,
  },
  {
    id: 'write-auth',
    type: 'tool',
    status: 'completed',
    toolName: 'Write',
    toolUseId: 'write-auth-id',
    toolInput: { file_path: 'src/auth/callback.ts' },
    content: 'Created callback handler',
    timestamp: Date.now() - 6000,
    parentId: 'task-inner-id',
    depth: 2,
  },
  {
    id: 'bash-test',
    type: 'tool',
    status: 'completed',
    toolName: 'Bash',
    toolUseId: 'bash-test-id',
    toolInput: { command: 'npm test', description: 'Run auth tests' },
    content: 'All tests passed',
    timestamp: Date.now() - 5000,
    parentId: 'task-outer-id',
    depth: 1,
  },
]

type InputContainerMode = 'freeform' | 'permission' | 'permission_impact' | 'permission_risky' | PlaygroundPermissionVariant | 'admin_approval' | 'admin_approval_ask_rule' | 'credential' | 'credential_basic' | 'workflow_launch' | 'workflow_launch_no_phases' | 'ask_user' | 'ask_user_batched'

/**
 * UB14.28 — the context meter's states. `none` is a session nothing has reported for yet (the meter
 * draws nothing); `quiet` is the always-on ring below the warning; `warning` is v0.15.1's info-tint
 * chip (≥ 80% of the compaction threshold); `estimatedWindow` is the quiet ring over a fallback window;
 * `unknownWindow` is an occupancy with no window (the broken ring) — pair it with a model the catalogue
 * has no window for, or the catalogue's window is used.
 */
type PlaygroundContextUsage = 'none' | 'quiet' | 'warning' | 'estimatedWindow' | 'unknownWindow'

const PLAYGROUND_CONTEXT_STATUS: Record<PlaygroundContextUsage, React.ComponentProps<typeof InputContainer>['contextStatus']> = {
  none: undefined,
  quiet: { inputTokens: 48_000, contextWindow: 200_000, autoCompactionThreshold: 155_000 },
  warning: { inputTokens: 140_000, contextWindow: 200_000, autoCompactionThreshold: 155_000 },
  estimatedWindow: { inputTokens: 48_000, contextWindow: 200_000, autoCompactionThreshold: 155_000, contextWindowSource: 'fallback' },
  unknownWindow: { inputTokens: 48_000 },
}

/** A model id the catalogue has no context window for (the unknown-window state needs one). */
const PLAYGROUND_UNLISTED_MODEL = 'local-unlisted-model'

/** UB14.28 — a draft, so the submit control shows Send (idle) / Queue / Steer instead of an empty Send. */
const PLAYGROUND_DRAFT = 'Also cover the retry path.'

interface InputContainerPlaygroundProps {
  disabled?: boolean
  isProcessing?: boolean
  placeholder?: string
  currentModel?: string
  permissionMode?: PermissionMode
  workingDirectory?: string
  inputMode?: InputContainerMode
  compactMode?: boolean
  showOptionBadges?: boolean
  showTasks?: boolean
  showLabels?: boolean
  showStatuses?: boolean
  labelCount?: number
  /** UB14.55 — P6.502: the session is never written to disk (a fact chip in the row above the card). */
  neverPersist?: boolean
  /** UB14.55 — P6.940: the agent the session runs as (`composerCapabilities.sessionAgent`; a fact chip above the card). */
  sessionAgent?: string
  showSources?: boolean
  sourceCount?: number
  showMcpResources?: boolean
  showWorkingDirectory?: boolean
  seedRecentProjects?: boolean
  recentProjectScenario?: RecentProjectScenario
  showAttachments?: boolean
  attachmentCount?: number
  showFollowUps?: boolean
  followUpCount?: number
  showQueue?: boolean
  queuePaused?: boolean
  /** UB14.28 — the context meter state (see {@link PlaygroundContextUsage}). */
  contextUsage?: PlaygroundContextUsage
  /** UB14.28 — the runtime queues mid-turn sends (`composerCapabilities.submit.queue`); else it steers. */
  queueCapable?: boolean
  /** UB14.28 — text already in the composer. */
  draft?: string
  /** UB14.24 — the runtime carries an answer note (`composerCapabilities.answerNote`): ordinary permission cards offer "Add a note". */
  answerNote?: boolean
  /**
   * UA1.13 — what `ChatDisplay.handleStop` does on a non-silent Stop
   * (`composerTextAfterStop`): the stopped prompt comes back into the input. With
   * `isProcessing` on, `Up` in the EMPTY composer runs that same Stop path, so the
   * sample prompt below appears; with a waiting double-Esc draft, `Up` restores
   * the draft instead and nothing is stopped.
   */
  restorePromptOnStop?: boolean
}

/** UA1.13 — the playground's stand-in for the prompt of the turn being stopped. */
const PLAYGROUND_STOPPED_PROMPT = 'Summarise the failing tests and propose a fix.'

function InputContainerPlayground({
  disabled = false,
  isProcessing = false,
  placeholder = 'Message Nessy...',
  currentModel = 'claude-sonnet-4-6',
  permissionMode = 'default',
  workingDirectory = '/Users/demo/projects/nessy-general-agent',
  inputMode = 'freeform',
  compactMode = false,
  showOptionBadges = true,
  showTasks = true,
  showLabels = true,
  showStatuses = true,
  labelCount = 3,
  neverPersist = false,
  sessionAgent,
  showSources = true,
  sourceCount = 2,
  showMcpResources = true,
  showWorkingDirectory = true,
  seedRecentProjects = true,
  recentProjectScenario = 'few',
  showAttachments = false,
  attachmentCount = 2,
  showFollowUps = false,
  followUpCount = 2,
  showQueue = false,
  queuePaused = false,
  restorePromptOnStop = true,
  contextUsage = 'none',
  queueCapable = false,
  draft = '',
  answerNote = false,
}: InputContainerPlaygroundProps) {
  const playgroundSessionId = 'playground-session'
  const [model, setModel] = React.useState(currentModel)
  const [mode, setMode] = React.useState<PermissionMode>(permissionMode)
  const [inputValue, setInputValue] = React.useState(draft)
  const composerCapabilities = React.useMemo(() => ({
    ...DEFAULT_COMPOSER_CAPABILITIES,
    submit: { queue: queueCapable, steer: true },
    ...(answerNote ? { answerNote: true as const } : {}),
    ...(sessionAgent ? { sessionAgent } : {}),
  }), [queueCapable, answerNote, sessionAgent])

  React.useEffect(() => {
    setInputValue(draft)
  }, [draft])
  const [currentSessionStatus] = React.useState('in-progress')
  const [cwd, setCwd] = React.useState(workingDirectory)

  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  React.useEffect(() => overrideElectronApiMethod(
    'listRecentProjects',
    async () => (seedRecentProjects ? getRecentProjectsForScenario(recentProjectScenario) : []),
  ), [recentProjectScenario, seedRecentProjects])

  // `mcp.md` § Use MCP resources — resources "appear alongside files in the
  // autocomplete menu" on every backend, so the `@` menu's resource rows are a
  // playground state of their own. `files: []` is the shipped Pi shape: the host
  // answers resources from the session's MCP pool while the local filesystem
  // search still supplies the file rows.
  React.useEffect(() => overrideElectronApiMethod(
    'fuzzyFileSearch',
    async (_sessionId: string, query: string) => (showMcpResources
      ? { files: [], resources: filterMockMcpResources(query) }
      : null),
  ), [showMcpResources])

  React.useEffect(() => {
    setModel(currentModel)
  }, [currentModel])

  React.useEffect(() => {
    setMode(permissionMode)
  }, [permissionMode])

  React.useEffect(() => {
    setCwd(workingDirectory)
  }, [workingDirectory])

  const labels = React.useMemo(() => inputContainerSampleLabels.slice(0, Math.max(1, Math.min(labelCount, inputContainerSampleLabels.length))), [labelCount])

  const [sessionLabels, setSessionLabels] = React.useState<string[]>(['bug', 'priority::2', 'sprint::Q1-S3'])

  React.useEffect(() => {
    const next = labels.map((label) => {
      if (label.id === 'priority') return 'priority::2'
      if (label.id === 'due-date') return 'due-date::2026-03-15'
      if (label.id === 'sprint') return 'sprint::Q1-S3'
      return label.id
    })
    setSessionLabels(next)
  }, [labels])

  const sources = React.useMemo(() => mockSources.slice(0, Math.max(1, Math.min(sourceCount, mockSources.length))), [sourceCount])
  const defaultEnabled = React.useMemo(() => sources.slice(0, Math.min(2, sources.length)).map(source => source.mention?.id ?? source.logicalName), [sources])
  const [enabledSourceSlugs, setEnabledSourceSlugs] = React.useState<string[]>(defaultEnabled)

  React.useEffect(() => {
    setEnabledSourceSlugs(defaultEnabled)
  }, [defaultEnabled])

  const followUpItems = React.useMemo(() => {
    const samples = [
      {
        id: 'fu-a',
        messageId: 'assistant-msg-1',
        annotationId: 'annotation-1',
        index: 1,
        noteLabel: 'Prevent stale token from discarding draft input.',
        selectedText: 'Include OAuth refresh edge cases',
        color: 'info',
      },
      {
        id: 'fu-b',
        messageId: 'assistant-msg-1',
        annotationId: 'annotation-2',
        index: 2,
        noteLabel: 'Check compact mode and quick mode switching.',
        selectedText: 'Validate animation with permission mode transitions',
        color: 'info',
      },
      {
        id: 'fu-c',
        messageId: 'assistant-msg-2',
        annotationId: 'annotation-3',
        index: 3,
        noteLabel: 'Review spacing and overflow for label/source badge density.',
        selectedText: 'Review label + source badge density on narrow widths',
        color: 'info',
      },
      {
        id: 'fu-d',
        messageId: 'assistant-msg-3',
        annotationId: 'annotation-4',
        index: 4,
        noteLabel: 'Add chip click affordance for jumping back to annotation',
        selectedText: 'Add chip click affordance for jumping back to annotation',
        color: 'info',
      },
    ]
    if (!showFollowUps) return []
    return samples.slice(0, Math.max(1, Math.min(followUpCount, samples.length)))
  }, [showFollowUps, followUpCount])

  const attachmentFiles = React.useMemo(() => {
    if (!showAttachments) return [] as File[]

    const imageBytes = sampleImageAttachment.base64
      ? Uint8Array.from(atob(sampleImageAttachment.base64), char => char.charCodeAt(0))
      : new Uint8Array([137, 80, 78, 71])

    const samples: File[] = [
      new File([imageBytes], sampleImageAttachment.name, { type: sampleImageAttachment.mimeType }),
      new File(['%PDF-1.4\n% Playground sample\n'], samplePdfAttachment.name, { type: samplePdfAttachment.mimeType }),
      new File(['export function App() {\n  return <div>Hello Playground</div>\n}\n'], sampleCodeAttachment.name, { type: sampleCodeAttachment.mimeType }),
    ]

    return samples.slice(0, Math.max(1, Math.min(attachmentCount, samples.length)))
  }, [showAttachments, attachmentCount])

  const attachmentSeedKey = React.useMemo(() => {
    if (!showAttachments) return 'none'
    return attachmentFiles.map(file => `${file.name}:${file.size}`).join('|')
  }, [showAttachments, attachmentFiles])

  React.useEffect(() => {
    if (!showAttachments || attachmentFiles.length === 0) return

    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('nessy:paste-files', {
        detail: {
          files: attachmentFiles,
          sessionId: playgroundSessionId,
        },
      }))
    }, 0)

    return () => clearTimeout(timer)
  }, [showAttachments, attachmentSeedKey, attachmentFiles, playgroundSessionId])

  const structuredInput = React.useMemo(() => {
    if (inputMode === 'permission') {
      return {
        type: 'permission' as const,
        data: samplePermissionRequest,
      }
    }

    if (inputMode === 'permission_impact') {
      return {
        type: 'permission' as const,
        data: sampleImpactPermissionRequest,
      }
    }

    if (inputMode === 'permission_risky') {
      return {
        type: 'permission' as const,
        data: sampleRiskyPermissionRequest,
      }
    }

    if (inputMode in PLAYGROUND_PERMISSION_VARIANTS) {
      return {
        type: 'permission' as const,
        data: PLAYGROUND_PERMISSION_VARIANTS[inputMode as PlaygroundPermissionVariant] as PermissionRequest,
      }
    }

    if (inputMode === 'admin_approval') {
      return {
        type: 'admin_approval' as const,
        data: mockAdminApprovalRequest({
          appName: 'Docker Desktop',
          reason: 'Homebrew needs admin access to complete post-install steps.',
          impact: 'May install files in /Applications and system-managed directories.',
          command: 'brew install --cask docker',
        }),
      }
    }

    // F1.885 — the same install under a readable ask rule: the rule sentence, and no remember switch.
    if (inputMode === 'admin_approval_ask_rule') {
      return {
        type: 'admin_approval' as const,
        data: mockAdminApprovalRequest({
          rememberForMinutes: undefined,
          noAlwaysAllow: true,
          ruleSentence: 'Bash requires approval by readable permission policy rule `ask-brew` (workspace scope).',
        }),
      }
    }

    if (inputMode === 'credential') {
      return { type: 'credential' as const, data: sampleCredentialRequest }
    }

    if (inputMode === 'credential_basic') {
      return { type: 'credential' as const, data: sampleBasicCredentialRequest }
    }

    if (inputMode === 'workflow_launch') {
      return {
        type: 'workflow_launch' as const,
        data: sampleWorkflowLaunchRequest,
      }
    }

    if (inputMode === 'workflow_launch_no_phases') {
      return { type: 'workflow_launch' as const, data: sampleWorkflowLaunchNoPhasesRequest }
    }

    if (inputMode === 'ask_user') {
      return { type: 'ask_user' as const, data: sampleAskUserRequest }
    }

    if (inputMode === 'ask_user_batched') {
      return { type: 'ask_user' as const, data: sampleAskUserBatchedRequest }
    }

    return undefined
  }, [inputMode])

  return (
    <ModalProvider>
    <AppShellProvider value={playgroundAppShellContext as any}>
      <div className="w-full h-full flex flex-col bg-background">
        <div className="flex-1" />

        {showQueue && (
          <div className={cn('mx-auto w-full', compactMode ? CHAT_LAYOUT.controlGutterCompact : CHAT_LAYOUT.controlGutter, CHAT_LAYOUT.maxWidth)}>
            <QueuedMessageList
              queue={mockQueuedMessages}
              paused={queuePaused}
              onSteer={() => {}}
              onEdit={() => {}}
              onDelete={() => {}}
              // P6.51 — the strip's fourth verb. Inert here for the same reason
              // the other three are: the playground renders the surface, and
              // the order it would reorder is the server's.
              onReorder={() => {}}
              onResume={() => {}}
            />
          </div>
        )}

        <ChatInputZone
          key={`input:${inputMode}:${compactMode ? 'compact' : 'full'}:${showAttachments ? attachmentSeedKey : 'none'}:${showFollowUps ? followUpCount : 0}:${showQueue ? `queue-${queuePaused ? 'paused' : 'live'}` : 'no-queue'}:${seedRecentProjects ? recentProjectScenario : 'unseeded'}`}
          compactMode={compactMode}
          showOptionBadges={showOptionBadges}
          permissionMode={mode}
          neverPersist={neverPersist}
          onPermissionModeChange={setMode}
          tasks={showTasks ? sampleBackgroundTasks : []}
          sessionId={playgroundSessionId}
          workspaceId="playground-workspace"
          onStopTask={(target) => console.log('[Playground] Stop task:', target.id)}
          onDismissTask={(target) => console.log('[Playground] Dismiss task:', target.id)}
          sessionLabels={showLabels ? sessionLabels : []}
          labels={showLabels ? labels : []}
          onLabelsChange={setSessionLabels}
          currentSessionStatus={showStatuses ? currentSessionStatus : undefined}
          composerCapabilities={composerCapabilities}
          inputProps={{
            placeholder,
            disabled,
            isProcessing,
            contextStatus: PLAYGROUND_CONTEXT_STATUS[contextUsage],
            structuredInput,
            onStructuredResponse: (response) => {
              console.log('[Playground] Structured response:', response)
            },
            currentModel: model,
            sources: showSources ? sources : [],
            enabledSourceSlugs: showSources ? enabledSourceSlugs : [],
            onSourcesChange: showSources ? setEnabledSourceSlugs : undefined,
            workingDirectory: showWorkingDirectory ? cwd : undefined,
            onWorkingDirectoryChange: showWorkingDirectory ? (project) => setCwd(project.displayPath) : undefined,
            followUpItems,
            onSubmit: mockInputCallbacks.onSubmit,
            onModelChange: setModel,
            onInputChange: setInputValue,
            inputValue,
            onHeightChange: mockInputCallbacks.onHeightChange,
            onFocusChange: mockInputCallbacks.onFocusChange,
            onStop: (silent?: boolean) => {
              mockInputCallbacks.onStop()
              if (!silent && isProcessing && restorePromptOnStop) setInputValue(PLAYGROUND_STOPPED_PROMPT)
            },
          }}
        />
      </div>
    </AppShellProvider>
    </ModalProvider>
  )
}

/**
 * UB14.7 — one background-task chip with its card open, per state the card draws and per runtime: a Claude agent the
 * CLI's live level names (digest: steps + latest message), a Pi command (output tail), a finished agent (its result),
 * a failed Pi command, a codex terminal and a Pi agent task (no host read: no Open, "No output" or the end summary),
 * Stopping…, a chip held for its end report (no Stop) and a stale one (No signal). In the live playground the card
 * polls the `readBackgroundTaskOutput` mock; the static sweep draws its first frame.
 */
const backgroundTaskCardStates: Record<string, BackgroundTask> = {
  claudeAgent: sampleBackgroundTasks[0]!,
  piCommand: sampleBackgroundTasks[1]!,
  finishedAgent: sampleBackgroundTasks[2]!,
  failedCommand: sampleBackgroundTasks[3]!,
  codexTerminal: { id: '4242', type: 'shell', toolUseId: 'tool-codex-1', startTime: Date.now() - 75_000, elapsedSeconds: 0, status: 'running', intent: 'npm run dev' },
  piAgentEnded: { id: 'pi-task-77', type: 'agent', toolUseId: 'tool-pi-1', startTime: Date.now() - 64_000, elapsedSeconds: 60, status: 'completed', completedAt: Date.now() - 1_000, intent: 'Summarise the changelog', summary: 'Summarised 14 entries; no breaking changes.' },
  stopping: { ...sampleBackgroundTasks[0]!, id: 'agent-stopping-1', stopping: true },
  held: { ...sampleBackgroundTasks[0]!, id: 'agent-held-1', unlistedAt: Date.now() - 2_000 },
  stale: { id: 'task-stale-2', type: 'agent', toolUseId: 'tool-stale-2', startTime: Date.now() - 25 * 60_000, elapsedSeconds: 0, status: 'stale', intent: 'Long research pass' },
}

interface BackgroundTaskChipPlaygroundProps {
  task?: BackgroundTask
  /** The card is open (the product opens it on a click) */
  open?: boolean
}

function BackgroundTaskChipPlayground({ task = backgroundTaskCardStates.claudeAgent!, open = true }: BackgroundTaskChipPlaygroundProps) {
  const [isOpen, setOpen] = React.useState(open)
  React.useEffect(() => setOpen(open), [open])
  // UB12.79 — Open fills the same overlay ChatDisplay renders (an agent's digest as a document, a command in the terminal).
  const [opened, setOpened] = React.useState<TaskOutputOverlayState | null>(null)
  const { isDark } = useTheme()
  return (
    <div className="flex min-h-[480px] w-full max-w-[520px] items-end p-6">
      <BackgroundTaskChip
        task={task}
        sessionId="playground-session"
        open={isOpen}
        onOpenChange={setOpen}
        onStop={(target) => console.log('[Playground] Stop task:', target.id)}
        onDismiss={(target) => console.log('[Playground] Dismiss task:', target.id)}
        onOpenOutput={(target, output) => setOpened({ type: 'task-output', title: target.intent?.trim() || target.id, output })}
      />
      {opened && <TaskOutputOverlay state={opened} tasks={[task]} onClose={() => setOpened(null)} theme={isDark ? 'dark' : 'light'} />}
    </div>
  )
}

/**
 * UB12.79 — the overlay the task card's Open fills (v0.15.1's task-output overlay, `chat-display/TaskOutputOverlay`):
 * an agent's digest as one document (its message, then its recent steps, a blue Bot badge naming the task); a
 * command's output in the terminal, with L9's running notice while its row is still listed — not once the row is
 * gone, and not for a command that ended.
 */
const PLAYGROUND_AGENT_DIGEST: AgentTaskOutput = {
  kind: 'agent',
  message: '**Radix popovers trap focus while open.** Hand focus back after unmount in a `requestAnimationFrame`, and pass `onCloseAutoFocus` when the trigger unmounts with the content.',
  steps: [
    { tool: 'Read', label: 'evaluator.ts' },
    { tool: 'Grep', label: 'newAutoLabelEntries' },
    { tool: 'mcp__github__search_code', label: 'Search Code' },
  ],
  truncated: false,
}

const taskOutputOverlayStates: Record<string, TaskOutputOverlayState> = {
  agent: { type: 'task-output', title: 'Research Radix popover focus rules', output: PLAYGROUND_AGENT_DIGEST },
  agentStepsOnly: { type: 'task-output', title: 'Adversarial review of label fix', output: { ...PLAYGROUND_AGENT_DIGEST, message: null } },
  commandRunning: {
    type: 'task-output',
    title: 'bun test --watch',
    output: { kind: 'text', command: 'bun test --watch', output: 'bun test v1.3.10\n\n 89 pass\n 0 fail\n\nWatching for file changes…\n', description: 'bun test --watch', toolType: 'bash', isRunning: true, taskId: PLAYGROUND_SHELL_ID },
  },
  commandEnded: {
    type: 'task-output',
    title: 'Lint the workspace',
    output: { kind: 'text', command: 'bun run lint', output: '$ eslint src\nsrc/a.ts\n  12:7  error  Unexpected any\n\n✖ 1 problem (1 error, 0 warnings)\n', description: 'Lint the workspace', toolType: 'bash', exitCode: 1, isRunning: false, taskId: PLAYGROUND_FAILED_SHELL_ID },
  },
}

interface TaskOutputOverlayPlaygroundProps {
  state?: TaskOutputOverlayState
  /** The task is still among the session's rows (a running command's notice holds only then) */
  listed?: boolean
}

function TaskOutputOverlayPlayground({ state = taskOutputOverlayStates.agent!, listed = true }: TaskOutputOverlayPlaygroundProps) {
  const [open, setOpen] = React.useState(true)
  React.useEffect(() => setOpen(true), [state, listed])
  const { isDark } = useTheme()
  const tasks = listed ? [{ id: PLAYGROUND_SHELL_ID }, { id: PLAYGROUND_FAILED_SHELL_ID }] : []
  return (
    <div className="p-8">
      <Button onClick={() => setOpen(true)}>Open Task Output</Button>
      {open && (
        <TaskOutputOverlay
          state={state}
          tasks={tasks}
          onClose={() => setOpen(false)}
          theme={isDark ? 'dark' : 'light'}
          onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
          onOpenFile={(path) => console.log('[Playground] Open file:', path)}
        />
      )}
    </div>
  )
}

/**
 * UB14.34 — the pasted console snippet's offer, as `ChatInputZone` mounts it directly above the composer card: the
 * meta chip "Run in background" with the command's first line (" …" when it has more), and a dismiss. The zone holds
 * it in state after a paste (and only where the runtime's own tool backgrounds a command), so it is drawn here alone.
 */
function PastedCommandChipPlayground({ command = 'bun test' }: { command?: string }) {
  return (
    <div className={cn('mx-auto w-full', CHAT_LAYOUT.controlGutter, CHAT_LAYOUT.maxWidth)}>
      <PastedCommandChip
        command={command}
        onRun={() => console.log('[Playground] Run in background:', command)}
        onDismiss={() => console.log('[Playground] Dismiss the pasted command')}
      />
    </div>
  )
}

/**
 * Contextual wrapper for ActiveTasksBar showing it with messages and input.
 *
 * THIS ENTRY SHOWED NO TASK ROWS UNTIL `ActiveTasksBar` WAS MOUNTED. It passed
 * `tasks` to `ActiveOptionBadges`, which read the array only to decide whether
 * the row was visible at all — so all four variants below ("With Multiple
 * Tasks", "With Single Task", "With Long Running Tasks", "Empty") rendered the
 * same thing: a mode badge. The design surface named the component and did not
 * exercise it, which is part of why the product mount stayed missing for three
 * tracker rows.
 *
 * `withSessionFacts` is the state UB14.55 adds: the tasks row on its own line
 * and, under it, our one quiet chip row (never-persist P6.502, the pinned agent
 * P6.940). The label stack that used to share the task row is gone with upstream
 * (the chat header owns labels and status, UB14.6).
 */
interface ActiveTasksBarContextProps {
  tasks?: BackgroundTask[]
  /** Render our session-fact chips (never persisted, a pinned agent) under the task row. */
  withSessionFacts?: boolean
}

function ActiveTasksBarContext({ tasks = sampleBackgroundTasks, withSessionFacts = false }: ActiveTasksBarContextProps) {
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('default')
  const capabilities = React.useMemo(
    () => (withSessionFacts ? { ...DEFAULT_COMPOSER_CAPABILITIES, sessionAgent: 'reviewer' } : DEFAULT_COMPOSER_CAPABILITIES),
    [withSessionFacts],
  )

  // Inject mock electronAPI for file attachments
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  return (
    <div className="w-full max-w-[960px] h-full flex flex-col">
      {/* Sample messages for context - matches ChatDisplay padding */}
      <div className="flex-1 overflow-auto px-5 py-8 space-y-2.5">
        {/* User message */}
        <div className="pt-3 flex justify-end">
          <div className="max-w-[80%] rounded-2xl bg-foreground text-background px-4 py-2">
            <p className="text-sm">Can you explore the codebase structure and analyze the API endpoints?</p>
          </div>
        </div>

        {/* Assistant message */}
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2">
            <p className="text-sm">I'll explore the codebase and analyze the API endpoints. Let me start by running a background task to search for API route definitions...</p>
          </div>
        </div>
      </div>

      {/* Input area - matches ChatDisplay padding */}
      <div className="mx-auto w-full px-4 pb-4 mt-1" style={{ maxWidth: 'var(--content-max-width, 960px)' }}>
        {/* Active option badges and tasks. No mode chip: `ChatInputZone` raises it above the card only while a
            decision prompt replaces the toolbar (UB14.33); here the mode control is the toolbar chip (UB14.29). */}
        <ComposerCapabilitiesProvider value={capabilities}>
          <ActiveOptionBadges
            permissionMode={permissionMode}
            showPermissionMode={false}
            onPermissionModeChange={setPermissionMode}
            neverPersist={withSessionFacts}
            tasks={tasks}
            sessionId="playground-session"
            onStopTask={(target) => console.log('[Playground] Stop task:', target.id)}
            onDismissTask={(target) => console.log('[Playground] Dismiss task:', target.id)}
            // The product DOES supply an overlay host — `ChatDisplay` owns a `task-output` overlay state and passes
            // its handler down. This stub keeps the card's Open inspectable here; the overlay itself is the
            // `task-output-overlay` entry (UB12.79). The card (UB14.7) still hides Open for a caller with none.
            onOpenTaskOutput={(target, output) => console.log('[Playground] Open task output:', target.id, output)}
          />
        </ComposerCapabilitiesProvider>

        {/* Real InputContainer */}
        <InputContainer
          placeholder="Message Nessy..."
          disabled={false}
          isProcessing={false}
          currentModel="claude-sonnet-4-6"
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          sources={mockSources}
          enabledSourceSlugs={['github-api', 'local-files']}
          workingDirectory="/Users/demo/projects/nessy-general-agent"
          workspaceId="playground-workspace"
          sessionId="playground-session"
          onSubmit={mockInputCallbacks.onSubmit}
          onModelChange={mockInputCallbacks.onModelChange}
          onInputChange={mockInputCallbacks.onInputChange}
          onHeightChange={mockInputCallbacks.onHeightChange}
          onFocusChange={mockInputCallbacks.onFocusChange}
          onSourcesChange={mockInputCallbacks.onSourcesChange}
          onWorkingDirectoryChange={mockInputCallbacks.onWorkingDirectoryChange}
          onStop={mockInputCallbacks.onStop}
        />
      </div>
    </div>
  )
}

/**
 * UB14.55 — `ActiveOptionBadges` as the page shows it, plus the one input the component reads from a provider rather
 * than a prop: the pinned session agent (`composerCapabilities.sessionAgent`, P6.940 — the server decides whether the
 * pin applies on the session's runtime). Every other prop passes straight through.
 */
function ActiveOptionBadgesPreview({ sessionAgent, ...props }: React.ComponentProps<typeof ActiveOptionBadges> & { sessionAgent?: string }) {
  const capabilities = React.useMemo(
    () => (sessionAgent ? { ...DEFAULT_COMPOSER_CAPABILITIES, sessionAgent } : DEFAULT_COMPOSER_CAPABILITIES),
    [sessionAgent],
  )
  return (
    <ComposerCapabilitiesProvider value={capabilities}>
      <ActiveOptionBadges {...props} />
    </ComposerCapabilitiesProvider>
  )
}

/**
 * Interactive test component for Permission UI ↔ Input View animation transitions
 * Allows toggling between states to inspect the animate in/out behavior
 */
interface PermissionInputToggleProps {
  autoToggle?: boolean
  autoToggleInterval?: number
  useLongCommand?: boolean
}

function PermissionInputToggle({ autoToggle = false, autoToggleInterval = 3000, useLongCommand = false }: PermissionInputToggleProps) {
  const [showPermission, setShowPermission] = React.useState(false)
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('default')

  const permissionRequest = useLongCommand ? veryLongPermissionRequest : samplePermissionRequest

  // Auto-toggle for continuous animation testing
  React.useEffect(() => {
    if (!autoToggle) return
    const interval = setInterval(() => {
      setShowPermission(prev => !prev)
    }, autoToggleInterval)
    return () => clearInterval(interval)
  }, [autoToggle, autoToggleInterval])

  // Inject mock electronAPI for file attachments
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  const handlePermissionResponse = (response: StructuredResponse) => {
    console.log('[Playground] Structured response:', response)
    setShowPermission(false)
  }

  // Build structuredInput state for real InputContainer
  const structuredInput = showPermission ? {
    type: 'permission' as const,
    data: permissionRequest,
  } : undefined

  return (
    <div className="w-full max-w-[960px] h-full flex flex-col px-4 pb-4">
      {/* Spacer to push content to bottom */}
      <div className="flex-1" />

      {/* Control buttons */}
      <div className="flex items-center gap-2 mb-20">
        <Button
          variant={showPermission ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowPermission(true)}
          className="gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Show Permission
        </Button>
        <Button
          variant={!showPermission ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowPermission(false)}
          className="gap-1.5"
        >
          Show Input
        </Button>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          Current: <span className="font-medium">{showPermission ? 'Permission Banner' : 'Input View'}</span>
        </span>
      </div>

      {/* Active option badges */}
      <ActiveOptionBadges
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
      />

      {/* Real InputContainer - handles animation automatically */}
      <InputContainer
        placeholder="Message Nessy..."
        disabled={false}
        isProcessing={false}
        currentModel="claude-sonnet-4-6"
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        sources={mockSources}
        enabledSourceSlugs={['github-api', 'local-files']}
        workingDirectory="/Users/demo/projects/nessy-general-agent"
        workspaceId="playground-workspace"
        sessionId="playground-session"
        structuredInput={structuredInput}
        onStructuredResponse={handlePermissionResponse}
        onSubmit={mockInputCallbacks.onSubmit}
        onModelChange={mockInputCallbacks.onModelChange}
        onInputChange={mockInputCallbacks.onInputChange}
        onHeightChange={mockInputCallbacks.onHeightChange}
        onFocusChange={mockInputCallbacks.onFocusChange}
        onSourcesChange={mockInputCallbacks.onSourcesChange}
        onWorkingDirectoryChange={mockInputCallbacks.onWorkingDirectoryChange}
        onStop={mockInputCallbacks.onStop}
      />
    </div>
  )
}

// Generate variants for all hints dynamically
const emptyStateHintVariants = Array.from({ length: getHintCount() }, (_, i) => ({
  name: `Hint ${i + 1}`,
  description: getHintTemplate(i).slice(0, 50) + '...',
  props: { hintIndex: i },
}))

export const chatComponents: ComponentEntry[] = [
  {
    id: 'agent-panel',
    name: 'AgentPanel',
    category: 'Chat',
    description: 'Observe-and-steer panel for running forks and background subagents, including the refused-control state. Chrome comes from the shared SystemCard primitive.',
    component: AgentPanel,
    props: [
      {
        name: 'mainSessionLabel',
        description: "Name of the main session's row",
        control: { type: 'string' },
        defaultValue: 'Parser work',
      },
    ],
    variants: agentPanelVariants,
    mockData: () => ({
      open: true,
      // Base state = the first variant's one running fork. It was `rows: []`
      // (without it the entry crashed on `rows` undefined), but the panel draws
      // NOTHING with no rows, so the entry opened blank (F1.216).
      rows: agentPanelVariants[0]!.props.rows,
      errors: {},
      onOpenTranscript: () => {},
      // A refusal must be visible AND must not eat the text, so the playground's
      // callback reports the refusal the same way the real hook does.
      onFollowUp: async () => false,
      onDismiss: () => {},
      onReturnFocus: () => {},
    }),
  },
  {
    id: 'empty-state-hint',
    name: 'EmptyStateHint',
    category: 'Chat',
    description: 'Rotating workflow suggestions for empty chat state with inline entity badges (sources, files, folders, skills)',
    component: EmptyStateHint,
    props: [
      {
        name: 'hintIndex',
        description: 'Specific hint to display (0-14). Leave empty for random.',
        control: { type: 'number', min: 0, max: 14, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: emptyStateHintVariants,
    mockData: () => ({}),
  },
  {
    id: 'attachment-preview',
    name: 'AttachmentPreview',
    category: 'Chat',
    description: 'ChatGPT-style attachment preview strip showing attached files as bubbles above textarea',
    component: AttachmentPreview,
    props: [
      {
        name: 'disabled',
        description: 'Disable remove buttons',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'loadingCount',
        description: 'Number of loading placeholders to show',
        control: { type: 'number', min: 0, max: 5, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: [
      { name: 'Empty', props: { attachments: [], loadingCount: 0 } },
      { name: 'With Images', props: { attachments: [sampleImageAttachment, sampleImageAttachment] } },
      { name: 'With Documents', props: { attachments: [samplePdfAttachment, sampleCodeAttachment] } },
      { name: 'Mixed', props: { attachments: [sampleImageAttachment, samplePdfAttachment, sampleCodeAttachment] } },
      { name: 'Loading', props: { attachments: [], loadingCount: 3 } },
      { name: 'Disabled', props: { attachments: [sampleImageAttachment, samplePdfAttachment], disabled: true } },
      {
        name: 'Long names',
        description: 'UB14.27 — one line each: the stem truncates and a short extension stays visible; no extension, or one over 8 characters, truncates whole',
        props: { attachments: [sampleLongNameAttachment, sampleNoExtensionAttachment, sampleLongExtensionAttachment] },
      },
      {
        name: 'Pasted text',
        description: 'A long paste kept as a chip: the localized title and the "Show in text field" restore (ours, kept by UB14.27)',
        props: {
          attachments: [samplePastedTextAttachment, samplePdfAttachment],
          onRestoreText: (attachment: FileAttachment) => console.log('[Playground] Restore pasted text:', attachment.name),
        },
      },
    ],
    mockData: () => ({
      attachments: [sampleImageAttachment, samplePdfAttachment],
      onRemove: mockAttachmentCallbacks.onRemove,
    }),
  },
  {
    id: 'setup-auth-banner',
    name: 'SetupAuthBanner',
    category: 'Chat',
    description: 'Shows when an agent needs activation or authentication',
    component: SetupAuthBanner,
    props: [
      {
        name: 'state',
        description: 'Banner state',
        control: {
          type: 'select',
          options: [
            { label: 'Hidden', value: 'hidden' },
            { label: 'MCP Auth', value: 'mcp_auth' },
            { label: 'API Auth', value: 'api_auth' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'mcp_auth',
      },
      {
        name: 'reason',
        description: 'Custom reason message',
        control: { type: 'string', placeholder: 'Optional custom reason' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'MCP Auth', props: { state: 'mcp_auth' } },
      { name: 'API Auth', props: { state: 'api_auth' } },
      { name: 'Custom Reason', props: { state: 'api_auth', reason: 'Your OAuth token has expired. Please re-authenticate to continue.' } },
      { name: 'Error', props: { state: 'error' } },
      { name: 'Hidden', props: { state: 'hidden' } },
    ],
    mockData: () => ({
      onAction: () => console.log('[Playground] Setup/Auth action clicked'),
    }),
  },
  {
    id: 'active-option-badges',
    name: 'ActiveOptionBadges',
    category: 'Chat',
    description: 'The rows above the chat input: background-task chips, then one quiet chip row with the permission-mode chip (shown while a decision prompt replaces the toolbar) and our session facts — never persisted, the pinned agent, the goal (UB14.55)',
    component: ActiveOptionBadgesPreview,
    props: [
      {
        name: 'permissionMode',
        description: 'Current permission mode',
        control: {
          type: 'select',
          options: PERMISSION_MODE_ORDER.map(mode => ({
            // Registry chrome uses the mode ID — the component itself renders
            // the i18n words the composer shows.
            label: mode,
            value: mode,
          })),
        },
        defaultValue: 'default',
      },
      {
        name: 'variant',
        description: 'Interaction variant',
        control: {
          type: 'select',
          options: [
            { label: 'Dropdown', value: 'dropdown' },
            { label: 'Cycle', value: 'cycle' },
          ],
        },
        defaultValue: 'dropdown',
      },
    ],
    variants: [
      ...PERMISSION_MODE_ORDER.map(mode => ({
        name: `Permission Mode (${mode})`,
        props: { permissionMode: mode, tasks: [], sessionId: 'session-1' },
      })),
      { name: 'Single Task', props: { permissionMode: 'default', tasks: singleBackgroundTask, sessionId: 'session-1' } },
      { name: 'Multiple Tasks', props: { permissionMode: 'default', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Long Running Tasks', props: { permissionMode: 'default', tasks: longRunningTasks, sessionId: 'session-1' } },
      { name: 'All Active (Everything)', props: { permissionMode: 'default', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Tasks in Plan Mode', props: { permissionMode: 'plan', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
      { name: 'Cycle Variant', props: { permissionMode: 'default', tasks: sampleBackgroundTasks, variant: 'cycle', sessionId: 'session-1' } },
      // UB14.55 — our session facts (P6.502, P6.940), on the toolbar's side of the rule (no mode chip) and beside it.
      { name: 'Session Facts Only', props: { showPermissionMode: false, neverPersist: true, sessionAgent: 'reviewer', tasks: [], sessionId: 'session-1' } },
      { name: 'Never Persisted Alone', props: { showPermissionMode: false, neverPersist: true, tasks: [], sessionId: 'session-1' } },
      { name: 'Session Facts + Mode + Tasks', props: { permissionMode: 'acceptEdits', neverPersist: true, sessionAgent: 'reviewer', tasks: sampleBackgroundTasks, sessionId: 'session-1' } },
    ],
    mockData: () => ({
      tasks: sampleBackgroundTasks,
      sessionId: 'session-playground',
      onPermissionModeChange: (mode: string) => console.log('[Playground] Permission mode changed:', mode),
      onStopTask: (target: BackgroundTask) => console.log('[Playground] Stop task:', target.id),
      onDismissTask: (target: BackgroundTask) => console.log('[Playground] Dismiss task:', target.id),
    }),
  },
  {
    id: 'permission-input-toggle',
    name: 'Permission ↔ Input Toggle',
    category: 'Chat',
    description: 'Interactive test for animating between Permission Banner and Input View. Click buttons to toggle states and inspect animations.',
    component: PermissionInputToggle,
    props: [
      {
        name: 'useLongCommand',
        description: 'Use a very long multi-line command',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'autoToggle',
        description: 'Automatically toggle between states',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'autoToggleInterval',
        description: 'Auto-toggle interval in milliseconds',
        control: { type: 'number', min: 1000, max: 10000, step: 500 },
        defaultValue: 3000,
      },
    ],
    variants: [
      { name: 'Short Command', props: { useLongCommand: false } },
      { name: 'Long Command (10+ lines)', props: { useLongCommand: true } },
      { name: 'Auto Toggle', props: { autoToggle: true, autoToggleInterval: 2000 } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'turn-card-flat',
    name: 'TurnCard (Flat Tools)',
    category: 'Turn Cards',
    description: 'TurnCard with flat tool hierarchy - no nesting, all tools at root level',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: flatActivities,
      response: { text: 'I found the pattern across the codebase and made the necessary edits.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'turn-card-nested-complete',
    name: 'TurnCard (Nested - Complete)',
    category: 'Turn Cards',
    description: 'TurnCard showing Task subagent with completed child tools - vertical line tree view',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: nestedActivitiesCompleted,
      response: { text: 'Exploration complete. I found 24 React components with 156 exported functions. The codebase follows a modular pattern.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'turn-card-nested-progress',
    name: 'TurnCard (Nested - In Progress)',
    category: 'Turn Cards',
    description: 'TurnCard showing Task subagent with child tools still running',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: nestedActivitiesInProgress,
      isStreaming: true,
      isComplete: false,
    }),
  },
  {
    id: 'turn-card-multi-task',
    name: 'TurnCard (Multiple Tasks)',
    category: 'Turn Cards',
    description: 'TurnCard showing multiple sequential Task subagents, each with their own child tools',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: multipleNestedTasks,
      response: { text: 'Analysis and fixes complete. I found 23 TODO/FIXME issues, removed deprecated code, and created a modern replacement component.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'turn-card-deep-nested',
    name: 'TurnCard (Deep Nesting)',
    category: 'Turn Cards',
    description: 'TurnCard showing 2+ levels of nesting - Task containing another Task with tools',
    component: TurnCard,
    props: [],
    variants: [
      { name: 'Default', props: {} },
    ],
    mockData: () => ({
      activities: deepNestedActivities,
      response: { text: 'Authentication refactoring complete. I implemented OAuth with PKCE, created a callback handler, and all tests pass.', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }),
  },
  {
    id: 'background-task-chip',
    name: 'Background Task Chip',
    category: 'Chat',
    description: 'UB14.7 — a background task chip above the composer with its card open: live output or an agent\'s steps, Open / Copy / Dismiss / Stop, per runtime (Pi command, Claude agent, codex terminal).',
    component: BackgroundTaskChipPlayground,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      { name: 'open', description: 'The card is open', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Claude Agent (Running)', props: { task: backgroundTaskCardStates.claudeAgent } },
      { name: 'Pi Command (Running)', props: { task: backgroundTaskCardStates.piCommand } },
      { name: 'Finished Agent', props: { task: backgroundTaskCardStates.finishedAgent } },
      { name: 'Failed Command', props: { task: backgroundTaskCardStates.failedCommand } },
      { name: 'Codex Terminal (No Read)', props: { task: backgroundTaskCardStates.codexTerminal } },
      { name: 'Pi Agent Ended (Summary)', props: { task: backgroundTaskCardStates.piAgentEnded } },
      { name: 'Stopping', props: { task: backgroundTaskCardStates.stopping } },
      { name: 'Held For Its End (No Stop)', props: { task: backgroundTaskCardStates.held } },
      { name: 'Stale', props: { task: backgroundTaskCardStates.stale } },
      { name: 'Chip Only (Closed)', props: { task: backgroundTaskCardStates.claudeAgent, open: false } },
    ],
  },
  {
    id: 'task-output-overlay',
    name: 'Task Output Overlay',
    category: 'Chat',
    description: 'UB12.79 — what a background task card\'s Open shows (v0.15.1): an agent\'s message and recent steps as a document, a command\'s whole output in the terminal with the running notice while its row is listed.',
    component: TaskOutputOverlayPlayground,
    layout: 'top',
    props: [
      { name: 'listed', description: 'The task is still among the session\'s rows', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Agent Digest', props: { state: taskOutputOverlayStates.agent } },
      { name: 'Agent Steps Only (No Message Yet)', props: { state: taskOutputOverlayStates.agentStepsOnly } },
      { name: 'Command Running', props: { state: taskOutputOverlayStates.commandRunning } },
      { name: 'Command Running, Row Gone', props: { state: taskOutputOverlayStates.commandRunning, listed: false } },
      { name: 'Command Ended (Exit 1)', props: { state: taskOutputOverlayStates.commandEnded } },
    ],
  },
  {
    id: 'pasted-command-chip',
    name: 'Pasted Command Chip',
    category: 'Chat',
    description: 'UB14.34 — a pasted console snippet offers "Run in background" above the composer (v0.15.0), on runtimes whose own tool backgrounds a command (Claude, Pi); the command\'s first line, " …" when it has more.',
    component: PastedCommandChipPlayground,
    layout: 'centered',
    props: [
      { name: 'command', description: 'The pasted snippet\'s command (prompts removed)', control: { type: 'string' }, defaultValue: 'bun test' },
    ],
    variants: [
      { name: 'Single Command', props: { command: 'bun test' } },
      { name: 'Multi-line (first line + …)', props: { command: 'git status\ngit diff --stat' } },
      { name: 'Long Command (truncated)', props: { command: 'docker compose -f docker-compose.dev.yml up --build --remove-orphans --force-recreate api worker scheduler' } },
    ],
  },
  {
    id: 'active-tasks-bar-context',
    name: 'Active Tasks & Badges',
    category: 'Chat',
    description: 'Background task chips in a wrapping row (UB14.7), on their own line above our session-fact chips (UB14.55). Shows full chat context with messages above and input below.',
    component: ActiveTasksBarContext,
    layout: 'full',
    props: [
      {
        name: 'withSessionFacts',
        description: 'Render our session-fact chips (never persisted, a pinned agent) under the task row',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'With Multiple Tasks', props: { tasks: sampleBackgroundTasks } },
      { name: 'With Single Task', props: { tasks: singleBackgroundTask } },
      { name: 'With Long Running Tasks', props: { tasks: longRunningTasks } },
      // UA12.18 — the chip lifecycle: running, workflow, done, failed, stopped, stale, and a label-less chip.
      { name: 'With Lifecycle States', props: { tasks: lifecycleBackgroundTasks } },
      // UB14.55 — the task row on its own line, our quiet session-fact row under it (labels left for the header).
      { name: 'With Tasks And Session Facts', props: { tasks: sampleBackgroundTasks, withSessionFacts: true } },
      { name: 'Session Facts Only (No Tasks)', props: { tasks: [], withSessionFacts: true } },
      { name: 'Empty (Hidden)', props: { tasks: [] } },
    ],
    mockData: () => ({
      tasks: sampleBackgroundTasks,
    }),
  },
  {
    id: 'input-container',
    name: 'InputContainer',
    category: 'Chat Inputs',
    description: 'App-like input zone with max-width layout, background-task chips, our session-fact chips, the # label and status menu, and full InputContainer behavior. Session status and label chips live in the chat header.',
    component: InputContainerPlayground,
    layout: 'full',
    previewOverflow: 'visible',
    props: [
      {
        name: 'inputMode',
        description: 'Input mode rendered by InputContainer',
        control: {
          type: 'select',
          options: [
            { label: 'Freeform', value: 'freeform' },
            { label: 'Permission', value: 'permission' },
            { label: 'Permission + Impact', value: 'permission_impact' },
            { label: 'Permission (risky, danger ring)', value: 'permission_risky' },
            { label: 'Permission (switch to auto mode)', value: 'permission_auto_switch' },
            { label: 'Permission (no remember key)', value: 'permission_no_remember' },
            { label: 'Permission (subagent, session-only)', value: 'permission_subagent' },
            { label: 'Permission (outside read, three answers)', value: 'permission_outside_read' },
            { label: 'Permission (outside root)', value: 'permission_outside_root' },
            { label: 'Permission (worktree cleanup)', value: 'permission_worktree_cleanup' },
            { label: 'Permission (reopen compact)', value: 'permission_reopen_compact' },
            { label: 'Permission (artifact publish)', value: 'permission_artifact_publish' },
            { label: 'Permission (defaultToNo)', value: 'permission_default_to_no' },
            { label: 'Admin Approval', value: 'admin_approval' },
            { label: 'Admin Approval (ask rule)', value: 'admin_approval_ask_rule' },
            { label: 'Credential (API key)', value: 'credential' },
            { label: 'Credential (basic auth)', value: 'credential_basic' },
            { label: 'Workflow Launch', value: 'workflow_launch' },
            { label: 'Workflow Launch (no phases)', value: 'workflow_launch_no_phases' },
            { label: 'Ask User (one question)', value: 'ask_user' },
            { label: 'Ask User (two questions)', value: 'ask_user_batched' },
          ],
        },
        defaultValue: 'freeform',
      },
      {
        name: 'disabled',
        description: 'Disable all inputs',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isProcessing',
        description: 'Show processing state (disables send, shows stop)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'restorePromptOnStop',
        description: 'UA1.13 — Stop (button, or Up in the empty composer while processing) puts the stopped prompt back',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'compactMode',
        description: 'Compact mode used by embedded editors/popovers',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'placeholder',
        description: 'Textarea placeholder text',
        control: { type: 'string', placeholder: 'Message...' },
        defaultValue: 'Message Nessy...',
      },
      {
        name: 'currentModel',
        description: 'Current selected model',
        control: {
          type: 'select',
          options: [
            { label: 'Opus 4.8', value: 'claude-opus-4-8' },
            { label: 'Opus 4.7', value: 'claude-opus-4-7' },
            { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
            { label: 'Haiku 3.5', value: 'claude-3-5-haiku-20241022' },
          ],
        },
        defaultValue: 'claude-sonnet-4-6',
      },
      {
        name: 'permissionMode',
        description: 'Permission mode badge',
        control: {
          type: 'select',
          options: [
            { label: 'Plan (read-only)', value: 'plan' },
            { label: 'Manual (prompt)', value: 'default' },
            { label: 'Bypass permissions', value: 'bypassPermissions' },
          ],
        },
        defaultValue: 'default',
      },
      {
        name: 'showOptionBadges',
        description: 'Show the ActiveOptionBadges row above input',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showTasks',
        description: 'Include background tasks in badges row',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showLabels',
        description: 'Include label badges and value editing',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'labelCount',
        description: 'Number of label configs to show',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 3,
      },
      {
        name: 'showStatuses',
        description: "Pass the session's status to the # menu (the status glyph lives in the chat header)",
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'neverPersist',
        description: 'UB14.55 — the session is never written to disk: a fact chip in the row above the card (P6.502)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'sessionAgent',
        description: 'UB14.55 — the agent the session runs as (composerCapabilities.sessionAgent): an @agent chip above the card (P6.940)',
        control: { type: 'string' },
        defaultValue: '',
      },
      {
        name: 'showSources',
        description: 'Enable sources selector badge and source mentions',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'sourceCount',
        description: 'How many sources are available in selector',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 2,
      },
      {
        name: 'showMcpResources',
        description: 'Offer MCP resource rows in the @ mention menu',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showWorkingDirectory',
        description: 'Show working directory context badge',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'workingDirectory',
        description: 'Current working directory',
        control: { type: 'string', placeholder: '/path/to/project' },
        defaultValue: '/Users/demo/projects/nessy-general-agent',
      },
      {
        name: 'seedRecentProjects',
        description: 'Seed recent working directory history in playground local storage',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'recentProjectScenario',
        description: 'Fixture set used for recent working directory history',
        control: {
          type: 'select',
          options: [
            { label: 'Few (3 items)', value: 'few' },
            { label: 'Many (9 items + filter)', value: 'many' },
            { label: 'None (empty)', value: 'none' },
          ],
        },
        defaultValue: 'few',
      },
      {
        name: 'showAttachments',
        description: 'Show preloaded attachment chips above editor',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'attachmentCount',
        description: 'Number of preloaded attachments to preview',
        control: { type: 'number', min: 1, max: 3, step: 1 },
        defaultValue: 2,
      },
      {
        name: 'showFollowUps',
        description: 'Show follow-up annotation chips above editor',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'followUpCount',
        description: 'Number of follow-up chips to preview',
        control: { type: 'number', min: 1, max: 4, step: 1 },
        defaultValue: 2,
      },
      {
        name: 'showQueue',
        description: 'Show queued follow-up rows above editor',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'queuePaused',
        description: 'Show paused queue resume banner',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'contextUsage',
        description: 'UB14.28 — context meter: nothing reported, the quiet ring, the warning chip, a fallback window, or no window',
        control: {
          type: 'select',
          options: [
            { label: 'Nothing reported yet', value: 'none' },
            { label: 'Quiet ring (24%)', value: 'quiet' },
            { label: 'Warning chip (90% of threshold)', value: 'warning' },
            { label: 'Estimated window', value: 'estimatedWindow' },
            { label: 'Unknown window', value: 'unknownWindow' },
          ],
        },
        defaultValue: 'none',
      },
      {
        name: 'queueCapable',
        description: 'UB14.28 — the runtime queues a mid-turn send (Queue) instead of steering it (Steer)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'draft',
        description: 'UB14.28 — text already in the composer (Send ready; with isProcessing, Queue or Steer)',
        control: { type: 'string', placeholder: 'Draft text' },
        defaultValue: '',
      },
      {
        name: 'answerNote',
        description: 'UB14.24 — the runtime carries an answer note: ordinary permission cards offer "Add a note"',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    mockData: () => ({}),
    variants: [
      {
        name: 'Default (Comprehensive)',
        description: 'App-like full setup with badges, labels, statuses, sources, and working directory',
        props: {},
      },
      {
        name: 'Working Dir History (Few)',
        description: 'Recent working directory list with a few entries (remove button testing)',
        props: {
          showWorkingDirectory: true,
          seedRecentProjects: true,
          recentProjectScenario: 'few',
        },
      },
      {
        name: 'Working Dir History (Many + Filter)',
        description: 'Recent working directory list with many entries to trigger filter input path',
        props: {
          showWorkingDirectory: true,
          seedRecentProjects: true,
          recentProjectScenario: 'many',
        },
      },
      {
        name: 'Working Dir History (Empty)',
        description: 'No recent directory history (empty state)',
        props: {
          showWorkingDirectory: true,
          seedRecentProjects: true,
          recentProjectScenario: 'none',
        },
      },
      {
        name: 'Minimal',
        description: 'Input only — no badges, no sources, no cwd badge',
        props: {
          showOptionBadges: false,
          showSources: false,
          showWorkingDirectory: false,
        },
      },
      {
        name: 'Processing + Tasks',
        description: 'Streaming/processing state with background task badges',
        props: {
          isProcessing: true,
          showTasks: true,
          showOptionBadges: true,
        },
      },
      {
        name: 'Safe + Compact',
        description: 'Plan mode style in compact embedding',
        props: {
          permissionMode: 'plan',
          compactMode: true,
          showTasks: false,
        },
      },
      {
        name: 'Compact + Processing (collapsed)',
        description: 'UB14.32 — compact while a turn runs: the draft folds away and the spacer is the tap-to-type target (v0.15.0 material)',
        props: {
          compactMode: true,
          isProcessing: true,
          showTasks: false,
        },
      },
      {
        name: 'Permission Mode UI',
        description: 'Structured permission request replaces freeform input',
        props: {
          inputMode: 'permission',
          showFollowUps: false,
        },
      },
      {
        name: 'Session Facts (never persisted, pinned agent)',
        description: 'UB14.55 — our quiet chip row above the card: never persisted (P6.502) and @agent (P6.940), with labels and a status set — the chat header owns those, so the row draws neither',
        props: {
          neverPersist: true,
          sessionAgent: 'reviewer',
          showLabels: true,
          showStatuses: true,
          showTasks: false,
        },
      },
      {
        name: 'Session Facts + Permission Mode UI',
        description: 'UB14.55 — a decision prompt over the same session: the mode chip joins the facts in the one row above the card',
        props: {
          inputMode: 'permission',
          showFollowUps: false,
          neverPersist: true,
          sessionAgent: 'reviewer',
          showTasks: false,
        },
      },
      {
        name: 'Permission + Impact UI',
        description: 'Permission request whose call escapes the sandbox — impact block above the command',
        props: {
          inputMode: 'permission_impact',
          showFollowUps: false,
        },
      },
      {
        name: 'Permission (risky) UI',
        description: 'UB14.27 — a call carrying a decision-model risk badge: the composer card wears the destructive ring instead of the info ring',
        props: {
          inputMode: 'permission_risky',
          showFollowUps: false,
        },
      },
      ...([
        ['Permission UI (switch to auto mode)', 'permission_auto_switch', 'UB14.24 — P6.208: Allow primary · "Yes, and switch to auto mode" and Always Allow secondary · Deny ghost; the answer note offered', { answerNote: true }],
        ['Permission UI (no remember key)', 'permission_no_remember', 'UB14.24 — UA12.105: no Always Allow, the foot says nothing is remembered (no repeat glyph)', {}],
        ['Permission UI (subagent, session-only)', 'permission_subagent', 'UB14.24 — the subagent that asked leads the details; curl buys a session-only Always Allow (D1.262)', {}],
        ['Permission UI (outside read)', 'permission_outside_read', 'UB14.24 — P6.202 (3): the path in the sunken well, Keep allowing primary · Block from now on and Ask again ghosts', {}],
        ['Permission UI (outside root)', 'permission_outside_root', 'UB14.24 — P6: Allow once primary · Allow for this session secondary · Deny ghost', {}],
        ['Permission UI (worktree cleanup)', 'permission_worktree_cleanup', 'UB14.24 — P6.135: Remove primary · Keep ghost, the impact block above, no Always Allow', {}],
        ['Permission UI (reopen compact)', 'permission_reopen_compact', 'UB14.24 — P6.500/P6.950: Summary primary · As is and Don\'t ask again ghosts', {}],
        ['Permission UI (artifact publish)', 'permission_artifact_publish', 'UB14.24 — UA1.18: the publish details in the card body, Publish primary, no remembering answer', {}],
        ['Permission UI (defaultToNo)', 'permission_default_to_no', 'UB14.24 — F1.1219: Allow drawn secondary, focus opens on Deny', {}],
      ] as const).map(([name, inputMode, description, extra]) => ({
        name,
        description,
        props: { inputMode, showFollowUps: false, ...extra },
      })),
      {
        name: 'Admin Approval UI',
        description: 'Structured admin approval request state',
        props: {
          inputMode: 'admin_approval',
          showFollowUps: false,
        },
      },
      {
        name: 'Admin Approval UI (ask rule)',
        description: 'Admin approval under a readable ask rule — names the rule, no remember switch (F1.885)',
        props: {
          inputMode: 'admin_approval_ask_rule',
          showFollowUps: false,
        },
      },
      {
        name: 'Credential UI',
        description: 'UB14.23 — the credential card on the decision anatomy: info tile, the API-key field with its header name and reveal toggle, Save primary · Cancel ghost, the encrypted-at-rest foot',
        props: {
          inputMode: 'credential',
          showFollowUps: false,
        },
      },
      {
        name: 'Credential UI (basic auth)',
        description: 'UB14.23 — basic auth: username + an optional password, both on the decision anatomy',
        props: {
          inputMode: 'credential_basic',
          showFollowUps: false,
        },
      },
      {
        name: 'Workflow Launch UI',
        description: 'UB14.25 — workflow launch consent on the decision anatomy: Once primary · Always for this project secondary · Deny ghost',
        props: {
          inputMode: 'workflow_launch',
          showFollowUps: false,
        },
      },
      ...([
        ['Workflow Launch UI (no phases)', 'workflow_launch_no_phases', 'UB14.25 — a workflow that declares no phases: the same three answers, Deny still the ghost'],
        ['Ask User UI', 'ask_user', 'UB14.25 — one question: the options as raised answers, the free-text Send primary, Cancel ghost'],
        ['Ask User UI (two questions)', 'ask_user_batched', 'UB14.25 — AskUserQuestion with two questions: header pills, selectable rows, Submit primary (off until an answer), Cancel ghost'],
      ] as const).map(([name, inputMode, description]) => ({
        name,
        description,
        props: { inputMode, showFollowUps: false },
      })),
      {
        name: 'Label-heavy Review',
        description: 'Many labels + status for metadata density checks',
        props: {
          showLabels: true,
          labelCount: 4,
          showStatuses: true,
          showTasks: false,
        },
      },
      {
        name: 'Source-heavy Review',
        description: 'Multiple source avatars and source selector stress test',
        props: {
          showSources: true,
          sourceCount: 4,
          showWorkingDirectory: false,
        },
      },
      {
        name: 'MCP Resource Mentions',
        description: 'Type @ — MCP resource rows sit alongside files in the mention menu',
        props: {
          showMcpResources: true,
          showSources: true,
          sourceCount: 3,
        },
      },
      {
        name: 'No MCP Resources',
        description: 'Same menu with no resource-advertising server connected',
        props: {
          showMcpResources: false,
        },
      },
      {
        name: 'Follow-up Review',
        description: 'Follow-up annotation chips visible in input',
        props: {
          showFollowUps: true,
          followUpCount: 3,
        },
      },
      {
        name: 'Attachments + Follow-ups',
        description: 'Preloaded attachments with follow-up annotation chips visible together',
        props: {
          showAttachments: true,
          attachmentCount: 2,
          showFollowUps: true,
          followUpCount: 3,
        },
      },
      {
        name: 'Queued Follow-ups',
        description: 'Queued follow-up rows with inline actions',
        props: {
          showQueue: true,
        },
      },
      {
        name: 'Paused Queue',
        description: 'Queued follow-up rows with paused resume banner',
        props: {
          showQueue: true,
          queuePaused: true,
        },
      },
      {
        name: 'Draft ready (Send)',
        description: 'UB14.28 — a draft and no turn: the round accent Send (data-state ready)',
        props: {
          draft: PLAYGROUND_DRAFT,
        },
      },
      {
        name: 'Processing + draft (Steer)',
        description: 'UB14.28 — a turn runs and a draft waits on a steer runtime: the accent control says Steer',
        props: {
          isProcessing: true,
          draft: PLAYGROUND_DRAFT,
          queueCapable: false,
        },
      },
      {
        name: 'Processing + draft (Queue)',
        description: 'UB14.28 — the same on a queue runtime: the control says Queue',
        props: {
          isProcessing: true,
          draft: PLAYGROUND_DRAFT,
          queueCapable: true,
        },
      },
      {
        name: 'Context meter (quiet)',
        description: 'UB14.28 — the always-on quiet ring below the warning (our meter; upstream draws nothing here)',
        props: {
          contextUsage: 'quiet',
        },
      },
      {
        name: 'Context meter (warning)',
        description: 'UB14.28 — v0.15.1\'s info-tint chip, ring + percent; a press sends /compact',
        props: {
          contextUsage: 'warning',
        },
      },
      {
        name: 'Context meter (warning, turn running)',
        description: 'UB14.28 — the warning chip disabled (not hidden) while a turn runs; Stop beside it',
        props: {
          contextUsage: 'warning',
          isProcessing: true,
        },
      },
      {
        name: 'Context window unknown',
        description: 'UB14.28 — an occupancy with no window: the broken ring with a ?, never an empty ring',
        props: {
          contextUsage: 'unknownWindow',
          currentModel: PLAYGROUND_UNLISTED_MODEL,
        },
      },
      {
        name: 'Disabled',
        description: 'Fully disabled state',
        props: {
          disabled: true,
        },
      },
    ],
  },
]
