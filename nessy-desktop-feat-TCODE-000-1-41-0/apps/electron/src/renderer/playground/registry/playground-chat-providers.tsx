/**
 * The context providers a playground entry that mounts a `ChatDisplay` (or reads
 * `useNavigation` / `useActionRegistry`) needs, spelled once — and, since F1.281,
 * mounted once for EVERY entry by `PlaygroundEntryFrame` (`../ComponentPreview.tsx`),
 * so no entry wraps its own.
 *
 * `ChatDisplay` reads `useNavigation()` (session branching) and registers
 * actions through the action registry, and both hooks THROW outside their
 * provider. The playground root supplies neither — only the mobile demos wrap
 * their own, in `MobilePlaygroundProviders` — so an entry that mounted a
 * `ChatDisplay` bare rendered a blank page. Measured 2026-09-23 on the dev
 * playground: `EditPopover` (inline, on opening) and `Side Question Panel
 * (/btw)` both died with `useNavigation must be used within
 * NavigationProvider`, and with navigation supplied, next with
 * `useActionRegistry must be used within ActionRegistryProvider`.
 *
 * The same stack the mobile demos use, minus their per-demo Jotai store and
 * AppShell override (each entry here brings its own AppShell context): no-op
 * routing, the playground's own workspace id, a mock session factory.
 */
import * as React from 'react'
import { ModalProvider } from '@/context/ModalContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ActionRegistryProvider } from '@/actions/registry'
import { NavigationProvider } from '@/contexts/NavigationContext'
import type { Session } from '../../../shared/types'

const PLAYGROUND_WORKSPACE_ID = 'playground-workspace'

async function createPlaygroundSession(workspaceId: string): Promise<Session> {
  return {
    id: `playground-created-${Date.now()}`,
    workspaceId,
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }
}

export function PlaygroundChatProviders({ children }: { children: React.ReactNode }) {
  return (
    <ActionRegistryProvider>
      <DismissibleLayerProvider>
        <ModalProvider>
          <NavigationProvider
            workspaceId={PLAYGROUND_WORKSPACE_ID}
            onCreateSession={createPlaygroundSession}
            isReady
            isSessionsReady
          >
            {children}
          </NavigationProvider>
        </ModalProvider>
      </DismissibleLayerProvider>
    </ActionRegistryProvider>
  )
}
