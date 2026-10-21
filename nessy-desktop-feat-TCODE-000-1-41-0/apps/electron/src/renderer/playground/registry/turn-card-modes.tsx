import type { ComponentEntry } from './types'
import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import {
  TRANSCRIPT_VERBOSITY_MODES,
  TurnCard,
  UserMessageBubble,
  type ActivityItem,
  type ResponseContent,
  type TranscriptVerbosity,
} from '@nessy-agent/ui'

// Import sample workflows
import {
  incidentResponseActivities,
  incidentResponseResponse,
} from './samples/incident-response'
import {
  deploymentActivities,
  deploymentResponse,
} from './samples/deployment'
import {
  customerSupportActivities,
  customerSupportResponse,
} from './samples/customer-support'

// Import icons for simple samples
import { nativeToolIcons, sourceIcons, createCircleIcon } from './sample-icons'

/** Wrapper with padding for playground preview */
function PaddedWrapper({ children }: { children: ReactNode }) {
  return <div className="p-8">{children}</div>
}

// ============================================================================
// Simple Sample Data (for quick demos)
// ============================================================================

const now = Date.now()

// Simple native tool samples
const simpleRead: ActivityItem = {
  id: 'simple-read-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/components/Button.tsx' },
  timestamp: now - 5000,
}

const simpleEdit: ActivityItem = {
  id: 'simple-edit-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Edit',
  toolInput: { file_path: '/src/auth/index.ts', old_string: '...', new_string: '...' },
  timestamp: now - 4000,
}

const simpleBashGit: ActivityItem = {
  id: 'simple-bash-git',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: { command: 'git status', description: 'Checking repository status' },
  intent: 'Checking repository status',
  toolDisplayMeta: {
    displayName: 'Git',
    category: 'native',
    iconDataUrl: nativeToolIcons.git,
  },
  timestamp: now - 3000,
}

const simpleBashNpm: ActivityItem = {
  id: 'simple-bash-npm',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: { command: 'npm test', description: 'Running the test suite' },
  intent: 'Running the test suite',
  toolDisplayMeta: {
    displayName: 'npm',
    category: 'native',
    iconDataUrl: nativeToolIcons.npm,
  },
  timestamp: now - 2000,
}

// Simple MCP tool samples
const simpleSlack: ActivityItem = {
  id: 'simple-slack',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__slack__slack_send_message',
  toolInput: {
    channel: '#general',
    text: 'Hello team!',
    _intent: 'Sending a message to the team',
    _displayName: 'Send Message',
  },
  intent: 'Sending a message to the team',
  displayName: 'Send Message',
  toolDisplayMeta: {
    displayName: 'Slack',
    category: 'source',
    iconDataUrl: sourceIcons.slack,
  },
  timestamp: now - 1000,
}

const simpleStripe: ActivityItem = {
  id: 'simple-stripe',
  type: 'tool',
  status: 'completed',
  toolName: 'mcp__stripe__api_stripe',
  toolInput: {
    path: '/v1/customers',
    method: 'GET',
    _intent: 'Fetching customer list',
    _displayName: 'List Customers',
  },
  intent: 'Fetching customer list',
  displayName: 'List Customers',
  toolDisplayMeta: {
    displayName: 'Stripe',
    category: 'source',
    iconDataUrl: sourceIcons.stripe,
  },
  timestamp: now,
}

// Simple responses
const shortResponse: ResponseContent = {
  text: "I've completed the requested operations. All tasks have been processed successfully.",
  isStreaming: false,
}

// ============================================================================
// Playground Component with Mode Toggle
// ============================================================================

type DisplayMode = 'informative' | 'detailed'

function TurnCardModesDemo({
  activities,
  response,
  userMessage,
  initialMode = 'detailed',
}: {
  activities: ActivityItem[]
  response?: ResponseContent
  userMessage?: string
  initialMode?: DisplayMode
}) {
  const [mode, setMode] = useState<DisplayMode>(initialMode)

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackActivities, setPlaybackActivities] = useState<ActivityItem[]>([])
  const [showResponse, setShowResponse] = useState(false)
  const playbackRef = useRef<{ cancel: boolean }>({ cancel: false })

  // Sync mode when variant changes initialMode prop
  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  // Reset playback when activities change (variant switch)
  useEffect(() => {
    playbackRef.current.cancel = true
    setIsPlaying(false)
    setPlaybackActivities([])
    setShowResponse(false)
  }, [activities])

  // Playback logic
  const startPlayback = useCallback(async () => {
    // Reset state
    playbackRef.current.cancel = false
    setIsPlaying(true)
    setPlaybackActivities([])
    setShowResponse(false)

    // Process each activity
    for (let i = 0; i < activities.length; i++) {
      if (playbackRef.current.cancel) return

      const activity = activities[i]

      // Add activity as "running"
      setPlaybackActivities(prev => [
        ...prev,
        { ...activity, status: 'running' }
      ])

      // Random "running" duration: 1000-2000ms
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000))
      if (playbackRef.current.cancel) return

      // Mark as "completed"
      setPlaybackActivities(prev =>
        prev.map((a, idx) => idx === prev.length - 1 ? { ...a, status: 'completed' } : a)
      )

      // No delay between activities - next one starts immediately after completion
    }

    // Show response after small delay
    if (!playbackRef.current.cancel) {
      await new Promise(resolve => setTimeout(resolve, 300))
      setShowResponse(true)
      setIsPlaying(false)
    }
  }, [activities])

  const resetPlayback = useCallback(() => {
    playbackRef.current.cancel = true
    setIsPlaying(false)
    setPlaybackActivities([])
    setShowResponse(false)
  }, [])

  // Determine what to show
  const hasPlaybackStarted = playbackActivities.length > 0 || isPlaying
  const displayActivities = hasPlaybackStarted ? playbackActivities : activities
  const displayResponse = hasPlaybackStarted ? (showResponse ? response : undefined) : response
  const isComplete = hasPlaybackStarted ? showResponse : true

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
        {/* Playback Button */}
        <button
          onClick={hasPlaybackStarted ? resetPlayback : startPlayback}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-background shadow-minimal text-foreground hover:bg-foreground/5 transition-colors"
        >
          {hasPlaybackStarted ? (
            <>
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" />
              Play
            </>
          )}
        </button>

        <div className="w-px h-5 bg-border mx-2" />

        {/* Mode Toggle */}
        <span className="text-sm font-medium text-muted-foreground mr-2">Display Mode:</span>
        <button
          onClick={() => setMode('informative')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            mode === 'informative'
              ? 'bg-background shadow-minimal text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Informative
        </button>
        <button
          onClick={() => setMode('detailed')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            mode === 'detailed'
              ? 'bg-background shadow-minimal text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Detailed
        </button>
        <span className="ml-4 text-xs text-muted-foreground">
          {mode === 'informative'
            ? 'Hides MCP/API tool names and params, shows only source + intent'
            : 'Shows full tool names, params, and all metadata'
          }
        </span>
      </div>

      {/* User Message (shows the user's request/intention) */}
      {userMessage && (
        <div className="pt-4">
          <UserMessageBubble content={userMessage} />
        </div>
      )}

      {/* TurnCard with mode and hover states enabled */}
      <TurnCard
        sessionId="playground-modes"
        turnId="playground-turn"
        activities={displayActivities}
        response={displayResponse}
        isStreaming={isPlaying}
        isComplete={isComplete}
        defaultExpanded={true}
        displayMode={mode}
        animateResponse={hasPlaybackStarted}
        onOpenFile={(path) => console.log('[Playground] Open file:', path)}
        onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
        onOpenActivityDetails={(activity) => console.log('[Playground] Open activity details:', activity.id, activity.toolName)}
      />
    </div>
  )
}

// ============================================================================
// P6.469 · Transcript view mode — the state the one key (Cmd/Ctrl+O) cycles
// ============================================================================

/**
 * The same turn, painted at each of the three verbosities.
 *
 * The design surface for the row, and the reason it is a playground entry
 * rather than a screenshot: Summary is the state that LOOKS like a bug — the
 * step-count badge still says twelve while two rows are drawn — and the point
 * of drawing it here is to confirm that it reads as "there was more" and not as
 * "the session did nothing".
 */
function TranscriptVerbosityDemo({
  activities,
  response,
  userMessage,
  initialVerbosity = 'normal',
}: {
  activities: ActivityItem[]
  response?: ResponseContent
  userMessage?: string
  initialVerbosity?: TranscriptVerbosity
}) {
  const [verbosity, setVerbosity] = useState<TranscriptVerbosity>(initialVerbosity)
  useEffect(() => { setVerbosity(initialVerbosity) }, [initialVerbosity])

  const blurb: Record<TranscriptVerbosity, string> = {
    normal: 'Tool calls collapsed into summaries, with full text responses',
    verbose: 'Every tool call, file read and intermediate step — the section opens itself',
    summary: 'Only the final response and the changes it made; the badge still counts the rest',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
        <span className="text-sm font-medium text-muted-foreground mr-2">Transcript view:</span>
        {TRANSCRIPT_VERBOSITY_MODES.map(mode => (
          <button
            key={mode}
            onClick={() => setVerbosity(mode)}
            className={`px-3 py-1.5 text-sm rounded-md capitalize transition-colors ${
              verbosity === mode
                ? 'bg-background shadow-minimal text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {mode}
          </button>
        ))}
        <span className="ml-4 text-xs text-muted-foreground">{blurb[verbosity]}</span>
      </div>

      {userMessage && (
        <div className="pt-4">
          <UserMessageBubble content={userMessage} />
        </div>
      )}

      <TurnCard
        sessionId="playground-verbosity"
        turnId="playground-verbosity-turn"
        activities={activities}
        {...(response ? { response } : {})}
        isStreaming={false}
        isComplete={true}
        transcriptVerbosity={verbosity}
        onOpenFile={(path) => console.log('[Playground] Open file:', path)}
        onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
      />
    </div>
  )
}

// ============================================================================
// Component Registry
// ============================================================================

export const turnCardModesComponents: ComponentEntry[] = [
  {
    id: 'turn-card-transcript-verbosity',
    name: 'Transcript View Mode',
    category: 'TurnCard Modes',
    description:
      'P6.469 · Normal / Verbose / Summary, cycled by one key (Cmd+O, and literally Ctrl+O on Windows and Linux). Host-rendered from the event stream, so the three runtimes cannot diverge: codex and Pi both surface a file change as `Edit`, which is claude\'s own spelling. Normal is exactly what the card rendered before the row existed.',
    component: TranscriptVerbosityDemo,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'initialVerbosity',
        description: 'Which of the three modes the card starts in',
        control: {
          type: 'select',
          options: [
            { label: 'Normal', value: 'normal' },
            { label: 'Verbose', value: 'verbose' },
            { label: 'Summary', value: 'summary' },
          ],
        },
        defaultValue: 'normal',
      },
    ],
    variants: [
      {
        name: 'Normal — the default, unchanged',
        description: 'Tool calls collapsed into summaries, with full text responses. Byte-for-byte what this card always drew.',
        props: {
          userMessage: 'There\'s a spike in errors on the dashboard. Can you investigate and fix the issue?',
          activities: incidentResponseActivities,
          response: incidentResponseResponse,
          initialVerbosity: 'normal',
        },
      },
      {
        name: 'Verbose — every step, section open',
        description: 'Every tool call, file read and intermediate step. The section opens itself, because there is nothing to be in Verbose for while it is collapsed; a MessageDisplay hook\'s replacement is set aside so the model\'s own words are painted.',
        props: {
          userMessage: 'There\'s a spike in errors on the dashboard. Can you investigate and fix the issue?',
          activities: incidentResponseActivities,
          response: incidentResponseResponse,
          initialVerbosity: 'verbose',
        },
      },
      {
        name: 'Summary — only the changes, and the count stays honest',
        description: 'Only the final response and the changes it made. THE STATE TO LOOK AT: the step-count badge still counts every held-back row, so the turn reads as "there was more" rather than as "nothing happened".',
        props: {
          userMessage: 'There\'s a spike in errors on the dashboard. Can you investigate and fix the issue?',
          activities: incidentResponseActivities,
          response: incidentResponseResponse,
          initialVerbosity: 'summary',
        },
      },
      {
        name: 'Summary — a read-only turn',
        description: 'Boundary: a turn that changed nothing draws no rows in Summary and still shows its count. The response is the whole of what happened, which is what the mode promises.',
        props: {
          userMessage: 'What does the deploy pipeline do?',
          activities: [simpleRead, simpleBashGit, simpleSlack],
          response: shortResponse,
          initialVerbosity: 'summary',
        },
      },
    ],
    // F1.216 — the state the page opens the entry in, before any variant is
    // picked. `mockData` was `{}`, so the demo got `activities` undefined and the
    // entry threw on its first render; it now opens on the Normal variant's turn.
    mockData: () => ({
      userMessage: 'There\'s a spike in errors on the dashboard. Can you investigate and fix the issue?',
      activities: incidentResponseActivities,
      response: incidentResponseResponse,
    }),
  },
  {
    id: 'turn-card-modes-all',
    name: 'All Tool Types',
    category: 'TurnCard Modes',
    description: 'Compare Informative vs Detailed mode with various tool types and workflows',
    component: TurnCardModesDemo,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'initialMode',
        description: 'Starting display mode',
        control: {
          type: 'select',
          options: [
            { label: 'Informative', value: 'informative' },
            { label: 'Detailed', value: 'detailed' },
          ],
        },
        defaultValue: 'detailed',
      },
    ],
    variants: [
      {
        name: '🚨 Incident Response',
        description: 'Production incident: Sentry → Slack → GitHub → Fix → Deploy (12 steps)',
        props: {
          userMessage: 'There\'s a spike in errors on the dashboard. Can you investigate and fix the issue?',
          activities: incidentResponseActivities,
          response: incidentResponseResponse,
          initialMode: 'detailed',
        },
      },
      {
        name: '🚀 Full-Stack Deployment',
        description: 'Feature development through CI/CD to production (16 steps)',
        props: {
          userMessage: 'Deploy the new user authentication feature to production with full CI/CD pipeline.',
          activities: deploymentActivities,
          response: deploymentResponse,
          initialMode: 'detailed',
        },
      },
      {
        name: '💬 Customer Support',
        description: 'Cross-platform support: Gmail → Stripe → ClickUp → Slack (10 steps)',
        props: {
          userMessage: 'I got an email from a customer about a billing issue. Can you help resolve it?',
          activities: customerSupportActivities,
          response: customerSupportResponse,
          initialMode: 'detailed',
        },
      },
      {
        name: 'Simple: Native + MCP Mix',
        description: 'Quick demo with native tools and MCP sources',
        props: {
          userMessage: 'Check the repo status, run tests, and notify the team on Slack.',
          activities: [
            simpleRead,
            simpleEdit,
            simpleBashGit,
            simpleBashNpm,
            simpleSlack,
            simpleStripe,
          ],
          response: shortResponse,
          initialMode: 'detailed',
        },
      },
      {
        name: 'Informative Mode Preview',
        description: 'Same mix starting in Informative mode',
        props: {
          userMessage: 'Check the repo status, run tests, and notify the team on Slack.',
          activities: [
            simpleRead,
            simpleEdit,
            simpleBashGit,
            simpleBashNpm,
            simpleSlack,
            simpleStripe,
          ],
          response: shortResponse,
          initialMode: 'informative',
        },
      },
    ],
    mockData: () => ({
      userMessage: 'Read the Button component, check git status, and post to Slack.',
      activities: [
        simpleRead,
        simpleBashGit,
        simpleSlack,
      ],
      response: shortResponse,
      initialMode: 'detailed',
    }),
  },
]
