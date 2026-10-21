import * as React from 'react'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { PERMISSION_MODE_ORDER } from '@nessy-agent/shared/agent/modes'

export const DEFAULT_COMPOSER_CAPABILITIES: ComposerCapabilities = {
  attachments: { files: true, images: 'per-model', folders: true },
  mentions: { files: true, skills: true, sources: true },
  slash: { commandIds: 'all' },
  submit: { queue: false, steer: true },
  reasoning: { levels: [] },
  permissions: { modes: PERMISSION_MODE_ORDER },
  // Conservative until the server says otherwise: a composer with no
  // capabilities yet must not offer a switch it cannot know is legal.
  connection: { switchable: false, activeRuntime: 'pi' },
  // C3.263 — `ultracode` is ABSENT here ON PURPOSE, and the absence is the
  // conservative answer rather than a gap. The field's own contract
  // (`@nessy-agent/shared/protocol` `ComposerCapabilities.ultracode`) makes
  // absent mean "an older server that has no answer", which draws NO control,
  // while `mechanism: 'unsupported'` is a real answer that draws a visibly
  // unavailable one with its reason. This fallback is exactly the no-answer
  // case, so writing a block here would turn "we have not been told" into a
  // claim about the runtime — and on codex the claim would be drawn in the
  // wrong shape.
  contextMeter: true,
  contextUsage: { kind: 'unavailable', reason: 'unknown', refresh: false },
  externalFooter: { gitBranch: true },
}

const Ctx = React.createContext<ComposerCapabilities>(DEFAULT_COMPOSER_CAPABILITIES)

export function ComposerCapabilitiesProvider({
  value,
  children,
}: {
  value?: ComposerCapabilities
  children: React.ReactNode
}) {
  return <Ctx.Provider value={value ?? DEFAULT_COMPOSER_CAPABILITIES}>{children}</Ctx.Provider>
}

export function useComposerCapabilities(): ComposerCapabilities {
  return React.useContext(Ctx)
}
