/**
 * AGT-7 — a plugin option is collected, stored and exported.
 *
 * Four steps in the checklist, and this case now drives all four:
 *
 *   1. the plugin declaring `userConfig` ASKS for its options — read from
 *      `plugin.manage({action: 'configuration-status'})`, which is the object
 *      the dialog itself renders from.
 *   2. the options ACCEPT values — written with
 *      `plugin.manage({action: 'configure', values})`, which is the same RPC
 *      the dialog submits through
 *      (`renderer/hooks/usePluginConfigurationPrompt.tsx` — "the one-way
 *      `configure` action the detail page already uses").
 *   3. the plugin's hook sees `CLAUDE_PLUGIN_OPTION_<KEY>` — the option
 *      variables are assembled by `readPluginOptionEnvironment`
 *      (`plugins/plugin-settings.ts`) and minted at
 *      `plugins/user-config-substitution.ts` as
 *      `` `CLAUDE_PLUGIN_OPTION_${field.key.toUpperCase()}` ``. Observable only
 *      from the hook's own output, so the hook must echo it.
 *   4. THE SECURITY HALF — the sensitive value must not sit in plain text under
 *      the plugin data root. A byte scan, run TWICE: once before `configure`
 *      and once after, because a leak written by the write itself is the
 *      interesting one and a single pre-scan would miss it.
 *
 * ## What used to make this case unable to pass, and what replaced it
 *
 * It ended in an unconditional terminal `blocked()` claiming steps 1-2 "are a
 * UI drive … and were not performed by this case", resting on the older claim
 * that "the harness does not install plugins or type secrets on its own". The
 * second half of that is stale: `plugin.manage` is renderer-reachable
 * (`transport/channel-map.ts` — `'plugin.manage': invoke(RPC_CHANNELS.plugins.MANAGE)`)
 * and `configure` is the dialog's own submit path. So steps 1-2 are driven here
 * through the same seam, and the terminal block is gone.
 *
 * INSTALLING the plugin is still the operator's, and stays a precondition.
 *
 * ## Three things that stop a vacuous pass
 *
 * - **The declared shape is asserted, not assumed.** The row is about a plugin
 *   with ONE PLAIN and ONE SENSITIVE option. `PluginConfigurationFieldStatus`
 *   carries `sensitive` per field, so both must be present — a bundle with two
 *   plain options would otherwise "pass" a security assertion about a secret it
 *   never had.
 * - **The write is idempotent.** The value written is the value the operator
 *   supplied in `NESSY_CDP_PLUGIN_SENSITIVE_VALUE`, and `configure` merges over
 *   what is already stored (`management-service-v2.ts` `mergePluginConfiguration`
 *   is given `values` last), so a partial payload cannot clear the operator's
 *   other options.
 * - **The status must not echo the secret.** `management-types.ts` calls the
 *   status "Value-free, like every other status this layer returns"; this case
 *   holds it to that by scanning the returned object's own bytes for the value.
 *   That check is free, and it is the one a UI drive could never make.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'

const ID = 'AGT-7'
const TITLE = "A plugin's userConfig is collected, exported as CLAUDE_PLUGIN_OPTION_<KEY>, and the sensitive value is not in plain text"

/** The sensitive value to store, and to hunt for on disk afterwards. */
const SENSITIVE = process.env.NESSY_CDP_PLUGIN_SENSITIVE_VALUE?.trim()
/** The SENSITIVE option's key, so the case can name the expected env var. */
const OPTION_KEY = process.env.NESSY_CDP_PLUGIN_OPTION_KEY?.trim()
/** The installed plugin `plugin.manage` addresses. */
const PLUGIN_KEY = process.env.NESSY_CDP_PLUGIN_KEY?.trim()
/** Optional: a plain option to set alongside, and its value. */
const PLAIN_KEY = process.env.NESSY_CDP_PLUGIN_PLAIN_KEY?.trim()
const PLAIN_VALUE = process.env.NESSY_CDP_PLUGIN_PLAIN_VALUE?.trim()
/**
 * Where plugin data lives. `workspaces/paths.ts` — `PLUGIN_DATA_DIR =
 * join(PLUGINS_DIR, 'data')` under `CONFIG_DIR`, so it MOVES with
 * `NESSY_CONFIG_DIR`. Hardcoding `~/.nessy-agent` here made the scan read the
 * operator's tree while the app under test wrote a fixture one — a clean pass
 * over the wrong directory.
 */
const DATA_ROOT = process.env.NESSY_CDP_PLUGIN_DATA_ROOT ?? join(configDir(), 'plugins', 'data')

const SCAN_LIMIT_BYTES = 8 * 1024 * 1024

interface FieldStatus {
  key: string
  valueType?: string
  required?: boolean
  configured?: boolean
  missing?: boolean
  sensitive?: boolean
  title?: string
  description?: string
}

interface ConfigurationStatus {
  ok: boolean
  error?: string
  state?: string
  fields: FieldStatus[]
  /** The whole reply, serialised — scanned for the secret it must not carry. */
  raw: string
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

/** Files whose bytes contain `needle`. Never logs file CONTENT, only paths. */
async function filesContaining(root: string, needle: string): Promise<{ scanned: number; hits: string[] }> {
  const hits: string[] = []
  let scanned = 0
  const probe = Buffer.from(needle, 'utf8')
  for await (const file of walk(root)) {
    const info = await stat(file).catch(() => undefined)
    if (!info || info.size > SCAN_LIMIT_BYTES) continue
    scanned += 1
    const bytes = await readFile(file).catch(() => undefined)
    if (bytes && bytes.includes(probe)) hits.push(file)
  }
  return { scanned, hits }
}

/**
 * One `plugin.manage` round trip, with the reply kept verbatim.
 *
 * `raw` is the serialised reply and it is deliberately carried out of the page:
 * the status contract promises to be value-free, and the only way to hold it to
 * that is to look at the bytes it actually returned.
 */
async function manage(
  session: CdpSession,
  request: Record<string, unknown>,
): Promise<ConfigurationStatus> {
  return session.call<ConfigurationStatus>(`
    try {
      const reply = await window.electronAPI.plugin.manage(${JSON.stringify(request)})
      const configuration = (reply && reply.configuration) ? reply.configuration : reply
      return {
        ok: true,
        state: configuration ? configuration.state : undefined,
        fields: (configuration && Array.isArray(configuration.fields) ? configuration.fields : []).map(f => ({
          key: f.key, valueType: f.valueType, required: f.required,
          configured: f.configured, missing: f.missing, sensitive: f.sensitive,
          title: f.title, description: f.description,
        })),
        raw: JSON.stringify(reply ?? null),
      }
    } catch (e) {
      return { ok: false, error: String((e && (e.message || e.code)) || e), fields: [], raw: '' }
    }
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  run.observe('plugin-data-root', DATA_ROOT)

  if (!SENSITIVE || !OPTION_KEY || !PLUGIN_KEY) {
    blocked(
      'install a plugin declaring a `userConfig` with one PLAIN and one SENSITIVE option, then set three vars. '
      + 'NESSY_CDP_PLUGIN_KEY = the installed plugin key `plugin.manage` addresses (the detail page shows it); '
      + 'NESSY_CDP_PLUGIN_OPTION_KEY = the SENSITIVE option\'s key; '
      + 'NESSY_CDP_PLUGIN_SENSITIVE_VALUE = the value to store in it, which is also the literal the disk scan hunts '
      + 'for — use something that appears nowhere else. Optionally NESSY_CDP_PLUGIN_PLAIN_KEY / '
      + 'NESSY_CDP_PLUGIN_PLAIN_VALUE to set the plain option in the same write. '
      + `Currently: pluginKey=${PLUGIN_KEY ?? 'unset'}, optionKey=${OPTION_KEY ?? 'unset'}, `
      + `sensitiveValue=${SENSITIVE ? 'set' : 'unset'}. `
      + 'The harness does not install the plugin — that is the operator\'s marketplace step, the same one MCP-W1..3 '
      + 'require. It DOES supply the values: `plugin.manage({action: \'configure\', values})` is the dialog\'s own '
      + 'submit path (`usePluginConfigurationPrompt.tsx`), so no typing is involved. '
      + `The disk scan reads ${DATA_ROOT}, derived from this PROCESS's NESSY_CONFIG_DIR — export the same one the app `
      + 'was launched with, or the scan reads a directory the app never wrote and passes over the wrong tree.',
    )
  }

  // ---- the pre-write scan: what was on disk before this run touched it -----
  const before = await filesContaining(DATA_ROOT, SENSITIVE)
  run.observe('pre-write scan', { scanned: before.scanned, hits: before.hits })

  // ---- 1. the plugin ASKS for its options ----------------------------------
  const status = await manage(session, {
    pluginKey: PLUGIN_KEY,
    action: 'configuration-status',
    workspaceId: key.workspaceId,
  })
  run.observe('configuration-status', { ok: status.ok, error: status.error, state: status.state, fields: status.fields })
  if (!status.ok) {
    blocked(
      `plugin.manage refused configuration-status for ${PLUGIN_KEY}: ${status.error}. `
      + 'A wrong plugin key, a plugin that is not active, or a workspace mismatch '
      + '(`plugin.manage.workspace-mismatch`) all land here — none of them is a finding about the option flow.',
    )
  }
  run.check(
    'the plugin declares options at all — step 1 has something to ask for',
    status.state !== 'not-required' && status.fields.length > 0,
    `state=${status.state}, ${status.fields.length} field(s)`,
  )
  const sensitiveFields = status.fields.filter(f => f.sensitive === true)
  const plainFields = status.fields.filter(f => f.sensitive !== true)
  run.check(
    'the declared shape is one PLAIN and one SENSITIVE option, as the row requires',
    sensitiveFields.length > 0 && plainFields.length > 0,
    `sensitive=[${sensitiveFields.map(f => f.key).join(', ')}] plain=[${plainFields.map(f => f.key).join(', ')}] — `
    + 'a bundle with no sensitive option would make the security half assert about a secret it never had',
  )
  const target = status.fields.find(f => f.key === OPTION_KEY)
  run.check(
    `the option ${OPTION_KEY} is one the plugin asks for`,
    target !== undefined,
    target ? JSON.stringify(target) : `declared keys: ${status.fields.map(f => f.key).join(', ') || 'none'}`,
  )
  run.check(
    `${OPTION_KEY} is declared SENSITIVE`,
    target?.sensitive === true,
    `sensitive=${String(target?.sensitive)}, valueType=${target?.valueType} — the security half below is only a `
    + 'claim about secret handling if the field is one',
  )
  // `plugins-reference.md` makes label and help text REQUIRED fields of an
  // option declaration, and they were imported and then never rendered once.
  run.observe('what the dialog would show for each option', status.fields.map(f => ({
    key: f.key, title: f.title ?? '(falls back to the raw key)', description: f.description ?? '(none)',
  })))

  // ---- 2. the options ACCEPT values ----------------------------------------
  const values: Record<string, string> = { [OPTION_KEY]: SENSITIVE }
  if (PLAIN_KEY && PLAIN_VALUE) values[PLAIN_KEY] = PLAIN_VALUE
  run.observe('configure keys written', Object.keys(values))
  const configured = await manage(session, {
    pluginKey: PLUGIN_KEY,
    action: 'configure',
    workspaceId: key.workspaceId,
    values,
  })
  run.observe('configure reply', { ok: configured.ok, error: configured.error, state: configured.state, fields: configured.fields })
  // "It did not throw" and "it accepted the values" are DIFFERENT claims, and
  // only the second one is step 2. `handlers/rpc/plugins.ts` initialises its
  // reply's `ok` to `true` and reassigns it only on the repair/update branch, so
  // for `configure` a returned `ok: true` carries no information at all —
  // failure arrives as a throw. Asserting on it would be a check that cannot
  // fail. The acceptance claim is the field status below.
  run.check(
    'the configure RPC did not refuse',
    configured.ok,
    configured.error ?? `state=${configured.state}`,
  )
  const storedTarget = configured.fields.find(f => f.key === OPTION_KEY)
  run.check(
    `${OPTION_KEY} reports itself configured after the write — step 2, the option ACCEPTED the value`,
    storedTarget?.configured === true && storedTarget?.missing !== true,
    storedTarget ? JSON.stringify(storedTarget) : 'the field is absent from the reply',
  )
  // The status contract's own promise, held to its own bytes.
  run.check(
    'neither reply carries the sensitive value back',
    !status.raw.includes(SENSITIVE) && !configured.raw.includes(SENSITIVE),
    `configuration-status carries it: ${status.raw.includes(SENSITIVE)}, configure carries it: ${configured.raw.includes(SENSITIVE)}`,
  )

  // ---- 4. the security half — the scan that matters is the one AFTER -------
  const after = await filesContaining(DATA_ROOT, SENSITIVE)
  run.observe('files-scanned', after.scanned)
  run.observe('files-containing-the-value', after.hits)
  run.check(
    'the sensitive value is not in plain text under the plugin data root',
    after.hits.length === 0,
    after.hits.length === 0
      ? `${after.scanned} files scanned under ${DATA_ROOT}, before the write ${before.hits.length} held it`
      : `${after.hits.length} file(s) hold it verbatim: ${after.hits.join(', ')}`,
  )

  // ---- 3. the hook sees CLAUDE_PLUGIN_OPTION_<KEY> --------------------------
  const envName = `CLAUDE_PLUGIN_OPTION_${OPTION_KEY.toUpperCase()}`
  run.observe('expected-env-var', envName)
  const turn = await sendPrompt(
    session,
    key,
    `Trigger the installed plugin's hook and report, verbatim, the value of ${envName} that it observed. ` +
      'If the hook does not run or the variable is unset, say exactly UNSET.',
    240_000,
  )
  // The residue, recorded rather than pretended away. What is driven above is
  // the SEAM — the same status object the dialog renders from and the same
  // action it submits. What is NOT driven is the dialog's own rendering: that
  // the prompt appears at install time, is laid out from `title`/`description`,
  // and masks the sensitive input. Those are pixels, and this case does not
  // click them. It is an observation and not a terminal block, because folding
  // it into one hid three halves that CAN be measured.
  run.observe(
    'the option DIALOG itself was not driven',
    'steps 1-2 are measured at the RPC seam (configuration-status / configure). Confirm by hand at install time '
    + 'that the prompt appears, shows each option\'s title and help text, and masks the sensitive field.',
  )

  const answer = lastAssistantText(turn.added)
  run.observe('hook-report', answer.slice(0, 300))
  run.check(`the plugin hook saw ${envName}`, !/UNSET/i.test(answer) && answer.trim().length > 0, answer.slice(0, 200))
  // Stronger than "the hook said something": the variable must carry the value
  // that was just written. `user-config-substitution.ts` mints
  // `CLAUDE_PLUGIN_OPTION_<KEY>` from the stored option, so a hook that reports
  // a DIFFERENT value is reading a stale write, and one that reports a masked
  // placeholder is not exporting the option at all. Both are the failure this
  // step exists to catch, and neither is visible to a non-empty check.
  run.check(
    `${envName} carries the value written moments ago`,
    answer.includes(SENSITIVE),
    answer.includes(SENSITIVE)
      ? 'the hook echoed the stored value'
      : `the hook reported ${JSON.stringify(answer.slice(0, 120))}, which is not the value configure stored — `
        + 'a stale write, a masked export, or a hook that never ran',
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
