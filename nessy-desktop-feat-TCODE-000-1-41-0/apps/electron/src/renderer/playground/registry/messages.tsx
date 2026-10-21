import * as React from 'react'
import type { ComponentEntry } from './types'
import {
  TurnCard,
  type ActivityItem,
  type ResponseContent,
  Markdown,
  CollapsibleMarkdownProvider,
  Spinner,
  UserMessageBubble,
  SystemMessage,
} from '@nessy-agent/ui'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AuthRequestCard } from '@/components/chat/AuthRequestCard'
import type { Message } from '../../../shared/types'
import type { SessionAttachmentDto } from '@nessy-agent/core'
import { MessageBubble } from '@/components/app-shell/chat-display/MessageBubble'
import { ProcessingIndicator } from '@/components/app-shell/chat-display/ProcessingIndicator'
import { TurnFrame } from '@/components/app-shell/chat-display/TurnFrame'
import {
  CompactEmptyState,
  EarlierMessagesHint,
  NewChatEmptyState,
  NoRenderableMessages,
  TranscriptLoadError,
  TranscriptSkeleton,
} from '@/components/app-shell/chat-display/TranscriptStates'

/** UB14.13: a user-bubble image attachment; the host's `previewUrl` is a data URL (message-mapper.ts). */
const PLAYGROUND_IMAGE_ATTACHMENT: SessionAttachmentDto = {
  handleId: 'playground-image-1',
  type: 'image',
  name: 'layout.png',
  mimeType: 'image/png',
  size: 48_213,
  previewUrl:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="#3b4252"/><rect x="8" y="10" width="40" height="8" rx="2" fill="#88c0d0"/><rect x="8" y="24" width="26" height="22" rx="2" fill="#a3be8c"/><rect x="38" y="24" width="10" height="22" rx="2" fill="#ebcb8b"/></svg>',
    ),
}

/** UB14.13: a user-bubble document attachment with no preview (the file-type glyph). */
const PLAYGROUND_DOCUMENT_ATTACHMENT: SessionAttachmentDto = {
  handleId: 'playground-document-1',
  type: 'pdf',
  name: 'quarterly-report.pdf',
  mimeType: 'application/pdf',
  size: 312_004,
}

// ============================================================================
// Message Components - Demo components for playground preview
// Uses shared components from @nessy-agent/ui where available
// ============================================================================

/** Assistant message bubble - left aligned white card (playground demo version) */
function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-start group">
      <div className="relative max-w-[80%] bg-white shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0">
        <button
          className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/5"
          title="Open in new window"
        >
          <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-foreground" />
        </button>
        <CollapsibleMarkdownProvider>
          <Markdown
            mode="minimal"
            className="text-sm"
            collapsible
          >
            {content}
          </Markdown>
        </CollapsibleMarkdownProvider>
      </div>
    </div>
  )
}

/** Status message - spinner with text, used during compaction etc (playground demo) */
function StatusMessage({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[13px] text-muted-foreground">
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      <span>{content}</span>
    </div>
  )
}

/** Compaction divider - horizontal rule with centered label shown after context compaction (playground demo) */
function CompactionDivider({ label = 'Conversation Compacted' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 my-12 px-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-sm text-muted-foreground/70 select-none">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

/**
 * UB14.15 — the SHIPPED live line (`chat-display/ProcessingIndicator`, v0.15.1 + our P6.274/P6.916
 * retry arm and P6.424 tip), mounted instead of the hand-copied mirror this entry used to draw.
 * `startTime` is minted once per mount so the elapsed counter ticks from the knob's offset.
 */
type LiveLineState = 'cycling' | 'status' | 'retrying' | 'retryingNow' | 'tip' | 'longLabel'

const LIVE_LINE_RETRY_FACTS = { kind: 'rate_limit', attempt: 2, maxAttempts: 5, delaySeconds: 30 } as const

function LiveLinePreview({ state = 'cycling', elapsed = 0 }: { state?: LiveLineState; elapsed?: number }) {
  const startTime = React.useMemo(() => Date.now() - elapsed * 1000, [elapsed])
  const props: React.ComponentProps<typeof ProcessingIndicator> = { startTime }
  if (state === 'status') props.statusMessage = 'Compacting conversation…'
  if (state === 'retrying') Object.assign(props, { statusMessage: 'Rate limited by the provider', statusType: 'retrying', retry: LIVE_LINE_RETRY_FACTS })
  if (state === 'retryingNow') Object.assign(props, { statusMessage: 'Provider error (fetch failed) — retry 1/5 in 0s', statusType: 'retrying' })
  if (state === 'tip') props.suggestion = { topic: 'Terraform modules with remote state', reference: 'terraform@nessy-plugins' }
  if (state === 'longLabel') props.statusMessage = 'Waiting for the provider to accept the request while the previous turn finishes writing its files to the workspace'
  return (
    <div className="w-[520px] max-w-full">
      <ProcessingIndicator {...props} />
    </div>
  )
}

// ============================================================================
// Message Gallery - All message types in one scrollable view
// ============================================================================

function MessageGallery() {
  const now = Date.now()

  // Sample tool activities for TurnCard
  const completedGrepActivity: ActivityItem = {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolInput: { pattern: 'AuthHandler', path: 'src/' },
    intent: 'Searching for authentication handlers',
    timestamp: now - 5000,
  }

  const completedReadActivity: ActivityItem = {
    id: 'tool-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolInput: { file_path: '/src/auth/index.ts' },
    timestamp: now - 4000,
  }

  const runningGrepActivity: ActivityItem = {
    id: 'tool-running-1',
    type: 'tool',
    status: 'running',
    toolName: 'Grep',
    toolInput: { pattern: 'handleError', path: 'src/' },
    intent: 'Finding error handling patterns',
    timestamp: now - 1000,
  }

  const shortResponse: ResponseContent = {
    text: "I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation.",
    isStreaming: false,
  }

  const streamingResponse: ResponseContent = {
    text: "I'm analyzing the codebase and looking for patterns that match your query. Let me check a few more files...",
    isStreaming: true,
    streamStartTime: now - 500,
  }

  return (
    <div className="max-w-[960px] mx-auto p-8 space-y-8">
      {/* Section: Status & Dividers (playground demo components) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Status & Dividers</h2>
        <div className="bg-muted/20 rounded-lg">
          <StatusMessage content="Compacting conversation..." />
          <CompactionDivider />
          <StatusMessage content="Connecting to server..." />
        </div>
      </section>

      {/* Section: Processing States */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Processing States</h2>
        <div className="bg-muted/20 rounded-lg ">
          <LiveLinePreview />
        </div>
      </section>

      {/* Section: User Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">User Messages</h2>
        <div className="space-y-3">
          <UserMessageBubble content="How do I authenticate with the API?" />
          <UserMessageBubble content="Can you search for all files that contain 'handleError' and show me how they work?" />
        </div>
      </section>

      {/* Section: Assistant Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Assistant Messages</h2>
        <div className="space-y-3">
          <AssistantMessage content="I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation." />
          <AssistantMessage content={`Here's a more detailed response with **markdown** formatting:

1. First, check the \`config.ts\` file
2. Then update the environment variables
3. Finally, restart the server

\`\`\`typescript
const config = {
  apiKey: process.env.API_KEY,
  secret: process.env.SECRET
};
\`\`\`
`} />
        </div>
      </section>

      {/* Section: SystemMessage (from @nessy-agent/ui) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">SystemMessage (Shared)</h2>
        <div className="bg-muted/20 rounded-lg">
          <SystemMessage content="This is a system message." type="system" />
          <SystemMessage content="This is an info message." type="info" />
          <SystemMessage content="This is a warning message." type="warning" />
          <SystemMessage content="This is an error message." type="error" />
        </div>
      </section>

      {/* Section: TurnCard - Complete Turn */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Complete Turn</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-1"
          activities={[completedGrepActivity, completedReadActivity]}
          response={shortResponse}
          intent="Analyzing authentication system"
          isStreaming={false}
          isComplete={true}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Streaming */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Streaming Response</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-2"
          activities={[completedGrepActivity]}
          response={streamingResponse}
          isStreaming={true}
          isComplete={false}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Tool Running */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Tool Running</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-3"
          activities={[runningGrepActivity]}
          response={undefined}
          intent="Finding error handling patterns"
          isStreaming={true}
          isComplete={false}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Response Only */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Response Only (No Tools)</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-4"
          activities={[]}
          response={shortResponse}
          isStreaming={false}
          isComplete={true}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: Auth Request Cards */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Auth Request Cards</h2>
        <div className="space-y-4">
          {/* Credential - Pending */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Credential Request (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'credential',
                status: 'pending',
                sourceSlug: 'github',
                sourceName: 'GitHub',
                mode: 'bearer',
                description: 'Enter your GitHub personal access token to connect.',
                hint: 'Generate a token at https://github.com/settings/tokens',
              })}
              onRespondToCredential={(sessionId, requestId, response) =>
                console.log('Credential response:', { sessionId, requestId, response })
              }
            />
          </div>

          {/* Credential - Basic Auth */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Basic Auth (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'credential',
                status: 'pending',
                sourceSlug: 'jira',
                sourceName: 'Jira',
                mode: 'basic',
                labels: { username: 'Email', password: 'API Token' },
                description: 'Connect to your Atlassian account.',
              })}
              onRespondToCredential={(sessionId, requestId, response) =>
                console.log('Credential response:', { sessionId, requestId, response })
              }
            />
          </div>

          {/* OAuth - Pending */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">OAuth Request (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth',
                status: 'pending',
                sourceSlug: 'linear',
                sourceName: 'Linear',
              })}
            />
          </div>

          {/* Google OAuth - Pending */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Google OAuth (pending)</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth-google',
                status: 'pending',
                sourceSlug: 'gmail',
                sourceName: 'Gmail',
              })}
            />
          </div>

          {/* Completed */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Auth Completed</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth-google',
                status: 'completed',
                sourceSlug: 'gmail',
                sourceName: 'Gmail',
                email: 'user@example.com',
              })}
            />
          </div>

          {/* Cancelled */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Auth Cancelled</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'oauth',
                status: 'cancelled',
                sourceSlug: 'linear',
                sourceName: 'Linear',
              })}
            />
          </div>

          {/* Failed */}
          <div>
            <h3 className="text-sm font-medium mb-2 text-muted-foreground">Auth Failed</h3>
            <AuthRequestCard
              sessionId="playground-session"
              message={createAuthMessage({
                type: 'credential',
                status: 'failed',
                sourceSlug: 'sentry',
                sourceName: 'Sentry',
                error: 'Invalid API key. Please check and try again.',
              })}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

/** Helper to create auth message for playground */
function createAuthMessage(opts: {
  type: 'credential' | 'oauth' | 'oauth-google' | 'dp'
  status: 'pending' | 'completed' | 'cancelled' | 'failed'
  sourceSlug: string
  sourceName: string
  mode?: 'bearer' | 'basic' | 'header' | 'query'
  labels?: { credential?: string; username?: string; password?: string }
  description?: string
  hint?: string
  error?: string
  email?: string
  workspace?: string
}): Message {
  return {
    id: `auth-${opts.sourceSlug}-${Date.now()}`,
    role: 'auth-request',
    content: `Authentication required for ${opts.sourceName}`,
    timestamp: Date.now(),
    authRequestId: `req-${opts.sourceSlug}`,
    authRequestType: opts.type,
    authSourceSlug: opts.sourceSlug,
    authSourceName: opts.sourceName,
    authStatus: opts.status,
    authCredentialMode: opts.mode,
    authLabels: opts.labels,
    authDescription: opts.description,
    authHint: opts.hint,
    authError: opts.error,
    authEmail: opts.email,
    authWorkspace: opts.workspace,
  }
}

// ============================================================================
// UB14.14 — the REAL transcript message renderer and transcript states
// (v0.15.1 chat-display/*), one entry each, every state the row touches.
// ============================================================================

const TRANSCRIPT_NOOP = () => {}

/** The sample `Message` for each transcript state (ids are stable so the memo boundary is honest). */
const TRANSCRIPT_MESSAGES: Record<string, Message> = {
  assistant: {
    id: 'pg-assistant', role: 'assistant', timestamp: 0,
    content: 'The handler lives in `src/auth/index.ts`. It refreshes the token **before** the request:\n\n```ts\nawait refreshIfStale(session)\n```',
  },
  status: { id: 'pg-status', role: 'status', timestamp: 0, content: 'Compacting conversation...' },
  info: { id: 'pg-info', role: 'info', timestamp: 0, content: 'Plan approved.', infoLevel: 'success' },
  infoList: {
    id: 'pg-info-list', role: 'info', timestamp: 0, infoLevel: 'info',
    content: '/help — this list\n/mcp — the MCP servers this session can reach\n/diff — what is uncommitted in the working tree',
  },
  compaction: { id: 'pg-compaction', role: 'info', timestamp: 0, content: '', statusType: 'compaction_complete' },
  runtimeSwitch: { id: 'pg-switch', role: 'info', timestamp: 0, content: 'runtime_switched:pi:anthropic:{"carry":"native"}' },
  runtimeSwitchText: { id: 'pg-switch-text', role: 'info', timestamp: 0, content: 'runtime_switched:anthropic:codex-runtime:{"carry":"text"}' },
  terminalReason: { id: 'pg-terminal', role: 'info', timestamp: 0, content: 'terminal_reason:max_agent_turns', infoLevel: 'warning' },
  warning: { id: 'pg-warning', role: 'warning', timestamp: 0, content: '2 attachment(s) could not be stored and will not be sent: layout.png, notes.md' },
  error: {
    id: 'pg-error', role: 'error', timestamp: 0,
    errorTitle: 'Rate limited',
    content: 'Rate limited: the gateway refused the request. Try again in a minute.',
    errorActions: [
      { key: 'retry', label: 'Retry', action: 'retry' },
      { key: 'docs', label: 'Open status page', action: 'open_url', url: 'https://example.invalid/status' },
    ],
    errorDetails: ['status: 429', 'request: req_0123'],
    errorOriginal: '{"error":{"type":"rate_limit_error"}}',
  },
  errorCredential: {
    id: 'pg-error-credential', role: 'error', timestamp: 0,
    errorCode: 'invalid_api_key',
    errorTitle: 'Authentication failed',
    content: 'Authentication failed: the API key for this connection was rejected.',
    errorActions: [
      { key: 'settings', label: 'Settings', action: 'settings' },
      { key: 'retry', label: 'Retry', action: 'retry' },
    ],
  },
  taskNotification: {
    id: 'pg-task-notification', role: 'user', timestamp: 0, taskNotification: true,
    content: '<task-notification>\nBackground subagent task t-1 finished (completed).\nAll three checks passed.\n</task-notification>',
  },
}

/** One transcript row through the shipped `MessageBubble` — never a copy of its markup. */
function TranscriptMessagePreview({ kind = 'assistant' }: { kind?: string }) {
  const message = TRANSCRIPT_MESSAGES[kind] ?? TRANSCRIPT_MESSAGES.assistant!
  return (
    <div className="w-[640px] flex flex-col gap-5">
      <MessageBubble
        message={message}
        onOpenFile={TRANSCRIPT_NOOP}
        onOpenUrl={TRANSCRIPT_NOOP}
        sessionId="playground-session"
        onPopOut={message.role === 'assistant' ? TRANSCRIPT_NOOP : undefined}
        onRetry={message.role === 'error' ? TRANSCRIPT_NOOP : undefined}
      />
    </div>
  )
}

const TRANSCRIPT_MESSAGE_KINDS: Array<[string, string]> = [
  ['assistant', 'Assistant (plain copy)'],
  ['status', 'Status line'],
  ['info', 'Info (success)'],
  ['infoList', 'Info (a multi-line seam answer)'],
  ['compaction', 'Compaction divider'],
  ['runtimeSwitch', 'Runtime switch (native carry)'],
  ['runtimeSwitchText', 'Runtime switch (text carry)'],
  ['terminalReason', 'Terminal reason'],
  ['warning', 'Warning marker'],
  ['error', 'Error marker (actions, details)'],
  ['errorCredential', 'Error marker (credential sign-in)'],
  ['taskNotification', 'Task notification line'],
]

/** Every transcript placeholder state, in a transcript-sized frame (the empty states are absolutely placed). */
function TranscriptStatePreview({ state = 'skeleton', label }: { state?: string; label?: string }) {
  return (
    <div className="relative w-[640px] min-h-[320px]">
      {state === 'skeleton' && <TranscriptSkeleton />}
      {state === 'loadError' && <TranscriptLoadError error="session.jsonl could not be read (EACCES)" onRetry={TRANSCRIPT_NOOP} />}
      {state === 'loadErrorRetrying' && <TranscriptLoadError error="session.jsonl could not be read (EACCES)" onRetry={TRANSCRIPT_NOOP} isRetrying />}
      {state === 'noRenderable' && <NoRenderableMessages />}
      {state === 'compactEmpty' && <CompactEmptyState label={label} />}
      {state === 'newChat' && <NewChatEmptyState />}
      {state === 'newChatCompact' && <NewChatEmptyState compact />}
      {state === 'earlier' && <EarlierMessagesHint count={42} />}
    </div>
  )
}

/** UB14.15: a user turn and an answer, each framed the way ChatDisplay frames every turn. */
function TurnFramePreview({ match = 'current' }: { match?: 'none' | 'any' | 'current' }) {
  const register = React.useCallback(() => {}, [])
  return (
    <div className="flex w-[640px] flex-col gap-5 bg-paper px-6 py-8">
      <TurnFrame turnKey="user-1" registerRef={register} isCurrentMatch={false} isAnyMatch={match !== 'none'}>
        <UserMessageBubble content="Where is the retry ladder configured?" />
      </TurnFrame>
      <TurnFrame turnKey="turn-1" registerRef={register} isCurrentMatch={match === 'current'} isAnyMatch={match !== 'none'}>
        <p className="text-copy text-foreground">The retry ladder lives in the gateway adapter: 15, 30, 60, 60 and 60 seconds.</p>
      </TurnFrame>
    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const messagesComponents: ComponentEntry[] = [
  {
    id: 'message-gallery',
    name: 'Message Gallery',
    category: 'Chat Messages',
    description: 'All message types displayed together for easy design comparison',
    component: MessageGallery,
    layout: 'top',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
  {
    id: 'user-message-bubble',
    name: 'UserMessageBubble',
    category: 'Chat Messages',
    description: 'Right-aligned user message bubble (from @nessy-agent/ui)',
    component: UserMessageBubble,
    props: [
      {
        name: 'content',
        description: 'Message text content',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 2 },
        defaultValue: 'How do I authenticate with the API?',
      },
    ],
    variants: [
      { name: 'Short', props: { content: 'Hello!' } },
      { name: 'Medium', props: { content: 'How do I authenticate with the API?' } },
      { name: 'Long', props: { content: 'Can you search for all files that contain "handleError" and show me how they work? I need to understand the error handling patterns in this codebase.' } },
      // UB14.13 (R3-07): the v0.15.1 bubble's attachment, compact and queued states. Attachments
      // are `SessionAttachmentDto`s — the image draws the host's `previewUrl` as given, the
      // placeholder state has none.
      { name: 'Image attachment', props: { content: 'What is wrong with this layout?', attachments: [PLAYGROUND_IMAGE_ATTACHMENT] } },
      { name: 'Image without preview', props: { content: 'And this one?', attachments: [{ ...PLAYGROUND_IMAGE_ATTACHMENT, handleId: 'playground-image-2', previewUrl: undefined }] } },
      { name: 'Document attachment', props: { content: 'Summarise the report.', attachments: [PLAYGROUND_DOCUMENT_ATTACHMENT] } },
      { name: 'Compact', props: { content: 'How do I authenticate with the API?', compactMode: true } },
      { name: 'Queued', props: { content: 'Also run the tests afterwards.', isQueued: true } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'assistant-message',
    name: 'AssistantMessage',
    category: 'Chat Messages',
    description: 'Left-aligned assistant response with markdown support',
    component: AssistantMessage,
    props: [
      {
        name: 'content',
        description: 'Message text content (supports markdown)',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 4 },
        defaultValue: 'I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows.',
      },
    ],
    variants: [
      { name: 'Short', props: { content: 'The file is located at `src/config.ts`.' } },
      { name: 'With Code', props: { content: 'Here\'s the code:\n\n```typescript\nconst x = 1;\n```' } },
      { name: 'With List', props: { content: '**Steps:**\n1. First step\n2. Second step\n3. Third step' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'status-message',
    name: 'StatusMessage',
    category: 'Chat Messages',
    description: 'System status with spinner (compaction, connecting, etc)',
    component: StatusMessage,
    props: [
      {
        name: 'content',
        description: 'Status message text',
        control: { type: 'string', placeholder: 'Status message...' },
        defaultValue: 'Compacting conversation...',
      },
    ],
    variants: [
      { name: 'Compacting', props: { content: 'Compacting conversation...' } },
      { name: 'Compacted', props: { content: 'Compacted conversation (was 180000 tokens)' } },
      { name: 'Connecting', props: { content: 'Connecting to server...' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'system-message',
    name: 'SystemMessage',
    category: 'Chat Messages',
    description: 'System/info/warning/error message (from @nessy-agent/ui)',
    component: SystemMessage,
    props: [
      {
        name: 'content',
        description: 'Message text content',
        control: { type: 'textarea', placeholder: 'Message content...', rows: 2 },
        defaultValue: 'This is a system message.',
      },
      {
        name: 'type',
        description: 'Message type determining visual style',
        control: {
          type: 'select',
          options: [
            { label: 'System', value: 'system' },
            { label: 'Info', value: 'info' },
            { label: 'Warning', value: 'warning' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'system',
      },
    ],
    variants: [
      { name: 'System', props: { content: 'Session restored from 5 minutes ago.', type: 'system' } },
      { name: 'Info', props: { content: 'Agent activated successfully.', type: 'info' } },
      { name: 'Warning', props: { content: 'Rate limit approaching.', type: 'warning' } },
      { name: 'Error', props: { content: 'Connection lost.', type: 'error' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'compaction-divider',
    name: 'CompactionDivider',
    category: 'Chat Messages',
    description: 'Horizontal rule with centered label shown after context compaction',
    component: CompactionDivider,
    props: [
      {
        name: 'label',
        description: 'Label text shown in the center',
        control: { type: 'string', placeholder: 'Label...' },
        defaultValue: 'Conversation Compacted',
      },
    ],
    variants: [
      { name: 'Default', props: { label: 'Conversation Compacted' } },
      { name: 'Custom Label', props: { label: 'Context Reset' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'processing-indicator',
    name: 'ProcessingIndicator',
    category: 'Chat Messages',
    description:
      'UB14.15: the shipped live line (v0.15.1 chat-display/ProcessingIndicator) — a 28px row with the accent spinner on the work log column, the label in secondary and the elapsed time in tertiary; ours: the P6.274/P6.916 retry line assembled from the producer\'s facts with a ticking countdown, and the P6.424 plugin tip under the label.',
    component: LiveLinePreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which status the line shows',
        control: {
          type: 'select',
          options: [
            { label: 'Cycling label', value: 'cycling' },
            { label: 'Status (compacting)', value: 'status' },
            { label: 'Retrying (facts, countdown)', value: 'retrying' },
            { label: 'Retrying now (parsed line)', value: 'retryingNow' },
            { label: 'Plugin tip (P6.424)', value: 'tip' },
            { label: 'Long label (truncates)', value: 'longLabel' },
          ],
        },
        defaultValue: 'cycling',
      },
      {
        name: 'elapsed',
        description: 'Seconds already elapsed when the line mounts',
        control: { type: 'number', min: 0, max: 600, step: 5 },
        defaultValue: 0,
      },
    ],
    variants: [
      { name: 'Cycling label', props: { state: 'cycling', elapsed: 0 } },
      { name: 'Cycling at 1:05', props: { state: 'cycling', elapsed: 65 } },
      { name: 'Status (compacting)', props: { state: 'status', elapsed: 12 } },
      { name: 'Retrying (facts, countdown)', props: { state: 'retrying', elapsed: 40 } },
      { name: 'Retrying now (parsed line)', props: { state: 'retryingNow', elapsed: 90 } },
      { name: 'Plugin tip (P6.424)', props: { state: 'tip', elapsed: 8 } },
      { name: 'Long label (truncates)', props: { state: 'longLabel', elapsed: 3 } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'auth-request-card',
    name: 'AuthRequestCard',
    category: 'Chat Messages',
    description: 'Inline authentication request card for credentials, OAuth or the Developer Platform sign-in, on the decision material (UB14.26)',
    component: ({ authType, authStatus, sourceName, mode, description, hint, error, email, workspace, attempt, interactive }) => (
      <div className="w-[80%]">
        <AuthRequestCard
          sessionId="playground-session"
          message={createAuthMessage({
            type: authType,
            status: authStatus,
            sourceSlug: sourceName.toLowerCase().replace(/\s+/g, '-'),
            sourceName,
            mode,
            description,
            hint,
            error,
            email,
            workspace,
          })}
          isInteractive={interactive}
          // The in-flight attempt is the card's local state; the playground mounts it directly (UB14.26).
          initialAttempt={attempt === 'in-browser'
            ? authType === 'dp'
              ? { submitting: true, dpStatus: 'waiting-browser', dpAuthUrl: 'https://auth.example.invalid/oauth2/auth?state=playground' }
              : { submitting: true }
            : undefined}
          onRespondToCredential={(sessionId, requestId, response) =>
            console.log('Credential response:', { sessionId, requestId, response })
          }
        />
      </div>
    ),
    props: [
      {
        name: 'authType',
        description: 'Type of authentication',
        control: {
          type: 'select',
          options: [
            { label: 'Credential', value: 'credential' },
            { label: 'OAuth', value: 'oauth' },
            { label: 'Google OAuth', value: 'oauth-google' },
            { label: 'Developer Platform', value: 'dp' },
          ],
        },
        defaultValue: 'credential',
      },
      {
        name: 'attempt',
        description: 'The sign-in attempt the card mounts in (OAuth or Developer Platform, pending only)',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Waiting for the browser', value: 'in-browser' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'interactive',
        description: 'The latest message (off: the compact outcome after the next message)',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'authStatus',
        description: 'Current status of the auth request',
        control: {
          type: 'select',
          options: [
            { label: 'Pending', value: 'pending' },
            { label: 'Completed', value: 'completed' },
            { label: 'Cancelled', value: 'cancelled' },
            { label: 'Failed', value: 'failed' },
          ],
        },
        defaultValue: 'pending',
      },
      {
        name: 'sourceName',
        description: 'Name of the source',
        control: { type: 'string', placeholder: 'Source name...' },
        defaultValue: 'GitHub',
      },
      {
        name: 'mode',
        description: 'Credential mode (only for credential type)',
        control: {
          type: 'select',
          options: [
            { label: 'Bearer Token', value: 'bearer' },
            { label: 'Basic Auth', value: 'basic' },
            { label: 'Header', value: 'header' },
            { label: 'Query Param', value: 'query' },
          ],
        },
        defaultValue: 'bearer',
      },
      {
        name: 'description',
        description: 'Description shown to user',
        control: { type: 'string', placeholder: 'Description...' },
        defaultValue: 'Enter your personal access token to connect.',
      },
      {
        name: 'hint',
        description: 'Hint about where to find credentials',
        control: { type: 'string', placeholder: 'Hint...' },
        defaultValue: '',
      },
      {
        name: 'error',
        description: 'Error message (for failed status)',
        control: { type: 'string', placeholder: 'Error message...' },
        defaultValue: '',
      },
      {
        name: 'email',
        description: 'Email (for completed OAuth)',
        control: { type: 'string', placeholder: 'Email...' },
        defaultValue: '',
      },
      {
        name: 'workspace',
        description: 'Workspace (for completed OAuth)',
        control: { type: 'string', placeholder: 'Workspace...' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Credential Pending',
        props: {
          authType: 'credential',
          authStatus: 'pending',
          sourceName: 'GitHub',
          mode: 'bearer',
          description: 'Enter your personal access token to connect.',
          hint: 'Generate at https://github.com/settings/tokens',
        },
      },
      {
        name: 'Basic Auth',
        props: {
          authType: 'credential',
          authStatus: 'pending',
          sourceName: 'Jira',
          mode: 'basic',
          description: 'Connect to your Atlassian account.',
        },
      },
      {
        name: 'OAuth Pending',
        props: {
          authType: 'oauth',
          authStatus: 'pending',
          sourceName: 'Linear',
        },
      },
      {
        name: 'Google OAuth',
        props: {
          authType: 'oauth-google',
          authStatus: 'pending',
          sourceName: 'Gmail',
        },
      },
      {
        name: 'Completed',
        props: {
          authType: 'oauth-google',
          authStatus: 'completed',
          sourceName: 'Gmail',
          email: 'user@example.com',
        },
      },
      {
        name: 'Cancelled',
        props: {
          authType: 'oauth',
          authStatus: 'cancelled',
          sourceName: 'Linear',
        },
      },
      {
        name: 'Failed',
        props: {
          authType: 'credential',
          authStatus: 'failed',
          sourceName: 'Sentry',
          error: 'Invalid API key. Please check and try again.',
        },
      },
      {
        name: 'OAuth Waiting Browser',
        props: {
          authType: 'oauth',
          authStatus: 'pending',
          sourceName: 'Linear',
          attempt: 'in-browser',
        },
      },
      {
        name: 'Completed (workspace)',
        props: {
          authType: 'oauth',
          authStatus: 'completed',
          sourceName: 'Linear',
          email: 'user@example.com',
          workspace: 'Platform Team',
        },
      },
      {
        name: 'Completed (compact)',
        props: {
          authType: 'oauth-google',
          authStatus: 'completed',
          sourceName: 'Gmail',
          email: 'user@example.com',
          interactive: false,
        },
      },
      {
        name: 'Developer Platform Pending',
        props: {
          authType: 'dp',
          authStatus: 'pending',
          sourceName: 'Developer Platform',
          description: '',
        },
      },
      {
        name: 'Developer Platform Waiting Browser',
        props: {
          authType: 'dp',
          authStatus: 'pending',
          sourceName: 'Developer Platform',
          description: '',
          attempt: 'in-browser',
        },
      },
      {
        name: 'Developer Platform Connected',
        props: {
          authType: 'dp',
          authStatus: 'completed',
          sourceName: 'Developer Platform',
          description: '',
        },
      },
      {
        name: 'Developer Platform Failed',
        props: {
          authType: 'dp',
          authStatus: 'failed',
          sourceName: 'Developer Platform',
          description: '',
          error: 'ExecFailed',
        },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'chat-display-message-bubble',
    name: 'MessageBubble (transcript)',
    category: 'Chat Messages',
    description:
      'UB14.14: the shipped transcript row (v0.15.1 chat-display/MessageBubble + ErrorMessage) — assistant copy, status line, info notices, the compaction and runtime-switch dividers, the terminal-reason notice, the warning and error markers (credential sign-in first), and the task-notification line.',
    component: TranscriptMessagePreview,
    layout: 'top',
    props: [
      {
        name: 'kind',
        description: 'Which transcript message to render',
        control: { type: 'select', options: TRANSCRIPT_MESSAGE_KINDS.map(([value, label]) => ({ label, value })) },
        defaultValue: 'assistant',
      },
    ],
    variants: TRANSCRIPT_MESSAGE_KINDS.map(([kind, name]) => ({ name, props: { kind } })),
    mockData: () => ({}),
  },
  {
    id: 'chat-display-transcript-states',
    name: 'Transcript states',
    category: 'Chat Messages',
    description:
      'UB14.14: v0.15.1 chat-display/TranscriptStates — the loading skeleton, the load failure with Retry, no renderable messages, the compact empty state (with our D1.382 label), the new-chat display moment and the earlier-messages hint.',
    component: TranscriptStatePreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which transcript state to render',
        control: {
          type: 'select',
          options: [
            { label: 'Skeleton', value: 'skeleton' },
            { label: 'Load error', value: 'loadError' },
            { label: 'Load error (retrying)', value: 'loadErrorRetrying' },
            { label: 'No renderable messages', value: 'noRenderable' },
            { label: 'Compact empty', value: 'compactEmpty' },
            { label: 'New chat', value: 'newChat' },
            { label: 'New chat (compact page, UB14.15)', value: 'newChatCompact' },
            { label: 'Earlier messages hint', value: 'earlier' },
          ],
        },
        defaultValue: 'skeleton',
      },
      {
        name: 'label',
        description: 'D1.382: a caller-owned compact empty-state sentence (replaces both lines)',
        control: { type: 'string', placeholder: 'Empty-state sentence…' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'Skeleton', props: { state: 'skeleton' } },
      { name: 'Load error', props: { state: 'loadError' } },
      { name: 'Load error (retrying)', props: { state: 'loadErrorRetrying' } },
      { name: 'No renderable messages', props: { state: 'noRenderable' } },
      { name: 'Compact empty (edit popover)', props: { state: 'compactEmpty', label: '' } },
      { name: 'Compact empty (own label, D1.382)', props: { state: 'compactEmpty', label: 'Ask a side question — the main chat keeps going.' } },
      { name: 'New chat', props: { state: 'newChat' } },
      { name: 'New chat (compact page, UB14.15)', props: { state: 'newChatCompact' } },
      { name: 'Earlier messages hint', props: { state: 'earlier' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'chat-display-turn-frame',
    name: 'TurnFrame (search ring)',
    category: 'Chat Messages',
    description:
      'UB14.15: v0.15.1 chat-display/TurnFrame — every transcript turn registers for in-session search and draws the match ring 8px outside the turn on the paper ground: the current match solid, other matches faint, no ring otherwise.',
    component: TurnFramePreview,
    layout: 'top',
    props: [
      {
        name: 'match',
        description: 'Search state of the framed turn',
        control: {
          type: 'select',
          options: [
            { label: 'No match', value: 'none' },
            { label: 'Other match', value: 'any' },
            { label: 'Current match', value: 'current' },
          ],
        },
        defaultValue: 'current',
      },
    ],
    variants: [
      { name: 'No match', props: { match: 'none' } },
      { name: 'Other match (faint)', props: { match: 'any' } },
      { name: 'Current match (solid)', props: { match: 'current' } },
    ],
    mockData: () => ({}),
  },
]
