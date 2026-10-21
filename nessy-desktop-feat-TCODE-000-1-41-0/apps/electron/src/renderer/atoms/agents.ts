/**
 * Agents Atom
 *
 * Simple atom for storing workspace agent definitions.
 */

import { atom } from 'jotai'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

export const agentsAtom = atom<SafeCapabilitySummary[]>([])
