/**
 * A per-run secret the parent conversation knows and nothing else can supply.
 *
 * AGT-1's whole value is the negative control: a fork answers a question only
 * the parent's history can answer, and a named subagent — which cannot inherit —
 * cannot. That comparison is void the moment the secret exists anywhere a
 * fresh-context agent can read.
 *
 * It happened. The 2026-07-30 run planted `ZARYA-417` with the words "Remember
 * this codeword exactly", the model did exactly that — through its memory tool,
 * into the session's own `data/MEMORY.md` — and the control subagent later read
 * it back verbatim out of the file. The control reported FAIL and the finding
 * was the harness's.
 *
 * Two defences, because either alone is a coin flip:
 *
 * 1. **Don't ask for it to be remembered.** `plantPrompt` states the value and
 *    explicitly forbids persisting it. "Remember" is the word that reaches for
 *    the memory tool.
 * 2. **Check, don't assume.** `memoryLeaks` reads the three files the memory
 *    layer actually loads (`memory-store.ts`) and names any that hold the token.
 *    A leaked control is reported as unrunnable, never as a pass or a fail.
 *
 * The value carries no fixed prefix from any earlier run. `ZARYA` is in this
 * repo's own checklist, so a subagent with a shell could have grepped its way to
 * a plausible-looking answer without inheriting anything.
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `memory-store.ts`: `MEMORY_FILE_NAME`. */
const MEMORY_FILE_NAME = 'MEMORY.md'

/** A fresh token: 20 hex characters, no dictionary word, no run-to-run prefix. */
export function newCodeword(): string {
  const hex = randomBytes(10).toString('hex').toUpperCase()
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15)}`
}

/**
 * The message that plants it.
 *
 * Kept here rather than in the case so the wording and the leak scan stay one
 * decision: the scan below only makes sense against a prompt that asked for no
 * persistence in the first place.
 */
export function plantPrompt(codeword: string): string {
  return (
    `For this conversation only, the reference label is ${codeword}. ` +
    'Do not write it to memory, to MEMORY.md, or to any file — keep it in this conversation. ' +
    'Reply with the single word OK.'
  )
}

/** The question only this conversation can answer. */
export function recallPrompt(): string {
  return 'What is the reference label for this conversation? Answer with the label and nothing else.'
}

export interface MemoryLeak {
  path: string
  scope: 'session' | 'project' | 'user'
}

export interface MemoryScanTargets {
  /** `<config>/sessions/<workspaceId>/<sessionId>/data/MEMORY.md`. */
  workspaceId: string
  sessionId: string
  /** The session's working directory, when the case knows it. */
  workingDirectory?: string
  configDir?: string
}

/**
 * Every memory file that holds `codeword`.
 *
 * The three paths are `memory-store.ts`'s own: session (`<session>/data/`),
 * project (`<cwd>/`) and user (`<configDir>/`). A fork reads the PARENT's
 * session memory by design (`child-session-scope.ts` `resolveMemorySessionId`),
 * so a token sitting in any of these reaches a child through the prompt itself
 * and proves nothing about inheritance.
 */
export async function memoryLeaks(codeword: string, targets: MemoryScanTargets): Promise<MemoryLeak[]> {
  const configDir = targets.configDir ?? join(homedir(), '.nessy-agent')
  const candidates: MemoryLeak[] = [
    { scope: 'session', path: join(configDir, 'sessions', targets.workspaceId, targets.sessionId, 'data', MEMORY_FILE_NAME) },
    { scope: 'user', path: join(configDir, MEMORY_FILE_NAME) },
    ...(targets.workingDirectory ? [{ scope: 'project' as const, path: join(targets.workingDirectory, MEMORY_FILE_NAME) }] : []),
  ]
  const hits: MemoryLeak[] = []
  for (const candidate of candidates) {
    const text = await readFile(candidate.path, 'utf8').catch(() => undefined)
    if (text?.includes(codeword)) hits.push(candidate)
  }
  return hits
}
