/**
 * Mention Parsing Utilities
 *
 * Pure string-parsing functions for [bracket] mentions in chat messages.
 * No renderer/browser dependencies — safe to use in any context.
 *
 * Mention types:
 * - Skills:  [skill:slug] or [skill:workspaceId:slug]
 * - Sources: [source:slug]
 * - Files:   [file:path]
 * - Folders: [folder:path]
 *
 * `[skill:…]` is the host's OWN invocation vocabulary and the only one any of the
 * three runtimes is given — deliberately one marker for three, not an oversight.
 * The vendors each spell the same act differently (`/skill` on Claude,
 * `$skill` in Codex, `@skill` in ChatGPT) and none of those resolves here, so a
 * pasted vendor prompt template is plain text. The decision, its reason and the
 * cost it accepts are recorded once, at the place that TELLS the model the
 * marker: `agent/core/prompt-builder.ts:skillListingReference` (P6.38 / ledger
 * L11). Do not restate it here — record any change there.
 */

// Simple path join that works in both Node and browser contexts.
// Cannot use node:path here — this module is imported by the Vite renderer.
function joinPath(base: string, relative: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return base.endsWith(sep) ? base + relative : base + sep + relative
}

// ============================================================================
// Constants
// ============================================================================

// Workspace ID character class for regex: word chars, spaces (NOT newlines), hyphens, dots
// Using literal space instead of \s to avoid matching newlines which would break parsing
export const WS_ID_CHARS = '[\\w .-]'

// ============================================================================
// Types
// ============================================================================

export interface ParsedMentions {
  /** Skill slugs mentioned via [skill:slug] */
  skills: string[]
  /** Invalid skill slugs mentioned but not found in availableSkillSlugs */
  invalidSkills: string[]
  /** Source slugs mentioned via [source:slug] */
  sources: string[]
  /** File paths mentioned via [file:path] */
  files: string[]
  /** Folder paths mentioned via [folder:path] */
  folders: string[]
}

/** Exact payloads from `[skill:...]` mentions, in first-seen order. */
export function parseSkillMentionReferences(text: string): string[] {
  return [...new Set(parseSkillMentionOccurrences(text))]
}

/** Exact payloads from every `[skill:...]` mention, including repeats, in text order. */
export function parseSkillMentionOccurrences(text: string): string[] {
  return [...text.matchAll(/\[skill:([^\]\r\n]+)\]/g)].map(match => match[1]!)
}

function legacySkillSlug(reference: string): string {
  return reference.slice(reference.lastIndexOf(':') + 1)
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse all mentions from message text
 *
 * @param text - The message text to parse
 * @param availableSkillSlugs - Valid skill slugs to match against
 * @param availableSourceSlugs - Valid source slugs to match against
 * @returns Parsed mentions by type
 *
 * @example
 * parseMentions('[skill:commit] [source:linear]', ['commit'], ['linear'])
 * // Returns: { skills: ['commit'], sources: ['linear'] }
 */
export function parseMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): ParsedMentions {
  const result: ParsedMentions = {
    skills: [],
    invalidSkills: [],
    sources: [],
    files: [],
    folders: [],
  }

  // Match source mentions: [source:slug]
  const sourcePattern = /\[source:([\w-]+)\]/g
  let match: RegExpExecArray | null
  while ((match = sourcePattern.exec(text)) !== null) {
    const slug = match[1]!
    if (availableSourceSlugs.includes(slug) && !result.sources.includes(slug)) {
      result.sources.push(slug)
    }
  }

  for (const reference of parseSkillMentionReferences(text)) {
    const legacySlug = legacySkillSlug(reference)
    const resolved = availableSkillSlugs.includes(reference)
      ? reference
      : availableSkillSlugs.includes(legacySlug)
        ? legacySlug
        : undefined
    if (resolved) {
      if (!result.skills.includes(resolved)) {
        result.skills.push(resolved)
      }
    } else {
      if (!result.invalidSkills.includes(reference)) {
        result.invalidSkills.push(reference)
      }
    }
  }

  // Match file mentions: [file:path] (path can contain any chars except ])
  const filePattern = /\[file:([^\]]+)\]/g
  while ((match = filePattern.exec(text)) !== null) {
    const filePath = match[1]!
    if (!result.files.includes(filePath)) {
      result.files.push(filePath)
    }
  }

  // Match folder mentions: [folder:path]
  const folderPattern = /\[folder:([^\]]+)\]/g
  while ((match = folderPattern.exec(text)) !== null) {
    const folderPath = match[1]!
    if (!result.folders.includes(folderPath)) {
      result.folders.push(folderPath)
    }
  }

  return result
}

/**
 * Strip all mentions from text, replacing skill/source mentions with their slug.
 *
 * @param text - The message text with mentions
 * @returns Text with skill/source mentions replaced by their slug
 *
 * @deprecated Prefer resolveSkillMentions + resolveSourceMentions for richer output.
 */
export function stripAllMentions(text: string): string {
  return text
    // Replace [source:slug] with just the slug
    .replace(/\[source:([\w-]+)\]/g, '$1')
    // Replace [skill:slug], legacy workspace-qualified, or exact capability-key mentions.
    .replace(/\[skill:([^\]\r\n]+)\]/g, (_match, reference: string) => legacySkillSlug(reference))
    // Note: [file:...] and [folder:...] are NOT stripped — they are content
    // that gets resolved to absolute paths by resolveFileMentions().
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolve skill mentions to semantic markers with display names.
 *
 * [skill:datadog-api]           → [Mentioned skill: Datadog API (slug: datadog-api)]
 * [skill:My Workspace:commit]   → [Mentioned skill: Git Commit (slug: commit)]
 *
 * Skills not found in the map fall back to the slug as display name.
 *
 * @param text - The message text with skill mentions
 * @param skillNames - Map of slug → display name (from loaded skill metadata)
 */
export function resolveSkillMentions(
  text: string,
  skillNames: Map<string, string>
): string {
  return text.replace(
    /\[skill:([^\]\r\n]+)\]/g,
    (_match, reference: string) => {
      const legacySlug = legacySkillSlug(reference)
      const exact = skillNames.has(reference)
      const name = skillNames.get(reference) ?? skillNames.get(legacySlug) ?? legacySlug
      return `[Mentioned skill: ${name} (slug: ${exact ? reference : legacySlug})]`
    }
  )
}

/**
 * Resolve source mentions to semantic markers.
 *
 * [source:github] → [Mentioned source: github]
 *
 * @param text - The message text with source mentions
 */
export function resolveSourceMentions(text: string): string {
  return text.replace(
    /\[source:([\w-]+)\]/g,
    (_match, slug: string) => `[Mentioned source: ${slug}]`
  )
}

/**
 * Resolve file and folder mentions to semantic markers with absolute paths.
 *
 * [file:src/index.ts]       → [Mentioned file: index.ts (at /Users/me/project/src/index.ts)]
 * [folder:src/components]   → [Mentioned folder: components (at /Users/me/project/src/components)]
 * [file:/tmp/test.txt]      → [Mentioned file: test.txt (at /tmp/test.txt)]
 *
 * The semantic wrapper signals to the agent that the user explicitly referenced
 * this file/folder and it should be proactively read. This matches the
 * [Attached file: ...] pattern used by drag-and-drop attachments.
 *
 * Leaves other mention types ([skill:...], [source:...]) untouched.
 */
// ============================================================================
// MCP resource mentions
// ============================================================================

/**
 * `@<server>:<scheme>://<path>` — Claude's documented resource-mention format
 * (`@github:issue://123`). The server slug is word-ish; the URI is any scheme
 * followed by `://` and a non-space tail. Distinct from an email (`a@b.com`,
 * no `://`) and from bracket mentions.
 */
const MCP_RESOURCE_MENTION = /@([A-Za-z0-9_-]+):([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s\]]+)/g

export interface McpResourceMention {
  server: string
  uri: string
  /** The exact matched text, for replacement. */
  raw: string
}

/** One resource offered in the `@` autocomplete alongside files. */
export interface McpResourceMentionCandidate {
  server: string
  uri: string
  name?: string
  mimeType?: string
  description?: string
}

/** Parse every `@server:uri` resource mention, de-duplicated in first-seen order. */
export function parseMcpResourceMentions(text: string): McpResourceMention[] {
  const seen = new Set<string>()
  const mentions: McpResourceMention[] = []
  for (const match of text.matchAll(MCP_RESOURCE_MENTION)) {
    const raw = match[0]!
    if (seen.has(raw)) continue
    seen.add(raw)
    mentions.push({ server: match[1]!, uri: match[2]!, raw })
  }
  return mentions
}

// Imported here rather than at the top so the lines other documents cite above
// keep their numbers. A leaf module (no imports of its own), so the renderer's
// import of this file stays renderer-safe.
import { formatTolerantTagPattern, neutralizeHarnessMarkers } from '../prompts/untrusted-text.ts'

/**
 * F1.891 — every tag-like `<mcp-resource` / `</mcp-resource` (any case, any
 * spacing) in text the host did not write, so a server can neither close the
 * fence early nor open a second one. The `<` becomes `&lt;`: still readable, no
 * longer a tag. The claude binary guards its own wrapper around a resource's
 * text the same way (it escapes the wrapper's closing tag inside that text).
 *
 * F1.1016 — built by the host's one tag builder rather than spelled here, so an
 * invisible format character in the gap (`</` + U+2060 + `mcp-resource>`) or
 * between the name's letters is caught too; `\s` stays admitted in the gap,
 * as F1.891 had it. Only the `<` is replaced: every other byte the server wrote
 * survives.
 */
const MCP_RESOURCE_TAG_LIKE = formatTolerantTagPattern(['mcp-resource'], '\\s')

/**
 * F1.1010 — the server's text is first run through
 * {@link neutralizeHarnessMarkers}, the host's one defang for untrusted text:
 * control characters out, then a zero-width space after the `<` of every
 * harness tag, so the server cannot plant a live `<system-reminder>` (or
 * `<untrusted>` / `<nessy_agent_environment>`) inside the fence. It touches
 * nothing else — `User:` lines in a document stay as they are. The strip runs
 * BEFORE the fence escape on purpose: `</` + U+0001 + `mcp-resource>` would
 * otherwise slip past {@link MCP_RESOURCE_TAG_LIKE} and close the fence.
 */
function escapeMcpResourceText(text: string): string {
  return neutralizeHarnessMarkers(text).replace(MCP_RESOURCE_TAG_LIKE, tag => `&lt;${tag.slice(1)}`)
}

/** An attribute value additionally cannot end its own quotes. */
function escapeMcpResourceAttribute(value: string): string {
  return escapeMcpResourceText(value).replaceAll('"', '&quot;')
}

/**
 * Fetch each `@server:uri` mention's contents and inline them before the turn is
 * built, the resource analogue of the drag-and-drop `[Attached file: ...]`
 * pattern. Fails SOFT: an unknown server, an unknown uri, or a read error
 * becomes a note in place of the content, never a thrown turn.
 *
 * F1.891 (owner decision 2026-09-26, option `tag-wrap`) — the text is FENCED:
 * `<mcp-resource server="…" uri="…">` + the server's text +
 * `</mcp-resource>`, so the model can see where the server's text ends and the
 * user's words resume. The tag is the claude binary's (2.1.267) for a resource
 * attachment with no content; its text attachment rides a `<system-reminder>`
 * instead, which a user message must not carry, so the neutral tag it is. The server's text, and a read error's (the server's too), is
 * escaped by {@link escapeMcpResourceText}, so the only fence tags in the
 * result are the host's own and no harness tag inside is live (F1.1010). One writer for all three runtimes
 * (`BaseAgent.extractSkillInvocations`); the Guardian judge's reader of this
 * shape is `judgeTrustedIntent` (`prompts/guardian.ts`).
 *
 * F1.1022 — every mention is replaced in ONE pass over the user's own text, so
 * a fence lands only where the user typed its mention and fences never nest.
 * Replacing mention after mention (`split`/`join`) re-scanned the text already
 * inlined: a server's text that repeated another typed mention got that whole
 * fence inside its own, and a mention that prefixes a longer one
 * (`@s:x://1` / `@s:x://12`) cut the longer one's start off. A function
 * replacer, so a `$&` in the server's text stays literal.
 */
export async function resolveMcpResourceMentions(
  text: string,
  fetchResource: (
    server: string,
    uri: string,
  ) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>,
): Promise<string> {
  const mentions = parseMcpResourceMentions(text)
  if (mentions.length === 0) return text
  const replacements = new Map<string, string>()
  for (const mention of mentions) {
    const open = `<mcp-resource server="${escapeMcpResourceAttribute(mention.server)}" uri="${escapeMcpResourceAttribute(mention.uri)}">`
    let replacement: string
    try {
      const { contents } = await fetchResource(mention.server, mention.uri)
      const body = contents
        .map(entry => typeof entry.text === 'string'
          ? entry.text
          : `(binary ${entry.mimeType ?? 'application/octet-stream'} resource; contents omitted)`)
        .join('\n')
        .trim()
      replacement = `${open}\n${escapeMcpResourceText(body)}\n</mcp-resource>`
    } catch (error) {
      replacement = `${open}(could not be read: ${escapeMcpResourceText(error instanceof Error ? error.message : String(error))})</mcp-resource>`
    }
    replacements.set(mention.raw, replacement)
  }
  return text.replace(MCP_RESOURCE_MENTION, raw => replacements.get(raw) ?? raw)
}

/** Filter resource candidates for the `@` autocomplete by a fuzzy substring query. */
export function matchMcpResourceMentionCandidates(
  query: string,
  resources: readonly McpResourceMentionCandidate[],
): McpResourceMentionCandidate[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...resources]
  return resources.filter(resource =>
    resource.uri.toLowerCase().includes(normalized)
    || resource.server.toLowerCase().includes(normalized)
    || (resource.name?.toLowerCase().includes(normalized) ?? false)
    || (resource.description?.toLowerCase().includes(normalized) ?? false))
}

export function resolveFileMentions(text: string, workingDirectory: string): string {
  return text
    .replace(/\[file:([^\]]+)\]/g, (_match, filePath: string) => {
      const resolved = filePath.startsWith('/') || filePath.startsWith('~')
        ? filePath
        : joinPath(workingDirectory, filePath)
      const name = filePath.split('/').pop() || filePath
      return `[Mentioned file: ${name} (at ${resolved})]`
    })
    .replace(/\[folder:([^\]]+)\]/g, (_match, folderPath: string) => {
      const resolved = folderPath.startsWith('/') || folderPath.startsWith('~')
        ? folderPath
        : joinPath(workingDirectory, folderPath)
      const name = folderPath.split('/').pop() || folderPath
      return `[Mentioned folder: ${name} (at ${resolved})]`
    })
}
