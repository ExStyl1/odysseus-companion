/**
 * Fixture for `cases/rs-38.ts` — the two preconditions the reopen compact-or-keep
 * offer has, and neither of which a case may create for itself.
 *
 * ```bash
 * NESSY_CONFIG_DIR=<the run's config dir> bun run scripts/cdp/fixtures/reopen-compact.ts
 * NESSY_CONFIG_DIR=<…> bun run scripts/cdp/fixtures/reopen-compact.ts --idle-hours 3 --threshold 20000
 * NESSY_CONFIG_DIR=<…> bun run scripts/cdp/fixtures/reopen-compact.ts --print
 * ```
 *
 * ## Why a FIXTURE and not part of the case
 *
 * `offerCompactOnReopen` (`packages/server-core/src/sessions/SessionManager.ts`)
 * offers the card only when the conversation is idle past
 * `REOPEN_COMPACT_IDLE_MS` — about an hour, a constant with no knob — and is
 * carrying more than `getReopenCompactPromptTokens()`, whose default is 100 000.
 * Both are properties of the config dir's own files: the session's persisted
 * `lastMessageAt`, and `reopenCompactPromptTokens` in `config.json`.
 *
 * The harness README draws that line and it is the line this file sits on: *"A
 * case never installs hooks, plugins or managed policy … A FIXTURE may write
 * into a config dir it owns — that is what a fixture is — and it happens here,
 * in one reviewable place, against a scratch config dir, rather than inside a
 * case where a later reader would not expect it."*
 *
 * ## What it will NOT do
 *
 * - **It never fakes the context size.** The threshold is LOWERED through the
 *   operator knob `getReopenCompactPromptTokens()` already reads, so the number
 *   the card quotes is the session's own real `contextTokens`. A fixture that
 *   wrote `tokenUsage` would make the card quote a fiction and the case would be
 *   measuring its own arithmetic.
 * - **It never touches a config dir it was not given.** `NESSY_CONFIG_DIR` (or
 *   `--config-dir`) is required and must already hold a `config.json` and a
 *   `sessions/` tree, so a typo cannot create a new profile somewhere. It also
 *   refuses a directory under the user's home unless `--allow-home` is passed:
 *   every rig lane's profile lives under the scratchpad, and the one config dir
 *   that must never be rewound is the operator's own.
 * - **It writes no credential and reads none.** The dp credential lives outside
 *   the config dir (`~/.nessy/dp_auth_creds.json`) and nothing here opens it.
 *
 * ## The app must be RELAUNCHED after this runs
 *
 * `SessionManager` holds the session in memory and `persistSession` writes the
 * whole meta line back, so a rewind applied under a running app is overwritten
 * the next time anything persists that session — and `getReopenCompactPromptTokens()`
 * is read from the config the running process loaded. Quit, run this, relaunch.
 * `rs-38` says the same thing in its own `manual` block and BLOCKS rather than
 * guessing when it meets sessions that were never rewound.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The prefix `rs-38` names its sessions with; only these are ever rewound. */
export const REOPEN_FIXTURE_SESSION_PREFIX = 'CDP RS-38'

interface RewoundSession {
  workspaceId: string
  sessionId: string
  name: string
  wasLastMessageAt: number | undefined
  nowLastMessageAt: number
  contextTokens: number | undefined
  messageCount: number | undefined
  reopenCompactChoice: string | null
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** The config dir this fixture is allowed to write, or a thrown refusal. */
export function resolveFixtureConfigDir(): string {
  const raw = argValue('--config-dir') ?? process.env.NESSY_CONFIG_DIR
  if (!raw) {
    throw new Error(
      'reopen-compact-fixture: no config dir. Pass --config-dir <path> or export NESSY_CONFIG_DIR — '
      + 'this fixture rewinds persisted sessions and must never guess which profile it is aimed at.',
    )
  }
  const dir = resolve(raw)
  if (!existsSync(join(dir, 'config.json')) || !existsSync(join(dir, 'sessions'))) {
    throw new Error(
      `reopen-compact-fixture: ${dir} does not look like a config dir (no config.json, or no sessions/). `
      + 'Boot the app against it once first.',
    )
  }
  if (dir.startsWith(`${homedir()}/`) && !process.argv.includes('--allow-home')) {
    throw new Error(
      `reopen-compact-fixture: refusing ${dir} — it is under the user's home. Every rig profile lives under `
      + 'the scratchpad, and the one config dir that must never be rewound is the operator\'s own. '
      + 'Pass --allow-home only if you meant it.',
    )
  }
  return dir
}

/**
 * Rewind every `CDP RS-38 …` session's `lastMessageAt`, and optionally lower the
 * prompt threshold.
 *
 * The rewind is `Date.now() - idleHours` rather than a fixed instant so the card
 * quotes a plausible "idle for about N hours" every time it is run, and
 * `lastUsedAt` moves with it so the sidebar ordering does not contradict it.
 */
export function prepareReopenOffer(
  configDir: string,
  options: { idleHours: number; thresholdTokens?: number },
): { configDir: string; idleHours: number; thresholdTokens: number | '(unchanged)'; sessions: RewoundSession[] } {
  const root = join(configDir, 'sessions')
  const sessions: RewoundSession[] = []
  for (const workspaceId of readdirSync(root)) {
    const workspaceDir = join(root, workspaceId)
    let sessionIds: string[]
    try { sessionIds = readdirSync(workspaceDir) } catch { continue }
    for (const sessionId of sessionIds) {
      const file = join(workspaceDir, sessionId, 'session.jsonl')
      if (!existsSync(file)) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      let meta: Record<string, unknown>
      try { meta = JSON.parse(lines[0] ?? '{}') as Record<string, unknown> } catch { continue }
      if (typeof meta.name !== 'string' || !meta.name.startsWith(REOPEN_FIXTURE_SESSION_PREFIX)) continue
      const was = typeof meta.lastMessageAt === 'number' ? meta.lastMessageAt : undefined
      const now = Date.now() - options.idleHours * 3_600_000
      meta.lastMessageAt = now
      meta.lastUsedAt = now
      lines[0] = JSON.stringify(meta)
      writeFileSync(file, lines.join('\n'))
      const usage = meta.tokenUsage as { contextTokens?: number } | undefined
      sessions.push({
        workspaceId,
        sessionId,
        name: meta.name,
        wasLastMessageAt: was,
        nowLastMessageAt: now,
        contextTokens: usage?.contextTokens,
        messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : undefined,
        reopenCompactChoice: typeof meta.reopenCompactChoice === 'string' ? meta.reopenCompactChoice : null,
      })
    }
  }

  let thresholdTokens: number | '(unchanged)' = '(unchanged)'
  if (options.thresholdTokens !== undefined) {
    const configFile = join(configDir, 'config.json')
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
    config.reopenCompactPromptTokens = options.thresholdTokens
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)
    thresholdTokens = options.thresholdTokens
  }
  return { configDir, idleHours: options.idleHours, thresholdTokens, sessions }
}

if (import.meta.main) {
  const configDir = resolveFixtureConfigDir()
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ configDir, sessionPrefix: REOPEN_FIXTURE_SESSION_PREFIX }, null, 1))
  } else {
    const idleHours = Number(argValue('--idle-hours') ?? '3')
    const thresholdRaw = argValue('--threshold')
    const report = prepareReopenOffer(configDir, {
      idleHours,
      ...(thresholdRaw === undefined ? {} : { thresholdTokens: Number(thresholdRaw) }),
    })
    console.log(JSON.stringify(report, null, 1))
    console.error(
      '\nNow RELAUNCH the app against this config dir — a rewind applied under a running app is overwritten '
      + 'by the next persistSession, and the threshold is read from the config the process loaded — then run:\n'
      + '  bun run scripts/cdp/cases/rs-38.ts\n',
    )
  }
}
