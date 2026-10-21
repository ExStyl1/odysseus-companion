/**
 * Skills Atom
 *
 * Simple atom for storing workspace skills.
 * Used by NavigationContext for auto-selection when navigating to skills view.
 */

import { atom } from 'jotai'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

/**
 * Atom to store the current workspace's skills.
 * AppShell populates this when skills are loaded.
 * NavigationContext reads from it for auto-selection.
 */
export const skillsAtom = atom<SafeCapabilitySummary[]>([])
