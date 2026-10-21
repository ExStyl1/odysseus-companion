/**
 * P6.469 — the one transcript view mode, persisted across sessions.
 *
 * App-wide and not per session, deliberately: `desktop.md#switch-view-modes`
 * describes Summary as what to use *"when you're running multiple sessions and
 * want to scan results quickly"*, which only works if the mode survives a
 * session switch. `useTurnCardExpansion` beside this file is the opposite case
 * and is keyed per session for the opposite reason.
 *
 * The DECISION — what each mode shows, and the cycle order — is not here. It is
 * `packages/ui/src/components/chat/transcript-verbosity.ts`, so that the desktop
 * transcript and the shared `SessionViewer` can never answer it differently.
 * This hook is storage and nothing else.
 */

import { useCallback, useState } from 'react'
import {
  DEFAULT_TRANSCRIPT_VERBOSITY,
  cycleTranscriptVerbosity,
  isTranscriptVerbosity,
  type TranscriptVerbosity,
} from '@nessy-agent/ui/chat'
import * as storage from '@/lib/local-storage'

export interface TranscriptVerbosityState {
  verbosity: TranscriptVerbosity
  /** Advance one step: Normal → Verbose → Summary → Normal. Returns the new mode. */
  cycle: () => TranscriptVerbosity
}

export function useTranscriptVerbosity(): TranscriptVerbosityState {
  const [verbosity, setVerbosity] = useState<TranscriptVerbosity>(() => {
    // A stored value from an older build, or a hand-edited entry, must not be
    // able to put the transcript into a mode no renderer knows.
    const stored = storage.get<string>(storage.KEYS.transcriptVerbosity, DEFAULT_TRANSCRIPT_VERBOSITY)
    return isTranscriptVerbosity(stored) ? stored : DEFAULT_TRANSCRIPT_VERBOSITY
  })

  const cycle = useCallback(() => {
    const next = cycleTranscriptVerbosity(verbosity)
    setVerbosity(next)
    storage.set(storage.KEYS.transcriptVerbosity, next)
    return next
  }, [verbosity])

  return { verbosity, cycle }
}
