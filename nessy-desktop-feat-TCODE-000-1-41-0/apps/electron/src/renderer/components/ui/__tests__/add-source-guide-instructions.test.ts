/**
 * F1.246 — the add-source instructions must not send the agent to a tool that
 * does not exist.
 *
 * The 'add-source-local' prompt in `EditPopover.tsx` and step 0 of the bundled
 * `resources/docs/sources.md` (synced to `~/.nessy-agent/docs/` on every
 * launch) told the agent to call `mcp__nessy-docs__SearchNessyDocs` as a
 * REQUIRED FIRST STEP. Nothing registers that server or tool
 * (`getBuiltinSources` returns an empty list), so the first instruction of every
 * add-source turn was a call that could only fail. Upstream craft-agents-oss
 * dropped its SearchCraftDocs twin in v0.12.0 for a hosted docs URL; Nessy has
 * no hosted per-service guides, so the step now points at what ships: the
 * provider notes in the same bundled guide.
 *
 * Positive arm: neither file names the dead tool (nor the `nessy-docs` server).
 * Negative arm: the bundled guide still carries its setup process, its step 0
 * and the two sections step 0 now points at — so the guard cannot pass on an
 * emptied or truncated file.
 *
 * F1.460 (8)(9) — the text an add-source agent actually RECEIVES is neither of
 * these two files: a managed popover sends the user's instructions plus the
 * host's guidance (`getManagedEditAgentGuidance` in server-core's
 * `domain/capabilities/managed-resources.ts`), and EditPopover's own per-key
 * text reaches no agent (F1.432). That third surface is guarded where it can be
 * resolved, in `server-core/src/handlers/rpc/__tests__/managed-resources.test.ts`
 * (every add-source key, no SearchNessyDocs; the add-source-local pointer to
 * the Local Sources section). The assertion that EditPopover still carried the
 * guide's path was a pin on that unsent text and could not fail for
 * add-source-local (three other entries spell the path), so it is gone.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')

const EDIT_POPOVER = read('../EditPopover.tsx')
const SOURCES_GUIDE = read('../../../../../resources/docs/sources.md')

describe('F1.246 — no add-source instruction names a tool nothing registers', () => {
  it('EditPopover and the bundled sources.md never name SearchNessyDocs or the nessy-docs server', () => {
    for (const text of [EDIT_POPOVER, SOURCES_GUIDE]) {
      expect(text).not.toContain('SearchNessyDocs')
      expect(text).not.toContain('mcp__nessy-docs__')
    }
  })

  it('the bundled guide keeps its setup process, its step 0 and the sections step 0 points at', () => {
    expect(SOURCES_GUIDE).toContain('## Source Setup Process')
    expect(SOURCES_GUIDE).toMatch(/^### 0\. /m)
    expect(SOURCES_GUIDE).toContain('## Common Providers')
    expect(SOURCES_GUIDE).toContain('### Local Sources')
  })
})
